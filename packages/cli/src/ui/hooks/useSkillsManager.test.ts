/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useSkillsManager } from './useSkillsManager.js';
import type { Config, Skill, SkillManager } from '@qwen-code/qwen-code-core';

describe('useSkillsManager', () => {
  const mockListSkills = vi.fn();
  const mockGetSkillManager = vi.fn();
  const mockGetWorkingDir = vi.fn();

  const mockConfig = {
    getSkillManager: mockGetSkillManager,
    getWorkingDir: mockGetWorkingDir,
  } as unknown as Config;

  const mockSkillManager = {
    listSkills: mockListSkills,
  } as unknown as SkillManager;

  const mockSkills: Skill[] = [
    {
      path: '/path/to/skill1',
      metadata: { name: 'skill1', description: 'desc1' },
      instructions: 'inst1',
    },
    {
      path: '/path/to/skill2',
      metadata: { name: 'skill2', description: 'desc2' },
      instructions: 'inst2',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSkillManager.mockReturnValue(mockSkillManager);
    mockGetWorkingDir.mockReturnValue('/mock/cwd');
    mockListSkills.mockResolvedValue(mockSkills);
  });

  it('loads skills on mount', async () => {
    const { result } = renderHook(() => useSkillsManager(mockConfig));

    // Initially empty
    expect(result.current.skills).toEqual([]);

    // Wait for async load
    await waitFor(() => {
      expect(result.current.skills).toHaveLength(2);
    });

    expect(mockGetSkillManager).toHaveBeenCalled();
    expect(mockListSkills).toHaveBeenCalledWith({ force: true });
    expect(result.current.skills).toEqual(mockSkills);
  });

  it('handles null config gracefully', async () => {
    const { result } = renderHook(() => useSkillsManager(null));

    expect(result.current.skills).toEqual([]);
    expect(mockGetSkillManager).not.toHaveBeenCalled();
  });

  it('refreshSkills reloads data', async () => {
    const { result } = renderHook(() => useSkillsManager(mockConfig));

    await waitFor(() => {
      expect(result.current.skills).toHaveLength(2);
    });

    const newSkills = [
      ...mockSkills,
      {
        path: '/path/to/skill3',
        metadata: { name: 'skill3', description: 'desc3' },
        instructions: 'inst3',
      },
    ];
    mockListSkills.mockResolvedValueOnce(newSkills);

    await result.current.refreshSkills();

    await waitFor(() => {
      expect(result.current.skills).toHaveLength(3);
    });
  });
});
