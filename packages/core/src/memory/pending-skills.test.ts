/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  stageSkillDirs,
  acceptPendingSkill,
  rejectPendingSkill,
} from './pending-skills.js';
import { getPendingSkillsRoot } from '../skills/skill-paths.js';

async function makeSkill(root: string, name: string, body = 'hi') {
  const dir = path.join(root, '.qwen', 'skills', `auto-skill-${name}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: does ${name}\nsource: auto-skill\n---\n${body}\n`,
    'utf-8',
  );
  return path.join(dir, 'SKILL.md');
}

describe('pendingSkills', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pending-skills-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('moves auto-skill dirs out of skills root into pending root', async () => {
    const file = await makeSkill(root, 'alpha');
    const pending = await stageSkillDirs([file], root);
    expect(pending).toHaveLength(1);
    expect(pending[0].name).toBe('auto-skill-alpha');
    expect(pending[0].description).toBe('does alpha');
    await expect(fs.access(file)).rejects.toThrow();
    await expect(
      fs.access(pending[0].stagedManifestPath),
    ).resolves.toBeUndefined();
    expect(
      pending[0].stagedManifestPath.startsWith(getPendingSkillsRoot(root)),
    ).toBe(true);
  });

  it('does NOT stage a pre-existing skill the agent edited in place', async () => {
    const file = await makeSkill(root, 'epsilon');
    const pending = await stageSkillDirs(
      [file],
      root,
      new Set(['auto-skill-epsilon']),
    );
    expect(pending).toHaveLength(0);
    // The already-confirmed skill stays live in the skills root, untouched —
    // a later Discard can never delete it.
    await expect(fs.access(file)).resolves.toBeUndefined();
  });

  it('stages new skills while leaving pre-existing edited ones in place', async () => {
    const newFile = await makeSkill(root, 'new-one');
    const editedFile = await makeSkill(root, 'old-one');
    const pending = await stageSkillDirs(
      [newFile, editedFile],
      root,
      new Set(['auto-skill-old-one']),
    );
    expect(pending.map((p) => p.name)).toEqual(['auto-skill-new-one']);
    await expect(fs.access(editedFile)).resolves.toBeUndefined(); // stays live
    await expect(fs.access(newFile)).rejects.toThrow(); // moved to pending
  });

  it('parses an empty description as empty, not the next YAML line', async () => {
    const dir = path.join(root, '.qwen', 'skills', 'auto-skill-empty');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'SKILL.md'),
      '---\ndescription:\nsource: auto-skill\n---\nbody\n',
      'utf-8',
    );
    const pending = await stageSkillDirs([path.join(dir, 'SKILL.md')], root);
    expect(pending[0].description).toBe('');
  });

  it('strips surrounding quotes from a quoted description', async () => {
    const dir = path.join(root, '.qwen', 'skills', 'auto-skill-quoted');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'SKILL.md'),
      '---\ndescription: "A skill for X"\nsource: auto-skill\n---\nbody\n',
      'utf-8',
    );
    const pending = await stageSkillDirs([path.join(dir, 'SKILL.md')], root);
    expect(pending[0].description).toBe('A skill for X');
  });

  it('namespaces staged dirs by taskId so same-named batches do not collide', async () => {
    const fileA = await makeSkill(root, 'dup');
    const [pa] = await stageSkillDirs([fileA], root, new Set(), 'task-A');
    // A later run creates a same-named skill while the first is still deferred.
    const fileB = await makeSkill(root, 'dup');
    const [pb] = await stageSkillDirs([fileB], root, new Set(), 'task-B');
    expect(pa.stagedManifestPath).not.toBe(pb.stagedManifestPath);
    // Both staged copies survive — batch B did not clobber batch A.
    await expect(fs.access(pa.stagedManifestPath)).resolves.toBeUndefined();
    await expect(fs.access(pb.stagedManifestPath)).resolves.toBeUndefined();
  });

  it('accept moves a staged dir back into skills root', async () => {
    const file = await makeSkill(root, 'beta');
    const [p] = await stageSkillDirs([file], root);
    await acceptPendingSkill(p);
    await expect(fs.access(p.finalManifestPath)).resolves.toBeUndefined();
    await expect(fs.access(p.stagedManifestPath)).rejects.toThrow();
  });

  it('accept is a no-op when the skill is already in the skills root', async () => {
    const file = await makeSkill(root, 'delta');
    const [p] = await stageSkillDirs([file], root);
    await acceptPendingSkill(p); // promote it
    // Re-accepting (staged dir gone, but skill already live) is harmless.
    await expect(acceptPendingSkill(p)).resolves.toBeUndefined();
    await expect(fs.access(p.finalManifestPath)).resolves.toBeUndefined();
  });

  it('accept throws when staged dir is gone and skill is not in skills root', async () => {
    const file = await makeSkill(root, 'delta2');
    const [p] = await stageSkillDirs([file], root);
    await rejectPendingSkill(p); // staged dir removed, never promoted
    // Data-loss case: surface it instead of silently dropping the skill from
    // pendingSkills metadata.
    await expect(acceptPendingSkill(p)).rejects.toThrow();
  });

  it('reject deletes the staged dir and never touches skills root', async () => {
    const file = await makeSkill(root, 'gamma');
    const [p] = await stageSkillDirs([file], root);
    await rejectPendingSkill(p);
    await expect(fs.access(p.stagedManifestPath)).rejects.toThrow();
    await expect(fs.access(p.finalManifestPath)).rejects.toThrow();
  });

  it('ignores touched paths whose skill dir no longer exists (edited existing skill)', async () => {
    const pending = await stageSkillDirs(
      [path.join(root, '.qwen', 'skills', 'auto-skill-x', 'SKILL.md')],
      root,
    );
    expect(pending).toHaveLength(0);
  });
});
