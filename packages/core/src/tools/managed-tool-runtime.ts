/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { canUseRipgrep } from '../utils/ripgrepUtils.js';
import { deriveConfig, type Config } from '../config/config.js';
import {
  firePreToolUseHook,
  firePostToolUseHook,
  firePostToolUseFailureHook,
  generateToolUseId,
  type PreToolUseHookResult,
  type PostToolUseHookResult,
  type PostToolUseFailureHookResult,
} from '../core/toolHookTriggers.js';
import { promptIdContext } from '../utils/promptIdContext.js';
import { runWithInvocationContext } from '../utils/invocation-context.js';
import {
  ToolConfirmationOutcome,
  type AnyDeclarativeTool,
  type AnyToolInvocation,
  type ToolCallConfirmationDetails,
  type ToolConfirmationPayload,
  type ToolResult,
  type ToolResultDisplay,
} from './tools.js';
import { ToolNames } from './tool-names.js';
import { isModifiableDeclarativeTool } from './modifiable-tool.js';
import { ToolErrorType } from './tool-error.js';
import {
  managedToolDigest,
  parseManagedToolContentModification,
  parseManagedToolMediaContext,
  type ManagedToolMediaContext,
  type ManagedToolContentModification,
  serializeManagedToolConfirmation,
  type ManagedToolCallIdentity,
  type ManagedToolInvocationReference,
  type ManagedToolPrepareResponse,
  type ManagedToolDescriptor,
} from './managed-tool-protocol.js';

import type { ManagedToolFileHistoryClient } from './managed-tool-file-history-protocol.js';

function invocationParams(params: unknown): Record<string, unknown> {
  // Native tools add optional undefined fields; hash the same JSON sent on the wire.
  const projected = JSON.parse(JSON.stringify(params)) as Record<
    string,
    unknown
  >;
  managedToolDigest(projected);
  return projected;
}

export type ManagedToolConfirmationPhase = 'permission' | 'preflight';

export type ManagedToolV2Client = {
  [K in
    | 'manifest'
    | 'beginTurn'
    | 'prepare'
    | 'confirmation'
    | 'confirm'
    | 'preflight'
    | 'execute'
    | 'status'
    | 'cancel']: (
    ...args: Parameters<ManagedToolRuntime[K]>
  ) => Promise<Awaited<ReturnType<ManagedToolRuntime[K]>>>;
} & {
  fileHistory?: ManagedToolFileHistoryClient;
  prepareExecution?: (
    reference: ManagedToolInvocationReference,
  ) => Promise<ManagedToolExecutionReservation>;
  startExecution?: (
    reference: ManagedToolInvocationReference,
    executionCallId: string,
  ) => Promise<ManagedToolExecutionResult>;
};

export interface ManagedToolExecutionReservation {
  executionCallId: string;
  invocationBindingId: string;
}

export interface ManagedToolExecutionResult {
  executionStatus: 'not_started' | 'success' | 'error' | 'cancelled';
  result?: ToolResult;
  error?: { message: string; type?: ToolErrorType };
  postHook?: PostToolUseHookResult;
  failureHook?: PostToolUseFailureHookResult;
}

export interface ManagedToolRuntimeFileHistory {
  prepareTurn(identity: ManagedToolCallIdentity): Promise<void>;
  execute(
    operation: () => Promise<ManagedToolExecutionResult>,
  ): Promise<ManagedToolExecutionResult>;
}

export interface ManagedToolProgress {
  seq: number;
  output: ToolResultDisplay;
}

export interface ManagedToolInvocationStatus {
  state: 'prepared' | 'executing' | 'cancel_requested' | 'settled';
  cancelRequested: boolean;
  lastSeq: number;
  firstAvailableSeq: number;
  progressGap: boolean;
  progress: ManagedToolProgress[];
  result?: ManagedToolExecutionResult;
}

interface Decision {
  digest: string;
  promise: Promise<void>;
  settled: boolean;
}

