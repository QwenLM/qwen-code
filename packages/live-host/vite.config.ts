import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  publicDir: resolve(__dirname, 'resources'),
  resolve: {
    alias: {
      '@qwen-code/qwen-live/subagents': resolve(
        __dirname,
        '../qwen-live/src/subagents/types.ts',
      ),
      '@qwen-code/qwen-live/i18n': resolve(
        __dirname,
        '../qwen-live/src/i18n/messages.ts',
      ),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/renderer/index.html'),
        subagents: resolve(__dirname, 'src/renderer/subagents.html'),
      },
    },
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    sourcemap: true,
  },
});
