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
  TurnNotificationNavigationContext,
  type TurnNotificationObserver,
} from './daemon/session/turn-notification-context';

type Settings = NonNullable<ReturnType<typeof useBrowserNotificationSettings>>;
interface Capture {
  settings?: Settings;
  observer?: TurnNotificationObserver;
  navigationTarget?: EventTarget;
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
  capture.navigationTarget = useContext(TurnNotificationNavigationContext);
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
  it('defaults on only when configured and preserves an explicit off choice after remount', async () => {
    const capture: Capture = {};
    const wrapper = (node: ReactNode) => (
      <BrowserTurnNotifications
        language="en"
        options={{ defaultEnabled: true }}
      >
        {node}
      </BrowserTurnNotifications>
    );
    const root = render(capture, wrapper);
    attach(capture);
    expect(capture.settings!.enabled).toBe(true);
    expect(
      window.localStorage.getItem(BROWSER_NOTIFICATIONS_STORAGE_KEY),
    ).toBeNull();
    await settle(capture);
    expect(notifications).toHaveLength(1);
    await act(() => capture.settings!.setEnabled(false));
    act(() => root.render(null));
    render(capture, wrapper);
    attach(capture);
    expect(capture.settings!.enabled).toBe(false);
    await settle(capture, 'after-reload');
    expect(notifications).toHaveLength(1);
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });

  it.each(['default', 'denied'] as const)(
    'does not request permission or deliver automatically with default on and permission %s',
    async (permission) => {
      FakeNotification.permission = permission;
      const capture: Capture = {};
      render(capture, (node) => (
        <BrowserTurnNotifications
          language="en"
          options={{ defaultEnabled: true }}
        >
          {node}
        </BrowserTurnNotifications>
      ));
      attach(capture);
      expect(capture.settings!.enabled).toBe(true);
      await settle(capture);
      expect(notifications).toHaveLength(0);
      expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
      if (permission === 'default') {
        await act(() => capture.settings!.setEnabled(true));
        expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
        await settle(capture, 'authorized');
        expect(notifications).toHaveLength(1);
      }
    },
  );

