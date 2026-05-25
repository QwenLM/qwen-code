import { useEffect, useRef } from 'react';
import { isEditableTarget } from '../utils/dom';

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
