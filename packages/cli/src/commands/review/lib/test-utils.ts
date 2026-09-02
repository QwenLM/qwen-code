/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PARSE_ARGS_REPORT } from './paths.js';

/** Seed the report `parse-args` tees, so the effort fallback has something to read. */
export function seedParseArgs(dir: string, effort: unknown): void {
  mkdirSync(join(dir, dirname(PARSE_ARGS_REPORT)), { recursive: true });
  writeFileSync(
    join(dir, PARSE_ARGS_REPORT),
    JSON.stringify({ effort, effortSource: 'flag' }),
    'utf8',
  );
}
