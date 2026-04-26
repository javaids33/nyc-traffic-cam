"""In-memory shared state: per-camera frame stats + WebSocket broadcasting."""
from __future__ import annotations

import asyncio
import json
from typing import Any

from .frame_processor import FrameStats


class HubState:
    """Holds in-memory per-camera state and connected websocket clients."""

    def __init__(self) -> None:
        self.frame_state: dict[str, FrameStats] = {}
        self.consecutive_failures: dict[str, int] = {}
        self.consecutive_static: dict[str, int] = {}
        self.consecutive_normal: dict[str, int] = {}
        self.last_alert_at: dict[tuple[str, str], int] = {}  # (camera_id, kind) -> ts
        # Latest raw JPEG per camera, populated by ingestor on every successful fetch.
        # Lets the API serve a fresh snapshot without re-hitting upstream.
        self.latest_jpeg: dict[str, bytes] = {}
        self._ws_clients: set[asyncio.Queue] = set()
        self.metrics = {
            "polls_total": 0,
            "polls_failed": 0,
            "alerts_opened": 0,
            "alerts_resolved": 0,
            "last_tick_at": 0,
        }

    def get_frame_state(self, camera_id: str) -> FrameStats:
        st = self.frame_state.get(camera_id)
        if st is None:
            st = FrameStats()
            self.frame_state[camera_id] = st
        return st

    # --- WebSocket fan-out ---

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=200)
        self._ws_clients.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._ws_clients.discard(q)

    async def broadcast(self, event: dict[str, Any]) -> None:
        msg = json.dumps(event, default=str)
        dead = []
        for q in list(self._ws_clients):
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            self._ws_clients.discard(q)


hub = HubState()
