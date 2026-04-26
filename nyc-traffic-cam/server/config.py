"""Runtime configuration. Override via env vars."""
from __future__ import annotations
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("NYC_DB_PATH", ROOT / "data" / "nyc.db"))
SNAPSHOT_DIR = Path(os.environ.get("NYC_SNAPSHOT_DIR", ROOT / "data" / "snapshots"))

NYC_API_URL = os.environ.get("NYC_API_URL", "https://webcams.nyctmc.org/cameras/graphql")

# Polling cadence (seconds).
# Probe (2026-04-26) showed upstream refreshes ~every 3-5s.
# 15s/cam = 64 RPS sustained, ~350 MB/hour download — catches multi-frame events.
NORMAL_POLL_INTERVAL = int(os.environ.get("NYC_POLL_INTERVAL", "15"))
HOT_POLL_INTERVAL = int(os.environ.get("NYC_HOT_POLL_INTERVAL", "5"))
HOT_WINDOW_SECONDS = int(os.environ.get("NYC_HOT_WINDOW", "600"))        # 10 min after last alert
MAX_CONCURRENT_FETCHES = int(os.environ.get("NYC_MAX_CONCURRENT", "32"))
FETCH_TIMEOUT_SECONDS = float(os.environ.get("NYC_FETCH_TIMEOUT", "15"))
FETCH_JITTER_SECONDS = float(os.environ.get("NYC_FETCH_JITTER", "1.5"))

# Frame-diff anomaly detection.
DIFF_DOWNSCALE = 96                 # frames are downscaled to NxN grayscale before diff
DIFF_WARMUP_SAMPLES = 8             # need this many samples before z-scoring
DIFF_Z_ALERT = 3.0                  # z-score >= this triggers a "sudden change" alert
DIFF_Z_HIGH = 5.0                   # severity caps to 10 around this z-score
DIFF_STATIC_THRESHOLD = 0.4         # mean abs diff below this counts as "no motion"
STATIC_FEED_TICKS = 10              # consecutive low-diff ticks => static feed alert
OFFLINE_FAILURES = 3                # consecutive fetch failures => offline alert

# Alert dedup / lifecycle.
DEDUP_WINDOW_SECONDS = 600          # don't open a 2nd alert of same kind within this window
RESOLVE_AFTER_NORMAL_TICKS = 3      # auto-resolve after this many normal ticks

DB_PATH.parent.mkdir(parents=True, exist_ok=True)
SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
