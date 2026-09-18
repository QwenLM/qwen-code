#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { connect, type Socket } from 'node:net';

import { defaultChromeBridgeSocketPath } from '../protocol.js';
import { verifySocketPeerPath } from '../socket-path.js';
import { encodeFrame, FrameDecoder } from '../transport/framing.js';
import { encodeNativeMessagingOutput } from './native-messaging-output.js';

const socketPath = defaultChromeBridgeSocketPath();
const nativeDecoder = new FrameDecoder();
const queued: unknown[] = [];
let latestHello: unknown;
let socket: Socket | undefined;
let outputSequence = 0;
let closing = false;

function shutdown(code = 0): void {
  if (closing) return;
  closing = true;
  process.exitCode = code;
  socket?.destroy();
  process.stdin.destroy();
  // Let queued stdout writes drain, but do not hang if Chrome stops reading.
  setTimeout(() => process.exit(code), 2_000).unref();
}

async function connectBackend(): Promise<void> {
  try {
    await verifySocketPeerPath(socketPath);
  } catch {
    shutdown();
    return;
  }
  if (closing) return;
  const candidate = connect(socketPath);
  socket = candidate;
  candidate.once('connect', () => {
    if (latestHello !== undefined) candidate.write(encodeFrame(latestHello));
    for (const message of queued.splice(0))
      candidate.write(encodeFrame(message));
  });
  candidate.once('error', () => shutdown());
  candidate.once('close', () => shutdown());
  const backendDecoder = new FrameDecoder();
  candidate.on('data', (chunk) => {
    try {
      for (const message of backendDecoder.push(chunk)) {
        outputSequence += 1;
        for (const frame of encodeNativeMessagingOutput(
          message,
          String(outputSequence),
        )) {
          process.stdout.write(frame);
        }
      }
    } catch {
      shutdown(1);
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
        if (socket !== undefined && !socket.connecting && !socket.destroyed)
          socket.write(encodeFrame(message));
        continue;
      }
      if (socket !== undefined && !socket.connecting && !socket.destroyed)
        socket.write(encodeFrame(message));
      else {
        queued.push(message);
        if (queued.length > 100) queued.shift();
      }
    }
  } catch {
    shutdown(1);
  }
});

process.stdin.on('end', () => shutdown());
process.stdin.on('error', () => shutdown(1));

process.stdout.on('error', () => shutdown());
void connectBackend();
