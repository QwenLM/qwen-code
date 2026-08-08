/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createMockWorkspaceContext } from './mockWorkspaceContext.js';

describe('createMockWorkspaceContext', () => {
  it('accepts missing descendants under a workspace root', () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), 'qwen-workspace-'));
    const workspace = createMockWorkspaceContext(rootDir);

    expect(
      workspace.isPathWithinWorkspace(path.join(rootDir, 'missing.txt')),
    ).toBe(true);
  });

  it('does not treat a similarly prefixed sibling as inside the workspace', () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), 'qwen-workspace-'));
    const workspace = createMockWorkspaceContext(rootDir);

    expect(workspace.isPathWithinWorkspace(`${rootDir}-sibling/file.txt`)).toBe(
      false,
    );
  });

  it('checks additional workspace directories', () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), 'qwen-workspace-'));
    const additionalDir = mkdtempSync(
      path.join(os.tmpdir(), 'qwen-workspace-'),
    );
    const workspace = createMockWorkspaceContext(rootDir, [additionalDir]);

    expect(
      workspace.isPathWithinWorkspace(path.join(additionalDir, 'missing.txt')),
    ).toBe(true);
  });
});
