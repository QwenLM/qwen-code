// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  DAEMON_APPROVAL_MODES: ['plan', 'default', 'yolo'],
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
  it('opens with the highlight on the current mode and confirms on Enter', () => {
    const onSelect = vi.fn();
    mount(<ApprovalModeDialog currentMode="default" onSelect={onSelect} />);

    expect(activeDescendant()).toBe('mode-opt-1');

    press('ArrowDown');
    expect(activeDescendant()).toBe('mode-opt-2');
    press('Enter');
    expect(onSelect).toHaveBeenCalledWith('yolo');
  });

  it('binds aria-selected to the current mode, not the roving highlight', () => {
    mount(<ApprovalModeDialog currentMode="plan" onSelect={vi.fn()} />);
    const selected = () =>
      Array.from(container!.querySelectorAll('[aria-selected="true"]'));

    expect(selected()).toHaveLength(1);
    expect(selected()[0].id).toBe('mode-opt-0');

    press('ArrowDown');
    expect(selected()).toHaveLength(1);
    expect(selected()[0].id).toBe('mode-opt-0');
  });

  it('re-syncs the highlight when the current mode changes while open', () => {
    mount(<ApprovalModeDialog currentMode="plan" onSelect={vi.fn()} />);
    expect(activeDescendant()).toBe('mode-opt-0');

    // Another client sharing the session flips approval mode while the dialog
    // is open: the highlight (and Enter's target) must follow.
    rerender(<ApprovalModeDialog currentMode="yolo" onSelect={vi.fn()} />);
    expect(activeDescendant()).toBe('mode-opt-2');
  });

  it('stops following once the user has navigated', () => {
    mount(<ApprovalModeDialog currentMode="plan" onSelect={vi.fn()} />);

    press('ArrowDown');
    expect(activeDescendant()).toBe('mode-opt-1');

    // The user owns the highlight now — a mode change must not steal it.
    rerender(<ApprovalModeDialog currentMode="yolo" onSelect={vi.fn()} />);
    expect(activeDescendant()).toBe('mode-opt-1');
  });
});
