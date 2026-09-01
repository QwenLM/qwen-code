// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  createRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  DaemonHttpError,
  type DaemonInputAnnotation,
  type DaemonSessionSummary,
  type DaemonSessionContextUsageStatus,
  type DaemonSessionMonitorTaskStatus,
  type DaemonSessionShellTaskStatus,
  type DaemonSessionStatsStatus,
  type DaemonSessionTaskStatus,
  type DaemonSettingDescriptor,
  type DaemonSkillToggleMutation,
  type DaemonWorkspaceGitStatus,
  type GoalSnapshotV2,
} from '@qwen-code/sdk/daemon';
import type { WebShellApi } from './App';
import type { Message } from './adapters/types';
import type {
  VoiceStatusRevision,
  VoiceWorkspaceTarget,
} from './voice/voice-workspace-target';
import type {
  ChatHeaderRenderInfo,
  WebShellComposerToolbarRenderInfo,
} from './customization';
import { serializeContextUsageMessage } from './components/messages/ContextUsageMessage';
import { serializeStatsMessage } from './components/messages/StatsMessage';
import { serializeStatusMessage } from './components/messages/StatusMessage';
import { loadSplitSessions, saveSplitSessions } from './utils/splitUrl';

type StreamingState = 'idle' | 'responding';

type MockConnection = {
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  sessionId: string | undefined;
  sessionContext?: { kind: 'standalone' };
  context?: { sessionId: string };
  clientId: string;
  displayName: string | undefined;
  titleSource?: 'manual' | 'auto';
  workspaceCwd: string;
  currentModel: string;
  currentMode: string;
  models: Array<{
    id: string;
    label?: string;
    reasoningPreview?: {
      enabled: boolean;
      effort: string;
      efforts: string[];
      defaultEffort: string;
      canDisable?: boolean;
    };
  }>;
  commands: unknown[];
  skills: string[] | undefined;
  capabilities: { qwenCodeVersion: string; features: string[] };
  loadingTranscript: boolean;
  catchingUp: boolean;
  error?: string;
  errorStatus?: number;
  missingSession?: boolean;
  sessionContext?:
    | { kind: 'workspace'; cwd: string }
    | { kind: 'standalone' }
    | { kind: 'live' };
  gitBranch?: string;
  gitStatus?: DaemonWorkspaceGitStatus;
  voiceTarget?: VoiceWorkspaceTarget;
  voiceStatusRevision?: VoiceStatusRevision;
  goalState?: GoalSnapshotV2;
  standaloneSession?: {
    creationRecovery?: {
      state: 'creating';
      sessionId: string;
    };
    errorCode?: 'working_directory_missing';
  };
};

function activeGoalSnapshot(
  objective = 'ship it',
  revision = 1,
): GoalSnapshotV2 {
  return {
    v: 2,
    activity: 'idle',
    goal: {
      goalId: 'goal-1',
      revision,
      objective,
      status: 'active',
      evidenceCursor: { recordId: null },
      turnCount: 2,
      activeTimeMs: 1_000,
      createdAt: 123,
      updatedAt: 456,
    },
  };
}

type ChatEditorTestProps = {
  onSubmit: (
    text: string,
    images?: { data: string; media_type: string }[],
    files?: { name: string; media_type: string; text: string }[],
    commitAccepted?: () => void,
    metadata?: { inputAnnotations?: DaemonInputAnnotation[] },
  ) => boolean | void;
  onCancel?: () => void;
  onInputTextChange?: (text: string) => void;
  onAttachmentsChange?: (hasAttachments: boolean) => void;
  onStartNewSessionSuggestion?: () => void;
  newSessionSuggestion?: { isVisible: boolean; classifiedInput: string } | null;
  skills?: Array<{ name: string; description: string }>;
  commands?: Array<{ name: string }>;
  isPreparing?: boolean;
  cancelArmed?: boolean;
  disabled?: boolean;
  dialogOpen?: boolean;
  onToggleShortcuts?: () => void;
  reasoning?: {
    enabled: boolean;
    effort: string;
    efforts: string[];
    defaultEffort: string;
    canDisable?: boolean;
  };
  onSelectModel?: (modelId: string) => void;
  onSelectReasoningEffort?: (value: string) => Promise<void> | void;
  voiceTarget?: VoiceWorkspaceTarget;
  voiceStatusRevision?: VoiceStatusRevision;
  placeholderText?: string;
  sessionName?: string;
  workspaces?: Array<{
    id: string;
    cwd: string;
    label: string;
    primary: boolean;
    trusted: boolean;
  }>;
  atWorkspaceCwd?: string;
  composerScopeKey?: string;
  workspaceFeaturesEnabled?: boolean;
  selectedWorkspaceCwd?: string;
  onSelectWorkspace?: (cwd: string | undefined) => void;
  onCreateScratchWorkspace?: () => void;
  onOpenExistingWorkspace?: () => void;
  scratchWorkspaceSupported?: boolean;
  existingFolderWorkspaceSupported?: boolean;
  gitModeIntent?: { mode: string; name?: string; slug?: string };
  onGitModeIntentChange?: (intent: {
    mode: string;
    name?: string;
    slug?: string;
  }) => void;
  gitBranch?: string;
  gitStatus?: DaemonWorkspaceGitStatus;
  onOpenGitDiff?: () => void;
  visibleToolbarActions?: string[];
  tokenCount?: number;
  contextWindow?: number;
  onShowContextUsage?: () => void;
  onChatWidthModeChange?: (mode: '1000' | 'wide') => void;
};

type AddWorkspaceDialogTestProps = {
  onClose: () => void;
  onAdd: (cwd: string, persist: boolean, displayName?: string) => Promise<void>;
  onSuggest?: (prefix: string) => Promise<unknown>;
  onPick?: () => Promise<string | undefined>;
  displayNameEnabled?: boolean;
  persistenceSupported?: boolean;
};

function voiceSetting(effective: string): DaemonSettingDescriptor {
  return {
    key: 'voiceModel',
    type: 'string',
    label: 'Voice model',
    category: 'model',
    requiresRestart: false,
    default: '',
    values: { effective, workspace: effective },
  };
}

function sessionWorkflowSetting(): DaemonSettingDescriptor {
  return {
    key: 'experimental.sessionWorkflow',
    type: 'boolean',
    label: 'Session Workflow Plan & Review',
    category: 'Experimental',
    requiresRestart: false,
    default: false,
    values: { effective: true },
  };
}

const {
  mockCollectSystemInfo,
  mockConnection,
  mockSessionActions,
  mockWorkspace,
  mockWorkspaceActions,
  mockMcp,
  mockStore,
  mockFollowup,
  testState,
  rawEnqueuePrompt,
  queuedTexts,
  editLastQueuedPrompt,
  clearQueuedPrompts,
  editorClear,
  editorCommit,
  editorFocus,
  editorInsertText,
  editorRestoreInputAnnotations,
  settingsReload,
  settingsSetValue,
  qualifiedWorkspaceSettings,
  rootWorkspaceProviders,
  qualifiedWorkspaceProviders,
  qualifiedSetWorkspaceSetting,
  sessionCatalogController,
  mockReleaseWebTerminal,
} = vi.hoisted(() => {
  const connection: MockConnection = {
    status: 'connected',
    sessionId: 'session-1',
    clientId: 'client-1',
    displayName: 'Session One',
    workspaceCwd: '/tmp/project',
    currentModel: 'qwen',
    currentMode: 'default',
    models: [{ id: 'qwen', label: 'Qwen' }],
    commands: [],
    skills: [],
    capabilities: { qwenCodeVersion: '1.2.3', features: [] },
    loadingTranscript: false,
    catchingUp: false,
  };
  const loadSkillsStatus = vi.fn().mockResolvedValue({ skills: [] });
  const qualifiedWorkspaceSettings = vi.fn();
  const rootWorkspaceProviders = vi.fn();
  const qualifiedWorkspaceProviders = vi.fn();
  const qualifiedSetWorkspaceSetting = vi.fn();
  const workspaceClient = {
    workspaceByCwd: vi.fn(() => ({
      workspaceGit: vi.fn().mockResolvedValue({ branch: 'main' }),
      workspaceSkills: loadSkillsStatus,
      workspaceGitHubPullRequests: vi.fn().mockResolvedValue({
        v: 1,
        workspaceCwd: '/workspace',
        available: true,
        pullRequests: [],
      }),
    })),
    workspaceProviders: rootWorkspaceProviders,
    workspaceById: vi.fn(() => ({
      workspaceSettings: qualifiedWorkspaceSettings,
      workspaceProviders: qualifiedWorkspaceProviders,
      setWorkspaceSetting: qualifiedSetWorkspaceSetting,
    })),
    sessionStatus: vi.fn(() =>
      Promise.resolve({ workspaceCwd: '/tmp/project' }),
    ),
    startLive: vi.fn().mockResolvedValue({
      v: 1,
      available: true,
      state: 'listening',
      shortcut: 'Command+Q',
    }),
    getStandaloneSession: vi.fn().mockResolvedValue({
      sessionId: 'session-1',
      sourceType: 'standalone',
      context: { kind: 'standalone' },
      isArchived: false,
    }),
    listWorkspaceSessions: vi.fn(() => Promise.resolve([])),
    createSideTaskSession: vi.fn().mockResolvedValue({
      sessionId: 'side-session-1',
      clientId: 'side-client-1',
      displayName: 'Side task',
    }),
    detachSession: vi.fn().mockResolvedValue(undefined),
    renameStandaloneSession: vi.fn().mockResolvedValue(undefined),
    unarchiveStandaloneSessions: vi.fn().mockResolvedValue({
      unarchived: [],
      alreadyActive: [],
      notFound: [],
      errors: [],
    }),
    repairStandaloneSessionDirectory: vi.fn().mockResolvedValue(undefined),
    resolveSubagentSession: vi
      .fn()
      .mockRejectedValue(new Error('Subagent details unavailable')),
  };
  const settingsSetValue = vi.fn().mockResolvedValue(undefined);
  const mockCollectSystemInfo = vi.fn();
  return {
    mockCollectSystemInfo,
    mockConnection: connection,
    mockSessionActions: {
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      btwSession: vi.fn().mockResolvedValue({ answer: 'side answer' }),
      generateSessionContent: vi.fn(async function* () {}),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      attachSession: vi.fn().mockResolvedValue(undefined),
      clearSession: vi.fn().mockResolvedValue(undefined),
      releaseSession: vi.fn().mockResolvedValue(undefined),
      renameSession: vi.fn().mockResolvedValue(undefined),
      recapSession: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        recap: null,
      }),
      refreshCommands: vi.fn().mockResolvedValue(undefined),
      setModel: vi.fn().mockResolvedValue(undefined),
      setReasoningEffort: vi.fn().mockResolvedValue(undefined),
      setApprovalMode: vi.fn().mockResolvedValue(undefined),
      getRewindSnapshots: vi.fn().mockResolvedValue([]),
      rewindSession: vi.fn().mockResolvedValue(undefined),
      branchSession: vi.fn().mockResolvedValue({
        sessionId: 'branch-1',
        displayName: 'Historical branch',
        switchStarted: true,
      }),
      submitPermission: vi.fn().mockResolvedValue(true),
      clearGoal: vi.fn().mockResolvedValue(undefined),
      getGoal: vi.fn().mockResolvedValue({
        snapshot: { v: 2, activity: 'idle', goal: null },
      }),
      controlGoal: vi.fn().mockResolvedValue({
        snapshot: { v: 2, activity: 'idle', goal: null },
      }),
      applyGoalSnapshot: vi.fn((sessionId: string, snapshot: unknown) => {
        if (mockConnection.sessionId === sessionId) {
          mockConnection.goalState = snapshot as never;
        }
      }),
      forkSession: vi.fn().mockResolvedValue({ launched: false }),
      sendShellCommand: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
      getStats: vi.fn().mockResolvedValue({}),
      getContextUsage: vi.fn().mockResolvedValue({}),
      readAttachment: vi.fn().mockResolvedValue({
        data: 'aGVsbG8=',
        mimeType: 'text/plain',
      }),
      getTasks: vi.fn().mockResolvedValue({
        v: 1,
        sessionId: 'session-1',
        now: 1,
        tasks: [],
      }),
      loadArtifacts: vi.fn().mockResolvedValue({ artifacts: [] }),
      loadSession: vi.fn().mockResolvedValue(undefined),
      reloadSession: vi.fn().mockResolvedValue(undefined),
    },
    mockWorkspace: {
      capabilities: {
        workspaces: [{ id: 'primary', cwd: '/workspace', primary: true }],
      },
      status: 'connected' as 'connected' | 'error',
      client: workspaceClient,
      refreshCapabilities: vi.fn(),
    },
    mockWorkspaceActions: {
      readWorkspaceFile: vi.fn().mockResolvedValue({
        content: '',
        truncated: false,
      }),
      stat: vi.fn().mockResolvedValue({
        kind: 'stat',
        path: '',
        type: 'file',
        sizeBytes: 0,
        modifiedMs: 0,
      }),
      loadSkillsStatus,
      loadProviders: vi.fn().mockResolvedValue({ current: null }),
      loadPreflight: vi.fn().mockResolvedValue(null),
      loadEnv: vi.fn().mockResolvedValue(null),
      loadMcpStatus: vi.fn().mockResolvedValue({ servers: [] }),
      loadMcpTools: vi.fn().mockResolvedValue([]),
      loadMcpResources: vi.fn().mockResolvedValue([]),
      addWorkspace: vi.fn(),
      addScratchWorkspace: vi.fn(),
      suggestWorkspacePaths: vi.fn(),
      pickWorkspaceDirectory: vi.fn(),
      listScheduledTasks: vi.fn(),
      updateScheduledTask: vi.fn(),
      deleteScheduledTask: vi.fn(),
      deleteModel: vi.fn().mockResolvedValue(undefined),
      controlGoal: vi.fn().mockResolvedValue({
        snapshot: { v: 2, activity: 'idle', goal: null },
      }),
    },
    mockMcp: {
      initialize: vi.fn().mockResolvedValue({ accepted: true }),
      reloadConfig: vi.fn().mockResolvedValue({ accepted: true }),
      reload: vi.fn(),
      loadTools: vi.fn(),
      loadResources: vi.fn(),
      restartServer: vi.fn(),
      manageServer: vi.fn(),
      addServer: vi.fn(),
      removeServer: vi.fn(),
      loading: false,
      error: undefined,
    },
    mockStore: {
      getSnapshot: vi.fn(() => ({ blocks: testState.blocks })),
      dispatch: vi.fn(),
      reset: vi.fn(),
      appendLocalUserMessage: vi.fn(),
      appendLocalAssistantMessage: vi.fn(),
    },
    mockFollowup: {
      clear: vi.fn(),
      onAcceptFollowup: vi.fn(),
      onDismissFollowup: vi.fn(),
    },
    testState: {
      ownerVersion: 0,
      prompt: 'hello',
      inputAnnotations: undefined as DaemonInputAnnotation[] | undefined,
      promptImages: undefined as
        | { data: string; media_type: string }[]
        | undefined,
      streamingState: 'idle' as StreamingState,
      sessionHasActivePrompt: false,
      blocks: [] as unknown[],
      liveBlocks: undefined as unknown[] | undefined,
      snapshotCallOptions: [] as Array<
        { structuralOnly?: boolean } | undefined
      >,
      messages: [] as unknown[],
      streamingTailMessages: undefined as unknown[] | undefined,
      queuedPromptHoldHistory: [] as boolean[],
      queuedPromptStreamingState: 'idle',
      queuedPromptSessionHasActivePrompt: false,
      chatEditorRenderCount: 0,
      latestChatEditorProps: null as ChatEditorTestProps | null,
      onChatEditorLayout: null as ((props: ChatEditorTestProps) => void) | null,
      latestToastHostElevated: false,
      latestStatusBarTasks: null as DaemonSessionMonitorTaskStatus[] | null,
      latestStatusBarOnOpenTasks: null as (() => void) | null,
      latestStatusBarHideSettings: false,
      latestMessageListProps: null as {
        messages?: Array<{
          role?: string;
          content?: string;
          answer?: string;
          isPending?: boolean;
        }>;
        showRetryHint?: boolean;
        onRetryClick?: () => void;
        failedPromptMessageId?: string;
        onRetryFailedPrompt?: () => void;
        onBranchSession?: (branchRecordId?: string) => void | Promise<void>;
        onAttachmentPreview?: (file: {
          name: string;
          attachmentId?: string;
        }) => void;
        isResponding?: boolean;
        transcriptReloadPaused?: boolean;
        activeTurnStartedAt?: number;
        transcriptBlockCount?: number;
        terminalBackgroundShellTaskIds?: ReadonlySet<string>;
      } | null,
      latestBtwMessageProps: null as {
        question: string;
        answer: string;
        isPending: boolean;
      } | null,
      latestAddWorkspaceDialogProps: null as AddWorkspaceDialogTestProps | null,
      latestSessionOverviewProps: null as {
        onOpenSession?: (sessionId: string, workspaceCwd?: string) => void;
        onOpenSplit?: (sessionIds: string[]) => void;
        onCurrentSessionRemoved?: (session: {
          sessionId: string;
          workspaceCwd: string;
        }) => Promise<boolean | void> | boolean | void;
        manageLiveState?: boolean;
      } | null,
      latestToolApprovalKeyboardActive: null as boolean | null,
      toolApprovalKeyboardActiveHistory: [] as Array<boolean | null>,
      latestToolApprovalPlanTodos: [] as Array<{ id: string }>,
      latestToolApprovalOnConfirm: null as
        | ((id: string, selectedOption: string) => void | Promise<void>)
        | null,
      latestAskUserQuestionKeyboardActive: null as boolean | null,
      askUserKeyboardActiveHistory: [] as Array<boolean | null>,
      latestTodoPanelTodos: [] as Array<{
        id: string;
        blockedBy?: string[];
      }>,
      latestTodoPanelOnOpen: null as (() => void) | null,
      latestAskUserQuestionOnError: null as
        | ((error: unknown, fallback: string) => void)
        | null,
      latestBackgroundTasksRefreshTrigger: null as number | null,
      backgroundTasks: [] as DaemonSessionTaskStatus[],
      latestMonitorDetailsOnOpen: null as
        | ((tool: {
            callId: string;
            toolName: string;
            status: 'completed';
          }) => Promise<boolean>)
        | null,
      latestTasksStatusProps: null as {
        planTodos?: Array<{ id: string }>;
        agentTools?: Array<{ callId: string }>;
        onOpenMonitor?: (task: DaemonSessionMonitorTaskStatus) => void;
      } | null,
      settings: [] as DaemonSettingDescriptor[],
      settingsLoading: false,
      // A background revalidation: the real resource sets loading:true while
      // keeping the last-known-good data and status.
      settingsReloading: false,
      settingsError: undefined as Error | undefined,
      latestSettingsHookOptions: undefined as
        | { autoLoad?: boolean; enabled?: boolean }
        | undefined,
      latestProvidersHookOptions: undefined as
        | { autoLoad?: boolean; enabled?: boolean }
        | undefined,
      workspaceEventSignals: {
        artifactsVersion: 0,
        extensionsVersion: 0,
        skillsVersion: 0,
        lastSkillMutation: undefined as DaemonSkillToggleMutation | undefined,
        skillMutationsByCwd: undefined as
          | Record<string, DaemonSkillToggleMutation[]>
          | undefined,
      },
      latestSettingsState: null as {
        settings: DaemonSettingDescriptor[];
      } | null,
      latestSplitViewProps: null as {
        includeOtherWorkspaces?: boolean;
        workspaceCwd?: string;
        sessionWorkflowEnabled?: boolean;
      } | null,
      latestSettingsInitialCategory: undefined as string | undefined,
      latestModelManagement: null as {
        busy?: boolean;
        onSelectModel?: (modelId: string) => void;
        onDeleteModel?: (target: {
          authType: string;
          modelId: string;
          baseUrl?: string;
        }) => void;
      } | null,
      latestScheduledTasksProps: null as {
        onRunPrompt?: (
          prompt: string,
          sessionId: string | null,
        ) => Promise<void>;
        onCreateViaChat?: () => void;
        workspaces?: Array<{ id: string; cwd: string }>;
        lockedWorkspace?: { id: string; cwd: string; primary: boolean };
        currentSession?: {
          sessionId?: string;
          pendingInteractionCount?: number;
        };
        currentSessionSchedulingAvailable?: boolean;
      } | null,
      latestGoalsProps: null as {
        onCreateGoal?: (condition: string) => Promise<void>;
        onOpenSession?: (sessionId: string) => void;
      } | null,
    },
    rawEnqueuePrompt: vi.fn(() => true),
    queuedTexts: [] as string[],
    editLastQueuedPrompt: vi.fn(() => false),
    clearQueuedPrompts: vi.fn(() => false),
    editorClear: vi.fn(),
    editorCommit: vi.fn(),
    editorFocus: vi.fn(),
    editorInsertText: vi.fn(),
    editorRestoreInputAnnotations: vi.fn(),
    settingsReload: vi.fn().mockResolvedValue(undefined),
    settingsSetValue,
    qualifiedWorkspaceSettings,
    rootWorkspaceProviders,
    qualifiedWorkspaceProviders,
    qualifiedSetWorkspaceSetting,
    sessionCatalogController: {
      invalidateWorkspace: vi.fn(),
      refreshWorkspace: vi.fn(),
      sessionCreated: vi.fn(),
      promptAdmitted: vi.fn(),
      promptAdmissionUncertain: vi.fn(),
      renamed: vi.fn(),
      turnCompleted: vi.fn(),
    },
    mockReleaseWebTerminal: vi.fn(),
  };
});

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => {
  const ownerGuard = {
    capture: () => {
      const ownerVersion = testState.ownerVersion;
      return { isCurrent: () => testState.ownerVersion === ownerVersion };
    },
  };
  return {
    DAEMON_APPROVAL_MODES: ['default', 'plan', 'auto-edit', 'auto', 'yolo'],
    // This harness only models the parent session connection.
    DaemonSessionProvider: ({
      children,
      clientId,
    }: {
      children: ReactNode;
      clientId?: string;
    }) => (clientId?.startsWith('side-task:') ? null : children),
    useActions: () => mockSessionActions,
    useConnection: () => mockConnection,
    useDaemonSessionOwnerGuard: () => ownerGuard,
    useDaemonFollowupSuggestion: () => ({
      followupState: null,
      clear: mockFollowup.clear,
      onAcceptFollowup: mockFollowup.onAcceptFollowup,
      onDismissFollowup: mockFollowup.onDismissFollowup,
    }),
    useSessionNotices: () => ({ notices: [], dismissNotice: vi.fn() }),
    usePromptStatus: () => 'idle',
    useSettings: (options?: { autoLoad?: boolean; enabled?: boolean }) => {
      testState.latestSettingsHookOptions = options;
      return {
        settings: testState.settings,
        setValue: settingsSetValue,
        reload: settingsReload,
        status:
          testState.settingsLoading || testState.settingsError
            ? undefined
            : { v: 1, settings: testState.settings },
        loading: testState.settingsLoading || testState.settingsReloading,
        error: testState.settingsError,
      };
    },
    useProviders: (options?: { autoLoad?: boolean; enabled?: boolean }) => {
      testState.latestProvidersHookOptions = options;
      return {
        providers: [],
        current: undefined,
        loading: false,
        error: undefined,
        reload: vi.fn().mockResolvedValue(undefined),
      };
    },
    useStreamingState: () => testState.streamingState,
    useTranscriptBlocks: () => testState.blocks,
    useTranscriptHistory: () => ({
      hasMore: false,
      loading: false,
      capacityReached: false,
      paginationError: false,
      loadMore: vi.fn(),
      release: vi.fn(),
    }),
    useTranscriptStore: () => mockStore,
    useWorkspace: () => mockWorkspace,
    useWorkspaceActions: () => mockWorkspaceActions,
    useMcp: () => mockMcp,
    useWorkspaceEventSignals: () => testState.workspaceEventSignals,
  };
});

vi.mock('@qwen-code/sdk/daemon', () => {
  class DaemonHttpError extends Error {
    constructor(
      readonly status: number,
      readonly body: unknown,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    DaemonHttpError,
    DAEMON_GOAL_STATUS_SENTINEL_PREFIX: 'qwen-goal-status:',
    STANDALONE_SESSIONS_CAPABILITY: 'standalone_sessions_v1',
    isDaemonTurnError: (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      (error as { _daemonTurnError?: unknown })._daemonTurnError === true,
    isStaleBranchPointError: (error: unknown): boolean =>
      error instanceof DaemonHttpError &&
      error.status === 409 &&
      typeof error.body === 'object' &&
      error.body !== null &&
      (error.body as Record<string, unknown>)['code'] ===
        'branch_point_invalid',
    isStandaloneSessionNotFoundError: (error: unknown): boolean =>
      error instanceof DaemonHttpError &&
      error.status === 404 &&
      typeof error.body === 'object' &&
      error.body !== null &&
      (error.body as Record<string, unknown>)['code'] ===
        'standalone_session_not_found',
  };
});

vi.mock('./hooks/useMessages', () => ({
  projectStreamingTailMessages: () => testState.streamingTailMessages,
  useMessages: () => testState.messages,
  useMessagesFromBlocks: () => testState.messages,
}));

vi.mock('./hooks/useAnimationFrameTranscriptBlocks', () => ({
  useAnimationFrameTranscriptSnapshot: (options?: {
    structuralOnly?: boolean;
  }) => {
    testState.snapshotCallOptions.push(options);
    return {
      blocks:
        options?.structuralOnly === true
          ? testState.blocks
          : (testState.liveBlocks ?? testState.blocks),
    };
  },
}));

vi.mock('./hooks/useBackgroundTasks', () => ({
  useBackgroundTasks: (
    _sessionId: string | undefined,
    _taskActivityKey: string,
    _connected: boolean,
    refreshTrigger = 0,
  ) => {
    testState.latestBackgroundTasksRefreshTrigger = refreshTrigger;
    return testState.backgroundTasks;
  },
}));

vi.mock('./hooks/useAnimationFrameValue', () => ({
  useAnimationFrameValue: (value: unknown) => value,
}));

vi.mock('./hooks/useQueuedPrompts', () => ({
  useQueuedPrompts: (args: {
    holdQueuedPromptsLocally?: boolean;
    streamingState: string;
    sessionHasActivePrompt?: boolean;
  }) => {
    testState.queuedPromptHoldHistory.push(
      args.holdQueuedPromptsLocally === true,
    );
    testState.queuedPromptStreamingState = args.streamingState;
    testState.queuedPromptSessionHasActivePrompt =
      args.sessionHasActivePrompt === true;
    return {
      queuedPrompts: [],
      queuedTexts,
      enqueuePrompt: rawEnqueuePrompt,
      removeQueuedPrompt: vi.fn(),
      editQueuedPrompt: vi.fn(),
      editLastQueuedPrompt,
      clearQueuedPrompts,
    };
  },
}));

vi.mock('./utils/systemInfo', () => ({
  collectSystemInfo: mockCollectSystemInfo,
}));

vi.mock('./components/ChatEditor', async () => {
  const React = await import('react');
  const { useWebShellCustomization } = await import('./customization');
  return {
    ChatEditor: React.memo(
      React.forwardRef(function ChatEditor(
        props: ChatEditorTestProps,
        ref: React.ForwardedRef<{
          clear: () => void;
          hasAttachments: () => boolean;
          hasInput: () => boolean;
          insertText: (text: string) => void;
          getText: () => string;
          setText: (text: string) => void;
          restoreImages: (
            images: readonly { data: string; media_type: string }[],
          ) => void;
          restoreFiles: (
            files: readonly {
              name: string;
              media_type: string;
              text: string;
            }[],
          ) => void;
          restoreInputAnnotations: (
            inputAnnotations: readonly DaemonInputAnnotation[],
          ) => void;
          submit: (input?: { text?: string }) => void;
          focus: () => void;
        }>,
      ) {
        testState.chatEditorRenderCount += 1;
        testState.latestChatEditorProps = props;
        const { onAttachmentsChange } = props;
        const customization = useWebShellCustomization();
        React.useEffect(() => {
          onAttachmentsChange?.(
            Boolean(
              testState.promptImages?.length ||
                testState.inputAnnotations?.length,
            ),
          );
        }, [onAttachmentsChange]);
        React.useLayoutEffect(() => {
          testState.onChatEditorLayout?.(props);
        });
        React.useImperativeHandle(ref, () => ({
          clear: () => {
            testState.prompt = '';
            testState.promptImages = undefined;
            props.onInputTextChange?.('');
            editorClear();
          },
          hasAttachments: () =>
            Boolean(
              testState.promptImages?.length ||
                testState.inputAnnotations?.length,
            ),
          hasInput: () => testState.prompt.trim().length > 0,
          insertText: editorInsertText,
          getText: () => testState.prompt,
          setText: (text) => {
            testState.prompt = text;
          },
          restoreImages: () => undefined,
          restoreFiles: () => undefined,
          restoreInputAnnotations: editorRestoreInputAnnotations,
          submit: (input) => {
            const accepted = props.onSubmit(
              input?.text ?? testState.prompt,
              testState.promptImages,
              undefined,
              editorCommit,
              testState.inputAnnotations
                ? { inputAnnotations: testState.inputAnnotations }
                : undefined,
            );
            if (accepted) editorCommit();
          },
          // The panel focus effect calls editorRef.current?.focus() when a panel
          // closes with no pending approval (e.g. resuming a session).
          focus: editorFocus,
        }));
        return React.createElement(
          'div',
          {
            'data-web-shell-composer': '',
            'data-file-upload-enabled':
              customization.fileUploadEnabled === undefined
                ? undefined
                : String(customization.fileUploadEnabled),
            'data-file-upload-directory': customization.fileUploadDirectory,
          },
          React.createElement(
            'button',
            {
              'data-testid': 'submit',
              'data-preparing': props.isPreparing ? 'true' : 'false',
              onClick: () => {
                if (testState.inputAnnotations) {
                  props.onSubmit(
                    testState.prompt,
                    undefined,
                    undefined,
                    editorCommit,
                    {
                      inputAnnotations: testState.inputAnnotations,
                    },
                  );
                  return;
                }
                props.onSubmit(
                  testState.prompt,
                  undefined,
                  undefined,
                  editorCommit,
                );
              },
              type: 'button',
            },
            'submit',
          ),
          props.newSessionSuggestion
            ? React.createElement(
                'div',
                { 'data-testid': 'new-session-suggestion' },
                React.createElement(
                  'button',
                  {
                    'data-testid': 'new-session-suggestion-start',
                    onClick: () => props.onStartNewSessionSuggestion?.(),
                    type: 'button',
                  },
                  'This looks like a new topic',
                ),
              )
            : null,
        );
      }),
    ),
  };
});

vi.mock('./components/MessageList', async () => {
  const React = await import('react');
  const { useInteractionBlocker } = await import('./interactionBlockContext');
  function InteractionBlockerProbe() {
    const registerInteractionBlocker = useInteractionBlocker();
    const releaseRef = React.useRef<(() => void) | null>(null);
    return React.createElement(
      'button',
      {
        'data-testid': 'interaction-blocker',
        onClick: () => {
          if (releaseRef.current) {
            releaseRef.current();
            releaseRef.current = null;
          } else {
            releaseRef.current = registerInteractionBlocker();
          }
        },
        type: 'button',
      },
      releaseRef.current ? 'release blocker' : 'register blocker',
    );
  }
  return {
    MessageList: React.forwardRef(function MessageList(
      props: {
        messages?: Array<{
          role?: string;
          content?: string;
          answer?: string;
          isPending?: boolean;
        }>;
        showRetryHint?: boolean;
        onRetryClick?: () => void;
        failedPromptMessageId?: string;
        onRetryFailedPrompt?: () => void;
        onBranchSession?: (branchRecordId?: string) => void | Promise<void>;
        onAttachmentPreview?: (file: {
          name: string;
          attachmentId?: string;
        }) => void;
        isResponding?: boolean;
        transcriptReloadPaused?: boolean;
        activeTurnStartedAt?: number;
        terminalBackgroundShellTaskIds?: ReadonlySet<string>;
        welcomeHeader?: React.ReactNode;
      },
      ref: React.ForwardedRef<{ scrollToBottom: () => void }>,
    ) {
      testState.latestMessageListProps = props;
      React.useImperativeHandle(ref, () => ({ scrollToBottom: vi.fn() }));
      return React.createElement(
        'div',
        { 'data-testid': 'messages' },
        props.welcomeHeader ?? null,
        React.createElement(InteractionBlockerProbe),
        props.showRetryHint
          ? React.createElement(
              'button',
              {
                'data-testid': 'retry',
                onClick: props.onRetryClick,
                type: 'button',
              },
              'retry',
            )
          : null,
        props.failedPromptMessageId
          ? React.createElement(
              'button',
              {
                'data-testid': 'failed-prompt-retry',
                onClick: props.onRetryFailedPrompt,
                type: 'button',
              },
              props.failedPromptMessageId,
            )
          : null,
      );
    }),
  };
});

// SettingsMessage / ModelDialog expose their callbacks as buttons so tests can
// walk the fast-model path: open Settings -> onSubDialog('fastModel') opens the
// model picker -> onSelect fires handleFastModelSelect.
vi.mock('./components/messages/SettingsMessage', async () => {
  const React = await import('react');
  return {
    SettingsMessage: (props: {
      settingsState: {
        settings: DaemonSettingDescriptor[];
      };
      initialCategory?: string;
      onSubDialog?: (key: string, scope: 'user' | 'workspace') => void;
      onLanguageChange?: (
        language: string,
        scope: 'user' | 'workspace',
      ) => void;
      modelManagement?: {
        busy?: boolean;
        onSelectModel?: (modelId: string) => void;
        onDeleteModel?: (target: {
          authType: string;
          modelId: string;
          baseUrl?: string;
        }) => void;
      };
    }) => {
      testState.latestSettingsState = props.settingsState;
      testState.latestSettingsInitialCategory = props.initialCategory;
      testState.latestModelManagement = props.modelManagement ?? null;
      return React.createElement(
        'div',
        { 'data-testid': 'settings-message' },
        React.createElement(
          'button',
          {
            'data-testid': 'open-fast-model',
            type: 'button',
            // The real panel forwards the active tab's scope; default is
            // workspace, which drives the `--project` flag below.
            onClick: () => props.onSubDialog?.('fastModel', 'workspace'),
          },
          'fast model',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'open-fast-model-user',
            type: 'button',
            // User tab → drives the `--global` flag.
            onClick: () => props.onSubDialog?.('fastModel', 'user'),
          },
          'fast model (user)',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'open-voice-model',
            type: 'button',
            onClick: () => props.onSubDialog?.('voiceModel', 'workspace'),
          },
          'voice model',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'open-voice-model-user',
            type: 'button',
            onClick: () => props.onSubDialog?.('voiceModel', 'user'),
          },
          'voice model (user)',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'change-language-workspace',
            type: 'button',
            // Workspace tab language change → /language ui en --project.
            onClick: () => props.onLanguageChange?.('en', 'workspace'),
          },
          'language (workspace)',
        ),
      );
    },
  };
});

// Expose the Local Control popover's settings callback as a plain button so
// tests can drive the pane-header deep link without opening a Radix popover.
vi.mock('./components/LocalControlQrButton', async () => {
  const React = await import('react');
  return {
    LocalControlQrButton: (props: { onOpenSettings: () => void }) =>
      React.createElement(
        'button',
        {
          type: 'button',
          'aria-label': 'Mobile access',
          onClick: props.onOpenSettings,
        },
        'mobile access',
      ),
  };
});

vi.mock('./components/dialogs/ModelDialog', async () => {
  const React = await import('react');
  return {
    ModelDialog: (props: { onSelect?: (id: string) => void }) =>
      React.createElement(
        'button',
        {
          'data-testid': 'model-select',
          type: 'button',
          onClick: () => props.onSelect?.('fast-model-x'),
        },
        'select model',
      ),
  };
});

// The /diff intercept opens this dialog; render it through the (mocked)
// DialogShell so tests can detect it via [data-testid="dialog-shell"] without
// exercising the dialog's diff-fetching hooks.
vi.mock('./components/dialogs/GitDiffDialog', async () => {
  const React = await import('react');
  const { DialogShell } = await import('./components/dialogs/DialogShell');
  return {
    GitDiffDialog: () =>
      React.createElement(DialogShell, null, 'changes dialog'),
    GitDiffContent: () => React.createElement('div', null, 'changes dialog'),
  };
});

// Render DialogShell as an observable container so tests can detect an open
// sub-dialog (model picker, approval-mode picker) via [data-testid="dialog-shell"].
vi.mock('./components/dialogs/DialogShell', async () => {
  const React = await import('react');
  return {
    DialogShell: (props: {
      children?: React.ReactNode;
      title?: React.ReactNode;
    }) =>
      React.createElement(
        'div',
        {
          'data-testid': 'dialog-shell',
          ...(typeof props.title === 'string'
            ? { 'data-dialog-title': props.title }
            : {}),
        },
        props.children,
      ),
  };
});

vi.mock('./components/sidebar/WebShellSidebar', async () => {
  const React = await import('react');
  return {
    WebShellSidebar: (props: {
      collapsed?: boolean;
      onOpenPlugins?: () => void;
      onOpenChannels?: () => void;
      onOpenDaemonStatus?: () => void;
      onOpenSessions?: () => void;
      onOpenSplitView?: () => void;
      onMobileClose?: () => void;
      onNewSession?: (workspaceCwd?: string) => Promise<boolean> | boolean;
      onNewWorktreeSession?: (
        workspaceCwd?: string,
      ) => Promise<boolean> | boolean | void;
      onSelectWorkspace?: (workspaceCwd: string | undefined) => void;
      onLoadSession?: (sessionId: string) => Promise<void> | void;
      onLoadStandaloneSession?: (sessionId: string) => Promise<void> | void;
      onSelectCurrentSession?: () => void;
      onSessionsDeleted?: (sessionIds: string[]) => void;
      onOpenAddWorkspace?: () => void;
      onThemeChange?: (theme: 'light' | 'dark') => void;
      showSessionSourceSwitch?: boolean;
    }) => {
      // Expose the Daemon Status / Session Overview openers so tests can
      // exercise those activePanel branches (neither has a slash command).
      return React.createElement(
        'div',
        {
          'data-testid': 'sidebar',
          'data-collapsed': String(Boolean(props.collapsed)),
          'data-show-session-source-switch': String(
            props.showSessionSourceSwitch,
          ),
        },
        React.createElement(
          'button',
          {
            'data-testid': 'change-sidebar-theme',
            type: 'button',
            onClick: () => props.onThemeChange?.('dark'),
          },
          'change theme',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'open-add-workspace',
            type: 'button',
            onClick: props.onOpenAddWorkspace,
          },
          'add workspace',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'new-session',
            type: 'button',
            onClick: props.onNewSession,
          },
          'new session',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'new-session-primary-workspace',
            type: 'button',
            onClick: () => void props.onNewSession?.('/workspace'),
          },
          'new session in primary workspace',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'new-worktree-session',
            type: 'button',
            onClick: () => void props.onNewWorktreeSession?.(),
          },
          'new worktree session',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'new-worktree-session-other',
            type: 'button',
            onClick: () => void props.onNewWorktreeSession?.('/other'),
          },
          'new worktree session in other',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'select-other-workspace',
            type: 'button',
            onClick: () => props.onSelectWorkspace?.('/other'),
          },
          'select other workspace',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'load-session',
            type: 'button',
            onClick: () => props.onLoadSession?.('session-2'),
          },
          'load session',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'load-standalone-session',
            type: 'button',
            onClick: () => {
              void Promise.resolve(
                props.onLoadStandaloneSession?.('standalone-session-2'),
              ).catch(() => undefined);
            },
          },
          'load standalone session',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'select-current-session',
            type: 'button',
            onClick: props.onSelectCurrentSession,
          },
          'select current session',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'delete-session',
            type: 'button',
            onClick: () => props.onSessionsDeleted?.(['session-1']),
          },
          'delete session',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'open-plugins',
            type: 'button',
            onClick: props.onOpenPlugins,
          },
          'plugins',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'open-channels',
            type: 'button',
            onClick: props.onOpenChannels,
          },
          'channels',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'open-daemon-status',
            type: 'button',
            onClick: props.onOpenDaemonStatus,
          },
          'daemon status',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'open-sessions-overview',
            type: 'button',
            onClick: props.onOpenSessions,
          },
          'sessions overview',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'open-split-view',
            type: 'button',
            onClick: props.onOpenSplitView,
          },
          'split view',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'close-mobile-sidebar',
            type: 'button',
            onClick: props.onMobileClose,
          },
          'close mobile sidebar',
        ),
      );
    },
  };
});

vi.mock('./session-catalog/session-catalog-store', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('./session-catalog/session-catalog-store')
    >();
  type TestListClient = {
    listWorkspaceSessions?: (
      workspaceCwd: string,
      options?: Record<string, unknown>,
    ) => Promise<DaemonSessionSummary[]>;
    listWorkspaceSessionsPage?: (
      workspaceCwd: string,
      options?: Record<string, unknown>,
    ) => Promise<{ sessions: DaemonSessionSummary[] }>;
    workspaceByCwd: (workspaceCwd: string) => {
      listWorkspaceSessions?: (
        options?: Record<string, unknown>,
      ) => Promise<DaemonSessionSummary[]>;
      listWorkspaceSessionsPage?: (
        options?: Record<string, unknown>,
      ) => Promise<{ sessions: DaemonSessionSummary[] }>;
    };
  };
  return {
    ...actual,
    loadSessionCatalogOnce: async (
      client: TestListClient,
      query: {
        routeKind: 'legacy' | 'qualified';
        workspaceCwd: string;
        options?: Record<string, unknown>;
      },
    ) => {
      if (query.routeKind === 'qualified') {
        const scoped = client.workspaceByCwd(query.workspaceCwd);
        if (scoped.listWorkspaceSessionsPage) {
          return scoped.listWorkspaceSessionsPage(query.options);
        }
        return {
          sessions: scoped.listWorkspaceSessions
            ? await scoped.listWorkspaceSessions(query.options)
            : [],
        };
      }
      if (client.listWorkspaceSessionsPage) {
        return client.listWorkspaceSessionsPage(
          query.workspaceCwd,
          query.options,
        );
      }
      return {
        sessions: client.listWorkspaceSessions
          ? await client.listWorkspaceSessions(
              query.workspaceCwd,
              query.options,
            )
          : [],
      };
    },
  };
});

vi.mock('./session-catalog/session-catalog-hooks', () => ({
  useSessionCatalogController: () => sessionCatalogController,
  useSessionHasActivePrompt: () => testState.sessionHasActivePrompt,
}));

vi.mock('./components/dialogs/AddWorkspaceDialog', async () => {
  const React = await import('react');
  return {
    AddWorkspaceDialog: (props: AddWorkspaceDialogTestProps) => {
      testState.latestAddWorkspaceDialogProps = props;
      return React.createElement('div', {
        'data-testid': 'add-workspace-dialog',
      });
    },
  };
});

function mockComponent(path: string, exportName: string): void {
  vi.doMock(path, async () => {
    const React = await import('react');
    return {
      [exportName]: () => React.createElement('div'),
    };
  });
}

vi.doMock('./components/StatusBar', async () => {
  const React = await import('react');
  return {
    StatusBar: (props: {
      tasks?: DaemonSessionMonitorTaskStatus[];
      onOpenTasks?: () => void;
      hideSettings?: boolean;
    }) => {
      testState.latestStatusBarTasks = props.tasks ?? [];
      testState.latestStatusBarOnOpenTasks = props.onOpenTasks ?? null;
      testState.latestStatusBarHideSettings = props.hideSettings ?? false;
      return React.createElement('div');
    },
  };
});
vi.doMock('./components/StreamingStatus', async () => {
  const React = await import('react');
  return {
    StreamingStatus: ({
      startedAt,
      hasActivePrompt,
    }: {
      startedAt?: number;
      hasActivePrompt?: boolean;
    }) =>
      React.createElement('div', {
        'data-testid': 'streaming-status',
        'data-started-at': startedAt,
        'data-has-active-prompt': String(hasActivePrompt === true),
      }),
  };
});
vi.doMock('./components/ToastHost', async () => {
  const React = await import('react');
  const actual = await vi.importActual<Record<string, unknown>>(
    './components/ToastHost',
  );
  return {
    ...actual,
    ToastHost: (props: { elevated?: boolean }) => {
      testState.latestToastHostElevated = props.elevated ?? false;
      return React.createElement('div');
    },
  };
});
vi.doMock('./components/panels/TodoPanel', async () => {
  const React = await import('react');
  return {
    TodoPanel: (props: {
      todos: Array<{ id: string; blockedBy?: string[] }>;
      onOpen?: () => void;
    }) => {
      testState.latestTodoPanelTodos = props.todos;
      testState.latestTodoPanelOnOpen = props.onOpen ?? null;
      return React.createElement('div');
    },
  };
});
mockComponent('./components/WelcomeHeader', 'WelcomeHeader');
mockComponent('./components/dialogs/ApprovalModeDialog', 'ApprovalModeDialog');
mockComponent('./components/dialogs/ResumeDialog', 'ResumeDialog');
mockComponent('./components/dialogs/ToolsDialog', 'ToolsDialog');
mockComponent('./components/tools/ToolsManagerPage', 'ToolsManagerPage');
mockComponent('./components/skills/SkillsManagerPage', 'SkillsManagerPage');
mockComponent('./components/dialogs/DaemonStatusDialog', 'DaemonStatusDialog');
vi.doMock('./components/SessionOverviewPanel', async () => {
  const React = await import('react');
  return {
    SessionOverviewPanel: (props: {
      onOpenSession?: (sessionId: string, workspaceCwd?: string) => void;
      onOpenSplit?: (sessionIds: string[]) => void;
      onCurrentSessionRemoved?: (session: {
        sessionId: string;
        workspaceCwd: string;
      }) => Promise<boolean | void> | boolean | void;
      manageLiveState?: boolean;
    }) => {
      testState.latestSessionOverviewProps = props;
      return React.createElement('div', {
        'data-testid': 'session-overview-panel',
      });
    },
  };
});
vi.doMock('./components/channels/ChannelsManagerPage', async () => {
  const React = await import('react');
  return {
    ChannelsManagerPage: () =>
      React.createElement('div', { 'data-testid': 'channels-manager-page' }),
  };
});
vi.doMock('./components/SplitView', async () => {
  const React = await import('react');
  return {
    SplitView: (props: {
      onExit?: () => void;
      sessionIds?: string[];
      onPanesChange?: (ids: string[]) => void;
      includeOtherWorkspaces?: boolean;
      workspaceCwd?: string;
      sessionWorkflowEnabled?: boolean;
      onPaneArtifactsChange?: (
        sessionId: string,
        artifacts: unknown[],
        workspaceActions: unknown,
      ) => void;
      onRightPanelOpen?: (request: unknown) => void;
      onOpenMonitor?: (
        task: DaemonSessionMonitorTaskStatus,
        sessionId: string,
        sessionActions: typeof mockSessionActions,
      ) => void;
      renderPaneHeaderActions?: (info: {
        sessionId: string;
        workspaceCwd?: string;
        sessionActions?: typeof mockSessionActions;
      }) => unknown;
      voiceWorkspaces?: readonly unknown[];
    }) => {
      testState.latestSplitViewProps = props;
      const artifact = {
        id: 'pane-artifact',
        kind: 'report',
        storage: 'memory',
        source: 'tool',
        status: 'available',
        title: 'Pane artifact',
        updatedAt: '2026-07-10T00:00:00Z',
        sizeBytes: 10,
      };
      const updatedArtifact = {
        ...artifact,
        title: 'Updated pane artifact',
        updatedAt: '2026-07-10T00:01:00Z',
        sizeBytes: 20,
      };
      const changedArtifact = {
        ...updatedArtifact,
        status: 'changed',
      };
      const mainArtifact = {
        id: 'main-artifact',
        kind: 'report',
        storage: 'memory',
        source: 'tool',
        status: 'available',
        title: 'Main artifact',
        updatedAt: '2026-07-10T00:00:00Z',
        sizeBytes: 10,
      };
      const paneScheduledTask = {
        id: 'pane-cron',
        toolCallId: 'pane-cron-call',
        title: 'Pane task',
        cron: '0 9 * * *',
        prompt: 'pane task prompt',
        recurring: true,
        durable: true,
        workspaceId: 'pane-ws',
      };
      const paneReviewChanges = [
        {
          path: 'notes.md',
          status: 'modified',
          toolCallId: 'tool-notes',
          isArtifact: false,
          diffs: [],
        },
      ];
      return React.createElement(
        'div',
        { 'data-testid': 'split-view-mock' },
        // Surface the seed so a test can assert the App preserved / restored it.
        React.createElement(
          'span',
          { 'data-testid': 'split-initial' },
          (props.sessionIds ?? []).join(','),
        ),
        React.createElement(
          'span',
          { 'data-testid': 'split-voice-workspaces' },
          props.voiceWorkspaces === undefined
            ? 'legacy'
            : String(props.voiceWorkspaces.length),
        ),
        // Simulate the real SplitView reporting its live pane set up to the App.
        React.createElement(
          'button',
          {
            'data-testid': 'split-report-panes',
            type: 'button',
            onClick: () => props.onPanesChange?.(['s1', 's2', 's3']),
          },
          'report',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'split-remove-panes',
            type: 'button',
            onClick: () => props.onPanesChange?.([]),
          },
          'remove panes',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'split-report-artifact',
            type: 'button',
            onClick: () =>
              props.onPaneArtifactsChange?.('pane-session', [artifact]),
          },
          'artifact',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'split-report-updated-artifact',
            type: 'button',
            onClick: () =>
              props.onPaneArtifactsChange?.('pane-session', [updatedArtifact]),
          },
          'updated artifact',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'split-report-changed-artifact',
            type: 'button',
            onClick: () =>
              props.onPaneArtifactsChange?.('pane-session', [changedArtifact]),
          },
          'changed artifact',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'split-clear-artifacts',
            type: 'button',
            onClick: () => props.onPaneArtifactsChange?.('pane-session', []),
          },
          'clear artifacts',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'split-open-artifact',
            type: 'button',
            onClick: () =>
              props.onRightPanelOpen?.({
                id: 'artifact:pane-artifact:pane-session',
                kind: 'artifact',
                title: artifact.title,
                turnId: 'turn-1',
                artifactId: artifact.id,
                artifact,
                workspaceCwd: '/tmp/project',
                workspaceId: 'primary',
                sourceSessionId: 'pane-session',
                previewContent: '<p>stale</p>',
              }),
          },
          'open artifact',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'split-open-main-artifact',
            type: 'button',
            onClick: () =>
              props.onRightPanelOpen?.({
                id: 'artifact:main-artifact',
                kind: 'artifact',
                title: mainArtifact.title,
                turnId: 'turn-1',
                artifactId: mainArtifact.id,
                artifact: mainArtifact,
                workspaceCwd: '/tmp/project',
                workspaceId: 'primary',
              }),
          },
          'open main artifact',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'split-open-attachment-one',
            type: 'button',
            onClick: () =>
              props.onRightPanelOpen?.({
                id: 'attachment:shared.txt',
                kind: 'attachment',
                title: 'shared.txt',
                turnId: 'turn-1',
                data: new Blob(['one']),
                sourceSessionId: 'pane-session-1',
              }),
          },
          'open attachment one',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'split-open-attachment-two',
            type: 'button',
            onClick: () =>
              props.onRightPanelOpen?.({
                id: 'attachment:shared.txt',
                kind: 'attachment',
                title: 'shared.txt',
                turnId: 'turn-2',
                data: new Blob(['two']),
                sourceSessionId: 'pane-session-2',
              }),
          },
          'open attachment two',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'split-open-scheduled-task',
            type: 'button',
            onClick: () =>
              props.onRightPanelOpen?.({
                id: 'scheduled-task:pane-cron-call',
                kind: 'scheduled_task',
                title: 'Scheduled Tasks',
                turnId: 'turn-1',
                task: paneScheduledTask,
                workspaceCwd: '/tmp/pane',
                workspaceId: 'pane-ws',
                sourceSessionId: 'pane-session',
              }),
          },
          'open scheduled task',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'split-open-review',
            type: 'button',
            onClick: () =>
              props.onRightPanelOpen?.({
                id: 'review',
                kind: 'review',
                title: 'Review',
                turnId: 'turn-1',
                changes: paneReviewChanges,
                workspaceCwd: '/tmp/pane',
                workspaceId: 'pane-ws',
                sourceSessionId: 'pane-session',
              }),
          },
          'open review',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'split-open-monitor',
            type: 'button',
            onClick: () =>
              props.onOpenMonitor?.(
                {
                  kind: 'monitor',
                  id: 'monitor-1',
                  label: 'monitor-label',
                  description: 'watch pane logs',
                  status: 'running',
                  startTime: 1,
                  runtimeMs: 10,
                  command: 'tail -f pane.log',
                  eventCount: 1,
                  droppedLines: 0,
                  toolUseId: 'monitor-call',
                },
                'pane-session',
                mockSessionActions,
              ),
          },
          'open monitor',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'split-back',
            type: 'button',
            onClick: props.onExit,
          },
          'back',
        ),
        React.createElement(
          'span',
          { 'data-testid': 'split-has-header-actions' },
          props.renderPaneHeaderActions ? 'yes' : 'no',
        ),
        // Surface the pane header actions so tests can drive them like a real
        // pane header would (the default action opens the token usage panel).
        props.renderPaneHeaderActions
          ? React.createElement(
              'div',
              { 'data-testid': 'split-header-actions' },
              props.renderPaneHeaderActions({
                sessionId: 's1',
                workspaceCwd: '/tmp/project',
                sessionActions: mockSessionActions,
              }),
            )
          : null,
      );
    },
  };
});
// Capturing mock: stores the onRunPrompt handler (App's real runTaskManually)
// so tests can drive the manual-run orchestration directly, then renders a bare
// node like the other dialog mocks.
vi.doMock('./components/dialogs/ScheduledTasksDialog', async () => {
  const React = await import('react');
  return {
    ScheduledTasksDialog: (props: {
      onRunPrompt?: (prompt: string, sessionId: string | null) => Promise<void>;
      workspaces?: Array<{ id: string; cwd: string }>;
      lockedWorkspace?: { id: string; cwd: string; primary: boolean };
      currentSession?: {
        sessionId?: string;
        pendingInteractionCount?: number;
      };
      currentSessionSchedulingAvailable?: boolean;
    }) => {
      testState.latestScheduledTasksProps = props;
      return React.createElement('div');
    },
  };
});
// Capturing mock: stores App's real onCreateGoal / onOpenSession handlers so
// tests can drive the goal-creation orchestration without a daemon.
vi.doMock('./components/dialogs/GoalsDialog', async () => {
  const React = await import('react');
  return {
    GoalsDialog: (props: {
      onCreateGoal?: (condition: string) => Promise<void>;
      onOpenSession?: (sessionId: string) => void;
    }) => {
      testState.latestGoalsProps = props;
      return React.createElement('div');
    },
  };
});
vi.doMock('./components/extensions/ExtensionsManagerPage', async () => {
  const React = await import('react');
  return {
    ExtensionsManagerPage: (props: {
      onClose: () => void;
      initialFocusRef?: React.Ref<HTMLHeadingElement>;
      embedded?: unknown;
    }) =>
      React.createElement(
        'div',
        { 'data-testid': 'extensions-manager-page' },
        React.createElement(
          'h1',
          {
            ref: props.initialFocusRef,
            tabIndex: -1,
            'data-testid': 'extensions-manager-heading',
          },
          'Manage extensions',
        ),
        React.createElement('button', {
          'data-testid': 'extensions-manager-back',
          onClick: props.onClose,
        }),
      ),
  };
});
mockComponent('./components/dialogs/ThemeDialog', 'ThemeDialog');
mockComponent(
  './components/dialogs/DeleteSessionDialog',
  'DeleteSessionDialog',
);
mockComponent(
  './components/dialogs/ReleaseSessionDialog',
  'ReleaseSessionDialog',
);
mockComponent('./components/dialogs/RewindDialog', 'RewindDialog');
mockComponent('./components/agents/AgentsManagerPage', 'AgentsManagerPage');
mockComponent('./components/messages/MemoryMessage', 'MemoryMessage');
mockComponent('./components/messages/AuthMessage', 'AuthMessage');
// Record keyboardActive so app-level tests can assert the overlay is told to
// grab focus when it becomes topmost (the actual focus lives in the real
// components, covered by their own unit tests).
vi.doMock('./components/messages/ToolApproval', async () => {
  const React = await import('react');
  return {
    ToolApproval: (props: {
      keyboardActive?: boolean;
      planTodos?: Array<{ id: string }>;
      onConfirm?: (id: string, selectedOption: string) => void | Promise<void>;
    }) => {
      testState.latestToolApprovalKeyboardActive = props.keyboardActive ?? null;
      testState.toolApprovalKeyboardActiveHistory.push(
        props.keyboardActive ?? null,
      );
      testState.latestToolApprovalPlanTodos = props.planTodos ?? [];
      // Captured so app-level tests can drive the overlay's confirm path and
      // observe the promise contract the real component re-arms on.
      testState.latestToolApprovalOnConfirm = props.onConfirm ?? null;
      return React.createElement('div', {
        'data-web-shell-permission-panel': '',
      });
    },
  };
});
vi.doMock('./components/messages/AskUserQuestion', async () => {
  const React = await import('react');
  return {
    AskUserQuestion: (props: {
      keyboardActive?: boolean;
      onError: (error: unknown, fallback: string) => void;
    }) => {
      testState.latestAskUserQuestionKeyboardActive =
        props.keyboardActive ?? null;
      testState.askUserKeyboardActiveHistory.push(props.keyboardActive ?? null);
      testState.latestAskUserQuestionOnError = props.onError;
      return React.createElement('div', { 'data-web-shell-ask-panel': '' });
    },
  };
});
vi.doMock('./components/messages/TasksStatusMessage', async () => {
  const React = await import('react');
  return {
    TasksStatusMessage: (props: {
      planTodos?: Array<{ id: string }>;
      agentTools?: Array<{ callId: string }>;
      onOpenMonitor?: (task: DaemonSessionMonitorTaskStatus) => void;
    }) => {
      testState.latestTasksStatusProps = props;
      return React.createElement('div');
    },
    MonitorTaskDetail: () => React.createElement('div'),
    ShellTaskDetail: (props: { task: DaemonSessionShellTaskStatus }) =>
      React.createElement(
        'div',
        null,
        `${props.task.command} ${props.task.cwd}`,
      ),
  };
});
vi.doMock('./monitorDetailsContext', async () => {
  const React = await import('react');
  return {
    MonitorDetailsProvider: (props: {
      onOpen: (tool: {
        callId: string;
        toolName: string;
        status: 'completed';
      }) => Promise<boolean>;
      children: React.ReactNode;
    }) => {
      testState.latestMonitorDetailsOnOpen = props.onOpen;
      return React.createElement(React.Fragment, null, props.children);
    },
  };
});
vi.doMock('./components/messages/BtwMessage', async () => {
  const React = await import('react');
  return {
    BtwMessage: (props: {
      question: string;
      answer: string;
      isPending: boolean;
    }) => {
      testState.latestBtwMessageProps = props;
      return React.createElement('div');
    },
  };
});
vi.doMock('./components/terminal/TerminalPanel', async () => {
  const React = await import('react');
  return {
    releaseWebTerminal: mockReleaseWebTerminal,
    TerminalPanel: (props: { terminalId: string }) =>
      React.createElement('div', {
        'data-testid': 'terminal-panel',
        'data-web-terminal': '',
        'data-terminal-id': props.terminalId,
      }),
  };
});
mockComponent('./components/QueuedPromptDisplay', 'QueuedPromptDisplay');

const {
  App,
  getTaskActivityKey,
  getEnvironmentAgentTasks,
  mergeMonitorTaskSnapshot,
  mergeSideTaskCatalog,
} = await import('./App');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

describe('mergeSideTaskCatalog', () => {
  const listed = (sessionId: string) => ({ sessionId, title: sessionId });

  it('replaces the catalog when the parent session changes', () => {
    const next = mergeSideTaskCatalog(
      { parentSessionId: 'parent-a', items: [listed('stale')], loaded: true },
      'parent-b',
      [listed('b1')],
      new Set(['stale']),
    );
    expect(next).toEqual({
      parentSessionId: 'parent-b',
      items: [listed('b1')],
      loaded: true,
    });
  });

  it('treats a successful listing as authoritative for confirmed items', () => {
    const next = mergeSideTaskCatalog(
      {
        parentSessionId: 'parent-a',
        items: [listed('kept'), listed('deleted-elsewhere')],
        loaded: true,
      },
      'parent-a',
      [listed('kept')],
      new Set(),
    );
    expect(next.items.map((item) => item.sessionId)).toEqual(['kept']);
  });

  it('keeps a locally created draft the listing has not echoed yet', () => {
    const next = mergeSideTaskCatalog(
      {
        parentSessionId: 'parent-a',
        items: [listed('kept'), listed('draft')],
        loaded: true,
      },
      'parent-a',
      [listed('kept')],
      new Set(['draft']),
    );
    expect(next.items.map((item) => item.sessionId)).toEqual(['kept', 'draft']);
  });

  it('does not duplicate a draft once the listing confirms it', () => {
    const next = mergeSideTaskCatalog(
      { parentSessionId: 'parent-a', items: [listed('draft')], loaded: true },
      'parent-a',
      [listed('draft')],
      new Set(['draft']),
    );
    expect(next.items.map((item) => item.sessionId)).toEqual(['draft']);
  });
});

describe('task activity key', () => {
  it('includes background shells in any tool-call state', () => {
    const messages = [
      {
        id: 'tools',
        role: 'tool_group',
        tools: [
          {
            callId: 'shell-call',
            toolName: 'shell',
            status: 'in_progress',
            args: { is_background: true },
          },
          {
            callId: 'agent-call',
            toolName: 'agent',
            status: 'pending',
            args: {},
            subTools: [
              {
                callId: 'nested-shell',
                toolName: 'run_shell_command',
                status: 'completed',
                args: { is_background: true },
              },
            ],
          },
          {
            callId: 'foreground-agent',
            toolName: 'agent',
            status: 'in_progress',
            args: { run_in_background: false },
          },
          {
            callId: 'completed-shell',
            toolName: 'shell',
            status: 'completed',
            args: { is_background: true },
          },
          {
            callId: 'promoted-shell',
            toolName: 'run_shell_command',
            status: 'completed',
            args: { is_background: false },
            rawOutput: 'Promoted to background: bg_1234abcd',
          },
          {
            callId: 'monitor-call',
            toolName: 'monitor',
            status: 'completed',
            args: { command: 'npm run dev --watch' },
          },
        ],
      },
    ] satisfies Message[];

    expect(getTaskActivityKey(messages)).toBe(
      'shell-call:in_progress|agent-call:pending|nested-shell:completed|completed-shell:completed|promoted-shell:completed|monitor-call:completed',
    );
  });

  it('does not regress a terminal monitor to a stale running snapshot', () => {
    const running: DaemonSessionMonitorTaskStatus = {
      kind: 'monitor',
      id: 'monitor-1',
      label: 'monitor-label',
      description: 'watch server log',
      status: 'running',
      startTime: 1_000,
      runtimeMs: 5_000,
      command: 'tail -f server.log',
      eventCount: 3,
      lastEventTime: 5_000,
      droppedLines: 0,
    };
    const cancelled: DaemonSessionMonitorTaskStatus = {
      ...running,
      status: 'cancelled',
      endTime: 6_000,
    };

    expect(mergeMonitorTaskSnapshot(cancelled, running)).toBe(cancelled);
    expect(mergeMonitorTaskSnapshot(running, cancelled)).toBe(cancelled);
  });

  it('keeps the legacy inline behavior when monitor correlation is unsupported', async () => {
    renderApp();
    await flush();

    expect(testState.latestMonitorDetailsOnOpen).toBeNull();
    expect(mockSessionActions.getTasks).not.toHaveBeenCalled();
  });

  it('opens environment information for /tasks without a dialog', async () => {
    const { container } = renderApp();
    await flush();
    expect(testState.latestBackgroundTasksRefreshTrigger).toBe(0);

    testState.prompt = '/tasks';
    await clickSubmit(container);
    await flush();

    expect(
      container.querySelector(
        '[data-testid="environment-panel"]:not([hidden])',
      ),
    ).not.toBeNull();
    expect(testState.latestTasksStatusProps).toBeNull();
    expect(mockSessionActions.getTasks).not.toHaveBeenCalled();
    expect(testState.latestBackgroundTasksRefreshTrigger).toBe(1);
  });

  it('opens a monitor tool from the transcript in the right panel', async () => {
    const task: DaemonSessionMonitorTaskStatus = {
      kind: 'monitor',
      id: 'monitor-1',
      label: 'monitor-label',
      description: 'watch server log',
      status: 'running',
      startTime: 1_000,
      runtimeMs: 5_000,
      command: 'tail -f server.log',
      eventCount: 3,
      lastEventTime: 5_000,
      droppedLines: 0,
      toolUseId: 'monitor-call',
    };
    mockSessionActions.getTasks.mockResolvedValue({
      v: 1,
      sessionId: 'session-1',
      now: 6_000,
      tasks: [task],
    });
    mockConnection.capabilities.features = ['session_monitor_tool_correlation'];
    const { container } = renderApp();
    await flush();
    expect(testState.latestMonitorDetailsOnOpen).toBeTypeOf('function');

    let opened = false;
    await act(async () => {
      opened =
        (await testState.latestMonitorDetailsOnOpen?.({
          callId: 'monitor-call',
          toolName: 'monitor',
          status: 'completed',
        })) ?? false;
    });
    await flush();

    expect(opened).toBe(true);
    expect(mockSessionActions.getTasks).toHaveBeenCalled();
    expect(
      container.querySelector('button[title="watch server log"]'),
    ).not.toBeNull();
    expect(testState.latestBackgroundTasksRefreshTrigger).toBe(1);

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle environment information"]',
        )
        ?.click();
    });

    expect(
      container.querySelector(
        '[data-testid="environment-panel"]:not([hidden])',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector('button[title="watch server log"]'),
    ).not.toBeNull();
  });

  it('expands the right panel to fullscreen and shrinks it back from the toolbar or Escape', async () => {
    const task: DaemonSessionMonitorTaskStatus = {
      kind: 'monitor',
      id: 'monitor-1',
      label: 'monitor-label',
      description: 'watch server log',
      status: 'running',
      startTime: 1_000,
      runtimeMs: 5_000,
      command: 'tail -f server.log',
      eventCount: 3,
      lastEventTime: 5_000,
      droppedLines: 0,
      toolUseId: 'monitor-call',
    };
    mockSessionActions.getTasks.mockResolvedValue({
      v: 1,
      sessionId: 'session-1',
      now: 6_000,
      tasks: [task],
    });
    mockConnection.capabilities.features = ['session_monitor_tool_correlation'];
    const { container } = renderApp();
    await flush();
    expect(testState.latestMonitorDetailsOnOpen).toBeTypeOf('function');

    await act(async () => {
      await testState.latestMonitorDetailsOnOpen?.({
        callId: 'monitor-call',
        toolName: 'monitor',
        status: 'completed',
      });
      await Promise.resolve();
    });
    await flush();

    expect(
      container.querySelector('button[title="watch server log"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).toBeNull();

    const dockedAside = container.querySelector(
      'aside[aria-label="Right panel"]',
    );
    expect(dockedAside).not.toBeNull();
    const enterFullscreen = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Fullscreen"]',
    );
    expect(enterFullscreen).not.toBeNull();
    await act(async () => {
      enterFullscreen?.click();
      await Promise.resolve();
    });

    const fullscreenOverlay = document.querySelector(
      '[class*="artifactPanelFullscreen"]',
    );
    expect(fullscreenOverlay).not.toBeNull();
    const fullscreenAside = fullscreenOverlay?.querySelector('aside');
    // The docked instance must stay mounted across the mode change — a
    // remount would silently discard panel-local state (drafts, scroll).
    expect(fullscreenAside).toBe(dockedAside);
    expect(fullscreenAside?.className).toContain('panelFullscreen');
    // The fullscreen surface renders through the top-level portal root so a
    // transformed/stacking-context host ancestor cannot trap the fixed panel.
    expect(
      fullscreenOverlay?.closest('[data-web-shell-portal-root]'),
    ).not.toBeNull();
    // Modal role/name parity with the floating variant, where vaul's Radix
    // dialog supplies them.
    expect(fullscreenOverlay?.getAttribute('role')).toBe('dialog');
    expect(fullscreenOverlay?.getAttribute('aria-label')).toBe('Right panel');
    // Chat-only interaction is gated while the surface covers the chat.
    expect(testState.latestChatEditorProps?.disabled).toBe(true);
    // Panel toasts elevate alongside the surface.
    expect(testState.latestToastHostElevated).toBe(true);
    // The covered shells must drop out of layout, tab order, and AT while the
    // opaque surface is up — keyboard/AT reaching them behind the overlay is
    // exactly what the hiding prevents.
    const messages = container.querySelector('[data-testid="messages"]');
    expect(messages).not.toBeNull();
    expect(messages?.closest('[aria-hidden="true"]')).not.toBeNull();
    const sidebarShell = container.querySelector('[data-sidebar-shell]');
    expect(sidebarShell).not.toBeNull();
    expect(sidebarShell?.getAttribute('aria-hidden')).toBe('true');
    expect(sidebarShell?.className).toContain('chatViewHidden');
    const contextShell = container.querySelector('[class*="contextShell"]');
    expect(contextShell).not.toBeNull();
    expect(contextShell?.getAttribute('aria-hidden')).toBe('true');
    expect(contextShell?.className).toContain('chatViewHidden');
    const exitFullscreenButton =
      fullscreenAside?.querySelector<HTMLButtonElement>(
        'button[aria-label="Exit fullscreen"]',
      );
    expect(exitFullscreenButton).not.toBeNull();
    expect(container.querySelector('[role="separator"]')).toBeNull();

    await act(async () => {
      exitFullscreenButton?.click();
      await Promise.resolve();
    });
    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).toBeNull();
    expect(container.querySelector('[role="separator"]')).not.toBeNull();
    // The same instance must survive the shrink too — the resize handle
    // remounting beside it must not displace the panel's tree position.
    expect(container.querySelector('aside[aria-label="Right panel"]')).toBe(
      dockedAside,
    );
    // The surface moved back into the app tree's layout slot, and the chat
    // interaction gate and toast elevation reset with it.
    expect(container.contains(dockedAside)).toBe(true);
    // The docked (non-modal) panel drops the dialog role again.
    expect(
      dockedAside
        ?.closest('[class*="artifactPanelDock"]')
        ?.getAttribute('role'),
    ).toBeNull();
    expect(testState.latestChatEditorProps?.disabled).toBe(false);
    expect(testState.latestToastHostElevated).toBe(false);
    // The dock node just swapped back from fullscreen: suppress its open
    // animation so the already-open panel doesn't re-play the slide-in.
    expect(
      container.querySelector('[class*="artifactPanelDockNoOpenAnimation"]'),
    ).not.toBeNull();

    await act(async () => {
      enterFullscreen?.click();
      await Promise.resolve();
    });
    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).not.toBeNull();

    await act(async () => {
      document
        .querySelector('[class*="artifactPanelFullscreen"]')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        );
      await Promise.resolve();
    });

    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).toBeNull();
    expect(container.querySelector('[role="separator"]')).not.toBeNull();
    expect(
      container.querySelector('button[title="watch server log"]'),
    ).not.toBeNull();
    // Exiting fullscreen restores the covered shells to layout and AT.
    expect(messages?.closest('[aria-hidden="true"]')).toBeNull();
    expect(sidebarShell?.getAttribute('aria-hidden')).toBeNull();
    expect(sidebarShell?.className).not.toContain('chatViewHidden');
    expect(contextShell?.getAttribute('aria-hidden')).toBeNull();
    expect(contextShell?.className).not.toContain('chatViewHidden');
  });

  it('merges a reopened monitor into its existing tab', async () => {
    const stopped: DaemonSessionMonitorTaskStatus = {
      kind: 'monitor',
      id: 'monitor-1',
      label: 'monitor-label',
      description: 'stopped watch',
      status: 'cancelled',
      startTime: 1_000,
      runtimeMs: 5_000,
      endTime: 6_000,
      command: 'tail -f server.log',
      eventCount: 3,
      lastEventTime: 5_000,
      droppedLines: 0,
    };
    mockConnection.capabilities.features = ['session_monitor_tool_correlation'];
    mockSessionActions.getTasks.mockResolvedValueOnce({
      v: 1,
      sessionId: 'session-1',
      now: 6_000,
      tasks: [{ ...stopped, toolUseId: 'monitor-call' }],
    });
    const { container } = renderApp();
    await flush();

    await act(async () => {
      await testState.latestMonitorDetailsOnOpen?.({
        callId: 'monitor-call',
        toolName: 'monitor',
        status: 'completed',
      });
    });
    await flush();

    let tabs =
      container.querySelectorAll<HTMLButtonElement>('button[role="tab"]');
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.getAttribute('title')).toBe('stopped watch');

    const running: DaemonSessionMonitorTaskStatus = {
      kind: 'monitor',
      id: 'monitor-1',
      label: 'monitor-label',
      description: 'running watch',
      status: 'running',
      startTime: 1_000,
      runtimeMs: 5_000,
      command: 'tail -f server.log',
      eventCount: 3,
      lastEventTime: 5_000,
      droppedLines: 0,
    };
    mockSessionActions.getTasks.mockResolvedValueOnce({
      v: 1,
      sessionId: 'session-1',
      now: 7_000,
      tasks: [{ ...running, toolUseId: 'monitor-call' }],
    });
    await act(async () => {
      await testState.latestMonitorDetailsOnOpen?.({
        callId: 'monitor-call',
        toolName: 'monitor',
        status: 'completed',
      });
    });
    await flush();

    tabs = container.querySelectorAll<HTMLButtonElement>('button[role="tab"]');
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.getAttribute('title')).toBe('stopped watch');
    expect(container.querySelector('button[title="running watch"]')).toBeNull();
  });

  it('updates an open monitor tab from background task polling', async () => {
    const running: DaemonSessionMonitorTaskStatus = {
      kind: 'monitor',
      id: 'monitor-1',
      label: 'monitor-label',
      description: 'watch server log',
      status: 'running',
      startTime: 1_000,
      runtimeMs: 5_000,
      command: 'tail -f server.log',
      eventCount: 3,
      lastEventTime: 5_000,
      droppedLines: 0,
      toolUseId: 'monitor-call',
    };
    mockSessionActions.getTasks.mockResolvedValue({
      v: 1,
      sessionId: 'session-1',
      now: 6_000,
      tasks: [running],
    });
    mockConnection.capabilities.features = ['session_monitor_tool_correlation'];
    const { container, rerender } = renderApp();
    await flush();

    await act(async () => {
      await testState.latestMonitorDetailsOnOpen?.({
        callId: 'monitor-call',
        toolName: 'monitor',
        status: 'completed',
      });
    });
    await flush();
    expect(
      container.querySelector('button[title="watch server log"]'),
    ).not.toBeNull();

    testState.backgroundTasks = [
      { ...running, description: 'updated watch', runtimeMs: 9_000 },
    ];
    rerender();
    await flush();

    expect(
      container.querySelector('button[title="updated watch"]'),
    ).not.toBeNull();
  });

  it('returns to inline behavior when a capable daemon has no matching task', async () => {
    mockConnection.capabilities.features = ['session_monitor_tool_correlation'];
    renderApp();
    await flush();

    let opened = true;
    await act(async () => {
      opened =
        (await testState.latestMonitorDetailsOnOpen?.({
          callId: 'monitor-call',
          toolName: 'monitor',
          status: 'completed',
        })) ?? true;
    });

    expect(opened).toBe(false);
    expect(mockSessionActions.getTasks).toHaveBeenCalled();
  });

  it('ignores a monitor task response after switching sessions', async () => {
    let resolveTasks:
      | ((snapshot: {
          v: 1;
          sessionId: string;
          now: number;
          tasks: DaemonSessionMonitorTaskStatus[];
        }) => void)
      | undefined;
    mockSessionActions.getTasks.mockReturnValue(
      new Promise((resolve) => {
        resolveTasks = resolve;
      }),
    );
    mockConnection.capabilities.features = ['session_monitor_tool_correlation'];
    const { container, rerender } = renderApp();
    await flush();
    const openMonitor = testState.latestMonitorDetailsOnOpen;
    expect(openMonitor).toBeTypeOf('function');

    const openedPromise = openMonitor?.({
      callId: 'monitor-call',
      toolName: 'monitor',
      status: 'completed',
    });
    mockConnection.sessionId = 'session-2';
    rerender();
    await flush();

    await act(async () => {
      resolveTasks?.({
        v: 1,
        sessionId: 'session-1',
        now: 6_000,
        tasks: [
          {
            kind: 'monitor',
            id: 'monitor-1',
            label: 'monitor-label',
            description: 'watch old session',
            status: 'running',
            startTime: 1_000,
            runtimeMs: 5_000,
            command: 'tail -f old.log',
            eventCount: 3,
            lastEventTime: 5_000,
            droppedLines: 0,
            toolUseId: 'monitor-call',
          },
        ],
      });
      expect(await openedPromise).toBe(false);
    });

    expect(
      container.querySelector('button[title="watch old session"]'),
    ).toBeNull();
    expect(testState.latestBackgroundTasksRefreshTrigger).toBe(0);
  });
});

describe('artifact panel fullscreen', () => {
  it('opens an @ file with the current workspace identity', async () => {
    mockWorkspace.capabilities = {
      workspaceCwd: '/tmp/project',
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    mockWorkspaceActions.readWorkspaceFile.mockResolvedValueOnce({
      content: 'hello',
      truncated: false,
    });
    const { container } = renderApp();
    await flush();

    await act(async () => {
      testState.latestMessageListProps?.onAttachmentPreview?.({
        name: 'notes.txt',
        workspacePath: 'notes.txt',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockWorkspaceActions.readWorkspaceFile).toHaveBeenCalledWith(
      'notes.txt',
    );
    expect(container.textContent).not.toContain(
      'This workspace may have been removed',
    );
  });

  it('does not open an @ directory in the file preview', async () => {
    mockWorkspace.capabilities = {
      workspaceCwd: '/tmp/project',
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    mockWorkspaceActions.stat.mockResolvedValueOnce({
      kind: 'stat',
      path: 'docs',
      type: 'directory',
      sizeBytes: 0,
      modifiedMs: 0,
    });
    const { container } = renderApp();
    await flush();

    await act(async () => {
      testState.latestMessageListProps?.onAttachmentPreview?.({
        name: 'docs',
        workspacePath: 'docs',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockWorkspaceActions.stat).toHaveBeenCalledWith('docs');
    expect(
      container.querySelector('aside[aria-label="Right panel"]'),
    ).toBeNull();
  });

  it('loads a daemon attachment before opening its preview', async () => {
    const { container } = renderApp();
    await flush();

    await act(async () => {
      testState.latestMessageListProps?.onAttachmentPreview?.({
        name: 'notes.txt',
        attachmentId: 'attachment-1',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockSessionActions.readAttachment).toHaveBeenCalledWith(
      'attachment-1',
    );
    expect(
      container.querySelector('aside[aria-label="Right panel"]'),
    ).not.toBeNull();
  });

  it('reports attachment preview failures', async () => {
    const onToast = vi.fn();
    mockSessionActions.readAttachment.mockRejectedValueOnce(
      new Error('attachment unavailable'),
    );
    const { container } = renderApp({ onToast });
    await flush();

    await act(async () => {
      testState.latestMessageListProps?.onAttachmentPreview?.({
        name: 'notes.txt',
        attachmentId: 'attachment-1',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onToast).toHaveBeenCalledWith('error', 'attachment unavailable');
    expect(
      container.querySelector('aside[aria-label="Right panel"]'),
    ).toBeNull();
  });

  it('does not open an attachment after switching sessions', async () => {
    let resolveAttachment:
      | ((value: { data: string; mimeType: string }) => void)
      | undefined;
    mockSessionActions.readAttachment.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAttachment = resolve;
      }),
    );
    const { container, rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestMessageListProps?.onAttachmentPreview?.({
        name: 'notes.txt',
        attachmentId: 'attachment-1',
      });
    });
    mockConnection.sessionId = 'session-2';
    testState.ownerVersion += 1;
    rerender();
    await flush();

    await act(async () => {
      resolveAttachment?.({ data: 'aGVsbG8=', mimeType: 'text/plain' });
      await Promise.resolve();
    });

    expect(
      container.querySelector('aside[aria-label="Right panel"]'),
    ).toBeNull();
  });

  it('drops fullscreen when the panel closes and reopens docked', async () => {
    const { container } = renderApp();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await flush();
    expect(
      container.querySelector('aside[aria-label="Right panel"]'),
    ).not.toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Fullscreen"]')
        ?.click();
      await Promise.resolve();
    });
    await flush();
    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).not.toBeNull();

    // Close the panel with its own toggle while it is fullscreen.
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          'aside button[aria-label="Toggle right panel"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await flush();
    expect(
      container.querySelector('aside[aria-label="Right panel"]'),
    ).toBeNull();

    // Reopening must restore the docked default, not fullscreen.
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await flush();
    expect(
      container.querySelector('aside[aria-label="Right panel"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).toBeNull();
    expect(container.querySelector('[role="separator"]')).not.toBeNull();
    // A genuine close-and-reopen re-arms the dock's open animation: the
    // suppression class must be gone so the next open animates.
    expect(
      container.querySelector('[class*="artifactPanelDockNoOpenAnimation"]'),
    ).toBeNull();
  });

  it('does not carry fullscreen into a switched-to session', async () => {
    const { container, rerender } = renderApp();
    const openPanel = () =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
    const enterFullscreen = () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Fullscreen"]')
        ?.click();

    // Seed session-2 with a saved open-panel state.
    act(() => {
      mockConnection.sessionId = 'session-2';
      rerender();
    });
    await flush();
    act(openPanel);
    expect(
      container.querySelector('aside[aria-label="Right panel"]'),
    ).not.toBeNull();

    // Session-1: open the panel and expand it to fullscreen.
    act(() => {
      mockConnection.sessionId = 'session-1';
      rerender();
    });
    await flush();
    act(openPanel);
    act(enterFullscreen);
    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).not.toBeNull();

    // Back to session-2: its saved state reopens the panel docked; the
    // fullscreen flag must not leak across sessions.
    act(() => {
      mockConnection.sessionId = 'session-2';
      rerender();
    });
    await flush();
    expect(
      container.querySelector('aside[aria-label="Right panel"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).toBeNull();
    expect(container.querySelector('[role="separator"]')).not.toBeNull();
  });

  it('expands the floating drawer to fullscreen without remounting the panel', async () => {
    // No min-width query matches: the panel floats in a drawer instead of
    // docking.
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    const { container } = renderApp();
    await flush();

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
    });
    await flush();

    const portal = '[data-web-shell-portal-root]';
    const drawerAside = document.querySelector(
      `${portal} aside[aria-label="Right panel"]`,
    );
    expect(drawerAside).not.toBeNull();
    const drawerContent = document.querySelector<HTMLElement>(
      `${portal} [data-slot="drawer-content"]`,
    );
    expect(drawerContent?.className).toContain('min(520px');

    act(() => {
      drawerAside
        ?.querySelector<HTMLButtonElement>('button[aria-label="Fullscreen"]')
        ?.click();
    });
    await flush();

    // The same mounted instance now fills the viewport.
    const fullscreenAside = document.querySelector(
      `${portal} aside[aria-label="Right panel"]`,
    );
    expect(fullscreenAside).toBe(drawerAside);
    expect(fullscreenAside?.className).toContain('panelFullscreen');
    const fullscreenContent = document.querySelector<HTMLElement>(
      `${portal} [data-slot="drawer-content"]`,
    );
    expect(fullscreenContent).toBe(drawerContent);
    expect(fullscreenContent?.className).toContain('w-full');
    expect(fullscreenContent?.className).not.toContain('min(520px');
    expect(
      fullscreenAside?.querySelector('button[aria-label="Exit fullscreen"]'),
    ).not.toBeNull();

    // Escape shrinks the panel back to its drawer width; it must not close
    // the panel entirely. Dispatch on the drawer content (not window) so the
    // event passes through document, where vaul's capture-phase Escape
    // listener runs — DrawerContent's onEscapeKeyDown preventDefault is what
    // keeps the drawer from closing the panel here.
    await act(async () => {
      drawerAside?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();
    });
    await flush();

    const restoredAside = document.querySelector(
      `${portal} aside[aria-label="Right panel"]`,
    );
    expect(restoredAside).toBe(drawerAside);
    expect(restoredAside?.className).not.toContain('panelFullscreen');
    const restoredContent = document.querySelector<HTMLElement>(
      `${portal} [data-slot="drawer-content"]`,
    );
    expect(restoredContent?.className).toContain('min(520px');
  });

  it('leaves terminal Escape to xterm in the floating drawer', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    mockConnection.capabilities.features = ['web_terminal'];
    const { container } = renderApp({
      rightPanel: { items: ['terminal'] },
    });
    await flush();
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
    });
    await flush();
    act(() => {
      Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.includes('Terminal'))
        ?.click();
    });
    await flush();
    const terminal = document.querySelector('[data-web-terminal]');
    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });

    await act(async () => {
      terminal?.dispatchEvent(escape);
      await Promise.resolve();
    });
    await flush();

    expect(escape.defaultPrevented).toBe(true);
    expect(
      document.querySelector('aside[aria-label="Right panel"]'),
    ).not.toBeNull();
  });

  it('leaves an IME-composition Escape to the composer in the fullscreen drawer', async () => {
    // No min-width query matches: the panel floats in a drawer instead of
    // docking.
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    const { container } = renderApp();
    await flush();

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
    });
    await flush();

    const portal = '[data-web-shell-portal-root]';
    const drawerAside = document.querySelector(
      `${portal} aside[aria-label="Right panel"]`,
    );
    expect(drawerAside).not.toBeNull();
    act(() => {
      drawerAside
        ?.querySelector<HTMLButtonElement>('button[aria-label="Fullscreen"]')
        ?.click();
    });
    await flush();
    expect(drawerAside?.className).toContain('panelFullscreen');

    // Escape during IME composition must only cancel the composition: the
    // panel must not shrink and the drawer must not close. Radix's dismiss
    // layer checks only `key === 'Escape'` on document capture (no
    // isComposing guard), so the app masks the key for the dismiss layer
    // and restores it before the event reaches the focused input — with no
    // preventDefault to swallow the native IME cancel.
    const compositionEscape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    await act(async () => {
      drawerAside?.dispatchEvent(compositionEscape);
      await Promise.resolve();
    });
    await flush();

    expect(compositionEscape.defaultPrevented).toBe(false);
    expect(compositionEscape.key).toBe('Escape');
    expect(
      document.querySelector(`${portal} aside[aria-label="Right panel"]`),
    ).toBe(drawerAside);
    expect(drawerAside?.className).toContain('panelFullscreen');

    // WebKit can mark IME-owned keys with keyCode 229 while isComposing is
    // still false; the keyCode fallback branch must mask the key exactly like
    // the isComposing one above.
    const keyCodeEscape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(keyCodeEscape, 'keyCode', { value: 229 });
    await act(async () => {
      drawerAside?.dispatchEvent(keyCodeEscape);
      await Promise.resolve();
    });
    await flush();

    expect(keyCodeEscape.defaultPrevented).toBe(false);
    expect(keyCodeEscape.key).toBe('Escape');
    expect(
      document.querySelector(`${portal} aside[aria-label="Right panel"]`),
    ).toBe(drawerAside);
    expect(drawerAside?.className).toContain('panelFullscreen');

    // A plain Escape afterwards still shrinks the panel back to its drawer
    // width instead of closing it.
    await act(async () => {
      drawerAside?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();
    });
    await flush();
    expect(drawerAside?.className).not.toContain('panelFullscreen');
    expect(
      document.querySelector(`${portal} aside[aria-label="Right panel"]`),
    ).toBe(drawerAside);
  });

  it('preserves the docked width across a fullscreen round-trip', async () => {
    // While fullscreen, the chat pane is display:none; a real browser fires
    // its ResizeObserver the moment it collapses to 0x0. The width clamp
    // must not shrink the persisted panel width from that 0 measurement.
    const resizeCallbacks = new Set<ResizeObserverCallback>();
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {
        resizeCallbacks.add(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {
        resizeCallbacks.delete(this.callback);
      }
    } as typeof ResizeObserver;
    let chatPaneWidth = 400;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function () {
        if (this.dataset['testid'] !== 'chat-pane-container')
          return new DOMRect();
        return new DOMRect(0, 0, chatPaneWidth, 600);
      },
    );
    const { container } = renderApp();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await flush();
    // The opening clamp shrinks the default 500px panel to fit the 400px
    // chat pane — the width a user would then carry into fullscreen.
    expect(
      container
        .querySelector('[role="separator"]')
        ?.getAttribute('aria-valuenow'),
    ).toBe('400');

    // The hidden pane collapses to 0x0 once fullscreen covers the chat. Seed
    // the 0 measurement BEFORE entering fullscreen: entering runs the clamp
    // effect's cleanup (observer.disconnect()), so a 0 fired afterwards
    // reaches nothing — the hazard is the immediate clampWidth() the effect
    // runs with the fullscreen guard removed (and again when it re-arms on
    // exit).
    chatPaneWidth = 0;
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Fullscreen"]')
        ?.click();
      await Promise.resolve();
    });
    await flush();
    const fullscreenAside = document.querySelector<HTMLElement>(
      '[class*="artifactPanelFullscreen"] aside',
    );
    expect(fullscreenAside).not.toBeNull();
    // Full-bleed comes from the class; the docked inline width must not be
    // applied alongside it (inline styles beat classes).
    expect(fullscreenAside?.style.width).toBe('');
    expect(fullscreenAside?.style.flexBasis).toBe('');

    // The pane lays back out at viewport(900) - panel(400) = 500 on exit; the
    // persisted width must survive the 0 measurement round-trip.
    chatPaneWidth = 500;
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Exit fullscreen"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await flush();
    expect(
      container
        .querySelector('[role="separator"]')
        ?.getAttribute('aria-valuenow'),
    ).toBe('400');
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it('shrinks fullscreen when a tool approval becomes pending', async () => {
    const { container, rerender } = renderApp();

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Fullscreen"]')
        ?.click();
    });
    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).not.toBeNull();

    // A gated tool call arrives while the opaque surface covers the chat;
    // the approval overlay renders in the chat footer, so fullscreen must
    // step aside or the turn hangs behind it with no visible prompt.
    await act(async () => {
      testState.blocks = [makePendingPermissionBlock()];
      rerender();
      await Promise.resolve();
    });

    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).toBeNull();
    // The panel steps aside for the approval; it must not close — the
    // user's artifact/tab context survives beside the overlay.
    expect(
      container.querySelector('aside[aria-label="Right panel"]'),
    ).not.toBeNull();
    expect(container.querySelector('[role="separator"]')).not.toBeNull();
    const approvalOverlay = document.querySelector(
      '[data-testid="approval-overlay"]',
    );
    expect(approvalOverlay).not.toBeNull();
    expect(approvalOverlay?.closest('[aria-hidden="true"]')).toBeNull();
    // While fullscreen is still up the overlay is told keyboardActive=false;
    // the focus pull is edge-triggered, so burning its first edge on the
    // hidden (display:none) subtree would leave the shrunk overlay unfocused.
    expect(testState.toolApprovalKeyboardActiveHistory[0]).toBe(false);
    expect(testState.latestToolApprovalKeyboardActive).toBe(true);
  });

  it('shrinks fullscreen when an ask-user question becomes pending', async () => {
    const { container, rerender } = renderApp();

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Fullscreen"]')
        ?.click();
    });
    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).not.toBeNull();

    // Mirror of the tool-approval case: the question overlay renders in the
    // same hidden chat footer, so fullscreen must step aside for it too, and
    // the overlay must not be told it owns the keyboard while still covered.
    await act(async () => {
      testState.blocks = [
        makePendingPermissionBlock({ toolName: 'ask_user_question' }),
      ];
      rerender();
      await Promise.resolve();
    });

    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).toBeNull();
    expect(
      container.querySelector('aside[aria-label="Right panel"]'),
    ).not.toBeNull();
    const approvalOverlay = document.querySelector(
      '[data-testid="approval-overlay"]',
    );
    expect(approvalOverlay).not.toBeNull();
    expect(approvalOverlay?.closest('[aria-hidden="true"]')).toBeNull();
    expect(testState.askUserKeyboardActiveHistory[0]).toBe(false);
    expect(testState.latestAskUserQuestionKeyboardActive).toBe(true);
  });

  it('rethrows a rejected permission submission so the overlay re-arms', async () => {
    // The main-chat approval overlay is onConfirm for every main-chat
    // approval. ToolApproval re-arms its double-submit guard only when the
    // promise returned by onConfirm rejects — an onConfirm that swallows the
    // rejection (returning undefined) leaves submittedRef latched after a
    // transient daemon/WS failure, blocking every retry for that request.
    testState.blocks = [makePendingPermissionBlock()];
    renderApp();
    await flush();
    expect(testState.latestToolApprovalOnConfirm).not.toBeNull();

    const failure = new Error('daemon unavailable');
    mockSessionActions.submitPermission.mockRejectedValueOnce(failure);

    const submission = testState.latestToolApprovalOnConfirm?.(
      'req-1',
      'proceed_once',
    );
    expect(submission).toBeInstanceOf(Promise);
    await expect(submission).rejects.toBe(failure);
    expect(mockSessionActions.submitPermission).toHaveBeenCalledWith(
      'req-1',
      'proceed_once',
      undefined,
    );
  });

  it('leaves a docked-fullscreen IME Escape to the window handler guard', async () => {
    const { container } = renderApp();

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Fullscreen"]')
        ?.click();
    });
    const fullscreenSurface = document.querySelector(
      '[class*="artifactPanelFullscreen"]',
    );
    expect(fullscreenSurface).not.toBeNull();

    // Docked fullscreen has no drawer dismiss layer — the preserveImeEscape
    // mask is floating-only — so the only protection is the window handler's
    // isComposing guard. It must leave the native IME cancel untouched and
    // keep the panel fullscreen.
    const compositionEscape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    await act(async () => {
      fullscreenSurface?.dispatchEvent(compositionEscape);
      await Promise.resolve();
    });
    await flush();

    expect(compositionEscape.defaultPrevented).toBe(false);
    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).not.toBeNull();

    // The keyCode 229 shape (isComposing still false) must behave the same:
    // the window handler's IME guard owns both halves.
    const keyCodeEscape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(keyCodeEscape, 'keyCode', { value: 229 });
    await act(async () => {
      document
        .querySelector('[class*="artifactPanelFullscreen"]')
        ?.dispatchEvent(keyCodeEscape);
      await Promise.resolve();
    });
    await flush();

    expect(keyCodeEscape.defaultPrevented).toBe(false);
    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).not.toBeNull();

    // A plain Escape afterwards still shrinks the panel back to its docked
    // width instead of closing it.
    await act(async () => {
      document
        .querySelector('[class*="artifactPanelFullscreen"]')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        );
      await Promise.resolve();
    });
    await flush();
    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).toBeNull();
    expect(
      container.querySelector('aside[aria-label="Right panel"]'),
    ).not.toBeNull();
  });

  it('shrinks fullscreen instead of arming cancel while streaming', async () => {
    const { container, rerender } = renderApp();

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Fullscreen"]')
        ?.click();
    });
    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).not.toBeNull();

    await act(async () => {
      testState.streamingState = 'responding';
      rerender();
      await Promise.resolve();
    });

    // The fullscreen surface is topmost, so Escape must shrink it first.
    // Falling through to decideEscapeIntent would arm the two-press cancel,
    // whose affordance renders inside the hidden (display:none) chat subtree
    // — the user would see nothing and a second Escape would kill the turn.
    await act(async () => {
      document
        .querySelector('[class*="artifactPanelFullscreen"]')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        );
      await Promise.resolve();
    });
    await flush();

    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).toBeNull();
    // The panel shrinks but stays open.
    expect(
      container.querySelector('aside[aria-label="Right panel"]'),
    ).not.toBeNull();
    expect(container.querySelector('[role="separator"]')).not.toBeNull();
    expect(testState.latestChatEditorProps?.cancelArmed).toBe(false);
  });

  it('re-arms the dock open animation after a floating interlude', async () => {
    // Make the dock breakpoint flippable mid-test so the panel can hand over
    // to the floating drawer and back, like the split-view toggle or a
    // viewport resize.
    const dockQuery = '(min-width: 1001px)';
    let dockMatches = true;
    const dockChangeListeners = new Set<
      (event: { matches: boolean }) => void
    >();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches:
          query === dockQuery ? dockMatches : query.includes('min-width'),
        media: query,
        addEventListener: vi.fn((type: string, handler: unknown) => {
          if (type === 'change' && query === dockQuery) {
            dockChangeListeners.add(
              handler as (event: { matches: boolean }) => void,
            );
          }
        }),
        removeEventListener: vi.fn((type: string, handler: unknown) => {
          if (type === 'change' && query === dockQuery) {
            dockChangeListeners.delete(
              handler as (event: { matches: boolean }) => void,
            );
          }
        }),
      })),
    });
    const { container } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Fullscreen"]')
        ?.click();
      await Promise.resolve();
    });
    await flush();
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Exit fullscreen"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await flush();
    // The same dock node just swapped back from fullscreen: its open
    // animation stays suppressed while it remains mounted.
    expect(
      container.querySelector('[class*="artifactPanelDockNoOpenAnimation"]'),
    ).not.toBeNull();

    // Narrow the viewport: the dock unmounts and the drawer takes over.
    dockMatches = false;
    await act(async () => {
      dockChangeListeners.forEach((handler) => handler({ matches: false }));
      await Promise.resolve();
    });
    await flush();
    expect(container.querySelector('[class*="artifactPanelDock"]')).toBeNull();
    expect(
      document.querySelector(
        '[data-web-shell-portal-root] aside[aria-label="Right panel"]',
      ),
    ).not.toBeNull();

    // Widen again: the dock remounts for a genuine open and must get its
    // slide-in animation back — a stale suppression flag would eat it.
    dockMatches = true;
    await act(async () => {
      dockChangeListeners.forEach((handler) => handler({ matches: true }));
      await Promise.resolve();
    });
    await flush();
    expect(
      container.querySelector('[class*="artifactPanelDock"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[class*="artifactPanelDockNoOpenAnimation"]'),
    ).toBeNull();
  });

  it('does not steal focus when an open docked panel hands over to the floating drawer', async () => {
    // The drawer mounts already-open; autofocus belongs to a genuine
    // closed->open only. A docked->floating hand-over of an open panel
    // (viewport resize here) mounts the drawer mid-session, and pulling
    // focus into it would eat the user's keystrokes.
    const dockQuery = '(min-width: 1001px)';
    let dockMatches = true;
    const dockChangeListeners = new Set<
      (event: { matches: boolean }) => void
    >();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches:
          query === dockQuery ? dockMatches : query.includes('min-width'),
        media: query,
        addEventListener: vi.fn((type: string, handler: unknown) => {
          if (type === 'change' && query === dockQuery) {
            dockChangeListeners.add(
              handler as (event: { matches: boolean }) => void,
            );
          }
        }),
        removeEventListener: vi.fn((type: string, handler: unknown) => {
          if (type === 'change' && query === dockQuery) {
            dockChangeListeners.delete(
              handler as (event: { matches: boolean }) => void,
            );
          }
        }),
      })),
    });
    const { container } = renderApp();
    await flush();

    // Open the panel while it docks.
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await flush();
    expect(
      container.querySelector('aside[aria-label="Right panel"]'),
    ).not.toBeNull();

    // The user is on the composer's submit control when the viewport narrows.
    const composer = container.querySelector<HTMLElement>(
      '[data-testid="submit"]',
    );
    expect(composer).not.toBeNull();
    composer!.focus();
    expect(document.activeElement).toBe(composer);

    // Narrow: the dock unmounts and the drawer takes over mid-session.
    dockMatches = false;
    await act(async () => {
      dockChangeListeners.forEach((handler) => handler({ matches: false }));
      await Promise.resolve();
    });
    await flush();
    expect(container.querySelector('[class*="artifactPanelDock"]')).toBeNull();
    expect(
      document.querySelector(
        '[data-web-shell-portal-root] aside[aria-label="Right panel"]',
      ),
    ).not.toBeNull();

    // The hand-over mounts the drawer already-open; it must not autofocus.
    expect(document.activeElement).toBe(composer);
  });

  it('moves focus into the floating drawer on a genuine open', async () => {
    // No min-width query matches: the panel floats in a drawer instead of
    // docking, so opening it is a genuine closed->open — the autofocus the
    // hand-over test above keeps out must still land here.
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    const { container } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await flush();

    const drawerAside = document.querySelector(
      '[data-web-shell-portal-root] aside[aria-label="Right panel"]',
    );
    expect(drawerAside).not.toBeNull();
    expect(drawerAside!.contains(document.activeElement)).toBe(true);
  });

  it('keeps the dock animation suppressed across a fullscreen floating interlude', async () => {
    // Docked fullscreen -> narrow (the drawer takes over) -> widen -> shrink
    // via a non-toggle exit: the suppression flag must survive the interlude,
    // or the exit class swap replays the slide-in on the already-open panel.
    const dockQuery = '(min-width: 1001px)';
    let dockMatches = true;
    const dockChangeListeners = new Set<
      (event: { matches: boolean }) => void
    >();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches:
          query === dockQuery ? dockMatches : query.includes('min-width'),
        media: query,
        addEventListener: vi.fn((type: string, handler: unknown) => {
          if (type === 'change' && query === dockQuery) {
            dockChangeListeners.add(
              handler as (event: { matches: boolean }) => void,
            );
          }
        }),
        removeEventListener: vi.fn((type: string, handler: unknown) => {
          if (type === 'change' && query === dockQuery) {
            dockChangeListeners.delete(
              handler as (event: { matches: boolean }) => void,
            );
          }
        }),
      })),
    });
    const { container } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Fullscreen"]')
        ?.click();
      await Promise.resolve();
    });
    await flush();

    // Narrow: the drawer takes over while fullscreen persists.
    dockMatches = false;
    await act(async () => {
      dockChangeListeners.forEach((handler) => handler({ matches: false }));
      await Promise.resolve();
    });
    await flush();
    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).toBeNull();
    expect(
      document.querySelector(
        '[data-web-shell-portal-root] aside[class*="panelFullscreen"]',
      ),
    ).not.toBeNull();

    // Widen: the dock remounts straight into the fullscreen class.
    dockMatches = true;
    await act(async () => {
      dockChangeListeners.forEach((handler) => handler({ matches: true }));
      await Promise.resolve();
    });
    await flush();
    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).not.toBeNull();

    // Shrink via Escape — a non-toggle exit that does not re-set the flag.
    await act(async () => {
      document
        .querySelector('[class*="artifactPanelFullscreen"]')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        );
      await Promise.resolve();
    });
    await flush();
    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).toBeNull();
    expect(
      container.querySelector('[class*="artifactPanelDockNoOpenAnimation"]'),
    ).not.toBeNull();
  });

  it('suppresses the dock animation when a floating fullscreen hands back to the dock', async () => {
    // Floating (narrow viewport) -> fullscreen -> widen -> shrink: the toggle
    // never set the flag (the panel was floating when it fired), so the
    // hand-over back to the dock must arm it itself.
    const dockQuery = '(min-width: 1001px)';
    let dockMatches = false;
    const dockChangeListeners = new Set<
      (event: { matches: boolean }) => void
    >();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches:
          query === dockQuery ? dockMatches : query.includes('min-width'),
        media: query,
        addEventListener: vi.fn((type: string, handler: unknown) => {
          if (type === 'change' && query === dockQuery) {
            dockChangeListeners.add(
              handler as (event: { matches: boolean }) => void,
            );
          }
        }),
        removeEventListener: vi.fn((type: string, handler: unknown) => {
          if (type === 'change' && query === dockQuery) {
            dockChangeListeners.delete(
              handler as (event: { matches: boolean }) => void,
            );
          }
        }),
      })),
    });
    const { container } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await flush();
    // The narrow viewport floats the panel in a drawer.
    const drawerAside = () =>
      document.querySelector<HTMLElement>(
        '[data-web-shell-portal-root] aside[aria-label="Right panel"]',
      );
    expect(drawerAside()).not.toBeNull();
    await act(async () => {
      drawerAside()
        ?.querySelector<HTMLButtonElement>('button[aria-label="Fullscreen"]')
        ?.click();
      await Promise.resolve();
    });
    await flush();
    expect(drawerAside()?.className).toContain('panelFullscreen');

    // Widen: the dock mounts directly into the fullscreen class.
    dockMatches = true;
    await act(async () => {
      dockChangeListeners.forEach((handler) => handler({ matches: true }));
      await Promise.resolve();
    });
    await flush();
    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).not.toBeNull();

    // Shrink via Escape; the hand-over must have armed the suppression flag.
    await act(async () => {
      document
        .querySelector('[class*="artifactPanelFullscreen"]')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        );
      await Promise.resolve();
    });
    await flush();
    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).toBeNull();
    expect(
      container.querySelector('[class*="artifactPanelDockNoOpenAnimation"]'),
    ).not.toBeNull();
  });

  it('does not dismiss the floating environment panel on pointerdown while fullscreen', async () => {
    const resizeCallbacks = new Set<ResizeObserverCallback>();
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {
        resizeCallbacks.add(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {
        resizeCallbacks.delete(this.callback);
      }
    } as typeof ResizeObserver;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function () {
        if (this.dataset['testid'] !== 'context-body') return new DOMRect();
        return new DOMRect(0, 0, 1_000, 600);
      },
    );
    const { container } = renderApp();

    await act(async () => {
      resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver));
      await Promise.resolve();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle environment information"]',
        )
        ?.click();
    });
    expect(
      container
        .querySelector('[data-testid="environment-panel"]:not([hidden])')
        ?.getAttribute('data-floating'),
    ).toBe('true');

    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Fullscreen"]')
        ?.click();
    });
    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).not.toBeNull();

    // A pointerdown lands on the fullscreen surface; the covered environment
    // panel is hidden but must not be dismissed by its outside-click listener.
    act(() => {
      document
        .querySelector('[class*="artifactPanelFullscreen"]')
        ?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });

    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Exit fullscreen"]',
        )
        ?.click();
    });
    expect(
      container.querySelector(
        '[data-testid="environment-panel"]:not([hidden])',
      ),
    ).not.toBeNull();
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it('keeps the elevated toast host out of the fullscreen aria-hidden sweep', async () => {
    const { container } = renderApp();
    await flush();
    // Elevation portals the toast host into the same portal root the
    // fullscreen slot parks in; plant one before the surface goes up.
    const portalRoot = document.querySelector('[data-web-shell-portal-root]');
    expect(portalRoot).not.toBeNull();
    const toastHost = document.createElement('div');
    toastHost.setAttribute('data-web-shell-toast-host', '');
    portalRoot!.appendChild(toastHost);
    try {
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Toggle right panel"]',
          )
          ?.click();
        await Promise.resolve();
      });
      await flush();
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('button[aria-label="Fullscreen"]')
          ?.click();
        await Promise.resolve();
      });
      await flush();
      expect(
        document.querySelector('[class*="artifactPanelFullscreen"]'),
      ).not.toBeNull();
      // Toasts carry functional messages (connection lost, side-task
      // failures) — the sweep must hide the app without silencing them.
      expect(toastHost.getAttribute('aria-hidden')).toBeNull();
      // Control: the sweep still hides the app container.
      expect(container.getAttribute('aria-hidden')).toBe('true');
    } finally {
      toastHost.remove();
    }
  });

  it('defers aria-hidden restoration while a hideOthers lock owns the node', async () => {
    const { container } = renderApp();
    await flush();
    // A body-level sibling of the portal root, hidden by the sweep like the
    // app container is.
    const probe = document.createElement('div');
    document.body.appendChild(probe);
    try {
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Toggle right panel"]',
          )
          ?.click();
        await Promise.resolve();
      });
      await flush();
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('button[aria-label="Fullscreen"]')
          ?.click();
        await Promise.resolve();
      });
      await flush();
      expect(probe.getAttribute('aria-hidden')).toBe('true');
      // A DialogShell opened over the surface marks its controlled nodes;
      // it recorded this one as already hidden, so its unlock will not
      // restore it.
      probe.setAttribute('data-aria-hidden', 'true');
      await act(async () => {
        document
          .querySelector('[class*="artifactPanelFullscreen"]')
          ?.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Escape',
              bubbles: true,
              cancelable: true,
            }),
          );
        await Promise.resolve();
      });
      await flush();
      expect(
        document.querySelector('[class*="artifactPanelFullscreen"]'),
      ).toBeNull();
      // Restoring now would expose the app behind the open modal, and the
      // control node without a lock restores immediately.
      expect(probe.getAttribute('aria-hidden')).toBe('true');
      expect(container.getAttribute('aria-hidden')).toBeNull();
      // The lock releases; the deferred restore returns the node's state.
      probe.removeAttribute('data-aria-hidden');
      await flush();
      expect(probe.hasAttribute('aria-hidden')).toBe(false);
    } finally {
      probe.remove();
    }
  });

  it('restores the app to AT when a locked floating fullscreen hands back to the dock', async () => {
    // Narrow viewport: the panel floats in vaul's drawer, a Radix modal
    // dialog whose hideOthers lock aria-hides every body-level sibling and
    // marks it with data-aria-hidden. Widening across the breakpoint
    // mid-fullscreen unmounts the drawer and mounts the docked surface in
    // one commit; the sweep's layout-phase setup captures aria-hidden values
    // while the lock still owns them (its unlock runs in the passive phase).
    const dockQuery = '(min-width: 1001px)';
    let dockMatches = false;
    const dockChangeListeners = new Set<
      (event: { matches: boolean }) => void
    >();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches:
          query === dockQuery ? dockMatches : query.includes('min-width'),
        media: query,
        addEventListener: vi.fn((type: string, handler: unknown) => {
          if (type === 'change' && query === dockQuery) {
            dockChangeListeners.add(
              handler as (event: { matches: boolean }) => void,
            );
          }
        }),
        removeEventListener: vi.fn((type: string, handler: unknown) => {
          if (type === 'change' && query === dockQuery) {
            dockChangeListeners.delete(
              handler as (event: { matches: boolean }) => void,
            );
          }
        }),
      })),
    });
    const { container } = renderApp();
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await flush();
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-web-shell-portal-root] aside[aria-label="Right panel"] button[aria-label="Fullscreen"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await flush();
    expect(
      document.querySelector(
        '[data-web-shell-portal-root] aside[class*="panelFullscreen"]',
      ),
    ).not.toBeNull();
    // The drawer's modal lock owns the app container.
    expect(container.getAttribute('aria-hidden')).toBe('true');
    expect(container.hasAttribute('data-aria-hidden')).toBe(true);

    // Widen: the docked surface mounts while the lock still owns the
    // container, so the sweep must not record the lock's value as the
    // container's original state.
    dockMatches = true;
    await act(async () => {
      dockChangeListeners.forEach((handler) => handler({ matches: true }));
      await Promise.resolve();
    });
    await flush();
    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).not.toBeNull();
    // The lock's unlock restored the true original value by now.
    expect(container.hasAttribute('data-aria-hidden')).toBe(false);

    // Shrink back via Escape.
    await act(async () => {
      document
        .querySelector('[class*="artifactPanelFullscreen"]')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        );
      await Promise.resolve();
    });
    await flush();
    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).toBeNull();
    // The deferred restore must not re-apply the lock's aria-hidden as if it
    // were the container's original state: the shell stays visible to AT.
    expect(container.getAttribute('aria-hidden')).toBeNull();
  });

  it('keeps an open modal focus trap active when the docked panel mounts', async () => {
    // Stand-in for an open DialogShell modal: a real Radix FocusScope trap,
    // on the same module-global focus-scope stack a dialog registers in.
    const { FocusScope } = await import('@radix-ui/react-focus-scope');
    const trapContainer = document.createElement('div');
    document.body.appendChild(trapContainer);
    const trapRoot = createRoot(trapContainer);
    try {
      act(() => {
        trapRoot.render(
          <FocusScope trapped>
            <button type="button">inside dialog</button>
          </FocusScope>,
        );
      });
      const trappedButton =
        trapContainer.querySelector<HTMLButtonElement>('button');
      expect(trappedButton).not.toBeNull();
      expect(document.activeElement).toBe(trappedButton);

      const { container } = renderApp();
      await flush();
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Toggle right panel"]',
          )
          ?.click();
        await Promise.resolve();
      });
      await flush();
      expect(
        container.querySelector('aside[aria-label="Right panel"]'),
      ).not.toBeNull();

      // Focus escaping the modal must be pulled back into it; a trap paused
      // by the panel mounting (the regression) leaves it outside.
      const outside = container.querySelector<HTMLElement>(
        '[data-testid="submit"]',
      );
      expect(outside).not.toBeNull();
      outside!.focus();
      expect(document.activeElement).toBe(trappedButton);
    } finally {
      act(() => trapRoot.unmount());
      trapContainer.remove();
    }
  });

  it('wraps Tab at the fullscreen surface edges', async () => {
    const { container } = renderApp();
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Fullscreen"]')
        ?.click();
      await Promise.resolve();
    });
    await flush();
    const surface = document.querySelector<HTMLElement>(
      '[class*="artifactPanelFullscreen"]',
    );
    expect(surface).not.toBeNull();
    const tabbables = Array.from(
      surface!.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    expect(tabbables.length).toBeGreaterThan(1);
    const first = tabbables[0]!;
    const last = tabbables[tabbables.length - 1]!;
    last.focus();
    expect(document.activeElement).toBe(last);
    await act(async () => {
      surface!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(first);
    await act(async () => {
      surface!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(last);
  });

  it('pulls focus back into the docked fullscreen surface when it escapes', async () => {
    const { container } = renderApp();
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Fullscreen"]')
        ?.click();
      await Promise.resolve();
    });
    await flush();
    const surface = document.querySelector<HTMLElement>(
      '[class*="artifactPanelFullscreen"]',
    );
    expect(surface).not.toBeNull();

    // Focus inside the surface — including the sandboxed HTML preview
    // iframe, whose document owns its keydowns — must be left alone.
    const exitFullscreen = surface!.querySelector<HTMLElement>(
      'button[aria-label="Exit fullscreen"]',
    );
    expect(exitFullscreen).not.toBeNull();
    exitFullscreen!.focus();
    expect(document.activeElement).toBe(exitFullscreen);

    // A Tab past the preview's last focusable lands focus natively outside
    // the surface: the keydown that moved it never reached the surface's
    // Tab-wrap handler. Pull the focus back so the keyboard stays the
    // surface's escape route...
    const outside = container.querySelector<HTMLElement>(
      '[data-testid="submit"]',
    );
    expect(outside).not.toBeNull();
    outside!.focus();
    expect(document.activeElement).toBe(surface);

    // ...while the elevated toast host stays actionable beside the surface.
    const portalRoot = document.querySelector('[data-web-shell-portal-root]');
    expect(portalRoot).not.toBeNull();
    const toastHost = document.createElement('div');
    toastHost.setAttribute('data-web-shell-toast-host', '');
    const toastButton = document.createElement('button');
    toastHost.appendChild(toastButton);
    portalRoot!.appendChild(toastHost);
    try {
      toastButton.focus();
      expect(document.activeElement).toBe(toastButton);
    } finally {
      toastHost.remove();
    }

    // The recovered focus re-arms the keyboard-only exit.
    await act(async () => {
      surface!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();
    });
    await flush();
    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).toBeNull();
  });

  it('keeps the docked fullscreen surface keyboard-operable in shadow-DOM portal mode', async () => {
    const { container } = renderApp({ shadowDom: { portals: true } });
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Fullscreen"]')
        ?.click();
      await Promise.resolve();
    });
    await flush();
    const portalHost = document.querySelector<HTMLElement>(
      '[data-web-shell-shadow-host="portals"]',
    );
    const shadowRoot = portalHost?.shadowRoot;
    const surface = shadowRoot?.querySelector<HTMLElement>(
      '[class*="artifactPanelFullscreen"]',
    );
    expect(surface).not.toBeNull();

    // focusin is composed: the browser retargets it to the shadow host at
    // document level while composedPath() keeps the real node. Model that
    // delivery and require the pull handler to resolve the real node...
    const exitFullscreen = surface!.querySelector<HTMLElement>(
      'button[aria-label="Exit fullscreen"]',
    );
    expect(exitFullscreen).not.toBeNull();
    exitFullscreen!.focus();
    expect(shadowRoot!.activeElement).toBe(exitFullscreen);
    const composedFocusin = new FocusEvent('focusin', {
      bubbles: true,
      composed: true,
    });
    Object.defineProperty(composedFocusin, 'composedPath', {
      value: () => [
        exitFullscreen,
        surface,
        portalHost,
        document.body,
        document.documentElement,
        document,
      ],
    });
    await act(async () => {
      portalHost!.dispatchEvent(composedFocusin);
      await Promise.resolve();
    });
    // ...instead of snapping every focus change back onto the surface.
    expect(shadowRoot!.activeElement).toBe(exitFullscreen);

    // Focus that genuinely left the shell is still pulled back.
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    try {
      outside.focus();
      await act(async () => {
        outside.dispatchEvent(
          new FocusEvent('focusin', { bubbles: true, composed: true }),
        );
        await Promise.resolve();
      });
      expect(shadowRoot!.activeElement).toBe(surface);
    } finally {
      outside.remove();
    }

    // Tab wraps at the surface edges off the shadow root's active element,
    // not the retargeted document.activeElement.
    const tabbables = Array.from(
      surface!.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    expect(tabbables.length).toBeGreaterThan(1);
    const first = tabbables[0]!;
    const last = tabbables[tabbables.length - 1]!;
    last.focus();
    expect(shadowRoot!.activeElement).toBe(last);
    await act(async () => {
      surface!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();
    });
    expect(shadowRoot!.activeElement).toBe(first);
  });

  it('shrinks fullscreen with one Escape while a forced session drawer is open', async () => {
    const shellRef = createRef<WebShellApi>();
    const { container } = renderApp({ sidebar: true, shellRef });
    await flush();
    await act(async () => {
      shellRef.current?.openSessionDrawer();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-sidebar-shell][role="dialog"]')?.className,
    ).toContain('mobileDrawerForced');

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Fullscreen"]')
        ?.click();
      await Promise.resolve();
    });
    await flush();
    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).not.toBeNull();

    // One Escape shrinks the surface: the forced (display:none) drawer must
    // not swallow the key and force a second press.
    await act(async () => {
      document
        .querySelector('[class*="artifactPanelFullscreen"]')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        );
      await Promise.resolve();
    });
    await flush();
    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).toBeNull();
    // Escape only shrunk the surface; the drawer stays as it was.
    expect(
      container.querySelector('[data-sidebar-shell][role="dialog"]'),
    ).not.toBeNull();
  });

  it('leaves terminal Escape to xterm while the session drawer is open', async () => {
    const shellRef = createRef<WebShellApi>();
    const { container } = renderApp({ sidebar: true, shellRef });
    await flush();
    await act(async () => {
      shellRef.current?.openSessionDrawer();
      await Promise.resolve();
    });
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    document.body.append(host);
    const terminal = document.createElement('div');
    terminal.dataset['webTerminal'] = '';
    const input = document.createElement('textarea');
    terminal.append(input);
    shadow.append(terminal);
    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
      composed: true,
    });

    await act(async () => {
      input.dispatchEvent(escape);
      await Promise.resolve();
    });

    expect(escape.defaultPrevented).toBe(false);
    expect(
      container.querySelector('[data-sidebar-shell][role="dialog"]'),
    ).not.toBeNull();
    host.remove();
  });

  it('reveals the covered shells in the commit that closes the fullscreen panel', async () => {
    const { container } = renderApp();
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Fullscreen"]')
        ?.click();
      await Promise.resolve();
    });
    await flush();
    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).not.toBeNull();
    const sidebarShell = container.querySelector('[data-sidebar-shell]');
    const contextShell = container.querySelector('[class*="contextShell"]');
    expect(sidebarShell?.className).toContain('chatViewHidden');
    expect(contextShell?.className).toContain('chatViewHidden');

    // Inside async act the click's commit flushes at the microtask boundary
    // while the passive effects stay queued until act completes, so the DOM
    // read here is exactly the committed frame the browser would paint next.
    // A fullscreen reset deferred to the management effect would leave the
    // shells display:none in this frame.
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          'aside button[aria-label="Toggle right panel"]',
        )
        ?.click();
      await Promise.resolve();
      expect(
        document.querySelector('[class*="artifactPanelFullscreen"]'),
      ).toBeNull();
      expect(
        container.querySelector('aside[aria-label="Right panel"]'),
      ).toBeNull();
      expect(sidebarShell?.className).not.toContain('chatViewHidden');
      expect(contextShell?.className).not.toContain('chatViewHidden');
      expect(contextShell?.getAttribute('aria-hidden')).toBeNull();
    });
    await flush();
  });

  it('reveals the covered shells in the commit that closes the last fullscreen tab', async () => {
    const task: DaemonSessionMonitorTaskStatus = {
      kind: 'monitor',
      id: 'monitor-1',
      label: 'monitor-label',
      description: 'watch server log',
      status: 'running',
      startTime: 1_000,
      runtimeMs: 5_000,
      command: 'tail -f server.log',
      eventCount: 3,
      lastEventTime: 5_000,
      droppedLines: 0,
      toolUseId: 'monitor-call',
    };
    mockSessionActions.getTasks.mockResolvedValue({
      v: 1,
      sessionId: 'session-1',
      now: 6_000,
      tasks: [task],
    });
    mockConnection.capabilities.features = ['session_monitor_tool_correlation'];
    const { container } = renderApp();
    await flush();
    await act(async () => {
      await testState.latestMonitorDetailsOnOpen?.({
        callId: 'monitor-call',
        toolName: 'monitor',
        status: 'completed',
      });
      await Promise.resolve();
    });
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Fullscreen"]')
        ?.click();
      await Promise.resolve();
    });
    await flush();
    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).not.toBeNull();
    const sidebarShell = container.querySelector('[data-sidebar-shell]');
    const contextShell = container.querySelector('[class*="contextShell"]');
    expect(sidebarShell?.className).toContain('chatViewHidden');
    expect(contextShell?.className).toContain('chatViewHidden');

    // Closing the last tab closes the panel through closeArtifactPanelTab;
    // its fullscreen reset must land in the same commit exactly like the
    // panel-close path's, or the covered shells paint one hidden frame with
    // the panel already gone.
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          'aside button[aria-label="Close watch server log"]',
        )
        ?.click();
      await Promise.resolve();
      expect(
        document.querySelector('[class*="artifactPanelFullscreen"]'),
      ).toBeNull();
      expect(
        container.querySelector('aside[aria-label="Right panel"]'),
      ).toBeNull();
      expect(sidebarShell?.className).not.toContain('chatViewHidden');
      expect(contextShell?.className).not.toContain('chatViewHidden');
      expect(contextShell?.getAttribute('aria-hidden')).toBeNull();
    });
    await flush();
  });

  it('keeps the floating drawer Escape-to-close intact while not fullscreen', async () => {
    // No min-width query matches: the panel floats in a drawer instead of
    // docking.
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    const { container } = renderApp();
    await flush();
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
    });
    await flush();
    const portal = '[data-web-shell-portal-root]';
    const drawerAside = document.querySelector(
      `${portal} aside[aria-label="Right panel"]`,
    );
    expect(drawerAside).not.toBeNull();
    expect(drawerAside?.className).not.toContain('panelFullscreen');

    // The preserveImeEscape mask runs whenever the drawer is open —
    // fullscreen or not — so a composition-cancel Escape must pass through
    // vaul's dismiss layer here too: no preventDefault, and the key is
    // restored for the focused input.
    const compositionEscape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    await act(async () => {
      drawerAside?.dispatchEvent(compositionEscape);
      await Promise.resolve();
    });
    await flush();
    expect(compositionEscape.defaultPrevented).toBe(false);
    expect(compositionEscape.key).toBe('Escape');
    expect(
      document.querySelector(`${portal} aside[aria-label="Right panel"]`),
    ).toBe(drawerAside);

    // WebKit marks IME-owned keys with keyCode 229 while isComposing is
    // still false; the fallback branch masks them identically.
    const keyCodeEscape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(keyCodeEscape, 'keyCode', { value: 229 });
    await act(async () => {
      drawerAside?.dispatchEvent(keyCodeEscape);
      await Promise.resolve();
    });
    await flush();
    expect(keyCodeEscape.defaultPrevented).toBe(false);
    expect(keyCodeEscape.key).toBe('Escape');
    expect(
      document.querySelector(`${portal} aside[aria-label="Right panel"]`),
    ).toBe(drawerAside);

    // The fullscreen handler's non-fullscreen branch must stay a pure
    // pass-through: no preventDefault, so vaul's dismiss layer closes the
    // drawer exactly as it did before fullscreen support landed.
    await act(async () => {
      drawerAside?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();
    });
    await flush();
    expect(
      document.querySelector(`${portal} aside[aria-label="Right panel"]`),
    ).toBeNull();
  });
});

describe('environment agent tasks', () => {
  it('reports transcript agent tasks without enabling the overview panel', async () => {
    testState.messages = [
      {
        id: 'tools',
        role: 'tool_group',
        tools: [
          {
            callId: 'agent-call',
            toolName: 'agent',
            title: 'Agent: Explore code',
            status: 'completed',
            args: {
              description: 'Explore code',
              run_in_background: false,
            },
            rawOutput: {
              type: 'task_execution',
              status: 'completed',
            },
          },
        ],
      },
    ];
    const onAgentTasksChange = vi.fn();

    renderApp({
      header: { items: [] },
      environmentPanel: { items: [] },
      onAgentTasksChange,
    });
    await flush();

    expect(onAgentTasksChange).toHaveBeenLastCalledWith([
      expect.objectContaining({
        id: 'agent-call',
        label: 'Explore code',
        status: 'completed',
        isBackgrounded: false,
      }),
    ]);
  });

  it('reports merged live tasks without duplication and clears for a new session', async () => {
    const onAgentTasksChange = vi.fn();
    const props = {
      header: { items: [] as const },
      environmentPanel: { items: [] as const },
      onAgentTasksChange,
    };
    const { rerender } = renderApp(props);
    await flush();
    expect(onAgentTasksChange).toHaveBeenLastCalledWith([]);

    testState.messages = [
      {
        id: 'tools',
        role: 'tool_group',
        tools: [
          {
            callId: 'agent-call',
            toolName: 'agent',
            title: 'Agent: Review code',
            status: 'in_progress',
            args: {
              description: 'Review code',
              subagent_type: 'reviewer',
              run_in_background: true,
            },
          },
        ],
      },
    ];
    testState.backgroundTasks = [
      {
        kind: 'agent',
        id: 'agent-task',
        label: 'reviewer: Review code',
        description: 'Review code',
        subagentType: 'reviewer',
        status: 'running',
        startTime: 1,
        runtimeMs: 1,
        isBackgrounded: true,
        toolUseId: 'agent-call',
      },
    ];
    rerender(props);
    await flush();

    const mergedTasks = onAgentTasksChange.mock.lastCall?.[0];
    expect(mergedTasks).toHaveLength(1);
    expect(mergedTasks?.[0]).toMatchObject({
      id: 'agent-task',
      label: 'Review code',
      status: 'running',
      toolUseId: 'agent-call',
    });

    const mergeCallCount = onAgentTasksChange.mock.calls.length;
    testState.messages = [...testState.messages];
    testState.backgroundTasks = testState.backgroundTasks.map((task) => ({
      ...task,
      runtimeMs: 3_001,
      ...(task.kind === 'agent'
        ? {
            stats: { totalTokens: 42, toolUses: 3, durationMs: 3_001 },
            recentActivities: [
              { name: 'read', description: 'Read App.tsx', at: 3_000 },
            ],
          }
        : {}),
    }));
    rerender(props);
    await flush();
    expect(onAgentTasksChange).toHaveBeenCalledTimes(mergeCallCount);

    mockConnection.sessionId = 'session-2';
    testState.ownerVersion += 1;
    testState.messages = [];
    testState.backgroundTasks = [];
    rerender(props);
    await flush();

    expect(onAgentTasksChange).toHaveBeenLastCalledWith([]);
  });

  it('reports the current snapshot after the callback is reattached', async () => {
    testState.backgroundTasks = [
      {
        kind: 'agent',
        id: 'agent-task',
        label: 'Review code',
        description: 'Review code',
        status: 'running',
        startTime: 1,
        runtimeMs: 1,
        isBackgrounded: true,
      },
    ];
    const onAgentTasksChange = vi.fn();
    const props = { onAgentTasksChange };
    const { rerender } = renderApp(props);
    await flush();
    expect(onAgentTasksChange).toHaveBeenCalledTimes(1);

    rerender({});
    await flush();
    rerender(props);
    await flush();

    expect(onAgentTasksChange).toHaveBeenCalledTimes(2);
    expect(onAgentTasksChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'agent-task', status: 'running' }),
    ]);
  });

  it('keeps a completed foreground agent from the session transcript', () => {
    const messages = [
      {
        id: 'tools',
        role: 'tool_group',
        tools: [
          {
            callId: 'agent-call',
            toolName: 'agent',
            title: 'Agent: Explore code',
            status: 'completed',
            args: {
              description: 'Explore code',
              run_in_background: false,
            },
            rawOutput: {
              type: 'task_execution',
              status: 'completed',
              subagentColor: 'purple',
            },
          },
        ],
      },
    ] satisfies Message[];

    expect(getEnvironmentAgentTasks(messages, [])).toMatchObject([
      {
        id: 'agent-call',
        label: 'Explore code',
        status: 'completed',
        color: 'purple',
        isBackgrounded: false,
        toolUseId: 'agent-call',
      },
    ]);
  });

  it('uses the prompt for a generic Agent title and ignores nested tools', () => {
    const messages = [
      {
        id: 'tools',
        role: 'tool_group',
        tools: [
          {
            callId: 'agent-call',
            toolName: 'agent',
            title: 'Agent',
            status: 'in_progress',
            args: {
              prompt: '查询杭州明天天气',
              run_in_background: true,
            },
            subTools: [
              {
                callId: 'search-call',
                toolName: 'web_search',
                status: 'completed',
                subContent: 'result',
              },
            ],
          },
        ],
      },
    ] satisfies Message[];

    expect(getEnvironmentAgentTasks(messages, [])).toMatchObject([
      {
        id: 'agent-call',
        label: '查询杭州明天天气',
      },
    ]);
  });

  it('keeps the transcript color when a live agent task is available', () => {
    const messages = [
      {
        id: 'tools',
        role: 'tool_group',
        tools: [
          {
            callId: 'agent-call',
            toolName: 'agent',
            title: 'Agent: Review code',
            status: 'in_progress',
            args: { subagent_type: 'reviewer' },
            rawOutput: {
              type: 'task_execution',
              subagentColor: 'purple',
            },
          },
        ],
      },
    ] satisfies Message[];
    const liveTask = {
      kind: 'agent' as const,
      id: 'agent-task',
      label: 'reviewer: Review code',
      description: 'Review code',
      subagentType: 'reviewer',
      status: 'running' as const,
      startTime: 1,
      runtimeMs: 1,
      isBackgrounded: true,
      toolUseId: 'agent-call',
    };

    expect(getEnvironmentAgentTasks(messages, [liveTask])).toMatchObject([
      {
        id: 'agent-task',
        color: 'purple',
      },
    ]);
  });

  it('deduplicates a live agent by the task id recorded in the message stream', () => {
    const messages = [
      {
        id: 'tools',
        role: 'tool_group',
        tools: [
          {
            callId: 'call-agent-1',
            toolName: 'agent',
            title: 'Agent: Review code',
            status: 'in_progress',
            args: { subagent_type: 'shadcn-ux' },
          },
        ],
      },
      {
        id: 'agent-notification',
        role: 'system',
        content: 'background agent completed',
        variant: 'info',
        source: 'background_notification',
        data: {
          kind: 'agent',
          taskId: 'agent-runtime-id',
          toolUseId: 'call-agent-1',
          status: 'completed',
        },
      },
    ] satisfies Message[];
    const liveTask = {
      kind: 'agent' as const,
      id: 'agent-runtime-id',
      label: 'shadcn-ux: Review code',
      description: 'Review code',
      subagentType: 'shadcn-ux',
      status: 'completed' as const,
      startTime: 1,
      runtimeMs: 1,
      isBackgrounded: true,
    };

    expect(getEnvironmentAgentTasks(messages, [liveTask])).toMatchObject([
      {
        id: 'agent-runtime-id',
        label: 'Review code',
        status: 'completed',
      },
    ]);
  });

  it('deduplicates a completed background agent whose live task lost its toolUseId', () => {
    const messages = [
      {
        id: 'tools',
        role: 'tool_group',
        tools: [
          {
            callId: 'call-agent-1',
            toolName: 'agent',
            title: 'Agent: Review code',
            status: 'completed',
            args: {
              description: 'Review code',
              prompt: 'Review the diff for bugs',
              subagent_type: 'general-purpose',
              run_in_background: true,
            },
            rawOutput: {
              type: 'task_execution',
              status: 'completed',
            },
          },
        ],
      },
      {
        id: 'agent-notification',
        role: 'system',
        content: 'background agent completed',
        variant: 'info',
        source: 'background_notification',
        data: {
          kind: 'agent',
          taskId: 'general-purpose-internal-1',
          status: 'completed',
        },
      },
    ] satisfies Message[];
    const liveTask = {
      kind: 'agent' as const,
      id: 'general-purpose-internal-1',
      label: 'general-purpose: Review code',
      description: 'Review code',
      prompt: 'Review the diff for bugs',
      subagentType: 'general-purpose',
      status: 'completed' as const,
      startTime: 1,
      runtimeMs: 1,
      isBackgrounded: true,
    };

    expect(getEnvironmentAgentTasks(messages, [liveTask])).toMatchObject([
      {
        id: 'general-purpose-internal-1',
        label: 'Review code',
        status: 'completed',
      },
    ]);
  });

  it('deduplicates a completed background agent with no toolUseId or prompt on the live task', () => {
    const messages = [
      {
        id: 'tools',
        role: 'tool_group',
        tools: [
          {
            callId: 'call-agent-1',
            toolName: 'agent',
            title: 'Agent: Fix lint errors',
            status: 'completed',
            args: {
              description: 'Fix lint errors',
              prompt: 'Fix all lint errors in src/',
              run_in_background: true,
            },
            rawOutput: {
              type: 'task_execution',
              status: 'completed',
            },
          },
        ],
      },
      {
        id: 'agent-notification',
        role: 'system',
        content: 'background agent completed',
        variant: 'info',
        source: 'background_notification',
        data: {
          kind: 'agent',
          taskId: 'general-purpose-internal-2',
          status: 'completed',
        },
      },
    ] satisfies Message[];
    const liveTask = {
      kind: 'agent' as const,
      id: 'general-purpose-internal-2',
      label: 'general-purpose: Fix lint errors',
      description: 'Fix lint errors',
      status: 'completed' as const,
      startTime: 1,
      runtimeMs: 1,
      isBackgrounded: true,
    };

    expect(getEnvironmentAgentTasks(messages, [liveTask])).toMatchObject([
      {
        id: 'general-purpose-internal-2',
        label: 'Fix lint errors',
        status: 'completed',
      },
    ]);
  });

  it('does not collapse two agents that share a description when one is linked precisely', () => {
    const messages = [
      {
        id: 'tools',
        role: 'tool_group',
        tools: [
          {
            callId: 'call-A',
            toolName: 'agent',
            title: 'Agent: Review code',
            status: 'completed',
            args: { description: 'Review code', run_in_background: true },
            rawOutput: { type: 'task_execution', status: 'completed' },
          },
          {
            callId: 'call-B',
            toolName: 'agent',
            title: 'Agent: Review code',
            status: 'completed',
            args: { description: 'Review code', run_in_background: true },
            rawOutput: { type: 'task_execution', status: 'completed' },
          },
        ],
      },
    ] satisfies Message[];
    // The precisely-linked task is listed first so a loose description fallback
    // would steal it before reaching the orphaned one.
    const linkedTask = {
      kind: 'agent' as const,
      id: 'task-B',
      label: 'Review code',
      description: 'Review code',
      status: 'completed' as const,
      startTime: 1,
      runtimeMs: 1,
      isBackgrounded: true,
      toolUseId: 'call-B',
    };
    const orphanTask = {
      kind: 'agent' as const,
      id: 'task-A',
      label: 'Review code',
      description: 'Review code',
      status: 'completed' as const,
      startTime: 1,
      runtimeMs: 1,
      isBackgrounded: true,
    };

    const result = getEnvironmentAgentTasks(messages, [linkedTask, orphanTask]);
    expect(result).toHaveLength(2);
    expect(result).toMatchObject([
      { id: 'task-A', description: 'Review code', status: 'completed' },
      { id: 'task-B', description: 'Review code', status: 'completed' },
    ]);
  });

  it('lists two precisely-linked agents that share a description once each', () => {
    const messages = [
      {
        id: 'tools',
        role: 'tool_group',
        tools: [
          {
            callId: 'call-A',
            toolName: 'agent',
            title: 'Agent: Review code',
            status: 'completed',
            args: { description: 'Review code', run_in_background: true },
            rawOutput: { type: 'task_execution', status: 'completed' },
          },
          {
            callId: 'call-B',
            toolName: 'agent',
            title: 'Agent: Review code',
            status: 'completed',
            args: { description: 'Review code', run_in_background: true },
            rawOutput: { type: 'task_execution', status: 'completed' },
          },
        ],
      },
    ] satisfies Message[];
    const taskA = {
      kind: 'agent' as const,
      id: 'task-A',
      label: 'Review code',
      description: 'Review code',
      status: 'completed' as const,
      startTime: 1,
      runtimeMs: 1,
      isBackgrounded: true,
      toolUseId: 'call-A',
    };
    const taskB = {
      kind: 'agent' as const,
      id: 'task-B',
      label: 'Review code',
      description: 'Review code',
      status: 'completed' as const,
      startTime: 1,
      runtimeMs: 1,
      isBackgrounded: true,
      toolUseId: 'call-B',
    };

    const result = getEnvironmentAgentTasks(messages, [taskA, taskB]);
    expect(result).toHaveLength(2);
    expect(result).toMatchObject([{ id: 'task-A' }, { id: 'task-B' }]);
  });
});

function renderApp(props: React.ComponentProps<typeof App> = {}): {
  container: HTMLElement;
  rerender: (nextProps?: React.ComponentProps<typeof App>) => void;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const doRender = (nextProps: React.ComponentProps<typeof App> = props) => {
    act(() => {
      root.render(
        <App sidebar={{ enabled: true }} header={{}} {...nextProps} />,
      );
    });
  };
  doRender(props);
  const entry = { root, container };
  mounted.push(entry);
  const unmount = () => {
    const index = mounted.indexOf(entry);
    if (index >= 0) mounted.splice(index, 1);
    act(() => root.unmount());
    container.remove();
  };
  return { container, rerender: doRender, unmount };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function clickSubmit(container: HTMLElement): Promise<void> {
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('[data-testid="submit"]')
      ?.click();
    await Promise.resolve();
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => res(value as T | PromiseLike<T>);
    reject = rej;
  });
  return { promise, resolve, reject };
}

function skillCommandFixture(name: string, description: string) {
  return {
    name,
    description,
    source: 'skill',
    raw: {
      name,
      description,
      input: null,
      _meta: { source: 'skill' },
    },
  };
}

function emitSkillMutation(
  id: string,
  skills: Array<{ name: string; enabled: boolean }>,
  activation: 'applied' | 'deferred' | 'partial' = 'partial',
  sessionsRefreshed = activation === 'applied' ? 1 : 0,
): void {
  const mutation = {
    id,
    kind: 'skill_toggle' as const,
    skills,
    activation,
    sessionsRefreshed,
    sessionsFailed: activation === 'partial' ? 1 : 0,
  };
  const cwd = mockConnection.workspaceCwd;
  const previousByCwd = testState.workspaceEventSignals.skillMutationsByCwd;
  const existing = previousByCwd?.[cwd] ?? [];
  testState.workspaceEventSignals = {
    ...testState.workspaceEventSignals,
    skillsVersion: testState.workspaceEventSignals.skillsVersion + 1,
    lastSkillMutation: mutation,
    skillMutationsByCwd: {
      ...previousByCwd,
      [cwd]: existing.some((entry) => entry.id === mutation.id)
        ? existing
        : [...existing, mutation],
    },
  };
}

function emitPartialSkillMutation(
  id: string,
  skills: Array<{ name: string; enabled: boolean }>,
): void {
  emitSkillMutation(id, skills, 'partial');
}

async function triggerAutoRecap(): Promise<{
  recap: ReturnType<
    typeof deferred<{ sessionId: string; recap: string | null }>
  >;
  container: HTMLElement;
  rerender: (nextProps?: React.ComponentProps<typeof App>) => void;
}> {
  const recap = deferred<{ sessionId: string; recap: string | null }>();
  mockSessionActions.recapSession.mockReturnValueOnce(recap.promise);
  testState.blocks = [{}, {}, {}, {}];
  let hidden = true;
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  });
  let now = 1;
  vi.spyOn(Date, 'now').mockImplementation(() => now);

  const { container, rerender } = renderApp();
  await flush();
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  now += 3 * 60 * 1000;
  hidden = false;
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(mockSessionActions.recapSession).toHaveBeenCalledOnce();
  return { recap, container, rerender };
}

// A transcript block shaped like extractPendingPermission() expects. Defaults to
// a non-AskUserQuestion tool (→ pendingToolApproval); pass toolName
// 'ask_user_question' to exercise the pendingAskUserApproval branch instead.
// isAskUserPermission() classifies by rawInput.questions being a non-empty
// array, so the ask-user variant carries a toolCall.input.questions payload
// (getPermissionRawInput reads toolCall.input) — a bare toolName isn't enough.
function makePendingPermissionBlock(
  overrides: {
    resolved?: boolean;
    toolName?: string;
    kind?: string;
    todoPlan?: { planId: string; sourceCallId: string };
    options?: Array<{
      optionId: string;
      label: string;
      raw: Record<string, unknown>;
    }>;
    content?: unknown[];
  } = {},
): unknown {
  const toolName = overrides.toolName ?? 'run_shell_command';
  const isAskUser = toolName === 'ask_user_question';
  return {
    kind: 'permission',
    resolved: overrides.resolved ?? false,
    requestId: 'req-1',
    sessionId: 'session-1',
    title: 'Run ls',
    toolCall: {
      toolCallId: 'tc-1',
      kind: overrides.kind ?? (isAskUser ? 'other' : 'execute'),
      _meta: {
        toolName,
        ...(overrides.todoPlan ? { qwenTodoApproval: overrides.todoPlan } : {}),
      },
      ...(overrides.content ? { content: overrides.content } : {}),
      ...(isAskUser
        ? { input: { questions: [{ question: 'Pick one', options: [] }] } }
        : {}),
    },
    options: overrides.options ?? [
      { optionId: 'proceed_once', label: 'Allow', raw: {} },
      { optionId: 'cancel', label: 'Reject', raw: {} },
    ],
  };
}

beforeEach(() => {
  // Split persistence uses sessionStorage; clear it so one test's split doesn't
  // auto-restore into the next test's App mount.
  try {
    sessionStorage.clear();
    window.localStorage?.removeItem('qwen-code-web-shell-chat-width');
  } catch {
    // Web storage may be unavailable under storage-disabled jsdom contexts.
  }
  mockReleaseWebTerminal.mockReset();
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => false,
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    // Query-aware: report a large screen (min-width matches) so the Session
    // Overview entry point is available, while keeping the mobile (max-width)
    // query false as the other tests expect.
    value: vi.fn().mockImplementation((query: string) => ({
      matches: typeof query === 'string' && query.includes('min-width'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  mockConnection.sessionId = 'session-1';
  mockConnection.sessionContext = undefined;
  mockConnection.context = undefined;
  mockConnection.workspaceCwd = '/tmp/project';
  mockConnection.status = 'connected';
  mockConnection.displayName = 'Session One';
  mockConnection.titleSource = undefined;
  mockConnection.currentMode = 'default';
  mockConnection.currentModel = 'qwen';
  mockConnection.models = [{ id: 'qwen', label: 'Qwen' }];
  mockConnection.error = undefined;
  mockConnection.errorStatus = undefined;
  mockConnection.missingSession = false;
  mockConnection.sessionContext = undefined;
  mockConnection.commands = [];
  mockConnection.skills = [];
  mockConnection.loadingTranscript = false;
  mockConnection.catchingUp = false;
  mockConnection.capabilities = {
    qwenCodeVersion: '1.2.3',
    features: [],
  };
  mockConnection.gitBranch = undefined;
  mockConnection.gitStatus = undefined;
  // A loaded session always carries a Goal snapshot; tests that exercise the
  // hydration window (goalState still unknown) set it back to undefined.
  mockConnection.goalState = { v: 2, activity: 'idle', goal: null };
  mockConnection.standaloneSession = undefined;
  testState.ownerVersion = 0;
  testState.workspaceEventSignals = {
    artifactsVersion: 0,
    extensionsVersion: 0,
    skillsVersion: 0,
    lastSkillMutation: undefined,
    skillMutationsByCwd: undefined,
  };
  mockWorkspace.capabilities = {
    workspaces: [{ id: 'primary', cwd: '/workspace', primary: true }],
  };
  mockWorkspace.status = 'connected';
  mockWorkspace.refreshCapabilities.mockReset();
  mockWorkspace.refreshCapabilities.mockResolvedValue(
    mockWorkspace.capabilities,
  );
  mockWorkspace.client.workspaceByCwd.mockReset();
  mockWorkspace.client.workspaceByCwd.mockImplementation(() => ({
    workspaceGit: vi.fn().mockResolvedValue({ branch: 'main' }),
    workspaceSkills: mockWorkspaceActions.loadSkillsStatus,
    workspaceGitHubPullRequests: vi.fn().mockResolvedValue({
      v: 1,
      workspaceCwd: '/workspace',
      available: true,
      pullRequests: [],
    }),
  }));
  mockWorkspace.client.workspaceById.mockClear();
  mockWorkspace.client.sessionStatus.mockReset();
  mockWorkspace.client.sessionStatus.mockResolvedValue({
    workspaceCwd: '/tmp/project',
  });
  mockWorkspace.client.startLive.mockReset();
  mockWorkspace.client.startLive.mockResolvedValue({
    v: 1,
    available: true,
    state: 'listening',
    shortcut: 'Command+Q',
  });
  mockWorkspace.client.getStandaloneSession.mockReset();
  mockWorkspace.client.getStandaloneSession.mockResolvedValue({
    sessionId: 'session-1',
    sourceType: 'standalone',
    context: { kind: 'standalone' },
    isArchived: false,
  });
  mockWorkspace.client.listWorkspaceSessions.mockReset();
  mockWorkspace.client.listWorkspaceSessions.mockResolvedValue([]);
  mockWorkspace.client.createSideTaskSession.mockReset();
  mockWorkspace.client.createSideTaskSession.mockImplementation(
    () => new Promise(() => undefined),
  );
  mockWorkspace.client.detachSession.mockReset();
  mockWorkspace.client.detachSession.mockResolvedValue(undefined);
  mockWorkspace.client.renameStandaloneSession.mockReset();
  mockWorkspace.client.renameStandaloneSession.mockResolvedValue(undefined);
  mockWorkspace.client.unarchiveStandaloneSessions.mockReset();
  mockWorkspace.client.unarchiveStandaloneSessions.mockResolvedValue({
    unarchived: [],
    alreadyActive: [],
    notFound: [],
    errors: [],
  });
  mockWorkspace.client.repairStandaloneSessionDirectory.mockReset();
  mockWorkspace.client.repairStandaloneSessionDirectory.mockResolvedValue(
    undefined,
  );
  for (const method of Object.values(sessionCatalogController)) {
    method.mockReset();
  }
  mockWorkspace.client.resolveSubagentSession.mockReset();
  mockWorkspace.client.resolveSubagentSession.mockRejectedValue(
    new Error('Subagent details unavailable'),
  );
  testState.prompt = 'hello';
  testState.inputAnnotations = undefined;
  testState.promptImages = undefined;
  testState.streamingState = 'idle';
  testState.sessionHasActivePrompt = false;
  testState.blocks = [];
  testState.liveBlocks = undefined;
  testState.snapshotCallOptions = [];
  testState.messages = [];
  testState.streamingTailMessages = undefined;
  testState.queuedPromptHoldHistory = [];
  testState.queuedPromptStreamingState = 'idle';
  testState.queuedPromptSessionHasActivePrompt = false;
  testState.chatEditorRenderCount = 0;
  testState.latestChatEditorProps = null;
  testState.onChatEditorLayout = null;
  testState.latestToastHostElevated = false;
  testState.latestStatusBarTasks = null;
  testState.latestStatusBarOnOpenTasks = null;
  testState.latestStatusBarHideSettings = false;
  testState.latestMessageListProps = null;
  testState.latestBtwMessageProps = null;
  testState.latestAddWorkspaceDialogProps = null;
  testState.latestSessionOverviewProps = null;
  testState.latestToolApprovalKeyboardActive = null;
  testState.toolApprovalKeyboardActiveHistory = [];
  testState.latestToolApprovalPlanTodos = [];
  testState.latestToolApprovalOnConfirm = null;
  testState.latestAskUserQuestionKeyboardActive = null;
  testState.askUserKeyboardActiveHistory = [];
  testState.latestTodoPanelTodos = [];
  testState.latestTodoPanelOnOpen = null;
  testState.latestTasksStatusProps = null;
  testState.latestAskUserQuestionOnError = null;
  testState.latestBackgroundTasksRefreshTrigger = null;
  testState.backgroundTasks = [];
  testState.latestMonitorDetailsOnOpen = null;
  testState.settings = [];
  testState.settingsLoading = false;
  testState.settingsReloading = false;
  testState.settingsError = undefined;
  testState.latestSettingsHookOptions = undefined;
  testState.latestProvidersHookOptions = undefined;
  testState.latestSettingsState = null;
  testState.latestSettingsInitialCategory = undefined;
  testState.latestModelManagement = null;
  testState.latestScheduledTasksProps = null;
  testState.latestGoalsProps = null;
  testState.latestSplitViewProps = null;
  rawEnqueuePrompt.mockClear();
  editorClear.mockClear();
  editorCommit.mockClear();
  editorFocus.mockClear();
  editorRestoreInputAnnotations.mockClear();
  editorInsertText.mockClear();
  mockStore.appendLocalUserMessage.mockReset();
  settingsReload.mockClear();
  settingsReload.mockResolvedValue(undefined);
  settingsSetValue.mockReset();
  settingsSetValue.mockResolvedValue(undefined);
  qualifiedWorkspaceSettings.mockReset();
  qualifiedWorkspaceSettings.mockResolvedValue({
    v: 1,
    settings: [],
  });
  rootWorkspaceProviders.mockReset();
  rootWorkspaceProviders.mockResolvedValue({
    v: 1,
    workspaceCwd: '/work/primary',
    initialized: true,
    providers: [],
  });
  qualifiedWorkspaceProviders.mockReset();
  qualifiedWorkspaceProviders.mockResolvedValue({
    v: 1,
    workspaceCwd: '/work/secondary',
    initialized: true,
    providers: [],
  });
  qualifiedSetWorkspaceSetting.mockReset();
  qualifiedSetWorkspaceSetting.mockResolvedValue({
    key: 'voiceModel',
    scope: 'workspace',
    value: 'fast-model-x',
    requiresRestart: false,
  });
  mockFollowup.clear.mockClear();
  for (const value of Object.values(mockSessionActions)) {
    if (typeof value === 'function' && 'mockClear' in value) value.mockClear();
  }
  mockSessionActions.sendPrompt.mockResolvedValue(undefined);
  mockSessionActions.btwSession.mockResolvedValue({ answer: 'side answer' });
  mockSessionActions.createSession.mockResolvedValue({
    sessionId: 'session-1',
  });
  mockSessionActions.attachSession.mockResolvedValue(undefined);
  mockSessionActions.clearSession.mockResolvedValue(undefined);
  mockSessionActions.releaseSession.mockResolvedValue(undefined);
  mockSessionActions.renameSession.mockResolvedValue(undefined);
  mockSessionActions.recapSession.mockResolvedValue({
    sessionId: 'session-1',
    recap: null,
  });
  mockSessionActions.loadSession.mockResolvedValue(undefined);
  mockSessionActions.reloadSession.mockResolvedValue(undefined);
  mockSessionActions.refreshCommands.mockResolvedValue(undefined);
  mockSessionActions.setModel.mockResolvedValue(undefined);
  mockSessionActions.setReasoningEffort.mockResolvedValue(undefined);
  mockSessionActions.setApprovalMode.mockResolvedValue(undefined);
  mockSessionActions.getRewindSnapshots.mockResolvedValue([]);
  mockSessionActions.rewindSession.mockResolvedValue(undefined);
  mockSessionActions.branchSession.mockResolvedValue({
    sessionId: 'branch-1',
    displayName: 'Historical branch',
    switchStarted: true,
  });
  mockSessionActions.submitPermission.mockResolvedValue(undefined);
  mockSessionActions.clearGoal.mockResolvedValue(undefined);
  mockSessionActions.getGoal.mockResolvedValue({
    snapshot: { v: 2, activity: 'idle', goal: null },
  });
  mockSessionActions.controlGoal.mockResolvedValue({
    snapshot: { v: 2, activity: 'idle', goal: null },
  });
  mockSessionActions.forkSession.mockResolvedValue({ launched: false });
  mockSessionActions.sendShellCommand.mockResolvedValue(undefined);
  mockSessionActions.cancel.mockResolvedValue(undefined);
  mockSessionActions.getStats.mockResolvedValue({});
  mockSessionActions.getContextUsage.mockResolvedValue({});
  mockSessionActions.readAttachment.mockResolvedValue({
    data: 'aGVsbG8=',
    mimeType: 'text/plain',
  });
  mockSessionActions.getTasks.mockResolvedValue({
    v: 1,
    sessionId: 'session-1',
    now: 1,
    tasks: [],
  });
  mockSessionActions.loadSession.mockResolvedValue(undefined);
  mockStore.reset.mockClear();
  mockStore.getSnapshot.mockClear();
  mockStore.dispatch.mockClear();
  mockWorkspaceActions.loadSkillsStatus.mockResolvedValue({ skills: [] });
  mockWorkspaceActions.readWorkspaceFile.mockReset();
  mockWorkspaceActions.readWorkspaceFile.mockResolvedValue({
    content: '',
    truncated: false,
  });
  mockWorkspaceActions.stat.mockReset();
  mockWorkspaceActions.stat.mockResolvedValue({
    kind: 'stat',
    path: '',
    type: 'file',
    sizeBytes: 0,
    modifiedMs: 0,
  });
  mockWorkspaceActions.loadProviders.mockResolvedValue({ current: null });
  mockWorkspaceActions.controlGoal.mockResolvedValue({
    snapshot: { v: 2, activity: 'idle', goal: null },
  });
  mockWorkspaceActions.loadPreflight.mockResolvedValue(null);
  mockWorkspaceActions.loadEnv.mockResolvedValue(null);
  mockCollectSystemInfo.mockImplementation(() => ({
    nodeVersion: '',
    npmVersion: '',
    authSource: '',
    platform: '',
    arch: '',
    sandbox: '',
    proxy: '',
    memoryUsage: '',
  }));
  mockWorkspaceActions.loadMcpStatus.mockResolvedValue({ servers: [] });
  mockWorkspaceActions.loadMcpTools.mockResolvedValue([]);
  mockWorkspaceActions.loadMcpResources.mockResolvedValue([]);
  mockWorkspaceActions.addWorkspace.mockReset();
  mockWorkspaceActions.addScratchWorkspace.mockReset();
  mockWorkspaceActions.suggestWorkspacePaths.mockReset();
  mockWorkspaceActions.pickWorkspaceDirectory.mockReset();
  mockWorkspaceActions.listScheduledTasks.mockReset();
  mockWorkspaceActions.updateScheduledTask.mockReset();
  mockWorkspaceActions.deleteScheduledTask.mockReset();
  mockWorkspaceActions.deleteModel.mockReset();
  mockWorkspaceActions.deleteModel.mockResolvedValue(undefined);
  mockMcp.initialize.mockClear();
  mockMcp.initialize.mockResolvedValue({ accepted: true });
  mockMcp.reloadConfig.mockClear();
  mockMcp.reloadConfig.mockResolvedValue({ accepted: true });
  mockMcp.reload.mockReset();
  mockMcp.loadTools.mockReset();
  mockMcp.loadResources.mockReset();
  mockMcp.restartServer.mockReset();
  mockMcp.restartServer.mockResolvedValue({
    serverName: 'server',
    restarted: true,
    durationMs: 1,
  });
  mockMcp.manageServer.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  const url = new URL(window.location.href);
  if (url.searchParams.has('view')) {
    url.searchParams.delete('view');
    window.history.replaceState(null, '', url);
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('App live transcript boundary', () => {
  it('renders and copies the projected live tail over the structural baseline', async () => {
    const writeText = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue();
    testState.prompt = '/copy';
    testState.blocks = [{ id: 'assistant', text: 'a' }];
    testState.liveBlocks = [
      { id: 'assistant', text: 'ab' },
      { id: 'tool', kind: 'tool' },
    ];
    testState.messages = [{ id: 'assistant', role: 'assistant', content: 'a' }];
    testState.streamingTailMessages = [
      { id: 'assistant', role: 'assistant', content: 'ab' },
    ];

    renderApp();
    await flush();

    expect(testState.latestMessageListProps?.messages).toMatchObject([
      { id: 'assistant', role: 'assistant', content: 'ab' },
    ]);
    expect(testState.latestMessageListProps?.transcriptBlockCount).toBe(2);
    expect(testState.snapshotCallOptions).toContainEqual({
      structuralOnly: true,
    });
    expect(testState.snapshotCallOptions).toContainEqual(undefined);

    await clickSubmit(document.body);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('ab'));
  });
});

describe('App global shortcuts', () => {
  it('keeps Ctrl+O suppressed after the compact toggle retirement', async () => {
    renderApp();

    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: 'o',
    });
    await act(async () => {
      window.dispatchEvent(event);
      await Promise.resolve();
    });

    // The toggle is gone, but the key must stay inert: without the global
    // preventDefault the browser's Open File dialog fires on Ctrl+O.
    expect(event.defaultPrevented).toBe(true);
    expect(settingsSetValue).not.toHaveBeenCalledWith(
      'workspace',
      'ui.compactMode',
      expect.anything(),
    );
  });

  it.each(['o', 'b'])('leaves Ctrl+%s to xterm', async (key) => {
    const { container } = renderApp();
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    document.body.append(host);
    const terminal = document.createElement('div');
    terminal.dataset['webTerminal'] = '';
    const input = document.createElement('textarea');
    terminal.append(input);
    shadow.append(terminal);
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      composed: true,
      ctrlKey: true,
      key,
    });
    const sidebar = container.querySelector('[data-testid="sidebar"]');
    const collapsed = sidebar?.getAttribute('data-collapsed');

    await act(async () => {
      input.dispatchEvent(event);
      await Promise.resolve();
    });

    expect(event.defaultPrevented).toBe(false);
    expect(sidebar?.getAttribute('data-collapsed')).toBe(collapsed);
    host.remove();
  });
});

describe('App plan todos', () => {
  it('gates the exit-plan workflow on the experimental setting', async () => {
    const approvedEntries = [
      {
        content: 'Prepare',
        status: 'completed',
        _meta: { qwenTodo: { id: 'prepare' } },
      },
      {
        content: 'Ship',
        status: 'pending',
        _meta: { qwenTodo: { id: 'ship', blockedBy: ['prepare'] } },
      },
    ];
    testState.messages = [
      {
        id: 'approved-plan',
        role: 'tool_group',
        tools: [
          {
            callId: 'todo-approved',
            toolName: 'todo_write',
            status: 'completed',
            rawOutput: {
              entries: approvedEntries,
              plan: { id: 'plan-1' },
            },
          },
        ],
      },
      { id: 'revision', role: 'user', content: 'Revise the wording' },
      {
        id: 'newer-plan',
        role: 'tool_group',
        tools: [
          {
            callId: 'todo-newer',
            toolName: 'todo_write',
            status: 'completed',
            rawOutput: {
              entries: [
                ...approvedEntries.map((entry) => ({
                  ...entry,
                  status: 'completed',
                })),
                {
                  content: 'Deploy',
                  status: 'pending',
                  _meta: { qwenTodo: { id: 'deploy' } },
                },
              ],
              plan: { id: 'plan-1' },
            },
          },
        ],
      },
    ];
    testState.blocks = [
      makePendingPermissionBlock({
        toolName: 'exit_plan_mode',
        kind: 'switch_mode',
        todoPlan: { planId: 'plan-1', sourceCallId: 'todo-approved' },
      }),
    ];

    const { rerender } = renderApp();
    await flush();

    expect(testState.latestToolApprovalPlanTodos).toEqual([]);

    testState.settings = [sessionWorkflowSetting()];
    rerender();
    await flush();

    expect(
      testState.latestToolApprovalPlanTodos.map((todo) => todo.id),
    ).toEqual(['prepare', 'ship']);
  });

  it('refreshes dependencies when only blockedBy changes', async () => {
    testState.messages = [
      {
        id: 'plan',
        role: 'plan',
        todos: [
          { id: 'prepare', content: 'Prepare', status: 'completed' },
          {
            id: 'ship',
            content: 'Ship',
            status: 'pending',
            blockedBy: ['prepare'],
          },
        ],
      },
    ];
    const { rerender } = renderApp();
    await flush();

    expect(testState.latestTodoPanelTodos[1]?.blockedBy).toEqual(['prepare']);

    testState.messages = [
      {
        id: 'plan',
        role: 'plan',
        todos: [
          { id: 'prepare', content: 'Prepare', status: 'completed' },
          {
            id: 'ship',
            content: 'Ship',
            status: 'pending',
            blockedBy: [],
          },
        ],
      },
    ];
    rerender();
    await flush();

    expect(testState.latestTodoPanelTodos[1]?.blockedBy).toEqual([]);
  });

  it('keeps ordinary Todos on the task details surface', async () => {
    testState.settings = [sessionWorkflowSetting()];
    testState.messages = [
      {
        id: 'completed-workflow',
        role: 'tool_group',
        tools: [
          {
            callId: 'workflow-todos',
            toolName: 'todo_write',
            status: 'completed',
            args: {
              todos: [
                { id: 'old-work', content: 'Old work', status: 'completed' },
              ],
            },
            rawOutput: {
              sessionWorkflow: true,
              plan: { id: 'old-plan' },
            },
          },
        ],
      },
      {
        id: 'plan',
        role: 'plan',
        todos: [{ id: 'work', content: 'Work', status: 'in_progress' }],
      },
      {
        id: 'agents',
        role: 'tool_group',
        tools: [
          {
            callId: 'agent-call',
            toolName: 'Agent',
            status: 'in_progress',
            args: { todo_id: 'work' },
          },
        ],
      },
    ];
    const { container } = renderApp();
    await flush();

    await act(async () => {
      testState.latestTodoPanelOnOpen?.();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="cockpit-page"]')).toBeNull();
    expect(
      container
        .querySelector('[data-testid="dialog-shell"]')
        ?.getAttribute('data-dialog-title'),
    ).toBe('Plan & tasks');
  });

  it('keeps the tasks dialog plain when Session Workflow is off', async () => {
    testState.messages = [
      {
        id: 'plan',
        role: 'plan',
        todos: [{ id: 'work', content: 'Work', status: 'in_progress' }],
      },
      {
        id: 'agents',
        role: 'tool_group',
        tools: [
          {
            callId: 'agent-call',
            toolName: 'Agent',
            status: 'in_progress',
            args: { todo_id: 'work' },
          },
        ],
      },
    ];
    const { container } = renderApp();
    await flush();

    await act(async () => {
      testState.latestStatusBarOnOpenTasks?.();
      await Promise.resolve();
    });

    expect(testState.latestTasksStatusProps?.planTodos).toEqual([]);
    expect(testState.latestTasksStatusProps?.agentTools).toEqual([]);
    expect(
      container
        .querySelector('[data-testid="dialog-shell"]')
        ?.getAttribute('data-dialog-title'),
    ).toBe('Background tasks');
  });

  it('routes the Todo panel entry through Workflow when enabled', async () => {
    testState.messages = [
      {
        id: 'plan',
        role: 'tool_group',
        tools: [
          {
            callId: 'todo-workflow',
            toolName: 'todo_write',
            status: 'completed',
            args: {
              todos: [
                {
                  id: 'prepare',
                  content: 'Prepare',
                  status: 'completed',
                },
                {
                  id: 'work',
                  content: 'Work',
                  status: 'in_progress',
                  blockedBy: ['prepare'],
                },
              ],
            },
            rawOutput: {
              sessionWorkflow: true,
              plan: { id: 'plan-1' },
            },
          },
        ],
      },
    ];
    const { container, rerender } = renderApp();
    await flush();

    expect(testState.latestTodoPanelOnOpen).not.toBeNull();

    testState.settings = [sessionWorkflowSetting()];
    rerender();
    await flush();

    await act(async () => {
      testState.latestTodoPanelOnOpen?.();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="cockpit-page"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="workflow-inspector"]'),
    ).not.toBeNull();
  });
});

describe('App session workflow', () => {
  it('keeps a direct cockpit route and normal approval fail-closed when disabled', async () => {
    testState.blocks = [makePendingPermissionBlock()];
    window.history.replaceState(null, '', '/?view=cockpit');

    const { container } = renderApp();
    await flush();

    expect(container.querySelector('[data-testid="cockpit-page"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="approval-overlay"]'),
    ).not.toBeNull();
    expect(new URLSearchParams(window.location.search).has('view')).toBe(false);

    window.history.pushState(null, '', '/?view=cockpit');
    act(() => window.dispatchEvent(new PopStateEvent('popstate')));
    expect(container.querySelector('[data-testid="cockpit-page"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="approval-overlay"]'),
    ).not.toBeNull();
  });

  it('keeps an arriving approval in Chat without a cockpit history loop', async () => {
    testState.settings = [sessionWorkflowSetting()];
    testState.messages = [
      {
        id: 'plan',
        role: 'tool_group',
        tools: [
          {
            callId: 'todo-workflow',
            toolName: 'todo_write',
            status: 'completed',
            args: {
              todos: [{ id: 'work', content: 'Work', status: 'in_progress' }],
            },
            rawOutput: {
              sessionWorkflow: true,
              plan: { id: 'plan-1' },
            },
          },
        ],
      },
    ];
    const { container, rerender } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-workflow"]')
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="workflow-inspector"]'),
    ).not.toBeNull();
    expect(new URLSearchParams(window.location.search).has('view')).toBe(false);

    const replaceState = vi.spyOn(window.history, 'replaceState');
    testState.blocks = [makePendingPermissionBlock()];
    rerender();
    await flush();

    expect(container.querySelector('[data-testid="cockpit-page"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="workflow-inspector"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="approval-overlay"]'),
    ).not.toBeNull();
    expect(new URLSearchParams(window.location.search).has('view')).toBe(false);
    expect(replaceState).not.toHaveBeenCalled();

    window.history.pushState(null, '', '/?view=cockpit');
    act(() => window.dispatchEvent(new PopStateEvent('popstate')));
    await flush();
    expect(container.querySelector('[data-testid="cockpit-page"]')).toBeNull();
    expect(new URLSearchParams(window.location.search).has('view')).toBe(false);
    expect(replaceState).toHaveBeenCalledOnce();

    act(() => testState.latestTodoPanelOnOpen?.());
    expect(container.querySelector('[data-testid="cockpit-page"]')).toBeNull();
  });

  it('leaves panel fullscreen before expanding the Workflow graph', async () => {
    testState.settings = [sessionWorkflowSetting()];
    testState.messages = [
      {
        id: 'plan',
        role: 'tool_group',
        tools: [
          {
            callId: 'todo-workflow',
            toolName: 'todo_write',
            status: 'completed',
            args: {
              todos: [{ id: 'work', content: 'Work', status: 'in_progress' }],
            },
            rawOutput: {
              sessionWorkflow: true,
              plan: { id: 'plan-1' },
            },
          },
        ],
      },
    ];
    const { container } = renderApp();
    await flush();

    act(() => testState.latestTodoPanelOnOpen?.());
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Fullscreen"]')
        ?.click();
      await Promise.resolve();
    });
    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).not.toBeNull();

    act(() => {
      Array.from(document.querySelectorAll('button'))
        .find((button) =>
          button.textContent?.includes('Expand dependency graph'),
        )
        ?.click();
    });

    expect(
      container.querySelector('[data-testid="cockpit-page"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[class*="artifactPanelFullscreen"]'),
    ).toBeNull();
  });

  it('keeps a Chat return path when the host hides the Chat header', async () => {
    testState.settings = [sessionWorkflowSetting()];
    testState.messages = [
      {
        id: 'plan',
        role: 'tool_group',
        tools: [
          {
            callId: 'todo-workflow',
            toolName: 'todo_write',
            status: 'completed',
            args: {
              todos: [{ id: 'work', content: 'Work', status: 'in_progress' }],
            },
            rawOutput: {
              sessionWorkflow: true,
              plan: { id: 'plan-1' },
            },
          },
        ],
      },
    ];
    const { container } = renderApp({ header: { items: [] } });
    await flush();
    editorFocus.mockClear();

    act(() => testState.latestTodoPanelOnOpen?.());
    expect(
      container.querySelector('[data-testid="workflow-inspector"]'),
    ).not.toBeNull();
    act(() => {
      Array.from(container.querySelectorAll('button'))
        .find((button) =>
          button.textContent?.includes('Expand dependency graph'),
        )
        ?.click();
    });
    expect(
      container.querySelector('[data-testid="cockpit-page"]'),
    ).not.toBeNull();
    const backToChat = container.querySelector<HTMLButtonElement>(
      '[data-testid="workflow-back-to-chat"]',
    );
    expect(document.activeElement).toBe(backToChat);

    act(() => {
      backToChat?.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="cockpit-page"]')).toBeNull();
    expect(new URLSearchParams(window.location.search).has('view')).toBe(false);
    expect(editorFocus).toHaveBeenCalled();
  });

  it('does not enter cockpit while settings are loading or after an error', async () => {
    testState.settingsLoading = true;
    window.history.replaceState(null, '', '/?view=cockpit');

    const { container, rerender } = renderApp();
    await flush();
    expect(container.querySelector('[data-testid="cockpit-page"]')).toBeNull();

    testState.settingsLoading = false;
    testState.settingsError = new Error('settings unavailable');
    rerender();
    await flush();

    expect(container.querySelector('[data-testid="cockpit-page"]')).toBeNull();
    expect(new URLSearchParams(window.location.search).has('view')).toBe(false);
  });

  it('keeps an established cockpit through a background settings revalidation', async () => {
    testState.settings = [sessionWorkflowSetting()];
    window.history.replaceState(null, '', '/?view=cockpit');

    const { container, rerender } = renderApp();
    await flush();
    expect(
      container.querySelector('[data-testid="cockpit-page"]'),
    ).not.toBeNull();

    // Any client of this workspace saving any setting bumps settingsVersion,
    // which reloads the resource: loading flips true while the last-known-good
    // status is retained. That must not evict the view or drop the deep link.
    testState.settingsReloading = true;
    rerender();
    await flush();

    expect(
      container.querySelector('[data-testid="cockpit-page"]'),
    ).not.toBeNull();
    expect(new URLSearchParams(window.location.search).get('view')).toBe(
      'cockpit',
    );

    testState.settingsReloading = false;
    rerender();
    await flush();

    expect(
      container.querySelector('[data-testid="cockpit-page"]'),
    ).not.toBeNull();
  });

  it('evicts an established cockpit when revalidation resolves disabled', async () => {
    testState.settings = [sessionWorkflowSetting()];
    window.history.replaceState(null, '', '/?view=cockpit');

    const { container, rerender } = renderApp();
    await flush();
    expect(
      container.querySelector('[data-testid="cockpit-page"]'),
    ).not.toBeNull();

    // The retaining walk above keeps the last-known-good flag through a
    // background reload; this is the reset walk: the reload RESOLVES with
    // the gate disabled (file edit, dotfile sync) while the cockpit is
    // open. The Chat/Workflow toggle hides when disabled, so nothing can
    // lead back in — the eviction must be automatic: unmount the view,
    // strip the deep link, and restore composer focus.
    editorFocus.mockClear();
    testState.settings = [];
    rerender();
    await flush();

    expect(container.querySelector('[data-testid="cockpit-page"]')).toBeNull();
    expect(new URLSearchParams(window.location.search).has('view')).toBe(false);
    expect(editorFocus).toHaveBeenCalled();
  });

  it('strips the cockpit deep link when a controlled host takes over the view', async () => {
    testState.settings = [sessionWorkflowSetting()];
    window.history.replaceState(null, '', '/?view=cockpit');

    const { container, rerender } = renderApp({
      sidebar: false,
      splitSessionIds: [],
    });
    await flush();
    expect(
      container.querySelector('[data-testid="cockpit-page"]'),
    ).not.toBeNull();

    // A controlled host taking over the view is a cockpit departure: the deep
    // link must be stripped the way every interactive departure does.
    rerender({ sidebar: false, splitSessionIds: ['s1'] });
    await flush();
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();
    expect(new URLSearchParams(window.location.search).has('view')).toBe(false);

    // When the host clears the split the app lands on chat — and stays
    // there, instead of the stale deep link snapping back to the Workflow view.
    rerender({ sidebar: false, splitSessionIds: [] });
    await flush();
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();
    expect(container.querySelector('[data-testid="cockpit-page"]')).toBeNull();
    expect(new URLSearchParams(window.location.search).has('view')).toBe(false);
  });

  it('strips a stale cockpit deep link when a controlled host takes over from chat', async () => {
    // While settings load the gate is unresolved, so the deep link cannot
    // enter the cockpit and the app stays on chat — the stale link survives.
    // The takeover must strip it anyway: if the single commit that resolves
    // the gate enabled also hands the view to the host, the later-declared
    // reopen effect would read the stale link in that same commit and
    // out-vote the host's split — the cockpit wins and the split never
    // renders.
    testState.settingsLoading = true;
    window.history.replaceState(null, '', '/?view=cockpit');

    const { container, rerender } = renderApp({
      sidebar: false,
      splitSessionIds: [],
    });
    await flush();
    expect(container.querySelector('[data-testid="cockpit-page"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();
    // Precondition: the stale link survives while the gate is unresolved.
    expect(new URLSearchParams(window.location.search).get('view')).toBe(
      'cockpit',
    );

    // One commit resolves the gate enabled AND hands the view to the host.
    testState.settingsLoading = false;
    testState.settings = [sessionWorkflowSetting()];
    rerender({ sidebar: false, splitSessionIds: ['s1'] });
    await flush();

    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="cockpit-page"]')).toBeNull();
    expect(new URLSearchParams(window.location.search).has('view')).toBe(false);
  });

  it('keeps the revision-bound plan approval in Chat', async () => {
    const approvedEntries = [
      {
        content: 'Prepare',
        status: 'completed',
        _meta: { qwenTodo: { id: 'prepare' } },
      },
      {
        content: 'Ship',
        status: 'pending',
        _meta: { qwenTodo: { id: 'ship', blockedBy: ['prepare'] } },
      },
    ];
    testState.messages = [
      {
        id: 'approved-plan',
        role: 'tool_group',
        tools: [
          {
            callId: 'todo-approved',
            toolName: 'todo_write',
            status: 'completed',
            rawOutput: {
              sessionWorkflow: true,
              entries: approvedEntries,
              plan: { id: 'plan-1' },
            },
          },
        ],
      },
      { id: 'revision', role: 'user', content: 'Revise the wording' },
      {
        id: 'newer-plan',
        role: 'tool_group',
        tools: [
          {
            callId: 'todo-newer',
            toolName: 'todo_write',
            status: 'completed',
            rawOutput: {
              sessionWorkflow: true,
              entries: [
                ...approvedEntries.map((entry) => ({
                  ...entry,
                  status: 'completed',
                })),
                {
                  content: 'Deploy',
                  status: 'pending',
                  _meta: { qwenTodo: { id: 'deploy' } },
                },
              ],
              plan: { id: 'plan-1' },
            },
          },
        ],
      },
    ];
    testState.blocks = [
      makePendingPermissionBlock({
        toolName: 'exit_plan_mode',
        kind: 'switch_mode',
        todoPlan: { planId: 'plan-1', sourceCallId: 'todo-approved' },
      }),
    ];

    const { container, rerender } = renderApp();
    await flush();

    expect(testState.latestToolApprovalPlanTodos).toEqual([]);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-split-view"]')
        ?.click();
      await Promise.resolve();
    });

    testState.settings = [sessionWorkflowSetting()];
    rerender();
    await flush();

    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();
    await act(async () => {
      container
        .querySelector('[data-testid="split-approval-notice"] button')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="approval-overlay"]'),
    ).not.toBeNull();
    expect(
      testState.latestToolApprovalPlanTodos.map((todo) => todo.id),
    ).toEqual(['prepare', 'ship']);
    expect(new URLSearchParams(window.location.search).has('view')).toBe(false);

    testState.blocks = [
      makePendingPermissionBlock({
        resolved: true,
        toolName: 'exit_plan_mode',
        kind: 'switch_mode',
        todoPlan: { planId: 'plan-1', sourceCallId: 'todo-approved' },
      }),
    ];
    rerender();
    await flush();
    expect(container.querySelector('[data-testid="cockpit-page"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="open-workflow"]'),
    ).not.toBeNull();
  });

  it('opens the inspector first and expands into a synchronized graph', async () => {
    testState.settings = [sessionWorkflowSetting()];
    testState.messages = [
      {
        id: 'plan',
        role: 'tool_group',
        tools: [
          {
            callId: 'todo-start',
            toolName: 'todo_write',
            status: 'completed',
            args: {
              todos: [
                {
                  id: 'prepare',
                  content: 'Prepare',
                  status: 'completed',
                },
                {
                  id: 'work',
                  content: 'Work',
                  status: 'in_progress',
                  blockedBy: ['prepare'],
                },
              ],
            },
            rawOutput: {
              sessionWorkflow: true,
              plan: { id: 'plan-1' },
            },
          },
        ],
      },
      {
        id: 'agents',
        role: 'tool_group',
        tools: [
          {
            callId: 'agent-call',
            toolName: 'Agent',
            title: 'Worker agent',
            status: 'in_progress',
            args: { todo_id: 'work', description: 'Inspect repository' },
          },
        ],
      },
    ];
    const { container } = renderApp();
    await flush();

    expect(testState.latestTodoPanelOnOpen).not.toBeNull();
    expect(
      container.querySelector('[data-testid="open-workflow"]'),
    ).not.toBeNull();

    await act(async () => {
      testState.latestTodoPanelOnOpen?.();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="cockpit-page"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="workflow-inspector"]')
        ?.textContent,
    ).toContain('Worker agent');
    expect(container.querySelector('[data-plan-node-id="work"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="chat-context-header"]'),
    ).not.toBeNull();
    expect(new URLSearchParams(window.location.search).has('view')).toBe(false);

    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) =>
          button.textContent?.includes('Expand dependency graph'),
        )
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="cockpit-page"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-plan-node-id="work"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="workflow-canvas-detail"]'),
    ).not.toBeNull();
    expect(new URLSearchParams(window.location.search).get('view')).toBe(
      'cockpit',
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-plan-node-id="prepare"]')
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="workflow-canvas-detail"]')
        ?.textContent,
    ).toContain('Prepare');

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="workflow-back-to-chat"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(new URLSearchParams(window.location.search).has('view')).toBe(false);
    expect(container.querySelector('[data-testid="cockpit-page"]')).toBeNull();
  });

  it('keeps the floating inspector drawer when expand is gated by a pending approval', async () => {
    // openCockpit() silently aborts while an approval overlay is active;
    // expandWorkflowGraph must not run its drawer-closing side effect
    // without the action, or the interactive workflow surface disappears
    // with no cockpit to show for it.
    const dockQuery = '(min-width: 1001px)';
    const dockChangeListeners = new Set<
      (event: { matches: boolean }) => void
    >();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === dockQuery ? false : query.includes('min-width'),
        media: query,
        addEventListener: vi.fn((type: string, handler: unknown) => {
          if (type === 'change' && query === dockQuery) {
            dockChangeListeners.add(
              handler as (event: { matches: boolean }) => void,
            );
          }
        }),
        removeEventListener: vi.fn((type: string, handler: unknown) => {
          if (type === 'change' && query === dockQuery) {
            dockChangeListeners.delete(
              handler as (event: { matches: boolean }) => void,
            );
          }
        }),
      })),
    });
    testState.settings = [sessionWorkflowSetting()];
    testState.messages = [
      {
        id: 'plan',
        role: 'tool_group',
        tools: [
          {
            callId: 'todo-workflow',
            toolName: 'todo_write',
            status: 'completed',
            args: {
              todos: [{ id: 'work', content: 'Work', status: 'in_progress' }],
            },
            rawOutput: {
              sessionWorkflow: true,
              plan: { id: 'plan-1' },
            },
          },
        ],
      },
    ];
    const { container, rerender } = renderApp();
    await flush();

    // Open the inspector while the panel floats in a drawer.
    await act(async () => {
      testState.latestTodoPanelOnOpen?.();
      await Promise.resolve();
    });
    await flush();
    const floatingDrawer = () =>
      document.querySelector(
        '[data-web-shell-portal-root] aside[aria-label="Right panel"]',
      );
    expect(floatingDrawer()).not.toBeNull();
    expect(
      document.querySelector('[data-testid="workflow-inspector"]'),
    ).not.toBeNull();

    // A permission request becomes pending; the drawer stays interactive.
    await act(async () => {
      testState.blocks = [makePendingPermissionBlock()];
      rerender();
      await Promise.resolve();
    });
    await flush();
    expect(
      document.querySelector('[data-testid="approval-overlay"]'),
    ).not.toBeNull();
    expect(floatingDrawer()).not.toBeNull();

    // The expand action is gated: the cockpit must not open, and the drawer
    // must not close as a side effect of the aborted action.
    await act(async () => {
      Array.from(document.querySelectorAll('button'))
        .find((button) =>
          button.textContent?.includes('Expand dependency graph'),
        )
        ?.click();
      await Promise.resolve();
    });
    await flush();
    expect(container.querySelector('[data-testid="cockpit-page"]')).toBeNull();
    expect(new URLSearchParams(window.location.search).has('view')).toBe(false);
    expect(floatingDrawer()).not.toBeNull();
    expect(
      document.querySelector('[data-testid="workflow-inspector"]'),
    ).not.toBeNull();
  });

  it('keeps the tasks dialog plain when Session Workflow is off', async () => {
    testState.messages = [
      {
        id: 'plan',
        role: 'plan',
        todos: [{ id: 'work', content: 'Work', status: 'in_progress' }],
      },
      {
        id: 'agents',
        role: 'tool_group',
        tools: [
          {
            callId: 'agent-call',
            toolName: 'Agent',
            status: 'in_progress',
            args: { todo_id: 'work' },
          },
        ],
      },
    ];
    const { container } = renderApp();
    await flush();

    await act(async () => {
      testState.latestTodoPanelOnOpen?.();
      await Promise.resolve();
    });

    expect(testState.latestTasksStatusProps?.planTodos).toEqual([]);
    expect(testState.latestTasksStatusProps?.agentTools).toEqual([]);
    expect(
      container
        .querySelector('[data-testid="dialog-shell"]')
        ?.getAttribute('data-dialog-title'),
    ).toBe('Background tasks');
  });

  it('keeps workflow agent tools mounted behind the tasks dialog', async () => {
    testState.settings = [sessionWorkflowSetting()];
    testState.messages = [
      {
        id: 'plan',
        role: 'tool_group',
        tools: [
          {
            callId: 'todo-workflow',
            toolName: 'todo_write',
            status: 'completed',
            args: {
              todos: [{ id: 'work', content: 'Work', status: 'in_progress' }],
            },
            rawOutput: {
              sessionWorkflow: true,
              plan: { id: 'plan-1' },
            },
          },
        ],
      },
      {
        id: 'agents',
        role: 'tool_group',
        tools: [
          {
            callId: 'agent-call',
            toolName: 'Agent',
            status: 'in_progress',
            args: { todo_id: 'work', description: 'Do the work' },
          },
        ],
      },
    ];
    const { container, rerender } = renderApp();
    await flush();

    act(() => testState.latestTodoPanelOnOpen?.());
    await flush();
    expect(
      container.querySelector('[data-testid="workflow-inspector"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Do the work');

    // A follow-up user message empties the floating plan while the tagged
    // session-workflow plan (and the inspector projecting it) stays.
    testState.messages = [
      ...testState.messages,
      { id: 'follow-up', role: 'user', content: 'Keep going' },
    ];
    rerender();
    await flush();

    await act(async () => {
      testState.latestStatusBarOnOpenTasks?.();
      await Promise.resolve();
    });
    await flush();

    expect(
      container.querySelector('[data-testid="dialog-shell"]'),
    ).not.toBeNull();
    // The dialog renders the floating plan, which is empty after the user
    // message, so it shows no agent tools.
    expect(testState.latestTasksStatusProps?.agentTools).toEqual([]);
    // The inspector behind the dialog must stay anchored to the workflow
    // plan and keep its linked subagent (R15-5).
    expect(
      container.querySelector('[data-testid="workflow-inspector"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Do the work');
  });
});

describe('App composer footer renderer', () => {
  it('passes composer state and keeps the header, composer, and footers ordered', async () => {
    const composerFooterProps: WebShellComposerToolbarRenderInfo[] = [];
    const ComposerFooter = (props: WebShellComposerToolbarRenderInfo) => {
      composerFooterProps.push(props);
      return <div data-testid="composer-footer">composer footer</div>;
    };
    const { container } = renderApp({
      renderComposerHeader: () => (
        <div data-testid="composer-header">composer header</div>
      ),
      renderComposerFooter: ComposerFooter,
      renderFooter: () => <div data-testid="shell-footer">shell footer</div>,
    });
    await flush();

    expect(composerFooterProps.at(-1)).toEqual({
      disabled: false,
      isRunning: false,
      currentMode: 'default',
      currentModel: 'qwen',
      sessionName: 'Session One',
    });

    const composer = container.querySelector('[data-web-shell-composer]');
    const composerHeader = container.querySelector(
      '[data-testid="composer-header"]',
    );
    const composerFooter = container.querySelector(
      '[data-testid="composer-footer"]',
    );
    const shellFooter = container.querySelector('[data-testid="shell-footer"]');

    expect(composer).not.toBeNull();
    expect(composerHeader?.parentElement?.nextElementSibling).toBe(composer);
    expect(composer?.nextElementSibling).toBe(composerFooter);
    expect(composerFooter?.parentElement).toBe(composer?.parentElement);
    expect(composer?.parentElement?.nextElementSibling).toBe(shellFooter);
  });

  it('updates composer footer state and renders it in the empty welcome state', async () => {
    const composerFooterProps: WebShellComposerToolbarRenderInfo[] = [];
    const ComposerFooter = (props: WebShellComposerToolbarRenderInfo) => {
      composerFooterProps.push(props);
      return <div data-testid="composer-footer" />;
    };
    const { container, rerender } = renderApp({
      renderComposerFooter: ComposerFooter,
    });
    await flush();

    testState.streamingState = 'responding';
    mockConnection.currentMode = 'plan';
    mockConnection.currentModel = 'qwen-next';
    mockConnection.displayName = 'Session Two';
    rerender({ renderComposerFooter: ComposerFooter });
    await flush();

    expect(composerFooterProps.at(-1)).toEqual({
      disabled: false,
      isRunning: true,
      currentMode: 'plan',
      currentModel: 'qwen-next',
      sessionName: 'Session Two',
    });

    mockConnection.catchingUp = true;
    rerender({ renderComposerFooter: ComposerFooter });
    await flush();

    // Catch-up no longer disables the composer (only a pending approval or
    // prompt preparation does).
    expect(composerFooterProps.at(-1)).toEqual({
      disabled: false,
      isRunning: true,
      currentMode: 'plan',
      currentModel: 'qwen-next',
      sessionName: 'Session Two',
    });

    mockConnection.catchingUp = false;
    testState.streamingState = 'idle';
    mockConnection.sessionId = undefined;
    mockConnection.displayName = undefined;
    rerender({ renderComposerFooter: ComposerFooter });
    await flush();

    expect(
      container.querySelector('[data-testid="composer-footer"]'),
    ).not.toBeNull();
    expect(composerFooterProps.at(-1)).toEqual({
      disabled: false,
      isRunning: false,
      currentMode: 'plan',
      currentModel: 'qwen-next',
      sessionName: undefined,
    });
  });

  it('does not add composer footer DOM when omitted or when the renderer returns null', async () => {
    const { container, rerender } = renderApp();
    await flush();

    const composer = container.querySelector('[data-web-shell-composer]');
    const composerChildren = Array.from(
      composer?.parentElement?.children ?? [],
    );
    expect(composer?.nextElementSibling).toBeNull();

    rerender({ renderComposerFooter: () => null });
    await flush();

    const nullComposer = container.querySelector('[data-web-shell-composer]');
    const nullComposerChildren = Array.from(
      nullComposer?.parentElement?.children ?? [],
    );
    expect(nullComposer?.nextElementSibling).toBeNull();
    expect(nullComposerChildren).toHaveLength(composerChildren.length);
    expect(
      nullComposerChildren.map((child) =>
        child.getAttribute('data-web-shell-composer'),
      ),
    ).toEqual(
      composerChildren.map((child) =>
        child.getAttribute('data-web-shell-composer'),
      ),
    );
  });
});

describe('App conversation indicator keep-alive (#9487)', () => {
  it('keeps the indicator mounted and composer running through a silent gap', async () => {
    const composerFooterProps: WebShellComposerToolbarRenderInfo[] = [];
    const ComposerFooter = (props: WebShellComposerToolbarRenderInfo) => {
      composerFooterProps.push(props);
      return <div data-testid="composer-footer" />;
    };
    const { container, rerender } = renderApp({
      renderComposerFooter: ComposerFooter,
    });
    await flush();

    expect(
      container.querySelector('[data-testid="streaming-status"]'),
    ).toBeNull();
    expect(composerFooterProps.at(-1)?.isRunning).toBe(false);

    // Silent mid-turn gap: streamingState is idle while the daemon still
    // reports the in-flight prompt.
    testState.sessionHasActivePrompt = true;
    rerender({ renderComposerFooter: ComposerFooter });
    await flush();

    const status = container.querySelector('[data-testid="streaming-status"]');
    expect(status).not.toBeNull();
    expect(status?.getAttribute('data-has-active-prompt')).toBe('true');
    expect(composerFooterProps.at(-1)?.isRunning).toBe(true);

    testState.sessionHasActivePrompt = false;
    rerender({ renderComposerFooter: ComposerFooter });
    await flush();

    expect(
      container.querySelector('[data-testid="streaming-status"]'),
    ).toBeNull();
    expect(composerFooterProps.at(-1)?.isRunning).toBe(false);
  });

  it('lets Escape cancel during a silent gap the daemon still owns', async () => {
    const { rerender } = renderApp();
    await flush();
    mockSessionActions.cancel.mockClear();

    const pressEscape = () => {
      act(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    };

    // Fully idle, no daemon prompt: Escape has nothing to cancel.
    pressEscape();
    pressEscape();
    expect(mockSessionActions.cancel).not.toHaveBeenCalled();

    testState.sessionHasActivePrompt = true;
    rerender();
    await flush();

    pressEscape(); // arm the two-press cancel
    pressEscape(); // confirm it
    expect(mockSessionActions.cancel).toHaveBeenCalled();
  });
});

describe('App shell command queueing', () => {
  it('skips prompt preparation for locally handled slash and shell commands', async () => {
    const prepareSubmit = vi.fn(async () => undefined);
    const onThemeChange = vi.fn();
    renderApp({ prepareSubmit, onThemeChange });
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('/help');
      testState.latestChatEditorProps?.onSubmit('/theme dark');
    });
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('!echo hello');
      await vi.waitFor(() => {
        expect(mockSessionActions.sendShellCommand).toHaveBeenCalledWith(
          'echo hello',
        );
      });
    });

    expect(onThemeChange).toHaveBeenCalledWith('dark');
    expect(prepareSubmit).not.toHaveBeenCalled();
  });

  it('lazily creates a session for ! shell commands in a new task', async () => {
    mockConnection.sessionId = undefined;
    mockSessionActions.createSession.mockImplementation(async () => {
      mockConnection.sessionId = 'session-1';
      return { sessionId: 'session-1' };
    });
    const onSessionChange = vi.fn();
    renderApp({ onSessionChange });
    await flush();

    let accepted: boolean | void;
    await act(async () => {
      accepted = testState.latestChatEditorProps?.onSubmit(
        '!echo hi',
        undefined,
        undefined,
        editorCommit,
      );
      await vi.waitFor(() => {
        expect(mockSessionActions.sendShellCommand).toHaveBeenCalledWith(
          'echo hi',
        );
      });
    });
    expect(accepted).toBe(false);
    expect(editorCommit).toHaveBeenCalled();
    expect(editorClear).not.toHaveBeenCalled();
    expect(mockSessionActions.createSession).toHaveBeenCalled();
    expect(onSessionChange).toHaveBeenCalledWith({
      type: 'submit',
      sessionId: 'session-1',
      prompt: '!echo hi',
      queued: false,
    });
  });

  it('runs the ! command in a new task even when the session-id render commits before attach resolves', async () => {
    mockConnection.sessionId = undefined;
    mockSessionActions.createSession.mockImplementation(async () => {
      // Mirrors the real createSession(): setConnection({ sessionId }) fires
      // synchronously before the promise resolves.
      mockConnection.sessionId = 'session-1';
      return { sessionId: 'session-1' };
    });
    // attachSession() is a further round-trip after the sessionId is already
    // live, so React commits + flushes effects in that window.
    let releaseAttach!: () => void;
    const attachGate = new Promise<void>((r) => {
      releaseAttach = r;
    });
    mockSessionActions.attachSession.mockReturnValue(attachGate);

    const { rerender } = renderApp({});
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit(
        '!echo hi',
        undefined,
        undefined,
        editorCommit,
      );
      await Promise.resolve();
    });

    // Commit the render carrying the new sessionId so the session-switch
    // effect fires — this is what the real useConnection context triggers.
    act(() => {
      rerender({});
    });
    await act(async () => {
      for (let i = 0; i < 5; i++) {
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    });

    // Resolve attachSession — the command must still execute.
    await act(async () => {
      releaseAttach();
      await Promise.resolve();
    });
    await act(async () => {
      for (let i = 0; i < 15; i++) {
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    });

    expect(mockSessionActions.sendShellCommand).toHaveBeenCalledWith('echo hi');
    expect(editorCommit).toHaveBeenCalled();
  });

  it('returns true and clears editor for ! commands with an existing session', async () => {
    renderApp({});
    await flush();
    let accepted: boolean | void;
    await act(async () => {
      accepted = testState.latestChatEditorProps?.onSubmit('!ls');
      await vi.waitFor(() => {
        expect(mockSessionActions.sendShellCommand).toHaveBeenCalledWith('ls');
      });
    });
    expect(accepted).toBe(true);
    expect(mockSessionActions.createSession).not.toHaveBeenCalled();
    expect(sessionCatalogController.invalidateWorkspace).toHaveBeenCalledWith(
      '/tmp/project',
    );
  });

  it('runs an idle shell command immediately while a Goal is active', async () => {
    mockConnection.goalState = activeGoalSnapshot('keep working');
    renderApp({});
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('!pwd');
      await vi.waitFor(() => {
        expect(mockSessionActions.sendShellCommand).toHaveBeenCalledWith('pwd');
      });
    });

    expect(rawEnqueuePrompt).not.toHaveBeenCalled();
  });

  it('blocks duplicate ! submission while session creation is in flight', async () => {
    mockConnection.sessionId = undefined;
    let resolveCreate!: () => void;
    const createDone = new Promise<void>((r) => {
      resolveCreate = r;
    });
    mockSessionActions.createSession.mockImplementation(() => {
      return createDone.then(() => {
        mockConnection.sessionId = 'session-1';
        return { sessionId: 'session-1' };
      });
    });
    renderApp({});
    await flush();

    let first: boolean | void;
    let second: boolean | void;
    await act(async () => {
      first = testState.latestChatEditorProps?.onSubmit('!git push');
      second = testState.latestChatEditorProps?.onSubmit('!git push');
      await Promise.resolve();
    });

    expect(first).toBe(false);
    expect(second).toBe(false);

    await act(async () => {
      resolveCreate();
      await vi.waitFor(() => {
        expect(mockSessionActions.sendShellCommand).toHaveBeenCalledTimes(1);
      });
    });

    expect(mockSessionActions.sendShellCommand).toHaveBeenCalledWith(
      'git push',
    );
  });

  it('releases isPreparing after session creation, not after command completion', async () => {
    mockConnection.sessionId = undefined;
    let resolveCreate!: () => void;
    const createDone = new Promise<void>((r) => {
      resolveCreate = r;
    });
    mockSessionActions.createSession.mockImplementation(() => {
      return createDone.then(() => {
        mockConnection.sessionId = 'session-1';
        return { sessionId: 'session-1' };
      });
    });
    let resolveCmd!: () => void;
    const cmdDone = new Promise<void>((r) => {
      resolveCmd = r;
    });
    mockSessionActions.sendShellCommand.mockReturnValue(cmdDone);
    renderApp({});
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('!npm run build');
      await Promise.resolve();
    });

    expect(testState.latestChatEditorProps?.isPreparing).toBe(true);

    // Resolve session creation — isPreparing must drop even though the
    // command is still running.
    await act(async () => {
      resolveCreate();
      await Promise.resolve();
    });

    expect(testState.latestChatEditorProps?.isPreparing).toBe(false);
    expect(mockSessionActions.sendShellCommand).toHaveBeenCalledWith(
      'npm run build',
    );

    // Clean up the pending command promise.
    await act(async () => {
      resolveCmd();
      await Promise.resolve();
    });
  });

  it('reports an error and skips the command when session creation fails', async () => {
    mockConnection.sessionId = undefined;
    mockSessionActions.createSession.mockRejectedValueOnce(
      new Error('no session'),
    );
    const onToast = vi.fn();
    renderApp({ onToast });
    await flush();

    let accepted: boolean | void;
    await act(async () => {
      accepted = testState.latestChatEditorProps?.onSubmit('!echo hi');
      await vi.waitFor(() => {
        expect(onToast).toHaveBeenCalledWith('error', expect.any(String));
      });
    });

    expect(accepted).toBe(false);
    expect(editorClear).not.toHaveBeenCalled();
    expect(mockSessionActions.sendShellCommand).not.toHaveBeenCalled();
  });

  it('queues a ! command during a turn and drains it when the turn ends', async () => {
    const onToast = vi.fn();
    const { rerender } = renderApp({ onToast });
    await flush();

    act(() => {
      testState.streamingState = 'responding';
      rerender({ onToast });
    });

    let accepted: boolean | void;
    await act(async () => {
      accepted = testState.latestChatEditorProps?.onSubmit('!echo queued');
      await Promise.resolve();
    });

    expect(accepted).toBe(true);
    expect(mockSessionActions.sendShellCommand).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenCalledWith('info', expect.any(String));

    act(() => {
      testState.streamingState = 'idle';
      rerender({ onToast });
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(mockSessionActions.sendShellCommand).toHaveBeenCalledWith(
          'echo queued',
        );
      });
    });
  });

  it('drops queued ! commands when the session changes', async () => {
    const onToast = vi.fn();
    const { rerender } = renderApp({ onToast });
    await flush();

    act(() => {
      testState.streamingState = 'responding';
      rerender({ onToast });
    });

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('!rm -rf build/');
      await Promise.resolve();
    });
    expect(mockSessionActions.sendShellCommand).not.toHaveBeenCalled();

    // Switch to a different, idle session in a single commit: the queue must be
    // wiped before the drain effect runs, so the command never reaches the new
    // session's daemon.
    act(() => {
      mockConnection.sessionId = 'session-2';
      testState.streamingState = 'idle';
      rerender({ onToast });
    });
    await flush();

    expect(mockSessionActions.sendShellCommand).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenCalledWith('warning', expect.any(String));
  });

  it('aborts remaining commands if the session changes mid-drain', async () => {
    const onToast = vi.fn();
    const { rerender } = renderApp({ onToast });
    await flush();

    let resolveFirst!: () => void;
    const firstDone = new Promise<void>((r) => {
      resolveFirst = r;
    });
    mockSessionActions.sendShellCommand
      .mockReturnValueOnce(firstDone)
      .mockResolvedValueOnce(undefined);

    act(() => {
      testState.streamingState = 'responding';
      rerender({ onToast });
    });

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('!first');
      testState.latestChatEditorProps?.onSubmit('!second');
      await Promise.resolve();
    });

    // Go idle — drain starts and blocks on the pending first command.
    act(() => {
      testState.streamingState = 'idle';
      rerender({ onToast });
    });
    await flush();

    expect(mockSessionActions.sendShellCommand).toHaveBeenCalledTimes(1);

    // Switch session while the first command is still running.
    act(() => {
      mockConnection.sessionId = 'session-2';
      rerender({ onToast });
    });

    // Resolve the first command — the second must NOT be dispatched.
    await act(async () => {
      resolveFirst();
      await Promise.resolve();
    });

    expect(mockSessionActions.sendShellCommand).toHaveBeenCalledTimes(1);
    expect(mockSessionActions.sendShellCommand).toHaveBeenCalledWith('first');
    expect(onToast).toHaveBeenCalledWith('warning', expect.any(String));
  });

  it('drops the whole queue when the drain bails, preserving FIFO integrity', async () => {
    const onToast = vi.fn();
    const { rerender } = renderApp({ onToast });
    await flush();

    let resolveA!: () => void;
    const aDone = new Promise<void>((r) => {
      resolveA = r;
    });
    mockSessionActions.sendShellCommand
      .mockReturnValueOnce(aDone)
      .mockResolvedValue(undefined);

    act(() => {
      testState.streamingState = 'responding';
      rerender({ onToast });
    });
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('!a');
      testState.latestChatEditorProps?.onSubmit('!b');
      await Promise.resolve();
    });

    act(() => {
      testState.streamingState = 'idle';
      rerender({ onToast });
    });
    await flush();
    expect(mockSessionActions.sendShellCommand).toHaveBeenCalledTimes(1);

    // User queues `c` while `a` is still running.
    act(() => {
      testState.streamingState = 'responding';
      rerender({ onToast });
    });
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('!c');
      await Promise.resolve();
    });
    act(() => {
      testState.streamingState = 'idle';
      rerender({ onToast });
    });
    await flush();

    mockConnection.status = 'disconnected';
    await act(async () => {
      resolveA();
      await Promise.resolve();
    });
    await flush();

    // Both `b` and `c` are dropped, and the user is told about both.
    expect(onToast).toHaveBeenCalledWith(
      'warning',
      '2 queued shell commands will not run.',
    );

    // Reconnecting must not resurrect `c` behind the already-dropped `b`.
    mockConnection.status = 'connected';
    act(() => {
      testState.streamingState = 'responding';
      rerender({ onToast });
    });
    act(() => {
      testState.streamingState = 'idle';
      rerender({ onToast });
    });
    await flush();
    await flush();

    expect(mockSessionActions.sendShellCommand).toHaveBeenCalledTimes(1);
    expect(mockSessionActions.sendShellCommand).toHaveBeenCalledWith('a');
  });

  it('preserves commands queued after cancel while a drain command is still running', async () => {
    const onToast = vi.fn();
    const { rerender } = renderApp({ onToast });
    await flush();

    let resolveA!: () => void;
    const aDone = new Promise<void>((r) => {
      resolveA = r;
    });
    mockSessionActions.sendShellCommand
      .mockReturnValueOnce(aDone)
      .mockResolvedValue(undefined);

    act(() => {
      testState.streamingState = 'responding';
      rerender({ onToast });
    });
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('!a');
      testState.latestChatEditorProps?.onSubmit('!b');
      await Promise.resolve();
    });

    // Go idle — drain starts, dispatches `a` (pending).
    act(() => {
      testState.streamingState = 'idle';
      rerender({ onToast });
    });
    await flush();
    expect(mockSessionActions.sendShellCommand).toHaveBeenCalledTimes(1);

    // User presses Stop while `a` is still running.
    await act(async () => {
      testState.latestChatEditorProps?.onCancel?.();
      await Promise.resolve();
    });

    // Queue `x` while `a` is still in flight.
    act(() => {
      testState.streamingState = 'responding';
      rerender({ onToast });
    });
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('!x');
      await Promise.resolve();
    });

    // Resolve `a` — the stale drain bails but must NOT wipe `x`.
    await act(async () => {
      resolveA();
      await Promise.resolve();
    });

    act(() => {
      testState.streamingState = 'idle';
      rerender({ onToast });
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(mockSessionActions.sendShellCommand).toHaveBeenCalledTimes(2);
      });
    });

    expect(mockSessionActions.sendShellCommand).toHaveBeenNthCalledWith(1, 'a');
    expect(mockSessionActions.sendShellCommand).toHaveBeenNthCalledWith(2, 'x');
  });

  it('preserves commands queued after a session switch while a drain command is still running', async () => {
    const onToast = vi.fn();
    const { rerender } = renderApp({ onToast });
    await flush();

    let resolveA!: () => void;
    const aDone = new Promise<void>((r) => {
      resolveA = r;
    });
    mockSessionActions.sendShellCommand
      .mockReturnValueOnce(aDone)
      .mockResolvedValue(undefined);

    act(() => {
      testState.streamingState = 'responding';
      rerender({ onToast });
    });
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('!a');
      testState.latestChatEditorProps?.onSubmit('!b');
      await Promise.resolve();
    });

    // Go idle — drain starts, dispatches `a` (pending).
    act(() => {
      testState.streamingState = 'idle';
      rerender({ onToast });
    });
    await flush();
    expect(mockSessionActions.sendShellCommand).toHaveBeenCalledTimes(1);

    // Switch session while `a` is still running.
    act(() => {
      mockConnection.sessionId = 'session-2';
      rerender({ onToast });
    });

    // Queue `x` against the new session while `a` is still in flight.
    act(() => {
      testState.streamingState = 'responding';
      rerender({ onToast });
    });
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('!x');
      await Promise.resolve();
    });

    // Resolve `a` — the stale drain bails but must NOT wipe `x`.
    await act(async () => {
      resolveA();
      await Promise.resolve();
    });

    act(() => {
      testState.streamingState = 'idle';
      rerender({ onToast });
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(mockSessionActions.sendShellCommand).toHaveBeenCalledTimes(2);
      });
    });

    expect(mockSessionActions.sendShellCommand).toHaveBeenNthCalledWith(1, 'a');
    expect(mockSessionActions.sendShellCommand).toHaveBeenNthCalledWith(2, 'x');
  });

  it('drains multiple queued commands in FIFO order', async () => {
    const onToast = vi.fn();
    const { rerender } = renderApp({ onToast });
    await flush();

    act(() => {
      testState.streamingState = 'responding';
      rerender({ onToast });
    });

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('!aaa');
      testState.latestChatEditorProps?.onSubmit('!bbb');
      testState.latestChatEditorProps?.onSubmit('!ccc');
      await Promise.resolve();
    });

    act(() => {
      testState.streamingState = 'idle';
      rerender({ onToast });
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(mockSessionActions.sendShellCommand).toHaveBeenCalledTimes(3);
      });
    });

    expect(mockSessionActions.sendShellCommand).toHaveBeenNthCalledWith(
      1,
      'aaa',
    );
    expect(mockSessionActions.sendShellCommand).toHaveBeenNthCalledWith(
      2,
      'bbb',
    );
    expect(mockSessionActions.sendShellCommand).toHaveBeenNthCalledWith(
      3,
      'ccc',
    );
  });

  it('keeps draining when streamingState changes between commands', async () => {
    const onToast = vi.fn();
    const { rerender } = renderApp({ onToast });
    await flush();

    let resolveFirst!: () => void;
    const firstDone = new Promise<void>((r) => {
      resolveFirst = r;
    });
    mockSessionActions.sendShellCommand
      .mockReturnValueOnce(firstDone)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    act(() => {
      testState.streamingState = 'responding';
      rerender({ onToast });
    });

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('!first');
      testState.latestChatEditorProps?.onSubmit('!second');
      testState.latestChatEditorProps?.onSubmit('!third');
      await Promise.resolve();
    });

    // Go idle — drain starts and blocks on the pending first command.
    act(() => {
      testState.streamingState = 'idle';
      rerender({ onToast });
    });
    await flush();
    expect(mockSessionActions.sendShellCommand).toHaveBeenCalledTimes(1);

    // A running command drives streamingState non-idle and back to idle (as
    // sendShellCommand does via promptStatus). That must not cancel the drain.
    act(() => {
      testState.streamingState = 'responding';
      rerender({ onToast });
    });
    act(() => {
      testState.streamingState = 'idle';
      rerender({ onToast });
    });

    // Resolve the first command — the rest must still drain in FIFO order.
    await act(async () => {
      resolveFirst();
      await vi.waitFor(() => {
        expect(mockSessionActions.sendShellCommand).toHaveBeenCalledTimes(3);
      });
    });

    expect(mockSessionActions.sendShellCommand).toHaveBeenNthCalledWith(
      1,
      'first',
    );
    expect(mockSessionActions.sendShellCommand).toHaveBeenNthCalledWith(
      2,
      'second',
    );
    expect(mockSessionActions.sendShellCommand).toHaveBeenNthCalledWith(
      3,
      'third',
    );
  });

  it('does not drop queued commands when a new command is queued mid-drain', async () => {
    const onToast = vi.fn();
    const { rerender } = renderApp({ onToast });
    await flush();

    let resolveFirst!: () => void;
    const firstDone = new Promise<void>((r) => {
      resolveFirst = r;
    });
    mockSessionActions.sendShellCommand
      .mockReturnValueOnce(firstDone)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    act(() => {
      testState.streamingState = 'responding';
      rerender({ onToast });
    });

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('!aaa');
      testState.latestChatEditorProps?.onSubmit('!bbb');
      testState.latestChatEditorProps?.onSubmit('!ccc');
      await Promise.resolve();
    });

    // Go idle — drain starts and blocks on the pending first command.
    act(() => {
      testState.streamingState = 'idle';
      rerender({ onToast });
    });
    await flush();
    expect(mockSessionActions.sendShellCommand).toHaveBeenCalledTimes(1);

    // The running command drives streamingState non-idle; while it runs the
    // user queues another command, then streamingState returns to idle. That
    // idle transition must not start a competing drain that bumps the
    // generation and drops the still-pending batch.
    act(() => {
      testState.streamingState = 'responding';
      rerender({ onToast });
    });
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('!ddd');
      await Promise.resolve();
    });
    act(() => {
      testState.streamingState = 'idle';
      rerender({ onToast });
    });
    await flush();

    // Resolve the first command — the rest of the batch must still drain in
    // FIFO order, followed by the command queued mid-drain.
    await act(async () => {
      resolveFirst();
      await vi.waitFor(() => {
        expect(mockSessionActions.sendShellCommand).toHaveBeenCalledTimes(4);
      });
    });

    expect(mockSessionActions.sendShellCommand).toHaveBeenNthCalledWith(
      1,
      'aaa',
    );
    expect(mockSessionActions.sendShellCommand).toHaveBeenNthCalledWith(
      2,
      'bbb',
    );
    expect(mockSessionActions.sendShellCommand).toHaveBeenNthCalledWith(
      3,
      'ccc',
    );
    expect(mockSessionActions.sendShellCommand).toHaveBeenNthCalledWith(
      4,
      'ddd',
    );
  });

  it('continues draining after a command fails', async () => {
    const onToast = vi.fn();
    const { rerender } = renderApp({ onToast });
    await flush();

    mockSessionActions.sendShellCommand
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);

    act(() => {
      testState.streamingState = 'responding';
      rerender({ onToast });
    });

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('!fail');
      testState.latestChatEditorProps?.onSubmit('!ok');
      await Promise.resolve();
    });

    act(() => {
      testState.streamingState = 'idle';
      rerender({ onToast });
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(mockSessionActions.sendShellCommand).toHaveBeenCalledTimes(2);
      });
    });

    expect(mockSessionActions.sendShellCommand).toHaveBeenNthCalledWith(
      1,
      'fail',
    );
    expect(mockSessionActions.sendShellCommand).toHaveBeenNthCalledWith(
      2,
      'ok',
    );
    expect(onToast).toHaveBeenCalledWith('error', expect.any(String));
  });

  it('drops queued ! commands when the user cancels', async () => {
    const onToast = vi.fn();
    const { rerender } = renderApp({ onToast });
    await flush();

    act(() => {
      testState.streamingState = 'responding';
      rerender({ onToast });
    });

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('!rm -rf build/');
      await Promise.resolve();
    });
    expect(mockSessionActions.sendShellCommand).not.toHaveBeenCalled();

    // User presses Stop — the queue must be cleared before the turn goes idle.
    await act(async () => {
      testState.latestChatEditorProps?.onCancel?.();
      await Promise.resolve();
    });

    expect(onToast).toHaveBeenCalledWith('warning', expect.any(String));
    expect(mockSessionActions.cancel).toHaveBeenCalled();

    act(() => {
      testState.streamingState = 'idle';
      rerender({ onToast });
    });
    await flush();

    expect(mockSessionActions.sendShellCommand).not.toHaveBeenCalled();
  });

  it('stops draining remaining commands when the user cancels mid-drain', async () => {
    const onToast = vi.fn();
    const { rerender } = renderApp({ onToast });
    await flush();

    let resolveFirst!: () => void;
    const firstDone = new Promise<void>((r) => {
      resolveFirst = r;
    });
    mockSessionActions.sendShellCommand
      .mockReturnValueOnce(firstDone)
      .mockResolvedValueOnce(undefined);

    act(() => {
      testState.streamingState = 'responding';
      rerender({ onToast });
    });

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('!first');
      testState.latestChatEditorProps?.onSubmit('!second');
      await Promise.resolve();
    });

    // Go idle — drain starts and blocks on the pending first command.
    act(() => {
      testState.streamingState = 'idle';
      rerender({ onToast });
    });
    await flush();

    expect(mockSessionActions.sendShellCommand).toHaveBeenCalledTimes(1);

    // User presses Stop while the first command is still running.
    await act(async () => {
      testState.latestChatEditorProps?.onCancel?.();
      await Promise.resolve();
    });

    expect(mockSessionActions.cancel).toHaveBeenCalled();

    // Resolve the first command — the second must NOT be dispatched.
    await act(async () => {
      resolveFirst();
      await Promise.resolve();
    });

    expect(mockSessionActions.sendShellCommand).toHaveBeenCalledTimes(1);
    expect(mockSessionActions.sendShellCommand).toHaveBeenCalledWith('first');
  });

  it('does not drop queued commands when the UI language changes', async () => {
    const onToast = vi.fn();
    const { rerender } = renderApp({ onToast });
    await flush();

    act(() => {
      testState.streamingState = 'responding';
      rerender({ onToast });
    });

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('!deploy prod');
      await Promise.resolve();
    });
    expect(mockSessionActions.sendShellCommand).not.toHaveBeenCalled();

    // Change language mid-turn — the queue must survive.
    act(() => {
      rerender({ onToast, language: 'zh-CN' });
    });
    await flush();

    expect(mockSessionActions.sendShellCommand).not.toHaveBeenCalled();
    const warningCalls = onToast.mock.calls.filter(
      (c: unknown[]) => c[0] === 'warning',
    );
    expect(warningCalls).toHaveLength(0);

    // Turn ends — the queued command must still drain.
    act(() => {
      testState.streamingState = 'idle';
      rerender({ onToast, language: 'zh-CN' });
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(mockSessionActions.sendShellCommand).toHaveBeenCalledWith(
          'deploy prod',
        );
      });
    });
  });

  it('does not drain when the connection is not connected', async () => {
    const onToast = vi.fn();
    const { rerender } = renderApp({ onToast });
    await flush();

    act(() => {
      testState.streamingState = 'responding';
      rerender({ onToast });
    });

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('!echo hi');
      await Promise.resolve();
    });

    // Go idle but disconnect in the same commit.
    act(() => {
      mockConnection.status = 'disconnected';
      testState.streamingState = 'idle';
      rerender({ onToast });
    });
    await flush();

    expect(mockSessionActions.sendShellCommand).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenCalledWith('warning', expect.any(String));
  });

  it('does not resume a cancelled drain when a later drain starts', async () => {
    const onToast = vi.fn();
    const { rerender } = renderApp({ onToast });
    await flush();

    let resolveFirst!: () => void;
    const firstDone = new Promise<void>((r) => {
      resolveFirst = r;
    });
    mockSessionActions.sendShellCommand
      .mockReturnValueOnce(firstDone)
      .mockResolvedValueOnce(undefined);

    // Turn 1: queue two commands.
    act(() => {
      testState.streamingState = 'responding';
      rerender({ onToast });
    });
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('!A');
      testState.latestChatEditorProps?.onSubmit('!B');
      await Promise.resolve();
    });

    // Go idle — drain starts, dispatches A (pending).
    act(() => {
      testState.streamingState = 'idle';
      rerender({ onToast });
    });
    await flush();
    expect(mockSessionActions.sendShellCommand).toHaveBeenCalledTimes(1);

    // Cancel mid-drain — generation bumps, queue cleared.
    await act(async () => {
      testState.latestChatEditorProps?.onCancel?.();
      await Promise.resolve();
    });

    // Turn 2: queue a new command.
    act(() => {
      testState.streamingState = 'responding';
      rerender({ onToast });
    });
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('!C');
      await Promise.resolve();
    });

    // Go idle — new drain starts, dispatches C.
    act(() => {
      testState.streamingState = 'idle';
      rerender({ onToast });
    });
    await flush();
    expect(mockSessionActions.sendShellCommand).toHaveBeenCalledTimes(2);
    expect(mockSessionActions.sendShellCommand).toHaveBeenNthCalledWith(2, 'C');

    // Resolve A — the old drain must NOT dispatch B.
    await act(async () => {
      resolveFirst();
      await Promise.resolve();
    });

    expect(mockSessionActions.sendShellCommand).toHaveBeenCalledTimes(2);
  });

  it('skips sendShellCommand when the user cancels during session creation', async () => {
    mockConnection.sessionId = undefined;
    let resolveCreate!: () => void;
    const createDone = new Promise<void>((r) => {
      resolveCreate = r;
    });
    mockSessionActions.createSession.mockImplementation(() => {
      return createDone.then(() => {
        mockConnection.sessionId = 'session-1';
        return { sessionId: 'session-1' };
      });
    });
    renderApp({});
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('!deploy prod');
      await Promise.resolve();
    });

    expect(mockSessionActions.sendShellCommand).not.toHaveBeenCalled();

    // User presses Stop while session creation is still in flight.
    await act(async () => {
      testState.latestChatEditorProps?.onCancel?.();
      await Promise.resolve();
    });

    // Resolve session creation — the command must NOT execute.
    await act(async () => {
      resolveCreate();
      await Promise.resolve();
    });

    expect(mockSessionActions.sendShellCommand).not.toHaveBeenCalled();
  });

  it('allows new shell commands after cancel during session creation', async () => {
    mockConnection.sessionId = undefined;
    let resolveCreate!: () => void;
    const createDone = new Promise<void>((r) => {
      resolveCreate = r;
    });
    mockSessionActions.createSession.mockImplementation(() => {
      return createDone.then(() => {
        mockConnection.sessionId = 'session-1';
        return { sessionId: 'session-1' };
      });
    });
    renderApp({});
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('!deploy prod');
      await Promise.resolve();
    });

    // Cancel while session creation is in flight.
    await act(async () => {
      testState.latestChatEditorProps?.onCancel?.();
      await Promise.resolve();
    });

    // Resolve session creation — the cancelled command must not execute.
    await act(async () => {
      resolveCreate();
      await Promise.resolve();
    });
    expect(mockSessionActions.sendShellCommand).not.toHaveBeenCalled();

    // A new ! command must not be silently dropped.
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('!git status');
      await Promise.resolve();
    });

    expect(mockSessionActions.sendShellCommand).toHaveBeenCalledWith(
      'git status',
    );
  });

  it('runs a retry submitted while session creation is still in flight after cancel', async () => {
    mockConnection.sessionId = undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    mockSessionActions.createSession.mockImplementation(() =>
      gate.then(() => {
        mockConnection.sessionId = 'session-1';
        return { sessionId: 'session-1' };
      }),
    );
    renderApp({});
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('!a');
      await Promise.resolve();
    });
    await act(async () => {
      testState.latestChatEditorProps?.onCancel?.();
      await Promise.resolve();
    });
    // Retry while creation is STILL in flight — the only state in which
    // shellSubmitInFlightRef stays true unless handleCancel resets it.
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('!c');
      await Promise.resolve();
    });
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await flush();

    expect(mockSessionActions.sendShellCommand).toHaveBeenCalledWith('c');
  });

  it('skips sendShellCommand when the session changes during session creation', async () => {
    mockConnection.sessionId = undefined;
    let resolveCreate!: () => void;
    const createDone = new Promise<void>((r) => {
      resolveCreate = r;
    });
    mockSessionActions.createSession.mockImplementation(() => {
      return createDone.then(() => {
        mockConnection.sessionId = 'session-1';
        return { sessionId: 'session-1' };
      });
    });
    const { rerender } = renderApp({});
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('!rm -rf build/');
      await Promise.resolve();
    });

    expect(mockSessionActions.sendShellCommand).not.toHaveBeenCalled();

    // User switches workspace while session creation is still in flight.
    act(() => {
      mockConnection.sessionId = 'session-2';
      rerender({});
    });
    await flush();

    // Resolve session creation — the command must NOT execute against
    // the new session.
    await act(async () => {
      resolveCreate();
      await Promise.resolve();
    });

    expect(mockSessionActions.sendShellCommand).not.toHaveBeenCalled();
  });

  it('reports an error when sendShellCommand rejects with an existing session', async () => {
    mockSessionActions.sendShellCommand.mockRejectedValueOnce(
      new Error('daemon rejected'),
    );
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const onToast = vi.fn();
    renderApp({ onToast });
    await flush();

    let accepted: boolean | void;
    await act(async () => {
      accepted = testState.latestChatEditorProps?.onSubmit('!ls');
      await vi.waitFor(() => {
        expect(onToast).toHaveBeenCalledWith('error', expect.any(String));
      });
    });

    expect(accepted).toBe(true);
    expect(consoleError).toHaveBeenCalledWith(
      '[web-shell]',
      'daemon rejected',
      expect.anything(),
    );

    consoleError.mockRestore();
  });

  it('returns false for bare ! or whitespace-only ! commands', async () => {
    renderApp({});
    await flush();

    let accepted: boolean | void;
    await act(async () => {
      accepted = testState.latestChatEditorProps?.onSubmit('!');
      await Promise.resolve();
    });
    expect(accepted).toBe(false);

    await act(async () => {
      accepted = testState.latestChatEditorProps?.onSubmit('!   ');
      await Promise.resolve();
    });
    expect(accepted).toBe(false);

    expect(mockSessionActions.sendShellCommand).not.toHaveBeenCalled();
    expect(mockSessionActions.createSession).not.toHaveBeenCalled();
  });
});

describe('App read-only local commands mid-turn', () => {
  it('runs /stats immediately while streaming and skips the echo', async () => {
    const statsFixture: DaemonSessionStatsStatus = {
      v: 1,
      sessionId: 'session-1',
      workspaceCwd: '/tmp/project',
      sessionStartTimeMs: 1000,
      durationMs: 42000,
      promptCount: 2,
      models: {},
      tools: {
        totalCalls: 1,
        totalSuccess: 1,
        totalFail: 0,
        totalDurationMs: 120,
        byName: {},
      },
      files: { totalLinesAdded: 3, totalLinesRemoved: 1 },
      sources: [],
    };
    mockSessionActions.getStats.mockResolvedValue(statsFixture);
    const { rerender } = renderApp({});
    await flush();

    act(() => {
      testState.streamingState = 'responding';
      rerender({});
    });

    let accepted: boolean | void;
    await act(async () => {
      accepted = testState.latestChatEditorProps?.onSubmit('/stats');
      await vi.waitFor(() => {
        expect(mockSessionActions.getStats).toHaveBeenCalled();
      });
    });

    expect(accepted).toBe(true);
    expect(mockStore.appendLocalUserMessage).not.toHaveBeenCalled();
    expect(mockStore.dispatch).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'status',
        clearActiveText: false,
        text: serializeStatsMessage(statsFixture, 'overview'),
      }),
    ]);
  });

  it('echoes /stats when idle', async () => {
    renderApp({});
    await flush();

    let accepted: boolean | void;
    await act(async () => {
      accepted = testState.latestChatEditorProps?.onSubmit('/stats');
      await vi.waitFor(() => {
        expect(mockSessionActions.getStats).toHaveBeenCalled();
      });
    });

    expect(accepted).toBe(true);
    expect(mockStore.appendLocalUserMessage).toHaveBeenCalledWith('/stats');
  });

  it('runs /about immediately while streaming and skips the echo', async () => {
    const { rerender } = renderApp({});
    await flush();

    act(() => {
      testState.streamingState = 'responding';
      rerender({});
    });

    let accepted: boolean | void;
    await act(async () => {
      accepted = testState.latestChatEditorProps?.onSubmit('/about');
      await vi.waitFor(() => {
        expect(mockWorkspaceActions.loadPreflight).toHaveBeenCalled();
      });
    });

    expect(accepted).toBe(true);
    expect(mockStore.appendLocalUserMessage).not.toHaveBeenCalled();
    expect(mockStore.dispatch).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'status',
        clearActiveText: false,
        text: serializeStatusMessage({
          cliVersion: '1.2.3',
          runtime: '',
          platform: '',
          auth: '',
          baseUrl: '',
          model: 'qwen',
          fastModel: 'qwen',
          sessionId: 'session-1',
          sandbox: '',
          proxy: '',
          memoryUsage: '',
        }),
      }),
    ]);
  });

  it('echoes /about when idle', async () => {
    renderApp({});
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('/about');
      await vi.waitFor(() => {
        expect(mockWorkspaceActions.loadPreflight).toHaveBeenCalled();
      });
    });

    expect(mockStore.appendLocalUserMessage).toHaveBeenCalledWith('/about');
  });

  it('runs /status immediately while streaming and skips the echo', async () => {
    const { rerender } = renderApp({});
    await flush();

    act(() => {
      testState.streamingState = 'responding';
      rerender({});
    });

    let accepted: boolean | void;
    await act(async () => {
      accepted = testState.latestChatEditorProps?.onSubmit('/status');
      await vi.waitFor(() => {
        expect(mockWorkspaceActions.loadPreflight).toHaveBeenCalled();
      });
    });

    expect(accepted).toBe(true);
    expect(mockStore.appendLocalUserMessage).not.toHaveBeenCalled();
    expect(mockStore.dispatch).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'status',
        clearActiveText: false,
        text: serializeStatusMessage({
          cliVersion: '1.2.3',
          runtime: '',
          platform: '',
          auth: '',
          baseUrl: '',
          model: 'qwen',
          fastModel: 'qwen',
          sessionId: 'session-1',
          sandbox: '',
          proxy: '',
          memoryUsage: '',
        }),
      }),
    ]);
  });

  it('echoes /status when idle', async () => {
    renderApp({});
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('/status');
      await vi.waitFor(() => {
        expect(mockWorkspaceActions.loadPreflight).toHaveBeenCalled();
      });
    });

    expect(mockStore.appendLocalUserMessage).toHaveBeenCalledWith('/status');
  });

  it('runs /context immediately while streaming and skips the echo', async () => {
    const contextFixture: DaemonSessionContextUsageStatus = {
      v: 1,
      sessionId: 'session-1',
      workspaceCwd: '/tmp/project',
      usage: {
        modelName: 'qwen',
        totalTokens: 1234,
        contextWindowSize: 131072,
        breakdown: {
          systemPrompt: 500,
          builtinTools: 200,
          mcpTools: 0,
          memoryFiles: 50,
          skills: 0,
          messages: 584,
          freeSpace: 129738,
          autocompactBuffer: 0,
        },
        builtinTools: [{ name: 'read_file', tokens: 120 }],
        mcpTools: [],
        memoryFiles: [{ path: 'QWEN.md', tokens: 50 }],
        skills: [],
      },
      formattedText: 'Context usage: 1.2k / 131k tokens',
    };
    mockSessionActions.getContextUsage.mockResolvedValue(contextFixture);
    const { rerender } = renderApp({});
    await flush();

    act(() => {
      testState.streamingState = 'responding';
      rerender({});
    });

    let accepted: boolean | void;
    await act(async () => {
      accepted = testState.latestChatEditorProps?.onSubmit('/context');
      await vi.waitFor(() => {
        expect(mockSessionActions.getContextUsage).toHaveBeenCalled();
      });
    });

    expect(accepted).toBe(true);
    expect(mockStore.appendLocalUserMessage).not.toHaveBeenCalled();
    expect(mockStore.dispatch).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'status',
        clearActiveText: false,
        text: serializeContextUsageMessage(contextFixture),
      }),
    ]);
  });

  it('echoes /context when idle', async () => {
    renderApp({});
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('/context');
      await vi.waitFor(() => {
        expect(mockSessionActions.getContextUsage).toHaveBeenCalled();
      });
    });

    expect(mockStore.appendLocalUserMessage).toHaveBeenCalledWith('/context');
  });

  it('reports /stats load failures instead of swallowing them', async () => {
    renderApp({});
    await flush();

    mockSessionActions.getStats.mockRejectedValueOnce(
      new Error('stats unavailable'),
    );
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('/stats');
      await vi.waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith(
          '[web-shell]',
          expect.stringContaining('stats unavailable'),
          expect.anything(),
        );
      });
    });

    consoleError.mockRestore();
  });

  it('reports /about load failures instead of swallowing them', async () => {
    renderApp({});
    await flush();

    mockCollectSystemInfo.mockImplementationOnce(() => {
      throw new Error('status unavailable');
    });
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('/about');
      await vi.waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith(
          '[web-shell]',
          expect.stringContaining('status unavailable'),
          expect.anything(),
        );
      });
    });

    consoleError.mockRestore();
  });
});

describe('App session callbacks', () => {
  it('forwards an Assistant checkpoint and returns the pending branch request', async () => {
    const branch = deferred<{
      sessionId: string;
      displayName: string;
      switchStarted: boolean;
    }>();
    mockSessionActions.branchSession.mockReturnValue(branch.promise);
    renderApp();
    await flush();

    let request: void | Promise<void>;
    let duplicate: void | Promise<void>;
    act(() => {
      request =
        testState.latestMessageListProps?.onBranchSession?.('checkpoint-1');
      duplicate =
        testState.latestMessageListProps?.onBranchSession?.('checkpoint-1');
    });

    expect(mockSessionActions.branchSession).toHaveBeenCalledWith(
      undefined,
      'checkpoint-1',
    );
    expect(request!).toBeInstanceOf(Promise);
    expect(duplicate).toBe(request);
    expect(mockSessionActions.branchSession).toHaveBeenCalledTimes(1);

    branch.resolve({
      sessionId: 'branch-1',
      displayName: 'Historical branch',
      switchStarted: true,
    });
    await act(async () => {
      await request;
    });
    expect(mockStore.dispatch).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'status',
        text: expect.stringContaining('Historical branch') as string,
      }),
    ]);
  });

  it('does not report a concurrent branch request as a failure', async () => {
    const branch = deferred<{
      sessionId: string;
      displayName: string;
      switchStarted: boolean;
    }>();
    mockSessionActions.branchSession
      .mockReturnValueOnce(branch.promise)
      .mockRejectedValueOnce(
        new DOMException(
          'A branch request is already in progress',
          'InvalidStateError',
        ),
      );
    const onToast = vi.fn();
    renderApp({ onToast });
    await flush();

    let first: void | Promise<void>;
    let second: void | Promise<void>;
    act(() => {
      first =
        testState.latestMessageListProps?.onBranchSession?.('checkpoint-1');
      second =
        testState.latestMessageListProps?.onBranchSession?.('checkpoint-2');
    });

    await act(async () => {
      await second;
    });
    expect(onToast).not.toHaveBeenCalled();

    branch.resolve({
      sessionId: 'branch-1',
      displayName: 'Historical branch',
      switchStarted: true,
    });
    await act(async () => {
      await first;
    });
  });

  it('does not claim a late branch result switched sessions', async () => {
    mockSessionActions.branchSession.mockResolvedValue({
      sessionId: 'branch-1',
      displayName: 'Historical branch',
      switchStarted: false,
    });
    renderApp();
    await flush();

    await act(async () => {
      await testState.latestMessageListProps?.onBranchSession?.('checkpoint-1');
    });

    expect(mockStore.dispatch).not.toHaveBeenCalledWith([
      expect.objectContaining({ type: 'status' }),
    ]);
  });

  it('reloads the transcript when a historical checkpoint becomes stale', async () => {
    const { DaemonHttpError } = await import('@qwen-code/sdk/daemon');
    mockConnection.capabilities.features = ['session_transcript_pagination'];
    mockSessionActions.branchSession.mockRejectedValue(
      new DaemonHttpError(
        409,
        { code: 'branch_point_invalid' },
        'Invalid branch point',
      ),
    );
    const onToast = vi.fn();
    renderApp({ onToast });
    await flush();

    await act(async () => {
      await testState.latestMessageListProps?.onBranchSession?.(
        'stale-checkpoint',
      );
    });

    expect(mockSessionActions.branchSession).toHaveBeenCalledWith(
      undefined,
      'stale-checkpoint',
    );
    expect(mockSessionActions.reloadSession).toHaveBeenCalledWith(
      expect.any(AbortSignal),
    );
    expect(onToast).toHaveBeenCalledWith(
      'error',
      'This response is no longer on the active history path. The transcript has been refreshed.',
    );
  });

  it('does not reload an unrelated session when the branch source was switched away', async () => {
    const { DaemonHttpError } = await import('@qwen-code/sdk/daemon');
    mockConnection.capabilities.features = ['session_transcript_pagination'];
    let rejectBranch!: (error: unknown) => void;
    mockSessionActions.branchSession.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectBranch = reject;
      }),
    );
    const onToast = vi.fn();
    const { rerender } = renderApp({ onToast });
    await flush();

    let request: void | Promise<void>;
    act(() => {
      request =
        testState.latestMessageListProps?.onBranchSession?.('stale-checkpoint');
    });
    expect(mockSessionActions.branchSession).toHaveBeenCalledWith(
      undefined,
      'stale-checkpoint',
    );

    // The user switches to another session before the branch call returns.
    act(() => {
      mockConnection.sessionId = 'session-2';
      rerender({ onToast });
    });
    await flush();

    await act(async () => {
      rejectBranch(
        new DaemonHttpError(
          409,
          { code: 'branch_point_invalid' },
          'Invalid branch point',
        ),
      );
      await request;
    });

    expect(mockSessionActions.reloadSession).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenCalledWith('error', 'Failed to branch session.');
  });

  it('skips the stale-recovery toast when a switch lands during the reload', async () => {
    const { DaemonHttpError } = await import('@qwen-code/sdk/daemon');
    mockConnection.capabilities.features = ['session_transcript_pagination'];
    mockSessionActions.branchSession.mockRejectedValue(
      new DaemonHttpError(
        409,
        { code: 'branch_point_invalid' },
        'Invalid branch point',
      ),
    );
    let rejectReload!: (error: unknown) => void;
    mockSessionActions.reloadSession.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectReload = reject;
      }),
    );
    const onToast = vi.fn();
    const { rerender } = renderApp({ onToast });
    await flush();

    let request: void | Promise<void>;
    act(() => {
      request =
        testState.latestMessageListProps?.onBranchSession?.('stale-checkpoint');
    });
    await vi.waitFor(() =>
      expect(mockSessionActions.reloadSession).toHaveBeenCalled(),
    );

    // The user switches away while the recovery reload is in flight, and the
    // superseded load then rejects.
    act(() => {
      mockConnection.sessionId = 'session-2';
      rerender({ onToast });
    });
    await flush();

    await act(async () => {
      rejectReload(new DOMException('Session load superseded', 'AbortError'));
      await request;
    });

    expect(onToast).not.toHaveBeenCalledWith(
      'error',
      'This response is no longer on the active history path, and the transcript could not be refreshed. Please retry.',
    );
    expect(onToast).not.toHaveBeenCalledWith(
      'error',
      'This response is no longer on the active history path. The transcript has been refreshed.',
    );
  });

  it('binds the main composer Voice target to its active secondary session', async () => {
    mockConnection.workspaceCwd = '/work/secondary';
    mockWorkspace.capabilities = {
      workspaceCwd: '/work/primary',
      features: ['workspace_qualified_voice'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/work/primary',
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary',
          cwd: '/work/secondary',
          primary: false,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;

    renderApp();
    await flush();

    expect(testState.latestChatEditorProps?.voiceTarget).toMatchObject({
      route: 'workspace-qualified',
      cwd: '/work/secondary',
      selector: { kind: 'id', value: 'secondary' },
      sessionId: 'session-1',
      streamPath: 'workspaces/secondary/voice/stream',
    });
    expect(testState.latestChatEditorProps?.voiceStatusRevision).toEqual({
      user: 0,
      workspace: 0,
    });
  });

  it('keeps primary Voice model reads and writes on legacy routes', async () => {
    mockConnection.workspaceCwd = '/work/primary';
    mockWorkspace.capabilities = {
      workspaceCwd: '/work/primary',
      features: [],
      workspaces: [
        {
          id: 'primary',
          cwd: '/work/primary',
          primary: true,
          trusted: false,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const { container } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('/model --voice');
    });
    await flush();

    expect(rootWorkspaceProviders).toHaveBeenCalledOnce();
    expect(qualifiedWorkspaceProviders).not.toHaveBeenCalled();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="model-select"]')
        ?.click();
      await Promise.resolve();
    });

    expect(settingsSetValue).toHaveBeenCalledWith(
      'workspace',
      'voiceModel',
      'fast-model-x',
    );
    expect(qualifiedSetWorkspaceSetting).not.toHaveBeenCalled();
  });

  it('keeps the legacy pre-session Voice fallback out of git status', async () => {
    mockConnection.sessionId = undefined;
    mockWorkspace.capabilities = {
      workspaceCwd: '/workspace',
      features: ['voice_transcribe'],
    } as typeof mockWorkspace.capabilities;
    const workspaceGit = vi.fn().mockResolvedValue({ branch: 'main' });
    mockWorkspace.client.workspaceByCwd.mockImplementation(() => ({
      workspaceGit,
      workspaceSkills: mockWorkspaceActions.loadSkillsStatus,
    }));

    renderApp();
    await flush();

    expect(testState.latestChatEditorProps?.voiceTarget).toMatchObject({
      route: 'legacy-primary',
      cwd: '/workspace',
      streamPath: 'voice/stream',
    });
    expect(workspaceGit).not.toHaveBeenCalled();
  });

  it('uses qualified providers and workspace settings for secondary Voice models', async () => {
    mockConnection.workspaceCwd = '/work/secondary';
    mockWorkspace.capabilities = {
      workspaceCwd: '/work/primary',
      features: [
        'workspace_qualified_voice',
        'workspace_qualified_rest_core',
        'workspace_settings',
      ],
      workspaces: [
        {
          id: 'primary',
          cwd: '/work/primary',
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary',
          cwd: '/work/secondary',
          primary: false,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const { container } = renderApp();
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('/model --voice');
      await Promise.resolve();
    });

    expect(qualifiedWorkspaceProviders).toHaveBeenCalledOnce();
    expect(mockWorkspaceActions.loadProviders).not.toHaveBeenCalled();
    const select = container.querySelector<HTMLButtonElement>(
      '[data-testid="model-select"]',
    );
    expect(select).not.toBeNull();
    await act(async () => {
      select?.click();
      await Promise.resolve();
    });

    expect(qualifiedSetWorkspaceSetting).toHaveBeenCalledWith(
      'workspace',
      'voiceModel',
      'fast-model-x',
    );
    expect(settingsSetValue).not.toHaveBeenCalled();
  });

  it('never exposes the primary Voice setting while secondary settings load', async () => {
    mockConnection.workspaceCwd = '/work/secondary';
    mockWorkspace.capabilities = {
      workspaceCwd: '/work/primary',
      features: [
        'workspace_qualified_voice',
        'workspace_qualified_rest_core',
        'workspace_settings',
      ],
      workspaces: [
        {
          id: 'primary',
          cwd: '/work/primary',
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary',
          cwd: '/work/secondary',
          primary: false,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    testState.settings = [voiceSetting('primary-voice')];
    let resolveSettings: (status: {
      v: 1;
      settings: DaemonSettingDescriptor[];
    }) => void = () => undefined;
    qualifiedWorkspaceSettings.mockReturnValue(
      new Promise((resolve) => {
        resolveSettings = resolve;
      }),
    );
    const { container } = renderApp();
    await flush();
    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();

    expect(
      testState.latestSettingsState?.settings.find(
        (setting) => setting.key === 'voiceModel',
      ),
    ).toBeUndefined();

    await act(async () => {
      resolveSettings({
        v: 1,
        settings: [voiceSetting('secondary-voice')],
      });
      await Promise.resolve();
    });
    await flush();

    expect(
      testState.latestSettingsState?.settings.find(
        (setting) => setting.key === 'voiceModel',
      )?.values.effective,
    ).toBe('secondary-voice');
  });

  it('drops a provider failure after the Voice workspace changes', async () => {
    mockConnection.workspaceCwd = '/work/secondary-a';
    mockWorkspace.capabilities = {
      workspaceCwd: '/work/primary',
      features: [
        'workspace_qualified_voice',
        'workspace_qualified_rest_core',
        'workspace_settings',
      ],
      workspaces: [
        {
          id: 'primary',
          cwd: '/work/primary',
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary-a',
          cwd: '/work/secondary-a',
          primary: false,
          trusted: true,
        },
        {
          id: 'secondary-b',
          cwd: '/work/secondary-b',
          primary: false,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const providersResult = deferred();
    qualifiedWorkspaceProviders.mockReturnValue(providersResult.promise);
    const onToast = vi.fn();
    const { container, rerender } = renderApp({ onToast });
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('/model --voice');
      await Promise.resolve();
    });
    expect(qualifiedWorkspaceProviders).toHaveBeenCalledOnce();

    mockConnection.workspaceCwd = '/work/secondary-b';
    rerender();
    await flush();
    await act(async () => {
      providersResult.reject(new Error('old workspace failed'));
      await Promise.resolve();
    });

    expect(onToast).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="model-select"]')).toBeNull();
  });

  it('drops a stale provider success after an A to B to A workspace change', async () => {
    mockConnection.workspaceCwd = '/work/secondary-a';
    mockWorkspace.capabilities = {
      workspaceCwd: '/work/primary',
      features: [
        'workspace_qualified_voice',
        'workspace_qualified_rest_core',
        'workspace_settings',
      ],
      workspaces: [
        {
          id: 'primary',
          cwd: '/work/primary',
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary-a',
          cwd: '/work/secondary-a',
          primary: false,
          trusted: true,
        },
        {
          id: 'secondary-b',
          cwd: '/work/secondary-b',
          primary: false,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const providersResult = deferred<{
      v: 1;
      workspaceCwd: string;
      initialized: boolean;
      providers: never[];
    }>();
    qualifiedWorkspaceProviders.mockReturnValue(providersResult.promise);
    const { container, rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('/model --voice');
    });
    mockConnection.workspaceCwd = '/work/secondary-b';
    rerender();
    await flush();
    mockConnection.workspaceCwd = '/work/secondary-a';
    rerender();
    await flush();

    await act(async () => {
      providersResult.resolve({
        v: 1,
        workspaceCwd: '/work/secondary-a',
        initialized: true,
        providers: [],
      });
      await Promise.resolve();
    });
    await flush();

    expect(container.querySelector('[data-testid="model-select"]')).toBeNull();
  });

  it('drops a provider failure after the Web Shell unmounts', async () => {
    mockConnection.workspaceCwd = '/work/secondary';
    mockWorkspace.capabilities = {
      workspaceCwd: '/work/primary',
      features: [
        'workspace_qualified_voice',
        'workspace_qualified_rest_core',
        'workspace_settings',
      ],
      workspaces: [
        {
          id: 'primary',
          cwd: '/work/primary',
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary',
          cwd: '/work/secondary',
          primary: false,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const providersResult = deferred();
    qualifiedWorkspaceProviders.mockReturnValue(providersResult.promise);
    const onToast = vi.fn();
    const { unmount } = renderApp({ onToast });
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('/model --voice');
    });
    unmount();
    await act(async () => {
      providersResult.reject(new Error('late provider failure'));
      await Promise.resolve();
    });

    expect(onToast).not.toHaveBeenCalled();
  });

  it('closes an open Voice picker when its capability gate is lost', async () => {
    mockConnection.workspaceCwd = '/work/secondary';
    mockWorkspace.capabilities = {
      workspaceCwd: '/work/primary',
      features: [
        'workspace_qualified_voice',
        'workspace_qualified_rest_core',
        'workspace_settings',
      ],
      workspaces: [
        {
          id: 'primary',
          cwd: '/work/primary',
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary',
          cwd: '/work/secondary',
          primary: false,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const { container, rerender } = renderApp();
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('/model --voice');
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="model-select"]'),
    ).not.toBeNull();

    mockWorkspace.capabilities = {
      ...mockWorkspace.capabilities,
      features: ['workspace_qualified_voice', 'workspace_qualified_rest_core'],
    };
    rerender();
    await flush();

    expect(container.querySelector('[data-testid="model-select"]')).toBeNull();
  });

  it('does not open a pending Voice picker after entering split view', async () => {
    mockConnection.workspaceCwd = '/work/secondary';
    mockWorkspace.capabilities = {
      workspaceCwd: '/work/primary',
      features: [
        'workspace_qualified_voice',
        'workspace_qualified_rest_core',
        'workspace_settings',
      ],
      workspaces: [
        {
          id: 'primary',
          cwd: '/work/primary',
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary',
          cwd: '/work/secondary',
          primary: false,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const providerStatus = {
      v: 1 as const,
      workspaceCwd: '/work/secondary',
      initialized: true,
      providers: [],
    };
    const providersResult = deferred<typeof providerStatus>();
    qualifiedWorkspaceProviders.mockReturnValue(providersResult.promise);
    const { container } = renderApp();
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('/model --voice');
      await Promise.resolve();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-split-view"]')
        ?.click();
    });
    await act(async () => {
      providersResult.resolve(providerStatus);
      await Promise.resolve();
    });
    await flush();

    expect(container.querySelector('[data-testid="model-select"]')).toBeNull();
  });

  it('does not open a pending command Voice picker after entering Settings', async () => {
    mockConnection.workspaceCwd = '/work/secondary';
    mockWorkspace.capabilities = {
      workspaceCwd: '/work/primary',
      features: [
        'workspace_qualified_voice',
        'workspace_qualified_rest_core',
        'workspace_settings',
      ],
      workspaces: [
        {
          id: 'primary',
          cwd: '/work/primary',
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary',
          cwd: '/work/secondary',
          primary: false,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const providerStatus = {
      v: 1 as const,
      workspaceCwd: '/work/secondary',
      initialized: true,
      providers: [],
    };
    const providersResult = deferred<typeof providerStatus>();
    qualifiedWorkspaceProviders.mockReturnValue(providersResult.promise);
    const { container } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('/model --voice');
      testState.latestChatEditorProps?.onSubmit('/settings');
    });
    expect(qualifiedWorkspaceProviders).toHaveBeenCalledOnce();
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();

    await act(async () => {
      providersResult.resolve(providerStatus);
      await Promise.resolve();
    });
    await flush();

    expect(container.querySelector('[data-testid="model-select"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();
  });

  it('waits for session loading to finish before requesting status', async () => {
    mockConnection.loadingTranscript = true;
    const { rerender } = renderApp();
    await flush();

    expect(mockWorkspace.client.sessionStatus).not.toHaveBeenCalled();

    mockConnection.loadingTranscript = false;
    rerender();

    await vi.waitFor(() => {
      expect(mockWorkspace.client.sessionStatus).toHaveBeenCalledWith(
        'session-1',
      );
    });
  });

  it('uses the session catalog title when the connection has no display name', async () => {
    mockConnection.displayName = undefined;
    mockWorkspace.client.listWorkspaceSessions.mockResolvedValue([
      {
        sessionId: 'session-1',
        workspaceCwd: '/tmp/project',
        displayName: 'Real session title',
      },
    ]);

    const { container } = renderApp();

    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="chat-context-header"]')
          ?.textContent,
      ).toContain('Real session title');
    });
  });

  it('does not query a workspace catalog for a Live session title', async () => {
    mockConnection.sessionContext = { kind: 'live' };
    mockConnection.workspaceCwd = '';
    mockConnection.displayName = undefined;
    mockWorkspace.client.sessionStatus.mockResolvedValue({
      sessionId: 'session-1',
      workspaceCwd: '/internal/conversations',
      displayName: 'Live conversation',
    });

    const { container } = renderApp();

    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="chat-context-header"]')
          ?.textContent,
      ).toContain('Live conversation');
    });
    expect(mockWorkspace.client.listWorkspaceSessions).not.toHaveBeenCalled();
  });

  it('does not expose cached metadata after a same-id workspace switch', async () => {
    mockConnection.displayName = undefined;
    const sourceStatus = deferred<{
      workspaceCwd: string;
      displayName: string;
    }>();
    mockWorkspace.client.sessionStatus.mockReturnValueOnce(
      sourceStatus.promise,
    );
    const sourceList = deferred<never[]>();
    mockWorkspace.client.listWorkspaceSessions.mockReturnValueOnce(
      sourceList.promise,
    );
    const targetStatus = deferred<{ workspaceCwd: string }>();
    mockWorkspace.client.sessionStatus.mockReturnValueOnce(
      targetStatus.promise,
    );
    const { container, rerender } = renderApp();

    await act(async () => {
      sourceStatus.resolve({
        workspaceCwd: '/work/a',
        displayName: 'Session A title',
      });
      sourceList.resolve([]);
      await Promise.all([sourceStatus.promise, sourceList.promise]);
    });

    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="chat-context-header"]')
          ?.textContent,
      ).toContain('Session A title');
    });

    testState.ownerVersion += 1;
    mockConnection.workspaceCwd = '/work/b';
    rerender();
    await flush();
    rerender();

    expect(
      container.querySelector('[data-testid="chat-context-header"]')
        ?.textContent,
    ).not.toContain('Session A title');

    await act(async () => {
      targetStatus.resolve({ workspaceCwd: '/work/b' });
      await targetStatus.promise;
    });
    await flush();
  });

  it('keeps the persistent chat header opt-in for existing integrations', () => {
    const { container } = renderApp({ header: undefined });

    expect(
      container.querySelector('[data-testid="chat-context-header"]'),
    ).toBeNull();
  });

  it('appends composer actions without replacing context-sensitive defaults', () => {
    mockConnection.sessionId = undefined;
    testState.messages = [];
    renderApp({ composerToolbarAdditionalActions: ['addMenu'] });

    expect(testState.latestChatEditorProps?.visibleToolbarActions).toEqual(
      expect.arrayContaining(['addMenu', 'gitBranch', 'widthMode']),
    );
  });

  it('lets a custom renderer replace the complete persistent chat header', () => {
    mockConnection.gitBranch = 'main';
    mockConnection.gitStatus = {
      v: 2,
      workspaceCwd: '/tmp/project',
      branch: 'main',
      unstaged: 1,
    };
    const renderChatHeader = vi.fn(() => (
      <header data-testid="custom-chat-header">Custom session header</header>
    ));
    const { container } = renderApp({
      header: undefined,
      renderChatHeader,
    });

    expect(
      container.querySelector('[data-testid="chat-context-header"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="custom-chat-header"]')
        ?.textContent,
    ).toContain('Custom session header');
    expect(renderChatHeader).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        sessionName: 'Session One',
        workspaceCwd: '/tmp/project',
        items: ['title', 'environment', 'rightPanel'],
        environmentPanelOpen: false,
        rightPanelOpen: false,
        onEnvironmentPanelOpenChange: expect.any(Function),
        onRightPanelOpenChange: expect.any(Function),
      }),
    );
    expect(testState.latestChatEditorProps?.visibleToolbarActions).toContain(
      'gitBranch',
    );
  });

  it('exposes token usage to a custom chat header', async () => {
    mockSessionActions.getStats.mockReturnValue(new Promise(() => {}));
    const renderChatHeader = vi.fn(
      ({ onOpenTokenUsage }: ChatHeaderRenderInfo) => (
        <button type="button" onClick={onOpenTokenUsage}>
          Custom token usage
        </button>
      ),
    );
    const { container } = renderApp({
      header: { items: ['tokenUsage'] },
      renderChatHeader,
    });
    await flush();

    expect(renderChatHeader).toHaveBeenCalledWith(
      expect.objectContaining({
        items: ['tokenUsage'],
        onOpenTokenUsage: expect.any(Function),
      }),
    );
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Custom token usage')!
        .click();
      await Promise.resolve();
    });
    expect(mockSessionActions.getStats).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Token Usage');
  });

  it('exposes the Local Control settings deep link to a custom chat header', async () => {
    const renderChatHeader = vi.fn(
      ({ onOpenLocalControlSettings }: ChatHeaderRenderInfo) => (
        <button type="button" onClick={onOpenLocalControlSettings}>
          Custom mobile access
        </button>
      ),
    );
    const { container } = renderApp({ renderChatHeader });
    await flush();

    expect(renderChatHeader).toHaveBeenCalledWith(
      expect.objectContaining({
        onOpenLocalControlSettings: expect.any(Function),
      }),
    );
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Custom mobile access')!
        .click();
      await Promise.resolve();
    });
    await flush();
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();
    expect(testState.latestSettingsInitialCategory).toBe('Daemon');
  });

  it('omits the workspace settings deep link from a standalone chat header', async () => {
    mockConnection.sessionContext = { kind: 'standalone' };
    mockConnection.workspaceCwd = '';
    const renderChatHeader = vi.fn(() => null);
    renderApp({ renderChatHeader });
    await flush();

    expect(renderChatHeader).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceCwd: undefined,
        onOpenLocalControlSettings: undefined,
      }),
    );
  });

  it('opens Settings deep-linked to Daemon from the main chat header QR entry', async () => {
    const { container } = renderApp();
    await flush();

    const entry = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-context-header"] [aria-label="Mobile access"]',
    );
    expect(entry).not.toBeNull();
    await act(async () => {
      entry!.click();
      await Promise.resolve();
    });
    await flush();
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();
    expect(testState.latestSettingsInitialCategory).toBe('Daemon');
  });

  it('opens the token usage panel from the main chat header action', async () => {
    const statsFixture: DaemonSessionStatsStatus = {
      v: 1,
      sessionId: 'session-1',
      workspaceCwd: '/tmp/project',
      sessionStartTimeMs: 1000,
      durationMs: 60000,
      promptCount: 2,
      models: {
        'qwen-plus::hybrid': {
          api: { totalRequests: 2, totalErrors: 0, totalLatencyMs: 1000 },
          tokens: {
            prompt: 500000,
            candidates: 100000,
            total: 600000,
            cached: 50000,
            thoughts: 10000,
          },
        },
      },
      tools: {
        totalCalls: 0,
        totalSuccess: 0,
        totalFail: 0,
        totalDurationMs: 0,
        byName: {},
      },
      files: { totalLinesAdded: 0, totalLinesRemoved: 0 },
      sources: [],
    };
    mockSessionActions.getStats.mockResolvedValue(statsFixture);
    const { container } = renderApp({
      header: { items: ['title', 'environment', 'rightPanel', 'tokenUsage'] },
    });
    await flush();

    const entry = container.querySelector<HTMLButtonElement>(
      '[aria-label="Session token usage"]',
    );
    expect(entry).not.toBeNull();
    await act(async () => {
      entry!.click();
      await Promise.resolve();
    });
    await flush();

    expect(mockSessionActions.getStats).toHaveBeenCalled();
    // Docked right panel on the main chat view renders in the container.
    expect(container.textContent).toContain('Token Usage');
    expect(container.textContent).toContain('qwen-plus::hybrid');

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="delete-session"]')!
        .click();
    });
    expect(container.textContent).not.toContain('qwen-plus::hybrid');
  });

  it('wires the composer context ring from the connection and opens /context on click', async () => {
    const usageConnection = mockConnection as typeof mockConnection & {
      tokenCount?: number;
      contextWindow?: number;
    };
    usageConnection.tokenCount = 338;
    usageConnection.contextWindow = 1000;

    renderApp();
    await flush();

    expect(testState.latestChatEditorProps?.visibleToolbarActions).toContain(
      'contextUsage',
    );
    expect(testState.latestChatEditorProps?.tokenCount).toBe(338);
    expect(testState.latestChatEditorProps?.contextWindow).toBe(1000);

    await act(async () => {
      testState.latestChatEditorProps?.onShowContextUsage?.();
    });
    await flush();

    expect(mockSessionActions.getContextUsage).toHaveBeenCalledWith({
      detail: false,
    });
  });

  it('defaults the composer ring props to 0 before any usage arrives', async () => {
    // The state right after connecting (or for sessions that never emit
    // usage): the `?? 0` fallbacks must keep NaN out of the ring math.
    const usageConnection = mockConnection as typeof mockConnection & {
      tokenCount?: number;
      contextWindow?: number;
    };
    usageConnection.tokenCount = undefined;
    usageConnection.contextWindow = undefined;

    renderApp();
    await flush();

    expect(testState.latestChatEditorProps?.tokenCount).toBe(0);
    expect(testState.latestChatEditorProps?.contextWindow).toBe(0);
  });

  it('keeps legacy task status for a custom header without explicit header configuration', () => {
    const monitor: DaemonSessionMonitorTaskStatus = {
      kind: 'monitor',
      id: 'monitor-1',
      label: 'Watch server',
      description: 'Watch server',
      status: 'running',
      startTime: 1,
      runtimeMs: 10,
    };
    testState.backgroundTasks = [monitor];

    renderApp({
      header: undefined,
      renderChatHeader: () => <header>Custom session header</header>,
    });

    expect(testState.latestStatusBarTasks).toEqual([monitor]);
  });

  it('passes terminal background shell task ids to the message list', async () => {
    const running: DaemonSessionShellTaskStatus = {
      kind: 'shell',
      id: 'shell-running',
      label: 'Running shell',
      description: 'Running shell',
      status: 'running',
      startTime: 1_000,
      runtimeMs: 5_000,
      command: 'npm run dev',
      cwd: '/tmp/project',
    };
    testState.backgroundTasks = [
      running,
      {
        ...running,
        id: 'shell-completed',
        status: 'completed',
      },
    ];

    renderApp();
    await flush();

    expect([
      ...(testState.latestMessageListProps?.terminalBackgroundShellTaskIds ??
        []),
    ]).toEqual(['shell-completed']);
  });

  it('controls the built-in chat header actions through header items', () => {
    const { container } = renderApp({
      header: { items: ['environment'] },
    });

    expect(
      container.querySelector(
        'button[aria-label="Toggle environment information"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="Toggle right panel"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="chat-context-header"]')
        ?.textContent,
    ).not.toContain('Session One');
  });

  it('hides the complete chat header when header items are empty', () => {
    const { container } = renderApp({ header: { items: [] } });

    expect(
      container.querySelector('[data-testid="chat-context-header"]'),
    ).toBeNull();
  });

  it('opens environment information without restoring composer Git information', () => {
    mockConnection.gitBranch = 'main';
    mockConnection.gitStatus = {
      v: 2,
      workspaceCwd: '/tmp/project',
      branch: 'main',
      unstaged: 1,
    };
    const { container } = renderApp();
    const rightPanelButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle right panel"]',
    );

    expect(rightPanelButton).not.toBeNull();
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle environment information"]',
        )
        ?.click();
    });

    expect(
      container.querySelector(
        '[data-testid="environment-panel"]:not([hidden])',
      ),
    ).not.toBeNull();
    expect(
      testState.latestChatEditorProps?.visibleToolbarActions,
    ).not.toContain('gitBranch');
  });

  it('keeps the right-panel action visible and opens a review-only empty state', () => {
    const { container } = renderApp();
    const rightPanelButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle right panel"]',
    );

    expect(rightPanelButton).not.toBeNull();
    act(() => rightPanelButton?.click());

    const emptyActions = container.querySelector(
      '[data-testid="right-panel-empty-actions"]',
    );
    const actions = Array.from(
      emptyActions?.querySelectorAll<HTMLButtonElement>('button') ?? [],
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]?.textContent).toContain('Changes');
    expect(actions[0]?.disabled).toBe(true);
    expect(
      container.querySelector('button[aria-label="Add panel"]'),
    ).toBeNull();

    const header = container.querySelector(
      '[data-testid="chat-context-header"]',
    );
    expect(
      header?.querySelector('button[aria-label="Toggle right panel"]'),
    ).toBeNull();
    expect(
      container
        .querySelector('aside[aria-label="Right panel"]')
        ?.querySelector('button[aria-label="Toggle right panel"]'),
    ).not.toBeNull();
    const artifactDock =
      container.querySelector('[role="separator"]')?.parentElement;
    // The dock renders through a display:contents slot, so the .appShell flex
    // parent sits one level above the wrapper itself.
    expect(artifactDock?.parentElement?.parentElement).toBe(
      header?.parentElement?.parentElement?.parentElement,
    );
    expect(header?.parentElement?.contains(artifactDock ?? null)).toBe(false);
  });

  it('shows the manual terminal action when configured and advertised', () => {
    mockConnection.capabilities.features = ['web_terminal'];
    const { container } = renderApp({
      rightPanel: { items: ['terminal'] },
    });
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click(),
    );

    const actions = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="right-panel-empty-actions"] button',
      ),
    );
    expect(
      actions.find((button) => button.textContent?.includes('Terminal')),
    ).toBeDefined();

    act(() =>
      actions
        .find((button) => button.textContent?.includes('Terminal'))
        ?.click(),
    );
    const terminalId = container
      .querySelector('[data-testid="terminal-panel"]')
      ?.getAttribute('data-terminal-id');
    expect(terminalId).toBeTruthy();
    act(() =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Close Terminal"]')
        ?.click(),
    );
    expect(mockReleaseWebTerminal).toHaveBeenCalledWith(terminalId);
  });

  it('hides the manual terminal action without the capability', () => {
    const { container } = renderApp({
      rightPanel: { items: ['terminal'] },
    });
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click(),
    );

    expect(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          '[data-testid="right-panel-empty-actions"] button',
        ),
      ).some((button) => button.textContent?.includes('Terminal')),
    ).toBe(false);
  });

  it('hides the manual terminal action when it is not configured', () => {
    mockConnection.capabilities.features = ['web_terminal'];
    const { container } = renderApp();
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click(),
    );

    expect(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          '[data-testid="right-panel-empty-actions"] button',
        ),
      ).some((button) => button.textContent?.includes('Terminal')),
    ).toBe(false);
  });

  it('opens the latest reviewable turn from the empty right panel', () => {
    mockWorkspace.capabilities = {
      workspaceCwd: '/tmp/project',
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    testState.messages = [
      {
        id: 'user-1',
        role: 'user',
        content: 'write the first file',
      },
      {
        id: 'tools-1',
        role: 'tool_group',
        tools: [
          {
            callId: 'write-1',
            toolName: 'write_file',
            status: 'completed',
            args: {
              file_path: 'src/first.ts',
              content: 'export const first = true;\n',
            },
          },
        ],
      },
      {
        id: 'user-2',
        role: 'user',
        content: 'write the latest file',
      },
      {
        id: 'tools-2',
        role: 'tool_group',
        tools: [
          {
            callId: 'write-2',
            toolName: 'write_file',
            status: 'completed',
            args: {
              file_path: 'src/latest.ts',
              content: 'export const latest = true;\n',
            },
          },
        ],
      },
    ];
    const { container } = renderApp();

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
    });
    const changes = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="right-panel-empty-actions"] button',
      ),
    ).find((button) => button.textContent?.startsWith('Changes'));
    expect(changes?.disabled).toBe(false);

    act(() => changes?.click());

    expect(container.querySelector('button[title="Changes"]')).not.toBeNull();
    expect(container.textContent).toContain('latest.ts');
    expect(container.textContent).not.toContain('first.ts');
  });

  it('floats environment information in ultrawide mode', () => {
    mockConnection.gitBranch = 'main';
    mockConnection.gitStatus = {
      v: 2,
      workspaceCwd: '/tmp/project',
      branch: 'main',
      unstaged: 1,
    };
    const { container } = renderApp();
    const environmentButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle environment information"]',
    );

    act(() => {
      testState.latestChatEditorProps?.onChatWidthModeChange?.('wide');
      environmentButton?.click();
    });

    const environmentPanel = container.querySelector(
      '[data-testid="environment-panel"]:not([hidden])',
    );
    expect(environmentPanel?.getAttribute('data-floating')).toBe('true');
    expect(
      environmentPanel?.parentElement?.contains(
        container.querySelector('[data-testid="chat-pane-container"]'),
      ),
    ).toBe(true);
  });

  it('closes environment information at the dock breakpoint and reopens it floating', async () => {
    let availableMessageWidth = 1200;
    const resizeCallbacks = new Set<ResizeObserverCallback>();
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {
        resizeCallbacks.add(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {
        resizeCallbacks.delete(this.callback);
      }
    } as typeof ResizeObserver;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function () {
        if (this.dataset['testid'] !== 'context-body') return new DOMRect();
        return new DOMRect(0, 0, availableMessageWidth, 600);
      },
    );
    testState.messages = [
      {
        id: 'tools',
        role: 'tool_group',
        tools: [
          {
            callId: 'agent-call',
            toolName: 'agent',
            title: 'Inspect repository',
            status: 'completed',
            args: { subagent_type: 'Explore' },
          },
        ],
      },
    ];
    const { container } = renderApp();
    const environmentButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle environment information"]',
    );

    act(() => environmentButton?.click());
    expect(
      container.querySelector(
        '[data-testid="environment-panel"]:not([hidden])',
      ),
    ).not.toBeNull();

    await act(async () => {
      availableMessageWidth = 932;
      resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver));
      await Promise.resolve();
    });
    expect(
      container.querySelector(
        '[data-testid="environment-panel"]:not([hidden])',
      ),
    ).toBeNull();

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle environment information"]',
        )
        ?.click();
    });
    expect(
      container
        .querySelector('[data-testid="environment-panel"]:not([hidden])')
        ?.getAttribute('data-floating'),
    ).toBe('true');
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it('opens environment information floating beside an open right panel', async () => {
    const resizeCallbacks = new Set<ResizeObserverCallback>();
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {
        resizeCallbacks.add(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {
        resizeCallbacks.delete(this.callback);
      }
    } as typeof ResizeObserver;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function () {
        if (this.dataset['testid'] !== 'context-body') return new DOMRect();
        return new DOMRect(0, 0, 1_000, 600);
      },
    );
    const { container } = renderApp();

    await act(async () => {
      resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver));
      await Promise.resolve();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle environment information"]',
        )
        ?.click();
    });

    const environmentPanel = container.querySelector(
      '[data-testid="environment-panel"]:not([hidden])',
    );
    expect(environmentPanel?.getAttribute('data-floating')).toBe('true');
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it('keeps the environment action visible without dynamic activity', () => {
    const { container } = renderApp();

    expect(
      container.querySelector(
        'button[aria-label="Toggle environment information"]',
      ),
    ).not.toBeNull();
  });

  it('keeps the environment action visible for a clean working tree', () => {
    mockConnection.gitBranch = 'main';
    mockConnection.gitStatus = {
      v: 2,
      workspaceCwd: '/tmp/project',
      branch: 'main',
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
    };
    const { container } = renderApp();

    expect(
      container.querySelector(
        'button[aria-label="Toggle environment information"]',
      ),
    ).not.toBeNull();
  });

  it('shows the environment action for a background task in the transcript', () => {
    testState.messages = [
      {
        id: 'tools',
        role: 'tool_group',
        tools: [
          {
            callId: 'background-shell',
            toolName: 'shell',
            status: 'completed',
            args: {
              command: 'npm run dev',
              is_background: true,
            },
          },
        ],
      },
    ];
    const { container } = renderApp();

    expect(
      container.querySelector(
        'button[aria-label="Toggle environment information"]',
      ),
    ).not.toBeNull();
  });

  it('opens an environment monitor in the right panel', () => {
    const monitor: DaemonSessionMonitorTaskStatus = {
      kind: 'monitor',
      id: 'monitor-1',
      label: 'monitor-label',
      description: 'watch server log',
      status: 'running',
      startTime: 1_000,
      runtimeMs: 5_000,
      command: 'tail -f server.log',
      eventCount: 3,
      lastEventTime: 5_000,
      droppedLines: 0,
    };
    testState.backgroundTasks = [monitor];
    const { container } = renderApp();

    act(() => {
      testState.latestChatEditorProps?.onChatWidthModeChange?.('wide');
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle environment information"]',
        )
        ?.click();
    });
    const backgroundTasksButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]'),
    ).find((button) => button.textContent?.includes('Background tasks'));
    act(() => backgroundTasksButton?.click());
    const monitorButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="environment-panel"] ul button',
      ),
    ).find((button) => button.textContent?.includes('watch server log'));

    act(() => monitorButton?.click());

    expect(
      container.querySelector(
        '[data-testid="environment-panel"]:not([hidden])',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector('button[title="watch server log"]'),
    ).not.toBeNull();
    expect(testState.latestBackgroundTasksRefreshTrigger).toBe(1);
  });

  it('opens an environment shell task in the right panel', () => {
    const shell: DaemonSessionShellTaskStatus = {
      kind: 'shell',
      id: 'shell-1',
      label: 'Development server',
      description: 'Run the development server',
      status: 'running',
      startTime: 1_000,
      runtimeMs: 5_000,
      command: 'npm run dev',
      cwd: '/tmp/project',
      pid: 42,
    };
    testState.backgroundTasks = [shell];
    const { container } = renderApp();

    act(() => {
      testState.latestChatEditorProps?.onChatWidthModeChange?.('wide');
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle environment information"]',
        )
        ?.click();
    });
    const backgroundTasksButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]'),
    ).find((button) => button.textContent?.includes('Background tasks'));
    act(() => backgroundTasksButton?.click());
    const shellButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="environment-panel"] ul button',
      ),
    ).find((button) => button.textContent?.includes('npm run dev'));

    act(() => shellButton?.click());

    expect(
      container.querySelector(
        '[data-testid="environment-panel"]:not([hidden])',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector('button[title="npm run dev"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('/tmp/project');
    expect(testState.latestBackgroundTasksRefreshTrigger).toBe(1);
  });

  it('closes environment information when the active session changes', () => {
    mockConnection.gitBranch = 'main';
    mockConnection.gitStatus = {
      v: 2,
      workspaceCwd: '/tmp/project',
      branch: 'main',
      unstaged: 1,
    };
    const { container, rerender } = renderApp();
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle environment information"]',
        )
        ?.click();
    });
    expect(
      container.querySelector(
        '[data-testid="environment-panel"]:not([hidden])',
      ),
    ).not.toBeNull();

    mockConnection.sessionId = 'session-2';
    rerender();

    expect(
      container.querySelector(
        '[data-testid="environment-panel"]:not([hidden])',
      ),
    ).toBeNull();
  });

  it('keeps environment information open with its subagent panel', async () => {
    let availableContextWidth = 1_200;
    const resizeCallbacks = new Set<ResizeObserverCallback>();
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {
        resizeCallbacks.add(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {
        resizeCallbacks.delete(this.callback);
      }
    } as typeof ResizeObserver;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function () {
        if (this.dataset['testid'] !== 'context-body') return new DOMRect();
        return new DOMRect(0, 0, availableContextWidth, 600);
      },
    );
    testState.messages = [
      {
        id: 'tools',
        role: 'tool_group',
        tools: [
          {
            callId: 'agent-call',
            toolName: 'agent',
            title: 'Inspect repository',
            status: 'completed',
            args: { subagent_type: 'Explore' },
            rawOutput: {
              type: 'task_execution',
              status: 'completed',
              subagentName: 'Explore',
            },
          },
        ],
      },
    ];
    const { container } = renderApp();
    await act(async () => {
      resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver));
      await Promise.resolve();
    });

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle environment information"]',
        )
        ?.click();
    });
    const subagentsButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]'),
    ).find((button) => button.textContent?.includes('Subagents'));
    act(() => subagentsButton?.click());

    const environmentButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle environment information"]',
    );
    act(() => environmentButton?.click());
    expect(
      container.querySelector(
        '[data-testid="environment-panel"]:not([hidden])',
      ),
    ).toBeNull();
    act(() => environmentButton?.click());
    expect(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          '[data-testid="environment-panel"]:not([hidden]) button[aria-expanded="true"]',
        ),
      ).some((button) => button.textContent?.includes('Subagents')),
    ).toBe(true);

    const agentButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="environment-panel"]:not([hidden]) ul button',
      ),
    ).find((button) => button.textContent?.includes('Inspect repository'));
    act(() => agentButton?.click());
    await act(async () => {
      availableContextWidth = 900;
      resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver));
      await Promise.resolve();
    });

    expect(
      container.querySelector(
        '[data-testid="environment-panel"]:not([hidden])',
      ),
    ).not.toBeNull();
    expect(
      container
        .querySelector('[data-testid="environment-panel"]:not([hidden])')
        ?.getAttribute('data-floating'),
    ).toBe('true');

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
    });

    expect(
      container.querySelector(
        '[data-testid="environment-panel"]:not([hidden])',
      ),
    ).not.toBeNull();

    act(() => {
      testState.latestChatEditorProps?.onChatWidthModeChange?.('wide');
    });
    expect(
      container
        .querySelector('[data-testid="environment-panel"]:not([hidden])')
        ?.getAttribute('data-floating'),
    ).toBe('true');

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
    });
    expect(
      container.querySelector(
        '[data-testid="environment-panel"]:not([hidden])',
      ),
    ).toBeNull();
    const environmentToggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle environment information"]',
    );
    expect(environmentToggle).not.toBeNull();

    act(() => environmentToggle?.click());
    expect(
      container.querySelector(
        '[data-testid="environment-panel"]:not([hidden])',
      ),
    ).not.toBeNull();
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it('loads an out-of-band fork after the right panel opens', async () => {
    testState.backgroundTasks = [
      {
        kind: 'agent',
        id: 'fork-agent-1',
        label: 'Review current changes',
        description: 'Review current changes',
        status: 'running',
        startTime: 1,
        runtimeMs: 10,
        isBackgrounded: true,
      },
    ];
    const { container } = renderApp();

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle environment information"]',
        )
        ?.click();
    });
    const subagentsButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]'),
    ).find((button) => button.textContent?.includes('Subagents'));
    act(() => subagentsButton?.click());
    const forkButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="environment-panel"] ul button',
      ),
    ).find((button) => button.textContent?.includes('Review current changes'));

    expect(forkButton?.disabled).toBe(false);
    act(() => forkButton?.click());

    expect(
      container.querySelector('[class*="artifactPanelDockNoOpenAnimation"]'),
    ).toBeNull();
    expect(mockWorkspace.client.resolveSubagentSession).not.toHaveBeenCalled();
    expect(
      container.querySelector(
        '[data-testid="environment-panel"]:not([hidden])',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector('button[title="Agent: Review current changes"]'),
    ).not.toBeNull();

    const dock = container.querySelector<HTMLElement>(
      '[class*="artifactPanelDock"]',
    );
    const panel = dock?.querySelector('aside');
    await act(async () => {
      panel?.dispatchEvent(new Event('animationend', { bubbles: true }));
      await Promise.resolve();
    });
    expect(mockWorkspace.client.resolveSubagentSession).not.toHaveBeenCalled();

    await act(async () => {
      dock?.dispatchEvent(new Event('animationend', { bubbles: true }));
      await Promise.resolve();
    });
    expect(
      mockWorkspace.client.resolveSubagentSession,
    ).toHaveBeenCalledExactlyOnceWith('session-1', 'fork-agent-1');
  });

  it('loads an out-of-band fork after the floating drawer opens with reduced motion', async () => {
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    testState.backgroundTasks = [
      {
        kind: 'agent',
        id: 'fork-agent-1',
        label: 'Review current changes',
        description: 'Review current changes',
        status: 'running',
        startTime: 1,
        runtimeMs: 10,
        isBackgrounded: true,
      },
    ];
    const { container } = renderApp();

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle environment information"]',
        )
        ?.click();
    });
    const subagentsButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]'),
    ).find((button) => button.textContent?.includes('Subagents'));
    act(() => subagentsButton?.click());
    const forkButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="environment-panel"] ul button',
      ),
    ).find((button) => button.textContent?.includes('Review current changes'));

    act(() => forkButton?.click());

    expect(mockWorkspace.client.resolveSubagentSession).not.toHaveBeenCalled();
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 700);
    const drawer = document.querySelector<HTMLElement>(
      '[data-slot="drawer-content"]',
    );
    expect(drawer).not.toBeNull();
    const dispatchAnimationEnd = (target: Element, animationName: string) => {
      const event = new Event('animationend', { bubbles: true });
      Object.defineProperty(event, 'animationName', { value: animationName });
      target.dispatchEvent(event);
    };

    await act(async () => {
      const panel = drawer?.querySelector('aside');
      if (panel) dispatchAnimationEnd(panel, 'child-animation');
      await Promise.resolve();
    });
    expect(mockWorkspace.client.resolveSubagentSession).not.toHaveBeenCalled();

    await act(async () => {
      if (drawer) dispatchAnimationEnd(drawer, 'slideFromRight');
      await Promise.resolve();
    });
    expect(
      mockWorkspace.client.resolveSubagentSession,
    ).toHaveBeenCalledExactlyOnceWith('session-1', 'fork-agent-1');
  });

  it('updates the header when session metadata supplies a generated title', () => {
    mockConnection.displayName = undefined;
    const { container, rerender } = renderApp();
    expect(
      container.querySelector('[data-testid="chat-context-header"]')
        ?.textContent,
    ).toContain('New session');

    mockConnection.displayName = 'Investigate task failures';
    rerender();

    expect(
      container.querySelector('[data-testid="chat-context-header"]')
        ?.textContent,
    ).toContain('Investigate task failures');
  });

  it('stops refreshing the generated title after the catalog resolves it', async () => {
    mockConnection.displayName = undefined;
    const { container, rerender } = renderApp();
    await vi.waitFor(() => {
      expect(mockWorkspace.client.listWorkspaceSessions).toHaveBeenCalled();
    });
    mockWorkspace.client.listWorkspaceSessions.mockClear();
    mockWorkspace.client.listWorkspaceSessions
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          sessionId: 'session-1',
          workspaceCwd: '/tmp/project',
          displayName: 'Generated session title',
        },
      ]);
    vi.useFakeTimers();

    act(() => {
      testState.streamingState = 'responding';
      rerender();
    });
    act(() => {
      testState.streamingState = 'idle';
      rerender();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="chat-context-header"]')
        ?.textContent,
    ).not.toContain('Generated session title');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(
      container.querySelector('[data-testid="chat-context-header"]')
        ?.textContent,
    ).toContain('Generated session title');
    expect(mockWorkspace.client.listWorkspaceSessions).toHaveBeenCalledTimes(2);

    mockWorkspace.client.listWorkspaceSessions.mockClear();
    act(() => {
      testState.streamingState = 'responding';
      rerender();
    });
    act(() => {
      testState.streamingState = 'idle';
      rerender();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(mockWorkspace.client.listWorkspaceSessions).not.toHaveBeenCalled();
  });

  it('defers title refresh while the page is hidden', async () => {
    mockConnection.displayName = undefined;
    const { container, rerender } = renderApp();
    await vi.waitFor(() => {
      expect(mockWorkspace.client.listWorkspaceSessions).toHaveBeenCalled();
    });
    mockWorkspace.client.listWorkspaceSessions.mockClear();
    mockWorkspace.client.listWorkspaceSessions.mockResolvedValueOnce([
      {
        sessionId: 'session-1',
        workspaceCwd: '/tmp/project',
        displayName: 'Visible session title',
      },
    ]);
    vi.useFakeTimers();
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true,
    });

    act(() => {
      testState.streamingState = 'responding';
      rerender();
    });
    act(() => {
      testState.streamingState = 'idle';
      rerender();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockWorkspace.client.listWorkspaceSessions).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(mockWorkspace.client.listWorkspaceSessions).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="chat-context-header"]')
        ?.textContent,
    ).not.toContain('Visible session title');

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false,
    });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="chat-context-header"]')
        ?.textContent,
    ).toContain('Visible session title');
  });

  it('submits through a disconnected session', async () => {
    mockConnection.status = 'disconnected';
    renderApp();

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('recover connection');
      await Promise.resolve();
    });

    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      'recover connection',
      expect.objectContaining({ images: undefined }),
    );
  });

  it('reports the current workspace id and path', async () => {
    mockConnection.workspaceCwd = '/work/secondary';
    mockWorkspace.capabilities = {
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true },
        { id: 'secondary', cwd: '/work/secondary', primary: false },
      ],
    };
    const onSessionIdChange = vi.fn();

    renderApp({ onSessionIdChange });
    await flush();

    expect(onSessionIdChange).toHaveBeenCalledWith(
      'session-1',
      'secondary',
      '/work/secondary',
    );
  });

  it('reports explicit non-workspace contexts to the host', async () => {
    mockConnection.workspaceCwd = '';
    mockConnection.sessionContext = { kind: 'live' };
    const onSessionIdChange = vi.fn();

    const { rerender } = renderApp({ onSessionIdChange });
    await flush();

    expect(onSessionIdChange).toHaveBeenLastCalledWith(
      'session-1',
      undefined,
      undefined,
      { kind: 'live' },
    );

    act(() => {
      mockConnection.sessionContext = { kind: 'standalone' };
      rerender({ onSessionIdChange });
    });
    await flush();

    expect(onSessionIdChange).toHaveBeenLastCalledWith(
      'session-1',
      undefined,
      undefined,
      { kind: 'standalone' },
    );
  });

  it('reports a pending standalone context after the current session clears', async () => {
    mockConnection.sessionContext = { kind: 'workspace', cwd: '/tmp/project' };
    mockConnection.capabilities.features = ['standalone_sessions_v1'];
    mockWorkspace.capabilities = {
      features: ['standalone_sessions_v1'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    };
    const shellRef = createRef<WebShellApi>();
    const onSessionIdChange = vi.fn();
    const { rerender } = renderApp({ onSessionIdChange, shellRef });
    await flush();

    await act(async () => {
      await shellRef.current?.createNewSession();
    });
    expect(mockSessionActions.clearSession).toHaveBeenCalledOnce();

    act(() => {
      mockConnection.sessionId = undefined;
      rerender({ onSessionIdChange, shellRef });
    });
    await flush();

    expect(onSessionIdChange).toHaveBeenLastCalledWith(
      undefined,
      undefined,
      undefined,
      { kind: 'standalone' },
    );
  });

  it('keeps a newer standalone draft when an older session load fails', async () => {
    const load = deferred<void>();
    mockConnection.sessionContext = { kind: 'workspace', cwd: '/tmp/project' };
    mockWorkspace.capabilities = {
      features: ['standalone_sessions_v1'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    mockSessionActions.loadSession.mockReturnValueOnce(load.promise);
    const shellRef = createRef<WebShellApi>();
    const { rerender } = renderApp({ shellRef });
    await flush();

    act(() => {
      window.dispatchEvent(
        new CustomEvent('qwen:open-session', {
          detail: { sessionId: 'stale-session', workspaceCwd: '/tmp/project' },
        }),
      );
    });
    await vi.waitFor(() =>
      expect(mockSessionActions.loadSession).toHaveBeenCalled(),
    );
    await act(async () => {
      expect(await shellRef.current?.createNewSession()).toBe(true);
    });
    act(() => {
      mockConnection.sessionId = undefined;
      rerender({ shellRef });
    });
    await act(async () => {
      load.reject(new Error('stale load failed'));
      await Promise.resolve();
    });
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('standalone prompt');
      await vi.waitFor(() =>
        expect(mockSessionActions.createSession).toHaveBeenCalled(),
      );
    });

    expect(mockSessionActions.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionContext: { kind: 'standalone' } }),
    );
  });

  it('keeps a primary workspace row New Task workspace-scoped on a capable daemon', async () => {
    mockConnection.sessionId = undefined;
    mockConnection.sessionContext = { kind: 'workspace', cwd: '/workspace' };
    mockConnection.capabilities.features = ['standalone_sessions_v1'];
    mockWorkspace.capabilities = {
      features: ['standalone_sessions_v1'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/workspace',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const { container } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="new-session-primary-workspace"]',
        )!
        .click();
      await Promise.resolve();
    });
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('workspace prompt');
      await vi.waitFor(() => {
        expect(mockSessionActions.createSession).toHaveBeenCalled();
      });
    });

    expect(mockSessionActions.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceCwd: '/workspace',
        sessionContext: { kind: 'workspace', cwd: '/workspace' },
      }),
    );
    expect(mockSessionActions.createSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionContext: { kind: 'standalone' } }),
    );
  });

  it('retries failed capabilities before routing a global new session', async () => {
    mockWorkspace.status = 'error';
    mockWorkspace.capabilities =
      undefined as unknown as typeof mockWorkspace.capabilities;
    mockWorkspace.refreshCapabilities.mockResolvedValue({
      features: ['standalone_sessions_v1'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    });
    const shellRef = createRef<WebShellApi>();
    const onSessionIdChange = vi.fn();
    const { rerender } = renderApp({ onSessionIdChange, shellRef });
    await flush();

    let created: boolean | undefined;
    await act(async () => {
      created = await shellRef.current?.createNewSession();
    });

    expect(created).toBe(true);
    expect(mockWorkspace.refreshCapabilities).toHaveBeenCalledOnce();
    expect(mockSessionActions.clearSession).toHaveBeenCalledOnce();

    act(() => {
      mockConnection.sessionId = undefined;
      rerender({ onSessionIdChange, shellRef });
    });
    await flush();

    expect(onSessionIdChange).toHaveBeenLastCalledWith(
      undefined,
      undefined,
      undefined,
      { kind: 'standalone' },
    );
  });

  it('does not expose stale workspace session commands in a pending standalone draft', async () => {
    mockConnection.sessionContext = { kind: 'workspace', cwd: '/tmp/project' };
    mockConnection.commands = [
      skillCommandFixture('workspace-review', 'Review this workspace'),
      {
        name: 'workspace-deploy',
        description: 'Deploy this workspace',
        source: 'project-command',
      },
    ];
    mockConnection.skills = ['workspace-review'];
    mockWorkspace.capabilities = {
      features: ['standalone_sessions_v1'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    };
    const shellRef = createRef<WebShellApi>();
    renderApp({ shellRef });
    await flush();

    await act(async () => {
      await shellRef.current?.createNewSession();
    });

    expect(testState.latestChatEditorProps?.skills).toEqual([]);
    expect(testState.latestChatEditorProps?.commands).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'workspace-review' }),
        expect.objectContaining({ name: 'workspace-deploy' }),
      ]),
    );
    expect(testState.latestChatEditorProps?.commands).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'status' })]),
    );
  });

  it('does not report a session with the previous workspace while loading', async () => {
    mockConnection.sessionId = 'session-2';
    mockConnection.workspaceCwd = '/workspace';
    mockConnection.loadingTranscript = true;
    mockWorkspace.capabilities = {
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true },
        { id: 'secondary', cwd: '/work/secondary', primary: false },
      ],
    };
    const onSessionIdChange = vi.fn();
    const { rerender } = renderApp({ onSessionIdChange });
    await flush();

    expect(onSessionIdChange).not.toHaveBeenCalled();

    mockConnection.workspaceCwd = '/work/secondary';
    mockConnection.loadingTranscript = false;
    mockConnection.error = 'target load failed';
    rerender({ onSessionIdChange });
    await flush();

    expect(onSessionIdChange).toHaveBeenCalledOnce();
    expect(onSessionIdChange).toHaveBeenCalledWith(
      'session-2',
      'secondary',
      '/work/secondary',
    );
  });

  it('reports the selected workspace, not the stale connection workspace, when no session is active', async () => {
    // A cleared session leaves connection.workspaceCwd pointing at the old
    // workspace (here: a secondary with a running task). Starting a new chat
    // in the primary must report the primary, not route the host back to the
    // stale workspace.
    mockConnection.sessionId = undefined;
    mockConnection.workspaceCwd = '/work/secondary';
    mockWorkspace.capabilities = {
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true, trusted: true },
        {
          id: 'secondary',
          cwd: '/work/secondary',
          primary: false,
          trusted: true,
        },
      ],
    };
    const onSessionIdChange = vi.fn();

    renderApp({
      onSessionIdChange,
      initialSelectedWorkspaceCwd: '/workspace',
    });
    await flush();

    expect(onSessionIdChange).toHaveBeenCalledWith(
      undefined,
      undefined,
      '/workspace',
    );
    expect(onSessionIdChange).not.toHaveBeenCalledWith(
      undefined,
      'secondary',
      '/work/secondary',
    );
  });

  it('reports the primary workspace, not the stale connection workspace, when the selection is unset', async () => {
    // The common new-chat path (sidebar "New task", /clear, /new) leaves
    // selectedWorkspaceCwd undefined — that is how "primary" is spelled. The
    // report must fall back to the primary workspace, not the stale
    // connection.workspaceCwd left over from the previous session.
    mockConnection.sessionId = undefined;
    mockConnection.workspaceCwd = '/work/secondary';
    mockWorkspace.capabilities = {
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true, trusted: true },
        {
          id: 'secondary',
          cwd: '/work/secondary',
          primary: false,
          trusted: true,
        },
      ],
    };
    const onSessionIdChange = vi.fn();

    renderApp({ onSessionIdChange });
    await flush();

    expect(onSessionIdChange).toHaveBeenCalledWith(
      undefined,
      undefined,
      '/workspace',
    );
    expect(onSessionIdChange).not.toHaveBeenCalledWith(
      undefined,
      'secondary',
      '/work/secondary',
    );
  });

  it('keeps reporting the active session workspace despite a conflicting next-session selection', async () => {
    // A selection for the next session must not leak into an active session's
    // report: while a session is live the host is routed by that session's own
    // workspace.
    mockConnection.workspaceCwd = '/work/secondary';
    mockWorkspace.capabilities = {
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true, trusted: true },
        {
          id: 'secondary',
          cwd: '/work/secondary',
          primary: false,
          trusted: true,
        },
      ],
    };
    const onSessionIdChange = vi.fn();

    renderApp({
      onSessionIdChange,
      initialSelectedWorkspaceCwd: '/workspace',
    });
    await flush();

    expect(onSessionIdChange).toHaveBeenCalledWith(
      'session-1',
      'secondary',
      '/work/secondary',
    );
    expect(onSessionIdChange).not.toHaveBeenCalledWith(
      'session-1',
      undefined,
      '/workspace',
    );
  });

  it('notifies the host on each deferred workspace switch while no session is active', async () => {
    // With no active session the report must re-run when the next-session
    // workspace selection changes, so a routing host follows each switch
    // rather than reacting to session-id changes alone.
    mockConnection.sessionId = undefined;
    mockConnection.workspaceCwd = '/work/secondary';
    mockWorkspace.capabilities = {
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true, trusted: true },
        {
          id: 'secondary',
          cwd: '/work/secondary',
          primary: false,
          trusted: true,
        },
        {
          id: 'tertiary',
          cwd: '/work/tertiary',
          primary: false,
          trusted: true,
        },
      ],
    };
    const onSessionIdChange = vi.fn();

    renderApp({ onSessionIdChange });
    await flush();

    expect(onSessionIdChange).toHaveBeenLastCalledWith(
      undefined,
      undefined,
      '/workspace',
    );

    act(() => {
      testState.latestChatEditorProps?.onSelectWorkspace?.('/work/tertiary');
    });
    await flush();

    expect(onSessionIdChange).toHaveBeenLastCalledWith(
      undefined,
      'tertiary',
      '/work/tertiary',
    );
  });

  it('creates scratch once, accepts refreshed capabilities, and opens a fresh chat', async () => {
    mockWorkspace.capabilities = {
      features: [
        'dynamic_workspace_registration',
        'scratch_workspace_registration',
      ],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    let resolveScratch!: (value: {
      id: string;
      cwd: string;
      primary: boolean;
      trusted: boolean;
      persisted: false;
    }) => void;
    mockWorkspaceActions.addScratchWorkspace.mockReturnValue(
      new Promise((resolve) => {
        resolveScratch = resolve;
      }),
    );
    const accepted = {
      features: ['scratch_workspace_registration'],
      workspaces: [
        ...mockWorkspace.capabilities.workspaces,
        {
          id: 'scratch',
          cwd: '/managed/scratch-Ab3',
          primary: false,
          trusted: true,
        },
      ],
    };
    mockWorkspace.refreshCapabilities.mockResolvedValue(accepted);
    renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onCreateScratchWorkspace?.();
      testState.latestChatEditorProps?.onCreateScratchWorkspace?.();
    });
    expect(mockWorkspaceActions.addScratchWorkspace).toHaveBeenCalledOnce();
    await act(async () => {
      resolveScratch({
        id: 'scratch',
        cwd: '/managed/scratch-Ab3',
        primary: false,
        trusted: true,
        persisted: false,
      });
      await vi.waitFor(() => {
        expect(mockSessionActions.clearSession).toHaveBeenCalled();
      });
    });

    expect(mockWorkspace.refreshCapabilities).toHaveBeenCalledOnce();
    expect(mockWorkspace.client.workspaceByCwd).toHaveBeenCalledWith(
      '/managed/scratch-Ab3',
    );
  });

  it('opens one App-owned Add workspace dialog from both entry points', async () => {
    mockWorkspace.capabilities = {
      features: [
        'dynamic_workspace_registration',
        'persistent_workspace_registration',
        'workspace_display_name',
        'native_directory_picker',
      ],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const { container, rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onOpenExistingWorkspace?.();
    });
    expect(
      container.querySelectorAll('[data-testid="add-workspace-dialog"]'),
    ).toHaveLength(1);
    expect(testState.latestAddWorkspaceDialogProps).toMatchObject({
      displayNameEnabled: true,
      persistenceSupported: true,
    });
    // The dialog's fetch effect re-runs on every onSuggest identity
    // change, so App must pass the memoized workspace action itself,
    // not a per-render closure; pin the reference across a re-render.
    expect(testState.latestAddWorkspaceDialogProps?.onSuggest).toBe(
      mockWorkspaceActions.suggestWorkspacePaths,
    );
    rerender();
    expect(testState.latestAddWorkspaceDialogProps?.onSuggest).toBe(
      mockWorkspaceActions.suggestWorkspacePaths,
    );
    mockWorkspaceActions.pickWorkspaceDirectory.mockResolvedValue({
      kind: 'workspace-directory-picker',
      selected: true,
      path: '/tmp/selected',
    });
    await expect(
      testState.latestAddWorkspaceDialogProps?.onPick?.(),
    ).resolves.toBe('/tmp/selected');

    act(() => {
      testState.latestAddWorkspaceDialogProps?.onClose();
    });
    expect(
      container.querySelector('[data-testid="add-workspace-dialog"]'),
    ).toBeNull();

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-add-workspace"]')
        ?.click();
    });
    expect(
      container.querySelectorAll('[data-testid="add-workspace-dialog"]'),
    ).toHaveLength(1);
  });

  it('closes the Add workspace dialog when navigation enters a standalone chat', async () => {
    mockWorkspace.capabilities = {
      features: ['dynamic_workspace_registration', 'standalone_sessions_v1'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const { container, rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onOpenExistingWorkspace?.();
    });
    expect(
      container.querySelector('[data-testid="add-workspace-dialog"]'),
    ).not.toBeNull();

    act(() => {
      mockConnection.sessionContext = { kind: 'standalone' };
      mockConnection.workspaceCwd = '';
      rerender();
    });

    expect(
      container.querySelector('[data-testid="add-workspace-dialog"]'),
    ).toBeNull();
  });

  it('closes workspace model settings when navigation enters a standalone chat', async () => {
    const { container, rerender } = renderApp();
    await flush();
    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-fast-model"]')
        ?.click();
    });
    expect(
      container.querySelector('[data-testid="model-select"]'),
    ).not.toBeNull();

    act(() => {
      mockConnection.sessionContext = { kind: 'standalone' };
      mockConnection.workspaceCwd = '';
      rerender();
    });

    expect(container.querySelector('[data-testid="model-select"]')).toBeNull();
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalledWith(
      expect.stringContaining('/model --fast'),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('omits the directory picker on headless daemon hosts', async () => {
    mockWorkspace.capabilities = {
      features: ['dynamic_workspace_registration'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const { container } = renderApp();
    await flush();

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-add-workspace"]')
        ?.click();
    });
    expect(
      container.querySelectorAll('[data-testid="add-workspace-dialog"]'),
    ).toHaveLength(1);
    expect(testState.latestAddWorkspaceDialogProps?.onPick).toBeUndefined();
  });

  it('forwards a supported workspace display name through the shared mutation lane', async () => {
    const added = {
      id: 'payments',
      cwd: '/tmp/payments',
      displayName: 'Payments API',
      primary: false,
      trusted: true,
      persisted: true,
    };
    mockWorkspace.capabilities = {
      features: [
        'dynamic_workspace_registration',
        'persistent_workspace_registration',
        'workspace_display_name',
      ],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    mockWorkspaceActions.addWorkspace.mockResolvedValue(added);
    mockWorkspace.refreshCapabilities.mockResolvedValue({
      ...mockWorkspace.capabilities,
      workspaces: [...mockWorkspace.capabilities.workspaces, added],
    });
    renderApp();
    await flush();
    act(() => {
      testState.latestChatEditorProps?.onOpenExistingWorkspace?.();
    });

    await act(async () => {
      await testState.latestAddWorkspaceDialogProps?.onAdd(
        '/tmp/payments',
        true,
        'Payments API',
      );
    });

    expect(mockWorkspaceActions.addWorkspace).toHaveBeenCalledWith(
      '/tmp/payments',
      { persist: true, displayName: 'Payments API' },
    );
    expect(mockWorkspace.refreshCapabilities).toHaveBeenCalledOnce();
  });

  it('omits unsupported persistence and display-name options', async () => {
    const added = {
      id: 'local',
      cwd: '/tmp/local',
      primary: false,
      trusted: true,
    };
    mockWorkspace.capabilities = {
      features: ['dynamic_workspace_registration'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    mockWorkspaceActions.addWorkspace.mockResolvedValue(added);
    mockWorkspace.refreshCapabilities.mockResolvedValue({
      ...mockWorkspace.capabilities,
      workspaces: [...mockWorkspace.capabilities.workspaces, added],
    });
    renderApp();
    await flush();
    act(() => {
      testState.latestChatEditorProps?.onOpenExistingWorkspace?.();
    });
    expect(testState.latestAddWorkspaceDialogProps).toMatchObject({
      displayNameEnabled: false,
      persistenceSupported: false,
    });

    await act(async () => {
      await testState.latestAddWorkspaceDialogProps?.onAdd(
        '/tmp/local',
        true,
        'Ignored name',
      );
    });

    expect(mockWorkspaceActions.addWorkspace).toHaveBeenCalledWith(
      '/tmp/local',
      { persist: false },
    );
  });

  it('rejects when the daemon does not confirm persistent registration', async () => {
    mockWorkspace.capabilities = {
      features: [
        'dynamic_workspace_registration',
        'persistent_workspace_registration',
      ],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    mockWorkspaceActions.addWorkspace.mockResolvedValue({
      id: 'payments',
      cwd: '/tmp/payments',
      primary: false,
      trusted: true,
      persisted: false,
    });
    renderApp();
    await flush();
    act(() => {
      testState.latestChatEditorProps?.onOpenExistingWorkspace?.();
    });

    await expect(
      testState.latestAddWorkspaceDialogProps?.onAdd('/tmp/payments', true),
    ).rejects.toThrow(
      'The daemon did not confirm persistent workspace registration',
    );
  });

  it('surfaces an inline error when an added folder cannot refresh capabilities', async () => {
    const added = {
      id: 'payments',
      cwd: '/tmp/payments',
      primary: false,
      trusted: true,
    };
    mockWorkspace.capabilities = {
      features: ['dynamic_workspace_registration'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    mockWorkspaceActions.addWorkspace.mockResolvedValue(added);
    mockWorkspace.refreshCapabilities.mockRejectedValueOnce(
      new Error('refresh failed'),
    );
    renderApp();
    await flush();
    act(() => {
      testState.latestChatEditorProps?.onOpenExistingWorkspace?.();
    });

    await expect(
      testState.latestAddWorkspaceDialogProps?.onAdd('/tmp/payments', false),
    ).rejects.toThrow(
      'Workspace added, but the workspace list could not be refreshed',
    );
    expect(mockWorkspaceActions.addWorkspace).toHaveBeenCalledOnce();
  });

  it('retries only capability refresh after a committed scratch cannot reconcile', async () => {
    mockWorkspace.capabilities = {
      features: ['scratch_workspace_registration'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const result = {
      id: 'scratch',
      cwd: '/managed/scratch-retry',
      primary: false,
      trusted: true,
      persisted: false as const,
    };
    const accepted = {
      features: ['scratch_workspace_registration'],
      workspaces: [...mockWorkspace.capabilities.workspaces, { ...result }],
    };
    mockWorkspaceActions.addScratchWorkspace.mockResolvedValue(result);
    mockWorkspace.refreshCapabilities
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValueOnce(accepted);
    renderApp();
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onCreateScratchWorkspace?.();
      await vi.waitFor(() => {
        expect(mockWorkspace.refreshCapabilities).toHaveBeenCalledOnce();
      });
    });
    act(() => {
      testState.latestChatEditorProps?.onCreateScratchWorkspace?.();
    });
    expect(mockWorkspaceActions.addScratchWorkspace).toHaveBeenCalledOnce();

    const refreshButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Refresh workspace list');
    await act(async () => {
      refreshButton?.click();
      await vi.waitFor(() => {
        expect(mockWorkspace.refreshCapabilities).toHaveBeenCalledTimes(2);
        expect(mockSessionActions.clearSession).toHaveBeenCalledOnce();
      });
    });

    expect(mockWorkspaceActions.addScratchWorkspace).toHaveBeenCalledOnce();
  });

  it('locks scratch creation after an unknown outcome until acknowledged', async () => {
    mockWorkspace.capabilities = {
      features: ['scratch_workspace_registration'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    mockWorkspaceActions.addScratchWorkspace.mockRejectedValue(
      new Error('Add scratch workspace timed out'),
    );
    mockWorkspace.refreshCapabilities.mockResolvedValue(
      mockWorkspace.capabilities,
    );
    renderApp();
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onCreateScratchWorkspace?.();
      await vi.waitFor(() => {
        expect(mockWorkspaceActions.addScratchWorkspace).toHaveBeenCalledOnce();
        expect(mockWorkspace.refreshCapabilities).toHaveBeenCalledOnce();
      });
    });
    await flush();
    act(() => {
      testState.latestChatEditorProps?.onCreateScratchWorkspace?.();
    });

    expect(mockWorkspaceActions.addScratchWorkspace).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain('I checked the workspace list');

    const ackButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'I checked the workspace list');
    expect(ackButton).toBeDefined();
    mockWorkspaceActions.addScratchWorkspace.mockResolvedValue({
      id: 'scratch-2',
      cwd: '/managed/scratch-2',
      primary: false,
      trusted: true,
      persisted: false,
    });
    mockWorkspace.refreshCapabilities.mockResolvedValue({
      features: ['scratch_workspace_registration'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
        {
          id: 'scratch-2',
          cwd: '/managed/scratch-2',
          primary: false,
          trusted: true,
        },
      ],
    });
    await act(async () => {
      ackButton?.click();
      await vi.waitFor(() => {
        expect(document.body.textContent).not.toContain(
          'I checked the workspace list',
        );
      });
    });

    await act(async () => {
      testState.latestChatEditorProps?.onCreateScratchWorkspace?.();
      await vi.waitFor(() => {
        expect(mockWorkspaceActions.addScratchWorkspace).toHaveBeenCalledTimes(
          2,
        );
      });
    });
  });

  it('reports a definitive 4xx rejection without locking scratch creation', async () => {
    mockWorkspace.capabilities = {
      features: ['scratch_workspace_registration'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const { DaemonHttpError: MockDaemonHttpError } = await import(
      '@qwen-code/sdk/daemon'
    );
    mockWorkspaceActions.addScratchWorkspace.mockRejectedValue(
      new MockDaemonHttpError(403, {}, 'Forbidden'),
    );
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    renderApp();
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onCreateScratchWorkspace?.();
      await vi.waitFor(() => {
        expect(mockWorkspaceActions.addScratchWorkspace).toHaveBeenCalledOnce();
      });
    });
    await flush();

    expect(consoleError).toHaveBeenCalledWith(
      '[web-shell]',
      expect.stringContaining('Forbidden'),
      expect.anything(),
    );
    expect(document.body.textContent).not.toContain(
      'I checked the workspace list',
    );

    mockWorkspaceActions.addScratchWorkspace.mockResolvedValue({
      id: 'scratch-3',
      cwd: '/managed/scratch-3',
      primary: false,
      trusted: true,
      persisted: false,
    });
    mockWorkspace.refreshCapabilities.mockResolvedValue({
      features: ['scratch_workspace_registration'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
        {
          id: 'scratch-3',
          cwd: '/managed/scratch-3',
          primary: false,
          trusted: true,
        },
      ],
    });
    await act(async () => {
      testState.latestChatEditorProps?.onCreateScratchWorkspace?.();
      await vi.waitFor(() => {
        expect(mockWorkspaceActions.addScratchWorkspace).toHaveBeenCalledTimes(
          2,
        );
      });
    });
    consoleError.mockRestore();
  });

  it('falls back to primary when the draft workspace becomes untrusted', async () => {
    mockConnection.sessionId = undefined;
    mockWorkspace.capabilities = {
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary',
          cwd: '/work/secondary',
          primary: false,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const view = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSelectWorkspace?.('/work/secondary');
    });
    expect(testState.latestChatEditorProps?.selectedWorkspaceCwd).toBe(
      '/work/secondary',
    );

    mockWorkspace.capabilities = {
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary',
          cwd: '/work/secondary',
          primary: false,
          trusted: false,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    view.rerender();
    await flush();

    expect(
      testState.latestChatEditorProps?.selectedWorkspaceCwd,
    ).toBeUndefined();
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('primary prompt');
      await vi.waitFor(() => {
        expect(mockSessionActions.createSession).toHaveBeenCalled();
      });
    });
    expect(mockSessionActions.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceCwd: '/tmp/project' }),
    );
    const promptOptions = mockSessionActions.sendPrompt.mock.calls.at(
      -1,
    )?.[1] as { onAdmitted?: () => void } | undefined;
    act(() => promptOptions?.onAdmitted?.());
    expect(sessionCatalogController.promptAdmitted).toHaveBeenCalledWith(
      '/tmp/project',
      expect.any(String),
    );
    expect(sessionCatalogController.promptAdmitted).not.toHaveBeenCalledWith(
      '/work/secondary',
      expect.any(String),
    );
  });

  it('does not retarget a settled standalone session when a stale workspace selection becomes untrusted', async () => {
    mockConnection.sessionId = 'standalone-a';
    mockConnection.sessionContext = { kind: 'standalone' };
    mockConnection.workspaceCwd = '';
    mockWorkspace.capabilities = {
      features: ['standalone_sessions_v1'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary',
          cwd: '/work/secondary',
          primary: false,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const view = renderApp({
      initialSelectedWorkspaceCwd: '/work/secondary',
    });
    await flush();

    mockWorkspace.capabilities = {
      ...mockWorkspace.capabilities,
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary',
          cwd: '/work/secondary',
          primary: false,
          trusted: false,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    view.rerender({ initialSelectedWorkspaceCwd: '/work/secondary' });
    await flush();

    expect(testState.latestChatEditorProps).toMatchObject({
      composerScopeKey: 'standalone',
      workspaceFeaturesEnabled: false,
    });
  });

  it('creates the first prompt in a newly selected secondary workspace', async () => {
    mockConnection.sessionId = undefined;
    mockConnection.sessionContext = { kind: 'workspace', cwd: '/tmp/project' };
    mockWorkspace.capabilities = {
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary',
          cwd: '/work/secondary',
          primary: false,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSelectWorkspace?.('/work/secondary');
    });
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('secondary prompt');
      await vi.waitFor(() => {
        expect(mockSessionActions.createSession).toHaveBeenCalled();
      });
    });

    expect(mockSessionActions.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceCwd: '/work/secondary',
        sessionContext: { kind: 'workspace', cwd: '/work/secondary' },
      }),
    );
  });

  it('rejects an untrusted draft workspace before its cleanup effect runs', async () => {
    const onToast = vi.fn();
    mockConnection.sessionId = undefined;
    const secondaryWorkspace = {
      id: 'secondary',
      cwd: '/work/secondary',
      primary: false,
      trusted: true,
    };
    mockWorkspace.capabilities = {
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
        secondaryWorkspace,
      ],
    } as typeof mockWorkspace.capabilities;
    renderApp({ onToast });
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSelectWorkspace?.('/work/secondary');
    });
    // Mutate the accepted snapshot in place so the selection ref remains stale
    // and the create-time trust guard, rather than the cleanup effect, is tested.
    secondaryWorkspace.trusted = false;

    act(() => {
      testState.latestChatEditorProps?.onSubmit('blocked prompt');
    });
    await vi.waitFor(() => {
      expect(onToast).toHaveBeenCalledWith(
        'error',
        'The selected workspace is unavailable or untrusted',
      );
    });

    expect(mockSessionActions.createSession).not.toHaveBeenCalled();
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(sessionCatalogController.promptAdmitted).not.toHaveBeenCalled();
  });

  it('does not start a new chat when selecting the active workspace', async () => {
    mockConnection.workspaceCwd = '/tmp/project';
    mockWorkspace.capabilities = {
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSelectWorkspace?.(undefined);
    });

    expect(mockSessionActions.clearSession).not.toHaveBeenCalled();
  });

  it('starts a fresh chat when an active session selects a different trusted workspace', async () => {
    mockConnection.sessionId = 'session-1';
    mockConnection.workspaceCwd = '/tmp/project';
    mockWorkspace.capabilities = {
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary',
          cwd: '/work/secondary',
          primary: false,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    renderApp();
    await flush();

    mockSessionActions.clearSession.mockClear();
    await act(async () => {
      testState.latestChatEditorProps?.onSelectWorkspace?.('/work/secondary');
      await vi.waitFor(() => {
        expect(mockSessionActions.clearSession).toHaveBeenCalled();
      });
    });

    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);
  });

  it('executes one clear when two workspace-switch intents arrive in the same tick', async () => {
    mockConnection.sessionId = 'session-1';
    mockConnection.workspaceCwd = '/tmp/project';
    mockWorkspace.capabilities = {
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary',
          cwd: '/work/secondary',
          primary: false,
          trusted: true,
        },
        {
          id: 'tertiary',
          cwd: '/work/tertiary',
          primary: false,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    renderApp();
    await flush();

    mockSessionActions.clearSession.mockClear();
    act(() => {
      testState.latestChatEditorProps?.onSelectWorkspace?.('/work/secondary');
      testState.latestChatEditorProps?.onSelectWorkspace?.('/work/tertiary');
    });
    await flush();

    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);
  });

  it('keeps composer workspace props stable across an equivalent list refresh', async () => {
    mockWorkspace.capabilities = {
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary',
          cwd: '/work/secondary',
          primary: false,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const view = renderApp();
    await flush();
    const previousProps = testState.latestChatEditorProps;

    mockWorkspace.capabilities = {
      workspaces: mockWorkspace.capabilities.workspaces.map((entry) => ({
        ...entry,
      })),
    } as typeof mockWorkspace.capabilities;
    view.rerender();
    await flush();

    // Voice props are owned by the voice feature, which derives them from the
    // capabilities snapshot identity and so legitimately recomputes them on an
    // equivalent refresh; this assertion guards the workspace props above.
    const VOICE_OWNED_PROPS = new Set(['voiceTarget', 'voiceStatusRevision']);
    const changedProps = Object.keys(previousProps ?? {}).filter(
      (key) =>
        !VOICE_OWNED_PROPS.has(key) &&
        (previousProps as unknown as Record<string, unknown>)[key] !==
          (
            testState.latestChatEditorProps as unknown as Record<
              string,
              unknown
            >
          )[key],
    );
    expect(changedProps).toEqual([]);
    expect(testState.latestChatEditorProps?.workspaces).toBe(
      previousProps?.workspaces,
    );
    expect(testState.latestChatEditorProps?.onSelectWorkspace).toBe(
      previousProps?.onSelectWorkspace,
    );
    expect(testState.latestChatEditorProps?.onCreateScratchWorkspace).toBe(
      previousProps?.onCreateScratchWorkspace,
    );
    expect(testState.latestChatEditorProps?.onOpenExistingWorkspace).toBe(
      previousProps?.onOpenExistingWorkspace,
    );
  });

  it('keeps the Live runtime out of the ordinary composer workspace selector', async () => {
    mockWorkspace.capabilities = {
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
        {
          id: 'live',
          cwd: '/Users/test/Documents/Qwen Code/Conversations',
          displayName: 'Conversations',
          primary: false,
          trusted: true,
          kind: 'live',
        },
      ],
    } as typeof mockWorkspace.capabilities;

    renderApp();
    await flush();

    expect(testState.latestChatEditorProps?.workspaces).toEqual([
      expect.objectContaining({ id: 'primary', cwd: '/tmp/project' }),
    ]);
  });

  it('keeps composer git status stable across an equivalent refresh', async () => {
    const workspaceGit = vi
      .fn()
      .mockResolvedValueOnce({
        v: 2,
        workspaceCwd: '/tmp/project',
        branch: 'main',
        unstaged: 1,
        computedAt: 1,
      })
      .mockResolvedValue({
        v: 2,
        workspaceCwd: '/tmp/project',
        branch: 'main',
        unstaged: 1,
        computedAt: 2,
      });
    mockWorkspace.client.workspaceByCwd.mockImplementation(() => ({
      workspaceGit,
      workspaceSkills: mockWorkspaceActions.loadSkillsStatus,
    }));
    renderApp();
    await vi.waitFor(() => {
      expect(testState.latestChatEditorProps?.gitStatus?.computedAt).toBe(1);
    });
    const previousProps = testState.latestChatEditorProps;

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });

    expect(workspaceGit).toHaveBeenCalledTimes(4);
    expect(testState.latestChatEditorProps?.gitStatus).toBe(
      previousProps?.gitStatus,
    );
    expect(testState.latestChatEditorProps?.onOpenGitDiff).toBe(
      previousProps?.onOpenGitDiff,
    );
  });

  it('creates new sessions in the locked workspace without a selector', async () => {
    mockConnection.sessionId = undefined;
    mockWorkspace.capabilities = {
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true },
        { id: 'secondary', cwd: '/work/secondary', primary: false },
      ],
    };
    renderApp({ lockedWorkspaceCwd: '/work/secondary' });
    await flush();

    expect(testState.latestChatEditorProps?.workspaces).toBeUndefined();
    expect(testState.latestChatEditorProps?.atWorkspaceCwd).toBe(
      '/work/secondary',
    );

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('locked prompt');
      await vi.waitFor(() => {
        expect(mockSessionActions.createSession).toHaveBeenCalled();
      });
    });
    expect(mockSessionActions.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceCwd: '/work/secondary' }),
    );
  });

  it('creates first sessions in the initial unlocked workspace', async () => {
    mockConnection.sessionId = undefined;
    mockWorkspace.capabilities = {
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true, trusted: true },
        {
          id: 'secondary',
          cwd: '/work/secondary',
          primary: false,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    renderApp({ initialSelectedWorkspaceCwd: '/work/secondary' });
    await flush();

    expect(testState.latestChatEditorProps?.selectedWorkspaceCwd).toBe(
      '/work/secondary',
    );

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('secondary prompt');
      await vi.waitFor(() => {
        expect(mockSessionActions.createSession).toHaveBeenCalled();
      });
    });
    expect(mockSessionActions.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceCwd: '/work/secondary' }),
    );
  });

  it('clears the git mode intent when starting a new session from the sidebar', async () => {
    mockConnection.sessionId = undefined;
    mockWorkspace.capabilities = {
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true, trusted: true },
      ],
    };
    mockWorkspace.client.workspaceByCwd.mockImplementation(() => ({
      workspaceGit: vi.fn().mockResolvedValue({ branch: 'main' }),
      workspaceSkills: mockWorkspaceActions.loadSkillsStatus,
    }));
    const { container } = renderApp();
    await flush();
    await flush();

    // Set branch intent via the ChatEditor prop.
    const intentChange = testState.latestChatEditorProps?.onGitModeIntentChange;
    expect(intentChange).toBeDefined();
    act(() => {
      intentChange?.({ mode: 'branch', name: 'feat/test' });
    });
    await flush();

    // Click "New session" from the sidebar — should reset the intent.
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="new-session"]')
        ?.click();
      await Promise.resolve();
    });

    // Submit a message — createSession should NOT include branch.
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('regular session');
      await vi.waitFor(() => {
        expect(mockSessionActions.createSession).toHaveBeenCalled();
      });
    });
    const arg = mockSessionActions.createSession.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(arg?.['branch']).toBeUndefined();
  });

  it('hides the git mode chip when the workspace is not trusted', async () => {
    mockConnection.sessionId = undefined;
    mockWorkspace.capabilities = {
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true, trusted: false },
      ],
    };
    mockWorkspace.client.workspaceByCwd.mockImplementation(() => ({
      workspaceGit: vi.fn().mockResolvedValue({ branch: 'main' }),
      workspaceSkills: mockWorkspaceActions.loadSkillsStatus,
    }));
    renderApp();
    await flush();
    await flush();

    expect(testState.latestChatEditorProps?.gitModeIntent).toBeUndefined();
    expect(
      testState.latestChatEditorProps?.onGitModeIntentChange,
    ).toBeUndefined();
  });

  it('fetches the composer git status on both the fast and the wait:true fresh path', async () => {
    mockConnection.sessionId = undefined;
    mockWorkspace.capabilities = {
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true, trusted: true },
      ],
    };
    const workspaceGit = vi.fn().mockResolvedValue({ branch: 'main' });
    mockWorkspace.client.workspaceByCwd.mockImplementation(() => ({
      workspaceGit,
      workspaceSkills: mockWorkspaceActions.loadSkillsStatus,
    }));
    renderApp();
    await flush();
    await flush();

    // Fast path paints the chip from the daemon's last-known cache; the
    // wait:true fresh path fills in the enriched counters once the daemon's
    // background recomputation lands (no SSE exists before the first
    // prompt). Both share one daemon-side `git status` computation.
    await vi.waitFor(() => {
      expect(workspaceGit).toHaveBeenCalledWith({ cwd: undefined });
      expect(workspaceGit).toHaveBeenCalledWith({ wait: true });
    });
  });

  it('mirrors connection.gitStatus into the composer git chip', async () => {
    mockConnection.sessionId = undefined;
    mockWorkspace.capabilities = {
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true, trusted: true },
      ],
    };
    mockWorkspace.client.workspaceByCwd.mockImplementation(() => ({
      workspaceGit: vi.fn().mockResolvedValue({ branch: 'main' }),
      workspaceSkills: mockWorkspaceActions.loadSkillsStatus,
    }));
    const { rerender } = renderApp();
    await flush();
    await flush();

    expect(testState.latestChatEditorProps?.visibleToolbarActions).toContain(
      'gitBranch',
    );

    // Fast GET applied the branch-only last-known status.
    await vi.waitFor(() => {
      expect(testState.latestChatEditorProps?.gitStatus).toEqual({
        branch: 'main',
      });
    });

    // The daemon's `git_status_changed` push lands as connection.gitStatus
    // (a provider state update in production; simulated here by mutating the
    // connection object and rerendering the provider consumer).
    act(() => {
      mockConnection.gitStatus = {
        v: 2,
        workspaceCwd: '/workspace',
        branch: 'main',
        staged: 2,
        computedAt: 1_700_000_000_000,
      };
    });
    rerender();
    await flush();

    await vi.waitFor(() => {
      expect(testState.latestChatEditorProps?.gitStatus).toMatchObject({
        workspaceCwd: '/workspace',
        branch: 'main',
        staged: 2,
      });
    });
  });

  it('skips the wait:true fresh path for worktree sessions', async () => {
    const worktreePath = '/workspace/.worktrees/feat-a';
    mockWorkspace.client.sessionStatus.mockResolvedValue({
      worktree: { slug: 'feat-a', path: worktreePath, branch: 'feat-a' },
    });
    mockWorkspace.capabilities = {
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true, trusted: true },
      ],
    };
    const workspaceGit = vi.fn().mockResolvedValue({ branch: 'feat-a' });
    mockWorkspace.client.workspaceByCwd.mockImplementation(() => ({
      workspaceGit,
      workspaceSkills: mockWorkspaceActions.loadSkillsStatus,
    }));
    renderApp();
    await flush();
    await flush();

    // The worktree session status lands and the git effect re-runs with the
    // worktree path.
    await vi.waitFor(() => {
      expect(workspaceGit).toHaveBeenCalledWith({ cwd: worktreePath });
    });

    // After the worktree cwd call, no wait:true call should follow — worktree
    // ?cwd= reads compute directly, so a second request would be a duplicate.
    const calls = workspaceGit.mock.calls.map(([arg]) => arg);
    const cwdIndex = calls.findIndex(
      (arg: Record<string, unknown>) => arg?.cwd === worktreePath,
    );
    const waitAfter = calls
      .slice(cwdIndex + 1)
      .filter((arg: Record<string, unknown>) => arg?.wait === true);
    expect(waitAfter).toHaveLength(0);
  });

  it('forwards the branch intent to createSession when submitting a prompt', async () => {
    mockConnection.sessionId = undefined;
    mockWorkspace.capabilities = {
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true, trusted: true },
      ],
    };
    mockWorkspace.client.workspaceByCwd.mockImplementation(() => ({
      workspaceGit: vi.fn().mockResolvedValue({ branch: 'main' }),
      workspaceSkills: mockWorkspaceActions.loadSkillsStatus,
    }));
    renderApp();
    await flush();
    await flush();

    const intentChange = testState.latestChatEditorProps?.onGitModeIntentChange;
    expect(intentChange).toBeDefined();
    act(() => {
      intentChange?.({ mode: 'branch', name: 'feat/test' });
    });
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('branch session');
      await vi.waitFor(() => {
        expect(mockSessionActions.createSession).toHaveBeenCalled();
      });
    });

    expect(mockSessionActions.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ branch: { name: 'feat/test' } }),
    );
  });

  it('forwards the worktree intent to createSession when submitting a prompt', async () => {
    mockConnection.sessionId = undefined;
    mockWorkspace.capabilities = {
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true, trusted: true },
      ],
    };
    mockWorkspace.client.workspaceByCwd.mockImplementation(() => ({
      workspaceGit: vi.fn().mockResolvedValue({ branch: 'main' }),
      workspaceSkills: mockWorkspaceActions.loadSkillsStatus,
    }));
    renderApp();
    await flush();
    await flush();

    const intentChange = testState.latestChatEditorProps?.onGitModeIntentChange;
    expect(intentChange).toBeDefined();
    act(() => {
      intentChange?.({ mode: 'worktree', slug: 'feat-a' });
    });
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('worktree session');
      await vi.waitFor(() => {
        expect(mockSessionActions.createSession).toHaveBeenCalled();
      });
    });

    expect(mockSessionActions.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ worktree: { slug: 'feat-a' } }),
    );
  });

  it('keeps an armed worktree intent across a transient git-status failure', async () => {
    mockConnection.sessionId = undefined;
    mockWorkspace.capabilities = {
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true, trusted: true },
      ],
    };
    const workspaceGit = vi.fn().mockResolvedValue({ branch: 'main' });
    mockWorkspace.client.workspaceByCwd.mockImplementation(() => ({
      workspaceGit,
      workspaceSkills: mockWorkspaceActions.loadSkillsStatus,
    }));
    renderApp();
    await flush();
    await flush();

    const intentChange = testState.latestChatEditorProps?.onGitModeIntentChange;
    act(() => {
      intentChange?.({ mode: 'worktree', slug: 'feat-a' });
    });
    await flush();
    expect(testState.latestChatEditorProps?.gitModeIntent).toEqual({
      mode: 'worktree',
      slug: 'feat-a',
    });

    // One refetch round fails (daemon busy, network blip): the status is
    // transiently unknown, but the requested worktree must not silently
    // degrade to a plain session once the status recovers.
    workspaceGit.mockRejectedValueOnce(new Error('daemon busy'));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();
    await flush();
    expect(testState.latestChatEditorProps?.gitModeIntent).toEqual({
      mode: 'worktree',
      slug: 'feat-a',
    });
  });

  it('arms the worktree intent from the sidebar entry, unless another session start intervened', async () => {
    mockConnection.sessionId = undefined;
    mockWorkspace.capabilities = {
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true, trusted: true },
      ],
    };
    mockWorkspace.client.workspaceByCwd.mockImplementation(() => ({
      workspaceGit: vi.fn().mockResolvedValue({ branch: 'main' }),
      workspaceSkills: mockWorkspaceActions.loadSkillsStatus,
    }));
    const { container } = renderApp();
    await flush();
    await flush();
    const worktreeButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="new-worktree-session"]',
    )!;
    const newSessionButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="new-session"]',
    )!;

    // Alone: the draft is armed for a worktree.
    await act(async () => {
      worktreeButton.click();
      await Promise.resolve();
    });
    await flush();
    await flush();
    expect(testState.latestChatEditorProps?.gitModeIntent).toEqual({
      mode: 'worktree',
    });

    // A plain new task started while the worktree creation is still in
    // flight owns the draft; the late arm must not land on it.
    await act(async () => {
      worktreeButton.click();
      newSessionButton.click();
      await Promise.resolve();
    });
    await flush();
    await flush();
    expect(testState.latestChatEditorProps?.gitModeIntent).toEqual({
      mode: 'current',
    });
  });

  it('gives a prompt submitted while the worktree draft is still clearing the worktree', async () => {
    mockConnection.sessionId = undefined;
    mockWorkspace.capabilities = {
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true, trusted: true },
      ],
    };
    mockWorkspace.client.workspaceByCwd.mockImplementation(() => ({
      workspaceGit: vi.fn().mockResolvedValue({ branch: 'main' }),
      workspaceSkills: mockWorkspaceActions.loadSkillsStatus,
    }));
    let resolveClear: () => void = () => {};
    mockSessionActions.clearSession.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveClear = resolve;
        }),
    );
    const { container } = renderApp();
    await flush();
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="new-worktree-session"]',
        )!
        .click();
      await Promise.resolve();
    });
    // The clear is still in flight; the intent is already the draft's.
    expect(testState.latestChatEditorProps?.gitModeIntent).toEqual({
      mode: 'worktree',
    });
    await act(async () => {
      resolveClear();
      await Promise.resolve();
    });
    await flush();
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('first prompt');
      await vi.waitFor(() => {
        expect(mockSessionActions.createSession).toHaveBeenCalled();
      });
    });
    expect(mockSessionActions.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ worktree: { slug: undefined } }),
    );
  });

  it('drops the worktree intent when the draft is re-targeted before it settles', async () => {
    mockConnection.sessionId = undefined;
    mockWorkspace.capabilities = {
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true, trusted: true },
        { id: 'other', cwd: '/other', primary: false, trusted: true },
      ],
    };
    mockWorkspace.client.workspaceByCwd.mockImplementation(() => ({
      workspaceGit: vi.fn().mockResolvedValue({ branch: 'main' }),
      workspaceSkills: mockWorkspaceActions.loadSkillsStatus,
    }));
    let resolveClear: () => void = () => {};
    mockSessionActions.clearSession.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveClear = resolve;
        }),
    );
    const { container } = renderApp();
    await flush();
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="new-worktree-session"]',
        )!
        .click();
      await Promise.resolve();
    });
    // The sidebar re-targets the draft while the clear is still in flight.
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="select-other-workspace"]',
        )!
        .click();
      await Promise.resolve();
    });
    await act(async () => {
      resolveClear();
      await Promise.resolve();
    });
    await flush();
    await flush();
    expect(testState.latestChatEditorProps?.gitModeIntent).toEqual({
      mode: 'current',
    });
  });

  it('keeps the worktree intent when the composer re-selects the draft workspace', async () => {
    mockConnection.sessionId = undefined;
    mockWorkspace.capabilities = {
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true, trusted: true },
        { id: 'other', cwd: '/other', primary: false, trusted: true },
      ],
    };
    mockWorkspace.client.workspaceByCwd.mockImplementation((cwd: string) => ({
      workspaceGit: vi
        .fn()
        .mockResolvedValue({ v: 2, workspaceCwd: cwd, branch: 'main' }),
      workspaceSkills: mockWorkspaceActions.loadSkillsStatus,
    }));
    renderApp();
    await flush();
    await flush();
    act(() => {
      testState.latestChatEditorProps?.onSelectWorkspace?.('/other');
    });
    await flush();
    await flush();
    act(() => {
      testState.latestChatEditorProps?.onGitModeIntentChange?.({
        mode: 'worktree',
        slug: 'feat-a',
      });
    });
    await flush();
    expect(testState.latestChatEditorProps?.gitModeIntent).toEqual({
      mode: 'worktree',
      slug: 'feat-a',
    });

    // Radix fires onValueChange for the already-checked radio row too; a
    // re-select of the draft's own workspace changes nothing.
    act(() => {
      testState.latestChatEditorProps?.onSelectWorkspace?.('/other');
    });
    await flush();
    await flush();
    expect(testState.latestChatEditorProps?.gitModeIntent).toEqual({
      mode: 'worktree',
      slug: 'feat-a',
    });

    // A real switch still drops it.
    act(() => {
      testState.latestChatEditorProps?.onSelectWorkspace?.(undefined);
    });
    await flush();
    await flush();
    expect(testState.latestChatEditorProps?.gitModeIntent).toEqual({
      mode: 'current',
    });
  });

  it("keeps a worktree intent armed for another workspace across the draft's stale no-branch status", async () => {
    mockConnection.sessionId = undefined;
    mockWorkspace.capabilities = {
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true, trusted: true },
        { id: 'other', cwd: '/other', primary: false, trusted: true },
      ],
    };
    // The primary is not a repository; the daemon answers a definitive
    // no-branch status for it. The secondary is a repo on main.
    mockWorkspace.client.workspaceByCwd.mockImplementation((cwd: string) => ({
      workspaceGit: vi
        .fn()
        .mockResolvedValue(
          cwd === '/other'
            ? { v: 2, workspaceCwd: '/other', branch: 'main' }
            : { v: 2, workspaceCwd: '/workspace', branch: null },
        ),
      workspaceSkills: mockWorkspaceActions.loadSkillsStatus,
    }));
    const { container } = renderApp();
    await flush();
    await flush();
    expect(testState.latestChatEditorProps?.gitModeIntent).toBeUndefined();

    // "New worktree task" on the secondary's row while the draft still
    // holds the primary's no-branch answer.
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="new-worktree-session-other"]',
        )!
        .click();
      await Promise.resolve();
    });
    await flush();
    await flush();
    expect(testState.latestChatEditorProps?.gitModeIntent).toEqual({
      mode: 'worktree',
    });
    act(() => {
      testState.latestChatEditorProps?.onSubmit('first prompt');
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.createSession).toHaveBeenCalled();
    });
    expect(mockSessionActions.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceCwd: '/other',
        worktree: { slug: undefined },
      }),
    );
  });

  it("clears the worktree intent once the draft workspace's own status turns definitively no-branch", async () => {
    mockConnection.sessionId = undefined;
    mockWorkspace.capabilities = {
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true, trusted: true },
      ],
    };
    const workspaceGit = vi
      .fn()
      .mockResolvedValue({ v: 2, workspaceCwd: '/workspace', branch: 'main' });
    mockWorkspace.client.workspaceByCwd.mockImplementation(() => ({
      workspaceGit,
      workspaceSkills: mockWorkspaceActions.loadSkillsStatus,
    }));
    renderApp();
    await flush();
    await flush();
    act(() => {
      testState.latestChatEditorProps?.onGitModeIntentChange?.({
        mode: 'worktree',
        slug: 'feat-a',
      });
    });
    await flush();
    expect(testState.latestChatEditorProps?.gitModeIntent).toEqual({
      mode: 'worktree',
      slug: 'feat-a',
    });

    // The repository is gone (.git removed): the daemon now answers a
    // definitive no-branch status for this very workspace.
    workspaceGit.mockResolvedValue({
      v: 2,
      workspaceCwd: '/workspace',
      branch: null,
    });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();
    await flush();
    // The chip is gone with the branch; the reset is observable on the
    // session the next prompt creates.
    expect(testState.latestChatEditorProps?.gitModeIntent).toBeUndefined();
    act(() => {
      testState.latestChatEditorProps?.onSubmit('first prompt');
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.createSession).toHaveBeenCalled();
    });
    expect(mockSessionActions.createSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ worktree: expect.anything() }),
    );
  });

  it('reloads skills from the target workspace when starting a new session', async () => {
    const { container } = renderApp({
      lockedWorkspaceCwd: '/work/secondary',
    });
    await flush();
    mockWorkspace.client.workspaceByCwd.mockClear();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="new-session"]')
        ?.click();
      await Promise.resolve();
    });

    expect(mockWorkspace.client.workspaceByCwd).toHaveBeenCalledWith(
      '/work/secondary',
    );
  });

  it('uses a registered capability fallback while the workspace list is stale', async () => {
    mockConnection.sessionId = undefined;
    mockWorkspace.capabilities = {
      workspaceCwd: '/workspace',
      workspaces: undefined,
    };
    const lockedWorkspaceCapability = {
      id: 'secondary',
      cwd: '/work/secondary',
      primary: false,
      trusted: true,
    };
    testState.prompt = '/schedule';
    const { container } = renderApp({
      lockedWorkspaceCwd: '/work/secondary',
      lockedWorkspaceCapability,
    });
    await flush();
    await clickSubmit(container);
    await flush();

    expect(testState.latestScheduledTasksProps?.workspaces).toEqual([
      lockedWorkspaceCapability,
    ]);
    expect(testState.latestScheduledTasksProps?.lockedWorkspace).toEqual(
      lockedWorkspaceCapability,
    );
  });

  it('refreshes pending interactions when the live prompt boundary settles', async () => {
    mockWorkspace.capabilities = {
      features: ['scheduled_task_session_reuse'],
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true, trusted: true },
      ],
    };
    const activeStatus = deferred<DaemonSessionSummary>();
    const settledStatus = deferred<DaemonSessionSummary>();
    mockWorkspace.client.sessionStatus
      .mockReturnValueOnce(activeStatus.promise)
      .mockReturnValueOnce(settledStatus.promise);
    testState.sessionHasActivePrompt = true;
    testState.prompt = '/schedule';
    const { container, rerender } = renderApp();
    await flush();
    await clickSubmit(container);
    await flush();

    testState.sessionHasActivePrompt = false;
    rerender();
    await flush();

    settledStatus.resolve({
      sessionId: mockConnection.sessionId,
      workspaceCwd: mockConnection.workspaceCwd,
      hasActivePrompt: false,
      pendingInteractionCount: 0,
    });
    await flush();
    await vi.waitFor(() => {
      expect(
        testState.latestScheduledTasksProps?.currentSession
          ?.pendingInteractionCount,
      ).toBe(0);
    });

    activeStatus.resolve({
      sessionId: mockConnection.sessionId,
      workspaceCwd: mockConnection.workspaceCwd,
      hasActivePrompt: true,
      pendingInteractionCount: 1,
    });
    await flush();

    expect(
      testState.latestScheduledTasksProps?.currentSession
        ?.pendingInteractionCount,
    ).toBe(0);
    expect(
      testState.latestScheduledTasksProps?.currentSessionSchedulingAvailable,
    ).toBe(true);
    expect(mockWorkspace.client.sessionStatus).toHaveBeenCalledTimes(2);
  });

  it('uses configured composer placeholders by state and falls back for blank values', async () => {
    const composerPlaceholders = {
      idle: 'Ask a question',
      processing: 'Working on it',
    };
    const { rerender } = renderApp({ composerPlaceholders });
    await flush();

    expect(testState.latestChatEditorProps?.placeholderText).toBe(
      'Ask a question',
    );

    testState.streamingState = 'responding';
    rerender({ composerPlaceholders });
    await flush();
    expect(testState.latestChatEditorProps?.placeholderText).toBe(
      'Working on it',
    );

    rerender({ composerPlaceholders: { idle: 'Ask a question' } });
    await flush();
    expect(testState.latestChatEditorProps?.placeholderText).toBe(
      'Processing. New messages will be queued.',
    );

    mockConnection.catchingUp = true;
    rerender({ composerPlaceholders });
    await flush();
    // Catch-up no longer overrides the streaming placeholder: the composer
    // keeps its processing text while history replays in the background.
    expect(testState.latestChatEditorProps?.placeholderText).toBe(
      'Working on it',
    );

    mockConnection.catchingUp = false;
    testState.streamingState = 'idle';
    rerender({ composerPlaceholders: { idle: '   ' } });
    await flush();
    expect(testState.latestChatEditorProps?.placeholderText).toBe(
      'Type a message or @ file path',
    );
  });

  it('filters disabled skills from the web-shell skills list', async () => {
    mockConnection.sessionId = undefined;
    mockWorkspaceActions.loadSkillsStatus.mockResolvedValue({
      skills: [
        {
          name: 'enabled-skill',
          description: 'Enabled',
          status: 'ok',
        },
        {
          name: 'disabled-extension-skill',
          description: 'Disabled',
          status: 'disabled',
        },
      ],
    });

    renderApp();
    await flush();

    expect(testState.latestChatEditorProps?.skills).toEqual([
      { name: 'enabled-skill', description: 'Enabled' },
    ]);
  });

  it('reloads skills when starting a new session', async () => {
    mockConnection.sessionId = undefined;
    mockConnection.commands = [
      {
        name: 'review',
        description: 'Review',
        raw: {
          name: 'review',
          description: 'Review',
          input: null,
          _meta: { source: 'skill' },
        },
      },
    ];
    mockConnection.skills = ['review'];
    mockWorkspaceActions.loadSkillsStatus.mockResolvedValue({
      skills: [{ name: 'review', description: 'Review', status: 'ok' }],
    });
    const { container } = renderApp();
    await flush();
    expect(testState.latestChatEditorProps?.skills).toEqual([
      { name: 'review', description: 'Review' },
    ]);
    expect(testState.latestChatEditorProps?.commands).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'review' })]),
    );

    mockWorkspaceActions.loadSkillsStatus.mockResolvedValue({
      skills: [{ name: 'review', description: 'Review', status: 'disabled' }],
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="new-session"]')
        ?.click();
      await Promise.resolve();
    });

    expect(testState.latestChatEditorProps?.skills).toEqual([]);
    expect(testState.latestChatEditorProps?.commands).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'review' })]),
    );
    expect(mockWorkspaceActions.loadSkillsStatus).toHaveBeenCalledTimes(2);
  });

  it('adds an enabled skill command when starting a new session', async () => {
    mockConnection.sessionId = undefined;
    mockWorkspaceActions.loadSkillsStatus.mockResolvedValue({
      skills: [{ name: 'review', description: 'Review', status: 'disabled' }],
    });
    const { container } = renderApp();
    await flush();
    expect(testState.latestChatEditorProps?.commands).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'review' })]),
    );

    mockWorkspaceActions.loadSkillsStatus.mockResolvedValue({
      skills: [
        {
          name: 'review',
          description: 'Review',
          argumentHint: '<path>',
          status: 'ok',
        },
      ],
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="new-session"]')
        ?.click();
      await Promise.resolve();
    });

    expect(testState.latestChatEditorProps?.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'review',
          argumentHint: '<path>',
          source: 'skill',
        }),
      ]),
    );
  });

  it('uses the active session command snapshot for Skill enable and empty disable updates', async () => {
    mockWorkspaceActions.loadSkillsStatus.mockResolvedValue({
      skills: [
        {
          name: 'stale-skill',
          description: 'Stale workspace snapshot',
          status: 'ok',
        },
      ],
    });
    const { rerender } = renderApp();
    await flush();

    expect(testState.latestChatEditorProps?.skills).toEqual([]);
    expect(testState.latestChatEditorProps?.commands).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'stale-skill' }),
      ]),
    );

    mockConnection.commands = [
      {
        name: 'web-search',
        description: 'Search the web',
        source: 'skill',
        raw: {
          name: 'web-search',
          description: 'Search the web',
          input: null,
          _meta: { source: 'skill' },
        },
      },
    ];
    mockConnection.skills = ['web-search'];
    testState.workspaceEventSignals = {
      ...testState.workspaceEventSignals,
      skillsVersion: 1,
      lastSkillMutation: {
        id: 'enable-web-search',
        kind: 'skill_toggle',
        skills: [{ name: 'web-search', enabled: true }],
        activation: 'applied',
        sessionsRefreshed: 1,
        sessionsFailed: 0,
      },
    };
    rerender();
    await flush();

    expect(testState.latestChatEditorProps?.skills).toEqual([
      { name: 'web-search', description: 'Search the web' },
    ]);
    expect(testState.latestChatEditorProps?.commands).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'web-search' })]),
    );

    mockConnection.commands = [];
    mockConnection.skills = [];
    testState.workspaceEventSignals = {
      ...testState.workspaceEventSignals,
      skillsVersion: 2,
      lastSkillMutation: {
        id: 'disable-web-search',
        kind: 'skill_toggle',
        skills: [{ name: 'web-search', enabled: false }],
        activation: 'applied',
        sessionsRefreshed: 1,
        sessionsFailed: 0,
      },
    };
    rerender();
    await flush();

    expect(testState.latestChatEditorProps?.skills).toEqual([]);
    expect(testState.latestChatEditorProps?.commands).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'web-search' })]),
    );
    expect(mockWorkspaceActions.loadSkillsStatus).toHaveBeenCalledTimes(1);
    expect(mockSessionActions.reloadSession).not.toHaveBeenCalled();
  });

  it('refreshes workspace Skills when an applied toggle refreshed no sessions', async () => {
    mockConnection.commands = [
      skillCommandFixture('web-search', 'Search the web'),
    ];
    mockConnection.skills = ['web-search'];
    const { rerender } = renderApp();
    await flush();
    expect(testState.latestChatEditorProps?.skills).toEqual([
      { name: 'web-search', description: 'Search the web' },
    ]);

    emitSkillMutation(
      'applied-web-search-without-refreshed-session',
      [{ name: 'web-search', enabled: false }],
      'applied',
      0,
    );
    rerender();
    await flush();

    await vi.waitFor(() => {
      expect(mockWorkspaceActions.loadSkillsStatus).toHaveBeenCalledTimes(2);
      expect(testState.latestChatEditorProps?.skills).toEqual([]);
    });
    expect(testState.latestChatEditorProps?.commands).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'web-search' })]),
    );
  });

  it('refreshes session-less composer Skills once for a deferred mutation', async () => {
    mockConnection.sessionId = undefined;
    mockWorkspaceActions.loadSkillsStatus
      .mockResolvedValueOnce({
        skills: [
          {
            name: 'web-search',
            description: 'Search the web',
            status: 'disabled',
          },
        ],
      })
      .mockResolvedValue({
        skills: [
          {
            name: 'web-search',
            description: 'Search the web',
            status: 'ok',
          },
        ],
      });
    const { rerender } = renderApp();
    await flush();
    expect(testState.latestChatEditorProps?.skills).toEqual([]);

    testState.workspaceEventSignals = {
      ...testState.workspaceEventSignals,
      skillsVersion: 1,
      lastSkillMutation: {
        id: 'deferred-web-search',
        kind: 'skill_toggle',
        skills: [{ name: 'web-search', enabled: true }],
        activation: 'deferred',
        sessionsRefreshed: 0,
        sessionsFailed: 0,
      },
    };
    rerender();
    await flush();
    await vi.waitFor(() => {
      expect(testState.latestChatEditorProps?.skills).toEqual([
        { name: 'web-search', description: 'Search the web' },
      ]);
    });

    rerender();
    await flush();
    expect(mockWorkspaceActions.loadSkillsStatus).toHaveBeenCalledTimes(2);
    expect(mockSessionActions.reloadSession).not.toHaveBeenCalled();
  });

  it('uses a refreshed workspace Skill snapshot after partial activation', async () => {
    mockConnection.commands = [
      {
        name: 'web-search',
        description: 'Search the web',
        source: 'skill',
        raw: {
          name: 'web-search',
          description: 'Search the web',
          input: null,
          _meta: { source: 'skill' },
        },
      },
    ];
    mockConnection.skills = ['web-search'];
    mockWorkspaceActions.loadSkillsStatus
      .mockResolvedValueOnce({
        skills: [
          {
            name: 'web-search',
            description: 'Search the web',
            status: 'ok',
          },
        ],
      })
      .mockResolvedValue({
        skills: [
          {
            name: 'web-search',
            description: 'Search the web',
            status: 'disabled',
          },
        ],
      });
    const { rerender } = renderApp();
    await flush();
    expect(testState.latestChatEditorProps?.skills).toHaveLength(1);

    testState.workspaceEventSignals = {
      ...testState.workspaceEventSignals,
      skillsVersion: 1,
      lastSkillMutation: {
        id: 'partial-web-search',
        kind: 'skill_toggle',
        skills: [{ name: 'web-search', enabled: false }],
        activation: 'partial',
        sessionsRefreshed: 0,
        sessionsFailed: 1,
      },
    };
    rerender();
    await flush();
    await vi.waitFor(() => {
      expect(testState.latestChatEditorProps?.skills).toEqual([]);
    });

    expect(testState.latestChatEditorProps?.commands).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'web-search' })]),
    );
    expect(mockWorkspaceActions.loadSkillsStatus).toHaveBeenCalledTimes(2);

    mockConnection.commands = [
      {
        name: 'review',
        description: 'Review changes',
        source: 'skill',
        raw: {
          name: 'review',
          description: 'Review changes',
          input: null,
          _meta: { source: 'skill' },
        },
      },
    ];
    mockConnection.skills = ['review'];
    rerender();
    await flush();
    await flush();

    expect(testState.latestChatEditorProps?.skills).toEqual([
      { name: 'review', description: 'Review changes' },
    ]);
  });

  it('removes declaration-only enables from a mixed pending mutation', async () => {
    const lockedStatus = {
      skills: [
        {
          name: 'locked',
          description: 'Locked by user settings',
          status: 'disabled' as const,
          disabledReason: 'hard' as const,
          lockedScope: 'user' as const,
        },
        {
          name: 'other',
          description: 'Other skill',
          status: 'ok' as const,
        },
        {
          name: 'review',
          description: 'Review code',
          status: 'ok' as const,
        },
        {
          name: 'review',
          description: 'Inactive Extension copy',
          status: 'disabled' as const,
          disabledReason: 'inactive_extension' as const,
        },
      ],
    };
    mockWorkspaceActions.loadSkillsStatus.mockResolvedValue(lockedStatus);
    mockConnection.commands = [skillCommandFixture('other', 'Other skill')];
    mockConnection.skills = ['other'];
    const { rerender } = renderApp();
    await flush();

    emitPartialSkillMutation('enable-mixed-declarations', [
      { name: 'locked', enabled: true },
      { name: 'review', enabled: true },
    ]);
    rerender();
    await vi.waitFor(() => {
      expect(mockWorkspaceActions.loadSkillsStatus).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => {
      expect(testState.latestChatEditorProps?.skills).toEqual([
        { name: 'other', description: 'Other skill' },
        { name: 'review', description: 'Review code' },
      ]);
    });

    mockConnection.commands = [
      skillCommandFixture('other', 'Other skill'),
      skillCommandFixture('review', 'Review code'),
      skillCommandFixture('late', 'Late session skill'),
    ];
    mockConnection.skills = ['other', 'review', 'late'];
    rerender();
    await flush();

    expect(testState.latestChatEditorProps?.skills).toEqual([
      { name: 'late', description: 'Late session skill' },
      { name: 'other', description: 'Other skill' },
      { name: 'review', description: 'Review code' },
    ]);

    emitSkillMutation(
      'applied-after-mixed',
      [{ name: 'other', enabled: true }],
      'applied',
    );
    rerender();
    await flush();
    expect(mockWorkspaceActions.loadSkillsStatus).toHaveBeenCalledTimes(2);
  });

  it('revalidates a partial Skill mutation only within its workspace', async () => {
    const enabledStatus = {
      skills: [
        {
          name: 'web-search',
          description: 'Search the web',
          status: 'ok' as const,
        },
      ],
    };
    const disabledStatus = {
      skills: [
        {
          name: 'web-search',
          description: 'Search the web',
          status: 'disabled' as const,
        },
      ],
    };
    const switchedSessionRefresh = deferred<typeof disabledStatus>();
    mockConnection.commands = [
      skillCommandFixture('web-search', 'Search the web'),
    ];
    mockConnection.skills = ['web-search'];
    mockWorkspaceActions.loadSkillsStatus
      .mockResolvedValueOnce(enabledStatus)
      .mockResolvedValueOnce(disabledStatus)
      .mockReturnValue(switchedSessionRefresh.promise);
    const { rerender } = renderApp();
    await flush();

    emitPartialSkillMutation('partial-web-search-session-switch', [
      { name: 'web-search', enabled: false },
    ]);
    rerender();
    await vi.waitFor(() => {
      expect(testState.latestChatEditorProps?.skills).toEqual([]);
    });

    mockConnection.sessionId = 'session-2';
    rerender();
    await vi.waitFor(() => {
      expect(mockWorkspaceActions.loadSkillsStatus).toHaveBeenCalledTimes(3);
    });
    mockConnection.skills = ['web-search'];
    rerender();
    await act(async () => {
      switchedSessionRefresh.resolve(disabledStatus);
      await switchedSessionRefresh.promise;
    });
    await flush();

    expect(testState.latestChatEditorProps?.skills).toEqual([]);
    expect(testState.latestChatEditorProps?.commands).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'web-search' })]),
    );
    expect(mockWorkspaceActions.loadSkillsStatus).toHaveBeenCalledTimes(3);

    emitPartialSkillMutation('partial-web-search-session-switch', [
      { name: 'web-search', enabled: false },
    ]);
    rerender();
    await flush();
    expect(mockWorkspaceActions.loadSkillsStatus).toHaveBeenCalledTimes(3);

    mockWorkspaceActions.loadSkillsStatus.mockResolvedValue({ skills: [] });
    mockConnection.sessionId = 'session-3';
    mockConnection.workspaceCwd = '/tmp/other-project';
    rerender();
    await vi.waitFor(() => {
      expect(mockWorkspaceActions.loadSkillsStatus).toHaveBeenCalledTimes(4);
    });
    expect(testState.latestChatEditorProps?.skills).toEqual([
      { name: 'web-search', description: 'Search the web' },
    ]);

    mockConnection.sessionId = 'session-2';
    mockConnection.workspaceCwd = '/tmp/project';
    rerender();
    await vi.waitFor(() => {
      expect(testState.latestChatEditorProps?.skills).toEqual([]);
    });
    expect(mockWorkspaceActions.loadSkillsStatus).toHaveBeenCalledTimes(6);

    mockConnection.status = 'connecting';
    mockConnection.sessionId = undefined;
    rerender();
    await flush();
    mockConnection.status = 'connected';
    mockConnection.sessionId = 'session-2';
    rerender();
    await vi.waitFor(() => {
      expect(testState.latestChatEditorProps?.skills).toEqual([]);
    });
    expect(mockWorkspaceActions.loadSkillsStatus).toHaveBeenCalledTimes(8);
  });

  it('keeps an in-flight partial Skill mutation when a later mutation is applied', async () => {
    const pendingPartialRefresh = deferred<{
      skills: Array<{
        name: string;
        description: string;
        status: 'disabled';
      }>;
    }>();
    const disabledStatus = {
      skills: [
        {
          name: 'web-search',
          description: 'Search the web',
          status: 'disabled' as const,
        },
      ],
    };
    mockConnection.commands = [
      skillCommandFixture('web-search', 'Search the web'),
    ];
    mockConnection.skills = ['web-search'];
    mockWorkspaceActions.loadSkillsStatus
      .mockResolvedValueOnce({
        skills: [
          {
            name: 'web-search',
            description: 'Search the web',
            status: 'ok',
          },
        ],
      })
      .mockReturnValueOnce(pendingPartialRefresh.promise)
      .mockResolvedValue(disabledStatus);
    const { rerender } = renderApp();
    await flush();

    emitPartialSkillMutation('partial-web-search-batch', [
      { name: 'web-search', enabled: false },
    ]);
    rerender();
    await vi.waitFor(() => {
      expect(mockWorkspaceActions.loadSkillsStatus).toHaveBeenCalledTimes(2);
    });

    emitSkillMutation(
      'applied-review-batch',
      [{ name: 'review', enabled: false }],
      'applied',
    );
    rerender();
    await flush();

    await vi.waitFor(() => {
      expect(mockWorkspaceActions.loadSkillsStatus).toHaveBeenCalledTimes(3);
      expect(testState.latestChatEditorProps?.skills).toEqual([]);
    });
    expect(testState.latestChatEditorProps?.commands).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'web-search' })]),
    );

    await act(async () => {
      pendingPartialRefresh.resolve(disabledStatus);
      await pendingPartialRefresh.promise;
    });
    await flush();
    expect(testState.latestChatEditorProps?.skills).toEqual([]);
  });

  it('reconciles every Skill mutation delivered in one signal update', async () => {
    const partialDisable: DaemonSkillToggleMutation = {
      id: 'partial-web-search-single-update',
      kind: 'skill_toggle',
      skills: [{ name: 'web-search', enabled: false }],
      activation: 'partial',
      sessionsRefreshed: 0,
      sessionsFailed: 1,
    };
    const appliedReview: DaemonSkillToggleMutation = {
      id: 'applied-review-single-update',
      kind: 'skill_toggle',
      skills: [{ name: 'review', enabled: false }],
      activation: 'applied',
      sessionsRefreshed: 1,
      sessionsFailed: 0,
    };
    mockConnection.commands = [
      skillCommandFixture('web-search', 'Search the web'),
    ];
    mockConnection.skills = ['web-search'];
    mockWorkspaceActions.loadSkillsStatus
      .mockResolvedValueOnce({
        skills: [
          {
            name: 'web-search',
            description: 'Search the web',
            status: 'ok',
          },
        ],
      })
      .mockResolvedValue({
        skills: [
          {
            name: 'web-search',
            description: 'Search the web',
            status: 'disabled',
          },
        ],
      });
    const { rerender } = renderApp();
    await flush();

    testState.workspaceEventSignals = {
      ...testState.workspaceEventSignals,
      skillsVersion: 2,
      lastSkillMutation: appliedReview,
      skillMutationsByCwd: {
        [mockConnection.workspaceCwd]: [partialDisable, appliedReview],
      },
    };
    rerender();
    await flush();

    await vi.waitFor(() => {
      expect(mockWorkspaceActions.loadSkillsStatus).toHaveBeenCalledTimes(2);
      expect(testState.latestChatEditorProps?.skills).toEqual([]);
    });
    expect(testState.latestChatEditorProps?.commands).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'web-search' })]),
    );
  });

  it('revalidates a cancelled mutation after another workspace mutates', async () => {
    const pendingWorkspaceARefresh = deferred<{
      skills: Array<{
        name: string;
        description: string;
        status: 'disabled';
      }>;
    }>();
    const enabledStatus = {
      skills: [
        {
          name: 'web-search',
          description: 'Search the web',
          status: 'ok' as const,
        },
      ],
    };
    const disabledStatus = {
      skills: [
        {
          name: 'web-search',
          description: 'Search the web',
          status: 'disabled' as const,
        },
      ],
    };
    mockConnection.commands = [
      skillCommandFixture('web-search', 'Search the web'),
    ];
    mockConnection.skills = ['web-search'];
    mockWorkspaceActions.loadSkillsStatus
      .mockResolvedValueOnce(enabledStatus)
      .mockReturnValueOnce(pendingWorkspaceARefresh.promise)
      .mockResolvedValue(disabledStatus);
    const { rerender } = renderApp();
    await flush();

    emitPartialSkillMutation('partial-web-search-workspace-a', [
      { name: 'web-search', enabled: false },
    ]);
    rerender();
    await vi.waitFor(() => {
      expect(mockWorkspaceActions.loadSkillsStatus).toHaveBeenCalledTimes(2);
    });

    mockConnection.workspaceCwd = '/tmp/other-project';
    mockConnection.sessionId = 'session-2';
    mockConnection.commands = [];
    mockConnection.skills = [];
    rerender();
    await flush();
    emitSkillMutation(
      'applied-review-workspace-b',
      [{ name: 'review', enabled: false }],
      'applied',
    );
    rerender();
    await flush();

    const callsBeforeReturning =
      mockWorkspaceActions.loadSkillsStatus.mock.calls.length;
    mockConnection.workspaceCwd = '/tmp/project';
    mockConnection.sessionId = 'session-1';
    mockConnection.commands = [
      skillCommandFixture('web-search', 'Search the web'),
    ];
    mockConnection.skills = ['web-search'];
    rerender();
    await flush();

    await vi.waitFor(() => {
      expect(mockWorkspaceActions.loadSkillsStatus.mock.calls.length).toBe(
        callsBeforeReturning + 2,
      );
      expect(testState.latestChatEditorProps?.skills).toEqual([]);
    });
    expect(testState.latestChatEditorProps?.commands).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'web-search' })]),
    );

    await act(async () => {
      pendingWorkspaceARefresh.resolve(disabledStatus);
      await pendingWorkspaceARefresh.promise;
    });
    await flush();
    expect(testState.latestChatEditorProps?.skills).toEqual([]);
  });

  it('surfaces a failed deferred Skill snapshot refresh', async () => {
    mockConnection.sessionId = undefined;
    mockWorkspaceActions.loadSkillsStatus
      .mockResolvedValueOnce({ skills: [] })
      .mockRejectedValueOnce(new Error('Skill snapshot unavailable'));
    const onToast = vi.fn();
    const { rerender } = renderApp({ onToast });
    await flush();

    testState.workspaceEventSignals = {
      ...testState.workspaceEventSignals,
      skillsVersion: 1,
      lastSkillMutation: {
        id: 'failed-deferred-web-search',
        kind: 'skill_toggle',
        skills: [{ name: 'web-search', enabled: true }],
        activation: 'deferred',
        sessionsRefreshed: 0,
        sessionsFailed: 0,
      },
    };
    rerender();
    await flush();

    expect(onToast).toHaveBeenCalledWith('error', 'Skill snapshot unavailable');
  });

  it('reloads workspace skills when an applied toggle arrives while session skills are unknown', async () => {
    mockConnection.commands = [
      skillCommandFixture('web-search', 'Search the web'),
    ];
    mockConnection.skills = undefined;
    mockWorkspaceActions.loadSkillsStatus
      .mockResolvedValueOnce({
        skills: [
          {
            name: 'web-search',
            description: 'Search the web',
            status: 'ok',
          },
        ],
      })
      .mockResolvedValue({
        skills: [
          {
            name: 'web-search',
            description: 'Search the web',
            status: 'disabled',
          },
        ],
      });

    const { rerender } = renderApp();
    await flush();
    await vi.waitFor(() => {
      expect(testState.latestChatEditorProps?.skills).toEqual([
        { name: 'web-search', description: 'Search the web' },
      ]);
    });
    emitSkillMutation(
      'applied-web-search-unknown-skills',
      [{ name: 'web-search', enabled: false }],
      'applied',
    );
    rerender();
    await flush();
    await vi.waitFor(() => {
      expect(testState.latestChatEditorProps?.skills).toEqual([]);
    });
    expect(
      mockWorkspaceActions.loadSkillsStatus.mock.calls.length,
    ).toBeGreaterThan(1);
  });

  it('uses the workspace Skill snapshot while the session Skill list is unknown', async () => {
    mockConnection.commands = [
      skillCommandFixture('web-search', 'Search the web'),
    ];
    mockConnection.skills = undefined;
    mockWorkspaceActions.loadSkillsStatus.mockResolvedValue({
      skills: [
        {
          name: 'web-search',
          description: 'Search the web',
          status: 'ok',
        },
      ],
    });

    renderApp();
    await flush();
    await vi.waitFor(() => {
      expect(testState.latestChatEditorProps?.skills).toEqual([
        { name: 'web-search', description: 'Search the web' },
      ]);
    });
  });

  it('does not treat an unknown session Skill list as reflecting a disable', async () => {
    mockConnection.commands = [
      skillCommandFixture('web-search', 'Search the web'),
    ];
    mockConnection.skills = undefined;
    mockWorkspaceActions.loadSkillsStatus
      .mockResolvedValueOnce({
        skills: [
          {
            name: 'web-search',
            description: 'Search the web',
            status: 'ok',
          },
        ],
      })
      .mockResolvedValue({
        skills: [
          {
            name: 'web-search',
            description: 'Search the web',
            status: 'disabled',
          },
        ],
      });

    const { rerender } = renderApp();
    await flush();
    emitPartialSkillMutation('partial-web-search-unknown-skills', [
      { name: 'web-search', enabled: false },
    ]);
    rerender();
    await flush();
    await vi.waitFor(() => {
      expect(testState.latestChatEditorProps?.skills).toEqual([]);
    });

    mockConnection.skills = ['web-search'];
    rerender();
    await flush();
    await flush();

    expect(testState.latestChatEditorProps?.skills).toEqual([]);
    expect(testState.latestChatEditorProps?.commands).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'web-search' })]),
    );
  });

  it.each([404, 410])(
    'shows a missing-session empty state with a new-session action for %d',
    async (status) => {
      mockConnection.status = 'disconnected';
      mockConnection.sessionId = undefined;
      mockConnection.error = 'Session load failed';
      mockConnection.errorStatus = status;
      mockConnection.missingSession = true;

      const onSessionIdChange = vi.fn();
      const { container, rerender } = renderApp({
        onSessionIdChange,
      });
      await flush();

      expect(container.textContent).toContain('Current session does not exist');
      const submit = container.querySelector('[data-testid="submit"]');
      expect(submit?.closest('[class*="chatSubtreeHidden"]')).not.toBeNull();
      expect(onSessionIdChange).not.toHaveBeenCalledWith(undefined);

      await act(async () => {
        Array.from(container.querySelectorAll('button'))
          .find((button) => button.textContent === 'New session')
          ?.click();
        await Promise.resolve();
      });

      expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);
      expect(mockSessionActions.createSession).not.toHaveBeenCalled();
      expect(mockSessionActions.attachSession).not.toHaveBeenCalled();
      expect(onSessionIdChange).toHaveBeenCalledWith(undefined);
      expect(onSessionIdChange).toHaveBeenCalledTimes(1);

      mockConnection.status = 'connected';
      mockConnection.sessionId = undefined;
      mockConnection.error = undefined;
      mockConnection.errorStatus = undefined;
      mockConnection.missingSession = false;
      testState.sessionHasActivePrompt = false;
      rerender();
      await flush();

      await act(async () => {
        testState.latestChatEditorProps?.onSubmit('first message');
        await flush();
      });

      expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(1);
      expect(rawEnqueuePrompt).not.toHaveBeenCalled();
    },
  );

  it('preserves standalone context when leaving a missing-session route', async () => {
    mockConnection.status = 'disconnected';
    mockConnection.sessionId = undefined;
    mockConnection.error = 'Session load failed';
    mockConnection.errorStatus = 404;
    mockConnection.missingSession = true;
    mockWorkspace.capabilities = {
      features: ['standalone_sessions_v1'],
      workspaces: [{ id: 'primary', cwd: '/workspace', primary: true }],
    };
    const onSessionIdChange = vi.fn();
    const { container } = renderApp({ onSessionIdChange });
    await flush();

    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'New session')
        ?.click();
      await Promise.resolve();
    });

    expect(onSessionIdChange).toHaveBeenCalledWith(
      undefined,
      undefined,
      undefined,
      { kind: 'standalone' },
    );
  });

  it('dispatches an automatic recap when the session remains active', async () => {
    const { recap } = await triggerAutoRecap();
    await act(async () => {
      recap.resolve({ sessionId: 'session-1', recap: 'Current session recap' });
      await recap.promise;
    });

    expect(mockStore.dispatch).toHaveBeenCalledWith([
      expect.objectContaining({
        source: 'recap',
        text: expect.stringContaining('Current session recap'),
      }),
    ]);
  });

  it('discards an automatic recap after a new turn starts in the same session', async () => {
    const { recap } = await triggerAutoRecap();
    testState.blocks = [
      ...testState.blocks,
      { id: 'new-turn', kind: 'user', text: 'Start another turn' },
    ];

    await act(async () => {
      recap.resolve({ sessionId: 'session-1', recap: 'Previous turn recap' });
      await recap.promise;
    });

    expect(mockStore.dispatch).not.toHaveBeenCalledWith([
      expect.objectContaining({ source: 'recap' }),
    ]);
  });

  it('discards an automatic recap when the session becomes active without a new user block', async () => {
    const { recap, rerender } = await triggerAutoRecap();
    testState.streamingState = 'responding';
    rerender();
    await flush();

    await act(async () => {
      recap.resolve({ sessionId: 'session-1', recap: 'Previous turn recap' });
      await recap.promise;
    });

    expect(mockStore.dispatch).not.toHaveBeenCalledWith([
      expect.objectContaining({ source: 'recap' }),
    ]);
  });

  it('discards an automatic recap after starting a new session', async () => {
    const { recap, container } = await triggerAutoRecap();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="new-session"]')
        ?.click();
      recap.resolve({
        sessionId: 'session-1',
        recap: 'Previous session recap',
      });
      await recap.promise;
    });

    expect(mockSessionActions.clearSession).toHaveBeenCalledOnce();
    expect(mockStore.dispatch).not.toHaveBeenCalledWith([
      expect.objectContaining({ source: 'recap' }),
    ]);
  });

  it('discards an automatic recap tagged for a different session', async () => {
    const { recap } = await triggerAutoRecap();
    await act(async () => {
      recap.resolve({ sessionId: 'session-2', recap: 'Stale recap' });
      await recap.promise;
    });

    expect(mockStore.dispatch).not.toHaveBeenCalledWith([
      expect.objectContaining({ source: 'recap' }),
    ]);
  });

  it('discards an automatic recap after switching to an existing session', async () => {
    const { recap, container } = await triggerAutoRecap();
    mockSessionActions.loadSession.mockImplementationOnce(async () => {
      testState.ownerVersion += 1;
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="load-session"]')
        ?.click();
      recap.resolve({
        sessionId: 'session-1',
        recap: 'Previous session recap',
      });
      await recap.promise;
    });

    expect(mockSessionActions.loadSession).toHaveBeenCalledWith('session-2', {
      workspaceCwd: undefined,
    });
    expect(mockStore.dispatch).not.toHaveBeenCalledWith([
      expect.objectContaining({ source: 'recap' }),
    ]);
  });

  it('keeps an automatic recap when an existing-session switch fails', async () => {
    const { recap } = await triggerAutoRecap();
    mockSessionActions.loadSession.mockRejectedValueOnce(
      new Error('target restore failed'),
    );

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('qwen:open-session', { detail: 'session-2' }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      recap.resolve({ sessionId: 'session-1', recap: 'Current session recap' });
      await recap.promise;
    });

    expect(mockStore.dispatch).toHaveBeenCalledWith([
      expect.objectContaining({
        source: 'recap',
        text: expect.stringContaining('Current session recap'),
      }),
    ]);
  });

  it('discards an automatic recap after resuming a session by command', async () => {
    const { recap } = await triggerAutoRecap();
    mockSessionActions.loadSession.mockImplementationOnce(async () => {
      testState.ownerVersion += 1;
    });
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('/resume session-3');
      recap.resolve({
        sessionId: 'session-1',
        recap: 'Previous session recap',
      });
      await recap.promise;
    });

    expect(mockSessionActions.loadSession).toHaveBeenCalledWith('session-3', {
      workspaceCwd: undefined,
    });
    expect(mockStore.dispatch).not.toHaveBeenCalledWith([
      expect.objectContaining({ source: 'recap' }),
    ]);
  });

  it('discards an automatic recap after clearing the screen', async () => {
    const { recap } = await triggerAutoRecap();
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          key: 'l',
        }),
      );
      recap.resolve({ sessionId: 'session-1', recap: 'Stale recap' });
      await recap.promise;
    });

    expect(mockStore.reset).toHaveBeenCalled();
    expect(mockStore.dispatch).not.toHaveBeenCalledWith([
      expect.objectContaining({ source: 'recap' }),
    ]);
  });

  it('discards an automatic recap when the connection session id changes', async () => {
    const { recap, rerender } = await triggerAutoRecap();
    await act(async () => {
      mockConnection.sessionId = 'session-reconnected';
      rerender();
      recap.resolve({ sessionId: 'session-1', recap: 'Stale recap' });
      await recap.promise;
    });

    expect(mockStore.dispatch).not.toHaveBeenCalledWith([
      expect.objectContaining({ source: 'recap' }),
    ]);
  });

  it('focuses the composer after starting a new session', async () => {
    const { container } = renderApp();
    await flush();
    editorFocus.mockClear();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="new-session"]')
        ?.click();
      await Promise.resolve();
    });

    expect(mockSessionActions.clearSession).toHaveBeenCalledOnce();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(editorFocus).toHaveBeenCalledOnce();
  });

  it('renames a /clear successor from persisted manual title provenance', async () => {
    mockWorkspace.client.listWorkspaceSessions.mockResolvedValue([
      {
        sessionId: 'session-1',
        workspaceCwd: '/tmp/project',
        displayName: 'Bug hunt',
        titleSource: 'manual',
      },
    ]);
    const { container, rerender } = renderApp();
    await flush();
    await flush();

    testState.prompt = '/clear';
    await clickSubmit(container);
    await vi.waitFor(() => {
      expect(mockSessionActions.clearSession).toHaveBeenCalledOnce();
    });

    act(() => {
      mockConnection.sessionId = undefined;
      mockConnection.displayName = undefined;
      rerender();
    });
    act(() => {
      testState.latestChatEditorProps?.onSubmit('first prompt');
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.sendPrompt).toHaveBeenCalled();
    });

    expect(mockSessionActions.renameSession).toHaveBeenCalledWith('Bug hunt');
    expect(
      mockSessionActions.renameSession.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockSessionActions.attachSession.mock.invocationCallOrder[0],
    );
    expect(
      mockSessionActions.renameSession.mock.invocationCallOrder[0],
    ).toBeLessThan(mockSessionActions.sendPrompt.mock.invocationCallOrder[0]);
  });

  it('does not carry an automatic title across /clear', async () => {
    mockConnection.titleSource = 'auto';
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = '/clear';
    await clickSubmit(container);
    await vi.waitFor(() => {
      expect(mockSessionActions.clearSession).toHaveBeenCalledOnce();
    });

    act(() => {
      mockConnection.sessionId = undefined;
      mockConnection.displayName = undefined;
      mockConnection.titleSource = undefined;
      rerender();
    });
    act(() => {
      testState.latestChatEditorProps?.onSubmit('first prompt');
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.sendPrompt).toHaveBeenCalled();
    });

    expect(mockSessionActions.renameSession).not.toHaveBeenCalled();
  });

  it('focuses a cleared new session without waiting for detach', async () => {
    const clear = deferred<void>();
    mockSessionActions.clearSession.mockReturnValueOnce(clear.promise);
    const { container } = renderApp();
    await flush();
    editorFocus.mockClear();

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="new-session"]')
        ?.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(editorFocus).toHaveBeenCalledOnce();
    await act(async () => clear.resolve());
  });

  it('focuses the composer after loading an existing session', async () => {
    const { container, rerender } = renderApp();
    await flush();
    editorFocus.mockClear();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="load-session"]')
        ?.click();
      await Promise.resolve();
    });
    expect(mockSessionActions.loadSession).toHaveBeenCalledWith('session-2', {
      workspaceCwd: undefined,
    });

    mockConnection.sessionId = 'session-2';
    rerender();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(editorFocus).toHaveBeenCalledOnce();
  });

  it('does not finish a same-id workspace switch before load', async () => {
    const load = deferred<void>();
    mockSessionActions.loadSession.mockImplementationOnce(() => {
      mockConnection.loadingTranscript = true;
      return load.promise;
    });
    const { rerender } = renderApp();
    await flush();
    editorFocus.mockClear();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('qwen:open-session', {
          detail: { sessionId: 'session-1', workspaceCwd: '/work/b' },
        }),
      );
      await Promise.resolve();
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(editorFocus).not.toHaveBeenCalled();
    expect(testState.latestChatEditorProps?.disabled).toBe(true);
    expect(testState.latestChatEditorProps?.onSubmit('must stay on A')).toBe(
      false,
    );
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();

    await act(async () => {
      mockConnection.workspaceCwd = '/work/b';
      mockConnection.loadingTranscript = false;
      load.resolve();
      rerender();
      await load.promise;
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(editorFocus).toHaveBeenCalledOnce();
  });

  it('opens a Live session through its explicit product context', async () => {
    mockWorkspace.capabilities = {
      features: ['multi_workspace_sessions'],
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true, trusted: true },
        {
          id: 'live',
          cwd: '/Users/test/Documents/Qwen Code/Conversations',
          primary: false,
          trusted: true,
          kind: 'live',
        },
      ],
    } as typeof mockWorkspace.capabilities;
    renderApp();
    await flush();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('qwen:open-session', {
          detail: {
            sessionId: 'live-coordinator',
            workspaceCwd: '/Users/test/Documents/Qwen Code/Conversations',
          },
        }),
      );
      await Promise.resolve();
    });

    expect(mockSessionActions.loadSession).toHaveBeenCalledWith(
      'live-coordinator',
      {
        workspaceCwd: undefined,
        sessionContext: { kind: 'live' },
      },
    );
    expect(mockSessionActions.loadSession).toHaveBeenCalledOnce();
  });

  it('opens a session link through the current standalone product context', async () => {
    mockConnection.sessionContext = { kind: 'standalone' };
    mockConnection.workspaceCwd = '';
    renderApp();
    await flush();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('qwen:open-session', {
          detail: 'standalone-child',
        }),
      );
      await Promise.resolve();
    });

    expect(mockSessionActions.loadSession).toHaveBeenCalledWith(
      'standalone-child',
      {
        workspaceCwd: undefined,
        sessionContext: { kind: 'standalone' },
      },
    );
    expect(mockSessionActions.loadSession).toHaveBeenCalledOnce();
  });

  it('hides stale standalone recovery state while switching to a workspace session', async () => {
    const load = deferred<void>();
    mockConnection.sessionContext = { kind: 'standalone' };
    mockConnection.workspaceCwd = '';
    mockConnection.standaloneSession = {
      creationRecovery: { state: 'creating', sessionId: 'session-1' },
    };
    mockSessionActions.loadSession.mockReturnValueOnce(load.promise);
    const { container } = renderApp();
    await flush();

    expect(
      container.querySelector('[data-testid="standalone-creation-recovery"]'),
    ).not.toBeNull();

    act(() => {
      window.dispatchEvent(
        new CustomEvent('qwen:open-session', {
          detail: {
            sessionId: 'workspace-session',
            workspaceCwd: '/workspace',
          },
        }),
      );
    });
    await flush();

    expect(mockSessionActions.loadSession).toHaveBeenCalledWith(
      'workspace-session',
      {
        workspaceCwd: '/workspace',
        sessionContext: { kind: 'workspace', cwd: '/workspace' },
      },
    );
    expect(
      container.querySelector('[data-testid="standalone-creation-recovery"]'),
    ).toBeNull();

    await act(async () => load.resolve());
  });

  it('does not steal focus when an approval appears before deferred session focus', async () => {
    vi.useFakeTimers();
    const { container, rerender } = renderApp();
    await flush();
    editorFocus.mockClear();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="load-session"]')
        ?.click();
      await Promise.resolve();
    });
    mockConnection.sessionId = 'session-2';
    rerender();

    await act(async () => {
      testState.blocks = [makePendingPermissionBlock()];
      rerender();
      await Promise.resolve();
    });
    editorFocus.mockClear();
    act(() => vi.runOnlyPendingTimers());

    // The editor isn't refocused while an approval is pending; instead the app
    // tells the approval overlay to take focus (keyboardActive), so a stray
    // keystroke can't send a message past the pending approval.
    expect(editorFocus).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="approval-overlay"]'),
    ).not.toBeNull();
    expect(testState.latestToolApprovalKeyboardActive).toBe(true);
  });

  it('hides the composer while a tool approval overlay is pending and restores it after resolution', async () => {
    const { container, rerender } = renderApp();
    await flush();

    const composerWrapper = () =>
      container.querySelector('[data-web-shell-composer]')?.parentElement;
    expect(composerWrapper()?.className).not.toContain('composerHidden');

    await act(async () => {
      testState.blocks = [makePendingPermissionBlock()];
      rerender();
      await Promise.resolve();
    });
    expect(
      document.querySelector('[data-testid="approval-overlay"]'),
    ).not.toBeNull();
    expect(composerWrapper()?.className).toContain('composerHidden');

    await act(async () => {
      testState.blocks = [];
      rerender();
      await Promise.resolve();
    });
    expect(
      document.querySelector('[data-testid="approval-overlay"]'),
    ).toBeNull();
    expect(composerWrapper()?.className).not.toContain('composerHidden');
  });

  it('hides the composer while an ask-user question overlay is pending', async () => {
    const { container, rerender } = renderApp();
    await flush();

    await act(async () => {
      testState.blocks = [
        makePendingPermissionBlock({ toolName: 'ask_user_question' }),
      ];
      rerender();
      await Promise.resolve();
    });
    expect(
      document.querySelector('[data-testid="approval-overlay"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-web-shell-composer]')?.parentElement
        ?.className,
    ).toContain('composerHidden');
  });

  it('does not show missing-session state for non-404/410 errors', async () => {
    mockConnection.status = 'disconnected';
    mockConnection.sessionId = undefined;
    mockConnection.error = 'Server error';
    mockConnection.errorStatus = 500;
    mockConnection.missingSession = false;

    const { container } = renderApp({ onSessionIdChange: vi.fn() });
    await flush();

    expect(container.textContent).not.toContain(
      'Current session does not exist',
    );
  });

  it('does not show missing-session state while connecting', async () => {
    mockConnection.status = 'connecting';
    mockConnection.sessionId = undefined;
    mockConnection.error = 'Session load failed';
    mockConnection.errorStatus = 404;
    mockConnection.missingSession = true;

    const { container } = renderApp({ onSessionIdChange: vi.fn() });
    await flush();

    expect(container.textContent).not.toContain(
      'Current session does not exist',
    );
  });

  it('does not notify session change when missing-session new chat fails', async () => {
    mockConnection.status = 'disconnected';
    mockConnection.sessionId = undefined;
    mockConnection.error = 'Session load failed';
    mockConnection.errorStatus = 404;
    mockConnection.missingSession = true;
    mockSessionActions.clearSession.mockRejectedValueOnce(new Error('network'));

    const onSessionIdChange = vi.fn();
    const { container } = renderApp({ onSessionIdChange });
    await flush();

    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'New session')
        ?.click();
      await Promise.resolve();
    });

    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);
    expect(onSessionIdChange).not.toHaveBeenCalled();
  });

  it('exposes canonical goal state to custom footers and clears it after session changes', async () => {
    const snapshots: unknown[] = [];
    const activeGoals: unknown[] = [];
    mockConnection.goalState = activeGoalSnapshot();
    const { rerender } = renderApp({
      renderFooter: (props) => {
        snapshots.push(props.goalSnapshot);
        activeGoals.push(props.activeGoal);
        return null;
      },
    });
    await flush();

    expect(snapshots.at(-1)).toMatchObject({
      v: 2,
      goal: { goalId: 'goal-1', objective: 'ship it' },
    });
    expect(activeGoals.at(-1)).toMatchObject({
      condition: 'ship it',
      setAt: 123,
    });

    mockConnection.errorStatus = 404;
    rerender({
      renderFooter: (props) => {
        snapshots.push(props.goalSnapshot);
        activeGoals.push(props.activeGoal);
        return null;
      },
    });
    await flush();

    expect(snapshots.at(-1)).toMatchObject({
      goal: { goalId: 'goal-1' },
    });
    expect(activeGoals.at(-1)).toMatchObject({
      condition: 'ship it',
      setAt: 123,
    });

    mockConnection.sessionId = 'session-2';
    mockConnection.goalState = undefined;
    rerender({
      renderFooter: (props) => {
        snapshots.push(props.goalSnapshot);
        activeGoals.push(props.activeGoal);
        return null;
      },
    });
    await flush();

    expect(snapshots.at(-1)).toBeNull();
    expect(activeGoals.at(-1)).toBeNull();
  });

  it('refuses /language ui while a Goal owns the session', async () => {
    // The daemon sync is what makes the agent answer in the new language; if
    // it is skipped the chrome switches alone and the agent keeps replying in
    // the old one for the rest of the Goal run.
    const onToast = vi.fn();
    mockConnection.goalState = activeGoalSnapshot('keep working');
    renderApp({ onToast });
    await flush();

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = testState.latestChatEditorProps?.onSubmit('/language ui zh');
      await flush();
    });

    expect(accepted).toBe(false);
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenCalledWith(
      'error',
      'Slash commands are unavailable while a Goal owns the session or its state is loading.',
    );
  });

  it.each([
    [
      'hidden command',
      '/internal deploy',
      { hiddenSlashCommands: ['internal'] },
    ],
    ['fast model command', '/model --fast qwen-max', {}],
    ['skill command', '/skills deployer', {}],
    ['delegated rename', '/rename --auto', {}],
  ])(
    'refuses an enqueue-style %s while a Goal owns the session',
    async (_label, command, props) => {
      const onToast = vi.fn();
      mockConnection.goalState = activeGoalSnapshot('keep working');
      renderApp({ ...props, onToast });
      await flush();

      let accepted: boolean | undefined;
      await act(async () => {
        accepted = testState.latestChatEditorProps?.onSubmit(command);
        await flush();
      });

      expect(accepted).toBe(false);
      expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
      expect(rawEnqueuePrompt).not.toHaveBeenCalled();
      expect(onToast).toHaveBeenCalledWith(
        'error',
        'Slash commands are unavailable while a Goal owns the session or its state is loading.',
      );
    },
  );

  it.each(['idle', 'responding'] as const)(
    'does not enqueue a forwarded command while Goal state is hydrating (%s)',
    async (streamingState) => {
      mockConnection.goalState = undefined;
      testState.streamingState = streamingState;
      renderApp();
      await flush();

      let accepted: boolean | undefined;
      await act(async () => {
        accepted =
          testState.latestChatEditorProps?.onSubmit('/deploy production');
        await flush();
      });

      expect(accepted).toBe(false);
      expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
      expect(rawEnqueuePrompt).not.toHaveBeenCalled();
    },
  );

  it('sends an idle composer prompt while Goal state is still hydrating', async () => {
    mockConnection.goalState = undefined;
    renderApp();
    await flush();

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = testState.latestChatEditorProps?.onSubmit(
        'hello during hydration',
      );
      await flush();
    });

    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      'hello during hydration',
      expect.objectContaining({ retry: undefined }),
    );
    expect(rawEnqueuePrompt).not.toHaveBeenCalled();
    expect(accepted).toBe(true);
  });

  it('inserts a hydrating composer prompt while the session is active', async () => {
    mockConnection.goalState = undefined;
    testState.streamingState = 'responding';
    renderApp();
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('hello during active turn');
      await flush();
    });

    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(rawEnqueuePrompt).toHaveBeenCalledTimes(1);
    expect(rawEnqueuePrompt.mock.calls[0]?.[0]).toBe(
      'hello during active turn',
    );
  });

  it('inserts a prompt before the first stream event reaches the client', async () => {
    testState.sessionHasActivePrompt = true;
    const { rerender } = renderApp();
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('hello before first token');
      await flush();
    });

    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(rawEnqueuePrompt).toHaveBeenCalledTimes(1);
    expect(rawEnqueuePrompt.mock.calls[0]?.[0]).toBe(
      'hello before first token',
    );
    expect(testState.queuedPromptStreamingState).toBe('idle');
    expect(testState.queuedPromptSessionHasActivePrompt).toBe(true);

    mockSessionActions.sendPrompt.mockClear();
    rawEnqueuePrompt.mockClear();
    testState.sessionHasActivePrompt = false;
    rerender();
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('hello after completion');
      await flush();
    });

    expect(testState.queuedPromptStreamingState).toBe('idle');
    expect(testState.queuedPromptSessionHasActivePrompt).toBe(false);
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(1);
    expect(rawEnqueuePrompt).not.toHaveBeenCalled();
  });

  it('enqueues a forwarded command while the session is active and Goal is idle', async () => {
    testState.streamingState = 'responding';
    renderApp();
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('/deploy production');
      await flush();
    });

    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(rawEnqueuePrompt).toHaveBeenCalledTimes(1);
    expect(rawEnqueuePrompt.mock.calls[0]?.[0]).toBe('/deploy production');
  });

  it('inserts a prompt when the session becomes active before effects run', async () => {
    mockConnection.goalState = undefined;
    const { rerender } = renderApp();
    await flush();

    let submitted = false;
    testState.onChatEditorLayout = (props) => {
      if (!props.isRunning || submitted) return;
      submitted = true;
      props.onSubmit('hello during active transition');
    };
    testState.streamingState = 'responding';

    rerender({});

    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(rawEnqueuePrompt).toHaveBeenCalledTimes(1);
    expect(rawEnqueuePrompt.mock.calls[0]?.[0]).toBe(
      'hello during active transition',
    );
  });

  it('sends an idle composer prompt when an active Goal is known', async () => {
    mockConnection.goalState = activeGoalSnapshot();
    renderApp();
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('hello during active Goal');
      await flush();
    });

    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      'hello during active Goal',
      expect.objectContaining({ retry: undefined }),
    );
    expect(rawEnqueuePrompt).not.toHaveBeenCalled();
  });

  it('does not locally hold prompts for an active Goal', async () => {
    mockConnection.goalState = activeGoalSnapshot();

    renderApp();
    await flush();

    expect(testState.queuedPromptHoldHistory.length).toBeGreaterThan(0);
    expect(testState.queuedPromptHoldHistory).not.toContain(true);
  });

  it('restores the Goal snapshot when the same session learns its workspace', async () => {
    const snapshots: unknown[] = [];
    mockConnection.workspaceCwd = '';
    mockConnection.goalState = activeGoalSnapshot();
    const { rerender } = renderApp({
      renderFooter: (props) => {
        snapshots.push(props.goalSnapshot);
        return null;
      },
    });
    await flush();

    act(() => {
      mockConnection.workspaceCwd = '/tmp/project';
      rerender({
        renderFooter: (props) => {
          snapshots.push(props.goalSnapshot);
          return null;
        },
      });
    });
    await flush();

    expect(snapshots.at(-1)).toMatchObject({
      goal: { goalId: 'goal-1', objective: 'ship it' },
    });
  });

  it('gates direct submissions and dispatches compatible submit events', async () => {
    const onSubmitBefore = vi.fn().mockResolvedValue(undefined);
    const onSessionChange = vi.fn();
    const { container } = renderApp({ onSubmitBefore, onSessionChange });
    await flush();

    await clickSubmit(container);
    await flush();

    expect(onSubmitBefore).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: 'hello',
    });
    expect(mockFollowup.clear).toHaveBeenCalledTimes(1);
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({ retry: undefined }),
    );
    expect(editorCommit).toHaveBeenCalledTimes(1);
    expect(editorClear).not.toHaveBeenCalled();
    expect(onSessionChange).toHaveBeenCalledWith({
      type: 'submit',
      sessionId: 'session-1',
      prompt: 'hello',
      queued: false,
    });
    const promptOptions = mockSessionActions.sendPrompt.mock.calls.at(
      -1,
    )?.[1] as { onAdmitted?: () => void } | undefined;
    act(() => promptOptions?.onAdmitted?.());
    expect(sessionCatalogController.promptAdmitted).toHaveBeenCalledWith(
      '/tmp/project',
      'session-1',
    );
  });

  it('prepares direct transport before the submit gate and session event', async () => {
    const order: string[] = [];
    const inputAnnotations: DaemonInputAnnotation[] = [
      {
        type: 'reference',
        start: 0,
        end: 8,
        text: 'resolved',
        reference: { id: 'resolved', kind: 'file' },
      },
    ];
    const prepareSubmit = vi.fn(async () => {
      order.push('prepare');
      return { prompt: 'resolved', inputAnnotations };
    });
    const onSubmitBefore = vi.fn(async ({ prompt }: { prompt: string }) => {
      order.push(`gate:${prompt}`);
    });
    mockSessionActions.sendPrompt.mockImplementationOnce(
      async (prompt: string) => {
        order.push(`transport:${prompt}`);
      },
    );
    const onSessionChange = vi.fn();
    const { container } = renderApp({
      prepareSubmit,
      onSubmitBefore,
      onSessionChange,
    });
    await flush();

    await clickSubmit(container);
    await flush();

    expect(prepareSubmit).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: 'hello',
      inputAnnotations: [],
    });
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      'resolved',
      expect.objectContaining({ inputAnnotations }),
    );
    expect(onSessionChange).toHaveBeenCalledWith({
      type: 'submit',
      sessionId: 'session-1',
      prompt: 'resolved',
      queued: false,
    });
    expect(order).toEqual(['prepare', 'gate:resolved', 'transport:resolved']);
  });

  it('keeps the draft when preparation removes all prompt content', async () => {
    const prepareSubmit = vi.fn().mockResolvedValue({
      prompt: '',
      inputAnnotations: [],
    });
    const { container } = renderApp({ prepareSubmit });
    await flush();

    await clickSubmit(container);
    await flush();

    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(editorCommit).not.toHaveBeenCalled();
    expect(editorClear).not.toHaveBeenCalled();
    expect(testState.prompt).toBe('hello');
  });

  it('keeps the original payload when preparation resolves without a result', async () => {
    const prepareSubmit = vi.fn().mockResolvedValue(undefined);
    const inputAnnotations: DaemonInputAnnotation[] = [
      {
        type: 'reference',
        start: 0,
        end: 5,
        text: 'hello',
        reference: { id: 'file:hello', kind: 'file', value: 'hello' },
      },
    ];
    testState.inputAnnotations = inputAnnotations;
    const { container } = renderApp({ prepareSubmit });
    await flush();

    await clickSubmit(container);
    await flush();

    expect(prepareSubmit).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: 'hello',
      inputAnnotations,
    });
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({ inputAnnotations }),
    );
  });

  it('inherits the original annotations when preparation returns only a prompt', async () => {
    const prepareSubmit = vi.fn().mockResolvedValue({ prompt: 'rewritten' });
    const inputAnnotations: DaemonInputAnnotation[] = [
      {
        type: 'reference',
        start: 0,
        end: 5,
        text: 'hello',
        reference: { id: 'file:hello', kind: 'file', value: 'hello' },
      },
    ];
    testState.inputAnnotations = inputAnnotations;
    const { container } = renderApp({ prepareSubmit });
    await flush();

    await clickSubmit(container);
    await flush();

    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      'rewritten',
      expect.objectContaining({ inputAnnotations }),
    );
  });

  it('cancels a direct submission when the session owner changes while preparing', async () => {
    // No session yet: without the post-prepare staleness check the stale
    // submit would run the host gate and allocate a session before the
    // later guards run.
    mockConnection.sessionId = undefined;
    let finishPrepare: (() => void) | undefined;
    const prepareSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishPrepare = resolve;
        }),
    );
    const onSubmitBefore = vi.fn().mockResolvedValue(undefined);
    const { container, rerender } = renderApp({
      prepareSubmit,
      onSubmitBefore,
    });
    await flush();

    await clickSubmit(container);
    expect(prepareSubmit).toHaveBeenCalledOnce();
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();

    act(() => {
      mockConnection.sessionId = 'session-2';
      mockConnection.workspaceCwd = '/tmp/project-2';
      testState.ownerVersion += 1;
      rerender({ prepareSubmit, onSubmitBefore });
    });
    await act(async () => {
      finishPrepare?.();
      await Promise.resolve();
    });

    expect(onSubmitBefore).not.toHaveBeenCalled();
    expect(mockSessionActions.createSession).not.toHaveBeenCalled();
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(editorCommit).not.toHaveBeenCalled();
    expect(editorClear).not.toHaveBeenCalled();
    expect(testState.prompt).toBe('hello');
    expect(testState.latestChatEditorProps?.isPreparing).toBe(false);
  });

  it('keeps the draft when prepareSubmit rejects', async () => {
    const prepareSubmit = vi.fn().mockRejectedValue(new Error('host failed'));
    const { container } = renderApp({ prepareSubmit });
    await flush();

    await clickSubmit(container);
    await flush();

    expect(prepareSubmit).toHaveBeenCalledOnce();
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(editorCommit).not.toHaveBeenCalled();
    expect(editorClear).not.toHaveBeenCalled();
    expect(testState.prompt).toBe('hello');
    expect(testState.latestChatEditorProps?.isPreparing).toBe(false);
  });

  it('classifies the retry payload from the prepared prompt, not the raw text', async () => {
    const preparedAnnotations: DaemonInputAnnotation[] = [
      {
        type: 'reference',
        start: 0,
        end: 8,
        text: 'prepared',
        reference: { id: 'prepared', kind: 'file' },
      },
    ];
    const prepareSubmit = vi.fn().mockResolvedValue({
      prompt: 'fix the CI pipeline',
      inputAnnotations: preparedAnnotations,
    });
    const { container, rerender } = renderApp({ prepareSubmit });
    await flush();

    testState.prompt = '/fix-ci';
    await clickSubmit(container);

    expect(prepareSubmit).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: '/fix-ci',
      inputAnnotations: [],
    });
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      'fix the CI pipeline',
      expect.objectContaining({ retry: undefined }),
    );

    act(() => {
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-rewritten',
          errorKind: 'model_stream_interrupted',
          text: 'terminated',
        },
      ];
      rerender({ prepareSubmit });
    });

    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
      await Promise.resolve();
    });

    expect(prepareSubmit).toHaveBeenCalledOnce();
    expect(mockSessionActions.sendPrompt).toHaveBeenLastCalledWith(
      'fix the CI pipeline',
      expect.objectContaining({
        optimisticUserMessage: false,
        retry: true,
        inputAnnotations: preparedAnnotations,
      }),
    );
  });

  it('disarms retry state when preparation turns the submit into a slash command', async () => {
    const prepareSubmit = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        prompt: '/compact foo',
        inputAnnotations: [],
      });
    const { container, rerender } = renderApp({ prepareSubmit });
    await flush();

    await clickSubmit(container);
    await flush();
    expect(mockSessionActions.sendPrompt).toHaveBeenLastCalledWith(
      'hello',
      expect.objectContaining({ retry: undefined }),
    );

    testState.prompt = 'world';
    await clickSubmit(container);
    await flush();
    expect(mockSessionActions.sendPrompt).toHaveBeenLastCalledWith(
      '/compact foo',
      expect.objectContaining({ retry: undefined }),
    );

    act(() => {
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-slash-prepared',
          errorKind: 'model_stream_interrupted',
          text: 'terminated',
        },
      ];
      rerender({ prepareSubmit });
    });

    expect(container.querySelector('[data-testid="retry"]')).toBeNull();
  });

  it('keeps attachment retry state disarmed after a slash-prepared submit', async () => {
    const images = [{ data: 'Ym1w', media_type: 'image/bmp' }];
    const files = [{ name: 'app.log', media_type: 'text/plain', text: 'log' }];
    const prepareSubmit = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        prompt: '/compact foo',
        inputAnnotations: [],
      });
    const { container, rerender } = renderApp({ prepareSubmit });
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit(
        'hello',
        images,
        files,
        editorCommit,
      );
    });
    await flush();
    expect(mockSessionActions.sendPrompt).toHaveBeenLastCalledWith(
      'hello',
      expect.objectContaining({ images, files, retry: undefined }),
    );

    testState.prompt = 'world';
    await clickSubmit(container);
    await flush();
    expect(mockSessionActions.sendPrompt).toHaveBeenLastCalledWith(
      '/compact foo',
      expect.objectContaining({ retry: undefined }),
    );

    act(() => {
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-slash-prepared-attachments',
          errorKind: 'model_stream_interrupted',
          text: 'terminated',
        },
      ];
      rerender({ prepareSubmit });
    });

    expect(container.querySelector('[data-testid="retry"]')).toBeNull();
  });

  it('keeps a stashed turn-error retry disarmed after a slash-prepared submit', async () => {
    const retrySend = deferred<void>();
    const prepareSubmit = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        prompt: '/compact foo',
        inputAnnotations: [],
      });
    mockSessionActions.sendPrompt
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(retrySend.promise)
      .mockResolvedValueOnce(undefined);
    const { container, rerender } = renderApp({ prepareSubmit });
    await flush();

    await clickSubmit(container);
    await flush();

    act(() => {
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-1',
          promptId: 'prompt-1',
        },
      ];
      rerender({ prepareSubmit });
    });
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(2);
    });
    const retryOptions = mockSessionActions.sendPrompt.mock.calls[1]?.[1];
    act(() => {
      retryOptions?.onAdmissionStarted?.();
      retryOptions?.onAdmitted?.();
    });
    await act(async () => {
      retrySend.reject(
        Object.assign(new Error('retried turn failed'), {
          _daemonTurnError: true,
        }),
      );
      await Promise.resolve();
    });
    await flush();

    testState.prompt = 'world';
    await clickSubmit(container);
    await flush();
    expect(mockSessionActions.sendPrompt).toHaveBeenLastCalledWith(
      '/compact foo',
      expect.objectContaining({ retry: undefined }),
    );

    act(() => {
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-1',
          promptId: 'prompt-1',
        },
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-2',
          promptId: 'prompt-2',
        },
      ];
      rerender({ prepareSubmit });
    });
    await flush();

    expect(container.querySelector('[data-testid="retry"]')).toBeNull();
  });

  it('does not attribute prompt admission when the active owner is unknown', async () => {
    mockConnection.workspaceCwd = undefined;
    const { container } = renderApp();
    await flush();

    await clickSubmit(container);
    await flush();

    expect(mockSessionActions.sendPrompt).toHaveBeenCalled();
    const promptOptions = mockSessionActions.sendPrompt.mock.calls.at(
      -1,
    )?.[1] as { onAdmitted?: () => void } | undefined;
    act(() => promptOptions?.onAdmitted?.());

    expect(sessionCatalogController.promptAdmitted).not.toHaveBeenCalled();
  });

  it('dispatches direct and queued submit events for image-only prompts', async () => {
    const onSessionChange = vi.fn();
    const images = [{ data: 'Ym1w', media_type: 'image/bmp' }];
    const { rerender } = renderApp({ onSessionChange });
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('', images);
    });
    await flush();
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      '',
      expect.objectContaining({ images }),
    );
    expect(onSessionChange).toHaveBeenCalledWith({
      type: 'submit',
      sessionId: 'session-1',
      prompt: '',
      queued: false,
    });

    onSessionChange.mockClear();
    act(() => {
      testState.streamingState = 'responding';
      rerender({ onSessionChange });
    });
    act(() => {
      testState.latestChatEditorProps?.onSubmit('', images);
    });
    expect(rawEnqueuePrompt).toHaveBeenCalledWith(
      '',
      images,
      undefined,
      undefined,
      undefined,
    );
    expect(onSessionChange).toHaveBeenCalledWith({
      type: 'submit',
      sessionId: 'session-1',
      prompt: '',
      queued: true,
    });
  });

  it('cancels an approved direct submission after the session changes', async () => {
    let approve: (() => void) | undefined;
    const onSubmitBefore = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          approve = resolve;
        }),
    );
    const onSessionChange = vi.fn();
    const { container, rerender } = renderApp({
      onSubmitBefore,
      onSessionChange,
    });
    await flush();

    await clickSubmit(container);
    expect(onSubmitBefore).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: 'hello',
    });
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(editorCommit).not.toHaveBeenCalled();
    expect(editorClear).not.toHaveBeenCalled();
    expect(onSessionChange).not.toHaveBeenCalled();

    act(() => {
      mockConnection.sessionId = 'session-2';
      mockConnection.workspaceCwd = '/tmp/project-2';
      rerender({ onSubmitBefore, onSessionChange });
    });
    await act(async () => {
      approve?.();
      await Promise.resolve();
    });

    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(editorCommit).not.toHaveBeenCalled();
    expect(editorClear).not.toHaveBeenCalled();
    expect(onSessionChange).not.toHaveBeenCalled();
    expect(mockFollowup.clear).not.toHaveBeenCalled();
    expect(testState.prompt).toBe('hello');
    expect(testState.latestChatEditorProps?.isPreparing).toBe(false);
  });

  it('keeps a daemon-bound draft when onSubmitBefore rejects', async () => {
    // The direct-submission path (streaming idle) must leave the composer
    // untouched when the host refuses the prompt: clearing or committing the
    // editor on rejection silently discards what the user typed.
    const onSubmitBefore = vi.fn().mockRejectedValue(new Error('host says no'));
    const { container } = renderApp({ onSubmitBefore });
    await flush();

    await clickSubmit(container);
    await flush();

    expect(onSubmitBefore).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: 'hello',
    });
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(editorCommit).not.toHaveBeenCalled();
    expect(editorClear).not.toHaveBeenCalled();
    expect(testState.prompt).toBe('hello');
    expect(testState.latestChatEditorProps?.isPreparing).toBe(false);
  });

  it('cancels an approved direct submission after a session transition', async () => {
    let approve: (() => void) | undefined;
    const onSubmitBefore = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          approve = resolve;
        }),
    );
    const onSessionChange = vi.fn();
    const { container, rerender } = renderApp({
      onSubmitBefore,
      onSessionChange,
    });
    await flush();

    await clickSubmit(container);
    expect(onSubmitBefore).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: 'hello',
    });

    act(() => {
      mockConnection.loadingTranscript = true;
      rerender({
        onSubmitBefore,
        onSessionChange,
      });
    });
    act(() => {
      mockConnection.loadingTranscript = false;
      rerender({
        onSubmitBefore,
        onSessionChange,
      });
    });
    await act(async () => {
      approve?.();
      await Promise.resolve();
    });

    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(editorCommit).not.toHaveBeenCalled();
    expect(editorClear).not.toHaveBeenCalled();
    expect(onSessionChange).not.toHaveBeenCalled();
    expect(mockFollowup.clear).not.toHaveBeenCalled();
    expect(testState.prompt).toBe('hello');
    expect(testState.latestChatEditorProps?.isPreparing).toBe(false);
  });

  it('does not commit an approved submission after the App unmounts', async () => {
    const approval = deferred<void>();
    const onSubmitBefore = vi.fn(() => approval.promise);
    const { container, unmount } = renderApp({ onSubmitBefore });
    await flush();

    await clickSubmit(container);
    expect(onSubmitBefore).toHaveBeenCalledOnce();
    unmount();
    await act(async () => {
      approval.resolve();
      await approval.promise;
    });

    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(editorCommit).not.toHaveBeenCalled();
    expect(editorClear).not.toHaveBeenCalled();
    expect(mockFollowup.clear).not.toHaveBeenCalled();
  });

  it('cancels an approved new-task submission after its target workspace changes', async () => {
    let approve: (() => void) | undefined;
    const onSubmitBefore = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          approve = resolve;
        }),
    );
    mockConnection.sessionId = undefined;
    mockWorkspace.capabilities = {
      workspaces: [
        {
          id: 'primary',
          cwd: '/workspace',
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary',
          cwd: '/work/secondary',
          primary: false,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const { container } = renderApp({ onSubmitBefore });
    await flush();

    await clickSubmit(container);
    expect(onSubmitBefore).toHaveBeenCalledWith({
      sessionId: undefined,
      prompt: 'hello',
    });

    act(() => {
      testState.latestChatEditorProps?.onSelectWorkspace?.('/work/secondary');
    });
    await act(async () => {
      approve?.();
      await Promise.resolve();
    });

    expect(mockSessionActions.createSession).not.toHaveBeenCalled();
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(editorCommit).not.toHaveBeenCalled();
    expect(testState.prompt).toBe('hello');
    expect(testState.latestChatEditorProps?.isPreparing).toBe(false);
  });

  it('cancels an approved submission as soon as a workspace switch starts', async () => {
    let approve: (() => void) | undefined;
    let finishClear: (() => void) | undefined;
    const onSubmitBefore = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          approve = resolve;
        }),
    );
    mockSessionActions.clearSession.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishClear = resolve;
        }),
    );
    mockWorkspace.capabilities = {
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary',
          cwd: '/work/secondary',
          primary: false,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const { container } = renderApp({ onSubmitBefore });
    await flush();

    await clickSubmit(container);
    act(() => {
      testState.latestChatEditorProps?.onSelectWorkspace?.('/work/secondary');
    });
    await act(async () => {
      approve?.();
      await Promise.resolve();
    });

    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(editorCommit).not.toHaveBeenCalled();

    await act(async () => {
      finishClear?.();
      await Promise.resolve();
    });
  });

  it('does not rerender the composer while a draft waits for intent classification', async () => {
    vi.useFakeTimers();
    const ComposerFooter = vi.fn(() => null);

    renderApp({ renderComposerFooter: ComposerFooter });
    await flush();
    const renderCount = ComposerFooter.mock.calls.length;

    act(() => {
      testState.latestChatEditorProps?.onInputTextChange?.(
        'Help me brainstorm a separate Web Shell design proposal',
      );
      vi.advanceTimersByTime(121);
    });
    await flush();

    expect(ComposerFooter).toHaveBeenCalledTimes(renderCount);
  });

  it('keeps ChatEditor memoized across transcript-only app renders', async () => {
    testState.streamingState = 'responding';
    testState.messages = [{ role: 'assistant', content: 'first delta' }];
    const { rerender } = renderApp();
    await flush();
    const renderCount = testState.chatEditorRenderCount;

    testState.blocks = [{ kind: 'debug', text: 'streaming delta' }];
    testState.messages = [{ role: 'assistant', content: 'next delta' }];
    rerender();
    await flush();

    expect(testState.chatEditorRenderCount).toBe(renderCount);
  });

  it('does not suggest a new session for obvious follow-up prompts', async () => {
    vi.useFakeTimers();
    mockConnection.capabilities.features = ['session_generation'];
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).tokenCount = 600;
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).contextWindow = 1000;
    testState.messages = Array.from({ length: 8 }, (_, index) => ({
      id: `m-followup-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `existing session topic ${index} about daemon generation review work`,
      timestamp: index,
    }));
    testState.prompt = '顺手补个测试';

    const { container } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onInputTextChange?.(testState.prompt);
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(701);
    });
    await flush();

    expect(
      container.querySelector('[data-testid="new-session-suggestion"]'),
    ).toBeNull();
    expect(mockSessionActions.generateSessionContent).not.toHaveBeenCalled();
  });

  it('suggests starting a new session for a new-topic prompt and auto-sends it in the fresh session', async () => {
    vi.useFakeTimers();
    mockConnection.capabilities.features = ['session_generation'];
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).tokenCount = 600;
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).contextWindow = 1000;
    testState.messages = Array.from({ length: 8 }, (_, index) => ({
      id: `m-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `existing session topic ${index} about daemon generation review work`,
      timestamp: index,
    }));
    const suggestedPrompt =
      'Help me brainstorm Web Shell interaction ideas on top of this interface for a design doc';
    testState.prompt = suggestedPrompt;
    testState.promptImages = [{ data: 'abc', media_type: 'image/png' }];
    mockSessionActions.clearSession.mockImplementation(async () => {
      mockConnection.sessionId = undefined;
    });
    mockSessionActions.createSession.mockImplementation(async () => {
      mockConnection.sessionId = 'session-created';
      return { sessionId: 'session-created' };
    });
    mockSessionActions.generateSessionContent.mockImplementation(
      async function* () {
        yield {
          type: 'delta',
          requestId: 'req-1',
          seq: 0,
          text: JSON.stringify({
            suggestion: 'new_session',
            confidence: 0.91,
          }),
        };
        yield {
          type: 'done',
          requestId: 'req-1',
          model: 'fast-model',
          modelSource: 'fast',
        };
      },
    );

    const { container } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onInputTextChange?.(testState.prompt);
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(121);
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(701);
    });
    await flush();

    expect(
      container.querySelector('[data-testid="new-session-suggestion"]')
        ?.textContent,
    ).toContain('This looks like a new topic');

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="new-session-suggestion-start"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);
    act(() => {
      vi.runOnlyPendingTimers();
    });
    await flush();
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      suggestedPrompt,
      expect.objectContaining({
        images: [{ data: 'abc', media_type: 'image/png' }],
      }),
    );
    expect(editorInsertText).not.toHaveBeenCalled();
  });

  it('waits for the replacement Live session before sending an accepted new-topic suggestion', async () => {
    vi.useFakeTimers();
    mockConnection.sessionId = 'live-session-current';
    mockConnection.sessionContext = { kind: 'live' };
    mockConnection.workspaceCwd = '';
    mockConnection.capabilities.features = ['session_generation'];
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).tokenCount = 600;
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).contextWindow = 1000;
    testState.messages = Array.from({ length: 8 }, (_, index) => ({
      id: `live-message-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `existing Live topic ${index} about the current conversation`,
      timestamp: index,
    }));
    const suggestedPrompt = 'Start a different Live conversation about tests';
    testState.prompt = suggestedPrompt;
    mockSessionActions.generateSessionContent.mockImplementation(
      async function* () {
        yield {
          type: 'delta',
          requestId: 'live-suggestion',
          seq: 0,
          text: JSON.stringify({
            suggestion: 'new_session',
            confidence: 0.91,
          }),
        };
        yield {
          type: 'done',
          requestId: 'live-suggestion',
          model: 'fast-model',
          modelSource: 'fast',
        };
      },
    );
    const onSessionIdChange = vi.fn();
    const { container, rerender } = renderApp({ onSessionIdChange });
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onInputTextChange?.(testState.prompt);
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(121);
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(701);
    });
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="new-session-suggestion-start"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(mockWorkspace.client.startLive).toHaveBeenCalledWith('new');
    expect(mockSessionActions.clearSession).not.toHaveBeenCalled();
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(onSessionIdChange).not.toHaveBeenCalledWith(undefined);

    act(() => {
      mockConnection.sessionId = 'live-session-next';
      rerender({ onSessionIdChange });
    });
    await flush();
    act(() => {
      vi.runOnlyPendingTimers();
    });
    await flush();

    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      suggestedPrompt,
      expect.any(Object),
    );
  });

  it('uses the locked workspace path when accepting a Live-context new-topic suggestion', async () => {
    vi.useFakeTimers();
    mockConnection.sessionId = 'live-session-current';
    mockConnection.sessionContext = { kind: 'live' };
    mockConnection.workspaceCwd = '';
    mockConnection.capabilities.features = ['session_generation'];
    mockWorkspace.capabilities = {
      features: ['standalone_sessions_v1'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).tokenCount = 600;
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).contextWindow = 1000;
    testState.messages = Array.from({ length: 8 }, (_, index) => ({
      id: `locked-live-message-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `existing Live topic ${index} about the current conversation`,
      timestamp: index,
    }));
    const suggestedPrompt = 'Start a workspace conversation about tests';
    testState.prompt = suggestedPrompt;
    mockSessionActions.clearSession.mockImplementation(async () => {
      mockConnection.sessionId = undefined;
    });
    mockSessionActions.generateSessionContent.mockImplementation(
      async function* () {
        yield {
          type: 'delta',
          requestId: 'locked-live-suggestion',
          seq: 0,
          text: JSON.stringify({
            suggestion: 'new_session',
            confidence: 0.91,
          }),
        };
        yield {
          type: 'done',
          requestId: 'locked-live-suggestion',
          model: 'fast-model',
          modelSource: 'fast',
        };
      },
    );
    const onSessionIdChange = vi.fn();
    const { container } = renderApp({
      lockedWorkspaceCwd: '/tmp/project',
      onSessionIdChange,
    });
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onInputTextChange?.(testState.prompt);
    });
    await flush();
    act(() => vi.advanceTimersByTime(821));
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="new-session-suggestion-start"]',
        )
        ?.click();
      await Promise.resolve();
    });
    act(() => vi.runOnlyPendingTimers());
    await flush();

    expect(mockWorkspace.client.startLive).not.toHaveBeenCalled();
    expect(mockSessionActions.clearSession).toHaveBeenCalledOnce();
    expect(onSessionIdChange).toHaveBeenCalledWith(undefined);
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      suggestedPrompt,
      expect.any(Object),
    );
  });

  it('cancels an accepted Live new-topic suggestion when a newer global new-chat request wins', async () => {
    vi.useFakeTimers();
    const startLive = deferred<{
      v: 1;
      available: true;
      state: 'listening';
      shortcut: string;
    }>();
    mockConnection.sessionId = 'live-session-current';
    mockConnection.sessionContext = { kind: 'live' };
    mockConnection.workspaceCwd = '';
    mockConnection.capabilities.features = ['session_generation'];
    mockWorkspace.capabilities = {
      features: ['standalone_sessions_v1'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).tokenCount = 600;
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).contextWindow = 1000;
    testState.messages = Array.from({ length: 8 }, (_, index) => ({
      id: `cancelled-live-message-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `existing Live topic ${index} about the current conversation`,
      timestamp: index,
    }));
    testState.prompt = 'Start a different Live conversation about tests';
    mockWorkspace.client.startLive.mockReturnValueOnce(startLive.promise);
    mockSessionActions.clearSession.mockImplementation(async () => {
      mockConnection.sessionId = undefined;
    });
    mockSessionActions.generateSessionContent.mockImplementation(
      async function* () {
        yield {
          type: 'delta',
          requestId: 'cancelled-live-suggestion',
          seq: 0,
          text: JSON.stringify({
            suggestion: 'new_session',
            confidence: 0.91,
          }),
        };
        yield {
          type: 'done',
          requestId: 'cancelled-live-suggestion',
          model: 'fast-model',
          modelSource: 'fast',
        };
      },
    );
    const shellRef = createRef<WebShellApi>();
    const { container } = renderApp({ shellRef });
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onInputTextChange?.(testState.prompt);
    });
    await flush();
    act(() => vi.advanceTimersByTime(821));
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="new-session-suggestion-start"]',
        )
        ?.click();
      await Promise.resolve();
    });

    await act(async () => {
      await shellRef.current?.createNewSession();
    });
    await act(async () => {
      startLive.resolve({
        v: 1,
        available: true,
        state: 'listening',
        shortcut: 'Command+Q',
      });
      await startLive.promise;
    });
    act(() => vi.runOnlyPendingTimers());
    await flush();

    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(testState.latestChatEditorProps?.disabled).toBe(false);
  });

  it('cancels an accepted Live new-topic suggestion after leaving Live', async () => {
    vi.useFakeTimers();
    mockConnection.sessionId = 'live-session-current';
    mockConnection.sessionContext = { kind: 'live' };
    mockConnection.workspaceCwd = '';
    mockConnection.capabilities.features = ['session_generation'];
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).tokenCount = 600;
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).contextWindow = 1000;
    testState.messages = Array.from({ length: 8 }, (_, index) => ({
      id: `live-message-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `existing Live topic ${index} about the current conversation`,
      timestamp: index,
    }));
    testState.prompt = 'Start a different Live conversation about tests';
    mockSessionActions.generateSessionContent.mockImplementation(
      async function* () {
        yield {
          type: 'delta',
          requestId: 'live-suggestion',
          seq: 0,
          text: JSON.stringify({
            suggestion: 'new_session',
            confidence: 0.91,
          }),
        };
        yield {
          type: 'done',
          requestId: 'live-suggestion',
          model: 'fast-model',
          modelSource: 'fast',
        };
      },
    );
    const { container, rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onInputTextChange?.(testState.prompt);
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(121);
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(701);
    });
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="new-session-suggestion-start"]',
        )
        ?.click();
      await Promise.resolve();
    });

    act(() => {
      mockConnection.sessionId = 'workspace-session';
      mockConnection.sessionContext = {
        kind: 'workspace',
        cwd: '/workspace',
      };
      rerender();
    });
    await flush();
    act(() => {
      vi.runOnlyPendingTimers();
    });
    await flush();

    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
  });

  it('suggests sending a side question with BTW and clears the accepted draft', async () => {
    vi.useFakeTimers();
    mockConnection.capabilities.features = ['session_generation'];
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).tokenCount = 600;
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).contextWindow = 1000;
    testState.messages = Array.from({ length: 8 }, (_, index) => ({
      id: `m-btw-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `existing session topic ${index} about daemon generation review work`,
      timestamp: index,
    }));
    const sideQuestion = '这里的 confidence 阈值为什么是 0.75？';
    testState.prompt = sideQuestion;
    mockSessionActions.generateSessionContent.mockImplementation(
      async function* () {
        yield {
          type: 'delta',
          requestId: 'req-btw',
          seq: 0,
          text: JSON.stringify({
            suggestion: 'btw',
            confidence: 0.92,
          }),
        };
        yield {
          type: 'done',
          requestId: 'req-btw',
          model: 'fast-model',
          modelSource: 'fast',
        };
      },
    );

    const { container } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onInputTextChange?.(testState.prompt);
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(121);
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(701);
    });
    await flush();

    expect(
      container.querySelector('[data-testid="btw-suggestion"]')?.textContent,
    ).toContain('side question');

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="btw-suggestion-send"]')
        ?.click();
      await Promise.resolve();
    });

    expect(mockSessionActions.btwSession).toHaveBeenCalledWith(
      sideQuestion,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(editorCommit).toHaveBeenCalledTimes(1);

    const newTask = '帮我写一篇新的设计文档，主题是 Web Shell 新功能方案';
    mockSessionActions.generateSessionContent.mockImplementation(
      async function* () {
        yield {
          type: 'delta',
          requestId: 'req-new-session-after-btw',
          seq: 0,
          text: JSON.stringify({
            suggestion: 'new_session',
            confidence: 0.94,
          }),
        };
        yield {
          type: 'done',
          requestId: 'req-new-session-after-btw',
          model: 'fast-model',
          modelSource: 'fast',
        };
      },
    );
    testState.prompt = newTask;
    act(() => {
      testState.latestChatEditorProps?.onInputTextChange?.(newTask);
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(121);
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(701);
    });
    await flush();

    expect(
      container.querySelector('[data-testid="new-session-suggestion"]'),
    ).not.toBeNull();
  });

  it('refuses a visible BTW suggestion when an inline tag is added before acceptance', async () => {
    vi.useFakeTimers();
    mockConnection.capabilities.features = ['session_generation'];
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).tokenCount = 600;
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).contextWindow = 1000;
    testState.messages = Array.from({ length: 8 }, (_, index) => ({
      id: `m-btw-attachment-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `existing session topic ${index} about daemon generation review work`,
      timestamp: index,
    }));
    testState.prompt = '顺便看看这里为什么会报错？';
    mockSessionActions.generateSessionContent.mockImplementation(
      async function* () {
        yield {
          type: 'delta',
          requestId: 'req-btw-attachment',
          seq: 0,
          text: JSON.stringify({
            suggestion: 'btw',
            confidence: 0.95,
          }),
        };
        yield {
          type: 'done',
          requestId: 'req-btw-attachment',
          model: 'fast-model',
          modelSource: 'fast',
        };
      },
    );

    const { container } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onInputTextChange?.(testState.prompt);
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(121);
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(701);
    });
    await flush();

    expect(
      container.querySelector('[data-testid="btw-suggestion"]'),
    ).not.toBeNull();

    testState.inputAnnotations = [
      {
        type: 'reference',
        text: '@src/App.tsx',
        start: 0,
        end: 12,
        reference: {
          id: 'src/App.tsx',
          value: 'src/App.tsx',
          serialized: '@src/App.tsx',
        },
      },
    ];
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="btw-suggestion-send"]')
        ?.click();
      await Promise.resolve();
    });

    expect(mockSessionActions.btwSession).not.toHaveBeenCalled();
    expect(editorCommit).not.toHaveBeenCalled();
  });

  it('waits for the current session to detach before auto-submitting the suggested new-session draft', async () => {
    vi.useFakeTimers();
    const clear = deferred<void>();
    mockConnection.capabilities.features = ['session_generation'];
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).tokenCount = 600;
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).contextWindow = 1000;
    testState.messages = Array.from({ length: 8 }, (_, index) => ({
      id: `m-delayed-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `existing session topic ${index} about daemon generation review work`,
      timestamp: index,
    }));
    const delayedPrompt =
      'Help me brainstorm Web Shell interaction ideas on top of this interface for a design doc';
    testState.prompt = delayedPrompt;
    mockSessionActions.clearSession.mockImplementation(() => {
      mockConnection.sessionId = undefined;
      return clear.promise;
    });
    mockSessionActions.generateSessionContent.mockImplementation(
      async function* () {
        yield {
          type: 'delta',
          requestId: 'req-2',
          seq: 0,
          text: JSON.stringify({
            suggestion: 'new_session',
            confidence: 0.91,
          }),
        };
        yield {
          type: 'done',
          requestId: 'req-2',
          model: 'fast-model',
          modelSource: 'fast',
        };
      },
    );

    const { container, rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onInputTextChange?.(testState.prompt);
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(121);
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(701);
    });
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="new-session-suggestion-start"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);
    rerender();
    await flush();
    act(() => {
      vi.runOnlyPendingTimers();
    });
    await flush();
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();

    await act(async () => clear.resolve());
    act(() => {
      vi.runOnlyPendingTimers();
    });
    await flush();

    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      delayedPrompt,
      expect.any(Object),
    );
  });

  it('dismisses a stale new-session suggestion after the draft changes before acceptance', async () => {
    vi.useFakeTimers();
    mockConnection.capabilities.features = ['session_generation'];
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).tokenCount = 600;
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).contextWindow = 1000;
    testState.messages = Array.from({ length: 8 }, (_, index) => ({
      id: `m-stale-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `existing session topic ${index} about daemon generation review work`,
      timestamp: index,
    }));
    testState.prompt =
      'Help me brainstorm Web Shell interaction ideas on top of this interface for a design doc';
    mockSessionActions.generateSessionContent.mockImplementation(
      async function* () {
        yield {
          type: 'delta',
          requestId: 'req-stale',
          seq: 0,
          text: JSON.stringify({
            suggestion: 'new_session',
            confidence: 0.91,
          }),
        };
        yield {
          type: 'done',
          requestId: 'req-stale',
          model: 'fast-model',
          modelSource: 'fast',
        };
      },
    );

    const { container } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onInputTextChange?.(testState.prompt);
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(121);
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(701);
    });
    await flush();

    expect(
      container.querySelector('[data-testid="new-session-suggestion"]'),
    ).not.toBeNull();

    testState.prompt = '顺手补个测试并继续当前实现';
    act(() => {
      testState.latestChatEditorProps?.onInputTextChange?.(testState.prompt);
    });
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="new-session-suggestion-start"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await flush();

    expect(mockSessionActions.clearSession).not.toHaveBeenCalled();
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="new-session-suggestion"]'),
    ).toBeNull();
  });

  it('cancels the pending new-session auto-submit when another session becomes active first', async () => {
    vi.useFakeTimers();
    const clear = deferred<void>();
    mockConnection.capabilities.features = ['session_generation'];
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).tokenCount = 600;
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).contextWindow = 1000;
    testState.messages = Array.from({ length: 8 }, (_, index) => ({
      id: `m-switch-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `existing session topic ${index} about daemon generation review work`,
      timestamp: index,
    }));
    testState.prompt =
      'Help me brainstorm Web Shell interaction ideas on top of this interface for a design doc';
    mockSessionActions.clearSession.mockImplementation(() => clear.promise);
    mockSessionActions.generateSessionContent.mockImplementation(
      async function* () {
        yield {
          type: 'delta',
          requestId: 'req-switch',
          seq: 0,
          text: JSON.stringify({
            suggestion: 'new_session',
            confidence: 0.91,
          }),
        };
        yield {
          type: 'done',
          requestId: 'req-switch',
          model: 'fast-model',
          modelSource: 'fast',
        };
      },
    );

    const { container, rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onInputTextChange?.(testState.prompt);
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(121);
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(701);
    });
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="new-session-suggestion-start"]',
        )
        ?.click();
      await Promise.resolve();
    });

    mockConnection.sessionId = 'session-other';
    rerender();
    await flush();

    await act(async () => clear.resolve());
    act(() => {
      vi.runOnlyPendingTimers();
    });
    await flush();

    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
  });

  it('keeps concurrent programmatic submissions behind session preparation', async () => {
    mockConnection.sessionId = undefined;
    const callbackStarted = deferred<void>();
    const callbackFinished = deferred<void>();
    mockSessionActions.createSession.mockImplementation(async () => {
      mockConnection.sessionId = 'session-created';
      mockConnection.workspaceCwd = '/workspace';
      return { sessionId: 'session-created' };
    });
    const onSessionCreated = vi.fn(async () => {
      callbackStarted.resolve();
      await callbackFinished.promise;
    });
    renderApp({ onSessionCreated });
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('first');
      await callbackStarted.promise;
    });
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('second');
      await Promise.resolve();
    });

    expect(mockSessionActions.createSession).toHaveBeenCalledOnce();
    expect(mockSessionActions.attachSession).not.toHaveBeenCalled();
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();

    await act(async () => {
      callbackFinished.resolve();
      await vi.waitFor(() => {
        expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(2);
      });
    });
    expect(mockSessionActions.attachSession).toHaveBeenCalledOnce();
  });

  it('cancels an approved submission when navigation occurs during session preparation', async () => {
    mockConnection.sessionId = undefined;
    const callbackStarted = deferred<void>();
    const callbackFinished = deferred<void>();
    mockSessionActions.createSession.mockImplementation(async () => {
      mockConnection.sessionId = 'session-created';
      return { sessionId: 'session-created' };
    });
    const onSessionCreated = vi.fn(async () => {
      callbackStarted.resolve();
      await callbackFinished.promise;
    });
    const onSubmitBefore = vi.fn().mockResolvedValue(undefined);
    const onSessionChange = vi.fn();
    const { rerender } = renderApp({
      onSessionChange,
      onSessionCreated,
      onSubmitBefore,
    });
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('first');
    });
    await callbackStarted.promise;
    act(() => {
      mockConnection.loadingTranscript = true;
      rerender({
        onSessionChange,
        onSessionCreated,
        onSubmitBefore,
      });
    });
    act(() => {
      mockConnection.loadingTranscript = false;
      rerender({
        onSessionChange,
        onSessionCreated,
        onSubmitBefore,
      });
    });
    await act(async () => {
      callbackFinished.resolve();
      await callbackFinished.promise;
    });
    await flush();

    expect(mockSessionActions.attachSession).toHaveBeenCalledOnce();
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(editorCommit).not.toHaveBeenCalled();
    expect(editorClear).not.toHaveBeenCalled();
    expect(mockFollowup.clear).not.toHaveBeenCalled();
    expect(onSessionChange).not.toHaveBeenCalled();
    expect(testState.prompt).toBe('hello');
  });

  it('cancels a default submission when navigation occurs during session preparation', async () => {
    mockConnection.sessionId = undefined;
    const callbackStarted = deferred<void>();
    const callbackFinished = deferred<void>();
    mockSessionActions.createSession.mockImplementation(async () => {
      mockConnection.sessionId = 'session-created';
      mockConnection.workspaceCwd = '/workspace';
      testState.ownerVersion += 1;
      return { sessionId: 'session-created' };
    });
    const onSessionCreated = vi.fn(async () => {
      callbackStarted.resolve();
      await callbackFinished.promise;
    });
    const onSessionChange = vi.fn();
    const { rerender } = renderApp({ onSessionChange, onSessionCreated });
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('first');
    });
    await callbackStarted.promise;
    const secondCommit = vi.fn();
    let secondAccepted: boolean | void;
    act(() => {
      secondAccepted = testState.latestChatEditorProps?.onSubmit(
        'second',
        undefined,
        secondCommit,
      );
      if (secondAccepted !== false) secondCommit();
    });
    expect(secondAccepted).toBe(false);
    expect(secondCommit).not.toHaveBeenCalled();
    act(() => {
      mockConnection.loadingTranscript = true;
      rerender({
        onSessionChange,
        onSessionCreated,
      });
    });
    act(() => {
      mockConnection.loadingTranscript = false;
      rerender({
        onSessionChange,
        onSessionCreated,
      });
    });
    await act(async () => {
      callbackFinished.resolve();
      await callbackFinished.promise;
    });
    await flush();

    expect(mockSessionActions.attachSession).toHaveBeenCalledOnce();
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(editorCommit).not.toHaveBeenCalled();
    expect(secondCommit).not.toHaveBeenCalled();
    expect(editorClear).not.toHaveBeenCalled();
    expect(mockFollowup.clear).not.toHaveBeenCalled();
    expect(onSessionChange).not.toHaveBeenCalled();
    expect(testState.prompt).toBe('hello');
  });

  it('keeps the first prompt retryable through its lazy session commit', async () => {
    mockConnection.sessionId = undefined;
    const callbackStarted = deferred<void>();
    const callbackFinished = deferred<void>();
    mockSessionActions.createSession.mockImplementation(async () => {
      testState.ownerVersion += 1;
      return { sessionId: 'session-created' };
    });
    const onSessionCreated = vi.fn(async () => {
      callbackStarted.resolve();
      await callbackFinished.promise;
    });
    const onSubmitBefore = vi.fn().mockResolvedValue(undefined);
    const { container, rerender } = renderApp({
      onSessionCreated,
      onSubmitBefore,
    });
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('first');
    });
    await callbackStarted.promise;
    rerender({ onSessionCreated, onSubmitBefore });
    await act(async () => {
      callbackFinished.resolve();
      await callbackFinished.promise;
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.sendPrompt).toHaveBeenCalledOnce();
    });
    act(() => {
      mockConnection.sessionId = 'session-created';
      mockConnection.workspaceCwd = '/workspace';
      rerender({ onSessionCreated, onSubmitBefore });
    });
    await flush();

    act(() => {
      testState.blocks = [
        { kind: 'error', source: 'turn_error', id: 'turn-error-created' },
      ];
      rerender({ onSessionCreated, onSubmitBefore });
    });
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
      await Promise.resolve();
    });
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(2);
    expect(mockSessionActions.sendPrompt).toHaveBeenLastCalledWith(
      'first',
      expect.objectContaining({ retry: true }),
    );
  });

  it('refreshes unknown-workspace retry ownership after accepting a prompt', async () => {
    mockConnection.workspaceCwd = undefined;
    const retrySend = deferred<void>();
    let retryAdmitted: (() => void) | undefined;
    mockSessionActions.sendPrompt
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(
        (
          _text: string,
          options?: {
            onAdmitted?: () => void;
          },
        ) => {
          retryAdmitted = options?.onAdmitted;
          return retrySend.promise;
        },
      );
    const { container, rerender } = renderApp();
    await flush();

    act(() => {
      testState.ownerVersion += 1;
      rerender();
    });
    testState.prompt = 'after reconnect';
    await clickSubmit(container);
    act(() => {
      testState.blocks = [
        { kind: 'error', source: 'turn_error', id: 'turn-error-reconnect' },
      ];
      rerender();
    });
    await flush();
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(2);
    });
    expect(retryAdmitted).toBeTypeOf('function');
    act(() => retryAdmitted?.());
    await act(async () => {
      retrySend.resolve();
      await retrySend.promise;
      testState.streamingState = 'idle';
      rerender();
      await Promise.resolve();
    });
    act(() => {
      testState.streamingState = 'responding';
      rerender();
    });

    expect(testState.latestMessageListProps?.isResponding).toBe(true);
    expect(
      container.querySelector('[data-testid="streaming-status"]'),
    ).not.toBeNull();
  });

  it('clears a stale welcome disable after reasoning becomes mandatory', async () => {
    const reasoningPreview = (canDisable: boolean) => ({
      enabled: true,
      effort: 'xhigh',
      efforts: ['low', 'medium', 'xhigh'],
      defaultEffort: 'xhigh',
      canDisable,
    });
    mockConnection.sessionId = undefined;
    mockConnection.workspaceCwd = '/workspace';
    mockConnection.currentModel = 'qwen3.8-max';
    mockConnection.models = [
      {
        id: 'qwen3.8-max',
        label: 'qwen3.8-max',
        reasoningPreview: reasoningPreview(true),
      },
    ];
    mockSessionActions.createSession.mockImplementation(async () => {
      mockConnection.sessionId = 'session-created';
      return { sessionId: 'session-created' };
    });

    const { rerender } = renderApp();
    await flush();
    act(() => {
      testState.latestChatEditorProps?.onSelectReasoningEffort?.('none');
    });
    await flush();
    expect(testState.latestChatEditorProps?.reasoning?.enabled).toBe(false);

    mockConnection.models = [
      {
        id: 'qwen3.8-max',
        label: 'qwen3.8-max',
        reasoningPreview: reasoningPreview(false),
      },
    ];
    rerender();
    await flush();
    expect(testState.latestChatEditorProps?.reasoning).toMatchObject({
      enabled: true,
      canDisable: false,
      effort: 'xhigh',
    });

    mockConnection.models = [
      {
        id: 'qwen3.8-max',
        label: 'qwen3.8-max',
        reasoningPreview: reasoningPreview(true),
      },
    ];
    rerender();
    await flush();
    expect(testState.latestChatEditorProps?.reasoning).toMatchObject({
      enabled: true,
      canDisable: true,
      effort: 'xhigh',
    });

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('first prompt');
      await vi.waitFor(() => {
        expect(mockSessionActions.sendPrompt).toHaveBeenCalledOnce();
      });
    });
    expect(mockSessionActions.setReasoningEffort).toHaveBeenCalledWith(
      'default',
      { persist: true },
    );
  });

  it.each([false, true])(
    'keeps reasoning persistence scoped with standalone=%s',
    async (standalone) => {
      mockConnection.sessionContext = standalone
        ? { kind: 'standalone' }
        : undefined;
      mockConnection.context = { sessionId: 'session-1' };
      renderApp();
      await flush();
      await act(async () => {
        await testState.latestChatEditorProps?.onSelectReasoningEffort?.(
          'medium',
        );
      });
      expect(mockSessionActions.setReasoningEffort).toHaveBeenCalledWith(
        'medium',
        { persist: !standalone },
      );
    },
  );

  it('does not retarget a stale model-bound reasoning intent', async () => {
    const reasoningPreview = (effort: string) => ({
      enabled: true,
      effort,
      efforts: ['low', 'medium', 'max'],
      defaultEffort: effort,
      canDisable: true,
    });
    mockConnection.sessionId = undefined;
    mockConnection.workspaceCwd = '/workspace';
    mockConnection.currentModel = 'model-a';
    mockConnection.models = [
      {
        id: 'model-a',
        label: 'model-a',
        reasoningPreview: reasoningPreview('low'),
      },
      {
        id: 'model-b',
        label: 'model-b',
        reasoningPreview: reasoningPreview('medium'),
      },
      {
        id: 'model-c',
        label: 'model-c',
        reasoningPreview: reasoningPreview('low'),
      },
    ];

    const { rerender } = renderApp();
    await flush();
    act(() => {
      testState.latestChatEditorProps?.onSelectReasoningEffort?.('max');
    });
    await flush();
    expect(testState.latestChatEditorProps?.reasoning?.effort).toBe('max');

    mockConnection.currentModel = 'model-b';
    rerender();
    await flush();
    expect(testState.latestChatEditorProps?.reasoning?.effort).toBe('medium');

    act(() => {
      testState.latestChatEditorProps?.onSelectModel?.('model-c');
    });
    await flush();

    expect(testState.latestChatEditorProps?.reasoning?.effort).toBe('low');
  });

  it.each([
    ['picker', 'none'],
    ['slash', 'none'],
    ['picker', 'medium'],
    ['slash', 'medium'],
  ] as const)(
    'retains compatible Welcome %s selection %s until first-prompt persistence',
    async (entry, selection) => {
      const targetModel = selection === 'none' ? 'qwen3.7-plus' : 'model-b';
      const tieredPreview = {
        enabled: true,
        effort: 'low',
        efforts: ['low', 'medium', 'xhigh'],
        defaultEffort: 'low',
        canDisable: true,
      };
      mockConnection.sessionId = undefined;
      mockConnection.workspaceCwd = '/workspace';
      mockConnection.currentModel = 'qwen3.8-max';
      mockConnection.models = [
        { id: 'qwen3.8-max', label: 'Source', reasoningPreview: tieredPreview },
        {
          id: targetModel,
          label: 'Target',
          reasoningPreview:
            selection === 'none'
              ? { enabled: true, efforts: [], canDisable: true }
              : tieredPreview,
        },
      ];
      mockSessionActions.createSession.mockImplementation(async () => {
        mockConnection.sessionId = 'session-created';
        return { sessionId: 'session-created' };
      });

      renderApp();
      await flush();
      act(() => {
        testState.latestChatEditorProps?.onSelectReasoningEffort?.(selection);
      });
      await flush();
      act(() => {
        if (entry === 'slash') {
          testState.latestChatEditorProps?.onSubmit(`/model ${targetModel}`);
        } else {
          testState.latestChatEditorProps?.onSelectModel?.(targetModel);
        }
      });
      await flush();

      expect(testState.latestChatEditorProps?.reasoning).toMatchObject(
        selection === 'none'
          ? { enabled: false, efforts: [] }
          : { enabled: true, effort: selection },
      );
      expect(mockSessionActions.createSession).not.toHaveBeenCalled();
      expect(mockSessionActions.setModel).not.toHaveBeenCalled();
      expect(mockSessionActions.setReasoningEffort).not.toHaveBeenCalled();

      await act(async () => {
        testState.latestChatEditorProps?.onSubmit('first prompt');
        await vi.waitFor(() =>
          expect(mockSessionActions.sendPrompt).toHaveBeenCalledOnce(),
        );
      });
      expect(mockSessionActions.setModel).toHaveBeenCalledWith(targetModel);
      expect(mockSessionActions.setReasoningEffort).toHaveBeenCalledWith(
        selection,
        { persist: true },
      );
      expect(
        mockSessionActions.setReasoningEffort.mock.invocationCallOrder[0],
      ).toBeGreaterThan(
        mockSessionActions.setModel.mock.invocationCallOrder[0],
      );
      expect(
        mockSessionActions.sendPrompt.mock.invocationCallOrder[0],
      ).toBeGreaterThan(
        mockSessionActions.setReasoningEffort.mock.invocationCallOrder[0],
      );
    },
  );

  it('commits the first prompt after creating its session', async () => {
    mockConnection.sessionId = undefined;
    mockSessionActions.createSession.mockImplementation(async () => {
      mockConnection.sessionId = 'session-created';
      return { sessionId: 'session-created' };
    });
    const commitAccepted = vi.fn();
    renderApp();
    await flush();

    let accepted: boolean | void = undefined;
    act(() => {
      accepted = testState.latestChatEditorProps?.onSubmit(
        'first prompt',
        undefined,
        undefined,
        commitAccepted,
      );
    });

    expect(accepted).toBe(false);
    await vi.waitFor(() => {
      expect(mockSessionActions.sendPrompt).toHaveBeenCalled();
    });
    expect(mockFollowup.clear).toHaveBeenCalledOnce();
    expect(commitAccepted).toHaveBeenCalledOnce();
    expect(sessionCatalogController.sessionCreated).toHaveBeenCalledWith(
      '/workspace',
      'session-created',
    );
  });

  it('lets a selected session bypass a stale preparation promise', async () => {
    mockConnection.sessionId = undefined;
    const callbackStarted = deferred<void>();
    const callbackFinished = deferred<void>();
    mockSessionActions.createSession.mockImplementation(async () => {
      mockConnection.sessionId = 'session-created';
      return { sessionId: 'session-created' };
    });
    const onSessionCreated = vi.fn(async () => {
      callbackStarted.resolve();
      await callbackFinished.promise;
    });
    const { rerender } = renderApp({ onSessionCreated });
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('first');
      await callbackStarted.promise;
    });
    mockConnection.sessionId = 'session-selected';
    rerender({ onSessionCreated });
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('second');
      await vi.waitFor(() => {
        expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(1);
      });
    });

    expect(mockSessionActions.attachSession).not.toHaveBeenCalled();
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      'second',
      expect.any(Object),
    );

    await act(async () => {
      callbackFinished.resolve();
      await vi.waitFor(() => {
        expect(mockSessionActions.releaseSession).toHaveBeenCalledWith(
          'session-created',
        );
      });
    });
    expect(mockSessionActions.attachSession).not.toHaveBeenCalled();
    expect(mockSessionActions.clearSession).not.toHaveBeenCalled();
  });

  it('lets a selected session bypass creation before its id is allocated', async () => {
    mockConnection.sessionId = undefined;
    const creationFinished = deferred<{ sessionId: string }>();
    mockSessionActions.createSession.mockImplementation(
      () => creationFinished.promise,
    );
    const { container, rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('first');
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.createSession).toHaveBeenCalledOnce();
    });
    act(() => {
      mockConnection.sessionId = 'session-selected';
      testState.blocks = [
        { kind: 'error', source: 'turn_error', id: 'selected-error' },
      ];
      rerender();
    });
    expect(container.querySelector('[data-testid="retry"]')).toBeNull();
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('second');
      await vi.waitFor(() => {
        expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(1);
      });
    });

    expect(mockSessionActions.attachSession).not.toHaveBeenCalled();
    await act(async () => {
      creationFinished.resolve({ sessionId: 'session-created' });
      await vi.waitFor(() => {
        expect(mockSessionActions.releaseSession).toHaveBeenCalledWith(
          'session-created',
        );
      });
    });
    expect(mockSessionActions.attachSession).not.toHaveBeenCalled();
    expect(mockSessionActions.clearSession).not.toHaveBeenCalled();
  });

  it('clears a shared rejected preparation so a later submit can retry', async () => {
    mockConnection.sessionId = undefined;
    const firstCreation = deferred<{ sessionId: string }>();
    mockSessionActions.createSession
      .mockImplementationOnce(() => firstCreation.promise)
      .mockImplementationOnce(async () => {
        mockConnection.sessionId = 'session-retry';
        return { sessionId: 'session-retry' };
      });
    renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('first');
      testState.latestChatEditorProps?.onSubmit('second');
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.createSession).toHaveBeenCalledOnce();
    });
    firstCreation.reject(new Error('create failed'));
    await flush();
    await flush();

    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(mockFollowup.clear).not.toHaveBeenCalled();
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('third');
      await vi.waitFor(() => {
        expect(mockSessionActions.createSession).toHaveBeenCalledTimes(2);
      });
      await vi.waitFor(() => {
        expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(1);
      });
    });
    expect(mockFollowup.clear).toHaveBeenCalledOnce();
  });

  it('cancels direct submissions when onSubmitBefore rejects and preserves retry state', async () => {
    const onSubmitBefore = vi.fn((params: { prompt: string }) =>
      params.prompt === 'blocked'
        ? Promise.reject(new Error('blocked'))
        : Promise.resolve(),
    );
    const { container, rerender } = renderApp({ onSubmitBefore });
    await flush();

    testState.prompt = 'first';
    await clickSubmit(container);
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      'first',
      expect.objectContaining({ retry: undefined }),
    );

    act(() => {
      testState.blocks = [
        { kind: 'error', source: 'turn_error', id: 'turn-error-1' },
      ];
      rerender({ onSubmitBefore });
    });
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();

    mockSessionActions.sendPrompt.mockClear();
    editorClear.mockClear();
    editorCommit.mockClear();
    testState.prompt = 'blocked';
    await clickSubmit(container);
    await flush();

    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(mockFollowup.clear).toHaveBeenCalledTimes(1);
    expect(editorClear).toHaveBeenCalledTimes(0);
    expect(editorCommit).toHaveBeenCalledTimes(0);
    expect(testState.latestChatEditorProps?.isPreparing).toBe(false);
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
      await Promise.resolve();
    });
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      'first',
      expect.objectContaining({ retry: true }),
    );
  });

  it('hides a turn-error retry while a newer prompt awaits admission', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rejectedAdmission = deferred<void>();
    const approvedAdmission = deferred<void>();
    let admissionCount = 0;
    const onSubmitBefore = vi.fn(() => {
      admissionCount += 1;
      if (admissionCount === 1) return Promise.resolve();
      if (admissionCount === 2) return rejectedAdmission.promise;
      return approvedAdmission.promise;
    });
    const { container, rerender } = renderApp({ onSubmitBefore });
    await flush();

    testState.prompt = 'first';
    await clickSubmit(container);
    act(() => {
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-1',
        },
      ];
      rerender({ onSubmitBefore });
    });
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();

    testState.prompt = 'newer';
    await clickSubmit(container);
    expect(testState.latestChatEditorProps?.isPreparing).toBe(true);
    expect(container.querySelector('[data-testid="retry"]')).toBeNull();

    await act(async () => {
      rejectedAdmission.reject(new Error('rejected'));
      await Promise.resolve();
    });
    await flush();
    expect(testState.latestChatEditorProps?.isPreparing).toBe(false);
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledOnce();

    await clickSubmit(container);
    expect(container.querySelector('[data-testid="retry"]')).toBeNull();
    await act(async () => {
      approvedAdmission.resolve();
      await approvedAdmission.promise;
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(2);
    });
    expect(testState.latestChatEditorProps?.isPreparing).toBe(false);
    expect(container.querySelector('[data-testid="retry"]')).toBeNull();
  });

  it('restores a turn-error retry after switching away during admission', async () => {
    let approveRetry: (() => void) | undefined;
    let admissionCount = 0;
    const onSubmitBefore = vi.fn(() => {
      admissionCount += 1;
      if (admissionCount === 1) return Promise.resolve();
      return new Promise<void>((resolve) => {
        approveRetry = resolve;
      });
    });
    const { container, rerender } = renderApp({ onSubmitBefore });
    await flush();

    testState.prompt = 'first';
    await clickSubmit(container);
    act(() => {
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-1',
          promptId: 'prompt-first',
        },
      ];
      rerender({ onSubmitBefore });
    });
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();

    mockSessionActions.sendPrompt.mockClear();
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
    });
    expect(onSubmitBefore).toHaveBeenCalledTimes(2);
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();

    act(() => {
      mockConnection.loadingTranscript = true;
      rerender({ onSubmitBefore });
    });
    const allowBPrompt = vi.fn().mockResolvedValue(undefined);
    act(() => {
      mockConnection.sessionId = 'session-2';
      mockConnection.workspaceCwd = '/tmp/project-2';
      testState.blocks = [];
      testState.ownerVersion += 1;
      mockConnection.loadingTranscript = false;
      rerender({
        onSubmitBefore: allowBPrompt,
      });
    });
    testState.prompt = 'second';
    await clickSubmit(container);
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledOnce();
    expect(mockSessionActions.sendPrompt).toHaveBeenLastCalledWith(
      'second',
      expect.objectContaining({ retry: undefined }),
    );
    await act(async () => {
      approveRetry?.();
      await Promise.resolve();
    });

    expect(mockSessionActions.sendPrompt).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="retry"]')).toBeNull();

    act(() => {
      testState.blocks = [
        { kind: 'error', source: 'turn_error', id: 'turn-error-2' },
      ];
      rerender({ onSubmitBefore: allowBPrompt });
    });
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
      await Promise.resolve();
    });
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(2);
    expect(mockSessionActions.sendPrompt).toHaveBeenLastCalledWith(
      'second',
      expect.objectContaining({
        optimisticUserMessage: false,
        retry: true,
      }),
    );

    act(() => {
      mockConnection.sessionId = 'session-1';
      mockConnection.workspaceCwd = '/tmp/project';
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-1',
          promptId: 'prompt-first',
        },
      ];
      testState.ownerVersion += 1;
      rerender({ onSubmitBefore });
    });
    await flush();

    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();
    const allowRetry = vi.fn().mockResolvedValue(undefined);
    rerender({ onSubmitBefore: allowRetry });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
      await Promise.resolve();
    });
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(3);
    expect(mockSessionActions.sendPrompt).toHaveBeenLastCalledWith(
      'first',
      expect.objectContaining({
        optimisticUserMessage: false,
        retry: true,
      }),
    );
  });

  it('carries file attachments through a cancelled turn-error retry restoration', async () => {
    let approveRetry: (() => void) | undefined;
    let admissionCount = 0;
    const onSubmitBefore = vi.fn(() => {
      admissionCount += 1;
      if (admissionCount === 1) return Promise.resolve();
      return new Promise<void>((resolve) => {
        approveRetry = resolve;
      });
    });
    const files = [
      { name: 'app.log', media_type: 'text/plain', text: 'SECRET=1' },
    ];
    const { container, rerender } = renderApp({ onSubmitBefore });
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit(
        'first',
        undefined,
        files,
        undefined,
      );
      await Promise.resolve();
    });
    act(() => {
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-1',
          promptId: 'prompt-first',
        },
      ];
      rerender({ onSubmitBefore });
    });
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();

    mockSessionActions.sendPrompt.mockClear();
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
    });
    act(() => {
      mockConnection.loadingTranscript = true;
      rerender({ onSubmitBefore });
    });

    const allowBPrompt = vi.fn().mockResolvedValue(undefined);
    act(() => {
      mockConnection.sessionId = 'session-2';
      mockConnection.workspaceCwd = '/tmp/project-2';
      testState.blocks = [];
      testState.ownerVersion += 1;
      mockConnection.loadingTranscript = false;
      rerender({ onSubmitBefore: allowBPrompt });
    });
    const otherFiles = [
      { name: 'b.log', media_type: 'text/plain', text: 'OTHER=1' },
    ];
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit(
        'second',
        undefined,
        otherFiles,
        undefined,
      );
      await Promise.resolve();
    });
    expect(mockSessionActions.sendPrompt).toHaveBeenLastCalledWith(
      'second',
      expect.objectContaining({ files: otherFiles }),
    );
    await act(async () => {
      approveRetry?.();
      await Promise.resolve();
    });
    // The gate resolved after the session switched away — the cancelled
    // retry must NOT resubmit; only 'second' has been sent so far.
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(1);

    act(() => {
      mockConnection.sessionId = 'session-1';
      mockConnection.workspaceCwd = '/tmp/project';
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-1',
          promptId: 'prompt-first',
        },
      ];
      testState.ownerVersion += 1;
      rerender({ onSubmitBefore });
    });
    await flush();

    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();
    mockSessionActions.sendPrompt.mockClear();
    const allowRetry = vi.fn().mockResolvedValue(undefined);
    rerender({ onSubmitBefore: allowRetry });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
      await Promise.resolve();
    });
    expect(mockSessionActions.sendPrompt).toHaveBeenLastCalledWith(
      'first',
      expect.objectContaining({
        files: [
          expect.objectContaining({
            name: 'app.log',
            media_type: 'text/plain',
            text: 'SECRET=1',
          }),
        ],
        optimisticUserMessage: false,
        retry: true,
      }),
    );
  });

  it('defers retry restoration until navigation commits', async () => {
    const retryApproval = deferred<void>();
    let admissionCount = 0;
    const onSubmitBefore = vi.fn(() => {
      admissionCount += 1;
      return admissionCount === 1 ? Promise.resolve() : retryApproval.promise;
    });
    const { container, rerender } = renderApp({ onSubmitBefore });
    await flush();

    testState.prompt = 'first';
    await clickSubmit(container);
    act(() => {
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-1',
          promptId: 'prompt-first',
        },
      ];
      rerender({ onSubmitBefore });
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
      mockConnection.loadingTranscript = true;
      rerender({ onSubmitBefore });
    });
    await act(async () => {
      retryApproval.resolve();
      await retryApproval.promise;
    });
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="retry"]')).toBeNull();
    act(() => {
      mockConnection.sessionId = 'session-1';
      mockConnection.workspaceCwd = '/tmp/project-2';
      testState.blocks = [
        { kind: 'error', source: 'turn_error', id: 'turn-error-2' },
      ];
      testState.ownerVersion += 1;
      mockConnection.loadingTranscript = false;
      rerender({ onSubmitBefore });
    });
    act(() => {
      mockConnection.sessionId = 'session-1';
      mockConnection.workspaceCwd = '/tmp/project';
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-1',
          promptId: 'prompt-first',
        },
      ];
      testState.ownerVersion += 1;
      rerender({ onSubmitBefore });
    });
    await flush();

    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();
  });

  it('waits for the source transcript before restoring a cancelled retry', async () => {
    let approveRetry: (() => void) | undefined;
    let admissionCount = 0;
    const onSubmitBefore = vi.fn(() => {
      admissionCount += 1;
      if (admissionCount === 1) return Promise.resolve();
      return new Promise<void>((resolve) => {
        approveRetry = resolve;
      });
    });
    const { container, rerender } = renderApp({ onSubmitBefore });
    await flush();

    testState.prompt = 'first';
    await clickSubmit(container);
    act(() => {
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-1',
          promptId: 'prompt-first',
        },
      ];
      rerender({ onSubmitBefore });
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
      mockConnection.loadingTranscript = true;
      rerender({ onSubmitBefore });
    });
    act(() => {
      mockConnection.sessionId = 'session-2';
      mockConnection.workspaceCwd = '/tmp/project-2';
      testState.blocks = [];
      testState.ownerVersion += 1;
      mockConnection.loadingTranscript = false;
      rerender({ onSubmitBefore });
    });
    act(() => {
      mockConnection.sessionId = 'session-1';
      mockConnection.workspaceCwd = '/tmp/project';
      mockConnection.loadingTranscript = true;
      testState.ownerVersion += 1;
      rerender({ onSubmitBefore });
    });
    await act(async () => {
      approveRetry?.();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="retry"]')).toBeNull();

    act(() => {
      mockConnection.loadingTranscript = false;
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-1',
          promptId: 'prompt-first',
        },
      ];
      rerender({ onSubmitBefore });
    });
    await flush();

    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();
  });

  it('does not restore a stale turn-error retry after the source advances', async () => {
    let approveRetry: (() => void) | undefined;
    let admissionCount = 0;
    const onSubmitBefore = vi.fn(() => {
      admissionCount += 1;
      if (admissionCount === 1) return Promise.resolve();
      return new Promise<void>((resolve) => {
        approveRetry = resolve;
      });
    });
    const { container, rerender } = renderApp({ onSubmitBefore });
    await flush();

    testState.prompt = 'first';
    await clickSubmit(container);
    act(() => {
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-1',
          eventId: 100,
          promptId: 'prompt-old',
        },
      ];
      rerender({ onSubmitBefore });
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
    });

    act(() => {
      mockConnection.loadingTranscript = true;
      rerender({ onSubmitBefore });
    });
    act(() => {
      mockConnection.sessionId = 'session-2';
      mockConnection.workspaceCwd = '/tmp/project-2';
      testState.blocks = [];
      testState.ownerVersion += 1;
      mockConnection.loadingTranscript = false;
      rerender({ onSubmitBefore });
    });

    const allowNewerPrompt = vi.fn().mockResolvedValue(undefined);
    act(() => {
      mockConnection.sessionId = 'session-1';
      mockConnection.workspaceCwd = '/tmp/project';
      testState.blocks = [];
      testState.ownerVersion += 1;
      rerender({ onSubmitBefore: allowNewerPrompt });
    });
    testState.prompt = 'newer';
    await clickSubmit(container);
    act(() => {
      testState.blocks = [
        { kind: 'user', id: 'newer-user' },
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-1',
          eventId: 200,
          promptId: 'prompt-new',
        },
      ];
      rerender({ onSubmitBefore: allowNewerPrompt });
    });
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();

    await act(async () => {
      approveRetry?.();
      await Promise.resolve();
    });
    await flush();

    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
      await Promise.resolve();
    });
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(3);
    expect(mockSessionActions.sendPrompt).toHaveBeenLastCalledWith(
      'newer',
      expect.objectContaining({ retry: true }),
    );
  });

  it('preserves the newer cancelled retry when admissions settle out of order', async () => {
    const oldRetryApproval = deferred<void>();
    const newerRetryApproval = deferred<void>();
    let admissionCount = 0;
    const onSubmitBefore = vi.fn(() => {
      admissionCount += 1;
      if (admissionCount === 2) return oldRetryApproval.promise;
      if (admissionCount === 4) return newerRetryApproval.promise;
      return Promise.resolve();
    });
    const oldError = {
      kind: 'error',
      source: 'turn_error',
      id: 'turn-error-old',
      promptId: 'prompt-old',
    } as const;
    const newerError = {
      kind: 'error',
      source: 'turn_error',
      id: 'turn-error-newer',
      promptId: 'prompt-newer',
    } as const;
    const { container, rerender } = renderApp({ onSubmitBefore });
    await flush();

    testState.prompt = 'first';
    await clickSubmit(container);
    act(() => {
      testState.blocks = [oldError];
      rerender({ onSubmitBefore });
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
    });
    expect(onSubmitBefore).toHaveBeenCalledTimes(2);

    act(() => {
      mockConnection.loadingTranscript = true;
      rerender({ onSubmitBefore });
    });
    act(() => {
      mockConnection.sessionId = 'session-2';
      mockConnection.workspaceCwd = '/tmp/project-2';
      testState.blocks = [];
      testState.ownerVersion += 1;
      mockConnection.loadingTranscript = false;
      rerender({ onSubmitBefore });
    });
    act(() => {
      mockConnection.sessionId = 'session-1';
      mockConnection.workspaceCwd = '/tmp/project';
      testState.blocks = [];
      testState.ownerVersion += 1;
      rerender({ onSubmitBefore });
    });

    testState.prompt = 'newer';
    await clickSubmit(container);
    act(() => {
      testState.blocks = [newerError];
      rerender({ onSubmitBefore });
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
    });
    expect(onSubmitBefore).toHaveBeenCalledTimes(4);

    act(() => {
      mockConnection.loadingTranscript = true;
      rerender({ onSubmitBefore });
    });
    act(() => {
      mockConnection.sessionId = 'session-2';
      mockConnection.workspaceCwd = '/tmp/project-2';
      testState.blocks = [];
      testState.ownerVersion += 1;
      mockConnection.loadingTranscript = false;
      rerender({ onSubmitBefore });
    });
    await act(async () => {
      newerRetryApproval.resolve();
      await newerRetryApproval.promise;
    });
    await act(async () => {
      oldRetryApproval.resolve();
      await oldRetryApproval.promise;
    });

    act(() => {
      mockConnection.sessionId = 'session-1';
      mockConnection.workspaceCwd = '/tmp/project';
      testState.blocks = [newerError];
      testState.ownerVersion += 1;
      rerender({ onSubmitBefore });
    });
    await flush();

    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
      await Promise.resolve();
    });
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(3);
    expect(mockSessionActions.sendPrompt).toHaveBeenLastCalledWith(
      'newer',
      expect.objectContaining({ retry: true }),
    );
  });

  it('allows manual retry after a model stream interrupted turn error with an active Goal', async () => {
    const retrySend = deferred<void>();
    mockConnection.goalState = activeGoalSnapshot('keep working');
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = 'recover this stream';
    await clickSubmit(container);
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      'recover this stream',
      expect.objectContaining({ retry: undefined }),
    );

    mockSessionActions.sendPrompt.mockClear();
    act(() => {
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-stream-interrupted',
          errorKind: 'model_stream_interrupted',
          text: 'terminated',
        },
      ];
      rerender();
    });

    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();

    const staleRetry = testState.latestMessageListProps?.onRetryClick;
    act(() => {
      testState.sessionHasActivePrompt = true;
      rerender();
    });
    expect(container.querySelector('[data-testid="retry"]')).toBeNull();
    act(() => staleRetry?.());
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    act(() => {
      testState.sessionHasActivePrompt = false;
      rerender();
    });

    mockSessionActions.sendPrompt.mockImplementationOnce(
      () => retrySend.promise,
    );
    const retryStartedAt = Date.now();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
      await Promise.resolve();
    });

    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      'recover this stream',
      expect.objectContaining({
        optimisticUserMessage: false,
        retry: true,
      }),
    );

    testState.streamingState = 'responding';
    rerender();
    expect(testState.latestMessageListProps?.isResponding).toBe(false);
    expect(testState.latestMessageListProps?.transcriptReloadPaused).toBe(true);
    expect(
      testState.latestMessageListProps?.activeTurnStartedAt,
    ).toBeUndefined();

    const retryOptions = mockSessionActions.sendPrompt.mock.calls.at(
      -1,
    )?.[1] as { onAdmitted?: () => void } | undefined;
    act(() => retryOptions?.onAdmitted?.());

    expect(testState.latestMessageListProps?.isResponding).toBe(true);
    expect(
      testState.latestMessageListProps?.activeTurnStartedAt,
    ).toBeGreaterThanOrEqual(retryStartedAt);

    await act(async () => {
      retrySend.resolve();
      testState.streamingState = 'idle';
      rerender();
      await Promise.resolve();
    });
  });

  it('asks for a new instruction instead of retrying a loop-detected turn', async () => {
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = 'repeat this';
    await clickSubmit(container);

    act(() => {
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-loop',
          errorKind: 'loop_detected',
          text: 'internal fallback',
        },
      ];
      rerender();
    });

    expect(container.querySelector('[data-testid="retry"]')).toBeNull();
    expect(testState.latestChatEditorProps?.disabled).toBe(false);
  });

  it('still reports a loop-detected turn error through turn_complete', async () => {
    const onSessionChange = vi.fn();
    const { container, rerender } = renderApp({ onSessionChange });
    await flush();

    testState.prompt = 'repeat this';
    await clickSubmit(container);
    onSessionChange.mockClear();

    act(() => {
      testState.streamingState = 'responding';
      rerender({ onSessionChange });
    });
    act(() => {
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-loop',
          errorKind: 'loop_detected',
          text: 'internal fallback',
        },
      ];
      testState.streamingState = 'idle';
      rerender({ onSessionChange });
    });

    expect(onSessionChange).toHaveBeenCalledWith({
      type: 'turn_complete',
      sessionId: 'session-1',
      error: expect.objectContaining({
        message: 'Turn error (block turn-error-loop)',
      }),
    });
    expect(container.querySelector('[data-testid="retry"]')).toBeNull();
  });

  it('reports the turn error through turn_complete across a trailing background notification', async () => {
    // turn_complete and the retry decision read the same backward walk, so
    // a background-notification user block after the turn error must not
    // hide the error from the host while the UI still offers retry.
    const onSessionChange = vi.fn();
    const { container, rerender } = renderApp({ onSessionChange });
    await flush();

    testState.prompt = 'interrupt this stream';
    await clickSubmit(container);
    onSessionChange.mockClear();

    act(() => {
      testState.streamingState = 'responding';
      rerender({ onSessionChange });
    });
    act(() => {
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-with-notification',
          errorKind: 'model_stream_interrupted',
          text: 'terminated',
        },
        {
          id: 'background-1',
          kind: 'user',
          text: 'Background task completed',
          meta: { source: 'background_notification' },
        },
      ];
      testState.streamingState = 'idle';
      rerender({ onSessionChange });
    });

    expect(onSessionChange).toHaveBeenCalledWith({
      type: 'turn_complete',
      sessionId: 'session-1',
      error: expect.objectContaining({
        message: 'Turn error (block turn-error-with-notification)',
      }),
    });
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();
  });

  it('does not rearm a retry when the retried turn is loop-stopped', async () => {
    // When the retried turn itself is stopped by loop protection, the
    // catch path must not arm retry state on the loop error: Ctrl+Y
    // calls handleRetry() directly even while the retry button is
    // hidden, and resubmitting the stopped prompt tends to re-loop.
    const retrySend = deferred<void>();
    mockSessionActions.sendPrompt
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(retrySend.promise);
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = 'repeat this';
    await clickSubmit(container);
    act(() => {
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-1',
          promptId: 'prompt-1',
        },
      ];
      rerender();
    });
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(2);
    });
    const retryOptions = mockSessionActions.sendPrompt.mock.calls[1]?.[1];

    // The loop turn_error lands before the rejection settles, so the
    // catch walk already sees it when the re-arm runs.
    act(() => {
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-1',
          promptId: 'prompt-1',
        },
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-loop',
          promptId: 'prompt-2',
          errorKind: 'loop_detected',
          text: 'internal fallback',
        },
      ];
      rerender();
    });
    act(() => {
      retryOptions?.onAdmissionStarted?.();
      retryOptions?.onAdmitted?.();
    });

    await act(async () => {
      retrySend.reject(
        Object.assign(new Error('loop protection stopped the turn'), {
          _daemonTurnError: true,
          body: 'LOOP_DETECTED',
        }),
      );
      await Promise.resolve();
    });
    await flush();

    expect(container.querySelector('[data-testid="retry"]')).toBeNull();
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'y', ctrlKey: true }),
      );
      await Promise.resolve();
    });
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(2);
  });

  it('does not reoffer a loop-stopped retry to a later unrelated turn error', async () => {
    // The rejection settles before the loop turn_error block commits
    // (microtask vs transcript flush), so the catch walk still sees the
    // original error. The stashed prompt must not survive the loop stop
    // and be consumed by a later unrelated retryable turn error, which
    // would resubmit the loop-stopped prompt misattributed to a turn
    // the user never submitted.
    const retrySend = deferred<void>();
    mockSessionActions.sendPrompt
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(retrySend.promise)
      .mockResolvedValueOnce(undefined);
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = 'repeat this';
    await clickSubmit(container);
    act(() => {
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-1',
          promptId: 'prompt-1',
        },
      ];
      rerender();
    });
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(2);
    });
    const retryOptions = mockSessionActions.sendPrompt.mock.calls[1]?.[1];
    act(() => {
      retryOptions?.onAdmissionStarted?.();
      retryOptions?.onAdmitted?.();
    });

    await act(async () => {
      retrySend.reject(
        Object.assign(new Error('loop protection stopped the turn'), {
          _daemonTurnError: true,
          body: 'LOOP_DETECTED',
        }),
      );
      await Promise.resolve();
    });
    await flush();

    act(() => {
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-1',
          promptId: 'prompt-1',
        },
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-loop',
          promptId: 'prompt-2',
          errorKind: 'loop_detected',
          text: 'internal fallback',
        },
      ];
      rerender();
    });
    await flush();
    expect(container.querySelector('[data-testid="retry"]')).toBeNull();

    act(() => {
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-1',
          promptId: 'prompt-1',
        },
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-loop',
          promptId: 'prompt-2',
          errorKind: 'loop_detected',
          text: 'internal fallback',
        },
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-3',
          promptId: 'prompt-3',
        },
      ];
      rerender();
    });
    await flush();

    expect(container.querySelector('[data-testid="retry"]')).toBeNull();
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'y', ctrlKey: true }),
      );
      await Promise.resolve();
    });
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(2);
  });

  it('does not report the previous turn error again when a retry settles without content', async () => {
    // The retry turn settles while the transcript still ends with the
    // original turn error (settle precedes the transcript flush); the
    // turn_complete for that turn must not re-report the error the user
    // already retried.
    const onSessionChange = vi.fn();
    const retrySend = deferred<void>();
    mockSessionActions.sendPrompt
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(retrySend.promise);
    const { container, rerender } = renderApp({ onSessionChange });
    await flush();

    testState.prompt = 'recover this stream';
    await clickSubmit(container);
    onSessionChange.mockClear();

    act(() => {
      testState.streamingState = 'responding';
      rerender({ onSessionChange });
    });
    act(() => {
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-1',
          promptId: 'prompt-1',
        },
      ];
      testState.streamingState = 'idle';
      rerender({ onSessionChange });
    });
    expect(onSessionChange).toHaveBeenCalledWith({
      type: 'turn_complete',
      sessionId: 'session-1',
      error: expect.objectContaining({
        message: 'Turn error (block turn-error-1)',
      }),
    });
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      retrySend.resolve();
      await Promise.resolve();
    });
    await flush();

    act(() => {
      testState.streamingState = 'responding';
      rerender({ onSessionChange });
    });
    onSessionChange.mockClear();
    act(() => {
      testState.streamingState = 'idle';
      rerender({ onSessionChange });
    });

    expect(onSessionChange).toHaveBeenCalledWith({
      type: 'turn_complete',
      sessionId: 'session-1',
      error: undefined,
    });
  });

  it.each([
    ['a fresh prompt id', 'prompt-2'],
    ['a reused prompt id', 'prompt-1'],
  ])(
    'reoffers a turn-error retry when the retried turn fails with %s',
    async (_label, nextPromptId) => {
      const retrySend = deferred<void>();
      mockSessionActions.sendPrompt
        .mockResolvedValueOnce(undefined)
        .mockReturnValueOnce(retrySend.promise)
        .mockResolvedValueOnce(undefined);
      const { container, rerender } = renderApp();
      await flush();

      testState.prompt = 'recover this stream';
      await clickSubmit(container);
      act(() => {
        testState.blocks = [
          {
            kind: 'error',
            source: 'turn_error',
            id: 'turn-error-1',
            promptId: 'prompt-1',
          },
        ];
        rerender();
      });
      act(() => {
        container
          .querySelector<HTMLButtonElement>('[data-testid="retry"]')
          ?.click();
      });
      await vi.waitFor(() => {
        expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(2);
      });
      const retryOptions = mockSessionActions.sendPrompt.mock.calls[1]?.[1];

      act(() => {
        retryOptions?.onAdmissionStarted?.();
        retryOptions?.onAdmitted?.();
      });
      await act(async () => {
        retrySend.reject(
          Object.assign(new Error('retried turn failed'), {
            _daemonTurnError: true,
          }),
        );
        await Promise.resolve();
      });
      expect(container.querySelector('[data-testid="retry"]')).toBeNull();
      act(() => {
        testState.blocks = [
          {
            kind: 'error',
            source: 'turn_error',
            id: 'turn-error-1',
            promptId: 'prompt-1',
          },
          {
            kind: 'error',
            source: 'turn_error',
            id: 'turn-error-2',
            promptId: nextPromptId,
          },
        ];
        rerender();
      });
      await flush();

      expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();
      act(() => {
        container
          .querySelector<HTMLButtonElement>('[data-testid="retry"]')
          ?.click();
      });
      await flush();
      expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(3);
      expect(mockSessionActions.sendPrompt).toHaveBeenLastCalledWith(
        'recover this stream',
        expect.objectContaining({ retry: true }),
      );
    },
  );

  it('restores a turn-error retry when resend fails before admission starts', async () => {
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = 'recover this stream';
    await clickSubmit(container);
    act(() => {
      testState.blocks = [
        { kind: 'error', source: 'turn_error', id: 'turn-error-network' },
      ];
      rerender();
    });
    mockSessionActions.sendPrompt.mockRejectedValueOnce(
      new TypeError('network unavailable'),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
    });
    await flush();

    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();
  });

  it('keeps a turn-error retry visible through background notifications', async () => {
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = 'recover this stream';
    await clickSubmit(container);
    act(() => {
      testState.blocks = [
        { kind: 'error', source: 'turn_error', id: 'turn-error-background' },
        {
          id: 'background-1',
          kind: 'user',
          text: 'Background task completed',
          meta: { source: 'background_notification' },
        },
      ];
      rerender();
    });

    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();
  });

  it('preserves the turn-error retry while session writes are blocked', async () => {
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = 'recover this stream';
    await clickSubmit(container);
    mockSessionActions.sendPrompt.mockClear();
    act(() => {
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-switching',
          errorKind: 'model_stream_interrupted',
          text: 'terminated',
        },
      ];
      mockConnection.loadingTranscript = true;
      rerender({});
    });

    const retry = container.querySelector<HTMLButtonElement>(
      '[data-testid="retry"]',
    );
    expect(retry).not.toBeNull();
    act(() => retry?.click());

    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();

    act(() => {
      mockConnection.loadingTranscript = false;
      rerender({});
    });
    await flush();
    const unblockedRetry = container.querySelector<HTMLButtonElement>(
      '[data-testid="retry"]',
    );
    expect(unblockedRetry).not.toBeNull();
    act(() => unblockedRetry?.click());
    await flush();
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledOnce();
  });

  it('settles a rejected turn-error retry after workspace enrichment', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const retrySend = deferred<void>();
    mockConnection.sessionId = 'session-late';
    mockConnection.workspaceCwd = undefined;
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = 'recover this stream';
    await clickSubmit(container);
    mockSessionActions.sendPrompt.mockClear();
    act(() => {
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-workspace-enrichment',
          errorKind: 'model_stream_interrupted',
          text: 'terminated',
        },
      ];
      rerender();
    });
    mockSessionActions.sendPrompt.mockReturnValueOnce(retrySend.promise);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.sendPrompt).toHaveBeenCalledOnce();
    });
    act(() => {
      mockConnection.workspaceCwd = '/tmp/project';
      rerender();
    });
    await act(async () => {
      retrySend.reject(new DaemonHttpError(413, {}, 'Retry rejected'));
      await Promise.resolve();
    });
    await flush();

    expect(error).toHaveBeenCalled();
    act(() => {
      testState.streamingState = 'responding';
      rerender();
    });
    expect(
      container.querySelector('[data-testid="streaming-status"]'),
    ).not.toBeNull();
    expect(testState.latestMessageListProps?.isResponding).toBe(true);
  });

  it('does not settle a turn-error retry into a different workspace', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const retrySend = deferred<void>();
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = 'recover this stream';
    await clickSubmit(container);
    mockSessionActions.sendPrompt.mockClear();
    act(() => {
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-cross-workspace',
          errorKind: 'model_stream_interrupted',
          text: 'terminated',
        },
      ];
      rerender();
    });
    mockSessionActions.sendPrompt.mockReturnValueOnce(retrySend.promise);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
      await Promise.resolve();
    });
    const retryOptions = mockSessionActions.sendPrompt.mock.calls[0]?.[1];
    act(() => {
      retryOptions?.onAdmissionStarted?.();
      mockConnection.workspaceCwd = '/other-workspace';
      testState.ownerVersion += 1;
      rerender();
    });
    await act(async () => {
      retrySend.reject(new Error('response lost'));
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="prompt-admission-unknown"]'),
    ).toBeNull();
    expect(warn).not.toHaveBeenCalledWith(
      '[WebShell] post-turn retry admission outcome is unknown',
      expect.anything(),
    );
    warn.mockRestore();
  });

  it('locks an image retry when its admission response is lost', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const retrySend = deferred<void>();
    const images = [{ data: 'aGVsbG8=', media_type: 'image/png' }];
    const inputAnnotations: DaemonInputAnnotation[] = [
      {
        type: 'reference',
        start: 0,
        end: 5,
        text: 'hello',
        reference: { id: 'file:hello', kind: 'file', value: 'hello' },
      },
    ];
    const { container, rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit(
        'hello',
        images,
        undefined,
        editorCommit,
        {
          inputAnnotations,
        },
      );
    });
    await flush();
    mockSessionActions.sendPrompt.mockClear();
    act(() => {
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-retry',
          errorKind: 'model_stream_interrupted',
          text: 'terminated',
        },
      ];
      rerender();
    });
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();
    mockSessionActions.sendPrompt.mockReturnValueOnce(retrySend.promise);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.sendPrompt).toHaveBeenCalledOnce();
    });
    const retryOptions = mockSessionActions.sendPrompt.mock.calls[0]?.[1];
    expect(retryOptions).toMatchObject({
      images,
      inputAnnotations,
      optimisticUserMessage: false,
      retry: true,
    });
    act(() => retryOptions?.onAdmissionStarted?.());
    await act(async () => {
      retrySend.reject(new Error('response lost'));
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="prompt-admission-unknown"]'),
    ).not.toBeNull();
    expect(testState.latestChatEditorProps?.disabled).toBe(true);
    expect(
      sessionCatalogController.promptAdmissionUncertain,
    ).toHaveBeenCalledWith('/tmp/project');
    expect(sessionCatalogController.promptAdmitted).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('gates queued submissions and only enqueues after approval', async () => {
    let approve: (() => void) | undefined;
    const onSubmitBefore = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          approve = resolve;
        }),
    );
    const onSessionChange = vi.fn();
    const { container, rerender } = renderApp({
      onSubmitBefore,
      onSessionChange,
    });
    await flush();

    act(() => {
      testState.streamingState = 'responding';
      rerender({ onSubmitBefore, onSessionChange });
    });
    testState.prompt = 'queued';
    await clickSubmit(container);
    expect(rawEnqueuePrompt).not.toHaveBeenCalled();
    expect(editorClear).not.toHaveBeenCalled();
    expect(editorCommit).not.toHaveBeenCalled();

    await act(async () => {
      approve?.();
      await Promise.resolve();
    });

    expect(rawEnqueuePrompt).toHaveBeenCalledWith(
      'queued',
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(onSessionChange).toHaveBeenCalledWith({
      type: 'submit',
      sessionId: 'session-1',
      prompt: 'queued',
      queued: true,
    });
    expect(editorCommit).toHaveBeenCalledTimes(1);
    expect(editorClear).not.toHaveBeenCalled();
  });

  it('freezes a normalized prepared submission before it enters the queue', async () => {
    const inputAnnotations: DaemonInputAnnotation[] = [
      {
        type: 'reference',
        start: 0,
        end: 6,
        text: 'queued',
        reference: { id: 'queued', kind: 'file' },
      },
    ];
    const prepareSubmit = vi.fn().mockResolvedValue({
      prompt: 'queued target',
      inputAnnotations,
    });
    const onSessionChange = vi.fn();
    const { container, rerender } = renderApp({
      prepareSubmit,
      onSessionChange,
    });
    await flush();

    act(() => {
      testState.streamingState = 'responding';
      rerender({ prepareSubmit, onSessionChange });
    });
    testState.prompt = 'queued';
    await clickSubmit(container);
    await flush();

    expect(prepareSubmit).toHaveBeenCalledOnce();
    expect(prepareSubmit).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: 'queued',
      inputAnnotations: [],
    });
    expect(rawEnqueuePrompt).toHaveBeenCalledWith(
      'queued target',
      undefined,
      undefined,
      undefined,
      inputAnnotations,
    );
    expect(onSessionChange).toHaveBeenCalledWith({
      type: 'submit',
      sessionId: 'session-1',
      prompt: 'queued target',
      queued: true,
    });
  });

  it('cancels an approved queued submission after an A-to-B-to-A owner cycle', async () => {
    let approve: (() => void) | undefined;
    const onSubmitBefore = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          approve = resolve;
        }),
    );
    const { container, rerender } = renderApp({ onSubmitBefore });
    await flush();

    act(() => {
      testState.streamingState = 'responding';
      rerender({ onSubmitBefore });
    });
    testState.prompt = 'queued';
    await clickSubmit(container);

    act(() => {
      mockConnection.sessionId = 'session-2';
      mockConnection.workspaceCwd = '/tmp/project-2';
      testState.ownerVersion += 1;
      rerender({ onSubmitBefore });
    });
    act(() => {
      mockConnection.sessionId = 'session-1';
      mockConnection.workspaceCwd = '/tmp/project';
      testState.ownerVersion += 1;
      rerender({ onSubmitBefore });
    });
    await act(async () => {
      approve?.();
      await Promise.resolve();
    });

    expect(rawEnqueuePrompt).not.toHaveBeenCalled();
    expect(editorCommit).not.toHaveBeenCalled();
    expect(editorClear).not.toHaveBeenCalled();
  });

  it('cancels an approved queued submission after a session transition', async () => {
    let approve: (() => void) | undefined;
    const onSubmitBefore = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          approve = resolve;
        }),
    );
    const onSessionChange = vi.fn();
    const { container, rerender } = renderApp({
      onSubmitBefore,
      onSessionChange,
    });
    await flush();

    act(() => {
      testState.streamingState = 'responding';
      rerender({ onSubmitBefore, onSessionChange });
    });
    testState.prompt = 'queued';
    await clickSubmit(container);

    act(() => {
      mockConnection.loadingTranscript = true;
      rerender({
        onSubmitBefore,
        onSessionChange,
      });
    });
    act(() => {
      mockConnection.loadingTranscript = false;
      rerender({
        onSubmitBefore,
        onSessionChange,
      });
    });
    await act(async () => {
      approve?.();
      await Promise.resolve();
    });

    expect(rawEnqueuePrompt).not.toHaveBeenCalled();
    expect(editorCommit).not.toHaveBeenCalled();
    expect(editorClear).not.toHaveBeenCalled();
    expect(onSessionChange).not.toHaveBeenCalled();
    expect(testState.prompt).toBe('queued');
  });

  it('does not enqueue an approved queued submission after the App unmounts', async () => {
    const approval = deferred<void>();
    const onSubmitBefore = vi.fn(() => approval.promise);
    const { container, rerender, unmount } = renderApp({ onSubmitBefore });
    await flush();

    act(() => {
      testState.streamingState = 'responding';
      rerender({ onSubmitBefore });
    });
    testState.prompt = 'queued';
    await clickSubmit(container);
    expect(onSubmitBefore).toHaveBeenCalledOnce();
    unmount();
    await act(async () => {
      approval.resolve();
      await approval.promise;
    });

    expect(rawEnqueuePrompt).not.toHaveBeenCalled();
    expect(editorCommit).not.toHaveBeenCalled();
    expect(editorClear).not.toHaveBeenCalled();
  });

  it('cancels queued submissions when onSubmitBefore rejects', async () => {
    const onSubmitBefore = vi.fn().mockRejectedValue(new Error('blocked'));
    const { container, rerender } = renderApp({ onSubmitBefore });
    await flush();

    act(() => {
      testState.streamingState = 'responding';
      rerender({ onSubmitBefore });
    });
    await clickSubmit(container);
    await flush();

    expect(rawEnqueuePrompt).not.toHaveBeenCalled();
    expect(editorClear).not.toHaveBeenCalled();
    expect(editorCommit).not.toHaveBeenCalled();
  });

  it('cancels a queued submission when the owner changes while preparing', async () => {
    let finishPrepare: (() => void) | undefined;
    const prepareSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishPrepare = resolve;
        }),
    );
    const onSubmitBefore = vi.fn().mockResolvedValue(undefined);
    const { container, rerender } = renderApp({
      prepareSubmit,
      onSubmitBefore,
    });
    await flush();

    act(() => {
      testState.streamingState = 'responding';
      rerender({ prepareSubmit, onSubmitBefore });
    });
    testState.prompt = 'queued';
    await clickSubmit(container);
    expect(prepareSubmit).toHaveBeenCalledOnce();

    act(() => {
      mockConnection.sessionId = 'session-2';
      mockConnection.workspaceCwd = '/tmp/project-2';
      testState.ownerVersion += 1;
      rerender({ prepareSubmit, onSubmitBefore });
    });
    act(() => {
      mockConnection.sessionId = 'session-1';
      mockConnection.workspaceCwd = '/tmp/project';
      testState.ownerVersion += 1;
      rerender({ prepareSubmit, onSubmitBefore });
    });
    await act(async () => {
      finishPrepare?.();
      await Promise.resolve();
    });

    expect(onSubmitBefore).not.toHaveBeenCalled();
    expect(rawEnqueuePrompt).not.toHaveBeenCalled();
    expect(editorCommit).not.toHaveBeenCalled();
    expect(editorClear).not.toHaveBeenCalled();
    expect(testState.prompt).toBe('queued');
  });

  it('cancels queued submissions when prepareSubmit rejects', async () => {
    const prepareSubmit = vi.fn().mockRejectedValue(new Error('host failed'));
    const { container, rerender } = renderApp({ prepareSubmit });
    await flush();

    act(() => {
      testState.streamingState = 'responding';
      rerender({ prepareSubmit });
    });
    testState.prompt = 'queued';
    await clickSubmit(container);
    await flush();

    expect(prepareSubmit).toHaveBeenCalledOnce();
    expect(rawEnqueuePrompt).not.toHaveBeenCalled();
    expect(editorCommit).not.toHaveBeenCalled();
    expect(editorClear).not.toHaveBeenCalled();
    expect(testState.prompt).toBe('queued');
  });

  it('keeps the draft when preparation empties a queued prompt', async () => {
    const prepareSubmit = vi.fn().mockResolvedValue({
      prompt: '',
      inputAnnotations: [],
    });
    const { container, rerender } = renderApp({ prepareSubmit });
    await flush();

    act(() => {
      testState.streamingState = 'responding';
      rerender({ prepareSubmit });
    });
    testState.prompt = 'queued';
    await clickSubmit(container);
    await flush();

    expect(prepareSubmit).toHaveBeenCalledOnce();
    expect(rawEnqueuePrompt).not.toHaveBeenCalled();
    expect(editorCommit).not.toHaveBeenCalled();
    expect(editorClear).not.toHaveBeenCalled();
    expect(testState.prompt).toBe('queued');
  });

  it('keeps goal controls on the control plane instead of prompt admission', async () => {
    const onSubmitBefore = vi.fn().mockRejectedValue(new Error('blocked'));
    const { container } = renderApp({ onSubmitBefore });
    await flush();

    testState.prompt = '/goal ship it';
    await clickSubmit(container);
    await flush();

    await vi.waitFor(() => {
      expect(mockSessionActions.controlGoal).toHaveBeenCalledWith({
        action: 'create',
        objective: 'ship it',
      });
    });
    expect(onSubmitBefore).not.toHaveBeenCalled();
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
  });

  it('refreshes background tasks after /fork launches', async () => {
    mockSessionActions.forkSession.mockResolvedValue({
      sessionId: 'session-1',
      description: 'Review current changes',
      launched: true,
    });
    const { container } = renderApp();
    await flush();

    testState.prompt = '/fork Review current changes';
    await clickSubmit(container);
    await flush();

    expect(mockSessionActions.forkSession).toHaveBeenCalledWith(
      'Review current changes',
    );
    expect(testState.latestBackgroundTasksRefreshTrigger).toBe(1);
  });

  it('keeps /btw as a lightweight side question when side tasks are available', async () => {
    mockConnection.capabilities.features = ['session_side_task'];
    const { container } = renderApp();
    await flush();

    testState.prompt = '/btw explain the current implementation';
    await clickSubmit(container);
    await flush();

    expect(mockSessionActions.forkSession).not.toHaveBeenCalled();
    expect(mockSessionActions.btwSession).toHaveBeenCalledWith(
      'explain the current implementation',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(container.querySelector('button[title="Side task"]')).toBeNull();
  });

  it('settles visible recap after a same-id attachment replacement', async () => {
    const recap = deferred<{ sessionId: string; recap: string | null }>();
    mockSessionActions.recapSession.mockReturnValueOnce(recap.promise);
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = '/recap';
    await clickSubmit(container);
    expect(
      testState.latestMessageListProps?.messages?.some((message) =>
        message.content?.includes('Generating recap'),
      ),
    ).toBe(true);

    act(() => {
      testState.ownerVersion += 1;
      rerender();
    });
    await act(async () => {
      recap.resolve({ sessionId: 'session-1', recap: 'Reconnect-safe recap' });
      await recap.promise;
    });

    expect(
      testState.latestMessageListProps?.messages?.some((message) =>
        message.content?.includes('Reconnect-safe recap'),
      ),
    ).toBe(true);
  });

  it('settles visible btw after a same-id attachment replacement', async () => {
    const btw = deferred<{ answer: string }>();
    mockSessionActions.btwSession.mockReturnValueOnce(btw.promise);
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = '/btw keep this answer';
    await clickSubmit(container);
    expect(testState.latestBtwMessageProps).toMatchObject({
      question: 'keep this answer',
      isPending: true,
    });

    act(() => {
      testState.ownerVersion += 1;
      rerender();
    });
    await act(async () => {
      btw.resolve({ answer: 'Reconnect-safe answer' });
      await btw.promise;
    });

    expect(testState.latestBtwMessageProps).toMatchObject({
      question: 'keep this answer',
      answer: 'Reconnect-safe answer',
      isPending: false,
    });
  });

  it('opens a new side task for /btw side when the capability is available', async () => {
    mockConnection.capabilities.features = ['session_side_task'];
    const { container } = renderApp();
    await flush();

    testState.prompt = '/btw side explain the current implementation';
    await clickSubmit(container);
    await flush();

    expect(mockSessionActions.forkSession).not.toHaveBeenCalled();
    expect(mockSessionActions.btwSession).not.toHaveBeenCalled();
    expect(container.querySelector('button[title="Side task"]')).not.toBeNull();
  });

  it('keeps /btw side as a lightweight question without the capability', async () => {
    const { container } = renderApp();
    await flush();

    testState.prompt = '/btw side explain the current implementation';
    await clickSubmit(container);
    await flush();

    expect(mockSessionActions.btwSession).toHaveBeenCalledWith(
      'side explain the current implementation',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(container.querySelector('button[title="Side task"]')).toBeNull();
  });

  it('passes a directive to /fork as a regular background-agent directive', async () => {
    mockSessionActions.forkSession.mockResolvedValue({
      sessionId: 'session-1',
      description: 'delegate',
      launched: true,
    });
    const { container } = renderApp();
    await flush();

    testState.prompt = '/fork delegate';
    await clickSubmit(container);
    await flush();

    expect(mockSessionActions.forkSession).toHaveBeenCalledWith('delegate');
    expect(container.querySelector('button[title="Side task"]')).toBeNull();
  });

  it('notifies the host before forwarding a slash command', async () => {
    const onSlashCommand = vi.fn();
    const { container } = renderApp({ onSlashCommand });
    await flush();

    testState.prompt = '/Deploy staging';
    await clickSubmit(container);
    await flush();

    expect(onSlashCommand).toHaveBeenCalledWith({
      command: 'deploy',
      args: 'staging',
      input: '/Deploy staging',
    });
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      '/Deploy staging',
      expect.any(Object),
    );
  });

  it('lets the host handle a slash command instead of forwarding it', async () => {
    const onSlashCommand = vi.fn(() => true);
    const { container } = renderApp({ onSlashCommand });
    await flush();

    testState.prompt = '/deploy production';
    await clickSubmit(container);
    await flush();

    expect(onSlashCommand).toHaveBeenCalledWith({
      command: 'deploy',
      args: 'production',
      input: '/deploy production',
    });
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
  });

  it('lets the host override a built-in slash command', async () => {
    const onSlashCommand = vi.fn(() => true);
    const { container } = renderApp({ onSlashCommand });
    await flush();

    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();

    expect(onSlashCommand).toHaveBeenCalledWith({
      command: 'settings',
      args: '',
      input: '/settings',
    });
    expect(container.querySelector('[data-testid="inline-panel"]')).toBeNull();
  });

  it('does not treat an absolute path as a slash command', async () => {
    const onSlashCommand = vi.fn(() => true);
    const { container } = renderApp({ onSlashCommand });
    await flush();

    testState.prompt = '/usr/local/bin/tool';
    await clickSubmit(container);
    await flush();

    expect(onSlashCommand).not.toHaveBeenCalled();
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      '/usr/local/bin/tool',
      expect.any(Object),
    );
  });

  it('lets the host handle a slash command while the daemon is unavailable', async () => {
    mockConnection.status = 'error';
    const onSlashCommand = vi.fn(() => true);
    const onToast = vi.fn();
    const { container } = renderApp({ onSlashCommand, onToast });
    await flush();

    testState.prompt = '/deploy production';
    await clickSubmit(container);
    await flush();

    expect(onSlashCommand).toHaveBeenCalledTimes(1);
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(onToast).not.toHaveBeenCalled();
  });

  it('reports a host slash command error and continues default handling', async () => {
    const error = new Error('host handler exploded');
    const onSlashCommand = vi.fn(() => {
      throw error;
    });
    const onToast = vi.fn();
    const { container } = renderApp({ onSlashCommand, onToast });
    await flush();

    testState.prompt = '/deploy staging';
    await clickSubmit(container);
    await flush();

    expect(onToast).toHaveBeenCalledWith('error', 'host handler exploded');
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      '/deploy staging',
      expect.any(Object),
    );
  });

  it('uses the latest slash command handler after a rerender', async () => {
    const firstHandler = vi.fn();
    const secondHandler = vi.fn(() => true);
    const { container, rerender } = renderApp({
      onSlashCommand: firstHandler,
    });
    await flush();

    rerender({ onSlashCommand: secondHandler });
    await flush();

    testState.prompt = '/deploy staging';
    await clickSubmit(container);
    await flush();
    expect(firstHandler).not.toHaveBeenCalled();
    expect(secondHandler).toHaveBeenCalledTimes(1);
  });

  it('forwards input annotations for /plan prompts in active sessions', async () => {
    const annotation: DaemonInputAnnotation = {
      type: 'reference',
      text: '@.husky/',
      start: 0,
      end: 8,
      reference: {
        id: '.husky/',
        value: '.husky/',
        serialized: '@.husky/',
      },
    };
    const { container } = renderApp();
    await flush();

    testState.prompt = '/plan @.husky/ explain';
    testState.inputAnnotations = [annotation];
    await clickSubmit(container);
    await flush();

    expect(mockSessionActions.setApprovalMode).toHaveBeenCalledWith('plan');
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      '@.husky/ explain',
      expect.objectContaining({
        inputAnnotations: [annotation],
      }),
    );
  });

  it('does not send a deferred plan prompt into a replacement owner', async () => {
    const approval = deferred<void>();
    mockSessionActions.setApprovalMode.mockReturnValueOnce(approval.promise);
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = '/plan explain the migration';
    await clickSubmit(container);
    expect(mockSessionActions.setApprovalMode).toHaveBeenCalledWith('plan');

    act(() => {
      testState.ownerVersion += 1;
      mockConnection.sessionId = 'session-2';
      rerender();
    });
    await act(async () => {
      approval.resolve();
      await approval.promise;
    });

    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(testState.latestChatEditorProps?.isPreparing).toBe(false);
  });

  it('does not send a deferred plan prompt after an interrupted navigation', async () => {
    const approval = deferred<void>();
    mockSessionActions.setApprovalMode.mockReturnValueOnce(approval.promise);
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = '/plan explain the migration';
    await clickSubmit(container);
    expect(mockSessionActions.setApprovalMode).toHaveBeenCalledWith('plan');

    act(() => {
      mockConnection.loadingTranscript = true;
      rerender({});
    });
    act(() => {
      mockConnection.loadingTranscript = false;
      rerender({});
    });
    await act(async () => {
      approval.resolve();
      await approval.promise;
    });

    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(testState.prompt).toBe('/plan explain the migration');
    expect(testState.latestChatEditorProps?.isPreparing).toBe(false);
  });

  it('clears deferred plan preparation after a same-session reattach', async () => {
    const approval = deferred<void>();
    mockSessionActions.setApprovalMode.mockReturnValueOnce(approval.promise);
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = '/plan explain the migration';
    await clickSubmit(container);
    expect(testState.latestChatEditorProps?.isPreparing).toBe(true);

    act(() => {
      testState.ownerVersion += 1;
      rerender();
    });
    await act(async () => {
      approval.resolve();
      await approval.promise;
    });

    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(testState.latestChatEditorProps?.isPreparing).toBe(false);
  });

  it('does not let an A-to-B-to-A plan completion clear newer preparation', async () => {
    const firstApproval = deferred<void>();
    const secondApproval = deferred<void>();
    mockSessionActions.setApprovalMode
      .mockReturnValueOnce(firstApproval.promise)
      .mockReturnValueOnce(secondApproval.promise);
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = '/plan first';
    await clickSubmit(container);

    act(() => {
      testState.ownerVersion += 1;
      mockConnection.sessionId = 'session-2';
      rerender();
    });
    await flush();
    act(() => {
      testState.ownerVersion += 1;
      mockConnection.sessionId = 'session-1';
      rerender();
    });
    await flush();

    testState.prompt = '/plan second';
    await clickSubmit(container);
    expect(testState.latestChatEditorProps?.isPreparing).toBe(true);

    await act(async () => {
      firstApproval.resolve();
      await firstApproval.promise;
    });
    expect(testState.latestChatEditorProps?.isPreparing).toBe(true);

    await act(async () => {
      secondApproval.resolve();
      await secondApproval.promise;
    });
    expect(testState.latestChatEditorProps?.isPreparing).toBe(false);
  });

  it('dispatches turn_complete only for the session that was streaming', async () => {
    const onSessionChange = vi.fn();
    const { container, rerender } = renderApp({ onSessionChange });
    await flush();

    testState.prompt = 'first';
    await clickSubmit(container);
    onSessionChange.mockClear();

    act(() => {
      testState.streamingState = 'responding';
      rerender({ onSessionChange });
    });
    act(() => {
      testState.blocks = [
        { kind: 'error', source: 'turn_error', id: 'turn-error-1' },
      ];
      testState.streamingState = 'idle';
      rerender({ onSessionChange });
    });

    expect(onSessionChange).toHaveBeenCalledWith({
      type: 'turn_complete',
      sessionId: 'session-1',
      error: expect.objectContaining({
        message: 'Turn error (block turn-error-1)',
      }),
    });
    expect(sessionCatalogController.turnCompleted).toHaveBeenCalledWith(
      '/tmp/project',
      'session-1',
    );

    onSessionChange.mockClear();
    act(() => {
      testState.streamingState = 'responding';
      rerender({ onSessionChange });
    });
    act(() => {
      mockConnection.sessionId = 'session-2';
      testState.streamingState = 'idle';
      rerender({ onSessionChange });
    });

    expect(onSessionChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'turn_complete' }),
    );

    sessionCatalogController.turnCompleted.mockClear();
    act(() => {
      mockConnection.sessionId = 'same-session';
      mockConnection.workspaceCwd = '/tmp/project';
      testState.streamingState = 'responding';
      rerender({ onSessionChange });
    });
    act(() => {
      mockConnection.workspaceCwd = '/tmp/other';
      testState.streamingState = 'idle';
      rerender({ onSessionChange });
    });
    expect(sessionCatalogController.turnCompleted).not.toHaveBeenCalled();
  });

  it('captures a main-session workspace that becomes available mid-turn', async () => {
    mockConnection.sessionId = 'session-late';
    mockConnection.workspaceCwd = undefined;
    const onSessionChange = vi.fn();
    const { rerender } = renderApp({ onSessionChange });
    await flush();

    act(() => {
      testState.streamingState = 'responding';
      rerender({ onSessionChange });
    });
    act(() => {
      mockConnection.workspaceCwd = '/tmp/project';
      rerender({ onSessionChange });
    });
    act(() => {
      testState.streamingState = 'idle';
      rerender({ onSessionChange });
    });

    expect(sessionCatalogController.turnCompleted).toHaveBeenCalledWith(
      '/tmp/project',
      'session-late',
    );
    expect(onSessionChange).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'turn_complete',
        sessionId: 'session-late',
      }),
    );
  });

  it('keeps retry state when the active workspace becomes available mid-turn', async () => {
    mockConnection.sessionId = 'session-late';
    mockConnection.workspaceCwd = undefined;
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = 'first';
    await clickSubmit(container);
    act(() => {
      testState.streamingState = 'responding';
      rerender();
    });
    act(() => {
      mockConnection.workspaceCwd = '/tmp/project';
      rerender();
    });
    act(() => {
      testState.blocks = [
        { kind: 'error', source: 'turn_error', id: 'turn-error-1' },
      ];
      testState.streamingState = 'idle';
      rerender();
    });
    await flush();

    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
    });
    await flush();

    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(2);
    expect(mockSessionActions.sendPrompt).toHaveBeenLastCalledWith(
      'first',
      expect.objectContaining({
        optimisticUserMessage: false,
        retry: true,
      }),
    );
  });

  it('restores a pending retry when the active workspace becomes available', async () => {
    let approveRetry: (() => void) | undefined;
    let admissionCount = 0;
    const onSubmitBefore = vi.fn(() => {
      admissionCount += 1;
      if (admissionCount === 1) return Promise.resolve();
      return new Promise<void>((resolve) => {
        approveRetry = resolve;
      });
    });
    mockConnection.sessionId = 'session-late';
    mockConnection.workspaceCwd = undefined;
    const { container, rerender } = renderApp({ onSubmitBefore });
    await flush();

    testState.prompt = 'first';
    await clickSubmit(container);
    act(() => {
      testState.blocks = [
        { kind: 'error', source: 'turn_error', id: 'turn-error-1' },
      ];
      rerender({ onSubmitBefore });
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
    });
    act(() => {
      mockConnection.workspaceCwd = '/tmp/project';
      rerender({ onSubmitBefore });
    });
    await act(async () => {
      approveRetry?.();
      await Promise.resolve();
    });
    await flush();

    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();
  });

  it('migrates a cached retry when the active workspace becomes available', async () => {
    const retryApproval = deferred<void>();
    let admissionCount = 0;
    const onSubmitBefore = vi.fn(() => {
      admissionCount += 1;
      return admissionCount === 1 ? Promise.resolve() : retryApproval.promise;
    });
    mockConnection.sessionId = 'session-late';
    mockConnection.workspaceCwd = undefined;
    const { container, rerender } = renderApp({ onSubmitBefore });
    await flush();

    testState.prompt = 'first';
    await clickSubmit(container);
    act(() => {
      testState.blocks = [
        { kind: 'error', source: 'turn_error', id: 'turn-error-1' },
      ];
      rerender({ onSubmitBefore });
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
      mockConnection.loadingTranscript = true;
      rerender({ onSubmitBefore });
    });
    await act(async () => {
      retryApproval.resolve();
      await retryApproval.promise;
    });
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="retry"]')).toBeNull();

    act(() => {
      mockConnection.workspaceCwd = '/tmp/project';
      mockConnection.loadingTranscript = true;
      rerender({ onSubmitBefore });
    });
    act(() => {
      mockConnection.loadingTranscript = false;
      rerender({ onSubmitBefore });
    });
    await flush();

    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();
  });

  it('clears retry state when a new owner supplies the workspace', async () => {
    mockConnection.sessionId = 'session-late';
    mockConnection.workspaceCwd = undefined;
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = 'first';
    await clickSubmit(container);
    act(() => {
      testState.blocks = [
        { kind: 'error', source: 'turn_error', id: 'turn-error-1' },
      ];
      rerender();
    });
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();

    act(() => {
      testState.ownerVersion += 1;
      mockConnection.workspaceCwd = '/tmp/project-2';
      rerender();
    });
    await flush();

    expect(container.querySelector('[data-testid="retry"]')).toBeNull();
  });

  it('prefers the active retry when its workspace becomes available', async () => {
    const oldRetryApproval = deferred<void>();
    const activeRetryApproval = deferred<void>();
    let admissionCount = 0;
    const onSubmitBefore = vi.fn(() => {
      admissionCount += 1;
      if (admissionCount === 2) return oldRetryApproval.promise;
      if (admissionCount === 4) return activeRetryApproval.promise;
      return Promise.resolve();
    });
    const oldError = {
      kind: 'error',
      source: 'turn_error',
      id: 'turn-error-1',
      eventId: 100,
      promptId: 'prompt-old',
    } as const;
    const activeError = {
      kind: 'error',
      source: 'turn_error',
      id: 'turn-error-2',
      eventId: 200,
      promptId: 'prompt-active',
    } as const;
    const { container, rerender } = renderApp({ onSubmitBefore });
    await flush();

    testState.prompt = 'first';
    await clickSubmit(container);
    act(() => {
      testState.blocks = [oldError];
      rerender({ onSubmitBefore });
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
      mockConnection.loadingTranscript = true;
      rerender({ onSubmitBefore });
    });
    await act(async () => {
      oldRetryApproval.resolve();
      await oldRetryApproval.promise;
    });
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledOnce();

    act(() => {
      testState.ownerVersion += 1;
      mockConnection.workspaceCwd = undefined;
      testState.blocks = [];
      mockConnection.loadingTranscript = false;
      rerender({ onSubmitBefore });
    });
    testState.prompt = 'second';
    await clickSubmit(container);
    act(() => {
      testState.blocks = [activeError];
      rerender({ onSubmitBefore });
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
      mockConnection.loadingTranscript = true;
      rerender({ onSubmitBefore });
    });
    await act(async () => {
      activeRetryApproval.resolve();
      await activeRetryApproval.promise;
    });
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(2);

    act(() => {
      mockConnection.workspaceCwd = '/tmp/project';
      mockConnection.loadingTranscript = true;
      rerender({ onSubmitBefore });
    });
    act(() => {
      mockConnection.loadingTranscript = false;
      rerender({ onSubmitBefore });
    });
    await flush();

    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
      await Promise.resolve();
    });
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(3);
    expect(mockSessionActions.sendPrompt).toHaveBeenLastCalledWith(
      'second',
      expect.objectContaining({ retry: true }),
    );
  });

  it('drops a known-workspace retry when a replacement reuses its local error id', async () => {
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = 'first';
    await clickSubmit(container);
    act(() => {
      testState.blocks = [
        { kind: 'error', source: 'turn_error', id: 'turn-error-1' },
      ];
      rerender();
    });
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();
    const retry = testState.latestMessageListProps?.onRetryClick;

    act(() => {
      testState.ownerVersion += 1;
      testState.blocks = [
        { kind: 'error', source: 'turn_error', id: 'turn-error-1' },
      ];
      retry?.();
      rerender();
    });
    await flush();

    expect(container.querySelector('[data-testid="retry"]')).toBeNull();
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('drops an uncertain retry response after a known-workspace transcript replacement', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const retrySend = deferred<void>();
    mockSessionActions.sendPrompt
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(retrySend.promise);
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = 'first';
    await clickSubmit(container);
    act(() => {
      testState.blocks = [
        { kind: 'error', source: 'turn_error', id: 'turn-error-1' },
      ];
      rerender();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(2);
    });
    const retryOptions = mockSessionActions.sendPrompt.mock.calls[1]?.[1];

    act(() => {
      retryOptions?.onAdmissionStarted?.();
      testState.ownerVersion += 1;
      testState.blocks = [
        { kind: 'error', source: 'turn_error', id: 'turn-error-1' },
      ];
      rerender();
    });
    await act(async () => {
      retrySend.reject(new Error('response lost'));
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="prompt-admission-unknown"]'),
    ).toBeNull();
    expect(warn).not.toHaveBeenCalledWith(
      '[WebShell] post-turn retry admission outcome is unknown',
      expect.anything(),
    );
  });

  it('keeps a known-workspace retry across a stable error replay', async () => {
    const firstError = {
      kind: 'error',
      source: 'turn_error',
      id: 'turn-error-1',
      promptId: 'prompt-1',
    } as const;
    const replayedError = {
      kind: 'error',
      source: 'turn_error',
      id: 'turn-error-2',
      promptId: 'prompt-1',
    } as const;
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = 'first';
    await clickSubmit(container);
    act(() => {
      testState.blocks = [firstError];
      rerender();
    });
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();

    act(() => {
      testState.ownerVersion += 1;
      testState.blocks = [replayedError];
      rerender();
    });
    await flush();
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
    });
    await flush();

    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(2);
    expect(mockSessionActions.sendPrompt).toHaveBeenLastCalledWith(
      'first',
      expect.objectContaining({ retry: true }),
    );
  });

  it('does not expose a duplicate retry when a stable replay passes through an empty transcript', async () => {
    const retrySend = deferred<void>();
    mockSessionActions.sendPrompt
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(retrySend.promise);
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = 'first';
    await clickSubmit(container);
    act(() => {
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-1',
          promptId: 'prompt-1',
        },
      ];
      rerender();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(2);
    });

    act(() => {
      testState.ownerVersion += 1;
      testState.blocks = [];
      rerender();
    });
    await flush();
    act(() => {
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-2',
          promptId: 'prompt-1',
        },
      ];
      rerender();
    });
    await flush();

    expect(container.querySelector('[data-testid="retry"]')).toBeNull();
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(2);
    await act(async () => {
      retrySend.resolve();
      await retrySend.promise;
    });
  });

  it('drops a visible workspace-unknown retry after its attachment is replaced', async () => {
    mockConnection.sessionId = 'session-1';
    mockConnection.workspaceCwd = undefined;
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = 'first';
    await clickSubmit(container);
    act(() => {
      testState.blocks = [
        { kind: 'error', source: 'turn_error', id: 'turn-error-1' },
      ];
      rerender();
    });
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();
    const retry = testState.latestMessageListProps?.onRetryClick;

    act(() => {
      testState.ownerVersion += 1;
      rerender();
    });
    expect(container.querySelector('[data-testid="retry"]')).toBeNull();
    act(() => retry?.());
    await flush();

    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('does not let an in-flight workspace-unknown retry suppress a replacement attachment', async () => {
    mockConnection.sessionId = 'session-1';
    mockConnection.workspaceCwd = undefined;
    const retrySend = deferred<void>();
    let retryAdmitted: (() => void) | undefined;
    mockSessionActions.sendPrompt
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(
        (
          _text: string,
          options?: {
            onAdmitted?: () => void;
          },
        ) => {
          retryAdmitted = options?.onAdmitted;
          return retrySend.promise;
        },
      );
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = 'first';
    await clickSubmit(container);
    act(() => {
      testState.blocks = [
        { kind: 'error', source: 'turn_error', id: 'turn-error-1' },
      ];
      rerender();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      testState.ownerVersion += 1;
      testState.streamingState = 'responding';
      rerender();
      retryAdmitted?.();
      retrySend.resolve();
      await retrySend.promise;
      await Promise.resolve();
    });
    await flush();

    expect(testState.latestMessageListProps?.isResponding).toBe(true);
  });

  it('drops a workspace-unknown retry when its owner changes', async () => {
    const retryApproval = deferred<void>();
    let admissionCount = 0;
    const onSubmitBefore = vi.fn(() => {
      admissionCount += 1;
      return admissionCount === 1 ? Promise.resolve() : retryApproval.promise;
    });
    mockConnection.sessionId = 'session-1';
    mockConnection.workspaceCwd = undefined;
    const { container, rerender } = renderApp({ onSubmitBefore });
    await flush();

    testState.prompt = 'first';
    await clickSubmit(container);
    act(() => {
      testState.blocks = [
        { kind: 'error', source: 'turn_error', id: 'turn-error-1' },
      ];
      rerender({ onSubmitBefore });
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
      mockConnection.loadingTranscript = true;
      rerender({ onSubmitBefore });
    });
    await act(async () => {
      retryApproval.resolve();
      await retryApproval.promise;
    });
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="retry"]')).toBeNull();
    act(() => {
      mockConnection.sessionId = 'session-1';
      mockConnection.workspaceCwd = '/tmp/project-2';
      testState.blocks = [
        { kind: 'error', source: 'turn_error', id: 'turn-error-1' },
      ];
      testState.ownerVersion += 1;
      mockConnection.loadingTranscript = false;
      rerender({ onSubmitBefore });
    });
    expect(container.querySelector('[data-testid="retry"]')).toBeNull();
    act(() => {
      mockConnection.sessionId = 'session-1';
      mockConnection.workspaceCwd = '/tmp/project';
      testState.blocks = [
        { kind: 'error', source: 'turn_error', id: 'turn-error-1' },
      ];
      testState.ownerVersion += 1;
      rerender({ onSubmitBefore });
    });
    await flush();

    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="retry"]')).toBeNull();
  });

  it('auto-closes an open Settings/Status panel when a tool approval becomes pending', async () => {
    // Regression: the approval overlay lives in the chat footer, which is
    // hidden (display:none) while a panel is shown. If a gated tool call
    // arrives while Settings/Status is open, the panel must step aside so the
    // approval is visible instead of the turn hanging behind it.
    const { container, rerender } = renderApp();
    await flush();

    // Open the Settings panel via the /settings command; the panel host carries
    // data-testid="inline-panel", so its presence tracks the panel.
    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();

    // A gated tool call arrives.
    await act(async () => {
      testState.blocks = [makePendingPermissionBlock()];
      rerender();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="inline-panel"]')).toBeNull();
  });

  it('does not open the extensions manager page with /extension manage', async () => {
    const { container } = renderApp();
    await flush();

    testState.prompt = '/extension manage';
    await clickSubmit(container);
    await flush();

    expect(
      container.querySelector('[data-testid="extensions-manager-page"]'),
    ).toBeNull();
  });

  it('opens the extensions manager page with /extensions manage', async () => {
    const { container } = renderApp();
    await flush();

    testState.prompt = '/extensions manage';
    await clickSubmit(container);
    await flush();

    expect(
      container.querySelector('[data-testid="extensions-manager-page"]'),
    ).not.toBeNull();
    const backButton = container.querySelector(
      '[data-testid="extensions-manager-back"]',
    );
    expect(document.activeElement).not.toBe(backButton);
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="extensions-manager-heading"]'),
    );

    editorFocus.mockClear();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="extensions-manager-back"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="extensions-manager-page"]'),
    ).toBeNull();
    expect(editorFocus).toHaveBeenCalled();
  });

  it.each(['/skills', '/skills detail', '/skills details'])(
    'opens the Skill manager page with %s',
    async (command) => {
      const { container } = renderApp();
      await flush();

      testState.prompt = command;
      await clickSubmit(container);
      await flush();

      expect(
        container
          .querySelector('[data-testid="inline-panel"]')
          ?.getAttribute('aria-label'),
      ).toBe('Skills');
      expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    },
  );

  it('converts /skills arguments to a direct skill command', async () => {
    const { container } = renderApp();
    await flush();

    testState.prompt = '/skills bugfix';
    await clickSubmit(container);
    await flush();

    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      '/bugfix',
      expect.any(Object),
    );
    expect(container.querySelector('[data-testid="inline-panel"]')).toBeNull();
  });

  it('opens plugin management tabs from the sidebar', async () => {
    mockWorkspaceActions.loadMcpStatus.mockResolvedValue({
      initialized: true,
      discoveryState: 'completed',
      servers: [],
    });
    const { container } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-plugins"]')
        ?.click();
      await Promise.resolve();
    });
    await flush();

    const panel = container.querySelector('[data-testid="inline-panel"]');
    const extensionsTab =
      panel?.querySelector<HTMLButtonElement>('button[role="tab"]');
    const tabs =
      panel?.querySelectorAll<HTMLButtonElement>('button[role="tab"]');
    expect(panel?.getAttribute('aria-label')).toBe('Plugins');
    expect(Array.from(tabs ?? []).map((tab) => tab.textContent)).toEqual([
      'Extensions',
      'MCP',
      'Skills',
      'Agents',
    ]);
    expect(extensionsTab?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(extensionsTab);

    await act(async () => {
      tabs?.[2]?.focus();
      tabs?.[2]?.click();
      await Promise.resolve();
    });
    expect(
      panel
        ?.querySelectorAll<HTMLButtonElement>('button[role="tab"]')[2]
        ?.getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('restores composer interaction after closing Plugins on the MCP tab', async () => {
    mockWorkspaceActions.loadMcpStatus.mockResolvedValue({
      initialized: true,
      discoveryState: 'completed',
      servers: [],
    });
    const { container } = renderApp();
    await flush();
    expect(testState.latestChatEditorProps?.dialogOpen).toBe(false);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-plugins"]')
        ?.click();
      await Promise.resolve();
    });
    await flush();
    const panel = container.querySelector('[data-testid="inline-panel"]');
    const tabs =
      panel?.querySelectorAll<HTMLButtonElement>('button[role="tab"]');
    expect(Array.from(tabs ?? []).map((tab) => tab.textContent)).toEqual([
      'Extensions',
      'MCP',
      'Skills',
      'Agents',
    ]);
    const mcpTab = Array.from(tabs ?? []).find(
      (tab) => tab.textContent === 'MCP',
    );
    await act(async () => {
      mcpTab?.focus();
      mcpTab?.click();
      await Promise.resolve();
    });
    await flush();
    expect(mockWorkspaceActions.loadMcpStatus).toHaveBeenCalled();
    expect(testState.latestChatEditorProps?.dialogOpen).toBe(true);

    const mcpPanel = container.querySelector('[data-testid="inline-panel"]');
    await act(async () => {
      mcpPanel?.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'Escape',
        }),
      );
      await Promise.resolve();
    });
    await flush();

    expect(container.querySelector('[data-testid="inline-panel"]')).toBeNull();
    expect(testState.latestChatEditorProps?.dialogOpen).toBe(false);
  });

  it('opens Channel management from the sidebar', async () => {
    const { container } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-channels"]')
        ?.click();
      await Promise.resolve();
    });

    const panel = container.querySelector('[data-testid="inline-panel"]');
    expect(panel?.getAttribute('aria-label')).toBe('Channels');
    expect(
      panel?.querySelector('[data-testid="channels-manager-page"]'),
    ).not.toBeNull();
  });

  it('shadow-isolates the unified plugin manager body when plugins is enabled', async () => {
    const { container } = renderApp({
      shadowDom: {
        plugins: true,
        portals: false,
        styles: '.plugin-shadow-content { color: rebeccapurple; }',
      },
    });
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-plugins"]')
        ?.click();
      await Promise.resolve();
    });
    await flush();

    const panel = container.querySelector('[data-testid="inline-panel"]');
    const host = panel?.querySelector<HTMLElement>(
      '[data-web-shell-shadow-host="plugins"]',
    );
    const extensionsTab =
      host?.shadowRoot?.querySelector<HTMLButtonElement>('button[role="tab"]');
    expect(host?.shadowRoot).not.toBeNull();
    expect(host?.shadowRoot?.firstElementChild?.tagName).toBe('STYLE');
    expect(panel?.querySelector('button[role="tab"]')).toBeNull();
    expect(extensionsTab?.textContent).toBe('Extensions');
    expect(host?.shadowRoot?.activeElement).toBe(extensionsTab);
    expect(
      document.querySelector('[data-web-shell-portal-root]'),
    ).not.toBeNull();
  });

  it.each([
    ['/extensions manage', 'Manage Extensions'],
    ['/mcp', 'MCP Servers'],
    ['/skills details', 'Skills'],
  ])(
    'shadow-isolates the %s compatibility page when plugins is enabled',
    async (command, panelLabel) => {
      mockWorkspaceActions.loadMcpStatus.mockResolvedValue({
        initialized: true,
        discoveryState: 'completed',
        servers: [],
      });
      const { container } = renderApp({
        shadowDom: {
          plugins: true,
          portals: false,
        },
      });
      await flush();

      testState.prompt = command;
      await clickSubmit(container);
      await flush();

      const panel = container.querySelector('[data-testid="inline-panel"]');
      const host = panel?.querySelector<HTMLElement>(
        '[data-web-shell-shadow-host="plugins"]',
      );
      expect(panel?.getAttribute('aria-label')).toBe(panelLabel);
      expect(host?.shadowRoot).not.toBeNull();
      expect(
        host?.shadowRoot?.querySelector(
          '[data-web-shell-shadow-root="plugins"]',
        ),
      ).not.toBeNull();
      expect(panel?.querySelector('button')).toBeNull();
    },
  );

  it('uses one shadow root for all portals without moving plugin content', async () => {
    const { container } = renderApp({
      shadowDom: {
        plugins: false,
        portals: true,
        styles: '.consumer-shadow-content { color: rebeccapurple; }',
      },
      style: {
        '--web-shell-portal-root-z-index': '2345',
      } as CSSProperties,
    });
    await flush();

    const portalHost = document.querySelector<HTMLElement>(
      '[data-web-shell-shadow-host="portals"]',
    );
    const portalRoot = portalHost?.shadowRoot?.querySelector(
      '[data-web-shell-portal-root]',
    );
    expect(portalRoot).not.toBeNull();
    expect(portalHost?.style.zIndex).toBe(
      'var(--web-shell-portal-root-z-index, 1000)',
    );
    expect(portalHost?.style.getPropertyPriority('z-index')).toBe('important');
    expect(
      portalHost?.style.getPropertyValue('--web-shell-portal-root-z-index'),
    ).toBe('2345');
    expect(portalHost?.shadowRoot?.firstElementChild?.tagName).toBe('STYLE');
    expect(portalHost?.shadowRoot?.lastElementChild).toBe(portalRoot);
    expect(document.querySelector('[data-web-shell-portal-root]')).toBeNull();
    expect(
      Array.from(portalHost?.shadowRoot?.querySelectorAll('style') ?? []).some(
        (style) => style.textContent?.includes('.consumer-shadow-content'),
      ),
    ).toBe(true);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-plugins"]')
        ?.click();
      await Promise.resolve();
    });
    await flush();

    const panel = container.querySelector('[data-testid="inline-panel"]');
    expect(panel?.querySelector('button[role="tab"]')).not.toBeNull();
    expect(
      panel?.querySelector('[data-web-shell-shadow-host="plugins"]'),
    ).toBeNull();
  });

  it('only shows server startup progress during MCP discovery', async () => {
    mockWorkspaceActions.loadMcpStatus.mockResolvedValue({
      initialized: true,
      discoveryState: 'starting',
      servers: [
        {
          name: 'filesystem',
          source: 'project',
          configOrigin: 'workspace_settings',
          disabled: false,
          mcpStatus: 'connecting',
        },
      ],
    });
    const { container } = renderApp();
    await flush();

    testState.prompt = '/mcp';
    await clickSubmit(container);
    await flush();

    expect(container.textContent).toContain(
      'MCP servers are starting up (1 initializing)',
    );
    expect(container.textContent).not.toContain('Loading MCP tools...');
    expect(
      container.querySelector('[role="button"][aria-label="filesystem"]'),
    ).toHaveProperty('tabIndex', 0);
  });

  it('shows server operations without duplicating tools and resources tabs', async () => {
    mockWorkspaceActions.loadMcpStatus.mockResolvedValue({
      initialized: true,
      discoveryState: 'completed',
      workspaceCwd: '/workspace',
      servers: [
        {
          name: 'filesystem',
          source: 'project',
          configOrigin: 'workspace_settings',
          disabled: false,
          mcpStatus: 'disconnected',
          resourceCount: 1,
          removable: true,
        },
      ],
    });
    mockMcp.loadTools.mockResolvedValue({
      serverName: 'filesystem',
      tools: [{ name: 'read_file', description: 'Read a file' }],
    });
    mockMcp.loadResources.mockResolvedValue({
      serverName: 'filesystem',
      resources: [{ uri: 'file:///README.md', name: 'README' }],
    });
    const { container } = renderApp();
    await flush();

    testState.prompt = '/mcp';
    await clickSubmit(container);
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="filesystem"]')
        ?.click();
      await Promise.resolve();
    });
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="mcp-server-actions"]')
        ?.dispatchEvent(
          new MouseEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            button: 0,
          }),
        );
      await Promise.resolve();
    });

    expect(document.body.textContent).not.toContain('View tools');
    expect(document.body.textContent).not.toContain('View resources');
    expect(document.body.textContent).toContain('Reconnect');
    expect(document.body.textContent).not.toContain('Authenticate');
    expect(document.body.textContent).toContain('Disable');
    expect(document.body.textContent).toContain('Delete');

    await act(async () => {
      document
        .querySelector<HTMLElement>(
          '[data-testid="mcp-server-action-reconnect"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await flush();
    expect(mockMcp.restartServer).toHaveBeenCalledWith('filesystem');
  });

  it('polls workspace MCP status until browser authentication completes', async () => {
    vi.useFakeTimers();
    const disconnectedServer = {
      name: 'yuque',
      source: 'project' as const,
      configOrigin: 'workspace_settings' as const,
      disabled: false,
      mcpStatus: 'disconnected' as const,
      requiresAuth: true,
      resourceCount: 0,
    };
    mockWorkspaceActions.loadMcpStatus.mockResolvedValue({
      initialized: true,
      discoveryState: 'completed',
      workspaceCwd: '/workspace',
      servers: [disconnectedServer],
    });
    mockMcp.loadTools.mockResolvedValue({ serverName: 'yuque', tools: [] });
    mockMcp.manageServer.mockResolvedValue({
      serverName: 'yuque',
      action: 'authenticate',
      ok: true,
      pending: true,
      messages: ['Open the browser to authenticate.'],
      authUrl: 'https://example.com/oauth',
    });
    mockMcp.reload
      .mockResolvedValueOnce({
        initialized: true,
        discoveryState: 'completed',
        workspaceCwd: '/workspace',
        servers: [
          { ...disconnectedServer, authenticationState: 'pending' as const },
        ],
      })
      .mockResolvedValueOnce({
        initialized: true,
        discoveryState: 'completed',
        workspaceCwd: '/workspace',
        servers: [
          {
            ...disconnectedServer,
            mcpStatus: 'connected' as const,
            hasOAuthTokens: true,
            authenticationState: 'succeeded' as const,
          },
        ],
      });
    const { container } = renderApp();
    await flush();

    testState.prompt = '/mcp';
    await clickSubmit(container);
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="yuque"]')
        ?.click();
      await Promise.resolve();
    });
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="mcp-server-actions"]')
        ?.dispatchEvent(
          new MouseEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            button: 0,
          }),
        );
      await Promise.resolve();
    });
    await act(async () => {
      document
        .querySelector<HTMLElement>(
          '[data-testid="mcp-server-action-authenticate"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      'Open the browser to authenticate.',
    );
    expect(mockMcp.reload).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(mockMcp.reload).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Authenticating');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    await flush();
    expect(mockMcp.reload).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Authenticate complete.');
  });

  it('does not show MCP discovery progress', async () => {
    mockWorkspaceActions.loadMcpStatus.mockResolvedValue({
      initialized: true,
      discoveryState: 'starting',
      servers: [],
    });
    const { container } = renderApp();
    await flush();

    testState.prompt = '/mcp';
    await clickSubmit(container);
    await flush();

    expect(container.textContent).not.toContain('Loading MCP tools...');
  });

  it('does not initialize MCP discovery when it is already complete', async () => {
    mockWorkspaceActions.loadMcpStatus.mockResolvedValue({
      initialized: true,
      discoveryState: 'completed',
      servers: [],
    });
    const { container } = renderApp();
    await flush();

    testState.prompt = '/mcp';
    await clickSubmit(container);
    await flush();

    expect(mockMcp.initialize).not.toHaveBeenCalled();
    expect(mockMcp.reloadConfig).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('MCP tools are ready.');
    expect(container.textContent).not.toContain('Loading MCP tools...');
  });

  it('does not show MCP discovery progress before or after completion', async () => {
    vi.useFakeTimers();
    mockWorkspaceActions.loadMcpStatus.mockResolvedValue({
      initialized: true,
      discoveryState: 'starting',
      servers: [],
    });
    mockMcp.reload.mockResolvedValue({
      initialized: true,
      discoveryState: 'completed',
      servers: [],
    });
    const { container } = renderApp();
    await flush();

    testState.prompt = '/mcp';
    await clickSubmit(container);
    await flush();
    expect(container.textContent).not.toContain('Loading MCP tools...');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    await flush();

    expect(container.textContent).not.toContain('Loading MCP tools...');
    expect(container.textContent).not.toContain('MCP tools are ready.');
  });

  it('auto-closes an open panel when an AskUserQuestion approval becomes pending', async () => {
    // The auto-close effect gates on pendingToolApproval || pendingAskUserApproval;
    // this covers the second branch (ask_user_question resolves to
    // pendingAskUserApproval), whose overlay is also hidden behind the panel.
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();

    await act(async () => {
      testState.blocks = [
        makePendingPermissionBlock({ toolName: 'ask_user_question' }),
      ];
      rerender();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="inline-panel"]')).toBeNull();
  });

  it('opens the Daemon Status panel and auto-closes it on a pending approval', async () => {
    // Covers the activePanel === 'status' branch (DaemonStatusDialog); the other
    // panel tests all open via /settings, so this guards the 'status' literal and
    // confirms the auto-close is panel-type-agnostic.
    const { container, rerender } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-daemon-status"]')
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();

    await act(async () => {
      testState.blocks = [makePendingPermissionBlock()];
      rerender();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="inline-panel"]')).toBeNull();
  });

  it('opens the Session Overview panel from the sidebar', async () => {
    const { container } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="open-sessions-overview"]',
        )
        ?.click();
      await Promise.resolve();
    });
    const panel = container.querySelector('[data-testid="inline-panel"]');
    expect(panel).not.toBeNull();
    // The panelHost aria-label distinguishes which panel is up.
    expect(panel?.getAttribute('aria-label')).toBe('Session Overview');
  });

  it('clears the current session without closing the Session Overview', async () => {
    const onSessionIdChange = vi.fn();
    const { container } = renderApp({ onSessionIdChange });
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="open-sessions-overview"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      await testState.latestSessionOverviewProps?.onCurrentSessionRemoved?.({
        sessionId: 'session-1',
        workspaceCwd: '/tmp/project',
      });
    });

    expect(mockSessionActions.clearSession).toHaveBeenCalledOnce();
    expect(onSessionIdChange).toHaveBeenCalledWith(undefined);
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="session-overview-panel"]'),
    ).not.toBeNull();
    expect(testState.latestSessionOverviewProps?.manageLiveState).toBe(false);
  });

  it('clears a legacy current session without a connection workspace cwd', async () => {
    mockConnection.workspaceCwd = '';
    mockWorkspace.capabilities = {
      workspaces: [{ id: 'primary', cwd: '/tmp/project', primary: true }],
    };
    const onSessionIdChange = vi.fn();
    const { container } = renderApp({ onSessionIdChange });
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="open-sessions-overview"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      await testState.latestSessionOverviewProps?.onCurrentSessionRemoved?.({
        sessionId: 'session-1',
        workspaceCwd: '/tmp/project',
      });
    });

    expect(mockSessionActions.clearSession).toHaveBeenCalledOnce();
    expect(onSessionIdChange).toHaveBeenCalledWith(undefined);
  });

  it("keeps the deleted current session's workspace for the next chat", async () => {
    mockConnection.workspaceCwd = '/work/secondary';
    mockWorkspace.capabilities = {
      workspaces: [
        { id: 'primary', cwd: '/tmp/project', primary: true, trusted: true },
        {
          id: 'secondary',
          cwd: '/work/secondary',
          primary: false,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const onSessionIdChange = vi.fn();
    const { container, rerender } = renderApp({ onSessionIdChange });
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="open-sessions-overview"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      await testState.latestSessionOverviewProps?.onCurrentSessionRemoved?.({
        sessionId: 'session-1',
        workspaceCwd: '/work/secondary',
      });
    });

    expect(mockSessionActions.clearSession).toHaveBeenCalledOnce();
    expect(onSessionIdChange).toHaveBeenCalledWith(undefined);
    expect(
      container.querySelector('[data-testid="session-overview-panel"]'),
    ).not.toBeNull();
    // The daemon cleared the session; the next chat's workspace target now
    // comes from the shell's selected-workspace state, which must stay in
    // the removed session's workspace instead of bouncing to the primary.
    mockConnection.sessionId = undefined;
    rerender();
    await flush();
    expect(testState.latestChatEditorProps?.selectedWorkspaceCwd).toBe(
      '/work/secondary',
    );
  });

  it('does not clear a different session after an overview mutation finishes', async () => {
    const onSessionIdChange = vi.fn();
    const { container, rerender } = renderApp({ onSessionIdChange });
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="open-sessions-overview"]',
        )
        ?.click();
      await Promise.resolve();
    });
    mockConnection.workspaceCwd = '/other/project';
    rerender();
    await flush();
    onSessionIdChange.mockClear();

    await act(async () => {
      await testState.latestSessionOverviewProps?.onCurrentSessionRemoved?.({
        sessionId: 'session-1',
        workspaceCwd: '/tmp/project',
      });
    });

    expect(mockSessionActions.clearSession).not.toHaveBeenCalled();
    expect(onSessionIdChange).not.toHaveBeenCalled();
  });

  it('does not clear a session opened while the current session is being cleared', async () => {
    let resolveClear!: () => void;
    mockSessionActions.clearSession.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveClear = resolve;
      }),
    );
    const onSessionIdChange = vi.fn();
    const { container, rerender } = renderApp({ onSessionIdChange });
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="open-sessions-overview"]',
        )
        ?.click();
      await Promise.resolve();
    });
    let removal: Promise<boolean | void> | boolean | void = undefined;
    act(() => {
      removal = testState.latestSessionOverviewProps?.onCurrentSessionRemoved?.(
        {
          sessionId: 'session-1',
          workspaceCwd: '/tmp/project',
        },
      );
    });
    expect(mockSessionActions.clearSession).toHaveBeenCalledOnce();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="load-session"]')
        ?.click();
      await Promise.resolve();
    });
    mockConnection.sessionId = 'session-2';
    rerender();
    await flush();
    onSessionIdChange.mockClear();
    await act(async () => {
      resolveClear();
      await removal;
    });

    expect(onSessionIdChange).not.toHaveBeenCalled();
  });

  it('reports failure when the current session cannot be cleared', async () => {
    const onSessionIdChange = vi.fn();
    mockSessionActions.clearSession.mockRejectedValueOnce(new Error('locked'));
    const { container } = renderApp({ onSessionIdChange });
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="open-sessions-overview"]',
        )
        ?.click();
      await Promise.resolve();
    });
    onSessionIdChange.mockClear();
    let cleared: boolean | void;
    await act(async () => {
      cleared =
        await testState.latestSessionOverviewProps?.onCurrentSessionRemoved?.({
          sessionId: 'session-1',
          workspaceCwd: '/tmp/project',
        });
    });

    expect(cleared).toBe(false);
    expect(onSessionIdChange).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="session-overview-panel"]'),
    ).not.toBeNull();
  });

  it('starts a new session when leaving the Session Overview with Back', async () => {
    mockConnection.workspaceCwd = '/work/secondary';
    mockWorkspace.capabilities = {
      workspaces: [
        { id: 'primary', cwd: '/tmp/project', primary: true, trusted: true },
        {
          id: 'secondary',
          cwd: '/work/secondary',
          primary: false,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const onSessionIdChange = vi.fn();
    const { container } = renderApp({ onSessionIdChange });
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="open-sessions-overview"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="panel-back"]')
        ?.click();
      await Promise.resolve();
    });

    expect(mockSessionActions.clearSession).toHaveBeenCalledOnce();
    expect(onSessionIdChange).toHaveBeenCalledWith(undefined);
    expect(testState.latestChatEditorProps?.selectedWorkspaceCwd).toBe(
      '/work/secondary',
    );
    expect(container.querySelector('[data-testid="inline-panel"]')).toBeNull();
  });

  it('leaves the Session Overview when a legacy workspace resolves during Back', async () => {
    mockConnection.workspaceCwd = '';
    mockWorkspace.capabilities = {
      workspaces: [{ id: 'primary', cwd: '/tmp/project', primary: true }],
    };
    let resolveClear!: () => void;
    mockSessionActions.clearSession.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveClear = resolve;
      }),
    );
    const onSessionIdChange = vi.fn();
    const { container, rerender } = renderApp({ onSessionIdChange });
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="open-sessions-overview"]',
        )
        ?.click();
      await Promise.resolve();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="panel-back"]')
        ?.click();
    });
    mockConnection.workspaceCwd = '/tmp/project';
    rerender();
    await flush();
    await act(async () => {
      resolveClear();
      await Promise.resolve();
    });

    expect(onSessionIdChange).toHaveBeenCalledWith(undefined);
    expect(container.querySelector('[data-testid="inline-panel"]')).toBeNull();
  });

  it('does not clear a session opened while leaving the Session Overview', async () => {
    let resolveClear!: () => void;
    mockSessionActions.clearSession.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveClear = resolve;
      }),
    );
    const onSessionIdChange = vi.fn();
    const { container, rerender } = renderApp({ onSessionIdChange });
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="open-sessions-overview"]',
        )
        ?.click();
      await Promise.resolve();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="panel-back"]')
        ?.click();
    });
    expect(mockSessionActions.clearSession).toHaveBeenCalledOnce();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="load-session"]')
        ?.click();
      await Promise.resolve();
    });
    mockConnection.sessionId = 'session-2';
    rerender();
    await flush();
    onSessionIdChange.mockClear();
    await act(async () => {
      resolveClear();
      await Promise.resolve();
    });

    expect(onSessionIdChange).not.toHaveBeenCalled();
  });

  it('forwards the session-source switch customization to the sidebar', async () => {
    const { container, rerender } = renderApp({
      sidebar: { enabled: true, showSessionSourceSwitch: false },
    });
    await flush();

    expect(
      container
        .querySelector('[data-testid="sidebar"]')
        ?.getAttribute('data-show-session-source-switch'),
    ).toBe('false');

    rerender({ sidebar: { enabled: true } });
    await flush();

    expect(
      container
        .querySelector('[data-testid="sidebar"]')
        ?.getAttribute('data-show-session-source-switch'),
    ).toBe('true');

    rerender({ sidebar: true });
    await flush();

    expect(
      container
        .querySelector('[data-testid="sidebar"]')
        ?.getAttribute('data-show-session-source-switch'),
    ).toBe('true');
  });

  it('opens the split view from the sidebar', async () => {
    const { container } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-split-view"]')
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();
    // The outer chat subtree is hidden (display:none + aria-hidden) behind the
    // split, so keyboard/AT can't reach the outer composer/toolbar. Assert the
    // node is present first, so a missing subtree fails rather than passing
    // vacuously through the optional chain.
    const messages = container.querySelector('[data-testid="messages"]');
    expect(messages).not.toBeNull();
    expect(messages?.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('preserves the legacy split Voice workspace fallback', async () => {
    mockWorkspace.capabilities = {
      features: ['voice_transcribe'],
      workspaceCwd: '/workspace',
    } as typeof mockWorkspace.capabilities;
    saveSplitSessions(['s1']);

    const { container } = renderApp();
    await flush();

    expect(
      container.querySelector('[data-testid="split-voice-workspaces"]')
        ?.textContent,
    ).toBe('legacy');
  });

  it('restores a persisted split on load (survives a refresh)', async () => {
    // Simulate the storage left behind by a split that was open before a refresh.
    saveSplitSessions(['s1', 's2']);
    const { container } = renderApp();
    await flush();
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="split-initial"]')?.textContent,
    ).toBe('s1,s2');
  });

  it('does not open the split when nothing was persisted', async () => {
    const { container } = renderApp();
    await flush();
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();
  });

  it('clears the persisted split when the user leaves the split view', async () => {
    saveSplitSessions(['s1', 's2']);
    const { container } = renderApp();
    await flush();
    // Restored into the split; leaving via its back button must clear storage
    // so a later refresh doesn't bring the split back uninvited.
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="split-back"]')
        ?.click();
      await Promise.resolve();
    });
    expect(loadSplitSessions()).toEqual([]);
  });

  it('syncs the split view from external session ids without the sidebar', async () => {
    const { container, rerender } = renderApp({
      sidebar: false,
      splitSessionIds: ['s1'],
      renderPaneHeaderActions: () => null,
    });
    await flush();

    expect(container.querySelector('[data-testid="sidebar"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="split-initial"]')?.textContent,
    ).toBe('s1');
    expect(
      container.querySelector('[data-testid="split-has-header-actions"]')
        ?.textContent,
    ).toBe('yes');

    rerender({ sidebar: false, splitSessionIds: ['s1', 's2'] });
    await flush();
    expect(
      container.querySelector('[data-testid="split-initial"]')?.textContent,
    ).toBe('s1,s2');

    rerender({ sidebar: false, splitSessionIds: [] });
    await flush();
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();

    rerender({ sidebar: false, splitSessionIds: ['s1', 's2'] });
    await flush();
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="split-initial"]')?.textContent,
    ).toBe('s1,s2');
  });

  it('waits for workspace capabilities before classifying controlled split ids', async () => {
    mockWorkspace.capabilities =
      undefined as unknown as typeof mockWorkspace.capabilities;
    const onSplitSessionIdsChange = vi.fn();
    const props = {
      sidebar: false as const,
      splitSessionIds: ['workspace-session'],
      onSplitSessionIdsChange,
    };
    const { container, rerender } = renderApp(props);
    await flush();

    expect(onSplitSessionIdsChange).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();

    mockWorkspace.capabilities = {
      workspaces: [{ id: 'primary', cwd: '/workspace', primary: true }],
    };
    rerender(props);
    await flush();

    expect(onSplitSessionIdsChange).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="split-initial"]')?.textContent,
    ).toBe('workspace-session');
  });

  it('dedupes and caps external split session ids', async () => {
    const { container } = renderApp({
      sidebar: false,
      splitSessionIds: ['s1', 's1', 's2', 's3', 's4', 's5', 's6', 's7'],
    });
    await flush();

    expect(
      container.querySelector('[data-testid="split-initial"]')?.textContent,
    ).toBe('s1,s2,s3,s4,s5,s6');
  });

  it('opens the token usage panel from the default pane header action', async () => {
    const statsFixture: DaemonSessionStatsStatus = {
      v: 1,
      sessionId: 's1',
      workspaceCwd: '/tmp/project',
      sessionStartTimeMs: 1000,
      durationMs: 60000,
      promptCount: 2,
      models: {
        'qwen-plus::hybrid': {
          api: { totalRequests: 2, totalErrors: 0, totalLatencyMs: 1000 },
          tokens: {
            prompt: 500000,
            candidates: 100000,
            total: 600000,
            cached: 50000,
            thoughts: 10000,
          },
        },
      },
      tools: {
        totalCalls: 3,
        totalSuccess: 3,
        totalFail: 0,
        totalDurationMs: 900,
        byName: {},
      },
      files: { totalLinesAdded: 12, totalLinesRemoved: 4 },
      sources: [],
    };
    mockSessionActions.getStats.mockResolvedValue(statsFixture);
    const { container } = renderApp({
      sidebar: false,
      splitSessionIds: ['s1'],
      header: { items: ['tokenUsage'] },
    });
    await flush();

    const entry = container.querySelector<HTMLButtonElement>(
      '[aria-label="Session token usage"]',
    );
    expect(entry).not.toBeNull();
    await act(async () => {
      entry!.click();
      await Promise.resolve();
    });
    await flush();

    expect(mockSessionActions.getStats).toHaveBeenCalled();
    // The right panel (floating drawer on split view) opened with the token
    // usage tab and its live data, portaled into document.body.
    expect(document.body.textContent).toContain('Token Usage');
    expect(document.body.textContent).toContain('qwen-plus::hybrid');
    expect(document.body.textContent).toContain('600K');

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="split-remove-panes"]')!
        .click();
    });
    expect(document.body.textContent).not.toContain('qwen-plus::hybrid');
  });

  it('does not add a token usage pane action unless it is enabled', async () => {
    const { container } = renderApp({
      sidebar: false,
      splitSessionIds: ['s1'],
    });
    await flush();

    // Built-in header actions still exist (Local Control QR entry), but the
    // token usage action stays behind its chat-header opt-in.
    const actions = container.querySelector(
      '[data-testid="split-header-actions"]',
    );
    expect(actions).not.toBeNull();
    expect(
      actions!.querySelector('[aria-label="Mobile access"]'),
    ).not.toBeNull();
    expect(
      actions!.querySelector('[aria-label="Session token usage"]'),
    ).toBeNull();
  });

  it('deep-links Settings to Daemon from the QR entry and clears the link on any panel close', async () => {
    const { container, rerender } = renderApp({
      sidebar: false,
      splitSessionIds: ['s1'],
    });
    await flush();

    // Click the pane-header QR entry's settings action: leaves split view,
    // opens the Settings panel deep-linked to the Daemon category.
    const qrEntry = container.querySelector<HTMLButtonElement>(
      '[data-testid="split-header-actions"] [aria-label="Mobile access"]',
    );
    expect(qrEntry).not.toBeNull();
    await act(async () => {
      qrEntry!.click();
      await Promise.resolve();
    });
    await flush();
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();
    expect(testState.latestSettingsInitialCategory).toBe('Daemon');

    // Close the panel through a non-closePanel path: a gated tool call
    // arriving auto-closes the panel so the approval overlay is visible.
    await act(async () => {
      testState.blocks = [makePendingPermissionBlock()];
      rerender();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="inline-panel"]')).toBeNull();
    await act(async () => {
      testState.blocks = [];
      rerender();
      await Promise.resolve();
    });

    // A later ordinary Settings open must not inherit the stale deep link.
    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();
    expect(testState.latestSettingsInitialCategory).toBeUndefined();
  });

  it('does not reopen controlled split view when the same ids get a new array reference', async () => {
    const { container, rerender } = renderApp({
      sidebar: false,
      splitSessionIds: ['s1', 's2'],
    });
    await flush();
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="split-back"]')
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-testid="inline-panel"]')
        ?.getAttribute('aria-label'),
    ).toBe('Session Overview');

    rerender({ sidebar: false, splitSessionIds: ['s1', 's2'] });
    await flush();
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-testid="inline-panel"]')
        ?.getAttribute('aria-label'),
    ).toBe('Session Overview');
  });

  it('does not reopen a controlled split after exit while classification is pending', async () => {
    const classification = deferred<never>();
    const notStandalone = new DaemonHttpError(
      404,
      { code: 'standalone_session_not_found' },
      'not found',
    );
    mockWorkspace.capabilities = {
      features: ['standalone_sessions_v1'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    mockWorkspace.client.getStandaloneSession
      .mockRejectedValueOnce(notStandalone)
      .mockReturnValueOnce(classification.promise);
    const onSplitSessionIdsChange = vi.fn();
    const { container, rerender } = renderApp({
      sidebar: false,
      splitSessionIds: ['current-session'],
      onSplitSessionIdsChange,
    });
    await flush();
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();

    rerender({
      sidebar: false,
      splitSessionIds: ['older-session'],
      onSplitSessionIdsChange,
    });
    await vi.waitFor(() => {
      expect(mockWorkspace.client.getStandaloneSession).toHaveBeenCalledWith(
        'older-session',
      );
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="split-back"]')
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      classification.reject(notStandalone);
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();
    expect(onSplitSessionIdsChange).toHaveBeenCalledWith([]);
  });

  it('keeps controlled split ids while a standalone navigation can still fail', async () => {
    const notStandalone = new DaemonHttpError(
      404,
      { code: 'standalone_session_not_found' },
      'not found',
    );
    mockWorkspace.capabilities = {
      features: ['standalone_sessions_v1'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    mockWorkspace.client.getStandaloneSession.mockRejectedValue(notStandalone);
    const load = deferred<void>();
    mockSessionActions.loadSession.mockReturnValueOnce(load.promise);
    const onSplitSessionIdsChange = vi.fn();
    const { container } = renderApp({
      sidebar: true,
      splitSessionIds: ['s1', 's2'],
      onSplitSessionIdsChange,
    });
    await flush();
    onSplitSessionIdsChange.mockClear();

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="load-standalone-session"]',
        )
        ?.click();
    });
    await flush();

    expect(onSplitSessionIdsChange).not.toHaveBeenCalledWith([]);
    await act(async () => {
      load.reject(notStandalone);
      await Promise.resolve();
    });
    await flush();

    expect(onSplitSessionIdsChange).not.toHaveBeenCalledWith([]);
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();
  });

  it('notifies external callers when split session ids change inside WebShell', async () => {
    const onSplitSessionIdsChange = vi.fn();
    const { container, rerender } = renderApp({
      sidebar: false,
      splitSessionIds: ['s1'],
      onSplitSessionIdsChange,
    });
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="split-report-panes"]')
        ?.click();
      await Promise.resolve();
    });

    expect(onSplitSessionIdsChange).toHaveBeenCalledWith(['s1', 's2', 's3']);
    expect(
      container.querySelector('[data-testid="split-initial"]')?.textContent,
    ).toBe('s1');

    rerender({
      sidebar: false,
      splitSessionIds: ['s1', 's2', 's3'],
      onSplitSessionIdsChange,
    });
    await flush();
    expect(
      container.querySelector('[data-testid="split-initial"]')?.textContent,
    ).toBe('s1,s2,s3');
  });

  it('notifies external callers when uncontrolled split session ids change', async () => {
    const onSplitSessionIdsChange = vi.fn();
    const shellRef = createRef<WebShellApi>();
    const { container } = renderApp({
      sidebar: false,
      onSplitSessionIdsChange,
      shellRef,
    });
    await flush();

    await act(async () => {
      shellRef.current?.openSplitView();
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="split-report-panes"]')
        ?.click();
      await Promise.resolve();
    });

    expect(onSplitSessionIdsChange).toHaveBeenCalledWith(['s1', 's2', 's3']);
  });

  it('opens the split view from the external shell ref like the sidebar button', async () => {
    let shellApi: WebShellApi | null = null;
    const { container } = renderApp({
      sidebar: false,
      shellRef: (api) => {
        shellApi = api;
      },
    });
    await flush();

    expect(container.querySelector('[data-testid="sidebar"]')).toBeNull();

    await act(async () => {
      shellApi?.openSplitView();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="split-initial"]')?.textContent,
    ).toBe('session-1');
  });

  it('submits allow_once for a native structured edit approval accept', async () => {
    let shellApi: WebShellApi | null = null;
    const { rerender } = renderApp({
      hostOwnsEditDiffPreview: true,
      shellRef: (api) => {
        shellApi = api;
      },
    });
    await flush();

    // Edit approval options arrive in the wire order built by
    // toPermissionOptions: allow_always first. The allow_once preference in
    // respondToPendingPermission is the only thing keeping a single native
    // Accept from submitting "Allow All Edits".
    await act(async () => {
      testState.blocks = [
        makePendingPermissionBlock({
          toolName: 'run_shell_command',
          kind: 'execute',
          content: [
            {
              type: 'diff',
              path: 'file.ts',
              oldText: 'before',
              newText: 'after',
            },
          ],
          options: [
            {
              optionId: 'proceed_always',
              label: 'Allow All Edits',
              raw: { kind: 'allow_always' },
            },
            {
              optionId: 'proceed_once',
              label: 'Allow',
              raw: { kind: 'allow_once' },
            },
            {
              optionId: 'cancel',
              label: 'Reject',
              raw: { kind: 'reject_once' },
            },
          ],
        }),
      ];
      rerender();
      await Promise.resolve();
    });
    await flush();
    expect(
      document.querySelector('[data-testid="approval-overlay"]'),
    ).not.toBeNull();

    let resolved: boolean | undefined;
    await act(async () => {
      resolved = await shellApi?.respondToPendingPermission('req-1', 'allow');
      await Promise.resolve();
    });
    await flush();

    expect(resolved).toBe(true);
    expect(mockSessionActions.submitPermission).toHaveBeenCalledTimes(1);
    expect(mockSessionActions.submitPermission).toHaveBeenCalledWith(
      'req-1',
      'proceed_once',
    );
  });

  it('does not let stale split classification replace a newer direct open', async () => {
    const classification = deferred<never>();
    mockWorkspace.capabilities = {
      features: ['standalone_sessions_v1'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    mockWorkspace.client.getStandaloneSession.mockReturnValueOnce(
      classification.promise,
    );
    const { container } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="open-sessions-overview"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      testState.latestSessionOverviewProps?.onOpenSplit?.(['older-session']);
      await vi.waitFor(() => {
        expect(mockWorkspace.client.getStandaloneSession).toHaveBeenCalledWith(
          'older-session',
        );
      });
    });
    act(() => {
      testState.latestSessionOverviewProps?.onOpenSession?.(
        'session-2',
        '/tmp/project',
      );
    });
    await flush();

    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();

    await act(async () => {
      classification.reject(
        new DaemonHttpError(
          404,
          { code: 'standalone_session_not_found' },
          'not found',
        ),
      );
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();
    expect(loadSplitSessions()).toEqual([]);
  });

  it('does not let stale split classification replace a sidebar session load', async () => {
    const classification = deferred<never>();
    mockWorkspace.capabilities = {
      features: ['standalone_sessions_v1'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    mockWorkspace.client.getStandaloneSession.mockReturnValueOnce(
      classification.promise,
    );
    const { container } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="open-sessions-overview"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      testState.latestSessionOverviewProps?.onOpenSplit?.(['older-session']);
      await vi.waitFor(() => {
        expect(mockWorkspace.client.getStandaloneSession).toHaveBeenCalledWith(
          'older-session',
        );
      });
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="load-session"]')
        ?.click();
      await Promise.resolve();
    });
    await flush();

    await act(async () => {
      classification.reject(
        new DaemonHttpError(
          404,
          { code: 'standalone_session_not_found' },
          'not found',
        ),
      );
      await Promise.resolve();
    });

    expect(mockSessionActions.loadSession).toHaveBeenCalledWith(
      'session-2',
      expect.any(Object),
    );
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();
    expect(loadSplitSessions()).toEqual([]);
  });

  it('requests controlled split ids from the external shell ref', async () => {
    const onSplitSessionIdsChange = vi.fn();
    const shellRef = createRef<WebShellApi>();
    const { container } = renderApp({
      sidebar: false,
      splitSessionIds: [],
      onSplitSessionIdsChange,
      shellRef,
    });
    await flush();

    await act(async () => {
      shellRef.current?.openSplitView();
      await Promise.resolve();
    });

    expect(onSplitSessionIdsChange).toHaveBeenCalledWith(['session-1']);
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();
  });

  it('does not request controlled split ids from a standalone shell context', async () => {
    mockConnection.sessionContext = { kind: 'standalone' };
    mockConnection.workspaceCwd = '';
    const onSplitSessionIdsChange = vi.fn();
    const shellRef = createRef<WebShellApi>();
    renderApp({
      sidebar: false,
      splitSessionIds: [],
      onSplitSessionIdsChange,
      shellRef,
    });
    await flush();

    act(() => {
      shellRef.current?.openSplitView();
    });
    await flush();

    expect(onSplitSessionIdsChange).not.toHaveBeenCalled();
  });

  it('assigns and clears the external shell object ref', async () => {
    const shellRef = createRef<WebShellApi>();
    const { unmount } = renderApp({
      sidebar: false,
      shellRef,
    });
    await flush();

    expect(shellRef.current).not.toBeNull();

    unmount();

    expect(shellRef.current).toBeNull();
  });

  it('creates a side task from the external shell ref', async () => {
    mockConnection.capabilities.features = ['session_side_task'];
    mockWorkspace.client.createSideTaskSession.mockResolvedValueOnce({
      sessionId: 'side-session-1',
      clientId: 'side-client-1',
      displayName: 'Side task',
    });
    const shellRef = createRef<WebShellApi>();
    const { container } = renderApp({ shellRef });
    await flush();

    let created = false;
    act(() => {
      created = shellRef.current?.createSideTask() ?? false;
    });

    expect(created).toBe(true);
    expect(container.querySelector('button[title="Side task"]')).not.toBeNull();
    await flush();
    expect(sessionCatalogController.sessionCreated).toHaveBeenCalledWith(
      '/tmp/project',
      'side-session-1',
    );
  });

  it('opens the Session Overview from the external shell ref like the sidebar button', async () => {
    let shellApi: WebShellApi | null = null;
    const { container } = renderApp({
      sidebar: false,
      shellRef: (api) => {
        shellApi = api;
      },
    });
    await flush();

    expect(container.querySelector('[data-testid="sidebar"]')).toBeNull();

    await act(async () => {
      shellApi?.openSessionOverview();
      await Promise.resolve();
    });

    const panel = container.querySelector('[data-testid="inline-panel"]');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('aria-label')).toBe('Session Overview');
  });

  it('forces the compact session drawer from the external shell ref', async () => {
    const shellRef = createRef<WebShellApi>();
    const { container } = renderApp({ sidebar: true, shellRef });
    await flush();

    await act(async () => {
      shellRef.current?.openSessionDrawer();
      await Promise.resolve();
    });

    const drawer = container.querySelector(
      '[data-sidebar-shell][role="dialog"]',
    );
    expect(drawer).not.toBeNull();
    expect(drawer?.className).toContain('mobileDrawerForced');
  });

  it('closes the forced compact drawer from the sidebar control', async () => {
    const shellRef = createRef<WebShellApi>();
    const { container } = renderApp({ sidebar: true, shellRef });
    await flush();

    await act(async () => {
      shellRef.current?.openSessionDrawer();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-sidebar-shell][role="dialog"]'),
    ).not.toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="close-mobile-sidebar"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-sidebar-shell][role="dialog"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-sidebar-shell]')?.className,
    ).not.toContain('mobileDrawerForced');
  });

  it('does not open or lock scrolling when the sidebar is disabled', async () => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'auto';

    try {
      const shellRef = createRef<WebShellApi>();
      const { container } = renderApp({ sidebar: false, shellRef });
      await flush();

      await act(async () => {
        shellRef.current?.openSessionDrawer();
        await Promise.resolve();
      });

      expect(container.querySelector('[data-sidebar-shell]')).toBeNull();
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(document.body.style.overflow).toBe('auto');
    } finally {
      document.body.style.overflow = previousOverflow;
    }
  });

  it('closes a forced compact drawer when the sidebar becomes disabled', async () => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'auto';
    const shellRef = createRef<WebShellApi>();
    const { container, rerender, unmount } = renderApp({
      sidebar: true,
      shellRef,
    });

    try {
      await flush();
      await act(async () => {
        shellRef.current?.openSessionDrawer();
        await Promise.resolve();
      });

      expect(
        container.querySelector('[data-sidebar-shell][role="dialog"]'),
      ).not.toBeNull();
      expect(document.body.style.overflow).toBe('hidden');

      rerender({ sidebar: false, shellRef });
      await flush();

      expect(container.querySelector('[data-sidebar-shell]')).toBeNull();
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(document.body.style.overflow).toBe('auto');
    } finally {
      unmount();
      document.body.style.overflow = previousOverflow;
    }
  });

  it('dismisses a forced compact drawer before opening split view', async () => {
    const shellRef = createRef<WebShellApi>();
    const { container } = renderApp({ sidebar: true, shellRef });
    await flush();

    await act(async () => {
      shellRef.current?.openSessionDrawer();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-sidebar-shell][role="dialog"]'),
    ).not.toBeNull();

    await act(async () => {
      shellRef.current?.openSplitView();
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-sidebar-shell][role="dialog"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-sidebar-shell]')?.className,
    ).not.toContain('mobileDrawerForced');
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('dismisses a forced compact drawer before opening the Session Overview', async () => {
    const shellRef = createRef<WebShellApi>();
    const { container } = renderApp({ sidebar: true, shellRef });
    await flush();

    await act(async () => {
      shellRef.current?.openSessionDrawer();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-sidebar-shell][role="dialog"]'),
    ).not.toBeNull();

    await act(async () => {
      shellRef.current?.openSessionOverview();
      await Promise.resolve();
    });

    const panel = container.querySelector('[data-testid="inline-panel"]');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('aria-label')).toBe('Session Overview');
    expect(
      container.querySelector('[data-sidebar-shell][role="dialog"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-sidebar-shell]')?.className,
    ).not.toContain('mobileDrawerForced');
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('returns a forced compact drawer to viewport control when dismissed', async () => {
    const shellRef = createRef<WebShellApi>();
    const { container } = renderApp({ sidebar: true, shellRef });
    await flush();

    await act(async () => {
      shellRef.current?.openSessionDrawer();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-sidebar-shell]')?.className,
    ).toContain('mobileDrawerForced');

    await act(async () => {
      container
        .querySelector<HTMLElement>(
          '[data-sidebar-shell] > div[aria-hidden="true"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-sidebar-shell]')?.className,
    ).not.toContain('mobileDrawerForced');
    expect(
      container.querySelector('[data-sidebar-shell][role="dialog"]'),
    ).toBeNull();
  });

  it('returns to chat and clears the current page when opening the compact drawer', async () => {
    const shellRef = createRef<WebShellApi>();
    const { container } = renderApp({ sidebar: true, shellRef });
    await flush();

    await act(async () => {
      shellRef.current?.openSessionOverview();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();

    await act(async () => {
      shellRef.current?.openSessionDrawer();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="inline-panel"]')).toBeNull();

    await act(async () => {
      shellRef.current?.openSplitView();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();

    await act(async () => {
      shellRef.current?.openSessionDrawer();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-sidebar-shell][role="dialog"]'),
    ).not.toBeNull();
  });

  it('clears a forced compact drawer after crossing to a wide viewport', async () => {
    let mobileChangeHandler:
      | ((event: { matches: boolean }) => void)
      | undefined;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('min-width'),
        media: query,
        addEventListener: (
          _type: string,
          handler: (event: { matches: boolean }) => void,
        ) => {
          if (query.includes('max-width')) mobileChangeHandler = handler;
        },
        removeEventListener: vi.fn(),
      })),
    });
    const shellRef = createRef<WebShellApi>();
    const { container } = renderApp({ sidebar: true, shellRef });
    await flush();

    await act(async () => {
      shellRef.current?.openSessionDrawer();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-sidebar-shell]')?.className,
    ).toContain('mobileDrawerForced');

    await act(async () => {
      mobileChangeHandler?.({ matches: false });
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-sidebar-shell]')?.className,
    ).not.toContain('mobileDrawerForced');
    expect(
      container.querySelector('[data-sidebar-shell][role="dialog"]'),
    ).toBeNull();
  });

  it('starts a new session from the external shell ref and returns to chat', async () => {
    const shellRef = createRef<WebShellApi>();
    const { container } = renderApp({ sidebar: true, shellRef });
    await flush();

    await act(async () => {
      shellRef.current?.openSplitView();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();

    vi.useFakeTimers();
    let created: boolean | undefined;
    await act(async () => {
      created = await shellRef.current?.createNewSession();
      vi.runOnlyPendingTimers();
    });

    expect(created).toBe(true);
    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();
  });

  it('reports a failed external new-session attempt through its boolean result', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockSessionActions.clearSession.mockRejectedValueOnce(new Error('boom'));
    const shellRef = createRef<WebShellApi>();
    renderApp({ sidebar: true, shellRef });
    await flush();

    vi.useFakeTimers();
    let created: boolean | undefined;
    await act(async () => {
      created = await shellRef.current?.createNewSession();
      vi.runOnlyPendingTimers();
    });

    expect(created).toBe(false);
    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      '[web-shell]',
      'boom',
      expect.any(Error),
    );
  });

  it('returns to the Session Overview when leaving the split view', async () => {
    const { container } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-split-view"]')
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="split-back"]')
        ?.click();
      await Promise.resolve();
    });
    // Split closed; the Session Overview panel is shown instead of the chat.
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();
    const panel = container.querySelector('[data-testid="inline-panel"]');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('aria-label')).toBe('Session Overview');
  });

  it('notifies controlled callers when leaving the split view', async () => {
    const onSplitSessionIdsChange = vi.fn();
    const { container } = renderApp({
      sidebar: false,
      splitSessionIds: ['s1', 's2'],
      onSplitSessionIdsChange,
    });
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="split-back"]')
        ?.click();
      await Promise.resolve();
    });

    expect(onSplitSessionIdsChange).toHaveBeenCalledWith([]);
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-testid="inline-panel"]')
        ?.getAttribute('aria-label'),
    ).toBe('Session Overview');
  });

  it('preserves the pane set when leaving the split view and reopening it', async () => {
    const { container } = renderApp();
    await flush();

    // Open the split, then let SplitView report a live pane set (s1,s2,s3) back
    // to the App — the same way real add/remove mirrors up via onPanesChange.
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-split-view"]')
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="split-report-panes"]')
        ?.click();
      await Promise.resolve();
    });

    // Leave the split (back to the overview)…
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="split-back"]')
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();

    // …and reopen it from the toolbar. The reported panes must be restored, not
    // reset to empty / the current session (the regression this guards).
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-split-view"]')
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="split-initial"]')?.textContent,
    ).toBe('s1,s2,s3');
  });

  it('updates an open artifact tab from pane snapshots and keeps it after the pane clears', async () => {
    mockWorkspace.capabilities = {
      workspaceCwd: '/tmp/project',
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const { container } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-split-view"]')
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="split-open-artifact"]')
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="split-report-artifact"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Pane artifact');
    expect(document.body.textContent).toContain('10 B');

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="split-report-updated-artifact"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('20 B');

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="split-report-changed-artifact"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('changed');

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="split-clear-artifacts"]',
        )
        ?.click();
      await Promise.resolve();
    });

    // The pane snapshot is gone, but the extra pushed on open keeps the
    // still-open tab renderable instead of orphaning it.
    expect(document.body.textContent).toContain('Pane artifact');
    expect(document.body.textContent).toContain('10 B');
    expect(document.body.textContent).not.toContain('Artifact not found.');
  });

  it('routes a split pane scheduled task through its stamped workspace identity', async () => {
    mockWorkspace.capabilities = {
      workspaceCwd: '/tmp/project',
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
        {
          id: 'pane-ws',
          cwd: '/tmp/pane',
          primary: false,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    mockWorkspaceActions.listScheduledTasks.mockResolvedValue([
      {
        id: 'pane-cron',
        name: 'Pane task',
        cron: '0 9 * * *',
        prompt: 'pane task prompt',
        recurring: true,
        enabled: true,
        createdAt: 1_700_000_000_000,
        lastFiredAt: null,
        nextRunAt: null,
        sessionId: null,
        runs: [],
      },
    ]);
    const { container } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-split-view"]')
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="split-open-scheduled-task"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(mockWorkspaceActions.listScheduledTasks).toHaveBeenCalledWith(
      'pane-ws',
    );
    expect(document.body.textContent).toContain('Pane task');
    expect(document.body.textContent).not.toContain(
      'This workspace may have been removed',
    );
  });

  it('routes a split pane review download through its stamped workspace identity', async () => {
    mockWorkspace.capabilities = {
      workspaceCwd: '/tmp/project',
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
        {
          id: 'pane-ws',
          cwd: '/tmp/pane',
          primary: false,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const paneFileStat = vi.fn().mockResolvedValue({
      sizeBytes: 5,
      modifiedMs: 1,
    });
    const paneReadBytes = vi.fn().mockResolvedValue({
      contentBase64: btoa('notes'),
      offset: 0,
      returnedBytes: 5,
      sizeBytes: 5,
    });
    const paneWorkspaceClient = {
      workspaceGit: vi.fn().mockResolvedValue({ branch: 'main' }),
      workspaceSkills: mockWorkspaceActions.loadSkillsStatus,
      workspaceGitHubPullRequests: vi.fn().mockResolvedValue({
        v: 1,
        workspaceCwd: '/tmp/pane',
        available: true,
        pullRequests: [],
      }),
      fileStat: paneFileStat,
      readWorkspaceFileBytes: paneReadBytes,
    };
    mockWorkspace.client.workspaceByCwd.mockImplementation(
      () => paneWorkspaceClient,
    );
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:pane-review'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    const { container } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-split-view"]')
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="split-open-review"]')
        ?.click();
      await Promise.resolve();
    });

    const download = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Download',
    );
    expect(download).toBeDefined();
    await act(async () => {
      download?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockWorkspace.client.workspaceByCwd).toHaveBeenCalledWith(
      '/tmp/pane',
    );
    expect(paneFileStat).toHaveBeenCalledWith('notes.md');
    expect(paneReadBytes).toHaveBeenCalledWith(
      'notes.md',
      expect.objectContaining({ offset: 0 }),
    );
  });

  it('keeps a main-session artifact tab renderable across a live-list gap', async () => {
    mockWorkspace.capabilities = {
      workspaceCwd: '/tmp/project',
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    mockConnection.capabilities = {
      ...mockConnection.capabilities,
      features: ['session_artifacts'],
    };
    const mainArtifactRow = {
      id: 'main-artifact',
      kind: 'report',
      storage: 'memory',
      source: 'tool',
      status: 'available',
      title: 'Main artifact',
      updatedAt: '2026-07-10T00:00:00Z',
      sizeBytes: 10,
    };
    mockSessionActions.loadArtifacts.mockResolvedValue({
      artifacts: [mainArtifactRow],
    });
    const { container, rerender } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-split-view"]')
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="split-open-main-artifact"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Main artifact');
    expect(document.body.textContent).toContain('10 B');

    // A transient disconnect empties the live artifact list; the cached
    // open-time row keeps the tab renderable through the gap.
    mockConnection.status = 'disconnected';
    await act(async () => {
      rerender();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Main artifact');
    expect(document.body.textContent).not.toContain('Artifact not found.');

    // Reconnecting restores the live list and reconciles the cached copy.
    mockConnection.status = 'connected';
    await act(async () => {
      rerender();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Main artifact');
    mockSessionActions.loadArtifacts.mockResolvedValue({ artifacts: [] });
  });

  it('opens a split pane monitor in the right panel', async () => {
    const { container } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-split-view"]')
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="split-open-monitor"]')
        ?.click();
      await Promise.resolve();
    });

    expect(
      document.body.querySelector('button[title="watch pane logs"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();
  });

  it('keeps same-name attachment tabs separate across split sessions', async () => {
    const { container } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-split-view"]')
        ?.click();
      await Promise.resolve();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="split-open-attachment-one"]',
        )
        ?.click();
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="split-open-attachment-two"]',
        )
        ?.click();
    });

    expect(
      document.body.querySelectorAll(
        'aside[aria-label="Right panel"] button[role="tab"]',
      ),
    ).toHaveLength(2);
  });

  it('clears split pane artifact snapshots when switching sessions', async () => {
    mockWorkspace.capabilities = {
      workspaceCwd: '/tmp/project',
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const { container, rerender } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-split-view"]')
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="split-report-artifact"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="split-open-artifact"]')
        ?.click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Pane artifact');
    expect(document.body.textContent).toContain('10 B');
    expect(document.body.textContent).not.toContain(
      'This workspace may have been removed',
    );

    await act(async () => {
      mockConnection.sessionId = 'session-2';
      rerender();
      await Promise.resolve();
    });

    expect(document.body.textContent).not.toContain('Pane artifact');
  });

  it('enters the split view from a ?split= URL and consumes the param', async () => {
    window.history.pushState({}, '', '/?split=s1,s2');
    try {
      const { container } = renderApp();
      await flush();
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).not.toBeNull();
      // The one-shot param is stripped so a reload/exit doesn't force it back.
      expect(window.location.search).toBe('');
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('does not restore over a consumed split deep link after capabilities refresh', async () => {
    window.history.pushState({}, '', '/?split=s1,s2');
    try {
      const { container, rerender } = renderApp();
      await flush();
      saveSplitSessions(['stale-split']);
      act(() => {
        mockWorkspace.capabilities = {
          ...mockWorkspace.capabilities,
          features: [...(mockWorkspace.capabilities?.features ?? [])],
        } as typeof mockWorkspace.capabilities;
        rerender();
      });
      await flush();

      expect(
        container.querySelector('[data-testid="split-initial"]')?.textContent,
      ).toBe('s1,s2');
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('lets controlled split session ids take precedence over a ?split= URL', async () => {
    window.history.pushState({}, '', '/?split=s1,s2');
    try {
      const { container } = renderApp({
        sidebar: false,
        splitSessionIds: ['s3'],
      });
      await flush();
      expect(
        container.querySelector('[data-testid="split-initial"]')?.textContent,
      ).toBe('s3');
      expect(window.location.search).toBe('');
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('seeds the split from a ?split= URL, deduping and capping the explicit selection', async () => {
    // Duplicates and more than MAX_SPLIT_PANES (6) ids drive the explicit-
    // selection branch of openSplitView (dedupe + cap + replace), distinct from
    // the no-selection restore branch covered above.
    window.history.pushState({}, '', '/?split=s1,s1,s2,s3,s4,s5,s6,s7');
    try {
      const { container } = renderApp();
      await flush();
      expect(
        container.querySelector('[data-testid="split-initial"]')?.textContent,
      ).toBe('s1,s2,s3,s4,s5,s6');
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('keeps the split view open when an approval becomes pending (unlike the scheduled-tasks page)', async () => {
    // Each split pane owns its own session's approval, so an approval on the
    // outer main session must NOT yank the user out of the split.
    const { container, rerender } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-split-view"]')
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();

    await act(async () => {
      testState.blocks = [makePendingPermissionBlock()];
      rerender();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();
    // The outer session's approval overlay must NOT render behind the split —
    // otherwise its global keyboard shortcuts could confirm an unseen approval.
    expect(
      container.querySelector('[data-testid="approval-overlay"]'),
    ).toBeNull();
  });

  it('surfaces the outer approval as a split notice and returns to chat when clicked', async () => {
    // The overlay is suppressed under the split, so the outer approval would be
    // invisible; a notice banner (with a way back) is the only signal.
    const { container, rerender } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-split-view"]')
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      testState.blocks = [makePendingPermissionBlock()];
      rerender();
      await Promise.resolve();
    });
    const notice = container.querySelector(
      '[data-testid="split-approval-notice"]',
    );
    expect(notice).not.toBeNull();
    // Its button leaves the split (mainView -> 'chat') so the approval overlay,
    // which only renders in chat, becomes visible and actionable.
    await act(async () => {
      notice!
        .querySelector('button')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="approval-overlay"]'),
    ).not.toBeNull();
  });

  it('auto-closes the split view when the screen shrinks below the breakpoint', async () => {
    let large = true;
    let changeHandler: ((event: { matches: boolean }) => void) | undefined;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        get matches() {
          return query.includes('min-width') ? large : false;
        },
        media: query,
        addEventListener: (
          _type: string,
          cb: (event: { matches: boolean }) => void,
        ) => {
          if (query.includes('1024')) changeHandler = cb;
        },
        removeEventListener: vi.fn(),
      })),
    });

    const { container } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-split-view"]')
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();

    await act(async () => {
      large = false;
      changeHandler?.({ matches: false });
      await Promise.resolve();
    });
    // Shrinking below the large-screen breakpoint folds the split back to chat.
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();
  });

  it('notifies controlled callers when a screen shrink closes the split view', async () => {
    let large = true;
    let changeHandler: ((event: { matches: boolean }) => void) | undefined;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        get matches() {
          return query.includes('min-width') ? large : false;
        },
        media: query,
        addEventListener: (
          _type: string,
          cb: (event: { matches: boolean }) => void,
        ) => {
          if (query.includes('1024')) changeHandler = cb;
        },
        removeEventListener: vi.fn(),
      })),
    });
    const onSplitSessionIdsChange = vi.fn();

    const { container } = renderApp({
      sidebar: false,
      splitSessionIds: ['s1', 's2'],
      onSplitSessionIdsChange,
    });
    await flush();
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();

    await act(async () => {
      large = false;
      changeHandler?.({ matches: false });
      await Promise.resolve();
    });

    expect(onSplitSessionIdsChange).toHaveBeenCalledWith([]);
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();
  });

  it('folds the split without switching the chat session on shrink', async () => {
    let large = true;
    let changeHandler: ((event: { matches: boolean }) => void) | undefined;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        get matches() {
          return query.includes('min-width') ? large : false;
        },
        media: query,
        addEventListener: (
          _type: string,
          cb: (event: { matches: boolean }) => void,
        ) => {
          if (query.includes('1024')) changeHandler = cb;
        },
        removeEventListener: vi.fn(),
      })),
    });
    mockConnection.sessionId = 'session-1';
    window.history.replaceState(null, '', '/?split=s1,s2');

    try {
      const { container } = renderApp();
      await flush();
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).not.toBeNull();

      await act(async () => {
        large = false;
        changeHandler?.({ matches: false });
        await Promise.resolve();
      });

      // The split folds back to chat, but folding must leave the chat's own
      // connection untouched — switching sessions here would drop its session /
      // git-branch / URL context and break the lossless restore on regrow.
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).toBeNull();
      expect(mockSessionActions.loadSession).not.toHaveBeenCalled();
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('restores the split view when the screen grows back after a shrink', async () => {
    let large = true;
    let changeHandler: ((event: { matches: boolean }) => void) | undefined;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        get matches() {
          return query.includes('min-width') ? large : false;
        },
        media: query,
        addEventListener: (
          _type: string,
          cb: (event: { matches: boolean }) => void,
        ) => {
          if (query.includes('1024')) changeHandler = cb;
        },
        removeEventListener: vi.fn(),
      })),
    });
    window.history.replaceState(null, '', '/?split=s1,s2');

    try {
      const { container } = renderApp();
      await flush();
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).not.toBeNull();

      // Shrinking below the breakpoint folds the split away...
      await act(async () => {
        large = false;
        changeHandler?.({ matches: false });
        await Promise.resolve();
      });
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).toBeNull();

      // ...and growing back past it restores the same split (a transient resize
      // is lossless, not a permanent drop of the panes).
      await act(async () => {
        large = true;
        changeHandler?.({ matches: true });
        await Promise.resolve();
      });
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).not.toBeNull();
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('defers split restoration while the Session Overview is open', async () => {
    let large = true;
    let changeHandler: ((event: { matches: boolean }) => void) | undefined;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        get matches() {
          return query.includes('min-width') ? large : false;
        },
        media: query,
        addEventListener: (
          _type: string,
          cb: (event: { matches: boolean }) => void,
        ) => {
          if (query.includes('1024')) changeHandler = cb;
        },
        removeEventListener: vi.fn(),
      })),
    });
    window.history.replaceState(null, '', '/?split=s1,s2');

    try {
      const { container } = renderApp();
      await flush();
      await act(async () => {
        large = false;
        changeHandler?.({ matches: false });
        await Promise.resolve();
      });
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="open-sessions-overview"]',
          )
          ?.click();
        await Promise.resolve();
      });

      await act(async () => {
        large = true;
        changeHandler?.({ matches: true });
        await Promise.resolve();
      });
      const panel = container.querySelector('[data-testid="inline-panel"]');
      expect(panel).not.toBeNull();
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).toBeNull();

      await act(async () => {
        panel?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
        await Promise.resolve();
      });
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).not.toBeNull();
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('does not restore a folded split when leaving the Session Overview with Back', async () => {
    let large = true;
    let changeHandler: ((event: { matches: boolean }) => void) | undefined;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        get matches() {
          return query.includes('min-width') ? large : false;
        },
        media: query,
        addEventListener: (
          _type: string,
          cb: (event: { matches: boolean }) => void,
        ) => {
          if (query.includes('1024')) changeHandler = cb;
        },
        removeEventListener: vi.fn(),
      })),
    });
    window.history.replaceState(null, '', '/?split=s1,s2');

    try {
      const { container } = renderApp();
      await flush();
      await act(async () => {
        large = false;
        changeHandler?.({ matches: false });
        await Promise.resolve();
      });
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="open-sessions-overview"]',
          )
          ?.click();
        await Promise.resolve();
      });

      await act(async () => {
        large = true;
        changeHandler?.({ matches: true });
        await Promise.resolve();
      });
      expect(
        container.querySelector('[data-testid="inline-panel"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).toBeNull();

      // Back is explicit navigation, not a plain dismiss: the folded split
      // must not be restored over the fresh chat.
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('[data-testid="panel-back"]')
          ?.click();
        await Promise.resolve();
      });
      expect(
        container.querySelector('[data-testid="inline-panel"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).toBeNull();
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('does not restore a folded split when opening a session from the Session Overview', async () => {
    let large = true;
    let changeHandler: ((event: { matches: boolean }) => void) | undefined;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        get matches() {
          return query.includes('min-width') ? large : false;
        },
        media: query,
        addEventListener: (
          _type: string,
          cb: (event: { matches: boolean }) => void,
        ) => {
          if (query.includes('1024')) changeHandler = cb;
        },
        removeEventListener: vi.fn(),
      })),
    });
    window.history.replaceState(null, '', '/?split=s1,s2');

    try {
      const { container } = renderApp();
      await flush();
      await act(async () => {
        large = false;
        changeHandler?.({ matches: false });
        await Promise.resolve();
      });
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="open-sessions-overview"]',
          )
          ?.click();
        await Promise.resolve();
      });

      await act(async () => {
        large = true;
        changeHandler?.({ matches: true });
        await Promise.resolve();
      });
      expect(
        container.querySelector('[data-testid="inline-panel"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).toBeNull();

      // Opening a session is explicit navigation: the folded split must not
      // be restored over the session the user chose.
      await act(async () => {
        await testState.latestSessionOverviewProps?.onOpenSession?.(
          'session-2',
        );
        await Promise.resolve();
      });
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).toBeNull();
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('does not restore a folded split when the sidebar starts a new chat', async () => {
    let large = true;
    let changeHandler: ((event: { matches: boolean }) => void) | undefined;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        get matches() {
          return query.includes('min-width') ? large : false;
        },
        media: query,
        addEventListener: (
          _type: string,
          cb: (event: { matches: boolean }) => void,
        ) => {
          if (query.includes('1024')) changeHandler = cb;
        },
        removeEventListener: vi.fn(),
      })),
    });
    window.history.replaceState(null, '', '/?split=s1,s2');

    try {
      const { container } = renderApp();
      await flush();
      await act(async () => {
        large = false;
        changeHandler?.({ matches: false });
        await Promise.resolve();
      });
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="open-sessions-overview"]',
          )
          ?.click();
        await Promise.resolve();
      });
      await act(async () => {
        large = true;
        changeHandler?.({ matches: true });
        await Promise.resolve();
      });
      expect(
        container.querySelector('[data-testid="inline-panel"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).toBeNull();

      // New chat is explicit navigation: the folded split must not be
      // restored over the fresh chat.
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('[data-testid="new-session"]')
          ?.click();
        await Promise.resolve();
      });
      await flush();
      expect(
        container.querySelector('[data-testid="inline-panel"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).toBeNull();
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('does not restore a folded split when the sidebar loads a session', async () => {
    let large = true;
    let changeHandler: ((event: { matches: boolean }) => void) | undefined;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        get matches() {
          return query.includes('min-width') ? large : false;
        },
        media: query,
        addEventListener: (
          _type: string,
          cb: (event: { matches: boolean }) => void,
        ) => {
          if (query.includes('1024')) changeHandler = cb;
        },
        removeEventListener: vi.fn(),
      })),
    });
    window.history.replaceState(null, '', '/?split=s1,s2');

    try {
      const { container } = renderApp();
      await flush();
      await act(async () => {
        large = false;
        changeHandler?.({ matches: false });
        await Promise.resolve();
      });
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="open-sessions-overview"]',
          )
          ?.click();
        await Promise.resolve();
      });
      await act(async () => {
        large = true;
        changeHandler?.({ matches: true });
        await Promise.resolve();
      });
      expect(
        container.querySelector('[data-testid="inline-panel"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).toBeNull();

      // Loading a session is explicit navigation: the folded split must not
      // be restored over the session the user chose.
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('[data-testid="load-session"]')
          ?.click();
        await Promise.resolve();
      });
      await flush();
      expect(
        container.querySelector('[data-testid="inline-panel"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).toBeNull();
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('does not restore a folded split when the sidebar selects the current session', async () => {
    let large = true;
    let changeHandler: ((event: { matches: boolean }) => void) | undefined;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        get matches() {
          return query.includes('min-width') ? large : false;
        },
        media: query,
        addEventListener: (
          _type: string,
          cb: (event: { matches: boolean }) => void,
        ) => {
          if (query.includes('1024')) changeHandler = cb;
        },
        removeEventListener: vi.fn(),
      })),
    });
    window.history.replaceState(null, '', '/?split=s1,s2');

    try {
      const { container } = renderApp();
      await flush();
      await act(async () => {
        large = false;
        changeHandler?.({ matches: false });
        await Promise.resolve();
      });
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="open-sessions-overview"]',
          )
          ?.click();
        await Promise.resolve();
      });
      await act(async () => {
        large = true;
        changeHandler?.({ matches: true });
        await Promise.resolve();
      });

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="select-current-session"]',
          )
          ?.click();
        await Promise.resolve();
      });
      expect(
        container.querySelector('[data-testid="inline-panel"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).toBeNull();
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('does not hand out the overview split action below the large-screen breakpoint', async () => {
    let large = false;
    let changeHandler: ((event: { matches: boolean }) => void) | undefined;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        get matches() {
          return query.includes('min-width') ? large : false;
        },
        media: query,
        addEventListener: (
          _type: string,
          cb: (event: { matches: boolean }) => void,
        ) => {
          if (query.includes('1024')) changeHandler = cb;
        },
        removeEventListener: vi.fn(),
      })),
    });

    const { container } = renderApp();
    await flush();
    // The overview itself is reachable below the breakpoint...
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="open-sessions-overview"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();
    // ...but a split cannot exist there, so the panel must not be handed the
    // split action at all.
    expect(testState.latestSessionOverviewProps?.onOpenSplit).toBeUndefined();
    // And a stale capture of the action must not fold-loop a phantom split
    // into existence that growing the window would resurrect.
    await act(async () => {
      testState.latestSessionOverviewProps?.onOpenSplit?.(['s1', 's2']);
      await Promise.resolve();
    });
    await act(async () => {
      large = true;
      changeHandler?.({ matches: true });
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();
  });

  it('auto-collapses the sidebar in a narrow split and expands it when wide', async () => {
    let wide = false;
    let changeHandler: ((event: { matches: boolean }) => void) | undefined;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        get matches() {
          // Keep the large-screen (>=1024) query true so the split renders;
          // the >=1200 "sidebar has room" query is the one under test.
          if (query.includes('1200')) return wide;
          return query.includes('min-width');
        },
        media: query,
        addEventListener: (
          _type: string,
          cb: (event: { matches: boolean }) => void,
        ) => {
          if (query.includes('1200')) changeHandler = cb;
        },
        removeEventListener: vi.fn(),
      })),
    });
    window.history.replaceState(null, '', '/?split=s1,s2');

    try {
      const { container } = renderApp();
      await flush();
      const sidebar = () => container.querySelector('[data-testid="sidebar"]');
      // Narrow split (< 1200px): the sidebar collapses to free room for panes.
      expect(sidebar()?.getAttribute('data-collapsed')).toBe('true');

      // Grow past 1200px: the sidebar expands again.
      await act(async () => {
        wide = true;
        changeHandler?.({ matches: true });
        await Promise.resolve();
      });
      expect(sidebar()?.getAttribute('data-collapsed')).toBe('false');
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('lands on the first pane, not an empty new chat, when a shrink closes a URL-driven split', async () => {
    let large = true;
    let changeHandler: ((event: { matches: boolean }) => void) | undefined;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        get matches() {
          return query.includes('min-width') ? large : false;
        },
        media: query,
        addEventListener: (
          _type: string,
          cb: (event: { matches: boolean }) => void,
        ) => {
          // Capture the isLargeScreen (1024px) query specifically — not the
          // separate 1200px split-sidebar query — so flipping it drives the fold.
          if (query.includes('1024')) changeHandler = cb;
        },
        removeEventListener: vi.fn(),
      })),
    });
    // The single chat has no session of its own — the split was entered from a
    // `?split=` deep link — so a naive close would strand on an empty new chat.
    mockConnection.sessionId = undefined;
    window.history.replaceState(null, '', '/?split=s1,s2');

    try {
      const { container } = renderApp();
      await flush();
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).not.toBeNull();

      await act(async () => {
        large = false;
        changeHandler?.({ matches: false });
        await Promise.resolve();
      });

      // The split folds back to chat and re-attaches to the first pane's
      // session instead of stranding the user on an empty new chat.
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).toBeNull();
      expect(mockSessionActions.loadSession).toHaveBeenCalledWith('s1');
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('keeps the chat on its own session (does not re-point to the first pane) when a shrink closes the split', async () => {
    let large = true;
    let changeHandler: ((event: { matches: boolean }) => void) | undefined;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        get matches() {
          return query.includes('min-width') ? large : false;
        },
        media: query,
        addEventListener: (
          _type: string,
          cb: (event: { matches: boolean }) => void,
        ) => {
          if (query.includes('1024')) changeHandler = cb;
        },
        removeEventListener: vi.fn(),
      })),
    });
    // This chat HAS a session of its own — folding must leave it (and its git
    // branch / URL) untouched rather than re-pointing at the split's first pane.
    mockConnection.sessionId = 'own-session';
    window.history.replaceState(null, '', '/?split=s1,s2');

    try {
      const { container } = renderApp();
      await flush();
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).not.toBeNull();
      mockSessionActions.loadSession.mockClear();

      await act(async () => {
        large = false;
        changeHandler?.({ matches: false });
        await Promise.resolve();
      });

      // Folded back to chat, but the guard kept the existing session — no
      // re-point to the first pane.
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).toBeNull();
      expect(mockSessionActions.loadSession).not.toHaveBeenCalled();
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('keeps the Session Overview open when the screen shrinks below the breakpoint', async () => {
    // The table handles narrow widths itself, so only split view remains gated
    // by the large-screen breakpoint.
    let large = true;
    let changeHandler: ((event: { matches: boolean }) => void) | undefined;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        get matches() {
          return query.includes('min-width') ? large : false;
        },
        media: query,
        addEventListener: (
          _type: string,
          cb: (event: { matches: boolean }) => void,
        ) => {
          if (query.includes('1024')) changeHandler = cb;
        },
        removeEventListener: vi.fn(),
      })),
    });

    const { container } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="open-sessions-overview"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();

    await act(async () => {
      large = false;
      changeHandler?.({ matches: false });
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();
  });

  it('dismisses the Scheduled Tasks page when an approval becomes pending', async () => {
    // The scheduled-tasks fullPage overlay covers the chat footer where the
    // approval renders, so an approval must close it too (like the panel).
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = '/schedule';
    await clickSubmit(container);
    await flush();
    expect(
      container.querySelector('[data-testid="scheduled-tasks-page"]'),
    ).not.toBeNull();

    await act(async () => {
      testState.blocks = [makePendingPermissionBlock()];
      rerender();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="scheduled-tasks-page"]'),
    ).toBeNull();
  });

  it('opening Daemon Status closes the Scheduled Tasks page (mutually exclusive full-pane views)', async () => {
    // Regression: both are full-pane views; the Scheduled Tasks fullPage is a
    // position:absolute overlay, so opening Daemon Status while it was up left
    // the panel rendered *behind* it — the button looked dead.
    const { container } = renderApp();
    await flush();

    testState.prompt = '/schedule';
    await clickSubmit(container);
    await flush();
    expect(
      container.querySelector('[data-testid="scheduled-tasks-page"]'),
    ).not.toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-daemon-status"]')
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="scheduled-tasks-page"]'),
    ).toBeNull();
  });

  it('opening Scheduled Tasks closes an open Settings/Status panel', async () => {
    const { container } = renderApp();
    await flush();

    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();

    testState.prompt = '/schedule';
    await clickSubmit(container);
    await flush();
    expect(
      container.querySelector('[data-testid="scheduled-tasks-page"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="inline-panel"]')).toBeNull();
  });

  it('keeps the panel open when transcript blocks carry no actionable approval', async () => {
    // Negative control: a resolved permission is not actionable, so the panel
    // must stay put (guards against an unconditional "close on any block").
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();

    await act(async () => {
      testState.blocks = [makePendingPermissionBlock({ resolved: true })];
      rerender();
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();
  });

  it('keeps the composer dormant (dialogOpen) while an approval overlay is up', async () => {
    // Regression: after the panel auto-closes for an approval, interactionBlocked
    // flips false. Unless dialogOpen also keys off the pending approval,
    // useComposerCore refocuses the composer and ToolApproval — which ignores
    // keys from editable targets — stops responding to its approval shortcuts.
    mockWorkspace.capabilities = {
      workspaceCwd: '/tmp/project',
      features: ['voice_transcribe'],
    } as typeof mockWorkspace.capabilities;
    const { rerender } = renderApp();
    await flush();
    expect(testState.latestChatEditorProps?.dialogOpen).toBe(false);
    const voiceTarget = testState.latestChatEditorProps?.voiceTarget;
    const voiceStatusRevision =
      testState.latestChatEditorProps?.voiceStatusRevision;
    expect(voiceTarget).toBeDefined();

    await act(async () => {
      testState.blocks = [makePendingPermissionBlock()];
      rerender();
      await Promise.resolve();
    });

    expect(testState.latestChatEditorProps?.dialogOpen).toBe(true);
    expect(testState.latestChatEditorProps?.disabled).toBe(true);
    expect(testState.latestChatEditorProps?.voiceTarget).toBe(voiceTarget);
    expect(testState.latestChatEditorProps?.voiceStatusRevision).toBe(
      voiceStatusRevision,
    );
  });

  it('keeps an active Voice owner stable while a normal dialog is open', async () => {
    mockWorkspace.capabilities = {
      workspaceCwd: '/tmp/project',
      features: ['voice_transcribe'],
    } as typeof mockWorkspace.capabilities;
    const { container } = renderApp();
    await flush();
    const voiceTarget = testState.latestChatEditorProps?.voiceTarget;
    expect(voiceTarget).toBeDefined();

    act(() => {
      testState.latestChatEditorProps?.onToggleShortcuts?.();
    });
    await flush();

    expect(
      container.querySelector('[data-testid="dialog-shell"]'),
    ).not.toBeNull();
    expect(testState.latestChatEditorProps?.disabled).toBe(true);
    expect(testState.latestChatEditorProps?.voiceTarget).toBe(voiceTarget);
  });

  it('dismisses an open sub-dialog (model picker) when an approval becomes pending', async () => {
    // A DialogShell sub-dialog left open would sit (backdrop) over the approval
    // overlay in the chat footer, hiding it — and, for the approval-mode picker,
    // let the user yolo-approve an unseen tool call. /model (no arg) opens the
    // picker; an approval must dismiss it.
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = '/model';
    await clickSubmit(container);
    await flush();
    expect(
      container.querySelector('[data-testid="dialog-shell"]'),
    ).not.toBeNull();

    await act(async () => {
      testState.blocks = [makePendingPermissionBlock()];
      rerender();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="dialog-shell"]')).toBeNull();
  });

  it('opens the Changes dialog for /diff and does not forward it to the agent', async () => {
    // /diff is intercepted locally — it opens the working-tree Changes dialog
    // rather than being forwarded to the daemon/agent as a prompt.
    const { container } = renderApp();
    await flush();

    testState.prompt = '/diff';
    await clickSubmit(container);
    await flush();

    expect(
      container.querySelector('[data-testid="dialog-shell"]'),
    ).not.toBeNull();
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
  });

  it('opens the Pull requests dialog for /prs when the daemon supports it', async () => {
    mockWorkspace.capabilities = {
      features: ['workspace_github_prs'],
      workspaces: [{ id: 'primary', cwd: '/workspace', primary: true }],
    } as typeof mockWorkspace.capabilities;
    const { container } = renderApp();
    await flush();

    testState.prompt = '/prs';
    await clickSubmit(container);
    await flush();

    expect(
      container.querySelector('[data-testid="dialog-shell"]'),
    ).not.toBeNull();
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
  });

  it('does not open the Pull requests dialog for /prs without the capability', async () => {
    // Default capabilities carry no features — /prs only shows a toast.
    const { container } = renderApp();
    await flush();

    testState.prompt = '/prs';
    await clickSubmit(container);
    await flush();

    expect(container.querySelector('[data-testid="dialog-shell"]')).toBeNull();
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
  });

  it('marks the approval overlay keyboard-active when it appears', async () => {
    // Focus itself is owned by ToolApproval/AskUserQuestion (covered by their
    // own tests); the app's job is to render the overlay and tell it to grab
    // focus (keyboardActive) once it's the topmost surface.
    const { rerender } = renderApp();
    await flush();

    await act(async () => {
      testState.blocks = [makePendingPermissionBlock()];
      rerender();
      await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="approval-overlay"]'),
    ).not.toBeNull();
    expect(testState.latestToolApprovalKeyboardActive).toBe(true);
  });

  it('marks the ask-user question overlay keyboard-active when it appears', async () => {
    // Symmetric to the ToolApproval case: guards against askUserOverlayVisible
    // being mis-derived (e.g. from pendingToolApproval) so the question overlay
    // would never pull focus.
    const { rerender } = renderApp();
    await flush();

    await act(async () => {
      testState.blocks = [
        makePendingPermissionBlock({ toolName: 'ask_user_question' }),
      ];
      rerender();
      await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="approval-overlay"]'),
    ).not.toBeNull();
    expect(testState.latestAskUserQuestionKeyboardActive).toBe(true);
  });

  it('routes AskUserQuestion submission errors to an error toast', async () => {
    const onToast = vi.fn();
    const { rerender } = renderApp({ onToast });
    await flush();

    await act(async () => {
      testState.blocks = [
        makePendingPermissionBlock({ toolName: 'ask_user_question' }),
      ];
      rerender({ onToast });
      await Promise.resolve();
    });

    act(() => {
      testState.latestAskUserQuestionOnError?.(
        new Error('Submit option is unavailable'),
        'Failed to submit answer',
      );
    });

    expect(onToast).toHaveBeenCalledWith(
      'error',
      'Submit option is unavailable',
    );
  });

  it('closes the panel on Escape from outside the sidebar', async () => {
    const { container } = renderApp();
    await flush();
    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();
    const panel = container.querySelector('[data-testid="inline-panel"]');
    expect(panel).not.toBeNull();

    await act(async () => {
      panel?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="inline-panel"]')).toBeNull();
  });

  it('keeps the panel open on Escape originating inside the sidebar', async () => {
    const { container } = renderApp();
    await flush();
    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();

    const sidebar = container.querySelector('[data-testid="sidebar"]');
    await act(async () => {
      sidebar?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();
  });

  it('marks the composer dormant (dialogOpen) while a panel replaces the chat', async () => {
    const { container } = renderApp();
    await flush();
    expect(testState.latestChatEditorProps?.dialogOpen).toBe(false);

    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();
    expect(testState.latestChatEditorProps?.dialogOpen).toBe(true);
  });

  it('blocks app-level shortcuts while an external modal is registered', async () => {
    const { container } = renderApp();
    await flush();
    expect(testState.latestChatEditorProps?.dialogOpen).toBe(false);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="interaction-blocker"]')
        ?.click();
      await Promise.resolve();
    });

    expect(testState.latestChatEditorProps?.dialogOpen).toBe(true);

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          key: 'l',
        }),
      );
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          key: 'y',
        }),
      );
    });

    expect(mockStore.reset).not.toHaveBeenCalled();
    expect(mockStore.dispatch).not.toHaveBeenCalled();
  });

  it('restores composer focus after an approval resolves following a panel auto-close', async () => {
    // Regression: on panel auto-close the editor focus is intentionally skipped
    // (the approval owns the keyboard); when the approval later resolves with no
    // panel to return to, focus must come back to the composer rather than being
    // orphaned on <body>.
    const { container, rerender } = renderApp();
    await flush();
    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();

    await act(async () => {
      testState.blocks = [makePendingPermissionBlock()];
      rerender();
      await Promise.resolve();
    });
    editorFocus.mockClear();

    await act(async () => {
      testState.blocks = [];
      rerender();
      await Promise.resolve();
    });
    expect(editorFocus).toHaveBeenCalled();
  });

  it('closes the panel and restores composer focus on Back button click', async () => {
    const { container } = renderApp();
    await flush();
    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();
    editorFocus.mockClear();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="panel-back"]')
        ?.click();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="inline-panel"]')).toBeNull();
    expect(editorFocus).toHaveBeenCalled();
  });

  it('closes the panel, sends /model --fast, and reloads settings on fast-model pick', async () => {
    const { container } = renderApp();
    await flush();
    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();

    // Open the fast-model picker from Settings, then pick a model.
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-fast-model"]')
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="dialog-shell"]'),
    ).not.toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="model-select"]')
        ?.click();
      await Promise.resolve();
    });
    await flush();

    expect(
      mockSessionActions.sendPrompt.mock.calls.some(
        // Workspace tab → the command carries the --project scope flag so the
        // fast-model choice persists to workspace settings, not the default.
        (c) => c[0] === '/model --fast fast-model-x --project',
      ),
    ).toBe(true);
    expect(container.querySelector('[data-testid="inline-panel"]')).toBeNull();
    expect(settingsReload).toHaveBeenCalled();
  });

  it.each([
    ['fast-model selection', ['open-fast-model', 'model-select']],
    ['settings language change', ['change-language-workspace']],
  ])(
    'shows the Goal-specific rejection for a blocked %s',
    async (_label, actions) => {
      const onToast = vi.fn();
      mockConnection.goalState = activeGoalSnapshot('keep working');
      const { container } = renderApp({ onToast });
      await flush();
      testState.prompt = '/settings';
      await clickSubmit(container);
      await flush();

      for (const action of actions) {
        await act(async () => {
          container
            .querySelector<HTMLButtonElement>(`[data-testid="${action}"]`)
            ?.click();
          await Promise.resolve();
        });
      }

      expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
      expect(onToast).toHaveBeenCalledWith(
        'error',
        'Slash commands are unavailable while a Goal owns the session or its state is loading.',
      );
    },
  );

  it.each([
    ['fast-model selection', ['open-fast-model', 'model-select']],
    ['settings language change', ['change-language-workspace']],
  ])(
    'blocks %s before the first stream event reaches the client',
    async (_label, actions) => {
      const onToast = vi.fn();
      testState.sessionHasActivePrompt = true;
      const { container } = renderApp({ onToast });
      await flush();
      testState.prompt = '/settings';
      await clickSubmit(container);
      await flush();

      for (const action of actions) {
        await act(async () => {
          container
            .querySelector<HTMLButtonElement>(`[data-testid="${action}"]`)
            ?.click();
          await Promise.resolve();
        });
      }

      expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
      expect(onToast).toHaveBeenCalledWith(
        'error',
        "Slash commands can't be queued while a turn is running.",
      );
    },
  );

  it('clears model selection busy state after a same-session reattach', async () => {
    const selection = deferred<void>();
    mockSessionActions.setModel.mockReturnValueOnce(selection.promise);
    const { container, rerender } = renderApp();
    await flush();
    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();

    act(() => testState.latestModelManagement?.onSelectModel?.('qwen-next'));
    expect(testState.latestModelManagement?.busy).toBe(true);

    act(() => {
      testState.ownerVersion += 1;
      rerender();
    });
    await act(async () => {
      selection.resolve();
      await selection.promise;
    });

    expect(testState.latestModelManagement?.busy).toBe(false);
  });

  it('does not let an A-to-B-to-A model completion clear a newer selection', async () => {
    const firstSelection = deferred<void>();
    const secondSelection = deferred<void>();
    mockSessionActions.setModel
      .mockReturnValueOnce(firstSelection.promise)
      .mockReturnValueOnce(secondSelection.promise);
    const { container, rerender } = renderApp();
    await flush();
    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();
    act(() => testState.latestModelManagement?.onSelectModel?.('model-a'));

    act(() => {
      testState.ownerVersion += 1;
      mockConnection.sessionId = 'session-2';
      rerender();
    });
    await flush();
    act(() => {
      testState.ownerVersion += 1;
      mockConnection.sessionId = 'session-1';
      rerender();
    });
    await flush();

    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();
    act(() => testState.latestModelManagement?.onSelectModel?.('model-b'));
    expect(testState.latestModelManagement?.busy).toBe(true);

    await act(async () => {
      firstSelection.resolve();
      await firstSelection.promise;
    });
    expect(testState.latestModelManagement?.busy).toBe(true);

    await act(async () => {
      secondSelection.resolve();
      await secondSelection.promise;
    });
    expect(testState.latestModelManagement?.busy).toBe(false);
  });

  it('does not let an A-to-B-to-A deletion affect the newer owner', async () => {
    const deletion = deferred<{
      removed: true;
      runtimeSync: { status: 'failed' };
    }>();
    const selection = deferred<void>();
    mockWorkspaceActions.deleteModel.mockReturnValueOnce(deletion.promise);
    mockSessionActions.setModel.mockReturnValueOnce(selection.promise);
    const { container, rerender } = renderApp();
    await flush();
    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();
    act(() =>
      testState.latestModelManagement?.onDeleteModel?.({
        authType: 'api-key',
        modelId: 'old-model',
      }),
    );

    act(() => {
      testState.ownerVersion += 1;
      mockConnection.sessionId = 'session-2';
      rerender();
    });
    await flush();
    act(() => {
      testState.ownerVersion += 1;
      mockConnection.sessionId = 'session-1';
      rerender();
    });
    await flush();

    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();
    act(() => testState.latestModelManagement?.onSelectModel?.('model-b'));
    expect(testState.latestModelManagement?.busy).toBe(true);

    await act(async () => {
      deletion.resolve({
        removed: true,
        runtimeSync: { status: 'failed' },
      });
      await deletion.promise;
    });
    expect(testState.latestModelManagement?.busy).toBe(true);
    expect(mockStore.dispatch).not.toHaveBeenCalledWith([
      {
        type: 'status',
        text: 'The change was saved, but running sessions could not be refreshed. Restart qwen serve before using the updated model list.',
      },
    ]);

    await act(async () => {
      selection.resolve();
      await selection.promise;
    });
    expect(testState.latestModelManagement?.busy).toBe(false);
  });

  it('warns when a deleted model was saved but runtime sync failed', async () => {
    mockWorkspaceActions.deleteModel.mockResolvedValueOnce({
      removed: true,
      runtimeSync: { status: 'failed' },
    });
    const { container } = renderApp();
    await flush();
    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();

    await act(async () => {
      testState.latestModelManagement?.onDeleteModel?.({
        authType: 'api-key',
        modelId: 'old-model',
      });
      await Promise.resolve();
    });

    expect(mockStore.dispatch).toHaveBeenCalledWith([
      {
        type: 'status',
        text: 'The change was saved, but running sessions could not be refreshed. Restart qwen serve before using the updated model list.',
      },
    ]);
  });

  it('does not publish stale deletion warnings into a replacement session', async () => {
    const deletion = deferred<{
      removed: true;
      requiresRestart: true;
      runtimeSync: { status: 'failed' };
    }>();
    mockWorkspaceActions.deleteModel.mockReturnValueOnce(deletion.promise);
    const { container, rerender } = renderApp();
    await flush();
    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();
    act(() =>
      testState.latestModelManagement?.onDeleteModel?.({
        authType: 'api-key',
        modelId: 'old-model',
      }),
    );

    act(() => {
      testState.ownerVersion += 1;
      mockConnection.sessionId = 'session-2';
      rerender();
    });
    await flush();
    await act(async () => {
      deletion.resolve({
        removed: true,
        requiresRestart: true,
        runtimeSync: { status: 'failed' },
      });
      await deletion.promise;
    });

    expect(mockStore.dispatch).not.toHaveBeenCalledWith([
      {
        type: 'status',
        text: 'The change was saved, but running sessions could not be refreshed. Restart qwen serve before using the updated model list.',
      },
    ]);
    expect(mockStore.dispatch).not.toHaveBeenCalledWith([
      {
        type: 'status',
        text: 'This change requires a restart to take effect.',
      },
    ]);
  });

  it('does not report a stale deletion error in a replacement session', async () => {
    const deletion = deferred<never>();
    mockWorkspaceActions.deleteModel.mockReturnValueOnce(deletion.promise);
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const { container, rerender } = renderApp();
    await flush();
    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();
    act(() =>
      testState.latestModelManagement?.onDeleteModel?.({
        authType: 'api-key',
        modelId: 'old-model',
      }),
    );

    act(() => {
      testState.ownerVersion += 1;
      mockConnection.sessionId = 'session-2';
      rerender();
    });
    await flush();
    await act(async () => {
      deletion.reject(new Error('delete failed'));
      await deletion.promise.catch(() => undefined);
    });

    expect(consoleError).not.toHaveBeenCalledWith(
      '[web-shell]',
      expect.stringContaining('delete failed'),
      expect.anything(),
    );
    consoleError.mockRestore();
  });

  it('sends /model --fast with --global when the fast-model picker is opened from the User tab', async () => {
    const { container } = renderApp();
    await flush();
    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="open-fast-model-user"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="model-select"]')
        ?.click();
      await Promise.resolve();
    });
    await flush();

    expect(
      mockSessionActions.sendPrompt.mock.calls.some(
        (c) => c[0] === '/model --fast fast-model-x --global',
      ),
    ).toBe(true);
  });

  it('keeps a secondary Voice user-scope write on the shared legacy setting route', async () => {
    mockConnection.workspaceCwd = '/work/secondary';
    mockWorkspace.capabilities = {
      workspaceCwd: '/work/primary',
      features: [
        'workspace_qualified_voice',
        'workspace_qualified_rest_core',
        'workspace_settings',
      ],
      workspaces: [
        {
          id: 'primary',
          cwd: '/work/primary',
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary',
          cwd: '/work/secondary',
          primary: false,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const { container } = renderApp();
    await flush();
    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="open-voice-model-user"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="model-select"]')
        ?.click();
      await Promise.resolve();
    });
    await flush();

    expect(settingsSetValue).toHaveBeenCalledWith(
      'user',
      'voiceModel',
      'fast-model-x',
    );
    expect(qualifiedSetWorkspaceSetting).not.toHaveBeenCalled();
  });

  it('sends /language ui --project for a workspace-scoped language change from Settings', async () => {
    const { container } = renderApp();
    await flush();
    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="change-language-workspace"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await flush();

    expect(
      mockSessionActions.sendPrompt.mock.calls.some(
        (c) => c[0] === '/language ui en --project',
      ),
    ).toBe(true);
  });

  it('resynchronizes the catalog when a settings prompt admission is ambiguous', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const lostResponse = deferred<void>();
    mockSessionActions.sendPrompt.mockImplementationOnce((_text, options) => {
      options?.onAdmissionStarted?.();
      return lostResponse.promise;
    });
    const { container } = renderApp();
    await flush();
    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="change-language-workspace"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.sendPrompt).toHaveBeenCalledOnce();
    });

    await act(async () => {
      lostResponse.reject(new Error('response lost after admission started'));
      await Promise.resolve();
    });

    expect(
      sessionCatalogController.promptAdmissionUncertain,
    ).toHaveBeenCalledOnce();
    expect(
      sessionCatalogController.promptAdmissionUncertain,
    ).toHaveBeenCalledWith('/tmp/project');
  });

  it('marks the chat view aria-hidden while a panel is shown', async () => {
    const { container } = renderApp();
    await flush();
    expect(
      container
        .querySelector('[data-testid="submit"]')
        ?.closest('[aria-hidden="true"]'),
    ).toBeNull();

    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();
    expect(
      container
        .querySelector('[data-testid="submit"]')
        ?.closest('[aria-hidden="true"]'),
    ).not.toBeNull();
  });

  it('closes an open panel when resuming a session via /resume', async () => {
    // Resuming a session must surface that chat, not leave it hidden behind an
    // open Settings/Status panel — mirrors createNewSession / loadSidebarSession.
    const { container } = renderApp();
    await flush();

    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();

    testState.prompt = '/resume session-2';
    await clickSubmit(container);
    await flush();

    expect(container.querySelector('[data-testid="inline-panel"]')).toBeNull();
    expect(mockSessionActions.loadSession).toHaveBeenCalledWith('session-2', {
      workspaceCwd: undefined,
    });
  });

  it('dispatches rename only after the current session name changes', async () => {
    const onSessionChange = vi.fn();
    const { rerender } = renderApp({ onSessionChange });
    await flush();

    expect(onSessionChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'rename' }),
    );

    act(() => {
      mockConnection.displayName = 'Renamed Session';
      rerender({ onSessionChange });
    });

    expect(onSessionChange).toHaveBeenCalledWith({
      type: 'rename',
      sessionId: 'session-1',
      newName: 'Renamed Session',
    });
    expect(sessionCatalogController.renamed).toHaveBeenCalledWith(
      '/tmp/project',
      'session-1',
      'Renamed Session',
    );

    onSessionChange.mockClear();
    act(() => {
      rerender({ onSessionChange });
    });
    expect(onSessionChange).not.toHaveBeenCalled();
  });

  it('does not report an existing title loaded during a session switch as a rename', async () => {
    const onSessionChange = vi.fn();
    const { rerender } = renderApp({ onSessionChange });
    await flush();

    act(() => {
      mockConnection.sessionId = 'session-2';
      mockConnection.displayName = undefined;
      rerender({ onSessionChange });
    });
    act(() => {
      mockConnection.displayName = 'Existing Session';
      rerender({ onSessionChange });
    });

    expect(sessionCatalogController.renamed).not.toHaveBeenCalled();
    expect(onSessionChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'rename' }),
    );
  });

  it('does not report an existing title when the same session id changes workspace', async () => {
    const onSessionChange = vi.fn();
    const { rerender } = renderApp({ onSessionChange });
    await flush();

    act(() => {
      mockConnection.workspaceCwd = '/tmp/other';
      mockConnection.displayName = 'Existing Other Session';
      rerender({ onSessionChange });
    });

    expect(sessionCatalogController.renamed).not.toHaveBeenCalled();
    expect(onSessionChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'rename' }),
    );
  });

  it('handles a rename event before the session workspace is known', async () => {
    mockConnection.workspaceCwd = undefined;
    const onSessionChange = vi.fn();
    const { rerender } = renderApp({ onSessionChange });
    await flush();

    act(() => {
      mockConnection.displayName = 'Renamed before workspace';
      rerender({ onSessionChange });
    });

    expect(sessionCatalogController.renamed).not.toHaveBeenCalled();
    expect(onSessionChange).toHaveBeenCalledWith({
      type: 'rename',
      sessionId: 'session-1',
      newName: 'Renamed before workspace',
    });
  });

  it('patches and resynchronizes the catalog after a confirmed /rename', async () => {
    const onSessionChange = vi.fn();
    const { container, rerender } = renderApp({ onSessionChange });
    await flush();

    testState.prompt = '/rename Catalog title';
    await clickSubmit(container);
    await flush();

    expect(mockSessionActions.renameSession).toHaveBeenCalledWith(
      'Catalog title',
    );
    expect(sessionCatalogController.renamed).toHaveBeenCalledWith(
      '/tmp/project',
      'session-1',
      'Catalog title',
    );
    expect(onSessionChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'rename' }),
    );

    act(() => {
      mockConnection.displayName = 'Catalog title';
      rerender({ onSessionChange });
    });
    expect(sessionCatalogController.renamed).toHaveBeenCalledTimes(1);
    expect(onSessionChange).toHaveBeenCalledWith({
      type: 'rename',
      sessionId: 'session-1',
      newName: 'Catalog title',
    });
  });

  it('uses the exact standalone route for /rename in a standalone chat', async () => {
    mockConnection.sessionContext = { kind: 'standalone' };
    mockConnection.workspaceCwd = '';
    mockConnection.displayName = 'Old standalone title';
    mockWorkspace.capabilities = {
      features: ['standalone_sessions_v1'],
      workspaces: [{ id: 'primary', cwd: '/workspace', primary: true }],
    } as typeof mockWorkspace.capabilities;
    const { container } = renderApp();
    await flush();

    testState.prompt = '/rename Standalone title';
    await clickSubmit(container);
    await flush();

    expect(mockWorkspace.client.renameStandaloneSession).toHaveBeenCalledWith(
      'session-1',
      'Standalone title',
    );
    expect(mockSessionActions.renameSession).not.toHaveBeenCalled();
    expect(testState.latestChatEditorProps?.sessionName).toBe(
      'Standalone title',
    );
  });

  it('rejects programmatic attachments in a standalone chat', async () => {
    mockConnection.sessionContext = { kind: 'standalone' };
    mockConnection.workspaceCwd = '';
    const onToast = vi.fn();
    renderApp({ onToast });
    await flush();

    let accepted: boolean | void;
    act(() => {
      accepted = testState.latestChatEditorProps?.onSubmit('hello', [
        { data: 'image-data', media_type: 'image/png' },
      ]);
    });

    expect(accepted).toBe(false);
    expect(rawEnqueuePrompt).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenCalledWith('warning', expect.any(String));
  });

  it('does not dispatch workspace management commands in a standalone chat', async () => {
    mockConnection.sessionContext = { kind: 'standalone' };
    mockConnection.workspaceCwd = '';
    const onToast = vi.fn();
    const { container } = renderApp({ onToast });
    await flush();

    expect(testState.latestSettingsHookOptions).toEqual({
      autoLoad: false,
      enabled: false,
    });
    expect(testState.latestProvidersHookOptions).toEqual({
      autoLoad: false,
      enabled: false,
    });
    expect(testState.latestChatEditorProps).toMatchObject({
      builtinAtProviders: false,
      composerScopeKey: 'standalone',
      workspaceFeaturesEnabled: false,
    });
    expect(testState.latestStatusBarHideSettings).toBe(true);

    for (const command of [
      '/mcp',
      '/skills',
      '/tools',
      '/agents',
      '/extensions manage',
      '/goal',
      '/model --vision qwen-vl',
      '/resume',
      '/delete',
      '/release',
    ]) {
      act(() => {
        expect(testState.latestChatEditorProps?.onSubmit(command)).toBe(true);
      });
    }
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="change-sidebar-theme"]',
        )
        ?.click();
    });
    act(() => {
      expect(testState.latestChatEditorProps?.onSubmit('/status')).toBe(true);
    });
    await flush();

    expect(mockWorkspaceActions.loadMcpStatus).not.toHaveBeenCalled();
    expect(mockWorkspaceActions.loadPreflight).not.toHaveBeenCalled();
    expect(mockWorkspaceActions.loadProviders).not.toHaveBeenCalled();
    expect(mockWorkspaceActions.loadEnv).not.toHaveBeenCalled();
    expect(settingsSetValue).not.toHaveBeenCalled();
    expect(mockSessionActions.loadSession).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenCalledTimes(10);
  });

  it('allows ordinary shell commands in a standalone chat', async () => {
    mockConnection.sessionContext = { kind: 'standalone' };
    mockConnection.workspaceCwd = '';
    renderApp();
    await flush();

    act(() => {
      expect(testState.latestChatEditorProps?.onSubmit('!pwd')).toBe(true);
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.sendShellCommand).toHaveBeenCalledWith('pwd');
    });

    expect(sessionCatalogController.invalidateWorkspace).not.toHaveBeenCalled();
  });

  it('routes an exact /resume through the standalone context', async () => {
    mockConnection.sessionContext = { kind: 'standalone' };
    mockConnection.workspaceCwd = '';
    renderApp();
    await flush();

    act(() => {
      expect(
        testState.latestChatEditorProps?.onSubmit(
          '/resume standalone-session-2',
        ),
      ).toBe(true);
    });
    await flush();

    expect(mockSessionActions.loadSession).toHaveBeenCalledWith(
      'standalone-session-2',
      {
        workspaceCwd: undefined,
        sessionContext: { kind: 'standalone' },
      },
    );
  });

  it('routes /new through the existing Live-specific path', async () => {
    mockConnection.sessionContext = { kind: 'live' };
    mockConnection.workspaceCwd = '';
    renderApp();
    await flush();

    act(() => {
      expect(testState.latestChatEditorProps?.onSubmit('/new')).toBe(true);
    });
    await flush();

    expect(mockWorkspace.client.startLive).toHaveBeenCalledOnce();
    expect(mockWorkspace.client.startLive).toHaveBeenCalledWith('new');
    expect(mockSessionActions.clearSession).not.toHaveBeenCalled();
  });

  it('keeps a legacy Live runtime cwd out of workspace product context', async () => {
    mockConnection.sessionContext = undefined;
    mockConnection.workspaceCwd = '/internal/conversations';
    mockWorkspace.capabilities = {
      workspaceCwd: '/workspace',
      workspaces: [
        {
          id: 'primary',
          cwd: '/workspace',
          primary: true,
          trusted: true,
        },
        {
          id: 'live',
          cwd: '/internal/conversations',
          primary: false,
          trusted: true,
          kind: 'live',
        },
      ],
    } as typeof mockWorkspace.capabilities;

    renderApp();
    await flush();

    expect(testState.latestChatEditorProps).toMatchObject({
      atWorkspaceCwd: undefined,
      composerScopeKey: 'live',
      workspaceFeaturesEnabled: false,
    });
    expect(testState.latestSettingsHookOptions).toEqual({
      autoLoad: false,
      enabled: false,
    });
    expect(testState.latestProvidersHookOptions).toEqual({
      autoLoad: false,
      enabled: false,
    });
  });

  it('creates an explicit standalone draft without workspace-only fields', async () => {
    mockConnection.sessionId = undefined;
    mockConnection.sessionContext = { kind: 'standalone' };
    mockConnection.workspaceCwd = '';
    mockWorkspace.capabilities = {
      features: ['standalone_sessions_v1'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/workspace',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    renderApp();
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('first standalone prompt');
      await vi.waitFor(() => {
        expect(mockSessionActions.createSession).toHaveBeenCalledOnce();
      });
    });

    expect(mockSessionActions.createSession).toHaveBeenCalledWith({
      sessionContext: { kind: 'standalone' },
      approvalMode: 'default',
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
        'first standalone prompt',
        expect.any(Object),
      );
    });
  });

  it('ignores a stale standalone unarchive result after navigation', async () => {
    const sourceSessionId = 'standalone-recovery-source';
    const nextSessionId = 'standalone-recovery-next';
    const unarchive = deferred<{
      unarchived: string[];
      alreadyActive: string[];
      notFound: string[];
      errors: Array<{ sessionId: string; message: string }>;
    }>();
    mockConnection.sessionId = sourceSessionId;
    mockConnection.sessionContext = { kind: 'standalone' };
    mockConnection.workspaceCwd = '';
    mockConnection.standaloneSession = {
      creationRecovery: { state: 'creating', sessionId: sourceSessionId },
    };
    mockWorkspace.capabilities = {
      features: ['standalone_sessions_v1'],
      workspaces: [{ id: 'primary', cwd: '/workspace', primary: true }],
    } as typeof mockWorkspace.capabilities;
    mockWorkspace.client.getStandaloneSession.mockResolvedValue({
      sessionId: sourceSessionId,
      sourceType: 'standalone',
      context: { kind: 'standalone' },
      isArchived: true,
    });
    mockWorkspace.client.unarchiveStandaloneSessions.mockReturnValueOnce(
      unarchive.promise,
    );
    const { container, rerender } = renderApp();
    await flush();

    const buttonNamed = (label: string) =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.trim() === label,
      );
    await act(async () => {
      buttonNamed('Check status')?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(buttonNamed('Unarchive')).toBeDefined();
    });
    act(() => buttonNamed('Unarchive')?.click());
    expect(
      mockWorkspace.client.unarchiveStandaloneSessions,
    ).toHaveBeenCalledWith([sourceSessionId]);

    act(() => {
      testState.ownerVersion += 1;
      mockConnection.sessionId = nextSessionId;
      mockConnection.standaloneSession = {
        creationRecovery: { state: 'creating', sessionId: nextSessionId },
      };
      rerender();
    });
    await flush();
    await act(async () => {
      unarchive.resolve({
        unarchived: [],
        alreadyActive: [],
        notFound: [sourceSessionId],
        errors: [],
      });
      await unarchive.promise;
    });

    expect(container.textContent).toContain('Creation may have succeeded');
    expect(container.textContent).not.toContain(
      'No conversation exists for the reserved ID',
    );
  });

  it('reports a recovered standalone load failure without reverting to archived', async () => {
    const sessionId = 'standalone-recovery-source';
    mockConnection.sessionId = sessionId;
    mockConnection.sessionContext = { kind: 'standalone' };
    mockConnection.workspaceCwd = '';
    mockConnection.standaloneSession = {
      creationRecovery: { state: 'creating', sessionId },
    };
    mockWorkspace.capabilities = {
      features: ['standalone_sessions_v1'],
      workspaces: [{ id: 'primary', cwd: '/workspace', primary: true }],
    } as typeof mockWorkspace.capabilities;
    mockWorkspace.client.getStandaloneSession.mockResolvedValue({
      sessionId,
      sourceType: 'standalone',
      context: { kind: 'standalone' },
      isArchived: true,
    });
    mockWorkspace.client.unarchiveStandaloneSessions.mockResolvedValue({
      unarchived: [sessionId],
      alreadyActive: [],
      notFound: [],
      errors: [],
    });
    mockSessionActions.loadSession.mockRejectedValue(new Error('load failed'));
    const onToast = vi.fn();
    const { container } = renderApp({ onToast });
    await flush();
    const buttonNamed = (label: string) =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.trim() === label,
      );
    await act(async () => buttonNamed('Check status')?.click());
    await vi.waitFor(() => expect(buttonNamed('Unarchive')).toBeDefined());

    await act(async () => buttonNamed('Unarchive')?.click());

    expect(container.textContent).not.toContain(
      'The recovered conversation is archived',
    );
    expect(onToast).toHaveBeenCalledWith('error', 'load failed');
    expect(onToast).not.toHaveBeenCalledWith(
      'error',
      expect.stringContaining('Failed to unarchive'),
    );
  });

  it('re-enables standalone directory repair after reload replaces the owner', async () => {
    mockConnection.sessionContext = { kind: 'standalone' };
    mockConnection.workspaceCwd = '';
    mockConnection.standaloneSession = {
      errorCode: 'working_directory_missing',
    };
    mockSessionActions.reloadSession.mockImplementationOnce(async () => {
      testState.ownerVersion += 1;
    });
    const onToast = vi.fn();
    const { container } = renderApp({ onToast });
    await flush();
    const repairButton = () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.trim() === 'Repair directory',
      );

    await act(async () => repairButton()?.click());

    expect(
      mockWorkspace.client.repairStandaloneSessionDirectory,
    ).toHaveBeenCalledWith('session-1');
    expect(repairButton()).toBeDefined();
    expect(repairButton()?.disabled).toBe(false);
    expect(onToast).toHaveBeenCalledWith(
      'info',
      'The private working directory was repaired.',
    );
  });

  it('reconciles a confirmed rename after its source attachment is replaced', async () => {
    const rename = deferred<void>();
    mockSessionActions.renameSession.mockReturnValueOnce(rename.promise);
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = '/rename Delayed title';
    await clickSubmit(container);
    await vi.waitFor(() => {
      expect(mockSessionActions.renameSession).toHaveBeenCalledWith(
        'Delayed title',
      );
    });

    act(() => {
      testState.ownerVersion += 1;
      mockConnection.sessionId = 'session-2';
      mockConnection.workspaceCwd = '/tmp/other';
      rerender();
    });
    sessionCatalogController.renamed.mockClear();

    await act(async () => {
      rename.resolve();
      await rename.promise;
    });

    expect(sessionCatalogController.renamed).toHaveBeenCalledWith(
      '/tmp/project',
      'session-1',
      'Delayed title',
    );
  });

  it('reconciles a name reused after the session loaded a different title', async () => {
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = '/rename Reused title';
    await clickSubmit(container);
    await flush();

    act(() => {
      mockConnection.sessionId = 'session-2';
      mockConnection.displayName = 'Other session';
      rerender();
    });
    act(() => {
      mockConnection.sessionId = 'session-1';
      mockConnection.displayName = 'Externally renamed';
      rerender();
    });
    sessionCatalogController.renamed.mockClear();

    testState.prompt = '/rename Reused title';
    await clickSubmit(container);
    await flush();

    expect(sessionCatalogController.renamed).toHaveBeenCalledWith(
      '/tmp/project',
      'session-1',
      'Reused title',
    );
  });
});

describe('App prompt send failure retry', () => {
  it('does not mark delivery unknown when lazy session creation fails before prompt admission', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockConnection.sessionId = undefined;
    mockSessionActions.createSession.mockRejectedValueOnce(
      new Error('session creation failed'),
    );
    renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit(
        'hello',
        undefined,
        undefined,
        editorCommit,
      );
    });
    await flush();

    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(editorCommit).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="prompt-admission-unknown"]'),
    ).toBeNull();
    expect(testState.latestChatEditorProps?.disabled).toBe(false);
  });

  it('keeps an unknown lazy-session admission scoped to its allocated session', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockConnection.sessionId = undefined;
    mockSessionActions.createSession.mockImplementationOnce(async () => {
      testState.ownerVersion += 1;
      return { sessionId: 'session-created' };
    });
    const firstSend = deferred<void>();
    mockSessionActions.sendPrompt.mockReturnValueOnce(firstSend.promise);
    const { rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit(
        'hello',
        undefined,
        undefined,
        editorCommit,
      );
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.sendPrompt).toHaveBeenCalledOnce();
    });
    const firstSendOptions = mockSessionActions.sendPrompt.mock.calls[0]?.[1];
    act(() => {
      firstSendOptions?.onAdmissionStarted?.();
      mockConnection.sessionId = 'session-created';
      rerender();
    });
    await act(async () => {
      firstSend.reject(new Error('connection closed before response'));
      await Promise.resolve();
    });

    expect(editorCommit).toHaveBeenCalledOnce();
    expect(
      document.querySelector('[data-testid="prompt-admission-unknown"]'),
    ).not.toBeNull();
    expect(
      sessionCatalogController.promptAdmissionUncertain,
    ).toHaveBeenCalledWith('/workspace');
  });

  it('locks duplicate submission when prompt admission is unknown', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const firstSend = deferred<void>();
    mockSessionActions.sendPrompt.mockImplementationOnce((_text, options) => {
      options?.onAdmissionStarted?.();
      return firstSend.promise;
    });
    const { rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('hello');
    });
    await act(async () => {
      firstSend.reject(new Error('connection closed before response'));
      await Promise.resolve();
    });

    const notice = document.querySelector(
      '[data-testid="prompt-admission-unknown"]',
    );
    expect(notice).not.toBeNull();
    expect(
      document.querySelector('[data-testid="failed-prompt-retry"]'),
    ).toBeNull();
    expect(testState.latestChatEditorProps?.disabled).toBe(true);

    act(() => {
      testState.streamingState = 'responding';
      rerender();
    });
    expect(
      document.querySelector('[data-testid="prompt-admission-unknown"]'),
    ).not.toBeNull();
    expect(testState.latestChatEditorProps?.disabled).toBe(true);

    act(() => {
      notice?.querySelectorAll('button').item(1).click();
    });

    expect(testState.latestChatEditorProps?.disabled).toBe(false);
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector('[data-testid="prompt-admission-unknown"]'),
    ).not.toBeNull();
  });

  it('restores direct prompt annotations after uncertain admission', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const firstSend = deferred<void>();
    mockSessionActions.sendPrompt.mockImplementationOnce((_text, options) => {
      options?.onAdmissionStarted?.();
      return firstSend.promise;
    });
    const inputAnnotations: DaemonInputAnnotation[] = [
      {
        type: 'reference',
        start: 0,
        end: 8,
        text: '@file.ts',
        reference: { id: 'file:file.ts', kind: 'file', value: 'file.ts' },
      },
    ];
    renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit(
        '@file.ts fix',
        undefined,
        undefined,
        editorCommit,
        { inputAnnotations },
      );
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.sendPrompt).toHaveBeenCalledOnce();
    });
    await act(async () => {
      firstSend.reject(new Error('response lost'));
      await Promise.resolve();
    });
    act(() => {
      document
        .querySelector('[data-testid="prompt-admission-unknown"]')
        ?.querySelectorAll('button')
        .item(0)
        .click();
    });

    expect(editorRestoreInputAnnotations).toHaveBeenCalledWith(
      inputAnnotations,
    );
    confirm.mockRestore();
    warn.mockRestore();
  });

  it('reuses the first prepared payload without preparing retry again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const firstSend = deferred<void>();
    const inputAnnotations: DaemonInputAnnotation[] = [
      {
        type: 'reference',
        start: 0,
        end: 8,
        text: 'resolved',
        reference: { id: 'resolved', kind: 'file' },
      },
    ];
    const prepareSubmit = vi.fn().mockResolvedValueOnce({
      prompt: 'resolved',
      inputAnnotations,
    });
    const onSubmitBefore = vi.fn().mockResolvedValue(undefined);
    mockSessionActions.sendPrompt.mockImplementationOnce(() => {
      testState.blocks = [{ id: 'u1', kind: 'user' }];
      return firstSend.promise;
    });
    const { container } = renderApp({ prepareSubmit, onSubmitBefore });
    await flush();

    await clickSubmit(container);
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      'resolved',
      expect.objectContaining({ inputAnnotations }),
    );
    testState.messages = [{ id: 'u1', role: 'user', content: 'resolved' }];
    await act(async () => {
      firstSend.reject(new DaemonHttpError(413, {}, 'Prompt too large'));
      await Promise.resolve();
    });

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="failed-prompt-retry"]')
        ?.click();
      await Promise.resolve();
    });

    expect(prepareSubmit).toHaveBeenCalledOnce();
    expect(prepareSubmit).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: 'hello',
      inputAnnotations: [],
    });
    expect(onSubmitBefore).toHaveBeenNthCalledWith(1, {
      sessionId: 'session-1',
      prompt: 'resolved',
    });
    expect(onSubmitBefore).toHaveBeenNthCalledWith(2, {
      sessionId: 'session-1',
      prompt: 'resolved',
    });
    expect(mockSessionActions.sendPrompt).toHaveBeenLastCalledWith(
      'resolved',
      expect.objectContaining({
        inputAnnotations,
        optimisticUserMessage: false,
      }),
    );
  });

  it('marks and retries a failed prompt while an active Goal is known', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockConnection.goalState = activeGoalSnapshot('keep working');
    const firstSend = deferred<void>();
    mockSessionActions.sendPrompt.mockImplementationOnce(() => {
      testState.blocks = [{ id: 'u1', kind: 'user' }];
      return firstSend.promise;
    });
    const inputAnnotations = [
      {
        type: 'reference',
        start: 0,
        end: 5,
        text: 'hello',
        reference: { id: 'file:hello', kind: 'file', value: 'hello' },
      },
    ] as DaemonInputAnnotation[];
    const images = [{ data: 'aGVsbG8=', media_type: 'image/png' }];
    const { rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit(
        'hello',
        images,
        undefined,
        editorCommit,
        {
          inputAnnotations,
        },
      );
    });
    testState.messages = [{ id: 'u1', role: 'user', content: 'hello' }];
    await act(async () => {
      firstSend.reject(new DaemonHttpError(413, {}, 'Prompt too large'));
      await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="failed-prompt-retry"]')
        ?.textContent,
    ).toBe('u1');

    const staleRetry = testState.latestMessageListProps?.onRetryFailedPrompt;
    act(() => {
      testState.sessionHasActivePrompt = true;
      rerender();
    });
    expect(
      document.querySelector('[data-testid="failed-prompt-retry"]'),
    ).toBeNull();
    act(() => staleRetry?.());
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(1);
    act(() => {
      testState.sessionHasActivePrompt = false;
      rerender();
    });

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="failed-prompt-retry"]')
        ?.click();
      await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="failed-prompt-retry"]'),
    ).toBeNull();
    expect(mockSessionActions.sendPrompt).toHaveBeenLastCalledWith(
      'hello',
      expect.objectContaining({
        images,
        inputAnnotations,
        optimisticUserMessage: false,
      }),
    );
  });

  it('retries a rejected failed prompt with its file attachment intact', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const firstSend = deferred<void>();
    mockSessionActions.sendPrompt.mockImplementationOnce(() => {
      testState.blocks = [{ id: 'u1', kind: 'user' }];
      return firstSend.promise;
    });
    const files = [
      { name: 'app.log', media_type: 'text/plain', text: 'SECRET=1' },
    ];
    renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit(
        'hello',
        undefined,
        files,
        editorCommit,
      );
    });
    testState.messages = [{ id: 'u1', role: 'user', content: 'hello' }];
    await act(async () => {
      firstSend.reject(new DaemonHttpError(413, {}, 'Prompt too large'));
      await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="failed-prompt-retry"]')
        ?.textContent,
    ).toBe('u1');

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="failed-prompt-retry"]')
        ?.click();
      await Promise.resolve();
    });

    expect(mockSessionActions.sendPrompt).toHaveBeenLastCalledWith(
      'hello',
      expect.objectContaining({
        files: [
          expect.objectContaining({
            name: 'app.log',
            media_type: 'text/plain',
            text: 'SECRET=1',
          }),
        ],
        optimisticUserMessage: false,
      }),
    );
  });

  it('does not resend a failed-prompt retry with daemon retry semantics', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const prepareSubmit = vi.fn().mockResolvedValue({
      prompt: 'prepared hello',
      inputAnnotations: [],
    });
    const firstSend = deferred<void>();
    mockSessionActions.sendPrompt.mockImplementationOnce(() => {
      testState.blocks = [{ id: 'u1', kind: 'user' }];
      return firstSend.promise;
    });
    renderApp({ prepareSubmit });
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('hello');
    });
    testState.messages = [
      { id: 'u1', role: 'user', content: 'prepared hello' },
    ];
    await act(async () => {
      firstSend.reject(new DaemonHttpError(413, {}, 'Prompt too large'));
      await Promise.resolve();
    });

    expect(prepareSubmit).toHaveBeenCalledOnce();
    expect(
      document.querySelector('[data-testid="failed-prompt-retry"]'),
    ).not.toBeNull();

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="failed-prompt-retry"]')
        ?.click();
      await Promise.resolve();
    });

    // The failed prompt was never admitted, so no user-message record exists
    // for it; daemon retry semantics skip that record and would drop the
    // turn's user message from the transcript. The retry must reuse the
    // prepared payload without forwarding `retry` to the daemon.
    expect(prepareSubmit).toHaveBeenCalledOnce();
    expect(mockSessionActions.sendPrompt).toHaveBeenLastCalledWith(
      'prepared hello',
      expect.objectContaining({
        optimisticUserMessage: false,
        retry: undefined,
      }),
    );
  });

  it('keeps a failed-prompt retry visible through background notifications', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const firstSend = deferred<void>();
    mockSessionActions.sendPrompt.mockImplementationOnce(() => {
      testState.blocks = [{ id: 'u1', kind: 'user', text: 'hello' }];
      return firstSend.promise;
    });
    const { container, rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('hello');
    });
    testState.messages = [{ id: 'u1', role: 'user', content: 'hello' }];
    await act(async () => {
      firstSend.reject(new DaemonHttpError(413, {}, 'Prompt too large'));
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="failed-prompt-retry"]'),
    ).not.toBeNull();

    act(() => {
      testState.blocks = [
        { id: 'u1', kind: 'user', text: 'hello' },
        {
          id: 'background-1',
          kind: 'user',
          text: 'Background task completed',
          meta: { source: 'background_notification' },
        },
      ];
      testState.messages = [
        { id: 'u1', role: 'user', content: 'hello' },
        {
          id: 'background-1',
          role: 'system',
          content: 'Background task completed',
          source: 'background_notification',
        },
      ];
      rerender();
    });
    await flush();

    expect(
      container.querySelector('[data-testid="failed-prompt-retry"]')
        ?.textContent,
    ).toBe('u1');
  });

  it('keeps a failed-prompt retry when its optimistic block is cloned', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const firstSend = deferred<void>();
    const optimisticUser = { id: 'u1', kind: 'user', text: 'hello' } as const;
    mockSessionActions.sendPrompt.mockImplementationOnce(() => {
      testState.blocks = [optimisticUser];
      return firstSend.promise;
    });
    const { container, rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('hello');
    });
    act(() => {
      testState.blocks = [{ ...optimisticUser, text: 'hello echoed' }];
      testState.messages = [
        { id: 'u1', role: 'user', content: 'hello echoed' },
      ];
      rerender();
    });
    await act(async () => {
      firstSend.reject(new DaemonHttpError(413, {}, 'Prompt too large'));
      await Promise.resolve();
    });
    await flush();

    expect(
      container.querySelector('[data-testid="failed-prompt-retry"]')
        ?.textContent,
    ).toBe('u1');
  });

  it('keeps a failed-prompt retry when its workspace becomes available', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockConnection.sessionId = 'session-late';
    mockConnection.workspaceCwd = undefined;
    const firstSend = deferred<void>();
    mockSessionActions.sendPrompt.mockImplementationOnce(() => {
      testState.blocks = [{ id: 'u1', kind: 'user' }];
      return firstSend.promise;
    });
    const { container, rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('hello');
    });
    testState.messages = [{ id: 'u1', role: 'user', content: 'hello' }];
    await act(async () => {
      firstSend.reject(new DaemonHttpError(413, {}, 'Prompt too large'));
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="failed-prompt-retry"]'),
    ).not.toBeNull();

    act(() => {
      mockConnection.workspaceCwd = '/tmp/project';
      rerender();
    });
    await flush();

    expect(
      container.querySelector('[data-testid="failed-prompt-retry"]')
        ?.textContent,
    ).toBe('u1');
  });

  it('restores a pending failed-prompt retry after workspace enrichment', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const retryApproval = deferred<void>();
    let admissionCount = 0;
    const onSubmitBefore = vi.fn(() => {
      admissionCount += 1;
      return admissionCount === 2 ? retryApproval.promise : Promise.resolve();
    });
    mockConnection.sessionId = 'session-late';
    mockConnection.workspaceCwd = undefined;
    const firstSend = deferred<void>();
    mockSessionActions.sendPrompt.mockImplementationOnce(() => {
      testState.blocks = [{ id: 'u1', kind: 'user' }];
      return firstSend.promise;
    });
    const { container, rerender } = renderApp({ onSubmitBefore });
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('hello');
    });
    testState.messages = [{ id: 'u1', role: 'user', content: 'hello' }];
    await act(async () => {
      firstSend.reject(new DaemonHttpError(413, {}, 'Prompt too large'));
      await Promise.resolve();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="failed-prompt-retry"]')
        ?.click();
      mockConnection.workspaceCwd = '/tmp/project';
      rerender({ onSubmitBefore });
    });
    await act(async () => {
      retryApproval.resolve();
      await retryApproval.promise;
    });
    await flush();

    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-testid="failed-prompt-retry"]')
        ?.textContent,
    ).toBe('u1');
  });

  it('restores a rejected failed-prompt retry after workspace enrichment', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockConnection.sessionId = 'session-late';
    mockConnection.workspaceCwd = undefined;
    const firstSend = deferred<void>();
    const retrySend = deferred<void>();
    mockSessionActions.sendPrompt
      .mockImplementationOnce(() => {
        testState.blocks = [{ id: 'u1', kind: 'user' }];
        return firstSend.promise;
      })
      .mockImplementationOnce(() => retrySend.promise);
    const { container, rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('hello');
    });
    testState.messages = [{ id: 'u1', role: 'user', content: 'hello' }];
    await act(async () => {
      firstSend.reject(new DaemonHttpError(413, {}, 'Prompt too large'));
      await Promise.resolve();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="failed-prompt-retry"]')
        ?.click();
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(2);
    });
    act(() => {
      mockConnection.workspaceCwd = '/tmp/project';
      rerender();
    });
    await act(async () => {
      retrySend.reject(new DaemonHttpError(413, {}, 'Prompt too large'));
      await Promise.resolve();
    });
    await flush();

    expect(
      container.querySelector('[data-testid="failed-prompt-retry"]')
        ?.textContent,
    ).toBe('u1');
  });

  it('rehydrates a rejected failed-prompt retry after attachment reset', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const firstSend = deferred<void>();
    const retrySend = deferred<void>();
    const originalAnchor = {
      id: 'user-1',
      kind: 'user',
      text: 'original anchor',
      sourceRecordIds: ['record-anchor'],
    };
    testState.blocks = [originalAnchor];
    testState.messages = [
      { id: 'user-1', role: 'user', content: 'original anchor' },
    ];
    mockStore.appendLocalUserMessage.mockImplementationOnce(() => {
      testState.blocks = [
        ...testState.blocks,
        { id: 'user-3', kind: 'user', text: 'hello' },
      ];
      testState.messages = [
        ...testState.messages,
        { id: 'user-3', role: 'user', content: 'hello' },
      ];
    });
    mockSessionActions.sendPrompt
      .mockImplementationOnce(() => {
        testState.blocks = [
          originalAnchor,
          { id: 'user-2', kind: 'user', text: 'hello' },
        ];
        return firstSend.promise;
      })
      .mockImplementationOnce(() => retrySend.promise);
    const { container, rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('hello');
    });
    testState.messages = [
      { id: 'user-1', role: 'user', content: 'original anchor' },
      { id: 'user-2', role: 'user', content: 'hello' },
    ];
    await act(async () => {
      firstSend.reject(new DaemonHttpError(413, {}, 'Prompt too large'));
      await Promise.resolve();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="failed-prompt-retry"]')
        ?.click();
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(2);
    });

    act(() => {
      testState.ownerVersion += 1;
      testState.blocks = [
        {
          id: 'user-9',
          kind: 'user',
          text: 'original anchor',
          sourceRecordIds: ['record-anchor'],
        },
      ];
      testState.messages = [
        { id: 'user-9', role: 'user', content: 'original anchor' },
      ];
      rerender();
    });
    await act(async () => {
      retrySend.reject(new DaemonHttpError(413, {}, 'Prompt too large'));
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mockStore.appendLocalUserMessage).toHaveBeenCalledWith(
        'hello',
        undefined,
        undefined,
        undefined,
      );
    });
    act(() => {
      testState.blocks = [...testState.blocks];
      testState.messages = [...testState.messages];
      rerender();
    });
    await flush();

    expect(
      container.querySelector('[data-testid="failed-prompt-retry"]')
        ?.textContent,
    ).toBe('user-3');
  });

  it('drops a known-workspace failed retry when a replacement reuses its local user id', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const firstSend = deferred<void>();
    mockSessionActions.sendPrompt.mockImplementationOnce(() => {
      testState.blocks = [{ id: 'user-1', kind: 'user', text: 'hello' }];
      return firstSend.promise;
    });
    const { container, rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('hello');
    });
    testState.messages = [{ id: 'user-1', role: 'user', content: 'hello' }];
    await act(async () => {
      firstSend.reject(new DaemonHttpError(413, {}, 'Prompt too large'));
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="failed-prompt-retry"]'),
    ).not.toBeNull();
    const retry = testState.latestMessageListProps?.onRetryFailedPrompt;

    act(() => {
      testState.ownerVersion += 1;
      testState.blocks = [
        { id: 'user-1', kind: 'user', text: 'replacement prompt' },
      ];
      testState.messages = [
        { id: 'user-1', role: 'user', content: 'replacement prompt' },
      ];
      retry?.();
      rerender();
    });
    await flush();

    expect(
      container.querySelector('[data-testid="failed-prompt-retry"]'),
    ).toBeNull();
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('drops an uncertain failed retry response after a known-workspace transcript replacement', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const firstSend = deferred<void>();
    const retrySend = deferred<void>();
    mockSessionActions.sendPrompt
      .mockImplementationOnce(() => {
        testState.blocks = [{ id: 'user-1', kind: 'user', text: 'first' }];
        return firstSend.promise;
      })
      .mockReturnValueOnce(retrySend.promise);
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = 'first';
    await clickSubmit(container);
    testState.messages = [{ id: 'user-1', role: 'user', content: 'first' }];
    await act(async () => {
      firstSend.reject(new DaemonHttpError(413, {}, 'Prompt too large'));
      await Promise.resolve();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="failed-prompt-retry"]')
        ?.click();
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(2);
    });
    const retryOptions = mockSessionActions.sendPrompt.mock.calls[1]?.[1];

    act(() => {
      retryOptions?.onAdmissionStarted?.();
      testState.ownerVersion += 1;
      testState.blocks = [{ id: 'user-1', kind: 'user', text: 'replacement' }];
      testState.messages = [
        { id: 'user-1', role: 'user', content: 'replacement' },
      ];
      rerender();
    });
    await act(async () => {
      retrySend.reject(new Error('response lost'));
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="prompt-admission-unknown"]'),
    ).toBeNull();
    expect(warn).not.toHaveBeenCalledWith(
      '[WebShell] prompt retry admission outcome is unknown',
      expect.anything(),
    );
  });

  it('drops a visible workspace-unknown failed retry after its attachment is replaced', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockConnection.sessionId = 'session-late';
    mockConnection.workspaceCwd = undefined;
    const firstSend = deferred<void>();
    mockSessionActions.sendPrompt.mockImplementationOnce(() => {
      testState.blocks = [{ id: 'user-1', kind: 'user' }];
      return firstSend.promise;
    });
    const { container, rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('hello');
    });
    testState.messages = [{ id: 'user-1', role: 'user', content: 'hello' }];
    await act(async () => {
      firstSend.reject(new DaemonHttpError(413, {}, 'Prompt too large'));
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="failed-prompt-retry"]'),
    ).not.toBeNull();
    const retry = testState.latestMessageListProps?.onRetryFailedPrompt;

    act(() => {
      testState.ownerVersion += 1;
      rerender();
    });
    expect(
      container.querySelector('[data-testid="failed-prompt-retry"]'),
    ).toBeNull();
    act(() => retry?.());
    await flush();

    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('does not let an in-flight workspace-unknown failed retry suppress a replacement attachment', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockConnection.sessionId = 'session-late';
    mockConnection.workspaceCwd = undefined;
    const firstSend = deferred<void>();
    const retrySend = deferred<void>();
    let retryAdmitted: (() => void) | undefined;
    mockSessionActions.sendPrompt
      .mockImplementationOnce(() => {
        testState.blocks = [{ id: 'user-1', kind: 'user' }];
        return firstSend.promise;
      })
      .mockImplementationOnce(
        (
          _text: string,
          options?: {
            onAdmitted?: () => void;
          },
        ) => {
          retryAdmitted = options?.onAdmitted;
          return retrySend.promise;
        },
      );
    const { container, rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('hello');
    });
    testState.messages = [{ id: 'user-1', role: 'user', content: 'hello' }];
    await act(async () => {
      firstSend.reject(new DaemonHttpError(413, {}, 'Prompt too large'));
      await Promise.resolve();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="failed-prompt-retry"]')
        ?.click();
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(2);
    });

    act(() => {
      testState.ownerVersion += 1;
      testState.streamingState = 'responding';
      rerender();
    });
    act(() => retryAdmitted?.());
    await act(async () => {
      retrySend.resolve();
      await retrySend.promise;
    });
    act(() => rerender());

    expect(testState.latestMessageListProps?.isResponding).toBe(true);
  });

  it('does not revive an old workspace-unknown failure when a replacement reuses its local id', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockConnection.sessionId = 'session-late';
    mockConnection.workspaceCwd = undefined;
    const firstSend = deferred<void>();
    const replacementSend = deferred<void>();
    mockSessionActions.sendPrompt
      .mockImplementationOnce(() => {
        testState.blocks = [{ id: 'user-1', kind: 'user' }];
        return firstSend.promise;
      })
      .mockImplementationOnce(() => {
        testState.blocks = [{ id: 'user-1', kind: 'user' }];
        return replacementSend.promise;
      });
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = 'old';
    await clickSubmit(container);
    testState.messages = [{ id: 'user-1', role: 'user', content: 'old' }];
    await act(async () => {
      firstSend.reject(new DaemonHttpError(413, {}, 'Prompt too large'));
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="failed-prompt-retry"]'),
    ).not.toBeNull();

    act(() => {
      testState.ownerVersion += 1;
      testState.blocks = [];
      testState.messages = [];
      rerender();
    });
    expect(
      container.querySelector('[data-testid="failed-prompt-retry"]'),
    ).toBeNull();

    testState.prompt = 'new';
    await clickSubmit(container);
    act(() => {
      testState.messages = [{ id: 'user-1', role: 'user', content: 'new' }];
      rerender();
    });

    expect(
      container.querySelector('[data-testid="failed-prompt-retry"]'),
    ).toBeNull();
    await act(async () => {
      replacementSend.resolve();
      await replacementSend.promise;
    });
  });

  it('drops a workspace-unknown failed-prompt retry when its owner changes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const retryApproval = deferred<void>();
    let admissionCount = 0;
    const onSubmitBefore = vi.fn(() => {
      admissionCount += 1;
      return admissionCount === 2 ? retryApproval.promise : Promise.resolve();
    });
    mockConnection.sessionId = 'session-late';
    mockConnection.workspaceCwd = undefined;
    const firstSend = deferred<void>();
    mockSessionActions.sendPrompt.mockImplementationOnce(() => {
      testState.blocks = [{ id: 'user-1', kind: 'user' }];
      return firstSend.promise;
    });
    const { container, rerender } = renderApp({ onSubmitBefore });
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('hello');
    });
    testState.messages = [{ id: 'user-1', role: 'user', content: 'hello' }];
    await act(async () => {
      firstSend.reject(new DaemonHttpError(413, {}, 'Prompt too large'));
      await Promise.resolve();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="failed-prompt-retry"]')
        ?.click();
      mockConnection.loadingTranscript = true;
      rerender({ onSubmitBefore });
    });
    act(() => {
      mockConnection.workspaceCwd = '/tmp/project-2';
      testState.blocks = [{ id: 'user-1', kind: 'user' }];
      testState.messages = [
        { id: 'user-1', role: 'user', content: 'other owner' },
      ];
      testState.ownerVersion += 1;
      mockConnection.loadingTranscript = false;
      rerender({ onSubmitBefore });
    });
    await act(async () => {
      retryApproval.resolve();
      await retryApproval.promise;
    });

    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-testid="failed-prompt-retry"]'),
    ).toBeNull();
    act(() => {
      mockConnection.workspaceCwd = '/tmp/project';
      testState.blocks = [{ id: 'user-1', kind: 'user' }];
      testState.messages = [{ id: 'user-1', role: 'user', content: 'hello' }];
      testState.ownerVersion += 1;
      rerender({ onSubmitBefore });
    });
    await flush();

    expect(
      container.querySelector('[data-testid="failed-prompt-retry"]'),
    ).toBeNull();
  });

  it('tracks the first failed message with the lazily allocated session id', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockConnection.sessionId = undefined;
    mockSessionActions.createSession.mockResolvedValueOnce({
      sessionId: 'session-created',
    });
    mockSessionActions.attachSession.mockImplementationOnce(async () => {
      testState.ownerVersion += 1;
    });
    const firstSend = deferred<void>();
    mockSessionActions.sendPrompt.mockImplementationOnce(() => {
      testState.blocks = [{ id: 'u1', kind: 'user' }];
      return firstSend.promise;
    });
    const { rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('first message');
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.sendPrompt).toHaveBeenCalledOnce();
    });
    expect(mockConnection.sessionId).toBeUndefined();

    act(() => {
      mockConnection.sessionId = 'session-created';
      testState.messages = [
        { id: 'u1', role: 'user', content: 'first message' },
      ];
      rerender();
    });
    await act(async () => {
      firstSend.reject(new DaemonHttpError(413, {}, 'Prompt too large'));
      await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="failed-prompt-retry"]')
        ?.textContent,
    ).toBe('u1');
  });

  it('restores a failed-prompt retry after an empty transcript returns', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let approveRetry: (() => void) | undefined;
    let admissionCount = 0;
    const onSubmitBefore = vi.fn(() => {
      admissionCount += 1;
      if (admissionCount === 1) return Promise.resolve();
      return new Promise<void>((resolve) => {
        approveRetry = resolve;
      });
    });
    const firstSend = deferred<void>();
    mockStore.appendLocalUserMessage.mockImplementationOnce(() => {
      testState.blocks = [{ id: 'user-1', kind: 'user', text: 'hello' }];
      testState.messages = [{ id: 'user-1', role: 'user', content: 'hello' }];
    });
    mockSessionActions.sendPrompt.mockImplementationOnce(() => {
      testState.blocks = [{ id: 'user-1', kind: 'user', text: 'hello' }];
      return firstSend.promise;
    });
    const { container, rerender } = renderApp({ onSubmitBefore });
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('hello');
    });
    testState.messages = [{ id: 'user-1', role: 'user', content: 'hello' }];
    await act(async () => {
      firstSend.reject(new DaemonHttpError(413, {}, 'Prompt too large'));
      await Promise.resolve();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="failed-prompt-retry"]')
        ?.click();
      mockConnection.loadingTranscript = true;
      rerender({ onSubmitBefore });
    });
    act(() => {
      mockConnection.workspaceCwd = '/tmp/project-2';
      testState.blocks = [];
      testState.messages = [];
      testState.ownerVersion += 1;
      mockConnection.loadingTranscript = false;
      rerender({ onSubmitBefore });
    });
    await act(async () => {
      approveRetry?.();
      await Promise.resolve();
    });

    act(() => {
      mockConnection.workspaceCwd = '/tmp/project';
      testState.blocks = [];
      testState.messages = [];
      testState.ownerVersion += 1;
      rerender({ onSubmitBefore });
    });
    act(() => {
      rerender({ onSubmitBefore });
    });
    await flush();

    expect(mockStore.appendLocalUserMessage).toHaveBeenCalledWith(
      'hello',
      undefined,
      undefined,
      undefined,
    );
    expect(
      container.querySelector('[data-testid="failed-prompt-retry"]')
        ?.textContent,
    ).toBe('user-1');
  });

  it('restores a failed-prompt retry after switching away during admission', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let approveRetry: (() => void) | undefined;
    let admissionCount = 0;
    const onSubmitBefore = vi.fn(() => {
      admissionCount += 1;
      if (admissionCount === 1) return Promise.resolve();
      return new Promise<void>((resolve) => {
        approveRetry = resolve;
      });
    });
    const firstSend = deferred<void>();
    const originalAnchor = {
      id: 'user-2',
      kind: 'user',
      text: 'original anchor',
      sourceRecordIds: ['record-anchor'],
    };
    testState.blocks = [originalAnchor];
    testState.messages = [
      { id: 'user-2', role: 'user', content: 'original anchor' },
    ];
    mockStore.appendLocalUserMessage.mockImplementationOnce(() => {
      testState.blocks = [
        ...testState.blocks,
        { id: 'user-10', kind: 'user', text: 'hello' },
      ];
      testState.messages = [
        ...testState.messages,
        { id: 'user-10', role: 'user', content: 'hello' },
      ];
    });
    mockSessionActions.sendPrompt.mockImplementationOnce(() => {
      testState.blocks = [
        originalAnchor,
        { id: 'user-3', kind: 'user', text: 'hello' },
      ];
      return firstSend.promise;
    });
    const { container, rerender } = renderApp({ onSubmitBefore });
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('hello');
    });
    testState.messages = [
      { id: 'user-2', role: 'user', content: 'original anchor' },
      { id: 'user-3', role: 'user', content: 'hello' },
    ];
    await act(async () => {
      firstSend.reject(new DaemonHttpError(413, {}, 'Prompt too large'));
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="failed-prompt-retry"]'),
    ).not.toBeNull();

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="failed-prompt-retry"]')
        ?.click();
    });
    expect(onSubmitBefore).toHaveBeenCalledTimes(2);
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(1);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="load-session"]')
        ?.click();
      await Promise.resolve();
    });
    act(() => {
      mockConnection.loadingTranscript = true;
      rerender({ onSubmitBefore });
    });
    act(() => {
      mockConnection.sessionId = 'session-1';
      mockConnection.workspaceCwd = '/tmp/project-2';
      testState.blocks = [];
      testState.messages = [];
      testState.ownerVersion += 1;
      mockConnection.loadingTranscript = false;
      rerender({ onSubmitBefore });
    });
    await act(async () => {
      approveRetry?.();
      await Promise.resolve();
    });

    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-testid="failed-prompt-retry"]'),
    ).toBeNull();

    act(() => {
      mockConnection.sessionId = 'session-1';
      mockConnection.workspaceCwd = '/tmp/project';
      testState.blocks = [
        {
          id: 'user-1',
          kind: 'user',
          text: 'original anchor',
          sourceRecordIds: ['record-anchor'],
        },
      ];
      testState.messages = [
        { id: 'user-1', role: 'user', content: 'original anchor' },
      ];
      testState.ownerVersion += 1;
      rerender({ onSubmitBefore });
    });
    expect(mockStore.appendLocalUserMessage).toHaveBeenCalledWith(
      'hello',
      undefined,
      undefined,
      undefined,
    );
    act(() => {
      rerender({ onSubmitBefore });
    });
    await flush();

    expect(
      container.querySelector('[data-testid="failed-prompt-retry"]')
        ?.textContent,
    ).toBe('user-10');
    const allowRetry = vi.fn().mockResolvedValue(undefined);
    rerender({ onSubmitBefore: allowRetry });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="failed-prompt-retry"]')
        ?.click();
      await Promise.resolve();
    });
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(2);
    expect(mockSessionActions.sendPrompt).toHaveBeenLastCalledWith(
      'hello',
      expect.objectContaining({ optimisticUserMessage: false }),
    );
  });

  it('restores a failed-prompt retry onto the replayed stable user record', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let approveRetry: (() => void) | undefined;
    let admissionCount = 0;
    const onSubmitBefore = vi.fn(() => {
      admissionCount += 1;
      if (admissionCount === 1) return Promise.resolve();
      return new Promise<void>((resolve) => {
        approveRetry = resolve;
      });
    });
    const firstSend = deferred<void>();
    const failedUser = {
      id: 'user-2',
      kind: 'user',
      text: 'hello',
      sourceRecordIds: ['record-failed'],
    } as const;
    mockSessionActions.sendPrompt.mockImplementationOnce(() => {
      testState.blocks = [failedUser];
      return firstSend.promise;
    });
    const { container, rerender } = renderApp({ onSubmitBefore });
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('hello');
    });
    testState.messages = [{ id: 'user-2', role: 'user', content: 'hello' }];
    await act(async () => {
      firstSend.reject(new DaemonHttpError(413, {}, 'Prompt too large'));
      await Promise.resolve();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="failed-prompt-retry"]')
        ?.click();
      mockConnection.loadingTranscript = true;
      rerender({ onSubmitBefore });
    });
    act(() => {
      mockConnection.workspaceCwd = '/tmp/project-2';
      testState.blocks = [];
      testState.messages = [];
      testState.ownerVersion += 1;
      mockConnection.loadingTranscript = false;
      rerender({ onSubmitBefore });
    });
    await act(async () => {
      approveRetry?.();
      await Promise.resolve();
    });
    act(() => {
      mockConnection.workspaceCwd = '/tmp/project';
      testState.blocks = [
        {
          id: 'user-9',
          kind: 'user',
          text: 'rewritten display text',
          sourceRecordIds: ['record-failed'],
        },
      ];
      testState.messages = [
        { id: 'user-9', role: 'user', content: 'rewritten display text' },
      ];
      testState.ownerVersion += 1;
      rerender({ onSubmitBefore });
    });
    await flush();

    expect(
      container.querySelector('[data-testid="failed-prompt-retry"]')
        ?.textContent,
    ).toBe('user-9');
  });

  it('drops a cancelled failed-prompt retry when its transcript anchor changes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let approveRetry: (() => void) | undefined;
    let admissionCount = 0;
    const onSubmitBefore = vi.fn(() => {
      admissionCount += 1;
      if (admissionCount === 1) return Promise.resolve();
      return new Promise<void>((resolve) => {
        approveRetry = resolve;
      });
    });
    const firstSend = deferred<void>();
    const originalAnchor = {
      id: 'user-1',
      kind: 'user',
      text: 'original anchor',
    };
    testState.blocks = [originalAnchor];
    testState.messages = [
      { id: 'user-1', role: 'user', content: 'original anchor' },
    ];
    mockSessionActions.sendPrompt.mockImplementationOnce(() => {
      testState.blocks = [
        originalAnchor,
        { id: 'user-2', kind: 'user', text: 'hello' },
      ];
      return firstSend.promise;
    });
    const { container, rerender } = renderApp({ onSubmitBefore });
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('hello');
    });
    testState.messages = [
      { id: 'user-1', role: 'user', content: 'original anchor' },
      { id: 'user-2', role: 'user', content: 'hello' },
    ];
    await act(async () => {
      firstSend.reject(new DaemonHttpError(413, {}, 'Prompt too large'));
      await Promise.resolve();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="failed-prompt-retry"]')
        ?.click();
      mockConnection.loadingTranscript = true;
      rerender({ onSubmitBefore });
    });
    act(() => {
      mockConnection.workspaceCwd = '/tmp/project-2';
      testState.blocks = [];
      testState.messages = [];
      testState.ownerVersion += 1;
      mockConnection.loadingTranscript = false;
      rerender({ onSubmitBefore });
    });
    await act(async () => {
      approveRetry?.();
      await Promise.resolve();
    });

    act(() => {
      mockConnection.workspaceCwd = '/tmp/project';
      testState.blocks = [
        { id: 'user-1', kind: 'user', text: 'replacement anchor' },
        { id: 'user-2', kind: 'user', text: 'unrelated message' },
      ];
      testState.messages = [
        { id: 'user-1', role: 'user', content: 'replacement anchor' },
        { id: 'user-2', role: 'user', content: 'unrelated message' },
      ];
      testState.ownerVersion += 1;
      rerender({ onSubmitBefore });
    });
    await flush();

    expect(mockStore.appendLocalUserMessage).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="failed-prompt-retry"]'),
    ).toBeNull();
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledOnce();
  });

  it('restores the retry action when resending fails again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const firstSend = deferred<void>();
    const retrySend = deferred<void>();
    const secondRetrySend = deferred<void>();
    mockSessionActions.sendPrompt
      .mockImplementationOnce(() => {
        testState.blocks = [{ id: 'u1', kind: 'user' }];
        return firstSend.promise;
      })
      .mockImplementationOnce(() => retrySend.promise)
      .mockImplementationOnce(() => secondRetrySend.promise);
    const { container, rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('hello');
    });
    testState.messages = [{ id: 'u1', role: 'user', content: 'hello' }];
    await act(async () => {
      firstSend.reject(new DaemonHttpError(413, {}, 'Prompt too large'));
      await Promise.resolve();
    });
    act(() =>
      document
        .querySelector<HTMLButtonElement>('[data-testid="failed-prompt-retry"]')
        ?.click(),
    );
    await act(async () => {
      retrySend.reject(new DaemonHttpError(413, {}, 'Prompt too large'));
      await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="failed-prompt-retry"]')
        ?.textContent,
    ).toBe('u1');

    await act(async () => {
      await Promise.resolve();
    });
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="failed-prompt-retry"]')
        ?.click(),
    );
    testState.streamingState = 'responding';
    rerender();

    expect(
      container.querySelector('[data-testid="streaming-status"]'),
    ).toBeNull();
    expect(testState.latestMessageListProps?.isResponding).toBe(false);
    expect(
      testState.latestMessageListProps?.activeTurnStartedAt,
    ).toBeUndefined();

    await act(async () => {
      secondRetrySend.resolve();
      testState.streamingState = 'idle';
      rerender();
      await Promise.resolve();
    });
  });

  it('settles a prompt retry after a same-id attachment replacement', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const firstSend = deferred<void>();
    const retrySend = deferred<void>();
    let retryAdmitted: (() => void) | undefined;
    const originalUser = {
      id: 'u1',
      kind: 'user',
      text: 'hello',
      sourceRecordIds: ['record-1'],
    } as const;
    const replayedUser = {
      id: 'u2',
      kind: 'user',
      text: 'hello',
      sourceRecordIds: ['record-1'],
    } as const;
    mockSessionActions.sendPrompt
      .mockImplementationOnce(() => {
        testState.blocks = [originalUser];
        return firstSend.promise;
      })
      .mockImplementationOnce(
        (
          _text: string,
          options?: {
            onAdmitted?: () => void;
          },
        ) => {
          retryAdmitted = options?.onAdmitted;
          return retrySend.promise;
        },
      );
    const { container, rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('hello');
    });
    testState.messages = [{ id: 'u1', role: 'user', content: 'hello' }];
    await act(async () => {
      firstSend.reject(new DaemonHttpError(413, {}, 'Prompt too large'));
      await Promise.resolve();
    });
    await flush();
    expect(
      container.querySelector('[data-testid="failed-prompt-retry"]'),
    ).not.toBeNull();
    act(() => {
      testState.ownerVersion += 1;
      testState.blocks = [replayedUser];
      testState.messages = [{ id: 'u2', role: 'user', content: 'hello' }];
      rerender();
    });
    await flush();
    expect(
      container.querySelector('[data-testid="failed-prompt-retry"]')
        ?.textContent,
    ).toBe('u2');
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="failed-prompt-retry"]')
        ?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(2);
    });
    expect(retryAdmitted).toBeTypeOf('function');

    act(() => {
      retryAdmitted?.();
    });
    await act(async () => {
      retrySend.resolve();
      await retrySend.promise;
      testState.streamingState = 'idle';
      rerender();
      await Promise.resolve();
    });
    act(() => {
      testState.streamingState = 'responding';
      rerender();
    });

    expect(testState.latestMessageListProps?.isResponding).toBe(true);
    expect(
      container.querySelector('[data-testid="streaming-status"]'),
    ).not.toBeNull();
  });

  it('shows processing only after retry admission and restarts its timer', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const firstSend = deferred<void>();
    const retrySend = deferred<void>();
    mockSessionActions.sendPrompt
      .mockImplementationOnce(() => {
        testState.blocks = [{ id: 'u1', kind: 'user' }];
        return firstSend.promise;
      })
      .mockImplementationOnce(() => retrySend.promise);
    const { container, rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('hello');
    });
    testState.messages = [{ id: 'u1', role: 'user', content: 'hello' }];
    await act(async () => {
      firstSend.reject(new DaemonHttpError(413, {}, 'Prompt too large'));
      await Promise.resolve();
    });

    const retryStartedAt = Date.now();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="failed-prompt-retry"]')
        ?.click();
      await Promise.resolve();
    });
    testState.streamingState = 'responding';
    rerender();

    expect(
      container.querySelector('[data-testid="streaming-status"]'),
    ).toBeNull();
    expect(testState.latestMessageListProps?.isResponding).toBe(false);
    expect(
      testState.latestMessageListProps?.activeTurnStartedAt,
    ).toBeUndefined();

    const retryOptions = mockSessionActions.sendPrompt.mock.calls.at(
      -1,
    )?.[1] as { onAdmitted?: () => void } | undefined;
    act(() => retryOptions?.onAdmitted?.());

    const status = container.querySelector('[data-testid="streaming-status"]');
    expect(status).not.toBeNull();
    expect(
      Number(status?.getAttribute('data-started-at')),
    ).toBeGreaterThanOrEqual(retryStartedAt);
    expect(testState.latestMessageListProps?.isResponding).toBe(true);
    expect(
      testState.latestMessageListProps?.activeTurnStartedAt,
    ).toBeGreaterThanOrEqual(retryStartedAt);

    await act(async () => {
      retrySend.resolve();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="streaming-status"]'),
    ).toBeNull();
    expect(testState.latestMessageListProps?.isResponding).toBe(false);
    expect(
      testState.latestMessageListProps?.activeTurnStartedAt,
    ).toBeUndefined();

    testState.streamingState = 'idle';
    rerender();
  });

  it('hides the old retry action when a newer user message appears', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const firstSend = deferred<void>();
    const newerSend = deferred<void>();
    mockSessionActions.sendPrompt
      .mockImplementationOnce(() => {
        testState.blocks = [{ id: 'u1', kind: 'user' }];
        return firstSend.promise;
      })
      .mockImplementationOnce(() => newerSend.promise);
    const { rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('first');
    });
    testState.messages = [{ id: 'u1', role: 'user', content: 'first' }];
    await act(async () => {
      firstSend.reject(new DaemonHttpError(413, {}, 'Prompt too large'));
      await Promise.resolve();
    });
    expect(
      document.querySelector('[data-testid="failed-prompt-retry"]'),
    ).not.toBeNull();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('second');
    });
    testState.blocks = [
      { id: 'u1', kind: 'user' },
      { id: 'u2', kind: 'user' },
    ];
    testState.messages = [
      { id: 'u1', role: 'user', content: 'first' },
      { id: 'u2', role: 'user', content: 'second' },
    ];
    rerender();
    await flush();

    expect(
      document.querySelector('[data-testid="failed-prompt-retry"]'),
    ).toBeNull();
    newerSend.resolve();
  });

  it('does not attach an old send failure to the newly selected session', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const firstSend = deferred<void>();
    mockSessionActions.sendPrompt.mockImplementationOnce(() => {
      testState.blocks = [{ id: 'u1', kind: 'user' }];
      return firstSend.promise;
    });
    const { rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('from session one');
    });
    testState.messages = [
      { id: 'u1', role: 'user', content: 'from session one' },
    ];
    await vi.waitFor(() => {
      expect(mockSessionActions.sendPrompt).toHaveBeenCalledOnce();
    });

    act(() => {
      mockConnection.sessionId = 'session-2';
      testState.blocks = [{ id: 'u2', kind: 'user' }];
      testState.messages = [
        { id: 'u2', role: 'user', content: 'from session two' },
      ];
      rerender();
    });
    await act(async () => {
      firstSend.reject(new Error('old session disconnected'));
      await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="failed-prompt-retry"]'),
    ).toBeNull();
  });

  it('does not restore retry when a newer user message arrived before failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const firstSend = deferred<void>();
    mockSessionActions.sendPrompt.mockImplementationOnce(() => {
      testState.blocks = [{ id: 'u1', kind: 'user' }];
      return firstSend.promise;
    });
    const { rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('first');
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.sendPrompt).toHaveBeenCalledOnce();
    });

    act(() => {
      testState.blocks = [
        { id: 'u1', kind: 'user' },
        { id: 'u2', kind: 'user' },
      ];
      testState.messages = [
        { id: 'u1', role: 'user', content: 'first' },
        { id: 'u2', role: 'user', content: 'newer' },
      ];
      rerender();
    });
    await act(async () => {
      firstSend.reject(new Error('first send failed late'));
      await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="failed-prompt-retry"]'),
    ).toBeNull();
  });

  it('leaves admitted turn failures to the existing turn-error UI', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockSessionActions.sendPrompt.mockImplementationOnce(
      (
        _text: string,
        options?: {
          onAdmitted?: () => void;
        },
      ) => {
        options?.onAdmitted?.();
        return Promise.reject(new Error('generation failed'));
      },
    );
    renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('hello');
    });
    testState.blocks = [{ id: 'u1', kind: 'user' }];
    testState.messages = [{ id: 'u1', role: 'user', content: 'hello' }];
    await flush();

    expect(
      document.querySelector('[data-testid="failed-prompt-retry"]'),
    ).toBeNull();
  });
});

describe('App /goal command', () => {
  it('opens the Goals page for a bare /goal instead of sending a prompt', async () => {
    const { container } = renderApp();
    await flush();

    testState.prompt = '/goal';
    await clickSubmit(container);
    await flush();

    expect(
      container.querySelector('[data-testid="goals-page"]'),
    ).not.toBeNull();
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
  });

  it('opens the Goals page for a bare /goal even while a turn is running', async () => {
    const { container, rerender } = renderApp();
    await flush();
    act(() => {
      testState.streamingState = 'responding';
      rerender({});
    });

    testState.prompt = '/goal';
    await clickSubmit(container);
    await flush();

    expect(
      container.querySelector('[data-testid="goals-page"]'),
    ).not.toBeNull();
    expect(rawEnqueuePrompt).not.toHaveBeenCalled();
  });

  it('creates a goal through the canonical control plane without sending a prompt', async () => {
    const { container } = renderApp();
    await flush();
    mockSessionActions.getGoal.mockClear();
    mockSessionActions.controlGoal.mockResolvedValueOnce({
      snapshot: activeGoalSnapshot('ship it'),
    });

    testState.prompt = '/goal ship it';
    await clickSubmit(container);
    await vi.waitFor(() => {
      expect(mockSessionActions.controlGoal).toHaveBeenCalledWith({
        action: 'create',
        objective: 'ship it',
      });
    });

    expect(container.querySelector('[data-testid="goals-page"]')).toBeNull();
    expect(mockSessionActions.getGoal).toHaveBeenCalledTimes(1);
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(mockStore.appendLocalUserMessage).toHaveBeenCalledWith(
      '/goal ship it',
    );
  });

  it('refuses a composer control while another goal control is in flight', async () => {
    // The strip disables its buttons while a control runs; the composer has no
    // disabled state, so without this refusal both controls read the same
    // snapshot, stamp the same expected revision, and the daemon rejects the
    // loser with a 409 surfaced as "Failed to …the goal".
    const pendingControl = deferred<{
      snapshot: ReturnType<typeof activeGoalSnapshot>;
    }>();
    mockSessionActions.controlGoal.mockReturnValueOnce(pendingControl.promise);
    const { container } = renderApp();
    await flush();

    testState.prompt = '/goal ship it';
    await clickSubmit(container);
    await vi.waitFor(() => {
      expect(mockSessionActions.controlGoal).toHaveBeenCalledTimes(1);
    });

    testState.prompt = '/goal ship something else';
    await clickSubmit(container);
    await flush();

    expect(mockSessionActions.controlGoal).toHaveBeenCalledTimes(1);
    expect(mockStore.appendLocalUserMessage).toHaveBeenCalledTimes(1);
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();

    await act(async () => {
      pendingControl.resolve({ snapshot: activeGoalSnapshot('ship it') });
      await flush();
    });
  });

  it('creates a goal as the first command while the new session is still committing', async () => {
    mockConnection.sessionId = undefined;
    mockSessionActions.createSession.mockResolvedValueOnce({
      sessionId: 'session-created',
    });
    mockWorkspaceActions.controlGoal.mockResolvedValueOnce({
      snapshot: activeGoalSnapshot('first objective'),
    });
    const { container } = renderApp();
    await flush();

    testState.prompt = '/goal first objective';
    await clickSubmit(container);
    await vi.waitFor(() => {
      expect(mockWorkspaceActions.controlGoal).toHaveBeenCalledWith(
        'session-created',
        { action: 'create', objective: 'first objective' },
      );
    });

    expect(mockSessionActions.createSession).toHaveBeenCalledOnce();
    expect(mockSessionActions.attachSession).toHaveBeenCalledOnce();
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
  });

  it('re-syncs canonical Goal state after creating it in an allocated session', async () => {
    const active = activeGoalSnapshot('first objective');
    mockConnection.sessionId = undefined;
    mockSessionActions.createSession.mockResolvedValueOnce({
      sessionId: 'session-created',
    });
    mockSessionActions.attachSession.mockImplementationOnce(async () => {
      mockConnection.sessionId = 'session-created';
      mockConnection.goalState = { v: 2, activity: 'idle', goal: null };
    });
    mockWorkspaceActions.controlGoal.mockResolvedValueOnce({
      snapshot: active,
    });
    mockSessionActions.getGoal.mockImplementationOnce(async () => {
      mockConnection.goalState = active;
      return { snapshot: active };
    });
    const { container } = renderApp();
    await flush();

    testState.prompt = '/goal first objective';
    await clickSubmit(container);
    await vi.waitFor(() => {
      expect(mockSessionActions.getGoal).toHaveBeenCalledOnce();
    });

    expect(
      mockWorkspaceActions.controlGoal.mock.invocationCallOrder[0],
    ).toBeLessThan(mockSessionActions.getGoal.mock.invocationCallOrder[0]!);
    expect(mockConnection.goalState).toBe(active);
  });

  it('installs the allocated-session Goal before its re-sync resolves', async () => {
    // `workspaceActions.controlGoal` does not write `connection.goalState`, so
    // install the create response without waiting for the follow-up GET.
    const active = activeGoalSnapshot('first objective');
    mockConnection.sessionId = undefined;
    mockSessionActions.createSession.mockResolvedValueOnce({
      sessionId: 'session-created',
    });
    mockSessionActions.attachSession.mockImplementationOnce(async () => {
      mockConnection.sessionId = 'session-created';
      mockConnection.goalState = { v: 2, activity: 'idle', goal: null };
    });
    mockWorkspaceActions.controlGoal.mockResolvedValueOnce({
      snapshot: active,
    });
    // The re-sync never resolves: the create response has to stand on its own.
    mockSessionActions.getGoal.mockImplementationOnce(
      () => new Promise(() => {}),
    );
    const { container } = renderApp();
    await flush();

    testState.prompt = '/goal first objective';
    await clickSubmit(container);
    await vi.waitFor(() => {
      expect(mockSessionActions.applyGoalSnapshot).toHaveBeenCalledWith(
        'session-created',
        active,
      );
    });
    await flush();

    expect(mockConnection.goalState).toBe(active);
    expect(testState.queuedPromptHoldHistory.at(-1)).toBe(false);
    // The App's own snapshot drives the strip; asserting only the connection
    // state would re-read what this test's mock wrote.
    expect(
      container.querySelector('[data-testid="goal-status-strip"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('first objective');

    rawEnqueuePrompt.mockClear();
    mockSessionActions.sendPrompt.mockClear();
    testState.prompt = 'continue normally';
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('continue normally');
      await flush();
    });

    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      'continue normally',
      expect.objectContaining({ retry: undefined }),
    );
    expect(rawEnqueuePrompt).not.toHaveBeenCalled();
  });

  it('keeps a session-less /goal control in the composer', async () => {
    // Returning true wipes the composer, so a control that cannot run without
    // a session has to be refused before that happens — the async path would
    // otherwise clear the text and leave only a toast.
    mockConnection.sessionId = undefined;
    renderApp();
    await flush();

    let accepted: boolean | undefined;
    act(() => {
      accepted = testState.latestChatEditorProps?.onSubmit(
        '/goal clear',
        undefined,
        undefined,
        editorCommit,
      );
    });
    await flush();

    expect(accepted).toBe(false);
    expect(editorCommit).not.toHaveBeenCalled();
    expect(mockSessionActions.controlGoal).not.toHaveBeenCalled();
    expect(mockSessionActions.createSession).not.toHaveBeenCalled();
  });

  it('reports an objective-less /goal set through the i18n layer', async () => {
    // `formatError` prefers `error.message`, so a hardcoded English string in
    // the parser would reach the toast untranslated. Localized copy comes from
    // the dictionaries, which the zh-CN mount below exercises.
    const onToast = vi.fn();
    const { rerender } = renderApp({ onToast });
    await flush();

    let accepted: boolean | undefined;
    act(() => {
      accepted = testState.latestChatEditorProps?.onSubmit(
        '/goal set',
        undefined,
        undefined,
        editorCommit,
      );
    });
    await flush();

    expect(accepted).toBe(false);
    expect(editorCommit).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenCalledWith(
      'error',
      '/goal set requires an objective.',
    );

    act(() => rerender({ onToast, language: 'zh-CN' }));
    await flush();
    act(() => {
      testState.latestChatEditorProps?.onSubmit(
        '/goal edit',
        undefined,
        undefined,
        editorCommit,
      );
    });
    await flush();

    expect(onToast).toHaveBeenLastCalledWith(
      'error',
      '/goal edit 需要提供目标内容。',
    );
  });

  it('keeps /goal attachments in the composer instead of discarding them', async () => {
    renderApp();
    await flush();
    testState.prompt = '/goal inspect this screenshot';
    const images = [{ data: 'abc', media_type: 'image/png' }];

    let accepted: boolean | undefined;
    act(() => {
      accepted = testState.latestChatEditorProps?.onSubmit(
        testState.prompt,
        images,
        undefined,
        editorCommit,
      );
    });
    await flush();

    expect(accepted).toBe(false);
    expect(mockSessionActions.controlGoal).not.toHaveBeenCalled();
    expect(mockWorkspaceActions.controlGoal).not.toHaveBeenCalled();
    expect(editorCommit).not.toHaveBeenCalled();
    expect(testState.prompt).toBe('/goal inspect this screenshot');
  });

  it('drops a lazy /goal create when another session wins allocation', async () => {
    mockConnection.sessionId = undefined;
    mockSessionActions.createSession.mockResolvedValueOnce({
      sessionId: 'session-created',
    });
    const attach = deferred<void>();
    mockSessionActions.attachSession.mockReturnValueOnce(attach.promise);
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = '/goal first objective';
    void clickSubmit(container);
    await vi.waitFor(() => {
      expect(mockSessionActions.attachSession).toHaveBeenCalledOnce();
    });

    act(() => {
      testState.ownerVersion += 1;
      mockConnection.sessionId = 'other-session';
      rerender({});
    });
    await act(async () => {
      attach.resolve();
      await attach.promise;
    });
    await flush();

    expect(mockWorkspaceActions.controlGoal).not.toHaveBeenCalled();
    expect(mockStore.appendLocalUserMessage).not.toHaveBeenCalledWith(
      '/goal first objective',
    );
  });

  it('refuses non-set Goal controls without allocating a session', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockConnection.sessionId = undefined;
    const { container } = renderApp();
    await flush();

    testState.prompt = '/goal clear';
    await clickSubmit(container);
    await flush();

    expect(mockSessionActions.createSession).not.toHaveBeenCalled();
    expect(mockSessionActions.attachSession).not.toHaveBeenCalled();
    expect(mockSessionActions.controlGoal).not.toHaveBeenCalled();
    expect(mockStore.appendLocalUserMessage).not.toHaveBeenCalledWith(
      '/goal clear',
    );
  });

  it('replaces an existing goal with compare-and-swap identity', async () => {
    const current = activeGoalSnapshot('old objective', 7);
    mockConnection.goalState = current;
    mockSessionActions.getGoal.mockResolvedValue({ snapshot: current });
    mockSessionActions.controlGoal.mockResolvedValueOnce({
      snapshot: activeGoalSnapshot('new objective', 8),
    });
    const { container } = renderApp();
    await flush();

    testState.prompt = '/goal new objective';
    await clickSubmit(container);
    await vi.waitFor(() => {
      expect(mockSessionActions.controlGoal).toHaveBeenCalledWith({
        action: 'replace',
        objective: 'new objective',
        expectedGoalId: 'goal-1',
        expectedRevision: 7,
      });
    });

    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
  });

  it('clears a goal directly without a confirmation or legacy clear call', async () => {
    const current = activeGoalSnapshot('ship it', 4);
    mockConnection.goalState = current;
    mockSessionActions.getGoal.mockResolvedValue({ snapshot: current });
    const { container } = renderApp();
    await flush();
    mockSessionActions.controlGoal.mockResolvedValueOnce({
      snapshot: { v: 2, activity: 'idle', goal: null },
    });

    testState.prompt = '/goal clear';
    await clickSubmit(container);
    await vi.waitFor(() => {
      expect(mockSessionActions.controlGoal).toHaveBeenCalledWith({
        action: 'clear',
        expectedGoalId: 'goal-1',
        expectedRevision: 4,
      });
    });

    expect(mockSessionActions.clearGoal).not.toHaveBeenCalled();
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
  });

  it('applies explicit controls immediately while a turn is running', async () => {
    const current = activeGoalSnapshot('ship it', 5);
    mockConnection.goalState = current;
    mockSessionActions.getGoal.mockResolvedValue({ snapshot: current });
    const { container, rerender } = renderApp();
    await flush();
    act(() => {
      testState.streamingState = 'responding';
      rerender({});
    });

    testState.prompt = '/goal pause';
    await clickSubmit(container);
    await vi.waitFor(() => {
      expect(mockSessionActions.controlGoal).toHaveBeenCalledWith({
        action: 'pause',
        expectedGoalId: 'goal-1',
        expectedRevision: 5,
      });
    });

    expect(rawEnqueuePrompt).not.toHaveBeenCalled();
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
  });

  it('starts a canonical goal in a fresh session from the Goals page', async () => {
    const onSessionIdChange = vi.fn();
    const { container } = renderApp({ onSessionIdChange });
    await flush();

    testState.prompt = '/goal';
    await clickSubmit(container);
    await flush();

    const onCreateGoal = testState.latestGoalsProps?.onCreateGoal;
    if (!onCreateGoal) throw new Error('onCreateGoal was not captured');
    mockSessionActions.clearSession.mockClear();
    mockSessionActions.getGoal.mockClear();
    mockSessionActions.controlGoal.mockResolvedValueOnce({
      snapshot: activeGoalSnapshot('all tests pass'),
    });

    await act(async () => {
      await onCreateGoal('all tests pass');
    });

    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);
    expect(mockSessionActions.controlGoal).toHaveBeenCalledWith({
      action: 'create',
      objective: 'all tests pass',
    });
    // Order is the invariant the flow exists for: dispatching the create
    // before the allocation completes would start the Goal inside the
    // conversation the user is leaving.
    expect(
      mockSessionActions.clearSession.mock.invocationCallOrder[0],
    ).toBeLessThan(mockSessionActions.controlGoal.mock.invocationCallOrder[0]!);
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(onSessionIdChange).not.toHaveBeenCalledWith(undefined);
    expect(container.querySelector('[data-testid="goals-page"]')).toBeNull();
  });

  it('does not create a goal session in an untrusted primary workspace', async () => {
    mockWorkspace.capabilities = {
      workspaceCwd: '/tmp/project',
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: false,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const { container } = renderApp();
    await flush();

    testState.prompt = '/goal';
    await clickSubmit(container);
    await flush();
    const onCreateGoal = testState.latestGoalsProps?.onCreateGoal;
    if (!onCreateGoal) throw new Error('onCreateGoal was not captured');
    mockSessionActions.clearSession.mockClear();
    mockSessionActions.controlGoal.mockClear();

    await act(async () => {
      await onCreateGoal('all tests pass');
    });

    expect(mockSessionActions.clearSession).not.toHaveBeenCalled();
    expect(mockSessionActions.controlGoal).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)(
    'ignores a stale Goal edit %s after the session changes',
    async (outcome) => {
      const goalA = activeGoalSnapshot('session A objective', 5);
      const goalB = {
        ...activeGoalSnapshot('session B objective', 1),
        goal: {
          ...activeGoalSnapshot('session B objective', 1).goal!,
          goalId: 'goal-b',
        },
      };
      const pending = deferred<{ snapshot: typeof goalA }>();
      mockConnection.goalState = goalA;
      mockSessionActions.getGoal.mockResolvedValue({ snapshot: goalA });
      mockSessionActions.controlGoal.mockReturnValueOnce(pending.promise);
      const { container, rerender } = renderApp();
      await flush();

      const editA = container.querySelector<HTMLButtonElement>(
        '[data-testid="goal-status-strip"] button[aria-label="Edit goal"]',
      );
      if (!editA) throw new Error('session A edit control was not rendered');
      act(() => editA.click());
      const saveA = [
        ...document.querySelectorAll<HTMLButtonElement>('button'),
      ].find((button) => button.textContent === 'Save');
      if (!saveA) throw new Error('session A save control was not rendered');
      act(() => saveA.click());
      await vi.waitFor(() => {
        expect(mockSessionActions.controlGoal).toHaveBeenCalledTimes(1);
      });

      act(() => {
        testState.ownerVersion += 1;
        mockConnection.sessionId = 'session-b';
        mockConnection.goalState = goalB;
        rerender({});
      });
      // Session A's dialog must be gone before B's is opened: left open, it
      // re-syncs its textarea from B's objective and the user edits B believing
      // it is still A. (The same-session replacement case, which only the
      // goalId-keyed reset effect covers, is pinned below.)
      expect(document.querySelector('textarea')).toBeNull();
      const editB = container.querySelector<HTMLButtonElement>(
        '[data-testid="goal-status-strip"] button[aria-label="Edit goal"]',
      );
      if (!editB) throw new Error('session B edit control was not rendered');
      act(() => editB.click());
      expect(document.querySelector('textarea')).not.toBeNull();

      await act(async () => {
        if (outcome === 'resolve') pending.resolve({ snapshot: goalA });
        else pending.reject(new Error('session A edit failed'));
        await Promise.resolve();
      });

      expect(document.querySelector('textarea')).not.toBeNull();
      expect(document.querySelector('[role="alert"]')).toBeNull();
      // The stale resolution must not install session A's goal over B's: the
      // strip and the dialog would then describe the wrong session's goal.
      expect(container.textContent).toContain('session B objective');
      expect(container.textContent).not.toContain('session A objective');
      expect(
        document.querySelector<HTMLTextAreaElement>('textarea')?.value,
      ).toBe('session B objective');
    },
  );

  it('keeps a Goal control busy latch owned by its own session', async () => {
    // Session A's control settles after the user moved to B. Releasing the
    // latch unconditionally re-enables B's strip mid-flight, and a second click
    // dispatches a duplicate control that dies in the daemon's CAS.
    const goalA = activeGoalSnapshot('goal A', 5);
    const goalB = {
      ...activeGoalSnapshot('goal B', 1),
      goal: {
        ...activeGoalSnapshot('goal B', 1).goal!,
        goalId: 'goal-b',
      },
    };
    const pendingA = deferred<{ snapshot: typeof goalA }>();
    const pendingB = deferred<{ snapshot: typeof goalB }>();
    mockConnection.goalState = goalA;
    mockSessionActions.getGoal
      .mockReturnValueOnce(pendingA.promise)
      .mockReturnValueOnce(pendingB.promise);
    const { container, rerender } = renderApp();
    await flush();

    const pauseA = container.querySelector<HTMLButtonElement>(
      '[data-testid="goal-status-strip"] button[aria-label="Pause goal"]',
    );
    if (!pauseA) throw new Error('session A pause control was not rendered');
    act(() => pauseA.click());

    act(() => {
      testState.ownerVersion += 1;
      mockConnection.sessionId = 'session-b';
      mockConnection.goalState = goalB;
      rerender({});
    });
    const pauseB = container.querySelector<HTMLButtonElement>(
      '[data-testid="goal-status-strip"] button[aria-label="Pause goal"]',
    );
    if (!pauseB) throw new Error('session B pause control was not rendered');
    act(() => pauseB.click());
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="goal-status-strip"] button[aria-label="Pause goal"]',
      )?.disabled,
    ).toBe(true);

    await act(async () => {
      pendingA.resolve({ snapshot: goalA });
      await flush();
    });

    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="goal-status-strip"] button[aria-label="Pause goal"]',
      )?.disabled,
    ).toBe(true);

    await act(async () => {
      pendingB.resolve({ snapshot: goalB });
      await flush();
    });
  });

  it('keeps the busy latch when an allocated-session create settles late', async () => {
    // `createGoalForAllocatedSession` shares the latch with `controlCurrentGoal`
    // but used to release it unconditionally, so a create that settles after
    // the user moved on re-enabled the strip under the new session's control.
    const created = activeGoalSnapshot('first objective');
    const goalB = activeGoalSnapshot('goal B', 1);
    mockConnection.sessionId = undefined;
    mockSessionActions.createSession.mockResolvedValueOnce({
      sessionId: 'session-created',
    });
    const pendingCreate = deferred<{ snapshot: typeof created }>();
    const pendingPause = deferred<{ snapshot: typeof goalB }>();
    mockWorkspaceActions.controlGoal.mockReturnValueOnce(pendingCreate.promise);
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = '/goal first objective';
    await clickSubmit(container);
    await vi.waitFor(() => {
      expect(mockWorkspaceActions.controlGoal).toHaveBeenCalledTimes(1);
    });

    // The user leaves for a session that already has a Goal and pauses it.
    mockSessionActions.getGoal.mockReturnValueOnce(pendingPause.promise);
    act(() => {
      testState.ownerVersion += 1;
      mockConnection.sessionId = 'session-b';
      mockConnection.goalState = goalB;
      rerender({});
    });
    const pause = container.querySelector<HTMLButtonElement>(
      '[data-testid="goal-status-strip"] button[aria-label="Pause goal"]',
    );
    if (!pause) throw new Error('session B pause control was not rendered');
    act(() => pause.click());
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="goal-status-strip"] button[aria-label="Pause goal"]',
      )?.disabled,
    ).toBe(true);

    await act(async () => {
      pendingCreate.resolve({ snapshot: created });
      await flush();
    });

    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="goal-status-strip"] button[aria-label="Pause goal"]',
      )?.disabled,
    ).toBe(true);

    await act(async () => {
      pendingPause.resolve({ snapshot: goalB });
      await flush();
    });
  });

  it('closes the Goal edit dialog when the same session replaces its goal', async () => {
    // Only the goalId-keyed reset effect can close it here — the session key is
    // unchanged — and an open dialog would re-sync its textarea to the new
    // goal's objective while the user believes they are editing the old one.
    const goalA = activeGoalSnapshot('goal A', 5);
    const goalB = {
      ...activeGoalSnapshot('goal B', 1),
      goal: {
        ...activeGoalSnapshot('goal B', 1).goal!,
        goalId: 'goal-b',
      },
    };
    mockConnection.goalState = goalA;
    mockSessionActions.getGoal.mockResolvedValue({ snapshot: goalA });
    const { container, rerender } = renderApp();
    await flush();

    const edit = container.querySelector<HTMLButtonElement>(
      '[data-testid="goal-status-strip"] button[aria-label="Edit goal"]',
    );
    if (!edit) throw new Error('edit control was not rendered');
    act(() => edit.click());
    expect(document.querySelector('textarea')).not.toBeNull();

    act(() => {
      mockConnection.goalState = goalB;
      rerender({});
    });

    expect(document.querySelector('textarea')).toBeNull();
  });

  it('rejects a Goal edit when the same session replaces the goal', async () => {
    const goalA = activeGoalSnapshot('goal A', 5);
    const goalB = {
      ...activeGoalSnapshot('goal B', 1),
      goal: {
        ...activeGoalSnapshot('goal B', 1).goal!,
        goalId: 'goal-b',
      },
    };
    const pendingGoal = deferred<{ snapshot: typeof goalB }>();
    mockConnection.goalState = goalA;
    mockSessionActions.getGoal.mockReturnValueOnce(pendingGoal.promise);
    const { container, rerender } = renderApp();
    await flush();

    const edit = container.querySelector<HTMLButtonElement>(
      '[data-testid="goal-status-strip"] button[aria-label="Edit goal"]',
    );
    if (!edit) throw new Error('edit control was not rendered');
    act(() => edit.click());
    const save = [
      ...document.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent === 'Save');
    if (!save) throw new Error('save control was not rendered');
    act(() => save.click());
    act(() => {
      mockConnection.goalState = goalB;
      rerender({});
    });
    await act(async () => pendingGoal.resolve({ snapshot: goalB }));

    expect(mockSessionActions.controlGoal).not.toHaveBeenCalled();
  });

  it('keeps the Goals page open when canonical creation is rejected', async () => {
    const { container } = renderApp();
    await flush();

    testState.prompt = '/goal';
    await clickSubmit(container);
    await flush();

    const onCreateGoal = testState.latestGoalsProps?.onCreateGoal;
    if (!onCreateGoal) throw new Error('onCreateGoal was not captured');
    mockSessionActions.controlGoal.mockRejectedValueOnce(
      new Error('daemon says no'),
    );

    await act(async () => {
      await expect(onCreateGoal('all tests pass')).rejects.toThrow(
        'daemon says no',
      );
    });

    expect(
      container.querySelector('[data-testid="goals-page"]'),
    ).not.toBeNull();
  });

  it('reuses the empty session left by a rejected canonical creation', async () => {
    const { container } = renderApp();
    await flush();

    testState.prompt = '/goal';
    await clickSubmit(container);
    await flush();

    const onCreateGoal = testState.latestGoalsProps?.onCreateGoal;
    if (!onCreateGoal) throw new Error('onCreateGoal was not captured');
    mockSessionActions.clearSession.mockClear();
    mockSessionActions.controlGoal.mockRejectedValueOnce(
      new Error('daemon says no'),
    );

    await act(async () => {
      await expect(onCreateGoal('all tests pass')).rejects.toThrow(
        'daemon says no',
      );
    });
    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      await onCreateGoal('all tests pass');
    });

    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);
    expect(mockSessionActions.controlGoal).toHaveBeenLastCalledWith({
      action: 'create',
      objective: 'all tests pass',
    });
  });

  it('forgets a rejected goal session after leaving the Goals page', async () => {
    const pendingCreate = deferred<{
      snapshot: ReturnType<typeof activeGoalSnapshot>;
    }>();
    const { container } = renderApp();
    await flush();

    testState.prompt = '/goal';
    await clickSubmit(container);
    await flush();
    const onCreateGoal = testState.latestGoalsProps?.onCreateGoal;
    if (!onCreateGoal) throw new Error('onCreateGoal was not captured');
    mockSessionActions.clearSession.mockClear();
    mockSessionActions.controlGoal.mockReturnValueOnce(pendingCreate.promise);

    let firstCreate!: Promise<void>;
    act(() => {
      firstCreate = onCreateGoal('all tests pass');
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.controlGoal).toHaveBeenCalledOnce();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="goals-page"] button')
        ?.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="goals-page"]')).toBeNull();
    pendingCreate.reject(new Error('daemon says no'));
    await act(async () => {
      await expect(firstCreate).rejects.toThrow('daemon says no');
    });

    testState.prompt = '/goal';
    await clickSubmit(container);
    await flush();
    const retryCreate = testState.latestGoalsProps?.onCreateGoal;
    if (!retryCreate) throw new Error('onCreateGoal was not recaptured');
    await act(async () => {
      await retryCreate('all tests pass');
    });

    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(2);
  });

  it('forgets a stranded session recorded before the user leaves the page', async () => {
    // Reject FIRST, leave the page second: the `[mainView]` cleanup effect is
    // the only thing that forgets the stranded session in that order, and
    // without it a later create reuses a session the user has since turned into
    // a real conversation.
    const { container } = renderApp();
    await flush();

    testState.prompt = '/goal';
    await clickSubmit(container);
    await flush();
    const onCreateGoal = testState.latestGoalsProps?.onCreateGoal;
    if (!onCreateGoal) throw new Error('onCreateGoal was not captured');
    mockSessionActions.clearSession.mockClear();
    mockSessionActions.controlGoal.mockRejectedValueOnce(
      new Error('daemon says no'),
    );

    await act(async () => {
      await expect(onCreateGoal('all tests pass')).rejects.toThrow(
        'daemon says no',
      );
    });
    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="goals-page"] button')
        ?.click();
    });
    await flush();

    testState.prompt = '/goal';
    await clickSubmit(container);
    await flush();
    const retryCreate = testState.latestGoalsProps?.onCreateGoal;
    if (!retryCreate) throw new Error('onCreateGoal was not recaptured');
    await act(async () => {
      await retryCreate('all tests pass');
    });

    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(2);
  });

  it('starts a fresh session for a goal created after a successful one', async () => {
    // A failed create records its session so the retry can reuse it. The
    // success path has to forget it again — otherwise the NEXT create reuses
    // the session the running Goal now owns and degrades into a CAS replace
    // against it.
    const { container } = renderApp();
    await flush();

    testState.prompt = '/goal';
    await clickSubmit(container);
    await flush();
    const onCreateGoal = testState.latestGoalsProps?.onCreateGoal;
    if (!onCreateGoal) throw new Error('onCreateGoal was not captured');
    mockSessionActions.clearSession.mockClear();
    mockSessionActions.controlGoal.mockRejectedValueOnce(
      new Error('daemon says no'),
    );

    await act(async () => {
      await expect(onCreateGoal('all tests pass')).rejects.toThrow(
        'daemon says no',
      );
    });
    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);

    // The retry reuses the stranded session rather than piling up a blank one.
    mockSessionActions.controlGoal.mockResolvedValue({
      snapshot: activeGoalSnapshot('all tests pass'),
    });
    await act(async () => {
      await onCreateGoal('all tests pass');
    });
    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);

    testState.prompt = '/goal';
    await clickSubmit(container);
    await flush();
    const nextCreate = testState.latestGoalsProps?.onCreateGoal;
    if (!nextCreate) throw new Error('onCreateGoal was not recaptured');
    await act(async () => {
      await nextCreate('and lint is clean');
    });

    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a session selected while goal creation is in flight', async () => {
    const pendingCreate = deferred<{
      snapshot: ReturnType<typeof activeGoalSnapshot>;
    }>();
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = '/goal';
    await clickSubmit(container);
    await flush();

    const onCreateGoal = testState.latestGoalsProps?.onCreateGoal;
    if (!onCreateGoal) throw new Error('onCreateGoal was not captured');
    mockSessionActions.clearSession.mockClear();
    mockSessionActions.controlGoal.mockReturnValueOnce(pendingCreate.promise);

    let firstCreate!: Promise<void>;
    act(() => {
      firstCreate = onCreateGoal('all tests pass');
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.controlGoal).toHaveBeenCalledTimes(1);
    });

    act(() => {
      testState.ownerVersion += 1;
      mockConnection.sessionId = 'conversation-session';
      rerender({});
    });
    pendingCreate.reject(new Error('daemon says no'));
    await act(async () => {
      await expect(firstCreate).rejects.toThrow('daemon says no');
    });

    const retryCreate = testState.latestGoalsProps?.onCreateGoal;
    if (!retryCreate) throw new Error('onCreateGoal was not recaptured');
    mockSessionActions.controlGoal.mockResolvedValueOnce({
      snapshot: activeGoalSnapshot('all tests pass'),
    });
    await act(async () => {
      await retryCreate('all tests pass');
    });

    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(2);
  });

  it('locks goal controls while the current snapshot refresh is in flight', async () => {
    const current = activeGoalSnapshot('ship it', 5);
    const pendingGoal = deferred<{ snapshot: typeof current }>();
    mockConnection.goalState = current;
    mockSessionActions.getGoal.mockReturnValueOnce(pendingGoal.promise);
    mockSessionActions.controlGoal.mockResolvedValueOnce({ snapshot: current });
    const { container } = renderApp();
    await flush();

    const pause = container.querySelector<HTMLButtonElement>(
      '[data-testid="goal-status-strip"] button[aria-label="Pause goal"]',
    );
    if (!pause) throw new Error('pause control was not rendered');
    act(() => pause.click());

    expect(pause.disabled).toBe(true);
    act(() => pause.click());
    expect(mockSessionActions.getGoal).toHaveBeenCalledTimes(1);

    await act(async () => pendingGoal.resolve({ snapshot: current }));
    await vi.waitFor(() => {
      expect(mockSessionActions.controlGoal).toHaveBeenCalledTimes(1);
    });
  });

  it('does not dispatch a Goal control after the session changes during refresh', async () => {
    const current = activeGoalSnapshot('ship it', 5);
    const pendingGoal = deferred<{ snapshot: typeof current }>();
    mockConnection.goalState = current;
    mockSessionActions.getGoal.mockReturnValueOnce(pendingGoal.promise);
    const { container, rerender } = renderApp();
    await flush();

    const pause = container.querySelector<HTMLButtonElement>(
      '[data-testid="goal-status-strip"] button[aria-label="Pause goal"]',
    );
    if (!pause) throw new Error('pause control was not rendered');
    act(() => pause.click());
    act(() => {
      testState.ownerVersion += 1;
      mockConnection.sessionId = 'session-b';
      rerender({});
    });
    await act(async () => pendingGoal.resolve({ snapshot: current }));

    expect(mockSessionActions.controlGoal).not.toHaveBeenCalled();
  });

  it('releases Goal control busy state after a same-session reattach', async () => {
    const current = activeGoalSnapshot('ship it', 5);
    const pendingControl = deferred<{ snapshot: typeof current }>();
    mockConnection.goalState = current;
    mockSessionActions.getGoal.mockResolvedValue({ snapshot: current });
    mockSessionActions.controlGoal.mockReturnValueOnce(pendingControl.promise);
    const { container, rerender } = renderApp();
    await flush();

    const pause = container.querySelector<HTMLButtonElement>(
      '[data-testid="goal-status-strip"] button[aria-label="Pause goal"]',
    );
    if (!pause) throw new Error('pause control was not rendered');
    act(() => pause.click());
    await vi.waitFor(() =>
      expect(mockSessionActions.controlGoal).toHaveBeenCalledOnce(),
    );
    act(() => {
      testState.ownerVersion += 1;
      rerender({});
    });
    await act(async () => pendingControl.resolve({ snapshot: current }));

    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="goal-status-strip"] button[aria-label="Pause goal"]',
      )?.disabled,
    ).toBe(false);
  });

  it('reports an edit failure after the edited Goal disappears', async () => {
    const current = activeGoalSnapshot('ship it', 5);
    const pendingGoal = deferred<{
      snapshot: { v: 2; activity: 'idle'; goal: null };
    }>();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    mockConnection.goalState = current;
    mockSessionActions.getGoal.mockReturnValueOnce(pendingGoal.promise);
    const { container, rerender } = renderApp();
    await flush();

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="goal-status-strip"] button[aria-label="Edit goal"]',
        )
        ?.click();
    });
    const save = [
      ...document.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent === 'Save');
    if (!save) throw new Error('save control was not rendered');
    act(() => save.click());
    act(() => {
      mockConnection.goalState = { v: 2, activity: 'idle', goal: null };
      rerender({});
    });
    await act(async () =>
      pendingGoal.resolve({
        snapshot: { v: 2, activity: 'idle', goal: null },
      }),
    );

    expect(consoleError).toHaveBeenCalledWith(
      '[web-shell]',
      expect.stringContaining('goal'),
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it("opens a goal's session in the chat view", async () => {
    // The goal's session transcript IS its history, so the Goals page has to be
    // able to hand off to it. Nothing exercised this wiring before.
    const { container } = renderApp();
    await flush();

    testState.prompt = '/goal';
    await clickSubmit(container);
    await flush();
    expect(
      container.querySelector('[data-testid="goals-page"]'),
    ).not.toBeNull();

    const onOpenSession = testState.latestGoalsProps?.onOpenSession;
    if (!onOpenSession) throw new Error('onOpenSession was not captured');
    mockSessionActions.loadSession.mockClear();

    await act(async () => {
      onOpenSession('goal-session-9');
    });
    await flush();

    // Pin the session id, not the options bag — main added a `{ workspaceCwd }`
    // second argument and will likely keep evolving it; the id is what this test
    // is about.
    expect(mockSessionActions.loadSession.mock.calls[0][0]).toBe(
      'goal-session-9',
    );
    // It must leave the Goals page, or the user loads a transcript they cannot see.
    expect(container.querySelector('[data-testid="goals-page"]')).toBeNull();
  });

  it("reports a failure to open a goal's session instead of swallowing it", async () => {
    const { container } = renderApp();
    await flush();

    testState.prompt = '/goal';
    await clickSubmit(container);
    await flush();

    const onOpenSession = testState.latestGoalsProps?.onOpenSession;
    if (!onOpenSession) throw new Error('onOpenSession was not captured');
    mockSessionActions.loadSession.mockRejectedValueOnce(
      new Error('session is gone'),
    );
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    await act(async () => {
      onOpenSession('goal-session-9');
    });
    await flush();

    // `loadSidebarSession` rethrows, so the handler's own `.catch` is the only
    // thing standing between a dead session and an unhandled rejection. It has
    // to route the failure to `reportError` (console + toast), not swallow it.
    expect(consoleError).toHaveBeenCalledWith(
      '[web-shell]',
      expect.stringContaining('session is gone'),
      expect.anything(),
    );
    consoleError.mockRestore();
  });

  it('does not drop the goal into the current session when the new session fails', async () => {
    const { container } = renderApp();
    await flush();

    testState.prompt = '/goal';
    await clickSubmit(container);
    await flush();

    const onCreateGoal = testState.latestGoalsProps?.onCreateGoal;
    if (!onCreateGoal) throw new Error('onCreateGoal was not captured');
    mockSessionActions.clearSession.mockRejectedValueOnce(
      new Error('daemon unreachable'),
    );
    mockSessionActions.controlGoal.mockClear();

    await act(async () => {
      await onCreateGoal('all tests pass');
    });

    expect(mockSessionActions.controlGoal).not.toHaveBeenCalled();
  });
});

describe('App manual-run orchestration (scheduled tasks)', () => {
  // Drives App's real runTaskManually / enqueueManualRun / tryFireBoundRun via
  // the onRunPrompt prop the (captured) ScheduledTasksDialog mock receives.
  // Opening the page with /schedule mounts the dialog and captures the handler.
  async function openRunHandler(
    container: HTMLElement,
  ): Promise<(prompt: string, sessionId: string | null) => Promise<void>> {
    mockConnection.goalState ??= {
      v: 2,
      activity: 'idle',
      goal: null,
    };
    testState.prompt = '/schedule';
    await clickSubmit(container);
    await flush();
    const handler = testState.latestScheduledTasksProps?.onRunPrompt;
    if (!handler) throw new Error('onRunPrompt was not captured');
    return handler;
  }

  // Make sendPrompt admit the prompt (fire onAdmitted) then resolve, the normal
  // "daemon accepted it" path.
  const admitOnSend = () =>
    mockSessionActions.sendPrompt.mockImplementation(
      (_text: string, opts?: { onAdmitted?: () => void }) => {
        opts?.onAdmitted?.();
        return Promise.resolve(undefined);
      },
    );

  it('resolves an unbound run once the daemon admits the prompt', async () => {
    admitOnSend();
    const { container } = renderApp();
    await flush();
    const run = await openRunHandler(container);
    await act(async () => {
      await expect(run('do the thing', null)).resolves.toBeUndefined();
    });
  });

  it('rejects an unbound run that settles without admitting (cancel path)', async () => {
    // Default sendPrompt resolves WITHOUT onAdmitted → onSubmitBefore cancel /
    // never reached the session: the caller must skip recording a run.
    const { container } = renderApp();
    await flush();
    const run = await openRunHandler(container);
    await act(async () => {
      await expect(run('do the thing', null)).rejects.toThrow(
        /cancelled before it started/,
      );
    });
  });

  it('rejects an unbound run when the send throws before admission', async () => {
    mockSessionActions.sendPrompt.mockRejectedValue(new Error('daemon boom'));
    const { container } = renderApp();
    await flush();
    const run = await openRunHandler(container);
    await act(async () => {
      await expect(run('do the thing', null)).rejects.toThrow('daemon boom');
    });
  });

  it('rejects an unbound run before admission while Goal is active', async () => {
    mockConnection.goalState = activeGoalSnapshot('keep working');
    const { container } = renderApp();
    await flush();
    const run = await openRunHandler(container);

    await act(async () => {
      await expect(run('do the thing', null)).rejects.toThrow(/Goal is active/);
    });
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
  });

  it('rejects an unbound run while Goal state is hydrating', async () => {
    mockConnection.goalState = undefined;
    const { container } = renderApp();
    await flush();
    const run = await openRunHandler(container);
    mockConnection.goalState = undefined;

    await act(async () => {
      await expect(run('do the thing', null)).rejects.toThrow(/Goal is active/);
    });
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
  });

  it('starts an unbound manual run when no session is attached yet', async () => {
    // Session-less means no Goal can exist and `sendPrompt` allocates a session
    // itself, so gating the run on an unknown Goal state here would make every
    // Run now on a fresh workspace fail.
    admitOnSend();
    const { container, rerender } = renderApp();
    await flush();
    const run = await openRunHandler(container);
    act(() => {
      mockConnection.sessionId = undefined;
      mockConnection.goalState = undefined;
      rerender({});
    });

    await act(async () => {
      await expect(run('do the thing', null)).resolves.toBeUndefined();
    });
    expect(mockSessionActions.sendPrompt).toHaveBeenCalled();
  });

  it('waits for bound-session Goal hydration before admitting a run', async () => {
    const { container, rerender } = renderApp();
    await flush();
    const run = await openRunHandler(container);
    act(() => {
      mockConnection.goalState = undefined;
      rerender({});
    });

    let runError: unknown;
    act(() => {
      void run('do the thing', 'session-1').catch((error) => {
        runError = error;
      });
    });
    await flush();
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();

    act(() => {
      mockConnection.goalState = activeGoalSnapshot('keep working');
      rerender({});
    });
    await vi.waitFor(() => {
      expect((runError as Error | undefined)?.message).toMatch(
        /Goal is active/,
      );
    });
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
  });

  it('fires a bound run immediately when its session is already active', async () => {
    admitOnSend();
    const { container } = renderApp();
    await flush();
    const run = await openRunHandler(container);
    // session-1 is the current, fully-loaded session, so tryFireBoundRun fires
    // right after loadSidebarSession without waiting on a dep-change effect.
    await act(async () => {
      await expect(run('do the thing', 'session-1')).resolves.toBeUndefined();
    });
    expect(mockSessionActions.loadSession).toHaveBeenCalledWith('session-1', {
      workspaceCwd: undefined,
    });
  });

  it('supersedes an older pending bound run with a newer one', async () => {
    // Neither target is the active session, so both stay latched; the second
    // must reject the first so its caller does not record a dropped run.
    const { container } = renderApp();
    await flush();
    const run = await openRunHandler(container);
    vi.useFakeTimers();
    let firstErr: unknown;
    let second: Promise<void> | undefined;
    await act(async () => {
      void run('first', 'sess-A').catch((e) => {
        firstErr = e;
      });
      second = run('second', 'sess-B').catch(() => {});
      await Promise.resolve();
    });
    expect((firstErr as Error | undefined)?.message).toMatch(/superseded/);
    vi.clearAllTimers();
    void second;
  });

  it('does not let an old same-target failure clear a newer bound run', async () => {
    admitOnSend();
    const { container, rerender } = renderApp();
    await flush();
    const run = await openRunHandler(container);
    const firstRestore = deferred<void>();
    const secondRestore = deferred<void>();
    mockSessionActions.loadSession
      .mockReturnValueOnce(firstRestore.promise)
      .mockReturnValueOnce(secondRestore.promise);
    let firstError: unknown;
    let secondSettled = false;

    await act(async () => {
      void run('first', 'same-target').catch((error) => {
        firstError = error;
      });
      void run('second', 'same-target').then(
        () => {
          secondSettled = true;
        },
        () => {
          secondSettled = true;
        },
      );
      await Promise.resolve();
    });
    expect((firstError as Error | undefined)?.message).toMatch(/superseded/);

    await act(async () => {
      firstRestore.reject(new Error('old restore failed'));
      await Promise.resolve();
    });
    expect(secondSettled).toBe(false);

    mockConnection.sessionId = 'same-target';
    await act(async () => {
      secondRestore.resolve();
      rerender();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(secondSettled).toBe(true));
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      'second',
      expect.any(Object),
    );
  });

  it('does not apply the catch-up timeout while restore is pending', async () => {
    const { container } = renderApp();
    await flush();
    const run = await openRunHandler(container);
    const restore = deferred<void>();
    mockSessionActions.loadSession.mockReturnValueOnce(restore.promise);
    vi.useFakeTimers();
    let err: unknown;
    await act(async () => {
      void run('do the thing', 'never-active').catch((e) => {
        err = e;
      });
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(err).toBeUndefined();
    await act(async () => {
      restore.reject(new Error('restore timed out'));
      await Promise.resolve();
    });
    expect((err as Error | undefined)?.message).toBe('restore timed out');
  });

  it('starts the 30 second timeout only after commit while catching up', async () => {
    const { container } = renderApp();
    await flush();
    const run = await openRunHandler(container);
    mockSessionActions.loadSession.mockImplementationOnce(async () => {
      mockConnection.sessionId = 'bound-session';
      mockConnection.catchingUp = true;
    });
    vi.useFakeTimers();
    let err: unknown;
    await act(async () => {
      void run('do the thing', 'bound-session').catch((error) => {
        err = error;
      });
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(29_999);
    });
    expect(err).toBeUndefined();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect((err as Error | undefined)?.message).toMatch(/session replay/);
  });

  it('"create via chat" starts a fresh session and primes the composer', async () => {
    const { container } = renderApp();
    await flush();
    testState.prompt = '/schedule';
    await clickSubmit(container);
    await flush();
    const onCreateViaChat =
      testState.latestScheduledTasksProps?.onCreateViaChat;
    if (!onCreateViaChat) throw new Error('onCreateViaChat was not captured');
    mockSessionActions.clearSession.mockClear();
    editorInsertText.mockClear();
    await act(async () => {
      onCreateViaChat();
    });
    await flush();
    // Jumps to a NEW session (clearSession is how createNewSession starts one)
    // rather than piling the task-creation chat onto the current conversation.
    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);
    // ...then primes the composer with the task starter (deferred one tick).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(editorInsertText).toHaveBeenCalled();
  });

  it('does not start task creation in an untrusted primary workspace', async () => {
    mockWorkspace.capabilities = {
      workspaceCwd: '/tmp/project',
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: false,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const { container } = renderApp();
    await flush();
    testState.prompt = '/schedule';
    await clickSubmit(container);
    await flush();
    const onCreateViaChat =
      testState.latestScheduledTasksProps?.onCreateViaChat;
    if (!onCreateViaChat) throw new Error('onCreateViaChat was not captured');
    mockSessionActions.clearSession.mockClear();
    editorInsertText.mockClear();

    act(() => onCreateViaChat());
    await flush();

    expect(mockSessionActions.clearSession).not.toHaveBeenCalled();
    expect(editorInsertText).not.toHaveBeenCalled();
  });

  it('"create via chat" does NOT prime the composer when the new session fails', async () => {
    // If createNewSession() fails, the error is already surfaced — priming the
    // (still-current) session would drop the task starter into the wrong chat.
    const { container } = renderApp();
    await flush();
    testState.prompt = '/schedule';
    await clickSubmit(container);
    await flush();
    const onCreateViaChat =
      testState.latestScheduledTasksProps?.onCreateViaChat;
    if (!onCreateViaChat) throw new Error('onCreateViaChat was not captured');
    mockSessionActions.clearSession.mockClear();
    mockSessionActions.clearSession.mockRejectedValueOnce(new Error('boom'));
    editorInsertText.mockClear();
    await act(async () => {
      onCreateViaChat();
    });
    await flush();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1); // attempted
    expect(editorInsertText).not.toHaveBeenCalled(); // but priming skipped
  });
});

describe('fileUploadEnabled customization plumbing', () => {
  it('reaches the composer customization when the host disables upload', () => {
    const { container } = renderApp({ fileUploadEnabled: false });
    const composer = container.querySelector('[data-web-shell-composer]');
    expect(composer?.getAttribute('data-file-upload-enabled')).toBe('false');
  });

  it('leaves the customization unset when the prop is omitted', () => {
    const { container } = renderApp({});
    const composer = container.querySelector('[data-web-shell-composer]');
    expect(composer?.hasAttribute('data-file-upload-enabled')).toBe(false);
  });

  it('reaches the composer customization with the upload directory', () => {
    const { container } = renderApp({ fileUploadDirectory: 'uploads' });
    const composer = container.querySelector('[data-web-shell-composer]');
    expect(composer?.getAttribute('data-file-upload-directory')).toBe(
      'uploads',
    );
  });

  it('leaves the upload directory unset when the prop is omitted', () => {
    const { container } = renderApp({});
    const composer = container.querySelector('[data-web-shell-composer]');
    expect(composer?.hasAttribute('data-file-upload-directory')).toBe(false);
  });
});

describe('App connection error reporting (#10406)', () => {
  it('reports a persistent connection error once even while host re-renders pass a fresh inline onError', async () => {
    // Daemon unreachable: connection.error persists. A host may store each
    // reported error in its own state, which re-renders the host and hands
    // App an onError with a fresh identity (inline or otherwise). Before the
    // fix, every new callback identity re-fired the notification effect for
    // the same persistent error — an infinite re-render loop.
    mockConnection.error = 'daemon unreachable';
    const calls: string[] = [];
    const HOST_NOTICE_CAP = 5;

    function Host() {
      const [noticeCount, setNoticeCount] = useState(0);
      return (
        <App
          sidebar={{ enabled: true }}
          header={{}}
          onError={(error: Error) => {
            calls.push(error.message);
            if (noticeCount < HOST_NOTICE_CAP) {
              setNoticeCount((count) => count + 1);
            }
          }}
        />
      );
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Host />);
    });
    await flush();
    await act(async () => {
      root.unmount();
    });
    container.remove();

    expect(calls).toEqual(['daemon unreachable']);
  });

  it('still reports when the connection error changes to a different value', async () => {
    mockConnection.error = 'daemon unreachable';
    const calls: string[] = [];
    const { rerender } = renderApp({
      onError: (error) => calls.push(error.message),
    });
    await flush();
    expect(calls).toEqual(['daemon unreachable']);

    mockConnection.error = 'session missing';
    rerender({ onError: (error) => calls.push(error.message) });
    await flush();

    expect(calls).toEqual(['daemon unreachable', 'session missing']);
  });

  it('reports a recurring error again after the connection recovers', async () => {
    mockConnection.error = 'daemon unreachable';
    const calls: string[] = [];
    const onError = (error: Error) => calls.push(error.message);
    const { rerender } = renderApp({ onError });
    await flush();
    expect(calls).toEqual(['daemon unreachable']);

    mockConnection.error = undefined;
    rerender({ onError });
    await flush();

    mockConnection.error = 'daemon unreachable';
    rerender({ onError });
    await flush();

    expect(calls).toEqual(['daemon unreachable', 'daemon unreachable']);
  });

  it('delivers a persistent error once when the host attaches onError after it appears', async () => {
    // onError is optional: a host may mount while a connection error is
    // already active and only attach its handler on a later render. The
    // pending error must still be delivered exactly once.
    mockConnection.error = 'daemon unreachable';
    const calls: string[] = [];
    const { rerender } = renderApp({});
    await flush();
    expect(calls).toEqual([]);

    rerender({ onError: (error) => calls.push(error.message) });
    await flush();

    expect(calls).toEqual(['daemon unreachable']);
  });
});
