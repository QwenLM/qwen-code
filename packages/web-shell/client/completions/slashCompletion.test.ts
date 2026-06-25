import { describe, expect, it } from 'vitest';
import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import type { CommandInfo } from '../adapters/types';
import { getTranslator } from '../i18n';
import {
  getSlashCommandCompletionResult,
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

  it('returns argument hints for Chinese command names', () => {
    const commands: CommandInfo[] = [
      {
        name: '学生信息',
        description: '收集学生信息',
        argumentHint: '<姓名>',
      },
    ];

    expect(getSlashCommandArgumentHint('/学生信息', commands, 'zh-CN')).toBe(
      '<姓名>',
    );
  });
});

describe('getSlashCommandCompletionResult', () => {
  it('returns top-level command items for the custom slash panel', () => {
    const commands: CommandInfo[] = [
      {
        name: 'clear',
        description: 'Clear the screen',
        source: 'builtin-command',
      },
      {
        name: 'demo:ping',
        description: 'Project command',
        source: 'skill-dir-command',
      },
    ];

    const result = getSlashCommandCompletionResult(
      '/',
      1,
      commands,
      [],
      'en',
      getTranslator('en'),
    );

    expect(result?.kind).toBe('command');
    expect(result?.from).toBe(0);
    expect(result?.to).toBe(1);
    expect(result?.items.map((item) => item.label)).toEqual([
      '/demo:ping',
      '/clear',
    ]);
    expect(result?.items.map((item) => item.section)).toEqual([
      'Custom commands',
      'System commands',
    ]);
  });

  it('returns explicit subcommands after accepting a parent command', () => {
    const commands: CommandInfo[] = [
      {
        name: 'agents',
        description: 'Manage agents',
        argumentHint: 'manage|create',
      },
    ];

    const result = getSlashCommandCompletionResult(
      '/agents ',
      8,
      commands,
      [],
      'en',
      getTranslator('en'),
    );

    expect(result?.kind).toBe('subcommand');
    expect(result?.from).toBe(0);
    expect(result?.to).toBe(8);
    expect(result?.items.map((item) => item.apply)).toEqual([
      '/agents manage ',
      '/agents create ',
    ]);
  });

  it('returns command-provided subcommands when no built-in tree exists', () => {
    const commands: CommandInfo[] = [
      {
        name: 'custom',
        description: 'Custom command',
        subcommands: ['one', 'two'],
      },
    ];

    const result = getSlashCommandCompletionResult(
      '/custom t',
      9,
      commands,
      [],
      'en',
      getTranslator('en'),
    );

    expect(result?.items.map((item) => item.label)).toEqual(['two']);
    expect(result?.items[0]?.apply).toBe('/custom two ');
  });

  it('returns dynamic skills for /skills', () => {
    const commands: CommandInfo[] = [
      { name: 'skills', description: 'Run a skill' },
    ];

    const result = getSlashCommandCompletionResult(
      '/skills re',
      10,
      commands,
      [{ name: 'review', description: 'Review current code' }],
      'en',
      getTranslator('en'),
    );

    expect(result?.items).toEqual([
      {
        id: '/skills review',
        label: 'review',
        detail: 'Review current code',
        apply: '/skills review ',
        type: 'skill',
      },
    ]);
  });

  it('honors panel category order and filtered commands', () => {
    const commands: CommandInfo[] = [
      {
        name: 'clear',
        description: 'Clear the screen',
        source: 'builtin-command',
      },
      {
        name: 'hidden',
        description: 'Hidden command',
        source: 'skill-dir-command',
      },
      {
        name: 'demo:ping',
        description: 'Project command',
        source: 'skill-dir-command',
      },
    ].filter((command) => command.name !== 'hidden');

    const result = getSlashCommandCompletionResult(
      '/',
      1,
      commands,
      [],
      'en',
      getTranslator('en'),
      ['system', 'custom', 'skill'],
    );

    expect(result?.items.map((item) => item.label)).toEqual([
      '/clear',
      '/demo:ping',
    ]);
  });
});

