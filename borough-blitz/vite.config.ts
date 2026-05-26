import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Standalone BOROUGH BLITZ build. No backend proxy — the only server
// surface is the Cloudflare Pages Function under functions/api/challenges,
// which `wrangler pages dev` serves locally. Camera data is baked into the
// bundle (src/cams.json) and live frames load straight from nyctmc.org.
export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2020',
    // MapLibre is the heavyweight; split it so the initial shell paints fast.
    // Matched by module path (react-map-gl v8 only ships subpath exports, so
    // it can't be named as a bare chunk entry).
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/maplibre-gl') || id.includes('node_modules/react-map-gl')) {
            return 'maplibre';
          }
          return undefined;
        },
      },
    },
  },
});
