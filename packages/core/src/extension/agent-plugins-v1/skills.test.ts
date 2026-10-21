/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAgentPluginSkills, parseAgentPluginSkill } from './skills.js';

describe('Agent Plugins v1 skills', () => {
  let pluginRoot: string;

  beforeEach(() => {
    pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-plugin-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(pluginRoot, { recursive: true, force: true });
    fs.rmSync(`${pluginRoot}-outside-skill.md`, { force: true });
  });

  it('loads only valid direct-child Agent Skills', async () => {
    writeSkill(
      'direct',
      '---\nname: direct\ndescription: Direct skill\nallowed-tools: Read Bash(git:*)\n---\nDo work.',
    );
    writeSkill(
      'bad-name',
      '---\nname: mismatch\ndescription: Invalid\n---\nNo.',
    );
    writeSkill(
      path.join('container', 'nested'),
      '---\nname: nested\ndescription: Nested\n---\nNo.',
    );

    const skills = await loadAgentPluginSkills(pluginRoot);

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: 'direct',
      description: 'Direct skill',
      body: 'Do work.',
      level: 'extension',
    });
    expect(skills[0]?.allowedTools).toBeUndefined();
  });

  it.each(['EACCES', 'ENOENT'] as const)(
    'reports directory %s without treating removal as an incomplete scan',
    async (code) => {
      writeSkill(
        'direct',
        '---\nname: direct\ndescription: Direct skill\n---\nBody.',
      );
      const error = Object.assign(new Error(code), { code });
      vi.spyOn(fs.promises, 'readdir').mockRejectedValueOnce(error);
      const onError = vi.fn();
      expect(await loadAgentPluginSkills(pluginRoot, onError)).toEqual([]);
      expect(onError).toHaveBeenCalledTimes(code === 'ENOENT' ? 0 : 1);
    },
  );

  it('reports a parse failure while keeping valid Agent Skills', async () => {
    writeSkill(
      'direct',
      '---\nname: direct\ndescription: Direct skill\n---\nBody.',
    );
    writeSkill('broken', 'invalid frontmatter');
    const onError = vi.fn();
    expect(
      (await loadAgentPluginSkills(pluginRoot, onError)).map(
        (skill) => skill.name,
      ),
    ).toEqual(['direct']);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('validates standard metadata fields', () => {
    const filePath = path.join(pluginRoot, 'skills', 'portable', 'SKILL.md');
    const valid =
      '---\nname: portable\ndescription: Portable skill\nlicense: Apache-2.0\ncompatibility: Qwen Code\nmetadata:\n  author: qwen\nallowed-tools: Read\n---\nBody';
    expect(parseAgentPluginSkill(valid, filePath)).toMatchObject({
      name: 'portable',
      description: 'Portable skill',
    });

    expect(() =>
      parseAgentPluginSkill(
        valid.replace('allowed-tools: Read', 'allowed-tools:\n  - Read'),
        filePath,
      ),
    ).toThrow('allowed-tools');
  });

  it.runIf(process.platform !== 'win32')(
    'skips a skill whose manifest resolves outside the plugin',
    async () => {
      const outside = `${pluginRoot}-outside-skill.md`;
      fs.writeFileSync(
        outside,
        '---\nname: escape\ndescription: Escape\n---\nNo.',
      );
      const skillDir = path.join(pluginRoot, 'skills', 'escape');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.symlinkSync(outside, path.join(skillDir, 'SKILL.md'));

      const onError = vi.fn();
      expect(await loadAgentPluginSkills(pluginRoot, onError)).toEqual([]);
      expect(onError).toHaveBeenCalledOnce();
      fs.rmSync(outside, { force: true });
    },
  );

  function writeSkill(name: string, content: string): void {
    const skillDir = path.join(pluginRoot, 'skills', name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);
  }
});
