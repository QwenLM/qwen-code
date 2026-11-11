/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { waitFor } from '../../../test-utils/async.js';
import { renderWithProviders } from '../../../test-utils/render.js';
import {
  getTeammateLaunchIdentity,
  SubagentGroupDisplay,
} from './SubagentGroupDisplay.js';
import {
  AgentTerminateMode,
  Kind,
  CoreToolCallStatus,
  TaskRegistry,
  type Message,
} from '@qwen-code/core';
import type { IndividualToolCallDisplay } from '../../types.js';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { Text } from 'ink';
import type {
  AgentBackgroundLaunchDisplay,
  AgentTeammateSpawnDisplay,
} from '../../utils/agentToolResultDisplay.js';
import { resolveAgentColor } from '../../utils/agentColors.js';
import { TaskRegistryProvider } from '../../contexts/TaskRegistryContext.js';

const mockUseAgentTranscript = vi.hoisted(() => vi.fn());
const mockInkApp = vi.hoisted(() => ({
  requestTranscriptReplacement: vi.fn(),
}));

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    useApp: () => mockInkApp,
  };
});

vi.mock('../../hooks/useAgentTranscript.js', () => ({
  useAgentTranscript: mockUseAgentTranscript,
}));

vi.mock('../../utils/MarkdownDisplay.js', () => ({
  MarkdownDisplay: ({ text }: { text: string }) => <Text>{text}</Text>,
}));

vi.mock('ink-spinner', () => ({
  default: () => <Text>◉</Text>,
}));

