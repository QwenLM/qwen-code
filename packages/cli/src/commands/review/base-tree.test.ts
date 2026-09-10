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
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
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
import { runBaseTree, type BaseTreeReport } from './base-tree.js';
import { baseWorktreePath } from './lib/paths.js';
import { baseTreeTrustPath, builtTreeRecord } from './lib/base-tree-trust.js';
import { adminEntryOf, plantAdminEntry } from './lib/test-utils.js';
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
    over: { plan?: Record<string, unknown>; worktree?: string } = {},
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
  });

  // The lease fetch-pr holds for the whole review, at the host-side path —
  // the run identity the mount cannot touch. Tests that exercise "a touch of
  // the plan must not rotate the run" need it; the rest run on the plan-mtime
  // fallback, the same signal the run ledger keys on.
  const writeLease = (): void => {
    const dir = join(repo, '.qwen', 'review-leases');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'qwen-review-lease-pr-1.json'),
      JSON.stringify({
        sessionId: 's',
        promptId: 'p',
        target: 'pr-1',
        repositoryRoot: repo,
        worktreePath: worktree,
        branch: 'qwen-review/pr-1',
      }),
    );
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
      expect(second.note).toContain('no longer passes a reuse check');
      expect(second.note).not.toContain('reusing it');
      expect(builds).toEqual([tree]); // declined — no sweep, no rebuild
      // The dirtied file is still on disk: discarding it is what was refused.
      expect(readFileSync(join(tree, 'a.txt'), 'utf8')).toBe('after\n');
    },
  );

  itWhereContainmentExists(
    "does not REUSE when an untracked path appears that THIS RUN's build did not leave",
    () => {
      // The nonce fence excludes only trees a DIFFERENT run built: reviewed
      // code holding the read-write mount can drop an untracked executable
      // into a tree this run stamped, after the stamp. But an untracked
      // addition is also exactly what a concurrent A/B's own cache output
      // looks like — and discarding on an ambiguous signal sweeps a live
      // tree a sibling shard may be mid-A/B in (R26-1). So the run declines
      // busy: the plant is never reused, never executed, and the NEXT run's
      // fresh nonce discards the tree, which is what sweeps it.
      const tree = baseWorktreePath(worktree);
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);
      // Same run: the plan — and with it the run's identity — is untouched.
      mkdirSync(join(tree, 'dist'), { recursive: true });
      writeFileSync(
        join(tree, 'dist', 'cli.js'),
        'planted by the reviewed build',
      );

      const second = run({}, build);
      expect(second.note).not.toContain('reusing it');
      expect(second.note).toContain('no longer passes a reuse check');
      expect(second.available).toBe(false);
      expect(builds).toEqual([tree]); // declined, not discarded
      // ...and the cross-run arm is the discard: a re-captured plan rotates
      // the run's trust file (records dropped), the standing tree has no
      // record this run wrote, and the rebuild below sweeps the plant.
      planPath = writePlan();
      const third = run({}, build);
      expect(builds).toEqual([tree, tree]); // the rebuild fired
      expect(existsSync(join(tree, 'dist', 'cli.js'))).toBe(false);
      expect(third.available).toBe(true);
    },
  );

  itWhereContainmentExists(
    'sees a plant hiding INSIDE a directory the build left (file-level record)',
    () => {
      // The fence's blind spot when the record was collapsed: with `dist/`
      // recorded as one entry, anything dropped inside it changed no set
      // membership — the exact place a host-side A/B's executable lives.
      // The record is file-level (`ls-files --others` never collapses), so
      // the addition below IS a membership change, and the run declines.
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

      writeFileSync(join(tree, 'dist', 'evil.js'), 'planted inside');
      const third = run({}, build);
      expect(third.note).not.toContain('reusing it');
      expect(third.note).toContain('no longer passes a reuse check');
      expect(third.available).toBe(false);
      expect(builds).toEqual([tree]); // declined — still no rebuild
    },
  );

  itWhereContainmentExists(
    'sees a plant named __proto__ — the fence is not a plain-object map',
    () => {
      // `inventory[p] = …` on a plain object feeds the prototype setter, so
      // a file at that name never lands in the record — symmetric on write
      // and compare, invisible to the fence. The record is Object.create(null).
      const tree = baseWorktreePath(worktree);
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);
      expect(run({}, build).note).toContain('reusing it');

      writeFileSync(join(tree, '__proto__'), 'planted');
      const third = run({}, build);
      expect(third.note).not.toContain('reusing it');
      expect(third.note).toContain('no longer passes a reuse check');
      expect(third.available).toBe(false);
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
      expect(third.note).toContain('no longer passes a reuse check');
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
      expect(second.note).toContain('no longer passes a reuse check');
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
      expect(moved.note).toContain('different merge base');
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
    'does not let a touched or backdated plan move the run off its tree',
    () => {
      // The run's identity is the plan's MTIME (the run ledger's signal),
      // not its ctime: a bare touch — even `utimensat` to the same value —
      // moves only ctime and must not fork the run's shards across two trust
      // states. A backdate to a DIFFERENT value is the attack shape (re-key
      // to an earlier run's state); rotation answers it — destructive of the
      // file's records, adoptive of nothing.
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
      const touched = run({}, build);
      expect(touched.note).toContain('reusing it');
      expect(builds).toEqual([tree]);

      const earlier = new Date(Date.now() - 3_600_000);
      utimesSync(planPath, earlier, earlier);
      const backdated = run({}, build);
      expect(backdated.note).not.toContain('reusing it');
      expect(builds).toEqual([tree, tree]); // rotated, then rebuilt
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
      expect(second.note).toContain('no longer passes a reuse check');
      expect(builds).toEqual([tree]); // declined, not destroyed
      // The cross-run sweep is what collects the plant: a re-captured plan
      // rotates the run's trust state, and the rebuild discards the tree.
      writeFileSync(
        planPath,
        JSON.stringify({ mergeBaseSha: baseSha, files: [] }),
      );
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
    'does not settle on a failed marker forged from the ok marker — only the record settles',
    () => {
      // The forge the in-tree stamp invited: read the ok marker, write its
      // bytes over the failed name, delete the original. The settled-failure
      // fence reads the host-side RECORD — which still says this run's build
      // succeeded — so the plant changes nothing and the lane stays alive.
      const tree = baseWorktreePath(worktree);
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);

      const stamp = readFileSync(join(tree, '.qwen-review-base-ok'), 'utf8');
      rmSync(join(tree, '.qwen-review-base-ok'));
      writeFileSync(join(tree, '.qwen-review-base-failed'), stamp);

      const second = run({}, build);
      expect(second.note).not.toContain('already failed');
      expect(second.note).toContain('reusing it');
      expect(second.available).toBe(true);
      expect(builds).toEqual([tree]);
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

      // The next run captures its own plan, and the plan's mtime IS the epoch.
      const later = new Date(Date.now() + 60_000);
      utimesSync(planPath, later, later);

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
