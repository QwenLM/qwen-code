/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { InitializeResponse } from '@agentclientprotocol/sdk';
import {
  makeBridge,
  makeChannel,
  WS_A,
  WS_B,
  type ChannelHandle,
} from './internal/testUtils.js';
import {
  SessionNotFoundError,
  SessionResetPendingError,
} from './bridgeErrors.js';
import { SERVE_CONTROL_EXT_METHODS } from './status.js';
import {
  ACTIVE_WORK_CLOSE_IF_UNHELD_PARAM,
  ACTIVE_WORK_HEARTBEAT_INTERVAL_MS,
  ACTIVE_WORK_HEARTBEAT_META_KEY,
  ACTIVE_WORK_HEARTBEAT_VERSION,
  ACTIVE_WORK_HOLD_CATEGORIES,
  ACTIVE_WORK_NOTIFICATION_METHOD,
  DAEMON_RESTORE_ASK_USER_QUESTION_META_KEY,
} from './bridgeTypes.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A child that negotiated active-work reporting (mirrors bridge.test.ts). */
function activeWorkInitializeResponse(): InitializeResponse {
  return {
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: { name: 'active-work-agent', version: '0' },
    authMethods: [],
    agentCapabilities: {},
    _meta: {
      [ACTIVE_WORK_HEARTBEAT_META_KEY]: {
        v: ACTIVE_WORK_HEARTBEAT_VERSION,
        intervalMs: ACTIVE_WORK_HEARTBEAT_INTERVAL_MS,
        categories: [...ACTIVE_WORK_HOLD_CATEGORIES],
      },
    },
  };
}

async function sendActiveWorkSnapshot(
  handle: ChannelHandle,
  seq: number,
  sessions: Array<{
    sessionId: string;
    holds: Array<{ category: string; id: string }>;
  }>,
): Promise<void> {
  await handle.agentConnection.extNotification(
    ACTIVE_WORK_NOTIFICATION_METHOD,
    { v: ACTIVE_WORK_HEARTBEAT_VERSION, seq, sessions },
  );
}

