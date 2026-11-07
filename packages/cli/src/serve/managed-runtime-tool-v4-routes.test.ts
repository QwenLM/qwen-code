/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import { resetManagedRuntimeDispatchGatesForTest } from '@qwen-code/qwen-code-core/managed-runtime/managed-runtime-dispatch-gate.js';
import type { ManagedToolMeasurements } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-measurements.js';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { LocalToolResultSegmentStore } from '@qwen-code/qwen-code-core/managed-runtime/local-managed-tool-result-store.js';
import { LocalShellResultCapture } from '@qwen-code/qwen-code-core/managed-runtime/local-shell-result-capture.js';
import type { ToolResultExpectedIdentity } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result-store.js';
import {
  parseToolResultManifestBytes,
  type ToolResultEnvelope,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import type { SessionWriterLease } from '@qwen-code/qwen-code-core/services/session-writer-lease.js';
import type {
  AnyDeclarativeTool,
  FileDiff,
} from '@qwen-code/qwen-code-core/tools/tools.js';
import {
  createManagedToolSet,
  ManagedToolExecutor,
  type ManagedToolReference,
  type ManagedToolResultPayload,
  type ManagedToolSet,
} from './managed-runtime-tool-executor.js';
import { registerManagedRuntimeToolRoutes } from './managed-runtime-tool-routes.js';
import { registerManagedRuntimeToolV3Routes } from './managed-runtime-tool-v3-routes.js';
import { registerManagedRuntimeToolV4Routes } from './managed-runtime-tool-v4-routes.js';
import {
  startManagedRuntimeAttestationWorker,
  type ManagedRuntimeAttestationWorkerHandle,
} from './managed-runtime-attestation-worker.js';
import type { ManagedContextBoot } from './managed-context-envelope.js';
import { computeManagedContextDigest } from './managed-workspace-binding.js';
import {
  MEASURED_WORKSPACE_CAPABILITY_DIGEST,
  MEASURED_WORKSPACE_EXECUTION_PROFILE,
  WORKSPACE_CAPABILITY_DIGEST,
  WORKSPACE_CONTEXT_CONFIG_REF,
} from './managed-workspace-activation.js';

const headers = {
  authorization: 'Bearer test-measured-token',
  'cache-control': 'no-store',
  'content-type': 'application/json',
  'x-qwen-managed-lease-id': 'measured-lease',
  'x-qwen-managed-lease-epoch': '2',
};
const identity = {
  token: 'test-measured-token',
  leaseId: 'measured-lease',
  epoch: 2,
  runtimeIncarnation: 'measured-incarnation',
  capabilityDigest: MEASURED_WORKSPACE_CAPABILITY_DIGEST,
};

interface MeasuredView {
  protocolVersion: 4;
  executionProtocol: 2 | 3;
  state: string;
  lastSequence?: number;
  result?: ManagedToolResultPayload;
  measurements?: ManagedToolMeasurements | null;
  resultDigest?: string;
}

let server: Server | undefined;
let executor: ManagedToolExecutor | undefined;
let worker: ManagedRuntimeAttestationWorkerHandle | undefined;
let captureStore: LocalToolResultSegmentStore | undefined;
let captureLease: SessionWriterLease | undefined;
let workspace: string;
let origin: string;

beforeEach(async () => {
  resetManagedRuntimeDispatchGatesForTest();
  workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), 'qwen-managed-diagnostics-v4-'),
  );
  await fs.writeFile(path.join(workspace, 'fixture.txt'), 'alpha\nbeta\n');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await worker?.close();
  await executor?.close();
  await captureStore?.close();
  await captureLease?.release();
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  await fs.rm(workspace, { recursive: true, force: true });
  executor = undefined;
  server = undefined;
  worker = undefined;
  captureStore = undefined;
  captureLease = undefined;
});

