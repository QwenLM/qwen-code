/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Client,
  type ContentBlock,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type ToolCall,
  type ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import {
  AgentEventEmitter,
  AgentEventType,
  AgentTerminateMode,
  ToolConfirmationOutcome,
  renderSubagentSystemPrompt,
  type AgentExternalInput,
  type AgentStatsSummary,
  type ContextState,
  type ExternalAgentExecutor,
  type ExternalAgentExecutorParams,
  type SubagentExecutor,
  type SubagentExecutorCore,
} from '@qwen-code/qwen-code-core/subagentRuntime';
import { InputFormat, sanitizeChildEnv } from '@qwen-code/qwen-code-core';
import { createStderrForwarder } from '@qwen-code/acp-bridge/spawnChannel';
import {
  ProcessRegistry,
  type TrackedChildProcess,
} from '@qwen-code/acp-bridge/processRegistry';

const INIT_TIMEOUT_MS = 10_000;

export function externalModelLabel(command: string): string {
  return `external-acp:${command.split(/[\\/]/).pop() ?? command}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolvePermissionMode(
  permissionMode: string | undefined,
  approvalMode: string | undefined,
): string {
  switch ((approvalMode ?? permissionMode ?? '').trim().toLowerCase()) {
    case 'auto':
    case 'yolo':
      return 'auto';
    case 'acceptedits':
    case 'auto-edit':
      return 'acceptEdits';
    case 'plan':
      return 'plan';
    case 'bypasspermissions':
    case 'bypass':
      return 'bypassPermissions';
    default:
      return 'default';
  }
}

export function optionKindForOutcome(
  outcome: ToolConfirmationOutcome,
): 'allow_once' | 'allow_always' | 'reject_once' {
  switch (outcome) {
    case ToolConfirmationOutcome.ProceedOnce:
    case ToolConfirmationOutcome.ProceedOnceAndSwitchToDefault:
      return 'allow_once';
    case ToolConfirmationOutcome.ProceedAlways:
    case ToolConfirmationOutcome.ProceedAlwaysServer:
    case ToolConfirmationOutcome.ProceedAlwaysTool:
    case ToolConfirmationOutcome.ProceedAlwaysProject:
    case ToolConfirmationOutcome.ProceedAlwaysUser:
      return 'allow_always';
    case ToolConfirmationOutcome.ModifyWithEditor:
    case ToolConfirmationOutcome.Cancel:
    case ToolConfirmationOutcome.RestorePrevious:
      return 'reject_once';
    default: {
      const exhaustive: never = outcome;
      void exhaustive;
      return 'reject_once';
    }
  }
}

export function selectPermissionOption(
  options: ReadonlyArray<{ optionId: string; kind: unknown }>,
  outcome: ToolConfirmationOutcome,
): string | undefined {
  if (outcome === ToolConfirmationOutcome.Cancel) return undefined;
  // An ambiguous option ID could turn a selected rejection into a grant.
  if (
    new Set(options.map((option) => option.optionId)).size !== options.length
  ) {
    return undefined;
  }
  const kind = optionKindForOutcome(outcome);
  return (
    options.find((option) => option.kind === kind) ??
    (kind === 'allow_always'
      ? options.find((option) => option.kind === 'allow_once')
      : undefined) ??
    options.find((option) => option.kind === 'reject_once') ??
    options.find((option) => option.kind === 'reject_always')
  )?.optionId;
}

/**
 * Picks the option that denies a single tool call without ending the turn. A
 * host-policy denial (no responder, headless, permission-avoidance, a routed
 * interactive question) must reject the TOOL, not cancel the TURN: ACP defines
 * the `cancelled` outcome as "the prompt turn was cancelled", so answering a
 * policy denial with it would abort the whole delegation on its first sensitive
 * tool instead of letting the peer continue without that one action — which is
 * what the in-process auto-deny path does. Prefers `reject_once` (deny this
 * call) over `reject_always` (deny for the session) to keep the scope narrow,
 * and returns undefined when no reject option is safely selectable so the caller
 * falls back to `cancelled` rather than guessing.
 */
export function selectRejectOption(
  options: ReadonlyArray<{ optionId: string; kind: unknown }>,
): string | undefined {
  // An ambiguous option ID could turn a denial into the wrong selection.
  if (
    new Set(options.map((option) => option.optionId)).size !== options.length
  ) {
    return undefined;
  }
  return (
    options.find((option) => option.kind === 'reject_once') ??
    options.find((option) => option.kind === 'reject_always')
  )?.optionId;
}

/**
 * Errors the ACP process registry raises when disposing a foreign child whose
 * process tree is already gone. acp-bridge raises both shapes only AFTER it has
 * driven every owned process group to empty, so neither is a cleanup failure —
 * they report that a foreign agent we do not own exited, which `terminateMode`
 * has already classified. Two shapes are expected here:
 *
 *  - the root exited on its own during the initial tree snapshot, invalidating
 *    the snapshot that would enumerate descendants (a Linux-only race where the
 *    prompt rejects on stdout EOF before the process `exit` event); and
 *  - `exited uncleanly during shutdown (code=…, signal=…)` for ANY code/signal —
 *    the peer's own exit status (a non-zero code from an uncaught exception, an
 *    OOM kill, a wrapper turning SIGTERM into 143, or the signal we sent). This
 *    is thrown only once `survivingGroups` is empty, i.e. cleanup succeeded.
 *
 * Tolerating the peer's exit status matters: `dispose()` is awaited inside
 * `runTurn`'s catch between error classification and the return, so letting it
 * reject here would replace the turn's declared terminal state — a turn the user
 * CANCELLED would surface to the parent as `failed` with the registry's text.
 *
 * Every genuine cleanup-PROOF error still propagates — a truncated snapshot, a
 * root that was absent or was not an isolated process-group leader, a failed
 * snapshot/signal/inspect, or an exit deadline exceeded — so a descendant we were
 * responsible for cannot survive disposal silently.
 */
export function isExpectedExternalAgentCleanupExit(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    /^ACP child pid=\d+ exited before its initial process-tree snapshot completed$/.test(
      error.message,
    ) ||
    /^ACP child pid=\d+ exited uncleanly during shutdown \(code=[^,]+, signal=[^)]+\)$/.test(
      error.message,
    )
  );
}

/**
 * Thrown by `wait()` when an operation exceeds its deadline. A dedicated type
 * lets `runTurn` classify a wall-time expiry by identity instead of re-deriving
 * it from a second `Date.now()` read: the timer fires on libuv's monotonic clock
 * against a `remaining` budget computed earlier, so comparing realtime elapsed
 * with a 1ms-exact `>=` misclassifies a turn that merely reached its budget as
 * ERROR whenever the timer wins by under a millisecond.
 */
class ExternalAgentTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`External ACP operation timed out after ${timeoutMs}ms`);
    this.name = 'ExternalAgentTimeoutError';
  }
}

class AcpSubagentExecutor implements SubagentExecutor {
  private connection!: ClientSideConnection;
  private sessionId = '';
  private finalText = '';
  private thoughtText = '';
  private terminateMode = AgentTerminateMode.ERROR;
  private round = 0;
  private durationMs = 0;
  private turnStartedAt = 0;
  private toolCalls = 0;
  private toolSucceeded = 0;
  private toolFailed = 0;
  private executing = false;
  private started = false;
  private disposed = false;
  private cancelled = false;
  private disposePromise?: Promise<void>;
  private provider?: () => AgentExternalInput[];
  private readonly pendingPermissions = new Map<string, () => void>();
  private readonly tools = new Map<string, ToolCall>();
  private readonly toolNames = new Map<string, string>();
  private readonly finishedTools = new Set<string>();
  private readonly failure = new AbortController();
  private readonly coreView: SubagentExecutorCore;

  private constructor(
    private readonly params: ExternalAgentExecutorParams,
    private readonly child: TrackedChildProcess,
    private readonly emitter: AgentEventEmitter,
  ) {
    this.coreView = {
      getEventEmitter: () => emitter,
      modelConfig: {
        ...params.modelConfig,
        model: externalModelLabel(params.spec.command),
      },
    };
    void child.exited.then(
      () => this.fail(new Error(`external agent "${params.name}" exited`)),
      (error: unknown) => this.fail(error),
    );
  }

  static async create(
    params: ExternalAgentExecutorParams,
  ): Promise<AcpSubagentExecutor> {
    if (params.runConfig.max_turns !== undefined) {
      throw new Error('External ACP agents cannot enforce max_turns.');
    }
    const minutes = params.runConfig.max_time_minutes;
    if (
      minutes !== undefined &&
      (!Number.isFinite(minutes) ||
        minutes <= 0 ||
        minutes * 60_000 > 2_147_483_647)
    ) {
      throw new Error(
        'External ACP max_time_minutes must be positive, finite, and within the Node timer range.',
      );
    }
    const child = spawn(params.spec.command, params.spec.args ?? [], {
      cwd: params.runtimeContext.getTargetDir(),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
      env: sanitizeChildEnv(process.env),
    });
    const tracked = new ProcessRegistry()
      .reserve()
      .attach(child, { ownsProcessTree: true });
    const executor = new AcpSubagentExecutor(
      params,
      tracked,
      params.eventEmitter ?? new AgentEventEmitter(),
    );
    child.on('error', (error) => executor.fail(error));
    child.stdin!.on('error', (error) => executor.fail(error));
    child.stdout!.on('error', (error) => executor.fail(error));
    const forwarder = createStderrForwarder({
      prefix: `[external-agent ${params.name}] `,
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', forwarder.onData);
    child.stderr!.on('end', forwarder.onEnd);
    child.stderr!.on('error', () => {});
    try {
      executor.connection = new ClientSideConnection(
        () => executor.buildClient(),
        ndJsonStream(
          Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
        ),
      );
      void executor.connection.closed.then(() =>
        executor.fail(new Error('External ACP connection closed')),
      );
      await executor.wait(executor.connect(), INIT_TIMEOUT_MS);
      return executor;
    } catch (error) {
      await executor.dispose();
      throw error;
    }
  }

  private buildClient(): Client {
    return {
      sessionUpdate: async (params) => this.onSessionUpdate(params),
      requestPermission: (params) => this.onRequestPermission(params),
      readTextFile: async () => {
        throw RequestError.methodNotFound('fs/read_text_file');
      },
      writeTextFile: async () => {
        throw RequestError.methodNotFound('fs/write_text_file');
      },
      extMethod: async (method) => {
        throw RequestError.methodNotFound(method);
      },
      extNotification: async () => {},
    };
  }

  private async connect(): Promise<void> {
    const initialized = await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    if (initialized.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error('Unsupported external ACP protocol version');
    }
    const session = await this.connection.newSession({
      cwd: this.params.runtimeContext.getTargetDir(),
      mcpServers: [],
    });
    if (!session.sessionId)
      throw new Error('External ACP agent returned no sessionId');
    this.sessionId = session.sessionId;
    const modeId = resolvePermissionMode(
      this.params.permissionMode,
      this.params.approvalMode,
    );
    if (
      !session.modes?.availableModes.some(
        (mode: { id: string }) => mode.id === modeId,
      )
    ) {
      throw new Error(
        `External ACP agent does not advertise permission mode ${modeId}`,
      );
    }
    await this.connection.setSessionMode({ sessionId: this.sessionId, modeId });
  }

  private fail(error: unknown): void {
    this.failure.abort(error);
    this.drainPermissions();
  }

  private async wait<T>(
    operation: Promise<T>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onFailure = () => {};
    let onAbort = () => {};
    const stopped = new Promise<never>((_resolve, reject) => {
      onFailure = () => reject(this.failure.signal.reason);
      onAbort = () =>
        reject(signal?.reason ?? new Error('External agent cancelled'));
      this.failure.signal.addEventListener('abort', onFailure, { once: true });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (this.failure.signal.aborted) onFailure();
      if (signal?.aborted) onAbort();
      if (timeoutMs !== undefined) {
        timer = setTimeout(
          () => reject(new ExternalAgentTimeoutError(timeoutMs)),
          timeoutMs,
        );
      }
    });
    try {
      return await Promise.race([operation, stopped]);
    } finally {
      clearTimeout(timer);
      this.failure.signal.removeEventListener('abort', onFailure);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async execute(
    context: ContextState,
    signal?: AbortSignal,
    options: { resetStats?: boolean } = {},
  ): Promise<void> {
    if (context.get('initial_messages_override') !== undefined) {
      throw new Error(
        'External ACP agents cannot import in-process conversation history',
      );
    }
    const system = renderSubagentSystemPrompt(
      this.params.promptConfig,
      context,
      this.params.runtimeContext,
    );
    const task = String(context.get('task_prompt') ?? 'Get Started!');
    // The first turn's task is seeded into the transcript as the initial user
    // prompt by the dispatcher; a continuation turn (a resident external agent
    // re-invoked per incoming user message) has no such seed, so emit the task
    // as a user-side record here or the JSONL transcript loses every message
    // after the first — the in-process sibling emits the same EXTERNAL_MESSAGE
    // on continuation.
    const continuation = this.started;
    await this.runTurn(
      [
        ...(system ? [{ type: 'text' as const, text: system }] : []),
        { type: 'text', text: task },
      ],
      signal,
      options,
      continuation ? [task] : undefined,
    );
  }

  async executeExternalInputs(
    inputs: AgentExternalInput[],
    signal?: AbortSignal,
    options: { resetStats?: boolean } = {},
  ): Promise<void> {
    if (inputs.length === 0) return;
    await this.runTurn(this.inputPrompt(inputs), signal, options, inputs);
  }

  private inputPrompt(inputs: AgentExternalInput[]): ContentBlock[] {
    return inputs.map((input) => ({
      type: 'text',
      text: typeof input === 'string' ? input : input.text,
    }));
  }

  private emitInputs(inputs: AgentExternalInput[]): void {
    for (const input of inputs) {
      this.emitter.emit(AgentEventType.EXTERNAL_MESSAGE, {
        subagentId: this.id,
        kind: typeof input === 'string' ? 'message' : input.kind,
        text: typeof input === 'string' ? input : input.text,
        timestamp: Date.now(),
      });
    }
  }

  private async runTurn(
    prompt: ContentBlock[],
    signal?: AbortSignal,
    options: { resetStats?: boolean } = {},
    inputs?: AgentExternalInput[],
  ): Promise<void> {
    if (this.executing)
      throw new Error('External ACP agents do not support concurrent turns');
    if (this.disposed || this.failure.signal.aborted)
      throw new Error('External ACP agent is closed');
    this.executing = true;
    this.started = true;
    this.cancelled = false;
    this.finalText = '';
    this.thoughtText = '';
    this.terminateMode = AgentTerminateMode.ERROR;
    if (options.resetStats !== false) {
      this.round =
        this.durationMs =
        this.toolCalls =
        this.toolSucceeded =
        this.toolFailed =
          0;
    }
    this.tools.clear();
    this.toolNames.clear();
    this.finishedTools.clear();
    this.turnStartedAt = Date.now();
    // Match DEFAULT_WORKFLOW_SUBAGENT_MAX_TIME_MINUTES without importing the workflow runtime.
    const timeoutMs = (this.params.runConfig.max_time_minutes ?? 10) * 60_000;
    const cancel = () => {
      this.cancelled = true;
      this.drainPermissions();
      void this.connection
        .cancel({ sessionId: this.sessionId })
        .catch(() => {});
    };
    signal?.addEventListener('abort', cancel, { once: true });
    let timedOut = false;
    try {
      this.emitter.emit(AgentEventType.START, {
        subagentId: this.id,
        name: this.params.name,
        model: this.coreView.modelConfig.model,
        tools: [],
        timestamp: Date.now(),
      });
      if (signal?.aborted) {
        this.terminateMode = AgentTerminateMode.CANCELLED;
        return;
      }
      if (inputs) this.emitInputs(inputs);
      let next = prompt;
      do {
        this.round++;
        const remaining =
          timeoutMs === undefined
            ? undefined
            : Math.max(0, timeoutMs - (Date.now() - this.turnStartedAt));
        // Stop before dispatching a round whose budget is already spent. Without
        // this, `remaining` clamps to 0 and `connection.prompt(...)` is evaluated
        // — a new, billed model turn really reaches the peer — one tick before
        // `wait`'s 0ms timer rejects with ExternalAgentTimeoutError; the catch
        // then disposes (SIGTERM/SIGKILL) a peer that just started work, and the
        // message this round already drained and recorded as delivered is never
        // processed. Mirrors the in-process sibling, which checks the budget at
        // the top of every round and breaks with TIMEOUT before dispatching. Set
        // terminateMode directly rather than throwing: the catch classifies
        // wall-time expiry by ExternalAgentTimeoutError identity, so a plain
        // Error here would be reclassified ERROR and rethrown to the parent.
        if (remaining !== undefined && remaining <= 0) {
          this.terminateMode = AgentTerminateMode.TIMEOUT;
          break;
        }
        const result = await this.wait(
          this.connection.prompt({ sessionId: this.sessionId, prompt: next }),
          remaining,
          signal,
        );
        this.terminateMode = this.stopMode(result.stopReason);
        if (this.terminateMode !== AgentTerminateMode.GOAL) break;
        const queued = this.provider?.() ?? [];
        if (queued.length === 0) break;
        this.emitter.emit(AgentEventType.ROUND_TEXT, {
          subagentId: this.id,
          round: this.round,
          text: this.finalText,
          thoughtText: this.thoughtText,
          timestamp: Date.now(),
        });
        this.finalText = '';
        this.thoughtText = '';
        this.emitInputs(queued);
        next = this.inputPrompt(queued);
      } while (!signal?.aborted);
      if (signal?.aborted) this.terminateMode = AgentTerminateMode.CANCELLED;
    } catch (error) {
      // Classify the wall-time expiry by the timer's own error identity, not by
      // re-reading Date.now(): a second clock can miss the monotonic deadline by
      // <1ms and misreport a budget-reaching turn as ERROR. See
      // ExternalAgentTimeoutError.
      timedOut = error instanceof ExternalAgentTimeoutError;
      this.terminateMode = signal?.aborted
        ? AgentTerminateMode.CANCELLED
        : timedOut
          ? AgentTerminateMode.TIMEOUT
          : AgentTerminateMode.ERROR;
      if (
        this.emitter.rawListeners(AgentEventType.ERROR).length > 0 &&
        !signal?.aborted
      ) {
        this.emitter.emit(AgentEventType.ERROR, {
          subagentId: this.id,
          error: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        });
      }
      await this.dispose();
      if (!signal?.aborted && !timedOut) throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
      this.durationMs += Date.now() - this.turnStartedAt;
      this.executing = false;
      this.drainPermissions();
      this.emitter.emit(AgentEventType.ROUND_TEXT, {
        subagentId: this.id,
        round: this.round,
        text: this.finalText,
        thoughtText: this.thoughtText,
        timestamp: Date.now(),
      });
      // Close out any tool call left open by cancel/timeout/crash before FINISH
      // reports the totals, so the counts sum and no consumer is left showing a
      // tool that never terminated (R7-3).
      this.flushOpenTools();
      this.emitter.emit(AgentEventType.FINISH, {
        subagentId: this.id,
        terminateReason: this.terminateMode,
        rounds: this.round,
        totalDurationMs: this.durationMs,
        totalToolCalls: this.toolCalls,
        successfulToolCalls: this.toolSucceeded,
        failedToolCalls: this.toolFailed,
        timestamp: Date.now(),
      });
    }
  }

  private stopMode(reason: string): AgentTerminateMode {
    switch (reason) {
      case 'end_turn':
        return AgentTerminateMode.GOAL;
      case 'max_turn_requests':
        return AgentTerminateMode.MAX_TURNS;
      case 'cancelled':
        return AgentTerminateMode.CANCELLED;
      case 'refusal':
        // A peer that refused the task neither achieved the goal nor was
        // cancelled by the user. CANCELLED renders as "cancelled by the user"
        // — a false statement about the user that also hides the refusal from
        // telemetry — so report it as a failure the parent can react to. The
        // ACP schema asks that a refusal be reflected rather than relabelled.
        return AgentTerminateMode.ERROR;
      default:
        return AgentTerminateMode.ERROR;
    }
  }

  private get id(): string {
    return this.params.subagentId ?? this.params.name;
  }
  getFinalText(): string {
    return this.finalText;
  }
  getTerminateMode(): AgentTerminateMode {
    return this.terminateMode;
  }
  getCore(): SubagentExecutorCore {
    return this.coreView;
  }
  setExternalMessageProvider(provider: () => AgentExternalInput[]): void {
    this.provider = provider;
  }
  getExecutionSummary(): AgentStatsSummary {
    return {
      rounds: this.round,
      totalDurationMs:
        this.durationMs +
        (this.executing ? Date.now() - this.turnStartedAt : 0),
      totalToolCalls: this.toolCalls,
      successfulToolCalls: this.toolSucceeded,
      failedToolCalls: this.toolFailed,
      successRate: this.toolCalls
        ? (this.toolSucceeded / this.toolCalls) * 100
        : 0,
      inputTokens: 0,
      outputTokens: 0,
      thoughtTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      toolUsage: [],
    };
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.fail(new Error('External ACP agent disposed'));
    return (this.disposePromise ??= this.child
      .terminate()
      .catch((error: unknown) => {
        if (!isExpectedExternalAgentCleanupExit(error)) throw error;
      }));
  }

  private drainPermissions(): void {
    for (const cancel of this.pendingPermissions.values()) cancel();
    this.pendingPermissions.clear();
  }

  private onSessionUpdate({ sessionId, update }: SessionNotification): void {
    // Drop updates once the turn is over for ANY reason, not just user cancel.
    // On timeout or peer crash the catch awaits dispose() before the finally
    // clears `executing`, and `cancelled` stays false, so without the
    // disposed/aborted checks the peer's still-flowing stdout would be appended
    // to finalText, emitted as STREAM_TEXT/ROUND_TEXT and counted into the
    // FINISH totals for up to EXIT_DEADLINE_MS after termination — a false
    // transcript record and a partial result handed to the parent verbatim on
    // the non-rethrowing TIMEOUT path (R8-1).
    if (
      sessionId !== this.sessionId ||
      !this.executing ||
      this.cancelled ||
      this.disposed ||
      this.failure.signal.aborted
    )
      return;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const thought = update.sessionUpdate === 'agent_thought_chunk';
        const text =
          update.content.type === 'text'
            ? update.content.text
            : JSON.stringify(update.content);
        if (thought) this.thoughtText += text;
        else this.finalText += text;
        this.emitter.emit(AgentEventType.STREAM_TEXT, {
          subagentId: this.id,
          round: this.round,
          text,
          thought,
          timestamp: Date.now(),
        });
        break;
      }
      case 'tool_call':
        this.updateTool(update);
        break;
      case 'tool_call_update':
        this.updateTool(update);
        break;
      default:
        break;
    }
  }

  private updateTool(update: ToolCall | ToolCallUpdate): void {
    const callId = update.toolCallId;
    if (this.finishedTools.has(callId)) return;
    const previous = this.tools.get(callId);
    const tool: ToolCall = {
      toolCallId: callId,
      title: previous?.title ?? 'External tool',
      ...previous,
      ...Object.fromEntries(
        Object.entries(update).filter(
          ([, value]) => value !== null && value !== undefined,
        ),
      ),
    };
    this.tools.set(callId, tool);
    const meta = tool._meta?.['claudeCode'];
    const reportedName =
      isRecord(meta) && typeof meta['toolName'] === 'string'
        ? meta['toolName']
        : (tool.kind ?? 'external_tool');
    const name = this.toolNames.get(callId) ?? reportedName;
    if (!previous) {
      this.toolNames.set(callId, name);
      this.toolCalls++;
      this.emitter.emit(AgentEventType.TOOL_CALL, {
        subagentId: this.id,
        round: this.round,
        callId,
        name,
        args: isRecord(tool.rawInput)
          ? tool.rawInput
          : { input: tool.rawInput },
        description: tool.title,
        timestamp: Date.now(),
      });
    }
    if (tool.status !== 'completed' && tool.status !== 'failed') return;
    this.finishedTools.add(callId);
    this.tools.delete(callId);
    const success = tool.status === 'completed';
    if (success) this.toolSucceeded++;
    else this.toolFailed++;
    this.toolNames.delete(callId);
    const response = {
      input: tool.rawInput ?? null,
      toolName: reportedName,
      output: tool.rawOutput ?? null,
      content: tool.content ?? null,
      status: tool.status,
    };
    const responseParts = [
      { functionResponse: { id: callId, name, response } },
    ];
    this.emitter.emit(AgentEventType.TOOL_RESULT, {
      subagentId: this.id,
      round: this.round,
      callId,
      name,
      success,
      responseParts,
      resultDisplay: JSON.stringify(tool.rawOutput ?? tool.content ?? null),
      timestamp: Date.now(),
    });
    this.emitter.emit(AgentEventType.TOOL_RESPONSES_FINALIZED, {
      subagentId: this.id,
      round: this.round,
      responses: [{ callId, responseParts }],
      timestamp: Date.now(),
    });
  }

  /**
   * Emit a terminal TOOL_RESULT + TOOL_RESPONSES_FINALIZED for every tool call
   * still open when the turn ends. Cancel, timeout and peer crash all leave
   * entries in `this.tools`: `cancel()` sets `this.cancelled` before the peer's
   * own terminal `tool_call_update` can arrive (so `onSessionUpdate` drops it),
   * and the next `runTurn` clears the map. Without this flush three consumers
   * keep a false record — the inline frame and Web Shell row show the tool
   * executing forever (TOOL_RESULT is the only writer of their status), the
   * JSONL transcript holds a permanently unpaired `functionCall`
   * (TOOL_RESPONSES_FINALIZED is the only writer of its `tool_result`), and
   * FINISH's totals do not sum. The in-process sibling closes the same gap via
   * `onAllToolCallsComplete`.
   */
  private flushOpenTools(): void {
    for (const [callId, tool] of this.tools) {
      const meta = tool._meta?.['claudeCode'];
      const reportedName =
        isRecord(meta) && typeof meta['toolName'] === 'string'
          ? meta['toolName']
          : (tool.kind ?? 'external_tool');
      const name = this.toolNames.get(callId) ?? reportedName;
      this.toolFailed++;
      const response = {
        input: tool.rawInput ?? null,
        toolName: reportedName,
        output: null,
        content: tool.content ?? null,
        status: 'failed',
      };
      const responseParts = [
        { functionResponse: { id: callId, name, response } },
      ];
      this.emitter.emit(AgentEventType.TOOL_RESULT, {
        subagentId: this.id,
        round: this.round,
        callId,
        name,
        success: false,
        responseParts,
        resultDisplay: JSON.stringify(tool.content ?? null),
        timestamp: Date.now(),
      });
      this.emitter.emit(AgentEventType.TOOL_RESPONSES_FINALIZED, {
        subagentId: this.id,
        round: this.round,
        responses: [{ callId, responseParts }],
        timestamp: Date.now(),
      });
    }
    this.tools.clear();
    this.toolNames.clear();
  }

  private async onRequestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const cancelled: RequestPermissionResponse = {
      outcome: { outcome: 'cancelled' },
    };
    const runtime = this.params.runtimeContext;
    const callId = params.toolCall.toolCallId;
    const meta = params.toolCall._meta?.['claudeCode'];
    const name =
      isRecord(meta) && typeof meta['toolName'] === 'string'
        ? meta['toolName']
        : (params.toolCall.kind ?? 'external_tool');
    // Turn-level and request-integrity states: the turn is already over, the
    // request is not ours, or it cannot be answered safely (no options, or
    // ambiguous duplicate option IDs). ACP `cancelled` is the right response —
    // there is no single tool call to deny.
    if (
      params.sessionId !== this.sessionId ||
      !this.executing ||
      this.cancelled ||
      this.disposed ||
      this.failure.signal.aborted ||
      this.pendingPermissions.has(callId) ||
      params.options.length === 0 ||
      new Set(params.options.map((option) => option.optionId)).size !==
        params.options.length
    )
      return cancelled;
    // Host-policy denials: reject the TOOL, not the TURN, so the peer continues
    // without this one action (see selectRejectOption). Falls back to
    // `cancelled` only when the peer offered no reject option to select.
    if (
      name.replaceAll('_', '').toLowerCase() === 'askuserquestion' ||
      runtime.getShouldAvoidPermissionPrompts() ||
      (!runtime.isInteractive() &&
        !runtime.getExperimentalZedIntegration() &&
        runtime.getInputFormat() !== InputFormat.STREAM_JSON) ||
      this.emitter.rawListeners(AgentEventType.TOOL_WAITING_APPROVAL).length ===
        0
    ) {
      const rejectOptionId = selectRejectOption(params.options);
      return rejectOptionId
        ? { outcome: { outcome: 'selected', optionId: rejectOptionId } }
        : cancelled;
    }
    return new Promise<RequestPermissionResponse>((resolve) => {
      const finish = (optionId?: string) => {
        if (this.pendingPermissions.get(callId) !== deny) return;
        this.pendingPermissions.delete(callId);
        resolve(
          optionId ? { outcome: { outcome: 'selected', optionId } } : cancelled,
        );
      };
      const deny = () => finish();
      this.pendingPermissions.set(callId, deny);
      try {
        this.emitter.emit(AgentEventType.TOOL_WAITING_APPROVAL, {
          subagentId: this.id,
          round: this.round,
          callId,
          name,
          args: isRecord(params.toolCall.rawInput)
            ? params.toolCall.rawInput
            : {},
          description: params.toolCall.title ?? 'External action',
          confirmationDetails: {
            type: 'info',
            title: params.toolCall.title ?? 'External action',
            prompt: params.options.map((option) => option.name).join(' / '),
            hideAlwaysAllow: true,
          },
          respond: async (outcome) =>
            finish(
              selectPermissionOption(params.options, outcome) ??
                // An explicit user rejection of THIS tool must deny the tool,
                // not cancel the whole turn: `selectPermissionOption` maps
                // Cancel to undefined, and ACP `cancelled` ends the prompt turn
                // (abandoning the remaining work and billing a fresh prompt to
                // re-delegate). Select the peer's `reject_once` option so the
                // turn continues without this one action, matching the dialog's
                // "suggest changes" promise and the in-process sibling. Fall
                // back to `cancelled` only when no reject option is selectable.
                (outcome === ToolConfirmationOutcome.Cancel
                  ? selectRejectOption(params.options)
                  : undefined),
            ),
          timestamp: Date.now(),
        });
      } catch {
        deny();
      }
    });
  }
}

export const acpExternalAgentExecutor: ExternalAgentExecutor = {
  create: (params) => AcpSubagentExecutor.create(params),
};
