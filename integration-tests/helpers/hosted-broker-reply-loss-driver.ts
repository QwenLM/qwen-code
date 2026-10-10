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
type Reply = {
  executionCallId?: string;
  status?: { state: string; result?: { executionStatus: string } };
};
type Exchange = {
  operation: string;
  executionCallId?: string;
  fields: Record<string, unknown>;
  reply: Reply;
};
const cli = new HostedHarnessProcess();
let sessionId = '';
let clientId = '';
let promptId = '';
let fault = '';
let dropped = 0;
let modelCalls = 0;
let proxyFailure: unknown;
let exchanges: Exchange[] = [];

async function json(route: string, body?: unknown, expected = 200) {
  const response = await cli.request(route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...cli.headers(clientId), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.equal(response.status, expected, text + cli.output);
  return text ? JSON.parse(text) : undefined;
}

async function upstream(route: string, body?: Buffer) {
  const response = await fetch(new URL(route, config.brokerUrl), {
    method: body?.length ? 'POST' : 'GET',
    headers: {
      Authorization: 'Bearer hosted-tools-broker-token',
      'Content-Type': 'application/json',
    },
    ...(body?.length ? { body } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `${route}: ${text}`);
  return { text, reply: JSON.parse(text) as Reply };
}

const proxy = createServer(async (req, res) => {
  try {
    const route = new URL(req.url!, config.brokerUrl);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const fields = body.length
      ? (JSON.parse(body.toString()) as Record<string, unknown>)
      : Object.fromEntries(route.searchParams);
    const operation =
      req.method === 'GET' ? 'status' : route.pathname.split(':').at(-1)!;
    const executionCallId = route.pathname.match(/\/executions\/([^/:]+)/)?.[1];
    assert.equal(fields['harnessSessionId'], sessionId);
    assert.equal(fields['runtimeSessionId'], promptId);
    if (fault === 'release-before-forward' && operation === 'release') {
      dropped++;
      exchanges.push({ operation, fields, reply: {} });
      res.destroy();
      return;
    }
    const { text, reply } = await upstream(req.url!, body);
    exchanges.push({ operation, executionCallId, fields, reply });
    if (fault === 'cancel' && operation === 'prepare')
      await json(`/session/${sessionId}/cancel`, {}, 204);
    const lose =
      (operation === fault && dropped === 0) ||
      (fault === 'prepare-twice' && operation === 'prepare');
    if (lose) {
      if (operation === 'status') {
        assert.equal(reply.status?.state, 'executing');
        const released = await fetch(config.statusGateUrl, {
          method: 'POST',
          signal: AbortSignal.timeout(5_000),
        });
        assert.equal(released.status, 204);
        // Observe settlement upstream before hiding the reply from the Harness.
        await waitUntil(
          async () =>
            (await upstream(req.url!)).reply.status?.state === 'settled',
        );
      }
      dropped++;
      res.destroy();
      return;
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
const model = await startFakeOpenAIServer(({ body }) => {
  modelCalls++;
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
  return { content: 'FAULT_TURN_DONE' };
});
const reports: Array<{
  fault: string;
  promptId: string;
  executionCallId?: string;
  idempotencyKey?: unknown;
}> = [];

function input(text: string) {
  const prompt = [{ type: 'text', text }];
  return {
    promptId: randomUUID(),
    prompt,
    payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
  };
}

try {
  await cli.start(model.baseUrl, {
    extraArgs: [
      '--managed-runtime-broker-url',
      `http://127.0.0.1:${address.port}`,
      '--managed-runtime-broker-token',
      'hosted-tools-broker-token',
    ],
  });
  await writeFile(path.join(cli.root, 'proof.txt'), 'decoy');
  for (const session of config.sessions) {
    ({ sessionId, fault } = session);
    dropped = 0;
    modelCalls = 0;
    exchanges = [];
    const connection = {
      baseUrl: config.storeUrl,
      tenantId: config.tenantId,
      workspaceId: session.workspaceId,
      writerId: cli.bootId,
      leaseDurationMs: 60_000,
    };
    const created = await json('/session', {
      sessionId,
      sessionScope: 'thread',
      managedSessionStore: connection,
      toolProfile: 'hosted-workspace-files/1',
    });
    clientId = created.clientId;
    const command = input(fault);
    promptId = command.promptId;
    await json(`/session/${sessionId}/prompt`, command, 202);
    await waitUntil(async () => {
      if (proxyFailure) throw proxyFailure;
      return !(await json(`/session/${sessionId}/status`)).hasActivePrompt;
    });
    assert.equal(
      dropped,
      fault === 'prepare-twice' ? 2 : 1,
      `${fault}: fault did not fire`,
    );
    const blocked = !['prepare', 'start'].includes(fault);
    assert.equal(
      (await json(`/session/${sessionId}/status`)).recoveryBlocked,
      blocked,
      cli.output,
    );
    assert.equal(
      modelCalls,
      ['prepare', 'start', 'release', 'release-before-forward'].includes(fault)
        ? 2
        : 1,
    );
    const events: Array<{
      type: string;
      promptId?: string;
      data: { record?: { type?: string; message?: { parts?: unknown[] } } };
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
    const terminals = events.filter(
      (event) => event.promptId === promptId && event.type.startsWith('turn_'),
    );
    assert.equal(terminals.length, blocked ? 0 : 1, JSON.stringify(events));
    if (!blocked) assert.equal(terminals[0].type, 'turn_complete');
    const results = events.filter(
      (event) => event.data.record?.type === 'tool_result',
    );
    assert.equal(
      results.length,
      modelCalls === 2 ? 1 : 0,
      JSON.stringify(events),
    );
    const prepared = exchanges.filter((entry) => entry.operation === 'prepare');
    assert.equal(
      prepared.length,
      fault === 'acquire' ? 0 : fault.startsWith('prepare') ? 2 : 1,
    );
    const executionCallId = prepared[0]?.reply.executionCallId;
    const idempotencyKey = prepared[0]?.fields['idempotencyKey'];
    if (prepared.length === 2) {
      assert.equal(prepared[1].reply.executionCallId, executionCallId);
      assert.deepEqual(prepared[1].fields, {
        ...prepared[0].fields,
        requestId: prepared[1].fields['requestId'],
      });
    }
    for (const entry of exchanges.filter((entry) => entry.executionCallId)) {
      assert.equal(entry.executionCallId, executionCallId);
      assert.equal(entry.reply.executionCallId, executionCallId);
    }
    const started = !['acquire', 'prepare-twice', 'cancel'].includes(fault);
    assert.equal(
      exchanges.filter((entry) => entry.operation === 'start').length,
      started ? 1 : 0,
    );
    assert.equal(
      exchanges.filter((entry) => entry.operation === 'acquire').length,
      1,
    );
    assert.equal(
      exchanges.filter((entry) => entry.operation === 'release').length,
      modelCalls === 2 ? 1 : 0,
    );
    if (fault === 'start' || fault === 'status')
      assert(exchanges.some((entry) => entry.operation === 'status'));
    if (fault === 'cancel')
      assert.equal(
        exchanges.find((entry) => entry.operation === 'cancel')?.reply.status
          ?.state,
        'settled',
      );
    await waitUntil(
      async () =>
        (await readFile(path.join(session.directory, 'proof.txt'), 'utf8')) ===
        (started ? 'xx' : 'x'),
    );
    assert.equal(
      await readFile(path.join(cli.root, 'proof.txt'), 'utf8'),
      'decoy',
    );
    if (blocked) {
      const rejected = await json(
        `/session/${sessionId}/prompt`,
        input('must remain blocked'),
        409,
      );
      assert.equal(rejected.error, 'hosted_turn_recovery_required');
    }
    const traffic = exchanges.length;
    const callsBeforeReload = modelCalls;
    const retryRelease = ['release', 'release-before-forward'].includes(fault);
    const rejectLoad = blocked && !retryRelease;
    await json(`/session/${sessionId}/detach`, {}, 204);
    const loaded = await json(
      `/session/${sessionId}/load`,
      {
        managedSessionStore: connection,
        toolProfile: 'hosted-workspace-files/1',
      },
      rejectLoad ? 409 : 200,
    );
    if (rejectLoad) assert.equal(loaded.error, 'hosted_turn_recovery_required');
    else {
      clientId = loaded.clientId;
      if (retryRelease) {
        await waitUntil(async () => {
          if (proxyFailure) throw proxyFailure;
          return !(await json(`/session/${sessionId}/status`)).hasActivePrompt;
        });
        assert.equal(
          (await json(`/session/${sessionId}/status`)).recoveryBlocked,
          fault === 'release-before-forward',
          cli.output,
        );
        const page = await json(
          `/session/${sessionId}/transcript?cursor=0&limit=256`,
        );
        assert.equal(page.hasMore, false);
        const recoveredEvents: typeof events = page.events;
        assert.deepEqual(
          recoveredEvents
            .filter(
              (event) =>
                event.promptId === promptId && event.type.startsWith('turn_'),
            )
            .map((event) => event.type),
          fault === 'release' ? ['turn_complete'] : [],
        );
        assert.equal(
          recoveredEvents.filter(
            (event) => event.data.record?.type === 'tool_result',
          ).length,
          1,
        );
      }
      await json(`/session/${sessionId}/detach`, {}, 204);
    }
    assert.deepEqual(
      exchanges.slice(traffic).map((entry) => entry.operation),
      retryRelease ? ['release'] : [],
      'Reload may only retry the original runtime release',
    );
    assert.equal(
      modelCalls,
      callsBeforeReload,
      'Reload must not call the model',
    );
    reports.push({ fault, promptId, executionCallId, idempotencyKey });
    console.log(
      `FG6A ${fault}: drops=${dropped}, modelCalls=${modelCalls}, starts=${started ? 1 : 0}, blocked=${blocked}`,
    );
  }
  await writeFile(`${configPath}.results`, JSON.stringify(reports));
  console.log('HOSTED_REPLY_LOSS_OK');
} catch (cause) {
  console.error(`FG6A ${fault}`, JSON.stringify(exchanges), cli.output);
  throw cause;
} finally {
  await cli.close();
  await model.close();
  proxy.closeAllConnections();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
}
