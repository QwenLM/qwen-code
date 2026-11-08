import { afterEach, expect, it, vi } from 'vitest';
import { DaemonTransportClosedError } from '@qwen-code/sdk/daemon';
import {
  DaemonAvailability,
  DaemonUnavailableError,
  createDaemonClient,
  findDaemonAvailability,
  registerDaemonAvailability,
} from './availability.js';

const connections: DaemonAvailability[] = [];
afterEach(() => {
  for (const connection of connections) connection.dispose();
  connections.length = 0;
  vi.useRealTimers();
});

function connectionWith(
  native: typeof fetch,
  baseUrl = 'https://daemon',
  token?: string,
) {
  const connection = new DaemonAvailability(baseUrl, token, native);
  connections.push(connection);
  return connection;
}

const health = () => Response.json({ status: 'ok' });
const capabilities = () => Response.json({ features: ['test'] });

it.each(['sync', 'async'] as const)(
  'keeps probing when a recovery listener immediately sees a %s fetch failure',
  async (mode) => {
    vi.useFakeTimers();
    const native = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockImplementation((input: string) =>
        Promise.resolve(input.endsWith('/health') ? health() : capabilities()),
      );
    const connection = connectionWith(native);
    let failed = false;
    const request = connection.wrapFetch(() => {
      if (mode === 'sync') throw new TypeError('recovery read failed');
      return Promise.reject(new TypeError('recovery read failed'));
    });
    connection.subscribe(() => {
      if (connection.getSnapshot() === 'available' && !failed) {
        failed = true;
        void request('/catalog').catch(() => {});
      }
    });
    await connection.check();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(failed).toBe(true);
    expect(connection.getSnapshot()).toBe('available');
    expect(native).toHaveBeenCalledTimes(5);
  },
);

it('closes business traffic synchronously and uses one bounded 5/15/30-second recovery loop', async () => {
  vi.useFakeTimers();
  const native = vi.fn().mockRejectedValue(new TypeError('offline'));
  const connection = connectionWith(native, 'https://daemon/', 'secret');
  const business = vi.fn().mockRejectedValue(new TypeError('offline'));
  const request = connection.wrapFetch(business);
  await expect(request('https://daemon/goals')).rejects.toThrow('offline');
  expect(connection.getSnapshot()).toBe('unavailable');
  await expect(request('https://daemon/goals')).rejects.toBeInstanceOf(
    DaemonUnavailableError,
  );
  expect(business).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(0);
  expect(native).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(native).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(native).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(native).toHaveBeenCalledTimes(3);
  native.mockResolvedValueOnce(health()).mockResolvedValueOnce(capabilities());
  await vi.advanceTimersByTimeAsync(30_000);
  expect(native).toHaveBeenCalledTimes(5);
  expect(native.mock.calls.map(([url]) => url)).toEqual([
    'https://daemon/health',
    'https://daemon/health',
    'https://daemon/health',
    'https://daemon/health',
    'https://daemon/capabilities',
  ]);
  expect(
    new Headers(native.mock.calls[0][1].headers).get('authorization'),
  ).toBe('Bearer secret');
  expect(native.mock.calls[0][1].cache).toBe('no-store');
  expect(connection.getSnapshot()).toBe('available');
  expect(connection.recoveredCapabilities?.features).toEqual(['test']);
  // Recovery never sends the rejected business operation again.
  expect(business).toHaveBeenCalledTimes(1);
});

it('honours a Retry-After hint from a cold-starting daemon', async () => {
  vi.useFakeTimers();
  const native = vi
    .fn()
    .mockResolvedValueOnce(health())
    .mockResolvedValueOnce(
      new Response('', { status: 503, headers: { 'retry-after': '1' } }),
    );
  const connection = connectionWith(native);
  await connection.check();
  expect(connection.getSnapshot()).toBe('unavailable');
  await vi.advanceTimersByTimeAsync(999);
  expect(native).toHaveBeenCalledTimes(2);
  native.mockResolvedValueOnce(health()).mockResolvedValueOnce(capabilities());
  await vi.advanceTimersByTimeAsync(1);
  expect(native).toHaveBeenCalledTimes(4);
  expect(connection.getSnapshot()).toBe('available');
});

