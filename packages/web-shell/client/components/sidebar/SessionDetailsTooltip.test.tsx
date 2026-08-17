// @vitest-environment jsdom

import { act } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { SessionDetailsTooltip } from './SessionDetailsTooltip';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function openDetails(container: HTMLElement) {
  const trigger = container.querySelector('button');
  if (!trigger) throw new Error('trigger was not rendered');
  await act(async () => {
    trigger.dispatchEvent(new Event('pointerover', { bubbles: true }));
    vi.advanceTimersByTime(300);
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, 'clipboard');
  document.body.replaceChildren();
});

describe('SessionDetailsTooltip', () => {
  it('shows the same structured details on row hover', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <I18nProvider language="en">
          <SessionDetailsTooltip
            session={{
              sessionId: 'session-1',
              workspaceCwd: '/work/qwen-code',
              clientCount: 2,
              branch: { name: 'codex/sidebar', baseBranch: 'main' },
            }}
            label="Improve sidebar"
            time="2 weeks ago"
            completedUnread={false}
          >
            <button type="button">Improve sidebar</button>
          </SessionDetailsTooltip>
        </I18nProvider>,
      );
    });

    await openDetails(container);

    const details = document.querySelector('[role="dialog"]');
    expect(details?.textContent).toContain('Improve sidebar');
    expect(details?.textContent).toContain('2 weeks ago');
    expect(details?.textContent).toContain('qwen-code');
    expect(details?.querySelector('[title="/work/qwen-code"]')).not.toBeNull();
    expect(details?.textContent).toContain('codex/sidebar');
    expect(details?.textContent).toContain('2 client(s)');
    expect(details?.querySelector('svg path.fill-popover')).not.toBeNull();

    act(() => root.unmount());
  });

  it('does not reopen after a row action opens its menu', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    const portalRoot = document.createElement('div');
    document.body.appendChild(container);
    document.body.appendChild(portalRoot);
    const root = createRoot(container);

    act(() => {
      root.render(
        <I18nProvider language="en">
          <SessionDetailsTooltip
            session={{ sessionId: 'session-1', workspaceCwd: '/work/repo' }}
            label="Session"
            time=""
            completedUnread={false}
          >
            <div>
              <button
                type="button"
                onClick={(event) => event.stopPropagation()}
              >
                More
              </button>
              {createPortal(<button type="button">Rename</button>, portalRoot)}
            </div>
          </SessionDetailsTooltip>
        </I18nProvider>,
      );
    });

    const row = container.firstElementChild;
    const action = container.querySelector('button');
    const menuItem = portalRoot.querySelector('button');
    act(() => {
      row?.dispatchEvent(new Event('pointerover', { bubbles: true }));
      vi.advanceTimersByTime(300);
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    act(() => {
      action?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      action?.click();
      vi.advanceTimersByTime(100);
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    act(() => {
      menuItem?.dispatchEvent(new Event('pointerover', { bubbles: true }));
      vi.advanceTimersByTime(300);
    });

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    act(() => root.unmount());
  });

  it('copies the complete session ID from the pointer-only panel', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <I18nProvider language="en">
          <SessionDetailsTooltip
            session={{
              sessionId: 'complete-session-id',
              workspaceCwd: '/work/qwen-code',
            }}
            label="Session"
            time=""
            completedUnread={false}
          >
            <button type="button">Session</button>
          </SessionDetailsTooltip>
        </I18nProvider>,
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>('button');
    await act(async () => {
      trigger?.focus();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await openDetails(container);
    const copy = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy session ID"]',
    );
    expect(copy?.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(trigger);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      copy?.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith('complete-session-id');
    expect(copy?.querySelector('.lucide-check')).not.toBeNull();
    expect(document.querySelector('[aria-live="polite"]')?.className).toBe(
      'sr-only',
    );
    act(() => vi.advanceTimersByTime(2000));
    expect(copy?.querySelector('.lucide-copy')).not.toBeNull();
    act(() => root.unmount());
  });

  it('keeps only the latest copy result', async () => {
    vi.useFakeTimers();
    const first = deferred<void>();
    const second = deferred<void>();
    const writeText = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <I18nProvider language="en">
          <SessionDetailsTooltip
            session={{ sessionId: 'session-id', workspaceCwd: '/work/repo' }}
            label="Session"
            time=""
            completedUnread={false}
          >
            <button type="button">Session</button>
          </SessionDetailsTooltip>
        </I18nProvider>,
      );
    });
    await openDetails(container);
    const copy = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy session ID"]',
    );
    await act(async () => {
      copy?.click();
      copy?.click();
      second.resolve(undefined);
      await second.promise;
    });
    expect(copy?.querySelector('.lucide-check')).not.toBeNull();

    await act(async () => {
      first.reject(new Error('stale failure'));
      await first.promise.catch(() => undefined);
    });
    expect(copy?.querySelector('.lucide-check')).not.toBeNull();
    act(() => root.unmount());
  });

  it('ignores a pending copy result after the details close', async () => {
    vi.useFakeTimers();
    const pending = deferred<void>();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockReturnValue(pending.promise) },
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <I18nProvider language="en">
          <SessionDetailsTooltip
            session={{ sessionId: 'session-id', workspaceCwd: '/work/repo' }}
            label="Session"
            time=""
            completedUnread={false}
          >
            <button type="button">Session</button>
          </SessionDetailsTooltip>
        </I18nProvider>,
      );
    });
    await openDetails(container);
    const trigger = container.querySelector<HTMLButtonElement>('button');
    const copy = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy session ID"]',
    );
    await act(async () => {
      copy?.click();
      trigger?.click();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => {
      pending.resolve(undefined);
      await pending.promise;
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    act(() => root.unmount());
  });

  it('reports clipboard failures', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <I18nProvider language="en">
          <SessionDetailsTooltip
            session={{ sessionId: 'session-id', workspaceCwd: '/work/repo' }}
            label="Session"
            time=""
            completedUnread={false}
          >
            <button type="button">Session</button>
          </SessionDetailsTooltip>
        </I18nProvider>,
      );
    });

    await openDetails(container);
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Copy session ID"]',
        )
        ?.click();
    });

    expect(document.body.textContent).toContain('Failed to copy session ID');
    act(() => root.unmount());
  });
});
