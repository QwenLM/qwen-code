// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  DAEMON_APPROVAL_MODES: ['plan', 'default', 'auto', 'yolo'],
}));

const { ApprovalModeDialog } = await import('./ApprovalModeDialog');

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

function rerender(node: React.ReactNode) {
  act(() => {
    root!.render(<I18nProvider language="en">{node}</I18nProvider>);
  });
}

function press(key: string) {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
  });
}

const activeDescendant = () =>
  container!
    .querySelector('[role="listbox"]')!
    .getAttribute('aria-activedescendant');

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('ApprovalModeDialog', () => {
  it('offers execution permissions without Plan, including Auto', () => {
    mount(<ApprovalModeDialog currentMode="default" onSelect={vi.fn()} />);
    expect(container!.querySelector('[data-mode-id="plan"]')).toBeNull();
    expect(
      container!.querySelector('[data-mode-id="auto"]')?.textContent,
    ).toContain('Classifier Approval (auto)');
  });

  it('opens with the highlight on the current mode and confirms on Enter', () => {
    const onSelect = vi.fn();
    mount(<ApprovalModeDialog currentMode="default" onSelect={onSelect} />);

    expect(activeDescendant()).toBe('mode-opt-0');

    press('ArrowDown');
    expect(activeDescendant()).toBe('mode-opt-1');
    press('Enter');
    expect(onSelect).toHaveBeenCalledWith('auto');
  });

  it('binds aria-selected to the current mode, not the roving highlight', () => {
    mount(<ApprovalModeDialog currentMode="default" onSelect={vi.fn()} />);
    const selected = () =>
      Array.from(container!.querySelectorAll('[aria-selected="true"]'));

    expect(selected()).toHaveLength(1);
    expect(selected()[0].id).toBe('mode-opt-0');

    press('ArrowDown');
    expect(selected()).toHaveLength(1);
    expect(selected()[0].id).toBe('mode-opt-0');
  });

  it('re-syncs the highlight when the current mode changes while open', () => {
    mount(<ApprovalModeDialog currentMode="default" onSelect={vi.fn()} />);
    expect(activeDescendant()).toBe('mode-opt-0');

    // Another client sharing the session flips approval mode while the dialog
    // is open: the highlight (and Enter's target) must follow.
    rerender(<ApprovalModeDialog currentMode="yolo" onSelect={vi.fn()} />);
    expect(activeDescendant()).toBe('mode-opt-2');
  });

  it('stops following once the user has navigated', () => {
    mount(<ApprovalModeDialog currentMode="default" onSelect={vi.fn()} />);

    press('ArrowDown');
    expect(activeDescendant()).toBe('mode-opt-1');

    // The user owns the highlight now — a mode change must not steal it.
    rerender(<ApprovalModeDialog currentMode="yolo" onSelect={vi.fn()} />);
    expect(activeDescendant()).toBe('mode-opt-1');
  });

  it('uses the supplied choices for rendering and keyboard confirmation', () => {
    const onSelect = vi.fn();
    mount(
      <ApprovalModeDialog
        currentMode="yolo"
        availableModes={['default', 'auto']}
        onSelect={onSelect}
      />,
    );
    expect(
      Array.from(container!.querySelectorAll('[data-mode-id]')).map((el) =>
        el.getAttribute('data-mode-id'),
      ),
    ).toEqual(['default', 'auto']);
    press('Enter');
    expect(onSelect).toHaveBeenCalledWith('default');
    press('ArrowDown');
    press('Enter');
    expect(onSelect).toHaveBeenLastCalledWith('auto');
  });

  it('re-anchors the highlight when a same-length swap replaces the highlighted row', () => {
    const onSelect = vi.fn();
    mount(
      <ApprovalModeDialog
        currentMode="default"
        availableModes={['default', 'auto']}
        onSelect={onSelect}
      />,
    );
    press('ArrowDown');
    expect(activeDescendant()).toBe('mode-opt-1');
    rerender(
      <ApprovalModeDialog
        currentMode="default"
        availableModes={['default', 'yolo']}
        onSelect={onSelect}
      />,
    );
    // The highlighted row left the list: the highlight re-anchors to the
    // current mode instead of sitting on a row the user never chose.
    expect(activeDescendant()).toBe('mode-opt-0');
    press('Enter');
    expect(onSelect).toHaveBeenCalledWith('default');
    expect(onSelect).not.toHaveBeenCalledWith('yolo');
  });

  it('follows the highlighted row when a swap keeps it', () => {
    const onSelect = vi.fn();
    mount(
      <ApprovalModeDialog
        currentMode="default"
        availableModes={['default', 'auto']}
        onSelect={onSelect}
      />,
    );
    press('ArrowDown');
    expect(activeDescendant()).toBe('mode-opt-1');
    rerender(
      <ApprovalModeDialog
        currentMode="default"
        availableModes={['auto', 'default']}
        onSelect={onSelect}
      />,
    );
    expect(activeDescendant()).toBe('mode-opt-0');
    press('Enter');
    expect(onSelect).toHaveBeenCalledWith('auto');
  });

  it('keeps keyboard confirmation valid when an open list shrinks', () => {
    const onSelect = vi.fn();
    mount(<ApprovalModeDialog currentMode="yolo" onSelect={onSelect} />);
    press('ArrowUp');
    rerender(
      <ApprovalModeDialog
        currentMode="yolo"
        availableModes={['default']}
        onSelect={onSelect}
      />,
    );
    expect(activeDescendant()).toBe('mode-opt-0');
    press('Enter');
    expect(onSelect).toHaveBeenCalledWith('default');
    rerender(
      <ApprovalModeDialog
        currentMode="yolo"
        availableModes={[]}
        onSelect={onSelect}
      />,
    );
    onSelect.mockClear();
    press('Enter');
    expect(onSelect).not.toHaveBeenCalled();
    expect(activeDescendant()).toBeNull();
    // A later grow must not resurrect the pre-shrink index: the highlight stays
    // on the clamped row and Enter commits what is highlighted.
    rerender(
      <ApprovalModeDialog
        currentMode="yolo"
        availableModes={['default', 'auto', 'yolo']}
        onSelect={onSelect}
      />,
    );
    expect(activeDescendant()).toBe('mode-opt-0');
    press('Enter');
    expect(onSelect).toHaveBeenLastCalledWith('default');
  });

  it('keeps the highlight on the current mode when the list widens while open', () => {
    const onSelect = vi.fn();
    mount(
      <ApprovalModeDialog
        currentMode="yolo"
        availableModes={['default', 'yolo']}
        onSelect={onSelect}
      />,
    );
    expect(activeDescendant()).toBe('mode-opt-1');
    // The operator widens the allowlist while the dialog is open. Both
    // effects fire in one commit, and Enter — normally a no-op re-commit of
    // the current mode — must not land on a row the user never chose.
    rerender(
      <ApprovalModeDialog
        currentMode="yolo"
        availableModes={['default', 'auto', 'yolo']}
        onSelect={onSelect}
      />,
    );
    expect(activeDescendant()).toBe('mode-opt-2');
    press('Enter');
    expect(onSelect).toHaveBeenCalledWith('yolo');
    expect(onSelect).not.toHaveBeenCalledWith('default');
  });

  it('follows the current mode onto a row that arrives with a later list', () => {
    const onSelect = vi.fn();
    mount(
      <ApprovalModeDialog
        currentMode="auto"
        availableModes={['default', 'auto']}
        onSelect={onSelect}
      />,
    );
    expect(activeDescendant()).toBe('mode-opt-1');
    // The session's mode changed to one the old list lacked; the arriving
    // list carries it at the index the old highlight held, and the highlight
    // must land on the current mode — not on the row inheriting the index.
    rerender(
      <ApprovalModeDialog
        currentMode="auto-edit"
        availableModes={['default', 'auto-edit', 'auto', 'yolo']}
        onSelect={onSelect}
      />,
    );
    expect(activeDescendant()).toBe('mode-opt-1');
    press('Enter');
    expect(onSelect).toHaveBeenCalledWith('auto-edit');
    expect(onSelect).not.toHaveBeenCalledWith('auto');
  });
});
