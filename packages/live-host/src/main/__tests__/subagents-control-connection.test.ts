import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { WebSocketServer } from 'ws';
import { MAX_SUBAGENTS_CONTROL_BYTES } from '@qwen-code/qwen-live/subagents';
import { LiveDaemonConnection } from '../daemon-connection.ts';
import {
  LIVE_PROTOCOL_VERSION,
  parseDaemonControlMessage,
} from '../../shared/protocol.ts';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task();
});

const nonce = 'subagents_fixture_instance';
const page = {
  type: 'page',
  page: {
    offset: 0,
    total: 0,
    snapshot: {
      revision: 0,
      counts: {
        running: 0,
        completed: 0,
        needsAttention: 0,
        failed: 0,
        cancelled: 0,
        interrupted: 0,
      },
      tasks: [],
      omitted: 0,
    },
  },
};
const welcome = {
  type: 'host.welcome',
  protocolVersion: LIVE_PROTOCOL_VERSION,
  daemonInstanceNonce: nonce,
  heartbeatIntervalMs: 10_000,
  epoch: 0,
  status: { v: 1, available: true, state: 'idle', shortcut: 'Command+E' },
};

async function fixture(
  options: {
    capability?: boolean;
    handleRequest?: (
      request: IncomingMessage,
      response: ServerResponse,
    ) => void;
  } = {},
) {
  const directory = await mkdtemp(
    join(tmpdir(), 'qwen-live-subagent-controls-'),
  );
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const requests: IncomingMessage[] = [];
  const server = createServer((request, response) => {
    requests.push(request);
    if (options.handleRequest) options.handleRequest(request, response);
    else
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(page));
  });
  const peers = new WebSocketServer({ server });
  cleanup.push(async () => {
    for (const peer of peers.clients) peer.terminate();
    peers.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const discovery = join(directory, 'daemon.json');
  await writeFile(
    discovery,
    JSON.stringify({
      url: `http://127.0.0.1:${address.port}`,
      token: 'management-token',
      protocolVersion: LIVE_PROTOCOL_VERSION,
      pid: process.pid,
      instanceNonce: nonce,
    }),
    { mode: 0o600 },
  );
  peers.on('connection', (peer) =>
    peer.once('message', () => {
      peer.send(
        JSON.stringify({
          ...welcome,
          ...(options.capability !== false ? { subagentsControlV1: true } : {}),
        }),
      );
    }),
  );
  let ready!: () => void;
  const waiting = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const connection = new LiveDaemonConnection(
    '0.0.6',
    {
      getReadiness: () => ({
        permissions: {
          microphone: 'denied',
          camera: 'denied',
          accessibility: 'denied',
          screenRecording: 'denied',
        },
        selfChecks: {
          audioInput: false,
          audioOutput: false,
          appshot: false,
          globalShortcut: false,
        },
      }),
      onSnapshot: (snapshot) => {
        if (snapshot.phase === 'ready') ready();
      },
      onOutputAudio: () => {},
      onOutputAudioFinished: () => {},
      onClearOutput: () => {},
    },
    discovery,
  );
  cleanup.push(() => connection.stop());
  connection.start();
  await waiting;
  return { connection, requests };
}

describe('standalone subagent management transport', () => {
  it('uses nonce-authenticated daemon management while the call is idle', async () => {
    const value = await fixture();
    assert.equal(value.connection.getSnapshot().subagentsControlV1, true);
    assert.deepEqual(
      await value.connection.requestSubagents({ action: 'list' }, nonce),
      page,
    );
    assert.equal(value.requests.length, 1);
    assert.equal(value.requests[0]?.method, 'POST');
    assert.equal(value.requests[0]?.url, '/live/subagents');
    assert.equal(
      value.requests[0]?.headers.authorization,
      'Bearer management-token',
    );
    assert.equal(value.requests[0]?.headers['x-qwen-live-nonce'], nonce);
  });

  it('rejects old renderer instance IDs and unsupported daemons before HTTP dispatch', async () => {
    const value = await fixture();
    assert.deepEqual(
      await value.connection.requestSubagents(
        { action: 'stop', taskId: 'harness:job_1' },
        'old_instance',
      ),
      { type: 'error', code: 'stale_instance' },
    );
    assert.equal(value.requests.length, 0);
    const legacy = await fixture({ capability: false });
    assert.deepEqual(
      await legacy.connection.requestSubagents({ action: 'list' }, nonce),
      { type: 'error', code: 'unsupported' },
    );
    assert.equal(legacy.requests.length, 0);
  });

  it('drops in-flight results when the authenticated connection changes', async () => {
    let received!: () => void;
    const arrived = new Promise<void>((resolve) => {
      received = resolve;
    });
    let reply!: () => void;
    const value = await fixture({
      handleRequest: (_request, response) => {
        reply = () => response.writeHead(200).end(JSON.stringify(page));
        received();
      },
    });
    const pending = value.connection.requestSubagents(
      { action: 'list' },
      nonce,
    );
    await arrived;
    value.connection.stop();
    reply();
    assert.deepEqual(await pending, { type: 'error', code: 'stale_instance' });
  });

  it('rejects oversized streamed responses and invalid outcomes', async () => {
    for (const body of [
      JSON.stringify({ type: 'outcome', outcome: 'stopped' }),
      'x'.repeat(MAX_SUBAGENTS_CONTROL_BYTES + 1),
    ]) {
      const value = await fixture({
        handleRequest: (_request, response) => {
          response.writeHead(200, { 'transfer-encoding': 'chunked' });
          response.write(body.slice(0, body.length / 2));
          response.end(body.slice(body.length / 2));
        },
      });
      assert.deepEqual(
        await value.connection.requestSubagents({ action: 'list' }, nonce),
        { type: 'error', code: 'action_failed' },
      );
    }
  });

  it('preserves owned errors and distinguishes nonce rejection', async () => {
    const denied = await fixture({
      handleRequest: (_request, response) =>
        response
          .writeHead(200)
          .end(
            JSON.stringify({ type: 'error', code: 'permission_unavailable' }),
          ),
    });
    assert.deepEqual(
      await denied.connection.requestSubagents(
        { action: 'permission', requestHandle: 'req_1', decision: 'allow' },
        nonce,
      ),
      { type: 'error', code: 'permission_unavailable' },
    );
    const stale = await fixture({
      handleRequest: (_request, response) => response.writeHead(409).end(),
    });
    assert.deepEqual(
      await stale.connection.requestSubagents({ action: 'list' }, nonce),
      { type: 'error', code: 'stale_instance' },
    );
  });

  it('rejects a well-formed result belonging to another task or permission decision', async () => {
    const wrongTask = await fixture({
      handleRequest: (_request, response) =>
        response
          .writeHead(200)
          .end(
            JSON.stringify({
              type: 'outcome',
              outcome: 'stopped',
              taskId: 'harness:job_2',
            }),
          ),
    });
    assert.deepEqual(
      await wrongTask.connection.requestSubagents(
        { action: 'stop', taskId: 'harness:job_1' },
        nonce,
      ),
      { type: 'error', code: 'action_failed' },
    );
    const wrongDecision = await fixture({
      handleRequest: (_request, response) =>
        response
          .writeHead(200)
          .end(
            JSON.stringify({
              type: 'outcome',
              outcome: 'denied',
              requestHandle: 'req_1',
            }),
          ),
    });
    assert.deepEqual(
      await wrongDecision.connection.requestSubagents(
        { action: 'permission', requestHandle: 'req_1', decision: 'allow' },
        nonce,
      ),
      { type: 'error', code: 'action_failed' },
    );
  });

  it('accepts an optional true capability but rejects malformed capability values', () => {
    assert(parseDaemonControlMessage(JSON.stringify(welcome)));
    assert.deepEqual(
      parseDaemonControlMessage(
        JSON.stringify({ ...welcome, subagentsControlV1: true }),
      )?.type,
      'host.welcome',
    );
    for (const subagentsControlV1 of [false, 'true', 1])
      assert.equal(
        parseDaemonControlMessage(
          JSON.stringify({ ...welcome, subagentsControlV1 }),
        ),
        undefined,
      );
  });
});
