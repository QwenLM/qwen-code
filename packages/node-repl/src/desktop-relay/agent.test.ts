/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Duplex } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  consentMessage,
  handleHttpRequest,
  parseConnectBody,
  serveConnection,
  type AgentContext,
  type RelayRecord,
} from './agent.js';
import type { HttpRequest } from './http.js';

const ORIGIN = 'https://devbox.example:4170';
const HOST = '127.0.0.1:47821';

function context(overrides: Partial<AgentContext> = {}) {
  let record: RelayRecord | undefined;
  const ctx: AgentContext = {
    port: 47821,
    version: '0.1.5',
    pid: 100,
    askConsent: vi.fn(async () => true),
    readRecord: () => record,
    writeRecord: (next) => {
      record = next;
    },
    isAlive: () => true,
    terminate: vi.fn(),
    startRelay: vi.fn(async () => undefined),
    now: () => new Date('2026-09-14T00:00:00Z'),
    ...overrides,
  };
  return {
    ctx,
    record: () => record,
    setRecord: (next: RelayRecord) => {
      record = next;
    },
  };
}

function req(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body = '',
): HttpRequest {
  return { method, path, headers: { host: HOST, ...headers }, body };
}

const connectBody = JSON.stringify({
  daemonUrl: `${ORIGIN}/`,
  sessionId: 'session-1',
  token: 'secret',
});