async function start(
  capabilityDigest = MEASURED_WORKSPACE_CAPABILITY_DIGEST,
  suppliedExecutor?: ManagedToolExecutor,
) {
  const app = express();
  executor =
    suppliedExecutor ??
    ManagedToolExecutor.forWorkspace(workspace, 'worker-tools');
  registerManagedRuntimeToolRoutes(app, identity, executor);
  registerManagedRuntimeToolV3Routes(app, identity, executor);
  registerManagedRuntimeToolV4Routes(
    app,
    { ...identity, capabilityDigest },
    executor,
  );
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function reference(
  callId: string,
  input: Record<string, unknown>,
): ManagedToolReference {
  return {
    sessionId: 'measured-session',
    promptId: 'measured-turn',
    callId,
    argsDigest: managedToolDigest(input),
  };
}

function body(reference: ManagedToolReference) {
  return { protocolVersion: 4, executionProtocol: 2, reference };
}

async function post(
  route: string,
  value: Record<string, unknown>,
  suppliedHeaders = headers,
) {
  return fetch(origin + route, {
    method: 'POST',
    headers: suppliedHeaders,
    body: JSON.stringify(value),
  });
}

async function execute(
  callId: string,
  toolName: string,
  input: Record<string, unknown>,
) {
  const ref = reference(callId, input);
  const reply = await post('/internal/managed-runtime/v4/execute', {
    ...body(ref),
    toolName,
    input,
  });
  expect(reply.status).toBe(200);
  expect(reply.headers.get('cache-control')).toBe('no-store');
  expect(reply.headers.get('x-qwen-managed-runtime-incarnation')).toBe(
    identity.runtimeIncarnation,
  );
  return { ref, value: (await reply.json()) as MeasuredView };
}

describe('Tool v4 measured HTTP routes', () => {
  it.each([false, true])(
    'freezes a real v3 Shell capture while execute waits and retains the acknowledged identity (v4 ACK before execute returns: %s)',
    async (ackBeforeReturn) => {
      const sessionKey = {
        tenantId: 'capture-tenant',
        workspaceId: 'capture-workspace',
        sessionId: 'capture-session',
      };
      const runtimeBaseDir = path.join(workspace, 'capture-runtime');
      const transcriptPath = path.join(
        runtimeBaseDir,
        'chats',
        `${sessionKey.sessionId}.jsonl`,
      );
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      captureLease = await LocalManagedSessionAuthority.acquireWriter({
        runtimeBaseDir,
        sessionId: sessionKey.sessionId,
        transcriptPath,
      });
      captureStore = await LocalToolResultSegmentStore.openWritable({
        sessionKey,
        lease: captureLease,
      });
      const resources = LocalManagedSessionResourceStore.create({
        runtimeBaseDir,
        sessionKey,
      });
      const input = {
        command: `"${process.execPath}" -e "require('node:fs').appendFileSync('shell-effect.txt','x'); process.stdout.write('capture-stdout'); process.stderr.write('capture-stderr')"`,
      };
      const ref = reference('capture-call', input);
      const capture = {
        tenantId: sessionKey.tenantId,
        sessionId: sessionKey.sessionId,
        turnId: 'capture-turn',
        executionCallId: 'capture-execution',
        bindingGeneration: '1',
        capturePolicy: 'complete_required' as const,
      };
      const expectedIdentity: ToolResultExpectedIdentity = {
        tenantId: capture.tenantId,
        sessionId: capture.sessionId,
        turnId: capture.turnId,
        executionCallId: capture.executionCallId,
        bindingGeneration: capture.bindingGeneration,
        callId: ref.callId,
        invocationDigest: ref.argsDigest,
        captureId: 'capture-v4',
        revision: 1,
      };
      let preparations = 0;
      const toolSet = createManagedToolSet(workspace, ref.sessionId);
      const measured = new ManagedToolExecutor(async () => toolSet, {
        prepare: async (request) => {
          preparations++;
          expect(request.reference).toEqual(ref);
          expect(request.capture).toEqual(capture);
          return {
            identity: expectedIdentity,
            sink: new LocalShellResultCapture(
              captureStore!,
              resources,
              expectedIdentity,
            ),
          };
        },
      });
      await start(MEASURED_WORKSPACE_CAPABILITY_DIGEST, measured);
      const request = {
        protocolVersion: 4,
        executionProtocol: 3,
        reference: ref,
      };
      let executionReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        executionReady = resolve;
      });
      let releaseExecution!: () => void;
      const released = new Promise<void>((resolve) => {
        releaseExecution = resolve;
      });
      const executeV3 = measured.executeV3.bind(measured);
      const delayed = vi
        .spyOn(measured, 'executeV3')
        .mockImplementation(async (invocation) => {
          await executeV3(invocation);
          executionReady();
          await released;
          return measured.statusV3(invocation.reference);
        });
      const first = post('/internal/managed-runtime/v4/execute', {
        ...request,
        toolName: 'run_shell_command',
        input,
        capture,
      });
      try {
        await ready;
        const firstStatus = await post(
          '/internal/managed-runtime/v4/status',
          request,
        );
        expect(firstStatus.status).toBe(200);
        const value = (await firstStatus.json()) as MeasuredView;
        const result = value.result as unknown as ToolResultEnvelope;
        expect(value.state).toBe('settled');
        expect(value.lastSequence).toBe(executor!.statusV3(ref).lastSequence);
        expect(value.lastSequence).toBeGreaterThan(0);
        expect(result).toMatchObject({
          executionStatus: 'success',
          capture: { captureStatus: 'complete', deliveryStatus: 'pending' },
        });
        expect(value.measurements?.executionOutcome).toBe('success');
        expect(value.resultDigest).toBe(
          managedToolDigest(
            { executionProtocol: 3, result, measurements: value.measurements },
            2 * 1024 * 1024,
          ),
        );
        const manifestRef = result.capture!.manifest!;
        const manifest = parseToolResultManifestBytes(
          await resources.read(manifestRef),
        );
        expect(
          manifest.contents.find((stream) => stream.streamId === 'stdout')
            ?.byteLength,
        ).toBe(14);
        const captured = await captureStore.readRange({
          manifestRef,
          expectedIdentity,
          streamId: 'stdout',
          offset: 0,
          length: 14,
        });
        expect(captured.status).toBe('ok');
        if (captured.status !== 'ok')
          throw new Error('Expected retained Shell stdout');
        expect(captured.result.toString('utf8')).toBe('capture-stdout');

        const receipt = {
          executionCallId: capture.executionCallId,
          manifest: manifestRef,
          deliveryStatus: 'committed',
          historyRevision: 1,
        };
        const delivery = await post(
          '/internal/managed-runtime/v3/acknowledge',
          {
            protocolVersion: 3,
            toolResult: 'managed-tool-result/1',
            reference: ref,
            receipt,
          },
        );
        expect(delivery.status).toBe(200);
        expect(executor!.statusV3(ref).result?.capture?.deliveryStatus).toBe(
          'committed',
        );
        const acknowledged = {
          protocolVersion: 4,
          executionProtocol: 3,
          state: 'acknowledged',
        };
        const ack = { ...request, resultDigest: value.resultDigest, receipt };
        if (ackBeforeReturn) {
          const reply = await post(
            '/internal/managed-runtime/v4/acknowledge',
            ack,
          );
          expect(reply.status).toBe(200);
          expect(await reply.json()).toEqual(acknowledged);
        }
        releaseExecution();
        const completed = await first;
        expect(completed.status).toBe(200);
        expect(await completed.json()).toEqual(
          ackBeforeReturn ? acknowledged : value,
        );
        expect(await delayed.mock.results[0]!.value).toMatchObject({
          result: { capture: { deliveryStatus: 'committed' } },
        });
        delayed.mockRestore();
        for (const route of ['status', 'cancel']) {
          const frozen = await post(
            `/internal/managed-runtime/v4/${route}`,
            request,
          );
          expect(await frozen.json()).toEqual(
            ackBeforeReturn ? acknowledged : value,
          );
        }
        const repeated = await post('/internal/managed-runtime/v4/execute', {
          ...request,
          toolName: 'run_shell_command',
          input,
          capture,
        });
        expect(await repeated.json()).toEqual(
          ackBeforeReturn ? acknowledged : value,
        );
        expect(preparations).toBe(1);
        expect(
          await fs.readFile(path.join(workspace, 'shell-effect.txt'), 'utf8'),
        ).toBe('x');

        for (let attempt = 0; attempt < 2; attempt++) {
          const reply = await post(
            '/internal/managed-runtime/v4/acknowledge',
            ack,
          );
          expect(reply.status).toBe(200);
          expect(await reply.json()).toEqual(acknowledged);
        }
        const status = await post(
          '/internal/managed-runtime/v4/status',
          request,
        );
        expect(await status.json()).toEqual(acknowledged);
        const afterAck = await post('/internal/managed-runtime/v4/execute', {
          ...request,
          toolName: 'run_shell_command',
          input,
          capture,
        });
        expect(afterAck.status).toBe(200);
        expect(await afterAck.json()).toEqual(acknowledged);
        for (const changed of [
          {
            ...request,
            toolName: 'run_shell_command',
            input: { ...input, command: 'printf different' },
            capture,
          },
          { ...request, toolName: 'monitor', input, capture },
          {
            ...request,
            toolName: 'run_shell_command',
            input,
            capture: { ...capture, turnId: 'other-capture-turn' },
          },
          { ...body(ref), toolName: 'run_shell_command', input },
        ]) {
          const conflict = await post(
            '/internal/managed-runtime/v4/execute',
            changed,
          );
          expect(conflict.status).toBe(409);
          expect(await conflict.json()).toMatchObject({
            code: 'managed_tool_result_conflict',
          });
        }
        const originalAfterConflicts = await post(
          '/internal/managed-runtime/v4/execute',
          {
            ...request,
            toolName: 'run_shell_command',
            input,
            capture,
          },
        );
        expect(originalAfterConflicts.status).toBe(200);
        expect(await originalAfterConflicts.json()).toEqual(acknowledged);
        const conflicting = await post(
          '/internal/managed-runtime/v4/acknowledge',
          {
            ...ack,
            receipt: { ...receipt, historyRevision: 2 },
          },
        );
        expect(conflicting.status).toBe(409);
        expect(
          await fs.readFile(path.join(workspace, 'shell-effect.txt'), 'utf8'),
        ).toBe('x');
      } finally {
        releaseExecution();
      }
    },
  );

  it('serves v4 from the measured context Worker using its installed and activated Session', async () => {
    const boot: ManagedContextBoot = {
      type: 'boot',
      version: 2,
      managedContext: 'managed-context/1',
      ...identity,
      runtimeInstanceId: 'measured-runtime',
      provisionRequestId: 'measured-provision',
      isolationClass: 'workspace',
      tenantId: 'measured-tenant',
      workspaceId: 'measured-workspace',
      workspaceGeneration: '1',
      storageId: 'measured-storage',
      mountRoot: workspace,
    };
    worker = await startManagedRuntimeAttestationWorker(boot);
    origin = worker.ready.url;
    const binding = {
      tenantId: boot.tenantId,
      workspaceId: boot.workspaceId,
      workspaceGeneration: boot.workspaceGeneration,
      storageId: boot.storageId,
      cwdRelative: '.',
      contextConfigRef: WORKSPACE_CONTEXT_CONFIG_REF,
      contextRevision: '1',
    };
    const contextDigest = computeManagedContextDigest(binding);
    const installed = await post('/internal/managed-runtime/v3/context', {
      protocolVersion: 3,
      managedContext: 'managed-context/1',
      operationId: 'install-measured',
      sessionId: 'measured-session',
      binding,
      contextDigest,
    });
    expect(installed.status).toBe(200);
    const activated = await post('/internal/managed-runtime/v3/activation', {
      protocolVersion: 1,
      operation: 'activate',
      sessionId: 'measured-session',
      contextDigest,
      contextConfigRef: WORKSPACE_CONTEXT_CONFIG_REF,
      profile: MEASURED_WORKSPACE_EXECUTION_PROFILE,
    });
    expect(activated.status).toBe(200);
    const result = await execute('worker-read', 'read_file', {
      file_path: path.join(workspace, 'fixture.txt'),
    });
    expect(result.value.result?.executionStatus).toBe('success');
    expect(result.value.measurements?.file?.operation).toBe('read');
  });

  it('returns bounded native read measurements and freezes the full result digest across retries/status/cancel', async () => {
    await start();
    const input = { file_path: path.join(workspace, 'fixture.txt') };
    const { ref, value } = await execute('read-1', 'read_file', input);
    expect(value.state).toBe('settled');
    expect(value.lastSequence).toBe(executor!.status(ref)!.lastSequence);
    expect(value.lastSequence).toBeGreaterThan(0);
    expect(value.result?.executionStatus).toBe('success');
    expect(JSON.stringify(value.result?.responseParts)).toContain('alpha');
    expect(value.measurements).toMatchObject({
      protocol: 'managed-tool-measurements/1',
      executionOutcome: 'success',
      file: {
        operation: 'read',
        status: 'measured',
        modelLinesAdded: null,
        appliedLinesAdded: null,
      },
    });
    expect(Number.isSafeInteger(value.measurements?.executionDurationMs)).toBe(
      true,
    );
    expect(value.measurements!.executionDurationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(value.measurements)).not.toContain(workspace);
    expect(JSON.stringify(value.measurements)).not.toContain('alpha');
    expect(value.resultDigest).toBe(
      managedToolDigest(
        {
          executionProtocol: 2,
          result: value.result,
          measurements: value.measurements,
        },
        2 * 1024 * 1024,
      ),
    );
    await fs.writeFile(
      path.join(workspace, 'fixture.txt'),
      'replacement after first read',
    );
    for (const route of ['status', 'cancel']) {
      const response = await post(
        `/internal/managed-runtime/v4/${route}`,
        body(ref),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(value);
    }
    const repeated = await execute('read-1', 'read_file', input);
    expect(repeated.value).toEqual(value);
  });

  it('preserves the file write effect, model/applied line measurements and the original result on execute replay', async () => {
    await start();
    const file = path.join(workspace, 'created.txt');
    const input = { file_path: file, content: 'one\ntwo\n' };
    const { value } = await execute('write-1', 'write_file', input);
    expect(value.result?.executionStatus).toBe('success');
    expect(await fs.readFile(file, 'utf8')).toBe('one\ntwo\n');
    expect(value.measurements?.file).toMatchObject({
      operation: 'write',
      status: 'measured',
      modelLinesAdded: 2,
      modelLinesRemoved: 0,
      appliedLinesAdded: 2,
      appliedLinesRemoved: 0,
    });
    await fs.writeFile(file, 'external edit after result');
    expect((await execute('write-1', 'write_file', input)).value).toEqual(
      value,
    );
    expect(await fs.readFile(file, 'utf8')).toBe('external edit after result');
  });

  it('preserves a proven native write and applied diff when cancellation arrives after the physical effect', async () => {
    const tools = createManagedToolSet(workspace, 'measured-session');
    const write = tools.tools.get('write_file')!;
    const build = write.build.bind(write);
    let executionReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      executionReady = resolve;
    });
    let releaseExecution!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    let actualExecutions = 0;
    vi.spyOn(write, 'build').mockImplementation((params) => {
      const invocation = build(params);
      const execute = invocation.execute.bind(invocation);
      vi.spyOn(invocation, 'execute').mockImplementation(async (...args) => {
        actualExecutions++;
        const result = await execute(...args);
        executionReady();
        await released;
        return result;
      });
      return invocation;
    });
    await start(
      MEASURED_WORKSPACE_CAPABILITY_DIGEST,
      new ManagedToolExecutor(async () => tools),
    );
    const file = path.join(workspace, 'cancel-after-write.txt');
    const input = { file_path: file, content: 'one\ntwo\n' };
    const ref = reference('cancel-after-write', input);
    const first = post('/internal/managed-runtime/v4/execute', {
      ...body(ref),
      toolName: 'write_file',
      input,
    });
    try {
      await ready;
      expect(await fs.readFile(file, 'utf8')).toBe('one\ntwo\n');
      const cancellation = await post(
        '/internal/managed-runtime/v4/cancel',
        body(ref),
      );
      expect(cancellation.status).toBe(200);
      expect(await cancellation.json()).toMatchObject({
        state: 'cancel_requested',
      });
      releaseExecution();
      const completed = await first;
      expect(completed.status).toBe(200);
      const value = (await completed.json()) as MeasuredView;
      expect(value.result?.executionStatus).toBe('cancelled');
      expect(value.measurements).toMatchObject({
        executionOutcome: 'success',
        file: {
          operation: 'write',
          status: 'measured',
          modelLinesAdded: 2,
          modelLinesRemoved: 0,
          appliedLinesAdded: 2,
          appliedLinesRemoved: 0,
        },
      });
      expect(actualExecutions).toBe(1);
      await fs.writeFile(file, 'external edit after cancelled delivery');
      expect(
        (await execute('cancel-after-write', 'write_file', input)).value,
      ).toEqual(value);
      expect(actualExecutions).toBe(1);
      expect(await fs.readFile(file, 'utf8')).toBe(
        'external edit after cancelled delivery',
      );
    } finally {
      releaseExecution();
    }
  });

  it('preserves a proven Shell completion when cancellation arrives before result delivery', async () => {
    const tools = createManagedToolSet(workspace, 'measured-session');
    const write = tools.tools.get('run_shell_command')!;
    const build = write.build.bind(write);
    let executionReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      executionReady = resolve;
    });
    let releaseExecution!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    let actualExecutions = 0;
    vi.spyOn(write, 'build').mockImplementation((params) => {
      const invocation = build(params);
      const execute = invocation.execute.bind(invocation);
      vi.spyOn(invocation, 'execute').mockImplementation(async (...args) => {
        actualExecutions++;
        const result = await execute(...args);
        executionReady();
        await released;
        return result;
      });
      return invocation;
    });
    await start(
      MEASURED_WORKSPACE_CAPABILITY_DIGEST,
      new ManagedToolExecutor(async () => tools),
    );
    const file = path.join(workspace, 'cancel-after-shell.txt');
    const input = {
      command: `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync('cancel-after-shell.txt', 'one\\ntwo\\n')"`,
    };
    const ref = reference('cancel-after-shell', input);
    const first = post('/internal/managed-runtime/v4/execute', {
      ...body(ref),
      toolName: 'run_shell_command',
      input,
    });
    try {
      await ready;
      expect(await fs.readFile(file, 'utf8')).toBe('one\ntwo\n');
      const cancellation = await post(
        '/internal/managed-runtime/v4/cancel',
        body(ref),
      );
      expect(cancellation.status).toBe(200);
      expect(await cancellation.json()).toMatchObject({
        state: 'cancel_requested',
      });
      releaseExecution();
      const completed = await first;
      expect(completed.status).toBe(200);
      const value = (await completed.json()) as MeasuredView;
      expect(value.result?.executionStatus).toBe('cancelled');
      expect(value.measurements).toMatchObject({
        executionOutcome: 'success',
        file: null,
      });
      expect(actualExecutions).toBe(1);
      await fs.writeFile(file, 'external edit after cancelled delivery');
      expect(
        (await execute('cancel-after-shell', 'run_shell_command', input)).value,
      ).toEqual(value);
      expect(actualExecutions).toBe(1);
      expect(await fs.readFile(file, 'utf8')).toBe(
        'external edit after cancelled delivery',
      );
    } finally {
      releaseExecution();
    }
  });

  it('records not_started measurement for a native build failure while retaining the legacy error result', async () => {
    const tools = createManagedToolSet(workspace, 'measured-session');
    const build = vi
      .spyOn(tools.tools.get('write_file')!, 'build')
      .mockImplementation(() => {
        throw new Error('test validation failed before invocation');
      });
    await start(
      MEASURED_WORKSPACE_CAPABILITY_DIGEST,
      new ManagedToolExecutor(async () => tools),
    );
    const file = path.join(workspace, 'must-not-be-written.txt');
    const { value } = await execute('build-failed', 'write_file', {
      file_path: file,
      content: 'unwritten',
    });
    expect(value.result?.executionStatus).toBe('error');
    expect(value.measurements).toEqual({
      protocol: 'managed-tool-measurements/1',
      executionOutcome: 'not_started',
      executionDurationMs: null,
      file: null,
    });
    expect(build).toHaveBeenCalledTimes(1);
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a native write and diff when output conversion fails after execution', async () => {
    const tools = createManagedToolSet(workspace, 'measured-session');
    const write = tools.tools.get('write_file')!;
    const build = write.build.bind(write);
    vi.spyOn(write, 'build').mockImplementation((params) => {
      const invocation = build(params);
      const invoke = invocation.execute.bind(invocation);
      vi.spyOn(invocation, 'execute').mockImplementation(async (...args) => {
        const result = await invoke(...args);
        return {
          ...result,
          get llmContent(): never {
            throw new Error('output conversion failed');
          },
        };
      });
      return invocation;
    });
    await start(
      MEASURED_WORKSPACE_CAPABILITY_DIGEST,
      new ManagedToolExecutor(async () => tools),
    );
    const file = path.join(workspace, 'write-before-output-error.txt');
    const { value } = await execute('output-error', 'write_file', {
      file_path: file,
      content: 'one\ntwo\n',
    });
    expect(await fs.readFile(file, 'utf8')).toBe('one\ntwo\n');
    expect(value.result?.executionStatus).toBe('error');
    expect(value.measurements).toMatchObject({
      executionOutcome: 'success',
      file: { operation: 'write', modelLinesAdded: 2, appliedLinesAdded: 2 },
    });
  });

  it.each(['originalContentTruncated', 'newContentTruncated'] as const)(
    'does not calculate applied lines from a FileDiff whose %s preview is incomplete',
    async (truncated) => {
      const display: FileDiff = {
        fileDiff: 'partial preview',
        fileName: 'fixture.txt',
        originalContent: 'alpha\n',
        newContent: 'beta\n',
        truncatedForSession: true,
        [truncated]: true,
        diffStat: {
          model_added_lines: 13,
          model_removed_lines: 7,
          model_added_chars: 0,
          model_removed_chars: 0,
          user_added_lines: 0,
          user_removed_lines: 0,
          user_added_chars: 0,
          user_removed_chars: 0,
        },
      };
      const tools: ManagedToolSet = {
        sessionId: 'measured-session',
        admitsDirectory: () => true,
        tools: new Map([
          [
            'edit',
            {
              validateToolParams: () => null,
              build: () => ({
                execute: async () => ({
                  llmContent: 'edited',
                  returnDisplay: display,
                }),
              }),
            } as unknown as AnyDeclarativeTool,
          ],
        ]),
      };
      await start(
        MEASURED_WORKSPACE_CAPABILITY_DIGEST,
        new ManagedToolExecutor(async () => tools),
      );
      const { value } = await execute('truncated-edit', 'edit', {
        file_path: 'fixture.txt',
        old_string: 'alpha',
        new_string: 'beta',
      });
      expect(value.result?.executionStatus).toBe('success');
      expect(value.measurements?.file).toEqual({
        operation: 'edit',
        status: 'unmeasured',
        modelLinesAdded: 13,
        modelLinesRemoved: 7,
        appliedLinesAdded: null,
        appliedLinesRemoved: null,
      });
    },
  );

  it('can measure full old/new file contents when only the textual patch preview is truncated', async () => {
    const display: FileDiff = {
      fileDiff: 'truncated patch',
      fileName: 'fixture.txt',
      originalContent: 'alpha\n',
      newContent: 'beta\n',
      truncatedForSession: true,
      fileDiffTruncated: true,
      originalContentTruncated: false,
      newContentTruncated: false,
      diffStat: {
        model_added_lines: 13,
        model_removed_lines: 7,
        model_added_chars: 0,
        model_removed_chars: 0,
        user_added_lines: 0,
        user_removed_lines: 0,
        user_added_chars: 0,
        user_removed_chars: 0,
      },
    };
    const tools: ManagedToolSet = {
      sessionId: 'measured-session',
      admitsDirectory: () => true,
      tools: new Map([
        [
          'edit',
          {
            validateToolParams: () => null,
            build: () => ({
              execute: async () => ({
                llmContent: 'edited',
                returnDisplay: display,
              }),
            }),
          } as unknown as AnyDeclarativeTool,
        ],
      ]),
    };
    await start(
      MEASURED_WORKSPACE_CAPABILITY_DIGEST,
      new ManagedToolExecutor(async () => tools),
    );
    const { value } = await execute('patch-truncated-edit', 'edit', {
      file_path: 'fixture.txt',
      old_string: 'alpha',
      new_string: 'beta',
    });
    expect(value.measurements?.file).toEqual({
      operation: 'edit',
      status: 'measured',
      modelLinesAdded: 13,
      modelLinesRemoved: 7,
      appliedLinesAdded: 1,
      appliedLinesRemoved: 1,
    });
  });

  it('rejects a wrong full-result ACK and makes the original ACK idempotent after payload reclamation', async () => {
    await start();
    const { ref, value } = await execute('ack-read', 'read_file', {
      file_path: path.join(workspace, 'fixture.txt'),
    });
    const wrong = await post('/internal/managed-runtime/v4/acknowledge', {
      ...body(ref),
      resultDigest: '0'.repeat(64),
    });
    expect(wrong.status).toBe(409);
    const stillPresent = await post(
      '/internal/managed-runtime/v4/status',
      body(ref),
    );
    expect(await stillPresent.json()).toEqual(value);
    const ack = { ...body(ref), resultDigest: value.resultDigest };
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await post(
        '/internal/managed-runtime/v4/acknowledge',
        ack,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        protocolVersion: 4,
        executionProtocol: 2,
        state: 'acknowledged',
      });
    }
    const status = await post('/internal/managed-runtime/v4/status', body(ref));
    expect(await status.json()).toEqual({
      protocolVersion: 4,
      executionProtocol: 2,
      state: 'acknowledged',
    });
    const conflict = await post('/internal/managed-runtime/v4/acknowledge', {
      ...ack,
      resultDigest: '0'.repeat(64),
    });
    expect(conflict.status).toBe(409);
  });

  it('retains the closed legacy v2 result and v3 status envelope on a new executor', async () => {
    await start();
    const input = { file_path: path.join(workspace, 'fixture.txt') };
    const ref = reference('legacy-read', input);
    const response = await post('/internal/managed-runtime/v2/execute', {
      protocolVersion: 2,
      reference: ref,
      toolName: 'read_file',
      input,
    });
    expect(response.status).toBe(200);
    const value = (await response.json()) as Record<string, unknown>;
    expect(value).toMatchObject({
      protocolVersion: 2,
      state: 'settled',
      result: { executionStatus: 'success' },
    });
    expect(value).not.toHaveProperty('measurements');
    expect(value).not.toHaveProperty('resultDigest');
    expect(value['result']).not.toHaveProperty('measurements');
    const status = await post('/internal/managed-runtime/v3/status', {
      protocolVersion: 3,
      toolResult: 'managed-tool-result/1',
      reference: reference('unknown-v3', input),
    });
    expect(status.status).toBe(200);
    const v3 = (await status.json()) as Record<string, unknown>;
    expect(v3).toMatchObject({ protocolVersion: 3, state: 'unknown' });
    expect(v3).not.toHaveProperty('measurements');
    expect(v3).not.toHaveProperty('resultDigest');
  });

  it('does not register v4 for the original Workspace capability', async () => {
    await start(WORKSPACE_CAPABILITY_DIGEST);
    const input = { file_path: path.join(workspace, 'fixture.txt') };
    const response = await post('/internal/managed-runtime/v4/execute', {
      ...body(reference('old-profile', input)),
      toolName: 'read_file',
      input,
    });
    expect(response.status).toBe(404);
    expect(executor!.measurements(reference('old-profile', input))).toBeNull();
  });

  it('rejects wrong credentials, lease identity and unknown fields before dispatch', async () => {
    await start();
    const file = path.join(workspace, 'must-not-exist.txt');
    const input = { file_path: file, content: 'forbidden' };
    const value = {
      ...body(reference('blocked-write', input)),
      toolName: 'write_file',
      input,
    };
    const unauthenticated = await post(
      '/internal/managed-runtime/v4/execute',
      value,
      { ...headers, authorization: 'Bearer wrong' },
    );
    expect(unauthenticated.status).toBe(401);
    expect(
      unauthenticated.headers.get('x-qwen-managed-runtime-incarnation'),
    ).toBeNull();
    const wrongLease = await post(
      '/internal/managed-runtime/v4/execute',
      value,
      { ...headers, 'x-qwen-managed-lease-id': 'other-lease' },
    );
    expect(wrongLease.status).toBe(409);
    const unknown = await post('/internal/managed-runtime/v4/execute', {
      ...value,
      arbitraryMeasurement: 1,
    });
    expect(unknown.status).toBe(400);
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('treats a reference from another Session as unknown without exposing or acknowledging its result', async () => {
    await start();
    const { ref, value } = await execute('owned-read', 'read_file', {
      file_path: path.join(workspace, 'fixture.txt'),
    });
    const response = await post(
      '/internal/managed-runtime/v4/status',
      body({ ...ref, sessionId: 'another-session' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      protocolVersion: 4,
      executionProtocol: 2,
      state: 'unknown',
    });
    const ack = await post('/internal/managed-runtime/v4/acknowledge', {
      ...body({ ...ref, sessionId: 'another-session' }),
      resultDigest: value.resultDigest,
    });
    expect(await ack.json()).toEqual({
      protocolVersion: 4,
      executionProtocol: 2,
      state: 'unknown',
    });
    const original = await post(
      '/internal/managed-runtime/v4/status',
      body(ref),
    );
    expect(await original.json()).toEqual(value);
  });

  it('returns a protocol conflict when redispatch attempts to reuse an existing invocation under another Session', async () => {
    await start();
    const input = { file_path: path.join(workspace, 'fixture.txt') };
    const { ref, value } = await execute(
      'conflicting-read',
      'read_file',
      input,
    );
    const response = await post('/internal/managed-runtime/v4/execute', {
      ...body({ ...ref, sessionId: 'another-session' }),
      toolName: 'read_file',
      input,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'managed_runtime_identity_conflict',
    });
    const original = await post(
      '/internal/managed-runtime/v4/status',
      body(ref),
    );
    expect(await original.json()).toEqual(value);
  });
});
