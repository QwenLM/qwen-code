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
  const exportsMap = JSON.parse(
    readFileSync(join(coreDir, 'package.json'), 'utf8'),
  ).exports;
  const namedKeys = Object.keys(exportsMap).filter(
    (key) =>
      key.startsWith('./') && !key.includes('*') && key !== './package.json',
  );

  it('covers every named entry of the core exports map', () => {
    expect(namedKeys.length).toBeGreaterThan(0);
    for (const key of namedKeys) {
      expect(
        named.has(key.slice('./'.length)),
        `loader named map is missing exports entry ${key}`,
      ).toBe(true);
    }
  });

  it('points every entry at the exports target in source space', () => {
    expect(named.size).toBeGreaterThan(0);
    for (const [name, target] of named) {
      expect(
        existsSync(join(coreDir, 'src', target)),
        `loader entry ${name} -> packages/core/src/${target} does not exist`,
      ).toBe(true);
      // Key coverage alone is not enough: a retargeted exports entry would
      // leave the loader serving the old module (the named map short-circuits
      // ahead of the loader's stem probe) while a built CLI runs the new one.
      // All named entries target ./dist/src/<stem>.js; an entry targeting
      // elsewhere needs an explicit exemption, not a blanket rewrite.
      const entry = exportsMap[`./${name}`];
      const importTarget = typeof entry === 'string' ? entry : entry?.import;
      const stem = importTarget
        .replace(/^\.\/dist\/src\//, '')
        .replace(/\.js$/, '');
      expect(
        [`${stem}.ts`, `${stem}.tsx`],
        `loader entry ${name} -> ${target} disagrees with exports target ${importTarget}`,
      ).toContain(target);
    }
  });

  it('has no loader entries without a matching exports key', () => {
    // The reverse direction of the key-set identity: a stale loader-only
    // entry short-circuits in a capture to a module the shipped package can
    // no longer resolve (ERR_PACKAGE_PATH_NOT_EXPORTED), so the capture runs
    // green on a module graph production rejects.
    for (const [name] of named) {
      expect(
        namedKeys.includes(`./${name}`),
        `loader entry ${name} has no matching exports key ./${name}`,
      ).toBe(true);
    }
  });
});
