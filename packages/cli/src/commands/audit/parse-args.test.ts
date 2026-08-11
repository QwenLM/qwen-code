/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseAuditArgs, parseArgsCommand } from './parse-args.js';
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
    writeFileSync: vi.fn((path: unknown, data: unknown) => {
      fsState.written.set(String(path), String(data));
    }),
    mkdirSync: vi.fn(),
  };
  return { ...mock, default: mock };
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

  it('refuses an unbalanced quote instead of silently re-targeting', () => {
    // An unquoted apostrophe would be stripped by the tokenizer and
    // re-target the audit (src/it's-dir -> src/its-dir); an unclosed quote
    // would swallow the rest of the string.
    expect(() => parseAuditArgs(`src/it's-dir`)).toThrow(/unbalanced quote/);
    expect(() => parseAuditArgs(`'${dir} --effort low`)).toThrow(
      /unbalanced quote/,
    );
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

  it('strips one trailing newline from the stdin payload', () => {
    // The shell's heredoc/echo adds one; a path never ends with a newline,
    // so exactly one is stripped and no more.
    fsState.stdin = `'${dir}'\n`;
    run({});
    expect(writeStdoutLine).toHaveBeenCalled();
  });

  it('refuses a negated --stdin (the command is stdin-only)', () => {
    expect(() => run({ stdin: false })).toThrow(/stdin-only/);
  });

  it('surfaces parse refusals through the handler exit path', () => {
    fsState.stdin = `src/it's-dir\n`;
    expect(() => run({})).toThrow(/unbalanced quote/);
  });
});
