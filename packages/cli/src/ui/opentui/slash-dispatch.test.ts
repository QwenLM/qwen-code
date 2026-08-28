/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies OpenTUI slash-command dispatch: parsing/resolution through the
 * original shared parser, the original command registry (built-in loader),
 * and result mapping — with `/help` producing the original help output.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import type { HistoryItemWithoutId } from '../types.js';
import type { SlashCommand } from '../commands/types.js';
import { CommandKind } from '../commands/types.js';
import {
  executeSlashCommand,
  isSlashCommandInput,
  loadInteractiveCommands,
  resolveSlashCommand,
} from './slash-dispatch.js';
import { HELP_DOCS_URL, formatHelpText } from './help-content.js';

function stub(
  overrides: Partial<SlashCommand> & { name: string },
): SlashCommand {
  return {
    description: `stub ${overrides.name}`,
    kind: CommandKind.BUILT_IN,
    ...overrides,
  };
}

const registry: SlashCommand[] = [
  stub({ name: 'help', altNames: ['?'] }),
  stub({
    name: 'greet',
    action: () => ({
      type: 'message',
      messageType: 'info',
      content: 'hello from greet',
    }),
  }),
  stub({
    name: 'boom',
    action: () => {
      throw new Error('kaboom');
    },
  }),
  stub({
    name: 'ask',
    action: () => ({
      type: 'submit_prompt',
      content: [{ text: 'part one ' }, { text: 'part two' }],
    }),
  }),
  stub({
    name: 'memory',
    description: 'parent',
    subCommands: [
      stub({ name: 'add', description: 'add memory' }),
      stub({ name: 'show', description: 'show memory' }),
    ],
  }),
  stub({
    name: 'theme',
    action: () => ({ type: 'dialog', dialog: 'theme' }),
  }),
  stub({ name: 'hidden', hidden: true }),
];

describe('isSlashCommandInput (ink submission gate parity)', () => {
  it('accepts /-prefixed input', () => {
    expect(isSlashCommandInput('/help')).toBe(true);
    expect(isSlashCommandInput('  /help args  ')).toBe(true);
  });

  it('rejects ?-prefixed input — ink routes it to the model/btw path', () => {
    expect(isSlashCommandInput('?')).toBe(false);
    expect(isSlashCommandInput('?btw side question')).toBe(false);
    expect(isSlashCommandInput('?stats')).toBe(false);
  });

  it('rejects plain prompts and path-like input', () => {
    expect(isSlashCommandInput('hello world')).toBe(false);
    expect(isSlashCommandInput('/usr/bin/ls')).toBe(false);
    expect(isSlashCommandInput('')).toBe(false);
  });
});

describe('resolveSlashCommand (original parseSlashCommand)', () => {
  it('resolves by primary name with args', () => {
    const resolution = resolveSlashCommand('/greet  world ', registry);
    expect(resolution.type).toBe('command');
    if (resolution.type !== 'command') return;
    expect(resolution.command.name).toBe('greet');
    expect(resolution.args).toBe('world');
    expect(resolution.canonicalPath).toEqual(['greet']);
  });

  it('resolves aliases like ? → help', () => {
    const resolution = resolveSlashCommand('/?', registry);
    expect(resolution.type).toBe('command');
    if (resolution.type !== 'command') return;
    expect(resolution.command.name).toBe('help');
  });

  it('resolves subcommand paths and reports unknown commands', () => {
    const resolution = resolveSlashCommand('/memory add something', registry);
    expect(resolution.type).toBe('command');
    if (resolution.type !== 'command') return;
    expect(resolution.canonicalPath).toEqual(['memory', 'add']);
    expect(resolution.args).toBe('something');

    expect(resolveSlashCommand('/nope', registry)).toEqual({
      type: 'unknown',
      input: '/nope',
    });
  });
});

function makeEnv(
  extra: Partial<Parameters<typeof executeSlashCommand>[2]> = {},
): Parameters<typeof executeSlashCommand>[2] {
  return {
    config: null,
    settings: { merged: {} } as never,
    ...extra,
  };
}

