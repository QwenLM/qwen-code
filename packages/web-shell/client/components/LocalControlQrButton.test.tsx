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
    return createElement('div', { onClick: () => setOpen(true) }, children);
  }
  function PopoverContent({ children }: { children?: ReactNode }) {
    return createElement('div', { 'data-test-popover-content': '' }, children);
  }
  return { Popover, PopoverTrigger, PopoverContent };
});

vi.mock('@qwen-code/webui/daemon-react-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/webui/daemon-react-sdk')>();
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

function mount(onOpenSettings: () => void = vi.fn()): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <LocalControlQrButton onOpenSettings={onOpenSettings} />
      </I18nProvider>,
    );
  });
  mounted.push({ root, container });
}

async function openPopover(): Promise<void> {
  const trigger = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Mobile access"]',
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
});

describe('LocalControlQrButton', () => {
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
      new URL('http://127.0.0.1:8080/workspace/local-control'),
      expect.objectContaining({ method: 'GET' }),
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
