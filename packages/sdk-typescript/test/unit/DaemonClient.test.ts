/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  DaemonClient,
  DaemonHttpError,
  abortTimeout,
  composeAbortSignals,
} from '../../src/daemon/DaemonClient.js';
import {
  DaemonCapabilityMissingError,
  requireWorkspaceCwd,
} from '../../src/daemon/types.js';
import type { DaemonCapabilities } from '../../src/daemon/types.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(frames: string): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function recordingFetch(
  reply: (req: CapturedRequest) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = init?.method ?? 'GET';
      const headers: Record<string, string> = {};
      if (init?.headers) {
        const h = new Headers(init.headers);
        h.forEach((v, k) => (headers[k.toLowerCase()] = v));
      }
      const body = typeof init?.body === 'string' ? init.body : null;
      const captured: CapturedRequest = { url, method, headers, body };
      calls.push(captured);
      return reply(captured);
    },
  ) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls };
}

describe('DaemonClient', () => {
  describe('health', () => {
    it('GETs /health and returns the body', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, { status: 'ok' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const res = await client.health();
      expect(res).toEqual({ status: 'ok' });
      expect(calls[0]?.url).toBe('http://daemon/health');
      expect(calls[0]?.method).toBe('GET');
    });

    it('throws DaemonHttpError on non-2xx', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(503, { error: 'down' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(client.health()).rejects.toBeInstanceOf(DaemonHttpError);
    });
  });

  describe('capabilities', () => {
    it('GETs /capabilities and returns the v1 envelope', async () => {
      const envelope = {
        v: 1 as const,
        mode: 'http-bridge' as const,
        features: ['health', 'capabilities'],
        modelServices: [],
        workspaceCwd: '/work/bound',
      };
      const { fetch } = recordingFetch(() => jsonResponse(200, envelope));
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const caps = await client.capabilities();
      expect(caps).toEqual(envelope);
      // #3803 §02: clients use `workspaceCwd` to pre-flight check +
      // omit `cwd` from `POST /session` (route falls back).
      expect(caps.workspaceCwd).toBe('/work/bound');
    });
  });

  describe('bearer auth', () => {
    it('attaches Authorization: Bearer when token is set', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, { status: 'ok' }),
      );
      const client = new DaemonClient({
        baseUrl: 'http://daemon',
        token: 'secret',
        fetch,
      });
      await client.health();
      expect(calls[0]?.headers['authorization']).toBe('Bearer secret');
    });

    it('omits Authorization when no token', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, { status: 'ok' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.health();
      expect(calls[0]?.headers['authorization']).toBeUndefined();
    });
  });

  describe('createOrAttachSession', () => {
    it('POSTs cwd in the body', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: false,
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const session = await client.createOrAttachSession({
        workspaceCwd: '/work/a',
      });
      expect(session.sessionId).toBe('s-1');
      expect(calls[0]?.method).toBe('POST');
      expect(calls[0]?.url).toBe('http://daemon/session');
      expect(JSON.parse(calls[0]!.body!)).toEqual({ cwd: '/work/a' });
    });

    it('omits cwd when workspaceCwd is not provided (#3803 §02)', async () => {
      // Per #3803 §02 the daemon route falls back to its bound
      // workspace when `cwd` is absent. The SDK relies on
      // JSON.stringify stripping `undefined` values, so an
      // omitted `workspaceCwd` ends up as "no `cwd` key" on the
      // wire — exactly the fallback shape the server expects.
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/bound',
          attached: false,
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.createOrAttachSession({});
      expect(JSON.parse(calls[0]!.body!)).toEqual({});
    });

    it('forwards empty-string workspaceCwd verbatim so the server can 400 it', async () => {
      // `workspaceCwd: ""` is a likely client-side bug shape. A
      // truthy-guard SDK would silently drop the field and let the
      // server's fallback bind the session — masking the bug. We
      // forward it verbatim so the server's
      // `cwd must be an absolute path when provided` 400 surfaces.
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(400, { error: 'bad cwd' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(
        client.createOrAttachSession({ workspaceCwd: '' }),
      ).rejects.toMatchObject({ status: 400 });
      expect(JSON.parse(calls[0]!.body!)).toEqual({ cwd: '' });
    });

    it('forwards modelServiceId when supplied', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: false,
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.createOrAttachSession({
        workspaceCwd: '/work/a',
        modelServiceId: 'qwen-prod',
      });
      expect(JSON.parse(calls[0]!.body!)).toEqual({
        cwd: '/work/a',
        modelServiceId: 'qwen-prod',
      });
    });

    it('throws on 400', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(400, { error: 'bad cwd' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(
        client.createOrAttachSession({ workspaceCwd: 'relative' }),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('prompt', () => {
    it('POSTs the prompt body and returns the agent response', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, { stopReason: 'end_turn' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const res = await client.prompt('s-1', {
        prompt: [{ type: 'text', text: 'hi' }],
      });
      expect(res.stopReason).toBe('end_turn');
      expect(calls[0]?.url).toBe('http://daemon/session/s-1/prompt');
      expect(calls[0]?.method).toBe('POST');
      const body = JSON.parse(calls[0]!.body!);
      expect(body.prompt).toEqual([{ type: 'text', text: 'hi' }]);
    });

    it('url-encodes the sessionId', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, { stopReason: 'end_turn' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.prompt('with/slash', {
        prompt: [{ type: 'text', text: 'x' }],
      });
      expect(calls[0]?.url).toBe('http://daemon/session/with%2Fslash/prompt');
    });

    it('forwards a caller AbortSignal through to fetch (A-UsQ)', async () => {
      // The bridge already supports per-prompt cancellation via the
      // signal arg on `sendPrompt`; the SDK had the parameter wired
      // but no test, so a regression that dropped it on the floor
      // would silently leave callers unable to cancel.
      const fetch = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_res, rej) => {
            init?.signal?.addEventListener('abort', () =>
              rej(new DOMException('aborted', 'AbortError')),
            );
          }),
      ) as unknown as typeof globalThis.fetch;
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 30);
      await expect(
        client.prompt(
          's-1',
          { prompt: [{ type: 'text', text: 'hi' }] },
          ctrl.signal,
        ),
      ).rejects.toThrow();
    });
  });

  describe('cancel', () => {
    it('POSTs /cancel and tolerates 204', async () => {
      const { fetch, calls } = recordingFetch(
        () => new Response(null, { status: 204 }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.cancel('s-1');
      expect(calls[0]?.url).toBe('http://daemon/session/s-1/cancel');
      expect(calls[0]?.method).toBe('POST');
    });

    it('throws on 404', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(404, { error: 'unknown', sessionId: 's-1' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(client.cancel('s-1')).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe('respondToPermission', () => {
    it('returns true on 200', async () => {
      const { fetch, calls } = recordingFetch(() => jsonResponse(200, {}));
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const accepted = await client.respondToPermission('req-1', {
        outcome: { outcome: 'selected', optionId: 'allow' },
      });
      expect(accepted).toBe(true);
      expect(calls[0]?.url).toBe('http://daemon/permission/req-1');
    });

    it('returns false on 404 (lost the race)', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(404, { error: 'unknown', requestId: 'req-1' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const accepted = await client.respondToPermission('req-1', {
        outcome: { outcome: 'cancelled' },
      });
      expect(accepted).toBe(false);
    });

    it('throws on 400 (malformed outcome)', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(400, { error: 'bad outcome' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(
        client.respondToPermission('req-1', {
          outcome: { outcome: 'cancelled' },
        }),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('subscribeEvents', () => {
    it('GETs /events and yields parsed frames', async () => {
      const { fetch, calls } = recordingFetch(() =>
        sseResponse(
          'id: 1\nevent: session_update\ndata: {"id":1,"v":1,"type":"session_update","data":"a"}\n\n' +
            'id: 2\nevent: session_update\ndata: {"id":2,"v":1,"type":"session_update","data":"b"}\n\n',
        ),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const events = [];
      for await (const e of client.subscribeEvents('s-1')) events.push(e);
      expect(events.map((e) => e.id)).toEqual([1, 2]);
      expect(calls[0]?.url).toBe('http://daemon/session/s-1/events');
      expect(calls[0]?.headers['accept']).toBe('text/event-stream');
    });

    it('forwards Last-Event-ID', async () => {
      const { fetch, calls } = recordingFetch(() => sseResponse(''));
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      // Drain immediately — empty stream.
      for await (const _ of client.subscribeEvents('s-1', {
        lastEventId: 42,
      })) {
        /* unreachable */
      }
      expect(calls[0]?.headers['last-event-id']).toBe('42');
    });

    it('throws DaemonHttpError when the daemon returns a non-2xx for events', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(404, { error: 'unknown', sessionId: 'missing' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const iter = client.subscribeEvents('missing');
      await expect(iter.next()).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('listWorkspaceSessions', () => {
    it('GETs /workspace/:id/sessions and returns the array', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, {
          sessions: [
            { sessionId: 's-1', workspaceCwd: '/work/a' },
            { sessionId: 's-2', workspaceCwd: '/work/a' },
          ],
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const sessions = await client.listWorkspaceSessions('/work/a');
      expect(sessions).toHaveLength(2);
      // The cwd must be URL-encoded so the slashes don't collide with the
      // route segments.
      expect(calls[0]?.url).toBe(
        'http://daemon/workspace/%2Fwork%2Fa/sessions',
      );
    });

    it('throws on non-2xx (e.g. 400 from a relative path)', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(400, { error: 'must be absolute' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(
        client.listWorkspaceSessions('relative'),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('setSessionModel', () => {
    it('POSTs the modelId in the body and returns the agent response', async () => {
      const { fetch, calls } = recordingFetch(() => jsonResponse(200, {}));
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const result = await client.setSessionModel('s-1', 'qwen3-coder');
      expect(result).toEqual({});
      expect(calls[0]?.url).toBe('http://daemon/session/s-1/model');
      expect(calls[0]?.method).toBe('POST');
      expect(JSON.parse(calls[0]!.body!)).toEqual({ modelId: 'qwen3-coder' });
    });

    it('throws on 404 (unknown session)', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(404, { error: 'unknown', sessionId: 's-1' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(
        client.setSessionModel('s-1', 'qwen3-coder'),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('error coercion', () => {
    it('falls back to text body when the response is not JSON', async () => {
      const { fetch } = recordingFetch(
        () =>
          new Response('plaintext error from upstream', {
            status: 502,
            headers: { 'content-type': 'text/plain' },
          }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const err = await client.health().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(DaemonHttpError);
      expect((err as DaemonHttpError).status).toBe(502);
      expect((err as DaemonHttpError).body).toBe(
        'plaintext error from upstream',
      );
    });

    it('respondToPermission throws on 5xx', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(503, { error: 'agent crashed' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(
        client.respondToPermission('req-1', {
          outcome: { outcome: 'cancelled' },
        }),
      ).rejects.toMatchObject({ status: 503 });
    });
  });

  describe('subscribeEvents edge cases', () => {
    it('throws when the response body is null', async () => {
      const { fetch } = recordingFetch(
        () =>
          new Response(null, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const iter = client.subscribeEvents('s-1');
      await expect(iter.next()).rejects.toThrow(/SSE response has no body/);
    });

    it('throws DaemonHttpError when content-type is not text/event-stream', async () => {
      // E.g. a misconfigured proxy returns 200 + JSON instead of SSE.
      // Without the content-type guard the parser would silently produce
      // zero events.
      const { fetch } = recordingFetch(
        () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const iter = client.subscribeEvents('s-1');
      await expect(iter.next()).rejects.toMatchObject({
        status: 200,
      });
    });

    it('applies fetchTimeoutMs to the connect phase only — never-resolving fetch aborts (A-UsS)', async () => {
      // The CONNECT phase (request → headers received) must respect
      // `fetchTimeoutMs`; the SSE body itself must NOT be timed out.
      // Verify the timer fires when headers never arrive.
      const fetch = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_res, rej) => {
            init?.signal?.addEventListener('abort', () =>
              rej(new DOMException('aborted', 'AbortError')),
            );
          }),
      ) as unknown as typeof globalThis.fetch;
      const client = new DaemonClient({
        baseUrl: 'http://daemon',
        fetch,
        fetchTimeoutMs: 50,
      });
      const before = Date.now();
      const iter = client.subscribeEvents('s-1');
      await expect(iter.next()).rejects.toThrow();
      const elapsed = Date.now() - before;
      // Generous bound — just confirms the timer fired.
      expect(elapsed).toBeLessThan(2000);
    });

    it('clears the connect-timeout when headers arrive promptly (A-UsS)', async () => {
      // A fast-resolving fetch must NOT leave the timer pending,
      // otherwise vitest would see a dangling handle that keeps the
      // event loop alive past the test (flake on slow CI).
      const { fetch } = recordingFetch(() => sseResponse(''));
      const client = new DaemonClient({
        baseUrl: 'http://daemon',
        fetch,
        fetchTimeoutMs: 60_000, // long; if we don't clear it, the test would hang
      });
      const iter = client.subscribeEvents('s-1');
      const first = await iter.next();
      expect(first.done).toBe(true);
      // We reach this line in < a second; the 60s timer was cleared.
    });
  });

  describe('URL encoding of session-scoped endpoints', () => {
    it('cancel encodes a slash-bearing sessionId', async () => {
      const { fetch, calls } = recordingFetch(
        () => new Response(null, { status: 204 }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.cancel('weird/id');
      expect(calls[0]?.url).toBe('http://daemon/session/weird%2Fid/cancel');
    });

    it('respondToPermission encodes a slash-bearing requestId', async () => {
      const { fetch, calls } = recordingFetch(() => jsonResponse(200, {}));
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.respondToPermission('weird/req', {
        outcome: { outcome: 'cancelled' },
      });
      expect(calls[0]?.url).toBe('http://daemon/permission/weird%2Freq');
    });
  });

  describe('baseUrl normalization', () => {
    it('strips trailing slashes', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, { status: 'ok' }),
      );
      const client = new DaemonClient({
        baseUrl: 'http://daemon/////',
        fetch,
      });
      await client.health();
      expect(calls[0]?.url).toBe('http://daemon/health');
    });
  });

  describe('fetchWithTimeout', () => {
    it('aborts the underlying fetch when the configured timeout fires', async () => {
      // Fetch that *never* resolves on its own — only abort can end it.
      // This is what the polyfill paths (`abortTimeout` /
      // `composeAbortSignals`) need to actually exercise; the rest of
      // the suite uses synchronous-resolving fakes that never trigger
      // the timeout machinery.
      const fetch = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_res, rej) => {
            init?.signal?.addEventListener('abort', () =>
              rej(new DOMException('aborted', 'AbortError')),
            );
          }),
      ) as unknown as typeof globalThis.fetch;
      const client = new DaemonClient({
        baseUrl: 'http://daemon',
        fetch,
        fetchTimeoutMs: 50,
      });
      const before = Date.now();
      await expect(client.health()).rejects.toThrow();
      const elapsed = Date.now() - before;
      // Generous upper bound — we just want to know the timer fired
      // (not that the test runner waited the full default 5s).
      expect(elapsed).toBeLessThan(2000);
    });

    it('aborts when the response BODY stalls after headers (BRN1o)', async () => {
      // Pre-fix bug: `fetchWithTimeout` cleared the timer the moment
      // `fetch` resolved (i.e. headers received). If the body then
      // stalled (proxy half-buffered, daemon hung mid-write), the
      // subsequent `await res.json()` had no deadline and could hang
      // indefinitely. Now the body-read happens INSIDE the timer
      // scope (via the `consume` callback), so this test exercises
      // the timer firing during body consumption.
      const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        // Build a Response whose body never delivers data and never
        // closes on its own — the only way `res.json()` ever
        // returns is if the timer aborts via the composed signal.
        // Wire the abort to `controller.error(...)` (NOT
        // `body.cancel()` — that throws on a locked stream once
        // `res.json()` has started reading) so the in-flight read
        // rejects naturally.
        const body = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () => {
              try {
                controller.error(
                  new DOMException('The operation timed out', 'TimeoutError'),
                );
              } catch {
                /* stream already errored / closed */
              }
            });
          },
        });
        return Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }) as unknown as typeof globalThis.fetch;
      const client = new DaemonClient({
        baseUrl: 'http://daemon',
        fetch,
        fetchTimeoutMs: 80,
      });
      const before = Date.now();
      await expect(client.health()).rejects.toThrow();
      const elapsed = Date.now() - before;
      // Pre-fix: this would hang for the test's outer timeout (5s+).
      // Post-fix: the timer fires ~80ms in, body read rejects.
      expect(elapsed).toBeLessThan(2000);
    });

    it('composeAbortSignals forwards the first abort, with or without native AbortSignal.any', async () => {
      // Direct-unit test on the helper — `subscribeEvents` bypasses
      // `fetchWithTimeout` entirely (it calls `_fetch` directly with
      // the caller's signal), so testing through subscribeEvents
      // never exercises the polyfill. Calling `composeAbortSignals`
      // here covers it on all Node versions: native (`>=20.3`) and
      // polyfill (`18.0`–`20.2`) take the same input shape.
      const a = new AbortController();
      const b = new AbortController();
      const composed = composeAbortSignals([a.signal, b.signal]);
      expect(composed.aborted).toBe(false);
      a.abort(new DOMException('first', 'AbortError'));
      // The composed signal should follow whichever input fires first.
      // Allow a microtask for native AbortSignal.any propagation.
      await Promise.resolve();
      expect(composed.aborted).toBe(true);
    });

    it('composeAbortSignals fires immediately if any input is already aborted', () => {
      const a = new AbortController();
      a.abort();
      const b = new AbortController();
      const composed = composeAbortSignals([a.signal, b.signal]);
      expect(composed.aborted).toBe(true);
    });

    it('abortTimeout fires after the configured delay', async () => {
      const t0 = Date.now();
      const sig = abortTimeout(40);
      await new Promise<void>((resolve) =>
        sig.addEventListener('abort', () => resolve(), { once: true }),
      );
      const elapsed = Date.now() - t0;
      // Generous tolerance — just checking the timer fires.
      expect(elapsed).toBeGreaterThanOrEqual(30);
      expect(elapsed).toBeLessThan(2000);
    });
  });

  describe('requireWorkspaceCwd', () => {
    // Helper: build a `DaemonCapabilities`-shaped envelope without
    // having to spell out the unrelated fields on every call.
    const caps = (overrides: Partial<DaemonCapabilities>): DaemonCapabilities =>
      ({
        v: 1,
        mode: 'http-bridge',
        features: [],
        modelServices: [],
        ...overrides,
      }) as DaemonCapabilities;

    it('returns the workspaceCwd when populated', () => {
      expect(requireWorkspaceCwd(caps({ workspaceCwd: '/work/bound' }))).toBe(
        '/work/bound',
      );
    });

    it('throws DaemonCapabilityMissingError when the field is undefined (pre-§02 daemon)', () => {
      // Pre-§02 daemons emit v=1 envelopes without `workspaceCwd`.
      // The helper exists so SDK consumers get an actionable error
      // instead of a downstream `Cannot read properties of undefined`.
      expect(() => requireWorkspaceCwd(caps({}))).toThrow(
        DaemonCapabilityMissingError,
      );
      const err = (() => {
        try {
          requireWorkspaceCwd(caps({}));
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(DaemonCapabilityMissingError);
      expect((err as DaemonCapabilityMissingError).capability).toBe(
        'workspaceCwd',
      );
      expect((err as DaemonCapabilityMissingError).message).toMatch(
        /predates the feature|workspaceCwd/,
      );
    });

    it('treats empty-string as missing (defensive)', () => {
      // A daemon that erroneously sends `workspaceCwd: ""` would
      // otherwise satisfy `typeof === 'string'` while still being
      // useless to consumers. Treat it like a missing field so the
      // call site lands in the same error branch.
      expect(() => requireWorkspaceCwd(caps({ workspaceCwd: '' }))).toThrow(
        DaemonCapabilityMissingError,
      );
    });
  });
});
