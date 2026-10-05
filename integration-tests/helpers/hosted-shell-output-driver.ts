/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { constants } from 'node:fs';
import { type FileHandle, open, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fakeToolCall, startFakeOpenAIServer } from '../fake-openai-server.js';
import { HostedHarnessProcess, waitUntil } from './hosted-harness-process.js';

const configPath = process.argv[2];
const config = JSON.parse(await readFile(configPath, 'utf8')) as {
  tenantId: string;
  storeUrl: string;
  brokerUrl: string;
  statusGateUrl: string;
  sessions: Array<{
    sessionId: string;
    workspaceId: string;
    directory: string;
    fault: string;
  }>;
};
type Transaction = {
  transactionId: string;
  recordBytesBase64: string;
};
const reports = config.sessions.map((session) => ({
  ...session,
  promptId: randomUUID(),
  executionCallId: '',
  idempotencyKey: '',
  modelCalls: 0,
  injections: 0,
  operations: [] as string[],
  signals: [] as unknown[],
  prefix: undefined as { resourceId: string; digest: string } | undefined,
  target: undefined as Transaction | undefined,
  targetDigest: '',
  receipt: undefined as Record<string, unknown> | undefined,
  restoreTransactions: [] as Transaction[],
}));
let current = reports[0];
let cli = new HostedHarnessProcess();
let clientId = '';
let restoring = false;
let proxyFailure: unknown;

function events(transaction: Transaction) {
  return Buffer.from(transaction.recordBytesBase64, 'base64')
    .toString()
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((record) => record.subtype === 'managed_session_event_v1')
    .map((record) => record.managedSession);
}

