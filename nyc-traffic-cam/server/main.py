"""FastAPI app — REST endpoints for the dashboard frontend.

Alerts pipeline disabled (2026-04). The frame-diff anomaly detector
and the /api/alerts* + /ws/alerts surface are commented out below; the
ingestor still runs in list-refresh-only mode so /api/cameras stays
current. To resurrect the alerts surface, flip Ingestor's
frame_diff_enabled back to True and uncomment the routes below.
"""
from __future__ import annotations

import asyncio  # noqa: F401  (kept for potential future async helpers)
import json
import logging
import re
import secrets
import time
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from . import db, transit
from .ingestor import Ingestor
from .nyc_api import NycApi
from .state import hub
from .curator import registry as curator_registry

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    conn = await db.connect()
    api = NycApi()
    # frame_diff_enabled=False (default): the ingestor only refreshes
    # the cameras list every ~30 min. The per-camera fetch + diff +
    # alerts pipeline is dormant. Camera-list freshness is what keeps
    # /api/cameras current.
    ingestor = Ingestor(api, conn, frame_diff_enabled=False)
    task = asyncio.create_task(_run_ingestor(ingestor))

    app.state.conn = conn
    app.state.api = api
    app.state.ingestor = ingestor
    app.state.ingestor_task = task
    try:
        yield
    finally:
        ingestor.stop()
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass
        await api.close()
        await conn.close()


async def _run_ingestor(ing: Ingestor) -> None:
    try:
        await ing.run()
    except Exception as e:
        log.exception("ingestor crashed: %s", e)


