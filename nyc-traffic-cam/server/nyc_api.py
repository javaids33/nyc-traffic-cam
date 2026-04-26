"""Tiny GraphQL client for the NYC TMC webcams API."""
from __future__ import annotations

import base64
from typing import Any

import httpx

from .config import NYC_API_URL, FETCH_TIMEOUT_SECONDS

CAMERAS_QUERY = """
query {
  cameras {
    id
    name
    latitude
    longitude
    isOnline
    area
  }
}
"""

IMAGE_QUERY = "query($id: UUID!) { cameraImage(cameraId: $id) }"


class NycApi:
    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self._client = client or httpx.AsyncClient(
            timeout=FETCH_TIMEOUT_SECONDS,
            headers={"content-type": "application/json", "user-agent": "nyc-traffic-cam-monitor/0.1"},
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def list_cameras(self) -> list[dict[str, Any]]:
        resp = await self._client.post(NYC_API_URL, json={"query": CAMERAS_QUERY})
        resp.raise_for_status()
        data = resp.json()
        if data.get("errors"):
            raise RuntimeError(f"GraphQL errors: {data['errors']}")
        out = []
        for cam in data["data"]["cameras"] or []:
            if not cam.get("isOnline"):
                continue
            try:
                out.append({
                    "id": cam["id"],
                    "name": cam.get("name"),
                    "lat": float(cam["latitude"]),
                    "lng": float(cam["longitude"]),
                    "isOnline": True,
                    "area": cam.get("area"),
                })
            except (TypeError, ValueError):
                continue
        return out

    async def fetch_image(self, camera_id: str) -> bytes | None:
        """Returns raw JPEG bytes, or None if the API returned nothing."""
        resp = await self._client.post(
            NYC_API_URL,
            json={"query": IMAGE_QUERY, "variables": {"id": camera_id}},
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("errors"):
            raise RuntimeError(f"GraphQL errors: {data['errors']}")
        img = (data.get("data") or {}).get("cameraImage")
        if not img:
            return None
        payload = img.split(",", 1)[1] if "," in img else img
        try:
            return base64.b64decode(payload)
        except (ValueError, base64.binascii.Error):
            return None
