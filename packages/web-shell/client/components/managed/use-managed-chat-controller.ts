import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { Message } from '../../adapters/types';
import { useI18n } from '../../i18n';
import type {
  ComposerSubmit,
  SessionChatController,
} from '../../chat-core/contract';
import { getComposerDraftStorageKey } from '../../hooks/useComposerCore.js';
import { managedCapabilitiesFromSummary } from './chat-capabilities';
import { createManagedChatController } from './chat-controller';
import type {
  ManagedOperationSettlement,
  ManagedTransportAdmission,
  ManagedTurnSettlement,
} from './chat-controller';
import type {
  ManagedAgentActionResponse,
  ManagedAgentOperationObserver,
  ManagedAgentOperationSettlement,
  ManagedAgentPendingAction,
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
} from './managed-agent-provider';
import { managedRequestId } from './managed-session-storage';
import { createManagedMessageProjector } from './managed-session-messages';
import { encodeManagedInput } from './managed-input';
import {
  isAuthFailure,
  isNonRetryableClientError,
} from './managed-request-error';
import {
  canonicalQuestionAnswers,
  questionResponseKey,
} from './managed-question-response';
import { useManagedActions } from './use-managed-actions';
import { useManagedSession } from './use-managed-session';
import {
  useManagedTurnCancel,
  type ManagedTurnCancelObserver,
} from './use-managed-turn-cancel';

interface ManagedChatControllerOptions {
  readonly provider: ManagedAgentProvider;
  readonly clientId: string;
  readonly sessionId: string | undefined;
}

export interface ManagedChatControllerFromStateOptions {
  readonly provider: ManagedAgentProvider;
  readonly clientId: string;
  readonly sessionId: string | undefined;
  readonly detail: ReturnType<typeof useManagedSession>;
  readonly pending: ReturnType<typeof useManagedActions>;
  readonly turnCancel: ReturnType<typeof useManagedTurnCancel>;
  readonly cancelObserverRef: {
    current: ManagedTurnCancelObserver | undefined;
  };
  readonly messages: readonly Message[];
  /**
   * The single pending action currently selected by the host (root or child
   * session). Keeping this singular makes bare-`actionId` submission routing
   * unambiguous even when multiple child sessions share an `actionId`.
   */
  readonly selectedAction: ManagedAgentPendingAction | undefined;
  readonly retainExpiredActions?: boolean;
  readonly canRespondAction?: () => boolean;
  readonly canCancel?: boolean;
}

interface BindingOwner {
  readonly provider: ManagedAgentProvider;
  readonly clientId: string;
  readonly sessionId: string | undefined;
  readonly projectMessages: ReturnType<typeof createManagedMessageProjector>;
  abort: AbortController;
  highWaterId: number;
  onOperation?: (event: ManagedOperationSettlement) => void;
  onTurn?: (event: ManagedTurnSettlement) => void;
}

interface BindingFacts {
  readonly summary: ManagedAgentSessionSummary | undefined;
  readonly detail: ReturnType<typeof useManagedSession>;
  readonly pendingActions: readonly ManagedAgentPendingAction[];
  readonly retryPending: () => void;
  readonly messages: readonly Message[];
}

function admissionFromError(error: unknown): ManagedTransportAdmission {
  return {
    admission:
      isNonRetryableClientError(error) && !isAuthFailure(error)
        ? 'rejected'
        : 'unknown',
  };
}

interface BoundControllerHandles {
  readonly controller: SessionChatController;
  readonly onOperation:
    | ((event: ManagedOperationSettlement) => void)
    | undefined;
  readonly onTurn: ((event: ManagedTurnSettlement) => void) | undefined;
}

