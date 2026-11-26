/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AUTOMATION_INPUT_SOURCE } from '@qwen-code/qwen-code-core/managed-runtime/managed-automation-operations.js';
import { CHANNEL_INPUT_SOURCE } from '@qwen-code/qwen-code-core/managed-runtime/managed-channel-operations.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { PR_EVENT_INPUT_SOURCE } from '@qwen-code/qwen-code-core/managed-runtime/managed-pr-watch-operations.js';
import {
  assertManagedSessionDurableRef,
  isChildNotificationSource,
  type ManagedSessionEvent,
  ManagedSessionRecordError,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import { SessionTranscriptChangedError } from '@qwen-code/qwen-code-core/services/session-writer-lease.js';
import { randomUUID } from 'node:crypto';
import { writeStderrLineSafe } from '../../utils/stdioHelpers.js';
import { readHostedInput } from '../hosted-input.js';
import { LOOP_INPUT_SOURCE } from '../hosted-loop-session.js';
import { wakeHasPriorAttempt } from '../hosted-monitor-wake.js';
import {
  answerCommittedTurnCalls,
  isDurableBlockedVerdict,
  originalRuntimeBroker,
  RecoveryDeclined,
  settleParkedTurnCancelled,
  stopParkedRuntimeExecutions,
} from '../hosted-runtime-recovery.js';
import { SESSION_MESSAGE_INPUT_SOURCE } from '../hosted-session-message-session.js';
import { endHostedAction } from '../hosted-tool-approval.js';
import { excludedHostedPrompts } from '../hosted-turn-history.js';
import {
  enqueueHostedWakeContinuation,
  isHostedWakeContinuationId,
  readHostedWakeContinuation,
} from '../hosted-wake-continuation.js';
import {
  type PendingSessionInput,
  pendingSessionInputs,
} from '../hosted-wake-intake.js';
import {
  type HostedWorkspaceBroker,
  type HostedWorkspaceBrokerOptions,
  HostedWorkspaceBrokerRejection,
} from '../hosted-workspace-broker.js';
import type { HostedSession } from './session-state.js';

/**
 * How long a route that settles a crashed wake input outside the pump (a
 * `reconcile_run` repair, a message stop) waits for a pump pass in
 * flight. The load's pass over a crashed input is its reads, its
 * transcript projection and the aftermath's Broker and Store calls. A
 * pass still running after this (a live turn, or a slow Store or Broker)
 * keeps the pump, and the route answers without settling. Well inside the
 * control plane's 30 s request timeout, which the settle itself still has
 * to fit in.
 */
export const HOSTED_WAKE_PASS_WAIT_MS = 10_000;

export async function readHostedClassifierUserText(
  session: HostedSession,
): Promise<ReadonlyMap<string, string>> {
  const accepted = session.managed.authority
    .eventsInSequenceRange(1, session.managed.authority.committedSequence)
    .filter(
      (event) =>
        event.kind === 'input.accepted' &&
        (event.payload['source'] === 'hosted-harness' ||
          event.payload['source'] === LOOP_INPUT_SOURCE),
    )
    .slice(-40);
  return new Map(
    await Promise.all(
      accepted.map(async (event) => {
        const promptId = String(event.payload['inputId']);
        if (event.payload['source'] === LOOP_INPUT_SOURCE) {
          // A loop continuation's prompt lives in its input envelope, not the
          // hosted-harness parts format readHostedInput parses. Carry it so a
          // fired tick's successor arm is vetted against its own prompt.
          let text = '';
          try {
            const ref = assertManagedSessionDurableRef(
              event.payload['contentRef'],
              'loop wakeup input',
            );
            const body = JSON.parse(
              (await session.managed.resources.read(ref)).toString('utf8'),
            ) as { text?: unknown };
            if (typeof body.text === 'string') text = body.text;
          } catch {
            text = '';
          }
          return [promptId, text] as const;
        }
        return [
          promptId,
          (await readHostedInput(session.managed, promptId, '')).text,
        ] as const;
      }),
    ),
  );
}

export function hasAcceptedInput(
  session: HostedSession,
  promptId: string,
): boolean {
  return acceptedInputSequence(session, promptId) !== undefined;
}

/** The journal sequence of the input's own admission event: the watermark
 * from which every event of that input's Turn follows. */
export function acceptedInputSequence(
  session: HostedSession,
  promptId: string,
): number | undefined {
  const authority = session.managed.authority;
  let sequence: number | undefined;
  for (const event of authority.eventsInSequenceRange(
    1,
    authority.committedSequence,
  )) {
    if (
      event.kind === 'input.accepted' &&
      event.payload['inputId'] === promptId
    )
      sequence = event.sequence;
  }
  return sequence;
}

export function unansweredPrompts(
  session: HostedSession,
  records: readonly ChatRecord[],
): Set<string> {
  const authority = session.managed.authority;
  return excludedHostedPrompts(
    authority.eventsInSequenceRange(1, authority.committedSequence),
    records,
  );
}

/** Which input sources ride the wake pump — the one predicate the probe,
 * the park guard, the pump's pick and the wake-owned classifier share:
 * a monitor notification, a channel input, an H6 automation input, and a child
 * acceptance notification of either child Session kind alike (child
 * runs park as Turns, never here; #13803 widened the child source to
 * the record's own kind, `child_agent` or `workflow`). */
export function isWakeInputSource(source: string): boolean {
  return (
    source === 'monitor' ||
    source === CHANNEL_INPUT_SOURCE ||
    source === AUTOMATION_INPUT_SOURCE ||
    isChildNotificationSource(source) ||
    source === SESSION_MESSAGE_INPUT_SOURCE ||
    source === LOOP_INPUT_SOURCE ||
    source === PR_EVENT_INPUT_SOURCE
  );
}

/** The oldest pending wake input, as the pump's
 * own read order sees it. */
export function firstPendingWakeInput(session: HostedSession) {
  const authority = session.managed.authority;
  return pendingSessionInputs(
    authority.eventsInSequenceRange(1, authority.committedSequence),
  ).find((input) => isWakeInputSource(input.source));
}

/**
 * The pending wake input a crash aftermath should target: the one that
 * carries a prior attempt. The pump may have skipped an older not-yet-due
 * input to run a later due one, so the attempted wake is not necessarily the
 * first by journal order; recovering the wrong one leaves the real crash
 * blocked. Falls back to the first pending wake when none has an attempt.
 */
export async function attemptedPendingWakeInput(session: HostedSession) {
  const authority = session.managed.authority;
  const pending = pendingSessionInputs(
    authority.eventsInSequenceRange(1, authority.committedSequence),
  ).filter((input) => isWakeInputSource(input.source));
  if (pending.length === 0) return undefined;
  const projected = await session.managed.sink.project();
  return (
    pending.find((input) => wakeHasPriorAttempt(projected, input.turnId)) ??
    pending[0]
  );
}

/** H4f × H4d-b: a stopped run's message inputs never start a turn; the
 * relay's stop settles them. */
export function isStoppedMessage(
  session: Pick<HostedSession, 'messagesStopped'>,
  source: string | undefined,
): boolean {
  return (
    session.messagesStopped === true && source === SESSION_MESSAGE_INPUT_SOURCE
  );
}

/**
 * The wake pump's pick over the committed prefix: the first deliverable wake
 * input due at `now` and the earliest future notBefore it skips. Deferral is
 * per input, not head-of-line.
 */
export function pickWakeInputs(
  session: HostedSession,
  now: number,
): { first?: PendingSessionInput; earliestDeferred?: number } {
  const authority = session.managed.authority;
  let first: PendingSessionInput | undefined;
  let earliestDeferred: number | undefined;
  for (const input of pendingSessionInputs(
    authority.eventsInSequenceRange(1, authority.committedSequence),
  )) {
    if (
      !isWakeInputSource(input.source) ||
      isStoppedMessage(session, input.source)
    ) {
      continue;
    }
    if (input.notBefore !== null && input.notBefore > now) {
      if (earliestDeferred === undefined || input.notBefore < earliestDeferred)
        earliestDeferred = input.notBefore;
      continue;
    }
    first ??= input;
  }
  return { first, earliestDeferred };
}

/**
 * Where the control plane delivers wake inputs at their due time, it owns
 * only deferred, unattempted ones. A due input is the pump's to run now, a
 * stopped run's message waits for the relay's stop, and an attempted or
 * non-wake input keeps its existing recovery.
 */
export function wakeDispatchOwnsInput(
  session: Pick<HostedSession, 'messagesStopped'>,
  input: PendingSessionInput,
  projected: ReadonlyArray<{ readonly daemonPromptId?: string }>,
  now: number,
): boolean {
  return (
    isWakeInputSource(input.source) &&
    !isStoppedMessage(session, input.source) &&
    input.notBefore !== null &&
    input.notBefore > now &&
    !wakeHasPriorAttempt(projected, input.turnId)
  );
}

/**
 * Whether a still-pending wake input holds the Session's checkpoint
 * parked at `await_runtime` with in-progress Runtime executions: the
 * crash residue that makes every later turn die at "not a model-start
 * phase" until its aftermath runs. A queued input can never match (its
 * turnId only reaches the checkpoint once an attempt runs), so the read
 * alone is proof enough.
 */
export async function hasPendingWakePark(
  session: HostedSession,
): Promise<boolean> {
  const authority = session.managed.authority;
  const pending = new Set(
    pendingSessionInputs(
      authority.eventsInSequenceRange(1, authority.committedSequence),
    )
      .filter((input) => isWakeInputSource(input.source))
      .map((input) => input.turnId),
  );
  if (pending.size === 0) return false;
  const authorization = await authority.harnessRunAuthorization();
  if (authorization.status !== 'runnable') {
    // A durable blocked verdict is no park to this probe; an erased one
    // (a store fault read as `missing_state` with its message) read the
    // checkpoint NOT AT ALL — keep the retriable refusal instead of
    // answering "no park" over state nobody read.
    if (
      authorization.status === 'blocked' &&
      !isDurableBlockedVerdict(authorization)
    ) {
      throw new ManagedSessionRecordError(
        `wake park probe read no durable checkpoint verdict: ${authorization.reason}${authorization.message === undefined ? '' : ` (${authorization.message})`}`,
      );
    }
    return false;
  }
  const parked = authorization.checkpoint.identity.turnId;
  if (parked === null || !pending.has(parked)) {
    return false;
  }
  return (authorization.checkpoint.tools?.items ?? []).some(
    (item) => item.state === 'in_progress' && item.outcomeSource === 'runtime',
  );
}

/**
 * The adopt refusals that mean the wake session is released or mid-release
 * (RELEASING), never a live one to stop: a cold Broker answers
 * `runtime_session_not_acquirable` from the persisted row, while the live
 * Broker that still holds the session in process answers
 * `runtime_session_not_ready`. Either way only an explicit release can
 * finish the lease, so neither may fail the aftermath before it.
 */
function isReleasedOrReleasingAdoptRefusal(cause: unknown): boolean {
  return (
    cause instanceof HostedWorkspaceBrokerRejection &&
    cause.status === 409 &&
    ['runtime_session_not_ready', 'runtime_session_not_acquirable'].includes(
      String(cause.code),
    )
  );
}

/**
 * The full aftermath of a wake turn that died inside its attempt, keyed
 * on the journal and the checkpoint — never on which settle ran before it:
 * its run fails with the execution unknown, a checkpoint parked at
 * `await_runtime` stops its Runtime executions and commits their results
 * cancelled, the wake session hands the Workspace lease back, and only
 * then the input's own `turn_result` consumes it, so a reload can never
 * re-classify the same crash. Retry-safe: every step reads the durable
 * state first, so a pass whose predecessor died halfway does only what
 * remains, and a surplus lease release is the idempotent direction — the
 * Broker answers an already-released session as released, while a skipped
 * release keeps the Workspace mount for every Session on it. 'pending'
 * means something could not be proved settled: the caller keeps what
 * blocks later turns rather than letting one run against the park.
 */
export async function settleCrashedWakeTurnAftermath(params: {
  session: HostedSession;
  sessionId: string;
  cwd: string;
  brokerOptions: HostedWorkspaceBrokerOptions | undefined;
  turnId: string;
}): Promise<'settled' | 'pending'> {
  const { session, sessionId, cwd, brokerOptions, turnId } = params;
  try {
    // Only the aftermath of a turn that demonstrably died inside an
    // attempt: a queued input owes no recovery, and settling it now
    // would kill work that never ran.
    if (!wakeHasPriorAttempt(await session.managed.sink.project(), turnId)) {
      return 'pending';
    }
    await session.automations?.settleRunFailedUnknown(turnId);
    const authorization =
      await session.managed.authority.harnessRunAuthorization();
    // An erased verdict read the checkpoint NOT AT ALL: settling this
    // crash over it would skip the stop/release or the wait's advance but
    // still consume the input, closing every retry channel the park has.
    // Fail closed — the caller's catch keeps the block and the input
    // pending.
    if (
      authorization.status === 'blocked' &&
      !isDurableBlockedVerdict(authorization)
    ) {
      throw new ManagedSessionRecordError(
        `wake crash aftermath read no durable checkpoint verdict: ${authorization.reason}${authorization.message === undefined ? '' : ` (${authorization.message})`}`,
      );
    }
    if (brokerOptions !== undefined) {
      if (
        authorization.status === 'runnable' &&
        authorization.checkpoint.identity.turnId === turnId
      ) {
        const items = authorization.checkpoint.tools?.items ?? [];
        const runtimeItems = items.filter(
          (item) => item.outcomeSource === 'runtime',
        );
        let broker: HostedWorkspaceBroker | undefined;
        if (runtimeItems.some((item) => item.state === 'in_progress')) {
          // The same cross-retry honesty carry the takeover cancel drive
          // keeps: a stop that counted unobserved ids must hand them to the
          // settle, or a reclaimed record certifies as a witnessed
          // cancellation. Owned on the Session — a stop that throws after
          // counting is this channel's retry channel, and a per-pass local
          // would let the next pass certify the stop nobody observed.
          const carried = new Set<string>(
            session.recoveryUnobserved?.get(turnId),
          );
          try {
            // A parked crash on a replacement Broker owns nothing until
            // adopted: status queries answer 404
            // runtime_session_not_found, a release 503
            // runtime_reconciliation_required. Adopt first, as the
            // passive takeover does — re-acquiring a READY session under
            // this same identity is idempotent server-side, and a 409
            // runtime_session_not_acquirable (a cold Broker) or
            // runtime_session_not_ready (a live Broker still holding the
            // session in process) refusal is exactly the already-released
            // (or mid-release) answer: nothing there remains to stop.
            const parkedBroker = await originalRuntimeBroker(
              session.managed,
              turnId,
              items,
              brokerOptions,
            );
            let adopted = true;
            try {
              await parkedBroker.acquire();
            } catch (cause) {
              if (!isReleasedOrReleasingAdoptRefusal(cause)) {
                throw cause;
              }
              adopted = false;
            }
            // The stop only makes sense on the session this pass
            // actually adopted: on a released (or mid-release) identity
            // every Broker read answers 404 runtime_session_not_found,
            // which is no RecoveryDeclined and would escape to the outer
            // catch as a failed pass — wedging the consume behind a poll
            // that can never answer. Skip it; the 409-aware release
            // block below still completes what the lease owes.
            if (adopted) {
              try {
                const stopped = await stopParkedRuntimeExecutions({
                  session: session.managed,
                  promptId: turnId,
                  brokerOptions,
                  carryUnobservedInto: carried,
                });
                broker = stopped.broker;
              } finally {
                persistRecoveryUnobserved(session, turnId, carried);
              }
            }
          } catch (cause) {
            // A decline is deterministic evidence read from the journal
            // (a shell under a hooks/MCP definition, a mismatched own
            // runtime route): retrying never changes it. Settle the
            // cancelled tool results and proceed to the consume anyway —
            // otherwise this Session wedges in an endless retry where a
            // user Turn's same park would get a typed terminal verdict.
            if (!(cause instanceof RecoveryDeclined)) throw cause;
            writeStderrLineSafe(
              `qwen serve: Hosted wake turn ${turnId} park is deterministically unrecoverable by the Broker; its cancelled tool results and run are settled anyway, and the wake session's lease stays the system's re-admitted kind: ${String(cause)}`,
            );
          }
          // The cancelled tool results journal like every route write: a
          // concurrent route claim can move the journal mid-write, and a
          // transcript-changed failure of one attempt is a retry, not a
          // drop, or the re-block loop this path exists to end comes back
          // with an unconsumed input.
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              const settleOutcome = await settleParkedTurnCancelled({
                session: session.managed,
                sessionId,
                cwd,
                promptId: turnId,
                unobserved: carried,
                broker,
                shell: session.shell,
              });
              // A settle that could not verify the park journaled nothing:
              // the release and the terminal record must not build on it —
              // the throw reaches the function catch, which answers
              // 'pending' for the retry.
              if (settleOutcome === 'not-runnable')
                throw new Error(
                  'Wake crash aftermath cannot verify the park (authorization not runnable).',
                );
              break;
            } catch (cause) {
              if (!(cause instanceof SessionTranscriptChangedError))
                throw cause;
              if (attempt === 2) throw cause;
              await new Promise((resolve) =>
                setTimeout(resolve, 50 * (attempt + 1)),
              );
            }
          }
        }
        // Release on every pass: the journal cannot say whether an
        // earlier pass's release landed after the checkpoint moved on.
        // A refused adopt is NOT proof of one — a session mid-release
        // (RELEASING) refuses it too: `runtime_session_not_acquirable` from
        // a cold Broker, `runtime_session_not_ready` from the live one that
        // still holds the session in process. Only the explicit release
        // below completes it; an already-released session answers that
        // same release idempotently as the released kind.
        if (runtimeItems.length > 0) {
          try {
            broker ??= await originalRuntimeBroker(
              session.managed,
              turnId,
              items,
              brokerOptions,
            );
            try {
              await broker.acquire();
            } catch (cause) {
              if (!isReleasedOrReleasingAdoptRefusal(cause)) {
                throw cause;
              }
            }
            await broker.release();
          } catch (cause) {
            // A wake turn that started a background run leaves that Runtime
            // held by design, so the routine release refuses
            // `runtime_session_held`. That is the designed hold, not an
            // aftermath failure: the run outlives the wake turn it started
            // on, and the Session's close owes the drain. Register the
            // obligation and go on settling the crashed wake's input. The
            // routine recovery is deliberately not turned into a drain, which
            // would stop a background run the user meant to keep (#13856
            // R1-28).
            if (
              cause instanceof HostedWorkspaceBrokerRejection &&
              cause.status === 409 &&
              cause.code === 'runtime_session_held'
            ) {
              session.heldRuntimeTurns.add(turnId);
            } else if (cause instanceof RecoveryDeclined) {
              writeStderrLineSafe(
                `qwen serve: Hosted wake turn ${turnId} could not derive its wake session's Broker identity; its lease stays the system's re-admitted kind: ${String(cause)}`,
              );
            } else {
              throw cause;
            }
          }
        }
      }
    }
    // A turn that died waiting for a decision leaves the checkpoint at
    // await_action, where no later turn can start. The crash settles that
    // turn, so its ask ends cancelled and the wait advances, as a parked
    // prompt's cancellation takeover does.
    if (
      authorization.status === 'runnable' &&
      authorization.checkpoint.identity.turnId === turnId &&
      authorization.checkpoint.continuation.phase === 'await_action'
    ) {
      const requestId = authorization.checkpoint.approval?.requestId;
      if (
        requestId !== undefined &&
        session.managed.authority.action(requestId)?.state === 'requested'
      )
        await endHostedAction(
          session.managed,
          requestId,
          'cancelled',
          () => !session.managed.authority.writesStopped,
        );
      await createManagedHarnessHandle(session.managed).resolveDurableWait();
    }
    // The calls the dead attempt committed but never answered get their
    // answers by what committed before the Turn settles; core's orphan
    // repair would tell the next Turn's model to retry them.
    await answerCommittedTurnCalls({
      session: session.managed,
      sessionId,
      cwd,
      promptId: turnId,
      children: session.childAgents,
      teams: session.teams,
      messages: session.messages,
      commands: session.commands,
    });
    const notificationId = isHostedWakeContinuationId(turnId)
      ? (await readHostedWakeContinuation(session.managed, turnId))
          .notificationTurnId
      : turnId;
    const sourceCancelled =
      session.publicChildAgentsVersion === 1 &&
      ((await session.childAgents?.cancelledNotification(turnId)) ||
        (await session.childAgents?.cancelledNotification(notificationId)));
    const continuationId = sourceCancelled
      ? undefined
      : await enqueueHostedWakeContinuation(session.managed, turnId);
    // Consume the crashed input: until its turnId settles, every reload
    // re-classifies it as recovery and re-blocks the Session over the
    // same crash (the journal-filter rule in the history builders then
    // keeps its prompt out of later turns). A concurrent route claim can
    // move the journal mid-write: the transcript-changed failure of one
    // attempt is a retry, not a drop, or the re-block loop this consumes
    // would come back.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await session.managed.sink.write({
          uuid: randomUUID(),
          parentUuid: null,
          sessionId,
          timestamp: new Date().toISOString(),
          type: 'system',
          cwd,
          version: 'hosted-harness/1',
          subtype: 'turn_result',
          systemPayload: {
            promptId: turnId,
            state: sourceCancelled ? 'cancelled' : 'error',
            stopReason: sourceCancelled ? 'cancelled' : 'error',
            endedAt: Date.now(),
          },
        });
        break;
      } catch (cause) {
        if (!(cause instanceof SessionTranscriptChangedError)) throw cause;
        if (attempt === 2) throw cause;
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
    // The settle journaled durably, so retries re-derive the outcomes from
    // the journal and the carry has no more work.
    session.recoveryUnobserved?.delete(turnId);
    writeStderrLineSafe(
      `qwen serve: Hosted wake turn ${turnId} crash aftermath settled${continuationId === undefined ? '.' : `; continuation ${continuationId} is durable.`}`,
    );
    return 'settled';
  } catch (cause) {
    writeStderrLineSafe(
      `qwen serve: Hosted wake turn ${turnId} aftermath could not be settled: ${String(cause)}`,
    );
    return 'pending';
  }
}

