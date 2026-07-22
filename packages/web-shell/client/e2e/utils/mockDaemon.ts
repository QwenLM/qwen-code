import type { Page, Route } from '@playwright/test';
import {
  DAEMON_APPROVAL_MODES,
  type DaemonChannelAuthSession,
  type DaemonChannelInstanceSnapshot,
  type DaemonChannelMutationResult,
  type DaemonChannelPairingRequest,
  type DaemonChannelsSnapshot,
  type DaemonChannelTypeCatalog,
  type DaemonChannelUpsertRequest,
  type DaemonApprovalMode,
  type DaemonCapabilities,
  type DaemonEvent,
  type DaemonRestoredSession,
  type DaemonSession,
  type DaemonSessionGroup,
  type DaemonSessionGroupCatalog,
  type DaemonSessionState,
  type DaemonSessionSummary,
  type DaemonWorkspaceExtensionsStatus,
  type DaemonWorkspaceMcpResourcesStatus,
  type DaemonWorkspaceMcpStatus,
  type DaemonWorkspaceMcpToolsStatus,
  type DaemonWorkspaceProvidersStatus,
  type DaemonWorkspaceSettingsStatus,
  type DaemonWorkspaceSkillsStatus,
  type DaemonWorkspaceToolsStatus,
  type DaemonWorkspaceVoiceStatus,
  type ExtensionActiveOperations,
  type ExtensionUpdateCheckResponse,
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
  providers: DaemonWorkspaceProvidersStatus;
  skills: DaemonWorkspaceSkillsStatus;
  settings: DaemonWorkspaceSettingsStatus;
  extensions: DaemonWorkspaceExtensionsStatus;
  extensionOperations: ExtensionActiveOperations;
  extensionUpdateCheck: ExtensionUpdateCheckResponse;
  sessions: DaemonSessionSummary[];
  sessionGroups: DaemonSessionGroup[];
  events: DaemonEvent[];
  state: DaemonSessionState;
  bearerToken: string;
  channelWorkspaces: Record<string, MockChannelWorkspaceState>;
  channelFailures: Record<string, MockChannelFailure[]>;
}

export interface MockChannelFailure {
  status: number;
  body: Record<string, unknown>;
}

export interface MockChannelWorkspaceState {
  catalog: DaemonChannelTypeCatalog;
  snapshot: DaemonChannelsSnapshot;
  authSessions: Record<
    string,
    { session: DaemonChannelAuthSession; pollCount: number }
  >;
  pairingRequests: Record<string, DaemonChannelPairingRequest[]>;
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
}

type ScenarioOverrides = Partial<
  Omit<
    WebShellDaemonScenario,
    | 'capabilities'
    | 'providers'
    | 'skills'
    | 'settings'
    | 'extensions'
    | 'extensionOperations'
    | 'extensionUpdateCheck'
    | 'sessions'
    | 'sessionGroups'
    | 'state'
  >
> & {
  capabilities?: Partial<DaemonCapabilities>;
  providers?: Partial<DaemonWorkspaceProvidersStatus>;
  skills?: Partial<DaemonWorkspaceSkillsStatus>;
  settings?: Partial<DaemonWorkspaceSettingsStatus>;
  extensions?: Partial<DaemonWorkspaceExtensionsStatus>;
  extensionOperations?: Partial<ExtensionActiveOperations>;
  extensionUpdateCheck?: Partial<ExtensionUpdateCheckResponse>;
  sessions?: DaemonSessionSummary[];
  sessionGroups?: DaemonSessionGroup[];
  state?: Partial<DaemonSessionState>;
};

const now = '2026-07-03T00:00:00.000Z';
const channelAuthExpiresAt = '2099-01-01T00:00:00.000Z';
const defaultBearerToken = 'web-shell-channel-e2e-token';

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

  const channelWorkspaces =
    overrides.channelWorkspaces ??
    createDefaultChannelWorkspaces(
      workspaceCwd,
      '/tmp/qwen-secondary-workspace',
    );

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
    extensions,
    extensionOperations,
    extensionUpdateCheck,
    sessions,
    sessionGroups: overrides.sessionGroups ?? [],
    events: overrides.events ?? [],
    state,
    bearerToken: overrides.bearerToken ?? defaultBearerToken,
    channelWorkspaces,
    channelFailures: overrides.channelFailures ?? {},
  };
}

