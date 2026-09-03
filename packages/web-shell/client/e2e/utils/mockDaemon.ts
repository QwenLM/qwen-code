import type { Page, Route } from '@playwright/test';
import {
  DAEMON_APPROVAL_MODES,
  type DaemonApprovalMode,
  type DaemonCapabilities,
  type DaemonChannelsSnapshot,
  type DaemonChannelPairingRequest,
  type DaemonChannelTypeCatalog,
  type DaemonPersistedBranchedSession,
  type DaemonEvent,
  type DaemonRestoredSession,
  type DaemonSession,
  type DaemonSessionArtifact,
  type DaemonSessionArtifactsEnvelope,
  type DaemonSessionGroup,
  type DaemonSessionGroupCatalog,
  type DaemonSessionCatalogVersion,
  type DaemonSessionState,
  type DaemonSessionSummary,
  type DaemonRestoredStandaloneSession,
  type DaemonStandaloneSession,
  type DaemonStandaloneSessionSummary,
  type DaemonWorkspaceExtensionsStatus,
  type DaemonWorkspaceFile,
  type DaemonGitHubPullRequestList,
  type DaemonWorkspaceGitStatus,
  type DaemonWorkspaceMcpResourcesStatus,
  type DaemonWorkspaceMcpStatus,
  type WorkspaceExtensionProjection,
  type DaemonWorkspaceHooksStatus,
  type DaemonWorkspaceMemoryStatus,
  type DaemonWorkspaceMcpToolsStatus,
  type DaemonWorkspaceProvidersStatus,
  type DaemonWorkspaceSettingsStatus,
  type DaemonWorkspaceSkillsStatus,
  type DaemonWorkspaceToolsStatus,
  type DaemonWorkspaceVoiceStatus,
  type ExtensionActiveOperations,
  type ExtensionUpdateCheckResponse,
  type GoalControlRequest,
  type GoalSnapshotV2,
  type PermissionResponse,
  type PromptRequest,
} from '@qwen-code/sdk/daemon';
import { installSseTransport, type SseTransport } from './sseTransport';

