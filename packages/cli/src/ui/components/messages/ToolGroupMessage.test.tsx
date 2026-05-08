/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect, vi } from 'vitest';
import { Text } from 'ink';
import type React from 'react';
import { ToolGroupMessage } from './ToolGroupMessage.js';
import type { IndividualToolCallDisplay } from '../../types.js';
import { ToolCallStatus } from '../../types.js';
import type {
  AgentResultDisplay,
  Config,
  ToolCallConfirmationDetails,
} from '@qwen-code/qwen-code-core';
import { TOOL_STATUS } from '../../constants.js';
import { ConfigContext } from '../../contexts/ConfigContext.js';
import { CompactModeProvider } from '../../contexts/CompactModeContext.js';

// Mock child components to isolate ToolGroupMessage behavior
vi.mock('./ToolMessage.js', () => ({
  ToolMessage: function MockToolMessage({
    callId,
    name,
    description,
    status,
    emphasis,
    resultDisplay,
    isFocused,
    forceShowResult,
  }: {
    callId: string;
    name: string;
    description: string;
    status: ToolCallStatus;
    emphasis: string;
    resultDisplay?: unknown;
    isFocused?: boolean;
    forceShowResult?: boolean;
  }) {
    // Use the same constants as the real component
    const statusSymbolMap: Record<ToolCallStatus, string> = {
      [ToolCallStatus.Success]: TOOL_STATUS.SUCCESS,
      [ToolCallStatus.Pending]: TOOL_STATUS.PENDING,
      [ToolCallStatus.Executing]: TOOL_STATUS.EXECUTING,
      [ToolCallStatus.Confirming]: TOOL_STATUS.CONFIRMING,
      [ToolCallStatus.Canceled]: TOOL_STATUS.CANCELED,
      [ToolCallStatus.Error]: TOOL_STATUS.ERROR,
    };
    const statusSymbol = statusSymbolMap[status] || '?';
    if (
      resultDisplay &&
      typeof resultDisplay === 'object' &&
      (resultDisplay as { type?: string }).type === 'task_execution'
    ) {
      // `forceShowResult` is the gate that lets `SubagentScrollbackSummary`
      // render in compact mode — surfaced in the mock so tests can
      // assert it was passed for terminal subagent tools.
      return (
        <Text>
          MockSubagent[{callId}]: focused={String(isFocused)} force=
          {String(Boolean(forceShowResult))}
        </Text>
      );
    }

    return (
      <Text>
        MockTool[{callId}]: {statusSymbol} {name} - {description} ({emphasis})
      </Text>
    );
  },
}));

vi.mock('./ToolConfirmationMessage.js', () => ({
  ToolConfirmationMessage: function MockToolConfirmationMessage({
    confirmationDetails,
  }: {
    confirmationDetails: ToolCallConfirmationDetails;
  }) {
    const displayText =
      confirmationDetails?.type === 'info'
        ? (confirmationDetails as { prompt: string }).prompt
        : confirmationDetails?.title || 'confirm';
    return <Text>MockConfirmation: {displayText}</Text>;
  },
}));

