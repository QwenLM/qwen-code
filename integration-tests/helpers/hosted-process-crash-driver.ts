/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fakeToolCall, startFakeOpenAIServer } from '../fake-openai-server.js';
import { HostedHarnessProcess, waitUntil } from './hosted-harness-process.js';

const configPath = process.argv[2];
const config = JSON.parse(await readFile(configPath, 'utf8')) as {
  tenantId: string;
  sessionId: string;
  workspaceId: string;
  directory: string;
  fault: string;
  storeUrl: string;
  brokerUrl: string;
  controlUrl: string;
};
type Transaction = {
  transactionId: string;
  recordBytesBase64: string;
};
const report = {
  fault: config.fault,
  promptId: randomUUID(),
  executionCallId: '',
  idempotencyKey: '',
  modelCalls: 0,
  operations: [] as string[],
  signalEvidence: [] as unknown[],
  restoreTransactions: [] as Transaction[],
  staleWriterConflicts: 0,
  fencedWriterRenewals: 0,
  target: undefined as Transaction | undefined,
};
const proof = path.join(config.directory, 'proof.txt');
const inFlight = !['harness-prepare', 'harness-result'].includes(config.fault);
await writeFile(proof, 'x');
let cli = new HostedHarnessProcess();
let clientId = '';
let restoring = false;
let injected = false;
let serviceKilled = false;
let proxyFailure: unknown;
const sealedWriters = new Set<string>();
// Writer identities (bootIds) of Harness processes this driver has SIGKILLed.
const killedWriters = new Set<string>();

function events(transaction: Transaction) {
  return Buffer.from(transaction.recordBytesBase64, 'base64')
    .toString()
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((record) => record.subtype === 'managed_session_event_v1')
    .map((record) => record.managedSession);
}

