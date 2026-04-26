"""FastAPI app — REST + WebSocket for the dashboard frontend."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from . import db
from .ingestor import Ingestor
from .nyc_api import NycApi
from .state import hub

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    conn = await db.connect()
    api = NycApi()
    ingestor = Ingestor(api, conn)
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
    allow_origins=["http://localhost:5173"],
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


@app.get("/api/alerts")
async def get_alerts(
    active_only: bool = Query(False),
    since: int | None = Query(None, description="unix seconds"),
    limit: int = Query(200, le=1000),
) -> JSONResponse:
    if active_only:
        rows = await db.list_active_alerts(app.state.conn)
    else:
        rows = await db.list_recent_alerts(app.state.conn, since_ts=since, limit=limit)
    return JSONResponse(rows)


@app.get("/api/alerts/{alert_id}/image.jpg")
async def get_alert_image(alert_id: int) -> Response:
    """Returns the JPEG that triggered this alert (or last-known frame for offline alerts)."""
    img = await db.get_alert_image(app.state.conn, alert_id)
    if img is None:
        raise HTTPException(status_code=404, detail="no image for this alert")
    return Response(
        content=img,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=86400, immutable"},
    )


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


@app.websocket("/ws/alerts")
async def ws_alerts(ws: WebSocket) -> None:
    await ws.accept()
    q = hub.subscribe()
    try:
        await ws.send_json({"type": "hello", "metrics": hub.metrics})
        while True:
            msg = await q.get()
            await ws.send_text(msg)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.warning("ws error: %s", e)
    finally:
        hub.unsubscribe(q)
