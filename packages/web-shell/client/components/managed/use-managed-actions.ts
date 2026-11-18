import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ManagedAgentPendingAction,
  ManagedAgentActionResponse,
  ManagedAgentProvider,
  ManagedAgentSessionEvent,
} from './managed-agent-provider';
import { isNonRetryableClientError } from './managed-request-error';
import type { ManagedQuestionDraft } from './ManagedQuestionForm';
import {
  canonicalQuestionAnswers,
  questionResponseKey,
} from './managed-question-response';

// Re-reads shortly after the earliest expiry so an unanswered approval leaves
// the page once the Harness has ended it.
const EXPIRY_GRACE_MS = 1_000;
// A failed read of the pending approvals is retried a few times, so one
// transient failure does not hide an approval until it expires.
const LOAD_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];
// The contract's codes for an Action that already ended: it expired, was
// cancelled, or was answered elsewhere. Retrying the answer cannot succeed.
// `action_response_delivery_failed` is deliberately absent: the service
// re-admits a retried click whose Action is still requested, so a retry
// after a delivery failure can succeed and the card must stay retryable.
// `action_response_decision_expired` is absent too, although no retry of it
// succeeds: the service records it while the Action is still requested, so
// the list keeps returning the Action and a hidden card would come straight
// back on the next read, only without the reason. The rejection keeps that
// reason on screen until the Action's end projects (review round 1, R1-2;
// the missing terminal signal is #14351).
const ENDED_ACTION_CODES: ReadonlySet<string> = new Set([
  'action_expired',
  'action_cancelled',
  'action_already_resolved',
]);

export function managedActionKey(action: ManagedAgentPendingAction): string {
  return JSON.stringify([
    action.sessionId,
    action.actionId,
    action.inputRevision,
    action.policyRevision,
  ]);
}

function actionSelectionKey(action: ManagedAgentPendingAction): string {
  return JSON.stringify([action.sessionId, action.actionId]);
}

const EMPTY_QUESTION_DRAFT: ManagedQuestionDraft = {};

function endedAction(failure: unknown): boolean {
  const code =
    typeof failure === 'object' && failure !== null && 'code' in failure
      ? (failure as { code?: unknown }).code
      : undefined;
  return typeof code === 'string' && ENDED_ACTION_CODES.has(code);
}

export interface ManagedActionsState {
  actions: readonly ManagedAgentPendingAction[];
  /** The selected pending request; answered ones stay hidden while they settle. */
  action?: ManagedAgentPendingAction;
  select(action: ManagedAgentPendingAction): void;
  questionDraft: ManagedQuestionDraft;
  setQuestionDraft(
    action: ManagedAgentPendingAction,
    draft: ManagedQuestionDraft,
  ): void;
  submitting: boolean;
  /** Reading the pending approvals failed; retries run in the background. */
  loadError?: unknown;
  /**
   * The pending approvals have been read for this Session, so a failed read is
   * a failed refresh of what the page already shows rather than an empty list.
   */
  loaded: boolean;
  /** Sending an answer failed; the approval is shown again. */
  answerError?: unknown;
  /**
   * The service refused an answer under the owner-or-Workspace-operator
   * rule. That refusal is a fact about the viewer's Workspace role row,
   * which an operator can raise while the page stays open, so the latch
   * covers every later approval the same Session raises and survives
   * leaving that Session and coming back — but `retry()` drops it and
   * re-probes instead of treating one 403 as permanent for the mount.
   */
  respondForbidden: boolean;
  respond(
    action: ManagedAgentPendingAction,
    response: ManagedAgentActionResponse,
  ): Promise<void>;
  /** Reads the pending approvals again now. */
  retry(): void;
}

/**
 * Loads a Session's pending Hosted approvals and answers them. It re-reads
 * when the transcript reports an approval change or a reconciled gap, when an
 * approval expires, and after an answer. `enabled` is undefined while the
 * Session summary is unknown, for example during a reload: the shown approval
 * stays and can be answered, and reads resume once the capability is known.
 */
