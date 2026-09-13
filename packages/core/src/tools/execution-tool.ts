/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { ApprovalMode, type Config } from '../config/config.js';
import type { PermissionDecision } from '../permissions/types.js';
import type {
  ExecutionEnvironment,
  ExecutionModification,
  PreparedExecution,
} from '../services/execution-environment.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { ToolNames } from './tool-names.js';
import {
  isModifiableDeclarativeTool,
  type ModifyContext,
} from './modifiable-tool.js';
import {
  BaseToolInvocation,
  DeclarativeTool,
  ToolConfirmationOutcome,
  type AnyDeclarativeTool,
  type ToolCallConfirmationDetails,
  type ToolInvocation,
  type ToolLocation,
  type ToolResult,
  type ToolResultDisplay,
} from './tools.js';

const cacheGenerations = new WeakMap<
  ExecutionEnvironment,
  { generation: number; pending: Promise<void> }
>();

interface PendingModification extends ExecutionModification {
  originalParams: Record<string, unknown>;
}

async function synchronizeReadCache(
  environment: ExecutionEnvironment,
  config: Config,
): Promise<void> {
  let state = cacheGenerations.get(environment);
  if (!state) {
    state = {
      generation: config.getFileReadCache().getClearGeneration(),
      pending: Promise.resolve(),
    };
    cacheGenerations.set(environment, state);
  }
  const generation = config.getFileReadCache().getClearGeneration();
  const current = state;
  current.pending = current.pending
    .catch(() => undefined)
    .then(async () => {
      if (current.generation !== generation) {
        await environment.invalidateReadCache();
        current.generation = generation;
      }
    });
  await current.pending;
}

class ExecutionToolInvocation extends BaseToolInvocation<object, ToolResult> {
  private readonly id = randomUUID();
  private prepared?: Promise<PreparedExecution>;
  private details?: PreparedExecution;
  private callId?: string;
  private released?: Promise<void>;
  private readonly preparationAbort = new AbortController();
  private modification?: PendingModification;
  private readonly abortListeners = new Map<AbortSignal, () => void>();

  constructor(
    private readonly owner: ExecutionTool,
    params: object,
  ) {
    super(params);
  }

  setCallId(callId: string): void {
    this.callId = callId;
    this.modification = this.owner.replaceInvocation(callId, this);
  }

  release(): Promise<void> {
    return (this.released ??= this.releaseOnce());
  }

  private async releaseOnce(): Promise<void> {
    this.preparationAbort.abort();
    for (const [signal, listener] of this.abortListeners)
      signal.removeEventListener('abort', listener);
    this.abortListeners.clear();
    try {
      if (this.prepared) {
        await this.prepared.catch(() => undefined);
        await this.owner.environment.release(
          this.id,
          new AbortController().signal,
        );
      }
    } finally {
      this.owner.finishInvocation(this.callId, this);
    }
  }

  getDescription(): string {
    return this.details?.description ?? this.owner.displayName;
  }

  override toolLocations(): ToolLocation[] {
    return this.details?.locations ?? [];
  }

  private async prepare(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.preparationAbort.signal.throwIfAborted();
    await synchronizeReadCache(this.owner.environment, this.owner.config);
    signal.throwIfAborted();
    this.preparationAbort.signal.throwIfAborted();
    if (!this.abortListeners.has(signal)) {
      const listener = () => {
        void this.release().catch(() => undefined);
      };
      this.abortListeners.set(signal, listener);
      signal.addEventListener('abort', listener, { once: true });
    }
    this.prepared ??= this.owner.environment.prepare(
      {
        id: this.id,
        toolName: this.owner.name,
        params:
          this.modification?.originalParams ??
          (this.params as Record<string, unknown>),
        ...(this.modification
          ? {
              modification: {
                oldContent: this.modification.oldContent,
                newContent: this.modification.newContent,
              },
            }
          : {}),
      },
      AbortSignal.any([signal, this.preparationAbort.signal]),
    );
    this.details = await this.prepared;
    Object.assign(this.params, this.details.params);
  }

  override async getDefaultPermission(
    signal = new AbortController().signal,
  ): Promise<PermissionDecision> {
    try {
      await this.prepare(signal);
      const permission = await this.owner.environment.permission(
        this.id,
        AbortSignal.any([signal, this.preparationAbort.signal]),
      );
      if (permission === 'deny') await this.release();
      return permission;
    } catch (error) {
      await this.release().catch(() => undefined);
      throw error;
    }
  }

