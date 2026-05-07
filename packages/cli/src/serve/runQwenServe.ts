/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Server } from 'node:http';
import { writeStderrLine, writeStdoutLine } from '../utils/stdioHelpers.js';
import { createServeApp } from './server.js';
import type { ServeOptions } from './types.js';

const QWEN_SERVER_TOKEN_ENV = 'QWEN_SERVER_TOKEN';
const LOOPBACK_BINDS = new Set(['127.0.0.1', 'localhost']);

export interface RunHandle {
  server: Server;
  url: string;
  /** Resolves when the listener has fully closed. */
  close(): Promise<void>;
}

/**
 * Validate options + start the listener. Resolves once the server is ready
 * to accept connections.
 *
 * Token resolution order:
 *   1. explicit `opts.token`
 *   2. `QWEN_SERVER_TOKEN` env var
 *
 * Boot refuses to start when bound beyond loopback without a token; this is a
 * hard rule, not a warning, per the threat model in the design issue.
 */
export async function runQwenServe(
  optsIn: Omit<ServeOptions, 'token'> & { token?: string },
): Promise<RunHandle> {
  const token = optsIn.token ?? process.env[QWEN_SERVER_TOKEN_ENV];
  const opts: ServeOptions = { ...optsIn, token };

  if (!LOOPBACK_BINDS.has(opts.hostname) && !token) {
    throw new Error(
      `Refusing to bind ${opts.hostname}:${opts.port} without a bearer token. ` +
        `Set ${QWEN_SERVER_TOKEN_ENV} or pass --token, or rebind to 127.0.0.1.`,
    );
  }

  let actualPort = opts.port;
  const app = createServeApp(opts, () => actualPort);

  return await new Promise<RunHandle>((resolve, reject) => {
    const server = app.listen(opts.port, opts.hostname, () => {
      const addr = server.address();
      actualPort = typeof addr === 'object' && addr ? addr.port : opts.port;
      const url = `http://${opts.hostname}:${actualPort}`;
      writeStdoutLine(`qwen serve listening on ${url} (mode=${opts.mode})`);
      if (!token) {
        writeStderrLine(
          `qwen serve: bearer auth disabled (loopback default). Set ${QWEN_SERVER_TOKEN_ENV} to enable.`,
        );
      }

      let shuttingDown = false;
      const detachSignals = () => {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
      };

      const handle: RunHandle = {
        server,
        url,
        close: () =>
          new Promise<void>((res, rej) => {
            shuttingDown = true;
            detachSignals();
            server.close((err) => (err ? rej(err) : res()));
          }),
      };

      const onSignal = async (signal: NodeJS.Signals) => {
        if (shuttingDown) return;
        writeStderrLine(`qwen serve: received ${signal}, draining...`);
        try {
          await handle.close();
          process.exit(0);
        } catch (err) {
          writeStderrLine(`qwen serve: shutdown error: ${String(err)}`);
          process.exit(1);
        }
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);

      resolve(handle);
    });
    server.once('error', reject);
  });
}
