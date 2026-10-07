/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, utimesSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { ManagedRuntimeOutcomeUnknownError } from '@qwen-code/qwen-code-core/services/execution-environment.js';
import { promptIdContext } from '@qwen-code/qwen-code-core/utils/promptIdContext.js';
import type { LocalManagedRuntimeOutcomes } from '@qwen-code/qwen-code-core/managed-runtime/managed-runtime-outcomes.js';
import { processBootLoaderEnv } from '../config/shared-env-keys.js';
import { createServer } from 'node:http';
import { MANAGED_RUNTIME_TOOL_RESULT_BODY_LIMIT_BYTES } from './managed-runtime-attestation-contract.js';
import {
  LedgerSweepUnprovenError,
  processGroupLiveness,
  queryProcessTable,
  testInternals,
} from './managed-runtime-ledger.js';
import {
  createManagedRuntimeEnvironment,
  currentCliWorkerLaunch,
  MANAGED_RUNTIME_RESPONSE_LIMIT_BYTES,
  ManagedSessionRuntimeWorker,
  toToolResult,
  type ManagedRuntimeWorkerLaunch,
  type ManagedSessionRuntimeWorkerOptions,
} from './managed-runtime-session-worker.js';

/**
 * Records the witness each ledger sweep runs with, so a test can tell the
 * arming sweep — run at the witnessed exit — from the reaper's retries,
 * which must not carry it. Transparent: every call passes through.
 */
const sweepWitnesses = vi.hoisted(() => ({
  records: [] as Array<{
    workFile: string;
    exitWitnessed: boolean | undefined;
    at: number;
  }>,
  /**
   * When set, the wrapped sweep parks on this promise after the record is
   * pushed: a test can hold one pass mid-flight and fire a second trigger
   * against it. Engagement is per-call, so the record count keeps naming
   * how many passes actually started.
   */
  hold: undefined as Promise<void> | undefined,
  /**
   * Every directory sweep started: sweepWorkerLedger calls from inside
   * sweepStaleLedgers never cross the module boundary, so directory passes
   * are counted at their own entry point instead.
   */
  dirCalls: [] as Array<{ directory: string; at: number }>,
}));
vi.mock('./managed-runtime-ledger.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./managed-runtime-ledger.js')>();
  return {
    ...actual,
    sweepWorkerLedger: async (
      workFile: string,
      options?: Parameters<typeof actual.sweepWorkerLedger>[1],
    ) => {
      sweepWitnesses.records.push({
        workFile,
        exitWitnessed: options?.exitWitnessed,
        at: Date.now(),
      });
      if (sweepWitnesses.hold !== undefined) await sweepWitnesses.hold;
      return actual.sweepWorkerLedger(workFile, options);
    },
    sweepStaleLedgers: (
      directory: string,
      options?: Parameters<typeof actual.sweepStaleLedgers>[1],
      onFileJudged?: Parameters<typeof actual.sweepStaleLedgers>[2],
    ) => {
      sweepWitnesses.dirCalls.push({ directory, at: Date.now() });
      return actual.sweepStaleLedgers(directory, options, onFileJudged);
    },
  };
});

// A worker that speaks boot v1 and the tool v2 routes, scripted per test.
const FAKE_WORKER = String.raw`
import { appendFileSync } from 'node:fs';
import http from 'node:http';
const log = (entry) => appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + '\n');
const mode = process.env.FAKE_MODE;
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const boot = JSON.parse(Buffer.concat(chunks).toString());
log({ boot: boot.runtimeIncarnation, pid: process.pid });
if (mode === 'log-ledger-env') log({ ledgerEnv: process.env['QWEN_MANAGED_RUNTIME_LEDGER'] ?? null });
const settled = (text) => ({
  protocolVersion: 2,
  state: 'settled',
  result: { executionStatus: 'success', responseParts: [{ type: 'text', text }] },
});
let stopping = false;
const inFlight = new Set();
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  const send = (status, value) => {
    // The incarnation the real worker names on every authorized answer.
    const incarnation = mode === 'anonymous' ? {} : {
      'x-qwen-managed-runtime-incarnation':
        mode === 'answers-as-another' ? 'another incarnation' : boot.runtimeIncarnation,
    };
    res.writeHead(status, { 'content-type': 'application/json', ...incarnation });
    res.end(JSON.stringify(value));
  };
  // As the real worker's guards, which answer before the incarnation is named.
  const guard = (status, value) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (req.headers.authorization !== 'Bearer ' + boot.token) return guard(401, {});
  const route = req.url.split('/').pop();
  log({ route, request });
  if (route === 'attest') {
    if (mode === 'slow-attest' || mode === 'slow-stop') await new Promise((resolve) => setTimeout(resolve, 300));
    // A refusal that still names the right identity: only its status tells.
    return send(mode === 'attest-refused' ? 409 : 200, {
      ...request,
      runtimeInstanceId: boot.runtimeInstanceId,
      runtimeIncarnation: mode === 'impostor-incarnation' ? 'another incarnation' : boot.runtimeIncarnation,
      leaseId: mode === 'impostor' ? 'another lease' : boot.leaseId,
      epoch: boot.epoch,
    });
  }
  if (route === 'execute') {
    if (mode === 'lost-response' || mode === 'unknown') return req.socket.destroy();
    // A settled answer whose parts no result-shaping survives.
    if (mode === 'null-part') return send(200, { protocolVersion: 2, state: 'settled', result: { executionStatus: 'success', responseParts: [null] } });
    if (mode === 'dies-mid-execute') {
      // A crash: the port is free for anyone, then the connection breaks.
      server.close();
      log({ closed: true });
      return process.once('SIGUSR2', () => {
        req.socket.destroy();
        setTimeout(() => process.exit(1), 5);
      });
    }
    if (mode === 'refuse') return send(409, { code: 'managed_runtime_identity_conflict', error: 'Refused before it ran.' });
    if (mode === 'guard-refuses') return guard(409, { code: 'managed_runtime_identity_conflict', error: 'Refused before it ran.' });
    if (mode === 'never-settles' || mode === 'settles-late') return;
    if (mode === 'cancels-on-stop') {
      // Stopping cancels the call and answers it before the worker exits.
      return inFlight.add(() =>
        send(200, { protocolVersion: 2, state: 'settled', result: { executionStatus: 'cancelled', responseParts: [] } }),
      );
    }
    if (mode === 'fails-before-journal') {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return send(500, {});
    }
    if (mode === 'cancel-overtakes') {
      const until = Date.now() + 5000;
      while (!globalThis.cancelRecorded && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return send(200, { protocolVersion: 2, state: 'settled', result: { executionStatus: 'cancelled', responseParts: [] } });
    }
    send(200, settled('ran ' + JSON.stringify(request.input)));
    if (mode === 'exit-after-call') setTimeout(() => process.exit(0), 20);
    if (mode === 'stop-listening') {
      server.close();
      setInterval(() => undefined, 1000);
    }
    return;
  }
  if (route === 'status') {
    if (mode === 'unknown' || mode === 'fails-before-journal') return send(200, { protocolVersion: 2, state: 'unknown' });
    if (mode === 'never-settles') return send(200, { protocolVersion: 2, state: 'cancel_requested', lastSequence: 2 });
    if (mode === 'settles-late') return send(200, { protocolVersion: 2, state: 'settled', lastSequence: 3, result: { executionStatus: 'cancelled', responseParts: [] } });
    return send(200, { ...settled('learned by reference'), lastSequence: 2 });
  }
  if (route === 'cancel') {
    if (mode === 'fails-before-journal') return send(200, { protocolVersion: 2, state: 'unknown' });
    // The first cancel arrives before the worker recorded the call.
    if (mode === 'cancel-overtakes' && !globalThis.cancelSeen) {
      globalThis.cancelSeen = true;
      return send(200, { protocolVersion: 2, state: 'unknown' });
    }
    globalThis.cancelRecorded = true;
    return send(200, { protocolVersion: 2, state: 'cancel_requested' });
  }
  if (route === 'acknowledge') {
    if (mode === 'fails-before-journal') return send(200, { protocolVersion: 2, state: 'unknown' });
    // Never answers: the receipt hangs on the client's control timeout.
    if (mode === 'acknowledge-never') return;
    return send(200, { protocolVersion: 2, state: 'acknowledged' });
  }
  send(404, {});
});
server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  log({ port });
  if (mode === 'slow-ready') await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_READY_MS ?? 400)));
  if (mode === 'ready-not-json') return process.stdout.write('starting...\n');
  process.stdout.write(JSON.stringify({
    type: mode === 'ready-wrong-type' ? 'started' : 'ready',
    version: 1,
    runtimeInstanceId: boot.runtimeInstanceId,
    runtimeIncarnation: mode === 'ready-wrong-incarnation' ? 'another incarnation' : boot.runtimeIncarnation,
    leaseId: boot.leaseId,
    epoch: boot.epoch,
    url: (mode === 'ready-remote-url' ? 'http://192.0.2.1:' : 'http://127.0.0.1:') + port,
  }) + '\n');
});
process.on('SIGTERM', () => {
  if (stopping) return;
  stopping = true;
  // A worker slow to see its stop finishes the requests in flight first.
  if (mode === 'slow-stop') return server.close(() => process.exit(0));
  // As the real worker: its calls settle, then every connection closes.
  for (const answer of inFlight) answer();
  setTimeout(() => {
    server.close();
    server.closeAllConnections();
    process.exit(0);
  }, 10);
});
`;

const SESSION_ID = '0d3c6b8e-5a43-4f5d-9d2b-6c1f3a7e9b21';

