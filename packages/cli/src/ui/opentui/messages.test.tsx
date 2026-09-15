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
  physicalRowsTotal,
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
import { getCachedStringWidth, toCodePoints } from '../utils/textUtils.js';
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

  it('detabs TAB to the two columns the renderer advances it (R11-2)', () => {
    // The cap slices this same string by display width while the painted
    // card row advances TAB 2 columns — the detab must live in the text
    // itself or the slice and the painted row disagree.
    expect(toolCardText('a\tb')).toBe('a  b');
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
    // (mem0 e2e regression). The collapsed bound prices the region above
    // the card plus the dialog chrome (the 26-row reserve) plus the
    // collapsed body, converted to budget rows by the 0.7 wrap ratio — a
    // budget row renders ~1/0.7 physical rows, so spending physical rows
    // directly as budget rows over-budgets the card by ~1.37x.
    expect(maxHistoryItemRows(80)).toBe(320);
    // No payload, unknown dialog: the collapsed-dialog bound charges the
    // full collapsed body window — (80 - 26 - 20) * 0.7 = 23.
    expect(pendingCardMaxRows(80, 0, 110)).toBe(23);
    expect(pendingCardMaxRows(100, 0, 110)).toBe(37);
    // A ~3.9k-char payload wraps to ~37 dialog rows at 110 columns; the
    // expanded-dialog bound leaves (80 - 26 - 37) * 0.7 = 11 card rows.
    expect(pendingCardMaxRows(80, 3900, 110)).toBe(11);
    // Boundary: the expanded-payload bound meets the collapsed price at the
    // 20-row collapsed window and binds tighter past it. At h=80 the two
    // coincide; h=81 separates them — a 20-row payload prices
    // (81-26-20)*0.7 = 24 while a 21-row payload drops to
    // (81-26-21)*0.7 = 23. (2160/2268 are exact multiples of the
    // 110-2=108-column divisor.)
    expect(pendingCardMaxRows(81, 2160, 110)).toBe(24);
    expect(pendingCardMaxRows(81, 2268, 110)).toBe(23);
    // A mid-range payload inside the collapsed window keeps the
    // collapsed-dialog budget even on tall terminals (the PR's
    // small-payload claim).
    expect(pendingCardMaxRows(100, 1080, 110)).toBe(37);
    // An mcp dialog shows two fixed lines and cannot expand: the card is the
    // only surface carrying the arguments (R5-9), so it keeps the
    // collapsed-footprint budget no matter how wide the args payload is.
    // The region converts at the card's own wrap ratio: an mcp card renders
    // its raw mcp__server__tool name (42 columns here), so a budget row
    // buys 66 of the 108 wrap columns and the bound is
    // (80 - 26 - 5) * 66/108 = 29.
    const mcpNameCols = 'mcp__github_enterprise__create_repository'.length + 1;
    expect(
      pendingCardMaxRows(80, 3900, 110, { type: 'mcp' }, 1, mcpNameCols),
    ).toBe(29);
    // ...but N pending siblings share the transcript region: two parked mcp
    // calls halve the collapsed bound after charging the second card's
    // hidden-tail and awaiting rows ((80 - 26 - 5 - 2) * 66/108 / 2 = 14),
    // so two 45-row cards cannot push the first call's dialog off an 80-row
    // alt screen.
    expect(
      pendingCardMaxRows(80, 3900, 110, { type: 'mcp' }, 2, mcpNameCols),
    ).toBe(14);
    // A hook-bounced info confirmation whose reason exactly fills the
    // collapsed window prices the collapsed dialog's real 20-row body
    // ((80 - 26 - 20) * 0.7 = 23); an unconverted physical-row term would
    // hand back 34 budget rows, which paint ~45 physical rows and push the
    // dialog's question row and outcome list off the viewport.
    const hookReason = Array.from({ length: 20 }, () => 'x'.repeat(10)).join(
      '\n',
    );
    expect(
      pendingCardMaxRows(80, 3900, 110, { type: 'info', body: hookReason }),
    ).toBe(23);
    // A many-short-line body folds to ~3 card rows but fills 25 dialog rows:
    // the expandable TextBody charges each logical row, so the card yields
    // ((80-26-25)*0.7 = 20) even though the folded width sits under the
    // gate. An info body measures identically.
    const planBody = Array.from({ length: 25 }, () => 'x'.repeat(10)).join(
      '\n',
    );
    expect(
      pendingCardMaxRows(80, 259, 110, { type: 'plan', body: planBody }),
    ).toBe(20);
    expect(
      pendingCardMaxRows(80, 259, 110, { type: 'info', body: planBody }),
    ).toBe(20);
    // The body measure is taken on the dialog's own column basis — the
    // terminal width minus the frame's 4 columns of border and padding,
    // which start-opentui-ui's availableWidth = width - 4 makes width
    // itself: 12 lines of 106 columns are 12 collapsed rows there (no
    // ctrl-s offered), so both bounds coincide at ((80 - 26 - 12) * 0.7 =
    // 29). On the card's narrower 104-column basis the same body would
    // miscount 24 rows and wrongly bind the expanded bound.
    const dialogFits = Array.from({ length: 12 }, () => 'x'.repeat(106)).join(
      '\n',
    );
    expect(
      pendingCardMaxRows(80, 0, 106, { type: 'plan', body: dialogFits }),
    ).toBe(29);
    // The band just past the dialog's content width: a 107-column line
    // paints 2 rows at the dialog's 106 columns, so 12 lines charge a
    // 24-row body and the expanded bound binds — (80 - 26 - 24) * 0.7 = 21.
    // A measure priced 2 columns wider than the painted surface charges 12
    // rows and hands back 29.
    const bandBody = Array.from({ length: 12 }, () => 'x'.repeat(107)).join(
      '\n',
    );
    expect(
      pendingCardMaxRows(80, 0, 106, { type: 'plan', body: bandBody }),
    ).toBe(21);
    // The renderer advances TAB exactly 2 columns while string widths count
    // it as 0, so the measure detabs before counting: 20 lines of
    // TAB + 105 columns are 107-column lines — 2 rows each at the dialog's
    // 106 columns, a 40-row body ((80 - 26 - 40) * 0.7 = 9) — priced
    // identically to their detabbed selves.
    const tabbed = Array.from(
      { length: 20 },
      () => '\t' + 'x'.repeat(105),
    ).join('\n');
    const detabbed = Array.from(
      { length: 20 },
      () => '  ' + 'x'.repeat(105),
    ).join('\n');
    expect(pendingCardMaxRows(80, 0, 106, { type: 'info', body: tabbed })).toBe(
      9,
    );
    expect(pendingCardMaxRows(80, 0, 106, { type: 'info', body: tabbed })).toBe(
      pendingCardMaxRows(80, 0, 106, { type: 'info', body: detabbed }),
    );
    // The body measure keeps the same collapsed-window boundary: a 20-row
    // body fits the window and both bounds coincide ((81-26-20)*0.7 = 24);
    // a 21-row body overflows and the expanded bound binds tighter
    // ((81-26-21)*0.7 = 23).
    const fits = Array.from({ length: 20 }, () => 'x'.repeat(10)).join('\n');
    expect(pendingCardMaxRows(81, 0, 110, { type: 'plan', body: fits })).toBe(
      24,
    );
    expect(
      pendingCardMaxRows(81, 0, 110, { type: 'plan', body: fits + '\nx' }),
    ).toBe(23);
    // An exec confirmation whose command never arrived keeps the
    // folded-payload proxy, and so does any type this module does not know
    // — a future ToolCallConfirmationDetails variant or a version-skewed
    // wire event fails safe toward yielding, not toward keeping the full
    // budget.
    expect(pendingCardMaxRows(80, 3900, 110, { type: 'exec' })).toBe(11);
    expect(
      pendingCardMaxRows(80, 3900, 110, { type: 'some_future_type' }),
    ).toBe(11);
    // ...but when the command arrives as the dialog body it is measured
    // newline-aware: the exec dialog renders it in full with no collapsed
    // window, so a 42-line command is 42 body rows ((80-26-42)*0.7 = 8),
    // not the ~22 folded card rows the payload proxy would charge.
    const command = Array.from({ length: 42 }, () => 'x'.repeat(55)).join('\n');
    expect(
      pendingCardMaxRows(80, 2300, 110, { type: 'exec', body: command }),
    ).toBe(8);
    // Parked siblings share BOTH dialog bounds: with two pending cards the
    // expanded bound halves too — a 30-row info body prices
    // (80-26-30-2)*0.7/2 = 7 (the second card's chrome rows charged before
    // dividing), not the undivided 16.
    const sharedBody = Array.from({ length: 30 }, () => 'x'.repeat(10)).join(
      '\n',
    );
    expect(
      pendingCardMaxRows(80, 3900, 110, { type: 'info', body: sharedBody }, 2),
    ).toBe(7);
  });

  it("converts the shared region with the card's own name width (R6-1)", () => {
    // mcp cards never appear in TOOL_DISPLAY_BY_NAME, so they render the raw
    // mcp__<server>__<tool> name — the longest names of any arm. A budget
    // row buys only (cols - name) of the card's wrap columns: at a
    // 42-column name the fixed 0.7 ratio hands back 34 budget rows that
    // paint ~54 physical rows against the 49-row region, and the mounted
    // dialog's outcome list leaves the alt screen (the mem0 regression
    // shape). The name-aware conversion caps the budget at 29.
    const nameCols = 'mcp__github_enterprise__create_repository'.length + 1;
    const budget = pendingCardMaxRows(
      80,
      3900,
      110,
      { type: 'mcp' },
      1,
      nameCols,
    );
    expect(budget).toBeLessThanOrEqual(30);
    expect(budget).toBe(29);
    // A short display name keeps the measured 0.7 ceiling — the tightening
    // only bites names too wide for that ceiling to hold.
    expect(pendingCardMaxRows(80, 3900, 110, { type: 'mcp' }, 1, 6)).toBe(34);
  });

  it('charges the rows a dialog renders outside its body window (R4-1)', () => {
    // An info dialog's urls block (a margin row, a header row and one row
    // per URL) and an exec dialog's warnings render OUTSIDE the windowed
    // body, so they charge in addition to it: a 20-row prompt alone prices
    // (80 - 26 - 20) * 0.7 = 23, and the same prompt with a 3-row urls
    // block prices (80 - 26 - 23) * 0.7 = 21.
    const prompt = Array.from({ length: 20 }, () => 'x'.repeat(10)).join('\n');
    expect(pendingCardMaxRows(80, 0, 110, { type: 'info', body: prompt })).toBe(
      23,
    );
    expect(
      pendingCardMaxRows(80, 0, 110, {
        type: 'info',
        body: prompt,
        extra: '\nURLs to fetch:\n - https://example.com/x',
      }),
    ).toBe(21);
    // exec renders its command in full plus one row per warning:
    // (80 - 26 - 3) * 0.7 = 35; without the two warnings it would be 37.
    expect(
      pendingCardMaxRows(80, 0, 110, {
        type: 'exec',
        body: 'echo hi',
        extra: '⚠ one\n⚠ two',
      }),
    ).toBe(35);
  });

  it('charges the edit and ask_user_question rows painted outside the collapsed window (R7-1)', () => {
    // The edit dialog paints the fileName row and one row per warning ABOVE
    // its tail-windowed diff, so they charge in addition to the body. A
    // 3-row extra drops the fixed-body price from (80-26-20)*0.7 = 23 to
    // (80-26-23)*0.7 = 21 (the strict drop is the pin: both calls would
    // otherwise return the identical number).
    const extra = '⚠ a\n⚠ b\n⚠ c';
    expect(pendingCardMaxRows(80, 2000, 108, { type: 'edit' }, 1)).toBe(23);
    expect(pendingCardMaxRows(80, 2000, 108, { type: 'edit', extra }, 1)).toBe(
      21,
    );
    // The ask flow paints one question block at a time and ConfirmationBody
    // renders NO windowed body for it, so the block alone is the price:
    // (80-26-0)*0.7 = 37 without one, (80-26-3)*0.7 = 35 with a 3-row
    // block — charging it the collapsed 20-row window would shrink the card
    // by rows the dialog never paints (R10-1).
    expect(
      pendingCardMaxRows(80, 2000, 108, { type: 'ask_user_question' }, 1),
    ).toBe(37);
    expect(
      pendingCardMaxRows(
        80,
        2000,
        108,
        { type: 'ask_user_question', extra },
        1,
      ),
    ).toBe(35);
    // mcp renders no outside-window rows and its price must not move:
    // (80-26-5)*0.7 = 34 with or without the extra term wired.
    expect(pendingCardMaxRows(80, 2000, 108, { type: 'mcp' }, 1)).toBe(34);
  });

  it('prices an edit dialog body by the windowed diff’s painted rows (R10-1)', () => {
    // DiffBody tail-windows the diff's LOGICAL lines and those lines wrap:
    // 40 added 200-column lines keep 19 windowed lines that paint 38 rows
    // at the dialog's 106 columns (plus the hidden-lines label), not the
    // flat 20 the collapsed window charges sight-unseen — so the wrapping
    // diff must leave the card a strictly smaller budget than one whose
    // windowed lines each paint a single row.
    const wrapping =
      '@@ -0,0 +1,40 @@\n' +
      Array.from({ length: 40 }, () => '+' + 'x'.repeat(199)).join('\n');
    const fitting =
      '@@ -0,0 +1,20 @@\n' +
      Array.from({ length: 20 }, () => '+' + 'x'.repeat(60)).join('\n');
    const budget = (body: string) =>
      pendingCardMaxRows(80, 0, 106, { type: 'edit', body, extra: 'a.ts' }, 2);
    expect(budget(wrapping)).toBeLessThan(budget(fitting));
    // The exact pins: (80-26-40-2)*0.7/2 floors to 4 against
    // (80-26-21-2)*0.7/2 = 10.
    expect(budget(wrapping)).toBe(4);
    expect(budget(fitting)).toBe(10);
  });

  it('counts TAB at the two columns the renderer advances it (R11-2)', () => {
    // String widths count TAB as 0 columns, so a raw measure under-counts a
    // tabbed line: 60 TABs + 60 columns paint 180 columns — 2 rows at 108.
    expect(physicalRowsTotal(['\t'.repeat(60) + 'x'.repeat(60)], 108)).toBe(2);
  });

  it('keeps the sibling sum inside the shared region when the divided bound drops below the settled cap (R4-8, R4-1)', () => {
    // The settled 5-row floor must not lift the divided bound back up, and
    // each sibling past the first spends its hidden-tail and awaiting rows
    // (2 per card — the reserve charges one card's) from the region before
    // it is divided: at N=8, mcp dialogs priced at the raw 42-column name
    // (wrap ratio 66/108) floor((80-26-5-14)*(66/108)/8) = 2, and eight
    // cards paint 8*2*(108/66) + 14 ≈ 40.2 physical rows against the
    // 80-26-5 = 49-row region. A floor-lifted 5-row budget would paint
    // 8*5*(108/66) + 14 ≈ 79.5 — the mounted dialog leaves the alt screen.
    // The tall-body dialogs (collapsed body 20, short name, ratio 0.7)
    // cross one batch size earlier: floor((80-26-20-8)*0.7/5) = 3 and
    // 5*3/0.7 + 8 ≈ 29.4 <= 34, where 5*5/0.7 + 8 ≈ 43.7 would not.
    const mcpNameCols = 'mcp__github_enterprise__create_repository'.length + 1;
    const mcp = pendingCardMaxRows(
      80,
      3900,
      110,
      { type: 'mcp' },
      8,
      mcpNameCols,
    );
    expect(mcp).toBe(2);
    expect(
      (8 * mcp * 108) / (108 - mcpNameCols) + 2 * (8 - 1),
    ).toBeLessThanOrEqual(80 - 26 - 5);
    const tall = pendingCardMaxRows(80, 0, 110, undefined, 5);
    expect((5 * tall) / 0.7 + 2 * (5 - 1)).toBeLessThanOrEqual(80 - 26 - 20);
  });

  it('shrinks the pending budget as the transcript above the card grows (R2-2)', () => {
    // The reserve prices the region above the card at its FRESH-session
    // height (the ≈ 5 transcript rows of startup notices and the prompt
    // echo), so counts at or below it leave the price alone...
    expect(pendingCardMaxRows(80, 0, 110, undefined, 1, 0, 5)).toBe(23);
    expect(pendingCardMaxRows(80, 0, 110, undefined, 1, 0, 0)).toBe(23);
    // ...but a grown session paints more above the card, and those rows
    // spend from the same region: 25 painted rows charge the 20-row
    // overage, so the collapsed bound drops from (80-26-20)*0.7 = 23 to
    // (80-26-20-20)*0.7 = 9.
    expect(pendingCardMaxRows(80, 0, 110, undefined, 1, 0, 25)).toBe(9);
    // Both dialog bounds charge the overage: the fixed-body mcp arm goes
    // from (80-26-5)*0.7 = 34 to (80-26-5-20)*0.7 = 20, and parked
    // siblings divide what the overage leaves --
    // floor((80-26-5-20-2)*0.7/2) = 9.
    expect(pendingCardMaxRows(80, 3900, 110, { type: 'mcp' }, 1, 6, 25)).toBe(
      20,
    );
    expect(pendingCardMaxRows(80, 3900, 110, { type: 'mcp' }, 2, 6, 25)).toBe(
      9,
    );
    // A transcript that floods the viewport on its own drops siblings to
    // the one-row floor; a lone card keeps the settled-cap floor (the
    // short-terminal fallback) -- card yielding alone cannot repair a
    // transcript that already overruns the screen.
    expect(pendingCardMaxRows(80, 3900, 110, { type: 'mcp' }, 2, 6, 200)).toBe(
      1,
    );
    expect(pendingCardMaxRows(80, 3900, 110, { type: 'mcp' }, 1, 6, 200)).toBe(
      TOOL_CARD_DESCRIPTION_ROWS,
    );
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

  it('keeps a one-row budget to one painted row when the name fits (R11-1)', () => {
    // The one-row floor exists for a name that alone exhausts the row
    // (descRows * cols - nameCols <= 0); applied unconditionally it
    // overrides a positive slice and the card paints name + a full-row
    // description — 2 physical rows against a budget that certified 1. At
    // descRows = 1 the unconditional floor fired for every name width.
    const name = 'n'.repeat(40);
    const cap = capToolCardDescription('d'.repeat(300), name, 110, 1);
    expect(
      getCachedStringWidth(cap.description) + getCachedStringWidth(name) + 1,
    ).toBeLessThanOrEqual(110 - STATUS_INDICATOR_WIDTH);
  });
});

