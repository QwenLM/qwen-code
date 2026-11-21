/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import { runSmoke, signedHeaders } from './smoke.mjs';

const signingKey = 'fixture-signing-key-with-at-least-thirty-two-bytes';

async function apiPeer(
  t,
  {
    output = true,
    turnStatus = 'completed',
    unsignedStatus = 401,
    key = signingKey,
    paginated = false,
    retainedOnNextPage = false,
  } = {},
) {
  const state = {
    inputs: 0,
    closed: false,
    signatureErrors: 0,
    marker: '',
    itemCursors: [],
  };
  const peer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const url = new URL(request.url, 'http://fixture');
    const headers = request.headers;
    const send = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (!headers['x-qwen-signature']) return send(unsignedStatus, {});
    const canonical = `qwen-broker-auth-v1\n${request.method}\n${url.pathname}\n${url.search.slice(1)}\n${headers['x-qwen-tenant-id']}\n${headers['x-qwen-actor-id']}\n${headers['x-qwen-signature-timestamp']}\n${createHash('sha256').update(body).digest('hex')}\n${headers['idempotency-key'] ?? ''}`;
    if (
      headers['x-qwen-signature'] !==
        `v1=${createHmac('sha256', key).update(canonical).digest('hex')}` ||
      headers['x-qwen-tenant-id'] !== 'k8s-smoke' ||
      headers['x-qwen-actor-id'] !== 'operator' ||
      (request.method === 'POST' && !headers['idempotency-key'])
    ) {
      state.signatureErrors++;
      return send(401, {});
    }
    const root = '/v1/agents/sessions';
    if (request.method === 'POST' && url.pathname === root) {
      assert.deepEqual(JSON.parse(body), { agent_id: 'qwen-code' });
      return send(202, { id: 'session-1' });
    }
    if (
      request.method === 'POST' &&
      url.pathname === `${root}/session-1/events`
    ) {
      state.inputs++;
      const input = JSON.parse(body);
      assert.equal(input.type, 'agent.session.input.message');
      state.marker = input.input[0].text.match(/K8S_SMOKE_[a-f0-9]+/)[0];
      return send(202, { turn_id: 'turn-1' });
    }
    if (url.pathname === `${root}/session-1/turns/turn-1`) {
      return send(200, { status: turnStatus, error_code: 'fixture_failure' });
    }
    if (url.pathname === `${root}/session-1/items`) {
      const cursor = url.searchParams.get('cursor');
      state.itemCursors.push(cursor);
      if (paginated && !cursor) {
        return send(200, {
          data: Array.from({ length: 100 }, () => ({
            role: retainedOnNextPage ? 'user' : 'assistant',
            content: [{ type: 'output_text', text: 'old response' }],
          })),
          has_more: true,
          next_cursor: 'snapshot/+first=',
        });
      }
      if (paginated) assert.equal(cursor, 'snapshot/+first=');
      return send(200, {
        data: [
          {
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: output ? state.marker : 'old response',
              },
            ],
          },
        ],
        has_more: false,
      });
    }
    if (
      request.method === 'POST' &&
      url.pathname === `${root}/session-1/close`
    ) {
      state.closed = true;
      return send(202, { id: 'close-1' });
    }
    if (url.pathname === `${root}/session-1/operations/close-1`) {
      return send(200, { status: 'completed' });
    }
    if (url.pathname === `${root}/session-1`) {
      return send(200, { status: state.closed ? 'closed' : 'active' });
    }
    send(404, {});
  });
  await new Promise((ready) => peer.listen(0, '127.0.0.1', ready));
  t.after(async () => {
    peer.closeAllConnections();
    await new Promise((done) => peer.close(done));
  });
  return {
    state,
    baseUrl: `http://127.0.0.1:${peer.address().port}`,
    signingKey: key,
  };
}

test('signs UTF-8 body, raw query and idempotency key in the Java canonical order', () => {
  const url = new URL('https://api.example/v1/agents/sessions?q=a%20b');
  const body = '{"text":"你好"}';
  const headers = signedHeaders(
    'POST',
    url,
    body,
    signingKey,
    'tenant',
    'actor',
    'request-1',
  );
  const canonical = [
    'qwen-broker-auth-v1',
    'POST',
    '/v1/agents/sessions',
    'q=a%20b',
    'tenant',
    'actor',
    headers['X-Qwen-Signature-Timestamp'],
    createHash('sha256').update(body).digest('hex'),
    'request-1',
  ].join('\n');
  assert.equal(
    headers['X-Qwen-Signature'],
    `v1=${createHmac('sha256', signingKey).update(canonical).digest('hex')}`,
  );
});

