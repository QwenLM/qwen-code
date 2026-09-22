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

  it('rotates on the 45 s refresh cadence and stops requesting on close', async () => {
    vi.useFakeTimers();
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
        .querySelector<HTMLButtonElement>('button[aria-label="Mobile access"]')!
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
  });

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

  it('shows the unencrypted notice for a legacy Local Control QR', async () => {
    // Older daemons answer the POST with {active:false} and serve the
    // long-lived URL from GET /workspace/local-control without expiresInMs.
    vi.mocked(fetch)
      .mockResolvedValueOnce(localControlResponse({ active: false }))
      .mockResolvedValueOnce(
        localControlResponse({
          active: true,
          url: 'http://192.168.1.2:8080/ws#token=abc',
          qrText: 'QR-TEXT',
          encrypted: false,
        }),
      );
    mount();
    await openPopover();

    expect(container.textContent).toContain('QR-TEXT');
    expect(container.textContent).toContain('Traffic is unencrypted');
  });

  it('shows the secure notice for an encrypted pairing QR', async () => {
    vi.mocked(fetch).mockResolvedValue(
      localControlResponse({
        active: true,
        url: 'http://qwen.test/#pairing=one-time',
        qrText: 'QR-TEXT',
        expiresInMs: 60_000,
        encrypted: true,
      }),
    );
    mount();
    await openPopover();

    expect(container.textContent).toContain(
      'Scan to grant access to this daemon.',
    );
    expect(container.textContent).not.toContain('Traffic is unencrypted');
  });

  it('states the per-tab lifetime for an unencrypted dynamic pairing QR', async () => {
    vi.mocked(fetch).mockResolvedValue(
      localControlResponse({
        active: true,
        url: 'http://qwen.test/#pairing=one-time',
        qrText: 'QR-TEXT',
        expiresInMs: 60_000,
        encrypted: false,
      }),
    );
    mount();
    await openPopover();

    expect(container.textContent).toContain(
      "The device that scans stays signed in until the daemon restarts or that device's tab is closed.",
    );
    expect(container.textContent).toContain('Traffic is unencrypted');
    expect(container.textContent).not.toContain(
      'Scan to grant access until this daemon restarts.',
    );
    // The credential lives on the scanning device, not in this popover's tab.
    expect(container.textContent).not.toContain('This browser tab');
  });

  it('keeps the daemon-lifetime wording on an encrypted legacy Local Control QR', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(localControlResponse({ active: false }))
      .mockResolvedValueOnce(
        localControlResponse({
          active: true,
          url: 'https://192.168.1.2:8080/ws#token=abc',
          qrText: 'QR-TEXT',
          encrypted: true,
        }),
      );
    mount();
    await openPopover();

    expect(container.textContent).toContain(
      'Scan to grant access until this daemon restarts.',
    );
    expect(container.textContent).not.toContain(
      'This browser tab stays signed in',
    );
  });

  it('re-polls while a wildcard bind offers no network address', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue(
      localControlResponse({ active: true, interfaces: [] }),
    );
    mount();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Mobile access"]')!
        .click(),
    );
    expect(container.textContent).toContain('No local network address');
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('No local network address');

    // The cadence widens after the first empty replies: a fixed 5 s loop
    // would spend ~24 more mutation-tier POSTs over the next two minutes on
    // this terminal state; the bounded loop spends four.
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it('lets the operator return to the network choice after a wrong pick', async () => {
    const interfaces = [
      { interfaceName: 'en0', address: '192.168.1.9' },
      { interfaceName: 'br0', address: '10.0.0.5' },
    ];
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const body = JSON.parse(
        String((init as RequestInit | undefined)?.body ?? '{}'),
      );
      if (typeof body.address === 'string') {
        return localControlResponse({
          active: true,
          url: `http://${body.address}:8080/#pairing=one-time`,
          qrText: 'QR-TEXT',
          expiresInMs: 60_000,
          encrypted: false,
        });
      }
      return localControlResponse({ active: true, interfaces });
    });
    mount();
    await openPopover();
    expect(container.textContent).toContain('en0: 192.168.1.9');

    const pick = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('br0: 10.0.0.5'))!;
    await act(async () => pick.click());
    await flush();
    const pickInit = vi.mocked(fetch).mock.calls.at(-1)![1] as RequestInit;
    expect(JSON.parse(String(pickInit.body))).toEqual({
      address: '10.0.0.5',
    });
    expect(container.textContent).toContain('QR-TEXT');
    expect(container.textContent).toContain('http://10.0.0.5:8080/');

    // A wrong pick must not be sticky: the QR view offers a way back to the
    // candidate list, and the re-request leaves the address out.
    const change = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Change network');
    expect(change).toBeDefined();
    await act(async () => change!.click());
    await flush();
    expect(container.textContent).toContain('en0: 192.168.1.9');
    expect(container.textContent).toContain('br0: 10.0.0.5');
    const lastInit = vi.mocked(fetch).mock.calls.at(-1)![1] as RequestInit;
    expect(lastInit.body).toBeUndefined();
  });

  it('stops re-polling a permanently failing pairing route', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    mount();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Mobile access"]')!
        .click(),
    );
    expect(container.textContent).toContain('offline');

    // Failures widen from 5 s to 30 s after the first two: a fixed 5 s loop
    // would have issued a fourth request inside 15 s.
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(fetch).toHaveBeenCalledTimes(3);
    // …and stop entirely after six retries: a fixed 5 s loop would have made
    // 121 requests over the same ten minutes.
    await act(async () => vi.advanceTimersByTimeAsync(585_000));
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(container.textContent).toContain('offline');
    // The manual recovery stays: Retry re-arms the effect.
    const retry = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Retry');
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    expect(fetch).toHaveBeenCalledTimes(8);
  });

  it('does not re-poll while the operator is choosing a network', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue(
      localControlResponse({
        active: true,
        interfaces: [
          { interfaceName: 'en0', address: '192.168.1.2' },
          { interfaceName: 'en1', address: '10.0.0.2' },
        ],
      }),
    );
    mount();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Mobile access"]')!
        .click(),
    );
    expect(container.textContent).toContain('en0: 192.168.1.2');
    expect(fetch).toHaveBeenCalledTimes(1);

    // The choice list only advances through `setAddress`, so an idle popover
    // must not keep spending mutation-tier POSTs on an unchanged screen.
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to Local Control on a non-404 pairing failure', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue(
      localControlResponse({ error: 'daemon busy' }, false, 500),
    );
    mount();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Mobile access"]')!
        .click(),
    );
    // Only a 404 means "this daemon predates pairing"; any other failure is
    // an error to show, not a reason to probe the legacy endpoint.
    expect(container.textContent).toContain('daemon busy');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenLastCalledWith(
      new URL('http://127.0.0.1:8080/web-shell/pairing'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('re-polls pairing from the error-state Retry button', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        localControlResponse({ error: 'offline' }, false, 500),
      )
      .mockResolvedValue(
        localControlResponse({
          active: true,
          url: 'http://qwen.test/#pairing=recovered',
          qrText: 'RECOVERED-QR',
          expiresInMs: 60_000,
        }),
      );
    mount();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Mobile access"]')!
        .click(),
    );
    expect(container.textContent).toContain('offline');

    const retry = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Retry');
    expect(retry).toBeDefined();
    await act(async () => {
      retry!.click();
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('RECOVERED-QR');
    expect(container.textContent).not.toContain('offline');
  });

  it('ignores a pairing response that lands after the popover closes', async () => {
    vi.useFakeTimers();
    let settle: ((response: Response) => void) | undefined;
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          settle = resolve;
        }),
    );
    mount();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Mobile access"]')!
        .click(),
    );
    expect(fetch).toHaveBeenCalledTimes(1);

    const close = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Close test popover');
    if (!close) throw new Error('close button not found');
    act(() => close.click());

    settle?.(
      localControlResponse({
        active: true,
        url: 'http://qwen.test/#pairing=late',
        qrText: 'LATE-QR',
        expiresInMs: 60_000,
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(180_000));

    // The late response must not render into the closed popover, and its
    // refresh timer must not outlive it either.
    expect(container.textContent).not.toContain('LATE-QR');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('recovers from a refresh that never settles', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValueOnce(
      localControlResponse({
        active: true,
        url: 'http://qwen.test/#pairing=old',
        qrText: 'OLD-QR',
        expiresInMs: 60_000,
      }),
    );
    // The refresh settles only when the request's own signal aborts it.
    vi.mocked(fetch).mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          (init as RequestInit | undefined)?.signal?.addEventListener(
            'abort',
            () => reject(new Error('The operation timed out.')),
          );
        }),
    );
    mount();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Mobile access"]')!
        .click(),
    );
    expect(container.textContent).toContain('OLD-QR');

    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(container.textContent).not.toContain('OLD-QR');
    // The stall must land in the error branch so a recovery affordance is on
    // screen instead of the expired copy idling forever.
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).toContain('Retry');
  });

  it('offers a manual retry while an expired refresh is still in flight', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValueOnce(
      localControlResponse({
        active: true,
        url: 'http://qwen.test/#pairing=old',
        qrText: 'OLD-QR',
        expiresInMs: 60_000,
      }),
    );
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => {}));
    mount();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Mobile access"]')!
        .click(),
    );

    await act(async () => vi.advanceTimersByTimeAsync(61_000));
    expect(container.textContent).toContain('QR code expired');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    const retry = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Retry');
    expect(retry).toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => {
      retry!.click();
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('recovers from a failed refresh without a manual retry', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));
    vi.mocked(fetch).mockResolvedValue(
      localControlResponse({
        active: true,
        url: 'http://qwen.test/#pairing=recovered',
        qrText: 'RECOVERED-QR',
        expiresInMs: 60_000,
      }),
    );
    mount();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Mobile access"]')!
        .click(),
    );
    expect(container.textContent).toContain('offline');

    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(container.textContent).toContain('RECOVERED-QR');
    expect(container.textContent).not.toContain('offline');
  });

  it('clears the QR material when the popover closes', async () => {
    vi.mocked(fetch).mockResolvedValue(
      localControlResponse({
        active: true,
        url: 'http://qwen.test/#pairing=one-time',
        qrText: 'QR-TEXT',
        expiresInMs: 60_000,
      }),
    );
    mount();
    await openPopover();
    expect(container.textContent).toContain('QR-TEXT');

    const close = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Close test popover');
    if (!close) throw new Error('close button not found');
    act(() => close.click());

    // A stale frame must not outlive the popover: the invitation the daemon
    // issued is single-use and expires within a minute.
    expect(container.textContent).not.toContain('QR-TEXT');
    expect(container.textContent).not.toContain('#pairing=');
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
