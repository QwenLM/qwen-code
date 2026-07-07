/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import {
  buildLearnSkillPrompt,
  buildLearnTaskPrompt,
  createLearnSkillScopedAgentConfig,
  LEARNED_SKILL_DIR_PREFIX,
  LEARN_SKILL_SYSTEM_PROMPT,
} from './learn-skill-agent.js';
import { ToolNames } from '../tools/tool-names.js';

function makeMinimalConfig(projectRoot: string): Config {
  return {
    getProjectRoot: () => projectRoot,
    getPermissionManager: () => undefined,
  } as unknown as Config;
}

function scopedPm(projectRoot: string) {
  const scoped = createLearnSkillScopedAgentConfig(
    makeMinimalConfig(projectRoot),
    projectRoot,
  );
  const pm = scoped.getPermissionManager();
  if (!pm) {
    throw new Error(
      'createLearnSkillScopedAgentConfig must install a PermissionManager',
    );
  }
  return pm;
}

async function writeSkillFile(
  projectRoot: string,
  skillName: string,
  content: string,
): Promise<string> {
  const dir = path.join(projectRoot, '.qwen', 'skills', skillName);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'SKILL.md');
  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

const LEARNED_SKILL = `---
name: my-skill
source: learned
---

body
`;

const AUTO_SKILL = `---
name: my-skill
source: auto-skill
---

body
`;

const USER_SKILL = `---
name: my-skill
description: hand-authored
---

human body
`;

describe('learnSkillAgent — scoped permissions', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-skill-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('allows read_file from any path (including outside project root)', async () => {
    const outsidePath = path.join(tempDir, 'external', 'README.md');
    const pm = scopedPm(projectRoot);
    expect(
      await pm.evaluate({
        toolName: ToolNames.READ_FILE,
        filePath: outsidePath,
      }),
    ).toBe('allow');
  });

  it('allows list_directory from any path', async () => {
    const pm = scopedPm(projectRoot);
    expect(
      await pm.evaluate({
        toolName: ToolNames.LS,
        filePath: '/some/external/dir',
      }),
    ).toBe('allow');
  });

  it('allows grep_search from any path', async () => {
    const pm = scopedPm(projectRoot);
    expect(
      await pm.evaluate({ toolName: ToolNames.GREP, filePath: '/external' }),
    ).toBe('allow');
  });

  it('allows web_fetch', async () => {
    const pm = scopedPm(projectRoot);
    expect(await pm.evaluate({ toolName: ToolNames.WEB_FETCH })).toBe('allow');
  });

  it('allows write_file to a fresh learned-skill path', async () => {
    const fresh = path.join(
      projectRoot,
      '.qwen',
      'skills',
      'learned-skill-deploy',
      'SKILL.md',
    );
    const pm = scopedPm(projectRoot);
    expect(
      await pm.evaluate({ toolName: ToolNames.WRITE_FILE, filePath: fresh }),
    ).toBe('allow');
  });

  it('denies write_file to an existing skill path', async () => {
    const filePath = await writeSkillFile(
      projectRoot,
      'learned-skill-deploy',
      LEARNED_SKILL,
    );
    const pm = scopedPm(projectRoot);
    expect(
      await pm.evaluate({ toolName: ToolNames.WRITE_FILE, filePath }),
    ).toBe('deny');
  });

  it('denies write_file to a path outside the project skills root', async () => {
    const escape = path.join(projectRoot, 'NOT-SKILLS', 'evil.md');
    const pm = scopedPm(projectRoot);
    expect(
      await pm.evaluate({ toolName: ToolNames.WRITE_FILE, filePath: escape }),
    ).toBe('deny');
  });

  it('denies write_file to a non-SKILL.md path inside the skills root', async () => {
    const aux = path.join(
      projectRoot,
      '.qwen',
      'skills',
      'learned-skill-x',
      'NOTES.md',
    );
    await fs.mkdir(path.dirname(aux), { recursive: true });
    const pm = scopedPm(projectRoot);
    expect(
      await pm.evaluate({ toolName: ToolNames.WRITE_FILE, filePath: aux }),
    ).toBe('deny');
  });

  it('allows edit on an existing learned skill', async () => {
    const filePath = await writeSkillFile(
      projectRoot,
      'learned-skill-deploy',
      LEARNED_SKILL,
    );
    const pm = scopedPm(projectRoot);
    expect(await pm.evaluate({ toolName: ToolNames.EDIT, filePath })).toBe(
      'allow',
    );
  });

  it('denies edit on an existing auto-skill', async () => {
    const filePath = await writeSkillFile(
      projectRoot,
      'auto-skill-foo',
      AUTO_SKILL,
    );
    const pm = scopedPm(projectRoot);
    expect(await pm.evaluate({ toolName: ToolNames.EDIT, filePath })).toBe(
      'deny',
    );
  });

  it('denies edit on a user-authored skill', async () => {
    const filePath = await writeSkillFile(projectRoot, 'my-skill', USER_SKILL);
    const pm = scopedPm(projectRoot);
    expect(await pm.evaluate({ toolName: ToolNames.EDIT, filePath })).toBe(
      'deny',
    );
  });

  it('denies edit on a path outside the skills root', async () => {
    const pm = scopedPm(projectRoot);
    expect(
      await pm.evaluate({
        toolName: ToolNames.EDIT,
        filePath: path.join(projectRoot, 'src', 'index.ts'),
      }),
    ).toBe('deny');
  });

  it('denies write_file when the target traverses a symlink', async () => {
    const outside = path.join(tempDir, 'outside');
    await fs.mkdir(outside, { recursive: true });
    const skillsRoot = path.join(projectRoot, '.qwen', 'skills');
    await fs.mkdir(skillsRoot, { recursive: true });
    await fs.symlink(outside, path.join(skillsRoot, 'escape'));
    const target = path.join(skillsRoot, 'escape', 'SKILL.md');
    const pm = scopedPm(projectRoot);
    expect(
      await pm.evaluate({ toolName: ToolNames.WRITE_FILE, filePath: target }),
    ).toBe('deny');
  });
});

