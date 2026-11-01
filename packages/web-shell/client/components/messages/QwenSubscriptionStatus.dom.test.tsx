// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider, type WebShellLanguage } from '../../i18n';
import {
  QwenSubscriptionStatus,
  type QwenSubscriptionState,
} from './QwenSubscriptionStatus';
import styles from './AuthMessage.module.css';

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
    expect(container.textContent).not.toContain('Qwen Subscription');
    expect(container.querySelector('[data-slot="alert"]')).toBeNull();
    expect(callbacks.onOpenAuthorization).not.toHaveBeenCalled();
    expect(container.querySelector('input')).toBeNull();
    click('Open authorization page');
    expect(callbacks.onOpenAuthorization).toHaveBeenCalledExactlyOnceWith(url);
    const next = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'next',
    );
    expect(next).toBeUndefined();
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    click('previous');
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
      expect(container.textContent).not.toContain('starter@example.com');
      expect(container.textContent).toContain(
        'Waiting for your subscription to become active…',
      );
      expect(callbacks.onOpenPurchase).not.toHaveBeenCalled();
      const options = container.querySelector(`.${styles.options}`);
      expect(
        [...(options?.querySelectorAll('button') ?? [])].map((button) =>
          button.getAttribute('aria-label'),
        ),
      ).toEqual(['View Plans', 'Switch Provider']);
      expect(container.querySelectorAll('button')).toHaveLength(2);
      expect(container.textContent).not.toContain('Cancel');
      expect(container.textContent).not.toContain('Sign out');
      click('View Plans');
      expect(container.textContent).not.toContain('Retry Connection');
      expect(callbacks.onRetry).not.toHaveBeenCalled();
      click('Switch Provider');
      expect(callbacks.onSwitchProvider).toHaveBeenCalledOnce();
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
    'offers only a retry after %s',
    (message) => {
      const callbacks = render({
        status: 'purchase-required',
        plan: 'Free',
        email: 'starter@example.com',
        message,
        canCheckAgain: true,
      });
      expect(container.querySelectorAll('button')).toHaveLength(1);
      expect(container.textContent).not.toContain('View Plans');
      expect(container.textContent).not.toContain('Switch Provider');
      click('Retry Connection');
      expect(callbacks.onOpenPurchase).not.toHaveBeenCalled();
      expect(callbacks.onRetry).toHaveBeenCalledOnce();
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
      expect(container.querySelectorAll('button')).toHaveLength(1);
      act(() => button?.click());
      expect(callbacks.onRetry).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain('Press any key');
      expect(container.textContent).not.toContain('Esc to');
    },
  );

  it('follows the host locale for the complete purchase guidance and updates when it changes', () => {
    const state = {
      status: 'purchase-required',
      plan: 'Free',
      email: 'starter@example.com',
    } as const;
    const callbacks = render(state, 'zh-CN');

    expect(container.querySelector('section')?.lang).toBe('zh-CN');
    expect(container.textContent).toContain('Free 账号');
    expect(container.textContent).toContain('正在等待你的订阅生效…');
    expect(container.textContent).toContain('在浏览器中打开 Qwen Code 套餐页');
    expect(container.textContent).toContain('选择其他模型供应商');
    expect(container.textContent).not.toContain('退出登录');
    expect(container.textContent).not.toContain("You're signed in");
    click('查看套餐');
    expect(callbacks.onOpenPurchase).toHaveBeenCalledOnce();
    click('切换供应商');
    expect(callbacks.onSwitchProvider).toHaveBeenCalledOnce();
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    act(() =>
      root?.render(
        <I18nProvider language="en">
          <QwenSubscriptionStatus state={state} {...callbacks} />
        </I18nProvider>,
      ),
    );
    expect(container.querySelector('section')?.lang).toBe('en');
    expect(container.textContent).toContain(
      "You're signed in with a Free account",
    );
    expect(container.textContent).not.toContain('正在等待');
    click('View Plans');
    expect(callbacks.onOpenPurchase).toHaveBeenCalledTimes(2);
  });

  it.each(['en', 'zh-CN'] as const)(
    'offers retry before previous without Next after authorization failure (%s)',
    (language) => {
      const message =
        language === 'en'
          ? 'Authorization or access was denied.'
          : '授权或访问被拒绝。';
      const callbacks = render(
        { status: 'error', retry: 'authorization', message },
        language,
      );
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        message,
      );
      expect(container.querySelectorAll('button')).toHaveLength(2);
      expect(
        [...container.querySelectorAll('button')].map(
          (button) => button.textContent,
        ),
      ).toEqual(
        language === 'en'
          ? ['Retry Connection', 'previous']
          : ['重试', '上一步'],
      );
      const next = [...container.querySelectorAll('button')].find(
        (button) =>
          button.textContent === (language === 'en' ? 'next' : '下一步'),
      );
      expect(next).toBeUndefined();
      click(language === 'en' ? 'Retry Connection' : '重试');
      expect(callbacks.onRetry).toHaveBeenCalledOnce();
      click(language === 'en' ? 'previous' : '上一步');
      expect(callbacks.onCancel).toHaveBeenCalledOnce();
    },
  );

  it('keeps nonretryable credential errors without an authorization retry', () => {
    const callbacks = render({
      status: 'error',
      message: 'Could not save credentials.',
    });
    expect(
      [...container.querySelectorAll('button')].map(
        (button) => button.textContent,
      ),
    ).toEqual(['previous']);
    click('previous');
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
    expect(callbacks.onRetry).not.toHaveBeenCalled();
  });

  it('moves the highlighted action with keyboard focus without activating it', () => {
    const callbacks = render({
      status: 'purchase-required',
      plan: 'Go',
      email: 'starter@example.com',
    });
    const options = container.querySelector(`.${styles.options}`)!;
    const buttons = [...options.querySelectorAll('button')];
    expect(buttons[0].getAttribute('data-selected')).toBe('true');
    expect(buttons[0].classList.contains(styles.optionActive)).toBe(true);
    expect(buttons[0].getAttribute('data-slot')).toBeNull();
    expect(options.textContent).not.toContain('›');
    act(() => {
      buttons[0].focus();
      buttons[0].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(buttons[1]);
    expect(buttons[1].getAttribute('data-selected')).toBe('true');
    expect(buttons[1].classList.contains(styles.optionActive)).toBe(true);
    expect(buttons[0].getAttribute('data-selected')).toBe('false');
    expect(callbacks.onSwitchProvider).not.toHaveBeenCalled();
    act(() => buttons[1].click());
    expect(callbacks.onSwitchProvider).toHaveBeenCalledOnce();
  });
});
