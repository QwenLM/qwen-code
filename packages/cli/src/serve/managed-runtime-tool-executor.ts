/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ManagedRuntimeFileHistory } from './managed-runtime-file-history.js';
import type { RawFileHistoryOperation } from './hosted-file-history-protocol.js';
import { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { ApprovalMode } from '@qwen-code/qwen-code-core/config/approval-mode.js';
import { ReadFileTool } from '@qwen-code/qwen-code-core/tools/read-file.js';
import { WriteFileTool } from '@qwen-code/qwen-code-core/tools/write-file.js';
import { EditTool } from '@qwen-code/qwen-code-core/tools/edit.js';
import { ShellTool } from '@qwen-code/qwen-code-core/tools/shell.js';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import type { ShellToolInvocation } from '@qwen-code/qwen-code-core/tools/shell.js';
import type { ToolResultEnvelope } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import type {
  LocalShellCaptureRequest,
  LocalShellReceipt,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-shell-result-session.js';
import type { LocalShellResultCapture } from '@qwen-code/qwen-code-core/managed-runtime/local-shell-result-capture.js';
import type { ToolResultExpectedIdentity } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result-store.js';
import { MANAGED_TOOL_RESULT_PROTOCOL } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  registerSessionProjectDir,
  sessionIdContext,
} from '@qwen-code/qwen-code-core/utils/sessionIdContext.js';
import type {
  AnyDeclarativeTool,
  ToolResult,
} from '@qwen-code/qwen-code-core/tools/tools.js';
import { MANAGED_RUNTIME_TOOL_RESULT_BODY_LIMIT_BYTES } from './managed-runtime-attestation-contract.js';
import type { ManagedHookRuntime } from './managed-hook-runtime.js';
import { MANAGED_MCP_TOOL } from '@qwen-code/qwen-code-core/managed-runtime/managed-mcp-protocol.js';
import type { ManagedMcpOperationView } from '@qwen-code/qwen-code-core/managed-runtime/managed-mcp-protocol.js';
import {
  type ManagedMcpRuntime,
  ManagedMcpError,
  parseManagedMcpControl,
} from './managed-mcp-runtime.js';

export class ManagedMcpToolUnknownError extends Error {}

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
  | 'settled'
  | 'unknown';

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
  constructor(
    message: string,
    readonly code:
      | 'managed_runtime_identity_conflict'
      | 'managed_runtime_provider_operation_failed'
      | 'managed_tool_result_conflict' = 'managed_runtime_identity_conflict',
  ) {
    super(message);
  }
}

export class ManagedToolInvalidError extends Error {}

/** The call's Session has no verified directory to run in. */
export class ManagedToolUnavailableError extends Error {
  readonly code = 'managed_context_unavailable';
}

/** The admitted tools, keyed by name, over one configuration. */
export interface ManagedToolSet {
  /**
   * The session the tools run as. A shell they start sees it as
   * QWEN_CODE_SESSION_ID, with that session's project directory.
   */
  readonly sessionId: string;
  readonly directory?: string;
  readonly tools: ReadonlyMap<string, AnyDeclarativeTool>;
  /**
   * Whether a shell `directory` lies inside the tools' workspace. Calls run
   * without approval, so the executor enforces this boundary itself.
   */
  readonly admitsDirectory: (directory: string) => boolean;
  readonly isActive?: () => boolean;
}

/**
 * The tools a new invocation runs with, or undefined when its Session has no
 * verified directory. It is asked once per invocation, before it is journaled.
 */
export type ManagedToolSetResolver = (
  reference: ManagedToolReference,
) => Promise<ManagedToolSet | undefined>;

const ADMITTED_TOOL_NAMES: ReadonlySet<string> = new Set([
  ReadFileTool.Name,
  WriteFileTool.Name,
  EditTool.Name,
  ShellTool.Name,
]);

