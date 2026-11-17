// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, act, useState } from 'react';
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

function mountStrict(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <StrictMode>
        <I18nProvider language="en">{node}</I18nProvider>
      </StrictMode>,
    );
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
    (button) =>
      button.textContent === 'Browse…' ||
      button.textContent === 'Choosing directory…',
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
  describe('directory picker lifecycle', () => {
    function deferredPick() {
      let resolve!: (path: string | undefined) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<string | undefined>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      return { promise, resolve, reject };
    }

    function rerender(node: React.ReactNode) {
      act(() => {
        root!.render(<I18nProvider language="en">{node}</I18nProvider>);
      });
    }

    it('passes a signal and fills the path without registering until Add', async () => {
      const pending = deferredPick();
      let signal: AbortSignal | undefined;
      const onPick = vi.fn((opts?: { signal?: AbortSignal }) => {
        signal = opts?.signal;
        return pending.promise;
      });
      const onAdd = vi.fn().mockResolvedValue(undefined);
      mount(
        <AddWorkspaceDialog onClose={vi.fn()} onAdd={onAdd} onPick={onPick} />,
      );

      act(() => browseButton().click());
      expect(input().disabled).toBe(true);
      expect(browseButton().disabled).toBe(true);
      expect(onAdd).not.toHaveBeenCalled();
      await act(async () => pending.resolve('/daemon/project'));

      expect(input().value).toBe('/daemon/project');
      expect(input().disabled).toBe(false);
      expect(onAdd).not.toHaveBeenCalled();
      expect(signal).toBeInstanceOf(AbortSignal);
      await act(async () => submitButton().click());
      expect(onAdd).toHaveBeenCalledExactlyOnceWith('/daemon/project', true);
    });

    it('disables Add while a picker is pending even when a path is already filled', async () => {
      const pending = deferredPick();
      const onAdd = vi.fn().mockResolvedValue(undefined);
      mount(
        <AddWorkspaceDialog
          initialPath="/daemon/original"
          onClose={vi.fn()}
          onAdd={onAdd}
          onPick={() => pending.promise}
        />,
      );

      act(() => browseButton().click());
      expect(submitButton().disabled).toBe(true);
      await act(async () => submitButton().click());
      expect(onAdd).not.toHaveBeenCalled();
      await act(async () => pending.resolve('/daemon/selected'));
      expect(submitButton().disabled).toBe(false);
      await act(async () => submitButton().click());
      expect(onAdd).toHaveBeenCalledExactlyOnceWith('/daemon/selected', true);
    });

    it('ignores a same-frame form submission while a picker is pending', async () => {
      const pending = deferredPick();
      const onAdd = vi.fn().mockResolvedValue(undefined);
      mount(
        <AddWorkspaceDialog
          initialPath="/daemon/original"
          onClose={vi.fn()}
          onAdd={onAdd}
          onPick={() => pending.promise}
        />,
      );

      await act(async () => {
        browseButton().click();
        input().form!.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
      });
      expect(onAdd).not.toHaveBeenCalled();
      await act(async () => pending.resolve('/daemon/selected'));
      await act(async () => submitButton().click());
      expect(onAdd).toHaveBeenCalledExactlyOnceWith('/daemon/selected', true);
    });

    it.each(['undefined', 'AbortError'] as const)(
      'keeps the dialog usable after picker cancellation via %s',
      async (outcome) => {
        const onPick = vi
          .fn()
          .mockImplementationOnce(() =>
            outcome === 'undefined'
              ? Promise.resolve(undefined)
              : Promise.reject(new DOMException('Dismissed', 'AbortError')),
          )
          .mockResolvedValue('/daemon/next');
        const onAdd = vi.fn();
        mount(
          <AddWorkspaceDialog
            initialPath="/daemon/original"
            onClose={vi.fn()}
            onAdd={onAdd}
            onPick={onPick}
          />,
        );

        await act(async () => browseButton().click());
        expect(input().value).toBe('/daemon/original');
        expect(input().disabled).toBe(false);
        expect(alert()).toBeNull();
        expect(onAdd).not.toHaveBeenCalled();
        await act(async () => browseButton().click());
        expect(input().value).toBe('/daemon/next');
        expect(onAdd).not.toHaveBeenCalled();
      },
    );

    it.each(['Cancel', 'Escape'] as const)(
      'aborts the picker when dismissed with %s before the parent unmounts',
      async (dismiss) => {
        const pending = deferredPick();
        let signal: AbortSignal | undefined;
        const onPick = (opts?: { signal?: AbortSignal }) => {
          signal = opts?.signal;
          return pending.promise;
        };
        const onClose = vi.fn();
        const onAdd = vi.fn();
        mount(
          <AddWorkspaceDialog
            initialPath="/daemon/original"
            onClose={onClose}
            onAdd={onAdd}
            onPick={onPick}
          />,
        );
        act(() => browseButton().click());
        act(() => {
          if (dismiss === 'Cancel') {
            Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
              .find((button) => button.textContent === 'Cancel')!
              .click();
          } else {
            document.dispatchEvent(
              new KeyboardEvent('keydown', {
                key: 'Escape',
                bubbles: true,
                cancelable: true,
              }),
            );
          }
        });
        expect(onClose).toHaveBeenCalledOnce();
        await act(async () => pending.resolve('/daemon/late'));
        expect(input().value).toBe('/daemon/original');
        expect(onAdd).not.toHaveBeenCalled();
        expect(signal?.aborted).toBe(true);
      },
    );

    it('aborts on unmount and consumes a late rejected result', async () => {
      const pending = deferredPick();
      let signal: AbortSignal | undefined;
      mount(
        <AddWorkspaceDialog
          onClose={vi.fn()}
          onAdd={vi.fn()}
          onPick={(opts?: { signal?: AbortSignal }) => {
            signal = opts?.signal;
            return pending.promise;
          }}
        />,
      );
      act(() => browseButton().click());
      act(() => root!.unmount());
      root = null;
      await act(async () => pending.reject(new Error('Late failure')));
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(signal?.aborted).toBe(true);
    });

    it.each([
      ['location', 'resolve'],
      ['location', 'reject'],
      ['connection', 'resolve'],
      ['connection', 'reject'],
    ] as const)(
      'invalidates a picker on %s change and ignores its late %s while another is pending',
      async (change, outcome) => {
        const oldPick = deferredPick();
        const nextPick = deferredPick();
        const signals: Array<AbortSignal | undefined> = [];
        const onPick = vi.fn((opts?: { signal?: AbortSignal }) => {
          signals.push(opts?.signal);
          return signals.length === 1 ? oldPick.promise : nextPick.promise;
        });
        const onAdd = vi.fn();
        const connection = {};
        const renderDialog = (changed: boolean) => (
          <AddWorkspaceDialog
            initialPath="/daemon/original"
            onClose={vi.fn()}
            onAdd={onAdd}
            onPick={onPick}
            selectedLocation={
              changed && change === 'location' ? 'https://other.example' : ''
            }
            pickerTarget={changed && change === 'connection' ? {} : connection}
          />
        );
        mount(renderDialog(false));
        act(() => browseButton().click());
        rerender(renderDialog(true));
        expect(input().disabled).toBe(false);
        expect(browseButton().disabled).toBe(false);
        act(() => browseButton().click());
        await act(async () => {
          if (outcome === 'resolve') oldPick.resolve('/wrong-daemon/project');
          else oldPick.reject(new Error('Old daemon failed'));
        });
        expect(input().value).toBe('/daemon/original');
        expect(input().disabled).toBe(true);
        expect(browseButton().disabled).toBe(true);
        expect(alert()).toBeNull();
        expect(onAdd).not.toHaveBeenCalled();
        expect(signals[0]?.aborted).toBe(true);
        expect(signals[1]?.aborted).toBe(false);

        await act(async () => nextPick.resolve('/current-daemon/project'));
        expect(input().value).toBe('/current-daemon/project');
        expect(input().disabled).toBe(false);
        expect(onAdd).not.toHaveBeenCalled();
      },
    );

    it.each(['parent folder', 'suggestion'] as const)(
      'locks the %s path writer while a host picker is pending',
      async (writer) => {
        vi.useFakeTimers();
        try {
          const pending = deferredPick();
          const onAdd = vi.fn().mockResolvedValue(undefined);
          mount(
            <AddWorkspaceDialog
              browseDirectories
              pickerUsesHostUi
              initialPath="/daemon/original"
              onClose={vi.fn()}
              onAdd={onAdd}
              onPick={() => pending.promise}
              onSuggest={async () => ({
                dir: '/daemon/',
                sep: '/',
                suggestions: [{ name: 'other', path: '/daemon/other' }],
                truncated: false,
              })}
            />,
          );
          await act(async () => vi.advanceTimersByTimeAsync(200));
          expect(
            document.querySelector('[role="option"]')?.textContent,
          ).toContain('other');
          await act(async () => browseButton().click());
          expect(document.body.style.pointerEvents).toBe('');
          if (writer === 'parent folder') {
            const parent = document.querySelector<HTMLButtonElement>(
              'button[aria-label="Parent folder"]',
            )!;
            act(() => parent.click());
            expect.soft(parent.disabled).toBe(true);
          } else {
            const option = document.querySelector('[role="option"]');
            if (option) {
              act(() =>
                option.dispatchEvent(
                  new MouseEvent('mousedown', {
                    bubbles: true,
                    cancelable: true,
                  }),
                ),
              );
            }
            expect.soft(document.querySelector('[role="listbox"]')).toBeNull();
          }
          expect.soft(input().value).toBe('/daemon/original');
          expect(document.querySelector('[role="status"]')).toBeNull();
          expect(submitButton().disabled).toBe(true);
          expect(onAdd).not.toHaveBeenCalled();

          await act(async () => pending.resolve('/daemon/original'));
          expect.soft(input().value).toBe('/daemon/original');
          expect(document.activeElement).toBe(browseButton());
          expect(document.activeElement).not.toBe(input());
          expect(
            document.querySelector<HTMLButtonElement>(
              'button[aria-label="Parent folder"]',
            )!.disabled,
          ).toBe(false);
          await act(async () => submitButton().click());
          expect(onAdd).toHaveBeenCalledExactlyOnceWith(
            '/daemon/original',
            true,
          );
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it.each(
      (['host', 'native'] as const).flatMap((picker) =>
        (['cancel', 'same path', 'new path', 'error'] as const).map(
          (outcome) => [picker, outcome] as const,
        ),
      ),
    )(
      'preserves only the unchanged folder list scroll after a %s picker returns %s',
      async (picker, outcome) => {
        vi.useFakeTimers();
        try {
          const pending = deferredPick();
          const onAdd = vi.fn();
          mount(
            <AddWorkspaceDialog
              browseDirectories
              pickerUsesHostUi={picker === 'host'}
              initialPath="/daemon/original"
              onClose={vi.fn()}
              onAdd={onAdd}
              onPick={() => pending.promise}
              onSuggest={async (path) => ({
                dir: path,
                sep: '/',
                suggestions: Array.from({ length: 24 }, (_, index) => ({
                  name: `folder-${index}`,
                  path: `${path}/folder-${index}`,
                })),
                truncated: false,
              })}
            />,
          );
          const list = () =>
            document.querySelector<HTMLUListElement>('[role="listbox"]')!;
          await act(async () => vi.advanceTimersByTimeAsync(200));
          expect(list().children).toHaveLength(24);
          list().scrollTop = 180;
          await act(async () => browseButton().click());
          expect(list()).toBeNull();
          expect(input().getAttribute('aria-expanded')).toBe('false');
          expect(input().hasAttribute('aria-controls')).toBe(false);

          await act(async () => {
            if (outcome === 'error') pending.reject(new Error('picker failed'));
            else
              pending.resolve(
                outcome === 'cancel'
                  ? undefined
                  : outcome === 'same path'
                    ? '/daemon/original'
                    : '/daemon/selected',
              );
          });
          await act(async () => vi.advanceTimersByTimeAsync(200));
          expect(list().children).toHaveLength(24);
          expect(list().scrollTop).toBe(outcome === 'new path' ? 0 : 180);
          expect(input().value).toBe(
            outcome === 'new path' ? '/daemon/selected' : '/daemon/original',
          );
          expect(onAdd).not.toHaveBeenCalled();

          // Navigating later must not reuse the picker snapshot for new results.
          type('/daemon/another');
          await act(async () => vi.advanceTimersByTimeAsync(200));
          expect(list().children).toHaveLength(24);
          expect(list().scrollTop).toBe(0);
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it('keeps an invocation alive across inline callback rerenders on the same target', async () => {
      const pending = deferredPick();
      let signal: AbortSignal | undefined;
      const onAdd = vi.fn();
      const target = {};
      const renderDialog = (
        onPick: (opts?: {
          signal?: AbortSignal;
        }) => Promise<string | undefined>,
      ) => (
        <AddWorkspaceDialog
          onClose={vi.fn()}
          onAdd={onAdd}
          onPick={onPick}
          pickerTarget={target}
        />
      );
      mount(
        renderDialog((opts) => {
          signal = opts?.signal;
          return pending.promise;
        }),
      );
      act(() => browseButton().click());
      const nextPicker = vi.fn().mockResolvedValue('/daemon/second');
      rerender(renderDialog(nextPicker));
      expect(input().disabled).toBe(true);
      expect(signal?.aborted).toBe(false);
      await act(async () => pending.resolve('/daemon/first'));
      expect(input().value).toBe('/daemon/first');
      expect(nextPicker).not.toHaveBeenCalled();
      await act(async () => browseButton().click());
      expect(input().value).toBe('/daemon/second');
      expect(onAdd).not.toHaveBeenCalled();
    });

    it.each([
      ['host', 'resolve'],
      ['host', 'cancel'],
      ['native', 'resolve'],
      ['native', 'cancel'],
    ] as const)(
      'keeps the %s picker pointer boundary correct through %s',
      async (picker, outcome) => {
        const pending = deferredPick();
        mount(
          <AddWorkspaceDialog
            onClose={vi.fn()}
            onAdd={vi.fn()}
            onPick={() => pending.promise}
            pickerUsesHostUi={picker === 'host'}
          />,
        );
        expect(document.body.style.pointerEvents).toBe('none');

        await act(async () => browseButton().click());
        expect(document.body.style.pointerEvents).toBe(
          picker === 'host' ? '' : 'none',
        );
        await act(async () =>
          pending.resolve(outcome === 'resolve' ? '/daemon/picked' : undefined),
        );
        expect(document.body.style.pointerEvents).toBe('none');
        expect(input().value).toBe(
          outcome === 'resolve' ? '/daemon/picked' : '',
        );
      },
    );

    it('parks unclaimed host-picker focus on the busy panel and restores Browse after settling', async () => {
      const pending = deferredPick();
      mount(
        <AddWorkspaceDialog
          onClose={vi.fn()}
          onAdd={vi.fn()}
          onPick={() => pending.promise}
          pickerUsesHostUi
        />,
      );

      await act(async () => {
        browseButton().focus();
        browseButton().click();
      });
      const pendingPanel = document.querySelector('[data-web-shell-dialog]')!;
      expect.soft(document.activeElement).toBe(pendingPanel);
      expect.soft(pendingPanel.getAttribute('aria-busy')).toBe('true');
      expect(browseButton().textContent).toBe('Choosing directory…');
      await act(async () => pending.resolve('/daemon/picked'));
      const settledPanel = document.querySelector('[data-web-shell-dialog]')!;
      expect(settledPanel.getAttribute('aria-busy')).not.toBe('true');
      expect(document.activeElement).toBe(browseButton());
      expect(input().value).toBe('/daemon/picked');
    });

    it.each(['plain', 'service selector'] as const)(
      'preserves the %s dialog scroll position and restores Browse instead of its first field',
      async (configuration) => {
        const pending = deferredPick();
        mount(
          <AddWorkspaceDialog
            initialPath="/daemon/original"
            displayNameEnabled
            executionMode={
              configuration === 'service selector' ? 'daemon' : undefined
            }
            onExecutionModeChange={
              configuration === 'service selector' ? vi.fn() : undefined
            }
            onClose={vi.fn()}
            onAdd={vi.fn()}
            onPick={() => pending.promise}
            pickerUsesHostUi
          />,
        );
        input().form!.parentElement!.scrollTop = 120;
        await act(async () => {
          browseButton().focus();
          browseButton().click();
        });
        expect.soft(input().form!.parentElement!.scrollTop).toBe(120);
        await act(async () => pending.resolve('/daemon/picked'));
        expect.soft(input().form!.parentElement!.scrollTop).toBe(120);
        expect(document.activeElement).toBe(browseButton());
        expect(document.activeElement).not.toBe(input());
        expect(input().value).toBe('/daemon/picked');
      },
    );

    it('leaves focus with a host picker that claims it during the handoff', async () => {
      const pending = deferredPick();
      const onClose = vi.fn();
      function HostPicker() {
        const [open, setOpen] = useState(false);
        return (
          <>
            {open && <input id="host-picker-focus" autoFocus />}
            <AddWorkspaceDialog
              onClose={onClose}
              onAdd={vi.fn()}
              pickerUsesHostUi
              onPick={() => {
                setOpen(true);
                return pending.promise;
              }}
            />
          </>
        );
      }
      mount(<HostPicker />);

      await act(async () => browseButton().click());
      const hostInput =
        document.querySelector<HTMLInputElement>('#host-picker-focus')!;
      expect(document.activeElement).toBe(hostInput);
      expect(onClose).not.toHaveBeenCalled();
      await act(async () => pending.resolve(undefined));
    });

    it('does not dismiss Add Workspace when the host picker receives outside pointer and focus events', async () => {
      const pending = deferredPick();
      const onClose = vi.fn();
      let signal: AbortSignal | undefined;
      mount(
        <>
          <input id="host-picker-outside" />
          <AddWorkspaceDialog
            onClose={onClose}
            onAdd={vi.fn()}
            pickerUsesHostUi
            onPick={(opts) => {
              signal = opts?.signal;
              return pending.promise;
            }}
          />
        </>,
      );
      await act(async () => browseButton().click());
      const hostInput = document.querySelector<HTMLInputElement>(
        '#host-picker-outside',
      )!;
      act(() => {
        hostInput.dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true }),
        );
        hostInput.focus();
      });
      expect(document.activeElement).toBe(hostInput);
      expect(onClose).not.toHaveBeenCalled();
      expect(signal?.aborted).toBe(false);
      await act(async () => pending.resolve('/daemon/picked'));
      expect(input().value).toBe('/daemon/picked');
    });

    it('replaces a same-frame invocation and ignores its result without releasing the new busy state', async () => {
      const oldPick = deferredPick();
      const nextPick = deferredPick();
      const signals: Array<AbortSignal | undefined> = [];
      const onPick = vi.fn((opts?: { signal?: AbortSignal }) => {
        signals.push(opts?.signal);
        return signals.length === 1 ? oldPick.promise : nextPick.promise;
      });
      mount(
        <AddWorkspaceDialog
          onClose={vi.fn()}
          onAdd={vi.fn()}
          onPick={onPick}
        />,
      );
      act(() => {
        browseButton().click();
        browseButton().click();
      });
      expect(onPick).toHaveBeenCalledTimes(2);
      await act(async () => oldPick.resolve('/daemon/stale'));
      expect(input().value).toBe('');
      expect(input().disabled).toBe(true);
      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]?.aborted).toBe(false);
      await act(async () => nextPick.resolve('/daemon/current'));
      expect(input().value).toBe('/daemon/current');
      expect(input().disabled).toBe(false);
    });
  });

  it('offers the owning service before directory registration without submitting on a mode change', async () => {
    const onAdd = vi.fn();
    const onExecutionModeChange = vi.fn();
    mount(
      <AddWorkspaceDialog
        executionMode="daemon"
        onExecutionModeChange={onExecutionModeChange}
        onClose={vi.fn()}
        onAdd={onAdd}
      />,
    );
    const trigger = [
      ...document.querySelectorAll<HTMLElement>('[role="combobox"]'),
    ].find((item) => item.textContent?.includes('Local (daemon)'))!;
    await act(async () => trigger.click());
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((item) => item.textContent === 'Managed (Managed Agent)')!;
    await act(async () => option.click());
    expect(onExecutionModeChange).toHaveBeenCalledExactlyOnceWith('managed');
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('locks execution choice while a local directory is being registered', async () => {
    let resolve: () => void = () => {};
    const onAdd = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    mount(
      <AddWorkspaceDialog
        executionMode="daemon"
        onExecutionModeChange={vi.fn()}
        initialPath="/projects/example"
        onClose={vi.fn()}
        onAdd={onAdd}
      />,
    );
    submit();
    const trigger = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="combobox"]'),
    ].find((item) => item.textContent?.includes('Local (daemon)'))!;
    expect(trigger.disabled).toBe(true);
    await act(async () => resolve());
  });
  it('focuses the path input when opened', () => {
    mount(<AddWorkspaceDialog onClose={vi.fn()} onAdd={vi.fn()} />);

    expect(document.activeElement).toBe(input());
  });

  it('renders no Browse… button when the host cannot pick a directory', () => {
    // #9406 R1-7: every other browseButton() call site passes onPick, and
    // App.test.tsx mocks this dialog out entirely, so nothing observed the
    // `{onPick && (` guard — turning it into an unconditional render shipped
    // green. On a headless daemon host that puts back the dead affordance
    // this PR exists to remove: a Browse… button whose handler returns
    // immediately.
    mount(<AddWorkspaceDialog onClose={vi.fn()} onAdd={vi.fn()} />);

    expect(browseButton()).toBeUndefined();
  });

  it('renders the Browse… button when the host can pick a directory', () => {
    mount(
      <AddWorkspaceDialog onClose={vi.fn()} onAdd={vi.fn()} onPick={vi.fn()} />,
    );

    expect(browseButton()).toBeDefined();
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
    expect(err?.textContent).toBe(
      'Enter an absolute path or an SSH workspace URL.',
    );
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

    it('submits an SSH URL with Enter without browsing the local filesystem', async () => {
      const onAdd = vi.fn().mockResolvedValue(undefined);
      const onSuggest = vi.fn().mockResolvedValue(SUGGESTIONS);
      mount(
        <AddWorkspaceDialog
          onClose={vi.fn()}
          onAdd={onAdd}
          onSuggest={onSuggest}
          browseDirectories
          initialPath="/local/"
        />,
      );
      await settle();
      expect(onSuggest).toHaveBeenCalledWith('/local/');
      expect(
        document.querySelector('button[aria-label="Parent folder"]'),
      ).not.toBeNull();
      expect(document.body.textContent).toContain('ssh://');
      onSuggest.mockClear();
      const url = 'ssh://alice@build-box:2222/srv/project';
      type(`  ${url}  `);
      await settle();
      expect(onSuggest).not.toHaveBeenCalled();
      expect(
        document.querySelector('button[aria-label="Parent folder"]'),
      ).toBeNull();
      const enter = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        input().dispatchEvent(enter);
      });
      expect(enter.defaultPrevented).toBe(false);
      expect(input().value.trim()).toBe(url);
      await act(async () => {
        input().form!.requestSubmit();
      });
      expect(onAdd).toHaveBeenCalledWith(url, true);
    });

    it('renders a persistent remote directory browser', async () => {
      const onSuggest = vi.fn().mockResolvedValue(SUGGESTIONS);
      mount(
        <AddWorkspaceDialog
          browseDirectories
          initialPath="/home/me/"
          locations={[
            {
              origin: 'http://localhost',
              label: 'This computer',
              remote: false,
            },
            {
              origin: 'https://remote.example:4170',
              label: 'remote.example:4170',
              remote: true,
            },
          ]}
          selectedLocation="https://remote.example:4170"
          onLocationChange={vi.fn()}
          onClose={vi.fn()}
          onAdd={vi.fn()}
          onSuggest={onSuggest}
        />,
      );

      await settle();

      expect(input().value).toBe('/home/me/');
      expect(listbox()).not.toBeNull();
      expect(document.body.textContent).toContain('Folder source');
      expect(document.body.textContent).toContain('remote.example:4170');
      expect(document.body.textContent).toContain(
        'Choose a folder below, or type an absolute path.',
      );
      expect(submitButton().textContent).toBe('Add this folder');

      act(() => input().blur());
      expect(listbox()).not.toBeNull();
    });

    it('switches the folder source from inside the browser', async () => {
      const onLocationChange = vi.fn();
      mount(
        <AddWorkspaceDialog
          browseDirectories
          initialPath="/home/me/"
          locations={[
            {
              origin: 'http://localhost',
              label: 'This computer',
              remote: false,
            },
            {
              origin: 'https://remote.example:4170',
              label: 'remote.example:4170',
              remote: true,
            },
          ]}
          selectedLocation="http://localhost"
          onLocationChange={onLocationChange}
          onClose={vi.fn()}
          onAdd={vi.fn()}
          onSuggest={vi.fn().mockResolvedValue(SUGGESTIONS)}
        />,
      );

      act(() => {
        document
          .querySelector<HTMLButtonElement>(
            'button[aria-labelledby="workspace-location-label"]',
          )!
          .click();
      });
      const remote = Array.from(
        document.querySelectorAll<HTMLElement>('[role="option"]'),
      ).find((option) => option.textContent === 'remote.example:4170');
      act(() => remote!.click());

      expect(onLocationChange).toHaveBeenCalledWith(
        'https://remote.example:4170',
      );
    });

    it('navigates to the parent directory without submitting', async () => {
      const onAdd = vi.fn();
      const onSuggest = vi.fn().mockResolvedValue(SUGGESTIONS);
      mount(
        <AddWorkspaceDialog
          browseDirectories
          initialPath="/home/me/code/"
          onClose={vi.fn()}
          onAdd={onAdd}
          onSuggest={onSuggest}
        />,
      );

      act(() => {
        document
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Parent folder"]',
          )!
          .click();
      });

      expect(input().value).toBe('/home/me/');
      expect(onAdd).not.toHaveBeenCalled();
    });

    it('opens the typed directory on Enter instead of registering it', async () => {
      const onAdd = vi.fn();
      const onSuggest = vi.fn().mockResolvedValue(SUGGESTIONS);
      mount(
        <AddWorkspaceDialog
          browseDirectories
          initialPath="/home/me"
          onClose={vi.fn()}
          onAdd={onAdd}
          onSuggest={onSuggest}
        />,
      );

      act(() => {
        input().dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
      });

      expect(input().value).toBe('/home/me/');
      expect(onAdd).not.toHaveBeenCalled();
    });

    it('hides stale remote suggestions as soon as the path changes', async () => {
      const onSuggest = vi.fn().mockResolvedValue(SUGGESTIONS);
      mount(
        <AddWorkspaceDialog
          browseDirectories
          initialPath="/home/me/"
          onClose={vi.fn()}
          onAdd={vi.fn()}
          onSuggest={onSuggest}
        />,
      );

      await settle();
      expect(listbox()).not.toBeNull();

      type('/other/');
      expect(listbox()).toBeNull();
    });

    it('reports a failed remote directory lookup', async () => {
      const onSuggest = vi.fn().mockRejectedValue(new Error('offline'));
      mount(
        <AddWorkspaceDialog
          browseDirectories
          initialPath="/home/me/"
          onClose={vi.fn()}
          onAdd={vi.fn()}
          onSuggest={onSuggest}
        />,
      );

      await settle();

      expect(alert()?.textContent).toContain('Could not read folders');
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
        'Unable to open the folder picker',
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
    const onClose = vi.fn();
    mount(<AddWorkspaceDialog onClose={onClose} onAdd={onAdd} />);

    type('/abs/project');
    submit();

    // The awaited onAdd is still pending, so the dialog stays in its submitting
    // state: the button shows the localized "Adding…" label and the controls
    // are disabled.
    expect(submitButton().textContent).toBe('Adding…');
    expect(submitButton().disabled).toBe(true);
    expect(input().disabled).toBe(true);
    expect(document.querySelector('button[aria-label="Close"]')).toBeNull();
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(onClose).not.toHaveBeenCalled();

    resolveAdd();
    await act(async () => {
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  function gitUrlInput() {
    return document.querySelector<HTMLInputElement>('#add-workspace-git-url')!;
  }

  function gitTargetInput() {
    return document.querySelector<HTMLInputElement>(
      '#add-workspace-git-target',
    )!;
  }

  async function selectGitSource() {
    const trigger = document.querySelector<HTMLElement>(
      '#add-workspace-source',
    )!;
    await act(async () => trigger.click());
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((item) => item.textContent === 'Git repository')!;
    await act(async () => option.click());
  }

  async function flushAsync() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it.each([false, true])(
    'guards Git parent picking and preserves native/host modality (host=%s)',
    async (host) => {
      let resolve!: (value: string | undefined) => void;
      const pending = new Promise<string | undefined>((done) => {
        resolve = done;
      });
      let signal: AbortSignal | undefined;
      const onPick = vi.fn((opts?: { signal?: AbortSignal }) => {
        signal = opts?.signal;
        return pending;
      });
      const start = vi.fn();
      const onAdd = vi.fn();
      mount(
        <AddWorkspaceDialog
          onClose={vi.fn()}
          onAdd={onAdd}
          onPick={onPick}
          pickerUsesHostUi={host}
          gitClone={{ start, poll: vi.fn(), cancel: vi.fn() }}
        />,
      );
      await selectGitSource();
      typeInto(gitUrlInput(), 'https://example.com/org/repo.git');
      typeInto(gitTargetInput(), '/old/repo');
      act(() => {
        browseButton().click();
        document
          .querySelector('form')!
          .dispatchEvent(
            new Event('submit', { bubbles: true, cancelable: true }),
          );
      });
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal!.aborted).toBe(false);
      expect(start).not.toHaveBeenCalled();
      expect(onAdd).not.toHaveBeenCalled();
      expect(document.body.style.pointerEvents).toBe(host ? '' : 'none');
      expect(
        document
          .querySelector('[data-web-shell-dialog]')
          ?.getAttribute('aria-busy'),
      ).toBe('true');
      expect(gitUrlInput().disabled).toBe(true);
      expect(gitTargetInput().disabled).toBe(true);
      expect(browseButton().disabled).toBe(true);
      expect(submitButton().disabled).toBe(true);
      expect(
        document.querySelector<HTMLButtonElement>('#add-workspace-source')!
          .disabled,
      ).toBe(true);

      await act(async () => resolve('/selected-parent'));
      expect(gitTargetInput().value).toBe('/selected-parent/repo');
      expect(gitUrlInput().disabled).toBe(false);
      expect(browseButton().disabled).toBe(false);
      expect(submitButton().disabled).toBe(false);
      expect(document.body.style.pointerEvents).toBe('none');
      expect(
        document
          .querySelector('[data-web-shell-dialog]')
          ?.hasAttribute('aria-busy'),
      ).toBe(false);
      if (host) expect(document.activeElement).toBe(browseButton());
      expect(start).not.toHaveBeenCalled();
      expect(onAdd).not.toHaveBeenCalled();
    },
  );

  it('aborts a Git parent pick on close and ignores its late selection', async () => {
    let resolve!: (value: string) => void;
    let signal: AbortSignal | undefined;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    const onClose = vi.fn();
    const start = vi.fn();
    mount(
      <AddWorkspaceDialog
        onClose={onClose}
        onAdd={vi.fn()}
        pickerUsesHostUi
        onPick={(opts) => {
          signal = opts?.signal;
          return pending;
        }}
        gitClone={{ start, poll: vi.fn(), cancel: vi.fn() }}
      />,
    );
    await selectGitSource();
    typeInto(gitUrlInput(), 'https://example.com/org/repo.git');
    typeInto(gitTargetInput(), '/old/repo');
    act(() => browseButton().click());
    const cancel = [
      ...document.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent === 'Cancel')!;
    act(() => cancel.click());
    expect(onClose).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(true);
    await act(async () => resolve('/late'));
    expect(gitTargetInput().value).toBe('/old/repo');
    expect(start).not.toHaveBeenCalled();
  });

  it('invalidates a Git parent pick when cloning is withdrawn', async () => {
    let resolve!: (value: string) => void;
    let signal: AbortSignal | undefined;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    const onPick = (opts?: { signal?: AbortSignal }) => {
      signal = opts?.signal;
      return pending;
    };
    const controls = { start: vi.fn(), poll: vi.fn(), cancel: vi.fn() };
    const render = (enabled: boolean) => (
      <AddWorkspaceDialog
        onClose={vi.fn()}
        onAdd={vi.fn()}
        onPick={onPick}
        pickerUsesHostUi
        gitClone={enabled ? controls : undefined}
      />
    );
    mount(render(true));
    await selectGitSource();
    typeInto(gitUrlInput(), 'https://example.com/org/repo.git');
    typeInto(gitTargetInput(), '/old/repo');
    act(() => browseButton().click());
    act(() =>
      root!.render(<I18nProvider language="en">{render(false)}</I18nProvider>),
    );
    expect(signal?.aborted).toBe(true);
    await act(async () => resolve('/late'));
    expect(input().value).toBe('');
    act(() =>
      root!.render(<I18nProvider language="en">{render(true)}</I18nProvider>),
    );
    await selectGitSource();
    expect(gitTargetInput().value).toBe('/old/repo');
    expect(controls.start).not.toHaveBeenCalled();
  });

  it('treats AbortError from a Git parent picker as cancellation', async () => {
    mount(
      <AddWorkspaceDialog
        onClose={vi.fn()}
        onAdd={vi.fn()}
        pickerUsesHostUi
        onPick={async () => {
          throw new DOMException('Cancelled', 'AbortError');
        }}
        gitClone={{ start: vi.fn(), poll: vi.fn(), cancel: vi.fn() }}
      />,
    );
    await selectGitSource();
    typeInto(gitTargetInput(), '/old/repo');
    await act(async () => browseButton().click());
    expect(alert()).toBeNull();
    expect(gitTargetInput().value).toBe('/old/repo');
    expect(browseButton().disabled).toBe(false);
  });

  it('hides the Git source when the daemon does not advertise cloning', () => {
    mount(<AddWorkspaceDialog onClose={vi.fn()} onAdd={vi.fn()} />);
    expect(document.querySelector('#add-workspace-source')).toBeNull();
  });

  it('clones into the target and registers the cloned directory', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const start = vi.fn().mockResolvedValue({ jobId: 'job-1' });
    const poll = vi.fn().mockResolvedValue({
      jobId: 'job-1',
      status: 'succeeded',
      percent: 100,
      cwd: '/home/me/repo',
    });
    mount(
      <AddWorkspaceDialog
        onClose={onClose}
        onAdd={onAdd}
        gitClone={{ start, poll, cancel: vi.fn() }}
      />,
    );
    await selectGitSource();
    typeInto(gitUrlInput(), 'https://example.com/org/repo.git');
    typeInto(gitTargetInput(), '/home/me/repo');
    submit();
    await flushAsync();

    expect(start).toHaveBeenCalledWith({
      url: 'https://example.com/org/repo.git',
      target: '/home/me/repo',
    });
    expect(poll).toHaveBeenCalledWith('job-1');
    expect(onAdd).toHaveBeenCalledWith('/home/me/repo', true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows clone progress and cancels the job', async () => {
    let polls = 0;
    const poll = vi.fn().mockImplementation(async () => {
      polls++;
      return polls === 1
        ? { jobId: 'job-2', status: 'running', percent: 42 }
        : { jobId: 'job-2', status: 'cancelled' };
    });
    const cancel = vi.fn().mockResolvedValue(undefined);
    mount(
      <AddWorkspaceDialog
        onClose={vi.fn()}
        onAdd={vi.fn()}
        gitClone={{
          start: vi.fn().mockResolvedValue({ jobId: 'job-2' }),
          poll,
          cancel,
        }}
      />,
    );
    await selectGitSource();
    typeInto(gitUrlInput(), 'https://example.com/org/repo.git');
    typeInto(gitTargetInput(), '/home/me/repo');
    submit();
    await flushAsync();

    expect(document.body.textContent).toContain('Cloning… 42%');
    const cancelButton = [
      ...document.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent === 'Cancel clone')!;
    await act(async () => {
      cancelButton.click();
      await Promise.resolve();
    });
    await flushAsync();

    expect(cancel).toHaveBeenCalledWith('job-2');
    expect(document.body.textContent).toContain('Clone cancelled.');
  });

  it('surfaces a clone failure and returns to the form', async () => {
    mount(
      <AddWorkspaceDialog
        onClose={vi.fn()}
        onAdd={vi.fn()}
        gitClone={{
          start: vi.fn().mockResolvedValue({ jobId: 'job-3' }),
          poll: vi.fn().mockResolvedValue({
            jobId: 'job-3',
            status: 'failed',
            error: { code: 'clone_failed', message: 'fatal: not found' },
          }),
          cancel: vi.fn(),
        }}
      />,
    );
    await selectGitSource();
    typeInto(gitUrlInput(), 'https://example.com/org/repo.git');
    typeInto(gitTargetInput(), '/home/me/repo');
    submit();
    await flushAsync();

    expect(document.body.textContent).toContain('fatal: not found');
    const back = [
      ...document.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent === 'Back')!;
    await act(async () => back.click());
    expect(gitUrlInput()).not.toBeNull();
  });

  it('rejects a relative target without starting a clone', async () => {
    const start = vi.fn();
    mount(
      <AddWorkspaceDialog
        onClose={vi.fn()}
        onAdd={vi.fn()}
        gitClone={{ start, poll: vi.fn(), cancel: vi.fn() }}
      />,
    );
    await selectGitSource();
    typeInto(gitUrlInput(), 'https://example.com/org/repo.git');
    typeInto(gitTargetInput(), 'relative/repo');
    submit();
    await flushAsync();

    expect(start).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      'Enter an absolute target path.',
    );
  });

  it('offers recheck after a polling failure before the stale cancel action', async () => {
    let polls = 0;
    const poll = vi.fn().mockImplementation(async () => {
      polls++;
      if (polls === 1) throw new Error('network down');
      return {
        jobId: 'job-unknown',
        status: 'succeeded',
        percent: 100,
        cwd: '/home/me/repo',
      };
    });
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    mount(
      <AddWorkspaceDialog
        onClose={onClose}
        onAdd={onAdd}
        gitClone={{
          start: vi.fn().mockResolvedValue({ jobId: 'job-unknown' }),
          poll,
          cancel: vi.fn(),
        }}
      />,
    );
    await selectGitSource();
    typeInto(gitUrlInput(), 'https://example.com/org/repo.git');
    typeInto(gitTargetInput(), '/home/me/repo');
    submit();
    await flushAsync();

    expect(document.body.textContent).toContain(
      'Could not confirm the clone result.',
    );
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')];
    const recheck = buttons.find(
      (button) => button.textContent === 'Check again',
    );
    expect(recheck).toBeTruthy();
    expect(
      buttons.some((button) => button.textContent === 'Cancel clone'),
    ).toBe(false);

    await act(async () => {
      recheck!.click();
      await Promise.resolve();
    });
    await flushAsync();
    expect(onAdd).toHaveBeenCalledWith('/home/me/repo', true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('registers a clone under StrictMode', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    mountStrict(
      <AddWorkspaceDialog
        onClose={vi.fn()}
        onAdd={onAdd}
        gitClone={{
          start: vi.fn().mockResolvedValue({ jobId: 'job-strict' }),
          poll: vi.fn().mockResolvedValue({
            jobId: 'job-strict',
            status: 'succeeded',
            percent: 100,
            cwd: '/home/me/repo',
          }),
          cancel: vi.fn(),
        }}
      />,
    );
    await selectGitSource();
    typeInto(gitUrlInput(), 'https://example.com/org/repo.git');
    typeInto(gitTargetInput(), '/home/me/repo');
    submit();
    await flushAsync();

    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith('/home/me/repo', true);
  });

  it('reuses the directory path as the clone parent', async () => {
    mount(
      <AddWorkspaceDialog
        onClose={vi.fn()}
        onAdd={vi.fn()}
        gitClone={{ start: vi.fn(), poll: vi.fn(), cancel: vi.fn() }}
      />,
    );
    typeInto(input(), '/home/me/src');
    await selectGitSource();
    typeInto(gitUrlInput(), 'https://example.com/org/repo.git');

    expect(gitTargetInput().value).toBe('/home/me/src/repo');
  });

  it('keeps a directory path that already ends with the repository name', async () => {
    mount(
      <AddWorkspaceDialog
        onClose={vi.fn()}
        onAdd={vi.fn()}
        gitClone={{ start: vi.fn(), poll: vi.fn(), cancel: vi.fn() }}
      />,
    );
    typeInto(input(), '/home/me/src/repo');
    await selectGitSource();
    typeInto(gitUrlInput(), 'https://example.com/org/repo.git');

    expect(gitTargetInput().value).toBe('/home/me/src/repo');
  });

  it('does not overwrite a manually edited clone target', async () => {
    mount(
      <AddWorkspaceDialog
        onClose={vi.fn()}
        onAdd={vi.fn()}
        gitClone={{ start: vi.fn(), poll: vi.fn(), cancel: vi.fn() }}
      />,
    );
    typeInto(input(), '/home/me/src');
    await selectGitSource();
    typeInto(gitUrlInput(), 'https://example.com/org/repo.git');
    typeInto(gitTargetInput(), '/custom/target');
    typeInto(gitUrlInput(), 'https://example.com/org/other.git');

    expect(gitTargetInput().value).toBe('/custom/target');
  });

  it('selects a clone parent from directory suggestions', async () => {
    const onSuggest = vi.fn().mockResolvedValue({
      dir: '/home/me',
      sep: '/',
      suggestions: [{ name: 'src', path: '/home/me/src' }],
      truncated: false,
    });
    mount(
      <AddWorkspaceDialog
        onClose={vi.fn()}
        onAdd={vi.fn()}
        onSuggest={onSuggest}
        gitClone={{ start: vi.fn(), poll: vi.fn(), cancel: vi.fn() }}
      />,
    );
    await selectGitSource();
    typeInto(gitUrlInput(), 'https://example.com/org/repo.git');
    typeInto(gitTargetInput(), '/home/me/');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });

    expect(onSuggest).toHaveBeenCalledWith('/home/me/');
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((item) => item.textContent?.startsWith('src'));
    expect(option).toBeTruthy();
    await act(async () => {
      option!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(gitTargetInput().value).toBe('/home/me/src/repo');
  });

  it('returns to the directory source when the clone capability disappears', async () => {
    const controls = {
      start: vi.fn(),
      poll: vi.fn(),
      cancel: vi.fn(),
    };
    function Harness() {
      const [enabled, setEnabled] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setEnabled(false)}>
            drop-capability
          </button>
          <AddWorkspaceDialog
            onClose={vi.fn()}
            onAdd={vi.fn()}
            gitClone={enabled ? controls : undefined}
          />
        </>
      );
    }
    mount(<Harness />);
    await selectGitSource();
    expect(document.querySelector('#add-workspace-git-url')).not.toBeNull();
    const drop = [
      ...document.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent === 'drop-capability')!;
    await act(async () => drop.click());
    expect(document.querySelector('#add-workspace-path')).not.toBeNull();
    expect(document.querySelector('#add-workspace-git-url')).toBeNull();
  });

  it('reports a pruned clone job instead of offering recheck forever', async () => {
    const { DaemonHttpError } = await import('@qwen-code/sdk/daemon');
    mount(
      <AddWorkspaceDialog
        onClose={vi.fn()}
        onAdd={vi.fn()}
        gitClone={{
          start: vi.fn().mockResolvedValue({ jobId: 'job-gone' }),
          poll: vi.fn().mockRejectedValue(
            new DaemonHttpError(
              404,
              {
                error: 'Workspace clone job not found',
                code: 'clone_job_not_found',
              },
              'GET /workspace-git-clone-jobs/job-gone',
            ),
          ),
          cancel: vi.fn(),
        }}
      />,
    );
    await selectGitSource();
    typeInto(gitUrlInput(), 'https://example.com/org/repo.git');
    typeInto(gitTargetInput(), '/home/me/repo');
    submit();
    await flushAsync();

    expect(document.body.textContent).toContain('no longer available');
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.some((button) => button.textContent === 'Check again')).toBe(
      false,
    );
  });

  it('does not register a clone the user asked to cancel', async () => {
    let polls = 0;
    const poll = vi.fn().mockImplementation(async () => {
      polls++;
      return polls === 1
        ? { jobId: 'job-race', status: 'running', percent: 10 }
        : {
            jobId: 'job-race',
            status: 'succeeded',
            percent: 100,
            cwd: '/home/me/repo',
          };
    });
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const cancel = vi.fn().mockResolvedValue(undefined);
    mount(
      <AddWorkspaceDialog
        onClose={onClose}
        onAdd={onAdd}
        gitClone={{
          start: vi.fn().mockResolvedValue({ jobId: 'job-race' }),
          poll,
          cancel,
        }}
      />,
    );
    await selectGitSource();
    typeInto(gitUrlInput(), 'https://example.com/org/repo.git');
    typeInto(gitTargetInput(), '/home/me/repo');
    submit();
    await flushAsync();

    const cancelButton = [
      ...document.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent === 'Cancel clone')!;
    await act(async () => {
      cancelButton.click();
      await Promise.resolve();
    });
    await flushAsync();

    expect(cancel).toHaveBeenCalledWith('job-race');
    expect(onAdd).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    const back = [
      ...document.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent === 'Back');
    expect(back).toBeTruthy();
  });

  it('closes instead of cancelling an unconfirmed clone', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    mount(
      <AddWorkspaceDialog
        onClose={onClose}
        onAdd={vi.fn()}
        gitClone={{
          start: vi.fn().mockResolvedValue({ jobId: 'job-unknown-2' }),
          poll: vi.fn().mockRejectedValue(new Error('network down')),
          cancel,
        }}
      />,
    );
    await selectGitSource();
    typeInto(gitUrlInput(), 'https://example.com/org/repo.git');
    typeInto(gitTargetInput(), '/home/me/repo');
    submit();
    await flushAsync();

    const footerCancel = [
      ...document.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent === 'Cancel')!;
    await act(async () => footerCancel.click());

    expect(cancel).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('tears the clone panel down when the capability disappears mid-clone', async () => {
    const controls = {
      start: vi.fn().mockResolvedValue({ jobId: 'job-drop' }),
      poll: vi.fn().mockResolvedValue({
        jobId: 'job-drop',
        status: 'running',
        percent: 7,
      }),
      cancel: vi.fn(),
    };
    function Harness() {
      const [enabled, setEnabled] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setEnabled(false)}>
            drop-capability
          </button>
          <AddWorkspaceDialog
            onClose={vi.fn()}
            onAdd={vi.fn()}
            gitClone={enabled ? controls : undefined}
          />
        </>
      );
    }
    mount(<Harness />);
    await selectGitSource();
    typeInto(gitUrlInput(), 'https://example.com/org/repo.git');
    typeInto(gitTargetInput(), '/home/me/repo');
    submit();
    await flushAsync();
    expect(document.body.textContent).toContain('Cloning');

    const drop = [
      ...document.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent === 'drop-capability')!;
    await act(async () => drop.click());
    await flushAsync();

    expect(document.querySelector('#add-workspace-path')).not.toBeNull();
    expect(document.body.textContent).not.toContain('Cloning');
    expect(document.body.textContent).not.toContain('Cancel clone');
  });
});
