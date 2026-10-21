/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { probePreAuthHostGateRejection } from './preAuthHostGateProbe.js';

describe('probePreAuthHostGateRejection', () => {
  const INVALID_HOST_BODY = JSON.stringify({ error: 'Invalid Host header' });

  let server: http.Server;
  let baseUrl: string;
  let lastReceivedHost: string | undefined;
  let status = 403;
  let body = INVALID_HOST_BODY;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      lastReceivedHost = req.headers.host;
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(body);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('reports a rejection when the gate answers 403 Invalid Host header', async () => {
    await expect(
      probePreAuthHostGateRejection(baseUrl, 'localhost:52100'),
    ).resolves.toBe(true);
  });

  it('sends the forwarded authority as the Host header', async () => {
    // The mechanism: the gate must see the exact authority the webview's
    // browser will send, or its answer says nothing about the browser path.
    await probePreAuthHostGateRejection(baseUrl, 'localhost:52100');
    expect(lastReceivedHost).toBe('localhost:52100');
  });

  it('ignores the same body under a non-403 status', async () => {
    // Pins the status guard on its own: delete the `!== 403` check and this
    // — not any body-mismatch case — must go red.
    status = 401;
    try {
      await expect(
        probePreAuthHostGateRejection(baseUrl, 'localhost:52100'),
      ).resolves.toBe(false);
    } finally {
      status = 403;
    }
  });

  it('ignores a 403 with a different body', async () => {
    body = JSON.stringify({ error: 'Request denied by CORS policy' });
    try {
      await expect(
        probePreAuthHostGateRejection(baseUrl, 'localhost:52100'),
      ).resolves.toBe(false);
    } finally {
      body = INVALID_HOST_BODY;
    }
  });

  it('ignores a healthy 200', async () => {
    status = 200;
    body = JSON.stringify({ status: 'ok' });
    try {
      await expect(
        probePreAuthHostGateRejection(baseUrl, 'localhost:52100'),
      ).resolves.toBe(false);
    } finally {
      status = 403;
      body = INVALID_HOST_BODY;
    }
  });

  it('resolves false fast against an unreachable port', async () => {
    // Bind-then-close yields a loopback port nothing listens on, so the
    // probe must refuse quickly rather than hang until its timeout.
    const holder = http.createServer();
    await new Promise<void>((resolve) =>
      holder.listen(0, '127.0.0.1', resolve),
    );
    const deadPort = (holder.address() as AddressInfo).port;
    await new Promise<void>((resolve) => {
      holder.close(() => resolve());
    });

    const started = Date.now();
    await expect(
      probePreAuthHostGateRejection(
        `http://127.0.0.1:${deadPort}`,
        'localhost:52100',
      ),
    ).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
