/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  STALE_MARGIN_MS,
  bundleStaleness,
  reviewSourceRoots,
  staleBundleWarning,
} from './stale-bundle.js';

describe('bundleStaleness', () => {
  let root: string;
  let bundle: string;
  let sources: string;

  // A fixed instant, so each case is about the gap and not about how long the
  // suite took to run.
  const BUILT_AT = Date.parse('2026-08-02T00:57:00Z');

  /** Write `file` and stamp it `secondsFromBuild` after the bundle. */
  const at = (file: string, secondsFromBuild: number) => {
    writeFileSync(file, 'x');
    const t = new Date(BUILT_AT + secondsFromBuild * 1000);
    utimesSync(file, t, t);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stale-bundle-'));
    bundle = join(root, 'cli.js');
    sources = join(root, 'src');
    mkdirSync(sources, { recursive: true });
    at(bundle, 0);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reports the newest source and how far ahead it is', () => {
    // The case this exists for, to scale: a bundle built overnight and a
    // command merged the next morning.
    at(join(sources, 'old.ts'), -3600);
    at(join(sources, 'drive.ts'), 10 * 3600);
    const s = bundleStaleness(bundle, [sources]);
    expect(s.stale).toBe(true);
    expect(s.newest?.file).toContain('drive.ts');
    expect(s.newest?.aheadMs).toBe(10 * 3_600_000);
  });

  it('accepts a single file as a root, not only a directory', () => {
    // `review.ts` registers every subcommand and lives beside the directory,
    // not in it — a new command or a changed dispatch is a change there and
    // nowhere else.
    const lone = join(root, 'review.ts');
    at(lone, 3600);
    const s = bundleStaleness(bundle, [lone]);
    expect(s.stale).toBe(true);
    expect(s.newest?.file).toBe(lone);
  });

  it('finds a source nested below the root', () => {
    const deep = join(sources, 'lib', 'nested');
    mkdirSync(deep, { recursive: true });
    at(join(deep, 'ledger.ts'), 7200);
    expect(bundleStaleness(bundle, [sources]).stale).toBe(true);
  });

  it('is quiet when the bundle is newer than every source', () => {
    at(join(sources, 'a.ts'), -600);
    const s = bundleStaleness(bundle, [sources]);
    expect(s.stale).toBe(false);
    expect(s.unmeasured).toBeUndefined();
  });

  it('absorbs a checkout, where every file lands at once in no order', () => {
    // A clone writes the bundle and the sources within the same moment, and
    // nothing about which lands first is meaningful.
    at(join(sources, 'a.ts'), STALE_MARGIN_MS / 1000 - 1);
    expect(bundleStaleness(bundle, [sources]).stale).toBe(false);
  });

  it.each([
    [
      'a bundle that is not there',
      () => ({ b: join(root, 'nope.js'), r: [sources] }),
    ],
    [
      'a source root that is not there',
      () => ({ b: bundle, r: [join(root, 'nope')] }),
    ],
  ])(
    'says it could not measure %s, and does not accuse the build',
    (_n, mk) => {
      // An installed package has no sources beside it. A check that cannot see
      // the files must not report the build as stale, and must say why rather
      // than pass silently.
      const { b, r } = mk();
      const s = bundleStaleness(b, r);
      expect(s.stale).toBe(false);
      expect(s.unmeasured).toBeTruthy();
      expect(staleBundleWarning(s)).toBeUndefined();
    },
  );
});

describe('staleBundleWarning', () => {
  it('names the file, the gap and the command, or says nothing at all', () => {
    expect(
      staleBundleWarning({
        stale: true,
        newest: {
          file: '/w/packages/cli/src/commands/review/drive.ts',
          aheadMs: 14.5 * 3_600_000,
        },
      }),
    ).toContain(
      '14.5h older than /w/packages/cli/src/commands/review/drive.ts',
    );
    expect(
      staleBundleWarning({
        stale: true,
        newest: { file: '/w/a.ts', aheadMs: 5 * 60_000 },
      }),
    ).toContain('5m older');
    expect(staleBundleWarning({ stale: false })).toBeUndefined();
  });

  it('says what runs from the bundle, not just that it is old', () => {
    // "Rebuild" alone leaves a reader to guess what is at risk; the whole
    // point is that the results they are about to trust may be the old
    // build's.
    const w = staleBundleWarning({
      stale: true,
      newest: { file: '/w/a.ts', aheadMs: 2 * 3_600_000 },
    })!;
    expect(w).toContain('runs the BUILT bundle, not this working tree');
    expect(w).toContain('npm run build:packages && npm run bundle');
  });
});

describe('reviewSourceRoots', () => {
  it('resolves both trees a review command can live in', () => {
    expect(reviewSourceRoots('/w/dist/cli.js')).toEqual([
      '/w/packages/cli/src/commands/review',
      // The registration file sits beside the directory, so a subcommand added
      // without a rebuild is a change this check can see.
      '/w/packages/cli/src/commands/review.ts',
      '/w/packages/core/src/skills/bundled/review',
    ]);
  });
});
