import { BodegaAwning, StreetFauna } from './bodega-tv';

export default function About() {
  return (
    <div className="min-h-screen w-screen flex flex-col text-white" style={{
      background: 'radial-gradient(ellipse at 50% 30%, #1a1530 0%, #0a0a18 55%, #06060c 100%)',
    }}>
      <BodegaAwning
        rightSlot={
          <a
            href="/"
            className="ml-2 px-2 py-0.5 border border-[#FFD600] text-[#FFD600] hover:bg-[#FFD600] hover:text-black transition-colors font-typewriter text-[10px] uppercase tracking-[0.18em]"
          >
            ← LOUNGE
          </a>
        }
      />

      <main className="flex-1 max-w-[760px] mx-auto px-6 py-10 z-10">
        <div className="font-bungee text-[64px] leading-[0.95] uppercase mb-4">
          <span className="text-[#FFD600]">★</span> About<br/>
          this <span className="text-[#FFD600]">channel</span>.
        </div>

        <p className="font-typewriter text-[14px] leading-relaxed text-white/85 mb-6">
          A love letter to New York City, dressed up like the corner-bodega TV that's
          always on. The picture is a real-time stream of the city's traffic cameras —
          all 954 of them — surfed at random so you can leave it up like a fish tank
          and let the city flicker by while you do something else.
        </p>

        <Section title="What you’re looking at">
          <p>
            New York's Department of Transportation publishes ~954 traffic cameras
            citywide, each refreshing every few seconds. Our backend polls every camera
            roughly every 15&nbsp;seconds, decodes the frames, and watches for anomalies.
          </p>
        </Section>

        <Section title="What counts as “change”">
          <p>
            Each frame is downscaled to a 96×96 grayscale thumbnail. We compute the
            <em> mean absolute pixel difference</em> versus the previous thumbnail —
            that's the diff score. Per camera we keep a running mean and variance
            (Welford's algorithm) of those scores, and the z-score
            <code className="text-[#FFD600]"> (current − mean) / std </code>
            is what fires alerts when it crosses 3σ. The threshold self-calibrates per
            camera, so a parking-lot view and a Cross Bronx view both behave correctly
            without per-camera tuning.
          </p>
        </Section>

        <Section title="The channel surf">
          <p>
            On the lounge page, the bodega TV auto-flips every 18&nbsp;seconds to a
            different camera. We bias toward worthwhile alerts (severity ≥ 5, skipping
            frozen/offline kinds) so you get the interesting moments. If nothing's
            happening, we tune to a random camera as B-roll. Tap the screen to lock the
            channel; it auto-resumes after 90&nbsp;seconds.
          </p>
        </Section>

        <Section title="Hidden bits">
          <ul className="list-disc list-inside space-y-1">
            <li>Try the Konami code: <code className="text-[#FFD600]">↑↑↓↓←→←→BA</code></li>
            <li><code className="text-[#FFD600]">?</code> opens the keyboard guide</li>
            <li>Numbers <code className="text-[#FFD600]">1–9</code> jump to active alerts</li>
            <li>Watch the bottom of the screen for visitors. The cat sleeps. The hydrant spurts.</li>
            <li>Refresh and see the MetroCard swipe</li>
          </ul>
        </Section>

        <Section title="Stack">
          <ul className="list-disc list-inside space-y-1">
            <li>Frontend: React + Vite + Tailwind on Cloudflare Pages</li>
            <li>Backend: Python FastAPI + asyncio on Fly.io, SQLite WAL on a 1GB volume</li>
            <li>Map: MapLibre GL + deck.gl (HeatmapLayer + Scatterplot)</li>
            <li>Camera frames: NYC TMC GraphQL API, public</li>
            <li>Weather: <a href="https://wttr.in" className="text-[#FFD600]">wttr.in</a>, no key</li>
          </ul>
        </Section>

        <Section title="Inspirations">
          <p>
            NY1 lower-thirds. The corner-store CRT mounted high in the corner. The
            Sabrett umbrella. The 1990s Bowery Mission flyer. The MetroCard. The
            blue-and-white Greek "We Are Happy To Serve You" coffee cup. NY Post
            tabloid headlines. Sodium-vapor street lamps. The whole city, basically.
          </p>
        </Section>

        <div className="mt-10 font-typewriter text-[10px] uppercase tracking-[0.22em] text-white/40">
          Made with affection · Not affiliated with NYC DOT, MTA, or Sabrett ·
          <a href="/dashboard" className="ml-2 text-[#FFD600]/80 hover:text-[#FFD600]">/dashboard</a>
        </div>
      </main>

      <StreetFauna />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-7">
      <h2 className="font-tabloid uppercase tracking-[0.04em] text-[24px] leading-none mb-2 text-white">
        <span className="text-[#FFD600]">› </span>{title}
      </h2>
      <div className="font-typewriter text-[13px] leading-relaxed text-white/80">{children}</div>
    </section>
  );
}
