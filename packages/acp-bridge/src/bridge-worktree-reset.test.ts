/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { makeBridge, makeChannel, WS_A } from './internal/testUtils.js';
import {
  SessionNotFoundError,
  SessionResetPendingError,
} from './bridgeErrors.js';
import { SERVE_CONTROL_EXT_METHODS } from './status.js';
import { DAEMON_RESTORE_ASK_USER_QUESTION_META_KEY } from './bridgeTypes.js';

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

        await bridge.severSessionClients?.(owner.sessionId);

        // The last detach runs the natural idle-close path: the child gets
        // the ordinary sessionClose round trip, the entry leaves the
        // catalog, and the now-empty channel follows the idle policy
        // (zero-configured timeout kills it immediately in tests).
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

    it('is a no-op for an unknown session id', async () => {
      const handle = makeChannel();
      const bridge = makeBridge({
        channelFactory: async () => handle.channel,
      });
      try {
        const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });

        await bridge.severSessionClients?.('missing-session');

        expect(bridge.getSessionSummary(session.sessionId).clientCount).toBe(1);
        expect(bridge.sessionCount).toBe(1);
      } finally {
        await bridge.shutdown();
      }
    });
  });
});
