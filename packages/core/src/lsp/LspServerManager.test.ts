/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config as CoreConfig } from '../config/config.js';
import type { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';
import { LspServerManager } from './LspServerManager.js';

const createManager = (workspaceRoot: string) => {
  const config = {
    isTrustedFolder: () => true,
  } as unknown as CoreConfig;
  const workspaceContext = {
    getDirectories: () => [workspaceRoot],
  } as unknown as WorkspaceContext;
  const fileDiscoveryService = {
    shouldIgnoreFile: () => false,
  } as unknown as FileDiscoveryService;
  return new LspServerManager(config, workspaceContext, fileDiscoveryService, {
    requireTrustedWorkspace: true,
    workspaceRoot,
  });
};

const getIsPathSafe = (manager: LspServerManager) =>
  (
    manager as unknown as {
      isPathSafe: (
        command: string,
        workspacePath: string,
        cwd?: string,
      ) => boolean;
    }
  ).isPathSafe.bind(manager);

describe('LspServerManager path safety', () => {
  it('allows bare command names', () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lsp-workspace-'),
    );
    const manager = createManager(workspaceRoot);
    const isPathSafe = getIsPathSafe(manager);

    expect(isPathSafe('clangd', workspaceRoot)).toBe(true);

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('rejects absolute command paths outside workspace that are not in PATH', () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lsp-workspace-'),
    );
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-bin-'));
    const commandPath = path.join(binDir, 'not-in-path');
    fs.writeFileSync(commandPath, '#!/bin/sh\necho nope\n');
    fs.chmodSync(commandPath, 0o755);

    const manager = createManager(workspaceRoot);
    const isPathSafe = getIsPathSafe(manager);

    expect(isPathSafe(commandPath, workspaceRoot)).toBe(false);

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  it('allows absolute command paths that resolve from PATH', () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'lsp-workspace-'),
    );
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-bin-'));
    const commandPath = path.join(binDir, 'path-safe');
    fs.writeFileSync(commandPath, '#!/bin/sh\necho ok\n');
    fs.chmodSync(commandPath, 0o755);

    const originalPath = process.env['PATH'];
    process.env['PATH'] = `${binDir}${path.delimiter}${originalPath ?? ''}`;

    try {
      const manager = createManager(workspaceRoot);
      const isPathSafe = getIsPathSafe(manager);
      expect(isPathSafe(commandPath, workspaceRoot)).toBe(true);
    } finally {
      process.env['PATH'] = originalPath;
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });
});
