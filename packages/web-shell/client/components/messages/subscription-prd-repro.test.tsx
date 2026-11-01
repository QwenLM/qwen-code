// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';
import { QwenSubscriptionStatus } from './QwenSubscriptionStatus';

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

it('offers only membership retry after a no-membership recheck', () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const openPlans = vi.fn();
  const retry = vi.fn();
  const switchProvider = vi.fn();
  const cancel = vi.fn();
  act(() =>
    root?.render(
      <I18nProvider language="en">
        <QwenSubscriptionStatus
          state={{
            status: 'purchase-required',
            email: 'synthetic@example.test',
            plan: 'Free',
            canCheckAgain: true,
            message:
              'No active Plus or Pro subscription was found for this account.',
          }}
          onOpenAuthorization={vi.fn()}
          onOpenPurchase={openPlans}
          onRetry={retry}
          onSwitchProvider={switchProvider}
          onCancel={cancel}
        />
      </I18nProvider>,
    ),
  );
  const button = (label: string) =>
    [...container!.querySelectorAll('button')].find(
      (item) =>
        item.getAttribute('aria-label') === label || item.textContent === label,
    );
  expect(container.querySelectorAll('button')).toHaveLength(1);
  expect(button('Retry Connection')).toBeDefined();
  expect(button('Sign out')).toBeUndefined();
  expect(button('View Plans')).toBeUndefined();
  expect(button('Switch Provider')).toBeUndefined();
  act(() => button('Retry Connection')?.click());
  expect(retry).toHaveBeenCalledOnce();
  expect(openPlans).not.toHaveBeenCalled();
  expect(switchProvider).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
});
