/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Decision-logic tests for the OpenTUI composer model: the `\`+Enter submit
 * decision, the slash-command tree parse (sub-command + argument
 * completion), perfect-match detection, replacement positions, and the
 * large-paste placeholder lifecycle (ink InputPrompt parity).
 */

import { describe, expect, it } from 'vitest';
import {
  CompletionMode,
  LARGE_PASTE_CHAR_THRESHOLD,
  LARGE_PASTE_LINE_THRESHOLD,
  applyCompletion,
  commandCompletionItemsToSuggestions,
  decideSubmit,
  detectCompletionTarget,
  expandPendingPastePlaceholders,
  freePastePlaceholderId,
  isLargePaste,
  isPerfectSlashMatch,
  largePastePlaceholder,
  nextLargePastePlaceholder,
  normalizePastedText,
  parsePastePlaceholder,
  parseSlashCommandQuery,
  slashCommandPool,
  slashCompletionPositions,
  slashSuggestions,
  subcommandSuggestions,
  type CommandParseResult,
} from './input-prompt-model.js';
import { CommandKind, type SlashCommand } from '../commands/types.js';
import type { RecentSlashCommand } from '../hooks/useSlashCompletion.js';
import type { Suggestion } from '../utils/suggestions.js';

function cmd(
  overrides: Partial<SlashCommand> & { name: string },
): SlashCommand {
  return {
    description: `${overrides.name} description`,
    kind: CommandKind.BUILT_IN,
    action: () => undefined,
    ...overrides,
  };
}

const TEST_COMMANDS: readonly SlashCommand[] = [
  cmd({ name: 'help', altNames: ['?'] }),
  cmd({ name: 'heuristic' }),
  cmd({
    name: 'directory',
    altNames: ['dir'],
    subCommands: [
      cmd({ name: 'add', description: 'Add directories' }),
      cmd({ name: 'list' }),
    ],
  }),
  cmd({
    name: 'cd',
    completion: async () => ['/tmp/'],
  }),
  cmd({
    name: 'curator',
    action: undefined,
    subCommands: [
      cmd({
        name: 'pin',
        completion: async () => ['skill-a'],
      }),
      cmd({ name: 'unpin' }),
    ],
  }),
  cmd({ name: 'hidden-cmd', hidden: true }),
];

// Gating fixtures (R1-86): a model-invocable command whose canonical name
// suppresses the mid-input dropdown, a SKILL-kind command for stacked-skill
// continuations, and a regular command to make the input slash-led.
const GATING_COMMANDS: readonly SlashCommand[] = [
  cmd({ name: 'memory', modelInvocable: true }),
  cmd({ name: 'memory-sub', modelInvocable: true, hidden: true }),
  cmd({ name: 'skill-a', kind: CommandKind.SKILL }),
  cmd({ name: 'review' }),
];

describe('detectCompletionTarget mid-input gating (useCommandCompletion port, R1-86)', () => {
  const detect = (text: string, cursorOffset: number) => {
    const lines = text.split('\n');
    const before = text.slice(0, cursorOffset);
    const row = before.split('\n').length - 1;
    const col = before.length - (row > 0 ? before.lastIndexOf('\n') + 1 : 0);
    return detectCompletionTarget(
      lines,
      row,
      col,
      text,
      cursorOffset,
      GATING_COMMANDS,
    );
  };

  it('completes a token in regular mid-input text', () => {
    expect(detect('hello /me', 9)).toEqual({
      mode: CompletionMode.SLASH,
      query: '/me',
      start: 6,
      end: 9,
      slashContext: 'mid-input',
    });
  });

  it('does not offer mid-input completion for a slash-led argument', () => {
    // `/review /sto` falls through to the line-led target (the whole first
    // line), never to a mid-input pool — ink's isSlashLedInput gate.
    const target = detect('/review /sto', 12);
    expect(target?.mode).toBe(CompletionMode.SLASH);
    expect(target?.slashContext).toBeUndefined();
    expect(target?.query).toBe('/review /sto');
  });

  it('suppresses an exact model-invocable name (ghost text owns it)', () => {
    expect(detect('hello /memory', 13)).toBeNull();
  });

  it('completes a stacked-skill continuation with its own context', () => {
    expect(detect('/skill-a /sk', 12)).toEqual({
      mode: CompletionMode.SLASH,
      query: '/sk',
      start: 9,
      end: 12,
      slashContext: 'stacked-skill',
    });
  });
});

describe('slashCommandPool (ink slashCommandsForCompletion port, R1-86)', () => {
  it('mid-input sees only model-invocable non-hidden commands', () => {
    const pool = slashCommandPool(
      {
        mode: CompletionMode.SLASH,
        query: '/me',
        start: 6,
        end: 9,
        slashContext: 'mid-input',
      },
      GATING_COMMANDS,
    );
    expect(pool.map((c) => c.name)).toEqual(['memory']);
  });

  it('stacked-skill continuations see only skill commands', () => {
    const pool = slashCommandPool(
      {
        mode: CompletionMode.SLASH,
        query: '/sk',
        start: 9,
        end: 12,
        slashContext: 'stacked-skill',
      },
      GATING_COMMANDS,
    );
    expect(pool.map((c) => c.name)).toEqual(['skill-a']);
  });

  it('line-led commands see the full registry', () => {
    const pool = slashCommandPool(
      { mode: CompletionMode.SLASH, query: '/he', start: 0, end: 3 },
      GATING_COMMANDS,
    );
    expect(pool).toHaveLength(GATING_COMMANDS.length);
  });
});

describe('decideSubmit (`\\`+Enter continuation)', () => {
  it('submits ordinary text', () => {
    expect(decideSubmit('hello', 5)).toEqual({ kind: 'submit', text: 'hello' });
  });

  it('is a no-op for whitespace-only input', () => {
    expect(decideSubmit('   \n ', 5)).toEqual({ kind: 'noop' });
  });

  it('continues the line when the caret sits right after a backslash', () => {
    expect(decideSubmit('ab\\', 3)).toEqual({ kind: 'newline-continuation' });
  });

  it('submits when the backslash is not immediately before the caret', () => {
    expect(decideSubmit('ab\\cd', 5)).toEqual({
      kind: 'submit',
      text: 'ab\\cd',
    });
  });
});

describe('parseSlashCommandQuery (useCommandParser port)', () => {
  it('lists root commands for a bare slash', () => {
    const parsed = parseSlashCommandQuery('/', TEST_COMMANDS);
    expect(parsed.partial).toBe('');
    expect(parsed.currentLevel).toEqual(TEST_COMMANDS);
    expect(parsed.isArgumentCompletion).toBe(false);
  });

  it('keeps the top-level partial for `/he`', () => {
    const parsed = parseSlashCommandQuery('/he', TEST_COMMANDS);
    expect(parsed.commandPathParts).toEqual([]);
    expect(parsed.partial).toBe('he');
    expect(parsed.currentLevel).toEqual(TEST_COMMANDS);
  });

  it('drills into subCommands after `/directory `', () => {
    const parsed = parseSlashCommandQuery('/directory ', TEST_COMMANDS);
    expect(parsed.hasTrailingSpace).toBe(true);
    expect(parsed.commandPathParts).toEqual(['directory']);
    expect(parsed.partial).toBe('');
    expect(parsed.currentLevel?.map((c) => c.name)).toEqual(['add', 'list']);
  });

  it('matches sub-command prefixes (`/directory ad`)', () => {
    const parsed = parseSlashCommandQuery('/directory ad', TEST_COMMANDS);
    expect(parsed.partial).toBe('ad');
    expect(parsed.currentLevel?.map((c) => c.name)).toEqual(['add', 'list']);
  });

  it('resolves aliases while walking (`/dir `)', () => {
    const parsed = parseSlashCommandQuery('/dir ', TEST_COMMANDS);
    expect(parsed.currentLevel?.map((c) => c.name)).toEqual(['add', 'list']);
  });

  it('treats an exact parent name as the parent level (`/directory`)', () => {
    const parsed = parseSlashCommandQuery('/directory', TEST_COMMANDS);
    expect(parsed.exactMatchAsParent?.name).toBe('directory');
    expect(parsed.partial).toBe('');
    expect(parsed.currentLevel?.map((c) => c.name)).toEqual(['add', 'list']);
  });

  it('flags first-word argument completion for `/cd <partial>`', () => {
    const parsed = parseSlashCommandQuery('/cd /tm', TEST_COMMANDS);
    expect(parsed.isArgumentCompletion).toBe(true);
    expect(parsed.leafCommand?.name).toBe('cd');
    expect(parsed.argumentString).toBe('/tm');
    expect(parsed.invocationRaw).toBe('/cd /tm');
  });

  it('flags argument completion after a trailing space (`/cd `)', () => {
    const parsed = parseSlashCommandQuery('/cd ', TEST_COMMANDS);
    expect(parsed.isArgumentCompletion).toBe(true);
    expect(parsed.argumentString).toBe('');
  });

  it('reaches nested sub-command argument completion (`/curator pin `)', () => {
    const parsed = parseSlashCommandQuery('/curator pin ', TEST_COMMANDS);
    expect(parsed.isArgumentCompletion).toBe(true);
    expect(parsed.leafCommand?.name).toBe('pin');
  });

  it('stops resolving past unknown parts (`/cd foo bar`)', () => {
    const parsed = parseSlashCommandQuery('/cd foo bar', TEST_COMMANDS);
    expect(parsed.isArgumentCompletion).toBe(false);
    expect(parsed.leafCommand).toBeNull();
    expect(parsed.currentLevel).toEqual([]);
  });
});

describe('subcommandSuggestions / slashSuggestions', () => {
  it('ranks exact matches before prefix matches at the root', () => {
    const suggestions = slashSuggestions('/he', TEST_COMMANDS);
    expect(suggestions.map((s) => s.value)).toEqual(['help', 'heuristic']);
  });

  it('lists sub-commands after the resolved command (`/directory `)', () => {
    const suggestions = slashSuggestions('/directory ', TEST_COMMANDS);
    expect(suggestions.map((s) => s.value)).toEqual(['add', 'list']);
  });

  it('prefix-matches sub-commands (`/directory ad` → add)', () => {
    const suggestions = slashSuggestions('/directory ad', TEST_COMMANDS);
    expect(suggestions.map((s) => s.value)).toEqual(['add']);
  });

  it('hides hidden commands', () => {
    const suggestions = slashSuggestions('/hidden', TEST_COMMANDS);
    expect(suggestions).toEqual([]);
  });

  it('returns nothing for argument completion (async path owns it)', () => {
    expect(slashSuggestions('/cd /tm', TEST_COMMANDS)).toEqual([]);
  });

  it('exposes subcommandSuggestions for an existing parse result', () => {
    const parsed = parseSlashCommandQuery('/dir ', TEST_COMMANDS);
    expect(subcommandSuggestions(parsed).map((s) => s.value)).toEqual([
      'add',
      'list',
    ]);
  });
});

describe('fuzzy + recency ranking (useSlashCompletion port)', () => {
  function recent(
    entries: Array<[string, Partial<RecentSlashCommand>]>,
  ): ReadonlyMap<string, RecentSlashCommand> {
    return new Map(
      entries.map(([name, entry]) => [
        name,
        { name, usedAt: Date.now(), count: 1, ...entry },
      ]),
    );
  }

  it('matches beyond prefixes (`/mcpser` → mcp-servers)', () => {
    const suggestions = slashSuggestions('/mcpser', [
      cmd({ name: 'mcp-servers' }),
      cmd({ name: 'about' }),
    ]);
    expect(suggestions.map((s) => s.value)).toEqual(['mcp-servers']);
  });

  it('ranks a name match over an alias match (`/re` → resume before clear)', () => {
    const suggestions = slashSuggestions('/re', [
      cmd({ name: 'clear', altNames: ['reset'] }),
      cmd({ name: 'resume' }),
    ]);
    expect(suggestions.map((s) => s.value)).toEqual(['resume', 'clear']);
  });

  it('ranks prefix > segment-prefix > fuzzy (`/ser`)', () => {
    const suggestions = slashSuggestions('/ser', [
      cmd({ name: 'answers' }),
      cmd({ name: 'mcp-servers' }),
      cmd({ name: 'services' }),
    ]);
    expect(suggestions.map((s) => s.value)).toEqual([
      'services',
      'mcp-servers',
      'answers',
    ]);
  });

  it('carries the matched alias on alias hits (`/reset`)', () => {
    const suggestions = slashSuggestions('/reset', [
      cmd({ name: 'clear', altNames: ['reset'] }),
    ]);
    expect(suggestions[0]?.value).toBe('clear');
    expect(suggestions[0]?.matchedAlias).toBe('reset');
  });

  it('boosts recent commands for non-empty queries', () => {
    const suggestions = slashSuggestions(
      '/m',
      [cmd({ name: 'model' }), cmd({ name: 'memory' })],
      recent([['memory', {}]]),
    );
    expect(suggestions.map((s) => s.value)).toEqual(['memory', 'model']);
  });

  it('lists recently used commands first for an empty query', () => {
    const suggestions = slashSuggestions(
      '/',
      TEST_COMMANDS,
      recent([['heuristic', {}]]),
    );
    expect(suggestions[0]?.value).toBe('heuristic');
  });

  it('weights repeat use above a single recent use', () => {
    const suggestions = slashSuggestions(
      '/',
      [cmd({ name: 'alpha' }), cmd({ name: 'beta' })],
      recent([
        ['alpha', { count: 1 }],
        ['beta', { count: 3 }],
      ]),
    );
    expect(suggestions.map((s) => s.value)).toEqual(['beta', 'alpha']);
  });

  it('decays recency over time', () => {
    const suggestions = slashSuggestions(
      '/',
      [cmd({ name: 'alpha' }), cmd({ name: 'beta' })],
      recent([
        ['alpha', { usedAt: Date.now() }],
        ['beta', { usedAt: Date.now() - 20 * 60 * 1000 }],
      ]),
    );
    expect(suggestions.map((s) => s.value)).toEqual(['alpha', 'beta']);
  });
});

describe('slashCompletionPositions (useCompletionPositions port)', () => {
  function positions(query: string): { start: number; end: number } {
    return slashCompletionPositions(
      query,
      parseSlashCommandQuery(query, TEST_COMMANDS),
    );
  }

  it('replaces the partial for a top-level query (`/he`)', () => {
    expect(positions('/he')).toEqual({ start: 1, end: 3 });
  });

  it('replaces the sub-command partial (`/directory ad`)', () => {
    expect(positions('/directory ad')).toEqual({ start: 11, end: 13 });
  });

  it('inserts at the end after a trailing space (`/directory `)', () => {
    expect(positions('/directory ')).toEqual({ start: 11, end: 11 });
  });

  it('inserts at the end for an exact parent (`/directory`)', () => {
    expect(positions('/directory')).toEqual({ start: 10, end: 10 });
  });

  it('starts an argument after the command path (`/cd /tm`)', () => {
    expect(positions('/cd /tm')).toEqual({ start: 4, end: 7 });
  });

  it('replaces everything after a bare slash', () => {
    expect(positions('/')).toEqual({ start: 1, end: 1 });
  });
});

describe('isPerfectSlashMatch (usePerfectMatch port)', () => {
  function perfect(query: string): boolean {
    return isPerfectSlashMatch(parseSlashCommandQuery(query, TEST_COMMANDS));
  }

  it('is false while the name is still partial (`/he`)', () => {
    expect(perfect('/he')).toBe(false);
  });

  it('is true for an exact runnable command (`/help`)', () => {
    expect(perfect('/help')).toBe(true);
  });

  it('is true for an exact altName (`/?`)', () => {
    expect(perfect('/?')).toBe(true);
  });

  it('is false once arguments start (`/help `)', () => {
    expect(perfect('/help ')).toBe(false);
  });

  it('is true for an exact nested command (`/directory add`)', () => {
    expect(perfect('/directory add')).toBe(true);
  });

  it('is false for a parent without an action (`/curator`)', () => {
    expect(perfect('/curator')).toBe(false);
  });
});

describe('commandCompletionItemsToSuggestions', () => {
  it('maps strings and items, dropping value-less entries', () => {
    const suggestions = commandCompletionItemsToSuggestions([
      'plain',
      { value: 'rich', label: 'Rich', description: 'd' },
      { value: '', label: 'dropped' },
      { value: 'dir/', isDirectory: true },
    ]);
    expect(suggestions).toEqual([
      { label: 'plain', value: 'plain' },
      { label: 'Rich', value: 'rich', description: 'd' },
      { label: 'dir/', value: 'dir/', isDirectory: true },
    ]);
  });
});

describe('applyCompletion', () => {
  const slashTarget = {
    mode: CompletionMode.SLASH,
    query: '',
    start: 0,
    end: 0,
  };

  it('replaces a top-level partial keeping the leading slash', () => {
    const applied = applyCompletion(
      '/he',
      { ...slashTarget, query: '/he', start: 0, end: 3 },
      { label: 'help', value: 'help' },
      false,
      { start: 1, end: 3 },
    );
    expect(applied.line).toBe('/help ');
    expect(applied.cursorCol).toBe(6);
    expect(applied.submitNow).toBeUndefined();
  });

  it('inserts a sub-command after the resolved path', () => {
    const applied = applyCompletion(
      '/directory ad',
      { ...slashTarget, query: '/directory ad', start: 0, end: 13 },
      { label: 'add', value: 'add' },
      false,
      { start: 11, end: 13 },
    );
    expect(applied.line).toBe('/directory add ');
    expect(applied.cursorCol).toBe(15);
  });

  it('inserts an argument completion without clobbering the command', () => {
    const applied = applyCompletion(
      '/cd /tm',
      { ...slashTarget, query: '/cd /tm', start: 0, end: 7 },
      { label: '/tmp/', value: '/tmp/', isDirectory: true },
      false,
      { start: 4, end: 7 },
    );
    // Directories keep the caret adjacent (no trailing space) for drill-in.
    expect(applied.line).toBe('/cd /tmp/');
    expect(applied.cursorCol).toBe(9);
  });

  it('appends a trailing space unless one already follows', () => {
    const applied = applyCompletion(
      '/he x',
      { ...slashTarget, query: '/he', start: 0, end: 3 },
      { label: 'help', value: 'help' },
      false,
      { start: 1, end: 3 },
    );
    expect(applied.line).toBe('/help x');
  });

  it('submits on Enter-accept for submitOnAccept suggestions', () => {
    const applied = applyCompletion(
      '/skil',
      { ...slashTarget, query: '/skil', start: 0, end: 5 },
      { label: 'skills', value: 'skills', submitOnAccept: true },
      true,
      { start: 1, end: 5 },
    );
    expect(applied.submitNow).toBe('/skills');
  });

  it('keeps the legacy slash behavior without a range (adds the slash)', () => {
    const applied = applyCompletion(
      '/he',
      { ...slashTarget, query: '/he', start: 0, end: 3 },
      { label: 'help', value: 'help' },
      false,
    );
    expect(applied.line).toBe('/help ');
  });

  it('leaves AT completions untouched by slash handling', () => {
    const applied = applyCompletion(
      '@src/ind',
      { mode: CompletionMode.AT, query: 'src/ind', start: 1, end: 8 },
      { label: 'src/index.ts', value: 'src/index.ts' },
      false,
    );
    expect(applied.line).toBe('@src/index.ts ');
  });
});

describe('large-paste collapsing', () => {
  it('normalizes CRLF and CR onto LF', () => {
    expect(normalizePastedText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('collapses pastes over the char threshold', () => {
    const paste = 'x'.repeat(LARGE_PASTE_CHAR_THRESHOLD + 1);
    expect(isLargePaste(paste)).toBe(true);
    expect(isLargePaste('x'.repeat(LARGE_PASTE_CHAR_THRESHOLD))).toBe(false);
  });

  it('collapses pastes over the line threshold', () => {
    const lines = 'l'.repeat(LARGE_PASTE_LINE_THRESHOLD + 1);
    expect(isLargePaste(lines.split('').join('\n'))).toBe(true);
    const under = 'l'.repeat(LARGE_PASTE_LINE_THRESHOLD);
    expect(isLargePaste(under.split('').join('\n'))).toBe(false);
  });

  it('counts Unicode characters, not UTF-16 units', () => {
    const emoji = '😀'.repeat(501); // 501 code points, 1002 UTF-16 units
    expect(isLargePaste(emoji)).toBe(false);
  });

  it('allocates, disambiguates and frees placeholder ids', () => {
    const active = new Map<number, Set<number>>();
    expect(nextLargePastePlaceholder(42, active)).toBe(
      '[Pasted Content 42 chars]',
    );
    expect(nextLargePastePlaceholder(42, active)).toBe(
      '[Pasted Content 42 chars] #2',
    );
    expect(nextLargePastePlaceholder(7, active)).toBe(
      '[Pasted Content 7 chars]',
    );
    // Freeing #1 lets the next same-size paste reuse it.
    freePastePlaceholderId(active, 42, 1);
    expect(nextLargePastePlaceholder(42, active)).toBe(
      '[Pasted Content 42 chars]',
    );
  });

  it('parses placeholders back into char count and id', () => {
    expect(parsePastePlaceholder('[Pasted Content 42 chars]')).toEqual({
      charCount: 42,
      id: 1,
    });
    expect(parsePastePlaceholder('[Pasted Content 42 chars] #3')).toEqual({
      charCount: 42,
      id: 3,
    });
    expect(parsePastePlaceholder('not a placeholder')).toBeNull();
  });

  it('formats placeholders like ink', () => {
    expect(largePastePlaceholder(1000, 1)).toBe('[Pasted Content 1000 chars]');
    expect(largePastePlaceholder(1000, 2)).toBe(
      '[Pasted Content 1000 chars] #2',
    );
  });

  it('expands placeholders on submit', () => {
    const pending = new Map<string, string>([
      ['[Pasted Content 1200 chars]', 'line1\nline2'],
    ]);
    expect(
      expandPendingPastePlaceholders(
        'before [Pasted Content 1200 chars] after',
        pending,
      ),
    ).toBe('before line1\nline2 after');
  });

  it('leaves text untouched when nothing is pending', () => {
    expect(expandPendingPastePlaceholders('plain', new Map())).toBe('plain');
  });
});

describe('parse result invariants', () => {
  it('handles a null query as the root listing', () => {
    const parsed = parseSlashCommandQuery(null, TEST_COMMANDS);
    expect(parsed.currentLevel).toEqual(TEST_COMMANDS);
    expect(parsed.partial).toBe('');
  });

  it('accepts queries without a leading slash', () => {
    const parsed = parseSlashCommandQuery('he', TEST_COMMANDS);
    expect(parsed.partial).toBe('he');
  });

  it('keeps the interface exhaustive for future fields', () => {
    const parsed: CommandParseResult = parseSlashCommandQuery(
      '/x',
      TEST_COMMANDS,
    );
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'argumentString',
        'commandPathParts',
        'currentLevel',
        'exactMatchAsParent',
        'hasTrailingSpace',
        'invocationRaw',
        'isArgumentCompletion',
        'leafCommand',
        'partial',
      ].sort(),
    );
  });
});

describe('suggestion shape stability', () => {
  it('carries argument hints and descriptions for dropdown rendering', () => {
    const withHint = cmd({ name: 'cd2', argumentHint: '<path>' });
    const suggestions: Suggestion[] = slashSuggestions('/cd2', [withHint]);
    expect(suggestions[0]?.argumentHint).toBe('<path>');
    expect(suggestions[0]?.description).toBe('cd2 description');
  });
});
