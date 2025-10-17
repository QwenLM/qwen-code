/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MarkdownDisplay } from './MarkdownDisplay.js';
import { LoadedSettings } from '../../config/settings.js';
import { SettingsContext } from '../contexts/SettingsContext.js';

describe('<MarkdownDisplay />', () => {
  const baseProps = {
    isPending: false,
    terminalWidth: 80,
    availableTerminalHeight: 40,
  };

  const mockSettings = new LoadedSettings(
    { path: '', settings: {} },
    { path: '', settings: {} },
    { path: '', settings: {} },
    { path: '', settings: {} },
    [],
    true,
    new Set(),
  );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing for empty text', () => {
    const { lastFrame } = render(
      <SettingsContext.Provider value={mockSettings}>
        <MarkdownDisplay {...baseProps} text="" />
      </SettingsContext.Provider>,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('renders a simple paragraph', () => {
    const text = 'Hello, world.';
    const { lastFrame } = render(
      <SettingsContext.Provider value={mockSettings}>
        <MarkdownDisplay {...baseProps} text={text} />
      </SettingsContext.Provider>,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('renders headers with correct levels', () => {
    const text = `
# Header 1
## Header 2
### Header 3
#### Header 4
`;
    const { lastFrame } = render(
      <SettingsContext.Provider value={mockSettings}>
        <MarkdownDisplay {...baseProps} text={text} />
      </SettingsContext.Provider>,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('renders a fenced code block with a language', () => {
    const text = '```javascript\nconst x = 1;\nconsole.log(x);\n```';
    const { lastFrame } = render(
      <SettingsContext.Provider value={mockSettings}>
        <MarkdownDisplay {...baseProps} text={text} />
      </SettingsContext.Provider>,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('renders a fenced code block without a language', () => {
    const text = '```\nplain text\n```';
    const { lastFrame } = render(
      <SettingsContext.Provider value={mockSettings}>
        <MarkdownDisplay {...baseProps} text={text} />
      </SettingsContext.Provider>,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('handles unclosed (pending) code blocks', () => {
    const text = '```typescript\nlet y = 2;';
    const { lastFrame } = render(
      <SettingsContext.Provider value={mockSettings}>
        <MarkdownDisplay {...baseProps} text={text} isPending={true} />
      </SettingsContext.Provider>,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('renders unordered lists with different markers', () => {
    const text = `
- item A
* item B
+ item C
`;
    const { lastFrame } = render(
      <SettingsContext.Provider value={mockSettings}>
        <MarkdownDisplay {...baseProps} text={text} />
      </SettingsContext.Provider>,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('renders nested unordered lists', () => {
    const text = `
* Level 1
  * Level 2
    * Level 3
`;
    const { lastFrame } = render(
      <SettingsContext.Provider value={mockSettings}>
        <MarkdownDisplay {...baseProps} text={text} />
      </SettingsContext.Provider>,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('renders ordered lists', () => {
    const text = `
1. First item
2. Second item
`;
    const { lastFrame } = render(
      <SettingsContext.Provider value={mockSettings}>
        <MarkdownDisplay {...baseProps} text={text} />
      </SettingsContext.Provider>,
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
`;
    const { lastFrame } = render(
      <SettingsContext.Provider value={mockSettings}>
        <MarkdownDisplay {...baseProps} text={text} />
      </SettingsContext.Provider>,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('renders tables correctly', () => {
    const text = `
| Header 1 | Header 2 |
|----------|:--------:|
| Cell 1   | Cell 2   |
| Cell 3   | Cell 4   |
`;
    const { lastFrame } = render(
      <SettingsContext.Provider value={mockSettings}>
        <MarkdownDisplay {...baseProps} text={text} />
      </SettingsContext.Provider>,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('handles a table at the end of the input', () => {
    const text = `
Some text before.
| A | B |
|---|
| 1 | 2 |`;
    const { lastFrame } = render(
      <SettingsContext.Provider value={mockSettings}>
        <MarkdownDisplay {...baseProps} text={text} />
      </SettingsContext.Provider>,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('inserts a single space between paragraphs', () => {
    const text = `Paragraph 1.

Paragraph 2.`;
    const { lastFrame } = render(
      <SettingsContext.Provider value={mockSettings}>
        <MarkdownDisplay {...baseProps} text={text} />
      </SettingsContext.Provider>,
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
`;
    const { lastFrame } = render(
      <SettingsContext.Provider value={mockSettings}>
        <MarkdownDisplay {...baseProps} text={text} />
      </SettingsContext.Provider>,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('hides line numbers in code blocks when showLineNumbers is false', () => {
    const text = '```javascript\nconst x = 1;\n```';
    const settings = new LoadedSettings(
      { path: '', settings: {} },
      { path: '', settings: {} },
      { path: '', settings: { ui: { showLineNumbers: false } } },
      { path: '', settings: {} },
      [],
      true,
      new Set(),
    );

    const { lastFrame } = render(
      <SettingsContext.Provider value={settings}>
        <MarkdownDisplay {...baseProps} text={text} />
      </SettingsContext.Provider>,
    );
    expect(lastFrame()).toMatchSnapshot();
    expect(lastFrame()).not.toContain(' 1 ');
  });

  it('shows line numbers in code blocks by default', () => {
    const text = '```javascript\nconst x = 1;\n```';
    const { lastFrame } = render(
      <SettingsContext.Provider value={mockSettings}>
        <MarkdownDisplay {...baseProps} text={text} />
      </SettingsContext.Provider>,
    );
    expect(lastFrame()).toMatchSnapshot();
    expect(lastFrame()).toContain(' 1 ');
  });

  it('correctly splits lines using \\n regardless of platform EOL', () => {
    // Test that the component uses \n for splitting, not EOL
    const textWithUnixLineEndings = 'Line 1\nLine 2\nLine 3';

    const { lastFrame } = render(
      <SettingsContext.Provider value={mockSettings}>
        <MarkdownDisplay {...baseProps} text={textWithUnixLineEndings} />
      </SettingsContext.Provider>,
    );

    const output = lastFrame();
    expect(output).toContain('Line 1');
    expect(output).toContain('Line 2');
    expect(output).toContain('Line 3');
    expect(output).toMatchSnapshot();
  });
});
