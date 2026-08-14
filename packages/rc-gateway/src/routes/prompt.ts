/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { PromptContentBlock } from '@qwen-code/sdk';
import type { SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import { PromptQueue, QueueTimeoutError } from './promptQueue.js';
import type { PromptEventBroadcaster } from './promptEventBroadcaster.js';

/**
 * POST /session/:id/prompt — proxy the SDK's daemon.prompt(). Accepts either
 * `{ prompt: string }` (turned into a single text block) or
 * `{ blocks: PromptContentBlock[] }` (forwarded verbatim). Long-lived: awaits
 * the daemon's turn and returns its stopReason. A client disconnect aborts the
 * daemon prompt (no response written). The prompt text is NEVER audited.
 *
 * Session FIFO + timeouts (spec "Per-session FIFO preserved"):
 *  - Each session has a single-slot queue (`PromptQueue`). A prompt that
 *    cannot acquire the slot within `queueWaitMs` receives 503 `queue_timeout`.
 *  - Once executing, if the daemon call does not complete within `promptTimeoutMs`
 *    the turn is cancelled via AbortController, a synthetic `stream_error` event
 *    with `{ code: "prompt_timeout" }` is broadcast to all SSE subscribers via
 *    the `PromptEventBroadcaster`, and the queue slot is released.
 */
/** Records the originator of a session's turn, for cost attribution. */
export type PromptAcceptedHook = (
  sessionId: string,
  attribution: { attributionTokenId: string; subActor: string | null },
) => void;

/** Shared singleton queue (module-level so all route instances share state). */
const sharedQueue = new PromptQueue();

export interface PromptRouteOptions {
  /** ms to wait for the per-session slot before returning 503 (default: 120_000). */
  queueWaitMs?: number;
  /** ms budget for the daemon turn before it is cancelled (default: 600_000). */
  promptTimeoutMs?: number;
  /**
   * Broadcaster for gateway-injected SSE events (e.g. `stream_error` on prompt
   * timeout). When omitted, timeout cancellation still happens but no synthetic
   * event is emitted to SSE subscribers.
   */
  promptEventBroadcaster?: PromptEventBroadcaster;
  /**
   * Override the shared PromptQueue (for tests that need isolated queues).
   */
  queue?: PromptQueue;
}

export function createPromptRoute(
  daemon: SessionDaemon,
  audit?: AuditRecorder,
  onAccepted?: PromptAcceptedHook,
  opts: PromptRouteOptions = {},
): RequestHandler {
  const queueWaitMs = opts.queueWaitMs ?? 120_000;
  const promptTimeoutMs = opts.promptTimeoutMs ?? 600_000;
  const broadcaster = opts.promptEventBroadcaster;
  const queue = opts.queue ?? sharedQueue;

  return async (req, res) => {
    const sessionId = req.params.id;
    const body = (req.body ?? {}) as { prompt?: unknown; blocks?: unknown };

    let blocks: PromptContentBlock[];
    if (typeof body.prompt === 'string' && body.prompt.length > 0) {
      blocks = [{ type: 'text', text: body.prompt }];
    } else if (Array.isArray(body.blocks) && body.blocks.length > 0) {
      blocks = body.blocks as PromptContentBlock[];
    } else {
      res.status(400).json({ error: 'Invalid prompt', code: 'invalid_prompt' });
      return;
    }

    // ── Queue-wait: acquire the per-session FIFO slot ────────────────────────
    let release: (() => void) | undefined;
    try {
      release = await queue.acquire(sessionId, queueWaitMs);
    } catch (err) {
      if (err instanceof QueueTimeoutError) {
        res.status(503).json({ error: 'queue_timeout', code: 'queue_timeout' });
        return;
      }
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }

    // ── We hold the slot — run the daemon turn ───────────────────────────────
    try {
      // Capture attribution BEFORE the turn: the usage events the ingester
      // prices arrive WHILE daemon.prompt() is awaited, so the session→(tokenId,
      // subActor) mapping must be set first.
      if (onAccepted && req.rcClient?.id) {
        onAccepted(sessionId, {
          attributionTokenId: req.rcClient.id,
          subActor: req.rcClient.subActor ?? null,
        });
      }

      // Abort the (long-lived) daemon turn if the client disconnects. Listen on
      // the response, not the request: for a POST, `req`'s 'close' fires as soon
      // as the body is consumed — well before the turn resolves — which would
      // abort every prompt immediately. `res`'s 'close' fires only when the
      // underlying connection actually closes (client disconnect, or after we
      // end the response — by which point the turn has already resolved).
      const clientAbort = new AbortController();
      res.on('close', () => clientAbort.abort());

      // Prompt-execution timeout: cancel the daemon turn if it takes too long.
      const timeoutAbort = new AbortController();
      const promptTimer = setTimeout(() => {
        timeoutAbort.abort();
      }, promptTimeoutMs);

      // Compose both abort signals so either cancels the daemon call.
      const signal = AbortSignal.any
        ? AbortSignal.any([clientAbort.signal, timeoutAbort.signal])
        : (() => {
            // Fallback: manual composition for older Node versions.
            const ctrl = new AbortController();
            const abort = () => ctrl.abort();
            clientAbort.signal.addEventListener('abort', abort, { once: true });
            timeoutAbort.signal.addEventListener('abort', abort, {
              once: true,
            });
            return ctrl.signal;
          })();

      let result;
      let timedOut = false;
      try {
        result = await daemon.prompt(sessionId, { prompt: blocks }, signal);
      } catch {
        // Check what triggered the abort.
        if (timeoutAbort.signal.aborted) {
          timedOut = true;
        } else if (clientAbort.signal.aborted) {
          // Client disconnected — socket is gone, don't try to respond.
          return;
        } else {
          res
            .status(502)
            .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
          return;
        }
      } finally {
        clearTimeout(promptTimer);
      }

      if (timedOut) {
        // Broadcast a synthetic stream_error to all SSE subscribers so they
        // know the turn was cancelled by the gateway.
        broadcaster?.emit(sessionId, {
          type: 'stream_error',
          data: { code: 'prompt_timeout' },
        });
        res
          .status(504)
          .json({ error: 'prompt_timeout', code: 'prompt_timeout' });
        return;
      }

      // Guard against a race: if the client disconnected while we were awaiting
      // the result (but clientAbort didn't win the race above), don't respond.
      if (clientAbort.signal.aborted) return;

      void audit?.record({
        action: 'prompt_sent',
        actorTokenId: req.rcClient?.id,
        subActor: req.rcClient?.subActor,
        target: sessionId,
        detail: { stopReason: result!.stopReason, blocks: blocks.length },
      });

      res.status(200).json({ stopReason: result!.stopReason });
    } finally {
      // Always release the queue slot, even on timeout or error.
      release();
    }
  };
}
