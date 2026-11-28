/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Box, Text, useStdout } from 'ink';
import {
  getAssistantTextBlocks,
  buildWorkflowResumePrompt,
  getDisplayableUserText,
  getProjectWorkflowsDir,
  getToolUseDisplayMetadata,
  isTerminalStatus,
  normalizeToolInput,
  slugifyWorkflowName,
  WORKFLOW_STRUCTURED_OUTPUT_TOOL_NAME,
  type Message,
  type WorkflowUnifiedTask,
} from '@qwen-code/core';
import { theme } from '../semantic-colors.js';
import { figures } from '../utils/figures.js';
import { BaseTabDialog } from './shared/BaseTabDialog.js';
import { SHORTCUT_HINTS } from '../constants/shortcuts.js';
import {
  useRegisterActionHandlers,
  useRegisterFallbackHandler,
  type ActionHandler,
} from '../contexts/ActionHandlerRegistry.js';
import wrapText from '../../ink/wrap-text.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useTaskRegistry } from '../contexts/TaskRegistryContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { dismissTask } from '../utils/taskActions.js';
import { useWorkflowAgentTranscript } from '../hooks/useWorkflowAgentTranscript.js';
import {
  buildWorkflowRunView,
  filterWorkflowAgentsByPhase,
  formatWorkflowDuration,
  workflowAllPhaseId,
  type WorkflowAgentView,
  type WorkflowPhaseView,
  type WorkflowRunView,
} from '../workflows/workflowPanelSelectors.js';
import { getCachedStringWidth } from '../utils/textUtils.js';
import { calculateCenteredWindow } from '../utils/calculateCenteredWindow.js';
import {
  useKeyBindingConfig,
  useKeyMatchers,
} from '../hooks/useKeyMatchers.js';
import { Command } from '../key/keyBindings.js';
import { formatCommand } from '../key/keybindingUtils.js';

export type WorkflowPanelMode = 'inline' | 'fullscreen';

export interface WorkflowPanelProps {
  task?: WorkflowUnifiedTask;
  mode?: WorkflowPanelMode;
  onBack: () => void;
}

type FocusColumn = 'phases' | 'agents';
type PanelMode = 'overview' | 'agent-detail';
type WorkflowAgentStatusFilter =
  | 'all'
  | 'running'
  | 'failed'
  | 'done'
  | 'skipped'
  | 'cached';

const WORKFLOW_AGENT_STATUS_FILTERS: WorkflowAgentStatusFilter[] = [
  'all',
  'running',
  'failed',
  'done',
  'skipped',
  'cached',
];

const MAX_AGENT_DETAIL_PROMPT_LINES = 4;
const RECENT_AGENT_ACTIVITY_LIMIT = 3;
const OVERVIEW_PHASE_ROW_LIMIT = 8;
const OVERVIEW_AGENT_ROW_LIMIT = 22;
const DETAIL_AGENT_ROW_LIMIT = 16;
const DETAIL_CONTENT_ROW_LIMIT = 16;
const PHASES_COLUMN_WIDTH = 26;
const DETAIL_AGENT_COLUMN_WIDTH = 38;