function useBindingOwner(
  provider: ManagedAgentProvider,
  clientId: string,
  sessionId: string | undefined,
) {
  const [, render] = useReducer((value: number) => value + 1, 0);
  const owner = useMemo<BindingOwner>(
    () => ({
      provider,
      clientId,
      sessionId,
      projectMessages: createManagedMessageProjector(),
      abort: new AbortController(),
      highWaterId: 0,
    }),
    [provider, clientId, sessionId],
  );
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const isCurrent = useCallback(
    (candidate: BindingOwner) =>
      ownerRef.current === candidate && !candidate.abort.signal.aborted,
    [],
  );

  // StrictMode runs effect setup -> cleanup -> setup against the same memoized
  // owner. Re-arm the AbortController on setup so StrictMode remounts remain
  // live while real owner changes and unmounts still abort in-flight work.
  useEffect(() => {
    if (owner.abort.signal.aborted) {
      owner.abort = new AbortController();
    }
    const abort = owner.abort;
    return () => {
      abort.abort();
    };
  }, [owner]);

  return { owner, isCurrent, render };
}

function useObserveManagedOperation(
  isCurrent: (candidate: BindingOwner) => boolean,
  render: () => void,
) {
  return useCallback(
    (
      candidate: BindingOwner,
      observation: ManagedAgentOperationSettlement,
      expectedSessionId: string | undefined,
      onCompleted?: () => void,
    ) => {
      if (
        !isCurrent(candidate) ||
        observation.sessionId !== expectedSessionId
      ) {
        return;
      }
      if (
        observation.status !== 'completed' &&
        observation.status !== 'failed' &&
        observation.status !== 'cancelled' &&
        observation.status !== 'recovery_blocked'
      ) {
        return;
      }
      if (observation.status === 'completed') {
        onCompleted?.();
      }
      const listener = candidate.onOperation;
      if (!listener) return;
      listener({
        operationId: observation.operationId,
        status: observation.status,
      });
      render();
    },
    [isCurrent, render],
  );
}

function useManagedCancelBinding(
  owner: BindingOwner,
  isCurrent: (candidate: BindingOwner) => boolean,
  observeOperation: (
    candidate: BindingOwner,
    observation: ManagedAgentOperationSettlement,
    expectedSessionId: string | undefined,
  ) => void,
) {
  const cancelResponseRef = useRef<
    | {
        owner: BindingOwner;
        turnId: string;
        resolve: (admission: ManagedTransportAdmission) => void;
        waiters: Array<(admission: ManagedTransportAdmission) => void>;
      }
    | undefined
  >(undefined);
  const cancelObserver = useMemo<ManagedTurnCancelObserver>(
    () => ({
      onAccepted: (admission) => {
        const pendingCancel = cancelResponseRef.current;
        if (
          !pendingCancel ||
          pendingCancel.owner !== owner ||
          !isCurrent(owner)
        ) {
          return;
        }
        if (
          admission.sessionId !== owner.sessionId ||
          admission.turnId !== pendingCancel.turnId ||
          !admission.operationId
        ) {
          pendingCancel.resolve({ admission: 'unknown' });
          return;
        }
        pendingCancel.resolve({
          admission: 'accepted',
          operationId: admission.operationId,
        });
      },
      // Operation poll settlements lack turnId, so they only settle already
      // admitted operations via operationId and never forge admission for an
      // unrelated turn's cancel() call.
      onSettlement: (settlement) => {
        observeOperation(owner, settlement, owner.sessionId);
      },
      onError: (error) => {
        const pendingCancel = cancelResponseRef.current;
        if (pendingCancel?.owner === owner) {
          pendingCancel.resolve(admissionFromError(error));
        }
      },
    }),
    [isCurrent, observeOperation, owner],
  );

  const runCancelTurn = useCallback(
    (
      source: BindingOwner,
      turnId: string,
      canCancel: boolean,
      busy: boolean,
      requestCancel: () => Promise<void>,
    ): Promise<ManagedTransportAdmission> => {
      if (!isCurrent(source)) {
        return Promise.resolve({ admission: 'unknown' });
      }
      if (!canCancel) {
        return Promise.resolve({ admission: 'rejected' });
      }
      const live = cancelResponseRef.current;
      if (live && live.owner === source) {
        if (live.turnId === turnId) {
          return new Promise((resolve) => {
            live.waiters.push(resolve);
          });
        }
        return Promise.resolve({ admission: 'unknown' });
      }
      if (busy) {
        return Promise.resolve({ admission: 'rejected' });
      }
      return new Promise((resolve) => {
        const signal = source.abort.signal;
        let settled = false;
        const slot = {
          owner: source,
          turnId,
          resolve: (admission: ManagedTransportAdmission) => {
            settle(admission);
          },
          waiters: [] as Array<(admission: ManagedTransportAdmission) => void>,
        };
        const settle = (admission: ManagedTransportAdmission) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          if (cancelResponseRef.current === slot) {
            cancelResponseRef.current = undefined;
          }
          const resolved: ManagedTransportAdmission = isCurrent(source)
            ? admission
            : { admission: 'unknown' };
          resolve(resolved);
          for (const waiter of slot.waiters) {
            waiter(resolved);
          }
          slot.waiters.length = 0;
        };
        const onAbort = () => settle({ admission: 'unknown' });
        signal.addEventListener('abort', onAbort, { once: true });
        cancelResponseRef.current = slot;
        void requestCancel().then(
          () => settle({ admission: 'unknown' }),
          (error) => settle(admissionFromError(error)),
        );
      });
    },
    [isCurrent],
  );

  return { cancelObserver, runCancelTurn };
}

