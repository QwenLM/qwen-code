// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider, type WebShellLanguage } from '../../i18n';
import {
  QwenSubscriptionStatus,
  type QwenSubscriptionState,
} from './QwenSubscriptionStatus';

let root: Root | undefined;
let container: HTMLDivElement;

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  root = undefined;
});

function render(
  state: QwenSubscriptionState,
  language: WebShellLanguage = 'en',
) {
  const callbacks = {
    onOpenAuthorization: vi.fn(),
    onOpenPurchase: vi.fn(),
    onRetry: vi.fn(),
    onCancel: vi.fn(),
    onSwitchProvider: vi.fn(),
    onSignOut: vi.fn(),
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <I18nProvider language={language}>
        <QwenSubscriptionStatus state={state} {...callbacks} />
      </I18nProvider>,
    );
  });
  return callbacks;
}

function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(
    (item) =>
      item.getAttribute('aria-label') === label || item.textContent === label,
  );
  expect(button, `Missing button: ${label}`).toBeDefined();
  act(() => button?.click());
}

describe('QwenSubscriptionStatus', () => {
  it('shows the authorization link without opening it until requested', () => {
    const url = 'https://auth.example/authorize?user_code=ABCD';
    const callbacks = render({
      status: 'waiting',
      authorizationUrl: url,
    });

    expect(container.textContent).not.toContain('Authorization code:');
    expect(container.textContent).toContain('Waiting for sign-in…');
    expect(container.textContent).toContain(url);
    expect(callbacks.onOpenAuthorization).not.toHaveBeenCalled();
    expect(container.querySelector('input')).toBeNull();
    click('Open authorization page');
    expect(callbacks.onOpenAuthorization).toHaveBeenCalledExactlyOnceWith(url);
    click('Cancel');
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
  });

  it.each(['Free', 'Go'] as const)(
    'allows %s users to open plans while waiting for their purchase',
    (plan) => {
      const callbacks = render({
        status: 'purchase-required',
        plan,
        email: 'starter@example.com',
      });

      expect(container.textContent).toContain(
        `Signed in as starter@example.com (Qwen ${plan})`,
      );
      expect(container.textContent).toContain('Waiting for your subscription');
      expect(callbacks.onOpenPurchase).not.toHaveBeenCalled();
      click('Open plans again');
      expect(container.textContent).not.toContain('Check again');
      expect(callbacks.onRetry).not.toHaveBeenCalled();
      click('Use Alibaba ModelStudio instead');
      expect(callbacks.onSwitchProvider).toHaveBeenCalledOnce();
      click('Sign out');
      expect(callbacks.onSignOut).toHaveBeenCalledOnce();
      expect(callbacks.onOpenPurchase).toHaveBeenCalledOnce();
      click('Cancel');
      expect(callbacks.onCancel).toHaveBeenCalledOnce();
    },
  );

  it.each(['Plus', 'Pro'] as const)(
    'only displays readiness when the caller supplies ready %s state',
    (plan) => {
      render({
        status: 'ready',
        plan,
        email: 'builder@example.com',
      });

      expect(container.textContent).toContain(`Qwen ${plan} is active`);
      expect(container.querySelectorAll('button')).toHaveLength(0);
    },
  );

  it('shows a supplied error as text and allows retry or cancellation', () => {
    const callbacks = render({
      status: 'query-error',
      message: 'Unable to check membership. <script>ignored</script>',
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Unable to check membership. <script>ignored</script>',
    );
    expect(container.querySelector('script')).toBeNull();
    click('Check again');
    expect(callbacks.onRetry).toHaveBeenCalledOnce();
    click('Cancel');
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
  });

  it.each(['query failure', 'purchase timeout'])(
    'replaces the plans action with manual checking after %s',
    (message) => {
      const callbacks = render({
        status: 'purchase-required',
        plan: 'Free',
        email: 'starter@example.com',
        message,
        canCheckAgain: true,
      });
      expect(container.textContent).toContain('Open plans again');
      click('Check again');
      expect(callbacks.onOpenPurchase).not.toHaveBeenCalled();
      expect(callbacks.onRetry).toHaveBeenCalledOnce();
    },
  );

  it('disables Check again during a membership query', () => {
    const callbacks = render({
      status: 'purchase-required',
      plan: 'Free',
      email: 'starter@example.com',
      checking: true,
      canCheckAgain: true,
    });
    expect(container.textContent).toContain('Checking your subscription…');
    const button = [...container.querySelectorAll('button')].find(
      (item) => item.textContent === 'Check again',
    );
    expect(button?.disabled).toBe(true);
    act(() => button?.click());
    expect(callbacks.onRetry).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Press any key');
    expect(container.textContent).not.toContain('Esc to');
  });

  it('uses the selected locale for subscription text and actions', () => {
    const callbacks = render(
      {
        status: 'purchase-required',
        plan: 'Free',
        email: 'starter@example.com',
      },
      'zh-CN',
    );

    expect(container.textContent).toContain('Free 账号');
    click('重新打开套餐页');
    expect(callbacks.onOpenPurchase).toHaveBeenCalledOnce();
    click('取消');
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
  });
});