export const WorkflowPanel: React.FC<WorkflowPanelProps> = ({
  task: activeTask,
  mode = 'fullscreen',
  onBack,
}) => {
  const config = useConfig();
  const registry = useTaskRegistry();
  const uiActions = useUIActions();
  const keyMatchers = useKeyMatchers();
  const keyBindingConfig = useKeyBindingConfig();
  const [focusColumn, setFocusColumn] = useState<FocusColumn>('phases');
  const [panelMode, setPanelMode] = useState<PanelMode>('overview');
  const [selectedPhaseIndex, setSelectedPhaseIndex] = useState(0);
  const [selectedAgentIndex, setSelectedAgentIndex] = useState(0);
  const [statusFilter, setStatusFilter] =
    useState<WorkflowAgentStatusFilter>('all');
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [detailScrollOffset, setDetailScrollOffset] = useState(0);
  const detailMaxScrollOffsetRef = useRef(0);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [currentTimeMs, setCurrentTimeMs] = useState(() => Date.now());
  const { stdout } = useStdout();
  const isLiveTask = Boolean(activeTask && registry?.get(activeTask.id));

  const hasRunningTask = activeTask?.status === 'running';
  useEffect(() => {
    if (!hasRunningTask) return undefined;
    const timer = setInterval(() => setCurrentTimeMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasRunningTask]);

  const view = useMemo(
    () =>
      activeTask ? buildWorkflowRunView(activeTask, currentTimeMs) : undefined,
    [activeTask, currentTimeMs],
  );
  const phaseRows = useMemo(() => {
    if (!view) return [];
    return [
      {
        id: workflowAllPhaseId(),
        index: 0,
        title: 'All',
        totalAgents: view.agentCount,
        doneAgents: view.agentDoneCount,
        status:
          view.agentCount > 0 && view.agentDoneCount >= view.agentCount
            ? 'done'
            : view.agentCount > 0
              ? 'running'
              : 'pending',
      } satisfies WorkflowPhaseView,
      ...view.phases,
    ];
  }, [view]);
  const selectedPhase =
    phaseRows[clampIndex(selectedPhaseIndex, phaseRows.length)];
  const phaseAgents = useMemo(
    () => (view ? filterWorkflowAgentsByPhase(view, selectedPhase?.id) : []),
    [view, selectedPhase?.id],
  );
  const visibleAgents = useMemo(
    () => filterWorkflowAgentsByStatus(phaseAgents, statusFilter),
    [phaseAgents, statusFilter],
  );
  const selectedAgent =
    visibleAgents[clampIndex(selectedAgentIndex, visibleAgents.length)];
  const selectedAgentControllable = Boolean(
    activeTask?.status === 'running' &&
      selectedAgent &&
      activeTask.agentControllers?.[selectedAgent.id],
  );
  const skipAgentKey = formatCommand(
    Command.WORKFLOW_AGENT_SKIP,
    keyBindingConfig,
  ).toLowerCase();

  useEffect(() => {
    setSelectedPhaseIndex((value) => clampIndex(value, phaseRows.length));
  }, [phaseRows.length]);

  useEffect(() => {
    setSelectedAgentIndex((value) => clampIndex(value, visibleAgents.length));
  }, [visibleAgents.length]);

  useEffect(() => {
    setPromptExpanded(false);
    setDetailScrollOffset(0);
  }, [panelMode, selectedAgent?.id]);

  const updateDetailMaxScrollOffset = useCallback((maxOffset: number) => {
    detailMaxScrollOffsetRef.current = maxOffset;
    setDetailScrollOffset((value) => clampScrollOffset(value, maxOffset));
  }, []);

  const moveSelection = useCallback(
    (delta: number) => {
      if (focusColumn === 'phases') {
        setSelectedPhaseIndex((value) =>
          clampIndex(value + delta, phaseRows.length),
        );
      } else {
        setSelectedAgentIndex((value) =>
          clampIndex(value + delta, visibleAgents.length),
        );
      }
    },
    [focusColumn, phaseRows.length, visibleAgents.length],
  );

  const stopWorkflow = useCallback(() => {
    if (!activeTask || !isLiveTask) return false;
    const terminal = isTerminalStatus(activeTask.status);
    if (
      !terminal &&
      activeTask.status !== 'running' &&
      activeTask.status !== 'paused'
    ) {
      return false;
    }
    dismissTask(registry, activeTask);
    setMessage(
      terminal
        ? `Cleared ${activeTask.workflowName}.`
        : `Stop requested for ${activeTask.workflowName}.`,
    );
    return true;
  }, [activeTask, isLiveTask, registry]);

  const retryAgent = useCallback(() => {
    if (!activeTask || activeTask.status !== 'running' || !selectedAgent) {
      return false;
    }
    const ok = registry?.retryWorkflowAgent(activeTask.id, selectedAgent.id);
    setMessage(
      ok
        ? `Restart requested for ${selectedAgent.label}.`
        : 'Workflow agent is no longer controllable.',
    );
    return true;
  }, [activeTask, registry, selectedAgent]);

  const skipAgent = useCallback(() => {
    if (!activeTask || !selectedAgent || !selectedAgentControllable) {
      return false;
    }
    const ok = registry?.skipWorkflowAgent(activeTask.id, selectedAgent.id);
    setMessage(
      ok
        ? `Skip requested for ${selectedAgent.label}.`
        : 'Workflow agent is no longer controllable.',
    );
    return true;
  }, [activeTask, registry, selectedAgent, selectedAgentControllable]);

  const toggleStatusFilter = useCallback(() => {
    const currentIndex = WORKFLOW_AGENT_STATUS_FILTERS.indexOf(statusFilter);
    const next =
      WORKFLOW_AGENT_STATUS_FILTERS[
        (currentIndex + 1) % WORKFLOW_AGENT_STATUS_FILTERS.length
      ] ?? 'all';
    setStatusFilter(next);
    setSelectedAgentIndex(0);
    setMessage(`Agent filter: ${next}.`);
    return true;
  }, [statusFilter]);

  const enterAgents = useCallback(() => {
    if (phaseAgents.length === 0) return false;
    setSelectedAgentIndex(0);
    setStatusFilter('all');
    setFocusColumn('agents');
    return true;
  }, [phaseAgents.length]);

  const pauseOrResumeWorkflow = useCallback(() => {
    if (!activeTask) return false;
    if (activeTask.status === 'running') {
      const paused = registry?.pauseWorkflow(activeTask.id) ?? false;
      setMessage(
        paused
          ? `Paused ${activeTask.workflowName}.`
          : 'Workflow is no longer controllable.',
      );
      return true;
    }
    if (activeTask.status === 'paused') {
      const prompt = buildWorkflowResumePrompt({
        scriptPath: activeTask.scriptPath,
        runId: activeTask.workflowRunId,
        args: activeTask.args,
      });
      onBack();
      void uiActions.handleFinalSubmit(prompt);
      return true;
    }
    return false;
  }, [activeTask, onBack, registry, uiActions]);

  const saveWorkflowScript = useCallback(() => {
    if (!activeTask) return false;
    void saveWorkflowScriptToProject(
      config.getSessionArtifactProjectRoot(),
      activeTask,
    )
      .then(async (savedPath) => {
        await config.reloadSkills();
        setMessage(`Saved workflow script: ${savedPath}`);
      })
      .catch((error) => {
        setMessage(
          `Failed to save workflow script: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    return true;
  }, [activeTask, config]);

  const togglePromptExpanded = useCallback(() => {
    if (panelMode !== 'agent-detail') return false;
    setPromptExpanded((expanded) => {
      const next = !expanded;
      setDetailScrollOffset(0);
      setMessage(next ? 'Prompt expanded.' : 'Prompt collapsed.');
      return next;
    });
    return true;
  }, [panelMode]);

  const actionHandlers = useMemo(
    (): Record<string, ActionHandler> => ({
      'dialog:navigate:up': () => {
        moveSelection(-1);
        return true;
      },
      'dialog:navigate:down': () => {
        moveSelection(1);
        return true;
      },
      'dialog:navigate:left': () => {
        if (panelMode === 'agent-detail') {
          setPanelMode('overview');
        } else if (focusColumn === 'agents') {
          setFocusColumn('phases');
        } else {
          onBack();
        }
        return true;
      },
      'dialog:navigate:right': () => {
        if (panelMode === 'overview' && focusColumn === 'phases') {
          enterAgents();
        }
        return true;
      },
      'dialog:confirm': () => {
        if (panelMode === 'agent-detail') {
          return togglePromptExpanded();
        }
        if (focusColumn === 'agents') {
          if (selectedAgent) {
            setPanelMode('agent-detail');
          }
          return true;
        }
        enterAgents();
        return true;
      },
    }),
    [
      focusColumn,
      enterAgents,
      moveSelection,
      onBack,
      panelMode,
      selectedAgent,
      togglePromptExpanded,
    ],
  );
  useRegisterActionHandlers('Dialog', actionHandlers, activeTask !== undefined);

  const fallbackHandler = useCallback<ActionHandler>(
    (key) => {
      if (
        (panelMode === 'agent-detail' || focusColumn === 'agents') &&
        keyMatchers[Command.WORKFLOW_AGENT_SKIP](key)
      ) {
        return skipAgent();
      }
      if (
        panelMode === 'agent-detail' &&
        (key.sequence === 'j' || key.sequence === 'J')
      ) {
        setDetailScrollOffset((value) =>
          clampScrollOffset(value + 1, detailMaxScrollOffsetRef.current),
        );
        return true;
      }
      if (
        panelMode === 'agent-detail' &&
        (key.sequence === 'k' || key.sequence === 'K')
      ) {
        setDetailScrollOffset((value) => Math.max(0, value - 1));
        return true;
      }
      if (key.sequence === 'k' || key.sequence === 'K') {
        return stopWorkflow();
      }
      if (key.sequence === 'r' || key.sequence === 'R') {
        return retryAgent();
      }
      if (key.sequence === 'f' || key.sequence === 'F') {
        return toggleStatusFilter();
      }
      if (key.sequence === 'p' || key.sequence === 'P') {
        return pauseOrResumeWorkflow();
      }
      if (key.sequence === 's' || key.sequence === 'S') {
        return saveWorkflowScript();
      }
      return false;
    },
    [
      panelMode,
      focusColumn,
      keyMatchers,
      retryAgent,
      saveWorkflowScript,
      skipAgent,
      stopWorkflow,
      toggleStatusFilter,
      pauseOrResumeWorkflow,
    ],
  );
  useRegisterFallbackHandler(
    'Dialog',
    fallbackHandler,
    activeTask !== undefined,
  );

  if (!view || !activeTask) {
    return (
      <BaseTabDialog title="Workflows" onClose={onBack}>
        <Box marginTop={1}>
          <Text color={theme.text.secondary} dimColor>
            No workflow tasks.
          </Text>
        </Box>
      </BaseTabDialog>
    );
  }

  const pauseResumeHint =
    activeTask.status === 'running'
      ? 'p pause'
      : activeTask.status === 'paused'
        ? 'p resume'
        : undefined;
  const footerHints =
    panelMode === 'agent-detail'
      ? [
          { label: 'j/k scroll', order: 10 },
          { label: 'Enter prompt', order: 20 },
          ...(selectedAgentControllable && skipAgentKey
            ? [{ label: `${skipAgentKey} stop`, order: 30 }]
            : []),
          ...(activeTask.status === 'running'
            ? [{ label: SHORTCUT_HINTS.R_RESTART, order: 40 }]
            : []),
          { label: `f filter: ${statusFilter}`, order: 60 },
          ...(pauseResumeHint ? [{ label: pauseResumeHint, order: 70 }] : []),
          { label: 's save script', order: 80 },
          { label: SHORTCUT_HINTS.GO_BACK, order: 90 },
        ]
      : [
          { label: '↑↓ select', order: 10 },
          { label: '←→ focus', order: 20 },
          { label: 'Enter details', order: 30 },
          ...(focusColumn === 'agents' &&
          selectedAgentControllable &&
          skipAgentKey
            ? [{ label: `${skipAgentKey} stop`, order: 35 }]
            : []),
          ...(activeTask.status === 'running' || activeTask.status === 'paused'
            ? [{ label: 'k stop workflow', order: 40 }]
            : isLiveTask && isTerminalStatus(activeTask.status)
              ? [{ label: 'k clear', order: 40 }]
              : []),
          { label: `f filter: ${statusFilter}`, order: 50 },
          ...(pauseResumeHint ? [{ label: pauseResumeHint, order: 60 }] : []),
          { label: 's save script', order: 70 },
          { label: SHORTCUT_HINTS.GO_BACK, order: 90 },
        ];
  const terminalWidth = stdout?.columns ?? 120;
  const agentDetailContentWidth = Math.max(
    24,
    terminalWidth - DETAIL_AGENT_COLUMN_WIDTH - 8,
  );

  return (
    <BaseTabDialog
      title={mode === 'inline' ? undefined : 'Workflows'}
      onClose={onBack}
      extraHints={footerHints}
    >
      <Box flexDirection="column" marginTop={mode === 'inline' ? 0 : 1}>
        <WorkflowHeader view={view} />
        {panelMode === 'agent-detail' ? (
          <WorkflowAgentDetailLayout
            task={activeTask}
            agents={visibleAgents}
            selectedAgent={selectedAgent}
            contentWidth={agentDetailContentWidth}
            promptExpanded={promptExpanded}
            detailScrollOffset={detailScrollOffset}
            onDetailMaxScrollOffsetChange={updateDetailMaxScrollOffset}
          />
        ) : (
          <WorkflowOverviewLayout
            view={view}
            phases={phaseRows}
            selectedPhase={selectedPhase}
            selectedAgent={selectedAgent}
            agents={visibleAgents}
            focusColumn={focusColumn}
            statusFilter={statusFilter}
          />
        )}
        {message ? (
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>{message}</Text>
          </Box>
        ) : null}
      </Box>
    </BaseTabDialog>
  );
};

function WorkflowHeader({ view }: { view: WorkflowRunView }) {
  const right = `${view.agentDoneCount}/${view.agentCount} agents · ${formatWorkflowDuration(view.elapsedMs)} · ${view.status}`;
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold color={theme.ui.focus}>
          {view.name}
        </Text>
        <Text color={statusColor(view.status)}>{right}</Text>
      </Box>
      <Text color={theme.text.secondary} wrap="truncate">
        {view.description}
      </Text>
    </Box>
  );
}

function WorkflowOverviewLayout({
  view,
  phases,
  selectedPhase,
  selectedAgent,
  agents,
  focusColumn,
  statusFilter,
}: {
  view: WorkflowRunView;
  phases: WorkflowPhaseView[];
  selectedPhase?: WorkflowPhaseView;
  selectedAgent?: WorkflowAgentView;
  agents: WorkflowAgentView[];
  focusColumn: FocusColumn;
  statusFilter: WorkflowAgentStatusFilter;
}) {
  const selectedPhaseIndex = Math.max(
    0,
    phases.findIndex((phase) => phase.id === selectedPhase?.id),
  );
  const selectedAgentIndex = Math.max(
    0,
    agents.findIndex((agent) => agent.id === selectedAgent?.id),
  );
  const phaseWindow = windowRows(
    phases,
    selectedPhaseIndex,
    OVERVIEW_PHASE_ROW_LIMIT,
  );
  const agentWindow = windowRows(
    agents,
    selectedAgentIndex,
    OVERVIEW_AGENT_ROW_LIMIT,
  );

  return (
    <Box
      marginTop={1}
      flexDirection="row"
      borderStyle="single"
      borderColor={theme.border.default}
      borderDimColor
      minHeight={12}
    >
      <Box
        width={PHASES_COLUMN_WIDTH}
        flexDirection="column"
        paddingX={1}
        borderStyle="single"
        borderTop={false}
        borderBottom={false}
        borderLeft={false}
        borderRight
        borderColor={theme.border.default}
        borderDimColor
      >
        <Text
          bold
          color={focusColumn === 'phases' ? theme.ui.focus : theme.text.primary}
        >
          Phases
        </Text>
        {phaseWindow.hiddenBefore > 0 ? (
          <HiddenRows count={phaseWindow.hiddenBefore} label="previous" />
        ) : null}
        {phaseWindow.rows.map((phase) => (
          <PhaseRow
            key={phase.id}
            phase={phase}
            selected={selectedPhase?.id === phase.id}
            focused={focusColumn === 'phases'}
          />
        ))}
        {phaseWindow.hiddenAfter > 0 ? (
          <HiddenRows count={phaseWindow.hiddenAfter} label="more" />
        ) : null}
      </Box>
      <Box flexGrow={1} flexShrink={1} flexDirection="column" paddingX={1}>
        <Text
          bold
          color={focusColumn === 'agents' ? theme.ui.focus : theme.text.primary}
        >
          {selectedPhase?.title ?? 'All'} · {agents.length} agents
          {statusFilter !== 'all' ? ` · ${statusFilter}` : ''}
        </Text>
        {agents.length === 0 ? (
          <Text color={theme.text.secondary} dimColor>
            No agents in this phase.
          </Text>
        ) : (
          <>
            {agentWindow.hiddenBefore > 0 ? (
              <HiddenRows count={agentWindow.hiddenBefore} label="previous" />
            ) : null}
            {agentWindow.rows.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                selected={selectedAgent?.id === agent.id}
                focused={focusColumn === 'agents'}
                showMeta
              />
            ))}
            {agentWindow.hiddenAfter > 0 ? (
              <HiddenRows count={agentWindow.hiddenAfter} label="more" />
            ) : null}
          </>
        )}
        {view.error ? (
          <Box marginTop={1}>
            <Text color={theme.status.error} wrap="truncate">
              {view.error}
            </Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

function WorkflowAgentDetailLayout({
  task,
  agents,
  selectedAgent,
  contentWidth,
  promptExpanded,
  detailScrollOffset,
  onDetailMaxScrollOffsetChange,
}: {
  task: WorkflowUnifiedTask;
  agents: WorkflowAgentView[];
  selectedAgent?: WorkflowAgentView;
  contentWidth: number;
  promptExpanded: boolean;
  detailScrollOffset: number;
  onDetailMaxScrollOffsetChange: (maxOffset: number) => void;
}) {
  const selectedAgentIndex = Math.max(
    0,
    agents.findIndex((agent) => agent.id === selectedAgent?.id),
  );
  const agentWindow = windowRows(
    agents,
    selectedAgentIndex,
    DETAIL_AGENT_ROW_LIMIT,
  );

  return (
    <Box
      marginTop={1}
      flexDirection="row"
      borderStyle="single"
      borderColor={theme.border.default}
      borderDimColor
      minHeight={12}
    >
      <Box
        width={DETAIL_AGENT_COLUMN_WIDTH}
        flexDirection="column"
        paddingX={1}
        borderStyle="single"
        borderTop={false}
        borderBottom={false}
        borderLeft={false}
        borderRight
        borderColor={theme.border.default}
        borderDimColor
      >
        <Text bold>Agents</Text>
        {agentWindow.hiddenBefore > 0 ? (
          <HiddenRows count={agentWindow.hiddenBefore} label="previous" />
        ) : null}
        {agentWindow.rows.map((agent) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            selected={selectedAgent?.id === agent.id}
            focused
            showMeta={false}
          />
        ))}
        {agentWindow.hiddenAfter > 0 ? (
          <HiddenRows count={agentWindow.hiddenAfter} label="more" />
        ) : null}
      </Box>
      <Box
        flexGrow={1}
        flexShrink={1}
        flexDirection="column"
        paddingX={1}
        overflow="hidden"
        width={contentWidth}
      >
        {selectedAgent ? (
          <AgentDetail
            task={task}
            agent={selectedAgent}
            contentWidth={contentWidth}
            promptExpanded={promptExpanded}
            scrollOffset={detailScrollOffset}
            onMaxScrollOffsetChange={onDetailMaxScrollOffsetChange}
          />
        ) : (
          <Text color={theme.text.secondary} dimColor>
            No agent selected.
          </Text>
        )}
      </Box>
    </Box>
  );
}

function PhaseRow({
  phase,
  selected,
  focused,
}: {
  phase: WorkflowPhaseView;
  selected: boolean;
  focused: boolean;
}) {
  const active = selected && focused;
  return (
    <Box height={1} overflow="hidden">
      <Box width={2}>
        <Text color={active ? theme.ui.focus : undefined}>
          {active ? figures.pointer : phaseStatusMarker(phase.status)}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text
          color={active ? theme.ui.focus : undefined}
          dimColor={!selected && phase.status === 'pending'}
          wrap="truncate"
        >
          {phase.title}
        </Text>
      </Box>
      <Text color={active ? theme.ui.focus : theme.text.secondary}>
        {phase.doneAgents}/{phase.totalAgents}
      </Text>
    </Box>
  );
}

function AgentRow({
  agent,
  selected,
  focused,
  showMeta = true,
}: {
  agent: WorkflowAgentView;
  selected: boolean;
  focused: boolean;
  showMeta?: boolean;
}) {
  const active = selected && focused;
  return (
    <Box height={1} overflow="hidden">
      <Box width={2}>
        <Text color={active ? theme.ui.focus : agentStatusColor(agent.status)}>
          {active ? figures.pointer : agentStatusMarker(agent.status)}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text
          color={active ? theme.ui.focus : undefined}
          dimColor={!selected && agent.status === 'pending'}
          wrap="truncate"
        >
          {agent.label}
          {agent.cached ? ' · cached' : ''}
        </Text>
      </Box>
      {showMeta ? (
        <Box flexShrink={0} marginLeft={1} overflow="hidden">
          <Text color={theme.text.secondary} wrap="truncate">
            {formatAgentMeta(agent)}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function AgentDetail({
  task,
  agent,
  contentWidth,
  promptExpanded,
  scrollOffset,
  onMaxScrollOffsetChange,
}: {
  task: WorkflowUnifiedTask;
  agent: WorkflowAgentView;
  contentWidth: number;
  promptExpanded: boolean;
  scrollOffset: number;
  onMaxScrollOffsetChange: (maxOffset: number) => void;
}) {
  const transcript = useWorkflowAgentTranscript({ task, agent });
  const {
    transcriptPrompt,
    structuredOutcome,
    transcriptOutcome,
    transcriptActivity,
  } = useMemo(
    () => ({
      transcriptPrompt: firstUserPrompt(transcript.messages),
      structuredOutcome: finalStructuredOutput(transcript.messages),
      transcriptOutcome: finalAssistantText(transcript.messages),
      transcriptActivity: recentToolActivities(transcript.messages),
    }),
    [transcript.messages],
  );
  const promptText =
    agent.prompt ?? transcriptPrompt ?? agent.promptPreview ?? '';
  const promptLines = wrapWorkflowDetailLines(promptText, contentWidth);
  const outcome =
    structuredOutcome ??
    transcriptOutcome ??
    agent.resultPreview ??
    agent.error ??
    (agent.status === 'running' ? 'Still running...' : agent.state);
  const outcomeIsErrorFallback =
    structuredOutcome === undefined &&
    transcriptOutcome === undefined &&
    agent.resultPreview === undefined &&
    (agent.error !== undefined || agent.status === 'error');
  const outcomeLines = wrapWorkflowDetailLines(outcome, contentWidth);
  const liveActivity = liveToolActivity(agent);
  const useLiveActivity =
    liveActivity.recent.length > 0 &&
    (agent.status === 'running' || transcriptActivity.recent.length === 0);
  const activity = useLiveActivity ? liveActivity : transcriptActivity;
  const totalToolCalls = agent.toolCalls ?? activity.total;
  const summary = formatAgentDetailSummary(agent);
  const detailRows: React.ReactNode[] = [
    <Text key="title" bold wrap="truncate">
      {truncateWorkflowDisplayText(agent.label, contentWidth)}
    </Text>,
    <Text key="summary" color={theme.text.secondary} wrap="wrap">
      {summary}
    </Text>,
    <Box key="prompt-gap" height={1} />,
    <Text key="prompt-title" color={theme.text.secondary}>
      Prompt{promptLines.length > 0 ? ` · ${promptLines.length} lines` : ''}
      {promptLines.length > MAX_AGENT_DETAIL_PROMPT_LINES
        ? promptExpanded
          ? ' · expanded'
          : ' · ↵ expand'
        : ''}
    </Text>,
  ];

  if (promptLines.length > 0) {
    const visiblePromptLines = promptExpanded
      ? promptLines
      : promptLines.slice(0, MAX_AGENT_DETAIL_PROMPT_LINES);
    visiblePromptLines.forEach((line, index) => {
      detailRows.push(
        <Text
          key={`prompt-${index}`}
          color={theme.text.secondary}
          wrap="truncate"
        >
          {line}
        </Text>,
      );
    });
    if (!promptExpanded && promptLines.length > MAX_AGENT_DETAIL_PROMPT_LINES) {
      detailRows.push(
        <Text key="prompt-more" color={theme.text.secondary} dimColor>
          ... {promptLines.length - MAX_AGENT_DETAIL_PROMPT_LINES} more lines
        </Text>,
      );
    }
  } else {
    detailRows.push(
      <Text key="prompt-empty" color={theme.text.secondary} dimColor>
        Not available yet.
      </Text>,
    );
  }

  detailRows.push(
    <Box key="activity-gap" height={1} />,
    <Text key="activity-title" color={theme.text.secondary}>
      Activity
      {totalToolCalls > 0
        ? ` · last ${
            activity.recent.length > 0
              ? activity.recent.length
              : Math.min(RECENT_AGENT_ACTIVITY_LIMIT, totalToolCalls)
          } of ${totalToolCalls} tool calls`
        : ''}
    </Text>,
  );

  if (activity.recent.length > 0) {
    activity.recent.forEach((item, index) => {
      detailRows.push(
        <Text
          key={`activity-${index}`}
          color={theme.text.secondary}
          wrap="truncate"
        >
          {truncateWorkflowDisplayText(item, contentWidth)}
        </Text>,
      );
    });
  } else if (transcript.loading) {
    detailRows.push(
      <Text key="activity-loading" color={theme.text.secondary}>
        Loading transcript...
      </Text>,
    );
  } else {
    detailRows.push(
      <Text key="activity-fallback" wrap="truncate">
        {agent.toolCalls !== undefined
          ? `${agent.toolCalls} tool call${agent.toolCalls === 1 ? '' : 's'}`
          : agent.status === 'running'
            ? 'Running...'
            : 'No recent activity.'}
      </Text>,
    );
    if (transcript.error) {
      detailRows.push(
        <Text key="activity-error" color={theme.status.error} wrap="truncate">
          {truncateWorkflowDisplayText(
            `Transcript unavailable: ${transcript.error}`,
            contentWidth,
          )}
        </Text>,
      );
    }
  }

  detailRows.push(
    <Box key="outcome-gap" height={1} />,
    <Text key="outcome-title" color={theme.text.secondary}>
      Outcome
    </Text>,
  );
  if (outcomeLines.length > 0) {
    outcomeLines.forEach((line, index) => {
      detailRows.push(
        <Text
          key={`outcome-${index}`}
          color={outcomeIsErrorFallback ? theme.status.error : undefined}
          wrap="truncate"
        >
          {line}
        </Text>,
      );
    });
  } else {
    detailRows.push(
      <Text key="outcome-empty" color={theme.text.secondary} dimColor>
        Not available yet.
      </Text>,
    );
  }

  const maxScrollOffset = Math.max(
    0,
    detailRows.length - DETAIL_CONTENT_ROW_LIMIT,
  );
  const effectiveScrollOffset = clampScrollOffset(
    scrollOffset,
    maxScrollOffset,
  );
  useLayoutEffect(() => {
    onMaxScrollOffsetChange(maxScrollOffset);
  }, [maxScrollOffset, onMaxScrollOffsetChange]);

  const detailWindow = windowRowsByOffset(
    detailRows,
    effectiveScrollOffset,
    DETAIL_CONTENT_ROW_LIMIT,
  );

  return (
    <Box flexDirection="column" overflow="hidden">
      {detailWindow.hiddenBefore > 0 ? (
        <HiddenRows count={detailWindow.hiddenBefore} label="previous" />
      ) : null}
      {detailWindow.rows}
      {detailWindow.hiddenAfter > 0 ? (
        <HiddenRows count={detailWindow.hiddenAfter} label="more" />
      ) : null}
    </Box>
  );
}

function filterWorkflowAgentsByStatus(
  agents: WorkflowAgentView[],
  filter: WorkflowAgentStatusFilter,
): WorkflowAgentView[] {
  if (filter === 'all') return agents;
  if (filter === 'failed') {
    return agents.filter((agent) => agent.status === 'error');
  }
  if (filter === 'cached') {
    return agents.filter((agent) => agent.cached);
  }
  return agents.filter((agent) => agent.status === filter);
}

function firstUserPrompt(messages: Message[]): string | undefined {
  for (const message of messages) {
    if (message.type !== 'user') continue;
    const text = getDisplayableUserText(message) ?? '';
    if (text.trim()) return text;
  }
  return undefined;
}

function finalAssistantText(messages: Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.type !== 'assistant') continue;
    const text = getAssistantTextBlocks(message).join('\n').trim();
    if (text) return text;
  }
  return undefined;
}

function finalStructuredOutput(messages: Message[]): string | undefined {
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (message.type !== 'assistant') continue;
    const content = message.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === 'tool_use') {
        toolNames.set(block.id, block.name);
      }
    }
  }

  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex--
  ) {
    const message = messages[messageIndex];
    if (message?.type !== 'user') continue;
    const content = message.message.content;
    if (!Array.isArray(content)) continue;
    for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex--) {
      const block = content[blockIndex];
      if (
        block?.type !== 'tool_result' ||
        toolNames.get(block.tool_use_id) !==
          WORKFLOW_STRUCTURED_OUTPUT_TOOL_NAME
      ) {
        continue;
      }
      const toolUseResult = (message as { toolUseResult?: unknown })
        .toolUseResult;
      if (toolUseResult !== undefined) {
        return stringifyWorkflowOutcome(toolUseResult);
      }
      return stringifyWorkflowOutcome(block.content);
    }
  }
  return undefined;
}

function recentToolActivities(messages: Message[]): {
  total: number;
  recent: string[];
} {
  const activities: string[] = [];
  for (const message of messages) {
    if (message.type !== 'assistant') continue;
    const content = message.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== 'tool_use') continue;
      if (block.name === WORKFLOW_STRUCTURED_OUTPUT_TOOL_NAME) continue;
      const input = normalizeToolInput(block.input);
      const metadata = getToolUseDisplayMetadata(block.name, input);
      const displayName = metadata.displayName || block.name;
      const description = metadata.description?.trim();
      activities.push(
        description ? `${displayName}(${description})` : `${displayName}()`,
      );
    }
  }
  return {
    total: activities.length,
    recent: activities.slice(-RECENT_AGENT_ACTIVITY_LIMIT),
  };
}

function liveToolActivity(agent: WorkflowAgentView): {
  total: number;
  recent: string[];
} {
  if (agent.recentToolActivities && agent.recentToolActivities.length > 0) {
    return {
      total: agent.toolCalls ?? agent.recentToolActivities.length,
      recent: agent.recentToolActivities.slice(-RECENT_AGENT_ACTIVITY_LIMIT),
    };
  }
  if (!agent.lastToolName) {
    return { total: agent.toolCalls ?? 0, recent: [] };
  }
  const activity = agent.lastToolSummary
    ? `${agent.lastToolName}(${agent.lastToolSummary})`
    : `${agent.lastToolName}()`;
  return {
    total: agent.toolCalls ?? 1,
    recent: [activity],
  };
}

function stringifyWorkflowOutcome(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.trim() || undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function saveWorkflowScriptToProject(
  projectRoot: string,
  task: WorkflowUnifiedTask,
): Promise<string> {
  const script = await readFile(task.scriptPath, 'utf8');
  const workflowsDir = getProjectWorkflowsDir(projectRoot);
  await mkdir(workflowsDir, { recursive: true, mode: 0o700 });
  const baseName = slugifyWorkflowName(task.workflowName);
  const preferredPath = path.join(workflowsDir, `${baseName}.js`);
  try {
    await writeFile(preferredPath, script, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    return preferredPath;
  } catch (error) {
    if (!isFileExistsError(error)) throw error;
  }

  const fallbackPath = path.join(
    workflowsDir,
    `${baseName}-${task.workflowRunId}.js`,
  );
  await writeFile(fallbackPath, script, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  return fallbackPath;
}

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'EEXIST'
  );
}

export function truncateWorkflowDisplayText(
  value: string,
  maxWidth: number,
): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (maxWidth <= 0 || text.length === 0) return '';
  if (getCachedStringWidth(text) <= maxWidth) return text;
  if (maxWidth <= 3) return '.'.repeat(maxWidth);

  const suffix = '...';
  const targetWidth = maxWidth - getCachedStringWidth(suffix);
  let result = '';
  let width = 0;

  for (const char of Array.from(text)) {
    const nextWidth = getCachedStringWidth(char);
    if (width + nextWidth > targetWidth) break;
    result += char;
    width += nextWidth;
  }

  return `${result}${suffix}`;
}

function HiddenRows({ count, label }: { count: number; label: string }) {
  return (
    <Box height={1} overflow="hidden">
      <Text color={theme.text.secondary} dimColor>
        ... {count} {label}
      </Text>
    </Box>
  );
}

function windowRows<T>(
  rows: T[],
  selectedIndex: number,
  maxRows: number,
): { rows: T[]; hiddenBefore: number; hiddenAfter: number } {
  if (rows.length <= maxRows) {
    return { rows, hiddenBefore: 0, hiddenAfter: 0 };
  }
  const start = calculateCenteredWindow(selectedIndex, rows.length, maxRows);
  const end = start + maxRows;
  return {
    rows: rows.slice(start, end),
    hiddenBefore: start,
    hiddenAfter: rows.length - end,
  };
}

function windowRowsByOffset<T>(
  rows: T[],
  offset: number,
  maxRows: number,
): { rows: T[]; hiddenBefore: number; hiddenAfter: number } {
  if (rows.length <= maxRows) {
    return { rows, hiddenBefore: 0, hiddenAfter: 0 };
  }
  const start = Math.max(0, Math.min(offset, rows.length - maxRows));
  const end = start + maxRows;
  return {
    rows: rows.slice(start, end),
    hiddenBefore: start,
    hiddenAfter: rows.length - end,
  };
}

function wrapWorkflowDetailLines(text: string, maxWidth: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return wrapText(trimmed, Math.max(1, maxWidth), 'wrap')
    .split('\n')
    .filter((line) => line.length > 0);
}

function formatAgentDetailSummary(agent: WorkflowAgentView): string {
  const parts = [`state: ${agent.state}`];
  if (agent.agentType) parts.push(`type: ${agent.agentType}`);
  if (agent.model) parts.push(`model: ${agent.model}`);
  if (agent.attempt && agent.maxAttempts) {
    parts.push(`attempt ${agent.attempt}/${agent.maxAttempts}`);
  } else if (agent.attempt) {
    parts.push(`attempt ${agent.attempt}`);
  }
  if (agent.durationMs !== undefined) {
    parts.push(formatWorkflowDuration(agent.durationMs));
  }
  if (agent.tokens !== undefined) {
    parts.push(`${agent.tokens} token${agent.tokens === 1 ? '' : 's'}`);
  }
  if (agent.toolCalls !== undefined) {
    parts.push(
      `${agent.toolCalls} tool call${agent.toolCalls === 1 ? '' : 's'}`,
    );
  }
  if (agent.cached) parts.push('cached');
  if (agent.skipped || agent.status === 'skipped') parts.push('skipped');
  if (agent.error || agent.status === 'error') parts.push('error');
  return parts.join(' · ');
}

function formatAgentMeta(agent: WorkflowAgentView): string {
  if (agent.status === 'pending') return agent.state;
  const parts = [agent.model ?? agent.agentType].filter(Boolean);
  if (agent.status === 'running' && agent.lastToolName) {
    parts.push(agent.lastToolName);
  }
  if (agent.toolCalls !== undefined) {
    parts.push(`${agent.toolCalls} tool`);
  }
  return parts.length > 0 ? parts.join(' · ') : agent.state;
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, index));
}

function clampScrollOffset(offset: number, maxOffset: number): number {
  return Math.max(0, Math.min(offset, maxOffset));
}

function statusColor(status: WorkflowUnifiedTask['status']): string {
  switch (status) {
    case 'running':
      return theme.status.warning;
    case 'completed':
      return theme.status.success;
    case 'failed':
    case 'killed':
      return theme.status.error;
    default:
      return theme.text.secondary;
  }
}

function phaseStatusMarker(status: WorkflowPhaseView['status']): string {
  switch (status) {
    case 'done':
      return '✓';
    case 'error':
      return '×';
    case 'running':
      return '○';
    case 'pending':
    default:
      return ' ';
  }
}

function agentStatusMarker(status: WorkflowAgentView['status']): string {
  switch (status) {
    case 'done':
      return '✓';
    case 'error':
      return '×';
    case 'skipped':
      return '-';
    case 'running':
      return '○';
    case 'pending':
    default:
      return ' ';
  }
}

function agentStatusColor(status: WorkflowAgentView['status']): string {
  switch (status) {
    case 'done':
      return theme.status.success;
    case 'error':
      return theme.status.error;
    case 'skipped':
      return theme.text.secondary;
    case 'running':
      return theme.status.warning;
    case 'pending':
    default:
      return theme.text.secondary;
  }
}
