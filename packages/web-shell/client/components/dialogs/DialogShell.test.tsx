// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';
import { ThemeProvider } from '../../themeContext';
import { DialogShell } from './DialogShell';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <I18nProvider language="en">
        <ThemeProvider value="dark">{node}</ThemeProvider>
      </I18nProvider>,
    );
  });
}

function press(key: string, options: KeyboardEventInit = {}) {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key, cancelable: true, ...options }),
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function AutofocusChild() {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return <input ref={inputRef} type="text" />;
}

describe('DialogShell', () => {
  it('hides the fullscreen toggle by default', () => {
    mount(
      <DialogShell title="T" onClose={() => {}}>
        <div>content</div>
      </DialogShell>,
    );
    // DialogShell portals into document.body, so query there, not the root.
    expect(document.querySelector('button[aria-pressed]')).toBeNull();
  });

  it('shows a fullscreen toggle when allowFullscreen and toggles its state', () => {
    mount(
      <DialogShell title="T" allowFullscreen onClose={() => {}}>
        <div>content</div>
      </DialogShell>,
    );
    const toggle = document.querySelector(
      'button[aria-pressed]',
    ) as HTMLElement | null;
    expect(toggle).toBeTruthy();
    expect(toggle!.getAttribute('aria-pressed')).toBe('false');
    act(() => {
      toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(toggle!.getAttribute('aria-pressed')).toBe('true');
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    mount(
      <DialogShell title="Test" onClose={onClose}>
        <button type="button">inner</button>
      </DialogShell>,
    );

    press('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores Escape that belongs to an IME composition', () => {
    const onClose = vi.fn();
    mount(
      <DialogShell title="Test" onClose={onClose}>
        <input type="text" />
      </DialogShell>,
    );

    // Chrome/Firefox: Escape cancelling a composition reports isComposing.
    press('Escape', { isComposing: true });
    expect(onClose).not.toHaveBeenCalled();

    // WebKit: compositionend fires first, so only keyCode 229 marks the key.
    act(() => {
      const imeEscape = new KeyboardEvent('keydown', {
        key: 'Escape',
        cancelable: true,
      });
      Object.defineProperty(imeEscape, 'keyCode', { value: 229 });
      document.dispatchEvent(imeEscape);
    });
    expect(onClose).not.toHaveBeenCalled();

    // A genuine Escape still closes.
    press('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps focus on the panel when Tab is pressed with nothing focusable inside', () => {
    mount(
      <DialogShell title="Test" onClose={vi.fn()}>
        <button type="button" data-testid="inner">
          inner
        </button>
      </DialogShell>,
    );

    const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
    // Simulate content whose focusables all went away (e.g. everything became
    // disabled/hidden while an action runs).
    document.querySelector('[data-dialog-close]')!.remove();
    document.querySelector('[data-testid="inner"]')!.remove();

    panel.focus();
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    // Tab must not escape to the page behind; focus stays parked on the panel.
    expect(document.activeElement).toBe(panel);
  });

  it('lets a dialog control consume Escape instead of closing', () => {
    const onClose = vi.fn();
    mount(
      <DialogShell title="Test" onClose={onClose}>
        <input
          type="text"
          onKeyDown={(event) => {
            // e.g. an inline editor cancelling its edit on Escape.
            if (event.key === 'Escape') event.preventDefault();
          }}
        />
      </DialogShell>,
    );

    const input = document.querySelector<HTMLInputElement>('input')!;
    input.focus();
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('only the topmost of stacked shells handles Escape', () => {
    const onCloseBottom = vi.fn();
    const onCloseTop = vi.fn();
    mount(
      <>
        <DialogShell title="Bottom" onClose={onCloseBottom}>
          <button type="button">bottom</button>
        </DialogShell>
        <DialogShell title="Top" onClose={onCloseTop}>
          <button type="button">top</button>
        </DialogShell>
      </>,
    );

    // One Escape peels off one layer — the top one — not both at once.
    press('Escape');
    expect(onCloseTop).toHaveBeenCalledTimes(1);
    expect(onCloseBottom).not.toHaveBeenCalled();
  });

  it('keeps focus inside the top shell if a lower shell unmounts first', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    function Harness({ showBottom }: { showBottom: boolean }) {
      return (
        <>
          {showBottom ? (
            <DialogShell title="Bottom" onClose={vi.fn()}>
              <button type="button">bottom</button>
            </DialogShell>
          ) : null}
          <DialogShell title="Top" onClose={vi.fn()}>
            <button type="button" data-testid="top-focus">
              top
            </button>
          </DialogShell>
        </>
      );
    }

    mount(<Harness showBottom={true} />);
    const topButton = document.querySelector<HTMLElement>(
      '[data-testid="top-focus"]',
    )!;
    expect(document.activeElement).toBe(topButton);

    act(() => {
      root!.render(
        <I18nProvider language="en">
          <ThemeProvider value="dark">
            <Harness showBottom={false} />
          </ThemeProvider>
        </I18nProvider>,
      );
    });

    // Focus must stay inside the remaining top shell, not jump back behind it.
    expect(document.activeElement).toBe(topButton);
    opener.remove();
  });

  it('restores focus to the remaining top shell when the lower shell unmounts after focus moved', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    function Harness({ showBottom }: { showBottom: boolean }) {
      return (
        <>
          {showBottom ? (
            <DialogShell title="Bottom" onClose={vi.fn()}>
              <button type="button">bottom</button>
            </DialogShell>
          ) : null}
          <DialogShell title="Top" onClose={vi.fn()}>
            <button type="button" data-testid="top-focus">
              top
            </button>
          </DialogShell>
        </>
      );
    }

    mount(<Harness showBottom={true} />);
    const topButton = document.querySelector<HTMLElement>(
      '[data-testid="top-focus"]',
    )!;
    document.querySelector<HTMLElement>('button:not([data-testid])')!.focus();

    act(() => {
      root!.render(
        <I18nProvider language="en">
          <ThemeProvider value="dark">
            <Harness showBottom={false} />
          </ThemeProvider>
        </I18nProvider>,
      );
    });

    expect(document.activeElement).toBe(topButton);
    opener.remove();
  });

  it('closes when the backdrop is clicked but not when the panel is clicked', () => {
    const onClose = vi.fn();
    mount(
      <DialogShell title="Test" onClose={onClose}>
        <button type="button">inner</button>
      </DialogShell>,
    );

    const backdrop = document.querySelector<HTMLElement>(
      '[data-keyboard-scope]',
    );
    const panel = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(backdrop).toBeTruthy();

    act(() => {
      panel!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      panel!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      backdrop!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      backdrop!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      backdrop!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close when a drag starts in the panel and ends on the backdrop', () => {
    const onClose = vi.fn();
    mount(
      <DialogShell title="Test" onClose={onClose}>
        <button type="button">inner</button>
      </DialogShell>,
    );

    const backdrop = document.querySelector<HTMLElement>(
      '[data-keyboard-scope]',
    )!;
    const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;

    act(() => {
      panel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not close when a press starts on the backdrop and ends on the panel', () => {
    const onClose = vi.fn();
    mount(
      <DialogShell title="Test" onClose={onClose}>
        <button type="button">inner</button>
      </DialogShell>,
    );

    const backdrop = document.querySelector<HTMLElement>(
      '[data-keyboard-scope]',
    )!;
    const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;

    act(() => {
      backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      panel.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      // Browsers synthesize click on the nearest common ancestor for mismatched
      // press/release targets; here that's effectively the backdrop.
      backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('moves focus into the dialog on open', () => {
    mount(
      <DialogShell title="Test" onClose={vi.fn()}>
        <button type="button" data-testid="first">
          first
        </button>
        <button type="button">second</button>
      </DialogShell>,
    );

    const first = document.querySelector<HTMLElement>('[data-testid="first"]');
    expect(document.activeElement).toBe(first);
  });

  it('restores focus to the opener on close', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    mount(
      <DialogShell title="Test" onClose={vi.fn()}>
        <button type="button">inner</button>
      </DialogShell>,
    );
    // Focus moved into the dialog.
    expect(document.activeElement).not.toBe(opener);

    act(() => root?.unmount());
    root = null;
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('restores focus to the opener even if a child autofocuses first', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    mount(
      <DialogShell title="Test" onClose={vi.fn()}>
        <AutofocusChild />
      </DialogShell>,
    );

    const input = document.querySelector<HTMLInputElement>('input');
    expect(document.activeElement).toBe(input);

    act(() => root?.unmount());
    root = null;
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('traps Tab within the dialog, wrapping at both ends', () => {
    mount(
      <DialogShell title="Test" onClose={vi.fn()}>
        <button type="button" data-testid="last">
          inner
        </button>
      </DialogShell>,
    );

    // Focusables in DOM order: [close button, inner button].
    const close = document.querySelector<HTMLElement>('[data-dialog-close]')!;
    const last = document.querySelector<HTMLElement>('[data-testid="last"]')!;

    // Tab from the last focusable wraps to the first (the close button).
    last.focus();
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(close);

    // Shift+Tab from the first focusable wraps to the last.
    close.focus();
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
        }),
      );
    });
    expect(document.activeElement).toBe(last);
  });

  it('pulls focus into the dialog when Tab is pressed while the panel holds focus', () => {
    mount(
      <DialogShell title="Test" onClose={vi.fn()}>
        <button type="button" data-testid="last">
          inner
        </button>
      </DialogShell>,
    );

    const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const close = document.querySelector<HTMLElement>('[data-dialog-close]')!;
    const last = document.querySelector<HTMLElement>('[data-testid="last"]')!;

    // Focus sits on the panel itself (roving-list fallback). Tab pulls it in.
    panel.focus();
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(close);

    // Shift+Tab from the panel pulls in from the end instead.
    panel.focus();
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
        }),
      );
    });
    expect(document.activeElement).toBe(last);
  });
});
