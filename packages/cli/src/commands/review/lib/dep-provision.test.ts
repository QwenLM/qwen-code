/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEPS_COMPLETE_MARKER,
  PROVISION_MARKER,
  provisionSourceOf,
  provisionWorktreeDependencies,
} from './dep-provision.js';

const LOCK = JSON.stringify({ name: 'fixture', lockfileVersion: 3 });

describe('provisionWorktreeDependencies', () => {
  const made: string[] = [];
  const tmp = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    made.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of made.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
    writeFileSync(join(entry, DEPS_COMPLETE_MARKER), '');
    return entry;
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
      JSON.stringify({ name: '@fix/core' }),
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
    const wt = makeWorktree();

    const got = provisionWorktreeDependencies(wt, cache);

    expect(got.provisioned).toBe(true);
    expect(got.source).toBe(realpathSync(entry));
    expect(got.failed).toBe(0);
    // plain-pkg, .bin, @scope/inner and the member's nested-dep from the
    // cache; @fix/core and @fix/empty as worktree self-links.
    expect(got.linked).toBe(6);
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
    // npm's completeness marker is what makes build-test skip its install.
    expect(existsSync(join(wt, 'node_modules', '.package-lock.json'))).toBe(
      true,
    );
    // The provenance marker names the entry, for the scratch-tree containment.
    expect(
      readFileSync(join(wt, 'node_modules', PROVISION_MARKER), 'utf8').trim(),
    ).toBe(realpathSync(entry));
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
      expect(provisionSourceOf(wt)).toBe(realpathSync(entry));
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
