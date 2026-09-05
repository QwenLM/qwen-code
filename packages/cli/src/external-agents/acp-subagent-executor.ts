/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview ACP-driven subagent executor.
 *
 * Runs a subagent's turn in an external agent process (today: Claude Code via
 * `@agentclientprotocol/claude-agent-acp`) instead of the in-process reasoning
 * loop, and re-publishes what happens as `AgentEventEmitter` events so the
 * existing downstream machinery — JSONL transcript writer, `SubAgentTracker`'s
 * nested-permission bridge, virtual subagent sessions, the Web Shell panel —
 * works unchanged.
 *
 * Two deliberate choices, both recorded in
 * `docs/design/claude-code-web-shell-backend.md`:
 *
 * - ACP payloads are handled as `unknown` and narrowed by hand rather than
 *   typed against the SDK's request/response interfaces, mirroring
 *   `packages/qwen-live/src/adaptor/acp-adaptor.ts`. Adapter versions drift;
 *   hand-narrowing degrades instead of mis-typing.
 * - The permission mode is derived from the subagent definition, never
 *   inherited from the external agent's own local config. Measured: with
 *   `~/.claude/settings.json` at `defaultMode: "auto"` a Write executed with no
 *   permission request at all (§9.4).
 *
 * Known fidelity limits (see §9.1.1):
 * - Token statistics are reported as 0. The adapter only exposes a
 *   context-window gauge (`usage_update {size, used}`), which is a level, not a
 *   per-turn delta; feeding it to an accumulator would inflate totals past the
 *   window and trip the workflow budget gate early. Consequence: an external
 *   subagent does not advance `QWEN_CODE_MAX_TOKENS_PER_WORKFLOW` (§Q11).
 * - Approval dialogs are raised as the `info` confirmation variant, so the Web
 *   Shell shows the tool title and prompt but not a rendered file diff.
 *   `edit`/`exec` variants are a follow-up.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk';
import type { Client } from '@agentclientprotocol/sdk';
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
import { sanitizeChildEnv } from '@qwen-code/qwen-code-core';
import { createStderrForwarder } from '@qwen-code/acp-bridge/spawnChannel';

/**
 * Adapter-private steering method (`acp-agent.js:103`), advertised through
 * `InitializeResponse._meta.steering.supported`. Not ACP-standard, so it is
 * only used when the handshake says it is there.
 */
const STEER_METHOD = '_session/steering';

/**
 * Handshake deadline. Without one, a command that spawns and stays alive but
 * never speaks ACP (`command: cat`, an adapter blocked on a missing credential,
 * a wrapper script) hangs `create()` forever, which surfaces as an Agent tool
 * call that never returns and never errors. Matches qwen-live's
 * `INIT_TIMEOUT_MS`.
 */
const INIT_TIMEOUT_MS = 10_000;

/**
 * Label reported through `getCore().modelConfig.model`. Deliberately not the
 * parent's model id: an external subagent did not run on it, and the label is
 * what surfaces in usage displays.
 *
 * Exported for unit tests.
 */