describe('<SubagentGroupDisplay />', () => {
  beforeEach(() => {
    mockUseAgentTranscript.mockReset();
    mockInkApp.requestTranscriptReplacement.mockReset();
    mockUseAgentTranscript.mockReturnValue({
      messages: [],
      loading: false,
    });
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

  const mockToolCalls: IndividualToolCallDisplay[] = [
    {
      callId: 'call-1',
      name: 'agent_1',
      description: 'Test agent 1',
      confirmationDetails: undefined,
      status: CoreToolCallStatus.Executing,
      kind: Kind.Agent,
      resultDisplay: {
        isSubagentProgress: true,
        agentName: 'api-monitor',
        state: 'running',
        recentActivity: [
          {
            id: 'act-1',
            type: 'tool_call',
            status: 'running',
            content: '',
            displayName: 'Action Required',
            description: 'Verify server is running',
          },
        ],
      },
    },
    {
      callId: 'call-2',
      name: 'agent_2',
      description: 'Test agent 2',
      confirmationDetails: undefined,
      status: CoreToolCallStatus.Success,
      kind: Kind.Agent,
      resultDisplay: {
        isSubagentProgress: true,
        agentName: 'db-manager',
        state: 'completed',
        result: 'Database schema validated',
        recentActivity: [
          {
            id: 'act-2',
            type: 'thought',
            status: 'completed',
            content: 'Database schema validated',
          },
        ],
      },
    },
  ];

  const renderSubagentGroup = async (
    toolCallsToRender: IndividualToolCallDisplay[],
    height?: number,
  ) =>
    renderWithProviders(
      <SubagentGroupDisplay
        toolCalls={toolCallsToRender}
        terminalWidth={80}
        availableTerminalHeight={height}
        isExpandable={true}
      />,
    );

  it('renders nothing if there are no agent tool calls', async () => {
    const { lastFrame } = await renderSubagentGroup([], 40);
    expect(lastFrame({ allowEmpty: true })).toBe('');
  });

  it('renders collapsed view by default with correct agent counts and states', async () => {
    const { lastFrame } = await renderSubagentGroup(mockToolCalls, 40);
    expect(lastFrame()).toMatchSnapshot();
  });

  it('renders launched teammates as foreground-colored @name identities', async () => {
    const teammateLaunch = (
      agentId: string,
      name: string,
      color: 'red' | 'blue',
    ): AgentTeammateSpawnDisplay => ({
      status: 'teammate_spawned',
      prompt: `Work as ${name}.`,
      teammate_id: agentId,
      agent_id: agentId,
      agent_type: 'general-purpose',
      model: 'test-model',
      name,
      color,
      tmux_session_name: 'in-process',
      tmux_window_name: 'in-process',
      tmux_pane_id: 'in-process',
      team_name: 'session-abcdef12',
      is_splitpane: false,
      plan_mode_required: false,
    });
    const toolCalls: IndividualToolCallDisplay[] = [
      {
        ...mockToolCalls[0],
        callId: 'red-teammate',
        resultDisplay: teammateLaunch('agent-red', 'researcher', 'red'),
        status: CoreToolCallStatus.Success,
      },
      {
        ...mockToolCalls[1],
        callId: 'blue-teammate',
        resultDisplay: teammateLaunch('agent-blue', 'reviewer', 'blue'),
        status: CoreToolCallStatus.Success,
      },
    ];

    const { lastFrame } = await renderSubagentGroup(toolCalls, 40);

    expect(lastFrame()).toContain('@researcher · Teammate');
    expect(lastFrame()).toContain('@reviewer · Teammate');
    expect(getTeammateLaunchIdentity(toolCalls[0].resultDisplay, 'agent')).toEqual({
      name: '@researcher',
      textColor: resolveAgentColor('red'),
    });
    expect(getTeammateLaunchIdentity(toolCalls[1].resultDisplay, 'agent')).toEqual({
      name: '@reviewer',
      textColor: resolveAgentColor('blue'),
    });
  });

  it('renders the effective limit when an agent reaches maxTurns', async () => {
    const maxTurnsToolCall: IndividualToolCallDisplay = {
      ...mockToolCalls[1],
      status: CoreToolCallStatus.Error,
      resultDisplay: {
        isSubagentProgress: true,
        agentName: 'long-reviewer',
        state: 'completed',
        result: 'Partial review result',
        terminateReason: AgentTerminateMode.MAX_TURNS,
        terminationDetails: { maxTurns: 150 },
        recentActivity: [],
      },
    };

    const { lastFrame, rerender } = await renderSubagentGroup(
      [maxTurnsToolCall],
      40,
    );

    expect(lastFrame()).toContain(
      'Reached max turns (150); increase maxTurns to continue.',
    );

    rerender(
      <SubagentGroupDisplay
        toolCalls={[maxTurnsToolCall]}
        terminalWidth={100}
        availableTerminalHeight={undefined}
        isExpandable={true}
      />,
    );
    await waitFor(() => {
      expect(lastFrame()).toContain('Reached the maximum turn limit (150).');
      expect(lastFrame()).toContain('Increase maxTurns');
      expect(lastFrame()).toContain('configuration and retry.');
    });
  });

  it('renders cancelled header when every parallel agent is cancelled', async () => {
    const cancelledToolCalls = mockToolCalls.map((toolCall, index) => ({
      ...toolCall,
      status: CoreToolCallStatus.Cancelled,
      resultDisplay: {
        isSubagentProgress: true,
        agentName: `cancelled-agent-${index + 1}`,
        state: 'cancelled',
        result: 'User cancelled.',
        recentActivity: [
          {
            id: `cancelled-${index + 1}`,
            type: 'thought',
            status: 'cancelled',
            content: 'Request cancelled.',
          },
        ],
      },
    })) as IndividualToolCallDisplay[];

    const { lastFrame } = await renderSubagentGroup(cancelledToolCalls, 40);

    expect(lastFrame()).toContain('2 Agents Cancelled');
  });

  it('renders user-cancelled summary instead of last activity after cancellation', async () => {
    const cancelledToolCalls: IndividualToolCallDisplay[] = [
      {
        ...mockToolCalls[0],
        status: CoreToolCallStatus.Cancelled,
        resultDisplay: {
          isSubagentProgress: true,
          agentName: 'explorer',
          state: 'cancelled',
          result: 'User cancelled.',
          recentActivity: [
            {
              id: 'cancelled-tool',
              type: 'tool_call',
              status: 'cancelled',
              content: 'Glob',
              displayName: 'Glob',
              description: '**/package.json',
            },
          ],
        },
      },
      {
        ...mockToolCalls[1],
        status: CoreToolCallStatus.Cancelled,
        resultDisplay: {
          isSubagentProgress: true,
          agentName: 'reviewer',
          state: 'cancelled',
          result: 'User cancelled.',
          recentActivity: [
            {
              id: 'cancelled-thought',
              type: 'thought',
              status: 'cancelled',
              content: 'Request cancelled.',
            },
          ],
        },
      },
    ];

    const { lastFrame } = await renderSubagentGroup(cancelledToolCalls, 40);

    expect(lastFrame()).toContain('explorer · User cancelled.');
    expect(lastFrame()).toContain('reviewer · User cancelled.');
    expect(lastFrame()).not.toContain('explorer · Glob **/package.json');
    expect(lastFrame()).not.toContain('reviewer · 💭 Request cancelled.');
  });

  it('renders background launches without implying agent completion', async () => {
    const backgroundToolCalls: IndividualToolCallDisplay[] = [
      {
        callId: 'bg-1',
        name: 'Explore',
        description: 'Find TODO comments',
        confirmationDetails: undefined,
        status: CoreToolCallStatus.Success,
        kind: Kind.Agent,
        resultDisplay: backgroundLaunchDisplay('agent-1', 'Find TODO comments'),
      },
      {
        callId: 'bg-2',
        name: 'Explore',
        description: 'Find FIXME comments',
        confirmationDetails: undefined,
        status: CoreToolCallStatus.Success,
        kind: Kind.Agent,
        resultDisplay: backgroundLaunchDisplay('agent-2', 'Find FIXME comments'),
      },
    ];

    const { lastFrame } = await renderSubagentGroup(
      backgroundToolCalls,
      40,
    );

    expect(lastFrame()).toContain('2 Agents Launched in Background');
    expect(lastFrame()).toContain('Explore · Backgrounded agent');
    expect(lastFrame()).not.toContain('Prompt:');
    expect(lastFrame()).not.toContain('Completed successfully');

    const { lastFrame: expandedFrame } = await renderSubagentGroup(
      backgroundToolCalls,
      undefined,
    );

    await waitFor(() => {
      expect(expandedFrame()).toContain('Explore · Backgrounded agent');
      expect(expandedFrame()).toContain(
        'Prompt: Search for Find TODO comments',
      );
      expect(expandedFrame()).toContain(
        'Prompt: Search for Find FIXME comments',
      );
      expect(expandedFrame()).not.toContain('Completed successfully');
    });
  });

  it('uses sidechain status for collapsed state and sidechain progress for expanded details', async () => {
    const erroredParentWithCompletedSidechain = mockToolCalls[1];
    const erroredToolCalls: IndividualToolCallDisplay[] = [
      {
        ...erroredParentWithCompletedSidechain,
        status: CoreToolCallStatus.Error,
        resultDisplay: {
          isSubagentProgress: true,
          agentName: 'finished-agent',
          state: 'completed',
          result: 'Finished before the parent turn was cancelled.',
          recentActivity: [
            {
              id: 'finished-read',
              type: 'tool_call',
              status: 'completed',
              content: 'Read',
              displayName: 'Read',
              description: 'package.json',
            },
          ],
        },
      },
      {
        ...mockToolCalls[0],
        status: CoreToolCallStatus.Error,
        resultDisplay: {
          isSubagentProgress: true,
          agentName: 'interrupted-agent',
          state: 'cancelled',
          result: 'User cancelled.',
          recentActivity: [
            {
              id: 'cancelled-thought',
              type: 'thought',
              status: 'cancelled',
              content: 'Request cancelled.',
            },
          ],
        },
      },
    ];

    const { lastFrame, rerender } = await renderSubagentGroup(
      erroredToolCalls,
      40,
    );

    expect(lastFrame()).toContain('2 Agents (1 completed, 1 cancelled)...');
    expect(lastFrame()).toContain('finished-agent · Completed successfully');

    rerender(
      <SubagentGroupDisplay
        toolCalls={erroredToolCalls}
        terminalWidth={80}
        availableTerminalHeight={undefined}
        isExpandable={true}
      />,
    );

    await waitFor(() => {
      expect(lastFrame()).toContain(
        'finished-agent · Completed successfully.',
      );
      expect(lastFrame()).toContain('interrupted-agent · User cancelled.');
    });
  });

  it('expands when availableTerminalHeight is undefined', async () => {
    const { lastFrame, rerender } = await renderSubagentGroup(
      mockToolCalls,
      40,
    );

    // Default collapsed view
    await waitFor(() => {
      expect(lastFrame()).toContain('(Ctrl+O to expand)');
    });

    // Expand view
    rerender(
      <SubagentGroupDisplay
        toolCalls={mockToolCalls}
        terminalWidth={80}
        availableTerminalHeight={undefined}
        isExpandable={true}
      />,
    );
    await waitFor(() => {
      expect(lastFrame()).toContain('collapse)');
    });

    // Collapse view
    rerender(
      <SubagentGroupDisplay
        toolCalls={mockToolCalls}
        terminalWidth={80}
        availableTerminalHeight={40}
        isExpandable={true}
      />,
    );
    await waitFor(() => {
      expect(lastFrame()).toContain('expand)');
    });
  });

  it('lazy-loads complete history while parent progress stays bounded', async () => {
    mockUseAgentTranscript.mockReturnValue({
      messages: transcriptMessagesForTools([
        {
          id: 'tool-earlier',
          name: 'Read',
          input: { file_path: '/workspace/earlier.txt' },
          result: 'earlier contents',
        },
        {
          id: 'tool-latest',
          name: 'Grep',
          input: { pattern: 'latest', path: 'src' },
          result: 'src/latest.ts',
        },
      ]),
      loading: false,
    });
    const progress = {
      isSubagentProgress: true as const,
      agentId: 'agent-transcript',
      agentName: 'history-agent',
      state: 'running' as const,
      recentActivity: [
        {
          id: 'tool-latest',
          type: 'tool_call' as const,
          content: 'Grep',
          description: "'latest' within src",
          status: 'running' as const,
        },
      ],
    };
    const toolCall: IndividualToolCallDisplay = {
      callId: 'agent-call',
      name: 'history-agent',
      description: '',
      confirmationDetails: undefined,
      status: CoreToolCallStatus.Executing,
      kind: Kind.Agent,
      resultDisplay: progress,
    };

    const { lastFrame, unmount } = await renderSubagentGroup(
      [toolCall],
      undefined,
    );

    await waitFor(() => {
      expect(lastFrame()).toContain('earlier.txt');
      expect(lastFrame()).toContain('latest');
      expect(lastFrame()).toContain('Read 1 line');
      expect(lastFrame()).not.toContain('Loading transcript...');
    });
    unmount();
  });

  it('replaces overflowing native scrollback when lazy loading settles', async () => {
    mockUseAgentTranscript.mockReturnValue({
      messages: [],
      loading: true,
    });
    const progress = {
      isSubagentProgress: true as const,
      agentId: 'agent-transcript-replacement',
      agentName: 'history-agent',
      state: 'completed' as const,
      result: 'Done',
      recentActivity: [],
    };
    const toolCall: IndividualToolCallDisplay = {
      callId: 'agent-transcript-replacement-call',
      name: 'history-agent',
      description: '',
      confirmationDetails: undefined,
      status: CoreToolCallStatus.Success,
      kind: Kind.Agent,
      resultDisplay: progress,
    };

    const { lastFrame, rerender, unmount } = await renderSubagentGroup(
      [toolCall],
      undefined,
    );
    expect(lastFrame()).toContain('Loading transcript...');
    expect(mockInkApp.requestTranscriptReplacement).not.toHaveBeenCalled();

    mockUseAgentTranscript.mockReturnValue({
      messages: transcriptMessagesForTools([
        {
          id: 'tool-loaded',
          name: 'Read',
          input: { file_path: '/workspace/loaded.txt' },
          result: 'loaded contents',
        },
      ]),
      loading: false,
    });
    rerender(
      <SubagentGroupDisplay
        toolCalls={[toolCall]}
        terminalWidth={80}
        availableTerminalHeight={undefined}
        isExpandable={true}
      />,
    );

    await waitFor(() => {
      expect(lastFrame()).toContain('workspace/loaded');
      expect(lastFrame()).not.toContain('Loading transcript...');
      expect(mockInkApp.requestTranscriptReplacement).toHaveBeenCalledTimes(1);
    });

    rerender(
      <SubagentGroupDisplay
        toolCalls={[toolCall]}
        terminalWidth={80}
        availableTerminalHeight={undefined}
        isExpandable={true}
      />,
    );
    expect(mockInkApp.requestTranscriptReplacement).toHaveBeenCalledTimes(1);

    mockUseAgentTranscript.mockReturnValue({
      messages: transcriptMessagesForTools([
        {
          id: 'tool-loaded',
          name: 'Read',
          input: { file_path: '/workspace/loaded.txt' },
          result: 'loaded contents',
        },
      ]),
      loading: true,
    });
    rerender(
      <SubagentGroupDisplay
        toolCalls={[toolCall]}
        terminalWidth={80}
        availableTerminalHeight={undefined}
        isExpandable={true}
      />,
    );
    await Promise.resolve();
    expect(mockInkApp.requestTranscriptReplacement).toHaveBeenCalledTimes(1);

    mockUseAgentTranscript.mockReturnValue({
      messages: transcriptMessagesForTools([
        {
          id: 'tool-loaded',
          name: 'Read',
          input: { file_path: '/workspace/loaded.txt' },
          result: 'loaded contents',
        },
      ]),
      loading: false,
    });
    rerender(
      <SubagentGroupDisplay
        toolCalls={[toolCall]}
        terminalWidth={80}
        availableTerminalHeight={undefined}
        isExpandable={true}
      />,
    );
    await Promise.resolve();
    expect(mockInkApp.requestTranscriptReplacement).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('replaces the transcript once after a parallel load batch settles', async () => {
    const loadingByAgent = new Map([
      ['agent-batch-1', true],
      ['agent-batch-2', true],
      ['agent-batch-3', true],
    ]);
    mockUseAgentTranscript.mockImplementation(
      (source: { agentId?: string } | undefined) => ({
        messages: [],
        loading: loadingByAgent.get(source?.agentId ?? '') ?? false,
      }),
    );
    const toolCalls: IndividualToolCallDisplay[] = [1, 2, 3].map((index) => ({
      callId: `agent-batch-call-${index}`,
      name: 'history-agent',
      description: '',
      confirmationDetails: undefined,
      status: CoreToolCallStatus.Success,
      kind: Kind.Agent,
      resultDisplay: {
        isSubagentProgress: true,
        agentId: `agent-batch-${index}`,
        agentName: 'history-agent',
        state: 'completed',
        result: `Done ${index}`,
        recentActivity: [],
      },
    }));
    const expandedGroup = () => (
      <SubagentGroupDisplay
        toolCalls={toolCalls}
        terminalWidth={80}
        availableTerminalHeight={undefined}
        isExpandable={true}
      />
    );

    const { rerender, unmount } = await renderSubagentGroup(
      toolCalls,
      undefined,
    );
    expect(mockInkApp.requestTranscriptReplacement).not.toHaveBeenCalled();

    loadingByAgent.set('agent-batch-1', false);
    rerender(expandedGroup());
    expect(mockInkApp.requestTranscriptReplacement).not.toHaveBeenCalled();

    loadingByAgent.set('agent-batch-2', false);
    rerender(expandedGroup());
    expect(mockInkApp.requestTranscriptReplacement).not.toHaveBeenCalled();

    loadingByAgent.set('agent-batch-3', false);
    rerender(expandedGroup());
    await waitFor(() => {
      expect(mockInkApp.requestTranscriptReplacement).toHaveBeenCalledTimes(1);
    });

    const addedToolCall: IndividualToolCallDisplay = {
      ...toolCalls[0],
      callId: 'agent-batch-call-4',
      resultDisplay: {
        isSubagentProgress: true,
        agentId: 'agent-batch-4',
        agentName: 'history-agent',
        state: 'running',
        recentActivity: [],
      },
    };
    loadingByAgent.set('agent-batch-4', true);
    rerender(
      <SubagentGroupDisplay
        toolCalls={[...toolCalls, addedToolCall]}
        terminalWidth={80}
        availableTerminalHeight={undefined}
        isExpandable={true}
      />,
    );
    loadingByAgent.set('agent-batch-4', false);
    rerender(
      <SubagentGroupDisplay
        toolCalls={[...toolCalls, addedToolCall]}
        terminalWidth={80}
        availableTerminalHeight={undefined}
        isExpandable={true}
      />,
    );
    await Promise.resolve();
    expect(mockInkApp.requestTranscriptReplacement).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('renders complete Bash results loaded from the transcript', async () => {
    mockUseAgentTranscript.mockReturnValue({
      messages: transcriptMessagesForTools(
        Array.from({ length: 6 }, (_, index) => ({
          id: `read-${index}`,
          name: 'Bash',
          input: { command: `printf document-${index}-contents` },
          result: `document-${index}-contents`,
        })),
      ),
      loading: false,
    });
    const progress = {
      isSubagentProgress: true as const,
      agentId: 'agent-parallel-read',
      agentName: 'parallel-reader',
      state: 'completed' as const,
      recentActivity: transcriptMessagesForReadFallback(),
    };
    const toolCall: IndividualToolCallDisplay = {
      callId: 'agent-parallel-read-call',
      name: 'parallel-reader',
      description: '',
      confirmationDetails: undefined,
      status: CoreToolCallStatus.Success,
      kind: Kind.Agent,
      resultDisplay: progress,
    };

    const { lastFrame, unmount } = await renderSubagentGroup(
      [toolCall],
      undefined,
    );

    await waitFor(() => {
      const output = lastFrame();
      for (let index = 0; index < 6; index++) {
        expect(output).toContain(`printf document-${index}-contents`);
        expect(output).toContain(`document-${index}-contents`);
      }
    });
    unmount();
  });

  it('updates transcript-backed activity while a running agent is expanded', async () => {
    let transcriptMessages = transcriptMessagesForTools([
      {
        id: 'read-before-open',
        name: 'Read',
        input: { file_path: '/workspace/before-open.md' },
        result: 'before-open contents',
      },
    ]);
    mockUseAgentTranscript.mockImplementation(() => ({
      messages: transcriptMessages,
      loading: false,
    }));
    const registry = new TaskRegistry();
    registry.register({
      id: 'a-agent-inline',
      type: 'local_agent',
      status: 'running',
      description: 'Inspect files',
      startTime: Date.now(),
      notified: false,
      executionId: 1,
      outputPath: '/tmp/agent-inline.jsonl',
      completionBehavior: 'notify',
      agentId: 'agent-inline',
      agentName: 'inline-agent',
      agentType: 'Explore',
      prompt: 'Inspect files',
      isBackgrounded: false,
      taskId: 'task-inline',
    });
    const toolCall: IndividualToolCallDisplay = {
      callId: 'agent-inline-call',
      name: 'inline-agent',
      description: '',
      confirmationDetails: undefined,
      status: CoreToolCallStatus.Executing,
      kind: Kind.Agent,
      resultDisplay: {
        isSubagentProgress: true,
        agentId: 'agent-inline',
        agentName: 'inline-agent',
        state: 'running',
        recentActivity: [],
      },
    };

    const rendered = await renderWithProviders(
      <TaskRegistryProvider registry={registry}>
        <SubagentGroupDisplay
          toolCalls={[toolCall]}
          terminalWidth={80}
          availableTerminalHeight={undefined}
          isExpandable={true}
        />
      </TaskRegistryProvider>,
    );

    expect(rendered.lastFrame()).toContain('before-open.md');

    transcriptMessages = transcriptMessagesForTools([
      {
        id: 'read-before-open',
        name: 'Read',
        input: { file_path: '/workspace/before-open.md' },
        result: 'before-open contents',
      },
      {
        id: 'grep-while-open',
        name: 'Grep',
        input: { pattern: 'needle', path: 'src' },
        result: 'src/needle.ts',
      },
    ]);
    registry.updateProgress('a-agent-inline', {
      isSubagentProgress: true,
      agentId: 'agent-inline',
      agentName: 'inline-agent',
      state: 'running',
      recentActivity: [],
    });

    await waitFor(() => {
      expect(rendered.lastFrame()).toContain('before-open.md');
      expect(rendered.lastFrame()).toContain("'needle' within src");
      expect(rendered.lastFrame()).toContain('Found 1 match');
    });
    rendered.unmount();
  });
});

function transcriptMessagesForReadFallback() {
  return Array.from({ length: 5 }, (_, index) => ({
    id: `fallback-${index}`,
    type: 'tool_call' as const,
    content: 'Read',
    description: `/workspace/fallback-${index}.md`,
    status: 'completed' as const,
  }));
}

function transcriptMessagesForTools(
  tools: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    result: string;
  }>,
): Message[] {
  const structuredResults = tools.map((tool) => {
    if (tool.name === 'Bash') {
      return {
        kind: 'completed',
        stdout: tool.result,
        stderr: '',
        exitCode: 0,
        signal: null,
      };
    }
    if (tool.name === 'Grep') {
      return {
        mode: 'content',
        numFiles: 1,
        filenames: [tool.result],
        content: tool.result,
        numMatches: 1,
      };
    }
    return {
      type: 'text',
      file: {
        content: tool.result,
        startLine: 1,
        numLines: 1,
        totalLines: 1,
      },
    };
  });

  return [
    {
      type: 'assistant',
      uuid: 'assistant-tools',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: {
        role: 'assistant',
        content: tools.map((tool) => ({
          type: 'tool_use',
          id: tool.id,
          name: tool.name,
          input: tool.input,
        })),
      },
    },
    {
      type: 'user',
      uuid: 'user-results',
      timestamp: '2026-01-01T00:00:01.000Z',
      toolUseResult: structuredResults,
      message: {
        role: 'user',
        content: tools.map((tool) => ({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: tool.result,
          is_error: false,
        })),
      },
    },
  ] as unknown as Message[];
}
