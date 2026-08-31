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

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(__dirname, '..');

// Per-package prerequisites: for each key, the workspace packages whose
// built `dist/` output that package's tests import through package.json
// `main`/`exports` entries — i.e. packages that are NOT fully aliased to
// TypeScript source in that package's vitest.config.ts. `packages/core`
// lists itself: several core test files import the bare
// `@qwen-code/qwen-code-core` specifier, which resolves through the
// package's own exports to `dist/index.js`.
// Verified against a clean checkout: each missing entry below produces a
// "Failed to resolve" collection error. When you add a cross-package import
// that is not source-aliased, add its package here as well; the sync test in
// scripts/tests/vitest-global-setup.test.js asserts the builtin channels of
// channel-registry.ts stay covered.
export const DIST_PREREQUISITES = {
  'packages/core': ['packages/channels/base', 'packages/core'],
  'packages/cli': [
    'packages/acp-bridge',
    'packages/web-templates',
    'packages/channels/base',
    'packages/channels/dingtalk',
    'packages/channels/dws',
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

// Specifiers aliased to TypeScript source in a consumer's vitest config
// (keys of `resolve.alias`, e.g. `'@qwen-code/acp-bridge/bridgeErrors'`).
// Dist targets behind an aliased specifier are never resolved from dist/
// during test collection, so probing them would block runs that pass.
// Alias keys are matched as quoted object keys containing a `/` — the only
// such keys in these configs are specifier aliases. An unreadable config
// yields an empty set (probe everything).
export function aliasedSpecifiers(configPath) {
  let source;
  try {
    source = readFileSync(configPath, 'utf8');
  } catch {
    return new Set();
  }
  // ponytail: lexical comment strip for checked-in vitest configs; use a TS
  // parser if generated configs or exotic string literals need support.
  const uncommented = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  return new Set(
    [...uncommented.matchAll(/'([^']*\/[^']*)':/g)].map((match) => match[1]),
  );
}

// Every file under `dist/` that the manifest's `exports`/`main` entries
// point at, each paired with the import specifier it serves. Checking all
// of them (not only the '.' entry) also covers unaliased subpath imports
// such as `@qwen-code/acp-bridge/sessionRestoreTimeout`; a package whose
// dist is missing any listed file would still break test collection. Note
// that dist files reachable only through a root-index re-export are not
// listed in `exports` and remain outside this probe.
export function distEntryFiles(manifest, packageDir) {
  const files = [];
  const name = manifest.name;
  const collect = (specifier, target) => {
    // Wildcard pattern entries (`"./dist/*": "./dist/*"`) name no individual
    // file and cannot be enumerated here; skip them. Normalize targets without
    // a leading `./` — all guarded manifests spell `"main": "dist/index.js"`.
    if (typeof target !== 'string' || target.includes('*')) return;
    const normalized = target.startsWith('./') ? target : `./${target}`;
    if (normalized.startsWith('./dist/')) {
      files.push({ specifier, file: path.join(packageDir, normalized) });
    }
  };
  for (const [key, entry] of Object.entries(manifest.exports ?? {})) {
    const specifier =
      key === '.' ? name : `${name}/${key.replace(/^\.\//, '')}`;
    if (typeof entry === 'string') collect(specifier, entry);
    else if (entry && typeof entry === 'object')
      collect(specifier, entry.import ?? entry.default);
  }
  collect(name, manifest.main);
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

  const aliased = aliasedSpecifiers(path.join(root, key, 'vitest.config.ts'));
  const missing = [];
  for (const rel of distPackages ?? []) {
    const packageDir = path.join(root, rel);
    let name;
    let enumerated;
    try {
      const manifest = readManifest(packageDir);
      name = manifest.name;
      enumerated = distEntryFiles(manifest, packageDir);
    } catch {
      // A missing directory or unreadable manifest is itself a missing
      // prerequisite; report it through the normal exit path instead of
      // crashing the guard with a raw filesystem stack trace.
      missing.push(
        `  - ${rel}: package directory or package.json is missing/unreadable`,
      );
      continue;
    }
    if (enumerated.length === 0) {
      // Zero enumeration means the manifest exposes no ./dist/ target the
      // probe understands (e.g. a require-only or nested-condition entry).
      // Fail loud instead of silently passing — a stale probe must not
      // resurrect the raw resolution error this guard exists to replace.
      missing.push(
        `  - ${rel}: package.json exposes no dist/ entry files to check` +
          ' (guard probe may be stale)',
      );
      continue;
    }
    // Entries served by a source alias in the consumer's vitest config never
    // resolve from dist/ during collection; probing them would fail runs
    // whose aliased dist files simply have not been (re)built.
    const entryFiles = enumerated
      .filter(({ specifier }) => !aliased.has(specifier))
      .map(({ file }) => file);
    if (entryFiles.length === 0) {
      continue;
    }
    const absent = entryFiles.find((file) => !existsSync(file));
    if (absent) {
      const partiallyBuilt = entryFiles.some((file) => existsSync(file));
      missing.push(
        partiallyBuilt
          ? `  - ${rel}: workspace package "${name}" build output is` +
              ' incomplete or package.json exports points at a file the' +
              ` build does not emit (missing ${path.relative(root, absent)})` +
              ' — re-run "npm run build"; if it still fails, check the' +
              " package's exports entries"
          : `  - ${rel}: workspace package "${name}" has not been built` +
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
  const hasGenerated = missing.some((line) =>
    line.includes('generated file does not exist'),
  );
  const hasStaleProbe = missing.some((line) =>
    line.includes('guard probe may be stale'),
  );
  const lines = [
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
  ];
  if (hasGenerated) {
    lines.push(
      'To only regenerate git-commit.ts, run "npm run generate" instead.',
      '',
    );
  }
  if (hasStaleProbe) {
    lines.push(
      'Note: a "guard probe may be stale" line above means the guard itself',
      'needs updating to match the package manifest; "npm run build" alone',
      'will not clear it.',
      '',
    );
  }
  return lines.join('\n');
}

function realpathOrSelf(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Checks prerequisites for `cwd` against `root`, prints the actionable
 * message when something is missing, and returns the intended exit code
 * (0 = ready, 1 = missing prerequisites).
 */
export function checkAndReport({ cwd = process.cwd(), root = repoRoot } = {}) {
  // Realpath both ends before deriving the key: `repoRoot` descends from
  // import.meta.url, which Node resolves through symlinks, while vitest
  // resolves `root` with a plain path.resolve — comparing them raw lets a
  // symlinked ancestor spell the same directory two ways and silently
  // disable the guard.
  const realRoot = realpathOrSelf(root);
  const missing = findMissingPrerequisites(
    path.relative(realRoot, realpathOrSelf(cwd)),
    realRoot,
  );
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
  // QWEN_VITEST_GUARD_ROOT lets the tests exercise this entry point against
  // a hermetic fixture checkout; production never sets it.
  const root = process.env['QWEN_VITEST_GUARD_ROOT'] || undefined;
  const exitCode = checkAndReport({ cwd, root });
  if (exitCode !== 0) {
    // Exit directly instead of throwing: a thrown error surfaces as an
    // "Unhandled Error" after vitest's reporter has already printed a
    // misleading "No test files found" line, which is exactly the confusion
    // this guard exists to remove.
    process.exit(exitCode);
  }
}
