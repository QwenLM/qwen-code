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

// R3 pin: an EMFILE mid-scan must reject the whole load instead of resolving
// with the surviving skills. The failing path is toggled per-test; the real
// implementation is re-attached whenever the toggle is off. skills.ts reads
// through `fs.promises.readFile` (the `node:fs` namespace), so mock there.
const emfileProbe = vi.hoisted(() => ({
  failReadOf: undefined as string | undefined,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: async (
        ...args: Parameters<typeof actual.promises.readFile>
      ) => {
        if (
          emfileProbe.failReadOf !== undefined &&
          String(args[0]).includes(emfileProbe.failReadOf)
        ) {
          throw Object.assign(new Error('EMFILE: too many open files'), {
            code: 'EMFILE',
          });
        }
        return actual.promises.readFile(...args);
      },
    },
  };
});

describe('Agent Plugins v1 skills', () => {
  let pluginRoot: string;

  beforeEach(() => {
    pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-plugin-'));
  });

  afterEach(() => {
    fs.rmSync(pluginRoot, { recursive: true, force: true });
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

      expect(await loadAgentPluginSkills(pluginRoot)).toEqual([]);
      fs.rmSync(outside, { force: true });
    },
  );

  function writeSkill(name: string, content: string): void {
    const skillDir = path.join(pluginRoot, 'skills', name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);
  }

  it('rejects the whole load when a skill read hits resource exhaustion', async () => {
    // An EMFILE mid-scan must fail the refresh closed (rethrown), not resolve
    // with the surviving skills — a truncated set committed as successful
    // would stick until restart.
    writeSkill(
      'direct',
      '---\nname: direct\ndescription: Direct skill\n---\nDo work.',
    );
    emfileProbe.failReadOf = 'direct';
    try {
      await expect(loadAgentPluginSkills(pluginRoot)).rejects.toThrow('EMFILE');
    } finally {
      emfileProbe.failReadOf = undefined;
    }
  });
});
