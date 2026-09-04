/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Routes realtime function calls to handlers and turns whatever happens —
 * success, handler error, bad arguments, timeout — into a JSON receipt
 * string. No call is ever left unanswered: an unanswered function call
 * would stall the realtime response arbitration.
 */

/**
 * Generous by design: the timeout is a last-resort answer for the model,
 * not a cancellation — the handler keeps running and its side effects
 * (a created job, a submitted prompt) stay real. The receipt wording must
 * therefore steer the model away from retrying.
 */
const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;
const TIMEOUT_NOTE =
  'The action is still running in the background and may yet finish. Do ' +
  'not retry the call; check on it with session_monitor.';

/** Per-call context threaded through from the realtime function-call event. */
export interface ToolContext {
  /** Transcript tail captured at call time (capturesTranscript tools). */
  activeTranscript: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

export interface ToolDispatchResult {
  /** JSON receipt to submit as the function call output. */
  receipt: string;
  ok: boolean;
}

export interface ToolDispatcherOptions {
  handlers: ReadonlyMap<string, ToolHandler>;
  timeoutMs?: number;
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    /* fall through to the lenient default */
  }
  return {};
}

class ToolTimeoutError extends Error {
  constructor() {
    super('tool handler timed out');
    this.name = 'ToolTimeoutError';
  }
}

export class ToolDispatcher {
  private readonly handlers: ReadonlyMap<string, ToolHandler>;
  private readonly timeoutMs: number;

  constructor(options: ToolDispatcherOptions) {
    this.handlers = options.handlers;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
  }

  async dispatch(
    name: string,
    rawArguments: string,
    ctx: ToolContext,
  ): Promise<ToolDispatchResult> {
    const handler = this.handlers.get(name);
    if (!handler) {
      return {
        ok: false,
        receipt: JSON.stringify({
          status: 'error',
          note: `No handler for tool ${name}.`,
        }),
      };
    }
    const args = parseArguments(rawArguments);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        Promise.resolve(handler(args, ctx)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new ToolTimeoutError());
          }, this.timeoutMs);
          timer.unref?.();
        }),
      ]);
      return { ok: true, receipt: JSON.stringify(outcome) };
    } catch (error) {
      if (error instanceof ToolTimeoutError) {
        return {
          ok: false,
          receipt: JSON.stringify({ status: 'pending', note: TIMEOUT_NOTE }),
        };
      }
      return {
        ok: false,
        receipt: JSON.stringify({
          status: 'error',
          note:
            error instanceof Error && error.message
              ? error.message.slice(0, 300)
              : 'the tool failed',
        }),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
