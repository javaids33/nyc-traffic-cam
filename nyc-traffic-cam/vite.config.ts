import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // FastAPI dashboard backend
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:8000',
        ws: true,
        changeOrigin: true,
      },
      // Direct passthrough to NYC TMC GraphQL — used by the legacy LocationCameraApp.
      '/nyc-graphql': {
        target: 'https://webcams.nyctmc.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/nyc-graphql/, '/cameras/graphql'),
      },
    },
  },
});