describe('handleHttpRequest', () => {
  it('refuses a foreign Host so a rebound DNS name cannot reach the relay', async () => {
    const { ctx } = context();
    const outcome = await handleHttpRequest(
      req('GET', '/status', {
        host: 'evil.example:47821',
        origin: 'http://evil.example:47821',
      }),
      ctx,
    );
    expect(outcome.status).toBe(421);
    expect(outcome.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers the preflight with CORS and the private-network opt-in', async () => {
    const { ctx } = context();
    const outcome = await handleHttpRequest(
      req('OPTIONS', '/connect', { origin: ORIGIN }),
      ctx,
    );
    expect(outcome.status).toBe(204);
    expect(outcome.headers).toMatchObject({
      'access-control-allow-origin': ORIGIN,
      'access-control-allow-private-network': 'true',
    });
  });

  it('asks the person at the computer, records the relay, and starts it after the reply', async () => {
    const { ctx, record } = context();
    const outcome = await handleHttpRequest(
      req('POST', '/connect', { origin: ORIGIN }, connectBody),
      ctx,
    );
    expect(ctx.askConsent).toHaveBeenCalledWith(
      expect.stringContaining('can run code on this computer'),
    );
    expect(outcome.status).toBe(202);
    expect(ctx.startRelay).not.toHaveBeenCalled();
    expect(record()).toMatchObject({
      pid: 100,
      origin: ORIGIN,
      phase: 'connecting',
    });
    expect(JSON.stringify(record())).not.toContain('secret');

    await outcome.after?.();
    expect(ctx.startRelay).toHaveBeenCalledWith(
      { daemonUrl: `${ORIGIN}/`, sessionId: 'session-1', token: 'secret' },
      ORIGIN,
    );
  });

  it('records a relay startup failure after returning the accepted response', async () => {
    const { ctx, record } = context({
      startRelay: vi.fn(async () => {
        throw new Error('cannot start relay');
      }),
    });
    const outcome = await handleHttpRequest(
      req('POST', '/connect', { origin: ORIGIN }, connectBody),
      ctx,
    );

    expect(outcome.status).toBe(202);
    await expect(outcome.after?.()).resolves.toBeUndefined();
    expect(record()).toMatchObject({
      pid: null,
      phase: 'failed',
      message: 'cannot start relay',
    });
  });

  it('reports a declined request and starts nothing', async () => {
    const { ctx, record } = context({ askConsent: vi.fn(async () => false) });
    const outcome = await handleHttpRequest(
      req('POST', '/connect', { origin: ORIGIN }, connectBody),
      ctx,
    );
    expect(outcome.status).toBe(403);
    expect(JSON.parse(outcome.body)).toEqual({ ok: false, code: 'denied' });
    expect(outcome.after).toBeUndefined();
    expect(record()).toBeUndefined();
  });

  it('never asks for a request without an Origin', async () => {
    const { ctx } = context();
    const outcome = await handleHttpRequest(
      req('POST', '/connect', {}, connectBody),
      ctx,
    );
    expect(outcome.status).toBe(403);
    expect(ctx.askConsent).not.toHaveBeenCalled();
  });

  it('replaces a running relay once the new one is approved', async () => {
    const { ctx, setRecord } = context();
    setRecord({
      pid: 42,
      origin: ORIGIN,
      daemonUrl: `${ORIGIN}/`,
      sessionId: 'old',
      phase: 'connected',
      updatedAt: '',
    });
    await handleHttpRequest(
      req('POST', '/connect', { origin: ORIGIN }, connectBody),
      ctx,
    );
    expect(ctx.terminate).toHaveBeenCalledWith(42);
  });

  it('shows the connection only to the page that started it', async () => {
    const { ctx, setRecord } = context();
    setRecord({
      pid: 42,
      origin: ORIGIN,
      daemonUrl: `${ORIGIN}/`,
      sessionId: 'session-1',
      phase: 'connected',
      updatedAt: '',
    });
    const own = await handleHttpRequest(
      req('GET', '/status', { origin: ORIGIN }),
      ctx,
    );
    expect(JSON.parse(own.body)).toMatchObject({
      ok: true,
      version: '0.1.5',
      active: { sessionId: 'session-1', phase: 'connected' },
    });
    const other = await handleHttpRequest(
      req('GET', '/status', { origin: 'https://other.example' }),
      ctx,
    );
    expect(JSON.parse(other.body)).toEqual({ ok: true, version: '0.1.5' });
  });

  it('reads a relay that died without saying so as stopped', async () => {
    const { ctx, setRecord } = context({ isAlive: () => false });
    setRecord({
      pid: 42,
      origin: ORIGIN,
      daemonUrl: `${ORIGIN}/`,
      sessionId: 'session-1',
      phase: 'connected',
      updatedAt: '',
    });
    const outcome = await handleHttpRequest(
      req('GET', '/status', { origin: ORIGIN }),
      ctx,
    );
    expect(JSON.parse(outcome.body).active.phase).toBe('stopped');
  });

  it('disconnects only for the page that connected', async () => {
    const { ctx, setRecord, record } = context();
    setRecord({
      pid: 42,
      origin: ORIGIN,
      daemonUrl: `${ORIGIN}/`,
      sessionId: 'session-1',
      phase: 'connected',
      updatedAt: '',
    });
    const other = await handleHttpRequest(
      req('POST', '/disconnect', { origin: 'https://other.example' }),
      ctx,
    );
    expect(other.status).toBe(409);
    expect(ctx.terminate).not.toHaveBeenCalled();

    const own = await handleHttpRequest(
      req('POST', '/disconnect', { origin: ORIGIN }),
      ctx,
    );
    expect(own.status).toBe(200);
    expect(ctx.terminate).toHaveBeenCalledWith(42);
    expect(record()).toMatchObject({ pid: null, phase: 'stopped' });
  });
});

describe('parseConnectBody / consentMessage', () => {
  it('validates the daemon URL, session and workspace', () => {
    expect(parseConnectBody('{')).toBe('body is not JSON');
    expect(
      parseConnectBody(
        JSON.stringify({ daemonUrl: 'file:///etc', sessionId: 's' }),
      ),
    ).toBe('daemonUrl must be http or https');
    expect(
      parseConnectBody(
        JSON.stringify({ daemonUrl: 'https://u:p@h/', sessionId: 's' }),
      ),
    ).toBe('daemonUrl must not carry credentials');
    expect(
      parseConnectBody(
        JSON.stringify({
          daemonUrl: 'https://h/',
          sessionId: 's',
          workspace: { kind: 'cwd', value: '/w' },
        }),
      ),
    ).toEqual({
      daemonUrl: 'https://h/',
      sessionId: 's',
      workspace: { kind: 'cwd', value: '/w' },
    });
  });

  it('names both sites when the page and the session differ', () => {
    const message = consentMessage('https://page.example', {
      daemonUrl: 'https://devbox.example:4170/',
      sessionId: 's',
    });
    expect(message).toContain('session on devbox.example:4170');
    expect(message).toContain('are on different sites');
  });
});

class MemorySocket extends Duplex {
  readonly written: string[] = [];
  override _read(): void {
    // Data is pushed by the test.
  }
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: () => void,
  ): void {
    this.written.push(chunk.toString('utf8'));
    done();
  }
}

describe('serveConnection', () => {
  it('answers an HTTP request and closes', async () => {
    const { ctx } = context();
    const socket = new MemorySocket();
    const done = serveConnection(socket, {
      http: ctx,
    });
    socket.push(
      `GET /status HTTP/1.1\r\nHost: ${HOST}\r\nOrigin: ${ORIGIN}\r\n\r\n`,
    );
    await done;
    const response = socket.written.join('');
    expect(response.startsWith('HTTP/1.1 200 OK\r\n')).toBe(true);
    expect(response).toContain(`access-control-allow-origin: ${ORIGIN}`);
  });
});
