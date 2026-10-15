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
import { isScreenDisplayId } from './host/screen-display.js';

export function persistScreenDisplayPreference(
  dataDir: string,
  value: string,
): string {
  if (!isScreenDisplayId(value)) throw new Error('Invalid screen display ID.');
  const screenDisplayId = value.toLowerCase();
  const path = join(dataDir, 'config.json');
  const content: unknown = existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''))
    : {};
  if (!content || typeof content !== 'object' || Array.isArray(content))
    throw new Error('Invalid Live config.');
  const visualInput = 'visualInput' in content ? content.visualInput : {};
  if (
    !visualInput ||
    typeof visualInput !== 'object' ||
    Array.isArray(visualInput)
  )
    throw new Error('Invalid Live visual input config.');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(
        fd,
        `${JSON.stringify({ ...content, visualInput: { ...visualInput, screenDisplayId } }, null, 2)}\n`,
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
  return screenDisplayId;
}
