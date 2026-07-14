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
import { promptRecordDir } from './lib/prompt-record.js';
import {
  composeReview,
  composeReviewCommand,
  type ComposeReviewInput,
  type ComposeReviewResult,
} from './compose-review.js';

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
}));

const MODEL = 'test-model';

// Coverage is read from the harness's transcripts on disk, so the fixtures build
// them: a plan, and the `agent-<id>.jsonl` files the harness would have written.
let dir: string;
/** Passed explicitly, so these tests never race another suite over process.env. */
let ENV: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'compose-cov-'));
  ENV = { QWEN_CODE_PROJECT_DIR: dir, QWEN_CODE_SESSION_ID: 'S1' };
  mkdirSync(join(dir, 'subagents', 'S1'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const DIFF = '/abs/diff.txt';

/** Write a plan with two chunks, and return its path. */
function plan(): string {
  const p = join(dir, 'plan.json');
  writeFileSync(
    p,
    JSON.stringify({
      diffPathAbsolute: DIFF,
      chunks: [
        { id: 1, startLine: 1, endLine: 100 },
        { id: 2, startLine: 101, endLine: 200 },
      ],
    }),
  );
  // Backdate it. The transcripts are written first and the stale-transcript
  // filter is `mtime < planMtime`; on a filesystem with millisecond granularity
  // both land in the same tick and the comparison flips at random. An explicit
  // gap makes the fixture say what it means: these transcripts are newer.
  const old = new Date(2020, 0, 1);
  utimesSync(p, old, old);
  return p;
}

/** Write one agent transcript, as the harness would. */
function transcript(
  id: string,
  launchPrompt: string,
  opts: { toolCalls?: number; text?: string } = {},
): void {
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
            { functionCall: { name: 'read_file', args: { file_path: DIFF } } },
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
  return `You are reviewing chunk ${chunk} of 2.\nread_file(file_path="${DIFF}", offset=${offset}, limit=100)`;
}

/** Lay down the CLI's record of the prompt it built for `chunk`. */
function recordBuilt(planPath: string, chunk: number): void {
  const d = promptRecordDir(planPath);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `chunk-${chunk}.txt`), goodPrompt(chunk));
}

/** The prompt the orchestrator actually sent, 23 times: no diff anywhere. */
function blindPrompt(chunk: number): string {
  return `The changes are in chunk ${chunk} of 2, covering lines 1-100 of the diff.`;
}

/** Both chunks reviewed by agents that opened the diff. */
function coveredPlan(): string {
  transcript('a1', goodPrompt(1), { toolCalls: 3 });
  transcript('a2', goodPrompt(2), { toolCalls: 2 });
  const p = plan();
  recordBuilt(p, 1);
  recordBuilt(p, 2);
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

const FOOTER = `_— ${MODEL} via Qwen Code /review_`;

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
    expect(r.body).toContain(
      '2 Suggestion-level finding(s) could not be anchored to the diff; see the terminal output.',
    );
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

describe('composeReview — input validation (the producer is a model that omits inapplicable fields)', () => {
  it('a body-Critical-only input with every count omitted is REQUEST_CHANGES (undefined + 1 = NaN once meant APPROVE)', () => {
    const r = composeReview({
      bodyCriticals: ['the only blocker'],
      modelId: MODEL,
    });
    expect(r.event).toBe('REQUEST_CHANGES');
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
  it('reads --input and writes the result JSON to --out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'compose-review-test-'));
    const inputPath = join(dir, 'compose.json');
    const outPath = join(dir, 'nested', 'composed.json');
    writeFileSync(
      inputPath,
      JSON.stringify({ suggestionsInline: 1, modelId: MODEL }),
      'utf8',
    );
    (composeReviewCommand.handler as (argv: unknown) => void)({
      input: inputPath,
      out: outPath,
    });
    const written = JSON.parse(
      readFileSync(outPath, 'utf8'),
    ) as ComposeReviewResult;
    expect(written.event).toBe('COMMENT');
    expect(written.body).toContain('Suggestions are inline.');
    expect(written.body.endsWith(FOOTER)).toBe(true);
  });

  it('strips a model-supplied `env` — it cannot redirect the transcript lookup', () => {
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
          criticalsInline: 0,
          suggestionsInline: 0,
          planPath,
          env: { QWEN_CODE_PROJECT_DIR: forged, QWEN_CODE_SESSION_ID: 'S1' },
          modelId: MODEL,
        }),
      );
      const outPath = join(dir, 'out.json');
      const prevProj = process.env['QWEN_CODE_PROJECT_DIR'];
      delete process.env['QWEN_CODE_PROJECT_DIR']; // real env cannot find transcripts
      try {
        (composeReviewCommand.handler as (argv: unknown) => void)({
          input: inputPath,
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
  it('caps when no plan is given — nothing can show the diff was read', () => {
    const r = composeReview({
      criticalsInline: 0,
      suggestionsInline: 0,
      modelId: MODEL,
    });
    expect(r.event).not.toBe('APPROVE');
    expect(r.body).toContain('no plan was given');
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
  });

  it('names a blind launch as itself, not as a whiff', () => {
    // An agent whose prompt never named the diff could not have read it, and
    // relaunching it produces another agent that cannot either. The prompt is the
    // defect, and the body has to say so or the reader will retry forever.
    const r = composeReview({
      criticalsInline: 0,
      suggestionsInline: 0,
      planPath: blindPlan(),
      env: ENV,
      modelId: MODEL,
    });
    expect(r.event).not.toBe('APPROVE');
    expect(r.body).toContain('never named the diff file');
    expect(r.body).toContain('agent-prompt');
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