interface CallSlot {
  current?: Entry;
  pending?: Promise<Entry>;
}

interface Entry {
  readonly reference: ManagedToolInvocationReference;
  readonly inputDigest: string;
  readonly tool: AnyDeclarativeTool;
  readonly invocation: AnyToolInvocation;
  readonly controller: AbortController;
  readonly toolUseId: string;
  readonly prepared: ManagedToolPrepareResponse;
  confirmation?: Promise<ToolCallConfirmationDetails>;
  decisions: Map<ManagedToolConfirmationPhase, Decision>;
  preflight?: Promise<PreToolUseHookResult>;
  preflightResult?: PreToolUseHookResult;
  hookConfirmed: boolean;
  execution?: Promise<ManagedToolExecutionResult>;
  cancellation?: Promise<void>;
  result?: ManagedToolExecutionResult;
  progress: Array<ManagedToolProgress & { bytes: number }>;
  progressBytes: number;
  sequence: number;
}

const MAX_INVOCATIONS = 1024;
const MAX_PROGRESS_BYTES = 1024 * 1024;

/** Owned by one Tool-only Session; only the authenticated parent may dispatch. */
export class ManagedToolRuntime {
  private readonly entries = new Map<string, Entry>();
  private readonly calls = new Map<string, CallSlot>();
  private readonly lifetime = new AbortController();
  private activePrompt?: { id: string; snapshot: Promise<void> };
  private pendingBuilds = 0;
  private pendingPreparations = 0;
  private snapshotPending = false;
  private readonly startedPrompts = new Set<string>();
  private disposal?: Promise<void>;

  constructor(
    private readonly config: Config,
    private readonly tools: () => AnyDeclarativeTool[],
    private readonly policyRevision: () => string,
    private readonly sharedFileHistory?: ManagedToolRuntimeFileHistory,
    private readonly bindMediaTool?: (
      tool: AnyDeclarativeTool,
      context: ManagedToolMediaContext,
    ) => AnyDeclarativeTool,
  ) {}

  manifest(): {
    tools: ManagedToolDescriptor[];
    capabilityDigest: string;
    policyRevision: string;
  } {
    this.lifetime.signal.throwIfAborted();
    const tools = this.tools().map(
      (tool): ManagedToolDescriptor => ({
        name: tool.name,
        displayName: tool.displayName,
        description: tool.description,
        kind: tool.kind,
        schema: tool.schema,
        canUpdateOutput: tool.canUpdateOutput,
        isOutputMarkdown: tool.isOutputMarkdown,
        shouldDefer: tool.shouldDefer,
        alwaysLoad: tool.alwaysLoad,
        ...(tool.searchHint === undefined
          ? {}
          : { searchHint: tool.searchHint }),
        ...(tool.maxOutputChars === undefined
          ? {}
          : {
              maxOutputChars:
                tool.maxOutputChars === Infinity
                  ? ('unlimited' as const)
                  : tool.maxOutputChars,
            }),
        truncateKeep: tool.truncateKeep,
      }),
    );
    return {
      tools: structuredClone(tools),
      capabilityDigest: managedToolDigest(tools, 1024 * 1024),
      policyRevision: this.policyRevision(),
    };
  }

  private assertCurrent(identity: ManagedToolCallIdentity): void {
    this.lifetime.signal.throwIfAborted();
    const current = this.manifest();
    if (
      identity.sessionId !== this.config.getSessionId().toLowerCase() ||
      identity.capabilityDigest !== current.capabilityDigest ||
      identity.policyRevision !== current.policyRevision
    )
      throw new Error('Managed tool Session or capability changed.');
  }

  private get(reference: ManagedToolInvocationReference): Entry {
    const entry = this.entries.get(reference.invocationId);
    if (
      !entry ||
      managedToolDigest(reference) !== managedToolDigest(entry.reference)
    ) {
      throw new Error('Managed tool invocation identity does not match.');
    }
    return entry;
  }

