/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dispatch, SetStateAction } from 'react';
import type {
  DaemonSessionContextStatus,
  DaemonSessionClient,
  DaemonSessionBtwResult,
  DaemonSessionRecapResult,
  DaemonTranscriptStore,
  PermissionResponse,
} from '@qwen-code/sdk/daemon';
import {
  isNonBlockingAccepted,
  type PromptResult,
} from '@qwen-code/sdk/daemon';
import { mapSupportedCommands } from './mappers.js';
import { toDaemonPromptContent } from './promptContent.js';
import {
  clearPassiveAssistantDoneTimer,
  withActionTimeout,
  type TimerRef,
} from '../timing.js';
import type {
  ActivePrompt,
  DaemonConnectionState,
  DaemonPromptStatus,
  DaemonSessionActions,
  PendingSessionLoad,
} from './types.js';

interface RefBox<T> {
  current: T;
}

export interface CreateDaemonSessionActionsArgs {
  store: DaemonTranscriptStore;
  sessionRef: RefBox<DaemonSessionClient | undefined>;
  activePromptsRef: RefBox<Map<string, ActivePrompt>>;
  pendingSessionLoadRef: RefBox<PendingSessionLoad | undefined>;
  pendingSessionLoadIdRef: RefBox<number>;
  heartbeatSupportedRef: RefBox<boolean>;
  passiveAssistantDoneTimerRef: TimerRef;
  setConnection: Dispatch<SetStateAction<DaemonConnectionState>>;
  setPromptStatus: Dispatch<SetStateAction<DaemonPromptStatus>>;
  setRestoreSessionId: Dispatch<SetStateAction<string | undefined>>;
  setRestoreMode: Dispatch<SetStateAction<'load' | 'resume'>>;
  setRestoreSessionNonce: Dispatch<SetStateAction<number>>;
  setNewSessionNonce: Dispatch<SetStateAction<number>>;
}