interface JournalEntry {
  readonly version: 2 | 3;
  readonly reference: ManagedToolReference;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly inputJson: string;
  state: ManagedToolExecutionState;
  lastSequence: number;
  result?: ManagedToolResultPayload;
  v3Result?: ToolResultEnvelope;
  readonly v3Capture?: LocalShellCaptureRequest['capture'];
  readonly captureSink?: ManagedShellCaptureSink;
  readonly capturePublisher?: ManagedShellCapturePublisher;
  acknowledgement?: ToolResultAcknowledgement;
  readonly controller: AbortController;
  promise?: Promise<void>;
}

export interface ToolResultAcknowledgement {
  readonly executionCallId: string;
  readonly manifest: ManagedSessionDurableRef | null;
  readonly deliveryStatus: 'committed' | 'blocked';
  readonly historyRevision: number | null;
}

export interface ManagedToolV3View {
  readonly state: ManagedToolExecutionState | 'unknown';
  readonly lastSequence?: number;
  readonly result?: ToolResultEnvelope;
}

export type ManagedShellCaptureSink = Pick<
  LocalShellResultCapture,
  keyof LocalShellResultCapture
>;

export interface ManagedShellCapturePublisher {
  prepare(request: LocalShellCaptureRequest): Promise<{
    identity: ToolResultExpectedIdentity;
    sink: ManagedShellCaptureSink;
    publisher?: ManagedShellCapturePublisher;
  }>;
  accept?(
    identity: ToolResultExpectedIdentity,
    envelope: ToolResultEnvelope,
  ): Promise<LocalShellReceipt>;
  finish?(
    identity: ToolResultExpectedIdentity,
    result: ToolResultEnvelope,
  ): Promise<void>;
}

/**
 * Executes the admitted ordinary tools for one Managed Runtime worker and
 * journals every invocation so `status` and `cancel` can answer by the
 * original reference. Each new invocation runs with the tools that the
 * resolver answers for it. The journal is in-memory by construction: the worker
 * process is the Runtime generation, so a restart is a new generation, never
 * a continuation of this state.
 */
export class ManagedToolExecutor {
  private readonly entries = new Map<string, JournalEntry>();
  private readonly mcpCalls = new Map<
    string,
    {
      reference: ManagedToolReference;
      input: Record<string, unknown>;
      inputJson: string;
      refusal?: ManagedToolResultPayload;
    }
  >();
  private readonly providerSessions = new Set<string>();
  private readonly closedSessions = new Set<string>();
  private provider?: {
    hasActiveSession(sessionId: string): boolean;
    close(): Promise<void>;
  };
  private closing = false;
  private readonly fileHistories = new Map<string, ManagedRuntimeFileHistory>();
  private readonly historyControls = new Set<string>();

  async controlFileHistory(
    ownerSessionId: string,
    sessionId: string,
    operation: RawFileHistoryOperation,
  ): Promise<unknown> {
    this.assertLegacySession(sessionId);
    if (
      this.closing ||
      this.hasActiveToolSession(sessionId) ||
      (operation.action === 'rewind' &&
        this.hooks?.hasHolds(sessionId) === true) ||
      [...this.entries.values()].some(
        (entry) =>
          entry.reference.sessionId === sessionId && entry.state === 'unknown',
      )
    )
      throw new ManagedToolConflictError(
        'File history requires an idle Runtime Session.',
      );
    this.historyControls.add(sessionId);
    try {
      const tools = await this.toolsFor({
        sessionId,
        promptId: sessionId,
        callId: 'history',
        argsDigest: '',
      });
      if (!tools?.directory || tools.isActive?.() === false)
        throw new ManagedToolUnavailableError(
          'File history Workspace is unavailable.',
        );
      let history = this.fileHistories.get(sessionId);
      if (operation.action === 'bind') {
        if (!history) {
          history = new ManagedRuntimeFileHistory(
            ownerSessionId,
            tools.directory,
            operation.state,
          );
          await history.ready();
          this.fileHistories.set(sessionId, history);
        } else if (
          history.ownerSessionId !== ownerSessionId ||
          history.directory !== tools.directory ||
          !isDeepStrictEqual(
            history.state(),
            operation.state ?? { ownerSessionId, snapshots: [], files: {} },
          )
        ) {
          throw new ManagedToolConflictError('File history binding conflicts.');
        }
      }
      if (
        !history ||
        history.ownerSessionId !== ownerSessionId ||
        history.directory !== tools.directory
      )
        throw new ManagedToolConflictError(
          'File history is not bound to this Workspace.',
        );
      if (operation.action === 'prepare')
        await history.prepare(operation.promptId, operation.paths);
      if (operation.action === 'rewind')
        return await history.rewind(operation.promptId);
      await history.ready();
      return history.state();
    } finally {
      this.historyControls.delete(sessionId);
    }
  }