// The fake worker and the assertions use POSIX process signals.
describe.skipIf(process.platform === 'win32')(
  'ManagedSessionRuntimeWorker',
  () => {
    let root: string;
    let script: string;
    let logFile: string;
    const workers: ManagedSessionRuntimeWorker[] = [];

    beforeEach(async () => {
      root = await mkdtemp(path.join(os.tmpdir(), 'qwen-m5-worker-'));
      script = path.join(root, 'fake-worker.mjs');
      logFile = path.join(root, 'log.jsonl');
      await writeFile(script, FAKE_WORKER);
      await writeFile(logFile, '');
    });

    afterEach(async () => {
      await Promise.all(workers.splice(0).map((worker) => worker.close()));
      await rm(root, { recursive: true, force: true });
    });

    function launch(
      mode: string,
      env: NodeJS.ProcessEnv = {},
    ): () => ManagedRuntimeWorkerLaunch {
      return () => ({
        command: process.execPath,
        args: [script],
        env: { ...process.env, ...env, FAKE_MODE: mode, FAKE_LOG: logFile },
      });
    }

    function worker(
      mode: string,
      cancelSettleTimeoutMs?: number,
      env?: NodeJS.ProcessEnv,
    ) {
      const created = new ManagedSessionRuntimeWorker(
        SESSION_ID,
        root,
        launch(mode, env),
        cancelSettleTimeoutMs,
      );
      workers.push(created);
      return created;
    }

    async function entries(): Promise<
      Array<{
        boot?: string;
        pid?: number;
        port?: number;
        closed?: boolean;
        ledgerEnv?: string | null;
        route?: string;
        request?: unknown;
      }>
    > {
      return (await readFile(logFile, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    }

    /** The boots and requests the fake workers logged. */
    async function logged() {
      return (await entries()).filter(
        (entry) => entry.port === undefined && entry.closed === undefined,
      );
    }

    function isAlive(pid: number): boolean {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }

    it('boots, attests and runs a call bound to the session', async () => {
      const result = await worker('ok').execute(
        'read_file',
        { file_path: 'a.txt' },
        new AbortController().signal,
      );
      expect(result).toEqual({
        executionStatus: 'success',
        responseParts: [{ type: 'text', text: 'ran {"file_path":"a.txt"}' }],
      });
      const entries = await logged();
      expect(entries.map((entry) => entry.route ?? 'boot')).toEqual([
        'boot',
        'attest',
        'execute',
      ]);
      expect(entries[1].request).toMatchObject({
        protocolVersion: 2,
        isolationClass: 'session',
        workspaceCwd: root,
      });
      expect(entries[2].request).toMatchObject({
        protocolVersion: 2,
        toolName: 'read_file',
        input: { file_path: 'a.txt' },
        reference: {
          sessionId: SESSION_ID,
          argsDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        },
      });
    });

    it('learns the result of a call whose response was lost, without running it again', async () => {
      const result = await worker('lost-response').execute(
        'write_file',
        { file_path: 'a.txt', content: 'x' },
        new AbortController().signal,
      );
      expect(result.responseParts).toEqual([
        { type: 'text', text: 'learned by reference' },
      ]);
      const entries = await logged();
      expect(entries.filter((entry) => entry.route === 'execute')).toHaveLength(
        1,
      );
      const execute = entries.find((entry) => entry.route === 'execute')!;
      const status = entries.find((entry) => entry.route === 'status')!;
      expect((status.request as { reference: unknown }).reference).toEqual(
        (execute.request as { reference: unknown }).reference,
      );
    });

    it('reports a call it cannot learn the outcome of as unknown', async () => {
      await expect(
        worker('unknown').execute(
          'write_file',
          { file_path: 'a.txt', content: 'x' },
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(ManagedRuntimeOutcomeUnknownError);
    });

    it.each([
      ['its handler', 'refuse'],
      // A refusal names no incarnation, and needs none: whoever sent it, the
      // call did not run.
      ['a guard', 'guard-refuses'],
    ])(
      'reports a call that %s of the worker refused as not started',
      async (_label, mode) => {
        const result = await worker(mode).execute(
          'run_shell_command',
          { command: 'true' },
          new AbortController().signal,
        );
        expect(result).toEqual({
          executionStatus: 'not_started',
          responseParts: [],
          error: { message: 'Refused before it ran.' },
        });
      },
    );

    it('gives up on a cancelled call that does not settle', async () => {
      const controller = new AbortController();
      const running = worker('never-settles', 200).execute(
        'run_shell_command',
        { command: 'sleep 100' },
        controller.signal,
      );
      while (!(await logged()).some((entry) => entry.route === 'execute')) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      controller.abort();
      await expect(running).rejects.toBeInstanceOf(
        ManagedRuntimeOutcomeUnknownError,
      );
      expect((await logged()).some((entry) => entry.route === 'cancel')).toBe(
        true,
      );
    });

    it('returns a call cancelled while its worker starts at once, unsent', async () => {
      const controller = new AbortController();
      const running = worker('slow-ready', undefined, {
        FAKE_READY_MS: '10000',
      }).execute(
        'run_shell_command',
        { command: 'touch never' },
        controller.signal,
      );
      while ((await logged()).length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const abortedAt = Date.now();
      controller.abort();
      expect(await running).toEqual({
        executionStatus: 'cancelled',
        responseParts: [],
      });
      // Long before the worker is ready.
      expect(Date.now() - abortedAt).toBeLessThan(5000);
      expect((await logged()).some((entry) => entry.route === 'execute')).toBe(
        false,
      );
    });

    it.each([
      // Stopping drops the attestation in flight, so the worker never starts.
      ['during its attestation', 'slow-attest', true],
      // A worker slow to see its stop still answers the attestation: the
      // worker starts, and the call finds the session closing.
      ['as a slow-stopping worker gets ready', 'slow-stop', false],
    ] as const)(
      'does not send a call when the session closes %s',
      async (_when, mode, failedToStart) => {
        const closing = worker(mode);
        const running = closing.execute(
          'run_shell_command',
          { command: 'touch never' },
          new AbortController().signal,
        );
        const refused = running.then(
          () => new Error('the call was sent'),
          (error: unknown) => error as Error,
        );
        while (!(await logged()).some((entry) => entry.route === 'attest')) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await closing.close();
        expect((await refused).message).toContain('closing');
        // Only a start that failed carries the failure as its cause.
        expect((await refused).cause !== undefined).toBe(failedToStart);
        expect(
          (await logged()).some((entry) => entry.route === 'execute'),
        ).toBe(false);
      },
    );

    it('settles a call the worker cancels as it stops', async () => {
      const stopping = worker('cancels-on-stop');
      const running = stopping.execute(
        'run_shell_command',
        { command: 'sleep 100' },
        new AbortController().signal,
      );
      void running.catch(() => undefined);
      while (!(await logged()).some((entry) => entry.route === 'execute')) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await stopping.close();
      expect(await running).toEqual({
        executionStatus: 'cancelled',
        responseParts: [],
      });
    });

    it('never asks the port of a worker that died during a call', async () => {
      const dying = worker('dies-mid-execute');
      const running = dying.execute(
        'read_file',
        { file_path: 'a.txt' },
        new AbortController().signal,
      );
      void running.catch(() => undefined);
      while (!(await entries()).some((entry) => entry.closed)) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      const [{ pid }, { port }] = await entries();
      // Another process takes the port the moment it is free and answers
      // every question with an outcome of its own.
      const heard: string[] = [];
      const stranger = createServer((req, res) => {
        heard.push(String(req.headers.authorization));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            protocolVersion: 2,
            state: 'settled',
            result: {
              executionStatus: 'success',
              responseParts: [{ type: 'text', text: 'forged' }],
            },
          }),
        );
      });
      await new Promise<void>((resolve, reject) => {
        stranger.once('error', reject);
        stranger.listen(port, '127.0.0.1', () => {
          stranger.off('error', reject);
          resolve();
        });
      });
      try {
        // The stranger listens before the worker dies and its call breaks.
        process.kill(pid!, 'SIGUSR2');
        await expect(running).rejects.toBeInstanceOf(
          ManagedRuntimeOutcomeUnknownError,
        );
        expect(heard).toEqual([]);
      } finally {
        await new Promise((resolve) => stranger.close(resolve));
      }
    });

    it.each([
      ['names no incarnation', 'anonymous'],
      ['names another incarnation', 'answers-as-another'],
    ])('takes no outcome from an answer that %s', async (_label, mode) => {
      // The worker answers both questions with a result: neither counts.
      await expect(
        worker(mode).execute(
          'read_file',
          { file_path: 'a.txt' },
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(ManagedRuntimeOutcomeUnknownError);
      expect((await logged()).map((entry) => entry.route)).toEqual([
        undefined,
        'attest',
        'execute',
        'status',
      ]);
    });

    it.each([
      ['answers as another worker', 'ready-wrong-incarnation', 'not the one'],
      ['announces something else', 'ready-wrong-type', 'not the one'],
      ['listens beyond loopback', 'ready-remote-url', 'not the one'],
      ['prints no ready document', 'ready-not-json', 'is not ready'],
      [
        'attests as another incarnation',
        'impostor-incarnation',
        'failed attestation',
      ],
      ['refuses its attestation', 'attest-refused', 'failed attestation'],
    ])(
      'stops a worker that %s and runs nothing',
      async (_label, mode, message) => {
        await expect(
          worker(mode).execute(
            'read_file',
            { file_path: 'a.txt' },
            new AbortController().signal,
          ),
        ).rejects.toThrow(message);
        const [{ pid }] = await logged();
        expect(isAlive(pid!)).toBe(false);
        expect(
          (await logged()).some((entry) => entry.route === 'execute'),
        ).toBe(false);
      },
    );

    it('does not send a call when the session closes while its worker starts', async () => {
      const closing = worker('slow-ready');
      const running = closing.execute(
        'run_shell_command',
        { command: 'touch never' },
        new AbortController().signal,
      );
      while ((await logged()).length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const refused = running.then(
        () => new Error('the call was sent'),
        (error: unknown) => error as Error,
      );
      await closing.close();
      expect((await refused).message).toContain('closing');
      // The worker failed to start, and that failure is kept.
      expect((await refused).cause).toBeInstanceOf(Error);
      expect((await logged()).some((entry) => entry.route === 'execute')).toBe(
        false,
      );
    });

    it('retries a cancel that overtook its call', async () => {
      const controller = new AbortController();
      const running = worker('cancel-overtakes').execute(
        'run_shell_command',
        { command: 'sleep 100' },
        controller.signal,
      );
      while (!(await logged()).some((entry) => entry.route === 'execute')) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      controller.abort();
      expect(await running).toEqual({
        executionStatus: 'cancelled',
        responseParts: [],
      });
      expect(
        (await logged()).filter((entry) => entry.route === 'cancel').length,
      ).toBeGreaterThan(1);
    });

    it('stops retrying a cancel once the call ends without an outcome', async () => {
      const controller = new AbortController();
      const running = worker('fails-before-journal', 60_000).execute(
        'run_shell_command',
        { command: 'sleep 100' },
        controller.signal,
      );
      while (!(await logged()).some((entry) => entry.route === 'execute')) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      controller.abort();
      await expect(running).rejects.toBeInstanceOf(
        ManagedRuntimeOutcomeUnknownError,
      );
    });

    it('takes one last look at a cancelled call before calling it unknown', async () => {
      const controller = new AbortController();
      const running = worker('settles-late', 200).execute(
        'run_shell_command',
        { command: 'sleep 100' },
        controller.signal,
      );
      while (!(await logged()).some((entry) => entry.route === 'execute')) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      controller.abort();
      expect(await running).toEqual({
        executionStatus: 'cancelled',
        responseParts: [],
      });
    });

    it('refuses a worker that fails attestation and stops it', async () => {
      await expect(
        worker('impostor').execute(
          'read_file',
          { file_path: 'a.txt' },
          new AbortController().signal,
        ),
      ).rejects.toThrow('failed attestation');
      const [{ pid }] = await logged();
      expect(isAlive(pid!)).toBe(false);
    });

    it('starts a new worker after one exits between calls', async () => {
      const replaced = worker('exit-after-call');
      const signal = new AbortController().signal;
      await replaced.execute('read_file', { file_path: 'a.txt' }, signal);
      const [{ pid: first }] = await logged();
      while (isAlive(first!)) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await replaced.execute('read_file', { file_path: 'b.txt' }, signal);
      const boots = (await logged()).filter(
        (entry) => entry.boot !== undefined,
      );
      expect(boots).toHaveLength(2);
      // This one exits on its own too; closing must not race it.
      while (isAlive(boots[1].pid!)) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    });

    it('reports a call that reached no worker as not started and replaces it', async () => {
      const replaced = worker('stop-listening');
      const signal = new AbortController().signal;
      await replaced.execute('read_file', { file_path: 'a.txt' }, signal);
      const [{ pid: first }] = await logged();

      expect(
        await replaced.execute('read_file', { file_path: 'b.txt' }, signal),
      ).toEqual({
        executionStatus: 'not_started',
        responseParts: [],
        error: { message: 'The Runtime worker was not running.' },
      });
      // The silent worker is stopped, and the next call starts another.
      while (isAlive(first!)) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await replaced.execute('read_file', { file_path: 'c.txt' }, signal);
      expect(
        (await logged()).filter((entry) => entry.boot !== undefined),
      ).toHaveLength(2);
    });

    it('stops its worker on close and runs nothing afterwards', async () => {
      const closing = worker('ok');
      const signal = new AbortController().signal;
      await closing.execute('read_file', { file_path: 'a.txt' }, signal);
      const [{ pid }] = await logged();
      await closing.close();
      expect(isAlive(pid!)).toBe(false);
      await expect(
        closing.execute('read_file', { file_path: 'a.txt' }, signal),
      ).rejects.toThrow('closing');
    });

    describe('physical stop', () => {
      const signal = new AbortController().signal;
      const sleeperChildren: Array<ReturnType<typeof spawn>> = [];

      afterEach(() => {
        for (const child of sleeperChildren.splice(0)) {
          if (child.pid !== undefined) killGroup(child.pid);
        }
      });

      function spawnSleeper(): number {
        const child = spawn('sleep', ['300'], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        child.on('exit', () => undefined);
        if (child.pid === undefined) throw new Error('spawn failed');
        sleeperChildren.push(child);
        return child.pid;
      }

      function killGroup(pgid: number): void {
        try {
          process.kill(-pgid, 'SIGKILL');
        } catch {
          try {
            process.kill(pgid, 'SIGKILL');
          } catch {
            // gone already
          }
        }
      }

      function ledgerWorker(
        mode: string,
        options: ManagedSessionRuntimeWorkerOptions,
      ) {
        const created = new ManagedSessionRuntimeWorker(
          SESSION_ID,
          root,
          launch(mode),
          undefined,
          options,
        );
        workers.push(created);
        return created;
      }

      async function incarnation(): Promise<string> {
        const [{ boot }] = await logged();
        if (boot === undefined) throw new Error('no worker booted');
        return boot;
      }

      it('names the worker its own ledger file in the launch environment', async () => {
        const ledgerDir = path.join(root, 'ledgers');
        const created = ledgerWorker('log-ledger-env', { ledgerDir });
        await created.execute('read_file', { file_path: 'a.txt' }, signal);
        const [entry] = (await entries()).filter(
          (item) => item.ledgerEnv !== undefined,
        );
        const ledgerEnv = entry?.ledgerEnv;
        expect(ledgerEnv).toBeTruthy();
        expect(ledgerEnv!.startsWith(`${ledgerDir}${path.sep}`)).toBe(true);
        expect(ledgerEnv!.endsWith('.json')).toBe(true);
        // The host names the file; only the worker ever writes it.
        expect(existsSync(ledgerEnv!)).toBe(false);
      });

      it('sweeps the ledger of a worker that exits between calls', async () => {
        // The dominant crash path: the exit observer fires without any call
        // in flight, long before close(). Its groups die with it.
        const ledgerDir = path.join(root, 'ledgers');
        const quarantine = { report: vi.fn(), lift: vi.fn() };
        const created = ledgerWorker('exit-after-call', {
          ledgerDir,
          quarantine,
        });
        await created.execute('read_file', { file_path: 'a.txt' }, signal);
        const workFile = path.join(ledgerDir, `${await incarnation()}.json`);
        const sleeperPid = spawnSleeper();
        testInternals.writeLedgerDocument(
          workFile,
          {
            pid: 42424242,
            pgid: 42424242,
            incarnation: 'incarnation-1',
            startedAt: Date.now(),
          },
          [{ pgid: sleeperPid, callId: 'call-1', startedAt: Date.now() }],
        );

        const deadline = Date.now() + 10_000;
        while (
          processGroupLiveness(sleeperPid) !== 'gone' ||
          existsSync(workFile)
        ) {
          if (Date.now() > deadline) {
            throw new Error('the exit-between-calls sweep never landed');
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(quarantine.report).not.toHaveBeenCalled();
        sleeperChildren.length = 0;
      });

      it('sweeps the process groups a stopped worker left in its ledger', async () => {
        const ledgerDir = path.join(root, 'ledgers');
        const quarantine = { report: vi.fn(), lift: vi.fn() };
        const created = ledgerWorker('ok', { ledgerDir, quarantine });
        await created.execute('read_file', { file_path: 'a.txt' }, signal);
        const workFile = path.join(ledgerDir, `${await incarnation()}.json`);
        const sleeperPid = spawnSleeper();
        testInternals.writeLedgerDocument(
          workFile,
          {
            pid: 42424242,
            pgid: 42424242,
            incarnation: 'incarnation-1',
            startedAt: Date.now(),
          },
          [{ pgid: sleeperPid, callId: 'call-1', startedAt: Date.now() }],
        );

        await created.close();

        expect(processGroupLiveness(sleeperPid)).toBe('gone');
        expect(existsSync(workFile)).toBe(false);
        expect(quarantine.report).not.toHaveBeenCalled();
        sleeperChildren.length = 0;
      });

      it('quarantines the engine while a stop stays unproven and lifts once proven', async () => {
        const ledgerDir = path.join(root, 'ledgers');
        const quarantine = { report: vi.fn(), lift: vi.fn() };
        const created = ledgerWorker('ok', { ledgerDir, quarantine });
        await created.execute('read_file', { file_path: 'a.txt' }, signal);
        const workFile = path.join(ledgerDir, `${await incarnation()}.json`);
        // A truth the sweep can neither trust nor resolve: bytes it cannot
        // read, so nothing may be swept.
        await writeFile(workFile, 'not a ledger at all', 'utf8');

        // close() sweeps the ledger itself or defers to the exit hook's
        // already-armed reaper — whichever reports first; either way the
        // quarantine is reported exactly once.
        await created.close().catch(() => undefined);
        expect(quarantine.report).toHaveBeenCalledTimes(1);
        const reason = quarantine.report.mock.calls[0]![0] as Error;
        expect(reason).toBeInstanceOf(LedgerSweepUnprovenError);
        expect(quarantine.lift).not.toHaveBeenCalled();

        // The truth heals: a valid ledger whose group the reaper's own
        // sweep proves gone — it SIGKILLs the survivor itself — lets the
        // reaper lift the quarantine it raised, with the same reason object
        // it reported (the host keys the quarantine on reason identity).
        const healerIncarnation = await incarnation();
        const survivorPid = spawnSleeper();
        testInternals.writeLedgerDocument(
          workFile,
          {
            pid: 42424242,
            pgid: 42424242,
            incarnation: healerIncarnation,
            startedAt: Date.now(),
          },
          [{ pgid: survivorPid, callId: 'call-1', startedAt: Date.now() }],
        );
        const deadline = Date.now() + 10_000;
        while (quarantine.lift.mock.calls.length === 0) {
          if (Date.now() > deadline) {
            throw new Error('reaper never proved the stop');
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(quarantine.lift).toHaveBeenCalledWith(reason);
        expect(processGroupLiveness(survivorPid)).toBe('gone');
        expect(existsSync(workFile)).toBe(false);
        sleeperChildren.length = 0;
      });

      it('leaves a ledger its reaper already owns to the reaper at close', async () => {
        // A close that finds its ledger unprovable reports the quarantine
        // once and arms the reaper; a repeated close must not pay a second
        // proof budget over the same path nor reject with a duplicate of
        // the failure its report already counts.
        const ledgerDir = path.join(root, 'ledgers');
        const quarantine = { report: vi.fn(), lift: vi.fn() };
        const created = ledgerWorker('ok', { ledgerDir, quarantine });
        await created.execute('read_file', { file_path: 'a.txt' }, signal);
        const workFile = path.join(ledgerDir, `${await incarnation()}.json`);
        // A truth the sweep can neither trust nor resolve: bytes it cannot
        // read, too young to retire.
        await writeFile(workFile, 'not a ledger at all', 'utf8');

        await created.close().catch(() => undefined);
        const deadline = Date.now() + 10_000;
        while (quarantine.report.mock.calls.length === 0) {
          if (Date.now() > deadline) throw new Error('never quarantined');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(quarantine.report).toHaveBeenCalledTimes(1);

        // The path is the reaper's now: a repeated close sweeps nothing
        // again, reports nothing again, and does not reject.
        await expect(created.close()).resolves.toBeUndefined();
        expect(quarantine.report).toHaveBeenCalledTimes(1);
      });

      it('a deleted unreadable ledger is no proof: the reaper never lifts', async () => {
        // The unreadable ledger named no groups; deleting the file leaves
        // nothing to re-probe, and an empty probe is not a proof — the
        // quarantine stands until the child restarts.
        const ledgerDir = path.join(root, 'ledgers');
        const quarantine = { report: vi.fn(), lift: vi.fn() };
        const created = ledgerWorker('ok', { ledgerDir, quarantine });
        await created.execute('read_file', { file_path: 'a.txt' }, signal);
        const workFile = path.join(ledgerDir, `${await incarnation()}.json`);
        await writeFile(workFile, 'not a ledger at all', 'utf8');

        await created.close().catch(() => undefined);
        expect(quarantine.report).toHaveBeenCalledTimes(1);
        expect(quarantine.lift).not.toHaveBeenCalled();

        await rm(workFile);
        // Past two reaper intervals: no lift ever came.
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        expect(quarantine.lift).not.toHaveBeenCalled();
      });

      it('reports and holds an aged ledger set aside unreadable at close', async () => {
        // A ledger nobody can read, old enough to be debris: the sweep sets
        // it aside and REJECTS — nothing it named can ever be proven, so the
        // quarantine is reported and held, never silently closed over.
        const ledgerDir = path.join(root, 'ledgers');
        const quarantine = { report: vi.fn(), lift: vi.fn() };
        const created = ledgerWorker('ok', { ledgerDir, quarantine });
        await created.execute('read_file', { file_path: 'a.txt' }, signal);
        const workFile = path.join(ledgerDir, `${await incarnation()}.json`);
        await writeFile(workFile, 'not a ledger at all', 'utf8');
        const past = new Date(Date.now() - 120_000);
        utimesSync(workFile, past, past);

        // close() itself sweeps or defers to the exit hook's reaper —
        // whichever reports first; either way the retirement is reported
        // once, with the ledger named, and never lifted.
        await created.close().catch(() => undefined);
        expect(quarantine.report).toHaveBeenCalledTimes(1);
        const reason = quarantine.report.mock.calls[0]![0] as Error;
        expect(reason.message).toContain(workFile);
        expect(
          existsSync(path.join(ledgerDir, `${await incarnation()}.unreadable`)),
        ).toBe(true);
        // Two reaper intervals past the retirement: no lift ever came.
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        expect(quarantine.lift).not.toHaveBeenCalled();
      });

      it('the reaper retries without the exit witness the first sweep spent', async () => {
        // The witness is fresh only at the exit the host saw: a retry that
        // carried it forever would SIGKILL whatever process group later
        // answers on a recycled id, on the strength of a witness about a
        // different moment. The arming sweep carries it; no retry may.
        const ledgerDir = path.join(root, 'ledgers');
        const quarantine = { report: vi.fn(), lift: vi.fn() };
        const created = ledgerWorker('ok', { ledgerDir, quarantine });
        await created.execute('read_file', { file_path: 'a.txt' }, signal);
        const workFile = path.join(ledgerDir, `${await incarnation()}.json`);
        // Unreadable and too young to retire: every sweep throws the same
        // way, so the reaper keeps retrying it for the child's lifetime.
        await writeFile(workFile, 'not a ledger at all', 'utf8');

        sweepWitnesses.records.length = 0;
        await created.close().catch(() => undefined);
        expect(quarantine.report).toHaveBeenCalledTimes(1);
        const own = () =>
          sweepWitnesses.records.filter(
            (record) => record.workFile === workFile,
          );
        // The arming sweep — close to the witnessed exit — carries it.
        expect(own().length).toBeGreaterThan(0);
        expect(own()[0]!.exitWitnessed).toBe(true);
        // The reaper's first retry lands no earlier than its 1 s interval;
        // anything this much later than the arming sweep is a retry.
        const armedAt = own()[0]!.at;
        await vi.waitFor(
          () => {
            expect(own().some((record) => record.at - armedAt > 900)).toBe(
              true,
            );
          },
          { timeout: 15_000 },
        );
        for (const retry of own()) {
          if (retry.at - armedAt > 900) {
            expect(retry.exitWitnessed).not.toBe(true);
          }
        }
      });

      it('close joins the sweep the exit hook is already running over the same ledger', async () => {
        // Two triggers in one window — the exit hook and an explicit
        // close() — must pay one sweep over the ledger, not two: the
        // second joins the in-flight pass. The wrapped sweep records every
        // pass it starts, so the join shows as one record for the file.
        const ledgerDir = path.join(root, 'ledgers');
        const quarantine = { report: vi.fn(), lift: vi.fn() };
        const created = ledgerWorker('exit-after-call', {
          ledgerDir,
          quarantine,
        });
        sweepWitnesses.records.length = 0;
        let release: (() => void) | undefined;
        // Engage before the worker can exit: the exit observation is a
        // macrotask away, but only if the hold precedes the call.
        sweepWitnesses.hold = new Promise<void>((resolve) => {
          release = resolve;
        });
        await created.execute('read_file', { file_path: 'a.txt' }, signal);
        const workFile = path.join(ledgerDir, `${await incarnation()}.json`);
        try {
          // The exit hook reached the sweep and parked inside it.
          await vi.waitFor(
            () => {
              expect(
                sweepWitnesses.records.some(
                  (record) => record.workFile === workFile,
                ),
              ).toBe(true);
            },
            { timeout: 10_000 },
          );
          // close() now fires the same path: it must join, not re-enter.
          const closing = created.close().catch(() => undefined);
          release?.();
          await closing;
          await new Promise((resolve) => setTimeout(resolve, 300));
          expect(
            sweepWitnesses.records.filter(
              (record) => record.workFile === workFile,
            ),
          ).toHaveLength(1);
        } finally {
          release?.();
          sweepWitnesses.hold = undefined;
          sweepWitnesses.records.length = 0;
        }
      });

      it('sweeps the ledger of a worker that never finished launching', async () => {
        // A launch that fails attestation leaves no live session to own the
        // file: the inline sweep at the launch failure is what both stops
        // the half-launched worker's groups and unlinks its ledger, so this
        // child never reads the file as a sibling's live work later.
        const ledgerDir = path.join(root, 'ledgers');
        const quarantine = { report: vi.fn(), lift: vi.fn() };
        const created = ledgerWorker('impostor', { ledgerDir, quarantine });
        const attempt = created
          .execute('read_file', { file_path: 'a.txt' }, signal)
          .catch((error: unknown) => error);
        let inc = '';
        await vi.waitFor(
          async () => {
            const entries = await logged();
            expect(entries.some((entry) => entry.boot !== undefined)).toBe(
              true,
            );
            inc = entries.find((entry) => entry.boot !== undefined)!.boot!;
          },
          { timeout: 10_000 },
        );
        const workFile = path.join(ledgerDir, `${inc}.json`);
        const sleeperPid = spawnSleeper();
        testInternals.writeLedgerDocument(
          workFile,
          {
            pid: 42424245,
            pgid: 42424245,
            incarnation: 'incarnation-1',
            startedAt: Date.now(),
          },
          [{ pgid: sleeperPid, callId: 'call-launch', startedAt: Date.now() }],
        );
        const outcome = await attempt;
        expect(outcome).toBeInstanceOf(Error);
        await vi.waitFor(
          () => {
            expect(processGroupLiveness(sleeperPid)).toBe('gone');
            expect(existsSync(workFile)).toBe(false);
          },
          { timeout: 10_000 },
        );
      });

      it(
        'a reaper keeps the groups an earlier failure named across a later nameless one',
        // Reaper ticks are seconds apart; the choreography observes each
        // one rather than sleeping fixed gaps.
        { timeout: 45_000 },
        async () => {
          // The arming close-sweep reads garbage and names nothing; the
          // first retry names a live held group; the next retry reads
          // garbage again and names nothing. The names of the first retry
          // must survive the nameless one — a read problem is no proof
          // about the group. With the ledger then gone and the group dead,
          // only the accumulated name lets the reaper answer 'proven' and
          // lift. A replace-instead-of-accumulate reaper ends terminal
          // instead and never lifts.
          const ledgerDir = path.join(root, 'ledgers');
          const quarantine = { report: vi.fn(), lift: vi.fn() };
          const created = ledgerWorker('ok', { ledgerDir, quarantine });
          await created.execute('read_file', { file_path: 'a.txt' }, signal);
          const workFile = path.join(ledgerDir, `${await incarnation()}.json`);
          const sleeper = spawnSleeper();
          // Too fresh to retire: both garbage phases throw, naming nothing.
          await writeFile(workFile, 'not a ledger at all', 'utf8');
          await created.close().catch(() => undefined);
          expect(quarantine.report).toHaveBeenCalledTimes(1);
          const retries = () =>
            sweepWitnesses.records.filter(
              (record) =>
                record.workFile === workFile && record.exitWitnessed !== true,
            );
          // The first retry reads a valid ledger naming a held group: the
          // stamp sits far enough ahead that every pass up to the kill
          // judges 'unknown' — held, never signal-worthy.
          testInternals.writeLedgerDocument(
            workFile,
            {
              pid: 42424243,
              pgid: 42424243,
              incarnation: 'incarnation-1',
              startedAt: Date.now(),
            },
            [
              {
                pgid: sleeper,
                callId: 'call-named',
                startedAt: Date.now() + 10_000,
              },
            ],
          );
          await vi.waitFor(
            () => {
              expect(retries().length).toBeGreaterThanOrEqual(1);
            },
            { timeout: 10_000 },
          );
          // The nameless failure the names must survive.
          await writeFile(workFile, 'not a ledger at all', 'utf8');
          await vi.waitFor(
            () => {
              expect(retries().length).toBeGreaterThanOrEqual(2);
            },
            { timeout: 10_000 },
          );
          await rm(workFile);
          killGroup(sleeper);
          // Absent file, named group gone: only the accumulated name can
          // turn this verdict 'proven'.
          await vi.waitFor(
            () => {
              expect(quarantine.lift).toHaveBeenCalledTimes(1);
            },
            { timeout: 20_000 },
          );
          expect(quarantine.report).toHaveBeenCalledTimes(1);
          expect(quarantine.lift).toHaveBeenCalledTimes(1);
        },
      );
    });
  },
);

describe.skipIf(process.platform === 'win32')(
  'createManagedRuntimeEnvironment',
  () => {
    let root: string;
    let script: string;
    let logFile: string;
    let config: Config;
    let environment: ReturnType<typeof createManagedRuntimeEnvironment>;
    let previousRuntimeDir: string | undefined;
    let admissions: Array<Record<string, unknown>>;
    let settlements: Array<Record<string, unknown>>;
    /** Gates the fake recorder's commit awaits, per test. */
    const outcomeWaiters: { admit?: Promise<void>; settle?: Promise<void> } =
      {};
    /** Fires as the fake recorder enters a commit, per test. */
    const outcomeSignals: { admit?: () => void; settle?: () => void } = {};
    /** Makes the fake recorder's commits fail, per test. */
    const outcomeFailures: { admit?: Error; settle?: Error } = {};
    /** The receipts the fake recorder answers as committed, per test. */
    const outcomeReceipts = new Set<string>();
    const signal = new AbortController().signal;

    function recordOutcomes(target: Config) {
      const recorder = {
        admit: async (input: Record<string, unknown>) => {
          if (outcomeFailures.admit) throw outcomeFailures.admit;
          outcomeSignals.admit?.();
          if (outcomeWaiters.admit) await outcomeWaiters.admit;
          admissions.push(input);
        },
        settle: async (input: Record<string, unknown>) => {
          if (outcomeFailures.settle) throw outcomeFailures.settle;
          outcomeSignals.settle?.();
          if (outcomeWaiters.settle) await outcomeWaiters.settle;
          settlements.push(input);
        },
        finalizeBatch: async () => undefined,
        hasCommittedReceipt: (id: string) => outcomeReceipts.has(id),
      };
      vi.spyOn(target, 'getManagedRuntimeOutcomes').mockReturnValue(
        recorder as unknown as LocalManagedRuntimeOutcomes,
      );
    }

    beforeEach(async () => {
      root = await mkdtemp(path.join(os.tmpdir(), 'qwen-m5-env-'));
      // Pin the runtime temp root: the worker launch creates the ledger
      // directory by sha256 of cwd, which `rm(root)` can never reach.
      previousRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
      process.env['QWEN_RUNTIME_DIR'] = path.join(root, 'runtime');
      script = path.join(root, 'fake-worker.mjs');
      logFile = path.join(root, 'log.jsonl');
      await writeFile(script, FAKE_WORKER);
      await writeFile(logFile, '');
      admissions = [];
      settlements = [];
      outcomeWaiters.admit = undefined;
      outcomeWaiters.settle = undefined;
      outcomeSignals.admit = undefined;
      outcomeSignals.settle = undefined;
      outcomeFailures.admit = undefined;
      outcomeFailures.settle = undefined;
      outcomeReceipts.clear();
      config = new Config({
        sessionId: SESSION_ID,
        targetDir: root,
        cwd: root,
        debugMode: false,
        model: 'test-model',
        usageStatisticsEnabled: false,
        telemetry: { enabled: false },
        deferTelemetryInitialization: true,
      });
      recordOutcomes(config);
    });

    afterEach(async () => {
      await environment?.dispose();
      if (previousRuntimeDir === undefined) {
        delete process.env['QWEN_RUNTIME_DIR'];
      } else {
        process.env['QWEN_RUNTIME_DIR'] = previousRuntimeDir;
      }
      await rm(root, { recursive: true, force: true });
    });

    /** The execute requests the fake worker received. */
    async function executeRequests() {
      return (await readFile(logFile, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              route?: string;
              request?: { input?: Record<string, unknown> };
            },
        )
        .filter((entry) => entry.route === 'execute')
        .map((entry) => entry.request);
    }

    function create(mode: string, extraEnv: Record<string, string> = {}) {
      environment = createManagedRuntimeEnvironment(config, () => ({
        command: process.execPath,
        args: [script],
        env: {
          ...process.env,
          FAKE_MODE: mode,
          FAKE_LOG: logFile,
          ...extraEnv,
        },
      }));
      return environment;
    }

    it('prepares a call here and runs it in the worker', async () => {
      const file = path.join(root, 'written.txt');
      const env = create('ok');
      expect([...env.toolNames!].sort()).toEqual([
        'edit',
        'read_file',
        'run_shell_command',
        'write_file',
      ]);
      const prepared = await env.prepare(
        {
          id: 'write',
          toolName: 'write_file',
          params: { file_path: file, content: 'x' },
        },
        signal,
      );
      expect(prepared.locations).toEqual([{ path: file }]);
      expect(await env.permission('write', signal)).toBe('ask');
      // The turn's prompt id rides the async context into the admission: the
      // durable batch is keyed by it.
      const result = await promptIdContext.run('prompt-1', () =>
        env.execute('write', signal),
      );
      expect(result.llmContent).toEqual([
        { text: `ran ${JSON.stringify({ file_path: file, content: 'x' })}` },
      ]);
      // The worker's journal names the call by the host's id for it.
      const entries = (await readFile(logFile, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              route?: string;
              boot?: string;
              request?: { reference?: { callId?: string } };
            },
        );
      const execute = entries.find((entry) => entry.route === 'execute');
      expect(execute?.request?.reference?.callId).toBe('write');
      // The call was admitted before dispatch: the intent and the checkpoint
      // name the tool, the final parameters and this worker's incarnation.
      expect(admissions).toEqual([
        expect.objectContaining({
          functionCallId: 'write',
          toolName: 'write_file',
          promptId: 'prompt-1',
          params: { file_path: file, content: 'x' },
          workerIncarnation: entries.find((entry) => entry.boot)?.boot,
          toolDefinition: {
            name: 'write_file',
            description: expect.any(String),
            parametersJsonSchema: expect.objectContaining({
              type: 'object',
            }),
          },
        }),
      ]);
      // It settled with a success the recorder saw, and the worker then
      // forgot it.
      expect(settlements).toEqual([
        expect.objectContaining({
          functionCallId: 'write',
          executionStatus: 'success',
          payload: expect.objectContaining({
            executionStatus: 'success',
            responseParts: [
              expect.objectContaining({
                text: `ran ${JSON.stringify({ file_path: file, content: 'x' })}`,
              }),
            ],
          }),
        }),
      ]);
      await vi.waitFor(async () => {
        const acknowledgesNow = (await readFile(logFile, 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map(
            (line) =>
              JSON.parse(line) as {
                route?: string;
                request?: { reference?: { callId?: string } };
              },
          )
          .filter((entry) => entry.route === 'acknowledge');
        expect(acknowledgesNow).toHaveLength(1);
        expect(acknowledgesNow[0]!.request?.reference?.callId).toBe('write');
      });
      // The host prepared it but never wrote the file.
      await expect(readFile(file, 'utf8')).rejects.toThrow();
    });

    it('waits for the admission before it dispatches the call', async () => {
      const env = create('ok');
      let release!: () => void;
      outcomeWaiters.admit = new Promise((resolve) => {
        release = resolve;
      });
      await env.prepare(
        {
          id: 'write',
          toolName: 'write_file',
          params: { file_path: path.join(root, 'written.txt'), content: 'x' },
        },
        signal,
      );
      const result = env.execute('write', signal);
      // The admission holds while the worker stands ready: dispatch is
      // blocked, not merely slow.
      for (;;) {
        const log = await readFile(logFile, 'utf8');
        if (log.includes('"boot"')) {
          expect(log).not.toContain('"execute"');
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      release();
      await result;
      expect(admissions).toHaveLength(1);
      expect(await readFile(logFile, 'utf8')).toContain('"execute"');
    });

    it('does not dispatch a call whose admission fails', async () => {
      const env = create('ok');
      outcomeFailures.admit = new Error('the journal is unavailable');
      await env.prepare(
        {
          id: 'write',
          toolName: 'write_file',
          params: { file_path: path.join(root, 'written.txt'), content: 'x' },
        },
        signal,
      );
      await expect(env.execute('write', signal)).rejects.toThrow(
        'journal is unavailable',
      );
      expect(admissions).toHaveLength(0);
      expect(settlements).toHaveLength(0);
      expect(await readFile(logFile, 'utf8')).not.toContain('"execute"');
    });

    it('commits the outcome before the model sees the result', async () => {
      const env = create('ok');
      let release!: () => void;
      outcomeWaiters.settle = new Promise((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const settleStarted = new Promise<void>((resolve) => {
        entered = resolve;
      });
      outcomeSignals.settle = entered;
      await env.prepare(
        {
          id: 'write',
          toolName: 'write_file',
          params: { file_path: path.join(root, 'written.txt'), content: 'x' },
        },
        signal,
      );
      let resolved = false;
      const result = env.execute('write', signal).then((value) => {
        resolved = true;
        return value;
      });
      // The settle commit entered, then paused; the commit has not landed,
      // so the model loop waits even though the worker settled the call.
      await settleStarted;
      await vi.waitFor(async () => {
        expect(await readFile(logFile, 'utf8')).toContain('"execute"');
      });
      // The worker never forgot anything before the commit landed.
      expect(await readFile(logFile, 'utf8')).not.toContain('"acknowledge"');
      await new Promise((resolve) => setImmediate(resolve));
      expect(resolved).toBe(false);
      release();
      await result;
      expect(settlements).toHaveLength(1);
      expect(resolved).toBe(true);
      // The worker forgot the call only after its commit landed.
      await vi.waitFor(async () => {
        const acknowledgesNow = (await readFile(logFile, 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map(
            (line) =>
              JSON.parse(line) as {
                route?: string;
                request?: { reference?: { callId?: string } };
              },
          )
          .filter((entry) => entry.route === 'acknowledge');
        expect(acknowledgesNow).toHaveLength(1);
        expect(acknowledgesNow[0]!.request?.reference?.callId).toBe('write');
      });
    });

    it('refuses to dispatch with no durable outcome writer', async () => {
      const soConfig = new Config({
        sessionId: SESSION_ID,
        targetDir: root,
        cwd: root,
        debugMode: false,
        model: 'test-model',
        usageStatisticsEnabled: false,
        telemetry: { enabled: false },
        deferTelemetryInitialization: true,
      });
      environment = createManagedRuntimeEnvironment(soConfig, () => ({
        command: process.execPath,
        args: [script],
        env: { ...process.env, FAKE_MODE: 'ok', FAKE_LOG: logFile },
      }));
      const env = environment;
      await env.prepare(
        {
          id: 'write',
          toolName: 'write_file',
          params: { file_path: path.join(root, 'written.txt'), content: 'x' },
        },
        signal,
      );
      await expect(env.execute('write', signal)).rejects.toThrow(
        'records no log',
      );
      expect(await readFile(logFile, 'utf8')).toBe('');
    });

    it('commits nothing when the turn cancels while the worker boots', async () => {
      const env = create('slow-ready', { FAKE_READY_MS: '600' });
      const controller = new AbortController();
      await env.prepare(
        {
          id: 'write',
          toolName: 'write_file',
          params: { file_path: path.join(root, 'written.txt'), content: 'x' },
        },
        controller.signal,
      );
      const result = env.execute('write', controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 100));
      controller.abort();
      const settled = await result;
      expect(settled.error?.message).toBe('The tool call was cancelled.');
      expect(admissions).toHaveLength(0);
      expect(settlements).toHaveLength(0);
      expect(await readFile(logFile, 'utf8')).not.toContain('"execute"');
    });

    it('returns the settled result when the receipt never lands', async () => {
      // Poison every acknowledge answer: the log shows the call ran, yet no
      // receipt comes back, and the model still gets its result.
      const env = create('acknowledge-never');
      await env.prepare(
        {
          id: 'write',
          toolName: 'write_file',
          params: { file_path: path.join(root, 'written.txt'), content: 'x' },
        },
        signal,
      );
      const result = await env.execute('write', signal);
      expect(result.llmContent).toEqual([
        {
          text: `ran ${JSON.stringify({ file_path: path.join(root, 'written.txt'), content: 'x' })}`,
        },
      ]);
      expect(settlements).toHaveLength(1);
      await vi.waitFor(async () => {
        expect(await readFile(logFile, 'utf8')).toContain('"acknowledge"');
      });
    });

    it('blocks the session when the durable settlement fails', async () => {
      const env = create('ok');
      outcomeFailures.settle = new Error('the authority stopped writing');
      await env.prepare(
        {
          id: 'write',
          toolName: 'write_file',
          params: { file_path: path.join(root, 'written.txt'), content: 'x' },
        },
        signal,
      );
      const failure = env.execute('write', signal);
      await expect(failure).rejects.toBeInstanceOf(
        ManagedRuntimeOutcomeUnknownError,
      );
      expect(config.getManagedSessionBlock()).toBeInstanceOf(
        ManagedRuntimeOutcomeUnknownError,
      );
      expect(config.getManagedSessionBlock()?.message).toContain(
        'durable settlement',
      );
      // The call was admitted before dispatch; its settlement never landed,
      // which is the durable unknown-outcome shape.
      expect(admissions).toHaveLength(1);
      expect(settlements).toHaveLength(0);
    });

    it('does not block when the settlement failed after the receipt committed', async () => {
      const env = create('ok');
      outcomeFailures.settle = new Error('the checkpoint resolve failed');
      outcomeReceipts.add('write');
      await env.prepare(
        {
          id: 'write',
          toolName: 'write_file',
          params: { file_path: path.join(root, 'written.txt'), content: 'x' },
        },
        signal,
      );
      // The receipt committed ahead of the failed step: the outcome is
      // provable from the log, so the turn continues on it.
      const result = await env.execute('write', signal);
      expect(result.llmContent).toEqual([
        {
          text: `ran ${JSON.stringify({ file_path: path.join(root, 'written.txt'), content: 'x' })}`,
        },
      ]);
      expect(config.getManagedSessionBlock()).toBeUndefined();
    });

    it('does not block when result shaping fails after the settlement landed', async () => {
      const env = create('null-part');
      await env.prepare(
        {
          id: 'write',
          toolName: 'write_file',
          params: { file_path: path.join(root, 'written.txt'), content: 'x' },
        },
        signal,
      );
      // The settlement committed; the failure to shape the result for the
      // model is an ordinary tool error, not an unknown outcome.
      await expect(env.execute('write', signal)).rejects.toThrow(TypeError);
      expect(settlements).toHaveLength(1);
      expect(config.getManagedSessionBlock()).toBeUndefined();
    });

    it("admits the call under the scheduler's call id when it carries one", async () => {
      const env = create('ok');
      await env.prepare(
        {
          id: 'invocation-1',
          callId: 'model-call-1',
          toolName: 'write_file',
          params: { file_path: path.join(root, 'written.txt'), content: 'x' },
        },
        signal,
      );
      await env.execute('invocation-1', signal);
      expect(admissions).toEqual([
        expect.objectContaining({ functionCallId: 'model-call-1' }),
      ]);
      expect(settlements).toEqual([
        expect.objectContaining({ functionCallId: 'model-call-1' }),
      ]);
      // The worker's journal names the call by the same id.
      const entries = (await readFile(logFile, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              route?: string;
              request?: { reference?: { callId?: string } };
            },
        );
      expect(
        entries.find((entry) => entry.route === 'execute')?.request?.reference
          ?.callId,
      ).toBe('model-call-1');
    });

    it('commits a refused call as not started and still settles it', async () => {
      const env = create('refuse');
      await env.prepare(
        {
          id: 'write',
          toolName: 'write_file',
          params: { file_path: path.join(root, 'written.txt'), content: 'x' },
        },
        signal,
      );
      const result = await env.execute('write', signal);
      expect(result.error?.message).toContain('The tool call did not run');
      expect(admissions).toHaveLength(1);
      expect(settlements).toEqual([
        expect.objectContaining({
          functionCallId: 'write',
          executionStatus: 'not_started',
        }),
      ]);
    });

    it('settles a call cancelled after its admission without dispatching it', async () => {
      const env = create('ok');
      let release!: () => void;
      outcomeWaiters.admit = new Promise((resolve) => {
        release = resolve;
      });
      const controller = new AbortController();
      await env.prepare(
        {
          id: 'write',
          toolName: 'write_file',
          params: { file_path: path.join(root, 'written.txt'), content: 'x' },
        },
        controller.signal,
      );
      let entered!: () => void;
      const admitStarted = new Promise<void>((resolve) => {
        entered = resolve;
      });
      outcomeSignals.admit = entered;
      const result = env.execute('write', controller.signal);
      await admitStarted;
      controller.abort();
      release();
      const settled = await result;
      expect(settled.error?.message).toBe('The tool call was cancelled.');
      // The durable payload keeps the cancellation evidence the live result
      // reports, so a restore can rebuild the same record from it.
      expect(settlements).toEqual([
        {
          functionCallId: 'write',
          executionStatus: 'cancelled',
          payload: {
            executionStatus: 'cancelled',
            responseParts: [],
            error: { message: 'The tool call was cancelled.' },
          },
        },
      ]);
      // The worker heard nothing: the admission stands, the cancelled
      // settlement closes it.
      expect(admissions).toEqual([
        expect.objectContaining({ functionCallId: 'write' }),
      ]);
      expect(await readFile(logFile, 'utf8')).not.toContain('"execute"');
    });

    it('blocks the session when the settlement of a cancelled call fails', async () => {
      const env = create('ok');
      let release!: () => void;
      outcomeWaiters.admit = new Promise((resolve) => {
        release = resolve;
      });
      const controller = new AbortController();
      await env.prepare(
        {
          id: 'write',
          toolName: 'write_file',
          params: { file_path: path.join(root, 'written.txt'), content: 'x' },
        },
        controller.signal,
      );
      let entered!: () => void;
      const admitStarted = new Promise<void>((resolve) => {
        entered = resolve;
      });
      outcomeSignals.admit = entered;
      const result = env.execute('write', controller.signal);
      await admitStarted;
      controller.abort();
      outcomeFailures.settle = new Error('the authority stopped writing');
      release();
      // The cancelled call's settlement never landing is the same unknown
      // outcome as a dispatched call's: the session blocks.
      await expect(result).rejects.toBeInstanceOf(
        ManagedRuntimeOutcomeUnknownError,
      );
      expect(config.getManagedSessionBlock()).toBeInstanceOf(
        ManagedRuntimeOutcomeUnknownError,
      );
      expect(settlements).toHaveLength(0);
      expect(await readFile(logFile, 'utf8')).not.toContain('"execute"');
    });

    it.each([true, 'true'])(
      'refuses a background command (%j) before it asks or starts a worker',
      async (isBackground) => {
        const env = create('ok');
        await expect(
          env.prepare(
            {
              id: 'background',
              toolName: 'run_shell_command',
              params: { command: 'sleep 1', is_background: isBackground },
            },
            signal,
          ),
        ).rejects.toThrow('foreground only');
        await expect(env.permission('background', signal)).rejects.toThrow(
          'Unknown execution invocation',
        );
        expect(await readFile(logFile, 'utf8')).toBe('');
      },
    );

    it('refuses a command in a directory the worker cannot reach', async () => {
      const env = create('ok');
      const outside = path.dirname(root);
      await expect(
        env.prepare(
          {
            id: 'outside',
            toolName: 'run_shell_command',
            params: { command: 'pwd', directory: outside },
          },
          signal,
        ),
      ).rejects.toThrow(`only in ${root}`);
      expect(await readFile(logFile, 'utf8')).toBe('');
    });

    it('judges a command directory by the directory the worker is bound to', async () => {
      const env = create('ok');
      const other = path.join(root, 'other');
      await mkdir(other);
      // Had the session's directory moved, the worker would still be bound
      // to the one it was created for.
      vi.spyOn(config, 'getTargetDir').mockReturnValue(
        path.join(root, 'below'),
      );
      await env.prepare(
        {
          id: 'other',
          toolName: 'run_shell_command',
          params: { command: 'pwd', directory: other },
        },
        signal,
      );
      await env.release('other', signal);
      await expect(
        env.prepare(
          {
            id: 'outside',
            toolName: 'run_shell_command',
            params: { command: 'pwd', directory: path.dirname(root) },
          },
          signal,
        ),
      ).rejects.toThrow(`only in ${root}.`);
    });

    it('runs a command in a directory below the session directory', async () => {
      const env = create('ok');
      const below = path.join(root, 'below');
      await mkdir(below);
      await env.prepare(
        {
          id: 'below',
          toolName: 'run_shell_command',
          params: { command: 'pwd', directory: below },
        },
        signal,
      );
      const result = await env.execute('below', signal);
      const execute = (await executeRequests())[0];
      expect(execute?.input).toMatchObject({
        command: 'pwd',
        directory: below,
      });
      expect(result.llmContent).toEqual([
        { text: `ran ${JSON.stringify(execute?.input)}` },
      ]);
    });

    it('prepares an edit here and makes it in the worker', async () => {
      const env = create('ok');
      const file = path.join(root, 'edited.txt');
      await writeFile(file, 'before');
      const params = {
        file_path: file,
        old_string: 'before',
        new_string: 'after',
      };
      const prepared = await env.prepare(
        { id: 'edit', toolName: 'edit', params },
        signal,
      );
      expect(prepared.locations?.map((location) => location.path)).toEqual([
        file,
      ]);
      expect(await env.permission('edit', signal)).toBe('ask');
      const result = await env.execute('edit', signal);
      expect((await executeRequests())[0]?.input).toEqual(params);
      expect(result.llmContent).toEqual([
        { text: `ran ${JSON.stringify(params)}` },
      ]);
      // The host prepared it but never changed the file.
      expect(await readFile(file, 'utf8')).toBe('before');
    });

    it('shows no copy of a file it read', async () => {
      const env = create('ok');
      const file = path.join(root, 'a.txt');
      await env.prepare(
        { id: 'read', toolName: 'read_file', params: { file_path: file } },
        signal,
      );
      const result = await env.execute('read', signal);
      expect(result.returnDisplay).toBe('');
      expect(result.llmContent).toEqual([
        { text: `ran ${JSON.stringify({ file_path: file })}` },
      ]);
    });

    it('gives each session a worker of its own', async () => {
      const other = new Config({
        sessionId: '5b0b2a5c-9f53-4a5e-8d0c-2f1b7c4e6a90',
        targetDir: root,
        cwd: root,
        debugMode: false,
        model: 'test-model',
        usageStatisticsEnabled: false,
        telemetry: { enabled: false },
        deferTelemetryInitialization: true,
      });
      recordOutcomes(other);
      const launch = () => ({
        command: process.execPath,
        args: [script],
        env: { ...process.env, FAKE_MODE: 'ok', FAKE_LOG: logFile },
      });
      const first = createManagedRuntimeEnvironment(config, launch);
      const second = createManagedRuntimeEnvironment(other, launch);
      try {
        for (const [env, id] of [
          [first, 'one'],
          [second, 'two'],
        ] as const) {
          await env.prepare(
            {
              id,
              toolName: 'read_file',
              params: { file_path: path.join(root, 'a.txt') },
            },
            signal,
          );
          await env.execute(id, signal);
        }
        const entries = (await readFile(logFile, 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map(
            (line) =>
              JSON.parse(line) as {
                pid?: number;
                route?: string;
                request?: { reference?: { sessionId?: string } };
              },
          );
        expect(new Set(entries.flatMap((entry) => entry.pid ?? [])).size).toBe(
          2,
        );
        const executions = entries.filter((entry) => entry.route === 'execute');
        expect(
          executions.flatMap(
            (entry) => entry.request?.reference?.sessionId ?? [],
          ),
        ).toEqual([SESSION_ID, '5b0b2a5c-9f53-4a5e-8d0c-2f1b7c4e6a90']);
      } finally {
        await first.dispose();
        await second.dispose();
      }
    });

    it('blocks the session when a call outcome is unknown', async () => {
      const env = create('unknown');
      await env.prepare(
        {
          id: 'read',
          toolName: 'read_file',
          params: { file_path: path.join(root, 'a.txt') },
        },
        signal,
      );
      const failure = env.execute('read', signal);
      await expect(failure).rejects.toBeInstanceOf(
        ManagedRuntimeOutcomeUnknownError,
      );
      expect(config.getManagedSessionBlock()).toBe(
        await failure.catch((error: unknown) => error),
      );
      // The call was admitted before dispatch; its item never settles, which
      // is the durable form of the block.
      expect(admissions).toEqual([
        expect.objectContaining({ functionCallId: 'read' }),
      ]);
      expect(settlements).toEqual([]);
      // Whatever the worker still runs is stopped with it.
      const [{ pid }] = (await readFile(logFile, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { pid?: number });
      expect(() => process.kill(pid!, 0)).toThrow();
    });

    it(
      'holds the quarantine when a never-readable ledger is deleted from outside the sweep',
      // The reaper's ticks are seconds apart.
      { timeout: 30_000 },
      async () => {
        // A never-judged file that vanishes from outside proves nothing —
        // the single-ledger sibling holds the same fact terminal: no lift,
        // however many retries pass. The lift lives with the next test:
        // a proof the sweep itself made.
        const sweeperConfig = new Config({
          sessionId: '11111111-2222-3333-4444-555555555555',
          targetDir: root,
          cwd: root,
          debugMode: false,
          model: 'test-model',
          usageStatisticsEnabled: false,
          telemetry: { enabled: false },
          deferTelemetryInitialization: true,
        });
        const reportSpy = vi.spyOn(
          sweeperConfig,
          'reportManagedEngineQuarantine',
        );
        const clearSpy = vi.spyOn(
          sweeperConfig,
          'clearManagedEngineQuarantine',
        );
        const ledgerDir = path.join(
          sweeperConfig.storage.getProjectTempDir(),
          'managed-runtime',
        );
        await mkdir(ledgerDir, { recursive: true });
        // A FRESH unreadable ledger: old enough to judge, too young to
        // retire, so the sweep fails the same way on every retry until an
        // outside actor — here the test — removes the blocker.
        const ghost = path.join(ledgerDir, 'ghost.json');
        await writeFile(ghost, '{not a ledger', 'utf8');

        environment = createManagedRuntimeEnvironment(sweeperConfig, () => ({
          command: process.execPath,
          args: [script],
          env: { ...process.env, FAKE_MODE: 'ok', FAKE_LOG: logFile },
        }));
        await vi.waitFor(() => {
          expect(reportSpy).toHaveBeenCalled();
        });
        expect(clearSpy).not.toHaveBeenCalled();

        await rm(ghost);
        // Several retry intervals pass: the terminal fact means no lift.
        await new Promise((resolve) => setTimeout(resolve, 3_500));
        expect(clearSpy).not.toHaveBeenCalled();
        expect(reportSpy).toHaveBeenCalledTimes(1);
      },
    );

    it(
      'holds the quarantine for a vanished unreadable ledger when a sibling ledger proves out beside it',
      // The reaper's ticks are seconds apart.
      { timeout: 40_000 },
      async () => {
        // One failure batch can arm several ledgers: an unreadable ghost
        // (which names nothing) beside a sibling whose groups die later.
        // The sibling's proof is evidence about ITS file only — the ghost's
        // own vanished truth was never judged, so the quarantine must stay
        // terminal where a union of every ledger's names would lift.
        const sweeperConfig = new Config({
          sessionId: '11111111-2222-3333-4444-555555555555',
          targetDir: root,
          cwd: root,
          debugMode: false,
          model: 'test-model',
          usageStatisticsEnabled: false,
          telemetry: { enabled: false },
          deferTelemetryInitialization: true,
        });
        const reportSpy = vi.spyOn(
          sweeperConfig,
          'reportManagedEngineQuarantine',
        );
        const clearSpy = vi.spyOn(
          sweeperConfig,
          'clearManagedEngineQuarantine',
        );
        const ledgerDir = path.join(
          sweeperConfig.storage.getProjectTempDir(),
          'managed-runtime',
        );
        await mkdir(ledgerDir, { recursive: true });
        // Ghost A: fresh enough to be swept, too young to retire — it names
        // nothing and never will.
        const ghost = path.join(ledgerDir, 'ghost.json');
        await writeFile(ghost, '{not a ledger', 'utf8');
        // Ledger B: names a real live process group this test owns. The
        // record stamp sits just in the future, so the first passes judge
        // the group 'unknown' and hold it unproven; once the wall clock
        // passes the stamp, a retry judges the group against its own age,
        // signals it, and proves B clean — evidence that must not speak
        // for A.
        const child = spawn('sleep', ['300'], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        const pgid = child.pid!;
        const sibling = path.join(ledgerDir, 'sibling.json');
        testInternals.writeLedgerDocument(
          sibling,
          {
            pid: 42424244,
            pgid: 42424244,
            incarnation: 'incarnation-1',
            startedAt: Date.now(),
          },
          [
            {
              pgid,
              callId: 'call-sibling',
              startedAt: Date.now() + 2_500,
            },
          ],
        );
        try {
          environment = createManagedRuntimeEnvironment(sweeperConfig, () => ({
            command: process.execPath,
            args: [script],
            env: { ...process.env, FAKE_MODE: 'ok', FAKE_LOG: logFile },
          }));
          await vi.waitFor(
            () => {
              expect(reportSpy).toHaveBeenCalled();
            },
            { timeout: 15_000 },
          );
          expect(clearSpy).not.toHaveBeenCalled();
          // The ghost vanishes from outside the sweep.
          await rm(ghost);
          // A retry proves the sibling ledger itself — its own real group
          // signed, its file unlinked.
          await vi.waitFor(
            () => {
              expect(existsSync(sibling)).toBe(false);
            },
            { timeout: 15_000 },
          );
          // The sibling's proof is in. Several intervals pass: the ghost's
          // unproven stop still keeps the quarantine.
          await new Promise((resolve) => setTimeout(resolve, 4_000));
          expect(clearSpy).not.toHaveBeenCalled();
          expect(reportSpy).toHaveBeenCalledTimes(1);
        } finally {
          try {
            process.kill(-pgid, 'SIGKILL');
          } catch {
            // Already proven by the sweep.
          }
        }
      },
    );

    it(
      'two environment creations in one sweep window share the stale-ledger pass',
      { timeout: 30_000 },
      async () => {
        // The installation-time directory sweep is once per ledger dir per
        // window: a second environment created while the first pass is in
        // flight joins it rather than paying a second full scan on the
        // child's single thread. The wrapped sweep records every pass it
        // starts; the seeded ledger must show up in it exactly once.
        const sweeperConfig = (sessionId: string) =>
          new Config({
            sessionId,
            targetDir: root,
            cwd: root,
            debugMode: false,
            model: 'test-model',
            usageStatisticsEnabled: false,
            telemetry: { enabled: false },
            deferTelemetryInitialization: true,
          });
        const firstConfig = sweeperConfig(
          '22222222-2222-3333-4444-555555555555',
        );
        const ledgerDir = path.join(
          firstConfig.storage.getProjectTempDir(),
          'managed-runtime',
        );
        await mkdir(ledgerDir, { recursive: true });
        // A stale ledger another child provable finished with: dead worker,
        // no groups — it proves fast, on the first pass that reads it.
        const stale = path.join(ledgerDir, 'stale.json');
        testInternals.writeLedgerDocument(
          stale,
          {
            pid: 42424246,
            pgid: 42424246,
            incarnation: 'incarnation-1',
            startedAt: Date.now(),
          },
          [],
        );
        sweepWitnesses.records.length = 0;
        sweepWitnesses.dirCalls.length = 0;
        const launch = () => ({
          command: process.execPath,
          args: [script],
          env: { ...process.env, FAKE_MODE: 'ok', FAKE_LOG: logFile },
        });
        // Both creations land before the first pass can settle, so the
        // second joins it.
        environment = createManagedRuntimeEnvironment(firstConfig, launch);
        const second = createManagedRuntimeEnvironment(
          sweeperConfig('33333333-2222-3333-4444-555555555555'),
          launch,
        );
        try {
          // The pass actually judged the seeded ledger (it unlinks a
          // proven one): without that, a zero-pass count would green the
          // assertion vacuously.
          await vi.waitFor(
            () => {
              expect(existsSync(stale)).toBe(false);
            },
            { timeout: 10_000 },
          );
          // Any accidental second pass would land in the same window.
          await new Promise((resolve) => setTimeout(resolve, 500));
          expect(
            sweepWitnesses.dirCalls.filter(
              (call) => call.directory === ledgerDir,
            ),
          ).toHaveLength(1);
        } finally {
          await second.dispose();
        }
      },
    );

    it(
      'a second environment creation never sweeps the first live worker',
      { timeout: 30_000 },
      async () => {
        // Two Managed sessions in one child share the ledger dir, and the
        // second one's startup sweep must not prove anything about the
        // first session's live worker. The ONLY thing holding that line is
        // the skip-set wiring: launchedLedgerPaths.add before every spawn
        // keeps the first worker's ledger invisible to the sibling pass,
        // because holdsForLiveHost explicitly refuses to hold what this
        // process itself parented. Dropping the wire SIGKILLs the first
        // worker mid-Shell.
        const sweeperConfig = (sessionId: string) =>
          new Config({
            sessionId,
            targetDir: root,
            cwd: root,
            debugMode: false,
            model: 'test-model',
            usageStatisticsEnabled: false,
            telemetry: { enabled: false },
            deferTelemetryInitialization: true,
          });
        const firstConfig = sweeperConfig(
          '44444444-2222-3333-4444-555555555555',
        );
        const ledgerDir = path.join(
          firstConfig.storage.getProjectTempDir(),
          'managed-runtime',
        );
        const launch = () => ({
          command: process.execPath,
          args: [script],
          env: { ...process.env, FAKE_MODE: 'ok', FAKE_LOG: logFile },
        });
        // The first session's worker, launched through the same production
        // constructor the environment wraps: its launch has already
        // enrolled its ledger path in the process-wide skip set by the time
        // the environment creation below runs the startup sweep.
        const firstWorker = new ManagedSessionRuntimeWorker(
          SESSION_ID,
          root,
          launch,
          undefined,
          { ledgerDir },
        );
        await firstWorker.execute('read_file', { file_path: 'a.txt' }, signal);
        let inc = '';
        await vi.waitFor(
          async () => {
            const entries = (await readFile(logFile, 'utf8'))
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line) as { boot?: string });
            expect(entries.some((entry) => entry.boot !== undefined)).toBe(
              true,
            );
            inc = entries.find((entry) => entry.boot !== undefined)!.boot!;
          },
          { timeout: 10_000 },
        );
        const liveWorkerLedger = path.join(ledgerDir, `${inc}.json`);
        // A live, marker-bearing process recorded as that ledger's worker:
        // exactly the shape the sibling sweep would sign and unlink without
        // the skip.
        const fixture = spawn(
          process.execPath,
          ['-e', 'setInterval(() => {}, 1_000_000)', 'managed-runtime-worker'],
          { detached: true, stdio: 'ignore' },
        );
        fixture.unref();
        fixture.on('exit', () => undefined);
        const fixturePid = fixture.pid!;
        testInternals.writeLedgerDocument(
          liveWorkerLedger,
          {
            pid: fixturePid,
            pgid: fixturePid,
            incarnation: inc,
            startedAt: Date.now(),
          },
          [],
        );
        const second = createManagedRuntimeEnvironment(
          sweeperConfig('55555555-2222-3333-4444-555555555555'),
          launch,
        );
        try {
          // The sibling pass settles quickly over one file; give it its
          // window, then the live worker still runs and its file stands.
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          expect(processGroupLiveness(fixturePid)).toBe('alive');
          expect(existsSync(liveWorkerLedger)).toBe(true);
        } finally {
          await second.dispose();
          await firstWorker.close().catch(() => undefined);
          try {
            process.kill(-fixturePid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
      },
    );

    it(
      'lifts the quarantine when the retry sweep itself proves the ledger clean',
      // The reaper's ticks are seconds apart.
      { timeout: 30_000 },
      async () => {
        // The startup reaper must accept its own sweep's proof: a retry
        // that judges the recorded group recycled — the id outlived its
        // group — deletes the ledger and resolves 'proven', and that
        // verdict, not the liveness of the ids the first failure named,
        // lifts the quarantine.
        {
          const sweeperConfig = new Config({
            sessionId: '11111111-2222-3333-4444-555555555555',
            targetDir: root,
            cwd: root,
            debugMode: false,
            model: 'test-model',
            usageStatisticsEnabled: false,
            telemetry: { enabled: false },
            deferTelemetryInitialization: true,
          });
          const reportSpy = vi.spyOn(
            sweeperConfig,
            'reportManagedEngineQuarantine',
          );
          const clearSpy = vi.spyOn(
            sweeperConfig,
            'clearManagedEngineQuarantine',
          );
          const ledgerDir = path.join(
            sweeperConfig.storage.getProjectTempDir(),
            'managed-runtime',
          );
          await mkdir(ledgerDir, { recursive: true });
          // Phase 1: an undatable group — a leaderless survivor younger
          // than its record — arms the quarantine and stays alive.
          const leader = spawn('bash', ['-c', 'sleep 300 & exit 0'], {
            detached: true,
            stdio: 'ignore',
          });
          leader.unref();
          leader.on('exit', () => undefined);
          if (leader.pid === undefined) throw new Error('spawn failed');
          const groupId = leader.pid;
          try {
            const memberDeadline = Date.now() + 10_000;
            for (;;) {
              const rows = [...queryProcessTable().values()].filter(
                (row) => row.pgid === groupId,
              );
              const leaderGone = !rows.some((row) => row.pid === groupId);
              const memberAlive = rows.some((row) => row.pid !== groupId);
              if (
                processGroupLiveness(groupId) === 'alive' &&
                leaderGone &&
                memberAlive
              ) {
                break;
              }
              if (Date.now() > memberDeadline) {
                throw new Error('the leaderless member never appeared');
              }
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            const workFile = path.join(ledgerDir, 'undatable.json');
            testInternals.writeLedgerDocument(
              workFile,
              {
                pid: 42424243,
                pgid: 42424243,
                incarnation: 'incarnation-undatable',
                startedAt: Date.now(),
              },
              [
                {
                  pgid: groupId,
                  callId: 'call-1',
                  startedAt: Date.now() - 60_000,
                },
              ],
            );
            environment = createManagedRuntimeEnvironment(
              sweeperConfig,
              () => ({
                command: process.execPath,
                args: [script],
                env: { ...process.env, FAKE_MODE: 'ok', FAKE_LOG: logFile },
              }),
            );
            const deadline = Date.now() + 15_000;
            while (reportSpy.mock.calls.length === 0) {
              if (Date.now() > deadline) throw new Error('never quarantined');
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            expect(clearSpy).not.toHaveBeenCalled();

            // Phase 2: the ledger now names a live young leader with an
            // hour-old record — the id provably outlived its group. The
            // retry resolves it recycled, deletes the file and returns
            // 'proven', which lifts — even though the id the first failure
            // named still runs.
            const young = spawn('sleep', ['300'], {
              detached: true,
              stdio: 'ignore',
            });
            young.unref();
            young.on('exit', () => undefined);
            if (young.pid === undefined) throw new Error('spawn failed');
            const youngPid = young.pid;
            try {
              const settleDeadline = Date.now() + 10_000;
              for (;;) {
                const rows = [...queryProcessTable().values()].filter(
                  (row) => row.pgid === youngPid,
                );
                if (rows.length === 1 && rows[0]!.pid === youngPid) break;
                if (Date.now() > settleDeadline) {
                  throw new Error('the young group never settled');
                }
                await new Promise((resolve) => setTimeout(resolve, 25));
              }
              testInternals.writeLedgerDocument(
                workFile,
                {
                  pid: 42424243,
                  pgid: 42424243,
                  incarnation: 'incarnation-undatable',
                  startedAt: Date.now() - 3_600_000,
                },
                [
                  {
                    pgid: youngPid,
                    callId: 'call-2',
                    startedAt: Date.now() - 3_600_000,
                  },
                ],
              );
              await vi.waitFor(
                () => {
                  expect(clearSpy).toHaveBeenCalled();
                },
                { timeout: 15_000 },
              );
              // The proof deleted the ledger; the unrelated group the first
              // failure named is still running, untouched.
              expect(existsSync(workFile)).toBe(false);
              expect(processGroupLiveness(groupId)).toBe('alive');
              expect(processGroupLiveness(youngPid)).toBe('alive');
            } finally {
              try {
                process.kill(-youngPid, 'SIGKILL');
              } catch {
                // gone already
              }
            }
          } finally {
            try {
              process.kill(-groupId, 'SIGKILL');
            } catch {
              // gone already
            }
          }
        }
      },
    );

    it(
      'stops retrying for good when a retry ages the unreadable ledger out',
      // The reaper's ticks are seconds apart.
      { timeout: 30_000 },
      async () => {
        // A fresh unreadable ledger arms the quarantine as unproven; once it
        // outlives the debris age BETWEEN retries, the retry sweep sets it
        // aside and rejects with the retirement — and only the closure's
        // reading of that rejection keeps a later 'absent' pass from lifting.
        {
          const sweeperConfig = new Config({
            sessionId: '11111111-2222-3333-4444-555555555555',
            targetDir: root,
            cwd: root,
            debugMode: false,
            model: 'test-model',
            usageStatisticsEnabled: false,
            telemetry: { enabled: false },
            deferTelemetryInitialization: true,
          });
          const reportSpy = vi.spyOn(
            sweeperConfig,
            'reportManagedEngineQuarantine',
          );
          const clearSpy = vi.spyOn(
            sweeperConfig,
            'clearManagedEngineQuarantine',
          );
          const ledgerDir = path.join(
            sweeperConfig.storage.getProjectTempDir(),
            'managed-runtime',
          );
          await mkdir(ledgerDir, { recursive: true });
          const ghost = path.join(ledgerDir, 'ghost.json');
          await writeFile(ghost, '{not a ledger', 'utf8');
          // Just inside the debris age: the arming sweep still reads it as
          // unproven; the first retry, a second later, retires it.
          const almostAged = new Date(Date.now() - 59_250);
          utimesSync(ghost, almostAged, almostAged);

          environment = createManagedRuntimeEnvironment(sweeperConfig, () => ({
            command: process.execPath,
            args: [script],
            env: { ...process.env, FAKE_MODE: 'ok', FAKE_LOG: logFile },
          }));
          await vi.waitFor(
            () => {
              expect(reportSpy).toHaveBeenCalled();
            },
            { timeout: 15_000 },
          );
          expect(clearSpy).not.toHaveBeenCalled();

          // The retry sets the ledger aside, reads its own rejection as
          // terminal, and stops: over the next intervals there is no lift.
          await vi.waitFor(
            () => {
              expect(existsSync(path.join(ledgerDir, 'ghost.unreadable'))).toBe(
                true,
              );
            },
            { timeout: 15_000 },
          );
          await new Promise((resolve) => setTimeout(resolve, 3_500));
          expect(clearSpy).not.toHaveBeenCalled();
          expect(reportSpy).toHaveBeenCalledTimes(1);
        }
      },
    );

    it(
      'holds the quarantine for good once a ledger is set aside unreadable',
      // The reaper's ticks are seconds apart.
      { timeout: 30_000 },
      async () => {
        // A retirement rides the sweep's rejection: the file set aside is
        // judged by no later pass, so the terminal fact must arrive with
        // the failure that armed the reaper — after it, no later clean pass
        // may read as a proof, not even once everything else has died.
        {
          const sweeperConfig = new Config({
            sessionId: '11111111-2222-3333-4444-555555555555',
            targetDir: root,
            cwd: root,
            debugMode: false,
            model: 'test-model',
            usageStatisticsEnabled: false,
            telemetry: { enabled: false },
            deferTelemetryInitialization: true,
          });
          const reportSpy = vi.spyOn(
            sweeperConfig,
            'reportManagedEngineQuarantine',
          );
          const clearSpy = vi.spyOn(
            sweeperConfig,
            'clearManagedEngineQuarantine',
          );
          const ledgerDir = path.join(
            sweeperConfig.storage.getProjectTempDir(),
            'managed-runtime',
          );
          await mkdir(ledgerDir, { recursive: true });
          // An AGED unreadable ledger: the first sweep sets it aside.
          const ghost = path.join(ledgerDir, 'ghost.json');
          await writeFile(ghost, '{not a ledger', 'utf8');
          const past = new Date(Date.now() - 120_000);
          utimesSync(ghost, past, past);
          // …and a stale ledger whose group the sweep cannot date, so the
          // same rejection also names groups.
          const leader = spawn('bash', ['-c', 'sleep 300 & exit 0'], {
            detached: true,
            stdio: 'ignore',
          });
          leader.unref();
          leader.on('exit', () => undefined);
          if (leader.pid === undefined) throw new Error('spawn failed');
          const groupId = leader.pid;
          try {
            const memberDeadline = Date.now() + 10_000;
            for (;;) {
              const rows = [...queryProcessTable().values()].filter(
                (row) => row.pgid === groupId,
              );
              const leaderGone = !rows.some((row) => row.pid === groupId);
              const memberAlive = rows.some((row) => row.pid !== groupId);
              if (
                processGroupLiveness(groupId) === 'alive' &&
                leaderGone &&
                memberAlive
              ) {
                break;
              }
              if (Date.now() > memberDeadline) {
                throw new Error('the leaderless member never appeared');
              }
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            const staleFile = path.join(ledgerDir, 'stale.json');
            testInternals.writeLedgerDocument(
              staleFile,
              {
                pid: 42424244,
                pgid: 42424244,
                incarnation: 'incarnation-stale',
                startedAt: Date.now(),
              },
              [
                {
                  pgid: groupId,
                  callId: 'call-1',
                  startedAt: Date.now() - 60_000,
                },
              ],
            );
            environment = createManagedRuntimeEnvironment(
              sweeperConfig,
              () => ({
                command: process.execPath,
                args: [script],
                env: { ...process.env, FAKE_MODE: 'ok', FAKE_LOG: logFile },
              }),
            );
            await vi.waitFor(
              () => {
                expect(reportSpy).toHaveBeenCalled();
              },
              { timeout: 15_000 },
            );
            expect(existsSync(path.join(ledgerDir, 'ghost.unreadable'))).toBe(
              true,
            );
            expect(clearSpy).not.toHaveBeenCalled();

            // The group the rejection named dies: the lift must still never
            // come — the retired ledger's groups can never be proven.
            try {
              process.kill(-groupId, 'SIGKILL');
            } catch {
              // gone already
            }
            await new Promise((resolve) => setTimeout(resolve, 3_500));
            expect(clearSpy).not.toHaveBeenCalled();
            expect(reportSpy).toHaveBeenCalledTimes(1);
          } finally {
            try {
              process.kill(-groupId, 'SIGKILL');
            } catch {
              // gone already
            }
          }
        }
      },
    );

    it(
      'a retirement settles what still can be proven before going terminal',
      // The reaper's backoff spaces its ticks seconds apart.
      { timeout: 30_000 },
      async () => {
        // One aged unreadable ledger retires while a second ledger's
        // undatable group is still outstanding: the retirement keeps the
        // lift from ever firing, but the provable entry keeps its retries —
        // once the group dies, its ledger is swept clean even though the
        // quarantine stands.
        {
          const sweeperConfig = new Config({
            sessionId: '11111111-2222-3333-4444-555555555555',
            targetDir: root,
            cwd: root,
            debugMode: false,
            model: 'test-model',
            usageStatisticsEnabled: false,
            telemetry: { enabled: false },
            deferTelemetryInitialization: true,
          });
          const reportSpy = vi.spyOn(
            sweeperConfig,
            'reportManagedEngineQuarantine',
          );
          const clearSpy = vi.spyOn(
            sweeperConfig,
            'clearManagedEngineQuarantine',
          );
          const ledgerDir = path.join(
            sweeperConfig.storage.getProjectTempDir(),
            'managed-runtime',
          );
          await mkdir(ledgerDir, { recursive: true });
          // An AGED unreadable ledger: the arming sweep sets it aside.
          const ghost = path.join(ledgerDir, 'ghost.json');
          await writeFile(ghost, '{not a ledger', 'utf8');
          const past = new Date(Date.now() - 120_000);
          utimesSync(ghost, past, past);
          // …and a stale ledger whose group the sweep cannot date, so the
          // same rejection also names groups.
          const leader = spawn('bash', ['-c', 'sleep 300 & exit 0'], {
            detached: true,
            stdio: 'ignore',
          });
          leader.unref();
          leader.on('exit', () => undefined);
          if (leader.pid === undefined) throw new Error('spawn failed');
          const groupId = leader.pid;
          try {
            const memberDeadline = Date.now() + 10_000;
            for (;;) {
              const rows = [...queryProcessTable().values()].filter(
                (row) => row.pgid === groupId,
              );
              const leaderGone = !rows.some((row) => row.pid === groupId);
              const memberAlive = rows.some((row) => row.pid !== groupId);
              if (
                processGroupLiveness(groupId) === 'alive' &&
                leaderGone &&
                memberAlive
              ) {
                break;
              }
              if (Date.now() > memberDeadline) {
                throw new Error('the leaderless member never appeared');
              }
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            const staleFile = path.join(ledgerDir, 'stale.json');
            testInternals.writeLedgerDocument(
              staleFile,
              {
                pid: 42424244,
                pgid: 42424244,
                incarnation: 'incarnation-stale',
                startedAt: Date.now(),
              },
              [
                {
                  pgid: groupId,
                  callId: 'call-1',
                  startedAt: Date.now() - 60_000,
                },
              ],
            );
            environment = createManagedRuntimeEnvironment(
              sweeperConfig,
              () => ({
                command: process.execPath,
                args: [script],
                env: { ...process.env, FAKE_MODE: 'ok', FAKE_LOG: logFile },
              }),
            );
            await vi.waitFor(
              () => {
                expect(reportSpy).toHaveBeenCalled();
              },
              { timeout: 15_000 },
            );
            expect(clearSpy).not.toHaveBeenCalled();

            // The named group dies: a reaper that retired with the ghost
            // would never re-sweep the stale ledger, so its file going away
            // witnesses the retry; the lift must still never come.
            try {
              process.kill(-groupId, 'SIGKILL');
            } catch {
              // gone already
            }
            await vi.waitFor(
              () => {
                expect(processGroupLiveness(groupId)).toBe('gone');
                expect(existsSync(staleFile)).toBe(false);
              },
              { timeout: 15_000 },
            );
            await new Promise((resolve) => setTimeout(resolve, 2_500));
            expect(clearSpy).not.toHaveBeenCalled();
            expect(reportSpy).toHaveBeenCalledTimes(1);
          } finally {
            try {
              process.kill(-groupId, 'SIGKILL');
            } catch {
              // gone already
            }
          }
        }
      },
    );

    it(
      'holds the quarantine while a group named by a deleted ledger still runs',
      // The reaper's backoff spaces its ticks seconds apart.
      { timeout: 30_000 },
      async () => {
        // The startup sweep's reaper re-probes the groups the last failure
        // named when the file itself is gone: deleting the ledger proves
        // nothing about them, so the lift waits for their deaths.
        {
          const sweeperConfig = new Config({
            sessionId: '11111111-2222-3333-4444-555555555555',
            targetDir: root,
            cwd: root,
            debugMode: false,
            model: 'test-model',
            usageStatisticsEnabled: false,
            telemetry: { enabled: false },
            deferTelemetryInitialization: true,
          });
          const reportSpy = vi.spyOn(
            sweeperConfig,
            'reportManagedEngineQuarantine',
          );
          const clearSpy = vi.spyOn(
            sweeperConfig,
            'clearManagedEngineQuarantine',
          );
          const ledgerDir = path.join(
            sweeperConfig.storage.getProjectTempDir(),
            'managed-runtime',
          );
          await mkdir(ledgerDir, { recursive: true });
          // A leaderless group whose only member is younger than its record:
          // the shape a sweep can neither signal nor resolve.
          const leader = spawn('bash', ['-c', 'sleep 300 & exit 0'], {
            detached: true,
            stdio: 'ignore',
          });
          leader.unref();
          leader.on('exit', () => undefined);
          if (leader.pid === undefined) throw new Error('spawn failed');
          const groupId = leader.pid;
          try {
            // The member exists and the leader is gone before the record is
            // judged: a live young leader would read the id as recycled.
            const memberDeadline = Date.now() + 10_000;
            for (;;) {
              const rows = [...queryProcessTable().values()].filter(
                (row) => row.pgid === groupId,
              );
              const leaderGone = !rows.some((row) => row.pid === groupId);
              const memberAlive = rows.some((row) => row.pid !== groupId);
              if (
                processGroupLiveness(groupId) === 'alive' &&
                leaderGone &&
                memberAlive
              ) {
                break;
              }
              if (Date.now() > memberDeadline) {
                throw new Error('the leaderless member never appeared');
              }
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            const workFile = path.join(ledgerDir, 'undatable.json');
            testInternals.writeLedgerDocument(
              workFile,
              {
                pid: 42424243,
                pgid: 42424243,
                incarnation: 'incarnation-undatable',
                startedAt: Date.now(),
              },
              [
                {
                  pgid: groupId,
                  callId: 'call-1',
                  startedAt: Date.now() - 60_000,
                },
              ],
            );
            environment = createManagedRuntimeEnvironment(
              sweeperConfig,
              () => ({
                command: process.execPath,
                args: [script],
                env: { ...process.env, FAKE_MODE: 'ok', FAKE_LOG: logFile },
              }),
            );
            const deadline = Date.now() + 15_000;
            while (reportSpy.mock.calls.length === 0) {
              if (Date.now() > deadline) throw new Error('never quarantined');
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            expect(clearSpy).not.toHaveBeenCalled();

            // An unrelated ledger the retry sweep CAN prove: a
            // directory-level 'proven' earned by a ledger that did not arm
            // the quarantine must not lift it either.
            testInternals.writeLedgerDocument(
              path.join(ledgerDir, 'settled.json'),
              {
                pid: 42424244,
                pgid: 42424244,
                incarnation: 'incarnation-settled',
                startedAt: Date.now() - 60_000,
              },
              [
                {
                  pgid: 42424245,
                  callId: 'call-9',
                  startedAt: Date.now() - 60_000,
                },
              ],
            );

            // Deleting the ledger must not lift: the group it named still runs.
            await rm(workFile);
            await new Promise((resolve) => setTimeout(resolve, 2_500));
            expect(clearSpy).not.toHaveBeenCalled();

            // Once the named group dies, the reaper proves it and lifts.
            try {
              process.kill(-groupId, 'SIGKILL');
            } catch {
              // gone already
            }
            await vi.waitFor(
              () => {
                expect(clearSpy).toHaveBeenCalled();
              },
              { timeout: 15_000 },
            );
          } finally {
            try {
              process.kill(-groupId, 'SIGKILL');
            } catch {
              // gone already
            }
          }
        }
      },
    );

    it('sweeps the stale worker ledgers of an earlier child when it starts', async () => {
      {
        const sweeperConfig = new Config({
          sessionId: '11111111-2222-3333-4444-555555555555',
          targetDir: root,
          cwd: root,
          debugMode: false,
          model: 'test-model',
          usageStatisticsEnabled: false,
          telemetry: { enabled: false },
          deferTelemetryInitialization: true,
        });
        const ledgerDir = path.join(
          sweeperConfig.storage.getProjectTempDir(),
          'managed-runtime',
        );
        await mkdir(ledgerDir, { recursive: true });
        const child = spawn('sleep', ['300'], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        child.on('exit', () => undefined);
        if (child.pid === undefined) throw new Error('spawn failed');
        const stalePid = child.pid;
        const workFile = path.join(ledgerDir, 'stale.json');
        testInternals.writeLedgerDocument(
          workFile,
          {
            pid: 42424243,
            pgid: 42424243,
            incarnation: 'incarnation-2',
            startedAt: Date.now(),
          },
          [{ pgid: stalePid, callId: 'call-stale', startedAt: Date.now() }],
        );
        try {
          environment = createManagedRuntimeEnvironment(sweeperConfig, () => ({
            command: process.execPath,
            args: [script],
            env: { ...process.env, FAKE_MODE: 'ok', FAKE_LOG: logFile },
          }));
          // The stale ledger's group is the earlier worker's: its processes
          // die before this engine runs anything.
          const deadline = Date.now() + 15_000;
          const settled = () =>
            processGroupLiveness(stalePid) === 'gone' && !existsSync(workFile);
          while (!settled()) {
            if (Date.now() > deadline) {
              throw new Error('startup sweep never reaped the stale group');
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          expect(existsSync(workFile)).toBe(false);
          await environment.dispose();

          // A ledger landing after the first sweep still finds a sweep on
          // the next environment's creation: the guard is the live skip set,
          // not a once-per-process stamp.
          const later = spawn('sleep', ['300'], {
            detached: true,
            stdio: 'ignore',
          });
          later.unref();
          later.on('exit', () => undefined);
          if (later.pid === undefined) throw new Error('spawn failed');
          const laterPid = later.pid;
          const laterFile = path.join(ledgerDir, 'stale-2.json');
          testInternals.writeLedgerDocument(
            laterFile,
            {
              pid: 42424246,
              pgid: 42424246,
              incarnation: 'incarnation-3',
              startedAt: Date.now(),
            },
            [{ pgid: laterPid, callId: 'call-stale-2', startedAt: Date.now() }],
          );
          const laterConfig = new Config({
            sessionId: '22222222-3333-4444-5555-666666666666',
            targetDir: root,
            cwd: root,
            debugMode: false,
            model: 'test-model',
            usageStatisticsEnabled: false,
            telemetry: { enabled: false },
            deferTelemetryInitialization: true,
          });
          environment = createManagedRuntimeEnvironment(laterConfig, () => ({
            command: process.execPath,
            args: [script],
            env: { ...process.env, FAKE_MODE: 'ok', FAKE_LOG: logFile },
          }));
          // Phase 2 earns its own budget: what phase 1 spent is not owed to
          // it, and a failed wait must still kill the sleeper below.
          const laterDeadline = Date.now() + 15_000;
          try {
            const laterSettled = () =>
              processGroupLiveness(laterPid) === 'gone' &&
              !existsSync(laterFile);
            while (!laterSettled()) {
              if (Date.now() > laterDeadline) {
                throw new Error('no sweep ran for a ledger created mid-life');
              }
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            expect(existsSync(laterFile)).toBe(false);
          } finally {
            try {
              process.kill(-laterPid, 'SIGKILL');
            } catch {
              try {
                process.kill(laterPid, 'SIGKILL');
              } catch {
                // gone already
              }
            }
          }
        } finally {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            try {
              process.kill(child.pid, 'SIGKILL');
            } catch {
              // gone already
            }
          }
        }
      }
    });
  },
);

describe('toToolResult', () => {
  it('reports the model parts of a successful call', () => {
    expect(
      toToolResult({
        executionStatus: 'success',
        responseParts: [
          { type: 'text', text: 'line' },
          { inlineData: { mimeType: 'image/png', data: 'AA==' } },
        ],
      }),
    ).toEqual({
      llmContent: [
        { text: 'line' },
        { inlineData: { mimeType: 'image/png', data: 'AA==' } },
      ],
      returnDisplay: 'line',
    });
  });

  it('keeps the error type the worker reports', () => {
    expect(
      toToolResult({
        executionStatus: 'error',
        responseParts: [],
        error: { message: 'timed out', type: 'execution_timeout' },
      }).error,
    ).toEqual({ message: 'timed out', type: 'execution_timeout' });
  });

  it('gives the model the output of a call that failed', () => {
    expect(
      toToolResult({
        executionStatus: 'error',
        responseParts: [{ type: 'text', text: 'command output' }],
        error: { message: 'exited 1' },
      }),
    ).toEqual({
      llmContent: [{ text: 'command output' }],
      returnDisplay: 'command output',
      error: { message: 'exited 1' },
    });
  });

  it.each([
    ['error', { message: 'boom' }, 'boom'],
    ['error', undefined, 'The tool call failed.'],
    [
      'not_started',
      { message: 'refused' },
      'The tool call did not run: refused',
    ],
    [
      'not_started',
      undefined,
      'The tool call did not run: the Runtime worker did not run it.',
    ],
    ['cancelled', undefined, 'The tool call was cancelled.'],
  ] as const)(
    'reports a %s call as an error',
    (executionStatus, error, message) => {
      expect(
        toToolResult({ executionStatus, responseParts: [], error }),
      ).toEqual({
        llmContent: message,
        returnDisplay: message,
        error: { message },
      });
    },
  );
});

describe('currentCliWorkerLaunch', () => {
  const execArgv = process.execArgv;
  afterEach(() => {
    processBootLoaderEnv.clear();
    process.execArgv = execArgv;
  });

  it('starts this CLI as a worker with the loader vars this process booted with', () => {
    process.execArgv = ['--inspect-port', '9229', '--import', 'tsx/esm'];
    processBootLoaderEnv.set('NODE_OPTIONS', '--import tsx/esm');
    const launch = currentCliWorkerLaunch();
    expect(launch.command).toBe(process.execPath);
    // The inspector flag goes with its value; the loader stays in order.
    expect(launch.args).toEqual([
      '--import',
      'tsx/esm',
      process.env['QWEN_CLI_ENTRY'] || process.argv[1],
      'managed-runtime-worker',
    ]);
    expect(launch.env?.['NODE_OPTIONS']).toBe('--import tsx/esm');
  });

  it('drops every spelling of an inspector flag from its arguments', () => {
    process.execArgv = [
      '--inspect',
      '--inspect_brk=0',
      '--inspect-brk-node',
      '--inspect-wait=0',
      '--inspect-port=9230',
      '--debug_port',
      '9230',
      '--import',
      'tsx/esm',
    ];
    expect(currentCliWorkerLaunch().args.slice(0, 2)).toEqual([
      '--import',
      'tsx/esm',
    ]);
  });

  // An env file can set NODE_OPTIONS, and a config file its options.
  it('reads no options file again', () => {
    process.execArgv = [
      '--env-file',
      '.env',
      '--env_file_if_exists=.env.local',
      '--env-file-if-exists',
      '.env.test',
      '--experimental-config-file',
      'node.config.json',
      '--experimental-default-config-file',
      '--import',
      'tsx/esm',
    ];
    expect(currentCliWorkerLaunch().args.slice(0, 2)).toEqual([
      '--import',
      'tsx/esm',
    ]);
  });

  it.each([
    ['--inspect-brk --import tsx/esm', '--import tsx/esm'],
    ['--import tsx/esm --inspect-port 9230', '--import tsx/esm'],
    ['--inspect=0', undefined],
    // Node reads `_` for `-` in option names, and a quoted option as one.
    ['--inspect_brk --inspect-brk-node --import tsx/esm', '--import tsx/esm'],
    ['"--inspect=0" --import tsx/esm', '--import tsx/esm'],
    ['--inspect_port 9230 --import tsx/esm', '--import tsx/esm'],
    // What it keeps is copied as written, quoted spacing included.
    [
      '--inspect-brk --require "/opt/a  b/hook.js"',
      '--require "/opt/a  b/hook.js"',
    ],
    [
      '--inspect-brk --require "/opt/a\tb/\\"hook\\".js"',
      '--require "/opt/a\tb/\\"hook\\".js"',
    ],
    ['--require  "/opt/a  b/hook.js" ', '--require  "/opt/a  b/hook.js" '],
    // An escaped quote keeps what follows inside the quoted option.
    ['--inspect-brk --title "a\\" --inspect"', '--title "a\\" --inspect"'],
    // Neither a run of spaces nor `""` is an entry: the port's value is
    // still the one dropped.
    ['--inspect-port  9230 --import tsx/esm', '--import tsx/esm'],
    ['--inspect-port "" 9230 --import tsx/esm', '--import tsx/esm'],
    // Outside quotes a backslash escapes nothing.
    ['--inspect-brk --title a\\ --inspect', '--title a\\'],
    // Node folds `_` only in an option's name, so this is no option.
    ['__inspect --import tsx/esm', '__inspect --import tsx/esm'],
  ])(
    'opens no debugger in the worker from NODE_OPTIONS %j',
    (options, expected) => {
      processBootLoaderEnv.set('NODE_OPTIONS', options);
      expect(currentCliWorkerLaunch().env?.['NODE_OPTIONS']).toBe(expected);
    },
  );

  it.each([
    ['--inspect-brk --import tsx/esm', '--import tsx/esm'],
    ['--inspect-brk', undefined],
  ])(
    'opens no debugger in the worker from Node_Options %j, as Windows reads it',
    (options, expected) => {
      processBootLoaderEnv.set('Node_Options', options);
      expect(currentCliWorkerLaunch().env?.['Node_Options']).toBe(expected);
    },
  );

  it('reads every answer the worker may give', () => {
    expect(MANAGED_RUNTIME_RESPONSE_LIMIT_BYTES).toBeGreaterThan(
      MANAGED_RUNTIME_TOOL_RESULT_BODY_LIMIT_BYTES,
    );
  });
});
