/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../test-utils/render.js';
import {
  AssistantMessage,
  AssistantMessageContent,
} from './ConversationMessages.js';

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

  it('keeps the newest overflow tail without emitting live marker rows', () => {
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

    expect(output).not.toContain('lines hidden');
    expect(output).not.toContain('line 1');
    expect(output).toContain('line 2');
    expect(output).toContain('line 7');
  });

  it('hard-bounds pending assistant output after actual Ink wrapping (#3279)', () => {
    const text = Array.from(
      { length: 30 },
      (_, index) =>
        `> **Note:** The retry loop (${index}) uses exponential backoff to avoid hammering the API while preserving delivery.`,
    ).join('\n');

    const { lastFrame } = renderWithProviders(
      <AssistantMessage
        text={text}
        isPending={true}
        availableTerminalHeight={10}
        contentWidth={32}
      />,
    );
    const output = lastFrame() ?? '';

    expect(output.split('\n')).toHaveLength(10);
    expect(output).not.toContain('lines hidden');
    expect(output).toContain('preserving');
  });

  it('caps tall pending assistant budgets to avoid scrollback frame leakage (#3279)', () => {
    const text = Array.from(
      { length: 80 },
      () => '```mermaid\nflowchart TD\n    A --> B',
    ).join('\n');

    const { lastFrame } = renderWithProviders(
      <AssistantMessage
        text={text}
        isPending={true}
        availableTerminalHeight={40}
        contentWidth={32}
      />,
    );
    const output = lastFrame() ?? '';

    expect(output.split('\n').length).toBeLessThanOrEqual(26);
    expect(output).not.toContain('lines hidden');
    expect(output).not.toContain('```mermaid');
    expect(output).toContain('flowchart TD');
    expect(output).toContain('A --> B');
    expect(output.match(/flowchart TD/g)).toHaveLength(1);
    expect(output.match(/A --> B/g)).toHaveLength(1);
  });

  it('keeps pending assistant output bounded when height is unconstrained (#3279)', () => {
    const text = Array.from(
      { length: 80 },
      (_, index) =>
        `flowchart TD line ${index} uses a long label that wraps on narrow panes`,
    ).join('\n');

    const { lastFrame } = renderWithProviders(
      <AssistantMessage text={text} isPending={true} contentWidth={32} />,
    );
    const output = lastFrame() ?? '';

    expect(output.split('\n').length).toBeLessThanOrEqual(26);
    expect(output).not.toContain('lines hidden');
    expect(output).not.toContain('line 0');
    expect(output).toContain('line 79');
  });

  it('suppresses pending fenced code delimiters before they reach scrollback (#3279)', () => {
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

    expect(output).not.toContain('```mermaid');
    expect(output).toContain('flowchart TD');
    expect(output).not.toMatch(/^\s*1\s+flowchart TD$/m);
  });

  it('shows bounded complete-line code while an unclosed fence streams (#3279)', () => {
    const text = [
      '下面是一个完整的 Mermaid 类图示例：',
      '',
      '```mermaid',
      'classDiagram',
      'classDiagram',
      'classDiagram',
    ].join('\n');

    const { lastFrame } = renderWithProviders(
      <AssistantMessage
        text={text}
        isPending={true}
        availableTerminalHeight={20}
        contentWidth={40}
      />,
    );
    const output = lastFrame() ?? '';

    expect(output).toContain('下面是一个完整的 Mermaid');
    expect(output).not.toContain('```mermaid');
    expect(output).toContain('classDiagram');
    expect(output.match(/classDiagram/g)).toHaveLength(1);
    expect(output).not.toContain('... writing code block ...');
  });

  it('streams bounded structural preview on ultra-narrow panes without placeholders (#3279)', () => {
    const text = [
      '下面是一个完整的 Mermaid 流程图样例，涵盖常见语法：',
      '',
      '```mermaid',
      'flowchart TD',
      '    A[用户发起请求] --> B{是否已登录?}',
      '    B -->|是| C[检查权限]',
      '```',
    ].join('\n');

    const { lastFrame } = renderWithProviders(
      <AssistantMessage
        text={text}
        isPending={true}
        availableTerminalHeight={20}
        contentWidth={30}
      />,
    );
    const output = lastFrame() ?? '';

    expect(output).toContain('下面是一个完整的 Mermaid');
    expect(output).not.toContain('```mermaid');
    expect(output).toContain('flowchart TD');
    expect(output).toContain('A[用户发起请求]');
    expect(output).not.toContain('... writing code block ...');
  });

  it('shows the trailing partial code line while an unclosed fence streams (#3279)', () => {
    const text = ['```mermaid', 'classDiagram', 'class Order'].join('\n');

    const { lastFrame } = renderWithProviders(
      <AssistantMessage
        text={text}
        isPending={true}
        availableTerminalHeight={20}
        contentWidth={40}
      />,
    );

    const output = lastFrame() ?? '';
    expect(output).not.toContain('```mermaid');
    expect(output).toContain('classDiagram');
    expect(output).toContain('class Order');
    expect(output).not.toContain('... writing code block ...');
  });

  it('shows bounded complete-line tables while a table streams (#3279)', () => {
    const text = [
      '### 语法速查',
      '',
      '| 语法 | 说明 | 示例 |',
      '|------|------|',
      '| `A <\\|-- B` | 继承 | `Base <|-- Child` |',
      '| `A <\\|.. B` | 实现接口 | `IFace <\\|.. Impl` |',
    ].join('\n');

    const { lastFrame } = renderWithProviders(
      <AssistantMessage
        text={text}
        isPending={true}
        availableTerminalHeight={20}
        contentWidth={40}
      />,
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('### 语法速查');
    expect(output).toContain('| 语法 | 说明 | 示例 |');
    expect(output).toContain('Base <|--');
    expect(output).not.toContain('IFace');
    expect(output).not.toContain('... writing table ...');
  });

  it('ignores trailing blank lines in pending live preview before slicing (#3279)', () => {
    const text = [
      'Here is a deterministic Mermaid flowchart:',
      '```mermaid',
      'flowchart TD',
      '    A[QWEN_A1] --> B[QWEN_B1]',
      '    B --> C[QWEN_C1]',
      '```',
      ...Array.from({ length: 30 }, () => ''),
    ].join('\n');

    const { lastFrame } = renderWithProviders(
      <AssistantMessage
        text={text}
        isPending={true}
        availableTerminalHeight={6}
        contentWidth={42}
      />,
    );
    const output = lastFrame() ?? '';

    expect(output.trim()).not.toBe('');
    expect(output).not.toContain('lines hidden');
    expect(output).not.toContain('```mermaid');
    expect(output).toContain('QWEN_A1');
    expect(output).toContain('QWEN_C1');
  });

  it('ignores boundary blank lines in pending live preview (#3279)', () => {
    const text = ['', '', '下面是一个完整的 Mermaid 时序图示例：', '', ''].join(
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

    expect(output).toContain('下面是一个完整的 Mermaid');
    expect(output.startsWith('\n')).toBe(false);
    expect(output.endsWith('\n')).toBe(false);
  });

  it('deduplicates repeated markdown structure in pending live preview (#3279)', () => {
    const text = [
      '### 语法参考',
      '### 语法参考',
      '### 语法参考',
      '| 语法 | 说明 |',
      '| 语法 | 说明 |',
      '| 语法 | 说明 |',
    ].join('\n');

    const { lastFrame } = renderWithProviders(
      <AssistantMessage
        text={text}
        isPending={true}
        availableTerminalHeight={20}
        contentWidth={40}
      />,
    );
    const output = lastFrame() ?? '';

    expect(output.match(/### 语法参考/g)).toHaveLength(1);
    expect(output.match(/\| 语法 \| 说明 \|/g)).toHaveLength(1);
    expect(output).not.toContain('... writing structure ...');
  });

  it('drops incomplete structural tail lines in pending live preview (#3279)', () => {
    const text = ['### 语法参考', '| 语法 | 说明 |', '| `flowchart TD/L'].join(
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

    expect(output).toContain('### 语法参考');
    expect(output).toContain('| 语法 | 说明 |');
    expect(output).not.toContain('flowchart TD/L');
    expect(output).not.toContain('... writing structure ...');
  });

  it('folds progressive structural row prefixes in pending live preview (#3279)', () => {
    const text = [
      '| `flowchart TD/L',
      '| `flowchart TD/LR/RL/BT` |',
      '| `flowchart TD/LR/RL/BT` | 示例 |',
    ].join('\n');

    const { lastFrame } = renderWithProviders(
      <AssistantMessage
        text={text}
        isPending={true}
        availableTerminalHeight={20}
        contentWidth={52}
      />,
    );
    const output = lastFrame() ?? '';

    expect(output).toContain('| `flowchart TD/LR/RL/BT` | 示例 |');
    expect(output.match(/flowchart TD\/LR\/RL\/BT/g)).toHaveLength(1);
    expect(output).not.toContain('... writing structure ...');
  });

  it('shows Mermaid relationship rows once without placeholders (#3279)', () => {
    const text = [
      '语法速查表',
      '',
      'Base <|-- Child',
      'IFace <|.. Impl',
      'A *-- B',
      'Order *-- Item',
    ].join('\n');

    const { lastFrame } = renderWithProviders(
      <AssistantMessage
        text={text}
        isPending={true}
        availableTerminalHeight={20}
        contentWidth={40}
      />,
    );
    const output = lastFrame() ?? '';

    expect(output).toContain('语法速查表');
    expect(output).toContain('Base <|-- Child');
    expect(output).toContain('IFace');
    expect(output).toContain('Order');
    expect(output).not.toContain('... writing structure ...');
  });

  it('bounds consecutive repeated prose rows in pending live preview (#3279)', () => {
    const text = [
      '需要其他类型的 Mermaid 图',
      '需要其他类型的 Mermaid 图',
      '需要其他类型的 Mermaid 图',
      '需要其他类型的 Mermaid 图',
      '随时告诉我。',
    ].join('\n');

    const { lastFrame } = renderWithProviders(
      <AssistantMessage
        text={text}
        isPending={true}
        availableTerminalHeight={20}
        contentWidth={40}
      />,
    );
    const output = lastFrame() ?? '';

    expect(output.match(/需要其他类型的 Mermaid 图/g)).toHaveLength(2);
    expect(output).toContain('随时告诉我。');
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

  it('bounds repeated rows when the assistant message is committed (#3279)', () => {
    const text = [
      '',
      '',
      '需要其他类型的 Mermaid 图',
      '需要其他类型的 Mermaid 图',
      '需要其他类型的 Mermaid 图',
      '需要其他类型的 Mermaid 图',
      '',
      '',
      '结束。',
    ].join('\n');

    const { lastFrame } = renderWithProviders(
      <AssistantMessage
        text={text}
        isPending={false}
        availableTerminalHeight={20}
        contentWidth={40}
      />,
    );
    const output = lastFrame() ?? '';

    expect(output.startsWith('\n')).toBe(false);
    expect(output.match(/需要其他类型的 Mermaid 图/g)).toHaveLength(2);
    expect(output).toContain('结束。');
  });

  it('bounds repeated Mermaid relationship rows when committed (#3279)', () => {
    const text = [
      '语法速查表',
      '',
      'Base <|-- Child',
      'Base <|-- Child',
      'Base <|-- Child',
      'IFace <|.. Impl',
      'IFace <|.. Impl',
      'A o-- B',
      'A o-- B',
      'A o-- B',
      'Order *-- Item',
      'Order *-- Item',
      '语法：+field / +method()',
    ].join('\n');

    const { lastFrame } = renderWithProviders(
      <AssistantMessage
        text={text}
        isPending={false}
        availableTerminalHeight={40}
        contentWidth={40}
      />,
    );
    const output = lastFrame() ?? '';

    expect(output.match(/Base <\|-- Child/g)).toHaveLength(1);
    expect(output.match(/IFace <\|\.\. Impl/g)).toHaveLength(1);
    expect(output.match(/A o-- B/g)).toHaveLength(1);
    expect(output.match(/Order \*-- Item/g)).toHaveLength(1);
    expect(output).toContain('语法：+field / +method()');
  });

  it('bounds repeated table-shaped rows when committed on narrow panes (#3279)', () => {
    const text = [
      '语法参考',
      '',
      'nds A) | `Base <|-- Child`',
      'nds A) | `Base <|-- Child`',
      'nds A) | `Base <|-- Child`',
      'IFace <\\|.. Impl` |',
      'IFace <\\|.. Impl` |',
      'IFace <\\|.. Impl` |',
      '说明：public',
    ].join('\n');

    const { lastFrame } = renderWithProviders(
      <AssistantMessage
        text={text}
        isPending={false}
        availableTerminalHeight={40}
        contentWidth={28}
      />,
    );
    const output = lastFrame() ?? '';

    expect(output.match(/Base <\|-- Child/g)).toHaveLength(1);
    expect(output.match(/IFace <\\\|\.\. Impl/g)).toHaveLength(1);
    expect(output).toContain('说明：public');
  });

  it('folds progressive structural row prefixes when committed (#3279)', () => {
    const text = [
      '| `flowchart TD/L',
      '| `flowchart TD/LR/RL/BT` |',
      '| `flowchart TD/LR/RL/BT` | 示例 |',
    ].join('\n');

    const { lastFrame } = renderWithProviders(
      <AssistantMessage
        text={text}
        isPending={false}
        availableTerminalHeight={20}
        contentWidth={52}
      />,
    );
    const output = lastFrame() ?? '';

    expect(output.match(/flowchart TD\/LR\/RL\/BT/g)).toHaveLength(1);
    expect(output).toContain('示例');
  });

  it('bounds repeated rows across committed assistant content chunks (#3279)', () => {
    const previousText = [
      '需要其他类型的 Mermaid 图',
      '需要其他类型的 Mermaid 图',
    ].join('\n');
    const text = [
      '需要其他类型的 Mermaid 图',
      '需要其他类型的 Mermaid 图',
      '随时告诉我。',
    ].join('\n');

    const { lastFrame } = renderWithProviders(
      <AssistantMessageContent
        text={text}
        previousAssistantText={previousText}
        isPending={false}
        availableTerminalHeight={20}
        contentWidth={40}
      />,
    );
    const output = lastFrame() ?? '';

    expect(output).not.toContain('需要其他类型的 Mermaid 图');
    expect(output).toContain('随时告诉我。');
  });

  it('deduplicates structural rows across pending assistant content chunks (#3279)', () => {
    const previousText = '| 语法 | 说明 |';
    const text = ['| 语法 | 说明 |', '| 语法 | 说明 |', '| 语法 | 示例 |'].join(
      '\n',
    );

    const { lastFrame } = renderWithProviders(
      <AssistantMessageContent
        text={text}
        previousAssistantText={previousText}
        isPending={true}
        availableTerminalHeight={20}
        contentWidth={40}
      />,
    );
    const output = lastFrame() ?? '';

    expect(output.match(/\| 语法 \| 说明 \|/g)).toBeNull();
    expect(output).toContain('| 语法 | 示例 |');
    expect(output).not.toContain('... writing structure ...');
  });

  it('trims sliced leading blank lines from pending previews on narrow terminals', () => {
    const text = [
      '首段说明',
      ...Array.from({ length: 18 }, () => ''),
      '尾部内容',
    ].join('\n');

    const { lastFrame } = renderWithProviders(
      <AssistantMessageContent
        text={text}
        isPending={true}
        availableTerminalHeight={14}
        contentWidth={24}
      />,
    );
    const output = lastFrame() ?? '';
    const indexOfTail = output.indexOf('尾部内容');

    expect(indexOfTail).toBeGreaterThanOrEqual(0);
    expect(output.slice(0, indexOfTail)).not.toContain('\n\n\n\n');
  });
});
