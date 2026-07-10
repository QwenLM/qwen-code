/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BridgeClient } from './client.js';

interface Captured {
  method: string;
  path: string;
  auth?: string;
  subActor?: string;
  body: unknown;
}

let server: Server | undefined;
let base: string;
let captured: Captured[];
let rateLimitNext: boolean;
let lastEventIdHeader: string | undefined;

beforeEach(() => {
  captured = [];
  rateLimitNext = false;
  lastEventIdHeader = undefined;
  const app = express();
  app.use(express.json());
  const cap = (req: express.Request) =>
    captured.push({
      method: req.method,
      path: req.path,
      auth: req.header('authorization'),
      subActor: req.header('x-rc-subactor'),
      body: req.body,
    });
  app.post('/rc/bridges', (req, res) => {
    cap(req);
    res.status(200).json({ id: req.body.id, registered: true });
  });
  app.post('/session/:id/prompt', (req, res) => {
    cap(req);
    if (rateLimitNext) {
      res.set('retry-after', '7');
      res.status(429).json({ code: 'sub_actor_rate_limited' });
      return;
    }
    res.status(200).json({ stopReason: 'end_turn' });
  });
  app.post('/session/:id/permission/:requestId', (req, res) => {
    cap(req);
    res.status(200).json({ ok: true });
  });
  app.post('/rc/bridges/:id/heartbeat', (req, res) => {
    cap(req);
    res
      .status(200)
      .json({ id: req.params.id, registeredAt: 1, heartbeatIntervalSec: 60 });
  });
  app.post('/rc/bridges/:id/invite/redeem', (req, res) => {
    cap(req);
    if (req.body?.token === 'inv_good') {
      res.status(200).json({ sessionId: 'sess_bound', kind: 'telegram' });
      return;
    }
    res.status(400).json({ error: 'Invalid or expired invite token' });
  });
  app.get('/session/:id/events', (req, res) => {
    lastEventIdHeader = req.header('last-event-id');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(
      'id: 1\ndata: {"id":1,"type":"session_update","data":{"text":"hi"}}\n\n',
    );
    res.write(
      'id: 2\ndata: {"id":2,"type":"permission_request","data":{"requestId":"r1","bridgeHints":{"recommendedSurface":"inline"}}}\n\n',
    );
    res.end();
  });
  return new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
      resolve();
    });
  });
});
afterEach(
  () => new Promise<void>((r) => (server ? server.close(() => r()) : r())),
);

function client() {
  return new BridgeClient({ baseUrl: base, token: 'qwk_test' });
}

describe('BridgeClient (loopback contract)', () => {
  it('register POSTs /rc/bridges with the bearer token', async () => {
    const r = await client().register({ id: 'telegram', displayName: 'TG' });
    expect(r.ok).toBe(true);
    expect(captured[0]).toMatchObject({
      method: 'POST',
      path: '/rc/bridges',
      auth: 'Bearer qwk_test',
      body: { id: 'telegram', displayName: 'TG' },
    });
  });

  it('sendPrompt carries the bearer AND X-RC-SubActor + the prompt body', async () => {
    const r = await client().sendPrompt('s1', 'do it', 'telegram:alice');
    expect(r.ok).toBe(true);
    expect(captured[0]).toMatchObject({
      method: 'POST',
      path: '/session/s1/prompt',
      auth: 'Bearer qwk_test',
      subActor: 'telegram:alice',
      body: { prompt: 'do it' },
    });
  });

  it('vote POSTs the permission route with outcome + sub-actor', async () => {
    await client().vote('s1', 'r1', 'allow_once', 'telegram:alice', 'opt-a');
    expect(captured[0]).toMatchObject({
      path: '/session/s1/permission/r1',
      subActor: 'telegram:alice',
      body: { outcome: 'allow_once', optionId: 'opt-a' },
    });
  });

  it('redeemInvite POSTs the bridge invite route and returns the bound sessionId', async () => {
    const r = await client().redeemInvite('telegram', 'inv_good');
    expect(r.ok).toBe(true);
    expect(r.sessionId).toBe('sess_bound');
    expect(captured[0]).toMatchObject({
      method: 'POST',
      path: '/rc/bridges/telegram/invite/redeem',
      auth: 'Bearer qwk_test',
      body: { token: 'inv_good' },
    });
  });

  it('heartbeat POSTs the bridge heartbeat path with the bearer token', async () => {
    const r = await client().heartbeat('telegram');
    expect(r.ok).toBe(true);
    expect(
      (r.body as { heartbeatIntervalSec?: number }).heartbeatIntervalSec,
    ).toBe(60);
    expect(captured[0]).toMatchObject({
      method: 'POST',
      path: '/rc/bridges/telegram/heartbeat',
      auth: 'Bearer qwk_test',
    });
  });

  it('redeemInvite surfaces the gateway error (no sessionId) on a bad token', async () => {
    const r = await client().redeemInvite('telegram', 'inv_bad');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.sessionId).toBeUndefined();
    expect((r.body as { error?: string }).error).toBe(
      'Invalid or expired invite token',
    );
  });

  it('surfaces a 429 with retryAfterSec for back-pressure', async () => {
    rateLimitNext = true;
    const r = await client().sendPrompt('s1', 'spam', 'telegram:troll');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(429);
    expect(r.retryAfterSec).toBe(7);
  });

  it('subscribeEvents parses frames (incl. bridgeHints) and invokes onEvent', async () => {
    const events: Array<{ type?: string; data?: unknown }> = [];
    await client().subscribeEvents('s1', (ev) => events.push(ev));
    expect(events.map((e) => e.type)).toEqual([
      'session_update',
      'permission_request',
    ]);
    const perm = events[1].data as {
      bridgeHints?: { recommendedSurface?: string };
    };
    expect(perm.bridgeHints?.recommendedSurface).toBe('inline');
  });

  it('sends Last-Event-ID when a resume cursor is given (and not otherwise)', async () => {
    await client().subscribeEvents('s1', () => {});
    expect(lastEventIdHeader).toBeUndefined(); // first subscribe: no cursor
    await client().subscribeEvents('s1', () => {}, undefined, 42);
    expect(lastEventIdHeader).toBe('42'); // reconnect: resume from id 42
  });
});
