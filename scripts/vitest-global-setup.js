/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Vitest globalSetup guard for package-local unit tests.
 *
 * In a fresh clone or a new worktree, workspace packages such as
 * `@qwen-code/acp-bridge`, `@qwen-code/web-templates` and the channel
 * packages have no `dist/` output until `npm run build` has run, and
 * `src/generated/git-commit.ts` does not exist until `npm run generate`
 * has run. Unit tests that import them then fail during collection with
 * module-resolution errors that name neither the cause nor the fix.
 *
 * This guard checks those prerequisites up front and fails with a message
 * that names both the missing pieces and the command that creates them.
 * See https://github.com/QwenLM/qwen-code/issues/9149.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(__dirname, '..');

// Workspace packages that `packages/cli` tests import through package.json
// `main`/`exports` entries pointing at `dist/` — i.e. packages that are NOT
// fully aliased to TypeScript source in packages/cli/vitest.config.ts.
// Verified against a clean checkout: each missing entry below produces a
// "Failed to resolve" collection error. When you add a cross-package import
// that is not source-aliased, add its package here as well; the sync test in
// scripts/tests/vitest-global-setup.test.js asserts the builtin channels of
// channel-registry.ts stay covered.
export const DIST_PREREQUISITES = {
  'packages/cli': [
    'packages/acp-bridge',
    'packages/web-templates',
    'packages/channels/base',
    'packages/channels/dingtalk',
    'packages/channels/feishu',
    'packages/channels/github',
    'packages/channels/gitlab',
    'packages/channels/qqbot',
    'packages/channels/telegram',
    'packages/channels/wecom',
    'packages/channels/weixin',
  ],
};

// Generated files that unit tests import but that a fresh checkout does
// not contain (`scripts/generate-git-commit-info.js` produces them; the
// root `npm run build` runs it).
export const GENERATED_PREREQUISITES = {
  'packages/cli': ['packages/cli/src/generated/git-commit.ts'],
};

// Normalize win32 backslash separators so keys derived from Windows paths
// match the forward-slash keys above instead of silently disabling the guard.
export function normalizePackageKey(relPath) {
  return relPath.split(/[\\/]/).join('/').replace(/\/+$/, '');
}

function readManifest(packageDir) {
  return JSON.parse(
    readFileSync(path.join(packageDir, 'package.json'), 'utf8'),
  );
}

// Every file under `dist/` that the manifest's `exports`/`main` entries
// point at. Checking all of them (not only the '.' entry) also covers
// unaliased subpath imports such as
// `@qwen-code/acp-bridge/sessionRestoreTimeout`; a package whose dist is
// missing any listed file would still break test collection. Note that dist
// files reachable only through a root-index re-export are not listed in
// `exports` and remain outside this probe.
export function distEntryFiles(packageDir) {
  const manifest = readManifest(packageDir);
  const files = [];
  const collect = (target) => {
    if (typeof target === 'string' && target.startsWith('./dist/')) {
      files.push(path.join(packageDir, target));
    }
  };
  for (const entry of Object.values(manifest.exports ?? {})) {
    if (typeof entry === 'string') collect(entry);
    else if (entry && typeof entry === 'object')
      collect(entry.import ?? entry.default);
  }
  collect(manifest.main);
  return files;
}

/**
 * Returns human-readable lines describing the missing prerequisites for
 * `packageRelPath` (e.g. `packages/cli`) under `root`, or an empty array
 * when everything is in place (or the package has no known prerequisites).
 */
export function findMissingPrerequisites(packageRelPath, root = repoRoot) {
  const key = normalizePackageKey(packageRelPath);
  const distPackages = DIST_PREREQUISITES[key];
  const generatedFiles = GENERATED_PREREQUISITES[key];
  if (!distPackages && !generatedFiles) {
    return [];
  }

  const missing = [];
  for (const rel of distPackages ?? []) {
    const packageDir = path.join(root, rel);
    let name;
    let entryFiles;
    try {
      const manifest = readManifest(packageDir);
      name = manifest.name;
      entryFiles = distEntryFiles(packageDir);
    } catch {
      // A missing directory or unreadable manifest is itself a missing
      // prerequisite; report it through the normal exit path instead of
      // crashing the guard with a raw filesystem stack trace.
      missing.push(
        `  - ${rel}: package directory or package.json is missing/unreadable`,
      );
      continue;
    }
    const absent = entryFiles.find((file) => !existsSync(file));
    if (absent) {
      missing.push(
        `  - ${rel}: workspace package "${name}" has not been built` +
          ` (missing ${path.relative(root, absent)})`,
      );
    }
  }
  for (const rel of generatedFiles ?? []) {
    if (!existsSync(path.join(root, rel))) {
      missing.push(`  - ${rel}: generated file does not exist`);
    }
  }
  return missing;
}

export function formatPrerequisiteMessage(missing) {
  return [
    '',
    'Unit-test build prerequisites are missing (fresh checkout detected):',
    '',
    ...missing,
    '',
    'Package-local unit tests import these workspace packages through',
    'their built dist/ output, which a fresh clone or new worktree does',
    'not have. From the repository root, run:',
    '',
    '    npm run build',
    '',
    'then re-run the tests. (To only regenerate git-commit.ts, run',
    '"npm run generate" instead.)',
    '',
  ].join('\n');
}

/**
 * Checks prerequisites for `cwd` against `root`, prints the actionable
 * message when something is missing, and returns the intended exit code
 * (0 = ready, 1 = missing prerequisites).
 */
export function checkAndReport({ cwd = process.cwd(), root = repoRoot } = {}) {
  const missing = findMissingPrerequisites(path.relative(root, cwd), root);
  if (missing.length === 0) {
    return 0;
  }
  console.error(formatPrerequisiteMessage(missing));
  return 1;
}

export default function checkUnitTestPrerequisites(project) {
  // Vitest passes the TestProject; its resolved root stays correct even when
  // vitest is launched as `vitest run --root packages/cli` from elsewhere.
  // Fall back to process.cwd() when invoked outside vitest.
  const cwd = project?.config?.root ?? process.cwd();
  const exitCode = checkAndReport({ cwd });
  if (exitCode !== 0) {
    // Exit directly instead of throwing: a thrown error surfaces as an
    // "Unhandled Error" after vitest's reporter has already printed a
    // misleading "No test files found" line, which is exactly the confusion
    // this guard exists to remove.
    process.exit(exitCode);
  }
}
