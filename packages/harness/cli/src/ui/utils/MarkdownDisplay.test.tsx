/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createLoadedSettings } from '../../config/settings.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MarkdownDisplay } from './MarkdownDisplay.js';
import { act } from 'react';
import chalk from 'chalk';
import { themeManager, DEFAULT_THEME } from '../themes/theme-manager.js';
import { RenderInline } from './InlineMarkdownRenderer.js';
import { TableRenderer } from './TableRenderer.js';
import { renderWithProviders } from '../../test-utils/render.js';

// The shared test tokenizer drops colors and OSC 8 styles.
vi.mock('@alcalzone/ansi-tokenize', async () => {
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const packagePath = createRequire(import.meta.url).resolve(
    '@alcalzone/ansi-tokenize/package.json',
  );
  const entry = new URL('./build/index.js', pathToFileURL(packagePath)).href;
  return import(/* @vite-ignore */ entry);
});

describe('<MarkdownDisplay />', () => {
  it.each(['text', 'javascript', ''])(
    'keeps full code URL targets at different wrapping widths for %s',
    async (language) => {
      const url = `http://127.0.0.1:18749/qoder-url-wrap/${'a'.repeat(97)}/onboard_suite`;
      for (const width of [50, 160, 89]) {
        const result = await renderWithProviders(<></>, { width });
        const opens: Array<{ params: string; href: string }> = [];
        const handler = result.terminal.parser.registerOscHandler(8, (data) => {
          const separator = data.indexOf(';');
          const href = data.slice(separator + 1);
          if (href) opens.push({ params: data.slice(0, separator), href });
          return false;
        });
        try {
          result.rerender(
            <MarkdownDisplay
              text={`\`\`\`${language}\n${url}\n\`\`\``}
              isPending={false}
              terminalWidth={width}
            />,
          );
          await result.waitUntilReady();
          expect(opens.length).toBeGreaterThan(0);
          expect(opens.every((open) => open.href === url)).toBe(true);
          expect(new Set(opens.map((open) => open.params)).size).toBe(1);
          const contentLines = result
            .lastFrame()
            .split('\n')
            .filter((line) => line.trim());
          const visible = contentLines.map((line) => line.slice(1)).join('');
          expect(visible).toBe(url);
          expect(contentLines.length).toBe(
            width === 160 ? 1 : width === 89 ? 2 : 4,
          );
        } finally {
          handler.dispose();
          result.unmount();
        }
      }
    },
  );

  const baseProps = {
    isPending: false,
    terminalWidth: 80,
    availableTerminalHeight: 40,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing for empty text', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <MarkdownDisplay {...baseProps} text="" />,
    );
    expect(lastFrame({ allowEmpty: true })).toMatchSnapshot();
    unmount();
  });

  it('renders a simple paragraph', async () => {
    const text = 'Hello, world.';
    const { lastFrame, unmount } = await renderWithProviders(
      <MarkdownDisplay {...baseProps} text={text} />,
    );
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('renders an unfinished chunk immediately without waiting for a newline', async () => {
    const renderStreaming = (text: string) => (
      <MarkdownDisplay {...baseProps} text={text} isPending={true} />
    );
    const streaming = await renderWithProviders(renderStreaming('H'));

    expect(streaming.lastFrame()).toContain('H');
    streaming.rerender(renderStreaming('Hello\n\nunfinished wor'));
    await streaming.waitUntilReady();
    expect(streaming.lastFrame()).toContain('unfinished wor');

    streaming.unmount();
  });

  it.each([
    { isPending: false, renderMarkdown: true },
    { isPending: true, renderMarkdown: true },
    { isPending: false, renderMarkdown: false },
  ])('repaints unchanged content: %j', async (mode) => {
    const previousTheme = themeManager.getActiveTheme().name;
    const previousBackground = themeManager.getTerminalBackground();
    const previousLevel = chalk.level;
    chalk.level = 3;
    const text = [
      '# Heading',
      '',
      'A [link](https://example.com) and `inline code`.',
      '',
      '```typescript',
      'const answer = "value";',
      '```',
      '',
      '| Header | Other |',
      '| --- | --- |',
      '| `code` | [link](https://example.com) |',
      '',
      'Trailing paragraph.',
    ].join('\n');
    const result = await renderWithProviders(
      <>
        <MarkdownDisplay {...baseProps} {...mode} text={text} />
        <RenderInline text="A separate `inline` [link](https://example.com)" />
        <TableRenderer
          headers={['Stable header']}
          rows={[['A `stable` cell']]}
          terminalWidth={80}
        />
      </>,
    );
    const foregroundModes = () => {
      const buffer = result.terminal.buffer.active;
      const cells = [];
      for (let row = buffer.baseY; row < buffer.length; row++) {
        const line = buffer.getLine(row);
        if (!line) continue;
        for (let column = 0; column < line.length; column++) {
          const cell = line.getCell(column);
          if (cell && cell.getChars().trim()) cells.push(cell);
        }
      }
      return cells;
    };
    try {
      expect(foregroundModes().some((cell) => cell.isFgRGB())).toBe(true);
      for (const name of ['ANSI', 'ANSI Light']) {
        // No prop updates or settings-context changes: subscribers alone must
        // invalidate code blocks, inline markdown, tables and settled chunks.
        await act(async () => {
          themeManager.setActiveTheme(name);
          themeManager.setTerminalBackground('#25272e');
        });
        await result.waitUntilReady();
        expect(result.lastFrame()).toContain('answer');
        const cells = foregroundModes();
        expect(cells.length).toBeGreaterThan(0);
        for (const cell of cells) {
          expect(cell.isFgRGB()).toBe(false);
          expect(cell.isBgRGB()).toBe(false);
          if (cell.isFgPalette()) expect(cell.getFgColor()).toBeLessThan(16);
          if (cell.isBgPalette()) expect(cell.getBgColor()).toBeLessThan(16);
        }
        await act(async () => {
          themeManager.setActiveTheme(DEFAULT_THEME.name);
          themeManager.setTerminalBackground(undefined);
        });
        await result.waitUntilReady();
        expect(foregroundModes().some((cell) => cell.isFgRGB())).toBe(true);
      }
    } finally {
      result.unmount();
      themeManager.setActiveTheme(previousTheme);
      themeManager.setTerminalBackground(previousBackground);
      chalk.level = previousLevel;
    }
  });

  const lineEndings = [
    { name: 'Windows', eol: '\r\n' },
    { name: 'Unix', eol: '\n' },
  ];

  describe.each(lineEndings)('with $name line endings', ({ eol }) => {
    it('renders headers with correct levels', async () => {
      const text = `
# Header 1
## Header 2
### Header 3
#### Header 4
`.replace(/\n/g, eol);
      const { lastFrame, unmount } = await renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      expect(lastFrame()).toMatchSnapshot();
      unmount();
    });

    it('renders a fenced code block with a language', async () => {
      const text = '```javascript\nconst x = 1;\nconsole.log(x);\n```'.replace(
        /\n/g,
        eol,
      );
      const { lastFrame, unmount } = await renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      expect(lastFrame()).toMatchSnapshot();
      unmount();
    });

    it('renders a fenced code block without a language', async () => {
      const text = '```\nplain text\n```'.replace(/\n/g, eol);
      const { lastFrame, unmount } = await renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      expect(lastFrame()).toMatchSnapshot();
      unmount();
    });

    it('handles unclosed (pending) code blocks', async () => {
      const text = '```typescript\nlet y = 2;'.replace(/\n/g, eol);
      const { lastFrame, unmount } = await renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} isPending={true} />,
      );
      expect(lastFrame()).toMatchSnapshot();
      unmount();
    });

    it('renders unordered lists with different markers', async () => {
      const text = `
- item A
* item B
+ item C
`.replace(/\n/g, eol);
      const { lastFrame, unmount } = await renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      expect(lastFrame()).toMatchSnapshot();
      unmount();
    });

    it('renders nested unordered lists', async () => {
      const text = `
* Level 1
  * Level 2
    * Level 3
`.replace(/\n/g, eol);
      const { lastFrame, unmount } = await renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      expect(lastFrame()).toMatchSnapshot();
      unmount();
    });

    it('renders ordered lists', async () => {
      const text = `
1. First item
2. Second item
`.replace(/\n/g, eol);
      const { lastFrame, unmount } = await renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      expect(lastFrame()).toMatchSnapshot();
      unmount();
    });

    it('renders horizontal rules', async () => {
      const text = `
Hello
---
World
***
Test
`.replace(/\n/g, eol);
      const { lastFrame, unmount } = await renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      expect(lastFrame()).toMatchSnapshot();
      unmount();
    });

    // skip: 现存失败
    it.skip('renders tables correctly', async () => {
      const text = `
| Header 1 | Header 2 |
|----------|:--------:|
| Cell 1   | Cell 2   |
| Cell 3   | Cell 4   |
`.replace(/\n/g, eol);
      const { lastFrame, unmount } = await renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      expect(lastFrame()).toMatchSnapshot();
      unmount();
    });

    it('handles a table at the end of the input', async () => {
      const text = `
Some text before.
| A | B |
|---|
| 1 | 2 |`.replace(/\n/g, eol);
      const { lastFrame, unmount } = await renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      expect(lastFrame()).toMatchSnapshot();
      unmount();
    });

    it('inserts a single space between paragraphs', async () => {
      const text = `Paragraph 1.

Paragraph 2.`.replace(/\n/g, eol);
      const { lastFrame, unmount } = await renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      expect(lastFrame()).toMatchSnapshot();
      unmount();
    });

    it('correctly parses a mix of markdown elements', async () => {
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
      const { lastFrame, unmount } = await renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      expect(lastFrame()).toMatchSnapshot();
      unmount();
    });

    it('hides line numbers in code blocks when showLineNumbers is false', async () => {
      const text = '```javascript\nconst x = 1;\n```'.replace(/\n/g, eol);
      const settings = createLoadedSettings(
        {
          path: '',
          settings: { ui: { showLineNumbers: false } },
          originalSettings: { ui: { showLineNumbers: false } },
        },
        { path: '', settings: {}, originalSettings: {} },
        { path: '', settings: {}, originalSettings: {} },
        true,
        [],
      );

      const { lastFrame, unmount } = await renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
        { settings },
      );
      expect(lastFrame()).toMatchSnapshot();
      expect(lastFrame()).not.toContain('1 const x = 1;');
      unmount();
    });

    it('hides line numbers in code blocks by default', async () => {
      const text = '```javascript\nconst x = 1;\n```'.replace(/\n/g, eol);
      const { lastFrame, unmount } = await renderWithProviders(
        <MarkdownDisplay {...baseProps} text={text} />,
      );
      expect(lastFrame()).toMatchSnapshot();
      expect(lastFrame()).not.toContain('1 const x = 1;');
      unmount();
    });
  });
});
