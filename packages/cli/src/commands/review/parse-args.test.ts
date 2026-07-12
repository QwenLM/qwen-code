/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import yargs from 'yargs';
import {
  parseArgsCommand,
  parseReviewArgs,
  tokenizeArgs,
  type ParsedReviewArgs,
} from './parse-args.js';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';

// The handler reads the raw string from fd 0 (`--stdin`) and writes the
// verdict to `--out`; both are intercepted so the wiring tests below can run
// the real yargs command without a real terminal or filesystem.
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

describe('tokenizeArgs', () => {
  it('splits on whitespace and collapses runs', () => {
    expect(tokenizeArgs('  6711   --comment ')).toEqual(['6711', '--comment']);
  });

  it('honours double- and single-quoted segments', () => {
    expect(tokenizeArgs('"src/my file.ts" --effort low')).toEqual([
      'src/my file.ts',
      '--effort',
      'low',
    ]);
    expect(tokenizeArgs("'a b' c")).toEqual(['a b', 'c']);
  });

  it('returns an empty list for an empty string', () => {
    expect(tokenizeArgs('')).toEqual([]);
    expect(tokenizeArgs('   ')).toEqual([]);
  });
});

/**
 * Table-driven cases. Each row that reproduces a previously-shipped parsing
 * bug names it, so a regression is recognizable at a glance.
 */
interface Case {
  name: string;
  raw: string;
  expect: Partial<ParsedReviewArgs> & {
    targetType: ParsedReviewArgs['target']['type'];
    warningCount?: number;
  };
}

const CASES: Case[] = [
  {
    name: 'no arguments → local diff at medium',
    raw: '',
    expect: {
      targetType: 'local',
      effort: 'medium',
      effortSource: 'default',
      warningCount: 0,
    },
  },
  {
    name: 'PR number → high by default',
    raw: '6711',
    expect: {
      targetType: 'pr-number',
      effort: 'high',
      effortSource: 'default',
      warningCount: 0,
    },
  },
  {
    name: 'file path → medium by default',
    raw: 'src/foo.ts',
    expect: {
      targetType: 'file',
      effort: 'medium',
      effortSource: 'default',
      warningCount: 0,
    },
  },
  {
    name: 'PR URL → owner/repo/number extracted',
    raw: 'https://github.com/QwenLM/qwen-code/pull/6711',
    expect: { targetType: 'pr-url', effort: 'high', warningCount: 0 },
  },
  {
    name: 'explicit effort on a PR',
    raw: '6711 --effort medium',
    expect: {
      targetType: 'pr-number',
      effort: 'medium',
      effortSource: 'explicit',
      warningCount: 0,
    },
  },
  {
    name: 'equals form parses without consuming a second token (bug: undefined = form)',
    raw: '--effort=low src/foo.ts',
    expect: {
      targetType: 'file',
      effort: 'low',
      effortSource: 'explicit',
      warningCount: 0,
    },
  },
  {
    name: 'invalid equals value warns, falls back, touches nothing else (bug: = form undefined)',
    raw: '6711 --effort=typo',
    expect: {
      targetType: 'pr-number',
      effort: 'high',
      effortSource: 'default',
      warningCount: 1,
    },
  },
  {
    name: 'invalid spaced value is discarded when another token is the target (bug: typo leaked into disambiguation)',
    raw: '6711 --effort typo',
    expect: {
      targetType: 'pr-number',
      effort: 'high',
      effortSource: 'default',
      extraTokens: [],
      warningCount: 1,
    },
  },
  {
    name: 'invalid spaced value survives as the sole target candidate',
    raw: '--effort 6711',
    expect: {
      targetType: 'pr-number',
      effort: 'high',
      effortSource: 'default',
      warningCount: 1,
    },
  },
  {
    name: 'a following flag is never consumed as the value (bug: --effort --comment ate the flag)',
    raw: '6711 --effort --comment',
    expect: {
      targetType: 'pr-number',
      effort: 'high',
      comment: { requested: true, effective: true },
      warningCount: 1,
    },
  },
  {
    name: 'flag-final --effort warns and defaults',
    raw: '6711 --effort',
    expect: { targetType: 'pr-number', effort: 'high', warningCount: 1 },
  },
  {
    name: '--comment on a PR is effective and forces high over an explicit lower effort',
    raw: '6711 --comment --effort low',
    expect: {
      targetType: 'pr-number',
      effort: 'high',
      effortSource: 'forced-by-comment',
      comment: { requested: true, effective: true },
      warningCount: 1,
    },
  },
  {
    name: 'ignored --comment on a non-PR must not change the effort (bug: silently-forced high)',
    raw: 'src/foo.ts --comment --effort low',
    expect: {
      targetType: 'file',
      effort: 'low',
      effortSource: 'explicit',
      comment: { requested: true, effective: false },
      warningCount: 1,
    },
  },
  {
    name: '--commentary is not --comment (substring guard)',
    raw: '6711 --commentary',
    expect: {
      targetType: 'pr-number',
      comment: { requested: false, effective: false },
      unknownFlags: ['--commentary'],
      warningCount: 1,
    },
  },
  {
    name: 'extra positional tokens are reported, not guessed at',
    raw: '6711 typo2',
    expect: {
      targetType: 'pr-number',
      extraTokens: ['typo2'],
      warningCount: 1,
    },
  },
  {
    name: 'numeric-prefix junk after /pull/ is not a PR URL (bug: /pull/42oops read as PR 42)',
    raw: 'https://github.com/QwenLM/qwen-code/pull/42oops',
    expect: {
      targetType: 'local',
      extraTokens: ['https://github.com/QwenLM/qwen-code/pull/42oops'],
      warningCount: 1,
    },
  },
  {
    name: 'shell metacharacters in owner never reach the verdict',
    raw: '"https://github.com/$(rm -rf x)/qwen-code/pull/42"',
    expect: {
      targetType: 'local',
      extraTokens: ['https://github.com/$(rm -rf x)/qwen-code/pull/42'],
      warningCount: 1,
    },
  },
];

