/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Against a REAL git repo, for the same reason `base-tree`'s suite is: what
// breaks here is the worktree lifecycle — a detached add at the right SHA, a
// leftover from a crashed run, a reused tree that must come back PRISTINE — and
// none of that is exercised by mocking `spawnSync`.
//
// The invariant every test below is really about is the one the command exists
// for: after any of this, the shared review worktree is byte-for-byte what its
// commit says it is. A scratch tree that works but lets one write through is a
// scratch tree that has failed.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import yargs from 'yargs';

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn(),
}));
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
// The post-probe swap window is a race no fixture can stage deterministically,
// so the probe is wrapped: measure FIRST, then retarget the gitfile — the
// exact landing spot the creation's identity pin exists to close. Default
// behaviour is the real probe, untouched.
const worktreeLib = vi.hoisted(() => ({
  realWorktreeResidue: undefined as undefined | typeof worktreeResidue,
}));
// Every spawnSync argv, recorded: a pin's whole job is to put
// `--git-dir=<verified entry>` on the record, and a refactor that drops one
// re-opens the post-gate window while every behavioural test stays green
// (the swap shapes that would expose it are races no fixture stages). The
// wrapper is a pure pass-through.
const spawnLog = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const realSpawnSync = actual.spawnSync;
  const wrapper = (...callArgs: Parameters<typeof realSpawnSync>) => {
    const args = callArgs[1];
    if (Array.isArray(args)) spawnLog.calls.push(args.map(String));
    return realSpawnSync(...callArgs);
  };
  return {
    ...actual,
    // `default` is load-bearing: CJS-interop imports of the builtin resolve
    // through it (the same shape fetch-pr.test.ts uses), and without it the
    // transitive modules silently keep the real spawnSync.
    default: { ...actual, spawnSync: wrapper },
    spawnSync: wrapper,
  };
});
vi.mock('./lib/worktree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/worktree.js')>();
  worktreeLib.realWorktreeResidue = actual.worktreeResidue;
  return {
    ...actual,
    worktreeResidue: vi.fn((...args: Parameters<typeof worktreeResidue>) =>
      actual.worktreeResidue(...args),
    ),
  };
});
import { worktreeResidue } from './lib/worktree.js';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { runScratchTree, scratchTreeCommand } from './scratch-tree.js';
import { scratchWorktreePath } from './lib/paths.js';
import { isolateHostGitConfig } from './lib/test-utils.js';

