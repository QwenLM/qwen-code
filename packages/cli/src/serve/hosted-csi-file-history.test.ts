/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { requestHostedCsiHistory } from './hosted-csi-file-history.js';

const fixture = JSON.parse(
  readFileSync(
    new URL(
      './contracts/managed-csi-file-history-v1.fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const key = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  sessionId: fixture.request.identity.sessionId as string,
};
const broker = { baseUrl: 'http://127.0.0.1:8080', token: 'owned-token' };
const operation = {
  kind: 'csi-file-history',
  version: 1,
  action: 'snapshot',
} as const;
const headers = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
};
function body() {
  return {
    protocolVersion: 1,
    harnessSessionId: key.sessionId,
    runtimeSessionId: key.sessionId,
    result: {
      ...structuredClone(fixture.request),
      observation: structuredClone(fixture.valid[1].observation),
    },
  };
}

afterEach(() => vi.restoreAllMocks());

it('fetches the original owner with exact credentials and validates the retained history', async () => {
  const response = body();
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(response), { headers }));
  await expect(
    requestHostedCsiHistory(broker, key, operation),
  ).resolves.toEqual(fixture.valid[1].observation);
  const [url, options] = fetch.mock.calls[0];
  expect(String(url)).toBe(
    `${broker.baseUrl}/internal/runtime-broker/v1/tool-sessions/${key.sessionId}/control`,
  );
  expect(options).toMatchObject({
    method: 'POST',
    redirect: 'error',
    headers: {
      Authorization: 'Bearer owned-token',
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
  expect(JSON.parse(String(options!.body))).toEqual({
    protocolVersion: 1,
    requestId: expect.any(String),
    harnessSessionId: key.sessionId,
    operation,
  });
});

it.each([
  'status',
  'cache',
  'type',
  'encoding',
  'missing-body',
  'oversized',
  'malformed',
  'duplicate-key',
])('refuses a %s HTTP response', async (fault) => {
  let wire = JSON.stringify(body());
  let expected = 'Original CSI history bind failed.';
  const responseHeaders: Record<string, string> = { ...headers };
  if (fault === 'cache') delete responseHeaders['cache-control'];
  if (fault === 'type') responseHeaders['content-type'] = 'text/plain';
  if (fault === 'encoding') responseHeaders['content-encoding'] = 'gzip';
  if (fault === 'missing-body') expected = 'Missing CSI history response.';
  if (fault === 'oversized') {
    wire = 'x'.repeat(65 * 1024 + 1);
    expected = 'CSI history response is too large.';
  }
  if (fault === 'malformed') {
    wire = '{';
    expected = 'record is not valid JSON.';
  }
  if (fault === 'duplicate-key') {
    wire = wire.replace(
      '"protocolVersion":1',
      '"protocolVersion":1,"protocolVersion":1',
    );
    expected = 'record has the duplicate JSON key';
  }
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(fault === 'missing-body' ? null : wire, {
      status: fault === 'status' ? 401 : 200,
      headers: responseHeaders,
    }),
  );
  await expect(requestHostedCsiHistory(broker, key, operation)).rejects.toThrow(
    expected,
  );
});

it.each([
  'outer-keyset',
  'inner-keyset',
  'owner',
  'runtime-owner',
  'operation',
  'scope',
  'context',
  'observation',
])('refuses %s drift in an otherwise valid response', async (fault) => {
  const response = body();
  let expected = 'Invalid CSI history response.';
  if (fault === 'outer-keyset') Object.assign(response, { extra: true });
  if (fault === 'inner-keyset') response.result.extra = true;
  if (fault === 'owner') {
    response.harnessSessionId = 'foreign';
    expected = 'CSI history owner differs.';
  }
  if (fault === 'runtime-owner') {
    response.runtimeSessionId = 'foreign';
    expected = 'CSI history owner differs.';
  }
  if (fault === 'operation') {
    response.result.operation.action = 'bind';
    expected = 'CSI history response differs.';
  }
  if (fault === 'scope') expected = 'CSI history scope differs.';
  if (fault === 'context') {
    response.result.installedContext.contextDigest = `sha256:${'0'.repeat(64)}`;
    expected = 'Invalid private CSI native readback.';
  }
  if (fault === 'observation') {
    response.result.observation.state.ownerSessionId = 'foreign';
    expected = 'Hosted file history owner conflicts.';
  }
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(response), { headers }),
  );
  await expect(
    requestHostedCsiHistory(
      broker,
      fault === 'scope' ? { ...key, workspaceId: 'foreign' } : key,
      operation,
    ),
  ).rejects.toThrow(expected);
});
