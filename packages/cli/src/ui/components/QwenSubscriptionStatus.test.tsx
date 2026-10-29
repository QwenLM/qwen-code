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
  onSignOut: vi.fn(),
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
        'Open plans again',
        'Use Alibaba ModelStudio instead',
        'Sign out',
      ]);
      for (const action of Object.values(actions))
        expect(action).not.toHaveBeenCalled();
      for (const item of menu.items) menu.onSelect(item.value);
      expect(actions.onCheckAgain).not.toHaveBeenCalled();
      for (const action of [
        actions.onOpenPlans,
        actions.onSwitchProvider,
        actions.onSignOut,
      ])
        expect(action).toHaveBeenCalledOnce();
      ui.unmount();
    },
  );

  it('disables Check again and uses the confirmed checking copy', () => {
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
    expect(items.find((item) => item.key === 'plans')).toBeDefined();
    ui.unmount();
  });

  it('keeps the purchase actions when the caller supplies a query error', () => {
    const message =
      "Couldn't check your subscription status. Please try again.";
    const ui = render(
      <QwenSubscriptionStatus
        status="purchase-required"
        email="starter@example.com"
        plan="Free"
        message={message}
        canCheckAgain
        {...callbacks()}
      />,
    );
    expect(ui.lastFrame()?.replace(/\s+/g, ' ')).toContain(message);
    expect(ui.lastFrame()).toContain('Check again');
    expect(ui.lastFrame()).toContain('Open plans again');
    ui.unmount();
  });

  it('keeps the supplied membership error and Check again action', () => {
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
    expect(menu.items[0]?.title).toBe('Check again');
    menu.onSelect('check');
    expect(onRetry).toHaveBeenCalledOnce();
    ui.unmount();
  });
});
