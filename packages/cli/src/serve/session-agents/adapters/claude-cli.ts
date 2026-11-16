/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview The `claude` program adapter: one Claude Code process per
 * turn, in `-p` stream-json mode, resumed with `--resume <session_id>`.
 *
 * Follows Multica's claude backend (server/pkg/agent/claude.go) for the
 * process shape, event mapping, resume-rejection detection and cancel
 * sequence, with one deliberate difference: Multica runs with
 * `--permission-mode bypassPermissions` and answers every `control_request`
 * with allow. Here permissions are NOT bypassed: the CLI runs in its default
 * mode with `--permission-prompt-tool stdio`, and each `can_use_tool`
 * request is relayed to the person through `awaitPermission`.
 * Because Claude does not run with bypass, Multica's root/sudo preflight
 * (`IS_SANDBOX=1`) does not apply.
 *
 * Approval contract: `--permission-mode default` asks for every edit and
 * every Bash command unless the user's own Claude settings
 * (`permissions.allow` in their settings.json, or the project's) already
 * allow it; an allowed tool runs without a question in the session, as it
 * would in their terminal. Read-only tools (Read, Grep, Glob) do not ask by
 * default.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentAdapter,
  AgentAdapterTurnInput,
  AgentAdapterTurnResult,
  SessionAgentPermissionPrompt,
  SessionAgentStep,
} from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';
import {
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

/** Env var naming the claude executable (also read by the program probe). */
export const CLAUDE_PATH_ENV = 'QWEN_AGENT_CLAUDE_PATH';
/** MCP server name the `session_send` tool is exposed under. */
export const SESSION_SEND_MCP_SERVER_NAME = 'qwen-session';
const DEFAULT_TERMINATE_GRACE_MS = 5_000;
const STDOUT_DRAIN_GRACE_MS = 2_000;
const MAX_INPUT_PREVIEW_CHARS = 2_000;
const MAX_TITLE_SUMMARY_CHARS = 160;
const MAX_STEP_TITLE_CHARS = 200;

/**
 * Provider messages that positively identify a refused `--resume`
 * (Multica `resumeRejectedPhrases`; the account-binding wordings are kept
 * because they are what forces a fresh session after an account switch).
 */
const RESUME_REJECTED_PHRASES = [
  'no conversation found',
  'no saved session found',
  '已绑定另外',
  'bound to another account',
  'bound to a different account',
];

/** Claude's structured "context window exhausted" terminal reason. */
const PROMPT_TOO_LONG = 'prompt_too_long';

export interface ClaudeCliAdapterOptions {
  /** Path or name of the claude CLI; defaults to `claude` on PATH. */
  executable?: string;
  /** Base environment for the child; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Test seams. */
  spawn?: AgentSpawn;
  terminateGraceMs?: number;
}

export function buildClaudeArgs(options: {
  model?: string;
  resumeSessionId?: string;
  instructions?: string;
  mcpConfigPath?: string;
}): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose',
    // TODO(multi-agent): verify against real claude CLI — that `default` mode
    // plus `--permission-prompt-tool stdio` emits `control_request` /
    // `can_use_tool` on stdout for every tool needing approval, and that the
    // allow / deny `control_response` below is honored (session-multi-agent design §9.4). Tools the
    // user's settings already allow never reach us.
    '--permission-mode',
    'default',
    '--permission-prompt-tool',
    'stdio',
    // No UI can render Claude's own question tool in -p mode (Multica #2588).
    '--disallowedTools',
    'AskUserQuestion',
  ];
  if (options.model) args.push('--model', options.model);
  if (options.resumeSessionId) {
    args.push('--resume', options.resumeSessionId);
  } else if (options.instructions) {
    // TODO(multi-agent): verify against real claude CLI — the system prompt
    // is rebuilt per process, so a persona appended only on the fresh turn is
    // probably absent on resumed turns. The contract says "applied on a fresh
    // session"; if the persona is lost, pass it on every turn instead.
    args.push('--append-system-prompt', options.instructions);
  }
  if (options.mcpConfigPath) {
    // Adds our server next to the user's own. Multica also passes
    // `--strict-mcp-config` because it REPLACES the user's servers; we do not.
    // TODO(multi-agent): verify against real claude CLI — that a project
    // `.mcp.json` server is not silently dropped or prompted for in -p mode.
    args.push('--mcp-config', options.mcpConfigPath);
  }
  return args;
}

