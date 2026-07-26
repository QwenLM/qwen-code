import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import type { ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import pkg from './package.json' with { type: 'json' };

const daemonProxy: ProxyOptions = {
  target: process.env['QWEN_DAEMON_URL'] ?? 'http://127.0.0.1:4170',
  changeOrigin: true,
  bypass: (req) => {
    if (req.url?.startsWith('/api/')) return undefined;
    // `/extensions/*` is both a daemon API and a client source directory.
    if (
      req.method === 'GET' &&
      req.url?.startsWith('/extensions/') &&
      /\.(?:[cm]?[jt]sx?|css|map)(?:\?|$)/.test(req.url)
    ) {
      return req.url;
    }
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
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './client'),
      ...(command === 'serve'
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
        : {}),
    },
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
      '/extensions': daemonProxy,
      '/file': daemonProxy,
      '/stat': daemonProxy,
      '/list': daemonProxy,
      '/glob': daemonProxy,
      // Scheduled-tasks CRUD (the Scheduled Tasks dialog). Prefix-matches
      // `/scheduled-tasks` and `/scheduled-tasks/:id`. Like the routes above,
      // without it the SPA fallback returns index.html in dev and the dialog
      // fails JSON parsing / reports an HTTP error on open.
      '/scheduled-tasks': daemonProxy,
      // Goals page (`GET /goals`). Without it the SPA fallback returns
      // index.html in dev and the page fails JSON parsing on open.
      '/goals': daemonProxy,
      // Token-usage dashboard (Daemon Status "统计" tab). Same reason as the
      // routes above — without it the SPA fallback returns index.html in dev and
      // the tab fails JSON parsing on `GET /usage/dashboard`.
      '/usage': daemonProxy,
      // Voice dictation is a WebSocket (`/voice/stream`); `ws: true` makes the
      // dev proxy forward the HTTP upgrade to the daemon. Scope it to the exact
      // path — a bare `/voice` prefix would shadow the client's own
      // `client/voice/*` source modules (e.g. `/voice/voiceModels.ts`), which
      // vite must serve, and blanks the page.
      '/voice/stream': { ...daemonProxy, ws: true },
    },
  },
}));
