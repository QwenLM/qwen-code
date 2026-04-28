/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../test-utils/render.js';
import { AssistantMessage } from './ConversationMessages.js';

describe('<ConversationMessages />', () => {
  it('does not hide exactly fitting pending assistant output', () => {
    const text = [
      'line 1',
      'line 2',
      'line 3',
      'line 4',
      'line 5',
      'line 6',
    ].join('\n');

    const { lastFrame } = renderWithProviders(
      <AssistantMessage
        text={text}
        isPending={true}
        availableTerminalHeight={6}
        contentWidth={80}
      />,
    );
    const output = lastFrame() ?? '';

    expect(output).not.toContain('streaming line');
    expect(output).toContain('line 1');
    expect(output).toContain('line 6');
  });

  it('reserves only the overflow marker row for pending assistant output', () => {
    const text = [
      'line 1',
      'line 2',
      'line 3',
      'line 4',
      'line 5',
      'line 6',
      'line 7',
    ].join('\n');

    const { lastFrame } = renderWithProviders(
      <AssistantMessage
        text={text}
        isPending={true}
        availableTerminalHeight={6}
        contentWidth={80}
      />,
    );
    const output = lastFrame() ?? '';

    expect(output).toContain('... first 2 streaming lines hidden ...');
    expect(output).not.toContain('line 2');
    expect(output).toContain('line 3');
    expect(output).toContain('line 7');
  });

  it('does not invoke rich markdown rendering for pending fenced code blocks (#3279)', () => {
    // Mermaid code block source: MarkdownDisplay would render this through
    // RenderCodeBlock + colorizeCode, which adds line-number prefixes and
    // narrows the wrap width below markdownWidth, making rendered height
    // exceed the slicer's source-text estimate. Pending must stay plain.
    const text = ['```mermaid', 'flowchart TD', '    A --> B', '```'].join(
      '\n',
    );

    const { lastFrame } = renderWithProviders(
      <AssistantMessage
        text={text}
        isPending={true}
        availableTerminalHeight={20}
        contentWidth={40}
      />,
    );
    const output = lastFrame() ?? '';

    // Raw fence visible — proves we did not enter MarkdownDisplay's code
    // block branch (which would have stripped the fence and emitted a
    // line-number-prefixed render).
    expect(output).toContain('```mermaid');
    expect(output).toContain('flowchart TD');
    expect(output).not.toMatch(/^\s*1\s+flowchart TD$/m);
    expect(output).not.toContain('streaming line');
  });

  it('renders rich markdown once the assistant message is committed', () => {
    const text = ['```mermaid', 'flowchart TD', '```'].join('\n');

    const { lastFrame } = renderWithProviders(
      <AssistantMessage
        text={text}
        isPending={false}
        availableTerminalHeight={20}
        contentWidth={40}
      />,
    );
    const output = lastFrame() ?? '';

    // Committed messages still go through MarkdownDisplay → RenderCodeBlock
    // → colorizeCode, which emits a line-number prefix.
    expect(output).toMatch(/1\s+flowchart TD/);
    expect(output).not.toContain('```mermaid');
  });
});
