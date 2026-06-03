import { useCallback, useEffect, useRef, useState } from 'react';

/* The live cam frame as a "panorama" you can lean into — scroll/double-click
 * to zoom, drag to pan — so you can read a street sign or a storefront. The
 * `noZoom` modifier locks it flat for hard-mode players. Pure CSS transforms,
 * no canvas, so there is no cross-origin tainting to worry about. */

const MAX_SCALE = 4;
const MIN_SCALE = 1;

export function ZoomableCam({
  src,
  alt,
  grayscale,
  noZoom,
  resetKey,
  fit = 'cover',
}: {
  src: string;
  alt: string;
  grayscale: boolean;
  noZoom: boolean;
  resetKey: string; // changing this (new round) snaps back to 1×
  // 'cover' fills the frame (desktop, where the viewport ≈ the cam's
  // landscape ratio). 'contain' shows the whole frame without cropping —
  // used on mobile so a wide cam isn't sliced to a zoomed-in centre strip.
  fit?: 'cover' | 'contain';
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const [loaded, setLoaded] = useState(false);

  // New round → reset transform + loading state.
  useEffect(() => {
    setScale(1);
    setTx(0);
    setTy(0);
    setLoaded(false);
  }, [resetKey]);

  const clampPan = useCallback((nx: number, ny: number, s: number) => {
    const el = wrapRef.current;
    if (!el) return { x: nx, y: ny };
    const max = (s - 1) / 2;
    const limX = el.clientWidth * max;
    const limY = el.clientHeight * max;
    return {
      x: Math.max(-limX, Math.min(limX, nx)),
      y: Math.max(-limY, Math.min(limY, ny)),
    };
  }, []);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (noZoom) return;
      e.preventDefault();
      setScale((prev) => {
        const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev - e.deltaY * 0.0016 * prev));
        if (next <= 1.001) {
          setTx(0);
          setTy(0);
        }
        return next;
      });
    },
    [noZoom],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    if (noZoom || scale <= 1) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, tx, ty };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    const c = clampPan(drag.current.tx + dx, drag.current.ty + dy, scale);
    setTx(c.x);
    setTy(c.y);
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onDoubleClick = () => {
    if (noZoom) return;
    if (scale > 1) {
      setScale(1);
      setTx(0);
      setTy(0);
    } else {
      setScale(2.5);
    }
  };

  const zoomed = scale > 1.01;

  // A hair of blur smooths the upscale aliasing of a low-res JPEG when the
  // frame is magnified to fill the screen (cover mode, not zoomed). It's
  // dropped the instant the player zooms in so street signs stay legible —
  // and so the transform's scale doesn't magnify the blur with it. Contrast
  // is kept gentle: a heavier boost would amplify the JPEG/sensor noise.
  const softBlur = fit === 'cover' && !zoomed;
  const filter = grayscale
    ? `grayscale(1) contrast(1.06)${softBlur ? ' blur(0.3px)' : ''}`
    : `contrast(1.02) saturate(1.05)${softBlur ? ' blur(0.3px)' : ''}`;

  return (
    <div
      ref={wrapRef}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onDoubleClick={onDoubleClick}
      className="absolute inset-0 touch-none select-none overflow-hidden"
      style={{ cursor: noZoom ? 'default' : zoomed ? 'grab' : 'zoom-in' }}
    >
      {!loaded && (
        <div className="absolute inset-0 grid place-items-center">
          <span className="animate-pulse font-mono text-[11px] uppercase tracking-[0.3em] text-taxi/55">
            acquiring feed…
          </span>
        </div>
      )}
      <img
        key={resetKey}
        src={src}
        alt={alt}
        referrerPolicy="no-referrer"
        decoding="async"
        draggable={false}
        onLoad={() => setLoaded(true)}
        className={`absolute inset-0 h-full w-full will-change-transform ${
          fit === 'contain' ? 'object-contain' : 'object-cover'
        }`}
        style={{
          transform: `translate3d(${tx}px,${ty}px,0) scale(${scale})`,
          transition: drag.current ? 'none' : 'transform 0.12s ease-out',
          filter,
          opacity: loaded ? 1 : 0,
        }}
      />
    </div>
  );
}
