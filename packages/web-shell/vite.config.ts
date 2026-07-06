import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import type { ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json' with { type: 'json' };

const daemonProxy: ProxyOptions = {
  target: process.env['QWEN_DAEMON_URL'] ?? 'http://127.0.0.1:4170',
  changeOrigin: true,
  bypass: (req) => {
    if (req.url?.startsWith('/api/')) return undefined;
    const fetchMode = req.headers['sec-fetch-mode'];
    const fetchDest = req.headers['sec-fetch-dest'];
    const accept = req.headers.accept ?? '';
    const isDocumentNavigation =
      fetchMode === 'navigate' ||
      fetchDest === 'document' ||
      accept.trim().toLowerCase().startsWith('text/html');
    if (isDocumentNavigation) {
      return '/index.html';
    }
    return undefined;
  },
  configure: (proxy) => {
    proxy.on('proxyReq', (proxyReq) => {
      proxyReq.removeHeader('origin');
      proxyReq.removeHeader('referer');
    });
  },
};

export default defineConfig(({ command }) => ({
  root: 'client',
  plugins: [react()],
  resolve: {
    alias:
      command === 'serve'
        ? {
            '@qwen-code/webui/daemon-react-sdk': resolve(
              __dirname,
              '../webui/src/daemon-react-sdk.ts',
            ),
            '@qwen-code/webui': resolve(__dirname, '../webui/src/index.ts'),
            '@qwen-code/sdk/daemon': resolve(
              __dirname,
              '../sdk-typescript/src/daemon/index.ts',
            ),
            '@qwen-code/sdk': resolve(
              __dirname,
              '../sdk-typescript/src/index.ts',
            ),
          }
        : {},
    dedupe: ['react', 'react-dom', '@qwen-code/webui', '@qwen-code/sdk'],
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  define: {
    __WEB_SHELL_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    cors: false,
    port: 5173,
    proxy: {
      '/health': daemonProxy,
      '/capabilities': daemonProxy,
      // Daemon status report; scoped to the exact route the dashboard uses (a
      // bare `/daemon` prefix would proxy unrelated `/daemon/*` paths). Without
      // it the SPA fallback answers with index.html and the dialog fails JSON
      // parsing in dev.
      '/daemon/status': daemonProxy,
      '/session': daemonProxy,
      '/permission': daemonProxy,
      '/workspace': daemonProxy,
      '/file': daemonProxy,
      '/stat': daemonProxy,
      '/list': daemonProxy,
      '/glob': daemonProxy,
      // Scheduled-tasks CRUD (the Scheduled Tasks dialog). Prefix-matches
      // `/scheduled-tasks` and `/scheduled-tasks/:id`. Like the routes above,
      // without it the SPA fallback returns index.html in dev and the dialog
      // fails JSON parsing / reports an HTTP error on open.
      '/scheduled-tasks': daemonProxy,
      // Voice dictation is a WebSocket (`/voice/stream`); `ws: true` makes the
      // dev proxy forward the HTTP upgrade to the daemon. Scope it to the exact
      // path — a bare `/voice` prefix would shadow the client's own
      // `client/voice/*` source modules (e.g. `/voice/voiceModels.ts`), which
      // vite must serve, and blanks the page.
      '/voice/stream': { ...daemonProxy, ws: true },
    },
  },
}));