export function externalModelLabel(command: string): string {
  const base = command.split(/[\\/]/).pop() ?? command;
  return `external-acp:${base}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Map the definition's approval intent onto Claude's permission mode names
 * (`permissions/modes.js`: auto / default(manual) / acceptEdits / dontAsk /
 * plan / bypassPermissions).
 *
 * Never returns undefined, and never declines to choose: an absent or
 * unrecognized mode resolves to `'default'`, which asks. Letting the adapter
 * fall back to its own configured default instead would inherit
 * `~/.claude/settings.json`, where `permissions.defaultMode: "auto"` makes
 * every tool call self-approve with no permission request at all — measured,
 * not hypothetical (§9.4 of the design doc). Failing safe towards asking is
 * the whole point of deriving this here.
 *
 * Exported for unit tests.
 */
export function resolvePermissionMode(
  permissionMode: string | undefined,
  approvalMode: string | undefined,
): string {
  const declared = (permissionMode ?? approvalMode ?? '').trim().toLowerCase();
  switch (declared) {
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
    case 'default':
    case 'manual':
      return 'default';
    default:
      // Fail safe towards asking. An unrecognized or absent mode must not
      // inherit an auto-approving local config.
      return 'default';
  }
}

/**
 * qwen confirmation outcome -> the ACP option kind to answer with.
 *
 * Exported for unit tests.
 */
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
      // Fail closed. The `never` assignment makes this a compile error the
      // moment ToolConfirmationOutcome gains a member, so the mapping cannot
      // silently drift; the runtime branch still denies rather than granting,
      // because a default of `allow_once` would turn every unmapped outcome —
      // `RestorePrevious` before it was listed, say — into a permission the
      // user never gave.
      const exhaustive: never = outcome;
      void exhaustive;
      return 'reject_once';
    }
  }
}

/**
 * Pick the option to answer an external agent's permission request with.
 *
 * Returns `undefined` for "answer with a cancelled outcome", which grants
 * nothing. Extracted from the `respond` callback so the escalation rule is
 * testable without driving a live ACP connection.
 *
 * The rule: use the option whose `kind` matches the user's outcome; when the
 * agent offered no such kind, **deny** — never fall back to the first offered
 * option. Approving "proceed once" against an offered set of
 * `[allow_always, reject_once]` must not answer `allow_always`, which would
 * silently widen a one-time approval to the whole session.
 */
export function selectPermissionOption(
  options: ReadonlyArray<{ optionId: string; kind: unknown }>,
  outcome: ToolConfirmationOutcome,
): string | undefined {
  if (outcome === ToolConfirmationOutcome.Cancel) return undefined;
  const wantKind = optionKindForOutcome(outcome);
  const match = options.find((option) => option.kind === wantKind);
  if (match) return match.optionId;
  const deny = options.find((option) =>
    String(option.kind).startsWith('reject'),
  );
  return deny?.optionId;
}

interface PendingPermission {
  resolve: (optionId: string | undefined) => void;
  options: Array<{ optionId: string; kind: unknown }>;
}

class AcpSubagentExecutor implements SubagentExecutor {
  private readonly coreView: SubagentExecutorCore;
  private finalText = '';
  private terminateMode: AgentTerminateMode = AgentTerminateMode.ERROR;
  private round = 0;
  private startedAtMs = 0;
  private toolCalls = 0;
  private toolSucceeded = 0;
  private toolFailed = 0;
  private executing = false;
  private steeringSupported = false;
  private sessionId: string | undefined;
  private connection?: ClientSideConnection;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  /** callId -> tool name, so TOOL_RESULT reports the name TOOL_CALL emitted. */
  private readonly toolNames = new Map<string, string>();

  private constructor(
    private readonly params: ExternalAgentExecutorParams,
    private readonly child: ChildProcess,
    private readonly emitter: AgentEventEmitter,
    modelLabel: string,
  ) {
    this.coreView = {
      getEventEmitter: () => this.emitter,
      modelConfig: { ...params.modelConfig, model: modelLabel },
    };
  }

  static async create(
    params: ExternalAgentExecutorParams,
  ): Promise<AcpSubagentExecutor> {
    const cwd = params.runtimeContext.getTargetDir();
    const child = spawn(params.spec.command, params.spec.args ?? [], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // The command is named by a project-level `.qwen/agents/*.md`, so a
      // repository the user merely cloned chooses the executable. It must not
      // inherit the daemon bearer token or other Qwen-internal secrets — the
      // same reasoning `mcp-client.ts` applies to its MCP child spawn.
      env: sanitizeChildEnv(process.env),
    });

    // A spawn failure (ENOENT) emits 'error' and never 'exit'; a child that
    // spawns and then dies emits 'exit' and never 'error'. Both must reject the
    // handshake racers — otherwise the most likely real-world failure (`npx -y`
    // unable to resolve offline, an adapter erroring during boot) waits out the
    // full deadline instead of failing in milliseconds.
    const spawnFailure = new Promise<never>((_resolve, reject) => {
      child.once('error', (error) => {
        reject(
          new Error(
            `external agent "${params.name}" failed to spawn ` +
              `${params.spec.command}: ${error.message}`,
          ),
        );
      });
      child.once('exit', (code, signal) => {
        reject(
          new Error(
            `external agent "${params.name}" exited during handshake ` +
              `(code ${String(code)}, signal ${String(signal)})`,
          ),
        );
      });
    });

    const emitter = params.eventEmitter ?? new AgentEventEmitter();
    const executor = new AcpSubagentExecutor(
      params,
      child,
      emitter,
      externalModelLabel(params.spec.command),
    );

    const stdout = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
    const stdin = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
    // A static method of the class may touch private members of its instances,
    // so the connection is assigned directly rather than through a cast.
    executor.connection = new ClientSideConnection(
      () => executor.buildClient(),
      ndJsonStream(stdin, stdout),
    );

    // Reuse the bridge's forwarder rather than an inline split: it buffers
    // across chunks (so a line spanning two chunks is not fragmented) and runs
    // every line through `redactLogCredentials` before it reaches the terminal
    // or a captured log.
    if (child.stderr) {
      const forwarder = createStderrForwarder({
        prefix: `[external-agent ${params.name}] `,
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', forwarder.onData);
      child.stderr.on('end', forwarder.onEnd);
      child.stderr.on('error', () => {
        // A broken stderr pipe must not crash the parent; the child is
        // already gone or going.
      });
    }

    try {
      await executor.connect(spawnFailure);
    } catch (error) {
      executor.dispose();
      throw error;
    }

    // Post-handshake: a mid-turn crash must become a visible failure, and must
    // release anything parked on an approval dialog — otherwise the dialog
    // waits on a process that no longer exists and the parent turn hangs.
    child.once('exit', (code, signal) => {
      executor.onChildExit(code, signal);
    });
    return executor;
  }

  /**
   * ACP client surface. Params are `unknown` and narrowed by hand — see the
   * file header for why.
   */
  private buildClient(): Client {
    return {
      sessionUpdate: async (params: unknown) => {
        this.onSessionUpdate(params);
      },
      requestPermission: async (params: unknown) =>
        new Promise((resolve) => {
          void this.onRequestPermission(params, resolve);
        }),
      readTextFile: async () => {
        throw methodNotFound('fs/read_text_file');
      },
      writeTextFile: async () => {
        throw methodNotFound('fs/write_text_file');
      },
      extMethod: async (method: string) => {
        // Thread the real method name through: a bare 'extMethod' tells the
        // agent nothing about which extension it asked for.
        throw methodNotFound(method);
      },
      extNotification: async () => {},
    } as unknown as Client;
  }

  private async connect(spawnFailure: Promise<never>): Promise<void> {
    // One deadline covers both handshake round-trips. Without it a child that
    // spawns, stays alive and never speaks ACP hangs `create()` forever, which
    // surfaces as an Agent tool call that never returns and never errors.
    const deadline = new Promise<never>((_resolve, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(
              `external agent "${this.params.name}" did not complete the ACP ` +
                `handshake within ${INIT_TIMEOUT_MS}ms`,
            ),
          ),
        INIT_TIMEOUT_MS,
      ).unref();
    });

    const initialized = (await Promise.race([
      this.requireConnection().initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
        },
      }),
      spawnFailure,
      deadline,
    ])) as unknown;

    const meta = isRecord(initialized) ? initialized['_meta'] : undefined;
    const steering = isRecord(meta) ? meta['steering'] : undefined;
    this.steeringSupported =
      isRecord(steering) && steering['supported'] === true;

    const session = (await Promise.race([
      this.requireConnection().newSession({
        cwd: this.params.runtimeContext.getTargetDir(),
        mcpServers: [],
        // Set at creation rather than via a later session/set_mode so there is
        // no window in which the agent runs under its own auto-approving
        // local default.
        _meta: {
          permissionMode: resolvePermissionMode(
            this.params.permissionMode,
            this.params.approvalMode,
          ),
        },
      }),
      spawnFailure,
      deadline,
    ])) as unknown;

    const sessionId = isRecord(session)
      ? asString(session['sessionId'])
      : undefined;
    if (!sessionId) {
      throw new Error(
        `external agent "${this.params.name}" returned no sessionId`,
      );
    }
    this.sessionId = sessionId;
  }

  /**
   * The external agent died on its own. Release anything parked on an approval
   * dialog — the process that would have answered it is gone, so leaving it
   * parked hangs the parent turn — and turn a mid-turn death into a visible
   * ERROR event instead of silence.
   */
  private onChildExit(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    for (const pending of this.pendingPermissions.values()) {
      pending.resolve(undefined);
    }
    this.pendingPermissions.clear();
    if (this.executing) {
      this.terminateMode = AgentTerminateMode.ERROR;
      // `AgentEventType.ERROR` is Node's `'error'` event, and
      // `AgentEventEmitter` delegates straight to `EventEmitter.emit`, which
      // throws ERR_UNHANDLED_ERROR when nothing is subscribed. The background,
      // resume and workflow emitters attach no ERROR listener, so emitting
      // unguarded would turn a child crash into an uncaught exception raised
      // from inside this exit handler. The terminateMode assignment above is
      // what makes the failure visible to the caller; the event is best-effort.
      if (this.emitter.rawListeners(AgentEventType.ERROR).length > 0) {
        this.emitter.emit(AgentEventType.ERROR, {
          subagentId: this.params.subagentId ?? this.params.name,
          error:
            `external agent "${this.params.name}" exited mid-turn ` +
            `(code ${String(code)}, signal ${String(signal)})`,
          timestamp: Date.now(),
        });
      }
    }
  }

  // ─── SubagentExecutor ───────────────────────────────────────────────────

  async execute(
    context: ContextState,
    externalSignal?: AbortSignal,
  ): Promise<void> {
    if (this.executing) {
      throw new Error(
        'AcpSubagentExecutor does not support concurrent execute() calls.',
      );
    }
    this.executing = true;
    this.startedAtMs = Date.now();
    this.finalText = '';
    this.terminateMode = AgentTerminateMode.ERROR;
    this.round += 1;

    const subagentId = this.params.subagentId ?? this.params.name;
    this.emitter.emit(AgentEventType.START, {
      subagentId,
      name: this.params.name,
      model: externalModelLabel(this.params.spec.command),
      tools: [],
      timestamp: Date.now(),
    });

    const onCancel = () => {
      if (!this.sessionId) return;
      this.requireConnection()
        .cancel({ sessionId: this.sessionId })
        .catch(() => {});
    };
    externalSignal?.addEventListener('abort', onCancel, { once: true });

    try {
      const systemPrompt = renderSubagentSystemPrompt(
        this.params.promptConfig,
        context,
        this.params.runtimeContext,
      );
      const task = asString(context.get('task_prompt')) ?? 'Get Started!';
      const prompt = [
        ...(systemPrompt ? [{ type: 'text', text: systemPrompt }] : []),
        { type: 'text', text: task },
      ];

      const result = await this.requireConnection().prompt({
        sessionId: this.sessionId!,
        prompt: prompt as never,
      });

      this.terminateMode = this.terminateModeForStopReason(
        isRecord(result) ? asString(result['stopReason']) : undefined,
        externalSignal?.aborted === true,
      );
      this.emitter.emit(AgentEventType.FINISH, {
        subagentId,
        terminateReason: this.terminateMode,
        timestamp: Date.now(),
        rounds: this.round,
        totalDurationMs: Date.now() - this.startedAtMs,
        totalToolCalls: this.toolCalls,
        successfulToolCalls: this.toolSucceeded,
        failedToolCalls: this.toolFailed,
      });
    } catch (error) {
      this.terminateMode = AgentTerminateMode.ERROR;
      this.emitter.emit(AgentEventType.ERROR, {
        subagentId,
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      });
      throw error;
    } finally {
      externalSignal?.removeEventListener('abort', onCancel);
      this.executing = false;
    }
  }

  async executeExternalInputs(
    inputs: AgentExternalInput[],
    // Unused: the ACP steering extension takes no abort signal, and a cancel
    // arrives through `execute`'s signal → `session/cancel` instead.
    _externalSignal?: AbortSignal,
  ): Promise<void> {
    if (inputs.length === 0 || !this.sessionId) return;
    const text = inputs
      .map((input) => asString((input as { text?: unknown }).text))
      .filter((part): part is string => Boolean(part))
      .join('\n');
    if (!text) return;

    const prompt = [{ type: 'text', text }] as never;
    // Ask the adapter to leave the content to us when the session is idle, so
    // it never detaches a turn behind our lifecycle and statistics.
    if (this.steeringSupported) {
      const steered = (await this.requireConnection().extMethod(STEER_METHOD, {
        sessionId: this.sessionId,
        prompt,
        _meta: { steering: { idleBehavior: 'promptRequired' } },
      })) as unknown;
      const outcome = isRecord(steered)
        ? asString(steered['outcome'])
        : undefined;
      if (outcome === 'injected') return;
      if (outcome !== 'promptRequired') return;
    }
    await this.requireConnection().prompt({
      sessionId: this.sessionId,
      prompt,
    });
  }

  getFinalText(): string {
    return this.finalText;
  }

  getTerminateMode(): AgentTerminateMode {
    return this.terminateMode;
  }

  getExecutionSummary(): AgentStatsSummary {
    const totalDurationMs = this.startedAtMs
      ? Date.now() - this.startedAtMs
      : 0;
    return {
      rounds: this.round,
      totalDurationMs,
      totalToolCalls: this.toolCalls,
      successfulToolCalls: this.toolSucceeded,
      failedToolCalls: this.toolFailed,
      successRate:
        this.toolCalls > 0 ? (this.toolSucceeded / this.toolCalls) * 100 : 0,
      // See §Q11: reported as 0 rather than derived from the adapter's
      // context-window gauge, which is a level and not a per-turn delta.
      inputTokens: 0,
      outputTokens: 0,
      thoughtTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      toolUsage: [],
    };
  }

  getCore(): SubagentExecutorCore {
    return this.coreView;
  }

  setExternalMessageProvider(_provider: () => AgentExternalInput[]): void {
    // Accepted and deliberately not acted on. Mid-turn input reaches the
    // external agent through `executeExternalInputs` (the adapter's steering
    // channel), not through the drain callback the in-process reasoning loop
    // polls between tool rounds.
  }

  /** Kills the external agent process. Idempotent. */
  dispose(): void {
    this.killChild();
  }

  /**
   * `connection` is assigned in `create` right after construction, so it is
   * only absent when construction itself failed. Centralised here so the call
   * sites do not each repeat a non-null assertion.
   */
  private requireConnection(): ClientSideConnection {
    const connection = this.connection;
    if (!connection) {
      throw new Error(
        `external agent "${this.params.name}" has no ACP connection`,
      );
    }
    return connection;
  }

  // ─── internals ──────────────────────────────────────────────────────────

  private killChild(): void {
    for (const pending of this.pendingPermissions.values()) {
      pending.resolve(undefined);
    }
    this.pendingPermissions.clear();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGTERM');
    }
  }

  private terminateModeForStopReason(
    stopReason: string | undefined,
    aborted: boolean,
  ): AgentTerminateMode {
    if (aborted) return AgentTerminateMode.CANCELLED;
    switch (stopReason) {
      case 'end_turn':
      case 'max_tokens':
        return AgentTerminateMode.GOAL;
      case 'max_turn_requests':
        return AgentTerminateMode.MAX_TURNS;
      case 'refusal':
      case 'cancelled':
        return AgentTerminateMode.CANCELLED;
      default:
        return AgentTerminateMode.GOAL;
    }
  }

  private onSessionUpdate(params: unknown): void {
    if (!isRecord(params)) return;
    const update = isRecord(params['update']) ? params['update'] : undefined;
    if (!update) return;
    const kind = asString(update['sessionUpdate']);
    const subagentId = this.params.subagentId ?? this.params.name;
    const timestamp = Date.now();

    switch (kind) {
      case 'agent_message_chunk': {
        const content = isRecord(update['content']) ? update['content'] : {};
        const text = asString(content['text']);
        if (typeof text === 'string' && text.length > 0) {
          this.finalText += text;
          this.emitter.emit(AgentEventType.STREAM_TEXT, {
            subagentId,
            round: this.round,
            text,
            timestamp,
          });
        }
        return;
      }
      case 'tool_call': {
        const callId =
          asString(update['toolCallId']) ?? `external-${this.toolCalls}`;
        const title = asString(update['title']) ?? 'External tool';
        const meta = isRecord(update['_meta']) ? update['_meta'] : undefined;
        const claudeMeta = isRecord(meta) ? meta['claudeCode'] : undefined;
        const name =
          (isRecord(claudeMeta)
            ? asString(claudeMeta['toolName'])
            : undefined) ??
          asString(update['kind']) ??
          'external_tool';
        this.toolCalls += 1;
        this.toolNames.set(callId, name);
        this.emitter.emit(AgentEventType.TOOL_CALL, {
          subagentId,
          round: this.round,
          callId,
          name,
          args: isRecord(update['rawInput']) ? update['rawInput'] : {},
          description: title,
          timestamp,
        });
        return;
      }
      case 'tool_call_update': {
        const callId = asString(update['toolCallId']) ?? '';
        const status = asString(update['status']);
        if (status === 'completed') {
          this.toolSucceeded += 1;
        } else if (status === 'failed') {
          this.toolFailed += 1;
        } else {
          return;
        }
        this.emitter.emit(AgentEventType.TOOL_RESULT, {
          subagentId,
          round: this.round,
          callId,
          // Must match the name emitted on TOOL_CALL for the same callId, or
          // consumers that pair a call with its result by (callId, name) see a
          // mismatch. Falls back when the update arrives for an id we never
          // saw a tool_call for.
          name: this.toolNames.get(callId) ?? 'external_tool',
          success: status === 'completed',
          timestamp,
        });
        this.toolNames.delete(callId);
        return;
      }
      default:
        // usage_update carries a context-window gauge, not token deltas (§Q11);
        // user_message_chunk is our own echo. Neither maps to an event.
        return;
    }
  }

  private async onRequestPermission(
    params: unknown,
    resolve: (value: unknown) => void,
  ): Promise<void> {
    if (!isRecord(params)) {
      resolve({ outcome: { outcome: 'cancelled' } });
      return;
    }
    const rawOptions = Array.isArray(params['options'])
      ? params['options']
      : [];
    const options = rawOptions
      .filter(isRecord)
      .map((option) => ({
        optionId: asString(option['optionId']) ?? '',
        name: asString(option['name']) ?? '',
        kind: option['kind'],
      }))
      .filter((option) => option.optionId !== '');
    if (options.length === 0) {
      resolve({ outcome: { outcome: 'cancelled' } });
      return;
    }

    const toolCall = isRecord(params['toolCall']) ? params['toolCall'] : {};
    const callId = asString(toolCall['toolCallId']) ?? `perm-${Date.now()}`;
    const title = asString(toolCall['title']) ?? 'External agent action';
    const subagentId = this.params.subagentId ?? this.params.name;
    // Recover the real tool name the same way the tool_call branch does, so the
    // approval dialog names the tool the agent actually asked about rather than
    // a generic placeholder.
    const toolMeta = isRecord(toolCall['_meta'])
      ? toolCall['_meta']
      : undefined;
    const claudeMeta = isRecord(toolMeta) ? toolMeta['claudeCode'] : undefined;
    const toolName =
      (isRecord(claudeMeta) ? asString(claudeMeta['toolName']) : undefined) ??
      asString(toolCall['kind']) ??
      'external_tool';

    // The adapter validates that the answer selects an offered optionId, so
    // park the resolver and answer from the user's decision.
    const chosen = await new Promise<string | undefined>((park) => {
      this.pendingPermissions.set(callId, { resolve: park, options });
      this.emitter.emit(AgentEventType.TOOL_WAITING_APPROVAL, {
        subagentId,
        round: this.round,
        callId,
        name: toolName,
        description: title,
        args: isRecord(toolCall['rawInput']) ? toolCall['rawInput'] : {},
        // `info` variant: the faithful `edit`/`exec` shapes need a rendered
        // diff/command we do not reconstruct yet (see file header).
        confirmationDetails: {
          type: 'info',
          title,
          prompt: options.map((option) => option.name).join(' / '),
        },
        respond: async (outcome: ToolConfirmationOutcome) => {
          const pending = this.pendingPermissions.get(callId);
          this.pendingPermissions.delete(callId);
          // The escalation rule lives in `selectPermissionOption` so it can be
          // tested without driving a live ACP connection.
          pending?.resolve(selectPermissionOption(options, outcome));
        },
        timestamp: Date.now(),
      } as never);
    });

    const selected = chosen
      ? options.find((option) => option.optionId === chosen)
      : undefined;
    resolve(
      selected
        ? {
            outcome: {
              outcome: 'selected',
              optionId: selected.optionId,
            },
          }
        : { outcome: { outcome: 'cancelled' } },
    );
  }
}

/**
 * Must be a real `RequestError`: the SDK's connection only preserves
 * `RequestError` instances and repackages anything else — including a plain
 * `Error` with a duck-typed `code` field — as `-32603 Internal error`. Agents
 * that branch on `-32601` to degrade gracefully would never see it.
 */
function methodNotFound(method: string): RequestError {
  return RequestError.methodNotFound(method);
}

/**
 * Inject into the host Config with `setExternalAgentExecutor` so subagent
 * definitions carrying an `executor` block run externally instead of failing.
 */
export const acpExternalAgentExecutor: ExternalAgentExecutor = {
  create: (params) => AcpSubagentExecutor.create(params),
};