it('clamps an excessive Retry-After to the operator-patience ceiling', async () => {
  vi.useFakeTimers();
  const native = vi
    .fn()
    .mockResolvedValueOnce(health())
    .mockResolvedValueOnce(
      new Response('', { status: 503, headers: { 'retry-after': '600' } }),
    );
  const connection = connectionWith(native);
  await connection.check();
  await vi.advanceTimersByTimeAsync(29_999);
  expect(native).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(native).toHaveBeenCalledTimes(3);
});

it('gives each probe leg its own deadline', async () => {
  vi.useFakeTimers();
  const slow =
    (response: () => Response) => (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason),
        );
        setTimeout(() => resolve(response()), 4_000);
      });
  const native = vi
    .fn()
    .mockImplementationOnce(slow(health))
    .mockImplementationOnce(slow(capabilities));
  const connection = connectionWith(native);
  const check = connection.check();
  await vi.advanceTimersByTimeAsync(8_000);
  await check;
  expect(native).toHaveBeenCalledTimes(2);
  expect(connection.getSnapshot()).toBe('available');
});

it('coalesces checks and does not overlap a slow probe with foreground retries', async () => {
  vi.useFakeTimers();
  const native = vi.fn(
    (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason),
        );
      }),
  );
  const connection = connectionWith(native);
  const first = connection.check();
  expect(connection.check()).toBe(first);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(native).toHaveBeenCalledTimes(1);
  expect(connection.check()).toBe(first);
  await vi.advanceTimersByTimeAsync(1);
  await first;
  expect(connection.getSnapshot()).toBe('unavailable');
  await vi.advanceTimersByTimeAsync(5_000);
  expect(native).toHaveBeenCalledTimes(2);
});

it('requires authenticated capabilities before resuming and stops retrying rejected credentials', async () => {
  vi.useFakeTimers();
  const native = vi
    .fn()
    .mockResolvedValueOnce(health())
    .mockResolvedValueOnce(new Response('', { status: 401 }));
  const connection = connectionWith(native, 'https://daemon', 'old');
  await connection.check();
  expect(connection.getSnapshot()).toBe('auth-required');
  await vi.advanceTimersByTimeAsync(120_000);
  expect(native).toHaveBeenCalledTimes(2);
});

it('does not treat business rejection or intentional cancellation as an outage', async () => {
  const native = vi.fn();
  const connection = connectionWith(native);
  const controller = new AbortController();
  controller.abort();
  connection.reportFailure(new TypeError('aborted fetch'), controller.signal);
  connection.reportFailure({ status: 400 });
  connection.reportFailure({ status: 403 });
  connection.reportFailure({ status: 404 });
  connection.reportFailure({ status: 409 });
  expect(connection.getSnapshot()).toBe('available');
  expect(native).not.toHaveBeenCalled();
});

it.each([401, 502, 503, 504])(
  'diagnoses endpoint %s without suspending a healthy connection',
  async (status) => {
    const native = vi
      .fn()
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(capabilities());
    const connection = connectionWith(native);
    const listener = vi.fn();
    connection.subscribe(listener);
    connection.reportFailure({ status });
    expect(connection.getSnapshot()).toBe('available');
    expect(listener).not.toHaveBeenCalled();
    await connection.check();
    expect(connection.getSnapshot()).toBe('available');
    expect(listener).toHaveBeenCalledOnce();
    expect(connection.recoveredCapabilities?.features).toEqual(['test']);
  },
);