describe('slashCompletionSource', () => {
  it('completes a top-level slash command from any cursor position in the command', () => {
    const commands: CommandInfo[] = [
      { name: 'context', description: 'Show context usage' },
      { name: 'clear', description: 'Clear the screen' },
    ];
    const source = slashCompletionSource(
      () => commands,
      () => [],
      () => 'en',
      getTranslator('en'),
    );

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

  it('shows custom slash commands before built-in commands', () => {
    const commands: CommandInfo[] = [
      {
        name: 'clear',
        description: 'Clear the screen',
        source: 'builtin-command',
      },
      {
        name: 'demo:ping',
        description: 'Project command',
        source: 'skill-dir-command',
      },
      {
        name: 'context',
        description: 'Show context usage',
        source: 'builtin-command',
      },
    ];
    const source = slashCompletionSource(
      () => commands,
      () => [],
      () => 'en',
      getTranslator('en'),
    );
    const state = EditorState.create({ doc: '/' });
    const result = source(new CompletionContext(state, 1, true));

    expect(result?.options.map((option) => option.label)).toEqual([
      '/demo:ping',
      '/clear',
      '/context',
    ]);
  });

  it('keeps custom commands first when filtering slash commands', () => {
    const commands: CommandInfo[] = [
      {
        name: 'model',
        description: 'Switch model',
        source: 'builtin-command',
      },
      {
        name: 'memory',
        description: 'Manage memory',
        source: 'builtin-command',
      },
      {
        name: 'my-command',
        description: 'Project command',
        source: 'skill-dir-command',
      },
    ];
    const source = slashCompletionSource(() => commands);
    const state = EditorState.create({ doc: '/m' });
    const result = source(new CompletionContext(state, 2, true));

    expect(result?.options.map((option) => option.label)).toEqual([
      '/my-command',
      '/memory',
      '/model',
    ]);
  });

  it('orders slash commands by custom, skill, then system categories', () => {
    const commands: CommandInfo[] = [
      {
        name: 'clear',
        description: 'Clear the screen',
        source: 'builtin-command',
      },
      {
        name: 'batch',
        description: 'Execute batch operations',
        displayCategory: 'skill',
      },
      {
        name: 'demo:ping',
        description: 'Project command',
        source: 'skill-dir-command',
      },
    ];
    const source = slashCompletionSource(
      () => commands,
      () => [],
      () => 'en',
      getTranslator('en'),
    );
    const state = EditorState.create({ doc: '/' });
    const result = source(new CompletionContext(state, 1, true));

    expect(result?.options.map((option) => option.label)).toEqual([
      '/demo:ping',
      '/batch',
      '/clear',
    ]);
    expect(
      result?.options.map((option) => {
        const section =
          typeof option.section === 'string' ? undefined : option.section;
        return section ? { name: section.name, rank: section.rank } : undefined;
      }),
    ).toEqual([
      { name: 'Custom commands', rank: 0 },
      { name: 'Skill commands', rank: 1 },
      { name: 'System commands', rank: 2 },
    ]);
  });

  it('localizes slash command category section titles', () => {
    const commands: CommandInfo[] = [
      {
        name: 'clear',
        description: 'Clear the screen',
        source: 'builtin-command',
      },
      {
        name: 'batch',
        description: 'Execute batch operations',
        displayCategory: 'skill',
      },
      {
        name: 'demo:ping',
        description: 'Project command',
        source: 'skill-dir-command',
      },
    ];
    const source = slashCompletionSource(
      () => commands,
      () => [],
      () => 'zh-CN',
      getTranslator('zh-CN'),
    );
    const state = EditorState.create({ doc: '/' });
    const result = source(new CompletionContext(state, 1, true));

    expect(
      result?.options.map((option) => {
        const section =
          typeof option.section === 'string' ? undefined : option.section;
        return section?.name;
      }),
    ).toEqual(['自定义', 'Skill', '系统']);
  });

  it('only includes sections for categories with matching commands', () => {
    const commands: CommandInfo[] = [
      {
        name: 'clear',
        description: 'Clear the screen',
        source: 'builtin-command',
      },
      {
        name: 'batch',
        description: 'Execute batch operations',
        displayCategory: 'skill',
      },
      {
        name: 'demo:ping',
        description: 'Project command',
        source: 'skill-dir-command',
      },
    ];
    const source = slashCompletionSource(
      () => commands,
      () => [],
      () => 'en',
      getTranslator('en'),
    );
    const state = EditorState.create({ doc: '/cle' });
    const result = source(new CompletionContext(state, 4, true));

    expect(result?.options.map((option) => option.label)).toEqual(['/clear']);
    expect(
      result?.options.map((option) => {
        const section =
          typeof option.section === 'string' ? undefined : option.section;
        return section?.name;
      }),
    ).toEqual(['System commands']);
  });

  it('supports custom slash command category order', () => {
    const commands: CommandInfo[] = [
      {
        name: 'clear',
        description: 'Clear the screen',
        source: 'builtin-command',
      },
      {
        name: 'batch',
        description: 'Execute batch operations',
        displayCategory: 'skill',
      },
      {
        name: 'demo:ping',
        description: 'Project command',
        source: 'skill-dir-command',
      },
    ];
    const source = slashCompletionSource(
      () => commands,
      () => [],
      () => 'en',
      getTranslator('en'),
      () => ['system', 'custom', 'skill'],
    );
    const state = EditorState.create({ doc: '/' });
    const result = source(new CompletionContext(state, 1, true));

    expect(result?.options.map((option) => option.label)).toEqual([
      '/clear',
      '/demo:ping',
      '/batch',
    ]);
    expect(
      result?.options.map((option) => {
        const section =
          typeof option.section === 'string' ? undefined : option.section;
        return section ? { name: section.name, rank: section.rank } : undefined;
      }),
    ).toEqual([
      { name: 'System commands', rank: 0 },
      { name: 'Custom commands', rank: 1 },
      { name: 'Skill commands', rank: 2 },
    ]);
  });

  it('completes Chinese custom slash command names', () => {
    const commands: CommandInfo[] = [
      {
        name: '学生信息',
        description: '收集学生信息',
        source: 'skill-dir-command',
      },
      {
        name: 'clear',
        description: 'Clear the screen',
        source: 'builtin-command',
      },
    ];
    const source = slashCompletionSource(
      () => commands,
      () => [],
      () => 'zh-CN',
      getTranslator('zh-CN'),
    );
    const state = EditorState.create({ doc: '/学' });
    const result = source(new CompletionContext(state, 2, true));

    expect(result?.from).toBe(0);
    expect(result?.to).toBe(2);
    expect(result?.options.map((option) => option.label)).toEqual([
      '/学生信息',
    ]);
  });

  it('completes implicit /mcp subcommands', () => {
    const commands: CommandInfo[] = [
      {
        name: 'mcp',
        description: 'Manage MCP servers',
        argumentHint: 'desc|nodesc|schema',
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
