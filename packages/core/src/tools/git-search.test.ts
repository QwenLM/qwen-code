/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, beforeEach, afterEach, vi, expect } from 'vitest';
import { GitSearchTool } from './git-search.js';
import { Config } from '../config/config.js';
import { WorkspaceContext } from '../utils/workspaceContext.js';

// Mock the child_process module
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Mock the fs module
vi.mock('fs', () => ({
  default: {
    statSync: vi.fn(),
    existsSync: vi.fn(),
  },
}));

// Mock the gitUtils module
vi.mock('../utils/gitUtils.js', () => ({
  isGitRepository: vi.fn(),
  findGitRoot: vi.fn(),
}));

describe('GitSearchTool', () => {
  let gitSearchTool: GitSearchTool;
  let mockConfig: Config;

  beforeEach(() => {
    // Create mock config
    mockConfig = {
      getTargetDir: () => '/mock/project',
      getWorkspaceContext: () =>
        ({
          isPathWithinWorkspace: () => true,
          getDirectories: () => ['/mock/project'],
        }) as unknown as WorkspaceContext,
    } as unknown as Config;

    gitSearchTool = new GitSearchTool(mockConfig);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should create the tool with correct properties', () => {
    expect(gitSearchTool.name).toBe('git_search');
    expect(gitSearchTool.description).toBe(
      'Searches a git repository for commits, code changes, file history, or blame information.',
    );
  });

  it('should validate parameters correctly', async () => {
    // Test valid parameters
    const validParams = {
      query: 'feature',
      searchType: 'commit-message' as const,
    };
    expect(gitSearchTool.validateToolParams(validParams)).toBeNull();

    // Test invalid searchType
    const invalidParams = {
      query: 'feature',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      searchType: 'invalid-type' as any,
    };
    expect(gitSearchTool.validateToolParams(invalidParams)).toContain(
      'params/searchType must be equal to one of the allowed values',
    );

    // Test invalid maxResults
    const invalidMaxResults = {
      query: 'feature',
      searchType: 'commit-message' as const,
      maxResults: 150,
    };
    expect(gitSearchTool.validateToolParams(invalidMaxResults)).toContain(
      'params/maxResults must be <= 100',
    );
  });
});
