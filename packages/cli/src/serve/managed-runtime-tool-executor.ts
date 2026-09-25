/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { ApprovalMode } from '@qwen-code/qwen-code-core/config/approval-mode.js';
import { ReadFileTool } from '@qwen-code/qwen-code-core/tools/read-file.js';
import { WriteFileTool } from '@qwen-code/qwen-code-core/tools/write-file.js';
import { EditTool } from '@qwen-code/qwen-code-core/tools/edit.js';
import { ShellTool } from '@qwen-code/qwen-code-core/tools/shell.js';
import type {
  AnyDeclarativeTool,
  ToolResult,
} from '@qwen-code/qwen-code-core/tools/tools.js';
import { MANAGED_RUNTIME_TOOL_RESULT_BODY_LIMIT_BYTES } from './managed-runtime-attestation-contract.js';

export interface ManagedToolReference {
  readonly sessionId: string;
  readonly promptId: string;
  readonly callId: string;
  readonly argsDigest: string;
}

export type ManagedToolExecutionState =
  | 'prepared'
  | 'executing'
  | 'cancel_requested'
  | 'settled';

export interface ManagedToolResultPayload {
  readonly executionStatus: 'not_started' | 'success' | 'error' | 'cancelled';
  readonly responseParts: unknown[];
  readonly error?: { readonly message: string; readonly type?: string };
}

export interface ManagedToolInvocationView {
  readonly state: ManagedToolExecutionState;
  readonly lastSequence: number;
  readonly result?: ManagedToolResultPayload;
}

/** The reference identifies a different call than the recorded invocation. */
export class ManagedToolConflictError extends Error {
  readonly code = 'managed_runtime_identity_conflict';
}

export class ManagedToolInvalidError extends Error {}

interface JournalEntry {
  readonly reference: ManagedToolReference;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly inputJson: string;
  state: ManagedToolExecutionState;
  lastSequence: number;
  result?: ManagedToolResultPayload;
  readonly controller: AbortController;
  promise?: Promise<void>;
}

/**
 * Executes the admitted ordinary tools for one Managed Runtime worker and
 * journals every invocation so `status` and `cancel` can answer by the
 * original reference. The journal is in-memory by construction: the worker
 * process is the Runtime generation, so a restart is a new generation, never
 * a continuation of this state.
 */
export class ManagedToolExecutor {
  private readonly entries = new Map<string, JournalEntry>();
  private readonly tools = new Map<string, AnyDeclarativeTool>();

  constructor(config: Config) {
    const admitted: AnyDeclarativeTool[] = [
      new ReadFileTool(config),
      new WriteFileTool(config),
      new EditTool(config),
      new ShellTool(config),
    ];
    for (const tool of admitted) {
      this.tools.set(tool.name, tool);
    }
  }

  static forWorkspace(workspaceCwd: string, runtimeInstanceId: string) {
    return new ManagedToolExecutor(
      new Config({
        sessionId: runtimeInstanceId,
        targetDir: workspaceCwd,
        cwd: workspaceCwd,
        model: 'managed-runtime-worker',
        debugMode: false,
        usageStatisticsEnabled: false,
        approvalMode: ApprovalMode.YOLO,
        fileCheckpointingEnabled: false,
        // The worker has no conversation history to justify cached read elision.
        fileReadCacheDisabled: true,
      }),
    );
  }

  hasTool(toolName: string): boolean {
    return this.tools.has(toolName);
  }

  async execute(
    reference: ManagedToolReference,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<ManagedToolResultPayload> {
    let inputJson: string;
    try {
      inputJson = JSON.stringify(input);
    } catch {
      throw new ManagedToolInvalidError(
        'Managed Runtime tool request is invalid.',
      );
    }
    const existing = this.entries.get(reference.callId);
    if (existing) {
      if (!sameInvocation(existing, reference, toolName, inputJson)) {
        throw new ManagedToolConflictError(
          'Managed Runtime invocation identity conflicts.',
        );
      }
      await existing.promise;
      return existing.result!;
    }
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new ManagedToolConflictError(
        `Managed Runtime does not admit tool ${toolName}.`,
      );
    }
    if (toolName === ShellTool.Name) {
      let isBackground = false;
      try {
        const params = structuredClone(input);
        // Admission must see the same normalized parameters as build().
        isBackground =
          tool.validateToolParams(params) === null &&
          params['is_background'] === true;
      } catch {
        // Let run() journal parameter failures through its normal error path.
      }
      if (isBackground) {
        throw new ManagedToolConflictError(
          'Managed Runtime does not admit background shell execution.',
        );
      }
    }
    const entry: JournalEntry = {
      reference,
      toolName,
      input,
      inputJson,
      state: 'prepared',
      lastSequence: 0,
      controller: new AbortController(),
    };
    this.entries.set(reference.callId, entry);
    entry.promise = this.run(entry, tool);
    await entry.promise;
    return entry.result!;
  }

