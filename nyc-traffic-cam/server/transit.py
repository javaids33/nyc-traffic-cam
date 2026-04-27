"""MTA GTFS-Realtime arrival predictions for the Hop the Turnstile mode.

The MTA publishes binary protobuf feeds at api-endpoint.mta.info, grouped
by line family (1234567, ACE, BDFM, G, JZ, L, NQRW, SI). They no longer
require an API key (since 2021). Each feed updates ~every 30s.

We cache the parsed feed in-process for FEED_CACHE_TTL seconds so that a
busy boarding screen with a few clients doesn't hammer the upstream.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx
from google.transit import gtfs_realtime_pb2

# https://api.mta.info/#/subwayRealTimeFeeds — line → feed group
LINE_TO_FEED: dict[str, str] = {
    "1": "gtfs", "2": "gtfs", "3": "gtfs", "4": "gtfs", "5": "gtfs",
    "6": "gtfs", "7": "gtfs", "S": "gtfs",
    "A": "gtfs-ace", "C": "gtfs-ace", "E": "gtfs-ace",
    "B": "gtfs-bdfm", "D": "gtfs-bdfm", "F": "gtfs-bdfm", "M": "gtfs-bdfm",
    "G": "gtfs-g",
    "J": "gtfs-jz", "Z": "gtfs-jz",
    "L": "gtfs-l",
    "N": "gtfs-nqrw", "Q": "gtfs-nqrw", "R": "gtfs-nqrw", "W": "gtfs-nqrw",
    "SI": "gtfs-si",
}

FEED_BASE = "https://api-endpoint.mta.info/Dataservices/mtagtfsfeeds/nyct%2F"
FEED_CACHE_TTL = 25  # seconds — feeds refresh ~30s upstream

# (timestamp, list_of_trip_updates) per feed name
_feed_cache: dict[str, tuple[float, list[Any]]] = {}
_feed_locks: dict[str, asyncio.Lock] = {}


async def _fetch_feed(feed_name: str) -> list[Any]:
    """Return a list of TripUpdate messages for the feed. Cached."""
    now = time.time()
    cached = _feed_cache.get(feed_name)
    if cached and (now - cached[0]) < FEED_CACHE_TTL:
        return cached[1]

    # Per-feed lock so concurrent requests don't all hit upstream.
    lock = _feed_locks.setdefault(feed_name, asyncio.Lock())
    async with lock:
        cached = _feed_cache.get(feed_name)
        if cached and (time.time() - cached[0]) < FEED_CACHE_TTL:
            return cached[1]
        url = FEED_BASE + feed_name
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(url)
            r.raise_for_status()
            buf = r.content
        feed = gtfs_realtime_pb2.FeedMessage()
        feed.ParseFromString(buf)
        trips = [e.trip_update for e in feed.entity if e.HasField("trip_update")]
        _feed_cache[feed_name] = (time.time(), trips)
        return trips


async def next_arrivals(
    *,
    stop_id: str,
    line: str | None = None,
    limit: int = 4,
) -> dict[str, Any]:
    """Return up to `limit` upcoming arrivals for each direction at stop_id.

    stop_id is the GTFS stop ID without the N/S direction suffix (e.g.
    "F25" for 14 St / 6 Av on the F). If `line` is given we filter the
    feed to only that route. Otherwise we infer the feed from the
    stop_id prefix's first character (e.g. "F25" → BDFM feed).
    """
    feed_name: str | None = None
    if line and line in LINE_TO_FEED:
        feed_name = LINE_TO_FEED[line]
    else:
        # Best-effort inference: prefix letter or digit → feed.
        head = stop_id[:1].upper()
        feed_name = LINE_TO_FEED.get(head)
    if not feed_name:
        return {"stop_id": stop_id, "north": [], "south": [], "error": "no feed for line"}

    try:
        trips = await _fetch_feed(feed_name)
    except Exception as e:
        return {"stop_id": stop_id, "north": [], "south": [], "error": f"feed: {e}"}

    now = time.time()
    north: list[dict[str, Any]] = []
    south: list[dict[str, Any]] = []
    target_n = stop_id.upper() + "N"
    target_s = stop_id.upper() + "S"

    for tu in trips:
        route_id = tu.trip.route_id if tu.HasField("trip") else ""
        if line and route_id and route_id != line:
            continue
        for stu in tu.stop_time_update:
            stop = stu.stop_id.upper()
            if stop != target_n and stop != target_s:
                continue
            t = 0
            if stu.HasField("arrival") and stu.arrival.time:
                t = stu.arrival.time
            elif stu.HasField("departure") and stu.departure.time:
                t = stu.departure.time
            if t == 0 or t < now - 30:
                continue  # already departed
            entry = {
                "route": route_id or line,
                "minutes": max(0, int(round((t - now) / 60))),
                "epoch": int(t),
            }
            (north if stop == target_n else south).append(entry)

    north.sort(key=lambda e: e["epoch"])
    south.sort(key=lambda e: e["epoch"])
    return {
        "stop_id": stop_id,
        "line": line,
        "fetched_at": int(now),
        "north": north[:limit],
        "south": south[:limit],
    }