describe('worktree reset session transfer', () => {
  describe('parked deferred restore prompt activity', () => {
    it('reports a parked deferred restore prompt as active in getSessionSummary', async () => {
      const handle = makeChannel({
        promptImpl: () => ({ stopReason: 'end_turn' }),
        loadSessionImpl: () => ({
          configOptions: [],
          _meta: { [DAEMON_RESTORE_ASK_USER_QUESTION_META_KEY]: true },
        }),
      });
      const bridge = makeBridge({
        channelFactory: async () => handle.channel,
        restoreAskUserQuestion: true,
      });
      try {
        const restored = await bridge.loadSession({
          sessionId: 'reset-deferred-auq',
          workspaceCwd: WS_A,
          clientId: 'client-1',
          deferRestoreAskUserQuestionPrompt: true,
        });

        // The owner-side restore response deliberately keeps its pre-transfer
        // computation (restorePromptAdmitted || promptActive || goalTurnActive)
        // so the restore route can tell a parked prompt from a running one.
        expect(restored.hasActivePrompt).toBe(false);
        expect(handle.agent.promptCalls).toHaveLength(0);
        // The summary is the surface that must count the parked prompt as
        // in-flight: quiescence readers (reset preconditions, the Channel
        // busy probe) would otherwise relocate the session under it.
        expect(
          bridge.getSessionSummary(restored.sessionId).hasActivePrompt,
        ).toBe(true);
        expect(
          bridge
            .listWorkspaceSessions(WS_A)
            .find((s) => s.sessionId === restored.sessionId)?.hasActivePrompt,
        ).toBe(true);
        // The daemon status surface is what automation reads session activity
        // from; no other field on it reveals the parked prompt, so it must not
        // report the session as idle while the summary reports it active.
        const statusSnapshotHasActivePrompt = () =>
          bridge
            .getDaemonStatusSnapshot()
            .sessions.find((s) => s.sessionId === restored.sessionId)
            ?.hasActivePrompt;
        expect(statusSnapshotHasActivePrompt()).toBe(true);

        // Firing the parked prompt and letting it settle returns the summary
        // to quiescent — the parked state, not a sticky flag, drove the report.
        expect(
          bridge.fireDeferredRestoreAskUserQuestionPrompt?.(
            restored.sessionId,
            restored.clientId,
          ),
        ).toBe(true);
        await vi.waitFor(() => {
          expect(handle.agent.promptCalls).toHaveLength(1);
          expect(
            bridge.getSessionSummary(restored.sessionId).hasActivePrompt,
          ).toBe(false);
          expect(statusSnapshotHasActivePrompt()).toBe(false);
        });
      } finally {
        await bridge.shutdown();
      }
    });

    it('reports a parked deferred restore prompt as active to a coalesced restore waiter', async () => {
      const loadGate = deferred<void>();
      const handle = makeChannel({
        loadSessionImpl: async () => {
          await loadGate.promise;
          return {
            configOptions: [],
            _meta: { [DAEMON_RESTORE_ASK_USER_QUESTION_META_KEY]: true },
          };
        },
      });
      const bridge = makeBridge({
        channelFactory: async () => handle.channel,
        restoreAskUserQuestion: true,
      });
      try {
        const owner = bridge.loadSession({
          sessionId: 'reset-deferred-coalesced',
          workspaceCwd: WS_A,
          clientId: 'client-1',
          deferRestoreAskUserQuestionPrompt: true,
        });
        // Same-shape restores coalesce onto the in-flight owner; the waiter
        // has no restorePromptAdmitted term of its own, so without the
        // parked-prompt term it would read the session as idle.
        const waiter = bridge.loadSession({
          sessionId: 'reset-deferred-coalesced',
          workspaceCwd: WS_A,
          clientId: 'client-2',
        });
        loadGate.resolve();

        const [ownerRestored, waiterRestored] = await Promise.all([
          owner,
          waiter,
        ]);
        expect(ownerRestored.hasActivePrompt).toBe(false);
        expect(waiterRestored.hasActivePrompt).toBe(true);
        expect(handle.agent.promptCalls).toHaveLength(0);
      } finally {
        await bridge.shutdown();
      }
    });
  });

  describe('reset-pending prompt barrier', () => {
    it('throws SessionResetPendingError synchronously from sendPrompt while armed and re-admits after clear', async () => {
      const handle = makeChannel();
      const bridge = makeBridge({
        channelFactory: async () => handle.channel,
      });
      try {
        const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

        // The return value reports whether a live entry exists for the id.
        expect(bridge.setSessionResetPending?.(session.sessionId)).toBe(true);

        // Admission fails closed synchronously — before the route's 202
        // contract, same as PromptQueueFullError — and nothing reaches the
        // child.
        expect(() =>
          bridge.sendPrompt(session.sessionId, {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'blocked during reset' }],
          }),
        ).toThrow(SessionResetPendingError);
        expect(handle.agent.promptCalls).toHaveLength(0);

        bridge.clearSessionResetPending?.(session.sessionId);
        await expect(
          bridge.sendPrompt(session.sessionId, {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'admitted after reset completed' }],
          }),
        ).resolves.toEqual({ stopReason: 'end_turn' });
        expect(handle.agent.promptCalls).toHaveLength(1);
      } finally {
        await bridge.shutdown();
      }
    });

    it('blocks the trusted continueSession prompt source while armed', async () => {
      const handle = makeChannel({
        promptImpl: () => ({ stopReason: 'end_turn' }),
        extMethodImpl: (method) => {
          if (method === SERVE_CONTROL_EXT_METHODS.sessionContinue) {
            return { accepted: true, interruption: 'interrupted_prompt' };
          }
          return {};
        },
      });
      const bridge = makeBridge({
        channelFactory: async () => handle.channel,
      });
      try {
        const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
        bridge.setSessionResetPending?.(session.sessionId);

        // continueSession admits through the same sendPrompt admission path:
        // the child-side accept/decline pre-check runs, then the barrier
        // refuses admission and no continuation turn is ever dispatched.
        await expect(
          bridge.continueSession(session.sessionId, {
            clientId: session.clientId,
          }),
        ).rejects.toBeInstanceOf(SessionResetPendingError);
        expect(handle.agent.extMethodCalls).toContainEqual(
          expect.objectContaining({
            method: SERVE_CONTROL_EXT_METHODS.sessionContinue,
          }),
        );
        expect(handle.agent.promptCalls).toHaveLength(0);

        bridge.clearSessionResetPending?.(session.sessionId);
        await expect(
          bridge.continueSession(session.sessionId, {
            clientId: session.clientId,
          }),
        ).resolves.toMatchObject({ accepted: true });
        await vi.waitFor(() => {
          expect(handle.agent.promptCalls).toHaveLength(1);
        });
      } finally {
        await bridge.shutdown();
      }
    });

    it('stays armed for an id whose entry registers after the barrier was set', async () => {
      const handle = makeChannel();
      const bridge = makeBridge({
        channelFactory: async () => handle.channel,
      });
      try {
        // Arming an id with no live entry returns false (no entry) but still
        // fences the id: the transfer's replacement restore registers the
        // entry later, and a prompt admitted in between would write to a
        // checkout whose ownership just moved.
        expect(bridge.setSessionResetPending?.('reset-pending-restore')).toBe(
          false,
        );

        const restored = await bridge.loadSession({
          sessionId: 'reset-pending-restore',
          workspaceCwd: WS_A,
        });
        expect(() =>
          bridge.sendPrompt(restored.sessionId, {
            sessionId: restored.sessionId,
            prompt: [{ type: 'text', text: 'blocked after restore' }],
          }),
        ).toThrow(SessionResetPendingError);
        expect(handle.agent.promptCalls).toHaveLength(0);

        // Clearing is idempotent and re-admits.
        bridge.clearSessionResetPending?.(restored.sessionId);
        bridge.clearSessionResetPending?.(restored.sessionId);
        await expect(
          bridge.sendPrompt(restored.sessionId, {
            sessionId: restored.sessionId,
            prompt: [{ type: 'text', text: 'admitted after clear' }],
          }),
        ).resolves.toEqual({ stopReason: 'end_turn' });
      } finally {
        await bridge.shutdown();
      }
    });
  });

  describe('reset-pending writer barrier', () => {
    it('fences the non-prompt writers that reach the checkout or the cwd', async () => {
      const handle = makeChannel({
        extMethodImpl: (method) => {
          if (method === SERVE_CONTROL_EXT_METHODS.sessionRewind) {
            return { targetTurnIndex: 0, filesChanged: [], filesFailed: [] };
          }
          if (method === SERVE_CONTROL_EXT_METHODS.sessionCd) {
            return { previousCwd: WS_A, newCwd: WS_B, warnings: [] };
          }
          if (method === SERVE_CONTROL_EXT_METHODS.sessionForkAgent) {
            return { launched: true };
          }
          if (method === SERVE_CONTROL_EXT_METHODS.sessionBranch) {
            return { newSessionId: 'branch-1', title: 'Branch 1' };
          }
          return {};
        },
      });
      const bridge = makeBridge({
        channelFactory: async () => handle.channel,
        sessionShellCommandEnabled: true,
      });
      try {
        const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
        const context = { clientId: session.clientId };
        bridge.setSessionResetPending?.(session.sessionId);

        // A rewind restores files under the session cwd, a fork agent runs its
        // tools there, a shell command executes in `effectiveCwd`, a branch
        // mutates the session's persisted history and a cd moves the session —
        // all admitted precisely in the idle state the transfer requires, so
        // all must fail closed on the barrier `sendPrompt` uses.
        await expect(
          bridge.rewindSession(
            session.sessionId,
            { promptId: 'prompt-1' },
            context,
          ),
        ).rejects.toBeInstanceOf(SessionResetPendingError);
        await expect(
          bridge.launchSessionForkAgent(
            session.sessionId,
            'fork the checkout writer',
            context,
          ),
        ).rejects.toBeInstanceOf(SessionResetPendingError);
        await expect(
          bridge.branchSession(
            session.sessionId,
            { atRecordId: '11111111-1111-4111-8111-111111111111' },
            context,
          ),
        ).rejects.toBeInstanceOf(SessionResetPendingError);
        await expect(
          bridge.changeSessionCwd(session.sessionId, { path: WS_B }, context),
        ).rejects.toBeInstanceOf(SessionResetPendingError);
        await expect(
          bridge.executeShellCommand(
            session.sessionId,
            'touch written-during-transfer',
            undefined,
            context,
          ),
        ).rejects.toBeInstanceOf(SessionResetPendingError);

        // Nothing reached the child: the refusal is at admission, not a
        // dispatched-then-failed mutation.
        const dispatched = handle.agent.extMethodCalls.map(
          (call) => call.method,
        );
        for (const method of [
          SERVE_CONTROL_EXT_METHODS.sessionRewind,
          SERVE_CONTROL_EXT_METHODS.sessionForkAgent,
          SERVE_CONTROL_EXT_METHODS.sessionBranch,
          SERVE_CONTROL_EXT_METHODS.sessionCd,
        ]) {
          expect(dispatched).not.toContain(method);
        }

        // The barrier is the only thing refusing them, and the route clears it
        // in its `finally`, so a refused writer cannot wedge past the
        // transfer: the same rewind is admitted and dispatched afterwards.
        bridge.clearSessionResetPending?.(session.sessionId);
        await expect(
          bridge.rewindSession(
            session.sessionId,
            { promptId: 'prompt-1' },
            context,
          ),
        ).resolves.toMatchObject({ targetTurnIndex: 0 });
        expect(handle.agent.extMethodCalls).toContainEqual(
          expect.objectContaining({
            method: SERVE_CONTROL_EXT_METHODS.sessionRewind,
            params: expect.objectContaining({
              sessionId: session.sessionId,
              rewindFiles: true,
            }),
          }),
        );
      } finally {
        await bridge.shutdown();
      }
    });
  });

  describe('clearSessionWorktree', () => {
    it('removes the worktree association from the session summary and bumps the catalog once', async () => {
      const handle = makeChannel();
      const bridge = makeBridge({
        channelFactory: async () => handle.channel,
      });
      try {
        const worktree = { slug: 'wt', path: '/tmp/wt', branch: 'wt-branch' };
        const session = await bridge.spawnOrAttach({
          workspaceCwd: WS_A,
          worktree,
        });
        expect(bridge.getSessionSummary(session.sessionId).worktree).toEqual(
          worktree,
        );
        const v0 = bridge.getSessionCatalogVersion().revision;

        bridge.clearSessionWorktree?.(session.sessionId);
        expect(
          bridge.getSessionSummary(session.sessionId).worktree,
        ).toBeUndefined();
        expect(bridge.getSessionCatalogVersion().revision).toBe(v0 + 1);

        // No association left and unknown id: both no-ops, no further bumps.
        bridge.clearSessionWorktree?.(session.sessionId);
        bridge.clearSessionWorktree?.('missing-session');
        expect(bridge.getSessionCatalogVersion().revision).toBe(v0 + 1);
      } finally {
        await bridge.shutdown();
      }
    });
  });

  describe('severSessionClients', () => {
    it('detaches every registered client and lets the idle-close path remove the session', async () => {
      const handle = makeChannel();
      const bridge = makeBridge({
        channelFactory: async () => handle.channel,
      });
      try {
        const owner = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
        const attacher = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
        expect(attacher.sessionId).toBe(owner.sessionId);
        expect(bridge.getSessionSummary(owner.sessionId).clientCount).toBe(2);

        const severed = await bridge.severSessionClients?.(owner.sessionId);

        // The last detach runs the natural idle-close path: the child gets
        // the ordinary sessionClose round trip, the entry leaves the
        // catalog, and the now-empty channel follows the idle policy
        // (zero-configured timeout kills it immediately in tests).
        expect(severed).toBe(true);
        expect(handle.agent.extMethodCalls).toContainEqual(
          expect.objectContaining({
            method: SERVE_CONTROL_EXT_METHODS.sessionClose,
            params: expect.objectContaining({ sessionId: owner.sessionId }),
          }),
        );
        expect(bridge.sessionCount).toBe(0);
        expect(() => bridge.getSessionSummary(owner.sessionId)).toThrow(
          SessionNotFoundError,
        );
        expect(handle.killed).toBe(true);
      } finally {
        await bridge.shutdown();
      }
    });

    it('detaches a clientId registered twice so the superseded session cannot survive', async () => {
      const handle = makeChannel();
      const bridge = makeBridge({
        channelFactory: async () => handle.channel,
      });
      try {
        const owner = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
        // Reconnect shape: the client echoes the minted id, so the second
        // attach refcounts the existing registration instead of adding a key.
        // No count-based surface reveals it — clientCount counts keys, and the
        // attach ledger holds the one recorded attach (a spawn owner seeds 0).
        const reconnect = await bridge.spawnOrAttach({
          workspaceCwd: WS_A,
          clientId: owner.clientId,
        });
        expect(reconnect.clientId).toBe(owner.clientId);
        expect(bridge.getSessionSummary(owner.sessionId).clientCount).toBe(1);
        expect(
          bridge
            .getDaemonStatusSnapshot()
            .sessions.find((s) => s.sessionId === owner.sessionId)?.attachCount,
        ).toBe(1);

        await bridge.severSessionClients?.(owner.sessionId);

        // One detach per remaining registration: the surviving refcount must
        // not hold the idle close off, or the superseded session stays live
        // and promptable after the reset route clears the barrier.
        expect(bridge.sessionCount).toBe(0);
        expect(() => bridge.getSessionSummary(owner.sessionId)).toThrow(
          SessionNotFoundError,
        );
      } finally {
        await bridge.shutdown();
      }
    });

    it('is a no-op for an unknown session id', async () => {
      const handle = makeChannel();
      const bridge = makeBridge({
        channelFactory: async () => handle.channel,
      });
      try {
        const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

        // Nothing is registered for the id, so the reported end state (entry
        // gone) holds trivially.
        const severed = await bridge.severSessionClients?.('missing-session');

        expect(severed).toBe(true);
        expect(bridge.getSessionSummary(session.sessionId).clientCount).toBe(1);
        expect(bridge.sessionCount).toBe(1);
      } finally {
        await bridge.shutdown();
      }
    });

    it('reports a survivor when the child refuses the conditional idle close', async () => {
      const handle = makeChannel({
        initializeImpl: () => activeWorkInitializeResponse(),
        // The user is running a dev server inside the worktree: the child
        // holds a background shell and refuses the conditional close.
        extMethodImpl: (method) =>
          method === SERVE_CONTROL_EXT_METHODS.sessionClose
            ? { closed: false, holds: [{ category: 'shell', id: 'sh1' }] }
            : {},
      });
      const bridge = makeBridge({
        channelFactory: async () => handle.channel,
      });
      try {
        const owner = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
        // A fresh "no holds" snapshot so the detach path treats the session as
        // an auto-close candidate and actually asks the child: the refusal, not
        // the cache, is what defers the close.
        await sendActiveWorkSnapshot(handle, 1, [
          { sessionId: owner.sessionId, holds: [] },
        ]);

        const severed = await bridge.severSessionClients?.(owner.sessionId);

        // The documented end state is not reached, and the caller must be able
        // to see that: the entry is still registered, so the superseded
        // session is alive, cwd'd inside the transferred checkout,
        // re-attachable by id and — once the route clears the barrier —
        // promptable.
        expect(severed).toBe(false);
        expect(handle.agent.extMethodCalls).toContainEqual(
          expect.objectContaining({
            method: SERVE_CONTROL_EXT_METHODS.sessionClose,
            params: expect.objectContaining({
              sessionId: owner.sessionId,
              [ACTIVE_WORK_CLOSE_IF_UNHELD_PARAM]: true,
            }),
          }),
        );
        expect(bridge.sessionCount).toBe(1);
        expect(bridge.getSessionSummary(owner.sessionId).clientCount).toBe(0);
      } finally {
        await bridge.shutdown();
      }
    });
  });
});
