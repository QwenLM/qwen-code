/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';
import { resolve, dirname } from 'path';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Vite configuration for @qwen-code/webui library
 *
 * Build outputs:
 * - ESM: dist/index.js (primary format)
 * - CJS: dist/index.cjs (compatibility)
 * - UMD: dist/index.umd.js (for CDN usage)
 * - TypeScript declarations: dist/index.d.ts
 * - CSS: dist/styles.css (optional styles)
 *
 * The followup subpath (@qwen-code/webui/followup) is built separately
 * via vite.config.followup.ts so that the root entry stays free of
 * @qwen-code/qwen-code-core dependencies.
 */
export default defineConfig({
  plugins: [
    react(),
    dts({
      include: ['src'],
      outDir: 'dist',
      rollupTypes: false,
      insertTypesEntry: true,
      afterBuild: () => {
        // vite-plugin-dts outputs declarations under dist/src/ preserving
        // directory structure, but the package "types" field points to
        // dist/index.d.ts. The generated stub only contains `export {}`.
        // Overwrite it with a re-export using .js extension so consumers
        // with NodeNext moduleResolution can resolve the types correctly.
        const stubPath = resolve(__dirname, 'dist/index.d.ts');
        writeFileSync(stubPath, "export * from './src/index.js';\n");
      },
    }),
  ],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'QwenCodeWebUI',
      formats: ['es', 'cjs', 'umd'],
      fileName: (format) => {
        if (format === 'es') return 'index.js';
        if (format === 'cjs') return 'index.cjs';
        if (format === 'umd') return 'index.umd.js';
        return 'index.js';
      },
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
          'react/jsx-runtime': 'ReactJSXRuntime',
        },
        assetFileNames: 'styles.[ext]',
      },
    },
    sourcemap: true,
    minify: false,
    cssCodeSplit: false,
  },
});