export function createDaemonSessionActions({
  store,
  sessionRef,
  activePromptsRef,
  pendingSessionLoadRef,
  pendingSessionLoadIdRef,
  heartbeatSupportedRef,
  passiveAssistantDoneTimerRef,
  setConnection,
  setPromptStatus,
  setRestoreSessionId,
  setRestoreMode,
  setRestoreSessionNonce,
  setNewSessionNonce,
}: CreateDaemonSessionActionsArgs): DaemonSessionActions {
  function startSessionSwitch(
    sessionId: string,
    mode: 'load' | 'resume',
  ): Promise<void> {
    const loadId = pendingSessionLoadIdRef.current + 1;
    pendingSessionLoadIdRef.current = loadId;
    if (pendingSessionLoadRef.current) {
      clearTimeout(pendingSessionLoadRef.current.timeout);
      pendingSessionLoadRef.current.reject(
        new Error(`Session ${mode} superseded by a newer request`),
      );
    }
    const loadPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (pendingSessionLoadRef.current?.id === loadId) {
          pendingSessionLoadRef.current = undefined;
          reject(new Error(`Session ${mode} timed out`));
        }
      }, 30_000);
      pendingSessionLoadRef.current = {
        id: loadId,
        sessionId,
        mode,
        timeout,
        resolve,
        reject,
      };
    });
    setPromptStatus('idle');
    clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
    store.reset();
    setRestoreMode(mode);
    setRestoreSessionId(sessionId);
    setRestoreSessionNonce((nonce) => nonce + 1);
    return loadPromise;
  }

  return {
    async sendPrompt(text, options) {
      const session = requireSessionForAction(
        store,
        sessionRef.current,
        'Prompt failed',
      );
      const sessionId = session.sessionId;
      if (activePromptsRef.current.has(sessionId)) {
        throw dispatchActionError(
          store,
          'Prompt failed',
          'A prompt is already in progress',
        );
      }
      clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
      setPromptStatus('waiting');
      const ctrl = new AbortController();
      activePromptsRef.current.set(sessionId, { controller: ctrl });
      try {
        if (options?.optimisticUserMessage !== false) {
          store.appendLocalUserMessage(text);
        }
        const result = await session.prompt(
          {
            prompt: toDaemonPromptContent(text, options?.images),
          },
          ctrl.signal,
        );
        if (isNonBlockingAccepted(result)) {
          return await waitForAcceptedPromptCompletion(
            activePromptsRef.current,
            sessionId,
            ctrl,
            result.promptId,
          );
        }
        if (sessionRef.current?.sessionId === sessionId) {
          store.dispatch({
            type: 'assistant.done',
            reason: result.stopReason,
          });
        }
        return result;
      } catch (error) {
        if (isAbortError(error)) {
          if (sessionRef.current?.sessionId === sessionId) {
            store.dispatch({ type: 'assistant.done', reason: 'cancelled' });
          }
          return { stopReason: 'cancelled' };
        }
        if (sessionRef.current?.sessionId === sessionId) {
          store.dispatch({ type: 'assistant.done', reason: 'error' });
        }
        throw dispatchActionError(store, 'Prompt failed', error);
      } finally {
        const active = activePromptsRef.current.get(sessionId);
        if (active?.controller === ctrl) {
          activePromptsRef.current.delete(sessionId);
        }
        if (sessionRef.current?.sessionId === sessionId) {
          setPromptStatus('idle');
        }
      }
    },

    async cancel() {
      const session = requireSessionForAction(
        store,
        sessionRef.current,
        'Cancel failed',
      );
      const active = activePromptsRef.current.get(session.sessionId);
      active?.controller.abort();
      clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
      const cancelGuard = active ? new AbortController() : undefined;
      if (cancelGuard) {
        activePromptsRef.current.set(session.sessionId, {
          controller: cancelGuard,
        });
      }
      try {
        await withActionTimeout(session.cancel(), 'Cancel timed out');
      } catch (error) {
        throw dispatchActionError(store, 'Cancel failed', error);
      } finally {
        if (
          cancelGuard &&
          activePromptsRef.current.get(session.sessionId)?.controller ===
            cancelGuard
        ) {
          activePromptsRef.current.delete(session.sessionId);
        }
        if (sessionRef.current?.sessionId === session.sessionId) {
          setPromptStatus('idle');
        }
      }
    },

    async setModel(modelId) {
      const session = requireSessionForAction(
        store,
        sessionRef.current,
        'Set model failed',
      );
      try {
        const result = await withActionTimeout(
          session.setModel(modelId),
          'Set model timed out',
        );
        setConnection((current) => ({ ...current, currentModel: modelId }));
        return result;
      } catch (error) {
        throw dispatchActionError(store, 'Set model failed', error);
      }
    },

    async setApprovalMode(mode, opts) {
      const session = requireSessionForAction(
        store,
        sessionRef.current,
        'Set approval mode failed',
      );
      try {
        const result = await withActionTimeout(
          session.client.setSessionApprovalMode(session.sessionId, mode, {
            persist: opts?.persist,
            clientId: session.clientId,
          }),
          'Set approval mode timed out',
        );
        setConnection((current) => ({
          ...current,
          currentMode: result.mode || mode,
        }));
        return result;
      } catch (error) {
        throw dispatchActionError(store, 'Set approval mode failed', error);
      }
    },

    async respondToPermission(requestId, response) {
      const session = requireSessionForAction(
        store,
        sessionRef.current,
        'Permission response failed',
      );
      try {
        return await withActionTimeout(
          session.respondToSessionPermission(requestId, response),
          'Permission response timed out',
        );
      } catch (error) {
        throw dispatchActionError(store, 'Permission response failed', error);
      }
    },

    async submitPermission(requestId, optionId, answers) {
      const session = requireSessionForAction(
        store,
        sessionRef.current,
        'Permission response failed',
      );
      const response =
        optionId !== undefined && optionId.length > 0
          ? {
              outcome: { outcome: 'selected' as const, optionId },
              ...(answers ? { answers } : {}),
            }
          : {
              outcome: { outcome: 'cancelled' as const },
              ...(answers ? { answers } : {}),
            };
      try {
        return await withActionTimeout(
          session.respondToSessionPermission(requestId, response),
          'Permission response timed out',
        );
      } catch (error) {
        throw dispatchActionError(store, 'Permission response failed', error);
      }
    },

    async heartbeat() {
      const session = sessionRef.current;
      if (!session || !heartbeatSupportedRef.current) return undefined;
      return withActionTimeout(session.heartbeat(), 'Heartbeat timed out');
    },

    async listSessions() {
      const session = sessionRef.current;
      if (!session) return [];
      return session.client.listWorkspaceSessions(session.workspaceCwd);
    },

    async loadSession(sessionId) {
      return startSessionSwitch(sessionId, 'load');
    },

    async resumeSession(sessionId) {
      return startSessionSwitch(sessionId, 'resume');
    },

    async newSession() {
      for (const [, active] of activePromptsRef.current) {
        active.controller.abort();
      }
      activePromptsRef.current.clear();
      setPromptStatus('idle');
      clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
      if (pendingSessionLoadRef.current) {
        clearTimeout(pendingSessionLoadRef.current.timeout);
        pendingSessionLoadRef.current.reject(
          new Error('New session requested'),
        );
        pendingSessionLoadRef.current = undefined;
      }
      store.reset();
      setRestoreSessionId(undefined);
      setNewSessionNonce((nonce) => nonce + 1);
    },

    async releaseSession(sessionId) {
      try {
        const session = requireSessionForAction(
          store,
          sessionRef.current,
          'Release session failed',
        );
        await withActionTimeout(
          session.client.closeSession(sessionId),
          'Release session timed out',
        );
      } catch (error) {
        throw dispatchActionError(store, 'Release session failed', error);
      }
    },

    async closeSession() {
      const session = requireSessionForAction(
        store,
        sessionRef.current,
        'Close session failed',
      );
      await withActionTimeout(session.close(), 'Close session timed out');
    },

    async refreshCommands() {
      const session = requireSessionForAction(
        store,
        sessionRef.current,
        'Refresh commands failed',
      );
      const status = await withActionTimeout(
        session.supportedCommands(),
        'Refresh commands timed out',
      );
      const { commands, skills } = mapSupportedCommands(status);
      setConnection((current) => ({
        ...current,
        commands,
        skills,
        supportedCommands: status,
      }));
    },

    async getContext() {
      const session = requireSessionForAction(
        store,
        sessionRef.current,
        'Load context failed',
      );
      const context = await withActionTimeout(
        session.context(),
        'Load context timed out',
      );
      setConnection((current) => ({
        ...current,
        context,
        currentMode: getModeFromSessionContext(context) ?? current.currentMode,
      }));
      return context;
    },

    async getContextUsage(opts) {
      const session = requireSessionForAction(
        store,
        sessionRef.current,
        'Load context usage failed',
      );
      return await withActionTimeout(
        session.contextUsage(opts),
        'Load context usage timed out',
      );
    },

    async renameSession(displayName) {
      const session = requireSessionForAction(
        store,
        sessionRef.current,
        'Rename session failed',
      );
      return withActionTimeout(
        session.updateMetadata({ displayName }),
        'Rename session timed out',
      );
    },

    async recapSession(): Promise<DaemonSessionRecapResult> {
      const session = requireSessionForAction(
        store,
        sessionRef.current,
        'Recap session failed',
      );
      try {
        return await withActionTimeout(
          session.recap(),
          'Recap session timed out',
        );
      } catch (error) {
        throw dispatchActionError(store, 'Recap session failed', error);
      }
    },

    async btwSession(
      question: string,
      opts?: { signal?: AbortSignal },
    ): Promise<DaemonSessionBtwResult> {
      const session = requireSessionForAction(
        store,
        sessionRef.current,
        'Side question failed',
      );
      try {
        return await withActionTimeout(
          session.btw(question, opts),
          'Side question timed out',
        );
      } catch (error) {
        if (opts?.signal?.aborted || isAbortError(error)) {
          throw error;
        }
        throw dispatchActionError(store, 'Side question failed', error);
      }
    },

    async sendShellCommand(command: string) {
      const session = requireSessionForAction(
        store,
        sessionRef.current,
        'Shell command failed',
      );
      const shellKey = `${session.sessionId}:shell`;
      setPromptStatus('waiting');
      const ctrl = new AbortController();
      activePromptsRef.current.set(shellKey, { controller: ctrl });
      try {
        return await session.shellCommand(command, ctrl.signal);
      } catch (error) {
        throw dispatchActionError(store, 'Shell command failed', error);
      } finally {
        if (activePromptsRef.current.get(shellKey)?.controller === ctrl) {
          activePromptsRef.current.delete(shellKey);
        }
        if (sessionRef.current?.sessionId === session.sessionId) {
          setPromptStatus('idle');
        }
      }
    },

    async getTasks() {
      const session = requireSessionForAction(
        store,
        sessionRef.current,
        'Get tasks failed',
      );
      try {
        return await withActionTimeout(session.tasks(), 'Get tasks timed out');
      } catch (error) {
        throw dispatchActionError(store, 'Get tasks failed', error);
      }
    },

    async getStats() {
      const session = requireSessionForAction(
        store,
        sessionRef.current,
        'Load stats failed',
      );
      return await withActionTimeout(session.stats(), 'Load stats timed out');
    },

    async respondToGlobalPermission(
      requestId: string,
      response: PermissionResponse,
    ): Promise<boolean> {
      const session = requireSessionForAction(
        store,
        sessionRef.current,
        'Global permission response failed',
      );
      try {
        return await withActionTimeout(
          session.client.respondToPermission(requestId, response),
          'Global permission response timed out',
        );
      } catch (error) {
        throw dispatchActionError(
          store,
          'Global permission response failed',
          error,
        );
      }
    },
  };
}

