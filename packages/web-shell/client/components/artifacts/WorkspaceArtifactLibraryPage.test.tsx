// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DaemonHttpError,
  type DaemonArtifactLibrarySessionEnvelope,
  type DaemonClient,
  type DaemonSessionArtifact,
  type DaemonWorkspaceArtifactLibraryStreamEvent,
} from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';
import {
  WORKSPACE_ARTIFACT_LIBRARY_FEATURE,
  WORKSPACE_ARTIFACT_LIBRARY_STREAM_FEATURE,
  type WorkspaceArtifactLibraryReader,
} from '../../hooks/useWorkspaceArtifactLibrary';
import { getSessionCatalogStore } from '../../session-catalog/session-catalog-store';
import {
  classifyWorkspaceArtifactDispatch,
  resolvePendingArtifactJumpOpen,
  runArtifactLibrarySessionJump,
  type PendingArtifactJumpOpenRequest,
} from './artifactUtils';
import { WorkspaceArtifactLibraryPage } from './WorkspaceArtifactLibraryPage';

const mocks = vi.hoisted(() => {
  const readSessionArtifactContent = vi.fn();
  const readWorkspaceFile = vi.fn();
  const readFileBytes = vi.fn();
  const stat = vi.fn();
  const client = {
    readSessionArtifactContent,
  };
  const capabilities = {
    workspaceCwd: '/work/proj',
    features: ['workspace_artifact_library'],
  };
  const actions = {
    readWorkspaceFile,
    readFileBytes,
    stat,
  };
  return {
    readSessionArtifactContent,
    readWorkspaceFile,
    readFileBytes,
    stat,
    client,
    capabilities,
    actions,
  };
});

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useConnection: () => ({
    sessionId: 'sess-connected-current',
    clientId: 'client-1',
    status: 'connected',
  }),
  useWorkspace: () => ({
    baseUrl: 'http://daemon',
    capabilities: mocks.capabilities,
    client: mocks.client,
  }),
  useWorkspaceActions: () => mocks.actions,
}));

vi.mock('./useArtifactWorkspaceTarget', () => ({
  useArtifactWorkspaceTarget: (cwd: string | undefined) =>
    cwd
      ? {
          workspaceCwd: cwd,
          actions: mocks.actions,
        }
      : undefined,
  resolveArtifactWorkspaceOwner: () => undefined,
}));

function makeArtifact(
  id: string,
  overrides: Partial<DaemonSessionArtifact> = {},
): DaemonSessionArtifact {
  return {
    id,
    title: `${id}.md`,
    kind: 'document',
    storage: 'workspace',
    workspacePath: `docs/${id}.md`,
    status: 'available',
    source: 'tool',
    retention: 'restorable',
    clientRetained: false,
    sizeBytes: 512,
    createdAt: '2026-11-21T08:00:00.000Z',
    updatedAt: '2026-11-21T09:00:00.000Z',
    ...overrides,
  };
}

function makeEnvelope(
  sessionId: string,
  artifacts: DaemonSessionArtifact[],
  archiveState: 'active' | 'archived' = 'active',
  displayName?: string,
): DaemonArtifactLibrarySessionEnvelope {
  return {
    v: 1,
    sessionId,
    generatedAt: '2026-11-21T10:00:00.000Z',
    limits: { maxArtifacts: 100 },
    session: {
      ...(displayName !== undefined ? { displayName } : {}),
      createdAt: '2026-11-20T00:00:00.000Z',
      archiveState,
      sourceType: 'web',
    },
    artifacts,
  };
}

function setInputValue(input: HTMLInputElement, nextValue: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, nextValue);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

