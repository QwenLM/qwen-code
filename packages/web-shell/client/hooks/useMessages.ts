import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DaemonHttpError,
  isSessionLevelNotFound,
  isSubagentSessionNotFound,
  type DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import {
  useConnection,
  useTranscriptBlocks,
  useWorkspace,
} from '@qwen-code/webui/daemon-react-sdk';
import { transcriptBlocksToDaemonMessages } from '../adapters/transcriptToMessages';
import type { Message } from '../adapters/types';
import {
  isActiveToolStatus,
  isBackgroundSubAgentToolCall,
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

export interface BackgroundAgentResolution {
  status: string;
  durationMs?: number;
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

function isTerminalBackgroundAgentStatus(status: string): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'canceled'
  );
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
      toolsChanged = true;
      const cancelled =
        resolution.status === 'cancelled' || resolution.status === 'canceled';
      const status: typeof tool.status =
        resolution.status === 'failed' ? 'failed' : 'completed';
      return {
        ...tool,
        status,
        ...(tool.startTime !== undefined
          ? { endTime: tool.startTime + (resolution.durationMs ?? 0) }
          : {}),
        ...(cancelled
          ? {
              rawOutput: {
                ...(typeof tool.rawOutput === 'object' &&
                tool.rawOutput !== null &&
                !Array.isArray(tool.rawOutput)
                  ? tool.rawOutput
                  : {}),
                status: 'cancelled',
              },
            }
          : {}),
      };
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
): Message[] {
  const workspace = useWorkspace();
  const connection = useConnection();
  const messages = useMemo(
    () => transcriptBlocksToLocalizedMessages(blocks, t),
    [blocks, t],
  );
  const [resolutionSnapshot, setResolutionSnapshot] = useState<{
    sessionId: string;
    resolutions: ReadonlyMap<string, BackgroundAgentResolution>;
  }>();
  const reconciledMessages = useMemo(() => {
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
  }, [connection.sessionId, messages, resolutionSnapshot]);
  const pendingBackgroundAgentKey = useMemo(
    () => getPendingBackgroundAgentKey(reconciledMessages),
    [reconciledMessages],
  );
  const backgroundAgentNotificationKey = useMemo(
    () => getBackgroundAgentNotificationKey(blocks),
    [blocks],
  );
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
    const callIds = pendingBackgroundAgentKey.split('|');
    for (const callId of [...missingAgentMissesRef.current.keys()]) {
      if (!callIds.includes(callId)) {
        missingAgentMissesRef.current.delete(callId);
      }
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
        // belongs to the live round.
        for (const callId of succeeded) {
          missingAgentMissesRef.current.delete(callId);
        }
        for (const callId of notFounds) {
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
            const count = (previous.errorAttempts.get(entry.callId) ?? 0) + 1;
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
    reconciliationAttempt,
    workspace.client,
  ]);

  return reconciledMessages;
}

export function useMessages(t: Translator): Message[] {
  const blocks = useTranscriptBlocks();
  return useMessagesFromBlocks(t, blocks);
}
