/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIHandler,
} from '../fake-openai-server.js';
import { HostedHarnessProcess, waitUntil } from './hosted-harness-process.js';

const config = JSON.parse(await readFile(process.argv[2], 'utf8')) as {
  tenantId: string;
  storeUrl: string;
  brokerUrl: string;
  resultFile: string;
  coldLoadUrl: string;
  secondarySessionId: string;
  sessions: Array<{
    sessionId: string;
    workspaceId: string;
    directory: string;
    toolProfile: string;
  }>;
};
const starts = new Map<string, number>();
let releaseWarm!: () => void;
const warmGate = new Promise<void>((resolve) => {
  releaseWarm = resolve;
});
let warmPending = false;
let loseStatus = false;
let droppedStart = false;
let shellProfile = false;
let shellFault: 'storage' | 'raw' | undefined;
let publisherTarget = '';
let rawReplyDropped = false;
const rawWrites = new Map<string, number>();
const durableReceipts: Array<Record<string, unknown>> = [];
const shellExpected: Array<Record<string, unknown>> = [];
const captureDiagnostics: unknown[] = [];
async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function bytes(req: import('node:http').IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
// Hop-by-hop headers describe the upstream connection, not this proxy's.
// Relaying Spring's `Keep-Alive: timeout=60` let the daemon's fetch pool reuse
// a socket this server had just closed at its own 5 s idle timeout, and the
// cold load's parallel resource reads failed with "other side closed".
function endToEndHeaders(headers: Headers) {
  const hop = new Set([
    'connection',
    'keep-alive',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    ...(headers.get('connection') ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  ]);
  return Object.fromEntries([...headers].filter(([name]) => !hop.has(name)));
}
const publisherRelay = createServer(async (req, res) => {
  try {
    const payload = await bytes(req);
    const body = JSON.parse(payload.toString());
    const response = await fetch(publisherTarget, {
      method: 'POST',
      headers: {
        Authorization: req.headers.authorization!,
        'Content-Type': 'application/json',
      },
      body: payload,
      signal: AbortSignal.timeout(30000),
    });
    const output = await response.text();
    if (body.operation === 'write') {
      const key = `${body.executionCallId}:${body.stream}:${body.offset}`;
      rawWrites.set(key, (rawWrites.get(key) ?? 0) + 1);
      if (!rawReplyDropped && response.ok) {
        rawReplyDropped = true;
        res.destroy();
        return;
      }
    }
    res.writeHead(response.status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(output);
  } catch (cause) {
    res.writeHead(503);
    res.end(String(cause));
  }
});
const publisherRelayUrl = await listen(publisherRelay);
const storeProxy = createServer(async (req, res) => {
  try {
    const payload = await bytes(req);
    const body = payload.length ? JSON.parse(payload.toString()) : undefined;
    if (
      shellFault === 'storage' &&
      req.url?.endsWith('/tool-results:publish') &&
      body.kind === 'managed-tool-result-content'
    ) {
      res.writeHead(503, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(
        JSON.stringify({
          error: {
            code: 'injected_storage_failure',
            message: 'injected failure',
          },
        }),
      );
      return;
    }
    const response = await fetch(new URL(req.url!, config.storeUrl), {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'X-Qwen-Tenant-Id': String(req.headers['x-qwen-tenant-id']),
        'X-Qwen-Managed-Writer-Token': String(
          req.headers['x-qwen-managed-writer-token'],
        ),
      },
      ...(payload.length ? { body: payload } : {}),
      signal: AbortSignal.timeout(30000),
    });
    const output = Buffer.from(await response.arrayBuffer());
    if (
      response.ok &&
      req.url?.endsWith('/tool-results:publish') &&
      body.kind === 'managed-tool-result-manifest'
    ) {
      const manifest = JSON.parse(
        Buffer.from(body.bytesBase64, 'base64').toString(),
      );
      captureDiagnostics.push({
        sessionId: manifest.sessionId,
        executionStatus: manifest.executionStatus,
        captureStatus: manifest.captureStatus,
        captureReason: manifest.captureReason,
        contents: manifest.contents.map(
          (stream: {
            streamId: string;
            byteLength: number;
            state: string;
          }) => ({
            streamId: stream.streamId,
            byteLength: stream.byteLength,
            state: stream.state,
          }),
        ),
      });
    }
    if (response.ok && req.url?.endsWith('/transactions:commit')) {
      for (const line of Buffer.from(body.recordBytesBase64, 'base64')
        .toString()
        .trim()
        .split('\n')) {
        const record = JSON.parse(line);
        if (record.managedSession?.kind === 'tool.receipt')
          durableReceipts.push(record.managedSession);
      }
    }
    res.writeHead(response.status, endToEndHeaders(response.headers));
    res.end(output);
  } catch (cause) {
    res.writeHead(503);
    res.end(String(cause));
  }
});
const storeProxyUrl = await listen(storeProxy);
const proxy = createServer(async (req, res) => {
  try {
    if (req.url?.endsWith('/runtimes:warm')) {
      warmPending = true;
      await warmGate;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    let body = Buffer.concat(chunks);
    if (shellFault === 'raw' && req.url?.endsWith(':publisher')) {
      const registration = JSON.parse(body.toString());
      publisherTarget = registration.publisher.url;
      registration.publisher.url =
        publisherRelayUrl + '/internal/hosted-shell-publisher/v1';
      body = Buffer.from(JSON.stringify(registration));
    }
    const isStart = req.url?.endsWith(':start');
    if (isStart) starts.set(req.url!, (starts.get(req.url!) ?? 0) + 1);
    const response = await fetch(new URL(req.url!, config.brokerUrl), {
      method: req.method,
      headers: {
        Authorization: 'Bearer hosted-tools-broker-token',
        'Content-Type': 'application/json',
      },
      ...(body.length ? { body } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok)
      console.error(`Broker ${req.url}: ${response.status} ${text}`);
    if (isStart && !droppedStart) {
      droppedStart = true;
      res.destroy();
      return;
    }
    if (loseStatus && (isStart || req.method === 'GET')) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'runtime_broker_execution_unknown' }));
    } else {
      res.writeHead(response.status, { 'Content-Type': 'application/json' });
      res.end(text);
    }
  } catch (cause) {
    res.writeHead(503);
    res.end(String(cause));
  }
});
await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const address = proxy.address();
assert(address && typeof address !== 'string');
let current = 'TEXT_ONLY';
let modelCalls = 0;
const modelReply: FakeOpenAIHandler = ({ body }) => {
  modelCalls++;
  const tools = body['tools'] as Array<{ function: { name: string } }>;
  assert.deepEqual(tools.map((tool) => tool.function.name).sort(), [
    'edit',
    'read_file',
    ...(shellProfile ? ['run_shell_command'] : []),
    'write_file',
  ]);
  const messages = body['messages'] as Array<{
    role: string;
    content: unknown;
    tool_call_id?: string;
    tool_calls?: Array<{ id: string }>;
  }>;
  const lastPrompt = messages.findLastIndex(
    (message) =>
      message.role === 'user' &&
      JSON.stringify(message.content).includes(current),
  );
  assert(lastPrompt >= 0);
  const receipts = messages
    .slice(lastPrompt + 1)
    .filter((message) => message.role === 'tool');
  if (current.startsWith('SHELL_') && current !== 'SHELL_REFUSAL') {
    const reloaded =
      current === 'SHELL_RELOADED' || current === 'SHELL_RESTARTED';
    const callId =
      current === 'SHELL_RESTARTED'
        ? 'shell-restarted-proof'
        : reloaded
          ? 'shell-reloaded-proof'
          : 'shell-proof';
    if (!receipts.length) {
      const producer = reloaded
        ? "require('fs').appendFileSync('shell-reloaded.txt','x'); console.log('RELOADED_OK');"
        : current === 'SHELL_CANCEL'
          ? "require('fs').appendFileSync('shell-once.txt','x'); setInterval(()=>process.stdout.write('running\\n'),20);"
          : "require('fs').appendFileSync('shell-once.txt','x'); (async()=>{await new Promise(r=>process.stdout.write(process.cwd()+'\\n',r)); const b=Buffer.alloc(1024*1024,0x91); for(let i=0;i<100;i++) await new Promise(r=>process.stdout.write(b,r)); await new Promise(r=>process.stdout.write('stdout-tail\\0',r)); process.stderr.write('stderr-tail\\0');})().catch(e=>{console.error(e);process.exitCode=1});";
      const quote = (text: string) =>
        "'" + text.replaceAll("'", "'\"'\"'") + "'";
      return {
        toolCalls: [
          fakeToolCall(
            'run_shell_command',
            {
              command: `${quote(process.execPath)} -e ${quote(producer)}`,
              timeout: 180000,
            },
            callId,
          ),
        ],
      };
    }
    assert(
      current === 'SHELL_LARGE' || reloaded,
      'A failed/cancelled Shell started another inference',
    );
    assert.equal(receipts.length, 1);
    assert(
      durableReceipts.some(
        (receipt) =>
          (receipt['sessionKey'] as { sessionId: string }).sessionId ===
            sessionId &&
          !!(receipt['payload'] as Record<string, unknown>)['resultRef'],
      ),
      'Inference preceded durable admission',
    );
    assert.equal(receipts[0].tool_call_id, callId);
    if (reloaded) {
      assert.match(JSON.stringify(receipts[0].content), /RELOADED_OK/);
      return { content: 'SHELL_DONE' };
    }
    assert.match(
      JSON.stringify(receipts[0].content),
      /Shell execution: success.*Output preview is truncated/s,
    );
    assert.doesNotMatch(
      JSON.stringify(receipts[0].content),
      /full output has been saved to|use the read_file tool with the absolute file path/,
    );
    assert(Buffer.byteLength(JSON.stringify(receipts[0].content)) < 64 * 1024);
    return { content: 'SHELL_DONE' };
  }
  if (current === 'HISTORY_FILES') {
    if (!receipts.length)
      return {
        toolCalls: [
          fakeToolCall(
            'write_file',
            { file_path: 'history-existing.txt', content: 'middle' },
            'history-existing',
          ),
          fakeToolCall(
            'write_file',
            { file_path: 'history-new.txt', content: 'created' },
            'history-new',
          ),
        ],
      };
    if (receipts.length === 2)
      return {
        toolCalls: [
          fakeToolCall(
            'edit',
            {
              file_path: 'history-existing.txt',
              old_string: 'middle',
              new_string: 'final',
            },
            'history-edit',
          ),
        ],
      };
    assert.equal(receipts.length, 3);
    return { content: 'HISTORY_FILES_DONE' };
  }
  if (current.startsWith('RUN_TOOLS')) {
    if (!receipts.length)
      return {
        content: 'Preparing the Workspace file.',
        toolCalls: [
          fakeToolCall(
            'write_file',
            { file_path: 'proof.txt', content: 'before' },
            'write-proof',
          ),
        ],
      };
    if (receipts.length === 1)
      return {
        toolCalls: [
          fakeToolCall('read_file', { file_path: 'proof.txt' }, 'read-proof'),
          fakeToolCall(
            'edit',
            {
              file_path: 'proof.txt',
              old_string: 'before',
              new_string: 'after',
            },
            'edit-proof',
          ),
        ],
      };
    assert.deepEqual(
      receipts.map((message) => message.tool_call_id),
      ['write-proof', 'read-proof', 'edit-proof'],
    );
    assert.match(JSON.stringify(receipts[0].content), /Successfully created/);
    assert.match(JSON.stringify(receipts[1].content), /before/);
    assert.match(
      JSON.stringify(receipts[2].content),
      /has been updated.*after/s,
    );
    return { content: 'TOOLS_DONE', reasoning: 'PRIVATE_REASONING_MARKER' };
  }
  if (current === 'INVALID_FILE_PATH') {
    if (!receipts.length)
      return {
        toolCalls: [
          fakeToolCall(
            'read_file',
            { file_path: path.join(config.sessions[0].directory, 'proof.txt') },
            'invalid-read',
          ),
          fakeToolCall(
            'write_file',
            { file_path: 'skipped.txt', content: 'must not run' },
            'skipped-write',
          ),
        ],
      };
    if (receipts.length === 2) {
      assert.deepEqual(
        receipts.map((message) => message.tool_call_id),
        ['invalid-read', 'skipped-write'],
      );
      assert.match(JSON.stringify(receipts[0].content), /file_path/);
      assert.doesNotMatch(JSON.stringify(receipts[0].content), /cwdRelative/);
      assert(
        !JSON.stringify(receipts[0].content).includes(
          config.sessions[0].directory,
        ),
        'The refusal echoed the model-provided absolute path',
      );
      assert.match(JSON.stringify(receipts[1].content), /not executed/);
      assert(
        !existsSync(path.join(config.sessions[0].directory, 'skipped.txt')),
        'The valid sibling ran before the model could correct the batch',
      );
      return {
        toolCalls: [
          fakeToolCall(
            'write_file',
            { file_path: 'corrected.txt', content: 'once' },
            'corrected-write',
          ),
        ],
      };
    }
    assert.deepEqual(
      receipts.map((message) => message.tool_call_id),
      ['invalid-read', 'skipped-write', 'corrected-write'],
    );
    assert.match(JSON.stringify(receipts[2].content), /Successfully created/);
    return { content: 'CORRECTED_OK' };
  }
  if (current === 'HISTORY_AFTER_INVALID') {
    const previousCalls = messages.flatMap((message) =>
      (message.tool_calls ?? []).map((call) => call.id),
    );
    const previousReceipts = messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.tool_call_id);
    assert.deepEqual(previousCalls.slice(-3), [
      'invalid-read',
      'skipped-write',
      'corrected-write',
    ]);
    assert.deepEqual(previousReceipts.slice(-3), previousCalls.slice(-3));
    return { content: 'HISTORY_OK' };
  }
  if (current === 'SECOND_SESSION_FILE') {
    if (!receipts.length)
      return {
        toolCalls: [
          fakeToolCall(
            'read_file',
            { file_path: 'corrected.txt' },
            'second-read',
          ),
        ],
      };
    assert.equal(receipts[0].tool_call_id, 'second-read');
    assert.match(JSON.stringify(receipts[0].content), /once/);
    return { content: 'SECOND_SESSION_OK' };
  }
  if (current === 'SHELL_REFUSAL')
    return {
      toolCalls: [
        fakeToolCall('run_shell_command', { command: 'touch refused-shell' }),
      ],
    };
  if (current === 'UNKNOWN_WRITE')
    return {
      toolCalls: [
        fakeToolCall('write_file', {
          file_path: 'unknown.txt',
          content: 'one effect',
        }),
      ],
    };
  if (current === 'HISTORY_CHECK') {
    const previousCalls = messages
      .flatMap((message) => message.tool_calls ?? [])
      .map((call) => call.id);
    const previousReceipts = messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.tool_call_id);
    assert.deepEqual(previousReceipts, previousCalls);
    assert.equal(previousReceipts.length, 3);
  }
  return { content: 'TEXT_DONE' };
};
const model = await startFakeOpenAIServer((request) => {
  try {
    return modelReply(request);
  } catch (cause) {
    console.error('Hosted fake-model assertion:', cause);
    throw cause;
  }
});
let cli = new HostedHarnessProcess();
let sessionId = '';
let clientId = '';
async function javaLoad(expected = 200) {
  const response = await fetch(config.coldLoadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      harnessUrl: cli.baseUrl,
      storeUrl: storeProxyUrl,
    }),
  });
  const body = await response.text();
  assert.equal(response.status, expected, body);
  return JSON.parse(body) as { clientId: string; code?: string };
}

