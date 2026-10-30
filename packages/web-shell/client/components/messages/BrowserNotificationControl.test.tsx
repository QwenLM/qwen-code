// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useBrowserNotificationSettings } from '../../browser-turn-notifications';
import { I18nProvider } from '../../i18n';
import { BrowserNotificationControl } from './BrowserNotificationControl';
import { ToolApproval } from './ToolApproval';

vi.mock('../../browser-turn-notifications', () => ({
  useBrowserNotificationSettings: vi.fn(),
}));

const settings = {
  enabled: true,
  permission: 'granted' as NotificationPermission | 'unavailable',
  pending: false,
  persistent: true,
  error: false,
  setEnabled: vi.fn(async () => {}),
  requestPermissionOnce: vi.fn(),
  refreshPermission: vi.fn(),
  syncLanguage: vi.fn(),
};
let root: Root;
let container: HTMLDivElement;
const selector = '[aria-label="Task notifications"]';
const popup = '[data-web-shell-notification-help]';
function render(node: ReactNode = <BrowserNotificationControl />) {
  act(() => root.render(<I18nProvider language="en">{node}</I18nProvider>));
}
function trigger() {
  return container.querySelector<HTMLButtonElement>(selector)!;
}
function hover() {
  act(() =>
    trigger().dispatchEvent(new MouseEvent('pointerover', { bubbles: true })),
  );
}
function leave() {
  act(() =>
    trigger().dispatchEvent(
      new MouseEvent('pointerout', {
        bubbles: true,
        relatedTarget: document.body,
      }),
    ),
  );
  act(() => vi.advanceTimersByTime(250));
}
function escape(target: Element = trigger()) {
  act(() =>
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  Object.assign(settings, {
    enabled: true,
    permission: 'granted',
    pending: false,
    persistent: true,
    error: false,
  });
  settings.setEnabled.mockReset().mockResolvedValue(undefined);
  vi.mocked(useBrowserNotificationSettings).mockReturnValue(settings);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('describes a help popup rather than a settings toggle', () => {
  render();
  expect(trigger().hasAttribute('aria-pressed')).toBe(false);
  expect(trigger().getAttribute('aria-haspopup')).toBe('dialog');
  hover();
  expect(trigger().getAttribute('aria-expanded')).toBe('true');
});

it('restores focus on Escape and still closes a re-hovered popup on pointer leave', () => {
  render();
  hover();
  const help = document.querySelector<HTMLElement>(popup)!;
  act(() => help.focus());
  escape(help);
  expect(document.querySelector(popup)).toBeNull();
  expect(document.activeElement).toBe(trigger());
  hover();
  expect(document.querySelector(popup)).not.toBeNull();
  leave();
  expect(document.querySelector(popup)).toBeNull();
  expect(document.activeElement).toBe(trigger());
});

it('keeps keyboard-focused trigger and content open across the close timer', () => {
  render();
  act(() => trigger().focus());
  leave();
  expect(document.querySelector(popup)).not.toBeNull();
  const help = document.querySelector<HTMLElement>(popup)!;
  act(() => help.focus());
  leave();
  expect(document.querySelector(popup)).not.toBeNull();
});

it('closes on pointer leave when neither trigger nor content has focus', () => {
  render();
  hover();
  leave();
  expect(document.querySelector(popup)).toBeNull();
});

it('keeps enabled status and separately reports a delivery error', () => {
  settings.error = true;
  render();
  hover();
  const help = document.querySelector(popup)!;
  expect(help.querySelector('[role="status"]')?.textContent).toBe(
    'Enabled for this site.',
  );
  expect(help.textContent).toContain('Unable to enable or show notifications.');
});

it('explains when the preference cannot persist', () => {
  settings.persistent = false;
  render();
  hover();
  expect(document.querySelector(popup)?.textContent).toContain(
    'This setting is saved for the current page only.',
  );
});

it('keeps authorization help open through pending blur and restores focus after grant', async () => {
  settings.enabled = false;
  settings.permission = 'default';
  vi.mocked(useBrowserNotificationSettings).mockImplementation(() => ({
    ...settings,
  }));
  let grant!: () => void;
  settings.setEnabled.mockImplementation(async () => {
    settings.pending = true;
    render();
    await new Promise<void>((resolve) => {
      grant = resolve;
    });
    settings.pending = false;
    settings.enabled = true;
    settings.permission = 'granted';
    render();
  });
  render();
  hover();
  const allow = document.querySelector<HTMLButtonElement>(`${popup} button`)!;
  act(() => allow.focus());
  act(() => allow.click());
  expect(allow.disabled).toBe(true);
  act(() => allow.blur());
  act(() =>
    document.querySelector(popup)!.dispatchEvent(
      new MouseEvent('pointerout', {
        bubbles: true,
        relatedTarget: document.body,
      }),
    ),
  );
  act(() => vi.advanceTimersByTime(250));
  expect(document.querySelector(popup)).not.toBeNull();
  await act(async () => grant());
  expect(document.activeElement).toBe(trigger());
  expect(document.querySelector('[role="status"]')?.textContent).toBe(
    'Enabled for this site.',
  );
});

it.each(['Enter', ' ', 'ArrowDown'])(
  'opens help with %s and focuses the portaled content',
  (key) => {
    render();
    act(() => trigger().focus());
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
    });
    act(() => trigger().dispatchEvent(event));
    act(() => vi.advanceTimersByTime(20));
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(document.querySelector(popup));
  },
);

