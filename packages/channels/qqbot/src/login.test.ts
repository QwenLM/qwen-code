import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelAuthContext } from '@qwen-code/channel-base';
import type {
  QrConnectCallbacks,
  QrConnectCredentials,
} from '@tencent-connect/qqbot-connector';

const { connector, stop } = vi.hoisted(() => ({
  connector: {
    callbacks: undefined as QrConnectCallbacks | undefined,
    options: undefined as
      | { displayQrCodeToConsole?: boolean; signal?: AbortSignal }
      | undefined,
  },
  stop: vi.fn(),
}));

vi.mock('@tencent-connect/qqbot-connector', () => ({
  qrConnect: vi
    .fn()
    .mockResolvedValue([
      { appId: 'standalone-id', appSecret: 'standalone-secret' },
    ]),
  startQrConnect: vi.fn((callbacks, options) => {
    connector.callbacks = callbacks;
    connector.options = options;
    return stop;
  }),
}));

const { loadCredentials } = await import('./accounts.js');
const { authDriver, qrCodeLogin } = await import('./login.js');
const { plugin } = await import('./index.js');

afterEach(() => {
  connector.callbacks = undefined;
  connector.options = undefined;
  stop.mockClear();
  vi.restoreAllMocks();
});

function context(signal = new AbortController().signal): ChannelAuthContext {
  return {
    channelName: 'work-bot',
    stateDir: mkdtempSync(join(tmpdir(), 'qq-auth-')),
    signal,
  };
}