it('diagnoses consumer TypeErrors without declaring a healthy daemon unavailable', async () => {
  let release!: (response: Response) => void;
  const native = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValueOnce(capabilities());
  const connection = connectionWith(native);
  const listener = vi.fn();
  connection.subscribe(listener);
  connection.reportFailure(new TypeError('Cannot read properties of null'));
  const check = connection.check();
  await Promise.resolve();
  expect(connection.getSnapshot()).toBe('available');
  expect(connection.getGeneration()).toBe(0);
  expect(listener).not.toHaveBeenCalled();
  const business = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  await expect(
    connection.wrapFetch(business)('/goals'),
  ).resolves.toBeInstanceOf(Response);
  release(health());
  await check;
  expect(connection.getSnapshot()).toBe('available');
  expect(connection.getGeneration()).toBe(0);
  expect(native).toHaveBeenCalledTimes(2);
});

it('closes the gate when a custom transport fetch rejects with TypeError', async () => {
  const native = vi.fn().mockRejectedValue(new TypeError('offline'));
  const connection = connectionWith(native);
  const transport = connection.wrapTransport({
    fetch: vi.fn().mockRejectedValue(new TypeError('network failed')),
    subscribeEvents: vi.fn(),
    dispose: vi.fn(),
  } as unknown as import('@qwen-code/sdk/daemon').DaemonTransport);
  await expect(transport.fetch('/goals', {})).rejects.toThrow('network failed');
  expect(connection.getSnapshot()).toBe('unavailable');
  expect(connection.getGeneration()).toBe(1);
});

it('ignores pre-outage request failures that arrive after a successful recovery', async () => {
  let rejectOld!: (error: unknown) => void;
  let completeOld!: (response: Response) => void;
  const native = vi
    .fn()
    .mockResolvedValueOnce(health())
    .mockResolvedValueOnce(capabilities());
  const connection = connectionWith(native);
  const business = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((_resolve, reject) => {
          rejectOld = reject;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          completeOld = resolve;
        }),
    );
  const request = connection.wrapFetch(business);
  const oldFailure = request('/old').catch((error) => error);
  const oldResponse = request('/slow');
  connection.reportFailure(new DaemonTransportClosedError('offline'));
  await connection.check();
  expect(connection.getSnapshot()).toBe('available');
  rejectOld(new DOMException('timeout', 'TimeoutError'));
  completeOld(new Response('', { status: 503 }));
  await oldFailure;
  await oldResponse;
  expect(connection.getSnapshot()).toBe('available');
  expect(native).toHaveBeenCalledTimes(2);
});

it('rechecks an outage discovered while an older diagnostic probe is in flight', async () => {
  let completeOld!: (response: Response) => void;
  const native = vi
    .fn()
    .mockResolvedValueOnce(health())
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          completeOld = resolve;
        }),
    )
    .mockRejectedValue(new TypeError('offline'));
  const connection = connectionWith(native);
  connection.reportFailure({ status: 503 });
  const oldProbe = connection.check();
  await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(2));
  connection.reportFailure(new DaemonTransportClosedError('new outage'));
  expect(connection.getSnapshot()).toBe('unavailable');
  completeOld(capabilities());
  await oldProbe;
  await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(3));
  expect(connection.getSnapshot()).toBe('unavailable');
  expect(connection.recoveredCapabilities).toBeUndefined();
  expect(native).toHaveBeenCalledTimes(3);
});

it('does not let late successes restore a disposed connection and cancels waiters', async () => {
  let release!: (response: Response) => void;
  const native = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValueOnce(capabilities());
  const connection = connectionWith(native);
  connection.reportFailure(new DaemonTransportClosedError('offline'));
  const check = connection.check();
  await Promise.resolve();
  const signal = new AbortController();
  const cancelled = connection
    .waitUntilAvailable(signal.signal)
    .catch((error) => error);
  signal.abort();
  expect((await cancelled).name).toBe('AbortError');
  const waiter = connection.waitUntilAvailable().catch((error) => error);
  connection.dispose();
  expect(await waiter).toBeInstanceOf(DaemonUnavailableError);
  release(health());
  await check;
  expect(native).toHaveBeenCalledTimes(1);
  expect(connection.getSnapshot()).toBe('unavailable');
});

