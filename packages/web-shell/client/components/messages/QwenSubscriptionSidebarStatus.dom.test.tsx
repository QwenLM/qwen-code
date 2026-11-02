// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider, type WebShellLanguage } from '../../i18n';
import { QwenSubscriptionSidebarStatus } from './QwenSubscriptionSidebarStatus';
import type { QwenSubscriptionState } from './QwenSubscriptionStatus';
import styles from './QwenSubscriptionSidebarStatus.module.css';

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
    onUseAnotherAccount: vi.fn(),
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <I18nProvider language={language}>
        <QwenSubscriptionSidebarStatus state={state} {...callbacks} />
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

describe('QwenSubscriptionSidebarStatus', () => {
  it('shows the authorization link without opening it until requested', () => {
    const url = 'https://auth.example/authorize?user_code=ABCD';
    const callbacks = render({
      status: 'waiting',
      authorizationUrl: url,
    });

    expect(container.textContent).not.toContain('Authorization code:');
    expect(container.textContent).toContain('Waiting for sign-in…');
    expect(container.textContent).toContain(url);
    expect(container.textContent).not.toContain('Qwen Subscription');
    expect(container.querySelector('[data-slot="alert"]')).toBeNull();
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
        `You're signed in with a ${plan} account`,
      );
      expect(container.textContent).toContain(
        `Signed in as starter@example.com (Qwen ${plan})`,
      );
      expect(container.textContent).toContain(
        'Waiting for your subscription to become active…',
      );
      expect(callbacks.onOpenPurchase).not.toHaveBeenCalled();
      const options = container.querySelector(`.${styles.actions}`);
      expect(
        [...(options?.querySelectorAll('button') ?? [])].map(
          (button) => button.textContent,
        ),
      ).toEqual(['View Plans', 'Switch Provider', 'Use another account']);
      expect(container.querySelectorAll('button')).toHaveLength(3);
      expect(container.textContent).not.toContain('Sign out');
      expect(container.textContent).not.toContain('Cancel');
      expect(options?.querySelectorAll('p')).toHaveLength(0);
      click('View Plans');
      expect(container.textContent).not.toContain('Retry Connection');
      expect(callbacks.onRetry).not.toHaveBeenCalled();
      click('Switch Provider');
      expect(callbacks.onSwitchProvider).toHaveBeenCalledOnce();
      click('Use another account');
      expect(callbacks.onUseAnotherAccount).toHaveBeenCalledOnce();
      expect(callbacks.onOpenPurchase).toHaveBeenCalledOnce();
      expect(callbacks.onCancel).not.toHaveBeenCalled();
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

  it('shows a supplied query error as text and only allows retry', () => {
    const callbacks = render({
      status: 'query-error',
      message: 'Unable to check membership. <script>ignored</script>',
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Unable to check membership. <script>ignored</script>',
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).not.toContain('Qwen Subscription');
    expect(container.querySelector('[data-slot="alert"]')).toBeNull();
    click('Retry Connection');
    expect(callbacks.onRetry).toHaveBeenCalledOnce();
    expect(container.querySelectorAll('button')).toHaveLength(1);
    expect(callbacks.onCancel).not.toHaveBeenCalled();
  });

  it.each(['query failure', 'purchase timeout'])(
    'offers retry and account switching after %s',
    (message) => {
      const callbacks = render({
        status: 'purchase-required',
        plan: 'Free',
        email: 'starter@example.com',
        message,
        canCheckAgain: true,
      });
      expect(container.querySelectorAll('button')).toHaveLength(2);
      expect(container.textContent).not.toContain('View Plans');
      expect(container.textContent).not.toContain('Switch Provider');
      click('Retry Connection');
      expect(callbacks.onOpenPurchase).not.toHaveBeenCalled();
      expect(callbacks.onRetry).toHaveBeenCalledOnce();
      click('Use another account');
      expect(callbacks.onUseAnotherAccount).toHaveBeenCalledOnce();
    },
  );

  it.each(['purchase-required', 'query-error'] as const)(
    'disables Retry Connection during a %s query',
    (status) => {
      const callbacks = render(
        status === 'query-error'
          ? { status, message: 'Unable to check membership.', checking: true }
          : {
              status,
              plan: 'Free',
              email: 'starter@example.com',
              checking: true,
              canCheckAgain: true,
            },
      );
      expect(container.textContent).toContain('Checking your subscription…');
      const button = [...container.querySelectorAll('button')].find(
        (item) =>
          item.getAttribute('aria-label') === 'Retry Connection' ||
          item.textContent === 'Retry Connection',
      );
      expect(button?.disabled).toBe(true);
      expect(container.querySelectorAll('button')).toHaveLength(
        status === 'purchase-required' ? 2 : 1,
      );
      act(() => button?.click());
      expect(callbacks.onRetry).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain('Press any key');
      expect(container.textContent).not.toContain('Esc to');
    },
  );

  it('offers an authorization retry and cancellation after denied consent', () => {
    const callbacks = render({
      status: 'error',
      retry: 'authorization',
      message: 'Authorization or access was denied.',
    });
    expect(
      [...container.querySelectorAll('button')].map(
        (button) => button.textContent,
      ),
    ).toEqual(['Retry Connection', 'Cancel']);
    click('Retry Connection');
    expect(callbacks.onRetry).toHaveBeenCalledOnce();
    click('Cancel');
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
  });

  it('shows only purchase action buttons in a Chinese host', () => {
    const callbacks = render(
      {
        status: 'purchase-required',
        plan: 'Free',
        email: 'starter@example.com',
      },
      'zh-CN',
    );

    expect(container.textContent).toContain(
      "You're signed in with a Free account",
    );
    expect(container.textContent).not.toContain(
      'Opens the Qwen Code plans page in your browser',
    );
    expect(container.textContent).not.toContain(
      'Coding Plan, Token Plan, or Standard API Key',
    );
    expect(container.textContent).not.toContain(
      'Disconnect this device from your Qwen account',
    );
    expect(
      [...container.querySelectorAll('button')].map(
        (button) => button.textContent,
      ),
    ).toEqual(['View Plans', 'Switch Provider', 'Use another account']);
    click('View Plans');
    expect(callbacks.onOpenPurchase).toHaveBeenCalledOnce();
    expect(callbacks.onCancel).not.toHaveBeenCalled();
  });
});
