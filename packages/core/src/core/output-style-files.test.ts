/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  findOutputStyle,
  loadOutputStyleCatalog,
  loadOutputStylesFromDir,
  parseOutputStyleFile,
} from './output-style-files.js';
import { BUILT_IN_OUTPUT_STYLES } from './output-styles.js';

let fakeHome: string;
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => fakeHome };
});

describe('parseOutputStyleFile', () => {
  it('reads name, description and keep-coding-instructions from frontmatter', () => {
    const style = parseOutputStyleFile(
      [
        '---',
        'name: Reviewer',
        'description: Reviews code without editing it',
        'keep-coding-instructions: true',
        '---',
        '',
        'Review the code; do not edit.',
      ].join('\n'),
      '/styles/reviewer.md',
      'user',
    );
    expect(style).toEqual({
      name: 'Reviewer',
      source: 'user',
      description: 'Reviews code without editing it',
      keepCodingInstructions: true,
      prompt: 'Review the code; do not edit.',
    });
  });

  it('defaults the name to the file name and the description to the first line', () => {
    const style = parseOutputStyleFile(
      '# Terse mode\n\nAnswer in **one** line.\n',
      '/styles/terse.md',
      'project',
    );
    expect(style.name).toBe('terse');
    expect(style.description).toBe('Terse mode');
    expect(style.keepCodingInstructions).toBe(false);
    expect(style.prompt).toBe('# Terse mode\n\nAnswer in **one** line.');
  });

  it('accepts a file without frontmatter and CRLF line endings', () => {
    const style = parseOutputStyleFile(
      '\uFEFFBe brief.\r\nAlways.\r\n',
      '/styles/brief.md',
      'user',
    );
    expect(style.prompt).toBe('Be brief.\nAlways.');
    expect(style.description).toBe('Be brief.');
  });

  it('treats a non-boolean keep-coding-instructions as false', () => {
    const style = parseOutputStyleFile(
      '---\nkeep-coding-instructions: yes please\n---\nBody',
      '/styles/x.md',
      'user',
    );
    expect(style.keepCodingInstructions).toBe(false);
  });

  it('falls back to a generic description when the body has no prose line', () => {
    const style = parseOutputStyleFile(
      '```\ncode only\n```',
      '/styles/code.md',
      'user',
    );
    expect(style.description).toBe('Custom code output style');
  });

  // The description is rendered straight into a picker row, so it gets the
  // same treatment the sibling `name` field already gets. An OSC-8 hyperlink
  // can make a row link somewhere it does not say, and U+202E reorders the
  // row so the `(project)` marker reads as something else.
  it.each([
    ['a declared description', 'description: "%s"', ''],
    ['a derived description', '', '%s'],
  ])('strips escape and format characters from %s', (_label, fm, body) => {
    const payload =
      'Safe \u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007 \u202Etxet';
    const content =
      fm === ''
        ? body.replace('%s', payload)
        : `---\nname: Styled\n${fm.replace('%s', payload)}\n---\nBody`;
    const style = parseOutputStyleFile(content, '/styles/x.md', 'user');

    expect(style.description).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(style.description).not.toContain('evil.example');
    expect([...style.description].length).toBeLessThanOrEqual(120);
  });

  it('caps a long declared description at the derived-description limit', () => {
    const style = parseOutputStyleFile(
      `---\nname: Styled\ndescription: "${'x'.repeat(5000)}"\n---\nBody`,
      '/styles/x.md',
      'user',
    );
    expect([...style.description].length).toBe(120);
  });

  it.each([
    ['an empty body', '---\nname: Empty\n---\n\n', 'no prompt body'],
    ['the reserved name default', '---\nname: Default\n---\nBody', 'reserved'],
    ['an empty name', '---\nname: "  "\n---\nBody', 'empty'],
    [
      'a name with control characters',
      '---\nname: "a\\u0007b"\n---\nBody',
      'control',
    ],
    [
      'a name over 64 characters',
      `---\nname: ${'x'.repeat(65)}\n---\nBody`,
      'longer than 64',
    ],
  ])('rejects %s', (_label, content, message) => {
    expect(() => parseOutputStyleFile(content, '/styles/f.md', 'user')).toThrow(
      message,
    );
  });
});

