/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import yargs from 'yargs';
import { parseAuditArgs, parseArgsCommand } from './parse-args.js';
import { auditCommand } from '../audit.js';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';

// The handler reads the raw string from fd 0 and writes the verdict to
// --out; both are intercepted so the wiring tests can run the real yargs
// command without a real terminal or filesystem.
const fsState = vi.hoisted(() => ({
  stdin: '',
  written: new Map<string, string>(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const mock = {
    ...real,
    readFileSync: vi.fn((path: unknown, ...rest: unknown[]) =>
      path === 0
        ? fsState.stdin
        : (real['readFileSync'] as (...a: unknown[]) => unknown)(path, ...rest),
    ),
    mkdirSync: vi.fn(),
  };
  return { ...mock, default: mock };
});

// The verdict write goes through the guarded writer (an fd-based open, so a
// planted symlink or FIFO at --out cannot redirect or hang it). Intercept it
// at that seam rather than at writeFileSync, and leave the module's reads
// real — files-plan resolves the fixture directory through them.
vi.mock('./lib/safe-read.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    writeFileGuarded: vi.fn((path: unknown, data: unknown) => {
      fsState.written.set(String(path), String(data));
    }),
  };
});

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
}));

describe('parseAuditArgs', () => {
  let dir: string;

  beforeEach(() => {
    // Realpath the fixture: resolveAuditRoot returns the realpath, and on
    // macOS os.tmpdir() sits behind the /var -> /private/var symlink. The
    // spaced, metacharacter-carrying prefix pins tokenizeArgs' literal
    // handling of the chars a shell would otherwise expand ($ and ; are
    // legal in Windows filenames too).
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'audit args $;')));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('preserves a quoted path with spaces and shell metacharacters', () => {
    // Single quotes, not JSON.stringify: JSON escaping doubles backslashes
    // that the shell-style tokenizer keeps verbatim, so a stringified
    // Windows path can never equal the single-backslash realpath.
    const parsed = parseAuditArgs(`'${dir}' --effort high`);
    expect(parsed).toEqual({
      targetPath: dir,
      targetPathAbsolute: dir,
      effort: 'high',
    });
  });

  it('defaults to medium and accepts the equals effort form', () => {
    expect(parseAuditArgs(`'${dir}'`).effort).toBe('medium');
    expect(parseAuditArgs(`'${dir}' --effort=LOW`).effort).toBe('low');
  });

  it('refuses an unclosed quote instead of silently re-targeting', () => {
    // An unclosed quote would swallow the rest of the string in the
    // tokenizer; an unquoted apostrophe would re-target the audit
    // (src/it's-dir -> src/its-dir).
    expect(() => parseAuditArgs(`src/it's-dir`)).toThrow(/unbalanced quote/);
    expect(() => parseAuditArgs(`'${dir} --effort low`)).toThrow(
      /unbalanced quote/,
    );
    // The nesting semantics: inside an open quote the other quote
    // character is literal content, so per-character parity is wrong in
    // both directions — this input LOOKS parity-balanced but ends inside
    // an unclosed single quote.
    expect(() => parseAuditArgs(`"a'"b'`)).toThrow(/unbalanced quote/);
  });

  it('accepts an apostrophe inside a double-quoted path', () => {
    // A balanced quoted path carrying the opposite quote character is
    // legal shell input; the old per-character parity refused it.
    const spaced = realpathSync(mkdtempSync(join(tmpdir(), "audit O'Brien ")));
    try {
      const parsed = parseAuditArgs(`"${spaced}"`);
      expect(parsed.targetPathAbsolute).toBe(spaced);
    } finally {
      rmSync(spaced, { recursive: true, force: true });
    }
  });

  it('rejects missing, extra, and ambiguous input', () => {
    expect(() => parseAuditArgs('')).toThrow(/exactly one directory/);
    expect(() => parseAuditArgs(`'${dir}' other`)).toThrow(
      /exactly one directory/,
    );
    expect(() => parseAuditArgs(`'${dir}' --unknown`)).toThrow(/unknown flag/);
    expect(() => parseAuditArgs(`'${dir}' --effort nope`)).toThrow(
      /must be low, medium, or high/,
    );
  });
});

describe('parseArgsCommand handler', () => {
  let dir: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'audit parse-args cmd ')));
    vi.mocked(writeStdoutLine).mockClear();
    fsState.written.clear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (argv: Record<string, unknown>) =>
    (parseArgsCommand.handler as (a: unknown) => void)({
      _: ['audit', 'parse-args'],
      stdin: true,
      ...argv,
    });

  it('reads the raw string from stdin and writes the verdict to --out', () => {
    const out = join(dir, 'verdict.json');
    fsState.stdin = `'${dir}' --effort low\n`;
    run({ out });
    const verdict = JSON.parse(fsState.written.get(out)!) as {
      targetPathAbsolute: string;
      effort: string;
    };
    expect(verdict.targetPathAbsolute).toBe(dir);
    expect(verdict.effort).toBe('low');
    expect(writeStdoutLine).toHaveBeenCalledWith(
      fsState.written.get(out)!.replace(/\n$/, ''),
    );
  });

  it('tolerates trailing newlines in the stdin payload', () => {
    // The shell's heredoc/echo appends newlines; the tokenizer splits on
    // whitespace, so the payload parses end-to-end without any stripping.
    fsState.stdin = `'${dir}'\n\n`;
    const out = join(dir, 'nl.json');
    run({ out });
    const verdict = JSON.parse(fsState.written.get(out)!) as {
      targetPathAbsolute: string;
    };
    expect(verdict.targetPathAbsolute).toBe(dir);
  });

  it('refuses a negated --stdin (the command is stdin-only)', () => {
    expect(() => run({ stdin: false })).toThrow(/stdin-only/);
  });

  it('surfaces parse refusals through the handler exit path', () => {
    fsState.stdin = `src/it's-dir\n`;
    expect(() => run({})).toThrow(/unbalanced quote/);
  });

  it('creates a non-existent nested --out parent before writing', () => {
    // mkdirSync runs with recursive:true against the verdict's parent —
    // a nested parent that does not exist yet is exactly the shape the
    // skill's .qwen/tmp path lands in; without the recursive flag the
    // verdict write would ENOENT.
    const out = join(dir, 'nested', 'deeper', 'verdict.json');
    fsState.stdin = `'${dir}'`;
    run({ out });
    expect(fsState.written.get(out)).toBeDefined();
    expect(vi.mocked(mkdirSync)).toHaveBeenCalledWith(dirname(out), {
      recursive: true,
    });
  });
});

describe('yargs wiring', () => {
  let dir: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'audit parse-args yargs ')));
    vi.mocked(writeStdoutLine).mockClear();
    fsState.written.clear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs parse-args flat from --stdin to --out through real yargs', () => {
    fsState.stdin = `'${dir}'`;
    const out = join(dir, 'flat.json');
    void yargs(['parse-args', '--stdin', '--out', out])
      .command(parseArgsCommand)
      .strict()
      .exitProcess(false)
      .parse();
    const verdict = JSON.parse(fsState.written.get(out)!) as { effort: string };
    expect(verdict.effort).toBe('medium');
  });

  it('runs parse-args nested under the audit command through real yargs', () => {
    fsState.stdin = `'${dir}'`;
    const out = join(dir, 'nested.json');
    void yargs(['audit', 'parse-args', '--stdin', '--out', out])
      .command(auditCommand)
      .strict()
      .exitProcess(false)
      .parse();
    const verdict = JSON.parse(fsState.written.get(out)!) as { effort: string };
    expect(verdict.effort).toBe('medium');
  });
});