  private scoped<T>(identity: ManagedToolCallIdentity, action: () => T): T {
    return promptIdContext.run(identity.promptId, () =>
      runWithInvocationContext(
        {
          version: 1,
          sessionId: identity.sessionId,
          promptId: identity.promptId,
        },
        action,
      ),
    );
  }

  beginTurn(identity: ManagedToolCallIdentity): Promise<void> {
    this.assertCurrent(identity);
    if (this.activePrompt?.id === identity.promptId)
      return this.activePrompt.snapshot;
    if (
      this.snapshotPending ||
      this.pendingPreparations ||
      [...this.entries.values()].some((entry) => !entry.result)
    ) {
      throw new Error(
        'Managed Runtime still owns an unfinished tool invocation.',
      );
    }
    if (this.startedPrompts.has(identity.promptId)) {
      throw new Error('Managed Runtime cannot reopen a previous tool turn.');
    }
    this.entries.clear();
    this.calls.clear();
    identity = structuredClone(identity);
    this.snapshotPending = true;
    this.startedPrompts.add(identity.promptId);
    const snapshot = this.scoped(identity, async () => {
      try {
        if (this.sharedFileHistory) {
          await this.sharedFileHistory.prepareTurn(identity);
        } else {
          await this.config
            .getFileHistoryService()
            .makeSnapshot(identity.promptId);
        }
        this.assertCurrent(identity);
      } finally {
        this.snapshotPending = false;
      }
    });
    this.activePrompt = { id: identity.promptId, snapshot };
    void snapshot.catch(() => {});
    return snapshot;
  }

  prepare(
    identity: ManagedToolCallIdentity,
    toolName: string,
    input: Record<string, unknown>,
    modification?: ManagedToolContentModification,
    mediaContext?: ManagedToolMediaContext,
  ): Promise<ManagedToolPrepareResponse> {
    this.assertCurrent(identity);
    managedToolDigest(input);
    identity = structuredClone(identity);
    const copied = structuredClone(input);
    const media =
      mediaContext === undefined
        ? undefined
        : parseManagedToolMediaContext(mediaContext);
    const contentModification =
      modification === undefined
        ? undefined
        : parseManagedToolContentModification(modification);
    const inputDigest = managedToolDigest(
      {
        identity,
        toolName,
        input: copied,
        ...(media === undefined ? {} : { mediaContext: media }),
        ...(contentModification === undefined
          ? {}
          : { modification: contentModification }),
      },
      1024 * 1024,
    );
    const key = JSON.stringify([identity.promptId, identity.callId]);
    const slot = this.calls.get(key) ?? {};
    const previous = slot.pending;
    this.pendingPreparations++;
    const pending = (async () => {
      // A rejected preparation owns no invocation; queued retries still build.
      await previous?.catch(() => {});
      const entry = slot.current;
      if (entry) {
        if (entry.inputDigest === inputDigest) return entry;
        if (!entry.controller.signal.aborted || entry.execution) {
          throw new Error('Managed tool call already owns another invocation.');
        }
        await entry.cancellation;
      }
      this.assertCurrent(identity);
      if (this.activePrompt?.id !== identity.promptId) {
        throw new Error('Managed Runtime tool turn has not started.');
      }
      if (this.entries.size + this.pendingBuilds >= MAX_INVOCATIONS) {
        throw new Error('Managed tool invocation capacity is exhausted.');
      }
      this.pendingBuilds++;
      try {
        await this.activePrompt.snapshot;
        this.assertCurrent(identity);
        const built = await this.scoped(identity, () =>
          this.build(
            identity,
            toolName,
            copied,
            inputDigest,
            contentModification,
            entry,
            media,
          ),
        );
        slot.current = built;
        return built;
      } finally {
        this.pendingBuilds--;
      }
    })();
    void pending.then(
      () => {
        this.pendingPreparations--;
      },
      () => {
        this.pendingPreparations--;
      },
    );
    slot.pending = pending;
    this.calls.set(key, slot);
    void pending.catch(() => {
      if (slot.pending === pending && !slot.current) this.calls.delete(key);
    });
    return pending.then((entry) => structuredClone(entry.prepared));
  }

