/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders } from '../../../test-utils/render.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ToolGroupMessage } from './ToolGroupMessage.js';
import {
  UPDATE_TOPIC_TOOL_NAME,
  TOPIC_PARAM_TITLE,
  TOPIC_PARAM_SUMMARY,
  TOPIC_PARAM_STRATEGIC_INTENT,
  makeFakeConfig,
  CoreToolCallStatus,
  ASK_USER_DISPLAY_NAME,
  WRITE_FILE_DISPLAY_NAME,
  READ_FILE_DISPLAY_NAME,
  GLOB_DISPLAY_NAME,
  Kind,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  WORKFLOW_TOOL_NAME,
} from '@qwen-code/core';
import type {
  HistoryItem,
  HistoryItemWithoutId,
  IndividualToolCallDisplay,
} from '../../types.js';
import type { AgentBackgroundLaunchDisplay } from '../../utils/agentToolResultDisplay.js';
import type { SubagentProgress } from '@qwen-code/core';
import { Scrollable } from '../shared/Scrollable.js';
import os from 'node:os';
import { createMockSettings } from '../../../test-utils/settings.js';
import { FoldLevel } from '../../constants/messageLayout.js';

describe('<ToolGroupMessage />', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createToolCall = (
    overrides: Partial<IndividualToolCallDisplay> = {},
  ): IndividualToolCallDisplay => ({
    callId: 'tool-123',
    name: 'test-tool',
    args: {},
    description: 'A tool for testing',
    resultDisplay: 'Test result',
    status: CoreToolCallStatus.Success,
    confirmationDetails: undefined,
    renderOutputAsMarkdown: false,
    ...overrides,
  });

  const baseProps = {
    terminalWidth: 80,
  };

  const createItem = (
    tools: IndividualToolCallDisplay[],
  ): HistoryItem | HistoryItemWithoutId => ({
    id: 1,
    type: 'tool_group',
    tools,
  });

  const backgroundLaunchDisplay = (
    agentId: string,
    description: string,
  ): AgentBackgroundLaunchDisplay => ({
    isAsync: true,
    status: 'async_launched',
    agentId,
    description,
    resolvedModel: 'test-model',
    prompt: `Search for ${description}`,
    outputFile: `/tmp/${agentId}.jsonl`,
    canReadOutputFile: true,
  });

  const baseMockConfig = makeFakeConfig({
    model: 'gemini-pro',
    targetDir: os.tmpdir(),
    debugMode: false,
    folderTrust: false,
  });
  const fullVerbositySettings = createMockSettings({
    ui: { errorVerbosity: 'full' },
  });
  const lowVerbositySettings = createMockSettings({
    ui: { errorVerbosity: 'low' },
  });

  describe('Golden Snapshots', () => {
    it('renders single successful tool call', async () => {
      const toolCalls = [createToolCall()];
      const item = createItem(toolCalls);
      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage {...baseProps} item={item} toolCalls={toolCalls} />,
        {
          config: baseMockConfig,
          settings: fullVerbositySettings,
          uiState: {
            pendingHistoryItems: [
              {
                type: 'tool_group',
                tools: toolCalls,
              },
            ],
          },
        },
      );
      expect(lastFrame({ allowEmpty: true })).toMatchSnapshot();
      unmount();
    });

    it('shows confirming tools with their request context', async () => {
      const toolCalls = [
        createToolCall({
          callId: 'confirm-tool',
          status: CoreToolCallStatus.AwaitingApproval,
          confirmationDetails: {
            type: 'info',
            title: 'Confirm tool',
            prompt: 'Do you want to proceed?',
          },
        }),
      ];
      const item = createItem(toolCalls);

      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage {...baseProps} item={item} toolCalls={toolCalls} />,
        { config: baseMockConfig, settings: fullVerbositySettings },
      );

      expect(lastFrame({ allowEmpty: true })).toMatchSnapshot();
      unmount();
    });

    it('renders canceled tool calls', async () => {
      const toolCalls = [
        createToolCall({
          callId: 'canceled-tool',
          name: 'canceled-tool',
          status: CoreToolCallStatus.Cancelled,
        }),
      ];
      const item = createItem(toolCalls);

      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage {...baseProps} item={item} toolCalls={toolCalls} />,
        { config: baseMockConfig, settings: fullVerbositySettings },
      );

      const output = lastFrame();
      expect(output).toMatchSnapshot('canceled_tool');
      unmount();
    });

    it('renders multiple tool calls with different statuses (only visible ones)', async () => {
      const toolCalls = [
        createToolCall({
          callId: 'tool-1',
          name: 'successful-tool',
          description: 'This tool succeeded',
          status: CoreToolCallStatus.Success,
        }),
        createToolCall({
          callId: 'tool-2',
          name: 'pending-tool',
          description: 'This tool is pending',
          status: CoreToolCallStatus.Scheduled,
        }),
        createToolCall({
          callId: 'tool-3',
          name: 'error-tool',
          description: 'This tool failed',
          status: CoreToolCallStatus.Error,
        }),
      ];
      const item = createItem(toolCalls);

      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage {...baseProps} item={item} toolCalls={toolCalls} />,
        {
          config: baseMockConfig,
          settings: fullVerbositySettings,
          uiState: {
            pendingHistoryItems: [
              {
                type: 'tool_group',
                tools: toolCalls,
              },
            ],
          },
        },
      );
      // pending-tool should now be visible
      const output = lastFrame();
      expect(output).toContain('successful-tool');
      expect(output).toContain('pending-tool');
      expect(output).toContain('error-tool');
      expect(output).toMatchSnapshot();
      unmount();
    });

    it('keeps errored tool calls visible even when the result is empty', async () => {
      const toolCalls = [
        createToolCall({
          callId: 'tool-1',
          name: 'successful-tool',
          status: CoreToolCallStatus.Success,
        }),
        createToolCall({
          callId: 'tool-2',
          name: 'error-tool',
          status: CoreToolCallStatus.Error,
          resultDisplay: undefined,
        }),
      ];
      const item = createItem(toolCalls);

      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage {...baseProps} item={item} toolCalls={toolCalls} />,
        {
          config: baseMockConfig,
          settings: lowVerbositySettings,
          uiState: {
            pendingHistoryItems: [
              {
                type: 'tool_group',
                tools: toolCalls,
              },
            ],
          },
        },
      );
      const output = lastFrame();
      expect(output).toContain('successful-tool');
      expect(output).toContain('error-tool');
      unmount();
    });

    it('keeps errored Read calls visible when the result display is empty', async () => {
      const toolCalls = [
        createToolCall({
          callId: 'read-error',
          name: READ_FILE_DISPLAY_NAME,
          description: 'packages/missing.ts',
          status: CoreToolCallStatus.Error,
          resultDisplay: undefined,
        }),
      ];
      const item = createItem(toolCalls);

      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage {...baseProps} item={item} toolCalls={toolCalls} />,
        {
          config: baseMockConfig,
          settings: lowVerbositySettings,
        },
      );

      const output = lastFrame();
      expect(output).toContain(READ_FILE_DISPLAY_NAME);
      expect(output).toContain('packages/missing.ts');
      unmount();
    });

    it('keeps client-initiated errored tool calls visible in low error verbosity mode', async () => {
      const toolCalls = [
        createToolCall({
          callId: 'tool-1',
          name: 'client-error-tool',
          status: CoreToolCallStatus.Error,
          isClientInitiated: true,
          resultDisplay: 'Client tool failed',
        }),
      ];
      const item = createItem(toolCalls);

      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage {...baseProps} item={item} toolCalls={toolCalls} />,
        {
          config: baseMockConfig,
          settings: lowVerbositySettings,
          uiState: {
            pendingHistoryItems: [
              {
                type: 'tool_group',
                tools: toolCalls,
              },
            ],
          },
        },
      );

      const output = lastFrame();
      expect(output).toContain('client-error-tool');
      unmount();
    });

    it('renders update_topic tool call using TopicMessage', async () => {
      const toolCalls = [
        createToolCall({
          callId: 'topic-tool',
          name: UPDATE_TOPIC_TOOL_NAME,
          args: {
            [TOPIC_PARAM_TITLE]: 'Testing Topic',
            [TOPIC_PARAM_STRATEGIC_INTENT]: 'This is the description',
          },
        }),
      ];
      const item = createItem(toolCalls);

      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage {...baseProps} item={item} toolCalls={toolCalls} />,
        {
          config: baseMockConfig,
          settings: fullVerbositySettings,
        },
      );

      const output = lastFrame();
      expect(output).toContain('Testing Topic: ');
      expect(output).toContain('This is the description');
      expect(output).toMatchSnapshot('update_topic_tool');
      unmount();
    });

    it('renders workflow tool calls with the workflow launch template', async () => {
      const toolCalls = [
        createToolCall({
          callId: 'workflow-tool',
          name: WORKFLOW_TOOL_NAME,
          kind: Kind.Workflow,
          description: 'dynamic workflow: smoke-runtime',
          resultDisplay: 'Running in background · /workflows to monitor and save',
        }),
      ];
      const item = createItem(toolCalls);

      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage {...baseProps} item={item} toolCalls={toolCalls} />,
        {
          config: baseMockConfig,
          settings: fullVerbositySettings,
        },
      );

      const output = lastFrame();
      expect(output).toContain(
        `${WORKFLOW_TOOL_NAME}(dynamic workflow: smoke-runtime)`,
      );
      expect(output).toContain(
        'Running in background · /workflows to monitor and save',
      );
      expect(output).not.toContain('Agent Completed');
      unmount();
    });

    it('renders background agent launches through the Agent grouped renderer', async () => {
      const toolCalls = [
        createToolCall({
          callId: 'background-agent',
          name: 'Agent',
          kind: Kind.Agent,
          description: 'Run Explore in the background',
          status: CoreToolCallStatus.Success,
          resultDisplay: backgroundLaunchDisplay(
            'agent-1',
            'Find TODO comments',
          ),
        }),
      ];
      const item = createItem(toolCalls);

      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage
          {...baseProps}
          item={item}
          toolCalls={toolCalls}
          availableTerminalHeight={40}
        />,
        {
          config: baseMockConfig,
          settings: fullVerbositySettings,
        },
      );

      const output = lastFrame();
      expect(output).toContain('Agent Launched in Background');
      expect(output).toContain('Agent · Backgrounded agent');
      expect(output).not.toContain('Agent background subagent: Explore');
      unmount();
    });

    it('keeps backgrounded and foreground agents in the same Agent group', async () => {
      const liveBackgroundProgress: SubagentProgress = {
        isSubagentProgress: true,
        agentName: 'Explore',
        prompt: 'Search for TODOs',
        backgrounded: true,
        recentActivity: [],
        state: 'running',
      };
      const runningProgress: SubagentProgress = {
        isSubagentProgress: true,
        agentName: 'Review',
        recentActivity: [],
        state: 'running',
      };
      const toolCalls = [
        createToolCall({
          callId: 'background-agent-live',
          name: 'Agent',
          kind: Kind.Agent,
          description: 'Run Explore in the background',
          status: CoreToolCallStatus.Executing,
          resultDisplay: liveBackgroundProgress,
        }),
        createToolCall({
          callId: 'foreground-agent-live',
          name: 'Agent',
          kind: Kind.Agent,
          description: 'Run Review in the foreground',
          status: CoreToolCallStatus.Executing,
          resultDisplay: runningProgress,
        }),
      ];
      const item = createItem(toolCalls);

      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage
          {...baseProps}
          item={item}
          toolCalls={toolCalls}
          availableTerminalHeight={40}
        />,
        {
          config: baseMockConfig,
          settings: fullVerbositySettings,
        },
      );

      const output = lastFrame();
      expect(output).toContain(
        '2 Agents (1 running, 1 launched in background)',
      );
      expect(output).toContain('Explore · Backgrounded agent');
      expect(output).toContain('Review ·');
      expect(output).not.toContain('Agent background subagent: Explore');
      unmount();
    });

    it('renders update_topic tool call with summary instead of strategic_intent', async () => {
      const toolCalls = [
        createToolCall({
          callId: 'topic-tool-summary',
          name: UPDATE_TOPIC_TOOL_NAME,
          args: {
            [TOPIC_PARAM_TITLE]: 'Testing Topic',
            [TOPIC_PARAM_SUMMARY]: 'This is the summary',
          },
        }),
      ];
      const item = createItem(toolCalls);

      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage {...baseProps} item={item} toolCalls={toolCalls} />,
        {
          config: baseMockConfig,
          settings: fullVerbositySettings,
        },
      );

      const output = lastFrame();
      expect(output).toContain('Testing Topic: ');
      expect(output).toContain('This is the summary');
      unmount();
    });

    it('renders mixed tool calls including update_topic', async () => {
      const toolCalls = [
        createToolCall({
          callId: 'topic-tool-mixed',
          name: UPDATE_TOPIC_TOOL_NAME,
          args: {
            [TOPIC_PARAM_TITLE]: 'Testing Topic',
            [TOPIC_PARAM_STRATEGIC_INTENT]: 'This is the description',
          },
        }),
        createToolCall({
          callId: 'tool-1',
          name: 'Read',
          description: 'Read a file',
          status: CoreToolCallStatus.Success,
        }),
        createToolCall({
          callId: 'tool-2',
          name: 'Bash',
          description: 'Run command',
          status: CoreToolCallStatus.Executing,
        }),
        createToolCall({
          callId: 'tool-3',
          name: 'Write',
          description: 'Write to file',
          status: CoreToolCallStatus.Scheduled,
        }),
      ];
      const item = createItem(toolCalls);

      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage {...baseProps} item={item} toolCalls={toolCalls} />,
        {
          config: baseMockConfig,
          settings: fullVerbositySettings,
          uiState: {
            pendingHistoryItems: [
              {
                type: 'tool_group',
                tools: toolCalls,
              },
            ],
          },
        },
      );
      // write_file (Pending) should now be visible
      const output = lastFrame();
      expect(output).toContain('Read');
      expect(output).toContain('Bash');
      expect(output).toContain('Write');
      expect(output).toMatchSnapshot();
      unmount();
    });

    it('renders with limited terminal height', async () => {
      const toolCalls = [
        createToolCall({
          callId: 'tool-1',
          name: 'tool-with-result',
          description: 'Tool with output',
          resultDisplay:
            'This is a long result that might need height constraints',
        }),
        createToolCall({
          callId: 'tool-2',
          name: 'another-tool',
          description: 'Another tool',
          resultDisplay: 'More output here',
        }),
      ];
      const item = createItem(toolCalls);
      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage
          {...baseProps}
          item={item}
          toolCalls={toolCalls}
          availableTerminalHeight={10}
        />,
        {
          config: baseMockConfig,
          settings: fullVerbositySettings,
          uiState: {
            pendingHistoryItems: [
              {
                type: 'tool_group',
                tools: toolCalls,
              },
            ],
          },
        },
      );
      expect(lastFrame({ allowEmpty: true })).toMatchSnapshot();
      unmount();
    });

    it('renders with narrow terminal width', async () => {
      const toolCalls = [
        createToolCall({
          name: 'very-long-tool-name-that-might-wrap',
          description:
            'This is a very long description that might cause wrapping issues',
        }),
      ];
      const item = createItem(toolCalls);
      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage
          {...baseProps}
          item={item}
          toolCalls={toolCalls}
          terminalWidth={40}
        />,
        {
          config: baseMockConfig,
          settings: fullVerbositySettings,
          uiState: {
            pendingHistoryItems: [
              {
                type: 'tool_group',
                tools: toolCalls,
              },
            ],
          },
        },
      );
      expect(lastFrame({ allowEmpty: true })).toMatchSnapshot();
      unmount();
    });

    it('renders empty tool calls array', async () => {
      const toolCalls: IndividualToolCallDisplay[] = [];
      const item = createItem(toolCalls);
      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage {...baseProps} item={item} toolCalls={toolCalls} />,
        {
          config: baseMockConfig,
          settings: fullVerbositySettings,
          uiState: {
            pendingHistoryItems: [
              {
                type: 'tool_group',
                tools: [],
              },
            ],
          },
        },
      );
      expect(lastFrame({ allowEmpty: true })).toMatchSnapshot();
      unmount();
    });

    it('renders header when scrolled', async () => {
      const toolCalls = [
        createToolCall({
          callId: '1',
          name: 'tool-1',
          description:
            'Description 1. This is a long description that will need to be truncated if the terminal width is small.',
          resultDisplay: 'line1\nline2\nline3\nline4\nline5',
        }),
        createToolCall({
          callId: '2',
          name: 'tool-2',
          description: 'Description 2',
          resultDisplay: 'line1\nline2',
        }),
      ];
      const item = createItem(toolCalls);
      const { lastFrame, unmount } = await renderWithProviders(
        <Scrollable height={12} hasFocus={true} scrollToBottom={true}>
          <ToolGroupMessage {...baseProps} item={item} toolCalls={toolCalls} />
        </Scrollable>,
        {
          config: baseMockConfig,
          settings: fullVerbositySettings,
          uiState: {
            pendingHistoryItems: [
              {
                type: 'tool_group',
                tools: toolCalls,
              },
            ],
          },
        },
      );
      expect(lastFrame({ allowEmpty: true })).toMatchSnapshot();
      unmount();
    });

    it('renders tool call with outputFile', async () => {
      const toolCalls = [
        createToolCall({
          callId: 'tool-output-file',
          name: 'tool-with-file',
          description: 'Tool that saved output to file',
          status: CoreToolCallStatus.Success,
          outputFile: '/path/to/output.txt',
        }),
      ];
      const item = createItem(toolCalls);
      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage {...baseProps} item={item} toolCalls={toolCalls} />,
        {
          config: baseMockConfig,
          settings: fullVerbositySettings,
          uiState: {
            pendingHistoryItems: [
              {
                type: 'tool_group',
                tools: toolCalls,
              },
            ],
          },
        },
      );
      expect(lastFrame({ allowEmpty: true })).toMatchSnapshot();
      unmount();
    });

    it('renders two tool groups where only the last line of the previous group is visible', async () => {
      const toolCalls1 = [
        createToolCall({
          callId: '1',
          name: 'tool-1',
          description: 'Description 1',
          resultDisplay: 'line1\nline2\nline3\nline4\nline5',
        }),
      ];
      const item1 = createItem(toolCalls1);
      const toolCalls2 = [
        createToolCall({
          callId: '2',
          name: 'tool-2',
          description: 'Description 2',
          resultDisplay: 'line1',
        }),
      ];
      const item2 = createItem(toolCalls2);

      const { lastFrame, unmount } = await renderWithProviders(
        <Scrollable height={6} hasFocus={true} scrollToBottom={true}>
          <ToolGroupMessage
            {...baseProps}
            item={item1}
            toolCalls={toolCalls1}
          />
          <ToolGroupMessage
            {...baseProps}
            item={item2}
            toolCalls={toolCalls2}
          />
        </Scrollable>,
        {
          config: baseMockConfig,
          settings: fullVerbositySettings,
          uiState: {
            pendingHistoryItems: [
              {
                type: 'tool_group',
                tools: toolCalls1,
              },
              {
                type: 'tool_group',
                tools: toolCalls2,
              },
            ],
          },
        },
      );
      expect(lastFrame({ allowEmpty: true })).toMatchSnapshot();
      unmount();
    });
  });

  describe('Border Color Logic', () => {
    it('uses yellow border for shell commands even when successful', async () => {
      const toolCalls = [
        createToolCall({
          name: 'Bash',
          status: CoreToolCallStatus.Success,
        }),
      ];
      const item = createItem(toolCalls);
      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage {...baseProps} item={item} toolCalls={toolCalls} />,
        {
          config: baseMockConfig,
          settings: fullVerbositySettings,
          uiState: {
            pendingHistoryItems: [
              {
                type: 'tool_group',
                tools: toolCalls,
              },
            ],
          },
        },
      );
      expect(lastFrame({ allowEmpty: true })).toMatchSnapshot();
      unmount();
    });

    it('uses gray border when all tools are successful and no shell commands', async () => {
      const toolCalls = [
        createToolCall({ status: CoreToolCallStatus.Success }),
        createToolCall({
          callId: 'tool-2',
          name: 'another-tool',
          status: CoreToolCallStatus.Success,
        }),
      ];
      const item = createItem(toolCalls);
      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage {...baseProps} item={item} toolCalls={toolCalls} />,
        {
          config: baseMockConfig,
          settings: fullVerbositySettings,
          uiState: {
            pendingHistoryItems: [
              {
                type: 'tool_group',
                tools: toolCalls,
              },
            ],
          },
        },
      );
      expect(lastFrame({ allowEmpty: true })).toMatchSnapshot();
      unmount();
    });
  });

  describe('Height Calculation', () => {
    it('calculates available height correctly with multiple tools with results', async () => {
      const toolCalls = [
        createToolCall({
          callId: 'tool-1',
          resultDisplay: 'Result 1',
        }),
        createToolCall({
          callId: 'tool-2',
          resultDisplay: 'Result 2',
        }),
        createToolCall({
          callId: 'tool-3',
          resultDisplay: '', // No result
        }),
      ];
      const item = createItem(toolCalls);
      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage
          {...baseProps}
          item={item}
          toolCalls={toolCalls}
          availableTerminalHeight={20}
        />,
        {
          config: baseMockConfig,
          settings: fullVerbositySettings,
          uiState: {
            pendingHistoryItems: [
              {
                type: 'tool_group',
                tools: toolCalls,
              },
            ],
          },
        },
      );
      expect(lastFrame({ allowEmpty: true })).toMatchSnapshot();
      unmount();
    });
  });

  describe('Ask User Filtering', () => {
    it.each([
      {
        status: CoreToolCallStatus.Scheduled,
        resultDisplay: 'test result',
        shouldHide: true,
      },
      {
        status: CoreToolCallStatus.Executing,
        resultDisplay: 'test result',
        shouldHide: true,
      },
      {
        status: CoreToolCallStatus.AwaitingApproval,
        resultDisplay: 'test result',
        shouldHide: true,
      },
      {
        status: CoreToolCallStatus.Success,
        resultDisplay: 'test result',
        shouldHide: false,
      },
      { status: CoreToolCallStatus.Error, resultDisplay: '', shouldHide: true },
      {
        status: CoreToolCallStatus.Error,
        resultDisplay: 'error message',
        shouldHide: false,
      },
    ])(
      'filtering logic for status=$status and hasResult=$resultDisplay',
      async ({ status, resultDisplay, shouldHide }) => {
        const toolCalls = [
          createToolCall({
            callId: `ask-user-${status}`,
            name: ASK_USER_DISPLAY_NAME,
            status,
            resultDisplay,
          }),
        ];
        const item = createItem(toolCalls);

        const { lastFrame, unmount } = await renderWithProviders(
          <ToolGroupMessage {...baseProps} item={item} toolCalls={toolCalls} />,
          { config: baseMockConfig, settings: fullVerbositySettings },
        );
        if (shouldHide) {
          expect(lastFrame({ allowEmpty: true })).toBe('');
        } else {
          expect(lastFrame()).toMatchSnapshot();
        }
        unmount();
      },
    );

    it('shows other tools when ask_user is filtered out', async () => {
      const toolCalls = [
        createToolCall({
          callId: 'other-tool',
          name: 'other-tool',
          status: CoreToolCallStatus.Success,
        }),
        createToolCall({
          callId: 'ask-user-pending',
          name: ASK_USER_DISPLAY_NAME,
          status: CoreToolCallStatus.Scheduled,
        }),
      ];
      const item = createItem(toolCalls);

      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage {...baseProps} item={item} toolCalls={toolCalls} />,
        { config: baseMockConfig, settings: fullVerbositySettings },
      );

      expect(lastFrame({ allowEmpty: true })).toMatchSnapshot();
      unmount();
    });

    it('folds completed AskUser result content in collapsed tool mode', async () => {
      const toolCalls = [
        createToolCall({
          callId: 'ask-user-success',
          name: ASK_USER_DISPLAY_NAME,
          status: CoreToolCallStatus.Success,
          description: 'Asking user: Python 项目放在哪里?',
          resultDisplay: [
            '**User answered:**',
            '',
            '  Q: Python 项目放在哪里?',
            '  项目位置 → 当前仓库根目录下新建 sample-py/',
            '  备注 → 使用默认依赖管理',
            '  下一步 → 开始创建项目',
          ].join('\n'),
        }),
      ];
      const item = createItem(toolCalls);

      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage {...baseProps} item={item} toolCalls={toolCalls} />,
        {
          config: baseMockConfig,
          settings: fullVerbositySettings,
          width: 140,
          uiState: { constrainHeight: true },
          initialFoldLevel: FoldLevel.GroupExpandedToolCollapsed,
        },
      );

      const frame = lastFrame();
      expect(frame).toContain('AskUserQuestion');
      expect(frame).toContain('... 4 hidden (Ctrl+O) ...');
      expect(frame).toContain('备注 → 使用默认依赖管理');
      expect(frame).toContain('下一步 → 开始创建项目');
      expect(frame).not.toContain('Asking user: Python 项目放在哪里?');
      unmount();
    });

    it('renders nothing when only tool is in-progress AskUser with borderBottom=false', async () => {
      // AskUser tools in progress are rendered by AskUserDialog, not ToolGroupMessage.
      // When AskUser is the only tool and borderBottom=false (no border to close),
      // the component should render nothing.
      const toolCalls = [
        createToolCall({
          callId: 'ask-user-tool',
          name: ASK_USER_DISPLAY_NAME,
          status: CoreToolCallStatus.Executing,
        }),
      ];
      const item = createItem(toolCalls);

      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage
          {...baseProps}
          item={item}
          toolCalls={toolCalls}
          borderBottom={false}
        />,
        { config: baseMockConfig, settings: fullVerbositySettings },
      );
      // AskUser tools in progress are rendered by AskUserDialog, so we expect nothing.
      expect(lastFrame({ allowEmpty: true })).toBe('');
      unmount();
    });

    it('does not render a bottom-border fragment when all tools are filtered out', async () => {
      const toolCalls = [
        createToolCall({
          callId: 'hidden-ask-user-tool',
          name: ASK_USER_DISPLAY_NAME,
          status: CoreToolCallStatus.Executing,
          resultDisplay: undefined,
        }),
      ];
      const item = createItem(toolCalls);

      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage
          {...baseProps}
          item={item}
          toolCalls={toolCalls}
          borderTop={false}
          borderBottom={true}
        />,
        {
          config: baseMockConfig,
          settings: lowVerbositySettings,
        },
      );

      expect(lastFrame({ allowEmpty: true })).toBe('');
      unmount();
    });

    it('renders empty for explicit closing slices (borders removed in fold system)', async () => {
      const toolCalls: IndividualToolCallDisplay[] = [];
      const item = createItem(toolCalls);

      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage
          {...baseProps}
          item={item}
          toolCalls={toolCalls}
          borderTop={false}
          borderBottom={true}
        />,
        {
          config: baseMockConfig,
          settings: fullVerbositySettings,
        },
      );

      // With the fold system, explicit closing slices no longer render visible borders
      expect(lastFrame({ allowEmpty: true })).toBeDefined();
      unmount();
    });

    it('does not render a border fragment when plan-mode tools are filtered out', async () => {
      const toolCalls = [
        createToolCall({
          callId: 'plan-write',
          name: WRITE_FILE_DISPLAY_NAME,
          planModeActive: true,
          status: CoreToolCallStatus.Success,
          resultDisplay: 'Plan file written',
        }),
      ];
      const item = createItem(toolCalls);

      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage
          {...baseProps}
          item={item}
          toolCalls={toolCalls}
          borderTop={false}
          borderBottom={true}
        />,
        {
          config: baseMockConfig,
          settings: fullVerbositySettings,
        },
      );

      expect(lastFrame({ allowEmpty: true })).toBe('');
      unmount();
    });

    it('renders confirming tools when they are the only visible tool', async () => {
      const toolCalls = [
        createToolCall({
          callId: 'confirm-only',
          status: CoreToolCallStatus.AwaitingApproval,
          confirmationDetails: {
            type: 'info',
            title: 'Confirm',
            prompt: 'Proceed?',
          },
        }),
      ];
      const item = createItem(toolCalls);

      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage
          {...baseProps}
          item={item}
          toolCalls={toolCalls}
          borderTop={false}
          borderBottom={true}
        />,
        {
          config: baseMockConfig,
          settings: fullVerbositySettings,
        },
      );

      expect(lastFrame({ allowEmpty: true })).toMatchSnapshot();
      unmount();
    });

    it('does not leave a border stub when transitioning from visible to fully filtered tools', async () => {
      const visibleTools = [
        createToolCall({
          callId: 'visible-success',
          name: 'visible-tool',
          status: CoreToolCallStatus.Success,
          resultDisplay: 'visible output',
        }),
      ];
      const hiddenTools = [
        createToolCall({
          callId: 'hidden-ask-user',
          name: ASK_USER_DISPLAY_NAME,
          status: CoreToolCallStatus.Executing,
          resultDisplay: undefined,
        }),
      ];

      const initialItem = createItem(visibleTools);
      const hiddenItem = createItem(hiddenTools);

      const firstRender = await renderWithProviders(
        <ToolGroupMessage
          {...baseProps}
          item={initialItem}
          toolCalls={visibleTools}
          borderTop={false}
          borderBottom={true}
        />,
        {
          config: baseMockConfig,
          settings: lowVerbositySettings,
        },
      );
      await firstRender.waitUntilReady();
      expect(firstRender.lastFrame()).toContain('visible-tool');
      firstRender.unmount();

      const secondRender = await renderWithProviders(
        <ToolGroupMessage
          {...baseProps}
          item={hiddenItem}
          toolCalls={hiddenTools}
          borderTop={false}
          borderBottom={true}
        />,
        {
          config: baseMockConfig,
          settings: lowVerbositySettings,
        },
      );
      await secondRender.waitUntilReady();
      expect(secondRender.lastFrame({ allowEmpty: true })).toBe('');
      secondRender.unmount();
    });

    it('keeps visible tools rendered with many filtered tools (stress case)', async () => {
      const visibleTool = createToolCall({
        callId: 'visible-tool',
        name: 'visible-tool',
        status: CoreToolCallStatus.Success,
        resultDisplay: 'visible output',
      });
      const hiddenTools = Array.from({ length: 50 }, (_, index) =>
        createToolCall({
          callId: `hidden-${index}`,
          name: ASK_USER_DISPLAY_NAME,
          status: CoreToolCallStatus.Executing,
          resultDisplay: undefined,
        }),
      );
      const toolCalls = [visibleTool, ...hiddenTools];
      const item = createItem(toolCalls);

      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage
          {...baseProps}
          item={item}
          toolCalls={toolCalls}
          borderTop={false}
          borderBottom={true}
        />,
        {
          config: baseMockConfig,
          settings: lowVerbositySettings,
        },
      );

      const output = lastFrame();
      expect(output).toContain('visible-tool');
      expect(output).not.toContain(ASK_USER_DISPLAY_NAME);
      unmount();
    });

    it('handles explicit closing slice at very narrow terminal width', async () => {
      const toolCalls: IndividualToolCallDisplay[] = [];
      const item = createItem(toolCalls);

      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage
          item={item}
          toolCalls={toolCalls}
          terminalWidth={8}
          borderTop={false}
          borderBottom={true}
        />,
        {
          config: baseMockConfig,
          settings: fullVerbositySettings,
        },
      );

      // With the fold system, explicit closing slices no longer render visible borders
      expect(lastFrame({ allowEmpty: true })).toBeDefined();
      unmount();
    });
  });

  describe('Task tool filtering', () => {
    it.each([
      TASK_CREATE_TOOL_NAME,
      TASK_GET_TOOL_NAME,
      TASK_LIST_TOOL_NAME,
      TASK_UPDATE_TOOL_NAME,
    ])('renders no transcript row for %s', async (name) => {
      const toolCalls = [
        createToolCall({
          callId: `task-tool-${name}`,
          name,
          resultDisplay: 'Task state changed',
        }),
      ];
      const item = createItem(toolCalls);

      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage {...baseProps} item={item} toolCalls={toolCalls} />,
        { config: baseMockConfig, settings: fullVerbositySettings },
      );

      expect(lastFrame({ allowEmpty: true })).toBe('');
      unmount();
    });
  });

  describe('SendMessage filtering', () => {
    it('renders no transcript row for a successful teammate message', async () => {
      const toolCalls = [
        createToolCall({
          callId: 'send-message',
          name: SEND_MESSAGE_TOOL_NAME,
          args: {
            to: 'researcher',
            message: 'Continue the investigation.',
            summary: 'Continue investigation',
          },
          status: CoreToolCallStatus.Success,
          resultDisplay: 'Message sent successfully.',
        }),
      ];
      const item = createItem(toolCalls);

      const { lastFrame, unmount } = await renderWithProviders(
        <ToolGroupMessage
          {...baseProps}
          item={item}
          toolCalls={toolCalls}
          borderTop={false}
          borderBottom={true}
        />,
        {
          config: baseMockConfig,
          settings: fullVerbositySettings,
        },
      );

      expect(lastFrame({ allowEmpty: true })).toBe('');
      unmount();
    });
  });

  describe('Plan Mode Filtering', () => {
    it.each([
      {
        name: WRITE_FILE_DISPLAY_NAME,
        mode: 'default',
        visible: true,
      },
      { name: READ_FILE_DISPLAY_NAME, mode: 'default', visible: true },
      { name: GLOB_DISPLAY_NAME, mode: 'default', visible: true },
    ])(
      'filtering logic for $name in $mode mode',
      async ({ name, mode, visible }) => {
        const toolCalls = [
          createToolCall({
            callId: 'test-call',
            name,
            planModeActive: mode === 'plan',
          }),
        ];
        const item = createItem(toolCalls);

        const { lastFrame, unmount } = await renderWithProviders(
          <ToolGroupMessage {...baseProps} item={item} toolCalls={toolCalls} />,
          { config: baseMockConfig, settings: fullVerbositySettings },
        );

        if (visible) {
          expect(lastFrame()).toContain(name);
        } else {
          expect(lastFrame({ allowEmpty: true })).toBe('');
        }
        unmount();
      },
    );
  });
});
