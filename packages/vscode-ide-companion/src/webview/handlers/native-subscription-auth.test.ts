/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runNativeSubscriptionAction,
  type NativeSubscriptionActionOptions,
} from './native-subscription-auth.js';

const mocks = vi.hoisted(() => ({
  createQuickPick: vi.fn(),
  openExternal: vi.fn(async (_url: string) => true),
  warn: vi.fn(),
}));
vi.mock('vscode', () => ({
  window: { createQuickPick: mocks.createQuickPick },
  env: { openExternal: mocks.openExternal },
  Uri: { parse: (url: string) => url },
  QuickPickItemKind: { Separator: -1 },
}));

vi.mock('../../utils/logger.js', () => ({ logger: { warn: mocks.warn } }));

class Picker {
  title = '';
  placeholder = '';
  value = '';
  busy = false;
  ignoreFocusOut = false;
  items: Array<{
    label: string;
    value: string;
    kind?: number;
    detail?: string;
  }> = [];
  selectedItems: Array<{ label: string; value: string }> = [];
  accepts = new Set<() => void>();
  hides = new Set<() => void>();
  show = vi.fn();
  hide = vi.fn(() => this.hides.forEach((callback) => callback()));
  dispose = vi.fn();
  status() {
    return this.items
      .filter((item) => item.kind === -1)
      .map((item) => item.label)
      .join('\n');
  }
  onDidAccept(callback: () => void) {
    this.accepts.add(callback);
    return { dispose: () => this.accepts.delete(callback) };
  }
  onDidHide(callback: () => void) {
    this.hides.add(callback);
    return { dispose: () => this.hides.delete(callback) };
  }
  select(label: string) {
    const item = this.items.find((item) => item.label === label);
    expect(item, `native item ${label}`).toBeDefined();
    this.selectedItems = [item!];
    [...this.accepts].forEach((callback) => callback());
  }
}

