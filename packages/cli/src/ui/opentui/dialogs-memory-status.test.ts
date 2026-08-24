/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Memory dialog path resolution tests (audit 01 G-8): the configured
 * context file names (getAllGeminiMdFilenames) drive the displayed paths —
 * never a hardcoded memory.md.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

import {
  getAllGeminiMdFilenames,
  setGeminiMdFilename,
} from '@qwen-code/qwen-code-core';
import {
  resolvePreferredMemoryFile,
  readMemoryToggle,
} from './dialogs-memory-status.js';

describe('readMemoryToggle (ink readToggle parity)', () => {
  const off = { bareMode: false, safeMode: false };

  it('defaults managed-memory toggles ON and honors explicit values', () => {
    expect(readMemoryToggle(undefined, off)).toBe(true);
    expect(readMemoryToggle(true, off)).toBe(true);
    expect(readMemoryToggle(false, off)).toBe(false);
  });

  it('gates every toggle off in bare and safe modes', () => {
    expect(readMemoryToggle(true, { bareMode: true, safeMode: false })).toBe(
      false,
    );
    expect(readMemoryToggle(true, { bareMode: false, safeMode: true })).toBe(
      false,
    );
  });
});

describe('resolvePreferredMemoryFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentui-memory-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('picks the first configured filename that exists', () => {
    // Default configured names include QWEN.md and AGENTS.md.
    const filenames = getAllGeminiMdFilenames();
    const present = filenames.at(-1) ?? 'AGENTS.md';
    fs.writeFileSync(path.join(dir, present), '# memory');
    expect(resolvePreferredMemoryFile(dir)).toBe(path.join(dir, present));
  });

  it('falls back to the primary configured filename when none exist', () => {
    expect(resolvePreferredMemoryFile(dir)).toBe(
      path.join(dir, getAllGeminiMdFilenames()[0] ?? 'QWEN.md'),
    );
  });

  it('honors overridden configured filenames', () => {
    setGeminiMdFilename(['CUSTOM.md']);
    try {
      fs.writeFileSync(path.join(dir, 'CUSTOM.md'), '# custom');
      expect(resolvePreferredMemoryFile(dir)).toBe(path.join(dir, 'CUSTOM.md'));
    } finally {
      // Restore the default list for other tests.
      setGeminiMdFilename(['QWEN.md', 'AGENTS.md']);
    }
  });
});
