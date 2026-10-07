/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { ManagedRuntimeOutcomeUnknownError } from '@qwen-code/qwen-code-core/services/execution-environment.js';
import { promptIdContext } from '@qwen-code/qwen-code-core/utils/promptIdContext.js';
import type { LocalManagedRuntimeOutcomes } from '@qwen-code/qwen-code-core/managed-runtime/managed-runtime-outcomes.js';
import { processBootLoaderEnv } from '../config/shared-env-keys.js';
import { createServer } from 'node:http';
import { MANAGED_RUNTIME_TOOL_RESULT_BODY_LIMIT_BYTES } from './managed-runtime-attestation-contract.js';
import {
  createManagedRuntimeEnvironment,
  currentCliWorkerLaunch,
  MANAGED_RUNTIME_RESPONSE_LIMIT_BYTES,
  ManagedSessionRuntimeWorker,
  toToolResult,
  type ManagedRuntimeWorkerLaunch,
} from './managed-runtime-session-worker.js';

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
