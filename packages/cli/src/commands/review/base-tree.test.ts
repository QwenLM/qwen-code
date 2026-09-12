/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Against a REAL git repo, because the part that breaks is the worktree
// lifecycle — a detached add at a specific SHA, a stale sibling from a crashed
// run, a path that must sit beside the review worktree rather than inside it.
// None of that is exercised by mocking `spawnSync`, and all of it is what makes
// the command fail on a real review.
//
// The build is the seam. It is the slow half and it has its own suite; what
// matters here is that a base tree only counts as `available` when the build
// actually succeeded, since an A/B against a half-built tree measures the build,
// not the diff.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  symlinkSync,
  utimesSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runBaseTree,
  sweepStaleLock,
  type BaseTreeReport,
} from './base-tree.js';
import { baseWorktreePath } from './lib/paths.js';
import {
  baseTreeTrustPath,
  builtTreeRecord,
  dropBuiltTree,
  runIdentity,
} from './lib/base-tree-trust.js';
import { adminEntryOf, plantAdminEntry } from './lib/test-utils.js';
import {
  createReviewWorktreeLease,
  recordReviewWorktreeLeaseMergeBase,
} from '../../services/review-worktree-lease.js';
import type { BuildTestReport } from './build-test.js';

const okBuild = {
  ok: true,
  toolchain: 'npm',
  build: [{ command: 'npm run build', exitCode: 0 }],
  note: 'built',
} as unknown as BuildTestReport;
const failedBuild = {
  ok: false,
  note: 'TS2307',
  build: [{ command: 'npm run build', exitCode: 2 }],
} as unknown as BuildTestReport;

// Skipped on win32 for the same reason as the sibling suites: `mountRootFor`
// refuses every absolute Windows path (a drive letter is a colon), so no
// mount boundary exists there for the reuse fence to hold — these cases pin
// fence behaviour (reuse, decline, settle, rebuild) that only exists where
// one does. The build-mechanics cases below stay ungated: they are this
// file's coverage for the lane the fence never speaks on.
const itWhereContainmentExists = it.skipIf(process.platform === 'win32');

