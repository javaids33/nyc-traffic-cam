# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project shape

NYC Traffic Cam Co. — a maximalist NYC bodega-themed dashboard around the public NYC DOT traffic-cam network, plus several mini-modes (subway-ride simulator, GeoGuessr-style game, scratch-off arcade, civic shrine). React + Vite frontend; FastAPI + SQLite backend on Fly.io; Cloudflare Pages hosts the static frontend.

```
.
├── src/                      ← React 18 + Vite + Tailwind (dark + zine aesthetic)
│   ├── main.tsx              ← Manual path-prefix router (no React Router)
│   ├── lounge.tsx            ← /            "TV lounge" — main page, surfs cams
│   ├── turnstile.tsx         ← /turnstile   "Hop the Turnstile" — pick line, ride, GTFS-RT
│   ├── geoguessr.tsx         ← /geoguessr   5-round cam guessing game w/ shareable hash
│   ├── scratch.tsx           ← /scratch     $1 scratch-off arcade (3 game modes)
│   ├── shrine.tsx            ← /shrine      Mamdani Shrine — civic education + HPD lookup
│   ├── about.tsx, game.tsx   ← /about, /game (Jimmy's Arcade typing game)
│   ├── audio-store.ts/-panel ← Singleton audio + radio + Tone.js lofi pad
│   ├── quarter.tsx           ← Quarter stash + RollingQuarter + HiddenCoin easter eggs
│   ├── bodega-tv.tsx         ← BodegaAwning, BodegaTV, StreetFauna (rats, cab, scooter…)
│   ├── civic-data.ts         ← GeoSearch + HPD (open Socrata) + Legistar fetchers
│   ├── fx-particles.tsx      ← tsparticles ShrineParticles (altar fireflies)
│   ├── fx-lottie.tsx         ← LottieRemote helper (any public Lottie URL)
│   └── api.ts, types.ts      ← Backend client (Fly), shared types
├── server/                   ← FastAPI + asyncio
│   ├── main.py               ← REST + WS, /api/cameras /api/alerts /api/challenges /api/transit/arrivals
│   ├── db.py                 ← aiosqlite — cameras, alerts, geoguessr_challenges
│   ├── ingestor.py           ← polls NYC DOT, runs frame-diff anomaly detection
│   ├── transit.py            ← MTA GTFS-RT protobuf decoder (gtfs-realtime-bindings)
│   └── …
├── data/                     ← SQLite + snapshot JPEGs (gitignored)
├── Dockerfile, fly.toml      ← Fly.io deploy
└── vite.config.ts, tailwind.config.js, postcss.config.js
```

### Routing

There is **no React Router**. `src/main.tsx` mounts the right page component based on `window.location.pathname` prefix matching. To add a route, add an `import` and an extra ternary branch in `main.tsx`. Pretty URLs (e.g. `/turnstile`, `/shrine`, `/scratch`) are served by Cloudflare Pages with the SPA fallback rewriting any unmatched path to `/index.html`.

## Commands

Frontend (run from repo root):

```
npm install
npm run dev       # vite dev server, picks an open port (typically 5173-5176)
npm run build     # tsc -b && vite build → dist/
npm run preview   # serve the built dist/
npm run typecheck # tsc --noEmit
```

Backend (run from repo root, requires `server/.venv` or root `.venv`):

```
.venv/bin/uvicorn server.main:app --reload --port 8000
.venv/bin/python -m pytest server/tests   # if/when tests exist
```

One-time data jobs (run from repo root):

```
.venv/bin/python -m server.sync_cameras                 # refresh src/cameras.json from NYCTMC GraphQL
.venv/bin/python -m server.check_cameras --concurrency 24
                                                        # probe every cam, write data/cam_health.json + src/cam-health.json
.venv/bin/python -m server.poi_classify_local --resume  # classify cams via LOCAL Ollama vision model
                                                        # → writes src/cam-pois.json (lights up /poi page)
                                                        # default model: llama3.2-vision (needs Ollama ≥ 0.5.13)
                                                        # fallback: --model llava:7b on older Ollama
.venv/bin/python -m server.poi_classify --resume        # same job, but cloud Anthropic API (needs ANTHROPIC_API_KEY)
```

