/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/* global fetch, AbortSignal */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL, URL, URLSearchParams } from 'node:url';
import { parseArgs } from 'node:util';

export function signedHeaders(
  method,
  url,
  body,
  key,
  tenant,
  actor,
  requestKey,
) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const canonical = [
    'qwen-broker-auth-v1',
    method,
    url.pathname,
    url.search.slice(1),
    tenant,
    actor,
    timestamp,
    createHash('sha256').update(body).digest('hex'),
    requestKey ?? '',
  ].join('\n');
  return {
    'Content-Type': 'application/json',
    'X-Qwen-Tenant-Id': tenant,
    'X-Qwen-Actor-Id': actor,
    'X-Qwen-Signature-Timestamp': timestamp,
    'X-Qwen-Signature': `v1=${createHmac('sha256', key).update(canonical).digest('hex')}`,
    ...(requestKey ? { 'Idempotency-Key': requestKey } : {}),
  };
}

export async function runSmoke({
  baseUrl,
  signingKey,
  tenant = 'k8s-smoke',
  actor = 'operator',
  sessionId,
  keepSession = false,
  timeoutMs = 120_000,
}) {
  const base = new URL(baseUrl);
  assert(
    ['http:', 'https:'].includes(base.protocol),
    'Use an HTTP(S) API URL.',
  );
  assert(
    !base.username && !base.password,
    'URL credentials are not supported.',
  );
  assert(
    Buffer.byteLength(signingKey) >= 32,
    'The signing key must have at least 32 bytes.',
  );
  assert(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
    'Timeout must be a positive integer.',
  );
  const deadline = Date.now() + timeoutMs;
  const signal = () => {
    assert(Date.now() < deadline, 'Smoke timed out.');
    return AbortSignal.timeout(Math.min(10_000, deadline - Date.now()));
  };
  const request = async (method, path, value) => {
    const url = new URL(path, base);
    const body = value === undefined ? '' : JSON.stringify(value);
    const key = method === 'GET' ? undefined : randomUUID();
    const response = await fetch(url, {
      method,
      headers: signedHeaders(method, url, body, signingKey, tenant, actor, key),
      ...(body ? { body } : {}),
      redirect: 'error',
      signal: signal(),
    });
    assert(response.ok, `${method} ${path}: HTTP ${response.status}`);
    return response.json();
  };
  const wait = async (path) => {
    while (true) {
      const result = await request('GET', path);
      if (result.status === 'completed') return result;
      assert(
        ['accepted', 'pending', 'running', 'cancelling'].includes(
          result.status,
        ),
        `Operation ${result.status}: ${result.error_code ?? result.failure_code ?? 'no error code'}`,
      );
      await setTimeout(Math.min(1000, Math.max(0, deadline - Date.now())));
    }
  };
  const historyContains = async (path, predicate) => {
    let cursor;
    do {
      const query = new URLSearchParams({ limit: '100' });
      if (cursor) query.set('cursor', cursor);
      const items = await request('GET', `${path}/items?${query}`);
      if (items.data.some(predicate)) return true;
      cursor = items.has_more ? items.next_cursor : undefined;
    } while (cursor);
    return false;
  };

  const unsigned = await fetch(new URL('/v1/agents/sessions', base), {
    headers: { 'X-Qwen-Tenant-Id': tenant },
    redirect: 'error',
    signal: signal(),
  });
  assert.equal(unsigned.status, 401, 'Unsigned requests must be refused.');
  await unsigned.body?.cancel();

  try {
    if (sessionId) {
      assert(
        await historyContains(
          `/v1/agents/sessions/${sessionId}`,
          (item) => item.role === 'assistant',
        ),
        'Previous assistant history is missing.',
      );
    } else {
      const created = await request('POST', '/v1/agents/sessions', {
        agent_id: 'qwen-code',
      });
      sessionId = created.id;
      assert(sessionId, 'Session creation returned no ID.');
    }
    const path = `/v1/agents/sessions/${sessionId}`;
    const marker = `K8S_SMOKE_${randomUUID().replaceAll('-', '')}`;
    const input = await request('POST', `${path}/events`, {
      type: 'agent.session.input.message',
      input: [{ type: 'input_text', text: `Reply with exactly ${marker}.` }],
    });
    assert(input.turn_id, 'Input admission returned no Turn ID.');
    await wait(`${path}/turns/${input.turn_id}`);
    assert(
      await historyContains(
        path,
        (item) =>
          item.role === 'assistant' &&
          item.content?.some(
            (part) =>
              part.type === 'output_text' && part.text?.includes(marker),
          ),
      ),
      'Assistant history does not contain the smoke response.',
    );
    if (!keepSession) {
      const operation = await request('POST', `${path}/close`);
      assert(operation.id, 'Close admission returned no operation ID.');
      await wait(`${path}/operations/${operation.id}`);
      const closed = await request('GET', path);
      assert.equal(closed.status, 'closed');
    }
    return {
      sessionId,
      turnId: input.turn_id,
      status: 'completed',
      closed: !keepSession,
    };
  } catch (error) {
    throw new Error(
      `Smoke failed (Session ${sessionId ?? 'not created'}): ${error.message}`,
      { cause: error },
    );
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      url: { type: 'string', default: 'http://127.0.0.1:8080' },
      'key-file': { type: 'string' },
      tenant: { type: 'string', default: 'k8s-smoke' },
      actor: { type: 'string', default: 'operator' },
      'session-id': { type: 'string' },
      'keep-session': { type: 'boolean', default: false },
      'timeout-ms': { type: 'string', default: '120000' },
    },
  });
  assert(
    values['key-file'],
    'Pass --key-file pointing to the auth-signing-key.',
  );
  const signingKey = await readFile(values['key-file'], 'utf8');
  const result = await runSmoke({
    baseUrl: values.url,
    signingKey,
    tenant: values.tenant,
    actor: values.actor,
    sessionId: values['session-id'],
    keepSession: values['keep-session'],
    timeoutMs: Number(values['timeout-ms']),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
