// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { DialogShell } from '../components/dialogs/DialogShell';
import { I18nProvider } from '../i18n';
import { ThemeProvider } from '../themeContext';
import { createRoot, type Root } from 'react-dom/client';
import { useListboxKeyboard } from './useListboxKeyboard';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface HarnessProps {
  itemCount: number;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onConfirm: (index: number) => void;
  enabled?: boolean;
  onKeyboardMode?: (value: boolean) => void;
}

function Harness({ onKeyboardMode, ...props }: HarnessProps) {
  const { keyboardMode } = useListboxKeyboard(props);
  onKeyboardMode?.(keyboardMode);
  return null;
}

function ScopedHarness({
  name,
  onKeyboardMode,
  ...props
}: HarnessProps & { name: string }) {
  const { keyboardMode } = useListboxKeyboard(props);
  onKeyboardMode?.(keyboardMode);
  return (
    <div data-scope={name} tabIndex={-1}>
      {name}
    </div>
  );
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(props: HarnessProps) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Harness {...props} />);
  });
}

function mountNode(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
}

function press(key: string) {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key, cancelable: true }),
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('useListboxKeyboard', () => {
  it('moves the active index down and up within bounds', () => {
    const onActiveIndexChange = vi.fn();
    mount({
      itemCount: 3,
      activeIndex: 1,
      onActiveIndexChange,
      onConfirm: vi.fn(),
    });

    press('ArrowDown');
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(2);

    press('ArrowUp');
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(0);
  });

  it('clamps at the edges', () => {
    const onActiveIndexChange = vi.fn();
    mount({
      itemCount: 3,
      activeIndex: 2,
      onActiveIndexChange,
      onConfirm: vi.fn(),
    });

    press('ArrowDown');
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(2);
  });

  it('jumps to first/last with Home/End', () => {
    const onActiveIndexChange = vi.fn();
    mount({
      itemCount: 5,
      activeIndex: 2,
      onActiveIndexChange,
      onConfirm: vi.fn(),
    });

    press('End');
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(4);
    press('Home');
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(0);
  });

  it('yields Home/End to a focused text input for caret movement', () => {
    const onActiveIndexChange = vi.fn();
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.focus();
    mount({
      itemCount: 5,
      activeIndex: 2,
      onActiveIndexChange,
      onConfirm: vi.fn(),
    });

    press('Home');
    press('End');
    // The input keeps Home/End for its caret; the list is not moved.
    expect(onActiveIndexChange).not.toHaveBeenCalled();
    // Arrows still navigate the list even from within the input (combobox nav).
    press('ArrowDown');
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(3);
    input.remove();
  });

  it('ignores modified arrow keys (e.g. macOS Cmd+↑/↓ text navigation)', () => {
    const onActiveIndexChange = vi.fn();
    mount({
      itemCount: 5,
      activeIndex: 2,
      onActiveIndexChange,
      onConfirm: vi.fn(),
    });

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', metaKey: true }),
      );
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true }),
      );
    });
    expect(onActiveIndexChange).not.toHaveBeenCalled();
  });

  it('confirms the active index on Enter', () => {
    const onConfirm = vi.fn();
    mount({
      itemCount: 3,
      activeIndex: 1,
      onActiveIndexChange: vi.fn(),
      onConfirm,
    });

    press('Enter');
    expect(onConfirm).toHaveBeenCalledWith(1);
  });

  it('yields Enter to a focused button so it activates instead of confirming', () => {
    const onConfirm = vi.fn();
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    mount({
      itemCount: 3,
      activeIndex: 1,
      onActiveIndexChange: vi.fn(),
      onConfirm,
    });

    press('Enter');
    expect(onConfirm).not.toHaveBeenCalled();
    button.remove();
  });

  it('does not confirm on Enter when no row is highlighted (activeIndex -1)', () => {
    const onActiveIndexChange = vi.fn();
    const onConfirm = vi.fn();
    mount({
      itemCount: 3,
      activeIndex: -1,
      onActiveIndexChange,
      onConfirm,
    });

    // Searchable dialogs open with no highlight: Enter/Space have nothing to
    // act on.
    press('Enter');
    press(' ');
    expect(onConfirm).not.toHaveBeenCalled();

    // The first ArrowDown lands on the first row, not the second.
    press('ArrowDown');
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(0);
  });

  it('ignores keys during IME composition, including the WebKit Enter commit', () => {
    const onActiveIndexChange = vi.fn();
    const onConfirm = vi.fn();
    mount({
      itemCount: 3,
      activeIndex: 1,
      onActiveIndexChange,
      onConfirm,
    });

    // Mid-composition keys (Chrome/Firefox report isComposing) do nothing.
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          isComposing: true,
          cancelable: true,
        }),
      );
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          isComposing: true,
          cancelable: true,
        }),
      );
    });
    expect(onActiveIndexChange).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();

    // WebKit fires compositionend BEFORE the committing Enter's keydown, so it
    // arrives with isComposing false — only keyCode 229 marks it as an IME key.
    act(() => {
      const imeEnter = new KeyboardEvent('keydown', {
        key: 'Enter',
        cancelable: true,
      });
      Object.defineProperty(imeEnter, 'keyCode', { value: 229 });
      window.dispatchEvent(imeEnter);
    });
    expect(onConfirm).not.toHaveBeenCalled();

    // A genuine Enter afterwards still confirms.
    press('Enter');
    expect(onConfirm).toHaveBeenCalledWith(1);
  });

  it('confirms the active row on Space, mirroring Enter', () => {
    const onConfirm = vi.fn();
    mount({
      itemCount: 3,
      activeIndex: 1,
      onActiveIndexChange: vi.fn(),
      onConfirm,
    });

    press(' ');
    expect(onConfirm).toHaveBeenCalledWith(1);
  });

  it('yields Space to a focused text input, where it types a space', () => {
    const onConfirm = vi.fn();
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.focus();
    mount({
      itemCount: 3,
      activeIndex: 1,
      onActiveIndexChange: vi.fn(),
      onConfirm,
    });

    press(' ');
    expect(onConfirm).not.toHaveBeenCalled();
    input.remove();
  });

  it('confirms from a focused search combobox once a row is highlighted', () => {
    const onConfirm = vi.fn();
    const input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('role', 'combobox');
    document.body.appendChild(input);
    input.focus();
    mount({
      itemCount: 3,
      activeIndex: 1,
      onActiveIndexChange: vi.fn(),
      onConfirm,
    });

    // Focus never leaves the filter input in searchable dialogs, so Enter
    // from it must confirm the visibly highlighted row.
    press('Enter');
    expect(onConfirm).toHaveBeenCalledWith(1);
    input.remove();
  });

  it('does nothing when disabled or empty', () => {
    const onActiveIndexChange = vi.fn();
    const onConfirm = vi.fn();
    mount({
      itemCount: 0,
      activeIndex: 0,
      onActiveIndexChange,
      onConfirm,
      enabled: true,
    });

    press('ArrowDown');
    press('Enter');
    expect(onActiveIndexChange).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('does nothing when disabled', () => {
    const onActiveIndexChange = vi.fn();
    const onConfirm = vi.fn();
    mount({
      itemCount: 3,
      activeIndex: 1,
      onActiveIndexChange,
      onConfirm,
      enabled: false,
    });

    press('ArrowDown');
    press('Enter');
    expect(onActiveIndexChange).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('enters keyboard mode on arrow nav and exits on real mouse movement', () => {
    let mode = false;
    mount({
      itemCount: 3,
      activeIndex: 0,
      onActiveIndexChange: vi.fn(),
      onConfirm: vi.fn(),
      onKeyboardMode: (value) => {
        mode = value;
      },
    });

    expect(mode).toBe(false);

    press('ArrowDown');
    expect(mode).toBe(true);

    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    });
    expect(mode).toBe(false);
  });

  it('only the active scope handles keys when two scoped hooks are mounted', () => {
    const onBottomMove = vi.fn();
    const onTopMove = vi.fn();

    mountNode(
      <I18nProvider language="en">
        <ThemeProvider value="dark">
          <DialogShell title="Bottom" onClose={vi.fn()}>
            <ScopedHarness
              name="bottom"
              itemCount={3}
              activeIndex={0}
              onActiveIndexChange={onBottomMove}
              onConfirm={vi.fn()}
            />
          </DialogShell>
          <DialogShell title="Top" onClose={vi.fn()}>
            <ScopedHarness
              name="top"
              itemCount={3}
              activeIndex={0}
              onActiveIndexChange={onTopMove}
              onConfirm={vi.fn()}
            />
          </DialogShell>
        </ThemeProvider>
      </I18nProvider>,
    );

    // The top shell auto-focuses its content; only it should react.
    press('ArrowDown');
    expect(onTopMove).toHaveBeenCalledWith(1);
    expect(onBottomMove).not.toHaveBeenCalled();
  });
});