export function queueMockDaemonFailure(
  scenario: WebShellDaemonScenario,
  method: string,
  path: string,
  failure: MockChannelFailure,
): void {
  const key = `${method.toUpperCase()} ${path}`;
  (scenario.channelFailures[key] ??= []).push(failure);
}

function createDefaultChannelWorkspaces(
  primaryCwd: string,
  secondaryCwd: string,
): Record<string, MockChannelWorkspaceState> {
  return {
    [primaryCwd]: createDefaultChannelWorkspace(primaryCwd),
    [secondaryCwd]: createDefaultChannelWorkspace(secondaryCwd, 'secondary'),
  };
}

function createDefaultChannelWorkspace(
  workspaceCwd: string,
  prefix = 'primary',
): MockChannelWorkspaceState {
  const credentialName = `${prefix}-credential`;
  const qrName = `${prefix}-qr`;
  const catalog: DaemonChannelTypeCatalog = [
    {
      type: 'credential-adapter',
      displayName: 'Credential Adapter',
      manageable: true,
      auth: ['credentials'],
      fields: [
        {
          key: 'token',
          label: 'Access token',
          kind: 'secret',
          envResolvable: true,
        },
        {
          key: 'endpoint',
          label: 'Endpoint',
          kind: 'string',
          required: true,
        },
      ],
    },
    {
      type: 'qr-adapter',
      displayName: 'QR Adapter',
      manageable: true,
      auth: ['qr'],
      fields: [],
    },
  ];
  const instances: Record<string, DaemonChannelInstanceSnapshot> = {
    [credentialName]: {
      name: credentialName,
      config: {
        type: 'credential-adapter',
        endpoint: 'https://adapter.invalid/messages',
        cwd: workspaceCwd,
      },
      secrets: { token: { present: true, source: 'literal' } },
      webhookSecrets: {},
      startsWithServe: false,
      runtime: { state: 'stopped' },
    },
    [qrName]: {
      name: qrName,
      config: { type: 'qr-adapter', cwd: workspaceCwd },
      secrets: {},
      webhookSecrets: {},
      startsWithServe: true,
      runtime: { state: 'connected' },
    },
  };
  return {
    catalog,
    snapshot: { revision: 'revision-1', instances },
    authSessions: {},
    pairingRequests: {},
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
  options: { id?: number; sessionId?: string } = {},
): DaemonEvent {
  return sessionUpdateEvent(
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
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
    isChannelPath(path) ||
    /^\/workspace\/mcp\/[^/]+\/tools\/?$/.test(path) ||
    /^\/workspace\/mcp\/[^/]+\/resources\/?$/.test(path) ||
    /^\/workspaces?\/.+\/sessions\/?$/.test(path) ||
    /^\/workspaces?\/.+\/session-groups\/?$/.test(path) ||
    path === '/session' ||
    /^\/permission\/[^/]+\/?$/.test(path) ||
    /^\/session\/[^/]+\/pending-prompts(?:\/[^/]+)?\/?$/.test(path) ||
    /^\/session\/[^/]+\/(load|resume|prompt|permission\/[^/]+|context|supported-commands|events|model|approval-mode|heartbeat|cancel|detach)\/?$/.test(
      path,
    )
  );
}

function isDaemonRoute(method: string, path: string): boolean {
  if (isChannelPath(path)) return isChannelMethod(method, path);
  if (method === 'GET' && (path === '/health' || path === '/capabilities')) {
    return true;
  }
  if (
    (method === 'GET' || method === 'POST') &&
    path === '/workspace/settings'
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
  if (method === 'GET' && /^\/workspace\/mcp\/[^/]+\/tools\/?$/.test(path)) {
    return true;
  }
  if (
    method === 'GET' &&
    /^\/workspace\/mcp\/[^/]+\/resources\/?$/.test(path)
  ) {
    return true;
  }
  if (method === 'GET' && /^\/workspaces?\/.+\/sessions\/?$/.test(path)) {
    return true;
  }
  if (method === 'GET' && /^\/workspaces?\/.+\/session-groups\/?$/.test(path)) {
    return true;
  }
  if (method === 'POST' && path === '/session') return true;
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
  if (
    method === 'POST' &&
    /^\/session\/[^/]+\/(load|resume|prompt|permission\/[^/]+|model|approval-mode|heartbeat|cancel|detach)\/?$/.test(
      path,
    )
  ) {
    return true;
  }
  return (
    method === 'GET' &&
    /^\/session\/[^/]+\/(context|supported-commands)\/?$/.test(path)
  );
}

interface ParsedChannelPath {
  workspaceCwd: string;
  rest: string;
}

function parseChannelPath(
  path: string,
  primaryWorkspaceCwd = '',
): ParsedChannelPath | undefined {
  const primary = path.match(
    /^\/workspace\/(channel-types|channels(?:\/.*)?)$/,
  );
  if (primary) {
    return { workspaceCwd: primaryWorkspaceCwd, rest: primary[1] };
  }
  const selected = path.match(
    /^\/workspaces\/([^/]+)\/(channel-types|channels(?:\/.*)?)$/,
  );
  if (!selected) return undefined;
  return {
    workspaceCwd: decodeURIComponent(selected[1]),
    rest: selected[2],
  };
}

function isChannelPath(path: string): boolean {
  return parseChannelPath(path) !== undefined;
}

function isChannelMethod(method: string, path: string): boolean {
  const parsed = parseChannelPath(path);
  if (!parsed) return false;
  if (parsed.rest === 'channel-types' || parsed.rest === 'channels') {
    return method === 'GET';
  }
  if (/^channels\/[^/]+$/.test(parsed.rest)) {
    return method === 'PUT' || method === 'DELETE';
  }
  if (/^channels\/[^/]+\/startup$/.test(parsed.rest)) {
    return method === 'PUT';
  }
  if (/^channels\/[^/]+\/(start|stop|restart)$/.test(parsed.rest)) {
    return method === 'POST';
  }
  if (/^channels\/[^/]+\/pairing-requests$/.test(parsed.rest)) {
    return method === 'GET';
  }
  if (/^channels\/[^/]+\/pairing-requests\/approve$/.test(parsed.rest)) {
    return method === 'POST';
  }
  if (/^channels\/[^/]+\/auth-sessions$/.test(parsed.rest)) {
    return method === 'POST';
  }
  if (/^channels\/[^/]+\/auth-sessions\/[^/]+$/.test(parsed.rest)) {
    return method === 'GET' || method === 'DELETE';
  }
  if (/^channels\/[^/]+\/auth-sessions\/[^/]+\/qr$/.test(parsed.rest)) {
    return method === 'GET';
  }
  if (/^channels\/[^/]+\/auth-sessions\/[^/]+\/commit$/.test(parsed.rest)) {
    return method === 'POST';
  }
  return false;
}

async function handleChannelRoute(
  route: Route,
  method: string,
  path: string,
  scenario: WebShellDaemonScenario,
  body: unknown,
): Promise<void> {
  if (
    route.request().headers()['authorization'] !==
    `Bearer ${scenario.bearerToken}`
  ) {
    await json(
      route,
      { code: 'unauthorized', error: 'A valid bearer token is required.' },
      401,
    );
    return;
  }

  const failureKey = `${method} ${path}`;
  const failure = scenario.channelFailures[failureKey]?.shift();
  if (failure) {
    await json(route, failure.body, failure.status);
    return;
  }

  const parsed = parseChannelPath(path, scenario.workspaceCwd);
  if (!parsed) {
    await json(route, { code: 'channel_route_not_found' }, 404);
    return;
  }
  const workspace = scenario.channelWorkspaces[parsed.workspaceCwd];
  if (!workspace) {
    await json(
      route,
      { code: 'workspace_not_found', workspaceCwd: parsed.workspaceCwd },
      404,
    );
    return;
  }

  if (parsed.rest === 'channel-types') {
    await json(route, workspace.catalog);
    return;
  }
  if (parsed.rest === 'channels') {
    await json(route, workspace.snapshot);
    return;
  }

  const segments = parsed.rest.split('/').map(decodeURIComponent);
  const name = segments[1] ?? '';
  if (!name) {
    await badRequest(route, 'Channel name is required.');
    return;
  }

  if (segments.length === 2 && method === 'PUT') {
    const request = body as DaemonChannelUpsertRequest;
    if (!(await requireChannelRevision(route, workspace, request))) return;
    const previous = workspace.snapshot.instances[name];
    const instance: DaemonChannelInstanceSnapshot = {
      name,
      config: { ...(request.config ?? {}) },
      secrets: applySecretUpdates(previous?.secrets ?? {}, request.secrets),
      webhookSecrets: applySecretUpdates(
        previous?.webhookSecrets ?? {},
        request.webhookSecrets,
      ),
      startsWithServe: previous?.startsWithServe ?? false,
      runtime: previous?.runtime ?? { state: 'stopped' },
    };
    workspace.snapshot.instances[name] = instance;
    await json(route, mutateChannelSnapshot(workspace, instance));
    return;
  }

  const instance = workspace.snapshot.instances[name];
  if (!instance) {
    await json(route, { code: 'channel_not_found', name }, 404);
    return;
  }

  if (segments.length === 2 && method === 'DELETE') {
    if (!(await requireChannelRevision(route, workspace, body))) return;
    delete workspace.snapshot.instances[name];
    const result = mutateChannelSnapshot(workspace, instance);
    await json(route, result);
    return;
  }

  if (segments[2] === 'startup' && method === 'PUT') {
    if (!(await requireChannelRevision(route, workspace, body))) return;
    instance.startsWithServe = getRecordValue(body, 'enabled') === true;
    await json(route, mutateChannelSnapshot(workspace, instance));
    return;
  }

  if (
    segments.length === 3 &&
    method === 'POST' &&
    (segments[2] === 'start' ||
      segments[2] === 'stop' ||
      segments[2] === 'restart')
  ) {
    instance.runtime = {
      state: segments[2] === 'stop' ? 'stopped' : 'connected',
    };
    await json(route, channelMutationResult(workspace, instance));
    return;
  }

  if (segments[2] === 'pairing-requests') {
    const requests = workspace.pairingRequests[name] ?? [];
    if (segments.length === 3 && method === 'GET') {
      await json(route, { requests });
      return;
    }
    if (segments[3] === 'approve' && method === 'POST') {
      const code = getRecordValue(body, 'code');
      const approved = requests.find((request) => request.code === code);
      if (!approved) {
        await json(route, { code: 'channel_pairing_request_not_found' }, 404);
        return;
      }
      workspace.pairingRequests[name] = requests.filter(
        (request) => request.code !== code,
      );
      await json(route, {
        approved,
        requests: workspace.pairingRequests[name],
      });
      return;
    }
  }

  if (segments[2] === 'auth-sessions') {
    await handleChannelAuthRoute(
      route,
      method,
      segments,
      workspace,
      instance,
      body,
    );
    return;
  }

  await json(route, { code: 'channel_route_not_found' }, 404);
}

async function requireChannelRevision(
  route: Route,
  workspace: MockChannelWorkspaceState,
  body: unknown,
): Promise<boolean> {
  const expectedRevision = getRecordValue(body, 'expectedRevision');
  if (expectedRevision === workspace.snapshot.revision) return true;
  await json(
    route,
    {
      code: 'channel_settings_conflict',
      expectedRevision,
      actualRevision: workspace.snapshot.revision,
    },
    409,
  );
  return false;
}

function applySecretUpdates(
  current: DaemonChannelInstanceSnapshot['secrets'],
  updates: DaemonChannelUpsertRequest['secrets'],
): DaemonChannelInstanceSnapshot['secrets'] {
  const next = { ...current };
  for (const [key, update] of Object.entries(updates ?? {})) {
    if (update.operation === 'preserve') continue;
    next[key] =
      update.operation === 'replace'
        ? { present: true, source: 'literal' }
        : { present: false };
  }
  return next;
}

function mutateChannelSnapshot(
  workspace: MockChannelWorkspaceState,
  instance: DaemonChannelInstanceSnapshot,
): DaemonChannelMutationResult {
  workspace.snapshot.revision = nextRevision(workspace.snapshot.revision);
  return channelMutationResult(workspace, instance);
}

function channelMutationResult(
  workspace: MockChannelWorkspaceState,
  instance: DaemonChannelInstanceSnapshot,
): DaemonChannelMutationResult {
  return { snapshot: workspace.snapshot, instance };
}

function nextRevision(revision: string): string {
  const match = /^(.*?)(\d+)$/.exec(revision);
  return match ? `${match[1]}${Number(match[2]) + 1}` : `${revision}-next`;
}

async function handleChannelAuthRoute(
  route: Route,
  method: string,
  segments: string[],
  workspace: MockChannelWorkspaceState,
  instance: DaemonChannelInstanceSnapshot,
  body: unknown,
): Promise<void> {
  const name = segments[1];
  if (segments.length === 3 && method === 'POST') {
    if (getRecordValue(body, 'channelType') !== instance.config['type']) {
      await badRequest(route, 'Channel type does not match the instance.');
      return;
    }
    const id = `auth-${name}`;
    const session: DaemonChannelAuthSession = {
      id,
      state: 'awaiting_scan',
      expiresAt: channelAuthExpiresAt,
      qrRevision: 1,
    };
    workspace.authSessions[id] = { session, pollCount: 0 };
    await json(route, session);
    return;
  }

  const sessionId = segments[3] ?? '';
  const auth = workspace.authSessions[sessionId];
  if (!auth) {
    await json(route, { code: 'channel_auth_session_not_found' }, 404);
    return;
  }

  if (segments.length === 4 && method === 'DELETE') {
    auth.session = { ...auth.session, state: 'cancelled' };
    await json(route, { cancelled: true });
    return;
  }
  if (segments.length === 4 && method === 'GET') {
    auth.pollCount += 1;
    const progression: Array<{
      state: DaemonChannelAuthSession['state'];
      qrRevision: number;
    }> = [
      { state: 'scanned', qrRevision: 1 },
      { state: 'refreshing', qrRevision: 2 },
      { state: 'awaiting_scan', qrRevision: 2 },
      { state: 'scanned', qrRevision: 2 },
      { state: 'ready', qrRevision: 2 },
    ];
    const next =
      progression[Math.min(auth.pollCount - 1, progression.length - 1)];
    auth.session = { ...auth.session, ...next };
    await json(route, auth.session);
    return;
  }
  if (segments[4] === 'qr' && method === 'GET') {
    await svg(route, auth.session.qrRevision);
    return;
  }
  if (segments[4] === 'commit' && method === 'POST') {
    if (auth.session.state !== 'ready') {
      await json(route, { code: 'channel_auth_not_ready' }, 409);
      return;
    }
    if (getRecordValue(body, 'channelType') !== instance.config['type']) {
      await badRequest(route, 'Channel type does not match the instance.');
      return;
    }
    auth.session = { ...auth.session, state: 'committed' };
    instance.runtime = { state: 'connected' };
    await json(route, mutateChannelSnapshot(workspace, instance));
    return;
  }
  await json(route, { code: 'channel_auth_route_not_found' }, 404);
}

async function svg(route: Route, revision: number): Promise<void> {
  const foreground = revision === 1 ? '#111827' : '#1d4ed8';
  const body =
    `<svg xmlns="http://www.w3.org/2000/svg" width="224" height="224" viewBox="0 0 224 224">` +
    `<rect width="224" height="224" fill="#fff"/>` +
    `<path fill="${foreground}" d="M20 20h56v56H20zm128 0h56v56h-56zM20 148h56v56H20zm92-52h20v20h-20zm36 36h20v20h-20zm-52 36h20v20H96z"/>` +
    `</svg>`;
  await route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    headers: {
      'cache-control': 'no-store, no-cache, must-revalidate',
      pragma: 'no-cache',
    },
    body,
  });
}

