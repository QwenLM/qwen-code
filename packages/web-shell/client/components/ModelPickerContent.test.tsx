// @vitest-environment jsdom

import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  WebShellModelPickerContext,
  WebShellModelPickerMount,
} from '../model-picker';
import { WebShellPortalRootContext } from '../portalRoot';
import {
  isModelPickerOverlayEvent,
  ModelPickerContent,
  useModelPickerOverlays,
} from './ModelPickerContent';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const initialContext: Omit<WebShellModelPickerContext, 'overlayContainer'> = {
  composerId: 'composer-a',
  sessionId: 'session-a',
  currentModelId: 'model-a',
  language: 'en',
  theme: 'light',
};

type Mount = WebShellModelPickerMount<WebShellModelPickerContext>;
type HarnessProps = {
  open?: boolean;
  mount?: Mount;
  context?: typeof initialContext;
  revision?: object;
};

let root: Root | undefined;
let container: HTMLElement | undefined;
let portal: HTMLElement | undefined;

function Harness({
  open = true,
  mount,
  context = initialContext,
  revision,
}: HarnessProps) {
  const overlays = useModelPickerOverlays(open);
  return open ? (
    <ModelPickerContent
      mount={mount}
      context={context}
      revision={revision}
      overlayRoot={overlays}
      fallback={<span data-testid="native">Native model</span>}
    />
  ) : null;
}

function render(props: HarnessProps, strict = false) {
  if (!root) {
    container = document.createElement('div');
    portal = document.createElement('div');
    document.body.append(container, portal);
    root = createRoot(container);
  }
  const content = (
    <WebShellPortalRootContext.Provider value={portal!}>
      <Harness {...props} />
    </WebShellPortalRootContext.Provider>
  );
  act(() =>
    root!.render(strict ? <StrictMode>{content}</StrictMode> : content),
  );
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  portal?.remove();
  container = undefined;
  portal = undefined;
  vi.restoreAllMocks();
});

describe('ModelPickerContent', () => {
  it('recognizes delayed shadow events only for their owning picker', () => {
    render({});
    const overlays = portal!.querySelector<HTMLElement>(
      '[data-web-shell-model-picker-overlays]',
    )!;
    const shadow = portal!.attachShadow({ mode: 'open' });
    shadow.append(overlays);
    const button = document.createElement('button');
    overlays.append(button);
    const event = new Event('pointerdown', { bubbles: true, composed: true });
    button.dispatchEvent(event);
    expect(event.composedPath()).toHaveLength(0);
    expect(event.target).toBe(portal);
    expect(isModelPickerOverlayEvent(overlays, event)).toBe(true);
    expect(
      isModelPickerOverlayEvent(document.createElement('div'), event),
    ).toBe(false);
    const outside = new Event('pointerdown', { bubbles: true, composed: true });
    document.body.dispatchEvent(outside);
    expect(isModelPickerOverlayEvent(overlays, outside)).toBe(false);
  });

  it('updates one mounted view and its own overlay without remounting', () => {
    const update = vi.fn();
    const dispose = vi.fn();
    const mount = vi.fn<Mount>((target, context) => {
      target.textContent = 'Custom model';
      context.overlayContainer.textContent = 'Custom explanation';
      return { update, dispose };
    });
    render({ mount });
    const node = container!.querySelector(
      '[data-web-shell-model-picker-content]',
    );
    const firstContext = mount.mock.calls[0]![1];
    expect(container!.textContent).toBe('Custom model');
    expect(portal!.contains(firstContext.overlayContainer)).toBe(true);
    expect(portal!.textContent).toBe('Custom explanation');

    const context = { ...initialContext, currentModelId: 'model-b' };
    render({ mount, context });
    expect(mount).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenLastCalledWith({
      ...context,
      overlayContainer: firstContext.overlayContainer,
    });
    expect(
      container!.querySelector('[data-web-shell-model-picker-content]'),
    ).toBe(node);

    render({ mount, context, open: false });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(firstContext.overlayContainer.isConnected).toBe(false);
    expect(portal!.childElementCount).toBe(0);
  });

  it('updates a stable factory when its display map changes', () => {
    const update = vi.fn();
    const mount = vi.fn<Mount>((target) => {
      target.textContent = 'Custom model';
      return { update, dispose() {} };
    });
    const first = {};
    render({ mount, revision: first });
    render({ mount, revision: first });
    expect(update).not.toHaveBeenCalled();

    render({ mount, revision: {} });
    expect(update).toHaveBeenCalledTimes(1);
    expect(mount).toHaveBeenCalledTimes(1);
  });

  it('replaces the view when its factory changes and restores native content on removal', () => {
    const dispose = vi.fn();
    const first = vi.fn<Mount>((target) => {
      target.textContent = 'First';
      return { update() {}, dispose };
    });
    const second = vi.fn<Mount>((target) => {
      target.textContent = 'Second';
      return { update() {}, dispose };
    });
    render({ mount: first });
    render({ mount: second });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(container!.textContent).toBe('Second');

    render({});
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(container!.textContent).toBe('Native model');
    expect(portal!.textContent).toBe('');
  });

  it.each(['decline', 'throw'] as const)(
    'clears partial content and overlays when a factory %s',
    (result) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const mount = vi.fn<Mount>((target, context) => {
        target.textContent = 'Partial content';
        context.overlayContainer.textContent = 'Partial explanation';
        if (result === 'throw') throw new Error('Mount failed');
        return null;
      });
      render({ mount });
      expect(container!.textContent).toBe('Native model');
      expect(portal!.textContent).toBe('');
      expect(
        portal!.querySelector('[data-web-shell-model-picker-overlays]')
          ?.childElementCount,
      ).toBe(0);
      expect(mount).toHaveBeenCalledTimes(1);
    },
  );

  it('disposes a failed update and falls back even if cleanup throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dispose = vi.fn(() => {
      throw new Error('Cleanup failed');
    });
    const mount = vi.fn<Mount>((target, context) => {
      target.textContent = 'Custom model';
      context.overlayContainer.textContent = 'Explanation';
      return {
        update() {
          throw new Error('Update failed');
        },
        dispose,
      };
    });
    render({ mount });
    render({ mount, context: { ...initialContext, language: 'zh-CN' } });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(container!.textContent).toBe('Native model');
    expect(portal!.textContent).toBe('');
  });

  it('creates a fresh view after the list closes and reopens', () => {
    const dispose = vi.fn();
    const mount = vi.fn<Mount>(() => ({ update() {}, dispose }));
    render({ mount });
    const firstOverlay = mount.mock.calls[0]![1].overlayContainer;
    render({ mount, open: false });
    render({ mount });
    expect(mount).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(mount.mock.calls[1]![1].overlayContainer).not.toBe(firstOverlay);
  });

  it('pairs every successful StrictMode mount with exactly one disposal', () => {
    const handles: Array<ReturnType<typeof vi.fn>> = [];
    const mount = vi.fn<Mount>((target) => {
      target.textContent = 'Custom model';
      const dispose = vi.fn();
      handles.push(dispose);
      return { update() {}, dispose };
    });
    render({ mount }, true);
    expect(handles.length).toBeGreaterThan(0);
    render({ mount, open: false }, true);
    for (const dispose of handles) expect(dispose).toHaveBeenCalledTimes(1);
    expect(portal!.childElementCount).toBe(0);
  });
});
