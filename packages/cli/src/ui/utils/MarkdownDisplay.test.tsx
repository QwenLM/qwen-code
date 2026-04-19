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

  it('renders inline math without rewriting non-math dollar text', () => {
    const text = 'Energy $E = mc^2$ costs $20 and $30.';
    const { lastFrame } = renderWithProviders(
      <MarkdownDisplay {...baseProps} text={text} />,
    );
    const output = lastFrame();
    expect(output).toContain('Energy E = mc² costs $20 and $30.');
  });

  it('renders block math with terminal layout', () => {
    const text = '$$\n\\frac{a+b}{c+d}\n$$';
    const { lastFrame } = renderWithProviders(
      <MarkdownDisplay {...baseProps} text={text} />,
    );
    const output = lastFrame();
    expect(output).toContain('a+b');
    expect(output).toContain('───');
    expect(output).toContain('c+d');
  });

  it('does not render math inside fenced code blocks', () => {
    const text = '```latex\n$E = mc^2$\n```';
    const { lastFrame } = renderWithProviders(
      <MarkdownDisplay {...baseProps} text={text} />,
    );
    expect(lastFrame()).toContain('$E = mc^2$');
  });

  it('handles manual math verification text with an unclosed code fence', () => {
    const text = [
      '> Please output the following markdown exactly:',
      '',
      'Inline: $E = mc^2$, $\\alpha + \\beta \\leq \\gamma$',
      '',
      '$$',
      '\\frac{\\partial_t u}{\\Delta u + \\xi}',
      '$$',
      '',
      '$$',
      '\\begin{cases}',
      'x^2 & x \\geq 0 \\\\',
      '-x & x < 0',
      '\\end{cases}',
      '$$',
      '',
      '```latex',
      '$E = mc^2$',
      '',
      'Also keep this non-math text unchanged: price is $20 and shell variable is $PATH.',
    ].join('\n');
    const { lastFrame } = renderWithProviders(
      <MarkdownDisplay {...baseProps} text={text} isPending={true} />,
    );
    const output = lastFrame();
    expect(output).toContain('Inline: E = mc², α + β ≤ γ');
    expect(output).toContain('$E = mc^2$');
    expect(output).toContain('price is $20');
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
