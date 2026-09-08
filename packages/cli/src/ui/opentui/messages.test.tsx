/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the OpenTUI message meta helpers: the tool-card naming/status
 * parity with the original ToolMessage (`Shell echo X (Echo X)` — display
 * name from the shared map, description reconstructed from the invocation
 * args, no generic `· ok` suffix) and the user/assistant/thinking glyphs.
 */

import { describe, it, expect, vi } from 'vitest';

// theme.ts builds a SyntaxStyle at module scope, which needs the OpenTUI
// native FFI — unavailable in the test runtime. Stub the graphics surface.
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

import {
  GENERIC_TOOL_SUMMARIES,
  MAX_RESULT_DISPLAY_CHARACTERS,
  TOOL_CARD_DESCRIPTION_ROWS,
  assistantMessageMeta,
  capToolCardDescription,
  headWindowPhysical,
  hiddenLinesLabel,
  hiddenTailLinesLabel,
  maxHistoryItemRows,
  pendingCardMaxRows,
  tailWindow,
  tailWindowPhysical,
  thinkingMeta,
  toolCardDescription,
  toolCardName,
  toolCardSummarySuffix,
  toolCardText,
  toolStatusMeta,
  truncateResultDisplayChars,
  truncateTokenLine,
  userMessageMeta,
  STATUS_INDICATOR_WIDTH,
} from './messages.js';
import { toCodePoints } from '../utils/textUtils.js';
import { TOOL_STATUS } from '../constants.js';
import { C } from './theme.js';
import type { AnsiToken } from '@qwen-code/qwen-code-core';
import type { LiveToolItem } from './live-session-model.js';

const ansiToken = (text: string, fg = ''): AnsiToken => ({
  text,
  bold: false,
  italic: false,
  underline: false,
  dim: false,
  inverse: false,
  fg,
  bg: '',
});

describe('toolCardName (ink ToolDisplayNames parity)', () => {
  it('maps internal tool names to their display names', () => {
    expect(toolCardName('run_shell_command')).toBe('Shell');
    expect(toolCardName('read_file')).toBe('ReadFile');
    expect(toolCardName('write_file')).toBe('WriteFile');
    expect(toolCardName('grep_search')).toBe('Grep');
    expect(toolCardName('glob')).toBe('Glob');
    expect(toolCardName('edit')).toBe('Edit');
  });

  it('passes unknown names through unchanged', () => {
    expect(toolCardName('mcp__server__tool')).toBe('mcp__server__tool');
    expect(toolCardName('Read')).toBe('Read');
  });
});

describe('toolCardDescription (invocation getDescription parity)', () => {
  it('renders shell cards as `command (description)`', () => {
    const args = JSON.stringify({
      command: 'echo PARITY-OK',
      description: 'Echo PARITY-OK',
    });
    expect(toolCardDescription('run_shell_command', args)).toBe(
      'echo PARITY-OK (Echo PARITY-OK)',
    );
  });

  it('renders shell cards without a description as the bare command', () => {
    const args = JSON.stringify({ command: 'git status' });
    expect(toolCardDescription('run_shell_command', args)).toBe('git status');
  });

  it('collapses multi-line commands and descriptions to one line', () => {
    const args = JSON.stringify({
      command: 'echo a\necho b',
      description: 'line one\nline two',
    });
    expect(toolCardDescription('run_shell_command', args)).toBe(
      'echo a echo b (line one line two)',
    );
  });

  it('renders file tools with their path argument', () => {
    expect(
      toolCardDescription(
        'read_file',
        JSON.stringify({ file_path: '/a/b.ts' }),
      ),
    ).toBe('/a/b.ts');
    expect(
      toolCardDescription('edit', JSON.stringify({ file_path: '/a/b.ts' })),
    ).toBe('/a/b.ts');
  });

  it('renders grep with its pattern', () => {
    expect(
      toolCardDescription('grep_search', JSON.stringify({ pattern: 'foo.*' })),
    ).toBe('foo.*');
  });

  it('returns empty without args or for unknown tools', () => {
    expect(toolCardDescription('run_shell_command')).toBe('');
    expect(toolCardDescription('run_shell_command', 'not json')).toBe('');
    expect(toolCardDescription('some_other_tool', '{}')).toBe('');
  });
});

