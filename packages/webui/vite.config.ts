/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';
import { resolve } from 'path';

/**
 * Vite configuration for @qwen-code/webui library
 *
 * Build outputs:
 * - ESM: dist/index.js, dist/followup.js
 * - CJS: dist/index.cjs, dist/followup.cjs
 * - TypeScript declarations: dist/index.d.ts, dist/followup.d.ts
 * - CSS: dist/styles.css (optional styles)
 *
 * The followup entry is a separate subpath (@qwen-code/webui/followup)
 * so that consumers who don't need follow-up suggestions are not forced
 * to install @qwen-code/qwen-code-core.
 */
export default defineConfig({
  plugins: [
    react(),
    dts({
      include: ['src'],
      outDir: 'dist',
      rollupTypes: false,
      insertTypesEntry: true,
    }),
  ],
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        followup: resolve(__dirname, 'src/followup.ts'),
      },
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: [
        'react',
        'react-dom',
        'react/jsx-runtime',
        '@qwen-code/qwen-code-core',
      ],
      output: {
        assetFileNames: 'styles.[ext]',
      },
    },
    sourcemap: true,
    minify: false,
    cssCodeSplit: false,
  },
});
