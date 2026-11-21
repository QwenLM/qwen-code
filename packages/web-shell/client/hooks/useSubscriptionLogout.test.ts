/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const { actions } = vi.hoisted(() => ({
  actions: {
    loadProviders: vi.fn(),
    getSubscriptionConfig: vi.fn(),
    signOutGoogleOAuth: vi.fn(),
    signOutSubscription: vi.fn(),
  },
}));
const refreshModels = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspaceActions: () => actions,
  useActions: () => ({ refreshModels }),
  useConnection: () => ({
    sessionId: undefined,
    status: 'connected',
    currentModel: 'gemini-4-argon(google-oauth)',
    context: { state: { _meta: { authType: 'google-oauth' } } },
  }),
  useDaemonSessionOwnerGuard: () => ({
    capture: () => ({ isCurrent: () => true }),
  }),
}));

const { useSubscriptionLogout } = await import('./useSubscriptionLogout');

describe('useSubscriptionLogout with Google OAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actions.loadProviders.mockResolvedValue({
      current: { authType: 'google-oauth' },
    });
    actions.getSubscriptionConfig.mockResolvedValue({ enabled: false });
    actions.signOutGoogleOAuth.mockResolvedValue(undefined);
    refreshModels.mockResolvedValue(undefined);
  });

  it('calls Google sign-out and refreshes models without starting Qwen cleanup', async () => {
    const onNotice = vi.fn();
    const onError = vi.fn();
    const { result, unmount } = renderHook(() =>
      useSubscriptionLogout({
        workspaceCwd: '/workspace',
        t: (key) => key,
        isBlocked: () => false,
        onBlocked: vi.fn(() => true),
        onNotice,
        onError,
      }),
    );
    const qwenReadsBefore = actions.getSubscriptionConfig.mock.calls.length;
    await act(async () => {
      expect(result.current.handleCommand('/logout')).toBe(true);
    });

    await waitFor(() =>
      expect(actions.signOutGoogleOAuth).toHaveBeenCalledOnce(),
    );
    expect(actions.signOutSubscription).not.toHaveBeenCalled();
    expect(actions.getSubscriptionConfig).toHaveBeenCalledTimes(
      qwenReadsBefore,
    );
    expect(refreshModels).toHaveBeenCalledWith(undefined, {
      reloadProviders: false,
    });
    expect(onNotice).toHaveBeenCalledWith(
      'info',
      'subscription.signedOutLocally',
    );
    expect(onError).not.toHaveBeenCalled();
    unmount();
  });
});
