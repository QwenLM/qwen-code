// @vitest-environment jsdom

import { webcrypto } from 'node:crypto';
import { act, useContext, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserTurnNotifications,
  BROWSER_NOTIFICATIONS_STORAGE_KEY,
  useBrowserNotificationSettings,
} from './browser-turn-notifications';
import {
  TurnNotificationContext,
  type TurnNotificationObserver,
} from './daemon/session/turn-notification-context';

type Settings = NonNullable<ReturnType<typeof useBrowserNotificationSettings>>;
interface Capture {
  settings?: Settings;
  observer?: TurnNotificationObserver;
}
const notifications: FakeNotification[] = [];
class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission = vi.fn(
    async (): Promise<NotificationPermission> => {
      FakeNotification.permission = 'granted';
      return 'granted';
    },
  );
  onclick?: () => void;
  onerror?: () => void;
  close = vi.fn();
  constructor(
    public title: string,
    public options: NotificationOptions,
  ) {
    notifications.push(this);
  }
}
const roots: Root[] = [];
function Probe({ capture }: { capture: Capture }) {
  capture.settings = useBrowserNotificationSettings();
  capture.observer = useContext(TurnNotificationContext);
  return null;
}
function render(capture: Capture, wrapper?: (node: ReactNode) => ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      wrapper ? (
        wrapper(<Probe capture={capture} />)
      ) : (
        <BrowserTurnNotifications language="en">
          <Probe capture={capture} />
        </BrowserTurnNotifications>
      ),
    ),
  );
  return root;
}
async function settle(capture: Capture, promptId = 'prompt') {
  await act(async () => {
    capture.observer!.observe('scope', 'session', {
      type: 'turn_complete',
      data: { sessionId: 'session', promptId, stopReason: 'end_turn' },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
function attach(capture: Capture) {
  capture.observer!.retain('scope');
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  notifications.length = 0;
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  });
  FakeNotification.permission = 'granted';
  FakeNotification.requestPermission
    .mockReset()
    .mockImplementation(async () => {
      FakeNotification.permission = 'granted';
      return 'granted';
    });
  vi.stubGlobal('Notification', FakeNotification);
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('navigator', { locks: undefined });
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('browser task notifications', () => {
  it('defaults off despite permission, consumes disabled terminals and persists an explicit choice', async () => {
    const capture: Capture = {};
    render(capture);
    attach(capture);
    expect(capture.settings!.enabled).toBe(false);
    await settle(capture);
    await act(() => capture.settings!.setEnabled(true));
    expect(window.localStorage.getItem(BROWSER_NOTIFICATIONS_STORAGE_KEY)).toBe(
      'true',
    );
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    await settle(capture);
    expect(notifications).toHaveLength(0);
    await settle(capture, 'new');
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.options.body).toBe('This turn has completed.');
    expect(notifications[0]?.options.tag).not.toContain('scope');
  });

  it('requests permission only when the user enables and keeps a denied preference off', async () => {
    FakeNotification.permission = 'default';
    FakeNotification.requestPermission.mockImplementation(async () => {
      FakeNotification.permission = 'denied';
      return 'denied';
    });
    const capture: Capture = {};
    render(capture);
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    await act(() => capture.settings!.setEnabled(true));
    expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
    expect(capture.settings!.permission).toBe('denied');
    expect(capture.settings!.enabled).toBe(false);
    await act(() => capture.settings!.setEnabled(true));
    expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
  });

  it('suppresses foreground and cancelled turns, and uses generic failure text', async () => {
    window.localStorage.setItem(BROWSER_NOTIFICATIONS_STORAGE_KEY, 'true');
    const capture: Capture = {};
    render(capture);
    attach(capture);
    vi.mocked(document.hasFocus).mockReturnValue(true);
    await settle(capture);
    vi.mocked(document.hasFocus).mockReturnValue(false);
    await settle(capture);
    await act(async () => {
      capture.observer!.observe('scope', 'session', {
        type: 'turn_complete',
        data: {
          sessionId: 'session',
          promptId: 'cancel',
          stopReason: 'cancelled',
        },
      });
      capture.observer!.observe('scope', 'session', {
        type: 'turn_error',
        data: {
          sessionId: 'session',
          promptId: 'error',
          message: 'secret /workspace/path',
        },
      });
      await vi.waitFor(() => expect(notifications).toHaveLength(1));
    });
    expect(notifications[0]?.options.body).toBe(
      'This turn failed. Return to view the details.',
    );
    expect(JSON.stringify(notifications)).not.toContain('secret');
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    notifications[0]?.onclick?.();
    expect(focus).toHaveBeenCalledOnce();
    expect(notifications[0]?.close).toHaveBeenCalledOnce();
  });

  it('keeps preference but stops sending after permission is revoked', async () => {
    window.localStorage.setItem(BROWSER_NOTIFICATIONS_STORAGE_KEY, 'true');
    const capture: Capture = {};
    render(capture);
    attach(capture);
    FakeNotification.permission = 'denied';
    act(() => window.dispatchEvent(new Event('focus')));
    expect(capture.settings).toMatchObject({
      enabled: true,
      permission: 'denied',
    });
    await settle(capture);
    expect(notifications).toHaveLength(0);
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });

  it('does not let late permission overwrite another tab disabling notifications', async () => {
    window.localStorage.setItem(BROWSER_NOTIFICATIONS_STORAGE_KEY, 'true');
    FakeNotification.permission = 'default';
    let resolve!: (permission: NotificationPermission) => void;
    FakeNotification.requestPermission.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const capture: Capture = {};
    render(capture);
    let enabling!: Promise<void>;
    act(() => {
      enabling = capture.settings!.setEnabled(true);
    });
    act(() => {
      window.localStorage.setItem(BROWSER_NOTIFICATIONS_STORAGE_KEY, 'false');
    });
    await act(async () => {
      FakeNotification.permission = 'granted';
      resolve('granted');
      await enabling;
    });
    act(() =>
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: BROWSER_NOTIFICATIONS_STORAGE_KEY,
          newValue: 'false',
        }),
      ),
    );
    expect(capture.settings!.enabled).toBe(false);
    expect(window.localStorage.getItem(BROWSER_NOTIFICATIONS_STORAGE_KEY)).toBe(
      'false',
    );
  });

  it('coordinates two page instances with Web Locks and a shared claim', async () => {
    let queue = Promise.resolve();
    vi.stubGlobal('navigator', {
      locks: {
        request: (_name: string, action: () => void) => {
          queue = queue.then(action);
          return queue;
        },
      },
    });
    window.localStorage.setItem(BROWSER_NOTIFICATIONS_STORAGE_KEY, 'true');
    const a: Capture = {},
      b: Capture = {};
    render(a);
    render(b);
    attach(a);
    attach(b);
    await settle(a);
    await settle(b);
    expect(notifications).toHaveLength(1);
  });

  it('falls back to a page-local choice when storage is blocked', async () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const capture: Capture = {};
    render(capture);
    attach(capture);
    await act(() => capture.settings!.setEnabled(true));
    expect(capture.settings).toMatchObject({
      enabled: true,
      persistent: false,
    });
    await settle(capture);
    expect(notifications).toHaveLength(1);
  });

  it('handles Notification construction and asynchronous display failures', async () => {
    window.localStorage.setItem(BROWSER_NOTIFICATIONS_STORAGE_KEY, 'true');
    const capture: Capture = {};
    render(capture);
    attach(capture);
    await settle(capture);
    act(() => notifications[0]?.onerror?.());
    expect(capture.settings!.error).toBe(true);
    class BrokenNotification extends FakeNotification {
      constructor(title: string, opts: NotificationOptions) {
        super(title, opts);
        throw new Error('display blocked');
      }
    }
    vi.stubGlobal('Notification', BrokenNotification);
    await settle(capture, 'broken');
    expect(capture.settings!.error).toBe(true);
  });

  it('exposes no controls to embedded hosts and does not request permission in an insecure context', async () => {
    const embedded: Capture = {};
    render(embedded, (node) => node);
    expect(embedded.settings).toBeUndefined();
    expect(embedded.observer).toBeUndefined();
    vi.stubGlobal('isSecureContext', false);
    const standalone: Capture = {};
    render(standalone);
    expect(standalone.settings!.permission).toBe('unavailable');
    await act(() => standalone.settings!.setEnabled(true));
    expect(standalone.settings!.enabled).toBe(false);
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });
});
