/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QwenSubscriptionStatus } from './QwenSubscriptionStatus.js';
import { DescriptiveRadioButtonSelect } from './shared/DescriptiveRadioButtonSelect.js';
import { setLanguageAsync } from '../../i18n/index.js';

vi.mock('../hooks/useKeypress.js', () => ({ useKeypress: vi.fn() }));
vi.mock('./shared/DescriptiveRadioButtonSelect.js', () => ({
  DescriptiveRadioButtonSelect: vi.fn(({ items }) => (
    <Text>
      {items
        .map(
          (item: { title: string; description: string }) =>
            `${item.title} ${item.description}`,
        )
        .join('\n')}
    </Text>
  )),
}));
const callbacks = () => ({
  onOpenPlans: vi.fn(),
  onCheckAgain: vi.fn(),
  onSwitchProvider: vi.fn(),
  onUseAnotherAccount: vi.fn(),
});

describe('QwenSubscriptionStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['Free', 'Go'] as const)(
    'uses the PRD purchase copy for %s and delegates actions',
    (plan) => {
      const actions = callbacks();
      const ui = render(
        <QwenSubscriptionStatus
          status="purchase-required"
          email="starter@example.com"
          plan={plan}
          {...actions}
        />,
      );
      const frame = ui.lastFrame()?.replace(/\s+/g, ' ');
      expect(frame).toContain(
        `Signed in as starter@example.com (Qwen ${plan})`,
      );
      expect(frame).toContain(`You're signed in with a ${plan} account`);
      expect(frame).toContain(
        'Waiting for your subscription to become active…',
      );
      expect(frame).not.toContain('Current plan:');
      expect(frame).not.toContain('Enter to open plans');
      const menu = vi
        .mocked(DescriptiveRadioButtonSelect)
        .mock.calls.at(-1)![0];
      expect(menu.items.map((item) => item.title)).toEqual([
        'View Plans',
        'Switch Provider',
        'Use another account',
      ]);
      for (const action of Object.values(actions))
        expect(action).not.toHaveBeenCalled();
      for (const item of menu.items) menu.onSelect(item.value);
      expect(actions.onCheckAgain).not.toHaveBeenCalled();
      for (const action of [
        actions.onOpenPlans,
        actions.onSwitchProvider,
        actions.onUseAnotherAccount,
      ])
        expect(action).toHaveBeenCalledOnce();
      ui.unmount();
    },
  );

  it('disables Retry Connection and uses the confirmed checking copy', () => {
    const ui = render(
      <QwenSubscriptionStatus
        status="purchase-required"
        email="starter@example.com"
        plan="Free"
        checking
        canCheckAgain
        {...callbacks()}
      />,
    );
    expect(ui.lastFrame()).toContain('Checking your subscription…');
    const items = vi.mocked(DescriptiveRadioButtonSelect).mock.calls.at(-1)![0]
      .items;
    expect(items.find((item) => item.key === 'check')?.disabled).toBe(true);
    expect(items.map((item) => item.title)).toEqual([
      'Retry Connection',
      'Use another account',
    ]);
    ui.unmount();
  });

  it('offers retry and account switching after a failed membership recheck', () => {
    const actions = callbacks();
    const message =
      "Couldn't check your subscription status. Please try again.";
    const ui = render(
      <QwenSubscriptionStatus
        status="purchase-required"
        email="starter@example.com"
        plan="Free"
        message={message}
        canCheckAgain
        {...actions}
      />,
    );
    expect(ui.lastFrame()?.replace(/\s+/g, ' ')).toContain(message);
    expect(ui.lastFrame()).toContain('Retry Connection');
    expect(ui.lastFrame()).not.toContain('View Plans');
    expect(ui.lastFrame()).not.toContain('Switch Provider');
    expect(ui.lastFrame()).not.toContain('Sign out');
    const menu = vi.mocked(DescriptiveRadioButtonSelect).mock.calls.at(-1)![0];
    expect(menu.items).toHaveLength(2);
    menu.onSelect(menu.items[0]!.value);
    expect(actions.onCheckAgain).toHaveBeenCalledOnce();
    expect(actions.onOpenPlans).not.toHaveBeenCalled();
    expect(actions.onSwitchProvider).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('keeps the supplied membership error and Retry Connection action', () => {
    const onRetry = vi.fn();
    const ui = render(
      <QwenSubscriptionStatus
        status="error"
        message="Subscription service unavailable"
        onRetry={onRetry}
      />,
    );
    expect(ui.lastFrame()).toContain('Subscription service unavailable');
    const menu = vi.mocked(DescriptiveRadioButtonSelect).mock.calls.at(-1)![0];
    expect(menu.items[0]?.title).toBe('Retry Connection');
    menu.onSelect('check');
    expect(onRetry).toHaveBeenCalledOnce();
    ui.unmount();
  });

  it.each([
    ['zh', '查看套餐', '切换供应商', '重试', '使用其他账号'],
    ['zh-TW', '檢視方案', '切換供應商', '重試', '使用其他帳號'],
  ])(
    'localizes purchase and retry actions in %s',
    async (language, plans, provider, retry, account) => {
      await setLanguageAsync(language);
      const actions = callbacks();
      const ui = render(
        <QwenSubscriptionStatus
          status="purchase-required"
          email="starter@example.com"
          plan="Free"
          {...actions}
        />,
      );
      try {
        const menu = vi
          .mocked(DescriptiveRadioButtonSelect)
          .mock.calls.at(-1)![0];
        expect(menu.items.map((item) => item.title)).toEqual([
          plans,
          provider,
          account,
        ]);
        ui.rerender(
          <QwenSubscriptionStatus
            status="purchase-required"
            email="starter@example.com"
            plan="Free"
            canCheckAgain
            {...actions}
          />,
        );
        await vi.waitFor(() => {
          const retryMenu = vi
            .mocked(DescriptiveRadioButtonSelect)
            .mock.calls.at(-1)![0];
          expect(retryMenu.items.map((item) => item.title)).toEqual([
            retry,
            account,
          ]);
        });
      } finally {
        ui.unmount();
        await setLanguageAsync('en');
      }
    },
  );
});
