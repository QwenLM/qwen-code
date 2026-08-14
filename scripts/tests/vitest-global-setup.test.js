/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DIST_PREREQUISITES,
  GENERATED_PREREQUISITES,
  findMissingPrerequisites,
  formatPrerequisiteMessage,
} from '../vitest-global-setup.js';

function buildFixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'vitest-prereq-'));
  for (const rel of DIST_PREREQUISITES['packages/cli']) {
    mkdirSync(path.join(root, rel, 'dist'), { recursive: true });
    writeFileSync(
      path.join(root, rel, 'package.json'),
      JSON.stringify({
        name: `fake-${path.basename(rel)}`,
        exports: { '.': { import: './dist/index.js' } },
      }),
    );
    writeFileSync(path.join(root, rel, 'dist', 'index.js'), '');
  }
  for (const rel of GENERATED_PREREQUISITES['packages/cli']) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), '');
  }
  return root;
}

describe('vitest-global-setup prerequisite guard', () => {
  it('reports nothing when every prerequisite exists', () => {
    const root = buildFixtureRoot();
    try {
      expect(findMissingPrerequisites('packages/cli', root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports an unbuilt workspace package and a missing generated file', () => {
    const root = buildFixtureRoot();
    try {
      rmSync(path.join(root, 'packages/channels/base/dist/index.js'));
      rmSync(path.join(root, 'packages/cli/src/generated/git-commit.ts'));

      const missing = findMissingPrerequisites('packages/cli', root);
      expect(missing).toHaveLength(2);
      expect(missing[0]).toContain('packages/channels/base');
      expect(missing[0]).toContain('has not been built');
      expect(missing[1]).toContain('packages/cli/src/generated/git-commit.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips packages without known prerequisites', () => {
    const root = buildFixtureRoot();
    try {
      expect(findMissingPrerequisites('packages/core', root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('names the fix command in the formatted message', () => {
    const message = formatPrerequisiteMessage(['  - packages/x: nope']);
    expect(message).toContain('npm run build');
    expect(message).toContain('packages/x: nope');
    expect(message).toContain('npm run generate');
  });
});
