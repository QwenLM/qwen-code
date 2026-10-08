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
  encodeAutomationInputEnvelope,
  scheduleOpenBody,
  scheduleRetireBody,
  scheduleRevisionBody,
  type AutomationDefinition,
  type AutomationRunOutcome,
  type AutomationRunTrigger,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-automation-operations.js';
import { isTerminalRunState } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import type {
  CommittedExtensionOperation,
  ManagedSessionActor,
  ManagedSessionCommand,
  ManagedSessionInputRequest,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import {
  MANAGED_SESSION_LIMITS,
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

export interface AutomationFireResult {
  readonly run: AutomationRun;
  readonly inputId: string;
  readonly replayed: boolean;
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
      `A Session holds at most ${limit} live automation definitions (count_limit).`,
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

export class HostedAutomationSession {
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: HostedAutomationStore,
    private readonly key: ManagedSessionKey,
  ) {}

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
            };
      const definition = assertAutomationDefinition(
        params.definition,
        defaults,
      );
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
   * `fireRun`: the claim (revision 1) and, in one transaction with the
   * run's input and wake, the dispatch (revision 2). A replay answers the
   * committed run first — whatever the definition did since — and
   * completes a dispatch a crash left out: with the definition's current
   * prompt while it is live, or by cancelling the claim once it retired.
   */
  fire(params: AutomationFireParams): Promise<AutomationFireResult> {
    return this.serial(async () => {
      const runId = automationRunId(params.scheduleId, params.occurrenceKey);
      const inputId = automationInputId(runId);
      const existing = this.run(runId);
      if (existing !== undefined) {
        if (
          existing.run.execution !== 'intent' ||
          isTerminalRunState(existing.run.state)
        ) {
          return { run: existing, inputId, replayed: true };
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
          return { run: cancelled, inputId, replayed: true };
        }
        return {
          run: await this.dispatch(existing, schedule, params, inputId),
          inputId,
          replayed: true,
        };
      }
      const schedule = this.schedule(params.scheduleId);
      if (schedule === undefined) {
        throw new AutomationNotFoundError(params.scheduleId);
      }
      if (isTerminalRunState(schedule.run.state)) {
        throw new AutomationRetiredError(params.scheduleId);
      }
      if (schedule.definitionRevision !== params.definitionRevision) {
        throw new AutomationRevisionStaleError(
          params.scheduleId,
          schedule.definitionRevision,
          params.definitionRevision,
        );
      }
      const claim = automationRunClaimBody({
        schedule,
        occurrenceKey: params.occurrenceKey,
      });
      await this.commitRun(claim, 1, 'fireRun');
      return {
        run: await this.dispatch(claim, schedule, params, inputId),
        inputId,
        replayed: false,
      };
    });
  }

  /** Revision 2: the input and its wake, in one transaction with the run. */
  private async dispatch(
    claim: AutomationRun,
    schedule: Schedule,
    params: AutomationFireParams,
    inputId: string,
  ): Promise<AutomationRun> {
    const text = automationTurnText({
      schedule,
      occurrenceKey: params.occurrenceKey,
      trigger: params.trigger,
      firedAt: params.firedAt,
      prompt: await this.promptOf(schedule),
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
