/**
 * @license
 * Copyright 2025 Google LLC
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
// that is not source-aliased, add its package here as well.
export const DIST_PREREQUISITES = {
  'packages/cli': [
    'packages/acp-bridge',
    'packages/sdk-typescript',
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

function distEntryFile(packageDir) {
  const manifest = JSON.parse(
    readFileSync(path.join(packageDir, 'package.json'), 'utf8'),
  );
  const dot = manifest.exports?.['.'];
  const entry =
    (typeof dot === 'object' && (dot.import || dot.default)) || manifest.main;
  return entry ? path.join(packageDir, entry) : null;
}

/**
 * Returns human-readable lines describing the missing prerequisites for
 * `packageRelPath` (e.g. `packages/cli`) under `root`, or an empty array
 * when everything is in place (or the package has no known prerequisites).
 */
export function findMissingPrerequisites(packageRelPath, root = repoRoot) {
  const distPackages = DIST_PREREQUISITES[packageRelPath];
  const generatedFiles = GENERATED_PREREQUISITES[packageRelPath];
  if (!distPackages && !generatedFiles) {
    return [];
  }

  const missing = [];
  for (const rel of distPackages ?? []) {
    const entryFile = distEntryFile(path.join(root, rel));
    if (!entryFile || !existsSync(entryFile)) {
      const name = JSON.parse(
        readFileSync(path.join(root, rel, 'package.json'), 'utf8'),
      ).name;
      missing.push(
        `  - ${rel}: workspace package "${name}" has not been built` +
          (entryFile ? ` (missing ${path.relative(root, entryFile)})` : ''),
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

export default function checkUnitTestPrerequisites() {
  const missing = findMissingPrerequisites(
    path.relative(repoRoot, process.cwd()),
  );
  if (missing.length === 0) {
    return;
  }

  // Print and exit directly instead of throwing: a thrown error surfaces as
  // an "Unhandled Error" after vitest's reporter has already printed a
  // misleading "No test files found" line, which is exactly the confusion
  // this guard exists to remove.
  console.error(formatPrerequisiteMessage(missing));
  process.exit(1);
}
