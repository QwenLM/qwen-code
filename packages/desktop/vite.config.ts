/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const packageRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(packageRoot, 'src/renderer'),
  plugins: [react()],
  build: {
    outDir: resolve(packageRoot, 'dist/renderer'),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    host: '127.0.0.1',
  },
});
