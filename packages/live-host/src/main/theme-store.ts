import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { isLiveTheme, type LiveTheme } from '../shared/theme.ts';

export function readHostTheme(path: string): LiveTheme {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      value &&
      typeof value === 'object' &&
      'theme' in value &&
      isLiveTheme(value.theme)
    )
      return value.theme;
  } catch {
    /* Missing or corrupt UI preference falls back to the system. */
  }
  return 'system';
}

export function saveHostTheme(path: string, theme: LiveTheme): void {
  if (!isLiveTheme(theme)) throw new TypeError('Invalid Host theme');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ theme }), {
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* Rename consumed the temporary file. */
    }
  }
}
