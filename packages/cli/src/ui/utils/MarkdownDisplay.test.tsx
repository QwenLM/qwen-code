/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MarkdownDisplay } from './MarkdownDisplay.js';
import { LoadedSettings } from '../../config/settings.js';
import { renderWithProviders } from '../../test-utils/render.js';

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
      const output = lastFrame();
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
      const output = lastFrame();
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
      const output = lastFrame();
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
      const output = lastFrame();
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
      const output = lastFrame();
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
      const output = lastFrame();
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

    it('recognizes a table nested under a list-item bullet', () => {
      // Models sometimes emit tables prefixed by a bullet marker:
      //   `+ | ID | Name |`
      // ulItemRegex would otherwise swallow the line; this verifies the
      // bullet prefix does not prevent table detection.
      const text = `
+ | ID | Name |
|----|------|
| 001 | foo |
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      const output = lastFrame() ?? '';
      // Should render as a table (has border chars), not as a list item + raw text.
      expect(output).toContain('┌');
      expect(output).toContain('ID');
      expect(output).toContain('001');
      // No stray raw pipe lines, and no bullet + pipe content.
      expect(output).not.toContain('+ |');
    });

    it('buffers a partial in-progress row while streaming (no raw flicker)', () => {
      // Mid-stream: last line is a row being typed — starts with `|` but has
      // no closing `|` yet. Without the guard this would close the table and
      // render the partial row as raw text, flipping each chunk.
      const text = `
| A | B |
|---|---|
| 1 | 2 |
| 3 | x`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} isPending={true} text={text} />,
      );
      const output = lastFrame() ?? '';
      // The committed row is rendered.
      expect(output).toContain('1');
      expect(output).toContain('2');
      // The partial row must NOT be rendered as raw pipe text.
      expect(output).not.toMatch(/\|\s*3\s*\|\s*x\s*$/m);
    });

    it('flushes the partial row as text when streaming is complete', () => {
      // Same content but stream has ended — fall through to legacy behavior
      // so truly malformed tables don't silently drop data.
      const text = `
| A | B |
|---|---|
| 1 | 2 |
| 3 | x`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} isPending={false} text={text} />,
      );
      const output = lastFrame() ?? '';
      expect(output).toContain('3');
      expect(output).toContain('x');
    });

    it('renders a header-only skeleton while streaming with no data rows yet', () => {
      // Reproduces the mid-stream state where header + separator have arrived
      // but no data rows have been parsed yet. Before this fix the renderer
      // emitted nothing for that state, causing a height collapse between
      // "raw text" and "first row arrives" frames.
      const text = `
| ID | Name |
|----|------|
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay {...baseProps} isPending={true} text={text} />,
      );
      const output = lastFrame() ?? '';
      // Skeleton contains the header labels followed by a colon.
      expect(output).toContain('ID:');
      expect(output).toContain('Name:');
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
});
