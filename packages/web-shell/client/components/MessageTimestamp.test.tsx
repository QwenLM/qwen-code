// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MessageTimestamp, formatTimestamp } from './MessageTimestamp';
import styles from './MessageTimestamp.module.css';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 5, 13, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function render(node: ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

describe('formatTimestamp', () => {
  // Built from local-time parts so expectations are timezone independent
  // (month is 0-based: 5 = June).
  const now = new Date(2026, 5, 13, 12, 0, 0);

  it('shows only time for a same-day timestamp', () => {
    const ts = new Date(2026, 5, 13, 9, 8, 7).getTime();
    expect(formatTimestamp(ts, now)).toBe('09:08:07');
  });

  it('shows full yyyy-MM-dd HH:mm:ss for an earlier day in the same year', () => {
    const ts = new Date(2026, 0, 2, 9, 8, 7).getTime();
    expect(formatTimestamp(ts)).toBe('2026-01-02 09:08:07');
  });

  it('distinguishes dates on either side of local midnight', () => {
    vi.setSystemTime(new Date(2026, 0, 2, 0, 0, 1));
    expect(formatTimestamp(new Date(2026, 0, 1, 23, 59, 59).getTime())).toBe(
      '2026-01-01 23:59:59',
    );
    expect(formatTimestamp(new Date(2026, 0, 2, 0, 0, 0).getTime())).toBe(
      '00:00:00',
    );
  });

  it('shows full yyyy-MM-dd HH:mm:ss for a previous year', () => {
    // Same month/day as `now` but last year — must not be read as "today".
    const ts = new Date(2025, 5, 13, 9, 8, 7).getTime();
    expect(formatTimestamp(ts)).toBe('2025-06-13 09:08:07');
  });
});

describe('MessageTimestamp', () => {
  it.each([false, true])('shows the date with chatMode=%s', (chatMode) => {
    const ts = new Date(2026, 5, 12, 9, 8, 7).getTime();
    const container = render(
      <MessageTimestamp timestamp={ts} chatMode={chatMode}>
        <div>body</div>
      </MessageTimestamp>,
    );

    const tip = container.querySelector('span[aria-hidden="true"]');
    expect(tip).not.toBeNull();
    expect(tip?.textContent).toBe('2026-06-12 09:08:07');
    expect(container.textContent).toContain('body');
  });

  it('renders no wrapper when timestamp is undefined', () => {
    const container = render(
      <MessageTimestamp>
        <div data-testid="child">body</div>
      </MessageTimestamp>,
    );

    expect(container.querySelector('span[aria-hidden="true"]')).toBeNull();
    const child = container.querySelector('[data-testid="child"]');
    expect(child).not.toBeNull();
    expect(child?.parentElement).toBe(container);
  });

  it('uses larger spacing only when requested for a tool group', () => {
    const defaultRow = render(
      <MessageTimestamp>
        <div>default</div>
      </MessageTimestamp>,
    );
    const toolRow = render(
      <MessageTimestamp toolGroupSpacing>
        <div>tool</div>
      </MessageTimestamp>,
    );

    expect(defaultRow.firstElementChild?.classList).not.toContain(
      styles.toolGroupSpacing,
    );
    expect(toolRow.firstElementChild?.classList).toContain(
      styles.toolGroupSpacing,
    );
  });

  it('renders the edit action after the copy action in the hover row', () => {
    const onEdit = vi.fn();
    const ts = new Date(2026, 5, 13, 9, 8, 7).getTime();
    const container = render(
      <MessageTimestamp
        timestamp={ts}
        chatMode
        copyText="hello"
        copyTitle="Copy"
        onEdit={onEdit}
        editTitle="Edit message"
      >
        <div>body</div>
      </MessageTimestamp>,
    );

    const actions = container.querySelectorAll(`.${styles.chatActions} button`);
    expect(
      [...actions].map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Copy', 'Edit message']);
    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Edit message"]')
        ?.click();
    });
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('omits the edit action when no handler is given', () => {
    const ts = new Date(2026, 5, 13, 9, 8, 7).getTime();
    const container = render(
      <MessageTimestamp timestamp={ts} chatMode copyText="hello">
        <div>body</div>
      </MessageTimestamp>,
    );

    expect(
      container.querySelector('button[aria-label="Edit message"]'),
    ).toBeNull();
  });
});
