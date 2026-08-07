/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { executeWebBridgeAction } from './web-bridge-actions';

interface WebBridgeCallFrame {
  type: 'webbridge_call';
  requestId: string;
  payload?: {
    name?: unknown;
    args?: unknown;
  };
}

interface WebBridgeResultFrame {
  type: 'webbridge_result';
  responseToRequestId: string;
  payload: {
    data?: unknown;
    error?: string;
    chunked?: boolean;
  };
}

interface WebBridgeResultChunkFrame {
  type: 'webbridge_result_chunk';
  responseToRequestId: string;
  payload: { chunk: string };
}

type WebBridgeSend = (
  frame: WebBridgeResultFrame | WebBridgeResultChunkFrame,
) => void;
const RESULT_CHUNK_LENGTH = 8 * 1024 * 1024;

export function isWebBridgeFrame(type: unknown): boolean {
  return type === 'webbridge_call';
}

export function handleWebBridgeFrame(
  frame: { type?: unknown },
  send: WebBridgeSend,
): void {
  void execute(frame as WebBridgeCallFrame, send);
}

async function execute(
  frame: WebBridgeCallFrame,
  send: WebBridgeSend,
): Promise<void> {
  const requestId = frame.requestId;
  if (typeof requestId !== 'string') return;
  try {
    const name = frame.payload?.name;
    const args = frame.payload?.args;
    if (typeof name !== 'string') throw new Error('Missing action name');
    if (!isRecord(args)) throw new Error('Action args must be an object');
    const data = await executeWebBridgeAction(name, args);
    if (isRecord(data) && typeof data['data'] === 'string') {
      const { data: artifact, ...metadata } = data;
      for (
        let offset = 0;
        offset < artifact.length;
        offset += RESULT_CHUNK_LENGTH
      ) {
        send({
          type: 'webbridge_result_chunk',
          responseToRequestId: requestId,
          payload: {
            chunk: artifact.slice(offset, offset + RESULT_CHUNK_LENGTH),
          },
        });
      }
      send({
        type: 'webbridge_result',
        responseToRequestId: requestId,
        payload: { data: metadata, chunked: true },
      });
      return;
    }
    send({
      type: 'webbridge_result',
      responseToRequestId: requestId,
      payload: { data },
    });
  } catch (error) {
    send({
      type: 'webbridge_result',
      responseToRequestId: requestId,
      payload: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
