# NYC Traffic Cam Monitor

A real-time anomaly-detection dashboard for all ~954 online NYC DOT traffic cameras.
Polls every camera, runs frame-difference + per-camera statistical anomaly detection,
and surfaces alerts on a live map with severity heatmap, picture-in-picture feeds,
and a Lo-Fi "channel-flip" mode that auto-flies between live alerts.

## What it does

- **Polls every online NYC traffic camera** at 15 s intervals (5 s for cameras with active alerts).
- **Self-calibrating anomaly detection**: per-camera Welford running mean/variance over frame-diff scores. A camera pointed at a parking lot has a different "normal" than one on the BQE — the z-score adapts automatically.
- **Three alert kinds out of the box**:
  - `sudden_change` — frame-diff z-score ≥ 3 (anything visually unusual)
  - `static_feed` — 10 consecutive ticks of ~zero motion (frozen / broken camera)
  - `camera_offline` — 3 consecutive fetch failures
- **Live dashboard** (React + Vite + MapLibre + deck.gl) with severity heatmap, clickable camera dots, alert sidebar with inline JPEG thumbnails, and a Lo-Fi mode that auto-flies the map to each new alert and shows a live PIP of the camera.

## Architecture

```
NYC GraphQL API (webcams.nyctmc.org)
        │
        ▼
  Async ingestor (Python, 32 concurrent fetches)
        │  raw JPEG bytes
        ▼
  Frame processor (decode → 96×96 grayscale → mean-abs diff vs prior)
        │  per-camera Welford running stats
        ▼
  Rules engine (z-score thresholds + dedup + auto-resolve)
        │  alert events
        ▼
  SQLite + WebSocket broadcast
        │
        ▼
  React dashboard (MapLibre + deck.gl HeatmapLayer)
```

## Running it locally

You need Python 3.11+ and Node 18+.

```bash
# Install Python deps
python3 -m venv .venv
.venv/bin/pip install -r server/requirements.txt

# Install JS deps
npm install

# Terminal 1 — backend (FastAPI + ingestor)
.venv/bin/uvicorn server.main:app --host 127.0.0.1 --port 8000

# Terminal 2 — frontend (Vite dev server, proxies /api and /ws to backend)
npm run dev

# → open http://localhost:5173/
```

State lives in `data/nyc.db` (SQLite WAL). Delete the directory to reset.

## Configuration

Override via env vars (see `server/config.py`):

- `NYC_POLL_INTERVAL=15` — normal cadence per camera (seconds)
- `NYC_HOT_POLL_INTERVAL=5` — cadence for cameras with recent alerts
- `NYC_MAX_CONCURRENT=32` — max in-flight fetches
- `NYC_HOT_WINDOW=600` — how long after an alert a camera stays "hot"

## Project layout

```
server/                    # Python backend
├── main.py                # FastAPI app + WebSocket endpoint
├── ingestor.py            # async polling loop with hot-cam acceleration
├── frame_processor.py     # JPEG → diff score with Welford stats
├── rules.py               # alert open/update/resolve + dedup
├── nyc_api.py             # GraphQL client (uses cameraImage, not watermark)
├── db.py                  # SQLite schema + queries
├── state.py               # in-memory shared state + WS fan-out
└── config.py              # tunable constants

src/                       # React dashboard
├── main.tsx               # entry point
├── dashboard.tsx          # map + alerts sidebar + Lo-Fi PIP
├── api.ts                 # REST + WebSocket client
├── types.ts               # shared types matching the backend
└── location-camera-app.tsx  # legacy "geolocation triggers a snapshot" demo

vite.config.ts             # proxies /api, /ws to backend; /nyc-graphql passthrough
```

## License

MIT.
