/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Verifies the bundled /review skill's frontmatter hook configuration
// survives parsing — the hook is what enforces the worktree contract for
// weakly instruction-following models, so a YAML regression here would be
// silently catastrophic.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { SkillManager } from '../../skill-manager.js';
import type { CommandHookConfig } from '../../../hooks/types.js';
import { HookEventName } from '../../../hooks/types.js';
import { makeFakeConfig } from '../../../test-utils/config.js';

const skillDir = path.dirname(fileURLToPath(import.meta.url));
const skillFile = path.join(skillDir, 'SKILL.md');
const guardScript = path.join(skillDir, 'guard.sh');

describe('bundled review skill', () => {
  let parsed: ReturnType<SkillManager['parseSkillContent']>;

  beforeAll(() => {
    const manager = new SkillManager(makeFakeConfig());
    const content = fs.readFileSync(skillFile, 'utf8');
    parsed = manager.parseSkillContent(content, skillFile, 'bundled');
  });

  it('declares a PreToolUse hook on run_shell_command', () => {
    expect(parsed.hooks).toBeDefined();
    const preToolUse = parsed.hooks?.[HookEventName.PreToolUse];
    expect(preToolUse).toBeDefined();
    expect(preToolUse).toHaveLength(1);
    expect(preToolUse?.[0]?.matcher).toBe('run_shell_command');
    expect(preToolUse?.[0]?.hooks).toHaveLength(1);
    const hook = preToolUse?.[0]?.hooks?.[0] as CommandHookConfig;
    expect(hook.type).toBe('command');
    expect(hook.command).toContain('guard.sh');
    // Regression guard for the round-1 `timeout: 5` bug — `hookRunner.ts`
    // treats command-hook timeouts as milliseconds, so 5 (≈ 0.005s) made the
    // guard always time out and silently fail open. Anything ≥ 1000ms gives
    // bash + jq + grep enough room to finish; pinning a floor here means a
    // future SKILL.md edit can't accidentally reintroduce the regression.
    expect(hook.timeout).toBeGreaterThanOrEqual(1000);
    // Pinning the outer shell to bash is what makes `$QWEN_SKILL_ROOT`
    // expand on Windows (cmd.exe / PowerShell don't expand `$VAR`).
    expect(hook.shell).toBe('bash');
  });

  it('ships an executable guard.sh alongside SKILL.md', () => {
    const stat = fs.statSync(guardScript);
    expect(stat.isFile()).toBe(true);
    // NTFS doesn't track unix execute bits, so the mode check is meaningful
    // only on POSIX. On Windows the file is invoked via `bash` which doesn't
    // require the +x bit anyway.
    if (process.platform !== 'win32') {
      // 0o111 = any-execute bit; the bundled file ships as 0755 in source control.
      expect(stat.mode & 0o111).toBeGreaterThan(0);
    }
  });

  describe('guard.sh', () => {
    let cwd: string;

    beforeAll(() => {
      cwd = mkdtempSync(path.join(tmpdir(), 'qwen-review-guard-'));
      mkdirSync(path.join(cwd, '.qwen', 'tmp'), { recursive: true });
      // Simulate an active /review session — the guard self-disables when no
      // fetch-pr report is present (lifecycle backstop for the no-op
      // `unregisterSkillHooks`). Without this stub, every command below
      // would fall straight through to `allow` and the deny matrix would be
      // exercising the wrong code path.
      writeFileSync(
        path.join(cwd, '.qwen', 'tmp', 'qwen-review-pr-1-fetch.json'),
        '{}',
      );
    });

    afterAll(() => {
      // The individual self-disable test creates its own tmpdir and
      // cleans up; the shared one created here was being left behind on
      // every test run. Remove it explicitly.
      fs.rmSync(cwd, { recursive: true, force: true });
    });

    function runGuard(input: object): { stdout: string; exitCode: number } {
      try {
        // Mirror hookRunner.ts:575 — the real hook receives
        // `QWEN_PROJECT_DIR` in env. The guard uses that env var (not
        // bash's cwd) to anchor its session-marker lookup, so tests must
        // pass it too or the self-disable branch fires on every command.
        const stdout = execFileSync('bash', [guardScript], {
          input: JSON.stringify(input),
          encoding: 'utf8',
          cwd,
          env: { ...process.env, QWEN_PROJECT_DIR: cwd },
        });
        return { stdout, exitCode: 0 };
      } catch (err) {
        const e = err as { stdout?: string; status?: number };
        return { stdout: e.stdout ?? '', exitCode: e.status ?? 1 };
      }
    }

    it.each([
      // Bare branch-mutating forms.
      'gh pr checkout 123',
      'git checkout main',
      'git switch feature',
      'git pull origin main',
      'git reset --hard HEAD~1',
      // Rule-4 broaden: every `git reset` variant that moves HEAD is now
      // denied; only `git reset -- <pathspec>` (and bare `git reset`)
      // remain in the allow list below.
      'git reset HEAD~1',
      'git reset --soft HEAD~1',
      'git reset --mixed HEAD~1',
      'git reset --keep BRANCH',
      'git reset --merge',
      // Flag-based HEAD mutations the previous `[^-]` rule let through.
      'git checkout -b new',
      'git checkout -B existing',
      'git checkout -c new',
      'git checkout --detach HEAD',
      'git checkout --orphan greenfield',
      'git switch -c new',
      'git switch -C existing',
      'git switch --detach HEAD',
      // Shell-composition bypasses the previous prefix rule missed.
      '(git checkout main)',
      'echo $(git checkout main)',
      'echo `git checkout main`',
      'echo x|git checkout main',
      'false||git pull',
      'eval "git checkout main"',
      // `$IFS` / `${IFS}` parameter-expansion bypasses — bash splits these
      // into whitespace at runtime, so the literal command string seen by
      // the regex doesn't contain a `git <verb>` sequence. Rule 6 denies
      // any `$IFS` in the command outright.
      'git$IFS checkout main',
      'git${IFS}checkout main',
      'git${IFS:1}reset --hard HEAD',
      'gh$IFS pr checkout 123',
      'gh${IFS}pr checkout 123',
    ])('denies %s', (cmd) => {
      const { stdout } = runGuard({
        tool_name: 'run_shell_command',
        tool_input: { command: cmd },
      });
      const decision = JSON.parse(stdout);
      expect(decision.decision).toBe('deny');
      expect(decision.reason).toMatch(/Blocked during \/review/);
    });

    it.each([
      'git diff main...HEAD',
      'git checkout -- src/foo.ts',
      'git checkout -- .',
      'git checkout', // bare info form, no HEAD movement
      // Rule-4 safe forms — `git reset -- pathspec` unstages, `git reset`
      // alone unstages everything; neither moves HEAD.
      'git reset -- src/foo.ts',
      'git reset -- .',
      'git reset',
      'qwen review fetch-pr 123 octo/repo --out .qwen/tmp/x.json',
      'gh pr diff https://github.com/owner/repo/pull/1',
      'cd /tmp && ls',
      'ls -la',
      // Rule 6 ($IFS) must NOT fire on commit-message / changelog text that
      // references $IFS literally — anchor narrowing regression.
      "git commit -m 'fix: deny $IFS in guard.sh'",
      "echo 'documenting $IFS bypass' >> CHANGELOG.md",
      'echo $IFS',
    ])('allows %s', (cmd) => {
      const { stdout } = runGuard({
        tool_name: 'run_shell_command',
        tool_input: { command: cmd },
      });
      const decision = JSON.parse(stdout);
      expect(decision.decision).toBe('allow');
    });

    it('allows non-shell tools to pass through', () => {
      const { stdout } = runGuard({
        tool_name: 'read_file',
        tool_input: { path: '/etc/passwd' },
      });
      const decision = JSON.parse(stdout);
      expect(decision.decision).toBe('allow');
    });

    it('self-disables when no /review session is active', () => {
      // The hook outlives any single /review invocation because
      // `unregisterSkillHooks` is a no-op. If no fetch-pr report exists, the
      // guard must NOT deny the user's other work even on otherwise-blocked
      // commands.
      const otherCwd = mkdtempSync(path.join(tmpdir(), 'qwen-review-noop-'));
      try {
        const stdout = execFileSync('bash', [guardScript], {
          input: JSON.stringify({
            tool_name: 'run_shell_command',
            tool_input: { command: 'git checkout main' },
          }),
          encoding: 'utf8',
          cwd: otherCwd,
          env: { ...process.env, QWEN_PROJECT_DIR: otherCwd },
        });
        const decision = JSON.parse(stdout);
        expect(decision.decision).toBe('allow');
      } finally {
        fs.rmSync(otherCwd, { recursive: true, force: true });
      }
    });

    it('denies via the cwd fallback when QWEN_PROJECT_DIR is unset and the report is in cwd', () => {
      // Defensive regression: if hookRunner.ts ever stops passing
      // QWEN_PROJECT_DIR, the `${QWEN_PROJECT_DIR:-.}` fallback uses
      // bash's cwd. Without an explicit test of the fallback path, a
      // regression that drops the env var would silently degrade the
      // guard to "self-disable in worktree, allow everything" with no
      // test failing — exactly the failure shape the env-var anchor
      // was added to prevent.
      const env = { ...process.env };
      delete env['QWEN_PROJECT_DIR'];
      const stdout = execFileSync('bash', [guardScript], {
        input: JSON.stringify({
          tool_name: 'run_shell_command',
          tool_input: { command: 'git checkout main' },
        }),
        encoding: 'utf8',
        cwd,
        env,
      });
      const decision = JSON.parse(stdout);
      expect(decision.decision).toBe('deny');
    });

    it('still denies when bash cwd drifts into the worktree but QWEN_PROJECT_DIR points at the project root', () => {
      // Regression: an earlier draft anchored the session-marker lookup at
      // bash's cwd, which the LLM is supposed to set to the worktree during
      // a compliant review flow. That made the self-disable branch fire
      // exactly when the guard most needed to deny — `git checkout main`
      // from inside the worktree would otherwise contaminate the user's
      // main checkout. Use QWEN_PROJECT_DIR (set by hookRunner) to anchor.
      const worktreeCwd = path.join(cwd, '.qwen', 'tmp', 'review-pr-1');
      mkdirSync(worktreeCwd, { recursive: true });
      const stdout = execFileSync('bash', [guardScript], {
        input: JSON.stringify({
          tool_name: 'run_shell_command',
          tool_input: { command: 'git checkout main' },
        }),
        encoding: 'utf8',
        cwd: worktreeCwd,
        env: { ...process.env, QWEN_PROJECT_DIR: cwd },
      });
      const decision = JSON.parse(stdout);
      expect(decision.decision).toBe('deny');
    });
  });
});