function waitForAcceptedPromptCompletion(
  activePrompts: Map<string, ActivePrompt>,
  sessionId: string,
  controller: AbortController,
  promptId: string,
): Promise<PromptResult> {
  return new Promise<PromptResult>((resolve, reject) => {
    const active = activePrompts.get(sessionId);
    if (active?.controller !== controller) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    if (active.promptId !== undefined && active.promptId !== promptId) {
      reject(new Error(`Prompt accepted with unexpected id ${promptId}`));
      return;
    }
    if (active.pendingResult !== undefined) {
      activePrompts.delete(sessionId);
      resolve(active.pendingResult);
      return;
    }
    if (active.pendingError !== undefined) {
      activePrompts.delete(sessionId);
      reject(active.pendingError);
      return;
    }
    if (controller.signal.aborted) {
      activePrompts.delete(sessionId);
      reject(
        controller.signal.reason ?? new DOMException('Aborted', 'AbortError'),
      );
      return;
    }
    const cleanup = () => {
      controller.signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      const current = activePrompts.get(sessionId);
      if (current?.controller === controller) {
        activePrompts.delete(sessionId);
      }
      cleanup();
      reject(
        controller.signal.reason ?? new DOMException('Aborted', 'AbortError'),
      );
    };
    activePrompts.set(sessionId, {
      ...active,
      promptId,
      resolve: (result) => {
        cleanup();
        resolve(result);
      },
      reject: (error) => {
        cleanup();
        reject(error);
      },
    });
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
}

function getModeFromSessionContext(
  context: DaemonSessionContextStatus,
): string | undefined {
  const modes =
    typeof context.state.modes === 'object' && context.state.modes !== null
      ? (context.state.modes as Record<string, unknown>)
      : undefined;
  const mode = modes?.['currentModeId'] ?? modes?.['currentMode'];
  return typeof mode === 'string' ? mode : undefined;
}

function requireSessionForAction(
  store: DaemonTranscriptStore,
  session: DaemonSessionClient | undefined,
  action: string,
): DaemonSessionClient {
  if (!session) {
    throw dispatchActionError(store, action, 'Daemon session is not connected');
  }
  return session;
}

function dispatchActionError(
  store: DaemonTranscriptStore,
  action: string,
  error: unknown,
): Error {
  const message = error instanceof Error ? error.message : String(error);
  store.dispatch({
    type: 'error',
    text: `${action}: ${message}`,
    recoverable: true,
  });
  return error instanceof Error ? error : new Error(message);
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}
