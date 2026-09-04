import type { CSSProperties } from 'react';

export function cssUrlValue(url: string): string {
  const escaped = url.replace(/["\\\n\r\f]/g, (char) => {
    switch (char) {
      case '"':
      case '\\':
        return `\\${char}`;
      case '\n':
        return '\\A ';
      case '\r':
        return '\\D ';
      case '\f':
        return '\\C ';
      default:
        return '';
    }
  });
  return `url("${escaped}")`;
}

export function cssUrlVar(name: string, url: string): CSSProperties {
  return { [name]: cssUrlValue(url) } as CSSProperties;
}