app = FastAPI(title="NYC Traffic Cam Monitor", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    # Read-only public dashboard — allow any origin so the Cloudflare Pages
    # site (and tunnels / preview deploys) can hit the backend directly.
    allow_origin_regex=r"https?://(localhost(:\d+)?|.*\.pages\.dev|.*\.trycloudflare\.com)",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health() -> dict:
    return {"ok": True, "metrics": hub.metrics, "cameras_loaded": len(app.state.ingestor.cameras)}


@app.get("/api/cameras")
async def get_cameras() -> JSONResponse:
    rows = await db.list_cameras(app.state.conn)
    return JSONResponse(rows)


# ────────────────────────────────────────────────────────────────────
# Alerts surface — DISABLED (2026-04)
# We replaced realtime anomaly detection with a one-time POI
# classification pass. The /api/alerts* routes and the /ws/alerts
# websocket below are commented out; the legacy frontend code that
# called them no longer does. To resurrect: flip Ingestor's
# frame_diff_enabled=True in lifespan() and uncomment.
# ────────────────────────────────────────────────────────────────────
#
# @app.get("/api/alerts")
# async def get_alerts(
#     active_only: bool = Query(False),
#     since: int | None = Query(None, description="unix seconds"),
#     limit: int = Query(200, le=1000),
# ) -> JSONResponse:
#     if active_only:
#         rows = await db.list_active_alerts(app.state.conn)
#     else:
#         rows = await db.list_recent_alerts(app.state.conn, since_ts=since, limit=limit)
#     return JSONResponse(rows)
#
#
# @app.get("/api/alerts/{alert_id}/image.jpg")
# async def get_alert_image(alert_id: int) -> Response:
#     img = await db.get_alert_image(app.state.conn, alert_id)
#     if img is None:
#         raise HTTPException(status_code=404, detail="no image for this alert")
#     return Response(
#         content=img,
#         media_type="image/jpeg",
#         headers={"Cache-Control": "public, max-age=86400, immutable"},
#     )


@app.get("/api/cameras/{camera_id}/snapshot.jpg")
async def get_camera_snapshot(camera_id: str) -> Response:
    """Latest cached frame for a camera. Populated by the ingestor on each poll."""
    img = hub.latest_jpeg.get(camera_id)
    if img is None:
        raise HTTPException(status_code=404, detail="no snapshot yet for this camera")
    return Response(
        content=img,
        media_type="image/jpeg",
        # Short TTL — the ingestor refreshes this every 5-15s.
        headers={"Cache-Control": "public, max-age=10"},
    )


@app.get("/api/stats")
async def get_stats() -> dict:
    rows = await db.list_cameras(app.state.conn)
    online = sum(1 for r in rows if r["is_online"])
    polled_recently = sum(1 for r in rows if (r["last_polled_at"] or 0) > 0)
    return {
        "cameras_online": online,
        "cameras_polled": polled_recently,
        "metrics": hub.metrics,
    }


# ────────────────────────────────────────────────────────────────────
# /api/curator/approve — save curator approval decisions
# ────────────────────────────────────────────────────────────────────

class CuratorApprovalBody(BaseModel):
    cam_id: str = Field(..., min_length=1, max_length=256)
    approved: bool | None = Field(None)
    notes: str | None = Field(None, max_length=1024)
    image_usable_override: bool | None = Field(None)


@app.post("/api/curator/approve")
async def curator_approve(body: CuratorApprovalBody) -> dict:
    """Save a curator decision for a camera classification."""
    try:
        curator_registry.save_one(
            cam_id=body.cam_id,
            approved=body.approved,
            notes=body.notes or "",
        )
        stats = curator_registry.stats()
        return {
            "cam_id": body.cam_id,
            "approved": body.approved,
            "saved_at": int(time.time()),
            "stats": stats,
        }
    except Exception as e:
        log.error(f"failed to save curator decision: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/curator/stats")
async def curator_stats() -> dict:
    """Get curator approval statistics."""
    return curator_registry.stats()


# ────────────────────────────────────────────────────────────────────
# /api/challenges — geoguessr "play the same 5 cameras as your friend"
# Snapshot the 5 camera UUIDs at share time, store under a 6-char hash,
# expire after 24h. Bounded storage and per-IP rate limit guard memory.
# ────────────────────────────────────────────────────────────────────

# In-memory per-IP token buckets. Cheap, single-process: this server
# runs as one uvicorn worker, so a Python dict is fine. If we ever scale
# horizontally this would need to move to redis or similar.
_RATE_BUCKET: dict[str, deque[float]] = {}
_RATE_WINDOW_SEC = 60 * 60
_RATE_LIMIT_PER_WINDOW = 30  # 30 challenge creates per IP per hour

_CAM_ID_RE = re.compile(r"^[0-9a-fA-F-]{36}$")  # uuid-shaped
_HASH_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no I/O/0/1 → fewer "is that a one?" issues


def _client_ip(req: Request) -> str:
    fwd = req.headers.get("x-forwarded-for") or req.headers.get("cf-connecting-ip")
    if fwd:
        return fwd.split(",", 1)[0].strip()
    return req.client.host if req.client else "unknown"


def _check_rate_limit(ip: str) -> None:
    now = time.time()
    bucket = _RATE_BUCKET.setdefault(ip, deque())
    # Drop expired timestamps from the head
    while bucket and bucket[0] < now - _RATE_WINDOW_SEC:
        bucket.popleft()
    if len(bucket) >= _RATE_LIMIT_PER_WINDOW:
        raise HTTPException(status_code=429, detail="rate limit exceeded — try again later")
    bucket.append(now)
    # Defensive: if the bucket dict grows unbounded over time, prune
    # buckets that are completely empty after dropping expired entries.
    if len(_RATE_BUCKET) > 5_000:
        for k in list(_RATE_BUCKET.keys()):
            b = _RATE_BUCKET[k]
            while b and b[0] < now - _RATE_WINDOW_SEC:
                b.popleft()
            if not b:
                del _RATE_BUCKET[k]


def _make_hash(n: int = 6) -> str:
    return "".join(secrets.choice(_HASH_ALPHABET) for _ in range(n))


class CreateChallengeBody(BaseModel):
    cameras: list[str] = Field(..., min_length=1, max_length=10)
    score: int | None = Field(None, ge=0, le=100_000)
    grade: str | None = Field(None, max_length=64)


@app.post("/api/challenges")
async def create_challenge(body: CreateChallengeBody, request: Request) -> dict:
    ip = _client_ip(request)
    _check_rate_limit(ip)

    # Validate camera IDs look like UUIDs — keeps junk out of storage.
    for cid in body.cameras:
        if not _CAM_ID_RE.match(cid):
            raise HTTPException(status_code=400, detail=f"bad camera id: {cid}")

    # Sweep before insert: keeps the table near its target size and
    # expired rows clear out lazily on real traffic, no cron needed.
    await db.sweep_challenges(app.state.conn)

    # Generate a fresh hash, retry up to a few times on the rare collision.
    last_err: Exception | None = None
    for _ in range(6):
        h = _make_hash()
        try:
            await db.insert_challenge(
                app.state.conn,
                hash_=h,
                cameras=body.cameras,
                score=body.score,
                grade=body.grade,
            )
            return {"hash": h, "expires_in_seconds": db.CHALLENGE_TTL_SECONDS}
        except Exception as e:  # most likely UNIQUE constraint failed
            last_err = e
            continue
    raise HTTPException(status_code=500, detail=f"could not allocate challenge hash: {last_err}")


@app.get("/api/challenges/{hash_}")
async def get_challenge(hash_: str) -> dict:
    if not re.fullmatch(r"[A-Z0-9]{4,12}", hash_):
        raise HTTPException(status_code=400, detail="bad hash format")
    row = await db.get_challenge(app.state.conn, hash_)
    if not row:
        raise HTTPException(status_code=404, detail="challenge not found or expired")
    # Lazy TTL check — entries past TTL get reaped on the next sweep.
    if row["expires_at"] < int(time.time()):
        raise HTTPException(status_code=410, detail="challenge expired")
    return row


# ────────────────────────────────────────────────────────────────────
# /api/transit/arrivals — GTFS-RT next-train predictions
# Real-time arrivals at a given GTFS stop_id, parsed from the MTA's
# protobuf feeds. Server-side decode keeps the client lean.
# ────────────────────────────────────────────────────────────────────


@app.get("/api/transit/arrivals")
async def get_arrivals(
    stop_id: str = Query(..., min_length=2, max_length=12),
    line: str | None = Query(None, max_length=4),
) -> dict:
    sid = stop_id.strip().upper()
    if not re.fullmatch(r"[A-Z0-9]{2,12}", sid):
        raise HTTPException(status_code=400, detail="bad stop id")
    line_norm = line.strip().upper() if line else None
    if line_norm and line_norm not in transit.LINE_TO_FEED:
        raise HTTPException(status_code=400, detail=f"unknown line: {line}")
    return await transit.next_arrivals(stop_id=sid, line=line_norm)


# /ws/alerts — DISABLED (2026-04). See note at top of file.
#
# @app.websocket("/ws/alerts")
# async def ws_alerts(ws: WebSocket) -> None:
#     await ws.accept()
#     q = hub.subscribe()
#     try:
#         await ws.send_json({"type": "hello", "metrics": hub.metrics})
#         while True:
#             msg = await q.get()
#             await ws.send_text(msg)
#     except WebSocketDisconnect:
#         pass
#     except Exception as e:
#         log.warning("ws error: %s", e)
#     finally:
#         hub.unsubscribe(q)


# ────────────────────────────────────────────────────────────────────
# /api/pois — points-of-interest classification (one-time, static)
# Camera locations don't move, so we classify each cam's most notable
# visible landmark ONCE (via server/poi_classify.py) and serve the
# resulting JSON statically. Cheap, no recomputation, no per-request
# work. This endpoint is mostly a fallback — the UI imports the same
# JSON at build time so it works fully offline / edge-only.
# ────────────────────────────────────────────────────────────────────

_POI_PATH = Path(__file__).resolve().parent.parent / "data" / "cam_pois.json"
_POI_CACHE: dict | None = None


@app.get("/api/pois")
async def get_pois() -> dict:
    global _POI_CACHE
    if _POI_CACHE is None:
        try:
            _POI_CACHE = json.loads(_POI_PATH.read_text())
        except FileNotFoundError:
            return {"generated_at": None, "cameras": {}}
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"pois: {e}")
    return _POI_CACHE
