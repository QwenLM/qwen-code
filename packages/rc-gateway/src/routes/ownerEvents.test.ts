/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Request, Response } from 'express';
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AuditRecord } from '../auditLog.js';
import { requireScope } from '../auth.js';
import { OWNER, SESSION_READ, type RcScope } from '../scopes.js';
import { OwnerEventBus, MAX_OWNER_SUBSCRIBERS } from '../ownerEvents.js';
import { createOwnerEventsRoute } from './ownerEvents.js';

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
  server = undefined;
});

async function mount(bus: OwnerEventBus, scopes: RcScope[]): Promise<string> {
  const app = express();
  app.use((req, _res, next) => {
    req.rcClient = { id: 'tok', scopes };
    next();
  });
  app.get('/rc/events', requireScope(OWNER), createOwnerEventsRoute(bus));
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

function auditRecord(action: string): AuditRecord {
  return { ts: 7, action } as unknown as AuditRecord;
}

describe('GET /rc/events', () => {
  it('streams a published audit record LIVE to a connected owner', async () => {
    // Use the raw http client (not fetch): node's fetch ReadableStream batches
    // small SSE chunks until close, which would hide live delivery; http emits
    // each frame on arrival, so this asserts the frame is pushed immediately.
    const bus = new OwnerEventBus();
    const url = new URL(`${await mount(bus, [OWNER])}/rc/events`);

    const { contentType, frame } = await new Promise<{
      contentType: string | undefined;
      frame: string;
    }>((resolve, reject) => {
      const req = http.get(
        { hostname: url.hostname, port: url.port, path: url.pathname },
        (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`status ${res.statusCode}`));
            return;
          }
          const contentType = res.headers['content-type'];
          res.setEncoding('utf8');
          let buf = '';
          let published = false;
          res.on('data', (chunk: string) => {
            buf += chunk;
            // Publish only after the stream opener confirms we're subscribed.
            if (!published && buf.includes(': ok')) {
              published = true;
              bus.publish({
                type: 'audit',
                record: auditRecord('token_minted'),
              });
            }
            const line = buf
              .split('\n')
              .find(
                (l) => l.startsWith('data: ') && l.includes('token_minted'),
              );
            if (line) {
              req.destroy();
              resolve({ contentType, frame: line });
            }
          });
        },
      );
      req.on('error', reject);
      setTimeout(() => {
        req.destroy();
        reject(new Error('timed out waiting for the frame'));
      }, 3000);
    });

    expect(contentType).toContain('text/event-stream');
    const parsed = JSON.parse(frame.slice('data: '.length));
    expect(parsed).toMatchObject({
      type: 'audit',
      record: { action: 'token_minted', ts: 7 },
    });
    // The client disconnect unsubscribed it (no leaked subscriber).
    await new Promise((r) => setTimeout(r, 50));
    expect(bus.size).toBe(0);
  });

  it('403s a non-owner before opening a stream', async () => {
    const bus = new OwnerEventBus();
    const base = await mount(bus, [SESSION_READ]);
    const res = await fetch(`${base}/rc/events`);
    expect(res.status).toBe(403);
    await res.text();
    expect(bus.size).toBe(0);
  });

  it('503s when the bus is at capacity', async () => {
    const bus = new OwnerEventBus();
    // Saturate the bus so the route's own subscribe() returns null.
    for (let i = 0; i < MAX_OWNER_SUBSCRIBERS; i++) bus.subscribe(() => {});
    const base = await mount(bus, [OWNER]);
    const res = await fetch(`${base}/rc/events`);
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('too_many_streams');
  });

  it('drops frames under backpressure and emits ONE resync on drain', () => {
    // Drive res.write() === false directly with a mock res so the
    // dropping/dropped/resync path (the externally-triggerable-storm mitigation)
    // is verified, not just read.
    const bus = new OwnerEventBus();
    const writes: string[] = [];
    let writeOk = true;
    let drain: (() => void) | undefined;
    let close: (() => void) | undefined;
    const res = {
      writeHead() {},
      flushHeaders() {},
      write(s: string) {
        writes.push(s);
        return writeOk;
      },
      once(ev: string, cb: () => void) {
        if (ev === 'drain') drain = cb;
      },
      end() {},
    } as unknown as Response;
    const req = {
      on(ev: string, cb: () => void) {
        if (ev === 'close') close = cb;
      },
      socket: { setNoDelay() {} },
    } as unknown as Request;

    createOwnerEventsRoute(bus)(req, res, () => {});
    expect(writes).toContain(': ok\n\n');

    // The frame that trips write()===false is sent; subsequent frames drop.
    writeOk = false;
    bus.publish({ type: 'audit', record: auditRecord('a1') });
    bus.publish({ type: 'audit', record: auditRecord('a2') });
    bus.publish({ type: 'audit', record: auditRecord('a3') });
    expect(writes.filter((w) => w.startsWith('data: '))).toHaveLength(1);

    // On drain, exactly one resync marker reports the dropped count (2).
    writeOk = true;
    drain?.();
    const resync = writes.filter((w) => w.startsWith('event: resync'));
    expect(resync).toHaveLength(1);
    expect(resync[0]).toContain('"dropped":2');

    close?.(); // clear the heartbeat interval
  });
});
