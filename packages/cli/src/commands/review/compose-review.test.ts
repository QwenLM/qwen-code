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
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { promptRecordDir, briefPath } from './lib/prompt-record.js';
import { appendRunSession, recordResume } from './lib/run-ledger.js';
import {
  budgetStopEntry,
  budgetStopEntryZh,
  roundCapStopEntry,
  roundCapStopEntryZh,
  writeBudgetStop,
  writeRoundCapStop,
} from './lib/deadline.js';
import { getGhHost, setGhHost } from './lib/gh.js';
import { LEDGER_MAX_ROUND, parseLedger } from './lib/ledger.js';
import { countInlineFindings } from './lib/inline-counts.js';
import {
  composeReview,
  isNonDiffDimensionGap,
  buildLedger,
  repositoryContextGate,
  scriptLintGate,
  testPlanGate,
  composeReviewCommand,
  describeChunkGap,
  verdictLine,
  type ComposeReviewInput,
  type ComposeReviewResult,
  type DeferredEntry,
  type PrBodyFetcher,
} from './compose-review.js';

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn(),
}));
vi.mock('../../utils/version.js', () => ({
  getCliVersion: vi.fn().mockResolvedValue('0.21.2'),
}));
// The handler reads `review.attribution` from the operator's real
// settings.json — pin it, or a developer running with the switch off
// reddens every handler-level footer assertion below.
const reviewSettingsMock = vi.hoisted(() =>
  vi.fn((): Record<string, unknown> => ({})),
);
vi.mock('../../config/settings.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../config/settings.js')>();
  return {
    ...actual,
    // The production call carries `{ skipWorkspaceSettings: true }` — the
    // attribution switch resolves from operator scopes only. A caller that
    // forgets the flag reads the workspace-polluted view below instead, and
    // the handler assertions redden: a repository's `.qwen/settings.json`
    // must not control it.
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
  reviewSettingsMock.mockReturnValue({});
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
    /** The PR identity fetch-pr records — anchors and bilingual recovery. */
    ownerRepo?: string;
    prNumber?: string | number;
    host?: string;
    /** The head fetch-pr resolved — the ledger marker's incremental anchor. */
    fetchedSha?: string;
    reviewModelId?: string;
  } = {},
): string {
  const p = join(dir, 'plan.json');
  writeFileSync(
    p,
    JSON.stringify({
      diffPathAbsolute: DIFF,
      ...(opts.fetchedSha === undefined ? {} : { fetchedSha: opts.fetchedSha }),
      ...(opts.reviewModelId === undefined
        ? {}
        : { reviewModelId: opts.reviewModelId }),
      // What fetch-pr records when the PR description contains Han
      // characters — the deterministic bilingual-body switch.
      ...(opts.han ? { prDescriptionHasHan: true } : {}),
      // The effort the capturing command recorded — the roster and the
      // reverse-audit floor both read it from here.
      ...(opts.effort ? { effort: opts.effort } : {}),
      ...(opts.repositoryContext === undefined
        ? {}
        : { repositoryContext: opts.repositoryContext }),
      ...(opts.ownerRepo === undefined ? {} : { ownerRepo: opts.ownerRepo }),
      ...(opts.prNumber === undefined ? {} : { prNumber: opts.prNumber }),
      ...(opts.host === undefined ? {} : { host: opts.host }),
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
 * what `verificationGaps` asks. Pass a subset of `keys` to model a skipped step;
 * `['0']` lays down the issue-fidelity agent the same way.
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
    toolPath?: string;
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
                  : { file_path: opts.toolPath ?? DIFF },
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
 * Move one agent's transcript into a ledgered PRIOR session — the shape a
 * resumed run reads.
 *
 * The records are re-stamped with the owning session (a transcript copied
 * into another session's directory is not that session's evidence, and
 * production refuses the misplaced shape), and the ledger is written by the
 * real writer so the entries carry the plan mtime they are keyed on. The
 * current attempt is stamped last and its resume recorded: reading prior
 * evidence at all requires that authorization.
 */
function rehomeToPriorSession(planPath: string, file: string): void {
  mkdirSync(join(dir, 'subagents', 'S0'), { recursive: true });
  const from = join(dir, 'subagents', 'S1', file);
  writeFileSync(
    join(dir, 'subagents', 'S0', file),
    readFileSync(from, 'utf8').replaceAll(
      '"sessionId":"S1"',
      '"sessionId":"S0"',
    ),
  );
  rmSync(from, { force: true });
  const now = Date.now();
  appendRunSession(planPath, { QWEN_CODE_SESSION_ID: 'S0' }, now);
  appendRunSession(planPath, { QWEN_CODE_SESSION_ID: 'S1' }, now + 1500);
  recordResume(planPath, ENV, now + 1500);
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
 * default pair so this controls them exactly. When the plan names the PR it also
 * carries the issue-fidelity agent that plan's roster then requires.
 */
function coveredPlan(
  step45Keys: string[] = ['verify', 'reverse-audit'],
  planOpts: {
    han?: boolean;
    effort?: 'low' | 'medium' | 'high';
    srcDiffLines?: number;
    repositoryContext?: unknown;
    ownerRepo?: string;
    prNumber?: string | number;
    host?: string;
    fetchedSha?: string;
    reviewModelId?: string;
  } = {},
): string {
  transcript('a1', goodPrompt(1), { toolCalls: 3 });
  transcript('a2', goodPrompt(2), { toolCalls: 2 });
  const p = plan({ step45: false, ...planOpts });
  recordBuilt(p, 1);
  recordBuilt(p, 2);
  recordMatrix(p);
  recordStep45(p, step45Keys);
  // A plan naming the PR owes the roster's issue-fidelity agent (Agent 0)
  // too; without its records the plan caps with `unreviewed-dimension`, and
  // a verdict assertion over it is decided by the cap, not by the counts.
  if (planOpts.ownerRepo !== undefined && planOpts.prNumber !== undefined) {
    recordStep45(p, ['0']);
  }
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

  it('omits the footer entirely when attribution is off', () => {
    const r = composeReview(base({}), '0.21.2', false);
    expect(r.body).toBe('No issues found. LGTM! ✅');
    expect(r.body).not.toContain(MODEL);
  });

  it('attribution off: a missing modelId is no error — its only consumer is gated off', () => {
    // Before the gate, an attribution-off run still died over the field the
    // footer — provably never rendered — names.
    const r = composeReview(base({ modelId: '' }), '0.21.2', false);
    expect(r.body).toBe('No issues found. LGTM! ✅');
  });

  it('attribution off: a footer-unsafe modelId composes — nothing renders it', () => {
    const r = composeReview(
      base({ modelId: 'evil\nvia Qwen Code /review' }),
      '0.21.2',
      false,
    );
    expect(r.body).toBe('No issues found. LGTM! ✅');
  });

  it('attribution on: a missing modelId is still refused', () => {
    expect(() => composeReview(base({ modelId: '' }), '0.21.2')).toThrow(
      /modelId is required/,
    );
  });

  it('attribution on: a footer-unsafe modelId is still refused', () => {
    expect(() =>
      composeReview(base({ modelId: 'evil\nmodel' }), '0.21.2'),
    ).toThrow(/single line/);
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

describe('composeReview — modeled-system defect-layer cap', () => {
  const sentinel = (domains: string[]) => ({
    version: 1,
    provider: 'test',
    label: 'guard',
    domains,
    relatedPaths: [],
    recommendedTests: [],
    requiredConfigurations: [],
    requiredAgents: [],
    unverifiedDimensions: [],
    verificationNotes: [],
  });
  const IDENTITY =
    'You are review agent `reverse-audit` — Reverse audit agent.';
  const ALL = [
    'lexing',
    'expansion',
    'scope-propagation',
    'resolution-order',
    'inheritance',
    'toctou',
  ];
  const walked = (...ids: string[]) =>
    ids.map((id) => `Layer walked: ${id} — clear.`).join('\n');
  // A GENUINE auditor: launched with the prompt the CLI recorded for the
  // role, and it opened the brief that prompt points at (plus a real diff
  // read, receipts as final text). A receipt only counts from one of these —
  // otherwise a compliant sibling's floor could carry a hand-written
  // auditor's claims. (The earlier fixture matched on a bare IDENTITY
  // constant; the gate no longer accepts that shape.)
  const auditor = (id: string, receipts: string) => {
    const planPath = join(dir, 'plan.json');
    const brief = briefPath(planPath, 'reverse-audit');
    const launch =
      'You are review agent `reverse-audit`.\n' +
      `read_file(file_path="${brief}")\n` +
      `read_file(file_path="${DIFF}")`;
    transcript(id, launch, {
      toolCalls: 1,
      range: [0, 100],
      opens: [brief],
      text: receipts,
    });
  };
  const markedPlan = (domains: string[]) =>
    coveredPlan(['verify', 'reverse-audit'], {
      repositoryContext: sentinel(domains),
    });
  const compose = (p: string) =>
    composeReview({
      criticalsInline: 0,
      suggestionsInline: 0,
      planPath: p,
      env: ENV,
      modelId: MODEL,
    });

  it('caps Approve to Comment when a marked diff leaves layers unwalked', () => {
    const p = markedPlan(['modeled-executable-system']);
    auditor('ra-1', walked('lexing', 'expansion')); // 2 of 6
    const r = compose(p);
    // Reverting the compose-review wiring line leaves this green as APPROVE.
    expect(r.event).toBe('COMMENT');
    expect(r.body).toContain('scope-propagation');
  });

  it('leaves Approve intact when every layer is walked', () => {
    const p = markedPlan(['modeled-executable-system']);
    auditor('ra-1', walked(...ALL));
    expect(compose(p).event).toBe('APPROVE');
  });

  it('does not count a parrot that never read the diff (diffToolCalls === 0)', () => {
    const p = markedPlan(['modeled-executable-system']);
    auditor('ra-1', walked('lexing', 'expansion')); // genuine: 4 owed
    // Identity line and ALL six receipts, but a brief read, not a diff read:
    // successfulToolCalls > 0, diffToolCalls === 0 — corroboration must drop it,
    // or its six receipts would cover the four the genuine auditor left owed.
    transcript('ra-parrot', `${IDENTITY}\nread_file(file_path="/x/brief.md")`, {
      opens: ['/x/brief.md'],
      text: walked(...ALL),
    });
    const r = compose(p);
    expect(r.event).toBe('COMMENT');
    expect(r.body).toContain('scope-propagation');
  });

  it('does not count a verifier whose prompt merely mentions reverse-audit', () => {
    const p = markedPlan(['modeled-executable-system']);
    auditor('ra-1', walked('lexing', 'expansion')); // genuine: 4 owed
    // A verifier identity, a real diff read, and all six receipts quoted in its
    // verdict: the substring `reverse-audit` appears, the identity line does not.
    transcript(
      'vr',
      `You are review agent \`verify\` — Verification agent, ruling on reverse-audit findings.\nread_file(file_path="${DIFF}")`,
      { toolCalls: 1, range: [0, 100], text: walked(...ALL) },
    );
    expect(compose(p).event).toBe('COMMENT');
  });

  it('does not count an auditor whose diff read misses its baked territory', () => {
    const p = markedPlan(['modeled-executable-system']);
    // A reverse auditor whose launch baked territory 3301-4000 but whose only diff
    // read was lines 1-50: retirement's territory bar drops it, so its six parroted
    // receipts do not count and the layers stay owed. `diffToolCalls > 0` alone
    // would (wrongly) credit them and release Approve.
    transcript(
      'ra-off',
      `${IDENTITY}\nread_file(file_path="${DIFF}", offset=3300, limit=700)`,
      { toolCalls: 1, range: [0, 50], text: walked(...ALL) },
    );
    expect(compose(p).event).toBe('COMMENT');
  });

  it('is inert without the sentinel domain — an ordinary review is unaffected', () => {
    const p = markedPlan(['some-other-domain']);
    auditor('ra-1', ''); // zero receipts, but the domain is not armed
    expect(compose(p).event).toBe('APPROVE');
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

  it('a round-cap marker caps the verdict and dedups against the relayed entry', () => {
    // A huge diff's reverse audit ran its full 3 rounds without converging;
    // the builder refused round 4 and wrote a round-cap marker. compose-review
    // caps on it whether or not the orchestrator relays — and says it once
    // when the orchestrator does relay.
    const plan = coveredPlan();
    writeRoundCapStop(plan, 3, 4);
    const r = composeReview(base({ planPath: plan }));
    expect(r.event).toBe('COMMENT');
    expect(r.body).toContain('reverse-audit round cap of 3');
    expect(r.body).not.toContain('LGTM');

    const r2 = composeReview(
      base({
        planPath: plan,
        unreviewedDimensions: [
          'reverse audit — did not converge within the reverse-audit round cap of 3',
        ],
      }),
    );
    expect(r2.body.split('reverse-audit round cap').length - 1).toBe(1);
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

  it('a round-cap stop does NOT suppress the not-built gap — its rebuild is admitted', () => {
    // R4-9: the reverseByDesign exemption is time-budget-ONLY. A round-cap
    // marker with zero reverse-audit records must not suppress the not-built
    // gap the way a time-budget stop does: the cap gate refuses only
    // `round > cap`, so the gap's FIX (rebuild `--round 1`) is admitted, and
    // a local run has no deadline to refuse it at all. Reading the marker
    // cause-blind would silently drop both the gap and its rebuild
    // remediation for a run that audited nothing.
    const plan = coveredPlan([]); // no reverse-audit ran — the not-built shape
    writeRoundCapStop(plan, 3, 4);
    const r = composeReview({ planPath: plan, env: ENV, modelId: MODEL });
    // The round-cap marker still discloses and caps the verdict…
    expect(r.event).toBe('COMMENT');
    expect(r.body).toContain('reverse-audit round cap of 3');
    // …but the not-built gap and its rebuild remediation are still owed.
    expect(r.remediation.join(' ')).toContain('reverse audit:');
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
    // The gap disclosure follows, so the opener says the review is partial —
    // any "Reviewed…" opener above "Not reviewed:" read as the body
    // contradicting itself (#8811).
    expect(r.body).toContain(
      'Partially reviewed — gaps disclosed. Suggestions are inline.',
    );
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

  it('discloses coverage gaps before the diff-only warning', () => {
    const r = composeReview(
      base({ contextUnavailable: true, unreviewedDimensions: ['security'] }),
    );
    expect(r.body.indexOf('Partially reviewed')).toBeLessThan(
      r.body.indexOf('Reviewed diff-only'),
    );
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

describe('composeReview — duplicate-dropped Suggestions (#9204: the body claimed an anchor failure that never happened)', () => {
  it('an all-duplicates run stays COMMENT with the duplicate sentence, never the anchor-failure one', () => {
    // The dogfooded failure: three Suggestions resolved to exact-added
    // anchors, were dropped because a concurrent reviewer had already
    // posted them, and the only state field that kept them counting toward
    // S rendered "could not be anchored to a changed line" — a public
    // claim the resolver's output contradicts.
    const r = composeReview(
      base({
        suggestionsDroppedAsDuplicates: [
          'R1-1 precheck-pr pin — already reported (comment 3788857375)',
          'R1-2 loose review-config pins — already reported (comment 3788857379)',
          'R1-3 unpinned authorize join — already reported (comment 3788857379)',
        ],
      }),
    );
    expect(r.event).toBe('COMMENT');
    expect(r.event).not.toBe('APPROVE');
    expect(r.body).toContain(
      '3 Suggestion-level finding(s) this review confirmed are already reported on this PR and are not repeated:',
    );
    // Every entry must render, not just the first: the count sentence reads
    // the array's length independently of the rendered entries, so a list
    // truncation would overclaim it while a first-item assertion stayed green.
    expect(r.body).toContain(
      [
        '- R1-1 precheck-pr pin — already reported (comment 3788857375)',
        '- R1-2 loose review-config pins — already reported (comment 3788857379)',
        '- R1-3 unpinned authorize join — already reported (comment 3788857379)',
      ].join('\n'),
    );
    expect(r.body).not.toContain('could not be anchored');
    expect(r.body).not.toContain('Suggestions are inline.');
  });

  it('mixed inline/duplicate Suggestions carries the inline sentence and the duplicate paragraph', () => {
    const r = composeReview(
      base({
        suggestionsInline: 1,
        suggestionsDroppedAsDuplicates: [
          'R1-2 loose pins — already reported (comment 3788857379)',
        ],
      }),
    );
    expect(r.event).toBe('COMMENT');
    expect(r.body).toContain('Suggestions are inline.');
    expect(r.body).toContain(
      '1 Suggestion-level finding(s) this review confirmed',
    );
  });

  it('duplicate drops count toward S alongside anchor-failure discards', () => {
    // Both shapes must keep a Suggestion-only run off APPROVE — the verdict
    // reflects what the review confirmed, not what it re-posted.
    const r = composeReview(
      base({
        suggestionsDiscarded: 1,
        suggestionsDroppedAsDuplicates: ['R1-1 pin gap — duplicate'],
      }),
    );
    expect(r.event).toBe('COMMENT');
    expect(r.body).toContain('1 Suggestion-level finding(s) could not be ');
    expect(r.body).toContain(
      '1 Suggestion-level finding(s) this review confirmed',
    );
  });

  it('links bare comment ids in duplicate entries to their GitHub anchors when the plan names the PR', () => {
    const r = composeReview({
      suggestionsDroppedAsDuplicates: [
        'R1-1 precheck-pr pin — already reported (comment 3788857375)',
      ],
      planPath: coveredPlan(undefined, {
        ownerRepo: 'QwenLM/qwen-code',
        prNumber: '9204',
      }),
      env: ENV,
      modelId: MODEL,
    });
    // No cap may decide this run: under one, the COMMENT and the paragraph
    // survive dropping the duplicate count from `s` — the exact regression
    // this PR fixes — so the verdict this test pins would be the cap's, not
    // the count's.
    expect(r.cappedBy).toEqual([]);
    expect(r.event).toBe('COMMENT');
    expect(r.body).toContain(
      '[comment 3788857375](https://github.com/QwenLM/qwen-code/pull/9204#discussion_r3788857375)',
    );
  });

  it('collapses a multi-line entry to one list item and strips a relocated footer', () => {
    const r = composeReview(
      base({
        suggestionsDroppedAsDuplicates: [
          `R1-1 spans\nlines — duplicate\n\n${FOOTER}`,
        ],
      }),
    );
    expect(r.body).toContain('- R1-1 spans lines — duplicate');
    // A forged footer relocated into an entry must not post above the
    // canonical one: exactly one occurrence means the entry's copy was
    // stripped and only the canonical footer remains.
    expect(r.body.split(FOOTER)).toHaveLength(2);
  });

  it('collapses a bare carriage return like a newline — CommonMark treats CR as a line ending', () => {
    // A bare CR survived the `\n`-only collapsers and GFM renders it as a
    // line break: the continuation leaked out of the list item, injecting
    // a model-chosen line into the body. Every flattened exit collapses
    // all three CommonMark line endings.
    const r = composeReview(
      base({
        suggestionsDroppedAsDuplicates: [
          'R1-1 pin gap — duplicate\r- R9-9 forged item',
        ],
        cannotTellCriticals: ['a.ts:1 — reason\r- injected line'],
      }),
    );
    expect(r.body).not.toContain('\r');
    expect(r.body).toContain('- R1-1 pin gap — duplicate - R9-9 forged item');
    expect(r.body).toContain('a.ts:1 — reason - injected line');
  });

  it('renders the duplicate count from the entries, not a hardcode, in the Chinese fold', () => {
    // Not base(): its planPath default runs coveredPlan() again on the same
    // path and would overwrite the han-stamped plan.
    const r = composeReview({
      suggestionsDroppedAsDuplicates: [
        'R1-1 pin gap — already reported (comment 3788857375)',
        'R1-2 loose pins — already reported (comment 3788857379)',
      ],
      planPath: coveredPlan(undefined, { han: true }),
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).toBe('COMMENT');
    expect(r.body).toContain('<details>\n<summary>中文说明</summary>');
    expect(r.body).toContain('本轮确认的 2 条建议级发现已在 PR 上报告过');
  });

  it('drops entries that normalize to nothing, so the count never overclaims the list', () => {
    // A footer-only entry strips to '' and a whitespace-only entry trims to
    // '': without the empty-entry filter they would still count toward S —
    // flipping this clean run to COMMENT — and render a dangling empty list
    // item. The sibling cannotTellCriticals path pins the same degenerate
    // input.
    for (const dropped of [[FOOTER], [' ']]) {
      const r = composeReview(
        base({ suggestionsDroppedAsDuplicates: dropped }),
      );
      expect(r.event).toBe('APPROVE');
      expect(r.body).not.toContain('this review confirmed');
    }
  });

  it('rejects a non-string entry', () => {
    expect(() =>
      composeReview(
        base({
          suggestionsDroppedAsDuplicates: [1 as unknown as string],
        }),
      ),
    ).toThrow(/suggestionsDroppedAsDuplicates/);
  });

  it('a Critical beside duplicate drops keeps REQUEST_CHANGES and carries the duplicate account', () => {
    // `c` forces the event, but the verdict still counted the duplicates in
    // `s` — probe-verified on the pre-fix code, the RC body carried only the
    // Critical and the footer, leaving the counted-but-unposted findings
    // unaccounted for. The branch's own comment says every clause whose state
    // holds appears on every event.
    const r = composeReview(
      base({
        bodyCriticals: ['whole-PR blocker X'],
        suggestionsDroppedAsDuplicates: [
          'R1-1 pin gap — already reported (comment 3788857375)',
          'R1-2 loose pins — already reported (comment 3788857379)',
        ],
      }),
    );
    expect(r.event).toBe('REQUEST_CHANGES');
    expect(r.body).toContain('**[Critical]** whole-PR blocker X');
    expect(r.body).toContain(
      '2 Suggestion-level finding(s) this review confirmed are already reported on this PR and are not repeated:',
    );
    expect(r.body).toContain(
      '- R1-1 pin gap — already reported (comment 3788857375)',
    );
  });

  it('bounds one oversized entry the way the deferred channel does — the body must not die at the 65,536 limit', () => {
    // Witness shape from the deferral channel's own incident record: one
    // ~70,000-char entry composes a body past GitHub's 65,536-char limit,
    // and `submit` posts all-or-nothing — the round's Criticals die with
    // this disclosure paragraph. Entries are model-written with no upstream
    // cap, so the bound lives where the deferred channel's already does.
    const r = composeReview(
      base({
        suggestionsDroppedAsDuplicates: [
          `R1-1 ${'x'.repeat(70_000)} — already reported (comment 3788857375)`,
        ],
      }),
    );
    expect(r.event).toBe('COMMENT');
    expect(r.body.length).toBeLessThan(65_536);
    expect(r.body).toContain(
      '1 Suggestion-level finding(s) this review confirmed',
    );
    expect(r.body).toContain('- R1-1 ');
    expect(r.body).toContain('…');
  });

  it('a cut landing inside a trailing comment ref drops the fragment — a truncated id never linkifies', () => {
    // A 245-char entry puts the 240-char cut inside the 10-digit id,
    // keeping a 6-digit prefix that satisfies the linkifier's `\d{6,}`
    // floor. Before the strip the posted body anchored `[comment 378885]`
    // — a comment that does not exist — in the paragraph whose stated
    // purpose is a truthful account of where findings already live.
    const r = composeReview({
      suggestionsDroppedAsDuplicates: [
        `R1-1 ${'x'.repeat(200)} — already reported (comment 3788857375)`,
      ],
      planPath: coveredPlan(undefined, {
        ownerRepo: 'QwenLM/qwen-code',
        prNumber: '9204',
      }),
      env: ENV,
      modelId: MODEL,
    });
    expect(r.body).toContain('- R1-1 ');
    expect(r.body).toContain('…');
    // The fragment drops whole: neither the kept prefix nor the full id
    // may ride an anchor.
    expect(r.body).not.toContain('378885');
    expect(r.body).not.toContain('discussion_r');
  });

  it('caps the rendered list at the deferred line cap and keeps the count truthful with an overflow item', () => {
    const entry = (i: number) =>
      `R1-${i} finding — already reported (comment 378885${String(i).padStart(5, '0')})`;
    const dropped = Array.from({ length: 25 }, (_, i) => entry(i + 1));
    const r = composeReview(base({ suggestionsDroppedAsDuplicates: dropped }));
    expect(r.event).toBe('COMMENT');
    // The count sentence names ALL 25; the rendered list is the cap, and the
    // overflow item keeps the two from disagreeing — a verdict counting 25
    // over a silent list of 20 is the false record the cap exists to avoid.
    expect(r.body).toContain(
      '25 Suggestion-level finding(s) this review confirmed are already reported on this PR and are not repeated:',
    );
    expect(r.body).toContain(`- ${entry(1)}`);
    expect(r.body).toContain(`- ${entry(20)}`);
    expect(r.body).not.toContain(`- ${entry(21)}`);
    expect(r.body).toContain('- …and 5 more (see the run report)');

    // Exactly at the cap there is no overflow item — no "…and 0 more".
    const atCap = composeReview(
      base({ suggestionsDroppedAsDuplicates: dropped.slice(0, 20) }),
    );
    expect(atCap.body).toContain(
      '20 Suggestion-level finding(s) this review confirmed',
    );
    expect(atCap.body).not.toContain('…and');
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
    expect(r.body).toContain('Partially reviewed — gaps disclosed.');
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
      base({
        criticalsInline: 1,
        contextUnavailable: true,
        unreviewedDimensions: ['security'],
      }),
    );
    expect(r.event).toBe('REQUEST_CHANGES');
    expect(r.body.indexOf('Partially reviewed')).toBeLessThan(
      r.body.indexOf('Reviewed diff-only'),
    );
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
    expect(r.body).toContain('Reviewed.');
    expect(r.body).not.toContain('Partially reviewed');
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

  it('accepts the array form of suggestionsDiscarded, counting it by length', () => {
    // The Step 7 prose prescribes a count, but runs following older skill
    // revisions wrote the LIST of discarded items and used to die at this gate
    // late, after hours of analysis. `[]` is zero; a populated list is its
    // length — the same claim as the number, spelled the older way.
    expect(composeReview(base({ suggestionsDiscarded: [] })).event).toBe(
      'APPROVE',
    );
    const r = composeReview(
      base({
        suggestionsDiscarded: ['src/a.ts:12 — could not anchor', 'src/b.ts:7'],
      }),
    );
    expect(r.event).toBe('COMMENT');
    expect(r.body).toContain('2 Suggestion-level finding(s)');
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

  /**
   * Drive the handler with a state floor, a recorded floor, and a plan
   * naming PR 8255 (the recovery is PR-bound), then return the ARCHIVED
   * composed JSON — read from --out before cleanup, because the archive is
   * what Step 8 registers and later rounds consume; asserting stdout alone
   * let a hoisted pre-override archive write ship unnoticed.
   */
  async function composeWithRecordedFloor(opts: {
    stateFloor?: string;
    argsLine: string;
    settings?: Record<string, unknown>;
    /** Omit the plan from the state — the R4-1 shape: the recovery must
     * fall back to the handler's own --pr, exactly as submit does. */
    noPlan?: boolean;
    /** The handler's caller identity — --pr / --repo / --host. */
    pr?: number;
    repo?: string;
    host?: string;
  }): Promise<{
    written: ComposeReviewResult;
    stderrHasOverride: boolean;
    stderr: string[];
  }> {
    if (opts.settings) reviewSettingsMock.mockReturnValue(opts.settings);
    // The stderr spy accumulates across tests; the no-override assertion
    // below must not read an earlier test's note.
    (writeStderrLine as ReturnType<typeof vi.fn>).mockClear();
    const dir = mkdtempSync(join(tmpdir(), 'compose-recorded-floor-'));
    const inputPath = join(dir, 'compose.json');
    const commentsPath = join(dir, 'comments.json');
    const outPath = join(dir, 'composed.json');
    const argsPath = join(dir, 'skill-args.txt');
    const planPath = join(dir, 'plan.json');
    writeFileSync(planPath, JSON.stringify({ prNumber: 8255 }), 'utf8');
    writeFileSync(
      inputPath,
      JSON.stringify({
        modelId: MODEL,
        ...(opts.noPlan ? {} : { planPath }),
        ...(opts.stateFloor === undefined
          ? {}
          : { severityFloor: opts.stateFloor }),
      }),
      'utf8',
    );
    writeFileSync(
      commentsPath,
      JSON.stringify([
        { path: 'a.ts', line: 3, body: '**[Suggestion]** tidy this' },
      ]),
      'utf8',
    );
    writeFileSync(argsPath, `${opts.argsLine}\n`, 'utf8');
    const savedSession = process.env['QWEN_CODE_SESSION_ID'];
    delete process.env['QWEN_CODE_SESSION_ID'];
    let written: ComposeReviewResult;
    try {
      await runComposeReviewCommand({
        input: inputPath,
        comments: commentsPath,
        out: outPath,
        skillArgs: argsPath,
        ...(opts.pr === undefined ? {} : { pr: opts.pr }),
        ...(opts.repo === undefined ? {} : { repo: opts.repo }),
        ...(opts.host === undefined ? {} : { host: opts.host }),
      });
      written = JSON.parse(readFileSync(outPath, 'utf8'));
    } finally {
      if (savedSession === undefined)
        delete process.env['QWEN_CODE_SESSION_ID'];
      else process.env['QWEN_CODE_SESSION_ID'] = savedSession;
      rmSync(dir, { recursive: true, force: true });
    }
    const stderr = (writeStderrLine as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => String(c[0]),
    );
    return {
      written,
      stderrHasOverride: stderr.some((l) =>
        l.includes('verbatim record outranks'),
      ),
      stderr,
    };
  }

  it('resolves the recorded floor at THIS boundary too — the archive must match the post', async () => {
    // The recorded-floor recovery lives in the shared lib helper; if only
    // submit resolved it, the archived composed JSON and terminal verdict
    // (this boundary's outputs) would describe a different review than the
    // posted body whenever the override fired.
    const { written, stderrHasOverride } = await composeWithRecordedFloor({
      stateFloor: 'suggestion',
      argsLine: '8255 --severity-floor critical',
    });
    expect(written.floorEnforced).toEqual([0]);
    expect(stderrHasOverride).toBe(true);
  });

  it('overrides in BOTH directions — a recorded posture-off outranks a drifted critical', async () => {
    // Direction-independence: an enforcement-direction-only condition would
    // let a drifted state 'critical' stand over the operator's recorded
    // `--severity-floor suggestion` and silently invert a posture-off
    // decision.
    const { written, stderrHasOverride } = await composeWithRecordedFloor({
      stateFloor: 'critical',
      argsLine: '8255 --severity-floor suggestion',
    });
    expect(written.floorEnforced).toEqual([]);
    expect(stderrHasOverride).toBe(true);
  });

  it('the configured setting reaches this boundary without a flag', async () => {
    // The flag-less leg: the record names only the PR; the floor comes from
    // `review.severityFloor` through `operatorReviewSettings()` — deleting
    // that argument from the handler must fail here.
    const { written } = await composeWithRecordedFloor({
      argsLine: '8255',
      settings: { attribution: true, severityFloor: 'critical' },
    });
    expect(written.floorEnforced).toEqual([0]);
  });

  it('falls back to --pr when the state carries no usable plan — the R4-1 symmetry', async () => {
    // With the plan absent (or unusable) the recovery must resolve exactly
    // as submit's does through its own --pr, or the archived compose and
    // the post describe different reviews on precisely the drifted-state
    // shape enforcement exists for.
    const { written, stderr } = await composeWithRecordedFloor({
      stateFloor: 'suggestion',
      argsLine: '8255 --severity-floor critical',
      noPlan: true,
      pr: 8255,
    });
    expect(written.floorEnforced).toEqual([0]);
    // And the flag-sourced note names the flag, not the setting.
    expect(
      stderr.some((l) => l.includes('the recorded `--severity-floor` flag')),
    ).toBe(true);
  });

  it('binds a URL-shaped GHE record with the caller identity — full submit symmetry', async () => {
    // R5-1's split: submit passed repo/host while compose did not, so on
    // the plan-less shape a GHE URL record recovered at one boundary and
    // not the other. The compose handler now feeds --repo and the
    // effective --host into the same bar.
    const prevHost = getGhHost();
    try {
      const { written } = await composeWithRecordedFloor({
        stateFloor: 'suggestion',
        argsLine:
          'https://ghe.corp.example/QwenLM/qwen-code/pull/8255 --severity-floor critical',
        noPlan: true,
        pr: 8255,
        repo: 'QwenLM/qwen-code',
        host: 'ghe.corp.example',
      });
      expect(written.floorEnforced).toEqual([0]);
    } finally {
      // The handler routes gh via setGhHost; undo it so later tests do not
      // inherit the Enterprise host.
      setGhHost(prevHost);
    }
  });

  it("refuses a foreign repo's URL record — the handler's --repo is the bar", async () => {
    // The compose boundary is the one call shape where the identity repo
    // can be unknown (--repo is optional, the plan may carry no
    // ownerRepo), so it is where a last-writer-wins record of ANOTHER
    // repo's PR 8255 could bind on number and host alone. Two arms: with
    // --repo the bar refuses the foreign record; without it the unknown
    // repo refuses it too (fail-closed), so dropping the handler's
    // callerRepo leg cannot pass both.
    for (const repo of ['QwenLM/qwen-code', undefined]) {
      const { written, stderrHasOverride } = await composeWithRecordedFloor({
        stateFloor: 'suggestion',
        argsLine:
          'https://github.com/other/repo/pull/8255 --severity-floor critical',
        noPlan: true,
        pr: 8255,
        repo,
      });
      expect(written.floorEnforced).toEqual([]);
      expect(stderrHasOverride).toBe(false);
    }
  });

  it('stays silent when the recovered floor equals the state — normalised', async () => {
    // The equality guard compares the normalised state floor: a
    // case-drifted transcription of the SAME floor is agreement, and an
    // override note over it is a false audit claim.
    for (const stateFloor of ['critical', 'CRITICAL']) {
      const { written, stderrHasOverride } = await composeWithRecordedFloor({
        stateFloor,
        argsLine: '8255 --severity-floor critical',
      });
      expect(written.floorEnforced).toEqual([0]);
      expect(stderrHasOverride).toBe(false);
    }
  });

  it('names the setting as the source when no flag was typed', async () => {
    const { written, stderr } = await composeWithRecordedFloor({
      stateFloor: 'suggestion',
      argsLine: '8255',
      settings: { attribution: true, severityFloor: 'critical' },
    });
    expect(written.floorEnforced).toEqual([0]);
    expect(
      stderr.some((l) =>
        l.includes('setting resolved against the recorded invocation'),
      ),
    ).toBe(true);
    expect(
      stderr.some((l) => l.includes('the recorded `--severity-floor` flag')),
    ).toBe(false);
  });

  it("does not recover another PR's recorded floor", async () => {
    // The record is last-writer-wins across /review invocations; unbound,
    // a later review of PR 999 would hand ITS floor to this PR's archive.
    const { written, stderrHasOverride } = await composeWithRecordedFloor({
      stateFloor: 'suggestion',
      argsLine: '999 --severity-floor critical',
    });
    expect(written.floorEnforced).toEqual([]);
    expect(stderrHasOverride).toBe(false);
  });

  it('honours review.attribution=false through the handler (wiring)', async () => {
    // Third wiring leg: deleting the attribution argument from the
    // composeReviewCommand call leaves the direct composeReview test and the
    // submit handler test green, while the persisted/terminal verdict still
    // carries the footer the setting exists to remove.
    const dir = mkdtempSync(join(tmpdir(), 'compose-attribution-'));
    const inputPath = join(dir, 'compose.json');
    const commentsPath = join(dir, 'comments.json');
    const outPath = join(dir, 'composed.json');
    writeFileSync(inputPath, JSON.stringify({ modelId: MODEL }), 'utf8');
    writeFileSync(commentsPath, '[]', 'utf8');
    reviewSettingsMock.mockReturnValue({ attribution: false });
    try {
      await runComposeReviewCommand({
        input: inputPath,
        comments: commentsPath,
        out: outPath,
      });
      const written = JSON.parse(
        readFileSync(outPath, 'utf8'),
      ) as ComposeReviewResult;
      // No plan in this minimal state, so the coverage gate caps the body —
      // the assertion is on what the wiring leg controls: the footer.
      expect(written.body).not.toBe('');
      expect(written.body).not.toContain('via Qwen Code /review');
      expect(written.body).not.toContain(MODEL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('injects the session model into the marker — QWEN_CODE_MODEL reaches the anchor (wiring)', async () => {
    // The certifying identity must be the model the runtime published for
    // the session — Config publishes it per session, the shell tool injects
    // it into this subprocess — superseding the id the state JSON typed.
    // Dropping the runtime argument from the handler's composeReview call
    // leaves the pure-function tests green while the posted anchor is
    // certified by the typed id again.
    const dir = mkdtempSync(join(tmpdir(), 'compose-runtime-model-'));
    const inputPath = join(dir, 'compose.json');
    const commentsPath = join(dir, 'comments.json');
    const outPath = join(dir, 'composed.json');
    writeFileSync(
      inputPath,
      JSON.stringify({
        modelId: 'typed-by-the-model',
        planPath: coveredPlan(['verify', 'reverse-audit'], {
          prNumber: 8255,
          fetchedSha: 'deadbeef00112233',
        }),
      }),
      'utf8',
    );
    writeFileSync(
      commentsPath,
      JSON.stringify([
        { path: 'a.ts', line: 3, body: '**[Suggestion]** prefer x' },
      ]),
      'utf8',
    );
    // The handler strips `env` off the state JSON, so coverage resolves the
    // fixture transcripts from the process environment.
    const prevDir = process.env['QWEN_CODE_PROJECT_DIR'];
    const prevSession = process.env['QWEN_CODE_SESSION_ID'];
    const prevModel = process.env['QWEN_CODE_MODEL'];
    // Cleared, not just saved: the boundary PREFERS the qualified identity
    // over the bare id, so an ambient one — which this PR's own Config now
    // publishes, and the shell tool injects into every subprocess — would
    // override the model this test sets. Running the suite inside a Qwen
    // Code session is the dogfooding path, so the ambient value is the
    // normal case, not the exotic one.
    const prevIdentity = process.env['QWEN_CODE_MODEL_IDENTITY'];
    delete process.env['QWEN_CODE_MODEL_IDENTITY'];
    process.env['QWEN_CODE_PROJECT_DIR'] = ENV['QWEN_CODE_PROJECT_DIR'];
    process.env['QWEN_CODE_SESSION_ID'] = ENV['QWEN_CODE_SESSION_ID'];
    process.env['QWEN_CODE_MODEL'] = 'the-session-model';
    try {
      await runComposeReviewCommand({
        input: inputPath,
        comments: commentsPath,
        out: outPath,
      });
      const written = JSON.parse(
        readFileSync(outPath, 'utf8'),
      ) as ComposeReviewResult;
      const ledger = parseLedger(written.body)!;
      expect(ledger.sha).toBe('deadbeef00112233');
      expect(ledger.model).toBe('the-session-model');
    } finally {
      for (const [key, prev] of [
        ['QWEN_CODE_PROJECT_DIR', prevDir],
        ['QWEN_CODE_SESSION_ID', prevSession],
        ['QWEN_CODE_MODEL', prevModel],
        ['QWEN_CODE_MODEL_IDENTITY', prevIdentity],
      ] as const) {
        if (prev === undefined) delete process.env[key];
        else process.env[key] = prev;
      }
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('carries duplicate-dropped Suggestions through the --input seam', async () => {
    // The seam strips caller keys with explicit `delete parsed.<key>`
    // statements, then spreads the rest into composeReview. The field rides
    // the spread today; if it ever joins them, `compose-review --input`
    // computes `s` without the duplicates — the persisted verdict reads
    // clean while `submit`, recomposing from the same state, posts COMMENT
    // with the paragraph: the terminal-vs-posted divergence this module
    // exists to kill. The body is the observable: with no plan, the
    // missing-plan cap posts COMMENT whatever the counts.
    const dir = mkdtempSync(join(tmpdir(), 'compose-dup-seam-'));
    try {
      const inputPath = join(dir, 'compose.json');
      const commentsPath = join(dir, 'comments.json');
      const outPath = join(dir, 'composed.json');
      writeFileSync(
        inputPath,
        JSON.stringify({
          modelId: MODEL,
          suggestionsDroppedAsDuplicates: [
            'R1-1 pin gap — already reported (comment 1)',
          ],
        }),
        'utf8',
      );
      writeFileSync(commentsPath, '[]', 'utf8');
      await runComposeReviewCommand({
        input: inputPath,
        comments: commentsPath,
        out: outPath,
      });
      const written = JSON.parse(
        readFileSync(outPath, 'utf8'),
      ) as ComposeReviewResult;
      expect(written.body).toContain(
        '1 Suggestion-level finding(s) this review confirmed',
      );
      expect(written.event).not.toBe('APPROVE');
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

  it('opens partial, not zero-certified, while any chunk is certified — and names the gaps it carries', () => {
    // chunk 1 built and never launched; chunk 2 reviewed properly. A partial
    // gap is a disclosure, not a zero-certification — and the opener says
    // the review is partial, so no "Reviewed…" opener ever sits beside
    // "Not reviewed:" (#8811).
    const p = plan();
    recordBuilt(p, 1);
    recordBuilt(p, 2);
    recordMatrix(p);
    transcript('a2', goodPrompt(2), { toolCalls: 2 });
    const r = composeReview({ planPath: p, env: ENV, modelId: MODEL });
    expect(r.body).toContain('Partially reviewed — gaps disclosed.');
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

  it('quotes a prose agent label — it is the agent’s name, not a claim about the PR', () => {
    // #8811: a whole-diff agent (no `chunk N of M` in its prompt) was
    // disclosed by the truncated first line of its launch prompt, rendered
    // bare — "Not reviewed: This PR narrows the daemon-marker check from a
    // truthy tes..." read as a sentence about the whole PR, not the name of
    // the one agent that failed. Quotes say which it is, and the truncation
    // stops at a word boundary instead of mid-word.
    const p = plan({ han: true });
    transcript('a2', goodPrompt(2), { toolCalls: 2 });
    recordBuilt(p, 2);
    recordMatrix(p);
    const brief = briefPath(p, 'chunk-1');
    writeFileSync(brief, 'The chunk-1 brief.');
    const launch =
      'This PR narrows the daemon-marker check from a truthy test to an exact one\n' +
      `read_file(file_path="${brief}")\n` +
      `read_file(file_path="${DIFF}", offset=0, limit=100)`;
    writeFileSync(join(promptRecordDir(p), 'chunk-1.txt'), launch);
    transcript('p1', launch, {
      toolCalls: 1,
      toolPath: join(dir, 'other.ts'),
      opens: [brief],
    });
    const r = composeReview({
      criticalsInline: 0,
      suggestionsInline: 0,
      planPath: p,
      env: ENV,
      modelId: MODEL,
    });
    expect(r.body).toContain(
      'Not reviewed: `"This PR narrows the daemon-marker check from a truthy test…"`',
    );
    expect(r.body).not.toContain('truthy tes...');
    expect(r.body).toContain(
      '启动 prompt 为它指定了 diff 中的行，但它从未打开',
    );
  });

  it('keeps long agent labels distinct when their first word matches', () => {
    transcript(
      'p1',
      `Verify the daemon marker rename does not break macos-build behavior\n${DIFF}`,
    );
    transcript(
      'p2',
      `Verify the daemon marker rename does not break linux-build behavior\n${DIFF}`,
    );
    const r = composeReview({ planPath: plan(), env: ENV, modelId: MODEL });

    expect(r.body).toContain('macos-build…');
    expect(r.body).toContain('linux-build…');
  });

  it('counts agent labels that truncate to the same public subject', () => {
    const prefix = `Verify ${'the same long scope '.repeat(5)}`;
    transcript('p1', `${prefix}macos behavior\n${DIFF}`);
    transcript('p2', `${prefix}linux behavior\n${DIFF}`);
    const r = composeReview({ planPath: plan(), env: ENV, modelId: MODEL });

    expect(r.body).toContain('(×2)');
  });

  it('renders prompt-derived labels as inert Markdown', () => {
    transcript(
      'p1',
      `Fix the "daemon marker" regression for @owner from #123\n${DIFF}`,
    );
    const r = composeReview({ planPath: plan(), env: ENV, modelId: MODEL });

    expect(r.body).toContain(
      'Not reviewed: `"Fix the \\"daemon marker\\" regression for @owner from #123"`',
    );
  });

  it('collapses spaces after removing backticks from agent labels', () => {
    transcript('p1', `Inspect the \`auth\` and \`session\` paths\n${DIFF}`);
    const r = composeReview({ planPath: plan(), env: ENV, modelId: MODEL });

    expect(r.body).toContain(
      'Not reviewed: `"Inspect the auth and session paths"`',
    );
  });

  it('labels an agent by its brief codename wherever it sits in the prompt', () => {
    // Launchers prepend context lines: twelve live finders shared one
    // PR-summary first line, so every disclosure rendered the same truncated
    // PR quote. The codename line wins over first-line prose.
    transcript(
      'p1',
      `PR #9045 modifies getAuthTypeFromEnv().\nYou are review agent \`security\` — inspect auth\n${DIFF}`,
    );
    const r = composeReview({ planPath: plan(), env: ENV, modelId: MODEL });

    expect(r.body).toContain('Not reviewed: `"agent security"`');
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
      floorEnforced: [],
      postedInline: 0,
      downgradedFrom: null,
      remediation: [],
      deferredCount: 0,
      bodyTrim: {
        sections: 0,
        deferralList: false,
        fold: false,
        truncated: false,
      },
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
    // The partial opener, in both halves (#8811).
    expect(r.body).toContain('Partially reviewed — gaps disclosed.');
    expect(r.body).toContain('仅完成部分审查，审查缺口已披露。');
  });

  it('keeps the untranslatable unresolved list in the English half; the Chinese half points at it', () => {
    const r = composeReview({
      suggestionsInline: 1,
      cannotTellCriticals: ['old blocker at a.ts:1 — still reachable?'],
      planPath: coveredPlan(undefined, { han: true }),
      env: ENV,
      modelId: MODEL,
    });
    expect(r.body).toContain('Unresolved, please confirm:');
    // The caller's text once, above the fold — the fold carries a count and
    // a pointer, not a duplicate of the English list (#8388's fold doubled
    // the body copying 31 untranslated entries verbatim).
    expect(
      r.body.match(/old blocker at a\.ts:1 — still reachable\?/g) ?? [],
    ).toHaveLength(1);
    expect(r.body).toContain('未决，请确认：共 1 条');
    expect(r.body.indexOf('old blocker at a.ts:1')).toBeLessThan(
      r.body.indexOf('<details>'),
    );
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

  it('carries the reviewed head sha as the incremental anchor on a clean run', () => {
    // A GENUINELY clean run: covered plan, transcripts, Step 4/5 records. The
    // first cut of this test used the describe-local bare plan — which
    // compose-review itself caps ("could not certify that any of this diff
    // was reviewed") — so the suite pinned the anchor's presence on exactly
    // the round that must not carry one, and the cappedBy divergence below
    // went unnoticed until a sandboxed verification measured it.
    // Not base(): its planPath default would call coveredPlan() again and
    // overwrite the same plan.json without the PR identity or the sha.
    const r = composeReview({
      planPath: coveredPlan(['verify', 'reverse-audit'], {
        prNumber: 8255,
        fetchedSha: 'deadbeef00112233',
      }),
      env: ENV,
      modelId: MODEL,
      criticalsInline: 0,
      suggestionsInline: 0,
      draftedComments: [
        { path: 'src/a.ts', line: 3, body: '**[Suggestion]** untested' },
      ],
    });
    expect(r.cappedBy).toEqual([]);
    expect(parseLedger(r.body)?.sha).toBe('deadbeef00112233');
  });

  it('withholds the anchor when the posting model is not the reviewing model', () => {
    // The deferred-post flow: review under A, `/model` to B, "post comments".
    // The runtime id is sampled at POST time, so it says B while the plan's
    // round-start stamp says A — this round cannot say who reviewed the
    // range, so it certifies nobody and the pair is withheld. The findings
    // still ride; the next round simply re-reviews in full.
    const drifted = composeReview(
      {
        planPath: coveredPlan(['verify', 'reverse-audit'], {
          prNumber: 8255,
          fetchedSha: 'deadbeef00112233',
          reviewModelId: 'model-a',
        }),
        env: ENV,
        modelId: MODEL,
        criticalsInline: 0,
        suggestionsInline: 0,
        draftedComments: [
          { path: 'src/a.ts', line: 3, body: '**[Suggestion]** untested' },
        ],
      },
      'unknown',
      true,
      'model-b',
    );
    expect(drifted.cappedBy).toEqual([]);
    const withheld = parseLedger(drifted.body)!;
    expect(withheld.sha).toBeUndefined();
    expect(withheld.model).toBeUndefined();
    expect(withheld.findings.length).toBeGreaterThan(0);

    // Same stamp, same poster: the anchor rides, certified by that identity.
    const agreed = composeReview(
      {
        planPath: coveredPlan(['verify', 'reverse-audit'], {
          prNumber: 8255,
          fetchedSha: 'deadbeef00112233',
          reviewModelId: 'model-a',
        }),
        env: ENV,
        modelId: MODEL,
        criticalsInline: 0,
        suggestionsInline: 0,
        draftedComments: [
          { path: 'src/a.ts', line: 3, body: '**[Suggestion]** untested' },
        ],
      },
      'unknown',
      true,
      'model-a',
    );
    expect(parseLedger(agreed.body)?.sha).toBe('deadbeef00112233');
    expect(parseLedger(agreed.body)?.model).toBe('model-a');
  });

  it('a stamped round with NO runtime identity withholds, never falls back', () => {
    // The deferred post run from a terminal outside a session shell: the
    // plan proves the round STARTED under an identity, and the post-time
    // channel says nothing. Skipping the check there let `certifying` fall
    // back to the model-WRITTEN state field — the channel this PR retires —
    // so the marker certified the sha to a typed id and a later round under
    // a matching typed id scoped past code it never reviewed.
    //
    // The recovery side already rules an empty running identity a mismatch;
    // this is the same rule on the certifying side.
    const r = composeReview(
      {
        planPath: coveredPlan(['verify', 'reverse-audit'], {
          prNumber: 8255,
          fetchedSha: 'deadbeef00112233',
          reviewModelId: 'model-a@aaaaaaaa',
        }),
        env: ENV,
        modelId: 'typed-by-the-model',
        criticalsInline: 0,
        suggestionsInline: 0,
        draftedComments: [
          { path: 'src/a.ts', line: 3, body: '**[Suggestion]** untested' },
        ],
      },
      'unknown',
      true,
      '',
    );
    const withheld = parseLedger(r.body)!;
    expect(withheld.sha).toBeUndefined();
    expect(withheld.model).toBeUndefined();
    // The footer still names the model — attribution is a separate contract.
    // What must not carry it is the MARKER, which is the anchor's certificate.
    expect(JSON.stringify(withheld)).not.toContain('typed-by-the-model');
    // The findings still ride.
    expect(withheld.findings.length).toBeGreaterThan(0);
  });

  it('a provider-qualified identity is what gets certified, verbatim', () => {
    // A bare model id is unique only inside one provider configuration; the
    // runtime publishes `<model>@<8-hex of authType+baseUrl>` so two
    // configurations exposing one name cannot pass each other's gate.
    const r = composeReview(
      {
        planPath: coveredPlan(['verify', 'reverse-audit'], {
          prNumber: 8255,
          fetchedSha: 'deadbeef00112233',
          reviewModelId: 'qwen3.7-max@1a2b3c4d',
        }),
        env: ENV,
        modelId: MODEL,
        criticalsInline: 0,
        suggestionsInline: 0,
        draftedComments: [
          { path: 'src/a.ts', line: 3, body: '**[Suggestion]** untested' },
        ],
      },
      'unknown',
      true,
      'qwen3.7-max@1a2b3c4d',
    );
    expect(parseLedger(r.body)?.model).toBe('qwen3.7-max@1a2b3c4d');
    // …and the SAME model id under a different provider does not match it.
    expect(parseLedger(r.body)?.model).not.toBe('qwen3.7-max@9f8e7d6c');
  });

  it('the anchor carries its model — the same-model contract survives recovery', () => {
    // The cache pairs `lastCommitSha` with `lastModelId`, and Step 1 refuses
    // the incremental shortcut across models — but the marker's anchor rode
    // bare, so a cross-model round that recovered it from the posted body
    // scoped `sha..HEAD` past code the current model never reviewed. The
    // model that certified the range now travels beside it.
    const r = composeReview({
      planPath: coveredPlan(['verify', 'reverse-audit'], {
        prNumber: 8255,
        fetchedSha: 'deadbeef00112233',
      }),
      env: ENV,
      modelId: MODEL,
      criticalsInline: 0,
      suggestionsInline: 0,
      draftedComments: [
        { path: 'src/a.ts', line: 3, body: '**[Suggestion]** untested' },
      ],
    });
    const ledger = parseLedger(r.body)!;
    expect(ledger.sha).toBe('deadbeef00112233');
    expect(ledger.model).toBe(MODEL);
  });

  it('attribution off: the marker withholds the model WITH the footer', () => {
    // `review.attribution` is "whether the posted review names its model".
    // The footer is the visible half; the marker rides the same posted body,
    // so a model id inside it publishes exactly what the setting removes —
    // readable through the API and the raw-body edit view — on a write this
    // module calls public and irreversible. Withheld, the anchor degrades to
    // the skill's specified fail-safe: absent model → mismatch → full-range.
    const r = composeReview(
      {
        planPath: coveredPlan(['verify', 'reverse-audit'], {
          prNumber: 8255,
          fetchedSha: 'deadbeef00112233',
        }),
        env: ENV,
        modelId: MODEL,
        criticalsInline: 0,
        suggestionsInline: 0,
        draftedComments: [
          { path: 'src/a.ts', line: 3, body: '**[Suggestion]** untested' },
        ],
      },
      'unknown',
      false,
    );
    const ledger = parseLedger(r.body)!;
    expect(ledger.sha).toBe('deadbeef00112233');
    expect(ledger.model).toBeUndefined();
    expect(r.body).not.toContain(MODEL);
  });

  it('attribution off, modelId absent: the marker SURVIVES — only the model is withheld', () => {
    // Attribution off skips the `modelId is required` validation, so a state
    // JSON without the field is legal on a clean round. A marker path that
    // threw on it would drop the WHOLE marker, not just the model: the round
    // counter resets (the next round re-issues ids the PR already carries)
    // and the findings work list is lost. Measured: deleting the typeof guard
    // survived the suite, so this pins the branch by name.
    const r = composeReview(
      {
        planPath: coveredPlan(['verify', 'reverse-audit'], {
          prNumber: 8255,
          fetchedSha: 'deadbeef00112233',
        }),
        env: ENV,
        modelId: undefined as unknown as string,
        criticalsInline: 0,
        suggestionsInline: 0,
        draftedComments: [
          { path: 'src/a.ts', line: 3, body: '**[Suggestion]** untested' },
        ],
      },
      'unknown',
      false,
    );
    const ledger = parseLedger(r.body)!;
    expect(ledger.sha).toBe('deadbeef00112233');
    expect(ledger.model).toBeUndefined();
  });

  it('attribution off WITH a runtime identity: the session model stays withheld', () => {
    // The runtime channel is the primary identity path — every session
    // publishes QWEN_CODE_MODEL — so the attribution gate must reach it,
    // not just the typed fallback the sibling cases pin: a gate reading
    // `(attribution || runtime !== '') && certifying !== ''` would leak the
    // session model into every ordinary attribution-off post, and measured,
    // it ships CI-green — both earlier attribution-off tests omit
    // runtimeModelId.
    const r = composeReview(
      {
        planPath: coveredPlan(['verify', 'reverse-audit'], {
          prNumber: 8255,
          fetchedSha: 'deadbeef00112233',
        }),
        env: ENV,
        modelId: MODEL,
        criticalsInline: 0,
        suggestionsInline: 0,
        draftedComments: [
          { path: 'src/a.ts', line: 3, body: '**[Suggestion]** untested' },
        ],
      },
      'unknown',
      false,
      'the-session-model',
    );
    const ledger = parseLedger(r.body)!;
    expect(ledger.sha).toBe('deadbeef00112233');
    expect(ledger.model).toBeUndefined();
    expect(r.body).not.toContain('the-session-model');
  });

  it('the anchor carries the RUNTIME identity — injected at the CLI boundary, superseding the typed id', () => {
    // The certifying model used to be `input.modelId` — a field of the
    // model-written state JSON. A review running under one model could type
    // another's id, and the posted anchor would certify the range to a model
    // that never reviewed it: a later run of that model accepts `sha..HEAD`
    // and skips the earlier code. The boundaries now inject the runtime-
    // published identity (Config publishes QWEN_CODE_MODEL), superseding the
    // typed field, which is only the fallback for runs no session published.
    const r = composeReview(
      {
        planPath: coveredPlan(['verify', 'reverse-audit'], {
          prNumber: 8255,
          fetchedSha: 'deadbeef00112233',
        }),
        env: ENV,
        modelId: 'typed-by-the-model',
        criticalsInline: 0,
        suggestionsInline: 0,
        draftedComments: [
          { path: 'src/a.ts', line: 3, body: '**[Suggestion]** untested' },
        ],
      },
      'unknown',
      true,
      'the-session-model',
    );
    const ledger = parseLedger(r.body)!;
    expect(ledger.sha).toBe('deadbeef00112233');
    expect(ledger.model).toBe('the-session-model');
  });

  it('withholds the model WITH the sha on a capped round — it qualifies the anchor, nothing else', () => {
    const r = composeReview({
      planPath: plan({ fetchedSha: 'deadbeef00112233' }),
      modelId: 'm',
      criticalsInline: 0,
      suggestionsInline: 0,
      draftedComments: [{ path: 'a.ts', body: '**[Critical]** boom' }],
    });
    expect(r.cappedBy.length).toBeGreaterThan(0);
    const ledger = parseLedger(r.body)!;
    expect(ledger.sha).toBeUndefined();
    expect(ledger.model).toBeUndefined();
  });

  it('withholds the sha when the module ITSELF caps the round', () => {
    // The four input fields are not the only fail-closed signals: cappedBy is
    // computed in this module from conditions with no input channel at all
    // (coverage it could not prove, findings still unverified). Measured live:
    // gated on the input fields alone, a round stamped "could not certify
    // that any of this diff was reviewed" still carried the anchor. This bare
    // plan (no coverage, no transcripts) is exactly that round.
    const r = composeReview({
      planPath: plan({ fetchedSha: 'deadbeef00112233' }),
      modelId: 'm',
      criticalsInline: 0,
      suggestionsInline: 0,
      draftedComments: [{ path: 'a.ts', body: '**[Critical]** boom' }],
    });
    expect(r.cappedBy.length).toBeGreaterThan(0);
    const ledger = parseLedger(r.body);
    expect(ledger?.sha).toBeUndefined();
    expect(ledger?.findings).toHaveLength(1);
  });

  it('withholds the sha on a fail-closed input — the findings still ride', () => {
    // Same conditions under which Step 8 forbids advancing the cache's
    // lastCommitSha: an anchor written past unreviewed scope lets the next
    // round's incremental range skip it forever. Each named input reaches the
    // predicate through the cap entry composeReviewBody pushes for it — the
    // predicate reads the module's own verdict, not a parallel list — except
    // the last case: a whitespace-only cannotTellCriticals entry is filtered
    // out of the rendered caps (nothing to render), but an undecided blocker
    // whose text was lost is still an undecided blocker, so the one raw
    // input check must catch what the cap list deliberately drops. That case
    // asserts cappedBy is EMPTY, which is exactly why it exists: delete the
    // raw check and only this case fails (measured — a mutant keeping only
    // `cappedBy.length > 0` survived every other test in the suite).
    for (const failClosed of [
      // Restored after a live review of this change (#9175, R2-12) named what
      // deleting it cost: a whiffed lens is recorded in `unreviewedDimensions`
      // and NOTHING else sees it — `coverageFromTranscripts` reports only idle,
      // blind and never-opened agents — so exempting the whole field let a
      // twice-whiffed Security pass advance the range past lines it never read.
      { unreviewedDimensions: ['security — the agent whiffed twice'] },
      { cannotTellCriticals: ['a.ts:3 — could not fetch the full body'] },
      { uncoverableChunks: ['chunk 5 (src/big.min.js)'] },
      { contextUnavailable: true },
      { cannotTellCriticals: [' '] },
    ]) {
      const r = composeReview({
        planPath: coveredPlan(['verify', 'reverse-audit'], {
          prNumber: 8255,
          fetchedSha: 'deadbeef00112233',
        }),
        env: ENV,
        modelId: MODEL,
        criticalsInline: 0,
        suggestionsInline: 0,
        draftedComments: [
          { path: 'src/a.ts', line: 3, body: '**[Suggestion]** untested' },
        ],
        ...failClosed,
      });
      const ledger = parseLedger(r.body);
      // Keyed by the fail-closed input so a regression names its condition.
      expect({ ...failClosed, sha: ledger?.sha }).toEqual({ ...failClosed });
      expect(ledger?.findings).toHaveLength(1);
      if (
        Array.isArray(failClosed.cannotTellCriticals) &&
        failClosed.cannotTellCriticals[0] === ' '
      ) {
        // The raw-check-only case: no cap fires, the input alone withholds.
        expect(r.cappedBy).toEqual([]);
      }
    }
  });

  it('still ANCHORS a round whose only cap is an unreviewable dimension', () => {
    // The one cap that no longer withholds. `unreviewedDimensions` is the
    // orchestrator's prose about DEPTH — on this repo, "the integration suite
    // CI skipped did not run locally", true of every round because
    // `build-test`'s whole-call budget cannot fit the suites. Withholding on
    // it closed a loop with no exit: an untestable dimension capped the
    // verdict, the cap withheld the anchor, and the missing anchor made the
    // next round re-review the full diff — 119 minutes and 34M tokens on a PR
    // whose code had not changed since the round before (measured, #9113 r2).
    // A dimension nobody could run says nothing about WHICH LINES were read,
    // and the anchor's only claim is about lines.
    const r = composeReview({
      planPath: coveredPlan(['verify', 'reverse-audit'], {
        prNumber: 8255,
        fetchedSha: 'deadbeef00112233',
      }),
      env: ENV,
      modelId: MODEL,
      criticalsInline: 0,
      suggestionsInline: 0,
      draftedComments: [
        { path: 'src/a.ts', line: 3, body: '**[Suggestion]** untested' },
      ],
      unreviewedDimensions: [
        'build-and-test — the integration suite never ran',
      ],
    });

    expect(r.cappedBy).toEqual(['unreviewed-dimension']);
    expect(r.scopeUnproven).toBe(false);
    expect(r.dimensionGapsAreDepthOnly).toBe(true);
    expect(parseLedger(r.body)?.sha).toBe('deadbeef00112233');
  });

  it('classifies a budget stop the same whether or not the entry is relayed', () => {
    // The stderr instruction MANDATES relaying the stop entry, so a rule that
    // reads only the prose withheld the anchor from every compliant run and
    // carried it for every non-compliant one — identical machine state,
    // opposite outcomes by relay. The marker is the state; the entry is its
    // echo; a truncated reverse audit is DEPTH over lines the receipts
    // already prove read.
    const composeWith = (dims: string[]): ReturnType<typeof composeReview> => {
      const planPath = coveredPlan(['verify', 'reverse-audit'], {
        prNumber: 8255,
        fetchedSha: 'deadbeef00112233',
      });
      writeBudgetStop(
        planPath,
        { remainingSeconds: 10, reserveSeconds: 300, expectedRoundSeconds: 60 },
        3,
      );
      return composeReview({
        planPath,
        env: ENV,
        modelId: MODEL,
        criticalsInline: 0,
        suggestionsInline: 0,
        draftedComments: [
          { path: 'src/a.ts', line: 3, body: '**[Suggestion]** untested' },
        ],
        unreviewedDimensions: dims,
      });
    };

    // Non-compliant baseline: the entry is dropped. The machine state alone
    // decides everything below.
    const dropped = composeWith([]);
    expect(dropped.dimensionGapsAreDepthOnly).toBe(true);
    expect(parseLedger(dropped.body)?.sha).toBe('deadbeef00112233');

    // Compliant: the canonical entry is relayed. The splice retires it, the
    // structural line carries the disclosure — so the BODY IS BYTE-IDENTICAL
    // to the dropped case. That is the whole relay-independence claim in one
    // assertion, and it is what an English-only splice broke for the Chinese
    // pair: the relayed zh entry survived into the whiffed-dimension
    // rendering beside the structural stop line — the same gap said twice,
    // one copy under the wrong cause.
    const relayed = composeWith([budgetStopEntry(3)]);
    expect(relayed.dimensionGapsAreDepthOnly).toBe(true);
    expect(relayed.body).toBe(dropped.body);

    const relayedZh = composeWith([budgetStopEntryZh(3)]);
    expect(relayedZh.dimensionGapsAreDepthOnly).toBe(true);
    expect(relayedZh.body).toBe(dropped.body);

    // A LINE-COVERAGE claim whose whiffed scope IS the reverse audit: same
    // head, mentions the phrase, marker present — and it must withhold. The
    // exemption is text-anchored to the exact entries the machinery mints,
    // because anything looser also covers this, and the phrase splice removes
    // it from the rendered body so nothing else would ever disclose it again.
    const whiffed = composeWith([
      'reverse audit — the review time budget ended the round before the chunk-2 relaunch returned evidence',
    ]);
    expect(whiffed.dimensionGapsAreDepthOnly).toBe(false);
    expect(parseLedger(whiffed.body)?.sha).toBeUndefined();
  });

  it('classifies a ROUND-CAP stop the same way, relay or no relay', () => {
    // The round-cap branch mints its own canonical pair; without a pin the
    // budget branch could hold while this one regressed to relay-dependence.
    const composeWith = (dims: string[]): ReturnType<typeof composeReview> => {
      const planPath = coveredPlan(['verify', 'reverse-audit'], {
        prNumber: 8255,
        fetchedSha: 'deadbeef00112233',
      });
      writeRoundCapStop(planPath, 5, 5);
      return composeReview({
        planPath,
        env: ENV,
        modelId: MODEL,
        criticalsInline: 0,
        suggestionsInline: 0,
        draftedComments: [
          { path: 'src/a.ts', line: 3, body: '**[Suggestion]** untested' },
        ],
        unreviewedDimensions: dims,
      });
    };
    const dropped = composeWith([]);
    expect(dropped.dimensionGapsAreDepthOnly).toBe(true);
    expect(parseLedger(dropped.body)?.sha).toBe('deadbeef00112233');
    // Byte identity across all three relay states, exactly as the budget
    // branch pins it — the Chinese pair included, whose splice constant
    // exists for precisely this path.
    const relayed = composeWith([roundCapStopEntry(5)]);
    expect(relayed.dimensionGapsAreDepthOnly).toBe(true);
    expect(relayed.body).toBe(dropped.body);
    const relayedZh = composeWith([roundCapStopEntryZh(5)]);
    expect(relayedZh.dimensionGapsAreDepthOnly).toBe(true);
    expect(relayedZh.body).toBe(dropped.body);
  });

  it('gives stop-shaped PROSE no exemption when no marker backs it', () => {
    // Marker-anchored on purpose: without the machine state, an entry that
    // merely looks like the stop must not buy an anchor — and a lens entry
    // that mentions the phrase in its reason withholds either way (its head
    // names the lens, not the reverse audit).
    const r = composeReview({
      planPath: coveredPlan(['verify', 'reverse-audit'], {
        prNumber: 8255,
        fetchedSha: 'deadbeef00112233',
      }),
      env: ENV,
      modelId: MODEL,
      criticalsInline: 0,
      suggestionsInline: 0,
      draftedComments: [
        { path: 'src/a.ts', line: 3, body: '**[Suggestion]** untested' },
      ],
      unreviewedDimensions: [budgetStopEntry(3)],
    });
    expect(r.dimensionGapsAreDepthOnly).toBe(false);
    expect(parseLedger(r.body)?.sha).toBeUndefined();
  });

  it('keeps the marker round-trip whole AT the round cap', () => {
    // The stamp is capped because the round is the id space: an uncapped
    // prevRound + 1 met the serializer's round clamp at exactly the cap and
    // produced a marker whose own parser dropped every finding — invisibly,
    // with the anchor still riding.
    writeFileSync(
      join(dir, 'qwen-review-pr-8255-prev-ledger.json'),
      JSON.stringify({ v: 1, round: LEDGER_MAX_ROUND, findings: [] }),
    );
    const r = composeReview({
      planPath: plan(),
      modelId: 'm',
      criticalsInline: 0,
      suggestionsInline: 0,
      draftedComments: [{ path: 'a.ts', body: '**[Critical]** boom' }],
    });
    const ledger = parseLedger(r.body);
    expect(ledger?.round).toBe(LEDGER_MAX_ROUND);
    // The finding survives its own round trip — id round == marker round.
    expect(ledger?.findings).toHaveLength(1);
    expect(ledger?.findings[0]?.id).toBe(`R${LEDGER_MAX_ROUND}-1`);
  });

  it("sees a debt the deterministic gates push in AFTER the caller's entries", () => {
    // `unreviewed` has three writers, at three different points: the caller's
    // own entries, the budget-phrase splice that removes some of them, and the
    // script-lint / layer-audit gates that push machine-owed debts later. A
    // decision that reads any single snapshot misses one of them — an earlier
    // fix read too late and missed the splice, its replacement read too early
    // and missed the gates. Both directions are line-coverage claims, so both
    // must withhold: an unlinted script or an unwalked defect layer is not a
    // dimension nobody could run.
    expect(
      isNonDiffDimensionGap('the executable-script lint — no report'),
    ).toBe(false);
    expect(
      isNonDiffDimensionGap('reverse-audit layer coverage — 2 layers unwalked'),
    ).toBe(false);
    // ...and the only entry that IS exempt stays exempt.
    expect(
      isNonDiffDimensionGap('build-and-test — the integration suite never ran'),
    ).toBe(true);
  });

  it('sees a lens gap the budget-phrase splice removes from the rendered list', () => {
    // The splice keeps the body from saying one gap twice, and it matches on a
    // PHRASE — so an entry that merely mentions the review time budget in its
    // free-form reason leaves `unreviewedDimensions` before anything else reads
    // it. Harmless while every cap withheld the anchor; not harmless once one
    // cap does not, because the spliced entry is the line-coverage claim the
    // anchor decision exists to respect.
    const r = composeReview({
      planPath: coveredPlan(['verify', 'reverse-audit'], {
        prNumber: 8255,
        fetchedSha: 'deadbeef00112233',
      }),
      env: ENV,
      modelId: MODEL,
      criticalsInline: 0,
      suggestionsInline: 0,
      draftedComments: [
        { path: 'src/a.ts', line: 3, body: '**[Suggestion]** untested' },
      ],
      unreviewedDimensions: [
        'security — the review time budget ended the round before the security relaunch returned evidence',
      ],
    });

    expect(r.dimensionGapsAreDepthOnly).toBe(false);
    expect(parseLedger(r.body)?.sha).toBeUndefined();
  });

  it('withholds the anchor when a dimension gap is about LINES, not depth', () => {
    // The distinction the exemption turns on, and the one a live review of
    // this change had to restore: Agent 7 is the only role whose brief sets
    // `readsDiff: false`, so only its gap says nothing about which lines were
    // read. Any other dimension in that field is a whiffed lens — a claim
    // about lines that no machine detector produces.
    const withLensGap = composeReview({
      planPath: coveredPlan(['verify', 'reverse-audit'], {
        prNumber: 8255,
        fetchedSha: 'deadbeef00112233',
      }),
      env: ENV,
      modelId: MODEL,
      criticalsInline: 0,
      suggestionsInline: 0,
      draftedComments: [
        { path: 'src/a.ts', line: 3, body: '**[Suggestion]** untested' },
      ],
      unreviewedDimensions: [
        'build-and-test — the integration suite never ran',
        'security — the agent whiffed twice',
      ],
    });

    expect(withLensGap.cappedBy).toEqual(['unreviewed-dimension']);
    expect(withLensGap.scopeUnproven).toBe(false);
    expect(withLensGap.dimensionGapsAreDepthOnly).toBe(false);
    expect(parseLedger(withLensGap.body)?.sha).toBeUndefined();
    // The findings still ride: a fail-closed round's work list is still a work
    // list, it just cannot certify a range.
    expect(parseLedger(withLensGap.body)?.findings).toHaveLength(1);
  });

  it('withholds it again as soon as the COVERAGE evidence is short', () => {
    // The safety property the relaxation must not cost: when the machine
    // evidence itself leaves doubt that the diff was read, the cap wears the
    // same name (`unreviewed-dimension`) but `scopeUnproven` is what decides.
    transcript('a1', goodPrompt(1), { toolCalls: 0 });
    transcript('a2', goodPrompt(2), { toolCalls: 0 });
    const r = composeReview({
      planPath: plan({ prNumber: 8255, fetchedSha: 'deadbeef00112233' }),
      env: ENV,
      modelId: MODEL,
      criticalsInline: 0,
      suggestionsInline: 0,
      draftedComments: [
        { path: 'src/a.ts', line: 3, body: '**[Suggestion]** untested' },
      ],
    });

    expect(r.scopeUnproven).toBe(true);
    expect(parseLedger(r.body)?.sha).toBeUndefined();
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

describe('composeReview — convergence-posture deferrals (typed channel; disclosed, never capping)', () => {
  // The channel is TYPED: `{file, line?, source, severity, title, locations?}`.
  // Deterministic derives from `source`, relocation from `severity`, and the
  // rendered `file:line — [source] title` is formatting nothing re-parses —
  // the class of regex misses four review rounds kept finding is closed by
  // construction, so no test here probes a spelling.
  const nit = (over: Partial<DeferredEntry> = {}): DeferredEntry => ({
    file: 'a.ts',
    line: 1,
    source: 'review',
    severity: 'Suggestion',
    title: 'nit',
    ...over,
  });

  it('an APPROVE with deferrals keeps its event, anchor, and honesty', () => {
    // The posture's whole payoff: a clean late round with only deferrals
    // composes an APPROVE — the loop's stop signal — while the deferred list
    // stays on the record and the incremental anchor still rides. And the
    // opener must not claim "No issues found" over findings the same body
    // lists two paragraphs down.
    const planPath = coveredPlan(['verify', 'reverse-audit'], {
      prNumber: 8255,
      fetchedSha: 'deadbeef00112233',
    });
    writeFileSync(
      join(dirname(planPath), 'qwen-review-pr-8255-prev-ledger.json'),
      JSON.stringify({ v: 1, round: 5, findings: [] }),
    );
    const r = composeReview({
      planPath,
      env: ENV,
      modelId: MODEL,
      criticalsInline: 0,
      suggestionsInline: 0,
      severityFloor: 'auto',
      deferredSuggestions: [
        nit({ file: 'src/a.ts', line: 42, title: 'tighten the retry backoff' }),
      ],
    });
    expect(r.event).toBe('APPROVE');
    expect(r.cappedBy).toEqual([]);
    expect(r.body).toContain('No blocking issues. LGTM! ✅');
    expect(r.body).not.toContain('No issues found');
    expect(r.body).toContain('convergence posture (round 6, not a blocker)');
    expect(r.body).toContain(
      '- `src/a.ts:42 — [review] tighten the retry backoff`',
    );
    expect(parseLedger(r.body)?.sha).toBe('deadbeef00112233');
    // The clause and the marker must name the SAME round — mutation-verified
    // that re-splitting the side-file read ships green without this pin.
    expect(parseLedger(r.body)?.round).toBe(6);
    // Pure deferrals stay OUT of the ledger work list — feeding them to
    // buildLedger re-opens next round exactly what the posture recorded so
    // nobody would re-rule it.
    expect(parseLedger(r.body)?.findings).toEqual([]);
  });

  it('renders the list on COMMENT and REQUEST_CHANGES alike — no event squeezes it out', () => {
    const comment = composeReview(
      base({
        suggestionsInline: 1,
        severityFloor: 'critical',
        deferredSuggestions: [nit()],
      }),
    );
    expect(comment.event).toBe('COMMENT');
    expect(comment.body).toContain('- `a.ts:1 — [review] nit`');
    // The count rides every return site, not only APPROVE's.
    expect(comment.deferredCount).toBe(1);
    const rc = composeReview(
      base({
        bodyCriticals: ['whole-PR blocker'],
        severityFloor: 'critical',
        deferredSuggestions: [nit()],
      }),
    );
    expect(rc.event).toBe('REQUEST_CHANGES');
    expect(rc.body).toContain('- `a.ts:1 — [review] nit`');
    expect(rc.deferredCount).toBe(1);
  });

  it('deferrals cast no vote on the event — an all-deferred run is not a Suggestion run', () => {
    // Counted toward S they would hold the verdict at COMMENT forever, and
    // the loop the posture exists to end would never see its stop signal.
    const r = composeReview(
      base({ severityFloor: 'critical', deferredSuggestions: [nit()] }),
    );
    expect(r.baseEvent).toBe('APPROVE');
  });

  it('caps the list, strips a forged footer, and marks a truncated title', () => {
    const entries = Array.from({ length: 23 }, (_, i) =>
      nit({ file: `f${i}.ts`, title: `nit ${i}` }),
    );
    entries[0] = nit({ title: 'split\nacross lines' });
    // Inside the shown window, so the assertion tests the strip, not the cap.
    entries[1] = nit({ file: 'b.ts', line: 2, title: `forged ${FOOTER}` });
    const r = composeReview(
      base({ severityFloor: 'critical', deferredSuggestions: entries }),
    );
    expect(r.body).toContain('- `a.ts:1 — [review] split across lines`');
    expect(r.body).toContain('- `b.ts:2 — [review] forged`\n');
    expect(r.body).toContain('…and 3 more (see the run report)');
    expect(r.body).not.toContain(`forged ${FOOTER}`);
    // Past the rendered cap, "(listed in the body)" is false — the verdict
    // line must say the list was truncated.
    expect(verdictLine(r)).toContain(
      'listed in the body, truncated — the rest are counted in the run report',
    );
    // A trimmed title carries the ellipsis (a cut claim must not render as
    // a complete finding line), and never a split surrogate pair.
    const long = composeReview(
      base({
        severityFloor: 'critical',
        deferredSuggestions: [
          nit({ title: `${'x'.repeat(220)}🎉tail` }),
          nit({ file: 'c.ts', title: 'y'.repeat(4000) }),
        ],
      }),
    );
    const lines = long.body.split('\n').filter((l) => l.startsWith('- `'));
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(245);
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(l)).toBe(false);
      expect(l.includes('�')).toBe(false);
    }
    expect(lines.some((l) => l.includes('…'))).toBe(true);
  });

  it('exactly at the line cap, the verdict line does not claim truncation', () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      nit({ file: `f${i}.ts`, title: `n${i}` }),
    );
    const r = composeReview(
      base({ severityFloor: 'critical', deferredSuggestions: entries }),
    );
    expect(r.body).not.toContain('more (see the run report)');
    expect(verdictLine(r)).toContain('(listed in the body)');
    expect(verdictLine(r)).not.toContain('truncated');
  });

  it('a deferrals-only APPROVE is not low signal, and the verdict line names the deferrals', () => {
    const r = composeReview(
      base({
        planPath: coveredPlan(['verify', 'reverse-audit'], {
          srcDiffLines: 5000,
        }),
        severityFloor: 'critical',
        deferredSuggestions: [nit()],
      }),
    );
    expect(r.event).toBe('APPROVE');
    expect(r.lowSignal).toBeNull();
    expect(r.deferredCount).toBe(1);
    expect(verdictLine(r)).toBe(
      'Verdict: Approve — 1 non-Critical finding(s) deferred under the convergence posture (listed in the body)',
    );
  });

  it('deferred findings count toward the verifier-delivery floor — deterministic sources excepted', () => {
    // A deferral publishes its claim in the body, so a deferrals-only run
    // owes a verifier exactly as a posting run does — unless the source is
    // deterministic (build/test/probe are pre-confirmed and Step 4 launches
    // no verifier for them; demanding one would be a permanent self-cap).
    // NOT base(): its planPath default writes a verify record into the
    // shared dir, which would satisfy the very floor this proves.
    const planPath = coveredPlan(['reverse-audit']);
    const common = {
      criticalsInline: 0,
      suggestionsInline: 0,
      planPath,
      env: ENV,
      modelId: MODEL,
      severityFloor: 'critical' as const,
    };
    expect(composeReview(common).cappedBy).toEqual([]);
    const reviewSourced = composeReview({
      ...common,
      deferredSuggestions: [nit()],
    });
    expect(reviewSourced.cappedBy).toContain('unreviewed-dimension');
    expect(reviewSourced.event).toBe('COMMENT');
    for (const source of ['build', 'test', 'probe'] as const) {
      const det = composeReview({
        ...common,
        deferredSuggestions: [
          nit({
            file: 'packages/core/src/my-file.ts',
            line: 42,
            source,
            title: 'mutation survivor',
            locations: 2,
          }),
        ],
      });
      expect(det.cappedBy).toEqual([]);
      expect(det.event).toBe('APPROVE');
      expect(det.body).toContain(
        `- \`packages/core/src/my-file.ts:42 (+2 locations) — [${source}] mutation survivor\``,
      );
    }
  });

  it('relocates a Critical entry into the body Criticals — never a throw, never deferred', () => {
    // The entry is a Critical by its own field, so it counts toward C, the
    // event blocks, the round posts, and it rides the machine ledger ("the
    // findings always ride" includes the mis-routed ones).
    const planPath = coveredPlan(['verify', 'reverse-audit'], {
      prNumber: 8255,
      fetchedSha: 'deadbeef00112233',
    });
    const r = composeReview({
      planPath,
      env: ENV,
      modelId: MODEL,
      criticalsInline: 0,
      suggestionsInline: 0,
      deferredSuggestions: [
        nit({
          file: 'src/auth.ts',
          line: 88,
          severity: 'Critical',
          title: 'auth bypass',
        }),
      ],
    });
    expect(r.event).toBe('REQUEST_CHANGES');
    expect(r.deferredCount).toBe(0);
    expect(r.body).toContain(
      '**[Critical]** `src/auth.ts:88 — [review] auth bypass` _(relocated from the deferral channel',
    );
    expect(parseLedger(r.body)?.findings.some((f) => f.sev === 'C')).toBe(true);
    // A relocation-only run (no floor echoed) incurs no licence cap — the
    // licence keys on the post-split deferred list, and salvage is exactly
    // the run relocation exists for.
    expect(r.cappedBy).not.toContain('unlicensed-deferral');
  });

  it('a relocated Critical is classified by its source FIELD, never its title', () => {
    // `source: 'review'` owes a verifier and caps `criticals-unverified`
    // when none ran, whatever the title mentions; `source: 'test'` is
    // pre-confirmed and blocks. Own case: the flagship relocation test's
    // verify record in the shared dir would satisfy the very floor this
    // proves.
    const titled = composeReview({
      criticalsInline: 0,
      suggestionsInline: 0,
      planPath: coveredPlan(['reverse-audit']),
      env: ENV,
      modelId: MODEL,
      deferredSuggestions: [
        nit({
          severity: 'Critical',
          title: 'mishandles [test] configuration files',
        }),
      ],
    });
    expect(titled.cappedBy).toContain('criticals-unverified');
    expect(titled.event).toBe('COMMENT');
    const genuine = composeReview({
      criticalsInline: 0,
      suggestionsInline: 0,
      planPath: coveredPlan(['reverse-audit']),
      env: ENV,
      modelId: MODEL,
      deferredSuggestions: [
        nit({
          severity: 'Critical',
          source: 'test',
          title: 'red on the merge',
        }),
      ],
    });
    expect(genuine.cappedBy).not.toContain('criticals-unverified');
    expect(genuine.event).toBe('REQUEST_CHANGES');
  });

  it('a relocated Critical is bounded like its deferred siblings — no unbounded feed into the body', () => {
    // Round-9 finding: relocation bypassed the per-entry cap, the newline
    // collapse, the surrogate trim and the Markdown neutralization that the
    // deferred exit applies; twenty-five 4,000-char relocated titles would
    // splice ~100 KB into the body and lose the review at GitHub's limit.
    const r = composeReview(
      base({
        deferredSuggestions: [
          nit({
            severity: 'Critical',
            title: `${'x'.repeat(4000)}\nsecond line @mention #123`,
          }),
        ],
      }),
    );
    const bodyLine = r.body
      .split('\n')
      .find((l) => l.startsWith('**[Critical]**'))!;
    // marker + backticked bounded line + relocation note: well under 4,000.
    expect(bodyLine.length).toBeLessThan(400);
    expect(bodyLine).toContain('…');
    expect(bodyLine).not.toContain('\nsecond');
    // Neutralized: the title rides inside a code span.
    expect(bodyLine).toMatch(/\*\*\[Critical\]\*\* `a\.ts:1 — \[review\] x+…`/);
  });

  it('refuses a malformed entry — the channel that un-posts findings is not guessed at', () => {
    const cases: Array<[unknown, RegExp]> = [
      ['a.ts:1 — nit', /free-text entry is not accepted/],
      [
        { file: 'a.ts', source: 'review', severity: 'Suggestion' },
        /non-empty file and title/,
      ],
      [
        { file: 'a.ts', source: 'lint?', severity: 'Suggestion', title: 't' },
        /source must be one of/,
      ],
      [
        { file: 'a.ts', source: 'review', severity: 'Blocker', title: 't' },
        /severity must be one of/,
      ],
      [
        {
          file: 'a.ts',
          source: 'review',
          severity: 'Nice to have',
          title: 't',
        },
        /terminal-only findings are never deferred/,
      ],
      [
        {
          file: 'a.ts',
          line: 0,
          source: 'review',
          severity: 'Suggestion',
          title: 't',
        },
        /line must be a positive integer/,
      ],
    ];
    for (const [entry, re] of cases) {
      expect(() =>
        composeReview(base({ deferredSuggestions: [entry] as never })),
      ).toThrow(re);
    }
    expect(() =>
      composeReview(base({ deferredSuggestions: 'a.ts' as never })),
    ).toThrow(/deferredSuggestions/);
  });

  it('caps — never refuses — deferrals the posture does not license', () => {
    // The channel only ever removes findings from posting, so unlicensed
    // shapes fail CLOSED but not FATAL: a thrown compose loses the whole
    // round, Criticals included, and `prevRound` is a best-effort side-file
    // read whose every failure mode returns 0 — a missing file at a true
    // round 6 must degrade to a disclosed, capped verdict, never to no
    // verdict at all. Every shape renders the list, discloses the missing
    // licence, caps the event, and withholds the anchor.
    const explicitOff = composeReview(
      base({ severityFloor: 'suggestion', deferredSuggestions: [nit()] }),
    );
    expect(explicitOff.cappedBy).toContain('unlicensed-deferral');
    expect(explicitOff.event).toBe('COMMENT');
    expect(explicitOff.body).toContain('without a posture licence');
    expect(explicitOff.body).toContain('- `a.ts:1 — [review] nit`');
    // The opener may not certify what the ⚠️ clause retracts.
    expect(explicitOff.body).not.toContain('no blockers');
    expect(parseLedger(explicitOff.body)?.sha).toBeUndefined();
    const round1Auto = composeReview(
      base({ severityFloor: 'auto', deferredSuggestions: [nit()] }),
    );
    expect(round1Auto.cappedBy).toContain('unlicensed-deferral');
    expect(verdictLine(round1Auto)).toContain(
      'findings were deferred without a posture licence',
    );
    // An ABSENT floor beside a non-empty list is unlicensed too: the field
    // ships in the same PR as the channel, so omission is fail-closed.
    const absent = composeReview(base({ deferredSuggestions: [nit()] }));
    expect(absent.cappedBy).toContain('unlicensed-deferral');
    expect(absent.body).toContain('carried no recognisable `severityFloor`');
    // And `auto` in the context-unavailable state: the round is unknowable.
    const noContext = composeReview(
      base({
        severityFloor: 'auto',
        contextUnavailable: true,
        deferredSuggestions: [nit()],
      }),
    );
    expect(noContext.cappedBy).toContain('unlicensed-deferral');
    expect(noContext.body).toContain('context-unavailable');
  });

  it('an unrecognised severityFloor is unknown — never a throw', () => {
    // A model-transcribed drift ("Critical", "auto ", "") on an ordinary
    // zero-deferral round must not lose the WHOLE composed round over a
    // field that changes no output. Unknown folds into the absent state:
    // unlicensed (capped, disclosed) with a list, inert without one.
    // Trimmed/cased spellings of the three legal values still resolve.
    const withList = composeReview(
      base({ severityFloor: 'blocker' as never, deferredSuggestions: [nit()] }),
    );
    expect(withList.cappedBy).toContain('unlicensed-deferral');
    const inert = composeReview(base({ severityFloor: 'blocker' as never }));
    expect(inert.event).toBe('APPROVE');
    expect(inert.cappedBy).toEqual([]);
    const cased = composeReview(
      base({
        severityFloor: ' Critical ' as never,
        deferredSuggestions: [nit()],
      }),
    );
    expect(cased.cappedBy).toEqual([]);
    expect(cased.deferredCount).toBe(1);
  });

  it('auto with a recovered previous round licenses the age-rule deferral', () => {
    // The state carries `auto` unresolved and the module licenses it by the
    // round it derives itself — this pins the legal rounds-2-5 shape end to
    // end (a round-resolved `suggestion` would have been refused as the
    // operator's override — the shipped round-5 regression).
    const planPath = coveredPlan(['verify', 'reverse-audit'], {
      prNumber: 8255,
      fetchedSha: 'deadbeef00112233',
    });
    writeFileSync(
      join(dirname(planPath), 'qwen-review-pr-8255-prev-ledger.json'),
      JSON.stringify({ v: 1, round: 2, findings: [] }),
    );
    const r = composeReview({
      planPath,
      env: ENV,
      modelId: MODEL,
      criticalsInline: 0,
      suggestionsInline: 0,
      severityFloor: 'auto',
      deferredSuggestions: [nit({ title: 'aged-out nit' })],
    });
    expect(r.cappedBy).toEqual([]);
    expect(r.event).toBe('APPROVE');
    expect(r.body).toContain('convergence posture (round 3, not a blocker)');
  });
});

describe("composeReview — the composed body fits GitHub's limit", () => {
  // A POST over 65,536 characters is rejected WHOLE — the review's blockers
  // included — so the body carries its own budget. What it may drop, and in
  // what order, is the policy under test: the deferral display yields first,
  // the not-reviewed disclosures second, the blockers and the caps never.
  const LIMIT = 65536;
  /** An unpaired half in EITHER direction — the oracle was one-sided. */
  const LONE_SURROGATE =
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const countOf = (haystack: string, needle: string): number =>
    haystack.split(needle).length - 1;
  const nit = (i: number): DeferredEntry => ({
    file: `f${i}.ts`,
    line: 1,
    source: 'review',
    severity: 'Suggestion',
    title: 'x'.repeat(200),
  });

  it('leaves a body that fits untouched', () => {
    const r = composeReview(
      base({
        severityFloor: 'critical',
        deferredSuggestions: [nit(1)],
        unreviewedDimensions: ['security'],
      }),
    );
    expect(r.body.length).toBeLessThanOrEqual(LIMIT);
    // Name the notices the module actually emits. The first version of this
    // guard forbade a phrase no code path writes, so it held over a body
    // carrying a spurious trim banner.
    expect(r.body).not.toContain('was trimmed to fit');
    expect(r.body).not.toContain('was dropped to fit');
    expect(r.body).not.toContain('was TRUNCATED to fit');
    expect(r.body).toContain('Deferred under the convergence posture');
    expect(r.bodyTrim).toEqual({
      sections: 0,
      deferralList: false,
      fold: false,
      truncated: false,
    });
  });

  it('trims the deferral display first, discloses the count, and keeps the blockers', () => {
    // The un-trimmable half is huge but legal: unresolved blockers are the
    // one thing a review exists to deliver.
    const blocker = 'B'.repeat(64_300);
    const r = composeReview(
      base({
        severityFloor: 'critical',
        bodyCriticals: [blocker],
        deferredSuggestions: [nit(1), nit(2), nit(3)],
      }),
    );
    expect(r.body.length).toBeLessThanOrEqual(LIMIT);
    // The blocker survives whole; the deferral display is gone, counted.
    expect(r.body).toContain(blocker);
    expect(r.body).not.toContain('Deferred under the convergence posture');
    expect(r.body).toContain('(1 section(s))');
    expect(r.body).toContain('the deferred-findings list did not fit');
    // The operator gets the same fact on stderr, not only the PR page.
    expect(r.remediation.some((line) => line.startsWith('body budget:'))).toBe(
      true,
    );
  });

  it('trims the deferral display ALONE when that is enough — the order is observable', () => {
    // Without this shape the ordering policy has no guard: a mutant that
    // makes the not-reviewed disclosures yield WITH the deferral display
    // (trim 2 → 1) leaves a byte-identical body whenever both must go, so
    // the whole suite passed under it. Here dropping rank 1 alone fits, so
    // rank 2 must survive.
    const blocker = 'B'.repeat(64_200);
    const r = composeReview(
      base({
        severityFloor: 'critical',
        bodyCriticals: [blocker],
        deferredSuggestions: [nit(1), nit(2), nit(3)],
        unreviewedDimensions: ['security'],
      }),
    );
    expect(r.body.length).toBeLessThanOrEqual(LIMIT);
    expect(r.body).toContain(blocker);
    expect(r.body).not.toContain('Deferred under the convergence posture');
    expect(r.body).toContain('Not reviewed: security');
    expect(r.body).toContain('(1 section(s))');
    expect(r.body).toContain('the deferred-findings list did not fit');
    // The rank-drop exit's one sentence naming the loss non-blocking: the
    // cut path asserts its ABSENCE, and with no positive arm the clause
    // could be deleted from `trimNote` with the whole suite green.
    expect(r.body).toContain('Nothing blocking was trimmed.');
    expect(r.bodyTrim).toEqual({
      sections: 1,
      deferralList: true,
      fold: false,
      truncated: false,
    });
    // This plan is monolingual, so nothing may claim a translation was
    // dropped — the body channel of the `hadFold` guarantee, which had no
    // oracle at all.
    expect(r.body).not.toContain(
      'Chinese translation of this body was dropped',
    );
    // The verdict line must not claim a list the body does not carry —
    // and its second half is the only pointer the author gets to where the
    // list survived, so it is pinned whole, like every sibling verdict
    // string in this file.
    expect(verdictLine(r)).toContain(
      '3 non-Critical finding(s) deferred under the convergence posture ' +
        '(trimmed from the body to fit GitHub’s limit — whole in the ' +
        'findings artifact)',
    );
    expect(verdictLine(r)).not.toContain('listed in the body');
  });

  it('trims the not-reviewed disclosures only after the deferral display', () => {
    const blocker = 'B'.repeat(63_000);
    const r = composeReview(
      base({
        severityFloor: 'critical',
        bodyCriticals: [blocker],
        deferredSuggestions: [nit(1), nit(2), nit(3)],
        unreviewedDimensions: [`security — ${'D'.repeat(3_000)}`],
      }),
    );
    expect(r.body.length).toBeLessThanOrEqual(LIMIT);
    expect(r.body).toContain(blocker);
    expect(r.body).not.toContain('Deferred under the convergence posture');
    expect(r.body).not.toContain('Not reviewed:');
    expect(r.body).toContain('(2 section(s))');
    expect(r.body).toContain(
      'the deferred-findings list and the not-reviewed and non-blocking disclosures did not fit',
    );
    expect(r.bodyTrim.sections).toBe(2);
  });

  it('truncates as a last resort rather than composing a body GitHub rejects', () => {
    // Blockers alone past the limit: they are un-trimmable by policy, so the
    // body is cut — English-only, so the bilingual fold cannot be left
    // unbalanced — and says so. Posting a truncated review beats posting
    // none, which is what a 422 would leave.
    const r = composeReview(
      base({
        planPath: coveredPlan(['verify', 'reverse-audit'], { han: true }),
        bodyCriticals: ['C'.repeat(80_000)],
      }),
    );
    expect(r.body.length).toBeLessThanOrEqual(LIMIT);
    expect(r.body).toContain('was TRUNCATED to fit');
    expect(r.body).toContain(FOOTER);
    // Rung 3 renders English only, so the posted body carries NO fold
    // markup at all — the earlier `open === close` form compared 0 to 0 on
    // this fixture and passed under a mutant that appended a bare opener.
    expect(countOf(r.body, '<details>')).toBe(0);
    expect(countOf(r.body, '</details>')).toBe(0);
    // Two-sided: the cut can only orphan a high surrogate, but an oracle
    // that looks for one direction cannot report a regression that produces
    // the other.
    expect(LONE_SURROGATE.test(r.body)).toBe(false);
    // The rung-3 notice guard (`droppedRanks.length > 0`) had no oracle:
    // deleting it rode a keep:1 "did not fit (0 section(s))" notice above
    // the cut of EVERY rank-less truncation — empty subject, zero count.
    // No rank was dropped here, so no trim notice may ride at all.
    expect(r.body).not.toContain('was trimmed to fit');
    // This exit owes its own stderr line; no other push carries the
    // sentence, and deleting it left the suite green.
    expect(r.remediation.join('\n')).toContain(
      'so the posted body is truncated',
    );
  });

  it('bounds the footer the last-resort tail carries — an unbounded modelId must not post a body GitHub rejects', () => {
    // The protected tail — truncation notice plus footer — is the one
    // rung-3 contributor the budget never measured, and the footer
    // interpolates modelId verbatim with no length cap: a single-line
    // modelId past the budget empties the cut and the rung returns the
    // tail itself, OVER budget — the POST GitHub rejects whole, blockers
    // included, which is the exact failure the budget exists to prevent.
    const r = composeReview(
      base({
        modelId: 'M'.repeat(70_000),
        bodyCriticals: ['C'.repeat(80_000)],
      }),
    );
    expect(r.body.length).toBeLessThanOrEqual(LIMIT);
    expect(r.body).toContain('was TRUNCATED to fit');
    // A bounded footer leaves the blockers the room the budget holds: the
    // cut keeps most of them instead of posting tail-only.
    expect(r.body).toContain('C'.repeat(50_000));
    // A silently truncated attribution names a model that is not the one
    // that ran, so the clamp is disclosed on the operator's channel.
    expect(r.remediation.join('\n')).toContain('modelId');
  });

  it('a below-rejection oversized modelId must not empty the cut of every blocker', () => {
    // Under the rejection boundary the same hole was quieter: the 56k
    // tail alone fit, the POST succeeded — and carried almost nothing but
    // itself, every blocker dropped although the budget had room for
    // almost all of them. A bounded footer fits the blocker and the
    // attribution together, no cut at all.
    const r = composeReview(
      base({
        modelId: 'M'.repeat(56_000),
        bodyCriticals: ['C'.repeat(60_000)],
      }),
    );
    expect(r.body.length).toBeLessThanOrEqual(LIMIT);
    expect(r.body).toContain('C'.repeat(50_000));
    expect(r.body).toContain('via Qwen Code /review');
  });

  it('bounds the footer the last-resort tail carries — an unbounded version must not post a body GitHub rejects', () => {
    // The footer interpolates a second input — the CLI version — and both
    // of its sources are wrapper-reachable: `footerVersion` checks the
    // startup stamp's charset but not its length, and `getCliVersion`
    // returns `CLI_VERSION` unchecked. A version-shaped string past the
    // budget empties the rung-3 cut exactly like the modelId hole the two
    // tests above pin — and the quieter below-rejection shape fits with
    // every blocker dropped. One cap, on the interpolation both sources
    // meet, closes both.
    const r = composeReview(
      base({
        bodyCriticals: ['C'.repeat(80_000)],
      }),
      'v'.repeat(70_000),
    );
    expect(r.body.length).toBeLessThanOrEqual(LIMIT);
    expect(r.body).toContain('was TRUNCATED to fit');
    expect(r.body).toContain('C'.repeat(50_000));
    expect(r.body).toContain('via Qwen Code /review');
    // A silently truncated stamp names a release that is not the one that
    // ran, so the clamp is disclosed on the operator's channel like the
    // modelId clamp beside it.
    expect(r.remediation.join('\n')).toContain('cliVersion');
  });

  it('keeps the downgrade disclosure through the COMMENT opener merge', () => {
    // The COMMENT path merges clauses 1-4 into one paragraph. The merge
    // copied only `en`/`zh`, so every `keep` tag on those clauses was lost
    // and the merged opener — carrying the downgrade disclosure — became the
    // FIRST thing the tail cut spent: a posted Critical with no disclosure
    // that the verdict had been downgraded.
    const r = composeReview({
      planPath: coveredPlan(['verify', 'reverse-audit']),
      env: ENV,
      modelId: MODEL,
      criticalsInline: 1,
      suggestionsInline: 1,
      bodyCriticals: ['C'.repeat(70_000)],
      presubmit: {
        downgradeRequestChanges: true,
        downgradeReasons: ['CI failing'],
      },
    });
    expect(r.event).toBe('COMMENT');
    expect(r.body.length).toBeLessThanOrEqual(LIMIT);
    expect(r.body).toContain('Downgraded from Request changes');
  });

  it('never cuts a surrogate pair when it truncates', () => {
    // The ASCII truncation case could not fail this guard: every cut landed
    // on a single code unit. An astral-plane blocker (CJK Extension B here,
    // as real as an emoji in a quoted log line) puts a surrogate pair on the
    // boundary, where removing the guard leaves a lone high surrogate in the
    // posted body.
    // A BAND of pairs, not one boundary: calibrating the fixture to the
    // exact cut position made the oracle depend on four remote constants,
    // and a three-character change to the protected tail moved the cut
    // clear of every pair — after which the guard could be deleted green.
    // Anywhere in this band, the cut lands inside a pair.
    const r = composeReview(
      base({
        bodyCriticals: [
          'A'.repeat(40_000) + '\u{20000}'.repeat(20_000) + 'B'.repeat(20_000),
        ],
      }),
    );
    expect(r.body.length).toBeLessThanOrEqual(LIMIT);
    expect(r.body).toContain('was TRUNCATED to fit');
    expect(LONE_SURROGATE.test(r.body)).toBe(false);
    expect(r.body.includes('\uFFFD')).toBe(false);
    // And no over-strip: every astral character BEFORE the boundary
    // survives the cut whole. A widened loop that stripped complete pairs
    // and unpaired lows alike spent the entire band with every test green.
    expect(r.body.includes('\u{20000}')).toBe(true);
    expect(r.bodyTrim.truncated).toBe(true);
    // The truncation exit owes its own stderr line, and no other push
    // carries this sentence.
    expect(r.remediation.join('\n')).toContain(
      'so the posted body is truncated',
    );
  });

  it('leaves an unpaired low surrogate at the cut exactly as the author wrote it', () => {
    // The strip loop owes HIGH halves only: a prefix cut can only orphan a
    // high. A low at the boundary was already unpaired in the author's
    // text — rewriting it is not balancing, it is spending the author's
    // bytes. No fixture carried a low, so widening the strip to both
    // halves shipped green while it deleted every astral character back to
    // the last BMP one.
    const r = composeReview(
      base({
        bodyCriticals: ['A'.repeat(60_000) + '\uDC00'.repeat(20_000)],
      }),
    );
    expect(r.body.length).toBeLessThanOrEqual(LIMIT);
    expect(r.bodyTrim.truncated).toBe(true);
    // The truncation notice rides at the TOP now, so the cut's junction is
    // the footer boundary at the end.
    const junction = r.body.lastIndexOf(`\n\n${FOOTER}`);
    expect(junction).toBeGreaterThan(0);
    // The cut landed inside the low band and handed one straight to the
    // tail: nothing stripped it.
    expect(r.body.charAt(junction - 1)).toBe('\uDC00');
  });

  it('clears a run of lone high surrogates the cut exposes', () => {
    // One pass was not enough: quoted model text can already carry an
    // unpaired high, and a cut inside the astral pair that follows it leaves
    // TWO halves — removing one still posts invalid UTF-16.
    // A band again, so no exact cut position is assumed. The band is full
    // of PRE-EXISTING lone highs — the author's own bytes, which this code
    // must not rewrite — so the oracle is the junction, not the whole body:
    // whatever the cut ends on, the character handed to the tail must not
    // be an unpaired half.
    const r = composeReview(
      base({
        // A solid RUN of unpaired highs spanning the cut: wherever the cut
        // lands inside it, one strip leaves another half, so a single-pass
        // guard cannot pass. The alternating band did not force that —
        // two cut positions in three were clean after one strip.
        bodyCriticals: ['A'.repeat(60_000) + '\uD800'.repeat(20_000)],
      }),
    );
    expect(r.body.length).toBeLessThanOrEqual(LIMIT);
    expect(r.bodyTrim.truncated).toBe(true);
    const junction = r.body.lastIndexOf(`\n\n${FOOTER}`);
    expect(junction).toBeGreaterThan(0);
    // The cut can only orphan a HIGH half, so that is the whole invariant:
    // the last character it hands to the tail must not be one.
    expect(/[\uD800-\uDBFF]/.test(r.body.charAt(junction - 1))).toBe(false);
  });

  it("spends the copy the author already has before this round's only copy", () => {
    // Both are blocker-grade, so the cut has to choose. The undecided list
    // was DELIVERED to the author in the round that raised it; this round's
    // body Criticals exist nowhere the author can reach. So the undecided
    // list goes first — and the notice stops claiming nothing blocking was
    // trimmed, which is what was actually wrong when this shape first came
    // up. Tying the two at `keep: 2` inverted the loss instead of fixing
    // the claim.
    const r = composeReview(
      base({
        severityFloor: 'critical',
        bodyCriticals: ['C'.repeat(70_000)],
        cannotTellCriticals: ['ZZZ old blocker — still unresolved'],
        deferredSuggestions: [nit(1), nit(2)],
        unreviewedDimensions: ['security — gap'],
      }),
    );
    expect(r.body.length).toBeLessThanOrEqual(LIMIT);
    expect(r.bodyTrim.truncated).toBe(true);
    expect(r.body).toContain('C'.repeat(50_000));
    expect(r.body).not.toContain('ZZZ old blocker');
    expect(r.body).not.toContain('Nothing blocking was trimmed');
    expect(r.body).toContain('was TRUNCATED to fit');
    // The trim notice is `keep: 1` and must survive the cut that spent
    // everything below it — without it the rank drops are disclosed
    // nowhere in the posted body.
    expect(r.body).toContain(
      'the deferred-findings list and the not-reviewed and non-blocking disclosures did not fit',
    );
    // The truncation exit dropped ranks on its way here, and owes the same
    // stderr line the rank loop pushes — a record naming only the cut
    // leaves the kinds it dropped disclosed nowhere but the body.
    expect(r.remediation.join('\n')).toContain(
      'repeat the trimmed sections in your terminal summary',
    );
  });

  it('drops the bilingual fold BEFORE it drops any content', () => {
    // The fold is a translation of the English above it: dropping it costs
    // the author nothing the body does not still say, where every other rung
    // costs a finding or a disclosure. Measured against a bilingual body,
    // this shape used to spend the whole deferral list with ~24,000
    // characters of headroom sitting behind the fold.
    const r = composeReview({
      planPath: coveredPlan(['verify', 'reverse-audit'], { han: true }),
      env: ENV,
      modelId: MODEL,
      criticalsInline: 0,
      suggestionsInline: 0,
      severityFloor: 'critical',
      bodyCriticals: ['C'.repeat(40_000)],
      deferredSuggestions: [nit(1), nit(2)],
      unreviewedDimensions: ['security — gap'],
    });
    expect(r.body.length).toBeLessThanOrEqual(LIMIT);
    expect(r.bodyTrim).toEqual({
      sections: 0,
      deferralList: false,
      fold: true,
      truncated: false,
    });
    // Everything content-bearing survives.
    expect(r.body).toContain('Deferred under the convergence posture');
    expect(r.body).toContain('Not reviewed: security');
    expect(r.body).not.toContain('<details>');
    expect(r.body.startsWith('⚠️ The Chinese translation')).toBe(true);
    // The zero-rank arm of the fold notice and of its stderr line: no trim
    // notice exists, so neither may point at one.
    expect(r.body).not.toContain('apart from the sections');
    const budgetLines = r.remediation.filter((l) =>
      l.startsWith('body budget:'),
    );
    expect(budgetLines).toEqual([
      "body budget: the bilingual fold was dropped to fit GitHub's " +
        '65536-character review limit — the English body is complete',
    ]);
  });

  it('drops sections only after the fold, and says so in both channels', () => {
    // English-only still overflows here, so rung 2 runs — and both exits owe
    // their own stderr line: the rank-naming one and the fold one. Deleting
    // either used to leave the whole suite green.
    const r = composeReview({
      planPath: coveredPlan(['verify', 'reverse-audit'], { han: true }),
      env: ENV,
      modelId: MODEL,
      criticalsInline: 0,
      suggestionsInline: 0,
      severityFloor: 'critical',
      bodyCriticals: ['C'.repeat(64400)],
      deferredSuggestions: [nit(1), nit(2)],
      unreviewedDimensions: ['security — gap'],
    });
    expect(r.body.length).toBeLessThanOrEqual(LIMIT);
    expect(r.bodyTrim.truncated).toBe(false);
    expect(r.bodyTrim.fold).toBe(true);
    expect(r.bodyTrim.sections).toBeGreaterThan(0);
    expect(r.bodyTrim.deferralList).toBe(true);
    // Both notices ride at the TOP, fold first, and each describes what the
    // other left: appended at the bottom the fold notice sat 64,000
    // characters below the body it qualifies.
    expect(r.body.startsWith('⚠️ The Chinese translation')).toBe(true);
    expect(r.body).toContain('apart from the sections the notice below names');
    expect(r.body.indexOf('The Chinese translation')).toBeLessThan(
      r.body.indexOf('This body was trimmed to fit'),
    );
    const budgetLines = r.remediation.filter((l) =>
      l.startsWith('body budget:'),
    );
    expect(budgetLines).toHaveLength(2);
    expect(budgetLines[0]).toContain(
      'repeat the trimmed sections in your terminal summary',
    );
    expect(budgetLines[1]).toContain(
      'the English body is complete apart from the trimmed sections',
    );
  });

  it('a truncated bilingual body discloses its fold too, and calls nothing complete', () => {
    // The reorder put the fold-drop record on the way INTO the cut, where
    // it recorded `fold: true` and pushed "the English body is complete" —
    // on a body cut mid-blocker, whose text disclosed no fold at all. The
    // stderr line is persisted, so that was a durable false record.
    const r = composeReview({
      planPath: coveredPlan(['verify', 'reverse-audit'], { han: true }),
      env: ENV,
      modelId: MODEL,
      criticalsInline: 0,
      suggestionsInline: 0,
      severityFloor: 'critical',
      bodyCriticals: ['C'.repeat(70_000)],
      deferredSuggestions: [nit(1), nit(2)],
      unreviewedDimensions: ['security — gap'],
    });
    expect(r.body.length).toBeLessThanOrEqual(LIMIT);
    expect(r.bodyTrim.fold).toBe(true);
    expect(r.bodyTrim.truncated).toBe(true);
    // Disclosed in the body, at the top, and honest about the cut. On a
    // truncated body the truncation notice leads and the fold notice
    // follows it — both above the text they qualify.
    expect(r.body.startsWith('⚠️ This review body was TRUNCATED')).toBe(true);
    expect(r.body.indexOf('This review body was TRUNCATED')).toBeLessThan(
      r.body.indexOf('The Chinese translation'),
    );
    // …and the sentence must point where the notice actually rides: the
    // truncation notice leads the body now, so "at the end" named a spot
    // no rung composes a notice at. The prefix-only pin shipped that green.
    expect(r.body).toContain(
      'the English text below is truncated as well — see the notice above',
    );
    expect(r.body).not.toContain('see the notice at the end');
    expect(r.body).toContain('was TRUNCATED to fit');
    const budget = r.remediation
      .filter((l) => l.startsWith('body budget:'))
      .join('\n');
    expect(budget).toContain('the English body is truncated as well');
    expect(budget).not.toContain('the English body is complete');
  });

  it('does not reorder a body it never cuts', () => {
    // The `keep` sort exists to steer a CUT. Running it on the fold-only
    // exit reordered a body that survives whole, filing "Unresolved, please
    // confirm" as a footnote to the 40,000-character blocker above it.
    // The unlicensed-deferral disclosure is `keep: 1` and is composed AFTER
    // the undecided-blocker block (`keep: 2`) — the one pair whose natural
    // order the sort visibly inverts. Without such a pair every fixture
    // reads the same sorted or not, which is how the first version of this
    // test passed under the very mutation it was written to catch.
    const r = composeReview({
      planPath: coveredPlan(['verify', 'reverse-audit'], { han: true }),
      env: ENV,
      modelId: MODEL,
      criticalsInline: 0,
      suggestionsInline: 1,
      deferredSuggestions: [nit(1)],
      bodyCriticals: ['C'.repeat(40_000)],
      cannotTellCriticals: ['old blocker — still unresolved'],
    });
    expect(r.bodyTrim.truncated).toBe(false);
    // This must be the fold-only exit: it is the branch under test.
    expect(r.body).toContain('Chinese translation of this body was dropped');
    const undecided = r.body.indexOf('old blocker — still unresolved');
    const unlicensed = r.body.indexOf('deferred without a posture licence');
    expect(undecided).toBeGreaterThan(-1);
    expect(unlicensed).toBeGreaterThan(undecided);
  });

  it('counts the sections it dropped, not the ranks', () => {
    // One rank can carry four `Not reviewed:` paragraphs. Counting ranks
    // reported "(2 section(s))" over five dropped ones — and persisted that
    // number into the artifact.
    const dims = ['security', 'perf', 'a11y', 'i18n'].map(
      (d, i) => `${d} — ${'D'.repeat(700)}${i}`,
    );
    const r = composeReview(
      base({
        severityFloor: 'critical',
        bodyCriticals: ['B'.repeat(62_000)],
        deferredSuggestions: [nit(1), nit(2), nit(3)],
        unreviewedDimensions: dims,
      }),
    );
    expect(r.body.length).toBeLessThanOrEqual(LIMIT);
    expect(r.bodyTrim.sections).toBe(5);
    expect(r.body).toContain('(5 section(s))');
  });

  it('points at the findings artifact only when the deferral list is what went', () => {
    // Rank 2 drops alone on any run with disclosures and no posture
    // deferrals. The unconditional pointer then told the author to read
    // "deferred findings in this run's findings artifact" — of which there
    // are none. The sibling stderr line had the condition all along.
    const dims = ['security', 'perf', 'a11y', 'i18n'].map(
      (d, i) => `${d} — ${'D'.repeat(700)}${i}`,
    );
    const r = composeReview(
      base({
        bodyCriticals: ['B'.repeat(64_000)],
        unreviewedDimensions: dims,
      }),
    );
    expect(r.body.length).toBeLessThanOrEqual(LIMIT);
    expect(r.deferredCount).toBe(0);
    expect(r.bodyTrim.deferralList).toBe(false);
    expect(r.bodyTrim.sections).toBeGreaterThan(0);
    expect(r.body).toContain('did not fit');
    expect(r.body).toContain('read them in the terminal report.');
    expect(r.body).not.toContain('findings artifact');
    // The stderr twin carries the same condition and had no oracle: an
    // operator sent to a list that does not exist is the same false record
    // in the channel the operator actually reads.
    expect(r.remediation.join('\n')).not.toContain('findings artifact');
  });

  it('keeps the verdict-qualifying opener through a truncation', () => {
    // R2-3's shape: the COMMENT merge takes the strongest `keep` among the
    // clauses it merges, and those clauses had none — so the merged opener
    // defaulted to the weakest rank and the tail cut spent the sentences
    // that qualify the verdict before it spent a single blocker.
    //
    // The cap here is the absent verifier, which still POSTS the blockers
    // (clause 7 rides on `criticalsUnverified`); the findings-file tag route
    // caps without that flag, so its body carries no blocker and cannot
    // reach the cut at all.
    const r = composeReview({
      planPath: coveredPlan(['reverse-audit']),
      env: ENV,
      modelId: MODEL,
      criticalsInline: 0,
      suggestionsInline: 0,
      // Model-written blocker prose: the cannot-tell account is capped per
      // entry upstream of the budget now, so it can no longer overflow.
      bodyCriticals: ['Z'.repeat(70_000)],
    });
    expect(r.event).toBe('COMMENT');
    expect(r.body.length).toBeLessThanOrEqual(LIMIT);
    expect(r.bodyTrim.truncated).toBe(true);
    expect(r.body).toContain('Partially reviewed — gaps disclosed.');
    expect(r.body).toContain('**[Critical]** ');
  });

  it('the unlicensed-deferral disclosure promises no adjacency it cannot keep', () => {
    // The dangerous shape: the disclosure survives (`keep: 1`) while the
    // list it refers to is dropped as rank 1. Its old wording — "They are
    // listed below" — was then false by its own content. Locating the block
    // by a substring both wordings share left that sentence free to return,
    // so the wording itself is pinned here.
    const r = composeReview(
      base({
        bodyCriticals: ['B'.repeat(64_300)],
        deferredSuggestions: [nit(1), nit(2), nit(3)],
      }),
    );
    expect(r.body.length).toBeLessThanOrEqual(LIMIT);
    expect(r.body).not.toContain('Deferred under the convergence posture');
    expect(r.body).toContain('deferred without a posture licence');
    expect(r.body).toContain(
      'They are listed in this body when it has room for them, and always ' +
        "in the terminal report and this run's findings artifact",
    );
    expect(r.body).not.toContain('They are listed below');
  });

  it('sees no swallow when an opener sits inside a quoted attribute', () => {
    // `onerror="<script>"` never opens a script element: the phantom
    // swallow spent the whole cut in the fail-closed direction, dropping
    // every blocker over an opener that does not exist.
    const attrOpener =
      'add <img onerror="<script>"> guard ' + 'K'.repeat(70_000);
    const r = composeReview(base({ bodyCriticals: [attrOpener] }));
    expect(r.body.length).toBeLessThanOrEqual(LIMIT);
    expect(r.bodyTrim.truncated).toBe(true);
    expect(r.body).toContain('K'.repeat(1_000));
    expect(r.body).toContain('was TRUNCATED to fit');
  });

  it('keeps the context-unavailable trust warning through a truncation', () => {
    // `contextUnavailableClause` is `keep: 1` so the rung-3 cut spends
    // blockers before the diff-only trust warning; no truncation fixture
    // carried the clause, so deleting the tag shipped green — the untagged
    // clause sorted to rank 3 and the cut spent the warning first.
    const r = composeReview(
      base({
        criticalsInline: 1,
        contextUnavailable: true,
        bodyCriticals: ['B'.repeat(70_000)],
      }),
    );
    expect(r.event).toBe('REQUEST_CHANGES');
    expect(r.bodyTrim.truncated).toBe(true);
    expect(r.body).toContain('Reviewed diff-only');
  });

  it('keeps the unlicensed-deferral disclosure through a rung-3 cut', () => {
    // Same family: the disclosure's `keep: 1` had no oracle through a real
    // cut — deleting the tag shipped green while the cut spent the only
    // posted copy of the under-posting warning.
    const r = composeReview(
      base({
        criticalsInline: 1,
        bodyCriticals: ['B'.repeat(70_000)],
        deferredSuggestions: [nit(1)],
      }),
    );
    expect(r.bodyTrim.truncated).toBe(true);
    expect(r.body).toContain('deferred without a posture licence');
  });

  it('ranks the plan-gate disclosures with the not-reviewed ones, not with the deferral list', () => {
    // `deferredBlock`, `testPlanBlock` and `repositoryContextBlock` all
    // carry `trim: 2`, and no overflow fixture carried any of them — so
    // both mutations shipped green: `2 → 1` drops the disclosure WITH the
    // deferral display (inverting the documented order), and deleting the
    // tag makes it un-trimmable, sending a borderline body to the cut.
    const withContext = (blocker: string) =>
      composeReview({
        planPath: coveredPlan(['verify', 'reverse-audit'], {
          repositoryContext: {
            version: 1,
            provider: 'test',
            label: 'guard',
            domains: ['modeled-executable-system'],
            relatedPaths: [],
            recommendedTests: [],
            requiredConfigurations: [],
            requiredAgents: [],
            unverifiedDimensions: ['crypto-boundary', 'ffi-boundary'],
            verificationNotes: [],
          },
        }),
        env: ENV,
        modelId: MODEL,
        criticalsInline: 0,
        suggestionsInline: 0,
        severityFloor: 'critical',
        bodyCriticals: [blocker],
        deferredSuggestions: [nit(1), nit(2), nit(3)],
      });

    // Self-calibrating rather than pinned to a byte size: scan a range and
    // require BOTH shapes to exist. `trim: 2 → 1` removes the first (the
    // block would go with the deferral display); deleting the tag removes
    // the second (the block would never yield).
    // Fine-grained on purpose: the rank-1-only window is as wide as the
    // deferral display itself (~750 chars), so a coarse scan steps over the
    // shape that proves the ranks are distinct.
    const runs = Array.from({ length: 61 }, (_, i) => 50_000 + i * 250).map(
      (n) => withContext('B'.repeat(n)),
    );
    const survivesRank1 = runs.find(
      (r) =>
        r.bodyTrim.deferralList &&
        !r.bodyTrim.truncated &&
        r.body.includes('Repository proof boundary'),
    );
    const goesWithRank2 = runs.find(
      (r) =>
        r.bodyTrim.deferralList &&
        !r.body.includes('Repository proof boundary'),
    );
    // The fixture must actually emit the block, or the test proves nothing.
    expect(runs[0].bodyTrim.sections).toBe(0);
    expect(runs[0].body).toContain('Repository proof boundary');
    expect(survivesRank1).toBeDefined();
    expect(goesWithRank2).toBeDefined();
    expect(goesWithRank2!.bodyTrim.sections).toBeGreaterThan(
      survivesRank1!.bodyTrim.sections,
    );
  });

  it('puts the truncation notice ABOVE the cut, where nothing can swallow it', () => {
    // This placement is what makes the last resort bounded. A notice BELOW
    // the cut has to survive whatever the cut left open — an unclosed
    // fence, a raw HTML block, a comment — and deciding that means
    // modelling the page the author reads. Three hand models each shipped a
    // new class of divergence. Above the cut, the question never arises:
    // the notice is the first thing in the body, and the most an open
    // construct can still absorb is the footer's attribution line.
    const fenced = '```ts\n' + 'const x = 1;\n'.repeat(6_000);
    const r = composeReview(base({ bodyCriticals: [fenced] }));
    expect(r.body.length).toBeLessThanOrEqual(LIMIT);
    expect(r.bodyTrim.truncated).toBe(true);
    expect(r.body.startsWith('⚠️ This review body was TRUNCATED')).toBe(true);
    // Nothing after the cut carries a disclosure, so an unbalanced fence
    // costs the reader nothing the review needed to say.
    expect(r.body.indexOf('was TRUNCATED to fit')).toBeLessThan(
      r.body.indexOf('```'),
    );
  });

  it('keeps the blocker under an absurd modelId — the footer is bounded', () => {
    // The footer interpolates caller text, and interpolated whole it
    // emptied the cut: the body posted tail-only, past the limit, losing
    // every blocker. The cap in `reviewFooter` is what bounds it, and this
    // is the shape that proves the budget can rely on that.
    const r = composeReview(
      base({ modelId: 'm'.repeat(60_000), bodyCriticals: ['C'.repeat(1_000)] }),
      '0.21.2',
    );
    expect(r.body.length).toBeLessThanOrEqual(LIMIT);
    expect(r.body).toContain('**[Critical]** ');
    expect(r.body).toContain('C'.repeat(1_000));
  });

  it('holds room for the ledger marker, so the POSTED body still fits', () => {
    // The marker is appended after the body composes, so the budget reserves
    // its cap — measured on the value `submit` actually posts.
    const planPath = coveredPlan(['verify', 'reverse-audit'], {
      prNumber: 8255,
      fetchedSha: 'deadbeef00112233',
    });
    const r = composeReview({
      planPath,
      env: ENV,
      modelId: MODEL,
      criticalsInline: 0,
      suggestionsInline: 0,
      bodyCriticals: Array.from(
        { length: 40 },
        (_, i) => `blocker ${i}: ${'B'.repeat(1_500)}`,
      ),
    });
    expect(r.body).toContain('<!-- qwen-review-ledger ');
    expect(r.body.length).toBeLessThanOrEqual(LIMIT);
    // Presence is not enough: this fixture truncates, and a marker moved
    // inside the content the cut measures would be sliced — the prefix
    // still matches `toContain` while the next round's `parseLedger`
    // returns null and the whole cross-round work list is lost.
    expect(r.bodyTrim.truncated).toBe(true);
    expect(parseLedger(r.body)).not.toBeNull();
  });

  it('measures the rung-2 exit against the RESERVED budget, not the raw limit', () => {
    // Every other rank-dropping fixture uses a PR-less plan, where the
    // reserve is 0. A PR-named body whose post-rank-drop size lands in the
    // reserve window (reserved budget < body ≤ unreserved budget) must
    // fall through to the rung-3 CUT: measured against the UNRESERVED
    // budget it would exit rung 2 whole at up to 65,024 chars, the marker
    // would ride on top, and the POST 422s — losing the review this whole
    // file exists to deliver. (The original sizing here sat BELOW the
    // reserved budget after its rank drop and exited rung 2 identically
    // under that mutation — it caught nothing.)
    const planPath = coveredPlan(['verify', 'reverse-audit'], {
      prNumber: 8255,
      fetchedSha: 'deadbeef00112233',
    });
    const r = composeReview({
      planPath,
      env: ENV,
      modelId: MODEL,
      criticalsInline: 0,
      suggestionsInline: 0,
      severityFloor: 'critical',
      bodyCriticals: ['B'.repeat(59_600)],
      unreviewedDimensions: [
        `security — ${'D'.repeat(3_000)}`,
        `perf — ${'D'.repeat(3_000)}`,
        `a11y — ${'D'.repeat(3_000)}`,
        `i18n — ${'D'.repeat(3_000)}`,
      ],
    });
    expect(r.bodyTrim.sections).toBe(4);
    expect(r.bodyTrim.deferralList).toBe(false);
    expect(r.bodyTrim.truncated).toBe(true);
    expect(r.body).toContain('<!-- qwen-review-ledger ');
    expect(parseLedger(r.body)).not.toBeNull();
    expect(r.body.length).toBeLessThanOrEqual(LIMIT);
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
    expect(r.body).toContain(
      'Review incomplete — unverified findings disclosed.',
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
    expect(r.body).toContain('Review incomplete — findings unavailable.');
    expect(r.body).not.toContain('unverified findings disclosed');
    expect(r.remediation.join(' ')).toContain('findingsPath');
  });

  it('refuses a present findingsPath of the wrong shape', () => {
    expect(() =>
      composeReview(base({ findingsPath: 42 as unknown as string })),
    ).toThrow(/findingsPath must be a non-empty string/);
  });
});

/**
 * #8388's posted body ran 31 unresolved existing Criticals and seven
 * disclosures together in one space-joined paragraph, each entry restating
 * the same reason, every comment id a bare number, and the Chinese fold
 * duplicating the whole untranslated wall. These pin the readable shape:
 * paragraphs, a Markdown list, one reason per group, anchored ids.
 */
describe('composeReview — unresolved-Critical rendering (#8388 readability)', () => {
  // The github.com anchor assertions ride the effective-host chain's
  // default; an exported GH_HOST must not leak in — save/delete/restore
  // it, as every sibling suite whose assertions read the host does.
  let savedGhHost: string | undefined;
  beforeEach(() => {
    savedGhHost = process.env['GH_HOST'];
    delete process.env['GH_HOST'];
  });
  afterEach(() => {
    if (savedGhHost !== undefined) {
      process.env['GH_HOST'] = savedGhHost;
    } else delete process.env['GH_HOST'];
  });

  it('renders the cannot-tell entries as a Markdown list in its own paragraph', () => {
    const r = composeReview(
      base({
        suggestionsInline: 1,
        cannotTellCriticals: [
          'a.ts:1 — full text unfetchable',
          'b.ts:2 — quarantined by the harness',
        ],
      }),
    );
    expect(r.event).toBe('COMMENT');
    // Opener sentences stay one paragraph; the block opens its own.
    expect(r.body).toContain(
      'Reviewed. Suggestions are inline.\n\nUnresolved, please confirm:\n\n',
    );
    expect(r.body).toContain(
      '\n- **[Critical]** a.ts:1 — full text unfetchable',
    );
    expect(r.body).toContain(
      '\n- **[Critical]** b.ts:2 — quarantined by the harness',
    );
  });

  it('bounds a one-line entry the way the deferred channel does — the body must not die at the 65,536 limit', () => {
    // Same incident shape the duplicate-drop bound exists for: one ~70 KB
    // one-line entry — nothing for a `\n` collapser to catch — composes a
    // body past GitHub's 65,536-char limit, and `submit` posts
    // all-or-nothing. The entry still renders, trimmed and ellipsized —
    // nothing is dropped, the full entry lives in the run's state.
    const r = composeReview(
      base({
        cannotTellCriticals: [`subject ${'y'.repeat(70_000)} — reason`],
      }),
    );
    expect(r.event).toBe('COMMENT');
    expect(r.cappedBy).toContain('cannot-tell-existing-critical');
    expect(r.body.length).toBeLessThan(65_536);
    expect(r.body).toContain('Unresolved, please confirm:');
    expect(r.body).toContain('subject y');
    expect(r.body).toContain('…');
  });

  it('collapses entries sharing the exact reason into one group that says it once', () => {
    const r = composeReview(
      base({
        cannotTellCriticals: [
          'comment one (a.ts) — body truncated; status undetermined',
          'unique.ts:9 — full text unfetchable',
          'comment two (b.ts) — body truncated; status undetermined',
        ],
      }),
    );
    expect(r.body).toContain(
      '- **[Critical]** 2 entries — body truncated; status undetermined:\n' +
        '  - comment one (a.ts)\n' +
        '  - comment two (b.ts)',
    );
    // The shared reason renders once, not per entry …
    expect(r.body.match(/body truncated; status undetermined/g)).toHaveLength(
      1,
    );
    // … and the odd one out keeps its own full line, nothing dropped.
    expect(r.body).toContain(
      '- **[Critical]** unique.ts:9 — full text unfetchable',
    );
  });

  it('links bare comment ids to their GitHub anchors when the plan names the PR', () => {
    const r = composeReview({
      cannotTellCriticals: [
        'comment 3733696855 (capture-tui.test.ts, R10-1) — body truncated',
        'issue-level comment 5199834809 (author review) — body truncated',
      ],
      planPath: coveredPlan(undefined, {
        ownerRepo: 'QwenLM/qwen-code',
        prNumber: '8388',
      }),
      env: ENV,
      modelId: MODEL,
    });
    expect(r.body).toContain(
      '[comment 3733696855](https://github.com/QwenLM/qwen-code/pull/8388#discussion_r3733696855)',
    );
    expect(r.body).toContain(
      '[issue-level comment 5199834809](https://github.com/QwenLM/qwen-code/pull/8388#issuecomment-5199834809)',
    );
  });

  it('leaves comment ids bare when the plan names no PR', () => {
    const r = composeReview(
      base({
        cannotTellCriticals: ['comment 3733696855 (a.ts) — body truncated'],
      }),
    );
    expect(r.body).toContain(
      '- **[Critical]** comment 3733696855 (a.ts) — body truncated',
    );
    expect(r.body).not.toContain('discussion_r');
  });

  it('a budget gap that says "(none …)" is completion, not a gap — dropped', () => {
    // #8388's body: `Not explored to full depth …: chunk 2: (none — all
    // planned checks completed)` — the agent reported finishing, and the
    // disclosure contradicted it.
    transcript('a1', goodPrompt(1), {
      toolCalls: 3,
      range: [0, 100],
      text:
        'No issues found — walked chunk 1 fully.\n' +
        'Budget gap: (none — all planned checks completed)',
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
      planPath: p,
      env: ENV,
      modelId: MODEL,
    });
    expect(r.body).not.toContain('Not explored to full depth');
    expect(r.event).toBe('APPROVE');
    expect(r.body).toContain('No issues found. LGTM! ✅');
  });

  it('leaves an already-linked entry untouched — never nests a second link', () => {
    const r = composeReview({
      cannotTellCriticals: [
        '[comment 3733696855](https://github.com/QwenLM/qwen-code/pull/8388#discussion_r3733696855) — body truncated',
      ],
      planPath: coveredPlan(undefined, {
        ownerRepo: 'QwenLM/qwen-code',
        prNumber: '8388',
      }),
      env: ENV,
      modelId: MODEL,
    });
    // Byte-identical passthrough: the model linked it itself.
    expect(r.body).toContain(
      '[comment 3733696855](https://github.com/QwenLM/qwen-code/pull/8388#discussion_r3733696855) — body truncated',
    );
    expect(r.body).not.toContain('[[comment');
  });

  it('renders reasonless entries as their own bullets — no collapse, no dangling dash', () => {
    const r = composeReview(
      base({
        cannotTellCriticals: ['old blocker', 'second blocker'],
      }),
    );
    expect(r.body).toContain('\n- **[Critical]** old blocker\n');
    expect(r.body).toContain('\n- **[Critical]** second blocker\n');
    expect(r.body).not.toContain('entries —');
  });

  it('reads a dangling " — " as reasonless, not an empty group key', () => {
    const r = composeReview(
      base({
        cannotTellCriticals: ['a.ts:1 — ', 'b.ts:2 — '],
      }),
    );
    expect(r.body).toContain('\n- **[Critical]** a.ts:1\n');
    expect(r.body).toContain('\n- **[Critical]** b.ts:2\n');
    expect(r.body).not.toContain('entries —');
  });

  it('a cut landing right after the separator stays reasonless and keeps the trim mark', () => {
    // The bound strands the separator at the line's end (` — …`) the way
    // a trailing-space entry strands it (` — `): both are reasonless, and
    // the ellipsis still says the entry was cut.
    const r = composeReview(
      base({
        cannotTellCriticals: [`${'x'.repeat(237)} — reason`],
      }),
    );
    expect(r.body).toContain(`- **[Critical]** ${'x'.repeat(237)}…`);
    expect(r.body).not.toContain('— …');
  });

  it('collapses embedded newlines so a multi-line entry stays one list item', () => {
    const r = composeReview(
      base({
        cannotTellCriticals: [
          'comment 3733696855 (a.ts) — body truncated\nsee also b.ts',
        ],
      }),
    );
    expect(r.body).toContain(
      '- **[Critical]** comment 3733696855 (a.ts) — body truncated see also b.ts',
    );
  });

  it('counts entries, not groups, in the Chinese fold', () => {
    // Three entries collapsing into two groups — the fold must carry 3.
    const r = composeReview({
      cannotTellCriticals: [
        'one (a.ts) — body truncated',
        'two (b.ts) — body truncated',
        'three (c.ts) — quarantined by the harness',
      ],
      planPath: coveredPlan(undefined, { han: true }),
      env: ENV,
      modelId: MODEL,
    });
    // … the count AND the pointer — the fold's whole payload besides the
    // list it points at.
    expect(r.body).toContain(
      '未决，请确认：共 3 条（原文未翻译，列表见上方英文部分）。',
    );
  });

  it("anchors comment ids at the plan's GHE host, short ids included", () => {
    const r = composeReview({
      cannotTellCriticals: ['comment 12345 (a.ts) — body truncated'],
      planPath: coveredPlan(undefined, {
        ownerRepo: 'corp/widgets',
        prNumber: '12',
        host: 'ghe.example.com',
      }),
      env: ENV,
      modelId: MODEL,
    });
    expect(r.body).toContain(
      '[comment 12345](https://ghe.example.com/corp/widgets/pull/12#discussion_r12345)',
    );
  });

  it('leaves short ids bare on github.com — ordinals are not anchors', () => {
    const r = composeReview({
      cannotTellCriticals: ['comment 12345 (a.ts) — body truncated'],
      planPath: coveredPlan(undefined, {
        ownerRepo: 'QwenLM/qwen-code',
        prNumber: '8388',
      }),
      env: ENV,
      modelId: MODEL,
    });
    expect(r.body).toContain(
      '- **[Critical]** comment 12345 (a.ts) — body truncated',
    );
    expect(r.body).not.toContain('discussion_r12345');
  });

  it('reads a cased or :443-suffixed github.com as the default host', () => {
    // GH_HOST reaches the anchor builder through resolveGhHost; a cased
    // variant of the default host must not dodge the short-id floor.
    process.env['GH_HOST'] = 'GitHub.com:443';
    const r = composeReview({
      cannotTellCriticals: ['comment 12345 (a.ts) — body truncated'],
      planPath: coveredPlan(undefined, {
        ownerRepo: 'QwenLM/qwen-code',
        prNumber: '8388',
      }),
      env: ENV,
      modelId: MODEL,
    });
    expect(r.body).toContain(
      '- **[Critical]** comment 12345 (a.ts) — body truncated',
    );
    expect(r.body).not.toContain('discussion_r12345');
  });

  it('anchors an Issue-level mention at #issuecomment whatever its casing', () => {
    // pr-context renders `**Issue-level comment**` capitalized; an entry
    // echoing that casing must still anchor under #issuecomment, not
    // #discussion_r — an anchor GitHub cannot resolve. The link text keeps
    // the entry's own casing: the linkifier navigates, it does not rewrite.
    const r = composeReview({
      cannotTellCriticals: [
        'Issue-level comment 5199834809 (author review) — body truncated',
      ],
      planPath: coveredPlan(undefined, {
        ownerRepo: 'QwenLM/qwen-code',
        prNumber: '8388',
      }),
      env: ENV,
      modelId: MODEL,
    });
    expect(r.body).toContain(
      '[Issue-level comment 5199834809](https://github.com/QwenLM/qwen-code/pull/8388#issuecomment-5199834809)',
    );
  });

  it('falls back to github.com when the recorded host is not a hostname', () => {
    const r = composeReview({
      cannotTellCriticals: ['comment 3733696855 (a.ts) — body truncated'],
      planPath: coveredPlan(undefined, {
        ownerRepo: 'QwenLM/qwen-code',
        prNumber: '8388',
        host: 'ghe.example.com/evil',
      }),
      env: ENV,
      modelId: MODEL,
    });
    expect(r.body).toContain(
      '[comment 3733696855](https://github.com/QwenLM/qwen-code/pull/8388#discussion_r3733696855)',
    );
    expect(r.body).not.toContain('ghe.example.com/evil');
  });

  it('leaves ids bare when the recorded ownerRepo is misshapen', () => {
    // `../repo` rides the character class but is a dot segment — it must
    // not reach the anchor URL's path.
    const r = composeReview({
      cannotTellCriticals: ['comment 3733696855 (a.ts) — body truncated'],
      planPath: coveredPlan(undefined, {
        ownerRepo: '../repo',
        prNumber: '8388',
      }),
      env: ENV,
      modelId: MODEL,
    });
    expect(r.body).toContain(
      '- **[Critical]** comment 3733696855 (a.ts) — body truncated',
    );
    expect(r.body).not.toContain('discussion_r3733696855');
  });

  it('anchors at the run-routed host when the plan recorded none', () => {
    setGhHost('ghe.example.com');
    try {
      const r = composeReview({
        cannotTellCriticals: ['comment 12345 (a.ts) — body truncated'],
        planPath: coveredPlan(undefined, {
          ownerRepo: 'corp/widgets',
          prNumber: '12',
        }),
        env: ENV,
        modelId: MODEL,
      });
      expect(r.body).toContain(
        '[comment 12345](https://ghe.example.com/corp/widgets/pull/12#discussion_r12345)',
      );
    } finally {
      setGhHost(undefined);
    }
  });

  it('strips a copied **[Critical]** prefix from a cannot-tell entry', () => {
    // The orchestrator copies blocker lines as the context file renders
    // them — marker included; the bullet renders it exactly once.
    const r = composeReview(
      base({
        cannotTellCriticals: [
          '**[Critical]** old blocker (a.ts) — body truncated',
        ],
      }),
    );
    expect(r.body).toContain(
      '- **[Critical]** old blocker (a.ts) — body truncated',
    );
    expect(r.body).not.toContain('**[Critical]** **[Critical]**');
  });

  it('reads www./trailing-dot/zero-padded-port github.com variants as the default host', () => {
    // Each is the same default instance; a variant must not dodge the
    // short-id floor and link an ordinal into a dead anchor.
    for (const variant of [
      'www.github.com',
      'github.com.',
      'github.com:0443',
    ]) {
      process.env['GH_HOST'] = variant;
      const r = composeReview({
        cannotTellCriticals: ['comment 12345 (a.ts) — body truncated'],
        planPath: coveredPlan(undefined, {
          ownerRepo: 'QwenLM/qwen-code',
          prNumber: '8388',
        }),
        env: ENV,
        modelId: MODEL,
      });
      expect(r.body).toContain(
        '- **[Critical]** comment 12345 (a.ts) — body truncated',
      );
      expect(r.body).not.toContain('discussion_r12345');
    }
    // And a long id under the www variant anchors at the apex host.
    process.env['GH_HOST'] = 'www.github.com';
    const r = composeReview({
      cannotTellCriticals: ['comment 3733696855 (a.ts) — body truncated'],
      planPath: coveredPlan(undefined, {
        ownerRepo: 'QwenLM/qwen-code',
        prNumber: '8388',
      }),
      env: ENV,
      modelId: MODEL,
    });
    expect(r.body).toContain(
      '[comment 3733696855](https://github.com/QwenLM/qwen-code/pull/8388#discussion_r3733696855)',
    );
  });

  it("routes an issue-level entry's bare id to #issuecomment — the anchor family is per entry", () => {
    // pr-context's own header shape carries the id apart from the phrase:
    // `**Issue-level comment** — by @alice (comment 5199834809)`. Issue-
    // comment ids and review-comment ids are separate id spaces, so
    // routing that id by adjacency alone mints a #discussion_r anchor
    // that can never resolve.
    const r = composeReview({
      cannotTellCriticals: [
        '**Issue-level comment** — by @alice (comment 5199834809) — full text unfetchable',
      ],
      planPath: coveredPlan(undefined, {
        ownerRepo: 'QwenLM/qwen-code',
        prNumber: '8388',
      }),
      env: ENV,
      modelId: MODEL,
    });
    expect(r.body).toContain('#issuecomment-5199834809');
    expect(r.body).not.toContain('discussion_r5199834809');
  });

  it('degrades to bare ids on a corrupt plan file — never throws', () => {
    // The orchestrator killed mid-write leaves plan.json truncated; the
    // anchors degrade, the composition survives.
    const planPath = join(dir, 'corrupt-plan.json');
    writeFileSync(planPath, '{ not json');
    const r = composeReview({
      cannotTellCriticals: ['comment 3733696855 (a.ts) — body truncated'],
      planPath,
      env: ENV,
      modelId: MODEL,
    });
    expect(r.body).toContain(
      '- **[Critical]** comment 3733696855 (a.ts) — body truncated',
    );
    expect(r.body).not.toContain('discussion_r');
  });

  it('accepts a numeric prNumber — plans record both JSON forms', () => {
    const r = composeReview({
      cannotTellCriticals: ['comment 3733696855 (a.ts) — body truncated'],
      planPath: coveredPlan(undefined, {
        ownerRepo: 'QwenLM/qwen-code',
        prNumber: 8388,
      }),
      env: ENV,
      modelId: MODEL,
    });
    expect(r.body).toContain(
      '[comment 3733696855](https://github.com/QwenLM/qwen-code/pull/8388#discussion_r3733696855)',
    );
  });

  it('stays linear on a cannot-tell entry with a long whitespace run', () => {
    // The newline collapse must not reintroduce a quadratic scan: a
    // model-written entry has no length cap, and `/\s*\n+\s*/g` was
    // measured at seconds on an 80k whitespace run with no newline in it.
    const flat = `comment 101 (a.ts) — body${' '.repeat(80_000)}truncated`;
    const wrapped = `comment 102 (b.ts) — body\n${' '.repeat(80_000)}truncated`;
    const t0 = performance.now();
    const r = composeReview(base({ cannotTellCriticals: [flat, wrapped] }));
    expect(performance.now() - t0).toBeLessThan(2000);
    // 160k of model prose used to reach the body budget's last-resort
    // truncation; the per-entry char cap this account now shares bounds it
    // upstream of the budget instead, which is the better place for it. So
    // the body fits with room to spare and nothing claims a truncation.
    expect(r.body.length).toBeLessThanOrEqual(65536);
    expect(r.body).not.toContain('was TRUNCATED to fit');
  });

  it('collapses a multi-line cannot-tell entry into one list item', () => {
    const wrapped = 'comment 102 (b.ts) — body\n   truncated';
    const r = composeReview(base({ cannotTellCriticals: [wrapped] }));
    expect(r.body).toContain('comment 102 (b.ts) — body truncated');
    expect(r.body).not.toContain('was TRUNCATED to fit');
  });
});

describe('composeReview — a resumed run is continuity, not a coverage gap', () => {
  it('stays APPROVE and renders the non-capping continuity note', () => {
    // The interrupted attempt's chunk-1 agent, re-homed into session S0 and
    // named by the run ledger; the current session covers the rest. The
    // recovered work COUNTS as reviewed: no cap, no "Not reviewed:" entry —
    // a capping entry here downgraded every clean resumed run to COMMENT,
    // permanently, since the prior records never leave the ledger.
    // Build the input FIRST: `base()`'s object literal evaluates its
    // `planPath: coveredPlan()` default even when the caller overrides it,
    // and `coveredPlan()` rewrites the current session's chunk-1 record —
    // which would then supersede the prior one and (correctly) stop counting
    // as recovered work.
    const input = base({});
    rehomeToPriorSession(input.planPath as string, 'agent-a1.jsonl');

    const r = composeReview(input);
    expect(r.event).toBe('APPROVE');
    // The EXACT joined body, not a substring: on the approve path the
    // separator is chosen per-render, and continuity is the only block
    // present here. Asserted as a whole, a separator that forgot this block
    // glues the note onto the verdict sentence with a single space; asserted
    // with `toContain`, that reads identically.
    expect(r.body).toBe(
      'No issues found. LGTM! ✅\n\n' +
        'Resumed run (not a gap): 1 agent result(s) from the interrupted ' +
        'earlier attempt were re-certified from the harness records and ' +
        'counted as reviewed.\n\n' +
        '_— test-model via Qwen Code /review (vunknown)_',
    );
    expect(r.body).not.toContain('Not reviewed: review continuity');
    expect(r.body).not.toContain('Partially reviewed');
  });
});

describe('composeReview — continuity renders on every verdict', () => {
  /**
   * A resumed run: chunk-1's agent re-homed to the ledgered prior session.
   *
   * `base()`'s object literal evaluates its `planPath: coveredPlan()` default
   * even when the caller overrides it, and `coveredPlan()` REWRITES
   * `subagents/S1/agent-a1.jsonl` — so the move must happen after `base()`
   * has been built, not before. Callers pass the input through here.
   */
  function resumedInput(
    over: Partial<ComposeReviewInput> = {},
  ): ComposeReviewInput {
    const input = base(over);
    const p = input.planPath as string;
    rehomeToPriorSession(p, 'agent-a1.jsonl');
    return input;
  }

  it('renders on REQUEST_CHANGES', () => {
    const r = composeReview(resumedInput({ criticalsInline: 1 }));
    expect(r.event).toBe('REQUEST_CHANGES');
    expect(r.body).toContain('Resumed run (not a gap): 1 agent result(s)');
  });

  it('renders on COMMENT', () => {
    const r = composeReview(resumedInput({ suggestionsInline: 1 }));
    expect(r.event).toBe('COMMENT');
    expect(r.body).toContain('Resumed run (not a gap): 1 agent result(s)');
  });
});

describe('floor enforcement — the posture, as code', () => {
  // SKILL Step 6 resolves the posting floor in prose and tells the MODEL to
  // defer; six live PRs measured 2026-08-16 posted double-digit Suggestions
  // at rounds ≥ 6 anyway. The floor is the operator's configured policy, so
  // `composeReview` now enforces it mechanically: drafted Suggestions leave
  // the posting set and join the deferral list. Every case here is a row of
  // the decision table (floor × round × knowability), and the fail-open rows
  // matter as much as the firing ones — a posting bar in doubt posts.
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'floor-enf-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const plan = (over: Record<string, unknown> = {}) => {
    const p = join(dir, 'plan.json');
    writeFileSync(p, JSON.stringify({ prNumber: 8255, ...over }));
    return p;
  };
  const sideFile = (round: number) =>
    writeFileSync(
      join(dir, 'qwen-review-pr-8255-prev-ledger.json'),
      JSON.stringify({ v: 1, round, findings: [] }),
    );
  const drafts = () => [
    { path: 'a.ts', line: 3, body: '**[Critical]** boom' },
    { path: 'b.ts', line: 7, body: '**[Suggestion]** R2-4: tidy this' },
    { path: 'c.ts', line: 9, body: '**[Suggestion]** rename the flag' },
  ];
  const compose = (over: Partial<ComposeReviewInput> = {}) =>
    composeReview({
      planPath: plan(),
      modelId: 'm',
      criticalsInline: 1,
      suggestionsInline: 2,
      draftedComments: drafts(),
      ...over,
    });

  it('reroutes drafted Suggestions under an explicit critical floor, any round', () => {
    const r = compose({ severityFloor: 'critical' });
    expect(r.floorEnforced).toEqual([1, 2]);
    expect(r.deferredCount).toBe(2);
    // The finding is not lost: the body discloses the move and lists the
    // entries, carried ids included — the record survives on the PR.
    expect(r.body).toContain('floor enforcement');
    expect(r.body).toContain('b.ts:7');
    expect(r.body).toContain('R2-4: tidy this');
    // The ledger work list holds only what posts — the same semantics as a
    // model-side deferral.
    const ledger = parseLedger(r.body)!;
    expect(ledger.findings.map((f) => f.sev)).toEqual(['C']);
    // A posting decision, never a cap: the licence holds by construction.
    expect(r.cappedBy).not.toContain('unlicensed-deferral');
    // The Critical still posts and still counts toward the base event (on
    // this bare plan the existing criticals-unverified cap then softens the
    // posted event, exactly as it would without enforcement — enforcement
    // itself moved no verdict).
    expect(r.baseEvent).toBe('REQUEST_CHANGES');
    expect(verdictLine(r)).toContain('moved by CLI floor enforcement');
  });

  it('enforces auto from round 6 — the side-file round decides', () => {
    sideFile(5); // this review is round 6
    const r = compose({ severityFloor: 'auto' });
    expect(r.floorEnforced).toEqual([1, 2]);
    expect(parseLedger(r.body)?.round).toBe(6);
  });

  it('does not enforce auto before round 6 — the rounds-2-5 age rule stays model-side', () => {
    sideFile(4); // this review is round 5
    const r = compose({ severityFloor: 'auto' });
    expect(r.floorEnforced).toEqual([]);
    expect(r.body).not.toContain('floor enforcement');
  });

  it('fails open when auto cannot know the round — context-unavailable', () => {
    sideFile(9);
    const r = compose({ severityFloor: 'auto', contextUnavailable: true });
    expect(r.floorEnforced).toEqual([]);
  });

  it('fails open when auto recovered no round — round 1', () => {
    const r = compose({ severityFloor: 'auto' });
    expect(r.floorEnforced).toEqual([]);
  });

  it('an explicit suggestion floor turns the posture off — no enforcement', () => {
    sideFile(9);
    const r = compose({ severityFloor: 'suggestion' });
    expect(r.floorEnforced).toEqual([]);
  });

  it('an absent floor fails open — the licence cannot be checked', () => {
    sideFile(9);
    const r = compose({});
    expect(r.floorEnforced).toEqual([]);
  });

  it('leaves a pathless Suggestion inline — fail open, the submit gate refuses it anyway', () => {
    const r = compose({
      severityFloor: 'critical',
      criticalsInline: 0,
      suggestionsInline: 2,
      draftedComments: [
        { line: 7, body: '**[Suggestion]** no path to defer to' },
        { path: 'c.ts', line: 9, body: '**[Suggestion]** rename the flag' },
      ],
    });
    expect(r.floorEnforced).toEqual([1]);
  });

  it('an all-enforced round reads as deferrals, never as silence', () => {
    const r = compose({
      severityFloor: 'critical',
      criticalsInline: 0,
      suggestionsInline: 2,
      draftedComments: drafts().slice(1),
    });
    expect(r.floorEnforced).toEqual([0, 1]);
    expect(r.deferredCount).toBe(2);
    // A deferral must not regenerate a review round: nothing counts toward S.
    expect(r.body).toContain('Deferred under the convergence posture');
    expect(r.body).not.toContain('Suggestions are inline.');
    // A posting decision, never a cap: the base event reads deferrals-only
    // APPROVE, and no enforcement-born cap state may appear.
    expect(r.baseEvent).toBe('APPROVE');
    expect(r.cappedBy).not.toContain('floor-enforcement');
  });

  it('an all-enforced CLEAN round composes a deferrals-only APPROVE — never a cap', () => {
    // The APPROVE branch of the body composer carries its own floorEnforced
    // return; the bare-plan fixtures above never reach it (their coverage
    // caps soften APPROVE to COMMENT), so a regression there sailed through
    // the whole suite. This is also the strongest pin of the PR's stated
    // invariant: enforcement is a posting decision, never a cap — event
    // APPROVE, empty cappedBy, and the anchor still rides.
    const r = composeReview({
      planPath: coveredPlan(['verify', 'reverse-audit'], {
        prNumber: 8255,
        fetchedSha: 'deadbeef00112233',
      }),
      env: ENV,
      modelId: MODEL,
      criticalsInline: 0,
      suggestionsInline: 1,
      severityFloor: 'critical',
      draftedComments: [
        { path: 'src/a.ts', line: 3, body: '**[Suggestion]** untested' },
      ],
    });
    expect(r.floorEnforced).toEqual([0]);
    expect(r.event).toBe('APPROVE');
    expect(r.baseEvent).toBe('APPROVE');
    expect(r.cappedBy).toEqual([]);
    expect(r.body).toContain('No blocking issues');
    expect(parseLedger(r.body)?.sha).toBe('deadbeef00112233');
  });

  it('clamps an understated suggestionsInline to a composable zero', () => {
    // The counts are model-transcribed; a state understating the drafted
    // Suggestions is the drift class this PR exists for, and without the
    // clamp the effective count goes negative and toCount refuses the WHOLE
    // round — the exact outcome the documented wrong-but-composable-zero
    // degrade exists to avoid.
    const r = compose({
      severityFloor: 'critical',
      criticalsInline: 0,
      suggestionsInline: 1,
      draftedComments: drafts().slice(1),
    });
    expect(r.floorEnforced).toEqual([0, 1]);
    expect(r.deferredCount).toBe(2);
  });

  it('adjusts an array-shaped seam count — the legacy list form toCount accepts', () => {
    // Without the Array.isArray arm the stale pre-enforcement length stays,
    // and the posted body carries "Suggestions are inline." two lines from
    // the enforcement disclosure saying they are not.
    const r = compose({
      severityFloor: 'critical',
      criticalsInline: 0,
      suggestionsInline: ['x', 'y'] as never,
      draftedComments: drafts().slice(1),
    });
    expect(r.floorEnforced).toEqual([0, 1]);
    expect(r.body).not.toContain('Suggestions are inline.');
    expect(r.body).toContain('floor enforcement');
  });

  it('an unrecognised present floor fails open — a posting bar in doubt posts', () => {
    // Model-transcribed drift ("Critical-only", "blocker", "high") must not
    // enforce: the absent-floor row alone cannot catch a mutation that fires
    // on any unknown non-empty string.
    for (const floor of ['blocker', 'Critical-only', 'high']) {
      const r = compose({ severityFloor: floor as never });
      expect(r.floorEnforced).toEqual([]);
    }
  });

  it('an explicit critical floor enforces even when the round is unknowable', () => {
    // context-unavailable stands only `auto` down — what is unknowable there
    // is the ROUND, and an explicit critical floor applies the posture from
    // round 1 regardless of round.
    const r = compose({ severityFloor: 'critical', contextUnavailable: true });
    expect(r.floorEnforced).toEqual([1, 2]);
  });

  it('merges enforced entries and model deferrals into one list, one count', () => {
    const r = compose({
      severityFloor: 'critical',
      deferredSuggestions: [
        {
          file: 'd.ts',
          line: 1,
          source: 'review',
          severity: 'Suggestion',
          title: 'model deferred this',
        },
      ],
    });
    expect(r.deferredCount).toBe(3);
    expect(r.body).toContain('model deferred this');
    expect(r.body).toContain('rename the flag');
  });

  it('leaves a deterministic-source Suggestion inline — the floor excludes it by source', () => {
    // SKILL Step 6: a [build]/[test]/[probe] finding is pre-confirmed and the
    // floor excludes it by its source field. The inline channel carries no
    // source, so the tag convention decides — the same predicate the
    // body-Critical scan reads deterministic by.
    const r = compose({
      severityFloor: 'critical',
      criticalsInline: 0,
      suggestionsInline: 2,
      draftedComments: [
        {
          path: 'src/retry.ts',
          line: 42,
          body: '**[Suggestion]** [test] mutation survivor on the retry guard',
        },
        { path: 'c.ts', line: 9, body: '**[Suggestion]** rename the flag' },
      ],
    });
    expect(r.floorEnforced).toEqual([1]);
    // The deterministic finding still posts — it is the ledger's only entry
    // after the plain Suggestion moved to the deferral list.
    const ledger = parseLedger(r.body)!;
    expect(ledger.findings.map((f) => f.file)).toEqual(['src/retry.ts']);
  });

  it('normalises the floor exactly as the licence block does — case and whitespace', () => {
    // Mutation guard: deleting the shared trim/lowercase must fail here —
    // the state field arrives model-transcribed on both entry paths.
    for (const floor of ['CRITICAL', ' critical ']) {
      const r = compose({ severityFloor: floor as never });
      expect(r.floorEnforced).toEqual([1, 2]);
    }
  });

  it('keeps BOTH channels’ records when they share an anchor — no dedup, no lost finding', () => {
    // An anchor-keyed identity cannot distinguish "the same finding riding
    // both channels" from "a different finding drafted at an anchor the
    // model also deferred" — and collapsing the second loses a finding from
    // every posted surface. Between the failure modes, a duplicated public
    // record is the cheap one, so both entries render and every count is
    // honest about it.
    const r = compose({
      severityFloor: 'critical',
      criticalsInline: 0,
      suggestionsInline: 1,
      draftedComments: [
        { path: 'c.ts', line: 9, body: '**[Suggestion]** rename the flag' },
      ],
      deferredSuggestions: [
        {
          file: 'c.ts',
          line: 9,
          source: 'review',
          severity: 'Suggestion',
          title: 'model kept this record',
        },
      ],
    });
    // The inline comment leaves the posting set…
    expect(r.floorEnforced).toEqual([0]);
    // …and BOTH records survive — the constructed one and the model's.
    expect(r.deferredCount).toBe(2);
    expect(r.body).toContain('model kept this record');
    expect(r.body).toContain('rename the flag');
    // The two disclosure surfaces count from the same basis: the moved
    // count can never exceed its antecedent (a "2 of 1" verdict line was
    // the observed self-contradiction under anchor-keyed dedup), and the
    // body note's N is the MOVED count, not the merged list's — swapping
    // its basis for deferredSuggestions.length would overclaim "2 moved"
    // here.
    const line = verdictLine(r);
    expect(line).toContain('2 non-Critical finding(s) deferred');
    expect(line).toContain('1 of those moved by CLI floor enforcement');
    expect(r.body).toContain(
      '1 Suggestion(s) were drafted inline past the resolved critical posting floor',
    );
  });

  it('renders the zh disclosure arm beside the en one on a bilingual review', () => {
    // The zh non-overflow arm posts on Han-flagged plans; a broken
    // interpolation there ships a Chinese disclosure contradicting the
    // English note beside it. (The overflow arm's zh twin is pinned in the
    // cap-aware test.)
    const hanPlan = join(dir, 'plan-han-note.json');
    writeFileSync(
      hanPlan,
      JSON.stringify({ prNumber: 8255, prDescriptionHasHan: true }),
    );
    const r = compose({
      severityFloor: 'critical',
      criticalsInline: 0,
      suggestionsInline: 1,
      draftedComments: [
        { path: 'c.ts', line: 9, body: '**[Suggestion]** rename the flag' },
      ],
      planPath: hanPlan,
    });
    expect(r.floorEnforced).toEqual([0]);
    expect(r.body).toContain(
      '1 条 Suggestion 在已解析的 critical 发布下限之外被起草为行内评论',
    );
    expect(r.body).toContain('下限强制执行）。');
  });

  it('turns the enforcement note cap-aware when the moved entries overflow the render cap', () => {
    const manyDrafts = Array.from({ length: 21 }, (_, i) => ({
      path: `f${i}.ts`,
      line: i + 1,
      body: `**[Suggestion]** enforced finding ${i}`,
    }));
    const r = compose({
      severityFloor: 'critical',
      criticalsInline: 0,
      suggestionsInline: 21,
      draftedComments: manyDrafts,
      // Han-flagged plan under its OWN filename: the shared plan() helper
      // writes plan.json and the compose() base would overwrite the flag.
      // The bilingual fold renders the zh arm into the POSTED body, so a
      // broken zh interpolation posts — pin it beside the en arm, per the
      // suite's own bilingual-pinning convention.
      planPath: (() => {
        const p = join(dir, 'plan-han.json');
        writeFileSync(
          p,
          JSON.stringify({ prNumber: 8255, prDescriptionHasHan: true }),
        );
        return p;
      })(),
    });
    expect(r.floorEnforced).toHaveLength(21);
    // The universal "listed below" claim would be false for entry 20 — the
    // note must say where the overflow went instead of asserting a list
    // that truncated it. Both language arms carry the same counts.
    expect(r.body).toContain('20 listed, 1 more inside the overflow count');
    expect(r.body).toContain('下限强制执行——列出 20 条，其余 1 条计入溢出计数');
    expect(r.body).toContain('and 1 more');
  });

  it('a tag outside the claim line does not exempt — the footer is not a kill-switch', () => {
    // The deterministic carve-out reads the CLAIM LINE only. The body's
    // tail is state-writable surface (the attribution footer is built from
    // the model-written modelId and appended before the predicate runs at
    // the submit boundary): matched over the whole body, one `[test]` in a
    // footer disabled enforcement for the entire review.
    const r = compose({
      severityFloor: 'critical',
      criticalsInline: 0,
      suggestionsInline: 1,
      draftedComments: [
        {
          path: 'c.ts',
          line: 9,
          body: '**[Suggestion]** rename the flag\n\n_— qwen3.7-max [test] via Qwen Code /review (v0.21.2)_',
        },
      ],
    });
    expect(r.floorEnforced).toEqual([0]);
    // And the forged footer never reaches the moved record: without the
    // strip, collapseToLine folds the attribution into the published
    // deferral title.
    expect(r.body).not.toContain('qwen3.7-max');
  });

  it('carries the whole marker-stripped body into the moved record, not just line one', () => {
    // The skill mandates multi-line Suggestion bodies (failure scenario,
    // suggested fix), and a moved comment's body leaves every posted
    // surface — a first-line-only title silently dropped the proposed fix
    // from the record.
    const r = compose({
      severityFloor: 'critical',
      criticalsInline: 0,
      suggestionsInline: 1,
      draftedComments: [
        {
          path: 'c.ts',
          line: 9,
          body: '**[Suggestion]** normalise the floor once.\n\nFailure scenario: drift.\n\nSuggested fix: parseFloor(raw)',
        },
      ],
    });
    expect(r.floorEnforced).toEqual([0]);
    expect(r.body).toContain('parseFloor(raw)');
  });

  it('renders enforced entries ahead of the cap, never truncated behind model deferrals', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      file: `m${i}.ts`,
      line: i + 1,
      source: 'review' as const,
      severity: 'Suggestion' as const,
      title: `model deferral ${i}`,
    }));
    const r = compose({
      severityFloor: 'critical',
      criticalsInline: 0,
      suggestionsInline: 1,
      draftedComments: [
        { path: 'c.ts', line: 9, body: '**[Suggestion]** rename the flag' },
      ],
      deferredSuggestions: many,
    });
    expect(r.deferredCount).toBe(21);
    // The CLI-moved entry is IN the rendered list — the disclosure note must
    // never point at a list that truncated away the entries it names.
    expect(r.body).toContain('rename the flag');
    expect(r.body).toContain('and 1 more');
    // The note counts MOVED comments and its overflow qualifier keys on the
    // ENFORCED entries, not the merged list: with the one moved entry
    // rendered in full, a "1 listed, 20 more inside the overflow count"
    // claim would be false — the model deferrals overflowed, not the move.
    expect(r.body).toContain(
      '1 Suggestion(s) were drafted inline past the resolved critical posting floor',
    );
    expect(r.body).not.toContain('inside the overflow count');
  });

  it('omits an unusable line and falls back on an all-marker body', () => {
    const r = compose({
      severityFloor: 'critical',
      criticalsInline: 0,
      suggestionsInline: 2,
      draftedComments: [
        { path: 'b.ts', line: 0, body: '**[Suggestion]** zero-line anchor' },
        { path: 'c.ts', line: 9, body: '**[Suggestion]**' },
      ],
    });
    expect(r.floorEnforced).toEqual([0, 1]);
    // The reroute path bypasses the consistency gate by construction, so its
    // own guards are the only protection against a `b.ts:0` locator or a
    // null title reaching the posted record.
    expect(r.body).not.toContain('b.ts:0');
    expect(r.body).toContain('zero-line anchor');
    expect(r.body).toContain('(comment carried no text)');
  });

  it('omits a non-integer line the same way — no fabricated locator', () => {
    // The Number.isSafeInteger conjunct is the only guard between a
    // model-transcribed `line: 2.5` and a `c.ts:2.5` anchor published into
    // the PR's permanent deferral record.
    const r = compose({
      severityFloor: 'critical',
      criticalsInline: 0,
      suggestionsInline: 1,
      draftedComments: [
        { path: 'c.ts', line: 2.5, body: '**[Suggestion]** fractional line' },
      ],
    });
    expect(r.floorEnforced).toEqual([0]);
    expect(r.body).not.toContain('c.ts:2.5');
    expect(r.body).toContain('fractional line');
  });
});

describe('convergence telemetry — volume, carried in the marker', () => {
  // The fields decide nothing, so every test here is about one property:
  // the number a round records is the number it actually posts, and it
  // survives the trip to the next round intact. A trend built on a count
  // that disagrees with the comment list is worse than no trend.
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'telemetry-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const plan = (over: Record<string, unknown> = {}) => {
    const p = join(dir, 'plan.json');
    writeFileSync(p, JSON.stringify({ prNumber: 8255, ...over }));
    return p;
  };
  const sideFile = (prev: Record<string, unknown>) =>
    writeFileSync(
      join(dir, 'qwen-review-pr-8255-prev-ledger.json'),
      JSON.stringify({ v: 1, findings: [], ...prev }),
    );
  const drafts = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      path: `f${i}.ts`,
      line: i + 1,
      body: `**[Suggestion]** finding ${i}`,
    }));

  it('records the posting count in the marker and on the result', () => {
    const r = composeReview({
      planPath: plan(),
      modelId: 'm',
      criticalsInline: 0,
      suggestionsInline: 3,
      draftedComments: drafts(3),
    });
    expect(r.postedInline).toBe(3);
    expect(parseLedger(r.body)?.posted).toBe(3);
  });

  it('counts the POST-enforcement set — what submit actually sends', () => {
    // The floor moves two of the three out of the posting set, so the
    // recorded volume is one. Counting the drafts would record a number no
    // comment list on the PR could corroborate.
    const r = composeReview({
      planPath: plan(),
      modelId: 'm',
      severityFloor: 'critical',
      criticalsInline: 1,
      suggestionsInline: 2,
      draftedComments: [
        { path: 'a.ts', line: 1, body: '**[Critical]** boom' },
        ...drafts(2),
      ],
    });
    expect(r.floorEnforced).toHaveLength(2);
    expect(r.postedInline).toBe(1);
    expect(parseLedger(r.body)?.posted).toBe(1);
  });

  it('carries the previous round forward, giving one marker a two-round window', () => {
    sideFile({ round: 4, posted: 7 });
    const r = composeReview({
      planPath: plan(),
      modelId: 'm',
      criticalsInline: 0,
      suggestionsInline: 2,
      draftedComments: drafts(2),
    });
    expect(r.prevPostedInline).toBe(7);
    const l = parseLedger(r.body)!;
    expect(l.round).toBe(5);
    expect(l.posted).toBe(2);
    expect(l.prevPosted).toBe(7);
  });

  it('records zero rather than dropping it — a converged round is the observation', () => {
    sideFile({ round: 2, posted: 0 });
    const r = composeReview({
      planPath: plan(),
      modelId: 'm',
      criticalsInline: 0,
      suggestionsInline: 0,
      draftedComments: [],
    });
    expect(r.postedInline).toBe(0);
    expect(r.prevPostedInline).toBe(0);
    const l = parseLedger(r.body)!;
    expect(l.posted).toBe(0);
    expect(l.prevPosted).toBe(0);
  });

  it('distinguishes "recorded nothing" from "posted nothing"', () => {
    // Every round before the field shipped has no volume; reading that as
    // zero would invent a trend point the predecessor never claimed.
    sideFile({ round: 3 });
    const r = composeReview({
      planPath: plan(),
      modelId: 'm',
      criticalsInline: 0,
      suggestionsInline: 1,
      draftedComments: drafts(1),
    });
    expect(r.prevPostedInline).toBeUndefined();
    expect(parseLedger(r.body)?.prevPosted).toBeUndefined();
    expect(parseLedger(r.body)?.posted).toBe(1);
  });

  it('refuses a side-file volume that is not one, without losing the round', () => {
    // The side file is a JSON pr-context wrote, not a marker the parser
    // already normalised — a malformed volume costs the trend point and
    // must not cost the posture's round.
    for (const bad of [-1, 2.5, 'seven', null]) {
      sideFile({ round: 6, posted: bad });
      const r = composeReview({
        planPath: plan(),
        modelId: 'm',
        criticalsInline: 0,
        suggestionsInline: 1,
        draftedComments: drafts(1),
      });
      expect(r.prevPostedInline).toBeUndefined();
      expect(parseLedger(r.body)?.round).toBe(7);
    }
  });

  it('keeps the volume on a round whose anchor is withheld', () => {
    // The anchor pair falls on a fail-closed round; the volume does not.
    // A trend that goes blank exactly when a PR starts capping would be
    // blind on the rounds it exists to describe.
    const r = composeReview({
      planPath: plan({ fetchedSha: 'deadbeef00112233' }),
      modelId: 'm',
      criticalsInline: 0,
      suggestionsInline: 2,
      draftedComments: drafts(2),
      cannotTellCriticals: ['a.ts:1 — could not decide'],
    });
    const l = parseLedger(r.body)!;
    expect(l.sha).toBeUndefined();
    expect(l.posted).toBe(2);
  });
});
