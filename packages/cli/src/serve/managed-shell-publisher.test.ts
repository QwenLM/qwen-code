/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import type { ShellExecutionResult } from '@qwen-code/qwen-code-core/services/shellExecutionService.js';
import type { ToolResultEnvelope } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import type { LocalShellCaptureRequest } from '@qwen-code/qwen-code-core/managed-runtime/managed-shell-result-session.js';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import {
  createManagedToolSet,
  ManagedToolExecutor,
} from './managed-runtime-tool-executor.js';
import {
  HOSTED_SHELL_PUBLISHER_PATH,
  MANAGED_SHELL_PUBLISHER_ROUTE,
  ManagedShellPublisherRegistry,
} from './managed-shell-publisher.js';

let directory: string | undefined;
let executor: ManagedToolExecutor | undefined;
let publisher: Server | undefined;
let worker: Server | undefined;
let pgid: number | undefined;
async function close(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
function groupAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
afterEach(async () => {
  if (pgid && groupAlive(pgid)) process.kill(-pgid, 'SIGKILL');
  await executor?.close();
  await close(publisher);
  await close(worker);
  vi.restoreAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  executor = undefined;
  publisher = undefined;
  worker = undefined;
  pgid = undefined;
});

async function registryFixture(
  finalized?: ToolResultEnvelope,
  refusal?: { operation: 'finalize' | 'accept'; status: number },
) {
  const publisherApp = express();
  publisherApp.use(express.json());
  let prepares = 0;
  let refusals = 0;
  publisherApp.post(HOSTED_SHELL_PUBLISHER_PATH, (request, response) => {
    response.set('Cache-Control', 'no-store');
    response.set('Connection', 'close');
    if (refusal && request.body.operation === refusal.operation) {
      refusals++;
      response.status(refusal.status).json({
        code: 'hosted_shell_publication_failed',
      });
      return;
    }
    if (request.body.operation === 'prepare') {
      prepares++;
      const { reference, capture } = request.body.request;
      response.json({
        tenantId: capture.tenantId,
        sessionId: capture.sessionId,
        turnId: capture.turnId,
        executionCallId: capture.executionCallId,
        callId: reference.callId,
        invocationDigest: reference.argsDigest,
        bindingGeneration: capture.bindingGeneration,
        captureId: 'capture-original',
        revision: 1,
      });
    } else if (request.body.operation === 'finalize' && finalized) {
      response.json({
        ...finalized,
        executionStatus: request.body.executionStatus,
      });
    } else response.json({ accepted: true });
  });
  publisher = createServer(publisherApp);
  await new Promise<void>((resolve) =>
    publisher!.listen(0, '127.0.0.1', resolve),
  );
  const registry = new ManagedShellPublisherRegistry();
  const workerApp = express();
  registry.register(
    workerApp,
    { token: 'runtime-token', leaseId: 'lease-a', epoch: 1 },
    (sessionId) => sessionId === 'runtime-a',
  );
  worker = createServer(workerApp);
  await new Promise<void>((resolve) => worker!.listen(0, '127.0.0.1', resolve));
  const installed = await fetch(
    `http://127.0.0.1:${(worker.address() as AddressInfo).port}${MANAGED_SHELL_PUBLISHER_ROUTE.path}`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer runtime-token',
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json',
        'X-Qwen-Managed-Lease-Id': 'lease-a',
        'X-Qwen-Managed-Lease-Epoch': '1',
      },
      body: JSON.stringify({
        protocolVersion: 3,
        toolResult: 'managed-tool-result/1',
        sessionId: 'runtime-a',
        publisher: {
          url: `http://127.0.0.1:${(publisher.address() as AddressInfo).port}${HOSTED_SHELL_PUBLISHER_PATH}`,
          token: 'a'.repeat(43),
        },
      }),
    },
  );
  expect(installed.status).toBe(200);
  await installed.body?.cancel();
  return { registry, prepares: () => prepares, refusals: () => refusals };
}
it.skipIf(process.platform === 'win32')(
  'settles a physically stopped foreground Shell when its original publisher is lost',
  async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'qwen-publisher-lost-'));
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(
      path.join(directory, 'global'),
    );
    const { registry, prepares } = await registryFixture();
    const prepare = vi.spyOn(registry, 'prepare');
    const program = [
      'const fs=require("node:fs"),cp=require("node:child_process");',
      'const child=cp.spawn(process.execPath,["-e","setTimeout(()=>{},60000)"],{stdio:"ignore"});',
      'fs.appendFileSync("once.txt","once\\n");',
      'fs.writeFileSync("pids.json",JSON.stringify({parent:process.pid,child:child.pid}));',
      'const timer=setTimeout(()=>process.exit(0),60000);',
      'const stop=()=>{clearTimeout(timer);child.kill("SIGTERM")};',
      'process.on("SIGTERM",stop);process.on("SIGINT",stop);',
      'child.on("exit",()=>process.exit(0));',
    ].join('');
    const input = {
      command: `"${process.execPath}" -e '${program}'`,
      timeout: 60_000,
      is_background: false,
    };
    const reference = {
      sessionId: 'runtime-a',
      promptId: 'prompt-a',
      callId: 'call-original',
      argsDigest: managedToolDigest(input),
    };
    const tools = createManagedToolSet(directory, 'runtime-a');
    executor = new ManagedToolExecutor(async () => tools, registry);
    const pending = executor.executeV3({
      reference,
      toolName: 'run_shell_command',
      input,
      capture: {
        tenantId: 'tenant-a',
        sessionId: 'session-a',
        turnId: 'turn-a',
        executionCallId: 'execution-original',
        bindingGeneration: '1',
        capturePolicy: 'complete_required',
      },
    });
    let earlyView: unknown;
    void pending.then((view) => {
      earlyView = view;
    });
    let pids: { parent: number; child: number } | undefined;
    await vi.waitFor(
      async () => {
        if (earlyView)
          throw new Error(
            'Execution settled before PID fixture: ' +
              JSON.stringify(earlyView),
          );
        pids = JSON.parse(
          await readFile(path.join(directory!, 'pids.json'), 'utf8'),
        );
        expect(pids?.parent).toBeGreaterThan(1);
      },
      { timeout: 5000 },
    );
    pgid = Number(
      execFileSync('ps', ['-p', String(pids!.parent), '-o', 'pgid='], {
        encoding: 'utf8',
      }).trim(),
    );
    expect(groupAlive(pgid)).toBe(true);
    expect(prepares()).toBe(1);
    await close(publisher);
    executor.cancelV3(reference);
    const view = await pending;
    await vi.waitFor(() => expect(groupAlive(pgid!)).toBe(false));
    expect(await readFile(path.join(directory, 'once.txt'), 'utf8')).toBe(
      'once\n',
    );
    console.info('publisher-loss-physical-observation', {
      pids,
      pgid,
      processGroupGone: !groupAlive(pgid),
      prepares: prepares(),
      view,
    });
    expect(view.state).toBe('settled');
    expect(view.result).toMatchObject({
      executionStatus: 'cancelled',
      capture: {
        captureStatus: 'unavailable',
        captureReason: 'producer_lost',
        manifest: null,
        deliveryStatus: 'blocked',
      },
    });
    expect(executor.statusV3(reference)).toEqual(view);
    expect(prepares()).toBe(1);
    expect(prepare).toHaveBeenCalledTimes(1);
  },
);

