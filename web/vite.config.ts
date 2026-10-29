import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev/preview only: explainer assets straight from the published pages (the gateway does this in production),
// everything else to a local gateway, or to DESK_API (e.g. the live desk, for reviewing a UI change against real
// data; the gateway checks Origin, so the proxy presents the target's own). `?mock=1` needs only the explainer proxy.
const api = process.env.DESK_API ?? 'http://127.0.0.1:8080';
const proxy: Record<string, ProxyOptions> = {
  '/api/explainer': {
    target: 'https://explainers.app.mintapis.com',
    changeOrigin: true,
    rewrite: (p) => p.replace(/^\/api\/explainer\/([a-z0-9-]+)\//, '/p/$1/'),
  },
  '/api': { target: api, ws: true, changeOrigin: true, headers: { Origin: new URL(api).origin } },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy },
  preview: { proxy },
  // elkjs (~440 KB gzip) is a lazy chunk loaded with the first flow/architecture canvas; check-build guards that.
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 1500 },
});
