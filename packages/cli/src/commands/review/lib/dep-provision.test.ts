/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  DEPS_CACHE_ENV,
  DEPS_COMPLETE_MARKER,
  DEPS_MANIFEST_FILE,
  DEPS_SOURCE_REV_FILE,
  PROVISION_MARKER,
  provisionSourceOf,
  provisionWorktreeDependencies,
} from './dep-provision.js';

const LOCK = JSON.stringify({ name: 'fixture', lockfileVersion: 3 });

describe('provisionWorktreeDependencies', () => {
  const made: string[] = [];
  const tmp = (prefix: string): string => {
    // Canonicalise: `verdict()` compares against realpath'd entry paths, and
    // hosts whose temp dir is symlinked (macOS: /var -> /private/var) would
    // otherwise misclassify every fixture self-link as an escape.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    made.push(dir);
    return dir;
  };

  /** Runs `fn` with DEPS_CACHE_ENV set, restoring the previous value. */
  const withDepsCacheEnv = <T>(value: string, fn: () => T): T => {
    const prev = process.env[DEPS_CACHE_ENV];
    process.env[DEPS_CACHE_ENV] = value;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env[DEPS_CACHE_ENV];
      else process.env[DEPS_CACHE_ENV] = prev;
    }
  };
  afterEach(() => {
    for (const dir of made.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Mirror the population step's read-only seal over the entry's files
   * (provision-review-deps.sh chmods a-w at publish): provisioning must
   * survive entries its own copies inherit that mode from.
   */
  const chmodEntryReadOnly = (entry: string): void => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (d.isSymbolicLink()) continue;
        const full = join(dir, d.name);
        if (d.isDirectory()) walk(full);
        else if (d.isFile()) files.push(full);
      }
    };
    walk(entry);
    for (const f of files) chmodSync(f, 0o444);
  };

  /**
   * A cache entry the CI population step would produce: the lockfile copy,
   * both completeness markers, a root install (plain, scoped, `.bin`, and
   * npm's workspace self-link), one member's nested install and prebuilt
   * `dist`, and one member the snapshot never materialised (its self-link
   * dangles — the shape a docs-only workspace leaves).
   */
  const makeEntry = (cacheRoot: string, lock: string = LOCK): string => {
    const hash = createHash('sha256').update(lock).digest('hex');
    const entry = join(cacheRoot, hash);
    const nm = join(entry, 'node_modules');
    mkdirSync(join(nm, 'plain-pkg'), { recursive: true });
    writeFileSync(join(nm, 'plain-pkg', 'index.js'), 'plain\n');
    mkdirSync(join(nm, '.bin'), { recursive: true });
    // npm writes member bin links RELATIVE, so they re-resolve through the
    // worktree's self-links once `.bin` is rebuilt there.
    symlinkSync('../plain-pkg/index.js', join(nm, '.bin', 'plainbin'));
    symlinkSync('../@fix/core/dist/cli.js', join(nm, '.bin', 'corebin'));
    mkdirSync(join(nm, '@scope', 'inner'), { recursive: true });
    writeFileSync(join(nm, '@scope', 'inner', 'index.js'), 'scoped\n');
    mkdirSync(join(nm, '@fix'), { recursive: true });
    mkdirSync(join(entry, 'packages', 'core', 'node_modules', 'nested-dep'), {
      recursive: true,
    });
    mkdirSync(join(entry, 'packages', 'core', 'dist'), { recursive: true });
    writeFileSync(
      join(entry, 'packages', 'core', 'dist', 'index.js'),
      'built at base\n',
    );
    writeFileSync(
      join(entry, 'packages', 'core', 'dist', 'cli.js'),
      'base cli\n',
    );
    symlinkSync(
      join(entry, 'packages', 'core'),
      join(nm, '@fix', 'core'),
      'dir',
    );
    // The dangling self-link: `packages/empty` holds neither an install nor a
    // dist, so the snapshot has no directory for it.
    symlinkSync(
      join(entry, 'packages', 'empty'),
      join(nm, '@fix', 'empty'),
      'dir',
    );
    writeFileSync(join(nm, '.package-lock.json'), '{"installed": true}');
    writeFileSync(join(entry, 'package-lock.json'), lock);
    sealEntry(entry);
    return entry;
  };

  /**
   * The population step's publish order: hash every staged file into the
   * manifest FIRST, marker LAST — the provisioner refuses an entry whose
   * contents no longer hash back to the manifest.
   */
  const sealEntry = (entry: string): void => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (d.isSymbolicLink()) continue;
        const full = join(dir, d.name);
        if (d.isDirectory()) walk(full);
        else if (d.isFile()) {
          // A RESEAL walks over the previous seal's own files; the manifest
          // cannot list itself or the marker.
          if (
            d.name === DEPS_MANIFEST_FILE ||
            d.name === DEPS_COMPLETE_MARKER
          ) {
            continue;
          }
          files.push(full);
        }
      }
    };
    walk(entry);
    const manifest =
      files
        .map(
          (f) =>
            `${createHash('sha256').update(readFileSync(f)).digest('hex')}  ./${relative(entry, f)}`,
        )
        .join('\n') + '\n';
    writeFileSync(join(entry, DEPS_MANIFEST_FILE), manifest);
    writeFileSync(join(entry, DEPS_COMPLETE_MARKER), '');
  };

  const makeWorktree = (lock: string = LOCK): string => {
    const wt = tmp('depprov-wt-');
    writeFileSync(join(wt, 'package-lock.json'), lock);
    writeFileSync(
      join(wt, 'package.json'),
      JSON.stringify({ name: 'fixture', workspaces: ['packages/*'] }),
    );
    mkdirSync(join(wt, 'packages', 'core'), { recursive: true });
    writeFileSync(
      join(wt, 'packages', 'core', 'package.json'),
      JSON.stringify({ name: '@fix/core', bin: { corebin: 'dist/cli.js' } }),
    );
    mkdirSync(join(wt, 'packages', 'empty'), { recursive: true });
    writeFileSync(
      join(wt, 'packages', 'empty', 'package.json'),
      JSON.stringify({ name: '@fix/empty' }),
    );
    return wt;
  };

  it('farms a matching entry: links, self-links, nested installs, dist copies', () => {
    const cache = tmp('depprov-cache-');
    const entry = makeEntry(cache);
    chmodEntryReadOnly(entry);
    const wt = makeWorktree();

    const got = provisionWorktreeDependencies(wt, cache);

    expect(got.provisioned).toBe(true);
    expect(got.source).toBe(realpathSync(entry));
    expect(got.failed).toBe(0);
    // plain-pkg, @scope/inner and the member's nested-dep from the cache;
    // @fix/core and @fix/empty as worktree self-links. `.bin` is NOT among
    // them — it is rebuilt below from the worktree's own members.
    expect(got.linked).toBe(5);
    expect(got.selfLinked).toBe(2);
    expect(got.distCopied).toBe(1);
    // Third-party packages resolve into the cache entry...
    expect(
      readFileSync(join(wt, 'node_modules', 'plain-pkg', 'index.js'), 'utf8'),
    ).toBe('plain\n');
    expect(
      lstatSync(join(wt, 'node_modules', 'plain-pkg')).isSymbolicLink(),
    ).toBe(true);
    expect(
      lstatSync(join(wt, 'node_modules', '@scope', 'inner')).isSymbolicLink(),
    ).toBe(true);
    // ...while the members resolve BY NAME to the worktree's own directories,
    // never the cache's — the stale-sibling trap this module's comment names.
    expect(realpathSync(join(wt, 'node_modules', '@fix', 'core'))).toBe(
      realpathSync(join(wt, 'packages', 'core')),
    );
    expect(realpathSync(join(wt, 'node_modules', '@fix', 'empty'))).toBe(
      realpathSync(join(wt, 'packages', 'empty')),
    );
    // The nested install and the prebuilt dist landed under the member...
    expect(
      lstatSync(
        join(wt, 'packages', 'core', 'node_modules', 'nested-dep'),
      ).isSymbolicLink(),
    ).toBe(true);
    // ...and dist is a COPY: a rebuild overwrites the worktree, not the cache.
    expect(
      lstatSync(join(wt, 'packages', 'core', 'dist')).isSymbolicLink(),
    ).toBe(false);
    expect(
      readFileSync(join(wt, 'packages', 'core', 'dist', 'index.js'), 'utf8'),
    ).toBe('built at base\n');
    // The entry published its files read-only, but the COPY is what Agent 7's
    // scoped build overwrites in place — the copy must come back writable
    // (R3-1) or that build dies EACCES on a cache-only false failure.
    writeFileSync(
      join(wt, 'packages', 'core', 'dist', 'index.js'),
      'rebuilt\n',
    );
    expect(
      readFileSync(join(wt, 'packages', 'core', 'dist', 'index.js'), 'utf8'),
    ).toBe('rebuilt\n');
    // ...and the shared entry's copy stayed what it was.
    expect(
      readFileSync(join(entry, 'packages', 'core', 'dist', 'index.js'), 'utf8'),
    ).toBe('built at base\n');
    // `.bin` is a REAL dir in the worktree: member binaries resolve into the
    // worktree member, never the entry's base copy...
    expect(lstatSync(join(wt, 'node_modules', '.bin')).isSymbolicLink()).toBe(
      false,
    );
    expect(realpathSync(join(wt, 'node_modules', '.bin', 'corebin'))).toBe(
      realpathSync(join(wt, 'packages', 'core', 'dist', 'cli.js')),
    );
    // ...while third-party binaries still resolve through the farm.
    expect(realpathSync(join(wt, 'node_modules', '.bin', 'plainbin'))).toBe(
      realpathSync(join(entry, 'node_modules', 'plain-pkg', 'index.js')),
    );
    // npm's completeness marker is what makes build-test skip its install.
    expect(existsSync(join(wt, 'node_modules', '.package-lock.json'))).toBe(
      true,
    );
    // The provenance marker names the entry, for the scratch-tree containment.
    expect(
      readFileSync(join(wt, 'node_modules', PROVISION_MARKER), 'utf8').trim(),
    ).toBe(realpathSync(entry));
  });

  it('refuses an entry name planted as a symlink out of the cache root', () => {
    // The entry is resolved before it is served; a link at the entry name
    // that escapes the cache root is a farm of someone else's choosing.
    const cache = tmp('depprov-cache-');
    const outside = tmp('depprov-outside-');
    const foreign = makeEntry(outside);
    const hash = createHash('sha256').update(LOCK).digest('hex');
    symlinkSync(foreign, join(cache, hash));

    const got = provisionWorktreeDependencies(makeWorktree(), cache);

    expect(got.provisioned).toBe(false);
    expect(got.reason).toContain('outside the cache root');
  });

  it('falls back on a cold cache with the lockfile hash in the reason', () => {
    const cache = tmp('depprov-cache-');
    const wt = makeWorktree();
    const got = provisionWorktreeDependencies(wt, cache);
    expect(got.provisioned).toBe(false);
    expect(got.reason).toContain('no cache entry');
    expect(existsSync(join(wt, 'node_modules'))).toBe(false);
  });

  it('falls back when the entry carries no completeness marker (torn snapshot)', () => {
    const cache = tmp('depprov-cache-');
    const entry = makeEntry(cache);
    rmSync(join(entry, DEPS_COMPLETE_MARKER));
    const got = provisionWorktreeDependencies(makeWorktree(), cache);
    expect(got.provisioned).toBe(false);
    expect(got.reason).toContain('no completeness marker');
  });

  it("falls back when the entry's lockfile copy differs from the worktree's", () => {
    const cache = tmp('depprov-cache-');
    const entry = makeEntry(cache);
    writeFileSync(join(entry, 'package-lock.json'), `${LOCK} `);
    const got = provisionWorktreeDependencies(makeWorktree(), cache);
    expect(got.provisioned).toBe(false);
    expect(got.reason).toContain('different lockfile');
  });

  it('falls back when the entry has no npm completeness marker to hand over', () => {
    // Without `node_modules/.package-lock.json` the farm would link every
    // package and build-test would still `npm ci` over it — refuse up front.
    const cache = tmp('depprov-cache-');
    const entry = makeEntry(cache);
    rmSync(join(entry, 'node_modules', '.package-lock.json'));
    const got = provisionWorktreeDependencies(makeWorktree(), cache);
    expect(got.provisioned).toBe(false);
    expect(got.reason).toContain('.package-lock.json');
  });

  it('refuses a committed DANGLING symlink at node_modules', () => {
    // existsSync would read the dangling link as ABSENT and the farm's mkdir
    // then dies EEXIST — the guard's lstatSync exists for exactly this shape.
    const cache = tmp('depprov-cache-');
    makeEntry(cache);
    const wt = makeWorktree();
    symlinkSync(join(wt, 'no-such-target'), join(wt, 'node_modules'));
    const got = provisionWorktreeDependencies(wt, cache);
    expect(got.provisioned).toBe(false);
    expect(got.reason).toContain('already carries a node_modules');
  });

  it('refuses a worktree that already carries a node_modules (PR content)', () => {
    const cache = tmp('depprov-cache-');
    makeEntry(cache);
    const wt = makeWorktree();
    mkdirSync(join(wt, 'node_modules', 'committed'), { recursive: true });
    const got = provisionWorktreeDependencies(wt, cache);
    expect(got.provisioned).toBe(false);
    expect(got.reason).toContain('already carries a node_modules');
    // What the commit ships is untouched.
    expect(existsSync(join(wt, 'node_modules', 'committed'))).toBe(true);
    expect(existsSync(join(wt, 'node_modules', 'plain-pkg'))).toBe(false);
  });

  it('leaves a committed member dist alone', () => {
    const cache = tmp('depprov-cache-');
    makeEntry(cache);
    const wt = makeWorktree();
    mkdirSync(join(wt, 'packages', 'core', 'dist'), { recursive: true });
    writeFileSync(join(wt, 'packages', 'core', 'dist', 'keep.txt'), 'ship\n');

    const got = provisionWorktreeDependencies(wt, cache);

    expect(got.provisioned).toBe(true);
    expect(got.distCopied).toBe(0);
    expect(
      readFileSync(join(wt, 'packages', 'core', 'dist', 'keep.txt'), 'utf8'),
    ).toBe('ship\n');
    expect(existsSync(join(wt, 'packages', 'core', 'dist', 'index.js'))).toBe(
      false,
    );
  });

  it('self-links a member the PR adds, which the cache has never seen', () => {
    const cache = tmp('depprov-cache-');
    makeEntry(cache);
    const wt = makeWorktree();
    mkdirSync(join(wt, 'packages', 'brand-new'), { recursive: true });
    writeFileSync(
      join(wt, 'packages', 'brand-new', 'package.json'),
      JSON.stringify({ name: '@fix/brand-new' }),
    );

    const got = provisionWorktreeDependencies(wt, cache);

    expect(got.provisioned).toBe(true);
    expect(realpathSync(join(wt, 'node_modules', '@fix', 'brand-new'))).toBe(
      realpathSync(join(wt, 'packages', 'brand-new')),
    );
  });

  it('COUNTS an entry link that escapes the cache, and withholds the npm marker', () => {
    // The cache is operator-provisioned, so an escaping link is a broken
    // snapshot — never mirrored, and the farm that dropped it must not claim
    // npm-completeness or the missing package surfaces as a defect in the
    // diff. Markerless, build-test's own install repairs the tree.
    const cache = tmp('depprov-cache-');
    const outside = tmp('depprov-outside-');
    const entry = makeEntry(cache);
    symlinkSync(outside, join(entry, 'node_modules', 'escapee'), 'dir');

    const wt = makeWorktree();
    const got = provisionWorktreeDependencies(wt, cache);

    expect(got.provisioned).toBe(false);
    expect(got.failed).toBe(1);
    expect(got.source).toBe(realpathSync(entry));
    expect(existsSync(join(wt, 'node_modules', 'escapee'))).toBe(false);
    expect(existsSync(join(wt, 'node_modules', '.package-lock.json'))).toBe(
      false,
    );
    // The partial farm still names its source for the containment readers.
    expect(
      readFileSync(join(wt, 'node_modules', PROVISION_MARKER), 'utf8').trim(),
    ).toBe(realpathSync(entry));
  });

  it('COUNTS a member name that would escape node_modules', () => {
    // The member NAME is PR content and becomes a link path; `../evil` must
    // die in the containment check, not land beside node_modules.
    const cache = tmp('depprov-cache-');
    makeEntry(cache);
    const wt = makeWorktree();
    writeFileSync(
      join(wt, 'packages', 'core', 'package.json'),
      JSON.stringify({ name: '../evil' }),
    );

    const got = provisionWorktreeDependencies(wt, cache);

    expect(got.provisioned).toBe(false);
    expect(got.failed).toBeGreaterThan(0);
    expect(existsSync(join(wt, 'evil'))).toBe(false);
  });

  it('refuses a member named "." that would collapse onto the farm root', () => {
    // The occupied branch's rmSync would delete the whole farm — provenance
    // marker included — and re-create node_modules as a link to the member.
    const cache = tmp('depprov-cache-');
    const entry = makeEntry(cache);
    const wt = makeWorktree();
    writeFileSync(
      join(wt, 'packages', 'core', 'package.json'),
      JSON.stringify({ name: '.' }),
    );

    const got = provisionWorktreeDependencies(wt, cache);

    expect(got.provisioned).toBe(false);
    expect(got.failed).toBeGreaterThan(0);
    // The farm survives: a real directory, marker intact.
    expect(lstatSync(join(wt, 'node_modules')).isSymbolicLink()).toBe(false);
    expect(
      readFileSync(join(wt, 'node_modules', PROVISION_MARKER), 'utf8').trim(),
    ).toBe(realpathSync(entry));
  });

  it('refuses a multi-segment member name that would traverse an entry link', () => {
    // `plain-pkg/x` resolves THROUGH the farm's plain-pkg link, landing the
    // mkdir/rm/symlink inside the shared host cache entry.
    const cache = tmp('depprov-cache-');
    const entry = makeEntry(cache);
    const wt = makeWorktree();
    writeFileSync(
      join(wt, 'packages', 'core', 'package.json'),
      JSON.stringify({ name: 'plain-pkg/x' }),
    );

    const got = provisionWorktreeDependencies(wt, cache);

    expect(got.provisioned).toBe(false);
    expect(got.failed).toBeGreaterThan(0);
    // The entry is unpoisoned.
    expect(existsSync(join(entry, 'node_modules', 'plain-pkg', 'x'))).toBe(
      false,
    );
  });

  it('refuses a member named after the farm provenance marker', () => {
    // `.qwen-review-farm` would replace the marker that names the farm's
    // source, and every scratch tree built for this review would lose its
    // dependencies.
    const cache = tmp('depprov-cache-');
    const entry = makeEntry(cache);
    const wt = makeWorktree();
    writeFileSync(
      join(wt, 'packages', 'core', 'package.json'),
      JSON.stringify({ name: '.qwen-review-farm' }),
    );

    const got = provisionWorktreeDependencies(wt, cache);

    expect(got.provisioned).toBe(false);
    expect(got.failed).toBeGreaterThan(0);
    expect(
      readFileSync(join(wt, 'node_modules', PROVISION_MARKER), 'utf8').trim(),
    ).toBe(realpathSync(entry));
  });

  it('refuses a member named ".bin" or a bare scope', () => {
    // Either would replace the farm's `.bin` / scope directory, making every
    // binary unreachable.
    const cache = tmp('depprov-cache-');
    makeEntry(cache);
    const wt = makeWorktree();
    writeFileSync(
      join(wt, 'packages', 'core', 'package.json'),
      JSON.stringify({ name: '.bin' }),
    );

    const got = provisionWorktreeDependencies(wt, cache);

    expect(got.provisioned).toBe(false);
    expect(got.failed).toBeGreaterThan(0);
    expect(lstatSync(join(wt, 'node_modules', '.bin')).isSymbolicLink()).toBe(
      false,
    );

    const cache2 = tmp('depprov-cache-');
    makeEntry(cache2);
    const wt2 = makeWorktree();
    writeFileSync(
      join(wt2, 'packages', 'core', 'package.json'),
      JSON.stringify({ name: '@fix' }),
    );

    const got2 = provisionWorktreeDependencies(wt2, cache2);

    expect(got2.provisioned).toBe(false);
    expect(got2.failed).toBeGreaterThan(0);
    // The other member's self-link still landed.
    expect(realpathSync(join(wt2, 'node_modules', '@fix', 'empty'))).toBe(
      realpathSync(join(wt2, 'packages', 'empty')),
    );
  });

  it('COUNTS a member bin whose link name or target escapes', () => {
    // The bin object's keys become paths under `.bin` and its values are
    // where the links resolve; `../` in either must die contained, not
    // rm/create outside the farm (R1-25).
    const cache = tmp('depprov-cache-');
    makeEntry(cache);
    const wt = makeWorktree();
    writeFileSync(
      join(wt, 'packages', 'core', 'package.json'),
      JSON.stringify({ name: '@fix/core', bin: { '../evil': './cli.js' } }),
    );

    const got = provisionWorktreeDependencies(wt, cache);

    expect(got.provisioned).toBe(false);
    expect(got.failed).toBeGreaterThan(0);
    expect(existsSync(join(wt, 'node_modules', 'evil'))).toBe(false);
    expect(existsSync(join(wt, 'evil'))).toBe(false);

    // A contained name but an escaping bin target.
    const cache2 = tmp('depprov-cache-');
    makeEntry(cache2);
    const wt2 = makeWorktree();
    writeFileSync(
      join(wt2, 'packages', 'core', 'package.json'),
      JSON.stringify({
        name: '@fix/core',
        bin: { corebin: '../../escaped-cli.js' },
      }),
    );

    const got2 = provisionWorktreeDependencies(wt2, cache2);

    expect(got2.provisioned).toBe(false);
    expect(got2.failed).toBeGreaterThan(0);
    expect(existsSync(join(wt2, 'escaped-cli.js'))).toBe(false);
    // The farm failed, so no marker: build-test installs on its own path.
    expect(existsSync(join(wt2, 'node_modules', '.package-lock.json'))).toBe(
      false,
    );
  });

  it('COUNTS an entry .bin link that reaches outside the entry', () => {
    // The .bin rebuild mirrors the entry's third-party bin links by their
    // LINK TEXT; a text pointing out of the entry must get the same escape
    // verdict every other mirrored link gets, not land in the worktree.
    // (Symlinks are not manifest-listed files, so the seal still verifies.)
    const cache = tmp('depprov-cache-');
    const entry = makeEntry(cache);
    symlinkSync(
      '/etc/passwd',
      join(entry, 'node_modules', '.bin', 'trojanbin'),
    );

    const wt = makeWorktree();
    const got = provisionWorktreeDependencies(wt, cache);

    expect(got.provisioned).toBe(false);
    expect(got.failed).toBeGreaterThan(0);
    expect(existsSync(join(wt, 'node_modules', '.bin', 'trojanbin'))).toBe(
      false,
    );
  });

  it('falls back when the entry content no longer hashes to its manifest', () => {
    // The entry sits on a path writable by the unsandboxed PR code the same
    // job executes; a written-through or pre-planted tree must fail closed,
    // not farm.
    const cache = tmp('depprov-cache-');
    const entry = makeEntry(cache);
    writeFileSync(
      join(entry, 'node_modules', 'plain-pkg', 'index.js'),
      'trojan\n',
    );

    const got = provisionWorktreeDependencies(makeWorktree(), cache);

    expect(got.provisioned).toBe(false);
    expect(got.reason).toContain('manifest');

    // Restored contents but an UNLISTED file: the set must agree too.
    writeFileSync(
      join(entry, 'node_modules', 'plain-pkg', 'index.js'),
      'plain\n',
    );
    writeFileSync(join(entry, 'node_modules', 'planted'), 'x\n');
    expect(
      provisionWorktreeDependencies(makeWorktree(), cache).provisioned,
    ).toBe(false);
  });

  it('falls back when the entry was built from a different source revision', () => {
    // The entry's dist was built from the recorded revision; serving it to a
    // worktree whose merge base is some OTHER commit decides the PR from the
    // base's code.
    const cache = tmp('depprov-cache-');
    const entry = makeEntry(cache);
    const recorded = 'ab'.repeat(20);
    writeFileSync(join(entry, DEPS_SOURCE_REV_FILE), `${recorded}\n`);
    sealEntry(entry);

    const got = provisionWorktreeDependencies(
      makeWorktree(),
      cache,
      'cd'.repeat(20),
    );

    expect(got.provisioned).toBe(false);
    expect(got.reason).toContain('not the worktree');
  });

  it('falls back when a merge base is given but the entry records no revision', () => {
    // An entry published before the source-rev guard existed cannot be
    // vouched for either.
    const cache = tmp('depprov-cache-');
    makeEntry(cache);

    const got = provisionWorktreeDependencies(
      makeWorktree(),
      cache,
      'cd'.repeat(20),
    );

    expect(got.provisioned).toBe(false);
    expect(got.reason).toContain('no source revision');
  });

  it('falls back when the merge base is unknown', () => {
    const cache = tmp('depprov-cache-');
    const entry = makeEntry(cache);
    writeFileSync(join(entry, DEPS_SOURCE_REV_FILE), `${'cd'.repeat(20)}\n`);
    sealEntry(entry);

    const got = provisionWorktreeDependencies(makeWorktree(), cache, null);

    expect(got.provisioned).toBe(false);
    expect(got.reason).toContain('merge base is unknown');
  });

  it('farms an entry whose recorded revision IS the merge base', () => {
    const cache = tmp('depprov-cache-');
    const entry = makeEntry(cache);
    const sha = 'cd'.repeat(20);
    writeFileSync(join(entry, DEPS_SOURCE_REV_FILE), `${sha}\n`);
    sealEntry(entry);

    const got = provisionWorktreeDependencies(makeWorktree(), cache, sha);

    expect(got.provisioned).toBe(true);
    expect(got.source).toBe(realpathSync(entry));
  });

  it('COUNTS a member whose manifest demands a package the entry lacks', () => {
    // Lockfile identity alone does not capture what the member manifests
    // declare; npm ci would reject the desync loudly, so the farm must not
    // claim a completeness the entry cannot satisfy.
    const cache = tmp('depprov-cache-');
    makeEntry(cache);
    const wt = makeWorktree();
    writeFileSync(
      join(wt, 'packages', 'core', 'package.json'),
      JSON.stringify({
        name: '@fix/core',
        dependencies: { 'left-pad': '^1.3.0' },
      }),
    );

    const got = provisionWorktreeDependencies(wt, cache);

    expect(got.provisioned).toBe(false);
    expect(got.failed).toBeGreaterThan(0);
    expect(existsSync(join(wt, 'node_modules', '.package-lock.json'))).toBe(
      false,
    );
  });

  it('COUNTS a member whose devDependency the entry lacks', () => {
    // The demanded set is not just dependencies: a missing devDependency
    // that passes the farm would surface as MODULE_NOT_FOUND behind the
    // marker build-test trusts.
    const cache = tmp('depprov-cache-');
    makeEntry(cache);
    const wt = makeWorktree();
    writeFileSync(
      join(wt, 'packages', 'core', 'package.json'),
      JSON.stringify({
        name: '@fix/core',
        devDependencies: { 'left-pad': '^1.3.0' },
      }),
    );

    const got = provisionWorktreeDependencies(wt, cache);

    expect(got.provisioned).toBe(false);
    expect(got.failed).toBeGreaterThan(0);
    expect(existsSync(join(wt, 'node_modules', '.package-lock.json'))).toBe(
      false,
    );
  });

  it('accepts a satisfied devDependency and an absent OPTIONAL peer', () => {
    const cache = tmp('depprov-cache-');
    makeEntry(cache);
    const wt = makeWorktree();
    writeFileSync(
      join(wt, 'packages', 'core', 'package.json'),
      JSON.stringify({
        name: '@fix/core',
        devDependencies: { 'plain-pkg': '*' },
        peerDependencies: { 'opt-peer': '^1.0.0' },
        peerDependenciesMeta: { 'opt-peer': { optional: true } },
      }),
    );

    const got = provisionWorktreeDependencies(wt, cache);

    expect(got.provisioned).toBe(true);
  });

  it('accepts a member whose manifest demand the entry satisfies', () => {
    const cache = tmp('depprov-cache-');
    makeEntry(cache);
    const wt = makeWorktree();
    writeFileSync(
      join(wt, 'packages', 'core', 'package.json'),
      JSON.stringify({
        name: '@fix/core',
        dependencies: { 'plain-pkg': '*' },
      }),
    );

    const got = provisionWorktreeDependencies(wt, cache);

    expect(got.provisioned).toBe(true);
  });

  // A lockfile that RECORDS the installed version, so the demand check can
  // do what npm ci does — compare the manifest's range against it.
  const RANGED_LOCK = JSON.stringify({
    name: 'fixture',
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture' },
      'node_modules/plain-pkg': { version: '1.0.0' },
    },
  });

  it('COUNTS a member whose manifest range the locked version does not satisfy', () => {
    // Presence alone is not npm's sync check: a manifest bumped past its
    // locked version must fail the farm before the marker hides the desync.
    const cache = tmp('depprov-cache-');
    makeEntry(cache, RANGED_LOCK);
    const wt = makeWorktree(RANGED_LOCK);
    writeFileSync(
      join(wt, 'packages', 'core', 'package.json'),
      JSON.stringify({
        name: '@fix/core',
        dependencies: { 'plain-pkg': '^2.0.0' },
      }),
    );

    const got = provisionWorktreeDependencies(wt, cache);

    expect(got.provisioned).toBe(false);
    expect(got.failed).toBeGreaterThan(0);
    expect(existsSync(join(wt, 'node_modules', '.package-lock.json'))).toBe(
      false,
    );
  });

  it('accepts a member whose range the locked version satisfies', () => {
    const cache = tmp('depprov-cache-');
    makeEntry(cache, RANGED_LOCK);
    const wt = makeWorktree(RANGED_LOCK);
    writeFileSync(
      join(wt, 'packages', 'core', 'package.json'),
      JSON.stringify({
        name: '@fix/core',
        dependencies: { 'plain-pkg': '^1.0.0' },
      }),
    );

    const got = provisionWorktreeDependencies(wt, cache);

    expect(got.provisioned).toBe(true);
  });

  it('COUNTS a ROOT manifest demand the entry lacks', () => {
    // Root dependencies ride the same pass; without a workspaces field the
    // member loop never runs and the root check is the only demand check.
    const cache = tmp('depprov-cache-');
    makeEntry(cache);
    const wt = makeWorktree();
    writeFileSync(
      join(wt, 'package.json'),
      JSON.stringify({
        name: 'single',
        dependencies: { 'left-pad': '^1.3.0' },
      }),
    );

    const got = provisionWorktreeDependencies(wt, cache);

    expect(got.provisioned).toBe(false);
    expect(got.failed).toBeGreaterThan(0);
    expect(existsSync(join(wt, 'node_modules', '.package-lock.json'))).toBe(
      false,
    );
  });

  it('falls back without a worktree lockfile to key the cache', () => {
    const cache = tmp('depprov-cache-');
    makeEntry(cache);
    const wt = makeWorktree();
    rmSync(join(wt, 'package-lock.json'));
    const got = provisionWorktreeDependencies(wt, cache);
    expect(got.provisioned).toBe(false);
    expect(got.reason).toContain('no package-lock.json');
  });

  describe('provisionSourceOf', () => {
    it('answers the validated cache entry for a provisioned worktree', () => {
      const cache = tmp('depprov-cache-');
      const entry = makeEntry(cache);
      const wt = makeWorktree();
      expect(provisionWorktreeDependencies(wt, cache).provisioned).toBe(true);
      expect(withDepsCacheEnv(cache, () => provisionSourceOf(wt))).toBe(
        realpathSync(entry),
      );
    });

    it('is null when no cache is configured', () => {
      // The marker may be valid, but with DEPS_CACHE_ENV unset no cache
      // exists for it to name — a local run must widen nothing.
      const cache = tmp('depprov-cache-');
      makeEntry(cache);
      const wt = makeWorktree();
      expect(provisionWorktreeDependencies(wt, cache).provisioned).toBe(true);
      const prev = process.env[DEPS_CACHE_ENV];
      delete process.env[DEPS_CACHE_ENV];
      try {
        expect(provisionSourceOf(wt)).toBe(null);
      } finally {
        if (prev !== undefined) process.env[DEPS_CACHE_ENV] = prev;
      }
    });

    it('rejects a marker naming a valid entry OUTSIDE the configured cache', () => {
      // A committed marker can name any attacker-shaped host directory; only
      // the configured cache root may answer.
      const cache = tmp('depprov-cache-');
      const otherRoot = tmp('depprov-otherroot-');
      const foreign = makeEntry(otherRoot);
      const wt = makeWorktree();
      mkdirSync(join(wt, 'node_modules'), { recursive: true });
      writeFileSync(join(wt, 'node_modules', PROVISION_MARKER), foreign);
      expect(withDepsCacheEnv(cache, () => provisionSourceOf(wt))).toBe(null);
    });

    it('is null for an unprovisioned tree', () => {
      expect(provisionSourceOf(makeWorktree())).toBe(null);
    });

    it('rejects a marker naming a path inside the dependency root', () => {
      // A PR can force-add the marker file and a fake "entry" beside it; a
      // path inside the worktree can only be PR content, never the host
      // cache, and admitting it would widen the scratch-tree containment to
      // wherever the commit points.
      const wt = makeWorktree();
      const fake = join(wt, 'fake-entry');
      mkdirSync(join(fake, 'node_modules'), { recursive: true });
      writeFileSync(join(fake, DEPS_COMPLETE_MARKER), '');
      mkdirSync(join(wt, 'node_modules'), { recursive: true });
      writeFileSync(join(wt, 'node_modules', PROVISION_MARKER), fake);
      expect(provisionSourceOf(wt)).toBe(null);
    });

    it('rejects a marker naming a directory without the completeness marker', () => {
      const wt = makeWorktree();
      const plain = tmp('depprov-plain-');
      mkdirSync(join(plain, 'node_modules'), { recursive: true });
      mkdirSync(join(wt, 'node_modules'), { recursive: true });
      writeFileSync(join(wt, 'node_modules', PROVISION_MARKER), plain);
      expect(provisionSourceOf(wt)).toBe(null);
    });

    it('rejects a relative or empty recorded path', () => {
      const wt = makeWorktree();
      mkdirSync(join(wt, 'node_modules'), { recursive: true });
      writeFileSync(
        join(wt, 'node_modules', PROVISION_MARKER),
        'relative/path',
      );
      expect(provisionSourceOf(wt)).toBe(null);
      writeFileSync(join(wt, 'node_modules', PROVISION_MARKER), '\n');
      expect(provisionSourceOf(wt)).toBe(null);
    });
  });
});
