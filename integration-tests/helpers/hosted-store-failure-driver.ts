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
import { fakeToolCall, startFakeOpenAIServer } from '../fake-openai-server.js';
import { HostedHarnessProcess, waitUntil } from './hosted-harness-process.js';
import { relayUpstream } from './hosted-relay-headers.js';

const configPath = process.argv[2];
const config = JSON.parse(await readFile(configPath, 'utf8')) as {
  tenantId: string;
  storeUrl: string;
  brokerUrl: string;
  sessions: Array<{
    sessionId: string;
    workspaceId: string;
    directory: string;
    fault: string;
  }>;
};
type Transaction = {
  transactionId: string;
  commandId: string;
  recordBytesBase64: string;
  latestCheckpointResourceId?: string;
  resources: Array<{
    resourceId: string;
    kind: string;
    bytesBase64?: string;
  }>;
};
type Event = { kind: string; payload: Record<string, unknown> };
type Receipt = { journalRevision: number; replayed: boolean };
const reports = config.sessions.map((session) => ({
  ...session,
  promptId: '',
  clientId: '',
  executionCallId: '',
  idempotencyKey: '',
  modelCalls: 0,
  faults: 0,
  operations: [] as string[],
  target: undefined as Transaction | undefined,
  targetDigest: '',
  receipt: undefined as Receipt | undefined,
  restoreTransactions: [] as Transaction[],
}));
let cli = new HostedHarnessProcess();
let current = reports[0];
let restoring = false;
let proxyFailure: unknown;

function events(transaction: Transaction): Event[] {
  return Buffer.from(transaction.recordBytesBase64, 'base64')
    .toString()
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((record) => record.subtype === 'managed_session_event_v1')
    .map((record) => record.managedSession);
}