describe('loadOutputStylesFromDir', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-output-styles-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns nothing for a missing directory', async () => {
    expect(
      await loadOutputStylesFromDir(path.join(dir, 'missing'), 'user', dir),
    ).toEqual([]);
  });

  it('loads *.md files in name order and skips everything else', async () => {
    await fs.writeFile(path.join(dir, 'b.md'), 'Style B');
    await fs.writeFile(path.join(dir, 'a.md'), 'Style A');
    await fs.writeFile(path.join(dir, 'notes.txt'), 'not a style');
    await fs.mkdir(path.join(dir, 'nested.md'));

    const styles = await loadOutputStylesFromDir(dir, 'user', dir);
    expect(styles.map((s) => s.name)).toEqual(['a', 'b']);
    expect(styles.every((s) => s.source === 'user')).toBe(true);
  });

  it('skips an invalid file without dropping its neighbours', async () => {
    await fs.writeFile(path.join(dir, 'bad.md'), '---\nname: default\n---\nx');
    await fs.writeFile(path.join(dir, 'good.md'), 'Good');

    const styles = await loadOutputStylesFromDir(dir, 'project', dir);
    expect(styles.map((s) => s.name)).toEqual(['good']);
  });

  it('keeps the first file when two files declare the same name', async () => {
    await fs.writeFile(path.join(dir, 'one.md'), '---\nname: Same\n---\nFirst');
    await fs.writeFile(
      path.join(dir, 'two.md'),
      '---\nname: same\n---\nSecond',
    );

    const styles = await loadOutputStylesFromDir(dir, 'user', dir);
    expect(styles).toHaveLength(1);
    expect(styles[0].prompt).toBe('First');
  });

  it('skips a file over the size limit', async () => {
    await fs.writeFile(path.join(dir, 'huge.md'), 'x'.repeat(1024 * 1024 + 1));
    await fs.writeFile(path.join(dir, 'small.md'), 'Small');

    const styles = await loadOutputStylesFromDir(dir, 'user', dir);
    expect(styles.map((s) => s.name)).toEqual(['small']);
  });

  // A style file's body goes into the system prompt verbatim, so a link that
  // names a file the repo author does not own is an exfiltration vector that
  // survives `git clone` and needs no user action.
  describe('links', () => {
    let outside: string;
    let secret: string;

    beforeEach(async () => {
      outside = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-outside-'));
      secret = path.join(outside, 'credentials');
      await fs.writeFile(secret, 'AWS_SECRET_ACCESS_KEY=hunter2');
    });

    afterEach(async () => {
      await fs.rm(outside, { recursive: true, force: true });
    });

    it('refuses a symlinked project style', async () => {
      await fs.symlink(secret, path.join(dir, 'notes.md'));
      await fs.writeFile(path.join(dir, 'ok.md'), 'Fine');

      const styles = await loadOutputStylesFromDir(dir, 'project', dir);
      expect(styles.map((s) => s.name)).toEqual(['ok']);
    });

    it('refuses a project symlink even when its target is in-workspace', async () => {
      // Confinement alone would wave this through: the target is inside the
      // project root. A repo can commit `notes.md -> .env` and read a
      // developer's own secrets out of their checkout.
      await fs.writeFile(path.join(dir, '.env'), 'API_KEY=hunter2');
      await fs.symlink(path.join(dir, '.env'), path.join(dir, 'notes.md'));

      const styles = await loadOutputStylesFromDir(dir, 'project', dir);
      expect(styles).toEqual([]);
    });

    it('follows a user symlink that stays inside the root', async () => {
      const inside = path.join(dir, 'dotfiles');
      await fs.mkdir(inside);
      await fs.writeFile(path.join(inside, 'x.md'), 'Dotfile style');
      await fs.symlink(path.join(inside, 'x.md'), path.join(dir, 'linked.md'));

      const styles = await loadOutputStylesFromDir(dir, 'user', dir);
      expect(styles.map((s) => s.name)).toEqual(['linked']);
      expect(styles[0].prompt).toBe('Dotfile style');
    });

    it('refuses a user symlink that escapes the root', async () => {
      await fs.symlink(secret, path.join(dir, 'notes.md'));

      const styles = await loadOutputStylesFromDir(dir, 'user', dir);
      expect(styles).toEqual([]);
    });

    it('refuses a hard link, which lstat sees as an ordinary file', async () => {
      await fs.link(secret, path.join(dir, 'notes.md'));

      expect(await loadOutputStylesFromDir(dir, 'project', dir)).toEqual([]);
      expect(await loadOutputStylesFromDir(dir, 'user', dir)).toEqual([]);
    });

    it('refuses a style reached through a symlinked ancestor', async () => {
      // A checked-in `.qwen -> /outside`: a final-component lstat sees a
      // plain file, so only the canonical path catches it.
      await fs.writeFile(path.join(outside, 'notes.md'), 'Outside style');
      const linkedDir = path.join(dir, 'styles');
      await fs.symlink(outside, linkedDir);

      const styles = await loadOutputStylesFromDir(linkedDir, 'project', dir);
      expect(styles).toEqual([]);
    });
  });
});