// H3: a monitor notification input is never a parked Turn — the wake pump
// owns its consumption, so reopen and takeover arithmetic skips it exactly
// like the close path settles it model-free. H4b: the child run's
// acceptance notification is the same shape — its consumption rides the
// wake turn, so exempting only `monitor` here wedges the Session: the
// pending notification counts as an unsettled Turn on every load while
// the pump that would deliver it can never run. H6: an automation input
// rides the same pump and the same rules; H5: so does a channel input.
/** The wake sources whose interrupted approval wait the pump resumes, so
 * the only ones whose wait may park (#18149 S4, S4b). Session-message
 * Turns keep their own settlement. */
export function isResumableWakeSource(source: unknown): boolean {
  return (
    source === 'monitor' ||
    source === AUTOMATION_INPUT_SOURCE ||
    source === LOOP_INPUT_SOURCE ||
    source === CHANNEL_INPUT_SOURCE ||
    source === PR_EVENT_INPUT_SOURCE ||
    isChildNotificationSource(source)
  );
}

export function isWakeOwnedInput(event: ManagedSessionEvent): boolean {
  if (event.kind !== 'input.accepted') return false;
  if (isWakeInputSource(event.payload['source'] as string)) return true;
  const turnId = event.payload['turnId'];
  const source = event.payload['source'];
  return (
    isChildNotificationSource(source) &&
    typeof turnId === 'string' &&
    turnId.endsWith(':accept:notify')
  );
}

