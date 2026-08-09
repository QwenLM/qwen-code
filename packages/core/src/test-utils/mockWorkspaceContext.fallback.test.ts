/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';

import * as fs from 'node:fs';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    realpathSync: vi.fn(() => {
      const error = new Error('mocked missing path') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }),
  };
});

import { createMockWorkspaceContext } from './mockWorkspaceContext.js';

const rootDir = mkdtempSync(path.join(os.tmpdir(), 'qwen-workspace-'));

describe('createMockWorkspaceContext filesystem fallback', () => {
  it('uses lexical containment when canonicalization is unavailable', () => {
    const workspace = createMockWorkspaceContext(rootDir);

    expect(
      workspace.isPathWithinWorkspace(path.join(rootDir, 'missing.txt')),
    ).toBe(true);
    expect(workspace.isPathWithinWorkspace(`${rootDir}-sibling`)).toBe(false);
  });

  it('uses lexical containment when ENOENT has no path', () => {
    const workspace = createMockWorkspaceContext(rootDir);

    expect(
      workspace.isPathWithinWorkspace(path.join(rootDir, 'missing.txt')),
    ).toBe(true);
  });

  it('uses lexical containment for non-Node filesystem stubs', () => {
    vi.mocked(fs.realpathSync).mockImplementation(() => {
      throw new TypeError('mocked filesystem call');
    });
    const workspace = createMockWorkspaceContext(rootDir);

    expect(workspace.isPathWithinWorkspace(`${rootDir}-sibling`)).toBe(false);
    expect(
      workspace.isPathWithinWorkspace(path.join(rootDir, 'missing.txt')),
    ).toBe(true);
  });
});

afterAll(() => {
  rmSync(rootDir, { recursive: true, force: true });
});
