# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo state — read this first

This project is a partial Create React App scaffold and **does not currently run as-is**. Before starting any task that requires `npm start`/`npm test`, expect to add the missing pieces below.

- `index.html` at the repo root is misnamed: it contains raw TSX (a React component), not HTML. It is a near-duplicate of `src/location-camera-app.tsx` — the two files have diverged slightly (the root file has more error handling, dev-fallback test cameras, an extra `Settings` icon import, and a `[watchId]` effect dep). Treat `src/location-camera-app.tsx` as the canonical component unless the user says otherwise, and confirm before editing the root `index.html`.
- There is no `public/index.html` and no `src/index.tsx` entry point, so `react-scripts start` will fail. If running locally is required, scaffold those files (or migrate to Vite) before debugging anything else.
- `package.json` declares `react-scripts` 4.0.3 with React 17 and `lucide-react@^0.1.0` (a very early version — the icons used in the component may not all exist in that release; if imports break, bumping `lucide-react` is the likely fix).
- The component uses Tailwind utility classes throughout, but there is no Tailwind config, PostCSS config, or CSS import. Styling will not render until Tailwind is wired up.

## Commands

Scripts in `package.json` (CRA defaults — see caveats above):

- `npm start` — dev server (currently broken; needs entry point)
- `npm run build` — production build
- `npm test` — Jest via `react-scripts` (no tests exist yet)
- `npm test -- --testPathPattern=<name>` — run a single test file

## Architecture

Single-component app: `LocationCameraApp` in `src/location-camera-app.tsx`. The data flow is:

1. **On mount**, `fetchCameras()` POSTs a GraphQL query to `https://webcams.nyctmc.org/cameras/graphql` to load all online NYC DOT traffic cameras (`{ id, latitude, longitude, isOnline }`), filters by `isOnline`, and stores them in state.
2. **`startTracking()`** calls `navigator.geolocation.watchPosition` with `enableHighAccuracy: true`. Each position update runs `handleLocationUpdate`, which:
   - Recomputes the nearest camera via `findNearestCamera` (linear scan + Haversine distance in `calculateDistance`).
   - If the nearest camera is within `threshold` meters (default 100m, user-adjustable 50–1000) **and** more than 30 s have passed since `lastTrigger`, it calls `fetchCameraImage`.
3. **`fetchCameraImage`** POSTs a second GraphQL query (`camera(cameraId)` + `watermark(cameraId) { imageBase64 }`) and prepends the result to `capturedImages`, which is capped at 5 entries.

Two invariants worth preserving when modifying this flow:
- The **30 s trigger cooldown** prevents the same camera from firing repeatedly while the user idles inside the threshold radius. Don't remove it without replacing it with another debounce mechanism.
- `capturedImages` is intentionally truncated to the last 5 (`prev.slice(0, 4)`) — the captured images are base64 data URLs and can be large, so unbounded growth would balloon memory.

### External API contract

The app depends entirely on the NYC TMC GraphQL endpoint. Relevant shape:

- `cameras { id, latitude, longitude, isOnline }` — `id` is a UUID string.
- `camera(cameraId: UUID!) { name }` and `watermark(cameraId: UUID!) { imageBase64, position }` — `imageBase64` is returned as a full data URL suitable for `<img src>`.

The endpoint is public and unauthenticated but third-party — assume it can change or rate-limit. Network failures fall back to two hardcoded test cameras (root `index.html` only).