function selected(transaction: Transaction, fault: string) {
  const committed = events(transaction);
  if (fault === 'arguments' || fault === 'intent') {
    const intent = committed.find((event) => event.kind === 'tool.intent');
    if (!intent) return false;
    const argument = transaction.resources.find(
      (resource) => resource.kind === 'managed-tool-input',
    );
    assert(argument?.bytesBase64);
    assert.equal(
      (intent.payload['argsRef'] as { resourceId: string }).resourceId,
      argument.resourceId,
    );
    return true;
  }
  if (fault === 'await-runtime' || fault === 'result-checkpoint') {
    const checkpoint = transaction.resources.find(
      (resource) =>
        resource.resourceId === transaction.latestCheckpointResourceId &&
        resource.kind === 'managed-checkpoint',
    );
    if (!checkpoint?.bytesBase64) return false;
    const state = JSON.parse(
      Buffer.from(checkpoint.bytesBase64, 'base64').toString(),
    );
    const matches =
      state.continuation.phase ===
      (fault === 'await-runtime' ? 'await_runtime' : 'results_ready');
    if (matches && fault === 'result-checkpoint')
      assert(
        transaction.resources.some(
          (resource) => resource.kind === 'managed-tool-outcome',
        ),
      );
    return matches;
  }
  return committed.some((event) =>
    fault === 'turn-reply'
      ? event.kind === 'turn.settled'
      : event.kind === 'message.committed' &&
        event.payload['role'] === 'tool_result',
  );
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
    const sessionId = store
      ? url.pathname.match(/\/sessions\/([^/]+)/)?.[1]
      : fields.harnessSessionId;
    const report = reports.find((item) => item.sessionId === sessionId);
    assert(report, `Unexpected session: ${url}`);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value && !['host', 'connection', 'content-length'].includes(name))
        headers.set(name, Array.isArray(value) ? value.join(',') : value);
    }
    const init = {
      method: req.method,
      headers,
      ...(body.length ? { body } : {}),
      signal: AbortSignal.timeout(30_000),
    };
    const commit = store && url.pathname.endsWith('/transactions:commit');
    const target = commit && !restoring && selected(fields, report.fault);
    if (target) {
      assert(report.faults < 3, 'Harness exceeded the commit retry budget');
      report.faults++;
      const digest = createHash('sha256').update(body).digest('hex');
      if (report.target) assert.equal(digest, report.targetDigest);
      else {
        report.target = fields;
        report.targetDigest = digest;
      }
    }
    const upstream = await fetch(url, init);
    const bytes = Buffer.from(await upstream.arrayBuffer());
    const json = upstream.headers
      .get('content-type')
      ?.includes('application/json')
      ? JSON.parse(bytes.toString())
      : undefined;
    if (target) {
      if (report.fault.endsWith('-reply')) {
        assert.equal(upstream.status, 200, bytes.toString());
        assert.equal(json.replayed, report.faults > 1);
        if (report.receipt)
          assert.deepEqual(json, { ...report.receipt, replayed: true });
        else {
          report.receipt = json;
          const replay = await fetch(url, init);
          assert.equal(replay.status, 200, await replay.clone().text());
          assert.deepEqual(await replay.json(), { ...json, replayed: true });
        }
        // Lose every bounded retry's reply to retain the unknown-write probe.
        res.destroy();
        return;
      }
      assert.equal(upstream.status, 500, bytes.toString());
    } else assert.equal(upstream.status, 200, `${url}: ${bytes}`);
    if (restoring && store && url.pathname.endsWith('/transactions'))
      report.restoreTransactions.push(...json.transactions);
    if (!store) {
      assert.equal(fields.runtimeSessionId, report.promptId);
      const operation =
        req.method === 'GET' ? 'status' : url.pathname.split(':').at(-1)!;
      report.operations.push(operation);
      if (operation === 'prepare') {
        assert.equal(report.executionCallId, '');
        report.executionCallId = json.executionCallId;
        report.idempotencyKey = fields.idempotencyKey;
      }
      const executionId = url.pathname.match(/\/executions\/([^/:]+)/)?.[1];
      if (executionId) {
        assert.equal(executionId, report.executionCallId);
        assert.equal(json.executionCallId, report.executionCallId);
      }
    }
    relayUpstream(res, upstream, bytes);
  } catch (cause) {
    proxyFailure = cause;
    res.destroy();
  }
});
await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const address = proxy.address();
assert(address && typeof address !== 'string');
const proxyUrl = `http://127.0.0.1:${address.port}`;
const model = await startFakeOpenAIServer(({ body }) => {
  current.modelCalls++;
  const messages = body['messages'] as Array<{
    role: string;
    content: unknown;
  }>;
  const receipts = messages.filter((message) => message.role === 'tool');
  if (!receipts.length)
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
  assert.equal(receipts.length, 1);
  assert.match(JSON.stringify(receipts[0].content), /has been updated/);
  return { content: 'STORE_FAULT_TURN_DONE' };
});

async function json(route: string, body?: unknown, expected = 200) {
  if (proxyFailure) throw proxyFailure;
  const response = await cli.request(route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...cli.headers(current.clientId),
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
      workspaceId: current.workspaceId,
      writerId: cli.bootId,
      leaseDurationMs: 5_000,
    },
    toolProfile: 'hosted-workspace-files/1',
  };
}

function input(text: string) {
  const prompt = [{ type: 'text', text }];
  return {
    promptId: randomUUID(),
    prompt,
    payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
  };
}

