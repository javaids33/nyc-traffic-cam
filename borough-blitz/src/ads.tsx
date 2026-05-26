/* Google AdSense integration — single point of configuration.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  TODO: paste your AdSense publisher ID below (the "ca-pub-XXXX" from  │
 * │  your AdSense account) AND the slot IDs you create in the dashboard.  │
 * │  Also update public/ads.txt with the same pub-XXXX digits.           │
 * │                                                                       │
 * │  AdSense only serves once Google approves the live domain, which     │
 * │  needs a deployed site with real content. Until the client below is  │
 * │  a real ID, no loader script is injected (clean console) and ad      │
 * │  slots render as a labelled placeholder in dev / nothing in prod.    │
 * └─────────────────────────────────────────────────────────────────────┘ */

import { useEffect, useRef } from 'react';

export const ADSENSE_CLIENT = 'ca-pub-XXXXXXXXXXXXXXXX';

// Named slots → paste the numeric data-ad-slot from each AdSense unit.
export const AD_SLOTS = {
  start: 'XXXXXXXXXX',
  summary: 'XXXXXXXXXX',
} as const;

export type AdSlotName = keyof typeof AD_SLOTS;

export function adsEnabled(): boolean {
  return !ADSENSE_CLIENT.includes('XXXX');
}

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

// Inject the AdSense loader exactly once, only when a real client is set.
function ensureLoader() {
  if (!adsEnabled() || typeof document === 'undefined') return;
  if (document.getElementById('adsbygoogle-js')) return;
  const s = document.createElement('script');
  s.id = 'adsbygoogle-js';
  s.async = true;
  s.crossOrigin = 'anonymous';
  s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}`;
  document.head.appendChild(s);
}

/* A responsive ad unit. Drop it on the start screen and the summary screen —
 * never over live gameplay (keeps the feed clean and stays on the right side
 * of AdSense placement policy). */
export function AdSlot({ name, className }: { name: AdSlotName; className?: string }) {
  const pushed = useRef(false);

  useEffect(() => {
    if (!adsEnabled()) return;
    ensureLoader();
    if (pushed.current) return;
    pushed.current = true;
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch {
      /* loader not ready yet; the unit fills when it arrives */
    }
  }, []);

  if (!adsEnabled()) {
    // Placeholder so you can see slot placement while building. Hidden in
    // production until a real publisher ID is configured above.
    if (!import.meta.env.DEV) return null;
    return (
      <div
        className={`grid h-[90px] place-items-center border border-dashed border-taxi/30 bg-night-800/60 ${className ?? ''}`}
        aria-hidden
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-taxi/40">
          ad · {name}
        </span>
      </div>
    );
  }

  return (
    <ins
      className={`adsbygoogle block ${className ?? ''}`}
      style={{ display: 'block' }}
      data-ad-client={ADSENSE_CLIENT}
      data-ad-slot={AD_SLOTS[name]}
      data-ad-format="auto"
      data-full-width-responsive="true"
    />
  );
}
