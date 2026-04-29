/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BACKEND_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Ambient stubs for packages whose .d.ts files are absent in a partial
// node_modules install. Safe after a full `npm install` -- packages ship
// their own types and these declarations are only used as fallbacks.
declare module 'lucide-react';

declare module 'maplibre-gl' {
  // Minimal stub so `import type { StyleSpecification }` compiles without
  // the full maplibre-gl types installed. Replace with the real package
  // types once `npm install` has run.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type StyleSpecification = Record<string, any>;
  const maplibregl: any;
  export default maplibregl;
  export * from 'maplibre-gl';
}
