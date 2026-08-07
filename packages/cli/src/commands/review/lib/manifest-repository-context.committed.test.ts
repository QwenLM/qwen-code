/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
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

const MANIFEST_RELATIVE_PATH = '.qwen/review-context.json';

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

interface CommittedRule {
  paths: string[];
  relatedPaths?: string[];
  domains?: string[];
  recommendedTests?: string[];
  requiredConfigurations?: string[];
}

function readCommittedRules(): CommittedRule[] {
  const content = readCommittedFile(MANIFEST_RELATIVE_PATH);
  if (content === null) {
    throw new Error('committed review context manifest is missing');
  }
  return (JSON.parse(content) as { rules: CommittedRule[] }).rules;
}

// The static directory prefix of a glob; the full pattern when it has no
// wildcard segment at all.
function staticPrefixOf(pattern: string): string {
  const prefix: string[] = [];
  for (const segment of pattern.split('/')) {
    if (segment.includes('*') || segment.includes('?')) break;
    prefix.push(segment);
  }
  return prefix.join('/');
}

// A changed path is only glob-matched, never opened, so a wildcard pattern's
// probe needs no file on disk: one synthetic file below its static prefix.
function probeFor(pattern: string): string {
  const prefix = staticPrefixOf(pattern);
  return prefix === pattern || prefix === '' ? pattern : `${prefix}/probe.txt`;
}

function inGitWorktree(): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

// Every paths pattern committed at review time is pinned: the probes above
// are derived from the manifest, so a deleted pattern takes its probe with
// it and would otherwise slip past every test in this file.
const pinnedPathPatterns: readonly string[] = [
  'packages/cli/src/commands/review/**',
  'packages/core/src/**',
  'packages/core/src/config/**',
  'packages/core/src/skills/**',
  'packages/web-shell/client/**',
  'integration-tests/**',
  '.github/workflows/**',
  'scripts/**',
  'eslint-rules/**',
  'eslint.config.js',
  'package.json',
];

// recommendedTests and requiredConfigurations are rendered verbatim into
// reviewer prompts, so pin them independently of the manifest: a typo'd or
// deleted value must fail here instead of silently redirecting every later
// medium/high-effort review of this repository.
const pinnedPayloads: ReadonlyArray<{
  path: string;
  recommendedTests: string[];
  requiredConfigurations: string[];
}> = [
  {
    path: 'packages/cli/src/commands/review/**',
    recommendedTests: ['review'],
    requiredConfigurations: ['node22'],
  },
  {
    path: 'packages/core/src/**',
    recommendedTests: ['core'],
    requiredConfigurations: ['node22'],
  },
  {
    path: 'packages/web-shell/client/**',
    recommendedTests: ['web-shell'],
    requiredConfigurations: ['node22'],
  },
  {
    path: 'integration-tests/**',
    recommendedTests: ['integration-tests'],
    requiredConfigurations: ['node22'],
  },
  {
    path: '.github/workflows/**',
    recommendedTests: ['helper-tests'],
    requiredConfigurations: ['github-actions'],
  },
  {
    path: 'scripts/**',
    recommendedTests: ['build-lint'],
    requiredConfigurations: ['node22'],
  },
];

