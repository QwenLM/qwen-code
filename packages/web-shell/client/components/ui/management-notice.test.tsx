// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagementNotice } from './management-notice';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

function renderNotice(
  tone: ComponentProps<typeof ManagementNotice>['tone'],
  onDismiss = vi.fn(),
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  act(() =>
    root.render(
      <ManagementNotice
        tone={tone}
        noticeKey={tone}
        closeLabel="Close"
        onDismiss={onDismiss}
      >
        Notice
      </ManagementNotice>,
    ),
  );
  return { container, onDismiss };
}

describe('ManagementNotice', () => {
  afterEach(() => {
    for (const { container, root } of mounted.splice(0)) {
      act(() => root.unmount());
      container.remove();
    }
    vi.useRealTimers();
  });

  it.each(['success', 'info'] as const)('auto-dismisses %s notices', (tone) => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    renderNotice(tone, onDismiss);
    act(() => vi.advanceTimersByTime(3_000));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('keeps errors visible and allows manual dismissal', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const view = renderNotice('error', onDismiss);
    act(() => vi.advanceTimersByTime(10_000));
    expect(onDismiss).not.toHaveBeenCalled();
    const button = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Close"]',
    );
    expect(button).not.toBeNull();
    act(() => button?.click());
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('keeps progress visible and cannot be dismissed', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const view = renderNotice('progress', onDismiss);
    expect(
      view.container.querySelector('button[aria-label="Close"]'),
    ).toBeNull();
    act(() => vi.advanceTimersByTime(10_000));
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
