/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  ChildAgentRun,
  ChildAgentStopReason,
  ChildCompletion,
  ChildSessionRun,
  ChildWorkspaceMode,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-record.js';
import {
  isChildSessionRun,
  parseChildRun,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-record.js';
import type { ChildAcceptance } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-acceptance-record.js';
import { parseChildAcceptance } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-acceptance-record.js';
import type {
  ManagedSessionActor,
  ManagedSessionCommand,
  ManagedSessionInputRequest,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { ManagedSessionConflictError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import {
  ManagedSessionRecordError,
  type ManagedSessionDurableRef,
  type ManagedSessionDomain,
  type ManagedSessionKey,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  MANAGED_CHILD_LIMITS,
  admitChildLaunch,
  childAcceptanceBody,
  childAcceptanceConsumedBody,
  childAttachBody,
  childCancelBody,
  childContinuationBody,
  childDeliveryBody,
  childDispatchBody,
  childFailBody,
  childLaunchBody,
  childSettleCompletedBody,
  childStopRequestedBody,
  decodeChildLaunchEnvelope,
  encodeChildLaunchEnvelope,
  type ChildAdmission,
  type ChildLaunchEnvelope,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-child-operations.js';
import {
  MANAGED_SESSION_MESSAGE_RUNTIME_LIMITS,
  isUndeliveredMessage,
  outboundMessageBody,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-message-operations.js';
import type { SessionMessage } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-message-record.js';
import { parseSessionMessage } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-message-record.js';
import type { DefinitionPin } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import { isTerminalRunState } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import {
  managedExtensionRecordKey,
  managedTaskId,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-projection.js';
import { escapeXml } from '@qwen-code/qwen-code-core/utils/xml.js';
import { hostedTeamMembership } from './hosted-team-session.js';
import {
  stripDisplayControlChars,
  truncateNotificationLabel,
} from '@qwen-code/qwen-code-core/utils/terminalSafe.js';

// H4b of #12827: the hosted orchestrator of a Session's child_agent runs
// and their acceptances. The Java control plane's relay drives creation
// and delivery; the dual path puts every product record on the hosted
// authority, so this funnel commits the record line as facts arrive: the
// launch intent before any side effect, dispatch and attach as the control
// plane proves them, settlement only with the result and receipt copies in
// hand, acceptance as one transaction with its notification input when the
// child completes in the background. Writes are serialized and replay-safe
// by command id, exactly like the Shell funnel. See
// docs/design/2026-10-07-managed-child-session-runtime.md.

/** The narrow authority/resource pair a HostedChildAgentSession commits through. */
export interface HostedChildAgentStore {
  readonly authority: {
    extensionRecord(
      domain: ManagedSessionDomain,
      recordId: string,
    ): { readonly record: unknown; readonly revision: number } | undefined;
    extensionRecordsInDomain(
      domain: ManagedSessionDomain,
    ): ReadonlyArray<{ readonly record: unknown }>;
    commitExtensionRecord(
      command: ManagedSessionCommand,
      request: {
        readonly domain: ManagedSessionDomain;
        readonly record: unknown;
        readonly input?: ManagedSessionInputRequest;
      },
      actor: ManagedSessionActor,
    ): Promise<unknown>;
  };
  readonly resources: {
    publish(kind: string, bytes: Buffer): Promise<ManagedSessionDurableRef>;
    read(ref: ManagedSessionDurableRef): Promise<Buffer>;
  };
}

export interface ChildAgentLaunchParams {
  readonly childRunId: string;
  readonly ownerScopeId: string;
  readonly rootSessionId: string;
  readonly completion: ChildCompletion;
  readonly description: string;
  readonly prompt: string;
  readonly definition: DefinitionPin;
  readonly workspaceMode: ChildWorkspaceMode;
  readonly workingDirectory: string;
  readonly executionCallId: string;
}

const TRUSTED: ManagedSessionActor = { class: 'trusted_entry' };

function digest(record: unknown): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The launch admission answer the tool turn translates into its error. The
 * caller encodes the envelope first (a bound failure there is `byte_limit`)
 * and passes its byte length here.
 */
export function childLaunchAdmission(params: {
  readonly workspaceMode: ChildWorkspaceMode;
  /** #13753 I2: the control plane serves child Workspaces. */
  readonly childWorkspaces: boolean;
  readonly sameDefinition: boolean;
  readonly closing: boolean;
  readonly activeInScope: number;
  readonly launchedInScope: number;
  readonly envelopeBytes: number;
}): ChildAdmission {
  return admitChildLaunch({
    closing: params.closing,
    depth: 1,
    activeInScope: params.activeInScope,
    launchedInScope: params.launchedInScope,
    envelopeBytes: params.envelopeBytes,
    workspaceMode: params.workspaceMode,
    childWorkspaces: params.childWorkspaces,
    sameDefinition: params.sameDefinition,
  });
}

/** #13753 I2: what a worktree child's terminal receipt says of its merge. */
export interface ChildWorkspaceOutcome {
  readonly outcome: 'merged' | 'conflicted' | 'blocked' | 'discarded';
  readonly code: string;
  readonly conflictPaths: readonly string[];
  /** Conflict paths the receipt left out to stay within its byte bound. */
  readonly omittedConflictPaths: number;
  readonly resultRef?: string;
}

const CHILD_WORKSPACE_OUTCOMES: ReadonlyArray<
  ChildWorkspaceOutcome['outcome']
> = ['merged', 'conflicted', 'blocked', 'discarded'];

const CHILD_WORKSPACE_RESULT_REF =
  /^refs\/qwen\/child-workspaces\/[0-9a-f]{32}\/result$/;

/**
 * Reads the `workspace` member the control plane's relay adds to a
 * worktree child's terminal receipt. The receipt is the parent's opaque
 * resource, so anything off-shape answers undefined rather than a guess.
 */
export function parseChildWorkspaceReceipt(
  bytes: Buffer,
): ChildWorkspaceOutcome | undefined {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
  const workspace =
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)['workspace']
      : undefined;
  if (
    typeof workspace !== 'object' ||
    workspace === null ||
    Array.isArray(workspace)
  )
    return undefined;
  const fields = workspace as Record<string, unknown>;
  const outcome = fields['outcome'];
  const code = fields['code'];
  const paths = fields['conflictPaths'];
  const omitted = fields['omittedConflictPaths'];
  const resultRef = fields['resultRef'];
  if (
    fields['mode'] !== 'worktree' ||
    typeof outcome !== 'string' ||
    !(CHILD_WORKSPACE_OUTCOMES as readonly string[]).includes(outcome) ||
    typeof code !== 'string' ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(code) ||
    (paths !== undefined &&
      (!Array.isArray(paths) ||
        paths.some((path) => typeof path !== 'string'))) ||
    (omitted !== undefined &&
      (!Number.isSafeInteger(omitted) || (omitted as number) < 0)) ||
    (resultRef !== undefined &&
      (typeof resultRef !== 'string' ||
        !CHILD_WORKSPACE_RESULT_REF.test(resultRef)))
  )
    return undefined;
  return {
    outcome: outcome as ChildWorkspaceOutcome['outcome'],
    code,
    conflictPaths: (paths as string[] | undefined) ?? [],
    omittedConflictPaths: (omitted as number | undefined) ?? 0,
    ...(resultRef === undefined ? {} : { resultRef: resultRef as string }),
  };
}

/** The rendered conflict list's own budget, whatever the paths are. */
const CONFLICT_PATHS_TEXT_BYTES = 4 * 1024;

/**
 * The merge outcome in one model-facing sentence. Conflict paths are file
 * names the child chose, so each is quoted (a newline stays an escape,
 * never a line of its own) and stripped of display controls, and the list
 * stops at its byte budget.
 */
export function childWorkspaceOutcomeText(
  outcome: ChildWorkspaceOutcome | undefined,
): string {
  if (outcome === undefined)
    return "the merge outcome is unavailable; inspect this Workspace before relying on the child's changes.";
  const kept =
    outcome.resultRef === undefined
      ? ''
      : `; the child's work is kept at ${outcome.resultRef}`;
  switch (outcome.outcome) {
    case 'merged':
      return 'merged into this Workspace as uncommitted changes.';
    case 'discarded':
      return `discarded; the child's changes did not land${kept}.`;
    case 'blocked':
      return `merge blocked (${outcome.code}); the child's changes did not land${kept}.`;
    default: {
      const quoted: string[] = [];
      let bytes = 0;
      for (const path of outcome.conflictPaths) {
        // JSON leaves the line and paragraph separators raw.
        const text = stripDisplayControlChars(JSON.stringify(path))
          .replace(/\u2028/g, '\\u2028')
          .replace(/\u2029/g, '\\u2029');
        bytes += Buffer.byteLength(text, 'utf8') + 2;
        if (bytes > CONFLICT_PATHS_TEXT_BYTES) break;
        quoted.push(text);
      }
      const more =
        outcome.conflictPaths.length -
        quoted.length +
        outcome.omittedConflictPaths;
      const list =
        quoted.join(', ') +
        (more > 0 ? `${quoted.length > 0 ? ', ' : ''}and ${more} more` : '');
      return `merge conflicted at ${list || 'unlisted paths'}; the child's changes did not land${kept}.`;
    }
  }
}

/**
 * #13753 I2: what a foreground answer ends with for a worktree run — its
 * merge outcome, read from the receipt the acceptance names. Empty for a
 * `shared` run. Both the live wait and the recovery gap fill use it.
 */
export async function childWorkspaceAnswerSuffix(
  record: ChildAgentRun | undefined,
  acceptance: ChildAcceptance,
  read: (ref: ManagedSessionDurableRef) => Promise<Buffer>,
): Promise<string> {
  if (record?.workspaceMode !== 'worktree') return '';
  return `\n\n[child workspace] ${childWorkspaceOutcomeText(
    parseChildWorkspaceReceipt(await read(acceptance.terminalReceiptRef)),
  )}`;
}

/**
 * The notification's own budget, far below the 64 KiB inline cap of both
 * the bundled input and the wake turn's subsequent user `managed-message`
 * envelope: design 5 names the notification the summary of an accepted
 * result whose full bytes ride the acceptance record, so the remainder
 * after its own envelope is owed entirely, never wedged by an escape.
 */
export const CHILD_NOTIFICATION_INLINE_LIMIT = 48 * 1024;

const TRUNCATION_MARKER =
  '\n… (truncated: the full result is on the acceptance record, H4b decision 5)';

/** Multiline stripping: display-control chars per line; newlines kept. */
function stripMultilineControlChars(text: string): string {
  return text.split('\n').map(stripDisplayControlChars).join('\n');
}

/** The text of a background child's result, wrapped for its waiting turn. */
export function childResultNotificationText(params: {
  /** The task id the launch's own answer returned (task_…), so the model
   * can follow the child's terminal list surface — never the internal
   * `promptId:callId` marker. */
  readonly taskId: string;
  readonly description: string;
  readonly text: string;
  /** H4e-b1: the member name of a child run on a team roster. */
  readonly teammate?: string;
  /** #13753 I2: a worktree child's merge outcome, already rendered. */
  readonly workspace?: string;
}): string {
  const head = [
    '<task-notification>',
    `<task-id>${escapeXml(params.taskId)}</task-id>`,
    '<kind>child_agent</kind>',
    ...(params.teammate === undefined
      ? []
      : [`<teammate>${escapeXml(params.teammate)}</teammate>`]),
    '<status>completed</status>',
    ...(params.workspace === undefined
      ? []
      : [`<workspace>${escapeXml(params.workspace)}</workspace>`]),
    `<summary>Child agent "${escapeXml(truncateNotificationLabel(params.description))}" finished.</summary>`,
    '<result>',
  ].join('\n');
  return boundedNotificationText(
    head,
    '</result>\n</task-notification>',
    params.text,
    TRUNCATION_MARKER,
  );
}

/**
 * Wraps `text` between `head` and `tail`, escaped, within the notification
 * budget: an overlong text is cut with `marker` naming where the full
 * bytes stay.
 */
export function boundedNotificationText(
  head: string,
  tail: string,
  text: string,
  marker: string,
): string {
  const stripped = stripMultilineControlChars(text);
  const escaped = escapeXml(stripped);
  // What actually publishes wraps the envelope in JSON.stringify on the
  // managed-input resource, and the bound reads those serialized bytes —
  // measuring the XML text alone would overshoot under escape inflation.
  const serialized = (body: string) =>
    Buffer.byteLength(JSON.stringify({ text: head + body + tail }), 'utf8');
  if (serialized(escaped) <= CHILD_NOTIFICATION_INLINE_LIMIT) {
    return head + escaped + tail;
  }
  // The cut is a code-POINT slice: a UTF-16 code-unit cut could land
  // between a surrogate pair and emit an unpaired surrogate to the
  // model-facing notification — one split pair, never a character.
  const codePoints = [...stripped];
  const fits = (points: number): boolean =>
    serialized(escapeXml(codePoints.slice(0, points).join('') + marker)) <=
    CHILD_NOTIFICATION_INLINE_LIMIT;
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return head + escapeXml(codePoints.slice(0, low).join('') + marker) + tail;
}

/**
 * H4d-b: a child run cannot settle while a message from its parent still
 * owes its handover, nor over more messages than the settlement saw — the
 * message would arrive at a run that has ended. The relay answers it by
 * watching again, never by counting an attempt.
 */
export class ChildMessagesPendingError extends Error {}

/** Where `send_message` to a child task went. */
export type ChildMessageRoute =
  | { readonly kind: 'message'; readonly childRunId: string }
  | {
      readonly kind: 'continuation';
      readonly childRunId: string;
      readonly predecessorChildRunId: string;
    }
  | { readonly kind: 'refused'; readonly reason: string };

export class HostedChildAgentSession {
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: HostedChildAgentStore,
    private readonly key: ManagedSessionKey,
  ) {}

  /** The last committed body of one child run, parsed. */
  record(childRunId: string): ChildAgentRun | undefined {
    const existing = this.store.authority.extensionRecord(
      'child_run',
      childRunId,
    );
    if (existing === undefined) return undefined;
    const record = parseChildRun(existing.record);
    return record.kind === 'child_agent' ? record : undefined;
  }

  /** The last committed acceptance of one child run, parsed. */
  acceptance(childRunId: string): ChildAcceptance | undefined {
    const existing = this.store.authority.extensionRecord(
      'child_acceptance',
      childRunId,
    );
    return existing ? parseChildAcceptance(existing.record) : undefined;
  }

  /**
   * Every child Session run one owner scope launched, ended or not. The
   * quotas count child Sessions, so both child Session kinds count.
   */
  launchedChildRunsOf(ownerScopeId: string): readonly ChildSessionRun[] {
    return this.store.authority
      .extensionRecordsInDomain('child_run')
      .map((entry) => parseChildRun(entry.record))
      .filter(
        (record): record is ChildSessionRun =>
          isChildSessionRun(record) && record.ownerScopeId === ownerScopeId,
      );
  }

  /** The non-terminal child Session runs of one owner scope. */
  activeChildRunsOf(ownerScopeId: string): readonly ChildSessionRun[] {
    return this.launchedChildRunsOf(ownerScopeId).filter(
      (record) => !isTerminalRunState(record.run.state),
    );
  }

  /** The task id a launch answered for one child run. */
  taskIdOf(childRunId: string): string {
    return managedTaskId(
      managedExtensionRecordKey(this.key.sessionId, 'child_run', childRunId),
    );
  }

  /** The child agent run one task id names, of any chain generation. */
  runForTask(taskId: string): ChildAgentRun | undefined {
    for (const entry of this.store.authority.extensionRecordsInDomain(
      'child_run',
    )) {
      const record = parseChildRun(entry.record);
      if (
        record.kind === 'child_agent' &&
        this.taskIdOf(record.childRunId) === taskId
      ) {
        return record;
      }
    }
    return undefined;
  }

  /**
   * The newest run of a continuation chain. A continuation proven never to
   * have started left its predecessor untouched (H4d-a decision 9), so the
   * chain's head stays at the predecessor until another one starts.
   */
  chainHead(run: ChildAgentRun): ChildAgentRun {
    let head = run;
    for (;;) {
      const next = this.store.authority
        .extensionRecordsInDomain('child_run')
        .map((entry) => parseChildRun(entry.record))
        .find(
          (record): record is ChildAgentRun =>
            record.kind === 'child_agent' &&
            record.predecessorChildRunId === head.childRunId &&
            record.run.execution !== 'not_started_proven',
        );
      if (next === undefined) return head;
      head = next;
    }
  }

  /** Every message this Session sent to one child run, in any state. */
  messagesTo(childRunId: string): readonly SessionMessage[] {
    return this.store.authority
      .extensionRecordsInDomain('session_message')
      .map((entry) => parseSessionMessage(entry.record))
      .filter(
        (message) =>
          message.direction === 'outbound' &&
          message.route === 'to_child' &&
          message.childRunId === childRunId,
      );
  }

  /** The parent's messages to one child run that still owe their handover. */
  undeliveredMessagesTo(childRunId: string): number {
    return this.messagesTo(childRunId).filter(isUndeliveredMessage).length;
  }

  /**
   * One step on this funnel's writes chain. The body must commit through
   * the store directly: a verb of this class inside it would wait on the
   * chain it runs in.
   */
  serialized<T>(body: () => Promise<T>): Promise<T> {
    return this.inWrites(body);
  }

  /**
   * H4d-b: `send_message` to a child task. The routing decision and its
   * commit share the writes chain with settlement, so a message either
   * opens before the run settles (and holds the settlement until its
   * handover) or finds the run ended: a completed run is continued as a
   * new run with the message as its first prompt, any other ending is a
   * named refusal. A re-driven call names the same message or the same
   * continuation again.
   */
  sendToChild(params: {
    readonly taskId: string;
    readonly text: string;
    readonly messageId: string;
    readonly continuationRunId: string;
    readonly executionCallId: string;
    readonly closing: boolean;
    /** #13753 I2: the host serves child Workspaces, which a continued
     * worktree run needs as its first launch did; absent means it does not. */
    readonly childWorkspaces?: boolean;
  }): Promise<ChildMessageRoute> {
    return this.inWrites(async () => {
      const content = Buffer.from(params.text, 'utf8');
      const sent = this.store.authority.extensionRecord(
        'session_message',
        params.messageId,
      );
      if (sent !== undefined) {
        const message = parseSessionMessage(sent.record);
        if (
          message.direction !== 'outbound' ||
          message.route !== 'to_child' ||
          message.contentDigest !== sha256(content)
        ) {
          throw new ManagedSessionConflictError(
            `Session message ${params.messageId} was sent with different evidence.`,
          );
        }
        return { kind: 'message', childRunId: message.childRunId };
      }
      const continued = this.record(params.continuationRunId);
      if (continued !== undefined) {
        const envelope = decodeChildLaunchEnvelope(
          await this.store.resources.read(continued.inputRef),
        );
        if (
          continued.predecessorChildRunId === null ||
          envelope.prompt !== params.text
        ) {
          throw new ManagedSessionConflictError(
            `Child run ${params.continuationRunId} was launched with different evidence.`,
          );
        }
        return {
          kind: 'continuation',
          childRunId: continued.childRunId,
          predecessorChildRunId: continued.predecessorChildRunId,
        };
      }
      const run = this.runForTask(params.taskId);
      if (run === undefined) {
        return {
          kind: 'refused',
          reason: `No child agent task ${params.taskId} was launched by this Session.`,
        };
      }
      // The bound is the smaller carrier: the continuation's launch
      // envelope, built from the chain's own description and definition,
      // which no later state changes — so a running and a completed task
      // answer the same text alike.
      const launch = decodeChildLaunchEnvelope(
        await this.store.resources.read(run.inputRef),
      );
      let envelope: Buffer;
      try {
        envelope = encodeChildLaunchEnvelope({
          description: launch.description,
          prompt: params.text,
          definition: launch.definition,
        });
      } catch (cause) {
        if (!(cause instanceof ManagedSessionRecordError)) throw cause;
        return {
          kind: 'refused',
          reason: `Message exceeds what a child task can carry (byte_limit): keep it under ${MANAGED_CHILD_LIMITS.maxEnvelopeBytes} bytes with its launch description.`,
        };
      }
      const head = this.chainHead(run);
      const headTask = this.taskIdOf(head.childRunId);
      if (!isTerminalRunState(head.run.state)) {
        if (head.stopRequested) {
          return {
            kind: 'refused',
            reason: `Child agent task ${headTask} is being stopped and cannot receive messages.`,
          };
        }
        if (params.closing) {
          return {
            kind: 'refused',
            reason: 'This Session is closing and sends no more messages.',
          };
        }
        const sentBefore = this.messagesTo(head.childRunId);
        const limits = MANAGED_SESSION_MESSAGE_RUNTIME_LIMITS;
        if (sentBefore.length >= limits.maxPerRun) {
          return {
            kind: 'refused',
            reason: `Child agent task ${headTask} has received its ${limits.maxPerRun} messages (budget_exhausted).`,
          };
        }
        if (
          sentBefore.filter(isUndeliveredMessage).length >=
          limits.maxInFlightPerRun
        ) {
          return {
            kind: 'refused',
            reason: `Child agent task ${headTask} has ${limits.maxInFlightPerRun} messages still on their way to it (count_limit); wait for them to arrive.`,
          };
        }
        const contentRef = await this.store.resources.publish(
          'managed-message-content',
          content,
        );
        const body = outboundMessageBody({
          messageId: params.messageId,
          route: 'to_child',
          childRunId: head.childRunId,
          senderSessionId: this.key.sessionId,
          contentRef,
          executionCallId: params.executionCallId,
        });
        await this.store.authority.commitExtensionRecord(
          {
            operation: 'sendSessionMessage',
            commandId: `${params.messageId}:1`,
            sessionKey: this.key,
            contentDigest: digest(body),
          },
          { domain: 'session_message', record: body },
          TRUSTED,
        );
        return { kind: 'message', childRunId: head.childRunId };
      }
      if (head.stopReason !== 'completed' || head.stopRequested) {
        return {
          kind: 'refused',
          reason: `Child agent task ${headTask} ended (${head.run.state}: ${head.stopReason ?? 'unknown'}) and cannot receive messages; launch a new agent instead.`,
        };
      }
      // H4e-b1: a team's roster names one run of its member, so a
      // continuation would run off the roster, unlabeled and unseen by
      // team_delete; continued members come with H4e-b2. Only a launch
      // joins, so a member's run is never itself a continuation.
      const member = hostedTeamMembership(
        this.store.authority.extensionRecordsInDomain('team_state'),
        head.childRunId,
      );
      if (member !== undefined) {
        return {
          kind: 'refused',
          reason: `Child agent task ${headTask} ran as "${member.name}" of team "${member.teamName}" and has finished; a team member cannot be continued yet. Launch a new member with another name for more work.`,
        };
      }
      // A continuation is a launch: it owes the launch admission (H4d-a
      // decision 9), which neither the authority nor the store checks.
      const admission = childLaunchAdmission({
        workspaceMode: head.workspaceMode,
        childWorkspaces: params.childWorkspaces === true,
        sameDefinition: true,
        closing: params.closing,
        activeInScope: this.activeChildRunsOf(head.ownerScopeId).length,
        launchedInScope: this.launchedChildRunsOf(head.ownerScopeId).length,
        envelopeBytes: envelope.byteLength,
      });
      if (!admission.admitted) {
        return {
          kind: 'refused',
          reason: `Hosted child agent refused to continue task ${headTask} (${admission.reason}).`,
        };
      }
      const inputRef = await this.store.resources.publish(
        'managed-input',
        envelope,
      );
      const body = childContinuationBody(head, {
        childRunId: params.continuationRunId,
        completion: 'sent',
        inputRef,
        executionCallId: params.executionCallId,
      });
      await this.store.authority.commitExtensionRecord(
        {
          operation: 'continueChildRun',
          commandId: params.continuationRunId,
          sessionKey: this.key,
          contentDigest: digest(body),
        },
        { domain: 'child_run', record: body },
        TRUSTED,
      );
      return {
        kind: 'continuation',
        childRunId: params.continuationRunId,
        predecessorChildRunId: head.childRunId,
      };
    });
  }

  /**
   * Revision 1 (`startChildRun`): the launch intent, before any physical
   * side effect. The retried launch returns its opening command, so the
   * creation idempotency the control plane derives from this record can
   * never diverge from it.
   */
  async admit(params: ChildAgentLaunchParams): Promise<{
    readonly inputRef: ManagedSessionDurableRef;
    readonly envelope: ChildLaunchEnvelope;
  }> {
    const envelope: ChildLaunchEnvelope = {
      description: params.description,
      prompt: params.prompt,
      definition: params.definition,
    };
    const bytes = encodeChildLaunchEnvelope(envelope);
    // A restated launch names the same record: identical evidence is the
    // replay — anything else conflicts, never a second child chain.
    const existing = this.record(params.childRunId);
    if (existing !== undefined) {
      const sameEvidence =
        existing.ownerScopeId === params.ownerScopeId &&
        existing.rootSessionId === params.rootSessionId &&
        existing.completion === params.completion &&
        existing.workspaceMode === params.workspaceMode &&
        existing.workingDirectory === params.workingDirectory &&
        existing.run.executionCallId === params.executionCallId &&
        isDeepStrictEqual(existing.run.definition, params.definition) &&
        isDeepStrictEqual(
          await this.store.resources.read(existing.inputRef),
          bytes,
        );
      if (!sameEvidence) {
        throw new ManagedSessionConflictError(
          `Child run ${params.childRunId} was launched with different evidence.`,
        );
      }
      return { inputRef: existing.inputRef, envelope };
    }
    const inputRef = await this.store.resources.publish('managed-input', bytes);
    await this.commit(
      params.childRunId,
      childLaunchBody({
        childRunId: params.childRunId,
        ownerScopeId: params.ownerScopeId,
        rootSessionId: params.rootSessionId,
        completion: params.completion,
        inputRef,
        workspaceMode: params.workspaceMode,
        workingDirectory: params.workingDirectory,
        executionCallId: params.executionCallId,
        definition: params.definition,
      }),
      params.childRunId,
      'startChildRun',
    );
    return { inputRef, envelope };
  }

  /**
   * The control plane admitted the idempotent creation. Step-aware against
   * relays that restate finished work: an identical restatement is a no-op,
   * anything else conflicts instead of rewriting history.
   */
  dispatchStarted(
    childRunId: string,
    params: {
      readonly dispatchId: string;
      readonly runtime: {
        readonly runtimeBindingId: string;
        readonly generation: string;
      };
    },
  ): Promise<void> {
    return this.revise(childRunId, (previous) => {
      if (previous.run.execution !== 'intent') {
        if (
          previous.run.dispatchId === params.dispatchId &&
          isDeepStrictEqual(previous.run.runtime, params.runtime)
        ) {
          return previous;
        }
        throw new ManagedSessionConflictError(
          `Child run ${childRunId} was already dispatched differently.`,
        );
      }
      return childDispatchBody(previous, params);
    });
  }

  /** The child Session's Harness is confirmed live, once and identically. */
  attach(childRunId: string, childSessionId: string): Promise<void> {
    return this.revise(childRunId, (previous) => {
      if (previous.childSessionId !== null) {
        if (previous.childSessionId === childSessionId) return previous;
        throw new ManagedSessionConflictError(
          `Child run ${childRunId} is already attached to another Session.`,
        );
      }
      return childAttachBody(previous, { childSessionId });
    });
  }

  /**
   * `commitChildResult`: the unique logical terminal result. The parent's
   * copies are published before the settling revision may name them; a
   * result beyond the copy bound is refused here, before any commit.
   */
  async settleCompleted(
    childRunId: string,
    params: {
      readonly result: Buffer;
      readonly receipt: Buffer;
      /** The parent's messages to this run the caller saw before choosing
       * the result; a later one holds the settlement (H4d-b). */
      readonly messageCount?: number;
    },
  ): Promise<ManagedSessionDurableRef> {
    if (params.result.byteLength > MANAGED_CHILD_LIMITS.maxResultBytes) {
      throw new ManagedSessionRecordError(
        `Child result exceeds ${MANAGED_CHILD_LIMITS.maxResultBytes} bytes (byte_limit).`,
      );
    }
    // A reply lost after the settling revision committed leaves the
    // already-published copies readable: the replay reuses them after
    // proving byte equality, instead of minting new resources and a
    // terminal revision the successor rule must refuse. The read, guard,
    // publications and the commit all queue into the one writes chain,
    // so a racing settle can never scan a half-committed chain.
    const write = this.writes.then(async () => {
      const existing = this.store.authority.extensionRecord(
        'child_run',
        childRunId,
      );
      if (existing === undefined) {
        throw new Error(`Child run ${childRunId} has no record to revise.`);
      }
      const previous = this.parseAgent(existing.record, childRunId);
      if (previous.resultRef != null && previous.terminalReceiptRef != null) {
        const committedResult = await this.store.resources.read(
          previous.resultRef,
        );
        const committedReceipt = await this.store.resources.read(
          previous.terminalReceiptRef,
        );
        if (
          committedResult.equals(params.result) &&
          committedReceipt.equals(params.receipt)
        ) {
          return previous.resultRef;
        }
        throw new ManagedSessionConflictError(
          `Child run ${childRunId} was already settled with a different result.`,
        );
      }
      this.assertSettlementSawEveryMessage(
        childRunId,
        params.messageCount ?? 0,
      );
      const resultRef = await this.store.resources.publish(
        'managed-child-result',
        params.result,
      );
      const terminalReceiptRef = await this.store.resources.publish(
        'managed-runtime-receipt',
        params.receipt,
      );
      const next = childSettleCompletedBody(previous, {
        resultRef,
        terminalReceiptRef,
      });
      await this.store.authority.commitExtensionRecord(
        {
          operation: 'commitChildRunRecord',
          commandId: `${childRunId}:${existing.revision + 1}`,
          sessionKey: this.key,
          contentDigest: digest(next),
        },
        { domain: 'child_run', record: next },
        TRUSTED,
      );
      return resultRef;
    });
    this.writes = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  /** A proven failure; a pre-creation failure lands on not_started_proven. */
  settleFailed(
    childRunId: string,
    params: {
      readonly stopReason: Extract<
        ChildAgentStopReason,
        'creation_failed' | 'child_failed' | 'quota_exceeded'
      >;
      readonly reason: ChildAgentRun['run']['reason'];
      readonly started: boolean;
      readonly childSessionId?: string;
      /** Present when the caller chose the failure from the child's newest
       * turn; a give-up never waits on a message. */
      readonly messageCount?: number;
    },
  ): Promise<void> {
    return this.revise(childRunId, (previous) => {
      if (
        params.messageCount !== undefined &&
        !isTerminalRunState(previous.run.state)
      ) {
        this.assertSettlementSawEveryMessage(childRunId, params.messageCount);
      }
      return childFailBody(previous, params);
    });
  }

  /** A stop was requested of the owner; set once, never cleared. */
  requestStop(childRunId: string): Promise<void> {
    return this.revise(childRunId, (previous) =>
      childStopRequestedBody(previous),
    );
  }

  /** `cancelChildRun`/`closeChildScope`: the request was honored. */
  settleCancelled(
    childRunId: string,
    params: { readonly started: boolean; readonly childSessionId?: string },
  ): Promise<void> {
    return this.revise(childRunId, (previous) =>
      childCancelBody(previous, params),
    );
  }

  /**
   * `acceptChildResult`: the acceptance receipt. On the sent arm the same
   * transaction carries the notification input and the wake the authority
   * generates for it; on the tool arm the acceptance commits alone, and the
   * tool result folds the accepted delivery step into its own commit.
   */
  async accept(
    childRunId: string,
    params: { readonly notification?: { readonly description: string } } = {},
  ): Promise<ManagedSessionDurableRef> {
    // One serialization for all of: the replay check, both notification
    // resources, and the acceptance commit — a re-driven acceptance mints
    // nothing twice.
    return this.inWrites(async () => {
      const child = this.mustRecord(childRunId);
      const acceptance = childAcceptanceBody(child, {
        contentRef: child.resultRef!,
        terminalReceiptRef: child.terminalReceiptRef!,
      });
      const existing = this.store.authority.extensionRecord(
        'child_acceptance',
        childRunId,
      );
      if (
        existing !== undefined &&
        isDeepStrictEqual(existing.record, acceptance)
      ) {
        return child.resultRef!;
      }
      const notification =
        params.notification === undefined
          ? undefined
          : await this.buildResultNotification(
              childRunId,
              child,
              params.notification,
            );
      await this.store.authority.commitExtensionRecord(
        {
          operation: 'acceptChildResult',
          commandId: `${childRunId}:accept`,
          sessionKey: this.key,
          contentDigest: digest(acceptance),
        },
        {
          domain: 'child_acceptance',
          record: acceptance,
          ...(notification === undefined ? {} : { input: notification }),
        },
        TRUSTED,
      );
      return child.resultRef!;
    });
  }

  /**
   * The relay's independent step: the run's delivery reaches accepted. A
   * wake-turn consumption can outrun this commit: accepted or consumed is
   * already past, so it restates nothing, and anything else conflicts.
   */
  markAccepted(childRunId: string): Promise<void> {
    return this.revise(childRunId, (previous) => {
      const delivery = previous.run.delivery?.state;
      if (delivery === 'accepted' || delivery === 'consumed') return previous;
      if (delivery !== 'accepting') {
        throw new ManagedSessionConflictError(
          `Child run ${childRunId} cannot be accepted from ${delivery}.`,
        );
      }
      return childDeliveryBody(previous, 'accepted');
    });
  }

  /**
   * The consuming turn settled: the acceptance's delivery moves first, the
   * run's steps after it in order (the reverse check gates the run's steps
   * on the acceptance chain, never the other way). Each step is its own
   * revision — a wake turn can outrun the relay's accepted commit, so an
   * accepting run takes accepted and consumed as two commits here, and the
   * relay's later accepted is a no-op by the check above it.
   */
  async markConsumed(childRunId: string): Promise<void> {
    const acceptance = this.acceptance(childRunId);
    if (
      acceptance !== undefined &&
      acceptance.run.delivery?.state !== 'consumed'
    ) {
      await this.commitDomain(
        'child_acceptance',
        childRunId,
        childAcceptanceConsumedBody(acceptance),
        `${childRunId}:consume`,
        'acceptChildResult',
      );
    }
    await this.revise(childRunId, (previous) => {
      const delivery = previous.run.delivery?.state;
      if (delivery === 'consumed') return previous;
      if (delivery === 'accepted') {
        return childDeliveryBody(previous, 'consumed');
      }
      if (delivery === 'accepting') {
        return childDeliveryBody(previous, 'accepted');
      }
      throw new ManagedSessionConflictError(
        `Child run ${childRunId} cannot be consumed from ${delivery}.`,
      );
    });
    const after = this.mustRecord(childRunId);
    if (after.run.delivery?.state === 'accepted') {
      await this.revise(childRunId, (previous) =>
        childDeliveryBody(previous, 'consumed'),
      );
    }
  }

  private async buildResultNotification(
    childRunId: string,
    child: ChildAgentRun,
    params: { readonly description: string },
  ): Promise<ManagedSessionInputRequest> {
    const resultRef = child.resultRef;
    if (resultRef === null) {
      throw new Error(`Child run ${childRunId} has no result to notify.`);
    }
    const inputId = `${childRunId}:accept:notify`;
    // #13753 I2: a worktree child's receipt reports its merge, which the
    // waiting turn must see beside the result.
    const workspace =
      child.workspaceMode === 'worktree' && child.terminalReceiptRef !== null
        ? childWorkspaceOutcomeText(
            parseChildWorkspaceReceipt(
              await this.store.resources.read(child.terminalReceiptRef),
            ),
          )
        : undefined;
    return {
      inputId,
      turnId: inputId,
      source: 'child_agent',
      contentRef: await this.store.resources.publish(
        'managed-input',
        Buffer.from(
          JSON.stringify({
            text: childResultNotificationText({
              taskId: managedTaskId(
                managedExtensionRecordKey(
                  this.key.sessionId,
                  'child_run',
                  childRunId,
                ),
              ),
              description: params.description,
              text: (await this.store.resources.read(resultRef)).toString(
                'utf8',
              ),
              teammate: hostedTeamMembership(
                this.store.authority.extensionRecordsInDomain('team_state'),
                childRunId,
              )?.name,
              ...(workspace === undefined ? {} : { workspace }),
            }),
          }),
          'utf8',
        ),
      ),
      deadline: null,
      admissionRef: await this.store.resources.publish(
        'managed-admission',
        Buffer.from('{}', 'utf8'),
      ),
      wakeReason: 'input',
    };
  }

  /**
   * The settlement stands on the child's newest turn only if no message to
   * the run still owes its handover and none opened after the caller read
   * them: messages are never deleted, so a count above what the caller saw
   * is a message its choice of result could not have accounted for.
   */
  private assertSettlementSawEveryMessage(
    childRunId: string,
    messageCount: number,
  ): void {
    const messages = this.messagesTo(childRunId);
    const pending = messages.filter(isUndeliveredMessage).length;
    if (pending > 0 || messages.length > messageCount) {
      throw new ChildMessagesPendingError(
        `Child run ${childRunId} has ${messages.length} message(s), ${pending} still owing their handover; the settlement saw ${messageCount}.`,
      );
    }
  }

  private mustRecord(childRunId: string): ChildAgentRun {
    const record = this.record(childRunId);
    if (record === undefined) {
      throw new Error(`Child run ${childRunId} has no record to revise.`);
    }
    return record;
  }

  /** One queued chain: the replay check, the body and resource work, and
   * the commit, so a re-driven verb mints nothing twice. */
  private async inWrites<T>(body: () => Promise<T>): Promise<T> {
    const run = this.writes.then(body);
    this.writes = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private revise(
    childRunId: string,
    step: (previous: ChildAgentRun) => ChildAgentRun,
  ): Promise<void> {
    const write = this.writes.then(async () => {
      const existing = this.store.authority.extensionRecord(
        'child_run',
        childRunId,
      );
      const previousParsed =
        existing === undefined
          ? undefined
          : this.parseAgent(existing.record, childRunId);
      if (previousParsed === undefined) {
        throw new Error(`Child run ${childRunId} has no record to revise.`);
      }
      const next = step(previousParsed);
      if (isDeepStrictEqual(previousParsed, next)) return;
      await this.store.authority.commitExtensionRecord(
        {
          operation: 'commitChildRunRecord',
          commandId: `${childRunId}:${existing!.revision + 1}`,
          sessionKey: this.key,
          contentDigest: digest(next),
        },
        { domain: 'child_run', record: next },
        TRUSTED,
      );
    });
    this.writes = write.catch(() => undefined);
    return write;
  }

  private parseAgent(record: unknown, childRunId: string): ChildAgentRun {
    const parsed = parseChildRun(record);
    if (parsed.kind !== 'child_agent') {
      throw new Error(`Child run ${childRunId} is not a child agent.`);
    }
    return parsed;
  }

  private commit(
    childRunId: string,
    record: ChildAgentRun,
    commandId: string,
    operation: string,
  ): Promise<void> {
    return this.commitDomain(
      'child_run',
      childRunId,
      record,
      commandId,
      operation,
    );
  }

  private commitDomain(
    domain: 'child_run' | 'child_acceptance',
    recordId: string,
    record: unknown,
    commandId: string,
    operation: string,
    input?: ManagedSessionInputRequest,
  ): Promise<void> {
    const write = this.writes.then(async () => {
      const existing = this.store.authority.extensionRecord(domain, recordId);
      if (
        existing !== undefined &&
        domain === 'child_acceptance' &&
        isDeepStrictEqual(existing.record, record)
      ) {
        return;
      }
      await this.store.authority.commitExtensionRecord(
        {
          operation,
          commandId,
          sessionKey: this.key,
          contentDigest: digest(record),
        },
        { domain, record, ...(input === undefined ? {} : { input }) },
        TRUSTED,
      );
    });
    this.writes = write.catch(() => undefined);
    return write;
  }
}
