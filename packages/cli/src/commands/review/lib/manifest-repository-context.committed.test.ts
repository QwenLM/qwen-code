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

const expectedManifest = {
  version: 1,
  label: 'Qwen Code',
  rules: [
    {
      paths: ['packages/cli/src/commands/review/**'],
      domains: ['cli', 'review'],
      recommendedTests: ['review'],
      requiredConfigurations: ['node22'],
    },
    {
      paths: ['packages/core/src/**'],
      domains: ['core'],
      recommendedTests: ['core'],
      requiredConfigurations: ['node22'],
    },
    {
      paths: ['packages/core/src/config/**'],
      relatedPaths: ['packages/core/src/config/**'],
      domains: ['core-config'],
    },
    {
      paths: ['packages/core/src/skills/**'],
      relatedPaths: ['packages/core/src/skills/**'],
      domains: ['core-skills'],
    },
    {
      paths: ['packages/web-shell/client/**'],
      domains: ['web-shell'],
      recommendedTests: ['web-shell'],
      requiredConfigurations: ['node22'],
    },
    {
      paths: ['packages/web-shell/client/**'],
      relatedPaths: [
        'packages/web-shell/client/adapters/**',
        'packages/web-shell/client/completions/**',
        'packages/web-shell/client/e2e/*',
        'packages/web-shell/client/e2e/utils/*',
        'packages/web-shell/client/e2e/visuals/*',
        'packages/web-shell/client/hooks/**',
      ],
    },
    {
      paths: ['integration-tests/**'],
      domains: ['integration-tests'],
      recommendedTests: ['integration-tests'],
      requiredConfigurations: ['node22'],
    },
    {
      paths: ['.github/workflows/**'],
      domains: ['ci', 'workflows'],
      recommendedTests: ['helper-tests'],
      requiredConfigurations: ['github-actions'],
    },
    {
      paths: [
        'scripts/**',
        'eslint-rules/**',
        'eslint.config.js',
        'package.json',
      ],
      domains: ['build', 'lint'],
      recommendedTests: ['build-lint'],
      requiredConfigurations: ['node22'],
    },
  ],
} as const;

const relatedPathSentinels: Readonly<Record<string, string>> = {
  'packages/core/src/config/**': 'packages/core/src/config/config.ts',
  'packages/core/src/skills/**':
    'packages/core/src/skills/bundled/review/SKILL.md',
  'packages/web-shell/client/adapters/**':
    'packages/web-shell/client/adapters/types.ts',
  'packages/web-shell/client/completions/**':
    'packages/web-shell/client/completions/slashCompletion.ts',
  'packages/web-shell/client/e2e/*':
    'packages/web-shell/client/e2e/web-shell.smoke.spec.ts',
  'packages/web-shell/client/e2e/utils/*':
    'packages/web-shell/client/e2e/utils/mockDaemon.ts',
  'packages/web-shell/client/e2e/visuals/*':
    'packages/web-shell/client/e2e/visuals/constants.ts',
  'packages/web-shell/client/hooks/**':
    'packages/web-shell/client/hooks/useMessages.ts',
};

function readCommittedFile(relativePath: string): string | null {
  const candidate = join(repoRoot, relativePath);
  if (!existsSync(candidate)) return null;
  return readFileSync(candidate, 'utf8').replace(/\r\n/g, '\n').trim();
}

function provideForRepo(changedPaths: string[]) {
  return manifestRepositoryContextProvider.provide({
    worktree: repoRoot,
    changedPaths,
    readIdentityFile: readCommittedFile,
  });
}

function probeFor(pattern: string): string {
  const wildcard = pattern.search(/[?*]/);
  if (wildcard === -1) return pattern;
  const slash = pattern.lastIndexOf('/', wildcard);
  return `${pattern.slice(0, slash)}/probe.txt`;
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

function exitsZero(args: string[]): boolean {
  try {
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

describe('committed review context manifest', () => {
  it('matches the pinned repository review policy', () => {
    const content = readCommittedFile(MANIFEST_RELATIVE_PATH);
    expect(content).not.toBeNull();
    expect(JSON.parse(content as string)).toEqual(expectedManifest);
  });

  it('matches every paths pattern through the real provider', () => {
    for (const rule of expectedManifest.rules) {
      for (const pattern of rule.paths) {
        expect(provideForRepo([probeFor(pattern)])).not.toBeNull();
      }
    }
  });

  it('resolves a distinct sentinel for every relatedPaths pattern', () => {
    const patterns = expectedManifest.rules.flatMap((rule) =>
      'relatedPaths' in rule ? [...rule.relatedPaths] : [],
    );
    expect(Object.keys(relatedPathSentinels).sort()).toEqual(
      [...patterns].sort(),
    );

    for (const rule of expectedManifest.rules) {
      if (!('relatedPaths' in rule)) continue;
      const context = provideForRepo([probeFor(rule.paths[0])]);
      expect(context).not.toBeNull();
      for (const pattern of rule.relatedPaths) {
        const sentinel = relatedPathSentinels[pattern];
        expect(context?.relatedPaths).toContain(sentinel);
      }
    }
  });

  it('stays under the resolved-file bound when every rule co-matches', () => {
    const probes = expectedManifest.rules.flatMap((rule) =>
      rule.paths.map(probeFor),
    );
    const context = provideForRepo(probes);
    expect(context).not.toBeNull();
    expect(context?.relatedPaths.length).toBeLessThanOrEqual(MAX_ARRAY_ITEMS);
  });

  it.skipIf(!inGitWorktree())(
    'keeps the manifest un-ignored and tracked despite the .qwen/* ignore',
    () => {
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