  override async getConfirmationDetails(
    signal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    let details;
    try {
      await this.prepare(signal);
      details = await this.owner.environment.confirmation(this.id, signal);
    } catch (error) {
      await this.release().catch(() => undefined);
      throw error;
    }
    return {
      ...details,
      onConfirm: async (outcome, payload) => {
        const current = this.owner.currentInvocation(this.callId);
        if (current && current !== this) {
          const confirmation = await current.getConfirmationDetails(signal);
          await confirmation.onConfirm(outcome, payload);
          return;
        }
        if (outcome === ToolConfirmationOutcome.Cancel) {
          await this.release().catch(() => undefined);
          return;
        }
        await this.owner.environment.confirm(this.id, outcome, payload, signal);
        if (
          outcome === ToolConfirmationOutcome.ProceedAlways &&
          details.type === 'edit'
        ) {
          this.owner.config.setApprovalMode(ApprovalMode.AUTO_EDIT);
        }
      },
    };
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: ToolResultDisplay) => void,
  ): Promise<ToolResult> {
    try {
      await this.prepare(signal);
      const result = await this.owner.environment.execute(
        this.id,
        signal,
        updateOutput,
      );
      // Worker paths belong to its filesystem, never to host artifact storage.
      return {
        llmContent: result.llmContent,
        returnDisplay: result.returnDisplay,
        ...(result.error ? { error: result.error } : {}),
        persistedOutputFiles: [],
        resultFilePaths: [],
      };
    } finally {
      await this.release().catch(() => undefined);
    }
  }
}

class ExecutionTool extends DeclarativeTool<object, ToolResult> {
  private readonly modifications = new Map<string, PendingModification>();
  private readonly invocations = new Map<string, ExecutionToolInvocation>();

  constructor(
    private readonly original: AnyDeclarativeTool,
    readonly environment: ExecutionEnvironment,
    readonly config: Config,
  ) {
    super(
      original.name,
      original.displayName,
      original.description,
      original.kind,
      original.parameterSchema,
      original.isOutputMarkdown,
      original.canUpdateOutput,
      original.shouldDefer,
      original.alwaysLoad,
      original.searchHint,
    );
    if (isModifiableDeclarativeTool(original)) {
      Object.defineProperty(this, 'getModifyContext', {
        value: (
          signal: AbortSignal,
          callId?: string,
        ): ModifyContext<object> => {
          if (!callId || !this.invocations.has(callId))
            throw new Error('Container edits require an active tool call.');
          const originalContext = original.getModifyContext(signal);
          const snapshots = new Map<
            string,
            Promise<{ current: string; proposed: string }>
          >();
          const content = (params: object) => {
            const key = JSON.stringify(params);
            let snapshot = snapshots.get(key);
            if (!snapshot) {
              snapshot = environment.modificationContent(
                original.name,
                params as Record<string, unknown>,
                signal,
              );
              snapshots.set(key, snapshot);
            }
            return snapshot;
          };
          return {
            getFilePath: originalContext.getFilePath,
            getCurrentContent: async (params) =>
              (await content(params)).current,
            getProposedContent: async (params) =>
              (await content(params)).proposed,
            createUpdatedParams: (oldContent, newContent, params) => {
              signal.throwIfAborted();
              if (!this.invocations.has(callId))
                throw new Error('The tool call is no longer active.');
              const updated =
                original.name === ToolNames.NOTEBOOK_EDIT
                  ? { ...params }
                  : originalContext.createUpdatedParams(
                      oldContent,
                      newContent,
                      params,
                    );
              this.modifications.set(callId, {
                oldContent,
                newContent,
                originalParams: structuredClone(params) as Record<
                  string,
                  unknown
                >,
              });
              return updated;
            },
          };
        },
      });
    }
  }

  override get schema() {
    return this.original.schema;
  }
  override get maxOutputChars() {
    return this.original.maxOutputChars;
  }
  override get truncateKeep() {
    return this.original.truncateKeep;
  }
  override toAutoClassifierInput(params: object) {
    return this.original.toAutoClassifierInput(params);
  }

  replaceInvocation(
    callId: string,
    invocation: ExecutionToolInvocation,
  ): PendingModification | undefined {
    const modification = this.modifications.get(callId);
    this.modifications.delete(callId);
    const previous = this.invocations.get(callId);
    this.invocations.set(callId, invocation);
    if (previous && previous !== invocation)
      void previous.release().catch(() => undefined);
    return modification;
  }

  currentInvocation(callId?: string): ExecutionToolInvocation | undefined {
    return callId ? this.invocations.get(callId) : undefined;
  }

  finishInvocation(
    callId: string | undefined,
    invocation: ExecutionToolInvocation,
  ): void {
    if (callId && this.invocations.get(callId) === invocation) {
      this.invocations.delete(callId);
      this.modifications.delete(callId);
    }
  }

  override validateToolParams(params: object): string | null {
    return SchemaValidator.validate(this.schema.parametersJsonSchema, params);
  }

  build(params: object): ToolInvocation<object, ToolResult> {
    const error = this.validateToolParams(params);
    if (error) throw new Error(error);
    return new ExecutionToolInvocation(this, params);
  }
}

export function wrapExecutionTool(
  original: AnyDeclarativeTool,
  environment: ExecutionEnvironment,
  config: Config,
): AnyDeclarativeTool {
  return new ExecutionTool(original, environment, config);
}
