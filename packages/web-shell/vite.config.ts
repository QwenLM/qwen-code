import { defineConfig } from 'vite';
import type { ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json' with { type: 'json' };

const daemonProxy: ProxyOptions = {
  target: 'http://127.0.0.1:4170',
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

export default defineConfig({
  root: 'client',
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom', '@qwen-code/webui'],
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
      '/session': daemonProxy,
      '/permission': daemonProxy,
      '/workspace': daemonProxy,
      '/file': daemonProxy,
      '/stat': daemonProxy,
      '/list': daemonProxy,
      '/glob': daemonProxy,
    },
  },
});
