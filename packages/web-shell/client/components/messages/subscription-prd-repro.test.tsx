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

it('keeps plans and account switching available after a no-membership recheck', () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const openPlans = vi.fn();
  const retry = vi.fn();
  const signOut = vi.fn();
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
          onSwitchProvider={vi.fn()}
          onSignOut={signOut}
          onCancel={vi.fn()}
        />
      </I18nProvider>,
    ),
  );
  const button = (label: string) =>
    [...container!.querySelectorAll('button')].find(
      (item) =>
        item.getAttribute('aria-label') === label || item.textContent === label,
    );
  expect(button('Check again')).toBeDefined();
  expect(button('Sign out')).toBeDefined();
  expect(button('Open plans again')).toBeDefined();
  act(() => button('Open plans again')?.click());
  expect(openPlans).toHaveBeenCalledOnce();
  expect(retry).not.toHaveBeenCalled();
  expect(signOut).not.toHaveBeenCalled();
});