function useBindControllerSettlements(
  owner: BindingOwner,
  bound: BoundControllerHandles | undefined,
  detail: ReturnType<typeof useManagedSession>,
  ready: boolean,
  isCurrent: (candidate: BindingOwner) => boolean,
  render: () => void,
) {
  // Attach listeners only on commit so StrictMode double-invoked useMemo calls
  // never overwrite the committed controller's callbacks with a discarded one.
  useEffect(() => {
    if (!bound) return;
    owner.onOperation = bound.onOperation;
    owner.onTurn = bound.onTurn;
    return () => {
      if (owner.onOperation === bound.onOperation)
        owner.onOperation = undefined;
      if (owner.onTurn === bound.onTurn) owner.onTurn = undefined;
    };
  }, [bound, owner]);

  // Advance the monotonic event high-water mark so already-seen snapshot events
  // and later loadOlder() pages (event.id <= highWaterId) never replay as fresh
  // turn settlements.
  useEffect(() => {
    if (!ready || detail.loading) return;
    let forwarded = false;
    for (const event of detail.events) {
      if (event.id <= owner.highWaterId) continue;
      owner.highWaterId = event.id;
      if (
        event.sessionId !== owner.sessionId ||
        !event.turnId ||
        (event.type !== 'completed' &&
          event.type !== 'failed' &&
          event.type !== 'cancelled')
      ) {
        continue;
      }
      if (!isCurrent(owner)) return;
      const listener = owner.onTurn;
      if (!listener) continue;
      listener({ turnId: event.turnId, outcome: event.type });
      forwarded = true;
    }
    if (forwarded) render();
  }, [detail.events, detail.loading, isCurrent, owner, ready, render]);
}

