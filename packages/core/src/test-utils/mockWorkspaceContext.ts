/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi } from 'vitest';
import { isNodeError } from '../utils/errors.js';
import {
  isPathWithinRoot,
  resolveWorkspacePath,
} from '../utils/workspaceContext.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';

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

  const mockWorkspaceContext = {
    addDirectory: vi.fn(),
    getDirectories: vi.fn().mockReturnValue(allDirs),
    isPathWithinWorkspace: vi.fn().mockImplementation((path: string) => {
      try {
        const canonicalPath = canonicalizeForContainment(path);
        return allDirs.some((dir) => {
          try {
            return isPathWithinRoot(
              canonicalPath,
              canonicalizeForContainment(dir),
            );
          } catch {
            return false;
          }
        });
      } catch {
        return false;
      }
    }),
  } as unknown as WorkspaceContext;

  return mockWorkspaceContext;
}

function canonicalizeForContainment(inputPath: string): string {
  try {
    return resolveWorkspacePath(inputPath);
  } catch (error: unknown) {
    if (isNodeError(error)) {
      if (error.code === 'ENOENT' && !error.path) {
        return inputPath;
      }
      throw error;
    }

    // Some tests stub filesystem calls; retain lexical behavior for those
    // mocked environments.
    return inputPath;
  }
}
