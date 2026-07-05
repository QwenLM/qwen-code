/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import stripAnsi from 'strip-ansi';
import { MarkdownDisplay } from './MarkdownDisplay.js';
import { LoadedSettings } from '../../config/settings.js';
import { renderWithProviders } from '../../test-utils/render.js';
import { renderMermaidVisual } from './mermaidVisualRenderer.js';
import { RenderModeProvider } from '../contexts/RenderModeContext.js';

describe('<MarkdownDisplay />', () => {
  const baseProps = {
    isPending: false,
    contentWidth: 80,
    availableTerminalHeight: 40,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing for empty text', () => {
    const { lastFrame } = renderWithProviders(
      <MarkdownDisplay {...baseProps} text="" />,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('renders a simple paragraph', () => {
    const text = 'Hello, world.';
    const { lastFrame } = renderWithProviders(
      <MarkdownDisplay {...baseProps} text={text} />,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  const lineEndings = [
    { name: 'Windows', eol: '\r\n' },
    { name: 'Unix', eol: '\n' },
  ];

  describe.each(lineEndings)('with $name line endings', ({ eol }) => {
    it('renders headers with correct levels', () => {
      const text = `
# Header 1
## Header 2
### Header 3
#### Header 4
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      expect(lastFrame()).toMatchSnapshot();
    });

    it('renders a fenced code block with a language', () => {
      const text = '```javascript\nconst x = 1;\nconsole.log(x);\n```'.replace(
        /\n/g,
        eol,
      );
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      expect(lastFrame()).toMatchSnapshot();
    });

    it('renders a fenced code block without a language', () => {
      const text = '```\nplain text\n```'.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      expect(lastFrame()).toMatchSnapshot();
    });

    it('handles unclosed (pending) code blocks', () => {
      const text = '```typescript\nlet y = 2;'.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} isPending={true} />,
      );
      expect(lastFrame()).toMatchSnapshot();
    });

    it('clips a long pending message to availableTerminalHeight', () => {
      // A long streaming message must NOT render all its lines: the live
      // (non-<Static>) frame would exceed the terminal height and ink would
      // clearTerminal + re-stream the whole transcript on every token (the
      // top→bottom "scroll replay" seen on tab-switch in multiplexers). The
      // pending markdown is clipped to availableTerminalHeight.
      const text = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join(
        eol,
      );
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay
          {...baseProps}
          text={text}
          isPending={true}
          availableTerminalHeight={10}
        />,
      );
      const output = lastFrame() ?? '';
      // Clipped to budget: head lines present, tail dropped. No "generating more"
      // cue — incremental scrollback commit (PR #6170) streams content in
      // real-time, so clipped content is "still streaming" not "delayed output".
      expect(output).toContain('line 1');
      expect(output).toContain('line 2');
      // The tail is dropped (budget exceeded), so a late line is absent.
      expect(output).not.toContain('line 60');
      const lineCount = output.split('\n').length;
      expect(lineCount).toBeLessThanOrEqual(10);
    });

    it('does not pad a short pending message up to availableTerminalHeight', () => {
      // The clip must activate only when content exceeds the budget —
      // a short pending message renders at its natural height, no blank rows.
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay
          {...baseProps}
          text="just one short line"
          isPending={true}
          availableTerminalHeight={20}
        />,
      );
      const output = (lastFrame() ?? '').replace(/\n+$/, '');
      expect(output).toContain('just one short line');
      // Not clipped → no "generating more" cue (a bug that always appends it
      // would fail here).
      expect(output).not.toContain('generating more');
      const lineCount = output.split('\n').length;
      expect(lineCount).toBeLessThan(20);
    });

    it('does not clip a long committed (non-pending) message', () => {
      // The clip is gated on isPending: committed messages live in <Static> and
      // must render in full. Guards against accidentally dropping the isPending
      // check (which would silently truncate scrollback).
      const text = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join(
        eol,
      );
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay
          {...baseProps}
          text={text}
          isPending={false}
          availableTerminalHeight={10}
        />,
      );
      expect(lastFrame() ?? '').toContain('line 60');
    });

    it('handles a code fence spanning the clip boundary', () => {
      // The head-slice can cut between an opening fence and its close; the
      // parser's EOF inCodeBlock flush then renders the (unclosed) block. The
      // frame must still stay within the budget.
      const text = [
        'intro line',
        '',
        '```ts',
        ...Array.from({ length: 50 }, (_, i) => `code ${i}`),
        '```',
      ].join(eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay
          {...baseProps}
          text={text}
          isPending={true}
          availableTerminalHeight={10}
        />,
      );
      const output = lastFrame() ?? '';
      expect(output.split('\n').length).toBeLessThanOrEqual(10);
      // No "generating more" cue — all cues removed (PR #6170 incremental commit
      // handles real-time streaming).
      expect(output.match(/generating more/g) ?? []).toHaveLength(0);
    });

    it('does not stack a double cue for a math block near the clip boundary', () => {
      // No "generating more" cue — all cues removed (PR #6170 incremental commit
      // handles real-time streaming).
      const text = [
        '$$',
        ...Array.from({ length: 40 }, (_, i) => `x_{${i}} +`),
        '$$',
      ].join(eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay
          {...baseProps}
          text={text}
          isPending={true}
          availableTerminalHeight={8}
        />,
      );
      const output = lastFrame() ?? '';
      expect(output.match(/generating more/g) ?? []).toHaveLength(0);
      expect(output.split('\n').length).toBeLessThanOrEqual(8);
    });

    it('does not clip a pending message when no height budget is given', () => {
      // The clip is gated on availableTerminalHeight !== undefined; without a
      // budget the full message renders (no clip, no cue).
      const text = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join(
        eol,
      );
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay
          {...baseProps}
          text={text}
          isPending={true}
          availableTerminalHeight={undefined}
        />,
      );
      const output = lastFrame() ?? '';
      expect(output).toContain('line 60');
      expect(output).not.toContain('generating more');
    });

    it('applies the minimum floor at a degenerate budget of 1', () => {
      // Math.max(MIN_PENDING_CONTENT_LINES, 1 - 2) = 1 (floored): keep one
      // content line, never 0 or negative. No "generating more" cue.
      const text = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join(
        eol,
      );
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay
          {...baseProps}
          text={text}
          isPending={true}
          availableTerminalHeight={1}
        />,
      );
      const output = lastFrame() ?? '';
      expect(output).toContain('line 1');
      expect(output).not.toContain('line 2');
      expect(output).not.toContain('generating more');
    });

    it('renders unordered lists with different markers', () => {
      const text = `
- item A
* item B
+ item C
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      expect(lastFrame()).toMatchSnapshot();
    });

    it('renders nested unordered lists', () => {
      const text = `
* Level 1
  * Level 2
    * Level 3
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      expect(lastFrame()).toMatchSnapshot();
    });

    it('renders ordered lists', () => {
      const text = `
1. First item
2. Second item
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      expect(lastFrame()).toMatchSnapshot();
    });

    it('renders horizontal rules', () => {
      const text = `
Hello
---
World
***
Test
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      expect(lastFrame()).toMatchSnapshot();
    });

    it('renders tables correctly', () => {
      const text = `
| Header 1 | Header 2 |
|----------|:--------:|
| Cell 1   | Cell 2   |
| Cell 3   | Cell 4   |
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      expect(lastFrame()).toMatchSnapshot();
    });

    it('handles a table at the end of the input', () => {
      const text = `
Some text before.
| A | B |
|---|
| 1 | 2 |`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      expect(lastFrame()).toMatchSnapshot();
    });

    it('holds back an unterminated trailing table row while streaming', () => {
      const text = `| A | B |
|---|---|
| one | two |
| three | fo`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} isPending={true} />,
      );
      const output = lastFrame() ?? '';
      // The completed row renders inside the table…
      expect(output).toContain('one');
      expect(output).toContain('two');
      // …but the still-typing frontier row is held back until its closing `|`,
      // so it never flips between a stray text line and a table row (the source
      // of per-token footer jitter).
      expect(output).not.toContain('three');
      expect(output).toContain('│');
    });

    it('holds back a frontier row that is closed but missing columns', () => {
      // `| four | five |` on a 3-column table is an intermediate state of
      // `| four | five | six |` still being typed: it matches the row regex but
      // has too few cells, so it must not render (and fill in cell by cell)
      // until every column has arrived.
      const text = `| A | B | C |
|---|---|---|
| one | two | three |
| four | five |`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} isPending={true} />,
      );
      const output = lastFrame() ?? '';
      expect(output).toContain('one');
      expect(output).toContain('three');
      expect(output).not.toContain('four');
    });

    it('renders the previously-held frontier row once it terminates', () => {
      const text = `| A | B |
|---|---|
| one | two |
| three | four |`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} isPending={true} />,
      );
      const output = lastFrame() ?? '';
      expect(output).toContain('three');
      expect(output).toContain('four');
    });

    it('holds back a partial first row, then pops the table in once it terminates', () => {
      // Header + separator present but the first data row is still being typed.
      // The partial row is held back and the table is not drawn yet, so there is
      // no header+separator with a stray partial line flashing beneath it.
      const partial = `| A | B |
|---|---|
| one | tw`.replace(/\n/g, eol);
      const { lastFrame: partialFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={partial} isPending={true} />,
      );
      expect(partialFrame() ?? '').not.toContain('one');

      // Once the row terminates, the table appears complete.
      const complete = `| A | B |
|---|---|
| one | two |`.replace(/\n/g, eol);
      const { lastFrame: completeFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={complete} isPending={true} />,
      );
      const out = completeFrame() ?? '';
      expect(out).toContain('one');
      expect(out).toContain('two');
    });

    it('keeps a streaming frontier table horizontal instead of the vertical list', () => {
      // A tall cell trips the vertical fallback, which would render the table as
      // a `label: value` list and then flip to a horizontal table once it
      // completes (a visible jump). The live streaming frontier table must stay
      // horizontal; the committed render may fall back to vertical.
      const tallCell = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ');
      const text = `| Col |
|---|
| ${tallCell} |`.replace(/\n/g, eol);

      const streaming =
        renderWithProviders(
          <MarkdownDisplay
            {...baseProps}
            text={text}
            isPending={true}
            contentWidth={60}
          />,
        ).lastFrame() ?? '';
      const committed =
        renderWithProviders(
          <MarkdownDisplay
            {...baseProps}
            text={text}
            isPending={false}
            contentWidth={60}
          />,
        ).lastFrame() ?? '';

      expect(stripAnsi(streaming)).toContain('┌');
      expect(stripAnsi(committed)).not.toContain('┌');
    });

    it('does not hold back a partial row in committed (non-pending) output', () => {
      const text = `| A | B |
|---|---|
| one | two |
| three | fo`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} isPending={false} />,
      );
      // Committed transcript is final, not a streaming frontier — render as-is.
      expect(lastFrame() ?? '').toContain('three');
    });

    it('still closes a streaming table when a non-pipe line follows', () => {
      const text = `| A | B |
|---|---|
| one | two |
Done.`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} isPending={true} />,
      );
      const output = lastFrame() ?? '';
      expect(output).toContain('one');
      expect(output).toContain('Done');
    });

    it('holds back a forming table header until its separator arrives', () => {
      // Header present but no separator yet — must not flash as raw `| a | b |`
      // text (streaming in char by char) before the table box appears.
      const text = `intro line
| Alpha | Beta |`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} isPending={true} />,
      );
      const output = lastFrame() ?? '';
      expect(output).toContain('intro line');
      expect(output).not.toContain('Alpha');
    });

    it('keeps holding the header while its separator is still being typed', () => {
      // A partial separator whose column count does not yet match the header is
      // not enough to recognize the table, so the header stays held.
      const text = `intro line
| Alpha | Beta |
|--`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} isPending={true} />,
      );
      expect((lastFrame() ?? '').includes('Alpha')).toBe(false);
    });

    it('renders the table once the separator matches the header columns', () => {
      const text = `| Alpha | Beta |
|---|---|
| 1 | 2 |`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} isPending={true} />,
      );
      const output = lastFrame() ?? '';
      expect(output).toContain('Alpha');
      expect(output).toContain('│'); // drawn as a table box, not raw text
    });

    it('draws the empty table box once recognized, before the first row completes', () => {
      // Header + separator recognized but the first row is still being typed:
      // show the header box immediately (empty body) rather than a long blank
      // while the first row streams (a stall in that window looked like a hang).
      const text = `| Alpha | Beta |
|---|---|
| 1`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} isPending={true} />,
      );
      const output = lastFrame() ?? '';
      expect(output).toContain('Alpha'); // header box drawn with zero rows
      expect(output).toContain('│');
    });

    it('does not hold back pipe lines inside a pending code block', () => {
      // A `|`-leading line that is fenced code-block content must still render.
      const text = '```\n| Alpha | Beta |'.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay
          {...baseProps}
          text={text}
          isPending={true}
          availableTerminalHeight={20}
        />,
      );
      expect(stripAnsi(lastFrame() ?? '')).toContain('Alpha');
    });

    it('renders a single-column table', () => {
      const text = `
| Name |
|---|
| Alice |
| Bob |
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      const output = lastFrame() ?? '';
      expect(output).toContain('Name');
      expect(output).toContain('Alice');
      expect(output).toContain('Bob');
      expect(output).toContain('┌');
      expect(output).toContain('└');
      expect(output).toMatchSnapshot();
    });

    it('renders a single-column table with center alignment', () => {
      const text = `
| Name |
|:---:|
| Alice |
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      expect(lastFrame()).toContain('Alice');
      expect(lastFrame()).toMatchSnapshot();
    });

    it('handles escaped pipes in table cells', () => {
      const text = `
| Name | Value |
|---|---|
| A \\| B | C |
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      const output = lastFrame() ?? '';
      expect(output).toContain('A | B');
      expect(output).toContain('C');
    });

    it('does not treat a lone table-like line as a table', () => {
      const text = `
| just text |
next line
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      const output = lastFrame() ?? '';
      expect(output).toContain('| just text |');
      expect(output).not.toContain('┌');
    });

    it('does not treat invalid separator as a table separator', () => {
      const text = `
| A | B |
| x | y |
| 1 | 2 |
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      const output = lastFrame() ?? '';
      expect(output).toContain('| A | B |');
      expect(output).not.toContain('┌');
    });

    it('does not treat separator with mismatched column count as a table', () => {
      const text = `
| A | B |
|---|
| 1 | 2 |
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      const output = lastFrame() ?? '';
      expect(output).toContain('| A | B |');
      expect(output).not.toContain('┌');
    });

    it('does not treat a horizontal rule after a pipe line as a table separator', () => {
      const text = `
| Header |
---
data
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      const output = lastFrame() ?? '';
      // `---` without any `|` is a horizontal rule, not a table separator
      expect(output).toContain('| Header |');
      expect(output).not.toContain('┌');
    });

    it('ends a table when a blank line appears', () => {
      const text = `
| A | B |
|---|---|
| 1 | 2 |

After
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      const output = lastFrame();
      expect(output).toContain('┌');
      expect(output).toContain('After');
    });

    it('does not treat separator-only text without header row as a table', () => {
      const text = `
|---|---|
plain
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      const output = lastFrame();
      expect(output).toContain('|---|---|');
      expect(output).not.toContain('┌');
    });

    it('does not crash on uneven escaped pipes near row edges', () => {
      const text = `
| A | B |
|---|---|
| \\| edge | ok |
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      expect(lastFrame()).toContain('| edge');
    });

    it('inserts a single space between paragraphs', () => {
      const text = `Paragraph 1.

Paragraph 2.`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      expect(lastFrame()).toMatchSnapshot();
    });

    it('correctly parses a mix of markdown elements', () => {
      const text = `
# Main Title

Here is a paragraph.

- List item 1
- List item 2

\`\`\`
some code
\`\`\`

Another paragraph.
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      expect(lastFrame()).toMatchSnapshot();
    });

    it('hides line numbers in code blocks when showLineNumbers is false', () => {
      const text = '```javascript\nconst x = 1;\n```'.replace(/\n/g, eol);
      const settings = new LoadedSettings(
        { path: '', settings: {}, originalSettings: {} },
        { path: '', settings: {}, originalSettings: {} },
        {
          path: '',
          settings: { ui: { showLineNumbers: false } },
          originalSettings: { ui: { showLineNumbers: false } },
        },
        { path: '', settings: {}, originalSettings: {} },
        true,
        new Set(),
      );

      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
        { settings },
      );
      expect(lastFrame()).toMatchSnapshot();
      expect(lastFrame()).not.toContain(' 1 ');
    });

    it('shows line numbers in code blocks by default', () => {
      const text = '```javascript\nconst x = 1;\n```'.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      expect(lastFrame()).toMatchSnapshot();
      expect(lastFrame()).toContain(' 1 ');
    });

    it('renders task list items with checkbox markers', () => {
      const text = `
- [x] Done
- [ ] Todo
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      const output = lastFrame();
      expect(output).toContain('✓ Done');
      expect(output).toContain('○ Todo');
    });

    it('keeps pipes inside markdown table code spans in the same cell', () => {
      const text = `
| Expr | Meaning |
|------|---------|
| \`a|b\` | code pipe |
| escaped\\|pipe | literal pipe |
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      const output = lastFrame();

      expect(output).toContain('a|b');
      expect(output).toContain('escaped|pipe');
      expect(output).toContain('code pipe');
      expect(output).toContain('literal pipe');
    });

    it('renders inline math inside markdown table cells', () => {
      const text = `
| Symbol | Meaning |
|--------|---------|
| $\\alpha$ | alpha |
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      const output = lastFrame();

      expect(output).toContain('α');
      expect(output).toContain('alpha');
      expect(output).not.toContain('$\\alpha$');
    });

    it('keeps pipes inside markdown table math spans in the same cell', () => {
      const text = `
| Expression | Meaning |
|------------|---------|
| $|x|$ | absolute value |
| $P(A|B)$ | conditional probability |
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      const output = lastFrame();

      expect(output).toContain('|x|');
      expect(output).toContain('P(A|B)');
      expect(output).toContain('absolute value');
      expect(output).toContain('conditional probability');
    });

    it('does not treat table dollar amounts as inline math', () => {
      const text = `
| Item | Price |
|------|-------|
| range | $5 and $10 later |
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );

      expect(lastFrame()).toContain('$5 and $10 later');
    });

    it('renders blockquotes as quoted text', () => {
      const text = '> Important **note**'.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      const output = lastFrame();
      expect(output).toContain('│');
      expect(output).toContain('Important note');
    });

    it('renders inline and block math with unicode substitutions', () => {
      const text = `
Inline math: $x^2 + \\alpha$

$$
\\sum_{i=1}^{n} x_i
$$
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      const output = lastFrame();
      expect(output).toContain('x² + α');
      expect(output).toContain('LaTeX block · source: /copy latex 1');
      expect(output).toContain('Σᵢ₌₁ⁿ xᵢ');
    });

    it('does not treat ordinary dollar amounts as inline math', () => {
      const text = 'The cost is $5 and $10 later.'.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );

      expect(lastFrame()).toContain('The cost is $5 and $10 later.');
    });

    it('renders mermaid flowcharts as a visual preview', () => {
      const text = `
\`\`\`mermaid
flowchart LR
  A[Client] --> B[API]
\`\`\`
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      const output = lastFrame();
      expect(output).toContain('Mermaid flowchart (LR)');
      expect(output).toContain('source: /copy mermaid 1');
      expect(output).toContain('Client');
      expect(output).toContain('API');
      expect(output).toContain('▶');
      expect(output).not.toContain('flowchart LR');
    });

    it('renders mermaid fences with info-string metadata as a visual preview', () => {
      const text = `
\`\`\`mermaid title="Flow"
flowchart LR
  A[Client] --> B[API]
\`\`\`
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      const output = lastFrame();
      expect(output).toContain('Mermaid flowchart (LR)');
      expect(output).toContain('source: /copy mermaid 1');
      expect(output).toContain('Client');
      expect(output).toContain('API');
      expect(output).not.toContain('flowchart LR');
    });

    it('labels mermaid source hints with language-specific numbering', () => {
      const text = `
\`\`\`ts
const before = true;
\`\`\`

\`\`\`mermaid
flowchart LR
  A[Client] --> B[API]
\`\`\`
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      const output = lastFrame();
      expect(output).toContain('source: /copy mermaid 1');
      expect(output).not.toContain('source: /copy code 2');
    });

    it('can render mermaid fences as source when raw mode is active', () => {
      const text = `
\`\`\`mermaid
flowchart LR
  A[Client] --> B[API]
\`\`\`
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <RenderModeProvider
          value={{
            renderMode: 'raw',
            setRenderMode: () => undefined,
          }}
        >
          <MarkdownDisplay {...baseProps} text={text} />
        </RenderModeProvider>,
      );
      const output = lastFrame();
      expect(output).toContain('flowchart LR');
      expect(output).toContain('A[Client] --> B[API]');
      expect(output).not.toContain('Mermaid flowchart');
    });

    it('keeps enhanced markdown blocks as markdown source in raw mode', () => {
      const text = `
| Name | Value |
|------|-------|
| Alpha | $x^2$ |

$$
\\alpha + \\beta
$$

- [x] Done
> Important
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <RenderModeProvider
          value={{
            renderMode: 'raw',
            setRenderMode: () => undefined,
          }}
        >
          <MarkdownDisplay {...baseProps} text={text} />
        </RenderModeProvider>,
      );

      const output = lastFrame();
      expect(output).toContain('| Name | Value |');
      expect(output).toContain('|------|-------|');
      expect(output).toContain('$x^2$');
      expect(output).toContain('$$');
      expect(output).toContain('\\alpha + \\beta');
      expect(output).toContain('- [x] Done');
      expect(output).toContain('> Important');
      expect(output).not.toContain('┌');
      expect(output).not.toContain('x²');
      expect(output).not.toContain('α + β');
      expect(output).not.toContain('✓ Done');
      expect(output).not.toContain('│ Important');
    });

    it('applies source copy offsets from previous assistant chunks', () => {
      const text = `
\`\`\`mermaid
sequenceDiagram
  A->>B: hello
\`\`\`

$$
\\gamma + \\delta
$$
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay
          {...baseProps}
          text={text}
          sourceCopyIndexOffsets={{
            codeBlockLanguageCounts: new Map([['mermaid', 1]]),
            mathBlockCount: 2,
          }}
        />,
      );

      const output = lastFrame();
      expect(output).toContain('source: /copy mermaid 2');
      expect(output).toContain('source: /copy latex 3');
    });

    it('reuses mermaid node labels when later edges reference node ids', () => {
      const text = `
\`\`\`mermaid
flowchart TD
  A[Developer writes code] --> B{Tests pass?}
  B -->|Yes| C[Create Pull Request]
  B -->|No| D[Fix failing tests]
\`\`\`
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      const output = lastFrame() ?? '';
      expect(output).toContain('Developer writes code');
      expect(output).toContain('Tests pass?');
      expect(output).toContain('Create Pull Request');
      expect(output).toContain('Fix failing tests');
      expect(output).toContain('Yes');
      expect(output).toContain('No');
      expect(output).toContain('▼');
      expect(output.match(/Tests pass\?/g)?.length).toBe(1);
      expect(output.match(/Create Pull Request/g)?.length).toBe(1);
      expect(output.match(/Fix failing tests/g)?.length).toBe(1);
      expect(output).not.toContain('│ B ');
    });

    it('does not duplicate branch nodes when a mermaid flowchart loops back', () => {
      const text = `
\`\`\`mermaid
flowchart TD
  A[Start] --> B{Is it working?}
  B -->|Yes| C[Great!]
  B -->|No| D[Debug]
  D --> B
\`\`\`
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      const output = lastFrame() ?? '';
      expect(output).toContain('No');
      expect(output).toContain('Debug');
      expect(output).toContain('↩');
      expect(output).toContain('Cycles:');
      expect(output).toContain('Debug ↩ to Is it working?');
      expect(output.match(/│ Debug │/g)?.length).toBe(1);
    });

    it('resizes mermaid flowchart wireframes to the available width', () => {
      const source = `
flowchart TD
  A[Start] --> B{Is it working?}
  B -->|Yes| C[Great!]
  B -->|No| D[Debug]
  D --> B
`;
      const narrow = renderMermaidVisual(source, 44).lines;
      const wide = renderMermaidVisual(source, 72).lines;
      const narrowOutput = narrow.join('\n');
      const wideOutput = wide.join('\n');

      expect(narrowOutput).toContain('◇ Is it working? ◇');
      expect(narrowOutput).toContain('↩');
      expect(narrowOutput).toContain('Cycles:');
      expect(narrow.every((line) => line.length <= 44)).toBe(true);
      expect(wide.every((line) => line.length <= 72)).toBe(true);
      expect(wideOutput).not.toBe(narrowOutput);
    });

    it('bounds large mermaid flowchart previews before layout', () => {
      const source = [
        'flowchart TD',
        ...Array.from({ length: 200 }, (_, index) => {
          const next = index + 1;
          return `N${index}[Node ${index}] --> N${next}[Node ${next}]`;
        }),
      ].join('\n');

      const preview = renderMermaidVisual(source, 80);

      expect(preview.warning).toContain('Preview limited');
      expect(preview.lines.length).toBeLessThanOrEqual(80);
    });

    it('renders mermaid sequence diagrams as a visual preview', () => {
      const text = `
\`\`\`mermaid
sequenceDiagram
  participant U as User
  participant A as API
  U->>A: request
\`\`\`
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      const output = lastFrame();
      expect(output).toContain('Mermaid sequence diagram');
      expect(output).toContain('Participants: User | API');
      expect(output).toContain('User → API: request');
      expect(output).not.toContain('sequenceDiagram');
    });

    it('renders common non-flowchart mermaid diagrams as readable previews', () => {
      const classPreview = renderMermaidVisual(
        `
classDiagram
  Animal <|-- Duck
  Animal: +int age
  Duck: +swim()
`,
        80,
      );
      const erPreview = renderMermaidVisual(
        `
erDiagram
  CUSTOMER ||--o{ ORDER : places
  CUSTOMER {
    string name
  }
`,
        80,
      );
      const piePreview = renderMermaidVisual(
        `
pie title Pets
  "Dogs" : 40
  "Cats" : 60
`,
        80,
      );

      expect(classPreview.title).toBe('Mermaid class diagram');
      expect(classPreview.lines.join('\n')).toContain('Animal');
      expect(classPreview.lines.join('\n')).toContain('Duck');
      expect(erPreview.title).toBe('Mermaid ER diagram');
      expect(erPreview.lines.join('\n')).toContain('CUSTOMER');
      expect(erPreview.lines.join('\n')).toContain('ORDER');
      expect(piePreview.title).toBe('Mermaid pie chart');
      expect(piePreview.lines.join('\n')).toContain('Dogs');
      expect(piePreview.lines.join('\n')).toContain('Cats');
    });

    it('renders additional basic mermaid diagram families as readable previews', () => {
      const statePreview = renderMermaidVisual(
        `
stateDiagram-v2
  [*] --> Idle
  Idle --> Running : start
`,
        80,
      );
      const ganttPreview = renderMermaidVisual(
        `
gantt
  title Release
  section Build
  Bundle :done, 2026-01-01, 1d
`,
        80,
      );
      const journeyPreview = renderMermaidVisual(
        `
journey
  title Signup
  section Start
  Open app: 5: User
`,
        80,
      );
      const mindmapPreview = renderMermaidVisual(
        `
mindmap
  Root
    Child
`,
        80,
      );
      const gitPreview = renderMermaidVisual(
        `
gitGraph
  commit
  branch feature
`,
        80,
      );
      const requirementPreview = renderMermaidVisual(
        `
requirementDiagram
  requirement login {
    id: 1
  }
`,
        80,
      );

      expect(statePreview.title).toBe('Mermaid state diagram');
      expect(statePreview.lines.join('\n')).toContain('Idle → Running');
      expect(ganttPreview.title).toBe('Mermaid gantt chart');
      expect(ganttPreview.lines.join('\n')).toContain('Bundle');
      expect(journeyPreview.title).toBe('Mermaid journey diagram');
      expect(journeyPreview.lines.join('\n')).toContain('Open app');
      expect(mindmapPreview.title).toBe('Mermaid mindmap');
      expect(mindmapPreview.lines.join('\n')).toContain('Child');
      expect(gitPreview.title).toBe('Mermaid git graph');
      expect(gitPreview.lines.join('\n')).toContain('branch feature');
      expect(requirementPreview.title).toBe('Mermaid requirement diagram');
      expect(requirementPreview.lines.join('\n')).toContain('id: 1');
    });

    it('falls back to mermaid source for unsupported diagrams', () => {
      const text = `
\`\`\`mermaid
timeline
  title History
  2024 : Start
\`\`\`
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      const output = lastFrame() ?? '';

      expect(output).toContain('Mermaid source (timeline)');
      expect(output).toContain('```mermaid');
      expect(output).toContain('timeline');
      expect(output).toContain('2024 : Start');
      expect(output).not.toContain('Visual preview unavailable');
    });

    it('falls back to mermaid source when a known diagram cannot be previewed', () => {
      const preview = renderMermaidVisual(
        `
stateDiagram-v2
  note right of StillReadable
    Notes are not parsed by the text preview yet.
  end note
`,
        80,
      );
      const output = preview.lines.join('\n');

      expect(preview.title).toBe('Mermaid source (stateDiagram)');
      expect(output).toContain('```mermaid');
      expect(output).toContain('stateDiagram-v2');
      expect(output).toContain('Notes are not parsed');
      expect(output).not.toContain('No previewable');
    });

    it('does not leave mermaid image rendering placeholders in finalized output', () => {
      const text = `
\`\`\`mermaid
flowchart TD
  A[Start] --> B[End]
\`\`\`
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} isPending={false} />,
      );
      const output = lastFrame() ?? '';

      expect(output).not.toContain('Rendering Mermaid image');
      expect(output).not.toContain('Image rendering unavailable');
      expect(output).toContain('Start');
      expect(output).toContain('End');
    });

    it('does not fully render mermaid diagrams while the code block is pending', () => {
      const text = `
\`\`\`mermaid
flowchart TD
  A[Start] --> B[End]
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} isPending={true} />,
      );
      const output = lastFrame() ?? '';

      expect(output).toContain('Mermaid diagram is being written');
      expect(output).not.toContain('Mermaid flowchart');
    });
  });

  it('correctly splits lines using \\n regardless of platform EOL', () => {
    // Test that the component uses \n for splitting, not EOL
    const textWithUnixLineEndings = 'Line 1\nLine 2\nLine 3';

    const { lastFrame } = renderWithProviders(
      <MarkdownDisplay {...baseProps} text={textWithUnixLineEndings} />,
    );

    const output = lastFrame();
    expect(output).toContain('Line 1');
    expect(output).toContain('Line 2');
    expect(output).toContain('Line 3');
    expect(output).toMatchSnapshot();
  });

  describe('pending render-height safety net', () => {
    const tableText = [
      '| A | B |',
      '| --- | --- |',
      '| 1 | one |',
      '| 2 | two |',
    ].join('\n');

    it('draws a streaming table live (no placeholder) when it fits the viewport', () => {
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={tableText} isPending={true} />,
      );
      const output = lastFrame() ?? '';
      expect(output).not.toContain('generating table');
      expect(output).toContain('┌'); // real table drawn while streaming
      expect(output).toContain('one');
    });

    it('clamps a tall streaming table to the viewport instead of locking', () => {
      const rows = Array.from({ length: 30 }, (_, i) => `| r${i} | v${i} |`);
      const text = ['| A | B |', '| --- | --- |', ...rows].join('\n');
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay
          {...baseProps}
          text={text}
          isPending={true}
          availableTerminalHeight={10}
        />,
      );
      const output = (lastFrame() ?? '').replace(/\n+$/, '');
      expect(output.split('\n').length).toBeLessThanOrEqual(10);
    });

    it('renders a completed (closed) table in full even while pending', () => {
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay
          {...baseProps}
          text={`${tableText}\n\nDone.`}
          isPending={true}
        />,
      );
      const output = lastFrame() ?? '';
      expect(output).not.toContain('generating table');
      expect(output).toContain('┌');
      expect(output).toContain('one');
      expect(output).toContain('Done.');
    });

    it('keeps a completed table + trailing text within the viewport (no overflow)', () => {
      const rows = Array.from({ length: 8 }, (_, i) => `| r${i} | v${i} |`);
      const text = [
        '| A | B |',
        '| --- | --- |',
        ...rows,
        '',
        'Conclusion.',
      ].join('\n');
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay
          {...baseProps}
          text={text}
          isPending={true}
          availableTerminalHeight={12}
        />,
      );
      const output = (lastFrame() ?? '').replace(/\n+$/, '');
      expect(output.split('\n').length).toBeLessThanOrEqual(12);
    });

    it('counts wide/CJK wrapping so a pending block stays within the viewport', () => {
      const wide = '一二三四五六七八九十'.repeat(6); // ~120 display cols
      const text = Array.from({ length: 20 }, () => wide).join('\n');
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay
          {...baseProps}
          text={text}
          isPending={true}
          contentWidth={20}
          availableTerminalHeight={10}
        />,
      );
      const output = (lastFrame() ?? '').replace(/\n+$/, '');
      expect(output.split('\n').length).toBeLessThanOrEqual(10);
    });
  });
});
