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

const isSelected = (el: HTMLElement) => el.className.includes(dp('selected'));

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('ReleaseSessionDialog selection', () => {
  it('does not select on hover — the release target only follows a click', () => {
    mount();

    // Nothing selected until a deliberate click; the action stays disabled.
    expect(dangerButton().disabled).toBe(true);
    act(() => {
      rows()[0].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    });
    expect(isSelected(rows()[0])).toBe(false);
    expect(dangerButton().disabled).toBe(true);

    // Clicking commits the selection (persistent).
    act(() => {
      rows()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(isSelected(rows()[0])).toBe(true);
    expect(dangerButton().disabled).toBe(false);

    // Moving the pointer over another row must NOT steal the selection.
    act(() => {
      rows()[1].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    });
    expect(isSelected(rows()[0])).toBe(true);
    expect(isSelected(rows()[1])).toBe(false);
  });
});
