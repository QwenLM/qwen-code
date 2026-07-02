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

// ModelDialog only reads `useConnection()`; models/current come in via props here.
vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useConnection: () => ({}),
}));

const { ModelDialog } = await import('./ModelDialog');

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

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('ModelDialog current marker', () => {
  it('marks exactly one row current when two models share an id', () => {
    // Two providers expose the same model id "qwen"; `currentModel` is only an
    // id, so both used to be flagged. Only the first match should be current.
    const models = [
      { id: 'qwen', authType: 'a', baseUrl: 'https://a' },
      { id: 'qwen', authType: 'b', baseUrl: 'https://b' },
      { id: 'other', authType: 'c' },
    ];
    mount(
      <ModelDialog onSelect={vi.fn()} models={models} currentModelId="qwen" />,
    );

    const options = Array.from(container!.querySelectorAll('[role="option"]'));
    expect(options).toHaveLength(3);
    const currentClass = dp('dialog-current');
    const marked = options.filter((el) => el.className.includes(currentClass));
    expect(marked).toHaveLength(1);
    expect(marked[0].textContent).toContain('1.');
  });

  it('binds aria-selected to the current model, not the roving highlight', () => {
    const models = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    mount(
      <ModelDialog onSelect={vi.fn()} models={models} currentModelId="b" />,
    );
    const selected = () =>
      Array.from(container!.querySelectorAll('[aria-selected="true"]'));

    // Only the current model (b) is aria-selected on open.
    expect(selected()).toHaveLength(1);
    expect(selected()[0].textContent).toContain('b');

    // Moving the keyboard highlight must not change which row is aria-selected.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    });
    expect(selected()).toHaveLength(1);
    expect(selected()[0].textContent).toContain('b');
  });
});

describe('ModelDialog keyboard confirmation', () => {
  it('confirms the highlighted model on Enter', () => {
    const onSelect = vi.fn();
    const models = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    mount(
      <ModelDialog onSelect={onSelect} models={models} currentModelId="b" />,
    );

    // Enter with no navigation confirms the current model's row.
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }),
      );
    });
    expect(onSelect).toHaveBeenCalledWith('b');

    // After arrowing, Enter confirms the newly highlighted row.
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }),
      );
    });
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }),
      );
    });
    expect(onSelect).toHaveBeenLastCalledWith('c');
  });
});

describe('ModelDialog highlight follows the current model', () => {
  const models = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const activeDescendant = () =>
    container!
      .querySelector('[role="listbox"]')!
      .getAttribute('aria-activedescendant');

  it('re-syncs the highlight when the current model changes while open', () => {
    mount(
      <ModelDialog onSelect={vi.fn()} models={models} currentModelId="a" />,
    );
    expect(activeDescendant()).toBe('model-opt-0');

    // Another client sharing the session switches the model while the dialog
    // is open: the highlight (and thus detail panel / Enter) must follow.
    act(() => {
      root!.render(
        <I18nProvider language="en">
          <ModelDialog onSelect={vi.fn()} models={models} currentModelId="c" />
        </I18nProvider>,
      );
    });
    expect(activeDescendant()).toBe('model-opt-2');
  });

  it('stops following once the user has navigated', () => {
    mount(
      <ModelDialog onSelect={vi.fn()} models={models} currentModelId="a" />,
    );

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    });
    expect(activeDescendant()).toBe('model-opt-1');

    // The user owns the highlight now — a current-model change must not steal it.
    act(() => {
      root!.render(
        <I18nProvider language="en">
          <ModelDialog onSelect={vi.fn()} models={models} currentModelId="c" />
        </I18nProvider>,
      );
    });
    expect(activeDescendant()).toBe('model-opt-1');
  });
});
