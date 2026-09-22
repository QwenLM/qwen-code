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
import type { ShellExecutionResult } from '../services/shellExecutionService.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { CommitAttributionService } from '../services/commitAttribution.js';
import { ShellTool } from './shell.js';
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

vi.mock('../services/shellExecutionService.js', () => ({
  ShellExecutionService: { execute: realExecute },
  isSignalTermination: (signal: number | NodeJS.Signals | null) =>
    signal !== null && signal !== 0,
  getShellAbortReasonKind: (reason: unknown) =>
    typeof reason === 'object' &&
    reason !== null &&
    'kind' in reason &&
    reason.kind === 'background'
      ? 'background'
      : 'cancel',
}));

const AMEND_COMMAND = 'git commit --amend --no-edit';
const USER_PROMPT = 'please amend that commit';

describe('ShellTool session commit tracking (issue #12460)', () => {
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
});
