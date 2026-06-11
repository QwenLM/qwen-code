import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function matches(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(QUERY).matches
  );
}

/** Tracks the OS "reduce motion" accessibility preference. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(matches);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mq = window.matchMedia(QUERY);
    const handler = (event: MediaQueryListEvent) => setReduced(event.matches);
    mq.addEventListener('change', handler);
    setReduced(mq.matches);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return reduced;
}
