/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi } from 'vitest';
import { realpathNearestExisting } from '../utils/paths.js';
import { isPathWithinRoot } from '../utils/workspaceContext.js';
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
  const canonicalDirs = allDirs.map(canonicalizeForContainment);

  const mockWorkspaceContext = {
    addDirectory: vi.fn(),
    getDirectories: vi.fn().mockReturnValue(allDirs),
    isPathWithinWorkspace: vi.fn().mockImplementation((path: string) => {
      const canonicalPath = canonicalizeForContainment(path);
      return canonicalDirs.some((dir) => isPathWithinRoot(canonicalPath, dir));
    }),
  } as unknown as WorkspaceContext;

  return mockWorkspaceContext;
}

function canonicalizeForContainment(inputPath: string): string {
  try {
    return realpathNearestExisting(inputPath);
  } catch {
    // Some tests stub filesystem stat calls; retain the old lexical behavior
    // when canonicalization is unavailable in that mocked environment.
    return inputPath;
  }
}
