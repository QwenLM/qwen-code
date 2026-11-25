/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import type { SkillDefinition } from '@qwen-code/resource';
import type { Message } from '../protocol/transcript/message.js';
import { createUserMessage } from '../protocol/transcript/conversions.js';
import { createAttachmentMessage } from '../attachments/factory.js';
import { createSkillAttachmentIfNeeded } from '../attachments/generators/compact-generators.js';
import {
  buildSkillPromptContent,
  activateInlineSkill,
  type InlineSkillActivationOptions,
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
    const messages: Message[] = [];
    let renderedBody: string | undefined;
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
        getRenderedBody: () => renderedBody,
        activateSkill: (_name: string, body: string) => {
          renderedBody = body;
        },
        recordUsage: vi.fn(async () => {}),
      }),
      getConversationMessages: () => messages,
      isWorkflowsEnabled: () => false,
      isSkillShellExecutionDisabled: () => false,
      getSessionId: () => 'session-1',
      getHookSystem: () => hookSystem,
    } as unknown as Config;

    const first = await activateInlineSkill(config, 'debug');
    if (!first.ok) throw new Error(first.error.errorMessage);
    messages.push(createUserMessage(first.result.skillBodyContent, { isMeta: true }));
    const repeated = await activateInlineSkill(config, 'debug');
    expect(repeated.ok && repeated.result.skillBodyContent).toContain('instructions unchanged');

    expect(hookSystem.clearSessionHooks).toHaveBeenCalledTimes(2);
    expect(registered.get('skill:debug')).toHaveLength(1);
  });
});

