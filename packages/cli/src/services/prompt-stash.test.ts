/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '@qwen-code/qwen-code-core';
import {
  clearPromptStash,
  loadPromptStash,
  restorePromptStash,
  savePromptStash,
} from './prompt-stash.js';

describe('prompt stash', () => {
  let runtimeDir: string;
  const targetDir = '/workspace/project';

  beforeEach(() => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-prompt-stash-'));
    vi.spyOn(Storage, 'getRuntimeBaseDir').mockReturnValue(runtimeDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });

  it('round-trips multiline and unicode input', () => {
    const text = 'first line\n第二行 🚀';

    expect(savePromptStash(targetDir, text)).toBe(true);
    expect(loadPromptStash(targetDir)).toBe(text);
  });

  it('clears a saved prompt', () => {
    expect(savePromptStash(targetDir, 'keep me')).toBe(true);

    expect(clearPromptStash(targetDir)).toBe(true);
    expect(loadPromptStash(targetDir)).toBeNull();
    expect(clearPromptStash(targetDir)).toBe(true);
  });

  it('restores into an empty input without overwriting existing text', () => {
    const onRestore = vi.fn();
    expect(savePromptStash(targetDir, 'saved draft')).toBe(true);

    expect(restorePromptStash(targetDir, '', onRestore)).toBe(true);
    expect(onRestore).toHaveBeenCalledWith('saved draft');

    onRestore.mockClear();
    expect(restorePromptStash(targetDir, 'typing now', onRestore)).toBe(false);
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('ignores malformed stash data', () => {
    const projectDir = new Storage(targetDir).getProjectDir();
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'prompt-stash.json'), '{bad json');

    expect(loadPromptStash(targetDir)).toBeNull();
  });
});