export interface DaemonRequestRecord {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

export interface WebShellDaemonScenario {
  workspaceCwd: string;
  sessionId: string;
  clientId: string;
  displayName: string;
  currentModel: string;
  currentMode: string;
  capabilities: DaemonCapabilities;
  /** Extra fields merged into `GET /session/:id/supported-commands`. */
  supportedCommands?: Record<string, unknown>;
  /** Tasks returned by `GET /session/:id/tasks` (workflow snapshots included). */
  workflowTasks?: unknown[];
  /** Definitions served by `GET /session/:id/saved-workflows/:name`, keyed by name. */
  savedWorkflowDetails?: Record<string, Record<string, unknown>>;
  providers: DaemonWorkspaceProvidersStatus;
  skills: DaemonWorkspaceSkillsStatus;
  settings: DaemonWorkspaceSettingsStatus;
  voice: DaemonWorkspaceVoiceStatus;
  extensions: DaemonWorkspaceExtensionsStatus;
  extensionOperations: ExtensionActiveOperations;
  extensionUpdateCheck: ExtensionUpdateCheckResponse;
  mcp: DaemonWorkspaceMcpStatus;
  /**
   * Per-workspace overrides for the sidebar overview facets, keyed by the
   * workspace cwd the qualified route names. Unlisted workspaces answer the
   * scenario-level `mcp` / `skills` and empty daemon-side facets, so a spec
   * can give a secondary workspace counts that differ from the primary's.
   */
  workspaceOverviews: Record<string, WorkspaceOverviewOverrides>;
  channelTypes: DaemonChannelTypeCatalog;
  channels: DaemonChannelsSnapshot;
  pairingRequests: Record<string, DaemonChannelPairingRequest[]>;
  pairingApprovals: Record<string, string[]>;
  pairingGroupApprovals: Record<string, string[]>;
  sessions: DaemonSessionSummary[];
  standaloneSessions: DaemonStandaloneSessionSummary[];
  standaloneCreateError?: {
    status: number;
    code: string;
    message: string;
  };
  sessionGroups: DaemonSessionGroup[];
  sessionCatalogVersion: DaemonSessionCatalogVersion;
  events: DaemonEvent[];
  state: DaemonSessionState;
  contextDelayMs?: number;
  providersDelayMs?: number;
  /** Artifact list returned by `GET /session/:id/artifacts`. */
  artifacts: DaemonSessionArtifact[];
  /** File contents served by `GET /file?path=...`, keyed by requested path. */
  workspaceFiles: Record<string, string>;
  /**
   * Response for `GET /workspaces/:cwd/git`. Defaults to a null-branch status
   * (non-git workspace), matching the real daemon's graceful degradation.
   */
  gitStatus?: DaemonWorkspaceGitStatus;
  /**
   * Response for `GET /workspaces/:cwd/github/prs`. Defaults to an available,
   * empty pull-request list.
   */
  gitHubPrs?: DaemonGitHubPullRequestList;
  /** Response for `GET /workspaces/:cwd/git/branches`. */
  gitBranches?: unknown;
  /** Response for `GET /workspaces/:cwd/git/diff`. */
  gitDiff?: unknown;
  /** Response for `GET /workspaces/:cwd/git/log`. */
  gitLog?: unknown;
  /** Response for `POST /session/:id/btw`. */
  btwAnswer?: string;
  goalSnapshot: GoalSnapshotV2;
  midTurnMessages: Array<{ messageId: string; text: string }>;
  /** Stateful response and replay used by historical branch E2E flows. */
  branch?: {
    sessionId: string;
    clientId?: string;
    displayName: string;
    events: DaemonEvent[];
  };
}

export interface MockDaemonController {
  scenario: WebShellDaemonScenario;
  sse: SseTransport<DaemonEvent>;
  requests: readonly DaemonRequestRecord[];
  sendEvent(event: DaemonEvent): Promise<void>;
  burstEvents(events: readonly DaemonEvent[]): Promise<void>;
  promptRequests(): DaemonRequestRecord[];
  permissionRequests(): DaemonRequestRecord[];
  modelRequests(): DaemonRequestRecord[];
  branchRequests(): DaemonRequestRecord[];
  configOptionRequests(): DaemonRequestRecord[];
}

export interface WorkspaceOverviewOverrides {
  mcp?: Partial<DaemonWorkspaceMcpStatus>;
  skills?: Partial<DaemonWorkspaceSkillsStatus>;
  extensions?: Partial<WorkspaceExtensionProjection>;
  memory?: Partial<DaemonWorkspaceMemoryStatus>;
  hooks?: Partial<DaemonWorkspaceHooksStatus>;
}

type ScenarioOverrides = Partial<
  Omit<
    WebShellDaemonScenario,
    | 'capabilities'
    | 'providers'
    | 'skills'
    | 'settings'
    | 'voice'
    | 'extensions'
    | 'extensionOperations'
    | 'extensionUpdateCheck'
    | 'mcp'
    | 'workspaceOverviews'
    | 'channelTypes'
    | 'channels'
    | 'pairingRequests'
    | 'pairingApprovals'
    | 'pairingGroupApprovals'
    | 'sessions'
    | 'sessionGroups'
    | 'sessionCatalogVersion'
    | 'state'
  >
> & {
  capabilities?: Partial<DaemonCapabilities>;
  providers?: Partial<DaemonWorkspaceProvidersStatus>;
  skills?: Partial<DaemonWorkspaceSkillsStatus>;
  settings?: Partial<DaemonWorkspaceSettingsStatus>;
  voice?: Partial<DaemonWorkspaceVoiceStatus>;
  extensions?: Partial<DaemonWorkspaceExtensionsStatus>;
  extensionOperations?: Partial<ExtensionActiveOperations>;
  extensionUpdateCheck?: Partial<ExtensionUpdateCheckResponse>;
  mcp?: Partial<DaemonWorkspaceMcpStatus>;
  workspaceOverviews?: Record<string, WorkspaceOverviewOverrides>;
  channelTypes?: DaemonChannelTypeCatalog;
  channels?: DaemonChannelsSnapshot;
  pairingRequests?: Record<string, DaemonChannelPairingRequest[]>;
  pairingApprovals?: Record<string, string[]>;
  pairingGroupApprovals?: Record<string, string[]>;
  sessions?: DaemonSessionSummary[];
  sessionGroups?: DaemonSessionGroup[];
  sessionCatalogVersion?: DaemonSessionCatalogVersion;
  state?: Partial<DaemonSessionState>;
};

const now = '2026-07-03T00:00:00.000Z';

export function applyScenarioCurrentModel(
  scenario: WebShellDaemonScenario,
  modelId: string,
): void {
  scenario.currentModel = modelId;
  const models =
    scenario.state.models && typeof scenario.state.models === 'object'
      ? scenario.state.models
      : {};
  scenario.state.models = {
    ...models,
    currentModelId: modelId,
  };
  scenario.providers = {
    ...scenario.providers,
    current: {
      ...scenario.providers.current,
      modelId,
      fastModelId: modelId,
    },
    providers: scenario.providers.providers.map((provider) => ({
      ...provider,
      models: provider.models?.map((model) => ({
        ...model,
        isCurrent: model.modelId === modelId,
      })),
    })),
  };
}

export function createWebShellDaemonScenario(
  overrides: ScenarioOverrides = {},
): WebShellDaemonScenario {
  const workspaceCwd = overrides.workspaceCwd ?? '/tmp/qwen-web-shell-e2e';
  const sessionId = overrides.sessionId ?? 'web-shell-e2e-session';
  const clientId = overrides.clientId ?? 'web-shell-e2e-client';
  const displayName = overrides.displayName ?? 'E2E Harness Session';
  const currentModel = overrides.currentModel ?? 'qwen-test';
  const currentMode = overrides.currentMode ?? 'default';
  const state: DaemonSessionState = {
    displayName,
    models: {
      currentModelId: currentModel,
      availableModels: [
        {
          modelId: currentModel,
          baseModelId: currentModel,
          name: 'Qwen Test',
          contextLimit: 32_768,
        },
        {
          modelId: 'qwen-test-alt',
          baseModelId: 'qwen-test-alt',
          name: 'Qwen Test Alt',
          contextLimit: 16_384,
        },
      ],
    },
    modes: {
      currentModeId: currentMode,
    },
    ...(overrides.state ?? {}),
  };

  const capabilities: DaemonCapabilities = {
    v: 1,
    mode: 'http-bridge',
    features: [
      'session_events',
      'permission_vote',
      'session_permission_vote',
      'session_scope_override',
      'session_source_metadata',
      'workspace_settings',
      'workspace_voice',
    ],
    modelServices: ['qwen-test'],
    transports: ['rest-sse'],
    workspaceCwd,
    qwenCodeVersion: '0.0.0-e2e',
    ...(overrides.capabilities ?? {}),
  };

  const providers: DaemonWorkspaceProvidersStatus = {
    v: 1,
    workspaceCwd,
    initialized: true,
    acpChannelLive: true,
    approvalMode: currentMode as DaemonWorkspaceProvidersStatus['approvalMode'],
    current: {
      authType: 'qwen-oauth',
      modelId: currentModel,
      fastModelId: currentModel,
    },
    providers: [
      {
        kind: 'model_provider',
        status: 'ok',
        authType: 'qwen-oauth',
        current: true,
        models: [
          {
            modelId: currentModel,
            baseModelId: currentModel,
            name: 'Qwen Test',
            contextLimit: 32_768,
            isCurrent: true,
            isRuntime: true,
          },
          {
            modelId: 'qwen-test-alt',
            baseModelId: 'qwen-test-alt',
            name: 'Qwen Test Alt',
            contextLimit: 16_384,
            isCurrent: false,
            isRuntime: true,
          },
        ],
      },
    ],
    ...(overrides.providers ?? {}),
  };

  const skills: DaemonWorkspaceSkillsStatus = {
    v: 1,
    workspaceCwd,
    initialized: true,
    skills: [],
    ...(overrides.skills ?? {}),
  };

  const settings: DaemonWorkspaceSettingsStatus = {
    v: 1,
    settings: [],
    ...(overrides.settings ?? {}),
  };

  const voice: DaemonWorkspaceVoiceStatus = {
    v: 1,
    workspaceCwd,
    enabled: false,
    mode: 'hold',
    language: 'en',
    voiceModel: null,
    availableVoiceModels: [],
    ...(overrides.voice ?? {}),
  };

  const extensions: DaemonWorkspaceExtensionsStatus = {
    v: 1,
    workspaceCwd,
    initialized: true,
    extensions: [],
    errors: [],
    ...(overrides.extensions ?? {}),
  };

  const extensionOperations: ExtensionActiveOperations = {
    v: 1,
    operations: [],
    ...(overrides.extensionOperations ?? {}),
  };

  const extensionUpdateCheck: ExtensionUpdateCheckResponse = {
    states: {},
    ...(overrides.extensionUpdateCheck ?? {}),
  };

  const mcp: DaemonWorkspaceMcpStatus = {
    v: 1,
    workspaceCwd,
    initialized: true,
    discoveryState: 'completed',
    servers: [],
    errors: [],
    clientCount: 0,
    budgetMode: 'off',
    budgets: [],
    ...(overrides.mcp ?? {}),
  };

  const sessions = overrides.sessions ?? [
    {
      sessionId,
      workspaceCwd,
      createdAt: now,
      updatedAt: now,
      displayName,
      clientCount: 1,
      hasActivePrompt: false,
    },
    {
      sessionId: 'previous-session',
      workspaceCwd,
      createdAt: now,
      updatedAt: now,
      displayName: 'Previous Session',
      clientCount: 0,
      hasActivePrompt: false,
    },
  ];

  return {
    workspaceCwd,
    sessionId,
    clientId,
    displayName,
    currentModel,
    currentMode,
    capabilities,
    providers,
    skills,
    settings,
    voice,
    extensions,
    extensionOperations,
    extensionUpdateCheck,
    mcp,
    workspaceOverviews: overrides.workspaceOverviews ?? {},
    channelTypes: overrides.channelTypes ?? [],
    channels: overrides.channels ?? { revision: '1', instances: {} },
    pairingRequests: overrides.pairingRequests ?? {},
    pairingApprovals: overrides.pairingApprovals ?? {},
    pairingGroupApprovals: overrides.pairingGroupApprovals ?? {},
    sessions,
    standaloneSessions: overrides.standaloneSessions ?? [],
    standaloneCreateError: overrides.standaloneCreateError,
    sessionGroups: overrides.sessionGroups ?? [],
    sessionCatalogVersion: overrides.sessionCatalogVersion ?? {
      generation: 'web-shell-e2e',
      revision: 0,
    },
    events: overrides.events ?? [],
    state,
    contextDelayMs: overrides.contextDelayMs,
    supportedCommands: overrides.supportedCommands,
    workflowTasks: overrides.workflowTasks,
    savedWorkflowDetails: overrides.savedWorkflowDetails,
    providersDelayMs: overrides.providersDelayMs,
    artifacts: overrides.artifacts ?? [],
    workspaceFiles: overrides.workspaceFiles ?? {},
    gitStatus: overrides.gitStatus,
    gitHubPrs: overrides.gitHubPrs,
    gitBranches: overrides.gitBranches,
    gitDiff: overrides.gitDiff,
    gitLog: overrides.gitLog,
    btwAnswer: overrides.btwAnswer,
    goalSnapshot: overrides.goalSnapshot ?? {
      v: 2,
      goal: null,
      activity: 'idle',
    },
    midTurnMessages: overrides.midTurnMessages ?? [],
    branch: overrides.branch,
  };
}

export async function installMockDaemon(
  page: Page,
  scenario: WebShellDaemonScenario,
  options: { baseURL?: string } = {},
): Promise<MockDaemonController> {
  const baseURL = options.baseURL ?? getPlaywrightBaseURL();
  const baseOrigin = new URL(baseURL).origin;
  const requests: DaemonRequestRecord[] = [];
  const sse = await installSseTransport<DaemonEvent>(page, { baseURL });

  await page.route(`${baseOrigin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;

    if (url.origin !== baseOrigin) {
      await route.fallback();
      return;
    }

    if (!isDaemonPath(path)) {
      await route.fallback();
      return;
    }

    const body = readRequestBody(request.postData());
    requests.push({
      method,
      path,
      body,
      headers: request.headers(),
    });

    if (!isDaemonRoute(method, path)) {
      await methodNotAllowed(route, method, path);
      return;
    }

    await handleDaemonRoute(
      route,
      method,
      path,
      scenario,
      body,
      url.searchParams,
    );
  });

  return {
    scenario,
    sse,
    requests,
    sendEvent: (event) => sse.send(event),
    burstEvents: (events) => sse.burst(events),
    promptRequests: () =>
      requests.filter((request) =>
        /\/session\/[^/]+\/prompt\/?$/.test(request.path),
      ),
    permissionRequests: () =>
      requests.filter((request) => /\/permission\/[^/]+$/.test(request.path)),
    modelRequests: () =>
      requests.filter((request) =>
        /\/session\/[^/]+\/model$/.test(request.path),
      ),
    branchRequests: () =>
      requests.filter((request) =>
        /\/session\/[^/]+\/branch\/?$/.test(request.path),
      ),
    configOptionRequests: () =>
      requests.filter((request) =>
        /\/session\/[^/]+\/config-option$/.test(request.path),
      ),
  };
}

export function userTextEvent(
  text: string,
  options: { id?: number; sessionId?: string } = {},
): DaemonEvent {
  return sessionUpdateEvent(
    {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text },
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    },
    options.id,
  );
}

export function assistantTextEvent(
  text: string,
  options: {
    id?: number;
    sessionId?: string;
    branchRecordId?: string;
  } = {},
): DaemonEvent {
  return sessionUpdateEvent(
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.branchRecordId
        ? {
            _meta: {
              qwenTranscript: { branchRecordId: options.branchRecordId },
            },
          }
        : {}),
    },
    options.id,
  );
}

export function thoughtTextEvent(
  text: string,
  options: { id?: number; sessionId?: string } = {},
): DaemonEvent {
  return sessionUpdateEvent(
    {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text },
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    },
    options.id,
  );
}

export function toolCallEvent(
  toolCallId: string,
  toolName: string,
  rawInput: Record<string, unknown>,
  options: { id?: number; rawOutput?: Record<string, unknown> } = {},
): DaemonEvent {
  return sessionUpdateEvent(
    {
      sessionUpdate: 'tool_call',
      toolCallId,
      toolName,
      title: toolName,
      kind: 'other',
      status: 'completed',
      rawInput,
      ...(options.rawOutput ? { rawOutput: options.rawOutput } : {}),
    },
    options.id,
  );
}

export function turnCompleteEvent(
  promptId: string,
  options: { id?: number; sessionId?: string } = {},
): DaemonEvent {
  return {
    ...(options.id !== undefined ? { id: options.id } : {}),
    v: 1,
    type: 'turn_complete',
    data: {
      promptId,
      sessionId: options.sessionId,
      stopReason: 'end_turn',
    },
  };
}

export function replayCompleteEvent(
  options: { replayedCount?: number; sessionId?: string } = {},
): DaemonEvent {
  return {
    v: 1,
    type: 'replay_complete',
    data: {
      sessionId: options.sessionId,
      replayedCount: options.replayedCount ?? 0,
    },
  };
}

export function permissionRequestEvent(
  requestId: string,
  options: { id?: number; sessionId?: string } = {},
): DaemonEvent {
  return {
    ...(options.id !== undefined ? { id: options.id } : {}),
    v: 1,
    type: 'permission_request',
    data: {
      requestId,
      sessionId: options.sessionId,
      toolCall: {
        name: 'Bash',
        input: {
          command: 'printf web-shell-e2e',
        },
      },
      options: [
        { optionId: 'allow_once', label: 'Allow once' },
        { optionId: 'reject_once', label: 'Reject' },
      ],
    },
  };
}

function sessionUpdateEvent(
  update: Record<string, unknown>,
  id?: number,
): DaemonEvent {
  return {
    ...(id !== undefined ? { id } : {}),
    v: 1,
    type: 'session_update',
    data: { update },
  };
}

function getPlaywrightBaseURL(): string {
  const port = process.env['PLAYWRIGHT_PORT'] ?? '5174';
  return process.env['PLAYWRIGHT_BASE_URL'] ?? `http://127.0.0.1:${port}`;
}

function readRequestBody(raw: string | null): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// Mirror production query modes: `group=pinned` is the pinned bucket;
// `group=all` (and missing group) returns the full active list. The UI
// renders pinned rows in the Pinned section and keeps them inside their
// named groups; unassigned pinned rows stay out of Ungrouped.
function filterScenarioSessions(
  scenario: WebShellDaemonScenario,
  searchParams: URLSearchParams,
): DaemonSessionSummary[] {
  const group = searchParams.get('group');
  const sourceType = searchParams.get('sourceType');
  const sourceSessions = sourceType
    ? scenario.sessions.filter(
        (session) =>
          session.sourceType === sourceType ||
          (sourceType === 'default' && session.sourceType === undefined),
      )
    : scenario.sessions;
  return group === 'pinned'
    ? sourceSessions.filter((session) => Boolean(session.isPinned))
    : sourceSessions;
}

function isDaemonPath(path: string): boolean {
  return (
    path === '/health' ||
    path === '/capabilities' ||
    path === '/workspace/settings' ||
    path === '/workspace/providers' ||
    path === '/workspace/skills' ||
    path === '/workspace/tools' ||
    path === '/workspace/extensions' ||
    path === '/workspace/extensions/operations' ||
    path === '/workspace/extensions/check-updates' ||
    path === '/workspace/mcp' ||
    path === '/workspace/voice' ||
    /^\/workspaces\/[^/]+\/(voice|providers|settings)\/?$/.test(path) ||
    /^\/workspaces\/[^/]+\/skills\/?$/.test(path) ||
    /^\/workspaces\/[^/]+\/(mcp|extensions|memory|hooks)\/?$/.test(path) ||
    /^\/workspaces\/[^/]+\/open\/?$/.test(path) ||
    /^\/workspace\/mcp\/[^/]+\/tools\/?$/.test(path) ||
    /^\/workspace\/mcp\/[^/]+\/resources\/?$/.test(path) ||
    /^\/workspaces\/[^/]+\/channel-types\/?$/.test(path) ||
    /^\/workspaces\/[^/]+\/channels\/?$/.test(path) ||
    /^\/workspaces\/[^/]+\/channels\/[^/]+\/pairing-requests(?:\/approve)?\/?$/.test(
      path,
    ) ||
    /^\/workspaces\/[^/]+\/channels\/[^/]+\/pairing-approvals\/?$/.test(path) ||
    /^\/workspaces\/[^/]+\/channels\/[^/]+\/?$/.test(path) ||
    /^\/workspace\/.+\/sessions\/?$/.test(path) ||
    /^\/workspaces\/[^/]+\/sessions\/?$/.test(path) ||
    /^\/workspace\/.+\/sessions\/search\/?$/.test(path) ||
    /^\/workspaces\/[^/]+\/sessions\/search\/?$/.test(path) ||
    /^\/workspaces\/[^/]+\/sessions\/live-state\/?$/.test(path) ||
    /^\/workspace\/.+\/session-groups\/?$/.test(path) ||
    /^\/workspaces\/[^/]+\/session-groups\/?$/.test(path) ||
    /^\/workspaces\/.+\/git\/?$/.test(path) ||
    /^\/workspaces\/.+\/git\/(branches|checkout|branch|push|pull|commit|diff|log)\/?$/.test(
      path,
    ) ||
    /^\/workspace\/git\/(branches|checkout|branch|push|pull|commit|diff|log)\/?$/.test(
      path,
    ) ||
    /^\/workspaces\/.+\/github\/prs\/?$/.test(path) ||
    /^\/workspaces\/.+\/github\/(prs\/create|default-branch)\/?$/.test(path) ||
    /^\/workspace\/github\/(prs\/create|default-branch)\/?$/.test(path) ||
    path === '/session' ||
    path === '/standalone/sessions' ||
    /^\/standalone\/sessions\/[^/]+(?:\/(?:load|resume|repair-directory|metadata|export))?\/?$/.test(
      path,
    ) ||
    path === '/goals' ||
    /^\/file\/?$/.test(path) ||
    /^\/session\/[^/]+\/artifacts\/?$/.test(path) ||
    /^\/permission\/[^/]+\/?$/.test(path) ||
    /^\/session\/[^/]+\/pending-prompts(?:\/[^/]+)?\/?$/.test(path) ||
    /^\/session\/[^/]+\/goal\/?$/.test(path) ||
    /^\/session\/[^/]+\/status\/?$/.test(path) ||
    /^\/session\/[^/]+\/tasks\/?$/.test(path) ||
    /^\/session\/[^/]+\/saved-workflows\/[^/]+\/?$/.test(path) ||
    /^\/session\/[^/]+\/mid-turn-message\/?$/.test(path) ||
    /^\/session\/[^/]+\/mid-turn-messages(?:\/[^/]+)?\/?$/.test(path) ||
    /^\/session\/[^/]+\/(load|resume|branch|prompt|permission\/[^/]+|context|supported-commands|events|model|config-option|approval-mode|heartbeat|cancel|detach|btw)\/?$/.test(
      path,
    )
  );
}

function isDaemonRoute(method: string, path: string): boolean {
  if (method === 'GET' && (path === '/health' || path === '/capabilities')) {
    return true;
  }
  if (
    (method === 'GET' || method === 'POST') &&
    path === '/workspace/settings'
  ) {
    return true;
  }
  if (
    (method === 'GET' || method === 'DELETE') &&
    /^\/workspaces\/[^/]+\/channels\/[^/]+\/pairing-approvals\/?$/.test(path)
  ) {
    return true;
  }
  if (method === 'GET' && path === '/workspace/providers') return true;
  if (method === 'GET' && path === '/workspace/skills') return true;
  if (method === 'GET' && path === '/workspace/tools') return true;
  if (method === 'GET' && path === '/workspace/extensions') return true;
  if (method === 'GET' && path === '/workspace/extensions/operations') {
    return true;
  }
  if (method === 'POST' && path === '/workspace/extensions/check-updates') {
    return true;
  }
  if (method === 'GET' && path === '/workspace/mcp') return true;
  if (method === 'GET' && path === '/workspace/voice') return true;
  if (
    (method === 'GET' || method === 'POST') &&
    /^\/workspaces\/[^/]+\/settings\/?$/.test(path)
  ) {
    return true;
  }
  if (
    method === 'GET' &&
    /^\/workspaces\/[^/]+\/(voice|providers)\/?$/.test(path)
  ) {
    return true;
  }
  if (method === 'GET' && /^\/workspaces\/[^/]+\/skills\/?$/.test(path)) {
    return true;
  }
  if (
    method === 'GET' &&
    /^\/workspaces\/[^/]+\/(mcp|extensions|memory|hooks)\/?$/.test(path)
  ) {
    return true;
  }
  if (method === 'POST' && /^\/workspaces\/[^/]+\/open\/?$/.test(path)) {
    return true;
  }
  if (method === 'GET' && /^\/workspace\/mcp\/[^/]+\/tools\/?$/.test(path)) {
    return true;
  }
  if (
    method === 'GET' &&
    /^\/workspace\/mcp\/[^/]+\/resources\/?$/.test(path)
  ) {
    return true;
  }
  if (
    method === 'GET' &&
    /^\/workspaces\/[^/]+\/sessions\/live-state\/?$/.test(path)
  ) {
    return true;
  }
  if (
    method === 'GET' &&
    (/^\/workspace\/.+\/sessions\/?$/.test(path) ||
      /^\/workspaces\/[^/]+\/sessions\/?$/.test(path))
  ) {
    return true;
  }
  if (
    method === 'GET' &&
    (/^\/workspace\/.+\/sessions\/search\/?$/.test(path) ||
      /^\/workspaces\/[^/]+\/sessions\/search\/?$/.test(path))
  ) {
    return true;
  }
  if (
    method === 'GET' &&
    (/^\/workspace\/.+\/session-groups\/?$/.test(path) ||
      /^\/workspaces\/[^/]+\/session-groups\/?$/.test(path))
  ) {
    return true;
  }
  if (
    method === 'GET' &&
    (/^\/workspaces\/[^/]+\/channel-types\/?$/.test(path) ||
      /^\/workspaces\/[^/]+\/channels\/?$/.test(path))
  ) {
    return true;
  }
  if (
    (method === 'PUT' || method === 'DELETE') &&
    /^\/workspaces\/[^/]+\/channels\/[^/]+\/?$/.test(path)
  ) {
    return true;
  }
  if (
    (method === 'GET' || method === 'POST') &&
    /^\/workspaces\/[^/]+\/channels\/[^/]+\/pairing-requests(?:\/approve)?\/?$/.test(
      path,
    )
  ) {
    return true;
  }
  if (
    method === 'GET' &&
    /^\/workspaces\/.+\/git\/(branches|diff|log)\/?$/.test(path)
  )
    return true;
  if (
    method === 'GET' &&
    /^\/workspace\/git\/(branches|diff|log)\/?$/.test(path)
  )
    return true;
  if (
    method === 'POST' &&
    /^\/workspaces\/.+\/git\/(checkout|branch|push|pull|commit)\/?$/.test(path)
  )
    return true;
  if (
    method === 'POST' &&
    /^\/workspace\/git\/(checkout|branch|push|pull|commit)\/?$/.test(path)
  )
    return true;
  if (
    method === 'GET' &&
    /^\/workspaces\/.+\/github\/default-branch\/?$/.test(path)
  )
    return true;
  if (method === 'GET' && /^\/workspace\/github\/default-branch\/?$/.test(path))
    return true;
  if (
    method === 'POST' &&
    /^\/workspaces\/.+\/github\/prs\/create\/?$/.test(path)
  )
    return true;
  if (method === 'POST' && /^\/workspace\/github\/prs\/create\/?$/.test(path))
    return true;
  if (method === 'POST' && /^\/session\/[^/]+\/btw\/?$/.test(path)) return true;
  if (method === 'GET' && /^\/file\/?$/.test(path)) return true;
  if (method === 'GET' && /^\/session\/[^/]+\/artifacts\/?$/.test(path)) {
    return true;
  }
  if (method === 'POST' && path === '/session') return true;
  if (
    path === '/standalone/sessions' &&
    (method === 'GET' || method === 'POST')
  ) {
    return true;
  }
  if (
    method === 'POST' &&
    /^\/standalone\/sessions\/(archive|unarchive|delete)\/?$/.test(path)
  ) {
    return true;
  }
  if (
    method === 'GET' &&
    /^\/standalone\/sessions\/[^/]+(?:\/export)?\/?$/.test(path)
  ) {
    return true;
  }
  if (
    method === 'POST' &&
    /^\/standalone\/sessions\/[^/]+\/(load|resume|repair-directory)\/?$/.test(
      path,
    )
  ) {
    return true;
  }
  if (
    method === 'PATCH' &&
    /^\/standalone\/sessions\/[^/]+\/metadata\/?$/.test(path)
  ) {
    return true;
  }
  if (method === 'GET' && path === '/goals') return true;
  if (
    (method === 'GET' || method === 'POST') &&
    /^\/session\/[^/]+\/goal\/?$/.test(path)
  ) {
    return true;
  }
  if (
    method === 'POST' &&
    /^\/session\/[^/]+\/mid-turn-message\/?$/.test(path)
  ) {
    return true;
  }
  if (
    (method === 'GET' || method === 'DELETE') &&
    /^\/session\/[^/]+\/mid-turn-messages(?:\/[^/]+)?\/?$/.test(path)
  ) {
    return true;
  }
  if (method === 'POST' && /^\/permission\/[^/]+\/?$/.test(path)) return true;
  if (
    (method === 'GET' || method === 'DELETE') &&
    /^\/session\/[^/]+\/pending-prompts(?:\/[^/]+)?\/?$/.test(path)
  ) {
    return true;
  }
  if (method === 'GET' && /^\/session\/[^/]+\/events\/?$/.test(path)) {
    return true;
  }
  if (method === 'GET' && /^\/session\/[^/]+\/status\/?$/.test(path)) {
    return true;
  }
  if (method === 'GET' && /^\/workspaces\/.+\/git\/?$/.test(path)) {
    return true;
  }
  if (method === 'GET' && /^\/workspaces\/.+\/github\/prs\/?$/.test(path)) {
    return true;
  }
  if (
    method === 'POST' &&
    /^\/session\/[^/]+\/(load|resume|branch|prompt|permission\/[^/]+|model|config-option|approval-mode|heartbeat|cancel|detach)\/?$/.test(
      path,
    )
  ) {
    return true;
  }
  return (
    (method === 'GET' &&
      /^\/session\/[^/]+\/(context|supported-commands|tasks)\/?$/.test(path)) ||
    (method === 'GET' &&
      /^\/session\/[^/]+\/saved-workflows\/[^/]+\/?$/.test(path))
  );
}

async function handleDaemonRoute(
  route: Route,
  method: string,
  path: string,
  scenario: WebShellDaemonScenario,
  body: unknown,
  searchParams: URLSearchParams = new URLSearchParams(),
): Promise<void> {
  if (method === 'GET' && path === '/health') {
    await json(route, { ok: true, healthy: true });
    return;
  }
  if (method === 'GET' && path === '/capabilities') {
    await json(route, scenario.capabilities);
    return;
  }
  if (method === 'GET' && path === '/workspace/providers') {
    const providers = scenario.providers;
    if (scenario.providersDelayMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, scenario.providersDelayMs),
      );
    }
    await json(route, providers);
    return;
  }
  if (method === 'GET' && path === '/workspace/skills') {
    await json(route, scenario.skills);
    return;
  }
  // Sidebar workspace overview facets, keyed by the workspace the route
  // names so two workspaces can answer differently. The qualified extensions
  // route answers with the workspace projection, not the manager's status
  // document.
  const overviewMatch = path.match(
    /^\/workspaces\/([^/]+)\/(mcp|skills|extensions|memory|hooks)\/?$/,
  );
  if (method === 'GET' && overviewMatch) {
    const workspaceCwd = decodeURIComponent(overviewMatch[1] ?? '');
    const facet = overviewMatch[2];
    const overrides = scenario.workspaceOverviews[workspaceCwd] ?? {};
    if (facet === 'mcp') {
      await json(route, {
        ...workspaceMcp(scenario),
        workspaceCwd,
        ...(overrides.mcp ?? {}),
      });
    } else if (facet === 'skills') {
      await json(route, {
        ...scenario.skills,
        workspaceCwd,
        ...(overrides.skills ?? {}),
      });
    } else if (facet === 'extensions') {
      await json(route, {
        v: 1,
        workspaceId: workspaceCwd,
        workspaceCwd,
        trusted: true,
        desiredGeneration: 0,
        appliedGeneration: 0,
        extensions: [],
        ...(overrides.extensions ?? {}),
      });
    } else if (facet === 'memory') {
      await json(route, {
        v: 1,
        workspaceCwd,
        initialized: true,
        files: [],
        totalBytes: 0,
        fileCount: 0,
        ruleCount: 0,
        ...(overrides.memory ?? {}),
      });
    } else {
      await json(route, {
        v: 1,
        workspaceCwd,
        initialized: true,
        disabled: false,
        hooks: [],
        events: {},
        ...(overrides.hooks ?? {}),
      });
    }
    return;
  }
  if (method === 'GET' && path === '/workspace/settings') {
    await json(route, scenario.settings);
    return;
  }
  if (method === 'POST' && path === '/workspace/settings') {
    await json(route, {
      key: getRecordValue(body, 'key') ?? 'unknown',
      scope: getRecordValue(body, 'scope') ?? 'workspace',
      value: getRecordValue(body, 'value'),
      requiresRestart: false,
    });
    return;
  }
  if (method === 'DELETE' && path === '/workspace/models') {
    await json(route, { removed: true, clearedActiveModel: false });
    return;
  }
  if (method === 'GET' && path === '/workspace/tools') {
    await json(route, workspaceTools(scenario));
    return;
  }
  if (method === 'GET' && path === '/workspace/extensions') {
    await json(route, scenario.extensions);
    return;
  }
  if (method === 'GET' && path === '/workspace/extensions/operations') {
    // The manager polls in-flight operations on mount. Defaults to an idle
    // (empty) list so the capture has no error banner; a scenario can seed
    // `extensionOperations` to preview an in-progress install/update.
    await json(route, scenario.extensionOperations);
    return;
  }
  if (method === 'POST' && path === '/workspace/extensions/check-updates') {
    // The manager kicks off an update check on mount. Defaults to "no updates
    // available", overridable via the scenario's `extensionUpdateCheck`.
    await json(route, scenario.extensionUpdateCheck);
    return;
  }
  if (method === 'GET' && path === '/workspace/mcp') {
    await json(route, workspaceMcp(scenario));
    return;
  }
  if (method === 'GET' && path === '/workspace/voice') {
    await json(route, workspaceVoice(scenario));
    return;
  }
  if (method === 'GET' && /^\/file\/?$/.test(path)) {
    const filePath = searchParams.get('path') ?? '';
    const content = scenario.workspaceFiles[filePath];
    if (content === undefined) {
      await json(route, { error: `No such file: ${filePath}` }, 404);
      return;
    }
    await json(route, workspaceFile(filePath, content));
    return;
  }
  if (method === 'GET' && /^\/workspaces\/[^/]+\/voice\/?$/.test(path)) {
    await json(route, workspaceVoice(scenario));
    return;
  }
  if (method === 'GET' && /^\/workspaces\/[^/]+\/providers\/?$/.test(path)) {
    const providers = scenario.providers;
    if (scenario.providersDelayMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, scenario.providersDelayMs),
      );
    }
    await json(route, providers);
    return;
  }
  if (method === 'GET' && /^\/workspaces\/[^/]+\/settings\/?$/.test(path)) {
    await json(route, scenario.settings);
    return;
  }
  if (method === 'POST' && /^\/workspaces\/[^/]+\/settings\/?$/.test(path)) {
    await json(route, {
      key: getRecordValue(body, 'key') ?? 'unknown',
      scope: getRecordValue(body, 'scope') ?? 'workspace',
      value: getRecordValue(body, 'value'),
      requiresRestart: false,
    });
    return;
  }
  if (method === 'GET' && /^\/workspace\/mcp\/[^/]+\/tools\/?$/.test(path)) {
    const serverName = decodeURIComponent(path.split('/')[3] ?? 'server');
    await json(route, workspaceMcpTools(scenario, serverName));
    return;
  }
  if (
    method === 'GET' &&
    /^\/workspace\/mcp\/[^/]+\/resources\/?$/.test(path)
  ) {
    const serverName = decodeURIComponent(path.split('/')[3] ?? 'server');
    await json(route, workspaceMcpResources(scenario, serverName));
    return;
  }
  if (
    method === 'GET' &&
    /^\/workspaces\/[^/]+\/sessions\/live-state\/?$/.test(path)
  ) {
    await json(route, {
      v: 1,
      catalogVersion: scenario.sessionCatalogVersion,
      sessions: scenario.sessions
        .filter(
          (session) =>
            (session.clientCount ?? 0) > 0 ||
            session.hasActivePrompt === true ||
            session.isWaitingForPermission === true ||
            session.isWaitingForUserQuestion === true,
        )
        .map((session) => ({
          sessionId: session.sessionId,
          clientCount: session.clientCount ?? 0,
          hasActivePrompt: session.hasActivePrompt ?? false,
          isWaitingForPermission: session.isWaitingForPermission ?? false,
          isWaitingForUserQuestion: session.isWaitingForUserQuestion ?? false,
        })),
    });
    return;
  }
  if (
    method === 'GET' &&
    (/^\/workspace\/.+\/sessions\/search\/?$/.test(path) ||
      /^\/workspaces\/[^/]+\/sessions\/search\/?$/.test(path))
  ) {
    // Content search scans transcript bodies server-side; scenarios don't
    // model those, so answer with no hits and let the client fall back to
    // its local title/id/git filter.
    await json(route, { results: [] });
    return;
  }
  if (
    method === 'GET' &&
    (/^\/workspace\/.+\/sessions\/?$/.test(path) ||
      /^\/workspaces\/[^/]+\/sessions\/?$/.test(path))
  ) {
    await json(route, {
      sessions: filterScenarioSessions(scenario, searchParams),
    });
    return;
  }
  if (
    method === 'GET' &&
    (/^\/workspace\/.+\/session-groups\/?$/.test(path) ||
      /^\/workspaces\/[^/]+\/session-groups\/?$/.test(path))
  ) {
    const catalog: DaemonSessionGroupCatalog = {
      groups: scenario.sessionGroups,
      colorOptions: ['red', 'orange', 'yellow', 'green', 'blue', 'purple'],
    };
    await json(route, catalog);
    return;
  }
  if (
    method === 'GET' &&
    /^\/workspaces\/[^/]+\/channel-types\/?$/.test(path)
  ) {
    await json(route, scenario.channelTypes);
    return;
  }
  if (method === 'GET' && /^\/workspaces\/[^/]+\/channels\/?$/.test(path)) {
    await json(route, scenario.channels);
    return;
  }
  const pairingMatch = path.match(
    /^\/workspaces\/[^/]+\/channels\/([^/]+)\/pairing-requests(\/approve)?\/?$/,
  );
  if (pairingMatch) {
    const name = decodeURIComponent(pairingMatch[1]);
    const requests = scenario.pairingRequests[name] ?? [];
    if (method === 'GET' && !pairingMatch[2]) {
      await json(route, { requests });
      return;
    }
    if (method === 'POST' && pairingMatch[2]) {
      const code = String(getRecordValue(body, 'code') ?? '').toUpperCase();
      const approved = requests.find((request) => request.code === code);
      if (!approved) {
        await json(route, { error: 'Pairing request not found.' }, 404);
        return;
      }
      const remaining = requests.filter((request) => request.code !== code);
      scenario.pairingRequests = {
        ...scenario.pairingRequests,
        [name]: remaining,
      };
      if (approved.subject?.type === 'group') {
        scenario.pairingGroupApprovals = {
          ...scenario.pairingGroupApprovals,
          [name]: Array.from(
            new Set([
              ...(scenario.pairingGroupApprovals[name] ?? []),
              approved.subject.id,
            ]),
          ),
        };
      } else {
        scenario.pairingApprovals = {
          ...scenario.pairingApprovals,
          [name]: Array.from(
            new Set([
              ...(scenario.pairingApprovals[name] ?? []),
              approved.senderId,
            ]),
          ),
        };
      }
      await json(route, { approved, requests: remaining });
      return;
    }
  }
  const pairingApprovalsMatch = path.match(
    /^\/workspaces\/[^/]+\/channels\/([^/]+)\/pairing-approvals\/?$/,
  );
  if (pairingApprovalsMatch) {
    const name = decodeURIComponent(pairingApprovalsMatch[1]);
    const senderIds = scenario.pairingApprovals[name] ?? [];
    const groupIds = scenario.pairingGroupApprovals[name] ?? [];
    if (method === 'GET') {
      await json(route, { senderIds, groupIds });
      return;
    }
    if (method === 'DELETE') {
      const senderId = String(getRecordValue(body, 'senderId') ?? '');
      const groupId = String(getRecordValue(body, 'groupId') ?? '');
      const known = senderId
        ? senderIds.includes(senderId)
        : groupIds.includes(groupId);
      if (!known) {
        await json(
          route,
          {
            error: 'Pairing approval was not found.',
            code: 'channel_pairing_approval_not_found',
          },
          404,
        );
        return;
      }
      const remainingSenders = senderId
        ? senderIds.filter((item) => item !== senderId)
        : senderIds;
      const remainingGroups =
        groupId && !senderId
          ? groupIds.filter((item) => item !== groupId)
          : groupIds;
      scenario.pairingApprovals = {
        ...scenario.pairingApprovals,
        [name]: remainingSenders,
      };
      scenario.pairingGroupApprovals = {
        ...scenario.pairingGroupApprovals,
        [name]: remainingGroups,
      };
      await json(route, {
        revoked: senderId || groupId,
        senderIds: remainingSenders,
        groupIds: remainingGroups,
      });
      return;
    }
  }
  const channelMutationMatch = path.match(
    /^\/workspaces\/[^/]+\/channels\/([^/]+)\/?$/,
  );
  if (channelMutationMatch && (method === 'PUT' || method === 'DELETE')) {
    const name = decodeURIComponent(channelMutationMatch[1]);
    if (
      !isRecord(body) ||
      body['expectedRevision'] !== scenario.channels.revision
    ) {
      await json(route, { error: 'Channel settings changed.' }, 409);
      return;
    }
    const revision = nextRevision(scenario.channels.revision);
    if (method === 'DELETE') {
      const instances = { ...scenario.channels.instances };
      delete instances[name];
      scenario.channels = { revision, instances };
      await json(route, {
        snapshot: scenario.channels,
        instance: {
          name,
          config: {},
          secrets: {},
          startsWithServe: false,
          runtime: { state: 'stopped' },
        },
      });
      return;
    }
    if (!isRecord(body['config'])) {
      await badRequest(route, 'Invalid Channel configuration.');
      return;
    }
    const previous = scenario.channels.instances[name];
    const secrets = { ...(previous?.secrets ?? {}) };
    if (isRecord(body['secrets'])) {
      for (const [key, update] of Object.entries(body['secrets'])) {
        if (!isRecord(update)) continue;
        if (update['operation'] === 'clear') {
          delete secrets[key];
        } else if (update['operation'] === 'replace') {
          secrets[key] = { present: true, source: 'literal' };
        }
      }
    }
    const instance = {
      name,
      config: body['config'],
      secrets,
      startsWithServe: previous?.startsWithServe ?? false,
      runtime: previous?.runtime ?? ({ state: 'stopped' } as const),
    };
    scenario.channels = {
      revision,
      instances: { ...scenario.channels.instances, [name]: instance },
    };
    await json(route, { snapshot: scenario.channels, instance });
    return;
  }
  if (method === 'GET' && /^\/workspaces\/.+\/git\/?$/.test(path)) {
    await json(
      route,
      scenario.gitStatus ?? {
        v: 2,
        workspaceCwd: scenario.workspaceCwd,
        branch: null,
      },
    );
    return;
  }
  if (method === 'POST' && /^\/workspaces\/[^/]+\/open\/?$/.test(path)) {
    await json(route, { kind: 'workspace-local-open', opened: true });
    return;
  }
  if (method === 'GET' && /^\/workspaces\/.+\/github\/prs\/?$/.test(path)) {
    await json(
      route,
      scenario.gitHubPrs ?? {
        v: 1,
        workspaceCwd: scenario.workspaceCwd,
        available: true,
        pullRequests: [],
      },
    );
    return;
  }
  if (
    method === 'GET' &&
    /^\/(workspaces\/.+\/|workspace\/)?git\/branches\/?$/.test(path)
  ) {
    await json(
      route,
      scenario.gitBranches ?? {
        v: 1,
        workspaceCwd: scenario.workspaceCwd,
        available: true,
        local: [
          {
            name: 'main',
            isHead: false,
            ahead: 0,
            behind: 0,
            commitDate: 0,
            commitSubject: '',
          },
          {
            name: 'feat/demo',
            isHead: true,
            ahead: 3,
            behind: 0,
            commitDate: 0,
            commitSubject: '',
          },
        ],
        remote: [
          {
            name: 'origin/main',
            isHead: false,
            ahead: 0,
            behind: 0,
            commitDate: 0,
            commitSubject: '',
          },
          {
            name: 'origin/develop',
            isHead: false,
            ahead: 0,
            behind: 0,
            commitDate: 0,
            commitSubject: '',
          },
          {
            name: 'upstream/main',
            isHead: false,
            ahead: 0,
            behind: 0,
            commitDate: 0,
            commitSubject: '',
          },
        ],
        tags: [{ name: 'v1.0.0', date: 0, subject: 'Release 1.0' }],
        recent: ['main', 'develop'],
        head: 'feat/demo',
        detached: false,
      },
    );
    return;
  }
  if (
    method === 'GET' &&
    /^\/(workspaces\/.+\/|workspace\/)?git\/diff\/?$/.test(path)
  ) {
    await json(
      route,
      scenario.gitDiff ?? {
        v: 1,
        workspaceCwd: scenario.workspaceCwd,
        available: true,
        files: [
          {
            path: 'src/foo.ts',
            added: 10,
            removed: 3,
            isBinary: false,
            isUntracked: false,
            isDeleted: false,
          },
          {
            path: 'src/bar.ts',
            added: 5,
            removed: 0,
            isBinary: false,
            isUntracked: true,
            isDeleted: false,
          },
        ],
      },
    );
    return;
  }
  if (
    method === 'GET' &&
    /^\/(workspaces\/.+\/|workspace\/)?git\/log\/?$/.test(path)
  ) {
    await json(
      route,
      scenario.gitLog ?? {
        v: 1,
        workspaceCwd: scenario.workspaceCwd,
        available: true,
        entries: [
          {
            sha: 'abc1234',
            shortSha: 'abc1234',
            subject: 'feat: add branch picker',
            authorName: 'dev',
            authorEmail: 'dev@example.com',
            authorDate: 0,
            refs: 'HEAD -> feat/demo',
            parents: [],
          },
          {
            sha: 'def5678',
            shortSha: 'def5678',
            subject: 'fix: resolve session per workspace',
            authorName: 'dev',
            authorEmail: 'dev@example.com',
            authorDate: 0,
            parents: [],
          },
        ],
        hasMore: false,
      },
    );
    return;
  }
  if (
    method === 'POST' &&
    /^\/(workspaces\/.+\/|workspace\/)?git\/(checkout|branch|push|pull|commit)\/?$/.test(
      path,
    )
  ) {
    const action = path.replace(/\/$/, '').split('/').pop();
    if (action === 'commit') {
      await json(route, { sha: 'abc1234', subject: 'test commit' });
    } else if (action === 'checkout' || action === 'branch') {
      await json(route, { branch: 'feat/demo', detached: false });
    } else {
      await json(route, { success: true, output: '' });
    }
    return;
  }
  if (
    method === 'GET' &&
    /^\/(workspaces\/.+\/|workspace\/)?github\/default-branch\/?$/.test(path)
  ) {
    await json(route, { branch: 'origin/main' });
    return;
  }
  if (
    method === 'POST' &&
    /^\/(workspaces\/.+\/|workspace\/)?github\/prs\/create\/?$/.test(path)
  ) {
    await json(
      route,
      { url: 'https://github.com/example/repo/pull/42', number: 42 },
      201,
    );
    return;
  }
  if (method === 'POST' && /^\/session\/[^/]+\/btw\/?$/.test(path)) {
    await json(route, {
      sessionId: path.split('/')[2],
      answer:
        scenario.btwAnswer ??
        'feat(web-shell): add git branch picker and commit dialog\n\n## What this PR does\nAdds branch picker, commit dialog, and create PR flow to the web shell.\n\n## Why it is needed\nCompletes the git workflow in the browser.',
    });
    return;
  }
  if (path === '/standalone/sessions') {
    if (method === 'GET') {
      const archiveState = searchParams.get('archiveState') ?? 'active';
      await json(route, {
        sessions: scenario.standaloneSessions.filter((session) =>
          archiveState === 'archived'
            ? session.isArchived === true
            : session.isArchived !== true,
        ),
      });
      return;
    }
    if (scenario.standaloneCreateError) {
      await json(
        route,
        {
          code: scenario.standaloneCreateError.code,
          message: scenario.standaloneCreateError.message,
        },
        scenario.standaloneCreateError.status,
      );
      return;
    }
    const sessionId = readStringField(body, 'sessionId');
    if (!sessionId) {
      await badRequest(route, 'Standalone sessionId is required.');
      return;
    }
    let summary = scenario.standaloneSessions.find(
      (session) => session.sessionId === sessionId,
    );
    if (!summary) {
      summary = standaloneSummary(scenario, sessionId);
      scenario.standaloneSessions.unshift(summary);
    }
    await json(route, standaloneSessionEnvelope(scenario, summary, false), 201);
    return;
  }

  const standaloneBatchMatch = path.match(
    /^\/standalone\/sessions\/(archive|unarchive|delete)\/?$/,
  );
  if (method === 'POST' && standaloneBatchMatch) {
    const action = standaloneBatchMatch[1];
    const sessionIds = readStringArrayField(body, 'sessionIds');
    const found = sessionIds.filter((sessionId) =>
      scenario.standaloneSessions.some(
        (session) => session.sessionId === sessionId,
      ),
    );
    const notFound = sessionIds.filter(
      (sessionId) => !found.includes(sessionId),
    );
    if (action === 'delete') {
      scenario.standaloneSessions = scenario.standaloneSessions.filter(
        (session) => !found.includes(session.sessionId),
      );
      await json(route, {
        removed: found,
        notFound,
        errors: [],
        fileCleanupPending: [],
      });
      return;
    }
    const targetArchived = action === 'archive';
    const changed: string[] = [];
    const unchanged: string[] = [];
    scenario.standaloneSessions = scenario.standaloneSessions.map((session) => {
      if (!found.includes(session.sessionId)) return session;
      if (Boolean(session.isArchived) === targetArchived) {
        unchanged.push(session.sessionId);
        return session;
      }
      changed.push(session.sessionId);
      return { ...session, isArchived: targetArchived, updatedAt: now };
    });
    await json(
      route,
      action === 'archive'
        ? {
            archived: changed,
            alreadyArchived: unchanged,
            notFound,
            errors: [],
          }
        : {
            unarchived: changed,
            alreadyActive: unchanged,
            notFound,
            errors: [],
          },
    );
    return;
  }

  const standaloneMatch = path.match(
    /^\/standalone\/sessions\/([^/]+)(?:\/(load|resume|repair-directory|metadata|export))?\/?$/,
  );
  if (standaloneMatch) {
    const sessionId = decodeURIComponent(standaloneMatch[1]);
    const action = standaloneMatch[2];
    const index = scenario.standaloneSessions.findIndex(
      (session) => session.sessionId === sessionId,
    );
    const summary = scenario.standaloneSessions[index];
    if (!summary) {
      await json(
        route,
        {
          code: 'standalone_session_not_found',
          message: `Standalone session ${sessionId} was not found.`,
        },
        404,
      );
      return;
    }
    if (method === 'GET' && !action) {
      await json(route, summary);
      return;
    }
    if (method === 'POST' && (action === 'load' || action === 'resume')) {
      await json(route, restoredStandaloneSessionEnvelope(scenario, summary));
      return;
    }
    if (method === 'POST' && action === 'repair-directory') {
      await json(route, {
        sessionId,
        projectlessOutputDirectory: standaloneOutputDirectory(sessionId),
        workingDirectory: { state: 'ready' },
      });
      return;
    }
    if (method === 'PATCH' && action === 'metadata') {
      const displayName = readStringField(body, 'displayName') ?? '';
      scenario.standaloneSessions[index] = {
        ...summary,
        displayName,
        updatedAt: now,
      };
      await json(route, { sessionId, displayName });
      return;
    }
    if (method === 'GET' && action === 'export') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        headers: {
          'access-control-allow-origin': '*',
          'content-disposition': `attachment; filename="${sessionId}.html"`,
        },
        body: `<p>${summary.displayName ?? sessionId}</p>`,
      });
      return;
    }
  }
  if (method === 'POST' && path === '/session') {
    await json(route, sessionEnvelope(scenario, { attached: false }));
    return;
  }
  if (method === 'GET' && path === '/goals') {
    const goal = scenario.goalSnapshot.goal;
    await json(route, {
      v: 1,
      goals:
        goal && goal.status !== 'complete'
          ? [
              {
                sessionId: scenario.sessionId,
                displayName: scenario.displayName,
                condition: goal.objective,
                iterations: goal.turnCount,
                setAt: goal.createdAt,
                hasActivePrompt: scenario.goalSnapshot.activity !== 'idle',
                snapshot: scenario.goalSnapshot,
              },
            ]
          : [],
      droppedCount: 0,
    });
    return;
  }

  const goalMatch = path.match(/^\/session\/([^/]+)\/goal\/?$/);
  if (goalMatch) {
    if (method === 'GET') {
      await json(route, { snapshot: scenario.goalSnapshot });
      return;
    }
    scenario.goalSnapshot = reduceMockGoal(
      scenario.goalSnapshot,
      body as GoalControlRequest,
    );
    await json(route, { snapshot: scenario.goalSnapshot });
    return;
  }
  if (method === 'GET' && /^\/session\/[^/]+\/status\/?$/.test(path)) {
    // The real route answers with a flat `DaemonSessionSummary`; a `{v, state}`
    // envelope leaves every field the client reads (workspaceCwd, displayName,
    // worktree, branch) undefined, so session metadata restoration silently
    // does nothing in every scenario.
    await json(route, {
      sessionId: scenario.sessionId,
      workspaceCwd: scenario.workspaceCwd,
      displayName: scenario.displayName,
    });
    return;
  }

  const midTurnMatch = path.match(
    /^\/session\/([^/]+)\/mid-turn-messages(?:\/([^/]+))?\/?$/,
  );
  if (midTurnMatch) {
    const messageId = midTurnMatch[2]
      ? decodeURIComponent(midTurnMatch[2])
      : undefined;
    if (method === 'DELETE' && messageId) {
      const before = scenario.midTurnMessages.length;
      scenario.midTurnMessages = scenario.midTurnMessages.filter(
        (message) => message.messageId !== messageId,
      );
      await json(route, {
        removed: scenario.midTurnMessages.length !== before,
      });
      return;
    }
    await json(route, {
      messages: scenario.midTurnMessages,
      settledMessageIds: [],
      promotedMessageIds: [],
    });
    return;
  }
  if (
    method === 'POST' &&
    /^\/session\/[^/]+\/mid-turn-message\/?$/.test(path)
  ) {
    const text = readStringField(body, 'message');
    const messageId =
      readStringField(body, 'messageId') ??
      `mid-turn-${scenario.midTurnMessages.length + 1}`;
    if (!text) {
      await badRequest(route, 'Invalid mid-turn message.');
      return;
    }
    scenario.midTurnMessages.push({ messageId, text });
    await json(route, { accepted: true, messageId });
    return;
  }

  const sessionMatch = path.match(
    /^\/session\/([^/]+)\/([^/]+)(?:\/([^/]+))?\/?$/,
  );
  if (sessionMatch) {
    const sessionId = decodeURIComponent(sessionMatch[1]);
    const action = sessionMatch[2];
    const extra = sessionMatch[3] ? decodeURIComponent(sessionMatch[3]) : '';
    if (action === 'load' || action === 'resume') {
      await json(route, restoredSessionEnvelope(scenario, sessionId));
      return;
    }
    if (action === 'branch') {
      if (!scenario.branch) {
        await json(route, { error: 'Branch scenario is not configured.' }, 404);
        return;
      }
      const branch = scenario.branch;
      const response: DaemonPersistedBranchedSession = {
        sessionId: branch.sessionId,
        displayName: branch.displayName,
        forkedFrom: {
          sessionId,
          displayName: scenario.displayName,
        },
      };
      await json(route, response, 201);
      return;
    }
    if (action === 'artifacts') {
      await json(route, sessionArtifactsEnvelope(scenario, sessionId));
      return;
    }
    if (action === 'prompt') {
      if (!isPromptRequest(body)) {
        await badRequest(route, 'Invalid prompt request.');
        return;
      }
      await json(
        route,
        {
          promptId: promptIdFor(body),
          lastEventId: maxEventId(scenario.events),
        },
        202,
      );
      return;
    }
    if (action === 'pending-prompts') {
      if (method === 'DELETE') {
        await json(route, { removed: true });
        return;
      }
      await json(route, { pendingPrompts: [] });
      return;
    }
    if (action === 'permission') {
      await json(route, {});
      return;
    }
    if (action === 'context') {
      if (scenario.contextDelayMs) {
        await new Promise((resolve) =>
          setTimeout(resolve, scenario.contextDelayMs),
        );
      }
      await json(route, {
        v: 1,
        sessionId,
        workspaceCwd: scenario.workspaceCwd,
        state: scenario.state,
      });
      return;
    }
    if (action === 'supported-commands') {
      await json(route, {
        v: 1,
        sessionId,
        availableCommands: [],
        availableSkills: [],
        ...(scenario.supportedCommands ?? {}),
      });
      return;
    }
    if (action === 'tasks') {
      await json(route, {
        v: 1,
        sessionId,
        now: Date.now(),
        tasks: scenario.workflowTasks ?? [],
      });
      return;
    }
    if (action === 'saved-workflows') {
      const detail = scenario.savedWorkflowDetails?.[extra];
      await json(route, {
        v: 1,
        sessionId,
        name: extra,
        workflow: detail ? { v: 1, sessionId, name: extra, ...detail } : null,
      });
      return;
    }
    if (action === 'model') {
      const modelId = readStringField(body, 'modelId');
      if (!modelId) {
        await badRequest(route, 'Invalid model request.');
        return;
      }
      applyScenarioCurrentModel(scenario, modelId);
      await json(route, { sessionId, modelId });
      return;
    }
    if (action === 'config-option') {
      const configId = readStringField(body, 'configId');
      const value = readStringField(body, 'value');
      const persist = getRecordValue(body, 'persist');
      if (
        configId !== 'reasoning_effort' ||
        !value ||
        (persist !== undefined && typeof persist !== 'boolean')
      ) {
        await badRequest(route, 'Invalid config-option request.');
        return;
      }
      const currentConfigOptions = Array.isArray(scenario.state.configOptions)
        ? scenario.state.configOptions
        : [];
      const reasoningOption = currentConfigOptions.find(
        (option) => isRecord(option) && option['id'] === configId,
      );
      const allowedValues = isRecord(reasoningOption)
        ? reasoningOption['options']
        : undefined;
      const reasoningMeta = isRecord(reasoningOption)
        ? getRecordValue(reasoningOption, '_meta')
        : undefined;
      const qwenReasoningMeta = isRecord(reasoningMeta)
        ? getRecordValue(reasoningMeta, 'qwenCode/reasoning')
        : undefined;
      const defaultEffort = isRecord(qwenReasoningMeta)
        ? readStringField(qwenReasoningMeta, 'defaultEffort')
        : undefined;
      const selectedValue =
        value === 'default' && defaultEffort ? defaultEffort : value;
      if (
        !Array.isArray(allowedValues) ||
        ((value !== 'default' || !defaultEffort) &&
          !allowedValues.some((option) => {
            return (
              isRecord(option) &&
              readStringField(option, 'value') === selectedValue
            );
          }))
      ) {
        await badRequest(route, 'Unsupported config-option value.');
        return;
      }
      const configOptions = currentConfigOptions.map((option) =>
        isRecord(option) && option['id'] === configId
          ? { ...option, currentValue: selectedValue }
          : option,
      );
      scenario.state.configOptions = configOptions;
      await json(route, { configOptions, persisted: persist === true });
      return;
    }
    if (action === 'approval-mode') {
      const mode = readStringField(body, 'mode');
      if (!mode || !isApprovalMode(mode)) {
        await badRequest(route, 'Invalid approval mode request.');
        return;
      }
      const previous = scenario.currentMode;
      scenario.currentMode = mode;
      scenario.state.modes = {
        ...(isRecord(scenario.state.modes) ? scenario.state.modes : {}),
        currentModeId: mode,
      };
      scenario.providers = {
        ...scenario.providers,
        approvalMode: mode,
      };
      await json(route, {
        sessionId,
        previous,
        mode,
        persisted: getRecordValue(body, 'persist') === true,
      });
      return;
    }
    if (action === 'heartbeat') {
      await json(route, { ok: true });
      return;
    }
    if (action === 'cancel') {
      await json(route, {});
      return;
    }
    if (action === 'detach') {
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    if (action === 'events' || extra) {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: ': web-shell mock daemon\n\n',
      });
      return;
    }
  }

  if (method === 'POST' && /^\/permission\/[^/]+\/?$/.test(path)) {
    const response = body as PermissionResponse | undefined;
    await json(route, response ?? {});
    return;
  }

  await json(
    route,
    { error: `Unhandled mock daemon route: ${method} ${path}` },
    404,
  );
}