describe('toolCardText (card one-liner sanitize, R1-105)', () => {
  it('collapses newlines and surrounding whitespace to single spaces', () => {
    expect(toolCardText('line one\n  line two\n')).toBe('line one line two');
  });

  it('neutralizes ANSI escapes and control bytes into inert text', () => {
    // Escapes become visible \uXXXX sequences, never live control bytes.
    expect(toolCardText('run\u001b[31m red\u001b[0m')).toBe(
      'run\\u001b[31m red\\u001b[0m',
    );
    expect(toolCardText('a\u0007b')).toBe('a\\u0007b');
  });
});

describe('toolCardSummarySuffix (status format parity)', () => {
  it('suppresses the generic summaries the glyph already conveys', () => {
    expect(GENERIC_TOOL_SUMMARIES.has('ok')).toBe(true);
    expect(toolCardSummarySuffix(true, 'ok')).toBe('');
    expect(toolCardSummarySuffix(true, 'error')).toBe('');
    expect(toolCardSummarySuffix(true, 'skipped')).toBe('');
    expect(toolCardSummarySuffix(true, 'interrupted')).toBe('');
  });

  it('keeps informative custom summaries', () => {
    expect(toolCardSummarySuffix(true, '4779 lines')).toBe(' · 4779 lines');
  });

  it('shows nothing while the tool is still running', () => {
    expect(toolCardSummarySuffix(false, 'anything')).toBe('');
    expect(toolCardSummarySuffix(true, undefined)).toBe('');
  });
});

