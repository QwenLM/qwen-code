import { useRef } from 'react';

function shallowEqual<T>(a: T, b: T): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => v === (b as unknown[])[i]);
  }

  const keysA = Object.keys(a);
  const objB = b as Record<string, unknown>;
  const objA = a as Record<string, unknown>;
  if (keysA.length !== Object.keys(objB).length) return false;
  return keysA.every((k) => {
    const va = objA[k];
    const vb = objB[k];
    if (va === vb) return true;
    if (Array.isArray(va) && Array.isArray(vb)) {
      return va.length === vb.length && va.every((v, i) => v === vb[i]);
    }
    return false;
  });
}

export function useShallowMemo<T>(value: T): T {
  const ref = useRef(value);
  if (!shallowEqual(ref.current, value)) {
    ref.current = value;
  }
  return ref.current;
}

export function useStableArray<T>(items: T[], keyFn: (item: T) => string): T[] {
  const ref = useRef(items);
  if (items.length !== ref.current.length) {
    ref.current = items;
    return items;
  }
  const changed = items.some(
    (item, i) => keyFn(item) !== keyFn(ref.current[i]),
  );
  if (changed) {
    ref.current = items;
  }
  return ref.current;
}
