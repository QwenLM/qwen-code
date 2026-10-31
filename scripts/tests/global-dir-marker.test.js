/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => readFileSync(join(root, file), 'utf8');

// These copy Storage.getGlobalQwenDir() instead of importing core. Their own
// tests pin each branch against their own literal, so only this check notices
// a marker renamed in one copy and not the others.
const mirrors = [
  'packages/cli/src/config/storage-paths-lite.ts',
  'packages/channels/base/src/paths.ts',
  'packages/sdk-typescript/src/peer/registry.ts',
  'packages/vscode-ide-companion/src/utils/paths.ts',
  'scripts/cli-entry.js',
  'packages/core/src/skills/bundled/stuck/SKILL.md',
];

const marker = /const GLOBAL_DIR_MARKER = '([^']+)';/.exec(
  read('packages/core/src/config/storage.ts'),
)?.[1];

it.each(mirrors)('%s checks the marker core writes', (file) => {
  expect(marker).toBeTruthy();
  expect(read(file)).toContain(marker);
});