  /** Read-only lookup; never creates or advances an invocation. */
  status(reference: ManagedToolReference): ManagedToolInvocationView | null {
    const entry = this.entries.get(reference.callId);
    if (!entry || !sameReference(entry.reference, reference)) {
      return null;
    }
    return view(entry);
  }

  cancel(reference: ManagedToolReference): ManagedToolInvocationView | null {
    const entry = this.entries.get(reference.callId);
    if (!entry || !sameReference(entry.reference, reference)) {
      return null;
    }
    if (entry.state === 'prepared') {
      // Never started; settle as cancelled without touching the tool.
      entry.result = {
        executionStatus: 'cancelled',
        responseParts: [],
      };
      entry.state = 'settled';
      entry.lastSequence += 1;
      return view(entry);
    }
    if (entry.state === 'executing') {
      entry.state = 'cancel_requested';
      entry.lastSequence += 1;
      entry.controller.abort();
    }
    return view(entry);
  }

  async close(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.state === 'executing' || entry.state === 'cancel_requested') {
        entry.controller.abort();
      }
    }
  }

  private static isCancelRequested(entry: JournalEntry): boolean {
    // Read across a method boundary: cancel() can move the entry to
    // cancel_requested while this invocation is parked in the tool.
    return entry.state === 'cancel_requested';
  }

  private async run(
    entry: JournalEntry,
    tool: AnyDeclarativeTool,
  ): Promise<void> {
    entry.state = 'executing';
    entry.lastSequence += 1;
    let payload: ManagedToolResultPayload;
    try {
      const invocation = tool.build(structuredClone(entry.input));
      const result: ToolResult = await invocation.execute(
        entry.controller.signal,
      );
      payload = toPayload(result, ManagedToolExecutor.isCancelRequested(entry));
    } catch (error) {
      payload = {
        executionStatus: ManagedToolExecutor.isCancelRequested(entry)
          ? 'cancelled'
          : 'error',
        responseParts: [],
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    entry.result = payload;
    entry.state = 'settled';
    entry.lastSequence += 1;
    // Status is the largest envelope because it also carries the sequence.
    if (
      Buffer.byteLength(
        JSON.stringify({ protocolVersion: 2, ...view(entry) }),
      ) > MANAGED_RUNTIME_TOOL_RESULT_BODY_LIMIT_BYTES
    ) {
      entry.result = {
        executionStatus:
          payload.executionStatus === 'cancelled' ? 'cancelled' : 'error',
        responseParts: [],
        error: { message: 'Managed Runtime tool result exceeds 1 MiB.' },
      };
    }
  }
}

function view(entry: JournalEntry): ManagedToolInvocationView {
  return {
    state: entry.state,
    lastSequence: entry.lastSequence,
    ...(entry.state === 'settled' ? { result: entry.result } : {}),
  };
}

function sameReference(
  left: ManagedToolReference,
  right: ManagedToolReference,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.promptId === right.promptId &&
    left.callId === right.callId &&
    left.argsDigest === right.argsDigest
  );
}

function sameInvocation(
  entry: JournalEntry,
  reference: ManagedToolReference,
  toolName: string,
  inputJson: string,
): boolean {
  return (
    sameReference(entry.reference, reference) &&
    entry.toolName === toolName &&
    entry.inputJson === inputJson
  );
}

function toPayload(
  result: ToolResult,
  cancelRequested: boolean,
): ManagedToolResultPayload {
  const content = result.llmContent;
  const responseParts =
    typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : Array.isArray(content)
        ? content
        : [];
  const toolError = result.error;
  // A cancel the Runtime honored ends the invocation, whether the tool
  // surfaces the abort as an error or as a polite early result.
  if (cancelRequested) {
    return {
      executionStatus: 'cancelled',
      responseParts,
      ...(toolError
        ? {
            error: {
              message: toolError.message,
              ...(toolError.type ? { type: toolError.type } : {}),
            },
          }
        : {}),
    };
  }
  if (toolError) {
    return {
      executionStatus: 'error',
      responseParts,
      error: {
        message: toolError.message,
        ...(toolError.type ? { type: toolError.type } : {}),
      },
    };
  }
  return { executionStatus: 'success', responseParts };
}
