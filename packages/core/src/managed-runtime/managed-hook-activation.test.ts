/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HookEventName, HookType } from '../hooks/types.js';
import {
  openManagedSession,
  type ManagedSession,
} from './managed-session-assembly.js';
import {
  ManagedHookActivationController,
  managedHookRestoreActivationId,
  type ManagedHookModelScope,
} from './managed-hook-activation.js';
import { createManagedHarnessHandle } from './managed-harness-factory.js';
import { TurnBudget } from '../core/turn-budget.js';
import { uiTelemetryService, type UiEvent } from '../telemetry/uiTelemetry.js';
import { ApiResponseEvent } from '../telemetry/types.js';
import { EVENT_API_RESPONSE } from '../telemetry/constants.js';

const operation = {
  operationId: 'operation-1',
  occurrenceId: 'occurrence-1',
  originTurnId: null,
};
const evaluation = {
  ...operation,
  eventName: HookEventName.SessionEnd,
  model: 'model-1',
};
const result = {
  hookConfig: { type: HookType.Prompt as const, prompt: 'allow?' },
  eventName: HookEventName.SessionEnd,
  success: true,
  outcome: 'success' as const,
  duration: 2,
};
const sessions: ManagedSession[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })),
  );
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-model-'));
  dirs.push(root);
  const ref = {
    resourceId: 'resource',
    kind: 'managed-test',
    schemaVersion: 1,
    byteLength: 2,
    digest: '9'.repeat(64),
  };
  const options = {
    runtimeBaseDir: root,
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
    transcriptPath: path.join(root, 'session.jsonl'),
    sessionKey: {
      tenantId: 't1',
      workspaceId: 'w1',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
    },
    cwd: root,
    version: 'test',
    workerId: 'worker-1',
    activationLeaseDurationMs: 60_000,
  };
  const session = await openManagedSession({
    ...options,
    create: { definitionRef: ref, rootSnapshotRef: ref, createdBy: 'test' },
  });
  sessions.push(session);
  uiTelemetryService.resetSession(options.sessionId);
  return {
    session,
    options,
    controller: new ManagedHookActivationController(session),
  };
}

