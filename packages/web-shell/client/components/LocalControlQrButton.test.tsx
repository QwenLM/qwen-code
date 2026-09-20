// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useContext, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The real popover shell is Radix, whose focus/scroll-lock effects never
// settle under `act` in jsdom. Render trigger and content inline, wiring the
// trigger click through a context so `open` state can be exercised.
vi.mock('./ui/popover', async () => {
  const React = await import('react');
  const OpenContext = React.createContext<(open: boolean) => void>(() => {});
  function Popover({
    children,
    onOpenChange,
  }: {
    children?: ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) {
    return createElement(
      OpenContext.Provider,
      { value: onOpenChange },
      children,
    );
  }
  function PopoverTrigger({ children }: { children?: ReactNode }) {
    const setOpen = useContext(OpenContext);
    return createElement(
      'div',
      null,
      createElement('div', { onClick: () => setOpen(true) }, children),
      createElement(
        'button',
        { onClick: () => setOpen(false) },
        'Close test popover',
      ),
    );
  }
  function PopoverContent({ children }: { children?: ReactNode }) {
    return createElement('div', { 'data-test-popover-content': '' }, children);
  }
  return { Popover, PopoverTrigger, PopoverContent };
});

vi.mock('@qwen-code/web-shell/daemon-react-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@qwen-code/web-shell/daemon-react-sdk')
    >();
  return {
    ...actual,
    useWorkspace: () => ({
      baseUrl: 'http://127.0.0.1:8080/',
      token: 'test-token',
    }),
  };
});

const { writeClipboardText } = vi.hoisted(() => ({
  writeClipboardText: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../utils/clipboard', () => ({
  writeClipboardText,
  warnClipboardWriteFailure: vi.fn(),
}));

const { I18nProvider } = await import('../i18n');
const { LocalControlQrButton } = await import('./LocalControlQrButton');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function localControlResponse(payload: object, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    text: () => Promise.resolve(JSON.stringify(payload)),
  } as Response;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function mount(
  onOpenSettings: () => void = vi.fn(),
  language: 'en' | 'zh-CN' = 'en',
): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language={language}>
        <LocalControlQrButton onOpenSettings={onOpenSettings} />
      </I18nProvider>,
    );
  });
  mounted.push({ root, container });
}

async function openPopover(label = 'Mobile access'): Promise<void> {
  const trigger = container.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!trigger) throw new Error('trigger button not found');
  act(() => {
    trigger.click();
  });
  await flush();
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  writeClipboardText.mockClear();
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('LocalControlQrButton', () => {
  it('preserves the QR glyph language within Chinese UI', async () => {
    vi.mocked(fetch).mockResolvedValue(
      localControlResponse({
        active: true,
        url: 'http://qwen.test/#pairing=one-time',
        qrText: 'QR-TEXT',
        expiresInMs: 60_000,
      }),
    );
    mount(vi.fn(), 'zh-CN');
    container.lang = 'zh-CN';
    await openPopover('手机访问');
    expect(container.textContent).toContain('一次性二维码');
    expect(container.querySelector('pre')?.lang).toBe('en');
  });

  it.each([-120_000, 120_000])(
    'rotates with a %i ms browser clock offset and stops requesting on close',
    async (offset) => {
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + offset);
      vi.mocked(fetch).mockImplementation(async () =>
        localControlResponse({
          active: true,
          url: `http://qwen.test/#pairing=${Date.now()}`,
          qrText: 'DYNAMIC-QR',
          expiresInMs: 60_000,
        }),
      );
      mount();
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Mobile access"]',
          )!
          .click(),
      );
      expect(container.textContent).toContain('Expires in 60s');
      const firstUrl = container.textContent;
      await act(async () => vi.advanceTimersByTimeAsync(45_000));
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(container.textContent).not.toBe(firstUrl);
      const close = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Close test popover',
      )!;
      act(() => close.click());
      await act(async () => vi.advanceTimersByTimeAsync(90_000));
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it('hides expired QR material when refreshing fails', async () => {
    vi.mocked(fetch).mockResolvedValue(
      localControlResponse({
        active: true,
        url: 'http://qwen.test/#pairing=old',
        qrText: 'OLD-QR',
        expiresInMs: 60_000,
      }),
    );
    vi.useFakeTimers();
    mount();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Mobile access"]')!
        .click(),
    );
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(container.textContent).not.toContain('OLD-QR');
    expect(container.textContent).not.toContain('#pairing=old');
    expect(container.textContent).toContain('QR code expired');
    expect(container.textContent).toContain('Retry');
  });

  it('falls back to Local Control on older daemons', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        localControlResponse({ error: 'not found' }, false, 404),
      )
      .mockResolvedValueOnce(localControlResponse({ active: false }));
    mount();
    await openPopover();
    expect(fetch).toHaveBeenLastCalledWith(
      new URL('http://127.0.0.1:8080/workspace/local-control'),
      expect.objectContaining({ method: 'GET' }),
    );
    expect(container.textContent).toContain('Local Control is off');
  });

  it('shows the QR code and pairing URL when Local Control is active', async () => {
    vi.mocked(fetch).mockResolvedValue(
      localControlResponse({
        active: true,
        url: 'http://192.168.1.2:8080/ws#token=abc',
        qrText: 'QR-TEXT',
      }),
    );
    mount();
    await openPopover();

    expect(fetch).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:8080/web-shell/pairing'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(container.textContent).toContain('QR-TEXT');
    expect(container.textContent).toContain(
      'http://192.168.1.2:8080/ws#token=abc',
    );
  });

  it('prompts to open Settings when Local Control is off', async () => {
    vi.mocked(fetch).mockResolvedValue(localControlResponse({ active: false }));
    const onOpenSettings = vi.fn();
    mount(onOpenSettings);
    await openPopover();

    expect(container.textContent).toContain('Local Control is off');
    const button = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((el) => el.textContent?.includes('Open Settings'));
    if (!button) throw new Error('Open Settings button not found');
    act(() => {
      button.click();
    });
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('shows the error when the status request fails', async () => {
    vi.mocked(fetch).mockResolvedValue(
      localControlResponse({ error: 'daemon unreachable' }, false, 500),
    );
    mount();
    await openPopover();

    expect(container.textContent).toContain('daemon unreachable');
  });

  it('shows the redacted hint when the daemon withholds the pairing URL', async () => {
    vi.mocked(fetch).mockResolvedValue(
      localControlResponse({ active: true, urlRedacted: true }),
    );
    mount();
    await openPopover();

    expect(container.textContent).toContain(
      'The pairing URL is not shown here',
    );
  });

  it('copies the pairing URL from the Copy button', async () => {
    vi.mocked(fetch).mockResolvedValue(
      localControlResponse({
        active: true,
        url: 'http://192.168.1.2:8080/ws#token=abc',
        qrText: 'QR-TEXT',
      }),
    );
    mount();
    await openPopover();

    const button = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((el) => el.textContent?.includes('Copy'));
    if (!button) throw new Error('Copy button not found');
    act(() => {
      button.click();
    });
    expect(writeClipboardText).toHaveBeenCalledWith(
      'http://192.168.1.2:8080/ws#token=abc',
    );
  });
});
