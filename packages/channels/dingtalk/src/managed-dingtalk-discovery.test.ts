/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #17173 R11: the SDK's getEndpoint() has no timeout and console.log()s the
// resolved config (clientSecret) and the gateway response (endpoint/ticket).
// Wrapping it in a process-wide console suppression therefore muted the whole
// process for as long as discovery stayed pending — past the attempt budget,
// which rejects the attempt without settling that promise. The wrapper now
// owns discovery: bounded, abortable and silent. Only the network boundary
// (ws, fetch) is fake; the SDK and the production wrapper run for real.

const wsState = vi.hoisted(() => ({
  instances: [] as unknown[],
  urls: [] as string[],
}));

vi.mock('ws', () => {
  class FakeWebSocket {
    readyState = 0;
    listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    ping = vi.fn();
    terminate = vi.fn();
    close = vi.fn(() => {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit('close');
    });
    constructor(url: string) {
      wsState.instances.push(this);
      wsState.urls.push(url);
    }
    on(event: string, cb: (...args: unknown[]) => void): void {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event)!.add(cb);
    }
    off(event: string, cb: (...args: unknown[]) => void): void {
      this.listeners.get(event)?.delete(cb);
    }
    emit(event: string, ...args: unknown[]): void {
      if (event === 'close') this.readyState = 3;
      this.listeners.get(event)?.forEach((cb) => cb(...args));
    }
    open(): void {
      this.readyState = 1;
      this.emit('open');
    }
  }
  return { default: FakeWebSocket };
});

import { createManagedDingtalkDeps } from './managed-dingtalk-deps.js';

type FakeSocket = { open: () => void; emit: (e: string) => void };
type Call = { url: string; init?: RequestInit };

const SETTINGS = {
  clientId: 'robot app',
  clientSecret: 's/ecret+&',
  pollInterval: 2_000,
};
const CONNECT_TIMEOUT_MS = 20_000;

const calls: Call[] = [];
let mode:
  | 'ok'
  | 'hang'
  | 'no-token'
  | 'no-ticket'
  | 'refused'
  | 'gateway-refused' = 'ok';

const body = (url: string) =>
  url.includes('gettoken')
    ? mode === 'no-token'
      ? {}
      : { access_token: 'tok' }
    : mode === 'no-ticket'
      ? { endpoint: 'wss://fake.invalid' }
      : { endpoint: 'wss://fake.invalid', ticket: 'tk' };

const latest = (): FakeSocket =>
  wsState.instances[wsState.instances.length - 1] as FakeSocket;

const newStream = () => {
  const { createStreamClient } = createManagedDingtalkDeps();
  return createStreamClient(SETTINGS, () => true);
};

const startOpen = async () => {
  const stream = newStream();
  const connecting = stream.connect();
  await vi.advanceTimersByTimeAsync(0);
  latest().open();
  await connecting;
  return stream;
};