describe('<ToolGroupMessage />', () => {
  const mockConfig: Config = {} as Config;

  const createToolCall = (
    overrides: Partial<IndividualToolCallDisplay> = {},
  ): IndividualToolCallDisplay => ({
    callId: 'tool-123',
    name: 'test-tool',
    description: 'A tool for testing',
    resultDisplay: 'Test result',
    status: ToolCallStatus.Success,
    confirmationDetails: undefined,
    renderOutputAsMarkdown: false,
    ...overrides,
  });

  const baseProps = {
    groupId: 1,
    contentWidth: 80,
    isFocused: true,
  };

  // Helper to wrap component with required providers
  const renderWithProviders = (component: React.ReactElement) =>
    render(
      <ConfigContext.Provider value={mockConfig}>
        {component}
      </ConfigContext.Provider>,
    );

  describe('Golden Snapshots', () => {
    it('renders single successful tool call', () => {
      const toolCalls = [createToolCall()];
      const { lastFrame } = renderWithProviders(
        <ToolGroupMessage {...baseProps} toolCalls={toolCalls} />,
      );
      expect(lastFrame()).toMatchSnapshot();
    });

    it('renders multiple tool calls with different statuses', () => {
      const toolCalls = [
        createToolCall({
          callId: 'tool-1',
          name: 'successful-tool',
          description: 'This tool succeeded',
          status: ToolCallStatus.Success,
        }),
        createToolCall({
          callId: 'tool-2',
          name: 'pending-tool',
          description: 'This tool is pending',
          status: ToolCallStatus.Pending,
        }),
        createToolCall({
          callId: 'tool-3',
          name: 'error-tool',
          description: 'This tool failed',
          status: ToolCallStatus.Error,
        }),
      ];
      const { lastFrame } = renderWithProviders(
        <ToolGroupMessage {...baseProps} toolCalls={toolCalls} />,
      );
      expect(lastFrame()).toMatchSnapshot();
    });

    it('renders tool call awaiting confirmation', () => {
      const toolCalls = [
        createToolCall({
          callId: 'tool-confirm',
          name: 'confirmation-tool',
          description: 'This tool needs confirmation',
          status: ToolCallStatus.Confirming,
          confirmationDetails: {
            type: 'info',
            title: 'Confirm Tool Execution',
            prompt: 'Are you sure you want to proceed?',
            onConfirm: vi.fn(),
          },
        }),
      ];
      const { lastFrame } = renderWithProviders(
        <ToolGroupMessage {...baseProps} toolCalls={toolCalls} />,
      );
      expect(lastFrame()).toMatchSnapshot();
    });

    it('renders shell command with yellow border', () => {
      const toolCalls = [
        createToolCall({
          callId: 'shell-1',
          name: 'run_shell_command',
          description: 'Execute shell command',
          status: ToolCallStatus.Success,
        }),
      ];
      const { lastFrame } = renderWithProviders(
        <ToolGroupMessage {...baseProps} toolCalls={toolCalls} />,
      );
      expect(lastFrame()).toMatchSnapshot();
    });

    it('renders mixed tool calls including shell command', () => {
      const toolCalls = [
        createToolCall({
          callId: 'tool-1',
          name: 'read_file',
          description: 'Read a file',
          status: ToolCallStatus.Success,
        }),
        createToolCall({
          callId: 'tool-2',
          name: 'run_shell_command',
          description: 'Run command',
          status: ToolCallStatus.Executing,
        }),
        createToolCall({
          callId: 'tool-3',
          name: 'write_file',
          description: 'Write to file',
          status: ToolCallStatus.Pending,
        }),
      ];
      const { lastFrame } = renderWithProviders(
        <ToolGroupMessage {...baseProps} toolCalls={toolCalls} />,
      );
      expect(lastFrame()).toMatchSnapshot();
    });

    it('renders with limited terminal height', () => {
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
      const { lastFrame } = renderWithProviders(
        <ToolGroupMessage
          {...baseProps}
          toolCalls={toolCalls}
          availableTerminalHeight={10}
        />,
      );
      expect(lastFrame()).toMatchSnapshot();
    });

    it('renders when not focused', () => {
      const toolCalls = [createToolCall()];
      const { lastFrame } = renderWithProviders(
        <ToolGroupMessage
          {...baseProps}
          toolCalls={toolCalls}
          isFocused={false}
        />,
      );
      expect(lastFrame()).toMatchSnapshot();
    });

    it('renders with narrow terminal width', () => {
      const toolCalls = [
        createToolCall({
          name: 'very-long-tool-name-that-might-wrap',
          description:
            'This is a very long description that might cause wrapping issues',
        }),
      ];
      const { lastFrame } = renderWithProviders(
        <ToolGroupMessage
          {...baseProps}
          toolCalls={toolCalls}
          contentWidth={40}
        />,
      );
      expect(lastFrame()).toMatchSnapshot();
    });

    it('renders empty tool calls array', () => {
      const { lastFrame } = renderWithProviders(
        <ToolGroupMessage {...baseProps} toolCalls={[]} />,
      );
      expect(lastFrame()).toMatchSnapshot();
    });
  });

  describe('SubAgent focus', () => {
    // Helper to build a running SubAgent result display
    const createRunningSubagentDisplay = (
      name: string,
    ): AgentResultDisplay => ({
      type: 'task_execution',
      subagentName: name,
      taskDescription: `${name} task`,
      taskPrompt: `Run ${name}`,
      status: 'running',
      toolCalls: [
        {
          callId: `${name}-read-1`,
          name: 'read_file',
          status: 'success',
          description: 'Read file',
        },
      ],
    });

    // Helper to build a completed SubAgent result display
    const createCompletedSubagentDisplay = (
      name: string,
    ): AgentResultDisplay => ({
      type: 'task_execution',
      subagentName: name,
      taskDescription: `${name} task`,
      taskPrompt: `Run ${name}`,
      status: 'completed',
      toolCalls: [
        {
          callId: `${name}-read-1`,
          name: 'read_file',
          status: 'success',
          description: 'Read file',
        },
      ],
    });

    it('keeps a normal running subagent focused so Ctrl+E can expand it', () => {
      const { lastFrame } = renderWithProviders(
        <ToolGroupMessage
          {...baseProps}
          toolCalls={[
            createToolCall({
              callId: 'agent-1',
              name: 'agent',
              status: ToolCallStatus.Executing,
              resultDisplay: createRunningSubagentDisplay('reviewer'),
            }),
          ]}
        />,
      );

      expect(lastFrame()).toContain('MockSubagent[agent-1]: focused=true');
    });

    it('does not focus a running subagent when the parent group is not focused', () => {
      const { lastFrame } = renderWithProviders(
        <ToolGroupMessage
          {...baseProps}
          isFocused={false}
          toolCalls={[
            createToolCall({
              callId: 'agent-1',
              name: 'agent',
              status: ToolCallStatus.Executing,
              resultDisplay: createRunningSubagentDisplay('reviewer'),
            }),
          ]}
        />,
      );

      expect(lastFrame()).toContain('MockSubagent[agent-1]: focused=false');
    });

    it('gives focus to only the first running subagent when multiple are running', () => {
      const { lastFrame } = renderWithProviders(
        <ToolGroupMessage
          {...baseProps}
          toolCalls={[
            createToolCall({
              callId: 'agent-1',
              name: 'agent',
              status: ToolCallStatus.Executing,
              resultDisplay: createRunningSubagentDisplay('first'),
            }),
            createToolCall({
              callId: 'agent-2',
              name: 'agent',
              status: ToolCallStatus.Executing,
              resultDisplay: createRunningSubagentDisplay('second'),
            }),
          ]}
        />,
      );

      expect(lastFrame()).toContain('MockSubagent[agent-1]: focused=true');
      expect(lastFrame()).toContain('MockSubagent[agent-2]: focused=false');
    });

    it('pending confirmation wins over running fallback', () => {
      const pendingDisplay: AgentResultDisplay = {
        ...createRunningSubagentDisplay('pending-agent'),
        pendingConfirmation: {
          type: 'info',
          title: 'Approve?',
          prompt: 'Allow this action?',
          onConfirm: vi.fn(),
        },
      };

      const { lastFrame } = renderWithProviders(
        <ToolGroupMessage
          {...baseProps}
          toolCalls={[
            createToolCall({
              callId: 'agent-running',
              name: 'agent',
              status: ToolCallStatus.Executing,
              resultDisplay: createRunningSubagentDisplay('runner'),
            }),
            createToolCall({
              callId: 'agent-pending',
              name: 'agent',
              status: ToolCallStatus.Executing,
              resultDisplay: pendingDisplay,
            }),
          ]}
        />,
      );

      // The subagent with pending confirmation gets focus, not the first running one
      expect(lastFrame()).toContain(
        'MockSubagent[agent-running]: focused=false',
      );
      expect(lastFrame()).toContain(
        'MockSubagent[agent-pending]: focused=true',
      );
    });

    it('direct tool-level confirmation blocks all subagent shortcut focus', () => {
      const { lastFrame } = renderWithProviders(
        <ToolGroupMessage
          {...baseProps}
          toolCalls={[
            createToolCall({
              callId: 'tool-confirm',
              name: 'write_file',
              status: ToolCallStatus.Confirming,
              confirmationDetails: {
                type: 'info',
                title: 'Write file?',
                prompt: 'Allow write?',
                onConfirm: vi.fn(),
              },
            }),
            createToolCall({
              callId: 'agent-running',
              name: 'agent',
              status: ToolCallStatus.Executing,
              resultDisplay: createRunningSubagentDisplay('runner'),
            }),
          ]}
        />,
      );

      // Direct tool confirmation active → subagent gets no shortcut focus
      expect(lastFrame()).toContain(
        'MockSubagent[agent-running]: focused=false',
      );
    });

    it('completed subagent does not receive focus', () => {
      const { lastFrame } = renderWithProviders(
        <ToolGroupMessage
          {...baseProps}
          toolCalls={[
            createToolCall({
              callId: 'agent-done',
              name: 'agent',
              status: ToolCallStatus.Success,
              resultDisplay: createCompletedSubagentDisplay('finished'),
            }),
          ]}
        />,
      );

      expect(lastFrame()).toContain('MockSubagent[agent-done]: focused=false');
    });
  });

  describe('Border Color Logic', () => {
    it('uses yellow border when tools are pending', () => {
      const toolCalls = [createToolCall({ status: ToolCallStatus.Pending })];
      const { lastFrame } = renderWithProviders(
        <ToolGroupMessage {...baseProps} toolCalls={toolCalls} />,
      );
      // The snapshot will capture the visual appearance including border color
      expect(lastFrame()).toMatchSnapshot();
    });

    it('uses yellow border for shell commands even when successful', () => {
      const toolCalls = [
        createToolCall({
          name: 'run_shell_command',
          status: ToolCallStatus.Success,
        }),
      ];
      const { lastFrame } = renderWithProviders(
        <ToolGroupMessage {...baseProps} toolCalls={toolCalls} />,
      );
      expect(lastFrame()).toMatchSnapshot();
    });

    it('uses gray border when all tools are successful and no shell commands', () => {
      const toolCalls = [
        createToolCall({ status: ToolCallStatus.Success }),
        createToolCall({
          callId: 'tool-2',
          name: 'another-tool',
          status: ToolCallStatus.Success,
        }),
      ];
      const { lastFrame } = renderWithProviders(
        <ToolGroupMessage {...baseProps} toolCalls={toolCalls} />,
      );
      expect(lastFrame()).toMatchSnapshot();
    });
  });

  describe('Height Calculation', () => {
    it('calculates available height correctly with multiple tools with results', () => {
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
      const { lastFrame } = renderWithProviders(
        <ToolGroupMessage
          {...baseProps}
          toolCalls={toolCalls}
          availableTerminalHeight={20}
        />,
      );
      expect(lastFrame()).toMatchSnapshot();
    });
  });

  describe('Confirmation Handling', () => {
    it('shows confirmation dialog for first confirming tool only', () => {
      const toolCalls = [
        createToolCall({
          callId: 'tool-1',
          name: 'first-confirm',
          status: ToolCallStatus.Confirming,
          confirmationDetails: {
            type: 'info',
            title: 'Confirm First Tool',
            prompt: 'Confirm first tool',
            onConfirm: vi.fn(),
          },
        }),
        createToolCall({
          callId: 'tool-2',
          name: 'second-confirm',
          status: ToolCallStatus.Confirming,
          confirmationDetails: {
            type: 'info',
            title: 'Confirm Second Tool',
            prompt: 'Confirm second tool',
            onConfirm: vi.fn(),
          },
        }),
      ];
      const { lastFrame } = renderWithProviders(
        <ToolGroupMessage {...baseProps} toolCalls={toolCalls} />,
      );
      // Should only show confirmation for the first tool
      expect(lastFrame()).toMatchSnapshot();
    });
  });

  describe('Compact mode + terminal subagent expansion', () => {
    // Helper that wraps the group with `compactMode: true` so the
    // `showCompact` branch is exercised. Verifies the safety net that
    // forces the group to expand when it carries a committed terminal
    // subagent — without it, `CompactToolGroupDisplay` would skip the
    // ToolMessage path and `SubagentScrollbackSummary` would never
    // surface in scrollback. The committed-summary handoff promised
    // by the LiveAgentPanel design depends on this.
    const renderCompact = (component: React.ReactElement, compactMode = true) =>
      render(
        <ConfigContext.Provider value={mockConfig}>
          <CompactModeProvider value={{ compactMode }}>
            {component}
          </CompactModeProvider>
        </ConfigContext.Provider>,
      );

    const subagentCall = (
      status: 'running' | 'completed' | 'failed' | 'cancelled',
    ): IndividualToolCallDisplay =>
      createToolCall({
        callId: `task-${status}`,
        name: 'task',
        description: 'Delegate task to subagent',
        status:
          status === 'running'
            ? ToolCallStatus.Executing
            : status === 'completed'
              ? ToolCallStatus.Success
              : ToolCallStatus.Error,
        resultDisplay: {
          type: 'task_execution',
          subagentName: 'researcher',
          taskDescription: 'investigate the change',
          taskPrompt: 'investigate',
          status,
        } as AgentResultDisplay,
      });

    it('compact mode: committed group with completed subagent forces expand', () => {
      // isPending=false (committed) + completed subagent → expand,
      // routing through ToolMessage so the scrollback summary lands
      // in the persistent record.
      const { lastFrame } = renderCompact(
        <ToolGroupMessage
          {...baseProps}
          toolCalls={[subagentCall('completed')]}
          isPending={false}
        />,
      );
      const frame = lastFrame() ?? '';
      // The MockToolMessage's `MockSubagent[task-completed]` sentinel
      // proves we routed through the expanded path; absence would
      // mean CompactToolGroupDisplay swallowed the call.
      expect(frame).toContain('MockSubagent[task-completed]');
    });

    it('compact mode: live group with running subagent stays compact', () => {
      // isPending=true (live) → panel below the composer owns the
      // row; staying compact keeps scrollback quiet until the parent
      // turn commits.
      const { lastFrame } = renderCompact(
        <ToolGroupMessage
          {...baseProps}
          toolCalls={[subagentCall('running')]}
          isPending={true}
        />,
      );
      // Compact path renders the group header / count, NOT the
      // expanded MockToolMessage sentinel.
      expect(lastFrame() ?? '').not.toContain('MockSubagent[task-running]');
    });

    it('compact mode: live group with completed subagent force-expands so the summary bridges the panel-snapshot drop', () => {
      // The subagent terminated mid-turn while the parent is still
      // running. After #3921 swapped the order in
      // `unregisterForeground` (delete-then-emit), the panel snapshot
      // has already evicted the row by the time we render — so if the
      // group stayed compact, the user would see NOTHING for the run
      // until the parent commits. Force-expand here so
      // `SubagentScrollbackSummary` lands inline immediately and
      // bridges the gap. Mirrors `SubagentExecutionRenderer`'s
      // ungated terminal-summary path and
      // `mergeCompactToolGroups.isForceExpandGroup`'s no-isPending-gate
      // committed-history rule.
      const { lastFrame } = renderCompact(
        <ToolGroupMessage
          {...baseProps}
          toolCalls={[subagentCall('completed')]}
          isPending={true}
        />,
      );
      expect(lastFrame() ?? '').toContain('MockSubagent[task-completed]');
    });

    it('live phase (non-compact): running subagent tool entry is hidden — panel owns the row', () => {
      // Without this filter the user sees the same subagent twice —
      // once as the parent tool group's `task` row, once as the
      // `LiveAgentPanel` row beneath the composer. Hide the inline
      // entry while `isPending=true` so the panel is the single
      // source of truth for in-flight subagents.
      const { lastFrame } = renderWithProviders(
        <ToolGroupMessage
          {...baseProps}
          toolCalls={[subagentCall('running')]}
          isPending={true}
        />,
      );
      // Pure-subagent group with everything panel-owned → entire
      // group is hidden so an empty bordered container doesn't
      // float above the panel.
      expect(lastFrame() ?? '').toBe('');
    });

    it('live phase (non-compact): mixed group still renders sibling tools', () => {
      // Only the subagent entry is hidden in live phase — sibling
      // tools (Read / Edit / Bash) keep rendering normally so the
      // parent's tool stream stays continuous.
      const sibling = createToolCall({
        callId: 'read-1',
        name: 'read_file',
        description: 'read config.yaml',
        status: ToolCallStatus.Success,
      });
      const { lastFrame } = renderWithProviders(
        <ToolGroupMessage
          {...baseProps}
          toolCalls={[subagentCall('running'), sibling]}
          isPending={true}
        />,
      );
      const frame = lastFrame() ?? '';
      // Sibling shown.
      expect(frame).toContain('read_file');
      // Subagent hidden — panel owns the live row.
      expect(frame).not.toContain('MockSubagent[task-running]');
    });

    it('live phase (non-compact): subagent with pending approval still renders', () => {
      // The focus-routed approval banner / queued marker is the
      // only inline surface that lets users answer the prompt
      // without opening the dialog, so the entry must NOT be
      // hidden when the subagent is awaiting confirmation.
      const pending = createToolCall({
        callId: 'task-pending',
        name: 'task',
        description: 'Delegate task to subagent',
        status: ToolCallStatus.Executing,
        resultDisplay: {
          type: 'task_execution',
          subagentName: 'researcher',
          taskDescription: 'investigate the change',
          taskPrompt: 'investigate',
          status: 'running',
          pendingConfirmation: { type: 'info', title: 't', prompt: 'p' },
        } as AgentResultDisplay,
      });
      const { lastFrame } = renderWithProviders(
        <ToolGroupMessage
          {...baseProps}
          toolCalls={[pending]}
          isPending={true}
        />,
      );
      // Subagent entry rendered (banner / marker fires inside
      // ToolMessage); panel sits below as ambient progress.
      expect(lastFrame() ?? '').toContain('MockSubagent[task-pending]');
    });

    it('live phase (non-compact): TERMINAL subagent renders inline (panel snapshot already dropped)', () => {
      // Post-#3921 swap-order, `unregisterForeground` removes the
      // foreground entry from the panel snapshot the moment the
      // subagent finishes. If the inline path also stayed hidden in
      // the live phase, the user would see nothing for the run
      // until the parent commits — `SubagentScrollbackSummary` has
      // to bridge that gap. Live-phase hide applies only to
      // running / paused / background entries.
      const { lastFrame } = renderWithProviders(
        <ToolGroupMessage
          {...baseProps}
          toolCalls={[subagentCall('completed')]}
          isPending={true}
        />,
      );
      // Terminal entry rendered → MockSubagent sentinel from the
      // ToolMessage mock; if the entry were still hidden the frame
      // would be empty.
      expect(lastFrame() ?? '').toContain('MockSubagent[task-completed]');
    });

    it('committed phase (non-compact): subagent tool entry comes back for the audit trail', () => {
      // Once the parent turn commits the panel evicts the row and
      // the inline entry returns so SubagentScrollbackSummary lands
      // inside the parent's tool group as a permanent record.
      const { lastFrame } = renderWithProviders(
        <ToolGroupMessage
          {...baseProps}
          toolCalls={[subagentCall('completed')]}
          isPending={false}
        />,
      );
      expect(lastFrame() ?? '').toContain('MockSubagent[task-completed]');
    });

    it('terminal subagent tool receives forceShowResult so the summary renders in compact mode', () => {
      // Force-expanding the group is necessary but not sufficient —
      // `ToolMessage`'s own compact-mode gate
      // (`!compactMode || forceShowResult`) would otherwise drop the
      // result block, so the inner SubagentScrollbackSummary never
      // gets a chance to render. ToolGroupMessage must propagate
      // `forceShowResult=true` for terminal subagent tools.
      const { lastFrame } = renderCompact(
        <ToolGroupMessage
          {...baseProps}
          toolCalls={[subagentCall('completed')]}
          isPending={false}
        />,
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('MockSubagent[task-completed]');
      expect(frame).toContain('force=true');
    });

    it('compact mode: committed group with failed subagent forces expand', () => {
      // Same as the completed case — the scrollback summary needs to
      // land for failed / cancelled foreground subagents too so the
      // user has a permanent record of the run's outcome.
      const { lastFrame } = renderCompact(
        <ToolGroupMessage
          {...baseProps}
          toolCalls={[subagentCall('failed')]}
          isPending={false}
        />,
      );
      expect(lastFrame() ?? '').toContain('MockSubagent[task-failed]');
    });

    it('compact mode: live mixed group with terminal subagent + sibling force-expands and renders both', () => {
      // Terminal subagent (drops from the panel snapshot the moment
      // it finishes) + sibling tool, in live + compact. The group
      // must force-expand so `SubagentScrollbackSummary` lands inline
      // for the subagent, while the sibling continues to render
      // through the normal ToolMessage path. Without this, the
      // sibling alone would have appeared in `CompactToolGroupDisplay`
      // and the subagent's outcome would have stayed invisible until
      // parent commit.
      const sibling = createToolCall({
        callId: 'edit-1',
        name: 'edit_file',
        description: 'apply diff to handler.ts',
        status: ToolCallStatus.Success,
      });
      const { lastFrame } = renderCompact(
        <ToolGroupMessage
          {...baseProps}
          toolCalls={[subagentCall('completed'), sibling]}
          isPending={true}
        />,
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('MockSubagent[task-completed]');
      expect(frame).toContain('MockTool[edit-1]');
    });

    it('compact mode: live mixed group filters panel-owned subagent out of count + active tool', () => {
      // Regression: in compact mode, the per-tool live-phase filter
      // used to live inside the expanded `.map()`, which `showCompact`
      // returned BEFORE. So a mixed live group (running subagent +
      // sibling tool) sent the unfiltered list to
      // `CompactToolGroupDisplay`, where the running subagent could
      // (a) inflate the count to N (`× N` suffix), and (b) win
      // `getActiveTool` (Executing beats sibling's Success / Pending),
      // overriding the header with the subagent's name. The fix
      // derives `inlineToolCalls` ONCE before any compact decision so
      // both the count and the active-tool selection see only what
      // will actually render inline.
      const sibling = createToolCall({
        callId: 'read-1',
        name: 'read_file',
        description: 'read config.yaml',
        status: ToolCallStatus.Success,
      });
      const { lastFrame } = renderCompact(
        <ToolGroupMessage
          {...baseProps}
          toolCalls={[subagentCall('running'), sibling]}
          isPending={true}
        />,
      );
      const frame = lastFrame() ?? '';
      // Sibling is the only inline survivor → wins active-tool, count
      // collapses to 1 (no `× N` suffix).
      expect(frame).toContain('read_file');
      expect(frame).not.toMatch(/× 2/);
      // Sibling description should appear; subagent description
      // should not.
      expect(frame).toContain('read config.yaml');
      expect(frame).not.toContain('Delegate task to subagent');
    });
  });
});
