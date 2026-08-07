/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { manifestRepositoryContextProvider } from './manifest-repository-context.js';
import { MAX_ARRAY_ITEMS } from './repository-context.js';

// The committed manifest is load-bearing review infrastructure: a hand-edit
// the strict parser rejects would fail every later medium/high-effort review
// of this repository closed, mid-review. The provider tests use synthetic
// manifests in temp worktrees, so only these tests catch such an edit — they
// run the real provider against the committed artifact.
const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
);

function readCommittedFile(relativePath: string): string | null {
  const candidate = join(repoRoot, relativePath);
  if (!existsSync(candidate)) return null;
  // The worktree identity reader's contract: CRLF normalised to LF,
  // surrounding whitespace trimmed.
  return readFileSync(candidate, 'utf8').replace(/\r\n/g, '\n').trim();
}

function provideForRepo(changedPaths: string[]) {
  return manifestRepositoryContextProvider.provide({
    worktree: repoRoot,
    changedPaths,
    readIdentityFile: readCommittedFile,
  });
}

// One representative changed path per manifest rule. The web-shell entry
// sits outside that rule's relatedPaths subtrees so its expansion stays
// visible in the merged output.
const ruleSamples: ReadonlyArray<{ path: string; domain: string }> = [
  { path: 'packages/cli/src/commands/review/run.ts', domain: 'review' },
  { path: 'packages/core/src/index.ts', domain: 'core' },
  {
    path: 'packages/core/src/config/approval-mode.ts',
    domain: 'core-config',
  },
  {
    path: 'packages/core/src/skills/bundled/batch/SKILL.md',
    domain: 'core-skills',
  },
  { path: 'packages/web-shell/client/App.tsx', domain: 'web-shell' },
  { path: 'integration-tests/cli/edit.test.ts', domain: 'integration-tests' },
  { path: '.github/workflows/ci.yml', domain: 'ci' },
  { path: 'package.json', domain: 'build' },
];

describe('committed review context manifest', () => {
  it('parses and matches every rule for a representative changed path', () => {
    for (const { path, domain } of ruleSamples) {
      const context = provideForRepo([path]);
      expect(context, `no context for ${path}`).not.toBeNull();
      expect(context?.domains, `domains for ${path}`).toContain(domain);
    }
  });

  it('expands the web-shell relatedPaths against the real tree', () => {
    const context = provideForRepo(['packages/web-shell/client/App.tsx']);
    expect(context?.relatedPaths.length).toBeGreaterThan(0);
    for (const related of context?.relatedPaths ?? []) {
      expect(related).toMatch(/^packages\/web-shell\/client\//);
    }
  });

  it('stays under the resolved-file bound when every rule co-matches', () => {
    // The provider merges the relatedPaths of ALL matching rules into one
    // expansion capped at MAX_ARRAY_ITEMS and throws beyond it, aborting
    // `review repo-context` fail-closed. One changed path per rule is the
    // widest co-matching combination a PR can bring; a rule whose
    // relatedPaths glob resolves enough files to break that sum throws here.
    const context = provideForRepo(ruleSamples.map((sample) => sample.path));
    expect(context).not.toBeNull();
    expect(context?.relatedPaths.length).toBeLessThanOrEqual(MAX_ARRAY_ITEMS);
  });
});
