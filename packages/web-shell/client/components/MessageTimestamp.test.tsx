// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MessageTimestamp, formatTimestamp } from './MessageTimestamp';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
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

  it('shows only HH:mm:ss for a same-day timestamp', () => {
    const ts = new Date(2026, 5, 13, 9, 8, 7).getTime();
    expect(formatTimestamp(ts, now)).toBe('09:08:07');
  });

  it('shows full yyyy-MM-dd HH:mm:ss for an earlier day in the same year', () => {
    const ts = new Date(2026, 0, 2, 9, 8, 7).getTime();
    expect(formatTimestamp(ts, now)).toBe('2026-01-02 09:08:07');
  });

  it('shows full yyyy-MM-dd HH:mm:ss for a previous year', () => {
    // Same month/day as `now` but last year — must not be read as "today".
    const ts = new Date(2025, 5, 13, 9, 8, 7).getTime();
    expect(formatTimestamp(ts, now)).toBe('2025-06-13 09:08:07');
  });
});

describe('MessageTimestamp', () => {
  it('reveals the wall-clock time as a hover tooltip when a timestamp is set', () => {
    const ts = new Date(2026, 5, 13, 9, 8, 7).getTime();
    const container = render(
      <MessageTimestamp timestamp={ts}>
        <div>body</div>
      </MessageTimestamp>,
    );

    const tip = container.querySelector('span[aria-hidden="true"]');
    expect(tip).not.toBeNull();
    // Every variant ends in HH:mm:ss; the leading parts depend on the real
    // "now", so assert the shape rather than an exact string here.
    expect(tip?.textContent).toMatch(/\d{2}:\d{2}:\d{2}$/);
    expect(container.textContent).toContain('body');
  });

  it('renders children unchanged with no tooltip when timestamp is undefined', () => {
    const container = render(
      <MessageTimestamp>
        <div data-testid="child">body</div>
      </MessageTimestamp>,
    );

    expect(container.querySelector('span[aria-hidden="true"]')).toBeNull();
    // No wrapper element is introduced: the child stays a direct child of the
    // mount container, so message spacing/structure is untouched.
    const child = container.querySelector('[data-testid="child"]');
    expect(child).not.toBeNull();
    expect(child?.parentElement).toBe(container);
  });
});
