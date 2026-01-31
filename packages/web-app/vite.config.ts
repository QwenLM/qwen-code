import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

const backendPort =
  Number(process.env['QWEN_CODE_WEB_PORT'] ?? process.env['WEB_APP_PORT']) ||
  5495;

export default defineConfig({
  plugins: [react()],
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${backendPort}`,
        changeOrigin: true,
      },
      '/ws': {
        target: `ws://localhost:${backendPort}`,
        ws: true,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/client'),
      '@qwen-code/webui/styles.css': path.resolve(
        __dirname,
        '../webui/dist/styles.css',
      ),
    },
  },
});