async function handleDaemonRoute(
  route: Route,
  method: string,
  path: string,
  scenario: WebShellDaemonScenario,
  body: unknown,
  searchParams: URLSearchParams = new URLSearchParams(),
): Promise<void> {
  if (isChannelPath(path)) {
    await handleChannelRoute(route, method, path, scenario, body);
    return;
  }
  if (method === 'GET' && path === '/health') {
    await json(route, { ok: true, healthy: true });
    return;
  }
  if (method === 'GET' && path === '/capabilities') {
    await json(route, scenario.capabilities);
    return;
  }
  if (method === 'GET' && path === '/workspace/providers') {
    await json(route, scenario.providers);
    return;
  }
  if (method === 'GET' && path === '/workspace/skills') {
    await json(route, scenario.skills);
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
  if (method === 'GET' && /^\/workspaces?\/.+\/sessions\/?$/.test(path)) {
    // Mirror production query modes: `group=pinned` is the pinned bucket;
    // `group=all` (and missing group) returns the full active list. The UI
    // excludes pinned rows from organized sections via `excludePinned`.
    const group = searchParams.get('group');
    const workspaceSelector = path
      .replace(/^\/workspaces?\//, '')
      .replace(/\/sessions\/?$/, '');
    const workspaceCwd = decodeURIComponent(workspaceSelector);
    const workspaceSessions = scenario.sessions.filter(
      (session) => session.workspaceCwd === workspaceCwd,
    );
    const sessions =
      group === 'pinned'
        ? workspaceSessions.filter((session) => Boolean(session.isPinned))
        : workspaceSessions;
    await json(route, { sessions });
    return;
  }
  if (method === 'GET' && /^\/workspaces?\/.+\/session-groups\/?$/.test(path)) {
    const catalog: DaemonSessionGroupCatalog = {
      groups: scenario.sessionGroups,
      colorOptions: ['red', 'orange', 'yellow', 'green', 'blue', 'purple'],
    };
    await json(route, catalog);
    return;
  }
  if (method === 'POST' && path === '/session') {
    await json(route, sessionEnvelope(scenario, { attached: false }));
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
      const sessionWorkspaceCwd = workspaceCwdForSession(scenario, sessionId);
      await json(route, {
        v: 1,
        sessionId,
        workspaceCwd: sessionWorkspaceCwd,
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

function restoredSessionEnvelope(
  scenario: WebShellDaemonScenario,
  sessionId: string,
): DaemonRestoredSession {
  return {
    sessionId,
    workspaceCwd: workspaceCwdForSession(scenario, sessionId),
    attached: true,
    clientId: scenario.clientId,
    createdAt: now,
    hasActivePrompt: false,
    state: scenario.state,
    compactedReplay: scenario.events,
    liveJournal: [],
    lastEventId: maxEventId(scenario.events),
  };
}

function workspaceCwdForSession(
  scenario: WebShellDaemonScenario,
  sessionId: string,
): string {
  return (
    scenario.sessions.find((session) => session.sessionId === sessionId)
      ?.workspaceCwd ?? scenario.workspaceCwd
  );
}

function maxEventId(events: readonly DaemonEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.id ?? max), 0);
}

function promptIdFor(body: PromptRequest): string {
  const meta = body?._meta;
  if (meta && typeof meta['promptId'] === 'string') return meta['promptId'];
  return 'prompt-e2e';
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
  return {
    v: 1,
    workspaceCwd: scenario.workspaceCwd,
    initialized: true,
    discoveryState: 'completed',
    servers: [],
    errors: [],
    clientCount: 0,
    budgetMode: 'off',
    budgets: [],
  };
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
  return {
    v: 1,
    workspaceCwd: scenario.workspaceCwd,
    enabled: false,
    mode: 'hold',
    language: 'en',
    voiceModel: null,
    availableVoiceModels: [],
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
