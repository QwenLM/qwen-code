/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync, Storage } from '@qwen-code/qwen-code-core';

const PROMPT_STASH_FILE = 'prompt-stash.json';

interface PromptStashData {
  version: 1;
  text: string;
}

function getPromptStashPath(targetDir: string): string {
  return path.join(new Storage(targetDir).getProjectDir(), PROMPT_STASH_FILE);
}

export function savePromptStash(targetDir: string, text: string): boolean {
  try {
    const filePath = getPromptStashPath(targetDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const data: PromptStashData = { version: 1, text };
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

export function loadPromptStash(targetDir: string): string | null {
  try {
    const raw = fs.readFileSync(getPromptStashPath(targetDir), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as Partial<PromptStashData>).version === 1 &&
      typeof (parsed as Partial<PromptStashData>).text === 'string'
    ) {
      return (parsed as PromptStashData).text;
    }
  } catch {
    // A missing or malformed stash must never prevent CLI startup.
  }
  return null;
}

export function restorePromptStash(
  targetDir: string,
  currentText: string,
  onRestore: (text: string) => void,
): boolean {
  const stashedPrompt = loadPromptStash(targetDir);
  if (stashedPrompt === null || currentText.length > 0) {
    return false;
  }
  onRestore(stashedPrompt);
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
