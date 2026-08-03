/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, basename, resolve, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { glob } from 'glob';
import fs from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRoot = join(__dirname, '..');
const BUNDLED_SKILL_TEST_FILE_RE =
  /\.(?:test|spec)\.(?:d\.)?[cm]?[jt]sx?(?:\.map)?$/;

/**
 * The digest of every review source this bundle was built from.
 *
 * Kept in step with `stale-bundle.ts`, which re-derives it the same way — and
 * duplicated rather than shared, because this script runs before the package
 * it would import has been built. `scripts/tests/review-source-digest.test.ts`
 * is what holds the two equal; nothing here is imported from there.
 *
 * Tests and fixtures are excluded on both sides: esbuild follows imports from
 * the CLI entry, neither is reachable that way, and a warning fired by an edit
 * that cannot change a byte of the bundle is the false positive this check
 * exists not to produce.
 */
// Mirrors NOT_BUNDLED_RE in stale-bundle.ts; the parity test keeps them equal.
const NOT_BUNDLED_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const NOT_BUNDLED_DIR = new Set(['__fixtures__', '__snapshots__']);
const NOT_BUNDLED_FILE = new Set(['test-utils.ts', '.DS_Store']);

export function reviewSourceDigestForBuild(root) {
  const cliCommands = join(root, 'packages', 'cli', 'src', 'commands');
  const roots = [
    join(cliCommands, 'review'),
    join(cliCommands, 'review.ts'),
    join(root, 'packages', 'core', 'src', 'skills', 'bundled', 'review'),
  ];
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOTDIR' && !NOT_BUNDLED_RE.test(dir)) files.push(dir);
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!NOT_BUNDLED_DIR.has(e.name)) walk(full);
      } else if (
        e.isFile() &&
        !NOT_BUNDLED_RE.test(e.name) &&
        !NOT_BUNDLED_FILE.has(e.name)
      ) {
        files.push(full);
      }
    }
  };
  for (const r of roots) walk(r);
  if (files.length === 0) return { digest: undefined, count: 0 };
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    hash.update(relative(root, file).split(sep).join('/'));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return { digest: hash.digest('hex'), count: files.length };
}

function stampReviewSourceDigest(root, distDir) {
  const { digest, count } = reviewSourceDigestForBuild(root);
  if (!digest) {
    console.log('No review sources found; skipped the source digest.');
    return;
  }
  fs.writeFileSync(join(distDir, 'review-sources.sha256'), digest);
  console.log(`Stamped the review source digest over ${count} files.`);
}