const captureRequest: LocalShellCaptureRequest = {
  reference: {
    sessionId: 'runtime-a',
    promptId: 'prompt-a',
    callId: 'call-original',
    argsDigest: 'a'.repeat(64),
  },
  capture: {
    tenantId: 'tenant-a',
    sessionId: 'session-a',
    turnId: 'turn-a',
    executionCallId: 'execution-original',
    bindingGeneration: '1',
    capturePolicy: 'complete_required',
  },
};
const recordedPid = 424242;
function physicalResult(): ShellExecutionResult {
  return {
    rawOutput: Buffer.alloc(0),
    output: '',
    exitCode: null,
    signal: 15,
    error: null,
    aborted: true,
    promoted: false,
    pid: recordedPid,
    executionMethod: 'child_process',
  };
}
function groupProbe(outcome: 'gone' | 'alive' | 'denied') {
  const original = process.kill.bind(process);
  return vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid !== -recordedPid || signal !== 0) return original(pid, signal);
    if (outcome === 'alive') return true;
    throw Object.assign(new Error('controlled group probe'), {
      code: outcome === 'gone' ? 'ESRCH' : 'EPERM',
    });
  });
}

it
  .skipIf(process.platform === 'win32')
  .each([
    'missing-physical',
    'not-aborted',
    'promoted',
    'wrong-pid',
    'undefined-none',
    'undefined-node-pty',
    'undefined-lydell-pty',
    'started-zero',
    'started-one',
    'started-nan',
    'group-alive',
    'group-denied',
    'ordinary-success',
  ])('does not certify publisher loss with %s', async (missing) => {
  const { registry } = await registryFixture();
  const { sink } = await registry.prepare(captureRequest);
  let started = recordedPid;
  if (missing === 'started-zero') started = 0;
  if (missing === 'started-one') started = 1;
  if (missing === 'started-nan') started = Number.NaN;
  sink.setStarted(started);
  const physical = physicalResult();
  if (missing === 'not-aborted') physical.aborted = false;
  if (missing === 'promoted') physical.promoted = true;
  if (missing === 'wrong-pid') physical.pid = recordedPid + 1;
  if (missing.startsWith('undefined-')) {
    physical.pid = undefined;
    physical.executionMethod =
      missing === 'undefined-none'
        ? 'none'
        : missing === 'undefined-node-pty'
          ? 'node-pty'
          : 'lydell-node-pty';
  }
  if (missing !== 'missing-physical') sink.setProcessResult(physical);
  await close(publisher);
  groupProbe(
    missing === 'group-alive'
      ? 'alive'
      : missing === 'group-denied'
        ? 'denied'
        : 'gone',
  );
  await expect(
    sink.finalize(missing === 'ordinary-success' ? 'success' : 'cancelled', []),
  ).rejects.toThrow();
});

