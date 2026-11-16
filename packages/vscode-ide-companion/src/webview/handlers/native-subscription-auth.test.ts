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
        signedIn: true,
        plansUrl:
          'https://chat.qwen.ai/?memberPlan=qwen_code&entry=qwen_code&paywallScene=plugin',
      }),
    signOutSubscription: vi
      .fn<Transport['signOutSubscription']>()
      .mockResolvedValue(undefined),
  };
  const isSubscriptionModel = vi.fn().mockResolvedValue(true);
  return {
    picker,
    owner,
    transport,
    isSubscriptionModel,
    run: (action: NativeSubscriptionActionOptions['action']) =>
      runNativeSubscriptionAction({
        transport,
        signal: owner.signal,
        action,
        isSubscriptionModel,
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
    'rechecks login after the %s model query completes',
    async (action) => {
      const f = fixture();
      let finish!: (value: boolean) => void;
      f.isSubscriptionModel.mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
      );
      const result = f.run(action);
      await settle();
      f.transport.getSubscriptionConfig.mockResolvedValue({
        enabled: true,
        signedIn: false,
        plansUrl:
          'https://chat.qwen.ai/?memberPlan=qwen_code&entry=qwen_code&paywallScene=plugin',
      });
      finish(true);
      await settle();
      await expect(result).resolves.toEqual({ kind: 'unavailable' });
      expect(mocks.openExternal).not.toHaveBeenCalled();
      expect(f.transport.signOutSubscription).not.toHaveBeenCalled();
    },
  );
  it.each(['logout', 'upgrade'] as const)(
    'rejects %s when signed out or using another model connection',
    async (action) => {
      for (const signedIn of [false, true]) {
        const f = fixture();
        f.transport.getSubscriptionConfig.mockResolvedValue({
          enabled: true,
          signedIn,
          plansUrl:
            'https://chat.qwen.ai/?memberPlan=qwen_code&entry=qwen_code&paywallScene=plugin',
        });
        f.isSubscriptionModel.mockResolvedValue(false);
        const result = f.run(action);
        await settle();
        expect(f.transport.signOutSubscription).not.toHaveBeenCalled();
        expect(mocks.openExternal).not.toHaveBeenCalled();
        if (action === 'upgrade') f.picker.select('Done');
        await expect(result).resolves.toEqual({ kind: 'unavailable' });
      }
    },
  );
  it.each(['logout', 'upgrade'] as const)(
    'does not perform %s when the subscription capability is disabled',
    async (action) => {
      const f = fixture();
      f.transport.getSubscriptionConfig.mockResolvedValue({ enabled: false });
      const result = f.run(action);
      await settle();
      if (action === 'logout') {
        await expect(result).resolves.toEqual({ kind: 'unavailable' });
        expect(mocks.createQuickPick).not.toHaveBeenCalled();
        return;
      }
      expect(f.picker.status()).toContain('Sign in to Qwen');
      expect(f.transport.signOutSubscription).not.toHaveBeenCalled();
      expect(mocks.openExternal).not.toHaveBeenCalled();
      expect(f.picker.items.map((item) => item.label)).not.toContain('Retry');
      f.picker.select('Done');
      await expect(result).resolves.toEqual({ kind: 'unavailable' });
    },
  );

  it.each(['upgrade'] as const)(
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
        kind: 'upgrade-opened',
      });
    },
  );

  it('logs out without opening a native picker or showing a success row', async () => {
    const f = fixture();
    const result = f.run('logout');
    await settle();
    expect(mocks.createQuickPick).not.toHaveBeenCalled();
    expect(f.transport.signOutSubscription).toHaveBeenCalledOnce();
    expect(f.transport.getSubscriptionConfig).toHaveBeenCalledTimes(2);
    await expect(result).resolves.toEqual({ kind: 'signed-out' });
  });

  it('does not open plans when the model owner is invalidated during the final account check', async () => {
    const f = fixture();
    let finish!: (config: {
      enabled: boolean;
      signedIn: boolean;
      plansUrl: string;
    }) => void;
    f.transport.getSubscriptionConfig
      .mockResolvedValueOnce({
        enabled: true,
        signedIn: true,
        plansUrl:
          'https://chat.qwen.ai/?memberPlan=qwen_code&entry=qwen_code&paywallScene=plugin',
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const result = f.run('upgrade');
    await settle();
    f.owner.abort();
    finish({
      enabled: true,
      signedIn: true,
      plansUrl:
        'https://chat.qwen.ai/?memberPlan=qwen_code&entry=qwen_code&paywallScene=plugin',
    });
    await expect(result).resolves.toEqual({ kind: 'cancelled' });
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('opens upgrade plans directly without starting OAuth or changing account state', async () => {
    const f = fixture();
    const result = f.run('upgrade');
    await settle();
    expect(mocks.openExternal).toHaveBeenCalledWith(
      'https://chat.qwen.ai/?memberPlan=qwen_code&entry=qwen_code&paywallScene=plugin',
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
    finish({
      enabled: true,
      plansUrl:
        'https://chat.qwen.ai/?memberPlan=qwen_code&entry=qwen_code&paywallScene=plugin',
    });
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
      if (stage === 'revoke')
        await expect(result).resolves.toEqual({ kind: 'signed-out' });
      else
        await expect(result).rejects.toMatchObject({
          body: { errorStage: 'cleanup' },
        });
      expect(mocks.createQuickPick).not.toHaveBeenCalled();
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
      expect(mocks.createQuickPick).not.toHaveBeenCalled();
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