describe('inline Skill re-invocation', () => {
  function setup(skill = makeSkill()) {
    const messages: Message[] = [];
    const renderedBodies = new Map<string, string>();
    const activateSkill = vi.fn(
      (_name: string, body: string, agentId: string) => {
        renderedBodies.set(agentId, body);
      },
    );
    const recordUsage = vi.fn(async () => {});
    const config = {
      getSkillManager: () => ({
        getSkill: () => skill,
        getRenderedBody: (_name: string, agentId: string) =>
          renderedBodies.get(agentId),
        activateSkill,
        recordUsage,
      }),
      getConversationMessages: () => messages,
      isWorkflowsEnabled: () => false,
      isSkillShellExecutionDisabled: () => false,
      getSessionId: () => 'session-1',
      getToolRegistry: () => ({ getFunctionDeclarations: () => [] }),
      getModel: () => 'test-model',
    } as unknown as Config;
    const invoke = async (
      args?: string,
      options?: InlineSkillActivationOptions,
    ) => {
      const outcome = await activateInlineSkill(config, skill.name, args, options);
      if (!outcome.ok) throw new Error(outcome.error.errorMessage);
      return outcome.result;
    };
    return { skill, messages, activateSkill, recordUsage, invoke };
  }

  it('reports the actual net saving including reminder arguments and Unicode', async () => {
    const { messages, invoke } = setup(
      makeSkill({ body: 'Instructions 🚀 '.repeat(40) }),
    );
    const first = await invoke('new invocation arguments');
    expect(first.dedupTelemetry).toEqual({
      skill_body_dedup_hit: false,
      skill_body_dedup_saved_chars: 0,
    });
    messages.push(createUserMessage(first.skillBodyContent, { isMeta: true }));
    const repeated = await invoke('new invocation arguments');
    expect(repeated.skillBodyContent).toContain('Arguments: new invocation arguments');
    expect(repeated.dedupTelemetry).toEqual({
      skill_body_dedup_hit: true,
      skill_body_dedup_saved_chars:
        Array.from(first.skillBodyContent).length -
        Array.from(repeated.skillBodyContent).length,
    });
  });

  it.each([false, true])(
    'elides an unchanged body while preserving activation and full recovery content (slash=%s)',
    async (isSlashCommand) => {
      const { messages, activateSkill, recordUsage, invoke } = setup();
      const options = { isSlashCommand };
      const first = await invoke(undefined, options);
      messages.push(createUserMessage(first.skillBodyContent, { isMeta: true }));

      const repeated = await invoke(undefined, options);
      expect(repeated.skillBodyContent).toContain('instructions unchanged');
      expect(repeated.skillBodyContent).not.toContain(first.skillBodyContent);
      expect(repeated.userMessageContent).toBe(
        `${repeated.metadataContent}\n\n${repeated.skillBodyContent}`,
      );
      expect(repeated.isMeta).toBe(true);
      expect(repeated.returnDisplay).toBe(first.returnDisplay);
      expect(repeated.llmContent).toBe(first.llmContent);
      expect(recordUsage).toHaveBeenCalledTimes(2);
      expect(activateSkill).toHaveBeenNthCalledWith(2, 'debug', first.skillBodyContent, 'main');
    },
  );

  it('recognizes instructions stored as text blocks', async () => {
    const { messages, invoke } = setup();
    const first = await invoke();
    messages.push(createUserMessage(
      [{ type: 'text', text: first.skillBodyContent }],
      { isMeta: true },
    ));

    expect((await invoke()).skillBodyContent).toContain('instructions unchanged');
  });

  it('requires the complete body even if the Skill was activated or a reminder remains', async () => {
    const { messages, invoke } = setup();
    const first = await invoke();
    expect((await invoke()).skillBodyContent).toBe(first.skillBodyContent);
    messages.push(createUserMessage(first.skillBodyContent, { isMeta: true }));
    const repeated = await invoke();
    messages.push(createUserMessage(repeated.skillBodyContent, { isMeta: true }));
    expect((await invoke()).skillBodyContent).toBe(repeated.skillBodyContent);

    // Simulate compaction or rewind discarding the full copy but retaining a reminder.
    messages.shift();
    expect((await invoke()).skillBodyContent).toBe(first.skillBodyContent);
  });

  it.each(['body', 'skillRoot', 'arguments'] as const)(
    'injects full instructions after %s changes',
    async (changed) => {
      const { skill, messages, invoke } = setup(makeSkill({ body: 'Review $ARGUMENTS' }));
      const first = await invoke('before');
      messages.push(createUserMessage(first.skillBodyContent, { isMeta: true }));
      if (changed === 'body') skill.body += '\n';
      if (changed === 'skillRoot') skill.skillRoot = '/different/resource/root';

      const next = await invoke(changed === 'arguments' ? 'after' : 'before');
      expect(next.skillBodyContent).not.toBe(first.skillBodyContent);
      expect(next.skillBodyContent).toContain('Base directory for this skill:');
      expect(next.skillBodyContent).not.toContain('instructions unchanged');
    },
  );

  it('reruns dynamic expansion and carries new arguments when its output stays identical', async () => {
    const getBody = vi.fn(async () => 'generated instructions');
    const { messages, invoke, activateSkill } = setup(makeSkill({ getBody }));
    const first = await invoke('before');
    messages.push(createUserMessage(first.skillBodyContent, { isMeta: true }));

    const repeated = await invoke('after');
    expect(repeated.skillBodyContent).toContain('instructions unchanged');
    expect(repeated.skillBodyContent).toContain('Arguments: after');
    expect(getBody).toHaveBeenNthCalledWith(2, 'after', expect.any(Object));

    getBody.mockResolvedValue('updated instructions');
    const changed = await invoke('after');
    expect(changed.skillBodyContent).toContain('updated instructions');
    expect(changed.skillBodyContent).not.toContain('instructions unchanged');
    expect(activateSkill).toHaveBeenLastCalledWith('debug', changed.skillBodyContent, 'main');
  });

  it('injects a changed version even when an older identical copy remains', async () => {
    const { skill, messages, invoke } = setup();
    const first = await invoke();
    messages.push(createUserMessage(first.skillBodyContent, { isMeta: true }));
    skill.body = 'updated instructions';
    const changed = await invoke();
    messages.push(createUserMessage(changed.skillBodyContent, { isMeta: true }));
    skill.body = 'body';

    expect((await invoke()).skillBodyContent).toBe(first.skillBodyContent);
  });

  it.each([false, true])(
    'reuses only complete compact recovery content (truncated=%s)',
    async (truncated) => {
      const { skill, messages, invoke } = setup(makeSkill({
        body: truncated ? 'instructions\n'.repeat(2500) : 'instructions',
      }));
      const first = await invoke();
      const attachment = createSkillAttachmentIfNeeded([{
        name: skill.name,
        path: skill.location,
        content: first.skillBodyContent,
        invokedAt: 1,
      }])!;
      messages.push(createAttachmentMessage(attachment));

      const repeated = await invoke();
      if (truncated) {
        expect(attachment.skills[0].content).toContain('truncated during compaction');
        expect(repeated.skillBodyContent).toBe(first.skillBodyContent);
      } else {
        expect(repeated.skillBodyContent).toContain('invoked-skills reminder');
        expect(repeated.skillBodyContent).toContain('this is a new invocation');
        expect(repeated.skillBodyContent).toContain('including any setup steps');
        expect(repeated.skillBodyContent).not.toContain(first.skillBodyContent);
        messages.unshift(
          createUserMessage(first.skillBodyContent, { isMeta: true }),
        );
        expect((await invoke()).skillBodyContent).toContain(
          'instructions unchanged',
        );
      }
    },
  );

  it.each(['ordinary input', 'tool result', 'virtual', 'summary'])(
    'does not mistake %s for loaded instructions',
    async (kind) => {
      const { messages, invoke } = setup();
      const first = await invoke();
      messages.push(createUserMessage(
        kind === 'tool result'
          ? [{ type: 'tool_result', tool_use_id: 'read', content: first.skillBodyContent }]
          : first.skillBodyContent,
        {
          isMeta: kind !== 'ordinary input',
          isVirtual: kind === 'virtual',
          isCompactSummary: kind === 'summary',
        },
      ));

      expect((await invoke()).skillBodyContent).toBe(first.skillBodyContent);
    },
  );

  it('uses the executing agent history instead of the shared main-session history', async () => {
    const { messages, invoke } = setup();
    const first = await invoke();
    const loaded = createUserMessage(first.skillBodyContent, { isMeta: true });
    messages.push(loaded);
    const childMessages: Message[] = [];
    const context = {
      agentId: 'child',
      getConversationMessages: () => childMessages,
    };

    expect((await invoke(undefined, { context })).skillBodyContent).toBe(first.skillBodyContent);

    messages.length = 0;
    childMessages.push(loaded);
    expect((await invoke(undefined, { context })).skillBodyContent).toContain('instructions unchanged');
  });

  it('keeps each agent’s last rendering isolated from inherited history', async () => {
    const { messages, invoke } = setup();
    const main = await invoke('main');
    const loaded = createUserMessage(main.skillBodyContent, { isMeta: true });
    messages.push(loaded);
    const childMessages = [loaded];
    const context = {
      agentId: 'child',
      getConversationMessages: () => childMessages,
    };

    const inherited = await invoke('main', { context });
    expect(inherited.skillBodyContent).toBe(main.skillBodyContent);

    const child = await invoke('child', { context });
    expect(child.skillBodyContent).toContain('ARGUMENTS: child');
    childMessages.push(createUserMessage(child.skillBodyContent, { isMeta: true }));

    expect((await invoke('main')).skillBodyContent).toContain('instructions unchanged');
    expect((await invoke('child', { context })).skillBodyContent).toContain('instructions unchanged');
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
