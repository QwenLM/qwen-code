/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionArchiveCoordinator } from './session-archive.js';
import type { RequestedSessionIdAdmission } from '../session-id-admission.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';
import { restoreSessionCore } from './session-restore.js';

// These cases drive the core directly rather than through supertest. The
// route-level suite records why: an HTTP disconnect assertion depends on
// Node's close-event timing and is flaky in CI. The cancellation predicate is
// the seam the extraction introduced, so it can be flipped deterministically
// here — which is the only way to pin the two cleanup arms and the telemetry
// sink that the HTTP oracle passes with mutated.
const mocks = vi.hoisted(() => ({
  readWorktreeSessionStrict: vi.fn(),
  resolveSessionIdForRestore: vi.fn(),
  assertSessionRestorable: vi.fn(),
  readLoadableLiveConversationMetadata: vi.fn(),
  reconcileDanglingPromptTerminals: vi.fn(),
  readRecentPromptTerminals: vi.fn(),
  sessionService: {
    getWorktreeSessionPath: vi.fn((id: string) => `/store/${id}.worktree.json`),
    readCreationMetadata: vi.fn(),
  },
}));

vi.mock(
  '@qwen-code/qwen-code-core/services/worktreeSessionService.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@qwen-code/qwen-code-core/services/worktreeSessionService.js')
    >()),
    readWorktreeSessionStrict: mocks.readWorktreeSessionStrict,
  }),
);
vi.mock('./session-archive.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session-archive.js')>()),
  resolveSessionIdForRestore: mocks.resolveSessionIdForRestore,
  assertSessionRestorable: mocks.assertSessionRestorable,
}));
vi.mock('../workspace-runtime-storage.js', () => ({
  runWithWorkspaceRuntimeStorage: (
    _runtime: unknown,
    fn: () => Promise<unknown>,
  ) => fn(),
  createWorkspaceRuntimeSessionService: () => mocks.sessionService,
}));
vi.mock('../../runtime/live-session-source.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../runtime/live-session-source.js')
  >()),
  readLoadableLiveConversationMetadata:
    mocks.readLoadableLiveConversationMetadata,
}));
vi.mock('../prompt-terminal-ledger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../prompt-terminal-ledger.js')>()),
  reconcileDanglingPromptTerminals: mocks.reconcileDanglingPromptTerminals,
  readRecentPromptTerminals: mocks.readRecentPromptTerminals,
}));

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const WORKSPACE_CWD = '/ws';

function restoredSession() {
  return {
    sessionId: SESSION_ID,
    clientId: 'client-1',
    attached: false,
    hasActivePrompt: false,
    currentCwd: undefined as string | undefined,
  };
}

function fakeBridge(overrides: Record<string, unknown> = {}) {
  return {
    loadSession: vi.fn(async () => restoredSession()),
    resumeSession: vi.fn(async () => restoredSession()),
    detachClient: vi.fn(async () => {}),
    killSession: vi.fn(async () => {}),
    changeSessionCwd: vi.fn(async (_id: string, req: { path: string }) => ({
      newCwd: req.path,
    })),
    setSessionWorktree: vi.fn(),
    fireDeferredRestoreAskUserQuestionPrompt: undefined,
    discardDeferredRestoreAskUserQuestionPrompt: undefined,
    ...overrides,
  };
}

function fakeRuntime(
  bridge: ReturnType<typeof fakeBridge>,
  provenance: 'workspace' | 'live-conversation' = 'workspace',
): WorkspaceRuntime {
  return {
    bridge,
    workspaceCwd: WORKSPACE_CWD,
    workspaceId: 'ws-1',
    provenance,
    sessionRuntimeBaseDir: '/store',
    trusted: true,
  } as unknown as WorkspaceRuntime;
}

const archiveCoordinator = {
  runSharedMany: async <T>(_ids: string[], fn: () => Promise<T>) => fn(),
} as unknown as SessionArchiveCoordinator;

function fakeAdmission() {
  const release = vi.fn();
  const admission = {
    reserveRestore: vi.fn(() => ({ release })),
  } as unknown as RequestedSessionIdAdmission;
  return { admission, release };
}

type CoreOptions = Parameters<typeof restoreSessionCore>[0];

function coreOptions(
  runtime: WorkspaceRuntime,
  overrides: Partial<CoreOptions> = {},
) {
  const { admission, release } = fakeAdmission();
  return {
    release,
    options: {
      action: 'load' as const,
      runtime,
      workspaceCwd: WORKSPACE_CWD,
      sessionId: SESSION_ID,
      archiveCoordinator,
      requestedSessionIdAdmission: admission,
      assertRuntimeGenerationOpen: undefined,
      daemonLog: undefined,
      materializeLiveConversationDirectory: undefined,
      historyPageSize: undefined,
      liveReplayMode: undefined,
      compactedReplayMode: undefined,
      clientId: undefined,
      approvalMode: undefined,
      restoreSource: {},
      isCancelled: () => false,
      ...overrides,
    },
  };
}