  private async build(
    identity: ManagedToolCallIdentity,
    toolName: string,
    input: Record<string, unknown>,
    inputDigest: string,
    modification?: ManagedToolContentModification,
    source?: Entry,
    mediaContext?: ManagedToolMediaContext,
  ): Promise<Entry> {
    let tool = this.tools().find((candidate) => candidate.name === toolName);
    if (!tool) throw new Error('Managed Runtime tool is unavailable.');
    if (mediaContext !== undefined) {
      if (!this.bindMediaTool)
        throw new Error('Managed Runtime tool does not support media context.');
      tool = this.bindMediaTool(tool, mediaContext);
    }
    if (modification) {
      if (
        !source ||
        this.get(modification.source) !== source ||
        source.tool !== tool ||
        tool.name !== ToolNames.NOTEBOOK_EDIT ||
        !isModifiableDeclarativeTool(tool) ||
        !source.controller.signal.aborted ||
        source.execution ||
        managedToolDigest(input) !== source.reference.argsDigest
      )
        throw new Error('Managed content modification source does not match.');
      const details = await source.confirmation;
      if (
        details?.type !== 'edit' ||
        typeof details.originalContent !== 'string'
      )
        throw new Error(
          'Managed content modification requires an edit confirmation.',
        );
      this.assertCurrent(identity);
      input = tool
        .getModifyContext(this.lifetime.signal)
        .createUpdatedParams(
          details.originalContent,
          modification.newContent,
          source.invocation.params,
        ) as Record<string, unknown>;
    }
    const invocation = tool.build(input);
    const aware = invocation as {
      setCallId?: (id: string) => void;
      setPromptId?: (id: string) => void;
    };
    aware.setCallId?.(identity.callId);
    aware.setPromptId?.(identity.promptId);
    const defaultPermission = await invocation.getDefaultPermission();
    this.assertCurrent(identity);
    const reference: ManagedToolInvocationReference = {
      ...identity,
      invocationId: randomUUID(),
      argsDigest: managedToolDigest(invocationParams(invocation.params)),
    };
    const toolUseId = generateToolUseId();
    const entry: Entry = {
      reference,
      inputDigest,
      tool,
      invocation,
      controller: new AbortController(),
      toolUseId,
      prepared: {
        ...reference,
        params: invocationParams(invocation.params),
        description: invocation.getDescription(),
        locations: invocation.toolLocations(),
        defaultPermission,
        requiresUserInteraction:
          invocation.requiresUserInteraction?.() ?? false,
        toolUseId,
      },
      decisions: new Map(),
      hookConfirmed: false,
      progress: [],
      progressBytes: 0,
      sequence: 0,
    };
    this.entries.set(reference.invocationId, entry);
    return entry;
  }

  async confirmation(reference: ManagedToolInvocationReference) {
    const entry = this.get(reference);
    this.assertExecutable(entry);
    entry.confirmation ??= this.scoped(reference, async () => {
      const details = await entry.invocation.getConfirmationDetails(
        entry.controller.signal,
      );
      serializeManagedToolConfirmation(details);
      return details;
    });
    const details = await entry.confirmation;
    this.assertExecutable(entry);
    return serializeManagedToolConfirmation(details);
  }

