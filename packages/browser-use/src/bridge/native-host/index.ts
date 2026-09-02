#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { connect, type Socket } from 'node:net';

import { defaultChromeBridgeSocketPath } from '../protocol.js';
import { encodeFrame, FrameDecoder } from '../transport/framing.js';

const socketPath = defaultChromeBridgeSocketPath();
const nativeDecoder = new FrameDecoder();
const queued: unknown[] = [];
let latestHello: unknown;
let socket: Socket | undefined;
let retryTimer: NodeJS.Timeout | undefined;
let closing = false;

function connectBackend(): void {
  if (closing || socket !== undefined) return;
  const candidate = connect(socketPath);
  candidate.once('connect', () => {
    socket = candidate;
    if (latestHello !== undefined) candidate.write(encodeFrame(latestHello));
    for (const message of queued.splice(0))
      candidate.write(encodeFrame(message));
  });
  const reconnect = (): void => {
    if (socket === candidate) socket = undefined;
    candidate.destroy();
    if (!closing && retryTimer === undefined) {
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        connectBackend();
      }, 1_000);
    }
  };
  candidate.once('error', reconnect);
  candidate.once('close', reconnect);
  const backendDecoder = new FrameDecoder();
  candidate.on('data', (chunk) => {
    try {
      for (const message of backendDecoder.push(chunk))
        process.stdout.write(encodeFrame(message));
    } catch {
      reconnect();
    }
  });
}

process.stdin.on('data', (chunk: Buffer) => {
  try {
    for (const message of nativeDecoder.push(chunk)) {
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'hello'
      ) {
        latestHello = message;
        if (socket !== undefined && !socket.destroyed)
          socket.write(encodeFrame(message));
        continue;
      }
      if (socket !== undefined && !socket.destroyed)
        socket.write(encodeFrame(message));
      else {
        queued.push(message);
        if (queued.length > 100) queued.shift();
      }
    }
  } catch {
    process.exitCode = 1;
    process.stdin.destroy();
  }
});

process.stdin.on('end', () => {
  closing = true;
  if (retryTimer !== undefined) clearTimeout(retryTimer);
  socket?.destroy();
  process.exit(0);
});

process.stdout.on('error', () => process.exit(0));
connectBackend();
