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
  failReaddirOf: undefined as string | undefined,
  failStatOf: undefined as string | undefined,
}));
const emfileError = (): Error =>
  Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      if (
        emfileProbe.failStatOf !== undefined &&
        String(args[0]).includes(emfileProbe.failStatOf)
      ) {
        throw emfileError();
      }
      return actual.statSync(...args);
    },
    promises: {
      ...actual.promises,
      readdir: async (...args: Parameters<typeof actual.promises.readdir>) => {
        if (
          emfileProbe.failReaddirOf !== undefined &&
          String(args[0]).includes(emfileProbe.failReaddirOf)
        ) {
          throw emfileError();
        }
        return actual.promises.readdir(...args);
      },
      readFile: async (
        ...args: Parameters<typeof actual.promises.readFile>
      ) => {
        if (
          emfileProbe.failReadOf !== undefined &&
          String(args[0]).includes(emfileProbe.failReadOf)
        ) {
          throw emfileError();
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

  it('rejects the whole load when only some skill reads hit resource exhaustion', async () => {
    // The production case is one fd-exhausted read among many successful
    // ones: a survivor-tolerant loader (rethrow only when NOTHING loaded)
    // would commit the truncated set and pass an all-fail fixture green.
    writeSkill(
      'first',
      '---\nname: first\ndescription: First skill\n---\nDo work.',
    );
    writeSkill(
      'second',
      '---\nname: second\ndescription: Second skill\n---\nDo work.',
    );
    emfileProbe.failReadOf = 'second';
    try {
      await expect(loadAgentPluginSkills(pluginRoot)).rejects.toThrow('EMFILE');
    } finally {
      emfileProbe.failReadOf = undefined;
    }
  });

  it('rejects the whole load when the skills directory listing hits resource exhaustion', async () => {
    // A readdir needs a descriptor too, so under a low RLIMIT_NOFILE it is a
    // likelier exhaustion point than the per-file reads; it must fail closed
    // rather than silently disable every skill in the plugin.
    writeSkill(
      'direct',
      '---\nname: direct\ndescription: Direct skill\n---\nDo work.',
    );
    emfileProbe.failReaddirOf = `${path.sep}skills`;
    try {
      await expect(loadAgentPluginSkills(pluginRoot)).rejects.toThrow('EMFILE');
    } finally {
      emfileProbe.failReaddirOf = undefined;
    }
  });

  it('rejects the whole load when the skills directory stat hits resource exhaustion', async () => {
    writeSkill(
      'direct',
      '---\nname: direct\ndescription: Direct skill\n---\nDo work.',
    );
    emfileProbe.failStatOf = `${path.sep}skills`;
    try {
      await expect(loadAgentPluginSkills(pluginRoot)).rejects.toThrow('EMFILE');
    } finally {
      emfileProbe.failStatOf = undefined;
    }
  });
});