  async confirm(
    reference: ManagedToolInvocationReference,
    outcome: ToolConfirmationOutcome,
    payload?: ToolConfirmationPayload,
    phase: ManagedToolConfirmationPhase = 'permission',
  ): Promise<void> {
    const entry = this.get(reference);
    reference = entry.reference;
    payload = payload === undefined ? undefined : structuredClone(payload);
    if (phase !== 'permission' && phase !== 'preflight')
      throw new Error('Invalid managed confirmation phase.');
    if (
      !Object.values(ToolConfirmationOutcome).includes(outcome) ||
      outcome === ToolConfirmationOutcome.RestorePrevious
    ) {
      throw new Error('Unsupported managed tool confirmation outcome.');
    }
    const digest = managedToolDigest({
      outcome,
      ...(payload ? { payload } : {}),
    });
    const previous = entry.decisions.get(phase);
    if (previous) {
      if (previous.digest !== digest)
        throw new Error('Managed tool confirmation already decided.');
      return previous.promise;
    }
    this.assertExecutable(entry);
    if (phase === 'permission' && entry.preflight)
      throw new Error('Managed tool preflight already started.');
    if (phase === 'preflight' && entry.preflightResult?.blockType !== 'ask')
      throw new Error('Managed tool preflight did not request confirmation.');
    if (
      payload?.updatedInput !== undefined ||
      payload?.newContent !== undefined ||
      outcome === ToolConfirmationOutcome.ModifyWithEditor
    ) {
      this.cancel(reference);
      throw new Error('Modified tool arguments require a new preparation.');
    }
    const pending = (async () => {
      await this.confirmation(reference);
      this.assertExecutable(entry);
      const details = await entry.confirmation!;
      await this.scoped(reference, () =>
        details.onConfirm(runtimeLocalOutcome(outcome), payload),
      );
      if (outcome === ToolConfirmationOutcome.Cancel) {
        this.requestCancel(entry);
        return;
      }
      this.assertExecutable(entry);
      if (phase === 'preflight') entry.hookConfirmed = true;
    })();
    const decision: Decision = { digest, promise: pending, settled: false };
    entry.decisions.set(phase, decision);
    void pending.then(
      () => {
        decision.settled = true;
      },
      () => {
        decision.settled = true;
      },
    );
    return pending;
  }

  private assertExecutable(entry: Entry): void {
    this.assertCurrent(entry.reference);
    entry.controller.signal.throwIfAborted();
    if (entry.execution)
      throw new Error('Managed tool invocation already dispatched.');
    if (
      managedToolDigest(invocationParams(entry.invocation.params)) !==
      entry.reference.argsDigest
    ) {
      throw new Error('Managed tool parameters changed after preparation.');
    }
  }

  async preflight(
    reference: ManagedToolInvocationReference,
  ): Promise<PreToolUseHookResult> {
    const entry = this.get(reference);
    this.assertExecutable(entry);
    entry.preflight ??= this.scoped(reference, async () => {
      for (const decision of entry.decisions.values()) await decision.promise;
      this.assertExecutable(entry);
      const result = await firePreToolUseHook(
        this.config.getDisableAllHooks()
          ? undefined
          : this.config.getMessageBus(),
        entry.tool.name,
        entry.invocation.params as Record<string, unknown>,
        entry.toolUseId,
        this.config.getApprovalMode(),
        entry.controller.signal,
        entry.reference.callId,
      );
      this.assertExecutable(entry);
      entry.preflightResult = structuredClone(result);
      return result;
    });
    return structuredClone(await entry.preflight);
  }

  /** The private parent calls this only after permission and its final guard. */
  execute(
    reference: ManagedToolInvocationReference,
  ): Promise<ManagedToolExecutionResult> {
    const entry = this.get(reference);
    if (entry.execution)
      return entry.execution.then((result) => structuredClone(result));
    this.assertExecutable(entry);
    const preflight = entry.preflightResult;
    if (
      !preflight ||
      (!preflight.shouldProceed &&
        !(preflight.blockType === 'ask' && entry.hookConfirmed))
    ) {
      throw new Error('Managed tool preflight has not permitted execution.');
    }
    if ([...entry.decisions.values()].some((decision) => !decision.settled)) {
      throw new Error('Managed tool confirmation is still pending.');
    }
    entry.execution = this.scoped(reference, () =>
      this.sharedFileHistory
        ? this.sharedFileHistory.execute(() => this.run(entry))
        : this.run(entry),
    );
    void entry.execution.catch(() => {});
    return entry.execution.then((result) => structuredClone(result));
  }

