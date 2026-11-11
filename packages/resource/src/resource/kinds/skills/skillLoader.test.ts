/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  drainSkillLoadErrors,
  loadSkillFromFile,
  loadSkillsFromCommandsDir,
  loadSkillsFromDir,
  parseFrontmatter,
  resolveSkillDir,
} from './skillLoader.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-skills-test-'));
  drainSkillLoadErrors();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('skillLoader', () => {
  it('parses extended frontmatter fields', () => {
    const parsed = parseFrontmatter(`name: Display\ndescription: Do work\nallowed-tools: Read, Grep\nwhen-to-use: when needed\nargument-hint: <file>\narguments:\n  - name: file\n    description: target file\n    required: true\ndisable-model-invocation: true\nuser-invocable: false\neffort: high\ncontext: fork\nagent: general-purpose\nhooks:\n  PreToolUse: []\npaths:\n  - src/*.{ts,tsx}\nshell: powershell`);

    expect(parsed).toMatchObject({
      name: 'Display',
      description: 'Do work',
      allowedTools: ['Read', 'Grep'],
      whenToUse: 'when needed',
      argumentHint: '<file>',
      arguments: [
        { name: 'file', description: 'target file', required: true },
      ],
      disableModelInvocation: true,
      userInvocable: false,
      effort: 'high',
      context: 'fork',
      agent: 'general-purpose',
      paths: ['src/*.ts', 'src/*.tsx'],
      shell: 'powershell',
    });
  });

  it('loads skills from nested skill packages and ignores root SKILL.md', async () => {
    await fs.writeFile(path.join(tmpDir, 'SKILL.md'), '# root');
    await fs.mkdir(path.join(tmpDir, 'category', 'alpha'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'category', 'alpha', 'SKILL.md'),
      '---\nname: Alpha Display\ndescription: Alpha desc\n---\nAlpha body',
    );

    const skills = await loadSkillsFromDir(tmpDir);

    expect(skills.map((skill) => skill.name)).toEqual(['alpha']);
    expect(skills[0]?.displayName).toBe('Alpha Display');
    expect(drainSkillLoadErrors().some((error) => error.severity === 'warning'))
      .toBe(true);
  });

  it('loads a direct skill when explicitly allowed', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'SKILL.md'),
      '---\ndescription: Direct desc\n---\nDirect body',
    );

    const skills = await loadSkillsFromDir(tmpDir, { allowDirectSkill: true });

    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe(path.basename(tmpDir));
  });

  it('loads command markdown files with namespaced identities', async () => {
    await fs.mkdir(path.join(tmpDir, 'ops', 'deploy'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'ops', 'deploy', 'SKILL.md'),
      '---\ndescription: Deploy\n---\nDeploy body',
    );
    await fs.writeFile(
      path.join(tmpDir, 'ops', 'restart.md'),
      '---\ndescription: Restart\n---\nRestart body',
    );

    const skills = await loadSkillsFromCommandsDir(tmpDir);

    expect(skills.map((skill) => skill.name).sort()).toEqual([
      'ops:deploy',
      'ops:restart',
    ]);
  });

  it('resolves skill directories for builtin, plugin commands, and files', async () => {
    const skillFile = path.join(tmpDir, 'skill', 'SKILL.md');
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.writeFile(skillFile, 'body');
    const loaded = await loadSkillFromFile(skillFile);

    expect(loaded).not.toBeNull();
    expect(resolveSkillDir(loaded!)).toBe(path.dirname(skillFile));
    expect(resolveSkillDir({ ...loaded!, isBuiltin: true })).toBe(process.cwd());
    expect(
      resolveSkillDir({
        ...loaded!,
        kind: 'plugin-command',
        pluginPath: '/plugin/root',
      }),
    ).toBe('/plugin/root');
  });
});
