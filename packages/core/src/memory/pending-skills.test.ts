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

  it('accept moves a staged dir back into skills root', async () => {
    const file = await makeSkill(root, 'beta');
    const [p] = await stageSkillDirs([file], root);
    await acceptPendingSkill(p);
    await expect(fs.access(p.finalManifestPath)).resolves.toBeUndefined();
    await expect(fs.access(p.stagedManifestPath)).rejects.toThrow();
  });

  it('accept is a no-op when the staged dir is already gone', async () => {
    const file = await makeSkill(root, 'delta');
    const [p] = await stageSkillDirs([file], root);
    await rejectPendingSkill(p); // remove the staged dir first
    await expect(acceptPendingSkill(p)).resolves.toBeUndefined();
    await expect(fs.access(p.finalManifestPath)).rejects.toThrow();
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