describe('parseReviewArgs', () => {
  it.each(CASES)('$name', (c) => {
    const got = parseReviewArgs(c.raw);
    const { targetType, warningCount, ...rest } = c.expect;
    expect(got.target.type).toBe(targetType);
    if (warningCount !== undefined) {
      expect(got.warnings).toHaveLength(warningCount);
    }
    for (const [key, value] of Object.entries(rest)) {
      expect(got[key as keyof ParsedReviewArgs]).toEqual(value);
    }
  });

  it('extracts host/owner/repo/number from a PR URL', () => {
    const got = parseReviewArgs('https://github.com/QwenLM/qwen-code/pull/42');
    expect(got.target).toEqual({
      type: 'pr-url',
      url: 'https://github.com/QwenLM/qwen-code/pull/42',
      host: 'github.com',
      owner: 'QwenLM',
      repo: 'qwen-code',
      number: 42,
    });
  });

  it('canonicalizes an uppercase scheme/host and drops query and fragment', () => {
    const got = parseReviewArgs(
      'HTTPS://GitHub.com/QwenLM/qwen-code/pull/42?diff=split#discussion',
    );
    expect(got.target).toEqual({
      type: 'pr-url',
      url: 'https://github.com/QwenLM/qwen-code/pull/42',
      host: 'github.com',
      owner: 'QwenLM',
      repo: 'qwen-code',
      number: 42,
    });
    expect(got.warnings).toHaveLength(0);
  });

  it('a trailing path segment after the number stays a valid URL boundary', () => {
    const got = parseReviewArgs(
      'https://github.com/QwenLM/qwen-code/pull/42/files',
    );
    expect(got.target).toMatchObject({ type: 'pr-url', number: 42 });
  });

  it('refuses a junk PR URL instead of guessing (never a file path, never PR 42)', () => {
    const got = parseReviewArgs(
      'https://github.com/QwenLM/qwen-code/pull/42oops',
    );
    expect(got.target).toEqual({ type: 'local' });
    expect(got.extraTokens).toEqual([
      'https://github.com/QwenLM/qwen-code/pull/42oops',
    ]);
    expect(got.warnings[0]).toContain('not a GitHub PR URL');
  });

  it('last explicit effort wins when repeated', () => {
    const got = parseReviewArgs('6711 --effort low --effort medium');
    expect(got.effort).toBe('medium');
    expect(got.effortSource).toBe('explicit');
  });
});

