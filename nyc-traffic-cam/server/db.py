"""Async SQLite layer. Schema + helpers used by ingestor and API."""
from __future__ import annotations

import json
import time
from typing import Any, Iterable

import aiosqlite

from .config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS cameras (
  id TEXT PRIMARY KEY,
  name TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  is_online INTEGER NOT NULL,
  last_polled_at INTEGER,
  last_image_at INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_static_ticks INTEGER NOT NULL DEFAULT 0,
  consecutive_normal_ticks INTEGER NOT NULL DEFAULT 0,
  diff_mean REAL NOT NULL DEFAULT 0,
  diff_m2 REAL NOT NULL DEFAULT 0,
  diff_count INTEGER NOT NULL DEFAULT 0,
  last_diff REAL
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  camera_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity INTEGER NOT NULL,
  message TEXT NOT NULL,
  details_json TEXT,
  thumbnail_b64 TEXT,
  image_jpeg BLOB,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER,
  occurrence_count INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_active ON alerts(camera_id, kind, resolved_at);

CREATE TABLE IF NOT EXISTS poll_log (
  ts INTEGER NOT NULL,
  cameras_polled INTEGER NOT NULL,
  cameras_failed INTEGER NOT NULL,
  alerts_opened INTEGER NOT NULL,
  alerts_resolved INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS geoguessr_challenges (
  hash TEXT PRIMARY KEY,
  cameras_json TEXT NOT NULL,
  score INTEGER,
  grade TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chal_created ON geoguessr_challenges(created_at);
"""

# Hard cap on stored challenges. With 24h TTL + per-IP rate limit this is
# very conservative — the cap is just belt-and-suspenders so a buggy
# client or mass spam can't blow up memory or disk.
CHALLENGE_TABLE_CAP = 10_000
CHALLENGE_TTL_SECONDS = 24 * 3600


async def connect() -> aiosqlite.Connection:
    conn = await aiosqlite.connect(DB_PATH)
    conn.row_factory = aiosqlite.Row
    await conn.executescript(SCHEMA)
    await conn.execute("PRAGMA journal_mode=WAL")
    await conn.execute("PRAGMA synchronous=NORMAL")
    # Idempotent migrations for columns added after first deploy.
    cursor = await conn.execute("PRAGMA table_info(alerts)")
    cols = {row["name"] for row in await cursor.fetchall()}
    await cursor.close()
    if "image_jpeg" not in cols:
        await conn.execute("ALTER TABLE alerts ADD COLUMN image_jpeg BLOB")
    await conn.commit()
    return conn


async def upsert_cameras(conn: aiosqlite.Connection, cams: Iterable[dict[str, Any]]) -> int:
    rows = [
        (cam["id"], cam.get("name"), cam["lat"], cam["lng"], 1 if cam.get("isOnline") else 0)
        for cam in cams
    ]
    if not rows:
        return 0
    await conn.executemany(
        """
        INSERT INTO cameras (id, name, lat, lng, is_online)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          lat = excluded.lat,
          lng = excluded.lng,
          is_online = excluded.is_online
        """,
        rows,
    )
    await conn.commit()
    return len(rows)


async def list_cameras(conn: aiosqlite.Connection) -> list[dict[str, Any]]:
    cursor = await conn.execute(
        """
        SELECT c.id, c.name, c.lat, c.lng, c.is_online, c.last_polled_at,
               c.last_image_at, c.consecutive_failures, c.last_diff,
               (SELECT MAX(severity) FROM alerts a
                WHERE a.camera_id = c.id AND a.resolved_at IS NULL) AS active_severity
        FROM cameras c
        """
    )
    rows = await cursor.fetchall()
    await cursor.close()
    return [dict(row) for row in rows]


_ALERT_LIST_COLS = (
    "a.id, a.camera_id, a.kind, a.severity, a.message, a.details_json, "
    "a.thumbnail_b64, (a.image_jpeg IS NOT NULL) AS has_image, "
    "a.created_at, a.updated_at, a.resolved_at, a.occurrence_count, "
    "c.lat AS lat, c.lng AS lng, c.name AS camera_name"
)


async def list_recent_alerts(
    conn: aiosqlite.Connection, since_ts: int | None = None, limit: int = 200
) -> list[dict[str, Any]]:
    if since_ts is None:
        since_ts = int(time.time()) - 24 * 3600
    cursor = await conn.execute(
        f"""
        SELECT {_ALERT_LIST_COLS}
        FROM alerts a
        JOIN cameras c ON c.id = a.camera_id
        WHERE a.created_at >= ?
        ORDER BY a.created_at DESC
        LIMIT ?
        """,
        (since_ts, limit),
    )
    rows = await cursor.fetchall()
    await cursor.close()
    return [_decode_alert(dict(row)) for row in rows]


async def list_active_alerts(conn: aiosqlite.Connection) -> list[dict[str, Any]]:
    cursor = await conn.execute(
        f"""
        SELECT {_ALERT_LIST_COLS}
        FROM alerts a
        JOIN cameras c ON c.id = a.camera_id
        WHERE a.resolved_at IS NULL
        ORDER BY a.severity DESC, a.updated_at DESC
        """,
    )
    rows = await cursor.fetchall()
    await cursor.close()
    return [_decode_alert(dict(row)) for row in rows]


async def get_alert_image(conn: aiosqlite.Connection, alert_id: int) -> bytes | None:
    cursor = await conn.execute("SELECT image_jpeg FROM alerts WHERE id = ?", (alert_id,))
    row = await cursor.fetchone()
    await cursor.close()
    if not row or row["image_jpeg"] is None:
        return None
    return bytes(row["image_jpeg"])


async def insert_challenge(
    conn: aiosqlite.Connection,
    *,
    hash_: str,
    cameras: list[str],
    score: int | None,
    grade: str | None,
) -> None:
    """Store a geoguessr challenge. Caller picks the hash (random) and is
    responsible for retrying on the small chance of a collision."""
    now = int(time.time())
    await conn.execute(
        """
        INSERT INTO geoguessr_challenges (hash, cameras_json, score, grade, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (hash_, json.dumps(cameras), score, grade, now),
    )
    await conn.commit()


async def get_challenge(conn: aiosqlite.Connection, hash_: str) -> dict[str, Any] | None:
    cursor = await conn.execute(
        "SELECT hash, cameras_json, score, grade, created_at "
        "FROM geoguessr_challenges WHERE hash = ?",
        (hash_,),
    )
    row = await cursor.fetchone()
    await cursor.close()
    if not row:
        return None
    return {
        "hash": row["hash"],
        "cameras": json.loads(row["cameras_json"]),
        "score": row["score"],
        "grade": row["grade"],
        "created_at": row["created_at"],
        "expires_at": row["created_at"] + CHALLENGE_TTL_SECONDS,
    }


async def sweep_challenges(conn: aiosqlite.Connection) -> int:
    """Delete challenges past TTL and trim to the table cap. Returns the
    number of rows deleted. Cheap to call on every write."""
    now = int(time.time())
    cutoff = now - CHALLENGE_TTL_SECONDS
    cursor = await conn.execute(
        "DELETE FROM geoguessr_challenges WHERE created_at < ?", (cutoff,)
    )
    expired = cursor.rowcount or 0
    await cursor.close()

    # Trim to cap by deleting oldest rows. SQLite has no direct "delete
    # all but newest N", so we use a subquery.
    cursor = await conn.execute("SELECT COUNT(*) AS n FROM geoguessr_challenges")
    row = await cursor.fetchone()
    await cursor.close()
    total = row["n"] if row else 0
    over = max(0, total - CHALLENGE_TABLE_CAP)
    trimmed = 0
    if over > 0:
        cursor = await conn.execute(
            """
            DELETE FROM geoguessr_challenges
            WHERE hash IN (
              SELECT hash FROM geoguessr_challenges
              ORDER BY created_at ASC LIMIT ?
            )
            """,
            (over,),
        )
        trimmed = cursor.rowcount or 0
        await cursor.close()

    if expired or trimmed:
        await conn.commit()
    return expired + trimmed


def _decode_alert(row: dict[str, Any]) -> dict[str, Any]:
    if row.get("details_json"):
        try:
            row["details"] = json.loads(row["details_json"])
        except json.JSONDecodeError:
            row["details"] = None
    row.pop("details_json", None)
    if "has_image" in row:
        row["has_image"] = bool(row["has_image"])
    return row
