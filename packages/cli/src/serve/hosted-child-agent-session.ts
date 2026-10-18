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
  childRecoveryBlockedBody,
  childSettleCompletedBody,
  childStopRequestedBody,
  decodeChildLaunchEnvelope,
  encodeChildLaunchEnvelope,
  encodeWorkflowLaunchEnvelope,
  workflowLaunchBody,
  type ChildAdmission,
  type ChildLaunchEnvelope,
  type WorkflowLaunchEnvelope,
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
import { managedChildTaskId } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-projection.js';
import { escapeXml } from '@qwen-code/qwen-code-core/utils/xml.js';
import { hostedTeamMembership } from './hosted-team-session.js';
import { parseTeamPlan } from '@qwen-code/qwen-code-core/managed-runtime/managed-team-record.js';
import { parseSessionCommand } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-command-record.js';
import {
  HOSTED_MEMBER_MESSAGE_IN_FLIGHT,
  HOSTED_MEMBER_MESSAGE_PER_RUN,
  HostedChildChains,
  hostedMemberView,
  hostedOpenTeamChainMember,
  hostedRouteDetails,
  isSentInstruction,
  MEMBER_MESSAGE_ID_PREFIX,
  memberPlanModeRequired,
  teamMemberPreamble,
  type HostedRouteDetails,
} from './hosted-member-chain.js';
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

/**
 * The workflow launch (#13803 decision 3): the script the child executes
 * and its arguments ride the envelope; the pin the admission computed from
 * those exact bytes opens the chain (K3).
 */
