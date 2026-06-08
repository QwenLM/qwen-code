/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { DaemonClient, PromptContentBlock } from '@qwen-code/sdk';
import type { AuditRecorder } from '../auditLog.js';

/**
 * POST /rc/session/:id/prompt — proxy the SDK's daemon.prompt(). Accepts either
 * `{ prompt: string }` (turned into a single text block) or
 * `{ blocks: PromptContentBlock[] }` (forwarded verbatim). Long-lived: awaits
 * the daemon's turn and returns its stopReason. A client disconnect aborts the
 * daemon prompt (no response written). The prompt text is NEVER audited.
 */
export function createPromptRoute(
  daemon: DaemonClient,
  audit?: AuditRecorder,
): RequestHandler {
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

    // Abort the (long-lived) daemon turn if the client disconnects. Listen on
    // the response, not the request: for a POST, `req`'s 'close' fires as soon
    // as the body is consumed — well before the turn resolves — which would
    // abort every prompt immediately. `res`'s 'close' fires only when the
    // underlying connection actually closes (client disconnect, or after we
    // end the response — by which point the turn has already resolved).
    const controller = new AbortController();
    res.on('close', () => controller.abort());

    let result;
    try {
      result = await daemon.prompt(
        sessionId,
        { prompt: blocks },
        controller.signal,
      );
    } catch {
      // A client disconnect aborts the prompt: the socket is already closed,
      // so don't try to respond and don't treat it as a daemon failure.
      if (controller.signal.aborted) return;
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }

    if (controller.signal.aborted) return;

    void audit?.record({
      action: 'prompt_sent',
      actorTokenId: req.rcClient?.id,
      target: sessionId,
      detail: { stopReason: result.stopReason, blocks: blocks.length },
    });

    res.status(200).json({ stopReason: result.stopReason });
  };
}
