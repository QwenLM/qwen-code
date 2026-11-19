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
  | 'gateway-refused'
  | 'transport' = 'ok';

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
      if (mode === 'transport') throw new TypeError('fetch failed');
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
    const headers = gateway!.init?.headers as Record<string, string>;
    expect(headers['access-token']).toBe('tok');
    // The SDK marks Accept as load-bearing (without it the gateway answers
    // XML); Content-Type is what makes the JSON body readable.
    expect(headers['Accept']).toBe('application/json');
    expect(headers['Content-Type']).toBe('application/json');
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

  it.each([
    'no-token',
    'no-ticket',
    'refused',
    'gateway-refused',
    'transport',
  ] as const)(
    'a %s answer rejects the first connect without leaking the secret',
    async (m) => {
      mode = m;
      const stream = newStream();
      const message = await stream.connect().then(
        () => 'resolved',
        (error: Error) => error.message,
      );
      // The redacted message is a constant, so it cannot discriminate the
      // branches. The request count can: a token-side refusal must
      // short-circuit before the authenticated gateway POST goes out.
      const gatewaySide = m === 'gateway-refused' || m === 'no-ticket';
      expect(calls).toHaveLength(gatewaySide ? 2 : 1);
      expect(message).toMatch(/check the clientId\/clientSecret and network/);
      expect(message).not.toContain(SETTINGS.clientSecret);
      // The token URL carries the encoded form, so the raw check alone is blind.
      expect(message).not.toContain(encodeURIComponent(SETTINGS.clientSecret));
      expect(wsState.instances).toHaveLength(0);
      stream.disconnect();
    },
  );

  // A signal that never aborts would satisfy an instanceof check, so pin the
  // deadline itself: one real timeout, at the attempt's horizon. Sharing that
  // horizon is deliberate — a shorter bound would narrow the allowance
  // discovery already had under the attempt budget.
  it('gives discovery the deadline the attempt itself armed, and uses it', async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const created: AbortSignal[] = [];
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((ms: number) => {
        const signal = realTimeout(ms);
        created.push(signal);
        return signal;
      });
    const setTimer = vi.spyOn(globalThis, 'setTimeout');
    const stream = await startOpen();

    expect(timeout).toHaveBeenCalledTimes(1);
    const deadline = timeout.mock.calls[0]![0];
    expect(deadline).toBe(CONNECT_TIMEOUT_MS);
    // Comparing against this file's constant alone would let the attempt arm a
    // different, shorter clock while discovery kept this one — a second, later
    // deadline. Tie it to a delay the attempt actually armed.
    expect(setTimer.mock.calls.map((c) => c[1])).toContain(deadline);
    // And the constructed deadline must be the signal the requests carry, not
    // one that was built and discarded.
    expect(created).toHaveLength(1);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.init?.signal).toBe(created[0]);
    }
    stream.disconnect();
  });

  // The undici double exposes ONLY the default namespace, as the bundled CJS
  // interop does: a named destructure binds undefined and throws before the
  // first request. It also records how the agent was built and destroyed, so
  // "some dispatcher arrived" is not enough to pass.
  const withUndiciDouble = async (
    run: (
      built: Array<Record<string, unknown>>,
      destroys: () => number,
    ) => Promise<void>,
  ) => {
    vi.useRealTimers();
    const built: Array<Record<string, unknown>> = [];
    let destroyed = 0;
    vi.resetModules();
    vi.doMock('undici', () => ({
      default: {
        EnvHttpProxyAgent: class {
          constructor(options: Record<string, unknown>) {
            built.push(options);
          }
          async destroy() {
            destroyed += 1;
          }
        },
      },
    }));
    try {
      await run(built, () => destroyed);
    } finally {
      vi.doUnmock('undici');
      vi.resetModules();
    }
  };

  const PROXY = 'http://proxy.invalid:8080';

  it('builds the proxy dispatcher from the resolved proxy and destroys it', async () => {
    await withUndiciDouble(async (built, destroys) => {
      const fresh = await import('./managed-dingtalk-deps.js');
      const stream = fresh
        .createManagedDingtalkDeps(PROXY)
        .createStreamClient(SETTINGS, () => true);
      const connecting = stream.connect();
      try {
        // Condition wait, not a turn count: a cold dynamic import takes far
        // longer than any fixed number of event-loop turns.
        await vi.waitFor(() => expect(wsState.instances).toHaveLength(1), {
          timeout: 10_000,
        });
        latest().open();
        await connecting;
      } finally {
        // Never leave with a connect in flight: afterEach unstubs fetch.
        stream.disconnect();
      }

      expect(built).toEqual([{ httpProxy: PROXY, httpsProxy: PROXY }]);
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(
          (call.init as { dispatcher?: unknown } | undefined)?.dispatcher,
        ).toBeDefined();
      }
      expect(destroys()).toBe(1);
    });
  });

  it('destroys the proxy dispatcher when discovery fails too', async () => {
    mode = 'transport';
    await withUndiciDouble(async (built, destroys) => {
      const fresh = await import('./managed-dingtalk-deps.js');
      const stream = fresh
        .createManagedDingtalkDeps(PROXY)
        .createStreamClient(SETTINGS, () => true);
      await expect(stream.connect()).rejects.toThrow(
        /check the clientId\/clientSecret and network/,
      );
      stream.disconnect();
      expect(built).toEqual([{ httpProxy: PROXY, httpsProxy: PROXY }]);
      expect(destroys()).toBe(1);
    });
  });

  it('leaves discovery on the ambient dispatcher when no proxy is configured', async () => {
    const stream = await startOpen();
    for (const call of calls) {
      expect(
        (call.init as { dispatcher?: unknown } | undefined)?.dispatcher,
      ).toBeUndefined();
    }
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
      'Accept: "application/json"',
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