function sessionEnvelope(
  scenario: WebShellDaemonScenario,
  options: { attached: boolean },
): DaemonSession {
  return {
    sessionId: scenario.sessionId,
    workspaceCwd: scenario.workspaceCwd,
    attached: options.attached,
    clientId: scenario.clientId,
    createdAt: now,
    hasActivePrompt: false,
  };
}

function standaloneOutputDirectory(sessionId: string): string {
  return `/tmp/qwen-web-shell-standalone/${sessionId}`;
}

function standaloneSummary(
  scenario: WebShellDaemonScenario,
  sessionId: string,
): DaemonStandaloneSessionSummary {
  return {
    sessionId,
    workspaceCwd: standaloneOutputDirectory(sessionId),
    sourceType: 'standalone',
    context: { kind: 'standalone' },
    createdAt: now,
    updatedAt: now,
    displayName: `Standalone ${scenario.standaloneSessions.length + 1}`,
    clientCount: 1,
    hasActivePrompt: false,
    isArchived: false,
  };
}

function standaloneSessionEnvelope(
  scenario: WebShellDaemonScenario,
  summary: DaemonStandaloneSessionSummary,
  attached: boolean,
): DaemonStandaloneSession {
  return {
    sessionId: summary.sessionId,
    workspaceCwd: summary.workspaceCwd,
    attached,
    clientId: scenario.clientId,
    createdAt: summary.createdAt ?? now,
    hasActivePrompt: false,
    sourceType: 'standalone',
    context: { kind: 'standalone' },
    projectlessOutputDirectory: standaloneOutputDirectory(summary.sessionId),
    workingDirectory: { state: 'ready' },
  };
}

