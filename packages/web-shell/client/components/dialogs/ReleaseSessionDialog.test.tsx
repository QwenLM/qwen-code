// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';
import { dp } from './dialogStyles';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const sessions = [
  {
    sessionId: 's0',
    displayName: 'S0',
    clientCount: 1,
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    sessionId: 's1',
    displayName: 'S1',
    clientCount: 1,
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    sessionId: 'me',
    displayName: 'Current Session',
    clientCount: 1,
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    sessionId: 'inactive',
    displayName: 'Inactive Session',
    clientCount: 0,
    hasActivePrompt: false,
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useConnection: () => ({ sessionId: 'me' }),
  useSessions: () => ({
    sessions,
    loading: false,
    error: undefined,
    releaseSession: vi.fn().mockResolvedValue(undefined),
  }),
}));

const { ReleaseSessionDialog } = await import('./ReleaseSessionDialog');

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <I18nProvider language="en">
        <ReleaseSessionDialog
          onReleased={vi.fn()}
          onError={vi.fn()}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );
  });
}

function rows(): HTMLElement[] {
  return Array.from(container!.querySelectorAll('[role="option"]'));
}

function dangerButton(): HTMLButtonElement {
  return Array.from(container!.querySelectorAll('button')).find((b) =>
    b.className.includes(dp('dialog-danger-button')),
  ) as HTMLButtonElement;
}

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  'value',
)!.set!;

function typeFilter(value: string) {
  act(() => {
    const el = container!.querySelector('input')!;
    nativeInputValueSetter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const isCursor = (el: HTMLElement) => el.className.includes(dp('selected'));
const isConfirmed = (el: HTMLElement) =>
  el.className.includes(dp('picker-item-confirmed'));

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('ReleaseSessionDialog selection', () => {
  it('keeps the cursor and the confirmed target separate', () => {
    mount();

    // The dialog opens with no highlight at all; Enter has nothing to act on.
    expect(rows().some(isCursor)).toBe(false);
    expect(rows().some(isConfirmed)).toBe(false);
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(rows().some(isConfirmed)).toBe(false);
    expect(dangerButton().disabled).toBe(true);

    // The first ArrowDown lands on row 0 without confirming it.
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    expect(isCursor(rows()[0])).toBe(true);
    expect(isConfirmed(rows()[0])).toBe(false);
    expect(dangerButton().disabled).toBe(true);

    // Arrowing to another row must not confirm/enable the destructive action.
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    expect(isCursor(rows()[1])).toBe(true);
    expect(isConfirmed(rows()[1])).toBe(false);
    expect(dangerButton().disabled).toBe(true);

    // Enter confirms the current cursor row and enables the action.
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(isConfirmed(rows()[1])).toBe(true);
    expect(dangerButton().disabled).toBe(false);

    // Moving the cursor again must not steal the confirmed target.
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
      );
    });
    expect(isCursor(rows()[0])).toBe(true);
    expect(isConfirmed(rows()[1])).toBe(true);
    expect(isConfirmed(rows()[0])).toBe(false);
    expect(dangerButton().disabled).toBe(false);
  });

  it('moves the cursor on hover, but only Enter/click confirms the target', () => {
    mount();

    // Hover updates the cursor so the visible gray row matches Enter's target,
    // but the destructive action still stays disabled until confirmation.
    act(() => {
      rows()[1].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    });
    expect(isCursor(rows()[1])).toBe(true);
    expect(isConfirmed(rows()[1])).toBe(false);
    expect(dangerButton().disabled).toBe(true);

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(isConfirmed(rows()[1])).toBe(true);
    expect(dangerButton().disabled).toBe(false);
  });

  it('does not confirm the current or an inactive session on click', () => {
    mount();

    // Current session row cannot become the confirmed target.
    act(() => {
      rows()[2].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(isConfirmed(rows()[2])).toBe(false);
    expect(dangerButton().disabled).toBe(true);

    // Inactive session row cannot become the confirmed target either.
    act(() => {
      rows()[3].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(isConfirmed(rows()[3])).toBe(false);
    expect(dangerButton().disabled).toBe(true);
  });

  it('clears the confirmed target and disarms release when the filter changes', () => {
    mount();

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(isConfirmed(rows()[1])).toBe(true);
    expect(dangerButton().disabled).toBe(false);

    typeFilter('s1');
    expect(rows()).toHaveLength(1);
    expect(rows().some(isConfirmed)).toBe(false);
    expect(rows().some(isCursor)).toBe(false);
    expect(dangerButton().disabled).toBe(true);
  });

  it('does not confirm any row when all visible rows are non-releasable', () => {
    const original = sessions.slice();
    try {
      sessions.splice(
        0,
        sessions.length,
        {
          sessionId: 'me',
          displayName: 'Current Session',
          clientCount: 1,
          updatedAt: '2026-01-01T00:00:00Z',
        },
        {
          sessionId: 'inactive',
          displayName: 'Inactive Session',
          clientCount: 0,
          hasActivePrompt: false,
          updatedAt: '2026-01-01T00:00:00Z',
        },
      );
      mount();

      act(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
        );
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
      });
      expect(rows().some((row) => isConfirmed(row))).toBe(false);
      expect(dangerButton().disabled).toBe(true);
    } finally {
      sessions.splice(0, sessions.length, ...original);
    }
  });
});