/** Lets every pending microtask run; a bare `await null` samples too early. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await flush();
  }
  throw new Error('condition never became true');
}

beforeEach(() => {
  vi.clearAllMocks();
  // A missing sidecar keeps the reconcile a no-op, so these cases observe the
  // cancellation arms rather than the worktree classification rules.
  mocks.readWorktreeSessionStrict.mockResolvedValue({ state: 'missing' });
  mocks.resolveSessionIdForRestore.mockResolvedValue(undefined);
  mocks.assertSessionRestorable.mockResolvedValue(undefined);
  mocks.readLoadableLiveConversationMetadata.mockResolvedValue({});
  mocks.reconcileDanglingPromptTerminals.mockResolvedValue(undefined);
  mocks.readRecentPromptTerminals.mockReturnValue([]);
  mocks.sessionService.readCreationMetadata.mockResolvedValue({});
  mocks.sessionService.getWorktreeSessionPath.mockImplementation(
    (id: string) => `/store/${id}.worktree.json`,
  );
});

describe('restoreSessionCore', () => {
  it('returns the restored session and releases the reservation', async () => {
    const bridge = fakeBridge();
    const { options, release } = coreOptions(fakeRuntime(bridge));

    const result = await restoreSessionCore(options);

    expect(result.kind).toBe('restored');
    expect(bridge.loadSession).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('cancels before the worktree reconcile without awaiting the cleanup', async () => {
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let killStarted = false;
    let killFinished = false;
    const bridge = fakeBridge({
      killSession: vi.fn(async () => {
        killStarted = true;
        await gate;
        killFinished = true;
      }),
    });
    const { options, release } = coreOptions(fakeRuntime(bridge), {
      isCancelled: () => true,
    });

    const result = await restoreSessionCore(options);

    expect(result).toEqual({ kind: 'cancelled' });
    // One sidecar read only: the pre-restore read. The reconcile never ran,
    // which is what places this arm before it rather than after.
    expect(mocks.readWorktreeSessionStrict).toHaveBeenCalledTimes(1);
    expect(killStarted).toBe(true);
    // `void cleanupRestoredSession()` — the caller is not held for the kill.
    expect(killFinished).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);

    openGate();
    await until(() => killFinished);
  });

  it('cancels after the worktree reconcile and awaits the cleanup', async () => {
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let killStarted = false;
    let killFinished = false;
    const bridge = fakeBridge({
      killSession: vi.fn(async () => {
        killStarted = true;
        await gate;
        killFinished = true;
      }),
    });
    let calls = 0;
    const { options, release } = coreOptions(fakeRuntime(bridge), {
      isCancelled: () => ++calls > 1,
    });

    let settled = false;
    const pending = restoreSessionCore(options).then((r) => {
      settled = true;
      return r;
    });
    await until(() => killStarted);

    // Two sidecar reads: the pre-restore read and the reconcile's own read.
    expect(mocks.readWorktreeSessionStrict).toHaveBeenCalledTimes(2);
    // `await cleanupRestoredSession()` — the core must not settle first.
    expect(settled).toBe(false);
    expect(killFinished).toBe(false);

    openGate();
    const result = await pending;

    expect(result).toEqual({ kind: 'cancelled' });
    expect(killFinished).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('publishes the resolved workspace once for an internal runtime', async () => {
    const bridge = fakeBridge();
    const onWorkspaceResolved = vi.fn();
    mocks.resolveSessionIdForRestore.mockResolvedValue(SESSION_ID);
    mocks.assertSessionRestorable.mockResolvedValue({ kind: 'workspace' });
    const { options } = coreOptions(fakeRuntime(bridge, 'live-conversation'), {
      onWorkspaceResolved,
      materializeLiveConversationDirectory: async () => '/ws/live/1',
    });

    const result = await restoreSessionCore(options);

    expect(result.kind).toBe('restored');
    expect(onWorkspaceResolved).toHaveBeenCalledTimes(1);
    expect(onWorkspaceResolved).toHaveBeenCalledWith(WORKSPACE_CWD);
  });

  it('releases the reservation when the bridge restore fails', async () => {
    const bridge = fakeBridge({
      loadSession: vi.fn(async () => {
        throw new Error('bridge exploded');
      }),
    });
    const { options, release } = coreOptions(fakeRuntime(bridge));

    await expect(restoreSessionCore(options)).rejects.toThrow(
      'bridge exploded',
    );

    expect(release).toHaveBeenCalledTimes(1);
  });
});