function restoredStandaloneSessionEnvelope(
  scenario: WebShellDaemonScenario,
  summary: DaemonStandaloneSessionSummary,
): DaemonRestoredStandaloneSession {
  return {
    ...standaloneSessionEnvelope(scenario, summary, true),
    state: { ...scenario.state, displayName: summary.displayName },
    compactedReplay: [],
    liveJournal: [],
    lastEventId: 0,
  };
}

function restoredSessionEnvelope(
  scenario: WebShellDaemonScenario,
  sessionId: string,
): DaemonRestoredSession {
  const branch =
    scenario.branch?.sessionId === sessionId ? scenario.branch : undefined;
  const events = branch?.events ?? scenario.events;
  return {
    sessionId,
    workspaceCwd: scenario.workspaceCwd,
    attached: true,
    clientId: branch?.clientId ?? scenario.clientId,
    createdAt: now,
    hasActivePrompt: false,
    state: branch
      ? { ...scenario.state, displayName: branch.displayName }
      : scenario.state,
    compactedReplay: events,
    liveJournal: [],
    lastEventId: maxEventId(events),
  };
}

function maxEventId(events: readonly DaemonEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.id ?? max), 0);
}

function promptIdFor(body: PromptRequest): string {
  const meta = body?._meta;
  if (meta && typeof meta['promptId'] === 'string') return meta['promptId'];
  return 'prompt-e2e';
}

