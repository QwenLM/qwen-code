/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadForkProfile, validateForkProfileName } from './fork-profile.js';

describe('fork profiles', () => {
  const tempDirs: string[] = [];

  async function createProject(): Promise<string> {
    const projectRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-fork-profile-'),
    );
    tempDirs.push(projectRoot);
    return projectRoot;
  }

  async function writeProfile(
    projectRoot: string,
    name: string,
    content: string,
  ): Promise<void> {
    const profileDir = path.join(projectRoot, '.qwen', 'fork-profiles');
    await fs.mkdir(profileDir, { recursive: true });
    await fs.writeFile(path.join(profileDir, `${name}.md`), content, 'utf8');
  }

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) =>
        fs.rm(dir, {
          recursive: true,
          force: true,
        }),
      ),
    );
  });

  it('loads a valid project profile with an optional prompt hint', async () => {
    const projectRoot = await createProject();
    await writeProfile(
      projectRoot,
      'ro-research',
      '\uFEFF---\r\n' +
        'name: ro-research\r\n' +
        'tools:\r\n' +
        '  - read_file\r\n' +
        '  - mcp__github__read_*\r\n' +
        'promptHint: |\r\n' +
        '  Work read-only.\r\n' +
        '  Report file and line evidence.\r\n' +
        '---\r\n',
    );

    expect(loadForkProfile(projectRoot, 'ro-research')).toEqual({
      name: 'ro-research',
      tools: ['read_file', 'mcp__github__read_*'],
      promptHint: 'Work read-only.\nReport file and line evidence.',
    });
  });

  it('preserves an empty tools array as deny-all', async () => {
    const projectRoot = await createProject();
    await writeProfile(
      projectRoot,
      'no-tools',
      '---\nname: no-tools\ntools: []\n---\n',
    );

    expect(loadForkProfile(projectRoot, 'no-tools')).toEqual({
      name: 'no-tools',
      tools: [],
    });
  });

  it('loads flow-style YAML with the strict parser', async () => {
    const projectRoot = await createProject();
    await writeProfile(
      projectRoot,
      'ro-research',
      '---\nname: ro-research\ntools: [read_file, grep_search]\n---\n',
    );

    expect(loadForkProfile(projectRoot, 'ro-research')).toEqual({
      name: 'ro-research',
      tools: ['read_file', 'grep_search'],
    });
  });

  it.each(['ro-research', 'review_2', '研究-2'])(
    'accepts safe profile name %s',
    (name) => {
      expect(validateForkProfileName(name)).toBeUndefined();
    },
  );

  it.each([
    '',
    'a',
    ' ro',
    'ro ',
    '-ro',
    'ro-',
    '_ro',
    'ro_',
    '../secret',
    'read only',
    'x'.repeat(51),
  ])('rejects unsafe profile name %j', (name) => {
    expect(validateForkProfileName(name)).toBeDefined();
  });

  it('reports a missing profile with its resolved project path', async () => {
    const projectRoot = await createProject();

    expect(() => loadForkProfile(projectRoot, 'missing')).toThrowError(
      `Fork profile "missing" was not found at ${path.join(
        projectRoot,
        '.qwen',
        'fork-profiles',
        'missing.md',
      )}.`,
    );
  });

  it('rejects a profile symlink that escapes the profile directory', async () => {
    const projectRoot = await createProject();
    const profileDir = path.join(projectRoot, '.qwen', 'fork-profiles');
    const outsideProfile = path.join(projectRoot, 'outside.md');
    await fs.mkdir(profileDir, { recursive: true });
    await fs.writeFile(
      outsideProfile,
      '---\nname: ro-research\ntools: []\n---\n',
      'utf8',
    );
    await fs.symlink(
      outsideProfile,
      path.join(profileDir, 'ro-research.md'),
      process.platform === 'win32' ? 'file' : undefined,
    );

    expect(() => loadForkProfile(projectRoot, 'ro-research')).toThrow(
      /resolves outside .*fork-profiles/i,
    );
  });

  it('rejects a non-regular profile before reading it', async () => {
    const projectRoot = await createProject();
    await fs.mkdir(
      path.join(projectRoot, '.qwen', 'fork-profiles', 'ro-research.md'),
      { recursive: true },
    );

    expect(() => loadForkProfile(projectRoot, 'ro-research')).toThrow(
      /is not a regular file/i,
    );
  });

  it('rejects a profile larger than the byte cap', async () => {
    const projectRoot = await createProject();
    await writeProfile(projectRoot, 'ro-research', 'x'.repeat(64 * 1024 + 1));

    expect(() => loadForkProfile(projectRoot, 'ro-research')).toThrow(
      /file is larger than 65536 bytes/i,
    );
  });

  it('accepts a valid profile exactly at the byte cap', async () => {
    const projectRoot = await createProject();
    const prefix = '---\nname: ro-research\ntools: []\n';
    const suffix = '---\n';
    const commentLength = 64 * 1024 - prefix.length - suffix.length - 2;
    const content = `${prefix}#${'x'.repeat(commentLength)}\n${suffix}`;
    expect(Buffer.byteLength(content)).toBe(64 * 1024);
    await writeProfile(projectRoot, 'ro-research', content);

    expect(loadForkProfile(projectRoot, 'ro-research')).toEqual({
      name: 'ro-research',
      tools: [],
    });
  });

  it('requires frontmatter name to match the requested filename', async () => {
    const projectRoot = await createProject();
    await writeProfile(
      projectRoot,
      'ro-research',
      '---\nname: another-profile\ntools: []\n---\n',
    );

    expect(() => loadForkProfile(projectRoot, 'ro-research')).toThrow(
      /frontmatter name must exactly match the filename/i,
    );
  });

  it('rejects unresolved YAML aliases instead of falling back', async () => {
    const projectRoot = await createProject();
    await writeProfile(
      projectRoot,
      'ro-research',
      '---\n' +
        'name: ro-research\n' +
        'tools:\n' +
        '  - read_file\n' +
        'note: *missing\n' +
        '---\n',
    );

    expect(() => loadForkProfile(projectRoot, 'ro-research')).toThrow(
      /malformed YAML frontmatter/i,
    );
  });

  it('rejects YAML warnings instead of accepting unresolved tags', async () => {
    const projectRoot = await createProject();
    await writeProfile(
      projectRoot,
      'ro-research',
      '---\nname: ro-research\ntools: !unknown [read_file]\n---\n',
    );

    expect(() => loadForkProfile(projectRoot, 'ro-research')).toThrow(
      /malformed YAML frontmatter/i,
    );
  });

  it('rejects non-empty Markdown bodies with promptHint guidance', async () => {
    const projectRoot = await createProject();
    await writeProfile(
      projectRoot,
      'ro-research',
      '---\nname: ro-research\ntools: []\n---\nWork read-only.\n',
    );

    expect(() => loadForkProfile(projectRoot, 'ro-research')).toThrow(
      /Markdown body content.*promptHint/i,
    );
  });

  it('rejects prompt hints longer than 200 characters', async () => {
    const projectRoot = await createProject();
    await writeProfile(
      projectRoot,
      'ro-research',
      '---\n' +
        'name: ro-research\n' +
        'tools: []\n' +
        `promptHint: ${'x'.repeat(201)}\n` +
        '---\n',
    );

    expect(() => loadForkProfile(projectRoot, 'ro-research')).toThrow(
      /promptHint must not exceed 200 characters/i,
    );
  });

  it.each([
    {
      label: 'missing frontmatter',
      content: 'name: ro-research\ntools: []\n',
      error: /missing YAML frontmatter/i,
    },
    {
      label: 'malformed tools YAML',
      content: '---\nname: ro-research\ntools: [\n---\n',
      error: /malformed YAML frontmatter/i,
    },
    {
      label: 'duplicate YAML keys',
      content:
        '---\nname: ro-research\nname: another-profile\ntools: []\n---\n',
      error: /malformed YAML frontmatter/i,
    },
    {
      label: 'non-array tools',
      content: '---\nname: ro-research\ntools: read_file\n---\n',
      error: /tools must be an array/i,
    },
    {
      label: 'empty tool name',
      content: '---\nname: ro-research\ntools:\n  - " "\n---\n',
      error: /array of non-empty tool names without surrounding whitespace/i,
    },
    {
      label: 'bare wildcard',
      content: '---\nname: ro-research\ntools:\n  - "*"\n---\n',
      error: /does not accept "\*"/i,
    },
    {
      label: 'invalid wildcard shape',
      content: '---\nname: ro-research\ntools:\n  - read_*\n---\n',
      error: /wildcard entries/i,
    },
    {
      label: 'non-string prompt hint',
      content:
        '---\nname: ro-research\ntools:\n  - read_file\npromptHint: 123\n---\n',
      error: /promptHint must be a string/i,
    },
  ])('rejects $label', async ({ content, error }) => {
    const projectRoot = await createProject();
    await writeProfile(projectRoot, 'ro-research', content);

    expect(() => loadForkProfile(projectRoot, 'ro-research')).toThrow(error);
  });
});
