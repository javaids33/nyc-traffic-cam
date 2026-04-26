"""Alert rules: convert frame analyses + camera health into alert records.

Alert kinds:
  - sudden_change   : frame-diff z-score above threshold (anything strange)
  - static_feed     : N consecutive ticks with ~zero motion (likely broken/frozen)
  - camera_offline  : N consecutive fetch failures
  - high_activity   : sustained above-mean diff (placeholder for future ML rules)
"""
from __future__ import annotations

import json
import time
from typing import Any, Optional

import aiosqlite

from .config import (
    DEDUP_WINDOW_SECONDS,
    OFFLINE_FAILURES,
    RESOLVE_AFTER_NORMAL_TICKS,
    STATIC_FEED_TICKS,
)
from .frame_processor import FrameAnalysis, thumbnail_to_b64_png
from .state import hub


ALERT_LABELS = {
    "sudden_change":  "Sudden visual change",
    "static_feed":    "Frozen / static feed",
    "camera_offline": "Camera offline",
    "high_activity":  "High activity",
}


async def _open_or_update_alert(
    conn: aiosqlite.Connection,
    camera_id: str,
    kind: str,
    severity: int,
    message: str,
    details: dict[str, Any],
    thumbnail_b64: Optional[str],
    image_jpeg: Optional[bytes],
) -> Optional[dict[str, Any]]:
    now = int(time.time())
    last = hub.last_alert_at.get((camera_id, kind), 0)

    # If we have an active alert of same kind, bump severity + occurrence_count
    # and refresh the snapshot so a watcher sees the latest scene.
    cursor = await conn.execute(
        "SELECT id, severity, occurrence_count FROM alerts "
        "WHERE camera_id = ? AND kind = ? AND resolved_at IS NULL "
        "ORDER BY id DESC LIMIT 1",
        (camera_id, kind),
    )
    active = await cursor.fetchone()
    await cursor.close()

    if active is not None:
        new_sev = max(active["severity"], severity)
        if image_jpeg is not None:
            await conn.execute(
                "UPDATE alerts SET severity = ?, updated_at = ?, "
                "occurrence_count = occurrence_count + 1, "
                "details_json = ?, message = ?, image_jpeg = ? WHERE id = ?",
                (new_sev, now, json.dumps(details), message, image_jpeg, active["id"]),
            )
        else:
            await conn.execute(
                "UPDATE alerts SET severity = ?, updated_at = ?, "
                "occurrence_count = occurrence_count + 1, "
                "details_json = ?, message = ? WHERE id = ?",
                (new_sev, now, json.dumps(details), message, active["id"]),
            )
        await conn.commit()
        hub.last_alert_at[(camera_id, kind)] = now
        return {
            "id": active["id"], "camera_id": camera_id, "kind": kind,
            "severity": new_sev, "message": message, "updated_at": now,
            "occurrence_count": active["occurrence_count"] + 1,
            "has_image": image_jpeg is not None,
            "is_new": False,
        }

    if now - last < DEDUP_WINDOW_SECONDS:
        return None

    await conn.execute(
        "INSERT INTO alerts (camera_id, kind, severity, message, details_json, "
        "thumbnail_b64, image_jpeg, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (camera_id, kind, severity, message, json.dumps(details),
         thumbnail_b64, image_jpeg, now, now),
    )
    await conn.commit()
    cursor = await conn.execute("SELECT last_insert_rowid() AS id")
    row = await cursor.fetchone()
    await cursor.close()
    alert_id = row["id"] if row else None

    hub.last_alert_at[(camera_id, kind)] = now
    hub.metrics["alerts_opened"] += 1
    return {
        "id": alert_id, "camera_id": camera_id, "kind": kind,
        "severity": severity, "message": message, "created_at": now,
        "updated_at": now, "occurrence_count": 1,
        "has_image": image_jpeg is not None,
        "is_new": True,
    }


async def _resolve_active(conn: aiosqlite.Connection, camera_id: str, kind: str) -> int | None:
    now = int(time.time())
    cursor = await conn.execute(
        "SELECT id FROM alerts WHERE camera_id = ? AND kind = ? AND resolved_at IS NULL",
        (camera_id, kind),
    )
    row = await cursor.fetchone()
    await cursor.close()
    if not row:
        return None
    await conn.execute("UPDATE alerts SET resolved_at = ? WHERE id = ?", (now, row["id"]))
    await conn.commit()
    hub.metrics["alerts_resolved"] += 1
    return row["id"]


