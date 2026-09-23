/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Witness tests for issue #12460.
 *
 * `packages/core/src/permissions/destructive-commands.ts` has carried a
 * session-commit registry (`registerSessionCommit` /
 * `isAmendOfSessionCommit` / `clearSessionCommits`) since the
 * `git commit --amend` guard landed, but no production code ever called
 * `registerSessionCommit`. The registry therefore stayed empty, the
 * "commit was made by the agent in this session" exemption was
 * unreachable, and Auto mode blocked *every* `git commit --amend`.
 *
 * These tests cross the wiring layer rather than the primitive: they run
 * a real `git commit` through `ShellToolInvocation.execute()` in a real
 * temporary git repository and then ask the destructive-command guard
 * whether the follow-up amend is allowed. Calling `registerSessionCommit`
 * directly would have been green before the fix and would prove nothing.
 *
 * The commands really execute (a fake `ShellExecutionService` runs them
 * through `child_process.spawnSync`), so `getGitHeadSync` / `getGitHead`
 * observe genuine pre/post HEAD values instead of stubbed SHAs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Config } from '../config/config.js';
import { ApprovalMode, deriveApprovalModeConfig } from '../config/config.js';
import {
  getShellAbortReasonKind,
  isSignalTermination,
  type ShellExecutionResult,
} from '../services/shellExecutionService.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { CommitAttributionService } from '../services/commitAttribution.js';
import { ShellTool } from './shell.js';
import { ToolNames } from './tool-names.js';
import { evaluateAutoMode } from '../permissions/autoMode.js';
import {
  clearSessionCommits,
  isDestructiveCommand,
} from '../permissions/destructive-commands.js';

/**
 * Runs the command for real in the requested cwd and shapes the result
 * like `ShellExecutionService.execute` does. Kept as a seam only so the
 * test does not depend on node-pty being loadable; nothing about the git
 * state is faked.
 */
const realExecute = vi.hoisted(() => vi.fn());

// Spread the real module and override only the executor. Re-implementing
// `isSignalTermination` / `getShellAbortReasonKind` here duplicates twelve
// lines from `shell.test.ts` and drifts: production reads `kind` as an *own*
// property inside a try/catch precisely so a prototype-only or throwing
// `kind` cannot reach the background branch, which a copy written from memory
// does not reproduce. The seam's stated reason survives the swap — `utils/
// getPty.ts` imports only `./errors.js` at module level and loads
// `@lydell/node-pty` lazily inside `loadPty()`, so importing the real module
// never pulls in a PTY.
vi.mock('../services/shellExecutionService.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../services/shellExecutionService.js')
  >()),
  ShellExecutionService: { execute: realExecute },
}));

const AMEND_COMMAND = 'git commit --amend --no-edit';
const USER_PROMPT = 'please amend that commit';

