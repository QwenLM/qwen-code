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

import { describe, it, expect } from 'vitest';
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

describe('isSlashCommandInput (ink processor guard parity)', () => {
  it('accepts / and ? prefixes', () => {
    expect(isSlashCommandInput('/help')).toBe(true);
    expect(isSlashCommandInput('  /help args  ')).toBe(true);
    expect(isSlashCommandInput('?')).toBe(true);
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

describe('executeSlashCommand (result mapping)', () => {
  const env = { config: null };

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
    const effect = await executeSlashCommand('/help', commands, {
      config: null,
    });
    expect(effect).toEqual({ kind: 'help' });
    const viaAlias = await executeSlashCommand('/?', commands, {
      config: null,
    });
    expect(viaAlias).toEqual({ kind: 'help' });
  }, 30000);

  it('/quit produces the quit effect', async () => {
    const commands = await loadInteractiveCommands(null);
    const effect = await executeSlashCommand('/quit', commands, {
      config: null,
    });
    expect(effect.kind).toBe('quit');
  }, 30000);

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
