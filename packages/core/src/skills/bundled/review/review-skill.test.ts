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
import { describe, expect, it, beforeAll } from 'vitest';
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

    function runGuard(input: object): { stdout: string; exitCode: number } {
      try {
        const stdout = execFileSync('bash', [guardScript], {
          input: JSON.stringify(input),
          encoding: 'utf8',
          cwd,
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
      'qwen review fetch-pr 123 octo/repo --out .qwen/tmp/x.json',
      'gh pr diff https://github.com/owner/repo/pull/1',
      'cd /tmp && ls',
      'ls -la',
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
        });
        const decision = JSON.parse(stdout);
        expect(decision.decision).toBe('allow');
      } finally {
        fs.rmSync(otherCwd, { recursive: true, force: true });
      }
    });
  });
});
