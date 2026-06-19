import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import type { ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

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
    if (isDocumentNavigation) return '/index.html';
    return undefined;
  },
  configure: (proxy) => {
    proxy.on('proxyReq', (proxyReq) => {
      proxyReq.removeHeader('origin');
      proxyReq.removeHeader('referer');
      proxyReq.removeHeader('if-none-match');
      proxyReq.removeHeader('if-modified-since');
    });
    proxy.on('proxyRes', (proxyRes) => {
      proxyRes.headers['cache-control'] = 'no-store';
      proxyRes.headers.pragma = 'no-cache';
      proxyRes.headers.expires = '0';
    });
  },
};

export default defineConfig(({ command }) => ({
  plugins: [react()],
  resolve: {
    alias:
      command === 'serve'
        ? {
            '@qwen-code/web-shell': resolve(
              __dirname,
              '../web-shell/client/index.tsx',
            ),
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
    dedupe: [
      'react',
      'react-dom',
      '@qwen-code/web-shell',
      '@qwen-code/webui',
      '@qwen-code/sdk',
    ],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    cors: false,
    port: 5174,
    proxy: {
      '/health': daemonProxy,
      '/capabilities': daemonProxy,
      '/daemon': daemonProxy,
      '/session': daemonProxy,
      '/sessions': daemonProxy,
      '/workspace': daemonProxy,
      '/permission': daemonProxy,
      '/file': daemonProxy,
      '/stat': daemonProxy,
      '/list': daemonProxy,
      '/glob': daemonProxy,
    },
  },
}));