describe('long-content caps (ink MaxSizedBox parity)', () => {
  it('caps an item at max(terminalHeight * 4, 100) rows', () => {
    expect(maxHistoryItemRows(24)).toBe(100);
    expect(maxHistoryItemRows(25)).toBe(100);
    expect(maxHistoryItemRows(50)).toBe(200);
  });

  it('budgets a pending card below the confirmation dialog footprint', () => {
    // At 80 rows the ink-parity cap is 320 — 4x past the viewport. The
    // pending budget is bounded by the collapsed dialog footprint, and by
    // the payload the dialog renders expanded: a hook-forced confirmation
    // duplicates the card's description in its body, so a wide payload
    // shrinks the card or ctrl-s expansion pushes the dialog off screen
    // (mem0 e2e regression).
    expect(maxHistoryItemRows(80)).toBe(320);
    expect(pendingCardMaxRows(80, 0, 110)).toBe(34);
    expect(pendingCardMaxRows(100, 0, 110)).toBe(54);
    // A ~3.9k-char payload wraps to ~37 dialog rows at 110 columns.
    expect(pendingCardMaxRows(80, 3900, 110)).toBe(20);
  });

  it('falls back to the settled cap on short terminals', () => {
    expect(pendingCardMaxRows(24, 3900, 110)).toBe(TOOL_CARD_DESCRIPTION_ROWS);
    expect(pendingCardMaxRows(46, 0, 110)).toBe(TOOL_CARD_DESCRIPTION_ROWS);
  });

  it('keeps everything when the content fits', () => {
    const lines = ['a', 'b', 'c'];
    expect(tailWindow(lines, 100)).toEqual({ visible: lines, hiddenCount: 0 });
  });

  it('keeps the tail and counts the hidden head', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    const win = tailWindow(lines, 5);
    expect(win.visible).toEqual(['line 6', 'line 7', 'line 8', 'line 9']);
    expect(win.hiddenCount).toBe(6);
  });

  it('never shrinks below the ink MINIMUM_MAX_HEIGHT of 2', () => {
    const win = tailWindow(['a', 'b', 'c'], 1);
    expect(win.visible).toEqual(['c']);
    expect(win.hiddenCount).toBe(2);
  });

  it('renders the ink hidden-lines indicator', () => {
    expect(hiddenLinesLabel(1)).toBe('... first 1 line hidden ...');
    expect(hiddenLinesLabel(4779)).toBe('... first 4779 lines hidden ...');
  });

  it('keeps everything when the physical height fits', () => {
    const rows = ['a'.repeat(150), 'b'];
    expect(headWindowPhysical(rows, 102, 20)).toEqual({
      visible: rows,
      hiddenRows: 0,
    });
  });

  it('caps a single over-long logical row by its wrapped height', () => {
    const win = headWindowPhysical(['head', 'x'.repeat(5000)], 102, 20);
    expect(win.visible[0]).toBe('head');
    expect(win.visible[1]).toBe('x'.repeat(18 * 100));
    expect(win.visible).toHaveLength(2);
    // 1 + 50 physical rows total, 19 budgeted for content.
    expect(win.hiddenRows).toBe(32);
  });

  it('keeps whole rows while they fit and slices the overflowing row', () => {
    const rows = Array.from(
      { length: 15 },
      (_, i) => `${i % 10}`.repeat(150), // 2 physical rows each at 100 cols
    );
    const win = headWindowPhysical(rows, 102, 20);
    expect(win.visible).toHaveLength(10);
    expect(win.visible[9]).toBe('9'.repeat(100));
    // 30 physical rows total, 19 budgeted for content.
    expect(win.hiddenRows).toBe(11);
  });

  it('engages the cap for a wide-character row measured in display columns', () => {
    // 1200 Han characters span 2400 columns: 24 physical rows at 100 cols,
    // not the 12 rows a UTF-16 length estimate would model.
    const win = headWindowPhysical(['汉'.repeat(1200)], 102, 20);
    expect(toCodePoints(win.visible[0])).toHaveLength(950);
    expect(win.hiddenRows).toBe(5);
  });

  it('cuts a wide-character row on a code-point boundary, never mid-pair', () => {
    const win = headWindowPhysical(['𝕏'.repeat(201)], 103, 1);
    expect(win.visible[0]).toMatch(/𝕏$/);
    expect(toCodePoints(win.visible[0])).toHaveLength(101);
  });

  it('renders the ink bottom-overflow hidden-tail indicator', () => {
    expect(hiddenTailLinesLabel(1)).toBe('... last 1 line hidden ...');
    expect(hiddenTailLinesLabel(4779)).toBe('... last 4779 lines hidden ...');
  });

  it('keeps everything when the physical height fits the tail budget', () => {
    const rows = ['a'.repeat(150), 'b'];
    expect(tailWindowPhysical(rows, 102, 20)).toEqual({
      visible: rows,
      hiddenRows: 0,
    });
  });

  it('caps a single over-long logical row by its wrapped tail', () => {
    const win = tailWindowPhysical(['head', 'x'.repeat(5000)], 102, 20);
    expect(win.visible).toEqual(['x'.repeat(20 * 100)]);
    // 1 + 50 physical rows total; the mega row's tail fills the budget.
    expect(win.hiddenRows).toBe(31);
  });

  it('keeps the last whole rows whose height fits', () => {
    const rows = Array.from(
      { length: 15 },
      (_, i) => `${i % 10}`.repeat(150), // 2 physical rows each at 100 cols
    );
    const win = tailWindowPhysical(rows, 102, 20);
    expect(win.visible).toHaveLength(10);
    expect(win.visible[0]).toBe('5'.repeat(150));
    expect(win.visible[9]).toBe('4'.repeat(150));
    expect(win.hiddenRows).toBe(10);
  });

  it('keeps wide-character tails within the display-column budget', () => {
    const win = tailWindowPhysical(['汉'.repeat(1200)], 102, 20);
    expect(toCodePoints(win.visible[0])).toHaveLength(1000);
    expect(win.hiddenRows).toBe(4);
  });

  it('truncates over-long results to the trailing characters', () => {
    const short = 'short output';
    expect(truncateResultDisplayChars(short)).toBe(short);
    const long = 'x'.repeat(MAX_RESULT_DISPLAY_CHARACTERS + 10);
    const truncated = truncateResultDisplayChars(long);
    expect(truncated.length).toBe(MAX_RESULT_DISPLAY_CHARACTERS + 3);
    expect(truncated.startsWith('...')).toBe(true);
  });
});