async function control(operation: string) {
  const response = await fetch(`${config.controlUrl}/${operation}`, {
    method: 'POST',
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

async function killHarness() {
  assert(cli.child?.pid);
  const pid = cli.child.pid;
  killedWriters.add(cli.bootId);
  const exited = once(cli.child, 'exit');
  assert(cli.child.kill('SIGKILL'));
  const [code, signal] = await exited;
  assert.equal(code, null);
  assert.equal(signal, 'SIGKILL');
  report.signalEvidence.push({ process: 'harness', pid, signal });
  killedWriters.add(cli.bootId);
}

async function enteredTool() {
  await waitUntil(() => existsSync(`${proof}.read-entered`));
  assert((await lstat(proof)).isFile());
  assert.equal(await readFile(proof, 'utf8'), 'x');
  const evidence = await control('evidence');
  assert.equal(evidence.executionState, 'EXECUTING');
  assert.equal(evidence.dispatchGeneration, 1);
}

const proxy = createServer(async (req, res) => {
  try {
    const store = req.url!.startsWith('/internal/managed-session-store/');
    const url = new URL(req.url!, store ? config.storeUrl : config.brokerUrl);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const fields = body.length
      ? JSON.parse(body.toString())
      : Object.fromEntries(url.searchParams);
    const commit = store && url.pathname.endsWith('/transactions:commit');
    if (
      commit &&
      !restoring &&
      config.fault === 'harness-result' &&
      events(fields).some(
        (event) =>
          event.kind === 'message.committed' &&
          event.payload.role === 'tool_result',
      )
    ) {
      assert.equal(injected, false);
      report.target = fields;
      const evidence = await control('evidence');
      assert.equal(evidence.executionState, 'SETTLED');
      assert.equal(evidence.executionStatus, 'success');
      await killHarness();
      injected = true;
      res.destroy();
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers))
      if (value && !['host', 'connection', 'content-length'].includes(name))
        headers.set(name, Array.isArray(value) ? value.join(',') : value);
    const operation =
      req.method === 'GET' ? 'status' : url.pathname.split(':').at(-1)!;
    if (!store) {
      assert.equal(fields.harnessSessionId, config.sessionId);
      assert.equal(fields.runtimeSessionId, report.promptId);
      assert.notEqual(
        operation,
        'release',
        'Unsettled execution must retain its owner',
      );
      report.operations.push(operation);
      const executionId = url.pathname.match(/\/executions\/([^/:]+)/)?.[1];
      if (executionId) assert.equal(executionId, report.executionCallId);
      if (operation === 'start' && inFlight)
        await writeFile(`${proof}.read-gate`, '');
    }
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      ...(body.length ? { body } : {}),
      signal: AbortSignal.timeout(40_000),
    });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    const json = upstream.headers
      .get('content-type')
      ?.includes('application/json')
      ? JSON.parse(bytes.toString())
      : undefined;
    const writerGrant = `${fields.writerId}:${fields.writerGeneration}`;
    if (
      store &&
      url.pathname.endsWith('/writers:seal') &&
      upstream.status === 200
    )
      sealedWriters.add(writerGrant);
    if (!serviceKilled) {
      if (
        upstream.status === 409 &&
        store &&
        url.pathname.endsWith('/writers:renew') &&
        (sealedWriters.has(writerGrant) ||
          (killedWriters.has(fields.writerId) &&
            fields.writerId !== cli.bootId))
      ) {
        // A renewal already in flight may reach the Store after its writer
        // sealed, or after the driver SIGKILLed the harness holding it. The
        // current boot's grant is never tolerated: catching that conflict is
        // the whole reason the fence exists.
        assert.equal(
          json.error.code,
          'managed_session_writer_conflict',
          `${url}: ${bytes}`,
        );
        report.fencedWriterRenewals++;
      } else if (
        upstream.status === 409 &&
        store &&
        killedWriters.has(fields.writerId)
      ) {
        // A write the killed Harness sent before SIGKILL can be answered only
        // after the cold load's acquire bumped the writer generation; the
        // writer fence rejecting it is the designed outcome, not a failure.
        assert.equal(
          json?.error?.code,
          'managed_session_writer_conflict',
          `${url}: ${bytes}`,
        );
        report.staleWriterConflicts++;
      } else if (upstream.status === 409) {
        assert(
          injected &&
            !store &&
            ['status', 'cancel'].includes(operation) &&
            config.fault.startsWith('worker-'),
          `${url}: ${bytes}`,
        );
        assert.equal(json.code, 'runtime_broker_execution_unknown');
      } else assert.equal(upstream.status, 200, `${url}: ${bytes}`);
    }
    if (restoring && store && url.pathname.endsWith('/transactions'))
      report.restoreTransactions.push(...json.transactions);
    if (!store && operation === 'prepare') {
      assert.equal(report.executionCallId, '');
      report.executionCallId = json.executionCallId;
      report.idempotencyKey = fields.idempotencyKey;
      if (config.fault === 'harness-prepare') {
        assert.equal(json.status.state, 'prepared');
        const evidence = await control('evidence');
        assert.equal(evidence.executionState, 'PREPARED');
        assert.equal(evidence.dispatchGeneration, 0);
        await killHarness();
        injected = true;
        res.destroy();
        return;
      }
    }
    if (!store && operation === 'start' && inFlight) {
      assert.equal(injected, false);
      assert.equal(json.status.state, 'executing');
      await enteredTool();
      if (config.fault === 'harness-start') {
        await killHarness();
        await unlink(`${proof}.read-gate`);
        injected = true;
        res.destroy();
        return;
      }
      serviceKilled = config.fault === 'spring-kill';
      const signal = await control(config.fault);
      report.signalEvidence.push({ process: config.fault, ...signal });
      if (serviceKilled) {
        assert.notEqual(signal.pid, signal.newPid);
        config.storeUrl = signal.storeUrl;
        config.brokerUrl = signal.brokerUrl;
      }
      injected = true;
    }
    for (const [name, value] of upstream.headers)
      if (!['content-length', 'transfer-encoding', 'connection'].includes(name))
        res.setHeader(name, value);
    res.writeHead(upstream.status);
    res.end(bytes);
  } catch (cause) {
    if (!serviceKilled || !(cause instanceof TypeError)) proxyFailure = cause;
    res.destroy();
  }
});
await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const address = proxy.address();
assert(address && typeof address !== 'string');
const proxyUrl = `http://127.0.0.1:${address.port}`;
const model = await startFakeOpenAIServer(() => {
  report.modelCalls++;
  if (report.modelCalls > 1) return { content: 'UNEXPECTED_CONTINUATION' };
  return {
    toolCalls: [
      fakeToolCall(
        'edit',
        {
          file_path: 'proof.txt',
          old_string: 'x',
          new_string: 'xx',
          replace_all: true,
        },
        'effect',
      ),
    ],
  };
});