type Transport = NativeSubscriptionActionOptions['transport'];
function fixture() {
  const picker = new Picker();
  mocks.createQuickPick.mockReturnValue(picker);
  const owner = new AbortController();
  const transport = {
    getSubscriptionConfig: vi
      .fn<Transport['getSubscriptionConfig']>()
      .mockResolvedValue({
        enabled: true,
        plansUrl: 'https://chat.qwen.ai/plans',
      }),
    signOutSubscription: vi
      .fn<Transport['signOutSubscription']>()
      .mockResolvedValue(undefined),
  };
  return {
    picker,
    owner,
    transport,
    run: (action: NativeSubscriptionActionOptions['action']) =>
      runNativeSubscriptionAction({
        transport,
        signal: owner.signal,
        action,
      }),
  };
}
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('native subscription authentication', () => {
  it.each(['logout', 'upgrade'] as const)(
    'does not perform %s when the subscription capability is disabled',
    async (action) => {
      const f = fixture();
      f.transport.getSubscriptionConfig.mockResolvedValue({ enabled: false });
      const result = f.run(action);
      await settle();
      expect(f.picker.status()).toContain('not available');
      expect(f.transport.signOutSubscription).not.toHaveBeenCalled();
      expect(mocks.openExternal).not.toHaveBeenCalled();
      expect(f.picker.items.map((item) => item.label)).not.toContain('Retry');
      f.picker.select('Done');
      await expect(result).resolves.toEqual({ kind: 'unavailable' });
    },
  );

  it.each(['logout', 'upgrade'] as const)(
    'offers only a usable Retry after a shortcut %s failure',
    async (action) => {
      const f = fixture();
      f.transport.getSubscriptionConfig.mockRejectedValueOnce(
        new Error('offline'),
      );
      const result = f.run(action);
      await settle();
      expect(f.picker.items.map((item) => item.label)).toContain('Retry');
      expect(f.picker.items.map((item) => item.label)).not.toContain(
        'Use another provider',
      );
      f.picker.select('Retry');
      await settle();
      f.picker.select('Done');
      await expect(result).resolves.toEqual({
        kind: action === 'logout' ? 'signed-out' : 'upgrade-opened',
      });
    },
  );

  it('logs out directly with a native status row without starting OAuth', async () => {
    const f = fixture();
    const result = f.run('logout');
    await settle();
    expect(f.picker.status()).toBe('Signed out of Qwen');
    expect(f.transport.signOutSubscription).toHaveBeenCalledOnce();
    expect(f.transport.getSubscriptionConfig).toHaveBeenCalledOnce();
    f.picker.select('Done');
    await expect(result).resolves.toEqual({ kind: 'signed-out' });
  });

  it('opens upgrade plans directly without starting OAuth or changing account state', async () => {
    const f = fixture();
    const result = f.run('upgrade');
    await settle();
    expect(mocks.openExternal).toHaveBeenCalledWith(
      'https://chat.qwen.ai/plans',
    );
    expect(f.picker.status()).toContain('plans opened');
    expect(f.transport.signOutSubscription).not.toHaveBeenCalled();
    f.picker.select('Done');
    await expect(result).resolves.toEqual({ kind: 'upgrade-opened' });
  });

  it('does not open plans when the owner changes while fetching upgrade configuration', async () => {
    const f = fixture();
    let finish!: (config: { enabled: boolean; plansUrl: string }) => void;
    f.transport.getSubscriptionConfig.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const result = f.run('upgrade');
    await settle();
    expect(f.picker.status()).toBe('Checking your Qwen account…');
    expect(f.picker.placeholder).toBe('Filter options');
    f.owner.abort();
    finish({ enabled: true, plansUrl: 'https://chat.qwen.ai/plans' });
    await expect(result).resolves.toEqual({ kind: 'cancelled' });
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('offers Retry when the browser refuses to open plans', async () => {
    const f = fixture();
    mocks.openExternal.mockResolvedValueOnce(false);
    const result = f.run('upgrade');
    await settle();
    expect(f.picker.status()).toContain('Unable to open');
    f.picker.select('Retry');
    await settle();
    f.picker.select('Done');
    await expect(result).resolves.toEqual({ kind: 'upgrade-opened' });
  });

  it.each(['revoke', 'cleanup'] as const)(
    'distinguishes a %s failure from successful local signout',
    async (stage) => {
      const f = fixture();
      f.transport.signOutSubscription.mockRejectedValueOnce({
        body: { errorStage: stage },
      });
      const result = f.run('logout');
      await settle();
      expect(f.picker.status()).toContain(
        stage === 'revoke' ? 'Signed out locally' : 'Unable to sign out',
      );
      f.picker.hide();
      await expect(result).resolves.toEqual({
        kind: stage === 'revoke' ? 'signed-out' : 'cancelled',
      });
    },
  );

  it.each([false, true])(
    'keeps completed local signout after closing the picker (owner aborted: %s)',
    async (abortOwner) => {
      const f = fixture();
      let finish!: () => void;
      f.transport.signOutSubscription.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const result = f.run('logout');
      await settle();
      f.picker.hide();
      if (abortOwner) f.owner.abort();
      finish();
      await expect(result).resolves.toEqual({
        kind: abortOwner ? 'cancelled' : 'signed-out',
      });
      expect(f.picker.dispose).toHaveBeenCalledOnce();
    },
  );

  it('respects Retry-After and logs only safe error metadata', async () => {
    vi.useRealTimers();
    const f = fixture();
    f.transport.getSubscriptionConfig.mockRejectedValueOnce({
      status: 429,
      body: {
        code: 'rate_limited',
        retryAfterMs: 1000,
        access_token: 'private-secret',
      },
    });
    const result = f.run('upgrade');
    await vi.waitFor(() => {
      expect(f.picker.status()).toContain('Waiting before retry');
      expect(f.picker.items.some((item) => item.label === 'Retry')).toBe(false);
    });
    await vi.waitFor(
      () => {
        expect(f.picker.items.some((item) => item.label === 'Retry')).toBe(
          true,
        );
      },
      { timeout: 2000 },
    );
    expect(mocks.warn).toHaveBeenCalledWith(
      '[QwenSubscription] Request failed',
      {
        code: 'rate_limited',
        status: 429,
        action: 'upgrade',
      },
    );
    expect(
      JSON.stringify([f.picker.items, mocks.warn.mock.calls]),
    ).not.toContain('private-secret');
    f.picker.select('Retry');
    await vi.waitFor(() => expect(f.picker.status()).toContain('plans opened'));
    f.picker.select('Done');
    await expect(result).resolves.toEqual({ kind: 'upgrade-opened' });
  });
});