describe('capToolCardDescription (transcript card flood bound)', () => {
  it('leaves a description that fits the card budget untouched', () => {
    const desc = 'Save this exact content to the bound memory?';
    expect(
      capToolCardDescription(
        desc,
        'mcp__mem0',
        110,
        TOOL_CARD_DESCRIPTION_ROWS,
      ),
    ).toEqual({ description: desc, hiddenRows: 0 });
  });

  it('keeps the head of an over-long description and counts the hidden rows', () => {
    const desc = 'x'.repeat(1000);
    const cols = 110 - STATUS_INDICATOR_WIDTH;
    const cap = capToolCardDescription(
      desc,
      'mcp__mem0',
      110,
      TOOL_CARD_DESCRIPTION_ROWS,
    );
    // The label row shares the budget: 4 description rows, the first one
    // hosting the name inline.
    const rows = Math.ceil(('mcp__mem0'.length + 1 + desc.length) / cols);
    expect(cap.description).toBe('x'.repeat(4 * cols - 'mcp__mem0'.length - 1));
    expect(cap.hiddenRows).toBe(rows - 4);
    expect(cap.hiddenRows).toBeGreaterThan(0);
  });

  it('measures wide-character descriptions in display columns', () => {
    // 1000 Han characters span 2000 columns: 19 rows at 108 cols, not the
    // 10 rows a UTF-16 length estimate would model.
    const cap = capToolCardDescription(
      '汉'.repeat(1000),
      'mcp__mem0',
      110,
      TOOL_CARD_DESCRIPTION_ROWS,
    );
    expect(toCodePoints(cap.description)).toHaveLength(211);
    expect(cap.hiddenRows).toBe(15);
  });
});

describe('message meta (ink glyph/color parity)', () => {
  it('keeps the user/assistant prefixes', () => {
    expect(userMessageMeta().glyph).toBe('>');
    expect(assistantMessageMeta().glyph).toBe('◆');
  });

  it('keeps the thinking collapse hint semantics', () => {
    const live = thinkingMeta(false, false, true);
    expect(live.icon).toBe('∵');
    expect(live.collapsed).toBe(false);
    const collapsed = thinkingMeta(true, false, true);
    expect(collapsed.icon).toBe('∴');
    expect(collapsed.hint).toContain('ctrl+o');
  });

  it('marks canceled tools for strikethrough', () => {
    const item = {
      kind: 'tool',
      id: 't',
      tool: 'run_shell_command',
      title: 'run_shell_command',
      output: '',
      done: true,
      success: false,
      summary: 'canceled',
    } as unknown as LiveToolItem;
    expect(toolStatusMeta(item).strikethrough).toBe(true);
  });

  it('marks the producers. two-L cancelled spelling for strikethrough too (R2-4)', () => {
    // Both real producers (event adapter tool_call_response and the client
    // tool-run) emit 'cancelled'; the CANCELED glyph must not fall through
    // to the red ERROR glyph for them.
    const item = {
      kind: 'tool',
      id: 't',
      tool: 'run_shell_command',
      title: 'run_shell_command',
      output: '',
      done: true,
      success: false,
      summary: 'cancelled',
    } as unknown as LiveToolItem;
    const meta = toolStatusMeta(item);
    expect(meta.strikethrough).toBe(true);
    expect(meta.glyph).toBe(TOOL_STATUS.CANCELED);
    expect(meta.color).not.toBe(C.red);
  });
});

describe('truncateTokenLine (ink wrap="truncate" parity)', () => {
  it('keeps tokens that fit the width budget unchanged', () => {
    const line = [ansiToken('ab'), ansiToken('cd')];
    expect(truncateTokenLine(line, 10)).toEqual(line);
  });

  it('hard-truncates mid-token with no ellipsis', () => {
    const line = [ansiToken('abcdef', 'red'), ansiToken('gh')];
    const out = truncateTokenLine(line, 4);
    expect(out).toEqual([{ ...ansiToken('abcd', 'red') }]);
  });

  it('stops at the first token that exceeds the budget', () => {
    const line = [ansiToken('ab'), ansiToken('cdef'), ansiToken('gh')];
    expect(truncateTokenLine(line, 4)).toEqual([
      ansiToken('ab'),
      ansiToken('cd'),
    ]);
  });

  it('returns an empty line for non-positive budgets', () => {
    expect(truncateTokenLine([ansiToken('ab')], 0)).toEqual([]);
    expect(truncateTokenLine([ansiToken('ab')], -1)).toEqual([]);
  });

  it('never splits a wide glyph in half', () => {
    const line = [ansiToken('你你你')];
    const out = truncateTokenLine(line, 4);
    expect(out).toEqual([ansiToken('你你')]);
  });
});
