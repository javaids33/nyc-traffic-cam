import { useEffect, useState } from 'react';
import Particles, { initParticlesEngine } from '@tsparticles/react';
import type { ISourceOptions } from '@tsparticles/engine';
import { loadSlim } from '@tsparticles/slim';

/* Single-init guard — tsparticles wants the engine ready exactly once
   per page lifetime. We track init state in module scope so multiple
   particle layers on the same page share the same boot. */
let inited = false;
let initPromise: Promise<void> | null = null;
function ensureInit(): Promise<void> {
  if (inited) return Promise.resolve();
  if (initPromise) return initPromise;
  initPromise = initParticlesEngine(async (engine) => {
    await loadSlim(engine);
  }).then(() => { inited = true; });
  return initPromise;
}

function useTsParticlesReady(): boolean {
  const [ready, setReady] = useState(inited);
  useEffect(() => {
    if (inited) { setReady(true); return; }
    let alive = true;
    ensureInit().then(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, []);
  return ready;
}

/* ShrineParticles — fireflies floating around the shrine altar.
   Confined to its parent container (parent must be position:relative
   and have its own dimensions). pointer-events: none on the canvas
   so it never captures clicks. */
const SHRINE_OPTIONS: ISourceOptions = {
  fullScreen: { enable: false },
  background: { color: { value: 'transparent' } },
  detectRetina: true,
  fpsLimit: 50,
  particles: {
    number: { value: 28, density: { enable: true, width: 800, height: 600 } },
    color: { value: ['#FFD600', '#FFE89A', '#FF8A3A'] },
    shape: { type: 'circle' },
    opacity: {
      value: { min: 0.25, max: 0.85 },
      animation: { enable: true, speed: 0.6, sync: false, startValue: 'random' },
    },
    size: { value: { min: 0.8, max: 2.4 } },
    move: {
      enable: true,
      speed: { min: 0.2, max: 0.7 },
      direction: 'none',
      random: true,
      straight: false,
      outModes: { default: 'out' },
      drift: { min: -0.4, max: 0.4 },
    },
    twinkle: {
      particles: { enable: true, color: '#FFD600', frequency: 0.06, opacity: 0.95 },
    },
  },
};

export function ShrineParticles() {
  const ready = useTsParticlesReady();
  if (!ready) return null;
  return (
    <Particles
      id="shrine-fireflies"
      options={SHRINE_OPTIONS}
      className="absolute inset-0 pointer-events-none"
      style={{ position: 'absolute', inset: 0 }}
    />
  );
}
