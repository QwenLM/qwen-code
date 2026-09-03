import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  DaemonHttpError,
  isSessionLevelNotFound,
  isSubagentSessionNotFound,
  type DaemonTranscriptBlock,
  type DaemonTranscriptBlockChangeSummary,
} from '@qwen-code/sdk/daemon';
import {
  useConnection,
  useTranscriptBlocks,
  useWorkspace,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { transcriptBlocksToDaemonMessages } from '../adapters/transcriptToMessages';
import type { Message } from '../adapters/types';
import {
  isActiveToolStatus,
  isBackgroundSubAgentToolCall,
  isTerminalBackgroundAgentStatus,
  projectTerminalBackgroundAgentTool,
} from '../adapters/toolClassification';

type Translator = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

const BACKGROUND_AGENT_RECONCILIATION_RETRY_BASE_MS = 3_000;
const BACKGROUND_AGENT_RECONCILIATION_RETRY_MAX_MS = 60_000;
// Cap on consecutive transient-error rounds for one pending agent. An agent
// whose own error count reaches the cap is marked failed so the UI unblocks,
// while healthy siblings keep polling. Healthy non-terminal responses back
// off on the same delay ladder but do not consume this budget, so a
// long-running agent's completion query keeps its retry tolerance.
const BACKGROUND_AGENT_RECONCILIATION_MAX_ATTEMPTS = 8;
// The daemon registers a launched background task shortly after the tool
// call appears in the transcript, so a first `session_not_found` can race
// registration. Require repeated misses before treating the agent as gone.
const MISSING_BACKGROUND_AGENT_GRACE_MISSES = 2;
// Insight JSON can split one growing text block into multiple projected
// messages, so the tail needs a full projection once its marker appears.
const INSIGHT_CONTENT_MARKER = '"insight_';

interface MessageProjection {
  blocks: readonly DaemonTranscriptBlock[];
  messages: Message[];
  t: Translator;
  blockChangeSummary?: DaemonTranscriptBlockChangeSummary;
}

export interface BackgroundAgentResolution {
  status: string;
  durationMs?: number;
}

interface CommittedMessageProjection extends MessageProjection {
  connectionSessionId?: string;
  resolutionSessionId?: string;
  resolutions?: ReadonlyMap<string, BackgroundAgentResolution>;
}

interface ReconciliationRound {
  resolutions: Map<string, BackgroundAgentResolution>;
  errors: ReadonlyArray<{ callId: string; error: unknown }>;
  notFounds: ReadonlyArray<string>;
  succeeded: ReadonlyArray<string>;
}

export function transcriptBlocksToLocalizedMessages(
  blocks: readonly DaemonTranscriptBlock[],
  t: Translator,
): Message[] {
  return transcriptBlocksToDaemonMessages(blocks, {
    labels: {
      promptCancelled: t('request.cancelled'),
      branchSuccess: (name) => t('branch.success', { name }),
      modelStreamInterrupted: t('error.modelStreamInterrupted'),
      loopDetected: t('error.loopDetected'),
    },
  });
}

function reuseUnchangedProjectedPrefix(
  previous: MessageProjection | undefined,
  blocks: readonly DaemonTranscriptBlock[],
  messages: Message[],
  t: Translator,
): Message[] {
  if (
    !previous ||
    previous.t !== t ||
    previous.blocks.length !== blocks.length ||
    previous.messages.length !== messages.length ||
    messages.length === 0 ||
    blocks.length === 0
  ) {
    return messages;
  }
  for (let i = 0; i < blocks.length - 1; i += 1) {
    if (previous.blocks[i] !== blocks[i]) return messages;
  }
  const before = previous.blocks[blocks.length - 1];
  const after = blocks[blocks.length - 1];
  if (
    (before.kind !== 'assistant' && before.kind !== 'thought') ||
    after.kind !== before.kind ||
    before.id !== after.id ||
    before.streaming !== true ||
    after.streaming !== true ||
    before.parentToolCallId !== undefined ||
    after.parentToolCallId !== undefined ||
    before.meta !== after.meta ||
    before.usage !== after.usage ||
    before.branchRecordId !== after.branchRecordId ||
    before.clientReceivedAt !== after.clientReceivedAt ||
    typeof before.text !== 'string' ||
    typeof after.text !== 'string' ||
    !after.text.startsWith(before.text) ||
    after.text.includes(INSIGHT_CONTENT_MARKER)
  ) {
    return messages;
  }
  for (let i = 0; i < messages.length - 1; i += 1) {
    const previousMessage = previous.messages[i];
    const message = messages[i];
    if (
      previousMessage.id !== message.id ||
      previousMessage.role !== message.role
    ) {
      return messages;
    }
  }
  const previousTail = previous.messages[previous.messages.length - 1];
  const tail = messages[messages.length - 1];
  if (
    previousTail.id !== tail.id ||
    previousTail.role !== tail.role ||
    (tail.role !== 'assistant' && tail.role !== 'thinking') ||
    tail.isStreaming !== true
  ) {
    return messages;
  }
  const result = messages.slice();
  for (let i = 0; i < result.length - 1; i += 1) {
    result[i] = previous.messages[i];
  }
  return result;
}

export function projectStreamingTailMessages(
  previous: MessageProjection | undefined,
  blocks: readonly DaemonTranscriptBlock[],
  t: Translator,
  blockChangeSummary?: DaemonTranscriptBlockChangeSummary,
): Message[] | undefined {
  if (
    !previous ||
    previous.t !== t ||
    previous.blocks.length !== blocks.length ||
    blocks.length === 0 ||
    previous.messages.length === 0
  ) {
    return undefined;
  }

  const previousSummary = previous.blockChangeSummary;
  let summaryProvesTailAppend = false;
  if (previousSummary && blockChangeSummary) {
    if (
      blockChangeSummary.source !== previousSummary.source ||
      blockChangeSummary.revision <= previousSummary.revision ||
      blockChangeSummary.tailAppendBarrierRevision !==
        previousSummary.tailAppendBarrierRevision
    ) {
      return undefined;
    }
    summaryProvesTailAppend = true;
  } else {
    for (let i = 0; i < blocks.length - 1; i += 1) {
      if (previous.blocks[i] !== blocks[i]) return undefined;
    }
  }

  const before = previous.blocks[blocks.length - 1];
  const after = blocks[blocks.length - 1];
  const previousTail = previous.messages[previous.messages.length - 1];
  if (
    (before.kind !== 'assistant' && before.kind !== 'thought') ||
    after.kind !== before.kind ||
    before.id !== after.id ||
    (blockChangeSummary !== undefined &&
      after.id !== blockChangeSummary.tailBlockId) ||
    before.streaming !== true ||
    after.streaming !== true ||
    before.parentToolCallId !== undefined ||
    after.parentToolCallId !== undefined ||
    before.meta !== after.meta ||
    before.usage !== after.usage ||
    before.branchRecordId !== after.branchRecordId ||
    before.clientReceivedAt !== after.clientReceivedAt ||
    before.promptId !== after.promptId ||
    before.sourceRecordIds !== after.sourceRecordIds ||
    typeof before.text !== 'string' ||
    typeof after.text !== 'string' ||
    after.text.length < before.text.length ||
    (!summaryProvesTailAppend && !after.text.startsWith(before.text))
  ) {
    return undefined;
  }

  if (after.text.includes(INSIGHT_CONTENT_MARKER)) {
    const tailPrefix = `${before.id}-`;
    const firstTailMessageIndex = previous.messages.findIndex(
      (message) =>
        message.id === before.id || message.id.startsWith(tailPrefix),
    );
    if (firstTailMessageIndex < 0) return undefined;
    const messages = transcriptBlocksToLocalizedMessages(blocks, t);
    for (let i = 0; i < firstTailMessageIndex; i += 1) {
      if (
        messages[i]?.id !== previous.messages[i]?.id ||
        messages[i]?.role !== previous.messages[i]?.role
      ) {
        break;
      }
      messages[i] = previous.messages[i];
    }
    return messages;
  }

  if (
    (previousTail.role !== 'assistant' && previousTail.role !== 'thinking') ||
    previousTail.isStreaming !== true ||
    (after.kind === 'assistant') !== (previousTail.role === 'assistant')
  ) {
    return undefined;
  }

  const messages = previous.messages.slice();
  const appendedText = after.text.slice(before.text.length);
  messages[messages.length - 1] = {
    ...previousTail,
    content: previousTail.content + appendedText,
    isStreaming: true,
    ...(previousTail.id === after.id
      ? { timestamp: after.serverTimestamp ?? after.clientReceivedAt }
      : {}),
  };
  return messages;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function describeReconciliationError(error: unknown): string {
  if (error instanceof DaemonHttpError) {
    const code = getRecord(error.body)?.['code'];
    return typeof code === 'string'
      ? `HTTP ${error.status} ${code}`
      : `HTTP ${error.status}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export function getBackgroundAgentNotificationKey(
  blocks: readonly DaemonTranscriptBlock[],
): string {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.kind !== 'assistant') continue;
    const meta = getRecord(block.meta);
    const task = getRecord(meta?.['backgroundTask']);
    const status = task?.['status'];
    if (
      meta?.['source'] === 'background_notification' &&
      task?.['kind'] === 'agent' &&
      typeof status === 'string' &&
      isTerminalBackgroundAgentStatus(status)
    ) {
      return `${block.id}:${status}`;
    }
  }
  return '';
}

export function getPendingBackgroundAgentKey(
  messages: readonly Message[],
): string {
  const callIds: string[] = [];
  for (const message of messages) {
    if (message.role !== 'tool_group') continue;
    for (const tool of message.tools) {
      if (
        isActiveToolStatus(tool.status) &&
        isBackgroundSubAgentToolCall(tool)
      ) {
        callIds.push(tool.callId);
      }
    }
  }
  return callIds.join('|');
}

type DaemonPermissionTranscriptBlock = Extract<
  DaemonTranscriptBlock,
  { kind: 'permission' }
>;

/**
 * CallIds whose permission request is still unanswered. Such an agent has not
 * spawned yet, so its subagent session legitimately does not exist and the
 * reconciliation 404 probe must not count toward the missing-agent grace.
 */
function getPendingPermissionCallIds(
  blocks: readonly DaemonTranscriptBlock[],
): Set<string> {
  const ids = new Set<string>();
  for (const block of blocks) {
    if (block.kind !== 'permission') continue;
    const perm = block as DaemonPermissionTranscriptBlock;
    if (perm.resolved) continue;
    const toolCall = getRecord(perm.toolCall);
    const callId =
      typeof toolCall?.['toolCallId'] === 'string'
        ? toolCall['toolCallId']
        : typeof toolCall?.['id'] === 'string'
          ? toolCall['id']
          : undefined;
    if (callId) ids.add(callId);
  }
  return ids;
}

export function reconcileBackgroundAgentResolutions(
  messages: Message[],
  resolutions: ReadonlyMap<string, BackgroundAgentResolution>,
): Message[] {
  if (resolutions.size === 0) return messages;

  let changed = false;
  const reconciled = messages.map((message): Message => {
    if (message.role !== 'tool_group') return message;
    let toolsChanged = false;
    const tools = message.tools.map((tool): (typeof message.tools)[number] => {
      const resolution = resolutions.get(tool.callId);
      if (
        !resolution ||
        !isTerminalBackgroundAgentStatus(resolution.status) ||
        !isActiveToolStatus(tool.status) ||
        !isBackgroundSubAgentToolCall(tool)
      ) {
        return tool;
      }
      const endTime =
        tool.startTime !== undefined
          ? tool.startTime + (resolution.durationMs ?? 0)
          : undefined;
      const reconciledTool = projectTerminalBackgroundAgentTool(
        tool,
        resolution.status,
        endTime,
      );
      if (reconciledTool === tool) return tool;
      toolsChanged = true;
      return reconciledTool;
    });
    if (!toolsChanged) return message;
    changed = true;
    return { ...message, tools };
  });
  return changed ? reconciled : messages;
}

export function useMessagesFromBlocks(
  t: Translator,
  blocks: readonly DaemonTranscriptBlock[],
  blockChangeSummary?: DaemonTranscriptBlockChangeSummary,
): Message[] {
  const workspace = useWorkspace();
  const connection = useConnection();
  const [resolutionSnapshot, setResolutionSnapshot] = useState<{
    sessionId: string;
    resolutions: ReadonlyMap<string, BackgroundAgentResolution>;
  }>();
  const previousProjectionRef = useRef<CommittedMessageProjection | undefined>(
    undefined,
  );
  const projection = useMemo(() => {
    const previous = previousProjectionRef.current;
    const streamingTailMessages = projectStreamingTailMessages(
      previous,
      blocks,
      t,
      blockChangeSummary,
    );
    return {
      previous,
      reusedStreamingTail: streamingTailMessages !== undefined,
      messages:
        streamingTailMessages ??
        reuseUnchangedProjectedPrefix(
          previous?.resolutions === undefined ? previous : undefined,
          blocks,
          transcriptBlocksToLocalizedMessages(blocks, t),
          t,
        ),
    };
  }, [blockChangeSummary, blocks, t]);
  const messages = projection.messages;
  const reconciledMessages = useMemo(() => {
    const previous = projection.previous;
    if (
      projection.reusedStreamingTail &&
      previous !== undefined &&
      previous.connectionSessionId === connection.sessionId &&
      previous.resolutionSessionId === resolutionSnapshot?.sessionId &&
      previous.resolutions === resolutionSnapshot?.resolutions
    ) {
      return messages;
    }
    if (
      !resolutionSnapshot ||
      resolutionSnapshot.sessionId !== connection.sessionId
    ) {
      return messages;
    }
    return reconcileBackgroundAgentResolutions(
      messages,
      resolutionSnapshot.resolutions,
    );
  }, [connection.sessionId, messages, projection, resolutionSnapshot]);
  useLayoutEffect(() => {
    previousProjectionRef.current = {
      blocks,
      messages: reconciledMessages,
      t,
      blockChangeSummary,
      connectionSessionId: connection.sessionId,
      resolutionSessionId: resolutionSnapshot?.sessionId,
      resolutions: resolutionSnapshot?.resolutions,
    };
  }, [
    blockChangeSummary,
    blocks,
    connection.sessionId,
    reconciledMessages,
    resolutionSnapshot,
    t,
  ]);
  const reconciliationKeysRef = useRef<
    | {
        source?: object;
        barrierRevision?: number;
        connectionSessionId?: string;
        resolutionSessionId?: string;
        resolutions?: ReadonlyMap<string, BackgroundAgentResolution>;
        pendingBackgroundAgentKey: string;
        pendingPermissionKey: string;
        backgroundAgentNotificationKey: string;
      }
    | undefined
  >(undefined);
  const cachedReconciliationKeys = reconciliationKeysRef.current;
  const canReuseReconciliationKeys =
    blockChangeSummary !== undefined &&
    cachedReconciliationKeys !== undefined &&
    cachedReconciliationKeys.source === blockChangeSummary.source &&
    cachedReconciliationKeys.barrierRevision ===
      blockChangeSummary.tailAppendBarrierRevision &&
    cachedReconciliationKeys.connectionSessionId === connection.sessionId &&
    cachedReconciliationKeys.resolutionSessionId ===
      resolutionSnapshot?.sessionId &&
    cachedReconciliationKeys.resolutions === resolutionSnapshot?.resolutions;
  const reconciliationKeys =
    canReuseReconciliationKeys && cachedReconciliationKeys
      ? cachedReconciliationKeys
      : {
          source: blockChangeSummary?.source,
          barrierRevision: blockChangeSummary?.tailAppendBarrierRevision,
          connectionSessionId: connection.sessionId,
          resolutionSessionId: resolutionSnapshot?.sessionId,
          resolutions: resolutionSnapshot?.resolutions,
          pendingBackgroundAgentKey:
            getPendingBackgroundAgentKey(reconciledMessages),
          pendingPermissionKey: [...getPendingPermissionCallIds(blocks)]
            .sort()
            .join('|'),
          backgroundAgentNotificationKey:
            getBackgroundAgentNotificationKey(blocks),
        };
  useLayoutEffect(() => {
    reconciliationKeysRef.current = reconciliationKeys;
  });
  const {
    pendingBackgroundAgentKey,
    pendingPermissionKey,
    backgroundAgentNotificationKey,
  } = reconciliationKeys;
  const [reconciliationAttempt, setReconciliationAttempt] = useState(0);
  const reconciliationRequestRef = useRef<
    | {
        key: string;
        request: Promise<ReconciliationRound>;
        processed: boolean;
      }
    | undefined
  >(undefined);
  // Keyed by session + pending-agent set (not the notification key) so other
  // agents' notifications cannot reset the backoff and keep the retry delay
  // pinned at its base. `attempts` drives the backoff delay; `errorAttempts`
  // tracks consecutive transient-error rounds per callId toward the budget.
  const retryBackoffRef = useRef<{
    key: string;
    attempts: number;
    errorAttempts: ReadonlyMap<string, number>;
  }>({
    key: '',
    attempts: 0,
    errorAttempts: new Map(),
  });
  const missingAgentMissesRef = useRef(new Map<string, number>());
  // Last 404 timestamp per callId. The grace ladder is wall-clock paced: a
  // miss only counts toward the grace once the base backoff has elapsed since
  // the previous miss, so a re-probe triggered by an unrelated transcript
  // change (for example another permission appearing) cannot collapse the
  // retry ladder into two immediate misses.
  const missTimestampsRef = useRef(new Map<string, number>());
  const errorTimestampsRef = useRef(new Map<string, number>());
  const lastConnectionKeyRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    // Miss counts and the retry budget may not span connection transitions:
    // a post-reconnect 404 is a fresh race with registration, and a restarted
    // daemon deserves a fresh retry ladder rather than the pre-disconnect
    // attempt count.
    const connectionKey = `${connection.sessionId}:${connection.status}`;
    if (lastConnectionKeyRef.current !== connectionKey) {
      lastConnectionKeyRef.current = connectionKey;
      missingAgentMissesRef.current.clear();
      missTimestampsRef.current.clear();
      errorTimestampsRef.current.clear();
      retryBackoffRef.current = {
        key: '',
        attempts: 0,
        errorAttempts: new Map(),
      };
    }
    const sessionId = connection.sessionId;
    if (
      !sessionId ||
      connection.status !== 'connected' ||
      connection.loadingTranscript ||
      connection.catchingUp ||
      !pendingBackgroundAgentKey
    ) {
      if (
        !sessionId ||
        connection.status !== 'connected' ||
        connection.loadingTranscript ||
        connection.catchingUp
      ) {
        reconciliationRequestRef.current = undefined;
      }
      return;
    }
    const requestKey = `${sessionId}:${pendingBackgroundAgentKey}:${backgroundAgentNotificationKey}`;
    const retryScopeKey = `${sessionId}:${pendingBackgroundAgentKey}`;
    const cachedRound = reconciliationRequestRef.current;
    // Agents still under approval have not spawned their subagent session
    // yet: exclude them so the 404 probe cannot accumulate missing-agent
    // misses and paint a failure while the dialog is unanswered. Rebuild the
    // membership from the stable key — the effect depends on the key, not the
    // Set, so a transcript delta with unchanged permission content does not
    // re-run this effect.
    const pendingPermissionCallIds = new Set(
      pendingPermissionKey ? pendingPermissionKey.split('|') : [],
    );
    const callIds = pendingBackgroundAgentKey
      .split('|')
      .filter((callId) => !pendingPermissionCallIds.has(callId));
    for (const callId of [...missingAgentMissesRef.current.keys()]) {
      if (!callIds.includes(callId)) {
        missingAgentMissesRef.current.delete(callId);
        missTimestampsRef.current.delete(callId);
      }
    }
    for (const callId of [...errorTimestampsRef.current.keys()]) {
      if (!callIds.includes(callId)) errorTimestampsRef.current.delete(callId);
    }
    const roundErrors: Array<{ callId: string; error: unknown }> = [];
    const roundNotFounds: string[] = [];
    // A settled round that was already processed must not be reused: a
    // re-run (for example a client identity swap) would attach a second
    // handler and count the same round against the retry budget twice.
    const roundIsReusable =
      !!cachedRound && cachedRound.key === requestKey && !cachedRound.processed;
    const request = roundIsReusable
      ? cachedRound.request
      : Promise.allSettled(
          callIds.map(async (callId) => {
            try {
              const resolution = await workspace.client.resolveSubagentSession(
                sessionId,
                callId,
              );
              return [callId, resolution] as const;
            } catch (error) {
              if (
                isSubagentSessionNotFound(error, callId) ||
                isSessionLevelNotFound(error)
              ) {
                // Both 404 shapes also occur while the daemon is racing
                // registration or the owning workspace runtime is
                // transiently inactive, so the active round's handler alone
                // counts them against the missing-agent grace.
                roundNotFounds.push(callId);
              } else if (
                error instanceof DaemonHttpError &&
                error.status >= 400 &&
                error.status < 500 &&
                error.status !== 404 &&
                error.status !== 429
              ) {
                // Permanent client errors never recover on retry; make the
                // card terminal so it can stop gating the UI. A 429 is the
                // daemon's rate-limit signal and unrecognized 404 shapes
                // stay transient, so neither may fail the agent.
                return [callId, { status: 'failed' }] as const;
              }
              roundErrors.push({ callId, error });
              throw error;
            }
          }),
        ).then((results) => {
          const resolutions = new Map<string, BackgroundAgentResolution>();
          const succeeded: string[] = [];
          results.forEach((result) => {
            if (result.status !== 'fulfilled') return;
            succeeded.push(result.value[0]);
            if (isTerminalBackgroundAgentStatus(result.value[1].status)) {
              resolutions.set(result.value[0], result.value[1]);
            }
          });
          return {
            resolutions,
            errors: roundErrors,
            notFounds: roundNotFounds,
            succeeded,
          };
        });
    const round = roundIsReusable
      ? cachedRound
      : { key: requestKey, request, processed: false };
    reconciliationRequestRef.current = round;
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    request
      .then(({ resolutions, errors, notFounds, succeeded }) => {
        if (!active) return;
        round.processed = true;
        // Grace-miss accounting lives in the active handler, not the per-call
        // closure: a superseded round's late 404 must not consume grace that
        // belongs to the live round. The handler also re-checks the current
        // probe set: a round that straddles a permission transition settles
        // with misses for an agent that is now excluded, and those must not
        // be counted (or re-added after the exclusion cleanup ran).
        for (const callId of succeeded) {
          missingAgentMissesRef.current.delete(callId);
          missTimestampsRef.current.delete(callId);
          errorTimestampsRef.current.delete(callId);
        }
        for (const callId of [...resolutions.keys()]) {
          if (!callIds.includes(callId)) resolutions.delete(callId);
        }
        for (const callId of notFounds) {
          if (!callIds.includes(callId)) continue;
          const now = Date.now();
          const lastMiss = missTimestampsRef.current.get(callId) ?? 0;
          if (now - lastMiss < BACKGROUND_AGENT_RECONCILIATION_RETRY_BASE_MS) {
            continue;
          }
          missTimestampsRef.current.set(callId, now);
          const misses = (missingAgentMissesRef.current.get(callId) ?? 0) + 1;
          missingAgentMissesRef.current.set(callId, misses);
          if (misses >= MISSING_BACKGROUND_AGENT_GRACE_MISSES) {
            resolutions.set(callId, { status: 'failed' });
          }
        }
        let unresolved = resolutions.size < callIds.length;
        const failedCallIds: string[] = [];
        let retryDelayMs = BACKGROUND_AGENT_RECONCILIATION_RETRY_BASE_MS;
        if (unresolved) {
          const previous =
            retryBackoffRef.current.key === retryScopeKey
              ? retryBackoffRef.current
              : {
                  key: retryScopeKey,
                  attempts: 0,
                  errorAttempts: new Map<string, number>(),
                };
          const attempts = previous.attempts + 1;
          // Consecutive error rounds are tracked per callId so one agent's
          // persistent errors cannot exhaust a shared budget and fail a
          // healthy sibling; a callId absent from this round's errors
          // resets implicitly. Healthy non-terminal responses back off but
          // never consume the budget.
          const errorAttempts = new Map<string, number>();
          for (const entry of errors) {
            if (!callIds.includes(entry.callId)) continue;
            const now = Date.now();
            const lastError = errorTimestampsRef.current.get(entry.callId);
            const previousCount = previous.errorAttempts.get(entry.callId) ?? 0;
            const count =
              lastError !== undefined &&
              now - lastError < BACKGROUND_AGENT_RECONCILIATION_RETRY_BASE_MS
                ? previousCount
                : previousCount + 1;
            if (count !== previousCount) {
              errorTimestampsRef.current.set(entry.callId, now);
            }
            errorAttempts.set(entry.callId, count);
            if (count >= BACKGROUND_AGENT_RECONCILIATION_MAX_ATTEMPTS) {
              failedCallIds.push(entry.callId);
              resolutions.set(entry.callId, { status: 'failed' });
            }
          }
          unresolved = resolutions.size < callIds.length;
          retryDelayMs = Math.min(
            BACKGROUND_AGENT_RECONCILIATION_RETRY_BASE_MS * 2 ** (attempts - 1),
            BACKGROUND_AGENT_RECONCILIATION_RETRY_MAX_MS,
          );
          retryBackoffRef.current = unresolved
            ? { key: retryScopeKey, attempts, errorAttempts }
            : { key: retryScopeKey, attempts: 0, errorAttempts: new Map() };
        } else {
          retryBackoffRef.current = {
            key: retryScopeKey,
            attempts: 0,
            errorAttempts: new Map(),
          };
        }
        if (failedCallIds.length > 0) {
          console.warn(
            '[web-shell] background agent reconciliation retry budget exhausted; marking agents failed',
            {
              sessionId,
              callIds: failedCallIds,
              errors: errors.map((entry) =>
                describeReconciliationError(entry.error),
              ),
            },
          );
        }
        setResolutionSnapshot((current) => ({
          sessionId,
          resolutions: new Map([
            ...(current?.sessionId === sessionId ? current.resolutions : []),
            ...resolutions,
          ]),
        }));
        if (!unresolved) return;
        if (errors.length > 0) {
          console.warn(
            '[web-shell] background agent reconciliation retry scheduled',
            {
              sessionId,
              callIds: errors.map((entry) => entry.callId),
              errors: errors.map((entry) =>
                describeReconciliationError(entry.error),
              ),
            },
          );
        }
        retryTimer = setTimeout(() => {
          if (reconciliationRequestRef.current?.request === request) {
            reconciliationRequestRef.current = undefined;
          }
          setReconciliationAttempt((attempt) => attempt + 1);
        }, retryDelayMs);
      })
      .catch(() => {
        if (reconciliationRequestRef.current?.request === request) {
          reconciliationRequestRef.current = undefined;
        }
      });
    return () => {
      active = false;
      clearTimeout(retryTimer);
    };
  }, [
    backgroundAgentNotificationKey,
    connection.catchingUp,
    connection.loadingTranscript,
    connection.sessionId,
    connection.status,
    pendingBackgroundAgentKey,
    pendingPermissionKey,
    reconciliationAttempt,
    workspace.client,
  ]);

  return reconciledMessages;
}

export function useMessages(t: Translator): Message[] {
  const blocks = useTranscriptBlocks();
  return useMessagesFromBlocks(t, blocks);
}
