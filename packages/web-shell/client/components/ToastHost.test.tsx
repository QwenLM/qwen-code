// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../i18n';
import { WebShellPortalRootContext } from '../portalRoot';
import {
  ToastHost,
  WindowToastHost,
  requestToast,
  TOAST_REQUEST_EVENT,
  MAX_TOASTS,
  TOAST_AUTO_DISMISS_MS,
  createWebShellToast,
  appendToastDeduped,
  type WebShellToast,
} from './ToastHost';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; containers: HTMLElement[] }> = [];

function renderToastHost(
  props: { elevated?: boolean; toasts?: readonly WebShellToast[] },
  portalRoot: HTMLElement | null = null,
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const containers = [container];
  if (portalRoot) containers.push(portalRoot);
  const root = createRoot(container);
  mounted.push({ root, containers });
  const toasts: readonly WebShellToast[] = props.toasts ?? [
    {
      id: 'toast-1',
      tone: 'info',
      message: 'Saved',
      dismissAt: Date.now() + 5000,
    },
  ];
  act(() => {
    root.render(
      <I18nProvider language="en">
        <WebShellPortalRootContext.Provider value={portalRoot}>
          <ToastHost
            toasts={toasts}
            onDismiss={() => {}}
            elevated={props.elevated}
          />
        </WebShellPortalRootContext.Provider>
      </I18nProvider>,
    );
  });
  return container;
}

afterEach(() => {
  for (const { root, containers } of mounted) {
    act(() => root.unmount());
    for (const container of containers) container.remove();
  }
  mounted.length = 0;
});

function findHost(root: ParentNode): HTMLElement | null {
  return root.querySelector('[data-web-shell-toast-host]');
}

