#!/usr/bin/env node
/* Regenerate src/cams.json — the slim, difficulty-tagged camera pool that
 * Borough Blitz ships in its bundle.
 *
 * Source of truth lives in the parent NYC-traffic-cam app:
 *   ../nyc-traffic-cam/src/cameras.json    (id, name, lat, lng)
 *   ../nyc-traffic-cam/src/cam-pois.json    (ML scene/area/landmark/interest)
 *   ../nyc-traffic-cam/src/cam-health.json  (frozen-feed blacklist)
 *
 * We compute a continuous "recognizability" score per camera, then split the
 * usable cameras into terciles → easy / medium / hard (balanced ~315 each).
 * Easy = most recognizable (landmarks, skyline, the core); hard = anonymous
 * blocks that could be anywhere.
 *
 * Run:  npm run bake     (from the borough-blitz/ dir)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..', '..', 'nyc-traffic-cam', 'src');
const OUT = path.resolve(__dirname, '..', 'src', 'cams.json');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const camMeta = readJson(path.join(SRC, 'cameras.json'));
const pois = readJson(path.join(SRC, 'cam-pois.json')).cameras;
const health = readJson(path.join(SRC, 'cam-health.json'));
const frozen = new Set(health.frozen ?? []);
const byId = new Map(camMeta.cameras.map((c) => [c.id, c]));

function recog(p) {
  let s = p.interest || 0;
  if (p.landmark_name) s += 40;
  if (p.skyline_visible) s += 18;
  if (p.area_type === 'downtown') s += 14;
  else if (p.area_type === 'waterfront') s += 8;
  else if (p.area_type === 'commercial') s += 5;
  if (p.crowd_or_event) s += 10;
  if (['bridge', 'tunnel', 'skyline'].includes(p.scene)) s += 10;
  if (p.scene === 'highway') s -= 8;
  if (p.scene === 'residential') s -= 4;
  if (p.congestion === 'busy' || p.congestion === 'jammed') s += 4;
  if (p.weather === 'snow') s += 6;
  if (p.weather === 'fog') s += 4;
  return s;
}

const rows = [];
for (const [id, p] of Object.entries(pois)) {
  const cam = byId.get(id);
  if (!cam || !cam.lat || !cam.lng) continue;
  if (frozen.has(id)) continue;
  if (p.image_usable === false) continue;
  if (['broken', 'empty'].includes(p.quality)) continue;
  rows.push({
    id,
    name: cam.name || null,
    lat: cam.lat,
    lng: cam.lng,
    _s: recog(p),
    scene: p.scene || null,
    area: p.area_type || null,
    landmark: p.landmark_name || null,
  });
}

rows.sort((a, b) => a._s - b._s);
const n = rows.length;
const t1 = Math.floor(n / 3);
const t2 = Math.floor((2 * n) / 3);
rows.forEach((r, i) => {
  r.tier = i < t1 ? 'hard' : i < t2 ? 'medium' : 'easy';
});

const cameras = rows.map(({ _s, ...r }) => r);
const payload = {
  generated_at: Math.floor(Date.now() / 1000),
  source_generated_at: camMeta.generated_at,
  count: cameras.length,
  tiers: {
    easy: cameras.filter((r) => r.tier === 'easy').length,
    medium: cameras.filter((r) => r.tier === 'medium').length,
    hard: cameras.filter((r) => r.tier === 'hard').length,
  },
  cameras,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload));
console.log(`wrote ${cameras.length} cams → ${path.relative(process.cwd(), OUT)}`);
console.log(`tiers: ${JSON.stringify(payload.tiers)}  (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
