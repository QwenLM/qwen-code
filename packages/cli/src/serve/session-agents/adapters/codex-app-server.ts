/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview The `codex` program adapter: one `codex app-server --listen
 * stdio://` process per turn, JSON-RPC 2.0 over stdio, resuming the agent's
 * thread with `thread/resume`.
 *
 * Follows Multica's codex backend (server/pkg/agent/codex.go): handshake,
 * resume-then-start fallback, the current-turn notification gate, thread
 * filtering, the final-answer deliverable and the timeouts. One deliberate
 * difference: Multica auto-accepts every approval request. Here each approval
 * request's JSON-RPC id is held open until the person answers through
 * `awaitPermission`, and `approvalPolicy` is set to `on-request` explicitly so
 * a user config of `never` cannot skip the question (Multica
 * execenv/codex_sandbox.go explains how `never` bypasses the approver).
 *
 * Approval contract (product decision, acceptance row 2.5): the thread runs
 * in codex's `read-only` sandbox. Every file change, and every command that
 * needs to leave that sandbox (a write, network, an escalation), asks the
 * person in the session. Read-only commands that the sandbox allows (`ls`,
 * `cat`, `rg`, ...) run without asking; that is codex's `on-request`
 * behaviour, not every command asking.
 *
 * There are no text deltas: each finished `agentMessage` is emitted whole.
 */

import type {
  AgentAdapter,
  AgentAdapterTurnInput,
  AgentAdapterTurnResult,
  SessionAgentPermissionPrompt,
  SessionAgentStep,
} from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';
import {
  DEFAULT_MAX_LINE_BYTES,
  LineTooLongError,
  previewJson,
  readJsonLines,
  scrubAgentEnv,
  spawnAgentProcess,
  TailBuffer,
  terminateAgentProcess,
  waitForExit,
  type AgentProcess,
  type AgentSpawn,
} from './agent-process.js';
import { SESSION_SEND_MCP_SERVER_NAME } from './claude-cli.js';

/** Env var naming the codex executable (also read by the program probe). */
export const CODEX_PATH_ENV = 'QWEN_AGENT_CODEX_PATH';

export interface CodexTimeouts {
  /** `initialize` and `turn/start`. */
  handshakeMs: number;
  /** `thread/start` and `thread/resume`. */
  threadSetupMs: number;
  /** From `turn/start` until the first item of the turn. */
  firstTurnNoProgressMs: number;
  /** No notification at all for this long ends the turn. */
  inactivityMs: number;
  /** SIGTERM → SIGKILL grace when stopping the process. */
  terminateGraceMs: number;
  /** How long a cancel waits for `turn/interrupt` to settle the turn. */
  interruptMs: number;
}

export const DEFAULT_CODEX_TIMEOUTS: CodexTimeouts = {
  handshakeMs: 30_000,
  threadSetupMs: 60_000,
  firstTurnNoProgressMs: 60_000,
  inactivityMs: 10 * 60_000,
  terminateGraceMs: 5_000,
  interruptMs: 5_000,
};

export interface CodexAppServerAdapterOptions {
  /** Path or name of the codex CLI; defaults to `codex` on PATH. */
  executable?: string;
  /** Base environment for the child; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Test seams. */
  spawn?: AgentSpawn;
  timeouts?: Partial<CodexTimeouts>;
  maxLineBytes?: number;
}

const MAX_INPUT_PREVIEW_CHARS = 2_000;
const MAX_TITLE_CHARS = 200;
const JSON_RPC_METHOD_NOT_FOUND = -32601;

/**
 * `-c` overrides that add the `session_send` server to Codex's MCP servers
 * for this process only.
 * TODO(multi-agent): verify against real codex CLI — that `-c
 * mcp_servers.<name>.*` on `app-server` adds a stdio server, that a hyphen in
 * the name is accepted, and that `env` reaches the server. The token is on
 * argv (visible in `ps`) for the life of the run; it is per run and the
 * endpoint is loopback only. A temporary CODEX_HOME would hide it but loses
 * the user's auth.json and config.
 */
