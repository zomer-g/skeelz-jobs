import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Service worker (public/sw.js, docs/pwa.md): after the build, write this build's id and the entry files of
 * index.html into dist/sw.js. A new build = a different sw.js = the browser installs the new worker, which drops
 * the old caches. No plugin dependency: two string replacements.
 */
const serviceWorkerBuild = (): Plugin => {
  let outDir = 'dist';
  return {
    name: 'skeelz-sw',
    apply: 'build',
    configResolved(config) { outDir = path.resolve(config.root, config.build.outDir); },
    closeBundle() {
      const swPath = path.join(outDir, 'sw.js');
      const indexPath = path.join(outDir, 'index.html');
      if (!fs.existsSync(swPath) || !fs.existsSync(indexPath)) return;
      const index = fs.readFileSync(indexPath, 'utf-8');
      const entry = [...new Set(index.match(/\/assets\/[^"'\s)]+/g) || [])].sort();
      // The id covers every file of the build (names and contents), so any change — a script, the offline page,
      // an icon — rolls out a new worker; an identical build keeps the same one.
      const hash = crypto.createHash('sha256');
      const walk = (dir: string) => {
        for (const name of fs.readdirSync(dir).sort()) {
          const full = path.join(dir, name);
          if (fs.statSync(full).isDirectory()) walk(full);
          else hash.update(path.relative(outDir, full).replace(/\\/g, '/')).update(fs.readFileSync(full));
        }
      };
      walk(outDir);
      const build = hash.digest('hex').slice(0, 12);
      const sw = fs.readFileSync(swPath, 'utf-8');
      fs.writeFileSync(swPath, sw
        .replace("'__SKEELZ_BUILD__'", JSON.stringify(build))
        .replace('/*__SKEELZ_PRECACHE__*/ []', JSON.stringify(entry)));
    },
  };
};

// Plain client build (no SSR bundle). In dev, /api is proxied to the API on :3000.
export default defineConfig({
  plugins: [react(), serviceWorkerBuild()],
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
