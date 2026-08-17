/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  existsSync,
  mkdirSync,
  utimesSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import {
  copyBundleAssets,
  reviewSourceDigestForBuild,
} from '../copy_bundle_assets.js';
import { copyFiles } from '../copy_files.js';
import { preparePackage } from '../prepare-package.js';

const realReadFileSync = fs.readFileSync;
const realReaddirSync = fs.readdirSync;
const realStatSync = fs.statSync;
const realRmSync = fs.rmSync;

describe('package asset scripts', () => {
  const tempDirs = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const tempDir of tempDirs.splice(0)) {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it('emits an executable dist/cli.js — shebang plus the exec bit, once', () => {
    // shellContextEnv blanks a QWEN_CODE_CLI a POSIX shell cannot exec (no
    // shebang, or no exec bit), and `"${QWEN_CODE_CLI:-qwen}"` then silently
    // runs whatever `qwen` the PATH resolves — a different install for every
    // review subcommand of a session launched off the bundle (measured on
    // three live runs). Deleting the block, dropping the chmod, or dropping
    // the already-has-a-shebang guard must not stay green.
    const rootDir = createFixtureRoot();
    writeFile(rootDir, 'dist/cli.js', 'console.log("bundle");\n');
    const cliEntry = path.join(rootDir, 'dist', 'cli.js');
    // A build time in the past, so the rewrite's own clock cannot coincide
    // with it: the digest stamp reads this mtime as "when the bundle was
    // built", and a rewrite that bumps it certifies a bundle as newer than
    // review sources edited before it — the staleness warning then never
    // fires and a review silently measures the old behaviour.
    const builtAt = new Date(Date.now() - 60_000);
    utimesSync(cliEntry, builtAt, builtAt);
    // Read back what the filesystem actually recorded. Comparing against the
    // `Date` handed to `utimesSync` would re-pin libuv's double-seconds →
    // `timespec` truncation (about half of all millisecond values land 1 ns
    // low), which is not the invariant under test — only whether the rewrite
    // moves the time the filesystem holds.
    const builtMs = fs.statSync(cliEntry).mtimeMs;
    stubConsole();

    copyBundleAssets({ root: rootDir });

    const once = readFileSync(cliEntry, 'utf8');
    expect(once.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(once).toContain('console.log("bundle");');
    expect(fs.statSync(cliEntry).mtimeMs).toBe(builtMs);
    if (process.platform !== 'win32') {
      // Windows has no POSIX exec bit for chmod to set; the shebang half
      // still holds there.
      expect(fs.statSync(cliEntry).mode & 0o777).toBe(0o755);
    }

    // Re-running the bundle step must not stack a second shebang — and must
    // still set the exec bit on a file that already carries one (an entry
    // arriving with a shebang but mode 0644 is exactly the shape that blanks
    // QWEN_CODE_CLI; demoting the chmod inside the shebang guard must fail).
    if (process.platform !== 'win32') {
      fs.chmodSync(cliEntry, 0o644);
    }
    copyBundleAssets({ root: rootDir });
    expect(readFileSync(cliEntry, 'utf8')).toBe(once);
    if (process.platform !== 'win32') {
      expect(fs.statSync(cliEntry).mode & 0o777).toBe(0o755);
    }
  });

  it('stamps the review source digest into dist', () => {
    // Nothing gated this call site: removing it left the whole scripts suite
    // green while `npm run bundle` silently stopped writing the stamp — and a
    // missing stamp is `unmeasured`, so the staleness warning would never fire
    // again with nothing in CI to notice.
    const rootDir = createFixtureRoot();
    writeFile(
      rootDir,
      'packages/cli/src/commands/review/drive.ts',
      'export const drive = 1;\n',
    );
    writeFile(rootDir, 'packages/cli/src/commands/review.ts', 'registers\n');
    // The stamp attests to a bundle, so there has to be one, and it has to be
    // at least as new as the sources it claims to describe.
    writeFile(rootDir, 'dist/cli.js', 'the bundle\n');
    // Force the boundary itself: the refusal is the strict
    // `newestSource > builtAt`, so EQUAL mtimes must still stamp. Without a
    // forced equality, whether a `>=` mutant fails depends on the runner's
    // clock granularity — the non-determinism this removes.
    const builtAt = new Date();
    for (const rel of [
      'packages/cli/src/commands/review/drive.ts',
      'packages/cli/src/commands/review.ts',
      'dist/cli.js',
    ]) {
      utimesSync(path.join(rootDir, rel), builtAt, builtAt);
    }
    stubConsole();

    copyBundleAssets({ root: rootDir });

    const stamped = readFileSync(
      path.join(rootDir, 'dist', 'review-sources.sha256'),
      'utf8',
    );
    expect(stamped).toBe(reviewSourceDigestForBuild(rootDir).digest);
    expect(stamped).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses to stamp a bundle older than the sources it would describe', () => {
    // The copier runs after esbuild, so a source edited in between — or this
    // script run on its own — would certify a `cli.js` built from something
    // else. That is the one direction where a silent check is affirmatively
    // wrong rather than uninformative.
    const rootDir = createFixtureRoot();
    writeFile(rootDir, 'dist/cli.js', 'the bundle\n');
    writeFile(
      rootDir,
      'packages/cli/src/commands/review/drive.ts',
      'export const drive = 1;\n',
    );
    const later = new Date(Date.now() + 3_600_000);
    utimesSync(
      path.join(rootDir, 'packages/cli/src/commands/review/drive.ts'),
      later,
      later,
    );
    stubConsole();

    copyBundleAssets({ root: rootDir });

    expect(
      existsSync(path.join(rootDir, 'dist', 'review-sources.sha256')),
    ).toBe(false);
    // `refuse()` warns because the runtime notice sends its reader back to
    // this build's output; deleting the warn kept this whole suite green.
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('newer than'),
    );
  });

  it('removes an older stamp when it refuses to write a new one', () => {
    // Leaving a previous attestation beside a newer bundle is a weaker form of
    // the certifying the refusal exists to avoid.
    const rootDir = createFixtureRoot();
    writeFile(rootDir, 'dist/cli.js', 'the bundle\n');
    writeFile(rootDir, 'dist/review-sources.sha256', 'a'.repeat(64));
    writeFile(
      rootDir,
      'packages/cli/src/commands/review/drive.ts',
      'export const drive = 1;\n',
    );
    const later = new Date(Date.now() + 3_600_000);
    utimesSync(
      path.join(rootDir, 'packages/cli/src/commands/review/drive.ts'),
      later,
      later,
    );
    stubConsole();

    copyBundleAssets({ root: rootDir });

    expect(
      existsSync(path.join(rootDir, 'dist', 'review-sources.sha256')),
    ).toBe(false);
  });

  it('keeps refusing by name when the old stamp cannot be removed', () => {
    // `force` swallows only ENOENT; a permission or lock error on the old
    // stamp (an antivirus holding a just-written file, a stamp owned by
    // another user on a shared volume) must not turn the named refusal into
    // an unhandled crash after every asset is already in place. Leaving the
    // unremovable stamp is the lesser outcome: at worst a later "stale"
    // notice whose rebuild advice is still correct.
    const rootDir = createFixtureRoot();
    writeFile(rootDir, 'dist/cli.js', 'the bundle\n');
    writeFile(rootDir, 'dist/review-sources.sha256', 'a'.repeat(64));
    writeFile(
      rootDir,
      'packages/cli/src/commands/review/drive.ts',
      'export const drive = 1;\n',
    );
    const later = new Date(Date.now() + 3_600_000);
    utimesSync(
      path.join(rootDir, 'packages/cli/src/commands/review/drive.ts'),
      later,
      later,
    );
    stubConsole();
    const stampPath = path.join(rootDir, 'dist', 'review-sources.sha256');
    vi.spyOn(fs, 'rmSync').mockImplementation((target, ...rest) => {
      if (String(target) === stampPath) {
        throw Object.assign(new Error('EACCES: permission denied'), {
          code: 'EACCES',
        });
      }
      return realRmSync(target, ...rest);
    });

    expect(() => copyBundleAssets({ root: rootDir })).not.toThrow();
    expect(existsSync(stampPath)).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not remove the stale source digest'),
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('newer than'),
    );
  });

  it('does not stamp a tree with no review sources', () => {
    // The zero-files branch of the digest: with nothing to hash there is no
    // digest to attest. The stamping cases pin the other side of the guard —
    // that a tree WITH sources is stamped — and this pins the side that
    // fires, so a guard that never fired would certify the empty-set digest
    // of a bundle nothing digested was built from.
    const rootDir = createFixtureRoot();
    writeFile(rootDir, 'dist/cli.js', 'the bundle\n');
    // Every refusal removes an existing stamp first; pre-seed one to pin that.
    writeFile(rootDir, 'dist/review-sources.sha256', 'a'.repeat(64));
    stubConsole();

    copyBundleAssets({ root: rootDir });

    expect(reviewSourceDigestForBuild(rootDir).digest).toBeUndefined();
    expect(
      existsSync(path.join(rootDir, 'dist', 'review-sources.sha256')),
    ).toBe(false);
  });

  it('refuses by the newest source, not the last one walked', () => {
    // `newest` must track the largest mtimeMs. The newest file sits in the
    // MIDDLE of the sort order, where both a keep-first and a keep-last
    // comparison miss it; either would see only an older file and certify a
    // bundle the newest source may not describe.
    const rootDir = createFixtureRoot();
    writeFile(rootDir, 'dist/cli.js', 'the bundle\n');
    for (const name of ['a-older.ts', 'm-newest.ts', 'z-older.ts']) {
      writeFile(
        rootDir,
        `packages/cli/src/commands/review/${name}`,
        `export const ${name[0]} = 1;\n`,
      );
    }
    const earlier = new Date(Date.now() - 3_600_000);
    for (const name of ['a-older.ts', 'z-older.ts']) {
      utimesSync(
        path.join(rootDir, 'packages/cli/src/commands/review', name),
        earlier,
        earlier,
      );
    }
    const later = new Date(Date.now() + 3_600_000);
    utimesSync(
      path.join(rootDir, 'packages/cli/src/commands/review/m-newest.ts'),
      later,
      later,
    );
    // The field directly, not only its consequence: keep-first and keep-last
    // mutants stamp by an older file here — the no-stamp assertion below is
    // what catches them. The complementary class tracks the right mtime but
    // attributes it to the wrong path: it still refuses, by the wrong file,
    // and only this field assertion catches it.
    expect(reviewSourceDigestForBuild(rootDir).newest?.file).toBe(
      path.join(rootDir, 'packages/cli/src/commands/review/m-newest.ts'),
    );
    stubConsole();

    copyBundleAssets({ root: rootDir });

    expect(
      existsSync(path.join(rootDir, 'dist', 'review-sources.sha256')),
    ).toBe(false);
  });

  it('does not fail the bundle when the review sources cannot be read', () => {
    // The stamp is the copier's last step, so throwing here would fail a build
    // whose every asset is already in place. A missing stamp is `unmeasured`,
    // which the runtime check already accepts.
    const rootDir = createFixtureRoot();
    writeFile(
      rootDir,
      'packages/cli/src/commands/review/drive.ts',
      'export const drive = 1;\n',
    );
    // The bundle LAST, so the sources are strictly older: the stamp's absence
    // is then attributable only to the error refusal, where a bundle written
    // first lets the mtime gate mask a skip-and-continue mutant.
    writeFile(rootDir, 'dist/cli.js', 'the bundle\n');
    // Every refusal removes an existing stamp first; pre-seed one to pin that.
    writeFile(rootDir, 'dist/review-sources.sha256', 'a'.repeat(64));
    stubConsole();
    // The file vanishes between the walk that listed it and the read that
    // hashes it — a concurrent checkout, mid-build.
    vi.spyOn(fs, 'readFileSync').mockImplementation((target, ...rest) => {
      if (String(target).endsWith('drive.ts')) {
        throw Object.assign(new Error('ENOENT: vanished mid-build'), {
          code: 'ENOENT',
        });
      }
      return realReadFileSync(target, ...rest);
    });

    expect(() => copyBundleAssets({ root: rootDir })).not.toThrow();
    expect(
      existsSync(path.join(rootDir, 'dist', 'review-sources.sha256')),
    ).toBe(false);
  });

  it('does not fail the bundle when a source directory cannot be listed', () => {
    // The directory-level twin of the case above: the walk throws instead of
    // silently hashing the survivors, and the refusal must stay a refusal —
    // never a failed bundle with every asset already in place.
    const rootDir = createFixtureRoot();
    writeFile(
      rootDir,
      'packages/cli/src/commands/review/drive.ts',
      'export const drive = 1;\n',
    );
    writeFile(
      rootDir,
      'packages/cli/src/commands/review/lib/ledger.ts',
      'export const ledger = 1;\n',
    );
    // The bundle LAST, so the stamp's absence is attributable only to the
    // error refusal, not the mtime gate (see the unreadable-file twin).
    writeFile(rootDir, 'dist/cli.js', 'the bundle\n');
    // Every refusal removes an existing stamp first; pre-seed one to pin that.
    writeFile(rootDir, 'dist/review-sources.sha256', 'a'.repeat(64));
    stubConsole();
    const libDir = path.join(rootDir, 'packages/cli/src/commands/review/lib');
    vi.spyOn(fs, 'readdirSync').mockImplementation((target, ...rest) => {
      if (String(target) === libDir) {
        throw Object.assign(new Error('EACCES: permission denied'), {
          code: 'EACCES',
        });
      }
      return realReaddirSync(target, ...rest);
    });

    expect(() => copyBundleAssets({ root: rootDir })).not.toThrow();
    expect(
      existsSync(path.join(rootDir, 'dist', 'review-sources.sha256')),
    ).toBe(false);
  });

  it('does not fail the bundle when a directory vanishes mid-walk', () => {
    // The parent walk listed this as a directory a moment ago; now both the
    // listing and the stat fail. Skipping it would stamp a digest over the
    // survivors, and every review after the tree settles would report stale
    // against a byte-correct bundle — so the walk refuses instead, and the
    // refusal must stay never-fatal.
    const rootDir = createFixtureRoot();
    writeFile(
      rootDir,
      'packages/cli/src/commands/review/drive.ts',
      'export const drive = 1;\n',
    );
    writeFile(
      rootDir,
      'packages/cli/src/commands/review/lib/ledger.ts',
      'export const ledger = 1;\n',
    );
    // The bundle LAST so the mtime gate cannot mask a skip-and-continue
    // mutant digesting the survivors.
    writeFile(rootDir, 'dist/cli.js', 'the bundle\n');
    // Every refusal removes an existing stamp first; pre-seed one to pin that.
    writeFile(rootDir, 'dist/review-sources.sha256', 'a'.repeat(64));
    stubConsole();
    const libDir = path.join(rootDir, 'packages/cli/src/commands/review/lib');
    const vanished = Object.assign(new Error('ENOENT: vanished mid-build'), {
      code: 'ENOENT',
    });
    vi.spyOn(fs, 'readdirSync').mockImplementation((target, ...rest) => {
      if (String(target) === libDir) throw vanished;
      return realReaddirSync(target, ...rest);
    });
    vi.spyOn(fs, 'statSync').mockImplementation((target, ...rest) => {
      if (String(target) === libDir) throw vanished;
      return realStatSync(target, ...rest);
    });

    expect(() => copyBundleAssets({ root: rootDir })).not.toThrow();
    expect(
      existsSync(path.join(rootDir, 'dist', 'review-sources.sha256')),
    ).toBe(false);
  });

  it('does not fail the bundle when a digest root cannot be measured', () => {
    // Root-level twin of the unlistable-directory case, for the failure the
    // `listed` flag cannot cover: both the listing and the stat fail with a
    // non-ENOENT error (an ancestor transiently without search permission).
    // Skipping the root would stamp a digest over the surviving roots — the
    // runtime twin (`sourceFilesUnder`) marks the same case incomplete, so a
    // skip here is a parity gap that would accuse a byte-for-byte correct
    // bundle once the tree becomes readable again. `review.ts` is the
    // survivor OUTSIDE the failing root: without it a skip mutant finds one
    // file fewer and the partial digest is harder to tell from a refusal.
    const rootDir = createFixtureRoot();
    writeFile(
      rootDir,
      'packages/cli/src/commands/review/drive.ts',
      'export const drive = 1;\n',
    );
    writeFile(rootDir, 'packages/cli/src/commands/review.ts', 'registers\n');
    writeFile(rootDir, 'dist/cli.js', 'the bundle\n');
    // Every refusal removes an existing stamp first; pre-seed one to pin that.
    writeFile(rootDir, 'dist/review-sources.sha256', 'a'.repeat(64));
    stubConsole();
    const reviewDir = path.join(rootDir, 'packages/cli/src/commands/review');
    const denied = Object.assign(new Error('EACCES: permission denied'), {
      code: 'EACCES',
    });
    vi.spyOn(fs, 'readdirSync').mockImplementation((target, ...rest) => {
      if (String(target) === reviewDir) throw denied;
      return realReaddirSync(target, ...rest);
    });
    vi.spyOn(fs, 'statSync').mockImplementation((target, ...rest) => {
      if (String(target) === reviewDir) throw denied;
      return realStatSync(target, ...rest);
    });

    expect(() => copyBundleAssets({ root: rootDir })).not.toThrow();
    expect(
      existsSync(path.join(rootDir, 'dist', 'review-sources.sha256')),
    ).toBe(false);
  });

  it('does not stamp when there is no bundle to attest', () => {
    // The stamp attests to a bundle; without `dist/cli.js` there is nothing
    // to attest. An orphan digest beside a later-built bundle would report
    // stale against sources that bundle may describe perfectly, instead of
    // the honest 'could not check'.
    const rootDir = createFixtureRoot();
    writeFile(
      rootDir,
      'packages/cli/src/commands/review/drive.ts',
      'export const drive = 1;\n',
    );
    // Every refusal removes an existing stamp first; pre-seed one to pin that.
    writeFile(rootDir, 'dist/review-sources.sha256', 'a'.repeat(64));
    stubConsole();

    expect(() => copyBundleAssets({ root: rootDir })).not.toThrow();
    expect(
      existsSync(path.join(rootDir, 'dist', 'review-sources.sha256')),
    ).toBe(false);
  });

  it('does not fail the bundle when the stamp cannot be written', () => {
    // The final write sits under the same never-fatal contract as the digest
    // walk: a stray directory occupying the stamp path makes writeFileSync
    // throw EISDIR after every asset is already in place.
    const rootDir = createFixtureRoot();
    writeFile(
      rootDir,
      'packages/cli/src/commands/review/drive.ts',
      'export const drive = 1;\n',
    );
    writeFile(rootDir, 'dist/cli.js', 'the bundle\n');
    mkdirSync(path.join(rootDir, 'dist', 'review-sources.sha256'), {
      recursive: true,
    });
    stubConsole();

    expect(() => copyBundleAssets({ root: rootDir })).not.toThrow();
    expect(
      existsSync(path.join(rootDir, 'dist', 'review-sources.sha256')),
    ).toBe(false);
  });

  // chmod is the only lever this case has: on Windows it is a no-op, and a
  // root user reads through it, so the branch under test is unreachable
  // there. The case skips rather than running into the other branch — a
  // readable tree, stamped as usual — and failing red against the no-stamp
  // assertion.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses when a digest root exists but cannot be listed',
    () => {
      // The root-level arm of the unlistable-directory refusal: with the
      // ROOT itself unreadable, skipping it would stamp a partial digest as
      // the truth, and every review after the tree becomes readable would
      // report stale against a bundle the full sources do not describe.
      // `review.ts` is the survivor OUTSIDE the unreadable root: without it
      // a skip-and-continue mutant finds zero files, refuses for the
      // no-sources reason, and passes this test anyway.
      const rootDir = createFixtureRoot();
      writeFile(
        rootDir,
        'packages/cli/src/commands/review/drive.ts',
        'export const drive = 1;\n',
      );
      writeFile(rootDir, 'packages/cli/src/commands/review.ts', 'registers\n');
      writeFile(rootDir, 'dist/cli.js', 'the bundle\n');
      // Every refusal removes an existing stamp first; pre-seed one to pin that.
      writeFile(rootDir, 'dist/review-sources.sha256', 'a'.repeat(64));
      const reviewDir = path.join(rootDir, 'packages/cli/src/commands/review');
      stubConsole();
      fs.chmodSync(reviewDir, 0o000);
      try {
        expect(() => copyBundleAssets({ root: rootDir })).not.toThrow();
        expect(
          existsSync(path.join(rootDir, 'dist', 'review-sources.sha256')),
        ).toBe(false);
      } finally {
        fs.chmodSync(reviewDir, 0o755);
      }
    },
  );

  it('copies extension examples into the bundled runtime dist', () => {
    const rootDir = createFixtureRoot();
    writeFile(
      rootDir,
      'packages/cli/src/commands/extensions/examples/mcp-server/keep.test.js',
      'console.log("example test fixture");\n',
    );
    stubConsole();

    copyBundleAssets({ root: rootDir });

    expect(readdirSync(path.join(rootDir, 'dist', 'examples')).sort()).toEqual([
      'agent',
      'commands',
      'context',
      'mcp-server',
      'skills',
    ]);
    expect(
      existsSync(
        path.join(rootDir, 'dist', 'examples', 'mcp-server', 'package.json'),
      ),
    ).toBe(true);
    expect(
      existsSync(
        path.join(rootDir, 'dist', 'examples', 'mcp-server', 'keep.test.js'),
      ),
    ).toBe(true);
  });

  it('copies bundled skill scripts and references into the runtime dist', () => {
    const rootDir = createFixtureRoot();
    writeFile(
      rootDir,
      'packages/core/src/skills/bundled/dataviz/SKILL.md',
      '---\nname: dataviz\ndescription: Chart guidance\n---\nBody\n',
    );
    writeFile(
      rootDir,
      'packages/core/src/skills/bundled/dataviz/scripts/validate_palette.js',
      'console.log("ok");\n',
    );
    writeFile(
      rootDir,
      'packages/core/src/skills/bundled/dataviz/scripts/validate_palette.test.js',
      'import { it } from "vitest";\n',
    );
    writeFile(
      rootDir,
      'packages/core/src/skills/bundled/dataviz/scripts/validate_palette.test.d.ts',
      'export {};\n',
    );
    writeFile(
      rootDir,
      'packages/core/src/skills/bundled/dataviz/scripts/validate_palette.test.js.map',
      '{}\n',
    );
    writeFile(
      rootDir,
      'packages/core/src/skills/bundled/dataviz/scripts/chart.spec.tsx',
      'export {};\n',
    );
    writeFile(
      rootDir,
      'packages/core/src/skills/bundled/dataviz/scripts/font-test-regular.woff2',
      'font\n',
    );
    writeFile(
      rootDir,
      'packages/core/src/skills/bundled/dataviz/references/palette.md',
      '# Palette\n',
    );
    writeFile(
      rootDir,
      'packages/core/src/skills/bundled/dataviz/DESIGN.md',
      '# Design notes\n',
    );
    writeFile(rootDir, 'dist/bundled/dataviz/scripts/stale.test.js', 'stale\n');
    writeFile(
      rootDir,
      'packages/core/src/skills/bundled/dataviz/.DS_Store',
      'finder droppings\n',
    );
    stubConsole();

    copyBundleAssets({ root: rootDir });

    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'bundled',
          'dataviz',
          'scripts',
          'validate_palette.js',
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'bundled',
          'dataviz',
          'scripts',
          'validate_palette.test.js',
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'bundled',
          'dataviz',
          'scripts',
          'validate_palette.test.d.ts',
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'bundled',
          'dataviz',
          'scripts',
          'validate_palette.test.js.map',
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'bundled',
          'dataviz',
          'scripts',
          'chart.spec.tsx',
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'bundled',
          'dataviz',
          'scripts',
          'stale.test.js',
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'bundled',
          'dataviz',
          'scripts',
          'font-test-regular.woff2',
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'bundled',
          'dataviz',
          'references',
          'palette.md',
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(path.join(rootDir, 'dist', 'bundled', 'dataviz', 'DESIGN.md')),
    ).toBe(false);
    // The copier's `.DS_Store` skip, pinned by the copier's own output: the
    // boundary test in review-source-digest models the skip, so only this
    // execution catches a copier that lost it.
    expect(
      existsSync(path.join(rootDir, 'dist', 'bundled', 'dataviz', '.DS_Store')),
    ).toBe(false);
  });

  it('keeps bundled-skill DESIGN.md out of the per-package dist/src copy', () => {
    const rootDir = createFixtureRoot();
    writeFile(
      rootDir,
      'packages/core/src/skills/bundled/review/SKILL.md',
      '---\nname: review\ndescription: Review changes\n---\nBody\n',
    );
    writeFile(
      rootDir,
      'packages/core/src/skills/bundled/review/DESIGN.md',
      '# Design notes\n',
    );
    writeFile(rootDir, 'packages/core/src/notes/DESIGN.md', '# Keep\n');
    stubConsole();

    copyFiles({ root: path.join(rootDir, 'packages', 'core') });

    const distSrc = path.join(rootDir, 'packages', 'core', 'dist', 'src');
    expect(
      existsSync(path.join(distSrc, 'skills', 'bundled', 'review', 'SKILL.md')),
    ).toBe(true);
    expect(
      existsSync(
        path.join(distSrc, 'skills', 'bundled', 'review', 'DESIGN.md'),
      ),
    ).toBe(false);
    expect(existsSync(path.join(distSrc, 'notes', 'DESIGN.md'))).toBe(true);
  });

  it('includes extension examples in the prepared dist package', () => {
    const rootDir = createFixtureRoot();
    createBundleArtifacts(rootDir);
    stubConsole();

    preparePackage({ rootDir, requireNativeAudioCapture: false });

    const distPackageJson = JSON.parse(
      readFileSync(path.join(rootDir, 'dist', 'package.json'), 'utf8'),
    );
    const rootPackageJson = JSON.parse(
      readFileSync(path.join(rootDir, 'package.json'), 'utf8'),
    );

    expect(distPackageJson.files).toContain('examples');
    expect(distPackageJson.bundledDependencies).toBeUndefined();
    expect(distPackageJson.optionalDependencies).toMatchObject({
      '@qwen-code/audio-capture': rootPackageJson.version,
    });

    expect(distPackageJson.optionalDependencies.sharp).toBe('0.35.4');
    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'node_modules',
          '@qwen-code',
          'audio-capture',
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        path.join(rootDir, 'dist', 'examples', 'mcp-server', 'package.json'),
      ),
    ).toBe(true);
  });

  it('falls back to the hoisted lockfile entry when core has no nested sharp', () => {
    const rootDir = createFixtureRoot();
    writeFile(
      rootDir,
      'package-lock.json',
      JSON.stringify({
        packages: {
          'node_modules/sharp': {
            version: '0.35.3',
          },
        },
      }),
    );
    writeFile(
      rootDir,
      'packages/core/package.json',
      JSON.stringify(
        {
          name: '@qwen-code/qwen-code-core',
          version: '0.17.0',
          dependencies: {
            sharp: '^0.35.0',
          },
        },
        null,
        2,
      ),
    );
    createBundleArtifacts(rootDir);
    stubConsole();

    preparePackage({ rootDir, requireNativeAudioCapture: false });

    const distPackageJson = JSON.parse(
      readFileSync(path.join(rootDir, 'dist', 'package.json'), 'utf8'),
    );
    expect(distPackageJson.optionalDependencies.sharp).toBe('0.35.3');
  });

  it('rejects a locked sharp version outside the core declaration', () => {
    const rootDir = createFixtureRoot();
    writeFile(
      rootDir,
      'packages/core/package.json',
      JSON.stringify({ dependencies: { sharp: '^0.34.0' } }),
    );
    createBundleArtifacts(rootDir);
    stubConsole();

    expect(() =>
      preparePackage({ rootDir, requireNativeAudioCapture: false }),
    ).toThrow(/resolved 0\.35\.4, packages\/core declares \^0\.34\.0/);
  });

  it('omits browser MCP install hooks and deps from the prepared dist package', () => {
    const rootDir = createFixtureRoot();
    createBundleArtifacts(rootDir);
    stubConsole();
    const browserMcpPackageName = ['chrome', 'devtools', 'mcp'].join('-');
    const browserAutomationPackageName = ['puppeteer', 'core'].join('-');
    const installScriptFile = ['postinstall', 'js'].join('.');
    const browserMcpPatchFile = `${browserMcpPackageName}+1.4.0.patch`;

    preparePackage({ rootDir, requireNativeAudioCapture: false });

    const distDir = path.join(rootDir, 'dist');
    const distPackageJson = JSON.parse(
      readFileSync(path.join(distDir, 'package.json'), 'utf8'),
    );

    expect(distPackageJson.files).not.toEqual(
      expect.arrayContaining(['patches', installScriptFile]),
    );
    expect(distPackageJson.scripts).toBeUndefined();
    expect(distPackageJson.dependencies).toEqual({});
    expect(distPackageJson.optionalDependencies).not.toHaveProperty(
      browserMcpPackageName,
    );
    expect(distPackageJson.optionalDependencies).not.toHaveProperty(
      browserAutomationPackageName,
    );
    expect(existsSync(path.join(distDir, installScriptFile))).toBe(false);
    expect(existsSync(path.join(distDir, 'patches'))).toBe(false);
    expect(existsSync(path.join(distDir, 'patches', browserMcpPatchFile))).toBe(
      false,
    );
  });

  it.each([
    ['dist/web-shell/assets/icon.svg', '<svg>chrome-devtools-mcp</svg>\n'],
    ['dist/chunks/server.js.map', '{"sources":["Chrome-Devtools-MCP"]}\n'],
  ])(
    'fails packaging when prepared dist contains scanner-sensitive literals in %s',
    (packagePath, contents) => {
      const rootDir = createFixtureRoot();
      createBundleArtifacts(rootDir);
      const browserMcpPackageName = ['chrome', 'devtools', 'mcp'].join('-');
      writeFile(rootDir, packagePath, contents);
      stubConsole();

      const expectedPath = path.relative(
        path.join(rootDir, 'dist'),
        path.join(rootDir, packagePath),
      );

      expect(() =>
        preparePackage({ rootDir, requireNativeAudioCapture: false }),
      ).toThrow(
        `Prepared package contains forbidden string "${browserMcpPackageName}" in ${expectedPath}`,
      );
    },
  );

  it('fails packaging when prepared dist exceeds the unpacked size budget', () => {
    const rootDir = createFixtureRoot();
    createBundleArtifacts(rootDir);
    stubConsole();

    preparePackage({
      rootDir,
      requireNativeAudioCapture: false,
      maxPackageUnpackedBytes: 50_000,
    });

    const oversizedRootDir = createFixtureRoot();
    createBundleArtifacts(oversizedRootDir);
    writeFile(oversizedRootDir, 'dist/chunks/large.js', 'x'.repeat(64 * 1024));

    expect(() =>
      preparePackage({
        rootDir: oversizedRootDir,
        requireNativeAudioCapture: false,
        maxPackageUnpackedBytes: 50_000,
      }),
    ).toThrow(/Prepared package unpacked size \d+ bytes exceeds 50000 bytes/);
  });

  it('enforces a 96 MiB default unpacked size budget', () => {
    const rootDir = createFixtureRoot();
    createBundleArtifacts(rootDir);
    writeFile(rootDir, 'dist/chunks/large.bin', '');
    const largeFile = path.join(rootDir, 'dist', 'chunks', 'large.bin');
    truncateSync(largeFile, 95 * 1024 * 1024);
    stubConsole();

    expect(() =>
      preparePackage({
        rootDir,
        requireNativeAudioCapture: false,
      }),
    ).not.toThrow();

    truncateSync(largeFile, 96 * 1024 * 1024);

    expect(() =>
      preparePackage({
        rootDir,
        requireNativeAudioCapture: false,
      }),
    ).toThrow(
      /Prepared package unpacked size \d+ bytes exceeds 100663296 bytes/,
    );
  });

  it('omits bundledDependencies when audio-capture artifacts are missing', () => {
    const rootDir = createFixtureRoot();
    rmSync(path.join(rootDir, 'packages', 'audio-capture', 'prebuilds'), {
      recursive: true,
      force: true,
    });
    createBundleArtifacts(rootDir);
    stubConsole();

    preparePackage({ rootDir, requireNativeAudioCapture: false });

    const distPackageJson = JSON.parse(
      readFileSync(path.join(rootDir, 'dist', 'package.json'), 'utf8'),
    );
    expect(distPackageJson.bundledDependencies).toBeUndefined();
    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'node_modules',
          '@qwen-code',
          'audio-capture',
        ),
      ),
    ).toBe(false);
  });

  it('removes stale bundled audio-capture files when artifacts are missing', () => {
    const rootDir = createFixtureRoot();
    createBundleArtifacts(rootDir);
    writeFile(
      rootDir,
      'dist/node_modules/@qwen-code/audio-capture/prebuilds/darwin-arm64/@qwen-code+audio-capture.node',
      'stale native addon\n',
    );
    stubConsole();

    rmSync(path.join(rootDir, 'packages', 'audio-capture', 'prebuilds'), {
      recursive: true,
      force: true,
    });

    preparePackage({ rootDir, requireNativeAudioCapture: false });

    const distPackageJson = JSON.parse(
      readFileSync(path.join(rootDir, 'dist', 'package.json'), 'utf8'),
    );
    expect(distPackageJson.bundledDependencies).toBeUndefined();
    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'node_modules',
          '@qwen-code',
          'audio-capture',
        ),
      ),
    ).toBe(false);
  });

  it('fails packaging when required audio-capture artifacts are missing', () => {
    const rootDir = createFixtureRoot();
    rmSync(path.join(rootDir, 'packages', 'audio-capture', 'prebuilds'), {
      recursive: true,
      force: true,
    });
    createBundleArtifacts(rootDir);
    stubConsole();

    expect(() =>
      preparePackage({ rootDir, requireNativeAudioCapture: true }),
    ).toThrow(/Required audio capture package artifact not found at/);
  });

  it('fails packaging when required audio-capture runtime output is empty', () => {
    const rootDir = createFixtureRoot();
    rmSync(path.join(rootDir, 'packages', 'audio-capture', 'dist', 'index.js'));
    createBundleArtifacts(rootDir);
    stubConsole();

    expect(() =>
      preparePackage({ rootDir, requireNativeAudioCapture: true }),
    ).toThrow(/Required audio capture package artifact has no runtime JS/);
  });

  it('fails packaging when required audio-capture prebuilds are empty', () => {
    const rootDir = createFixtureRoot();
    rmSync(
      path.join(
        rootDir,
        'packages',
        'audio-capture',
        'prebuilds',
        'darwin-arm64',
        '@qwen-code+audio-capture.node',
      ),
    );
    createBundleArtifacts(rootDir);
    stubConsole();

    expect(() =>
      preparePackage({ rootDir, requireNativeAudioCapture: true }),
    ).toThrow(/Required audio capture package artifact has no native prebuild/);
  });

  it('omits bundledDependencies when audio-capture dependencies are missing and not required', () => {
    const rootDir = createFixtureRoot();
    const audioPackagePath = path.join(
      rootDir,
      'packages',
      'audio-capture',
      'package.json',
    );
    const audioPackageJson = JSON.parse(readFileSync(audioPackagePath, 'utf8'));
    audioPackageJson.dependencies['missing-audio-runtime'] = '1.0.0';
    writeFileSync(audioPackagePath, JSON.stringify(audioPackageJson, null, 2));
    createBundleArtifacts(rootDir);
    stubConsole();

    preparePackage({ rootDir, requireNativeAudioCapture: false });

    const distPackageJson = JSON.parse(
      readFileSync(path.join(rootDir, 'dist', 'package.json'), 'utf8'),
    );
    expect(distPackageJson.bundledDependencies).toBeUndefined();
    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'node_modules',
          '@qwen-code',
          'audio-capture',
        ),
      ),
    ).toBe(false);
  });

  it('fails packaging when required audio-capture dependencies are missing', () => {
    const rootDir = createFixtureRoot();
    const audioPackagePath = path.join(
      rootDir,
      'packages',
      'audio-capture',
      'package.json',
    );
    const audioPackageJson = JSON.parse(readFileSync(audioPackagePath, 'utf8'));
    audioPackageJson.dependencies['missing-audio-runtime'] = '1.0.0';
    writeFileSync(audioPackagePath, JSON.stringify(audioPackageJson, null, 2));
    createBundleArtifacts(rootDir);
    stubConsole();

    expect(() =>
      preparePackage({ rootDir, requireNativeAudioCapture: true }),
    ).toThrow(/Required audio capture dependency not resolvable/);
  });

  it('omits bundledDependencies when audio-capture package JSON is invalid and not required', () => {
    const rootDir = createFixtureRoot();
    writeFile(rootDir, 'packages/audio-capture/package.json', '{ invalid json');
    createBundleArtifacts(rootDir);
    stubConsole();

    preparePackage({ rootDir, requireNativeAudioCapture: false });

    const distPackageJson = JSON.parse(
      readFileSync(path.join(rootDir, 'dist', 'package.json'), 'utf8'),
    );
    expect(distPackageJson.bundledDependencies).toBeUndefined();
    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'node_modules',
          '@qwen-code',
          'audio-capture',
        ),
      ),
    ).toBe(false);
  });

  it('fails packaging when required audio-capture package JSON is invalid', () => {
    const rootDir = createFixtureRoot();
    writeFile(rootDir, 'packages/audio-capture/package.json', '{ invalid json');
    createBundleArtifacts(rootDir);
    stubConsole();

    expect(() =>
      preparePackage({ rootDir, requireNativeAudioCapture: true }),
    ).toThrow(/Required audio capture package\.json is not valid JSON/);
  });

  function createFixtureRoot() {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'qwen-package-assets-'));
    tempDirs.push(rootDir);

    writeFile(rootDir, 'README.md', '# Qwen Code\n');
    writeFile(rootDir, 'LICENSE', 'Apache-2.0\n');
    writeFile(
      rootDir,
      'package.json',
      JSON.stringify(
        {
          name: '@qwen-code/qwen-code',
          version: '0.17.0',
          description: 'Qwen Code',
          repository: {
            type: 'git',
            url: 'https://github.com/QwenLM/qwen-code.git',
          },
          config: {},
          engines: {
            node: '>=22.0.0',
          },
          devDependencies: {
            'patch-package': '^8.0.1',
          },
        },
        null,
        2,
      ),
    );

    writeFile(
      rootDir,
      'package-lock.json',
      JSON.stringify(
        {
          packages: {
            'node_modules/sharp': {
              version: '0.35.3',
            },
            'packages/core/node_modules/sharp': {
              version: '0.35.4',
            },
          },
        },
        null,
        2,
      ),
    );

    writeFile(
      rootDir,
      'packages/cli/src/i18n/locales/en.json',
      '{"hello":"world"}\n',
    );
    writeFile(
      rootDir,
      'packages/core/package.json',
      JSON.stringify(
        {
          name: '@qwen-code/qwen-code-core',
          version: '0.17.0',
          dependencies: {
            sharp: '^0.35.0',
          },
        },
        null,
        2,
      ),
    );
    writeFile(
      rootDir,
      'packages/audio-capture/package.json',
      JSON.stringify(
        {
          name: '@qwen-code/audio-capture',
          version: '0.17.0',
          type: 'module',
          main: 'dist/index.js',
          dependencies: {
            'node-gyp-build': '^4.8.4',
          },
          scripts: {
            install: 'node install.js',
          },
          devDependencies: {
            typescript: '^5.3.3',
          },
        },
        null,
        2,
      ),
    );
    writeFile(rootDir, 'packages/audio-capture/dist/index.js', '');
    writeFile(
      rootDir,
      'packages/audio-capture/dist/index.test.js',
      'throw new Error("should not copy tests");\n',
    );
    writeFile(
      rootDir,
      'packages/audio-capture/dist/index.spec.js',
      'throw new Error("should not copy specs");\n',
    );
    writeFile(
      rootDir,
      'packages/audio-capture/prebuilds/darwin-arm64/@qwen-code+audio-capture.node',
      'fake native addon\n',
    );
    writeFile(
      rootDir,
      'packages/audio-capture/prebuilds/darwin-arm64/debug.log',
      'should not ship\n',
    );
    writeFile(
      rootDir,
      'packages/audio-capture/node_modules/node-gyp-build/package.json',
      '{"name":"node-gyp-build","version":"4.8.4"}\n',
    );
    writeFile(
      rootDir,
      'packages/audio-capture/node_modules/node-gyp-build/index.js',
      '',
    );

    for (const template of [
      'agent',
      'commands',
      'context',
      'mcp-server',
      'skills',
    ]) {
      writeFile(
        rootDir,
        `packages/cli/src/commands/extensions/examples/${template}/package.json`,
        '{}\n',
      );
    }

    return rootDir;
  }

  function createBundleArtifacts(rootDir) {
    writeFile(rootDir, 'dist/cli.js', '');
    mkdirSync(path.join(rootDir, 'dist', 'vendor'), { recursive: true });
    mkdirSync(path.join(rootDir, 'dist', 'bundled', 'qc-helper', 'docs'), {
      recursive: true,
    });
    // Web Shell release gate (prepare-package.js verifyBundleArtifacts): the
    // published package must ship the UI, so the fixture provides it too.
    writeFile(rootDir, 'dist/web-shell/index.html', '<!doctype html>');
    mkdirSync(path.join(rootDir, 'dist', 'web-shell', 'assets'), {
      recursive: true,
    });
  }

  function writeFile(rootDir, relativePath, content) {
    const filePath = path.join(rootDir, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }

  function stubConsole() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  }
});