  it('restores its initial default after storage deletion without treating prop changes as user choices', async () => {
    window.localStorage.setItem(BROWSER_NOTIFICATIONS_STORAGE_KEY, 'false');
    const capture: Capture = {};
    const root = render(capture, (node) => (
      <BrowserTurnNotifications
        language="en"
        options={{ defaultEnabled: true }}
      >
        {node}
      </BrowserTurnNotifications>
    ));
    act(() =>
      root.render(
        <BrowserTurnNotifications
          language="en"
          options={{ defaultEnabled: false }}
        >
          <Probe capture={capture} />
        </BrowserTurnNotifications>,
      ),
    );
    expect(capture.settings!.enabled).toBe(false);
    act(() => {
      window.localStorage.removeItem(BROWSER_NOTIFICATIONS_STORAGE_KEY);
      window.dispatchEvent(
        new StorageEvent('storage', { key: BROWSER_NOTIFICATIONS_STORAGE_KEY }),
      );
    });
    expect(capture.settings!.enabled).toBe(true);
    await act(() => capture.settings!.setEnabled(false));
    act(() => {
      window.localStorage.clear();
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(capture.settings!.enabled).toBe(true);
  });

  it('uses the configured default with unavailable storage and still allows turning off', async () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const capture: Capture = {};
    render(capture, (node) => (
      <BrowserTurnNotifications
        language="en"
        options={{ defaultEnabled: true }}
      >
        {node}
      </BrowserTurnNotifications>
    ));
    expect(capture.settings!.enabled).toBe(true);
    expect(capture.settings!.persistent).toBe(false);
    await act(() => capture.settings!.setEnabled(false));
    expect(capture.settings!.enabled).toBe(false);
  });

  it('uses the synchronized App language after preference updates', async () => {
    const capture: Capture = {};
    render(capture);
    attach(capture);
    act(() => capture.settings!.syncLanguage('zh-CN'));
    await act(() => capture.settings!.setEnabled(true));
    await settle(capture);
    expect(notifications[0]?.options.body).toBe('本轮已完成。');
  });

  it.each([
    [{}, 'QwenCode', undefined],
    [{ appName: '  ', iconUrl: '\n' }, 'QwenCode', undefined],
    [{ appName: '  DataAgent  ' }, 'DataAgent', undefined],
    [
      { iconUrl: 'https://cdn.example.com/icon.png' },
      'QwenCode',
      'https://cdn.example.com/icon.png',
    ],
    [
      { appName: 'DataAgent', iconUrl: ' https://cdn.example.com/icon.png ' },
      'DataAgent',
      'https://cdn.example.com/icon.png',
    ],
  ] as const)(
    'uses independent branding defaults for %j',
    async (options, name, icon) => {
      window.localStorage.setItem(BROWSER_NOTIFICATIONS_STORAGE_KEY, 'true');
      const capture: Capture = {};
      render(capture, (node) => (
        <BrowserTurnNotifications language="en" options={options}>
          {node}
        </BrowserTurnNotifications>
      ));
      attach(capture);
      await settle(capture);
      expect(notifications[0]?.title).toBe(name);
      if (icon) expect(notifications[0]?.options.icon).toBe(icon);
      else
        expect(notifications[0]?.options.icon).toMatch(
          /qwen-code-notification[^/]*\.png$/,
        );
    },
  );

  it('updates branding for new notifications without resetting the observer or preference', async () => {
    const capture: Capture = {};
    const root = render(capture, (node) => (
      <BrowserTurnNotifications
        language="en"
        options={{ appName: 'DataAgent' }}
      >
        {node}
      </BrowserTurnNotifications>
    ));
    attach(capture);
    const observer = capture.observer;
    await act(() => capture.settings!.setEnabled(true));
    const notify = async (promptId: string) => {
      await act(async () => {
        capture.observer!.observe(
          'scope',
          'session',
          {
            type: 'turn_complete',
            data: { sessionId: 'session', promptId, stopReason: 'end_turn' },
          },
          false,
          { sessionTitle: 'Build result' },
        );
        await vi.waitFor(() =>
          expect(notifications).toHaveLength(promptId === 'first' ? 1 : 2),
        );
      });
    };
    await notify('first');
    act(() =>
      root.render(
        <BrowserTurnNotifications
          language="en"
          options={{
            appName: 'Other App',
            iconUrl: 'https://cdn.example.com/new.png',
          }}
        >
          <Probe capture={capture} />
        </BrowserTurnNotifications>,
      ),
    );
    expect(capture.observer).toBe(observer);
    expect(capture.settings!.enabled).toBe(true);
    await notify('second');
    expect(notifications[0]?.title).toBe('DataAgent · Build result');
    expect(notifications[1]?.title).toBe('Other App · Build result');
    expect(notifications[1]?.options.icon).toBe(
      'https://cdn.example.com/new.png',
    );
  });

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

  it('shows a compact title, prompt and reply excerpts without storing them', async () => {
    vi.stubGlobal('navigator', {
      locks: { request: async (_name: string, action: () => void) => action() },
    });
    window.localStorage.setItem(BROWSER_NOTIFICATIONS_STORAGE_KEY, 'true');
    const capture: Capture = {};
    render(capture);
    attach(capture);
    await act(async () => {
      capture.observer!.observe(
        'scope',
        'session',
        {
          type: 'turn_complete',
          data: {
            sessionId: 'session',
            promptId: 'content',
            stopReason: 'end_turn',
          },
        },
        false,
        {
          sessionTitle: '  Fix **notifications**\n in Chrome ',
          promptText: '**Please** fix\n[alerts](https://example.com/private)',
          responseText:
            '# Result\n**Fixed** the [notification](https://example.com/private).\n- Added `tests`.',
        },
      );
      await vi.waitFor(() => expect(notifications).toHaveLength(1));
    });
    expect(notifications[0]?.title).toBe(
      'QwenCode · Fix notifications in Chrome',
    );
    expect(notifications[0]?.options.icon).toMatch(
      /qwen-code-notification[^/]*\.png$/,
    );
    expect(notifications[0]?.options.body).toBe(
      'This turn has completed.\nPrompt: Please fix alerts\nReply: Result Fixed the notification. Added tests.',
    );
    expect(
      window.localStorage.getItem('qwen-code-web-shell-notification-claims'),
    ).not.toMatch(/Fix|Result|private|Please|alerts/);
  });

  it('preserves code and comparisons while removing invisible controls', async () => {
    window.localStorage.setItem(BROWSER_NOTIFICATIONS_STORAGE_KEY, 'true');
    const capture: Capture = {};
    render(capture);
    attach(capture);
    await act(async () => {
      capture.observer!.observe(
        'scope',
        'session',
        {
          type: 'turn_complete',
          data: {
            sessionId: 'session',
            promptId: 'code',
            stopReason: 'end_turn',
          },
        },
        false,
        {
          sessionTitle: 'Build\u202E passed',
          promptText: 'Use `Map<string, number>`; is 3 < 5 and 7 > 2 correct?',
          responseText:
            '```html\n<div>Hello<br>world</div>\n```\ndone\u0000 tail\u0085\u2066',
        },
      );
      await vi.waitFor(() => expect(notifications).toHaveLength(1));
    });
    expect(notifications[0]?.title).toBe('QwenCode · Build passed');
    expect(notifications[0]?.options.body).toBe(
      'This turn has completed.\nPrompt: Use Map<string, number>; is 3 < 5 and 7 > 2 correct?\nReply: <div>Hello<br>world</div> done tail',
    );
  });

  it('bounds Unicode titles and excerpts, and keeps status-only fallbacks', async () => {
    window.localStorage.setItem(BROWSER_NOTIFICATIONS_STORAGE_KEY, 'true');
    const capture: Capture = {};
    render(capture);
    attach(capture);
    await act(async () => {
      for (const [promptId, type, content] of [
        [
          'long',
          'turn_complete',
          {
            sessionTitle: '🔔'.repeat(80),
            promptText: '问'.repeat(80),
            responseText: '😀'.repeat(160),
          },
        ],
        [
          'empty',
          'turn_complete',
          { sessionTitle: '  ', promptText: '  ', responseText: '  ' },
        ],
        [
          'failure',
          'turn_error',
          { sessionTitle: 'Failed task', responseText: 'partial answer' },
        ],
      ] as const) {
        capture.observer!.observe(
          'scope',
          'session',
          {
            type,
            data: { sessionId: 'session', promptId, stopReason: 'end_turn' },
          },
          false,
          content,
        );
      }
      await vi.waitFor(() => expect(notifications).toHaveLength(3));
    });
    const long = notifications.find((n) =>
      n.title.startsWith('QwenCode · 🔔'),
    )!;
    expect(long.title).toBe('QwenCode · ' + '🔔'.repeat(59) + '…');
    expect(long.options.body).toBe(
      'This turn has completed.\nPrompt: ' +
        '问'.repeat(80) +
        '\nReply: ' +
        '😀'.repeat(119) +
        '…',
    );
    expect(
      notifications.find((n) => n.title === 'QwenCode')?.options.body,
    ).toBe('This turn has completed.');
    expect(
      notifications.find((n) => n.title === 'QwenCode · Failed task')?.options
        .body,
    ).toBe('This turn failed. Return to view the details.');
  });

  it('localizes and bounds prompts independently, including failed turns', async () => {
    window.localStorage.setItem(BROWSER_NOTIFICATIONS_STORAGE_KEY, 'true');
    const capture: Capture = {};
    render(capture, (node) => (
      <BrowserTurnNotifications language="zh-CN">
        {node}
      </BrowserTurnNotifications>
    ));
    attach(capture);
    await act(async () => {
      capture.observer!.observe(
        'scope',
        'session',
        {
          type: 'turn_error',
          data: { sessionId: 'session', promptId: 'failed' },
        },
        false,
        { promptText: '😀'.repeat(81), responseText: 'partial private answer' },
      );
      capture.observer!.observe(
        'scope',
        'session',
        {
          type: 'turn_complete',
          data: {
            sessionId: 'session',
            promptId: 'done',
            stopReason: 'end_turn',
          },
        },
        false,
        { promptText: '第二轮问题', responseText: '**完成**' },
      );
      await vi.waitFor(() => expect(notifications).toHaveLength(2));
    });
    expect(notifications.map((n) => n.options.body)).toEqual(
      expect.arrayContaining([
        '本轮执行失败，请返回查看。\n提问：' + '😀'.repeat(79) + '…',
        '本轮已完成。\n提问：第二轮问题\n回复：完成',
      ]),
    );
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

  it.each([false, true])(
    'opens the captured target even if focus fails (%s)',
    async (focusFails) => {
      window.localStorage.setItem(BROWSER_NOTIFICATIONS_STORAGE_KEY, 'true');
      const capture: Capture = {};
      render(capture);
      attach(capture);
      const target = {
        sessionId: 'session',
        sessionContext: {
          kind: 'workspace' as const,
          cwd: '/original/workspace',
        },
      };
      const open = vi.fn();
      const globalOpen = vi.fn();
      capture.navigationTarget!.addEventListener('qwen:open-session', open);
      window.addEventListener('qwen:open-session', globalOpen);
      try {
        await act(async () => {
          capture.observer!.observe(
            'scope',
            'session',
            {
              type: 'turn_complete',
              data: {
                sessionId: 'session',
                promptId: 'click',
                stopReason: 'end_turn',
              },
            },
            false,
            { target },
          );
          await vi.waitFor(() => expect(notifications).toHaveLength(1));
        });
        expect(open).not.toHaveBeenCalled();
        capture.observer!.retain('another-scope');
        const focus = vi.spyOn(window, 'focus').mockImplementation(() => {
          if (focusFails) throw new Error('focus denied');
        });
        notifications[0]?.onclick?.();
        expect(focus).toHaveBeenCalledOnce();
        expect(open).toHaveBeenCalledOnce();
        expect(globalOpen).not.toHaveBeenCalled();
        expect((open.mock.calls[0]![0] as CustomEvent).detail).toEqual(target);
        expect(notifications[0]?.close).toHaveBeenCalledOnce();
      } finally {
        capture.navigationTarget!.removeEventListener(
          'qwen:open-session',
          open,
        );
        window.removeEventListener('qwen:open-session', globalOpen);
      }
    },
  );

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