describe('executeSlashCommand (result mapping)', () => {
  const env = makeEnv();

  it('unknown command → same error as the ink TUI', async () => {
    const effect = await executeSlashCommand('/nope', registry, env);
    expect(effect).toEqual({
      kind: 'message',
      messageType: 'error',
      content: 'Unknown command: /nope',
    });
  });

  it('message results carry type and content', async () => {
    const effect = await executeSlashCommand('/greet', registry, env);
    expect(effect).toEqual({
      kind: 'message',
      messageType: 'info',
      content: 'hello from greet',
    });
  });

  it('dialog results map to dialog effects (non-help)', async () => {
    const effect = await executeSlashCommand('/theme', registry, env);
    expect(effect).toEqual({
      kind: 'dialog',
      dialog: 'theme',
      command: 'theme',
    });
  });

  it('dialog results carry the OpenDialogActionReturn payload (R2-42)', async () => {
    const commands = [
      stub({
        name: 'resume',
        action: () => ({
          type: 'dialog' as const,
          dialog: 'resume' as const,
          sessionId: 'session-abc-123',
        }),
      }),
    ];
    const effect = await executeSlashCommand(
      '/resume session-abc-123',
      commands,
      env,
    );
    expect(effect).toEqual({
      kind: 'dialog',
      dialog: 'resume',
      command: 'resume',
      sessionId: 'session-abc-123',
    });
  });

  it('submit_prompt results stringify content', async () => {
    const effect = await executeSlashCommand('/ask', registry, env);
    expect(effect).toEqual({
      kind: 'submit',
      content: 'part one part two',
    });
  });

  it('parent commands without an action list their subcommands', async () => {
    const effect = await executeSlashCommand('/memory', registry, env);
    expect(effect.kind).toBe('message');
    if (effect.kind !== 'message') return;
    expect(effect.messageType).toBe('info');
    expect(effect.content).toContain("'/memory' requires a subcommand");
    expect(effect.content).toContain('- add:');
    expect(effect.content).toContain('- show:');
  });

  it('thrown actions become error messages', async () => {
    const effect = await executeSlashCommand('/boom', registry, env);
    expect(effect).toEqual({
      kind: 'message',
      messageType: 'error',
      content: "Command '/boom' failed: kaboom",
    });
  });
});

