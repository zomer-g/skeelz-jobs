import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Plain client build (no SSR bundle). In dev, /api is proxied to the API on :3000.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // Low-memory build on the shared xhostd account.
    rollupOptions: { maxParallelFileOps: 2 },
  },
  server: {
    proxy: { '/api': 'http://localhost:3000' },
  },
});