beforeEach(() => {
  wsState.instances.length = 0;
  wsState.urls.length = 0;
  calls.length = 0;
  mode = 'ok';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (mode === 'hang') return new Promise(() => {});
      // 'refused' fails the token leg; 'gateway-refused' answers the token and
      // fails the gateway, so both refusal branches are actually reached.
      const ok =
        mode === 'refused'
          ? false
          : mode === 'gateway-refused'
            ? url.includes('gettoken')
            : true;
      return { ok, json: async () => body(url) };
    }),
  );
  vi.useFakeTimers();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('managed DingTalk endpoint discovery (#17173 R11)', () => {
  it('requests the token and the gateway with the SDK contract', async () => {
    const stream = await startOpen();

    expect(calls).toHaveLength(2);
    const [token, gateway] = calls;
    expect(token!.url).toBe(
      'https://oapi.dingtalk.com/gettoken' +
        `?appkey=${encodeURIComponent(SETTINGS.clientId)}` +
        `&appsecret=${encodeURIComponent(SETTINGS.clientSecret)}`,
    );
    expect(gateway!.url).toBe(
      'https://api.dingtalk.com/v1.0/gateway/connections/open',
    );
    // Neither leg may follow a redirect: the first URL carries the appsecret
    // and the second carries the access token.
    expect(token!.init?.redirect).toBe('error');
    expect(gateway!.init?.redirect).toBe('error');
    expect(gateway!.init?.method).toBe('POST');
    expect(
      (gateway!.init?.headers as Record<string, string>)['access-token'],
    ).toBe('tok');
    expect(JSON.parse(String(gateway!.init?.body))).toMatchObject({
      clientId: SETTINGS.clientId,
      clientSecret: SETTINGS.clientSecret,
      subscriptions: expect.arrayContaining([
        { type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' },
      ]),
    });

    stream.disconnect();
  });

  it('assigns the url the SDK connects with from the discovered ticket', async () => {
    const stream = await startOpen();
    // _connect() builds the socket from dw_url, so the url it received is the
    // proof that discovery assigned it.
    expect(wsState.urls).toEqual(['wss://fake.invalid?ticket=tk']);
    stream.disconnect();
  });

  it.each(['no-token', 'no-ticket', 'refused', 'gateway-refused'] as const)(
    'a %s answer rejects the first connect without leaking the secret',
    async (m) => {
      mode = m;
      const stream = newStream();
      const message = await stream.connect().then(
        () => 'resolved',
        (error: Error) => error.message,
      );
      expect(message).toMatch(/check the clientId\/clientSecret and network/);
      expect(message).not.toContain(SETTINGS.clientSecret);
      expect(wsState.instances).toHaveLength(0);
      stream.disconnect();
    },
  );

  // A signal that never aborts would satisfy an instanceof check, so pin the
  // deadline itself: one real timeout, at the attempt's horizon. Sharing that
  // horizon is deliberate — a shorter bound would narrow the allowance
  // discovery already had under the attempt budget.
  it('gives discovery a real deadline at the attempt horizon', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const stream = await startOpen();
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout.mock.calls[0]![0]).toBe(CONNECT_TIMEOUT_MS);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(calls[0]!.init?.signal).toBe(calls[1]!.init?.signal);
    stream.disconnect();
  });

  it('prints nothing on a successful connect', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stream = await startOpen();
    expect(log).not.toHaveBeenCalled();
    stream.disconnect();
  });

  it('a discovery that never answers leaves console.log intact past the budget', async () => {
    mode = 'hang';
    // eslint-disable-next-line no-console -- the witness is console.log identity
    const original = console.log;
    const stream = newStream();
    const connecting = stream.connect();
    // The first failure is redacted by the wrapper, so match that message.
    const assertion = expect(connecting).rejects.toThrow(
      /check the clientId\/clientSecret and network/,
    );
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    await assertion;

    // The attempt gave up; the process must not still be muted.
    // eslint-disable-next-line no-console -- the witness is console.log identity
    expect(console.log).toBe(original);
    stream.disconnect();
  });

  it('the discovery contract still matches the pinned SDK source', () => {
    const require = createRequire(import.meta.url);
    const sdk = readFileSync(
      require
        .resolve('dingtalk-stream-sdk-nodejs')
        .replace(/index\.[cm]?js$/, 'client.mjs'),
      'utf8',
    );
    expect(sdk).toContain('https://oapi.dingtalk.com/gettoken');
    expect(sdk).toContain(
      'https://api.dingtalk.com/v1.0/gateway/connections/open',
    );
    expect(sdk).toContain('"access-token": result.data.access_token');
    expect(sdk).toContain('this.dw_url = `${endpoint}?ticket=${ticket}`');
    // The names discoverEndpoint hand-transcribes. Pinning only the URLs and
    // the header would let a rename of any of these pass while discovery kept
    // sending the old names, failing every managed connect.
    for (const literal of [
      'appkey=${this.config.clientId}',
      'appsecret=${this.config.clientSecret}',
      'clientId: this.config.clientId',
      'clientSecret: this.config.clientSecret',
      'ua: this.config.ua',
      'subscriptions: this.config.subscriptions',
    ]) {
      expect(sdk).toContain(literal);
    }
  });
});
