/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import type { SkillDefinition } from '@qwen-code/resource';
import {
  buildSkillPromptContent,
  activateInlineSkill,
} from './inlineSkillActivation.js';

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: 'debug',
    description: 'd',
    location: '/home/someone/.qwen/skills/debug/SKILL.md',
    skillRoot: '/home/someone/.qwen/skills/debug',
    body: 'body',
    ...overrides,
  } as SkillDefinition;
}

describe('buildSkillPromptContent', () => {
  it('prefixes filesystem-backed instructions with their resource root', () => {
    const skill = makeSkill();

    expect(buildSkillPromptContent(skill, 'body')).toBe(
      'Base directory for this skill: /home/someone/.qwen/skills/debug\n\nbody',
    );
  });

  it('does not expose a synthetic resource root for built-in skills', () => {
    const skill = makeSkill({ isBuiltin: true });

    expect(buildSkillPromptContent(skill, 'generated body')).toBe(
      'generated body',
    );
  });
});

describe('activateInlineSkill', () => {
  it('rejects a skill turned off in settings on both caller paths', async () => {
    const activateSkill = vi.fn();
    const disabledSkill = makeSkill({ name: 'simplify', disabled: true });
    const config = {
      getSkillManager: () => ({
        getSkill: () => disabledSkill,
        getDisplayableSkills: () => [],
        getModelVisibleSkills: () => [],
        activateSkill,
      }),
    } as unknown as Config;

    for (const options of [undefined, { isSlashCommand: true }]) {
      const outcome = await activateInlineSkill(
        config,
        'simplify',
        undefined,
        options,
      );

      expect(outcome.ok).toBe(false);
      const message = outcome.ok === false ? outcome.error.errorMessage : '';
      expect(message).toContain('Skill "simplify" is unavailable.');
      expect(message).not.toContain('not found');
    }
    expect(activateSkill).not.toHaveBeenCalled();
  });

  it('does not mutate activation state when Skill body expansion fails', async () => {
    const recordUsage = vi.fn(async () => {});
    const activateSkill = vi.fn();
    const clearSessionHooks = vi.fn();
    const registerSessionHook = vi.fn();
    const failingSkill = makeSkill({
      getBody: vi.fn(async () => {
        throw new Error('body expansion failed');
      }),
      hooks: {
        PreToolUse: [
          {
            hooks: [{ type: 'command', command: 'check' }],
          },
        ],
      },
    });
    const config = {
      getSkillManager: () => ({
        getSkill: () => failingSkill,
        getDisplayableSkills: () => [failingSkill],
        getModelVisibleSkills: () => [failingSkill],
        activateSkill,
        recordUsage,
      }),
      getToolRegistry: () => ({ getFunctionDeclarations: () => [] }),
      getModel: () => 'test-model',
      isWorkflowsEnabled: () => true,
      getHookSystem: () => ({ clearSessionHooks, registerSessionHook }),
    } as unknown as Config;

    await expect(
      activateInlineSkill(config, 'debug'),
    ).rejects.toThrow('body expansion failed');

    expect(recordUsage).not.toHaveBeenCalled();
    expect(clearSessionHooks).not.toHaveBeenCalled();
    expect(registerSessionHook).not.toHaveBeenCalled();
    expect(activateSkill).not.toHaveBeenCalled();
  });

  it('replaces frontmatter hooks when the same Skill is activated again', async () => {
    const registered = new Map<string, unknown[]>();
    const hookSystem = {
      clearSessionHooks: vi.fn((agentId: string) => {
        registered.delete(agentId);
      }),
      registerSessionHook: vi.fn(
        (agentId: string, hook: unknown) => {
          const hooks = registered.get(agentId) ?? [];
          hooks.push(hook);
          registered.set(agentId, hooks);
        },
      ),
    };
    const hookedSkill = makeSkill({
      hooks: {
        PreToolUse: [
          {
            hooks: [{ type: 'command', command: 'check' }],
          },
        ],
      },
    });
    const config = {
      getSkillManager: () => ({
        getSkill: () => hookedSkill,
        getDisplayableSkills: () => [hookedSkill],
        getModelVisibleSkills: () => [hookedSkill],
        activateSkill: vi.fn(),
        recordUsage: vi.fn(async () => {}),
      }),
      isWorkflowsEnabled: () => false,
      isSkillShellExecutionDisabled: () => false,
      getSessionId: () => 'session-1',
      getHookSystem: () => hookSystem,
    } as unknown as Config;

    await activateInlineSkill(config, 'debug');
    await activateInlineSkill(config, 'debug');

    expect(hookSystem.clearSessionHooks).toHaveBeenCalledTimes(2);
    expect(registered.get('skill:debug')).toHaveLength(1);
  });
});

describe('skill shell consistency during approval', () => {
  it.each([undefined, 'powershell'] as const)(
    'keeps the declared skill shell through approval: %s',
    async (shell) => {
      const { prepareSkillBody } = await import('./inlineSkillActivation.js');
      const { ShellExecutionService } = await import(
        '../services/shellExecutionService.js'
      );
      const execute = vi
        .spyOn(ShellExecutionService, 'execute')
        .mockResolvedValue({
          pid: 1,
          result: Promise.resolve({
            output: 'checked',
            exitCode: 0,
            signal: null,
            error: null,
            aborted: false,
            pid: 1,
            executionMethod: 'child_process',
          }),
        });
      try {
        const expectedShell = shell ?? 'bash';
        const permission = vi.fn(async (_command, shell) => {
          expect(shell).toBe(expectedShell);
          return true;
        });
        const config = {
          getSessionId: () => 'test',
          isSkillShellExecutionDisabled: () => false,
          getShellExecutionConfig: () => ({}),
        } as unknown as Config;
        const body = await prepareSkillBody(
          config,
          makeSkill({ body: '!`Get-Location`', shell }),
          'debug',
          '/skills/debug',
          '',
          permission,
        );
        expect(body).toContain('checked');
        expect(permission).toHaveBeenCalledWith('Get-Location', expectedShell);
        expect(execute.mock.calls[0][4]).toMatchObject({
          shellType: expectedShell,
          preventCwdChanges: true,
        });
      } finally {
        execute.mockRestore();
      }
    },
  );
});