describe('ToastHost elevation', () => {
  it('applies the elevated class only while elevated', () => {
    const container = renderToastHost({ elevated: false });
    const host = findHost(container);
    expect(host).not.toBeNull();
    expect(host?.className).not.toContain('hostElevated');

    const elevatedContainer = renderToastHost({ elevated: true });
    const elevatedHost = findHost(elevatedContainer);
    expect(elevatedHost).not.toBeNull();
    expect(elevatedHost?.className).toContain('hostElevated');
  });

  it('stays in the app tree when not elevated, even with a portal root', () => {
    const portalRoot = document.createElement('div');
    document.body.appendChild(portalRoot);
    const container = renderToastHost({ elevated: false }, portalRoot);
    expect(findHost(container)).not.toBeNull();
    expect(findHost(portalRoot)).toBeNull();
  });

  it('portals into the portal root while elevated', () => {
    const portalRoot = document.createElement('div');
    document.body.appendChild(portalRoot);
    const container = renderToastHost({ elevated: true }, portalRoot);
    // The host leaves the app tree so it shares the portal root's stacking
    // context — in shadow-DOM portal mode that is the only place it can
    // paint above the fullscreen drawer surface.
    expect(findHost(container)).toBeNull();
    const host = findHost(portalRoot);
    expect(host).not.toBeNull();
    expect(host?.className).toContain('hostElevated');
  });

  it('renders nothing without toasts', () => {
    const container = renderToastHost({ elevated: true, toasts: [] });
    expect(findHost(container)).toBeNull();
  });

  it('keeps the auto-dismiss countdown across an elevation remount', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const toast: WebShellToast = {
      id: 'toast-1',
      tone: 'info',
      message: 'Saved',
      dismissAt: Date.now() + 5000,
    };
    const portalRoot = document.createElement('div');
    document.body.appendChild(portalRoot);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, containers: [container, portalRoot] });
    const render = (elevated: boolean) =>
      act(() => {
        root.render(
          <I18nProvider language="en">
            <WebShellPortalRootContext.Provider value={portalRoot}>
              <ToastHost
                toasts={[toast]}
                onDismiss={onDismiss}
                elevated={elevated}
              />
            </WebShellPortalRootContext.Provider>
          </I18nProvider>,
        );
      });
    try {
      render(false);
      act(() => {
        vi.advanceTimersByTime(2500);
      });
      // Elevating portals the host out of the app tree, remounting the item;
      // the countdown must continue from the original deadline, not restart.
      render(true);
      expect(findHost(portalRoot)).not.toBeNull();
      expect(onDismiss).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(2500);
      });
      expect(onDismiss).toHaveBeenCalledWith('toast-1');
      // A re-armed full timer on the remount would dismiss again at 7500ms.
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(onDismiss).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('WindowToastHost', () => {
  function renderWindowHost(): HTMLElement {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, containers: [container] });
    act(() => {
      root.render(
        <I18nProvider language="en">
          <WindowToastHost />
        </I18nProvider>,
      );
    });
    return container;
  }

  function toasts(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll('[data-web-shell-toast]'));
  }

  it('renders a requested toast with its tone and message', () => {
    const container = renderWindowHost();
    expect(toasts(container)).toHaveLength(0);
    act(() => {
      requestToast('error', 'Could not change the directory.');
    });
    const list = toasts(container);
    expect(list).toHaveLength(1);
    expect(list[0]!.textContent).toContain('Could not change the directory.');
    expect(list[0]!.getAttribute('data-tone')).toBe('error');
  });

  it('deduplicates by tone+message and ignores empty messages', () => {
    const container = renderWindowHost();
    act(() => {
      requestToast('error', 'same');
      requestToast('error', 'same');
      requestToast('warning', 'same');
      requestToast('error', '');
    });
    const list = toasts(container);
    expect(list).toHaveLength(2);
    expect(
      list.filter((n) => n.getAttribute('data-tone') === 'error'),
    ).toHaveLength(1);
  });

  it('caps the stack at MAX_TOASTS, keeping the newest', () => {
    const container = renderWindowHost();
    act(() => {
      for (let i = 0; i < MAX_TOASTS + 2; i++) {
        requestToast('info', `message-${i}`);
      }
    });
    const list = toasts(container);
    expect(list).toHaveLength(MAX_TOASTS);
    expect(list[list.length - 1]!.textContent).toContain(
      `message-${MAX_TOASTS + 1}`,
    );
  });

  it('auto-dismisses after the shared deadline (R4-4)', () => {
    vi.useFakeTimers();
    try {
      const container = renderWindowHost();
      act(() => {
        requestToast('info', 'transient');
      });
      expect(toasts(container)).toHaveLength(1);
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      // A mutated dismissAt far in the future would keep the toast here.
      expect(toasts(container)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  function mountShell(inShadow = false): {
    shell: HTMLElement;
    host: HTMLElement;
    button: HTMLButtonElement;
  } {
    const shell = document.createElement('div');
    shell.setAttribute('data-web-shell-root', '');
    const button = document.createElement('button');
    shell.appendChild(button);
    const host = document.createElement('div');
    shell.appendChild(host);
    let outer: HTMLElement = shell;
    if (inShadow) {
      const shadowHost = document.createElement('div');
      document.body.appendChild(shadowHost);
      const shadow = shadowHost.attachShadow({ mode: 'open' });
      shadow.appendChild(shell);
      outer = shadowHost;
    } else {
      document.body.appendChild(shell);
    }
    const root = createRoot(host);
    mounted.push({ root, containers: [outer] });
    act(() => {
      root.render(
        <I18nProvider language="en">
          <WindowToastHost scope={shell} />
        </I18nProvider>,
      );
    });
    return { shell, host, button };
  }

  it('scopes notices to the acting shell when co-mounted (R4-6)', () => {
    const a = mountShell();
    const b = mountShell();
    // The acting control lives in shell A; its notice must not reach B.
    a.button.focus();
    act(() => {
      requestToast('error', 'shell-a notice');
    });
    expect(toasts(a.host)).toHaveLength(1);
    expect(toasts(b.host)).toHaveLength(0);
  });

  it('delivers an unfocused notice to the single mounted shell (R4-6)', () => {
    const a = mountShell();
    // document.activeElement stays on body: an effect-driven call must not
    // vanish just because nothing inside the shell holds focus.
    act(() => {
      requestToast('error', 'unfocused notice');
    });
    expect(toasts(a.host)).toHaveLength(1);
  });

  it('delivers a notice from a shell mounted in a shadow root (R4-6)', () => {
    const a = mountShell(true);
    a.button.focus();
    // document.activeElement is the shadow host; the walk must descend.
    act(() => {
      requestToast('error', 'shadow notice');
    });
    expect(toasts(a.host)).toHaveLength(1);
  });

  it('an explicit scope wins over focus in another shell (R4-6)', () => {
    const a = mountShell();
    const b = mountShell();
    b.button.focus();
    act(() => {
      requestToast('error', 'owned by a', a.shell);
    });
    expect(toasts(a.host)).toHaveLength(1);
    expect(toasts(b.host)).toHaveLength(0);
  });

  it('bubbles from a scoped descendant to the shell host (R4-4)', () => {
    const a = mountShell();
    act(() => {
      // Dispatch on a descendant: the host on the shell root only receives
      // it while the event bubbles.
      requestToast('info', 'bubbling notice', a.button);
    });
    expect(toasts(a.host)).toHaveLength(1);
  });

  it('still reaches a window listener from a shell-root dispatch (R4-4)', () => {
    const a = mountShell();
    const windowListener = vi.fn();
    window.addEventListener(TOAST_REQUEST_EVENT, windowListener);
    try {
      act(() => {
        requestToast('info', 'for app', a.shell);
      });
      // App's daemon-shell host listens on window; dropping bubbles would
      // cut it off from shell-root dispatches.
      expect(windowListener).toHaveBeenCalledOnce();
      expect(toasts(a.host)).toHaveLength(1);
    } finally {
      window.removeEventListener(TOAST_REQUEST_EVENT, windowListener);
    }
  });

  it('composed lets a shadow-root dispatch reach a window listener (F2)', () => {
    const a = mountShell(true);
    const windowListener = vi.fn();
    window.addEventListener(TOAST_REQUEST_EVENT, windowListener);
    try {
      act(() => {
        // Dispatch on an element INSIDE the shadow tree: only a composed
        // event crosses the shadow boundary to reach window.
        requestToast('info', 'crossing the boundary', a.button);
      });
      expect(windowListener).toHaveBeenCalledOnce();
      expect(toasts(a.host)).toHaveLength(1);
    } finally {
      window.removeEventListener(TOAST_REQUEST_EVENT, windowListener);
    }
  });
});

describe('shared toast queue contract (App + WindowToastHost)', () => {
  it('creates a deadline-based toast, not a fresh duration', () => {
    const now = 1_700_000_000_000;
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const toast = createWebShellToast('error', 'boom', 7);
      expect(toast.dismissAt).toBe(now + TOAST_AUTO_DISMISS_MS);
      expect(toast.id).toBe(`web-shell-toast-${now}-7`);
      expect(toast.tone).toBe('error');
      expect(toast.message).toBe('boom');
    } finally {
      spy.mockRestore();
    }
  });

  it('moves a tone+message repeat to the top instead of stacking twice', () => {
    const a = createWebShellToast('error', 'same', 1);
    const b = createWebShellToast('info', 'other', 2);
    const repeat = createWebShellToast('error', 'same', 3);
    const stack = appendToastDeduped(appendToastDeduped([a], b), repeat);
    expect(stack.map((toast) => toast.message)).toEqual(['other', 'same']);
    expect(stack[1]).toBe(repeat);
  });

  it('does not dedupe the same message under a different tone', () => {
    const a = createWebShellToast('error', 'same', 1);
    const b = createWebShellToast('warning', 'same', 2);
    const stack = appendToastDeduped([a], b);
    expect(stack).toEqual([a, b]);
  });

  it('caps the stack at MAX_TOASTS, dropping the oldest', () => {
    let stack: WebShellToast[] = [];
    for (let i = 0; i < MAX_TOASTS + 2; i += 1) {
      stack = appendToastDeduped(
        stack,
        createWebShellToast('info', `m${i}`, i),
      );
    }
    expect(stack).toHaveLength(MAX_TOASTS);
    expect(stack.map((toast) => toast.message)).toEqual(
      Array.from({ length: MAX_TOASTS }, (_, i) => `m${i + 2}`),
    );
  });
});