export function useManagedChatController({
  provider,
  clientId,
  sessionId,
}: ManagedChatControllerOptions): SessionChatController | undefined {
  const detail = useManagedSession(provider, clientId, sessionId);
  const { t } = useI18n();
  const { owner, isCurrent, render } = useBindingOwner(
    provider,
    clientId,
    sessionId,
  );
  const summary =
    detail.summary?.sessionId === sessionId ? detail.summary : undefined;
  const hasSummary = summary !== undefined;
  const pending = useManagedActions(
    provider,
    sessionId,
    clientId,
    summary?.capabilities.actions,
    detail.events,
  );
  const truncatedLabel = t('managed.truncated');
  const messages = useMemo(
    () => owner.projectMessages(detail.events, truncatedLabel),
    [owner, detail.events, truncatedLabel],
  );
  const factsRef = useRef(new WeakMap<BindingOwner, BindingFacts>());
  factsRef.current.set(owner, {
    summary,
    detail,
    pendingActions: pending.actions,
    retryPending: pending.retry,
    messages,
  });
  const facts = useCallback(
    (candidate: BindingOwner) => factsRef.current.get(candidate)!,
    [],
  );

  const observeOperation = useObserveManagedOperation(isCurrent, render);

  const sendResponse = useCallback(
    (
      source: BindingOwner,
      action: ManagedAgentPendingAction,
      response: ManagedAgentActionResponse,
      idempotencyKey: string,
    ): Promise<ManagedTransportAdmission> =>
      new Promise((resolve) => {
        const signal = source.abort.signal;
        let settled = false;
        const settle = (admission: ManagedTransportAdmission) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve(isCurrent(source) ? admission : { admission: 'unknown' });
        };
        const onAbort = () => settle({ admission: 'unknown' });
        const onAccepted: ManagedAgentOperationObserver['onAccepted'] = (
          admission,
        ) => {
          if (
            !isCurrent(source) ||
            admission.sessionId !== source.sessionId ||
            !admission.operationId
          ) {
            settle({ admission: 'unknown' });
            return;
          }
          settle({
            admission: 'accepted',
            operationId: admission.operationId,
          });
        };
        const onSettlement: ManagedAgentOperationObserver['onSettlement'] = (
          settlement,
        ) => {
          observeOperation(source, settlement, source.sessionId, () =>
            facts(source).retryPending(),
          );
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (!isCurrent(source)) {
          settle({ admission: 'unknown' });
          return;
        }
        const reader = source.provider.actions;
        if (!reader) {
          settle({ admission: 'unknown' });
          return;
        }
        let submission: Promise<void>;
        try {
          submission = reader.respond(action, response, {
            clientId: source.clientId,
            idempotencyKey,
            signal,
            onAccepted,
            onSettlement,
          });
        } catch (error) {
          settle(admissionFromError(error));
          return;
        }
        void submission.then(
          () => settle({ admission: 'unknown' }),
          (error) => settle(admissionFromError(error)),
        );
      }),
    [facts, isCurrent, observeOperation],
  );

  const findAction = useCallback(
    (candidate: BindingOwner, actionId: string) =>
      facts(candidate).pendingActions.find(
        (action) =>
          action.sessionId === candidate.sessionId &&
          action.actionId === actionId,
      ),
    [facts],
  );
  const { cancelObserver, runCancelTurn } = useManagedCancelBinding(
    owner,
    isCurrent,
    observeOperation,
  );
  const turnCancel = useManagedTurnCancel(
    provider,
    clientId,
    sessionId,
    summary,
    true,
    detail.refreshSummary,
    cancelObserver,
  );
  const turnCancelRef = useRef(turnCancel);
  turnCancelRef.current = turnCancel;
  const cancelTurn = useCallback(
    (
      source: BindingOwner,
      turnId: string,
    ): Promise<ManagedTransportAdmission> =>
      runCancelTurn(
        source,
        turnId,
        facts(source).summary?.capabilities.canCancel === true,
        false,
        () => turnCancelRef.current.request(),
      ),
    [facts, runCancelTurn],
  );

  const bound = useMemo(() => {
    const boundSessionId = owner.sessionId;
    if (!hasSummary || !boundSessionId) return undefined;
    let onOperation: ((event: ManagedOperationSettlement) => void) | undefined;
    let onTurn: ((event: ManagedTurnSettlement) => void) | undefined;
    const controller = createManagedChatController({
      sessionId: boundSessionId,
      storageKey:
        getComposerDraftStorageKey(
          undefined,
          `managed:${owner.provider.storageKey}:${boundSessionId}`,
        ) ?? '',
      get activeTurnId() {
        return facts(owner).summary?.activeTurnId;
      },
      get sessionPhase() {
        return facts(owner).summary?.phase ?? 'created';
      },
      get messages() {
        return facts(owner).messages;
      },
      get transcriptState() {
        const current = facts(owner);
        if (current.detail.stoppedLeg) return 'error';
        if (current.detail.loading) return 'loading';
        return 'ready';
      },
      get hasOlderHistory() {
        return facts(owner).detail.olderCursor !== undefined;
      },
      get loadingOlderHistory() {
        return facts(owner).detail.loadingOlder;
      },
      get historyCapacityReached() {
        return undefined;
      },
      get historyPaginationError() {
        return undefined;
      },
      loadOlder: () => facts(owner).detail.loadOlder(),
      get pendingActions() {
        return facts(owner).pendingActions;
      },
      get statusFacts() {
        return { queueLength: 0, goalActive: false };
      },
      get capabilities() {
        return managedCapabilitiesFromSummary(
          facts(owner).summary?.capabilities,
        );
      },
      async submitPrompt(input: ComposerSubmit) {
        const current = facts(owner).summary;
        if (!isCurrent(owner) || current?.capabilities.canSend !== true) {
          return { admission: 'rejected' };
        }
        let encoded;
        try {
          encoded = await encodeManagedInput(
            input.text,
            input.images,
            input.files,
          );
        } catch {
          return { admission: 'rejected' };
        }
        if (!isCurrent(owner)) {
          return { admission: 'rejected' };
        }
        try {
          const admission = await owner.provider.submitPrompt(
            boundSessionId,
            {
              text: input.text,
              ...(encoded.some(
                (block) =>
                  block.type !== 'input_text' || block.text !== input.text,
              )
                ? { input: encoded }
                : {}),
            },
            {
              clientId: owner.clientId,
              idempotencyKey: managedRequestId(),
              signal: owner.abort.signal,
            },
          );
          if (
            !isCurrent(owner) ||
            admission.sessionId !== boundSessionId ||
            !admission.turnId ||
            !admission.operationId
          ) {
            return { admission: 'unknown' };
          }
          // Advisory refresh: the session poll loop owns recovery, and a
          // failed or aborted read must not escape as an unhandled rejection.
          void facts(owner)
            .detail.refreshSummary()
            .catch(() => undefined);
          return {
            admission: 'accepted',
            turnId: admission.turnId,
            operationId: admission.operationId,
          };
        } catch (error) {
          return admissionFromError(error);
        }
      },
      cancelTurn: (turnId) => cancelTurn(owner, turnId),
      submitApproval: (actionId, optionId) => {
        const action = findAction(owner, actionId);
        if (!action || action.kind === 'question')
          return Promise.resolve({ admission: 'rejected' });
        return sendResponse(owner, action, optionId, `${actionId}:${optionId}`);
      },
      submitQuestion: (actionId, answers) => {
        const action = findAction(owner, actionId);
        if (!action || action.kind !== 'question')
          return Promise.resolve({ admission: 'rejected' });
        let canonical;
        try {
          canonical = canonicalQuestionAnswers(action, answers);
        } catch {
          return Promise.resolve({ admission: 'rejected' });
        }
        return sendResponse(
          owner,
          action,
          { kind: 'question', answers: canonical },
          questionResponseKey(action, canonical),
        );
      },
      subscribeOperationSettlement(listener) {
        onOperation = listener;
        return () => {
          if (onOperation === listener) onOperation = undefined;
        };
      },
      subscribeTurnSettlement(listener) {
        onTurn = listener;
        return () => {
          if (onTurn === listener) onTurn = undefined;
        };
      },
    });
    return { controller, onOperation, onTurn };
  }, [
    cancelTurn,
    facts,
    findAction,
    hasSummary,
    isCurrent,
    owner,
    sendResponse,
  ]);

  useBindControllerSettlements(
    owner,
    bound,
    detail,
    hasSummary,
    isCurrent,
    render,
  );

  return bound?.controller;
}

