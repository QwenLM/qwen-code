/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownDisplay } from './MarkdownDisplay.js';
import { LoadedSettings } from '../../config/settings.js';
import { renderWithProviders } from '../../test-utils/render.js';
import { renderMermaidVisual } from './mermaidVisualRenderer.js';
import { MarkdownRenderingProvider } from '../contexts/MarkdownRenderingContext.js';

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
      expect(output).toContain('source: /copy code 1');
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
      expect(output).toContain('source: /copy code 1');
      expect(output).toContain('Client');
      expect(output).toContain('API');
      expect(output).not.toContain('flowchart LR');
    });

    it('can render mermaid fences as source when source mode is active', () => {
      const text = `
\`\`\`mermaid
flowchart LR
  A[Client] --> B[API]
\`\`\`
`.replace(/\n/g, eol);
      const { lastFrame } = renderWithProviders(
        <MarkdownRenderingProvider
          value={{
            mermaidRenderMode: 'source',
            setMermaidRenderMode: () => undefined,
          }}
        >
          <MarkdownDisplay {...baseProps} text={text} />
        </MarkdownRenderingProvider>,
      );
      const output = lastFrame();
      expect(output).toContain('flowchart LR');
      expect(output).toContain('A[Client] --> B[API]');
      expect(output).not.toContain('Mermaid flowchart');
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
});
