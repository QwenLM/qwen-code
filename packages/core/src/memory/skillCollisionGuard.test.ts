/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the auto-skill collision guard (issue #4437).
 *
 * These cover the pure functions in `skillCollisionGuard.ts`. The wrapping
 * tool (`SkillCollisionAwareWriteFileTool`) is exercised end-to-end in
 * `skillCollisionAwareWriteFile.test.ts`.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findNextAvailableSkillPath,
  isSkillMdPath,
  listExistingProjectSkillNames,
  resolveSkillCollision,
} from './skillCollisionGuard.js';

async function writeSkill(
  projectRoot: string,
  skillName: string,
  body = 'placeholder\n',
): Promise<string> {
  const skillDir = path.join(projectRoot, '.qwen', 'skills', skillName);
  await fs.mkdir(skillDir, { recursive: true });
  const filePath = path.join(skillDir, 'SKILL.md');
  await fs.writeFile(filePath, body, 'utf-8');
  return filePath;
}

describe('skillCollisionGuard', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-collision-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('isSkillMdPath', () => {
    it('returns true for <root>/.qwen/skills/<name>/SKILL.md', () => {
      const target = path.join(
        projectRoot,
        '.qwen',
        'skills',
        'foo',
        'SKILL.md',
      );
      expect(isSkillMdPath(target, projectRoot)).toBe(true);
    });

    it('returns false for nested files under the skill directory', () => {
      // Auxiliary files (attachments / references) flow through unchanged.
      const target = path.join(
        projectRoot,
        '.qwen',
        'skills',
        'foo',
        'sub',
        'note.md',
      );
      expect(isSkillMdPath(target, projectRoot)).toBe(false);
    });

    it('returns false for files outside the skills root', () => {
      const target = path.join(projectRoot, 'README.md');
      expect(isSkillMdPath(target, projectRoot)).toBe(false);
    });

    it('returns false for SKILL.md at the skills root itself', () => {
      const target = path.join(projectRoot, '.qwen', 'skills', 'SKILL.md');
      expect(isSkillMdPath(target, projectRoot)).toBe(false);
    });
  });

  describe('findNextAvailableSkillPath', () => {
    it('returns <name>-2 when <name> exists', async () => {
      const original = await writeSkill(projectRoot, 'foo');
      const next = await findNextAvailableSkillPath(original);
      expect(next).toBe(
        path.join(projectRoot, '.qwen', 'skills', 'foo-2', 'SKILL.md'),
      );
    });

    it('skips already-claimed numeric suffixes', async () => {
      await writeSkill(projectRoot, 'foo');
      await writeSkill(projectRoot, 'foo-2');
      await writeSkill(projectRoot, 'foo-3');
      const next = await findNextAvailableSkillPath(
        path.join(projectRoot, '.qwen', 'skills', 'foo', 'SKILL.md'),
      );
      expect(next).toBe(
        path.join(projectRoot, '.qwen', 'skills', 'foo-4', 'SKILL.md'),
      );
    });
  });

  describe('resolveSkillCollision', () => {
    it("'rename' on a non-existing path returns the original path unchanged", async () => {
      const target = path.join(
        projectRoot,
        '.qwen',
        'skills',
        'fresh-skill',
        'SKILL.md',
      );
      const r = await resolveSkillCollision(target, 'rename', projectRoot);
      expect(r.action).toBe('write');
      expect(r.filePath).toBe(target);
      if (r.action === 'write') {
        expect(r.renamedFrom).toBeUndefined();
      }
    });

    it("'rename' on an existing AUTO-skill redirects to <name>-2", async () => {
      const original = await writeSkill(
        projectRoot,
        'my-skill',
        '---\nname: my-skill\nsource: auto-skill\n---\nbody\n',
      );
      const r = await resolveSkillCollision(original, 'rename', projectRoot);
      expect(r.action).toBe('write');
      expect(r.filePath).toBe(
        path.join(projectRoot, '.qwen', 'skills', 'my-skill-2', 'SKILL.md'),
      );
      if (r.action === 'write') {
        expect(r.renamedFrom).toBe(original);
      }
    });

    it("'rename' on an existing USER-skill (no source marker) also redirects — guard does not depend on frontmatter", async () => {
      // This is the failure mode the reporter cared about most: a user
      // skill silently clobbered. The wrapper applies the rename
      // regardless of `source:` so user work is preserved.
      const original = await writeSkill(
        projectRoot,
        'user-authored',
        '---\nname: user-authored\ndescription: hand-written\n---\nhuman body\n',
      );
      const r = await resolveSkillCollision(original, 'rename', projectRoot);
      expect(r.action).toBe('write');
      expect(r.filePath).toBe(
        path.join(
          projectRoot,
          '.qwen',
          'skills',
          'user-authored-2',
          'SKILL.md',
        ),
      );
    });

    it("'skip' on an existing skill returns action:'skip' with a reason", async () => {
      const original = await writeSkill(projectRoot, 'my-skill');
      const r = await resolveSkillCollision(original, 'skip', projectRoot);
      expect(r.action).toBe('skip');
      if (r.action === 'skip') {
        expect(r.reason).toMatch(/already exists/);
      }
    });

    it("'overwrite' returns the original path even when the skill exists (legacy behaviour)", async () => {
      const original = await writeSkill(projectRoot, 'my-skill');
      const r = await resolveSkillCollision(original, 'overwrite', projectRoot);
      expect(r.action).toBe('write');
      expect(r.filePath).toBe(original);
      if (r.action === 'write') {
        expect(r.renamedFrom).toBeUndefined();
      }
    });

    it('passes through writes to non-SKILL.md paths under the skills root', async () => {
      // The guard only governs the primary SKILL.md slot; helper files
      // (e.g. a README inside a skill folder) are not its concern.
      await writeSkill(projectRoot, 'foo');
      const helper = path.join(
        projectRoot,
        '.qwen',
        'skills',
        'foo',
        'NOTES.md',
      );
      await fs.writeFile(helper, 'helper', 'utf-8');
      const r = await resolveSkillCollision(helper, 'rename', projectRoot);
      expect(r.action).toBe('write');
      expect(r.filePath).toBe(helper);
    });
  });

  describe('listExistingProjectSkillNames', () => {
    it('returns an empty array when the skills root does not exist', async () => {
      const names = await listExistingProjectSkillNames(projectRoot);
      expect(names).toEqual([]);
    });

    it('lists directories that contain a SKILL.md, sorted alphabetically', async () => {
      await writeSkill(projectRoot, 'zebra');
      await writeSkill(projectRoot, 'apple');
      await writeSkill(projectRoot, 'banana');
      const names = await listExistingProjectSkillNames(projectRoot);
      expect(names).toEqual(['apple', 'banana', 'zebra']);
    });

    it('excludes directories that do not contain a SKILL.md', async () => {
      await writeSkill(projectRoot, 'real');
      await fs.mkdir(path.join(projectRoot, '.qwen', 'skills', 'empty'), {
        recursive: true,
      });
      const names = await listExistingProjectSkillNames(projectRoot);
      expect(names).toEqual(['real']);
    });
  });
});
