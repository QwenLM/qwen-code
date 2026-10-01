/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import {
  parseManagedToolInvocationReference,
  type ManagedToolPrepareResponse,
} from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import type { ManagedToolInvocationStatus } from '@qwen-code/qwen-code-core/tools/managed-tool-runtime.js';
import {
  ManagedRuntimeBrokerClient,
  MANAGED_RUNTIME_BROKER_ROUTE_PREFIX,
} from '../../packages/cli/src/serve/broker-managed-runtime-provider.js';
import { waitUntil } from './hosted-harness-process.js';

const configPath = process.argv[2];
const config = JSON.parse(await readFile(configPath, 'utf8')) as {
  tenantId: string;
  brokerUrl: string;
  statusGateUrl: string;
  sessions: Array<{
    sessionId: string;
    workspaceId: string;
    directory: string;
    fault: string;
  }>;
};
const reports = config.sessions.map((session) => ({
  ...session,
  runtimeSessionId: randomUUID(),
  promptId: randomUUID(),
  executionCallId: '',
  reference: {} as Record<string, unknown>,
  reservation: {} as Record<string, unknown>,
  starts: 0,
  drops: 0,
}));
let current = reports[0];
let proxyFailure: unknown;
const prefix = MANAGED_RUNTIME_BROKER_ROUTE_PREFIX + '/';
const token = 'hosted-tools-broker-token';
const proxy = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const body = bytes.length ? JSON.parse(bytes.toString()) : undefined;
    const url = new URL(req.url!, config.brokerUrl);
    assert.equal(
      body?.harnessSessionId ?? url.searchParams.get('harnessSessionId'),
      current.sessionId,
    );
    const start = url.pathname.endsWith(':start') && !('payloadJson' in body);
    const headers = new Headers();
    for (const name of ['authorization', 'content-type'] as const) {
      const value = req.headers[name];
      if (value !== undefined) headers.set(name, value);
    }
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      ...(bytes.length ? { body: bytes } : {}),
      signal: AbortSignal.timeout(40_000),
    });
    const response = Buffer.from(await upstream.arrayBuffer());
    if (upstream.status === 200) {
      if (url.pathname.endsWith('/executions:prepare'))
        current.reservation = structuredClone(body);
      if (start) current.starts++;
    }
    if (
      start &&
      current.fault === 'start-retry' &&
      current.drops === 0 &&
      upstream.status === 200
    ) {
      assert.equal(
        JSON.parse(response.toString()).executionCallId,
        current.executionCallId,
      );
      current.drops++;
      res.destroy();
      return;
    }
    res.writeHead(upstream.status, {
      'content-type': 'application/json',
      'cache-control': upstream.headers.get('cache-control') ?? '',
    });
    res.end(response);
  } catch (cause) {
    proxyFailure = cause;
    res.destroy();
  }
});
await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const address = proxy.address();
assert(address && typeof address !== 'string');
const baseUrl = `http://127.0.0.1:${address.port}`;
const client = new ManagedRuntimeBrokerClient({ baseUrl, token });
const signal = () => AbortSignal.timeout(45_000);

async function evidence(phase: string) {
  if (proxyFailure) throw proxyFailure;
  const response = await fetch(
    new URL(`/provider/${current.sessionId}/${phase}`, config.statusGateUrl),
    { method: 'POST', signal: signal() },
  );
  const body = await response.text();
  assert.equal(response.status, 200, body);
  return JSON.parse(body);
}

async function request(route: string, fields: object, expected = 200) {
  const response = await fetch(new URL(prefix + route, baseUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      protocolVersion: 1,
      requestId: randomUUID(),
      harnessSessionId: current.sessionId,
      runtimeSessionId: current.runtimeSessionId,
      ...fields,
    }),
    signal: signal(),
  });
  const body = await response.json();
  assert.equal(response.status, expected, JSON.stringify(body));
  if (proxyFailure) throw proxyFailure;
  if (expected === 200) {
    assert.equal(body.protocolVersion, 1);
    assert.equal(body.harnessSessionId, current.sessionId);
    assert.equal(body.runtimeSessionId, current.runtimeSessionId);
  }
  return body;
}

async function changedReference() {
  for (const field of ['policyRevision', 'capabilityDigest', 'invocationId']) {
    const original = current.reference[field] as string;
    const replacement =
      field === 'capabilityDigest'
        ? (original[0] === '0' ? '1' : '0') + original.slice(1)
        : original + '-changed';
    const rejected = await request(
      'executions:prepare',
      {
        ...current.reservation,
        reference: { ...current.reference, [field]: replacement },
      },
      409,
    );
    assert.equal(rejected.code, 'runtime_idempotency_conflict');
  }
}