export function codexMcpOverrides(
  server: NonNullable<AgentAdapterTurnInput['sessionSendServer']>,
): string[] {
  const prefix = `mcp_servers.${SESSION_SEND_MCP_SERVER_NAME}`;
  // JSON strings and string arrays are valid TOML basic strings / arrays.
  const args = [
    '-c',
    `${prefix}.command=${JSON.stringify(server.command)}`,
    '-c',
    `${prefix}.args=${JSON.stringify(server.args)}`,
  ];
  for (const [key, value] of Object.entries(server.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    args.push('-c', `${prefix}.env.${key}=${JSON.stringify(value)}`);
  }
  return args;
}

export function buildCodexArgs(
  sessionSendServer?: AgentAdapterTurnInput['sessionSendServer'],
): string[] {
  return [
    'app-server',
    '--listen',
    'stdio://',
    ...(sessionSendServer ? codexMcpOverrides(sessionSendServer) : []),
  ];
}

class CodexRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
  ) {
    super(
      `${method}: ${message}${code !== undefined ? ` (code=${code})` : ''}`,
    );
    this.name = 'CodexRpcError';
  }
}

/** The process is gone or unreadable; no further request can succeed. */
class CodexTransportError extends Error {
  constructor(
    message: string,
    readonly overflow = false,
  ) {
    super(message);
    this.name = 'CodexTransportError';
  }
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function nestedString(value: unknown, ...keys: string[]): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return typeof current === 'string' ? current : undefined;
}

function nestedNumber(value: unknown, ...keys: string[]): number | undefined {
  let current: unknown = value;
  for (const key of keys) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return typeof current === 'number' ? current : undefined;
}

