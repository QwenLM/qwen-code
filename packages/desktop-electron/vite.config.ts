/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = process.env['QWEN_CODE_ROOT']
  ? path.resolve(process.env['QWEN_CODE_ROOT'])
  : path.resolve(packageDir, '../..');
const webShellRoot = path.join(sourceRoot, 'packages', 'web-shell');
const webShellVersion = JSON.parse(
  fs.readFileSync(path.join(webShellRoot, 'package.json'), 'utf8'),
).version as string;

export default defineConfig({
  root: path.join(packageDir, 'src', 'renderer'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      {
        find: '@qwen-code/webui/daemon-react-sdk',
        replacement: path.join(
          sourceRoot,
          'packages/webui/src/daemon-react-sdk.ts',
        ),
      },
      {
        find: '@qwen-code/webui',
        replacement: path.join(sourceRoot, 'packages/webui/src/index.ts'),
      },
      {
        find: '@qwen-code/sdk/daemon',
        replacement: path.join(
          sourceRoot,
          'packages/sdk-typescript/src/daemon/index.ts',
        ),
      },
      {
        find: '@qwen-code/sdk',
        replacement: path.join(
          sourceRoot,
          'packages/sdk-typescript/src/index.ts',
        ),
      },
      {
        find: '@qwen-code/web-shell',
        replacement: path.join(webShellRoot, 'client/index.tsx'),
      },
      {
        find: '@',
        replacement: path.join(webShellRoot, 'client'),
      },
      {
        find: /^react$/,
        replacement: path.join(sourceRoot, 'node_modules/react/index.js'),
      },
      {
        find: /^react-dom$/,
        replacement: path.join(sourceRoot, 'node_modules/react-dom/index.js'),
      },
      {
        find: /^react-dom\/(.*)$/,
        replacement: path.join(sourceRoot, 'node_modules/react-dom/$1'),
      },
      {
        find: /^react\/(.*)$/,
        replacement: path.join(sourceRoot, 'node_modules/react/$1'),
      },
    ],
    dedupe: ['react', 'react-dom', '@qwen-code/webui', '@qwen-code/sdk'],
  },
  build: {
    outDir: path.join(packageDir, 'dist', 'renderer'),
    emptyOutDir: true,
    sourcemap: false,
  },
  define: {
    __WEB_SHELL_VERSION__: JSON.stringify(webShellVersion),
  },
});
