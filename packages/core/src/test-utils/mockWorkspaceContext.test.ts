/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createMockWorkspaceContext } from './mockWorkspaceContext.js';

describe('createMockWorkspaceContext', () => {
  it('accepts missing descendants under a workspace root', () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), 'qwen-workspace-'));
    try {
      const workspace = createMockWorkspaceContext(rootDir);

      expect(
        workspace.isPathWithinWorkspace(path.join(rootDir, 'missing.txt')),
      ).toBe(true);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('does not treat a similarly prefixed sibling as inside the workspace', () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), 'qwen-workspace-'));
    try {
      const workspace = createMockWorkspaceContext(rootDir);

      expect(
        workspace.isPathWithinWorkspace(`${rootDir}-sibling/file.txt`),
      ).toBe(false);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('checks additional workspace directories', () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), 'qwen-workspace-'));
    const additionalDir = mkdtempSync(
      path.join(os.tmpdir(), 'qwen-workspace-'),
    );
    try {
      const workspace = createMockWorkspaceContext(rootDir, [additionalDir]);

      expect(
        workspace.isPathWithinWorkspace(
          path.join(additionalDir, 'missing.txt'),
        ),
      ).toBe(true);
    } finally {
      rmSync(additionalDir, { recursive: true, force: true });
      rmSync(rootDir, { recursive: true, force: true });
    }
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
      rmSync(aliasDir, { recursive: true, force: true });
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('does not collapse missing paths below a symlinked ancestor', () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), 'qwen-workspace-'));
    const aliasDir = path.join(
      os.tmpdir(),
      `qwen-workspace-alias-${Date.now()}`,
    );
    symlinkSync(rootDir, aliasDir);

    try {
      const workspaceRoot = path.join(aliasDir, 'ghost', 'workspace');
      const siblingPath = path.join(
        aliasDir,
        'ghost',
        'completely-different',
        'file.txt',
      );
      const workspace = createMockWorkspaceContext(workspaceRoot);

      expect(workspace.isPathWithinWorkspace(siblingPath)).toBe(false);
    } finally {
      rmSync(aliasDir, { recursive: true, force: true });
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

  it('resolves existing candidate paths before checking containment', () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), 'qwen-workspace-'));
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'qwen-outside-'));
    const insidePath = path.join(rootDir, 'inside.txt');
    const outsidePath = path.join(outsideDir, 'outside.txt');
    const escapePath = path.join(rootDir, 'escape');
    writeFileSync(insidePath, 'inside');
    writeFileSync(outsidePath, 'outside');
    symlinkSync(outsidePath, escapePath);

    try {
      const workspace = createMockWorkspaceContext(rootDir);

      expect(workspace.isPathWithinWorkspace(insidePath)).toBe(true);
      expect(workspace.isPathWithinWorkspace(escapePath)).toBe(false);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
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

  it('ignores an invalid workspace root when another root is valid', () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), 'qwen-workspace-'));
    const cyclePath = path.join(rootDir, 'cycle');
    const candidatePath = path.join(rootDir, 'inside.txt');
    symlinkSync('cycle', cyclePath);
    writeFileSync(candidatePath, 'inside');

    try {
      const workspace = createMockWorkspaceContext(cyclePath, [rootDir]);

      expect(workspace.isPathWithinWorkspace(candidatePath)).toBe(true);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
