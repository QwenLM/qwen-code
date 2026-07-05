// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';
import { dp } from './dialogStyles';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

let sessions = [
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
];

const deleteSessionMock = vi.fn();
const deleteSessionsMock = vi.fn();
const initialSessions = sessions.slice();

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useConnection: () => ({ sessionId: 'me' }),
  useSessions: () => ({
    sessions,
    loading: false,
    error: undefined,
    deleteSession: deleteSessionMock,
    deleteSessions: deleteSessionsMock,
  }),
}));

const { DeleteSessionDialog } = await import('./DeleteSessionDialog');

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let onDeleted: ReturnType<typeof vi.fn>;
let onError: ReturnType<typeof vi.fn>;
let onClose: ReturnType<typeof vi.fn>;

function renderDialog() {
  root!.render(
    <I18nProvider language="en">
      <DeleteSessionDialog
        onDeleted={onDeleted}
        onError={onError}
        onClose={onClose}
      />
    </I18nProvider>,
  );
}

function mount() {
  onDeleted = vi.fn();
  onError = vi.fn();
  onClose = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    renderDialog();
  });
}

function rerender() {
  act(() => {
    renderDialog();
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

function press(key: string) {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
  });
}

function clickRow(index: number) {
  act(() => {
    rows()[index].dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
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
const isChecked = (el: HTMLElement) => el.textContent?.includes('[x]') === true;

beforeEach(() => {
  deleteSessionMock.mockReset();
  deleteSessionsMock.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  sessions = initialSessions.slice();
});

describe('DeleteSessionDialog selection', () => {
  it('keeps the keyboard cursor separate from the checked set; Enter only toggles', () => {
    mount();

    // Opens with no highlight and nothing checked; delete stays disabled.
    expect(rows().some(isCursor)).toBe(false);
    expect(rows().some(isChecked)).toBe(false);
    expect(dangerButton().disabled).toBe(true);

    // The first ArrowDown lands the cursor on row 0 without checking it.
    press('ArrowDown');
    expect(isCursor(rows()[0])).toBe(true);
    expect(isChecked(rows()[0])).toBe(false);
    expect(dangerButton().disabled).toBe(true);

    // Enter toggles the cursor row's checkbox — it must not delete anything.
    press('Enter');
    expect(isChecked(rows()[0])).toBe(true);
    expect(dangerButton().disabled).toBe(false);
    expect(deleteSessionsMock).not.toHaveBeenCalled();
    expect(deleteSessionMock).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // Moving the cursor keeps prior checks intact (multi-select).
    press('ArrowDown');
    expect(isCursor(rows()[1])).toBe(true);
    expect(isChecked(rows()[0])).toBe(true);
    expect(isChecked(rows()[1])).toBe(false);

    press('Enter');
    expect(isChecked(rows()[1])).toBe(true);

    // Enter on an already-checked row unchecks it.
    press('Enter');
    expect(isChecked(rows()[1])).toBe(false);
    expect(isChecked(rows()[0])).toBe(true);
  });

  it('does not check the current session row', () => {
    mount();

    clickRow(2);
    expect(isChecked(rows()[2])).toBe(false);
    expect(dangerButton().disabled).toBe(true);

    // Keyboard Enter on the current session row must not check it either.
    press('ArrowDown');
    press('ArrowDown');
    press('ArrowDown');
    expect(isCursor(rows()[2])).toBe(true);
    press('Enter');
    expect(isChecked(rows()[2])).toBe(false);
    expect(dangerButton().disabled).toBe(true);
  });

  it('clears checked rows and disarms delete when the filter changes', () => {
    mount();

    clickRow(0);
    clickRow(1);
    expect(isChecked(rows()[0])).toBe(true);
    expect(isChecked(rows()[1])).toBe(true);
    expect(dangerButton().disabled).toBe(false);

    typeFilter('s1');
    expect(rows()).toHaveLength(1);
    expect(isChecked(rows()[0])).toBe(false);
    expect(rows().some(isCursor)).toBe(false);
    expect(dangerButton().disabled).toBe(true);
  });

  it('prunes stale checked ids after an unfiltered session refresh', async () => {
    mount();

    clickRow(0);
    clickRow(1);
    expect(dangerButton().disabled).toBe(false);

    sessions = [
      {
        sessionId: 'me',
        displayName: 'Current Session',
        clientCount: 1,
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ];
    rerender();

    expect(rows()).toHaveLength(1);
    expect(isChecked(rows()[0])).toBe(false);
    expect(dangerButton().disabled).toBe(true);
  });

  it('deletes the checked sessions via the batch API and closes', async () => {
    deleteSessionsMock.mockResolvedValue({
      removed: ['s0', 's1'],
      notFound: [],
      errors: [],
    });
    mount();

    clickRow(0);
    clickRow(1);
    expect(dangerButton().disabled).toBe(false);

    await act(async () => {
      dangerButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(deleteSessionsMock).toHaveBeenCalledWith(['s0', 's1']);
    expect(onDeleted).toHaveBeenCalledWith(['s0', 's1']);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
});