  private progress(entry: Entry, output: ToolResultDisplay): void {
    const seq = ++entry.sequence;
    const event = { seq, output: structuredClone(output) };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > MAX_PROGRESS_BYTES) {
      entry.progress = [];
      entry.progressBytes = 0;
      return;
    }
    entry.progress.push({ ...event, bytes });
    entry.progressBytes += bytes;
    while (entry.progressBytes > MAX_PROGRESS_BYTES) {
      entry.progressBytes -= entry.progress.shift()!.bytes;
    }
  }

  private async run(entry: Entry): Promise<ManagedToolExecutionResult> {
    const signal = entry.controller.signal;
    const messageBus = this.config.getDisableAllHooks()
      ? undefined
      : this.config.getMessageBus();
    let result: ManagedToolExecutionResult;
    let executionStarted = false;
    try {
      signal.throwIfAborted();
      this.assertCurrent(entry.reference);
      executionStarted = true;
      const raw = await entry.invocation.execute(
        signal,
        (output) => this.progress(entry, output),
        {
          ...this.config.getShellExecutionConfig(),
          requireProcessGroupExit: true,
        },
      );
      result = {
        executionStatus:
          raw.executionStatus ??
          (raw.error ? (signal.aborted ? 'cancelled' : 'error') : 'success'),
      };
      try {
        result.result = structuredClone({
          llmContent: raw.llmContent,
          returnDisplay: raw.returnDisplay,
          ...(raw.error === undefined ? {} : { error: raw.error }),
          ...(raw.resultFilePaths === undefined
            ? {}
            : { resultFilePaths: raw.resultFilePaths }),
          ...(raw.persistedOutputFiles === undefined
            ? {}
            : { persistedOutputFiles: raw.persistedOutputFiles }),
          ...(raw.artifacts === undefined ? {} : { artifacts: raw.artifacts }),
        });
      } catch (error) {
        result.error = {
          message: `Cannot serialize managed tool result: ${String(error)}`,
          type: ToolErrorType.EXECUTION_FAILED,
        };
      }
    } catch (error) {
      result = {
        executionStatus: !executionStarted
          ? 'not_started'
          : signal.aborted
            ? 'cancelled'
            : 'error',
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }
    try {
      if (
        result.executionStatus === 'error' ||
        result.executionStatus === 'cancelled' ||
        result.result?.error !== undefined
      ) {
        result.failureHook = await firePostToolUseFailureHook(
          messageBus,
          entry.toolUseId,
          entry.tool.name,
          entry.invocation.params as Record<string, unknown>,
          result.result?.error?.message ??
            result.error?.message ??
            'Tool execution failed.',
          result.executionStatus === 'cancelled' || signal.aborted,
          this.config.getApprovalMode(),
          undefined,
          entry.reference.callId,
        );
      } else if (result.executionStatus === 'success' && result.result) {
        result.postHook = await firePostToolUseHook(
          messageBus,
          entry.tool.name,
          entry.invocation.params as Record<string, unknown>,
          {
            llmContent: result.result.llmContent,
            returnDisplay: result.result.returnDisplay,
          },
          entry.toolUseId,
          this.config.getApprovalMode(),
          undefined,
          entry.reference.callId,
        );
      }
    } catch (error) {
      const hookError = error instanceof Error ? error.message : String(error);
      if (result.executionStatus === 'success')
        result.postHook = { shouldStop: false, hookError };
      else result.failureHook = { hookError };
    }
    entry.result = structuredClone(result);
    return entry.result;
  }

  status(
    reference: ManagedToolInvocationReference,
    afterSeq = 0,
  ): ManagedToolInvocationStatus {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0)
      throw new Error('Invalid managed tool progress cursor.');
    const entry = this.get(reference);
    const firstAvailableSeq = entry.progress[0]?.seq ?? entry.sequence + 1;
    return {
      state: entry.result
        ? 'settled'
        : entry.controller.signal.aborted
          ? 'cancel_requested'
          : entry.execution
            ? 'executing'
            : 'prepared',
      cancelRequested: entry.controller.signal.aborted,
      lastSeq: entry.sequence,
      firstAvailableSeq,
      progressGap: afterSeq + 1 < firstAvailableSeq,
      progress: structuredClone(
        entry.progress
          .filter((event) => event.seq > afterSeq)
          .map(({ seq, output }) => ({ seq, output })),
      ),
      ...(entry.result ? { result: structuredClone(entry.result) } : {}),
    };
  }

  private requestCancel(entry: Entry): void {
    entry.controller.abort(new Error('Managed tool invocation cancelled.'));
    if (!entry.execution) {
      entry.cancellation ??= (async () => {
        await Promise.allSettled([
          entry.confirmation,
          entry.preflight,
          ...[...entry.decisions.values()].map((decision) => decision.promise),
        ]);
        entry.result = { executionStatus: 'not_started' };
      })();
    }
  }

  cancel(
    reference: ManagedToolInvocationReference,
  ): ManagedToolInvocationStatus {
    const entry = this.get(reference);
    this.requestCancel(entry);
    return this.status(reference);
  }

  hasActiveWork(): boolean {
    return (
      this.snapshotPending ||
      this.pendingPreparations > 0 ||
      [...this.entries.values()].some((entry) => !entry.result)
    );
  }

  seal(): void {
    this.lifetime.abort(new Error('Managed tool Runtime is closed.'));
    for (const entry of this.entries.values()) this.requestCancel(entry);
  }

  dispose(): Promise<void> {
    this.disposal ??= (async () => {
      this.seal();
      await Promise.allSettled([
        ...[...this.calls.values()].map((slot) => slot.pending),
        this.activePrompt?.snapshot,
      ]);
      await Promise.allSettled(
        [...this.entries.values()].flatMap((entry) => [
          entry.confirmation,
          entry.preflight,
          entry.execution,
          entry.cancellation,
          ...[...entry.decisions.values()].map((decision) => decision.promise),
        ]),
      );
      this.entries.clear();
      this.calls.clear();
    })();
    return this.disposal;
  }
}

