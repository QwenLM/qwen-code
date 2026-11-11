/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Freeze environment reads to the shared constants' Qwen Code defaults.
const sharedBrandFields = [
  ...new Set(
    [
      ...readFileSync(
        path.join(root, 'packages/core/src/config/brand.ts'),
        'utf8',
      ).matchAll(/process\.env\[['"](BRAND_[A-Z_]+)['"]\]/g),
    ].map((match) => match[1]),
  ),
];

export function qwenBrandDefines() {
  return Object.fromEntries(
    sharedBrandFields.map((name) => [
      `process.env.${name}`,
      JSON.stringify(''),
    ]),
  );
}