// H5/F5 follow-up: a channel input's parked turn is the wake pump's own,
// exactly like the unsettled-input arithmetic above treats it — including
// the file-history obligation the turn left behind. Naming this once
// keeps the load gate's exception aligned with the pump's ownership.
export function isPumpOwnedToolTurn(
  session: HostedSession,
  turnId: string,
): boolean {
  const authority = session.managed.authority;
  return authority
    .eventsInSequenceRange(1, authority.committedSequence)
    .some(
      (event) =>
        event.kind === 'input.accepted' &&
        event.payload['turnId'] === turnId &&
        (event.payload['source'] === CHANNEL_INPUT_SOURCE ||
          event.payload['source'] === PR_EVENT_INPUT_SOURCE),
    );
}

export function unsettledInputsThrough(
  session: HostedSession,
  throughSequence: number,
): Set<string> {
  const accepted = new Set<string>();
  const authority = session.managed.authority;
  for (const event of authority.eventsInSequenceRange(1, throughSequence)) {
    if (event.kind === 'input.accepted' && !isWakeOwnedInput(event))
      accepted.add(event.payload['turnId'] as string);
    if (event.kind === 'turn.settled')
      accepted.delete(event.payload['turnId'] as string);
  }
  return accepted;
}

export function hasUnsettledInput(
  session: HostedSession,
  throughSequence: number,
): boolean {
  return unsettledInputsThrough(session, throughSequence).size > 0;
}

export function unsettledInputs(session: HostedSession): Set<string> {
  return unsettledInputsThrough(
    session,
    session.managed.authority.committedSequence,
  );
}

// Recovery needs one unambiguous parked Turn; more than one fails closed.
export function unsettledPromptId(session: HostedSession): string | undefined {
  const unsettled = unsettledInputs(session);
  return unsettled.size === 1 ? [...unsettled][0] : undefined;
}

// A pruned-to-empty carry must persist as a delete, not as no write at
// all: an upsert-only write leaves the previous pass's stale set behind,
// and the next pass would journal a positively witnessed stop as
// unobservable.
export function persistRecoveryUnobserved(
  session: HostedSession,
  turnId: string,
  carried: Set<string>,
): void {
  if (carried.size > 0)
    (session.recoveryUnobserved ??= new Map()).set(turnId, carried);
  else session.recoveryUnobserved?.delete(turnId);
}