interface SharedBindingFacts {
  readonly summary: ManagedAgentSessionSummary | undefined;
  readonly detail: ReturnType<typeof useManagedSession>;
  readonly pending: ReturnType<typeof useManagedActions>;
  readonly turnCancel: ReturnType<typeof useManagedTurnCancel>;
  readonly selectedAction: ManagedAgentPendingAction | undefined;
  readonly selectedActions: readonly ManagedAgentPendingAction[];
  readonly messages: readonly Message[];
  readonly retainExpiredActions: boolean;
  readonly canRespondAction?: () => boolean;
  readonly canCancel: boolean;
}

/**
 * Binds an already-mounted set of Managed session hooks (`useManagedSession`,
 * `useManagedActions`, `useManagedTurnCancel`) to {@link SessionChatController}
 * without opening duplicate SSE streams or polling loops.
 */
export function useManagedChatControllerFromState({
  provider,
  clientId,
  sessionId,
  detail,
  pending,
  turnCancel,
  cancelObserverRef,
  messages,
  selectedAction,
  retainExpiredActions = false,
  canRespondAction,
  canCancel = true,
}: ManagedChatControllerFromStateOptions): SessionChatController {
  const { owner, isCurrent, render } = useBindingOwner(
    provider,
    clientId,
    sessionId,
  );
  const summary =
    detail.summary?.sessionId === sessionId ? detail.summary : undefined;
  const selectedActions = useMemo(
    () => (selectedAction ? [selectedAction] : []),
    [selectedAction],
  );
  const factsRef = useRef(new WeakMap<BindingOwner, SharedBindingFacts>());
  factsRef.current.set(owner, {
    summary,
    detail,
    pending,
    turnCancel,
    selectedAction,
    selectedActions,
    messages,
    retainExpiredActions,
    canRespondAction,
    canCancel,
  });
  const facts = useCallback(
    (candidate: BindingOwner) => factsRef.current.get(candidate)!,
    [],
  );

  const observeOperation = useObserveManagedOperation(isCurrent, render);

  const sendManagedActionResponse = useCallback(
    (
      source: BindingOwner,
      action: ManagedAgentPendingAction,
      response: ManagedAgentActionResponse,
    ): Promise<ManagedTransportAdmission> =>
      new Promise((resolve) => {
        const currentFacts = facts(source);
        if (
          !isCurrent(source) ||
          (currentFacts.canRespondAction && !currentFacts.canRespondAction())
        ) {
          resolve({ admission: 'rejected' });
          return;
        }
        const signal = source.abort.signal;
        let settled = false;
        const settle = (admission: ManagedTransportAdmission) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve(isCurrent(source) ? admission : { admission: 'unknown' });
        };
        const onAbort = () => settle({ admission: 'unknown' });
        const onAccepted: ManagedAgentOperationObserver['onAccepted'] = (
          admission,
        ) => {
          if (
            !isCurrent(source) ||
            admission.sessionId !== action.sessionId ||
            !admission.operationId
          ) {
            settle({ admission: 'unknown' });
            return;
          }
          settle({
            admission: 'accepted',
            operationId: admission.operationId,
          });
        };
        const onSettlement: ManagedAgentOperationObserver['onSettlement'] = (
          settlement,
        ) => {
          observeOperation(source, settlement, action.sessionId);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        void currentFacts.pending
          .respond(action, response, { onAccepted, onSettlement, signal })
          .then(
            (outcome) =>
              // Without `onAccepted`, a completed send carries no backend
              // `operationId` and could never settle if recorded as accepted,
              // so match the standalone rule (`unknown`) while keeping
              // pre-send skips and terminal `ended` refusals `rejected`.
              settle({
                admission: outcome === 'responded' ? 'unknown' : 'rejected',
              }),
            (error) => settle(admissionFromError(error)),
          );
      }),
    [facts, isCurrent, observeOperation],
  );

  const { cancelObserver, runCancelTurn } = useManagedCancelBinding(
    owner,
    isCurrent,
    observeOperation,
  );

  useEffect(() => {
    cancelObserverRef.current = cancelObserver;
    return () => {
      if (cancelObserverRef.current === cancelObserver) {
        cancelObserverRef.current = undefined;
      }
    };
  }, [cancelObserver, cancelObserverRef]);

  const cancelTurn = useCallback(
    (
      source: BindingOwner,
      turnId: string,
    ): Promise<ManagedTransportAdmission> => {
      const currentFacts = facts(source);
      return runCancelTurn(
        source,
        turnId,
        currentFacts.canCancel &&
          currentFacts.summary?.capabilities.canCancel === true,
        currentFacts.turnCancel.busy,
        () => currentFacts.turnCancel.request(),
      );
    },
    [facts, runCancelTurn],
  );

  const bound = useMemo(() => {
    const boundSessionId = owner.sessionId ?? '';
    let onOperation: ((event: ManagedOperationSettlement) => void) | undefined;
    let onTurn: ((event: ManagedTurnSettlement) => void) | undefined;
    const controller = createManagedChatController({
      sessionId: boundSessionId,
      storageKey:
        getComposerDraftStorageKey(
          undefined,
          `managed:${owner.provider.storageKey}:${owner.sessionId ?? 'new'}`,
        ) ?? '',
      get activeTurnId() {
        return facts(owner).summary?.activeTurnId;
      },
      get sessionPhase() {
        return facts(owner).summary?.phase ?? 'created';
      },
      get messages() {
        return facts(owner).messages;
      },
      get transcriptState() {
        return facts(owner).detail.loading ? 'loading' : 'ready';
      },
      get hasOlderHistory() {
        return facts(owner).detail.olderCursor !== undefined;
      },
      get loadingOlderHistory() {
        return facts(owner).detail.loadingOlder;
      },
      get historyCapacityReached() {
        return undefined;
      },
      get historyPaginationError() {
        return undefined;
      },
      loadOlder: () => facts(owner).detail.loadOlder(),
      get pendingActions() {
        return facts(owner).selectedActions;
      },
      get retainExpiredActions() {
        return facts(owner).retainExpiredActions;
      },
      get statusFacts() {
        return { queueLength: 0, goalActive: false };
      },
      get capabilities() {
        return managedCapabilitiesFromSummary(
          facts(owner).summary?.capabilities,
        );
      },
      // Host submission owns durable outbox/slash/queue orchestration via
      // ChatSurface.onComposerSubmit until outbox convergence lands.
      submitPrompt: () => Promise.resolve({ admission: 'rejected' }),
      cancelTurn: (turnId) => cancelTurn(owner, turnId),
      submitApproval: (actionId, optionId) => {
        const action = facts(owner).selectedAction;
        if (
          !action ||
          action.actionId !== actionId ||
          action.kind === 'question'
        )
          return Promise.resolve({ admission: 'rejected' });
        return sendManagedActionResponse(owner, action, optionId);
      },
      submitQuestion: (actionId, answers) => {
        const action = facts(owner).selectedAction;
        if (
          !action ||
          action.actionId !== actionId ||
          action.kind !== 'question'
        ) {
          return Promise.resolve({ admission: 'rejected' });
        }
        return sendManagedActionResponse(owner, action, {
          kind: 'question',
          answers: [...answers],
        });
      },
      subscribeOperationSettlement(listener) {
        onOperation = listener;
        return () => {
          if (onOperation === listener) onOperation = undefined;
        };
      },
      subscribeTurnSettlement(listener) {
        onTurn = listener;
        return () => {
          if (onTurn === listener) onTurn = undefined;
        };
      },
    });
    return { controller, onOperation, onTurn };
  }, [cancelTurn, facts, owner, sendManagedActionResponse]);

  useBindControllerSettlements(
    owner,
    bound,
    detail,
    summary !== undefined,
    isCurrent,
    render,
  );

  return bound.controller;
}
