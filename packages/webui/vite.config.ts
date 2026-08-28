/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';
import { resolve } from 'path';

/**
 * Vite configuration for @qwen-code/webui library
 *
 * Build outputs:
 * - Main entry:    dist/index.js, dist/index.cjs, dist/index.d.ts
 * - Advanced entry: dist/advanced.js, dist/advanced.cjs, dist/advanced.d.ts
 * - CSS: dist/styles.css
 */
export default defineConfig(({ command }) => ({
  resolve:
    command === 'serve'
      ? {
          alias: {
            '@qwen-code/sdk/daemon': resolve(
              __dirname,
              '../sdk-typescript/src/daemon/index.ts',
            ),
            '@qwen-code/sdk': resolve(
              __dirname,
              '../sdk-typescript/src/index.ts',
            ),
          },
        }
      : undefined,
  plugins: [
    react(),
    dts({
      include: ['src'],
      outDir: 'dist',
      rollupTypes: true,
      insertTypesEntry: true,
      aliasesExclude: [/^@qwen-code\//],
    }),
  ],
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        'daemon-react-sdk': resolve(__dirname, 'src/daemon-react-sdk.ts'),
      },
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: [
        '@qwen-code/sdk',
        '@qwen-code/sdk/daemon',
        'react',
        'react-dom',
        'react/jsx-runtime',
      ],
      output: {
        globals: {
          '@qwen-code/sdk': 'QwenCodeSdk',
          '@qwen-code/sdk/daemon': 'QwenCodeSdkDaemon',
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
  test: {
    // The worker->main `onTaskUpdate` RPC runs on a 60s budget; under the
    // resource pressure of the Windows/macOS runners a stall longer than
    // that surfaces as an unhandled error and exits an all-green run red
    // (the same failure class the core, cli, and scripts suites hit on
    // these lanes). Test failures still fail the run; only unhandled
    // errors stop being fatal, and only off Linux — the ubuntu lane and
    // Linux local runs keep the unhandled-error signal.
    dangerouslyIgnoreUnhandledErrors: process.platform !== 'linux',
  },
}));
