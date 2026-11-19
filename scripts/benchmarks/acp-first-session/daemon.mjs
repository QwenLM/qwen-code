/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { createServer } from 'node:http';
import { enableCompileCache, syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert(process.send, 'launch with an IPC channel');
for (const key of ['VITEST_WORKER_ID', 'NODE_OPTIONS', 'NODE_V8_COVERAGE']) {
  assert(!process.env[key], `${key} must be absent`);
}
const stamp = () => performance.timeOrigin + performance.now();
const emit = (event) => {
  if (process.connected) process.send({ ...event, at: stamp() });
};
const cache = enableCompileCache();
emit({
  kind: 'compile-cache',
  status: cache.status,
  directory: cache.directory,
});
const originalSpawn = childProcess.spawn;
childProcess.spawn = function (...args) {
  const at = stamp();
  const child = Reflect.apply(originalSpawn, this, args);
  const acp = Array.isArray(args[1]) && args[1].includes('--acp');
  process.send({ kind: 'child-spawn', pid: child.pid, acp, at });
  if (acp) {
    child.once('exit', (code, signal) =>
      emit({ kind: 'acp-exit', pid: child.pid, code, signal }),
    );
  }
  return child;
};
syncBuiltinESMExports();

const { bootstrapServeFastPathEnvironment } = await import(
  pathToFileURL(config.fastPathModule)
);
const bootSettings = await bootstrapServeFastPathEnvironment(config.workspace);
const { runQwenServe } = await import(pathToFileURL(config.serveModule));
let firstRequest = true;
const handle = await runQwenServe(
  {
    hostname: '127.0.0.1',
    port: 0,
    mode: 'http-bridge',
    workspace: config.workspace,
    token: process.env.QWEN_SERVER_TOKEN,
    requireAuth: true,
    tokenQr: false,
    maxSessions: 1000,
    enableSessionShell: true,
    initializeTimeoutMs: 60_000,
  },
  {
    ...(bootSettings ? { bootSettings } : {}),
    preheatBridge: false,
    resolveOnListen: true,
    deferRuntimeUntilFirstHealth: false,
    httpServerFactory: (app) => {
      const server = createServer(app);
      server.prependListener('request', (request) => {
        if (!firstRequest) return;
        firstRequest = false;
        emit({
          kind: 'first-http',
          method: request.method,
          route: new URL(request.url, 'http://localhost').pathname,
        });
      });
      return server;
    },
  },
);
process.on('message', async (message) => {
  if (message?.kind === 'evidence-barrier') {
    emit({ kind: 'evidence-barrier' });
  } else if (message?.kind === 'close') {
    try {
      await handle.close();
      emit({ kind: 'closed' });
    } catch (error) {
      emit({ kind: 'close-error', message: String(error) });
      process.exitCode = 1;
    }
    process.disconnect();
  }
});
await handle.runtimeReady;
const snapshot = handle.bridge.getDaemonStatusSnapshot();
emit({
  kind: 'daemon-ready',
  sessionCount: snapshot.sessionCount,
  channelLive: snapshot.channelLive,
  preheatBridge: false,
});
