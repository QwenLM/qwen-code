// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DaemonSessionSummary } from '@qwen-code/webui/daemon-react-sdk';
import { I18nProvider } from '../../i18n';
import { dp } from './dialogStyles';
import { SessionRow } from './SessionRow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const session = {
  sessionId: 'sess-1234abcd',
  displayName: 'My Session',
  updatedAt: '2026-01-01T00:00:00.000Z',
  clientCount: 2,
  hasActivePrompt: true,
} as unknown as DaemonSessionSummary;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<I18nProvider language="en">{node}</I18nProvider>);
  });
}

function row(): HTMLElement {
  return container!.querySelector('[role="option"]')!;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('SessionRow', () => {
  it('renders an option with the title and metadata', () => {
    mount(
      <SessionRow
        session={session}
        active={false}
        current={false}
        onClick={vi.fn()}
        onActivate={vi.fn()}
      />,
    );
    expect(row().getAttribute('role')).toBe('option');
    expect(row().textContent).toContain('My Session');
    // clientCount surfaces in the meta line.
    expect(row().textContent).toContain('2');
  });

  it('defaults aria-selected to `current` (not the roving highlight), explicit value wins', () => {
    // The roving highlight must NOT be announced as "selected" — per WAI-ARIA
    // it is conveyed by aria-activedescendant, while aria-selected marks the
    // chosen value (here: the current session, also exposed via aria-current).
    mount(
      <SessionRow
        session={session}
        active={true}
        current={false}
        onClick={vi.fn()}
        onActivate={vi.fn()}
      />,
    );
    expect(row().getAttribute('aria-selected')).toBe('false');
    expect(row().getAttribute('aria-current')).toBeNull();

    act(() => root?.unmount());
    container?.remove();
    mount(
      <SessionRow
        session={session}
        active={false}
        current={true}
        onClick={vi.fn()}
        onActivate={vi.fn()}
      />,
    );
    expect(row().getAttribute('aria-selected')).toBe('true');
    expect(row().getAttribute('aria-current')).toBe('true');

    act(() => root?.unmount());
    container?.remove();
    // Multi-select: an explicit ariaSelected (checked state) wins over current.
    mount(
      <SessionRow
        session={session}
        active={true}
        ariaSelected={false}
        current={true}
        onClick={vi.fn()}
        onActivate={vi.fn()}
      />,
    );
    expect(row().getAttribute('aria-selected')).toBe('false');
  });

  it('marks the current session and exposes the label as a tooltip', () => {
    mount(
      <SessionRow
        session={session}
        active={false}
        current={true}
        currentLabel="current"
        onClick={vi.fn()}
        onActivate={vi.fn()}
      />,
    );
    expect(row().className).toContain(dp('dialog-current'));
    expect(row().getAttribute('title')).toBe('current');
  });

  it('renders leading and trailing slots', () => {
    mount(
      <SessionRow
        session={session}
        active={false}
        current={false}
        leading={<span data-testid="lead">[x]</span>}
        trailing={<span data-testid="trail">inactive</span>}
        onClick={vi.fn()}
        onActivate={vi.fn()}
      />,
    );
    expect(container!.querySelector('[data-testid="lead"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="trail"]')).not.toBeNull();
  });

  it('fires onClick and onActivate', () => {
    const onClick = vi.fn();
    const onActivate = vi.fn();
    mount(
      <SessionRow
        session={session}
        active={false}
        current={false}
        onClick={onClick}
        onActivate={onActivate}
      />,
    );
    act(() => {
      row().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    act(() => {
      row().dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});