export function useManagedActions(
  provider: ManagedAgentProvider,
  sessionId: string | undefined,
  clientId: string,
  enabled: boolean | undefined,
  events: readonly ManagedAgentSessionEvent[],
  includeChildren = false,
): ManagedActionsState {
  const reader = enabled === false ? undefined : provider.actions;
  const credentials = useMemo(
    () => ({ provider, clientId }),
    [provider, clientId],
  );
  const owner = useMemo(
    () => ({ credentials, sessionId }),
    [credentials, sessionId],
  );
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const changed = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  const [pending, setPending] = useState<{
    owner?: typeof owner;
    actions: ManagedAgentPendingAction[];
  }>({ actions: [] });
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const [loadError, setLoadError] = useState<unknown>();
  const [answerErrors, setAnswerErrors] = useState<
    ReadonlyMap<string, unknown>
  >(new Map());
  const [drafts, setDrafts] = useState<
    ReadonlyMap<string, ManagedQuestionDraft>
  >(new Map());
  const [selection, setSelection] = useState<{
    owner: typeof owner;
    key: string;
  }>();
  const [submitting, setSubmitting] = useState<ReadonlySet<string>>(new Set());
  // The Sessions that refused this viewer under the owner-or-operator
  // rule, keyed by Session so that leaving a refused one and coming back
  // does not re-admit the 403 without an explicit retry.
  const [forbiddenSessions, setForbiddenSessions] = useState<
    ReadonlySet<string>
  >(new Set());
  const [revision, setRevision] = useState(0);
  const loadFailures = useRef(0);
  // Actions hidden because the service reported them ended when answered. A
  // read that still lists one shows it again, so a wrong report cannot hide
  // an approvable Action.
  const endedAnswers = useRef(new Set<string>());
  const inFlight = useRef(new Map<string, typeof owner>());
  const trigger = useMemo(() => {
    let last = 0;
    for (const event of events) {
      if (event.type === 'action_updated' || event.type === 'stream_gap') {
        last = event.id;
      }
    }
    return last;
  }, [events]);

  useEffect(() => {
    setAnswered(new Set());
    setLoadError(undefined);
    setAnswerErrors(new Map());
    setDrafts(new Map());
    setSelection(undefined);
    setSubmitting(new Set());
    loadFailures.current = 0;
    endedAnswers.current.clear();
  }, [owner]);

  useEffect(() => {
    setForbiddenSessions(new Set());
  }, [credentials]);

  useEffect(() => {
    if (!reader || !sessionId) {
      setPending({ actions: [] });
      // A withdrawn reader is not a failed read: a restored reader gets the
      // whole retry budget back instead of a single attempt with no ladder.
      loadFailures.current = 0;
      return undefined;
    }
    if (includeChildren && !visible) return undefined;
    if (enabled === undefined) {
      // So is a reload, which is how a user retries from the page: the
      // reader comes back with the same Session and a fresh retry budget.
      loadFailures.current = 0;
      return undefined;
    }
    const abort = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    reader
      .listPending(sessionId, {
        clientId,
        signal: abort.signal,
        ...(includeChildren ? { includeChildren: true } : {}),
      })
      .then((actions) => {
        if (abort.signal.aborted || ownerRef.current !== owner) return;
        loadFailures.current = 0;
        setPending({ owner, actions });
        setLoadError(undefined);
        const stillListed = actions
          .map(managedActionKey)
          .filter((id) => endedAnswers.current.has(id));
        endedAnswers.current.clear();
        if (stillListed.length > 0) {
          setAnswered((current) => {
            const next = new Set(current);
            for (const id of stillListed) next.delete(id);
            return next;
          });
        }
        const listed = new Set(actions.map(managedActionKey));
        setAnswerErrors(
          (current) => new Map([...current].filter(([key]) => listed.has(key))),
        );
        setDrafts(
          (current) => new Map([...current].filter(([key]) => listed.has(key))),
        );
        if (includeChildren) {
          retryTimer = setTimeout(
            () => setRevision((value) => value + 1),
            3_000,
          );
        }
      })
      .catch((failure: unknown) => {
        if (abort.signal.aborted || ownerRef.current !== owner) return;
        setLoadError(failure);
        // A 4xx the service will answer the same way every time is not a
        // hiccup: retrying it only burns requests, and the Retry button would
        // keep offering an attempt that cannot succeed. Timeouts and rate
        // limits still back off as before.
        if (isNonRetryableClientError(failure)) return;
        const delay =
          LOAD_RETRY_DELAYS_MS[loadFailures.current] ??
          (includeChildren ? 10_000 : undefined);
        loadFailures.current += 1;
        if (delay !== undefined) {
          retryTimer = setTimeout(
            () => setRevision((value) => value + 1),
            delay,
          );
        }
      });
    return () => {
      abort.abort();
      clearTimeout(retryTimer);
    };
  }, [
    reader,
    enabled,
    sessionId,
    clientId,
    trigger,
    revision,
    owner,
    includeChildren,
    visible,
  ]);

  const earliestExpiry = pending.actions.length
    ? Math.min(...pending.actions.map((action) => action.expiresAt))
    : undefined;
  useEffect(() => {
    if (earliestExpiry === undefined) return undefined;
    const timer = setTimeout(
      () => setRevision((value) => value + 1),
      Math.max(0, earliestExpiry - Date.now()) + EXPIRY_GRACE_MS,
    );
    return () => clearTimeout(timer);
  }, [earliestExpiry]);

  const actions = useMemo(
    () => (pending.owner === owner ? pending.actions : []),
    [pending.owner, pending.actions, owner],
  );
  // `pending.owner` is set by the success branch of a read only.
  const loaded = pending.owner === owner;
  const available = useMemo(
    () =>
      actions
        .filter((entry) => !answered.has(managedActionKey(entry)))
        .sort(
          (left, right) =>
            (left.createdAt ?? Number.MAX_SAFE_INTEGER) -
              (right.createdAt ?? Number.MAX_SAFE_INTEGER) ||
            left.sessionId.localeCompare(right.sessionId) ||
            left.actionId.localeCompare(right.actionId),
        ),
    [actions, answered],
  );
  const action =
    available.find(
      (entry) =>
        selection?.owner === owner &&
        actionSelectionKey(entry) === selection.key,
    ) ?? available[0];
  const selectedKey = action && managedActionKey(action);
  const selectedIdentity = action && actionSelectionKey(action);
  useEffect(() => {
    if (
      selectedIdentity &&
      (selection?.owner !== owner || selection.key !== selectedIdentity)
    )
      setSelection({ owner, key: selectedIdentity });
  }, [owner, selectedIdentity, selection]);
  const current = useRef({ owner, actions, answered, reader });
  current.current = { owner, actions, answered, reader };

  const select = useCallback(
    (target: ManagedAgentPendingAction) => {
      const key = managedActionKey(target);
      if (
        current.current.owner === owner &&
        !current.current.answered.has(key) &&
        current.current.actions.some((entry) => managedActionKey(entry) === key)
      )
        setSelection({ owner, key: actionSelectionKey(target) });
    },
    [owner],
  );

  const setQuestionDraft = useCallback(
    (target: ManagedAgentPendingAction, draft: ManagedQuestionDraft) => {
      const key = managedActionKey(target);
      if (
        current.current.owner === owner &&
        !current.current.answered.has(key) &&
        current.current.actions.some(
          (entry) =>
            entry.kind === 'question' && managedActionKey(entry) === key,
        )
      )
        setDrafts((current) => new Map(current).set(key, draft));
    },
    [owner],
  );

  const respond = useCallback(
    async (
      requested: ManagedAgentPendingAction,
      response: ManagedAgentActionResponse,
    ) => {
      if (current.current.owner !== owner) return;
      const key = managedActionKey(requested);
      const target = current.current.actions.find(
        (entry) =>
          managedActionKey(entry) === key && !current.current.answered.has(key),
      );
      const actionReader = current.current.reader;
      if (!target || !actionReader) return;
      if (inFlight.current.get(key) === owner) return;
      inFlight.current.set(key, owner);
      setSubmitting((current) => new Set(current).add(key));
      const isPending = () =>
        current.current.owner === owner &&
        current.current.actions.some(
          (entry) => managedActionKey(entry) === key,
        );
      if (target.kind !== 'question')
        setAnswered((current) => new Set(current).add(key));
      try {
        if ((target.kind === 'question') !== (typeof response !== 'string')) {
          throw new Error('Action response kind does not match the request');
        }
        const submitted =
          target.kind === 'question' && typeof response !== 'string'
            ? {
                kind: 'question' as const,
                answers: canonicalQuestionAnswers(target, response.answers),
              }
            : response;
        const idempotencyKey =
          target.kind === 'question' && typeof submitted !== 'string'
            ? await questionResponseKey(target, submitted.answers)
            : `${target.actionId}:${submitted}`;
        if (!isPending()) return;
        await actionReader.respond(target, submitted, {
          clientId,
          idempotencyKey,
        });
        if (!isPending()) return;
        setAnswered((current) => new Set(current).add(key));
        setAnswerErrors((current) => {
          const next = new Map(current);
          next.delete(key);
          return next;
        });
        setDrafts((current) => {
          const next = new Map(current);
          next.delete(key);
          return next;
        });
        setRevision((value) => value + 1);
      } catch (failure) {
        if (
          typeof failure === 'object' &&
          failure !== null &&
          'code' in failure &&
          (failure as { code?: unknown }).code === 'action_forbidden' &&
          ownerRef.current.credentials === credentials
        ) {
          // Responding requires the Session's owner or a Workspace operator,
          // which the service decides from the viewer's Workspace role row
          // rather than the Action, and it checks that row before it checks
          // that the Action still exists. So the refusal is recorded even
          // when a re-read has already dropped the refused Action, and it
          // covers every later approval of the Session the answer was aimed
          // at — not the one now selected.
          setForbiddenSessions((current) =>
            new Set(current).add(target.sessionId),
          );
        }
        if (!isPending()) throw failure;
        if (endedAction(failure)) {
          // No retry can succeed, so keep the card hidden and read the list
          // again instead of offering an answer the service will refuse.
          endedAnswers.current.add(key);
          setAnswered((current) => new Set(current).add(key));
          setAnswerErrors((current) => {
            const next = new Map(current);
            next.delete(key);
            return next;
          });
          setDrafts((current) => {
            const next = new Map(current);
            next.delete(key);
            return next;
          });
          setRevision((value) => value + 1);
          return;
        }
        setAnswered((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
        setAnswerErrors((current) => new Map(current).set(key, failure));
        throw failure;
      } finally {
        if (inFlight.current.get(key) === owner) inFlight.current.delete(key);
        if (ownerRef.current === owner)
          setSubmitting((current) => {
            const next = new Set(current);
            next.delete(key);
            return next;
          });
      }
    },
    [clientId, owner, credentials],
  );

  const retry = useCallback(() => {
    loadFailures.current = 0;
    // One explicit retry re-probes every refusal latched this mount: the
    // role row each of them was decided from can be raised while the page
    // stays open, and the refused Session is not necessarily the selected
    // one.
    setForbiddenSessions((current) =>
      current.size === 0 ? current : new Set(),
    );
    setRevision((value) => value + 1);
  }, []);

  return {
    actions: available,
    action,
    select,
    questionDraft: selectedKey
      ? (drafts.get(selectedKey) ?? EMPTY_QUESTION_DRAFT)
      : EMPTY_QUESTION_DRAFT,
    setQuestionDraft,
    submitting: selectedKey !== undefined && submitting.has(selectedKey),
    loadError,
    loaded,
    answerError: selectedKey ? answerErrors.get(selectedKey) : undefined,
    respondForbidden: includeChildren
      ? action !== undefined && forbiddenSessions.has(action.sessionId)
      : sessionId !== undefined && forbiddenSessions.has(sessionId),
    respond,
    retry,
  };
}
