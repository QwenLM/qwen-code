/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  consumePendingPromptEvents,
  getPendingPromptEvents,
  getPendingPromptVersion,
  subscribePendingPromptEvents,
  subscribePendingPromptVersion,
  useDaemonMidTurnInjected,
  type DaemonSessionActions,
  type DaemonStreamingState,
} from '@qwen-code/webui/daemon-react-sdk';
import type {
  DaemonPendingPromptSummary,
  DaemonTranscriptStore,
} from '@qwen-code/sdk/daemon';
import type { PromptImage } from '../adapters/promptTypes';
import type { EditorHandle } from './useComposerCore';
import { removeInjectedFromQueue } from '../midTurnDedup';
import { isCommandPrompt } from '../utils/localCommandQueue';
import type { getTranslator } from '../i18n';
import type { QueuedPrompt } from '../components/QueuedPromptDisplay';

interface RefBox<T> {
  current: T;
}

interface UseQueuedPromptsArgs {
  connected: boolean;
  sessionId?: string;
  clientId?: string;
  streamingState: DaemonStreamingState;
  sessionActions: DaemonSessionActions;
  store: DaemonTranscriptStore;
  editorRef: RefBox<EditorHandle | null>;
  reportError: (error: unknown, fallback: string) => void;
  notifySuccess: (message: string) => void;
  t: ReturnType<typeof getTranslator>;
}

const MAX_COMPLETED_PROMPT_IDS = 100;

function areQueuedPromptsEqual(
  left: readonly QueuedPrompt[],
  right: readonly QueuedPrompt[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((prompt, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      prompt.id === other.id &&
      prompt.sessionId === other.sessionId &&
      prompt.text === other.text &&
      prompt.serverPromptId === other.serverPromptId &&
      prompt.serverState === other.serverState &&
      prompt.isEditing === other.isEditing &&
      prompt.isRemoving === other.isRemoving &&
      (prompt.images?.length ?? 0) === (other.images?.length ?? 0)
    );
  });
}

function toStoreImages(
  images: readonly PromptImage[] | undefined,
): Array<{ data: string; mimeType: string }> | undefined {
  if (!images || images.length === 0) return undefined;
  return images.map((image) => ({
    data: image.data,
    mimeType: image.media_type || 'image/*',
  }));
}

export interface UseQueuedPromptsResult {
  queuedPrompts: QueuedPrompt[];
  queuedTexts: string[];
  enqueuePrompt: (
    text: string,
    images?: PromptImage[],
    onComplete?: () => void,
  ) => boolean;
  removeQueuedPrompt: (id: number) => void;
  insertQueuedPrompt: (id: number) => Promise<void>;
  editQueuedPrompt: (id: number) => Promise<void>;
  editLastQueuedPrompt: () => boolean;
  clearQueuedPrompts: () => boolean;
}