describe('executeSlashCommand ink-processor guards (R1-96/100/101/102)', () => {
  it('does not treat comment-style input as slash commands', () => {
    expect(isSlashCommandInput('/* This is a block comment */')).toBe(false);
    expect(isSlashCommandInput('// line note')).toBe(false);
  });

  it('maps ui.clear() to the clear effect', async () => {
    const commands = [
      stub({
        name: 'wipe',
        action: (ctx) => {
          ctx.ui.clear();
        },
      }),
    ];
    const effect = await executeSlashCommand('/wipe', commands, makeEnv());
    expect(effect).toEqual({ kind: 'clear' });
  });

  it('drops the action result once the submission is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const effect = await executeSlashCommand(
      '/ask',
      registry,
      makeEnv({ abortSignal: controller.signal }),
    );
    expect(effect).toEqual({ kind: 'handled' });
  });

  it('races non-cooperative actions against the abort signal (R1-18)', async () => {
    const controller = new AbortController();
    const commands = [
      stub({
        name: 'stuck',
        action: () =>
          new Promise(() => {
            /* never settles on its own, like /compress mid-operation */
          }),
      }),
    ];
    const pending = executeSlashCommand(
      '/stuck',
      commands,
      makeEnv({ abortSignal: controller.signal }),
    );
    controller.abort();
    await expect(pending).resolves.toEqual({ kind: 'handled' });
  });

  it('defers stacked skill invocations instead of leaking the second skill', async () => {
    const skills = [
      stub({ name: 'feat-dev', kind: CommandKind.SKILL }),
      stub({ name: 'e2e-testing', kind: CommandKind.SKILL }),
    ];
    const effect = await executeSlashCommand(
      '/feat-dev /e2e-testing do it',
      skills,
      makeEnv(),
    );
    expect(effect.kind).toBe('message');
    if (effect.kind !== 'message') return;
    expect(effect.content).toContain('Stacked skill invocations');
    expect(effect.content).toContain('/feat-dev /e2e-testing');
  });

  it('projects ui.addItem history items to transcript text', async () => {
    const commands = [
      stub({
        name: 'showstats',
        action: (ctx) => {
          ctx.ui.addItem({ type: 'stats', duration: '9m' }, Date.now());
        },
      }),
    ];
    const effect = await executeSlashCommand('/showstats', commands, makeEnv());
    expect(effect.kind).toBe('message');
    if (effect.kind !== 'message') return;
    expect(effect.messageType).toBe('info');
    expect(effect.content).toContain('Session Stats');
    expect(effect.content).toContain('Session duration: 9m');
  });

  it('surfaces added-item text alongside non-handled effects (R1-102)', async () => {
    const commands = [
      stub({
        name: 'init',
        action: (ctx) => {
          ctx.ui.addItem(
            { type: 'info', text: 'Empty QWEN.md created.' },
            Date.now(),
          );
          return {
            type: 'submit_prompt' as const,
            content: 'analyze the project',
          };
        },
      }),
    ];
    const effect = await executeSlashCommand('/init', commands, makeEnv());
    expect(effect).toEqual({
      kind: 'submit',
      content: 'analyze the project',
      notice: 'Empty QWEN.md created.',
    });
  });

  it('projects message items instead of the generic deferral (R2-5)', async () => {
    const commands = [
      stub({
        name: 'extensions',
        action: (ctx) => {
          ctx.ui.addItem(
            { type: 'error', text: 'Unknown extensions source: bogus.' },
            Date.now(),
          );
        },
      }),
    ];
    const effect = await executeSlashCommand(
      '/extensions explore bogus',
      commands,
      makeEnv(),
    );
    expect(effect.kind).toBe('message');
    if (effect.kind !== 'message') return;
    expect(effect.content).toBe('Unknown extensions source: bogus.');
    expect(effect.content).not.toContain('not yet available');
  });

  it('exposes env.history through the command context (R2-6)', async () => {
    let observed: HistoryItemWithoutId[] | undefined;
    const commands = [
      stub({
        name: 'scan',
        action: (ctx) => {
          observed = ctx.ui.history;
        },
      }),
    ];
    await executeSlashCommand(
      '/scan',
      commands,
      makeEnv({
        history: [{ type: 'error', text: 'boom' } as HistoryItemWithoutId],
      }),
    );
    expect(observed).toHaveLength(1);
    expect((observed?.[0] as { text?: string })?.text).toBe('boom');
  });
});

describe('original built-in registry', () => {
  it('loads built-in commands without a config (BuiltinCommandLoader)', async () => {
    const commands = await loadInteractiveCommands(null);
    const names = commands.map((cmd) => cmd.name);
    expect(names).toContain('help');
    expect(names).toContain('quit');
    expect(names).toContain('clear');
    expect(names).toContain('stats');
    // every interactive command is user-invocable and visible
    for (const cmd of commands) {
      expect(cmd.hidden).toBeFalsy();
      expect(cmd.userInvocable).not.toBe(false);
    }
  }, 30000);

  it('/help dispatches to the help dialog effect', async () => {
    const commands = await loadInteractiveCommands(null);
    const effect = await executeSlashCommand('/help', commands, makeEnv());
    expect(effect).toEqual({ kind: 'help' });
    const viaAlias = await executeSlashCommand('/?', commands, makeEnv());
    expect(viaAlias).toEqual({ kind: 'help' });
  }, 30000);

  it('/quit produces the quit effect', async () => {
    const commands = await loadInteractiveCommands(null);
    const effect = await executeSlashCommand('/quit', commands, makeEnv());
    expect(effect.kind).toBe('quit');
  }, 30000);

  it('/quit carries the quitting messages on the effect (ytahdn-1)', async () => {
    // ink renders QuitActionReturn.messages via QuittingDisplay (the /quit
    // echo + session-duration summary); the effect must carry the projected
    // text or the output is permanently lost under the new renderer.
    const commands = [
      stub({
        name: 'quit',
        action: () => ({
          type: 'quit' as const,
          messages: [
            { type: 'user', text: '/quit' },
            { type: 'quit', duration: '2m' },
          ] as never,
        }),
      }),
    ];
    const effect = await executeSlashCommand('/quit', commands, makeEnv());
    expect(effect.kind).toBe('quit');
    // The quit item projects to the ink QuittingDisplay summary; the user
    // echo item ({type:'user', text:'/quit'}) has no special-item projection
    // and the backend's own input echo covers it, exactly like the ink TUI.
    expect((effect as { notice?: string }).notice).toContain(
      'Agent powering down. Goodbye!',
    );
    expect((effect as { notice?: string }).notice).toContain('2m');
  });

  it('help output matches the original dialog content', async () => {
    const commands = await loadInteractiveCommands(null);
    const text = formatHelpText(commands);
    expect(text).toContain('Qwen Code');
    expect(text).toContain('Shortcuts');
    expect(text).toContain('↑/↓');
    expect(text).toContain('Browse built-in commands:');
    expect(text).toContain('Built-in Commands');
    expect(text).toContain('/help');
    expect(text).toContain('/quit');
    expect(text).toContain(HELP_DOCS_URL);
  }, 30000);
});

