/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import {
  renderWithProviders,
  withProviders,
} from '../../../test-utils/render.js';
import {
  OverflowProvider,
  useOverflowState,
} from '../../contexts/OverflowContext.js';
import { ToolCallStatus } from '../../types.js';
import { ToolMessage, type ToolMessageProps } from './ToolMessage.js';

const baseProps: ToolMessageProps = {
  callId: 'markdown-result',
  name: 'AskUserQuestion',
  description: '',
  resultDisplay: '**配置范围**: 两个都改',
  renderOutputAsMarkdown: true,
  status: ToolCallStatus.Success,
  confirmationDetails: undefined,
  contentWidth: 80,
  availableTerminalHeight: 20,
};

function OverflowProbe() {
  const state = useOverflowState();
  return <Text>overflow:{state?.overflowingIds.size ?? 0}</Text>;
}

function resultWithOverflow(props: ToolMessageProps, visible = true) {
  return (
    <OverflowProvider>
      {visible && (
        <Box width={props.contentWidth} flexDirection="column">
          <ToolMessage {...props} />
        </Box>
      )}
      <OverflowProbe />
    </OverflowProvider>
  );
}

describe('tool result Markdown with a real renderer', () => {
  it('formats a short answer even with a height budget', () => {
    const { lastFrame } = renderWithProviders(<ToolMessage {...baseProps} />);
    expect(lastFrame()).toContain('配置范围: 两个都改');
    expect(lastFrame()).not.toContain('**');
  });

  it.each([
    [
      'paragraphs',
      Array.from({ length: 60 }, (_, i) => `**row ${i}**`).join('\n'),
      80,
    ],
    [
      'list marker wrapping',
      Array.from({ length: 12 }, () => '- ' + 'a'.repeat(20)).join('\n'),
      24,
    ],
    [
      'asymmetric table after prose',
      'One\nTwo\nThree\nFour\n| A | B |\n| --- | --- |\n' +
        `| ${'x'.repeat(100)} | ${'a '.repeat(20).trim()} |\n` +
        Array.from({ length: 9 }, () => '| a | b |').join('\n'),
      80,
      40,
    ],
    ['word-wrapped paragraph', `${'a'.repeat(40)} `.repeat(22).trim(), 80],
    [
      'long vertical table cells',
      `| A | B |\n| --- | --- |\n| ${'x'.repeat(200)} | ${'y'.repeat(200)} |`,
      24,
    ],
    [
      'wrapped Chinese',
      Array.from({ length: 30 }, () => '**中文内容**'.repeat(8)).join('\n'),
      32,
    ],
    [
      'code block',
      '```typescript\n' +
        Array.from({ length: 60 }, (_, i) => `const value${i} = ${i};`).join(
          '\n',
        ) +
        '\n```',
      80,
    ],
    [
      'wrapped code after prose',
      'First line\nSecond line\nThird line\n```typescript\n' +
        Array.from(
          { length: 60 },
          () => 'const value = "very long content";',
        ).join('\n') +
        '\n```',
      24,
    ],
    [
      'code gutter wrapping',
      'First line\nSecond line\nThird line\n```typescript\n' +
        Array.from({ length: 60 }, () => 'abcdefghijklmnopqrstu').join('\n') +
        '\n```',
      24,
    ],
    [
      'tabbed code',
      'First line\nSecond line\nThird line\n```typescript\n' +
        Array.from({ length: 60 }, () => '\t\t\t\t\t\tvalue').join('\n') +
        '\n```',
      24,
    ],
    [
      'table with following text',
      '| A | B |\n| --- | --- |\n' +
        Array.from({ length: 40 }, (_, i) => `| value${i} | result${i} |`).join(
          '\n',
        ) +
        '\nAfter the table',
      80,
    ],
    [
      'table',
      '| A | B |\n| --- | --- |\n' +
        Array.from({ length: 40 }, (_, i) => `| value${i} | result${i} |`).join(
          '\n',
        ),
      80,
    ],
    [
      'narrow table',
      '| A | B |\n| --- | --- |\n' +
        Array.from(
          { length: 40 },
          (_, i) => `| 中文内容${i} | 很长的结果${i} |`,
        ).join('\n'),
      24,
    ],
  ])(
    'bounds %s and registers expandable overflow',
    async (
      _name,
      resultDisplay,
      contentWidth,
      availableTerminalHeight = 20,
    ) => {
      const { lastFrame } = renderWithProviders(
        resultWithOverflow({
          ...baseProps,
          resultDisplay,
          contentWidth,
          availableTerminalHeight,
        }),
      );
      await vi.waitFor(() => expect(lastFrame()).toMatch(/overflow:[1-9]/));
      const frame = lastFrame() ?? '';
      // Six rows are reserved; the tool header and overflow probe use two.
      expect(frame.split('\n').length).toBeLessThanOrEqual(
        availableTerminalHeight - 4,
      );
      expect(frame).toMatch(/more (?:lines?|rows)/);
      expect(frame).not.toContain('streaming');
    },
  );

  it.each([9, 12, 20])(
    'bounds a tall table at a %s-row tool budget',
    async (availableTerminalHeight) => {
      const props = {
        ...baseProps,
        availableTerminalHeight,
        resultDisplay:
          '| A | B |\n| --- | --- |\n' +
          Array.from(
            { length: 40 },
            (_, i) => `| value${i} | result${i} |`,
          ).join('\n'),
      };
      const { lastFrame, rerender } = renderWithProviders(
        resultWithOverflow(props),
      );
      await vi.waitFor(() => expect(lastFrame()).toContain('overflow:1'));
      expect((lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(
        availableTerminalHeight - 4,
      );
      rerender(
        withProviders(
          resultWithOverflow({ ...props, availableTerminalHeight: undefined }),
        ),
      );
      await vi.waitFor(() => expect(lastFrame()).toContain('overflow:0'));
      expect(lastFrame()).toContain('value39');
    },
  );

  it('reveals the full result and clears overflow when the budget is lifted', async () => {
    const props = {
      ...baseProps,
      resultDisplay: Array.from({ length: 60 }, (_, i) => `**row ${i}**`).join(
        '\n',
      ),
    };
    const { lastFrame, rerender } = renderWithProviders(
      resultWithOverflow(props),
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('overflow:1'));
    rerender(
      withProviders(
        resultWithOverflow({
          ...props,
          availableTerminalHeight: undefined,
          fullDetail: true,
        }),
      ),
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('overflow:0'));
    expect(lastFrame()).toContain('row 59');
    expect(lastFrame()).not.toContain('**');
  });

  it('clears overflow when content becomes short, empty, or is unmounted', async () => {
    const props = { ...baseProps, resultDisplay: '**long line**\n'.repeat(60) };
    const { lastFrame, rerender } = renderWithProviders(
      resultWithOverflow(props),
    );
    for (const resultDisplay of ['short', '', undefined]) {
      rerender(withProviders(resultWithOverflow(props)));
      await vi.waitFor(() => expect(lastFrame()).toContain('overflow:1'));
      rerender(
        withProviders(
          resultWithOverflow(
            { ...props, resultDisplay },
            resultDisplay !== undefined,
          ),
        ),
      );
      await vi.waitFor(() => expect(lastFrame()).toContain('overflow:0'));
    }
  });

  it('preserves explicit plain text and raw file detail', () => {
    for (const props of [
      { ...baseProps, renderOutputAsMarkdown: false },
      {
        ...baseProps,
        name: 'ReadFile',
        fullDetail: true,
        forceShowResult: true,
        availableTerminalHeight: undefined,
        detailedDisplay: '**配置范围**: 两个都改',
      },
    ]) {
      const { lastFrame } = renderWithProviders(<ToolMessage {...props} />);
      expect(lastFrame()).toContain('**配置范围**: 两个都改');
    }
  });

  it('keeps the resumed shell result plain and capped without a viewport budget', () => {
    const { lastFrame } = renderWithProviders(
      <ToolMessage
        {...baseProps}
        name="Shell"
        renderOutputAsMarkdown={undefined}
        availableTerminalHeight={undefined}
        resultDisplay={Array.from(
          { length: 60 },
          (_, i) => `**row ${i}**`,
        ).join('\n')}
      />,
    );
    expect(lastFrame()).toContain('**row 59**');
    expect(lastFrame()).not.toContain('**row 0**');
    expect(lastFrame()).toContain('lines hidden');
  });
});
