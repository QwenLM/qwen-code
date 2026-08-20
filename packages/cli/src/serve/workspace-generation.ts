/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import { GENERATION_MAX_PROMPT_BYTES } from '../acp-integration/generation.js';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import type { AcpSessionBridge } from './acp-session-bridge.js';
import {
  formatGenerationSse,
  GENERATION_HEARTBEAT_MS,
  writeGenerationSseChunk,
} from './generation-sse.js';

interface WorkspaceGenerationRouteDeps {
  bridge: AcpSessionBridge;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  parseClientId: (req: Request, res: Response) => string | undefined | null;
  safeBody: (req: Request) => Record<string, unknown>;
}

export function mountWorkspaceGenerationRoutes(
  app: Application,
  deps: WorkspaceGenerationRouteDeps,
): void {
  app.post('/workspace/generate', deps.mutate(), async (req, res) => {
    const body = deps.safeBody(req);
    const prompt = body['prompt'];
    if (
      typeof prompt !== 'string' ||
      prompt.trim().length === 0 ||
      Buffer.byteLength(prompt, 'utf8') > GENERATION_MAX_PROMPT_BYTES
    ) {
      res.status(400).json({
        error: `\`prompt\` must be a non-empty string no larger than ${GENERATION_MAX_PROMPT_BYTES} UTF-8 bytes`,
        code: 'invalid_prompt',
      });
      return;
    }
    const clientId = deps.parseClientId(req, res);
    if (clientId === null) return;
    if (!deps.bridge.generateWorkspaceContent) {
      res.status(501).json({
        error: 'Workspace generation is not supported by this bridge',
        code: 'generation_not_supported',
      });
      return;
    }

    const abort = new AbortController();
    let completed = false;
    const onClose = () => {
      if (!completed) abort.abort();
    };
    res.once('close', onClose);

    const stream = deps.bridge.generateWorkspaceContent(
      prompt.trim(),
      abort.signal,
      clientId,
    );
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let writeChain = Promise.resolve();
    const write = (chunk: string): Promise<void> => {
      writeChain = writeChain.then(() => writeGenerationSseChunk(res, chunk));
      return writeChain;
    };
    await write(': connected\n\n');
    const heartbeat = setInterval(() => {
      void write(': heartbeat\n\n').catch(() => abort.abort());
    }, GENERATION_HEARTBEAT_MS);
    heartbeat.unref();

    try {
      for await (const event of stream) {
        await write(formatGenerationSse(event.type, event));
      }
    } catch (error) {
      if (!abort.signal.aborted && !res.destroyed) {
        writeStderrLine(
          `qwen serve: POST /workspace/generate failed: ${
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error)
          }`,
        );
        await write(
          formatGenerationSse('error', {
            type: 'error',
            code: 'generation_failed',
            message: 'Generation failed',
          }),
        ).catch(() => undefined);
      }
    } finally {
      completed = true;
      clearInterval(heartbeat);
      res.off('close', onClose);
      if (!res.destroyed) res.end();
    }
  });
}
