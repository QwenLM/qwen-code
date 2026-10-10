/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HookExecutionResult } from '../hooks/types.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  extractTurnBudgetDirectiveText,
  parseTurnBudgetDirective,
  type TurnBudget,
  type TurnBudgetSnapshot,
} from '../core/turn-budget.js';
import {
  uiTelemetryService,
  type SessionMetrics,
} from '../telemetry/uiTelemetry.js';
import type { ManagedSession } from './managed-session-assembly.js';
import { ManagedSessionConflictError } from './managed-session-authority.js';
import type { ManagedSessionDurableRef } from './managed-session-records.js';

export interface ManagedHookModelOperation {
  readonly operationId: string;
  readonly occurrenceId: string;
  readonly originTurnId: string | null;
}

/**
 * Names the activation a Hook operation restores when it finishes. The ID is
 * derived from the activation the operation replaced, which the log always
 * holds. A reader can therefore tell the restore from a load, which always
 * installs a random ID, even when the operation's own activation never
 * installed.
 */
export function managedHookRestoreActivationId(activationId: string): string {
  const bytes = createHash('sha1')
    .update('qwen-managed-hook-restore/1:')
    .update(activationId)
    .digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type ManagedHookModelScope = Pick<
  LocalManagedHookModelScope,
  'evaluate' | 'bindBudget' | 'beginMainAttempt'
>;

export type ManagedMainModelAttempt = ((
  success: boolean,
  usage: unknown,
) => Promise<void>) & { readonly attemptId: string };

const sessionBudgets = new WeakMap<
  ManagedSession['authority'],
  { snapshot: TurnBudgetSnapshot | null }
>();

const MODEL_BUDGET_RESOURCE_KINDS = new Set([
  'managed-hook-model-route',
  'managed-hook-model-usage',
  'managed-hosted-model-route',
  'managed-hosted-model-usage',
]);

class LocalManagedHookModelScope {
  private open = true;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly session: ManagedSession,
    private readonly turnId: string | null,
    private readonly operation: ManagedHookModelOperation | null,
    private readonly isOwner: () => boolean,
  ) {}

  async bindBudget(budget: TurnBudget, prompt?: string): Promise<void> {
    this.assertOwner();
    const sessionId = this.session.authority.sessionHeader.sessionKey.sessionId;
    let shared = sessionBudgets.get(this.session.authority);
    if (!shared) {
      shared = { snapshot: null };
      let restoredModels = false;
      const events = this.session.authority.eventsInSequenceRange(
        1,
        this.session.authority.committedSequence,
      );
      for (const event of [...events].reverse()) {
        if (event.kind !== 'model.attempt') continue;
        for (const field of ['usageRef', 'routeRef']) {
          const ref = event.payload[field] as ManagedSessionDurableRef | null;
          if (!ref || !MODEL_BUDGET_RESOURCE_KINDS.has(ref.kind)) continue;
          const saved = JSON.parse(
            (await this.session.resources.read(ref)).toString(),
          ) as {
            budget?: TurnBudgetSnapshot | null;
            models?: SessionMetrics['models'];
          };
          shared.snapshot ??= saved.budget ?? null;
          if (!restoredModels && saved.models) {
            uiTelemetryService.restoreSessionModelMetrics(
              sessionId,
              saved.models,
            );
            restoredModels = true;
          }
        }
        if (shared.snapshot && restoredModels) break;
      }
      sessionBudgets.set(this.session.authority, shared);
    }
    if (prompt !== undefined && shared.snapshot?.promptId !== this.turnId) {
      if (this.operation || !this.turnId)
        throw new ManagedSessionConflictError(
          'Only a turn can begin a model budget.',
        );
      const directive = parseTurnBudgetDirective(
        extractTurnBudgetDirectiveText(prompt),
      );
      shared.snapshot = {
        sessionId,
        promptId: this.turnId,
        budget: directive?.total ?? null,
        ...(directive ? { directiveText: directive.text } : {}),
        outputTokensAtTurnStart:
          uiTelemetryService.getTotalOutputTokens(sessionId),
      };
    }
    if (shared.snapshot) budget.beginTurn(shared.snapshot);
  }

  async beginMainAttempt(model: string): Promise<ManagedMainModelAttempt> {
    this.assertOwner();
    if (this.operation)
      throw new ManagedSessionConflictError(
        'A Hook operation cannot run the main model loop.',
      );
    const attemptId = `${this.turnId}:main:${randomUUID()}`;
    return Object.assign(
      await this.beginAttempt(attemptId, 'hosted', {
        turnId: this.turnId,
        model,
      }),
      { attemptId },
    );
  }

  private async beginAttempt(
    attemptId: string,
    kind: 'hook' | 'hosted',
    route: object,
  ): Promise<(success: boolean, usage: unknown) => Promise<void>> {
    const authority = this.session.authority;
    const activation = this.session.activation;
    const budget = sessionBudgets.get(authority)?.snapshot ?? null;
    const routeRef = await this.session.resources.publish(
      `managed-${kind}-model-route`,
      Buffer.from(JSON.stringify({ version: 1, ...route, budget })),
    );
    const inputCheckpointRef = authority.latestCheckpoint?.stateRef ?? null;
    const commit = async (
      state: 'started' | 'output_committed' | 'abandoned',
      usageRef: ManagedSessionDurableRef | null,
    ) => {
      this.assertOwner();
      await authority.appendExecutionEvent(
        {
          operation: 'hostedModelAttempt',
          commandId: `${attemptId}:${state}`,
          sessionKey: authority.sessionHeader.sessionKey,
          contentDigest: routeRef.digest,
        },
        (sequence) => ({
          v: 1,
          sequence,
          eventId: `${attemptId}:${state}`,
          sessionKey: authority.sessionHeader.sessionKey,
          kind: 'model.attempt',
          occurredAt: Date.now(),
          subject: {
            type: 'activation',
            scopeId: activation.activationId,
            ...activation,
          },
          payload: { attemptId, routeRef, inputCheckpointRef, state, usageRef },
        }),
        { class: 'harness', activation },
      );
    };
    await commit('started', null);
    return async (success, usage) => {
      const usageRef = await this.session.resources.publish(
        `managed-${kind}-model-usage`,
        Buffer.from(
          JSON.stringify({
            version: 1,
            ...route,
            attempts: usage,
            budget,
            models: uiTelemetryService.getMetricsForSession(
              authority.sessionHeader.sessionKey.sessionId,
            ).models,
          }),
        ),
      );
      await commit(success ? 'output_committed' : 'abandoned', usageRef);
    };
  }

  evaluate(
    operation: ManagedHookModelOperation & {
      readonly eventName: string;
      readonly model: string;
    },
    evaluate: (
      recordUsage: (usage: unknown) => void,
    ) => Promise<HookExecutionResult>,
  ): Promise<HookExecutionResult> {
    this.assertOwner();
    const pending = this.queue.then(async () => {
      this.assertOwner();
      if (
        operation.originTurnId !== this.turnId ||
        (this.operation &&
          operation.occurrenceId !== this.operation.occurrenceId)
      ) {
        throw new ManagedSessionConflictError(
          'Prompt Hook does not belong to this model activation.',
        );
      }
      const authority = this.session.authority;
      const attemptId = `${operation.operationId}:model`;
      if (
        authority
          .eventsInSequenceRange(1, authority.committedSequence)
          .some(
            (event) =>
              event.kind === 'model.attempt' &&
              event.payload['attemptId'] === attemptId,
          )
      ) {
        throw new ManagedSessionConflictError(
          'Prompt Hook model attempt already exists; recovery cannot replay it.',
        );
      }
      const complete = await this.beginAttempt(attemptId, 'hook', operation);
      const usage: unknown[] = [];
      let result: HookExecutionResult | undefined;
      try {
        result = await evaluate((entry) => usage.push(entry));
        return result;
      } finally {
        await complete(
          result?.success === true || result?.outcome === 'blocking',
          usage,
        );
      }
    });
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  async close(): Promise<void> {
    await this.queue;
    this.open = false;
  }

  private assertOwner(): void {
    if (!this.open || !this.isOwner()) {
      throw new ManagedSessionConflictError(
        'Prompt Hook requires the active Session model slot.',
      );
    }
  }
}

const modelOwners = new WeakMap<
  ManagedSession['authority'],
  LocalManagedHookModelScope
>();

export class ManagedHookActivationController {
  constructor(private readonly session: ManagedSession) {}

  runTurn<T>(
    turnId: string,
    run: (scope: ManagedHookModelScope) => Promise<T>,
  ): Promise<T> {
    return this.run(turnId, null, run);
  }

  runHookOperation<T>(
    operation: ManagedHookModelOperation,
    run: (scope: ManagedHookModelScope) => Promise<T>,
  ): Promise<T> {
    return this.run(operation.originTurnId, operation, run);
  }

  private async run<T>(
    turnId: string | null,
    operation: ManagedHookModelOperation | null,
    run: (scope: ManagedHookModelScope) => Promise<T>,
  ): Promise<T> {
    if (modelOwners.has(this.session.authority)) {
      throw new ManagedSessionConflictError('Session model slot is busy.');
    }
    const scope: LocalManagedHookModelScope = new LocalManagedHookModelScope(
      this.session,
      turnId,
      operation,
      () => modelOwners.get(this.session.authority) === scope,
    );
    modelOwners.set(this.session.authority, scope);
    let restoreActivationId: string | undefined;
    try {
      if (operation) {
        const authorization =
          await this.session.authority.harnessRunAuthorization();
        if (
          authorization.status === 'blocked' ||
          (authorization.status === 'runnable' &&
            authorization.checkpoint.continuation.phase !== 'before_model' &&
            authorization.checkpoint.continuation.phase !== 'turn_settled')
        ) {
          throw new ManagedSessionConflictError(
            'Prompt Hook cannot bypass pending Harness recovery.',
          );
        }
        // Hosted Hook release finds the restore by this ID: neither it nor
        // the Hook operation's activation owns a Runtime.
        restoreActivationId = managedHookRestoreActivationId(
          this.session.activation.activationId,
        );
        await this.session.replaceActivation({
          type: 'hook_operation',
          operationId: operation.operationId,
          occurrenceId: operation.occurrenceId,
        });
      }
      const activation = this.session.authority.currentActivation;
      if (
        activation?.phase !== 'active' ||
        activation.activationId !== this.session.activation.activationId ||
        activation.epoch !== this.session.activation.epoch
      ) {
        throw new ManagedSessionConflictError(
          'Prompt Hook requires the current Session activation.',
        );
      }
      return await run(scope);
    } finally {
      await scope.close();
      try {
        if (restoreActivationId !== undefined)
          await this.session.replaceActivation(undefined, restoreActivationId);
      } finally {
        modelOwners.delete(this.session.authority);
      }
    }
  }
}
