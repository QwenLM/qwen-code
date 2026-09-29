/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { setTimeout as delay } from 'node:timers/promises';
import type { PreToolUseHookResult } from '../core/toolHookTriggers.js';
import {
  managedToolDigest,
  parseManagedToolContentModification,
  parseManagedToolMediaContext,
  type ManagedToolMediaContext,
  type ManagedToolContentModification,
  parseManagedToolInvocationReference,
  type ManagedToolDescriptor,
  type ManagedToolPrepareResponse,
  type ManagedToolInvocationReference,
  type ManagedToolCallIdentity,
} from './managed-tool-protocol.js';
import type {
  ManagedToolExecutionReservation,
  ManagedToolV2Client,
  ManagedToolExecutionResult,
  ManagedToolInvocationStatus,
} from './managed-tool-runtime.js';
import {
  DeclarativeTool,
  type ManagedToolInvocationLifecycle,
  type ToolCallConfirmationDetails,
  ToolConfirmationOutcome,
  type ToolConfirmationPayload,
  type ToolInvocation,
  type ToolResult,
  type ToolResultDisplay,
} from './tools.js';
import { ToolErrorType } from './tool-error.js';

export interface RuntimeBackedToolOptions {
  descriptor: ManagedToolDescriptor;
  sessionId: string;
  getClient: () => Promise<ManagedToolV2Client>;
  getMediaContext?: () => ManagedToolMediaContext;
  projectClassifierInput: (
    params: Record<string, unknown>,
  ) => Record<string, unknown> | string | undefined;
  onConfirm?: (
    outcome: ToolConfirmationOutcome,
    details: ToolCallConfirmationDetails,
  ) => void;
}

export class RuntimeBackedTool extends DeclarativeTool<
  Record<string, unknown>,
  ToolResult
> {
  private readonly options: RuntimeBackedToolOptions;

  constructor(options: RuntimeBackedToolOptions) {
    const descriptor = structuredClone(options.descriptor);
    super(
      descriptor.name,
      descriptor.displayName,
      descriptor.description,
      descriptor.kind,
      descriptor.schema.parametersJsonSchema ?? descriptor.schema.parameters,
      descriptor.isOutputMarkdown ?? true,
      descriptor.canUpdateOutput,
      descriptor.shouldDefer ?? false,
      descriptor.alwaysLoad ?? false,
      descriptor.searchHint,
    );
    this.options = { ...options, descriptor };
  }

  override get schema() {
    return structuredClone(this.options.descriptor.schema);
  }

  override get maxOutputChars() {
    const limit = this.options.descriptor.maxOutputChars;
    return limit === 'unlimited' ? Infinity : limit;
  }

  override get truncateKeep() {
    return this.options.descriptor.truncateKeep ?? 'both';
  }

  override toAutoClassifierInput(params: Record<string, unknown>) {
    return this.options.projectClassifierInput(params);
  }

  build(params: Record<string, unknown>) {
    managedToolDigest(params);
    return new RuntimeBackedInvocation(this.options, structuredClone(params));
  }
}