describe('message meta (ink glyph/color parity)', () => {
  // ink's ICON table appends U+FE0E to force the text presentation; the
  // selector is invisible in source, so it must not be stripped as a typo.
  it('keeps the user/assistant prefixes', () => {
    expect(userMessageMeta().glyph).toBe('>');
    expect(assistantMessageMeta().glyph).toBe('◆\uFE0E');
  });

  it('keeps the thinking collapse hint semantics', () => {
    const live = thinkingMeta(false, false, true);
    expect(live.icon).toBe('∵\uFE0E');
    expect(live.collapsed).toBe(false);
    const collapsed = thinkingMeta(true, false, true);
    expect(collapsed.icon).toBe('∴\uFE0E');
    expect(collapsed.hint).toContain('ctrl+o');
  });

  it('labels a committed thought with ink’s duration wording', () => {
    expect(thinkingMeta(true, false, false, 400).label).toBe('Thought briefly');
    expect(thinkingMeta(true, false, false, 12_000).label).toBe(
      'Thought for 12s',
    );
    expect(thinkingMeta(true, true, false, 12_000).label).toBe(
      'Thought for 12s',
    );
    // No duration stamped: ink falls back to the pending wording rather than
    // naming a time it never measured.
    expect(thinkingMeta(true, false, false).label).toBe('Thinking');
    // The duration is only stamped when the thought ends, so a live row never
    // carries one.
    expect(thinkingMeta(false, false, false, 12_000).label).toBe('Thinking…');
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
