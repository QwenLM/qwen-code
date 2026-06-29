import type { CSSProperties } from 'react';

export function cssUrlVar(name: string, url: string): CSSProperties {
  return { [name]: `url("${url}")` } as CSSProperties;
}
