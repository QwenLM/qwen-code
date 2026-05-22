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
import { mkdtempSync, mkdirSync } from 'node:fs';
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
  });

  it('ships an executable guard.sh alongside SKILL.md', () => {
    const stat = fs.statSync(guardScript);
    expect(stat.isFile()).toBe(true);
    // 0o111 = any-execute bit; the bundled file ships as 0755 in source control.
    expect(stat.mode & 0o111).toBeGreaterThan(0);
  });

  describe('guard.sh', () => {
    let cwd: string;

    beforeAll(() => {
      cwd = mkdtempSync(path.join(tmpdir(), 'qwen-review-guard-'));
      mkdirSync(path.join(cwd, '.qwen', 'tmp'), { recursive: true });
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
      'gh pr checkout 123',
      'git checkout main',
      'git switch feature',
      'git pull origin main',
      'git reset --hard HEAD~1',
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
      'qwen review fetch-pr 123 octo/repo --out .qwen/tmp/x.json',
      'gh pr diff https://github.com/owner/repo/pull/1',
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
  });
});