async function transcript() {
  const result: Array<{
    type: string;
    promptId?: string;
    data: { record?: { type: string } };
  }> = [];
  let cursor = '0';
  while (true) {
    const page = await json(
      `/session/${current.sessionId}/transcript?cursor=${cursor}&limit=256`,
    );
    result.push(...page.events);
    if (!page.hasMore) return result;
    cursor = page.nextCursor;
  }
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

try {
  await start();
  for (current of reports) {
    const created = await json('/session', {
      ...connection(),
      sessionId: current.sessionId,
      sessionScope: 'thread',
    });
    current.clientId = created.clientId;
    const command = input(current.fault);
    current.promptId = command.promptId;
    const route = `/session/${current.sessionId}`;
    await json(`${route}/prompt`, command, 202);
    await waitUntil(
      async () => !(await json(`${route}/status`)).hasActivePrompt,
    );
    assert.equal(current.faults, 3, `${current.fault}: retries not exhausted`);
    assert.equal((await json(`${route}/status`)).recoveryBlocked, true);
    assert.equal(current.modelCalls, current.fault === 'turn-reply' ? 2 : 1);
    const records = await transcript();
    assert.equal(
      records.filter((event) => event.type.startsWith('turn_')).length,
      0,
    );
    assert.equal(
      records.filter((event) => event.data.record?.type === 'tool_result')
        .length,
      ['result-checkpoint', 'turn-reply'].includes(current.fault) ? 1 : 0,
    );
    const started =
      current.fault.startsWith('result-') || current.fault === 'turn-reply';
    for (const [operation, count] of [
      ['acquire', 1],
      ['prepare', 1],
      ['start', started ? 1 : 0],
      ['release', current.fault === 'turn-reply' ? 1 : 0],
    ] as const)
      assert.equal(
        current.operations.filter((item) => item === operation).length,
        count,
      );
    assert.equal(
      await readFile(path.join(current.directory, 'proof.txt'), 'utf8'),
      started ? 'xx' : 'x',
    );
    assert.equal(
      await readFile(path.join(cli.root, 'proof.txt'), 'utf8'),
      'decoy',
    );
    assert.equal(
      (await json(`${route}/prompt`, input('must remain blocked'), 409)).error,
      'hosted_turn_recovery_required',
    );
  }
  await cli.close();
  const leaseDeadline = Date.now() + 5_100;
  await waitUntil(() => Date.now() >= leaseDeadline);
  cli = new HostedHarnessProcess();
  await start();
  restoring = true;
  for (current of reports) {
    const operations = current.operations.length;
    const calls = current.modelCalls;
    const completed = current.fault === 'turn-reply';
    const loaded = await json(
      `/session/${current.sessionId}/load`,
      connection(),
      completed ? 200 : 409,
    );
    if (completed) {
      current.clientId = loaded.clientId;
      const records = await transcript();
      const terminals = records.filter((event) =>
        event.type.startsWith('turn_'),
      );
      assert.equal(terminals.length, 1);
      assert.equal(terminals[0].type, 'turn_complete');
      assert.equal(terminals[0].promptId, current.promptId);
      assert.equal(
        records.filter((event) => event.data.record?.type === 'tool_result')
          .length,
        1,
      );
      await json(`/session/${current.sessionId}/detach`, {}, 204);
    } else assert.equal(loaded.error, 'hosted_turn_recovery_required');
    assert(current.restoreTransactions.length > 0);
    const restored = current.restoreTransactions.filter(
      (transaction) =>
        transaction.transactionId === current.target!.transactionId,
    );
    assert.equal(restored.length, current.receipt ? 1 : 0);
    if (current.receipt)
      assert.equal(
        restored[0].recordBytesBase64,
        current.target!.recordBytesBase64,
      );
    assert.equal(
      current.operations.length,
      operations,
      'Cold load must not contact Broker',
    );
    assert.equal(
      current.modelCalls,
      calls,
      'Cold load must not call the model',
    );
    const started = current.fault.startsWith('result-') || completed;
    assert.equal(
      await readFile(path.join(current.directory, 'proof.txt'), 'utf8'),
      started ? 'xx' : 'x',
    );
    assert.equal(
      await readFile(path.join(cli.root, 'proof.txt'), 'utf8'),
      'decoy',
    );
    console.log(
      `FG6B ${current.fault}: faults=${current.faults}, modelCalls=${calls}, starts=${started ? 1 : 0}, cold=${completed ? 'committed' : 'blocked'}`,
    );
  }
  if (proxyFailure) throw proxyFailure;
  await writeFile(`${configPath}.results`, JSON.stringify(reports));
  console.log('HOSTED_STORE_FAILURES_OK');
} catch (cause) {
  console.error(`FG6B ${current.fault}`, JSON.stringify(current), cli.output);
  throw cause;
} finally {
  await cli.close();
  await model.close();
  proxy.closeAllConnections();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
}
