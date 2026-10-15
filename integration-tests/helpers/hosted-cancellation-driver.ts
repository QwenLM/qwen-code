/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readFile, unlink, writeFile } from 'node:fs/promises';
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
const reports: Array<{
  fault: string;
  promptId: string;
  executionCallId: string;
  idempotencyKey: string;
}> = [];
let cli = new HostedHarnessProcess();
let sessionId = '';
let clientId = '';
let promptId = '';
let fault = '';
let proof = '';
let executionCallId = '';
let idempotencyKey = '';
let modelCalls = 0;
let cancels = 0;
let injected = false;
let statusHeld = false;
let resumeStatus = () => {};
let operations: string[] = [];
let proxyFailure: unknown;
const blocked = () => ['status-unavailable', 'cancel-reply'].includes(fault);

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

async function evidence(phase: string) {
  const url = new URL(
    `/cancellation/${sessionId}/${phase}`,
    config.statusGateUrl,
  );
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

async function enteredTool() {
  await waitUntil(() => existsSync(`${proof}.read-entered`));
  assert((await lstat(proof)).isFile());
  assert.equal(await readFile(proof, 'utf8'), 'x');
  await evidence('entered');
}

const proxy = createServer(async (req, res) => {
  try {
    const url = new URL(req.url!, config.brokerUrl);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const fields = body.length
      ? JSON.parse(body.toString())
      : Object.fromEntries(url.searchParams);
    const operation =
      req.method === 'GET' ? 'status' : url.pathname.split(':').at(-1)!;
    assert.equal(fields.harnessSessionId, sessionId);
    assert.equal(fields.runtimeSessionId, promptId);
    const id = url.pathname.match(/\/executions\/([^/:]+)/)?.[1];
    if (id) assert.equal(id, executionCallId);
    operations.push(operation);
    if (operation === 'start') {
      assert.notEqual(
        fault,
        'prepared',
        'Cancelled reservation must not start',
      );
      await writeFile(`${proof}.read-gate`, '');
    }
    if (operation === 'release') {
      assert.equal(
        blocked(),
        false,
        'Unconfirmed cancellation must retain its owner',
      );
      await evidence('release');
    }
    const upstream = await fetch(url, {
      method: req.method,
      headers: {
        Authorization: 'Bearer hosted-tools-broker-token',
        'Content-Type': 'application/json',
      },
      ...(body.length ? { body } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await upstream.text();
    assert.equal(upstream.status, 200, text);
    const reply = JSON.parse(text);
    if (id) assert.equal(reply.executionCallId, executionCallId);
    if (operation === 'prepare') {
      assert.equal(executionCallId, '');
      executionCallId = reply.executionCallId;
      idempotencyKey = fields.idempotencyKey;
      assert.equal(reply.status.state, 'prepared');
      await evidence('prepared');
      if (fault === 'prepared')
        await json(`/session/${sessionId}/cancel`, {}, 204);
    }
    if (operation === 'start') {
      assert.equal(reply.status.state, 'executing');
      await enteredTool();
      await json(`/session/${sessionId}/cancel`, {}, 204);
    }
    if (operation === 'cancel') {
      cancels++;
      assert.equal(
        reply.status.state,
        fault === 'prepared' ? 'settled' : 'cancel_requested',
      );
      if (fault === 'prepared')
        assert.equal(reply.status.result.executionStatus, 'cancelled');
      if (fault === 'cancel-reply' && cancels === 1) {
        injected = true;
        res.destroy();
        return;
      }
    }
    if (operation === 'status' && !injected) {
      assert(cancels > 0, 'Status must follow the real cancellation');
      assert.equal(reply.status.state, 'cancel_requested');
      if (fault === 'status-unavailable') {
        injected = true;
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'fg6d_status_unavailable' }));
        return;
      }
      assert.equal(fault, 'running');
      injected = true;
      await new Promise<void>((resolve) => {
        resumeStatus = resolve;
        statusHeld = true;
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(text);
  } catch (cause) {
    proxyFailure = cause;
    res.destroy();
  }
});
await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const address = proxy.address();
assert(address && typeof address !== 'string');
const proxyUrl = `http://127.0.0.1:${address.port}`;
const model = await startFakeOpenAIServer(() => {
  modelCalls++;
  assert.equal(modelCalls, 1, 'Cancellation must not continue inference');
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

async function transcript(terminal: boolean) {
  const events: Array<{
    type: string;
    promptId?: string;
    data: {
      stopReason?: string;
      record?: { type?: string };
    };
  }> = [];
  let cursor = '0';
  while (true) {
    const page = await json(
      `/session/${sessionId}/transcript?cursor=${cursor}&limit=256`,
    );
    events.push(...page.events);
    if (!page.hasMore) break;
    cursor = page.nextCursor;
  }
  const ends = events.filter((event) => event.type.startsWith('turn_'));
  assert.equal(ends.length, terminal ? 1 : 0, JSON.stringify(events));
  if (terminal) {
    assert.equal(ends[0].promptId, promptId);
    assert.equal(ends[0].type, 'turn_complete');
    assert.equal(ends[0].data.stopReason, 'cancelled');
  }
  assert.equal(
    events.filter((event) => event.data.record?.type === 'tool_result').length,
    terminal ? 1 : 0,
  );
}

function input(text: string) {
  const prompt = [{ type: 'text', text }];
  return {
    promptId: randomUUID(),
    prompt,
    payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
  };
}

try {
  for (const session of config.sessions) {
    ({ sessionId, fault } = session);
    proof = path.join(session.directory, 'proof.txt');
    executionCallId = '';
    idempotencyKey = '';
    modelCalls = 0;
    cancels = 0;
    injected = false;
    statusHeld = false;
    operations = [];
    await start();
    const connection = () => ({
      managedSessionStore: {
        baseUrl: config.storeUrl,
        tenantId: config.tenantId,
        workspaceId: session.workspaceId,
        writerId: cli.bootId,
        leaseDurationMs: 60_000,
      },
      toolProfile: 'hosted-workspace-files/1',
    });
    const created = await json('/session', {
      ...connection(),
      sessionId,
      sessionScope: 'thread',
    });
    clientId = created.clientId;
    const command = input(fault);
    promptId = command.promptId;
    await json(`/session/${sessionId}/prompt`, command, 202);
    if (fault === 'running') {
      await waitUntil(async () => {
        const status = await json(`/session/${sessionId}/status`);
        assert.equal(
          status.hasActivePrompt,
          true,
          'Cancel ACK must not finish a running tool',
        );
        return statusHeld;
      });
    } else if (blocked()) {
      await waitUntil(
        async () =>
          !(await json(`/session/${sessionId}/status`)).hasActivePrompt,
      );
      assert.equal(
        (await json(`/session/${sessionId}/status`)).recoveryBlocked,
        true,
      );
      assert.equal(injected, true);
    }
    if (fault !== 'prepared') {
      await evidence('pending');
      await transcript(false);
      assert((await lstat(proof)).isFile());
      assert.equal(await readFile(proof, 'utf8'), 'x');
      await unlink(`${proof}.read-gate`);
      resumeStatus();
      await waitUntil(
        async () => (await evidence('state')).state === 'SETTLED',
      );
    }
    await waitUntil(
      async () => !(await json(`/session/${sessionId}/status`)).hasActivePrompt,
    );
    assert.equal(
      (await json(`/session/${sessionId}/status`)).recoveryBlocked,
      blocked(),
    );
    await transcript(!blocked());
    await evidence('finished');
    assert.equal(modelCalls, 1);
    assert.equal(cancels, blocked() ? 2 : 1);
    for (const [operation, count] of [
      ['acquire', 1],
      ['prepare', 1],
      ['start', fault === 'prepared' ? 0 : 1],
      ['release', blocked() ? 0 : 1],
    ] as const)
      assert.equal(
        operations.filter((value) => value === operation).length,
        count,
      );
    assert.equal(
      await readFile(proof, 'utf8'),
      fault === 'prepared' ? 'x' : 'xx',
    );
    assert.equal(
      await readFile(path.join(cli.root, 'proof.txt'), 'utf8'),
      'decoy',
    );
    if (blocked()) {
      const rejected = await json(
        `/session/${sessionId}/prompt`,
        input('must remain blocked'),
        409,
      );
      assert.equal(rejected.error, 'hosted_turn_recovery_required');
    }
    const traffic = operations.length;
    const boot = cli.bootId;
    await json(`/session/${sessionId}/detach`, {}, 204);
    await cli.close();
    cli = new HostedHarnessProcess();
    await start();
    assert.notEqual(cli.bootId, boot);
    const loaded = await json(
      `/session/${sessionId}/load`,
      connection(),
      blocked() ? 409 : 200,
    );
    if (blocked()) assert.equal(loaded.error, 'hosted_turn_recovery_required');
    else {
      clientId = loaded.clientId;
      await transcript(true);
      await json(`/session/${sessionId}/detach`, {}, 204);
    }
    assert.equal(
      operations.length,
      traffic,
      'Cold load must not contact Broker',
    );
    assert.equal(modelCalls, 1, 'Cold load must not contact model');
    assert.equal(
      await readFile(proof, 'utf8'),
      fault === 'prepared' ? 'x' : 'xx',
    );
    await cli.close();
    cli = new HostedHarnessProcess();
    reports.push({ fault, promptId, executionCallId, idempotencyKey });
    console.log(
      `FG6D ${fault}: execution=${executionCallId}, cancels=${cancels}, blocked=${blocked()}, cold=${blocked() ? 'blocked' : 'loaded'}`,
    );
  }
  await writeFile(`${configPath}.results`, JSON.stringify(reports));
  console.log('HOSTED_CANCELLATION_OK');
} catch (cause) {
  console.error(`FG6D ${fault}`, JSON.stringify(operations), cli.output);
  throw cause;
} finally {
  resumeStatus();
  await cli.close();
  await model.close();
  proxy.closeAllConnections();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
}