export function useQueuedPrompts({
  connected,
  sessionId,
  clientId,
  streamingState,
  sessionActions,
  store,
  editorRef,
  reportError,
  notifySuccess,
  t,
}: UseQueuedPromptsArgs): UseQueuedPromptsResult {
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const queuedPromptsRef = useRef<QueuedPrompt[]>([]);
  const nextQueuedPromptIdRef = useRef(1);
  const latestSessionIdRef = useRef(sessionId);
  const midTurnEnqueueAbortRef = useRef<AbortController | null>(null);
  const submitAbortControllersRef = useRef<Set<AbortController>>(new Set());
  const editingServerPromptIdsRef = useRef<Set<string>>(new Set());
  const removingServerPromptIdsRef = useRef<Set<string>>(new Set());
  const displayedServerPromptIdsRef = useRef<Set<string>>(new Set());
  const completionCallbacksRef = useRef<Map<string, () => void>>(new Map());
  const completedPromptIdsRef = useRef<Set<string>>(new Set());
  const completedPromptIdOrderRef = useRef<string[]>([]);
  const latestStreamingStateRef = useRef(streamingState);

  latestSessionIdRef.current = sessionId;
  latestStreamingStateRef.current = streamingState;

  const queuedTexts = useMemo(
    () => queuedPrompts.map((prompt) => prompt.text),
    [queuedPrompts],
  );

  useEffect(() => {
    queuedPromptsRef.current = queuedPrompts;
  }, [queuedPrompts]);

  useEffect(() => {
    queuedPromptsRef.current = [];
    setQueuedPrompts([]);
    completionCallbacksRef.current.clear();
    completedPromptIdsRef.current.clear();
    completedPromptIdOrderRef.current = [];
    for (const controller of submitAbortControllersRef.current) {
      controller.abort();
    }
    submitAbortControllersRef.current.clear();
    editingServerPromptIdsRef.current.clear();
    removingServerPromptIdsRef.current.clear();
    displayedServerPromptIdsRef.current.clear();
    initialRefreshSessionIdRef.current = undefined;
    midTurnEnqueueAbortRef.current?.abort();
    midTurnEnqueueAbortRef.current = null;
  }, [sessionId]);

  const syncServerQueuedPrompts = useCallback(
    (serverQueued: DaemonPendingPromptSummary[], targetSessionId: string) => {
      const next = queuedPromptsRef.current.filter((p) => {
        if (!p.serverPromptId) return true;
        return serverQueued.some(
          (server) => server.promptId === p.serverPromptId,
        );
      });
      for (const serverPrompt of serverQueued) {
        if (removingServerPromptIdsRef.current.has(serverPrompt.promptId)) {
          continue;
        }
        if (displayedServerPromptIdsRef.current.has(serverPrompt.promptId)) {
          continue;
        }
        const existingIndex = next.findIndex(
          (p) => p.serverPromptId === serverPrompt.promptId,
        );
        if (existingIndex !== -1) {
          next[existingIndex] = {
            ...next[existingIndex]!,
            text: serverPrompt.text,
            serverState: serverPrompt.state,
          };
          continue;
        }
        next.push({
          id: nextQueuedPromptIdRef.current++,
          sessionId: targetSessionId,
          text: serverPrompt.text,
          serverPromptId: serverPrompt.promptId,
          serverState: serverPrompt.state,
        });
      }
      if (areQueuedPromptsEqual(queuedPromptsRef.current, next)) return;
      queuedPromptsRef.current = next;
      setQueuedPrompts(next);
    },
    [],
  );

  const refreshPendingPrompts = useCallback(
    async (targetSessionId = sessionId): Promise<boolean> => {
      if (!connected || !targetSessionId) return false;
      if (latestSessionIdRef.current !== targetSessionId) return false;
      try {
        const result = await sessionActions.getPendingPrompts({
          sessionId: targetSessionId,
        });
        if (latestSessionIdRef.current !== targetSessionId) return false;
        syncServerQueuedPrompts(
          result.pendingPrompts.filter(
            (p) => p.state === 'queued' || p.state === 'running',
          ),
          targetSessionId,
        );
        return true;
      } catch (error) {
        console.warn('Failed to refresh pending prompts', error);
        return false;
      }
    },
    [connected, sessionActions, sessionId, syncServerQueuedPrompts],
  );

  const restoreQueuedPrompts = useCallback((prompts: QueuedPrompt[]) => {
    const currentSessionId = latestSessionIdRef.current;
    const sameSessionPrompts = prompts.filter(
      (prompt) =>
        prompt.sessionId === undefined || prompt.sessionId === currentSessionId,
    );
    if (sameSessionPrompts.length === 0) return;
    const existingIds = new Set(queuedPromptsRef.current.map((p) => p.id));
    const restored = sameSessionPrompts.filter(
      (prompt) => !existingIds.has(prompt.id),
    );
    if (restored.length === 0) return;
    const next = [...queuedPromptsRef.current, ...restored].sort(
      (a, b) => a.id - b.id,
    );
    queuedPromptsRef.current = next;
    setQueuedPrompts(next);
  }, []);

  const restoreTextToEditor = useCallback(
    (text: string, images?: PromptImage[], targetSessionId?: string) => {
      if (
        targetSessionId !== undefined &&
        latestSessionIdRef.current !== targetSessionId
      ) {
        return;
      }
      const current = editorRef.current?.getText() ?? '';
      const next = current.trim() ? `${text}\n${current}` : text;
      editorRef.current?.setText(next);
      if (images && images.length > 0) {
        editorRef.current?.restoreImages(images);
      }
      editorRef.current?.focus();
    },
    [editorRef],
  );

  const pendingPromptVersion = useSyncExternalStore(
    subscribePendingPromptVersion,
    getPendingPromptVersion,
  );
  const prevPendingVersionRef = useRef(pendingPromptVersion);
  const initialRefreshSessionIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!connected || !sessionId) return;

    const versionChanged =
      prevPendingVersionRef.current !== pendingPromptVersion;
    prevPendingVersionRef.current = pendingPromptVersion;
    if (!versionChanged) {
      if (queuedPromptsRef.current.length > 0) return;
      if (streamingState === 'idle') return;
      if (initialRefreshSessionIdRef.current === sessionId) return;
      initialRefreshSessionIdRef.current = sessionId;
    }

    void refreshPendingPrompts();
  }, [
    pendingPromptVersion,
    connected,
    sessionId,
    streamingState,
    refreshPendingPrompts,
  ]);

  const pendingPromptEvents = useSyncExternalStore(
    subscribePendingPromptEvents,
    getPendingPromptEvents,
    getPendingPromptEvents,
  );
  useEffect(() => {
    if (!sessionId || pendingPromptEvents.length === 0) return;
    const handled: Array<(typeof pendingPromptEvents)[number]> = [];
    for (const event of pendingPromptEvents) {
      if (event.data.sessionId !== sessionId) continue;
      handled.push(event);
      const promptId = event.data.promptId;
      if (!promptId) continue;
      if (event.type === 'pending_prompt_started') {
        if (removingServerPromptIdsRef.current.has(promptId)) {
          continue;
        }
        const shouldAppendLocalUserMessage =
          event.originatorClientId === undefined ||
          event.originatorClientId === clientId;
        if (
          shouldAppendLocalUserMessage &&
          !displayedServerPromptIdsRef.current.has(promptId)
        ) {
          const eventText =
            typeof event.data.text === 'string' ? event.data.text : '';
          const prompt =
            queuedPromptsRef.current.find(
              (item) => item.serverPromptId === promptId,
            ) ??
            queuedPromptsRef.current.find(
              (item) =>
                !item.serverPromptId &&
                item.serverState === 'submitting' &&
                item.text === eventText,
            );
          const text = prompt?.text ?? '';
          if (text) {
            displayedServerPromptIdsRef.current.add(promptId);
            store.appendLocalUserMessage(text, toStoreImages(prompt?.images));
          }
        }
        const next = queuedPromptsRef.current.filter(
          (item) => item.serverPromptId !== promptId,
        );
        if (next.length !== queuedPromptsRef.current.length) {
          queuedPromptsRef.current = next;
          setQueuedPrompts(next);
        }
      } else if (event.type === 'turn_complete') {
        displayedServerPromptIdsRef.current.delete(promptId);
        const callback = completionCallbacksRef.current.get(promptId);
        completionCallbacksRef.current.delete(promptId);
        if (callback) {
          callback();
        } else {
          if (!completedPromptIdsRef.current.has(promptId)) {
            completedPromptIdsRef.current.add(promptId);
            completedPromptIdOrderRef.current.push(promptId);
            while (
              completedPromptIdOrderRef.current.length >
              MAX_COMPLETED_PROMPT_IDS
            ) {
              const expiredPromptId = completedPromptIdOrderRef.current.shift();
              if (expiredPromptId) {
                completedPromptIdsRef.current.delete(expiredPromptId);
              }
            }
          }
        }
      } else if (
        event.type === 'turn_error' ||
        (event.type === 'pending_prompt_completed' &&
          event.data.state === 'removed')
      ) {
        displayedServerPromptIdsRef.current.delete(promptId);
        const callback = completionCallbacksRef.current.get(promptId);
        completionCallbacksRef.current.delete(promptId);
        if (event.type === 'turn_error') {
          callback?.();
        }
        completedPromptIdsRef.current.delete(promptId);
        completedPromptIdOrderRef.current =
          completedPromptIdOrderRef.current.filter((id) => id !== promptId);
      }
    }
    consumePendingPromptEvents(handled);
  }, [pendingPromptEvents, sessionId, clientId, store]);

  const enqueuePrompt = useCallback(
    (text: string, images?: PromptImage[], onComplete?: () => void) => {
      const trimmed = text.trim();
      if (!trimmed) return true;
      const localId = nextQueuedPromptIdRef.current++;
      const targetSessionId = latestSessionIdRef.current;
      const submitAbort = new AbortController();
      submitAbortControllersRef.current.add(submitAbort);
      const queuedImages = images ? [...images] : undefined;
      const nextPrompt: QueuedPrompt = {
        id: localId,
        sessionId: targetSessionId,
        text: trimmed,
        images: queuedImages,
        onComplete,
        serverState: 'submitting',
      };
      queuedPromptsRef.current = [...queuedPromptsRef.current, nextPrompt];
      setQueuedPrompts(queuedPromptsRef.current);

      sessionActions
        .submitPrompt(trimmed, {
          images,
          optimisticUserMessage: false,
          sessionId: targetSessionId,
          signal: submitAbort.signal,
        })
        .then((result) => {
          submitAbortControllersRef.current.delete(submitAbort);
          if (latestSessionIdRef.current !== targetSessionId) {
            sessionActions
              .removePendingPrompt(result.promptId, {
                sessionId: targetSessionId,
              })
              .catch(() => {});
            return;
          }
          if (latestStreamingStateRef.current === 'idle') {
            if (!displayedServerPromptIdsRef.current.has(result.promptId)) {
              displayedServerPromptIdsRef.current.add(result.promptId);
              store.appendLocalUserMessage(
                trimmed,
                toStoreImages(queuedImages),
              );
            }
            const next = queuedPromptsRef.current.filter(
              (prompt) => prompt.id !== localId,
            );
            queuedPromptsRef.current = next;
            setQueuedPrompts(next);
            if (onComplete) {
              if (completedPromptIdsRef.current.delete(result.promptId)) {
                completedPromptIdOrderRef.current =
                  completedPromptIdOrderRef.current.filter(
                    (id) => id !== result.promptId,
                  );
                onComplete();
              } else {
                completionCallbacksRef.current.set(result.promptId, onComplete);
              }
            }
            return;
          }
          const current = queuedPromptsRef.current;
          const idx = current.findIndex((p) => p.id === localId);
          if (idx === -1) {
            sessionActions
              .removePendingPrompt(result.promptId, {
                sessionId: targetSessionId,
              })
              .then(
                (removeResult) => {
                  if (!removeResult.removed)
                    void refreshPendingPrompts(targetSessionId);
                },
                () => {
                  void refreshPendingPrompts(targetSessionId);
                },
              );
            return;
          }
          const updated = [...current];
          updated[idx] = {
            ...updated[idx]!,
            serverPromptId: result.promptId,
            serverState: 'queued',
          };
          queuedPromptsRef.current = updated;
          setQueuedPrompts(updated);
          if (onComplete) {
            if (completedPromptIdsRef.current.delete(result.promptId)) {
              completedPromptIdOrderRef.current =
                completedPromptIdOrderRef.current.filter(
                  (id) => id !== result.promptId,
                );
              onComplete();
            } else {
              completionCallbacksRef.current.set(result.promptId, onComplete);
            }
          }
        })
        .catch((error: unknown) => {
          submitAbortControllersRef.current.delete(submitAbort);
          if (latestSessionIdRef.current !== targetSessionId) return;
          if (!queuedPromptsRef.current.some((p) => p.id === localId)) return;
          const next = queuedPromptsRef.current.filter(
            (prompt) => prompt.id !== localId,
          );
          queuedPromptsRef.current = next;
          setQueuedPrompts(next);
          restoreTextToEditor(trimmed, queuedImages, targetSessionId);
          reportError(error, t('queue.queueFailed'));
        });
      return true;
    },
    [
      refreshPendingPrompts,
      reportError,
      restoreTextToEditor,
      sessionActions,
      store,
      t,
    ],
  );

  useEffect(() => {
    if (streamingState !== 'idle') return;
    const ctrl = midTurnEnqueueAbortRef.current;
    if (!ctrl) return;
    console.debug('[mid-turn] turn settled; cancelling any in-flight push');
    ctrl.abort();
    midTurnEnqueueAbortRef.current = null;
  }, [streamingState]);

  const popQueuedPromptForEdit = useCallback((id?: number): string | null => {
    const current = queuedPromptsRef.current;
    if (current.length === 0) return null;
    const index =
      id === undefined
        ? current.length - 1
        : current.findIndex((prompt) => prompt.id === id);
    if (index < 0) return null;
    const prompt = current[index];
    const next = current.filter((_, i) => i !== index);
    queuedPromptsRef.current = next;
    setQueuedPrompts(next);
    return prompt?.text ?? null;
  }, []);

  const setQueuedPromptFlags = useCallback(
    (
      id: number,
      flags: Partial<Pick<QueuedPrompt, 'isEditing' | 'isRemoving'>>,
    ) => {
      const next = queuedPromptsRef.current.map((prompt) =>
        prompt.id === id ? { ...prompt, ...flags } : prompt,
      );
      queuedPromptsRef.current = next;
      setQueuedPrompts(next);
    },
    [],
  );

  const removeServerPromptForAction = useCallback(
    async (
      target: QueuedPrompt,
      flags: Partial<Pick<QueuedPrompt, 'isEditing' | 'isRemoving'>>,
      fallback: string,
    ): Promise<boolean> => {
      if (!target.serverPromptId) return true;
      if (target.serverState !== 'queued') return false;
      if (removingServerPromptIdsRef.current.has(target.serverPromptId)) {
        return false;
      }
      const targetSessionId = target.sessionId;
      removingServerPromptIdsRef.current.add(target.serverPromptId);
      setQueuedPromptFlags(target.id, flags);
      try {
        const result = await sessionActions.removePendingPrompt(
          target.serverPromptId,
          {
            sessionId: targetSessionId,
          },
        );
        removingServerPromptIdsRef.current.delete(target.serverPromptId);
        if (!result.removed) {
          setQueuedPromptFlags(target.id, {
            isEditing: false,
            isRemoving: false,
          });
          void refreshPendingPrompts(targetSessionId);
          return false;
        }
        completionCallbacksRef.current.delete(target.serverPromptId);
        const next = queuedPromptsRef.current.filter(
          (prompt) => prompt.id !== target.id,
        );
        queuedPromptsRef.current = next;
        setQueuedPrompts(next);
        return true;
      } catch (error) {
        removingServerPromptIdsRef.current.delete(target.serverPromptId);
        setQueuedPromptFlags(target.id, {
          isEditing: false,
          isRemoving: false,
        });
        if (!(await refreshPendingPrompts(targetSessionId))) {
          restoreQueuedPrompts([target]);
        }
        reportError(error, fallback);
        return false;
      }
    },
    [
      refreshPendingPrompts,
      reportError,
      restoreQueuedPrompts,
      sessionActions,
      setQueuedPromptFlags,
    ],
  );

  const removeQueuedPrompt = useCallback(
    (id: number) => {
      const target = queuedPromptsRef.current.find((p) => p.id === id);
      if (target?.serverState === 'submitting') return;
      const next = queuedPromptsRef.current.filter(
        (prompt) => prompt.id !== id,
      );
      if (next.length === queuedPromptsRef.current.length) return;
      queuedPromptsRef.current = next;
      setQueuedPrompts(next);
      if (target?.serverPromptId) {
        const targetSessionId = target.sessionId;
        removingServerPromptIdsRef.current.add(target.serverPromptId);
        sessionActions
          .removePendingPrompt(target.serverPromptId, {
            sessionId: targetSessionId,
          })
          .then(
            async (result) => {
              if (result.removed) {
                removingServerPromptIdsRef.current.delete(
                  target.serverPromptId!,
                );
                completionCallbacksRef.current.delete(target.serverPromptId!);
                return;
              }
              removingServerPromptIdsRef.current.delete(target.serverPromptId!);
              if (!(await refreshPendingPrompts(targetSessionId))) {
                restoreQueuedPrompts([target]);
              }
              reportError(
                new Error('Prompt could not be removed from queue'),
                t('queue.deleteFailed'),
              );
            },
            async (error: unknown) => {
              removingServerPromptIdsRef.current.delete(target.serverPromptId!);
              if (!(await refreshPendingPrompts(targetSessionId))) {
                restoreQueuedPrompts([target]);
              }
              reportError(error, t('queue.deleteFailed'));
            },
          );
      }
    },
    [
      refreshPendingPrompts,
      reportError,
      restoreQueuedPrompts,
      sessionActions,
      t,
    ],
  );

  const insertQueuedPrompt = useCallback(
    async (id: number) => {
      const prompt = queuedPromptsRef.current.find((item) => item.id === id);
      if (!prompt || (prompt.images?.length ?? 0) > 0) return;
      if (
        prompt.serverState === 'submitting' ||
        prompt.isEditing ||
        prompt.isRemoving ||
        isCommandPrompt(prompt.text)
      ) {
        return;
      }
      const removedCompletionCallback = prompt.serverPromptId
        ? (prompt.onComplete ??
          completionCallbacksRef.current.get(prompt.serverPromptId))
        : undefined;
      const finishRemovedPrompt = () => {
        if (prompt.serverPromptId) {
          completionCallbacksRef.current.delete(prompt.serverPromptId);
        }
        removedCompletionCallback?.();
      };
      if (
        prompt.serverPromptId &&
        !(await removeServerPromptForAction(
          prompt,
          { isRemoving: true },
          t('queue.insertFailed'),
        ))
      ) {
        return;
      }
      let abort = midTurnEnqueueAbortRef.current;
      if (!abort) {
        abort = new AbortController();
        midTurnEnqueueAbortRef.current = abort;
      }
      let result: Awaited<
        ReturnType<typeof sessionActions.enqueueMidTurnMessage>
      >;
      try {
        result = await sessionActions.enqueueMidTurnMessage(prompt.text, {
          signal: abort.signal,
        });
      } catch (error) {
        if (prompt.serverPromptId) {
          restoreTextToEditor(prompt.text, prompt.images, prompt.sessionId);
          finishRemovedPrompt();
        }
        reportError(error, t('queue.insertFailed'));
        return;
      }
      if (!result.accepted) {
        if (prompt.serverPromptId) {
          restoreTextToEditor(prompt.text, prompt.images, prompt.sessionId);
          finishRemovedPrompt();
        }
        reportError(
          new Error('Queued message was not accepted for insertion'),
          t('queue.insertFailed'),
        );
        return;
      }
      finishRemovedPrompt();
      if (!prompt.serverPromptId) {
        const next = queuedPromptsRef.current.filter((item) => item.id !== id);
        queuedPromptsRef.current = next;
        setQueuedPrompts(next);
      }
      notifySuccess(t('queue.inserted'));
    },
    [
      removeServerPromptForAction,
      notifySuccess,
      reportError,
      restoreTextToEditor,
      sessionActions,
      t,
    ],
  );

  const editQueuedPrompt = useCallback(
    async (id: number) => {
      const target = queuedPromptsRef.current.find((p) => p.id === id);
      if (!target || target.serverState === 'submitting') return;
      if (target.isEditing || target.isRemoving) return;
      if (target.serverPromptId) {
        const removed = await removeServerPromptForAction(
          target,
          { isEditing: true },
          t('queue.editFailed'),
        );
        if (!removed) return;
        restoreTextToEditor(target.text, target.images, target.sessionId);
        return;
      }
      const queuedText = popQueuedPromptForEdit(id);
      if (!queuedText) return;
      restoreTextToEditor(queuedText, target.images, target.sessionId);
    },
    [
      popQueuedPromptForEdit,
      removeServerPromptForAction,
      restoreTextToEditor,
      t,
    ],
  );

  const editLastQueuedPrompt = useCallback((): boolean => {
    const current = queuedPromptsRef.current;
    if (current.length === 0) return false;
    const target = current[current.length - 1];
    if (!target) return false;
    if (
      target.serverState === 'submitting' ||
      target.isEditing ||
      target.isRemoving
    ) {
      return true;
    }
    if (!target.serverPromptId) {
      const queuedText = popQueuedPromptForEdit(target.id);
      if (!queuedText) return false;
      restoreTextToEditor(queuedText, target.images, target.sessionId);
      return true;
    }
    if (target.serverState !== 'queued') return true;
    if (editingServerPromptIdsRef.current.has(target.serverPromptId)) {
      return true;
    }
    editingServerPromptIdsRef.current.add(target.serverPromptId);
    removingServerPromptIdsRef.current.add(target.serverPromptId);
    setQueuedPromptFlags(target.id, { isEditing: true });
    sessionActions
      .removePendingPrompt(target.serverPromptId, {
        sessionId: target.sessionId,
      })
      .then(
        async (result) => {
          editingServerPromptIdsRef.current.delete(target.serverPromptId!);
          if (!result.removed) {
            setQueuedPromptFlags(target.id, { isEditing: false });
            removingServerPromptIdsRef.current.delete(target.serverPromptId!);
            void refreshPendingPrompts(target.sessionId);
            return;
          }
          removingServerPromptIdsRef.current.delete(target.serverPromptId!);
          completionCallbacksRef.current.delete(target.serverPromptId!);
          const next = queuedPromptsRef.current.filter(
            (prompt) => prompt.id !== target.id,
          );
          queuedPromptsRef.current = next;
          setQueuedPrompts(next);
          restoreTextToEditor(target.text, target.images, target.sessionId);
        },
        async (error: unknown) => {
          editingServerPromptIdsRef.current.delete(target.serverPromptId!);
          setQueuedPromptFlags(target.id, { isEditing: false });
          removingServerPromptIdsRef.current.delete(target.serverPromptId!);
          if (!(await refreshPendingPrompts(target.sessionId))) {
            restoreQueuedPrompts([target]);
          }
          reportError(error, t('queue.editFailed'));
        },
      );
    return true;
  }, [
    popQueuedPromptForEdit,
    refreshPendingPrompts,
    reportError,
    restoreQueuedPrompts,
    restoreTextToEditor,
    sessionActions,
    setQueuedPromptFlags,
    t,
  ]);

  const clearQueuedPrompts = useCallback((): boolean => {
    if (queuedPromptsRef.current.length === 0) return false;
    const clearablePrompts = queuedPromptsRef.current.filter(
      (prompt) => prompt.serverState !== 'submitting',
    );
    for (const controller of submitAbortControllersRef.current) {
      controller.abort();
    }
    for (const prompt of clearablePrompts) {
      if (prompt.serverPromptId) {
        const targetSessionId = prompt.sessionId;
        removingServerPromptIdsRef.current.add(prompt.serverPromptId);
        sessionActions
          .removePendingPrompt(prompt.serverPromptId, {
            sessionId: targetSessionId,
          })
          .then(
            async (result) => {
              if (result.removed) {
                removingServerPromptIdsRef.current.delete(
                  prompt.serverPromptId!,
                );
                completionCallbacksRef.current.delete(prompt.serverPromptId!);
                return;
              }
              removingServerPromptIdsRef.current.delete(prompt.serverPromptId!);
              if (!(await refreshPendingPrompts(targetSessionId))) {
                restoreQueuedPrompts([prompt]);
              }
              reportError(
                new Error('Prompt could not be removed from queue'),
                t('queue.deleteFailed'),
              );
            },
            async (error: unknown) => {
              removingServerPromptIdsRef.current.delete(prompt.serverPromptId!);
              if (!(await refreshPendingPrompts(targetSessionId))) {
                restoreQueuedPrompts([prompt]);
              }
              reportError(error, t('queue.deleteFailed'));
            },
          );
      }
    }
    queuedPromptsRef.current = [];
    setQueuedPrompts([]);
    store.dispatch([{ type: 'status', text: t('queue.cleared') }]);
    return true;
  }, [
    refreshPendingPrompts,
    reportError,
    restoreQueuedPrompts,
    store,
    t,
    sessionActions,
  ]);

  const { batches: midTurnInjectedBatches, consume: consumeMidTurnInjected } =
    useDaemonMidTurnInjected();
  useEffect(() => {
    if (!sessionId || midTurnInjectedBatches.length === 0) return;
    if (
      clientId === undefined &&
      midTurnInjectedBatches.some(
        (b) => b.sessionId === sessionId && b.originatorClientId !== undefined,
      )
    ) {
      console.debug(
        '[mid-turn] originator-stamped batches but no client id; dedupe skipped (may resend next turn)',
      );
    }
    const next = removeInjectedFromQueue(
      queuedPromptsRef.current,
      midTurnInjectedBatches,
      sessionId,
      clientId,
    );
    if (next) {
      queuedPromptsRef.current = next;
      setQueuedPrompts(next);
    }
    consumeMidTurnInjected(
      midTurnInjectedBatches.filter((b) => b.sessionId === sessionId),
    );
  }, [midTurnInjectedBatches, sessionId, clientId, consumeMidTurnInjected]);

  return {
    queuedPrompts,
    queuedTexts,
    enqueuePrompt,
    removeQueuedPrompt,
    insertQueuedPrompt,
    editQueuedPrompt,
    editLastQueuedPrompt,
    clearQueuedPrompts,
  };
}
