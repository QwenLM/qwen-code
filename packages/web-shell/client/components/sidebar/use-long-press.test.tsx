// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LONG_PRESS_DELAY_MS, useLongPress } from './use-long-press';

let container: HTMLDivElement;
let root: Root;

function createPointerEvent(
  type: string,
  init: {
    pointerType?: string;
    pointerId?: number;
    isPrimary?: boolean;
    clientX?: number;
    clientY?: number;
  } = {},
): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 20,
    clientY: init.clientY ?? 20,
  });
  Object.defineProperty(event, 'pointerType', {
    value: init.pointerType ?? 'touch',
  });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 });
  Object.defineProperty(event, 'isPrimary', { value: init.isPrimary ?? true });
  return event;
}

function Harness({
  enabled = true,
  onLongPress,
  onRowClick,
}: {
  enabled?: boolean;
  onLongPress: () => void;
  onRowClick: () => void;
}) {
  const { pressing, handlers } = useLongPress({ enabled, onLongPress });
  return (
    <div
      data-testid="row"
      data-pressing={pressing ? 'true' : undefined}
      onClick={onRowClick}
      {...handlers}
    >
      <span data-testid="title">Session Title</span>
      <button type="button" data-testid="nested-btn">
        More
      </button>
    </div>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
});

describe('useLongPress', () => {
  it('fires onLongPress after delay and suppresses the trailing click', () => {
    const onLongPress = vi.fn();
    const onRowClick = vi.fn();

    act(() => {
      root.render(
        <Harness onLongPress={onLongPress} onRowClick={onRowClick} />,
      );
    });

    const row = container.querySelector('[data-testid="row"]') as HTMLElement;
    const title = container.querySelector(
      '[data-testid="title"]',
    ) as HTMLElement;

    act(() => {
      title.dispatchEvent(createPointerEvent('pointerdown'));
    });
    expect(row.dataset.pressing).toBe('true');

    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_DELAY_MS - 1);
    });
    expect(onLongPress).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(row.dataset.pressing).toBeUndefined();

    // Trailing click from finger release must be swallowed so openRow does not fire.
    const clickEvent = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      title.dispatchEvent(clickEvent);
    });
    expect(clickEvent.defaultPrevented).toBe(true);
    expect(onRowClick).not.toHaveBeenCalled();

    // A later ordinary tap works normally.
    act(() => {
      title.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });

  it('cancels when pointer moves beyond threshold (vertical scroll)', () => {
    const onLongPress = vi.fn();
    const onRowClick = vi.fn();

    act(() => {
      root.render(
        <Harness onLongPress={onLongPress} onRowClick={onRowClick} />,
      );
    });

    const row = container.querySelector('[data-testid="row"]') as HTMLElement;
    act(() => {
      row.dispatchEvent(
        createPointerEvent('pointerdown', { clientX: 50, clientY: 100 }),
      );
    });
    expect(row.dataset.pressing).toBe('true');

    act(() => {
      row.dispatchEvent(
        createPointerEvent('pointermove', { clientX: 50, clientY: 112 }),
      );
    });
    expect(row.dataset.pressing).toBeUndefined();

    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_DELAY_MS + 50);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('cancels on pointerup and pointercancel before the delay', () => {
    const onLongPress = vi.fn();
    const onRowClick = vi.fn();

    act(() => {
      root.render(
        <Harness onLongPress={onLongPress} onRowClick={onRowClick} />,
      );
    });

    const row = container.querySelector('[data-testid="row"]') as HTMLElement;
    act(() => {
      row.dispatchEvent(createPointerEvent('pointerdown'));
      vi.advanceTimersByTime(200);
      row.dispatchEvent(createPointerEvent('pointerup'));
      vi.advanceTimersByTime(LONG_PRESS_DELAY_MS);
    });
    expect(onLongPress).not.toHaveBeenCalled();

    act(() => {
      row.dispatchEvent(createPointerEvent('pointerdown'));
      vi.advanceTimersByTime(200);
      row.dispatchEvent(createPointerEvent('pointercancel'));
      vi.advanceTimersByTime(LONG_PRESS_DELAY_MS);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('ignores mouse pointers and nested interactive buttons', () => {
    const onLongPress = vi.fn();
    const onRowClick = vi.fn();

    act(() => {
      root.render(
        <Harness onLongPress={onLongPress} onRowClick={onRowClick} />,
      );
    });

    const row = container.querySelector('[data-testid="row"]') as HTMLElement;
    const btn = container.querySelector(
      '[data-testid="nested-btn"]',
    ) as HTMLElement;

    act(() => {
      row.dispatchEvent(
        createPointerEvent('pointerdown', { pointerType: 'mouse' }),
      );
      vi.advanceTimersByTime(LONG_PRESS_DELAY_MS + 50);
    });
    expect(onLongPress).not.toHaveBeenCalled();

    act(() => {
      btn.dispatchEvent(
        createPointerEvent('pointerdown', { pointerType: 'touch' }),
      );
      vi.advanceTimersByTime(LONG_PRESS_DELAY_MS + 50);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('suppresses contextmenu during active or completed long press', () => {
    const onLongPress = vi.fn();
    act(() => {
      root.render(<Harness onLongPress={onLongPress} onRowClick={vi.fn()} />);
    });

    const row = container.querySelector('[data-testid="row"]') as HTMLElement;
    act(() => {
      row.dispatchEvent(createPointerEvent('pointerdown'));
    });
    const ctxEvent = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      row.dispatchEvent(ctxEvent);
    });
    expect(ctxEvent.defaultPrevented).toBe(true);
  });
});
