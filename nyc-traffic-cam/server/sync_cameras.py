"""sync_cameras.py — pull the NYC DOT camera list and bake it into src/.

The list changes maybe weekly (NYC DOT adds/removes a few cameras).
We snapshot it into src/cameras.json so the frontend can `import` the
list directly at build time — no API call, no spinner, no Python in
the request path.

Usage:
    python -m server.sync_cameras

Run weekly via .github/workflows/sync-cameras.yml. Output is committed.
"""
from __future__ import annotations

import asyncio
import json
import logging
import sys
import time
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "cameras.json"

NYCTMC_GRAPHQL = "https://webcams.nyctmc.org/cameras/graphql"
QUERY = """
{
  cameras {
    id
    name
    latitude
    longitude
    isOnline
  }
}
"""


async def fetch() -> list[dict[str, Any]]:
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(NYCTMC_GRAPHQL, json={"query": QUERY})
        r.raise_for_status()
        cams = r.json().get("data", {}).get("cameras", []) or []
    # Normalize keys to match what the frontend Camera type expects
    out: list[dict[str, Any]] = []
    for c in cams:
        try:
            out.append({
                "id": c["id"],
                "name": c.get("name") or "",
                "lat": float(c["latitude"]),
                "lng": float(c["longitude"]),
                "is_online": bool(c.get("isOnline", False)),
            })
        except (KeyError, ValueError, TypeError):
            continue
    return out


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cams = await fetch()
    if not cams:
        sys.exit("error: NYCTMC returned 0 cameras (something's wrong; not overwriting)")
    payload = {
        "generated_at": int(time.time()),
        "count": len(cams),
        "cameras": cams,
    }
    OUT.write_text(json.dumps(payload, indent=2))
    online = sum(1 for c in cams if c.get("is_online"))
    logging.info("wrote %d cameras (%d online) to %s", len(cams), online, OUT)


if __name__ == "__main__":
    asyncio.run(main())
