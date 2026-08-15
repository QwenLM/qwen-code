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

// The handler resolves `review.effort` / `review.comment` from the operator's
// real settings.json — pin it empty, or a developer running with either set
// reddens the wiring tests below.
const reviewSettingsMock = vi.hoisted(() =>
  vi.fn((): Record<string, unknown> => ({})),
);
vi.mock('../../config/settings.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../config/settings.js')>();
  return {
    ...actual,
    // The production call carries `{ skipWorkspaceSettings: true }` — these
    // policy keys resolve from operator scopes only. A caller that forgets
    // the flag reads the workspace-polluted view below instead, and the
    // wiring assertions redden: a repository's `.qwen/settings.json` must
    // not control them.
    loadSettings: vi.fn((...callArgs: unknown[]) => {
      const opts = callArgs[1] as
        | { skipWorkspaceSettings?: boolean }
        | undefined;
      return {
        merged: {
          review: opts?.skipWorkspaceSettings
            ? reviewSettingsMock()
            : { attribution: false, comment: true, effort: 'low' },
        },
      };
    }),
  };
});

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

describe('parseReviewArgs — --severity-floor (the convergence posture knob)', () => {
  it('defaults to auto: the round-adaptive rule is resolved at Step 6, not here', () => {
    const got = parseReviewArgs('6711');
    expect(got.severityFloor).toBe('auto');
    expect(got.severityFloorSource).toBe('default');
  });

  it('parses both forms case-insensitively; the last valid occurrence wins', () => {
    expect(parseReviewArgs('6711 --severity-floor critical')).toMatchObject({
      severityFloor: 'critical',
      severityFloorSource: 'explicit',
    });
    expect(parseReviewArgs('6711 --severity-floor=Suggestion')).toMatchObject({
      severityFloor: 'suggestion',
    });
    expect(
      parseReviewArgs(
        '6711 --severity-floor critical --severity-floor suggestion',
      ),
    ).toMatchObject({ severityFloor: 'suggestion' });
  });

  it('warns and ignores the flag on a non-PR target, exactly as --comment does', () => {
    const got = parseReviewArgs('src/foo.ts --severity-floor critical');
    expect(got.target.type).toBe('file');
    expect(got.severityFloor).toBe('auto');
    expect(got.severityFloorSource).toBe('default');
    expect(got.warnings.some((w) => w.includes('--severity-floor'))).toBe(true);
  });

  it('an invalid value warns naming what is in effect, and never eats the target', () => {
    // The typo is discarded when another token is the target — without the
    // disposal rule, `criticl` would classify as a file path and shadow the
    // real PR target that follows it.
    const got = parseReviewArgs('--severity-floor criticl 6711');
    expect(got.target).toEqual({ type: 'pr-number', number: 6711 });
    expect(got.severityFloor).toBe('auto');
    expect(
      got.warnings.some(
        (w) =>
          w.includes('Invalid --severity-floor value "criticl"') &&
          w.includes('round-adaptive default'),
      ),
    ).toBe(true);
  });

  it('an invalid equals-form value warns instead of vanishing', () => {
    // Mutation-verified gap: replacing the invalid-eq push with a bare
    // `continue` left the whole suite green — an operator who typed the flag
    // believing round 6 went Critical-only would get Suggestions posted with
    // nothing saying the flag never took effect.
    const got = parseReviewArgs('6711 --severity-floor=critcl');
    expect(got.target).toEqual({ type: 'pr-number', number: 6711 });
    expect(got.severityFloor).toBe('auto');
    expect(
      got.warnings.some((w) =>
        w.includes('Invalid --severity-floor value "critcl"'),
      ),
    ).toBe(true);
  });

  it('a sole invalid value becomes the target, and the warning says so', () => {
    const got = parseReviewArgs('--severity-floor criticl');
    expect(got.target).toEqual({ type: 'file', path: 'criticl' });
    expect(
      got.warnings.some(
        (w) =>
          w.includes('Invalid --severity-floor value "criticl"') &&
          w.includes('treating it as the review target'),
      ),
    ).toBe(true);
  });

  it('an unrelated typo never changes WHICH codebase is reviewed', () => {
    // `--effort 6711` reviews PR 6711 past a flag mistake; adding a second
    // malformed flag must not silently retarget the review at the local
    // diff. PR-shaped values survive disposal; enum-typo-shaped ones do not.
    const got = parseReviewArgs('--severity-floor blocker --effort 6711');
    expect(got.target).toEqual({ type: 'pr-number', number: 6711 });
    expect(
      got.warnings.some(
        (w) => w.includes('"blocker"') && w.includes('discarded'),
      ),
    ).toBe(true);
  });

  it('a typed target outranks a PR-shaped flag value', () => {
    // With a real positional target present, `--effort 6712` is a typo, not
    // a second target — keeping it would make the kept-as-target warning
    // lie about which PR is reviewed.
    const got = parseReviewArgs('6711 --effort 6712');
    expect(got.target).toEqual({ type: 'pr-number', number: 6711 });
    expect(got.extraTokens).toEqual([]);
    expect(
      got.warnings.some((w) => w.includes('"6712"') && w.includes('discarded')),
    ).toBe(true);
  });

  it('two PR-shaped flag values are ambiguous — refused, never first-wins', () => {
    // `--severity-floor 6711 --effort 6712`: silently reviewing 6711 would
    // review the wrong PR half the time. Both are discarded with a warning
    // that names them, and the review falls back to the local diff.
    const got = parseReviewArgs('--severity-floor 6711 --effort 6712');
    expect(got.target).toEqual({ type: 'local' });
    expect(got.extraTokens).toEqual([]);
    expect(
      got.warnings.some(
        (w) =>
          w.includes('Ambiguous target') &&
          w.includes('"6711"') &&
          w.includes('"6712"'),
      ),
    ).toBe(true);
  });

  it('the ambiguity guard covers the equals form — syntax does not pick a PR', () => {
    // Round-7 probe: the eq form never enters the disposal pool, so
    // `--severity-floor=6711 --effort 6712` silently targeted 6712 while
    // the all-spaced spelling was loudly refused. All four spellings must
    // land the same place.
    for (const raw of [
      '--severity-floor 6711 --effort 6712',
      '--severity-floor=6711 --effort 6712',
      '--severity-floor 6711 --effort=6712',
      '--severity-floor=6711 --effort=6712',
    ]) {
      const got = parseReviewArgs(raw);
      expect(got.target).toEqual({ type: 'local' });
      expect(got.warnings.some((w) => w.includes('Ambiguous target'))).toBe(
        true,
      );
    }
  });

  it('the equals form rescues a PR-shaped value exactly as the spaced form does', () => {
    // Round-8 probe: `--severity-floor=6711` reviewed the LOCAL tree while
    // `--severity-floor 6711` rescued PR 6711 — the guard's invariant
    // ("which codebase is reviewed cannot depend on which syntax happened
    // to be typed") was wired into refusal only. Every spelling converges.
    for (const raw of [
      '--severity-floor=6711',
      '--severity-floor 6711',
      '--effort=6711',
      '--severity-floor blocker --effort=6711',
      '--severity-floor blocker --effort 6711',
    ]) {
      expect(parseReviewArgs(raw).target).toEqual({
        type: 'pr-number',
        number: 6711,
      });
    }
    // Two spellings of the SAME PR are one candidate, not an ambiguity —
    // and not an extra argument either: the restated spelling must not
    // surface as `extraTokens` / "Ignoring extra argument(s)" (round-9).
    const dup = parseReviewArgs('--severity-floor 6711 --effort=6711');
    expect(dup.target).toEqual({ type: 'pr-number', number: 6711 });
    expect(dup.warnings.some((w) => w.includes('Ambiguous'))).toBe(false);
    expect(dup.extraTokens).toEqual([]);
    expect(dup.warnings.some((w) => w.includes('Ignoring extra'))).toBe(false);
    // Identity is the resolved TARGET, not the raw string: a bare number and
    // a same-number URL name one PR (round-9 finding — a raw-token Set read
    // them as two and fell back to the local tree).
    const mixed = parseReviewArgs(
      '--severity-floor 6711 --effort https://github.com/QwenLM/qwen-code/pull/6711',
    );
    expect(mixed.target).toMatchObject({ number: 6711 });
    expect(mixed.warnings.some((w) => w.includes('Ambiguous'))).toBe(false);
    expect(mixed.extraTokens).toEqual([]);
  });

  it('an invalid configured floor stays silent on a non-PR target', () => {
    // Round-8 mutant: deleting the `&& isPr` gate warned every file/local
    // review about a floor that is inert there by design.
    const got = parseReviewArgs('src/foo.ts', { severityFloor: 'blocker' });
    expect(got.severityFloor).toBe('auto');
    expect(got.warnings).toEqual([]);
  });

  it('an explicit auto floor is legal and overrides a configured floor for one run', () => {
    // Mutation-shown gap: dropping 'auto' from SEVERITY_FLOORS shipped
    // green while the documented one-shot override was rejected and, alone,
    // promoted to a bogus `auto` file target.
    expect(
      parseReviewArgs('6711 --severity-floor auto', {
        severityFloor: 'critical',
      }),
    ).toMatchObject({ severityFloor: 'auto', severityFloorSource: 'explicit' });
    const sole = parseReviewArgs('--severity-floor auto');
    expect(sole.target).toEqual({ type: 'local' });
  });

  it('a quoted-empty value is consumed as missing on both flags', () => {
    // Mutation-shown gap: with the consumption branch deleted, '' survived
    // as the sole candidate and became an empty-string file target.
    for (const raw of ['--severity-floor ""', '--effort ""']) {
      const got = parseReviewArgs(raw);
      expect(got.target).toEqual({ type: 'local' });
      expect(got.warnings.some((w) => w.includes('requires a value'))).toBe(
        true,
      );
    }
    const withTarget = parseReviewArgs('6711 --severity-floor ""');
    expect(withTarget.target).toEqual({ type: 'pr-number', number: 6711 });
    expect(
      withTarget.warnings.some((w) => w.includes('requires a value')),
    ).toBe(true);
  });

  it('two invalid values are two typos, not a target and a tiebreak', () => {
    // "Sole target candidate" is literal: with two invalid tokens neither is
    // sole, so both are discarded and the review falls back to the local
    // diff — promoting the first to a file target would send the caller off
    // to stat `blocker`.
    const got = parseReviewArgs(
      '--severity-floor blocker --severity-floor warning',
    );
    expect(got.target).toEqual({ type: 'local' });
    expect(got.extraTokens).toEqual([]);
    expect(got.warnings.filter((w) => w.includes('discarded')).length).toBe(2);
  });

  it('flag-final or flag-followed is a missing value, never a consumed flag', () => {
    const got = parseReviewArgs('6711 --severity-floor --comment');
    expect(got.comment.requested).toBe(true);
    expect(got.severityFloor).toBe('auto');
    expect(
      got.warnings.some((w) => w.includes('--severity-floor requires a value')),
    ).toBe(true);
  });

  it('applies the configured review.severityFloor; an explicit flag still wins', () => {
    expect(
      parseReviewArgs('6711', { severityFloor: 'critical' }),
    ).toMatchObject({
      severityFloor: 'critical',
      severityFloorSource: 'configured',
    });
    expect(
      parseReviewArgs('6711 --severity-floor suggestion', {
        severityFloor: 'critical',
      }),
    ).toMatchObject({
      severityFloor: 'suggestion',
      severityFloorSource: 'explicit',
    });
  });

  it('a configured floor is silently inert on a non-PR target', () => {
    const got = parseReviewArgs('src/foo.ts', { severityFloor: 'critical' });
    expect(got.severityFloor).toBe('auto');
    expect(got.warnings).toHaveLength(0);
  });

  it('an invalid configured floor warns on a PR target instead of dropping silently', () => {
    const got = parseReviewArgs('6711', { severityFloor: 'blocker' });
    expect(got.severityFloor).toBe('auto');
    expect(
      got.warnings.some((w) =>
        w.includes('Invalid review.severityFloor value "blocker"'),
      ),
    ).toBe(true);
  });
});

