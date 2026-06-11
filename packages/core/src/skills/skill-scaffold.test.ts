/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { scaffoldSkill } from './skill-scaffold.js';

vi.mock('node:fs/promises');

const mockMkdir = vi.mocked(fs.mkdir);
const mockWriteFile = vi.mocked(fs.writeFile);

describe('scaffoldSkill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
  });

  it('creates the skill directory and SKILL.md', async () => {
    const skillsDir = '/home/user/.qwen/skills';
    const result = await scaffoldSkill(skillsDir, 'my-skill');

    expect(mockMkdir).toHaveBeenCalledWith(path.join(skillsDir, 'my-skill'), {
      recursive: true,
    });
    expect(mockWriteFile).toHaveBeenCalledWith(
      path.join(skillsDir, 'my-skill', 'SKILL.md'),
      expect.stringContaining('name: my-skill'),
      { flag: 'wx' },
    );
    expect(result).toBe(path.join(skillsDir, 'my-skill', 'SKILL.md'));
  });

  it('includes name, description placeholder, and body in template', async () => {
    await scaffoldSkill('/skills', 'review');

    const written = mockWriteFile.mock.calls[0]![1] as string;
    expect(written).toContain('name: review');
    expect(written).toContain('description:');
    expect(written).toContain('# review');
  });

  it('rejects invalid skill names', async () => {
    await expect(scaffoldSkill('/skills', 'bad name')).rejects.toThrow(
      /must match/,
    );
    await expect(scaffoldSkill('/skills', '../traversal')).rejects.toThrow(
      /must match/,
    );
    expect(mockMkdir).not.toHaveBeenCalled();
  });

  it('throws a friendly error when the skill already exists', async () => {
    const eexist = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    mockWriteFile.mockRejectedValue(eexist);

    await expect(scaffoldSkill('/skills', 'existing')).rejects.toThrow(
      /already exists/,
    );
  });

  it('rethrows non-EEXIST write errors', async () => {
    const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    mockWriteFile.mockRejectedValue(eperm);

    await expect(scaffoldSkill('/skills', 'my-skill')).rejects.toThrow('EPERM');
  });
});
