import { useEffect, useState } from 'react';

/* Module-level audio singleton. The AudioPanel and the in-TV mini
   control both call useAudio() — they share one playing source so the
   user can switch UIs (e.g. into fullscreen TV) without losing the
   stream they're listening to. */

export type Station = {
  id: string;
  call: string;
  freq: string;
  vibe: string;
  url: string;
};

export const STATIONS: Station[] = [
  { id: 'wnyc-fm',  call: 'WNYC',  freq: '93.9 FM',     vibe: 'public radio · news · talk',          url: 'https://fm939.wnyc.org/wnycfm' },
  { id: 'wnyc-am',  call: 'WNYC',  freq: '820 AM',      vibe: 'spoken word · interviews',            url: 'https://am820.wnyc.org/wnycam' },
  { id: 'wbgo',     call: 'WBGO',  freq: '88.3 FM',     vibe: 'jazz · 24/7',                          url: 'https://wbgo.streamguys1.com/wbgo128' },
  { id: 'wqxr',     call: 'WQXR',  freq: '105.9 FM',    vibe: 'classical',                            url: 'https://stream.wqxr.org/wqxr' },
  { id: 'wfuv',     call: 'WFUV',  freq: '90.7 FM',     vibe: 'fordham · adult album alternative',    url: 'https://onair.wfuv.org/onair-hi.mp3' },
  { id: 'wbai',     call: 'WBAI',  freq: '99.5 FM',     vibe: 'pacifica · community',                 url: 'https://wbai.streamguys1.com/wbai' },
  { id: 'wkcr',     call: 'WKCR',  freq: '89.9 FM',     vibe: 'columbia · jazz / specialty',          url: 'https://wkcr-secure.cc.columbia.edu:8000/listen' },
  { id: 'wfmu',     call: 'WFMU',  freq: '91.1 FM',     vibe: 'freeform · weird in the best way',     url: 'https://stream0.wfmu.org/freeform-128k.mp3' },
  { id: 'wsou',     call: 'WSOU',  freq: '89.5 FM',     vibe: 'seton hall · loud rock',               url: 'https://stream.wsou.net/wsou.mp3' },
  { id: 'lot',      call: 'LOT',   freq: 'GREENPOINT',  vibe: 'brooklyn indie · live djs',            url: 'https://thelotradio.out.airtime.pro/thelotradio_a' },
  { id: 'nts1',     call: 'NTS',   freq: 'CH. 1',       vibe: 'global · curated · london ↔ ny',       url: 'https://stream-relay-geo.ntslive.net/stream' },
  { id: 'nts2',     call: 'NTS',   freq: 'CH. 2',       vibe: 'global · curated · b-side',            url: 'https://stream-relay-geo.ntslive.net/stream2' },
  { id: 'kexp',     call: 'KEXP',  freq: '90.3 SEA',    vibe: 'seattle · indie · sister station',     url: 'https://kexp-mp3-128.streamguys1.com/kexp128.mp3' },
];

export type AmbienceMode = 'ac' | 'subway' | 'street';
export const AMBIENCE: { id: AmbienceMode; label: string; gloss: string }[] = [
  { id: 'ac',     label: 'AC HUM',  gloss: 'window unit, july' },
  { id: 'subway', label: 'SUBWAY',  gloss: 'tracks below the deli' },
  { id: 'street', label: 'STREET',  gloss: 'sirens, distant' },
];

export type AudioSource =
  | { kind: 'radio'; stationId: string }
  | { kind: 'ambience'; mode: AmbienceMode }
  | null;

type State = {
  src: AudioSource;
  playing: boolean;
  vol: number;
  error: string | null;
};

let state: State = { src: null, playing: false, vol: 0.55, error: null };
const listeners = new Set<() => void>();
function emit() { listeners.forEach((l) => l()); }
function patch(p: Partial<State>) { state = { ...state, ...p }; emit(); }

let audioEl: HTMLAudioElement | null = null;
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let ambienceStop: (() => void) | null = null;

function ensureAudioEl(): HTMLAudioElement {
  if (audioEl) return audioEl;
  const a = new Audio();
  a.preload = 'none';
  a.addEventListener('error', () => patch({ error: 'signal lost — try another station', playing: false }));
  a.addEventListener('playing', () => patch({ playing: true, error: null }));
  a.addEventListener('pause', () => patch({ playing: false }));
  audioEl = a;
  return a;
}

function ensureCtx(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctx();
    master = ctx.createGain();
    master.gain.value = state.vol;
    master.connect(ctx.destination);
    return ctx;
  } catch {
    return null;
  }
}

