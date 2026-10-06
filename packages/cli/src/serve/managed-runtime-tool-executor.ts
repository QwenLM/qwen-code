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
import { getShellConfiguration } from '@qwen-code/qwen-code-core/utils/shell-utils.js';
import { getShellContextEnvVars } from '@qwen-code/qwen-code-core/services/shellContextEnv.js';
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
import {
  MANAGED_CSI_ACK_LIMIT_BYTES,
  ManagedCsiAckRequestError,
  parseManagedCsiAcknowledgement,
  parseManagedCsiAckRequest,
  parseManagedCsiAckResponse,
  parseManagedCsiCaptureIdentity,
  type ManagedCsiAckRequest,
  type ManagedCsiAckResponse,
  type ManagedCsiBoot,
  type ManagedCsiPodIdentity,
} from './managed-csi-envelope.js';
import {
  HookCommandIsolationUnavailableError,
  type HookCommandIsolationUnavailableReason,
  type ManagedChildRunProcess,
  type ManagedChildRunSupervisor,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-supervisor.js';
import { ManagedBackgroundShellRegistry } from './managed-background-shell-registry.js';
import { ManagedMonitorRegistry } from './managed-monitor-registry.js';
import { ManagedMonitorWatcher } from './managed-monitor-watcher.js';

export class ManagedMcpToolUnknownError extends Error {}

const ISOLATION_REFUSAL_CLAUSES: Record<
  HookCommandIsolationUnavailableReason,
  string
> = {
  platform: 'this Runtime does not run Linux with cgroup v2',
  root_missing: 'no delegated cgroup v2 root is configured on this Runtime',
  root_shape:
    'the delegated root on this Runtime is not a cgroup v2 domain directory',
  root_unreadable:
    'the delegated cgroup v2 root on this Runtime is missing or unreadable',
  unit_name_invalid: 'its cgroup unit name is not valid on this Runtime',
  unit_name_taken:
    'a cgroup unit with the same name already exists on this Runtime',
  unit_not_empty:
    'another unit still holds processes under that name on this Runtime',
  membership_unproven:
    'the process never proved its cgroup membership on this Runtime',
};

/** The recorded refusal carries the discriminator; the message names it. */
function isolationRefusal(
  tool: 'Background Shell' | 'Monitor watch',
  cause: HookCommandIsolationUnavailableError,
): { message: string; type?: string } {
  const { reason } = cause;
  if (reason === undefined)
    return {
      message: `${tool} requires a delegated Linux cgroup v2 directory on this Runtime.`,
    };
  return {
    message: `${tool} requires a delegated Linux cgroup v2 directory: ${ISOLATION_REFUSAL_CLAUSES[reason]}.`,
    type: `managed_isolation_${reason}`,
  };
}

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
  | 'acknowledged'
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

/** Live background Shells one Session may hold, by the H3 design contract. */
const MANAGED_BACKGROUND_MAX_SHELLS = 8;
/** Live Monitor watches one Session may hold, by the H3 design contract. */
const MANAGED_MONITOR_MAX_WATCHES = 4;
// The bounded capture publishes asynchronously; the pipe feeding it must
// slow down instead of queueing unboundedly. Sixteen MiB covers a store
// writing several seconds slower than the process produces, and resume
// re-arms well before the drain fully empties so a steady producer never
// stalls against the floor.
const MANAGED_BACKGROUND_OUTPUT_PAUSE_BYTES = 16 * 1024 * 1024;
const MANAGED_BACKGROUND_OUTPUT_RESUME_BYTES = 4 * 1024 * 1024;

interface JournalEntry {
  readonly version: 2 | 3;
  readonly reference: ManagedToolReference;
  readonly toolName: string;
  /**
   * Dropped with the result on acknowledgement: the caller that settled the
   * call durably owns the payload from then on, so the journal keeps only the
   * fact that proves a repeat is a repeat.
   */
  input?: Record<string, unknown>;
  inputJson?: string;
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

export interface ManagedWorkerDrainObservation {
  readonly state: 'DRAINING';
  readonly workState: 'PENDING' | 'QUIESCENT' | 'BLOCKED';
  readonly pendingStarts: number;
  readonly pendingInvocations: number;
  readonly blockers: readonly string[];
}

export type ManagedShellCaptureSink = Pick<
  LocalShellResultCapture,
  keyof LocalShellResultCapture
>;

export interface ManagedShellCapturePublisher {
  readonly hasInstalledPublication?: boolean;
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
  private readonly backgroundRegistry: ManagedBackgroundShellRegistry;
  private readonly monitorRegistry: ManagedMonitorRegistry;
  private readonly monitorWatcher: ManagedMonitorWatcher | undefined;
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
    getDrainInspection(): { pendingInvocations: number; hasActivity: boolean };
    close(): Promise<void>;
  };
  private closing = false;
  private retirementId?: string;
  private providerWasUsed = false;
  private capturePreparationStarted = false;
  private historyControlOutcomeUnknown = false;
  private readonly pendingStarts = new Set<Promise<unknown>>();
  private readonly fileHistories = new Map<string, ManagedRuntimeFileHistory>();
  private readonly historyControls = new Set<string>();

  get isAdmissionOpen(): boolean {
    return !this.closing && this.retirementId === undefined;
  }

  get isAdmissionSealed(): boolean {
    return this.retirementId !== undefined;
  }

  sealAdmission(retirementId: string): void {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        retirementId,
      )
    )
      throw new ManagedToolInvalidError('Retirement identity is invalid.');
    if (this.retirementId !== undefined && this.retirementId !== retirementId)
      throw new ManagedToolConflictError('Retirement identity conflicts.');
    this.retirementId = retirementId;
    this.mcp?.sealAdmission();
    this.hooks?.sealAdmission();
  }

  getDrainObservation(retirementId: string): ManagedWorkerDrainObservation {
    if (this.retirementId === undefined || this.retirementId !== retirementId)
      throw new ManagedToolConflictError('Retirement identity conflicts.');
    const blockers = new Set<string>();
    if (this.closing) blockers.add('shutdown_started');
    if (this.capturePreparationStarted)
      blockers.add('capture_preparation_unqualified');
    if (this.capturePublisher?.hasInstalledPublication)
      blockers.add('publication_lifecycle_unqualified');
    if (this.historyControlOutcomeUnknown)
      blockers.add('history_control_outcome_unknown');
    let pendingInvocations = 0;
    for (const entry of this.entries.values()) {
      if (entry.toolName === ShellTool.Name)
        blockers.add('shell_lifecycle_unqualified');
      if (entry.state === 'unknown') blockers.add('execution_outcome_unknown');
      // An acknowledged call is settled and its outcome durably committed by
      // the caller: it holds neither pending work nor a result to check.
      else if (entry.state === 'acknowledged') continue;
      else if (entry.state !== 'settled') pendingInvocations++;
      else if (entry.version === 2 && !entry.result)
        blockers.add('execution_result_missing');
      else if (entry.version === 3) {
        const result = entry.v3Result;
        if (!result) blockers.add('execution_result_missing');
        else if (result.executionStatus !== 'not_started') {
          if (result.capture?.captureStatus !== 'complete')
            blockers.add('capture_incomplete');
          if (
            result.capture?.deliveryStatus !== 'committed' ||
            entry.acknowledgement?.deliveryStatus !== 'committed'
          )
            blockers.add('capture_uncommitted');
        }
      }
    }
    const provider = this.provider?.getDrainInspection();
    if (this.providerWasUsed || provider?.hasActivity)
      blockers.add('provider_lifecycle_unqualified');
    pendingInvocations += provider?.pendingInvocations ?? 0;
    const mcp = this.mcp?.getDrainInspection();
    if (this.mcpCalls.size > 0 || mcp?.hasActivity)
      blockers.add('mcp_lifecycle_unqualified');
    pendingInvocations += mcp?.pendingInvocations ?? 0;
    const hooks = this.hooks?.getDrainInspection();
    if (hooks?.hasActivity) blockers.add('hook_lifecycle_unqualified');
    pendingInvocations += hooks?.pendingInvocations ?? 0;
    const pendingStarts =
      this.pendingStarts.size +
      (mcp?.pendingStarts ?? 0) +
      (hooks?.pendingStarts ?? 0);
    return {
      state: 'DRAINING',
      workState:
        blockers.size > 0
          ? 'BLOCKED'
          : pendingStarts > 0 || pendingInvocations > 0
            ? 'PENDING'
            : 'QUIESCENT',
      pendingStarts,
      pendingInvocations,
      blockers: [...blockers].sort(),
    };
  }

  controlFileHistory(
    ownerSessionId: string,
    sessionId: string,
    operation: RawFileHistoryOperation,
  ): Promise<unknown> {
    if (this.isAdmissionSealed) {
      const history = this.fileHistories.get(sessionId);
      if (operation.action !== 'snapshot')
        return Promise.reject(
          new ManagedToolUnavailableError(
            'Managed Runtime admission is sealed.',
          ),
        );
      if (!history || history.ownerSessionId !== ownerSessionId)
        return Promise.reject(
          new ManagedToolConflictError(
            'File history is not bound to this Workspace.',
          ),
        );
      if (this.hasActiveSession(sessionId))
        return Promise.reject(
          new ManagedToolConflictError(
            'File history requires an idle Runtime Session.',
          ),
        );
      return Promise.resolve(history.state());
    }
    return this.trackStart(() =>
      this.controlFileHistoryAdmitted(ownerSessionId, sessionId, operation),
    );
  }

  private async controlFileHistoryAdmitted(
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
    let mutationStarted = false;
    try {
      const tools = await this.toolsFor({
        sessionId,
        promptId: sessionId,
        callId: 'history',
        argsDigest: '',
      });
      if (
        !this.isAdmissionOpen ||
        !tools?.directory ||
        tools.isActive?.() === false
      )
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
          if (!this.isAdmissionOpen)
            throw new ManagedToolUnavailableError(
              'Managed Runtime admission is sealed.',
            );
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
      if (operation.action === 'prepare') {
        mutationStarted = true;
        await history.prepare(operation.promptId, operation.paths);
      }
      if (operation.action === 'rewind') {
        mutationStarted = true;
        const result = await history.rewind(operation.promptId);
        if (result.filesFailed.length > 0)
          this.historyControlOutcomeUnknown = true;
        return result;
      }
      await history.ready();
      return history.state();
    } catch (error) {
      if (mutationStarted) this.historyControlOutcomeUnknown = true;
      throw error;
    } finally {
      this.historyControls.delete(sessionId);
    }
  }

  constructor(
    private readonly toolsFor: ManagedToolSetResolver,
    private readonly capturePublisher?: ManagedShellCapturePublisher,
    private readonly mcp?: ManagedMcpRuntime,
    private readonly hooks?: ManagedHookRuntime,
    private readonly backgroundSupervisor?: ManagedChildRunSupervisor,
    backgroundRegistry?: ManagedBackgroundShellRegistry,
    monitorRegistry?: ManagedMonitorRegistry,
  ) {
    this.backgroundRegistry =
      backgroundRegistry ?? new ManagedBackgroundShellRegistry();
    this.monitorRegistry = monitorRegistry ?? new ManagedMonitorRegistry();
    this.monitorWatcher = backgroundSupervisor
      ? new ManagedMonitorWatcher(backgroundSupervisor)
      : undefined;
  }

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
      !this.isAdmissionOpen ||
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
    this.providerWasUsed = true;
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
    if (this.retirementId === undefined) this.fileHistories.delete(sessionId);
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

  execute(
    reference: ManagedToolReference,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<ManagedToolResultPayload> {
    return this.trackStart(() =>
      this.executeAdmitted(reference, toolName, input),
    );
  }

  private async executeAdmitted(
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
        this.assertAdmissionOpen();
        const tools = await this.toolsFor(reference);
        this.assertLegacySession(reference.sessionId);
        if (!this.isAdmissionOpen || !tools || tools.isActive?.() === false)
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
    this.assertAdmissionOpen();
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
    if (!this.isAdmissionOpen) {
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

  executeV3(
    request: LocalShellCaptureRequest & {
      readonly toolName: string;
      readonly input: Record<string, unknown>;
    },
  ): Promise<ManagedToolV3View> {
    return this.trackStart(() => this.executeV3Admitted(request));
  }

  private async executeV3Admitted(
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
    this.assertAdmissionOpen();
    if (
      !this.capturePublisher ||
      (toolName !== ShellTool.Name && toolName !== 'monitor')
    ) {
      throw new ManagedToolUnavailableError(
        'Tool v3 capture is not available.',
      );
    }
    const tools = await this.toolsFor(reference);
    this.assertLegacySession(reference.sessionId);
    const joined = this.entries.get(reference.callId);
    if (joined) return this.executeV3(request);
    if (!this.isAdmissionOpen || !tools || tools.isActive?.() === false) {
      throw new ManagedToolUnavailableError(
        'Managed context directory is unavailable.',
      );
    }
    // The native Monitor wire shape names its own tool: it needs no Shell
    // tool instance — the monitor admission owns its validation.
    if (toolName === 'monitor') {
      return this.executeV3Monitor(request, tools, structuredClone(input));
    }
    const normalized = structuredClone(input);
    // The background and monitor families reject long waits' shell-side
    // policies such as the foreground sleep guard — they exist exactly so
    // that a wait is durable rather than blocked. Validate with their own
    // admission instead of the foreground Shell tool's parameters.
    if (normalized['is_background'] === true) {
      return this.executeV3Background(request, tools, normalized);
    }
    if (normalized['is_monitor'] === true) {
      return this.executeV3Monitor(request, tools, normalized);
    }
    const tool = tools.tools.get(toolName);
    if (!tool)
      throw new ManagedToolUnavailableError('Foreground Shell is unavailable.');
    let prepared: Awaited<ReturnType<ManagedShellCapturePublisher['prepare']>>;
    try {
      this.capturePreparationStarted = true;
      prepared = await this.capturePublisher.prepare({ reference, capture });
    } catch (cause) {
      throw new ManagedToolUnavailableError(
        cause instanceof Error ? cause.message : String(cause),
      );
    }
    if (this.entries.has(reference.callId)) return this.executeV3(request);
    this.assertLegacySession(reference.sessionId);
    if (!this.isAdmissionOpen || tools.isActive?.() === false) {
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

  /**
   * H3 background Shell (v3): admission shares the foreground parameter and
   * directory gates, the supervised process starts under its named cgroup
   * unit, and the call settles with the durable handle while the registry
   * keeps the Runtime hold. A refusal before any effect settles as an
   * ordinary error result; it is never a transport error.
   */
  private async executeV3Background(
    request: LocalShellCaptureRequest & {
      readonly toolName: string;
      readonly input: Record<string, unknown>;
    },
    tools: ManagedToolSet,
    normalized: Record<string, unknown>,
  ): Promise<ManagedToolV3View> {
    const { reference, capture, input } = request;
    // The dispatch journal leads every effect: a repeat of this callId joins
    // it exactly like the foreground path, before any process exists.
    if (this.entries.has(reference.callId)) return this.executeV3(request);
    const entry: JournalEntry = {
      version: 3,
      reference,
      toolName: request.toolName,
      input,
      inputJson: JSON.stringify(input),
      v3Capture: capture,
      state: 'prepared',
      lastSequence: 0,
      controller: new AbortController(),
    };
    this.entries.set(reference.callId, entry);
    const settle = (result: ToolResultEnvelope): ManagedToolV3View => {
      entry.v3Result = result;
      entry.state = 'settled';
      entry.lastSequence = 1;
      this.entries.set(reference.callId, entry);
      return v3View(entry);
    };
    if (!this.backgroundSupervisor) {
      return settle({
        executionStatus: 'not_started',
        responseParts: [],
        capture: null,
        error: {
          message:
            'Background Shell requires a delegated Linux cgroup v2 root on this Runtime.',
          type: 'managed_isolation_root_missing',
        },
      });
    }
    let directory: string;
    const requestedDirectory = normalized['directory'];
    if (typeof requestedDirectory === 'string' && requestedDirectory !== '') {
      if (!tools.admitsDirectory(requestedDirectory)) {
        return settle({
          executionStatus: 'not_started',
          responseParts: [],
          capture: null,
          error: {
            message: `Directory '${requestedDirectory}' is not within any of the registered workspace directories.`,
          },
        });
      }
      directory = requestedDirectory;
    } else if (tools.directory !== undefined) {
      directory = tools.directory;
    } else {
      return settle({
        executionStatus: 'not_started',
        responseParts: [],
        capture: null,
        error: {
          message: 'Managed Runtime Session has no workspace directory.',
        },
      });
    }
    const command = normalized['command'];
    if (typeof command !== 'string' || !command.trim()) {
      return settle({
        executionStatus: 'not_started',
        responseParts: [],
        capture: null,
        error: { message: 'Hosted Shell requires a nonempty command.' },
      });
    }
    if (
      this.backgroundRegistry.countBySession(reference.sessionId) >=
      MANAGED_BACKGROUND_MAX_SHELLS
    ) {
      return settle({
        executionStatus: 'not_started',
        responseParts: [],
        capture: null,
        error: {
          message: `Session already runs ${MANAGED_BACKGROUND_MAX_SHELLS} background Shells.`,
        },
      });
    }
    let prepared: Awaited<ReturnType<ManagedShellCapturePublisher['prepare']>>;
    try {
      prepared = await this.capturePublisher!.prepare({
        reference,
        capture: { ...capture, background: true },
      });
    } catch (cause) {
      // A refusal before any effect settles as an ordinary result, never a
      // transport error: parking the entry here would hold the Session's
      // Runtime forever and wedge its close.
      return settle({
        executionStatus: 'not_started',
        responseParts: [],
        capture: null,
        error: {
          message: `Background Shell capture could not be prepared: ${cause instanceof Error ? cause.message : String(cause)}`,
        },
      });
    }
    if (this.closing || tools.isActive?.() === false) {
      return settle({
        executionStatus: 'not_started',
        responseParts: [],
        capture: null,
        error: {
          message: 'Managed Runtime worker is no longer active.',
        },
      });
    }
    const sink = prepared.sink;
    const publisher = prepared.publisher ?? this.capturePublisher!;
    const unitName = `qwen-bg-${reference.callId.replace(/[^a-zA-Z0-9._-]/g, '-')}`;
    const shellConfig = getShellConfiguration();
    let process: ManagedChildRunProcess | undefined;
    let bufferedBytes = 0;
    let paused = false;
    const applyPause = (next: boolean) => {
      paused = next;
      const child = process?.child;
      if (!child) return;
      for (const stream of [child.stdout, child.stderr]) {
        if (!stream) continue;
        if (next) {
          if (!stream.isPaused()) stream.pause();
        } else if (stream.isPaused()) {
          stream.resume();
        }
      }
    };
    try {
      process = await this.backgroundSupervisor.start({
        unitName,
        executable: shellConfig.executable,
        args: [...shellConfig.argsPrefix, command],
        env: backgroundEnv(tools.sessionId),
        cwd: directory,
        onOutput: (stream, chunk) => {
          bufferedBytes += chunk.byteLength;
          // flushStdio resumes the paused pipes when the launcher exits;
          // re-assert the pause behind every delivered chunk so a writer
          // that outlives its launcher never balloons the queue (R5 G5).
          if (paused) applyPause(true);
          const written = sink.write(stream, chunk);
          void written.then(
            () => {
              bufferedBytes -= chunk.byteLength;
              if (
                paused &&
                bufferedBytes <= MANAGED_BACKGROUND_OUTPUT_RESUME_BYTES
              )
                applyPause(false);
            },
            () => {
              bufferedBytes -= chunk.byteLength;
              if (
                paused &&
                bufferedBytes <= MANAGED_BACKGROUND_OUTPUT_RESUME_BYTES
              )
                applyPause(false);
            },
          );
          if (!paused && bufferedBytes >= MANAGED_BACKGROUND_OUTPUT_PAUSE_BYTES)
            applyPause(true);
        },
      });
    } catch (cause) {
      return settle({
        executionStatus: 'not_started',
        responseParts: [],
        capture: null,
        error:
          cause instanceof HookCommandIsolationUnavailableError
            ? isolationRefusal('Background Shell', cause)
            : {
                message: `Background Shell could not start: ${cause instanceof Error ? cause.message : String(cause)}`,
              },
      });
    }
    sink.setStarted(process.child.pid ?? 0);
    if (paused) applyPause(true);
    this.backgroundRegistry.register({
      unitName,
      sessionId: reference.sessionId,
      process,
      sink,
      publisher,
      identity: prepared.identity,
    });
    return settle({
      executionStatus: 'success',
      responseParts: [
        {
          text: `Background shell started under unit ${unitName}. It keeps running after this result and holds its Runtime until it exits; read its status and output through the task surface.`,
        },
      ],
      // The handle owns no capture: the live output streams through the
      // child_run record's output manifest instead, and the exit facts
      // settle there, with the same physical evidence.
      capture: {
        captureStatus: 'detached',
        captureReason: null,
        manifest: null,
        previewTruncated: false,
        deliveryStatus: 'pending',
      },
    });
  }

  /**
   * H3 Monitor watch (v3): the mirror of the background Shell admission —
   * journaled first, the supervised watch spawns under its own cgroup
   * unit inside the Session's four-watch quota, its stdout rides the same
   * bounded capture family, and the call settles with its durable handle
   * while the registry keeps the Runtime hold. Refusals before any effect
   * settle as ordinary error results, never as transport errors.
   */
  private async executeV3Monitor(
    request: LocalShellCaptureRequest & {
      readonly toolName: string;
      readonly input: Record<string, unknown>;
    },
    tools: ManagedToolSet,
    normalized: Record<string, unknown>,
  ): Promise<ManagedToolV3View> {
    const { reference, capture, input } = request;
    if (this.entries.has(reference.callId)) return this.executeV3(request);
    const entry: JournalEntry = {
      version: 3,
      reference,
      toolName: request.toolName,
      input,
      inputJson: JSON.stringify(input),
      v3Capture: capture,
      state: 'prepared',
      lastSequence: 0,
      controller: new AbortController(),
    };
    this.entries.set(reference.callId, entry);
    const settle = (result: ToolResultEnvelope): ManagedToolV3View => {
      entry.v3Result = result;
      entry.state = 'settled';
      entry.lastSequence = 1;
      this.entries.set(reference.callId, entry);
      return v3View(entry);
    };
    if (this.monitorWatcher === undefined) {
      return settle({
        executionStatus: 'not_started',
        responseParts: [],
        capture: null,
        error: {
          message:
            'Monitor watch requires a delegated Linux cgroup v2 root on this Runtime.',
          type: 'managed_isolation_root_missing',
        },
      });
    }
    const command = normalized['command'];
    if (typeof command !== 'string' || !command.trim()) {
      return settle({
        executionStatus: 'not_started',
        responseParts: [],
        capture: null,
        error: { message: 'Monitor watch requires a nonempty command.' },
      });
    }
    if (this.capturePublisher === undefined) {
      return settle({
        executionStatus: 'not_started',
        responseParts: [],
        capture: null,
        error: { message: 'Monitor watch capture is unavailable.' },
      });
    }
    if (
      this.monitorRegistry.countBySession(reference.sessionId) >=
      MANAGED_MONITOR_MAX_WATCHES
    ) {
      return settle({
        executionStatus: 'not_started',
        responseParts: [],
        capture: null,
        error: {
          message: `Session already runs ${MANAGED_MONITOR_MAX_WATCHES} Monitor watches.`,
        },
      });
    }
    // Directory admission before any side effect: a refused watch is a
    // plain not_started answer, never an attached capture abandoned by the
    // refusal.
    let directory = tools.directory;
    if (
      typeof normalized['directory'] === 'string' &&
      normalized['directory'] !== ''
    ) {
      if (!tools.admitsDirectory(normalized['directory'])) {
        return settle({
          executionStatus: 'not_started',
          responseParts: [],
          capture: null,
          error: {
            message: `Directory '${normalized['directory']}' is not within any of the registered workspace directories.`,
          },
        });
      }
      directory = normalized['directory'];
    }
    let prepared: Awaited<ReturnType<ManagedShellCapturePublisher['prepare']>>;
    try {
      prepared = await this.capturePublisher.prepare({
        reference,
        capture: { ...capture, background: true, monitoring: true },
      });
    } catch (cause) {
      return settle({
        executionStatus: 'not_started',
        responseParts: [],
        capture: null,
        error: {
          message: `Monitor watch capture could not be prepared: ${cause instanceof Error ? cause.message : String(cause)}`,
        },
      });
    }
    if (this.closing || tools.isActive?.() === false) {
      return settle({
        executionStatus: 'not_started',
        responseParts: [],
        capture: null,
        error: {
          message: 'Managed Runtime worker is no longer active.',
        },
      });
    }
    const sink = prepared.sink;
    const publisher = prepared.publisher ?? this.capturePublisher;
    const unitName = `qwen-mon-${reference.callId.replace(/[^a-zA-Z0-9._-]/g, '-')}`;
    let watchHandle: Awaited<ReturnType<ManagedMonitorWatcher['start']>>;
    let bufferedBytes = 0;
    let paused = false;
    const applyPause = (next: boolean) => {
      paused = next;
      const child = watchHandle?.process?.child;
      if (!child) return;
      for (const stream of [child.stdout, child.stderr]) {
        if (!stream) continue;
        if (next) {
          if (!stream.isPaused()) stream.pause();
        } else if (stream.isPaused()) {
          stream.resume();
        }
      }
    };
    const acceptChunk = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      bufferedBytes += chunk.byteLength;
      // The launcher-exit flushStdio resumes the paused pipe; re-assert
      // the pause behind every delivered chunk, like the Shell path.
      if (paused) applyPause(true);
      const written = sink.write(stream, chunk);
      const release = () => {
        bufferedBytes -= chunk.byteLength;
        if (paused && bufferedBytes <= MANAGED_BACKGROUND_OUTPUT_RESUME_BYTES)
          applyPause(false);
      };
      void written.then(release, release);
      if (!paused && bufferedBytes >= MANAGED_BACKGROUND_OUTPUT_PAUSE_BYTES)
        applyPause(true);
    };
    try {
      watchHandle = await this.monitorWatcher.start(
        { command },
        (_observationLine) => {
          // Observations ride the remote executor and the hosted fan-out;
          // the durable capture below never goes through a line.
        },
        () => undefined,
        { unitName, cwd: directory, onChunk: acceptChunk },
      );
    } catch (cause) {
      return settle({
        executionStatus: 'not_started',
        responseParts: [],
        capture: null,
        error:
          cause instanceof HookCommandIsolationUnavailableError
            ? isolationRefusal('Monitor watch', cause)
            : {
                message: `Monitor watch could not start: ${cause instanceof Error ? cause.message : String(cause)}`,
              },
      });
    }
    const watchProcess = watchHandle.process;
    if (watchProcess === undefined) {
      return settle({
        executionStatus: 'not_started',
        responseParts: [],
        capture: null,
        error: { message: 'Monitor watch reported no supervised unit.' },
      });
    }
    sink.setStarted(watchProcess.child.pid ?? 0);
    if (paused) applyPause(true);
    this.monitorRegistry.register({
      unitName,
      sessionId: reference.sessionId,
      process: watchProcess,
      sink,
      publisher,
      identity: prepared.identity,
    });
    return settle({
      executionStatus: 'success',
      responseParts: [
        {
          text: `Monitor watch started under unit ${unitName}. It keeps running after this result and holds its Runtime until it exits; read its status and output through the task surface.`,
        },
      ],
      capture: {
        captureStatus: 'detached',
        captureReason: null,
        manifest: null,
        previewTruncated: false,
        deliveryStatus: 'pending',
      },
    });
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
    if (receipt.executionCallId !== entry.v3Capture?.executionCallId) {
      throw new ManagedToolConflictError(
        'Tool result receipt conflicts.',
        'managed_tool_result_conflict',
      );
    }
    // A result that owns no managed capture (a background start handle)
    // acknowledges exactly with a null manifest.
    if (
      actual === null
        ? receipt.manifest !== null
        : JSON.stringify(receipt.manifest) !== JSON.stringify(actual.manifest)
    ) {
      throw new ManagedToolConflictError(
        'Tool result receipt conflicts.',
        'managed_tool_result_conflict',
      );
    }
    if (
      actual !== null &&
      receipt.deliveryStatus === 'committed' &&
      (actual.captureStatus !== 'complete' ||
        !Number.isSafeInteger(receipt.historyRevision) ||
        (receipt.historyRevision ?? 0) < 1)
    ) {
      throw new ManagedToolConflictError(
        'Tool result receipt conflicts.',
        'managed_tool_result_conflict',
      );
    }
    if (
      receipt.deliveryStatus === 'blocked' &&
      receipt.historyRevision !== null
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
      capture:
        actual === null
          ? null
          : {
              captureStatus: actual.captureStatus,
              captureReason: actual.captureReason,
              manifest: actual.manifest,
              previewTruncated: actual.previewTruncated,
              deliveryStatus: receipt.deliveryStatus,
            },
    };
    return v3View(entry);
  }

  acknowledgeOriginalCsi(
    request: ManagedCsiAckRequest,
    boot: ManagedCsiBoot,
    pod: ManagedCsiPodIdentity,
  ): { response: ManagedCsiAckResponse; json: string } {
    const parsed = parseManagedCsiAckRequest(request, boot, pod);
    const entry = this.entries.get(parsed.reference.callId);
    if (
      this.retirementId !== parsed.retirementId ||
      !entry ||
      entry.version !== 3 ||
      !sameReference(entry.reference, parsed.reference) ||
      entry.state !== 'settled' ||
      !entry.v3Result ||
      !['success', 'error', 'cancelled'].includes(
        entry.v3Result.executionStatus,
      ) ||
      entry.v3Result.capture?.captureStatus !== 'complete' ||
      entry.v3Result.capture.deliveryStatus === 'blocked' ||
      !entry.v3Capture ||
      !entry.captureSink
    )
      throw new ManagedCsiAckRequestError(409);
    try {
      const identity = parseManagedCsiCaptureIdentity(
        entry.captureSink.identity,
      );
      if (
        identity.tenantId !== boot.context.tenantId ||
        identity.tenantId !== entry.v3Capture.tenantId ||
        identity.sessionId !== entry.v3Capture.sessionId ||
        identity.turnId !== entry.v3Capture.turnId ||
        identity.executionCallId !== entry.v3Capture.executionCallId ||
        identity.bindingGeneration !== entry.v3Capture.bindingGeneration ||
        identity.callId !== entry.reference.callId ||
        identity.invocationDigest !== entry.reference.argsDigest
      )
        throw new Error();
      const actual = parseManagedCsiAcknowledgement({
        executionCallId: entry.v3Capture.executionCallId,
        manifest: entry.v3Result.capture.manifest,
        deliveryStatus: 'committed',
        historyRevision: parsed.acknowledgement.historyRevision,
      });
      if (
        !isDeepStrictEqual(actual, parsed.acknowledgement) ||
        (entry.acknowledgement &&
          !isDeepStrictEqual(
            parseManagedCsiAcknowledgement(entry.acknowledgement),
            parsed.acknowledgement,
          ))
      )
        throw new Error();
      const response = parseManagedCsiAckResponse(
        { ...parsed, state: 'ACKNOWLEDGED', captureIdentity: identity },
        boot,
        pod,
      );
      const json = JSON.stringify(response);
      if (Buffer.byteLength(json, 'utf8') > MANAGED_CSI_ACK_LIMIT_BYTES)
        throw new Error();
      if (entry.acknowledgement) {
        if (entry.v3Result.capture.deliveryStatus !== 'committed')
          throw new Error();
      } else {
        // Generic v3 retains its original order-sensitive first ACK contract.
        this.acknowledgeV3(entry.reference, {
          ...parsed.acknowledgement,
          manifest: entry.v3Result.capture.manifest,
        });
      }
      return { response, json };
    } catch {
      throw new ManagedCsiAckRequestError(409);
    }
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
      this.backgroundRegistry.hasHolds(sessionId) ||
      this.monitorRegistry.hasHolds(sessionId) ||
      [...this.entries.values()].some(
        (entry) =>
          entry.reference.sessionId === sessionId &&
          entry.state !== 'settled' &&
          entry.state !== 'acknowledged' &&
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

  /**
   * The caller committed the call's outcome in its own durable store: drop
   * the payload this journal holds for it. Only a settled call may be
   * forgotten — an in-flight one's payload is not the caller's yet — and an
   * acknowledged call stays acknowledged. Afterwards `execute` of the same
   * reference no longer matches the entry, so a repeat is refused as an
   * identity conflict.
   */
  acknowledge(
    reference: ManagedToolReference,
  ): ManagedToolInvocationView | null {
    const entry = this.entries.get(reference.callId);
    if (entry && entry.version !== 2) {
      throw new ManagedToolConflictError('Managed Runtime protocol conflicts.');
    }
    if (!entry || !sameReference(entry.reference, reference)) {
      return null;
    }
    if (entry.state !== 'settled') {
      if (entry.state === 'acknowledged') return view(entry);
      throw new ManagedToolConflictError(
        'Managed Runtime tool call has not settled.',
      );
    }
    entry.input = undefined;
    entry.inputJson = undefined;
    entry.result = undefined;
    entry.state = 'acknowledged';
    entry.lastSequence += 1;
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
      ...this.pendingStarts,
      ...[...this.entries.values()].flatMap((entry) =>
        entry.promise ? [entry.promise] : [],
      ),
      this.provider?.close(),
      this.backgroundRegistry.stopAll(5_000),
      this.monitorRegistry.stopAll(5_000),
    ]);
  }

  /**
   * Ordered close of one Session's background Shells and Monitor watches,
   * bounded per drain. The activation release gate calls this before
   * refusing, so a close that can prove its stops never wedges on holds
   * that ended.
   */
  async stopBackgroundSession(sessionId: string): Promise<void> {
    await Promise.all([
      this.backgroundRegistry.stopSession(sessionId, 5_000),
      this.monitorRegistry.stopSession(sessionId, 5_000),
    ]);
  }

  private trackStart<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing) {
      return Promise.reject(
        new ManagedToolUnavailableError('Managed Runtime worker is closing.'),
      );
    }
    const pending = action();
    this.pendingStarts.add(pending);
    void pending.then(
      () => this.pendingStarts.delete(pending),
      () => this.pendingStarts.delete(pending),
    );
    return pending;
  }

  private assertAdmissionOpen(): void {
    if (!this.isAdmissionOpen)
      throw new ManagedToolUnavailableError(
        'Managed Runtime admission is sealed.',
      );
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
    let invocationStarted = false;
    try {
      // Runs start only from a fresh journal entry, which still carries its
      // input; only an acknowledged entry loses it, and nothing runs that.
      const params = structuredClone(entry.input!);
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
      const invoke = () => {
        this.assertAdmissionOpen();
        return sessionIdContext.run(sessionId, () => {
          const invocation = tool.build(params);
          invocationStarted = true;
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
      };
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
        executionStatus:
          !invocationStarted &&
          this.isAdmissionSealed &&
          error instanceof ManagedToolUnavailableError
            ? 'not_started'
            : ManagedToolExecutor.isCancelRequested(entry)
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

function backgroundEnv(sessionId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    // The session context every managed command in this Runtime receives,
    // resolved for this call's session: the worker serves many, no session
    // context runs on the v3 path, and the process-global slot only ever
    // reflects the first session created in this process.
    ...sessionIdContext.run(sessionId, getShellContextEnvVars),
  };
  for (const key of [
    'PATH',
    'HOME',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'USER',
    'SHELL',
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
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
  // An acknowledged entry holds no encoded input, so it matches nothing: a
  // repeat of its reference is a conflict, as the design refuses re-dispatch.
  return (
    entry.inputJson !== undefined &&
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
