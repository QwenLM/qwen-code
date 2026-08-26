/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dispatch, SetStateAction } from 'react';
import type {
  DaemonApprovalMode,
  DaemonSessionContextStatus,
  DaemonSessionClient,
  DaemonSessionBtwResult,
  DaemonSessionGenerationEvent,
  CreateSessionRequest,
  DaemonForkSessionResult,
  DaemonMidTurnMessageResult,
  DaemonMidTurnMessagesResult,
  DaemonRemoveMidTurnMessageResult,
  DaemonPendingPromptSummary,
  DaemonRewindResult,
  DaemonSessionRecapResult,
  DaemonRewindSnapshotInfo,
  DaemonSessionTaskStatus,
  DaemonSessionArtifactsEnvelope,
  DaemonTranscriptStore,
  DaemonCapabilities,
  DaemonBranchSessionRequest,
  GoalControlRequest,
  GoalSnapshotV2,
  DaemonBranchedSession,
  DaemonSessionAttachmentReference,
  PermissionResponse,
  PromptContentBlock,
} from '@qwen-code/sdk/daemon';
import {
  DaemonHttpError,
  DaemonPendingPromptLimitError,
  isDaemonTurnError,
  isStaleBranchPointError,
  type PromptResult,
} from '@qwen-code/sdk/daemon';
import { extractHttpStatus, isInvalidClientIdError } from './httpErrors.js';
import {
  mapProviderStatus,
  mapReasoningControls,
  mapSessionContextReasoning,
  mapSupportedCommands,
  selectGoalState,
  selectGoalStateFromRead,
} from './mappers.js';
import {
  attachmentUriForName,
  daemonPromptImageToBlob,
  toDaemonPromptContent,
  withAttachmentTokens,
} from './promptContent.js';
import {
  clearPassiveAssistantDoneTimer,
  withActionTimeout,
  type TimerRef,
} from '../timing.js';
import {
  getPersistedClientId,
  persistStableClientId,
} from './clientLifecycle.js';
import type {
  ActivePrompt,
  AddDaemonSessionNotice,
  DaemonConnectionState,
  DaemonNoticeOperation,
  DaemonPromptFile,
  DaemonPromptStatus,
  DaemonSessionActions,
  SettledPrompt,
  PendingSessionLoad,
} from './types.js';

interface RefBox<T> {
  current: T;
}

function normalizePromptFiles(
  files: readonly DaemonPromptFile[] | undefined,
): Array<{ name: string; data: Blob; text?: string; mimeType: string }> {
  return (files ?? []).map((file) => ({
    name: file.name,
    data: file.data ?? new Blob([file.text ?? '']),
    ...(file.text !== undefined ? { text: file.text } : {}),
    mimeType:
      file.mimeType || file.mediaType || file.media_type || 'text/plain',
  }));
}

function imageAttachmentMimeType(mimeType: string): string {
  return mimeType.split(';', 1)[0]?.trim().toLowerCase() || mimeType;
}

function imageAttachmentName(mimeType: string): string {
  const extension = imageAttachmentMimeType(mimeType)
    .slice('image/'.length)
    .split('+', 1)[0];
  return `image.${extension === 'jpg' ? 'jpeg' : extension || 'img'}`;
}

function promptFilesForTranscript(
  files: ReturnType<typeof normalizePromptFiles>,
  fileReferences: ReadonlyArray<DaemonSessionAttachmentReference | undefined>,
  includeData = false,
) {
  return files.map((file, index) => ({
    name: fileReferences[index]?.attachmentId ?? file.name,
    mimeType: file.mimeType,
    ...(file.text !== undefined ? { text: file.text } : {}),
    ...(includeData ? { data: file.data } : {}),
    ...(fileReferences[index]
      ? { attachmentId: fileReferences[index].attachmentId }
      : {}),
  }));
}

class AttachmentUploadError extends Error {
  constructor(readonly reason: unknown) {
    super(reason instanceof Error ? reason.message : String(reason));
  }
}

const DEFAULT_RESTORE_SERVER_TIMEOUT_MS = 60_000;
const RESTORE_REQUEST_HEADROOM_MS = 10_000;
const RESTORE_WATCHDOG_HEADROOM_MS = 15_000;
const ATTACH_WATCHDOG_TIMEOUT_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function resolveSessionRestoreTimeouts(
  capabilities: DaemonCapabilities | undefined,
): { requestTimeoutMs: number; watchdogTimeoutMs: number | undefined } {
  const advertised = capabilities?.limits?.sessionRestoreTimeoutMs;
  const serverTimeoutMs =
    typeof advertised === 'number' &&
    Number.isInteger(advertised) &&
    advertised > 0
      ? advertised
      : DEFAULT_RESTORE_SERVER_TIMEOUT_MS;
  const requestTimeoutMs = serverTimeoutMs + RESTORE_REQUEST_HEADROOM_MS;
  const watchdogTimeoutMs = serverTimeoutMs + RESTORE_WATCHDOG_HEADROOM_MS;
  return {
    requestTimeoutMs:
      requestTimeoutMs > MAX_TIMER_DELAY_MS ? 0 : requestTimeoutMs,
    watchdogTimeoutMs:
      watchdogTimeoutMs > MAX_TIMER_DELAY_MS ? undefined : watchdogTimeoutMs,
  };
}

function clearPendingLoadTimeout(load: PendingSessionLoad): void {
  if (load.timeout !== undefined) clearTimeout(load.timeout);
}

export function normalizeWorkspaceIdentity(value: string | undefined): string {
  return value ? value.replace(/\\/g, '/').replace(/\/+$/, '') || '/' : '';
}

export interface CreateDaemonSessionActionsArgs {
  store: DaemonTranscriptStore;
  sessionRef: RefBox<DaemonSessionClient | undefined>;
  activePromptsRef: RefBox<Map<string, ActivePrompt>>;
  settledPromptsRef: RefBox<Map<string, SettledPrompt>>;
  pendingSessionLoadRef: RefBox<PendingSessionLoad | undefined>;
  pendingSessionLoadIdRef: RefBox<number>;
  sessionConfigGeneration: WeakMap<DaemonSessionClient, number>;
  heartbeatSupportedRef: RefBox<boolean>;
  manualSessionClearRef: RefBox<boolean>;
  skipNextCleanupDetachSessionRef: RefBox<DaemonSessionClient | undefined>;
  passiveAssistantDoneTimerRef: TimerRef;
  getCreateSessionRequest: () => CreateSessionRequest;
  createDetachedSession: (
    workspaceCwd?: string,
    overrides?: Pick<
      CreateSessionRequest,
      'approvalMode' | 'sourceType' | 'worktree' | 'branch'
    >,
  ) => Promise<DaemonSessionClient>;
  getConnection: () => DaemonConnectionState;
  hasSessionActivePrompt: () => boolean;
  resetCurrentSessionActivePrompt: () => void;
  restartEventStream: (sessionId: string) => void;
  addNotice: AddDaemonSessionNotice;
  setConnection: Dispatch<SetStateAction<DaemonConnectionState>>;
  setPromptStatus: Dispatch<SetStateAction<DaemonPromptStatus>>;
  setRestoreSessionId: Dispatch<SetStateAction<string | undefined>>;
  setRestoreWorkspaceCwd: Dispatch<SetStateAction<string | undefined>>;
  setRestoreMode: Dispatch<SetStateAction<'load' | 'resume'>>;
  setRestoreSessionNonce: Dispatch<SetStateAction<number>>;
  setAttachSessionNonce: Dispatch<SetStateAction<number>>;
  setNewSessionNonce: Dispatch<SetStateAction<number>>;
  clearLiveJournalRepair?: () => void;
}

