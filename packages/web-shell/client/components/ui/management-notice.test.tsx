// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagementNotice } from './management-notice';

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

function renderNotice(
  tone: ComponentProps<typeof ManagementNotice>['tone'],
  onDismiss = vi.fn(),
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  act(() => {
    root.render(
      <ManagementNotice
        tone={tone}
        noticeKey={`${tone}-notice`}
        closeLabel="Close"
        onDismiss={onDismiss}
      >
        Notice
      </ManagementNotice>,
    );
  });
  return { container, onDismiss };
}

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
});

describe('ManagementNotice', () => {
  it.each(['success', 'info'] as const)(
    'automatically dismisses %s notices after three seconds',
    (tone) => {
      vi.useFakeTimers();
      const { container, onDismiss } = renderNotice(tone);

      expect(container.querySelector('[aria-label="Close"]')).not.toBeNull();
      act(() => vi.advanceTimersByTime(2_999));
      expect(onDismiss).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1));
      expect(onDismiss).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps errors visible until they are manually dismissed', () => {
    vi.useFakeTimers();
    const { container, onDismiss } = renderNotice('error');

    act(() => vi.advanceTimersByTime(3_000));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Close"]')
        ?.click();
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not dismiss or show a close button while progress is active', () => {
    vi.useFakeTimers();
    const { container, onDismiss } = renderNotice('progress');

    expect(container.querySelector('[aria-label="Close"]')).toBeNull();
    act(() => vi.advanceTimersByTime(3_000));
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
