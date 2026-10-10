/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { atomicWriteFileSync } from '@qwen-code/qwen-code-core/utils/atomicFileWrite.js';

const PROMPT_STASH_FILE = 'prompt-stash.json';

// Version 2 marks a stash this build writes: only composer (user-authored)
// text ever reaches savePromptStash, so a restore keeps it verbatim. A
// version-1 stash predates that contract and can hold model-facing text
// with an injected envelope, so the restore shape-strips it as a fallback.
export interface PromptStashData {
  version: 1 | 2;
  text: string;
}

function getPromptStashPath(targetDir: string): string {
  return path.join(new Storage(targetDir).getProjectDir(), PROMPT_STASH_FILE);
}

export function savePromptStash(targetDir: string, text: string): boolean {
  try {
    const filePath = getPromptStashPath(targetDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const data: PromptStashData = { version: 2, text };
    atomicWriteFileSync(filePath, JSON.stringify(data), {
      mode: 0o600,
      forceMode: true,
      noFollow: true,
    });
    return true;
  } catch {
    return false;
  }
}

export function loadPromptStash(targetDir: string): PromptStashData | null {
  try {
    const raw = fs.readFileSync(getPromptStashPath(targetDir), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      ((parsed as Partial<PromptStashData>).version === 1 ||
        (parsed as Partial<PromptStashData>).version === 2) &&
      typeof (parsed as Partial<PromptStashData>).text === 'string'
    ) {
      return parsed as PromptStashData;
    }
  } catch {
    // A missing or malformed stash must never prevent CLI startup.
  }
  return null;
}

export function restorePromptStash(
  targetDir: string,
  currentText: string,
  onRestore: (text: string, version: PromptStashData['version']) => void,
): boolean {
  const stashed = loadPromptStash(targetDir);
  if (stashed === null || currentText.length > 0) {
    return false;
  }
  onRestore(stashed.text, stashed.version);
  return true;
}

export function clearPromptStash(targetDir: string): boolean {
  try {
    fs.unlinkSync(getPromptStashPath(targetDir));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}
