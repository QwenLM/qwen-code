/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Separate Vite config for the @qwen-code/webui/followup subpath entry.
 *
 * Built independently so that the root entry (vite.config.ts) stays free
 * of @qwen-code/qwen-code-core and can retain UMD output.
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
    react(),
    dts({
      include: ['src/followup.ts', 'src/hooks/useFollowupSuggestions.ts'],
      outDir: 'dist',
      rollupTypes: false,
      // Do not insert types entry — avoid clobbering the main build's index.d.ts
      insertTypesEntry: false,
    }),
  ],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/followup.ts'),
      formats: ['es', 'cjs'],
      fileName: (format) => {
        if (format === 'es') return 'followup.js';
        if (format === 'cjs') return 'followup.cjs';
        return 'followup.js';
      },
    },
    outDir: 'dist',
    emptyOutDir: false,
    rollupOptions: {
      external: [
        'react',
        'react-dom',
        'react/jsx-runtime',
        '@qwen-code/qwen-code-core',
      ],
    },
    sourcemap: true,
    minify: false,
    cssCodeSplit: false,
  },
});
