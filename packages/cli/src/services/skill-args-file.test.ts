/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, relative, resolve } from 'node:path';
import {
  skillArgsPath,
  writeSkillArgs,
  clearSkillArgs,
} from './skill-args-file.js';

let dir: string;
let cwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skill-args-'));
  cwd = process.cwd();
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

describe('writeSkillArgs', () => {
  it('writes the argument string byte for byte', () => {
    // No trimming, no trailing newline, no quoting. A parser reading the file
    // gets exactly what the user typed — including the whitespace, because
    // `--effort  high` and `--effort high` are the parser's business, not ours.
    const path = writeSkillArgs('review', '6771 --comment --effort high')!;
    expect(readFileSync(path, 'utf8')).toBe('6771 --comment --effort high');
  });

  it('keeps a value that would be mangled by a shell', () => {
    // The whole reason the arguments travel by file rather than as a shell
    // argument: `$(...)`, quotes and newlines survive intact.
    const nasty = '"$(rm -rf /)" \'quoted\'\nsecond line';
    const path = writeSkillArgs('review', nasty)!;
    expect(readFileSync(path, 'utf8')).toBe(nasty);
  });

  it('never lets a skill name escape the temp directory', () => {
    // The name becomes a filename. A skill called `../../etc/passwd` must not be
    // able to choose where the CLI writes — the path is derived from data the
    // skill controls, and that is the whole definition of a traversal.
    const path = skillArgsPath('../../etc/passwd');

    // The property is not "the string has no dots" — the sanitised name is
    // `.._.._etc_passwd`, and those dots are harmless once the separators are
    // gone. The property is that the *resolved* path is still inside the temp
    // directory, which is what a traversal would break.
    const inside = resolve('.qwen', 'tmp');
    const rel = relative(inside, resolve(path));
    expect(rel.startsWith('..')).toBe(false);
    expect(isAbsolute(rel)).toBe(false);

    const written = writeSkillArgs('../../etc/passwd', 'x')!;
    expect(existsSync(written)).toBe(true);
    // (Resolving two levels up from the
    // fixture would reach the real filesystem root, so assert on the fixture's
    // own tree — the traversal, had it worked, would have created these.)
    expect(existsSync(join(dir, 'etc'))).toBe(false);
    expect(existsSync(join(dir, '.qwen', 'etc'))).toBe(false);
  });

  it('scopes the path to the session, and derives the same path both sides', () => {
    // The record must be tied to the run that wrote it, not to a predictable
    // per-skill name any file could sit at. The session id — which the model
    // cannot choose or see — is the key, and it is read from the environment on
    // both the write and read sides.
    const prev = process.env['QWEN_CODE_SESSION_ID'];
    process.env['QWEN_CODE_SESSION_ID'] = 'abc-123';
    try {
      const p1 = skillArgsPath('review');
      expect(p1).toContain('abc-123');
      expect(p1).toContain('review');
      // A different session is a different file.
      process.env['QWEN_CODE_SESSION_ID'] = 'xyz-789';
      expect(skillArgsPath('review')).not.toBe(p1);
    } finally {
      if (prev === undefined) delete process.env['QWEN_CODE_SESSION_ID'];
      else process.env['QWEN_CODE_SESSION_ID'] = prev;
    }
  });

  it('refuses to write through a symlink planted at its path', () => {
    // A reproduction overwrote an arbitrary user-writable victim this way.
    // O_NOFOLLOW turns the planted link into an error, not a write through it.
    const target = join(dir, 'victim.txt');
    writeFileSync(target, 'precious');
    const linkPath = skillArgsPath('review');
    mkdirSync(join(dir, '.qwen', 'tmp'), { recursive: true });
    symlinkSync(target, linkPath);

    expect(writeSkillArgs('review', 'attacker')).toBeNull();
    expect(readFileSync(target, 'utf8')).toBe('precious'); // untouched
  });

  it('writes the file mode 0600 — arguments can carry a secret', () => {
    if (process.platform === 'win32') return;
    writeSkillArgs('review', 'TOKEN=sk-secret');
    const mode = statSync(skillArgsPath('review')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('writes a large argument string completely (no short write)', () => {
    // `writeSync` may write fewer bytes than asked and return the count; a
    // truncated record would lose `--comment` or mis-target the review. A big
    // value forces more than one syscall's worth.
    const big = 'x'.repeat(500_000) + ' --comment';
    writeSkillArgs('review', big);
    expect(readFileSync(skillArgsPath('review'), 'utf8')).toBe(big);
  });

  it('clears a prior record on a bare invocation', () => {
    // `/review 6771 --comment` then a bare `/review` in the same session: the
    // second must not inherit the first's posting authority.
    writeSkillArgs('review', '6771 --comment');
    expect(existsSync(skillArgsPath('review'))).toBe(true);
    clearSkillArgs('review');
    expect(existsSync(skillArgsPath('review'))).toBe(false);
  });

  it('puts the session scope in the directory, keeping the filename stable', () => {
    // The filename the skill prompt and cleanup reference must not move with the
    // session; the directory carries the scope.
    const prev = process.env['QWEN_CODE_SESSION_ID'];
    process.env['QWEN_CODE_SESSION_ID'] = 'sess-A';
    try {
      const p = skillArgsPath('review');
      expect(p).toContain('s-sess-A');
      expect(p.endsWith('qwen-skill-args-review.txt')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env['QWEN_CODE_SESSION_ID'];
      else process.env['QWEN_CODE_SESSION_ID'] = prev;
    }
  });

  it('gives each skill its own file', () => {
    writeSkillArgs('review', '6771');
    writeSkillArgs('verify', 'other');
    expect(readFileSync(skillArgsPath('review'), 'utf8')).toBe('6771');
    expect(readFileSync(skillArgsPath('verify'), 'utf8')).toBe('other');
  });

  it('returns null instead of throwing when the write fails', () => {
    // A read-only checkout must not stop a skill from running: it degrades to
    // the model reading the arguments out of the conversation, which is worse
    // but not broken. The target path is a *directory* here, so the write
    // fails with EISDIR.
    mkdirSync(skillArgsPath('review'), { recursive: true });

    expect(writeSkillArgs('review', '6771')).toBeNull();
  });
});