async def evaluate_frame(
    conn: aiosqlite.Connection,
    camera: dict[str, Any],
    analysis: FrameAnalysis,
    image_jpeg: bytes | None = None,
) -> list[dict[str, Any]]:
    """Run rules on a successful frame analysis. Returns alert events to broadcast."""
    cam_id = camera["id"]
    cam_name = camera.get("name") or cam_id[:8]
    events: list[dict[str, Any]] = []

    # Reset offline counter on success.
    hub.consecutive_failures[cam_id] = 0
    resolved = await _resolve_active(conn, cam_id, "camera_offline")
    if resolved:
        events.append({"type": "alert_resolved", "alert_id": resolved, "camera_id": cam_id, "kind": "camera_offline"})

    # Static-feed tracking.
    if analysis.is_static:
        hub.consecutive_static[cam_id] = hub.consecutive_static.get(cam_id, 0) + 1
        if hub.consecutive_static[cam_id] >= STATIC_FEED_TICKS:
            ev = await _open_or_update_alert(
                conn, cam_id, "static_feed",
                severity=3,
                message=f"{cam_name}: feed appears frozen",
                details={"consecutive_static_ticks": hub.consecutive_static[cam_id], "diff": analysis.diff_score},
                thumbnail_b64=thumbnail_to_b64_png(analysis.thumbnail),
                image_jpeg=image_jpeg,
            )
            if ev:
                events.append({"type": "alert_opened" if ev["is_new"] else "alert_updated", **ev})
    else:
        hub.consecutive_static[cam_id] = 0
        resolved = await _resolve_active(conn, cam_id, "static_feed")
        if resolved:
            events.append({"type": "alert_resolved", "alert_id": resolved, "camera_id": cam_id, "kind": "static_feed"})

    # Sudden-change alert.
    if analysis.is_anomaly:
        hub.consecutive_normal[cam_id] = 0
        ev = await _open_or_update_alert(
            conn, cam_id, "sudden_change",
            severity=analysis.severity,
            message=f"{cam_name}: anomalous scene change (z={analysis.z_score:.1f})",
            details={
                "diff_score": round(analysis.diff_score, 3),
                "z_score": round(analysis.z_score, 3),
            },
            thumbnail_b64=thumbnail_to_b64_png(analysis.thumbnail),
            image_jpeg=image_jpeg,
        )
        if ev:
            events.append({"type": "alert_opened" if ev["is_new"] else "alert_updated", **ev})
    else:
        hub.consecutive_normal[cam_id] = hub.consecutive_normal.get(cam_id, 0) + 1
        if hub.consecutive_normal[cam_id] >= RESOLVE_AFTER_NORMAL_TICKS:
            resolved = await _resolve_active(conn, cam_id, "sudden_change")
            if resolved:
                events.append({"type": "alert_resolved", "alert_id": resolved, "camera_id": cam_id, "kind": "sudden_change"})

    return events


async def evaluate_failure(conn: aiosqlite.Connection, camera: dict[str, Any], err: str) -> list[dict[str, Any]]:
    cam_id = camera["id"]
    cam_name = camera.get("name") or cam_id[:8]
    events: list[dict[str, Any]] = []
    hub.consecutive_failures[cam_id] = hub.consecutive_failures.get(cam_id, 0) + 1
    if hub.consecutive_failures[cam_id] >= OFFLINE_FAILURES:
        # Use the last-known-good frame so the offline alert still has a picture.
        last_known = hub.latest_jpeg.get(cam_id)
        ev = await _open_or_update_alert(
            conn, cam_id, "camera_offline",
            severity=2,
            message=f"{cam_name}: offline (failed {hub.consecutive_failures[cam_id]} times)",
            details={"error": err[:200], "consecutive_failures": hub.consecutive_failures[cam_id]},
            thumbnail_b64=None,
            image_jpeg=last_known,
        )
        if ev:
            events.append({"type": "alert_opened" if ev["is_new"] else "alert_updated", **ev})
    return events