describe('QQ QR auth driver', () => {
  it('keeps standalone QR login behavior unchanged', async () => {
    await expect(qrCodeLogin()).resolves.toEqual({
      appId: 'standalone-id',
      appSecret: 'standalone-secret',
    });
  });

  it('is advertised as the runtime driver behind serializable QR metadata', () => {
    expect(plugin.management?.auth).toEqual(['qr']);
    expect(plugin.authDriver).toBe(authDriver);
    expect(JSON.stringify(plugin.management)).not.toContain('authDriver');
  });

  it('publishes revisioned QR URLs without writing to stdout', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const session = await authDriver.begin(context());

    connector.callbacks?.onQrDisplayed?.('https://qq.example/qr/1');
    expect(session.snapshot()).toEqual({
      state: 'pending',
      qrPayload: 'https://qq.example/qr/1',
      qrRevision: 1,
    });
    expect(JSON.parse(JSON.stringify(session.snapshot()))).toEqual(
      session.snapshot(),
    );
    connector.callbacks?.onQrExpired?.();
    expect(session.snapshot().state).toBe('refreshing');
    connector.callbacks?.onQrDisplayed?.('https://qq.example/qr/2');
    expect(session.snapshot()).toEqual({
      state: 'pending',
      qrPayload: 'https://qq.example/qr/2',
      qrRevision: 2,
    });
    expect(connector.options?.displayQrCodeToConsole).toBe(false);
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it('keeps confirmed credentials in memory until commit', async () => {
    const authContext = context();
    const session = await authDriver.begin(authContext);

    connector.callbacks?.onSuccess([{ appId: 'id', appSecret: 'secret' }]);
    const credentials = await session.ready;
    expect(session.snapshot().state).toBe('confirmed');
    expect(JSON.stringify(session.snapshot())).not.toContain('secret');
    expect(
      loadCredentials(join(authContext.stateDir, 'credentials.json')),
    ).toBeNull();

    await session.commit(credentials);
    expect(
      loadCredentials(join(authContext.stateDir, 'credentials.json')),
    ).toEqual({ appId: 'id', appSecret: 'secret' });
  });

  it('fails when the connector succeeds without usable credentials', async () => {
    const session = await authDriver.begin(context());

    connector.callbacks?.onSuccess([]);

    await expect(session.ready).rejects.toThrow(
      'QR login failed: no credentials returned',
    );
    expect(session.snapshot().state).toBe('failed');
  });

  it('rejects non-string connector credentials', async () => {
    const session = await authDriver.begin(context());

    connector.callbacks?.onSuccess([
      { appId: 123, appSecret: 'secret' },
    ] as unknown as QrConnectCredentials[]);

    await expect(session.ready).rejects.toThrow(
      'QR login failed: no credentials returned',
    );
    expect(session.snapshot().state).toBe('failed');
  });

  it('invokes connector stop and aborts the signal on cancel', async () => {
    const session = await authDriver.begin(context());
    const connectorSignal = connector.options?.signal;
    stop.mockImplementationOnce(() => {
      connector.callbacks?.onFailure(new Error('cancelled'));
    });

    session.cancel();

    expect(stop).toHaveBeenCalledOnce();
    expect(connectorSignal?.aborted).toBe(true);
    await expect(session.ready).rejects.toMatchObject({ name: 'AbortError' });
    connector.callbacks?.onFailure(new Error('cancelled'));
    expect(session.snapshot().state).toBe('cancelled');
  });

  it('cancels once and ignores callbacks after cancellation', async () => {
    const session = await authDriver.begin(context());

    session.cancel();
    session.cancel();
    connector.callbacks?.onQrDisplayed?.('https://qq.example/late');
    connector.callbacks?.onSuccess([
      { appId: 'late-id', appSecret: 'late-secret' },
    ]);

    await expect(session.ready).rejects.toMatchObject({ name: 'AbortError' });
    expect(stop).toHaveBeenCalledOnce();
    expect(session.snapshot()).toEqual({
      state: 'cancelled',
      qrPayload: undefined,
      qrRevision: 0,
    });
  });

  it('classifies caller-context abort as cancellation', async () => {
    const controller = new AbortController();
    const session = await authDriver.begin(context(controller.signal));

    controller.abort();
    expect(connector.options?.signal?.aborted).toBe(true);
    connector.callbacks?.onFailure(new Error('已取消'));

    await expect(session.ready).rejects.toMatchObject({ name: 'AbortError' });
    expect(session.snapshot().state).toBe('cancelled');
  });

  it('settles immediately on caller abort and ignores late connector callbacks', async () => {
    const controller = new AbortController();
    const authContext = context(controller.signal);
    const session = await authDriver.begin(authContext);
    const ready = session.ready.catch((error: unknown) => error);

    controller.abort();

    expect(session.snapshot()).toEqual({
      state: 'cancelled',
      qrPayload: undefined,
      qrRevision: 0,
    });
    connector.callbacks?.onQrDisplayed?.('https://qq.example/late');
    connector.callbacks?.onQrExpired?.();
    connector.callbacks?.onSuccess([
      { appId: 'late-id', appSecret: 'late-secret' },
    ]);

    await expect(ready).resolves.toMatchObject({ name: 'AbortError' });
    expect(session.snapshot()).toEqual({
      state: 'cancelled',
      qrPayload: undefined,
      qrRevision: 0,
    });
    await expect(session.commit()).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(
      loadCredentials(join(authContext.stateDir, 'credentials.json')),
    ).toBeNull();
  });

  it('removes the context abort listener after successful settlement', async () => {
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(
      controller.signal,
      'removeEventListener',
    );
    const session = await authDriver.begin(context(controller.signal));

    connector.callbacks?.onSuccess([{ appId: 'id', appSecret: 'secret' }]);

    await expect(session.ready).resolves.toEqual({
      appId: 'id',
      appSecret: 'secret',
    });
    expect(removeEventListener).toHaveBeenCalledWith(
      'abort',
      expect.any(Function),
    );
    controller.abort();
    expect(session.snapshot().state).toBe('confirmed');
  });

  it('propagates connector failures without persisting credentials', async () => {
    const authContext = context();
    const session = await authDriver.begin(authContext);

    connector.callbacks?.onFailure(new Error('connector failed'));

    await expect(session.ready).rejects.toThrow('connector failed');
    expect(session.snapshot().state).toBe('failed');
    expect(
      loadCredentials(join(authContext.stateDir, 'credentials.json')),
    ).toBeNull();
  });
});
