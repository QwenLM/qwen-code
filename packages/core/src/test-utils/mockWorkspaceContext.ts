/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi } from 'vitest';
import { isNodeError } from '../utils/errors.js';
import { isPathWithinRoot } from '../utils/workspaceContext.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';
import * as fs from 'node:fs';

/**
 * Creates a mock WorkspaceContext for testing
 * @param rootDir The root directory to use for the mock
 * @param additionalDirs Optional additional directories to include in the workspace
 * @returns A mock WorkspaceContext instance
 */
export function createMockWorkspaceContext(
  rootDir: string,
  additionalDirs: string[] = [],
): WorkspaceContext {
  const allDirs = [rootDir, ...additionalDirs];
  const canonicalDirs = allDirs.map(canonicalizeForContainment);

  const mockWorkspaceContext = {
    addDirectory: vi.fn(),
    getDirectories: vi.fn().mockReturnValue(allDirs),
    isPathWithinWorkspace: vi.fn().mockImplementation((path: string) => {
      try {
        const canonicalPath = canonicalizeForContainment(path);
        return canonicalDirs.some((dir) =>
          isPathWithinRoot(canonicalPath, dir),
        );
      } catch {
        return false;
      }
    }),
  } as unknown as WorkspaceContext;

  return mockWorkspaceContext;
}

function canonicalizeForContainment(inputPath: string): string {
  try {
    const resolved = fs.realpathSync(inputPath);
    return typeof resolved === 'string' ? resolved : inputPath;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      if (error.path && isFileSymlink(error.path)) {
        throw error;
      }
      return error.path ?? inputPath;
    }

    if (isNodeError(error)) {
      throw error;
    }

    // Some tests stub filesystem calls; retain lexical behavior for those
    // mocked environments.
    return inputPath;
  }
}

function isFileSymlink(filePath: string): boolean {
  try {
    return !fs.readlinkSync(filePath).endsWith('/');
  } catch {
    return false;
  }
}