describe('Managed Hook model activation', () => {
  it('shares the original turn budget and all model usage with lifecycle Hooks after cold restore', async () => {
    const { session, controller, options } = await fixture();
    await createManagedHarnessHandle(session).ensureRunnable();
    const charge = (model: string, tokens: number) =>
      uiTelemetryService.addEvent(
        {
          ...new ApiResponseEvent('r1', model, 1, 'turn-1', undefined, {
            candidatesTokenCount: tokens,
            totalTokenCount: tokens,
          }),
          'event.name': EVENT_API_RESPONSE,
        } as UiEvent,
        options.sessionId,
      );
    charge('main', 100);
    const budget = new TurnBudget();
    await controller.runTurn('turn-1', async (scope) => {
      await scope.bindBudget(budget, 'finish this +5k');
      await scope.evaluate(
        { ...evaluation, originTurnId: 'turn-1' },
        async (usage) => {
          charge('hook', 20);
          usage({ model: 'hook', usage: { candidatesTokenCount: 20 } });
          return result;
        },
      );
      const complete = await scope.beginMainAttempt('main');
      expect(
        session.authority.lastEventOfKind('model.attempt')?.payload,
      ).toMatchObject({ attemptId: complete.attemptId, state: 'started' });
      charge('main', 30);
      await complete(true, [{ candidatesTokenCount: 30 }]);
      const replacement = new TurnBudget();
      await scope.bindBudget(replacement, 'rewritten prompt +10k');
      expect(replacement.current(options.sessionId)).toEqual(
        budget.current(options.sessionId),
      );
    });
    expect(budget.current(options.sessionId)).toMatchObject({
      budget: 5_000,
      outputTokensAtTurnStart: 100,
    });
    await session.close();
    sessions.splice(sessions.indexOf(session), 1);
    uiTelemetryService.resetSession(options.sessionId);
    const restored = await openManagedSession(options);
    sessions.push(restored);
    const lifecycleBudget = new TurnBudget();
    await new ManagedHookActivationController(restored).runHookOperation(
      { ...operation, operationId: 'lifecycle' },
      async (scope) => {
        await scope.bindBudget(lifecycleBudget);
        expect(lifecycleBudget.current(options.sessionId)).toEqual(
          budget.current(options.sessionId),
        );
        expect(uiTelemetryService.getTotalOutputTokens(options.sessionId)).toBe(
          150,
        );
        await expect(scope.beginMainAttempt('main')).rejects.toThrow(
          'cannot run the main model loop',
        );
        await scope.evaluate(
          { ...evaluation, operationId: 'lifecycle' },
          async (usage) => {
            charge('hook', 10);
            usage({ model: 'hook', usage: { candidatesTokenCount: 10 } });
            return result;
          },
        );
      },
    );
    expect(
      uiTelemetryService.getTotalOutputTokens(options.sessionId) -
        lifecycleBudget.current(options.sessionId)!.outputTokensAtTurnStart,
    ).toBe(60);
    const event = restored.authority.lastEventOfKind('model.attempt')!;
    const saved = JSON.parse(
      (
        await restored.resources.read(event.payload['usageRef'] as never)
      ).toString(),
    );
    expect(saved).toMatchObject({
      operationId: 'lifecycle',
      originTurnId: null,
      budget: { budget: 5_000 },
      attempts: [{ model: 'hook', usage: { candidatesTokenCount: 10 } }],
    });
  });

  it('owns a new epoch, preserves its subject on renewal and survives cold restore without a turn', async () => {
    const { session, controller, options } = await fixture();
    const initialEpoch = session.activation.epoch;
    const replaced = session.activation.activationId;
    let expired: ManagedHookModelScope | undefined;
    await controller.runHookOperation(operation, async (scope) => {
      expired = scope;
      expect(session.activation.epoch).toBe(initialEpoch + 1);
      expect(session.authority.currentActivationSubject).toEqual({
        type: 'hook_operation',
        operationId: operation.operationId,
        occurrenceId: operation.occurrenceId,
      });
      await session.authority.renewActivation({ leaseDurationMs: 60_000 });
      expect(session.authority.currentActivationSubject?.type).toBe(
        'hook_operation',
      );
      await expect(
        scope.evaluate(evaluation, async (usage) => {
          usage({ totalTokenCount: 7 });
          return result;
        }),
      ).resolves.toEqual(result);
    });
    expect(session.activation.epoch).toBe(initialEpoch + 2);
    expect(session.activation.activationId).toBe(
      managedHookRestoreActivationId(replaced),
    );
    expect(() => expired!.evaluate(evaluation, async () => result)).toThrow(
      'active Session model slot',
    );
    const events = session.authority.eventsInSequenceRange(
      1,
      session.authority.committedSequence,
    );
    const attempts = events.filter((event) => event.kind === 'model.attempt');
    expect(attempts.map((event) => event.payload['state'])).toEqual([
      'started',
      'output_committed',
    ]);
    expect(
      events.some(
        (event) =>
          event.kind === 'turn.settled' ||
          event.kind === 'checkpoint.committed',
      ),
    ).toBe(false);
    const usage = JSON.parse(
      (
        await session.resources.read(attempts[1].payload['usageRef'] as never)
      ).toString(),
    );
    expect(usage).toMatchObject({
      ...evaluation,
      attempts: [{ totalTokenCount: 7 }],
    });
    expect(await session.authority.harnessRunAuthorization()).toEqual({
      status: 'initial',
    });
    await session.close();
    sessions.splice(sessions.indexOf(session), 1);
    const restored = await openManagedSession(options);
    sessions.push(restored);
    expect(await restored.authority.harnessRunAuthorization()).toEqual({
      status: 'initial',
    });
  });

  it('shares the Session slot with turns and other controller instances', async () => {
    const { session, controller } = await fixture();
    const other = new ManagedHookActivationController(session);
    await controller.runTurn('turn-1', async () => {
      await expect(
        other.runHookOperation(operation, async () => undefined),
      ).rejects.toThrow('slot is busy');
      await expect(
        other.runTurn('turn-2', async () => undefined),
      ).rejects.toThrow('slot is busy');
    });
    await other.runHookOperation(operation, async () => undefined);
  });

  it('restores a turn activation when installing a Hook activation fails', async () => {
    const { session, controller } = await fixture();
    const replaced = session.activation.activationId;
    const failure = new Error('install resource failed');
    vi.spyOn(session.authority, 'installActivation').mockRejectedValueOnce(
      failure,
    );
    const evaluate = vi.fn();

    await expect(controller.runHookOperation(operation, evaluate)).rejects.toBe(
      failure,
    );

    expect(evaluate).not.toHaveBeenCalled();
    expect(session.authority.currentActivation).toMatchObject({
      ...session.activation,
      phase: 'active',
    });
    expect(session.authority.currentActivationSubject?.type).not.toBe(
      'hook_operation',
    );
    expect(session.activation.activationId).toBe(
      managedHookRestoreActivationId(replaced),
    );
    await expect(
      controller.runTurn('next-turn', async () => 'accepted'),
    ).resolves.toBe('accepted');
    await expect(
      controller.runHookOperation(operation, async () => 'retry'),
    ).resolves.toBe('retry');
  });

  it('derives a stable restore activation ID', () => {
    // A later build must still recognize the restores an earlier one recorded.
    const id = managedHookRestoreActivationId(
      '00000000-0000-4000-8000-000000000000',
    );
    expect(id).toBe('f31ba97f-91c5-5815-83c9-3da5e9cec2bc');
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('serializes prompt Hooks inside a turn and preserves the checkpoint', async () => {
    const { session, controller } = await fixture();
    await createManagedHarnessHandle(session).ensureRunnable();
    const checkpoint = session.authority.latestCheckpoint;
    const activation = session.activation;
    let finish!: () => void;
    const firstFinished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const second = vi.fn(async () => result);
    await controller.runTurn('turn-1', async (scope) => {
      const first = scope.evaluate(
        { ...evaluation, originTurnId: 'turn-1' },
        async () => {
          await firstFinished;
          return result;
        },
      );
      const next = scope.evaluate(
        { ...evaluation, operationId: 'operation-2', originTurnId: 'turn-1' },
        second,
      );
      expect(second).not.toHaveBeenCalled();
      finish();
      await Promise.all([first, next]);
    });
    expect(second).toHaveBeenCalledOnce();
    expect(session.activation).toEqual(activation);
    expect(session.authority.latestCheckpoint).toEqual(checkpoint);
    expect(
      session.authority
        .eventsInSequenceRange(1, session.authority.committedSequence)
        .filter((event) => event.kind === 'model.attempt')
        .map((event) => event.payload['state']),
    ).toEqual(['started', 'output_committed', 'started', 'output_committed']);
  });

  it.each([
    'await_runtime',
    'await_action',
    'results_ready',
    'model_output_committed',
  ])('does not bypass %s recovery', async (phase) => {
    const { session, controller } = await fixture();
    const evaluate = vi.fn();
    const epoch = session.activation.epoch;
    vi.spyOn(session.authority, 'harnessRunAuthorization').mockResolvedValue({
      status: 'runnable',
      checkpoint: { continuation: { phase } },
    } as never);
    await expect(
      controller.runHookOperation(operation, evaluate),
    ).rejects.toThrow('pending Harness recovery');
    expect(evaluate).not.toHaveBeenCalled();
    expect(session.activation.epoch).toBe(epoch);
  });

  it('records failed evaluation as abandoned and refuses replay or cross-origin evaluation', async () => {
    const { session, controller } = await fixture();
    await controller.runHookOperation(operation, async (scope) => {
      await expect(
        scope.evaluate(
          { ...evaluation, originTurnId: 'other-turn' },
          async () => result,
        ),
      ).rejects.toThrow('does not belong');
      await expect(
        scope.evaluate(evaluation, async () => {
          throw new Error('provider failed');
        }),
      ).rejects.toThrow('provider failed');
      await expect(
        scope.evaluate(evaluation, async () => result),
      ).rejects.toThrow('already exists');
    });
    expect(
      session.authority.lastEventOfKind('model.attempt')?.payload['state'],
    ).toBe('abandoned');
    expect(await session.authority.harnessRunAuthorization()).toEqual({
      status: 'initial',
    });
  });
});