export interface WorkflowLaunchParams {
  readonly childRunId: string;
  readonly ownerScopeId: string;
  readonly rootSessionId: string;
  readonly completion: ChildCompletion;
  readonly script: string;
  readonly args: unknown;
  readonly definition: DefinitionPin;
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
  /** #13753 I3: it also serves read-only snapshots. */
  readonly childSnapshots: boolean;
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
    childSnapshots: params.childSnapshots,
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
 * #13753 I2: what a foreground answer ends with for a worktree run that
 * started and then failed or was cancelled. Such a record has no receipt,
 * so the line claims an order, never a landing: the relay settles the run
 * only after a merge it asked for (the child had finished its work) has
 * its outcome, so what landed is already visible here, and what did not
 * may be kept at the result ref. Empty for a `shared` run and for one
 * that never started.
 */
export function childWorkspaceEndedSuffix(record: ChildSessionRun): string {
  if (record.workspaceMode !== 'worktree' || record.run.execution !== 'settled')
    return '';
  return "\n\n[child workspace] the child's changes did not land, unless the child had finished its work before this end and its merge landed them here. Inspect this Workspace before relying on the child's changes; work that did not land may be kept under refs/qwen/child-workspaces/.";
}

/** The model-facing name of a child Session kind, defined once so every
 * answer about a run names the kind its record carries. */
export function childKindLabel(
  kind: ChildSessionRun['kind'],
): 'Child agent' | 'Workflow child' {
  return kind === 'workflow' ? 'Workflow child' : 'Child agent';
}

/**
 * #13753 I2: the one-line end of an ended child run's answer, with its
 * workspace suffix. The live answer and the recovery gap fill must agree
 * (decision 7), so the sentence is defined once, here, and names the kind
 * the record itself carries.
 */
export function childRunEndedText(record: ChildSessionRun): string {
  // #14387: a blocked run never ended — its outcome is unwitnessed, so the
  // sentence says blocked, never a terminal shape it did not take.
  const blocked = record.run.state === 'recovery_blocked';
  const state = blocked
    ? 'recovery blocked'
    : record.run.state.replace(/^\w/, (letter) => letter.toLowerCase());
  const reason = blocked ? 'outcome unknown' : (record.stopReason ?? 'unknown');
  return `${childKindLabel(record.kind)} run ${state} (${reason}).${childWorkspaceEndedSuffix(record)}`;
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
  /** The record kind of the child that finished ('child_agent' | 'workflow'). */
  readonly kind: 'child_agent' | 'workflow';
  readonly description: string;
  readonly text: string;
  /** H4e-b1: the member name of a child run on a team roster. */
  readonly teammate?: string;
  /** #13753 I2: a worktree child's merge outcome, already rendered. */
  readonly workspace?: string;
  readonly plan?: {
    readonly requestId: string;
    readonly revision: number;
    readonly text: string;
  };
}): string {
  const label = childKindLabel(params.kind);
  const head = [
    '<task-notification>',
    `<task-id>${escapeXml(params.taskId)}</task-id>`,
    `<kind>${params.kind}</kind>`,
    ...(params.teammate === undefined
      ? []
      : [`<teammate>${escapeXml(params.teammate)}</teammate>`]),
    '<status>completed</status>',
    ...(params.workspace === undefined
      ? []
      : [`<workspace>${escapeXml(params.workspace)}</workspace>`]),
    `<summary>${label} "${escapeXml(truncateNotificationLabel(params.description))}" finished.</summary>`,
    ...(params.plan === undefined
      ? []
      : [
          `<plan-approval-request request="${escapeXml(params.plan.requestId)}" revision="${params.plan.revision}">\n${escapeXml(params.plan.text)}\n</plan-approval-request>`,
        ]),
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

/**
 * Where `send_message` to a child task went, with what its answer must
 * tell about the run it reached (H4e-b2), read on the writes chain.
 */
export type ChildMessageRoute =
  | ({
      readonly kind: 'message';
      readonly childRunId: string;
    } & HostedRouteDetails)
  | ({
      readonly kind: 'continuation';
      readonly childRunId: string;
      readonly predecessorChildRunId: string;
    } & HostedRouteDetails)
  | { readonly kind: 'refused'; readonly reason: string };

export class HostedChildAgentSession {
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: HostedChildAgentStore,
    private readonly key: ManagedSessionKey,
  ) {}

  /** The last committed body of one child run, parsed. Both child Session
   * kinds answer: the relay and cascade verbs are kind-blind (#13803 K2). */
  record(childRunId: string): ChildSessionRun | undefined {
    const existing = this.store.authority.extensionRecord(
      'child_run',
      childRunId,
    );
    if (existing === undefined) return undefined;
    const record = parseChildRun(existing.record);
    return isChildSessionRun(record) ? record : undefined;
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
  launchedChildRunsOf(
    ownerScopeId: string,
    chains?: HostedChildChains,
  ): readonly ChildSessionRun[] {
    const runs =
      chains?.runs() ??
      this.store.authority
        .extensionRecordsInDomain('child_run')
        .map((entry) => parseChildRun(entry.record))
        .filter(isChildSessionRun);
    return runs.filter((record) => record.ownerScopeId === ownerScopeId);
  }

  /** The non-terminal child Session runs of one owner scope. */
  activeChildRunsOf(
    ownerScopeId: string,
    chains?: HostedChildChains,
  ): readonly ChildSessionRun[] {
    return this.launchedChildRunsOf(ownerScopeId, chains).filter(
      (record) =>
        !isTerminalRunState(record.run.state) &&
        // #14387: a recovery-blocked run is parked — evidence of an
        // unwitnessed execution, never live work — so it does not hold a
        // launch-admission slot (matching the relay's hasLiveTurn gate).
        record.run.state !== 'recovery_blocked',
    );
  }

  /** The task id a launch answered for one child run. */
  taskIdOf(childRunId: string): string {
    return managedChildTaskId(this.key.sessionId, childRunId);
  }

  /** The child agent run one task id names, of any chain generation. */
  runForTask(
    taskId: string,
    chains?: HostedChildChains,
  ): ChildAgentRun | undefined {
    const runs =
      chains?.runs() ??
      this.store.authority
        .extensionRecordsInDomain('child_run')
        .map((entry) => parseChildRun(entry.record));
    for (const record of runs) {
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
  chainHead(
    run: ChildAgentRun,
    chains: HostedChildChains = new HostedChildChains(
      this.store.authority.extensionRecordsInDomain('child_run'),
    ),
  ): ChildAgentRun {
    // One definition of the head serves this routing and H4e-b2's member
    // views alike. A chain starts at a committed run and the authority
    // keeps a continuation's kind, so its head is a child agent run.
    const head = chains.head(run.childRunId);
    const record = head && this.record(head.childRunId);
    if (record === undefined)
      throw new Error(`Child run ${run.childRunId} has no chain head.`);
    if (record.kind !== 'child_agent')
      throw new Error(
        `Child run ${run.childRunId} chains back to a workflow run.`,
      );
    return record;
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
    /** A plan decision can only launch a continuation, never send a message. */
    readonly continuationOnly?: boolean;
    /** Run all continuation checks without publishing or committing. */
    readonly preflight?: boolean;
    readonly planDecision?: {
      readonly requestId: string;
      readonly decision: 'approved' | 'rejected';
      readonly childRunId: string;
    };
    /** #13753 I3: the host also serves snapshots, which a continued
     * snapshot run needs likewise. */
    readonly childSnapshots?: boolean;
  }): Promise<ChildMessageRoute> {
    return this.inWrites(async () => {
      const content = Buffer.from(params.text, 'utf8');
      const sent = this.store.authority.extensionRecord(
        'session_message',
        params.messageId,
      );
      if (sent !== undefined && !params.continuationOnly && !params.preflight) {
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
        return this.routed(
          { kind: 'message', childRunId: message.childRunId },
          params.messageId,
        );
      }
      const continued = this.record(params.continuationRunId);
      if (continued !== undefined) {
        const envelope = decodeChildLaunchEnvelope(
          await this.store.resources.read(continued.inputRef),
        );
        // H4e-b2 decision 5: a member's continuation opens with its
        // preamble, whose presence follows the team and may have changed
        // since, so the committed instruction is read for its form.
        if (
          continued.predecessorChildRunId === null ||
          !isSentInstruction(envelope.prompt, params.text)
        ) {
          throw new ManagedSessionConflictError(
            `Child run ${params.continuationRunId} was launched with different evidence.`,
          );
        }
        return this.routed({
          kind: 'continuation',
          childRunId: continued.childRunId,
          predecessorChildRunId: continued.predecessorChildRunId,
        });
      }
      const chains = new HostedChildChains(
        this.store.authority.extensionRecordsInDomain('child_run'),
      );
      const run = this.runForTask(params.taskId, chains);
      if (run === undefined) {
        // A workflow child's task id is a real task — the refusal says why
        // it takes no message instead of denying it exists.
        const workflow = this.store.authority
          .extensionRecordsInDomain('child_run')
          .map((entry) => parseChildRun(entry.record))
          .some(
            (record) =>
              record.kind === 'workflow' &&
              this.taskIdOf(record.childRunId) === params.taskId,
          );
        return {
          kind: 'refused',
          reason: workflow
            ? `Task ${params.taskId} is a workflow child, which takes no messages in this profile; read its task surface instead.`
            : `No child agent task ${params.taskId} was launched by this Session.`,
        };
      }
      // A continuation that never started is no head and left its
      // predecessor untouched (H4d-a decision 9), so its task id routes
      // from that predecessor: an answer that named it must still reach
      // the chain, never read as an ended child.
      let from = run;
      while (
        from.run.execution === 'not_started_proven' &&
        from.predecessorChildRunId !== null
      ) {
        const predecessor = this.record(from.predecessorChildRunId);
        if (predecessor === undefined || predecessor.kind !== 'child_agent')
          break;
        from = predecessor;
      }
      // H4e-b2 decision 2: a run of an open team member's chain is that
      // member, and every continuation of it opens its instruction with
      // the member preamble (decision 5).
      const member = hostedOpenTeamChainMember(
        this.store.authority.extensionRecordsInDomain('team_state'),
        chains,
        from.childRunId,
      );
      const planDecision = params.planDecision;
      if (planDecision !== undefined) {
        const stored = this.store.authority.extensionRecord(
          'team_plan',
          planDecision.requestId,
        );
        const plan =
          stored === undefined ? undefined : parseTeamPlan(stored.record);
        if (
          member === undefined ||
          member.team.lifecycle !== 'active' ||
          plan?.teamId !== member.team.teamId ||
          plan.member !== member.name ||
          (params.preflight
            ? plan.run.state !== 'waiting'
            : plan.decision !== planDecision.decision)
        ) {
          return {
            kind: 'refused',
            reason:
              'The plan decision no longer belongs to an eligible active member.',
          };
        }
        if (
          this.store.authority
            .extensionRecordsInDomain('team_plan')
            .some((entry) => {
              const other = parseTeamPlan(entry.record);
              return (
                other.teamId === plan.teamId &&
                other.member === plan.member &&
                other.planRevision > plan.planRevision
              );
            })
        )
          return {
            kind: 'refused',
            reason: 'Only the newest plan may continue the member.',
          };
      }
      const instruction =
        member === undefined
          ? params.text
          : // H4e-b3 decision 9: plan mode follows the roster entry until an
            // approved plan of this member exists; team_plan stays disabled
            // here, so the read only ever sees a b3d journal's records.
            teamMemberPreamble(
              {
                name: member.name,
                teamName: member.team.name,
              },
              !(params.preflight && planDecision?.decision === 'approved') &&
                memberPlanModeRequired(
                  member.team,
                  this.store.authority.extensionRecordsInDomain('team_plan'),
                  member.name,
                ),
            ) + params.text;
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
          prompt: instruction,
          definition: launch.definition,
        });
      } catch (cause) {
        if (!(cause instanceof ManagedSessionRecordError)) throw cause;
        return {
          kind: 'refused',
          reason:
            member === undefined
              ? `Message exceeds what a child task can carry (byte_limit): keep it under ${MANAGED_CHILD_LIMITS.maxEnvelopeBytes} bytes with its launch description.`
              : `Message exceeds what a child task can carry (byte_limit): keep it under ${MANAGED_CHILD_LIMITS.maxEnvelopeBytes} bytes together with its launch description and the member preamble every continuation of "${member.name}" carries.`,
        };
      }
      const head = this.chainHead(from, chains);
      if (
        planDecision !== undefined &&
        head.childRunId !== planDecision.childRunId
      ) {
        return {
          kind: 'refused',
          reason:
            'The member head changed before the decision could be delivered.',
        };
      }
      const headTask = this.taskIdOf(head.childRunId);
      // H4e-b2 decision 3: a member's refusal names the member.
      const subject =
        member === undefined
          ? `Child agent task ${headTask}`
          : `Member "${member.name}" (task ${headTask})`;
      if (!isTerminalRunState(head.run.state)) {
        if (params.continuationOnly || params.preflight) {
          return {
            kind: 'refused',
            reason: `Decide after ${subject}'s run settles.`,
          };
        }
        if (head.stopRequested) {
          return {
            kind: 'refused',
            reason:
              member === undefined
                ? `${subject} is being stopped and cannot receive messages.`
                : head.predecessorChildRunId !== null &&
                    head.childSessionId === null
                  ? // Stopped before it attached, it may end without
                    // starting, which hands the member back to its
                    // predecessor.
                    `Member "${member.name}" is being stopped before its latest continuation started and cannot receive messages now. If that continuation ends without starting, the member takes messages again: check task_list once it settles.`
                  : `Member "${member.name}" is being stopped and cannot receive messages.`,
          };
        }
        if (params.closing) {
          return {
            kind: 'refused',
            reason: 'This Session is closing and sends no more messages.',
          };
        }
        // #13753 I3: a snapshot child has no message lane, so nothing may
        // be committed that it could never receive; once it completes, a
        // message continues it as a new snapshot run. It sits below the
        // closing arm because a closing Session admits no continuation.
        if (head.workspaceMode === 'snapshot') {
          return {
            kind: 'refused',
            reason: `${subject} is a read-only snapshot and takes no messages while it runs. Wait for its result; a message sent after it completes continues it as a new snapshot.`,
          };
        }
        const sentBefore = this.messagesTo(head.childRunId);
        const limits = MANAGED_SESSION_MESSAGE_RUNTIME_LIMITS;
        if (sentBefore.length >= limits.maxPerRun) {
          return {
            kind: 'refused',
            reason: `${subject} has received its ${limits.maxPerRun} messages (budget_exhausted).`,
          };
        }
        if (
          sentBefore.filter(isUndeliveredMessage).length >=
          limits.maxInFlightPerRun
        ) {
          return {
            kind: 'refused',
            reason: `${subject} has ${limits.maxInFlightPerRun} messages still on their way to it (count_limit); wait for them to arrive.`,
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
        return this.routed(
          { kind: 'message', childRunId: head.childRunId },
          params.messageId,
          chains,
        );
      }
      if (head.stopReason !== 'completed' || head.stopRequested) {
        // A member is relaunched under a new name: a plain agent launch
        // would not join the team.
        return {
          kind: 'refused',
          reason:
            member === undefined
              ? `${subject} ended (${head.run.state}: ${head.stopReason ?? 'unknown'}) and cannot receive messages; launch a new agent instead.`
              : head.stopReason === 'completed'
                ? `Member "${member.name}" completed after a stop was requested and cannot receive messages; for more work, launch a new member under a new name.`
                : `Member "${member.name}" ended (${head.run.state}: ${head.stopReason ?? 'unknown'}) and cannot receive messages; for more work, launch a new member under a new name.`,
        };
      }
      // H4e-b2 decision 2: a member of an active team is continued like
      // any child, and the roster follows its chain. A closing team admits
      // no new work while it drains (H4e-a decision 8); once its team is
      // deleted, a former member continues as a plain child.
      if (member !== undefined && member.team.lifecycle !== 'active') {
        return {
          kind: 'refused',
          reason: `Member "${member.name}" (task ${headTask}) belongs to team "${member.team.name}", which is closing and takes no new work. Finish it with team_delete.`,
        };
      }
      // A continuation is a launch: it owes the launch admission (H4d-a
      // decision 9), which neither the authority nor the store checks.
      const admission = childLaunchAdmission({
        workspaceMode: head.workspaceMode,
        childWorkspaces: params.childWorkspaces === true,
        childSnapshots: params.childSnapshots === true,
        sameDefinition: true,
        closing: params.closing,
        activeInScope: this.activeChildRunsOf(head.ownerScopeId, chains).length,
        launchedInScope: this.launchedChildRunsOf(head.ownerScopeId, chains)
          .length,
        envelopeBytes: envelope.byteLength,
      });
      if (!admission.admitted) {
        return {
          kind: 'refused',
          reason:
            member === undefined
              ? `Hosted child agent refused to continue task ${headTask} (${admission.reason}).`
              : `Hosted child agent refused to continue member "${member.name}" (task ${headTask}) (${admission.reason}).`,
        };
      }
      if (params.preflight) {
        return this.routed(
          {
            kind: 'continuation',
            childRunId: head.childRunId,
            predecessorChildRunId: head.childRunId,
          },
          undefined,
          chains,
        );
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
      chains.add(body);
      return this.routed(
        {
          kind: 'continuation',
          childRunId: params.continuationRunId,
          predecessorChildRunId: head.childRunId,
        },
        undefined,
        chains,
      );
    });
  }

  /** A committed route with what its answer must tell (H4e-b2). */
  private routed<
    Route extends {
      readonly kind: 'message' | 'continuation';
      readonly childRunId: string;
    },
  >(
    route: Route,
    messageId?: string,
    chains?: HostedChildChains,
  ): Route & HostedRouteDetails {
    return {
      ...route,
      ...hostedRouteDetails(this.store.authority, route, messageId, chains),
    };
  }

  /**
   * H4e-b3 decision 8 (b3c): the running-only send of one member message,
   * executed on the lead's funnels for one roster position of its open
   * team. The head check and the commit ride this one writes chain, so
   * the recipient's state cannot change between them. The send never
   * routes to a continuation and never spends H4b's active cap or H4c's
   * launch budget: a finished, ended or stopping head is not reached.
   * Member messages share H4d-b's 8 in flight and 64 per run on the head
   * with the lead's own, capped to 4 in flight and 16 in all. A re-driven
   * send names the same `msgc_` id with the same content and is answered
   * sent, so nothing is sent twice.
   */
  sendToRunningMember(params: {
    /** The roster entry's run: the launch the recipient's chain started from. */
    readonly rootChildRunId: string;
    readonly content: Buffer;
    readonly messageId: string;
    /** The `member_message` command that sends it. */
    readonly executionCallId: string;
  }): Promise<
    | { readonly kind: 'sent' }
    | {
        readonly kind: 'notReached';
        readonly reason:
          | 'finished'
          | 'ended'
          | 'stopping'
          | 'budget_exhausted'
          | 'count_limit'
          | 'member_budget'
          | 'member_count_limit'
          | 'completed_after_stop';
      }
  > {
    return this.inWrites(async () => {
      const sent = this.store.authority.extensionRecord(
        'session_message',
        params.messageId,
      );
      if (sent !== undefined) {
        const message = parseSessionMessage(sent.record);
        if (
          message.direction === 'outbound' &&
          message.route === 'to_child' &&
          message.contentDigest === sha256(params.content)
        ) {
          return { kind: 'sent' };
        }
        throw new ManagedSessionConflictError(
          `Session message ${params.messageId} was sent with different evidence.`,
        );
      }
      const chains = new HostedChildChains(
        this.store.authority.extensionRecordsInDomain('child_run'),
      );
      const view = hostedMemberView(chains, params.rootChildRunId);
      const head = view.head;
      if (
        head === undefined ||
        view.state === 'failed' ||
        view.state === 'cancelled'
      ) {
        return { kind: 'notReached', reason: 'ended' };
      }
      // R1-3: a completed head that was stopped before completing is not
      // the `finished` case — the leader cannot continue it either.
      if (view.stopRequestedCompletion) {
        return { kind: 'notReached', reason: 'completed_after_stop' };
      }
      if (view.state === 'completed') {
        return { kind: 'notReached', reason: 'finished' };
      }
      if (view.stopping) {
        return { kind: 'notReached', reason: 'stopping' };
      }
      const sentBefore = this.messagesTo(head.childRunId);
      const limits = MANAGED_SESSION_MESSAGE_RUNTIME_LIMITS;
      if (sentBefore.length >= limits.maxPerRun) {
        return { kind: 'notReached', reason: 'budget_exhausted' };
      }
      if (
        sentBefore.filter(isUndeliveredMessage).length >=
        limits.maxInFlightPerRun
      ) {
        return { kind: 'notReached', reason: 'count_limit' };
      }
      const memberSent = sentBefore.filter((message) =>
        message.messageId.startsWith(MEMBER_MESSAGE_ID_PREFIX),
      );
      if (memberSent.length >= HOSTED_MEMBER_MESSAGE_PER_RUN) {
        return { kind: 'notReached', reason: 'member_budget' };
      }
      if (
        memberSent.filter(isUndeliveredMessage).length >=
        HOSTED_MEMBER_MESSAGE_IN_FLIGHT
      ) {
        return { kind: 'notReached', reason: 'member_count_limit' };
      }
      const contentRef = await this.store.resources.publish(
        'managed-message-content',
        params.content,
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
      return { kind: 'sent' };
    });
  }

  /**
   * Revision 1 (`startChildRun`): the launch intent, before any physical
   * side effect. The retried launch returns its opening command, so the
   * creation idempotency the control plane derives from this record can
   * never diverge from it.
   */
  async admit(
    params: ChildAgentLaunchParams & {
      /**
       * H4e-b2 decision 5: the prompt the model sent, when `prompt` opens
       * with a member preamble. A replay accepts a committed prompt that is
       * the sent one alone or behind one well-formed preamble block, since
       * whether the launch carries one follows a team that may have changed
       * since, and goes on with the committed envelope as it is.
       */
      readonly sentPrompt?: string;
    },
  ): Promise<{
    readonly inputRef: ManagedSessionDurableRef;
    readonly envelope: ChildLaunchEnvelope;
  }> {
    const envelope: ChildLaunchEnvelope = {
      description: params.description,
      prompt: params.prompt,
      definition: params.definition,
    };
    const replay = await this.admitLaunch(params, {
      bytes: () => encodeChildLaunchEnvelope(envelope),
      matches: (committedBytes) => {
        const committed = decodeChildLaunchEnvelope(committedBytes);
        const sentPrompt = params.sentPrompt ?? params.prompt;
        return (
          committed.description === params.description &&
          isDeepStrictEqual(committed.definition, params.definition) &&
          (committed.prompt === params.prompt ||
            isSentInstruction(committed.prompt, sentPrompt))
        );
      },
      build: (inputRef) =>
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
    });
    return replay.committedBytes === undefined
      ? { inputRef: replay.inputRef, envelope }
      : {
          inputRef: replay.inputRef,
          envelope: decodeChildLaunchEnvelope(replay.committedBytes),
        };
  }

  /**
   * Revision 1 of a `workflow` launch (#13803 K1): same discipline as
   * {@link admit}, with the workflow envelope and the pin opening the chain.
   */
  async admitWorkflow(params: WorkflowLaunchParams): Promise<{
    readonly inputRef: ManagedSessionDurableRef;
    readonly envelope: WorkflowLaunchEnvelope;
  }> {
    const envelope: WorkflowLaunchEnvelope = {
      definition: params.definition,
      script: params.script,
      args: params.args ?? null,
    };
    const { inputRef } = await this.admitLaunch(
      { ...params, workspaceMode: 'shared' as const },
      {
        bytes: () => encodeWorkflowLaunchEnvelope(envelope),
        build: (inputRef) =>
          workflowLaunchBody({
            childRunId: params.childRunId,
            ownerScopeId: params.ownerScopeId,
            rootSessionId: params.rootSessionId,
            completion: params.completion,
            inputRef,
            workingDirectory: params.workingDirectory,
            executionCallId: params.executionCallId,
            definition: params.definition,
          }),
      },
    );
    return { inputRef, envelope };
  }

  /** A restated launch names the same record. The shared launch path of
   * both kinds — publish, commit, replay by matching evidence (byte
   * identity, or the sent-instruction reading a restated child launch
   * tolerates): anything else conflicts, never a second chain. */
  private async admitLaunch(
    params: {
      readonly childRunId: string;
      readonly ownerScopeId: string;
      readonly rootSessionId: string;
      readonly completion: ChildCompletion;
      readonly definition: DefinitionPin;
      readonly workspaceMode: ChildWorkspaceMode;
      readonly workingDirectory: string;
      readonly executionCallId: string;
    },
    prepared: {
      /** Encoded only where a fresh launch publishes them (or the default
       * matcher compares them): a replay restating a launch whose encoding
       * would now pass the envelope bound still names its committed record
       * (#13858 R3-4). */
      readonly bytes: () => Buffer;
      readonly build: (inputRef: ManagedSessionDurableRef) => ChildSessionRun;
      readonly matches?: (committedBytes: Buffer) => boolean;
    },
  ): Promise<{
    readonly inputRef: ManagedSessionDurableRef;
    readonly committedBytes?: Buffer;
  }> {
    const existing = this.record(params.childRunId);
    if (existing !== undefined) {
      const committedBytes = await this.store.resources.read(existing.inputRef);
      const matches =
        prepared.matches ??
        ((candidate: Buffer) => isDeepStrictEqual(candidate, prepared.bytes()));
      const sameEvidence =
        existing.ownerScopeId === params.ownerScopeId &&
        existing.rootSessionId === params.rootSessionId &&
        existing.completion === params.completion &&
        existing.workspaceMode === params.workspaceMode &&
        existing.workingDirectory === params.workingDirectory &&
        existing.run.executionCallId === params.executionCallId &&
        isDeepStrictEqual(existing.run.definition, params.definition) &&
        matches(committedBytes);
      if (!sameEvidence) {
        throw new ManagedSessionConflictError(
          `Child run ${params.childRunId} was launched with different evidence.`,
        );
      }
      return { inputRef: existing.inputRef, committedBytes };
    }
    const inputRef = await this.store.resources.publish(
      'managed-input',
      prepared.bytes(),
    );
    await this.commit(
      params.childRunId,
      prepared.build(inputRef),
      params.childRunId,
      'startChildRun',
    );
    return { inputRef };
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
      const previous = this.parseSessionRun(existing.record, childRunId);
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
      readonly reason: ChildSessionRun['run']['reason'];
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

  /**
   * #14387: the Harness generation running this child was lost and the
   * in-process execution's outcome stays unwitnessed (a workflow's
   * node:vm work leaves no witness on a new generation). The record
   * settles blocked — never re-executed, never failed as if observed. A
   * background (sent) child owes its parent the blocked line — it never
   * produces a result, so the notification rides this commit.
   */
  settleRecoveryBlocked(
    childRunId: string,
    params: {
      readonly reason: ChildSessionRun['run']['reason'];
      readonly childSessionId?: string;
    },
  ): Promise<void> {
    return this.inWrites(async () => {
      const existing = this.store.authority.extensionRecord(
        'child_run',
        childRunId,
      );
      if (existing === undefined) {
        throw new Error(`Child run ${childRunId} has no record to revise.`);
      }
      const previous = this.parseSessionRun(existing.record, childRunId);
      const next = childRecoveryBlockedBody(previous, params);
      if (isDeepStrictEqual(previous, next)) return;
      // The line renders the blocked revision this commit lands, never
      // the running one it replaces (#14165 FG10d).
      const notification =
        previous.completion === 'sent'
          ? await this.buildBlockedNotification(childRunId, next)
          : undefined;
      await this.store.authority.commitExtensionRecord(
        {
          operation: 'commitChildRunRecord',
          commandId: `${childRunId}:${existing.revision + 1}`,
          sessionKey: this.key,
          contentDigest: digest(next),
        },
        {
          domain: 'child_run',
          record: next,
          ...(notification === undefined ? {} : { input: notification }),
        },
        TRUSTED,
      );
    });
  }

  /** The blocked line for a background child, which never has a result. */
  private async buildBlockedNotification(
    childRunId: string,
    child: ChildSessionRun,
  ): Promise<ManagedSessionInputRequest> {
    const inputId = `${childRunId}:blocked:notify`;
    const label = child.run.definition?.definitionId ?? child.childRunId;
    const text = [
      '<task-notification>',
      `<task-id>${escapeXml(this.taskIdOf(childRunId))}</task-id>`,
      `<kind>${child.kind}</kind>`,
      '<status>blocked</status>',
      `<summary>${childKindLabel(child.kind)} "${escapeXml(truncateNotificationLabel(label))}" recovery blocked (outcome unknown).</summary>`,
      '<result>',
      escapeXml(childRunEndedText(child)),
      '</result>',
      '</task-notification>',
    ].join('\n');
    return {
      inputId,
      turnId: inputId,
      source: child.kind,
      contentRef: await this.store.resources.publish(
        'managed-input',
        Buffer.from(JSON.stringify({ text }), 'utf8'),
      ),
      deadline: null,
      admissionRef: await this.store.resources.publish(
        'managed-admission',
        Buffer.from('{}', 'utf8'),
      ),
      wakeReason: 'input',
    };
  }

  /** A stop was requested of the owner; set once, never cleared. */
  requestStop(
    childRunId: string,
    /**
     * H4e-b3 b3a: evidence identifying the tool call that requested this
     * stop, so an interrupted turn's recovery tells "my caller committed
     * it" from someone else's. The default keeps the revision-shaped id
     * the user-facing cancel paths use.
     */
    evidence?: { readonly operation: string; readonly commandId: string },
  ): Promise<void> {
    return this.revise(
      childRunId,
      (previous) => childStopRequestedBody(previous),
      evidence,
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
    child: ChildSessionRun,
    params: { readonly description: string },
  ): Promise<ManagedSessionInputRequest> {
    const resultRef = child.resultRef;
    if (resultRef === null) {
      throw new Error(`Child run ${childRunId} has no result to notify.`);
    }
    const inputId = `${childRunId}:accept:notify`;
    const submitted = new Set(
      this.store.authority
        .extensionRecordsInDomain('session_command')
        .map((entry) => parseSessionCommand(entry.record))
        .filter(
          (command) =>
            command.direction === 'inbound' &&
            command.childRunId === childRunId &&
            command.kind === 'plan_submit',
        )
        .map((command) => command.commandId),
    );
    const waiting = this.store.authority
      .extensionRecordsInDomain('team_plan')
      .map((entry) => parseTeamPlan(entry.record))
      .find(
        (plan) => submitted.has(plan.requestId) && plan.run.state === 'waiting',
      );
    const plan =
      waiting === undefined
        ? undefined
        : {
            requestId: waiting.requestId,
            revision: waiting.planRevision,
            text: (await this.store.resources.read(waiting.planRef)).toString(
              'utf8',
            ),
          };
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
      // The source names the record kind that produced the result; the
      // wake and consumption predicates admit both (#13803 K2).
      source: child.kind,
      contentRef: await this.store.resources.publish(
        'managed-input',
        Buffer.from(
          JSON.stringify({
            text: childResultNotificationText({
              taskId: this.taskIdOf(childRunId),
              kind: child.kind,
              description: params.description,
              text: (await this.store.resources.read(resultRef)).toString(
                'utf8',
              ),
              // A run keeps the label of the roster it joined, so a result
              // accepted after its team was deleted still names its member.
              // H4e-b2 decision 6: a continuation is labeled through its
              // chain root while that root is on the open team's roster.
              teammate:
                hostedTeamMembership(
                  this.store.authority.extensionRecordsInDomain('team_state'),
                  childRunId,
                )?.name ??
                hostedOpenTeamChainMember(
                  this.store.authority.extensionRecordsInDomain('team_state'),
                  new HostedChildChains(
                    this.store.authority.extensionRecordsInDomain('child_run'),
                  ),
                  childRunId,
                )?.name,
              ...(workspace === undefined ? {} : { workspace }),
              ...(plan === undefined ? {} : { plan }),
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

  private mustRecord(childRunId: string): ChildSessionRun {
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
    step: (previous: ChildSessionRun) => ChildSessionRun,
    evidence?: {
      readonly operation?: string;
      readonly commandId?: string;
    },
  ): Promise<void> {
    const write = this.writes.then(async () => {
      const existing = this.store.authority.extensionRecord(
        'child_run',
        childRunId,
      );
      const previousParsed =
        existing === undefined
          ? undefined
          : this.parseSessionRun(existing.record, childRunId);
      if (previousParsed === undefined) {
        throw new Error(`Child run ${childRunId} has no record to revise.`);
      }
      const next = step(previousParsed);
      if (isDeepStrictEqual(previousParsed, next)) return;
      await this.store.authority.commitExtensionRecord(
        {
          operation: evidence?.operation ?? 'commitChildRunRecord',
          commandId:
            evidence?.commandId ?? `${childRunId}:${existing!.revision + 1}`,
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

  private parseSessionRun(
    record: unknown,
    childRunId: string,
  ): ChildSessionRun {
    const parsed = parseChildRun(record);
    if (!isChildSessionRun(parsed)) {
      throw new Error(`Child run ${childRunId} is not a child Session run.`);
    }
    return parsed;
  }

  private commit(
    childRunId: string,
    record: ChildSessionRun,
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
