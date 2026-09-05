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

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
  basename,
  resolve,
  relative,
  sep,
  extname,
} from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { glob } from 'glob';
import fs from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRoot = join(__dirname, '..');
// Exported for `scripts/tests/review-source-digest.test.ts`, which holds the
// skill root's digest allowlist up to everything this rule lets the copier
// ship — a file the copier would carry but the digest cannot see is a
// staleness check with a blind spot.
export const BUNDLED_SKILL_TEST_FILE_RE =
  /\.(?:test|spec)\.(?:d\.)?[cm]?[jt]sx?(?:\.map)?$/;

/**
 * The digest of every review source this bundle was built from.
 *
 * A staleness hint, not an integrity control: an unsigned file beside the
 * bundle, which anyone who can write `dist/` can write.
 *
 * Kept in step with `stale-bundle.ts`, which re-derives it the same way — and
 * duplicated rather than shared, because this script runs before the package
 * it would import has been built. `scripts/tests/review-source-digest.test.ts`
 * is what holds the two equal; nothing here is imported from there.
 *
 * Tests and fixtures are excluded on both sides: esbuild follows imports from
 * the CLI entry, neither is reachable that way, and a warning fired by an
 * edit to a file the bundle cannot contain is the false positive this check
 * exists not to produce. DESIGN.md is excluded for the same reason: the
 * copier below deliberately does not ship it.
 */
// Mirrors NOT_BUNDLED_RE / NOT_BUNDLED_DIR / NOT_BUNDLED_FILE /
// NOT_BUNDLED_SKILL_FILE / DIGESTED_EXTENSIONS in stale-bundle.ts; the
// parity test keeps them equal.
const NOT_BUNDLED_RE = /\.(?:test|spec)\.(?:d\.)?[cm]?[jt]sx?$/;
const NOT_BUNDLED_DIR = new Set(['__fixtures__', '__snapshots__']);
const NOT_BUNDLED_FILE = new Set(['test-utils.ts']);
const NOT_BUNDLED_SKILL_FILE = new Set(['DESIGN.md']);
const DIGESTED_EXTENSIONS = {
  code: new Set([
    '.ts',
    '.tsx',
    '.mts',
    '.cts',
    '.js',
    '.mjs',
    '.json',
    '.jsx',
  ]),
  skill: new Set(['.md']),
};

function isDigestedFile(kind, name) {
  if (!DIGESTED_EXTENSIONS[kind].has(extname(name))) return false;
  if (kind !== 'code') return !NOT_BUNDLED_SKILL_FILE.has(name);
  return !NOT_BUNDLED_RE.test(name) && !NOT_BUNDLED_FILE.has(name);
}