it('preserves global shortcuts from the trigger with help open and closed', () => {
  render();
  act(() => trigger().focus());
  const listener = vi.fn();
  window.addEventListener('keydown', listener);
  try {
    for (const open of [true, false]) {
      if (!open) escape();
      listener.mockClear();
      act(() =>
        trigger().dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'b',
            ctrlKey: true,
            bubbles: true,
          }),
        ),
      );
      expect(listener).toHaveBeenCalledOnce();
    }
  } finally {
    window.removeEventListener('keydown', listener);
  }
});

it('keeps unrelated input focus when Escape closes hover-opened help', () => {
  render();
  const input = document.createElement('textarea');
  container.append(input);
  act(() => input.focus());
  hover();
  escape(input);
  expect(document.querySelector(popup)).toBeNull();
  expect(document.activeElement).toBe(input);
});

it.each(['data-plan-interactive', 'data-approval-shortcuts-ignore'])(
  'preserves native activation of %s controls while help is hover-open',
  (attribute) => {
    render(
      <ToolApproval
        request={{
          id: 'diff',
          content: [
            { type: 'diff', path: 'test.ts', oldText: 'a', newText: 'b' },
          ],
          options: [{ id: 'cancel', label: 'Reject', kind: 'reject_once' }],
        }}
        onConfirm={vi.fn()}
        showBrowserNotifications
      />,
    );
    const target = container.querySelector<HTMLElement>(
      '[data-plan-interactive]',
    )!;
    target.removeAttribute('data-plan-interactive');
    target.setAttribute(attribute, '');
    target.tabIndex = 0;
    act(() => target.focus());
    hover();
    for (const key of ['Enter', ' ']) {
      const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
      });
      act(() => target.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
    }
  },
);

it('exposes the control only on daemon-backed approval cards and preserves a second Escape', () => {
  const onConfirm = vi.fn();
  const request = {
    id: 'request',
    content: [],
    options: [{ id: 'cancel', label: 'Reject', kind: 'reject_once' as const }],
  };
  render(<ToolApproval request={request} onConfirm={onConfirm} />);
  expect(trigger()).toBeNull();
  render(
    <ToolApproval
      request={request}
      onConfirm={onConfirm}
      showBrowserNotifications
    />,
  );
  act(() => trigger().focus());
  escape();
  expect(onConfirm).not.toHaveBeenCalled();
  expect(document.querySelector(popup)).toBeNull();
  escape();
  expect(onConfirm).toHaveBeenCalledWith('request', 'cancel');
});