Local POI classification — preferred over the cloud path. Requires Ollama
running locally with a vision model pulled (`ollama pull llama3.2-vision`
or `ollama pull llava:7b`). The script runs ~3-8s per cam on M-series
Macs with no API cost. Outputs are byte-identical schema to the cloud
version, so the frontend can't tell the difference.

The frontend's `src/api.ts` auto-routes `/api` calls to:
- `""` (Vite dev proxy) when `window.location.hostname` is localhost
- `https://nyc-cam-monitor.fly.dev` otherwise — pinned so the deployed Pages site never breaks even if `VITE_BACKEND_URL` isn't piped through. Override with `VITE_BACKEND_URL` at build time.

## External APIs in use

All client-side, no API keys, CORS-friendly. Listed for "if it breaks, here's where to look":

| Endpoint | Purpose | Used by |
| --- | --- | --- |
| `webcams.nyctmc.org/cameras/graphql` | NYC DOT cam list + per-cam frames | server `ingestor.py`, frontend image URLs |
| `webcams.nyctmc.org/api/cameras/{id}/image?t=…` | Single-cam JPEG (cache-busted) | turnstile, geoguessr direct fetch |
| `data.ny.gov/resource/39hk-dx4f.json` | MTA subway stations + GTFS stop_id | turnstile `useMtaStations` |
| `api.subwaynow.app/routes` | Live MTA service status | turnstile `MtaLineStatus` |
| MTA GTFS-RT feeds (`api-endpoint.mta.info/Dataservices/mtagtfsfeeds/nyct%2F…`) | Real-time train arrivals (protobuf) | server `transit.py`, surfaced via `/api/transit/arrivals` |
| `data.cityofnewyork.us/resource/wvxf-dwi5.json` | HPD violations | shrine `BuildingLookup` |
| `data.cityofnewyork.us/resource/ygpa-z7cr.json` | HPD complaint problems (filtered by block+lot) | shrine `BuildingLookup` |
| `geosearch.planninglabs.nyc/v2/{autocomplete,search}` | Address → BIN/BBL/coords | shrine `BuildingLookup` |
| `en.wikipedia.org/api/rest_v1/page/summary/Zohran_Mamdani` | Mayor portrait fallback | shrine `useMayorPhoto` |
| `webapi.legistar.com/v1/nyc/{Matters,Events}` | NYC Council bills + hearings | shrine — **gated as of 2026-mid** (returns 403 anonymously); UI falls back to `<GatedFeedCard>` linking to `legistar.council.nyc.gov` |
| `data.cityofnewyork.us/resource/erm2-nwe9.json` | NYC 311 service requests | lounge `<TimesSquareTicker>` etc. |

### NYC API Portal (`api-portal.nyc.gov`) — intentionally avoided

The Azure-gated API portal exposes the same data behind subscription keys (HPD DataFeed, Event Calendar, NYC 311, etc.). We deliberately route around it — keys can't ship in the frontend, so using it would force a backend proxy. Our open Socrata + GeoSearch path needs zero auth.

If we ever do need the gated APIs (higher rate limits, write access for 311), the proxy pattern is: `fly secrets set NYC_HPD_KEY=…`, add `/api/proxy/hpd/...` to `server/main.py` forwarding the `Ocp-Apim-Subscription-Key` header.

## Server-side endpoints