describe('parseReviewArgs — settings-provided defaults', () => {
  it('applies the configured effort when --effort is absent', () => {
    const got = parseReviewArgs('6711', { effort: 'medium' });
    expect(got.effort).toBe('medium');
    expect(got.effortSource).toBe('configured');
  });

  it('an explicit --effort beats the configured default', () => {
    const got = parseReviewArgs('6711 --effort low', { effort: 'medium' });
    expect(got.effort).toBe('low');
    expect(got.effortSource).toBe('explicit');
  });

  it('an effective --comment still forces high over the configured effort', () => {
    const got = parseReviewArgs('6711 --comment', { effort: 'low' });
    expect(got.effort).toBe('high');
    expect(got.effortSource).toBe('forced-by-comment');
  });

  it('an effective --fix still floors the configured effort at medium', () => {
    const got = parseReviewArgs('--fix', { effort: 'low' });
    expect(got.effort).toBe('medium');
    expect(got.effortSource).toBe('forced-by-fix');
  });

  it('the standing comment setting makes comment effective on a PR target', () => {
    const got = parseReviewArgs('6711', { comment: true });
    expect(got.comment.requested).toBe(false);
    expect(got.comment.effective).toBe(true);
    // The PR default is already high, so there is nothing to force.
    expect(got.effort).toBe('high');
    expect(got.effortSource).toBe('default');
  });

  it('the standing comment setting forces high over a configured lower effort', () => {
    const got = parseReviewArgs('6711', { comment: true, effort: 'low' });
    expect(got.comment.effective).toBe(true);
    // Posting still requires a verified review — and the warning says it was
    // the setting, not a flag the user never typed.
    expect(got.effort).toBe('high');
    expect(got.effortSource).toBe('forced-by-comment');
    expect(got.warnings.some((w) => w.includes('review.comment'))).toBe(true);
  });

  it('a flag-forced high names the flag in the forcing warning, not the setting', () => {
    // The flag branch of the same ternary: with no setting enabled, the
    // warning must not send the operator hunting a setting that is off.
    const got = parseReviewArgs('6711 --comment --effort low');
    expect(got.effort).toBe('high');
    expect(got.effortSource).toBe('forced-by-comment');
    expect(got.warnings).toContain(
      '`--comment` requires a verified review; running at high effort.',
    );
    expect(
      got.warnings.some((w) => w.includes('`review.comment` is enabled')),
    ).toBe(false);
  });

  it('the standing comment setting stays inert on a local target', () => {
    const got = parseReviewArgs('', { comment: true });
    expect(got.comment.effective).toBe(false);
    expect(got.effort).toBe('medium');
    expect(got.effortSource).toBe('default');
    expect(got.warnings).toHaveLength(0);
  });

  it('a configured effort above the built-in default applies to local targets', () => {
    const got = parseReviewArgs('', { effort: 'high' });
    expect(got.effort).toBe('high');
    expect(got.effortSource).toBe('configured');
  });

  it('an invalid explicit --effort falls back to the configured default and says so', () => {
    // The resolution text names what is ACTUALLY in effect; the `configured`
    // arm of that ternary is what this pins — every sibling arm is pinned
    // already, and a mutation to 'using the default effort' here must not
    // survive.
    const got = parseReviewArgs('6711 --effort bogus', { effort: 'medium' });
    expect(got.effort).toBe('medium');
    expect(got.effortSource).toBe('configured');
    expect(
      got.warnings.some((w) =>
        w.includes('using the configured review.effort'),
      ),
    ).toBe(true);
  });

  it('an invalid configured effort warns like the flag path instead of dropping silently', () => {
    // A hand-edited typo must not run every review at the built-in default
    // while the operator believes another level is on — the flag path warns
    // on the identical typo, so the configured path mirrors it.
    const got = parseReviewArgs('6711', { effort: 'hihg' });
    expect(got.effort).toBe('high');
    expect(got.effortSource).toBe('default');
    expect(got.warnings).toContain(
      'Invalid review.effort value "hihg" in settings; using the default effort.',
    );
  });

  it('a setting-forced high names the setting in the resolution, not a flag the user never typed', () => {
    // The invalid-effort warning states what is ACTUALLY in effect; when the
    // forcing came from the standing setting it must not claim `--comment`.
    const got = parseReviewArgs('6711 --effort bogus', {
      comment: true,
      effort: 'medium',
    });
    expect(got.effort).toBe('high');
    expect(got.effortSource).toBe('forced-by-comment');
    const invalidWarning = got.warnings.find((w) => w.includes('"bogus"'));
    expect(invalidWarning).toContain(
      'the `review.comment` setting forces high effort',
    );
    expect(invalidWarning).not.toContain('`--comment` forces high effort');
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
    // The flag drove the forcing — the resolution must name the flag, not a
    // setting that is off (both branches contain 'forces high effort').
    expect(invalidWarning).toContain('`--comment` forces high effort');
    expect(invalidWarning).not.toContain('review.comment');
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

/**
 * Settings wiring: the real handler, not the pure function. Deleting
 * `reviewDefaultsFromSettings()` from the handler leaves every pure-function
 * test above green while real `/review` invocations silently ignore the
 * configured effort/comment — so these drive the yargs command with a
 * configurable settings mock.
 */
describe('parseArgsCommand — configured defaults wiring', () => {
  beforeEach(() => {
    fsState.stdin = '';
    fsState.written.clear();
    vi.mocked(writeStdoutLine).mockClear();
    reviewSettingsMock.mockReturnValue({});
  });

  async function verdictFor(stdin: string): Promise<ParsedReviewArgs> {
    fsState.stdin = stdin;
    await yargs(['parse-args', '--stdin'])
      .command(parseArgsCommand)
      .strict()
      .exitProcess(false)
      .fail((msg, err) => {
        throw err ?? new Error(msg ?? 'yargs failure');
      })
      .parseAsync();
    const calls = vi.mocked(writeStdoutLine).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return JSON.parse(String(calls[calls.length - 1][0])) as ParsedReviewArgs;
  }

  it('a configured effort reaches the verdict through the handler', async () => {
    reviewSettingsMock.mockReturnValue({ effort: 'medium' });
    const got = await verdictFor('6711\n');
    expect(got.effort).toBe('medium');
    expect(got.effortSource).toBe('configured');
  });

  it('a configured comment setting makes comment effective through the handler', async () => {
    reviewSettingsMock.mockReturnValue({ comment: true });
    const got = await verdictFor('6711\n');
    expect(got.comment).toEqual({ requested: false, effective: true });
  });

  it('normalizes a case-variant configured effort like the flag path', async () => {
    // `"Low"` unnormalized misses the exact `effort === 'low'` comparisons
    // the forcings run — the `--fix` floor would never fire.
    reviewSettingsMock.mockReturnValue({ effort: 'Low' });
    const got = await verdictFor('src/foo.ts --fix\n');
    expect(got.effort).toBe('medium');
    expect(got.effortSource).toBe('forced-by-fix');
  });

  it('maps a configured auto effort to the built-in rule without warning', async () => {
    // The schema default written explicitly must behave exactly like the
    // setting's absence. Deleting the `auto` arm of reviewDefaultsFromSettings
    // leaves the resolved effort correct while every run warns about a value
    // that means the default — nothing else would surface the regression.
    reviewSettingsMock.mockReturnValue({ effort: 'auto' });
    const got = await verdictFor('6711\n');
    expect(got.effort).toBe('high');
    expect(got.effortSource).toBe('default');
    expect(got.warnings).toHaveLength(0);
  });

  it('maps a case-variant auto effort like auto', async () => {
    // `"Auto"` means exactly the built-in default the operator in fact gets;
    // a case-sensitive comparison drew a factually wrong invalid-value
    // warning on every run instead.
    reviewSettingsMock.mockReturnValue({ effort: 'Auto' });
    const got = await verdictFor('6711\n');
    expect(got.effort).toBe('high');
    expect(got.effortSource).toBe('default');
    expect(got.warnings).toHaveLength(0);
  });

  it('discards an invalid configured effort, warning instead of dropping it silently', async () => {
    reviewSettingsMock.mockReturnValue({ effort: 'bogus' });
    const got = await verdictFor('6711\n');
    expect(got.effort).toBe('high');
    expect(got.effortSource).toBe('default');
    expect(
      got.warnings.some((w) =>
        w.includes('Invalid review.effort value "bogus" in settings'),
      ),
    ).toBe(true);
  });

  it('a configured severityFloor reaches the verdict through the handler', async () => {
    // Deleting the severityFloor line of reviewDefaultsFromSettings leaves
    // every pure-parser test green while production silently ignores the
    // setting — same seam as the effort/comment cases above.
    reviewSettingsMock.mockReturnValue({ severityFloor: 'critical' });
    const got = await verdictFor('6711\n');
    expect(got.severityFloor).toBe('critical');
    expect(got.severityFloorSource).toBe('configured');
  });

  it('discards an invalid configured severityFloor, warning instead of dropping it silently', async () => {
    // Parity with the effort twin: a settings-layer "validation" that
    // silently dropped non-enum values would leave every pure-parser test
    // green while the operator's typo takes effect as silence.
    reviewSettingsMock.mockReturnValue({ severityFloor: 'bogus' });
    const got = await verdictFor('6711\n');
    expect(got.severityFloor).toBe('auto');
    expect(
      got.warnings.some((w) =>
        w.includes('Invalid review.severityFloor value "bogus" in settings'),
      ),
    ).toBe(true);
  });

  it('maps a configured auto severityFloor to the round-adaptive default without warning', async () => {
    reviewSettingsMock.mockReturnValue({ severityFloor: 'Auto' });
    const got = await verdictFor('6711\n');
    expect(got.severityFloor).toBe('auto');
    expect(got.severityFloorSource).toBe('default');
    expect(got.warnings).toHaveLength(0);
  });

  it('ignores workspace settings — the policy keys resolve from operator scopes only', async () => {
    // The mock answers a flag-less loadSettings call with a workspace-
    // polluted view (comment on, low effort); the handler's
    // skipWorkspaceSettings flag keeps it out. Dropping the flag reddens
    // this for every key at once.
    const got = await verdictFor('6711\n');
    expect(got.comment).toEqual({ requested: false, effective: false });
    expect(got.effort).toBe('high');
    expect(got.effortSource).toBe('default');
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
