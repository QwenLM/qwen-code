// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { I18nProvider } from '../../i18n';
import {
  useSubscription,
  type SubscriptionTransport,
} from './use-subscription';

it.each([
  ['en', 'Could not complete authorization. Please try signing in again.'],
  ['zh-CN', '无法完成授权，请重新登录。'],
  ['zh-TW', '無法完成授權，請重新登入。'],
  ['ru', 'Не удалось завершить авторизацию. Попробуйте войти снова.'],
] as const)('renders subscription errors in %s', async (language, message) => {
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
        <I18nProvider language={language}>{children}</I18nProvider>
      ),
    },
  );
  await waitFor(() =>
    expect(result.current.state).toMatchObject({
      status: 'error',
      message,
    }),
  );
  expect(openExternal).not.toHaveBeenCalled();
  unmount();
});
