"""Frame decode + per-camera anomaly scoring (Welford's running stats)."""
from __future__ import annotations

import io
import math
from dataclasses import dataclass
from typing import Optional

import numpy as np
from PIL import Image

from .config import (
    DIFF_DOWNSCALE,
    DIFF_WARMUP_SAMPLES,
    DIFF_Z_ALERT,
    DIFF_Z_HIGH,
    DIFF_STATIC_THRESHOLD,
)


@dataclass
class FrameStats:
    """Per-camera state held in memory by the ingestor."""
    last_thumbnail: Optional[np.ndarray] = None
    diff_mean: float = 0.0
    diff_m2: float = 0.0
    diff_count: int = 0


@dataclass
class FrameAnalysis:
    diff_score: float
    z_score: float
    severity: int
    is_anomaly: bool
    is_static: bool
    thumbnail: np.ndarray  # 8-bit grayscale, DIFF_DOWNSCALE x DIFF_DOWNSCALE


def decode_to_thumbnail(jpeg_bytes: bytes) -> Optional[np.ndarray]:
    try:
        img = Image.open(io.BytesIO(jpeg_bytes))
        img = img.convert("L").resize((DIFF_DOWNSCALE, DIFF_DOWNSCALE), Image.BILINEAR)
        return np.asarray(img, dtype=np.uint8)
    except Exception:
        return None


def analyze(state: FrameStats, jpeg_bytes: bytes) -> Optional[FrameAnalysis]:
    """Update Welford running stats and return per-frame analysis. Mutates `state`."""
    thumb = decode_to_thumbnail(jpeg_bytes)
    if thumb is None:
        return None

    if state.last_thumbnail is None:
        state.last_thumbnail = thumb
        return FrameAnalysis(
            diff_score=0.0, z_score=0.0, severity=0,
            is_anomaly=False, is_static=False, thumbnail=thumb,
        )

    # Mean absolute difference, normalized to 0..255.
    diff = float(np.mean(np.abs(thumb.astype(np.int16) - state.last_thumbnail.astype(np.int16))))
    state.last_thumbnail = thumb

    # Welford running mean & variance.
    state.diff_count += 1
    delta = diff - state.diff_mean
    state.diff_mean += delta / state.diff_count
    state.diff_m2 += delta * (diff - state.diff_mean)

    if state.diff_count < DIFF_WARMUP_SAMPLES:
        return FrameAnalysis(
            diff_score=diff, z_score=0.0, severity=0,
            is_anomaly=False, is_static=diff < DIFF_STATIC_THRESHOLD, thumbnail=thumb,
        )

    variance = state.diff_m2 / max(state.diff_count - 1, 1)
    std = math.sqrt(variance) if variance > 1e-9 else 1e-9
    z = (diff - state.diff_mean) / std

    is_anomaly = z >= DIFF_Z_ALERT
    is_static = diff < DIFF_STATIC_THRESHOLD

    if is_anomaly:
        # Scale z in [DIFF_Z_ALERT, DIFF_Z_HIGH] to severity in [4, 10].
        ratio = (z - DIFF_Z_ALERT) / max(DIFF_Z_HIGH - DIFF_Z_ALERT, 1e-9)
        severity = max(4, min(10, 4 + int(round(ratio * 6))))
    else:
        severity = 0

    return FrameAnalysis(
        diff_score=diff,
        z_score=z,
        severity=severity,
        is_anomaly=is_anomaly,
        is_static=is_static,
        thumbnail=thumb,
    )


def thumbnail_to_b64_png(thumb: np.ndarray) -> str:
    """Encode a thumbnail as base64 PNG for storing on alerts."""
    import base64
    buf = io.BytesIO()
    Image.fromarray(thumb, mode="L").save(buf, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
