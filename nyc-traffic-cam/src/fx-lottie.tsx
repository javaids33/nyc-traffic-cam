import { useEffect, useState } from 'react';
import Lottie from 'lottie-react';

/* LottieRemote — fetches a Lottie JSON file from `src` and renders it
   once loaded. Falls back silently to nothing if fetch fails so the
   page doesn't show a broken-icon placeholder.

   Usage: <LottieRemote src="https://assets10.lottiefiles.com/.../foo.json" />
   Drop in any public Lottie animation URL (lottiefiles.com has many
   free / CC0 NYC-flavored ones). */
export function LottieRemote({
  src,
  width = 96,
  height = 96,
  loop = true,
  className,
}: {
  src: string;
  width?: number | string;
  height?: number | string;
  loop?: boolean;
  className?: string;
}) {
  const [data, setData] = useState<unknown | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let stop = false;
    (async () => {
      try {
        const r = await fetch(src);
        if (!r.ok) throw new Error('lottie http ' + r.status);
        const j = await r.json();
        if (!stop) setData(j);
      } catch {
        if (!stop) setFailed(true);
      }
    })();
    return () => { stop = true; };
  }, [src]);
  if (failed || !data) return null;
  return (
    <Lottie
      animationData={data}
      loop={loop}
      style={{ width, height }}
      className={className}
    />
  );
}