it.skipIf(process.platform === 'win32')(
  'accepts only the original private lost-capture result, never its clone or matching shape',
  async () => {
    const { registry, prepares } = await registryFixture();
    const prepare = vi.spyOn(registry, 'prepare');
    const { sink, identity } = await registry.prepare(captureRequest);
    sink.setStarted(recordedPid);
    sink.setProcessResult({ ...physicalResult(), pid: undefined });
    const retry = await registry.prepare(captureRequest);
    expect(retry.sink).toBe(sink);
    expect(retry.identity).toEqual(identity);
    await close(publisher);
    groupProbe('gone');
    const result = await sink.finalize('cancelled', []);
    expect(result).toMatchObject({
      executionStatus: 'cancelled',
      capture: {
        captureStatus: 'unavailable',
        captureReason: 'producer_lost',
        manifest: null,
        deliveryStatus: 'blocked',
      },
    });
    await expect(registry.accept(identity, result)).resolves.toEqual({
      executionCallId: 'execution-original',
      manifest: null,
      deliveryStatus: 'blocked',
      historyRevision: null,
    });
    await expect(
      registry.accept(identity, structuredClone(result)),
    ).rejects.toThrow();
    await expect(
      registry.accept(identity, { ...result, responseParts: [] }),
    ).rejects.toThrow();
    expect(prepares()).toBe(2);
    expect(prepare).toHaveBeenCalledTimes(2);
  },
);

it.skipIf(process.platform === 'win32').each([
  { message: 'x'.repeat(4096), expectedMessage: 'x'.repeat(1024) },
  { message: 'x'.repeat(1023) + '😀', expectedMessage: 'x'.repeat(1023) },
])(
  'bounds cancellation error details when its original publisher is lost (%#)',
  async ({ message, expectedMessage }) => {
    const { registry } = await registryFixture();
    const { sink, identity } = await registry.prepare(captureRequest);
    sink.setStarted(recordedPid);
    sink.setProcessResult(physicalResult());
    await close(publisher);
    groupProbe('gone');
    const result = await sink.finalize('cancelled', [], {
      message,
      type: 'y'.repeat(512),
    });
    expect(result.error?.message).toBeTruthy();
    expect
      .soft(Buffer.byteLength(result.error!.message))
      .toBeLessThanOrEqual(1024);
    expect.soft(result.error?.type?.length).toBeLessThanOrEqual(128);
    expect(result.error).toEqual({
      message: expectedMessage,
      type: 'y'.repeat(128),
    });
    await expect(registry.accept(identity, result)).resolves.toMatchObject({
      deliveryStatus: 'blocked',
      historyRevision: null,
    });
  },
);