  constructor(
    private readonly toolsFor: ManagedToolSetResolver,
    private readonly capturePublisher?: ManagedShellCapturePublisher,
    private readonly mcp?: ManagedMcpRuntime,
    private readonly hooks?: ManagedHookRuntime,
  ) {}

  static forWorkspace(workspaceCwd: string, runtimeInstanceId: string) {
    // Boot v1 configures its one directory at startup, as it always has.
    const tools = createManagedToolSet(workspaceCwd, runtimeInstanceId);
    return new ManagedToolExecutor(async () => tools);
  }

  hasTool(toolName: string): boolean {
    return (
      ADMITTED_TOOL_NAMES.has(toolName) ||
      (toolName === MANAGED_MCP_TOOL && this.mcp !== undefined)
    );
  }

  attachProvider(provider: NonNullable<ManagedToolExecutor['provider']>): void {
    this.provider = provider;
  }

  claimProviderSession(sessionId: string): void {
    if (
      this.closing ||
      this.historyControls.has(sessionId) ||
      this.fileHistories.has(sessionId) ||
      this.closedSessions.has(sessionId) ||
      [...this.entries.values()].some(
        (entry) => entry.reference.sessionId === sessionId,
      ) ||
      [...this.mcpCalls.values()].some(
        (entry) => entry.reference.sessionId === sessionId,
      )
    ) {
      throw new ManagedToolConflictError('Managed Runtime Session conflicts.');
    }
    this.providerSessions.add(sessionId);
  }

  unclaimProviderSession(sessionId: string): void {
    this.providerSessions.delete(sessionId);
  }

  closeSessionAdmission(sessionId: string): void {
    if (this.hasActiveSession(sessionId)) {
      throw new ManagedToolConflictError(
        'Managed Runtime Session still owns unfinished work.',
      );
    }
    this.closedSessions.add(sessionId);
    this.fileHistories.delete(sessionId);
  }

  private assertLegacySession(sessionId: string): void {
    if (
      this.historyControls.has(sessionId) ||
      this.providerSessions.has(sessionId) ||
      this.closedSessions.has(sessionId)
    ) {
      throw new ManagedToolConflictError('Managed Runtime protocol conflicts.');
    }
  }

