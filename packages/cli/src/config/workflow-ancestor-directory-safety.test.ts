/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isWorkflowAncestorDirectorySafe } from './workflow-ancestor-directory-safety.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

describe('workflow ancestor directory safety', () => {
  let directory: string;

  beforeEach(() => {
    vi.mocked(fs.statSync).mockReset();
    directory = fs.mkdtempSync(path.join(tmpdir(), 'qwen-ancestor-safety-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('accepts missing optional workflow directories', () => {
    expect(isWorkflowAncestorDirectorySafe(directory)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a missing ancestor directory',
    () => {
      expect(
        isWorkflowAncestorDirectorySafe(path.join(directory, 'missing')),
      ).toBe(false);
    },
  );

  it
    .skipIf(process.platform === 'win32')
    .each(['', '.qwen', path.join('.qwen', 'workflows')])(
    'rejects world-writable %s',
    (component) => {
      fs.mkdirSync(path.join(directory, '.qwen', 'workflows'), {
        recursive: true,
      });
      const unsafe = path.join(directory, component);
      fs.chmodSync(unsafe, 0o777);
      try {
        expect(isWorkflowAncestorDirectorySafe(directory)).toBe(false);
      } finally {
        fs.chmodSync(unsafe, 0o755);
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects unexpected optional-directory stat failures',
    async () => {
      const { statSync } =
        await vi.importActual<typeof import('node:fs')>('node:fs');
      vi.mocked(fs.statSync).mockImplementation((location, ...args) => {
        if (String(location) === path.join(directory, '.qwen')) {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        }
        return statSync(location, ...args);
      });
      expect(isWorkflowAncestorDirectorySafe(directory)).toBe(false);
    },
  );

  it('does not interpret POSIX mode bits as Windows ACLs', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(isWorkflowAncestorDirectorySafe(directory)).toBe(true);
      expect(fs.statSync).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});
