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
  DaemonForkSessionResult,
  DaemonMidTurnMessageResult,
  DaemonSessionRecapResult,
  DaemonSessionTaskStatus,
  DaemonTranscriptStore,
  PermissionResponse,
} from '@qwen-code/sdk/daemon';
import {
  isDaemonTurnError,
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
import { persistStableClientId } from './clientLifecycle.js';
import type {
  ActivePrompt,
  AddDaemonSessionNotice,
  DaemonConnectionState,
  DaemonNoticeOperation,
  DaemonPromptStatus,
  DaemonSessionActions,
  SettledPrompt,
  PendingSessionLoad,
} from './types.js';

interface RefBox<T> {
  current: T;
}

export interface CreateDaemonSessionActionsArgs {
  store: DaemonTranscriptStore;
  sessionRef: RefBox<DaemonSessionClient | undefined>;
  activePromptsRef: RefBox<Map<string, ActivePrompt>>;
  settledPromptsRef: RefBox<Map<string, SettledPrompt>>;
  pendingSessionLoadRef: RefBox<PendingSessionLoad | undefined>;
  pendingSessionLoadIdRef: RefBox<number>;
  heartbeatSupportedRef: RefBox<boolean>;
  passiveAssistantDoneTimerRef: TimerRef;
  addNotice: AddDaemonSessionNotice;
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
  settledPromptsRef,
  pendingSessionLoadRef,
  pendingSessionLoadIdRef,
  heartbeatSupportedRef,
  passiveAssistantDoneTimerRef,
  addNotice,
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
        new DOMException(
          `Session ${mode} superseded by a newer request`,
          'AbortError',
        ),
      );
    }
    const loadPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (pendingSessionLoadRef.current?.id === loadId) {
          pendingSessionLoadRef.current = undefined;
          reject(
            dispatchActionError(
              addNotice,
              `${capitalize(mode)} session failed`,
              new Error(`Session ${mode} timed out`),
              mode === 'load' ? 'load_session' : 'resume_session',
            ),
          );
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
    settledPromptsRef.current.clear();
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
        addNotice,
        sessionRef.current,
        'Prompt failed',
        'send_prompt',
      );
      const sessionId = session.sessionId;
      if (activePromptsRef.current.has(sessionId)) {
        throw dispatchActionError(
          addNotice,
          'Prompt failed',
          'A prompt is already in progress',
          'send_prompt',
        );
      }
      clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
      setPromptStatus('waiting');
      const ctrl = new AbortController();
      activePromptsRef.current.set(sessionId, { controller: ctrl });
      try {
        // Normalize images once and pass the same array to both calls
        const normalizedImages: Array<{ data: string; mimeType: string }> = (
          options?.images ?? []
        ).map((img) => ({
          data: img.data,
          mimeType:
            img.mimeType || img.mediaType || img.media_type || 'image/*',
        }));
        if (options?.optimisticUserMessage !== false) {
          store.appendLocalUserMessage(text, normalizedImages);
        }
        const promptRequest: Record<string, unknown> = {
          prompt: toDaemonPromptContent(text, normalizedImages),
        };
        if (options?.retry) {
          promptRequest['retry'] = true;
        }
        const result = await session.prompt(
          promptRequest as Parameters<typeof session.prompt>[0],
          ctrl.signal,
        );
        if (isNonBlockingAccepted(result)) {
          return await waitForAcceptedPromptCompletion(
            activePromptsRef.current,
            settledPromptsRef.current,
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
        if (isDaemonTurnError(error)) {
          throw error;
        }
        throw dispatchActionError(
          addNotice,
          'Prompt failed',
          error,
          'send_prompt',
        );
      } finally {
        const active = activePromptsRef.current.get(sessionId);
        if (active?.controller === ctrl) {
          activePromptsRef.current.delete(sessionId);
        }
        if (
          sessionRef.current?.sessionId === sessionId &&
          !activePromptsRef.current.has(sessionId)
        ) {
          setPromptStatus('idle');
        }
      }
    },

    async cancel() {
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Cancel failed',
        'cancel_prompt',
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
        throw dispatchActionError(
          addNotice,
          'Cancel failed',
          error,
          'cancel_prompt',
        );
      } finally {
        if (
          cancelGuard &&
          activePromptsRef.current.get(session.sessionId)?.controller ===
            cancelGuard
        ) {
          activePromptsRef.current.delete(session.sessionId);
        }
        if (
          sessionRef.current?.sessionId === session.sessionId &&
          !activePromptsRef.current.has(session.sessionId)
        ) {
          setPromptStatus('idle');
        }
      }
    },

    async setModel(modelId) {
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Set model failed',
        'switch_model',
      );
      try {
        const result = await withActionTimeout(
          session.setModel(modelId),
          'Set model timed out',
        );
        setConnection((current) => ({ ...current, currentModel: modelId }));
        return result;
      } catch (error) {
        throw dispatchActionError(
          addNotice,
          'Set model failed',
          error,
          'switch_model',
        );
      }
    },

    async setApprovalMode(mode, opts) {
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Set approval mode failed',
        'set_approval_mode',
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
        throw dispatchActionError(
          addNotice,
          'Set approval mode failed',
          error,
          'set_approval_mode',
        );
      }
    },

    async respondToPermission(requestId, response) {
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Permission response failed',
        'submit_permission',
      );
      try {
        return await withActionTimeout(
          session.respondToSessionPermission(requestId, response),
          'Permission response timed out',
        );
      } catch (error) {
        throw dispatchActionError(
          addNotice,
          'Permission response failed',
          error,
          'submit_permission',
        );
      }
    },

    async submitPermission(requestId, optionId, answers) {
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Permission response failed',
        'submit_permission',
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
        throw dispatchActionError(
          addNotice,
          'Permission response failed',
          error,
          'submit_permission',
        );
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
      try {
        return await withActionTimeout(
          session.client.listWorkspaceSessions(session.workspaceCwd),
          'List sessions timed out',
        );
      } catch (error) {
        throw dispatchActionError(
          addNotice,
          'List sessions failed',
          error,
          'list_sessions',
        );
      }
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
      settledPromptsRef.current.clear();
      setPromptStatus('idle');
      clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
      if (pendingSessionLoadRef.current) {
        clearTimeout(pendingSessionLoadRef.current.timeout);
        pendingSessionLoadRef.current.reject(
          new DOMException('New session requested', 'AbortError'),
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
          addNotice,
          sessionRef.current,
          'Release session failed',
          'release_session',
        );
        await withActionTimeout(
          session.client.closeSession(sessionId),
          'Release session timed out',
        );
      } catch (error) {
        throw dispatchActionError(
          addNotice,
          'Release session failed',
          error,
          'release_session',
        );
      }
    },

    async closeSession() {
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Close session failed',
        'close_session',
      );
      try {
        await withActionTimeout(session.close(), 'Close session timed out');
      } catch (error) {
        throw dispatchActionError(
          addNotice,
          'Close session failed',
          error,
          'close_session',
        );
      }
    },

    async refreshCommands() {
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Refresh commands failed',
        'refresh_commands',
      );
      try {
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
      } catch (error) {
        throw dispatchActionError(
          addNotice,
          'Refresh commands failed',
          error,
          'refresh_commands',
        );
      }
    },

    async getContext() {
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Load context failed',
        'load_context',
      );
      try {
        const context = await withActionTimeout(
          session.context(),
          'Load context timed out',
        );
        setConnection((current) => ({
          ...current,
          context,
          currentMode:
            getModeFromSessionContext(context) ?? current.currentMode,
        }));
        return context;
      } catch (error) {
        throw dispatchActionError(
          addNotice,
          'Load context failed',
          error,
          'load_context',
        );
      }
    },

    async getContextUsage(opts) {
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Load context usage failed',
        'load_context_usage',
      );
      try {
        return await withActionTimeout(
          session.contextUsage(opts),
          'Load context usage timed out',
        );
      } catch (error) {
        throw dispatchActionError(
          addNotice,
          'Load context usage failed',
          error,
          'load_context_usage',
        );
      }
    },

    async renameSession(displayName) {
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Rename session failed',
        'rename_session',
      );
      try {
        return await withActionTimeout(
          session.updateMetadata({ displayName }),
          'Rename session timed out',
        );
      } catch (error) {
        throw dispatchActionError(
          addNotice,
          'Rename session failed',
          error,
          'rename_session',
        );
      }
    },

    async recapSession(): Promise<DaemonSessionRecapResult> {
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Recap session failed',
        'recap_session',
      );
      try {
        return await withActionTimeout(
          session.recap(),
          'Recap session timed out',
        );
      } catch (error) {
        throw dispatchActionError(
          addNotice,
          'Recap session failed',
          error,
          'recap_session',
        );
      }
    },

    async btwSession(
      question: string,
      opts?: { signal?: AbortSignal },
    ): Promise<DaemonSessionBtwResult> {
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Side question failed',
        'btw_session',
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
        throw dispatchActionError(
          addNotice,
          'Side question failed',
          error,
          'btw_session',
        );
      }
    },

    async enqueueMidTurnMessage(
      message: string,
      opts?: { signal?: AbortSignal },
    ): Promise<DaemonMidTurnMessageResult> {
      // Best-effort and silent: no session / idle session / transport failure /
      // abort all resolve `{ accepted: false }` so the caller falls back to its
      // own next-turn queue. Never raises a user-facing notice — a queued
      // message typed mid-turn is an optimization, not a user-initiated action.
      // `opts.signal` lets the caller abort a still-in-flight push when the turn
      // it was meant for settles, so a late arrival can't land in the next turn.
      const session = sessionRef.current;
      if (!session) return { accepted: false };
      try {
        return await session.enqueueMidTurnMessage(message, opts);
      } catch (err) {
        // An abort is the designed settle-time cancel (the message stays in the
        // browser queue for the next turn), not a failure — stay silent. Any
        // OTHER error (daemon down, 4xx/5xx, network, timeout) silently disables
        // mid-turn drain for every client, so surface it at debug for DevTools
        // without raising a user-facing notice.
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          console.debug(
            '[enqueueMidTurnMessage] push failed; kept for next turn',
            err,
          );
        }
        return { accepted: false };
      }
    },

    async sendShellCommand(command: string) {
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Shell command failed',
        'send_shell_command',
      );
      const shellKey = `${session.sessionId}:shell`;
      setPromptStatus('waiting');
      const ctrl = new AbortController();
      activePromptsRef.current.set(shellKey, { controller: ctrl });
      try {
        return await session.shellCommand(command, ctrl.signal);
      } catch (error) {
        throw dispatchActionError(
          addNotice,
          'Shell command failed',
          error,
          'send_shell_command',
        );
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
        addNotice,
        sessionRef.current,
        'Get tasks failed',
        'load_tasks',
      );
      try {
        return await withActionTimeout(session.tasks(), 'Get tasks timed out');
      } catch (error) {
        throw dispatchActionError(
          addNotice,
          'Get tasks failed',
          error,
          'load_tasks',
        );
      }
    },

    async cancelTask(taskId: string, kind: DaemonSessionTaskStatus['kind']) {
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Cancel task failed',
        'cancel_task',
      );
      try {
        return await withActionTimeout(
          session.cancelTask(taskId, kind),
          'Cancel task timed out',
        );
      } catch (error) {
        throw dispatchActionError(
          addNotice,
          'Cancel task failed',
          error,
          'cancel_task',
        );
      }
    },

    async clearGoal() {
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Clear goal failed',
        'clear_goal',
      );
      try {
        return await withActionTimeout(
          session.clearGoal(),
          'Clear goal timed out',
        );
      } catch (error) {
        throw dispatchActionError(
          addNotice,
          'Clear goal failed',
          error,
          'clear_goal',
        );
      }
    },

    async getStats() {
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Load stats failed',
        'load_stats',
      );
      try {
        return await withActionTimeout(session.stats(), 'Load stats timed out');
      } catch (error) {
        throw dispatchActionError(
          addNotice,
          'Load stats failed',
          error,
          'load_stats',
        );
      }
    },

    async respondToGlobalPermission(
      requestId: string,
      response: PermissionResponse,
    ): Promise<boolean> {
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Global permission response failed',
        'submit_permission',
      );
      try {
        return await withActionTimeout(
          session.client.respondToPermission(requestId, response),
          'Global permission response timed out',
        );
      } catch (error) {
        throw dispatchActionError(
          addNotice,
          'Global permission response failed',
          error,
          'submit_permission',
        );
      }
    },

    async branchSession(name?: string) {
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Branch session failed',
        'branch_session',
      );
      try {
        const result = await withActionTimeout(
          session.client.branchSession(
            session.sessionId,
            { name },
            session.clientId,
          ),
          'Branch session timed out',
        );
        persistStableClientId(result.clientId, result.sessionId);
        void startSessionSwitch(result.sessionId, 'load').catch(
          (switchError: unknown) => {
            if (isAbortError(switchError)) return;
            dispatchActionError(
              addNotice,
              'Branch session failed',
              switchError,
              'branch_session',
            );
          },
        );
        return {
          sessionId: result.sessionId,
          displayName: result.displayName,
        };
      } catch (error) {
        throw dispatchActionError(
          addNotice,
          'Branch session failed',
          error,
          'branch_session',
        );
      }
    },

    async forkSession(directive: string): Promise<DaemonForkSessionResult> {
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Fork session failed',
        'fork_session',
      );
      try {
        return await withActionTimeout(
          session.fork(directive),
          'Fork session timed out',
        );
      } catch (error) {
        throw dispatchActionError(
          addNotice,
          'Fork session failed',
          error,
          'fork_session',
        );
      }
    },
  };
}