describe('WorkspaceArtifactLibraryPage & dispatch contracts', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.readSessionArtifactContent.mockReset();
    mocks.readWorkspaceFile.mockReset().mockResolvedValue({
      path: 'docs/a.md',
      content: '# Hello from workspace file',
      truncated: false,
    });
    mocks.readFileBytes.mockReset().mockResolvedValue({
      contentBase64: '',
      offset: 0,
      returnedBytes: 0,
      sizeBytes: 0,
    });
    mocks.stat.mockReset().mockResolvedValue({
      sizeBytes: 27,
      modifiedMs: 1,
      type: 'file',
    });
    getSessionCatalogStore(
      mocks.client as unknown as DaemonClient,
    ).applyLiveState('/work/proj', []);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('keys snapshot dispatch on metadata.artifactType === web_preview_snapshot, sends cold-but-active snapshots to jump, and keeps metadata-only managed artifacts local (S1 & S2)', () => {
    const snapshot = makeArtifact('snap-1', {
      storage: 'published',
      managedId: 'preview-123',
      metadata: { artifactType: 'web_preview_snapshot' },
    });
    const managedMetadataOnly = makeArtifact('managed-1', {
      storage: 'managed',
      workspacePath: undefined,
      description: 'Managed descriptor only',
    });
    const workspaceFile = makeArtifact('ws-1', {
      storage: 'workspace',
      workspacePath: 'docs/ws-1.md',
    });

    expect(classifyWorkspaceArtifactDispatch(snapshot, true)).toEqual({
      kind: 'live_web_preview_snapshot',
    });
    expect(classifyWorkspaceArtifactDispatch(snapshot, false)).toEqual({
      kind: 'jump_web_preview_snapshot',
    });
    expect(
      classifyWorkspaceArtifactDispatch(managedMetadataOnly, false),
    ).toEqual({
      kind: 'metadata_detail',
    });
    expect(classifyWorkspaceArtifactDispatch(workspaceFile, false)).toEqual({
      kind: 'workspace_preview',
    });
  });

  it('holds post-jump open until the target session right-panel restore settles and cancels on mid-load session switch (S3)', () => {
    const pending = { sessionId: 'sess-target', artifactId: 'art-1' };
    const settledState = {
      currentSessionId: 'sess-target',
      switchingSessionId: null,
      panelStateKey: 'sess-target',
      restoredSessionKey: 'sess-target',
      panelRestoring: false,
      loadingTranscript: false,
      artifactsLoading: false,
      connected: true,
    };

    // No pending request -> 'none'
    expect(resolvePendingArtifactJumpOpen(undefined, settledState)).toBe(
      'none',
    );

    // Target session still switching -> wait
    expect(
      resolvePendingArtifactJumpOpen(pending, {
        ...settledState,
        currentSessionId: 'sess-old',
        switchingSessionId: 'sess-target',
      }),
    ).toBe('wait');

    // Neither connected to target session nor switching to it -> cancel
    expect(
      resolvePendingArtifactJumpOpen(pending, {
        ...settledState,
        currentSessionId: 'sess-old',
        switchingSessionId: null,
      }),
    ).toBe('cancel');

    // User switches to a different session mid-load -> cancel
    expect(
      resolvePendingArtifactJumpOpen(pending, {
        ...settledState,
        switchingSessionId: 'sess-other',
      }),
    ).toBe('cancel');

    // Reconnecting (connected: false) while all other fields match -> wait
    expect(
      resolvePendingArtifactJumpOpen(pending, {
        ...settledState,
        connected: false,
      }),
    ).toBe('wait');

    // Transcript still loading -> wait
    expect(
      resolvePendingArtifactJumpOpen(pending, {
        ...settledState,
        loadingTranscript: true,
      }),
    ).toBe('wait');

    // Artifacts still loading -> wait
    expect(
      resolvePendingArtifactJumpOpen(pending, {
        ...settledState,
        artifactsLoading: true,
      }),
    ).toBe('wait');

    // Panel restore in flight -> wait
    expect(
      resolvePendingArtifactJumpOpen(pending, {
        ...settledState,
        panelRestoring: true,
      }),
    ).toBe('wait');

    // Panel restore key not yet committed -> wait
    expect(
      resolvePendingArtifactJumpOpen(pending, {
        ...settledState,
        restoredSessionKey: undefined,
      }),
    ).toBe('wait');

    // Target session restore committed and settled -> open
    expect(resolvePendingArtifactJumpOpen(pending, settledState)).toBe('open');
  });

  it('arms post-jump pending artifact open only after archived session unarchive resolves, and fails closed on cross-workspace unarchive notFound (R1-1 & R3-2)', async () => {
    let pending: PendingArtifactJumpOpenRequest | undefined;
    let resolveUnarchive!: () => void;
    const unarchivePrimarySession = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveUnarchive = resolve;
        }),
    );
    const loadSidebarSession = vi.fn(async (_sessionId: string) => {
      // At the moment loadSidebarSession starts, pending must already be armed
      expect(pending).toEqual({
        sessionId: 'sess-archived',
        artifactId: 'art-snap',
      });
    });
    const reportError = vi.fn();

    const jumpPromise = runArtifactLibrarySessionJump({
      sessionId: 'sess-archived',
      archiveState: 'archived',
      artifactId: 'art-snap',
      targetCwd: '/work/proj',
      primaryCwd: '/work/proj',
      showChat: vi.fn(),
      unarchivePrimarySession,
      unarchiveWorkspaceSessions: vi.fn(),
      getPendingJumpArtifactOpen: () => pending,
      setPendingJumpArtifactOpen: (req) => {
        pending = req;
      },
      isCurrent: () => true,
      loadSidebarSession,
      reportError,
    });

    // While parked on `await unarchivePrimarySession`, pending MUST still be
    // undefined so `resolvePendingArtifactJumpOpen` on the current session
    // returns 'none' instead of 'cancel'.
    expect(unarchivePrimarySession).toHaveBeenCalledWith('sess-archived');
    expect(pending).toBeUndefined();
    expect(
      resolvePendingArtifactJumpOpen(pending, {
        currentSessionId: 'sess-old-current',
        switchingSessionId: null,
        panelStateKey: 'sess-old-current',
        restoredSessionKey: 'sess-old-current',
        panelRestoring: false,
        loadingTranscript: false,
        artifactsLoading: false,
        connected: true,
      }),
    ).toBe('none');

    resolveUnarchive();
    await jumpPromise;
    expect(loadSidebarSession).toHaveBeenCalledWith(
      'sess-archived',
      '/work/proj',
    );
    expect(reportError).not.toHaveBeenCalled();

    // Cross-workspace unarchive returning notFound fails closed without calling loadSidebarSession
    const loadNotFound = vi.fn();
    const reportNotFound = vi.fn();
    await runArtifactLibrarySessionJump({
      sessionId: 'sess-gone',
      archiveState: 'archived',
      artifactId: 'art-gone',
      targetCwd: '/work/secondary',
      primaryCwd: '/work/primary',
      showChat: vi.fn(),
      unarchivePrimarySession: vi.fn(),
      unarchiveWorkspaceSessions: vi.fn().mockResolvedValue({
        unarchived: [],
        alreadyActive: [],
        notFound: ['sess-gone'],
        errors: [],
      }),
      getPendingJumpArtifactOpen: () => pending,
      setPendingJumpArtifactOpen: (req) => {
        pending = req;
      },
      isCurrent: () => true,
      loadSidebarSession: loadNotFound,
      reportError: reportNotFound,
    });
    expect(loadNotFound).not.toHaveBeenCalled();
    expect(reportNotFound).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'sess-gone: not found in its workspace catalog',
      }),
      'Failed to open session',
    );

    // Cross-workspace unarchive returning alreadyActive succeeds and loads the session
    const loadAlreadyActive = vi.fn().mockResolvedValue(undefined);
    await runArtifactLibrarySessionJump({
      sessionId: 'sess-already',
      archiveState: 'archived',
      targetCwd: '/work/secondary',
      primaryCwd: '/work/primary',
      showChat: vi.fn(),
      unarchivePrimarySession: vi.fn(),
      unarchiveWorkspaceSessions: vi.fn().mockResolvedValue({
        unarchived: [],
        alreadyActive: ['sess-already'],
        notFound: [],
        errors: [],
      }),
      getPendingJumpArtifactOpen: () => pending,
      setPendingJumpArtifactOpen: (req) => {
        pending = req;
      },
      isCurrent: () => true,
      loadSidebarSession: loadAlreadyActive,
      reportError: vi.fn(),
    });
    expect(loadAlreadyActive).toHaveBeenCalledWith(
      'sess-already',
      '/work/secondary',
    );

    // R2-2: user navigates to another session while unarchive is in flight ->
    // isCurrent() flips false -> neither arms pending open nor loads old target.
    let stalePending: PendingArtifactJumpOpenRequest | undefined;
    let resolveStaleUnarchive!: () => void;
    let jumpStillCurrent = true;
    const loadStale = vi.fn();
    const stalePromise = runArtifactLibrarySessionJump({
      sessionId: 'sess-stale-a',
      archiveState: 'archived',
      artifactId: 'art-stale-a',
      targetCwd: '/work/proj',
      primaryCwd: '/work/proj',
      showChat: vi.fn(),
      unarchivePrimarySession: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveStaleUnarchive = resolve;
          }),
      ),
      unarchiveWorkspaceSessions: vi.fn(),
      getPendingJumpArtifactOpen: () => stalePending,
      setPendingJumpArtifactOpen: (req) => {
        stalePending = req;
      },
      isCurrent: () => jumpStillCurrent,
      loadSidebarSession: loadStale,
      reportError: vi.fn(),
    });
    // Simulate user clicking session B in the sidebar before unarchive finishes
    jumpStillCurrent = false;
    resolveStaleUnarchive();
    await stalePromise;
    expect(loadStale).not.toHaveBeenCalled();
    expect(stalePending).toBeUndefined();

    // R2-3: cross-workspace unarchive returning errors[] throws before arming
    // or loading and reports the error.
    let errPending: PendingArtifactJumpOpenRequest | undefined;
    const loadOnErr = vi.fn();
    const reportOnErr = vi.fn();
    await runArtifactLibrarySessionJump({
      sessionId: 'sess-archiving',
      archiveState: 'archived',
      artifactId: 'art-archiving',
      targetCwd: '/work/secondary',
      primaryCwd: '/work/primary',
      showChat: vi.fn(),
      unarchivePrimarySession: vi.fn(),
      unarchiveWorkspaceSessions: vi.fn().mockResolvedValue({
        unarchived: [],
        alreadyActive: [],
        notFound: [],
        errors: [{ sessionId: 'sess-archiving', error: 'session_archiving' }],
      }),
      getPendingJumpArtifactOpen: () => errPending,
      setPendingJumpArtifactOpen: (req) => {
        errPending = req;
      },
      isCurrent: () => true,
      loadSidebarSession: loadOnErr,
      reportError: reportOnErr,
    });
    expect(loadOnErr).not.toHaveBeenCalled();
    expect(errPending).toBeUndefined();
    expect(reportOnErr).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'session_archiving' }),
      'Failed to open session',
    );

    // R1-2 (a): jump's own loadSidebarSession rejects while isCurrent() is true ->
    // clears pendingJumpArtifactOpen and surfaces 'Failed to open session'.
    let loadFailPending: PendingArtifactJumpOpenRequest | undefined;
    const setLoadFailPending = vi.fn(
      (req: PendingArtifactJumpOpenRequest | undefined) => {
        loadFailPending = req;
      },
    );
    const reportLoadFail = vi.fn();
    await runArtifactLibrarySessionJump({
      sessionId: 'sess-load-fail',
      archiveState: 'active',
      artifactId: 'art-load-fail',
      targetCwd: '/work/proj',
      primaryCwd: '/work/proj',
      showChat: vi.fn(),
      unarchivePrimarySession: vi.fn(),
      unarchiveWorkspaceSessions: vi.fn(),
      getPendingJumpArtifactOpen: () => loadFailPending,
      setPendingJumpArtifactOpen: setLoadFailPending,
      isCurrent: () => true,
      loadSidebarSession: vi
        .fn()
        .mockRejectedValue(new Error('session deleted concurrently')),
      reportError: reportLoadFail,
    });
    expect(loadFailPending).toBeUndefined();
    expect(setLoadFailPending).toHaveBeenLastCalledWith(undefined);
    expect(reportLoadFail).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'session deleted concurrently' }),
      'Failed to open session',
    );

    // R1-2 (b): unarchive rejects AFTER isCurrent() flipped false -> stays silent
    // (does not toast an error for an abandoned jump and arms no pending open).
    let staleErrPending: PendingArtifactJumpOpenRequest | undefined;
    let rejectStaleUnarchive!: (err: Error) => void;
    let staleErrCurrent = true;
    const reportStaleErr = vi.fn();
    const staleErrPromise = runArtifactLibrarySessionJump({
      sessionId: 'sess-stale-err',
      archiveState: 'archived',
      artifactId: 'art-stale-err',
      targetCwd: '/work/proj',
      primaryCwd: '/work/proj',
      showChat: vi.fn(),
      unarchivePrimarySession: vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectStaleUnarchive = reject;
          }),
      ),
      unarchiveWorkspaceSessions: vi.fn(),
      getPendingJumpArtifactOpen: () => staleErrPending,
      setPendingJumpArtifactOpen: (req) => {
        staleErrPending = req;
      },
      isCurrent: () => staleErrCurrent,
      loadSidebarSession: vi.fn(),
      reportError: reportStaleErr,
    });
    staleErrCurrent = false;
    rejectStaleUnarchive(new Error('unarchive failed after abandon'));
    await staleErrPromise;
    expect(staleErrPending).toBeUndefined();
    expect(reportStaleErr).not.toHaveBeenCalled();
  });

  it('renders rows with displayName fallback and archive badges, previews workspace-file and metadata-only managed artifacts without loading a session, filters client-side and resets filter on workspace change, and bounds rendered rows with Show more', async () => {
    const onOpenSession = vi.fn();
    const onJumpToSessionArtifact = vi.fn();
    const reader: WorkspaceArtifactLibraryReader = {
      artifactLibraryStream: vi.fn(),
      artifactLibrary: vi.fn((ws: string) =>
        Promise.resolve({
          v: 1 as const,
          sessions:
            ws === '/work/proj-b'
              ? [
                  makeEnvelope(
                    'sess-b',
                    [
                      makeArtifact('art-b1', {
                        title: 'Workspace B Doc',
                        updatedAt: '2026-11-21T12:00:00.000Z',
                      }),
                    ],
                    'active',
                    'Workspace B Session',
                  ),
                ]
              : [
                  makeEnvelope(
                    '12345678-aaaa-bbbb-cccc-ddddeeeeffff',
                    [
                      makeArtifact('art-managed', {
                        title: 'Managed Summary',
                        storage: 'managed',
                        workspacePath: undefined,
                        description: 'Descriptor-only output',
                        updatedAt: '2026-11-21T11:00:00.000Z',
                      }),
                      makeArtifact('art-ws', {
                        title: 'Second Doc',
                        storage: 'workspace',
                        workspacePath: 'docs/a.md',
                        updatedAt: '2026-11-21T10:00:00.000Z',
                      }),
                    ],
                    'archived',
                    undefined,
                  ),
                  makeEnvelope(
                    'sess-named',
                    [
                      makeArtifact('art-3', {
                        title: 'Third Doc',
                        workspacePath: 'src/special-path.ts',
                        updatedAt: '2026-11-21T09:00:00.000Z',
                      }),
                    ],
                    'active',
                    'Named Session',
                  ),
                ],
          errors: [],
        }),
      ),
    };

    const renderForWorkspace = async (cwd: string) => {
      await act(async () => {
        root.render(
          <I18nProvider language="en">
            <WorkspaceArtifactLibraryPage
              workspaceCwd={cwd}
              reader={reader}
              features={[WORKSPACE_ARTIFACT_LIBRARY_FEATURE]}
              isSessionLive={() => false}
              renderLimitStep={2}
              onOpenSession={onOpenSession}
              onJumpToSessionArtifact={onJumpToSessionArtifact}
            />
          </I18nProvider>,
        );
      });
      await flush();
    };

    await renderForWorkspace('/work/proj');

    expect(
      container.querySelector(
        '[data-testid="workspace-artifact-library-status"]',
      )?.textContent,
    ).toContain('Enumeration finished (2/2)');

    // Bounded rendering: 2 of 3 rows initially
    expect(
      container.querySelectorAll(
        '[data-testid="workspace-artifact-library-row"]',
      ),
    ).toHaveLength(2);

    const firstSessionBtn = container.querySelector(
      '[data-testid="workspace-artifact-library-session-link"]',
    ) as HTMLButtonElement;
    expect(firstSessionBtn.textContent).toContain('Session 12345678');
    expect(firstSessionBtn.textContent).toContain('Archived');

    // Opening the page shows the list only: no row is pre-selected and no
    // artifact is read before the user clicks (#18508)
    expect(
      container.querySelector(
        '[data-testid="workspace-artifact-library-detail"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="workspace-artifact-library-select-prompt"]',
      ),
    ).not.toBeNull();
    expect(mocks.stat).not.toHaveBeenCalled();
    expect(mocks.readWorkspaceFile).not.toHaveBeenCalled();

    // Clicking the metadata-only managed row renders it from the descriptor
    const firstRowBtn = container
      .querySelectorAll('[data-testid="workspace-artifact-library-row"]')[0]
      ?.querySelector('button') as HTMLButtonElement;
    await act(async () => {
      firstRowBtn.click();
    });
    await flush();
    expect(onJumpToSessionArtifact).not.toHaveBeenCalled();
    expect(
      container.querySelector(
        '[data-testid="workspace-artifact-library-detail"]',
      )?.textContent,
    ).toContain('Descriptor-only output');

    // Select the workspace-storage row -> previews via stat + readWorkspaceFile without session jump
    const secondRowBtn = container
      .querySelectorAll('[data-testid="workspace-artifact-library-row"]')[1]
      ?.querySelector('button') as HTMLButtonElement;
    await act(async () => {
      secondRowBtn.click();
    });
    await flush();
    expect(mocks.stat).toHaveBeenCalledWith('docs/a.md');
    expect(mocks.readWorkspaceFile).toHaveBeenCalledWith(
      'docs/a.md',
      expect.objectContaining({ maxBytes: 256 * 1024 }),
    );
    expect(
      container.querySelector(
        '[data-testid="workspace-artifact-library-detail"]',
      )?.textContent,
    ).toContain('Hello from workspace file');

    // Click Show more -> 3rd row appears
    const loadMoreBtn = container.querySelector(
      '[data-testid="workspace-artifact-library-load-more"]',
    ) as HTMLButtonElement;
    expect(loadMoreBtn.textContent).toContain('(2/3)');
    await act(async () => {
      loadMoreBtn.click();
    });
    expect(
      container.querySelectorAll(
        '[data-testid="workspace-artifact-library-row"]',
      ),
    ).toHaveLength(3);

    // Client-side filter matches description, session label, workspacePath (case-insensitive)
    const filterInput = container.querySelector(
      '[data-testid="workspace-artifact-library-filter"]',
    ) as HTMLInputElement;
    await act(async () => {
      setInputValue(filterInput, '  DESCRIPTOR-ONLY ');
    });
    expect(
      container.querySelectorAll(
        '[data-testid="workspace-artifact-library-row"]',
      ),
    ).toHaveLength(1);

    await act(async () => {
      setInputValue(filterInput, 'named session');
    });
    expect(
      container.querySelectorAll(
        '[data-testid="workspace-artifact-library-row"]',
      ),
    ).toHaveLength(1);

    await act(async () => {
      setInputValue(filterInput, 'no-such-artifact-xyz');
    });
    expect(
      container.querySelectorAll(
        '[data-testid="workspace-artifact-library-row"]',
      ),
    ).toHaveLength(0);
    expect(
      container.querySelector(
        '[data-testid="workspace-artifact-library-filter-empty"]',
      )?.textContent,
    ).toContain('No artifacts match the current filter.');

    // Switching workspaceCwd resets filterText and clears filter-empty
    await renderForWorkspace('/work/proj-b');
    expect(filterInput.value).toBe('');
    expect(
      container.querySelector(
        '[data-testid="workspace-artifact-library-filter-empty"]',
      ),
    ).toBeNull();
    expect(
      container.querySelectorAll(
        '[data-testid="workspace-artifact-library-row"]',
      ),
    ).toHaveLength(1);

    // Clicking session label opens the session
    const sessionBtnB = container.querySelector(
      '[data-testid="workspace-artifact-library-session-link"]',
    ) as HTMLButtonElement;
    await act(async () => {
      sessionBtnB.click();
    });
    expect(onOpenSession).toHaveBeenCalledWith('sess-b', 'active');
  });

  it('does not jump on passive auto-selection of a stale-live snapshot, jumps when the user clicks it and the content route returns 404 session_not_found, jumps immediately for cold-but-active snapshots, and surfaces 404 artifact_snapshot_unavailable without jumping (S2 & R2-6)', async () => {
    const onOpenSession = vi.fn();
    const onJumpToSessionArtifact = vi.fn();
    const coldActiveSnapshot = makeArtifact('snap-cold-active', {
      title: 'Cold Active Preview',
      storage: 'published',
      managedId: 'preview-cold',
      workspacePath: undefined,
      metadata: { artifactType: 'web_preview_snapshot' },
      updatedAt: '2026-11-21T11:00:00.000Z',
    });
    const liveUnloadedRaceSnapshot = makeArtifact('snap-race', {
      title: 'Race Preview',
      storage: 'published',
      managedId: 'preview-race',
      workspacePath: undefined,
      metadata: { artifactType: 'web_preview_snapshot' },
      updatedAt: '2026-11-21T10:00:00.000Z',
    });
    const liveMissingSnapshot = makeArtifact('snap-missing', {
      title: 'Missing Snapshot File',
      storage: 'published',
      managedId: 'preview-missing',
      workspacePath: undefined,
      metadata: { artifactType: 'web_preview_snapshot' },
      updatedAt: '2026-11-21T09:00:00.000Z',
    });

    mocks.readSessionArtifactContent.mockImplementation(
      async (_sessionId: string, artifactId: string) => {
        if (artifactId === 'snap-race') {
          throw new DaemonHttpError(
            404,
            { code: 'session_not_found', error: 'No session with id' },
            'HTTP 404',
          );
        }
        if (artifactId === 'snap-missing') {
          throw new DaemonHttpError(
            404,
            { error: 'artifact_snapshot_unavailable' },
            'HTTP 404',
          );
        }
        return '<p>ok</p>';
      },
    );

    const reader: WorkspaceArtifactLibraryReader = {
      artifactLibraryStream: vi.fn(),
      artifactLibrary: vi.fn().mockResolvedValue({
        v: 1,
        sessions: [
          makeEnvelope('sess-cold-active', [coldActiveSnapshot], 'active'),
          makeEnvelope(
            'sess-live',
            [liveUnloadedRaceSnapshot, liveMissingSnapshot],
            'active',
          ),
        ],
        errors: [],
      }),
    };

    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <WorkspaceArtifactLibraryPage
            workspaceCwd="/work/proj"
            reader={reader}
            features={[WORKSPACE_ARTIFACT_LIBRARY_FEATURE]}
            isSessionLive={(sid) => sid === 'sess-live'}
            onOpenSession={onOpenSession}
            onJumpToSessionArtifact={onJumpToSessionArtifact}
          />
        </I18nProvider>,
      );
    });
    await flush();

    // R2-5: Nothing is previewed on open — not the cold jump row
    // ('snap-cold-active') and not the live snapshot below it (#18508)
    expect(mocks.readSessionArtifactContent).not.toHaveBeenCalled();
    expect(onJumpToSessionArtifact).not.toHaveBeenCalled();

    const rows = container.querySelectorAll(
      '[data-testid="workspace-artifact-library-row"]',
    );

    // Explicitly clicking 'snap-race' activates it; the 404 session_not_found falls back to jump
    const raceBtn = rows[1]?.querySelector('button') as HTMLButtonElement;
    await act(async () => {
      raceBtn.click();
    });
    await flush();
    expect(onJumpToSessionArtifact).toHaveBeenCalledWith(
      'sess-live',
      'snap-race',
      'active',
    );
    onJumpToSessionArtifact.mockClear();

    // Clicking the cold-but-active snapshot row jumps immediately
    const coldBtn = rows[0]?.querySelector('button') as HTMLButtonElement;
    await act(async () => {
      coldBtn.click();
    });
    expect(onJumpToSessionArtifact).toHaveBeenCalledWith(
      'sess-cold-active',
      'snap-cold-active',
      'active',
    );
    onJumpToSessionArtifact.mockClear();

    // Clicking the live missing-file snapshot surfaces the dedicated missing-file message and does NOT jump
    const missingBtn = rows[2]?.querySelector('button') as HTMLButtonElement;
    await act(async () => {
      missingBtn.click();
    });
    await flush();
    expect(onJumpToSessionArtifact).not.toHaveBeenCalled();
    expect(
      container.querySelector(
        '[data-testid="workspace-artifact-library-detail"] [role="alert"]',
      )?.textContent,
    ).toContain(
      'This saved version is missing or has changed. It cannot be opened.',
    );
  });

  it('exercises the production session-catalog store liveness path and subscribeLiveSessions re-render trigger (R1-7)', async () => {
    const onJumpToSessionArtifact = vi.fn();
    const store = getSessionCatalogStore(
      mocks.client as unknown as DaemonClient,
    );
    store.applyLiveState('/work/proj', [
      {
        sessionId: 'sess-store-live',
        clientCount: 1,
        hasActivePrompt: false,
        isWaitingForPermission: false,
        isWaitingForUserQuestion: false,
        updatedAt: '2026-11-21T10:00:00.000Z',
      },
    ]);
    mocks.readSessionArtifactContent.mockResolvedValue('<p>live snapshot</p>');

    const snapshot = makeArtifact('snap-store', {
      title: 'Store Live Snapshot',
      storage: 'published',
      managedId: 'preview-store',
      workspacePath: undefined,
      metadata: { artifactType: 'web_preview_snapshot' },
    });
    const reader: WorkspaceArtifactLibraryReader = {
      artifactLibraryStream: vi.fn(),
      artifactLibrary: vi.fn().mockResolvedValue({
        v: 1,
        sessions: [makeEnvelope('sess-store-live', [snapshot], 'active')],
        errors: [],
      }),
    };

    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <WorkspaceArtifactLibraryPage
            workspaceCwd="/work/proj"
            reader={reader}
            features={[WORKSPACE_ARTIFACT_LIBRARY_FEATURE]}
            onOpenSession={vi.fn()}
            onJumpToSessionArtifact={onJumpToSessionArtifact}
          />
        </I18nProvider>,
      );
    });
    await flush();

    // Opening the page loads nothing; the live snapshot previews inline only
    // after an explicit click (#18508)
    expect(mocks.readSessionArtifactContent).not.toHaveBeenCalled();
    const rowBtn = container
      .querySelector('[data-testid="workspace-artifact-library-row"]')
      ?.querySelector('button') as HTMLButtonElement;
    await act(async () => {
      rowBtn.click();
    });
    await flush();
    expect(mocks.readSessionArtifactContent).toHaveBeenCalledWith(
      'sess-store-live',
      'snap-store',
      expect.any(Object),
    );
    expect(onJumpToSessionArtifact).not.toHaveBeenCalled();

    // Clear live state -> subscribeLiveSessions fires -> the selected row is
    // now cold, so clicking it jumps to the session instead of previewing (R1-16)
    await act(async () => {
      store.applyLiveState('/work/proj', []);
    });
    await act(async () => {
      rowBtn.click();
    });
    expect(onJumpToSessionArtifact).toHaveBeenCalledWith(
      'sess-store-live',
      'snap-store',
      'active',
    );
  });

  it('opens on the list with nothing selected, and only previews the newest artifact after an explicit click (#18508)', async () => {
    const onJumpToSessionArtifact = vi.fn();
    const reader: WorkspaceArtifactLibraryReader = {
      artifactLibraryStream: vi.fn(),
      artifactLibrary: vi.fn().mockResolvedValue({
        v: 1,
        sessions: [
          makeEnvelope('sess-newest', [
            makeArtifact('newest-art', {
              title: 'newest.md',
              workspacePath: 'docs/newest.md',
              updatedAt: '2026-11-21T12:00:00.000Z',
            }),
            makeArtifact('older-art', {
              title: 'older.md',
              workspacePath: 'docs/older.md',
              updatedAt: '2026-11-21T11:00:00.000Z',
            }),
          ]),
        ],
        errors: [],
      }),
    };

    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <WorkspaceArtifactLibraryPage
            workspaceCwd="/work/proj"
            reader={reader}
            features={[WORKSPACE_ARTIFACT_LIBRARY_FEATURE]}
            isSessionLive={() => false}
            onOpenSession={vi.fn()}
            onJumpToSessionArtifact={onJumpToSessionArtifact}
          />
        </I18nProvider>,
      );
    });
    await flush();

    // The list is the landing view: both rows, no preview, no workspace read
    expect(
      container.querySelectorAll(
        '[data-testid="workspace-artifact-library-row"]',
      ),
    ).toHaveLength(2);
    expect(
      container.querySelector(
        '[data-testid="workspace-artifact-library-detail"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="workspace-artifact-library-select-prompt"]',
      )?.textContent,
    ).toContain('Select an artifact to preview it here.');
    expect(mocks.stat).not.toHaveBeenCalled();
    expect(mocks.readWorkspaceFile).not.toHaveBeenCalled();
    expect(onJumpToSessionArtifact).not.toHaveBeenCalled();

    // An explicit click is what opens the preview
    const newestBtn = container
      .querySelector('[data-testid="workspace-artifact-library-row"]')
      ?.querySelector('button') as HTMLButtonElement;
    await act(async () => {
      newestBtn.click();
    });
    await flush();
    expect(mocks.readWorkspaceFile).toHaveBeenCalledWith(
      'docs/newest.md',
      expect.objectContaining({ maxBytes: 256 * 1024 }),
    );
    expect(
      container.querySelector(
        '[data-testid="workspace-artifact-library-detail"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="workspace-artifact-library-select-prompt"]',
      ),
    ).toBeNull();
  });

  it('distinguishes finished-with-errors wording, renders 409 persistence-unavailable and 503 runtime-unavailable states, and shows the partial banner without empty state when a stream ends without complete (R1-5 & R2-2)', async () => {
    const readerWithMemberError: WorkspaceArtifactLibraryReader = {
      artifactLibraryStream: vi.fn(),
      artifactLibrary: vi.fn().mockResolvedValue({
        v: 1,
        sessions: [makeEnvelope('sess-ok', [makeArtifact('art-ok')])],
        errors: [
          {
            sessionId: 'deadbeef-1111',
            status: 413,
            code: 'transcript_too_large',
            message: 'Too large',
          },
        ],
      }),
    };

    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <WorkspaceArtifactLibraryPage
            workspaceCwd="/work/proj"
            reader={readerWithMemberError}
            features={[WORKSPACE_ARTIFACT_LIBRARY_FEATURE]}
            onOpenSession={vi.fn()}
            onJumpToSessionArtifact={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    await flush();

    expect(
      container.querySelector(
        '[data-testid="workspace-artifact-library-status"]',
      )?.textContent,
    ).toContain('Scan finished with per-session failures (2/2)');
    expect(
      container.querySelector(
        '[data-testid="workspace-artifact-library-session-errors"]',
      )?.textContent,
    ).toContain('deadbeef · transcript_too_large: Too large');

    // 409 artifact_library_unavailable
    const reader409: WorkspaceArtifactLibraryReader = {
      artifactLibraryStream: vi.fn(),
      artifactLibrary: vi.fn().mockRejectedValue(
        new DaemonHttpError(
          409,
          {
            code: 'artifact_library_unavailable',
            error: 'Artifact persistence is unavailable',
          },
          'HTTP 409',
        ),
      ),
    };

    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <WorkspaceArtifactLibraryPage
            workspaceCwd="/work/proj-409"
            reader={reader409}
            features={[WORKSPACE_ARTIFACT_LIBRARY_FEATURE]}
            onOpenSession={vi.fn()}
            onJumpToSessionArtifact={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    await flush();

    expect(
      container.querySelector(
        '[data-testid="workspace-artifact-library-request-error"]',
      )?.textContent,
    ).toContain('Artifact persistence is disabled on this daemon.');

    // 503 workspace_runtime_unavailable
    const reader503: WorkspaceArtifactLibraryReader = {
      artifactLibraryStream: vi.fn(),
      artifactLibrary: vi
        .fn()
        .mockRejectedValue(
          new DaemonHttpError(
            503,
            { code: 'workspace_runtime_unavailable', error: 'Not active' },
            'HTTP 503',
          ),
        ),
    };

    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <WorkspaceArtifactLibraryPage
            workspaceCwd="/work/proj-503"
            reader={reader503}
            features={[WORKSPACE_ARTIFACT_LIBRARY_FEATURE]}
            onOpenSession={vi.fn()}
            onJumpToSessionArtifact={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    await flush();

    expect(
      container.querySelector(
        '[data-testid="workspace-artifact-library-request-error"]',
      )?.textContent,
    ).toContain('The workspace runtime is unavailable.');

    // Unfinished stream closing with 0 rows renders partial banner and NOT empty state, and Retry re-runs scan
    let streamCalls = 0;
    const readerPartial: WorkspaceArtifactLibraryReader = {
      artifactLibrary: vi.fn(),
      artifactLibraryStream: vi.fn(
        async function* (): AsyncGenerator<DaemonWorkspaceArtifactLibraryStreamEvent> {
          streamCalls += 1;
          yield { type: 'start', v: 1, total: 3 };
        },
      ),
    };

    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <WorkspaceArtifactLibraryPage
            workspaceCwd="/work/proj-partial"
            reader={readerPartial}
            features={[
              WORKSPACE_ARTIFACT_LIBRARY_FEATURE,
              WORKSPACE_ARTIFACT_LIBRARY_STREAM_FEATURE,
            ]}
            onOpenSession={vi.fn()}
            onJumpToSessionArtifact={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    await flush();

    const partialBanner = container.querySelector(
      '[data-testid="workspace-artifact-library-partial-banner"]',
    );
    expect(partialBanner?.textContent).toContain(
      'Scan ended before completion; showing partial results. (0/3)',
    );
    expect(
      container.querySelector(
        '[data-testid="workspace-artifact-library-empty"]',
      ),
    ).toBeNull();

    const retryBtn = partialBanner?.querySelector(
      'button',
    ) as HTMLButtonElement;
    await act(async () => {
      retryBtn.click();
    });
    await flush();
    expect(streamCalls).toBe(2);
  });
});
