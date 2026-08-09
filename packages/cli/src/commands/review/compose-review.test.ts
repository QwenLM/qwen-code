/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { promptRecordDir, briefPath } from './lib/prompt-record.js';
import { writeBudgetStop } from './lib/deadline.js';
import { getGhHost, setGhHost } from './lib/gh.js';
import { parseLedger } from './lib/ledger.js';
import { countInlineFindings } from './lib/inline-counts.js';
import {
  composeReview,
  buildLedger,
  repositoryContextGate,
  scriptLintGate,
  testPlanGate,
  composeReviewCommand,
  describeChunkGap,
  verdictLine,
  type ComposeReviewInput,
  type ComposeReviewResult,
  type PrBodyFetcher,
} from './compose-review.js';

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn(),
}));
vi.mock('../../utils/version.js', () => ({
  getCliVersion: vi.fn().mockResolvedValue('0.21.2'),
}));
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';

const runComposeReviewCommand = (argv: unknown): Promise<void> =>
  Promise.resolve(composeReviewCommand.handler(argv as never) as void);

const ghMock = vi.hoisted(() => vi.fn((..._args: string[]) => ''));
vi.mock('./lib/gh.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/gh.js')>();
  return {
    ...actual,
    gh: ghMock,
  };
});

const MODEL = 'test-model';

// Coverage is read from the harness's transcripts on disk, so the fixtures build
// them: a plan, and the `agent-<id>.jsonl` files the harness would have written.
let dir: string;
/** Passed explicitly, so these tests never race another suite over process.env. */
let ENV: NodeJS.ProcessEnv;
// The captured diff, and its content hash. A REAL file (not just a token): coverage
// only string-matches this path in the agents' prompts, but the script-lint gate
// re-hashes it for its freshness check — so a plan that arms the gate needs a diff
// that actually exists, and a report that binds to its hash to read as fresh.
let DIFF: string;
let DIFF_HASH: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'compose-cov-'));
  ENV = { QWEN_CODE_PROJECT_DIR: dir, QWEN_CODE_SESSION_ID: 'S1' };
  mkdirSync(join(dir, 'subagents', 'S1'), { recursive: true });
  DIFF = join(dir, 'the.diff');
  writeFileSync(DIFF, 'diff --git a/a.ts b/a.ts\n@@ -0,0 +1 @@\n+x\n');
  DIFF_HASH = createHash('sha256').update(readFileSync(DIFF)).digest('hex');
  ghMock.mockClear();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Write a plan with two chunks, and return its path.
 *
 * A territory fan-out captured cross-repo, with no deletions: the smallest plan
 * whose roster is exactly the chunks plus the test matrix. `coveredPlan()` below
 * satisfies that one. A plan that requires nothing is not a plan any capture
 * command writes, and coverage now reads the roster out of it.
 */
function plan(
  opts: {
    step45?: boolean;
    han?: boolean;
    effort?: 'low' | 'medium' | 'high';
    /** Override the fixture's 5000 — the low-signal floor reads this. */
    srcDiffLines?: number;
    repositoryContext?: unknown;
  } = {},
): string {
  const p = join(dir, 'plan.json');
  writeFileSync(
    p,
    JSON.stringify({
      diffPathAbsolute: DIFF,
      // What fetch-pr records when the PR description contains Han
      // characters — the deterministic bilingual-body switch.
      ...(opts.han ? { prDescriptionHasHan: true } : {}),
      // The effort the capturing command recorded — the roster and the
      // reverse-audit floor both read it from here.
      ...(opts.effort ? { effort: opts.effort } : {}),
      ...(opts.repositoryContext === undefined
        ? {}
        : { repositoryContext: opts.repositoryContext }),
      srcDiffLines: opts.srcDiffLines ?? 5000,
      diffLines: 5000,
      files: [{ path: 'a.ts', kind: 'source', removedLines: 0, heavy: false }],
      // Real plans carry each chunk's files (`DiffChunk.files`) — the body
      // renderer names THEM, never the chunk id, so the fixture carries them
      // too. The 3A fixture below stays file-less on purpose: it is the
      // pre-files plan shape, and the renderer must fall back to counting.
      chunks: [
        {
          id: 1,
          startLine: 1,
          endLine: 100,
          files: [{ path: 'src/a.ts', newStart: 1, newEnd: 80 }],
        },
        {
          id: 2,
          startLine: 101,
          endLine: 200,
          files: [{ path: 'src/b.ts', newStart: 1, newEnd: 90 }],
        },
      ],
    }),
  );
  // Every high-effort review runs Step 4 (verify) and Step 5 (reverse audit), and
  // `composeReview` now proves they did — so a fixture meaning "a review that did
  // everything right" includes them, exactly as it includes the roster. Pass
  // `{ step45: false }` for a run that skipped one or both (the gap tests).
  if (opts.step45 !== false) recordStep45(p);
  // Backdate it. The transcripts are written first and the stale-transcript
  // filter is `mtime < planMtime`; on a filesystem with millisecond granularity
  // both land in the same tick and the comparison flips at random. An explicit
  // gap makes the fixture say what it means: these transcripts are newer.
  const old = new Date(2020, 0, 1);
  utimesSync(p, old, old);
  return p;
}

/**
 * Lay down the Step 4 verifier and Step 5 reverse auditor a complete high-effort
 * review runs: each one's recorded prompt, its brief, and the harness's transcript
 * of an agent launched with it that opened the brief. Neither names a line range,
 * so neither grants chunk coverage — they answer only "did the step run", which is
 * what `verificationGaps` asks. Pass a subset of `keys` to model a skipped step.
 */
function recordStep45(
  planPath: string,
  keys: string[] = ['verify', 'reverse-audit'],
): void {
  const d = promptRecordDir(planPath);
  mkdirSync(d, { recursive: true });
  for (const key of keys) {
    const brief = briefPath(planPath, key);
    writeFileSync(brief, `The ${key} brief.`);
    const launch =
      `You are review agent \`${key}\`.\n` +
      `read_file(file_path="${brief}")\n` +
      `read_file(file_path="${DIFF}")`;
    // Match production (`prompt-record.ts`): the record filename is the
    // percent-encoded key. A no-op for `verify`/`reverse-audit`, but a future role
    // whose name `encodeURIComponent` transforms would otherwise be written to a
    // name the reader never looks for.
    writeFileSync(join(d, `${encodeURIComponent(key)}.txt`), launch);
    transcript(`v-${key.replace(/[^a-z0-9]/gi, '_')}`, launch, {
      toolCalls: 2,
      opens: [brief],
    });
  }
}

/** Write one agent transcript, as the harness would. */
function transcript(
  id: string,
  launchPrompt: string,
  opts: {
    toolCalls?: number;
    text?: string;
    opens?: string[];
    /** `[offset, limit]` making the diff reads ranged, as a compliant agent's are. */
    range?: [number, number];
  } = {},
): void {
  const pointedAtBriefs = [
    ...launchPrompt.matchAll(/read_file\(file_path="([^"]*\.brief\.md)"\)/g),
  ].map((m) => m[1]);
  const working = (opts.toolCalls ?? 0) > 0;
  const opens = opts.opens ?? (working ? pointedAtBriefs : []);
  const base = { agentId: id, agentName: 'general-purpose', sessionId: 'S1' };
  const lines: string[] = [
    JSON.stringify({
      ...base,
      type: 'user',
      message: { role: 'user', parts: [{ text: launchPrompt }] },
    }),
  ];
  for (let i = 0; i < (opts.toolCalls ?? 0); i++) {
    lines.push(
      JSON.stringify({
        ...base,
        type: 'assistant',
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'read_file',
                args: opts.range
                  ? {
                      file_path: DIFF,
                      offset: opts.range[0],
                      limit: opts.range[1],
                    }
                  : { file_path: DIFF },
              },
            },
          ],
        },
      }),
      JSON.stringify({
        ...base,
        type: 'tool_result',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'read_file',
                response: { output: 'ok' },
              },
            },
          ],
        },
      }),
    );
  }
  for (const path of opens) {
    lines.push(
      JSON.stringify({
        ...base,
        type: 'assistant',
        message: {
          role: 'model',
          parts: [
            { functionCall: { name: 'read_file', args: { file_path: path } } },
          ],
        },
      }),
      JSON.stringify({
        ...base,
        type: 'tool_result',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'read_file',
                response: { output: 'brief' },
              },
            },
          ],
        },
      }),
    );
  }
  lines.push(
    JSON.stringify({
      ...base,
      type: 'assistant',
      message: {
        role: 'model',
        parts: [{ text: opts.text ?? 'No issues found.' }],
      },
    }),
  );
  writeFileSync(
    join(dir, 'subagents', 'S1', `agent-${id}.jsonl`),
    lines.join('\n') + '\n',
  );
}

/**
 * A prompt the CLI would have built: it names the diff and the read of THIS
 * chunk's lines. The offsets are the chunk's own, as `agent-prompt` emits them —
 * coverage is attributed from the range delivered, not from the words `chunk N`.
 */
function goodPrompt(chunk: number): string {
  const offset = (chunk - 1) * 100;
  const brief = briefPath(join(dir, 'plan.json'), `chunk-${chunk}`);
  return (
    `You are reviewing chunk ${chunk} of 2.\n` +
    `read_file(file_path="${brief}")\n` +
    `read_file(file_path="${DIFF}", offset=${offset}, limit=100)`
  );
}

/** Lay down the CLI's record of the prompt it built for `chunk`. */
function recordBuilt(planPath: string, chunk: number): void {
  const d = promptRecordDir(planPath);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `chunk-${chunk}.txt`), goodPrompt(chunk));
  writeFileSync(briefPath(planPath, `chunk-${chunk}`), `chunk-${chunk} brief`);
}

/**
 * The one whole-diff agent this plan's roster requires, built and launched.
 *
 * Its prompt names no line ranges, so it grants no coverage — a review may not
 * certify lines on the strength of "somebody had the file open".
 */
function recordMatrix(planPath: string): void {
  const d = promptRecordDir(planPath);
  mkdirSync(d, { recursive: true });
  const brief = briefPath(planPath, 'test-matrix');
  writeFileSync(brief, 'The test-matrix brief.');
  const launch = `You are the test-coverage matrix agent.\nread_file(file_path="${brief}")\nread_file(file_path="${DIFF}")`;
  writeFileSync(join(d, 'test-matrix.txt'), launch);
  transcript('tm', launch, { toolCalls: 2, opens: [brief] });
}

/** The prompt the orchestrator actually sent, 23 times: no diff anywhere. */
function blindPrompt(chunk: number): string {
  return `The changes are in chunk ${chunk} of 2, covering lines 1-100 of the diff.`;
}

/**
 * Both chunks reviewed by agents that opened the diff, and Step 4/5 ran — a
 * complete high-effort review. Pass a subset of keys to model a run that skipped a
 * step (what the (B) gap tests are about); `plan({ step45: false })` suppresses the
 * default pair so this controls them exactly.
 */
function coveredPlan(
  step45Keys: string[] = ['verify', 'reverse-audit'],
  planOpts: {
    han?: boolean;
    effort?: 'low' | 'medium' | 'high';
    srcDiffLines?: number;
    repositoryContext?: unknown;
  } = {},
): string {
  transcript('a1', goodPrompt(1), { toolCalls: 3 });
  transcript('a2', goodPrompt(2), { toolCalls: 2 });
  const p = plan({ step45: false, ...planOpts });
  recordBuilt(p, 1);
  recordBuilt(p, 2);
  recordMatrix(p);
  recordStep45(p, step45Keys);
  return p;
}

/** Agents given the diff, that never opened it — and said so at length. */
function idlePlan(): string {
  transcript('a1', goodPrompt(1), {
    toolCalls: 0,
    text: 'No issues found — reviewed chunk 1 (src/pay.ts) thoroughly.',
  });
  transcript('a2', goodPrompt(2), { toolCalls: 0 });
  return plan();
}

/** Agents launched with no diff in their prompt. They could not have read it. */
function blindPlan(): string {
  transcript('a1', blindPrompt(1), { toolCalls: 0 });
  transcript('a2', blindPrompt(2), { toolCalls: 0 });
  return plan();
}

const FOOTER = `_— ${MODEL} via Qwen Code /review (vunknown)_`;

function base(overrides: Partial<ComposeReviewInput>): ComposeReviewInput {
  return {
    criticalsInline: 0,
    suggestionsInline: 0,
    // These cases exercise the C/S table, the body clauses and the downgrades —
    // not coverage. Coverage is no longer an input at all (it is recomputed from
    // the harness's transcripts), so a table test that means to reach a clean
    // APPROVE points at a plan whose agents did read it. See coveredPlan().
    planPath: coveredPlan(),
    env: ENV,
    modelId: MODEL,
    ...overrides,
  };
}

describe('composeReview — the C/S table', () => {
  it('C=0, S=0 → APPROVE with the LGTM body', () => {
    const r = composeReview(base({}));
    expect(r.event).toBe('APPROVE');
    expect(r.body).toBe(`No issues found. LGTM! ✅\n\n${FOOTER}`);
  });

  it('includes the injected CLI version without breaking the stable marker', () => {
    const r = composeReview(base({}), '0.21.2');
    expect(r.body).toContain('via Qwen Code /review');
    expect(
      r.body.endsWith(`_— ${MODEL} via Qwen Code /review (v0.21.2)_`),
    ).toBe(true);
  });

  it('C=0, S≥1 → COMMENT with the no-blockers opener', () => {
    const r = composeReview(base({ suggestionsInline: 2 }));
    expect(r.event).toBe('COMMENT');
    expect(r.body).toBe(
      `Reviewed — no blockers. Suggestions are inline.\n\n${FOOTER}`,
    );
  });

  it('C≥1 → REQUEST_CHANGES with an empty body', () => {
    const r = composeReview(base({ criticalsInline: 1, suggestionsInline: 3 }));
    expect(r.event).toBe('REQUEST_CHANGES');
    expect(r.body).toBe('');
  });

  it('a body-only Critical counts toward C and is the RC body', () => {
    const r = composeReview(base({ bodyCriticals: ['whole-PR blocker X'] }));
    expect(r.event).toBe('REQUEST_CHANGES');
    expect(r.body).toContain('**[Critical]** whole-PR blocker X');
  });
});