/**
 * The Harness applies what an "always" choice means to its own Config -- the
 * approval mode, persisted rules -- when it forwards the decision. The Runtime
 * only carries out this one invocation, and its derived tool Config refuses an
 * approval-mode change, so the tool's own callback sees a single approval.
 */
function runtimeLocalOutcome(
  outcome: ToolConfirmationOutcome,
): ToolConfirmationOutcome {
  switch (outcome) {
    case ToolConfirmationOutcome.ProceedAlways:
    case ToolConfirmationOutcome.ProceedAlwaysServer:
    case ToolConfirmationOutcome.ProceedAlwaysTool:
    case ToolConfirmationOutcome.ProceedAlwaysProject:
    case ToolConfirmationOutcome.ProceedAlwaysUser:
      return ToolConfirmationOutcome.ProceedOnce;
    default:
      return outcome;
  }
}

export async function createBuiltinManagedToolRuntime(
  config: Config,
  fileHistory?: ManagedToolRuntimeFileHistory,
  toolConfig: Config = config,
): Promise<ManagedToolRuntime> {
  const [
    { ReadFileTool },
    { WriteFileTool },
    { EditTool },
    { NotebookEditTool },
    { ShellTool },
    { GlobTool },
    { LSTool },
    { GrepTool },
    { RipGrepTool },
    { ZoomImageTool },
  ] = await Promise.all([
    import('./read-file.js'),
    import('./write-file.js'),
    import('./edit.js'),
    import('./notebook-edit.js'),
    import('./shell.js'),
    import('./glob.js'),
    import('./ls.js'),
    import('./grep.js'),
    import('./ripGrep.js'),
    import('./zoom-image.js'),
  ]);
  const registry = config.getToolRegistry();
  await registry.ensureTool(ZoomImageTool.Name);
  if (
    toolConfig !== config &&
    toolConfig.isLsToolEnabled() &&
    !config.isLsToolEnabled() &&
    !registry.getAllToolNames().includes(LSTool.Name)
  ) {
    const permissionManager = config.getPermissionManager();
    if (!permissionManager)
      throw new Error(
        'Managed LS registration requires initialized permissions.',
      );
    const status = await permissionManager.getToolRegistrationStatus(
      LSTool.Name,
    );
    if (
      status !== 'disabled' &&
      !registry.getAllToolNames().includes(LSTool.Name)
    ) {
      const factory = async () => new LSTool(config);
      if (status === 'deferred')
        registry.registerPermissionDeferredFactory(LSTool.Name, factory);
      else registry.registerFactory(LSTool.Name, factory);
      await registry.ensureTool(LSTool.Name);
    }
  }
  const constructors = [
    ReadFileTool,
    WriteFileTool,
    EditTool,
    NotebookEditTool,
    ShellTool,
    GlobTool,
    LSTool,
    ZoomImageTool,
  ].filter(
    (Constructor) => Constructor !== LSTool || toolConfig.isLsToolEnabled(),
  );
  const revision = randomUUID();
  const admittedGrep = registry.getTool(GrepTool.Name);
  let grep: AnyDeclarativeTool | undefined;
  if (
    admittedGrep?.constructor === GrepTool ||
    admittedGrep?.constructor === RipGrepTool
  ) {
    let useRipgrep = false;
    if (toolConfig.getUseRipgrep()) {
      try {
        useRipgrep = await canUseRipgrep(toolConfig.getUseBuiltinRipgrep(), {
          requireProcessGroupExit: true,
          cwd: toolConfig.getTargetDir(),
        });
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code ===
          'ERR_OWNED_COMMAND_UNSUPPORTED'
        )
          throw error;
      }
    }
    grep = useRipgrep ? new RipGrepTool(toolConfig) : new GrepTool(toolConfig);
  }
  const boundTools =
    toolConfig === config
      ? undefined
      : constructors.flatMap((Constructor): AnyDeclarativeTool[] => {
          const tool = config.getToolRegistry().getTool(Constructor.Name);
          return tool?.constructor === Constructor
            ? [new Constructor(toolConfig)]
            : [];
        });
  return new ManagedToolRuntime(
    toolConfig,
    () => [
      ...(boundTools?.filter(
        (tool) =>
          config.getToolRegistry().getTool(tool.name)?.constructor ===
          tool.constructor,
      ) ??
        constructors.flatMap((Constructor): AnyDeclarativeTool[] => {
          const tool = config.getToolRegistry().getTool(Constructor.Name);
          return tool?.constructor === Constructor ? [tool] : [];
        })),
      ...(grep &&
      config.getToolRegistry().getTool(GrepTool.Name) === admittedGrep
        ? [grep]
        : []),
    ],
    () => revision,
    fileHistory,
    (tool, context) => {
      const Constructor = [ReadFileTool, ZoomImageTool].find(
        (candidate) => tool.constructor === candidate,
      );
      if (!Constructor) {
        throw new Error('Managed Runtime tool does not support media context.');
      }
      const view = deriveConfig(toolConfig, {
        getEffectiveInputModalities: () => ({ ...context.inputModalities }),
        getFileReadCache: () => toolConfig.getFileReadCache(),
        getFileService: () => toolConfig.getFileService(),
      });
      return new Constructor(view);
    },
  );
}