test('smoke requires authenticated completion and history, then closes', async (t) => {
  const fixture = await apiPeer(t);
  const result = await runSmoke(fixture);
  assert.deepEqual(result, {
    sessionId: 'session-1',
    turnId: 'turn-1',
    status: 'completed',
    closed: true,
  });
  assert.equal(fixture.state.inputs, 1);
  assert.equal(fixture.state.closed, true);
  assert.equal(fixture.state.signatureErrors, 0);
});

test('CLI preserves trailing whitespace in operator-managed signing keys', async (t) => {
  const key = `${signingKey}\n `;
  const fixture = await apiPeer(t, { key });
  const temporary = await mkdtemp(join(tmpdir(), 'qwen-smoke-key-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const keyFile = join(temporary, 'signing-key');
  await writeFile(keyFile, key, { mode: 0o600 });
  const { stdout } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('./smoke.mjs', import.meta.url)),
    '--url',
    fixture.baseUrl,
    '--key-file',
    keyFile,
  ]);
  assert.equal(JSON.parse(stdout).closed, true);
  assert.equal(fixture.state.signatureErrors, 0);
});

test('idle restart workflow preserves the Session until explicitly resumed', async (t) => {
  const fixture = await apiPeer(t);
  const kept = await runSmoke({ ...fixture, keepSession: true });
  assert.equal(kept.closed, false);
  assert.equal(fixture.state.closed, false);
  const resumed = await runSmoke({ ...fixture, sessionId: kept.sessionId });
  assert.equal(resumed.closed, true);
  assert.equal(fixture.state.inputs, 2);
});

test('a completed Turn with missing model output cannot pass', async (t) => {
  const fixture = await apiPeer(t, { output: false });
  await assert.rejects(
    runSmoke(fixture),
    /Session session-1.*does not contain/,
  );
  assert.equal(fixture.state.closed, false);
});

test('a reused long Session follows signed history cursors to the new output', async (t) => {
  const fixture = await apiPeer(t, { paginated: true });
  const result = await runSmoke({ ...fixture, sessionId: 'session-1' });
  assert.equal(result.closed, true);
  assert.deepEqual(fixture.state.itemCursors, [null, null, 'snapshot/+first=']);
  assert.equal(fixture.state.inputs, 1);
  assert.equal(fixture.state.signatureErrors, 0);
});

test('exhausted history pages without the new marker still fail', async (t) => {
  const fixture = await apiPeer(t, { paginated: true, output: false });
  await assert.rejects(
    runSmoke({ ...fixture, sessionId: 'session-1' }),
    /does not contain the smoke response/,
  );
  assert.equal(fixture.state.inputs, 1);
  assert.equal(fixture.state.closed, false);
  assert.equal(fixture.state.signatureErrors, 0);
});

test('reused history can start with a full page without an assistant', async (t) => {
  const fixture = await apiPeer(t, {
    paginated: true,
    retainedOnNextPage: true,
  });
  const result = await runSmoke({ ...fixture, sessionId: 'session-1' });
  assert.equal(result.closed, true);
  assert.deepEqual(fixture.state.itemCursors, [
    null,
    'snapshot/+first=',
    null,
    'snapshot/+first=',
  ]);
  assert.equal(fixture.state.inputs, 1);
  assert.equal(fixture.state.signatureErrors, 0);
});

test('uncertain execution fails without replaying input or closing the Session', async (t) => {
  const fixture = await apiPeer(t, { turnStatus: 'recovery_blocked' });
  await assert.rejects(runSmoke(fixture), /recovery_blocked: fixture_failure/);
  assert.equal(fixture.state.inputs, 1);
  assert.equal(fixture.state.closed, false);
});

test('an unsigned deployment is refused before creating any Session', async (t) => {
  const fixture = await apiPeer(t, { unsignedStatus: 200 });
  await assert.rejects(runSmoke(fixture), /Unsigned requests must be refused/);
  assert.equal(fixture.state.inputs, 0);
});