describe('buildLearnTaskPrompt', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-prompt-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('lists existing skill names to prevent collisions', async () => {
    await writeSkillFile(projectRoot, 'alpha', AUTO_SKILL);
    await writeSkillFile(projectRoot, 'beta', USER_SKILL);
    const prompt = await buildLearnTaskPrompt(projectRoot, {
      rawInput: 'https://example.com/docs',
    });
    expect(prompt).toContain('alpha');
    expect(prompt).toContain('beta');
    expect(prompt).toMatch(/do NOT reuse/i);
  });

  it('shows a placeholder when no skills exist', async () => {
    const prompt = await buildLearnTaskPrompt(projectRoot, {
      rawInput: 'some text',
    });
    expect(prompt).toMatch(/no skills exist yet/i);
  });

  it('includes the user input as knowledge source', async () => {
    const prompt = await buildLearnTaskPrompt(projectRoot, {
      rawInput: 'https://docs.example.com/api/quickstart',
    });
    expect(prompt).toContain('https://docs.example.com/api/quickstart');
  });

  it('instructs the agent to use the learned-skill- directory prefix', async () => {
    const prompt = await buildLearnTaskPrompt(projectRoot, {
      rawInput: 'some knowledge',
    });
    expect(prompt).toContain(LEARNED_SKILL_DIR_PREFIX);
    expect(prompt).toContain(
      `.qwen/skills/${LEARNED_SKILL_DIR_PREFIX}<name>/SKILL.md`,
    );
  });

  it('includes source: learned in the frontmatter template', async () => {
    const prompt = await buildLearnTaskPrompt(projectRoot, {
      rawInput: 'test',
    });
    expect(prompt).toContain('source: learned');
  });
});

describe('LEARN_SKILL_SYSTEM_PROMPT', () => {
  it('requires the learned-skill- directory prefix for new skills', () => {
    expect(LEARN_SKILL_SYSTEM_PROMPT).toContain(LEARNED_SKILL_DIR_PREFIX);
    expect(LEARN_SKILL_SYSTEM_PROMPT).toContain(
      `.qwen/skills/${LEARNED_SKILL_DIR_PREFIX}<name>/SKILL.md`,
    );
    expect(LEARN_SKILL_SYSTEM_PROMPT).toMatch(/MUST use/i);
  });

  it('requires source: learned in frontmatter', () => {
    expect(LEARN_SKILL_SYSTEM_PROMPT).toContain('source: learned');
  });

  it('mentions all four input types', () => {
    expect(LEARN_SKILL_SYSTEM_PROMPT).toContain('read_file');
    expect(LEARN_SKILL_SYSTEM_PROMPT).toContain('web_fetch');
    expect(LEARN_SKILL_SYSTEM_PROMPT).toContain('conversation history');
    expect(LEARN_SKILL_SYSTEM_PROMPT).toContain('task prompt');
  });
});

describe('buildLearnSkillPrompt', () => {
  it('includes the raw input', () => {
    const prompt = buildLearnSkillPrompt(
      'https://docs.example.com/api',
      '/tmp/project',
    );
    expect(prompt).toContain('https://docs.example.com/api');
  });

  it('includes the learned-skill- prefix', () => {
    const prompt = buildLearnSkillPrompt('some text', '/tmp/project');
    expect(prompt).toContain(LEARNED_SKILL_DIR_PREFIX);
  });

  it('includes source: learned in the template', () => {
    const prompt = buildLearnSkillPrompt('some text', '/tmp/project');
    expect(prompt).toContain('source: learned');
  });

  it('includes the project skills directory path', () => {
    const prompt = buildLearnSkillPrompt('some text', '/tmp/project');
    expect(prompt).toContain('/tmp/project/.qwen/skills');
  });
});