export function getWorkspaceModelsAfterSessionClear(
  current: DaemonConnectionState,
): DaemonConnectionState['models'] {
  return current.providers
    ? mapProviderStatus(current.providers).models
    : current.models;
}

export function getConnectionAfterSessionClear(
  current: DaemonConnectionState,
  clearedSessionId: string | undefined,
): DaemonConnectionState {
  const next = { ...current };
  if (!clearedSessionId || current.sessionId === clearedSessionId) {
    delete next.sessionId;
    delete next.clientId;
    delete next.displayName;
    delete next.tokenUsage;
    delete next.tokenCount;
    delete next.goalState;
    // Drop the session-scoped raw snapshots (both carry the cleared
    // sessionId), which also makes the effect's canReuseSessionMetadata
    // check refetch fresh data for the next session.
    delete next.supportedCommands;
    delete next.context;
    delete next.reasoning;
    next.models = getWorkspaceModelsAfterSessionClear(current);
    // Keep `commands`/`skills`: they are workspace-scoped (skills, custom,
    // MCP-prompt and workflow slash commands all live at the workspace/config
    // level, not the session), so they stay valid after the session is
    // cleared. Clearing starts a fresh deferred session that is not created
    // until the first prompt (#6066); preserving these keeps skill-backed
    // slash commands like /review autocompleting in that window — the same
    // guarantee #6153 added for the initial deferred connect. The next
    // session's available_commands_update refreshes them once it lands.
  }
  return {
    ...next,
    status: 'connected',
    loadingTranscript: undefined,
    catchingUp: undefined,
    error: undefined,
    errorStatus: undefined,
    missingSession: false,
  };
}

