/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(() => ''),
  };
});

vi.mock('../platform.js', () => ({
  getPlatform: vi.fn(() => 'windows'),
}));

vi.mock('../paths.js', () => ({
  homedir: vi.fn(() => os.tmpdir()),
  getConfigHomeDir: vi.fn(() => path.join(os.tmpdir(), '.qwen')),
}));

vi.mock('../runLogger.js', () => ({
  runLogger: {
    debug: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { findPreparedGitPath } from './index.js';
import { CRITICAL_GIT_FILES } from './types.js';
import { getConfigHomeDir } from '../paths.js';

describe('findPreparedGitPath', () => {
  let configDir: string;
  let gitDir: string;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-git-test-'));
    gitDir = path.join(configDir, 'bin', 'git');
    vi.mocked(getConfigHomeDir).mockReturnValue(configDir);
    vi.mocked(execFileSync).mockReturnValue('');
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns empty string when no installation exists', () => {
    expect(findPreparedGitPath()).toBe('');
  });

  it('returns bash path when installation passes strong validation', () => {
    for (const relPath of CRITICAL_GIT_FILES) {
      const fullPath = path.join(gitDir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, 'fake');
    }

    expect(findPreparedGitPath()).toBe(path.join(gitDir, 'bin', 'bash.exe'));
  });

  it('returns empty string for empty critical files', () => {
    for (const relPath of CRITICAL_GIT_FILES) {
      const fullPath = path.join(gitDir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, '');
    }

    expect(findPreparedGitPath()).toBe('');
  });
});
