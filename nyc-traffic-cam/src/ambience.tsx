import { useCallback, useEffect, useRef, useState } from 'react';
import { Headphones, X } from 'lucide-react';

/* Pure Web Audio NYC ambience — no audio assets, all synthesized.
   Picker in the corner. Click to enable (autoplay policy requires gesture). */

type Mode = 'off' | 'ac' | 'subway' | 'street';

const MODES: { id: Mode; label: string; gloss: string }[] = [
  { id: 'off', label: 'OFF', gloss: '— silence —' },
  { id: 'ac', label: 'AC HUM', gloss: 'window unit, july' },
  { id: 'subway', label: 'SUBWAY', gloss: 'tracks below the deli' },
  { id: 'street', label: 'STREET', gloss: 'sirens, distant' },
];

function makeBrownNoise(ctx: AudioContext) {
  const bufferSize = 2 * ctx.sampleRate;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let lastOut = 0;
  for (let i = 0; i < bufferSize; i++) {
    const white = Math.random() * 2 - 1;
    data[i] = (lastOut + 0.02 * white) / 1.02;
    lastOut = data[i];
    data[i] *= 3.5;
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  return src;
}

function makePinkNoise(ctx: AudioContext) {
  // Paul Kellet's pink noise approximation
  const bufferSize = 2 * ctx.sampleRate;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < bufferSize; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.96900 * b2 + white * 0.1538520;
    b3 = 0.86650 * b3 + white * 0.3104856;
    b4 = 0.55000 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.0168980;
    data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
    b6 = white * 0.115926;
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  return src;
}

export function AmbienceWidget() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('off');
  const [vol, setVol] = useState(0.45);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodesRef = useRef<{ stop: () => void } | null>(null);
  const masterRef = useRef<GainNode | null>(null);

  const start = useCallback((m: Mode) => {
    if (m === 'off') {
      nodesRef.current?.stop();
      nodesRef.current = null;
      return;
    }

    if (!ctxRef.current) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctxRef.current = new Ctx();
      const master = ctxRef.current.createGain();
      master.gain.value = vol;
      master.connect(ctxRef.current.destination);
      masterRef.current = master;
    }
    const ctx = ctxRef.current;
    const master = masterRef.current!;

    nodesRef.current?.stop();

    const stops: (() => void)[] = [];

    if (m === 'ac') {
      // AC: brown noise through a low-pass filter + a subtle 60Hz hum
      const noise = makeBrownNoise(ctx);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 600;
      const gn = ctx.createGain();
      gn.gain.value = 0.6;
      noise.connect(lp).connect(gn).connect(master);

      const hum = ctx.createOscillator();
      hum.type = 'sine';
      hum.frequency.value = 60;
      const hgn = ctx.createGain();
      hgn.gain.value = 0.12;
      hum.connect(hgn).connect(master);

      noise.start();
      hum.start();
      stops.push(() => { try { noise.stop(); hum.stop(); } catch { /* noop */ } });
    } else if (m === 'subway') {
      // Subway: brown noise lowpassed even further + occasional rumble swells
      const noise = makeBrownNoise(ctx);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 250;
      const gn = ctx.createGain();
      gn.gain.value = 0.85;
      noise.connect(lp).connect(gn).connect(master);
      noise.start();

      // Occasional rumble swell — modulate gn.gain
      const swellTimer = setInterval(() => {
        const t = ctx.currentTime;
        const target = 1.4 + Math.random() * 0.6;
        gn.gain.cancelScheduledValues(t);
        gn.gain.setValueAtTime(gn.gain.value, t);
        gn.gain.linearRampToValueAtTime(target, t + 1.2);
        gn.gain.linearRampToValueAtTime(0.85, t + 5.0);
      }, 12_000 + Math.random() * 12_000);

      // Track squeal — a fading high sine, every ~30-60s
      const squealTimer = setInterval(() => {
        const o = ctx.createOscillator();
        const og = ctx.createGain();
        o.type = 'triangle';
        o.frequency.value = 1800 + Math.random() * 1200;
        og.gain.value = 0;
        o.connect(og).connect(master);
        const t = ctx.currentTime;
        og.gain.linearRampToValueAtTime(0.05, t + 0.2);
        og.gain.linearRampToValueAtTime(0, t + 1.6);
        o.start(t);
        o.stop(t + 1.7);
      }, 45_000 + Math.random() * 45_000);

      stops.push(() => {
        try { noise.stop(); } catch { /* noop */ }
        clearInterval(swellTimer);
        clearInterval(squealTimer);
      });
    } else if (m === 'street') {
      // Street: pink noise + occasional siren whoop
      const noise = makePinkNoise(ctx);
      const gn = ctx.createGain();
      gn.gain.value = 0.4;
      noise.connect(gn).connect(master);
      noise.start();

      const sirenTimer = setInterval(() => {
        const t = ctx.currentTime;
        const o = ctx.createOscillator();
        const og = ctx.createGain();
        o.type = 'sawtooth';
        og.gain.value = 0;
        o.connect(og).connect(master);
        og.gain.linearRampToValueAtTime(0.05, t + 0.4);
        og.gain.linearRampToValueAtTime(0.04, t + 4);
        og.gain.linearRampToValueAtTime(0, t + 5);
        // wail up and down a few times
        o.frequency.setValueAtTime(700, t);
        for (let i = 0; i < 6; i++) {
          o.frequency.linearRampToValueAtTime(1100, t + 0.4 + i * 0.7);
          o.frequency.linearRampToValueAtTime(700, t + 0.7 + i * 0.7);
        }
        o.start(t);
        o.stop(t + 5);
      }, 50_000 + Math.random() * 60_000);

      // distant car horn — short two-tone honk every minute or two
      const hornTimer = setInterval(() => {
        const t = ctx.currentTime;
        const o = ctx.createOscillator();
        const og = ctx.createGain();
        o.type = 'square';
        o.frequency.value = 320;
        og.gain.value = 0;
        o.connect(og).connect(master);
        og.gain.linearRampToValueAtTime(0.04, t + 0.05);
        og.gain.linearRampToValueAtTime(0.04, t + 0.35);
        og.gain.linearRampToValueAtTime(0, t + 0.5);
        o.start(t);
        o.stop(t + 0.55);
      }, 70_000 + Math.random() * 80_000);

      stops.push(() => {
        try { noise.stop(); } catch { /* noop */ }
        clearInterval(sirenTimer);
        clearInterval(hornTimer);
      });
    }

    nodesRef.current = { stop: () => stops.forEach((s) => s()) };
  }, [vol]);

  // Apply volume changes live
  useEffect(() => {
    if (masterRef.current) masterRef.current.gain.value = vol;
  }, [vol]);

  // Cleanup
  useEffect(() => {
    return () => {
      nodesRef.current?.stop();
      ctxRef.current?.close();
    };
  }, []);

  const onPick = (m: Mode) => {
    setMode(m);
    start(m);
  };

  return (
    <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-40 pointer-events-auto">
      {open ? (
        <div
          className="bg-black/90 border border-[#FFD600] px-3 py-2 flex items-center gap-3 font-typewriter text-[10px] uppercase tracking-[0.2em]"
          style={{ boxShadow: '3px 3px 0 #d11a2a' }}
        >
          <span className="text-[#FFD600] flex items-center gap-1">
            <Headphones className="w-3 h-3" /> AMBIENCE
          </span>
          <div className="flex gap-1">
            {MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => onPick(m.id)}
                className={`px-2 py-0.5 border transition-colors ${
                  mode === m.id
                    ? 'bg-[#FFD600] text-black border-[#FFD600]'
                    : 'border-white/20 text-white/70 hover:border-[#FFD600] hover:text-[#FFD600]'
                }`}
                title={m.gloss}
              >
                {m.label}
              </button>
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={vol}
            onChange={(e) => setVol(parseFloat(e.target.value))}
            className="w-20"
            title="volume"
          />
          <button onClick={() => setOpen(false)} className="text-white/55 hover:text-white">
            <X className="w-3 h-3" />
          </button>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="bg-black/80 border border-[#FFD600]/70 px-2.5 py-1 flex items-center gap-1.5 font-typewriter text-[10px] uppercase tracking-[0.2em] text-[#FFD600] hover:bg-black"
          style={{ boxShadow: '3px 3px 0 #d11a2a' }}
          title="NYC ambient sound — click to choose"
        >
          <Headphones className="w-3 h-3" />
          <span>{mode === 'off' ? 'AMBIENCE OFF' : `· ${MODES.find((m) => m.id === mode)?.label}`}</span>
        </button>
      )}
    </div>
  );
}