describe('runScratchTree', () => {
  let repo: string;
  // See `lib/worktree.test.ts`: a polluted host gitconfig makes the fixture
  // commit throw, and every test here errors before it asserts anything.
  let gitIsolation: ReturnType<typeof isolateHostGitConfig>;
  let worktree: string;
  let headSha: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  const run = (label = 'verify--round-1--abc123') =>
    runScratchTree({ worktree, label });

  beforeEach(() => {
    gitIsolation = isolateHostGitConfig();
    spawnLog.calls.length = 0;
    repo = mkdtempSync(join(tmpdir(), 'qwen-scratch-tree-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'a.ts'), 'export const x = 1;\n');
    // Every JS repo a review runs in ignores its dependency directory; the
    // fixture follows. (The reuse reset itself deletes ignored paths —
    // `clean -ffdx` — and re-links the farm afterwards.)
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'head');
    headSha = git(repo, 'rev-parse', 'HEAD');
    worktree = join(repo, '.qwen', 'tmp', 'review-pr-1');
    mkdirSync(join(repo, '.qwen', 'tmp'), { recursive: true });
    git(repo, 'worktree', 'add', '--detach', '-q', worktree, headSha);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    gitIsolation.dispose();
    // The swap test queues a one-shot probe wrapper; an unconsumed one must
    // never leak into a later test.
    const realResidue = worktreeLib.realWorktreeResidue;
    vi.mocked(worktreeResidue).mockReset();
    if (realResidue !== undefined) {
      vi.mocked(worktreeResidue).mockImplementation(realResidue);
    }
  });

  it('stands up a sibling tree at the commit under review', () => {
    const r = run();
    expect(r.available).toBe(true);
    expect(r.headSha).toBe(headSha);
    expect(r.path).toBe(
      scratchWorktreePath(worktree, 'verify--round-1--abc123'),
    );
    expect(git(r.path!, 'rev-parse', 'HEAD')).toBe(headSha);
    expect(readFileSync(join(r.path!, 'a.ts'), 'utf8')).toBe(
      'export const x = 1;\n',
    );
  });

  it('anchors the shared-tree residue at the admin entry the caller names', () => {
    // The --admin-dir the pipeline welds into this call is the residue
    // probe's out-of-band identity: a shared tree whose gitfile names any
    // other entry — a foreign repository or a forge under the same common
    // dir — fails closed as unmeasured instead of being measured against
    // it. The refusal also WITHHOLDS the scratch tree: the head sha this
    // call derives comes through the same unverified discovery, and a tree
    // created from it descends from the very identity the gate refused
    // (measured at the pre-fix code: such a call answered the forge's head
    // sha and checked out its mutant under `available: true`). The tree's
    // own recorded admin entry measures the residue normally.
    writeFileSync(join(worktree, '__probe__.test.ts'), 'probe');
    const foreign = join(repo, 'foreign');
    mkdirSync(foreign);
    git(foreign, 'init', '-q', '-b', 'main');
    const own = execFileSync(
      'git',
      ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-dir'],
      { encoding: 'utf8' },
    ).trim();

    const refused = runScratchTree({
      worktree,
      label: 'verify--round-1--abc123',
      adminDir: join(foreign, '.git'),
    });
    expect(refused.available).toBe(false);
    expect(refused.path).toBeUndefined();
    expect(refused.sharedTreeResidue).toEqual([]);
    expect(refused.sharedTreeUnmeasured).toContain(
      'other than the one recorded',
    );
    expect(refused.note).toContain('identity could not be verified');
    expect(
      existsSync(scratchWorktreePath(worktree, 'verify--round-1--abc123')),
    ).toBe(false);

    const measured = runScratchTree({
      worktree,
      label: 'verify--round-1--abc123',
      adminDir: own,
    });
    expect(measured.available).toBe(true);
    expect(measured.sharedTreeResidue).toEqual(['__probe__.test.ts']);
    expect(measured.sharedTreeUnmeasured).toBeUndefined();
  });

  it('measures normally when the anchor carries the recorded filesystem identity', () => {
    // fetch-pr records the entry's dev:ino beside its path, and the
    // pipeline welds both into this call; a healthy tree carries the
    // recorded identity and measures its residue normally under the full
    // anchor.
    writeFileSync(join(worktree, '__probe__.test.ts'), 'probe');
    const own = execFileSync(
      'git',
      ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-dir'],
      { encoding: 'utf8' },
    ).trim();
    const entry = statSync(own);

    const r = runScratchTree({
      worktree,
      label: 'verify--round-1--abc123',
      adminDir: own,
      adminDevIno: `${entry.dev}:${entry.ino}`,
    });
    expect(r.available).toBe(true);
    expect(r.sharedTreeResidue).toEqual(['__probe__.test.ts']);
    expect(r.sharedTreeUnmeasured).toBeUndefined();
  });

  it('creates under the identity the probe VERIFIED — a post-probe swap is not honored', () => {
    // The identity gate checks the tree's gitfile ONCE, at probe time. The
    // creation that follows — the discard spawns and the `worktree add` —
    // re-discovered the repository through that same writable file: a swap
    // landing between the passing probe and the creation was honored, and
    // the scratch tree descended from the forge — whose filters executed
    // during the creation checkout while the report answered `available:
    // true` (measured at the pre-fix code). The creation now runs under
    // the verified identity, so the swap discovers nothing.
    const genuineAdmin = git(
      worktree,
      'rev-parse',
      '--path-format=absolute',
      '--git-dir',
    );
    // The forge: a clone carries the same head sha, so the pre-fix creation
    // succeeded there; its config plants the filter the swap exists to run,
    // and an attributes rule selects it for the creation checkout.
    const forge = join(repo, 'forge');
    execFileSync('git', ['clone', '-q', repo, forge]);
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: forge });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: forge });
    const pwned = join(repo, 'PWNED-smudge');
    execFileSync('git', ['config', 'filter.evil.smudge', `tee ${pwned}`], {
      cwd: forge,
    });
    writeFileSync(join(forge, '.git', 'info', 'attributes'), '* filter=evil\n');
    writeFileSync(join(forge, 'evil.ts'), 'contamination\n');
    execFileSync('git', ['add', '-A'], { cwd: forge });
    execFileSync('git', ['commit', '-qm', 'contamination'], { cwd: forge });
    // The swap lands between the probe and the creation: measure first,
    // then retarget the gitfile at the forge.
    const realResidue = worktreeLib.realWorktreeResidue;
    if (realResidue === undefined) throw new Error('probe mock missing');
    vi.mocked(worktreeResidue).mockImplementationOnce((cwd, anchor, cap) => {
      const r = realResidue(cwd, anchor, cap);
      writeFileSync(join(worktree, '.git'), `gitdir: ${join(forge, '.git')}\n`);
      return r;
    });

    const r = run();

    expect(r.available).toBe(true);
    expect(r.headSha).toBe(headSha);
    // Registered under the GENUINE common dir — the identity the probe
    // verified — never under the forge the swap names, and the forge's
    // filter never ran.
    const gitfile = readFileSync(join(r.path!, '.git'), 'utf8');
    expect(gitfile).toContain(dirname(dirname(genuineAdmin)));
    expect(gitfile).not.toContain('forge');
    expect(existsSync(pwned)).toBe(false);
  });

  it('keeps the screen pinned when the gitfile is swapped AFTER the gate', () => {
    // The executed R5-2 shape: the swap is live while the screen runs. A
    // screen that re-discovers through the writable gitfile resolves the
    // decoy the swap names — clean — and authorises a checkout that then
    // executes the honest repository's planted filter (measured: PWNED with
    // `available: true`). The pinned screen resolves the entry the gate
    // VERIFIED, finds the filter, and refuses.
    const honestGitfile = readFileSync(join(worktree, '.git'), 'utf8');
    const decoy = join(repo, 'decoy');
    execFileSync('git', ['clone', '-q', repo, decoy]);
    const pwned = join(repo, 'PWNED-screen-post-gate');
    git(worktree, 'config', 'filter.evil.smudge', `tee ${pwned}`);
    writeFileSync(join(repo, '.git', 'info', 'attributes'), '* filter=evil\n');
    const realResidue = worktreeLib.realWorktreeResidue;
    if (realResidue === undefined) throw new Error('probe mock missing');
    // Measure first (honest), then swap — the swap is LIVE for the screen.
    vi.mocked(worktreeResidue).mockImplementationOnce((cwd, anchor, cap) => {
      const r = realResidue(cwd, anchor, cap);
      writeFileSync(join(worktree, '.git'), `gitdir: ${join(decoy, '.git')}\n`);
      return r;
    });

    const r = run();

    expect(r.available).toBe(false);
    expect(r.note).toContain('filter.evil.smudge');
    expect(existsSync(pwned)).toBe(false);
    // The swap is undone for the tests that follow in this file's scope.
    writeFileSync(join(worktree, '.git'), honestGitfile);
  });

  it('reads the head sha through the verified entry when the gitfile is swapped AFTER the gate', () => {
    // The executed R5-4 shape with the swap live past the gate: an unpinned
    // head read resolves the forge the swap names (its HEAD is the evil sha,
    // objects planted in the shared store by a fetch), the anchored gate has
    // already passed, and the pinned creation materialises the evil commit
    // under `available: true`. Reading under the verified entry answers the
    // honest sha instead.
    const honestGitfile = readFileSync(join(worktree, '.git'), 'utf8');
    const forge = join(repo, 'forge');
    execFileSync('git', ['clone', '-q', repo, forge]);
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: forge });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: forge });
    writeFileSync(join(forge, 'malicious.ts'), 'evil\n');
    execFileSync('git', ['add', '-A'], { cwd: forge });
    execFileSync('git', ['commit', '-qm', 'evil'], { cwd: forge });
    const evilSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: forge,
      encoding: 'utf8',
    }).trim();
    expect(evilSha).not.toBe(headSha);
    execFileSync('git', ['fetch', '-q', forge], { cwd: worktree });
    const realResidue = worktreeLib.realWorktreeResidue;
    if (realResidue === undefined) throw new Error('probe mock missing');
    vi.mocked(worktreeResidue).mockImplementationOnce((cwd, anchor, cap) => {
      const r = realResidue(cwd, anchor, cap);
      writeFileSync(join(worktree, '.git'), `gitdir: ${join(forge, '.git')}\n`);
      return r;
    });

    const r = run();

    expect(r.available).toBe(true);
    expect(r.headSha).toBe(headSha);
    expect(existsSync(join(r.path!, 'malicious.ts'))).toBe(false);
    writeFileSync(join(worktree, '.git'), honestGitfile);
  });

  it('screens through the identity the gate VERIFIED — a pre-gate decoy swap does not blind the screen', () => {
    // The screen used to run BEFORE the identity gate and discover the
    // repository through the same writable gitfile: aimed at a clean decoy
    // for the duration of the scan and restored before the gate, the honest
    // repository's planted filter stayed invisible, and the creation
    // checkout the screen authorised executed it while the report answered
    // `available: true` (measured). The screen now runs AFTER the gate,
    // pinned to the identity it verified.
    const honestGitfile = readFileSync(join(worktree, '.git'), 'utf8');
    // The decoy: a clone, clean — no filter, no attributes.
    const decoy = join(repo, 'decoy');
    execFileSync('git', ['clone', '-q', repo, decoy]);
    // Plant the filter in the HONEST repository, after the clone, so the
    // decoy's config stays clean for the pre-gate discovery to find nothing.
    const pwned = join(repo, 'PWNED-screen-decoy');
    git(worktree, 'config', 'filter.evil.smudge', `tee ${pwned}`);
    writeFileSync(join(repo, '.git', 'info', 'attributes'), '* filter=evil\n');
    // Swap for the screen's duration; the probe wrapper restores the honest
    // gitfile before the gate measures.
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(decoy, '.git')}\n`);
    const realResidue = worktreeLib.realWorktreeResidue;
    if (realResidue === undefined) throw new Error('probe mock missing');
    vi.mocked(worktreeResidue).mockImplementationOnce((cwd, anchor, cap) => {
      writeFileSync(join(worktree, '.git'), honestGitfile);
      return realResidue(cwd, anchor, cap);
    });

    const r = run();

    expect(r.available).toBe(false);
    expect(r.note).toContain('filter.evil.smudge');
    expect(existsSync(pwned)).toBe(false);
    expect(
      existsSync(scratchWorktreePath(worktree, 'verify--round-1--abc123')),
    ).toBe(false);
  });

  it('resets under the verified identity — a post-gate double swap does not reach the reuse checkout', () => {
    // The reuse branch returned BEFORE the verified identity was extracted,
    // so every reset spawn re-discovered through the writable gitfiles, and
    // the reset's cross-check compared two discovery results the swapper
    // controls: a double swap — BOTH gitfiles retargeted at one forge with
    // forged backpointers and the filter planted, landing between the
    // passing gate and the reset — made every check resolve self-consistently
    // over the forge while the reset checkout executed its filter and the
    // report answered `available: true, reused: true` (measured). The reset
    // now compares against the common dir the gate VERIFIED, resolved under
    // the pin, and its mutation spawns run under the entry the gate
    // round-trip-checked.
    const first = run();
    expect(first.available).toBe(true);
    const scratchPath = first.path!;
    const genuineAdmin = git(
      worktree,
      'rev-parse',
      '--path-format=absolute',
      '--git-dir',
    );

    // The forge: a clone (the final HEAD comparison passes against it), the
    // filter planted, and one forged admin entry PER tree — each naming its
    // tree back, each resolving the common dir to the forge.
    const forge = join(repo, 'forge');
    execFileSync('git', ['clone', '-q', repo, forge]);
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: forge });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: forge });
    const pwned = join(repo, 'PWNED-reuse-swap');
    execFileSync('git', ['config', 'filter.evil.smudge', `tee ${pwned}`], {
      cwd: forge,
    });
    writeFileSync(join(forge, '.git', 'info', 'attributes'), '* filter=evil\n');
    const forgeEntryFor = (treePath: string, name: string): string => {
      const entry = join(forge, '.git', 'worktrees', name);
      mkdirSync(entry, { recursive: true });
      writeFileSync(join(entry, 'commondir'), '../..\n');
      writeFileSync(join(entry, 'gitdir'), `${join(treePath, '.git')}\n`);
      writeFileSync(join(entry, 'HEAD'), `${headSha}\n`);
      return entry;
    };
    const forgeWorktreeEntry = forgeEntryFor(worktree, 'forged-review');
    const forgeScratchEntry = forgeEntryFor(scratchPath, 'forged-scratch');

    // The swap lands between the gate and the reset: measure first, then
    // retarget BOTH gitfiles at the forge.
    const realResidue = worktreeLib.realWorktreeResidue;
    if (realResidue === undefined) throw new Error('probe mock missing');
    vi.mocked(worktreeResidue).mockImplementationOnce((cwd, anchor, cap) => {
      const r = realResidue(cwd, anchor, cap);
      writeFileSync(join(worktree, '.git'), `gitdir: ${forgeWorktreeEntry}\n`);
      writeFileSync(
        join(scratchPath, '.git'),
        `gitdir: ${forgeScratchEntry}\n`,
      );
      return r;
    });

    const second = run();

    expect(second.available).toBe(true);
    // Rebuilt under the genuine identity, never reused over the forge.
    expect(second.reused).toBe(false);
    expect(existsSync(pwned)).toBe(false);
    const gitfile = readFileSync(join(second.path!, '.git'), 'utf8');
    expect(gitfile).toContain(dirname(dirname(genuineAdmin)));
    expect(gitfile).not.toContain('forge');
  });

  it('reads the head sha under the verified identity — a pre-gate swap cannot taint it', () => {
    // The head sha used to be read BEFORE the gate through unverified
    // discovery: a swap restored before the gate tainted it while the
    // anchored gate passed on the legit identity, and the creation
    // materialised the forge's commit — objects planted in the SHARED store
    // by a fetch — answering `available: true` with the evil sha checked out
    // (measured). The read now runs under the identity the gate verified.
    const honestGitfile = readFileSync(join(worktree, '.git'), 'utf8');
    const forge = join(repo, 'forge');
    execFileSync('git', ['clone', '-q', repo, forge]);
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: forge });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: forge });
    writeFileSync(join(forge, 'malicious.ts'), 'evil\n');
    execFileSync('git', ['add', '-A'], { cwd: forge });
    execFileSync('git', ['commit', '-qm', 'evil'], { cwd: forge });
    const evilSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: forge,
      encoding: 'utf8',
    }).trim();
    expect(evilSha).not.toBe(headSha);
    // Plant the evil commit's objects in the shared store: a fetch from the
    // review worktree, same user — the objects land where the honest add
    // finds them.
    execFileSync('git', ['fetch', '-q', forge], { cwd: worktree });
    // For the pre-gate reads the worktree resolves to the forge (HEAD is the
    // evil sha); the probe wrapper restores before the gate measures.
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(forge, '.git')}\n`);
    const realResidue = worktreeLib.realWorktreeResidue;
    if (realResidue === undefined) throw new Error('probe mock missing');
    vi.mocked(worktreeResidue).mockImplementationOnce((cwd, anchor, cap) => {
      writeFileSync(join(worktree, '.git'), honestGitfile);
      return realResidue(cwd, anchor, cap);
    });

    const r = run();

    expect(r.available).toBe(true);
    expect(r.headSha).toBe(headSha);
    expect(existsSync(join(r.path!, 'malicious.ts'))).toBe(false);
  });

  it('refuses while repo-local config defines a content filter — checkouts would execute it', () => {
    // NO_HOOKS neutralises hooks and fsmonitor; a checkout still runs a
    // configured smudge/clean/process filter, and the common dir the
    // planting surface lives in is never wiped — so the refusal names the
    // surface instead of running whatever it holds.
    const pwned = join(repo, 'PWNED-smudge');
    git(worktree, 'config', 'filter.evil.smudge', `touch ${pwned}`);
    writeFileSync(join(worktree, 'a.ts'), 'dirty\n');

    const r = run();

    expect(r.available).toBe(false);
    expect(r.note).toContain('filter.evil.smudge');
    expect(existsSync(pwned)).toBe(false);
    expect(
      existsSync(scratchWorktreePath(worktree, 'verify--round-1--abc123')),
    ).toBe(false);

    // A repo WITHOUT the filter still gets a tree (the global-config filters
    // a user's own git-lfs install carries are not this surface).
    git(worktree, 'config', '--unset', 'filter.evil.smudge');
    expect(run().available).toBe(true);
  });

  it('refuses when the discovered HEAD is not the sha the caller recorded out-of-band', () => {
    // The refs INSIDE the verified repository are same-user-writable: one
    // rewrite of `<common>/worktrees/<id>/HEAD` survives every identity
    // check — the entry directory unchanged, no config write, no race — and
    // the scratch tree materialises the attacker's commit under a passing
    // gate (measured end-to-end). The pipeline holds the fetched sha
    // out-of-band; handed to this command, any disagreement is a refusal.
    const admin = git(
      worktree,
      'rev-parse',
      '--path-format=absolute',
      '--git-dir',
    );
    // A second commit, then drop it from the branch: the objects stay in the
    // shared store, reachable from a rewritten HEAD.
    writeFileSync(join(repo, 'evil.ts'), 'evil\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'evil');
    const evilSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'reset', '-q', '--hard', 'HEAD~1');
    writeFileSync(join(admin, 'HEAD'), `${evilSha}\n`);

    const r = runScratchTree({
      worktree,
      label: 'verify--round-1--abc123',
      expectedHeadSha: headSha,
    });

    expect(r.available).toBe(false);
    expect(r.path).toBeUndefined();
    expect(r.note).toContain(evilSha.slice(0, 9));
    expect(r.note).toContain(headSha.slice(0, 9));
    expect(
      existsSync(scratchWorktreePath(worktree, 'verify--round-1--abc123')),
    ).toBe(false);

    // A caller with no out-of-band record keeps the discovered value — the
    // check exists only for the pipeline that holds the sha.
    const unanchored = run();
    expect(unanchored.available).toBe(true);
    expect(unanchored.headSha).toBe(evilSha);
  });

  it('never executes core.fsmonitor — the creation and reset checkouts run the config, not it them', () => {
    // `core.fsmonitor` is a command git EXECUTES on index-reading commands —
    // the creation's `worktree add` and the reuse path's checkout included —
    // and the config that names it is the contaminator's write surface. It
    // rides the same neutralisation the residue probe applies to its
    // measurements (measured: the pre-fix creation and reset each fired a
    // planted monitor).
    const marker = join(repo, 'fsmonitor-fired');
    git(worktree, 'config', 'core.fsmonitor', `touch ${marker}`);

    const first = run();
    expect(first.available).toBe(true);
    expect(existsSync(marker)).toBe(false);

    const second = run();
    expect(second.available).toBe(true);
    expect(second.reused).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it('puts the verified identity on the record — the reset and discard spawns run pinned', () => {
    // A pin that is not asserted is a pin a refactor can drop: with the
    // gitfile honest, every behavioural shape agrees pinned and unpinned, so
    // the argv itself is the witness. The reset's mutation spawns must carry
    // the SCRATCH entry the reuse gate round-trip-verified, and the rebuild
    // path's discard and add must carry the REVIEW entry the residue gate
    // verified — dropping either re-opens the post-gate window silently.
    const first = run();
    expect(first.available).toBe(true);
    const genuineAdmin = git(
      worktree,
      'rev-parse',
      '--path-format=absolute',
      '--git-dir',
    );
    const scratchAdmin = git(
      first.path!,
      'rev-parse',
      '--path-format=absolute',
      '--git-dir',
    );

    // Reuse path: the reset's mutation spawns carry the scratch entry.
    spawnLog.calls.length = 0;
    const second = run();
    expect(second.available).toBe(true);
    expect(second.reused).toBe(true);
    const checkouts = spawnLog.calls.filter((c) => c.includes('checkout'));
    expect(checkouts.length).toBeGreaterThan(0);
    for (const argv of checkouts) {
      expect(argv).toContain(`--git-dir=${scratchAdmin}`);
    }

    // Rebuild path: the discard's unregister spawns and the add carry the
    // review entry, never a re-discovery through the writable gitfile.
    rmSync(join(first.path!, '.git'));
    spawnLog.calls.length = 0;
    const third = run();
    expect(third.available).toBe(true);
    expect(third.reused).toBe(false);
    const removes = spawnLog.calls.filter(
      (c) => c.includes('worktree') && c.includes('remove'),
    );
    expect(removes.length).toBeGreaterThan(0);
    for (const argv of removes) {
      expect(argv).toContain(`--git-dir=${genuineAdmin}`);
    }
    const adds = spawnLog.calls.filter(
      (c) => c.includes('worktree') && c.includes('add'),
    );
    expect(adds.length).toBeGreaterThan(0);
    for (const argv of adds) {
      expect(argv).toContain(`--git-dir=${genuineAdmin}`);
    }
  });

  it("screens ANOTHER worktree's per-worktree config, not just this one's", () => {
    // The screen runs against the review worktree, but the checkout it
    // authorises runs in the SCRATCH tree — whose own
    // `<common>/worktrees/<label>/config.worktree` is honored once
    // `extensions.worktreeConfig` is on and was not among the files read. A
    // filter planted there executed during the reset while this function
    // reported the repository clean, so the screen now reads every entry under
    // the common dir's `worktrees/`.
    const first = run();
    expect(first.available).toBe(true);

    const common = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: worktree, encoding: 'utf8' },
    ).trim();
    const scratchAdmin = join(
      common,
      'worktrees',
      basename(first.path!),
      'config.worktree',
    );
    execFileSync('git', ['config', 'extensions.worktreeConfig', 'true'], {
      cwd: worktree,
    });
    writeFileSync(
      scratchAdmin,
      '[filter "planted"]\n\tsmudge = touch /tmp/qwen-should-never-run\n',
    );

    const r = run();

    expect(r.available).toBe(false);
    expect(r.note).toContain('filter.planted.smudge');
  });

  it('places it BESIDE the review worktree, never inside it', () => {
    // Nested, every probe file would land in the tree this command exists to
    // keep clean — and in the PR's own diff with it.
    const r = run();
    expect(r.path!.startsWith(`${worktree}/`)).toBe(false);
    expect(r.path!.startsWith(`${worktree}-scratch-`)).toBe(true);
  });

  it('gives two labels two trees — one round runs its shards concurrently', () => {
    // A shared scratch tree would be the same race one level down: shard B
    // editing the file shard A is measuring.
    const a = run('verify--round-2--aaa');
    const b = run('verify--round-2--bbb');
    expect(a.path).not.toBe(b.path);
    expect(existsSync(a.path!)).toBe(true);
    expect(existsSync(b.path!)).toBe(true);
  });

  it('refuses an empty label rather than defaulting to a shared tree', () => {
    const r = runScratchTree({ worktree, label: '  ' });
    expect(r.available).toBe(false);
    expect(r.note).toContain('--label is required');
  });

  it('cannot be steered out of the temp dir by a crafted label', () => {
    // The label arrives over a CLI flag. A traversal in it would aim both the
    // `git worktree add` and cleanup's later delete at another directory.
    const r = run('../../../../etc/passwd');
    expect(r.available).toBe(true);
    expect(r.path!.startsWith(`${worktree}-scratch-`)).toBe(true);
    expect(r.path).not.toContain('..');
  });

  it('hands back a PRISTINE tree on reuse — a stale mutant is a wrong verdict', () => {
    // The failure this closes: finding A's probe leaves a mutant behind, finding
    // B's probe runs against it, and the verdict carries a deterministic source
    // tag over contaminated code.
    const first = run();
    writeFileSync(join(first.path!, 'a.ts'), 'export const x = 2;\n');
    writeFileSync(join(first.path!, '__probe__.test.ts'), 'it("x", () => {});');

    const second = run();
    expect(second.available).toBe(true);
    expect(second.reused).toBe(true);
    expect(second.path).toBe(first.path);
    expect(readFileSync(join(second.path!, 'a.ts'), 'utf8')).toBe(
      'export const x = 1;\n',
    );
    expect(existsSync(join(second.path!, '__probe__.test.ts'))).toBe(false);
  });

  it('rebuilds over a leftover directory instead of resetting the PARENT checkout', () => {
    // The reuse path runs `git checkout --force` with the scratch path as cwd.
    // A bare directory there — what a crashed `worktree add` or a cleanup whose
    // `rmSync` failed leaves behind — has no `.git`, so git walks UP and finds
    // the user's own checkout, which the scratch path sits inside: their
    // uncommitted work discarded, their HEAD detached onto the PR's commit, and
    // `rev-parse HEAD` then returning the sha that makes the reset report
    // success. Measured on a real repo before the `.git` gate.
    const tree = scratchWorktreePath(worktree, 'verify--round-1--abc123');
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, 'junk.txt'), 'from a run that died\n');
    // The parent checkout, as a user would leave it: on a branch, with work.
    writeFileSync(join(repo, 'a.ts'), 'LOCAL UNCOMMITTED WORK\n');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');

    const r = run();

    expect(r.available).toBe(true);
    // Rebuilt, not "reused" — the leftover was never treated as a worktree.
    expect(r.reused).toBe(false);
    expect(existsSync(join(tree, 'junk.txt'))).toBe(false);
    expect(existsSync(join(tree, '.git'))).toBe(true);
    expect(git(tree, 'rev-parse', 'HEAD')).toBe(headSha);
    // And the user's checkout is exactly as they left it.
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(readFileSync(join(repo, 'a.ts'), 'utf8')).toBe(
      'LOCAL UNCOMMITTED WORK\n',
    );
  });

  it('removes a nested repo a probe left behind — `-fd` alone would not', () => {
    // `git clean -fd` refuses to delete a nested git repository, so a probe that
    // cloned or `git init`-ed a fixture inside its scratch tree would survive
    // the reset while the report says "anything you left in it is gone".
    const first = run();
    const nested = join(first.path!, 'fixture-repo');
    mkdirSync(nested, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: nested });
    writeFileSync(join(nested, 'fixture.txt'), 'from the last probe\n');

    const second = run();
    expect(second.reused).toBe(true);
    expect(existsSync(nested)).toBe(false);
  });

  it('refuses to call a tree pristine when skip-worktree hides a mutant', () => {
    // `checkout --force` silently skips a file carrying the bit and `clean`
    // never touches tracked files, so the mutant survives with `git status`
    // reading empty and the sha still matching. The reset has to notice and
    // hand the caller the rebuild path instead.
    for (const bit of ['--skip-worktree', '--assume-unchanged']) {
      const first = run();
      execFileSync('git', ['update-index', bit, 'a.ts'], { cwd: first.path! });
      writeFileSync(join(first.path!, 'a.ts'), `MUTANT ${bit}\n`);

      const second = run();
      expect(second.available).toBe(true);
      expect(second.reused).toBe(false); // rebuilt, not "reset"
      expect(readFileSync(join(second.path!, 'a.ts'), 'utf8')).toBe(
        'export const x = 1;\n',
      );
    }
  });

  it('rebuilds when the leftover has a .git that git cannot use', () => {
    // A gitfile whose admin dir is gone (a killed cleanup, a `worktree prune`)
    // passes the registration gate and fails inside the reset — the catch must
    // take it to discard-and-rebuild rather than let the throw escape.
    const first = run();
    writeFileSync(join(first.path!, '.git'), 'gitdir: /nowhere/at/all\n');

    const second = run();
    expect(second.available).toBe(true);
    expect(second.reused).toBe(false);
    expect(
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: second.path!,
        encoding: 'utf8',
      }).trim(),
    ).toBe(headSha);
  });

  it("never fires the user repository's hooks", () => {
    // The scratch tree is a LINKED worktree, so its hooks resolve to the common
    // dir — the user's own `.git/hooks`. `worktree add` and `checkout` both run
    // `post-checkout` from there, which would make creating or resetting a
    // scratch tree execute whatever that repository holds.
    const log = join(repo, 'hook.log');
    const hook = join(repo, '.git', 'hooks', 'post-checkout');
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\necho fired >> ${log}\n`);
    chmodSync(hook, 0o755);

    run(); // creation path
    run(); // reset path
    expect(existsSync(log)).toBe(false);
  });

  it('replaces a node_modules it did not build rather than trusting it', () => {
    // The reuse reset deletes ignored paths and re-links the farm afterwards,
    // so anything a probe installed or planted in `node_modules` goes with
    // them rather than resolving as a dependency for every later probe in
    // the shard.
    mkdirSync(join(worktree, 'node_modules', 'vitest'), { recursive: true });
    const first = run();
    expect(first.dependencies).toMatchObject({ linked: 1 });
    writeFileSync(
      join(first.path!, 'node_modules', 'planted-stub.js'),
      'module.exports = 1;\n',
    );

    const second = run();
    expect(second.reused).toBe(true);
    expect(
      existsSync(join(second.path!, 'node_modules', 'planted-stub.js')),
    ).toBe(false);
    expect(existsSync(join(second.path!, 'node_modules', 'vitest'))).toBe(true);
  });

  it('rebuilds rather than resetting a scratch path that is a symlink', () => {
    // Probe code has a shell in this tree and the report tells it the path. A
    // symlink there would aim `checkout --force`, `clean -ffdx` and the farm's
    // rebuild at whatever it resolves to — including the shared review
    // worktree. Rebuilding is the safe answer: `discardWorktree` unlinks a
    // symlink rather than following it.
    const first = run();
    const victim = join(repo, 'victim');
    mkdirSync(join(victim, 'keep'), { recursive: true });
    rmSync(first.path!, { recursive: true, force: true });
    symlinkSync(victim, first.path!, 'dir');

    const second = run();
    expect(second.available).toBe(true);
    expect(second.reused).toBe(false);
    expect(existsSync(join(victim, 'keep'))).toBe(true);
  });

  it('clears IGNORED probe state too — pristine means pristine', () => {
    // Sparing ignored paths kept the farm cheap and left a probe's own
    // `node_modules` at any depth, its build caches and its mutated `dist/`
    // standing under a report that said the tree was back at the commit.
    const first = run();
    mkdirSync(join(first.path!, 'fixtures', 'node_modules'), {
      recursive: true,
    });
    writeFileSync(
      join(first.path!, 'fixtures', 'node_modules', 'planted.js'),
      'x',
    );

    const second = run();
    expect(second.reused).toBe(true);
    expect(existsSync(join(second.path!, 'fixtures'))).toBe(false);
  });

  it('rebuilds when the tree belongs to a DIFFERENT repository', () => {
    // `rev-parse --show-toplevel` prints the directory the `.git` file sits in,
    // whatever that file points at — so a gitfile naming another repository
    // passes a self-consistency check while every command below would run
    // against someone else's objects, refs, hooks and config.
    // A CLONE, so the commit the reset checks out exists there too — otherwise
    // the reset fails for the wrong reason and the test would pass without the
    // guard it is meant to pin.
    const other = join(repo, 'other-repo');
    execFileSync('git', ['clone', '-q', repo, other]);
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: other });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: other });
    writeFileSync(join(other, 'o.txt'), 'x\n');
    execFileSync('git', ['add', '-A'], { cwd: other });
    execFileSync('git', ['commit', '-qm', 'one'], { cwd: other });

    const first = run();
    writeFileSync(
      join(first.path!, '.git'),
      `gitdir: ${join(other, '.git')}\n`,
    );

    const second = run();
    expect(second.available).toBe(true);
    expect(second.reused).toBe(false);
    // The other repository is untouched: still on its branch, still holding its
    // own file.
    expect(
      execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: other,
        encoding: 'utf8',
      }).trim(),
    ).toBe('main');
    expect(existsSync(join(other, 'o.txt'))).toBe(true);
  });

  it('rebuilds over a .git SYMLINK at the scratch path — never resets the main checkout', () => {
    // A genuine linked worktree carries `.git` as a FILE; a symlink at that
    // path naming the repo's own gitdir passed every identity check —
    // measured live: `--show-toplevel` named the scratch dir and the common
    // dirs compared equal — while `checkout --force --detach` detached the
    // USER's HEAD onto the PR sha and rewrote the main index.
    const tree = scratchWorktreePath(worktree, 'verify--round-1--abc123');
    mkdirSync(tree, { recursive: true });
    symlinkSync(join(repo, '.git'), join(tree, '.git'));
    writeFileSync(join(repo, 'a.ts'), 'LOCAL UNCOMMITTED WORK\n');

    const r = run();

    expect(r.available).toBe(true);
    expect(r.reused).toBe(false); // rebuilt, not reset
    expect(git(tree, 'rev-parse', 'HEAD')).toBe(headSha);
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(readFileSync(join(repo, 'a.ts'), 'utf8')).toBe(
      'LOCAL UNCOMMITTED WORK\n',
    );
  });

  it('rebuilds when the scratch .git FILE names the common dir', () => {
    // The same main-checkout shape without a symlink: a `.git` file whose
    // `gitdir:` line names the common dir itself. A linked tree's gitdir is
    // `<common>/worktrees/<name>`; equality means the tree claims to be the
    // main checkout, where the reset must never land.
    const tree = scratchWorktreePath(worktree, 'verify--round-1--abc123');
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, '.git'), `gitdir: ${join(repo, '.git')}\n`);
    writeFileSync(join(repo, 'a.ts'), 'LOCAL UNCOMMITTED WORK\n');

    const r = run();

    expect(r.available).toBe(true);
    expect(r.reused).toBe(false);
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(readFileSync(join(repo, 'a.ts'), 'utf8')).toBe(
      'LOCAL UNCOMMITTED WORK\n',
    );
  });

  it('rebuilds when the scratch .git borrows a SIBLING worktree’s admin entry', () => {
    // A planted gitfile naming another worktree's admin entry passes every
    // other identity check — directory, gitfile, toplevel resolving to itself,
    // common dirs comparing equal, gitdir distinct from the commondir — while
    // the reset detaches the SIBLING's HEAD onto the PR sha and wipes its
    // staged index. The admin entry's `gitdir` backpointer names the tree it
    // belongs to; a borrowed entry's names the sibling.
    const first = run();
    const sibling = join(repo, 'sibling-wt');
    git(repo, 'worktree', 'add', '--detach', '-q', sibling, 'HEAD');
    writeFileSync(join(sibling, 's.txt'), 'sibling work\n');
    git(sibling, 'add', 's.txt');
    git(sibling, 'commit', '-qm', 'sibling work');
    writeFileSync(join(sibling, 'a.ts'), 'SIBLING UNCOMMITTED\n');
    git(sibling, 'add', 'a.ts');
    const siblingHead = git(sibling, 'rev-parse', 'HEAD');
    expect(siblingHead).not.toBe(headSha);
    const admin = git(
      sibling,
      'rev-parse',
      '--path-format=absolute',
      '--git-dir',
    );

    writeFileSync(join(first.path!, '.git'), `gitdir: ${admin}\n`);

    const second = run();

    expect(second.available).toBe(true);
    expect(second.reused).toBe(false); // rebuilt, not reset
    expect(readFileSync(join(second.path!, 'a.ts'), 'utf8')).toBe(
      'export const x = 1;\n',
    );
    // The sibling is untouched: HEAD where it was, staged change intact.
    expect(git(sibling, 'rev-parse', 'HEAD')).toBe(siblingHead);
    expect(git(sibling, 'diff', '--cached', '--name-only')).toBe('a.ts');
  });

  it('ignores a GIT_DIR inherited from the environment', () => {
    // An exported GIT_DIR overrides repository discovery for the ENTIRE
    // identity gate at once — both sides of every comparison see the same
    // override, so no check can detect it — and the head sha itself comes back
    // from the wrong repository. Every git call this command makes must drop
    // the redirect and resolve the tree it was given.
    const sibling = join(repo, 'env-sibling');
    git(repo, 'worktree', 'add', '--detach', '-q', sibling, 'HEAD');
    writeFileSync(join(sibling, 's.txt'), 'x\n');
    git(sibling, 'add', 's.txt');
    git(sibling, 'commit', '-qm', 'sibling');
    const admin = git(
      sibling,
      'rev-parse',
      '--path-format=absolute',
      '--git-dir',
    );
    const siblingHead = git(sibling, 'rev-parse', 'HEAD');
    expect(siblingHead).not.toBe(headSha);

    process.env['GIT_DIR'] = admin;
    let r: ReturnType<typeof run>;
    try {
      r = run();
    } finally {
      delete process.env['GIT_DIR'];
    }

    expect(r.available).toBe(true);
    // The sha came from the review worktree, not the redirect target.
    expect(r.headSha).toBe(headSha);
    expect(git(sibling, 'rev-parse', 'HEAD')).toBe(siblingHead);
  });

  it('is unavailable when the worktree’s .git file is gone — never walked up', () => {
    // With the `.git` file missing — a crash mid-`worktree add`, a cleanup
    // whose rmSync failed — git's discovery walks UP into the user's
    // checkout: HEAD resolves to the user's branch, the residue probe names
    // the user's own dirty paths, and the note's restore recipe is aimed at
    // them. Measured live before this check: `available: true` at the USER's
    // head sha, the scratch tree registered in the user's repo.
    writeFileSync(join(repo, 'a.ts'), 'LOCAL UNCOMMITTED WORK\n');
    rmSync(join(worktree, '.git'));

    const r = run();

    expect(r.available).toBe(false);
    expect(r.note).toContain('not a git worktree');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(readFileSync(join(repo, 'a.ts'), 'utf8')).toBe(
      'LOCAL UNCOMMITTED WORK\n',
    );
  });

  it('rebuilds when a submodule was initialized in the tree', () => {
    // Nothing in the reset reaches inside an initialized submodule, and
    // `rev-parse HEAD` is the superproject's — so a mutant in there would ride
    // a "pristine" report into the next probe. A fresh tree has it
    // uninitialized, which is why rebuilding is the answer.
    const sub = join(repo, 'sub-origin');
    mkdirSync(sub, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: sub });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: sub });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: sub });
    writeFileSync(join(sub, 's.txt'), 'x\n');
    execFileSync('git', ['add', '-A'], { cwd: sub });
    execFileSync('git', ['commit', '-qm', 'one'], { cwd: sub });
    execFileSync(
      'git',
      [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        sub,
        'vendor',
      ],
      { cwd: repo },
    );
    execFileSync('git', ['commit', '-qm', 'add submodule'], { cwd: repo });
    // The worktree was created from the PREVIOUS head; move it to the commit
    // that carries the submodule, which is what the scratch tree copies.
    headSha = execFileSync('git', ['rev-parse', 'main'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['checkout', '--detach', '-q', headSha], {
      cwd: worktree,
    });

    const first = run();
    execFileSync(
      'git',
      [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'update',
        '--init',
        '-q',
      ],
      { cwd: first.path! },
    );
    writeFileSync(join(first.path!, 'vendor', 's.txt'), 'MUTANT\n');

    const second = run();
    expect(second.reused).toBe(false);
    expect(existsSync(join(second.path!, 'vendor', 's.txt'))).toBe(false);
  });

  it('refuses a label that flattens to nothing rather than sharing one tree', () => {
    // `???` and `!!!` are two different non-empty labels with no path-safe
    // character between them: a fallback would put both shards in one tree —
    // the race the label exists to prevent, reached through the sanitiser.
    for (const label of ['???', '!!!']) {
      const r = runScratchTree({ worktree, label });
      expect(r.available).toBe(false);
      expect(r.note).toContain('--label is required');
    }
  });

  it('rebuilds the farm on reuse rather than inheriting it', () => {
    mkdirSync(join(worktree, 'node_modules', 'vitest'), { recursive: true });
    const first = run();
    expect(first.dependencies).toEqual({
      linked: 1,
      failed: 0,
      alreadyPresent: false,
      selfLinked: 0,
    });

    const second = run();
    expect(second.reused).toBe(true);
    // Re-linked rather than trusted: `node_modules` is the one ignored path a
    // reuse does not inherit, because it is where a probe may install.
    expect(second.dependencies).toEqual({
      linked: 1,
      failed: 0,
      alreadyPresent: false,
      selfLinked: 0,
    });
    expect(existsSync(join(second.path!, 'node_modules', 'vitest'))).toBe(true);
  });

  it('says which harness gap it hit when node_modules holds nothing linkable', () => {
    // The shape a killed `npm install` leaves. `{linked: 0, failed: 0}` reads
    // identically to "the farm was already there", and the two want opposite
    // things said to the verifier.
    mkdirSync(join(worktree, 'node_modules'), { recursive: true });
    writeFileSync(join(worktree, 'node_modules', '.package-lock.json'), '{}');

    const r = run();
    expect(r.dependencies).toEqual({
      linked: 0,
      failed: 0,
      alreadyPresent: false,
      selfLinked: 0,
    });
    expect(r.note).toContain('held nothing linkable');
    expect(r.note).not.toContain('already in place');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'says linking FAILED rather than "no node_modules" when the farm throws',
    () => {
      // Folding a link failure into the same `null` the absent case uses told
      // the verifier the worktree had no `node_modules` — about a worktree that
      // has one — sending it to install a tree that only needed a retry.
      const nm = join(worktree, 'node_modules');
      mkdirSync(join(nm, 'vitest'), { recursive: true });
      chmodSync(nm, 0o000); // readdirSync throws EACCES inside the farm
      try {
        const r = run();
        expect(r.available).toBe(true);
        // Counted, not swallowed and not thrown: the farm is best-effort, and
        // "0 linked, 1 failed" is the honest shape — never "the review worktree
        // has no node_modules", which sends the verifier to install a tree that
        // only needed a retry.
        expect(r.dependencies).toEqual({
          linked: 0,
          failed: 1,
          alreadyPresent: false,
          selfLinked: 0,
        });
        expect(r.note).toContain('could not be');
        expect(r.note).not.toContain('has no `node_modules`');
      } finally {
        chmodSync(nm, 0o755);
      }
    },
  );

  it('is unavailable — with its reason — when the worktree is not a checkout', () => {
    // Outside any repository, so git cannot discover one by walking up.
    const plain = mkdtempSync(join(tmpdir(), 'qwen-not-a-checkout-'));
    try {
      const r = runScratchTree({ worktree: plain, label: 'verify' });
      expect(r.available).toBe(false);
      expect(r.note).toContain('cannot read HEAD');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('leaves the shared review worktree untouched by everything it does', () => {
    // The whole point, asserted directly.
    const r = run();
    writeFileSync(join(r.path!, 'a.ts'), 'export const x = 99;\n');
    writeFileSync(join(r.path!, 'probe.test.ts'), 'it("x", () => {});');

    expect(readFileSync(join(worktree, 'a.ts'), 'utf8')).toBe(
      'export const x = 1;\n',
    );
    expect(git(worktree, 'status', '--porcelain')).toBe('');
  });

  it('reports residue in the shared worktree — the tree others are reading', () => {
    // The cleanliness check: a verifier that wrote into the shared tree before
    // it had a scratch tree learns so at the moment it asks for one, instead of
    // a concurrent auditor discovering it as a phantom Critical.
    writeFileSync(join(worktree, 'a.ts'), 'export const x = 2;\n');
    writeFileSync(join(worktree, '__probe__.test.ts'), 'it("x", () => {});');

    const r = run();
    expect(r.available).toBe(true);
    expect(r.sharedTreeResidue.sort()).toEqual(['__probe__.test.ts', 'a.ts']);
    expect(r.sharedTreeResidueTotal).toBe(2);
    expect(r.note).toContain('the shared review worktree is NOT clean');
    expect(r.note).toContain('__probe__.test.ts');
  });

  it('says how many dirty paths it did NOT list', () => {
    // A capped list presented as the complete one is a verifier restoring the
    // twelve it was shown and leaving the thirteenth in the tree the next round
    // reads.
    for (let i = 0; i < 13; i++) {
      writeFileSync(join(worktree, `f${i}.ts`), 'x\n');
    }
    const r = run();
    expect(r.sharedTreeResidueTotal).toBe(13);
    expect(r.sharedTreeResidue).toHaveLength(12);
    expect(r.note).toContain('1 more paths not listed here');
    expect(r.note).toContain('--untracked-files=all');
  });

  it('names every residue shape its own recovery, including the staged ones', () => {
    // Built from the real shapes, not from prose: a staged rename is reported
    // under BOTH names, and they take opposite commands — `git rm --cached` on
    // the original would stage a deletion rather than clear one.
    writeFileSync(join(worktree, 'a.ts'), 'export const x = 2;\n');
    writeFileSync(join(worktree, 'staged-new.ts'), 'x\n');
    execFileSync('git', ['add', 'staged-new.ts'], { cwd: worktree });
    execFileSync('git', ['mv', '.gitignore', 'ignore-rules'], {
      cwd: worktree,
    });

    const r = run();
    expect(r.sharedTreeResidue.sort()).toEqual([
      '.gitignore',
      'a.ts',
      'ignore-rules',
      'staged-new.ts',
    ]);
    expect(r.note).toContain('git checkout HEAD -- <path>');
    expect(r.note).toContain('git rm --cached <path>');
    expect(r.note).toContain('rm -rf <path>');
    // The rename's ORIGINAL name comes back with checkout, not with rm --cached.
    expect(r.note).toContain('git checkout HEAD -- <original>');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports UNMEASURED rather than clean when the residue check cannot run',
    () => {
      // A `git status` that dies (a tree too dirty for its buffer, an index it
      // cannot read) returns the same empty list a pristine tree does; a script
      // reading the field and a verifier reading the note both have to be able
      // to tell the two apart. `rev-parse HEAD` does not need the index, so the
      // command still gets far enough to report.
      const index = execFileSync(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-path', 'index'],
        { cwd: worktree, encoding: 'utf8' },
      ).trim();
      chmodSync(index, 0o000);
      try {
        const r = runScratchTree({
          worktree,
          label: 'verify--round-1--unmeasured',
        });
        expect(r.sharedTreeUnmeasured).toBeTruthy();
        expect(r.note).toContain('could not be measured');
        // A measurement failure is NOT an identity refusal: the tree's
        // identity held, so the scratch tree is still created — only the
        // cleanliness verdict degrades.
        expect(r.available).toBe(true);
      } finally {
        chmodSync(index, 0o644);
      }
    },
  );

  it('says nothing about residue when the shared worktree is clean', () => {
    const r = run();
    expect(r.sharedTreeResidue).toEqual([]);
    expect(r.note).not.toContain('NOT clean');
  });

  it('links the review worktree’s node_modules in, and says so', () => {
    mkdirSync(join(worktree, 'node_modules', 'vitest'), { recursive: true });
    mkdirSync(join(worktree, 'node_modules', '@scope', 'pkg'), {
      recursive: true,
    });

    const r = run();
    expect(r.dependencies).toEqual({
      linked: 2,
      failed: 0,
      alreadyPresent: false,
      selfLinked: 0,
    });
    expect(existsSync(join(r.path!, 'node_modules', 'vitest'))).toBe(true);
    expect(r.note).toContain('2 dependencies linked in');
  });

  it('says a harness will not start when there is nothing to link', () => {
    // Silence here would send the verifier hunting a mysterious
    // `vitest: not found` in a tree that was never the problem.
    const r = run();
    expect(r.dependencies).toBeNull();
    expect(r.note).toContain('no `node_modules`');
    expect(r.note).toContain('never in the review worktree');
  });

  it('is unavailable — not silently degraded — when there is no worktree', () => {
    const r = runScratchTree({
      worktree: join(repo, 'no', 'such', 'tree'),
      label: 'verify',
    });
    expect(r.available).toBe(false);
    expect(r.path).toBeUndefined();
    expect(r.note).toContain('does not exist');
  });

  // Windows as well as root: `chmodSync` on a directory there sets only the
  // read-only attribute, which does not stop `git worktree add` from creating a
  // subdirectory — the guard would be a no-op and the assertion below would fail
  // on the merge-queue-only Windows leg. Every other chmod-permission test in
  // this repo skips win32 for the same reason.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps the measured residue when the tree could not be created',
    () => {
      // The failure path must not collapse to the empty-residue default: a note
      // that names contaminated paths beside a `sharedTreeResidue: []` field
      // tells a reader and a script two different things.
      writeFileSync(join(worktree, '__probe__.test.ts'), 'it("x", () => {});');
      const parent = join(repo, '.qwen', 'tmp');
      chmodSync(parent, 0o555); // `git worktree add` cannot create the directory
      try {
        const r = runScratchTree({ worktree, label: 'verify--round-1--zzz' });
        expect(r.available).toBe(false);
        expect(r.sharedTreeResidue).toEqual(['__probe__.test.ts']);
        // The total belongs to the same report: a list longer than its own total
        // contradicts what the field documents.
        expect(r.sharedTreeResidueTotal).toBe(1);
        expect(r.note).toContain('NOT clean');
        expect(r.note).toContain(
          'Do NOT fall back to probing in the review worktree',
        );
      } finally {
        chmodSync(parent, 0o755);
      }
    },
  );

  describe('the command wiring', () => {
    beforeEach(() => {
      process.exitCode = undefined;
      (writeStdoutLine as unknown as ReturnType<typeof vi.fn>).mockClear();
    });
    afterEach(() => {
      process.exitCode = undefined;
    });

    it('parses --admin-dir/--admin-dev-ino into the fields the handler reads', async () => {
      // Every other test builds args by hand with the camelCase keys; the
      // handler does `argv as unknown as ScratchTreeArgs`, trusting yargs'
      // camel-case expansion. Renaming either flag or field makes every
      // real invocation run unanchored while this suite stays green — the
      // class this repo already shipped once. Parse real tokens through the
      // builder, drive the real handler, and use the referent-swap forge as
      // the fixture: it passes an UNANCHORED probe (certified clean), so an
      // anchored refusal in the printed report proves both flags reached
      // the probe.
      writeFileSync(join(worktree, 'a.ts'), 'export const x = 2; // MUTANT\n');
      writeFileSync(join(worktree, '__probe__.test.ts'), 'probe');
      const expected = git(
        worktree,
        'rev-parse',
        '--path-format=absolute',
        '--git-dir',
      );
      const entry = statSync(expected);

      const forge = join(repo, 'forge');
      mkdirSync(forge);
      git(forge, 'init', '-q', '-b', 'main', '--template=');
      git(forge, 'config', 'user.email', 't@t.t');
      git(forge, 'config', 'user.name', 't');
      writeFileSync(join(forge, 'a.ts'), 'export const x = 2; // MUTANT\n');
      writeFileSync(join(forge, '__probe__.test.ts'), 'probe');
      // The worktree checkout also carries the repo's `.gitignore`; the
      // forge commits it too, or an UNANCHORED probe on this fixture
      // measures residue instead of certifying clean — and the control run
      // the comment above implies would misdiagnose the fixture.
      writeFileSync(
        join(forge, '.gitignore'),
        readFileSync(join(worktree, '.gitignore')),
      );
      git(forge, 'add', '-A');
      git(forge, 'commit', '-qm', 'the mutant, as if it were the commit');
      git(forge, 'config', 'core.worktree', worktree);
      writeFileSync(
        join(forge, '.git', 'gitdir'),
        `${join(worktree, '.git')}\n`,
      );
      // Retarget the RECORDED entry at the forge; the gitfile is untouched.
      rmSync(expected, { recursive: true, force: true });
      symlinkSync(join(forge, '.git'), expected);

      await yargs([
        'scratch-tree',
        '--worktree',
        worktree,
        '--label',
        'verify--round-1--wiring',
        '--admin-dir',
        expected,
        '--admin-dev-ino',
        `${entry.dev}:${entry.ino}`,
      ])
        .command(scratchTreeCommand)
        .strict()
        .exitProcess(false)
        .fail((msg, err) => {
          throw err ?? new Error(msg ?? 'yargs failure');
        })
        .parseAsync();

      const printed = JSON.parse(
        String(
          (writeStdoutLine as unknown as ReturnType<typeof vi.fn>).mock
            .calls[0][0],
        ),
      );
      expect(printed.available).toBe(false);
      expect(printed.sharedTreeUnmeasured).toContain(
        'filesystem identity changed',
      );
      expect(process.exitCode).toBeUndefined();
    });

    it('refuses --admin-dev-ino without --admin-dir — the pair is the check', async () => {
      // A lone dev:ino anchors nothing: silently discarding it ran the
      // probe fully unanchored while the caller believed an identity check
      // was applied. Reject the contradictory invocation at parse time.
      // (Async-function form: a throwing fail handler makes `parseAsync`
      // itself throw synchronously, so there is no rejection to await.)
      await expect(async () =>
        yargs([
          'scratch-tree',
          '--worktree',
          worktree,
          '--label',
          'verify--round-1--wiring',
          '--admin-dev-ino',
          '64:4242',
        ])
          .command(scratchTreeCommand)
          .strict()
          .exitProcess(false)
          .fail((msg, err) => {
            throw err ?? new Error(msg ?? 'yargs failure');
          })
          .parseAsync(),
      ).rejects.toThrow(/admin-dir/);
    });

    it('parses --expected-head-sha and refuses a rewritten worktree HEAD end-to-end', async () => {
      // The persistent shape: one write of `<common>/worktrees/<id>/HEAD`
      // inside the verified repository — no race, every identity check
      // passes — and the scratch tree materialises the attacker's commit.
      // Driven through the real builder and handler, because the flag must
      // reach `expectedHeadSha` or every real invocation runs without the
      // content check while this suite stays green.
      const admin = git(
        worktree,
        'rev-parse',
        '--path-format=absolute',
        '--git-dir',
      );
      writeFileSync(join(repo, 'evil.ts'), 'evil\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-qm', 'evil');
      const evilSha = git(repo, 'rev-parse', 'HEAD');
      writeFileSync(join(admin, 'HEAD'), `${evilSha}\n`);

      await yargs([
        'scratch-tree',
        '--worktree',
        worktree,
        '--label',
        'verify--round-1--wiring-sha',
        '--expected-head-sha',
        headSha,
      ])
        .command(scratchTreeCommand)
        .strict()
        .exitProcess(false)
        .fail((msg, err) => {
          throw err ?? new Error(msg ?? 'yargs failure');
        })
        .parseAsync();

      const printed = JSON.parse(
        String(
          (writeStdoutLine as unknown as ReturnType<typeof vi.fn>).mock
            .calls[0][0],
        ),
      );
      expect(printed.available).toBe(false);
      expect(printed.note).toContain(evilSha.slice(0, 9));
      expect(process.exitCode).toBeUndefined();
    });
  });

  describe('the command handler', () => {
    beforeEach(() => {
      process.exitCode = undefined;
      (writeStdoutLine as unknown as ReturnType<typeof vi.fn>).mockClear();
    });
    afterEach(() => {
      process.exitCode = undefined;
    });

    it('refuses a directory --out BEFORE standing anything up', () => {
      // The class `assertWritableOutPath` exists for: without it the tree and
      // its farm are built, `writeFileSync` dies EISDIR, and a usage typo
      // exit-codes as a runtime failure with the usable tree's path lost.
      const outDir = join(repo, 'reports');
      mkdirSync(outDir, { recursive: true });
      (scratchTreeCommand.handler as (a: unknown) => void)({
        worktree,
        label: 'verify--round-1--out',
        out: outDir,
      });
      expect(process.exitCode).toBe(2);
      expect(
        existsSync(scratchWorktreePath(worktree, 'verify--round-1--out')),
      ).toBe(false);
    });

    it('prints the report before writing the side file', () => {
      const out = join(repo, 'reports', 'scratch.json');
      (scratchTreeCommand.handler as (a: unknown) => void)({
        worktree,
        label: 'verify--round-1--out',
        out,
      });
      expect(process.exitCode).toBeUndefined();
      const printed = (writeStdoutLine as unknown as ReturnType<typeof vi.fn>)
        .mock.calls[0][0] as string;
      expect(JSON.parse(printed).available).toBe(true);
      expect(JSON.parse(readFileSync(out, 'utf8')).path).toBe(
        scratchWorktreePath(worktree, 'verify--round-1--out'),
      );
    });

    it('keeps the report on stdout when the side-file write dies — and exits 1', () => {
      // The ordering is load-bearing, and both statements happening in either
      // order satisfies the test above. A self-referential symlink passes the
      // pre-check (`existsSync` is false through ELOOP) and throws at the write,
      // which is also the only exit-1 arm: without it, `exitCode = 2` as a
      // constant would pass every other case and tell a caller to repair a
      // sound invocation.
      const out = join(repo, 'reports', 'loop.json');
      mkdirSync(dirname(out), { recursive: true });
      symlinkSync(out, out);
      (scratchTreeCommand.handler as (a: unknown) => void)({
        worktree,
        label: 'verify--round-1--loop',
        out,
      });
      expect(process.exitCode).toBe(1);
      const printed = (writeStdoutLine as unknown as ReturnType<typeof vi.fn>)
        .mock.calls[0][0] as string;
      expect(JSON.parse(printed).available).toBe(true);
    });
  });
});
