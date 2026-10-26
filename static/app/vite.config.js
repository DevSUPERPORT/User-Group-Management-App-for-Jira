import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Forge serves the build from a relative path, hence base './'.
// `npm run dev` / `npm run build:demo` run the click-dummy, which imports the real
// service layer from ../../src with in-memory adapters.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: process.env.VITE_DEMO === 'true' ? 'demo-build' : 'build',
    emptyOutDir: true,
    target: 'es2020',
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 3000,
    strictPort: true,
    fs: { allow: ['../..'] },
  },
});
