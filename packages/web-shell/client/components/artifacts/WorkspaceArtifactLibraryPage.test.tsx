// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DaemonHttpError,
  type DaemonArtifactLibrarySessionEnvelope,
  type DaemonSessionArtifact,
} from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';
import {
  WORKSPACE_ARTIFACT_LIBRARY_FEATURE,
  type WorkspaceArtifactLibraryReader,
} from '../../hooks/useWorkspaceArtifactLibrary';
import {
  classifyWorkspaceArtifactDispatch,
  resolvePendingArtifactJumpOpen,
} from './artifactUtils';
import { WorkspaceArtifactLibraryPage } from './WorkspaceArtifactLibraryPage';

const mocks = vi.hoisted(() => {
  const readSessionArtifactContent = vi.fn();
  const readFile = vi.fn();
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
    readFile,
    readFileBytes,
    stat,
  };
  return {
    readSessionArtifactContent,
    readFile,
    readFileBytes,
    stat,
    client,
    capabilities,
    actions,
  };
});

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useConnection: () => ({
    sessionId: 'sess-live',
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

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
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
    mocks.readFile.mockReset().mockResolvedValue({
      path: 'docs/a.md',
      content: '# Hello from workspace file',
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
    // Cold-but-active session: archiveState may be 'active' in the envelope,
    // but live-state says false -> must jump, never hit content route.
    expect(classifyWorkspaceArtifactDispatch(snapshot, false)).toEqual({
      kind: 'jump_web_preview_snapshot',
    });
    // Metadata-only storage:'managed' renders straight from descriptor, no jump.
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

    // Target session still switching / restoring -> wait
    expect(
      resolvePendingArtifactJumpOpen(pending, {
        currentSessionId: 'sess-old',
        switchingSessionId: 'sess-target',
        panelStateKey: 'sess-old',
        restoredSessionKey: 'sess-old',
        panelRestoring: false,
        loadingTranscript: true,
        artifactsLoading: true,
        connected: true,
      }),
    ).toBe('wait');

    // Connected to target session, but panel restore has not committed yet -> wait
    expect(
      resolvePendingArtifactJumpOpen(pending, {
        currentSessionId: 'sess-target',
        switchingSessionId: null,
        panelStateKey: 'sess-target',
        restoredSessionKey: undefined,
        panelRestoring: true,
        loadingTranscript: false,
        artifactsLoading: false,
        connected: true,
      }),
    ).toBe('wait');

    // User switches to a different session mid-load -> cancel
    expect(
      resolvePendingArtifactJumpOpen(pending, {
        currentSessionId: 'sess-target',
        switchingSessionId: 'sess-other',
        panelStateKey: 'sess-target',
        restoredSessionKey: undefined,
        panelRestoring: true,
        loadingTranscript: true,
        artifactsLoading: false,
        connected: true,
      }),
    ).toBe('cancel');

    // Target session restore committed and settled -> open
    expect(
      resolvePendingArtifactJumpOpen(pending, {
        currentSessionId: 'sess-target',
        switchingSessionId: null,
        panelStateKey: 'sess-target',
        restoredSessionKey: 'sess-target',
        panelRestoring: false,
        loadingTranscript: false,
        artifactsLoading: false,
        connected: true,
      }),
    ).toBe('open');
  });

  it('renders rows with displayName fallback and archive badges, filters client-side, bounds rendered rows with Show more, and previews metadata-only managed artifacts without loading a session', async () => {
    const onOpenSession = vi.fn();
    const onJumpToSessionArtifact = vi.fn();
    const reader: WorkspaceArtifactLibraryReader = {
      artifactLibraryStream: vi.fn(),
      artifactLibrary: vi.fn().mockResolvedValue({
        v: 1,
        sessions: [
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
              makeArtifact('art-2', {
                title: 'Second Doc',
                updatedAt: '2026-11-21T10:00:00.000Z',
              }),
            ],
            'archived',
            undefined, // missing displayName -> fallback to shortened sessionId
          ),
          makeEnvelope(
            'sess-named',
            [
              makeArtifact('art-3', {
                title: 'Third Doc',
                updatedAt: '2026-11-21T09:00:00.000Z',
              }),
            ],
            'active',
            'Named Session',
          ),
        ],
        errors: [],
      }),
    };

    await act(async () => {
      root.render(
        <I18nProvider>
          <WorkspaceArtifactLibraryPage
            workspaceCwd="/work/proj"
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

    // Terminal wording for clean completion: "Enumeration finished"
    expect(
      container.querySelector(
        '[data-testid="workspace-artifact-library-status"]',
      )?.textContent,
    ).toContain('Enumeration finished (2/2)');

    // Bounded rendering: only 2 of 3 rows mounted initially
    const initialRows = container.querySelectorAll(
      '[data-testid="workspace-artifact-library-row"]',
    );
    expect(initialRows).toHaveLength(2);

    // Fallback session label ("Session 12345678") and Archived badge
    const firstSessionBtn = container.querySelector(
      '[data-testid="workspace-artifact-library-session-link"]',
    ) as HTMLButtonElement;
    expect(firstSessionBtn.textContent).toContain('Session 12345678');
    expect(firstSessionBtn.textContent).toContain('Archived');

    // Metadata-only managed artifact is selected and rendered directly from descriptor without session jump
    expect(onJumpToSessionArtifact).not.toHaveBeenCalled();
    expect(
      container.querySelector(
        '[data-testid="workspace-artifact-library-detail"]',
      )?.textContent,
    ).toContain('Descriptor-only output');

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

    // Clicking session label opens the archived session
    await act(async () => {
      firstSessionBtn.click();
    });
    expect(onOpenSession).toHaveBeenCalledWith(
      '12345678-aaaa-bbbb-cccc-ddddeeeeffff',
      'archived',
    );
  });

  it('jumps for cold-but-active web_preview_snapshot, falls back to jump on content-route 404 session_not_found, and surfaces 404 artifact_snapshot_unavailable without jumping (S2)', async () => {
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
            { code: 'session_not_found', error: 'Session not found' },
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
        <I18nProvider>
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

    // Auto-selecting the first non-jump row ('snap-race' on sess-live) hit the
    // content route, got 404 session_not_found, and fell back to jump:
    expect(onJumpToSessionArtifact).toHaveBeenCalledWith(
      'sess-live',
      'snap-race',
      'active',
    );
    onJumpToSessionArtifact.mockClear();

    // Clicking the cold-but-active snapshot row jumps immediately without calling the content route
    const rows = container.querySelectorAll(
      '[data-testid="workspace-artifact-library-row"]',
    );
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

    // Clicking the live missing-file snapshot surfaces the missing-file alert and does NOT jump
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
    ).toBeTruthy();
  });

  it('distinguishes finished-with-errors wording and renders 409 persistence-unavailable and 503 runtime-unavailable states', async () => {
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
        <I18nProvider>
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
        <I18nProvider>
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
  });
});