class RuntimeBackedInvocation
  implements
    ToolInvocation<Record<string, unknown>, ToolResult>,
    ManagedToolInvocationLifecycle
{
  readonly managed = this;
  private readonly input: Record<string, unknown>;
  private prepared?: ManagedToolPrepareResponse;
  private reference?: ManagedToolInvocationReference;
  private client?: ManagedToolV2Client;
  private preparation?: Promise<void>;
  private recoverTurn?: () => Promise<void>;
  private recoverPreparation?: () => Promise<ManagedToolPrepareResponse>;
  private identity?: ManagedToolCallIdentity;
  private context?: { callId: string; promptId: string };
  private signal?: AbortSignal;
  private authorized = false;
  private executionReservation?: Promise<ManagedToolExecutionReservation>;
  private cancelled = false;
  private cancellation?: Promise<void>;
  private execution?: Promise<ToolResult>;
  private executionResult?: ManagedToolExecutionResult;
  private preflightResult?: PreToolUseHookResult;
  private preflightConfirmed = false;
  private confirmationDetails?: ToolCallConfirmationDetails;
  private removeAbortListener?: () => void;

  constructor(
    private readonly options: RuntimeBackedToolOptions,
    params: Record<string, unknown>,
  ) {
    this.input = params;
  }

  get params() {
    return structuredClone(this.ready().params);
  }

  get permissionAliases() {
    return this.options.descriptor.permissionAliases;
  }

  get toolUseId() {
    return this.ready().toolUseId;
  }

  get result() {
    return this.executionResult === undefined
      ? undefined
      : structuredClone(this.executionResult);
  }

  getDescription() {
    return this.ready().description;
  }

  toolLocations() {
    return structuredClone(this.ready().locations);
  }

  async getDefaultPermission() {
    return this.ready().defaultPermission;
  }

  requiresUserInteraction() {
    return this.ready().requiresUserInteraction;
  }

  contentModification(newContent: string): ManagedToolContentModification {
    this.ready();
    this.checkAdmission();
    if (this.confirmationDetails?.type !== 'edit')
      throw new Error('Managed tool has no editable confirmation.');
    return parseManagedToolContentModification({
      source: this.reference,
      newContent,
    });
  }

  prepare(
    signal: AbortSignal,
    context: { callId: string; promptId: string },
    modification?: ManagedToolContentModification,
  ) {
    if (
      this.context &&
      managedToolDigest(context) !== managedToolDigest(this.context)
    ) {
      return Promise.reject(
        new Error('Managed invocation cannot change tool call identity.'),
      );
    }
    if (this.preparation) return this.preparation;
    const contentModification =
      modification === undefined
        ? undefined
        : parseManagedToolContentModification(modification);
    const callContext = { ...context };
    this.context = callContext;
    this.signal = signal;
    const onAbort = () => {
      // The scheduler also awaits this promise before releasing its batch.
      void this.cancelAndDrain().catch(() => {});
    };
    signal.addEventListener('abort', onAbort, { once: true });
    this.removeAbortListener = () =>
      signal.removeEventListener('abort', onAbort);
    this.preparation = (async () => {
      this.checkAdmission();
      const mediaContext = this.options.getMediaContext
        ? parseManagedToolMediaContext(this.options.getMediaContext())
        : undefined;
      const client = await this.options.getClient();
      this.client = client;
      this.checkAdmission();
      const manifest = await client.manifest();
      const descriptor = manifest.tools.find(
        (tool) => tool.name === this.options.descriptor.name,
      );
      if (
        !descriptor ||
        managedToolDigest(descriptor) !==
          managedToolDigest(this.options.descriptor)
      ) {
        throw new Error('Managed tool declaration changed before preparation.');
      }
      this.checkAdmission();
      const identity = {
        ...callContext,
        sessionId: this.options.sessionId,
        capabilityDigest: manifest.capabilityDigest,
        policyRevision: manifest.policyRevision,
      };
      this.recoverTurn = () => client.beginTurn(identity);
      await this.recoverTurn();
      this.recoverTurn = undefined;
      this.checkAdmission();
      this.identity = identity;
      this.recoverPreparation = () =>
        mediaContext !== undefined
          ? client.prepare(
              identity,
              descriptor.name,
              this.input,
              contentModification,
              mediaContext,
            )
          : contentModification === undefined
            ? client.prepare(identity, descriptor.name, this.input)
            : client.prepare(
                identity,
                descriptor.name,
                this.input,
                contentModification,
              );
      const prepared = await this.recoverPreparation();
      // Retain the reference before checking cancellation, so a late response
      // remains owned and is drained even when its caller has already aborted.
      const reference = parseManagedToolInvocationReference({
        ...identity,
        invocationId: prepared.invocationId,
        argsDigest: prepared.argsDigest,
      });
      this.reference = reference;
      this.recoverPreparation = undefined;
      for (const key of Object.keys(identity) as Array<keyof typeof identity>) {
        if (prepared[key] !== identity[key])
          throw new Error('Managed preparation identity does not match.');
      }
      if (
        managedToolDigest(prepared.params) !== reference.argsDigest ||
        !prepared.toolUseId
      ) {
        throw new Error(
          'Managed preparation parameters or tool identity do not match.',
        );
      }
      this.prepared = structuredClone(prepared);
      this.checkAdmission();
    })();
    return this.preparation;
  }

  private ready() {
    if (!this.prepared)
      throw new Error('Managed tool invocation has not been prepared.');
    return this.prepared;
  }

  private checkAdmission() {
    this.signal?.throwIfAborted();
    if (this.cancelled)
      throw new Error('Managed tool invocation was cancelled.');
  }

  async getConfirmationDetails(
    signal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    this.ready();
    this.checkAdmission();
    signal.throwIfAborted();
    const dto = await this.client!.confirmation(this.reference!);
    this.checkAdmission();
    signal.throwIfAborted();
    const details: ToolCallConfirmationDetails = {
      ...dto,
      onConfirm: async (outcome, payload) => {
        this.checkAdmission();
        await this.client!.confirm(this.reference!, outcome, payload);
        this.options.onConfirm?.(outcome, details);
      },
    };
    this.confirmationDetails = details;
    return details;
  }

  async preflight() {
    this.ready();
    this.checkAdmission();
    this.preflightResult = await this.client!.preflight(this.reference!);
    this.checkAdmission();
    return structuredClone(this.preflightResult);
  }

  async confirmPreflight(
    outcome: ToolConfirmationOutcome,
    payload?: ToolConfirmationPayload,
  ) {
    this.ready();
    this.checkAdmission();
    const details =
      this.confirmationDetails ??
      (await this.getConfirmationDetails(this.signal!));
    await this.client!.confirm(this.reference!, outcome, payload, 'preflight');
    this.checkAdmission();
    this.preflightConfirmed = outcome !== ToolConfirmationOutcome.Cancel;
    this.options.onConfirm?.(outcome, details);
  }

  authorize() {
    this.ready();
    this.checkAdmission();
    if (
      !this.preflightResult ||
      (!this.preflightResult.shouldProceed &&
        !(this.preflightResult.blockType === 'ask' && this.preflightConfirmed))
    ) {
      throw new Error('Managed tool preflight has not permitted execution.');
    }
    this.authorized = true;
  }

  prepareExecution(): Promise<ManagedToolExecutionReservation> {
    this.ready();
    this.checkAdmission();
    if (!this.authorized) {
      return Promise.reject(
        new Error(
          'Managed tool invocation has not been authorized by its scheduler.',
        ),
      );
    }
    const prepareExecution = this.client!.prepareExecution;
    if (
      (prepareExecution === undefined) !==
      (this.client!.startExecution === undefined)
    ) {
      return Promise.reject(
        new Error('Managed tool execution reservation contract is incomplete.'),
      );
    }
    this.executionReservation ??= (
      prepareExecution
        ? prepareExecution(this.reference!)
        : Promise.resolve({
            executionCallId: this.toolUseId,
            invocationBindingId: this.toolUseId,
          })
    ).then((reservation) => {
      if (
        ![reservation.executionCallId, reservation.invocationBindingId].every(
          (value) =>
            typeof value === 'string' &&
            value.length > 0 &&
            value.length <= 512 &&
            !value.includes('\0'),
        )
      ) {
        throw new Error('Managed tool execution reservation is invalid.');
      }
      return structuredClone(reservation);
    });
    return this.executionReservation.then((reservation) =>
      structuredClone(reservation),
    );
  }

  execute(
    signal: AbortSignal,
    updateOutput?: (output: ToolResultDisplay) => void,
  ): Promise<ToolResult> {
    if (this.execution) return this.execution;
    this.ready();
    this.checkAdmission();
    signal.throwIfAborted();
    if (!this.authorized)
      throw new Error(
        'Managed tool invocation has not been authorized by its scheduler.',
      );
    const onAbort = () => {
      void this.cancelAndDrain().catch(() => {});
    };
    signal.addEventListener('abort', onAbort, { once: true });
    this.execution = (async () => {
      const reservation = await this.prepareExecution();
      let rpcEnded = false;
      let rpcError: unknown;
      // Send execute exactly once. A lost response is recovered with status.
      const remoteExecution = this.client!.startExecution
        ? this.client!.startExecution(
            this.reference!,
            reservation.executionCallId,
          )
        : this.client!.execute(this.reference!);
      void remoteExecution.then(
        (result) => {
          this.acceptResult(result);
          rpcEnded = true;
        },
        (error: unknown) => {
          rpcError = error;
          rpcEnded = true;
        },
      );
      let cursor = 0;
      while (!this.executionResult) {
        try {
          const status = await this.client!.status(this.reference!, cursor);
          for (const event of status.progress) {
            if (event.seq > cursor) updateOutput?.(event.output);
            cursor = Math.max(cursor, event.seq);
          }
          this.acceptStatus(status);
          if (rpcEnded && rpcError && status.state === 'prepared') {
            await this.cancelAndDrain();
          }
        } catch (error) {
          if (rpcEnded && !this.executionResult) {
            throw new AggregateError(
              [rpcError, error],
              'Managed tool execution outcome is unknown.',
            );
          }
        }
        if (!this.executionResult) await delay(50);
      }
      const result = this.executionResult;
      const error =
        result.error ??
        result.result?.error ??
        (result.executionStatus === 'not_started' ||
        result.executionStatus === 'error'
          ? {
              message:
                result.executionStatus === 'not_started'
                  ? 'Managed tool did not execute.'
                  : 'Managed tool execution failed.',
              type:
                result.executionStatus === 'not_started'
                  ? ToolErrorType.EXECUTION_DENIED
                  : ToolErrorType.EXECUTION_FAILED,
            }
          : undefined);
      return {
        ...(result.result ?? {
          llmContent: result.error?.message ?? 'Managed tool did not execute.',
          returnDisplay:
            result.error?.message ?? 'Managed tool did not execute.',
        }),
        executionStatus: result.executionStatus,
        ...(error
          ? {
              error: {
                message: error.message,
                type: error.type ?? ToolErrorType.EXECUTION_FAILED,
              },
            }
          : {}),
      };
    })().finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
    return this.execution;
  }

  private acceptResult(result: ManagedToolExecutionResult) {
    this.executionResult ??= structuredClone(result);
    this.removeAbortListener?.();
  }

  private acceptStatus(status: ManagedToolInvocationStatus) {
    if (status.state === 'settled') {
      if (!status.result)
        throw new Error('Managed settled status has no execution result.');
      this.acceptResult(status.result);
    }
  }

  cancelAndDrain(): Promise<void> {
    this.cancelled = true;
    this.authorized = false;
    this.cancellation ??= (async () => {
      await this.preparation?.catch(() => {});
      if (this.recoverTurn) {
        await this.recoverTurn();
        this.recoverTurn = undefined;
      }
      if (!this.reference && this.recoverPreparation) {
        const prepared = await this.recoverPreparation();
        this.reference = parseManagedToolInvocationReference({
          ...this.identity,
          invocationId: prepared.invocationId,
          argsDigest: prepared.argsDigest,
        });
        this.recoverPreparation = undefined;
      }
      if (!this.reference || this.executionResult) {
        this.removeAbortListener?.();
        return;
      }
      this.acceptStatus(await this.client!.cancel(this.reference));
      while (!this.executionResult) {
        this.acceptStatus(await this.client!.status(this.reference));
        if (!this.executionResult) await delay(50);
      }
    })();
    return this.cancellation;
  }
}