/** The single stdin line that carries the user turn. */
export function buildClaudeUserMessage(prompt: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: prompt }] },
  })}\n`;
}

export function claudeResumeWasRejected(
  requested: string | undefined,
  emitted: string | undefined,
  failed: boolean,
  texts: readonly string[],
): boolean {
  if (!failed || !requested) return false;
  for (const text of texts) {
    const lower = text.toLowerCase();
    if (RESUME_REJECTED_PHRASES.some((phrase) => lower.includes(phrase))) {
      return true;
    }
  }
  return Boolean(emitted && emitted !== requested);
}

/** One-line summary of a tool input for titles. */
export function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  for (const key of [
    'command',
    'file_path',
    'path',
    'notebook_path',
    'pattern',
    'url',
    'query',
    'description',
  ]) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      const line = value.trim().replace(/\s+/g, ' ');
      return line.length > MAX_TITLE_SUMMARY_CHARS
        ? `${line.slice(0, MAX_TITLE_SUMMARY_CHARS)}…`
        : line;
    }
  }
  return '';
}

function toolTitle(name: string, input: unknown): string {
  const summary = summarizeToolInput(input);
  return (summary ? `${name}: ${summary}` : name).slice(
    0,
    MAX_STEP_TITLE_CHARS,
  );
}

/**
 * Forces `run_in_background: true` to false (Multica: managed runs are
 * foreground).
 * TODO(multi-agent): verify against real claude CLI — a tool the user's
 * settings already allow never reaches `can_use_tool`, so its background
 * flag cannot be rewritten here; the process ends at `result` regardless.
 */
function forceForeground(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return input['run_in_background'] === true
    ? { ...input, run_in_background: false }
    : input;
}

// No "always": claude would need `updatedPermissions` for that (unverified,
// see below), so the option would act as allow once under another name.
const PERMISSION_OPTIONS: SessionAgentPermissionPrompt['options'] = [
  { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
];

// TODO(multi-agent): model-facing text — needs eval before release
const DENIED_MESSAGE = 'The user denied this tool call.';
// TODO(multi-agent): model-facing text — needs eval before release
const RUN_ENDED_MESSAGE =
  'The run ended before the user answered this permission request.';

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ClaudeLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: ClaudeContentBlock[] | string };
  result?: string;
  is_error?: boolean;
  terminal_reason?: string;
  usage?: ClaudeUsage;
  request_id?: string;
  request?: {
    subtype?: string;
    tool_name?: string;
    input?: unknown;
  };
}

export function claudeUsageTotal(
  usage: ClaudeUsage | undefined,
): number | undefined {
  if (!usage) return undefined;
  // TODO(multi-agent): verify against real claude CLI — whether `modelUsage`
  // (per model, includes sub-agents) should be preferred over `usage`.
  const total =
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0);
  return total > 0 ? total : undefined;
}

interface AttemptOutcome {
  result: AgentAdapterTurnResult;
  /** The requested resume was refused (or the session is saturated). */
  retireSession: boolean;
  toolUses: number;
}

export function createClaudeCliAdapter(
  options: ClaudeCliAdapterOptions = {},
): AgentAdapter {
  const executable = options.executable || 'claude';
  const baseEnv = options.env ?? process.env;
  const spawnProcess = options.spawn ?? spawnAgentProcess;
  const graceMs = options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS;

  const attempt = async (
    input: AgentAdapterTurnInput,
    resumeSessionId: string | undefined,
    mcpConfigPath: string | undefined,
  ): Promise<AttemptOutcome> => {
    const args = buildClaudeArgs({
      model: input.model,
      resumeSessionId,
      instructions: input.instructions,
      mcpConfigPath,
    });
    let child: AgentProcess;
    try {
      child = spawnProcess(executable, args, {
        cwd: input.cwd,
        env: scrubAgentEnv(baseEnv),
      });
    } catch (error) {
      return {
        result: {
          status: 'failed',
          outputText: '',
          error: `Could not start claude (${executable}): ${(error as Error).message}`,
        },
        retireSession: false,
        toolUses: 0,
      };
    }

    // Assigned from callbacks: typed initializers keep TypeScript from
    // narrowing these to their initial value in the code after the awaits.
    let spawnError = undefined as Error | undefined;
    const exited = new Promise<void>((resolve) => {
      child.on('error', (error) => {
        spawnError = error;
        resolve();
      });
      void waitForExit(child).then(resolve);
    });

    const stderr = new TailBuffer();
    child.stderr?.on('data', (chunk: Buffer) => stderr.append(chunk));
    child.stdin?.on('error', () => {
      // EPIPE after the child exits; the exit path reports the failure.
    });

    let sessionId = undefined as string | undefined;
    let lastAssistantText = '';
    let resultText = undefined as string | undefined;
    let sawResult = false as boolean;
    let resultIsError = false as boolean;
    let terminalReason = undefined as string | undefined;
    let totalTokens = undefined as number | undefined;
    let toolUses = 0;
    const steps = new Map<string, SessionAgentStep>();
    /** Unanswered can_use_tool requests → withdraws the wait for one. */
    const openPermissions = new Map<string, () => void>();
    /**
     * One permission is put to the person at a time: the orchestrator keeps
     * one pending prompt per run, so a second concurrent request would be
     * unanswerable. Later requests wait here, unannounced.
     * TODO(multi-agent): verify against real claude CLI — whether it issues
     * can_use_tool requests concurrently (parallel tool_use blocks).
     */
    let permissionChain: Promise<void> = Promise.resolve();
    const withdrawAllPermissions = () => {
      for (const withdraw of openPermissions.values()) withdraw();
      openPermissions.clear();
    };

    const send = (payload: unknown) => {
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed || stdin.writableEnded) return;
      stdin.write(`${JSON.stringify(payload)}\n`);
    };
    const closeStdin = () => {
      try {
        child.stdin?.end();
      } catch {
        // Already closed.
      }
    };

    const emitStep = (step: SessionAgentStep) => {
      steps.set(step.id, step);
      input.onEvent({ type: 'step', step });
    };

    const handleControlRequest = (line: ClaudeLine) => {
      const requestId = line.request_id;
      if (!requestId) return;
      const request = line.request ?? {};
      if (request.subtype !== 'can_use_tool') {
        // Never answer an unknown request with allow.
        // TODO(multi-agent): verify against real claude CLI — the error
        // `control_response` shape.
        send({
          type: 'control_response',
          response: {
            subtype: 'error',
            request_id: requestId,
            error: `Unsupported control request: ${request.subtype ?? 'unknown'}`,
          },
        });
        return;
      }
      const toolName = request.tool_name ?? 'tool';
      const toolInput =
        request.input && typeof request.input === 'object'
          ? (request.input as Record<string, unknown>)
          : {};
      // What runs if allowed: the person approves this input, not the one
      // claude asked with (a background flag is forced off before showing).
      const executedInput = forceForeground(toolInput);
      const inputPreview = previewJson(executedInput, MAX_INPUT_PREVIEW_CHARS);
      const prompt: SessionAgentPermissionPrompt = {
        requestId,
        title: toolTitle(toolName, executedInput),
        toolName,
        ...(inputPreview ? { inputPreview } : {}),
        options: PERMISSION_OPTIONS,
      };
      let withdraw!: () => void;
      const withdrawn = new Promise<'withdrawn'>((resolve) => {
        withdraw = () => resolve('withdrawn');
      });
      openPermissions.set(requestId, withdraw);
      permissionChain = permissionChain
        .then(async () => {
          if (!openPermissions.has(requestId)) return;
          input.onEvent({ type: 'permission_request', prompt });
          const decision = await Promise.race([
            withdrawn,
            input.awaitPermission(prompt).then(
              (optionId) => {
                if (optionId === 'allow_once' || optionId === 'allow_always') {
                  // TODO(multi-agent): verify against real claude CLI — mapping
                  // allow_always to `updatedPermissions` (from the request's
                  // `permission_suggestions`) so Claude stops asking; today it
                  // is treated as allow once.
                  return {
                    behavior: 'allow',
                    updatedInput: executedInput,
                  };
                }
                return { behavior: 'deny', message: DENIED_MESSAGE };
              },
              () => ({ behavior: 'deny', message: RUN_ENDED_MESSAGE }),
            ),
          ]);
          if (decision === 'withdrawn' || !openPermissions.delete(requestId)) {
            return;
          }
          send({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: requestId,
              response: decision,
            },
          });
          input.onEvent({ type: 'permission_resolved', requestId });
        })
        .catch(() => {
          // Keep the chain alive for later requests.
        });
    };

    const handleLine = (raw: string) => {
      let line: ClaudeLine;
      try {
        line = JSON.parse(raw) as ClaudeLine;
      } catch {
        return; // Banner or other non-JSON output.
      }
      switch (line.type) {
        case 'system':
          if (line.session_id && line.session_id !== sessionId) {
            sessionId = line.session_id;
            input.onEvent({
              type: 'native_session',
              nativeSessionId: sessionId,
            });
          }
          break;
        case 'assistant': {
          const content = line.message?.content;
          if (!Array.isArray(content)) break;
          let text = '';
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              text += block.text;
              // stream-json without partial messages has no deltas: the
              // whole block is one delta.
              input.onEvent({ type: 'text_delta', text: block.text });
            } else if (block.type === 'thinking') {
              const thought = block.thinking ?? block.text;
              if (thought)
                input.onEvent({ type: 'thought_delta', text: thought });
            } else if (block.type === 'tool_use' && block.id) {
              toolUses += 1;
              emitStep({
                id: block.id,
                title: toolTitle(block.name ?? 'tool', block.input),
                status: 'running',
              });
            }
          }
          if (text) lastAssistantText = text;
          break;
        }
        case 'user': {
          const content = line.message?.content;
          if (!Array.isArray(content)) break;
          for (const block of content) {
            if (block.type !== 'tool_result' || !block.tool_use_id) continue;
            const previous = steps.get(block.tool_use_id);
            emitStep({
              id: block.tool_use_id,
              title: previous?.title ?? 'tool',
              status: block.is_error ? 'failed' : 'completed',
            });
          }
          break;
        }
        case 'result':
          sawResult = true;
          resultText = line.result;
          resultIsError = line.is_error === true;
          terminalReason = line.terminal_reason;
          if (line.session_id) sessionId = line.session_id;
          totalTokens = claudeUsageTotal(line.usage) ?? totalTokens;
          if (totalTokens !== undefined) {
            input.onEvent({ type: 'usage', totalTokens });
          }
          closeStdin();
          break;
        case 'control_request':
          handleControlRequest(line);
          break;
        case 'control_cancel_request': {
          // TODO(multi-agent): verify against real claude CLI — whether it
          // withdraws a pending can_use_tool this way.
          const requestId = line.request_id;
          const withdraw = requestId
            ? openPermissions.get(requestId)
            : undefined;
          if (requestId && withdraw) {
            openPermissions.delete(requestId);
            withdraw();
            input.onEvent({ type: 'permission_resolved', requestId });
          }
          break;
        }
        default:
          break;
      }
    };

    const reading = child.stdout
      ? readJsonLines(child.stdout, handleLine).catch(() => {
          // An oversized line ends the read; the exit path reports it.
        })
      : Promise.resolve();

    // Written from its own task, after the reader is attached: with
    // --verbose the CLI writes a banner before reading stdin, and a writer
    // that blocks the reader deadlocks (Multica claude.go). stdin then stays
    // open for control_response lines until `result` arrives.
    setImmediate(() => {
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed || stdin.writableEnded) return;
      // A fresh session after a refused resume holds none of the history
      // the delta assumes: it gets the conversation from the start.
      stdin.write(
        buildClaudeUserMessage(
          resumeSessionId ? input.prompt : (input.freshPrompt ?? input.prompt),
        ),
      );
    });

    let aborted = false as boolean;
    const onAbort = () => {
      aborted = true;
      void terminateAgentProcess(child, graceMs);
    };
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener('abort', onAbort, { once: true });

    await exited;
    // A descendant that inherited stdout (a background shell) can hold it
    // open after claude exits; stop reading after a short grace.
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      reading,
      new Promise<void>((resolve) => {
        graceTimer = setTimeout(resolve, STDOUT_DRAIN_GRACE_MS);
        graceTimer.unref?.();
      }),
    ]);
    if (graceTimer) clearTimeout(graceTimer);
    child.stdout?.destroy();
    await reading;
    input.signal.removeEventListener('abort', onAbort);
    withdrawAllPermissions();

    const stderrTail = stderr.toString().trim();
    const fallbackText = resultText?.trim() ? resultText : lastAssistantText;
    const withSession = (
      result: AgentAdapterTurnResult,
    ): AgentAdapterTurnResult => ({
      ...result,
      ...(sessionId ? { nativeSessionId: sessionId } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
    });

    if (aborted) {
      return {
        result: withSession({
          status: 'cancelled',
          outputText: lastAssistantText,
        }),
        retireSession: false,
        toolUses,
      };
    }
    if (spawnError) {
      return {
        result: {
          status: 'failed',
          outputText: '',
          error: `Could not start claude (${executable}): ${spawnError.message}`,
        },
        retireSession: false,
        toolUses,
      };
    }

    let failure: string | undefined;
    let overflow = false;
    if (!sawResult) {
      failure = `claude exited without a result${
        child.exitCode !== null ? ` (exit code ${child.exitCode})` : ''
      }.`;
    } else if (terminalReason === PROMPT_TOO_LONG) {
      // Arrives with is_error false as often as true (Multica GH #6402).
      overflow = true;
      failure =
        "claude ended the turn with terminal_reason=prompt_too_long: the session's context window is exhausted.";
    } else if (resultIsError) {
      failure = resultText?.trim() || 'claude reported an error.';
    }

    if (failure === undefined) {
      return {
        result: withSession({ status: 'completed', outputText: fallbackText }),
        retireSession: false,
        toolUses,
      };
    }
    const error = stderrTail
      ? `${failure}\n${stderrTail.slice(-2_000)}`
      : failure;
    const rejected = claudeResumeWasRejected(resumeSessionId, sessionId, true, [
      failure,
      stderrTail,
    ]);
    const retire = rejected || (overflow && Boolean(resumeSessionId));
    return {
      result: {
        status: 'failed',
        outputText: lastAssistantText,
        error,
        // A rejected session must not be persisted as the resume pointer.
        ...(sessionId && !rejected ? { nativeSessionId: sessionId } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {}),
      },
      retireSession: retire,
      toolUses,
    };
  };

  return {
    program: 'claude',
    async runTurn(
      input: AgentAdapterTurnInput,
    ): Promise<AgentAdapterTurnResult> {
      let mcpDir: string | undefined;
      let mcpConfigPath: string | undefined;
      try {
        if (input.sessionSendServer) {
          mcpDir = await mkdtemp(join(tmpdir(), 'qwen-agent-mcp-'));
          mcpConfigPath = join(mcpDir, 'mcp-config.json');
          const server = input.sessionSendServer;
          await writeFile(
            mcpConfigPath,
            JSON.stringify({
              mcpServers: {
                [SESSION_SEND_MCP_SERVER_NAME]: {
                  command: server.command,
                  args: server.args,
                  ...(server.env ? { env: server.env } : {}),
                },
              },
            }),
            { mode: 0o600 },
          );
        }
        const first = await attempt(
          input,
          input.nativeSessionId,
          mcpConfigPath,
        );
        if (
          !first.retireSession ||
          input.signal.aborted ||
          first.toolUses > 0
        ) {
          return {
            ...first.result,
            ...(first.retireSession ? { resumeRejected: true } : {}),
          };
        }
        // The resume was refused (or the session is saturated) before any
        // tool ran: start over in a fresh session, as Multica does.
        // TODO(multi-agent): the contract cannot retire a native session
        // whose failed turn already ran tools; the next turn retries the
        // resume, fails fast without tools, and lands here.
        const second = await attempt(input, undefined, mcpConfigPath);
        return { ...second.result, resumeRejected: true };
      } catch (error) {
        return {
          status: 'failed',
          outputText: '',
          error: (error as Error).message,
        };
      } finally {
        if (mcpDir)
          await rm(mcpDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