export function reviewSourceDigestForBuild(root) {
  const cliCommands = join(root, 'packages', 'cli', 'src', 'commands');
  const roots = [
    { path: join(cliCommands, 'review'), kind: 'code' },
    { path: join(cliCommands, 'review.ts'), kind: 'code' },
    // Mirrors the lease root `reviewSourceRoots` (stale-bundle.ts) adds; the
    // repo-tree case in review-source-digest.test.ts holds the two equal.
    {
      path: join(
        root,
        'packages',
        'cli',
        'src',
        'services',
        'review-worktree-lease.ts',
      ),
      kind: 'code',
    },
    // Mirrors the utils-helpers roots `reviewSourceRoots` (stale-bundle.ts)
    // adds; the repo-tree case in review-source-digest.test.ts holds the two
    // equal.
    {
      path: join(root, 'packages', 'cli', 'src', 'utils', 'shell-args.ts'),
      kind: 'code',
    },
    {
      path: join(root, 'packages', 'cli', 'src', 'utils', 'paths.ts'),
      kind: 'code',
    },
    {
      path: join(
        root,
        'packages',
        'core',
        'src',
        'skills',
        'bundled',
        'review',
      ),
      kind: 'skill',
    },
  ];
  const files = [];
  // `listed` is true when the parent walk saw this path as a directory a
  // moment ago: if it cannot be listed now, the tree changed underneath the
  // walk and the measurement is incomplete, where a root that was never there
  // has simply nothing to say.
  const walk = (dir, kind, listed) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // `readdirSync` failing says only "this path did not list" — the reason
      // decides everything, and `statSync` states it directly, where inferring
      // "this is a file" from `ENOTDIR` assumes every platform's libuv maps
      // the case the same way, and a one-sided divergence would drop
      // `review.ts` from one digest and not the other — a bundle that is
      // byte-for-byte correct warning on every review, forever, on that
      // platform alone. A directory that could not be listed (EACCES, or
      // vanished after the parent listed it) throws instead of being skipped:
      // a digest over the survivors would be stamped as the truth, and every
      // review from then on would report stale against it.
      let stats;
      try {
        stats = fs.statSync(dir);
      } catch (error) {
        if (listed) {
          throw new Error(`${dir} vanished while being walked`);
        }
        // A root that was never there is silent only on ENOENT — EACCES/EPERM
        // is a tree that IS there but cannot be measured, and skipping it
        // would stamp a digest over the surviving roots, which the runtime
        // twin (`sourceFilesUnder` in stale-bundle.ts) marks incomplete: a
        // parity gap that would accuse a byte-for-byte correct bundle once
        // the tree becomes readable again.
        if (error?.code !== 'ENOENT') {
          throw new Error(`${dir} could not be measured`);
        }
        return;
      }
      if (stats.isDirectory()) {
        throw new Error(`${dir} could not be listed`);
      }
      if (stats.isFile() && isDigestedFile(kind, basename(dir))) {
        files.push(dir);
      }
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (kind !== 'code' || !NOT_BUNDLED_DIR.has(e.name))
          walk(full, kind, true);
      } else if (e.isFile() && isDigestedFile(kind, e.name)) {
        files.push(full);
      }
    }
  };
  for (const r of roots) walk(r.path, r.kind, false);
  if (files.length === 0)
    return { digest: undefined, count: 0, newest: undefined };
  const hash = createHash('sha256');
  let newest;
  for (const file of files.sort()) {
    const { mtimeMs } = fs.statSync(file);
    if (!newest || mtimeMs > newest.mtimeMs) newest = { file, mtimeMs };
    hash.update(relative(root, file).split(sep).join('/'));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return { digest: hash.digest('hex'), count: files.length, newest };
}

function stampReviewSourceDigest(root, distDir) {
  const stampPath = join(distDir, 'review-sources.sha256');
  // Every refusal below removes an existing stamp first. Leaving an older
  // stamp beside a newer bundle is a weaker form of the misdescription the
  // refusal exists to avoid, and `unmeasured` is the state each refusal means.
  const refuse = (why) => {
    try {
      fs.rmSync(stampPath, { recursive: true, force: true });
    } catch (error) {
      // `force` swallows only ENOENT; a permission or lock error on the old
      // stamp must not kill the bundle step after every asset is in place.
      // Leaving it is the lesser outcome: at worst a later "stale" notice
      // whose rebuild advice is still correct.
      console.warn(
        `Could not remove the stale source digest at ${stampPath}: ` +
          (error instanceof Error ? error.message : error),
      );
    }
    // `warn`, not `log`: the runtime message sends its reader back to this
    // build's output, and a refusal hidden among plain logs is not what they
    // are being sent to find.
    console.warn(why);
  };
  // Never fatal. This is the last step of the copier, so a file vanishing
  // mid-walk would fail the bundle after every asset was already in place —
  // and a missing stamp is only `unmeasured`, which the runtime check already
  // treats as an acceptable answer.
  let digest, count, newest;
  try {
    ({ digest, count, newest } = reviewSourceDigestForBuild(root));
  } catch (error) {
    refuse(
      `Could not read the review sources; skipped the source digest: ${
        error instanceof Error ? error.message : error
      }`,
    );
    return;
  }
  if (!digest) {
    refuse('No review sources found; skipped the source digest.');
    return;
  }
  // The digest describes the tree as the COPIER sees it, and the copier runs
  // after esbuild — so a source edited after the bundle was written, or this
  // script run on its own, would stamp a `cli.js` built from something else.
  // That is the only direction where silence is affirmatively wrong instead
  // of merely uninformative: every other gap here degrades to `unmeasured`.
  // Timestamps are the wrong tool for judging staleness and the right one for
  // judging whether this stamp can be honest at all, so refuse rather than
  // stamp. The anchor is the bundle's WRITE time, not the build's start:
  // esbuild reads the sources during the graph walk, before it writes, so an
  // edit landing while the build is in flight is older than this anchor,
  // passes the gate, and is what the copier digests — a stamp honest about
  // the tree and not about the bundle. That window is not covered here.
  const bundlePath = join(distDir, 'cli.js');
  let builtAt;
  try {
    builtAt = fs.statSync(bundlePath).mtimeMs;
  } catch {
    refuse('No bundle found to stamp; skipped the source digest.');
    return;
  }
  const newestSource = newest.mtimeMs;
  if (newestSource > builtAt) {
    refuse(
      `A review source is newer than ${bundlePath}; skipped the source digest ` +
        `rather than stamp a bundle it may not describe. Run \`npm run bundle\` ` +
        `to rebuild the bundle and the stamp together.`,
    );
    return;
  }
  try {
    fs.writeFileSync(stampPath, digest);
  } catch (error) {
    refuse(
      `Could not write the source digest; skipped the stamp: ${
        error instanceof Error ? error.message : error
      }`,
    );
    return;
  }
  console.log(`Stamped the review source digest over ${count} files.`);
}

