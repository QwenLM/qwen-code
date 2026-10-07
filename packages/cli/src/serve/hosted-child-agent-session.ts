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
} from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-record.js';
import { parseChildRun } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-record.js';
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
  childDeliveryBody,
  childDispatchBody,
  childFailBody,
  childLaunchBody,
  childSettleCompletedBody,
  childStopRequestedBody,
  encodeChildLaunchEnvelope,
  type ChildAdmission,
  type ChildLaunchEnvelope,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-child-operations.js';
import type { DefinitionPin } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import { isTerminalRunState } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import {
  managedExtensionRecordKey,
  managedTaskId,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-projection.js';
import { escapeXml } from '@qwen-code/qwen-code-core/utils/xml.js';
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
  readonly workingDirectory: string;
  readonly executionCallId: string;
}

const TRUSTED: ManagedSessionActor = { class: 'trusted_entry' };

function digest(record: unknown): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

/**
 * The launch admission answer the tool turn translates into its error. The
 * caller encodes the envelope first (a bound failure there is `byte_limit`)
 * and passes its byte length here.
 */
export function childLaunchAdmission(params: {
  readonly workspaceMode: 'shared' | 'snapshot' | 'worktree';
  readonly sameDefinition: boolean;
  readonly closing: boolean;
  readonly activeInScope: number;
  readonly envelopeBytes: number;
}): ChildAdmission {
  return admitChildLaunch({
    closing: params.closing,
    depth: 1,
    activeInScope: params.activeInScope,
    envelopeBytes: params.envelopeBytes,
    workspaceMode: params.workspaceMode,
    sameDefinition: params.sameDefinition,
  });
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
}): string {
  const head = [
    '<task-notification>',
    `<task-id>${escapeXml(params.taskId)}</task-id>`,
    '<kind>child_agent</kind>',
    '<status>completed</status>',
    `<summary>Child agent "${escapeXml(truncateNotificationLabel(params.description))}" finished.</summary>`,
    '<result>',
  ].join('\n');
  const tail = '</result>\n</task-notification>';
  const stripped = stripMultilineControlChars(params.text);
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
    serialized(
      escapeXml(codePoints.slice(0, points).join('') + TRUNCATION_MARKER),
    ) <= CHILD_NOTIFICATION_INLINE_LIMIT;
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return (
    head +
    escapeXml(codePoints.slice(0, low).join('') + TRUNCATION_MARKER) +
    tail
  );
}

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

  /** The non-terminal child agent runs of one owner scope. */
  activeChildRunsOf(ownerScopeId: string): readonly ChildAgentRun[] {
    return this.store.authority
      .extensionRecordsInDomain('child_run')
      .map((entry) => parseChildRun(entry.record))
      .filter(
        (record): record is ChildAgentRun =>
          record.kind === 'child_agent' &&
          record.ownerScopeId === ownerScopeId &&
          !isTerminalRunState(record.run.state),
      );
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
    params: { readonly result: Buffer; readonly receipt: Buffer },
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
    },
  ): Promise<void> {
    return this.revise(childRunId, (previous) =>
      childFailBody(previous, params),
    );
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
    params: { readonly started: boolean },
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