export function copyBundleAssets({ root = defaultRoot } = {}) {
  const distDir = join(root, 'dist');
  const coreVendorDir = join(root, 'packages', 'core', 'vendor');

  // Create the dist directory if it doesn't exist
  if (!existsSync(distDir)) {
    mkdirSync(distDir);
  }

  // Find and copy all .sb files from packages to the root of the dist directory
  const sbFiles = glob.sync('packages/**/*.sb', { cwd: root });
  for (const file of sbFiles) {
    copyFileSync(join(root, file), join(distDir, basename(file)));
  }

  console.log('Copied sandbox profiles to dist/');

  // Copy vendor directory (contains ripgrep binaries)
  console.log('Copying vendor directory...');
  if (existsSync(coreVendorDir)) {
    const destVendorDir = join(distDir, 'vendor');
    copyRecursiveSync(coreVendorDir, destVendorDir);
    console.log('Copied vendor directory to dist/');
  } else {
    console.warn(`Warning: Vendor directory not found at ${coreVendorDir}`);
  }

  // Copy bundled skills (e.g. /review) so they are available at runtime.
  // In the esbuild bundle, import.meta.url resolves to dist/cli.js, so
  // SkillManager looks for bundled skills at dist/bundled/.
  const bundledSkillsDir = join(
    root,
    'packages',
    'core',
    'src',
    'skills',
    'bundled',
  );
  if (existsSync(bundledSkillsDir)) {
    const destBundledDir = join(distDir, 'bundled');
    fs.rmSync(destBundledDir, { recursive: true, force: true });
    copyRecursiveSync(bundledSkillsDir, destBundledDir, {
      skipEntry: isBundledSkillTestFile,
    });
    console.log('Copied bundled skills to dist/bundled/');
  } else {
    console.warn(
      `Warning: Bundled skills directory not found at ${bundledSkillsDir}`,
    );
  }

  // Copy user docs into qc-helper bundled skill so it can reference them at runtime.
  // The qc-helper skill reads docs from a `docs/` subdirectory relative to its own
  // directory. In the esbuild bundle this becomes dist/bundled/qc-helper/docs/.
  const userDocsDir = join(root, 'docs', 'users');
  if (existsSync(userDocsDir)) {
    const destDocsDir = join(distDir, 'bundled', 'qc-helper', 'docs');
    copyRecursiveSync(userDocsDir, destDocsDir);
    console.log('Copied docs/users/ to dist/bundled/qc-helper/docs/');
  } else {
    console.warn(`Warning: User docs directory not found at ${userDocsDir}`);
  }

  // Copy builtin locales so bundled dist/cli.js can load UI translations at runtime.
  // Published packages already include these via prepare-package.js; bundle output
  // should mirror that behavior for local `node dist/cli.js` runs.
  const localesDir = join(root, 'packages', 'cli', 'src', 'i18n', 'locales');
  if (existsSync(localesDir)) {
    const destLocalesDir = join(distDir, 'locales');
    copyRecursiveSync(localesDir, destLocalesDir);
    console.log('Copied builtin locales to dist/locales/');
  } else {
    console.warn(`Warning: Locales directory not found at ${localesDir}`);
  }

  // Copy extension templates so bundled dist/cli.js can scaffold
  // `/extensions new` from the runtime examples directory.
  const extensionExamplesDir = join(
    root,
    'packages',
    'cli',
    'src',
    'commands',
    'extensions',
    'examples',
  );
  if (existsSync(extensionExamplesDir)) {
    const destExtensionExamplesDir = join(distDir, 'examples');
    copyRecursiveSync(extensionExamplesDir, destExtensionExamplesDir);
    console.log('Copied extension examples to dist/examples/');
  } else {
    console.warn(
      `Warning: Extension examples directory not found at ${extensionExamplesDir}`,
    );
  }

  // Copy the built Web Shell SPA (index.html + assets/) so the bundled
  // `qwen serve` can serve the browser UI at its root path. The library
  // build outputs (dist/index.js, dist/types) are for npm consumers and are
  // intentionally NOT copied. Source only exists after the web-shell
  // workspace is built (npm run build); when absent (e.g. a --cli-only
  // build, or bundling without a prior full build) we warn and skip so the
  // bundle step never fails — the daemon then runs API-only at runtime.
  const webShellDistDir = join(root, 'packages', 'web-shell', 'dist');
  const webShellIndexHtml = join(webShellDistDir, 'index.html');
  const webShellAssetsDir = join(webShellDistDir, 'assets');
  if (existsSync(webShellIndexHtml) && existsSync(webShellAssetsDir)) {
    const destWebShellDir = join(distDir, 'web-shell');
    mkdirSync(destWebShellDir, { recursive: true });
    copyFileSync(webShellIndexHtml, join(destWebShellDir, 'index.html'));
    copyRecursiveSync(webShellAssetsDir, join(destWebShellDir, 'assets'));
    console.log('Copied Web Shell UI to dist/web-shell/');
  } else {
    console.warn(
      `Warning: Web Shell assets not found at ${webShellDistDir}; ` +
        'dist/web-shell/ will be absent and `qwen serve` runs API-only. ' +
        'Run a full `npm run build` before bundling to include the UI.',
    );
  }

  // Stamp what the review sources looked like at build time. `/review` drives
  // the bundle, not the working tree, so a review command edited after this
  // point takes no effect — and without a record of what was built, the run
  // cannot tell and neither can its reader. Compared, not trusted: the check
  // reads this and re-derives the digest from the tree.
  stampReviewSourceDigest(root, distDir);

  console.log('\n✅ All bundle assets copied to dist/');
}

if (isDirectRun()) {
  copyBundleAssets();
}

function isDirectRun() {
  return process.argv[1]
    ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
    : false;
}

/**
 * Recursively copy directory
 */
function copyRecursiveSync(src, dest, options = {}) {
  if (!existsSync(src)) {
    return;
  }

  const stats = statSync(src);

  if (stats.isDirectory()) {
    if (!existsSync(dest)) {
      mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src);
    for (const entry of entries) {
      if (entry === '.DS_Store' || options.skipEntry?.(entry)) {
        continue;
      }

      const srcPath = join(src, entry);
      const destPath = join(dest, entry);
      copyRecursiveSync(srcPath, destPath, options);
    }
  } else {
    copyFileSync(src, dest);
    // Preserve execute permissions for binaries
    const srcStats = statSync(src);
    if (srcStats.mode & 0o111) {
      fs.chmodSync(dest, srcStats.mode);
    }
  }
}

function isBundledSkillTestFile(fileName) {
  return BUNDLED_SKILL_TEST_FILE_RE.test(fileName);
}