function clip(text: string, max = MAX_TITLE_CHARS): string {
  const line = text.trim().replace(/\s+/g, ' ');
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function commandText(command: unknown): string {
  if (typeof command === 'string') return command;
  if (Array.isArray(command)) return command.map(String).join(' ');
  return '';
}

/**
 * Keeps resume-time history replay (and other turns) out of the new turn
 * (Multica `codexTurnNotificationGate`). Armed before `turn/start` because
 * notifications can precede its response; `turn/started` names the turn.
 */
export class CodexTurnGate {
  private armed = false;
  private started = false;
  turnId: string | undefined;

  arm(): void {
    this.armed = true;
  }

  accept(method: string, params: Json | undefined): boolean {
    if (!this.armed) return false;
    if (method === 'turn/started') {
      this.started = true;
      this.turnId = nestedString(params, 'turn', 'id');
      return true;
    }
    if (method === 'turn/completed') {
      if (!this.started) return true;
      const id = nestedString(params, 'turn', 'id');
      return !this.turnId || !id || id === this.turnId;
    }
    if (method.startsWith('item/') || method === 'thread/status/changed') {
      if (!this.started) return true;
      const id =
        typeof params?.['turnId'] === 'string' ? params['turnId'] : undefined;
      return !this.turnId || !id || id === this.turnId;
    }
    // A terminal `error` may be the first thing a failed turn produces.
    return true;
  }
}

type ApprovalKind = 'command' | 'fileChange' | 'permissions' | 'elicitation';

const APPROVAL_METHODS: Record<
  string,
  { kind: ApprovalKind; legacy: boolean }
> = {
  'item/commandExecution/requestApproval': { kind: 'command', legacy: false },
  execCommandApproval: { kind: 'command', legacy: true },
  'item/fileChange/requestApproval': { kind: 'fileChange', legacy: false },
  applyPatchApproval: { kind: 'fileChange', legacy: true },
  'item/permissions/requestApproval': { kind: 'permissions', legacy: false },
  'mcpServer/elicitation/request': { kind: 'elicitation', legacy: false },
};

const FULL_OPTIONS: SessionAgentPermissionPrompt['options'] = [
  { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
  {
    optionId: 'allow_always',
    // codex keeps the grant on this agent's thread, which only this chat
    // resumes (the native session is bound per chat session and agent).
    name: 'Allow for the rest of this chat',
    kind: 'allow_always',
  },
  { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
];
const ONCE_OPTIONS: SessionAgentPermissionPrompt['options'] = [
  { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
];

export function codexApprovalPrompt(
  requestId: string,
  method: string,
  params: Json | undefined,
): SessionAgentPermissionPrompt | undefined {
  const spec = APPROVAL_METHODS[method];
  if (!spec) return undefined;
  let title: string;
  let toolName: string;
  switch (spec.kind) {
    case 'command': {
      toolName = 'exec_command';
      const command = commandText(params?.['command']);
      title = command ? `exec_command: ${clip(command)}` : 'exec_command';
      break;
    }
    case 'fileChange':
      toolName = 'patch_apply';
      title = 'patch_apply: edit files';
      break;
    case 'permissions':
      toolName = 'permissions';
      title = 'permissions: grant additional access';
      break;
    case 'elicitation': {
      toolName = 'mcp_elicitation';
      const server =
        typeof params?.['serverName'] === 'string' ? params['serverName'] : '';
      title = server ? `mcp_elicitation: ${clip(server)}` : 'mcp_elicitation';
      break;
    }
    default: {
      const exhaustive: never = spec.kind;
      return exhaustive;
    }
  }
  const reason = typeof params?.['reason'] === 'string' ? params['reason'] : '';
  if (reason) title = clip(`${title} (${reason})`);
  const inputPreview = previewJson(params, MAX_INPUT_PREVIEW_CHARS);
  return {
    requestId,
    title,
    toolName,
    ...(inputPreview ? { inputPreview } : {}),
    options:
      spec.kind === 'command' || spec.kind === 'fileChange'
        ? FULL_OPTIONS
        : ONCE_OPTIONS,
  };
}

/**
 * The reply to an approval request for the chosen option.
 * TODO(multi-agent): verify against real codex CLI — every decision value:
 * v2 `accept` / `acceptForSession` / `decline`; legacy
 * `execCommandApproval` / `applyPatchApproval` `approved` /
 * `approved_for_session` / `denied` (Multica answers `accept` to both, which
 * is itself unverified); the permissions grant shape; and the elicitation
 * `accept` / `decline` actions.
 */
export function codexApprovalResponse(
  method: string,
  params: Json | undefined,
  optionId: string | undefined,
): unknown {
  const spec = APPROVAL_METHODS[method];
  const allow = optionId === 'allow_once' || optionId === 'allow_always';
  const always = optionId === 'allow_always';
  if (!spec) return {};
  switch (spec.kind) {
    case 'command':
    case 'fileChange':
      if (spec.legacy) {
        return {
          decision: allow
            ? always
              ? 'approved_for_session'
              : 'approved'
            : 'denied',
        };
      }
      return {
        decision: allow ? (always ? 'acceptForSession' : 'accept') : 'decline',
      };
    case 'permissions': {
      const granted: Json = {};
      const requested = asRecord(params?.['permissions']);
      if (allow && requested) {
        for (const key of ['network', 'fileSystem']) {
          if (requested[key] !== undefined && requested[key] !== null) {
            granted[key] = requested[key];
          }
        }
      }
      return { permissions: granted, scope: 'turn' };
    }
    case 'elicitation':
      return allow
        ? { action: 'accept', content: null }
        : { action: 'decline', content: null };
    default:
      return {};
  }
}

interface PendingRequest {
  method: string;
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

interface AttemptOutcome {
  result: AgentAdapterTurnResult;
  /** `thread/resume` could not be read: start again in a new process. */
  retryFresh: boolean;
}

export function createCodexAppServerAdapter(
  options: CodexAppServerAdapterOptions = {},
): AgentAdapter {
  const executable = options.executable || 'codex';
  const baseEnv = options.env ?? process.env;
  const spawnProcess = options.spawn ?? spawnAgentProcess;
  const timeouts: CodexTimeouts = {
    ...DEFAULT_CODEX_TIMEOUTS,
    ...options.timeouts,
  };
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;

  const attempt = async (
    input: AgentAdapterTurnInput,
    resumeThreadId: string | undefined,
  ): Promise<AttemptOutcome> => {
    let child: AgentProcess;
    try {
      child = spawnProcess(
        executable,
        buildCodexArgs(input.sessionSendServer),
        {
          cwd: input.cwd,
          env: scrubAgentEnv(baseEnv),
        },
      );
    } catch (error) {
      return {
        result: {
          status: 'failed',
          outputText: '',
          error: `Could not start codex (${executable}): ${(error as Error).message}`,
        },
        retryFresh: false,
      };
    }

    const stderr = new TailBuffer();
    child.stderr?.on('data', (chunk: Buffer) => stderr.append(chunk));
    child.stdin?.on('error', () => {
      // EPIPE after exit; the exit path reports it.
    });

    let nextId = 0;
    const pending = new Map<number, PendingRequest>();
    // Assigned from callbacks: typed initializers keep TypeScript from
    // narrowing these to their initial value in the code after the awaits.
    let transportError = undefined as CodexTransportError | undefined;
    const failTransport = (error: CodexTransportError) => {
      transportError ??= error;
      for (const [id, request] of pending) {
        if (request.timer) clearTimeout(request.timer);
        pending.delete(id);
        request.reject(transportError);
      }
      settleTurn();
    };

    const write = (message: Json) => {
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed || stdin.writableEnded) return;
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    };
    const request = (method: string, params: unknown, timeoutMs: number) =>
      new Promise<unknown>((resolve, reject) => {
        if (transportError) {
          reject(transportError);
          return;
        }
        const id = ++nextId;
        const entry: PendingRequest = { method, resolve, reject };
        if (timeoutMs > 0) {
          entry.timer = setTimeout(() => {
            pending.delete(id);
            // A timed-out handshake has an unknown outcome: the process is
            // treated as unusable.
            const error = new CodexTransportError(
              `codex ${method} timed out after ${timeoutMs}ms.`,
            );
            reject(error);
            failTransport(error);
          }, timeoutMs);
          entry.timer.unref?.();
        }
        pending.set(id, entry);
        write({ id, method, params });
      });
    const notify = (method: string, params?: unknown) =>
      write(params === undefined ? { method } : { method, params });

    // ---- turn state ----
    let threadId: string | undefined;
    const gate = new CodexTurnGate();
    let turnDone = false as boolean;
    let turnStatus = undefined as string | undefined;
    let turnError = undefined as string | undefined;
    let finalAnswer = '';
    let lastAgentMessage = '';
    let totalTokens = undefined as number | undefined;
    let sawProgress = false as boolean;
    let timeoutError = undefined as string | undefined;
    const steps = new Map<string, SessionAgentStep>();
    /** Held approval requests: JSON-RPC id → method/params. */
    const heldApprovals = new Map<
      string,
      { id: unknown; method: string; params?: Json }
    >();
    let approvalChain: Promise<void> = Promise.resolve();
    let stopping = false;
    /** Thread token total before this turn, from the first usage update. */
    let tokenBaseline = undefined as number | undefined;
    let settle: (() => void) | undefined;
    const turnSettled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    function settleTurn() {
      settle?.();
    }
    let cancelled = false as boolean;
    /** `turn/start` was written: a cancel interrupts the turn from then on. */
    let turnRequested = false as boolean;
    /** The turn's id from the `turn/start` response, if `turn/started` lags. */
    let requestedTurnId = undefined as string | undefined;
    let interruptSent = false as boolean;
    /**
     * Interrupts the cancelled turn once its id is known (`turn/started`, or
     * the `turn/start` response), so codex records it as interrupted; then
     * stops waiting after `interruptMs`. Sent at most once.
     * TODO(multi-agent): verify against real codex CLI — `turn/interrupt`
     * params.
     */
    function interruptTurn() {
      const turnId = gate.turnId ?? requestedTurnId;
      if (!cancelled || interruptSent || !threadId || !turnId) return;
      interruptSent = true;
      void request(
        'turn/interrupt',
        { threadId, turnId },
        timeouts.interruptMs,
      ).catch(() => {});
    }

    // ---- timers (paused while an approval is held) ----
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    let firstProgressTimer: ReturnType<typeof setTimeout> | undefined;
    let timersArmed = false;
    const clearTimers = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (firstProgressTimer) clearTimeout(firstProgressTimer);
      inactivityTimer = undefined;
      firstProgressTimer = undefined;
    };
    const armTimers = () => {
      clearTimers();
      if (stopping || !timersArmed || turnDone || heldApprovals.size > 0)
        return;
      inactivityTimer = setTimeout(() => {
        timeoutError = `codex produced no activity for ${timeouts.inactivityMs}ms.`;
        settleTurn();
      }, timeouts.inactivityMs);
      inactivityTimer.unref?.();
      if (!sawProgress) {
        firstProgressTimer = setTimeout(() => {
          timeoutError = `codex made no progress within ${timeouts.firstTurnNoProgressMs}ms of starting the turn.`;
          settleTurn();
        }, timeouts.firstTurnNoProgressMs);
        firstProgressTimer.unref?.();
      }
    };

    const emitStep = (step: SessionAgentStep) => {
      steps.set(step.id, step);
      input.onEvent({ type: 'step', step });
    };

    const isOtherThread = (params: Json | undefined) => {
      const id = params?.['threadId'];
      return (
        typeof id === 'string' && threadId !== undefined && id !== threadId
      );
    };

    const handleItem = (method: string, params: Json | undefined) => {
      const item = asRecord(params?.['item']);
      if (!item) return;
      const type = item['type'];
      const id = typeof item['id'] === 'string' ? item['id'] : undefined;
      const status =
        typeof item['status'] === 'string' ? item['status'] : undefined;
      const finished: SessionAgentStep['status'] =
        status === 'failed' || status === 'declined' ? 'failed' : 'completed';
      if (type === 'agentMessage') {
        if (method !== 'item/completed') return;
        const text = typeof item['text'] === 'string' ? item['text'] : '';
        if (!text) return;
        lastAgentMessage = text;
        if (item['phase'] === 'final_answer') finalAnswer = text;
        input.onEvent({ type: 'text_delta', text });
        return;
      }
      if (type === 'reasoning' && method === 'item/completed') {
        // TODO(multi-agent): verify against real codex CLI — reasoning item
        // shape (`summary` / `content` arrays).
        const parts = [item['summary'], item['content']]
          .flatMap((value) => (Array.isArray(value) ? value : []))
          .map((part) =>
            typeof part === 'string'
              ? part
              : (nestedString(part, 'text') ?? ''),
          )
          .filter(Boolean);
        if (parts.length > 0)
          input.onEvent({ type: 'thought_delta', text: parts.join('\n') });
        return;
      }
      if (!id) return;
      let title: string | undefined;
      if (type === 'commandExecution') {
        const command = commandText(item['command']);
        title = command ? `exec_command: ${clip(command)}` : 'exec_command';
      } else if (type === 'fileChange') {
        const changes = Array.isArray(item['changes'])
          ? item['changes'].length
          : 0;
        title = `patch_apply: ${changes} file${changes === 1 ? '' : 's'}`;
      } else if (type === 'mcpToolCall') {
        const tool =
          typeof item['tool'] === 'string' && item['tool'].trim()
            ? item['tool']
            : 'mcp_tool';
        title = clip(tool);
      }
      if (!title) return;
      emitStep({
        id,
        title: steps.get(id)?.title ?? title,
        status: method === 'item/started' ? 'running' : finished,
      });
    };

    const handleNotification = (method: string, params: Json | undefined) => {
      if (isOtherThread(params)) return;
      if (!gate.accept(method, params)) return;
      if (method.startsWith('item/')) {
        sawProgress = true;
        armTimers();
        handleItem(method, params);
        return;
      }
      armTimers();
      switch (method) {
        case 'turn/started':
          // A cancel that landed while `turn/start` was in flight.
          interruptTurn();
          return;
        case 'turn/completed': {
          if (turnDone) return;
          turnDone = true;
          const turn = asRecord(params?.['turn']);
          turnStatus = nestedString(turn, 'status');
          if (turnStatus === 'failed') {
            turnError ??=
              nestedString(turn, 'error', 'message') || 'codex turn failed';
          }
          // TODO(multi-agent): verify against real codex CLI — where the
          // turn's token usage is reported (Multica scans rollout files).
          const usage = asRecord(turn?.['usage']);
          if (usage) {
            const total =
              (typeof usage['total_tokens'] === 'number'
                ? usage['total_tokens']
                : 0) ||
              Number(usage['input_tokens'] ?? 0) +
                Number(usage['output_tokens'] ?? 0);
            if (total > 0) {
              totalTokens = total;
              input.onEvent({ type: 'usage', totalTokens: total });
            }
          }
          clearTimers();
          settleTurn();
          return;
        }
        case 'thread/tokenUsage/updated': {
          // TODO(multi-agent): verify against real codex CLI — this
          // notification and its `tokenUsage.total` / `.last` shape. The
          // run's tokens are the thread total minus the total before the
          // first update of this turn.
          const usage = asRecord(params?.['tokenUsage']);
          const total = nestedNumber(usage, 'total', 'totalTokens');
          if (total === undefined) return;
          const last = nestedNumber(usage, 'last', 'totalTokens') ?? 0;
          tokenBaseline ??= Math.max(0, total - last);
          const turnTokens = total - tokenBaseline;
          if (turnTokens > 0) {
            totalTokens = turnTokens;
            input.onEvent({ type: 'usage', totalTokens: turnTokens });
          }
          return;
        }
        case 'error': {
          if (params?.['willRetry'] === true) return;
          const message =
            nestedString(params, 'error', 'message') ??
            nestedString(params, 'message');
          if (message) turnError ??= message;
          return;
        }
        default:
          return;
      }
    };

    const handleServerRequest = (
      id: unknown,
      method: string,
      params: Json | undefined,
    ) => {
      const prompt = codexApprovalPrompt(String(id), method, params);
      if (!prompt) {
        const message = `unsupported codex app-server request: ${method}`;
        turnError ??= message;
        write({ id, error: { code: JSON_RPC_METHOD_NOT_FOUND, message } });
        return;
      }
      const key = prompt.requestId;
      heldApprovals.set(key, { id, method, params });
      clearTimers();
      // One approval is put to the person at a time (the orchestrator keeps
      // one pending prompt per run); later ones wait here, unannounced, with
      // their JSON-RPC ids still held.
      // TODO(multi-agent): verify against real codex CLI — whether approval
      // requests can be outstanding concurrently.
      approvalChain = approvalChain
        .then(async () => {
          if (!heldApprovals.has(key)) return;
          input.onEvent({ type: 'permission_request', prompt });
          const optionId = await input
            .awaitPermission(prompt)
            .catch(() => undefined);
          answer(key, optionId);
        })
        .catch(() => {
          // Keep the chain alive for later requests.
        });
    };

    const answer = (key: string, optionId: string | undefined) => {
      const held = heldApprovals.get(key);
      if (!held) return;
      heldApprovals.delete(key);
      write({
        id: held.id,
        result: codexApprovalResponse(held.method, held.params, optionId),
      });
      input.onEvent({ type: 'permission_resolved', requestId: key });
      armTimers();
    };

    const handleLine = (raw: string) => {
      let message: Json;
      try {
        message = JSON.parse(raw) as Json;
      } catch {
        return;
      }
      const method =
        typeof message['method'] === 'string' ? message['method'] : undefined;
      const params = asRecord(message['params']);
      if (
        'id' in message &&
        message['id'] !== null &&
        message['id'] !== undefined
      ) {
        if (method) {
          handleServerRequest(message['id'], method, params);
          return;
        }
        const id = Number(message['id']);
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        const error = asRecord(message['error']);
        if (error) {
          entry.reject(
            new CodexRpcError(
              entry.method,
              typeof error['code'] === 'number' ? error['code'] : undefined,
              typeof error['message'] === 'string' ? error['message'] : 'error',
            ),
          );
        } else {
          entry.resolve(message['result']);
        }
        return;
      }
      if (method) handleNotification(method, params);
    };

    const reading = child.stdout
      ? readJsonLines(child.stdout, handleLine, maxLineBytes).then(
          () =>
            failTransport(new CodexTransportError('codex closed its output.')),
          (error) =>
            failTransport(
              error instanceof LineTooLongError
                ? new CodexTransportError(error.message, true)
                : new CodexTransportError(String(error)),
            ),
        )
      : Promise.resolve();
    child.on('error', (error) =>
      failTransport(
        new CodexTransportError(
          `Could not start codex (${executable}): ${error.message}`,
        ),
      ),
    );
    void waitForExit(child).then(() =>
      failTransport(new CodexTransportError('codex exited.')),
    );

    const onAbort = () => {
      cancelled = true;
      if (!turnRequested) {
        // No turn yet (initialize, thread/resume, thread/start): unwind now.
        // Pending requests reject, and `request` refuses every later one, so
        // the prompt is never sent with `turn/start`; `failed` reports
        // `cancelled` and stops the process.
        failTransport(new CodexTransportError('codex turn cancelled.'));
        return;
      }
      // Interrupt the turn so codex records it as interrupted (now, or once
      // its id arrives), then stop.
      interruptTurn();
      // No turn id by then (`turn/start` still unanswered): unwind instead of
      // waiting out its handshake timeout.
      const timer = setTimeout(() => {
        if (interruptSent) settleTurn();
        else failTransport(new CodexTransportError('codex turn cancelled.'));
      }, timeouts.interruptMs);
      timer.unref?.();
    };
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener('abort', onAbort, { once: true });

    const stop = async () => {
      stopping = true;
      input.signal.removeEventListener('abort', onAbort);
      clearTimers();
      // Never leave codex waiting on a held approval.
      for (const key of [...heldApprovals.keys()]) answer(key, undefined);
      await terminateAgentProcess(child, timeouts.terminateGraceMs);
      await reading;
    };
    const stderrSuffix = () => {
      const tail = stderr.toString().trim();
      return tail ? `\n${tail.slice(-2_000)}` : '';
    };
    const failed = async (
      error: string,
      retryFresh = false,
    ): Promise<AttemptOutcome> => {
      await stop();
      return {
        result: {
          status: cancelled ? 'cancelled' : 'failed',
          outputText: finalAnswer || lastAgentMessage,
          ...(cancelled ? {} : { error: `${error}${stderrSuffix()}` }),
          ...(threadId ? { nativeSessionId: threadId } : {}),
        },
        retryFresh,
      };
    };

    try {
      await request(
        'initialize',
        {
          clientInfo: { name: 'qwen-code', title: 'Qwen Code', version: '1' },
          capabilities: { experimentalApi: true },
        },
        timeouts.handshakeMs,
      );
    } catch (error) {
      return failed(`codex initialize failed: ${(error as Error).message}`);
    }
    notify('initialized');

    let resumeRejected = false;
    // A thread started here (no resume requested, or the resume refused)
    // holds none of the history the delta assumes.
    let startedFresh = false;
    if (resumeThreadId) {
      try {
        const result = await request(
          'thread/resume',
          {
            threadId: resumeThreadId,
            cwd: input.cwd,
            model: input.model ?? null,
            // Re-asserted on every resume rather than trusted to persist with
            // the thread: the approval contract must not rest on codex
            // keeping these across resumes (see thread/start below). A codex
            // that refuses the fields falls back to a fresh thread, which
            // carries them.
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
          },
          timeouts.threadSetupMs,
        );
        threadId = nestedString(result, 'thread', 'id');
      } catch (error) {
        if (error instanceof CodexTransportError) {
          // A resume response too large for the line cap means the thread
          // cannot be handed to us at all (and the process is now wedged
          // writing it): retire it and start over in a new process.
          return failed(
            `codex thread/resume failed: ${error.message}`,
            error.overflow,
          );
        }
        // Unknown thread, schema drift, ...: fall back to a fresh thread.
      }
      if (!threadId) resumeRejected = true;
    }
    if (!threadId) {
      try {
        const result = await request(
          'thread/start',
          {
            model: input.model ?? null,
            cwd: input.cwd,
            approvalPolicy: 'on-request',
            // Pinned to read-only (session-multi-agent design §8-1; the contract in the file
            // header): every write, and every command that must leave the
            // read-only sandbox, is escalated and asks the person in the
            // session; read-only commands inside the sandbox run without
            // asking. Under `workspace-write`, `on-request` would let writes
            // inside the workspace through without asking.
            // Observed with codex 0.155.1 (acceptance 2.5): `ls` ran without
            // a prompt; apply_patch asked, and allow / reject were honoured.
            // thread/resume re-sends both pins.
            sandbox: 'read-only',
            // TODO(multi-agent): verify against real codex CLI — that
            // `developerInstructions` carries the persona and persists with
            // the thread across resumes.
            developerInstructions: input.instructions ?? null,
            persistExtendedHistory: true,
          },
          timeouts.threadSetupMs,
        );
        threadId = nestedString(result, 'thread', 'id');
      } catch (error) {
        return failed(`codex thread/start failed: ${(error as Error).message}`);
      }
      if (!threadId) return failed('codex thread/start returned no thread id.');
      startedFresh = true;
    }
    input.onEvent({ type: 'native_session', nativeSessionId: threadId });

    gate.arm();
    turnRequested = true;
    try {
      const started = await request(
        'turn/start',
        {
          threadId,
          input: [
            {
              type: 'text',
              text: startedFresh
                ? (input.freshPrompt ?? input.prompt)
                : input.prompt,
            },
          ],
        },
        timeouts.handshakeMs,
      );
      requestedTurnId = nestedString(started, 'turn', 'id');
      interruptTurn();
    } catch (error) {
      if (!turnDone)
        return failed(`codex turn/start failed: ${(error as Error).message}`);
    }
    timersArmed = true;
    armTimers();

    await turnSettled;
    await stop();

    const outputText = finalAnswer || lastAgentMessage;
    const base = {
      outputText,
      nativeSessionId: threadId,
      ...(resumeRejected ? { resumeRejected: true } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
    };
    if (cancelled)
      return { result: { status: 'cancelled', ...base }, retryFresh: false };
    if (!turnDone) {
      const reason =
        timeoutError ??
        transportError?.message ??
        'codex ended without completing the turn.';
      return {
        result: {
          status: 'failed',
          ...base,
          error: `${reason}${stderrSuffix()}`,
        },
        retryFresh: false,
      };
    }
    const interrupted =
      turnStatus === 'cancelled' ||
      turnStatus === 'canceled' ||
      turnStatus === 'aborted' ||
      turnStatus === 'interrupted';
    if (interrupted || turnError) {
      return {
        result: {
          status: 'failed',
          ...base,
          error: turnError ?? 'codex turn was interrupted.',
        },
        retryFresh: false,
      };
    }
    return { result: { status: 'completed', ...base }, retryFresh: false };
  };

  return {
    program: 'codex',
    async runTurn(
      input: AgentAdapterTurnInput,
    ): Promise<AgentAdapterTurnResult> {
      const first = await attempt(input, input.nativeSessionId);
      if (!first.retryFresh || input.signal.aborted) return first.result;
      const second = await attempt(input, undefined);
      return { ...second.result, resumeRejected: true };
    },
  };
}
