import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  WebShellModelPickerContext,
  WebShellModelPickerMount,
} from '../model-picker';
import { useWebShellPortalRoot } from '../portalRoot';

const overlayEvents = new WeakMap<HTMLElement, WeakSet<Event>>();

export function isModelPickerOverlayEvent(
  root: HTMLElement | null,
  event: Event,
) {
  return Boolean(
    root &&
      (overlayEvents.get(root)?.has(event) ||
        (event.target instanceof Node && root.contains(event.target)) ||
        event
          .composedPath()
          .some((target) => target instanceof Node && root.contains(target))),
  );
}

export function useModelPickerOverlays(open: boolean) {
  const portalRoot = useWebShellPortalRoot();
  const [root, setRoot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setRoot(null);
      return;
    }
    const parent = portalRoot ?? document.body;
    const element = parent.ownerDocument.createElement('div');
    element.dataset.webShellModelPickerOverlays = '';
    element.style.display = 'contents';
    const events = new WeakSet<Event>();
    overlayEvents.set(element, events);
    // Outside-interaction callbacks can run after dispatch, losing the shadow path.
    const remember = (event: Event) => events.add(event);
    const eventTypes = ['pointerdown', 'focusin', 'keydown'];
    for (const type of eventTypes)
      element.addEventListener(type, remember, true);
    parent.append(element);
    setRoot(element);
    return () => {
      for (const type of eventTypes)
        element.removeEventListener(type, remember, true);
      overlayEvents.delete(element);
      element.remove();
    };
  }, [open, portalRoot]);
  return root;
}

export function ModelPickerContent<T extends WebShellModelPickerContext>({
  mount,
  context,
  overlayRoot,
  revision,
  fallback,
  className,
  onActiveChange,
}: {
  mount?: WebShellModelPickerMount<T>;
  context: Omit<T, 'overlayContainer'>;
  overlayRoot: HTMLElement | null;
  revision?: object;
  fallback?: ReactNode;
  className?: string;
  onActiveChange?: (active: boolean) => void;
}) {
  const container = useRef<HTMLSpanElement>(null);
  const [active, setActive] = useState(false);
  const view = useRef<{
    mount: WebShellModelPickerMount<T>;
    handle: NonNullable<ReturnType<WebShellModelPickerMount<T>>>;
    overlay: HTMLElement;
    root: HTMLElement;
  } | null>(null);
  const dispose = useCallback(() => {
    const previous = view.current;
    view.current = null;
    if (!previous) return;
    try {
      previous.handle.dispose();
    } catch (error) {
      console.error('[web-shell] model picker cleanup failed:', error);
    } finally {
      previous.overlay.remove();
      container.current?.replaceChildren();
    }
  }, []);

  useLayoutEffect(() => {
    const target = container.current!;
    let pendingOverlay: HTMLElement | undefined;
    let mounted = false;
    try {
      if (view.current?.mount !== mount || view.current?.root !== overlayRoot)
        dispose();
      if (mount && overlayRoot) {
        const existing = view.current;
        if (existing) {
          existing.handle.update({
            ...context,
            overlayContainer: existing.overlay,
          } as T);
          mounted = true;
        } else {
          target.style.display = 'flex';
          pendingOverlay = target.ownerDocument.createElement('div');
          pendingOverlay.style.display = 'contents';
          overlayRoot.append(pendingOverlay);
          const handle = mount(target, {
            ...context,
            overlayContainer: pendingOverlay,
          } as T);
          if (handle) {
            if (
              typeof handle.update !== 'function' ||
              typeof handle.dispose !== 'function'
            ) {
              if (typeof handle.dispose === 'function') handle.dispose();
              throw new Error('Model picker mount requires update and dispose');
            }
            view.current = {
              mount,
              handle,
              overlay: pendingOverlay,
              root: overlayRoot,
            };
            mounted = true;
          }
        }
      }
    } catch (error) {
      dispose();
      console.error('[web-shell] model picker content failed:', error);
    }
    if (!mounted) {
      pendingOverlay?.remove();
      target.replaceChildren();
      target.style.display = 'none';
    }
    setActive(mounted);
    onActiveChange?.(mounted);
  }, [context, mount, overlayRoot, revision, dispose, onActiveChange]);
  useLayoutEffect(() => dispose, [dispose]);

  return (
    <>
      {!active && fallback}
      <span
        ref={container}
        className={className}
        style={{ display: active ? 'flex' : 'none' }}
        data-web-shell-model-picker-content=""
      />
    </>
  );
}
