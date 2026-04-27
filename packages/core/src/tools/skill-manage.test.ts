/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { SkillManageTool } from './skill-manage.js';
import { EXCLUDED_TOOLS_FOR_SUBAGENTS } from '../agents/runtime/agent-core.js';
import { ToolNames } from '../tools/tool-names.js';

// ─── Checklist 5: skill_manage excluded from subagents ───────────────────────

describe('EXCLUDED_TOOLS_FOR_SUBAGENTS – skill_manage isolation', () => {
  it('contains skill_manage so task-execution subagents cannot call it', () => {
    expect(EXCLUDED_TOOLS_FOR_SUBAGENTS.has(ToolNames.SKILL_MANAGE)).toBe(true);
  });

  it('contains agent to prevent recursive subagent spawning', () => {
    expect(EXCLUDED_TOOLS_FOR_SUBAGENTS.has(ToolNames.AGENT)).toBe(true);
  });

  it('does NOT exclude ordinary tools like read_file', () => {
    expect(EXCLUDED_TOOLS_FOR_SUBAGENTS.has(ToolNames.READ_FILE)).toBe(false);
  });
});

async function runSkillManage(
  tool: SkillManageTool,
  params: Parameters<SkillManageTool['build']>[0],
) {
  return tool.build(params).execute(new AbortController().signal);
}

describe('SkillManageTool', () => {
  let tempDir: string;
  let projectRoot: string;
  let config: Config;
  let tool: SkillManageTool;
  const refreshCache = vi.fn();

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-manage-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    refreshCache.mockReset();
    config = {
      getProjectRoot: vi.fn().mockReturnValue(projectRoot),
      getSkillManager: vi.fn().mockReturnValue({ refreshCache }),
    } as unknown as Config;
    tool = new SkillManageTool(config);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('creates a project-level SKILL.md', async () => {
    const result = await runSkillManage(tool, {
      action: 'create',
      name: 'My Skill',
      content: '---\nname: my-skill\ndescription: Test\n---\n\n# Test\n',
    });

    expect(result.error).toBeUndefined();
    await expect(
      fs.readFile(
        path.join(projectRoot, '.qwen', 'skills', 'my-skill', 'SKILL.md'),
        'utf-8',
      ),
    ).resolves.toContain('name: my-skill');
    expect(refreshCache).toHaveBeenCalled();
  });

  it('patches an existing skill file', async () => {
    const skillPath = path.join(
      projectRoot,
      '.qwen',
      'skills',
      'patch-me',
      'SKILL.md',
    );
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.writeFile(skillPath, 'old body', 'utf-8');

    const result = await runSkillManage(tool, {
      action: 'patch',
      name: 'patch-me',
      old_string: 'old',
      new_string: 'new',
    });

    expect(result.error).toBeUndefined();
    await expect(fs.readFile(skillPath, 'utf-8')).resolves.toBe('new body');
  });

  it('rejects write_file path traversal outside project skills', async () => {
    const result = await runSkillManage(tool, {
      action: 'write_file',
      name: 'refs',
      file_path: '../../outside.md',
      file_content: 'bad',
    });

    expect(result.error?.message).toContain('skill_manage can only write to');
    await expect(
      fs.stat(path.join(projectRoot, '.qwen', 'outside.md')),
    ).rejects.toThrow();
  });

  // ─── Checklist 4: Write protection ─────────────────────────────────────────

  it('sanitizes name path traversal: creates skill safely inside project', async () => {
    // Attempt to use a path-traversal-looking name.
    // sanitizeSkillName() converts "../../../etc/malicious" → "----------etc-malicious"
    // so the result is a safe path inside .qwen/skills/ (never escapes it).
    const result = await runSkillManage(tool, {
      action: 'create',
      name: '../../../etc/malicious',
      content: '---\nname: sanitized\n---\n',
    });

    // The call should succeed (the name is sanitized, not rejected)
    expect(result.error).toBeUndefined();
    // The file must be written inside the project skills root, not at /etc/malicious
    await expect(fs.stat('/etc/malicious/SKILL.md')).rejects.toThrow();
    // Verify it landed somewhere inside .qwen/skills/
    const skillsRoot = path.join(projectRoot, '.qwen', 'skills');
    const dirs = await fs.readdir(skillsRoot);
    expect(dirs.length).toBeGreaterThan(0);
  });

  it('allows write_file inside skill directory (reference file)', async () => {
    const result = await runSkillManage(tool, {
      action: 'write_file',
      name: 'my-skill',
      file_path: 'references/api.md',
      file_content: '# API reference\n',
    });

    expect(result.error).toBeUndefined();
    await expect(
      fs.readFile(
        path.join(
          projectRoot,
          '.qwen',
          'skills',
          'my-skill',
          'references',
          'api.md',
        ),
        'utf-8',
      ),
    ).resolves.toContain('API reference');
  });

  it('upsert: create succeeds if file already exists (idempotent)', async () => {
    const content1 = '---\nname: my-skill\ndescription: v1\n---\n';
    const content2 = '---\nname: my-skill\ndescription: v2\n---\n';

    // First create
    await runSkillManage(tool, {
      action: 'create',
      name: 'my-skill',
      content: content1,
    });

    // Second create on same name should succeed (upsert), not throw
    const result = await runSkillManage(tool, {
      action: 'create',
      name: 'my-skill',
      content: content2,
    });

    expect(result.error).toBeUndefined();
    // Content should be updated to v2
    const written = await fs.readFile(
      path.join(projectRoot, '.qwen', 'skills', 'my-skill', 'SKILL.md'),
      'utf-8',
    );
    expect(written).toContain('v2');
  });

  it('deletes the skill directory', async () => {
    // Setup
    await runSkillManage(tool, {
      action: 'create',
      name: 'to-delete',
      content: '---\nname: to-delete\n---\n',
    });

    const skillDir = path.join(projectRoot, '.qwen', 'skills', 'to-delete');
    await expect(fs.stat(skillDir)).resolves.toBeTruthy();

    // Delete
    const result = await runSkillManage(tool, {
      action: 'delete',
      name: 'to-delete',
    });

    expect(result.error).toBeUndefined();
    await expect(fs.stat(skillDir)).rejects.toThrow();
    expect(refreshCache).toHaveBeenCalled();
  });
});
