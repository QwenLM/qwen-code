import { describe, expect, it } from 'vitest';
import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import type { CommandInfo } from '../adapters/types';
import { getTranslator } from '../i18n';
import {
  getSlashCommandCompletionResult,
  getSlashCommandArgumentHint,
  getImplicitTabCompletion,
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

describe('getSlashCommandArgumentHint progressive skill hints', () => {
  const verifyPr: CommandInfo[] = [
    {
      name: 'verify-pr',
      description: 'Verify a PR',
      source: 'skill',
      argumentHint: '<pr-number> [--publish] [--watch] [--repo <owner>/<repo>]',
    },
  ];

  it('shows remaining flags after the required argument is typed', () => {
    expect(
      getSlashCommandArgumentHint('/verify-pr 15871', verifyPr, 'en'),
    ).toBe('[--publish] [--watch] [--repo <owner>/<repo>]');
    expect(
      getSlashCommandArgumentHint('/verify-pr 15871 --publish', verifyPr, 'en'),
    ).toBe('[--watch] [--repo <owner>/<repo>]');
  });

  it('consumes a flag value and keeps the value hint while it is missing', () => {
    expect(
      getSlashCommandArgumentHint(
        '/verify-pr 15871 --repo alice/repo',
        verifyPr,
        'en',
      ),
    ).toBe('[--publish] [--watch]');
    expect(
      getSlashCommandArgumentHint('/verify-pr 15871 --repo', verifyPr, 'en'),
    ).toBe('<owner>/<repo> [--publish] [--watch]');
  });

  it('puts a pending flag value before the remaining arguments', () => {
    expect(
      getSlashCommandArgumentHint('/verify-pr --repo', verifyPr, 'en'),
    ).toBe('<owner>/<repo> <pr-number> [--publish] [--watch]');
    expect(
      getSlashCommandArgumentHint(
        '/verify-pr --repo alice/repo 15871',
        verifyPr,
        'en',
      ),
    ).toBe('[--publish] [--watch]');
  });

  it('rejects a flag prefix that is followed by more arguments', () => {
    expect(
      getSlashCommandArgumentHint(
        '/verify-pr 15871 --pub --watch',
        verifyPr,
        'en',
      ),
    ).toBeNull();
    expect(
      getSlashCommandArgumentHint(
        '/verify-pr 15871 --pub --bogus',
        verifyPr,
        'en',
      ),
    ).toBeNull();
  });

  it.each(['skill-dir-command', 'bundled-skill'] as const)(
    'recognizes live-session source %s as skill-backed',
    (source) => {
      const commands: CommandInfo[] = [
        {
          name: 'verify-pr',
          description: 'Verify a PR',
          source,
          argumentHint: '<pr-number> [--publish]',
        },
      ];
      expect(getSlashCommandArgumentHint('/verify-pr', commands, 'en')).toBe(
        '<pr-number> [--publish]',
      );
      expect(
        getSlashCommandArgumentHint('/verify-pr 15871', commands, 'en'),
      ).toBe('[--publish]');
    },
  );

  it('recognizes extension skills by session membership, not by the shared plugin source', () => {
    const commands: CommandInfo[] = [
      {
        name: 'ext:probe',
        description: 'Extension skill',
        source: 'plugin-command',
        argumentHint: '<id> [--watch]',
      },
      {
        name: 'plugin-tool',
        description: 'Ordinary plugin command',
        source: 'plugin-command',
        argumentHint: '<target>',
      },
    ];
    const skillNames = new Set(['ext:probe']);
    expect(
      getSlashCommandArgumentHint('/ext:probe 42', commands, 'en', skillNames),
    ).toBe('[--watch]');
    expect(
      getSlashCommandArgumentHint(
        '/plugin-tool 42',
        commands,
        'en',
        skillNames,
      ),
    ).toBeNull();
    expect(
      getSlashCommandArgumentHint('/plugin-tool', commands, 'en', skillNames),
    ).toBe('<target>');
  });

  it('matches skill membership case-insensitively and covers source-less entries', () => {
    const commands: CommandInfo[] = [
      {
        name: 'Ext:Probe',
        description: 'Synthesized skill entry without a top-level source',
        argumentHint: '<id> [--watch]',
      },
    ];
    expect(
      getSlashCommandArgumentHint(
        '/Ext:Probe 42',
        commands,
        'en',
        new Set(['ext:probe']),
      ),
    ).toBe('[--watch]');
  });

  it('keeps the matching flag group visible while the flag is being typed', () => {
    expect(
      getSlashCommandArgumentHint('/verify-pr 15871 --pub', verifyPr, 'en'),
    ).toBe('[--publish] [--watch] [--repo <owner>/<repo>]');
  });

  it('hides the hint once every hint token is consumed', () => {
    const commands: CommandInfo[] = [
      {
        name: 'demo',
        description: 'Demo',
        source: 'skill',
        argumentHint: '<id> [--yes]',
      },
    ];
    expect(
      getSlashCommandArgumentHint('/demo 1 --yes', commands, 'en'),
    ).toBeNull();
  });

  it('hides the hint for arguments the hint cannot describe', () => {
    expect(
      getSlashCommandArgumentHint('/verify-pr 15871 --bogus', verifyPr, 'en'),
    ).toBeNull();
    expect(
      getSlashCommandArgumentHint('/verify-pr 15871 extra', verifyPr, 'en'),
    ).toBeNull();
  });

  it('keeps a required placeholder in the hint when a flag is typed first', () => {
    expect(
      getSlashCommandArgumentHint('/verify-pr --publish', verifyPr, 'en'),
    ).toBe('<pr-number> [--watch] [--repo <owner>/<repo>]');
  });

  it('consumes free-text placeholders entirely', () => {
    const commands: CommandInfo[] = [
      {
        name: 'create-issue',
        description: 'Create an issue',
        source: 'skill',
        argumentHint: '<feature idea or bug description>',
      },
    ];
    expect(
      getSlashCommandArgumentHint(
        '/create-issue add dark mode',
        commands,
        'en',
      ),
    ).toBeNull();
  });

  it('prefers the literal mode branch over optional placeholders', () => {
    const commands: CommandInfo[] = [
      {
        name: 'autofix-pr',
        description: 'Autofix a PR',
        source: 'skill',
        argumentHint: '[<pr>] [--once] | status [<pr>] | stop [<pr>]',
      },
    ];
    expect(
      getSlashCommandArgumentHint('/autofix-pr status', commands, 'en'),
    ).toBe('[<pr>]');
    expect(
      getSlashCommandArgumentHint('/autofix-pr 15871', commands, 'en'),
    ).toBe('[--once]');
    expect(
      getSlashCommandArgumentHint('/autofix-pr stop 15871', commands, 'en'),
    ).toBeNull();
  });

  it('supports flag value alternatives and optional placeholders before flags', () => {
    const commands: CommandInfo[] = [
      {
        name: 'review',
        description: 'Review',
        source: 'skill',
        argumentHint:
          '[pr-number|file-path] [--effort low|medium|high] [--fix]',
      },
    ];
    expect(
      getSlashCommandArgumentHint('/review 15871 --effort', commands, 'en'),
    ).toBe('low|medium|high [--fix]');
    expect(
      getSlashCommandArgumentHint(
        '/review 15871 --effort high',
        commands,
        'en',
      ),
    ).toBe('[--fix]');
    expect(getSlashCommandArgumentHint('/review --fix', commands, 'en')).toBe(
      '[pr-number|file-path] [--effort low|medium|high]',
    );
  });

  it('hides the hint when a flag is repeated beyond its hint group', () => {
    const commands: CommandInfo[] = [
      {
        name: 'demo',
        description: 'Demo',
        source: 'skill',
        argumentHint: '<id> [--yes] [--no]',
      },
    ];
    expect(
      getSlashCommandArgumentHint('/demo 1 --yes --yes', commands, 'en'),
    ).toBeNull();
  });

  it('does not swallow a following flag as a missing flag value', () => {
    const commands: CommandInfo[] = [
      {
        name: 'demo',
        description: 'Demo',
        source: 'skill',
        argumentHint: '<id> [--repo <owner>/<repo>] [--watch]',
      },
    ];
    expect(
      getSlashCommandArgumentHint('/demo 1 --repo --watch', commands, 'en'),
    ).toBe('<owner>/<repo>');
  });

  it('degrades gracefully on malformed hints', () => {
    for (const hint of [
      '[',
      '<',
      '[--x',
      '|',
      '||',
      '[[]]',
      '[]',
      '<>',
      '[] []',
    ]) {
      const commands: CommandInfo[] = [
        {
          name: 'demo',
          description: 'Demo',
          source: 'skill',
          argumentHint: hint,
        },
      ];
      expect(
        getSlashCommandArgumentHint('/demo 1 --yes', commands, 'en'),
      ).toBeNull();
    }
  });

  it('hides the original empty-group witness instead of echoing a leftover token', () => {
    const commands: CommandInfo[] = [
      {
        name: 'demo',
        description: 'Demo',
        source: 'skill',
        argumentHint: '[] []',
      },
    ];
    expect(getSlashCommandArgumentHint('/demo x', commands, 'en')).toBeNull();
  });

  it('consumes flags typed after a free-text placeholder', () => {
    const commands: CommandInfo[] = [
      {
        name: 'demo',
        description: 'Demo',
        source: 'skill',
        argumentHint: '<task description> [--dry-run] [--verbose]',
      },
    ];
    expect(
      getSlashCommandArgumentHint(
        '/demo update deps --dry-run',
        commands,
        'en',
      ),
    ).toBe('[--verbose]');
    expect(
      getSlashCommandArgumentHint(
        '/demo --dry-run update deps',
        commands,
        'en',
      ),
    ).toBe('[--verbose]');
    expect(
      getSlashCommandArgumentHint(
        '/demo update deps --dry-run --verbose',
        commands,
        'en',
      ),
    ).toBeNull();
    expect(
      getSlashCommandArgumentHint('/demo update deps --dry', commands, 'en'),
    ).toBe('[--dry-run] [--verbose]');
    expect(
      getSlashCommandArgumentHint('/demo update deps --bogus', commands, 'en'),
    ).toBeNull();
  });

  it('does not re-ask for a flag after a spaced single-value placeholder', () => {
    const commands: CommandInfo[] = [
      {
        name: 'verify-pr',
        description: 'Verify a PR',
        source: 'skill',
        argumentHint: '<PR number> [--publish] [--watch]',
      },
    ];
    expect(
      getSlashCommandArgumentHint('/verify-pr 15871 --publish', commands, 'en'),
    ).toBe('[--watch]');
  });

  it('keeps absorbing multi-word prose when no flag follows', () => {
    const commands: CommandInfo[] = [
      {
        name: 'demo',
        description: 'Demo',
        source: 'skill',
        argumentHint: '<feature idea or bug description> [--draft]',
      },
    ];
    expect(
      getSlashCommandArgumentHint(
        '/demo add dark mode --draft',
        commands,
        'en',
      ),
    ).toBeNull();
    expect(
      getSlashCommandArgumentHint('/demo add dark mode', commands, 'en'),
    ).toBe('[--draft]');
  });
});

describe('getSlashCommandCompletionResult', () => {
  it.each(['en', 'zh-CN'] as const)(
    'keeps Skill names separate from built-in syntax in %s',
    (language) => {
      for (const [name, argument] of [
        ['agents', ''],
        ['theme', ''],
        ['export', ''],
        ['language', ''],
        ['extensions', ''],
        ['context', 'd'],
        ['copy', 'c'],
        ['tools', 'd'],
        ['stats', 'm'],
        ['mcp', 'd'],
        ['memory', 's'],
        ['skills', ''],
      ]) {
        const commands: CommandInfo[] = [
          { name: name!, description: 'Published Skill', source: 'skill' },
        ];
        const skills = [{ name: 'review', description: 'Review' }];
        const text = `/${name} ${argument}`;
        expect(
          getSlashCommandCompletionResult(
            text,
            text.length,
            commands,
            skills,
            language,
          ),
        ).toBeNull();
        expect(
          getImplicitTabCompletion(`/${name} `, commands, language),
        ).toBeNull();
        expect(
          getSlashCommandArgumentHint(`/${name}`, commands, language),
        ).toBeNull();
        const source = slashCompletionSource(
          () => commands,
          () => skills,
          () => language,
        );
        const state = EditorState.create({ doc: text });
        expect(
          source(new CompletionContext(state, text.length, true)),
        ).toBeNull();
      }
    },
  );

  it('retains a Skill own argument hint without interpreting its arguments as built-ins', () => {
    const commands: CommandInfo[] = [
      {
        name: 'context',
        description: 'Skill',
        source: 'skill',
        argumentHint: '<topic>',
      },
    ];
    expect(getSlashCommandArgumentHint('/context', commands, 'en')).toBe(
      '<topic>',
    );
    expect(
      getSlashCommandArgumentHint('/context detail', commands, 'en'),
    ).toBeNull();
  });

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
        autoSubmit: true,
      },
    ]);
  });

  it('fuzzy-ranks top-level commands for an abbreviated query', () => {
    const commands: CommandInfo[] = [
      { name: 'model', description: 'Switch model', source: 'builtin-command' },
      {
        name: 'memory',
        description: 'Manage memory',
        source: 'builtin-command',
      },
      {
        name: 'agent-reproduce-feature',
        description: 'Reproduce a feature',
        source: 'skill-dir-command',
      },
    ];

    const mdl = getSlashCommandCompletionResult(
      '/mdl',
      4,
      commands,
      [],
      'en',
      getTranslator('en'),
    );
    expect(mdl?.items[0]?.label).toBe('/model');

    const arf = getSlashCommandCompletionResult(
      '/arf',
      4,
      commands,
      [],
      'en',
      getTranslator('en'),
    );
    expect(arf?.items.map((item) => item.label)).toContain(
      '/agent-reproduce-feature',
    );
  });

  it('drops section headers while searching but keeps them while browsing', () => {
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

    const browsing = getSlashCommandCompletionResult(
      '/',
      1,
      commands,
      [],
      'en',
      getTranslator('en'),
    );
    expect(browsing?.items.every((item) => Boolean(item.section))).toBe(true);

    const searching = getSlashCommandCompletionResult(
      '/c',
      2,
      commands,
      [],
      'en',
      getTranslator('en'),
    );
    expect(searching?.items.map((item) => item.label)).toEqual(['/clear']);
    expect(searching?.items.every((item) => item.section === undefined)).toBe(
      true,
    );
  });

  it('returns null when fuzzy search matches nothing', () => {
    const commands: CommandInfo[] = [
      { name: 'clear', description: 'Clear', source: 'builtin-command' },
    ];
    const result = getSlashCommandCompletionResult(
      '/zzzzzzz',
      8,
      commands,
      [],
      'en',
      getTranslator('en'),
    );
    expect(result).toBeNull();
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

  it('limits the rendered command menu while keeping search available', () => {
    const commands = Array.from({ length: 1_000 }, (_, index) => ({
      name: `command-${index}`,
      description: `Command ${index}`,
      source: 'builtin-command' as const,
    }));

    const browsing = getSlashCommandCompletionResult('/', 1, commands);
    const searching = getSlashCommandCompletionResult(
      '/command-999',
      12,
      commands,
    );

    expect(browsing?.items).toHaveLength(50);
    expect(searching?.items[0]?.label).toBe('/command-999');
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
