/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Response } from 'express';

export const GENERATION_HEARTBEAT_MS = 15_000;

export function formatGenerationSse(
  event: string,
  data: Record<string, unknown>,
): string {
  return `event: ${event}\ndata: ${JSON.stringify({ v: 1, ...data })}\n\n`;
}

export function writeGenerationSseChunk(
  res: Response,
  chunk: string,
): Promise<void> {
  if (res.destroyed) {
    return Promise.reject(new Error('Generation SSE connection destroyed'));
  }
  const writable = res.write(chunk);
  const flush = (res as Response & { flush?: () => void }).flush;
  flush?.call(res);
  if (writable) {
    return res.destroyed
      ? Promise.reject(new Error('Generation SSE connection destroyed'))
      : Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Generation SSE connection closed'));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
    if (res.destroyed) onClose();
  });
}
