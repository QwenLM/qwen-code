/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import type {
  AutomationRun,
  Schedule,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-automation-record.js';
import {
  parseAutomationRunRecord,
  parseScheduleRecord,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-automation-record.js';
import {
  AUTOMATION_INPUT_SOURCE,
  AUTOMATION_RESOURCE_KINDS,
  AUTOMATION_RUN_TRIGGERS,
  MANAGED_AUTOMATION_LIMITS,
  assertAutomationDefinition,
  automationDefinitionDigest,
  automationInputId,
  automationRunClaimBody,
  automationRunDispatchBody,
  automationRunFailedUnknownBody,
  automationRunId,
  automationRunIdOfInput,
  automationRunSettleBody,
  automationTurnText,
  decodeAutomationGateOutput,
  encodeAutomationGateOutput,
  encodeAutomationInputEnvelope,
  scheduleOpenBody,
  scheduleRetireBody,
  scheduleRevisionBody,
  type AutomationDefinition,
  type AutomationGateOutput,
  type AutomationRunOutcome,
  type AutomationRunTrigger,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-automation-operations.js';
import {
  HostedAutomationGateHeld,
  type HostedAutomationGateResult,
  type HostedAutomationGateRunner,
} from './hosted-automation-gate.js';
import { isTerminalRunState } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import {
  CRON_GATE_OUTPUT_CAP_BYTES,
  gateStderrTail,
  sanitizeGateOutput,
} from '@qwen-code/qwen-code-core/services/cron-gate.js';
import type {
  CommittedExtensionOperation,
  LocalManagedSessionAuthority,
  ManagedSessionActor,
  ManagedSessionCommand,
  ManagedSessionInputRequest,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import {
  MANAGED_SESSION_LIMITS,
  assertManagedSessionScheduleSessionModeEnabled,
  parseManagedSessionRecordJson,
  type ManagedSessionDomain,
  type ManagedSessionDurableRef,
  type ManagedSessionEvent,
  type ManagedSessionKey,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { wakeHasPriorAttempt } from './hosted-monitor-wake.js';

// H6b/H6c of #12827: the hosted funnel of a Session's automation
// definitions and runs. The control plane drives it through one operation
// route; every verb commits a record revision (or the run's dispatch with
// its input and wake) as facts arrive, replays by its derived command id,
// and reads the committed chain before acting — never its own memory. See
// docs/design/2026-10-07-managed-automation-runtime.md.

/** The narrow Session slice a HostedAutomationSession commits through. */
export interface HostedAutomationStore {
  readonly authority: {
    readonly committedSequence: number;
    appendExecutionEvent: LocalManagedSessionAuthority['appendExecutionEvent'];
    eventsInSequenceRange(
      from: number,
      to: number,
    ): readonly ManagedSessionEvent[];
    extensionRecord(
      domain: ManagedSessionDomain,
      recordId: string,
    ):
      | {
          readonly record: unknown;
          readonly revision: number;
          readonly recordRef: ManagedSessionDurableRef;
        }
      | undefined;
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
    commitOperationReplayed(
      command: ManagedSessionCommand,
      request: {
        readonly domain: ManagedSessionDomain;
        readonly recordId: string;
        readonly revision: number;
        readonly recordRef: ManagedSessionDurableRef;
      },
      actor: ManagedSessionActor,
    ): Promise<unknown>;
    committedExtensionOperation(
      operation: string,
      commandId: string,
    ): CommittedExtensionOperation | undefined;
    committedExtensionOperationByCommandId(commandId: string):
      | {
          readonly operation: string;
          readonly result: CommittedExtensionOperation;
        }
      | undefined;
  };
  readonly resources: {
    publish(kind: string, bytes: Buffer): Promise<ManagedSessionDurableRef>;
    read(ref: ManagedSessionDurableRef): Promise<Buffer>;
  };
  readonly sink: {
    project(): Promise<ChatRecord[]>;
  };
}

export interface AutomationDefineParams {
  readonly scheduleId: string;
  /**
   * The relayed operation's identity. A retry of one request carries the
   * same one, and the committed commit under it answers with the original
   * revision — however the chain moved since.
   */
  readonly operationId: string;
  /** The request's definition fields; a revision may carry a subset. */
  readonly definition: unknown;
}

export interface AutomationDefineResult {
  readonly schedule: Schedule;
  readonly revision: number;
  /** The committed definition already carried this content. */
  readonly replayed: boolean;
}

export interface AutomationFireParams {
  readonly scheduleId: string;
  readonly definitionRevision: number;
  readonly occurrenceKey: string;
  readonly trigger: AutomationRunTrigger;
  readonly firedAt: number;
}

/**
 * How the definition's gate decided one fire. `delivered` comes with the
 * run; every other outcome answers without one, and the control plane
 * records the occurrence as skipped with the outcome as its reason.
 */
export interface AutomationGateSummary {
  readonly outcome: 'delivered' | 'quiet' | 'failed' | 'blocked' | 'unknown';
  /** What went wrong, for the occurrence's `last_error`; absent when nothing did. */
  readonly detail?: string;
  readonly durationMs?: number;
}

export interface AutomationFireResult {
  /** Absent when the gate withheld the fire: nothing was claimed. */
  readonly run?: AutomationRun;
  readonly inputId: string;
  readonly replayed: boolean;
  /** Present exactly for a gated definition. */
  readonly gate?: AutomationGateSummary;
}

/** The definition names a gate this Session cannot run as its deployment
 * requires. */
export class AutomationGateUnsupportedError extends Error {
  constructor(
    scheduleId: string,
    reason = "the Session's tool profile declares no Shell to run it",
  ) {
    super(`Automation ${scheduleId} names a gate, but ${reason}.`);
    this.name = 'AutomationGateUnsupportedError';
  }
}

/**
 * The probe's output as the model sees it, cut back to the output cap on a
 * character boundary: sanitizing may lengthen it (a defanged tag gains a
 * character), and the input budget and the resource limit assume no more
 * than the cap.
 */
function sanitizedWithinCap(stdout: string): { stdout: string; cut: boolean } {
  const sanitized = sanitizeGateOutput(stdout);
  const bytes = Buffer.from(sanitized, 'utf8');
  if (bytes.length <= CRON_GATE_OUTPUT_CAP_BYTES) {
    return { stdout: sanitized, cut: false };
  }
  let end = CRON_GATE_OUTPUT_CAP_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { stdout: bytes.subarray(0, end).toString('utf8'), cut: true };
}

/** How long a release nobody owes may hold up the fire that asks it. */
const COURTESY_RELEASE_WAIT_MS = 2_000;

/** Owed probe releases remembered at most, oldest forgotten first. */
const OWED_GATE_RELEASES_LIMIT = 1024;

/** Why a Session whose deployment pins a Hook catalog runs no gate. */
const GATE_HOOKS_REASON =
  'the deployment pins a Hook catalog for this Session, and a probe does not run through its Hooks yet (PreToolUse and PermissionRequest would never see the gate command)';

export interface HostedAutomationSessionOptions {
  /** Runs a definition's gate; absent, every gated fire is `blocked`. */
  readonly gate?: HostedAutomationGateRunner;
  /**
   * Releases the derived Session of an occurrence's probe under a revision,
   * for a fire that ends without probing again; throws when it could not.
   */
  readonly releaseGate?: (
    automationRunId: string,
    definitionRevision: number,
  ) => Promise<void>;
  /** Whether this Session's tool profile declares Shell, at define time. */
  readonly shellAvailable?: () => boolean;
  /**
   * Whether the deployment pins a Hook catalog for this Session. A gate
   * would run around its Hooks, so such a Session refuses and blocks gates;
   * the catalog's contents are not read for this (an empty one counts too),
   * which keeps the answer synchronous and off the Broker.
   */
  readonly hooksConfigured?: () => boolean;
}

/** The definition moved since the caller read it; re-read and decide again. */
export class AutomationRevisionStaleError extends Error {
  constructor(scheduleId: string, committed: number, offered: number) {
    super(
      `Automation ${scheduleId} is at definition revision ${committed}; revision ${offered} admits nothing (automation_revision_stale).`,
    );
  }
}

/** The chain ended; it takes no revision and fires nothing. */
export class AutomationRetiredError extends Error {
  constructor(scheduleId: string) {
    super(`Automation ${scheduleId} is retired (automation_retired).`);
  }
}

export class AutomationNotFoundError extends Error {
  constructor(scheduleId: string) {
    super(`Automation ${scheduleId} has no record (automation_not_found).`);
  }
}

export class AutomationQuotaError extends Error {
  constructor(limit: number) {
    super(
      `A Session holds at most ${limit} live automation definitions (automation_count_limit).`,
    );
  }
}

/**
 * A replayed operation names another target or another content than the
 * operation committed: the retry must be refused, never answered with a
 * different request's result.
 */
export class AutomationOperationConflictError extends Error {
  constructor(operationId: string, reason: string) {
    super(`Automation operation ${operationId} conflicts: ${reason}.`);
  }
}

const TRUSTED: ManagedSessionActor = { class: 'trusted_entry' };
const SCHEDULE_ID = /^asch_[0-9a-f]{32}$/;

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function isAutomationTrigger(
  value: unknown,
): value is AutomationRunTrigger {
  return (AUTOMATION_RUN_TRIGGERS as readonly unknown[]).includes(value);
}

export function isAutomationScheduleId(value: unknown): value is string {
  return typeof value === 'string' && SCHEDULE_ID.test(value);
}

/** The longest gate detail the control plane keeps (`ma_schedule` and the
 * occurrence's `last_error` are 1024 characters). */
const AUTOMATION_GATE_DETAIL_MAX_CHARS = 1024;

/** The control plane's view of a probe that withheld the fire. */
function summarizeGate(
  result: Exclude<HostedAutomationGateResult, { kind: 'output' }>,
): AutomationGateSummary {
  switch (result.kind) {
    case 'quiet':
      return { outcome: 'quiet', durationMs: result.durationMs };
    case 'failed': {
      // A failed gate runs no turn, so its stderr has nowhere else to go:
      // its tail rides in the detail, cut so the whole detail fits what the
      // control plane keeps and its newest lines survive.
      const prefix = `${result.detail}; stderr: `;
      const tail = gateStderrTail(
        result.stderr,
        AUTOMATION_GATE_DETAIL_MAX_CHARS - prefix.length,
      );
      return {
        outcome: 'failed',
        detail: tail === '' ? result.detail : prefix + tail,
        durationMs: result.durationMs,
      };
    }
    case 'blocked':
      return { outcome: 'blocked', detail: result.reason };
    default:
      return { outcome: 'unknown', detail: result.reason };
  }
}

export class HostedAutomationSession {
  private writes: Promise<void> = Promise.resolve();
  /**
   * Probes this process ran whose attempt ended without the Session's
   * release (`<runId>|<revision>`): the next fire of that occurrence owes it.
   * Bounded, oldest first: an occurrence the scanner gave up on never fires
   * again to settle its entry.
   */
  private readonly owedGateReleases = new Set<string>();
  private gateReleaseDebtOverflowed = false;

  constructor(
    private readonly store: HostedAutomationStore,
    private readonly key: ManagedSessionKey,
    private readonly options: HostedAutomationSessionOptions = {},
  ) {}

  get hasPendingGateReleases(): boolean {
    return this.gateReleaseDebtOverflowed || this.owedGateReleases.size > 0;
  }

  schedule(scheduleId: string): Schedule | undefined {
    const existing = this.store.authority.extensionRecord(
      'schedule',
      scheduleId,
    );
    return existing ? parseScheduleRecord(existing.record) : undefined;
  }

  schedules(): Schedule[] {
    return this.store.authority
      .extensionRecordsInDomain('schedule')
      .map((entry) => parseScheduleRecord(entry.record));
  }

  run(automationRunId: string): AutomationRun | undefined {
    const existing = this.store.authority.extensionRecord(
      'automation_run',
      automationRunId,
    );
    return existing ? parseAutomationRunRecord(existing.record) : undefined;
  }

  cancelRequested(turnId: string): boolean {
    return this.store.authority
      .eventsInSequenceRange(1, this.store.authority.committedSequence)
      .some(
        (event) =>
          event.kind === 'cancel.requested' &&
          (event.payload['target'] as { turnId?: unknown } | undefined)
            ?.turnId === turnId,
      );
  }

  requestCancel(runId: string): Promise<AutomationRun> {
    return this.serial(async () => {
      const turnId = automationInputId(runId);
      await this.settleRunUnserialized(turnId);
      const run = this.run(runId);
      if (run === undefined) throw new AutomationNotFoundError(runId);
      if (isTerminalRunState(run.run.state)) return run;
      if (run.run.execution === 'intent') {
        const cancelled = automationRunSettleBody(run, 'cancelled', false);
        await this.commitRun(
          cancelled,
          this.revisionOf(runId) + 1,
          'settleRun',
        );
        return cancelled;
      }
      if (!this.cancelRequested(turnId)) {
        const commandId = `automation-cancel:${runId}`;
        await this.store.authority.appendExecutionEvent(
          {
            operation: 'requestCancel',
            commandId,
            contentDigest: digest(turnId),
            sessionKey: this.key,
          },
          (sequence) => ({
            v: 1,
            sequence,
            eventId: commandId,
            sessionKey: this.key,
            kind: 'cancel.requested',
            occurredAt: Date.now(),
            payload: {
              requestId: commandId,
              target: { turnId },
              reason: 'user',
              requestedBy: 'hosted',
            },
          }),
          TRUSTED,
        );
      }
      return run;
    });
  }

  runs(): AutomationRun[] {
    return this.store.authority
      .extensionRecordsInDomain('automation_run')
      .map((entry) => parseAutomationRunRecord(entry.record));
  }

  /** The prompt text a definition revision pinned. */
  async promptOf(schedule: Schedule): Promise<string> {
    return (await this.store.resources.read(schedule.promptRef)).toString(
      'utf8',
    );
  }

  /**
   * `defineSchedule`: opens a definition, or appends its next revision. An
   * unchanged definition appends nothing and answers the committed one; a
   * retired chain takes none. A retry of a committed operation is answered
   * with its original revision first of all, so a relay whose answer was
   * lost cannot rewrite a revision another request committed since.
   */
  define(params: AutomationDefineParams): Promise<AutomationDefineResult> {
    return this.serial(async () => {
      const prior = await this.mutationReplay(
        'defineSchedule',
        params.operationId,
        params.scheduleId,
        params.definition,
      );
      if (prior !== undefined) return prior;
      const existing = this.schedule(params.scheduleId);
      if (existing !== undefined && isTerminalRunState(existing.run.state)) {
        throw new AutomationRetiredError(params.scheduleId);
      }
      const defaults: Partial<AutomationDefinition> =
        existing === undefined
          ? {}
          : {
              goal: existing.goal,
              cron: existing.cron,
              timezone: existing.timezone,
              prompt: await this.promptOf(existing),
              sessionMode: existing.sessionMode,
              overlap: existing.overlap,
              catchUp: existing.catchUp,
              catchUpLimit: existing.catchUpLimit,
              enabled: existing.enabled,
              gate: existing.gate,
            };
      const definition = assertAutomationDefinition(
        params.definition,
        defaults,
      );
      // A definition the authority's mode gate would refuse publishes
      // nothing: the pre-flight throws the same error before the prompt
      // resource, so a refused define leaves no orphan body behind.
      assertManagedSessionScheduleSessionModeEnabled(definition.sessionMode);
      // A gate runs as a Shell execution of this Session: a profile with
      // no Shell could never run it, so the definition is refused here
      // rather than blocked at every fire.
      if (
        definition.gate !== null &&
        this.options.shellAvailable !== undefined &&
        !this.options.shellAvailable()
      ) {
        throw new AutomationGateUnsupportedError(params.scheduleId);
      }
      if (definition.gate !== null && this.options.hooksConfigured?.()) {
        throw new AutomationGateUnsupportedError(
          params.scheduleId,
          GATE_HOOKS_REASON,
        );
      }
      const definitionDigest = automationDefinitionDigest(definition);
      if (
        existing !== undefined &&
        existing.definitionDigest === definitionDigest
      ) {
        // Honored without a revision: the decision is committed as a
        // marker, or its lost-answer retry would replay nothing after the
        // chain moved and re-apply this content over it.
        const committed = this.store.authority.extensionRecord(
          'schedule',
          params.scheduleId,
        )!;
        await this.store.authority.commitOperationReplayed(
          {
            operation: 'defineSchedule',
            commandId: params.operationId,
            sessionKey: this.key,
            contentDigest: digest(existing),
          },
          {
            domain: 'schedule',
            recordId: params.scheduleId,
            revision: committed.revision,
            recordRef: committed.recordRef,
          },
          TRUSTED,
        );
        return {
          schedule: existing,
          revision: committed.revision,
          replayed: true,
        };
      }
      if (
        existing === undefined &&
        this.schedules().filter((each) => !isTerminalRunState(each.run.state))
          .length >= MANAGED_AUTOMATION_LIMITS.maxDefinitionsPerSession
      ) {
        throw new AutomationQuotaError(
          MANAGED_AUTOMATION_LIMITS.maxDefinitionsPerSession,
        );
      }
      const promptRef =
        existing !== undefined && definition.prompt === defaults.prompt
          ? existing.promptRef
          : await this.store.resources.publish(
              AUTOMATION_RESOURCE_KINDS.prompt,
              Buffer.from(definition.prompt, 'utf8'),
            );
      const record =
        existing === undefined
          ? scheduleOpenBody({
              scheduleId: params.scheduleId,
              ownerScopeId: this.key.sessionId,
              targetSessionId: this.key.sessionId,
              definition,
              promptRef,
              definitionDigest,
            })
          : scheduleRevisionBody(existing, {
              definition,
              promptRef,
              definitionDigest,
            });
      await this.commitSchedule(record, 'defineSchedule', params.operationId);
      return {
        schedule: record,
        revision: this.store.authority.extensionRecord(
          'schedule',
          params.scheduleId,
        )!.revision,
        replayed: false,
      };
    });
  }

  /** `retireSchedule`: the chain ends `cancelled` and freezes for good. */
  retire(
    scheduleId: string,
    operationId: string,
  ): Promise<AutomationDefineResult> {
    return this.serial(async () => {
      const prior = await this.mutationReplay(
        'retireSchedule',
        operationId,
        scheduleId,
        null,
      );
      if (prior !== undefined) return prior;
      const existing = this.schedule(scheduleId);
      if (existing === undefined) throw new AutomationNotFoundError(scheduleId);
      const revisionOf = () =>
        this.store.authority.extensionRecord('schedule', scheduleId)!.revision;
      if (isTerminalRunState(existing.run.state)) {
        const committed = this.store.authority.extensionRecord(
          'schedule',
          scheduleId,
        )!;
        await this.store.authority.commitOperationReplayed(
          {
            operation: 'retireSchedule',
            commandId: operationId,
            sessionKey: this.key,
            contentDigest: digest(existing),
          },
          {
            domain: 'schedule',
            recordId: scheduleId,
            revision: committed.revision,
            recordRef: committed.recordRef,
          },
          TRUSTED,
        );
        return { schedule: existing, revision: revisionOf(), replayed: true };
      }
      const record = scheduleRetireBody(existing);
      await this.commitSchedule(record, 'retireSchedule', operationId);
      return { schedule: record, revision: revisionOf(), replayed: false };
    });
  }

  /**
   * `fireRun`: for a gated definition, the probe first — in the Workspace
   * Runtime, under identities derived from the occurrence, so a retried
   * fire meets the Broker's receipt and never runs the command twice —
   * and only an output claims; then the claim (revision 1) and, in one
   * transaction with the run's input and wake, the dispatch (revision 2).
   * A replay answers the committed run first — whatever the definition did
   * since — and completes a dispatch a crash left out: with the
   * definition's current prompt and the output the claim recorded while it
   * is live, or by cancelling the claim once it retired.
   */
  fire(params: AutomationFireParams): Promise<AutomationFireResult> {
    return this.serial(async () => {
      const runId = automationRunId(params.scheduleId, params.occurrenceKey);
      const inputId = automationInputId(runId);
      const existing = this.run(runId);
      const gateOf = (
        run: AutomationRun,
      ): Pick<AutomationFireResult, 'gate'> =>
        run.gateOutputRef === null ? {} : { gate: { outcome: 'delivered' } };
      if (existing !== undefined) {
        if (
          existing.run.execution !== 'intent' ||
          isTerminalRunState(existing.run.state)
        ) {
          return {
            run: existing,
            inputId,
            replayed: true,
            ...gateOf(existing),
          };
        }
        const schedule = this.schedule(params.scheduleId);
        if (schedule === undefined || isTerminalRunState(schedule.run.state)) {
          // The definition ended before the claim dispatched: nothing of
          // this occurrence ever reached a turn.
          const cancelled = automationRunSettleBody(
            existing,
            'cancelled',
            false,
          );
          await this.commitRun(cancelled, 2, 'fireRun');
          return {
            run: cancelled,
            inputId,
            replayed: true,
            ...gateOf(existing),
          };
        }
        return {
          run: await this.dispatch(existing, schedule, params, inputId),
          inputId,
          replayed: true,
          ...gateOf(existing),
        };
      }
      const schedule = this.schedule(params.scheduleId);
      const ending =
        schedule === undefined
          ? new AutomationNotFoundError(params.scheduleId)
          : isTerminalRunState(schedule.run.state)
            ? new AutomationRetiredError(params.scheduleId)
            : undefined;
      const stale =
        schedule !== undefined &&
        schedule.definitionRevision !== params.definitionRevision;
      if (ending !== undefined || stale) {
        // This occurrence is not probed under its pinned revision again,
        // so an earlier attempt's probe Session, which that attempt could
        // not release, is released here; while this process knows it owes
        // that release, the scanner retries the fire until it is done.
        await this.releaseGateSession(runId, params.definitionRevision);
      }
      if (ending !== undefined) throw ending;
      if (schedule === undefined) {
        throw new AutomationNotFoundError(params.scheduleId);
      }
      if (stale) {
        throw new AutomationRevisionStaleError(
          params.scheduleId,
          schedule.definitionRevision,
          params.definitionRevision,
        );
      }
      let gateOutputRef: ManagedSessionDurableRef | null = null;
      let gate: AutomationGateSummary | undefined;
      if (schedule.gate !== null) {
        const result = await this.probe(
          schedule.gate,
          runId,
          params.definitionRevision,
        );
        if (result.kind !== 'output') {
          return { inputId, replayed: false, gate: summarizeGate(result) };
        }
        // Stored as the model sees it: raw control bytes would only grow
        // the resource (each escapes to six bytes) past its limit.
        const stored = sanitizedWithinCap(result.stdout);
        const output: AutomationGateOutput = {
          gate: schedule.gate,
          stdout: stored.stdout,
          truncated: result.truncated || stored.cut,
          durationMs: result.durationMs,
        };
        gateOutputRef = await this.store.resources.publish(
          AUTOMATION_RESOURCE_KINDS.gateOutput,
          encodeAutomationGateOutput(output),
        );
        gate = { outcome: 'delivered', durationMs: result.durationMs };
      }
      const claim = automationRunClaimBody({
        schedule,
        occurrenceKey: params.occurrenceKey,
        gateOutputRef,
      });
      await this.commitRun(claim, 1, 'fireRun');
      return {
        run: await this.dispatch(claim, schedule, params, inputId),
        inputId,
        replayed: false,
        ...(gate === undefined ? {} : { gate }),
      };
    });
  }

  /**
   * Releases the probe Session of `automationRunId` under `revision`, if any.
   * A probe this process left unreleased makes a failure retry the fire;
   * otherwise the release is a courtesy — most such fires never probed (an
   * ungated definition, a first attempt) and must not wait on the Broker.
   */
  private async releaseGateSession(
    automationRunId: string,
    revision: number,
  ): Promise<void> {
    if (this.options.releaseGate === undefined) return;
    const owed = `${automationRunId}|${revision}`;
    if (!this.owedGateReleases.has(owed)) {
      // A courtesy waits briefly: a Broker that hangs must not hold up a
      // definition that needs no Broker, nor the funnel queued behind it.
      const release = this.options
        .releaseGate(automationRunId, revision)
        .catch(() => undefined);
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        release,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, COURTESY_RELEASE_WAIT_MS);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
      return;
    }
    try {
      await this.options.releaseGate(automationRunId, revision);
      this.owedGateReleases.delete(owed);
    } catch (cause) {
      throw new HostedAutomationGateHeld(
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  }

  /** The gate probe of one occurrence; a funnel with no runner blocks it. */
  private probe(
    gate: string,
    automationRunId: string,
    definitionRevision: number,
  ): Promise<HostedAutomationGateResult> {
    if (this.options.gate === undefined) {
      return Promise.resolve({
        kind: 'blocked',
        reason: 'this Session cannot run gate commands',
      });
    }
    if (this.options.hooksConfigured?.()) {
      return Promise.resolve({ kind: 'blocked', reason: GATE_HOOKS_REASON });
    }
    const owed = `${automationRunId}|${definitionRevision}`;
    return this.options
      .gate({
        automationRunId,
        definitionRevision,
        gate,
        // Never aborted, on purpose: a fire whose relay request timed out is
        // a lost reply, and its re-drive reads the probe's receipt, so the
        // probe must run on rather than be cancelled; a Session that closes
        // takes its Runtime, and the probe with it, down through the cascade.
        signal: new AbortController().signal,
      })
      .then(
        async (result) => {
          // The runner released any Session this attempt may have held; one
          // an earlier attempt left behind is released here when this one
          // never came to hold it (a refusal before it acquired). A release
          // that fails retries the fire rather than settle it unreleased.
          if (this.owedGateReleases.has(owed)) {
            await this.releaseGateSession(automationRunId, definitionRevision);
          }
          return result;
        },
        (cause: unknown) => {
          this.owedGateReleases.delete(owed);
          this.owedGateReleases.add(owed);
          if (this.owedGateReleases.size > OWED_GATE_RELEASES_LIMIT) {
            // Forgetting a release key cannot prove its Runtime was released.
            this.gateReleaseDebtOverflowed = true;
            this.owedGateReleases.delete(
              this.owedGateReleases.values().next().value!,
            );
          }
          throw cause;
        },
      );
  }

  /** Revision 2: the input and its wake, in one transaction with the run. */
  private async dispatch(
    claim: AutomationRun,
    schedule: Schedule,
    params: AutomationFireParams,
    inputId: string,
  ): Promise<AutomationRun> {
    // The output the claim recorded, never a second probe: a replay after
    // a crash between the claim and this dispatch composes the same text.
    const gateOutput =
      claim.gateOutputRef === null
        ? null
        : decodeAutomationGateOutput(
            await this.store.resources.read(claim.gateOutputRef),
          );
    const text = automationTurnText({
      schedule,
      occurrenceKey: params.occurrenceKey,
      trigger: params.trigger,
      firedAt: params.firedAt,
      prompt: await this.promptOf(schedule),
      gateOutput,
    });
    const input: ManagedSessionInputRequest = {
      inputId,
      turnId: inputId,
      source: AUTOMATION_INPUT_SOURCE,
      contentRef: await this.store.resources.publish(
        AUTOMATION_RESOURCE_KINDS.input,
        encodeAutomationInputEnvelope({
          automationRunId: claim.automationRunId,
          scheduleId: params.scheduleId,
          definitionRevision: claim.definitionRevision,
          occurrenceKey: params.occurrenceKey,
          trigger: params.trigger,
          firedAt: params.firedAt,
          text,
        }),
      ),
      deadline: null,
      admissionRef: await this.store.resources.publish(
        'managed-admission',
        Buffer.from('{}', 'utf8'),
      ),
      wakeReason: 'input',
    };
    const dispatched = automationRunDispatchBody(claim);
    await this.commitRun(dispatched, 2, 'fireRun', input);
    return dispatched;
  }

  /**
   * The settle of one automation turn, read from the turn's own result:
   * completed settles the run, an error fails it, a cancel cancels it. A
   * turn that never ran (settled model-free on the close path) ends the
   * run with an execution proven not to have started.
   */
  settleRun(turnId: string): Promise<AutomationRun | undefined> {
    return this.serial(() => this.settleRunUnserialized(turnId));
  }

  /**
   * The turn an automation input was dispatched into stopped in a way the
   * journal proves neither way (the Harness crashed inside it and its
   * wake classifies as recovery): the run ends `failed` with an
   * `outcome_unknown` execution. Calling twice settles nothing more.
   */
  settleRunFailedUnknown(turnId: string): Promise<AutomationRun | undefined> {
    return this.serial(async () => {
      const runId = automationRunIdOfInput(turnId);
      if (runId === undefined) return undefined;
      const run = this.run(runId);
      if (
        run === undefined ||
        isTerminalRunState(run.run.state) ||
        run.run.execution !== 'dispatch_started'
      ) {
        return undefined;
      }
      const settled = automationRunFailedUnknownBody(run);
      await this.commitRun(settled, this.revisionOf(runId) + 1, 'settleRun');
      return settled;
    });
  }

  private async settleRunUnserialized(
    turnId: string,
  ): Promise<AutomationRun | undefined> {
    const runId = automationRunIdOfInput(turnId);
    if (runId === undefined) return undefined;
    const run = this.run(runId);
    if (
      run === undefined ||
      isTerminalRunState(run.run.state) ||
      run.run.execution !== 'dispatch_started'
    ) {
      return undefined;
    }
    const projected = await this.store.sink.project();
    // The journal's own settle of the turn is the authority; the sink's
    // turn result stands in only for a turn whose settle the journal does
    // not carry (the wake runner's error path writes the sink alone).
    const { authority } = this.store;
    const journalSettle = authority
      .eventsInSequenceRange(1, authority.committedSequence)
      .findLast(
        (event) =>
          event.kind === 'turn.settled' && event.payload['turnId'] === turnId,
      );
    const result = projected.findLast(
      (entry) =>
        entry.type === 'system' &&
        entry.subtype === 'turn_result' &&
        (entry.systemPayload as { promptId?: unknown } | undefined)
          ?.promptId === turnId,
    );
    const state =
      journalSettle?.payload['outcome'] ??
      (result?.systemPayload as { state?: unknown } | undefined)?.state;
    const outcome: AutomationRunOutcome | undefined =
      state === undefined
        ? undefined
        : state === 'completed'
          ? 'settled'
          : state === 'cancelled'
            ? 'cancelled'
            : 'failed';
    if (outcome === undefined) return undefined;
    const started = wakeHasPriorAttempt(projected, turnId);
    const settled = automationRunSettleBody(
      run,
      outcome === 'settled' && !started ? 'cancelled' : outcome,
      started,
    );
    await this.commitRun(settled, this.revisionOf(runId) + 1, 'settleRun');
    return settled;
  }

  /**
   * Every dispatched run whose turn settled gets its settle revision: the
   * open path's reconciliation of the settle → settle-revision crash
   * window, and the close path's follow-up to its model-free settlement.
   */
  async reconcileRuns(): Promise<string[]> {
    const settled: string[] = [];
    for (const run of this.runs()) {
      if (
        isTerminalRunState(run.run.state) ||
        run.run.execution !== 'dispatch_started'
      )
        continue;
      if (
        (await this.settleRun(automationInputId(run.automationRunId))) !==
        undefined
      )
        settled.push(run.automationRunId);
    }
    return settled;
  }

  private revisionOf(runId: string): number {
    return (
      this.store.authority.extensionRecord('automation_run', runId)?.revision ??
      0
    );
  }

  /**
   * The result a mutation's operation identity already landed, if any: the
   * committed revision, or the honored no-op marker. The replay verifies
   * the operation's target and, for defines, its content — another request
   * under the same identity is a conflict, never an answer.
   */
  private async mutationReplay(
    operation: 'defineSchedule' | 'retireSchedule',
    operationId: string,
    scheduleId: string,
    definition: unknown | null,
  ): Promise<AutomationDefineResult | undefined> {
    const prior = this.store.authority.committedExtensionOperation(
      operation,
      operationId,
    );
    if (prior === undefined) {
      const other =
        this.store.authority.committedExtensionOperationByCommandId(
          operationId,
        );
      if (other !== undefined && other.operation !== operation) {
        throw new AutomationOperationConflictError(
          operationId,
          `it answers for ${other.operation}, not ${operation}`,
        );
      }
      return undefined;
    }
    const conflict = (reason: string): never => {
      throw new AutomationOperationConflictError(operationId, reason);
    };
    if (prior.kind === 'record') {
      if (prior.result.recordId !== scheduleId)
        conflict(`it answers for ${prior.result.recordId}, not ${scheduleId}`);
      const record = await this.scheduleOf(prior.result.recordRef);
      await this.assertReplayContent(operationId, definition, record, conflict);
      return {
        schedule: record,
        revision: prior.result.revision,
        replayed: true,
      };
    }
    if (prior.recordId !== scheduleId)
      conflict(`it answers for ${prior.recordId}, not ${scheduleId}`);
    const record = await this.scheduleOf(prior.recordRef);
    await this.assertReplayContent(operationId, definition, record, conflict);
    return {
      schedule: record,
      revision: prior.revision,
      replayed: true,
    };
  }

  /**
   * The replayed define must ask for what the operation committed, and
   * nothing else: the requested fields merged over the committed
   * definition must digest as that definition.
   */
  private async assertReplayContent(
    operationId: string,
    definition: unknown | null,
    recorded: Schedule,
    conflict: (reason: string) => never,
  ): Promise<void> {
    if (definition === null) return;
    // Read the committed prompt outside the validation try: a store HTTP
    // or transport fault here is infrastructure, not a conflict — the
    // route keeps it retryable as a 503, it is never the request's shape.
    const prompt = await this.promptOf(recorded);
    let merged: AutomationDefinition;
    try {
      merged = assertAutomationDefinition(definition, {
        goal: recorded.goal,
        cron: recorded.cron,
        timezone: recorded.timezone,
        prompt,
        sessionMode: recorded.sessionMode,
        overlap: recorded.overlap,
        catchUp: recorded.catchUp,
        catchUpLimit: recorded.catchUpLimit,
        enabled: recorded.enabled,
        gate: recorded.gate,
      });
    } catch (error) {
      conflict(`its definition does not stand (${(error as Error).message})`);
    }
    if (automationDefinitionDigest(merged!) !== recorded.definitionDigest) {
      conflict('its definition is not the one the operation committed');
    }
  }

  /** The record body a committed operation carries, read from its ref. */
  private async scheduleOf(
    recordRef: ManagedSessionDurableRef,
  ): Promise<Schedule> {
    const bytes = await this.store.resources.read(recordRef);
    return parseScheduleRecord(
      parseManagedSessionRecordJson(
        bytes.toString('utf8'),
        MANAGED_SESSION_LIMITS.maxEventBytes,
      ),
    );
  }

  private async commitSchedule(
    record: Schedule,
    operation: string,
    operationId: string,
  ): Promise<void> {
    await this.store.authority.commitExtensionRecord(
      {
        operation,
        commandId: operationId,
        sessionKey: this.key,
        contentDigest: digest(record),
      },
      { domain: 'schedule', record },
      TRUSTED,
    );
  }

  private async commitRun(
    record: AutomationRun,
    revision: number,
    operation: string,
    input?: ManagedSessionInputRequest,
  ): Promise<void> {
    await this.store.authority.commitExtensionRecord(
      {
        operation,
        commandId: `${record.automationRunId}:${revision}`,
        sessionKey: this.key,
        contentDigest: digest(record),
      },
      {
        domain: 'automation_run',
        record,
        ...(input === undefined ? {} : { input }),
      },
      TRUSTED,
    );
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writes.then(work);
    this.writes = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
