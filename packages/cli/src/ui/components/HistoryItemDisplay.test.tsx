/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { HistoryItemDisplay } from './HistoryItemDisplay.js';
import { type HistoryItem, ToolCallStatus } from '../types.js';
import { MessageType } from '../types.js';
import { SessionStatsProvider } from '../contexts/SessionContext.js';
import type {
  Config,
  ToolExecuteConfirmationDetails,
} from '@qwen-code/qwen-code-core';
import { ToolGroupMessage } from './messages/ToolGroupMessage.js';
import { renderWithProviders } from '../../test-utils/render.js';
import { LoadedSettings } from '../../config/settings.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { ThoughtExpandedProvider } from '../contexts/ThoughtExpandedContext.js';
import { VirtualViewportContext } from '../contexts/VirtualViewportContext.js';
import type { MouseEvent } from '../utils/mouse.js';
import {
  layoutRowForEvent,
  measureElementPosition,
} from '../utils/measure-element-position.js';

// Mock child components
vi.mock('./messages/ToolGroupMessage.js', () => ({
  ToolGroupMessage: vi.fn(() => <div />),
}));

vi.mock('../hooks/useMouseEvents.js', () => ({
  useMouseEvents: vi.fn(),
}));

vi.mock('../utils/measure-element-position.js', () => ({
  layoutRowForEvent: vi.fn(),
  measureElementPosition: vi.fn(),
}));

import { useMouseEvents } from '../hooks/useMouseEvents.js';

import { toggleKeyHint } from './messages/ConversationMessages.js';

