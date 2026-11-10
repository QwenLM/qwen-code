// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { I18nProvider } from '../../i18n';
import {
  useSubscription,
  type SubscriptionTransport,
} from './use-subscription';

it('falls back to English subscription errors in a Russian shell', async () => {
  const transport: SubscriptionTransport = {
    getSubscriptionConfig: vi.fn().mockRejectedValue(new Error('offline')),
    startSubscriptionLogin: vi.fn(),
    getSubscriptionLogin: vi.fn(),
    cancelSubscriptionLogin: vi.fn(),
    getSubscriptionUserInfo: vi.fn(),
    signOutSubscription: vi.fn(),
  };
  const openExternal = vi.fn();
  const { result, unmount } = renderHook(
    () => useSubscription(transport, openExternal),
    {
      wrapper: ({ children }: PropsWithChildren) => (
        <I18nProvider language="ru">{children}</I18nProvider>
      ),
    },
  );
  await waitFor(() =>
    expect(result.current.state).toMatchObject({
      status: 'error',
      message: 'Could not complete authorization. Please try signing in again.',
    }),
  );
  expect(openExternal).not.toHaveBeenCalled();
  unmount();
});
