/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SubscriptionDeviceAuthorization } from '@qwen-code/qwen-code-core/qwen/subscription-oauth-client.js';
import type { Key } from '../contexts/KeypressContext.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { copyToClipboard } from '../utils/commandUtils.js';
import { QwenSubscriptionProgress } from './QwenSubscriptionProgress.js';

vi.mock('../hooks/useKeypress.js', () => ({ useKeypress: vi.fn() }));
vi.mock('../utils/commandUtils.js', () => ({ copyToClipboard: vi.fn() }));
vi.mock('ink-link', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('./RespondingSpinner.js', async () => {
  const { Text } = await import('ink');
  return { Spinner: () => <Text>⠋</Text> };
});

const grant: SubscriptionDeviceAuthorization = {
  verification_uri: 'https://example.com/device',
  verification_uri_complete: 'https://example.com/device?user_code=ABC123',
  user_code: 'ABC123',
  device_code: 'test-device-code',
  expires_in: 600,
  interval: 5,
  expiresAt: 1000,
};
const key = (name: string): Key => ({
  name,
  ctrl: false,
  meta: false,
  shift: false,
  paste: false,
  sequence: name,
});
let onKey: (key: Key) => void;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(0);
  vi.mocked(copyToClipboard).mockResolvedValue(undefined);
  vi.mocked(useKeypress).mockImplementation((handler) => {
    onKey = handler;
  });
});
afterEach(() => vi.useRealTimers());

it('keeps the pending subscription UI and copies the complete link', () => {
  const onCancel = vi.fn();
  const ui = render(
    <QwenSubscriptionProgress
      status="waiting"
      deviceAuth={grant}
      onCancel={onCancel}
    />,
  );
  try {
    expect(ui.lastFrame()).toContain('Qwen Subscription');
    expect(ui.lastFrame()).toContain('⠋ Waiting for sign-in…');
    expect(ui.lastFrame()).not.toContain('Time remaining:');
    expect(ui.lastFrame()).not.toContain('Authorization code:');
    expect(ui.lastFrame()).toContain('c to copy link · Esc to cancel');
    onKey(key('c'));
    expect(copyToClipboard).toHaveBeenCalledWith(
      grant.verification_uri_complete,
    );
    expect(onCancel).not.toHaveBeenCalled();
    onKey({ ...key('c'), ctrl: true });
    expect(onCancel).toHaveBeenCalledOnce();
  } finally {
    ui.unmount();
  }
});

it('keeps ordinary keys inert and cancels with Escape before a grant arrives', () => {
  const onCancel = vi.fn();
  const ui = render(
    <QwenSubscriptionProgress status="waiting" onCancel={onCancel} />,
  );
  try {
    expect(ui.lastFrame()).toContain('Waiting for sign-in…');
    onKey(key('a'));
    onKey(key('c'));
    expect(copyToClipboard).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    onKey(key('escape'));
    expect(onCancel).toHaveBeenCalledOnce();
  } finally {
    ui.unmount();
  }
});

it('does not copy pasted, modified or expired links, using the original grant deadline', () => {
  const ui = render(
    <QwenSubscriptionProgress
      status="waiting"
      deviceAuth={grant}
      onCancel={vi.fn()}
    />,
  );
  try {
    onKey({ ...key('c'), paste: true });
    onKey({ ...key('c'), meta: true });
    vi.setSystemTime(grant.expiresAt);
    onKey(key('c'));
    expect(copyToClipboard).not.toHaveBeenCalled();
  } finally {
    ui.unmount();
  }
});

it.each(['error', 'timeout'] as const)(
  'keeps the supplied %s message until a key returns to authentication',
  (status) => {
    const onCancel = vi.fn();
    const ui = render(
      <QwenSubscriptionProgress
        status={status}
        deviceAuth={grant}
        message="Please try again later"
        onCancel={onCancel}
      />,
    );
    try {
      expect(ui.lastFrame()).toContain('Please try again later');
      expect(ui.lastFrame()).toContain('Press any key');
      expect(onCancel).not.toHaveBeenCalled();
      onKey(key('c'));
      expect(onCancel).toHaveBeenCalledOnce();
      expect(copyToClipboard).not.toHaveBeenCalled();
    } finally {
      ui.unmount();
    }
  },
);