describe('<HistoryItemDisplay />', () => {
  const mockConfig = {
    getChatRecordingService: () => undefined,
  } as unknown as Config;
  const baseItem = {
    id: 1,
    timestamp: 12345,
    isPending: false,
    terminalWidth: 80,
    config: mockConfig,
  };

  it('renders UserMessage for "user" type', () => {
    const item: HistoryItem = {
      ...baseItem,
      type: MessageType.USER,
      text: 'Hello',
    };
    const { lastFrame } = renderWithProviders(
      <HistoryItemDisplay {...baseItem} item={item} />,
    );
    expect(lastFrame()).toContain('Hello');
  });

  it('renders UserMessage for "user" type with slash command', () => {
    const item: HistoryItem = {
      ...baseItem,
      type: MessageType.USER,
      text: '/theme',
    };
    const { lastFrame } = renderWithProviders(
      <HistoryItemDisplay {...baseItem} item={item} />,
    );
    expect(lastFrame()).toContain('/theme');
  });

  it('renders assistant replies with a leading spacer row', () => {
    const item: HistoryItem = {
      id: 1,
      type: 'gemini',
      text: 'Hello',
    };
    const { lastFrame } = renderWithProviders(
      <HistoryItemDisplay item={item} terminalWidth={100} isPending={false} />,
    );

    const output = lastFrame() ?? '';
    expect(output.startsWith('\n')).toBe(true);
    expect(output).toContain('◆ Hello');
  });

  it('renders tool summaries without a leading spacer row', () => {
    const item: HistoryItem = {
      id: 1,
      type: 'tool_use_summary',
      summary: 'Read txt files',
      precedingToolUseIds: ['c1'],
    };
    const { lastFrame } = renderWithProviders(
      <HistoryItemDisplay item={item} terminalWidth={100} isPending={false} />,
    );

    const output = lastFrame() ?? '';
    expect(output.startsWith('\n')).toBe(false);
    expect(output).toContain('Read txt files');
  });

  it('renders the dim ◎ notice for "vision_notice" type', () => {
    const item: HistoryItem = {
      ...baseItem,
      type: MessageType.VISION_NOTICE,
      text: 'Converted 1 image(s) to text via vm.',
    };
    const { lastFrame } = renderWithProviders(
      <HistoryItemDisplay {...baseItem} item={item} />,
    );
    const output = lastFrame() ?? '';
    expect(output).toContain('◎');
    expect(output).toContain('Converted 1 image(s) to text via vm.');
  });

  it('renders StatsDisplay for "stats" type', () => {
    const item: HistoryItem = {
      ...baseItem,
      type: MessageType.STATS,
      duration: '1s',
    };
    const { lastFrame } = renderWithProviders(
      <SessionStatsProvider>
        <HistoryItemDisplay {...baseItem} item={item} />
      </SessionStatsProvider>,
    );
    expect(lastFrame()).toContain('Stats');
  });

  it('renders AboutBox for "about" type', () => {
    const item: HistoryItem = {
      id: 1,
      type: MessageType.ABOUT,
      systemInfo: {
        cliVersion: '1.0.0',
        osPlatform: 'test-os',
        osArch: 'x64',
        osRelease: '22.0.0',
        nodeVersion: 'v20.0.0',
        npmVersion: '10.0.0',
        sandboxEnv: 'test-env',
        modelVersion: 'test-model',
        selectedAuthType: 'test-auth',
        ideClient: 'test-ide',
        sessionId: 'test-session-id',
        memoryUsage: '100 MB',
        baseUrl: undefined,
        gitCommit: undefined,
      },
    };
    const { lastFrame } = renderWithProviders(
      <HistoryItemDisplay {...baseItem} item={item} />,
    );
    expect(lastFrame()).toContain('Status');
  });

  it('renders ModelStatsDisplay for "model_stats" type', () => {
    const item: HistoryItem = {
      ...baseItem,
      type: 'model_stats',
    };
    const { lastFrame } = renderWithProviders(
      <SessionStatsProvider>
        <HistoryItemDisplay {...baseItem} item={item} />
      </SessionStatsProvider>,
    );
    expect(lastFrame()).toContain(
      'No API calls have been made in this session.',
    );
  });

  it('renders ToolStatsDisplay for "tool_stats" type', () => {
    const item: HistoryItem = {
      ...baseItem,
      type: 'tool_stats',
    };
    const { lastFrame } = renderWithProviders(
      <SessionStatsProvider>
        <HistoryItemDisplay {...baseItem} item={item} />
      </SessionStatsProvider>,
    );
    expect(lastFrame()).toContain(
      'No tool calls have been made in this session.',
    );
  });

  it('renders SkillStatsDisplay for "skill_stats" type', () => {
    const item: HistoryItem = {
      ...baseItem,
      type: 'skill_stats',
    };
    const { lastFrame } = renderWithProviders(
      <SessionStatsProvider>
        <HistoryItemDisplay {...baseItem} item={item} />
      </SessionStatsProvider>,
    );
    expect(lastFrame()).toContain(
      'No skill calls have been made in this session.',
    );
  });

  it('renders SessionSummaryDisplay for "quit" type', () => {
    const item: HistoryItem = {
      ...baseItem,
      type: 'quit',
      duration: '1s',
    };
    const { lastFrame } = renderWithProviders(
      <ConfigContext.Provider value={mockConfig as never}>
        <SessionStatsProvider>
          <HistoryItemDisplay {...baseItem} item={item} />
        </SessionStatsProvider>
      </ConfigContext.Provider>,
    );
    expect(lastFrame()).toContain('Agent powering down. Goodbye!');
  });

  it('should escape ANSI codes in text content', () => {
    const historyItem: HistoryItem = {
      id: 1,
      type: 'user',
      text: 'Hello, \u001b[31mred\u001b[0m world!',
    };

    const { lastFrame } = renderWithProviders(
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
  });

  it('should escape ANSI codes in tool confirmation details', () => {
    const historyItem: HistoryItem = {
      id: 1,
      type: 'tool_group',
      tools: [
        {
          callId: '123',
          name: 'run_shell_command',
          description: 'Run a shell command',
          resultDisplay: 'blank',
          status: ToolCallStatus.Confirming,
          confirmationDetails: {
            type: 'exec',
            title: 'Run Shell Command',
            command: 'echo "\u001b[31mhello\u001b[0m"',
            rootCommand: 'echo',
            onConfirm: async () => {},
          },
        },
      ],
    };

    renderWithProviders(
      <HistoryItemDisplay
        item={historyItem}
        terminalWidth={80}
        isPending={false}
      />,
    );

    const passedProps = vi.mocked(ToolGroupMessage).mock.calls[0][0];
    const confirmationDetails = passedProps.toolCalls[0]
      .confirmationDetails as ToolExecuteConfirmationDetails;

    expect(confirmationDetails.command).toBe(
      'echo "\\u001b[31mhello\\u001b[0m"',
    );
  });

  const longCode =
    '# Example code block:\n' +
    '```python\n' +
    Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`).join('\n') +
    '\n```';

  it('should render a truncated gemini item', () => {
    const item: HistoryItem = {
      id: 1,
      type: 'gemini',
      text: longCode,
    };
    const { lastFrame } = renderWithProviders(
      <HistoryItemDisplay
        item={item}
        isPending={false}
        terminalWidth={80}
        availableTerminalHeight={10}
      />,
    );

    expect(lastFrame()).toMatchSnapshot();
  });

  it('should render a full gemini item when using availableTerminalHeightGemini', () => {
    const item: HistoryItem = {
      id: 1,
      type: 'gemini',
      text: longCode,
    };
    const { lastFrame } = renderWithProviders(
      <HistoryItemDisplay
        item={item}
        isPending={false}
        terminalWidth={80}
        availableTerminalHeight={10}
        availableTerminalHeightGemini={Number.MAX_SAFE_INTEGER}
      />,
    );

    expect(lastFrame()).toMatchSnapshot();
  });

  it('should render a truncated gemini_content item', () => {
    const item: HistoryItem = {
      id: 1,
      type: 'gemini_content',
      text: longCode,
    };
    const { lastFrame } = renderWithProviders(
      <HistoryItemDisplay
        item={item}
        isPending={false}
        terminalWidth={80}
        availableTerminalHeight={10}
      />,
    );

    expect(lastFrame()).toMatchSnapshot();
  });

  it('should render a full gemini_content item when using availableTerminalHeightGemini', () => {
    const item: HistoryItem = {
      id: 1,
      type: 'gemini_content',
      text: longCode,
    };
    const { lastFrame } = renderWithProviders(
      <HistoryItemDisplay
        item={item}
        isPending={false}
        terminalWidth={80}
        availableTerminalHeight={10}
        availableTerminalHeightGemini={Number.MAX_SAFE_INTEGER}
      />,
    );

    expect(lastFrame()).toMatchSnapshot();
  });

  it('renders tool_use_summary as a dim badge line in full mode', () => {
    const item: HistoryItem = {
      id: 1,
      type: 'tool_use_summary',
      summary: 'Read txt files',
      precedingToolUseIds: ['c1', 'c2', 'c3', 'c4'],
    };
    const { lastFrame } = renderWithProviders(
      <HistoryItemDisplay
        {...baseItem}
        item={item}
        isPending={false}
        terminalWidth={80}
      />,
    );
    expect(lastFrame()).toContain('Read txt files');
    expect(lastFrame()).toContain('●');
  });

  it('renders committed thinking collapsed by default', () => {
    const item: HistoryItem = {
      id: 1,
      type: 'gemini_thought',
      text: 'Inspecting the repository',
      durationMs: 1200,
    };

    const { lastFrame } = renderWithProviders(
      <HistoryItemDisplay item={item} terminalWidth={100} isPending={false} />,
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('Thought for');
    expect(output).toContain(`${toggleKeyHint} to expand`);
    expect(output).not.toContain('Inspecting the repository');
  });

  it('renders committed thinking continuations hidden by default', () => {
    const item: HistoryItem = {
      id: 1,
      type: 'gemini_thought_content',
      text: 'Continuing the reasoning',
    };

    const { lastFrame } = renderWithProviders(
      <HistoryItemDisplay item={item} terminalWidth={100} isPending={false} />,
    );

    expect(lastFrame()).not.toContain('Continuing the reasoning');
  });

  it('renders committed thinking expanded when ThoughtExpandedProvider is true', () => {
    const item: HistoryItem = {
      id: 1,
      type: 'gemini_thought',
      text: 'Inspecting the repository',
      durationMs: 1200,
    };

    const { lastFrame } = renderWithProviders(
      <ThoughtExpandedProvider
        value={{
          allExpanded: true,
          expandedHeadIds: new Set<number>(),
          toggle: () => {},
        }}
      >
        <HistoryItemDisplay item={item} terminalWidth={100} isPending={false} />
      </ThoughtExpandedProvider>,
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('Thought for');
    expect(output).toContain(`${toggleKeyHint} to collapse`);
    expect(output).toContain('Inspecting the repository');
  });

  it('fullDetail forces a committed thought expanded even when context/prop are collapsed', () => {
    const item: HistoryItem = {
      id: 1,
      type: 'gemini_thought',
      text: 'Inspecting the repository',
      durationMs: 1200,
    };

    // No ThoughtExpandedProvider (context defaults to false) and thoughtExpanded
    // is not passed — fullDetail alone must win and show the full text. This is
    // the transcript's forced-expansion path.
    const { lastFrame } = renderWithProviders(
      <HistoryItemDisplay
        item={item}
        terminalWidth={100}
        isPending={false}
        fullDetail
      />,
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('Thought for');
    expect(output).toContain('Inspecting the repository');
  });

  it('forwards fullDetail to ToolGroupMessage for tool_group items', () => {
    vi.mocked(ToolGroupMessage).mockClear();
    const item: HistoryItem = {
      id: 1,
      type: 'tool_group',
      tools: [
        {
          callId: '123',
          name: 'run_shell_command',
          description: 'Run a shell command',
          resultDisplay: 'done',
          status: ToolCallStatus.Success,
          confirmationDetails: undefined,
        },
      ],
    };

    renderWithProviders(
      <HistoryItemDisplay
        item={item}
        terminalWidth={80}
        isPending={false}
        fullDetail
      />,
    );

    const passedProps = vi.mocked(ToolGroupMessage).mock.calls[0][0];
    expect(passedProps.fullDetail).toBe(true);
  });

  describe('showTimestamps', () => {
    const timestampItem: HistoryItem = {
      ...baseItem,
      type: 'gemini',
      text: 'Hello from assistant',
      timestamp: new Date('2026-01-15T14:30:45').getTime(),
    };

    const makeTimestampSettings = () =>
      new LoadedSettings(
        { path: '', settings: {}, originalSettings: {} },
        { path: '', settings: {}, originalSettings: {} },
        {
          path: '',
          settings: { output: { showTimestamps: true } },
          originalSettings: {},
        },
        { path: '', settings: {}, originalSettings: {} },
        true,
        new Set(),
      );

    it('does not render timestamp when showTimestamps is disabled', () => {
      const { lastFrame } = renderWithProviders(
        <HistoryItemDisplay
          {...baseItem}
          item={timestampItem}
          isPending={false}
        />,
      );
      expect(lastFrame()).not.toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
    });

    it('renders [HH:MM:SS] timestamp when showTimestamps is enabled', () => {
      const { lastFrame } = renderWithProviders(
        <HistoryItemDisplay
          {...baseItem}
          item={timestampItem}
          isPending={false}
        />,
        { settings: makeTimestampSettings() },
      );
      expect(lastFrame()).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
    });

    it('renders timestamp even when isPending is true (streaming)', () => {
      const { lastFrame } = renderWithProviders(
        <HistoryItemDisplay
          {...baseItem}
          item={timestampItem}
          isPending={true}
        />,
        { settings: makeTimestampSettings() },
      );
      expect(lastFrame()).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
    });

    it('does not render timestamp when timestamp field is missing', () => {
      const noTimestampItem: HistoryItem = {
        id: 1,
        type: 'gemini',
        text: 'Hello',
      };
      const { lastFrame } = renderWithProviders(
        <HistoryItemDisplay
          {...baseItem}
          item={noTimestampItem}
          isPending={false}
        />,
        { settings: makeTimestampSettings() },
      );
      expect(lastFrame()).not.toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
    });
  });

  describe('thinking-block mouse tracking is VP-gated (non-VP scroll fix)', () => {
    // A collapsed thinking block arms a click-to-expand mouse handler. The
    // VP-gating itself lives in useMouseEvents (covered by its own test); here
    // we pin the contract that the thinking block subscribes WITHOUT
    // `bypassVpGate`, i.e. it is subject to the gate — so in non-VP it never
    // turns on SGR mouse tracking and native terminal scrollback survives.
    // (Alt+T still expands the block in non-VP.)
    const thoughtItem: HistoryItem = {
      id: 1,
      type: 'gemini_thought',
      text: 'Inspecting the repository',
      durationMs: 1200,
    };

    const settingsWithVp = (enabled: boolean) =>
      new LoadedSettings(
        { path: '', settings: {}, originalSettings: {} },
        { path: '', settings: {}, originalSettings: {} },
        {
          path: '',
          settings: { ui: { useTerminalBuffer: enabled } },
          originalSettings: {},
        },
        { path: '', settings: {}, originalSettings: {} },
        true,
        new Set(),
      );

    const mouseEvent = (name: MouseEvent['name'], col: number): MouseEvent => ({
      name,
      col,
      row: 1,
      shift: false,
      meta: false,
      ctrl: false,
      button: 'left',
    });

    const renderThoughtWithToggle = (toggle: (headId: number) => void) => {
      vi.mocked(measureElementPosition).mockReturnValue({
        x: 0,
        y: 0,
        width: 80,
        height: 3,
      });
      vi.mocked(layoutRowForEvent).mockImplementation((_node, row) => row - 1);
      renderWithProviders(
        <ThoughtExpandedProvider
          value={{
            allExpanded: false,
            expandedHeadIds: new Set<number>(),
            toggle,
          }}
        >
          <HistoryItemDisplay
            item={thoughtItem}
            terminalWidth={100}
            isPending={false}
          />
        </ThoughtExpandedProvider>,
      );
      return vi.mocked(useMouseEvents).mock.calls.at(-1)?.[0];
    };

    it('subscribes the click handler without bypassVpGate (stays VP-gated)', () => {
      vi.mocked(useMouseEvents).mockClear();
      renderWithProviders(
        <HistoryItemDisplay
          item={thoughtItem}
          terminalWidth={100}
          isPending={false}
        />,
      );
      expect(vi.mocked(useMouseEvents)).toHaveBeenCalled();
      const opts = vi.mocked(useMouseEvents).mock.calls.at(-1)?.[1];
      // Collapsed thought → the handler is "active", but it must NOT bypass the
      // VP gate, so useMouseEvents only arms it in VP mode.
      expect(opts?.isActive).toBe(true);
      expect(opts?.bypassVpGate ?? false).toBe(false);
    });

    it('shows the click hint when raw settings are unset but startup VP is enabled', () => {
      const { lastFrame } = renderWithProviders(
        <VirtualViewportContext.Provider value={true}>
          <HistoryItemDisplay
            item={thoughtItem}
            terminalWidth={100}
            isPending={false}
          />
        </VirtualViewportContext.Provider>,
      );

      expect(lastFrame()).toContain(`click or ${toggleKeyHint} to expand`);
    });

    it('hides the click hint when startup VP overrides an enabled setting', () => {
      const { lastFrame } = renderWithProviders(
        <VirtualViewportContext.Provider value={false}>
          <HistoryItemDisplay
            item={thoughtItem}
            terminalWidth={100}
            isPending={false}
          />
        </VirtualViewportContext.Provider>,
        { settings: settingsWithVp(true) },
      );

      expect(lastFrame()).not.toContain(`click or ${toggleKeyHint} to expand`);
    });

    it('toggles on a complete click', () => {
      const toggle = vi.fn();
      const handler = renderThoughtWithToggle(toggle);

      handler?.(mouseEvent('left-press', 5));
      expect(toggle).not.toHaveBeenCalled();
      handler?.(mouseEvent('left-release', 5));
      expect(toggle).toHaveBeenCalledWith(thoughtItem.id);
    });

    it('does not toggle when selecting text by dragging', () => {
      const toggle = vi.fn();
      const handler = renderThoughtWithToggle(toggle);

      handler?.(mouseEvent('left-press', 5));
      handler?.(mouseEvent('move', 20));
      handler?.(mouseEvent('left-release', 20));

      expect(toggle).not.toHaveBeenCalled();
    });
  });
});
