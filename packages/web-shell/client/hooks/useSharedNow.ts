import { useEffect, useState } from 'react';

const subscribers = new Set<() => void>();
let interval: ReturnType<typeof setInterval> | null = null;
let currentNow = Date.now();

function tick() {
  currentNow = Date.now();
  for (const subscriber of subscribers) subscriber();
}

function subscribe(subscriber: () => void) {
  subscribers.add(subscriber);
  if (!interval) interval = setInterval(tick, 1000);
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0 && interval) {
      clearInterval(interval);
      interval = null;
    }
  };
}

export function useSharedNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    return subscribe(() => setNow(currentNow));
  }, [enabled]);

  return now;
}