describe('parseReviewArgs — repeated --effort warnings state what is actually in effect', () => {
  it('valid then invalid keeps the valid effort and the warning says so (bug: warned "using the default" while low stayed active)', () => {
    const got = parseReviewArgs('6711 --effort low --effort=typo');
    expect(got.effort).toBe('low');
    expect(got.effortSource).toBe('explicit');
    expect(got.warnings).toHaveLength(1);
    expect(got.warnings[0]).toContain('"typo"');
    expect(got.warnings[0]).toContain('--effort low');
    expect(got.warnings[0]).not.toContain('default');
  });

  it('invalid then valid resolves to the valid one and the warning names it', () => {
    const got = parseReviewArgs('--effort=typo 6711 --effort low');
    expect(got.effort).toBe('low');
    expect(got.effortSource).toBe('explicit');
    expect(got.warnings).toHaveLength(1);
    expect(got.warnings[0]).toContain('--effort low');
  });

  it('a discarded spaced typo alongside a valid effort does not claim the default', () => {
    const got = parseReviewArgs('--effort low 6711 --effort typo2');
    expect(got.effort).toBe('low');
    expect(got.warnings).toHaveLength(1);
    expect(got.warnings[0]).toContain('discarded');
    expect(got.warnings[0]).toContain('--effort low');
    expect(got.warnings[0]).not.toContain('default');
  });

  it('an invalid effort superseded by --comment forcing names the forcing, not the default', () => {
    const got = parseReviewArgs('6711 --comment --effort low --effort=typo');
    expect(got.effort).toBe('high');
    expect(got.effortSource).toBe('forced-by-comment');
    const invalidWarning = got.warnings.find((w) => w.includes('"typo"'));
    expect(invalidWarning).toContain('forces high effort');
    expect(invalidWarning).not.toContain('default');
  });

  it('with no valid occurrence anywhere the warning still says the default applies', () => {
    const got = parseReviewArgs('6711 --effort=typo');
    expect(got.effort).toBe('high');
    expect(got.effortSource).toBe('default');
    expect(got.warnings[0]).toContain('using the default effort');
  });
});

/**
 * Wiring-level tests: the real yargs command, not the pure function. The
 * pure-function table cannot see transport failures — the documented
 * positional invocation broke on any raw string that begins with a flag
 * (`qwen review parse-args '--effort low'` → `Unknown argument`), and every
 * unit test kept passing while it did.
 */
describe('parseArgsCommand wiring', () => {
  beforeEach(() => {
    fsState.stdin = '';
    fsState.written.clear();
    vi.mocked(writeStdoutLine).mockClear();
  });

  async function runCli(tokens: string[]): Promise<void> {
    await yargs(tokens)
      .command(parseArgsCommand)
      .strict()
      .exitProcess(false)
      .fail((msg, err) => {
        throw err ?? new Error(msg ?? 'yargs failure');
      })
      .parseAsync();
  }

  function printedVerdict(): ParsedReviewArgs {
    const calls = vi.mocked(writeStdoutLine).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return JSON.parse(String(calls[calls.length - 1][0])) as ParsedReviewArgs;
  }

  it('--stdin carries a flag-first raw string that the positional cannot', () => {
    fsState.stdin = '--effort low\n';
    return runCli(['parse-args', '--stdin']).then(() => {
      const got = printedVerdict();
      expect(got.effort).toBe('low');
      expect(got.effortSource).toBe('explicit');
      expect(got.target.type).toBe('local');
    });
  });

  it('a flag-first positional is rejected by strict mode before the handler runs (why --stdin exists)', async () => {
    await expect(runCli(['parse-args', '--effort low'])).rejects.toThrow(
      /Unknown argument/,
    );
    expect(vi.mocked(writeStdoutLine)).not.toHaveBeenCalled();
  });

  it('an empty stdin body is a no-argument local review', async () => {
    fsState.stdin = '\n';
    await runCli(['parse-args', '--stdin']);
    const got = printedVerdict();
    expect(got.target).toEqual({ type: 'local' });
    expect(got.effort).toBe('medium');
  });

  it('positional and --stdin together are refused, not silently merged', async () => {
    fsState.stdin = '6711';
    await expect(runCli(['parse-args', '6712', '--stdin'])).rejects.toThrow(
      /not both/,
    );
  });

  it('a raw string smuggled after -- is refused, not a silent local verdict', async () => {
    // Post-`--` tokens never bind to [raw]; this used to return
    // {type: local, effort: medium} for `-- '--effort low'` — a wrong
    // verdict that looked valid.
    await expect(runCli(['parse-args', '--', '--effort low'])).rejects.toThrow(
      /--stdin/,
    );
    expect(vi.mocked(writeStdoutLine)).not.toHaveBeenCalled();
  });

  it('--out writes the same verdict JSON it prints', async () => {
    fsState.stdin = '6711 --comment\n';
    await runCli(['parse-args', '--stdin', '--out', '/fake/dir/verdict.json']);
    const written = fsState.written.get('/fake/dir/verdict.json');
    expect(written).toBeDefined();
    const got = JSON.parse(written!) as ParsedReviewArgs;
    expect(got.target).toEqual({ type: 'pr-number', number: 6711 });
    expect(got.comment).toEqual({ requested: true, effective: true });
    expect(written).toBe(String(vi.mocked(writeStdoutLine).mock.calls[0][0]));
  });
});
