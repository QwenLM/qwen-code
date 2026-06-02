import { describe, expect, it } from 'vitest';
import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import type { CommandInfo } from '../adapters/types';
import {
  getSlashCommandArgumentHint,
  slashCompletionSource,
} from './slashCompletion';

describe('getSlashCommandArgumentHint', () => {
  it('returns a command argument hint for a bare slash command', () => {
    const commands: CommandInfo[] = [
      {
        name: 'stats',
        description: 'Show usage stats',
        argumentHint: '[model|tools]',
      },
    ];

    expect(getSlashCommandArgumentHint('/stats', commands, 'en')).toBe(
      '[model|tools]',
    );
    expect(getSlashCommandArgumentHint('/stats ', commands, 'en')).toBe(
      '[model|tools]',
    );
  });

  it('falls back to implicit subcommands when no argument hint is provided', () => {
    const commands: CommandInfo[] = [
      {
        name: 'context',
        description: 'Show context usage',
      },
    ];

    expect(getSlashCommandArgumentHint('/context', commands, 'en')).toBe(
      '[detail]',
    );
  });

  it('does not return a hint once arguments are being typed', () => {
    const commands: CommandInfo[] = [
      {
        name: 'stats',
        description: 'Show usage stats',
        argumentHint: '[model|tools]',
      },
    ];

    expect(getSlashCommandArgumentHint('/stats m', commands, 'en')).toBeNull();
  });
});

describe('slashCompletionSource', () => {
  it('completes a top-level slash command from any cursor position in the command', () => {
    const commands: CommandInfo[] = [
      { name: 'context', description: 'Show context usage' },
      { name: 'clear', description: 'Clear the screen' },
    ];
    const source = slashCompletionSource(() => commands);

    for (const pos of [0, 2, 4]) {
      const state = EditorState.create({ doc: '/con' });
      const result = source(new CompletionContext(state, pos, true));

      expect(result?.from).toBe(0);
      expect(result?.to).toBe(4);
      expect(result?.options.map((option) => option.label)).toEqual([
        '/context',
      ]);
    }
  });

  it('completes implicit /mcp subcommands', () => {
    const commands: CommandInfo[] = [
      {
        name: 'mcp',
        description: 'Manage MCP servers',
        argumentHint: 'desc|nodesc|schema|auth|noauth',
      },
    ];
    const source = slashCompletionSource(() => commands);
    const state = EditorState.create({ doc: '/mcp d' });
    const result = source(new CompletionContext(state, 6, true));

    expect(result?.options.map((option) => option.label)).toEqual([
      'desc',
      'nodesc',
    ]);
    expect(result?.options[0]?.apply).toBe('/mcp desc ');
  });

  it('does not expose third-level /agents create completions', () => {
    const commands: CommandInfo[] = [
      {
        name: 'agents',
        description: 'Manage subagents',
        argumentHint: 'manage|create',
      },
    ];
    const source = slashCompletionSource(() => commands);
    const state = EditorState.create({ doc: '/agents create ' });
    const result = source(new CompletionContext(state, 15, true));

    expect(result).toBeNull();
  });
});
