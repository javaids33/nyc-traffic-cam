# BOROUGH BLITZ 🚕

Spot the NYC traffic cam. You get a live frame from a real NYC DOT camera — drop a pin on the map and guess where in the city it is. 5 rounds, easy/medium/hard, a daily challenge, and shareable links so a friend plays your exact run.

A standalone game extracted from [NYC Traffic Cam Co.](../nyc-traffic-cam), deployed as its own Cloudflare Pages project.

## Stack

- **React 18 + Vite + TypeScript**, Tailwind
- **MapLibre GL** (`react-map-gl`) over CartoDB dark-matter raster tiles — the guess map
- Live frames straight from `webcams.nyctmc.org` (public, no key)
- **Cloudflare Pages** static hosting + **Pages Functions** + **KV** for shareable challenge links
- No backend server — camera data is baked into the bundle (`src/cams.json`)

## Game

- **Difficulty** draws from balanced ~315-camera pools, tiered by a recognizability score derived from the parent app's POI classifications (landmark / skyline / scene / area / interest). Easy = the core & landmarks; hard = anonymous blocks.
- **Modifiers**: grayscale, per-round timer (30/60s), no-zoom.
- **Daily challenge**: the same 5 cameras citywide each NYC day (deterministic seed `DAILY-YYYY-MM-DD`).
- **Scoring**: 100 pts/round, NYC distance bands (BULLSEYE → SAME BLOCK → … → JERSEY?).
- **Share**: a minted `?h=<hash>` link pins your exact 5 cameras in KV for 24h; the `?seed=` link is the offline fallback.

## Develop

```bash
npm install
npm run dev            # vite dev server (game only; share API needs pages dev)
npm run typecheck
npm run bake           # regenerate src/cams.json from ../nyc-traffic-cam
```

To exercise the share/challenge API locally (Pages Functions + KV), build then run wrangler:

```bash
npm run build
npm run pages:dev      # serves dist/ + functions/ with a local KV
```

## Deploy (Cloudflare Pages)

One-time:

```bash
wrangler login
wrangler kv namespace create BB_CHALLENGES
# paste the returned id into wrangler.jsonc → kv_namespaces[0].id
```

Then:

```bash
npm run deploy         # build + wrangler pages deploy dist --project-name borough-blitz
```

The first deploy creates the `borough-blitz` Pages project → `https://borough-blitz.pages.dev`. Bind the `CHALLENGES` KV namespace to the project (Pages → Settings → Functions → KV bindings) so the share API works in production.

## AdSense

All ad config lives in **`src/ads.tsx`** — set `ADSENSE_CLIENT` to your `ca-pub-…` ID and fill in the slot IDs, then update `public/ads.txt`. Until a real ID is set, no loader script is injected and ad slots render as placeholders in dev only. Ads appear on the start and summary screens, never over live gameplay.

## Data

`src/cams.json` is generated from the parent repo (`npm run bake`). Re-run it after the parent app refreshes its camera list or POI classifications.

Not affiliated with NYC DOT or GeoGuessr. Live camera imagery © NYC DOT Traffic Management Center (public feed).