it('rechecks the gate after an event subscription wait resolves', async () => {
  const native = vi.fn().mockRejectedValue(new TypeError('offline'));
  const connection = connectionWith(native);
  const subscribe = vi.fn(async function* () {});
  const transport = connection.wrapTransport({
    fetch: vi.fn(),
    subscribeEvents: subscribe,
    dispose: vi.fn(),
  } as unknown as import('@qwen-code/sdk/daemon').DaemonTransport);
  const subscription = transport
    .subscribeEvents('session', { signal: new AbortController().signal })
    .next();
  connection.reportFailure(new DaemonTransportClosedError('offline'));
  await expect(subscription).rejects.toBeInstanceOf(DaemonUnavailableError);
  expect(subscribe).not.toHaveBeenCalled();
});

it('gates both native REST and custom transport calls through the shared connection', async () => {
  const native = vi.fn().mockRejectedValue(new TypeError('offline'));
  const transportFetch = vi.fn().mockResolvedValue(Response.json({}));
  const connection = connectionWith(native, 'http://localhost');
  const unregister = registerDaemonAvailability(
    'http://localhost/',
    undefined,
    connection,
  );
  expect(findDaemonAvailability('http://localhost')).toBe(connection);
  const client = createDaemonClient({
    baseUrl: 'http://localhost',
    transport: {
      fetch: transportFetch,
      restFetch: native,
      dispose: vi.fn(),
    } as unknown as import('@qwen-code/sdk/daemon').DaemonTransport,
  });
  await expect(client.requestRest('/goals', {}, 0)).rejects.toThrow('offline');
  await expect(client.capabilities()).rejects.toBeInstanceOf(
    DaemonUnavailableError,
  );
  expect(transportFetch).not.toHaveBeenCalled();
  unregister();
});

it('keeps healthy traffic open when a caller or SDK deadline expires', async () => {
  for (const mode of ['caller', 'sdk', 'caller-type-error']) {
    const callerOwned = mode !== 'sdk';
    const native = vi
      .fn()
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(capabilities());
    const connection = connectionWith(native);
    const controller = new AbortController();
    const error = new DOMException('deadline', 'TimeoutError');
    if (callerOwned) controller.abort(error);
    connection.reportFailure(
      mode === 'caller-type-error' ? new TypeError('aborted') : error,
      callerOwned ? controller.signal : undefined,
    );
    expect(connection.getSnapshot()).toBe('available');
    expect(connection.getGeneration()).toBe(0);
    await connection.check();
    expect(connection.getSnapshot()).toBe('available');
  }
});

it('keeps ordinary checks inside the recovery schedule and permits an immediate retry', async () => {
  vi.useFakeTimers();
  const native = vi.fn().mockRejectedValue(new TypeError('offline'));
  const connection = connectionWith(native);
  await connection.check();
  for (let i = 0; i < 4; i++) {
    await vi.advanceTimersByTimeAsync(1000);
    await connection.check();
  }
  expect(native).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(native).toHaveBeenCalledTimes(2);
  native.mockResolvedValueOnce(health()).mockResolvedValueOnce(capabilities());
  await connection.check(true);
  expect(connection.getSnapshot()).toBe('available');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(native).toHaveBeenCalledTimes(4);
});

it('ignores ordinary checks after authentication rejection until explicit retry', async () => {
  const native = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 401 }));
  const connection = connectionWith(native);
  await connection.check();
  await connection.check();
  expect(native).toHaveBeenCalledTimes(1);
  native.mockResolvedValueOnce(health()).mockResolvedValueOnce(capabilities());
  await connection.check(true);
  expect(connection.getSnapshot()).toBe('available');
});
