import { vi, type Mock } from 'vitest';
import * as React from 'react';
import type {
  DaemonSessionSummary,
  DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';

export { flushReact as flushSidebar } from './reactHarness';

interface SessionPageState {
  sessions: DaemonSessionSummary[];
  data?: DaemonSessionSummary[];
}

export function resolveWebShellSessions<
  State extends SessionPageState,
  Query extends Record<string, unknown>,
>(
  state: State,
  enabled: boolean,
  catalogQuery: Query,
): State & {
  sessions: DaemonSessionSummary[];
  data: DaemonSessionSummary[] | undefined;
  catalogQuery: Query;
} {
  if (!enabled) {
    return { ...state, sessions: [], data: undefined, catalogQuery };
  }

  // An absent key is a legacy settled fixture; an explicit undefined value
  // models the real catalog hook before its first page has loaded.
  const data = Object.hasOwn(state, 'data') ? state.data : state.sessions;
  return {
    ...state,
    sessions: data === undefined ? [] : state.sessions,
    data,
    catalogQuery,
  };
}

export function installSidebarDomShims(): void {
  // IS_REACT_ACT_ENVIRONMENT and Element.prototype.scrollIntoView are owned
  // by test/setup.ts, a vitest setupFile that runs before any test module
  // body — re-installing them here would be unreachable no-ops. This file
  // only adds the pointer-event API jsdom lacks, which the sidebar suites
  // dispatch directly.
  if (!globalThis.PointerEvent) {
    globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
}

export function makeSidebarSession(
  sessionId: string,
  overrides: Partial<DaemonSessionSummary> = {},
): DaemonSessionSummary {
  return {
    sessionId,
    workspaceCwd: '/tmp/project',
    displayName: `Session ${sessionId}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    clientCount: 0,
    hasActivePrompt: false,
    isArchived: false,
    isPinned: false,
    groupId: null,
    color: null,
    ...overrides,
  } as DaemonSessionSummary;
}

export function clickSidebarElement(
  element: HTMLElement,
  includePointerEvents = false,
): void {
  if (includePointerEvents) {
    element.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
    );
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  }
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

// ---------------------------------------------------------------------------
// Shared mocked-daemon skeleton for the WebShellSidebar suites.
//
// `createSidebarMocks` is called once at the test file's top level; the
// bundle is a single set of module-level objects, stable across renders.
// Test files must reference the bundle from their vi.mock factories only
// through deferred arrows (render-time reads), never at factory-execution
// time, so the factories stay safe no matter which import resolves the
// mocked module first. A fresh per-render object from a mocked hook is the
// known trigger for the Radix popper measurement loop in jsdom.
// ---------------------------------------------------------------------------

/** Approval modes the mocked daemon-react-sdk module exposes. */
export const DAEMON_APPROVAL_MODES: string[] = [
  'default',
  'plan',
  'auto-edit',
  'auto',
  'yolo',
];

export interface SidebarConnectionCapabilities {
  qwenCodeVersion: string;
  features: string[];
  workspaceCwd?: string;
  workspaces?: DaemonWorkspaceCapability[];
}

export interface SidebarConnection {
  status: 'connected';
  sessionId: string | null;
  workspaceCwd: string;
  /** Partial: suites flip single feature bits on the connection at runtime. */
  capabilities?: Partial<SidebarConnectionCapabilities>;
  /** Suites flip transcript-load state at runtime (restore-failure flows). */
  error?: Error | undefined;
  loadingTranscript: boolean;
  sessionContext?:
    | { kind: 'workspace'; cwd: string }
    | { kind: 'standalone' }
    | { kind: 'live' };
  supportedCommands?: { workflowsEnabled?: boolean };
}

export function createSidebarConnection(
  overrides: Partial<SidebarConnection> = {},
): SidebarConnection {
  return {
    status: 'connected',
    sessionId: null,
    workspaceCwd: '/tmp/project',
    loadingTranscript: false,
    ...overrides,
  };
}

export interface SidebarWorkspaceClient {
  workspaceByCwd: Mock;
  searchWorkspaceSessions?: Mock;
  /** Paginated workspace catalog read (standalone-sessions flows). */
  listWorkspaceSessionsPage: Mock;
  /** Paginated standalone catalog read. */
  listStandaloneSessionsPage: Mock;
  archiveStandaloneSessions: Mock;
}

export interface SidebarWorkspace {
  baseUrl?: string;
  /** Partial: suites flip single feature bits on the workspace at runtime. */
  capabilities?: Partial<SidebarConnectionCapabilities>;
  client: SidebarWorkspaceClient;
  refreshCapabilities: Mock;
}

export function createSidebarWorkspace(
  options: {
    baseUrl?: string;
    colorOptions?: string[];
    searchWorkspaceSessions?: boolean;
    capabilities?: Partial<SidebarConnectionCapabilities>;
  } = {},
): SidebarWorkspace {
  const client: SidebarWorkspaceClient = {
    ...(options.searchWorkspaceSessions
      ? {
          searchWorkspaceSessions: vi.fn().mockResolvedValue({ results: [] }),
        }
      : {}),
    listWorkspaceSessionsPage: vi.fn().mockResolvedValue({ sessions: [] }),
    listStandaloneSessionsPage: vi.fn().mockResolvedValue({ sessions: [] }),
    archiveStandaloneSessions: vi.fn(),
    workspaceByCwd: vi.fn(() => ({
      listWorkspaceSessions: vi.fn().mockResolvedValue([]),
      listSessionGroups: vi.fn().mockResolvedValue({
        groups: [],
        colorOptions: options.colorOptions ?? [],
      }),
    })),
  };
  return {
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    capabilities: options.capabilities,
    client,
    refreshCapabilities: vi.fn(),
  };
}

export interface SidebarWorkspaceActions {
  addWorkspace: Mock;
  removeWorkspace: Mock;
  listSessionGroups: Mock;
  createSessionGroup: Mock;
  updateSessionGroup: Mock;
  deleteSessionGroup: Mock;
  updateSessionOrganization: Mock;
}

export function createSidebarWorkspaceActions(
  options: {
    colorOptions?: string[];
  } = {},
): SidebarWorkspaceActions {
  return {
    addWorkspace: vi.fn(),
    removeWorkspace: vi.fn(),
    listSessionGroups: vi.fn().mockResolvedValue({
      groups: [],
      colorOptions: options.colorOptions ?? [],
    }),
    createSessionGroup: vi.fn(),
    updateSessionGroup: vi.fn(),
    deleteSessionGroup: vi.fn(),
    updateSessionOrganization: vi.fn(),
  };
}

export interface SidebarSessionPageState {
  sessions: DaemonSessionSummary[];
  loading: boolean;
  error: Error | null;
  data?: DaemonSessionSummary[];
  reload: Mock;
  deleteSession: Mock;
  archiveSession: Mock;
  unarchiveSession: Mock;
  exportSession: Mock;
}

/**
 * One catalog page (active/pinned/archived). `includeData: false` keeps the
 * legacy settled shape without the explicit `data` key.
 */
export function createSidebarSessionPageState(
  options: {
    includeData?: boolean;
  } = {},
): SidebarSessionPageState {
  const sessions: DaemonSessionSummary[] = [];
  const state: SidebarSessionPageState = {
    sessions,
    loading: false,
    error: null,
    reload: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(true),
    archiveSession: vi.fn().mockResolvedValue(true),
    unarchiveSession: vi.fn().mockResolvedValue(true),
    exportSession: vi.fn(),
  };
  if (options.includeData !== false) {
    state.data = sessions;
  }
  return state;
}

export interface SidebarMocksOptions {
  /** `connection.capabilities`; the brand suites carry the daemon version. */
  connectionCapabilities?: SidebarConnectionCapabilities;
  workspaceCapabilities?: SidebarConnectionCapabilities;
  workspaceBaseUrl?: string;
  colorOptions?: string[];
  searchWorkspaceSessions?: boolean;
  /** The workspace-removal pages keep the legacy no-`data` shape. */
  includePageData?: boolean;
  connection?: Partial<SidebarConnection>;
}

export interface SidebarMocks {
  connection: SidebarConnection;
  workspace: SidebarWorkspace;
  workspaceActions: SidebarWorkspaceActions;
  /** Stable `useActions()` payload. */
  actions: { renameSession: Mock };
  /** Stable `useChannels()` payload. */
  channels: {
    data: undefined;
    catalog: never[];
    channels: Record<string, never>;
  };
  active: SidebarSessionPageState;
  pinned: SidebarSessionPageState;
  archived: SidebarSessionPageState;
  refreshSessionCatalogQueries: Mock;
  useSessionCatalogQueries: Mock;
  loadSession: Mock;
}

/**
 * The stable per-file bundle of the sidebar suites' mocked daemon state.
 */
export function createSidebarMocks(
  options: SidebarMocksOptions = {},
): SidebarMocks {
  const pageOptions = { includeData: options.includePageData };
  return {
    connection: createSidebarConnection({
      capabilities: options.connectionCapabilities,
      ...options.connection,
    }),
    workspace: createSidebarWorkspace({
      baseUrl: options.workspaceBaseUrl,
      colorOptions: options.colorOptions,
      searchWorkspaceSessions: options.searchWorkspaceSessions,
      capabilities: options.workspaceCapabilities,
    }),
    workspaceActions: createSidebarWorkspaceActions({
      colorOptions: options.colorOptions,
    }),
    actions: { renameSession: vi.fn() },
    channels: { data: undefined, catalog: [], channels: {} },
    active: createSidebarSessionPageState(pageOptions),
    pinned: createSidebarSessionPageState(pageOptions),
    archived: createSidebarSessionPageState(pageOptions),
    refreshSessionCatalogQueries: vi.fn(),
    useSessionCatalogQueries: vi.fn(() => []),
    loadSession: vi.fn(),
  };
}

/** The page selected by the mocked useSessions options. */
export function sidebarSessionPage(
  mocks: SidebarMocks,
  options?: { archiveState?: string; group?: string },
): SidebarSessionPageState {
  if (options?.archiveState === 'archived') {
    return mocks.archived;
  }
  if (options?.group === 'pinned') {
    return mocks.pinned;
  }
  return mocks.active;
}

/**
 * useWebShellSessions in the settled-catalog shape: the page state passes
 * through with a legacy catalog query attached.
 */
export function resolvedWebShellSessions(
  mocks: SidebarMocks,
  options?: { enabled?: boolean; archiveState?: string; group?: string },
) {
  const state = sidebarSessionPage(mocks, options);
  const catalogQuery = {
    routeKind: 'legacy' as const,
    workspaceCwd: mocks.connection.workspaceCwd,
    options,
  };
  return resolveWebShellSessions(
    state,
    options?.enabled !== false,
    catalogQuery,
  );
}

/**
 * Stateful useSessionCatalogQuery mock: mirrors the page read from
 * `client.workspaceByCwd(cwd).listWorkspaceSessions` and auto-loads once.
 */
export function useSidebarSessionCatalogQuery(
  client: SidebarWorkspaceClient,
  query: { workspaceCwd: string; options?: Record<string, unknown> },
  options: { autoLoad?: boolean; enabled?: boolean },
) {
  const [snapshot, setSnapshot] = React.useState({
    sessions: [] as DaemonSessionSummary[],
    loading: false,
    error: undefined as Error | undefined,
  });
  const reload = React.useCallback(async () => {
    const sessions = await client
      .workspaceByCwd(query.workspaceCwd)
      .listWorkspaceSessions(query.options);
    setSnapshot({ sessions, loading: false, error: undefined });
    return { sessions };
  }, [client, query.options, query.workspaceCwd]);
  React.useEffect(() => {
    if (options.enabled === false || !options.autoLoad) {
      return;
    }
    void reload().catch((error: Error) => {
      setSnapshot((current) => ({ ...current, loading: false, error }));
    });
  }, [options.autoLoad, options.enabled, reload]);
  return { ...snapshot, reload };
}

/** Settled static page for suites whose render trees never reload it. */
export function staticSidebarSessionCatalogQuery() {
  return {
    sessions: [] as DaemonSessionSummary[],
    loading: false,
    error: undefined as Error | undefined,
    reload: vi.fn(),
  };
}
