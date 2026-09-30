/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { arch, platform, release } from 'node:os';
import path from 'node:path';
import { parseSseStream } from '@qwen-code/sdk/daemon';
import { fakeToolCall, startFakeOpenAIServer } from '../fake-openai-server.js';
import { HostedHarnessProcess, waitUntil } from './hosted-harness-process.js';
import {
  compareHostedLatency,
  HOSTED_PROVISIONING_DELAY_MS,
  validateHostedLatency,
  type HostedLatencyMeasurement,
  type HostedLatencySample,
} from './hosted-latency-baseline.js';

const config = JSON.parse(await readFile(process.argv[2], 'utf8')) as {
  tenantId: string;
  storeUrl: string;
  brokerUrl: string;
  database: string;
  runtimeProvisioningDelayMs: number;
  sessions: Array<{
    sessionId: string;
    workspaceId: string;
    directory: string;
    fault: string;
  }>;
};
assert.equal(config.runtimeProvisioningDelayMs, HOSTED_PROVISIONING_DELAY_MS);
assert.deepEqual(config.sessions.map((session) => session.fault).sort(), [
  'no-tool',
  'tool',
]);
const baselinePath = path.resolve(
  'integration-tests/baselines/hosted-latency.json',
);
const reportPath = path.resolve(
  'packages/sdk-java/managed-agent-server/target/hosted-latency-baseline.json',
);
const samples: HostedLatencySample[] = [];
let sample: HostedLatencySample;
let started = 0;
const elapsed = () => performance.now() - started;
let initialMessages: unknown[] = [];
let toolCallId = '';
let contextVerified = false;
const model = await startFakeOpenAIServer(({ body, requestIndex }) => {
  assert.equal(body['model'], 'hosted-fixture');
  assert.equal(body['stream'], true);
  assert.deepEqual(
    (body['tools'] as Array<{ function: { name: string } }>)
      .map((tool) => tool.function.name)
      .sort(),
    ['edit', 'read_file', 'write_file'],
  );
  const messages = body['messages'] as Array<{
    role: string;
    content: unknown;
    tool_calls?: Array<{
      id: string;
      function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
  }>;
  if (sample.scenario === 'no-tool') return { content: 'TEXT_DONE' };
  if (requestIndex === 1) {
    initialMessages = structuredClone(messages);
    assert(JSON.stringify(messages).includes('TOOL_CONTEXT_MARKER'));
    return {
      content: 'Preparing the Workspace file.',
      toolCalls: [
        fakeToolCall(
          'write_file',
          { file_path: 'proof.txt', content: 'latency-proof' },
          toolCallId,
        ),
      ],
    };
  }
  assert.equal(requestIndex, 2, 'exactly one continuation');
  assert.deepEqual(messages.slice(0, initialMessages.length), initialMessages);
  assert.equal(messages.length, initialMessages.length + 2);
  const [assistant, result] = messages.slice(initialMessages.length);
  assert.equal(assistant.role, 'assistant');
  assert.deepEqual(assistant.tool_calls, [
    {
      id: toolCallId,
      type: 'function',
      function: {
        name: 'write_file',
        arguments: JSON.stringify({
          file_path: 'proof.txt',
          content: 'latency-proof',
        }),
      },
    },
  ]);
  assert.equal(result.role, 'tool');
  assert.equal(result.tool_call_id, toolCallId);
  assert.match(JSON.stringify(result.content), /Successfully created/);
  contextVerified = true;
  return { content: 'TOOLS_DONE' };
});

const proxyFailures: unknown[] = [];
const proxy = createServer(async (req, res) => {
  try {
    const route = req.url!;
    const isModel = route.startsWith('/model/');
    const isStore = route.startsWith('/store/');
    const isWarm = route.endsWith('/runtimes:warm');
    const isAcquire = route.endsWith('/tool-sessions:acquire');
    const isStart = route.endsWith(':start');
    const active = sample;
    if (isWarm) {
      assert.equal(
        active.warmRequestedMs,
        -1,
        'one warm request per fresh Workspace',
      );
      active.warmRequestedMs = elapsed();
    }
    if (isAcquire || isStart) {
      assert(
        active.runtimeReadyMs >= 0,
        'Broker use must wait for Runtime readiness',
      );
      const field = isAcquire ? 'acquireMs' : 'executionStartMs';
      assert.equal(active[field], null, 'one acquisition and execution');
      active[field] = elapsed();
    }
    if (isStore) active.storeRequests++;
    const round = { requestMs: elapsed(), firstTextMs: -1, finishedMs: -1 };
    if (isModel) active.modelRounds.push(round);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const target = isModel
      ? model.baseUrl + '/chat/completions'
      : new URL(
          isStore ? route.slice('/store'.length) : route,
          isStore ? config.storeUrl : config.brokerUrl,
        );
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (
        value !== undefined &&
        !['host', 'connection', 'content-length'].includes(key)
      )
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      ...(body.length ? { body } : {}),
      signal: AbortSignal.timeout(45_000),
    });
    assert(
      upstream.ok,
      `${route}: ${upstream.status} ${upstream.ok ? '' : await upstream.text()}`,
    );
    if (isModel) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const text = frame
              .split('\n')
              .find((line) => line.startsWith('data: '))
              ?.slice(6);
            if (!text || text === '[DONE]') continue;
            const data = JSON.parse(text) as {
              choices: Array<{
                delta?: { content?: string };
                finish_reason?: string | null;
              }>;
            };
            for (const choice of data.choices) {
              if (choice.delta?.content && round.firstTextMs < 0)
                round.firstTextMs = elapsed();
              if (choice.finish_reason) round.finishedMs = elapsed();
            }
          }
          res.write(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      res.end();
    } else {
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (isWarm) active.runtimeReadyMs = elapsed();
      res.writeHead(
        upstream.status,
        Object.fromEntries(
          [...upstream.headers].filter(
            ([key]) =>
              ![
                'connection',
                'content-length',
                'content-encoding',
                'transfer-encoding',
              ].includes(key),
          ),
        ),
      );
      res.end(bytes);
    }
  } catch (cause) {
    proxyFailures.push(cause);
    res.destroy(cause instanceof Error ? cause : undefined);
  }
});
const cli = new HostedHarnessProcess();
let clientId = '';
async function json(route: string, body: unknown, expected = 200) {
  const response = await cli.request(route, {
    method: 'POST',
    headers: { ...cli.headers(clientId), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, expected, text);
  return text ? JSON.parse(text) : undefined;
}
try {
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  assert(address && typeof address !== 'string');
  const proxyUrl = `http://127.0.0.1:${address.port}`;
  await cli.start(`${proxyUrl}/model/v1`, {
    extraArgs: [
      '--managed-runtime-broker-url',
      proxyUrl,
      '--managed-runtime-broker-token',
      'hosted-tools-broker-token',
    ],
  });
  for (const session of config.sessions) {
    sample = {
      scenario: session.fault as HostedLatencySample['scenario'],
      warmRequestedMs: -1,
      runtimeReadyMs: -1,
      firstVisibleTextMs: -1,
      turnCompleteMs: -1,
      acquireMs: null,
      executionStartMs: null,
      toolWaitMs: null,
      sameContext: null,
      storeRequests: 0,
      modelRounds: [],
    };
    const created = await json('/session', {
      sessionId: session.sessionId,
      sessionScope: 'thread',
      managedSessionStore: {
        baseUrl: `${proxyUrl}/store`,
        tenantId: config.tenantId,
        workspaceId: session.workspaceId,
        writerId: cli.bootId,
        leaseDurationMs: 60_000,
      },
      toolProfile: 'hosted-workspace-files/1',
    });
    clientId = created.clientId;
    sample.storeRequests = 0;
    const streamAbort = new AbortController();
    const stream = await cli.request(`/session/${session.sessionId}/events`, {
      headers: cli.headers(clientId),
      signal: streamAbort.signal,
    });
    assert.equal(stream.status, 200);
    const promptId = randomUUID();
    toolCallId = `latency-${randomUUID()}`;
    const prompt = [
      {
        type: 'text',
        text: sample.scenario === 'tool' ? 'TOOL_CONTEXT_MARKER' : 'TEXT_ONLY',
      },
    ];
    const timer = setTimeout(() => streamAbort.abort(), 60_000);
    try {
      started = performance.now();
      await json(
        `/session/${session.sessionId}/prompt`,
        {
          promptId,
          prompt,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
        },
        202,
      );
      for await (const event of parseSseStream(
        stream.body!,
        streamAbort.signal,
      )) {
        const envelope = event as {
          promptId?: string;
          type: string;
          data: {
            stopReason?: string;
            update?: { content?: { text?: string } };
          };
        };
        if (envelope.promptId !== promptId) continue;
        assert.notEqual(envelope.type, 'turn_error', JSON.stringify(envelope));
        if (
          envelope.type === 'session_update' &&
          envelope.data.update?.content?.text &&
          sample.firstVisibleTextMs < 0
        )
          sample.firstVisibleTextMs = elapsed();
        if (envelope.type === 'turn_complete') {
          assert.equal(envelope.data.stopReason, 'end_turn');
          sample.turnCompleteMs = elapsed();
          break;
        }
      }
    } finally {
      clearTimeout(timer);
      streamAbort.abort();
    }
    const turnStoreRequests = sample.storeRequests;
    await waitUntil(() => sample.runtimeReadyMs >= 0, 45_000);
    if (sample.scenario === 'tool') {
      sample.toolWaitMs =
        sample.runtimeReadyMs - sample.modelRounds[0].finishedMs;
      sample.sameContext = contextVerified;
      assert.equal(
        await readFile(path.join(session.directory, 'proof.txt'), 'utf8'),
        'latency-proof',
      );
    }
    sample.storeRequests = turnStoreRequests;
    samples.push(structuredClone(sample));
    await json(`/session/${session.sessionId}/detach`, {}, 204);
  }
  assert.deepEqual(proxyFailures, []);
  assert.equal(model.requests.length, 3);
  const measurement: HostedLatencyMeasurement = {
    version: 1,
    provider: 'local-openai-fixture',
    runtimeProvisioningDelayMs: config.runtimeProvisioningDelayMs,
    samples,
  };
  validateHostedLatency(measurement);
  const sources = [
    'integration-tests/helpers/hosted-latency-driver.ts',
    'integration-tests/helpers/hosted-latency-baseline.ts',
    'integration-tests/helpers/hosted-harness-process.ts',
    'integration-tests/fake-openai-server.ts',
    'packages/sdk-java/managed-agent-server/src/test/java/com/alibaba/qwen/code/managedagent/HostedWorkspaceToolTurnIT.java',
  ];
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      sources.map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex'),
      ]),
    ),
  );
  const report = {
    ...measurement,
    capturedAt: new Date().toISOString(),
    gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    workingTreeDirty:
      execFileSync('git', ['status', '--porcelain'], {
        encoding: 'utf8',
      }).trim().length > 0,
    sourceHashes,
    environment: {
      platform: platform(),
      arch: arch(),
      release: release(),
      node: process.version,
      database: config.database,
    },
    notes: [
      'Packaged Hosted private protocol + Spring SQL Session Store + real local-process Broker/worker; two fresh Workspaces, one sample each.',
      'Worker startup sleeps 15000ms before importing the packaged CLI. Timings use one monotonic clock relative to prompt submission; warm response defines readiness.',
      'Model firstTextMs observes the first nonempty provider delta.content at the proxy. firstVisibleTextMs observes committed session_update text over Harness SSE (250ms polling).',
      'toolWaitMs is warm response minus first model stream finish; modelRounds separately measure provider stream time, excluding readiness wait.',
      'Isolated boot-time fixture model configuration; local deterministic OpenAI responses, not real-model latency, published-configuration deployment or public Managed REST latency.',
      'storeRequests counts HTTP requests between prompt submission and observed completion, including SSE reads; no history-growth or cache claim.',
      'Checked-in numbers are descriptive; comparison enforces scenario coverage and ordering, never absolute millisecond thresholds.',
    ],
  };
  const capture = process.env['QWEN_HOSTED_UPDATE_BASELINE'] === '1';
  const comparison = capture
    ? []
    : compareHostedLatency(
        JSON.parse(await readFile(baselinePath, 'utf8')),
        report,
      );
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    JSON.stringify({ ...report, comparison }, null, 2) + '\n',
  );
  if (capture)
    await writeFile(baselinePath, JSON.stringify(report, null, 2) + '\n');
  console.log('HOSTED_LATENCY_OK', JSON.stringify({ samples, comparison }));
} catch (cause) {
  console.error(cli.output, proxyFailures);
  throw cause;
} finally {
  await cli.close();
  await model.close();
  proxy.closeAllConnections();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
}
