/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { uiTelemetryService } from '../telemetry/uiTelemetry.js';
import {
  withModelObservationScope,
  type ModelObservationSource,
} from '../telemetry/model-observation.js';
import type { ManagedSession } from './managed-session-assembly.js';
import type { ManagedSessionDurableRef } from './managed-session-records.js';
import {
  ManagedSessionRecordError,
  managedSessionJsonDigest,
  parseManagedSessionRecordJson,
  assertManagedSessionDurableRef,
} from './managed-session-records.js';
import { parseHistoryMaintenance } from './managed-history-maintenance-record.js';
import { readManagedMessageBody } from './managed-message-chunks.js';
import {
  addModelStatisticsGap,
  boundManagedCommittedContext,
  boundManagedModelStatistics,
  createManagedModelStatistics,
  MANAGED_MODEL_STATISTICS_KINDS,
  parseManagedStatisticsEnvelope,
  recordManagedModelObservation,
  type ManagedCommittedContext,
  type ManagedStatisticsBudget,
} from './managed-model-statistics.js';

const sessions = new WeakMap<
  ManagedSession['authority'],
  ManagedSessionDiagnostics
>();
const kinds = new Set<string>(Object.values(MANAGED_MODEL_STATISTICS_KINDS));

export function getManagedSessionDiagnostics(
  authority: ManagedSession['authority'],
) {
  return sessions.get(authority);
}

export async function enableManagedSessionDiagnostics(
  session: ManagedSession,
): Promise<void> {
  if (sessions.has(session.authority)) return;
  const diagnostics = new ManagedSessionDiagnostics(session);
  await diagnostics.restore();
  sessions.set(session.authority, diagnostics);
}

export class ManagedSessionDiagnostics {
  private statistics = createManagedModelStatistics();
  private revision = 0;
  private budget: ManagedStatisticsBudget | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private dirty = false;
  private observations = 0;
  private mainContext: ManagedCommittedContext | null = null;

  constructor(private readonly session: ManagedSession) {}