describe('loadOutputStyleCatalog', () => {
  let root: string;
  let projectRoot: string;
  let userDir: string;
  let projectDir: string;
  const originalQwenHome = process.env['QWEN_HOME'];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-style-catalog-'));
    fakeHome = path.join(root, 'home');
    projectRoot = path.join(root, 'project');
    process.env['QWEN_HOME'] = path.join(fakeHome, '.qwen');
    userDir = path.join(fakeHome, '.qwen', 'output-styles');
    projectDir = path.join(projectRoot, '.qwen', 'output-styles');
    await fs.mkdir(userDir, { recursive: true });
    await fs.mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    if (originalQwenHome === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = originalQwenHome;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  it('lists built-ins, then user, then project styles', async () => {
    await fs.writeFile(path.join(userDir, 'mine.md'), 'Mine');
    await fs.writeFile(path.join(projectDir, 'team.md'), 'Team');

    const catalog = await loadOutputStyleCatalog({ projectRoot });
    expect(catalog.map((s) => `${s.name}:${s.source}`)).toEqual([
      ...BUILT_IN_OUTPUT_STYLES.map((s) => `${s.name}:built-in`),
      'mine:user',
      'team:project',
    ]);
  });

  it('lets a project style shadow a user style and a built-in name', async () => {
    await fs.writeFile(path.join(userDir, 'shared.md'), 'User version');
    await fs.writeFile(path.join(projectDir, 'shared.md'), 'Project version');
    await fs.writeFile(
      path.join(projectDir, 'concise.md'),
      '---\nname: concise\n---\nProject concise',
    );

    const catalog = await loadOutputStyleCatalog({ projectRoot });
    const shared = catalog.filter((s) => s.name === 'shared');
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({
      source: 'project',
      prompt: 'Project version',
    });
    const concise = catalog.filter((s) => s.name.toLowerCase() === 'concise');
    expect(concise).toHaveLength(1);
    expect(concise[0].source).toBe('project');
    // The shadowed entries are gone entirely, not merely re-ordered.
    expect(catalog.filter((s) => s.prompt === 'User version')).toHaveLength(0);
  });

  it('omits project styles when no project root is given', async () => {
    await fs.writeFile(path.join(projectDir, 'team.md'), 'Team');

    const catalog = await loadOutputStyleCatalog();
    expect(catalog.some((s) => s.source === 'project')).toBe(false);
  });

  it('skips the project level when the project root is the home directory', async () => {
    await fs.mkdir(path.join(fakeHome, '.qwen', 'output-styles'), {
      recursive: true,
    });
    await fs.writeFile(path.join(userDir, 'mine.md'), 'Mine');

    const catalog = await loadOutputStyleCatalog({ projectRoot: fakeHome });
    expect(catalog.filter((s) => s.name === 'mine')).toHaveLength(1);
    expect(catalog.some((s) => s.source === 'project')).toBe(false);
  });

  it('returns only built-ins when there are no style files', async () => {
    const catalog = await loadOutputStyleCatalog({ projectRoot });
    expect(catalog).toEqual(BUILT_IN_OUTPUT_STYLES);
  });
});

describe('findOutputStyle', () => {
  it('matches case-insensitively and trims', () => {
    expect(findOutputStyle(BUILT_IN_OUTPUT_STYLES, '  concise ')?.name).toBe(
      'Concise',
    );
    expect(findOutputStyle(BUILT_IN_OUTPUT_STYLES, 'nope')).toBeUndefined();
  });
});