function waitForAcceptedPromptCompletion(
  activePrompts: Map<string, ActivePrompt>,
  settledPrompts: Map<string, SettledPrompt>,
  sessionId: string,
  controller: AbortController,
  promptId: string,
): Promise<PromptResult> {
  return new Promise<PromptResult>((resolve, reject) => {
    // IMPORTANT: Check settledPrompts BEFORE activePrompts. The turn event
    // may have already freed the active slot (allowing a new prompt to start).
    // If we checked activePrompts first, we'd find the NEXT prompt's controller
    // and incorrectly reject this one as aborted.
    const settledKey = getPromptSettledKey(sessionId, promptId);
    const settled = settledPrompts.get(settledKey);
    if (settled) {
      settledPrompts.delete(settledKey);
      if (settled.status === 'resolved') {
        resolve(settled.result);
      } else {
        reject(settled.error);
      }
      return;
    }
    const active = activePrompts.get(sessionId);
    if (active?.controller !== controller) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    if (active.promptId !== undefined && active.promptId !== promptId) {
      reject(new Error(`Prompt accepted with unexpected id ${promptId}`));
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

export function getPromptSettledKey(
  sessionId: string,
  promptId: string,
): string {
  return JSON.stringify([sessionId, promptId]);
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
  addNotice: AddDaemonSessionNotice,
  session: DaemonSessionClient | undefined,
  action: string,
  operation: DaemonNoticeOperation,
): DaemonSessionClient {
  if (!session) {
    throw dispatchActionError(
      addNotice,
      action,
      'Daemon session is not connected',
      operation,
    );
  }
  return session;
}

function dispatchActionError(
  addNotice: AddDaemonSessionNotice,
  action: string,
  error: unknown,
  operation: DaemonNoticeOperation,
): Error {
  if (isAbortError(error)) {
    if (error instanceof Error) return error;
    const message = error instanceof DOMException ? error.message : 'Aborted';
    const abortError = new Error(message);
    abortError.name = 'AbortError';
    return abortError;
  }
  const message = error instanceof Error ? error.message : String(error);
  addNotice({
    severity: 'error',
    category: 'user_action',
    operation,
    code: `daemon.${operation}.failed`,
    message: `${action}: ${message}`,
    debugMessage: message,
    recoverable: true,
  });
  return markNoticeDispatched(
    error instanceof Error ? error : new Error(message),
  );
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function markNoticeDispatched(error: Error): Error {
  return Object.assign(error, {
    _alreadyDispatched: true as const,
  });
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
