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

// The loader's only report of a skipped file is a debug-log line, which the
// test setup otherwise silences -- so the "reported and skipped" contract is
// only observable through a spy on this namespace's logger.
const styleDebugLogger = vi.hoisted(() => ({
  isEnabled: () => true,
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../utils/debugLogger.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/debugLogger.js')>();
  return {
    ...actual,
    createDebugLogger: (namespace: string) =>
      namespace === 'OUTPUT_STYLE_FILES'
        ? styleDebugLogger
        : actual.createDebugLogger(namespace),
  };
});

type FileSource = Parameters<typeof parseOutputStyleFile>[2];
type Style = ReturnType<typeof parseOutputStyleFile>;

// parseOutputStyleFile with the most common file path and source.
const parse = (
  content: string,
  filePath = '/styles/x.md',
  source: FileSource = 'user',
) => parseOutputStyleFile(content, filePath, source);

// Writes each `files` entry (name → body), in order, into `dir`.
async function writeFiles(dir: string, files: Record<string, string | Buffer>) {
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), body);
  }
}

const names = (styles: Style[]) => styles.map((s) => s.name);
const labels = (styles: ReadonlyArray<{ name: string; source: string }>) =>
  styles.map((s) => `${s.name}:${s.source}`);

describe('parseOutputStyleFile', () => {
  it('reads name, description and keep-coding-instructions from frontmatter', () => {
    const style = parse(
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
    const style = parse(
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
    const style = parse('﻿Be brief.\r\nAlways.\r\n', '/styles/brief.md');
    expect(style.prompt).toBe('Be brief.\nAlways.');
    expect(style.description).toBe('Be brief.');
  });

  it('treats a non-boolean keep-coding-instructions as false and reports it', () => {
    styleDebugLogger.warn.mockClear();
    const style = parse('---\nkeep-coding-instructions: yes please\n---\nBody');
    expect(style.keepCodingInstructions).toBe(false);
    expect(styleDebugLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('yes please'),
    );
  });

  // The YAML parser falls back to a line-wise parser whenever any frontmatter
  // line is not valid YAML, and that fallback yields strings -- so `True`
  // arrives as `'True'` and must still mean true.
  it.each([
    ['a plain boolean', 'keep-coding-instructions: true'],
    ['a quoted spelling', 'keep-coding-instructions: "true"'],
    [
      'a capitalized spelling parsed as a string',
      'description: a: b\nkeep-coding-instructions: True',
    ],
  ])('reads keep-coding-instructions from %s', (_label, fm) => {
    const style = parse(`---\n${fm}\n---\nBody`);
    expect(style.keepCodingInstructions).toBe(true);
  });

  it('inherits keep-coding-instructions from the built-in it shadows', () => {
    const shadowing = parse('My own brevity wording.', '/styles/concise.md');
    expect(shadowing.keepCodingInstructions).toBe(true);

    const declared = parse(
      '---\nkeep-coding-instructions: false\n---\nMy own brevity wording.',
      '/styles/concise.md',
    );
    expect(declared.keepCodingInstructions).toBe(false);

    const unrelated = parse('Body', '/styles/reviewer.md');
    expect(unrelated.keepCodingInstructions).toBe(false);
  });

  it('trims a name derived from the file name so it stays selectable', () => {
    const style = parse('Body', '/dir/Reviewer .md');
    expect(style.name).toBe('Reviewer');
    expect(findOutputStyle([style], 'Reviewer')).toBe(style);
  });

  it('accepts a name at exactly the 64-character bound', () => {
    const name = 'x'.repeat(64);
    const style = parse(`---\nname: ${name}\n---\nBody`, '/styles/f.md');
    expect(style.name).toBe(name);
  });

  it('falls back to the file name when the frontmatter name is not a string', () => {
    const style = parse(
      '---\nname:\n  foo: bar\n---\nBody',
      '/styles/fallback.md',
    );
    expect(style.name).toBe('fallback');
  });

  it('strips HTML comments from the prompt and the derived description', () => {
    const style = parse('<!-- team note -->\nAnswer tersely.');
    expect(style.prompt).toBe('Answer tersely.');
    expect(style.description).toBe('Answer tersely.');
  });

  it.each([
    [
      'a fence with trailing whitespace',
      '--- \nname: Fenced\n--- \nBody text.',
    ],
    ['an empty fence pair', '---\n---\nBody text.'],
  ])('tolerates %s', (_label, content) => {
    const style = parse(content);
    expect(style.prompt).toBe('Body text.');
  });

  it.each([
    ['prose', '---\nAnswer as a haiku.\n---\nThree lines only.'],
    ['a heading', '---\n# Haiku mode\n---\nThree lines only.'],
  ])(
    'keeps a block of %s fenced by decorative rules in the prompt',
    (_label, content) => {
      const style = parse(content, '/styles/haiku.md');
      expect(style.prompt).toBe(content);
    },
  );

  it('reads frontmatter that carries a YAML comment', () => {
    const style = parse(
      '---\n# why this style exists\nname: Commented\n---\nBody',
    );
    expect(style.name).toBe('Commented');
    expect(style.prompt).toBe('Body');
  });

  it('caps a long derived description and strips its markdown markers', () => {
    const style = parse(`# **${'ab '.repeat(100)}**`);
    expect(style.description).toHaveLength(120);
    expect(style.description.endsWith('…')).toBe(true);
    expect(style.description.startsWith('ab ab')).toBe(true);
  });

  it('falls back to a generic description when the body has no prose line', () => {
    const style = parse('```\ncode only\n```', '/styles/code.md');
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
      'Safe \u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007 ‮txet';
    const content =
      fm === ''
        ? body.replace('%s', payload)
        : `---\nname: Styled\n${fm.replace('%s', payload)}\n---\nBody`;
    const style = parse(content);

    expect(style.description).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(style.description).not.toContain('evil.example');
    expect([...style.description].length).toBeLessThanOrEqual(120);
  });

  it('caps a long declared description at the derived-description limit', () => {
    const style = parse(
      `---\nname: Styled\ndescription: "${'x'.repeat(5000)}"\n---\nBody`,
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
    // U+200B is a format character, not a C0 control: it renders as nothing,
    // so `a<ZWSP>b` and `ab` are two indistinguishable picker rows.
    [
      'a name with format characters',
      '---\nname: "a\\u200Bb"\n---\nBody',
      'control',
    ],
    [
      'a name over 64 characters',
      `---\nname: ${'x'.repeat(65)}\n---\nBody`,
      'longer than 64',
    ],
  ])('rejects %s', (_label, content, message) => {
    expect(() => parse(content, '/styles/f.md')).toThrow(message);
  });
});

describe('loadOutputStylesFromDir', () => {
  let dir: string;

  // Loads `dir` as `source` confined to `dir`.
  const load = (source: FileSource = 'user') =>
    loadOutputStylesFromDir(dir, source, dir);

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
    await writeFiles(dir, {
      'b.md': 'Style B',
      'a.md': 'Style A',
      'notes.txt': 'not a style',
    });
    await fs.mkdir(path.join(dir, 'nested.md'));

    const styles = await load();
    expect(names(styles)).toEqual(['a', 'b']);
    expect(styles.every((s) => s.source === 'user')).toBe(true);
  });

  it('skips an invalid file without dropping its neighbours', async () => {
    await writeFiles(dir, {
      'bad.md': '---\nname: default\n---\nx',
      'good.md': 'Good',
    });

    expect(names(await load('project'))).toEqual(['good']);
  });

  it('keeps the first file when two files declare the same name', async () => {
    await writeFiles(dir, {
      'one.md': '---\nname: Same\n---\nFirst',
      'two.md': '---\nname: same\n---\nSecond',
    });

    const styles = await load();
    expect(styles).toHaveLength(1);
    expect(styles[0].prompt).toBe('First');
  });

  it('loads a file whose extension is uppercase', async () => {
    await writeFiles(dir, { 'Shouty.MD': 'Shouty' });

    expect(names(await load())).toEqual(['Shouty']);
  });

  it('skips a file over the size limit and keeps one at the bound', async () => {
    await writeFiles(dir, {
      'huge.md': 'x'.repeat(25_001),
      'atbound.md': 'x'.repeat(25_000),
    });

    expect(names(await load())).toEqual(['atbound']);
  });

  it('reports a skipped file through the debug logger', async () => {
    styleDebugLogger.warn.mockClear();
    await writeFiles(dir, { 'huge.md': 'x'.repeat(25_001) });

    await load();
    expect(styleDebugLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('huge.md'),
    );
  });

  // PowerShell's `>` and Notepad's UTF-16 save option write these; decoded as
  // UTF-8 the frontmatter is silently dropped and NUL-riddled mojibake becomes
  // the prompt.
  it('skips a UTF-16 file without dropping its UTF-8 neighbour', async () => {
    await writeFiles(dir, {
      'utf16.md': Buffer.from('---\nname: X\n---\nBe terse.', 'utf16le'),
      'utf8.md': 'Be terse.',
    });

    expect(names(await load())).toEqual(['utf8']);
  });

  it('skips a comment-only file without dropping its neighbour', async () => {
    await writeFiles(dir, {
      'template.md': '<!-- copy this file and uncomment to make a style -->',
      'real.md': 'Answer as a reviewer.',
    });

    expect(names(await load())).toEqual(['real']);
  });

  it('skips a file whose padded name is the reserved default', async () => {
    await writeFiles(dir, { ' default.md': 'Body', 'ok.md': 'Fine' });

    expect(names(await load())).toEqual(['ok']);
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
      await writeFiles(dir, { 'ok.md': 'Fine' });

      expect(names(await load('project'))).toEqual(['ok']);
    });

    it('refuses a project symlink even when its target is in-workspace', async () => {
      // Confinement alone would wave this through: the target is inside the
      // project root. A repo can commit `notes.md -> .env` and read a
      // developer's own secrets out of their checkout.
      await writeFiles(dir, { '.env': 'API_KEY=hunter2' });
      await fs.symlink(path.join(dir, '.env'), path.join(dir, 'notes.md'));

      expect(await load('project')).toEqual([]);
    });

    it('follows a user symlink that stays inside the root', async () => {
      const inside = path.join(dir, 'dotfiles');
      await fs.mkdir(inside);
      await writeFiles(inside, { 'x.md': 'Dotfile style' });
      await fs.symlink(path.join(inside, 'x.md'), path.join(dir, 'linked.md'));

      const styles = await load();
      expect(names(styles)).toEqual(['linked']);
      expect(styles[0].prompt).toBe('Dotfile style');
    });

    it('refuses a user symlink that escapes the root', async () => {
      await fs.symlink(secret, path.join(dir, 'notes.md'));

      expect(await load()).toEqual([]);
    });

    it('refuses a hard link, which lstat sees as an ordinary file', async () => {
      await fs.link(secret, path.join(dir, 'notes.md'));

      expect(await load('project')).toEqual([]);
      expect(await load('user')).toEqual([]);
    });

    it('refuses a style reached through a symlinked ancestor', async () => {
      // A checked-in `.qwen -> /outside`: a final-component lstat sees a
      // plain file, so only the canonical path catches it.
      await writeFiles(outside, { 'notes.md': 'Outside style' });
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

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-style-catalog-'));
    fakeHome = path.join(root, 'home');
    projectRoot = path.join(root, 'project');
    vi.stubEnv('QWEN_HOME', path.join(fakeHome, '.qwen')); // undone in afterEach
    userDir = path.join(fakeHome, '.qwen', 'output-styles');
    projectDir = path.join(projectRoot, '.qwen', 'output-styles');
    await fs.mkdir(userDir, { recursive: true });
    await fs.mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('lists built-ins, then user, then project styles', async () => {
    await writeFiles(userDir, { 'mine.md': 'Mine' });
    await writeFiles(projectDir, { 'team.md': 'Team' });

    const catalog = await loadOutputStyleCatalog({ projectRoot });
    expect(labels(catalog)).toEqual([
      ...BUILT_IN_OUTPUT_STYLES.map((s) => `${s.name}:built-in`),
      'mine:user',
      'team:project',
    ]);
  });

  it('lets a project style shadow a user style and a built-in name', async () => {
    await writeFiles(userDir, { 'shared.md': 'User version' });
    await writeFiles(projectDir, {
      'shared.md': 'Project version',
      'concise.md': '---\nname: concise\n---\nProject concise',
    });

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

  it('omits project styles when no project root is given, keeping user styles', async () => {
    await writeFiles(projectDir, { 'team.md': 'Team' });
    await writeFiles(userDir, { 'mine.md': 'Mine' });

    // Positive control: the same fixtures are discoverable when a root is
    // given, so the omission below is the trust gate and not a stray path.
    const withRoot = await loadOutputStyleCatalog({ projectRoot });
    expect(labels(withRoot)).toEqual(
      expect.arrayContaining(['team:project', 'mine:user']),
    );

    const catalog = await loadOutputStyleCatalog();
    expect(catalog.some((s) => s.name === 'team')).toBe(false);
    expect(labels(catalog).filter((l) => l === 'mine:user')).toHaveLength(1);
  });

  it('skips the project level when the project root is the home directory', async () => {
    await fs.mkdir(path.join(fakeHome, '.qwen', 'output-styles'), {
      recursive: true,
    });
    await writeFiles(userDir, { 'mine.md': 'Mine' });

    const catalog = await loadOutputStyleCatalog({ projectRoot: fakeHome });
    expect(catalog.filter((s) => s.name === 'mine')).toHaveLength(1);
    expect(catalog.some((s) => s.source === 'project')).toBe(false);
  });

  // The user level resolves through QWEN_HOME, so the guard that dedupes it
  // against the project level has to compare the directories actually read.
  it('reads the user level from a relocated QWEN_HOME', async () => {
    const relocated = path.join(root, 'elsewhere', '.qwen');
    vi.stubEnv('QWEN_HOME', relocated);
    await fs.mkdir(path.join(relocated, 'output-styles'), { recursive: true });
    await writeFiles(path.join(relocated, 'output-styles'), {
      'qwenhome.md': 'Relocated',
    });

    const catalog = await loadOutputStyleCatalog({ projectRoot });
    expect(labels(catalog)).toContain('qwenhome:user');
  });

  it('keeps the project level when QWEN_HOME points away from the home directory', async () => {
    vi.stubEnv('QWEN_HOME', path.join(root, 'elsewhere', '.qwen'));
    await writeFiles(userDir, { 'homestyle.md': 'Home' });

    const catalog = await loadOutputStyleCatalog({ projectRoot: fakeHome });
    expect(labels(catalog)).toContain('homestyle:project');
  });

  it('does not relabel user styles when QWEN_HOME is the project .qwen', async () => {
    vi.stubEnv('QWEN_HOME', path.join(projectRoot, '.qwen'));
    await writeFiles(projectDir, { 'mine.md': 'Mine' });

    const catalog = await loadOutputStyleCatalog({ projectRoot });
    const mine = catalog.filter((s) => s.name === 'mine');
    expect(mine).toHaveLength(1);
    expect(mine[0].source).toBe('user');
  });

  it('inherits keep-coding-instructions from a shadowed built-in', async () => {
    await writeFiles(userDir, { 'concise.md': 'My own wording.' });
    await writeFiles(projectDir, {
      'explanatory.md':
        '---\nkeep-coding-instructions: false\n---\nMy own wording.',
    });

    const catalog = await loadOutputStyleCatalog({ projectRoot });
    const concise = catalog.find((s) => s.name.toLowerCase() === 'concise');
    expect(concise).toMatchObject({
      source: 'user',
      keepCodingInstructions: true,
    });
    const explanatory = catalog.find(
      (s) => s.name.toLowerCase() === 'explanatory',
    );
    expect(explanatory).toMatchObject({
      source: 'project',
      keepCodingInstructions: false,
    });
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