// The fake executor below really spawns `/bin/bash -c`, and that path does
// not exist on a Windows runner — `spawnSync` would fail with ENOENT, no
// commit would land, and the exemption rows would fail for a reason that has
// nothing to do with the code under test. Gated the same way as this repo's
// other real-bash suites (packages/cli/src/commands/review/drive.test.ts).
describe.skipIf(process.platform === 'win32')(
  'ShellTool session commit tracking (issue #12460)',
  () => {
    let repoDir: string;
    let shellTool: ShellTool;
    let mockConfig: Config;
    let mockAbortSignal: AbortSignal;

    /**
     * `isDestructiveCommand` returns `null` when it does not block, and a
     * `{ blocked: true, reason }` object when it does.
     */
    function amendVerdict(): ReturnType<typeof isDestructiveCommand> {
      return isDestructiveCommand(AMEND_COMMAND, USER_PROMPT, repoDir);
    }

    function headSha(): string {
      return execSync('git rev-parse HEAD', {
        cwd: repoDir,
        encoding: 'utf-8',
      }).trim();
    }

    /** Runs a git command straight through the shell, bypassing ShellTool. */
    function rawGit(args: string): void {
      execSync(`git ${args}`, { cwd: repoDir, stdio: 'ignore' });
    }

    async function runShellCommand(command: string): Promise<void> {
      const invocation = shellTool.build({ command, is_background: false });
      await invocation.execute(mockAbortSignal);
    }

    beforeEach(() => {
      vi.clearAllMocks();
      clearSessionCommits();
      CommitAttributionService.resetInstance();

      // Every repo below is real and every commit really runs, so a
      // machine-wide hook manager (`core.hooksPath` in the host's or the
      // system gitconfig — husky, lefthook, pre-commit) would run the host's
      // pre-commit hook inside the temp repo and decide whether this suite
      // passes: it expects the host's linters, exits non-zero, and every row
      // errors in `beforeEach`. Same scrub as `memory/team-memory-sync.test.ts`;
      // it also covers the fake executor, whose `spawnSync` passes no `env`.
      // The identity the rows assert on is set repo-locally and survives.
      vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
      vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');

      realExecute.mockImplementation(
        async (
          commandToExecute: string,
          cwd: string,
          onOutputEvent: (event: { type: 'data'; chunk: string }) => void,
        ) => {
          const spawned = spawnSync('/bin/bash', ['-c', commandToExecute], {
            cwd,
            encoding: 'utf-8',
            timeout: 30000,
          });
          const output = `${spawned.stdout ?? ''}${spawned.stderr ?? ''}`;
          if (output.length > 0) {
            onOutputEvent({ type: 'data', chunk: output });
          }
          const result: ShellExecutionResult = {
            rawOutput: Buffer.from(output),
            output,
            exitCode: spawned.status,
            signal: null,
            error: null,
            aborted: false,
            pid: 4242,
            executionMethod: 'child_process',
          };
          return { pid: 4242, result: Promise.resolve(result) };
        },
      );

      repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-12460-'));
      execSync('git init -q --initial-branch=main', { cwd: repoDir });
      execSync('git config user.email agent@example.com', { cwd: repoDir });
      execSync('git config user.name Agent', { cwd: repoDir });
      execSync('git config commit.gpgsign false', { cwd: repoDir });
      fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed\n');
      rawGit('add seed.txt');
      rawGit('commit -q -m "initial commit"');

      mockConfig = {
        getCoreTools: vi.fn().mockReturnValue([]),
        getPermissionsAllow: vi.fn().mockReturnValue([]),
        getPermissionsAsk: vi.fn().mockReturnValue([]),
        getPermissionsDeny: vi.fn().mockReturnValue([]),
        getDebugMode: vi.fn().mockReturnValue(false),
        getTargetDir: vi.fn().mockReturnValue(repoDir),
        getSessionId: vi.fn().mockReturnValue('test-session'),
        getWorkspaceContext: vi
          .fn()
          .mockReturnValue(createMockWorkspaceContext(repoDir)),
        storage: {
          getUserSkillsDirs: vi.fn().mockReturnValue([]),
          getProjectTempDir: vi.fn().mockReturnValue(repoDir),
          getProjectDir: vi.fn().mockReturnValue(repoDir),
        },
        getTruncateToolOutputThreshold: vi.fn().mockReturnValue(0),
        getTruncateToolOutputLines: vi.fn().mockReturnValue(0),
        isTruncateToolOutputThresholdExplicit: vi.fn().mockReturnValue(false),
        getPermissionManager: vi.fn().mockReturnValue(undefined),
        getLlmClient: vi.fn(),
        getModel: vi.fn().mockReturnValue('qwen3-coder-plus'),
        isInteractive: vi.fn().mockReturnValue(true),
        getGitCoAuthor: vi.fn().mockReturnValue({
          commit: true,
          pr: true,
          name: 'Qwen-Coder',
          email: 'qwen-coder@alibabacloud.com',
        }),
        getShouldUseNodePtyShell: vi.fn().mockReturnValue(false),
        getShellDefaultTimeoutMs: vi.fn().mockReturnValue(undefined),
        getShellHeartbeatIntervalMs: vi.fn().mockReturnValue(undefined),
        getBackgroundShellRegistry: vi.fn().mockReturnValue({
          register: vi.fn(),
          get: vi.fn(),
          getAll: vi.fn().mockReturnValue([]),
          cancel: vi.fn(),
          complete: vi.fn(),
          fail: vi.fn(),
        }),
      } as unknown as Config;

      shellTool = new ShellTool(mockConfig);
      mockAbortSignal = new AbortController().signal;
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      clearSessionCommits();
      CommitAttributionService.resetInstance();
      fs.rmSync(repoDir, { recursive: true, force: true });
    });

    it('registers a commit the shell tool really landed, so the follow-up amend is exempt', async () => {
      // Sanity: with an empty registry the guard blocks the amend. This is
      // the pre-fix behaviour for *every* amend, and it must stay true for
      // commits the agent did not make (see the regressions below).
      expect(amendVerdict()?.blocked).toBe(true);

      fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'work\n');
      const preHead = headSha();
      await runShellCommand('git add feature.txt && git commit -m "feature"');

      // The commit must have genuinely landed, otherwise the test would be
      // observing a stubbed HEAD rather than real git state.
      expect(realExecute).toHaveBeenCalled();
      expect(headSha()).not.toBe(preHead);
      expect(
        execSync('git log -1 --pretty=%s', {
          cwd: repoDir,
          encoding: 'utf-8',
        }).trim(),
      ).toBe('feature');

      // Witness assertion for #12460: the agent's own commit is now
      // registered, so the session exemption is reachable and the guard
      // returns null (no block). Before the fix `registerSessionCommit`
      // had no production caller, the registry stayed empty, and this was
      // `blocked: true` for every amend.
      expect(amendVerdict()).toBeNull();
    });

    it('still blocks an amend of a commit the shell tool did not make', async () => {
      // Regression ①: a commit created outside the shell tool (a user
      // commit, or one from another session) must not be exempted — the
      // guard has to keep blocking.
      fs.writeFileSync(path.join(repoDir, 'human.txt'), 'human\n');
      rawGit('add human.txt');
      rawGit('commit -q -m "human commit"');

      expect(amendVerdict()?.blocked).toBe(true);
      expect(amendVerdict()?.reason).toContain(
        'not made by the agent in this session',
      );
    });

    it('does not register HEAD when the commit failed and HEAD did not move', async () => {
      // Regression ②: `git commit` with nothing staged exits non-zero and
      // leaves HEAD where it was. Registering that HEAD would exempt an
      // amend of a commit the agent never made.
      const preHead = headSha();
      await runShellCommand('git commit -m "nothing staged"');
      expect(headSha()).toBe(preHead);

      expect(amendVerdict()?.blocked).toBe(true);
    });

    it('does not register a HEAD that a pull moved when the commit never landed', async () => {
      // Regression ⑤ — the fail-open half of ②. HEAD *did* move, but not
      // because of the agent's `git commit`: `git pull` fast-forwards onto
      // somebody else's commit and the `git commit` segment then exits
      // non-zero with nothing staged. Registering that HEAD would exempt an
      // amend of a commit the agent never authored, which lifts the
      // deterministic Auto-mode block and leaves a history rewrite to the
      // non-deterministic classifier.
      //
      // The chain really does reach the registration call site:
      // `gitCommitContext` only latches `cwdShifted` on cd/pushd/popd or a
      // cwd-shifting git flag, and `git pull` is neither, so
      // `attributableInCwd` stays true; and the call site is gated on
      // sandbox/attributability only, with no exit-code condition.
      const upstreamDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'qwen-12460-upstream-'),
      );
      try {
        execSync('git init -q --initial-branch=main', { cwd: upstreamDir });
        execSync('git config user.email upstream@example.com', {
          cwd: upstreamDir,
        });
        execSync('git config user.name "Upstream Author"', {
          cwd: upstreamDir,
        });
        execSync('git config commit.gpgsign false', { cwd: upstreamDir });
        fs.writeFileSync(path.join(upstreamDir, 'seed.txt'), 'seed\n');
        execSync('git add seed.txt && git commit -q -m "initial commit"', {
          cwd: upstreamDir,
        });
        fs.writeFileSync(
          path.join(upstreamDir, 'upstream.txt'),
          'upstream work\n',
        );
        execSync('git add upstream.txt && git commit -q -m "upstream work"', {
          cwd: upstreamDir,
        });
        const upstreamHead = execSync('git rev-parse HEAD', {
          cwd: upstreamDir,
          encoding: 'utf-8',
        }).trim();

        // Put the working repo on upstream's history one commit behind, so
        // the pull is a genuine fast-forward rather than an unrelated-history
        // merge.
        execSync(`git fetch -q ${upstreamDir} main`, { cwd: repoDir });
        execSync('git reset -q --hard FETCH_HEAD', { cwd: repoDir });
        execSync('git reset -q --hard HEAD~1', { cwd: repoDir });
        execSync(`git remote add upstream ${upstreamDir}`, { cwd: repoDir });

        const preHead = headSha();
        // The pull succeeds and moves HEAD; the commit then exits non-zero
        // because nothing is staged, so the whole chain's exit code is 1.
        await runShellCommand(
          'git pull -q upstream main && git commit -m "agent work"',
        );

        const postHead = headSha();
        // HEAD really moved, and onto the upstream author's commit — so a
        // criterion based on HEAD movement alone cannot tell this apart from
        // a commit the agent landed itself.
        expect(postHead).not.toBe(preHead);
        expect(postHead).toBe(upstreamHead);
        expect(
          execSync('git log -1 --pretty=%ae', {
            cwd: repoDir,
            encoding: 'utf-8',
          }).trim(),
        ).toBe('upstream@example.com');
        expect(
          execSync('git log -1 --pretty=%s', {
            cwd: repoDir,
            encoding: 'utf-8',
          }).trim(),
        ).toBe('upstream work');

        // Witness assertion: the agent did not produce this HEAD, so the
        // amend must stay blocked.
        expect(amendVerdict()?.blocked).toBe(true);
        expect(amendVerdict()?.reason).toContain(
          'not made by the agent in this session',
        );
      } finally {
        fs.rmSync(upstreamDir, { recursive: true, force: true });
      }
    });

    /**
     * Creates a second branch whose tip differs from `main`'s, then returns
     * to `main`. A trailing `checkout` / `reset` in a chain has to land HEAD
     * somewhere *other* than the pre-command HEAD, otherwise the
     * `head.sha !== preHead` term alone rejects the registration and the
     * reflog verb goes untested.
     */
    function createOtherBranchTip(): string {
      fs.writeFileSync(path.join(repoDir, 'other.txt'), 'other\n');
      rawGit('checkout -q -b other');
      rawGit('add other.txt');
      rawGit('commit -q -m "other work"');
      const otherHead = headSha();
      rawGit('checkout -q main');
      return otherHead;
    }

    it('does not register when a later segment checked HEAD out away from the commit', async () => {
      // Regression ⑥ — the trailing half of ⑤. Here the agent's `git commit`
      // really does land, and a later segment of the same chain then moves
      // HEAD off it onto a commit the agent never created. The newest reflog
      // entry is that move rather than the commit, so nothing registers, and
      // exempting an amend of it would rewrite somebody else's commit.
      //
      // ⑤ pins the leading move, this pins the trailing one. Both are needed:
      // a criterion that also accepted `checkout` / `reset` entries, or one
      // that rejected only `pull`, passes ⑤ and fails here.
      const seedHead = headSha();
      const otherHead = createOtherBranchTip();
      expect(headSha()).toBe(seedHead);
      fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'work\n');

      await runShellCommand(
        'git add feature.txt && git commit -m "feature" && git checkout -q other',
      );

      // The commit landed, but the chain left HEAD on `other`'s tip — a
      // different SHA from preHead, so only the reflog verb can reject it.
      expect(headSha()).toBe(otherHead);
      expect(headSha()).not.toBe(seedHead);
      expect(amendVerdict()?.blocked).toBe(true);
    });

    it('does not register when a later segment reset HEAD off the commit', async () => {
      // Regression ⑦ — same shape as ⑥ with `reset` instead of `checkout`,
      // so neither verb is special-cased by accident.
      const seedHead = headSha();
      const otherHead = createOtherBranchTip();
      expect(headSha()).toBe(seedHead);
      fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'work\n');

      await runShellCommand(
        'git add feature.txt && git commit -m "feature" && git reset -q --hard other',
      );

      expect(headSha()).toBe(otherHead);
      expect(headSha()).not.toBe(seedHead);
      expect(amendVerdict()?.blocked).toBe(true);
    });

    it('registers the commit when a later segment makes the chain exit non-zero', async () => {
      // Regression ⑧ — pins the *absence* of an exit-code gate at the call
      // site. `trackSessionCommit`'s docblock argues for that absence (`git
      // commit -m x && npm test` can land the commit and then fail) and
      // `:4199-4201` cites it as part of why regression ⑤ reaches the code,
      // but every other registration-expecting row drives a chain that exits
      // 0, so nothing fails when a contributor adds the gate. Gating
      // registration on the commit's own outcome was proposed as a fix
      // direction on this PR twice, so this is the hardening a reader of that
      // thread is most likely to apply — and it would pass review on a green
      // suite while reintroducing #12460's false block for exactly the shape
      // the docblock endorses.
      //
      // The trailing `&& false` is load-bearing twice over: it makes the
      // chain exit 1 (`bash -c 'true && false'` → 1) while leaving the newest
      // HEAD reflog entry a `commit:` verb, which is the term under test. A
      // trailing `git checkout` / `git reset` would also exit non-zero but
      // collide with ⑥/⑦ and mute the verb mutants.
      const preHead = headSha();
      fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'work\n');

      await runShellCommand(
        'git add feature.txt && git commit -m "feature" && false',
      );

      expect(headSha()).not.toBe(preHead);
      expect(
        execSync('git log -g -1 --format=%gs', {
          cwd: repoDir,
          encoding: 'utf-8',
        }).trim(),
      ).toMatch(/^commit\b/);
      expect(amendVerdict()).toBeNull();
    });

    it('registers nothing when the reflog cannot answer, so the amend stays blocked', async () => {
      // Regression ⑨ — the fail-closed branch itself. `getGitHeadOrigin`
      // resolves `null` when git cannot say what put HEAD there, and
      // `trackSessionCommit` then registers nothing. No other row reaches
      // that branch: every repo above has a readable HEAD reflog. The
      // plausible refactor — falling back to `getGitHead(cwd)` at a `null`
      // exit so a reflogs-off repo does not lose the exemption — keeps all of
      // them green while degrading the criterion to HEAD-movement-only, which
      // re-opens the fail-open ⑤/⑥/⑦ exist to prevent: a `git pull`
      // fast-forwarding onto a human commit would register as the agent's own.
      //
      // `core.logAllRefUpdates=false` has to be in effect *before* the seed
      // commit, because git creates `.git/logs/HEAD` on the first logged ref
      // update and a repo that already has one keeps answering the probe —
      // the row would then pass through the `head.sha !== preHead` term
      // instead of the branch it is about. Hence the rebuild of the repo
      // `beforeEach` already created, at the same path, so the helpers and the
      // config still point at it. Measured against real git: `.git/logs/HEAD`
      // is never created, and `git log -g -1 --format='%H%n%gs' HEAD` exits 0
      // with EMPTY stdout, so the exit taken is `!sha || !subject` and not the
      // `error` exit: a fallback written only at the `error` exit never runs
      // for this repo and does not model the refactor.
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.mkdirSync(repoDir, { recursive: true });
      execSync('git init -q --initial-branch=main', { cwd: repoDir });
      execSync('git config core.logAllRefUpdates false', { cwd: repoDir });
      execSync('git config user.email agent@example.com', { cwd: repoDir });
      execSync('git config user.name Agent', { cwd: repoDir });
      execSync('git config commit.gpgsign false', { cwd: repoDir });
      fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed\n');
      rawGit('add seed.txt');
      rawGit('commit -q -m "initial commit"');
      expect(fs.existsSync(path.join(repoDir, '.git', 'logs', 'HEAD'))).toBe(
        false,
      );

      const preHead = headSha();
      fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'work\n');
      await runShellCommand('git add feature.txt && git commit -m "feature"');

      // The commit genuinely landed and HEAD moved, so a movement-only
      // criterion would register it. Only the unanswerable reflog stops it,
      // and the cost is a blocked amend rather than a lifted block.
      expect(headSha()).not.toBe(preHead);
      expect(amendVerdict()?.blocked).toBe(true);
    });

    it('registers the rewritten HEAD after an amend so amend-of-amend is exempt', async () => {
      // Regression ③: an amend replaces HEAD, so the new SHA has to be
      // registered too — otherwise the second amend in a row is blocked.
      fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'work\n');
      await runShellCommand('git add feature.txt && git commit -m "feature"');
      expect(amendVerdict()).toBeNull();

      fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'work v2\n');
      const preAmendHead = headSha();
      await runShellCommand(
        'git add feature.txt && git commit --amend --no-edit',
      );

      // The amend rewrote HEAD, so the SHA the guard will read is a new
      // one that was never registered by the original commit.
      expect(headSha()).not.toBe(preAmendHead);
      const amendedSubject = execSync('git log -1 --pretty=%s', {
        cwd: repoDir,
        encoding: 'utf-8',
      }).trim();
      expect(amendedSubject).toBe('feature');

      expect(amendVerdict()).toBeNull();
    });

    it('registers the commit even when gitCoAuthor.commit attribution is disabled', async () => {
      // Regression ④: session tracking is deliberately independent of the
      // commit-attribution toggle. A user who turned attribution off must
      // not lose the amend exemption.
      (mockConfig.getGitCoAuthor as ReturnType<typeof vi.fn>).mockReturnValue({
        commit: false,
        pr: false,
        name: 'Qwen-Coder',
        email: 'qwen-coder@alibabacloud.com',
      });

      fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'work\n');
      await runShellCommand('git add feature.txt && git commit -m "feature"');

      // Prove the toggle really took effect: no Co-authored-by trailer was
      // injected into the commit.
      const body = execSync('git log -1 --pretty=%B', {
        cwd: repoDir,
        encoding: 'utf-8',
      });
      expect(body).not.toContain('Co-authored-by');

      // ...and the amend exemption still works, because session tracking
      // does not consult the attribution toggle.
      expect(amendVerdict()).toBeNull();
    });

    /**
     * Commits a real change through the shell tool and asserts the amend
     * exemption was earned, so the mode-switch cases below start from a
     * populated registry rather than an empty one (an empty registry would
     * make "blocked again" pass for the wrong reason).
     */
    async function commitAndAssertExempt(): Promise<void> {
      fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'work\n');
      await runShellCommand('git add feature.txt && git commit -m "feature"');
      expect(amendVerdict()).toBeNull();
    }

    it('clears the registry on a mode switch so the amend is blocked again', async () => {
      // Fail-closed witness for the `clearSessionCommits()` contract
      // ("Called on session end or mode switch"): exemptions earned under
      // one approval mode must not carry across a mode boundary.
      await commitAndAssertExempt();

      // Constructed already in DEFAULT (rather than switching into it) so
      // the registry is not cleared before the transition under test.
      const realConfig = makeFakeConfig({
        targetDir: repoDir,
        cwd: repoDir,
        approvalMode: ApprovalMode.DEFAULT,
      });
      vi.spyOn(realConfig, 'isTrustedFolder').mockReturnValue(true);
      expect(realConfig.getApprovalMode()).toBe(ApprovalMode.DEFAULT);

      realConfig.setApprovalMode(ApprovalMode.AUTO);
      expect(realConfig.getApprovalMode()).toBe(ApprovalMode.AUTO);

      // Same repo, same commit, same command — but the mode switched, so
      // the guard blocks again and the user has to re-approve.
      expect(amendVerdict()?.blocked).toBe(true);
    });

    it('keeps the exemption when the approval mode is re-set to its current value', async () => {
      // Guard against over-clearing: several callers re-set the mode they
      // are already in, and wiping the registry there would silently take
      // the amend exemption away mid-session.
      await commitAndAssertExempt();

      const realConfig = makeFakeConfig({
        targetDir: repoDir,
        cwd: repoDir,
        approvalMode: ApprovalMode.DEFAULT,
      });
      const currentMode = realConfig.getApprovalMode();
      expect(currentMode).toBe(ApprovalMode.DEFAULT);

      realConfig.setApprovalMode(currentMode);

      expect(amendVerdict()).toBeNull();
    });

    it('resolves the guard against the target dir when the call passes no directory', async () => {
      // The guard has to inspect the same repository the shell tool registered
      // in. `ShellToolInvocation` resolves its cwd as
      // `this.params.directory || this.config.getTargetDir()`, but
      // `PermissionCheckContext.cwd` is optional and is only set when a call
      // passes `directory`. Handing `undefined` to `isDestructiveCommand`
      // lands on `process.cwd()` inside its `git rev-parse`, which in a
      // process hosting several sessions (ACP, daemon) or several worktrees is
      // wherever the *process* started — so the exemption could be read out of
      // one repository's registry while the amend rewrites another's.
      await commitAndAssertExempt();

      const realConfig = makeFakeConfig({
        targetDir: repoDir,
        cwd: repoDir,
        approvalMode: ApprovalMode.AUTO,
      });
      vi.spyOn(realConfig, 'isTrustedFolder').mockReturnValue(true);
      expect(realConfig.getTargetDir()).toBe(repoDir);

      const decision = await evaluateAutoMode({
        // No `cwd` on the context — this is the shape a plain shell call has.
        ctx: { toolName: ToolNames.SHELL, command: AMEND_COMMAND },
        pmForcedAsk: false,
        toolParams: {},
        messages: [{ role: 'user', parts: [{ text: USER_PROMPT }] }],
        config: realConfig,
        signal: new AbortController().signal,
        // Keep the LLM classifier out of it; the assertion is about L5.2.5.
        skipClassifierReason: 'total_denial',
      });

      expect(decision.via).not.toBe('blocked:destructive-command');
    });

    it('keeps production abort/signal helpers behind the executor-only mock', () => {
      // The seam exists so this suite does not depend on node-pty, and it
      // replaces `execute` only. Production reads `kind` as an *own* property
      // inside a try/catch, precisely so a prototype-only or throwing `kind`
      // cannot take the promote branch; a hand-rolled copy written with
      // `'kind' in reason` returns 'background' on the input below. This row
      // is what keeps such a copy from coming back.
      expect(
        getShellAbortReasonKind(Object.create({ kind: 'background' })),
      ).toBe('cancel');
      expect(isSignalTermination(0)).toBe(false);
      expect(isSignalTermination('SIGTERM')).toBe(true);
    });

    it('keeps the root registry when a derived overlay changes its own mode', async () => {
      // `deriveApprovalModeConfig` installs an own `setApprovalMode` that
      // delegates to the prototype method, so a subagent's child-local
      // transition cleared the *root* session's registry — against the design
      // that such transitions stay child-local. The root session then
      // hard-blocked an amend of its own commit, minutes old, with a reason
      // that is false. Clearing is fail-closed, so the cost is a wrong block
      // rather than a lifted one, but it is still the wrong answer.
      await commitAndAssertExempt();

      const realConfig = makeFakeConfig({
        targetDir: repoDir,
        cwd: repoDir,
        approvalMode: ApprovalMode.AUTO,
      });
      vi.spyOn(realConfig, 'isTrustedFolder').mockReturnValue(true);

      const overlay = deriveApprovalModeConfig(
        realConfig,
        realConfig.getApprovalMode(),
      );
      overlay.config.setApprovalMode(ApprovalMode.AUTO_EDIT);

      // The transition really happened, and it stayed child-local.
      expect(overlay.config.getApprovalMode()).toBe(ApprovalMode.AUTO_EDIT);
      expect(realConfig.getApprovalMode()).toBe(ApprovalMode.AUTO);

      expect(amendVerdict()).toBeNull();
    });
  },
);
