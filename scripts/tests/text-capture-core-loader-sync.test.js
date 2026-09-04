/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const capturePath = join(
  root,
  'integration-tests',
  'terminal-capture',
  'skill-review-harness',
  'text-capture.tsx',
);
const coreDir = join(root, 'packages', 'core');

// The skill-review-harness loader redirects core subpath specifiers to their
// TypeScript sources so a capture runs without a build and can never mix in a
// stale dist. Its inline `named` map must carry one entry per named key of
// core's exports map: a missing entry whose specifier has no mirrored
// packages/core/src/<subpath>.ts file falls through to the exports map — on a
// fresh clone the capture dies mid-import with ERR_MODULE_NOT_FOUND, and with
// a stale dist present that one module silently loads from compiled output,
// the exact failure mode the loader exists to prevent.
describe('skill-review-harness core loader sync', () => {
  const source = readFileSync(capturePath, 'utf8');
  const namedBlock = source.match(/const named = new Map\(\[([\s\S]*?)\]\);/);
  const named = new Map(
    [...(namedBlock?.[1] ?? '').matchAll(/\['([^']+)',\s*'([^']+)'\]/g)].map(
      (match) => [match[1], match[2]],
    ),
  );

  it('covers every named entry of the core exports map', () => {
    const exportsMap = JSON.parse(
      readFileSync(join(coreDir, 'package.json'), 'utf8'),
    ).exports;
    const namedKeys = Object.keys(exportsMap).filter(
      (key) =>
        key.startsWith('./') && !key.includes('*') && key !== './package.json',
    );
    expect(namedKeys.length).toBeGreaterThan(0);
    for (const key of namedKeys) {
      expect(
        named.has(key.slice('./'.length)),
        `loader named map is missing exports entry ${key}`,
      ).toBe(true);
    }
  });

  it('points every entry at an existing core source file', () => {
    expect(named.size).toBeGreaterThan(0);
    for (const [name, target] of named) {
      expect(
        existsSync(join(coreDir, 'src', target)),
        `loader entry ${name} -> packages/core/src/${target} does not exist`,
      ).toBe(true);
    }
  });
});