const finalizedFixture: ToolResultEnvelope = {
  executionStatus: 'cancelled',
  responseParts: [{ text: 'fixture preview' }],
  capture: {
    captureStatus: 'complete',
    captureReason: null,
    previewTruncated: false,
    deliveryStatus: 'pending',
    manifest: {
      resourceId: 'fixture-manifest',
      kind: 'managed-tool-result-manifest',
      schemaVersion: 1,
      byteLength: 2,
      digest: 'b'.repeat(64),
    },
  },
};

it.skipIf(process.platform === 'win32').each([409, 503, 401])(
  'rejects finalize when a live publisher refuses with HTTP %i',
  async (status) => {
    const { registry, refusals } = await registryFixture(undefined, {
      operation: 'finalize',
      status,
    });
    const { sink } = await registry.prepare(captureRequest);
    sink.setStarted(recordedPid);
    sink.setProcessResult(physicalResult());
    groupProbe('gone');
    const outcome = await sink.finalize('cancelled', []).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    expect(publisher?.listening).toBe(true);
    expect(refusals()).toBe(1);
    expect(outcome).toEqual({
      error: expect.objectContaining({
        message: 'Shell publisher refused the request.',
      }),
    });
  },
);

it.skipIf(process.platform === 'win32').each([409, 503, 401])(
  'rejects accept when a live publisher refuses with HTTP %i',
  async (status) => {
    const { registry, refusals } = await registryFixture(finalizedFixture, {
      operation: 'accept',
      status,
    });
    const { sink, identity } = await registry.prepare(captureRequest);
    sink.setStarted(recordedPid);
    sink.setProcessResult(physicalResult());
    groupProbe('gone');
    const finalized = await sink.finalize('cancelled', []);
    const outcome = await registry.accept(identity, finalized).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    expect(publisher?.listening).toBe(true);
    expect(refusals()).toBe(1);
    expect(outcome).toEqual({
      error: expect.objectContaining({
        message: 'Shell publisher refused the request.',
      }),
    });
  },
);

it.skipIf(process.platform === 'win32')(
  'keeps a finalized manifest when the publisher disappears before its cancellation receipt',
  async () => {
    const { registry, prepares } = await registryFixture(finalizedFixture);
    const { sink, identity } = await registry.prepare(captureRequest);
    sink.setStarted(recordedPid);
    sink.setProcessResult(physicalResult());
    groupProbe('gone');
    const finalized = await sink.finalize('cancelled', []);
    expect(finalized.capture).toEqual(finalizedFixture.capture);
    await close(publisher);
    await expect(
      registry.accept(identity, structuredClone(finalized)),
    ).rejects.toThrow();
    await expect(registry.accept(identity, { ...finalized })).rejects.toThrow();
    await expect(registry.accept(identity, finalized)).resolves.toEqual({
      executionCallId: 'execution-original',
      manifest: finalizedFixture.capture!.manifest,
      deliveryStatus: 'blocked',
      historyRevision: null,
    });
    expect(finalized.capture).toEqual(finalizedFixture.capture);
    expect(prepares()).toBe(1);
  },
);
it
  .skipIf(process.platform === 'win32')
  .each([
    'ordinary-success',
    'missing-physical',
    'not-aborted',
    'promoted',
    'wrong-pid',
    'group-alive',
    'group-denied',
  ])('rejects a finalized lost-publisher receipt with %s', async (missing) => {
  const { registry } = await registryFixture(finalizedFixture);
  const { sink, identity } = await registry.prepare(captureRequest);
  sink.setStarted(recordedPid);
  const physical = physicalResult();
  if (missing === 'not-aborted') physical.aborted = false;
  if (missing === 'promoted') physical.promoted = true;
  if (missing === 'wrong-pid') physical.pid = recordedPid + 1;
  if (missing !== 'missing-physical') sink.setProcessResult(physical);
  groupProbe(
    missing === 'group-alive'
      ? 'alive'
      : missing === 'group-denied'
        ? 'denied'
        : 'gone',
  );
  const finalized = await sink.finalize(
    missing === 'ordinary-success' ? 'success' : 'cancelled',
    [],
  );
  expect(finalized.capture?.manifest).toEqual(
    finalizedFixture.capture!.manifest,
  );
  await close(publisher);
  await expect(registry.accept(identity, finalized)).rejects.toThrow();
});