export function createDaemonSessionActions({
  store,
  sessionRef,
  activePromptsRef,
  settledPromptsRef,
  pendingSessionLoadRef,
  pendingSessionLoadIdRef,
  sessionConfigGeneration,
  heartbeatSupportedRef,
  manualSessionClearRef,
  skipNextCleanupDetachSessionRef,
  passiveAssistantDoneTimerRef,
  getCreateSessionRequest,
  createDetachedSession,
  getConnection,
  hasSessionActivePrompt,
  resetCurrentSessionActivePrompt,
  restartEventStream,
  addNotice,
  setConnection,
  setPromptStatus,
  setRestoreSessionId,
  setRestoreWorkspaceCwd,
  setRestoreMode,
  setRestoreSessionNonce,
  setAttachSessionNonce,
  setNewSessionNonce,
  clearLiveJournalRepair = () => undefined,
}: CreateDaemonSessionActionsArgs): DaemonSessionActions {
  const silentHardFailureNoticeKeys = new Set<string>();
  let noticeOwner = sessionRef.current;
  let reasoningActionToken = 0;
  let appliedReasoningActionToken = 0;
  let modelMutationGeneration = 0;
  let branchInFlight = false;
  let attachmentClient = sessionRef.current?.client;
  let attachmentSessionId = sessionRef.current?.sessionId;
  let attachmentClientId = sessionRef.current?.clientId;

  function trackSessionConfigMutation<T>(
    session: DaemonSessionClient,
    operation: Promise<T>,
  ): Promise<T> {
    sessionConfigGeneration.set(
      session,
      (sessionConfigGeneration.get(session) ?? 0) + 1,
    );
    void operation.then(
      () => finishSessionConfigMutation(session),
      () => finishSessionConfigMutation(session),
    );
    return operation;
  }

  function finishSessionConfigMutation(session: DaemonSessionClient): void {
    sessionConfigGeneration.set(
      session,
      (sessionConfigGeneration.get(session) ?? 0) + 1,
    );
  }

  async function promptContentWithUploadedAttachments(
    session: DaemonSessionClient,
    text: string,
    images: ReadonlyArray<{ data: string; mimeType: string }>,
    files: ReadonlyArray<{
      name: string;
      data: Blob;
      text?: string;
      mimeType: string;
    }>,
    signal?: AbortSignal,
  ): Promise<{
    content: PromptContentBlock[];
    references: DaemonSessionAttachmentReference[];
    fileReferences: DaemonSessionAttachmentReference[];
  }> {
    if (text.trimStart().startsWith('/')) {
      return {
        content: toDaemonPromptContent(text),
        references: [],
        fileReferences: [],
      };
    }
    const supportsAttachmentUpload =
      getConnection().capabilities?.features.includes('session_attachments') ===
      true;
    const canUploadAttachments =
      supportsAttachmentUpload &&
      typeof session.uploadAttachment === 'function';
    if (files.length > 0 && !canUploadAttachments) {
      throw new Error('File attachment upload is not supported');
    }
    const uploadableImages = canUploadAttachments
      ? images.filter((image) => image.mimeType !== 'image/*')
      : [];
    const inlineImages = images.filter(
      (image) => !uploadableImages.includes(image),
    );
    const uploadableFiles = canUploadAttachments ? files : [];
    const inlineFiles = files.filter((file) => !uploadableFiles.includes(file));
    if (uploadableImages.length === 0 && uploadableFiles.length === 0) {
      return {
        content: toDaemonPromptContent(text, images, files),
        references: [],
        fileReferences: [],
      };
    }
    const results = await Promise.allSettled([
      ...uploadableImages.map(
        async (image) =>
          await session.uploadAttachment(
            daemonPromptImageToBlob(image),
            imageAttachmentName(image.mimeType),
            imageAttachmentMimeType(image.mimeType),
            signal,
          ),
      ),
      ...uploadableFiles.map(
        async (file) =>
          await session.uploadAttachment(
            file.data,
            file.name,
            file.mimeType,
            signal,
          ),
      ),
    ]);
    const references = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (!failure) {
      const content = toDaemonPromptContent(text, inlineImages, inlineFiles);
      const fileReferences = references.slice(uploadableImages.length);
      content[0] = {
        type: 'text',
        text: withAttachmentTokens(
          text,
          files.map((file, index) =>
            attachmentUriForName(
              fileReferences[index]?.attachmentId ?? file.name,
            ),
          ),
        ),
      };
      content.splice(1, 0, ...references);
      return {
        content,
        references,
        fileReferences,
      };
    }
    await removeUploadedAttachments(session, references);
    if (extractHttpStatus(failure.reason) === 404) {
      if (uploadableFiles.length > 0) {
        throw new AttachmentUploadError(failure.reason);
      }
      return {
        content: toDaemonPromptContent(text, images, files),
        references: [],
        fileReferences: [],
      };
    }
    throw new AttachmentUploadError(failure.reason);
  }

  async function removeUploadedAttachments(
    session: DaemonSessionClient,
    references: readonly DaemonSessionAttachmentReference[],
  ): Promise<void> {
    await Promise.allSettled(
      references.map((reference) =>
        session.removeAttachment(reference.attachmentId),
      ),
    );
  }

  function isDefinitePromptAdmissionRejection(error: unknown): boolean {
    return (
      error instanceof DaemonHttpError ||
      error instanceof DaemonPendingPromptLimitError
    );
  }

  const ignoreStaleNotice: AddDaemonSessionNotice = (notice) => ({
    ...notice,
    id: notice.id ?? 'stale-session-notice',
    createdAt: notice.createdAt ?? 0,
  });
  const noticeForSession = (session: DaemonSessionClient) => {
    if (sessionRef.current !== session) return ignoreStaleNotice;
    if (noticeOwner !== session) silentHardFailureNoticeKeys.clear();
    noticeOwner = session;
    return addNotice;
  };

  function clearActiveSessionState() {
    clearLiveJournalRepair();
    silentHardFailureNoticeKeys.clear();
    for (const [, active] of activePromptsRef.current) {
      active.controller.abort();
    }
    activePromptsRef.current.clear();
    settledPromptsRef.current.clear();
    setPromptStatus('idle');
    clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
    if (pendingSessionLoadRef.current) {
      if (
        skipNextCleanupDetachSessionRef.current?.sessionId ===
        pendingSessionLoadRef.current.sessionId
      ) {
        skipNextCleanupDetachSessionRef.current = undefined;
      }
      clearPendingLoadTimeout(pendingSessionLoadRef.current);
      pendingSessionLoadRef.current.reject(
        new DOMException('Session cleared', 'AbortError'),
      );
      pendingSessionLoadRef.current = undefined;
    }
    store.reset();
    setRestoreSessionId(undefined);
    setRestoreWorkspaceCwd(undefined);
  }

  function startPendingSessionLoad(
    sessionId: string,
    mode: PendingSessionLoad['mode'],
    signal?: AbortSignal,
    replaySource?: PendingSessionLoad['replaySource'],
  ): Promise<void> {
    const loadId = pendingSessionLoadIdRef.current + 1;
    pendingSessionLoadIdRef.current = loadId;
    if (pendingSessionLoadRef.current) {
      clearPendingLoadTimeout(pendingSessionLoadRef.current);
      pendingSessionLoadRef.current.reject(
        new DOMException(
          `Session ${mode} superseded by a newer request`,
          'AbortError',
        ),
      );
    }
    const loadPromise = new Promise<void>((resolve, reject) => {
      const restoreTimeouts = resolveSessionRestoreTimeouts(
        getConnection().capabilities,
      );
      const watchdogTimeoutMs =
        mode === 'attach'
          ? ATTACH_WATCHDOG_TIMEOUT_MS
          : restoreTimeouts.watchdogTimeoutMs;
      const timeout =
        watchdogTimeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              if (pendingSessionLoadRef.current?.id === loadId) {
                pendingSessionLoadRef.current = undefined;
                if (sessionRef.current?.sessionId !== sessionId) {
                  manualSessionClearRef.current = true;
                  setRestoreSessionId(undefined);
                  setRestoreWorkspaceCwd(undefined);
                  setConnection((current) => {
                    if (
                      current.status !== 'connecting' ||
                      current.sessionId !== sessionId
                    ) {
                      return current;
                    }
                    return {
                      ...getConnectionAfterSessionClear(current, sessionId),
                      status: 'disconnected',
                      sessionId: undefined,
                    };
                  });
                }
                reject(
                  dispatchActionError(
                    addNotice,
                    `${capitalize(mode)} session failed`,
                    new Error(`Session ${mode} timed out`),
                    getSessionLoadNoticeOperation(mode),
                  ),
                );
              }
            }, watchdogTimeoutMs);
      pendingSessionLoadRef.current = {
        id: loadId,
        sessionId,
        mode,
        timeout,
        ...(mode !== 'attach'
          ? { requestTimeoutMs: restoreTimeouts.requestTimeoutMs }
          : {}),
        resolve,
        reject,
        ...(signal ? { signal } : {}),
        ...(replaySource ? { replaySource } : {}),
      };
    });
    return loadPromise;
  }

  function startSessionSwitch(
    sessionId: string,
    mode: 'load' | 'resume',
    workspaceCwd?: string,
    signal?: AbortSignal,
    replaySource?: PendingSessionLoad['replaySource'],
  ): Promise<void> {
    if (replaySource !== 'memory') {
      clearLiveJournalRepair();
    }
    if (signal?.aborted) {
      return Promise.reject(
        new DOMException('Session load cancelled', 'AbortError'),
      );
    }
    manualSessionClearRef.current = false;
    const loadPromise = startPendingSessionLoad(
      sessionId,
      mode,
      signal,
      replaySource,
    );
    const pendingLoad = pendingSessionLoadRef.current;
    const currentSession = sessionRef.current;
    const currentSessionId = currentSession?.sessionId;
    const activePrompt = currentSessionId
      ? activePromptsRef.current.get(currentSessionId)
      : undefined;
    activePrompt?.reject?.(
      new DOMException('Session switch interrupted prompt wait', 'AbortError'),
    );
    if (currentSessionId) {
      activePromptsRef.current.delete(currentSessionId);
    }
    resetCurrentSessionActivePrompt();
    const targetWorkspaceCwd =
      workspaceCwd ??
      currentSession?.workspaceCwd ??
      // A failed switch leaves the target's workspace on the connection for
      // error rendering; never let the next workspace-less load inherit it.
      (getConnection().error ? undefined : getConnection().workspaceCwd);
    const reloadingCurrentSession =
      mode === 'load' &&
      currentSessionId === sessionId &&
      normalizeWorkspaceIdentity(currentSession?.workspaceCwd) ===
        normalizeWorkspaceIdentity(targetWorkspaceCwd);
    if (currentSession) {
      const detachCurrentSession = () =>
        currentSession.detach().catch((error: unknown) => {
          console.warn(
            '[DaemonSessionActions] detach before session switch failed:',
            error,
          );
        });
      if (reloadingCurrentSession) {
        skipNextCleanupDetachSessionRef.current = currentSession;
        void loadPromise
          .then(detachCurrentSession, () => undefined)
          .finally(() => {
            if (skipNextCleanupDetachSessionRef.current === currentSession) {
              skipNextCleanupDetachSessionRef.current = undefined;
            }
          });
      } else {
        void detachCurrentSession();
      }
    }
    if (!reloadingCurrentSession) sessionRef.current = undefined;
    if (!reloadingCurrentSession) {
      setConnection((current) => ({
        ...current,
        status: 'connecting',
        sessionId,
        workspaceCwd: targetWorkspaceCwd,
        clientId: undefined,
        displayName: undefined,
        goalState: undefined,
        error: undefined,
        errorStatus: undefined,
        missingSession: false,
        loadingTranscript: true,
        catchingUp: undefined,
      }));
    }
    setPromptStatus('idle');
    settledPromptsRef.current.clear();
    clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
    if (!reloadingCurrentSession) store.reset();
    setRestoreMode(mode);
    setRestoreSessionId(sessionId);
    setRestoreWorkspaceCwd(targetWorkspaceCwd);
    setRestoreSessionNonce((nonce) => nonce + 1);
    return loadPromise.catch((error: unknown) => {
      // The failed target stays visible (sessionId + workspaceCwd) so the UI
      // can render the load error in context. Only mark the connection as
      // failed; the next switch's workspace derivation skips a failed
      // connection so it cannot inherit this target's workspace. While this
      // load is still the current one — a superseding load has already
      // replaced the connecting state.
      if (
        !isAbortError(error) &&
        (pendingSessionLoadRef.current === undefined ||
          pendingSessionLoadRef.current === pendingLoad)
      ) {
        setConnection((current) => ({
          ...current,
          error: error instanceof Error ? error.message : String(error),
          errorStatus: extractHttpStatus(error),
          loadingTranscript: undefined,
          catchingUp: undefined,
        }));
      }
      throw error;
    });
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
        const normalizedFiles = normalizePromptFiles(options?.files);
        const slashCommand = text.trimStart().startsWith('/');
        const displayedImages = slashCommand ? [] : normalizedImages;
        const displayedFiles = slashCommand ? [] : normalizedFiles;
        const inputAnnotations =
          options?.inputAnnotations && options.inputAnnotations.length > 0
            ? options.inputAnnotations
            : undefined;
        const shouldAppendOptimisticMessage =
          options?.optimisticUserMessage !== false;
        const optimisticMessageAppended =
          shouldAppendOptimisticMessage &&
          displayedImages.length === 0 &&
          displayedFiles.length === 0;
        if (optimisticMessageAppended) {
          store.appendLocalUserMessage(
            text,
            displayedImages,
            inputAnnotations ? { inputAnnotations } : undefined,
            [],
          );
        }
        let uploaded: Awaited<
          ReturnType<typeof promptContentWithUploadedAttachments>
        >;
        try {
          uploaded = await promptContentWithUploadedAttachments(
            session,
            text,
            normalizedImages,
            normalizedFiles,
            ctrl.signal,
          );
        } catch (error) {
          if (shouldAppendOptimisticMessage && !optimisticMessageAppended) {
            store.appendLocalUserMessage(
              text,
              displayedImages,
              inputAnnotations ? { inputAnnotations } : undefined,
              promptFilesForTranscript(displayedFiles, [], true),
            );
          }
          throw error instanceof AttachmentUploadError ? error.reason : error;
        }
        if (ctrl.signal.aborted) {
          await removeUploadedAttachments(session, uploaded.references);
          if (shouldAppendOptimisticMessage && !optimisticMessageAppended) {
            store.appendLocalUserMessage(
              text,
              displayedImages,
              inputAnnotations ? { inputAnnotations } : undefined,
              promptFilesForTranscript(displayedFiles, [], true),
            );
          }
          ctrl.signal.throwIfAborted();
        }
        const promptRequest: Record<string, unknown> = {
          prompt: uploaded.content,
        };
        options?.onAdmissionStarted?.();
        if (inputAnnotations) {
          promptRequest['_meta'] = { inputAnnotations };
        }
        if (options?.retry) {
          promptRequest['retry'] = true;
        }
        let accepted: Awaited<ReturnType<typeof session.submitPrompt>>;
        try {
          accepted = await session.submitPrompt(
            promptRequest as Parameters<typeof session.submitPrompt>[0],
            ctrl.signal,
          );
        } catch (error) {
          const definiteRejection = isDefinitePromptAdmissionRejection(error);
          if (definiteRejection) {
            await removeUploadedAttachments(session, uploaded.references);
          }
          if (shouldAppendOptimisticMessage && !optimisticMessageAppended) {
            store.appendLocalUserMessage(
              text,
              displayedImages,
              inputAnnotations ? { inputAnnotations } : undefined,
              promptFilesForTranscript(
                displayedFiles,
                definiteRejection ? [] : uploaded.fileReferences,
                definiteRejection,
              ),
            );
          }
          throw error;
        }
        if (shouldAppendOptimisticMessage && !optimisticMessageAppended) {
          store.appendLocalUserMessage(
            text,
            displayedImages,
            inputAnnotations ? { inputAnnotations } : undefined,
            promptFilesForTranscript(displayedFiles, uploaded.fileReferences),
          );
        }
        if (activePromptsRef.current.get(sessionId)?.controller === ctrl) {
          restartEventStream(sessionId);
        }
        // The prompt is admitted to the session here — signal it before we wait
        // out the (possibly long) turn, so an admission-only caller can proceed.
        options?.onAdmitted?.();
        return await waitForAcceptedPromptCompletion(
          activePromptsRef.current,
          settledPromptsRef.current,
          sessionId,
          ctrl,
          accepted.promptId,
        );
      } catch (error) {
        if (isAbortError(error)) {
          if (sessionRef.current?.sessionId === sessionId) {
            store.dispatch({ type: 'assistant.done', reason: 'cancelled' });
          }
          return { stopReason: 'cancelled' };
        }
        if (isDaemonTurnError(error)) {
          throw error;
        }
        if (sessionRef.current?.sessionId === sessionId) {
          store.dispatch({ type: 'assistant.done', reason: 'error' });
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
          !hasSessionActivePrompt()
        ) {
          setPromptStatus('idle');
        }
      }
    },

    async submitPrompt(text, options) {
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Prompt failed',
        'send_prompt',
      );
      if (options?.sessionId && session.sessionId !== options.sessionId) {
        throw new Error('Session changed before prompt submission');
      }
      const normalizedImages: Array<{ data: string; mimeType: string }> = (
        options?.images ?? []
      ).map((img) => ({
        data: img.data,
        mimeType: img.mimeType || img.mediaType || img.media_type || 'image/*',
      }));
      const normalizedFiles = normalizePromptFiles(options?.files);
      const slashCommand = text.trimStart().startsWith('/');
      const displayedImages = slashCommand ? [] : normalizedImages;
      const displayedFiles = slashCommand ? [] : normalizedFiles;
      const inputAnnotations =
        options?.inputAnnotations && options.inputAnnotations.length > 0
          ? options.inputAnnotations
          : undefined;
      const shouldAppendOptimisticMessage =
        options?.optimisticUserMessage !== false;
      const optimisticMessageAppended =
        shouldAppendOptimisticMessage &&
        displayedImages.length === 0 &&
        displayedFiles.length === 0;
      if (optimisticMessageAppended) {
        store.appendLocalUserMessage(
          text,
          displayedImages,
          inputAnnotations ? { inputAnnotations } : undefined,
          [],
        );
      }
      let uploaded: Awaited<
        ReturnType<typeof promptContentWithUploadedAttachments>
      >;
      try {
        uploaded = await promptContentWithUploadedAttachments(
          session,
          text,
          normalizedImages,
          normalizedFiles,
          options?.signal,
        );
      } catch (error) {
        if (shouldAppendOptimisticMessage && !optimisticMessageAppended) {
          store.appendLocalUserMessage(
            text,
            displayedImages,
            inputAnnotations ? { inputAnnotations } : undefined,
            promptFilesForTranscript(displayedFiles, [], true),
          );
        }
        throw error instanceof AttachmentUploadError ? error.reason : error;
      }
      const promptRequest: Record<string, unknown> = {
        prompt: uploaded.content,
      };
      if (inputAnnotations) {
        promptRequest['_meta'] = { inputAnnotations };
      }
      if (options?.retry) {
        promptRequest['retry'] = true;
      }
      options?.onAdmissionStarted?.();
      let accepted: Awaited<ReturnType<typeof session.submitPrompt>>;
      try {
        accepted = await session.submitPrompt(
          promptRequest as Parameters<typeof session.submitPrompt>[0],
        );
      } catch (error) {
        const definiteRejection = isDefinitePromptAdmissionRejection(error);
        if (definiteRejection) {
          await removeUploadedAttachments(session, uploaded.references);
        }
        if (shouldAppendOptimisticMessage && !optimisticMessageAppended) {
          store.appendLocalUserMessage(
            text,
            displayedImages,
            inputAnnotations ? { inputAnnotations } : undefined,
            promptFilesForTranscript(
              displayedFiles,
              definiteRejection ? [] : uploaded.fileReferences,
              definiteRejection,
            ),
          );
        }
        throw error;
      }
      if (shouldAppendOptimisticMessage && !optimisticMessageAppended) {
        store.appendLocalUserMessage(
          text,
          displayedImages,
          inputAnnotations ? { inputAnnotations } : undefined,
          promptFilesForTranscript(displayedFiles, uploaded.fileReferences),
        );
      }
      if (options?.signal?.aborted) {
        try {
          const removal = await session.removePendingPrompt(accepted.promptId);
          if (removal.removed) {
            await removeUploadedAttachments(session, uploaded.references);
            return { promptId: accepted.promptId, removedAfterAbort: true };
          }
        } catch (err) {
          console.warn(
            '[submitPrompt] removePendingPrompt failed after abort',
            err,
          );
          addNotice({
            severity: 'error',
            category: 'user_action',
            operation: 'send_prompt',
            code: 'daemon.send_prompt.pending_cleanup_failed',
            message:
              'Prompt was accepted after cancellation but could not be removed from the queue.',
            debugMessage: err instanceof Error ? err.message : String(err),
            recoverable: true,
          });
        }
        throw (
          options.signal.reason ?? new DOMException('Aborted', 'AbortError')
        );
      }
      return { promptId: accepted.promptId };
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
          !hasSessionActivePrompt()
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
        const modelRequest = session.setModel(modelId);
        const contextRequest = trackSessionConfigMutation(
          session,
          modelRequest.then(() => session.context()),
        );
        const result = await withActionTimeout(
          modelRequest,
          'Set model timed out',
        );
        const modelGeneration =
          sessionRef.current === session
            ? ++modelMutationGeneration
            : undefined;
        if (modelGeneration !== undefined) {
          setConnection((current) => {
            if (
              sessionRef.current !== session ||
              modelGeneration !== modelMutationGeneration
            ) {
              return current;
            }
            return { ...current, currentModel: modelId, reasoning: undefined };
          });
        }
        const context = await withActionTimeout(
          contextRequest,
          'Refresh model context timed out',
        ).catch(() => undefined);
        if (
          modelGeneration !== undefined &&
          sessionRef.current === session &&
          modelGeneration === modelMutationGeneration
        ) {
          setConnection((current) => {
            if (
              sessionRef.current !== session ||
              modelGeneration !== modelMutationGeneration ||
              current.currentModel !== modelId
            ) {
              return current;
            }
            return {
              ...current,
              context: context ?? current.context,
              reasoning: context
                ? mapSessionContextReasoning(context)
                : undefined,
            };
          });
        }
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

    async setReasoningEffort(value) {
      const actionToken = ++reasoningActionToken;
      const sourceModel = getConnection().currentModel;
      const sourceModelGeneration = modelMutationGeneration;
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Set reasoning effort failed',
        'set_reasoning_effort',
      );
      try {
        const result = await withActionTimeout(
          trackSessionConfigMutation(
            session,
            session.setConfigOption('reasoning_effort', value),
          ),
          'Set reasoning effort timed out',
        );
        const nextReasoning = mapReasoningControls(
          result.configOptions,
          getConnection().reasoning?.effort,
        );
        const confirmed =
          value === 'none'
            ? nextReasoning?.enabled === false
            : nextReasoning?.enabled === true && nextReasoning.effort === value;
        if (!confirmed) {
          throw new Error(
            `Daemon did not confirm reasoning effort ${JSON.stringify(value)}`,
          );
        }
        const current = getConnection();
        if (
          sessionRef.current === session &&
          sourceModelGeneration === modelMutationGeneration &&
          current.currentModel === sourceModel &&
          actionToken > appliedReasoningActionToken
        ) {
          appliedReasoningActionToken = actionToken;
          setConnection((current) => {
            if (
              sessionRef.current !== session ||
              sourceModelGeneration !== modelMutationGeneration ||
              current.currentModel !== sourceModel
            ) {
              return current;
            }
            const configOptions = result.configOptions;
            return {
              ...current,
              reasoning: nextReasoning,
              context: current.context
                ? {
                    ...current.context,
                    state: { ...current.context.state, configOptions },
                  }
                : current.context,
            };
          });
        }
      } catch (error) {
        throw dispatchActionError(
          noticeForSession(session),
          'Set reasoning effort failed',
          error,
          'set_reasoning_effort',
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
        if (sessionRef.current === session) {
          setConnection((current) => ({
            ...current,
            currentMode: result.mode || mode,
          }));
        }
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

    async listSessions(options) {
      const session = sessionRef.current;
      if (!session) return [];
      try {
        return await withActionTimeout(
          session.client.listWorkspaceSessions(session.workspaceCwd, options),
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

    async loadSession(sessionId, options) {
      return startSessionSwitch(sessionId, 'load', options?.workspaceCwd);
    },

    async reloadSession(signal, options) {
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Reload session failed',
        'load_session',
      );
      return startSessionSwitch(
        session.sessionId,
        'load',
        session.workspaceCwd,
        signal,
        options?.replaySource,
      );
    },

    async resumeSession(sessionId, options) {
      return startSessionSwitch(sessionId, 'resume', options?.workspaceCwd);
    },

    async createSession(options?: {
      workspaceCwd?: string;
      approvalMode?: DaemonApprovalMode;
      sourceType?: string;
      worktree?: { slug?: string };
      branch?: { name: string };
    }) {
      let rawCreateStarted = false;
      let rawCreateSettled = false;
      let retireLateResult = false;
      const trackCreate = <T>(
        request: Promise<T>,
        retire: (created: T) => Promise<unknown>,
      ) => {
        rawCreateStarted = true;
        void request.then(
          (created) => {
            rawCreateSettled = true;
            if (retireLateResult) {
              void retire(created).catch((error: unknown) => {
                console.warn(
                  '[DaemonSessionActions] detach after timed-out create failed:',
                  error,
                );
              });
            }
          },
          () => {
            rawCreateSettled = true;
          },
        );
        return request;
      };
      try {
        manualSessionClearRef.current = false;
        // Fold the initial approval mode into the create request so the daemon
        // applies it atomically at spawn (`POST /session` →
        // `spawnOrAttach({ approvalMode })`), avoiding a follow-up
        // `setApprovalMode` round-trip. Approval mode is fail-closed at spawn:
        // an application failure aborts creation (this call rejects) rather than
        // leaving the session in a different mode than the caller requested.
        const requestOverrides = {
          ...(options?.approvalMode !== undefined
            ? { approvalMode: options.approvalMode }
            : {}),
          ...(options?.sourceType !== undefined
            ? { sourceType: options.sourceType }
            : {}),
          ...(options?.worktree !== undefined
            ? { worktree: options.worktree }
            : {}),
          ...(options?.branch !== undefined ? { branch: options.branch } : {}),
        };
        const session = sessionRef.current;
        const activeSession =
          session && getConnection().sessionId === session.sessionId
            ? session
            : undefined;
        if (activeSession) {
          const nextSession = await withActionTimeout(
            trackCreate(
              activeSession.client.createOrAttachSession({
                ...getCreateSessionRequest(),
                ...(options?.workspaceCwd !== undefined
                  ? { workspaceCwd: options.workspaceCwd }
                  : {}),
                ...requestOverrides,
              }),
              (created) =>
                activeSession.client.detachSession(
                  created.sessionId,
                  created.clientId,
                ),
            ),
            'Create session timed out',
          );
          persistStableClientId(nextSession.clientId, nextSession.sessionId);
          return nextSession;
        }

        const nextSession = await withActionTimeout(
          trackCreate(
            createDetachedSession(options?.workspaceCwd, requestOverrides),
            (created) => created.detach(),
          ),
          'Create session timed out',
        );
        if (manualSessionClearRef.current) {
          try {
            await withActionTimeout(
              nextSession.detach(),
              'Detach cleared session timed out',
            );
          } catch (error) {
            console.warn(
              '[DaemonSessionActions] detach after interrupted create failed:',
              error,
            );
          }
          throw new DOMException('Session creation interrupted', 'AbortError');
        }
        persistStableClientId(nextSession.clientId, nextSession.sessionId);
        sessionRef.current = nextSession;
        skipNextCleanupDetachSessionRef.current = nextSession;
        setConnection((current) => ({
          ...current,
          status: 'connected',
          sessionId: nextSession.sessionId,
          goalState: undefined,
          ...(nextSession.clientId ? { clientId: nextSession.clientId } : {}),
          workspaceCwd: nextSession.workspaceCwd,
          error: undefined,
          errorStatus: undefined,
          missingSession: false,
        }));
        return nextSession;
      } catch (error) {
        if (rawCreateStarted && !rawCreateSettled) retireLateResult = true;
        throw dispatchActionError(
          addNotice,
          `Create session failed${
            options?.workspaceCwd ? ` (workspace: ${options.workspaceCwd})` : ''
          }`,
          error,
          'create_session',
        );
      }
    },

    async attachSession() {
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Attach session failed',
        'attach_session',
      );
      const loadPromise = startPendingSessionLoad(session.sessionId, 'attach');
      setAttachSessionNonce((nonce) => nonce + 1);
      return loadPromise;
    },

    async clearSession() {
      const session = sessionRef.current;
      manualSessionClearRef.current = true;
      clearActiveSessionState();
      sessionRef.current = undefined;
      setConnection((current) =>
        getConnectionAfterSessionClear(current, session?.sessionId),
      );
      if (session) {
        try {
          await withActionTimeout(session.detach(), 'Clear session timed out');
        } catch (error) {
          console.warn('[DaemonSessionActions] detach on clear failed:', error);
        }
      }
    },

    async newSession() {
      manualSessionClearRef.current = false;
      clearActiveSessionState();
      setConnection((current) => ({
        ...current,
        goalState: undefined,
        missingSession: false,
        error: undefined,
        errorStatus: undefined,
      }));
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
        if (sessionRef.current === session) {
          const { commands, skills } = mapSupportedCommands(status);
          setConnection((current) => ({
            ...current,
            commands,
            skills,
            supportedCommands: status,
          }));
        }
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
      const configGeneration = sessionConfigGeneration.get(session) ?? 0;
      try {
        const context = await withActionTimeout(
          session.context(),
          'Load context timed out',
        );
        setConnection((current) => {
          if (
            sessionRef.current !== session ||
            configGeneration % 2 !== 0 ||
            (sessionConfigGeneration.get(session) ?? 0) !== configGeneration
          ) {
            return current;
          }
          return {
            ...current,
            context,
            currentMode:
              getModeFromSessionContext(context) ?? current.currentMode,
            currentModel:
              getModelFromSessionContext(context) ?? current.currentModel,
            reasoning: mapSessionContextReasoning(
              context,
              current.reasoning?.effort,
            ),
          };
        });
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

    async *generateSessionContent(
      prompt: string,
      opts?: { signal?: AbortSignal },
    ): AsyncGenerator<DaemonSessionGenerationEvent> {
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Generate content failed',
        'generate_session_content',
      );
      yield* session.generateContent(prompt, opts);
    },

    async getRewindSnapshots(): Promise<{
      snapshots: DaemonRewindSnapshotInfo[];
    }> {
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Load rewind snapshots failed',
        'rewind_snapshots',
      );
      try {
        return await withActionTimeout(
          session.getRewindSnapshots(),
          'Load rewind snapshots timed out',
        );
      } catch (error) {
        throw dispatchActionError(
          addNotice,
          'Load rewind snapshots failed',
          error,
          'rewind_snapshots',
        );
      }
    },

    async rewindSession(
      promptId: string,
      opts?: { rewindFiles?: boolean },
    ): Promise<DaemonRewindResult> {
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Rewind session failed',
        'rewind_session',
      );
      try {
        return await withActionTimeout(
          session.rewind(promptId, opts),
          'Rewind session timed out',
        );
      } catch (error) {
        throw dispatchActionError(
          addNotice,
          'Rewind session failed',
          error,
          'rewind_session',
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

    async uploadAttachment(attachment, opts) {
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Attachment upload failed',
        'send_prompt',
      );
      if (opts?.sessionId && opts.sessionId !== session.sessionId) {
        throw new Error('Attachment session changed');
      }
      const mimeType =
        attachment.mimeType ??
        attachment.mediaType ??
        attachment.media_type ??
        ('name' in attachment ? 'application/octet-stream' : 'image/*');
      attachmentClient = session.client;
      attachmentSessionId = session.sessionId;
      attachmentClientId = session.clientId;
      if ('name' in attachment) {
        return await session.uploadAttachment(
          attachment.data ??
            new Blob([attachment.text ?? ''], { type: mimeType }),
          attachment.name,
          mimeType,
          opts?.signal,
        );
      }
      return await session.uploadAttachment(
        daemonPromptImageToBlob(attachment),
        imageAttachmentName(mimeType),
        imageAttachmentMimeType(mimeType),
        opts?.signal,
      );
    },

    async readAttachment(attachmentId) {
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Attachment preview failed',
        'read_attachment',
      );
      return await session.readAttachment(attachmentId);
    },

    async removeAttachment(attachmentId, opts) {
      const session = sessionRef.current;
      const sessionId = opts?.sessionId ?? session?.sessionId;
      const client = session?.client ?? attachmentClient;
      if (!sessionId || !client) {
        throw dispatchActionError(
          addNotice,
          'Attachment removal failed',
          new Error('Daemon session is not connected'),
          'remove_attachment',
        );
      }
      if (sessionId === session?.sessionId) {
        return await session.removeAttachment(attachmentId);
      }
      const clientId =
        getPersistedClientId(sessionId) ??
        (attachmentSessionId === sessionId ? attachmentClientId : undefined);
      try {
        return clientId
          ? await client.removeSessionAttachment(sessionId, attachmentId, {
              clientId,
            })
          : await client.removeSessionAttachment(sessionId, attachmentId);
      } catch (error) {
        if (!clientId || !isInvalidClientIdError(error)) throw error;
        return await client.removeSessionAttachment(sessionId, attachmentId);
      }
    },

    async enqueueMidTurnMessage(
      message: string,
      opts?: {
        signal?: AbortSignal;
        messageId?: string;
        content?: PromptContentBlock[];
        onAdmissionStarted?: () => void;
      },
    ): Promise<DaemonMidTurnMessageResult> {
      // Calls without an id are the old-daemon compatibility path and fall back
      // locally. With a stable id, transport failure is ambiguous (the POST may
      // already have committed), so let the caller reconcile instead of
      // reporting a false rejection.
      const session = sessionRef.current;
      if (!session) return { accepted: false };
      try {
        const { onAdmissionStarted, ...requestOptions } = opts ?? {};
        onAdmissionStarted?.();
        return await session.enqueueMidTurnMessage(
          message,
          opts ? requestOptions : undefined,
        );
      } catch (err) {
        if (opts?.messageId) throw err;
        // An abort is the designed settle-time cancel (the message stays in the
        // browser queue for the next turn), not a failure — stay silent. Any
        // OTHER error (daemon down, 4xx/5xx, network, timeout) silently disables
        // mid-turn drain for every client, so surface it at debug for DevTools
        // without raising a user-facing notice.
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          console.debug(
            '[enqueueMidTurnMessage] legacy push failed; kept for next turn',
            err,
          );
        }
        return { accepted: false };
      }
    },

    async removeMidTurnMessage(
      messageId: string,
      opts,
    ): Promise<DaemonRemoveMidTurnMessageResult> {
      const session = sessionRef.current;
      if (!session) return { removed: false };
      if (opts?.sessionId && session.sessionId !== opts.sessionId) {
        // Authenticate against the target session when editing a row restored
        // after a session switch.
        const targetClientId =
          getPersistedClientId(opts.sessionId) ?? session.clientId;
        return await session.client.removeMidTurnMessage(
          opts.sessionId,
          messageId,
          {
            ...(targetClientId ? { clientId: targetClientId } : {}),
          },
        );
      }
      return await session.removeMidTurnMessage(messageId);
    },

    async getMidTurnMessages(opts?: {
      signal?: AbortSignal;
    }): Promise<DaemonMidTurnMessagesResult | undefined> {
      // Best-effort and silent, like `enqueueMidTurnMessage`: reconciliation
      // is a bookkeeping recovery aid (page refresh / missed echo), not a
      // user-initiated action. `undefined` means callers preserve their
      // current state because delivery is unknown.
      const session = sessionRef.current;
      if (!session) return undefined;
      try {
        return await session.getMidTurnMessages(opts);
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          console.debug(
            '[getMidTurnMessages] reconciliation query failed; keeping current state',
            err,
          );
        }
        return undefined;
      }
    },

    async getPendingPrompts(opts) {
      const session = sessionRef.current;
      if (!session)
        return { pendingPrompts: [] as DaemonPendingPromptSummary[] };
      if (opts?.sessionId && session.sessionId !== opts.sessionId) {
        throw new Error('Session changed before pending prompts refresh');
      }
      return await session.getPendingPrompts();
    },

    async removePendingPrompt(promptId: string, opts) {
      const session = sessionRef.current;
      if (!session) return { removed: false };
      if (opts?.sessionId && session.sessionId !== opts.sessionId) {
        return await session.client.removePendingPrompt(
          opts.sessionId,
          promptId,
        );
      }
      return await session.removePendingPrompt(promptId);
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
        if (
          sessionRef.current?.sessionId === session.sessionId &&
          !hasSessionActivePrompt()
        ) {
          setPromptStatus('idle');
        }
      }
    },

    async getTasks(opts) {
      const session = sessionRef.current;
      if (!session) throw new Error('Daemon session is not connected');
      try {
        return await withActionTimeout(session.tasks(), 'Get tasks timed out');
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'Daemon session is not connected'
        ) {
          throw error;
        }
        if (opts?.silent && isTransientActionError(error)) {
          throw error;
        }
        throw dispatchActionError(
          addNotice,
          'Get tasks failed',
          error,
          'load_tasks',
          opts?.silent
            ? {
                dispatchedNoticeKeys: silentHardFailureNoticeKeys,
                noticeOnceKey: getActionErrorNoticeKey('load_tasks', error),
              }
            : undefined,
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

    async getGoal() {
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Load goal failed',
        'load_goal',
      );
      // A read the daemon answered while goal-less can resolve after a
      // concurrent create; its bare-null snapshot carries no `clearedGoal`
      // tombstone, so reconciling it would wipe the new goal. Stamp the read
      // with the goal observed at issue time: a bare-null response may only
      // clear the goal it actually observed.
      const observedGoalId = getConnection().goalState?.goal?.goalId;
      try {
        const response = await withActionTimeout(
          session.goal(),
          'Load goal timed out',
        );
        setConnection((current) => {
          if (current.sessionId !== session.sessionId) return current;
          const goalState = selectGoalStateFromRead(
            current.goalState,
            response.snapshot,
            observedGoalId,
          );
          if (goalState === current.goalState) return current;
          return { ...current, goalState };
        });
        return response;
      } catch (error) {
        throw dispatchActionError(
          addNotice,
          'Load goal failed',
          error,
          'load_goal',
        );
      }
    },

    applyGoalSnapshot(sessionId: string, snapshot: GoalSnapshotV2) {
      setConnection((current) =>
        current.sessionId === sessionId
          ? {
              ...current,
              goalState: selectGoalState(current.goalState, snapshot),
            }
          : current,
      );
    },

    async controlGoal(request: GoalControlRequest) {
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Control goal failed',
        'control_goal',
      );
      try {
        const response = await withActionTimeout(
          session.controlGoal(request),
          'Control goal timed out',
        );
        setConnection((current) =>
          current.sessionId === session.sessionId
            ? {
                ...current,
                goalState: selectGoalState(
                  current.goalState,
                  response.snapshot,
                ),
              }
            : current,
        );
        return response;
      } catch (error) {
        throw dispatchActionError(
          addNotice,
          'Control goal failed',
          error,
          'control_goal',
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

    async loadArtifacts(): Promise<DaemonSessionArtifactsEnvelope> {
      const session = sessionRef.current;
      if (!session) throw new Error('Daemon session is not connected');
      return withActionTimeout(session.artifacts(), 'Load artifacts timed out');
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

    async branchSession(options: DaemonBranchSessionRequest = {}) {
      if (branchInFlight) {
        throw new DOMException(
          'A branch request is already in progress',
          'InvalidStateError',
        );
      }
      const session = requireSessionForAction(
        addNotice,
        sessionRef.current,
        'Branch session failed',
        'branch_session',
      );
      const sourceSessionId = session.sessionId;
      const loadGeneration = pendingSessionLoadIdRef.current;
      branchInFlight = true;
      try {
        const branchRequest = session.client.branchSession(
          sourceSessionId,
          options,
          session.clientId,
        );
        const result = await branchRequest;
        const switchStarted =
          sessionRef.current === session &&
          pendingSessionLoadIdRef.current === loadGeneration;
        const restored =
          !('atRecordId' in options) ||
          options.atRecordId === undefined ||
          ('worktree' in options && options.worktree !== undefined)
            ? (result as DaemonBranchedSession)
            : undefined;
        if (switchStarted) {
          if (restored?.clientId) {
            persistStableClientId(restored.clientId, restored.sessionId);
          }
          void startSessionSwitch(result.sessionId, 'load').catch(
            (switchError: unknown) => {
              if (restored?.clientId) {
                void session.client
                  .detachSession(restored.sessionId, restored.clientId)
                  .catch(() => undefined);
              }
              if (isAbortError(switchError)) return;
              dispatchActionError(
                addNotice,
                'Branch session failed',
                switchError,
                'branch_session',
              );
            },
          );
        } else if (restored?.clientId) {
          void session.client
            .detachSession(restored.sessionId, restored.clientId)
            .catch(() => undefined);
        }
        return {
          sessionId: result.sessionId,
          displayName: result.displayName,
          switchStarted,
        };
      } catch (error) {
        if (isStaleBranchPointError(error)) {
          throw markNoticeDispatched(error);
        }
        throw dispatchActionError(
          addNotice,
          'Branch session failed',
          error,
          'branch_session',
        );
      } finally {
        branchInFlight = false;
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

function getModelFromSessionContext(
  context: DaemonSessionContextStatus,
): string | undefined {
  const models =
    typeof context.state.models === 'object' && context.state.models !== null
      ? (context.state.models as Record<string, unknown>)
      : undefined;
  const model = models?.['currentModelId'] ?? models?.['currentModel'];
  return typeof model === 'string' ? model : undefined;
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
  opts?: {
    dispatchedNoticeKeys?: Set<string>;
    noticeOnceKey?: string;
  },
): Error {
  if (isAbortError(error)) {
    if (error instanceof Error) return error;
    const message = error instanceof DOMException ? error.message : 'Aborted';
    const abortError = new Error(message);
    abortError.name = 'AbortError';
    return abortError;
  }
  const message = error instanceof Error ? error.message : String(error);
  const noticeKey = opts?.noticeOnceKey;
  const dispatchedNoticeKeys = opts?.dispatchedNoticeKeys;
  if (!noticeKey || !dispatchedNoticeKeys?.has(noticeKey)) {
    addNotice({
      severity: 'error',
      category: 'user_action',
      operation,
      code: `daemon.${operation}.failed`,
      message: `${action}: ${message}`,
      debugMessage: message,
      recoverable: true,
    });
    if (noticeKey) {
      dispatchedNoticeKeys?.add(noticeKey);
    }
  }
  return markNoticeDispatched(
    error instanceof Error ? error : new Error(message),
  );
}

function getActionErrorNoticeKey(
  operation: DaemonNoticeOperation,
  error: unknown,
): string {
  return `${operation}:${getActionErrorMessage(error)}`;
}

function getActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTransientActionError(error: unknown): boolean {
  if (isAbortError(error)) return true;
  const status = extractHttpStatus(error);
  if (status !== undefined) {
    return status >= 500 || status === 408 || status === 429;
  }
  const message = getActionErrorMessage(error).toLowerCase();
  return (
    message.includes('timed out') ||
    message.includes('failed to fetch') ||
    message.includes('network error') ||
    message.includes('networkerror')
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

function getSessionLoadNoticeOperation(
  mode: PendingSessionLoad['mode'],
): DaemonNoticeOperation {
  if (mode === 'resume') return 'resume_session';
  if (mode === 'attach') return 'attach_session';
  return 'load_session';
}
