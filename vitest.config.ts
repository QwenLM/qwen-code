/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// Running vitest from the repo root skips every package's own config (setup
// files, 60s timeouts, forks pool) and produces failures that never happen
// inside a package. Only root scripts that set CLI_ALLOW_ROOT_VITEST (for
// example test:sea-launch) may start vitest here.
if (
  path.resolve(process.cwd()) === rootDir &&
  !process.env['CLI_ALLOW_ROOT_VITEST']
) {
  throw new Error(
    '不要在仓库根目录运行 vitest，请在包目录下运行，例如：\n' +
      '  cd packages/core && npx vitest run src/path/to/file.test.ts\n' +
      '用户明确要求跑全量时用 npm run test:ci。',
  );
}

export default defineConfig({
  resolve: {
    alias: {
      '@qwen-code/core': path.resolve(rootDir, 'packages/core/index.ts'),
      '@qwen-code/resource': path.resolve(
        rootDir,
        'packages/resource/index.ts',
      ),
    },
  },
});
