import { useEffect, useState } from 'react';

export function useAnimationFrameValue<T>(value: T): T {
  const [framedValue, setFramedValue] = useState(value);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setFramedValue(value);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [value]);

  return framedValue;
}
