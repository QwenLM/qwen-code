/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function fixture(change?: string) {
  const requests: string[] = [];
  const result = {
    executionStatus: 'cancelled',
    responseParts: [{ text: 'original preview' }],
    capture: {
      captureStatus: 'unavailable',
      captureReason: 'producer_lost',
      manifest: null,
      previewTruncated: true,
      deliveryStatus: 'blocked',
    },
  };
  const response: Record<string, unknown> = {
    protocolVersion: 1,
    harnessSessionId: 'session',
    runtimeSessionId: 'original-runtime',
    executionCallId: 'original-call',
    runtimeBindingId: 'original-binding',
    bindingGeneration: '7',
    status: { state: 'settled', result },
  };
  if (change === 'harness') response['harnessSessionId'] = 'other';
  if (change === 'runtime') response['runtimeSessionId'] = 'other';
  if (change === 'execution') response['executionCallId'] = 'other';
  if (change === 'binding') response['runtimeBindingId'] = '';
  if (change === 'protocol-version') response['protocolVersion'] = 2;
  if (change === 'non-string-generation') response['bindingGeneration'] = 7;
  if (change === 'zero-generation') response['bindingGeneration'] = '0';
  if (change === 'overflow')
    response['bindingGeneration'] = '9223372036854775808';
  if (change === 'executing')
    response['status'] = { state: 'executing', result };
  if (change === 'missing-result') response['status'] = { state: 'settled' };
  if (change === 'malformed-legacy-status')
    response['status'] = {
      state: 'settled',
      result: { executionStatus: ['cancelled'], responseParts: [] },
    };
  server = createServer((request, reply) => {
    const url = new URL(request.url!, 'http://127.0.0.1');
    requests.push(`${request.method} ${url.pathname}`);
    expect(url.searchParams.get('harnessSessionId')).toBe('session');
    expect(url.searchParams.get('runtimeSessionId')).toBe('original-runtime');
    reply.writeHead(change === 'unknown' ? 409 : 200, {
      'Content-Type': 'application/json',
    });
    reply.end(
      JSON.stringify(
        change === 'unknown'
          ? { code: 'runtime_broker_execution_unknown' }
          : response,
      ),
    );
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const broker = new HostedWorkspaceBroker(
    {
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token: 'test-only',
    },
    { tenantId: 'tenant', workspaceId: 'workspace', sessionId: 'session' },
    'original-runtime',
  );
  return { broker, requests, result };
}

it('reads the original settled Shell result without preparing or starting work', async () => {
  const { broker, requests, result } = await fixture();
  await expect(broker.readSettledShellResult('original-call')).resolves.toEqual(
    {
      bindingGeneration: '7',
      result,
    },
  );
  expect(requests).toEqual([
    'GET /internal/runtime-broker/v1/executions/original-call',
  ]);
  expect(broker.runtime).toBeUndefined();
});

it.each([
  'harness',
  'runtime',
  'execution',
  'binding',
  'protocol-version',
  'non-string-generation',
  'zero-generation',
  'overflow',
  'executing',
  'missing-result',
  'malformed-legacy-status',
  'unknown',
])('refuses recovered Shell evidence with %s', async (change) => {
  const { broker, requests } = await fixture(change);
  await expect(
    broker.readSettledShellResult('original-call'),
  ).rejects.toThrow();
  expect(requests).toEqual([
    'GET /internal/runtime-broker/v1/executions/original-call',
  ]);
});