`server/main.py`:

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/health` | metrics + cameras_loaded count |
| GET | `/api/cameras` | full camera list w/ status (cached in DB) |
| GET | `/api/alerts` | recent alerts; `?active_only=true&since=<ts>&limit=…` |
| GET | `/api/alerts/{id}/image.jpg` | JPEG that triggered the alert |
| GET | `/api/cameras/{id}/snapshot.jpg` | latest cached frame |
| GET | `/api/stats` | online + polled counts |
| WS  | `/ws/alerts` | live alert stream |
| POST | `/api/challenges` | snapshot 5 cam UUIDs for a geoguessr share — body `{cameras:[uuid…], score, grade}`, returns `{hash, expires_in_seconds}`. **Rate limit:** 30/IP/hr. **Storage cap:** 10k rows. **TTL:** 24h, lazy-swept on every write. |
| GET | `/api/challenges/{hash}` | retrieve a pinned challenge; 404 if missing, 410 if expired |
| GET | `/api/transit/arrivals` | `?stop_id=F25&line=F` → next-train predictions (north + south), 25s feed cache |

## Invariants worth preserving

- **Quarter economy**: localStorage key `nyc-quarters`, mutated only via `useQuarters()`. The seed grant (3 quarters on first visit) is gated by `nyc-quarters-seeded` so re-seeding doesn't double-grant. `RollingQuarter` cadence is intentionally 22-55s — bumping faster makes the page feel like a slot machine.
- **Camera image cap**: legacy `LocationCameraApp` capped captured images at 5 (`prev.slice(0, 4)`) because base64 data URLs balloon memory. Carry that pattern if you reintroduce a similar component.
- **Geoguessr share hashes**: server `db.geoguessr_challenges` is a soft-bounded ring (TTL 24h, hard cap 10k). A change here changes how shares behave for everyone. Don't loosen the rate limit without good reason.
- **Audio singleton**: `audio-store.ts` is module-scoped; multiple `useAudio()` consumers share one playing source. Don't introduce a per-component audio context — switching tabs/UIs while music plays should not interrupt it.
- **Ambient animations**: `<AmbientSky>` set-pieces (pizza, pigeon flock, balloon) are clipped to the top 14vh sky band or a side rail, `pointer-events: none`, `z: 0`. They MUST NOT cross the centered content column or capture clicks.
- **Soft-failing 3rd-party data**: many feeds (Legistar, HPD complaints) silently return 403. Components must degrade gracefully — render a "view live at <source>" link card, not a stack trace. Pattern: `fetchX(): Promise<T[] | null>` where null = gated/unavailable.
- **Borough nav opacity**: the lounge borough sub-header MUST be opaque (`bg-[#0a0a14]`, not `bg-black/55`) — otherwise the TV's "ON AIR / live broadcast" neon sign behind it bleeds through.

## Libraries beyond the obvious

- **maplibre-gl** + **react-map-gl** — Carto Voyager raster tiles (lighter, accessible vs. Dark Matter)
- **canvas-confetti** — fires on bullseye / jackpot / big wins; emoji shapes on big scratch wins
- **@use-gesture/react** — pointer/touch handling for the scratch-card canvas (better than raw pointer events on iOS)
- **react-rough-notation** — sketchy hand-drawn highlights (verse of the day, JACKPOT, FINAL)
- **lottie-react** — `LottieRemote` slot in `fx-lottie.tsx` for any public Lottie JSON
- **tone** — generative Cmaj7→Am7→Fmaj7→G7 lofi pad in audio-store, lazy-loaded via dynamic import (~180kb gzipped, doesn't ship to non-LOFI users)
- **@tsparticles/react** + slim — `ShrineParticles` fireflies inside the altar
- **gtfs-realtime-bindings** (server) — MTA protobuf decoder for `/api/transit/arrivals`

## Deployment

**Frontend → Cloudflare Pages**: auto-deploys on push to `main` (the connected repo). Build command: `npm run build`. Output: `dist/`. SPA fallback rewrites unknown paths to `index.html`.

**Backend → Fly.io** (`nyc-cam-monitor`, region `ewr`): manual `fly deploy` from the repo root. Persistent volume `nyc_data` mounted at `/data` for the SQLite DB. Don't push backend changes that depend on new endpoints without coordinating a Fly deploy — the frontend is forward-tolerant (gracefully falls back) but new features won't light up.

Secrets live in Fly only (currently none beyond the defaults). Never commit secrets.

## CI

`.github/workflows/ci.yml` runs on every push/PR:

1. Frontend: `npm ci` → `npm run typecheck` → `npm run build`
2. Backend: `pip install -r server/requirements.txt` → `python -c "from server import main"` (smoke import)

Required to pass before merging.
