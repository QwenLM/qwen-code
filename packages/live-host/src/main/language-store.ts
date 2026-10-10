import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  isLiveLanguage,
  liveMessage,
  type LiveLanguage,
} from '@qwen-code/qwen-live/i18n';

export function readHostLanguage(path: string): LiveLanguage {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const language = (value as Record<string, unknown>).language;
      if (isLiveLanguage(language)) return language;
    }
  } catch {
    // The cache is optional; the connected daemon remains authoritative.
  }
  return 'en';
}

export function saveHostLanguage(path: string, language: LiveLanguage): void {
  if (!isLiveLanguage(language))
    throw new Error(liveMessage('host.language.invalid'));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ language }), {
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
