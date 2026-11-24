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
import { useManagedTurnCancel } from './use-managed-turn-cancel';

interface ManagedChatControllerOptions {
  readonly provider: ManagedAgentProvider;
  readonly clientId: string;
  readonly sessionId: string | undefined;
}

interface BindingOwner {
  readonly provider: ManagedAgentProvider;
  readonly clientId: string;
  readonly sessionId: string | undefined;
  readonly abort: AbortController;
  readonly projectMessages: ReturnType<typeof createManagedMessageProjector>;
}

interface BindingFacts {
  readonly summary: ManagedAgentSessionSummary | undefined;
  readonly detail: ReturnType<typeof useManagedSession>;
  readonly pendingActions: readonly ManagedAgentPendingAction[];
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

export function useManagedChatController({
  provider,
  clientId,
  sessionId,
}: ManagedChatControllerOptions): SessionChatController | undefined {
  const detail = useManagedSession(provider, clientId, sessionId);
  const { t } = useI18n();
  const [, render] = useReducer((value: number) => value + 1, 0);
  const owner = useMemo<BindingOwner>(
    () => ({
      provider,
      clientId,
      sessionId,
      abort: new AbortController(),
      projectMessages: createManagedMessageProjector(),
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
  const seenEventIdsRef = useRef(new Set<number>());
  const previousOwnerRef = useRef<BindingOwner | undefined>(undefined);
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
    messages,
  });
  const facts = useCallback(
    (candidate: BindingOwner) => factsRef.current.get(candidate)!,
    [],
  );
  const operationListenerRef = useRef<
    ((event: ManagedOperationSettlement) => void) | undefined
  >(undefined);
  const turnListenerRef = useRef<
    | ((event: {
        turnId: string;
        outcome: 'completed' | 'cancelled' | 'failed';
      }) => void)
    | undefined
  >(undefined);

  const observeOperation = useCallback(
    (candidate: BindingOwner, observation: ManagedAgentOperationSettlement) => {
      if (
        !isCurrent(candidate) ||
        observation.sessionId !== candidate.sessionId
      )
        return;
      if (
        observation.status !== 'completed' &&
        observation.status !== 'failed' &&
        observation.status !== 'cancelled' &&
        observation.status !== 'recovery_blocked'
      ) {
        return;
      }
      const listener = operationListenerRef.current;
      if (!listener) return;
      listener({
        operationId: observation.operationId,
        status: observation.status,
      });
      render();
    },
    [isCurrent],
  );

  const sendResponse = useCallback(
    (
      source: BindingOwner,
      action: ManagedAgentPendingAction,
      response: ManagedAgentActionResponse,
      idempotencyKey: string,
    ): Promise<ManagedTransportAdmission> =>
      new Promise((resolve) => {
        let settled = false;
        const settle = (admission: ManagedTransportAdmission) => {
          if (settled) return;
          settled = true;
          source.abort.signal.removeEventListener('abort', onAbort);
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
          observeOperation(source, settlement);
        };
        source.abort.signal.addEventListener('abort', onAbort, { once: true });
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
            signal: source.abort.signal,
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
    [isCurrent, observeOperation],
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
  const cancelResponseRef = useRef<
    | {
        owner: BindingOwner;
        turnId: string;
        resolve: (admission: ManagedTransportAdmission) => void;
      }
    | undefined
  >(undefined);
  const cancelObserver = useMemo(
    () => ({
      onAccepted: (admission: {
        operationId: string;
        sessionId: string;
        turnId?: string;
      }) => {
        const pending = cancelResponseRef.current;
        if (!pending || pending.owner !== owner || !isCurrent(owner)) return;
        if (
          admission.sessionId !== owner.sessionId ||
          (admission.turnId && admission.turnId !== pending.turnId) ||
          !admission.operationId
        ) {
          pending.resolve({ admission: 'unknown' });
          return;
        }
        pending.resolve({
          admission: 'accepted',
          operationId: admission.operationId,
        });
      },
      onSettlement: (settlement: ManagedAgentOperationSettlement) => {
        const pending = cancelResponseRef.current;
        if (
          pending &&
          pending.owner === owner &&
          isCurrent(owner) &&
          settlement.sessionId === owner.sessionId &&
          settlement.operationId &&
          (!settlement.turnId || settlement.turnId === pending.turnId)
        ) {
          pending.resolve({
            admission: 'accepted',
            operationId: settlement.operationId,
          });
        }
        observeOperation(owner, settlement);
      },
      onError: (error: unknown) => {
        const pending = cancelResponseRef.current;
        if (pending?.owner === owner) {
          pending.resolve(admissionFromError(error));
        }
      },
    }),
    [isCurrent, observeOperation, owner],
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
      new Promise((resolve) => {
        if (!isCurrent(source)) {
          resolve({ admission: 'unknown' });
          return;
        }
        if (facts(source).summary?.capabilities.canCancel !== true) {
          resolve({ admission: 'rejected' });
          return;
        }
        let settled = false;
        const settle = (admission: ManagedTransportAdmission) => {
          if (settled) return;
          settled = true;
          source.abort.signal.removeEventListener('abort', onAbort);
          cancelResponseRef.current = undefined;
          resolve(isCurrent(source) ? admission : { admission: 'unknown' });
        };
        const onAbort = () => settle({ admission: 'unknown' });
        source.abort.signal.addEventListener('abort', onAbort, { once: true });
        cancelResponseRef.current = {
          owner: source,
          turnId,
          resolve: settle,
        };
        void turnCancelRef.current.request().then(
          () => settle({ admission: 'unknown' }),
          (error) => settle(admissionFromError(error)),
        );
      }),
    [facts, isCurrent],
  );

  useEffect(() => () => owner.abort.abort(), [owner]);
  useEffect(() => {
    if (previousOwnerRef.current !== owner || !hasSummary) {
      previousOwnerRef.current = owner;
      seenEventIdsRef.current = new Set(detail.events.map((event) => event.id));
      return;
    }
    for (const event of detail.events) {
      if (seenEventIdsRef.current.has(event.id)) continue;
      seenEventIdsRef.current.add(event.id);
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
      const listener = turnListenerRef.current;
      if (!listener) continue;
      listener({ turnId: event.turnId, outcome: event.type });
      render();
    }
  }, [detail.events, hasSummary, isCurrent, owner]);

  return useMemo(() => {
    const boundSessionId = owner.sessionId;
    if (!hasSummary || !boundSessionId || !isCurrent(owner)) return undefined;
    return createManagedChatController({
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
        if (!current.summary && current.detail.loading) return 'loading';
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
      signal: owner.abort.signal,
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
          return Promise.resolve({ admission: 'unknown' });
        return sendResponse(owner, action, optionId, `${actionId}:${optionId}`);
      },
      submitQuestion: (actionId, answers) => {
        const action = findAction(owner, actionId);
        if (!action || action.kind !== 'question')
          return Promise.resolve({ admission: 'unknown' });
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
        operationListenerRef.current = listener;
        return () => {
          if (operationListenerRef.current === listener)
            operationListenerRef.current = undefined;
        };
      },
      subscribeTurnSettlement(listener) {
        turnListenerRef.current = listener;
        return () => {
          if (turnListenerRef.current === listener)
            turnListenerRef.current = undefined;
        };
      },
    });
  }, [
    cancelTurn,
    facts,
    findAction,
    hasSummary,
    isCurrent,
    owner,
    sendResponse,
  ]);
}
