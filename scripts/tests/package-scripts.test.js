/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

describe('package scripts', () => {
  it('runs the serve fast-path bundle check in CI tests', () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(root, 'package.json'), 'utf8'),
    );

    expect(packageJson.scripts['test:ci']).toContain(
      'npm run check:serve-fast-path-bundle',
    );
  });
});
