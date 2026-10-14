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
import { ToolCallStatus, StreamingState } from '../../types.js';
import { StreamingContext } from '../../contexts/StreamingContext.js';
import { RenderModeProvider } from '../../contexts/RenderModeContext.js';
import { LoadedSettings } from '../../../config/settings.js';
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
    <StreamingContext.Provider value={StreamingState.Idle}>
      <OverflowProvider>
        {visible && (
          <Box width={props.contentWidth} flexDirection="column">
            <ToolMessage {...props} />
          </Box>
        )}
        <OverflowProbe />
      </OverflowProvider>
    </StreamingContext.Provider>
  );
}

describe('tool result Markdown with a real renderer', () => {
  it('formats a short answer even with a height budget', () => {
    const { lastFrame } = renderWithProviders(<ToolMessage {...baseProps} />);
    expect(lastFrame()).toContain('配置范围: 两个都改');
    expect(lastFrame()).not.toContain('**');
  });

  it.each([false, true])(
    'formats the real three-line answer at the minimum budget with pending=%s',
    (isPending) => {
      const { lastFrame } = renderWithProviders(
        resultWithOverflow({
          ...baseProps,
          isPending,
          availableTerminalHeight: 9,
          resultDisplay: {
            type: 'ask_user_question_answers',
            text: 'User has provided the following answers:\n\n**Color**: Blue',
            answers: [
              { question: 'Which color do you prefer?', answer: 'Blue' },
            ],
          },
        }),
      );
      expect(lastFrame()).toContain('User has provided the following answers:');
      expect(lastFrame()).toContain('Color: Blue');
      expect(lastFrame()).not.toContain('**');
      expect(lastFrame()).not.toContain('hidden');
      expect(lastFrame()).toContain('overflow:0');
      expect((lastFrame() ?? '').split('\n')).toHaveLength(5);
    },
  );

  it('keeps the tail of an overflowing completed Markdown result', () => {
    const { lastFrame } = renderWithProviders(
      resultWithOverflow({
        ...baseProps,
        renderOutputAsMarkdown: undefined,
        resultDisplay: Array.from(
          { length: 60 },
          (_, i) => `**row ${i}**`,
        ).join('\n'),
      }),
    );
    expect(lastFrame()).toContain('row 59');
    expect(lastFrame()).not.toContain('row 0');
    expect(lastFrame()).toContain('lines hidden');
  });

  it.each([
    ['wide line', 'x'.repeat(3000), 'xxxx'],
    ['JSON', JSON.stringify({ value: 'x'.repeat(3000) }), 'xxxx'],
    ['Chinese', '中文'.repeat(1500), '中文'],
  ])(
    'keeps content visible for an oversized first %s',
    (_name, resultDisplay, visibleText) => {
      const { lastFrame } = renderWithProviders(
        resultWithOverflow({
          ...baseProps,
          renderOutputAsMarkdown: undefined,
          resultDisplay,
          availableTerminalHeight: 9,
        }),
      );
      expect(lastFrame()).toContain(visibleText);
      expect((lastFrame() ?? '').split('\n')).toHaveLength(5);
    },
  );

  it('renders an exactly fitting Markdown result in full', () => {
    const { lastFrame } = renderWithProviders(
      resultWithOverflow({
        ...baseProps,
        availableTerminalHeight: 12,
        resultDisplay: Array.from({ length: 6 }, (_, i) => `**row ${i}**`).join(
          '\n',
        ),
      }),
    );
    expect(lastFrame()).toContain('row 0');
    expect(lastFrame()).toContain('row 5');
    expect(lastFrame()).not.toContain('**');
    expect(lastFrame()).not.toContain('hidden');
    expect(lastFrame()).not.toContain('more lines');
  });

  it('keeps raw table source and following text when they fit', () => {
    const { lastFrame } = renderWithProviders(
      <RenderModeProvider value={{ renderMode: 'raw', setRenderMode: vi.fn() }}>
        {resultWithOverflow({
          ...baseProps,
          availableTerminalHeight: 12,
          resultDisplay: '| A | B |\n| --- | --- |\n| x | y |\none\ntwo\nthree',
        })}
      </RenderModeProvider>,
    );
    expect(lastFrame()).toContain('three');
    expect(lastFrame()).not.toContain('hidden');
    expect(lastFrame()).not.toContain('┌');
  });

  it('counts code gutters in raw mode before choosing full Markdown', () => {
    const { lastFrame } = renderWithProviders(
      <RenderModeProvider value={{ renderMode: 'raw', setRenderMode: vi.fn() }}>
        {resultWithOverflow({
          ...baseProps,
          contentWidth: 26,
          availableTerminalHeight: 12,
          resultDisplay:
            '```text\n' +
            Array.from({ length: 4 }, () => 'x'.repeat(23)).join('\n') +
            '\n```',
        })}
      </RenderModeProvider>,
    );
    expect(lastFrame()).toContain('```text');
    expect(lastFrame()).not.toContain('hidden');
    expect((lastFrame() ?? '').split('\n')).toHaveLength(8);
  });

  it.each([false, true])(
    'honors showLineNumbers=%s in the result fit probe',
    (showLineNumbers) => {
      const settings = new LoadedSettings(
        { path: '', settings: {}, originalSettings: {} },
        { path: '', settings: {}, originalSettings: {} },
        {
          path: '',
          settings: { ui: { showLineNumbers } },
          originalSettings: {},
        },
        { path: '', settings: {}, originalSettings: {} },
        true,
        new Set(),
      );
      const { lastFrame } = renderWithProviders(
        resultWithOverflow({
          ...baseProps,
          contentWidth: 26,
          availableTerminalHeight: 12,
          resultDisplay:
            '```text\n' +
            Array.from({ length: 4 }, () => 'x'.repeat(23)).join('\n') +
            '\n```',
        }),
        { settings },
      );
      expect((lastFrame() ?? '').includes('```text')).toBe(showLineNumbers);
    },
  );

  it.each(['-', '123.'])(
    'keeps fitting %s task lists as Markdown',
    (marker) => {
      const { lastFrame } = renderWithProviders(
        resultWithOverflow({
          ...baseProps,
          availableTerminalHeight: 9,
          resultDisplay: Array.from(
            { length: 3 },
            () => `${marker} [ ] ${'x'.repeat(74)}`,
          ).join('\n'),
        }),
      );
      expect(lastFrame()).toContain('x'.repeat(74));
      expect(lastFrame()).not.toContain('[ ]');
      expect(lastFrame()).not.toContain('hidden');
      expect((lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(5);
    },
  );

  it('keeps a completed Mermaid source bounded rather than estimating its diagram from source lines', () => {
    const { lastFrame } = renderWithProviders(
      resultWithOverflow({
        ...baseProps,
        availableTerminalHeight: 9,
        resultDisplay: '```mermaid\ngraph TD; A-->B; B-->C; C-->D\n```',
      }),
    );
    expect(lastFrame()).toContain('graph TD; A-->B; B-->C; C-->D');
    expect((lastFrame() ?? '').split('\n')).toHaveLength(5);
  });

  it('keeps a narrow completed math block bounded without guessing its header height', () => {
    const { lastFrame } = renderWithProviders(
      resultWithOverflow({
        ...baseProps,
        contentWidth: 14,
        availableTerminalHeight: 9,
        resultDisplay: '$$\nx\n$$',
      }),
    );
    expect(lastFrame()).toContain('$$');
    expect(lastFrame()).not.toContain('LaTeX');
    expect((lastFrame() ?? '').split('\n')).toHaveLength(6);
  });

  it('counts raw blockquote indentation before choosing full Markdown', async () => {
    const { lastFrame } = renderWithProviders(
      <RenderModeProvider value={{ renderMode: 'raw', setRenderMode: vi.fn() }}>
        {resultWithOverflow({
          ...baseProps,
          contentWidth: 26,
          availableTerminalHeight: 12,
          resultDisplay: Array.from(
            { length: 6 },
            () => ' '.repeat(28) + '> x',
          ).join('\n'),
        })}
      </RenderModeProvider>,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('overflow:1'));
    expect((lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(8);
    expect(lastFrame()).toContain('> x');
  });

  it('keeps the completed-result tail even when its group is still pending', () => {
    const { lastFrame } = renderWithProviders(
      resultWithOverflow({
        ...baseProps,
        isPending: true,
        resultDisplay: Array.from(
          { length: 60 },
          (_, i) => `**row ${i}**`,
        ).join('\n'),
      }),
    );
    expect(lastFrame()).toContain('row 59');
    expect(lastFrame()).not.toContain('row 0');
  });

  it('keeps the newest executing Markdown output and its hidden-line count', async () => {
    const props = {
      ...baseProps,
      isPending: true,
      status: ToolCallStatus.Executing,
      availableTerminalHeight: 12,
      resultDisplay: Array.from(
        { length: 200 },
        (_, i) => `**line ${i + 1}**`,
      ).join('\n'),
    };
    const { lastFrame, rerender } = renderWithProviders(
      resultWithOverflow(props),
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('overflow:1'));
    expect(lastFrame()).toContain('line 200');
    rerender(
      withProviders(
        resultWithOverflow({
          ...props,
          resultDisplay: Array.from(
            { length: 5000 },
            (_, i) => `**line ${i + 1}**`,
          ).join('\n'),
        }),
      ),
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('line 5000'));
    expect(lastFrame()).not.toContain('line 1**');
    expect(lastFrame()).toContain('first 4995 lines hidden');
    expect(lastFrame()).toContain('overflow:1');
    expect((lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(8);
  });

  it.each([
    [
      'pending headroom',
      80,
      12,
      '**line 1**\n**line 2**\n**line 3**\n**line 4**\n**line 5**',
      'line 5',
    ],
    [
      'frontier layout',
      80,
      22,
      `| A | B |\n| --- | --- |\n| x | y |\n| ${'z'.repeat(500)} TAIL-LIVE | y |`,
      'TAIL-LIVE',
    ],
    ['narrow math header', 6, 11, '$$\nx\n$$', '$$'],
  ])(
    'keeps live content visible at %s',
    (_name, contentWidth, availableTerminalHeight, resultDisplay, tail) => {
      const { lastFrame } = renderWithProviders(
        resultWithOverflow({
          ...baseProps,
          name: 'MCP',
          isPending: true,
          status: ToolCallStatus.Executing,
          contentWidth,
          availableTerminalHeight,
          resultDisplay,
        }),
      );
      expect(lastFrame()).toContain(tail);
      expect(lastFrame()).not.toContain('LaTeX');
      expect((lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(
        availableTerminalHeight - 4,
      );
    },
  );

  it('preserves Markdown for a fitting executing result', () => {
    const { lastFrame } = renderWithProviders(
      resultWithOverflow({
        ...baseProps,
        isPending: true,
        status: ToolCallStatus.Executing,
      }),
    );
    expect(lastFrame()).toContain('配置范围: 两个都改');
    expect(lastFrame()).not.toContain('**');
  });

  it('keeps the tail of an overflowing pending table', async () => {
    const { lastFrame } = renderWithProviders(
      resultWithOverflow({
        ...baseProps,
        isPending: true,
        status: ToolCallStatus.Executing,
        resultDisplay:
          '| A | B |\n| --- | --- |\n' +
          Array.from(
            { length: 40 },
            (_, i) => `| value${i} | result${i} |`,
          ).join('\n'),
      }),
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('overflow:1'));
    expect(lastFrame()).toContain('value39');
    expect(lastFrame()).toContain('lines hidden');
    expect(lastFrame()).not.toContain('more rows streaming');
    expect((lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(16);
  });

  it('keeps a force-shown resumed shell result literal and tail-preserving', () => {
    const { lastFrame } = renderWithProviders(
      resultWithOverflow({
        ...baseProps,
        name: 'Shell',
        renderOutputAsMarkdown: undefined,
        forceShowResult: true,
        resultDisplay: Array.from(
          { length: 60 },
          (_, i) => `**row ${i}**`,
        ).join('\n'),
      }),
    );
    expect(lastFrame()).toContain('**row 59**');
    expect(lastFrame()).not.toContain('**row 0**');
  });

  it.each([false, true])(
    'honors explicit shell Markdown only when forceShowResult=%s lifts the cap',
    (forceShowResult) => {
      const { lastFrame } = renderWithProviders(
        resultWithOverflow({
          ...baseProps,
          name: 'Shell',
          forceShowResult,
          renderOutputAsMarkdown: true,
          resultDisplay: '**row 0**\n**row 1**\n**row 2**',
        }),
      );
      expect((lastFrame() ?? '').includes('**row')).toBe(!forceShowResult);
      expect(lastFrame()).toContain('row 2');
    },
  );

  it.each([
    [
      'paragraphs',
      Array.from({ length: 60 }, (_, i) => `**row ${i}**`).join('\n'),
      80,
    ],
    [
      'list marker wrapping',
      Array.from({ length: 20 }, () => '- ' + 'a'.repeat(20)).join('\n'),
      24,
    ],
    [
      'asymmetric table after prose',
      'One\nTwo\nThree\nFour\n| A | B |\n| --- | --- |\n' +
        `| ${'x'.repeat(100)} | ${'a '.repeat(20).trim()} |\n` +
        Array.from({ length: 50 }, () => '| a | b |').join('\n'),
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
      expect(frame.split('\n').length).toBeGreaterThanOrEqual(
        availableTerminalHeight - 6,
      );
      expect(frame).toMatch(/\.\.\. first \d+/);
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
      expect(lastFrame()).toContain('value39');
      expect((lastFrame() ?? '').split('\n').length).toBeGreaterThanOrEqual(
        availableTerminalHeight - 6,
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

  it('clears overflow when content becomes short or the result subtree is unmounted', async () => {
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