describe('model-invocable commands registration (ink loader-effect parity)', () => {
  type InvocableProvider = () => ReadonlyArray<{
    name: string;
    description: string;
  }>;
  type InvocableExecutor = (
    name: string,
    args?: string,
  ) => Promise<string | { error: string } | null>;

  // Minimal config stub: registration methods are captured while every
  // dynamic loader (skills, file commands, MCP prompts) stays on its empty
  // path, so the provider lists nothing but stays well-formed.
  function createConfigStub(
    onProvider?: (provider: InvocableProvider) => void,
    onExecutor?: (executor: InvocableExecutor) => void,
  ): Config {
    return {
      initialize: async () => {},
      getDisabledSlashCommands: () => [],
      setModelInvocableCommandsProvider: (provider: InvocableProvider) =>
        onProvider?.(provider),
      setModelInvocableCommandsExecutor: (executor: InvocableExecutor) =>
        onExecutor?.(executor),
      getBareMode: () => true,
      isWorkflowsEnabled: () => false,
      isManagedMemoryAvailable: () => false,
      getFolderTrust: () => false,
      getFolderTrustFeature: () => false,
      getFileCheckpointingEnabled: () => false,
      isLspEnabled: () => false,
      isCronEnabled: () => false,
      getMcpServers: () => ({}),
      getSkillManager: () => undefined,
      getDisabledSkillNames: () => new Set<string>(),
      getPermissionManager: () => undefined,
      getModel: () => undefined,
      getCliVersion: () => undefined,
      getProjectRoot: () => '/nonexistent-opentui-test-root',
    } as unknown as Config;
  }

  it('registers the provider and executor on the config', async () => {
    const providerSpy = vi.fn();
    const executorSpy = vi.fn();
    const config = createConfigStub(providerSpy, executorSpy);
    await loadInteractiveCommands(config);
    expect(providerSpy).toHaveBeenCalledTimes(1);
    expect(executorSpy).toHaveBeenCalledTimes(1);
  }, 30000);

  it('provider() returns a {name, description} listing', async () => {
    let provider: InvocableProvider | undefined;
    await loadInteractiveCommands(
      createConfigStub((p) => {
        provider = p;
      }),
    );
    expect(provider).toBeTypeOf('function');
    if (!provider) return;
    // Built-ins are forced modelInvocable:false and the stub keeps every
    // dynamic loader empty, so the listing is empty but well-formed.
    expect(provider()).toEqual([]);
  }, 30000);

  it('executor() returns null for names the model cannot invoke', async () => {
    let executor: InvocableExecutor | undefined;
    await loadInteractiveCommands(
      createConfigStub(undefined, (e) => {
        executor = e;
      }),
    );
    expect(executor).toBeTypeOf('function');
    if (!executor) return;
    // built-ins are never model-invocable, and unknown names miss entirely
    await expect(executor('help')).resolves.toBeNull();
    await expect(executor('definitely-not-a-command')).resolves.toBeNull();
  }, 30000);
});