  async restore(): Promise<void> {
    const events = this.session.authority.eventsInSequenceRange(
      1,
      this.session.authority.committedSequence,
    );
    const maintenance = new Map<
      string,
      {
        ref: ManagedSessionDurableRef;
        modelStatsRef: ManagedSessionDurableRef | null;
      }
    >();
    for (const event of events) {
      if (
        event.kind !== 'domain.committed' ||
        event.payload['domain'] !== 'history_maintenance'
      )
        continue;
      const ref = assertManagedSessionDurableRef(
        event.payload['recordRef'],
        'maintenance recordRef',
      );
      maintenance.set(managedSessionJsonDigest(ref), {
        ref,
        modelStatsRef: null,
      });
    }
    const maintenanceRefs = [...maintenance.values()];
    for (let index = 0; index < maintenanceRefs.length; index += 8) {
      await Promise.all(
        maintenanceRefs.slice(index, index + 8).map(async (entry) => {
          const record = parseHistoryMaintenance(
            JSON.parse(
              (await this.session.resources.read(entry.ref)).toString('utf8'),
            ),
          );
          entry.modelStatsRef =
            record.schemaVersion === 2 ? record.modelStatsRef : null;
        }),
      );
    }
    const refs = new Map<string, ManagedSessionDurableRef>();
    const attempts = new Set<string>();
    const turns = new Set<string>();
    let legacy = false;
    let legacyOutputTokens = 0;
    for (const event of events) {
      if (event.kind === 'model.attempt') {
        const id = event.payload['attemptId'] as string;
        const usageRef = event.payload[
          'usageRef'
        ] as ManagedSessionDurableRef | null;
        if (event.payload['state'] === 'started') attempts.add(id);
        else attempts.delete(id);
        if (
          event.payload['state'] !== 'started' &&
          usageRef &&
          !kinds.has(usageRef.kind)
        )
          legacy = true;
      }
      if (event.kind === 'input.accepted')
        turns.add(event.payload['turnId'] as string);
      if (event.kind === 'turn.settled')
        turns.delete(event.payload['turnId'] as string);
      const ref = event.payload['usageRef'] as
        | ManagedSessionDurableRef
        | null
        | undefined;
      if (ref && kinds.has(ref.kind)) refs.set(ref.resourceId, ref);
      if (
        event.kind === 'domain.committed' &&
        event.payload['domain'] === 'history_maintenance'
      ) {
        const recordRef = assertManagedSessionDurableRef(
          event.payload['recordRef'],
          'maintenance recordRef',
        );
        const modelStatsRef = maintenance.get(
          managedSessionJsonDigest(recordRef),
        )!.modelStatsRef;
        if (modelStatsRef) refs.set(modelStatsRef.resourceId, modelStatsRef);
      }
    }
    for (const entry of this.session.authority.extensionRecordsInDomain(
      'history_maintenance',
    )) {
      const maintenance = parseHistoryMaintenance(entry.record);
      if (maintenance.schemaVersion === 2 && maintenance.modelStatsRef)
        refs.set(
          maintenance.modelStatsRef.resourceId,
          maintenance.modelStatsRef,
        );
      if (maintenance.phase !== 'settled' && maintenance.attempt > 0) {
        addModelStatisticsGap(this.statistics, 'unclosed_maintenance');
      }
    }
    const recoveryGaps = this.statistics.coverage.gaps;
    if (!legacy && refs.size === 0) {
      for (const event of events) {
        if (
          event.kind !== 'message.committed' ||
          event.payload['role'] !== 'assistant'
        )
          continue;
        const record = JSON.parse(
          (
            await readManagedMessageBody(
              (ref) => this.session.resources.read(ref),
              assertManagedSessionDurableRef(
                event.payload['contentRef'],
                'message contentRef',
              ),
            )
          ).toString('utf8'),
        ) as { clientInitiatedSkills?: boolean };
        if (record.clientInitiatedSkills !== true) {
          legacy = true;
          break;
        }
      }
    }
    const revisionDigests = new Map<number, string>();
    const statisticsRefs = [...refs.values()];
    for (let index = 0; index < statisticsRefs.length; index += 8) {
      const envelopes = await Promise.all(
        statisticsRefs.slice(index, index + 8).map(async (ref) => {
          if (ref.schemaVersion !== 1)
            throw new ManagedSessionRecordError(
              'Unsupported model statistics resource version.',
            );
          return parseManagedStatisticsEnvelope(
            ref.kind,
            parseManagedSessionRecordJson(
              (await this.session.resources.read(ref)).toString('utf8'),
              64 * 1024,
            ),
          );
        }),
      );
      for (const envelope of envelopes) {
        const statistics = envelope.statistics;
        const digest = managedSessionJsonDigest(statistics);
        if (
          revisionDigests.has(statistics.snapshotRevision) &&
          revisionDigests.get(statistics.snapshotRevision) !== digest
        )
          throw new ManagedSessionRecordError(
            'Conflicting model statistics revision.',
          );
        revisionDigests.set(statistics.snapshotRevision, digest);
        if (statistics.snapshotRevision > this.revision) {
          this.statistics = statistics;
          this.revision = statistics.snapshotRevision;
          this.budget = envelope.budget;
        }
      }
    }
    for (const event of [...events].reverse()) {
      if (event.kind !== 'model.attempt') continue;
      const ref = event.payload['usageRef'] as ManagedSessionDurableRef | null;
      if (
        !ref ||
        !['managed-hosted-model-usage', 'managed-hook-model-usage'].includes(
          ref.kind,
        )
      )
        continue;
      const saved = JSON.parse(
        (await this.session.resources.read(ref)).toString('utf8'),
      ) as { models?: Record<string, { tokens?: { candidates?: unknown } }> };
      const total = Object.values(saved.models ?? {}).reduce((sum, model) => {
        const count = model.tokens?.candidates;
        return typeof count === 'number' &&
          Number.isFinite(count) &&
          count >= 0 &&
          count <= Number.MAX_SAFE_INTEGER
          ? Math.min(Number.MAX_SAFE_INTEGER, sum + count)
          : sum;
      }, 0);
      legacyOutputTokens = Math.max(legacyOutputTokens, total);
      break;
    }
    this.statistics.rawOutputTokensTotal = Math.max(
      this.statistics.rawOutputTokensTotal,
      legacyOutputTokens,
    );
    recoveryGaps.forEach((gap) => addModelStatisticsGap(this.statistics, gap));
    if (legacy) addModelStatisticsGap(this.statistics, 'legacy_history');
    if (turns.size) addModelStatisticsGap(this.statistics, 'unclosed_turn');
    if (attempts.size)
      addModelStatisticsGap(this.statistics, 'unclosed_model_attempt');
    this.dirty = this.statistics.coverage.gaps.length > 0;
    uiTelemetryService.restoreSessionOutputTokensBaseline(
      this.session.authority.sessionHeader.sessionKey.sessionId,
      this.statistics.rawOutputTokensTotal,
    );
  }