async function control(phase: string) {
  if (proxyFailure) throw proxyFailure;
  const response = await fetch(
    new URL(
      '/shell-output/' + current.sessionId + '/' + phase,
      config.statusGateUrl,
    ),
    { method: 'POST', signal: AbortSignal.timeout(15_000) },
  );
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

async function killHarness() {
  assert(cli.child?.pid);
  const pid = cli.child.pid;
  const exited = once(cli.child, 'exit');
  assert(cli.child.kill('SIGKILL'));
  const [code, signal] = await exited;
  assert.equal(code, null);
  assert.equal(signal, 'SIGKILL');
  current.signals.push({ process: 'harness', pid, signal });
}

async function finishProducer() {
  let writer: FileHandle | undefined;
  try {
    await waitUntil(async () => {
      try {
        writer = await open(
          path.join(current.directory, 'output-gate'),
          constants.O_WRONLY | constants.O_NONBLOCK,
        );
        return true;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENXIO') throw cause;
        return false;
      }
    });
    assert(writer);
    await writer.write('finish');
  } finally {
    await writer?.close();
  }
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
    assert.equal(sessionId, current.sessionId);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers))
      if (value && !['host', 'connection', 'content-length'].includes(name))
        headers.set(name, Array.isArray(value) ? value.join(',') : value);
    const operation =
      req.method === 'GET' ? 'status' : url.pathname.split(':').at(-1)!;
    const executionId = url.pathname.match(/\/executions\/([^/:]+)/)?.[1];
    if (!store) {
      assert.equal(restoring, false, 'Cold load must not contact Broker');
      assert.equal(fields.runtimeSessionId, current.promptId);
      assert.notEqual(operation, 'acknowledge');
      assert.notEqual(operation, 'release');
      current.operations.push(operation);
      if (executionId) assert.equal(executionId, current.executionCallId);
    }
    const target =
      store &&
      !restoring &&
      url.pathname.endsWith('/transactions:commit') &&
      events(fields).some((event) => event.kind === 'tool.receipt');
    if (target) {
      assert(current.fault.startsWith('receipt-'));
      assert(
        current.injections < 3,
        'Harness exceeded the commit retry budget',
      );
      current.injections++;
      assert.equal(fields.operation, 'recordToolResult');
      assert.equal(fields.commandId, current.executionCallId);
      const digest = createHash('sha256').update(body).digest('hex');
      if (current.target) assert.equal(digest, current.targetDigest);
      else {
        current.target = fields;
        current.targetDigest = digest;
      }
    }
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      ...(body.length ? { body } : {}),
      signal: AbortSignal.timeout(35_000),
    });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    const json = upstream.headers
      .get('content-type')
      ?.includes('application/json')
      ? JSON.parse(bytes.toString())
      : undefined;
    if (target && current.fault === 'receipt-failure') {
      assert.equal(upstream.status, 500, bytes.toString());
    } else if (!store && upstream.status === 409) {
      assert.equal(
        current.injections,
        current.fault.startsWith('receipt-') ? 3 : 1,
      );
      assert(['status', 'cancel'].includes(operation));
      assert(
        [
          'runtime_broker_execution_unknown',
          'runtime_execution_evidence_unavailable',
          'runtime_admission_closed',
        ].includes(json.code),
        json.code,
      );
    } else {
      assert.equal(upstream.status, 200, url + ': ' + bytes);
    }
    if (!store && executionId && upstream.status === 200)
      assert.equal(json.executionCallId, current.executionCallId);
    if (!store && operation === 'prepare') {
      assert.equal(current.executionCallId, '');
      assert.equal(fields.reference.runtimeProtocol, 3);
      current.executionCallId = json.executionCallId;
      current.idempotencyKey = fields.idempotencyKey;
      await control('prepared');
    }
    if (
      store &&
      !restoring &&
      url.pathname.endsWith('/tool-results:publish') &&
      fields.kind === 'managed-tool-result-content' &&
      fields.byteLength === 1024 * 1024
    ) {
      assert.equal(current.prefix, undefined);
      current.prefix = { resourceId: fields.resourceId, digest: fields.digest };
      assert.equal(
        fields.digest,
        createHash('sha256')
          .update(Buffer.alloc(1024 * 1024, 0x61))
          .digest('hex'),
      );
      await control('prefix');
      if (current.fault.endsWith('-kill')) {
        assert.equal(current.injections++, 0);
        if (current.fault === 'publisher-kill') {
          await killHarness();
          res.destroy();
          return;
        }
        current.signals.push(await control('kill-worker'));
      }
    }
    if (target && current.fault === 'receipt-reply') {
      assert.equal(json.replayed, current.injections > 1);
      if (current.receipt)
        assert.deepEqual(json, { ...current.receipt, replayed: true });
      else current.receipt = json;
      // Lose every bounded retry's reply to retain the unknown-write probe.
      res.destroy();
      return;
    }
    if (restoring && store && url.pathname.endsWith('/transactions'))
      current.restoreTransactions.push(...json.transactions);
    for (const [name, value] of upstream.headers)
      if (!['content-length', 'transfer-encoding', 'connection'].includes(name))
        res.setHeader(name, value);
    res.writeHead(upstream.status);
    res.end(bytes);
  } catch (cause) {
    proxyFailure = cause;
    res.destroy();
  }
});
await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const address = proxy.address();
assert(address && typeof address !== 'string');
const proxyUrl = 'http://127.0.0.1:' + address.port;
const model = await startFakeOpenAIServer(() => {
  current.modelCalls++;
  if (current.modelCalls > 1) return { content: 'UNEXPECTED_CONTINUATION' };
  const producer = [
    "const fs = require('fs');",
    "fs.writeFileSync('shell.pid', String(process.pid));",
    "fs.appendFileSync('proof.txt', 'x');",
    'process.stdout.write(Buffer.alloc(1024 * 1024, 0x61), () => {',
    current.fault.endsWith('-kill') ? "fs.readFileSync('output-gate');" : '',
    "process.stdout.write('stdout-tail\\n');",
    "process.stderr.write('stderr-tail\\n');",
    '});',
  ].join('\n');
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  return {
    toolCalls: [
      fakeToolCall(
        'run_shell_command',
        {
          command: quote(process.execPath) + ' -e ' + quote(producer),
          timeout: 60_000,
        },
        'shell-effect',
      ),
    ],
  };
});

