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

let sessions = [
  {
    sessionId: 'alpha-id',
    displayName: 'Alpha',
    clientCount: 1,
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    sessionId: 'beta-id',
    displayName: 'Beta',
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
const initialSessions = sessions.slice();
let scopedSessionsOptions: unknown;

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useConnection: () => ({ sessionId: 'me' }),
}));

vi.mock('../../hooks/useScopedSessions', () => ({
  useScopedSessions: (_workspaceCwd: unknown, options: unknown) => {
    scopedSessionsOptions = options;
    return {
      sessions,
      loading: false,
      error: undefined,
    };
  },
}));

const { ResumeDialog } = await import('./ResumeDialog');

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let onSelect: ReturnType<typeof vi.fn>;
let onClose: ReturnType<typeof vi.fn>;

function mount() {
  onSelect = vi.fn();
  onClose = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <I18nProvider language="en">
        <ResumeDialog onSelect={onSelect} onClose={onClose} />
      </I18nProvider>,
    );
  });
}

function rows(): HTMLElement[] {
  return Array.from(container!.querySelectorAll('[role="option"]'));
}

function press(key: string) {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
  });
}

// React installs a value tracker on the input, so set the value through the
// prototype's native setter for React's onChange to observe the change.
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

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  sessions = initialSessions.slice();
});

describe('ResumeDialog', () => {
  it('opens with no highlight; Enter does not switch sessions', () => {
    mount();

    expect(scopedSessionsOptions).toEqual({
      autoLoad: true,
      maxAgeMs: 1_000,
    });
    expect(rows()).toHaveLength(3);
    expect(rows().some(isCursor)).toBe(false);

    // A reflexive Enter in the search box must not resume anything.
    press('Enter');
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('resumes the highlighted session on Enter after arrow navigation', () => {
    mount();

    // First ArrowDown lands on row 0; a second moves to row 1.
    press('ArrowDown');
    expect(isCursor(rows()[0])).toBe(true);
    press('ArrowDown');
    expect(isCursor(rows()[1])).toBe(true);

    press('Enter');
    expect(onSelect).toHaveBeenCalledWith('beta-id');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('resets the highlight on filter edits and confirms within the filtered list', () => {
    mount();

    // Navigate first, then type: editing the filter must clear the highlight
    // so Enter cannot confirm a row the user did not visibly re-pick.
    press('ArrowDown');
    expect(isCursor(rows()[0])).toBe(true);

    typeFilter('beta');
    expect(rows()).toHaveLength(1);
    expect(rows().some(isCursor)).toBe(false);

    press('Enter');
    expect(onSelect).not.toHaveBeenCalled();

    // Re-navigating confirms the correct session from the filtered list.
    press('ArrowDown');
    expect(isCursor(rows()[0])).toBe(true);
    press('Enter');
    expect(onSelect).toHaveBeenCalledWith('beta-id');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('matches a session by its bound PR number in the filter', () => {
    sessions = [
      {
        sessionId: 'pr-id',
        displayName: 'Fix CI',
        clientCount: 1,
        updatedAt: '2026-01-01T00:00:00Z',
        prs: [{ number: 9517, url: 'https://github.com/o/r/pull/9517' }],
      },
      {
        sessionId: 'other',
        displayName: 'Unrelated',
        clientCount: 1,
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ];
    mount();

    typeFilter('#9517');
    expect(rows()).toHaveLength(1);
    expect(rows()[0].textContent).toContain('Fix CI');

    typeFilter('#9999');
    expect(rows()).toHaveLength(0);
  });
});
