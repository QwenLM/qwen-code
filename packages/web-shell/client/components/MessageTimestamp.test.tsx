// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MessageTimestamp, formatTimestamp } from './MessageTimestamp';
import { I18nProvider } from '../i18n';
import { TranscriptRenderModeProvider } from '../transcriptRenderMode';
import styles from './MessageTimestamp.module.css';

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
  act(() => root.render(<I18nProvider language="en">{node}</I18nProvider>));
  mounted.push({ root, container });
  return container;
}

function openMenu(container: HTMLElement) {
  const trigger = container.querySelector<HTMLButtonElement>(
    'button[aria-label="More message actions"]',
  );
  expect(trigger).not.toBeNull();
  act(() => {
    trigger!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
  });
}

function menuItem(label: string): HTMLElement {
  const item = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((element) => element.textContent === label);
  expect(item).toBeDefined();
  return item!;
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
  it('omits the action row and menu in document mode', () => {
    const container = render(
      <TranscriptRenderModeProvider value="document">
        <MessageTimestamp
          timestamp={1}
          chatMode
          copyText="hello"
          onEdit={vi.fn()}
          onDelete={vi.fn()}
        >
          <div>body</div>
        </MessageTimestamp>
      </TranscriptRenderModeProvider>,
    );
    expect(container.textContent).toBe('body');
    expect(container.querySelector('button')).toBeNull();
  });

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

  it('keeps only copy and overflow in the row and edits through the menu', () => {
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
    ).toEqual(['Copy', 'More message actions']);
    openMenu(container);
    act(() => menuItem('Edit message').click());
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('moves tool calls and edit into the overflow menu', () => {
    const onOpenTurnCalls = vi.fn();
    const container = render(
      <MessageTimestamp
        timestamp={1}
        chatMode
        copyText="hello"
        copyTitle="Copy"
        onOpenTurnCalls={onOpenTurnCalls}
        onEdit={vi.fn()}
        editTitle="Edit message"
      >
        <div>body</div>
      </MessageTimestamp>,
    );
    expect(
      [...container.querySelectorAll(`.${styles.chatActions} button`)].map(
        (button) => button.getAttribute('aria-label'),
      ),
    ).toEqual(['Copy', 'More message actions']);
    openMenu(container);
    const toolCalls = menuItem('View tool calls');
    expect(toolCalls.querySelector('.lucide-wrench')).not.toBeNull();
    act(() => toolCalls.click());
    expect(onOpenTurnCalls).toHaveBeenCalledTimes(1);
  });

  it.each([
    { timestamp: undefined },
    { timestamp: 1, hideTimestamp: true },
    { timestamp: 1, chatMode: true },
    { timestamp: 1 },
  ])('deletes through the menu with timestamp options %j', (options) => {
    const onDelete = vi.fn();
    const container = render(
      <MessageTimestamp {...options} onDelete={onDelete}>
        <div>body</div>
      </MessageTimestamp>,
    );
    expect(container.querySelector('[role="menuitem"]')).toBeNull();
    openMenu(container);
    const trigger = container.querySelector('[aria-haspopup="menu"]')!;
    expect(
      document.querySelector('[role="menu"]')?.getAttribute('aria-labelledby'),
    ).toBe(trigger.id);
    act(() => menuItem('Delete messages').click());
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('keeps a disabled deletion entry visible without dispatching it', () => {
    const onDelete = vi.fn();
    const container = render(
      <MessageTimestamp onDelete={onDelete} deleteDisabled>
        <div>body</div>
      </MessageTimestamp>,
    );
    openMenu(container);
    const item = menuItem('Delete messages');
    expect(item.getAttribute('aria-disabled')).toBe('true');
    act(() => item.click());
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('omits the edit action when no handler is given', () => {
    const ts = new Date(2026, 5, 13, 9, 8, 7).getTime();
    const container = render(
      <MessageTimestamp timestamp={ts} chatMode copyText="hello">
        <div>body</div>
      </MessageTimestamp>,
    );

    expect(
      container.querySelector('button[aria-label="More message actions"]'),
    ).toBeNull();
  });
});
