import { useEffect, useRef } from 'react';

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

export function useDelayedGlobalKeyDown(
  handler: (event: KeyboardEvent) => void,
  deps: readonly unknown[],
  delayMs = 50,
): void {
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (isEditableTarget(event.target)) return;
      handlerRef.current(event);
    };
    const timer = setTimeout(() => {
      window.addEventListener('keydown', listener);
    }, delayMs);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', listener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