async function damageSeal(manifestResourceId: string, damage: boolean) {
  const response = await fetch(config.coldLoadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, manifestResourceId, damage }),
  });
  assert.equal(response.status, 200, await response.text());
}

async function json(
  route: string,
  body?: unknown,
  expected = 200,
  method = body === undefined ? 'GET' : 'POST',
) {
  const response = await cli.request(route, {
    method,
    headers: { ...cli.headers(clientId), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.equal(response.status, expected, text);
  return text ? JSON.parse(text) : undefined;
}
async function prompt(text: string, expectedState = 'end_turn') {
  current = text;
  const blocks = [{ type: 'text', text }];
  const promptId = randomUUID();
  await json(
    `/session/${sessionId}/prompt`,
    {
      promptId,
      prompt: blocks,
      payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(blocks)).digest('hex')}`,
    },
    202,
  );
  if (text === 'SHELL_CANCEL') {
    const session = config.sessions.find(
      (entry) => entry.sessionId === sessionId,
    )!;
    await waitUntil(async () =>
      access(path.join(session.directory, 'shell-once.txt')).then(
        () => true,
        () => false,
      ),
    );
    await json(`/session/${sessionId}/cancel`, {}, 204);
  }
  await waitUntil(
    async () => !(await json(`/session/${sessionId}/status`)).hasActivePrompt,
    shellProfile ? 180000 : 30000,
  );
  const status = await json(`/session/${sessionId}/status`);
  assert.equal(
    status.recoveryBlocked,
    expectedState === 'blocked',
    JSON.stringify(captureDiagnostics) + '\n' + cli.output,
  );
  const events: Array<{
    type: string;
    promptId?: string;
    data: {
      stopReason?: string;
      record?: {
        message?: {
          parts?: Array<{
            functionCall?: { id?: string };
            functionResponse?: { id?: string };
          }>;
        };
      };
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
  const terminal = events.filter(
    (event) => event.promptId === promptId && event.type.startsWith('turn_'),
  );
  if (expectedState === 'blocked') assert.equal(terminal.length, 0);
  else {
    assert.equal(terminal.length, 1, JSON.stringify(events) + cli.output);
    assert.equal(
      terminal[0].type,
      expectedState === 'error' ? 'turn_error' : 'turn_complete',
      cli.output,
    );
    if (expectedState !== 'error')
      assert.equal(terminal[0].data.stopReason, expectedState);
  }
  return events;
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
  for (const [index, session] of config.sessions.entries()) {
    sessionId = session.sessionId;
    shellProfile = session.toolProfile === 'hosted-workspace-shell/1';
    const connection = {
      baseUrl: storeProxyUrl,
      tenantId: config.tenantId,
      workspaceId: session.workspaceId,
      writerId: cli.bootId,
      leaseDurationMs: 60_000,
    };
    const created = await json('/session', {
      sessionId,
      sessionScope: 'thread',
      managedSessionStore: connection,
      toolProfile: session.toolProfile,
    });
    clientId = created.clientId;
    if (shellProfile) {
      loseStatus = false;
      if (index === 2) {
        await prompt('TEXT_BEFORE_SHELL_RELOAD');
        await json(`/session/${sessionId}/detach`, {}, 204);
        const loaded = await json(`/session/${sessionId}/load`, {
          managedSessionStore: connection,
          toolProfile: session.toolProfile,
        });
        clientId = loaded.clientId;
      }
      const scenario =
        index === 2
          ? 'SHELL_LARGE'
          : index === 3
            ? 'SHELL_STORAGE'
            : index === 4
              ? 'SHELL_RAW'
              : 'SHELL_CANCEL';
      shellFault = index === 3 ? 'storage' : index === 4 ? 'raw' : undefined;
      if (index === 2) droppedStart = false;
      const before = modelCalls;
      const shellEvents = await prompt(
        scenario,
        index === 2 ? 'end_turn' : index === 5 ? 'cancelled' : 'blocked',
      );
      assert.equal(
        await readFile(path.join(session.directory, 'shell-once.txt'), 'utf8'),
        'x',
      );
      await assert.rejects(access(path.join(cli.root, 'shell-once.txt')));
      assert.equal(modelCalls, before + (index === 2 ? 2 : 1));
      if (index === 2) {
        assert.match(
          JSON.stringify(shellEvents),
          /"deliveryStatus":"committed"/,
        );
        const receipt = durableReceipts.find(
          (receipt) =>
            (receipt['sessionKey'] as { sessionId: string }).sessionId ===
            sessionId,
        )!;
        const expected = createHash('sha256').update(session.directory + '\n');
        const unit = Buffer.alloc(1024 * 1024, 0x91);
        for (let n = 0; n < 100; n++) expected.update(unit);
        expected.update('stdout-tail\0');
        shellExpected.push({
          sessionKey: {
            tenantId: config.tenantId,
            workspaceId: session.workspaceId,
            sessionId,
          },
          executionCallId: (receipt['payload'] as Record<string, unknown>)[
            'executionCallId'
          ],
          turnId: shellEvents.findLast(
            (event) => event.type === 'turn_complete',
          )?.promptId,
          manifestRef: (receipt['payload'] as Record<string, unknown>)[
            'resultRef'
          ],
          stdoutBytes:
            Buffer.byteLength(session.directory + '\n') +
            100 * 1024 * 1024 +
            12,
          stdoutDigest: expected.digest('hex'),
          stderrDigest: createHash('sha256')
            .update('stderr-tail\0')
            .digest('hex'),
        });
        await json(`/session/${sessionId}/title`, {
          title: 'Restored Shell Workspace',
        });
        await json(`/session/${sessionId}/detach`, {}, 204);
        const loaded = await javaLoad();
        clientId = loaded.clientId;
        await prompt('SHELL_RELOADED');
        assert.equal(
          await readFile(
            path.join(session.directory, 'shell-reloaded.txt'),
            'utf8',
          ),
          'x',
        );
        if (index === 2) {
          const receipt = durableReceipts.findLast(
            (entry) =>
              (entry.sessionKey as { sessionId: string }).sessionId ===
              sessionId,
          )!;
          const manifest = (
            receipt.payload as { resultRef: { resourceId: string } }
          ).resultRef;
          await json(`/session/${sessionId}/detach`, {}, 204);
          const before = starts.size;
          const beforeModel = modelCalls;
          await damageSeal(manifest.resourceId, true);
          try {
            assert.equal(
              (await javaLoad(409)).code,
              'hosted_turn_recovery_required',
            );
            assert.equal(starts.size, before);
            assert.equal(modelCalls, beforeModel);
          } finally {
            await damageSeal(manifest.resourceId, false);
          }
          const previousBoot = cli.bootId;
          await cli.close();
          cli = new HostedHarnessProcess();
          await cli.start(model.baseUrl, {
            extraArgs: [
              '--managed-runtime-broker-url',
              `http://127.0.0.1:${address.port}`,
              '--managed-runtime-broker-token',
              'hosted-tools-broker-token',
            ],
          });
          assert.notEqual(cli.bootId, previousBoot);
          connection.writerId = cli.bootId;
          clientId = (await javaLoad()).clientId;
          assert.equal(starts.size, before);
          assert.equal(modelCalls, beforeModel);
          assert.equal(
            await readFile(
              path.join(session.directory, 'shell-reloaded.txt'),
              'utf8',
            ),
            'x',
          );
          await prompt('SHELL_RESTARTED');
          assert.equal(starts.size, before + 1);
          assert.equal(modelCalls, beforeModel + 2);
          assert.equal(
            await readFile(
              path.join(session.directory, 'shell-reloaded.txt'),
              'utf8',
            ),
            'xx',
          );
          await assert.rejects(
            access(path.join(cli.root, 'shell-reloaded.txt')),
          );
        }
        await prompt('TEXT_AFTER_SHELL_RELOAD');
      }
      if (index === 4) {
        assert(rawReplyDropped);
        assert([...rawWrites.values()].every((count) => count === 1));
      }
      if (index === 5) await prompt('TEXT_AFTER_CANCEL');
      await json(`/session/${sessionId}/detach`, {}, 204);
      shellFault = undefined;
      continue;
    }
    if (index === 0) {
      await prompt('TEXT_ONLY');
      assert(warmPending, 'Warmup was not started alongside inference');
      assert.equal(starts.size, 0);
      releaseWarm();
    }
    const toolEvents = await prompt(`RUN_TOOLS_${index}`);
    const replayParts = toolEvents.flatMap(
      (event) => event.data.record?.message?.parts ?? [],
    );
    const replayCalls = replayParts.flatMap((part) =>
      part.functionCall ? [part.functionCall.id] : [],
    );
    assert.deepEqual(replayCalls, ['write-proof', 'read-proof', 'edit-proof']);
    assert.deepEqual(
      replayParts.flatMap((part) =>
        part.functionResponse ? [part.functionResponse.id] : [],
      ),
      replayCalls,
    );
    assert(
      !JSON.stringify(
        toolEvents.filter((event) => event.type === 'session_update'),
      ).includes('PRIVATE_REASONING_MARKER'),
    );
    assert.equal(
      await readFile(path.join(session.directory, 'proof.txt'), 'utf8'),
      'after',
    );
    assert.equal(
      await readFile(path.join(cli.root, 'proof.txt'), 'utf8'),
      'decoy',
    );
    await prompt('SHELL_REFUSAL', 'error');
    await json(`/session/${sessionId}/title`, {
      title: 'Restored File Workspace',
    });
    await json(`/session/${sessionId}/detach`, {}, 204);
    const loaded = await javaLoad();
    clientId = loaded.clientId;
    await prompt('HISTORY_CHECK');
    if (index === 0) {
      const before = starts.size;
      const refusedEvents = await prompt('INVALID_FILE_PATH');
      const refusedParts = refusedEvents.flatMap(
        (event) => event.data.record?.message?.parts ?? [],
      );
      const callIds = refusedParts.flatMap((part) =>
        part.functionCall ? [part.functionCall.id] : [],
      );
      assert.deepEqual(callIds.slice(-3), [
        'invalid-read',
        'skipped-write',
        'corrected-write',
      ]);
      assert.deepEqual(
        refusedParts
          .flatMap((part) =>
            part.functionResponse ? [part.functionResponse.id] : [],
          )
          .slice(-3),
        callIds.slice(-3),
      );
      assert.equal(starts.size, before + 1);
      assert.equal(
        await readFile(path.join(session.directory, 'corrected.txt'), 'utf8'),
        'once',
      );
      await assert.rejects(access(path.join(session.directory, 'skipped.txt')));
      await json(`/session/${sessionId}/detach`, {}, 204);
      const reloaded = await json(`/session/${sessionId}/load`, {
        managedSessionStore: connection,
        toolProfile: session.toolProfile,
      });
      clientId = reloaded.clientId;
      await prompt('HISTORY_AFTER_INVALID');

      const originalSessionId = sessionId;
      const originalClientId = clientId;
      sessionId = config.secondarySessionId;
      const secondary = await json('/session', {
        sessionId,
        sessionScope: 'thread',
        managedSessionStore: connection,
        toolProfile: session.toolProfile,
      });
      clientId = secondary.clientId;
      await prompt('SECOND_SESSION_FILE');
      await json(`/session/${sessionId}/detach`, {}, 204);
      sessionId = originalSessionId;
      clientId = originalClientId;
    }
    await writeFile(
      path.join(session.directory, 'history-existing.txt'),
      'original',
    );
    const historyEvents = await prompt('HISTORY_FILES');
    const targetPrompt = historyEvents
      .filter((event) => event.type === 'turn_complete')
      .at(-1)!.promptId;
    assert.equal(
      await readFile(
        path.join(session.directory, 'history-existing.txt'),
        'utf8',
      ),
      'final',
    );
    const history = await json(`/session/${sessionId}/files/history`);
    assert.equal(history.history.pendingTurn, null);
    assert.equal(
      history.history.state.snapshots.filter(
        (snapshot: { promptId: string }) => snapshot.promptId === targetPrompt,
      ).length,
      1,
    );
    await json(`/session/${sessionId}/detach`, {}, 204);
    clientId = (
      await json(`/session/${sessionId}/load`, {
        managedSessionStore: connection,
        toolProfile: session.toolProfile,
      })
    ).clientId;
    assert.deepEqual(
      (await json(`/session/${sessionId}/files/history`)).history,
      history.history,
    );
    await writeFile(
      path.join(session.directory, 'history-existing.txt'),
      'external',
    );
    const conflictRequest = { promptId: targetPrompt, requestId: randomUUID() };
    const conflict = await json(
      `/session/${sessionId}/files/rewind`,
      conflictRequest,
      409,
    );
    assert.equal(conflict.conflict, true);
    assert.equal(
      await readFile(path.join(session.directory, 'history-new.txt'), 'utf8'),
      'created',
    );
    await writeFile(
      path.join(session.directory, 'history-existing.txt'),
      'final',
    );
    const undoRequest = { promptId: targetPrompt, requestId: randomUUID() };
    const undone = await json(
      `/session/${sessionId}/files/rewind`,
      undoRequest,
    );
    assert.equal(undone.conflict, false);
    assert.equal(
      await readFile(
        path.join(session.directory, 'history-existing.txt'),
        'utf8',
      ),
      'original',
    );
    await assert.rejects(
      access(path.join(session.directory, 'history-new.txt')),
    );
    assert.deepEqual(
      await json(`/session/${sessionId}/files/rewind`, undoRequest),
      undone,
    );
    assert.deepEqual(
      await json(`/session/${sessionId}/files/rewind`, conflictRequest, 409),
      conflict,
    );
    const repeatedUndo = await json(`/session/${sessionId}/files/rewind`, {
      promptId: targetPrompt,
      requestId: randomUUID(),
    });
    assert.deepEqual(repeatedUndo.filesChanged, []);
    assert.deepEqual(
      await json(`/session/${sessionId}/files/rewind`, undoRequest),
      undone,
    );
    assert.equal(
      await readFile(path.join(cli.root, 'proof.txt'), 'utf8'),
      'decoy',
    );
    if (index === 1) {
      loseStatus = true;
      const before = modelCalls;
      await prompt('UNKNOWN_WRITE', 'blocked');
      assert.equal(modelCalls, before + 1);
      const blocks = [{ type: 'text', text: 'must stay blocked' }];
      await json(
        `/session/${sessionId}/prompt`,
        {
          promptId: randomUUID(),
          prompt: blocks,
          payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(blocks)).digest('hex')}`,
        },
        409,
      );
      await json(`/session/${sessionId}/detach`, {}, 204);
      await json(
        `/session/${sessionId}/load`,
        {
          managedSessionStore: connection,
          toolProfile: session.toolProfile,
        },
        409,
      );
    } else await json(`/session/${sessionId}/detach`, {}, 204);
  }
  assert(droppedStart);
  assert.equal(starts.size, 21);
  assert.equal(shellExpected.length, 1);
  await writeFile(
    config.resultFile,
    JSON.stringify({ storeUrl: config.storeUrl, outputs: shellExpected }),
  );
  assert([...starts.values()].every((count) => count === 1));
  console.log(
    'HOSTED_WORKSPACE_TOOLS_OK: six Workspaces, correctable file_path refusal, same-Workspace second Session, parallel warmup, file replay, durable backups, reload/undo/conflict checks, 100 MiB Shell, Java cold load without profile, Harness process restart, damaged durable empty Shell seal refusal, Shell after text/Shell reload, lost start ACK, publication faults, cancellation, at-most-once effects',
  );
} catch (cause) {
  console.error(cli.output);
  throw cause;
} finally {
  releaseWarm();
  await cli.close();
  await model.close();
  for (const server of [storeProxy, publisherRelay]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  proxy.closeAllConnections();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
}