async function json(route: string, body?: unknown, expected = 200) {
  if (proxyFailure) throw proxyFailure;
  const response = await cli.request(route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...cli.headers(clientId),
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.equal(response.status, expected, text + cli.output);
  if (proxyFailure) throw proxyFailure;
  return text ? JSON.parse(text) : undefined;
}

function connection() {
  return {
    managedSessionStore: {
      baseUrl: proxyUrl,
      tenantId: config.tenantId,
      workspaceId: config.workspaceId,
      writerId: cli.bootId,
      leaseDurationMs: 5_000,
    },
    toolProfile: 'hosted-workspace-files/1',
  };
}

async function start() {
  await cli.start(model.baseUrl, {
    extraArgs: [
      '--managed-runtime-broker-url',
      proxyUrl,
      '--managed-runtime-broker-token',
      'hosted-tools-broker-token',
    ],
  });
  await writeFile(path.join(cli.root, 'proof.txt'), 'decoy');
}

async function assertEffect() {
  assert((await lstat(proof)).isFile());
  assert.equal(
    await readFile(proof, 'utf8'),
    ['harness-start', 'harness-result'].includes(config.fault) ? 'xx' : 'x',
  );
  assert.equal(
    await readFile(path.join(cli.root, 'proof.txt'), 'utf8'),
    'decoy',
  );
}

try {
  await start();
  const boot = cli.bootId;
  const route = `/session/${config.sessionId}`;
  const created = await json('/session', {
    ...connection(),
    sessionId: config.sessionId,
    sessionScope: 'thread',
  });
  clientId = created.clientId;
  const prompt = [{ type: 'text', text: config.fault }];
  await json(
    `${route}/prompt`,
    {
      promptId: report.promptId,
      prompt,
      payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
    },
    202,
  );
  await waitUntil(() => {
    if (proxyFailure) throw proxyFailure;
    return injected;
  }, 60_000);
  if (config.fault === 'harness-start')
    await waitUntil(
      async () => (await control('evidence')).executionState === 'SETTLED',
    );
  if (!config.fault.startsWith('harness-')) {
    await waitUntil(
      async () => !(await json(`${route}/status`)).hasActivePrompt,
      90_000,
    );
    assert.equal((await json(`${route}/status`)).recoveryBlocked, true);
    let cursor = '0';
    while (true) {
      const response = await cli.request(
        `${route}/transcript?cursor=${cursor}&limit=256`,
        { headers: cli.headers(clientId) },
      );
      const text = await response.text();
      if (proxyFailure) throw proxyFailure;
      if (response.status === 503) {
        assert.equal(config.fault, 'spring-kill', text);
        assert.equal(JSON.parse(text).error, 'managed_transcript_unavailable');
        console.log(
          'FG6C spring-kill: live transcript unavailable after restart',
        );
        break;
      }
      assert.equal(response.status, 200, text + cli.output);
      const page = JSON.parse(text);
      assert.equal(
        page.events.filter((event: { type: string }) =>
          event.type.startsWith('turn_'),
        ).length,
        0,
      );
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    await killHarness();
  }
  await assertEffect();
  assert.equal(report.modelCalls, 1);
  for (const [operation, count] of [
    ['acquire', 1],
    ['prepare', 1],
    ['start', config.fault === 'harness-prepare' ? 0 : 1],
  ] as const)
    assert.equal(
      report.operations.filter((value) => value === operation).length,
      count,
    );
  await cli.close();
  const leaseDeadline = Date.now() + 5_100;
  await waitUntil(() => Date.now() >= leaseDeadline);
  cli = new HostedHarnessProcess();
  await start();
  assert.notEqual(cli.bootId, boot);
  restoring = true;
  const operations = report.operations.length;
  const loaded = await json(`${route}/load`, connection(), 409);
  assert.equal(loaded.error, 'hosted_turn_recovery_required');
  assert(report.restoreTransactions.length > 0);
  const restored = report.restoreTransactions.flatMap(events);
  assert.equal(
    restored.filter(
      (event) =>
        event.kind === 'input.accepted' &&
        event.payload.turnId === report.promptId,
    ).length,
    1,
  );
  assert.equal(
    restored.filter((event) => event.kind === 'turn.settled').length,
    0,
  );
  assert.equal(
    restored.filter(
      (event) =>
        event.kind === 'message.committed' &&
        event.payload.role === 'tool_result',
    ).length,
    0,
  );
  assert.equal(
    report.operations.length,
    operations,
    'Cold load must not contact Broker',
  );
  assert.equal(report.modelCalls, 1, 'Cold load must not call the model');
  await assertEffect();
  if (proxyFailure) throw proxyFailure;
  await writeFile(`${configPath}.results`, JSON.stringify(report));
  console.log(
    `FG6C ${config.fault}: execution=${report.executionCallId}, signals=${JSON.stringify(report.signalEvidence)}, cold=blocked`,
  );
  console.log('HOSTED_PROCESS_CRASH_OK');
} catch (cause) {
  console.error(`FG6C ${config.fault}`, JSON.stringify(report), cli.output);
  throw cause;
} finally {
  // The parent owns worker cleanup; do not unblock an uncertain Edit.
  await cli.close();
  await model.close();
  proxy.closeAllConnections();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
}