function reduceMockGoal(
  snapshot: GoalSnapshotV2,
  request: GoalControlRequest,
): GoalSnapshotV2 {
  const current = snapshot.goal;
  const timestamp = Date.now();
  if (request.action === 'clear') {
    // The daemon attaches the tombstone on clear, and it is what stops a stale
    // frame resurrecting the goal client-side — without it the e2e clear step
    // cannot exercise that path at all.
    return {
      v: 2,
      goal: null,
      activity: 'idle',
      ...(current
        ? {
            clearedGoal: {
              goalId: current.goalId,
              revision: current.revision + 1,
              updatedAt: timestamp,
            },
          }
        : {}),
    };
  }
  if (request.action === 'create' || request.action === 'replace') {
    return {
      v: 2,
      goal: {
        goalId: `goal-${timestamp}`,
        revision: 1,
        objective: request.objective.trim(),
        status: 'active',
        evidenceCursor: { recordId: null },
        turnCount: 0,
        activeTimeMs: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      activity: 'idle',
    };
  }
  if (!current) return snapshot;
  const activeTimeMs =
    current.activeTimeMs +
    (current.status === 'active'
      ? Math.max(0, timestamp - current.updatedAt)
      : 0);
  return {
    v: 2,
    goal: {
      ...current,
      revision: current.revision + 1,
      ...(request.action === 'edit'
        ? { objective: request.objective.trim() }
        : {}),
      ...(request.action === 'pause'
        ? { status: 'paused' as const }
        : request.action === 'resume'
          ? { status: 'active' as const }
          : {}),
      activeTimeMs,
      updatedAt: timestamp,
    },
    activity: 'idle',
  };
}

function isPromptRequest(body: unknown): body is PromptRequest {
  if (!isRecord(body)) return false;
  const prompt = body['prompt'];
  return Array.isArray(prompt) && prompt.some(isPromptContentBlock);
}

function isPromptContentBlock(block: unknown): boolean {
  if (!isRecord(block)) return false;
  if (block['type'] === 'text') {
    return readStringField(block, 'text') !== undefined;
  }
  if (block['type'] === 'image') {
    return (
      readStringField(block, 'data') !== undefined ||
      readStringField(block, 'url') !== undefined
    );
  }
  return false;
}

function readStringField(body: unknown, key: string): string | undefined {
  const value = getRecordValue(body, key);
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined;
}

function readStringArrayField(body: unknown, key: string): string[] {
  const value = getRecordValue(body, key);
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function nextRevision(revision: string): string {
  const numeric = Number(revision);
  return Number.isSafeInteger(numeric) && numeric >= 0
    ? String(numeric + 1)
    : `${revision}-next`;
}

function isApprovalMode(mode: string): mode is DaemonApprovalMode {
  const modes: readonly string[] = DAEMON_APPROVAL_MODES;
  return modes.includes(mode);
}

function getRecordValue(body: unknown, key: string): unknown {
  if (!isRecord(body)) return undefined;
  return body[key];
}

function isRecord(body: unknown): body is Record<string, unknown> {
  return typeof body === 'object' && body !== null;
}

function workspaceMcp(
  scenario: WebShellDaemonScenario,
): DaemonWorkspaceMcpStatus {
  return scenario.mcp;
}

function workspaceMcpTools(
  scenario: WebShellDaemonScenario,
  serverName: string,
): DaemonWorkspaceMcpToolsStatus {
  return {
    v: 1,
    workspaceCwd: scenario.workspaceCwd,
    serverName,
    initialized: true,
    acpChannelLive: true,
    tools: [],
    errors: [],
  };
}

function workspaceMcpResources(
  scenario: WebShellDaemonScenario,
  serverName: string,
): DaemonWorkspaceMcpResourcesStatus {
  return {
    v: 1,
    workspaceCwd: scenario.workspaceCwd,
    serverName,
    initialized: true,
    acpChannelLive: true,
    resources: [],
    errors: [],
  };
}

function workspaceTools(
  scenario: WebShellDaemonScenario,
): DaemonWorkspaceToolsStatus {
  return {
    v: 1,
    workspaceCwd: scenario.workspaceCwd,
    initialized: true,
    acpChannelLive: true,
    tools: [],
    errors: [],
  };
}

function workspaceVoice(
  scenario: WebShellDaemonScenario,
): DaemonWorkspaceVoiceStatus {
  return scenario.voice;
}

function sessionArtifactsEnvelope(
  scenario: WebShellDaemonScenario,
  sessionId: string,
): DaemonSessionArtifactsEnvelope {
  return {
    v: 1,
    sessionId,
    artifacts: scenario.artifacts,
    generatedAt: now,
    limits: { maxArtifacts: 100 },
  };
}

function workspaceFile(path: string, content: string): DaemonWorkspaceFile {
  const sizeBytes = new TextEncoder().encode(content).byteLength;
  return {
    kind: 'file',
    path,
    content,
    encoding: 'utf-8',
    bom: false,
    lineEnding: 'lf',
    sizeBytes,
    returnedBytes: sizeBytes,
    truncated: false,
    matchedIgnore: null,
    originalLineCount: null,
  };
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: {
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
    body: JSON.stringify(body),
  });
}

async function badRequest(route: Route, error: string): Promise<void> {
  await json(route, { error }, 400);
}

async function methodNotAllowed(
  route: Route,
  method: string,
  path: string,
): Promise<void> {
  await json(route, { error: `Method not allowed: ${method} ${path}` }, 405);
}