async function json(route: string, body?: unknown, expected = 200) {
  if (proxyFailure) throw proxyFailure;
  const response = await cli.request(route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...cli.headers(clientId), 'Content-Type': 'application/json' },
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
    toolProfile: 'hosted-workspace-shell/1',
  };
}

async function start() {
  cli = new HostedHarnessProcess();
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
  assert.equal(
    await readFile(path.join(current.directory, 'proof.txt'), 'utf8'),
    'xx',
  );
  assert.equal(
    await readFile(path.join(cli.root, 'proof.txt'), 'utf8'),
    'decoy',
  );
}

try {
  for (current of reports) {
    restoring = false;
    if (current.fault.endsWith('-kill'))
      execFileSync('mkfifo', [path.join(current.directory, 'output-gate')]);
    await start();
    const originalBoot = cli.bootId;
    const route = '/session/' + current.sessionId;
    const created = await json('/session', {
      ...connection(),
      sessionId: current.sessionId,
      sessionScope: 'thread',
    });
    clientId = created.clientId;
    const prompt = [{ type: 'text', text: current.fault }];
    const input = {
      promptId: current.promptId,
      prompt,
      payloadDigest:
        'sha256:' +
        createHash('sha256').update(JSON.stringify(prompt)).digest('hex'),
    };
    await json(route + '/prompt', input, 202);
    await waitUntil(() => {
      if (proxyFailure) throw proxyFailure;
      return current.injections > 0;
    });
    if (current.fault === 'publisher-kill') {
      await waitUntil(() => cli.child!.signalCode === 'SIGKILL');
      await finishProducer();
    } else {
      await waitUntil(
        async () => !(await json(route + '/status')).hasActivePrompt,
        60_000,
      );
      assert.equal((await json(route + '/status')).recoveryBlocked, true);
      const operations = current.operations.length;
      const rejected = await json(
        route + '/prompt',
        { ...input, promptId: randomUUID() },
        409,
      );
      assert.equal(rejected.error, 'hosted_turn_recovery_required');
      assert.equal(current.operations.length, operations);
      await killHarness();
    }
    await waitUntil(
      async () => (await control('state')).state !== 'EXECUTING',
      45_000,
    );
    await control('finished');
    await assertEffect();
    assert.equal(
      current.injections,
      current.fault.startsWith('receipt-') ? 3 : 1,
    );
    assert.equal(current.modelCalls, 1);
    assert(current.prefix);
    for (const operation of ['acquire', 'publisher', 'prepare', 'start'])
      assert.equal(
        current.operations.filter((value) => value === operation).length,
        1,
        operation,
      );
    await cli.close();
    const leaseDeadline = Date.now() + 5_100;
    await waitUntil(() => Date.now() >= leaseDeadline);
    await start();
    assert.notEqual(cli.bootId, originalBoot);
    restoring = true;
    const operations = current.operations.length;
    const loaded = await json(route + '/load', connection(), 409);
    assert.equal(loaded.error, 'hosted_turn_recovery_required');
    assert(current.restoreTransactions.length > 0);
    const restored = current.restoreTransactions.flatMap(events);
    assert.equal(
      restored.filter((event) => event.kind === 'input.accepted').length,
      1,
    );
    assert.equal(
      restored.filter((event) => event.kind === 'tool.intent').length,
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
      restored.filter((event) => event.kind === 'tool.receipt').length,
      current.fault === 'receipt-reply' ? 1 : 0,
    );
    assert.equal(current.operations.length, operations);
    assert.equal(current.modelCalls, 1);
    await assertEffect();
    await control('finished');
    await cli.close();
    console.log(
      'FG6F ' +
        current.fault +
        ': original=' +
        current.executionCallId +
        ', cold=blocked, effect=once',
    );
  }
  if (proxyFailure) throw proxyFailure;
  await writeFile(configPath + '.results', JSON.stringify(reports));
  console.log('HOSTED_SHELL_OUTPUT_FAULTS_OK');
} catch (cause) {
  console.error('FG6F ' + current.fault, JSON.stringify(current), cli.output);
  throw cause;
} finally {
  await cli.close();
  await model.close();
  proxy.closeAllConnections();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
}
