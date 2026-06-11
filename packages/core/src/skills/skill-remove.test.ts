/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { removeSkill } from './skill-remove.js';

vi.mock('node:fs/promises');

const mockAccess = vi.mocked(fs.access);
const mockRm = vi.mocked(fs.rm);

describe('removeSkill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccess.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
  });

  it('removes the skill directory when SKILL.md exists', async () => {
    const skillsDir = '/home/user/.qwen/skills';
    await removeSkill(skillsDir, 'my-skill');

    expect(mockAccess).toHaveBeenCalledWith(
      path.join(skillsDir, 'my-skill', 'SKILL.md'),
    );
    expect(mockRm).toHaveBeenCalledWith(path.join(skillsDir, 'my-skill'), {
      recursive: true,
    });
  });

  it('throws a friendly error when the skill does not exist', async () => {
    mockAccess.mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );

    await expect(removeSkill('/skills', 'missing')).rejects.toThrow(
      /not found/,
    );
    expect(mockRm).not.toHaveBeenCalled();
  });

  it('rejects invalid skill names before any filesystem access', async () => {
    await expect(removeSkill('/skills', '../escape')).rejects.toThrow(
      /must match/,
    );
    expect(mockAccess).not.toHaveBeenCalled();
    expect(mockRm).not.toHaveBeenCalled();
  });

  it('rejects names with spaces', async () => {
    await expect(removeSkill('/skills', 'bad name')).rejects.toThrow(
      /must match/,
    );
  });
});
