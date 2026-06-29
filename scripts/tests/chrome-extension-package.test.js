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

describe('chrome extension package scripts', () => {
  it('keeps the build script portable for Windows npm lifecycle runs', () => {
    const packageJson = JSON.parse(
      readFileSync(
        path.join(root, 'packages/chrome-extension/package.json'),
        'utf8',
      ),
    );

    expect(packageJson.scripts.build).not.toMatch(
      /(?:^|\s&&\s)[A-Za-z_][A-Za-z0-9_]*=/,
    );
    expect(packageJson.scripts.build).not.toMatch(
      /(?:^|\s&&\s)npm run clean(?:\s|$)/,
    );
  });
});
