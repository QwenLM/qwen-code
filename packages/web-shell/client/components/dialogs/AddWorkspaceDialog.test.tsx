// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';
import { WebShellPortalRootContext } from '../../portalRoot';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { AddWorkspaceDialog } = await import('./AddWorkspaceDialog');

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

// The dialog is portaled to document.body, so query the document, not container.
const input = () =>
  document.querySelector<HTMLInputElement>('#add-workspace-path')!;
const displayNameInput = () =>
  document.querySelector<HTMLInputElement>('#add-workspace-display-name')!;
const alert = () => document.querySelector('[role="alert"]');
const submitButton = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.getAttribute('type') === 'submit',
  )!;
const browseButton = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent === 'Browse…',
  )!;

function typeInto(target: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
    setter.call(target, value);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function type(value: string) {
  typeInto(input(), value);
}

function typeDisplayName(value: string) {
  typeInto(displayNameInput(), value);
}

function submit() {
  act(() => {
    submitButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('AddWorkspaceDialog', () => {
  it('focuses the path input when opened', () => {
    mount(<AddWorkspaceDialog onClose={vi.fn()} onAdd={vi.fn()} />);

    expect(document.activeElement).toBe(input());
  });

  it('hides the display name field unless the daemon supports it', () => {
    mount(<AddWorkspaceDialog onClose={vi.fn()} onAdd={vi.fn()} />);

    expect(document.querySelector('#add-workspace-display-name')).toBeNull();
  });

  it('describes the input with the hint and no error initially', () => {
    mount(<AddWorkspaceDialog onClose={vi.fn()} onAdd={vi.fn()} />);
    // Hint is always associated; error id is only added once an error exists so
    // aria-describedby never points at a missing node.
    expect(input().getAttribute('aria-describedby')).toBe('add-workspace-hint');
    expect(input().getAttribute('aria-invalid')).toBeNull();
    expect(alert()).toBeNull();
  });

  it('rejects a non-absolute path with an accessible error and does not call onAdd', () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    mount(<AddWorkspaceDialog onClose={vi.fn()} onAdd={onAdd} />);

    type('relative/path');
    submit();

    const err = alert();
    expect(err?.textContent).toBe('Path must be absolute');
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(input().getAttribute('aria-describedby')).toBe(
      'add-workspace-error add-workspace-hint',
    );
    expect(onAdd).not.toHaveBeenCalled();

    // Editing the field clears the error.
    type('/absolute/path');
    expect(alert()).toBeNull();
    expect(input().getAttribute('aria-invalid')).toBeNull();
  });

  it('submits a trimmed absolute path and closes on success', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    mount(<AddWorkspaceDialog onClose={onClose} onAdd={onAdd} />);

    type('  /abs/project  ');
    submit();
    // Let the awaited onAdd resolve.
    await act(async () => {
      await Promise.resolve();
    });

    expect(onAdd).toHaveBeenCalledWith('/abs/project', true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('submits an optional trimmed display name', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    mount(
      <AddWorkspaceDialog onClose={onClose} onAdd={onAdd} displayNameEnabled />,
    );

    expect(displayNameInput().maxLength).toBe(256);
    expect(displayNameInput().getAttribute('aria-describedby')).toBe(
      'add-workspace-display-name-hint',
    );
    type('/abs/project');
    typeDisplayName('  Payments API  ');
    submit();
    await act(async () => {
      await Promise.resolve();
    });

    expect(onAdd).toHaveBeenCalledWith('/abs/project', true, 'Payments API');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('submits a display name with persist=false', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    mount(
      <AddWorkspaceDialog onClose={onClose} onAdd={onAdd} displayNameEnabled />,
    );

    // Toggle the persist switch off (Radix renders it as a button[role="switch"]).
    const sw = document.querySelector<HTMLButtonElement>(
      '#add-workspace-persist',
    )!;
    act(() => {
      sw.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    type('/abs/project');
    typeDisplayName('Local workspace');
    submit();
    await act(async () => {
      await Promise.resolve();
    });

    expect(onAdd).toHaveBeenCalledWith(
      '/abs/project',
      false,
      'Local workspace',
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hides persistence and always submits false when unsupported', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    mount(
      <AddWorkspaceDialog
        onClose={vi.fn()}
        onAdd={onAdd}
        persistenceSupported={false}
      />,
    );

    expect(document.querySelector('[role="switch"]')).toBeNull();
    type('/abs/project');
    submit();
    await act(async () => {
      await Promise.resolve();
    });

    expect(onAdd).toHaveBeenCalledWith('/abs/project', false);
  });

  it('surfaces an onAdd failure as an inline error and stays open', async () => {
    const onAdd = vi.fn().mockRejectedValue(new Error('daemon unreachable'));
    const onClose = vi.fn();
    mount(<AddWorkspaceDialog onClose={onClose} onAdd={onAdd} />);

    type('/abs/project');
    submit();
    await act(async () => {
      await Promise.resolve();
    });

    expect(alert()?.textContent).toBe('daemon unreachable');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('accepts a Windows-style absolute path', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    mount(<AddWorkspaceDialog onClose={onClose} onAdd={onAdd} />);

    type('C:\\Users\\me\\project');
    submit();
    await act(async () => {
      await Promise.resolve();
    });

    expect(onAdd).toHaveBeenCalledWith('C:\\Users\\me\\project', true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(alert()).toBeNull();
  });

  it('falls back to the generic error when onAdd rejects with a non-Error', async () => {
    const onAdd = vi.fn().mockRejectedValue('boom');
    const onClose = vi.fn();
    mount(<AddWorkspaceDialog onClose={onClose} onAdd={onAdd} />);

    type('/abs/project');
    submit();
    await act(async () => {
      await Promise.resolve();
    });

    expect(alert()?.textContent).toBe('Failed to add workspace');
    expect(onClose).not.toHaveBeenCalled();
  });

  describe('path autocomplete', () => {
    const SUGGESTIONS = {
      dir: '/home/me',
      sep: '/',
      suggestions: [
        { name: 'code', path: '/home/me/code' },
        { name: 'coding-katas', path: '/home/me/coding-katas' },
      ],
      truncated: false,
    };
    const listbox = () => document.querySelector('[role="listbox"]');
    const options = () =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
    const keydown = (key: string) => {
      act(() => {
        input().dispatchEvent(
          new KeyboardEvent('keydown', {
            key,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    };
    const settle = async () => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
    };

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('debounces a suggestion fetch for an absolute prefix and lists directories', async () => {
      const onSuggest = vi.fn().mockResolvedValue(SUGGESTIONS);
      mount(
        <AddWorkspaceDialog
          onClose={vi.fn()}
          onAdd={vi.fn()}
          onSuggest={onSuggest}
        />,
      );

      type('/home/me/co');
      expect(onSuggest).not.toHaveBeenCalled(); // debounce window
      await settle();

      expect(onSuggest).toHaveBeenCalledWith('/home/me/co');
      expect(listbox()).not.toBeNull();
      expect(options().map((o) => o.textContent)).toEqual([
        'code/',
        'coding-katas/',
      ]);
      expect(input().getAttribute('aria-expanded')).toBe('true');
    });

    it('opens the system picker and fills the selected absolute path', async () => {
      const onPick = vi.fn().mockResolvedValue('/Users/me/code');
      const onSuggest = vi.fn().mockResolvedValue(SUGGESTIONS);
      mount(
        <AddWorkspaceDialog
          onClose={vi.fn()}
          onAdd={vi.fn()}
          onPick={onPick}
          onSuggest={onSuggest}
        />,
      );

      await act(async () => {
        browseButton().click();
        await Promise.resolve();
      });

      expect(onPick).toHaveBeenCalledTimes(1);
      expect(input().value).toBe('/Users/me/code');
      expect(document.activeElement).not.toBe(input());
      await settle();
      expect(listbox()).toBeNull();
    });

    it('keeps suggestions closed when a lookup finishes after blur', async () => {
      let resolveSuggestions!: (value: typeof SUGGESTIONS) => void;
      const onSuggest = vi.fn(
        () =>
          new Promise<typeof SUGGESTIONS>((resolve) => {
            resolveSuggestions = resolve;
          }),
      );
      mount(
        <AddWorkspaceDialog
          onClose={vi.fn()}
          onAdd={vi.fn()}
          onSuggest={onSuggest}
        />,
      );

      type('/home/me/co');
      await settle();
      act(() => input().blur());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
        resolveSuggestions(SUGGESTIONS);
        await Promise.resolve();
      });

      expect(listbox()).toBeNull();
    });

    it('closes the suggestion list when the input blurs', async () => {
      const onSuggest = vi.fn().mockResolvedValue(SUGGESTIONS);
      mount(
        <AddWorkspaceDialog
          onClose={vi.fn()}
          onAdd={vi.fn()}
          onSuggest={onSuggest}
        />,
      );

      type('/home/me/co');
      await settle();
      expect(listbox()).not.toBeNull();

      act(() => input().blur());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(listbox()).toBeNull();
    });

    it('cancels the pending blur dismiss when focus returns to the input', async () => {
      const onSuggest = vi.fn().mockResolvedValue(SUGGESTIONS);
      mount(
        <AddWorkspaceDialog
          onClose={vi.fn()}
          onAdd={vi.fn()}
          onSuggest={onSuggest}
        />,
      );

      type('/home/me/co');
      await settle();
      expect(listbox()).not.toBeNull();

      act(() => input().blur());
      act(() => input().focus());
      // Cross the blur timer's deadline: a still-pending timer would close
      // the list and invalidate in-flight lookups via the sequence counter.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(listbox()).not.toBeNull();

      type('/home/me/cod');
      await settle();
      expect(listbox()).not.toBeNull();
    });

    it('opens suggestions on the first edit after a re-blur within the blur window', async () => {
      const onSuggest = vi.fn().mockResolvedValue(SUGGESTIONS);
      mount(
        <AddWorkspaceDialog
          onClose={vi.fn()}
          onAdd={vi.fn()}
          onSuggest={onSuggest}
        />,
      );

      act(() => input().blur());
      act(() => input().focus());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      // Second blur while the first blur timer is still pending: it must
      // cancel that timer rather than stack a second one on top of it.
      act(() => input().blur());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
      act(() => input().focus());
      // Cross the first timer's original deadline: an uncancelled timer
      // would have bumped the sequence counter by now.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(40);
      });

      type('/home/me/co');
      await settle();

      expect(listbox()).not.toBeNull();
    });

    it('opens suggestions on the first edit after the blur dismiss fired', async () => {
      const onSuggest = vi.fn().mockResolvedValue(SUGGESTIONS);
      mount(
        <AddWorkspaceDialog
          onClose={vi.fn()}
          onAdd={vi.fn()}
          onSuggest={onSuggest}
        />,
      );

      type('/home/me/co');
      await settle();
      expect(listbox()).not.toBeNull();

      // Stay blurred past the dismiss window so the timer fires.
      act(() => input().blur());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(listbox()).toBeNull();

      // Returning and editing must reopen the list on the first edit.
      act(() => input().focus());
      type('/home/me/cod');
      await settle();

      expect(listbox()).not.toBeNull();
    });

    it('keeps suggestions closed when a pre-blur lookup resolves after refocus', async () => {
      let resolveSuggestions!: (value: typeof SUGGESTIONS) => void;
      const onSuggest = vi.fn(
        () =>
          new Promise<typeof SUGGESTIONS>((resolve) => {
            resolveSuggestions = resolve;
          }),
      );
      mount(
        <AddWorkspaceDialog
          onClose={vi.fn()}
          onAdd={vi.fn()}
          onSuggest={onSuggest}
        />,
      );

      type('/home/me/co');
      // Let the debounce fire so the lookup is in flight, then blur past the
      // dismiss window so the timer fires while the lookup is pending.
      await settle();
      act(() => input().blur());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Refocus before the stale lookup resolves: the dismiss must
      // invalidate it, not let it pop the list open with zero edits.
      act(() => input().focus());
      await act(async () => {
        resolveSuggestions(SUGGESTIONS);
        await Promise.resolve();
      });

      expect(listbox()).toBeNull();
    });

    it('drops stale suggestions on blur dismiss so refocus cannot reopen them', async () => {
      const onSuggest = vi.fn().mockResolvedValue(SUGGESTIONS);
      mount(
        <AddWorkspaceDialog
          onClose={vi.fn()}
          onAdd={vi.fn()}
          onSuggest={onSuggest}
        />,
      );

      type('/home/me/co');
      await settle();
      expect(listbox()).not.toBeNull();

      // Blur past the dismiss window while the second lookup is still
      // debounced: the timer invalidates it, so it never refreshes the
      // stale entries from the first prefix.
      type('/home/me/cod');
      act(() => input().blur());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });

      // Refocusing without editing must not reopen the stale entries.
      act(() => input().focus());
      keydown('ArrowDown');

      expect(listbox()).toBeNull();
    });

    it('opens suggestions for a focused input in a shadow-DOM portal root', async () => {
      const onSuggest = vi.fn().mockResolvedValue(SUGGESTIONS);
      const host = document.createElement('div');
      document.body.append(host);
      container = host;
      const shadowRoot = host.attachShadow({ mode: 'open' });
      const portalRoot = document.createElement('div');
      shadowRoot.append(portalRoot);
      const dialogContainer = document.createElement('div');
      shadowRoot.append(dialogContainer);
      root = createRoot(dialogContainer);
      act(() => {
        root!.render(
          <WebShellPortalRootContext.Provider value={portalRoot}>
            <I18nProvider language="en">
              <AddWorkspaceDialog
                onClose={vi.fn()}
                onAdd={vi.fn()}
                onSuggest={onSuggest}
              />
            </I18nProvider>
          </WebShellPortalRootContext.Provider>,
        );
      });

      const shadowInput = shadowRoot.querySelector<HTMLInputElement>(
        '#add-workspace-path',
      )!;
      // document.activeElement retargets to the shadow host in this mode.
      expect(shadowRoot.activeElement).toBe(shadowInput);
      expect(document.activeElement).toBe(host);

      typeInto(shadowInput, '/home/me/co');
      await settle();

      expect(shadowRoot.querySelector('[role="listbox"]')).not.toBeNull();
    });

    it('leaves the path unchanged when the system picker is cancelled', async () => {
      const onPick = vi.fn().mockResolvedValue(undefined);
      mount(
        <AddWorkspaceDialog
          onClose={vi.fn()}
          onAdd={vi.fn()}
          onPick={onPick}
        />,
      );

      await act(async () => {
        browseButton().click();
        await Promise.resolve();
      });

      expect(input().value).toBe('');
    });

    it('opens suggestions on the first edit after a cancelled picker', async () => {
      let resolvePick!: (value: string | undefined) => void;
      const onPick = vi.fn(
        () =>
          new Promise<string | undefined>((resolve) => {
            resolvePick = resolve;
          }),
      );
      const onSuggest = vi.fn().mockResolvedValue(SUGGESTIONS);
      mount(
        <AddWorkspaceDialog
          onClose={vi.fn()}
          onAdd={vi.fn()}
          onPick={onPick}
          onSuggest={onSuggest}
        />,
      );

      act(() => {
        browseButton().click();
      });
      // Simulate the picker staying open well past the blur window.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      await act(async () => {
        resolvePick(undefined);
        await Promise.resolve();
        await Promise.resolve();
      });

      act(() => input().focus());
      type('/home/me/co');
      await settle();

      expect(onSuggest).toHaveBeenCalledWith('/home/me/co');
      expect(listbox()).not.toBeNull();
    });

    it('opens suggestions on the first edit after picking the typed path', async () => {
      let resolvePick!: (value: string | undefined) => void;
      const onPick = vi.fn(
        () =>
          new Promise<string | undefined>((resolve) => {
            resolvePick = resolve;
          }),
      );
      const onSuggest = vi.fn().mockResolvedValue(SUGGESTIONS);
      mount(
        <AddWorkspaceDialog
          onClose={vi.fn()}
          onAdd={vi.fn()}
          onPick={onPick}
          onSuggest={onSuggest}
        />,
      );

      type('/home/me/co');
      await settle();
      expect(listbox()).not.toBeNull();

      act(() => {
        browseButton().click();
      });
      // Browse closes the open list while the picker is up.
      expect(listbox()).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      await act(async () => {
        // Same value as typed: setPath bails out, so no path-change effect.
        resolvePick('/home/me/co');
        await Promise.resolve();
        await Promise.resolve();
      });

      act(() => input().focus());
      type('/home/me/cod');
      await settle();

      expect(listbox()).not.toBeNull();
    });

    it('does not pop suggestions open on refocus when a same-value pick raced an in-flight lookup', async () => {
      let resolvePick!: (value: string | undefined) => void;
      const onPick = vi.fn(
        () =>
          new Promise<string | undefined>((resolve) => {
            resolvePick = resolve;
          }),
      );
      let resolveSuggestions!: (value: typeof SUGGESTIONS) => void;
      const onSuggest = vi.fn(
        () =>
          new Promise<typeof SUGGESTIONS>((resolve) => {
            resolveSuggestions = resolve;
          }),
      );
      mount(
        <AddWorkspaceDialog
          onClose={vi.fn()}
          onAdd={vi.fn()}
          onPick={onPick}
          onSuggest={onSuggest}
        />,
      );

      type('/home/me/co');
      // Browse while the first lookup is still debounced, then let the
      // debounce fire so the lookup is in flight while the picker is open.
      act(() => {
        browseButton().click();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      await act(async () => {
        resolvePick('/home/me/co');
        await Promise.resolve();
        await Promise.resolve();
      });

      act(() => input().focus());
      await act(async () => {
        resolveSuggestions(SUGGESTIONS);
        await Promise.resolve();
      });

      // The lookup predates Browse; the same-value pick must invalidate it
      // so a bare refocus cannot pop the list open.
      expect(listbox()).toBeNull();

      type('/home/me/cod');
      await settle();
      await act(async () => {
        // resolveSuggestions now points at the second lookup's resolver.
        resolveSuggestions(SUGGESTIONS);
        await Promise.resolve();
      });
      expect(listbox()).not.toBeNull();
    });

    it('keeps the pick-triggered lookup closed until the first edit', async () => {
      let resolvePick!: (value: string | undefined) => void;
      const onPick = vi.fn(
        () =>
          new Promise<string | undefined>((resolve) => {
            resolvePick = resolve;
          }),
      );
      const onSuggest = vi.fn().mockResolvedValue(SUGGESTIONS);
      mount(
        <AddWorkspaceDialog
          onClose={vi.fn()}
          onAdd={vi.fn()}
          onPick={onPick}
          onSuggest={onSuggest}
        />,
      );

      act(() => {
        browseButton().click();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      await act(async () => {
        resolvePick('/Users/me/code');
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(input().value).toBe('/Users/me/code');
      // Refocusing to fine-tune the picked path while its lookup is still
      // pending must not pop the list open; only a real edit may.
      act(() => input().focus());
      await settle();
      expect(listbox()).toBeNull();

      type('/Users/me/code/s');
      await settle();
      expect(listbox()).not.toBeNull();
    });

    it('shows an error when the system picker fails', async () => {
      const onPick = vi.fn().mockRejectedValue(new Error('boom'));
      const onSuggest = vi.fn().mockResolvedValue(SUGGESTIONS);
      mount(
        <AddWorkspaceDialog
          onClose={vi.fn()}
          onAdd={vi.fn()}
          onPick={onPick}
          onSuggest={onSuggest}
        />,
      );

      // The picker rejects instantly (e.g. no zenity/osascript on a
      // headless host).
      await act(async () => {
        browseButton().click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(alert()?.textContent).toContain(
        'Unable to open the system folder picker',
      );

      // No blur timer is pending here — pickDirectory cancels it right
      // after blur(). Cross the dismiss deadline anyway: even a leaked
      // dismiss must not stop the first edit below from opening the list.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      act(() => input().focus());
      type('/home/me/co');
      await settle();

      expect(onSuggest).toHaveBeenCalledWith('/home/me/co');
      expect(listbox()).not.toBeNull();
    });

    it('never queries for a non-absolute value', async () => {
      const onSuggest = vi.fn().mockResolvedValue(SUGGESTIONS);
      mount(
        <AddWorkspaceDialog
          onClose={vi.fn()}
          onAdd={vi.fn()}
          onSuggest={onSuggest}
        />,
      );

      type('relative/pa');
      await settle();

      expect(onSuggest).not.toHaveBeenCalled();
      expect(listbox()).toBeNull();
    });

    it('accepts the highlighted entry with Enter without submitting the form', async () => {
      const onSuggest = vi.fn().mockResolvedValue(SUGGESTIONS);
      const onAdd = vi.fn().mockResolvedValue(undefined);
      mount(
        <AddWorkspaceDialog
          onClose={vi.fn()}
          onAdd={onAdd}
          onSuggest={onSuggest}
        />,
      );

      type('/home/me/co');
      await settle();
      keydown('ArrowDown');
      expect(options()[0]?.getAttribute('aria-selected')).toBe('true');
      keydown('Enter');

      expect(input().value).toBe('/home/me/code/');
      expect(onAdd).not.toHaveBeenCalled();
      // Accepting descends into the directory: the follow-up fetch runs for
      // the new prefix.
      await settle();
      expect(onSuggest).toHaveBeenLastCalledWith('/home/me/code/');
    });

    it('accepts a single suggestion with Tab', async () => {
      const single = {
        ...SUGGESTIONS,
        suggestions: [SUGGESTIONS.suggestions[0]],
      };
      const onSuggest = vi.fn().mockResolvedValue(single);
      mount(
        <AddWorkspaceDialog
          onClose={vi.fn()}
          onAdd={vi.fn()}
          onSuggest={onSuggest}
        />,
      );

      type('/home/me/cod');
      await settle();
      keydown('Tab');

      expect(input().value).toBe('/home/me/code/');
    });

    it('accepts a suggestion on mousedown', async () => {
      const onSuggest = vi.fn().mockResolvedValue(SUGGESTIONS);
      mount(
        <AddWorkspaceDialog
          onClose={vi.fn()}
          onAdd={vi.fn()}
          onSuggest={onSuggest}
        />,
      );

      type('/home/me/co');
      await settle();
      act(() => {
        options()[1]!.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
        );
      });

      expect(input().value).toBe('/home/me/coding-katas/');
    });

    it('closes only the list on Escape, keeping the dialog open', async () => {
      const onSuggest = vi.fn().mockResolvedValue(SUGGESTIONS);
      const onClose = vi.fn();
      mount(
        <AddWorkspaceDialog
          onClose={onClose}
          onAdd={vi.fn()}
          onSuggest={onSuggest}
        />,
      );

      type('/home/me/co');
      await settle();
      expect(listbox()).not.toBeNull();

      keydown('Escape');

      expect(listbox()).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('shows no list when the lookup fails', async () => {
      const onSuggest = vi.fn().mockRejectedValue(new Error('offline'));
      mount(
        <AddWorkspaceDialog
          onClose={vi.fn()}
          onAdd={vi.fn()}
          onSuggest={onSuggest}
        />,
      );

      type('/home/me/co');
      await settle();

      expect(listbox()).toBeNull();
      expect(alert()).toBeNull(); // best-effort: no error surfaced
    });
  });

  it('shows the adding state and disables controls while submitting', async () => {
    let resolveAdd!: () => void;
    const onAdd = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveAdd = resolve;
        }),
    );
    mount(<AddWorkspaceDialog onClose={vi.fn()} onAdd={onAdd} />);

    type('/abs/project');
    submit();

    // The awaited onAdd is still pending, so the dialog stays in its submitting
    // state: the button shows the localized "Adding…" label and the controls
    // are disabled.
    expect(submitButton().textContent).toBe('Adding…');
    expect(submitButton().disabled).toBe(true);
    expect(input().disabled).toBe(true);

    resolveAdd();
    await act(async () => {
      await Promise.resolve();
    });
  });
});
