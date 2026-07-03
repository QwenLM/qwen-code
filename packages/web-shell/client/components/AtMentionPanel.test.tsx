// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AtMentionPanel } from './AtMentionPanel';
import type { AtMentionMenuState } from '../hooks/useAtMentionMenu';
import { I18nProvider } from '../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class ResizeObserverMock {
  observe = vi.fn();
  disconnect = vi.fn();
}

globalThis.ResizeObserver =
  ResizeObserverMock as unknown as typeof ResizeObserver;

let container: HTMLDivElement | null = null;
let anchor: HTMLDivElement | null = null;
let root: Root | null = null;

function categoriesMenu(): AtMentionMenuState {
  return {
    from: 0,
    to: 1,
    query: '',
    level: 'categories',
    selectedIndex: 0,
    providers: [
      {
        id: 'files',
        label: 'Files',
        description: 'Reference workspace files',
      },
    ],
    items: [],
    loading: false,
  };
}

function itemsMenu(): AtMentionMenuState {
  return {
    ...categoriesMenu(),
    level: 'items',
    selectedProviderId: 'files',
    items: [
      {
        id: 'readme',
        label: 'README.md',
        insertText: '@README.md ',
      },
    ],
  };
}

function mount(menu: AtMentionMenuState, handlers = {}) {
  container = document.createElement('div');
  anchor = document.createElement('div');
  document.body.append(container, anchor);
  anchor.getBoundingClientRect = vi.fn(() => ({
    x: 20,
    y: 100,
    top: 100,
    right: 420,
    bottom: 140,
    left: 20,
    width: 400,
    height: 40,
    toJSON: () => ({}),
  }));
  root = createRoot(container);
  act(() => {
    root!.render(
      <I18nProvider language="en">
        <AtMentionPanel
          menu={menu}
          anchorRef={{ current: anchor }}
          panelRef={{ current: null }}
          onSelect={vi.fn()}
          onAccept={vi.fn()}
          onBack={vi.fn()}
          onSearch={vi.fn()}
          {...handlers}
        />
      </I18nProvider>,
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  anchor?.remove();
  document.body
    .querySelectorAll('[role="listbox"]')
    .forEach((node) => node.remove());
  container = null;
  anchor = null;
  root = null;
});

describe('AtMentionPanel', () => {
  it('renders provider categories in a listbox', () => {
    mount(categoriesMenu());

    expect(
      document.body
        .querySelector('[role="dialog"]')
        ?.getAttribute('aria-label'),
    ).toBe('Reference menu');
    expect(
      document.body
        .querySelector('[role="listbox"]')
        ?.getAttribute('aria-label'),
    ).toBe('Reference menu');
    expect(document.body.textContent).toContain('Files');
    expect(document.body.textContent).toContain('Reference workspace files');
  });

  it('dispatches item-search keyboard actions', () => {
    const onBack = vi.fn();
    const onAccept = vi.fn();
    const onSelect = vi.fn();
    mount(itemsMenu(), { onBack, onAccept, onSelect });

    const input = document.body.querySelector('input')!;
    expect(input.getAttribute('aria-label')).toBe('Search');
    expect(input.getAttribute('aria-controls')).toBe('at-mention-listbox');
    expect(input.getAttribute('aria-activedescendant')).toBe(
      'at-mention-option-0',
    );
    expect(document.getElementById('at-mention-option-0')).not.toBeNull();
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });

    expect(onAccept).toHaveBeenCalledTimes(2);
    expect(onBack).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(0);
  });

  it('lets IME composition keys pass through the item search input', () => {
    const onBack = vi.fn();
    const onAccept = vi.fn();
    const onSelect = vi.fn();
    mount(itemsMenu(), { onBack, onAccept, onSelect });

    const input = document.body.querySelector('input')!;
    const enterEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
    });
    Object.defineProperty(enterEvent, 'isComposing', { value: true });
    const arrowEvent = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
    });
    Object.defineProperty(arrowEvent, 'keyCode', { value: 229 });
    act(() => {
      input.dispatchEvent(enterEvent);
      input.dispatchEvent(arrowEvent);
    });

    expect(onAccept).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('activates panel buttons from click events', () => {
    const onBack = vi.fn();
    const onAccept = vi.fn();
    mount(itemsMenu(), { onBack, onAccept });

    const buttons = document.body.querySelectorAll('button');
    act(() => {
      buttons[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      buttons[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onBack).toHaveBeenCalledOnce();
    expect(onAccept).toHaveBeenCalledWith(0);
  });

  it('shows loading state', () => {
    mount({ ...itemsMenu(), items: [], loading: true });
    expect(document.body.textContent).toContain('Loading...');
  });

  it('shows empty state', () => {
    mount({ ...itemsMenu(), items: [], loading: false });
    expect(document.body.textContent).toContain('No results');
  });
});
