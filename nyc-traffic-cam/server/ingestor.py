"""Async ingestor: schedules per-camera fetches, runs analysis, evaluates rules."""
from __future__ import annotations

import asyncio
import logging
import random
import time
from typing import Any

import aiosqlite

from .config import (
    FETCH_JITTER_SECONDS,
    HOT_POLL_INTERVAL,
    HOT_WINDOW_SECONDS,
    MAX_CONCURRENT_FETCHES,
    NORMAL_POLL_INTERVAL,
)
from .frame_processor import analyze
from .nyc_api import NycApi
from .rules import evaluate_failure, evaluate_frame
from .state import hub

log = logging.getLogger("ingestor")


class Ingestor:
    def __init__(
        self,
        api: NycApi,
        conn: aiosqlite.Connection,
        *,
        frame_diff_enabled: bool = False,
    ) -> None:
        # frame_diff_enabled controls whether we run the per-camera
        # fetch + diff + alerts pipeline. Disabled by default in the
        # current site since we replaced realtime alerts with a one-time
        # POI classification job. Flip to True to re-enable the legacy
        # behavior (along with re-enabling the /api/alerts endpoints in
        # main.py and rules.py wiring).
        self.api = api
        self.conn = conn
        self.frame_diff_enabled = frame_diff_enabled
        self.cameras: dict[str, dict[str, Any]] = {}
        self.next_due: dict[str, float] = {}  # camera_id -> monotonic timestamp
        self._sem = asyncio.Semaphore(MAX_CONCURRENT_FETCHES)
        self._stop = asyncio.Event()

    async def refresh_camera_list(self) -> int:
        cams = await self.api.list_cameras()
        # Keep cameras dict in memory keyed by id.
        self.cameras = {c["id"]: c for c in cams}
        # Stagger initial due times so we don't burst-fetch all 954 at once.
        now = time.monotonic()
        ids = list(self.cameras.keys())
        random.shuffle(ids)
        spread = NORMAL_POLL_INTERVAL
        for i, cid in enumerate(ids):
            self.next_due.setdefault(cid, now + (i / max(len(ids), 1)) * spread)
        # Persist to DB.
        from .db import upsert_cameras
        await upsert_cameras(self.conn, cams)
        return len(cams)

    def _cadence_for(self, cam_id: str) -> int:
        # Camera is "hot" if any kind triggered an alert within the hot window.
        now = int(time.time())
        for (cid, _), ts in hub.last_alert_at.items():
            if cid == cam_id and now - ts < HOT_WINDOW_SECONDS:
                return HOT_POLL_INTERVAL
        return NORMAL_POLL_INTERVAL

    async def _process_one(self, cam_id: str) -> None:
        camera = self.cameras.get(cam_id)
        if not camera:
            return
        async with self._sem:
            # Small jitter to avoid lockstep bursts.
            await asyncio.sleep(random.uniform(0, FETCH_JITTER_SECONDS))
            try:
                jpeg = await self.api.fetch_image(cam_id)
                hub.metrics["polls_total"] += 1
                if jpeg is None:
                    raise RuntimeError("empty response")
            except Exception as e:
                hub.metrics["polls_failed"] += 1
                events = await evaluate_failure(self.conn, camera, str(e))
                for ev in events:
                    await hub.broadcast(self._enrich(ev, camera))
                await self.conn.execute(
                    "UPDATE cameras SET last_polled_at = ?, consecutive_failures = consecutive_failures + 1 WHERE id = ?",
                    (int(time.time()), cam_id),
                )
                await self.conn.commit()
                return

            # Cache latest raw JPEG so the API can serve a snapshot without
            # re-hitting upstream.
            hub.latest_jpeg[cam_id] = jpeg

            state = hub.get_frame_state(cam_id)
            analysis = analyze(state, jpeg)
            now = int(time.time())
            await self.conn.execute(
                "UPDATE cameras SET last_polled_at = ?, last_image_at = ?, last_diff = ?, "
                "diff_mean = ?, diff_m2 = ?, diff_count = ?, consecutive_failures = 0 WHERE id = ?",
                (now, now, analysis.diff_score if analysis else None,
                 state.diff_mean, state.diff_m2, state.diff_count, cam_id),
            )
            await self.conn.commit()
            if analysis is None:
                return
            events = await evaluate_frame(self.conn, camera, analysis, image_jpeg=jpeg)
            for ev in events:
                await hub.broadcast(self._enrich(ev, camera))

    def _enrich(self, ev: dict[str, Any], camera: dict[str, Any]) -> dict[str, Any]:
        ev = {**ev, "camera_name": camera.get("name"), "lat": camera.get("lat"), "lng": camera.get("lng")}
        return ev

    async def run(self) -> None:
        await self.refresh_camera_list()
        log.info(
            "ingestor: %d cameras loaded (frame-diff %s)",
            len(self.cameras),
            "ENABLED" if self.frame_diff_enabled else "disabled — list-refresh only",
        )
        last_refresh = time.monotonic()

        while not self._stop.is_set():
            # Per-camera frame fetch + diff + alerts pipeline. Gated off
            # by default; only runs if frame_diff_enabled was set true.
            if self.frame_diff_enabled:
                now = time.monotonic()
                due = [cid for cid, t in self.next_due.items() if t <= now and cid in self.cameras]
                tasks = []
                for cid in due[:MAX_CONCURRENT_FETCHES * 4]:  # cap per-tick batch
                    self.next_due[cid] = now + self._cadence_for(cid) + random.uniform(-1, 1)
                    tasks.append(asyncio.create_task(self._process_one(cid)))
                if tasks:
                    await asyncio.gather(*tasks, return_exceptions=True)
                    hub.metrics["last_tick_at"] = int(time.time())

            # Periodic camera-list refresh (every 30 min). Always-on,
            # regardless of frame-diff: this is what keeps /api/cameras
            # current as upstream cameras come on/off.
            if time.monotonic() - last_refresh > 1800:
                try:
                    await self.refresh_camera_list()
                    log.info("ingestor: refreshed camera list (%d)", len(self.cameras))
                except Exception as e:
                    log.warning("camera list refresh failed: %s", e)
                last_refresh = time.monotonic()

            # When frame-diff is on, sleep just long enough to hit the
            # next due camera. When it's off, this loop has nothing to
            # do but check the 30-min refresh — sleep a full minute.
            if self.frame_diff_enabled:
                future_due = [t for t in self.next_due.values() if t > time.monotonic()]
                if future_due:
                    next_at = min(future_due)
                    await asyncio.sleep(min(max(next_at - time.monotonic(), 0.1), 1.0))
                else:
                    await asyncio.sleep(0.5)
            else:
                await asyncio.sleep(60)

    def stop(self) -> None:
        self._stop.set()
