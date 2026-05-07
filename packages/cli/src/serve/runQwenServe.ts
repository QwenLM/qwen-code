/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Server } from 'node:http';
import { writeStderrLine, writeStdoutLine } from '../utils/stdioHelpers.js';
import { createHttpAcpBridge, type HttpAcpBridge } from './httpAcpBridge.js';
import { isLoopbackBind } from './loopbackBinds.js';
import { createServeApp } from './server.js';
import type { ServeOptions } from './types.js';

const QWEN_SERVER_TOKEN_ENV = 'QWEN_SERVER_TOKEN';
const SHUTDOWN_FORCE_CLOSE_MS = 5_000;

export interface RunHandle {
  server: Server;
  url: string;
  bridge: HttpAcpBridge;
  /** Resolves when the listener has fully closed and the bridge is drained. */
  close(): Promise<void>;
}

export interface RunQwenServeDeps {
  /** Bridge instance; tests inject a fake. Defaults to a fresh real one. */
  bridge?: HttpAcpBridge;
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
  deps: RunQwenServeDeps = {},
): Promise<RunHandle> {
  const token = optsIn.token ?? process.env[QWEN_SERVER_TOKEN_ENV];
  const opts: ServeOptions = { ...optsIn, token };

  if (!isLoopbackBind(opts.hostname) && !token) {
    throw new Error(
      `Refusing to bind ${opts.hostname}:${opts.port} without a bearer token. ` +
        `Set ${QWEN_SERVER_TOKEN_ENV} or pass --token, or rebind to 127.0.0.1.`,
    );
  }

  const bridge = deps.bridge ?? createHttpAcpBridge();
  let actualPort = opts.port;
  const app = createServeApp(opts, () => actualPort, { bridge });

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

      // Forward declaration so handle.close can detach the listener after
      // drain completes. The handler is registered just before `resolve()`.
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

      const handle: RunHandle = {
        server,
        url,
        bridge,
        close: () =>
          new Promise<void>((res, rej) => {
            shuttingDown = true;
            // NOTE: the SIGINT/SIGTERM handlers stay attached during the
            // drain. Their `if (shuttingDown) return` guard makes a second
            // signal a no-op. Detaching them up front would leave Node's
            // default signal behavior in charge — a second SIGTERM mid-drain
            // would terminate the process and orphan agent children. We
            // detach AFTER drain completes (`finish` below).

            // server.close waits for in-flight connections (e.g. long-lived
            // SSE subscribers) before invoking the callback. Without a force
            // timeout, a single hung consumer can block shutdown forever.
            // Race a setTimeout against the natural close.
            let settled = false;
            const finish = (err?: Error | null) => {
              if (settled) return;
              settled = true;
              // Drain finished (or timed out) — safe to detach now.
              process.removeListener('SIGINT', onSignal);
              process.removeListener('SIGTERM', onSignal);
              if (err) rej(err);
              else res();
            };
            const forceTimer = setTimeout(() => {
              writeStderrLine(
                `qwen serve: ${SHUTDOWN_FORCE_CLOSE_MS}ms shutdown timeout reached; force-closing remaining connections`,
              );
              // Force-destroy every still-open connection on the listener.
              // This unblocks `server.close` which then resolves naturally.
              server.closeAllConnections?.();
              setTimeout(() => finish(), 100).unref();
            }, SHUTDOWN_FORCE_CLOSE_MS);
            forceTimer.unref();

            // Tear down child agents before closing the listener so in-flight
            // requests aren't left holding references to dead processes.
            bridge
              .shutdown()
              .catch((err) =>
                writeStderrLine(
                  `qwen serve: bridge shutdown error: ${String(err)}`,
                ),
              )
              .finally(() => {
                server.close((err) => {
                  clearTimeout(forceTimer);
                  finish(err);
                });
              });
          }),
      };

      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);

      resolve(handle);
    });
    server.once('error', reject);
  });
}
