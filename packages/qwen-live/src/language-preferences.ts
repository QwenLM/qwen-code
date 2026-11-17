/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  isLiveLanguage,
  liveMessage,
  type LiveLanguage,
} from './i18n/messages.js';

export function resolveLiveLanguage(value: unknown): LiveLanguage {
  if (value === undefined) return 'en';
  if (!isLiveLanguage(value)) throw new Error(liveMessage('language.invalid'));
  return value;
}

export function persistLanguagePreference(
  dataDir: string,
  value: unknown,
): LiveLanguage {
  if (!isLiveLanguage(value)) throw new Error(liveMessage('language.invalid'));
  const language = value;
  const path = join(dataDir, 'config.json');
  const content: unknown = existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''))
    : {};
  if (!content || typeof content !== 'object' || Array.isArray(content))
    throw new Error(liveMessage('language.configInvalid'));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(
        fd,
        `${JSON.stringify({ ...content, language }, null, 2)}\n`,
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* Rename consumed the temporary file. */
    }
  }
  return language;
}
