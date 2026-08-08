/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
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

  it('canonicalizes workspace aliases for containment checks', () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), 'qwen-workspace-'));
    const aliasDir = path.join(
      os.tmpdir(),
      `qwen-workspace-alias-${Date.now()}`,
    );
    symlinkSync(rootDir, aliasDir);

    try {
      const workspace = createMockWorkspaceContext(aliasDir);

      expect(
        workspace.isPathWithinWorkspace(path.join(rootDir, 'missing.txt')),
      ).toBe(true);
    } finally {
      rmSync(aliasDir, { force: true });
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('rejects dangling leaf symlinks', () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), 'qwen-workspace-'));
    const danglingPath = path.join(rootDir, 'dangling');
    symlinkSync(path.join(rootDir, 'missing-target'), danglingPath);

    try {
      const workspace = createMockWorkspaceContext(rootDir);

      expect(workspace.isPathWithinWorkspace(danglingPath)).toBe(false);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('rejects paths through a symlink cycle', () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), 'qwen-workspace-'));
    const cyclePath = path.join(rootDir, 'cycle');
    symlinkSync('cycle', cyclePath);

    try {
      const workspace = createMockWorkspaceContext(rootDir);

      expect(
        workspace.isPathWithinWorkspace(path.join(cyclePath, 'file.txt')),
      ).toBe(false);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