describe('runBaseTree', () => {
  let repo: string;
  let worktree: string;
  let baseSha: string;
  let headSha: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  const writePlan = (over: Record<string, unknown> = {}): string => {
    const p = join(repo, 'plan.json');
    writeFileSync(
      p,
      JSON.stringify({ mergeBaseSha: baseSha, files: [], ...over }),
    );
    return p;
  };

  // Captured ONCE per test, the way `fetch-pr` captures it once per run: the
  // reuse marker is fenced on the plan's epoch, so a helper that re-captured on
  // every call would simulate a new run each time and the fast path — the
  // concurrent-shard guard the reuse test below pins — could never speak.
  let planPath = '';
  const run = (
    over: {
      plan?: Record<string, unknown>;
      worktree?: string;
      onReuseWindow?: () => void;
    } = {},
    build: (w: string) => BuildTestReport = () => okBuild,
  ): BaseTreeReport => {
    const { plan: planOver, ...rest } = over;
    if (planOver !== undefined || !planPath) planPath = writePlan(planOver);
    return runBaseTree({
      plan: planPath,
      worktree,
      timeout: 60,
      install: false,
      build,
      ...rest,
    });
  };

  beforeEach(() => {
    planPath = '';
    repo = mkdtempSync(join(tmpdir(), 'qwen-base-tree-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'a.txt'), 'before\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    baseSha = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'a.txt'), 'after\n');
    git(repo, 'commit', '-qam', 'head');
    headSha = git(repo, 'rev-parse', 'HEAD');
    // The review worktree the base tree is created beside.
    worktree = join(repo, '.qwen', 'tmp', 'review-pr-1');
    mkdirSync(join(repo, '.qwen', 'tmp'), { recursive: true });
    git(repo, 'worktree', 'add', '--detach', '-q', worktree, headSha);
    writeLease();
  });

  /**
   * The lease fetch-pr holds for the whole review, at the host-side path —
   * the run identity the mount cannot touch, and now the ONLY source of one:
   * the plan-mtime fallback is gone, because it put the identity back inside
   * the directory the sandbox mounts read-write. Every case needs a lease,
   * so it is acquired in `beforeEach` through the REAL writer rather than
   * hand-built here — a hand-built fixture pins this command against a
   * fiction of the lease module, which is how the mtime-carried identity
   * survived its own test.
   */
  const tree = (): string => baseWorktreePath(worktree);
  const trustPathFor = (): string => baseTreeTrustPath(worktree, planPath);
  const writeLease = (promptId = 'p'): void => {
    createReviewWorktreeLease({
      sessionId: 's',
      promptId,
      target: 'pr-1',
      repositoryRoot: repo,
      worktreePath: worktree,
      branch: 'qwen-review/pr-1',
    });
    // The capture records the merge base it resolved, host-side — which
    // `fetch-pr` does on every capture, and which `base-tree` now REFUSES to
    // proceed without: its absence used to skip the anchor and hand the
    // mount-writable plan back its sole authority over the sha the run
    // builds and certifies.
    recordReviewWorktreeLeaseMergeBase(repo, 'pr-1', baseSha);
  };

  /**
   * The NEXT run: fetch-pr captures again, and the acquisition mints a fresh
   * identity — which rotates the trust file and drops its records.
   *
   * A re-captured PLAN used to do this, because the identity fell back to
   * the plan's mtime. It no longer does anything, and that is the point: the
   * plan lives inside the directory the sandbox mounts read-write, so the
   * reviewed code could rotate a live run's state — and sweep the tree a
   * sibling shard was mid-A/B in — with one `utimes`.
   */
  const nextRun = (): void => {
    rmSync(
      join(repo, '.qwen', 'review-leases', 'qwen-review-lease-pr-1.json'),
      { force: true },
    );
    writeLease('prompt-next');
  };

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  itWhereContainmentExists(
    'reports BUSY and leaves the tree standing when a tree THIS RUN built fails a reuse check (tracked dirt)',
    () => {
      // `rev-parse HEAD` does not move when working files change, and this tree
      // is a direct child of the directory the sandbox mounts read-write — but
      // tracked dirt on a tree THIS run stamped is not necessarily a rewrite by
      // the reviewed code: a build can modify tracked files (codegen, lockfile
      // rewrites), and a concurrent shard's A/B writes one (a snapshot
      // `--update`). Discarding on that signal sweeps a live tree another shard
      // may be mid-A/B in — the concurrent-shard clobber the fast path exists
      // to prevent — so the fence declines, the way the build lock's EEXIST arm
      // does, and the dirtied tree stands for the shard that is using it.
      const tree = baseWorktreePath(worktree);
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);
      // One tracked file rewritten, the plan untouched: same run, genuine stamp.
      writeFileSync(join(tree, 'a.txt'), 'after\n');

      const second = run({}, build);
      expect(second.available).toBe(false);
      expect(second.note).toContain(
        'no longer holds exactly what this run recorded',
      );
      expect(second.note).not.toContain('reusing it');
      expect(builds).toEqual([tree]); // declined — no sweep, no rebuild
      // The dirtied file is still on disk: discarding it is what was refused.
      expect(readFileSync(join(tree, 'a.txt'), 'utf8')).toBe('after\n');
    },
  );

  itWhereContainmentExists(
    "TOLERATES the A/B's own output — the lane survives an honest round (R1-4)",
    () => {
      // `test-delta` runs the base side with its cwd INSIDE this tree, so the
      // A/B's cache and coverage output lands here as untracked files. While
      // an addition declined, three consecutive asks after ONE honest A/B all
      // returned `available: false` and the round lost its A/B lane — with no
      // adversary, and where the pre-fence merge base reused. An
      // `available: false` base tree makes the agent fall back to the path
      // rule, so that decline waves through exactly the regressions the A/B
      // exists to catch.
      //
      // The record is NOT updated to include them. Re-recording would promote
      // whatever appeared into "what this run built", which is a false
      // statement written into the record itself — and there is no
      // discriminator to make it true, because the A/B's base side runs the
      // reviewed repository's own test code in this tree.
      const tree = baseWorktreePath(worktree);
      const trustPath = baseTreeTrustPath(worktree, planPath || writePlan());
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        if (builds.length === 1) {
          mkdirSync(join(w, 'dist'), { recursive: true });
          writeFileSync(join(w, 'dist', 'cli.js'), 'built');
        }
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);

      // What an A/B leaves behind, at the shapes vitest actually writes.
      mkdirSync(join(tree, 'node_modules', '.vite', 'deps'), {
        recursive: true,
      });
      writeFileSync(
        join(tree, 'node_modules', '.vite', 'deps', 'chunk-XYZ.js'),
        'cache',
      );
      mkdirSync(join(tree, 'coverage'), { recursive: true });
      writeFileSync(join(tree, 'coverage', 'lcov.info'), 'coverage');

      for (let ask = 0; ask < 3; ask++) {
        const again = run({}, build);
        expect(again.available).toBe(true);
        expect(again.note).toContain('reusing it');
      }
      expect(builds).toEqual([tree]); // never rebuilt, never swept

      // ...and the record still says only what the build left, so the claim
      // it makes stays true.
      expect(Object.keys(builtTreeRecord(trustPath, tree)!.untracked)).toEqual([
        'dist/cli.js',
      ]);
    },
  );

  itWhereContainmentExists(
    'sees a plant hiding INSIDE a directory the build left (file-level record)',
    () => {
      // The fence's blind spot when the record was collapsed: with `dist/`
      // recorded as one entry, anything dropped inside it changed no set
      // membership — the exact place a host-side A/B's executable lives.
      // The record is file-level, so `dist/cli.js` is watched in its own
      // right and an in-place rewrite of it is seen.
      const tree = baseWorktreePath(worktree);
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        if (builds.length === 1) {
          // The residue a real build leaves, recorded host-side as legitimate.
          mkdirSync(join(w, 'dist'), { recursive: true });
          writeFileSync(join(w, 'dist', 'cli.js'), 'built by round 1');
        }
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);
      // The honest arm first: the recorded residue itself still reuses.
      expect(run({}, build).note).toContain('reusing it');
      expect(builds).toEqual([tree]);

      // A file ADDED inside `dist/` is tolerated — see the R1-4 case above
      // for why, and for what the fence claims instead.
      writeFileSync(join(tree, 'dist', 'evil.js'), 'planted inside');
      expect(run({}, build).note).toContain('reusing it');

      // What the file-level record buys is this: `dist/cli.js` is recorded
      // in its own right, so rewriting it IN PLACE is seen. With `dist/`
      // recorded as one collapsed entry it was not — the directory's own
      // size and ctime do not move when a child is rewritten, and
      // `dist/cli.js` is exactly what a host-side A/B executes.
      writeFileSync(join(tree, 'dist', 'cli.js'), 'planted in place');
      const third = run({}, build);
      expect(third.note).not.toContain('reusing it');
      expect(third.note).toContain(
        'no longer holds exactly what this run recorded',
      );
      expect(third.available).toBe(false);
      expect(builds).toEqual([tree]); // declined — still no rebuild
    },
  );

  itWhereContainmentExists(
    'records a file named __proto__ — the fence is not a plain-object map',
    () => {
      // `inventory[p] = …` on a plain object feeds the prototype setter, so a
      // file at that name never lands in the record — symmetric on write and
      // on compare, which makes the fence blind to it in BOTH directions.
      // The record is `Object.create(null)`, so it lands as an own key, and
      // landing is what makes a rewrite of it visible.
      const tree = baseWorktreePath(worktree);
      const trustPath = baseTreeTrustPath(worktree, planPath || writePlan());
      const builds: string[] = [];
      let round = 0;
      const build = (w: string) => {
        builds.push(w);
        if (++round === 1) writeFileSync(join(w, '__proto__'), 'built');
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);
      const recorded = builtTreeRecord(trustPath, tree)!.untracked;
      expect(Object.prototype.hasOwnProperty.call(recorded, '__proto__')).toBe(
        true,
      );
      expect(run({}, build).note).toContain('reusing it');

      writeFileSync(join(tree, '__proto__'), 'planted in place');
      const third = run({}, build);
      expect(third.note).not.toContain('reusing it');
      expect(third.note).toContain(
        'no longer holds exactly what this run recorded',
      );
      expect(third.available).toBe(false);
      expect(builds).toEqual([tree]);
    },
  );

  itWhereContainmentExists(
    'declines when an already-recorded ignored file is rewritten IN PLACE',
    () => {
      // Membership cannot see this: the path was recorded at build time and
      // is still the only path there. The recorded stat pair is what an
      // in-place rewrite cannot forge — size moves here, and where size
      // cannot move (next case), ctime does and cannot be set back.
      const tree = baseWorktreePath(worktree);
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        if (builds.length === 1) {
          // The residue a real build leaves, recorded host-side as legitimate.
          mkdirSync(join(w, 'dist'), { recursive: true });
          writeFileSync(join(w, 'dist', 'cli.js'), 'built by round 1');
        }
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);
      // The honest arm first: the recorded residue itself still reuses.
      expect(run({}, build).note).toContain('reusing it');

      writeFileSync(
        join(tree, 'dist', 'cli.js'),
        'planted by the reviewed code, in place, at length',
      );
      const third = run({}, build);
      expect(third.note).not.toContain('reusing it');
      expect(third.note).toContain(
        'no longer holds exactly what this run recorded',
      );
      expect(third.available).toBe(false);
      expect(builds).toEqual([tree]); // declined, not discarded
    },
  );

  itWhereContainmentExists(
    'declines even when the in-place rewrite preserves the size — ctime carries it',
    () => {
      // The half of the in-place arm size cannot see: nine bytes for nine
      // bytes. `ctimeMs` cannot be set from userland — every write sets it
      // to now — so the rewrite shows even at the same size.
      const tree = baseWorktreePath(worktree);
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        if (builds.length === 1) {
          mkdirSync(join(w, 'dist'), { recursive: true });
          writeFileSync(join(w, 'dist', 'cli.js'), 'round one');
        }
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);

      const target = join(tree, 'dist', 'cli.js');
      const recordedCtime = lstatSync(target).ctimeMs;
      writeFileSync(target, 'PLANTED!!'); // 9 bytes, exactly 'round one'
      // A rewrite inside the filesystem's coarse ctime tick would leave
      // ctime bit-identical (the trust suite measured 7.7 µs on ext4), so
      // chmod until it OBSERVABLY moves — the same tick guard, for the same
      // reason. The mode alternates so no filesystem can skip a same-mode
      // chmod.
      const deadline = Date.now() + 10_000;
      let mode = 0o644;
      while (lstatSync(target).ctimeMs === recordedCtime) {
        if (Date.now() >= deadline) {
          throw new Error(
            'the filesystem never moved ctime across 10 s — the ctime arm ' +
              'of the stat check is unobservable here',
          );
        }
        chmodSync(target, mode);
        mode = mode === 0o644 ? 0o755 : 0o644;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }

      const second = run({}, build);
      expect(second.note).not.toContain('reusing it');
      expect(second.note).toContain(
        'no longer holds exactly what this run recorded',
      );
      expect(second.available).toBe(false);
      expect(builds).toEqual([tree]);
    },
    15_000,
  );

  itWhereContainmentExists(
    "declines — does not sweep — when the run's trust file is unreadable",
    () => {
      // The record is the fence, so its absence must not read as a verdict
      // about the tree: a torn write (a crashed process mid-rename, a full
      // disk) is bookkeeping, and discarding on it sweeps the live tree a
      // sibling shard may be mid-A/B in — the clobber the fast path exists
      // to prevent.
      const tree = baseWorktreePath(worktree);
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);

      writeFileSync(baseTreeTrustPath(worktree, planPath), 'torn');
      const second = run({}, build);
      expect(second.available).toBe(false);
      expect(second.note).toContain('missing or unreadable');
      expect(second.note).toContain('declining to reuse or discard');
      expect(builds).toEqual([tree]); // no sweep, no rebuild
      expect(readFileSync(join(tree, 'a.txt'), 'utf8')).toBe('before\n');
    },
  );

  itWhereContainmentExists(
    "declines busy when the tree's record is missing from an intact trust file",
    () => {
      // The same torn-bookkeeping shape one level down: the file is healthy,
      // the tree's entry is gone (a lost rename, a partial write). "No
      // record" is not "a plant" — the pointer and HEAD agree — so the
      // answer is the decline the dirt arms get, and the tree stands.
      const tree = baseWorktreePath(worktree);
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);

      const trustPath = baseTreeTrustPath(worktree, planPath);
      const trust = JSON.parse(readFileSync(trustPath, 'utf8'));
      delete trust.trees;
      writeFileSync(trustPath, JSON.stringify(trust));

      const second = run({}, build);
      expect(second.available).toBe(false);
      expect(second.note).toContain('missing or unreadable');
      expect(builds).toEqual([tree]); // no sweep, no rebuild
      expect(existsSync(join(tree, 'a.txt'))).toBe(true);
    },
  );

  itWhereContainmentExists(
    'records the residue of a real-size tree — a listing past the default spawn buffer',
    () => {
      // spawnSync's default maxBuffer is 1 MiB; a real built tree's
      // `ls-files --others --ignored` listing is measured at 6+ MB
      // (node_modules/ plus the packages' dist/). Under the default the record
      // write threw after the build succeeded, no record ever landed, and
      // the reuse fast path never fired. ~7k long-named files put this
      // fixture past the old limit.
      const tree = baseWorktreePath(worktree);
      let built = false;
      const build = (w: string) => {
        if (!built) {
          built = true;
          const dir = join(w, 'dist');
          mkdirSync(dir, { recursive: true });
          const padding = 'f'.repeat(170);
          for (let i = 0; i < 7000; i++) {
            writeFileSync(join(dir, `${i}${padding}`), 'x');
          }
        }
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);
      expect(
        builtTreeRecord(baseTreeTrustPath(worktree, planPath), tree),
      ).not.toBeNull();
      expect(run({}, build).note).toContain('reusing it');
    },
    60_000,
  );

  itWhereContainmentExists(
    "the fence's own git reads carry the config neutralization — a planted core.fsmonitor never fires",
    () => {
      // The reuse fence's `status`/`ls-files` resolve the base tree's own
      // repository, whose config the reviewed code could have reached while
      // it held the mount: a `core.fsmonitor` hook fires on an ordinary
      // index read, on the host, outside the container. The `-c` pins the
      // helpers carry make the hook an inert argument.
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);

      const canary = join(repo, 'fsmonitor-ran');
      const hook = join(repo, 'fsm.sh');
      writeFileSync(hook, `#!/bin/sh\necho ran >> ${canary}\nexit 0\n`);
      chmodSync(hook, 0o755);
      git(repo, 'config', 'core.fsmonitor', hook);

      const second = run({}, build);
      expect(second.note).toContain('reusing it');
      expect(existsSync(canary)).toBe(false);
    },
  );

  itWhereContainmentExists(
    "declines when the plan's mergeBaseSha moves mid-run — the run pinned its base at establishment",
    () => {
      // The plan lives inside the read-write mount, and base-tree reads it
      // after the containerized phases have run: rewriting mergeBaseSha is
      // how the reviewed code would choose the commit every later A/B
      // certifies as "the base". The run pins the first-read sha in the
      // host-side trust file, and a plan that disagrees gets a decline —
      // never a rebuild at the value named after the fact. (The lease is
      // what lets the pin see the rewrite at all: under it the plan's mtime
      // is out of the run identity, so the rewrite cannot rotate the pin
      // away.)
      writeLease();
      const tree = baseWorktreePath(worktree);
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);

      const moved = run({ plan: { mergeBaseSha: headSha } }, build);
      expect(moved.available).toBe(false);
      // The host-side ANCHOR is what answers now, and it answers before the
      // pin is written — which is the point: pinned first, a tampered FIRST
      // ask made the tampered sha the run's authoritative pin, and every
      // later honest capture in the session was then declined as "the plan
      // moved". The pin still covers a rewrite after the anchor agrees.
      expect(moved.note).toContain('capture recorded');
      expect(builds).toEqual([tree]); // declined — no rebuild at the new sha
      // And the tree still holds the base the run pinned.
      expect(git(tree, 'rev-parse', 'HEAD')).toBe(baseSha);
    },
  );

  itWhereContainmentExists(
    'a mid-run touch of the plan cannot rotate the run while the lease is held',
    () => {
      // Reviewed code holding the mount can `utimes` the plan at will; keyed
      // on the plan's stamps, that touch forked every later shard onto a
      // fresh trust state whose rebuild's first act — discarding the
      // standing tree — swept the tree a sibling was mid-A/B in. The lease
      // is the identity the mount cannot touch: the run goes on, the tree
      // stands.
      writeLease();
      const tree = baseWorktreePath(worktree);
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);

      const later = new Date(Date.now() + 60_000);
      utimesSync(planPath, later, later);
      const second = run({}, build);
      expect(second.available).toBe(true);
      expect(second.note).toContain('reusing it');
      expect(builds).toEqual([tree]); // neither discarded nor re-added
      expect(existsSync(tree)).toBe(true);
    },
  );

  itWhereContainmentExists(
    'rebuilds — does not decline — when a tree THIS RUN built has its pointer rewritten',
    () => {
      // Busy is for the ambiguous arms (dirt, untracked additions). A
      // rewritten gitfile has no benign cause: this run's build does not
      // touch the pointer, and a concurrent A/B does not either. Declining
      // would leave the plant standing for the rest of the run; the
      // discard-and-rebuild is what sweeps it.
      const tree = baseWorktreePath(worktree);
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);
      plantAdminEntry(
        join(repo, '.qwen', 'tmp', '.evil-base'),
        adminEntryOf(tree),
        tree,
        join(repo, '.git'),
      );

      const second = run({}, build);
      expect(second.note).not.toContain('reusing it');
      expect(second.note).not.toContain('declining to reuse or discard');
      expect(builds).toEqual([tree, tree]); // rebuilt, not declined
      expect(second.available).toBe(true);
    },
  );

  itWhereContainmentExists(
    'takes the plan OUT of the run identity — no stamp on it moves the run',
    () => {
      // The identity used to be the plan's mtime whenever no lease was held,
      // and the plan lives in the directory the sandbox mounts read-write.
      // One `utimes` from the reviewed code therefore rotated a live run's
      // trust state, and the rebuild that followed swept the tree a sibling
      // shard was mid-A/B in. Every direction is exercised here — a
      // same-value touch, a backdate, a forward-date, and a content rewrite
      // — and none of them is the run's identity any more.
      const tree = baseWorktreePath(worktree);
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);
      expect(run({}, build).note).toContain('reusing it');

      const same = statSync(planPath).mtime;
      utimesSync(planPath, same, same); // a same-value touch
      expect(run({}, build).note).toContain('reusing it');

      const earlier = new Date(Date.now() - 3_600_000);
      utimesSync(planPath, earlier, earlier);
      expect(run({}, build).note).toContain('reusing it');

      const later = new Date(Date.now() + 86_400_000);
      utimesSync(planPath, later, later);
      expect(run({}, build).note).toContain('reusing it');
      expect(builds).toEqual([tree]); // never rotated, never rebuilt

      // The control: what DOES rotate is the next capture, host-side.
      nextRun();
      expect(run({}, build).note).not.toContain('reusing it');
      expect(builds).toEqual([tree, tree]);
    },
  );

  itWhereContainmentExists(
    'certifies nothing from inside the mount — a forged marker and an in-place rewrite both fail the record (production geometry)',
    () => {
      // The plan lives at `.qwen/tmp/qwen-review-pr-<n>-fetch.json`, INSIDE
      // the directory the sandbox mounts read-write, and the base tree is
      // its sibling. The reviewed code's move: rewrite the executable the
      // A/B will run IN PLACE (no membership change, HEAD unmoved) and
      // refresh the marker to whatever it likes. A marker-authenticated
      // fence passed both; under the record the marker is noise and the
      // rewrite moves the file's ctime, which no syscall can set back.
      const tree = baseWorktreePath(worktree);
      planPath = join(repo, '.qwen', 'tmp', 'qwen-review-pr-1-fetch.json');
      writeFileSync(
        planPath,
        JSON.stringify({ mergeBaseSha: baseSha, files: [] }),
      );
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        if (builds.length === 1) {
          // The residue a real build leaves, recorded host-side as legitimate.
          mkdirSync(join(w, 'dist'), { recursive: true });
          writeFileSync(join(w, 'dist', 'cli.js'), 'built by round 1');
        }
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);

      writeFileSync(
        join(tree, 'dist', 'cli.js'),
        'planted by the reviewed code, in place',
      );
      writeFileSync(join(tree, '.qwen-review-base-ok'), `${baseSha}\nforged\n`);

      const second = run({}, build);
      expect(second.note).not.toContain('reusing it');
      expect(second.note).toContain(
        'no longer holds exactly what this run recorded',
      );
      expect(builds).toEqual([tree]); // declined, not destroyed
      // The cross-run sweep is what collects the plant: the next capture
      // rotates the run's trust state, and the rebuild discards the tree.
      nextRun();
      const third = run({}, build);
      expect(third.available).toBe(true);
      expect(builds).toEqual([tree, tree]);
      expect(existsSync(join(tree, 'dist', 'cli.js'))).toBe(false);
    },
  );

  itWhereContainmentExists(
    'ignores markers planted inside the tree — certification comes from the host-side record',
    () => {
      // Both markers, planted with a copied sha, on a tree stood up by hand:
      // everything a mount-local writer can produce. The failed one settles
      // nothing (the settled answer is read from the host-side record, which
      // a plant cannot supply) and the ok one certifies nothing — what a
      // planted marker on an unrecorded tree gets is the rebuild any
      // leftover gets.
      const tree = baseWorktreePath(worktree);
      git(repo, 'worktree', 'add', '--detach', '-q', tree, baseSha);
      writeFileSync(join(tree, '.qwen-review-base-ok'), `${baseSha}\n`);
      writeFileSync(join(tree, '.qwen-review-base-failed'), `${baseSha}\n`);

      const builds: string[] = [];
      const r = run({}, (w) => {
        builds.push(w);
        return okBuild;
      });
      expect(r.note).not.toContain('already failed');
      expect(builds).toEqual([tree]); // the rebuild was attempted
      expect(r.available).toBe(true);
    },
  );

  itWhereContainmentExists(
    'sees a recorded file DELETED from the tree — the compare is two-way (R1-2)',
    () => {
      // `dist/cli.js` is, in this module's own words, "exactly what a
      // host-side A/B executes". Iterating only the CURRENT inventory made
      // its removal invisible: the base side then ran against a tree missing
      // its built executable and read as "fails on base too", suppressing a
      // real finding. The addition and in-place-rewrite halves were both
      // caught and tested; this half was caught by neither.
      const tree = baseWorktreePath(worktree);
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        if (builds.length === 1) {
          mkdirSync(join(w, 'dist'), { recursive: true });
          writeFileSync(join(w, 'dist', 'cli.js'), 'built');
        }
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);
      expect(run({}, build).note).toContain('reusing it'); // the control

      rmSync(join(tree, 'dist', 'cli.js'));

      const second = run({}, build);
      expect(second.available).toBe(false);
      expect(second.note).toContain(
        'no longer holds exactly what this run recorded',
      );
      expect(builds).toEqual([tree]); // declined, never swept
    },
  );

  itWhereContainmentExists(
    'records a filename holding a non-UTF-8 byte instead of dying on it (R1-26)',
    () => {
      // `ls-files -z` exists to preserve a byte-exact filename, and decoding
      // its output as utf8 threw that away: one 0xff byte became U+FFFD, the
      // `lstat` of the decoded name failed ENOENT, and the whole enumeration
      // threw — so the build landed NO record and every later shard declined.
      // One `touch` inside the mount suppressed the A/B lane for the round
      // through a note that reads as infrastructure.
      const tree = baseWorktreePath(worktree);
      const odd = Buffer.concat([
        Buffer.from('plant-'),
        Buffer.from([0xff]),
        Buffer.from('-name.js'),
      ]);
      const oddIn = (dir: string): Buffer =>
        Buffer.concat([Buffer.from(`${dir}/`), odd]);
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        if (builds.length === 1) {
          writeFileSync(oddIn(w) as unknown as string, 'built');
        }
        return okBuild;
      };
      const first = run({}, build);
      expect(first.available).toBe(true);
      // The record LANDED, with the odd name in it — the thing the throw
      // used to prevent.
      const recorded = builtTreeRecord(
        baseTreeTrustPath(worktree, planPath),
        tree,
      );
      expect(recorded?.state).toBe('ok');
      expect(Object.keys(recorded!.untracked)).toContain(
        odd.toString('latin1'),
      );
      // ...and the fence still works over it: reuse holds, and a rewrite of
      // that same byte-exact path declines.
      expect(run({}, build).note).toContain('reusing it');
      writeFileSync(oddIn(tree) as unknown as string, 'planted in place');
      expect(run({}, build).note).toContain(
        'no longer holds exactly what this run recorded',
      );
      expect(builds).toEqual([tree]);
    },
  );

  itWhereContainmentExists(
    'sees inside a nested repository git collapses to one entry (R2-1)',
    () => {
      // `ls-files --others` stops descending at a nested repository and emits
      // the single entry `dir/`. A dependency fetched from a git URL, a
      // submodule materialised during install, or a `git init` inside the
      // mount all produce one — and the record then held ONE directory stat
      // for the whole subtree, so anything added, removed or rewritten
      // inside it moved nothing the compare reads.
      const tree = baseWorktreePath(worktree);
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        if (builds.length === 1) {
          const nested = join(w, 'node_modules', 'dep');
          mkdirSync(nested, { recursive: true });
          execFileSync('git', ['init', '-q'], { cwd: nested });
          writeFileSync(join(nested, 'index.js'), 'built');
        }
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);
      // The premise, pinned rather than assumed: git really does collapse it.
      const listed = execFileSync(
        'git',
        ['ls-files', '--others', '--exclude-standard'],
        { cwd: tree, encoding: 'utf8' },
      );
      expect(listed).toContain('node_modules/dep/');
      expect(listed).not.toContain('node_modules/dep/index.js');
      // ...and the fence walked it anyway.
      const recorded = builtTreeRecord(
        baseTreeTrustPath(worktree, planPath),
        tree,
      );
      expect(Object.keys(recorded!.untracked)).toContain(
        'node_modules/dep/index.js',
      );
      // ...and NOT the nested repository's own `.git`. That is git's
      // bookkeeping, not build output: recording every loose object would
      // re-stat them on every ask, and an ordinary git command inside that
      // repository rewrites them — so an honest repository's housekeeping
      // would read as tampering.
      expect(
        Object.keys(recorded!.untracked).filter((k) =>
          k.startsWith('node_modules/dep/.git/'),
        ),
      ).toEqual([]);
      expect(run({}, build).note).toContain('reusing it'); // the control

      writeFileSync(
        join(tree, 'node_modules', 'dep', 'index.js'),
        'planted inside the nested repository',
      );
      const second = run({}, build);
      expect(second.available).toBe(false);
      expect(second.note).toContain(
        'no longer holds exactly what this run recorded',
      );
    },
  );

  itWhereContainmentExists(
    'sees a rewrite of a symlink TARGET that lies outside the tree (R2-3)',
    () => {
      // `lstat` describes the LINK, which is right for spotting a planted
      // link and wrong for describing what the A/B's base side executes:
      // rewriting the target moves neither the link's size nor its ctime,
      // and a target outside the tree is never enumerated on its own
      // account. So the artifact that actually runs could be replaced with
      // the fence reporting the tree unchanged.
      const outside = join(repo, 'outside-bin.js');
      writeFileSync(outside, 'the real thing');
      const tree = baseWorktreePath(worktree);
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        if (builds.length === 1) {
          mkdirSync(join(w, 'node_modules', '.bin'), { recursive: true });
          symlinkSync(outside, join(w, 'node_modules', '.bin', 'tool'));
        }
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);
      expect(run({}, build).note).toContain('reusing it'); // the control

      // The link is untouched; only what it points at changes.
      writeFileSync(outside, 'planted by the reviewed code');

      const second = run({}, build);
      expect(second.available).toBe(false);
      expect(second.note).toContain(
        'no longer holds exactly what this run recorded',
      );
      expect(builds).toEqual([tree]);
    },
  );

  itWhereContainmentExists(
    're-asks the pointer question in the window before the index refresh (R1-60)',
    () => {
      // The entry check answers about the pointer as it stood THEN; the
      // inventory walk between the two is ~1 s on a real tree, and a sibling
      // tree under the same read-write mount is enough to rewrite
      // `<base>/.git` inside it. `git status` REFRESHES THE INDEX, which
      // runs the resolved repository's `filter.<driver>.clean` — on the
      // host, as the review user. The seam stages exactly that window.
      const tree = baseWorktreePath(worktree);
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);
      expect(run({}, build).note).toContain('reusing it'); // the control

      const second = run(
        {
          onReuseWindow: () => {
            plantAdminEntry(
              join(repo, '.qwen', 'tmp', '.evil-git'),
              adminEntryOf(tree),
              tree,
              join(repo, '.git'),
            );
          },
        },
        build,
      );
      expect(second.available).toBe(false);
      expect(second.note).toContain('rewritten while this ask was measuring');
      expect(builds).toEqual([tree]); // declined, never swept
    },
  );

  itWhereContainmentExists(
    'treats a WARNING on an exit-0 listing as incomplete, never as a baseline (R2-2)',
    () => {
      // `git ls-files` reports a directory it could not read as `warning:
      // unable to readdir …`, SKIPS that subtree, and still exits 0. Reading
      // stderr only on the non-zero branch therefore recorded a baseline
      // that silently omitted every path under it — after which anything
      // dropped there was invisible to the fence, in both directions and
      // with no note.
      //
      // Driven by a `git` shim rather than by `chmod`: this suite runs as
      // root in the CI image, where mode bits stop nothing.
      const tree = baseWorktreePath(worktree);
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        if (builds.length === 1) {
          mkdirSync(join(w, 'dist'), { recursive: true });
          writeFileSync(join(w, 'dist', 'cli.js'), 'built');
        }
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);
      expect(run({}, build).note).toContain('reusing it'); // the control

      const shimDir = join(repo, 'git-shim-warn');
      mkdirSync(shimDir, { recursive: true });
      const realGit = execFileSync('sh', ['-c', 'command -v git'], {
        encoding: 'utf8',
      }).trim();
      writeFileSync(
        join(shimDir, 'git'),
        `#!/bin/sh\n` +
          `for a in "$@"; do\n` +
          `  if [ "$a" = ls-files ]; then\n` +
          `    ${realGit} "$@"; st=$?\n` +
          `    echo "warning: unable to readdir 'node_modules/x': Permission denied" >&2\n` +
          `    exit $st\n` +
          `  fi\n` +
          `done\n` +
          `exec ${realGit} "$@"\n`,
        { mode: 0o755 },
      );
      const savedPath = process.env['PATH'];
      let warned: BaseTreeReport;
      try {
        process.env['PATH'] = `${shimDir}:${savedPath}`;
        // The premise, pinned rather than assumed: the shim really does warn
        // on stderr while exiting 0.
        const probe = spawnSync(
          'git',
          ['ls-files', '--others', '--exclude-standard'],
          { cwd: tree, encoding: 'utf8' },
        );
        expect(probe.status).toBe(0);
        expect(probe.stderr).toContain('unable to readdir');
        warned = run({}, build);
      } finally {
        process.env['PATH'] = savedPath;
      }
      // Declined — and NOT swept: "could not enumerate" is not evidence
      // worth destroying a live tree over.
      expect(warned.available).toBe(false);
      expect(warned.note).toContain(
        'no longer holds exactly what this run recorded',
      );
      expect(builds).toEqual([tree]);
      expect(existsSync(join(tree, 'dist', 'cli.js'))).toBe(true);

      // The BUILD-side listing is the one that writes the baseline, and it
      // matters more: a short listing recorded there is a baseline that
      // silently omits a whole subtree, after which anything dropped in it is
      // invisible in both directions. Same shim, a fresh run, and the record
      // must not land.
      rmSync(trustPathFor(), { force: true });
      rmSync(tree, { recursive: true, force: true });
      const buildBuilds: string[] = [];
      try {
        process.env['PATH'] = `${shimDir}:${savedPath}`;
        const built = run({}, (w) => {
          buildBuilds.push(w);
          mkdirSync(join(w, 'dist'), { recursive: true });
          writeFileSync(join(w, 'dist', 'cli.js'), 'built');
          return okBuild;
        });
        // The build ran; the certification did not follow it — and the call
        // itself refuses, rather than returning `available: true` with no
        // record behind it. A residue walk that cannot complete leaves
        // nothing to certify the tree against, and every other arm here
        // treats "could not enumerate" as a refusal.
        expect(buildBuilds).toEqual([tree]);
        expect(built.available).toBe(false);
        expect(built.note).toContain('residue could not be enumerated');
      } finally {
        process.env['PATH'] = savedPath;
      }
      expect(builtTreeRecord(trustPathFor(), tree)).toBeNull();
    },
  );

  itWhereContainmentExists(
    'refuses a plan naming a base the CAPTURE never resolved (R1-50)',
    () => {
      // The pin authenticates the plan against the FIRST ask's reading of
      // it — but the containerized build/test phase holds the plan
      // read-write and runs BEFORE any base-tree ask exists, so that first
      // reading is already the mount's choice. Rewriting `mergeBaseSha` to
      // the PR head (a real commit, so `worktree add` succeeds) made the run
      // build, certify and pin a "base" the PR chose, after which both A/B
      // arms emit identical output and every real difference reads as
      // pre-existing. The capture's own answer is recorded host-side.
      recordReviewWorktreeLeaseMergeBase(repo, 'pr-1', baseSha);

      // The honest plan agrees with it and builds.
      expect(run({}, () => okBuild).available).toBe(true);

      // The reviewed code's move: point the plan at the PR head instead.
      const builds: string[] = [];
      const hijacked = run({ plan: { mergeBaseSha: headSha } }, (w) => {
        builds.push(w);
        return okBuild;
      });
      expect(hijacked.available).toBe(false);
      expect(hijacked.note).toContain('capture recorded');
      expect(builds).toEqual([]); // nothing was built at the chosen sha
    },
  );

  itWhereContainmentExists(
    'does not let a record OUTLIVE the tree it certifies (R1-9)',
    () => {
      // `trees` is keyed by PATH and the base tree's path is fixed for the
      // review, so an entry that survives the sweep goes on describing a
      // generation that no longer exists. The rebuild drops it before the
      // sweep, so a rebuild that then records nothing — this one throws
      // mid-build, the budget-truncated one returns early — leaves no
      // certification behind rather than the previous generation's.
      const tree = baseWorktreePath(worktree);
      const trustPath = baseTreeTrustPath(worktree, planPath || writePlan());
      let round = 0;
      const build = (w: string) => {
        round += 1;
        if (round === 1) {
          mkdirSync(join(w, 'dist'), { recursive: true });
          writeFileSync(join(w, 'dist', 'cli.js'), 'built by round 1');
          return okBuild;
        }
        throw new Error('the build died here');
      };
      expect(run({}, build).available).toBe(true);
      expect(builtTreeRecord(trustPath, tree)?.state).toBe('ok');

      // Force the rebuild: a rewritten pointer has no benign cause, so this
      // arm sweeps rather than declining.
      plantAdminEntry(
        join(repo, '.qwen', 'tmp', '.evil-git'),
        adminEntryOf(tree),
        tree,
        join(repo, '.git'),
      );
      expect(() => run({}, build)).toThrow('the build died here');

      // The tree the record described is gone, and so is the record.
      expect(builtTreeRecord(trustPath, tree)).toBeNull();
    },
  );

  itWhereContainmentExists(
    'records IGNORED paths, which are essentially the whole real inventory (R1-12)',
    () => {
      // A built tree's untracked surface is `node_modules/` and `dist/`, and
      // both are gitignored — measured at ~103k of ~103k entries in this
      // repository. A suite whose only fixtures are non-ignored files never
      // touches the listing that carries the fence.
      const tree = baseWorktreePath(worktree);
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        if (builds.length === 1) {
          writeFileSync(join(w, '.gitignore'), 'ign/\n');
          mkdirSync(join(w, 'ign'), { recursive: true });
          writeFileSync(join(w, 'ign', 'payload.js'), 'built');
        }
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);
      // The premise, pinned rather than assumed: git really does treat it as
      // ignored, so this case is about the ignored listing and not about a
      // plain untracked file wearing an ignored-looking name.
      expect(
        execFileSync('git', ['check-ignore', 'ign/payload.js'], {
          cwd: tree,
          encoding: 'utf8',
        }).trim(),
      ).toBe('ign/payload.js');
      const recorded = builtTreeRecord(
        baseTreeTrustPath(worktree, planPath),
        tree,
      );
      expect(Object.keys(recorded!.untracked)).toContain('ign/payload.js');
      expect(run({}, build).note).toContain('reusing it'); // the control

      writeFileSync(join(tree, 'ign', 'payload.js'), 'planted in place');
      expect(run({}, build).note).toContain(
        'no longer holds exactly what this run recorded',
      );
    },
  );

  itWhereContainmentExists(
    'keys on ctime, which userland cannot set back — mtime alone would forge (R1-40)',
    () => {
      // `BuiltTreeStat.ctimeMs` exists because a forged mtime is one
      // `utimensat` away while ctime is not settable from userland at all.
      // The suite only ever drove rewrites that moved BOTH, so nothing
      // pinned the difference. Both halves are pinned here, and the first is
      // the reason the second is safe.
      const tree = baseWorktreePath(worktree);
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        if (builds.length === 1) {
          mkdirSync(join(w, 'dist'), { recursive: true });
          writeFileSync(join(w, 'dist', 'cli.js'), 'built');
        }
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);
      const target = join(tree, 'dist', 'cli.js');

      // HALF ONE — the mechanism, measured rather than asserted from docs:
      // `utimesSync` sets mtime to any value the caller likes AND moves
      // ctime to now as a side effect. So there is no "set mtime back"
      // primitive to forge with, which is the whole argument for the field.
      const before = statSync(target);
      const backdated = new Date(Date.now() - 3_600_000);
      utimesSync(target, backdated, backdated);
      const after = statSync(target);
      expect(after.mtimeMs).toBeLessThan(before.mtimeMs); // mtime obeyed
      expect(after.ctimeMs).toBeGreaterThanOrEqual(before.ctimeMs); // ctime did not
      expect(after.ctimeMs).not.toBe(before.ctimeMs);

      // HALF TWO — and because ctime moved, the fence sees the touch even
      // though the CONTENT and the SIZE are both unchanged. A record keyed
      // on mtime would have been walked straight back past.
      expect(after.size).toBe(before.size);
      expect(run({}, build).note).toContain(
        'no longer holds exactly what this run recorded',
      );
      expect(builds).toEqual([tree]); // declined, never swept
    },
  );

  itWhereContainmentExists(
    'rebuilds when HEAD moved under a recorded tree — the other no-benign-cause arm (R1-41)',
    () => {
      // The arm is `pointerWhy !== null || rev-parse HEAD !== baseSha`, and
      // only the pointer half had a fixture. A moved HEAD has no benign
      // cause either — this run's build does not move it and a concurrent
      // A/B does not either — so it sweeps rather than declining.
      const tree = baseWorktreePath(worktree);
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);
      expect(run({}, build).note).toContain('reusing it'); // the control

      // The reviewed code's move, inside the mount it holds: check the base
      // tree out at the PR head instead of the merge base.
      execFileSync('git', ['checkout', '-q', '--detach', headSha], {
        cwd: tree,
      });
      expect(
        execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: tree,
          encoding: 'utf8',
        }).trim(),
      ).toBe(headSha);

      const second = run({}, build);
      expect(second.available).toBe(true);
      expect(second.note).not.toContain('reusing it');
      expect(builds).toEqual([tree, tree]); // swept and rebuilt, not declined
      expect(
        execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: tree,
          encoding: 'utf8',
        }).trim(),
      ).toBe(baseSha);
    },
  );

  itWhereContainmentExists(
    'survives a file that vanishes between the listing and the stat (race)',
    () => {
      // A concurrent shard running an A/B in this tree removes cache files
      // while the walk is in flight, so `lstat` answering ENOENT for a path
      // git listed a moment earlier is ordinary churn — not evidence. A
      // throw there lands NO record at build time, and every later shard
      // then declines for the rest of the round: the A/B lane killed by one
      // file that moved.
      //
      // Staged with a `git` shim that lists one extra path which does not
      // exist, which is the same thing the race produces and needs no timing.
      const tree = baseWorktreePath(worktree);
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        if (builds.length === 1) {
          mkdirSync(join(w, 'dist'), { recursive: true });
          writeFileSync(join(w, 'dist', 'cli.js'), 'built');
        }
        return okBuild;
      };
      const shimDir = join(repo, 'git-shim-ghost');
      mkdirSync(shimDir, { recursive: true });
      const realGit = execFileSync('sh', ['-c', 'command -v git'], {
        encoding: 'utf8',
      }).trim();
      writeFileSync(
        join(shimDir, 'git'),
        `#!/bin/sh\n` +
          `for a in "$@"; do\n` +
          `  if [ "$a" = ls-files ]; then\n` +
          `    ${realGit} "$@" || exit $?\n` +
          `    printf 'dist/vanished.js\\0'\n` +
          `    exit 0\n` +
          `  fi\n` +
          `done\n` +
          `exec ${realGit} "$@"\n`,
        { mode: 0o755 },
      );
      const savedPath = process.env['PATH'];
      let first: BaseTreeReport;
      let second: BaseTreeReport;
      try {
        process.env['PATH'] = `${shimDir}:${savedPath}`;
        first = run({}, build);
        second = run({}, build);
      } finally {
        process.env['PATH'] = savedPath;
      }
      // The build was certified — the record LANDED despite the ghost.
      expect(first.available).toBe(true);
      const recorded = builtTreeRecord(
        baseTreeTrustPath(worktree, planPath),
        tree,
      );
      expect(recorded?.state).toBe('ok');
      expect(Object.keys(recorded!.untracked)).toContain('dist/cli.js');
      expect(Object.keys(recorded!.untracked)).not.toContain(
        'dist/vanished.js',
      );
      // ...and the lane is alive: the next ask reuses rather than declining.
      expect(second.note).toContain('reusing it');
      expect(builds).toEqual([tree]);
    },
  );

  itWhereContainmentExists(
    'refuses when the capture recorded NO merge base host-side (R1-50)',
    () => {
      // The anchor's absence used to be a pass, which handed the
      // mount-writable plan back its sole authority over the sha the run
      // builds, certifies and pins — on exactly the rounds where the capture
      // could not record one. The whole of the original hole, on a branch
      // that merely looked like an edge case.
      rmSync(join(repo, '.qwen', 'review-leases'), {
        recursive: true,
        force: true,
      });
      createReviewWorktreeLease({
        sessionId: 's',
        promptId: 'p',
        target: 'pr-1',
        repositoryRoot: repo,
        worktreePath: worktree,
        branch: 'qwen-review/pr-1',
      });
      const builds: string[] = [];
      const r = run({}, (w) => {
        builds.push(w);
        return okBuild;
      });
      expect(r.available).toBe(false);
      expect(r.note).toContain('recorded no merge base host-side');
      expect(builds).toEqual([]); // nothing built at a sha nobody vouched for
    },
  );

  it('refuses a mergeBaseSha that is not a full object name, before any git call', () => {
    // Everything downstream — `worktree add`, the `rev-parse HEAD` compare,
    // the note text — takes this string from the plan on trust, and the plan
    // is inside the mount. Checked independently of the host-side anchor, so
    // a lease that carries no base cannot make this the only line of defence.
    for (const bad of [
      'HEAD',
      '../../etc',
      baseSha.slice(0, 7),
      'Z'.repeat(40),
    ]) {
      const r = run({ plan: { mergeBaseSha: bad } });
      expect(r.available).toBe(false);
      expect(r.note).toContain('not a full object name');
    }
    // ...and the SHA-256 form is NOT malformed. Every sibling validator in
    // this pipeline accepts 40 or 64, and a repository created with
    // `--object-format=sha256` resolves a genuine 64-hex merge base — a
    // 40-only gate here would accuse an honest capture of tampering and kill
    // the A/B lane for every round of every such review. It gets past the
    // shape gate and is refused later, by the host-side anchor, for a
    // different and true reason.
    const r256 = run({ plan: { mergeBaseSha: 'a'.repeat(64) } });
    expect(r256.note).not.toContain('not a full object name');
  });

  itWhereContainmentExists(
    'rules the anchor BEFORE the pin, so a tampered first ask leaves no pin (R3-2)',
    () => {
      // Pinned first, the tampered sha became the run's authoritative pin and
      // every later HONEST capture in the session was declined as "the plan
      // moved" — the attack's cost landing on the operator after the attack
      // ended, with no recovery short of a real rebase.
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        return okBuild;
      };
      // Round 1: the mount rewrote the plan before the run's first ask.
      const hijacked = run({ plan: { mergeBaseSha: headSha } }, build);
      expect(hijacked.available).toBe(false);
      expect(hijacked.note).toContain('capture recorded');
      expect(builds).toEqual([]);

      // Round 2: the honest plan, same session, same identity. It must work.
      const honest = run({ plan: { mergeBaseSha: baseSha } }, build);
      expect(honest.available).toBe(true);
      expect(honest.note).not.toContain('the plan now names a different');
      expect(builds).toEqual([tree()]);
    },
  );

  itWhereContainmentExists(
    'is BUSY, not torn, while a sibling holds the build lock (R3-1)',
    () => {
      // `worktree add` creates the tree as its first act and the record lands
      // only after the whole install+build, so "the tree exists with no
      // record" is the ORDINARY state for the several minutes of the first
      // build. Answering the torn-write decline there was a false claim whose
      // prescribed recovery ("remove the tree") is the concurrent-shard
      // clobber this fast path exists to prevent — and which the agent briefs
      // forbid verbatim.
      const t = tree();
      // The state a builder leaves mid-flight: its lock held, its tree
      // created by `worktree add`, and no record yet — with the trust file
      // already minted by an earlier shard, so this ask is `adopted`, which
      // is the arm under test.
      expect(run({}, () => okBuild).available).toBe(true);
      dropBuiltTree(
        baseTreeTrustPath(worktree, planPath),
        runIdentity(worktree).identity,
        t,
      );
      expect(
        builtTreeRecord(baseTreeTrustPath(worktree, planPath), t),
      ).toBeNull();
      mkdirSync(`${t}.lock`);
      try {
        const r = run({}, () => okBuild);
        expect(r.available).toBe(false);
        expect(r.note).toContain('another probe is building the base tree');
        expect(r.note).not.toContain('remove');
      } finally {
        rmSync(`${t}.lock`, { recursive: true, force: true });
      }
    },
  );

  itWhereContainmentExists(
    'refuses to certify under an ancestor node_modules inside the mount (R3-3)',
    () => {
      // The fence bounds itself to the tree, and the tree's own parent is the
      // directory the sandbox hands the reviewed code read-write. npm
      // prepends every ancestor `node_modules/.bin` ahead of the inherited
      // PATH and Node resolves bare specifiers by walking ancestors, so a
      // plant one level up wins for every command the shard runs IN the
      // certified tree — on the host, outside the container, without ever
      // touching the tree.
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);
      expect(run({}, build).note).toContain('reusing it'); // the control

      const planted = join(repo, '.qwen', 'tmp', 'node_modules', '.bin');
      mkdirSync(planted, { recursive: true });
      writeFileSync(join(planted, 'node'), '#!/bin/sh\necho PWNED\n');

      const second = run({}, build);
      expect(second.available).toBe(false);
      expect(second.note).toContain('module resolution state');
      expect(builds).toEqual([tree()]); // refused, never swept
    },
  );

  it('does not SETTLE a build that produced nothing (R3-4)', () => {
    // The build's scope comes from the plan's `files`, which lives inside the
    // mount before any base-tree ask exists. Rewriting it to `[]` made
    // `runBuildTest` answer `ok: true` with an empty build list, and
    // recording THAT as `failed` settled the A/B lane as "infrastructure" for
    // the whole run — host-side, in the record this module presents as the
    // thing a mount cannot supply. It could not forge the record, so it chose
    // its content instead.
    const builds: string[] = [];
    const emptyBuild = (w: string) => {
      builds.push(w);
      return { ...okBuild, build: [] } as unknown as BuildTestReport;
    };
    const first = run({}, emptyBuild);
    expect(first.available).toBe(false);
    expect(first.note).toContain('built nothing');
    expect(first.note).not.toContain('did not build');

    // Not settled: the next shard repays the build rather than being served
    // the suppression.
    const second = run({}, emptyBuild);
    expect(second.available).toBe(false);
    expect(second.note).not.toContain('already failed');
    expect(builds).toHaveLength(2);

    // The control: a build that genuinely FAILED is still settled once.
    const failBuilds: string[] = [];
    const failing = (w: string) => {
      failBuilds.push(w);
      return { ...okBuild, ok: false } as unknown as BuildTestReport;
    };
    run({}, failing);
    const settled = run({}, failing);
    expect(settled.note).toContain('already failed');
    expect(failBuilds).toHaveLength(1);
  });

  itWhereContainmentExists(
    'watches an escaping target whose PATH holds a non-ASCII byte (R2-3a)',
    () => {
      // The target was resolved to a `latin1` string and handed to `statSync`
      // as a string, which re-encodes it as UTF-8 — so any byte >= 0x80
      // anywhere on the path (a non-ASCII home directory is enough) addressed
      // a path that does not exist, the catch recorded the DANGLING sentinel
      // for a live target, and a later rewrite recomputed the same sentinel
      // and compared equal.
      const oddDir = join(repo, 'outäside');
      mkdirSync(oddDir, { recursive: true });
      const outside = join(oddDir, 'bin.js');
      writeFileSync(outside, 'the real thing');
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        if (builds.length === 1) {
          mkdirSync(join(w, 'node_modules', '.bin'), { recursive: true });
          symlinkSync(outside, join(w, 'node_modules', '.bin', 'tool'));
        }
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);
      // The premise, pinned rather than assumed: a LIVE target was recorded,
      // not the dangling sentinel.
      const rec = builtTreeRecord(
        baseTreeTrustPath(worktree, planPath),
        tree(),
      )!.untracked['node_modules/.bin/tool'];
      expect(rec.targetSize).toBe('the real thing'.length);
      expect(run({}, build).note).toContain('reusing it'); // the control

      writeFileSync(outside, 'planted by the reviewed code');
      const second = run({}, build);
      expect(second.available).toBe(false);
      expect(second.note).toContain(
        'no longer holds exactly what this run recorded',
      );
    },
  );

  itWhereContainmentExists(
    'refuses a tree holding an escaping link to a DIRECTORY (R2-3b)',
    () => {
      // A directory's own size and ctime do not move when a child is
      // rewritten in place, so the recorded pair says nothing about what the
      // base side would execute through the link. Recorded as undescribable
      // and refused, rather than papered over with a pair that cannot bite.
      const outsideDir = join(repo, 'outside-pkg');
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(outsideDir, 'run.js'), 'the real thing');
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        if (builds.length === 1) {
          mkdirSync(join(w, 'node_modules'), { recursive: true });
          symlinkSync(outsideDir, join(w, 'node_modules', 'pkg'));
        }
        return okBuild;
      };
      const first = run({}, build);
      expect(first.available).toBe(false);
      expect(first.note).toContain('target is a DIRECTORY outside the tree');
      expect(builds).toEqual([tree()]); // refused, never swept
    },
  );

  itWhereContainmentExists(
    'resolves a link before judging whether it escapes (R2-3c)',
    () => {
      // `node_modules/.bin/tool -> ../pkg-real` is lexically INSIDE the tree,
      // so a lexical test recorded no target pair for it — while `pkg-real`
      // is itself a link out, so the file that actually runs is outside the
      // tree and was unwatched. The realpath answers where the bytes are; the
      // spelling only answers where the name points.
      const outside = join(repo, 'vendor-out.js');
      writeFileSync(outside, 'the real thing');
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        if (builds.length === 1) {
          mkdirSync(join(w, 'node_modules', '.bin'), { recursive: true });
          symlinkSync(outside, join(w, 'node_modules', 'pkg-real'));
          symlinkSync('../pkg-real', join(w, 'node_modules', '.bin', 'tool'));
        }
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);

      const rec = builtTreeRecord(
        baseTreeTrustPath(worktree, planPath),
        tree(),
      )!.untracked['node_modules/.bin/tool'];
      // The premise, pinned rather than assumed: the leaf really is lexically
      // in-tree, and its target pair was recorded anyway.
      expect(rec.link).toBe('../pkg-real');
      expect(rec.targetSize).toBe('the real thing'.length);
      expect(run({}, build).note).toContain('reusing it'); // the control

      writeFileSync(outside, 'planted by the reviewed code');
      const second = run({}, build);
      expect(second.available).toBe(false);
      expect(second.note).toContain(
        'no longer holds exactly what this run recorded',
      );
      expect(builds).toEqual([tree()]);
    },
  );

  itWhereContainmentExists(
    'refuses at RECORD time too when the ancestor plant predates the build (R3-3)',
    () => {
      // The plant is written during the containerized build/test phase, which
      // runs BEFORE the base tree is built — so the first ask to see it is
      // the one that would otherwise write the record. Certifying there and
      // refusing only on reuse would hand the very first shard a tree whose
      // commands resolve from a directory the reviewed code holds.
      const planted = join(repo, '.qwen', 'tmp', 'node_modules', '.bin');
      mkdirSync(planted, { recursive: true });
      writeFileSync(join(planted, 'node'), '#!/bin/sh\necho PWNED\n');

      const builds: string[] = [];
      const r = run({}, (w) => {
        builds.push(w);
        return okBuild;
      });
      expect(r.available).toBe(false);
      expect(r.note).toContain('module resolution state');
      // The build ran (the tree was created), and NOTHING was recorded for
      // it — so no later shard can reuse what this ask refused to certify.
      expect(builds).toEqual([tree()]);
      expect(
        builtTreeRecord(baseTreeTrustPath(worktree, planPath), tree()),
      ).toBeNull();
    },
  );

  itWhereContainmentExists(
    'refuses — never certifies — when the residue walk throws (R4-1)',
    () => {
      // `built === null` meant the walk threw, and the code then SKIPPED the
      // undescribable check and still returned `available: true` — the fence
      // failing open in the one direction it fails closed everywhere else.
      // Both halves are staged together here: a live escaping link to a
      // DIRECTORY (the entry the skipped check exists to refuse) AND a
      // listing that cannot be completed.
      //
      // The enumeration failure is driven by a `git` shim rather than by
      // `chmod`, for the reason the R2-2 case gives: this suite runs as root
      // in the CI image, where mode bits stop nothing.
      const outsideDir = join(repo, 'outside-pkg');
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(outsideDir, 'run.js'), 'the real thing');
      const shimDir = join(repo, 'git-shim-r41');
      mkdirSync(shimDir, { recursive: true });
      const realGit = execFileSync('sh', ['-c', 'command -v git'], {
        encoding: 'utf8',
      }).trim();
      writeFileSync(
        join(shimDir, 'git'),
        `#!/bin/sh\n` +
          `for a in "$@"; do\n` +
          `  if [ "$a" = ls-files ]; then\n` +
          `    ${realGit} "$@"; st=$?\n` +
          `    echo "warning: unable to readdir 'nested/locked'" >&2\n` +
          `    exit $st\n` +
          `  fi\n` +
          `done\n` +
          `exec ${realGit} "$@"\n`,
        { mode: 0o755 },
      );
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        mkdirSync(join(w, 'node_modules'), { recursive: true });
        symlinkSync(outsideDir, join(w, 'node_modules', 'pkg'));
        return okBuild;
      };
      const savedPath = process.env['PATH'];
      let r: BaseTreeReport;
      try {
        process.env['PATH'] = `${shimDir}:${savedPath}`;
        r = run({}, build);
      } finally {
        process.env['PATH'] = savedPath;
      }

      expect(r.available).toBe(false);
      expect(r.note).toContain('residue could not be enumerated');
      expect(builds).toEqual([tree()]);
      // Nothing certified, and nothing recorded for a later shard to reuse.
      expect(
        builtTreeRecord(baseTreeTrustPath(worktree, planPath), tree()),
      ).toBeNull();
    },
  );

  it('does not SETTLE a build killed by its own deadline, or refused (R4-2)', () => {
    // `runBuildTest` answers `ok: false` for two shapes that are explicitly
    // not facts about the sha, and the settled `failed` state is re-served to
    // every later shard with no rebuild: a per-command TIMEOUT (whose own
    // note says "an infrastructure result, not a defect in the diff", and
    // whose default deadline here is below the budget module's documented
    // slowest command), and a sandbox REFUSAL that ran no command at all.
    for (const shape of [
      { ok: false, timedOut: ['npm run build --workspace=packages/cli'] },
      { ok: false, toolchain: 'refused', build: [], timedOut: [] },
    ]) {
      planPath = '';
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        return { ...okBuild, ...shape } as unknown as BuildTestReport;
      };
      const first = run({}, build);
      expect(first.available).toBe(false);
      const second = run({}, build);
      expect(second.note).not.toContain('already failed');
      expect(builds).toHaveLength(2); // repaid, not settled
    }
  });

  itWhereContainmentExists(
    'bounds the ancestor walk at the OUTERMOST review temp dir (R3-3)',
    () => {
      // Resolution walks EVERY ancestor, not the nearest one — so bounding
      // at the innermost `.qwen/tmp` marker stopped one directory short of
      // the outer review's read-write temp dir in the nested geometry, which
      // is the directory the OUTER reviewed code holds.
      const inner = join(repo, '.qwen', 'tmp', 'review-pr-9', '.qwen', 'tmp');
      mkdirSync(inner, { recursive: true });
      const innerWt = join(inner, 'review-pr-1');
      git(repo, 'worktree', 'add', '--detach', '-q', innerWt, headSha);
      createReviewWorktreeLease({
        sessionId: 's',
        promptId: 'p',
        target: 'pr-1',
        repositoryRoot: repo,
        worktreePath: innerWt,
        branch: 'qwen-review/pr-1',
      });
      recordReviewWorktreeLeaseMergeBase(repo, 'pr-1', baseSha);

      // The plant is in the OUTER temp dir — two levels above the inner base
      // tree, and never touched by the inner review at all.
      const planted = join(repo, '.qwen', 'tmp', 'node_modules', '.bin');
      mkdirSync(planted, { recursive: true });
      writeFileSync(join(planted, 'node'), '#!/bin/sh\necho PWNED\n');

      const r = runBaseTree({
        plan: planPath || writePlan(),
        worktree: innerWt,
        timeout: 60,
        install: false,
        build: () => okBuild,
      });
      expect(r.available).toBe(false);
      expect(r.note).toContain('module resolution state');
      expect(r.note).toContain(join(repo, '.qwen', 'tmp', 'node_modules'));
    },
  );

  itWhereContainmentExists(
    'sees inside a REGISTERED submodule, which ls-files omits entirely (R4-4)',
    () => {
      // A gitlink makes `ls-files --others` emit nothing at all for that path
      // — not the files inside it and not even the collapsed `dir/` an
      // UNREGISTERED nested repository gets — and `status -uno` reports a
      // moved pointer but never the content. So the whole subtree was absent
      // from the inventory while the tree was certified around it.
      const sub = mkdtempSync(join(tmpdir(), 'qwen-base-sub-'));
      git(sub, 'init', '-q', '-b', 'main');
      git(sub, 'config', 'user.email', 't@t.t');
      git(sub, 'config', 'user.name', 't');
      writeFileSync(join(sub, 'lib.js'), 'sub\n');
      git(sub, 'add', '-A');
      git(sub, 'commit', '-qm', 'sub');
      git(
        repo,
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        sub,
        'deps/lib',
      );
      git(repo, 'commit', '-qm', 'add submodule');
      baseSha = git(repo, 'rev-parse', 'HEAD');
      planPath = '';
      recordReviewWorktreeLeaseMergeBase(repo, 'pr-1', baseSha);

      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        if (builds.length === 1) {
          git(
            w,
            '-c',
            'protocol.file.allow=always',
            'submodule',
            'update',
            '--init',
            '-q',
          );
          writeFileSync(join(w, 'deps', 'lib', 'built.js'), 'built');
        }
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);

      // The premise, pinned rather than assumed: git really does omit it.
      expect(
        execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
          cwd: tree(),
          encoding: 'utf8',
        }),
      ).not.toContain('deps/lib');
      // ...and the fence enumerated it anyway.
      const rec = builtTreeRecord(
        baseTreeTrustPath(worktree, planPath),
        tree(),
      )!;
      expect(Object.keys(rec.untracked)).toContain('deps/lib/built.js');
      expect(run({}, build).note).toContain('reusing it'); // the control

      writeFileSync(join(tree(), 'deps', 'lib', 'built.js'), 'planted');
      const second = run({}, build);
      expect(second.available).toBe(false);
      expect(second.note).toContain(
        'no longer holds exactly what this run recorded',
      );
      rmSync(sub, { recursive: true, force: true });
    },
  );

  itWhereContainmentExists(
    'refuses the reuse check when the resolved config defines filters (R4-5)',
    () => {
      // The reuse arm's `git status` REFRESHES the index, which runs
      // `filter.<driver>.clean` on the host — and computes its verdict on the
      // filtered bytes rather than on the files, so a rewrite whose filtered
      // form maps back to the indexed blob prints nothing at all. The two
      // `-c` pins cover only the fixed-key channels; this one is enumerated
      // out of the resolved config by the house's own screen.
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);
      expect(run({}, build).note).toContain('reusing it'); // the control

      git(tree(), 'config', 'filter.evil.clean', 'sh -c "echo PWNED >&2"');

      const second = run({}, build);
      expect(second.available).toBe(false);
      expect(second.note).toContain('content filters');
      expect(builds).toEqual([tree()]); // declined, never swept
    },
  );

  it('sweeps a stale lock, keeps a fresh one, and touches nothing when absent (R4-7)', () => {
    // Deciding this on a "is a builder holding it" predicate makes it a
    // check-then-destroy on the hot path: that predicate answers `false` for
    // "no lock" and for "a corpse" alike, so a sibling that takes the lock
    // between the check and the remove has its LIVE lock deleted — after
    // which both shards enter the build and the opening sweep destroys the
    // tree the other is mid-`npm ci` in. The three answers are the
    // distinction, and the no-op removal on an absent path is why nothing
    // downstream can see it.
    const lock = join(repo, 'probe.lock');
    expect(sweepStaleLock(lock, 60_000)).toBe('absent');

    mkdirSync(lock);
    expect(sweepStaleLock(lock, 60_000)).toBe('fresh');
    expect(existsSync(lock)).toBe(true);

    const old = new Date(Date.now() - 3_600_000);
    utimesSync(lock, old, old);
    expect(sweepStaleLock(lock, 60_000)).toBe('removed');
    expect(existsSync(lock)).toBe(false);
  });

  itWhereContainmentExists(
    'writes NOTHING into the tree, and a plant at a marker name settles nothing',
    () => {
      // The in-tree markers are gone, not demoted. Writing one was a
      // host-side write through whatever the reviewed code left at that path
      // for the minutes the containerized build held it: a symlink there
      // made it an arbitrary host-file truncate, and a FIFO made it a hang
      // inside `open(2)` that no surrounding `catch` could reach. Reading
      // one had the same two shapes.
      //
      // So: a successful build leaves no marker at all, and a file the
      // reviewed code plants at either marker's NAME is inventory like any
      // other — an unrecorded extra, which declines. It cannot settle the
      // lane, which is what the forged failed-marker used to do.
      const tree = baseWorktreePath(worktree);
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);
      expect(existsSync(join(tree, '.qwen-review-base-ok'))).toBe(false);
      expect(existsSync(join(tree, '.qwen-review-base-failed'))).toBe(false);
      // The reuse path is live before the plant — the control that tells a
      // working fence from one that declines everything.
      expect(run({}, build).note).toContain('reusing it');

      writeFileSync(join(tree, '.qwen-review-base-failed'), `${baseSha}\n`);

      // It settles NOTHING — which is what this case exists for. It is also
      // tolerated rather than declining, because it is an ADDITION (see the
      // R1-4 case for that decision): the settled answer lives in the
      // host-side record, and a file inside the tree cannot reach it either
      // way.
      const second = run({}, build);
      expect(second.note).not.toContain('already failed');
      expect(second.note).toContain('reusing it');
      expect(builds).toEqual([tree]); // never settled, never swept
    },
  );

  itWhereContainmentExists(
    'does not REUSE a base tree an EARLIER RUN built, whose untracked plants the dirt check cannot see',
    () => {
      // `cleanStale` releases the review worktree and its branch but never
      // `-base`, so this tree stands into the next round with a whole
      // containerized build/test phase in between — and inside the mount the
      // reviewed code writes where it likes. What it can drop there is
      // untracked executable content, `dist/cli.js` and `node_modules/.bin/`
      // being exactly what a host-side A/B measurement runs, and
      // `--untracked-files=no` cannot see it: a blanket untracked refusal
      // would disable every correctly-built tree's reuse and bring back the
      // concurrent-shard clobber the fast path exists to prevent. So the
      // fence certifies only what this run's own trust record holds, and an
      // earlier run's record is rotated away at this run's first ask.
      const tree = baseWorktreePath(worktree);
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);
      mkdirSync(join(tree, 'dist'), { recursive: true });
      writeFileSync(
        join(tree, 'dist', 'cli.js'),
        'planted by the reviewed build',
      );

      // The next run captures again, which mints a fresh identity host-side.
      nextRun();

      const second = run({}, build);
      expect(second.note).not.toContain('reusing it');
      expect(builds).toEqual([tree, tree]);
      // The plant went with the tree it was standing in.
      expect(existsSync(join(tree, 'dist', 'cli.js'))).toBe(false);
    },
  );

  itWhereContainmentExists(
    'refuses to build through a rewritten review-worktree gitfile',
    () => {
      // `worktree add` resolves the repository through the REVIEW worktree's own
      // gitfile, which lives in the directory the sandbox mounts read-write and
      // which the build/test phase already ran the PR's code against. It checks
      // files out, so it runs whatever that pointer leads to, on the host.
      plantAdminEntry(
        join(repo, '.qwen', 'tmp', '.evil-git'),
        adminEntryOf(worktree),
        worktree,
        join(repo, '.git'),
      );

      const r = run();
      expect(r.available).toBe(false);
      expect(JSON.stringify(r)).toContain('review temp dir');
      // The tree was never created, which is what says the spawn never ran —
      // the note alone reads the same whichever side of it the gate fires on.
      expect(existsSync(baseWorktreePath(worktree))).toBe(false);
    },
  );

  it('creates a sibling worktree holding the BASE commit, not the head', () => {
    const r = run();
    expect(r.available).toBe(true);
    expect(r.path).toBe(baseWorktreePath(worktree));
    expect(r.baseSha).toBe(baseSha);
    // The whole point: this tree is the code as it stood before the PR.
    expect(git(r.path!, 'rev-parse', 'HEAD')).toBe(baseSha);
    expect(existsSync(join(r.path!, 'a.txt'))).toBe(true);
  });

  it('places the base tree BESIDE the review worktree, never inside it', () => {
    // Nested, it would land in the PR's own diff and be swept with it.
    const r = run();
    expect(r.path!.startsWith(`${worktree}/`)).toBe(false);
    expect(r.path).toBe(`${worktree}-base`);
  });

  it('builds in the base tree, and only there', () => {
    const seen: string[] = [];
    const r = run({}, (w) => {
      seen.push(w);
      return okBuild;
    });
    expect(seen).toEqual([baseWorktreePath(worktree)]);
    expect(r.build).toBe(okBuild);
  });

  itWhereContainmentExists(
    'REUSES an already-built base tree instead of sweeping it (concurrent shards)',
    () => {
      // Reviewed live on this PR: N verifier shards run in parallel and all
      // resolve the same path; without the fast path, shard B's opening sweep
      // destroys the tree shard A is mid-A/B in, and A's base side reads as
      // empty output — a fabricated difference with a deterministic source tag.
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        return okBuild;
      };
      const first = run({}, build);
      expect(first.available).toBe(true);
      const second = run({}, build);
      expect(second.available).toBe(true);
      expect(second.path).toBe(first.path);
      expect(second.note).toContain('reusing');
      expect(builds).toHaveLength(1); // one install+build, not two
      // A record naming a DIFFERENT sha (a rebase between runs) does not
      // shortcut: the one disagreeing state the fence treats as evidence —
      // it falls through to the rebuild, which sweeps whatever stands there.
      const trustPath = baseTreeTrustPath(worktree, planPath);
      const trust = JSON.parse(readFileSync(trustPath, 'utf8'));
      trust.trees[first.path!].baseSha = 'f'.repeat(40);
      writeFileSync(trustPath, JSON.stringify(trust));
      expect(run({}, build).note).not.toContain('reusing');
    },
  );

  it('returns BUSY instead of sweeping while another probe holds the build lock', () => {
    // Reviewed live: shard B's opening sweep deleted the tree shard A was
    // mid-`npm ci` in, and whichever finished stamped the marker for a tree
    // the other was still mutating.
    mkdirSync(`${baseWorktreePath(worktree)}.lock`, { recursive: true });
    const builds: string[] = [];
    const r = run({}, (w) => {
      builds.push(w);
      return okBuild;
    });
    expect(r.available).toBe(false);
    expect(r.note).toContain('another probe is building');
    expect(builds).toEqual([]); // no sweep, no build under the lock holder
    rmSync(`${baseWorktreePath(worktree)}.lock`, {
      recursive: true,
      force: true,
    });
  });

  it('sweeps a STALE lock instead of reporting busy for the whole review', () => {
    // A builder killed without its finally leaves the lock forever; 30+ min
    // old is a corpse, not a live install+build.
    const lock = `${baseWorktreePath(worktree)}.lock`;
    mkdirSync(lock, { recursive: true });
    const old = Date.now() / 1000 - 45 * 60;
    utimesSync(lock, old, old);
    const r = run();
    expect(r.available).toBe(true); // built through the corpse
  });

  it('a budget-TRUNCATED build is unavailable but NOT settled — no marker either way', () => {
    // A rerun against packages the budget left unbuilt manufactures
    // "fails on base too" — but truncation says nothing about the SHA, so
    // neither marker is written and a later shard may repay and succeed.
    const truncatedBuild = {
      ...okBuild,
      notBuilt: ['packages/a', 'packages/b'],
    } as unknown as BuildTestReport;
    const builds: string[] = [];
    const build = (w: string) => {
      builds.push(w);
      return truncatedBuild;
    };
    const first = run({}, build);
    expect(first.available).toBe(false);
    expect(first.note).toContain('not built');
    expect(first.note).toContain('packages/a');
    // No success marker and no failed marker: the next shard repays the build.
    expect(existsSync(join(first.path!, '.qwen-review-base-ok'))).toBe(false);
    expect(existsSync(join(first.path!, '.qwen-review-base-failed'))).toBe(
      false,
    );
    const second = run({}, build);
    expect(second.available).toBe(false);
    expect(second.note).not.toContain('already failed');
    expect(builds).toHaveLength(2);
  });

  itWhereContainmentExists(
    'a FAILED build is a settled answer — later shards do not re-pay it',
    () => {
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        return failedBuild;
      };
      expect(run({}, build).available).toBe(false);
      const second = run({}, build);
      expect(second.available).toBe(false);
      expect(second.note).toContain('already failed');
      expect(builds).toHaveLength(1);
    },
  );

  it('recovers from a stale base tree left by a crashed run', () => {
    const stale = baseWorktreePath(worktree);
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'junk'), 'x');
    // A non-empty directory makes `git worktree add` fail `already exists`.
    expect(run().available).toBe(true);
  });

  it('is NOT available when the base tree does not build', () => {
    const r = run({}, () => failedBuild);
    expect(r.available).toBe(false);
    // The tree is kept: a base that will not compile is worth looking at, and
    // the note must not read as a defect in the PR.
    expect(existsSync(r.path!)).toBe(true);
    expect(r.build).toBe(failedBuild);
    expect(r.note).toMatch(/did not build/);
    expect(r.note).toMatch(/never a finding against the PR/);
  });

  it('is NOT available when the build handed off without building anything', () => {
    // A PR that adds a workspace package maps to no package at the merge base,
    // so runBuildTest hands off `unsupported` (ok: true, build: []). Stamping that
    // tree available would let an A/B read the missing build as a behavioural diff.
    const handoff = {
      ok: true,
      toolchain: 'unsupported',
      build: [],
      note: 'handoff',
    } as unknown as BuildTestReport;
    const r = run({}, () => handoff);
    expect(r.available).toBe(false);
    expect(
      existsSync(join(baseWorktreePath(worktree), '.qwen-review-base-ok')),
    ).toBe(false);
  });

  it('is NOT available when npm scoped nothing to compile', () => {
    // A docs-only diff (or a package with no build script) runs zero build commands
    // and returns ok: true with an empty build[]; that is not a built tree.
    const empty = {
      ok: true,
      toolchain: 'npm',
      build: [],
      note: 'nothing to build',
    } as unknown as BuildTestReport;
    expect(run({}, () => empty).available).toBe(false);
  });

  it('refuses when the plan carries no mergeBaseSha', () => {
    const r = run({ plan: { mergeBaseSha: undefined } });
    expect(r.available).toBe(false);
    expect(r.build).toBeNull();
    expect(r.note).toMatch(/no mergeBaseSha/);
    expect(existsSync(baseWorktreePath(worktree))).toBe(false);
  });

  it('refuses when the base branch could not be fetched — the SHA may be stale', () => {
    // An A/B against a stale base attributes the base branch's own commits to
    // this PR: the two-dot-diff error, in another shape.
    const r = run({ plan: { baseFetchFailed: true } });
    expect(r.available).toBe(false);
    expect(r.note).toMatch(/stale/);
    expect(existsSync(baseWorktreePath(worktree))).toBe(false);
  });

  it('refuses an unreadable plan and a missing worktree without throwing', () => {
    expect(
      runBaseTree({
        plan: join(repo, 'nope.json'),
        worktree,
        timeout: 60,
        install: false,
        build: () => okBuild,
      }).note,
    ).toMatch(/cannot read the plan/);
    expect(run({ worktree: join(repo, 'no-such-tree') }).note).toMatch(
      /does not exist/,
    );
  });

  it('refuses a mergeBaseSha that is not a commit in this repo', () => {
    // The CAPTURE resolved this sha too, so the host-side anchor agrees and
    // the refusal under test is git's, not the anchor's — without that the
    // case would be green for the wrong reason.
    recordReviewWorktreeLeaseMergeBase(repo, 'pr-1', '0'.repeat(40));
    const r = run({ plan: { mergeBaseSha: '0'.repeat(40) } });
    expect(r.available).toBe(false);
    expect(r.note).toMatch(/base worktree could not be created/);
  });

  it('ignores an exported GIT_DIR redirect when adding the base tree', () => {
    // An exported GIT_DIR overrides repository discovery for every git call
    // that inherits it: the add would land in the redirected repository and
    // the A/B measure the wrong program while every check against the given
    // tree passes. The sha below IS a commit — just not of this repo.
    const foreign = mkdtempSync(join(tmpdir(), 'qwen-base-tree-foreign-'));
    try {
      git(foreign, 'init', '-q', '-b', 'main');
      git(foreign, 'config', 'user.email', 't@t.t');
      git(foreign, 'config', 'user.name', 't');
      writeFileSync(join(foreign, 'b.txt'), 'x\n');
      git(foreign, 'add', '-A');
      git(foreign, 'commit', '-qm', 'foreign');
      const foreignSha = git(foreign, 'rev-parse', 'HEAD');

      // The capture resolved the foreign sha as well, so the host-side
      // anchor agrees and what is under test is the GIT_DIR redirect.
      recordReviewWorktreeLeaseMergeBase(repo, 'pr-1', foreignSha);
      process.env['GIT_DIR'] = join(foreign, '.git');
      let r: BaseTreeReport;
      try {
        r = run({ plan: { mergeBaseSha: foreignSha } });
      } finally {
        delete process.env['GIT_DIR'];
      }

      expect(r.available).toBe(false);
      expect(r.note).toMatch(/base worktree could not be created/);
      // The foreign repository gained no worktree from this call — its list
      // still holds only its own main checkout.
      expect(git(foreign, 'worktree', 'list').split('\n')).toHaveLength(1);
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }
  });
});
