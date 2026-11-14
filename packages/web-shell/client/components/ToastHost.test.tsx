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
  MAX_TOASTS,
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
});