  setBudget(budget: ManagedStatisticsBudget | null): void {
    this.budget = budget
      ? {
          sessionId: budget.sessionId,
          promptId: budget.promptId,
          budget: budget.budget,
          outputTokensAtTurnStart: budget.outputTokensAtTurnStart,
        }
      : null;
  }

  getBudget(): ManagedStatisticsBudget | null {
    return this.budget;
  }

  run<T>(source: ModelObservationSource, operation: () => T): T {
    return withModelObservationScope(
      {
        sessionId: this.session.authority.sessionHeader.sessionKey.sessionId,
        source,
        observe: (event) => {
          this.observations++;
          recordManagedModelObservation(this.statistics, event);
          this.dirty = true;
          if (event.source === 'main' && this.mainContext) {
            this.mainContext.inputTokens =
              event.usage?.promptTokenCount ?? null;
            this.mainContext.cachedTokens =
              event.usage?.cachedContentTokenCount ?? null;
          }
        },
        observationFailed: () => {
          this.observations++;
          addModelStatisticsGap(this.statistics, 'observation_error');
          this.dirty = true;
        },
      },
      operation,
    );
  }

  setMainContext(context: ManagedCommittedContext | null): void {
    this.mainContext = context;
  }

  serialCommit<T>(commit: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(commit);
    this.queue = pending.catch(() => {
      this.dirty = true;
    });
    return pending;
  }

  async publish(
    kind: string,
    route: object = {},
    context: ManagedCommittedContext | null = null,
    budget: ManagedStatisticsBudget | null = this.budget,
  ): Promise<ManagedSessionDurableRef> {
    const observations = this.observations;
    this.statistics.snapshotRevision = ++this.revision;
    this.statistics.rawOutputTokensTotal =
      uiTelemetryService.getTotalOutputTokens(
        this.session.authority.sessionHeader.sessionKey.sessionId,
      );
    this.statistics = boundManagedModelStatistics(this.statistics);
    const envelope = parseManagedStatisticsEnvelope(kind, {
      version: kind === MANAGED_MODEL_STATISTICS_KINDS.snapshot ? 1 : 2,
      ...route,
      budget,
      statistics: this.statistics,
      context: context ? boundManagedCommittedContext(context) : null,
    });
    const ref = await this.session.resources.publish(
      kind,
      Buffer.from(JSON.stringify(envelope)),
    );
    this.dirty = observations !== this.observations;
    return ref;
  }

  publishTurnFallback(
    turnId: string,
  ): Promise<ManagedSessionDurableRef | null> {
    const budget =
      this.budget?.promptId === turnId &&
      this.budget.sessionId ===
        this.session.authority.sessionHeader.sessionKey.sessionId
        ? this.budget
        : null;
    return this.dirty
      ? this.publish(MANAGED_MODEL_STATISTICS_KINDS.snapshot, {}, null, budget)
      : Promise.resolve(null);
  }
}