/**
 * OpenTUI renderer runtime assets (tree-sitter grammars, the parser worker,
 * `web-tree-sitter` runtime and the native render library) relocated next to
 * the bundle.
 *
 * In the esbuild single-file bundle @opentui/core's package-relative asset
 * fallback (`new URL('./assets/…', import.meta.url)`) points into `dist/`
 * and misses, so code-block syntax highlighting degrades to single color.
 * The runtime (`packages/cli/src/ui/opentui/opentui-assets.ts`) therefore
 * points `OTUI_ASSET_ROOT` at `dist/opentui-assets/` — but only when the tree
 * there is complete, because @opentui/core throws on any missing key under a
 * configured root (including the native library). This copier writes the
 * assets under exactly the keys that module checks:
 *
 *   opentui-assets/@opentui/core/parser.worker.js
 *   opentui-assets/@opentui/core/assets/<lang>/<file>
 *   opentui-assets/@opentui/core-<platform>-<arch>[ -musl]/libopentui.*
 *   opentui-assets/web-tree-sitter/tree-sitter.wasm
 *
 * Returns the list of destination-relative keys copied (empty on skip) so
 * callers/tests can assert on it. Never fails the bundle: a missing
 * @opentui/core (e.g. an install without the renderer) only warns.
 */
export function copyOpenTuiAssets({ root = defaultRoot, distDir } = {}) {
  distDir ??= join(root, 'dist');
  const destRoot = join(distDir, 'opentui-assets');
  // Start from a clean tree: the runtime gate below checks key existence
  // only, so a tree left by an earlier bundle would still satisfy it and
  // ship stale native libraries after the installed platform set changed.
  fs.rmSync(destRoot, { recursive: true, force: true });

  // @opentui/core may sit in the root node_modules or be hoisted into
  // packages/cli/node_modules (it is a cli dependency); try both anchors.
  const anchors = [
    join(root, 'package.json'),
    join(root, 'packages', 'cli', 'package.json'),
  ];
  let coreEntry;
  for (const anchor of anchors) {
    if (!existsSync(anchor)) continue;
    try {
      coreEntry = createRequire(anchor).resolve('@opentui/core');
      break;
    } catch {
      // try the next anchor
    }
  }
  if (!coreEntry) {
    console.warn(
      'Warning: @opentui/core is not resolvable; skipped OpenTUI assets',
    );
    return [];
  }
  const coreDir = dirname(coreEntry);
  const coreRequire = createRequire(join(coreDir, 'package.json'));

  const copied = [];
  const copyToKey = (source, key) => {
    if (!existsSync(source) || !statSync(source).isFile()) {
      console.warn(`Warning: OpenTUI asset missing at ${source}; skipped`);
      return;
    }
    const destPath = join(destRoot, key);
    mkdirSync(dirname(destPath), { recursive: true });
    copyFileSync(source, destPath);
    copied.push(key);
  };

  // 1. The tree-sitter parser worker (self-contained bundle).
  copyToKey(
    join(coreDir, 'parser.worker.js'),
    '@opentui/core/parser.worker.js',
  );

  // 2. Grammar assets: assets/<lang>/{highlights.scm,injections.scm,*.wasm}.
  const assetsDir = join(coreDir, 'assets');
  if (existsSync(assetsDir)) {
    for (const lang of fs.readdirSync(assetsDir)) {
      const langDir = join(assetsDir, lang);
      if (!statSync(langDir).isDirectory()) continue;
      for (const file of fs.readdirSync(langDir)) {
        copyToKey(join(langDir, file), `@opentui/core/assets/${lang}/${file}`);
      }
    }
  } else {
    console.warn(`Warning: OpenTUI grammar assets not found at ${assetsDir}`);
  }

  // 3. The web-tree-sitter runtime wasm (peer dependency of @opentui/core).
  let wasmSource;
  try {
    wasmSource = coreRequire.resolve('web-tree-sitter/tree-sitter.wasm');
  } catch {
    try {
      wasmSource = join(
        dirname(coreRequire.resolve('web-tree-sitter')),
        'tree-sitter.wasm',
      );
    } catch {
      wasmSource = undefined;
    }
  }
  if (wasmSource) {
    copyToKey(wasmSource, 'web-tree-sitter/tree-sitter.wasm');
  } else {
    console.warn(
      'Warning: web-tree-sitter is not resolvable; skipped its wasm asset',
    );
  }

  // 4. Native render libraries for every installed @opentui platform package
  //    (core-darwin-arm64, core-linux-x64-musl, …). The runtime only needs
  //    the current platform's, but shipping the installed set keeps the
  //    completeness check satisfiable wherever the bundle runs next. The
  //    platform packages live beside @opentui/core or hoisted at the repo
  //    root; scan both scope directories.
  const scopeDirs = [dirname(coreDir), join(root, 'node_modules', '@opentui')];
  const seenPackages = new Set();
  for (const scopeDir of scopeDirs) {
    if (!existsSync(scopeDir)) continue;
    for (const entry of fs.readdirSync(scopeDir)) {
      if (!entry.startsWith('core-') || seenPackages.has(entry)) continue;
      const packageDir = join(scopeDir, entry);
      if (!statSync(packageDir).isDirectory()) continue;
      let copiedFromPackage = false;
      for (const file of fs.readdirSync(packageDir)) {
        if (!/\.(dylib|so|dll)$/.test(file)) continue;
        copyToKey(join(packageDir, file), `@opentui/${entry}/${file}`);
        copiedFromPackage = true;
      }
      if (copiedFromPackage) seenPackages.add(entry);
    }
  }

  if (copied.length > 0) {
    console.log(
      `Copied ${copied.length} OpenTUI runtime assets to dist/opentui-assets/`,
    );
  } else {
    console.warn('Warning: no OpenTUI runtime assets were copied');
  }
  return copied;
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
      // DESIGN.md files are maintainer design narratives, not runtime inputs;
      // shipping one would hand a review a ~125 KB read_file target that
      // outweighs the context the slimmed skill saves.
      skipEntry: (entry) =>
        isBundledSkillTestFile(entry) || entry === 'DESIGN.md',
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

  // Copy the OpenTUI renderer's runtime assets (tree-sitter grammars, parser
  // worker, web-tree-sitter wasm, native render library) so the bundled
  // renderer can point OTUI_ASSET_ROOT at dist/opentui-assets/ and keep
  // code-block syntax highlighting. Warn-and-skip when unavailable.
  copyOpenTuiAssets({ root, distDir });

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

  // Make dist/cli.js directly executable: shellContextEnv blanks a
  // QWEN_CODE_CLI whose entry a POSIX shell cannot exec (no shebang, or no
  // execute bit), and the `"${QWEN_CODE_CLI:-qwen}"` fallback then silently
  // runs whatever `qwen` the PATH resolves — a different install for every
  // `review` subcommand of a session launched from this bundle. Measured on
  // three live `review run`s: every agent-issued subcommand ran the machine's
  // global install instead of the freshly bundled tree.
  const cliEntry = join(distDir, 'cli.js');
  if (existsSync(cliEntry)) {
    const source = readFileSync(cliEntry, 'utf8');
    if (!source.startsWith('#!')) {
      // Preserve the bundle's write time across the rewrite. The digest stamp
      // above reads this mtime as "when the bundle was built", and a bumped
      // one certifies a bundle as newer than review sources edited before it
      // — the staleness warning the skill's Step 0 stops on then never fires.
      // (Only a standalone run of this script is exposed, since a full bundle
      // stamps before reaching here, but that is a flow the gate contemplates.)
      const { atime, mtime } = statSync(cliEntry);
      writeFileSync(cliEntry, `#!/usr/bin/env node\n${source}`);
      fs.utimesSync(cliEntry, atime, mtime);
    }
    // chmod does not touch mtime, so it stays outside the guard: a bundle
    // that already carries a shebang may still arrive without the exec bit.
    fs.chmodSync(cliEntry, 0o755);
  }

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
