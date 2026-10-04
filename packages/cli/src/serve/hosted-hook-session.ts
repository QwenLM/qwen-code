/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { HookAggregator } from '@qwen-code/qwen-code-core/hooks/hookAggregator.js';
import { applyHookOutputToInput } from '@qwen-code/qwen-code-core/hooks/hook-sequential-input.js';
import {
  getHookMatcherTarget,
  getToolMatcherTargets,
} from '@qwen-code/qwen-code-core/hooks/hookPlanner.js';
import { matchesHookPattern } from '@qwen-code/qwen-code-core/hooks/hook-matcher.js';
import {
  HookEventName,
  HookType,
  createHookOutput,
} from '@qwen-code/qwen-code-core/hooks/types.js';
import type {
  HookConfig,
  HookInput,
  HookOutput,
  HookExecutionResult,
  PromptHookConfig,
} from '@qwen-code/qwen-code-core/hooks/types.js';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import type {
  ManagedSessionDurableRef,
  ManagedSessionSubject,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { managedHookRestoreActivationId } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-activation.js';
import type { ExtensionRun } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import {
  parseHookExecution,
  parseHookRegistration,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-record.js';
import type {
  HookExecution,
  HookRegistration,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-record.js';
import { MANAGED_HOOK_MAX_REQUEST_BYTES } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-protocol.js';
import type {
  ManagedHookCatalog,
  ManagedHookCatalogPin,
  ManagedHookControl,
  ManagedHookDescriptor,
  ManagedHookOperationView,
  ManagedHookResult,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-protocol.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
} from './hosted-workspace-broker.js';
import type { HostedWorkspaceBrokerOptions } from './hosted-workspace-broker.js';
import { waitForTurn } from './hosted-turn-wait.js';

export class HostedHookRecoveryRequiredError extends Error {
  constructor() {
    super('Hosted Hook requires reconciliation of its original execution.');
  }
}

export class HostedHookInputConflictError extends Error {
  constructor() {
    super('Hook occurrence input conflict.');
  }
}

export type HostedPromptHookRunner = (
  config: PromptHookConfig,
  event: HookEventName,
  input: HookInput,
  signal: AbortSignal,
) => Promise<HookExecutionResult>;

interface HookPlan {
  readonly registrationId: string;
  readonly input: HookInput;
  readonly hooks: readonly ManagedHookDescriptor[];
  readonly sequential: boolean;
  readonly messagesRef?: ManagedSessionDurableRef;
  readonly refusedInputDigest?: string;
}

function exceedsHookResourceLimit(value: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(value)) > 60 * 1024;
}

function byteLimitOutput(event: HookEventName): HookOutput {
  return {
    continue: false,
    decision: 'block',
    reason:
      'Hook data exceeds the 60 KiB resource or 8 MiB control/transaction limit.',
    ...(event === HookEventName.PermissionRequest
      ? {
          hookSpecificOutput: {
            decision: { behavior: 'deny', interrupt: true },
          },
        }
      : {}),
  };
}

function sequentialInput(
  input: HookInput,
  result: Pick<ManagedHookResult, 'success' | 'output'>,
  event: HookEventName,
): HookInput {
  if (!result.success || !result.output) return input;
  const effective = applyHookOutputToInput(input, result.output, event);
  const output = result.output.hookSpecificOutput;
  return {
    ...effective,
    ...(output?.['updatedInput'] && typeof output['updatedInput'] === 'object'
      ? { tool_input: output['updatedInput'] }
      : {}),
    ...(typeof output?.['updatedPrompt'] === 'string'
      ? { prompt: output['updatedPrompt'] }
      : {}),
  };
}

function semanticInput(value: object): Record<string, unknown> {
  const fields = { ...value } as Record<string, unknown>;
  for (const key of [
    'session_id',
    'transcript_path',
    'cwd',
    'hook_event_name',
    'timestamp',
    'messages',
  ])
    delete fields[key];
  return JSON.parse(JSON.stringify(fields)) as Record<string, unknown>;
}

function semanticInputDigest(value: object): string {
  return createHash('sha256')
    .update(
      JSON.stringify(semanticInput(value), (_key, item: unknown) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(
              Object.entries(item).sort(([left], [right]) =>
                left < right ? -1 : left > right ? 1 : 0,
              ),
            )
          : item,
      ),
    )
    .digest('hex');
}

function cancelledResult(): ManagedHookResult {
  return {
    success: false,
    outcome: 'cancelled',
    duration: 0,
    output: {
      continue: false,
      decision: 'block',
      reason: 'Hook execution cancelled.',
    },
  };
}

function executionUnavailable(response: ManagedHookOperationView): boolean {
  return (
    response.state === 'settled' &&
    (response.error?.code === 'managed_hook_handler_unavailable' ||
      response.error?.code === 'managed_hook_command_isolation_unavailable')
  );
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// Committed record revisions are immutable objects, so each is validated
// once however often the Session's history is scanned.
const parsedExecutions = new WeakMap<object, HookExecution>();

function savedExecution(record: unknown): HookExecution {
  let parsed = parsedExecutions.get(record as object);
  if (parsed === undefined) {
    parsed = parseHookExecution(record);
    parsedExecutions.set(record as object, parsed);
  }
  return parsed;
}

export function hostedHookOccurrenceId(
  event: HookEventName,
  occurrenceId: string,
): string {
  return `hook-plan-${digest([event, occurrenceId])}`;
}

export function parseHostedHookPin(value: unknown): ManagedHookCatalogPin {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Hook catalog pin.');
  const pin = value as Record<string, unknown>;
  if (
    Object.keys(pin).sort().join(',') !==
      'catalogId,catalogRevision,definitionDigest' ||
    typeof pin['catalogId'] !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(pin['catalogId']) ||
    !Number.isSafeInteger(pin['catalogRevision']) ||
    (pin['catalogRevision'] as number) < 1 ||
    typeof pin['definitionDigest'] !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(pin['definitionDigest'])
  )
    throw new Error('Invalid Hook catalog pin.');
  return {
    catalogId: pin['catalogId'],
    catalogRevision: pin['catalogRevision'] as number,
    definitionDigest: pin['definitionDigest'],
  };
}

export class HostedHookSession {
  readonly broker: HostedWorkspaceBroker;
  private readonly ownsBroker: boolean;
  private acquired = false;
  private acquiring?: Promise<void>;
  private readonly aggregator = new HookAggregator();
  private catalog?: ManagedHookCatalog;
  private registration?: HookRegistration;
  private readonly pending = new Map<
    string,
    {
      result: Promise<ManagedHookResult>;
      admitted: Promise<void>;
      abort: AbortController;
    }
  >();
  private readonly recoveredBrokers = new Map<string, HostedWorkspaceBroker>();
  private readonly releasedOwners = new Set<string>();
  private readonly occurrences = new Map<
    string,
    {
      input: Record<string, unknown>;
      result: Promise<HookOutput | undefined>;
    }
  >();
  private writes: Promise<void> = Promise.resolve();
  private occurrenceQueue: Promise<void> = Promise.resolve();
  private readonly stopPlanPrompts = new Map<string, unknown>();
  private children?: {
    readonly sequence: number;
    readonly byOccurrence: Map<string, HookExecution[]>;
  };
  private messagesProvider?: () => Array<Record<string, unknown>>;

  /**
   * Construct only on a load activation. Release finds earlier owners by
   * load activations alone, so an owner named after a Hook operation's
   * activation or its restore would never be released by a successor.
   */
  constructor(
    private readonly options: HostedWorkspaceBrokerOptions,
    private readonly session: ManagedSession,
    private readonly initialPin: ManagedHookCatalogPin,
    broker?: HostedWorkspaceBroker,
  ) {
    this.ownsBroker = broker === undefined;
    this.broker =
      broker ??
      new HostedWorkspaceBroker(
        options,
        this.key,
        `hooks-activation-${digest([session.activation.activationId, session.activation.epoch])}`,
      );
  }

  private get key() {
    return this.session.authority.sessionHeader.sessionKey;
  }

  async ensureReady(signal?: AbortSignal): Promise<void> {
    if (this.catalog) return;
    const registrations =
      this.session.authority.extensionRecordsInDomain('hook_registration');
    const latest = registrations.at(-1);
    if (latest) {
      const registration = parseHookRegistration(latest.record);
      await this.settleRegistration(registration);
      this.registration = parseHookRegistration(
        this.session.authority.extensionRecord(
          'hook_registration',
          registration.registrationId,
        )!.record,
      );
      this.catalog = await this.read<ManagedHookCatalog>(
        registration.catalogRef,
      );
      return;
    }
    await this.configure(
      `hook-catalog-${digest(this.initialPin)}`,
      this.initialPin,
      0,
      signal,
    );
  }

  async acquire(): Promise<void> {
    if (this.acquired) return;
    // Parallel Hooks share one acquisition, so each earlier owner is
    // released once.
    this.acquiring ??= (async () => {
      try {
        await this.releaseEarlierOwners();
        await this.broker.warm();
        await this.broker.acquire();
        if (!this.broker.runtime) throw new HostedHookRecoveryRequiredError();
        this.acquired = true;
      } finally {
        this.acquiring = undefined;
      }
    })();
    await this.acquiring;
  }

  private async releaseEarlierOwners(): Promise<void> {
    if (!this.ownsBroker) return;
    const owners = new Map<string, boolean>();
    const { authority } = this.session;
    const restores = new Set<string>();
    // Activation is durable before even the first catalog request acquires.
    for (const event of authority.eventsInSequenceRange(
      1,
      authority.committedSequence,
    )) {
      if (event.kind !== 'activation.changed') continue;
      // Only a load constructs a Hook owner. A Hook operation's activation,
      // and the one it restores on finishing, never acquire.
      const activationId = event.payload['activationId'] as string;
      restores.add(managedHookRestoreActivationId(activationId));
      if (
        restores.has(activationId) ||
        (event.payload['subject'] as ManagedSessionSubject).type ===
          'hook_operation'
      )
        continue;
      const id = `hooks-activation-${digest([activationId, event.payload['epoch']])}`;
      if (id !== this.broker.runtimeSessionId && !this.releasedOwners.has(id))
        owners.set(id, true);
    }
    for (const record of this.executions()) {
      const id = record.runtimeSessionId;
      if (id === this.broker.runtimeSessionId || this.releasedOwners.has(id))
        continue;
      const settled =
        record.run.state !== 'recovery_blocked' &&
        (record.resultRef !== null ||
          record.run.execution === 'not_started_proven');
      owners.set(id, (owners.get(id) ?? true) && settled);
    }
    for (const [id, settled] of owners) {
      if (!settled) continue;
      const broker =
        this.recoveredBrokers.get(id) ??
        new HostedWorkspaceBroker(this.options, this.key, id);
      try {
        await broker.release();
      } catch (cause) {
        if (
          !(cause instanceof HostedWorkspaceBrokerRejection) ||
          cause.status !== 404 ||
          cause.code !== 'runtime_session_not_found'
        )
          throw cause;
      }
      this.recoveredBrokers.delete(id);
      this.releasedOwners.add(id);
    }
  }

  get hasPendingOperations(): boolean {
    return this.executions().some((record) => {
      if (record.run.state === 'recovery_blocked') return true;
      if (record.resultRef || record.run.execution === 'not_started_proven')
        return false;
      if (record.hookId === '__plan__') return true;
      const marker = this.session.authority.extensionRecord(
        'hook_execution',
        record.occurrenceId,
      );
      return !marker || savedExecution(marker.record).resultRef === null;
    });
  }

  get hasUnsettledExecutions(): boolean {
    return this.executions().some(
      (record) =>
        !record.resultRef && record.run.execution !== 'not_started_proven',
    );
  }

  hasCompletedOccurrence(event: HookEventName, occurrenceId: string): boolean {
    const saved = this.session.authority.extensionRecord(
      'hook_execution',
      hostedHookOccurrenceId(event, occurrenceId),
    );
    if (!saved) return false;
    const record = parseHookExecution(saved.record);
    return (
      record.resultRef !== null || record.run.execution === 'not_started_proven'
    );
  }

  async wasStopBlocked(promptId: string): Promise<boolean> {
    for (const record of this.executions()) {
      if (
        record.hookId !== '__plan__' ||
        record.eventName !== HookEventName.Stop ||
        !record.resultRef
      )
        continue;
      // A plan never changes, so each one is read once rather than on
      // every turn of a long Session.
      const planId = record.planRef.resourceId;
      if (!this.stopPlanPrompts.has(planId))
        this.stopPlanPrompts.set(
          planId,
          (await this.read<HookPlan>(record.planRef)).input.prompt_id,
        );
      if (this.stopPlanPrompts.get(planId) !== promptId) continue;
      const result = await this.read<{ output?: HookOutput }>(record.resultRef);
      const output =
        result.output && createHookOutput(HookEventName.Stop, result.output);
      if (output?.isBlockingDecision() || output?.shouldStopExecution())
        return true;
    }
    return false;
  }

  async needsPromptRunner(
    event: HookEventName,
    occurrenceId: string,
  ): Promise<boolean> {
    await this.ensureReady();
    const saved = this.session.authority.extensionRecord(
      'hook_execution',
      hostedHookOccurrenceId(event, occurrenceId),
    );
    if (saved) {
      const record = parseHookExecution(saved.record);
      if (record.resultRef || record.run.execution === 'not_started_proven')
        return false;
    }
    const hooks = saved
      ? (await this.read<HookPlan>(parseHookExecution(saved.record).planRef))
          .hooks
      : this.catalog!.hooks.filter((hook) => hook.eventName === event);
    return hooks.some((hook) => hook.config.type === HookType.Prompt);
  }

  getCatalog(): ManagedHookCatalog | undefined {
    return this.catalog && structuredClone(this.catalog);
  }

  setMessagesProvider(provider?: () => Array<Record<string, unknown>>): void {
    this.messagesProvider = provider;
  }

  async configure(
    operationId: string,
    pin: ManagedHookCatalogPin,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const records =
      this.session.authority.extensionRecordsInDomain('hook_registration');
    const previous = this.session.authority.extensionRecord(
      'hook_registration',
      operationId,
    );
    if (previous) {
      const registration = parseHookRegistration(previous.record);
      if (!isDeepStrictEqual(registration.run.definition, this.definition(pin)))
        throw new Error('Hook registration identity conflict.');
      await this.settleRegistration(registration);
      const latest = this.session.authority
        .extensionRecordsInDomain('hook_registration')
        .filter((entry) => entry.run.state === 'settled')
        .at(-1);
      if (!latest) throw new HostedHookRecoveryRequiredError();
      this.registration = parseHookRegistration(latest.record);
      this.catalog = await this.read<ManagedHookCatalog>(
        this.registration.catalogRef,
      );
      return;
    }
    if (records.length !== expectedRevision)
      throw new Error('Hook catalog revision conflict.');
    if (
      records.some((entry) => {
        const registration = parseHookRegistration(entry.record);
        return (
          registration.catalogId === pin.catalogId &&
          registration.catalogRevision >= pin.catalogRevision
        );
      })
    )
      throw new Error('Hook catalog revision must advance within its catalog.');
    await waitForTurn(this.acquire(), signal);
    const response = await waitForTurn(
      this.broker.hookControl({
        kind: 'hook-catalog',
        sessionKey: this.key,
        operationId,
        pin,
      }),
      signal,
    );
    const catalog = response.catalog;
    if (
      response.state !== 'settled' ||
      !catalog ||
      catalog.hooks.some(
        (hook) => hook.async && hook.config.type === HookType.Prompt,
      ) ||
      !isDeepStrictEqual(
        parseHostedHookPin({
          catalogId: catalog.catalogId,
          catalogRevision: catalog.catalogRevision,
          definitionDigest: catalog.definitionDigest,
        }),
        pin,
      )
    )
      throw new Error('Hook catalog unavailable.');
    const registration: HookRegistration = {
      registrationId: operationId,
      catalogId: pin.catalogId,
      catalogRevision: pin.catalogRevision,
      catalogRef: await this.publish('managed-hook-catalog', catalog),
      run: { ...this.run(operationId, pin), execution: null },
    };
    signal?.throwIfAborted();
    await this.commit('hook_registration', operationId, registration);
    await this.settleRegistration(registration);
    this.registration = registration;
    this.catalog = catalog;
  }

  private async settleRegistration(
    registration: HookRegistration,
  ): Promise<void> {
    if (registration.run.state === 'admitted') {
      registration = {
        ...registration,
        run: { ...registration.run, state: 'running' },
      };
      await this.commit(
        'hook_registration',
        registration.registrationId,
        registration,
      );
    }
    if (registration.run.state === 'running')
      await this.commit('hook_registration', registration.registrationId, {
        ...registration,
        run: { ...registration.run, state: 'settled' },
      });
  }

  async fire(
    event: HookEventName,
    occurrenceId: string,
    fields: Record<string, unknown>,
    signal: AbortSignal,
    prompt?: HostedPromptHookRunner,
  ): Promise<HookOutput | undefined> {
    const key = hostedHookOccurrenceId(event, occurrenceId);
    const input = semanticInput(fields);
    const running = this.occurrences.get(key);
    if (running) {
      if (!isDeepStrictEqual(running.input, input))
        throw new HostedHookInputConflictError();
      return running.result;
    }
    const promise = this.occurrenceQueue.then(() =>
      this.fireOccurrence(event, key, fields, signal, prompt),
    );
    this.occurrenceQueue = promise.then(
      () => undefined,
      () => undefined,
    );
    this.occurrences.set(key, { input, result: promise });
    try {
      return await promise;
    } finally {
      this.occurrences.delete(key);
    }
  }

  private async fireOccurrence(
    event: HookEventName,
    occurrenceId: string,
    fields: Record<string, unknown>,
    signal: AbortSignal,
    prompt?: HostedPromptHookRunner,
  ): Promise<HookOutput | undefined> {
    await this.ensureReady(signal);
    const previous = this.session.authority.extensionRecord(
      'hook_execution',
      occurrenceId,
    );
    let marker: HookExecution;
    let plan: HookPlan;
    if (previous) {
      marker = parseHookExecution(previous.record);
      plan = await this.read<HookPlan>(marker.planRef);
      if (
        plan.refusedInputDigest
          ? plan.refusedInputDigest !== semanticInputDigest(fields)
          : !isDeepStrictEqual(semanticInput(plan.input), semanticInput(fields))
      )
        throw new HostedHookInputConflictError();
      if (marker.run.execution === 'not_started_proven')
        return cancelledResult().output;
      if (marker.resultRef)
        return (await this.read<{ output?: HookOutput }>(marker.resultRef))
          .output;
    } else {
      if (this.hasPendingOperations)
        throw new HostedHookRecoveryRequiredError();
      const { messages: suppliedMessages, ...eventFields } = fields;
      const input: HookInput = {
        ...eventFields,
        session_id: this.key.sessionId,
        transcript_path: '',
        cwd: '',
        hook_event_name: event,
        timestamp: new Date().toISOString(),
      };
      const target = getHookMatcherTarget(event, {
        toolName: fields['tool_name'] as string | undefined,
        commandName: fields['command_name'] as string | undefined,
        trigger: (fields['source'] ?? fields['reason'] ?? fields['trigger']) as
          | string
          | undefined,
        agentType: fields['agent_type'] as string | undefined,
        notificationType: fields['notification_type'] as string | undefined,
        filePath: fields['file_path'] as string | undefined,
        error: fields['error'] as string | undefined,
      });
      const usedOnce = new Set(
        this.executions()
          .map((entry) => entry.onceKey)
          .filter(Boolean),
      );
      const hooks = this.catalog!.hooks.filter(
        (hook) =>
          hook.eventName === event &&
          hook.enabled !== false &&
          hook.sourceTrusted !== false &&
          (!hook.owner || hook.owner.sessionId === this.key.sessionId) &&
          (!hook.agentScope ||
            (hook.owner !== undefined &&
              hook.owner.agentId === (fields['agent_id'] ?? null))) &&
          (!hook.onceKey || !usedOnce.has(hook.onceKey)) &&
          (!hook.matcher ||
            !target?.target ||
            matchesHookPattern(
              hook.matcher,
              target.target,
              target.kind === 'toolName'
                ? { aliases: getToolMatcherTargets(target.target) }
                : {},
            )),
      )
        .filter(
          (hook, index, matched) =>
            !hook.plannerKey ||
            matched.findIndex(
              (candidate) => candidate.plannerKey === hook.plannerKey,
            ) === index,
        )
        .filter(
          (hook, index, matched) =>
            !hook.onceKey ||
            matched.findIndex(
              (candidate) => candidate.onceKey === hook.onceKey,
            ) === index,
        );
      plan = {
        registrationId: this.registration!.registrationId,
        input,
        hooks,
        sequential: hooks.some((hook) => hook.sequential),
      };
      let messagesLimitExceeded = false;
      if (
        !exceedsHookResourceLimit(plan) &&
        hooks.some((hook) => hook.config.type === HookType.Function)
      ) {
        const messages =
          suppliedMessages ??
          this.messagesProvider?.() ??
          (await this.session.sink.project()).flatMap((record) =>
            (record.type === 'user' ||
              record.type === 'assistant' ||
              record.type === 'tool_result') &&
            record.message
              ? [record.message]
              : [],
          );
        const bytes = Buffer.from(JSON.stringify(messages));
        // Reserve space for the plan, input, chunk manifest and record closure.
        messagesLimitExceeded =
          bytes.length > MANAGED_HOOK_MAX_REQUEST_BYTES - 256 * 1024;
        if (!messagesLimitExceeded)
          plan = {
            ...plan,
            messagesRef: await this.publishMessages(bytes),
          };
      }
      if (messagesLimitExceeded || exceedsHookResourceLimit(plan)) {
        plan = {
          registrationId: plan.registrationId,
          refusedInputDigest: semanticInputDigest(input),
          input: {
            session_id: input.session_id,
            transcript_path: '',
            cwd: '',
            hook_event_name: event,
            timestamp: input.timestamp,
            ...(typeof input.prompt_id === 'string' &&
            Buffer.byteLength(input.prompt_id) <= 512
              ? { prompt_id: input.prompt_id }
              : {}),
          },
          hooks: [],
          sequential: false,
        };
      }
      const planRef = await this.publish('managed-hook-plan', plan);
      marker = {
        hookExecutionId: occurrenceId,
        occurrenceId,
        runtimeSessionId: this.broker.runtimeSessionId,
        registrationId: plan.registrationId,
        eventName: event,
        ordinal: 0,
        hookId: '__plan__',
        planRef,
        inputRef: await this.publish('managed-hook-input', plan.input),
        resultRef: null,
        onceKey: null,
        cancelRequested: false,
        run: this.run(occurrenceId, this.catalog!),
      };
      await this.commit('hook_execution', occurrenceId, marker);
    }
    if (marker.run.execution === 'intent') {
      await this.broker.authorizeLifecycle();
      marker = {
        ...marker,
        run: { ...marker.run, state: 'running', execution: 'dispatch_started' },
      };
      await this.commit('hook_execution', occurrenceId, marker);
    }
    const results: HookExecutionResult[] = [];
    let effectiveInput: HookInput = {
      ...structuredClone(plan.input),
    };
    let inputLimitExceeded = plan.refusedInputDigest !== undefined;
    const execute = async (
      hook: ManagedHookDescriptor,
      index: number,
    ): Promise<HookExecutionResult> => {
      const result = await this.executeHook(
        marker,
        hook,
        index + 1,
        plan.sequential ? effectiveInput : plan.input,
        signal,
        prompt,
      );
      return {
        ...result,
        hookConfig: hook.config as HookConfig,
        eventName: event,
        ...(result.error ? { error: new Error(result.error) } : {}),
      } as HookExecutionResult;
    };
    if (plan.sequential) {
      for (const [index, hook] of plan.hooks.entries()) {
        if (exceedsHookResourceLimit(effectiveInput)) {
          inputLimitExceeded = true;
          break;
        }
        const result = await execute(hook, index);
        results.push(result);
        effectiveInput = sequentialInput(effectiveInput, result, event);
      }
    } else {
      const settled = await Promise.allSettled(plan.hooks.map(execute));
      for (const result of settled) {
        if (result.status === 'rejected') throw result.reason;
        results.push(result.value);
      }
    }
    const cancelled =
      this.cancelRequested(marker.hookExecutionId) || signal.aborted;
    const output = cancelled
      ? cancelledResult().output
      : inputLimitExceeded
        ? byteLimitOutput(event)
        : this.aggregateOutput(results, event);
    const resultRef = await this.publish('managed-hook-result', {
      ...(output ? { output: createHookOutput(event, output) } : {}),
    });
    await this.commit('hook_execution', occurrenceId, {
      ...marker,
      resultRef,
      run: {
        ...marker.run,
        state: cancelled ? 'cancelled' : 'settled',
        execution: 'settled',
        reason: null,
      },
    });
    return output;
  }

  private async executeHook(
    marker: HookExecution,
    hook: ManagedHookDescriptor,
    ordinal: number,
    input: HookInput,
    signal: AbortSignal,
    prompt?: HostedPromptHookRunner,
  ): Promise<ManagedHookResult> {
    const id = `hook-${digest([marker.occurrenceId, ordinal])}`;
    const existing = this.session.authority.extensionRecord(
      'hook_execution',
      id,
    );
    if (
      !existing &&
      (signal.aborted || this.cancelRequested(marker.hookExecutionId))
    )
      return cancelledResult();
    if (hook.async && hook.config.type === HookType.Prompt)
      throw new Error('Prompt Hooks cannot run asynchronously.');
    let record: HookExecution = existing
      ? parseHookExecution(existing.record)
      : {
          ...marker,
          hookExecutionId: id,
          ordinal,
          hookId: hook.hookId,
          inputRef: await this.publish('managed-hook-input', input),
          resultRef: null,
          onceKey: hook.onceKey,
          run: {
            ...marker.run,
            state: 'admitted',
            execution: 'intent',
            effectId: id,
            runtime: null,
          },
        };
    if (!existing) await this.commit('hook_execution', id, record);
    if (record.resultRef) return this.read<ManagedHookResult>(record.resultRef);
    if (record.run.execution === 'not_started_proven') {
      if (record.run.state === 'recovery_blocked')
        throw new HostedHookRecoveryRequiredError();
      return cancelledResult();
    }
    const pending = this.pending.get(id);
    if (pending) {
      if (!hook.async) return pending.result;
      const completed = await Promise.race([
        pending.admitted.then(() => null),
        pending.result,
      ]);
      return completed ?? this.asyncAdmission();
    }
    const abort = new AbortController();
    const executionSignal = hook.async
      ? abort.signal
      : AbortSignal.any([signal, abort.signal]);
    let admit: () => void;
    const admitted = new Promise<void>((resolve) => {
      admit = resolve;
    });
    const cancelBeforeDispatch = async () => {
      await this.commit('hook_execution', id, {
        ...record,
        cancelRequested: true,
        run: {
          ...record.run,
          state: 'cancelled',
          execution: 'not_started_proven',
        },
      });
      return cancelledResult();
    };
    const perform = async (): Promise<ManagedHookResult> => {
      let response: ManagedHookOperationView;
      if (record.run.execution === 'intent') {
        if (
          executionSignal.aborted ||
          this.cancelRequested(id) ||
          this.cancelRequested(marker.hookExecutionId)
        )
          return cancelBeforeDispatch();
        const broker =
          hook.config.type === HookType.Prompt
            ? undefined
            : await this.executionBroker(record);
        if (
          executionSignal.aborted ||
          this.cancelRequested(id) ||
          this.cancelRequested(marker.hookExecutionId)
        )
          return cancelBeforeDispatch();
        if (hook.config.type === HookType.Prompt && !prompt)
          throw new Error('Hook model activation is unavailable.');
        await this.broker.authorizeLifecycle();
        record = {
          ...record,
          run: {
            ...record.run,
            state: 'running',
            execution: 'dispatch_started',
            runtime:
              hook.config.type === HookType.Prompt
                ? null
                : {
                    runtimeBindingId: broker!.runtime!.bindingId,
                    generation: broker!.runtime!.generation,
                  },
          },
        };
        await this.commit('hook_execution', id, record);
        if (
          executionSignal.aborted ||
          this.cancelRequested(id) ||
          this.cancelRequested(marker.hookExecutionId)
        )
          return cancelBeforeDispatch();
        if (hook.config.type === HookType.Prompt) {
          const originalInput = await this.read<HookInput>(record.inputRef);
          const result = await prompt!(
            hook.config,
            marker.eventName as HookEventName,
            {
              ...originalInput,
              managed_hook_execution_id: id,
              managed_hook_occurrence_id: marker.occurrenceId,
              managed_hook_origin_turn_id: originalInput.prompt_id ?? null,
            } as HookInput,
            executionSignal,
          );
          response = {
            operationId: id,
            state: 'settled',
            result: {
              success: result.success,
              outcome:
                result.outcome ??
                (result.success ? 'success' : 'non_blocking_error'),
              duration: result.duration,
              ...(result.output ? { output: result.output } : {}),
              ...(result.error ? { error: 'managed_hook_model_failed' } : {}),
            },
          };
        } else {
          const originalInput = await this.read<HookInput>(record.inputRef);
          const plan = await this.read<HookPlan>(record.planRef);
          const messages =
            hook.config.type === HookType.Function && plan.messagesRef
              ? await this.readMessages(plan.messagesRef)
              : undefined;
          const operation: ManagedHookControl = {
            kind: 'hook-execute',
            sessionKey: this.key,
            operationId: id,
            pin: {
              catalogId: record.run.definition!.definitionId,
              catalogRevision: record.run.definition!.definitionRevision,
              definitionDigest: record.run.definition!.definitionDigest,
            },
            hookId: hook.hookId,
            input: {
              ...originalInput,
              ...(messages ? { messages } : {}),
            },
            grant: this.session.authority.issueOperationGrant({
              domain: 'hook_execution',
              recordId: id,
              ownerId: this.session.authority.currentActivation!.workerId,
              workspaceGeneration: broker!.runtime!.workspaceGeneration,
              phases: ['execute'],
              leaseDurationMs: 300_000,
            }),
          };
          if (
            Buffer.byteLength(
              JSON.stringify({
                protocolVersion: 1,
                requestId: '00000000-0000-0000-0000-000000000000',
                harnessSessionId: this.key.sessionId,
                runtimeSessionId: record.runtimeSessionId,
                operation,
              }),
            ) > MANAGED_HOOK_MAX_REQUEST_BYTES
          ) {
            await this.commit('hook_execution', id, {
              ...record,
              run: {
                ...record.run,
                state: 'failed',
                execution: 'not_started_proven',
                reason: 'byte_limit',
              },
            });
            return {
              success: false,
              outcome: 'non_blocking_error',
              duration: 0,
              error: 'managed_hook_control_too_large',
              output: {
                continue: false,
                decision: 'block',
                reason: 'Hook control exceeds the 8 MiB limit.',
                ...(marker.eventName === HookEventName.PermissionRequest
                  ? { hookSpecificOutput: { decision: { behavior: 'deny' } } }
                  : {}),
              },
            };
          }
          try {
            response = await broker!.hookControl(operation);
          } catch {
            response = await this.lookup(record);
          }
        }
      } else response = await this.lookup(record);
      if (response.state === 'running') admit!();
      const deadline = Date.now() + 660_000;
      let cancelled = false;
      while (response.state === 'running' && Date.now() < deadline) {
        if (executionSignal.aborted && !cancelled) {
          cancelled = true;
          response = await this.lookup(record, true);
        }
        await delay(100);
        response = await this.lookup(record);
      }
      if (executionUnavailable(response)) {
        await this.commit('hook_execution', id, {
          ...record,
          run: {
            ...record.run,
            state: 'recovery_blocked',
            execution: 'not_started_proven',
            reason: 'handler_unavailable',
          },
        });
        throw new HostedHookRecoveryRequiredError();
      }
      if (response.state !== 'settled' || !response.result) {
        await this.commit('hook_execution', id, {
          ...record,
          run: {
            ...record.run,
            state: 'recovery_blocked',
            execution: 'outcome_unknown',
            reason: 'outcome_unknown',
          },
        });
        throw new HostedHookRecoveryRequiredError();
      }
      return this.settleExecution(record, response.result);
    };
    const result = perform();
    this.pending.set(id, { result, admitted, abort });
    void result.catch(() => undefined).finally(() => this.pending.delete(id));
    if (!hook.async) return result;
    const completed = await Promise.race([admitted.then(() => null), result]);
    return completed ?? this.asyncAdmission();
  }

  private cancelRequested(id: string): boolean {
    const record = this.session.authority.extensionRecord('hook_execution', id);
    return (
      record !== undefined && parseHookExecution(record.record).cancelRequested
    );
  }

  private async executionBroker(
    record: HookExecution,
    reacquire = false,
  ): Promise<HostedWorkspaceBroker> {
    const current = record.runtimeSessionId === this.broker.runtimeSessionId;
    let broker = current
      ? this.broker
      : this.recoveredBrokers.get(record.runtimeSessionId);
    if (!broker) {
      broker = new HostedWorkspaceBroker(
        this.options,
        this.key,
        record.runtimeSessionId,
      );
      this.recoveredBrokers.set(record.runtimeSessionId, broker);
    }
    if (current && !reacquire) await this.acquire();
    else
      await broker.acquire(
        reacquire && record.run.runtime ? record.run.runtime : undefined,
      );
    if (
      !broker.runtime ||
      this.executions().some(
        (execution) =>
          execution.runtimeSessionId === record.runtimeSessionId &&
          execution.run.runtime !== null &&
          (execution.run.runtime.runtimeBindingId !==
            broker!.runtime!.bindingId ||
            execution.run.runtime.generation !== broker!.runtime!.generation),
      )
    )
      throw new HostedHookRecoveryRequiredError();
    if (current) this.acquired = true;
    return broker;
  }

  private async settleExecution(
    record: HookExecution,
    raw: ManagedHookResult,
  ): Promise<ManagedHookResult> {
    const saved = parseHookExecution(
      this.session.authority.extensionRecord(
        'hook_execution',
        record.hookExecutionId,
      )!.record,
    );
    if (saved.resultRef) return this.read<ManagedHookResult>(saved.resultRef);
    const plan = await this.read<HookPlan>(record.planRef);
    const hook = plan.hooks[record.ordinal - 1];
    if (hook?.hookId !== record.hookId)
      throw new Error('Hook execution plan conflict.');
    if (exceedsHookResourceLimit(raw))
      raw = {
        success: false,
        outcome: 'non_blocking_error',
        duration: raw.duration,
        error: 'Managed hook output exceeds the size limit.',
      };
    const result =
      hook.failClosed && raw.outcome !== 'success' && raw.outcome !== 'blocking'
        ? {
            ...raw,
            output: {
              ...raw.output,
              continue: false,
              decision: 'block' as const,
              reason: 'Hook evaluation failed.',
              ...(record.eventName === HookEventName.PermissionRequest
                ? {
                    hookSpecificOutput: {
                      ...raw.output?.hookSpecificOutput,
                      decision: {
                        behavior: 'deny',
                        message: 'Hook evaluation failed.',
                        interrupt: true,
                      },
                    },
                  }
                : {}),
            },
          }
        : raw;
    const resultRef = await this.publish('managed-hook-result', result);
    await this.commit('hook_execution', record.hookExecutionId, (latest) =>
      latest.resultRef
        ? latest
        : {
            ...latest,
            resultRef,
            run: {
              ...latest.run,
              state: result.outcome === 'cancelled' ? 'cancelled' : 'settled',
              execution: 'settled',
              reason: null,
            },
          },
    );
    const committed = parseHookExecution(
      this.session.authority.extensionRecord(
        'hook_execution',
        record.hookExecutionId,
      )!.record,
    );
    return this.read<ManagedHookResult>(committed.resultRef!);
  }

  private asyncAdmission(): ManagedHookResult {
    return { success: true, outcome: 'success', duration: 0 };
  }

  private async lookup(
    record: HookExecution,
    cancel = false,
  ): Promise<ManagedHookOperationView> {
    if (record.run.runtime === null)
      return { operationId: record.hookExecutionId, state: 'outcome_unknown' };
    let broker =
      record.runtimeSessionId === this.broker.runtimeSessionId
        ? this.broker
        : this.recoveredBrokers.get(record.runtimeSessionId);
    if (!broker) {
      broker = new HostedWorkspaceBroker(
        this.options,
        this.key,
        record.runtimeSessionId,
      );
      this.recoveredBrokers.set(record.runtimeSessionId, broker);
    }
    const operation: ManagedHookControl = {
      kind: cancel ? 'hook-cancel' : 'hook-status',
      sessionKey: this.key,
      operationId: record.hookExecutionId,
      targetOperationId: record.hookExecutionId,
    };
    try {
      try {
        return await broker.hookControl(operation);
      } catch (cause) {
        if (
          !(cause instanceof HostedWorkspaceBrokerRejection) ||
          cause.code !== 'runtime_session_not_found'
        )
          throw cause;
        broker = await this.executionBroker(record, true);
        return await broker.hookControl(operation);
      }
    } catch {
      return { operationId: record.hookExecutionId, state: 'outcome_unknown' };
    }
  }

  private executions(): HookExecution[] {
    return this.session.authority
      .extensionRecordsInDomain('hook_execution')
      .map((entry) => savedExecution(entry.record));
  }

  /**
   * The child executions of an occurrence. Records change only by commit,
   * so the grouping is rebuilt only after one, not for every occurrence a
   * drain inspects.
   */
  private childrenOf(occurrenceId: string): HookExecution[] {
    const sequence = this.session.authority.committedSequence;
    if (this.children?.sequence !== sequence) {
      const byOccurrence = new Map<string, HookExecution[]>();
      for (const entry of this.executions()) {
        if (entry.hookId === '__plan__') continue;
        const siblings = byOccurrence.get(entry.occurrenceId);
        if (siblings) siblings.push(entry);
        else byOccurrence.set(entry.occurrenceId, [entry]);
      }
      this.children = { sequence, byOccurrence };
    }
    return this.children.byOccurrence.get(occurrenceId) ?? [];
  }

  async settleOccurrence(occurrenceId: string): Promise<void> {
    const marker = await this.status(occurrenceId);
    if (
      !marker.resultRef ||
      this.childrenOf(occurrenceId).some(
        (child) =>
          child.run.state === 'recovery_blocked' ||
          (!child.resultRef && child.run.execution !== 'not_started_proven'),
      )
    )
      throw new HostedHookRecoveryRequiredError();
  }

  async status(id: string, cancel = false): Promise<HookExecution> {
    const direct = this.session.authority.extensionRecord('hook_execution', id);
    const matches = direct
      ? [parseHookExecution(direct.record)]
      : this.executions().filter(
          (entry) =>
            entry.hookId === '__plan__' &&
            entry.hookExecutionId ===
              hostedHookOccurrenceId(entry.eventName as HookEventName, id),
        );
    if (matches.length !== 1)
      throw new Error('Hook execution does not exist or is ambiguous.');
    let record = matches[0];
    id = record.hookExecutionId;
    const terminal =
      record.resultRef !== null ||
      (record.run.execution === 'not_started_proven' &&
        record.run.state !== 'recovery_blocked');
    if (terminal && record.hookId !== '__plan__') return record;
    if (cancel && !terminal) {
      this.pending.get(id)?.abort.abort();
      if (!record.cancelRequested) {
        await this.commit('hook_execution', id, (latest) =>
          latest.resultRef || latest.run.state === 'cancelled'
            ? latest
            : { ...latest, cancelRequested: true },
        );
        record = parseHookExecution(
          this.session.authority.extensionRecord('hook_execution', id)!.record,
        );
        if (record.resultRef && record.hookId !== '__plan__') return record;
      }
    }
    if (record.hookId === '__plan__') {
      const children = this.childrenOf(id);
      if (cancel || record.cancelRequested) {
        const settled = await Promise.all(
          children.map((child) => this.status(child.hookExecutionId, true)),
        );
        if (
          !terminal &&
          !this.occurrences.has(id) &&
          settled.every(
            (child) =>
              child.resultRef || child.run.execution === 'not_started_proven',
          )
        ) {
          record = {
            ...record,
            resultRef:
              record.run.execution === 'intent'
                ? null
                : await this.publish('managed-hook-result', {
                    output: cancelledResult().output,
                  }),
            run: {
              ...record.run,
              state: 'cancelled',
              execution:
                record.run.execution === 'intent'
                  ? 'not_started_proven'
                  : 'settled',
              reason: null,
            },
          };
          await this.commit('hook_execution', id, record);
        }
      }
      if (!record.cancelRequested && !cancel && !this.occurrences.has(id)) {
        await Promise.all(
          children.map((child) => this.status(child.hookExecutionId)),
        );
        if (!terminal) return this.settleSavedMarker(record);
      }
      return record;
    }
    if (record.run.execution === 'not_started_proven') {
      if (cancel) {
        record = {
          ...record,
          run: { ...record.run, state: 'cancelled', reason: null },
        };
        await this.commit('hook_execution', id, record);
      }
      return record;
    }
    if (record.run.execution === 'intent') {
      if (record.cancelRequested && !this.pending.has(id)) {
        record = {
          ...record,
          run: {
            ...record.run,
            state: 'cancelled',
            execution: 'not_started_proven',
          },
        };
        await this.commit('hook_execution', id, record);
      }
      return record;
    }
    const response = await this.lookup(
      record,
      cancel || record.cancelRequested,
    );
    if (
      response.state === 'settled' &&
      response.result &&
      !this.pending.has(id)
    )
      await this.settleExecution(record, response.result);
    else if (!this.pending.has(id) && response.state !== 'running') {
      const unavailable = executionUnavailable(response);
      await this.commit('hook_execution', id, (latest) =>
        latest.resultRef
          ? latest
          : {
              ...latest,
              run: {
                ...latest.run,
                state: 'recovery_blocked',
                execution: unavailable
                  ? 'not_started_proven'
                  : 'outcome_unknown',
                reason: unavailable ? 'handler_unavailable' : 'outcome_unknown',
              },
            },
      );
    }
    return parseHookExecution(
      this.session.authority.extensionRecord('hook_execution', id)!.record,
    );
  }

  private async settleSavedMarker(
    record: HookExecution,
  ): Promise<HookExecution> {
    const plan = await this.read<HookPlan>(record.planRef);
    const results: HookExecutionResult[] = [];
    const event = record.eventName as HookEventName;
    let effectiveInput = plan.input;
    let inputLimitExceeded = plan.refusedInputDigest !== undefined;
    for (const [index, hook] of plan.hooks.entries()) {
      if (plan.sequential && exceedsHookResourceLimit(effectiveInput)) {
        inputLimitExceeded = true;
        break;
      }
      const id = `hook-${digest([record.occurrenceId, index + 1])}`;
      const saved = this.session.authority.extensionRecord(
        'hook_execution',
        id,
      );
      if (!saved) return record;
      const child = parseHookExecution(saved.record);
      if (
        !child.resultRef &&
        !(
          child.run.state === 'cancelled' &&
          child.run.execution === 'not_started_proven'
        )
      )
        return record;
      const result = child.resultRef
        ? await this.read<ManagedHookResult>(child.resultRef)
        : cancelledResult();
      results.push({
        ...result,
        hookConfig: hook.config as HookConfig,
        eventName: record.eventName as HookEventName,
        ...(result.error ? { error: new Error(result.error) } : {}),
      } as HookExecutionResult);
      if (plan.sequential)
        effectiveInput = sequentialInput(effectiveInput, result, event);
    }
    if (record.run.execution === 'intent') {
      await this.commit('hook_execution', record.hookExecutionId, (latest) =>
        latest.run.execution === 'intent'
          ? {
              ...latest,
              run: {
                ...latest.run,
                state: 'running',
                execution: 'dispatch_started',
              },
            }
          : latest,
      );
    }
    const output = inputLimitExceeded
      ? byteLimitOutput(event)
      : this.aggregateOutput(results, event);
    const resultRef = await this.publish('managed-hook-result', {
      ...(output ? { output } : {}),
    });
    await this.commit('hook_execution', record.hookExecutionId, (latest) =>
      latest.resultRef || latest.run.execution === 'not_started_proven'
        ? latest
        : {
            ...latest,
            resultRef,
            run: {
              ...latest.run,
              state: 'settled',
              execution: 'settled',
              reason: null,
            },
          },
    );
    return parseHookExecution(
      this.session.authority.extensionRecord(
        'hook_execution',
        record.hookExecutionId,
      )!.record,
    );
  }

  private aggregateOutput(
    results: HookExecutionResult[],
    event: HookEventName,
  ): HookOutput | undefined {
    const output = this.aggregator.aggregateResults(results, event).finalOutput;
    return exceedsHookResourceLimit({ output })
      ? byteLimitOutput(event)
      : output;
  }

  async drain(
    excludedOccurrences: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    const prior = () =>
      this.executions().filter(
        (record) =>
          !excludedOccurrences.has(record.hookExecutionId) &&
          !excludedOccurrences.has(record.occurrenceId),
      );
    for (const record of prior()) {
      if (!record.resultRef) await this.status(record.hookExecutionId, true);
    }
    await Promise.allSettled(
      [...this.pending.values()].map((pending) => pending.result),
    );
    await Promise.allSettled(
      [...this.occurrences.values()].map((occurrence) => occurrence.result),
    );
    for (const record of prior()) {
      const latest = await this.status(record.hookExecutionId, true);
      if (!latest.resultRef && latest.run.execution !== 'not_started_proven')
        throw new HostedHookRecoveryRequiredError();
    }
  }

  async close(): Promise<void> {
    await this.drain();
    await this.releaseEarlierOwners();
    for (const broker of this.recoveredBrokers.values()) await broker.release();
    this.recoveredBrokers.clear();
    if (this.ownsBroker && this.broker.runtime) {
      await this.broker.release();
      this.acquired = false;
    }
  }

  private definition(pin: ManagedHookCatalogPin) {
    return {
      definitionId: pin.catalogId,
      definitionRevision: pin.catalogRevision,
      definitionDigest: pin.definitionDigest,
    };
  }
  private run(id: string, pin: ManagedHookCatalogPin): ExtensionRun {
    return {
      state: 'admitted',
      execution: 'intent',
      effectId: id,
      executionCallId: null,
      dispatchId: null,
      deliveryId: null,
      delivery: null,
      definition: this.definition(pin),
      reason: null,
      runtime: null,
    };
  }
  private publish(kind: string, value: unknown) {
    return this.session.resources.publish(
      kind,
      Buffer.from(JSON.stringify(value)),
    );
  }
  private async publishMessages(
    bytes: Buffer,
  ): Promise<ManagedSessionDurableRef> {
    if (bytes.length <= 60 * 1024)
      return this.session.resources.publish('managed-hook-messages', bytes);
    const parts: ManagedSessionDurableRef[] = [];
    for (let offset = 0; offset < bytes.length; offset += 60 * 1024)
      parts.push(
        await this.session.resources.publish(
          'managed-hook-message-part',
          bytes.subarray(offset, offset + 60 * 1024),
        ),
      );
    return this.publish('managed-hook-message-chunks', { parts });
  }
  private async readMessages(ref: ManagedSessionDurableRef): Promise<unknown> {
    if (ref.kind !== 'managed-hook-message-chunks') return this.read(ref);
    const { parts } = await this.read<{ parts: ManagedSessionDurableRef[] }>(
      ref,
    );
    const buffers = [];
    for (const part of parts)
      buffers.push(await this.session.resources.read(part));
    return JSON.parse(Buffer.concat(buffers).toString('utf8')) as unknown;
  }
  private async read<T>(ref: ManagedSessionDurableRef): Promise<T> {
    return JSON.parse(
      (await this.session.resources.read(ref)).toString('utf8'),
    ) as T;
  }
  private commit(
    domain: 'hook_registration' | 'hook_execution',
    id: string,
    record:
      | HookRegistration
      | HookExecution
      | ((previous: HookExecution) => HookExecution),
  ): Promise<void> {
    const write = this.writes.then(async () => {
      const previous = this.session.authority.extensionRecord(domain, id);
      let next =
        typeof record === 'function'
          ? record(parseHookExecution(previous!.record))
          : record;
      if (
        domain === 'hook_execution' &&
        previous &&
        parseHookExecution(previous.record).cancelRequested &&
        'cancelRequested' in next
      )
        next = { ...next, cancelRequested: true };
      if (previous && isDeepStrictEqual(previous.record, next)) return;
      await this.session.authority.commitExtensionRecord(
        {
          operation: 'commitHookRecord',
          commandId: previous ? `${id}:${previous.revision + 1}` : id,
          sessionKey: this.key,
          contentDigest: digest(next),
        },
        { domain, record: next },
        { class: 'trusted_entry' },
      );
    });
    this.writes = write.catch(() => undefined);
    return write;
  }
}
