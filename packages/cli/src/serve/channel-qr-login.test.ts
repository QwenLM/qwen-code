/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  ChannelQrLoginDescriptor,
  ChannelQrLoginHandlers,
} from '@qwen-code/channel-base';
import {
  CHANNEL_QR_LOGIN_MAX_ACTIVE,
  CHANNEL_QR_LOGIN_RETENTION_MS,
  CHANNEL_QR_LOGIN_TTL_MS,
  ChannelQrLoginRegistry,
  TooManyChannelQrLoginsError,
} from './channel-qr-login.js';

function harness() {
  let clock = 1_000;
  let sweep: (() => void) | undefined;
  const persist = vi.fn(async () => {});
  const renderQrCode = vi.fn(async (url: string) => `data:image/png;${url}`);
  const dispose = vi.fn();
  let handlers: ChannelQrLoginHandlers | undefined;
  let signal: AbortSignal | undefined;
  const qrLogin: ChannelQrLoginDescriptor = {
    start: (h, s) => {
      handlers = h;
      signal = s;
      return dispose;
    },
  };
  const registry = new ChannelQrLoginRegistry({
    renderQrCode,
    persist,
    now: () => clock,
    scheduleInterval: (callback) => {
      sweep = callback;
      return { unref() {} } as unknown as ReturnType<typeof setInterval>;
    },
    clearScheduledInterval: () => {},
  });
  const start = (channelName = 'my-qq', initiatorClientId?: string) =>
    registry.start({
      channelType: 'qq',
      channelName,
      qrLogin,
      ...(initiatorClientId !== undefined ? { initiatorClientId } : {}),
    });
  return {
    registry,
    start,
    persist,
    renderQrCode,
    dispose,
    emit: () => handlers!,
    signal: () => signal!,
    advance: (ms: number) => {
      clock += ms;
    },
    runSweep: () => sweep!(),
  };
}

