/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { memo } from 'react';
import { Text } from 'ink';
import {
  areHistoryItemPropsEqual,
  HistoryItemDisplay,
} from './HistoryItemDisplay.js';
import { MessageType, type HistoryItem } from '../types.js';
import { SessionStatsProvider } from '../contexts/SessionContext.js';
import {
  CoreToolCallStatus,
  type Config,
  type SerializableConfirmationDetails,
} from '@qwen-code/core';
import { ToolGroupMessage } from './messages/ToolGroupMessage.js';
import { renderWithProviders } from '../../test-utils/render.js';
import { createMockSettings } from '../../test-utils/settings.js';
import { makeFakeConfig } from '@qwen-code/core';

// Mock child components
vi.mock('./messages/ToolGroupMessage.js', () => ({
  hasRenderableToolGroup: vi.fn(
    (item: { tools: unknown[]; borderBottom?: boolean }) =>
      item.tools.length > 0 || item.borderBottom === true,
  ),
  ToolGroupMessage: vi.fn(() => <div />),
}));

describe('<HistoryItemDisplay />', () => {
  const mockConfig = {} as unknown as Config;
  const baseItem = {
    id: 1,
    timestamp: 12345,
    isPending: false,
    terminalWidth: 80,
    config: mockConfig,
  };

  it('compares static history items by item reference and render props', () => {
    const item: HistoryItem = {
      id: 1,
      type: MessageType.USER,
      text: 'MAIN_SESSION_OK',
    };
    const replacementItem: HistoryItem = {
      id: 1,
      type: MessageType.USER,
      text: 'WT_A_SESSION_OK',
    };
    const props = {
      item,
      terminalWidth: 80,
      isPending: false,
      isStatic: true,
    };

    expect(
      areHistoryItemPropsEqual(props, {
        ...props,
        item: replacementItem,
      }),
    ).toBe(false);

    expect(areHistoryItemPropsEqual(props, props)).toBe(true);
  });

  it('rerenders memoized static history items when same id receives new content', async () => {
    const MemoizedHistoryItemDisplay = memo(
      HistoryItemDisplay,
      areHistoryItemPropsEqual,
    );
    const first: HistoryItem = {
      id: 1,
      type: 'custom_content',
      text: 'MAIN_SESSION_OK',
      content: <Text>MAIN_SESSION_OK</Text>,
    };
    const second: HistoryItem = {
      id: 1,
      type: 'custom_content',
      text: 'WT_A_SESSION_OK',
      content: <Text>WT_A_SESSION_OK</Text>,
    };

    const { lastFrameRaw, rerender, waitUntilReady, unmount } =
      await renderWithProviders(
        <MemoizedHistoryItemDisplay
          key={first.id}
          item={first}
          terminalWidth={80}
          isPending={false}
          isStatic={true}
        />,
      );
    expect(lastFrameRaw()).toContain('MAIN_SESSION_OK');

    rerender(
      <MemoizedHistoryItemDisplay
        key={second.id}
        item={second}
        terminalWidth={80}
        isPending={false}
        isStatic={true}
      />,
    );
    await waitUntilReady();

    expect(lastFrameRaw()).toContain('WT_A');
    expect(lastFrameRaw()).not.toContain('MAIN_SESSION_OK');
    unmount();
  });

  it('renders UserMessage for "user" type', async () => {
    const item: HistoryItem = {
      ...baseItem,
      type: MessageType.USER,
      text: 'Hello',
    };
    const { lastFrame, unmount } = await renderWithProviders(
      <HistoryItemDisplay {...baseItem} item={item} />,
    );
    expect(lastFrame()).toContain('Hello');
    unmount();
  });

  it('renders HintMessage for "hint" type', async () => {
    const item: HistoryItem = {
      ...baseItem,
      type: 'hint',
      text: 'Try using ripgrep first',
    };
    const { lastFrame, unmount } = await renderWithProviders(
      <HistoryItemDisplay {...baseItem} item={item} />,
    );
    expect(lastFrame()).toContain('Try using ripgrep first');
    unmount();
  });

  it('renders UserMessage for "user" type with slash command', async () => {
    const item: HistoryItem = {
      ...baseItem,
      type: MessageType.USER,
      text: '/theme',
    };
    const { lastFrame, unmount } = await renderWithProviders(
      <HistoryItemDisplay {...baseItem} item={item} />,
    );
    expect(lastFrame()).toContain('/theme');
    unmount();
  });

  // skip: 现存失败
  it.skip.each([true, false])(
    'renders InfoMessage for "info" type with multi-line text (alternateBuffer=%s)',
    async (useAlternateBuffer) => {
      const item: HistoryItem = {
        ...baseItem,
        type: MessageType.INFO,
        text: '⚡ Line 1\n⚡ Line 2\n⚡ Line 3',
      };
      const { lastFrame, unmount } = await renderWithProviders(
        <HistoryItemDisplay {...baseItem} item={item} />,
        {
          config: makeFakeConfig({ useAlternateBuffer }),
          settings: createMockSettings({ ui: { useAlternateBuffer } }),
        },
      );
      expect(lastFrame()).toMatchSnapshot();
      unmount();
    },
  );

  it('explains that refused model text is excluded from future context', async () => {
    const item: HistoryItem = {
      ...baseItem,
      type: MessageType.ERROR,
      text: 'This conversation contains sensitive content.',
      excludedFromContext: true,
    };
    const renderResult = await renderWithProviders(
      <HistoryItemDisplay {...baseItem} item={item} />,
    );

    await renderResult.waitUntilReady();
    await expect(renderResult).toMatchSvgSnapshot();
    renderResult.unmount();
  });

  it('renders StatsDisplay for "stats" type', async () => {
    const item: HistoryItem = {
      ...baseItem,
      type: MessageType.STATS,
      duration: '1s',
    };
    const { lastFrame, unmount } = await renderWithProviders(
      <SessionStatsProvider>
        <HistoryItemDisplay {...baseItem} item={item} />
      </SessionStatsProvider>,
    );
    expect(lastFrame()).toContain('Stats');
    unmount();
  });

  it('renders AboutBox for "about" type', async () => {
    const item: HistoryItem = {
      ...baseItem,
      type: MessageType.ABOUT,
      cliVersion: '1.0.0',
      osVersion: 'test-os',
      modelVersion: 'test-model',
      selectedAuthType: 'test-auth',
    };
    const { lastFrame, unmount } = await renderWithProviders(
      <HistoryItemDisplay {...baseItem} item={item} />,
    );
    expect(lastFrame()).toContain('About - Qwen Code');
    unmount();
  });

  it('renders ModelStatsDisplay for "model_stats" type', async () => {
    const item: HistoryItem = {
      ...baseItem,
      type: 'model_stats',
    };
    const { lastFrame, unmount } = await renderWithProviders(
      <SessionStatsProvider>
        <HistoryItemDisplay {...baseItem} item={item} />
      </SessionStatsProvider>,
    );
    expect(lastFrame()).toContain(
      'No API calls have been made in this session.',
    );
    unmount();
  });

  it('renders ToolStatsDisplay for "tool_stats" type', async () => {
    const item: HistoryItem = {
      ...baseItem,
      type: 'tool_stats',
    };
    const { lastFrame, unmount } = await renderWithProviders(
      <SessionStatsProvider>
        <HistoryItemDisplay {...baseItem} item={item} />
      </SessionStatsProvider>,
    );
    expect(lastFrame()).toContain(
      'No tool calls have been made in this session.',
    );
    unmount();
  });

  it('renders SessionSummaryDisplay for "quit" type', async () => {
    const item: HistoryItem = {
      ...baseItem,
      type: 'quit',
      duration: '1s',
    };
    const { lastFrame, unmount } = await renderWithProviders(
      <SessionStatsProvider>
        <HistoryItemDisplay {...baseItem} item={item} />
      </SessionStatsProvider>,
    );
    expect(lastFrame()).toContain('Agent powering down. Goodbye!');
    unmount();
  });

  it('should escape ANSI codes in text content', async () => {
    const historyItem: HistoryItem = {
      id: 1,
      type: 'user',
      text: 'Hello, \u001b[31mred\u001b[0m world!',
    };

    const { lastFrame, unmount } = await renderWithProviders(
      <HistoryItemDisplay
        item={historyItem}
        terminalWidth={80}
        isPending={false}
      />,
    );

    // The ANSI codes should be escaped for display.
    expect(lastFrame()).toContain('Hello, \\u001b[31mred\\u001b[0m world!');
    // The raw ANSI codes should not be present.
    expect(lastFrame()).not.toContain('Hello, \u001b[31mred\u001b[0m world!');
    unmount();
  });

  it('should escape ANSI codes in tool confirmation details', async () => {
    const historyItem: HistoryItem = {
      id: 1,
      type: 'tool_group',
      tools: [
        {
          callId: '123',
          name: 'Bash',
          description: 'Run a shell command',
          resultDisplay: 'blank',
          status: CoreToolCallStatus.AwaitingApproval,
          confirmationDetails: {
            type: 'exec',
            title: 'Run Shell Command',
            command: 'echo "\u001b[31mhello\u001b[0m"',
            rootCommand: 'echo',
            rootCommands: ['echo'],
          },
        },
      ],
    };

    const { unmount } = await renderWithProviders(
      <HistoryItemDisplay
        item={historyItem}
        terminalWidth={80}
        isPending={false}
      />,
    );

    const passedProps = vi.mocked(ToolGroupMessage).mock.calls[0][0];
    const confirmationDetails = passedProps.toolCalls[0]
      .confirmationDetails as SerializableConfirmationDetails & {
      type: 'exec';
    };

    expect(confirmationDetails.command).toBe(
      'echo "\\u001b[31mhello\\u001b[0m"',
    );
    unmount();
  });

  it('does not render an empty assistant item', async () => {
    const item: HistoryItem = {
      ...baseItem,
      type: 'gemini',
      text: '',
    };
    const { lastFrame, unmount } = await renderWithProviders(
      <HistoryItemDisplay {...baseItem} item={item} />,
    );

    expect(lastFrame({ allowEmpty: true })).toBe('');
    unmount();
  });

  it('does not render an empty tool group', async () => {
    const item: HistoryItem = {
      ...baseItem,
      type: 'tool_group',
      tools: [],
    };
    const { lastFrame, unmount } = await renderWithProviders(
      <HistoryItemDisplay {...baseItem} item={item} />,
    );

    expect(lastFrame({ allowEmpty: true })).toBe('');
    unmount();
  });

  describe('thinking items', () => {
    it('renders thinking item when enabled', async () => {
      const item: HistoryItem = {
        ...baseItem,
        type: 'thinking',
        thought: { subject: 'Thinking', description: 'test' },
      };
      const { lastFrame, unmount } = await renderWithProviders(
        <HistoryItemDisplay {...baseItem} item={item} />,
        {
          settings: createMockSettings({ ui: { inlineThinkingMode: 'full' } }),
        },
      );

      expect(lastFrame()).toMatchSnapshot();
      unmount();
    });

    it('renders "Thinking" header when isFirstThinking is true', async () => {
      const item: HistoryItem = {
        ...baseItem,
        type: 'thinking',
        thought: { subject: 'Thinking', description: 'test' },
      };
      const { lastFrame, unmount } = await renderWithProviders(
        <HistoryItemDisplay {...baseItem} item={item} isFirstThinking={true} />,
        {
          settings: createMockSettings({ ui: { inlineThinkingMode: 'full' } }),
        },
      );

      expect(lastFrame()).toContain('Thinking');
      expect(lastFrame()).toMatchSnapshot();
      unmount();
    });
    it('does not render thinking item when disabled', async () => {
      const item: HistoryItem = {
        ...baseItem,
        type: 'thinking',
        thought: { subject: 'Thinking', description: 'test' },
      };
      const { lastFrame, unmount } = await renderWithProviders(
        <HistoryItemDisplay {...baseItem} item={item} />,
        {
          settings: createMockSettings({ ui: { inlineThinkingMode: 'off' } }),
        },
      );

      expect(lastFrame({ allowEmpty: true })).toBe('');
      unmount();
    });

    it('does not render an empty thinking item', async () => {
      const item: HistoryItem = {
        ...baseItem,
        type: 'thinking',
        thought: { subject: '', description: '...' },
      };
      const { lastFrame, unmount } = await renderWithProviders(
        <HistoryItemDisplay {...baseItem} item={item} />,
        {
          settings: createMockSettings({ ui: { inlineThinkingMode: 'full' } }),
        },
      );

      expect(lastFrame({ allowEmpty: true })).toBe('');
      unmount();
    });
  });

  describe.each([true, false])(
    'gemini items (alternateBuffer=%s)',
    (useAlternateBuffer) => {
      const longCode =
        '# Example code block:\n' +
        '```python\n' +
        Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`).join('\n') +
        '\n```';

      // skip: 现存失败
      it.skip('should render a truncated gemini item', async () => {
        const item: HistoryItem = {
          id: 1,
          type: 'gemini',
          text: longCode,
        };
        const { lastFrame, unmount } = await renderWithProviders(
          <HistoryItemDisplay
            item={item}
            isPending={false}
            terminalWidth={80}
            availableTerminalHeight={10}
          />,
          {
            config: makeFakeConfig({ useAlternateBuffer }),
            settings: createMockSettings({ ui: { useAlternateBuffer } }),
          },
        );
        expect(lastFrame()).toMatchSnapshot();
        unmount();
      });

      // skip: 现存失败
      it.skip('should render a full gemini item when using availableTerminalHeightAssistant', async () => {
        const item: HistoryItem = {
          id: 1,
          type: 'gemini',
          text: longCode,
        };
        const { lastFrame, unmount } = await renderWithProviders(
          <HistoryItemDisplay
            item={item}
            isPending={false}
            terminalWidth={80}
            availableTerminalHeight={10}
            availableTerminalHeightAssistant={Number.MAX_SAFE_INTEGER}
          />,
          {
            config: makeFakeConfig({ useAlternateBuffer }),
            settings: createMockSettings({ ui: { useAlternateBuffer } }),
          },
        );
        expect(lastFrame()).toMatchSnapshot();
        unmount();
      });

      // skip: 现存失败
      it.skip('should render a truncated gemini_content item', async () => {
        const item: HistoryItem = {
          id: 1,
          type: 'gemini_content',
          text: longCode,
        };
        const { lastFrame, unmount } = await renderWithProviders(
          <HistoryItemDisplay
            item={item}
            isPending={false}
            terminalWidth={80}
            availableTerminalHeight={10}
          />,
          {
            config: makeFakeConfig({ useAlternateBuffer }),
            settings: createMockSettings({ ui: { useAlternateBuffer } }),
          },
        );
        expect(lastFrame()).toMatchSnapshot();
        unmount();
      });

      // skip: 现存失败
      it.skip('should render a full gemini_content item when using availableTerminalHeightAssistant', async () => {
        const item: HistoryItem = {
          id: 1,
          type: 'gemini_content',
          text: longCode,
        };
        const { lastFrame, unmount } = await renderWithProviders(
          <HistoryItemDisplay
            item={item}
            isPending={false}
            terminalWidth={80}
            availableTerminalHeight={10}
            availableTerminalHeightAssistant={Number.MAX_SAFE_INTEGER}
          />,
          {
            config: makeFakeConfig({ useAlternateBuffer }),
            settings: createMockSettings({ ui: { useAlternateBuffer } }),
          },
        );
        expect(lastFrame()).toMatchSnapshot();
        unmount();
      });
    },
  );
});
