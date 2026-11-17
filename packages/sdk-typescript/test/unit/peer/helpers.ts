/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readPidNamespaceId,
  readProcStartToken,
} from '../../../src/peer/identity.js';
import { writeOwnRecord } from '../../../src/peer/registry.js';

/** UNIX domain sockets are what these suites exercise. */
export const noUnixSockets = process.platform === 'win32';

/** A fresh directory short enough that sockets inside it fit `sun_path`. */
export function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qp-'));
}

/**
 * Connect, write `text`, and resolve once the connection closes with
 * whatever the other side wrote back. Resolves on a reset too: a dropped
 * connection is an outcome these tests look for, not an error.
 */
export function dial(
  socketPath: string,
  text: string,
  options: { end?: boolean } = {},
): Promise<{ received: string }> {
  return new Promise((resolve) => {
    const socket = net.connect({ path: socketPath });
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      received += chunk;
    });
    socket.on('connect', () => {
      if (options.end ?? true) socket.end(text);
      else socket.write(text);
    });
    socket.on('error', () => {});
    socket.on('close', () => resolve({ received }));
  });
}

/** A plain listener that records every line any connection writes. */
export async function listenForLines(
  socketPath: string,
  lines: string[],
): Promise<net.Server> {
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
    });
    socket.on('end', () => {
      lines.push(...buffer.split('\n').filter((line) => line.length > 0));
      socket.end();
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  server.unref();
  return server;
}

/** Publish a record for something this process is pretending to be. */
export function publishRecord(
  registryDir: string,
  fields: {
    sessionId: string;
    name: string;
    ipcPath: string;
    ipcToken?: string;
    kind?: string;
  },
): Promise<string> {
  return writeOwnRecord(registryDir, {
    schemaVersion: 1,
    pid: process.pid,
    procStart: readProcStartToken(process.pid),
    pidNs: readPidNamespaceId(),
    sessionId: fields.sessionId,
    cwd: '/w',
    name: fields.name,
    startedAt: Date.now(),
    qwenVersion: null,
    kind: fields.kind ?? 'tui',
    ipcPath: fields.ipcPath,
    ...(fields.ipcToken !== undefined ? { ipcToken: fields.ipcToken } : {}),
  });
}