/** Let the promise chains inside the handlers settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('ChannelQrLoginRegistry', () => {
  it('renders the QR payload and never exposes credential values', async () => {
    const h = harness();
    const { view } = h.start();
    expect(view.status).toBe('pending');

    h.emit().onQrCode('https://q.qq.com/connect?task_id=t1');
    await flush();
    const pending = h.registry.get(view.loginId)!;
    expect(pending.qrCodeDataUrl).toBe(
      'data:image/png;https://q.qq.com/connect?task_id=t1',
    );

    h.emit().onSuccess({ appID: 'app-1', appSecret: 'super-secret' });
    await flush();
    const done = h.registry.get(view.loginId)!;
    expect(done.status).toBe('succeeded');
    expect(h.persist).toHaveBeenCalledWith('my-qq', {
      appID: 'app-1',
      appSecret: 'super-secret',
    });
    // The secret reaches persist, never the wire shape.
    expect(JSON.stringify(done)).not.toContain('super-secret');
    expect(done.qrCodeDataUrl).toBeUndefined();
  });

  it('stops upstream polling once the login succeeds', async () => {
    const h = harness();
    const { view } = h.start();
    h.emit().onSuccess({ appID: 'a', appSecret: 's' });
    await flush();
    expect(h.dispose).toHaveBeenCalledOnce();
    expect(h.signal().aborted).toBe(true);
    expect(h.registry.get(view.loginId)!.status).toBe('succeeded');
  });

  it('reports a failed persist as failed rather than succeeded', async () => {
    const h = harness();
    h.persist.mockRejectedValueOnce(new Error('revision conflict'));
    const { view } = h.start();
    h.emit().onSuccess({ appID: 'a', appSecret: 's' });
    await flush();
    const done = h.registry.get(view.loginId)!;
    expect(done.status).toBe('failed');
    expect(done.error).toBe('revision conflict');
  });

  it('drops the stale image when the adapter refreshes an expired code', async () => {
    const h = harness();
    const { view } = h.start();
    h.emit().onQrCode('first');
    await flush();
    expect(h.registry.get(view.loginId)!.qrCodeDataUrl).toBeDefined();

    h.emit().onExpired();
    expect(h.registry.get(view.loginId)!.qrCodeDataUrl).toBeUndefined();
    expect(h.registry.get(view.loginId)!.status).toBe('pending');

    h.emit().onQrCode('second');
    await flush();
    expect(h.registry.get(view.loginId)!.qrCodeDataUrl).toBe(
      'data:image/png;second',
    );
  });

  it('cancels and aborts, and stays idempotent', () => {
    const h = harness();
    const { view } = h.start();
    expect(h.registry.cancel(view.loginId)).toBe(true);
    expect(h.registry.get(view.loginId)!.status).toBe('cancelled');
    expect(h.dispose).toHaveBeenCalledOnce();
    expect(h.signal().aborted).toBe(true);
    expect(h.registry.cancel(view.loginId)).toBe(true);
    expect(h.dispose).toHaveBeenCalledOnce();
    expect(h.registry.cancel('missing')).toBe(false);
  });

  it('expires an abandoned login and stops polling without a client', () => {
    const h = harness();
    const { view } = h.start();
    h.advance(CHANNEL_QR_LOGIN_TTL_MS + 1);
    h.runSweep();
    expect(h.registry.get(view.loginId)!.status).toBe('expired');
    expect(h.dispose).toHaveBeenCalledOnce();
    expect(h.signal().aborted).toBe(true);
  });

  it('reattaches the same pending login instead of starting a second one', () => {
    const h = harness();
    const first = h.start('my-qq', 'client-a');
    const again = h.start('my-qq', 'client-a');
    expect(again.attached).toBe(true);
    expect(again.view.loginId).toBe(first.view.loginId);
    expect(first.attached).toBe(false);
  });

  it('caps concurrent pending logins per workspace', () => {
    const h = harness();
    for (let i = 0; i < CHANNEL_QR_LOGIN_MAX_ACTIVE; i++) h.start(`qq-${i}`);
    expect(() => h.start('one-too-many')).toThrow(TooManyChannelQrLoginsError);
  });

  it('frees a cap slot once a login reaches a terminal state', () => {
    const h = harness();
    const started = [];
    for (let i = 0; i < CHANNEL_QR_LOGIN_MAX_ACTIVE; i++) {
      started.push(h.start(`qq-${i}`));
    }
    h.registry.cancel(started[0]!.view.loginId);
    expect(() => h.start('now-fits')).not.toThrow();
  });

  it('withholds the QR payload from a different client', async () => {
    const h = harness();
    const { view } = h.start('my-qq', 'client-a');
    h.emit().onQrCode('payload');
    await flush();
    expect(
      h.registry.get(view.loginId, 'client-a')!.qrCodeDataUrl,
    ).toBeDefined();
    const other = h.registry.get(view.loginId, 'client-b')!;
    expect(other.qrCodeDataUrl).toBeUndefined();
    // Status stays readable so a second tab can still show progress.
    expect(other.status).toBe('pending');
    expect(h.registry.cancel(view.loginId, 'client-b')).toBe(false);
    expect(h.registry.get(view.loginId)!.status).toBe('pending');
  });

  it('records a synchronous adapter start failure as failed', () => {
    const h = harness();
    const throwing: ChannelQrLoginDescriptor = {
      start: () => {
        throw new Error('connector unavailable');
      },
    };
    const { view } = h.registry.start({
      channelType: 'qq',
      channelName: 'broken',
      qrLogin: throwing,
    });
    expect(view.status).toBe('failed');
    expect(view.error).toBe('connector unavailable');
  });

  it('ignores adapter callbacks that arrive after a terminal state', async () => {
    const h = harness();
    const { view } = h.start();
    h.registry.cancel(view.loginId);
    h.emit().onSuccess({ appID: 'a', appSecret: 's' });
    h.emit().onQrCode('late');
    await flush();
    expect(h.persist).not.toHaveBeenCalled();
    const done = h.registry.get(view.loginId)!;
    expect(done.status).toBe('cancelled');
    expect(done.qrCodeDataUrl).toBeUndefined();
  });

  it('keeps a terminal view readable, then reclaims the entry', () => {
    const h = harness();
    const { view } = h.start();
    h.registry.cancel(view.loginId);
    h.advance(CHANNEL_QR_LOGIN_RETENTION_MS - 1);
    h.runSweep();
    expect(h.registry.get(view.loginId)?.status).toBe('cancelled');
    h.advance(2);
    h.runSweep();
    expect(h.registry.get(view.loginId)).toBeUndefined();
  });

  it('does not grow without bound across start/cancel cycles', () => {
    const h = harness();
    for (let i = 0; i < CHANNEL_QR_LOGIN_MAX_ACTIVE * 3; i++) {
      const { view } = h.start(`cycle-${i}`);
      h.registry.cancel(view.loginId);
      h.advance(CHANNEL_QR_LOGIN_RETENTION_MS + 1);
      h.runSweep();
    }
    // Every entry has been reclaimed, so a fresh login still fits the cap.
    expect(() => h.start('after-cycles')).not.toThrow();
    expect(h.registry.get('missing')).toBeUndefined();
  });

  it('stays cancelled when cancel lands during an in-flight persist', async () => {
    const h = harness();
    let release: (() => void) | undefined;
    h.persist.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { view } = h.start();
    h.emit().onSuccess({ appID: 'a', appSecret: 's' });
    await flush();
    h.registry.cancel(view.loginId);
    release!();
    await flush();
    expect(h.registry.get(view.loginId)!.status).toBe('cancelled');
  });

  it('gives different clients separate logins for the same channel', () => {
    const h = harness();
    const a = h.start('shared-qq', 'client-a');
    const b = h.start('shared-qq', 'client-b');
    expect(b.attached).toBe(false);
    expect(b.view.loginId).not.toBe(a.view.loginId);
  });

  it('dispose stops every session and clears the sweeper', () => {
    const h = harness();
    h.start('a');
    h.start('b');
    h.registry.dispose();
    expect(h.dispose).toHaveBeenCalledTimes(2);
    expect(h.signal().aborted).toBe(true);
  });
});
