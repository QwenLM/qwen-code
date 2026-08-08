/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from 'vitest';
import yargs from 'yargs';
import { join } from 'node:path';
import {
  parseArgsCommand,
  parseReviewArgs,
  tokenizeArgs,
  type ParsedReviewArgs,
} from './parse-args.js';
import { reviewCommand } from '../review.js';
import { reviewSourceRoots, reviewSourcesDigest } from './lib/stale-bundle.js';
import {
  FOREIGN_DIGEST,
  makeStaleBundleFixture,
  stampDigest,
} from './lib/test-utils.js';
import {
  writeStdoutLine,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';

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
  writeStderrLineSafe: vi.fn(),
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

describe('parseReviewArgs — `--fix` is `--comment` reflected: it needs a tree, not a PR', () => {
  // The two flags are gated on opposite targets, and each is *ignored with a
  // warning* on the other's. A PR review's tree is the ephemeral worktree Step 9
  // deletes; "fixed" edits there are discarded minutes later, and a review that
  // reported them as applied would be lying about work that no longer exists.

  it('is effective on a local review and floors the effort at medium', () => {
    const got = parseReviewArgs('--fix');
    expect(got.target.type).toBe('local');
    expect(got.fix).toEqual({ requested: true, effective: true });
    // Local defaults to medium already — no force, no warning about one.
    expect(got.effort).toBe('medium');
    expect(got.effortSource).toBe('default');
    expect(got.warnings).toHaveLength(0);
  });

  it('is effective on a file review', () => {
    const got = parseReviewArgs('src/foo.ts --fix');
    expect(got.target.type).toBe('file');
    expect(got.fix).toEqual({ requested: true, effective: true });
  });

  it('forces low up to medium — an unverified finding must not edit the tree', () => {
    const got = parseReviewArgs('--effort low --fix');
    expect(got.effort).toBe('medium');
    expect(got.effortSource).toBe('forced-by-fix');
    expect(got.warnings).toEqual([
      expect.stringContaining('`--fix` edits your working tree'),
    ]);
  });

  it('does not drag high down to medium', () => {
    const got = parseReviewArgs('--effort high --fix');
    expect(got.effort).toBe('high');
    expect(got.effortSource).toBe('explicit');
  });

  it('is ignored on a PR target, with a warning naming the ephemeral worktree', () => {
    const got = parseReviewArgs('6711 --fix');
    expect(got.target).toEqual({ type: 'pr-number', number: 6711 });
    expect(got.fix).toEqual({ requested: true, effective: false });
    expect(got.warnings).toEqual([
      expect.stringContaining('`--fix` flag is ignored'),
    ]);
    // And an ignored --fix changes nothing about the level.
    expect(got.effort).toBe('high');
    expect(got.effortSource).toBe('default');
  });

  it('never both: --comment and --fix cannot be effective in the same run', () => {
    const pr = parseReviewArgs('6711 --comment --fix');
    expect(pr.comment.effective).toBe(true);
    expect(pr.fix.effective).toBe(false);
    expect(pr.effort).toBe('high');

    const local = parseReviewArgs('--comment --fix');
    expect(local.comment.effective).toBe(false);
    expect(local.fix.effective).toBe(true);
    // The ignored --comment must not force high; the effective --fix floors at
    // medium, and local's default is already medium.
    expect(local.effort).toBe('medium');
  });

  it('is absent by default, not undefined', () => {
    const got = parseReviewArgs('6711');
    expect(got.fix).toEqual({ requested: false, effective: false });
  });

  it('is not a target token', () => {
    // `--fix` is a recognized flag, so it must not fall through to
    // `unknownFlags` (which would warn) nor be classified as a file path.
    const got = parseReviewArgs('--fix');
    expect(got.unknownFlags).toEqual([]);
    expect(got.extraTokens).toEqual([]);
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

describe('parseReviewArgs — case and single-dash disposal (bug: guessed where one meaning was plausible)', () => {
  it('accepts --effort High and --effort=HIGH, keeping the verdict lowercase', () => {
    const spaced = parseReviewArgs('6711 --effort High');
    expect(spaced.effort).toBe('high');
    expect(spaced.effortSource).toBe('explicit');
    expect(spaced.warnings).toHaveLength(0);

    const eq = parseReviewArgs('src/foo.ts --effort=MEDIUM');
    expect(eq.effort).toBe('medium');
    expect(eq.effortSource).toBe('explicit');
  });

  it('a single-dash token is an unknown flag, never the target (bug: -c became a file target and demoted the PR number)', () => {
    const got = parseReviewArgs('-c 6711');
    expect(got.target).toEqual({ type: 'pr-number', number: 6711 });
    expect(got.unknownFlags).toEqual(['-c']);
    expect(got.extraTokens).toEqual([]);
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

  // The real CLI nests this command under `review`, which changes what
  // yargs puts in argv._ (['review', 'parse-args'] instead of
  // ['parse-args']) — the smuggle guard once read that command path as
  // extra arguments and rejected every real invocation, while these
  // top-level tests kept passing.
  describe('nested under the real review command', () => {
    async function runNested(tokens: string[]): Promise<void> {
      await yargs(tokens)
        .command(reviewCommand)
        .strict()
        .exitProcess(false)
        .fail((msg, err) => {
          throw err ?? new Error(msg ?? 'yargs failure');
        })
        .parseAsync();
    }

    it('the documented stdin invocation works through `review parse-args`', async () => {
      fsState.stdin = '6711 --comment\n';
      await runNested(['review', 'parse-args', '--stdin']);
      const got = printedVerdict();
      expect(got.target).toEqual({ type: 'pr-number', number: 6711 });
      expect(got.effort).toBe('high');
    });

    it('the post--- smuggle is still refused when nested', async () => {
      await expect(
        runNested(['review', 'parse-args', '--', '--effort low']),
      ).rejects.toThrow(/--stdin/);
    });
  });
});

describe('parse-args warns when the bundle is not built from these sources', () => {
  // A real tree, not a mocked one: what is under test is the derivation from
  // `process.argv[1]` to the stamp and the roots, and mocking those reads
  // would test the mock. `node:fs` is mocked for this file, so the real
  // functions are pulled in explicitly.
  let fsReal: typeof import('node:fs');
  let repo: string;
  let argv1: string;

  beforeAll(async () => {
    fsReal = (await vi.importActual('node:fs')) as typeof import('node:fs');
  });

  beforeEach(() => {
    // `node:fs` is mocked for this file, so the fixture builder must write
    // through the real bindings pulled in above.
    ({ repo, argv1 } = makeStaleBundleFixture(fsReal, 'parse-args-stale-'));
    vi.mocked(writeStderrLineSafe).mockClear();
    vi.mocked(writeStdoutLine).mockClear();
  });
  afterEach(() => fsReal.rmSync(repo, { recursive: true, force: true }));

  const stamp = (digest: string) => stampDigest(fsReal, repo, digest);
  const run = () => {
    const original = process.argv[1];
    process.argv[1] = argv1;
    try {
      (parseArgsCommand.handler as (a: unknown) => void)({
        raw: '8368',
        _: ['review', 'parse-args'],
      });
    } finally {
      process.argv[1] = original;
    }
  };

  it('warns when the stamp does not match the sources', () => {
    stamp(FOREIGN_DIGEST);
    run();
    // The full paragraph: this is the first command of the review, and the
    // one-line form belongs to `drive`, which repeats the check.
    expect(vi.mocked(writeStderrLineSafe).mock.calls[0]?.[0]).toContain(
      'NOT built from the review sources',
    );
    expect(vi.mocked(writeStderrLineSafe).mock.calls[0]?.[0]).toContain(
      'runs the BUILT bundle, not the working tree',
    );
    // …and BEFORE the first result: relocating the loop below the
    // `writeStdoutLine(json)` keeps every substring assertion green while the
    // warning lands only once the reviewer has already consumed the parse.
    expect(
      vi.mocked(writeStderrLineSafe).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(writeStdoutLine).mock.invocationCallOrder[0]);
  });

  it('says nothing when the stamp matches', () => {
    stamp(reviewSourcesDigest(repo, reviewSourceRoots(repo))!);
    run();
    expect(writeStderrLineSafe).not.toHaveBeenCalled();
  });

  it('warns through a symlinked alias of the bundle', () => {
    // node hands `argv[1]` over unresolved, so a dogfooding alias like
    // `ln -s dist/cli.js ~/bin/qwen` must resolve back to the bundle before
    // the layout guard derives `dist/` from it — otherwise the check is
    // silently off for every symlinked entry.
    stamp(FOREIGN_DIGEST);
    const alias = join(repo, 'qwen-alias');
    fsReal.symlinkSync(argv1, alias);
    const original = process.argv[1];
    process.argv[1] = alias;
    try {
      (parseArgsCommand.handler as (a: unknown) => void)({
        raw: '8368',
        _: ['review', 'parse-args'],
      });
    } finally {
      process.argv[1] = original;
    }
    expect(vi.mocked(writeStderrLineSafe).mock.calls[0]?.[0]).toContain(
      'NOT built from the review sources',
    );
  });

  it('says it could not check when sources exist but the stamp does not', () => {
    // A checkout whose dist predates the stamp is genuinely stale and
    // unmeasurable — the state of every existing tree the moment this ships.
    // Silence there is the failure this whole check exists to end.
    run();
    expect(vi.mocked(writeStderrLineSafe).mock.calls[0]?.[0]).toContain(
      'could not check whether the bundle is current',
    );
    // The remediation tail — the only actionable content of a notice whose
    // whole purpose is telling a pre-stamp checkout how to fix its state.
    expect(vi.mocked(writeStderrLineSafe).mock.calls[0]?.[0]).toContain(
      'npm run bundle',
    );
  });

  it('treats a malformed stamp as no stamp instead of accusing the build', () => {
    // A bundle step killed mid-write leaves a truncated or non-hex digest
    // beside a current build; compared as-is it would report stale on every
    // review until the next one. The shape check routes it to the same
    // 'could not check' as a missing stamp.
    stamp('abc123');
    run();
    expect(vi.mocked(writeStderrLineSafe).mock.calls[0]?.[0]).toContain(
      'could not check whether the bundle is current',
    );
  });

  // chmod is the only lever this case has: on Windows it is a no-op, and a
  // root user reads through it, so the branch under test is unreachable
  // there. The case skips rather than running into the OTHER branch — a
  // readable tree, whose digest merely differs — and failing red against
  // assertions that match only the unmeasured message.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'says it could not check when a source cannot be read',
    () => {
      // Distinct from an installed package: the roots are on disk, so the
      // check has switched itself off for someone about to read a verdict,
      // and the docstring promises every unmeasurable case names itself.
      stamp(FOREIGN_DIGEST);
      const src = join(
        repo,
        'packages',
        'cli',
        'src',
        'commands',
        'review',
        'drive.ts',
      );
      fsReal.rmSync(src);
      fsReal.mkdirSync(src, { recursive: true });
      fsReal.writeFileSync(join(src, 'nested.ts'), 'x');
      fsReal.chmodSync(src, 0o000);
      try {
        run();
        // The branch the test names, not merely that something was printed.
        expect(vi.mocked(writeStderrLineSafe).mock.calls[0]?.[0]).toContain(
          'could not check whether the bundle is current',
        );
        expect(vi.mocked(writeStderrLineSafe).mock.calls[0]?.[0]).toContain(
          'a review source could not be read',
        );
      } finally {
        fsReal.chmodSync(src, 0o755);
      }
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'says it could not check when the roots cannot even be statted',
    () => {
      // An archive extracted with the wrong ownership, or a cache restored
      // without modes: the roots are on disk but every stat fails EACCES,
      // which `existsSync` reports as absence. That is a tree whose sources
      // cannot be measured, not a tree with none — and the notice must say
      // so instead of passing silently.
      stamp(FOREIGN_DIGEST);
      const packages = join(repo, 'packages');
      fsReal.chmodSync(packages, 0o000);
      try {
        run();
        expect(vi.mocked(writeStderrLineSafe).mock.calls[0]?.[0]).toContain(
          'could not check whether the bundle is current',
        );
        expect(vi.mocked(writeStderrLineSafe).mock.calls[0]?.[0]).toContain(
          'a review source could not be read',
        );
      } finally {
        fsReal.chmodSync(packages, 0o755);
      }
    },
  );

  it('names the cause when the roots hold nothing the digest admits', () => {
    // A root that exists but holds only test files measures zero digested
    // files. That is "nothing found", not "something unreadable", and the
    // docstring promises each unmeasurable case names itself. The other three
    // roots come out of the fixture too, so the zero is complete, not the
    // partial-checkout case.
    stamp(FOREIGN_DIGEST);
    const reviewDir = join(
      repo,
      'packages',
      'cli',
      'src',
      'commands',
      'review',
    );
    fsReal.rmSync(join(reviewDir, 'drive.ts'));
    fsReal.writeFileSync(join(reviewDir, 'only.test.ts'), 'a test');
    fsReal.rmSync(
      join(repo, 'packages', 'cli', 'src', 'commands', 'review.ts'),
    );
    fsReal.rmSync(
      join(
        repo,
        'packages',
        'cli',
        'src',
        'services',
        'review-worktree-lease.ts',
      ),
    );
    fsReal.rmSync(join(repo, 'packages', 'core'), {
      recursive: true,
      force: true,
    });
    run();
    expect(vi.mocked(writeStderrLineSafe).mock.calls[0]?.[0]).toContain(
      'no review sources were found to compare',
    );
  });

  it('stays silent for a layout that has nowhere to keep a stamp', () => {
    // `npm start` runs `node <root>/packages/cli`, and node sets argv[1] to
    // that DIRECTORY — so the derivation would find sources under <root> and
    // no stamp beside them, and print "could not check" on every review
    // forever, with advice that can never make it stop.
    const original = process.argv[1];
    process.argv[1] = join(repo, 'packages', 'cli');
    try {
      (parseArgsCommand.handler as (a: unknown) => void)({
        raw: '8368',
        _: ['review', 'parse-args'],
      });
    } finally {
      process.argv[1] = original;
    }
    expect(writeStderrLineSafe).not.toHaveBeenCalled();
  });

  it('says it could not check when only some of the roots are materialized', () => {
    // A sparse checkout narrows a full tree without touching `dist/`: the
    // stamp was made from every root, the tree now holds the rest of them,
    // and comparing the survivors would accuse a bundle that may be
    // byte-for-byte correct. The silence of an installed package is the
    // other end of the same spectrum — zero roots present — and stays.
    stamp(reviewSourcesDigest(repo, reviewSourceRoots(repo))!);
    fsReal.rmSync(join(repo, 'packages', 'core'), {
      recursive: true,
      force: true,
    });
    run();
    expect(vi.mocked(writeStderrLineSafe).mock.calls[0]?.[0]).toContain(
      'could not check whether the bundle is current',
    );
    expect(vi.mocked(writeStderrLineSafe).mock.calls[0]?.[0]).toContain(
      'only some of the review sources are present',
    );
    expect(vi.mocked(writeStderrLineSafe).mock.calls[0]?.[0]).not.toContain(
      'NOT built from the review sources',
    );
  });

  it('stays silent for an installed package, which has no sources either', () => {
    // No `packages/` beside the bundle: nothing to compare, nothing the user
    // could do about it, and no reason to put a line in their terminal.
    fsReal.rmSync(join(repo, 'packages'), { recursive: true, force: true });
    run();
    expect(writeStderrLineSafe).not.toHaveBeenCalled();
  });

  it('still parses the arguments', () => {
    // The warning is a diagnostic; the parse is unaffected by it.
    stamp(FOREIGN_DIGEST);
    run();
    expect(writeStdoutLine).toHaveBeenCalled();
  });
});