  async execute(
    reference: ManagedToolReference,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<ManagedToolResultPayload> {
    this.assertLegacySession(reference.sessionId);
    if (this.closing) {
      throw new ManagedToolUnavailableError(
        'Managed Runtime worker is closing.',
      );
    }
    if (toolName === MANAGED_MCP_TOOL && this.mcp) {
      const existing = this.mcpCalls.get(reference.callId);
      const inputJson = JSON.stringify(input);
      if (
        this.entries.has(reference.callId) ||
        (existing &&
          (!sameReference(existing.reference, reference) ||
            existing.inputJson !== inputJson))
      )
        throw new ManagedToolConflictError(
          'Managed MCP invocation identity conflicts.',
        );
      if (existing?.refusal) return existing.refusal;
      if (!existing) {
        const tools = await this.toolsFor(reference);
        this.assertLegacySession(reference.sessionId);
        if (!tools || tools.isActive?.() === false)
          throw new ManagedToolUnavailableError(
            'Managed MCP Session is unavailable.',
          );
        if (this.mcpCalls.has(reference.callId))
          return this.execute(reference, toolName, input);
        const control = parseManagedMcpControl(input);
        if (
          control.kind !== 'mcp-invoke' ||
          control.request.kind !== 'tool_call' ||
          control.operationId !== reference.callId
        )
          throw new ManagedToolInvalidError(
            'Managed MCP tool input is invalid.',
          );
        this.mcpCalls.set(reference.callId, {
          reference,
          input: structuredClone(input),
          inputJson,
        });
      }
      let result: ManagedMcpOperationView;
      try {
        result = await this.mcp.invokeTool(reference.sessionId, input);
      } catch (error) {
        if (!(error instanceof ManagedMcpError)) throw error;
        const refusal: ManagedToolResultPayload = {
          executionStatus: 'not_started',
          responseParts: [],
          error: { type: error.code, message: error.code },
        };
        this.mcpCalls.get(reference.callId)!.refusal = refusal;
        return refusal;
      }
      if (result.state !== 'settled')
        throw new ManagedMcpToolUnknownError(
          'Managed MCP execution outcome is unknown.',
        );
      return mcpPayload(result);
    }
    if (this.mcpCalls.has(reference.callId))
      throw new ManagedToolConflictError('Managed Runtime protocol conflicts.');
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
      if (existing.version !== 2) {
        throw new ManagedToolConflictError(
          'Managed Runtime protocol conflicts.',
        );
      }
      return join(existing, reference, toolName, inputJson);
    }
    const tools = await this.toolsFor(reference);
    this.assertLegacySession(reference.sessionId);
    // A concurrent execute of the same call may have journaled it meanwhile.
    const joined = this.entries.get(reference.callId);
    if (joined) {
      if (joined.version !== 2) {
        throw new ManagedToolConflictError(
          'Managed Runtime protocol conflicts.',
        );
      }
      return join(joined, reference, toolName, inputJson);
    }
    if (this.closing) {
      throw new ManagedToolUnavailableError(
        'Managed Runtime worker is closing.',
      );
    }
    if (tools === undefined || tools.isActive?.() === false) {
      throw new ManagedToolUnavailableError(
        'Managed context directory is unavailable.',
      );
    }
    const tool = tools.tools.get(toolName);
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
      version: 2,
      reference,
      toolName,
      input,
      inputJson,
      state: 'prepared',
      lastSequence: 0,
      controller: new AbortController(),
    };
    this.entries.set(reference.callId, entry);
    entry.promise = this.run(entry, tool, tools, tools.directory);
    return join(entry, reference, toolName, inputJson);
  }

  async executeV3(
    request: LocalShellCaptureRequest & {
      readonly toolName: string;
      readonly input: Record<string, unknown>;
    },
  ): Promise<ManagedToolV3View> {
    if (this.closing) {
      throw new ManagedToolUnavailableError(
        'Managed Runtime worker is closing.',
      );
    }
    const { reference, capture, toolName, input } = request;
    this.assertLegacySession(reference.sessionId);
    let inputJson: string;
    let inputDigest: string;
    try {
      inputJson = JSON.stringify(input);
      inputDigest = managedToolDigest(input);
    } catch {
      throw new ManagedToolInvalidError(
        'Managed Runtime tool request is invalid.',
      );
    }
    if (reference.argsDigest.replace(/^sha256:/, '') !== inputDigest) {
      throw new ManagedToolConflictError(
        'Managed Runtime invocation digest conflicts.',
      );
    }
    const existing = this.entries.get(reference.callId);
    if (existing) {
      if (
        existing.version !== 3 ||
        !sameReference(existing.reference, reference) ||
        existing.toolName !== toolName ||
        !sameCapture(existing.v3Capture, capture)
      ) {
        throw new ManagedToolConflictError(
          'Managed Runtime invocation identity conflicts.',
        );
      }
      if (!existing.capturePublisher?.finish) await existing.promise;
      return v3View(existing);
    }
    if (!this.capturePublisher || toolName !== ShellTool.Name) {
      throw new ManagedToolUnavailableError(
        'Tool v3 capture is not available.',
      );
    }
    const tools = await this.toolsFor(reference);
    this.assertLegacySession(reference.sessionId);
    const joined = this.entries.get(reference.callId);
    if (joined) return this.executeV3(request);
    if (!tools || tools.isActive?.() === false) {
      throw new ManagedToolUnavailableError(
        'Managed context directory is unavailable.',
      );
    }
    const tool = tools.tools.get(toolName);
    if (!tool)
      throw new ManagedToolUnavailableError('Foreground Shell is unavailable.');
    const normalized = structuredClone(input);
    if (
      tool.validateToolParams(normalized) === null &&
      normalized['is_background'] === true
    ) {
      throw new ManagedToolConflictError(
        'Background Shell capture is unavailable.',
      );
    }
    let prepared: Awaited<ReturnType<ManagedShellCapturePublisher['prepare']>>;
    try {
      prepared = await this.capturePublisher.prepare({ reference, capture });
    } catch (cause) {
      throw new ManagedToolUnavailableError(
        cause instanceof Error ? cause.message : String(cause),
      );
    }
    if (this.entries.has(reference.callId)) return this.executeV3(request);
    this.assertLegacySession(reference.sessionId);
    if (this.closing || tools.isActive?.() === false) {
      throw new ManagedToolUnavailableError(
        'Managed Runtime worker is no longer active.',
      );
    }
    const entry: JournalEntry = {
      version: 3,
      reference,
      toolName,
      input,
      inputJson,
      v3Capture: capture,
      captureSink: prepared.sink,
      capturePublisher: prepared.publisher ?? this.capturePublisher,
      state: 'prepared',
      lastSequence: 0,
      controller: new AbortController(),
    };
    this.entries.set(reference.callId, entry);
    entry.promise = this.run(entry, tool, tools);
    if (!entry.capturePublisher?.finish) await entry.promise;
    return v3View(entry);
  }

  statusV3(reference: ManagedToolReference): ManagedToolV3View {
    const entry = this.entries.get(reference.callId);
    if (!entry) return { state: 'unknown' };
    if (entry.version !== 3 || !sameReference(entry.reference, reference)) {
      throw new ManagedToolConflictError('Managed Runtime protocol conflicts.');
    }
    return v3View(entry);
  }

  cancelV3(reference: ManagedToolReference): ManagedToolV3View {
    const entry = this.entries.get(reference.callId);
    if (!entry) return { state: 'unknown' };
    if (entry.version !== 3 || !sameReference(entry.reference, reference)) {
      throw new ManagedToolConflictError('Managed Runtime protocol conflicts.');
    }
    if (entry.state === 'prepared') {
      entry.v3Result = {
        executionStatus: 'not_started',
        responseParts: [],
        capture: null,
      };
      entry.state = 'settled';
      entry.lastSequence++;
    } else if (entry.state === 'executing') {
      entry.state = 'cancel_requested';
      entry.lastSequence++;
      entry.controller.abort();
    }
    return v3View(entry);
  }

  acknowledgeV3(
    reference: ManagedToolReference,
    receipt: ToolResultAcknowledgement,
  ): ManagedToolV3View {
    const entry = this.entries.get(reference.callId);
    if (!entry) return { state: 'unknown' };
    if (entry.version !== 3 || !sameReference(entry.reference, reference)) {
      throw new ManagedToolConflictError('Managed Runtime protocol conflicts.');
    }
    if (!entry.v3Result || entry.state !== 'settled') {
      throw new ManagedToolConflictError(
        'Tool result has not settled.',
        'managed_tool_result_conflict',
      );
    }
    const actual = entry.v3Result.capture;
    if (
      !actual ||
      receipt.executionCallId !== entry.v3Capture?.executionCallId ||
      JSON.stringify(receipt.manifest) !== JSON.stringify(actual.manifest) ||
      (receipt.deliveryStatus === 'committed' &&
        (actual.captureStatus !== 'complete' ||
          !Number.isSafeInteger(receipt.historyRevision) ||
          (receipt.historyRevision ?? 0) < 1)) ||
      (receipt.deliveryStatus === 'blocked' && receipt.historyRevision !== null)
    ) {
      throw new ManagedToolConflictError(
        'Tool result receipt conflicts.',
        'managed_tool_result_conflict',
      );
    }
    if (
      entry.acknowledgement &&
      JSON.stringify(entry.acknowledgement) !== JSON.stringify(receipt)
    ) {
      throw new ManagedToolConflictError(
        'Tool result was acknowledged differently.',
        'managed_tool_result_conflict',
      );
    }
    entry.acknowledgement = receipt;
    entry.v3Result = {
      ...entry.v3Result,
      capture: { ...actual, deliveryStatus: receipt.deliveryStatus },
    };
    return v3View(entry);
  }

  /** Read-only lookup; never creates or advances an invocation. */
  hasActiveSession(sessionId: string): boolean {
    return (
      this.hooks?.hasHolds(sessionId) === true ||
      this.hasActiveToolSession(sessionId)
    );
  }

  private hasActiveToolSession(sessionId: string): boolean {
    if (this.historyControls.has(sessionId)) return true;
    return (
      this.mcp?.hasHolds(sessionId) === true ||
      this.provider?.hasActiveSession(sessionId) === true ||
      [...this.entries.values()].some(
        (entry) =>
          entry.reference.sessionId === sessionId &&
          entry.state !== 'settled' &&
          entry.state !== 'unknown',
      )
    );
  }

  /** Read-only lookup; never creates or advances an invocation. */
  status(reference: ManagedToolReference): ManagedToolInvocationView | null {
    const mcp = this.mcpCalls.get(reference.callId);
    if (mcp && this.mcp) {
      if (!sameReference(mcp.reference, reference)) return null;
      if (mcp.refusal)
        return { state: 'settled', lastSequence: 1, result: mcp.refusal };
      return mcpView(this.mcp.toolStatus(reference.sessionId, mcp.input));
    }
    const entry = this.entries.get(reference.callId);
    if (entry && entry.version !== 2) {
      throw new ManagedToolConflictError('Managed Runtime protocol conflicts.');
    }
    if (!entry || !sameReference(entry.reference, reference)) {
      return null;
    }
    return view(entry);
  }

  cancel(reference: ManagedToolReference): ManagedToolInvocationView | null {
    const mcp = this.mcpCalls.get(reference.callId);
    if (mcp && this.mcp) {
      if (!sameReference(mcp.reference, reference)) return null;
      if (mcp.refusal)
        return { state: 'settled', lastSequence: 1, result: mcp.refusal };
      this.mcp.cancelTool(reference.sessionId, mcp.input);
      return mcpView(this.mcp.toolStatus(reference.sessionId, mcp.input));
    }
    const entry = this.entries.get(reference.callId);
    if (entry && entry.version !== 2) {
      throw new ManagedToolConflictError('Managed Runtime protocol conflicts.');
    }
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
    this.closing = true;
    await Promise.all([this.mcp?.close(), this.hooks?.close()]);
    for (const entry of this.entries.values()) {
      if (entry.state === 'executing' || entry.state === 'cancel_requested') {
        entry.controller.abort();
      }
    }
    await Promise.allSettled([
      ...[...this.entries.values()].flatMap((entry) =>
        entry.promise ? [entry.promise] : [],
      ),
      this.provider?.close(),
    ]);
  }

  private static isCancelRequested(entry: JournalEntry): boolean {
    // Read across a method boundary: cancel() can move the entry to
    // cancel_requested while this invocation is parked in the tool.
    return entry.state === 'cancel_requested';
  }

  private async run(
    entry: JournalEntry,
    tool: AnyDeclarativeTool,
    tools: ManagedToolSet,
    directory?: string,
  ): Promise<void> {
    const { sessionId } = tools;
    entry.state = 'executing';
    entry.lastSequence += 1;
    let payload: ManagedToolResultPayload;
    try {
      const params = structuredClone(entry.input);
      if (
        directory &&
        entry.toolName !== ShellTool.Name &&
        typeof params['file_path'] === 'string' &&
        !path.isAbsolute(params['file_path'].trim())
      ) {
        params['file_path'] = path.resolve(
          directory,
          params['file_path'].trim(),
        );
      }
      if (
        entry.toolName === ShellTool.Name &&
        typeof params['directory'] === 'string' &&
        params['directory'] !== '' &&
        !tools.admitsDirectory(params['directory'])
      ) {
        throw new Error(
          `Directory '${params['directory']}' is not within any of the registered workspace directories.`,
        );
      }
      const invoke = () =>
        sessionIdContext.run(sessionId, () => {
          const invocation = tool.build(params);
          return entry.version === 3 && entry.captureSink
            ? (invocation as ShellToolInvocation).execute(
                entry.controller.signal,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                entry.captureSink,
              )
            : invocation.execute(entry.controller.signal);
        });
      const history = this.fileHistories.get(entry.reference.sessionId);
      let result: ToolResult;
      if (
        history &&
        [WriteFileTool.Name, EditTool.Name].includes(entry.toolName)
      ) {
        let outcome: { result: ToolResult } | { error: unknown };
        let invoked = false;
        try {
          const file = path
            .relative(history.directory, params['file_path'] as string)
            .split(path.sep)
            .join('/');
          outcome = await history.execute(file, async () => {
            invoked = true;
            try {
              return { result: await invoke() };
            } catch (error) {
              return { error };
            }
          });
        } catch (error) {
          if (!invoked) throw error;
          // A post-execution history failure cannot prove the file outcome.
          entry.state = 'unknown';
          entry.lastSequence++;
          return;
        }
        if ('error' in outcome) throw outcome.error;
        result = outcome.result;
      } else {
        result = await invoke();
      }
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
    if (entry.version === 3) {
      try {
        entry.v3Result = await entry.captureSink!.finalize(
          payload.executionStatus,
          payload.responseParts,
          payload.error,
        );
        if (
          Buffer.byteLength(
            JSON.stringify({
              protocolVersion: 3,
              toolResult: MANAGED_TOOL_RESULT_PROTOCOL,
              state: 'settled',
              lastSequence: entry.lastSequence + 1,
              result: entry.v3Result,
            }),
          ) > MANAGED_RUNTIME_TOOL_RESULT_BODY_LIMIT_BYTES
        ) {
          entry.v3Result = {
            ...entry.v3Result,
            responseParts: [],
            error: { message: 'Managed Runtime tool preview exceeds 1 MiB.' },
          };
        }
        if (entry.v3Result.capture) {
          if (entry.capturePublisher!.finish) {
            await entry.capturePublisher!.finish(
              entry.captureSink!.identity,
              entry.v3Result,
            );
          } else if (entry.capturePublisher!.accept) {
            const receipt = await entry.capturePublisher!.accept(
              entry.captureSink!.identity,
              entry.v3Result,
            );
            entry.v3Result = {
              ...entry.v3Result,
              capture: {
                ...entry.v3Result.capture,
                deliveryStatus: receipt.deliveryStatus,
              },
            };
            entry.acknowledgement = {
              executionCallId: receipt.executionCallId,
              manifest: receipt.manifest,
              deliveryStatus: receipt.deliveryStatus,
              historyRevision: receipt.historyRevision,
            };
          }
        }
      } catch {
        entry.state = 'unknown';
        entry.lastSequence++;
        return;
      }
      entry.state = 'settled';
      entry.lastSequence++;
      return;
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

function mcpView(view: ManagedMcpOperationView): ManagedToolInvocationView {
  return {
    state:
      view.state === 'running'
        ? 'executing'
        : view.state === 'outcome_unknown'
          ? 'unknown'
          : 'settled',
    lastSequence: view.state === 'running' ? 1 : 2,
    ...(view.state === 'settled' ? { result: mcpPayload(view) } : {}),
  };
}

function mcpPayload(view: ManagedMcpOperationView): ManagedToolResultPayload {
  const response = view.response;
  return {
    executionStatus: view.error
      ? ['managed_mcp_remote_error', 'managed_mcp_output_limit'].includes(
          view.error.code,
        )
        ? 'error'
        : 'not_started'
      : response?.['isError'] === true
        ? 'error'
        : 'success',
    responseParts: response ? [{ text: JSON.stringify(response) }] : [],
    ...(view.error
      ? { error: { type: view.error.code, message: view.error.code } }
      : {}),
  };
}

function v3View(entry: JournalEntry): ManagedToolV3View {
  return {
    state: entry.state,
    lastSequence: entry.lastSequence,
    ...(entry.state === 'settled' ? { result: entry.v3Result } : {}),
  };
}

/**
 * The admitted tools over a configuration whose working directory and
 * workspace are `directory`, as they are when it is built. They run as
 * `sessionId`, whose project directory is registered for their shells.
 */
export function createManagedToolSet(
  directory: string,
  sessionId: string,
  workspaceRoot: string = directory,
): ManagedToolSet {
  const config = new Config({
    sessionId,
    targetDir: directory,
    cwd: directory,
    includeDirectories: [workspaceRoot],
    model: 'managed-runtime-worker',
    debugMode: false,
    usageStatisticsEnabled: false,
    approvalMode: ApprovalMode.YOLO,
    fileCheckpointingEnabled: false,
    // The worker has no conversation history to justify cached read elision.
    fileReadCacheDisabled: true,
  });
  registerSessionProjectDir(sessionId, config.storage.getProjectDir());
  return {
    sessionId,
    directory,
    admitsDirectory: (candidate) =>
      config.getWorkspaceContext().isPathWithinWorkspace(candidate),
    tools: new Map(
      [
        new ReadFileTool(config),
        new WriteFileTool(config),
        new EditTool(config),
        new ShellTool(config),
      ].map((tool): [string, AnyDeclarativeTool] => [tool.name, tool]),
    ),
  };
}

async function join(
  entry: JournalEntry,
  reference: ManagedToolReference,
  toolName: string,
  inputJson: string,
): Promise<ManagedToolResultPayload> {
  if (!sameInvocation(entry, reference, toolName, inputJson)) {
    throw new ManagedToolConflictError(
      'Managed Runtime invocation identity conflicts.',
    );
  }
  await entry.promise;
  if (entry.state === 'unknown')
    throw new ManagedMcpToolUnknownError(
      'Managed Runtime tool outcome is unknown.',
    );
  return entry.result!;
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

function sameCapture(
  left: LocalShellCaptureRequest['capture'] | undefined,
  right: LocalShellCaptureRequest['capture'],
): boolean {
  return (
    left?.tenantId === right.tenantId &&
    left.sessionId === right.sessionId &&
    left.turnId === right.turnId &&
    left.executionCallId === right.executionCallId &&
    left.bindingGeneration === right.bindingGeneration &&
    left.capturePolicy === right.capturePolicy
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