function makeBrownNoise(c: AudioContext) {
  const buf = c.createBuffer(1, 2 * c.sampleRate, c.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    d[i] = (last + 0.02 * w) / 1.02;
    last = d[i];
    d[i] *= 3.5;
  }
  const s = c.createBufferSource();
  s.buffer = buf; s.loop = true;
  return s;
}
function makePinkNoise(c: AudioContext) {
  const buf = c.createBuffer(1, 2 * c.sampleRate, c.sampleRate);
  const d = buf.getChannelData(0);
  let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886*b0 + w*0.0555179;
    b1 = 0.99332*b1 + w*0.0750759;
    b2 = 0.96900*b2 + w*0.1538520;
    b3 = 0.86650*b3 + w*0.3104856;
    b4 = 0.55000*b4 + w*0.5329522;
    b5 = -0.7616*b5 - w*0.0168980;
    d[i] = (b0+b1+b2+b3+b4+b5+b6 + w*0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  const s = c.createBufferSource();
  s.buffer = buf; s.loop = true;
  return s;
}

export function audioStop() {
  if (audioEl) { audioEl.pause(); audioEl.src = ''; }
  ambienceStop?.();
  ambienceStop = null;
  patch({ playing: false });
}

export function audioOff() {
  audioStop();
  patch({ src: null });
}

export function audioTuneRadio(s: Station) {
  audioStop();
  patch({ src: { kind: 'radio', stationId: s.id }, error: null });
  const a = ensureAudioEl();
  a.src = s.url;
  a.volume = state.vol;
  a.play().catch(() => patch({ error: 'autoplay blocked — tap the station again', playing: false }));
}

export function audioStartAmbience(mode: AmbienceMode) {
  audioStop();
  patch({ src: { kind: 'ambience', mode }, error: null });
  const c = ensureCtx();
  if (!c || !master) return;
  const dest = master;
  if (c.state === 'suspended') c.resume().catch(() => {});
  const stops: (() => void)[] = [];

  if (mode === 'ac') {
    const noise = makeBrownNoise(c);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600;
    const gn = c.createGain(); gn.gain.value = 0.6;
    noise.connect(lp).connect(gn).connect(dest);
    const hum = c.createOscillator(); hum.type = 'sine'; hum.frequency.value = 60;
    const hgn = c.createGain(); hgn.gain.value = 0.12;
    hum.connect(hgn).connect(dest);
    noise.start(); hum.start();
    stops.push(() => { try { noise.stop(); hum.stop(); } catch { /* noop */ } });
  } else if (mode === 'subway') {
    const noise = makeBrownNoise(c);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 250;
    const gn = c.createGain(); gn.gain.value = 0.85;
    noise.connect(lp).connect(gn).connect(dest);
    noise.start();
    const swell = setInterval(() => {
      const t = c.currentTime;
      gn.gain.cancelScheduledValues(t);
      gn.gain.setValueAtTime(gn.gain.value, t);
      gn.gain.linearRampToValueAtTime(1.4 + Math.random() * 0.6, t + 1.2);
      gn.gain.linearRampToValueAtTime(0.85, t + 5);
    }, 12_000 + Math.random() * 12_000);
    const squeal = setInterval(() => {
      const t = c.currentTime;
      const o = c.createOscillator();
      const og = c.createGain();
      o.type = 'triangle';
      o.frequency.value = 1800 + Math.random() * 1200;
      og.gain.value = 0;
      o.connect(og).connect(dest);
      og.gain.linearRampToValueAtTime(0.05, t + 0.2);
      og.gain.linearRampToValueAtTime(0, t + 1.6);
      o.start(t); o.stop(t + 1.7);
    }, 45_000 + Math.random() * 45_000);
    stops.push(() => { try { noise.stop(); } catch { /* noop */ } clearInterval(swell); clearInterval(squeal); });
  } else if (mode === 'street') {
    const noise = makePinkNoise(c);
    const gn = c.createGain(); gn.gain.value = 0.4;
    noise.connect(gn).connect(dest);
    noise.start();
    const siren = setInterval(() => {
      const t = c.currentTime;
      const o = c.createOscillator();
      const og = c.createGain();
      o.type = 'sawtooth'; og.gain.value = 0;
      o.connect(og).connect(dest);
      og.gain.linearRampToValueAtTime(0.05, t + 0.4);
      og.gain.linearRampToValueAtTime(0.04, t + 4);
      og.gain.linearRampToValueAtTime(0, t + 5);
      o.frequency.setValueAtTime(700, t);
      for (let i = 0; i < 6; i++) {
        o.frequency.linearRampToValueAtTime(1100, t + 0.4 + i * 0.7);
        o.frequency.linearRampToValueAtTime(700,  t + 0.7 + i * 0.7);
      }
      o.start(t); o.stop(t + 5);
    }, 50_000 + Math.random() * 60_000);
    const horn = setInterval(() => {
      const t = c.currentTime;
      const o = c.createOscillator();
      const og = c.createGain();
      o.type = 'square'; o.frequency.value = 320; og.gain.value = 0;
      o.connect(og).connect(dest);
      og.gain.linearRampToValueAtTime(0.04, t + 0.05);
      og.gain.linearRampToValueAtTime(0.04, t + 0.35);
      og.gain.linearRampToValueAtTime(0, t + 0.5);
      o.start(t); o.stop(t + 0.55);
    }, 70_000 + Math.random() * 80_000);
    stops.push(() => { try { noise.stop(); } catch { /* noop */ } clearInterval(siren); clearInterval(horn); });
  }

  ambienceStop = () => stops.forEach((s) => s());
  patch({ playing: true });
}

export function audioToggle() {
  const s = state.src;
  if (!s) return;
  if (s.kind === 'radio' && audioEl) {
    if (state.playing) audioEl.pause();
    else audioEl.play().catch(() => patch({ error: 'autoplay blocked', playing: false }));
  } else if (s.kind === 'ambience') {
    // Ambience is a one-shot scheduled tree; "toggle" off means full stop
    if (state.playing) audioStop();
    else audioStartAmbience(s.mode);
  }
}

export function audioSetVol(v: number) {
  patch({ vol: v });
  if (audioEl) audioEl.volume = v;
  if (master) master.gain.value = v;
}

export function nowPlayingLabel(s: AudioSource): string | null {
  if (!s) return null;
  if (s.kind === 'radio') {
    const station = STATIONS.find((x) => x.id === s.stationId);
    return station ? `${station.call} · ${station.freq}` : null;
  }
  return AMBIENCE.find((m) => m.id === s.mode)?.label ?? null;
}

/* React hook: subscribe to the singleton. */
export function useAudio() {
  const [, forceTick] = useState(0);
  useEffect(() => {
    const cb = () => forceTick((n) => n + 1);
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  }, []);
  return state;
}