try {
  for (current of reports) {
    const raw = current.fault === 'raw-contract';
    await client.acquire(
      {
        protocolVersion: 1,
        tenantId: config.tenantId,
        workspaceId: current.workspaceId,
        workspaceCwd: current.directory,
        sessionId: current.runtimeSessionId,
        turnKind: 'bootstrap',
      },
      current.sessionId,
      signal(),
    );
    const file = path.join(current.directory, 'proof.txt');
    const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
    const toolName = raw ? 'edit' : 'run_shell_command';
    const input = raw
      ? { file_path: file, old_string: 'x', new_string: 'xx' }
      : {
          command:
            quote(process.execPath) +
            ' -e ' +
            quote("require('fs').appendFileSync('proof.txt', 'x')"),
        };
    const payloadJson = JSON.stringify({ toolName, input });
    let prepared: {
      executionCallId: string;
      status: ManagedToolInvocationStatus;
    };
    if (raw) {
      current.reference = {
        sessionId: current.runtimeSessionId,
        promptId: current.promptId,
        callId: randomUUID(),
        argsDigest:
          'sha256:' + createHash('sha256').update(payloadJson).digest('hex'),
      };
      prepared = await request('executions:prepare', {
        idempotencyKey: randomUUID(),
        turnId: current.promptId,
        toolCallId: current.reference['callId'],
        requestDigest: current.reference['argsDigest'],
        reference: current.reference,
      });
    } else {
      const control = (operation: Record<string, unknown>) =>
        client.control(
          current.runtimeSessionId,
          current.sessionId,
          operation,
          signal(),
        );
      const manifest = (await control({ kind: 'manifest' })) as {
        capabilityDigest: string;
        policyRevision: string;
      };
      const identity = {
        sessionId: current.runtimeSessionId,
        promptId: current.promptId,
        callId: randomUUID(),
        capabilityDigest: manifest.capabilityDigest,
        policyRevision: manifest.policyRevision,
      };
      await control({
        kind: 'bind-history',
        binding: {
          ownerSessionId: current.sessionId,
          ownerRuntimeSessionId: current.runtimeSessionId,
          executionCwd: current.directory,
          snapshots: [],
        },
      });
      await control({ kind: 'begin-turn', identity });
      const invocation = (await control({
        kind: 'prepare',
        identity,
        toolName,
        input,
      })) as ManagedToolPrepareResponse;
      const reference = parseManagedToolInvocationReference({
        ...identity,
        invocationId: invocation.invocationId,
        argsDigest: invocation.argsDigest,
      });
      for (const key of Object.keys(reference) as Array<
        keyof typeof reference
      >) {
        assert.equal(invocation[key], reference[key]);
      }
      current.reference = { ...reference };
      if (invocation.defaultPermission === 'ask')
        await control({ kind: 'confirm', reference, outcome: 'proceed_once' });
      await control({ kind: 'preflight', reference });
      prepared = await client.prepareExecution(
        current.runtimeSessionId,
        current.sessionId,
        reference,
        signal(),
      );
    }
    current.executionCallId = prepared.executionCallId;
    assert.equal(prepared.status.state, 'prepared');
    const reservation = structuredClone(current.reservation);
    assert.equal(
      (await request('executions:prepare', reservation)).executionCallId,
      current.executionCallId,
    );
    await evidence('prepared');
    const invalidStart = async () => {
      const rejected = await request(
        `executions/${current.executionCallId}:start`,
        raw ? {} : { payloadJson },
        raw ? 400 : 409,
      );
      assert.equal(
        rejected.code,
        raw ? 'runtime_payload_invalid' : 'runtime_execution_conflict',
      );
    };
    await invalidStart();
    if (!raw) await changedReference();
    await evidence('prepared');
    const start = () =>
      raw
        ? request(`executions/${current.executionCallId}:start`, {
            payloadJson,
          }).then((body) => body.status)
        : client.startExecution(
            current.runtimeSessionId,
            current.sessionId,
            current.executionCallId,
            signal(),
          );
    if (current.fault === 'start-retry') {
      await assert.rejects(start);
      assert.equal(current.drops, 1);
    } else await start();
    let settled: ManagedToolInvocationStatus | undefined;
    await waitUntil(async () => {
      settled = await client.getExecution(
        current.runtimeSessionId,
        current.sessionId,
        current.executionCallId,
        undefined,
        signal(),
      );
      return settled.state === 'settled';
    });
    assert.equal(settled!.result?.executionStatus, 'success');
    assert.deepEqual((await start()).result, settled!.result);
    await invalidStart();
    if (!raw) await changedReference();
    assert.equal(
      (await request('executions:prepare', reservation)).executionCallId,
      current.executionCallId,
    );
    await evidence('settled');
    const release = () =>
      client.release(current.runtimeSessionId, current.sessionId, signal());
    if (current.fault === 'release-reply') {
      await assert.rejects(release, {
        name: 'BrokerResponseError',
        status: 503,
        code: 'managed_runtime_unavailable',
        retryable: true,
      });
      await evidence('uncertain');
      await evidence('resume');
    }
    assert.equal(await release(), true);
    assert.equal(await release(), true);
    assert.deepEqual(
      await client.getExecution(
        current.runtimeSessionId,
        current.sessionId,
        current.executionCallId,
        undefined,
        signal(),
      ),
      settled,
    );
    await evidence('released');
    assert.equal(await readFile(file, 'utf8'), 'xx');
    assert.equal(current.starts, raw ? 0 : 2);
    console.log(
      `FG6F_PROVIDER ${current.fault}: original=${current.executionCallId}, effect=once, released=true`,
    );
  }
  if (proxyFailure) throw proxyFailure;
  await writeFile(configPath + '.results', JSON.stringify(reports));
  console.log('HOSTED_PROVIDER_FAULTS_OK');
} catch (cause) {
  console.error('FG6F_PROVIDER ' + current.fault, JSON.stringify(current));
  throw proxyFailure ?? cause;
} finally {
  proxy.closeAllConnections();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
}