describe('committed review context manifest', () => {
  const rules = readCommittedRules();

  it('matches every committed paths pattern for a synthesized probe', () => {
    // Deriving one probe per pattern from the manifest itself keeps the
    // one-sample-per-rule invariant without hand-maintenance: a rule added
    // to the manifest enters these tests the moment it is committed.
    for (const rule of rules) {
      for (const pattern of rule.paths) {
        const context = provideForRepo([probeFor(pattern)]);
        expect(context, `no context for ${pattern}`).not.toBeNull();
        for (const domain of rule.domains ?? []) {
          expect(context?.domains, `domains for ${pattern}`).toContain(domain);
        }
      }
    }
  });

  it('resolves every committed relatedPaths glob against the real tree', () => {
    // Aggregate-only checks survive a break in any single glob: a typo'd
    // scan root is skipped as ENOENT while the remaining subtrees still
    // satisfy a length or prefix assertion. Assert each glob contributes.
    for (const rule of rules) {
      for (const pattern of rule.relatedPaths ?? []) {
        const context = provideForRepo([probeFor(rule.paths[0])]);
        expect(context, `no context for ${rule.paths[0]}`).not.toBeNull();
        const prefix = staticPrefixOf(pattern);
        const contributed =
          prefix === pattern
            ? (context?.relatedPaths.includes(pattern) ?? false)
            : (context?.relatedPaths.some((path) =>
                path.startsWith(`${prefix}/`),
              ) ?? false);
        expect(contributed, `no files resolved for ${pattern}`).toBe(true);
      }
    }
  });

  it('stays under the resolved-file bound when every rule co-matches', () => {
    // The provider merges the relatedPaths of ALL matching rules into one
    // expansion capped at MAX_ARRAY_ITEMS and throws beyond it, aborting
    // `review repo-context` fail-closed. One probe per paths pattern is the
    // widest co-matching combination a PR can bring; a rule whose
    // relatedPaths glob resolves enough files to break that sum throws here.
    const probes = rules.flatMap((rule) => rule.paths.map(probeFor));
    const context = provideForRepo(probes);
    expect(context).not.toBeNull();
    expect(context?.relatedPaths.length).toBeLessThanOrEqual(MAX_ARRAY_ITEMS);
  });

  it('keeps every pinned paths pattern in the manifest', () => {
    const patterns = new Set(rules.flatMap((rule) => rule.paths));
    for (const pattern of pinnedPathPatterns) {
      expect(patterns, `paths pattern ${pattern} was removed`).toContain(
        pattern,
      );
    }
  });

  it('keeps every payload-bearing rule pinned to its rendered values', () => {
    const payloadRules = rules.filter(
      (rule) =>
        (rule.recommendedTests ?? []).length > 0 ||
        (rule.requiredConfigurations ?? []).length > 0,
    );
    // Every payload-bearing rule is pinned and every pin matches a rule, so
    // a payload edit cannot slip past the assertions below.
    expect(payloadRules.map((rule) => rule.paths[0]).sort()).toEqual(
      [...pinnedPayloads.map((pin) => pin.path)].sort(),
    );
    for (const pin of pinnedPayloads) {
      const context = provideForRepo([probeFor(pin.path)]);
      for (const name of pin.recommendedTests) {
        expect(
          context?.recommendedTests,
          `recommendedTests for ${pin.path}`,
        ).toContain(name);
      }
      for (const name of pin.requiredConfigurations) {
        expect(
          context?.requiredConfigurations,
          `requiredConfigurations for ${pin.path}`,
        ).toContain(name);
      }
    }
  });

  it.skipIf(!inGitWorktree())(
    'keeps the manifest un-ignored and tracked despite the .qwen/* ignore',
    () => {
      // Existing checkouts keep their on-disk copy if the .gitignore
      // negation is ever removed, so the provider tests above stay green
      // while the file drifts out of version control; check-ignore catches
      // the negation removal itself, ls-files the eventual untrack.
      // --no-index: the manifest IS tracked right now, and check-ignore
      // never reports a tracked path as ignored — only the raw pattern
      // evaluation discriminates the negation hunk.
      const exitsZero = (args: string[]): boolean => {
        try {
          execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
          return true;
        } catch {
          return false;
        }
      };
      expect(
        exitsZero(['check-ignore', '--no-index', '--', MANIFEST_RELATIVE_PATH]),
        'manifest must not be ignored by git',
      ).toBe(false);
      expect(
        exitsZero([
          'ls-files',
          '--error-unmatch',
          '--',
          MANIFEST_RELATIVE_PATH,
        ]),
        'manifest must be tracked by git',
      ).toBe(true);
    },
  );
});
