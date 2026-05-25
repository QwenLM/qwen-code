/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the #4437 fix:
 *  - `write_file` to an existing path inside the project skills root is
 *    denied (was 'allow' before — silently clobbered the prior SKILL.md).
 *  - `edit` semantics for existing auto-skills are preserved.
 *  - `buildTaskPrompt` enumerates existing skill directory names so the
 *    agent picks a fresh name on the first attempt.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import {
  buildTaskPrompt,
  createSkillScopedAgentConfig,
  listExistingSkillDirNames,
} from './skillReviewAgentPlanner.js';
import { ToolNames } from '../tools/tool-names.js';
import { getProjectSkillsRoot } from '../skills/skill-paths.js';

function makeMinimalConfig(projectRoot: string): Config {
  return {
    getProjectRoot: () => projectRoot,
    getPermissionManager: () => undefined,
  } as unknown as Config;
}

/**
 * Build the scoped Config and return its non-null PermissionManager.
 * `createSkillScopedAgentConfig` always installs one, but Config's
 * declared `getPermissionManager(): PermissionManager | null` forces
 * tests to launder the null at the call site — this helper does it
 * once with an assertion that fires loudly if the contract ever breaks.
 */
function scopedPm(projectRoot: string) {
  const scoped = createSkillScopedAgentConfig(
    makeMinimalConfig(projectRoot),
    projectRoot,
  );
  const pm = scoped.getPermissionManager();
  if (!pm) {
    throw new Error(
      'createSkillScopedAgentConfig must install a PermissionManager',
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

describe('skillReviewAgentPlanner — write_file collision deny (#4437)', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-review-v2-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("denies write_file to an existing AUTO-skill path (the #4437 bug — was 'allow')", async () => {
    const filePath = await writeSkillFile(projectRoot, 'my-skill', AUTO_SKILL);
    const pm = scopedPm(projectRoot);

    const decision = await pm.evaluate({
      toolName: ToolNames.WRITE_FILE,
      filePath,
    });
    expect(decision).toBe('deny');
  });

  it('denies write_file to an existing USER-skill path (already worked — kept as regression guard)', async () => {
    const filePath = await writeSkillFile(projectRoot, 'my-skill', USER_SKILL);
    const pm = scopedPm(projectRoot);

    const decision = await pm.evaluate({
      toolName: ToolNames.WRITE_FILE,
      filePath,
    });
    expect(decision).toBe('deny');
  });

  it('allows write_file to a fresh path that does not yet exist', async () => {
    const fresh = path.join(
      projectRoot,
      '.qwen',
      'skills',
      'brand-new',
      'SKILL.md',
    );
    const pm = scopedPm(projectRoot);

    const decision = await pm.evaluate({
      toolName: ToolNames.WRITE_FILE,
      filePath: fresh,
    });
    expect(decision).toBe('allow');
  });

  it('still allows edit on an existing auto-skill (update path preserved)', async () => {
    const filePath = await writeSkillFile(projectRoot, 'my-skill', AUTO_SKILL);
    const pm = scopedPm(projectRoot);

    const decision = await pm.evaluate({
      toolName: ToolNames.EDIT,
      filePath,
    });
    expect(decision).toBe('allow');
  });

  it('still denies edit on a user skill (update path safety preserved)', async () => {
    const filePath = await writeSkillFile(projectRoot, 'my-skill', USER_SKILL);
    const pm = scopedPm(projectRoot);

    const decision = await pm.evaluate({
      toolName: ToolNames.EDIT,
      filePath,
    });
    expect(decision).toBe('deny');
  });

  it('write_file deny rule message points the agent at a fresh name', async () => {
    const filePath = await writeSkillFile(projectRoot, 'my-skill', AUTO_SKILL);
    const pm = scopedPm(projectRoot);

    const rule = pm.findMatchingDenyRule({
      toolName: ToolNames.WRITE_FILE,
      filePath,
    });
    expect(rule).toMatch(/<name>-2/);
    expect(rule).toMatch(/edit/);
  });
});

describe('listExistingSkillDirNames', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-list-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns sorted directory names that contain a SKILL.md', async () => {
    await writeSkillFile(projectRoot, 'zebra', AUTO_SKILL);
    await writeSkillFile(projectRoot, 'apple', AUTO_SKILL);
    expect(await listExistingSkillDirNames(projectRoot)).toEqual([
      'apple',
      'zebra',
    ]);
  });

  it('skips directories without SKILL.md so half-built dirs do not reserve names', async () => {
    await writeSkillFile(projectRoot, 'real', AUTO_SKILL);
    await fs.mkdir(path.join(projectRoot, '.qwen', 'skills', 'empty'), {
      recursive: true,
    });
    expect(await listExistingSkillDirNames(projectRoot)).toEqual(['real']);
  });

  it('returns [] when the skills directory does not exist', async () => {
    expect(await listExistingSkillDirNames(projectRoot)).toEqual([]);
  });
});

describe('buildTaskPrompt', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-prompt-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('lists existing skill names so the agent picks a non-colliding name', async () => {
    await writeSkillFile(projectRoot, 'alpha', AUTO_SKILL);
    await writeSkillFile(projectRoot, 'beta', AUTO_SKILL);
    const prompt = await buildTaskPrompt(
      getProjectSkillsRoot(projectRoot),
      projectRoot,
    );
    expect(prompt).toContain('alpha');
    expect(prompt).toContain('beta');
    expect(prompt).toMatch(/do NOT reuse/i);
  });

  it('falls back to a placeholder line when no skills exist yet', async () => {
    const prompt = await buildTaskPrompt(
      getProjectSkillsRoot(projectRoot),
      projectRoot,
    );
    expect(prompt).toMatch(/no skills exist yet/i);
  });
});