describe('composeReview — the low-signal Approve disclosure', () => {
  // The coverage gate proves the agents READ the diff, not that the review had
  // discriminating power: a dogfooded weak-model run drafted nothing from all
  // of its agents on a non-trivial source diff where stronger same-condition
  // runs found a verified blocker, and composed a bare confident Approve.
  it('a zero-finding APPROVE over a non-trivial source diff carries the marker — event and body unchanged', () => {
    const r = composeReview(base({}));
    expect(r.event).toBe('APPROVE');
    expect(r.body).toBe(`No issues found. LGTM! ✅\n\n${FOOTER}`);
    // The fixture's roster: two chunk agents plus the test matrix.
    expect(r.lowSignal).toEqual({ agents: 3, srcDiffLines: 5000 });
    expect(verdictLine(r)).toBe(
      'Verdict: Approve — low signal: none of the 3 review agents reported ' +
        'a finding on a non-trivial diff (5000 source diff lines)',
    );
  });

  it('a docs-only diff keeps the bare Approve — finding nothing there is the expected outcome', () => {
    const r = composeReview({
      planPath: coveredPlan(undefined, { srcDiffLines: 0 }),
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).toBe('APPROVE');
    expect(r.lowSignal).toBeNull();
    expect(verdictLine(r)).toBe('Verdict: Approve');
  });

  it('a tiny source change at the floor keeps the bare Approve — the marker needs strictly more', () => {
    const r = composeReview({
      planPath: coveredPlan(undefined, { srcDiffLines: 100 }),
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).toBe('APPROVE');
    expect(r.lowSignal).toBeNull();
    expect(verdictLine(r)).toBe('Verdict: Approve');
  });

  it('a review with findings never carries the marker — low signal is about empty reviews', () => {
    const r = composeReview(base({ suggestionsInline: 1 }));
    expect(r.event).toBe('COMMENT');
    expect(r.lowSignal).toBeNull();
    expect(verdictLine(r)).not.toContain('low signal');
  });
});

describe('repository context proof boundary', () => {
  it('derives unreviewed dimensions from the validated plan, not model input', () => {
    const planPath = join(dir, 'repository-plan.json');
    writeFileSync(
      planPath,
      JSON.stringify({
        repositoryContext: {
          version: 1,
          provider: 'fake-provider',
          label: 'Example project',
          domains: ['runtime'],
          relatedPaths: [],
          recommendedTests: [],
          requiredConfigurations: ['linux-x64'],
          requiredAgents: ['test-matrix'],
          unverifiedDimensions: ['Alternate runtime was not exercised'],
          verificationNotes: [],
        },
      }),
    );
    expect(repositoryContextGate(planPath)).toEqual([
      '`Alternate runtime was not exercised` — the repository context marks this proof boundary as unverified',
    ]);
  });

  it('renders manifest-controlled proof boundaries as inert Markdown', () => {
    const planPath = join(dir, 'mention-plan.json');
    writeFileSync(
      planPath,
      JSON.stringify({
        repositoryContext: {
          version: 1,
          provider: 'manifest',
          label: 'Example project',
          domains: [],
          relatedPaths: [],
          recommendedTests: [],
          requiredConfigurations: [],
          requiredAgents: [],
          unverifiedDimensions: ['@security-team'],
          verificationNotes: [],
        },
      }),
    );
    expect(repositoryContextGate(planPath)).toEqual([
      '`@security-team` — the repository context marks this proof boundary as unverified',
    ]);
  });

  it('caps the unverified-dimension disclosure at five entries', () => {
    // The schema admits 128 dimensions x 512 chars; joined into one
    // disclosure that outruns the review body's own size budget — the same
    // cap discipline testPlanGate applies to its notes.
    const planPath = join(dir, 'capped-plan.json');
    writeFileSync(
      planPath,
      JSON.stringify({
        repositoryContext: {
          version: 1,
          provider: 'fake-provider',
          label: 'Example project',
          domains: [],
          relatedPaths: [],
          recommendedTests: [],
          requiredConfigurations: [],
          requiredAgents: [],
          unverifiedDimensions: Array.from(
            { length: 8 },
            (_, index) => `dimension ${index}`,
          ),
          verificationNotes: [],
        },
      }),
    );
    expect(repositoryContextGate(planPath)).toEqual([
      ...Array.from(
        { length: 5 },
        (_, index) =>
          `\`dimension ${index}\` — the repository context marks this proof boundary as unverified`,
      ),
      'and 3 more',
    ]);
  });

  it('returns no extra disclosure when the plan has no repository context', () => {
    const planPath = join(dir, 'generic-plan.json');
    writeFileSync(planPath, JSON.stringify({ files: [] }));
    expect(repositoryContextGate(planPath)).toEqual([]);
  });

  it('returns nothing for an unreadable plan but fails closed on a malformed context', () => {
    // Unreadable plan: the coverage gate owns plan validity; the disclosure
    // has nothing to say. Present-but-INVALID context: every consumer of the
    // field fails closed, so the gate throws instead of silently dropping the
    // disclosure.
    const missing = join(dir, 'missing-plan.json');
    expect(repositoryContextGate(missing)).toEqual([]);

    const malformed = join(dir, 'malformed-plan.json');
    writeFileSync(
      malformed,
      JSON.stringify({ repositoryContext: { version: 1 } }),
    );
    expect(() => repositoryContextGate(malformed)).toThrow(
      'unknown or missing fields',
    );
  });

  it('keeps the disclosure on a REQUEST_CHANGES body', () => {
    // The RC render site is a separate code path from APPROVE; deleting the
    // block there must fail the suite, not ship green.
    const planPath = coveredPlan(undefined, {
      repositoryContext: {
        version: 1,
        provider: 'fake-provider',
        label: 'Example project',
        domains: [],
        relatedPaths: [],
        recommendedTests: [],
        requiredConfigurations: [],
        requiredAgents: [],
        unverifiedDimensions: ['Alternate runtime was not exercised'],
        verificationNotes: [],
      },
    });
    const result = composeReview({
      planPath,
      env: ENV,
      modelId: MODEL,
      bodyCriticals: ['whole-PR blocker X'],
    });
    expect(result.event).toBe('REQUEST_CHANGES');
    expect(result.body).toContain('Repository proof boundary (not a blocker)');
    expect(result.body).toContain('Alternate runtime was not exercised');
  });

  it('keeps the disclosure when a cap downgrades the verdict to COMMENT', () => {
    // An APPROVE capped at COMMENT renders through the COMMENT clause
    // composer — the third render site — and the disclosure must survive
    // exactly the verdicts where the reader most needs the boundary.
    const planPath = coveredPlan(undefined, {
      repositoryContext: {
        version: 1,
        provider: 'fake-provider',
        label: 'Example project',
        domains: [],
        relatedPaths: [],
        recommendedTests: [],
        requiredConfigurations: [],
        requiredAgents: [],
        unverifiedDimensions: ['Alternate runtime was not exercised'],
        verificationNotes: [],
      },
    });
    const result = composeReview({
      planPath,
      env: ENV,
      modelId: MODEL,
      cannotTellCriticals: ['SKILL.md:35 — full text unfetchable'],
    });
    expect(result.event).toBe('COMMENT');
    expect(result.cappedBy).toContain('cannot-tell-existing-critical');
    expect(result.body).toContain('Repository proof boundary (not a blocker)');
    expect(result.body).toContain('Alternate runtime was not exercised');
  });

  it('discloses repository proof boundaries without permanently capping approval', () => {
    const planPath = coveredPlan(undefined, {
      repositoryContext: {
        version: 1,
        provider: 'fake-provider',
        label: 'Example project',
        domains: ['runtime'],
        relatedPaths: [],
        recommendedTests: [],
        requiredConfigurations: ['linux-x64'],
        requiredAgents: [],
        unverifiedDimensions: ['Alternate runtime was not exercised'],
        verificationNotes: [],
      },
    });

    const result = composeReview({ planPath, env: ENV, modelId: MODEL });

    expect(result.event).toBe('APPROVE');
    expect(result.cappedBy).not.toContain('unreviewed-dimension');
    expect(result.body).toContain('Repository proof boundary (not a blocker)');
    expect(result.body).toContain('Alternate runtime was not exercised');
  });
});

describe('composeReview — event caps (round-7 Critical #2: caps must reach every path)', () => {
  it('a cannot-tell existing Critical caps APPROVE at COMMENT and is serialized (round-7: body said Unresolved while event said APPROVE)', () => {
    const r = composeReview(
      base({ cannotTellCriticals: ['SKILL.md:35 — full text unfetchable'] }),
    );
    expect(r.event).toBe('COMMENT');
    expect(r.cappedBy).toContain('cannot-tell-existing-critical');
    expect(r.body).toContain('Unresolved, please confirm:');
    expect(r.body).toContain('**[Critical]** SKILL.md:35');
    expect(r.body).not.toContain('no blockers');
    expect(r.body).not.toContain('LGTM');
  });

  it('an unreviewed dimension caps APPROVE at COMMENT (round-7 Critical #3: zero findings + whiffed Security must not LGTM)', () => {
    const r = composeReview(base({ unreviewedDimensions: ['security'] }));
    expect(r.event).toBe('COMMENT');
    expect(r.body).toContain(
      'Not reviewed: security — the agent returned no evidence of its walk twice.',
    );
    expect(r.body).not.toContain('LGTM');
    expect(r.body).not.toContain('no blockers');
  });

  it('a budget-stop marker caps APPROVE at COMMENT with nothing relayed by the caller', () => {
    // The round builder refused a round and recorded the refusal; the
    // disclosure that caps the verdict is synthesized from that marker, not
    // from a sentence the orchestrator remembered to carry.
    const plan = coveredPlan();
    writeBudgetStop(
      plan,
      {
        remainingSeconds: 900,
        reserveSeconds: 3600,
        expectedRoundSeconds: 1800,
      },
      4,
    );
    const r = composeReview(base({ planPath: plan }));
    expect(r.event).toBe('COMMENT');
    expect(r.body).toContain(
      'reverse audit — stopped before round 4 by the review time budget',
    );
    expect(r.body).not.toContain('LGTM');

    // And said once when the orchestrator DID relay it.
    const r2 = composeReview(
      base({
        planPath: plan,
        unreviewedDimensions: [
          'reverse audit — stopped before round 4 by the review time budget',
        ],
      }),
    );
    expect(r2.body.split('review time budget').length - 1).toBe(1);

    // Still once when the relay was RESHAPED — an orchestrator prefix ahead
    // of the subject. The coverage prefix filter cannot see this one (it no
    // longer starts with `reverse audit — `); only the marker-phrase splice
    // dedups it, so this is the assertion that fails when the splice goes.
    const r3 = composeReview(
      base({
        planPath: plan,
        unreviewedDimensions: [
          'step 5 — reverse audit — stopped before round 4 by the review time budget',
        ],
      }),
    );
    expect(r3.body.split('review time budget').length - 1).toBe(1);
  });

  it('the marker does not shadow other reverse-audit scopes the caller disclosed', () => {
    // The budget entry claims the subject `reverse audit`; the caller-echo
    // prefix filter must not let it swallow a DIFFERENT reverse-audit scope
    // reported with its own reason — a whiffed chunk from the rounds that
    // DID run is exactly what a partially-run audit still owes the author.
    const plan = coveredPlan();
    writeBudgetStop(
      plan,
      {
        remainingSeconds: 900,
        reserveSeconds: 3600,
        expectedRoundSeconds: 1800,
      },
      3,
    );
    const r = composeReview(
      base({
        planPath: plan,
        unreviewedDimensions: [
          "reverse audit — chunk 2's auditor returned nothing substantive twice",
        ],
      }),
    );
    expect(r.body).toContain(
      'Not reviewed: reverse audit — stopped before round 3 by the review time budget.',
    );
    expect(r.body).toContain(
      "Not reviewed: reverse audit — chunk 2's auditor returned nothing substantive twice.",
    );
    // The marker's own disclosure still renders exactly once.
    expect(r.body.split('review time budget').length - 1).toBe(1);
  });

  it('a round-1 budget stop stands alone — no rogue-audit gap, no rebuild FIX', () => {
    // The gate refused round 1, so no reverse-audit record exists. Without
    // the marker the floor would report the absence as a rogue/unlaunched
    // audit and direct a rebuild the same gate deterministically refuses
    // (exit 4) — misattributing a deliberate stop. The budget disclosure
    // must stand alone, and the remediation must stay silent.
    const plan = coveredPlan([]); // nothing ran: the round-1 refusal shape
    writeBudgetStop(
      plan,
      {
        remainingSeconds: 900,
        reserveSeconds: 3600,
        expectedRoundSeconds: 1800,
      },
      1,
    );
    // Not base(): its planPath default runs coveredPlan() again on the same
    // path and would re-record the Step 4/5 pair this case means to lack.
    const r = composeReview({ planPath: plan, env: ENV, modelId: MODEL });
    expect(r.event).toBe('COMMENT');
    expect(r.body).toContain(
      'Not reviewed: reverse audit — stopped before round 1 by the review time budget.',
    );
    expect(r.body).not.toContain('no auditor was launched');
    expect(r.body).not.toContain('its prompt was built');
    expect(r.remediation.join(' ')).not.toContain('reverse audit:');
  });

  it('renders the budget stop bilingually on a Han-description PR', () => {
    // Every sibling structural disclosure carries a zh pair; the budget stop
    // used to ride the caller-prose path and posted English into both halves.
    const plan = coveredPlan(['verify', 'reverse-audit'], { han: true });
    writeBudgetStop(
      plan,
      {
        remainingSeconds: 900,
        reserveSeconds: 3600,
        expectedRoundSeconds: 1800,
      },
      4,
    );
    // Not base(): its planPath default runs coveredPlan() again on the same
    // path and would overwrite the han-stamped plan.
    const r = composeReview({ planPath: plan, env: ENV, modelId: MODEL });
    expect(r.body).toContain(
      'Not reviewed: reverse audit — stopped before round 4 by the review time budget.',
    );
    expect(r.body).toContain(
      '未审查：反向审计——评审时间预算不足，未能开始第 4 轮。',
    );
  });

  it('a budget stop does not launder a rewritten pre-stop round', () => {
    // Round 1 RAN — with a hand-written launch that opened its brief but
    // never got the built prompt — and round 2 was then refused on the
    // budget. The marker explains the audit that never ran; it says nothing
    // about the one that did, and the rewritten disclosure is still owed:
    // without it, "stopped before round 2" implies round 1 was faithful.
    const plan = coveredPlan(['verify']);
    const d = promptRecordDir(plan);
    const brief = briefPath(plan, 'reverse-audit');
    writeFileSync(brief, 'The reverse-audit brief.');
    const built =
      'You are review agent `reverse-audit`.\n' +
      `read_file(file_path="${brief}")\n` +
      `read_file(file_path="${DIFF}")`;
    writeFileSync(join(d, 'reverse-audit.txt'), built);
    transcript(
      'v-ra-rewritten',
      `Audit the diff for gaps. Your brief: ${brief}. Diff: ${DIFF}.`,
      { toolCalls: 2, opens: [brief] },
    );
    writeBudgetStop(
      plan,
      {
        remainingSeconds: 900,
        reserveSeconds: 3600,
        expectedRoundSeconds: 1800,
      },
      2,
    );

    // Not base(): its planPath default runs coveredPlan() again on the same
    // path and would lay a verbatim reverse-audit pair over this fixture.
    const r = composeReview({ planPath: plan, env: ENV, modelId: MODEL });
    expect(r.event).toBe('COMMENT');
    // The marker still discloses and caps…
    expect(r.body).toContain(
      'stopped before round 2 by the review time budget',
    );
    // …and the rewritten round is NOT laundered: the operator channel carries
    // its exact repair. (The posted body collapses same-subject disclosures —
    // both say "reverse audit" — so the author sees the stop; the rewritten
    // repair rides stderr, which is where repairs are acted on.)
    expect(r.remediation.join(' ')).toContain('reverse audit:');
    expect(r.remediation.join(' ')).toContain('EXACTLY what it prints');
  });

  it('an uncoverable chunk caps APPROVE at COMMENT and names the chunk', () => {
    const r = composeReview(
      base({ uncoverableChunks: ['chunk 5 (src/big.min.js)'] }),
    );
    expect(r.event).toBe('COMMENT');
    expect(r.body).toContain('Not reviewed: chunk 5 (src/big.min.js)');
  });

  it('caps never soften a REQUEST_CHANGES earned by a confirmed Critical', () => {
    const r = composeReview(
      base({
        criticalsInline: 1,
        cannotTellCriticals: ['old blocker'],
        unreviewedDimensions: ['security'],
      }),
    );
    expect(r.event).toBe('REQUEST_CHANGES');
  });

  it('a Suggestion-only COMMENT with a cap loses the certifying opener', () => {
    const r = composeReview(
      base({ suggestionsInline: 1, unreviewedDimensions: ['security'] }),
    );
    expect(r.event).toBe('COMMENT');
    expect(r.body).toContain('Reviewed. Suggestions are inline.');
    expect(r.body).not.toContain('no blockers');
  });
});

describe('composeReview — context-unavailable (clause 2)', () => {
  it('caps APPROVE and replaces the opener with the diff-only sentence', () => {
    const r = composeReview(base({ contextUnavailable: true }));
    expect(r.event).toBe('COMMENT');
    expect(r.body).toContain('Reviewed diff-only');
    expect(r.body).not.toContain('Reviewed — no blockers');
    expect(r.body).not.toContain('LGTM');
  });

  it('suggestion-only stays non-certifying under clause 2 with no duplicate opener', () => {
    const r = composeReview(
      base({ suggestionsInline: 2, contextUnavailable: true }),
    );
    expect(r.event).toBe('COMMENT');
    expect(r.body).toContain('Reviewed diff-only');
    expect(r.body).toContain('Suggestions are inline.');
    expect(r.body).not.toMatch(/Reviewed\.\s/);
  });

  it('does not soften a REQUEST_CHANGES', () => {
    const r = composeReview(
      base({ criticalsInline: 1, contextUnavailable: true }),
    );
    expect(r.event).toBe('REQUEST_CHANGES');
  });
});

describe('composeReview — 422 recovery (round-7 Critical #1 & round-6: verdict never upgrades)', () => {
  it('all Suggestions discarded on resubmit stays COMMENT, never APPROVE (round-6: Suggestion-only flipped to LGTM)', () => {
    // Before the 422: S=2. After dropping both anchors: recompose.
    const r = composeReview(base({ suggestionsDiscarded: 2 }));
    expect(r.event).toBe('COMMENT');
    // Self-contained for the PR author — the old text said "see the terminal
    // output", a terminal only the operator has.
    expect(r.body).toContain(
      '2 Suggestion-level finding(s) could not be anchored to a changed line and were dropped; nothing further to act on here.',
    );
    expect(r.body).not.toContain('terminal output');
    // Nothing is inline — the body must not claim otherwise while the
    // discarded sentence says the opposite (round-9: `s` included discarded).
    expect(r.body).not.toContain('Suggestions are inline.');
    expect(r.event).not.toBe('APPROVE');
  });

  it('mixed inline/discarded Suggestions carries both sentences', () => {
    const r = composeReview(
      base({ suggestionsInline: 1, suggestionsDiscarded: 1 }),
    );
    expect(r.body).toContain('Suggestions are inline.');
    expect(r.body).toContain('1 Suggestion-level finding(s)');
  });

  it('a relocated Critical keeps REQUEST_CHANGES with the blocker as the body', () => {
    const r = composeReview(
      base({ bodyCriticals: ['relocated after 422'], suggestionsInline: 1 }),
    );
    expect(r.event).toBe('REQUEST_CHANGES');
    expect(r.body).toContain('**[Critical]** relocated after 422');
  });
});

describe('composeReview — presubmit downgrades', () => {
  it('downgradeApprove turns a clean APPROVE into COMMENT with the downgrade sentence', () => {
    const r = composeReview(
      base({
        presubmit: {
          downgradeApprove: true,
          downgradeReasons: ['self-PR', 'CI still running'],
        },
      }),
    );
    expect(r.event).toBe('COMMENT');
    expect(r.downgraded).toBe(true);
    expect(r.body).toContain(
      '⚠️ Downgraded from Approve to Comment: self-PR; CI still running.',
    );
  });

  it('a downgraded Approve never certifies "no blockers" in the same body (the downgrade names failing CI two clauses earlier)', () => {
    const r = composeReview(
      base({
        presubmit: {
          downgradeApprove: true,
          downgradeReasons: ['CI failing'],
        },
      }),
    );
    expect(r.event).toBe('COMMENT');
    expect(r.body).toContain('Downgraded from Approve');
    expect(r.body).toContain('Reviewed.');
    expect(r.body).not.toContain('no blockers');
    expect(r.body).not.toContain('LGTM');
  });

  it('downgradeRequestChanges on a clean RC (inline Criticals only) carries the sentence and no Critical block', () => {
    const r = composeReview(
      base({
        criticalsInline: 1,
        presubmit: {
          downgradeRequestChanges: true,
          downgradeReasons: ['self-PR'],
        },
      }),
    );
    expect(r.event).toBe('COMMENT');
    expect(r.downgraded).toBe(true);
    expect(r.body).toContain('Downgraded from Request changes to Comment');
    expect(r.body).not.toContain('**[Critical]**');
  });

  it('downgradeApprove on a Suggestion-only review changes nothing — the verdict was already Comment', () => {
    const r = composeReview(
      base({
        suggestionsInline: 1,
        presubmit: { downgradeApprove: true, downgradeReasons: ['self-PR'] },
      }),
    );
    expect(r.event).toBe('COMMENT');
    expect(r.downgraded).toBe(false);
    expect(r.body).not.toContain('Downgraded');
  });

  it('self-PR downgrade of an RC keeps the body Criticals after the downgrade sentence (round-3 bug: the only copy of a blocker vanished)', () => {
    const r = composeReview(
      base({
        bodyCriticals: ['unmappable blocker'],
        presubmit: {
          downgradeRequestChanges: true,
          downgradeReasons: ['self-PR'],
        },
      }),
    );
    expect(r.event).toBe('COMMENT');
    expect(r.downgraded).toBe(true);
    expect(r.body).toContain('⚠️ Downgraded from Request changes to Comment');
    expect(r.body).toContain('**[Critical]** unmappable blocker');
    const sentenceIdx = r.body.indexOf('Downgraded');
    const blockerIdx = r.body.indexOf('unmappable blocker');
    expect(sentenceIdx).toBeLessThan(blockerIdx);
  });

  it('body Criticals never leak into a plain COMMENT that was not downgraded from RC', () => {
    // Defensive: bodyCriticals imply C>=1 so a plain COMMENT cannot carry
    // them — but the composer must not print them even if handed both.
    const r = composeReview(base({ suggestionsInline: 1 }));
    expect(r.body).not.toContain('**[Critical]**');
  });
});

describe('composeReview — stacked states compose, none erased', () => {
  it('downgrade + cannot-tell + discarded suggestions + unreviewed dimension all appear once', () => {
    const r = composeReview(
      base({
        suggestionsInline: 1,
        suggestionsDiscarded: 1,
        cannotTellCriticals: ['old blocker at a.ts:1'],
        unreviewedDimensions: ['security'],
        presubmit: { downgradeApprove: true, downgradeReasons: ['self-PR'] },
      }),
    );
    expect(r.event).toBe('COMMENT');
    // downgradeApprove did not fire (base event was COMMENT), so no sentence…
    expect(r.body).not.toContain('Downgraded');
    // …but every disclosure is present exactly once, and nothing certifies.
    expect(r.body).toContain('Reviewed.');
    expect(r.body).toContain('Suggestions are inline.');
    expect(r.body).toContain('1 Suggestion-level finding(s)');
    expect(r.body).toContain('Unresolved, please confirm:');
    expect(r.body).toContain('Not reviewed: security');
    expect(r.body).not.toContain('no blockers');
  });

  it('reads as a sentence when no role was briefed at all', () => {
    // The register this lands in matters as much as the fact. On #7012 the public
    // CHANGES_REQUESTED body was twelve lines of the review's own plumbing, each
    // naming an internal command (`agent-prompt --role 2`) the PR author has no way
    // to run, while the two Criticals that needed acting on sat inline below. The
    // author needs one thing from this: which of the review they should not trust.
    const gap =
      'every dimension — none of the 12 required agents was launched with a ' +
      'prompt this skill built, so this diff was reviewed, if at all, from prompts ' +
      'the run wrote for itself: the severity bar, the finding format and this ' +
      "project's own rules never reached an agent";
    const r = composeReview(base({ unreviewedDimensions: [gap] }));

    expect(r.body).toContain(`Not reviewed: ${gap}.`);
    expect(r.body).not.toMatch(/agent-prompt|--role|--chunk/);
    expect(r.event).not.toBe('APPROVE'); // it still caps, as it always did
  });

  it('RC with body Criticals plus unread scope carries both disclosures', () => {
    const r = composeReview(
      base({
        bodyCriticals: ['blocker'],
        uncoverableChunks: ['chunk 9 (x.min.js)'],
      }),
    );
    expect(r.event).toBe('REQUEST_CHANGES');
    expect(r.body).toContain('**[Critical]** blocker');
    expect(r.body).toContain('Not reviewed: chunk 9');
  });

  it('every non-empty body ends with the model footer', () => {
    for (const input of [
      base({}),
      base({ suggestionsInline: 1 }),
      base({ bodyCriticals: ['x'] }),
      base({ contextUnavailable: true }),
    ]) {
      const r = composeReview(input);
      if (r.body !== '') {
        expect(r.body.endsWith(FOOTER)).toBe(true);
      }
    }
  });
});

describe('composeReview — RC carries every applicable disclosure (no clause squeezed out)', () => {
  it('RC + context-unavailable keeps the diff-only trust warning in the body', () => {
    const r = composeReview(
      base({ criticalsInline: 1, contextUnavailable: true }),
    );
    expect(r.event).toBe('REQUEST_CHANGES');
    expect(r.body).toContain('Reviewed diff-only');
  });

  it('RC + uncoverable chunk alone still discloses the unread scope (was gated on other parts)', () => {
    const r = composeReview(
      base({ criticalsInline: 1, uncoverableChunks: ['chunk 3 (a.min.js)'] }),
    );
    expect(r.event).toBe('REQUEST_CHANGES');
    expect(r.body).toContain('Not reviewed: chunk 3 (a.min.js)');
  });

  it('RC + cannot-tell existing Critical carries the unresolved disclosure', () => {
    const r = composeReview(
      base({ criticalsInline: 1, cannotTellCriticals: ['old blocker'] }),
    );
    expect(r.event).toBe('REQUEST_CHANGES');
    expect(r.body).toContain('Unresolved, please confirm:');
  });

  it('a clean RC still submits an empty body', () => {
    const r = composeReview(base({ criticalsInline: 2 }));
    expect(r.body).toBe('');
  });
});

describe('composeReview — not-reviewed entries that carry their own reason', () => {
  it('renders the entry verbatim instead of appending the whiff sentence (Agent 0 issue-fetch failure)', () => {
    const r = composeReview(
      base({
        unreviewedDimensions: [
          'issue-fidelity — linked issue #123 could not be fetched',
          'security',
        ],
      }),
    );
    expect(r.event).toBe('COMMENT');
    expect(r.body).toContain(
      'Not reviewed: security — the agent returned no evidence of its walk twice.',
    );
    expect(r.body).toContain(
      'Not reviewed: issue-fidelity — linked issue #123 could not be fetched.',
    );
    // The self-explained entry must not be folded into the whiff sentence.
    expect(r.body).not.toContain('issue-fidelity, security');
  });
});

describe('composeReview — budget-gap disclosures (a channel, never a cap)', () => {
  it('renders disclosed gaps in the body and still approves a clean run', () => {
    // The agent read its whole territory (ranged read) and disclosed one
    // optional-depth check its tool budget cut short. The disclosure must
    // reach the author mechanically — whether or not the orchestrator
    // relays anything — and must NOT cap the verdict: judging which gaps
    // name a required trace is the orchestrator's ruling (Step 3D), and
    // capping on every routine budget stop would make the soft ceiling
    // hard.
    transcript('a1', goodPrompt(1), {
      toolCalls: 3,
      range: [0, 100],
      text:
        'No issues found — walked chunk 1 fully.\n' +
        'Budget gap: second-order callers of the renamed export',
    });
    transcript('a2', goodPrompt(2), { toolCalls: 2, range: [100, 100] });
    const p = plan({ step45: false });
    recordBuilt(p, 1);
    recordBuilt(p, 2);
    recordMatrix(p);
    recordStep45(p, ['verify', 'reverse-audit']);

    // Not base(): its planPath DEFAULT (coveredPlan()) is evaluated on every
    // call and rewrites this run's a1/a2 transcripts with clean ones.
    const r = composeReview({
      criticalsInline: 0,
      suggestionsInline: 0,
      planPath: p,
      env: ENV,
      modelId: MODEL,
    });
    // Attributed to its agent and wrapped as inline code — a gap carrying
    // an @-mention, a #123 reference or a stray `</details>` must reach
    // the body inert.
    expect(r.body).toContain(
      'Not explored to full depth (tool budget reached): ' +
        'chunk 1: `second-order callers of the renamed export`.',
    );
    expect(r.event).toBe('APPROVE');
  });

  it('drops its mechanical line for a gap the caller promoted — one register, not two', () => {
    // Step 3D has the orchestrator promote a required-trace gap into
    // unreviewedDimensions with the gap's own text as the scope. The
    // promoted entry caps and renders verbatim; the mechanical line must
    // yield, or the body says one budget stop twice in two contradicting
    // framings (#7188's double-disclosure regression, reopened).
    transcript('a1', goodPrompt(1), {
      toolCalls: 3,
      range: [0, 100],
      text:
        'No issues found — walked chunk 1 fully.\n' +
        'Budget gap: second-order callers of the renamed export',
    });
    transcript('a2', goodPrompt(2), { toolCalls: 2, range: [100, 100] });
    const p = plan({ step45: false });
    recordBuilt(p, 1);
    recordBuilt(p, 2);
    recordMatrix(p);
    recordStep45(p, ['verify', 'reverse-audit']);

    const r = composeReview({
      criticalsInline: 0,
      suggestionsInline: 0,
      unreviewedDimensions: [
        'second-order callers of the renamed export — stopped at the agent tool budget',
      ],
      planPath: p,
      env: ENV,
      modelId: MODEL,
    });
    expect(r.body).toContain(
      'Not reviewed: second-order callers of the renamed export — stopped at the agent tool budget.',
    );
    expect(r.body).not.toContain('Not explored to full depth');
    expect(r.event).toBe('COMMENT');
  });

  it('a disclosed gap denies the "no blockers" certification', () => {
    // "Reviewed — no blockers." two lines above "Not explored to full
    // depth" is the opener certifying what the disclosure takes back.
    transcript('a1', goodPrompt(1), {
      toolCalls: 3,
      range: [0, 100],
      text:
        'One suggestion filed.\n' +
        'Budget gap: the callers of the renamed export',
    });
    transcript('a2', goodPrompt(2), { toolCalls: 2, range: [100, 100] });
    const p = plan({ step45: false });
    recordBuilt(p, 1);
    recordBuilt(p, 2);
    recordMatrix(p);
    recordStep45(p, ['verify', 'reverse-audit']);

    const r = composeReview({
      criticalsInline: 0,
      suggestionsInline: 1,
      planPath: p,
      env: ENV,
      modelId: MODEL,
    });
    expect(r.body).toContain('Not explored to full depth');
    expect(r.body).not.toContain('no blockers');
  });
});

describe('composeReview — input validation (the producer is a model that omits inapplicable fields)', () => {
  it('a body-Critical-only input with every count omitted lands on the REQUEST_CHANGES row (undefined + 1 = NaN once meant APPROVE)', () => {
    // The NaN property pins on `baseEvent`: the arithmetic put the blocker on
    // the Request-changes row. The EVENT is then softened — no plan means the
    // blocker cannot be shown verified — and the blocker's body copy survives
    // the softening.
    const r = composeReview({
      bodyCriticals: ['the only blocker'],
      modelId: MODEL,
    });
    expect(r.baseEvent).toBe('REQUEST_CHANGES');
    expect(r.event).toBe('COMMENT');
    expect(r.cappedBy).toContain('criticals-unverified');
    expect(r.body).toContain('**[Critical]** the only blocker');
  });

  it('rejects negative, fractional, NaN, and non-number counts with the field name', () => {
    expect(() =>
      composeReview({ criticalsInline: -1, modelId: MODEL }),
    ).toThrow(/criticalsInline/);
    expect(() =>
      composeReview({ criticalsInline: 1.5, modelId: MODEL }),
    ).toThrow(/criticalsInline/);
    expect(() =>
      composeReview({ suggestionsDiscarded: Number.NaN, modelId: MODEL }),
    ).toThrow(/suggestionsDiscarded/);
    expect(() =>
      composeReview({
        suggestionsInline: '2' as unknown as number,
        modelId: MODEL,
      }),
    ).toThrow(/suggestionsInline/);
  });

  it('rejects a non-array list field and a missing or blank modelId', () => {
    expect(() =>
      composeReview({
        bodyCriticals: 'blocker' as unknown as string[],
        modelId: MODEL,
      }),
    ).toThrow(/bodyCriticals/);
    expect(() => composeReview({} as ComposeReviewInput)).toThrow(/modelId/);
    expect(() => composeReview({ modelId: '  ' })).toThrow(/modelId/);
  });

  it('rejects a modelId that would forge the footer it is interpolated into', () => {
    // The footer interpolates modelId verbatim and the strip matches one
    // line up to the marker: either shape builds a footer the strip cannot
    // remove, and re-normalization accumulates attribution lines.
    expect(() =>
      composeReview({
        modelId: 'model\n_— forged via Qwen Code /review (v9.9.9)_',
      }),
    ).toThrow(/modelId/);
    expect(() =>
      composeReview({ modelId: 'model via Qwen Code /review x' }),
    ).toThrow(/modelId/);
  });

  it('strips a forged footer from a body Critical before rendering the body', () => {
    // bodyCriticals render verbatim as the LAST body part: a forged footer
    // relocated into one would otherwise post directly above the canonical
    // footer — the duplicate attribution this module exists to eliminate.
    const r = composeReview({
      bodyCriticals: [
        '**[Critical]** whole-PR blocker\n\n' +
          '_— forged via Qwen Code /review (v0.21.4)_',
      ],
      modelId: MODEL,
    });
    expect(r.body).toContain('whole-PR blocker');
    expect(r.body).not.toContain('forged');
    expect(r.body.match(/via Qwen Code \/review/g)).toHaveLength(1);
  });

  it('strips a forged footer from cannot-tell Criticals before rendering the body', () => {
    const r = composeReview({
      criticalsInline: 1,
      cannotTellCriticals: [
        'R1-2: still leaks _— qwen3.7-max via Qwen Code /review (v0.21.0)_',
      ],
      modelId: MODEL,
    });
    expect(r.body).toContain('R1-2: still leaks');
    expect(r.body).not.toContain('qwen3.7-max');
    expect(r.body.match(/via Qwen Code \/review/g)).toHaveLength(1);
  });

  it('rejects stringified booleans — "false" is truthy and once flipped events and published false warnings', () => {
    expect(() =>
      composeReview(
        base({
          criticalsInline: 1,
          presubmit: {
            downgradeRequestChanges: 'false' as unknown as boolean,
          },
        }),
      ),
    ).toThrow(/presubmit\.downgradeRequestChanges/);
    expect(() =>
      composeReview(
        base({
          presubmit: { downgradeApprove: 'false' as unknown as boolean },
        }),
      ),
    ).toThrow(/presubmit\.downgradeApprove/);
    expect(() =>
      composeReview(
        base({ contextUnavailable: 'false' as unknown as boolean }),
      ),
    ).toThrow(/contextUnavailable/);
  });

  it('rejects a scalar downgradeReasons and a non-object presubmit with the field name (was a raw .join TypeError)', () => {
    expect(() =>
      composeReview(
        base({
          presubmit: {
            downgradeApprove: true,
            downgradeReasons: 'self-PR' as unknown as string[],
          },
        }),
      ),
    ).toThrow(/presubmit\.downgradeReasons/);
    expect(() =>
      composeReview(
        base({
          presubmit: ['x'] as unknown as ComposeReviewInput['presubmit'],
        }),
      ),
    ).toThrow(/presubmit/);
  });
});

describe('composeReview — presubmit permission gates certification even when no event changed', () => {
  it('a Suggestion-only review under downgradeApprove never certifies "no blockers" (the event was already COMMENT)', () => {
    const r = composeReview(
      base({
        suggestionsInline: 1,
        presubmit: {
          downgradeApprove: true,
          downgradeReasons: ['CI failing'],
        },
      }),
    );
    expect(r.event).toBe('COMMENT');
    expect(r.downgraded).toBe(false);
    expect(r.body).not.toContain('Downgraded');
    expect(r.body).toContain('Reviewed.');
    expect(r.body).not.toContain('no blockers');
  });
});

describe('composeReviewCommand handler (the CLI glue)', () => {
  // The handler prefers the inherited startup stamp; an ambient value from
  // a stamped qwen session would otherwise flip every footer assertion in
  // this suite to the stamped version.
  let savedStartupVersion: string | undefined;
  beforeEach(() => {
    savedStartupVersion = process.env['QWEN_CODE_STARTUP_VERSION'];
    delete process.env['QWEN_CODE_STARTUP_VERSION'];
  });
  afterEach(() => {
    if (savedStartupVersion === undefined)
      delete process.env['QWEN_CODE_STARTUP_VERSION'];
    else process.env['QWEN_CODE_STARTUP_VERSION'] = savedStartupVersion;
  });

  it('reads --input, counts the drafted comments, and writes the result JSON to --out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'compose-review-test-'));
    const inputPath = join(dir, 'compose.json');
    const commentsPath = join(dir, 'comments.json');
    const outPath = join(dir, 'nested', 'composed.json');
    writeFileSync(inputPath, JSON.stringify({ modelId: MODEL }), 'utf8');
    // The count comes from the drafted comments, not from a number in the
    // state JSON — one Suggestion drafted, one Suggestion composed.
    writeFileSync(
      commentsPath,
      JSON.stringify([
        { path: 'a.ts', line: 3, body: '**[Suggestion]** prefer x over y' },
      ]),
      'utf8',
    );
    await runComposeReviewCommand({
      input: inputPath,
      comments: commentsPath,
      out: outPath,
    });
    const written = JSON.parse(
      readFileSync(outPath, 'utf8'),
    ) as ComposeReviewResult;
    expect(written.event).toBe('COMMENT');
    expect(written.body).toContain('Suggestions are inline.');
    expect(
      written.body.endsWith(`_— ${MODEL} via Qwen Code /review (v0.21.2)_`),
    ).toBe(true);
  });

  it('pins the persisted footer to the inherited startup version, not the resolved one', async () => {
    // Same pin as `submit`: a shared runner rewrites installs under running
    // processes, so the version resolved at compose time can disagree with
    // the one the session started under. The archived verdict must carry the
    // startup stamp, or it contradicts the review `submit` posts.
    const dir = mkdtempSync(join(tmpdir(), 'compose-startup-'));
    const inputPath = join(dir, 'compose.json');
    const commentsPath = join(dir, 'comments.json');
    const outPath = join(dir, 'composed.json');
    writeFileSync(inputPath, JSON.stringify({ modelId: MODEL }), 'utf8');
    writeFileSync(commentsPath, '[]', 'utf8');
    const inherited = process.env['QWEN_CODE_STARTUP_VERSION'];
    process.env['QWEN_CODE_STARTUP_VERSION'] = '0.21.1';
    try {
      await runComposeReviewCommand({
        input: inputPath,
        comments: commentsPath,
        out: outPath,
      });
      const written = JSON.parse(
        readFileSync(outPath, 'utf8'),
      ) as ComposeReviewResult;
      expect(
        written.body.endsWith(`_— ${MODEL} via Qwen Code /review (v0.21.1)_`),
      ).toBe(true);
    } finally {
      if (inherited === undefined)
        delete process.env['QWEN_CODE_STARTUP_VERSION'];
      else process.env['QWEN_CODE_STARTUP_VERSION'] = inherited;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('routes its gh calls via the PR host — --host reaches setGhHost', async () => {
    // The bilingual body-language recovery calls `gh pr view`; on GitHub Enterprise
    // that call must hit the PR's host, or the composed body's language disagrees
    // with what `submit` (which routes by host) posts. Drop the `setGhHost(host)`
    // and this reddens.
    const dir = mkdtempSync(join(tmpdir(), 'compose-host-'));
    const inputPath = join(dir, 'compose.json');
    const commentsPath = join(dir, 'comments.json');
    writeFileSync(inputPath, JSON.stringify({ modelId: MODEL }), 'utf8');
    writeFileSync(commentsPath, '[]', 'utf8');
    setGhHost(undefined);
    try {
      await runComposeReviewCommand({
        input: inputPath,
        comments: commentsPath,
        host: 'github.example.com',
      });
      expect(getGhHost()).toBe('github.example.com');
    } finally {
      setGhHost(undefined);
    }
  });

  it('a drafted inline Critical reaches the verdict line — the report-only hole', async () => {
    // The dogfooded failure this boundary exists for: a report-only run (no
    // submit, so nothing downstream recounts) moved its one Critical from
    // `bodyCriticals` to an inline comment, dropped the count on the way, and
    // the verdict line read Approve over a blocker the same report listed.
    // With the counts derived from the drafted comments, that finding cannot
    // fall out of the computation.
    const dir = mkdtempSync(join(tmpdir(), 'compose-inline-crit-'));
    try {
      const inputPath = join(dir, 'compose.json');
      const commentsPath = join(dir, 'comments.json');
      const outPath = join(dir, 'composed.json');
      writeFileSync(inputPath, JSON.stringify({ modelId: MODEL }), 'utf8');
      writeFileSync(
        commentsPath,
        JSON.stringify([
          {
            path: 'shellAstParser.ts',
            line: 141,
            body: '**[Critical]** the AST path omits %G[?GKFPST]',
          },
        ]),
        'utf8',
      );
      await runComposeReviewCommand({
        input: inputPath,
        comments: commentsPath,
        out: outPath,
      });
      const written = JSON.parse(readFileSync(outPath, 'utf8')) as {
        event: string;
        baseEvent: string;
        verdictLine: string;
      };
      // The derived count reached the Request-changes row — that is the hole
      // this test pins. With no plan beside it the blocker cannot be shown
      // verified, so the EVENT softens and the verdict line says why.
      expect(written.baseEvent).toBe('REQUEST_CHANGES');
      expect(written.verdictLine).toContain(
        'a Request changes was NOT available',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts the review-payload shape too — the same file submit takes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'compose-payload-shape-'));
    try {
      const inputPath = join(dir, 'compose.json');
      const commentsPath = join(dir, 'review.json');
      const outPath = join(dir, 'composed.json');
      writeFileSync(inputPath, JSON.stringify({ modelId: MODEL }), 'utf8');
      writeFileSync(
        commentsPath,
        JSON.stringify({
          commit_id: 'abc',
          comments: [{ path: 'a.ts', line: 1, body: '**[Critical]** boom' }],
        }),
        'utf8',
      );
      await runComposeReviewCommand({
        input: inputPath,
        comments: commentsPath,
        out: outPath,
      });
      expect(
        (JSON.parse(readFileSync(outPath, 'utf8')) as { baseEvent: string })
          .baseEvent,
      ).toBe('REQUEST_CHANGES');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['criticalsInline', { criticalsInline: 1 }],
    ['suggestionsInline', { suggestionsInline: 2 }],
  ])(
    'refuses a state JSON carrying %s — counts are counted, not typed',
    async (_, extra) => {
      const dir = mkdtempSync(join(tmpdir(), 'compose-typed-count-'));
      try {
        const inputPath = join(dir, 'compose.json');
        const commentsPath = join(dir, 'comments.json');
        writeFileSync(
          inputPath,
          JSON.stringify({ modelId: MODEL, ...extra }),
          'utf8',
        );
        writeFileSync(commentsPath, '[]', 'utf8');
        await expect(
          runComposeReviewCommand({
            input: inputPath,
            comments: commentsPath,
          }),
        ).rejects.toThrow(/counted from the --comments file/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('refuses a drafted comment with no severity marker — it would weigh nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'compose-unmarked-'));
    try {
      const inputPath = join(dir, 'compose.json');
      const commentsPath = join(dir, 'comments.json');
      writeFileSync(inputPath, JSON.stringify({ modelId: MODEL }), 'utf8');
      writeFileSync(
        commentsPath,
        JSON.stringify([
          { path: 'a.ts', line: 1, body: '**[Critical]** real one' },
          { path: 'b.ts', line: 2, body: 'this blocker forgot its marker' },
        ]),
        'utf8',
      );
      await expect(
        runComposeReviewCommand({
          input: inputPath,
          comments: commentsPath,
        }),
      ).rejects.toThrow(/comments\[1\].*neither/s);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['missing --comments', undefined, /--comments is required/],
    [
      'a comments path that does not resolve',
      '/nonexistent/c.json',
      /cannot read the comments file/,
    ],
  ])(
    'refuses %s — omission is the failure mode, not a default',
    async (_, commentsPath, pattern) => {
      const dir = mkdtempSync(join(tmpdir(), 'compose-no-comments-'));
      try {
        const inputPath = join(dir, 'compose.json');
        writeFileSync(inputPath, JSON.stringify({ modelId: MODEL }), 'utf8');
        await expect(
          runComposeReviewCommand({
            input: inputPath,
            comments: commentsPath,
          }),
        ).rejects.toThrow(pattern as RegExp);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('refuses a comments file that is not an array (nor a payload with one)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'compose-bad-comments-'));
    try {
      const inputPath = join(dir, 'compose.json');
      const commentsPath = join(dir, 'comments.json');
      writeFileSync(inputPath, JSON.stringify({ modelId: MODEL }), 'utf8');
      writeFileSync(commentsPath, JSON.stringify({ criticals: 3 }), 'utf8');
      await expect(
        runComposeReviewCommand({
          input: inputPath,
          comments: commentsPath,
        }),
      ).rejects.toThrow(/must be a JSON array of comment objects/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('strips a model-supplied `env` — it cannot redirect the transcript lookup', async () => {
    // The input is a JSON the model wrote. `env` decides where the harness
    // transcripts are read from; if the handler honoured it, a model could point
    // it at a directory of transcripts it fabricated — the whole gate reopened
    // through one extra key. The handler must drop it and resolve from the real
    // environment (which, here, points nowhere valid — so it caps, not approves).
    const dir = mkdtempSync(join(tmpdir(), 'compose-env-'));
    try {
      const forged = join(dir, 'forged');
      const fdir = join(forged, 'subagents', 'S1');
      mkdirSync(fdir, { recursive: true });
      // A plan whose one chunk a FABRICATED, fully-covering transcript would
      // approve. If the handler honoured the model's env, this transcript would be
      // read and the review would APPROVE. Stripping env sends the lookup to the
      // real (empty) environment, so it caps. The two outcomes differ — which is
      // what makes this test able to fail.
      const planPath = join(dir, 'plan.json');
      writeFileSync(
        planPath,
        JSON.stringify({
          diffPathAbsolute: '/d.txt',
          chunks: [{ id: 1, startLine: 1, endLine: 10 }],
        }),
      );
      const good =
        'You are reviewing chunk 1 of 1.\nread_file(file_path="/d.txt", offset=0, limit=10)';
      const b = {
        agentId: 'f1',
        agentName: 'general-purpose',
        sessionId: 'S1',
      };
      writeFileSync(
        join(fdir, 'agent-f1.jsonl'),
        [
          JSON.stringify({
            ...b,
            type: 'user',
            message: { role: 'user', parts: [{ text: good }] },
          }),
          JSON.stringify({
            ...b,
            type: 'assistant',
            message: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'read_file',
                    args: { file_path: '/d.txt' },
                  },
                },
              ],
            },
          }),
          JSON.stringify({
            ...b,
            type: 'tool_result',
            message: {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    name: 'read_file',
                    response: { output: 'ok' },
                  },
                },
              ],
            },
          }),
          JSON.stringify({
            ...b,
            type: 'assistant',
            message: {
              role: 'model',
              parts: [{ text: 'Reviewed chunk 1, walked all ten lines.' }],
            },
          }),
        ].join('\n') + '\n',
      );
      const inputPath = join(dir, 'in.json');
      writeFileSync(
        inputPath,
        JSON.stringify({
          planPath,
          env: { QWEN_CODE_PROJECT_DIR: forged, QWEN_CODE_SESSION_ID: 'S1' },
          modelId: MODEL,
        }),
      );
      const commentsPath = join(dir, 'comments.json');
      writeFileSync(commentsPath, '[]', 'utf8');
      const outPath = join(dir, 'out.json');
      const prevProj = process.env['QWEN_CODE_PROJECT_DIR'];
      delete process.env['QWEN_CODE_PROJECT_DIR']; // real env cannot find transcripts
      try {
        await runComposeReviewCommand({
          input: inputPath,
          comments: commentsPath,
          out: outPath,
        });
      } finally {
        if (prevProj === undefined) delete process.env['QWEN_CODE_PROJECT_DIR'];
        else process.env['QWEN_CODE_PROJECT_DIR'] = prevProj;
      }
      const written = JSON.parse(
        readFileSync(outPath, 'utf8'),
      ) as ComposeReviewResult;
      // If env had been honoured, the fabricated transcript would APPROVE. It
      // was stripped, so the real (empty) env cannot show coverage and it caps.
      expect(written.event).not.toBe('APPROVE');
      expect(written.body).toMatch(/transcripts|no plan/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('coverage is recomputed, never accepted', () => {
  it('does not repeat a disclosure the caller echoed back — one subject, one line', () => {
    // #7188: the orchestrator pasted the gate's own gap sentences into
    // `unreviewedDimensions`, coverage recomputed the same gaps, and the
    // public body carried every disclosure twice — 22 "Not reviewed" clauses
    // for 11 roles. The chunk list already dedupes by its `chunk <id>`
    // prefix; the role list dedupes by label now, and when both sides name
    // the same subject the coverage-derived text wins.
    const p = plan();
    transcript('a1', goodPrompt(1), { toolCalls: 3 });
    transcript('a2', goodPrompt(2), { toolCalls: 2 });
    recordBuilt(p, 1);
    recordBuilt(p, 2);
    // test-matrix is required by this plan's roster and never built → exactly
    // one coverage-derived role gap.
    const label = 'Test coverage matrix (whole-diff)';
    const r = composeReview({
      planPath: p,
      env: ENV,
      modelId: MODEL,
      unreviewedDimensions: [
        `${label} — the run described this gap in its own words`,
        'a subject only the caller noticed — the auditor returned nothing twice',
      ],
    });
    // One clause for the shared subject — the machine's sentence, not the
    // caller's paraphrase, and in the author's register: the internal
    // codename stays off the posted body (it is the stderr selector).
    expect(r.body.split('the whole-diff test-coverage check')).toHaveLength(2);
    expect(r.body).not.toContain(label);
    expect(r.body).toContain('no record shows its brief reaching an agent');
    expect(r.body).not.toContain('described this gap in its own words');
    // A subject the coverage recomputation cannot see survives untouched.
    expect(r.body).toContain(
      'a subject only the caller noticed — the auditor returned nothing twice',
    );
  });

  it('says a shared cause once, with every subject on the one sentence', () => {
    // #7166's posted body: ninety-nine disclosure paragraphs over FOUR causes
    // — forty-three chunks all rewritten, fifty-five roles all unlaunched —
    // with the six real findings buried beneath. Same cause, one sentence.
    const p = plan();
    // Both chunk launches rewritten: recorded prompts exist, the agents ran
    // on hand-written prompts that DROP the brief line — an add-only wrap
    // would rightly pass the delivery check.
    recordBuilt(p, 1);
    recordBuilt(p, 2);
    transcript(
      'a1',
      `You are reviewing chunk 1 of 2.\nread_file(file_path="${DIFF}", offset=0, limit=100)`,
      { toolCalls: 2 },
    );
    transcript(
      'a2',
      `You are reviewing chunk 2 of 2.\nread_file(file_path="${DIFF}", offset=100, limit=100)`,
      { toolCalls: 2 },
    );
    const r = composeReview({ planPath: p, env: ENV, modelId: MODEL });
    const reason = 'launched with a prompt that is not the one the CLI built';
    // One clause for the shared cause — not one per chunk…
    expect(r.body.split(reason)).toHaveLength(2);
    // …and the subjects ride it in the author's units: both chunks is the
    // whole plan, and a chunk id is bookkeeping nothing on the PR page maps
    // to code (#7268's body enumerated all 49 of a run's ids, unsorted).
    expect(r.body).toMatch(
      new RegExp(`Not reviewed: the entire diff — ${reason}\\.`),
    );
    expect(r.body).not.toMatch(/chunk \d/);
  });

  it('an all-rewritten roster never claims nothing launched — precise cause, no contradicting aggregate', () => {
    // The first cut collapsed all-empty verbatim matches into "the run
    // stopped at the prompt builder" — but candidatesOf is also all-empty
    // when every agent RAN on a rewritten prompt, and the aggregate then
    // contradicted the rewritten-launch disclosures beside it. Reproduced
    // and refused: both chunks rewritten, the whole-diff role unlaunched —
    // each cause its own sentence, no "every dimension" claim anywhere.
    const p = plan();
    recordBuilt(p, 1);
    recordBuilt(p, 2);
    transcript(
      'a1',
      `You are reviewing chunk 1 of 2.\nread_file(file_path="${DIFF}", offset=0, limit=100)`,
      { toolCalls: 2 },
    );
    transcript(
      'a2',
      `You are reviewing chunk 2 of 2.\nread_file(file_path="${DIFF}", offset=100, limit=100)`,
      { toolCalls: 2 },
    );
    const r = composeReview({ planPath: p, env: ENV, modelId: MODEL });
    expect(r.body).toMatch(
      /Not reviewed: the entire diff — launched with a prompt that is not the one the CLI built\./,
    );
    expect(r.body).not.toContain('every dimension');
    expect(r.body).not.toContain('stopped at the prompt builder');
    // And the chunks appear under their PRECISE cause only — to the roster
    // they are also requirements with no verbatim launch, and repeating them
    // under that vaguer cause would claim nothing launched about agents that
    // demonstrably ran.
    expect(r.body).not.toContain('no agent on record was launched with it');
  });

  it('a reason carrying its own em-dash neither garbles the subject nor duplicates the line', () => {
    // Reasons are free-form — internal failures interpolate raw error
    // messages — so a subject/reason boundary reparsed from rendered prose
    // regroups exactly the entries it garbles. The entries are structural
    // now; the caller's echo of a dashed line still dedupes, by prefix
    // against the known subject.
    const p = plan();
    const r = composeReview({
      planPath: p,
      // Transcripts unreadable: the coverage AND verification reasons both
      // interpolate an error message — with an em-dash of their own.
      env: {
        QWEN_CODE_PROJECT_DIR: join(dir, 'nowhere — missing'),
        QWEN_CODE_SESSION_ID: 'S1',
      },
      unreviewedDimensions: [
        'coverage — could not read the transcripts — echoed back by the caller',
      ],
      modelId: MODEL,
    });
    // One coverage clause — the caller's dashed echo deduped by subject
    // prefix, the machine's own text rendered once, subject intact.
    expect(r.body.match(/Not reviewed: coverage/g)).toHaveLength(1);
    expect(r.body).not.toContain('echoed back by the caller');
  });

  it('caller echoes of per-role gaps fold into the one grouped sentence — the #7188 shape end to end', () => {
    // The coverage-side collapse discarded the per-role subjects before the
    // caller's echoes could collide with them, so the body carried the
    // caller's per-role sentences PLUS an overlapping aggregate. Per-role
    // subjects now survive to the dedup, and the grouping makes the one
    // sentence afterwards.
    const p = plan();
    recordBuilt(p, 1);
    recordBuilt(p, 2);
    // Chunks reviewed properly; the whole-diff role built but never launched.
    transcript('a1', goodPrompt(1), { toolCalls: 3 });
    transcript('a2', goodPrompt(2), { toolCalls: 2 });
    const label = 'Test coverage matrix (whole-diff)';
    const r = composeReview({
      planPath: p,
      env: ENV,
      unreviewedDimensions: [
        `${label} — its prompt was built, but no agent on record was launched with it`,
      ],
      modelId: MODEL,
    });
    // The caller's echo (internal label) dedupes against the internal
    // subject; the one surviving sentence prints the author's phrase.
    expect(r.body).not.toContain(label);
    expect(r.body.split('the whole-diff test-coverage check')).toHaveLength(2);
    expect(
      r.body.match(/no record shows its brief reaching an agent/g) ?? [],
    ).toHaveLength(1);
  });

  it('a chunk whose launch failure is already disclosed leaves the nobody-read sentence — cause, not consequence twice', () => {
    // #7166's first post-grouping body carried seventeen chunks in BOTH the
    // "nobody read them" sentence and the not-launched roster sentence: the
    // consequence restated beside its cause. The cap and remediation keep the
    // full list; only the posted sentence dedupes.
    const p = plan();
    recordBuilt(p, 1);
    recordBuilt(p, 2);
    // chunk 2 reviewed properly; chunk 1 built and never launched — its
    // territory therefore unread, and its cause on record.
    transcript('a2', goodPrompt(2), { toolCalls: 2 });
    const r = composeReview({ planPath: p, env: ENV, modelId: MODEL });
    expect(r.cappedBy).toContain('chunk-nobody-read'); // the cap keeps the fact
    expect(r.remediation.join(' ')).toContain('chunks nobody read');
    // The gap, named by the files it covers — the id stays on stderr.
    expect(r.body).toContain('the diff section covering src/a.ts');
    expect(r.body).not.toMatch(/chunk \d/);
    // …but only under its cause: no second sentence restating the consequence.
    expect(r.body).not.toContain('no agent reported covering');
  });

  it('keeps the nobody-read sentence for a chunk with no disclosed cause', () => {
    // The 3A shape: chunks are not roster requirements, so an unread chunk has
    // no launch-side disclosure to explain it — the receipt sentence is the
    // only place the author learns those lines went unread.
    const p = join(dir, 'plan-3a.json');
    writeFileSync(
      p,
      JSON.stringify({
        diffPathAbsolute: DIFF,
        srcDiffLines: 100,
        diffLines: 200,
        files: [
          { path: 'a.ts', kind: 'source', removedLines: 0, heavy: false },
        ],
        chunks: [
          { id: 1, startLine: 1, endLine: 100 },
          { id: 2, startLine: 101, endLine: 200 },
        ],
      }),
    );
    const old = new Date(2020, 0, 1);
    utimesSync(p, old, old);
    const r = composeReview({ planPath: p, env: ENV, modelId: MODEL });
    // Both chunks unread is the whole plan — said as the diff, not as ids.
    expect(r.body).toMatch(/the entire diff — no agent reported covering it/);
    expect(r.body).toContain('nobody read it');
    expect(r.body).not.toMatch(/chunk \d/);
  });

  it('opens with the zero-certified warning when every chunk is disclosed — never "Reviewed." above a body that denies it', () => {
    // #7268: the posted body opened "Reviewed. Suggestions are inline." and
    // then disclosed all 49 chunks across two Not-reviewed sentences — the
    // first sentence certified the exact thing every following one took back.
    // Both rewritten agents here demonstrably READ their chunks, so coverage
    // alone is not the test: certified is covered with no disclosure against
    // it.
    const p = plan();
    recordBuilt(p, 1);
    recordBuilt(p, 2);
    transcript(
      'a1',
      `You are reviewing chunk 1 of 2.\nread_file(file_path="${DIFF}", offset=0, limit=100)`,
      { toolCalls: 2 },
    );
    transcript(
      'a2',
      `You are reviewing chunk 2 of 2.\nread_file(file_path="${DIFF}", offset=100, limit=100)`,
      { toolCalls: 2 },
    );
    const r = composeReview({
      planPath: p,
      env: ENV,
      modelId: MODEL,
      suggestionsInline: 1,
    });
    expect(r.event).toBe('COMMENT');
    expect(r.body).toMatch(
      /^⚠️ This run could not certify that any of this diff was reviewed\./,
    );
    expect(r.body).toContain('Suggestions are inline.');
    expect(r.body).not.toContain('Reviewed.');
  });

  it('keeps the "Reviewed." opener while any chunk is certified', () => {
    // chunk 1 built and never launched; chunk 2 reviewed properly. A partial
    // gap is a disclosure, not a zero-certification.
    const p = plan();
    recordBuilt(p, 1);
    recordBuilt(p, 2);
    recordMatrix(p);
    transcript('a2', goodPrompt(2), { toolCalls: 2 });
    const r = composeReview({ planPath: p, env: ENV, modelId: MODEL });
    expect(r.body).toContain('Reviewed.');
    expect(r.body).not.toContain('could not certify');
  });

  it('does not merge two invariant files under one label — the em-dash is part of the subject', () => {
    // An invariant agent's label legitimately carries an em-dash segment
    // (`Invariant agent A … — src/foo.ts`). A first-dash dedup key would
    // merge two files into one subject and silently drop a disclosure.
    const p = plan();
    transcript('a1', goodPrompt(1), { toolCalls: 3 });
    transcript('a2', goodPrompt(2), { toolCalls: 2 });
    recordBuilt(p, 1);
    recordBuilt(p, 2);
    const r = composeReview({
      planPath: p,
      env: ENV,
      modelId: MODEL,
      unreviewedDimensions: [
        'Invariant agent A: state, timers — src/a.ts — the agent whiffed twice',
        'Invariant agent A: state, timers — src/b.ts — the agent whiffed twice',
      ],
    });
    expect(r.body).toContain('src/a.ts');
    expect(r.body).toContain('src/b.ts');
  });

  it('caps when no plan is given — nothing can show the diff was read', () => {
    const r = composeReview({
      criticalsInline: 0,
      suggestionsInline: 0,
      modelId: MODEL,
    });
    expect(r.event).not.toBe('APPROVE');
    expect(r.body).toContain('no plan was given');
    // No chunk universe to count means nothing countable was certified — the
    // opener says so instead of "Reviewed."
    expect(r.body).toMatch(/could not certify that any of this diff/);
  });

  it('caps when the agents made no tool call — whatever their prose said', () => {
    // The dogfood run, from its real transcripts: every agent returned confident,
    // specific text and not one of them opened the diff.
    const r = composeReview({
      criticalsInline: 0,
      suggestionsInline: 0,
      planPath: idlePlan(),
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).not.toBe('APPROVE');
    expect(r.body).toContain('read nothing');
    // The repair rides the remediation channel — a body disclosure whose FIX
    // silently vanished is the exact state that channel exists to prevent, and
    // without this line, deleting the idle push would fail no test.
    expect(r.remediation.join(' ')).toMatch(
      /idle agents: relaunch each with the same printed prompt/,
    );
  });

  it('names a blind launch as itself, not as a whiff', () => {
    // An agent whose prompt never named the diff could not have read it, and
    // relaunching it produces another agent that cannot either. The prompt is the
    // defect. The body says what happened — to the PR author, who cannot run
    // `agent-prompt` — and the rebuild command rides in `remediation`, which the
    // command prints to stderr for the orchestrator.
    const r = composeReview({
      criticalsInline: 0,
      suggestionsInline: 0,
      planPath: blindPlan(),
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).not.toBe('APPROVE');
    expect(r.body).toContain('never named the diff file');
    expect(r.body).not.toContain('agent-prompt');
    expect(r.remediation.join(' ')).toContain(
      '"${QWEN_CODE_CLI:-qwen}" review agent-prompt',
    );
    expect(r.remediation.join(' ')).toMatch(/do not relaunch the old prompt/);
    // Blind agents read nothing, so the chunks they owned are also chunks
    // nobody read — the CAP and the repair ride along, while the posted body
    // says it once, under the cause: the blind sentence already explains the
    // unread territory, and restating it as "nobody read them" beside it was
    // the #7166 double-disclosure.
    expect(r.cappedBy).toContain('chunk-nobody-read');
    expect(r.body).not.toContain('no agent reported covering');
    expect(r.remediation.join(' ')).toMatch(
      /chunks nobody read: build each with/,
    );
  });

  it('a missing-roles gap has a FIX on the remediation channel', () => {
    // The blind agents got one; the sibling categories did not, and a body
    // disclosure with no repair command is how #7012's orchestrator ended at
    // "the agents clearly did their job". Here the test-matrix brief was never
    // built: the body says what cannot be certified, in the author's register,
    // and the remediation names the roster call, in the operator's.
    // (Blind agents are pinned in the test above; the remaining three
    // categories in the test below — between them, every category that
    // discloses is asserted to repair.)
    const p = plan({ step45: false });
    transcript('a1', goodPrompt(1), { toolCalls: 3 });
    transcript('a2', goodPrompt(2), { toolCalls: 2 });
    recordBuilt(p, 1);
    recordBuilt(p, 2);
    // recordMatrix(p) deliberately absent — the roster still requires it.
    recordStep45(p);

    const r = composeReview({
      criticalsInline: 0,
      suggestionsInline: 0,
      planPath: p,
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).not.toBe('APPROVE');
    expect(r.body).toContain('no record shows its brief reaching an agent');
    expect(r.body).not.toMatch(/agent-prompt|--roster|--role/);
    // The FIX names the run's REAL plan path — a `<plan>` placeholder pasted
    // literally parses as a shell redirection.
    expect(r.remediation.join(' ')).toContain(
      `"\${QWEN_CODE_CLI:-qwen}" review agent-prompt --plan '${p}' --roster`,
    );
  });

  it('rewritten, unread-brief and never-opened gaps each carry their FIX too', () => {
    // The categories the missing-roles test above does not reach — without this,
    // dropping any one of their `remediation.push` calls would fail no test, which
    // is precisely the disclosure-without-repair state the channel exists to
    // prevent. One plan, three defects: chunk 1's agent ran on a hand-written
    // prompt (rewritten), chunk 2's got the built prompt and never opened its
    // brief (unread), and a third agent got chunk 1's built prompt and never
    // opened the diff (unopened).
    const p = plan();
    recordBuilt(p, 1);
    recordBuilt(p, 2);
    recordMatrix(p); // roster satisfied: these three categories, nothing else
    transcript(
      'a1',
      `You are reviewing chunk 1 of 2.\n` +
        `read_file(file_path="${DIFF}", offset=0, limit=100)`,
      { toolCalls: 3 },
    );
    transcript('a2', goodPrompt(2), { toolCalls: 3, opens: [] });
    transcript('a3', goodPrompt(1), {
      toolCalls: 0,
      opens: [briefPath(p, 'chunk-1')],
    });

    const r = composeReview({
      criticalsInline: 0,
      suggestionsInline: 0,
      planPath: p,
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).not.toBe('APPROVE');
    const fixes = r.remediation.join(' ');
    expect(fixes).toMatch(/rewritten launches: re-run/);
    expect(fixes).toMatch(/unread briefs: relaunch/);
    expect(fixes).toMatch(/agents that never opened the diff: relaunch/);
    // And none of the three disclosures drags a command into the body —
    // nor the unread brief's filesystem path: the path names the file an
    // OPERATOR makes the agent open, and it stays on stderr with the fix.
    expect(r.body).not.toMatch(/agent-prompt|--roster|--chunk/);
    expect(r.body).not.toContain('.brief.md');
    expect(r.body).toContain('never opened its brief, so it reviewed without');
  });

  it('the handler prints every FIX to stderr, before the verdict, never to stdout', async () => {
    // The array on the result is data; the command boundary is the interface the
    // orchestrator actually reads. Without this, rerouting FIX lines to stdout
    // (corrupting the JSON callers parse) or printing them after `Verdict:` (so
    // a reader that stops at the verdict never sees them) would stay green.
    const p = plan({ step45: false });
    transcript('a1', goodPrompt(1), { toolCalls: 3 });
    transcript('a2', goodPrompt(2), { toolCalls: 2 });
    recordBuilt(p, 1);
    recordBuilt(p, 2);
    recordStep45(p); // roster misses the test matrix → one repairable gap
    const input = join(dir, 'input.json');
    writeFileSync(
      input,
      JSON.stringify({
        planPath: p,
        modelId: MODEL,
      }),
    );
    const commentsPath = join(dir, 'comments.json');
    writeFileSync(commentsPath, '[]', 'utf8');

    const prevDir = process.env['QWEN_CODE_PROJECT_DIR'];
    const prevSession = process.env['QWEN_CODE_SESSION_ID'];
    process.env['QWEN_CODE_PROJECT_DIR'] = ENV['QWEN_CODE_PROJECT_DIR'];
    process.env['QWEN_CODE_SESSION_ID'] = ENV['QWEN_CODE_SESSION_ID'];
    try {
      vi.mocked(writeStderrLine).mockClear();
      vi.mocked(writeStdoutLine).mockClear();
      await runComposeReviewCommand({
        input,
        comments: commentsPath,
      });

      const stderr = vi
        .mocked(writeStderrLine)
        .mock.calls.map((c) => String(c[0]));
      const fixIdx = stderr.findIndex((l) => l.startsWith('FIX: '));
      const verdictIdx = stderr.findIndex((l) => l.startsWith('Verdict:'));
      expect(fixIdx).toBeGreaterThanOrEqual(0);
      expect(verdictIdx).toBeGreaterThan(fixIdx);
      // And stdout stays parseable JSON — no FIX line in it.
      const stdout = vi
        .mocked(writeStdoutLine)
        .mock.calls.map((c) => String(c[0]))
        .join('\n');
      expect(() => JSON.parse(stdout)).not.toThrow();
      expect(stdout).not.toContain('FIX: ');
      // The composed JSON persists the EXACT verdict line, so Step 8's archived
      // report copies it instead of re-deriving a lossy one from event+cappedBy
      // (a presubmit downgrade depends on fields that pair does not carry).
      const parsedOut = JSON.parse(stdout) as { verdictLine?: string };
      expect(parsedOut.verdictLine).toMatch(/^Verdict: /);
      const printedVerdict = vi
        .mocked(writeStderrLine)
        .mock.calls.map((c) => String(c[0]))
        .find((l) => l.startsWith('Verdict:'));
      expect(parsedOut.verdictLine).toBe(printedVerdict);
    } finally {
      if (prevDir === undefined) delete process.env['QWEN_CODE_PROJECT_DIR'];
      else process.env['QWEN_CODE_PROJECT_DIR'] = prevDir;
      if (prevSession === undefined) delete process.env['QWEN_CODE_SESSION_ID'];
      else process.env['QWEN_CODE_SESSION_ID'] = prevSession;
    }
  });

  it('caps when the transcripts cannot be read at all — and says so', () => {
    // A read-only HOME must not read as "every agent idled". It still caps, but
    // it names the infrastructure, not the agents. Env passed explicitly, like
    // every other test here: mutating `process.env` leaks across a concurrent
    // suite, which is how a sibling test started failing only when run together.
    const r = composeReview({
      criticalsInline: 0,
      suggestionsInline: 0,
      planPath: coveredPlan(),
      env: {
        QWEN_CODE_PROJECT_DIR: join(dir, 'no-such-project'),
        QWEN_CODE_SESSION_ID: 'S1',
      },
      modelId: MODEL,
    });
    expect(r.event).not.toBe('APPROVE');
    expect(r.body).toContain('transcripts');
  });

  it('approves when the agents actually read their chunks', () => {
    const r = composeReview({
      criticalsInline: 0,
      suggestionsInline: 0,
      planPath: coveredPlan(),
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).toBe('APPROVE');
  });
});

describe('the Step 4/5 gate — verify and reverse audit must have run (high effort)', () => {
  it('caps a clean APPROVE to COMMENT when the reverse audit never ran', () => {
    // The high-value catch: a zero-finding high-effort review that skipped the pass
    // meant to find what Step 3 missed cannot certify the diff clean. compose-review
    // runs only at high effort, so reverse audit is always owed here.
    const r = composeReview({
      criticalsInline: 0,
      suggestionsInline: 0,
      planPath: coveredPlan(['verify']), // reverse audit absent
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).toBe('COMMENT');
    expect(r.cappedBy).toContain('unreviewed-dimension');
    expect(r.body).toMatch(
      /reverse audit — no auditor was launched with a prompt this skill builds/,
    );
  });

  it('does not require the reverse audit at medium effort — a by-design Comment cap, no FIX line', () => {
    // The balanced tier skips Step 5 deliberately. A clean medium review still caps
    // at Comment (it cannot certify the diff the way high does), but the reverse
    // audit must NOT be flagged as a repairable gap: the FIX line telling the
    // orchestrator to run it made the one mandated repair round rebuild the full
    // high pipeline and escalate every medium review back to high.
    const r = composeReview({
      criticalsInline: 0,
      suggestionsInline: 1,
      // verify ran; reverse audit absent BY DESIGN (plan records medium).
      planPath: coveredPlan(['verify'], { effort: 'medium' }),
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).toBe('COMMENT');
    expect(r.cappedBy).toContain('unreviewed-dimension');
    // The disclosure reads as by-design, not as a failure the author must chase.
    expect(r.body).toContain(
      'the balanced (medium) tier skips the second-look pass',
    );
    expect(r.body).not.toMatch(
      /no auditor was launched with a prompt this skill builds/,
    );
    // And crucially: no reverse-audit FIX line, so nothing escalates medium to high.
    expect(r.remediation.join(' ')).not.toContain('reverse audit:');
  });

  it('still requires the verifier at medium — an unverified blocker must not post', () => {
    // Medium runs Step 4. A Critical it did not verify is still held back from
    // becoming a public blocker, exactly as at high — but no reverse-audit
    // remediation appears, because medium never owed it.
    const r = composeReview({
      criticalsInline: 1,
      suggestionsInline: 0,
      planPath: coveredPlan([], { effort: 'medium' }),
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).toBe('COMMENT');
    expect(r.cappedBy).toContain('criticals-unverified');
    const fixes = r.remediation.join(' ');
    expect(fixes).toContain('--role verify');
    expect(fixes).not.toContain('--role reverse-audit');
  });

  it('says one sentence when verify and the reverse audit failed the same way', () => {
    // #7268's posted body carried the two `rewritten` sentences back to back,
    // near-identical but for the tail. Both steps down the same way is one
    // failure with two subjects — while the stderr remediation keeps BOTH
    // rebuild commands, which differ.
    const r = composeReview({
      criticalsInline: 0,
      suggestionsInline: 1,
      planPath: coveredPlan([]), // neither verify nor reverse audit on record
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).toBe('COMMENT');
    expect(r.body).toMatch(
      /Not reviewed: verification and reverse audit — neither the verifier nor the reverse auditor was launched with a prompt this skill builds/,
    );
    expect(r.body).not.toMatch(/reverse audit — no auditor/);
    expect(r.body).not.toMatch(/verification — the review posts findings/);
    const fixes = r.remediation.join(' ');
    expect(fixes).toContain('--role reverse-audit');
    expect(fixes).toContain('--role verify');
  });

  it('softens an unverified Request changes to Comment — no verifier, no blocker', () => {
    // This test used to pin the opposite: "a confirmed Critical still blocks —
    // a cap never softens a REQUEST_CHANGES". The never-soften rule presumes
    // CONFIRMED, and when Step 4 never ran, nothing confirmed anything: a real
    // bot review shipped a CHANGES_REQUESTED onto an external contributor's PR
    // (#7166) whose one Critical its own body disclosed as unverified. The
    // module's stated principle — an unverified finding must not become a
    // public blocker — now has the mechanics on the Request-changes row too.
    const r = composeReview({
      criticalsInline: 1,
      suggestionsInline: 0,
      planPath: coveredPlan(['reverse-audit']), // verifier absent
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).toBe('COMMENT');
    expect(r.baseEvent).toBe('REQUEST_CHANGES');
    expect(r.cappedBy).toContain('criticals-unverified');
    expect(r.body).toMatch(/verification — the review posts findings/);
    // The opener must not certify anything over an unverified blocker.
    expect(r.body).not.toContain('no blockers');
    // The verdict line names what a reader would otherwise chase: a Comment
    // over visible Critical comments reads as a contradiction until it says why.
    expect(verdictLine(r)).toBe(
      'Verdict: Comment — a Request changes was NOT available: its blockers ' +
        'were never verified (they are posted, disclosed as unverified)',
    );
  });

  it('keeps the presubmit downgrade reasons when the unverified cap also holds', () => {
    // The softening runs first, so without the widened downgrade arm the
    // presubmit reasons silently vanished whenever both held. Verdict keeps
    // the unverified sentence; the body downgrade clause carries the reasons.
    const r = composeReview({
      criticalsInline: 1,
      planPath: coveredPlan(['reverse-audit']),
      env: ENV,
      presubmit: {
        downgradeRequestChanges: true,
        downgradeReasons: ['self-PR'],
      },
      modelId: MODEL,
    });
    expect(r.event).toBe('COMMENT');
    expect(r.body).toContain(
      'Downgraded from Request changes to Comment: self-PR',
    );
    expect(verdictLine(r)).toContain('its blockers were never verified');
  });

  it('verify on record with the reverse audit absent still blocks — softening gates on verify alone', () => {
    const r = composeReview({
      criticalsInline: 1,
      planPath: coveredPlan(['verify']),
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).toBe('REQUEST_CHANGES');
    expect(r.cappedBy).not.toContain('criticals-unverified');
  });

  it('keeps the body Criticals when the unverified cap softens the event — the only copy survives', () => {
    // The presubmit RC→Comment carve-out learned this the hard way: a softened
    // event must never erase the body copy of an unanchorable blocker.
    const r = composeReview({
      criticalsInline: 0,
      bodyCriticals: ['whole-PR blocker X'],
      planPath: coveredPlan(['reverse-audit']), // verifier absent
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).toBe('COMMENT');
    expect(r.cappedBy).toContain('criticals-unverified');
    expect(r.body).toContain('**[Critical]** whole-PR blocker X');
  });

  it('a mixed review keeps its Request changes — the deterministic blocker is confirmed with or without a verifier', () => {
    // One [build] Critical (pre-confirmed) beside one non-deterministic
    // Critical with the verifier absent: softening the whole event would
    // un-block a confirmed build failure. The unverified sibling stays
    // disclosed; the Request changes stands on the deterministic one.
    const r = composeReview({
      bodyCriticals: [
        '[build] tsc fails on the merge commit',
        'a real blocker that could not be anchored',
      ],
      planPath: coveredPlan(['reverse-audit']), // verifier absent
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).toBe('REQUEST_CHANGES');
    expect(r.cappedBy).toContain('criticals-unverified');
    expect(r.body).toMatch(/verification — the review posts findings/);
  });

  it('a deterministic-only Request changes stands without a verifier — pre-confirmed by design', () => {
    // [build]/[test] findings are deterministic: CI ran them, nothing a
    // verifier rules on. A review whose only blocker is one must not be
    // softened for skipping a verification it never owed.
    const r = composeReview({
      criticalsInline: 0,
      bodyCriticals: ['[build] tsc fails on main merge'],
      planPath: coveredPlan(['reverse-audit']), // verifier absent, none owed
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).toBe('REQUEST_CHANGES');
    expect(r.cappedBy).not.toContain('criticals-unverified');
  });

  it('a MODEL-written `[lint]` string is NOT deterministic — provenance, not the marker, decides', () => {
    // The gate's own findings are deterministic because `scriptLintGate` read a
    // tool's report; a body Critical a model merely tagged `[lint]` (or that quoted
    // `[lint]` out of the diff) must still be verified — otherwise an unverified or
    // injected claim launders itself into a blocker. With no verifier, it softens.
    const r = composeReview({
      criticalsInline: 0,
      bodyCriticals: [
        '[lint] deploy.sh:3 SC2086 — unquoted $x (model-written)',
      ],
      planPath: coveredPlan(['reverse-audit']), // verifier absent
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).toBe('COMMENT');
    expect(r.cappedBy).toContain('criticals-unverified');
  });

  it('a [probe] finding is deterministic too — a run confirmed it, so it needs no separate verifier', () => {
    // The verifier confirmed this by RUNNING a probe against the code; its
    // evidence is an observed behaviour, so it is pre-confirmed like [build]/[test]
    // and must not be softened for a missing verification it never owed.
    const r = composeReview({
      criticalsInline: 0,
      bodyCriticals: ['[probe] sendShellCommand ran twice for one `!git push`'],
      planPath: coveredPlan(['reverse-audit']), // verifier absent, none owed
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).toBe('REQUEST_CHANGES');
    expect(r.cappedBy).not.toContain('criticals-unverified');
  });

  it('a verified Request changes still blocks — the cap binds only when Step 4 is missing', () => {
    const r = composeReview({
      criticalsInline: 1,
      planPath: coveredPlan(), // verify AND reverse audit ran
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).toBe('REQUEST_CHANGES');
    expect(r.cappedBy).not.toContain('criticals-unverified');
  });

  it('fails closed when there is no plan to check verification against', () => {
    // "Could not show the blockers were verified" and "they were not" read
    // the same to the person the blocker would be posted at.
    const r = composeReview({
      criticalsInline: 1,
      modelId: MODEL,
    });
    expect(r.event).toBe('COMMENT');
    expect(r.cappedBy).toContain('criticals-unverified');
  });

  it('fails closed when the transcripts cannot be read at all', () => {
    const r = composeReview({
      criticalsInline: 1,
      planPath: coveredPlan(),
      env: {
        QWEN_CODE_PROJECT_DIR: join(dir, 'nowhere'),
        QWEN_CODE_SESSION_ID: 'S1',
      },
      modelId: MODEL,
    });
    expect(r.event).toBe('COMMENT');
    expect(r.cappedBy).toContain('criticals-unverified');
  });

  it('does not require a verifier on a review that confirmed nothing', () => {
    // C=0, S=0: nothing to verify. The reverse audit ran, so this approves.
    const r = composeReview({
      criticalsInline: 0,
      suggestionsInline: 0,
      planPath: coveredPlan(['reverse-audit']), // verifier absent, none needed
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).toBe('APPROVE');
    expect(r.body).not.toMatch(/verification/);
  });

  it('approves a review that ran both verify and the reverse audit', () => {
    const r = composeReview({
      criticalsInline: 0,
      suggestionsInline: 0,
      planPath: coveredPlan(), // both present
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).toBe('APPROVE');
  });

  it('requires a verifier for a body Critical that is not pre-confirmed', () => {
    // A non-deterministic Critical that could not be anchored still posts (in the
    // body) and still had to be verified — so a missing verifier is disclosed,
    // the event is softened (an unverified finding must not become a public
    // blocker), and the body copy survives the softening.
    const r = composeReview({
      bodyCriticals: ['a real blocker that could not be anchored'],
      planPath: coveredPlan(['reverse-audit']), // verifier absent
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).toBe('COMMENT');
    expect(r.cappedBy).toContain('criticals-unverified');
    expect(r.body).toMatch(/verification — the review posts findings/);
    expect(r.body).toContain(
      '**[Critical]** a real blocker that could not be anchored',
    );
  });

  it('does not require a verifier for a deterministic [build]/[test] body Critical', () => {
    // A `[build]`/`[test]` finding is pre-confirmed and skips verification by design,
    // so a review whose only finding is one must not be told its findings were
    // unverified — that would post a false disclosure on a correct review.
    const r = composeReview({
      bodyCriticals: ['[build] `npm run build` failed: TS2345 in x.ts'],
      planPath: coveredPlan(['reverse-audit']), // verifier absent, none needed
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).toBe('REQUEST_CHANGES');
    expect(r.body).not.toMatch(/verification/);
  });
});

// `verdictLine` is what Step 6 prints — the one place a verdict exists for the
// user. It had no test, and a review of this change found the reason to want one.
describe('verdictLine — the terminal verdict, and its dangling colon', () => {
  const line = (over: Partial<ComposeReviewResult>): string =>
    verdictLine({
      event: 'COMMENT',
      body: '',
      baseEvent: 'COMMENT',
      cappedBy: [],
      downgraded: false,
      downgradedFrom: null,
      remediation: [],
      lowSignal: null,
      ...over,
    });

  it('names a cap that took an Approve away', () => {
    expect(
      line({
        event: 'COMMENT',
        baseEvent: 'APPROVE',
        cappedBy: ['unreviewed-dimension'],
      }),
    ).toBe(
      'Verdict: Comment — an Approve was NOT available: a dimension nobody reviewed',
    );
  });

  it('does not leave a dangling colon when a downgrade ALONE took the Approve', () => {
    // The bug the review caught: `baseEvent` APPROVE, no cap state, `downgraded`
    // true — the old code joined an empty `cappedBy` and printed
    // "an Approve was NOT available:  — downgraded …", a colon over nothing.
    const out = line({
      event: 'COMMENT',
      baseEvent: 'APPROVE',
      cappedBy: [],
      downgraded: true,
      downgradedFrom: 'Approve',
    });
    expect(out).toBe(
      'Verdict: Comment — an Approve was NOT available: a presubmit check failed',
    );
    expect(out).not.toContain(':  ');
    expect(out).not.toMatch(/:\s*—/);
  });

  it('lists a cap AND a downgrade together when both took the Approve', () => {
    expect(
      line({
        event: 'COMMENT',
        baseEvent: 'APPROVE',
        cappedBy: ['uncoverable-chunk'],
        downgraded: true,
        downgradedFrom: 'Approve',
      }),
    ).toBe(
      'Verdict: Comment — an Approve was NOT available: part of the diff cannot be read at all; a presubmit check failed',
    );
  });

  it('says a Suggestion-only Comment was downgraded, without claiming a lost Approve', () => {
    // baseEvent COMMENT: there was no Approve to lose, but the presubmit still
    // moved the event and the user should see it.
    expect(
      line({
        event: 'COMMENT',
        baseEvent: 'COMMENT',
        downgraded: true,
        downgradedFrom: null,
      }),
    ).toBe('Verdict: Comment — downgraded by a presubmit check');
  });

  it('says a Request changes downgraded to Comment still has blockers', () => {
    // The case a review caught: a presubmit downgrade (self-PR, failing CI) moves a
    // REQUEST_CHANGES — a review with confirmed Criticals — down to COMMENT. Printed
    // as a bare "Comment — downgraded", an operator reads "nothing blocking" while
    // blockers were posted inline. `downgradedFrom` distinguishes it from a
    // Suggestion-only Comment; `baseEvent` cannot (a cap may already have softened
    // the RC before the downgrade ran).
    const out = line({
      event: 'COMMENT',
      baseEvent: 'REQUEST_CHANGES',
      downgraded: true,
      downgradedFrom: 'Request changes',
    });
    expect(out).toContain('Request changes');
    expect(out).toContain('blockers are still posted');
    expect(out).not.toBe('Verdict: Comment — downgraded by a presubmit check');
  });

  it('never names a cap on a Request changes — the blocker earned it, no cap softens it', () => {
    expect(
      line({
        event: 'REQUEST_CHANGES',
        baseEvent: 'REQUEST_CHANGES',
        cappedBy: ['unreviewed-dimension'],
      }),
    ).toBe('Verdict: Request changes');
  });

  it('is bare for a clean Approve', () => {
    expect(line({ event: 'APPROVE', baseEvent: 'APPROVE' })).toBe(
      'Verdict: Approve',
    );
  });

  it("marks a low-signal Approve, with the run's own numbers", () => {
    expect(
      line({
        event: 'APPROVE',
        baseEvent: 'APPROVE',
        lowSignal: { agents: 11, srcDiffLines: 642 },
      }),
    ).toBe(
      'Verdict: Approve — low signal: none of the 11 review agents reported ' +
        'a finding on a non-trivial diff (642 source diff lines)',
    );
  });
});

describe('describeChunkGap — chunk ids leave in the author units', () => {
  const planned = [
    { id: 1, files: ['src/a.ts'] },
    { id: 2, files: ['src/b.ts', 'src/c.ts'] },
    { id: 3, files: ['src/d.ts'] },
  ];

  it('every planned chunk collapses to the diff itself', () => {
    expect(describeChunkGap([2, 1, 3], planned)).toEqual({
      phrase: 'the entire diff',
      phraseZh: '整个 diff',
      plural: false,
    });
  });

  it('names the files of a narrow gap — sorted by id, deduped', () => {
    expect(describeChunkGap([2], planned)).toEqual({
      phrase: 'the diff section covering src/b.ts, src/c.ts',
      phraseZh: '涉及 src/b.ts、src/c.ts 的 diff 片段',
      plural: false,
    });
    expect(describeChunkGap([3, 1], planned)).toEqual({
      phrase: 'the diff sections covering src/a.ts, src/d.ts',
      phraseZh: '涉及 src/a.ts、src/d.ts 的 diff 片段',
      plural: true,
    });
    // A subject disclosed twice is one gap.
    expect(describeChunkGap([2, 2], planned).plural).toBe(false);
  });

  it('counts against the plan when the file list would sprawl', () => {
    const wide = [
      { id: 1, files: ['a.ts', 'b.ts', 'c.ts'] },
      { id: 2, files: ['d.ts', 'e.ts'] },
      { id: 3, files: ['f.ts'] },
    ];
    expect(describeChunkGap([1, 2], wide)).toEqual({
      phrase: "2 of the diff's 3 sections",
      phraseZh: 'diff 3 个片段中的 2 个',
      plural: true,
    });
  });

  it('one unknown chunk poisons the file list — naming the known files would overclaim the rest', () => {
    const partial = [
      { id: 1, files: ['src/a.ts'] },
      { id: 2, files: [] },
      { id: 3, files: ['src/d.ts'] },
    ];
    expect(describeChunkGap([1, 2], partial)).toEqual({
      phrase: "2 of the diff's 3 sections",
      phraseZh: 'diff 3 个片段中的 2 个',
      plural: true,
    });
  });

  it('still says something with no plan to count against', () => {
    expect(describeChunkGap([7], [])).toEqual({
      phrase: '1 section of the diff',
      phraseZh: 'diff 中的 1 个片段',
      plural: false,
    });
    expect(describeChunkGap([9, 7], [])).toEqual({
      phrase: '2 sections of the diff',
      phraseZh: 'diff 中的 2 个片段',
      plural: true,
    });
  });
});

describe('bilingual body — the PR author writes Chinese (prDescriptionHasHan)', () => {
  it('folds the complete Chinese version under the English body, footer outside the fold', () => {
    // Not base(): its planPath default runs coveredPlan() again on the same
    // path and would overwrite the han-stamped plan.
    const r = composeReview({
      suggestionsInline: 1,
      planPath: coveredPlan(undefined, { han: true }),
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).toBe('COMMENT');
    // English leads, untouched.
    expect(
      r.body.startsWith('Reviewed — no blockers. Suggestions are inline.'),
    ).toBe(true);
    // The complete Chinese version rides collapsed.
    expect(r.body).toContain('<details>\n<summary>中文说明</summary>');
    expect(r.body).toContain('已审查——无阻断问题。 建议见行内评论。');
    // One footer, after the fold — never inside it.
    expect(r.body.endsWith(FOOTER)).toBe(true);
    expect(r.body.split(FOOTER)).toHaveLength(2);
    expect(r.body.indexOf('</details>')).toBeLessThan(r.body.indexOf(FOOTER));
  });

  it('stays English-only without the plan flag', () => {
    const r = composeReview(base({ suggestionsInline: 1 }));
    expect(r.body).not.toContain('<details>');
    expect(r.body).not.toContain('中文');
  });

  it('translates the LGTM body', () => {
    const r = composeReview({
      planPath: coveredPlan(undefined, { han: true }),
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).toBe('APPROVE');
    expect(r.body).toContain('No issues found. LGTM! ✅');
    expect(r.body).toContain('未发现问题。LGTM！✅');
  });

  it('translates the disclosures — role phrase and Not-reviewed frame', () => {
    // test-matrix required and never built → one role gap, both languages.
    const p = plan({ han: true });
    transcript('a1', goodPrompt(1), { toolCalls: 3 });
    transcript('a2', goodPrompt(2), { toolCalls: 2 });
    recordBuilt(p, 1);
    recordBuilt(p, 2);
    const r = composeReview({ planPath: p, env: ENV, modelId: MODEL });
    expect(r.body).toContain(
      'Not reviewed: the whole-diff test-coverage check',
    );
    expect(r.body).toContain('未审查：全 diff 测试覆盖检查——');
    // The zh sentence carries the translated reason, not the English one.
    expect(r.body).toContain('没有记录表明它的 brief 到达过任何 agent');
  });

  it('quotes untranslatable caller text as-is in both halves', () => {
    const r = composeReview({
      suggestionsInline: 1,
      cannotTellCriticals: ['old blocker at a.ts:1 — still reachable?'],
      planPath: coveredPlan(undefined, { han: true }),
      env: ENV,
      modelId: MODEL,
    });
    expect(r.body).toContain('Unresolved, please confirm:');
    expect(r.body).toContain('未决，请确认：');
    // The caller's text, once per half.
    expect(
      r.body.match(/old blocker at a\.ts:1 — still reachable\?/g) ?? [],
    ).toHaveLength(2);
  });
});

/**
 * The plan flag is the deterministic path; this is the recovery for when it is
 * missing. `fetch-pr` always writes `prDescriptionHasHan`, but a `plan-diff`
 * plan never does, and an orchestrator that improvises the pipeline can hand
 * `compose-review` a plan that is not `fetch-pr`'s report — which is how a
 * Chinese-authored PR (#7686) shipped an English-only review while the four
 * bot reviews before it, off a proper plan, were bilingual. When the flag is
 * absent but the plan still names the PR, the register is recovered from the
 * live description, which the caller cannot forge.
 */
describe('bilingual body — recovered from the live PR when the plan omits the flag', () => {
  /** A covered plan with a PR identity but no `prDescriptionHasHan`, its mtime
   *  kept old so its transcripts still read as newer than it. */
  function namedPlanWithoutFlag(): string {
    const p = coveredPlan();
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    delete parsed.prDescriptionHasHan;
    parsed.ownerRepo = 'QwenLM/qwen-code';
    parsed.prNumber = '7686';
    writeFileSync(p, JSON.stringify(parsed));
    const old = new Date(2020, 0, 1);
    utimesSync(p, old, old);
    return p;
  }

  /** A fetcher that records its calls, so a test can prove it was NOT reached. */
  function recordingFetcher(body: string): PrBodyFetcher & { calls: number } {
    const fn = ((_ownerRepo: string, _prNumber: string) => {
      fn.calls++;
      return body;
    }) as PrBodyFetcher & { calls: number };
    fn.calls = 0;
    return fn;
  }

  it('folds in Chinese when the recovered description contains Han', () => {
    const fetch = recordingFetcher('这个 PR 懒加载首次使用的依赖。');
    const r = composeReview({
      suggestionsInline: 1,
      planPath: namedPlanWithoutFlag(),
      prBodyFetcher: fetch,
      env: ENV,
      modelId: MODEL,
    });
    expect(fetch.calls).toBe(1);
    // Both halves: the English rides above the fold, the Chinese inside it.
    expect(r.body).toContain('<details>\n<summary>中文说明</summary>');
    expect(r.body).toContain('Suggestions are inline.');
    expect(r.body).toContain('建议见行内评论。');
  });

  it('stays English when the recovered description has no Han', () => {
    const fetch = recordingFetcher(
      'This PR lazy-loads first-use dependencies.',
    );
    const r = composeReview({
      suggestionsInline: 1,
      planPath: namedPlanWithoutFlag(),
      prBodyFetcher: fetch,
      env: ENV,
      modelId: MODEL,
    });
    expect(fetch.calls).toBe(1);
    expect(r.body).not.toContain('<details>');
    expect(r.body).not.toContain('中文');
  });

  it('honours a recorded false without fetching — the English author is settled', () => {
    // A real fetch-pr report that fetched the body and found no Han. Re-reading
    // the live PR on every English review would be waste, and the recorded
    // snapshot is the answer.
    const p = coveredPlan();
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    parsed.prDescriptionHasHan = false;
    parsed.ownerRepo = 'QwenLM/qwen-code';
    parsed.prNumber = '7686';
    writeFileSync(p, JSON.stringify(parsed));
    const old = new Date(2020, 0, 1);
    utimesSync(p, old, old);
    const fetch = recordingFetcher('这段中文绝不该被读到。');
    const r = composeReview({
      suggestionsInline: 1,
      planPath: p,
      prBodyFetcher: fetch,
      env: ENV,
      modelId: MODEL,
    });
    expect(fetch.calls).toBe(0);
    expect(r.body).not.toContain('<details>');
  });

  it('does not fetch when the plan carries no PR identity', () => {
    const fetch = recordingFetcher('这段中文绝不该被读到。');
    const r = composeReview({
      suggestionsInline: 1,
      planPath: coveredPlan(), // no ownerRepo/prNumber, no flag
      prBodyFetcher: fetch,
      env: ENV,
      modelId: MODEL,
    });
    expect(fetch.calls).toBe(0);
    expect(r.body).not.toContain('<details>');
  });

  it('falls back to English when the fetch throws — language never takes the review down', () => {
    const boom: PrBodyFetcher = () => {
      throw new Error('gh unreachable');
    };
    const r = composeReview({
      suggestionsInline: 1,
      planPath: namedPlanWithoutFlag(),
      prBodyFetcher: boom,
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).toBe('COMMENT');
    expect(r.body).not.toContain('<details>');
    expect(r.body).not.toContain('中文');
    expect(r.body).toContain('Suggestions are inline.');
  });

  it('the production reader calls gh pr view with the right args and parses the body', () => {
    // All other tests in this block inject a fetcher, leaving fetchPrBodyViaGh —
    // the only new production behaviour — unpinned. A wrong --json field, a
    // dropped JSON.parse, or a body→bodyText slip would ship English-only reviews
    // with CI clean. This test reddens under those mutants.
    ghMock.mockReturnValue('{"body":"这个 PR 修复了双语渲染。"}');
    const r = composeReview({
      suggestionsInline: 1,
      planPath: namedPlanWithoutFlag(),
      env: ENV,
      modelId: MODEL,
    });
    expect(ghMock).toHaveBeenCalledWith(
      'pr',
      'view',
      '7686',
      '--repo',
      'QwenLM/qwen-code',
      '--json',
      'body',
    );
    expect(r.body).toContain('<details>\n<summary>中文说明</summary>');
  });

  it('strips a model-supplied prBodyFetcher — it cannot suppress the Chinese fold', async () => {
    // The handler deletes prBodyFetcher from the input JSON (the same way it
    // deletes env). Without that delete, "suppress" reaches bilingualFromPlan,
    // is called as a function, throws, and the catch drops the fold — the exact
    // regression this PR closes, through the alternate entry point.
    ghMock.mockReturnValue('{"body":"这个 PR 修复了双语渲染。"}');
    const handlerDir = mkdtempSync(join(tmpdir(), 'compose-fetcher-'));
    try {
      const planPath = join(handlerDir, 'plan.json');
      const p = namedPlanWithoutFlag();
      writeFileSync(planPath, readFileSync(p, 'utf8'));
      const old = new Date(2020, 0, 1);
      utimesSync(planPath, old, old);
      const inputPath = join(handlerDir, 'in.json');
      writeFileSync(
        inputPath,
        JSON.stringify({
          planPath,
          prBodyFetcher: 'suppress',
          modelId: MODEL,
        }),
      );
      const commentsPath = join(handlerDir, 'comments.json');
      writeFileSync(commentsPath, '[]', 'utf8');
      const outPath = join(handlerDir, 'out.json');
      await runComposeReviewCommand({
        input: inputPath,
        comments: commentsPath,
        out: outPath,
      });
      const written = JSON.parse(
        readFileSync(outPath, 'utf8'),
      ) as ComposeReviewResult;
      // If prBodyFetcher had NOT been stripped, "suppress" would throw and the
      // fold would be absent. Its presence proves the handler stripped it.
      expect(written.body).toContain('<details>\n<summary>中文说明</summary>');
    } finally {
      rmSync(handlerDir, { recursive: true, force: true });
    }
  });
});

describe('scriptLintGate — the deterministic gate reads the report', () => {
  // Unit-level: the gate turns the orchestrator's report into verdict inputs
  // (compose-review's coverage machinery is exercised elsewhere). A same-repo plan
  // carries a worktreePath; without one (diff-only) the orchestrator could not run
  // the command, so the gate must stay silent.
  //
  // Fixtures are FRESH by default: a captured diff exists and both the plan and the
  // report bind to its hash, so the happy-path tests exercise the gate on a verified
  // report — not through the fail-open branch. A freshness test overrides one side
  // (a mismatching hash, or `diffHash: undefined`) to model staleness.
  let freshDiff: { path: string; hash: string };
  beforeEach(() => {
    freshDiff = writeDiff();
  });
  function writePlan(over: Record<string, unknown>): string {
    const p = join(dir, 'plan.json');
    writeFileSync(
      p,
      JSON.stringify({
        worktreePath: '.qwen/tmp/review-pr-1',
        diffPathAbsolute: freshDiff.path,
        files: [{ path: 'deploy.sh', kind: 'source', addedLines: 3 }],
        ...over,
      }),
    );
    return p;
  }
  function writeReport(
    report: Record<string, unknown>,
    name = 'qwen-review-script-lint.json',
  ): void {
    writeFileSync(
      join(dir, name),
      JSON.stringify({
        checked: [],
        skipped: [],
        errored: [],
        ok: true,
        note: '',
        diffHash: freshDiff.hash,
        ...report,
      }),
    );
  }
  const finding = (over: Record<string, unknown> = {}) => ({
    line: 3,
    code: 'SC2086',
    level: 'info',
    message: 'Double quote to prevent globbing',
    inDiff: true,
    ...over,
  });
  const withFinding = (f: Record<string, unknown>) => ({
    checked: [{ path: 'deploy.sh', tool: 'shellcheck', findings: [f] }],
    ok: false,
  });
  /** Write a captured diff and return its path + the hash the gate will compute. */
  function writeDiff(content = 'diff --git a/x b/x\n@@ -0,0 +1 @@\n+added\n'): {
    path: string;
    hash: string;
  } {
    const dp = join(dir, 'pr.diff');
    writeFileSync(dp, content);
    const hash = createHash('sha256').update(readFileSync(dp)).digest('hex');
    return { path: dp, hash };
  }

  it('turns an inDiff finding (above style) into a [lint] critical', () => {
    const p = writePlan({});
    writeReport(withFinding(finding()));
    const g = scriptLintGate(p);
    expect(g.criticals).toHaveLength(1);
    expect(g.criticals[0]).toContain('SC2086');
    expect(g.criticals[0]).toContain('[lint]');
    expect(g.unreviewed).toEqual([]);
  });

  it('fails closed on a STALE report — its diffHash disagrees with the plan diff', () => {
    const p = writePlan({}); // plan binds to the fresh diff
    writeReport({ ...withFinding(finding()), diffHash: 'a-different-hash' });
    const g = scriptLintGate(p);
    // The finding is NOT trusted (it was produced against a different diff); the
    // review is unreviewed until script-lint re-runs against this one.
    expect(g.criticals).toEqual([]);
    expect(g.unreviewed).toHaveLength(1);
    expect(g.unreviewed[0]).toContain('stale');
  });

  it('accepts a report whose diffHash matches the plan diff (fresh)', () => {
    const p = writePlan({}); // both bind to the fresh diff by default
    writeReport(withFinding(finding()));
    const g = scriptLintGate(p);
    expect(g.criticals).toHaveLength(1);
    expect(g.unreviewed).toEqual([]);
  });

  it('fails closed when the plan diff is readable but the report has no diffHash', () => {
    // The command could not hash the diff → no `diffHash`. When the plan's diff IS
    // readable, an unverifiable report must not be trusted (the guard is not a no-op).
    const p = writePlan({}); // readable diff
    writeReport({ ...withFinding(finding()), diffHash: undefined }); // no diffHash
    const g = scriptLintGate(p);
    expect(g.criticals).toEqual([]);
    expect(g.unreviewed[0]).toContain('stale');
  });

  it('fails closed when NEITHER side has a hash — undefined must not equal undefined', () => {
    // The unverifiable case its own comment claims to fail closed on: the plan names
    // no readable diff AND the report carries no hash. `undefined !== undefined` is
    // false, so a bare `!==` guard would ACCEPT an arbitrary report and promote its
    // findings to blockers. The `!planDiffHash` arm is what closes it.
    const p = writePlan({ diffPathAbsolute: '/no/such/diff.txt' });
    writeReport({ ...withFinding(finding()), diffHash: undefined });
    const g = scriptLintGate(p);
    expect(g.criticals).toEqual([]);
    expect(g.unreviewed).toHaveLength(1);
    expect(g.unreviewed[0]).toContain('stale');
  });

  it('the staleness guard catches an uncommitted LOCAL edit (content, not HEAD)', () => {
    // A local plan (untrackedFiles present, no worktreePath) is `local` mode, not
    // diff-only, so the gate is armed. The identity is the DIFF's content, so an
    // uncommitted edit that changes the diff — HEAD unchanged — still invalidates a
    // stale report. This is exactly the local case a HEAD-based guard would miss.
    const d = writeDiff('diff --git a/x b/x\n@@ -0,0 +1 @@\n+edited\n');
    const p = writePlan({
      worktreePath: undefined,
      untrackedFiles: [],
      diffPathAbsolute: d.path,
    });
    writeReport({
      ...withFinding(finding()),
      diffHash: 'hash-of-the-old-diff',
    });
    const g = scriptLintGate(p);
    expect(g.criticals).toEqual([]);
    expect(g.unreviewed[0]).toContain('stale');
  });

  it('a DEFERRED report is disclosed but does NOT cap the verdict (actionlint deferral)', () => {
    // actionlint is deferred, not skipped/errored — a workflow-only PR whose only
    // "problem" is the deferral must NOT be made un-Approvable. It contributes
    // nothing to criticals/unreviewed (so it cannot cap), but it IS surfaced in
    // `disclosed` so the body can say the workflow's shell went un-linted.
    const p = writePlan({
      files: [{ path: '.github/workflows/ci.yml', kind: 'source' }],
    });
    writeReport({
      deferred: [
        {
          path: '.github/workflows/ci.yml',
          tool: 'actionlint',
          reason: 'source mapping not yet supported',
        },
      ],
    });
    const g = scriptLintGate(p);
    expect(g.criticals).toEqual([]);
    expect(g.unreviewed).toEqual([]);
    expect(g.disclosed).toHaveLength(1);
    expect(g.disclosed[0]).toContain('.github/workflows/ci.yml');
    expect(g.disclosed[0]).toContain('source mapping not yet supported');
  });

  it('ignores a cosmetic (style) or pre-existing (inDiff:false) finding', () => {
    const p = writePlan({});
    writeReport({
      checked: [
        {
          path: 'deploy.sh',
          tool: 'shellcheck',
          findings: [finding({ level: 'style' }), finding({ inDiff: false })],
        },
      ],
    });
    expect(scriptLintGate(p).criticals).toEqual([]);
  });

  it('reports a skipped checker as unreviewed, surfacing its own reason', () => {
    const p = writePlan({});
    writeReport({
      skipped: [
        {
          path: '.github/workflows/ci.yml',
          tool: 'actionlint',
          reason: 'actionlint source mapping not yet supported',
        },
      ],
    });
    const g = scriptLintGate(p);
    expect(g.criticals).toEqual([]);
    expect(g.unreviewed).toHaveLength(1);
    // the FILE and the entry's own reason are disclosed (not a hardcoded string)
    expect(g.unreviewed[0]).toContain('.github/workflows/ci.yml');
    expect(g.unreviewed[0]).toContain('not yet supported');
  });

  it('neutralises a PR-controlled path before it reaches the review body', () => {
    // A filename is workspace-controlled and git allows almost any byte in one, so a
    // path carrying a newline / `@team` / Markdown must not inject structure or a
    // mention into the body we post. It is rendered in an inline code span with
    // backticks and newlines stripped.
    const p = writePlan({});
    writeReport({
      deferred: [
        {
          path: '.github/workflows/x.yml\n@acme-team `pwn`',
          tool: 'actionlint',
          reason: 'source mapping not yet supported',
        },
      ],
    });
    const g = scriptLintGate(p);
    expect(g.disclosed).toHaveLength(1);
    const d = g.disclosed[0];
    expect(d).not.toContain('\n'); // newline stripped — cannot forge a body line
    expect(d).not.toContain('`pwn`'); // the PR's own backticks stripped — cannot break out
    // `@acme-team` sits INSIDE a code span (backtick … no backtick … backtick), so
    // it is inert as a GitHub mention — the whole path rendered as one code span.
    expect(d).toMatch(/`[^`\n]*@acme-team[^`\n]*`/);
  });

  it('reports an errored checker as unreviewed (fail closed)', () => {
    const p = writePlan({});
    writeReport({
      errored: [{ path: 'deploy.sh', tool: 'shellcheck', reason: 'exited 2' }],
    });
    expect(scriptLintGate(p).unreviewed[0]).toContain('errored');
  });

  it('fails closed when owed but no report was produced', () => {
    const p = writePlan({}); // no report file written
    const g = scriptLintGate(p);
    expect(g.unreviewed).toHaveLength(1);
    expect(g.unreviewed[0]).toContain('produced no report');
  });

  it('surfaces its OWN reason when the plan itself cannot be read', () => {
    // The coverage machinery also caps an unreadable plan, so the verdict is capped
    // either way — but the gate must still contribute its specific reason rather than
    // go silent (delete the plan-parse `unreviewed.push` and this disclosure vanishes
    // while the cap stays, which is exactly the sentence a reader loses).
    const g = scriptLintGate(join(dir, 'does-not-exist.json'));
    expect(g.criticals).toEqual([]);
    expect(g.unreviewed).toHaveLength(1);
    expect(g.unreviewed[0]).toContain('could not read the plan');
  });

  it('reads a fresh report for a shebang script the path-predicate misses', () => {
    // hasExecutableScript('.husky/pre-commit') is false (path-only), but the
    // command shebang-detected it and reported a finding. The gate reads the
    // report regardless of the predicate, so the finding is NOT dropped.
    const p = writePlan({
      files: [{ path: '.husky/pre-commit', kind: 'source' }],
    });
    writeReport({
      checked: [
        {
          path: '.husky/pre-commit',
          tool: 'shellcheck',
          findings: [finding()],
        },
      ],
      ok: false,
    });
    const g = scriptLintGate(p);
    expect(g.criticals).toHaveLength(1);
    expect(g.criticals[0]).toContain('.husky/pre-commit');
  });

  it('is a no-op when nothing was owed and no report exists', () => {
    const p = writePlan({ files: [{ path: 'a.ts', kind: 'source' }] });
    // no report written — not owed by path, and none produced → contribute nothing
    expect(scriptLintGate(p)).toEqual({
      criticals: [],
      unreviewed: [],
      disclosed: [],
    });
  });

  it('is a no-op on a diff-only review — no worktree to have run it', () => {
    const p = writePlan({ worktreePath: undefined });
    writeReport({
      errored: [{ path: 'deploy.sh', tool: 'shellcheck', reason: 'x' }],
    });
    expect(scriptLintGate(p)).toEqual({
      criticals: [],
      unreviewed: [],
      disclosed: [],
    });
  });

  it('derives the pr-numbered report name from the plan', () => {
    const p = writePlan({ prNumber: '42' });
    writeReport(withFinding(finding()), 'qwen-review-pr-42-script-lint.json');
    expect(scriptLintGate(p).criticals).toHaveLength(1);
  });
});

describe('composeReview — the script-lint gate wired to the verdict', () => {
  // A worktree arms the gate (pr-worktree, not diff-only). That mode also owes the
  // cross-file (1c) and build-and-test (7) roles, so a test that wants the gate's
  // own outcome to decide the verdict — not an unrelated dimension gap — must record
  // them too. `step45Keys` threads through to `coveredPlan` so a caller can drop the
  // verifier (['reverse-audit']) to prove a finding stands with none.
  function gateReadyPlan(
    step45Keys: string[] = ['verify', 'reverse-audit'],
  ): string {
    const p = coveredPlan(step45Keys);
    const planObj = JSON.parse(readFileSync(p, 'utf8'));
    planObj.worktreePath = '.qwen/tmp/review-pr-1';
    writeFileSync(p, JSON.stringify(planObj));
    for (const role of ['1c', '7']) {
      const d = promptRecordDir(p);
      mkdirSync(d, { recursive: true });
      const brief = briefPath(p, role);
      writeFileSync(brief, `The ${role} brief.`);
      const launch = `You are review agent \`${role}\`.\nread_file(file_path="${brief}")\nread_file(file_path="${DIFF}")`;
      writeFileSync(join(d, `${role}.txt`), launch);
      transcript(`r-${role}`, launch, { toolCalls: 2, opens: [brief] });
    }
    const old = new Date(2020, 0, 1);
    utimesSync(p, old, old);
    return p;
  }
  function writeGateReport(report: Record<string, unknown>): void {
    writeFileSync(
      join(dir, 'qwen-review-script-lint.json'),
      JSON.stringify({
        checked: [],
        skipped: [],
        errored: [],
        ok: true,
        note: '',
        // Bind to the plan's diff (coveredPlan sets diffPathAbsolute: DIFF) so the
        // gate reads a FRESH report, not one that slips through the fail-open branch.
        diffHash: DIFF_HASH,
        ...report,
      }),
    );
  }
  const lintFinding = {
    path: 'deploy.sh',
    tool: 'shellcheck',
    findings: [
      { line: 3, code: 'SC2086', level: 'info', message: 'x', inDiff: true },
    ],
  };

  it('a [lint] critical yields REQUEST_CHANGES, deterministically (no verifier)', () => {
    // Same-repo (worktreePath) so the gate fires; a [lint] finding is pre-confirmed,
    // so its Request changes stands with or without full coverage or a verifier.
    const p = gateReadyPlan();
    writeGateReport({ checked: [lintFinding], ok: false });
    const r = composeReview({
      criticalsInline: 0,
      suggestionsInline: 0,
      planPath: p,
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).toBe('REQUEST_CHANGES');
    expect(r.body).toContain('SC2086');
  });

  it('the gate critical is deterministic by PROVENANCE — it stands with NO verifier', () => {
    // The gate ran the linter, so its finding is pre-confirmed and skips Step 4 —
    // exactly like [build]/[test]/[probe]. A verifier is absent here (only the
    // reverse audit ran), yet the Request changes must stand and must NOT be flagged
    // criticals-unverified. Provenance (the gate produced it), not a tag, earns this:
    // the gate's criticals are tracked apart from the model's, never counted as
    // claims needing verification.
    const p = gateReadyPlan(['reverse-audit']); // verifier absent, none owed
    writeGateReport({ checked: [lintFinding], ok: false });
    const r = composeReview({
      criticalsInline: 0,
      suggestionsInline: 0,
      planPath: p,
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).toBe('REQUEST_CHANGES');
    expect(r.cappedBy).not.toContain('criticals-unverified');
    expect(r.body).toContain('SC2086');
  });

  it('a [probe] in a GATE finding text does not erase a model claim’s verification (identity, not count)', () => {
    // Provenance is by IDENTITY, not by count-subtraction. The gate produces a [lint]
    // finding whose MESSAGE happens to contain "[probe]", AND the model reports a
    // plain unverified blocker. A count-based `(filtered) − gateCount` would drop the
    // gate finding from the filtered set (it matches [probe]) and then subtract the
    // gate count anyway — erasing the MODEL claim's verification requirement, so the
    // unverified blocker would post unflagged. Identity-based tracking must keep the
    // model claim flagged as needing verification even with no verifier on record.
    const p = gateReadyPlan(['reverse-audit']); // verifier absent
    writeGateReport({
      checked: [
        {
          path: 'deploy.sh',
          tool: 'shellcheck',
          findings: [
            {
              line: 3,
              code: 'SC2086',
              level: 'info',
              message: 'quote the [probe] variable',
              inDiff: true,
            },
          ],
        },
      ],
      ok: false,
    });
    const r = composeReview({
      criticalsInline: 0,
      suggestionsInline: 0,
      bodyCriticals: ['an unanchored blocker the review could not verify'],
      planPath: p,
      env: ENV,
      modelId: MODEL,
    });
    // The gate [lint] blocker still earns Request changes...
    expect(r.event).toBe('REQUEST_CHANGES');
    // ...and the model's plain critical is STILL flagged as needing verification —
    // the "[probe]" in the gate finding did not absorb its verification requirement.
    expect(r.body).toMatch(/verification — the review posts findings/);
    expect(r.body).toContain(
      'an unanchored blocker the review could not verify',
    );
  });

  it('an ERRORED checker caps a would-be APPROVE to COMMENT and says the lint is unreviewed', () => {
    // A clean, fully-covered plan Approves — except the gate reports a checker that
    // errored (fail closed). That unreviewed scope must reach the cap: the verdict
    // drops to Comment and the body names the lint. Delete the `unreviewed.push` that
    // wires the gate to the cap and this silently Approves over an unrun linter.
    const p = gateReadyPlan();
    writeGateReport({
      errored: [{ path: 'deploy.sh', tool: 'shellcheck', reason: 'exited 2' }],
      ok: false,
    });
    const r = composeReview({
      criticalsInline: 0,
      suggestionsInline: 0,
      planPath: p,
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).toBe('COMMENT');
    expect(r.body).toContain('the executable-script lint');
    // the PR-controlled path is rendered in a Markdown code span (injection-safe)
    expect(r.body).toContain('errored on `deploy.sh`');
  });

  it('a DEFERRED-only report keeps APPROVE but discloses the deferral in the body', () => {
    // A fully-covered plan Approves. Its only script-lint outcome is a deferred
    // actionlint (a workflow's embedded shell) — which must NOT cap the Approve,
    // but MUST be surfaced in the body so the reader knows that shell went unlinted.
    // The gate reads the report as the sole authority, so the deferral is disclosed
    // from the report itself; the plan stays fully covered so the Approve stands.
    const p = gateReadyPlan();
    writeGateReport({
      deferred: [
        {
          path: '.github/workflows/ci.yml',
          tool: 'actionlint',
          reason: 'source mapping not yet supported',
        },
      ],
    });
    const r = composeReview({
      criticalsInline: 0,
      suggestionsInline: 0,
      planPath: p,
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).toBe('APPROVE');
    expect(r.body).toContain('.github/workflows/ci.yml');
    expect(r.body).toContain('source mapping not yet supported');
    // the LGTM copy is still there — the disclosure augments, it doesn't replace
    expect(r.body).toContain('LGTM');
  });
});

describe('testPlanGate — Test Plan rulings, disclosed but never capping', () => {
  // The gate's whole contract is that it produces NOTES and nothing else: no
  // critical, no cap, no unreviewed scope. Every test here is really the same
  // assertion from a different angle — a Test Plan defect must never be able to
  // change what the review does to the pull request.
  let diffPath: string;
  let diffHash: string;

  beforeEach(() => {
    diffPath = join(dir, 'pr.diff');
    writeFileSync(diffPath, 'diff --git a/x b/x\n@@ -0,0 +1 @@\n+added\n');
    diffHash = createHash('sha256')
      .update(readFileSync(diffPath))
      .digest('hex');
  });

  const writePlan = (over: Record<string, unknown> = {}): string => {
    const p = join(dir, 'plan.json');
    writeFileSync(
      p,
      JSON.stringify({ prNumber: 1, diffPathAbsolute: diffPath, ...over }),
    );
    return p;
  };
  const writeReport = (
    claims: Array<Record<string, unknown>>,
    over: Record<string, unknown> = {},
    name = 'qwen-review-pr-1-test-plan.json',
  ) =>
    writeFileSync(
      join(dir, name),
      JSON.stringify({ found: true, claims, diffHash, note: '', ...over }),
    );

  it('renders a contradicted claim with what was observed', () => {
    const p = writePlan();
    writeReport([
      {
        kind: 'path',
        text: 'src/ghost.test.ts',
        verdict: 'contradicted',
        observed: 'no such file or directory',
      },
    ]);
    // Both halves go through `mdField`: the claim is the author's text and the
    // observation is read back off disk, so neither is trusted to be inert
    // markdown.
    expect(testPlanGate(p).notes).toEqual([
      '`src/ghost.test.ts` — `no such file or directory`',
    ]);
  });

  it('renders a differing count as an observation, not a contradiction', () => {
    const p = writePlan();
    writeReport([
      {
        kind: 'count',
        text: '471 tests passed',
        verdict: 'differs',
        observed: '472 passed',
      },
    ]);
    expect(testPlanGate(p).notes).toEqual([
      '`471 tests passed` — this review observed `472 passed`',
    ]);
  });

  it('says nothing about claims that reproduced or could not be checked', () => {
    const p = writePlan();
    writeReport([
      { kind: 'command', text: 'npm run build', verdict: 'reproduces' },
      { kind: 'count', text: '9 tests passed', verdict: 'unchecked' },
    ]);
    expect(testPlanGate(p).notes).toEqual([]);
  });

  it('stays silent on a local review — there is no PR body to have checked', () => {
    const p = writePlan({ prNumber: undefined });
    writeReport([
      { kind: 'path', text: 'src/ghost.ts', verdict: 'contradicted' },
    ]);
    expect(testPlanGate(p).notes).toEqual([]);
  });

  it('drops a STALE report rather than quoting a previous commit Test Plan', () => {
    const p = writePlan();
    writeReport([{ kind: 'path', text: 'src/g.ts', verdict: 'contradicted' }], {
      diffHash: 'a-different-hash',
    });
    expect(testPlanGate(p).notes).toEqual([]);
  });

  it('does not cap or block when the report is missing or the plan is unreadable', () => {
    // The `deferred`-checker precedent: a limitation the author cannot fix must
    // never make a PR un-Approvable. Both paths return notes only.
    expect(testPlanGate(writePlan()).notes).toEqual([]);
    expect(testPlanGate(join(dir, 'nope.json')).notes).toEqual([]);
  });

  it('caps notes at five plus a summary line', () => {
    const p = writePlan();
    writeReport(
      Array.from({ length: 8 }, (_, i) => ({
        kind: 'count',
        text: `${i + 1} passed`,
        verdict: 'differs',
        observed: '999 passed',
      })),
    );
    const notes = testPlanGate(p).notes;
    expect(notes).toHaveLength(6);
    expect(notes[5]).toBe('and 3 more');
  });
});

describe('buildLedger', () => {
  it('gives a text-less finding a locating title instead of an empty one', () => {
    // A comment that is nothing but its severity marker used to yield an empty
    // title, and an empty title jams the review rather than merely degrading
    // the entry: the next round is told every ledger entry is owed a ruling,
    // has no claim to rule on, answers `cannot tell`, and that is
    // `cannot-tell-existing-critical` — a cap that nothing between rounds can
    // lift. Keep the entry (the Critical really was posted) and hand over the
    // one handle there is.
    const l = buildLedger(
      2,
      [{ path: 'packages/cli/src/a.ts', line: 42, body: '**[Critical]**' }],
      ['   '],
    );
    expect(l.findings[0].title).toContain('packages/cli/src/a.ts:42');
    expect(l.findings[0].title).not.toBe('');
    expect(l.findings[1].title).toContain('the review body');
    // A finding that DID carry text is untouched.
    expect(
      buildLedger(
        2,
        [{ path: 'a.ts', line: 1, body: '**[Critical]** real claim' }],
        [],
      ).findings[0].title,
    ).toBe('real claim');
  });

  it('numbers findings round-scoped, inline first then body Criticals', () => {
    const l = buildLedger(
      3,
      [
        {
          path: 'src/a.ts',
          line: 12,
          body: '**[Critical]**: double free\ndetail',
        },
        { path: 'src/b.ts', line: 4, body: '**[Suggestion]** untested guard' },
        { path: 'src/c.ts', body: 'no marker — not a finding' },
      ],
      ['`src/d.ts` unanchorable blocker'],
    );
    expect(l.round).toBe(3);
    expect(l.findings).toEqual([
      {
        id: 'R3-1',
        sev: 'C',
        file: 'src/a.ts',
        line: 12,
        title: 'double free',
      },
      {
        id: 'R3-2',
        sev: 'S',
        file: 'src/b.ts',
        line: 4,
        title: 'untested guard',
      },
      {
        id: 'R3-3',
        sev: 'C',
        file: '(body)',
        title: '`src/d.ts` unanchorable blocker',
      },
    ]);
  });

  it('classifies through `severityOf`, whitespace and all', () => {
    // The ledger restated the severity predicate as a bare `startsWith`, while
    // `countInlineFindings` — the count the VERDICT is computed from — trims
    // first. A Critical whose body opened with a newline was therefore counted,
    // posted, blocked the merge, and was silently missing from the ledger,
    // shifting the id of every finding after it.
    const drafted = [
      { path: 'src/a.ts', line: 1, body: '\n  **[Critical]** leading space' },
      { path: 'src/b.ts', line: 2, body: '**[Suggestion]** plain' },
    ];
    expect(countInlineFindings(drafted)).toEqual({
      criticalsInline: 1,
      suggestionsInline: 1,
    });
    expect(buildLedger(1, drafted, []).findings).toEqual([
      {
        id: 'R1-1',
        sev: 'C',
        file: 'src/a.ts',
        line: 1,
        title: 'leading space',
      },
      { id: 'R1-2', sev: 'S', file: 'src/b.ts', line: 2, title: 'plain' },
    ]);
  });

  it('keeps a carried-forward id instead of renumbering it by position', () => {
    // Step 6 re-reports a still-standing finding under its ORIGINAL id, so the
    // report says `R1-2 still stands` — and a ledger that renumbered it `R3-1`
    // handed the next round a work list keyed by ids the report never used,
    // which is the whole thing `R1-2 names the same claim every round` promised.
    const l = buildLedger(
      3,
      [
        { path: 'a.ts', line: 4, body: '**[Critical]** R1-2: still leaking' },
        { path: 'b.ts', body: '**[Suggestion]** brand new this round' },
        { path: 'c.ts', body: '**[Critical]** R2-1 — moved but the same' },
      ],
      ['R1-5) the unanchorable one, still open'],
    );
    expect(l.findings.map((f) => `${f.id}|${f.title}`)).toEqual([
      'R1-2|still leaking',
      'R3-1|brand new this round',
      'R2-1|— moved but the same',
      'R1-5|the unanchorable one, still open',
    ]);
  });

  it('never issues one id twice, however the comments are worded', () => {
    // A duplicated carried id (a copy-paste, or a title that merely opens like
    // one) must not collapse two claims onto one ledger entry.
    const l = buildLedger(
      2,
      [
        { path: 'a.ts', body: '**[Critical]** R1-1: one' },
        { path: 'b.ts', body: '**[Critical]** R1-1: two, same id' },
      ],
      [],
    );
    expect(l.findings.map((f) => f.id)).toEqual(['R1-1', 'R2-1']);
  });
});

describe('the ledger marker reaches the POSTED body', () => {
  // The feature was inert end to end: the marker was appended in the CLI
  // handler, after composeReview() returned, so it reached only the composed
  // JSON on disk — and `submit` posts what the PURE function returns. Every
  // assertion here goes through composeReview, the path GitHub receives.
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ledger-e2e-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const plan = (over: Record<string, unknown> = {}) => {
    const p = join(dir, 'plan.json');
    writeFileSync(p, JSON.stringify({ prNumber: 8255, ...over }));
    return p;
  };

  it('appends the marker to the body composeReview returns', () => {
    const r = composeReview({
      planPath: plan(),
      modelId: 'm',
      criticalsInline: 0,
      suggestionsInline: 0,
      draftedComments: [
        { path: 'src/a.ts', line: 3, body: '**[Suggestion]** untested guard' },
      ],
    });
    expect(r.body).toContain('<!-- qwen-review-ledger ');
    const ledger = parseLedger(r.body)!;
    expect(ledger.round).toBe(1);
    expect(ledger.findings).toEqual([
      {
        id: 'R1-1',
        sev: 'S',
        file: 'src/a.ts',
        line: 3,
        title: 'untested guard',
      },
    ]);
  });

  it('stores stripped body Criticals in the posted ledger marker', () => {
    const r = composeReview({
      planPath: plan(),
      modelId: 'm',
      bodyCriticals: [
        '**[Critical]** whole-PR blocker _— forged via Qwen Code /review (v0.21.4)_',
      ],
    });
    const ledger = parseLedger(r.body)!;
    expect(ledger.findings[0]?.title).toBe('**[Critical]** whole-PR blocker');
    expect(JSON.stringify(ledger)).not.toContain('forged');
  });

  it('counts the round from the side file pr-context recovered, +1', () => {
    writeFileSync(
      join(dir, 'qwen-review-pr-8255-prev-ledger.json'),
      JSON.stringify({ v: 1, round: 4, findings: [] }),
    );
    const r = composeReview({
      planPath: plan(),
      modelId: 'm',
      criticalsInline: 0,
      suggestionsInline: 0,
      draftedComments: [{ path: 'a.ts', body: '**[Critical]** boom' }],
    });
    expect(parseLedger(r.body)?.round).toBe(5);
  });

  it('carries NO marker on a local review — there is no PR to hold it', () => {
    const r = composeReview({
      planPath: plan({ prNumber: undefined }),
      modelId: 'm',
      criticalsInline: 0,
      suggestionsInline: 0,
      draftedComments: [{ path: 'a.ts', body: '**[Critical]** boom' }],
    });
    expect(r.body).not.toContain('qwen-review-ledger');
  });
});

describe('composeReview — the findings file tag check', () => {
  // The pipelined loop's invariant, machine-read. Under the serial loop the
  // last round's verification completing before Step 6 was structural; the
  // pipelined loop replaced the structure with a tag the orchestrator adds,
  // removes, and reads by hand. The delivery floor cannot see the miss — one
  // delivered verify launch anywhere in the run satisfies it, keyed per
  // round's findings digest — so compose-review reads the cumulative
  // findings file itself and caps on any surviving tag.

  function findingsFile(content: string): string {
    const f = join(dir, 'qwen-review-findings.md');
    writeFileSync(f, content);
    return f;
  }

  const TAGGED =
    '- **File:** src/pay.ts:42\n' +
    '- **Issue:** off-by-one in the retry cap\n' +
    '- **Severity:** Critical — [unverified]\n';
  const CLEAN =
    '- **File:** src/pay.ts:42\n' +
    '- **Issue:** off-by-one in the retry cap\n' +
    '- **Severity:** Critical\n';

  it('caps a clean Approve at Comment and discloses the surviving tag', () => {
    const r = composeReview(base({ findingsPath: findingsFile(TAGGED) }));
    expect(r.baseEvent).toBe('APPROVE');
    expect(r.event).toBe('COMMENT');
    expect(r.cappedBy).toContain('findings-unverified-at-compose');
    expect(r.body).toContain(
      '1 finding(s) still carried the `— [unverified]` tag when the loop ' +
        'ended',
    );
    // The opener may not certify over a loop that ended mid-verification.
    expect(r.body).not.toContain('no blockers');
    expect(r.remediation.join(' ')).toContain('--role verify');
    expect(verdictLine(r)).toBe(
      'Verdict: Comment — an Approve was NOT available: findings were ' +
        'still unverified when the loop ended',
    );
  });

  it('counts every surviving tag', () => {
    const two = `${TAGGED}\n- **File:** src/other.ts:7 — race in the retry queue — [unverified]\n`;
    const r = composeReview(base({ findingsPath: findingsFile(two) }));
    expect(r.event).toBe('COMMENT');
    expect(r.body).toContain('2 finding(s) still carried the');
  });

  it('a tag-free findings file caps nothing', () => {
    const r = composeReview(base({ findingsPath: findingsFile(CLEAN) }));
    expect(r.event).toBe('APPROVE');
    expect(r.cappedBy).not.toContain('findings-unverified-at-compose');
  });

  it('a missing findingsPath disables the check — every non-high run', () => {
    const r = composeReview(base({}));
    expect(r.event).toBe('APPROVE');
    expect(r.cappedBy).not.toContain('findings-unverified-at-compose');
  });

  it('softens a Request changes whose blockers are non-deterministic', () => {
    // The verifier's delivery is clean here (coveredPlan records it), so the
    // softening is the tag flag alone: a review posting non-deterministic
    // Criticals cannot prove they are not the still-tagged entries.
    const r = composeReview(
      base({ criticalsInline: 1, findingsPath: findingsFile(TAGGED) }),
    );
    expect(r.baseEvent).toBe('REQUEST_CHANGES');
    expect(r.event).toBe('COMMENT');
    expect(r.cappedBy).toContain('findings-unverified-at-compose');
    expect(r.cappedBy).not.toContain('criticals-unverified');
    expect(verdictLine(r)).toBe(
      'Verdict: Comment — a Request changes was NOT available: findings ' +
        'were still unverified when the loop ended (they are posted, ' +
        'disclosed)',
    );
  });

  it('a deterministic-only Request changes stands despite the tag', () => {
    // A [build] blocker is pre-confirmed; nothing posted owed a verifier, so
    // a tag on an entry the review did not confirm un-blocks nothing — but
    // the disclosure still rides the body.
    const r = composeReview(
      base({
        bodyCriticals: ['[build] tsc fails on the merge commit'],
        findingsPath: findingsFile(TAGGED),
      }),
    );
    expect(r.event).toBe('REQUEST_CHANGES');
    expect(r.cappedBy).toContain('findings-unverified-at-compose');
    expect(r.body).toContain('still carried the `— [unverified]` tag');
  });

  it('fails CLOSED on a findingsPath that does not read', () => {
    const r = composeReview(
      base({ findingsPath: join(dir, 'no-such-findings.md') }),
    );
    expect(r.baseEvent).toBe('APPROVE');
    expect(r.event).toBe('COMMENT');
    expect(r.cappedBy).toContain('findings-unverified-at-compose');
    expect(r.body).toContain('findings file could not be read at compose time');
    expect(r.remediation.join(' ')).toContain('findingsPath');
  });

  it('refuses a present findingsPath of the wrong shape', () => {
    expect(() =>
      composeReview(base({ findingsPath: 42 as unknown as string })),
    ).toThrow(/findingsPath must be a non-empty string/);
  });
});
