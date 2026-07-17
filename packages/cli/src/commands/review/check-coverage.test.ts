/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The subject is a review that approved 4 925 lines nobody read — twice.
//
// The first version of this check read `returns.txt`, a file the orchestrator
// wrote. It fabricated the receipts. The second read the agents' prose for signs
// of work; measured against 129 real transcripts it caught **none** of the 80
// agents that made no tool call, because every one of them returned more than
// forty characters of confident, specific text.
//
// This version reads the harness's own records. The tests are driven by the
// shapes those records actually take.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  utimesSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  coverageFromTranscripts,
  verificationGaps,
  TranscriptsUnavailableError,
} from './lib/coverage.js';
import { promptRecordDir, briefPath } from './lib/prompt-record.js';
import { requiredAgents, type RosterPlan } from './lib/roster.js';
import { checkCoverageCommand } from './check-coverage.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';

// Only the stderr test below drives the command handler; the rest of this file
// exercises the pure function, which prints nothing.
vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn(),
}));

let dir: string;
let ENV: NodeJS.ProcessEnv;

const DIFF = '/abs/qwen-review-pr-1-diff.txt';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cov-'));
  ENV = { QWEN_CODE_PROJECT_DIR: dir, QWEN_CODE_SESSION_ID: 'S1' };
  mkdirSync(join(dir, 'subagents', 'S1'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A plan with `n` chunks, backdated so every transcript counts as newer.
 *
 * It also lays down the prompt record `agent-prompt` would have written for each
 * chunk, because that is the state of a run that used the command it was told to
 * use. Pass `{ record: false }` for a run that hand-wrote its prompts instead.
 */
function plan(
  n = 2,
  opts: { record?: boolean; roster?: boolean } = {},
): string {
  const p = join(dir, 'plan.json');
  writeFileSync(
    p,
    JSON.stringify({
      diffPathAbsolute: DIFF,
      // A territory fan-out, captured cross-repo, with no deletions: the smallest
      // plan whose roster is exactly the chunks plus the test matrix. The fixtures
      // below are about chunk agents, so this keeps the roster out of their way
      // without switching it off — a plan that requires nothing is not a plan any
      // capture command writes.
      srcDiffLines: 5000,
      diffLines: 5000,
      files: [{ path: 'a.ts', kind: 'source', removedLines: 0, heavy: false }],
      chunks: Array.from({ length: n }, (_, i) => ({
        id: i + 1,
        startLine: i * 100 + 1,
        endLine: (i + 1) * 100,
      })),
    }),
  );
  if (opts.record !== false) {
    for (let c = 1; c <= n; c++) built(p, c);
  }
  if (opts.roster !== false) satisfyRoster(p);
  const old = new Date(2020, 0, 1);
  utimesSync(p, old, old);
  return p;
}

/**
 * Build and launch every agent this plan's roster requires that the test has not
 * already set up itself.
 *
 * A run that launched only its chunk agents is a run that skipped the whole-diff
 * half of the fan-out, and the roster check is right to fail it — so the fixtures
 * have to look like real runs. These stand-ins name no line ranges, so they grant
 * no coverage: a review may not certify lines on the strength of "somebody had the
 * file open".
 */
function satisfyRoster(planPath: string): void {
  const p = JSON.parse(readFileSync(planPath, 'utf8')) as RosterPlan;
  const d = promptRecordDir(planPath);
  mkdirSync(d, { recursive: true });
  for (const req of requiredAgents(p)) {
    // Not the chunk agents: their prompts are what most of these tests are ABOUT,
    // and writing one here would quietly satisfy the check a test is trying to fail.
    if (req.role === 'chunk') continue;
    const f = join(d, `${encodeURIComponent(req.key)}.txt`);
    if (existsSync(f)) continue;
    // The launch prompt POINTS at the brief; the brief is what the agent reads.
    // Both are written by the CLI, and the agent opening the second is what proves
    // the instructions arrived — a 4 652-character prompt is not something an
    // orchestrator pastes twelve times, and the run asked to do so delivered 2 893.
    const brief = briefPath(planPath, req.key);
    writeFileSync(brief, `The ${req.key} brief.`);
    const prompt =
      `You are ${req.key}.\n` +
      `read_file(file_path="${brief}")\n` +
      `read_file(file_path="${DIFF}")`;
    writeFileSync(f, prompt);
    transcript(`r-${req.key.replace(/[^a-z0-9]/gi, '_')}`, prompt, {
      calls: 2,
      opens: [brief],
    });
  }
}

/** Write a transcript the way the harness writes one. */
function transcript(
  id: string,
  launchPrompt: string,
  opts: {
    calls?: number;
    failed?: boolean;
    text?: string;
    /**
     * Paths this agent successfully opened, beyond the diff.
     *
     * Defaults to every brief its launch prompt points at — which is what a
     * compliant agent does, and what the launch prompt exists to make it do. A test
     * that wants an agent which ignored its brief passes `opens: []`.
     */
    opens?: string[];
  } = {},
): void {
  const base = { agentId: id, agentName: 'general-purpose', sessionId: 'S1' };
  const pointedAtBriefs = [
    ...launchPrompt.matchAll(/read_file\(file_path="([^"]*\.brief\.md)"\)/g),
  ].map((m) => m[1]);
  // An agent that did nothing opened nothing — not even its brief. The default
  // models a *working* agent, which is the only kind that reads what it is pointed
  // at; a whiff and a failed run leave the briefs unread, as they do the diff.
  const working = (opts.calls ?? 0) > 0 && !opts.failed;
  const opens = opts.opens ?? (working ? pointedAtBriefs : []);
  const lines = [
    JSON.stringify({
      ...base,
      type: 'user',
      message: { role: 'user', parts: [{ text: launchPrompt }] },
    }),
  ];
  for (let i = 0; i < (opts.calls ?? 0); i++) {
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
                response: opts.failed
                  ? { error: 'permission denied' }
                  : { output: 'diff bytes' },
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
 * What `agent-prompt` builds: the diff, and the read of *this* chunk's lines.
 *
 * The offsets are the chunk's own, as the real command emits them. The first
 * version of this helper gave every chunk `offset=0, limit=100` and coverage still
 * passed, because coverage was attributed from the words `chunk N of 2` and never
 * looked at the range. That is the same blindness the Step 3A topology walked into
 * for real: no agent's prompt says `chunk N of M` there, so no chunk was ever
 * attributed to anyone.
 */
const good = (c: number) =>
  `You are reviewing chunk ${c} of 2.\n` +
  `read_file(file_path="${chunkBrief(c)}")\n` +
  `read_file(file_path="${DIFF}", offset=${(c - 1) * 100}, limit=100)`;

/** Every plan fixture here writes to the same path, so the brief's is derivable. */
const chunkBrief = (c: number) =>
  briefPath(join(dir, 'plan.json'), `chunk-${c}`);

/** What Step 3A hands every dimension agent: the whole diff, chunk by chunk. */
const wholeDiff = () =>
  'Security review of the whole diff.\n' +
  `read_file(file_path="${DIFF}", offset=0, limit=100)\n` +
  `read_file(file_path="${DIFF}", offset=100, limit=100)`;

/** What the orchestrator actually sent, 23 times: no diff anywhere in it. */
const blind = (c: number) =>
  `The changes are in chunk ${c} of 2, covering lines 1-100 of the diff.`;

/**
 * The CLI's own record of the prompt it built — what `agent-prompt` writes and
 * what the rewrite check reads back. Without it every chunk agent reads as
 * hand-prompted, which is exactly what the check is for.
 */
function built(planPath: string, c: number, prompt = good(c)): void {
  const d = promptRecordDir(planPath);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `chunk-${c}.txt`), prompt);
  writeFileSync(chunkBrief(c), `The chunk-${c} brief.`);
}

/** A genuine Step 3A plan: a small source change, every dimension walking it all. */
function plan3a(): string {
  const p = join(dir, 'plan.json');
  writeFileSync(
    p,
    JSON.stringify({
      diffPathAbsolute: DIFF,
      srcDiffLines: 200,
      diffLines: 300,
      files: [{ path: 'a.ts', kind: 'source', removedLines: 0, heavy: false }],
      chunks: [
        { id: 1, startLine: 1, endLine: 100 },
        { id: 2, startLine: 101, endLine: 200 },
      ],
    }),
  );
  satisfyRoster(p);
  const old = new Date(2020, 0, 1);
  utimesSync(p, old, old);
  return p;
}

/** A same-repo PR: there is a tree to grep and build, and an issue to check against. */
function planPr(): string {
  const p = join(dir, 'plan.json');
  writeFileSync(
    p,
    JSON.stringify({
      diffPathAbsolute: DIFF,
      srcDiffLines: 200,
      diffLines: 300,
      prNumber: '6766',
      ownerRepo: 'QwenLM/qwen-code',
      worktreePath: '.qwen/tmp/review-pr-6766',
      files: [{ path: 'a.ts', kind: 'source', removedLines: 0, heavy: false }],
      chunks: [
        { id: 1, startLine: 1, endLine: 100 },
        { id: 2, startLine: 101, endLine: 200 },
      ],
    }),
  );
  satisfyRoster(p);
  const old = new Date(2020, 0, 1);
  utimesSync(p, old, old);
  return p;
}

describe('coverage — from the harness, not from the caller', () => {
  it('passes when every chunk was read by an agent that opened the diff', () => {
    transcript('a1', good(1), { calls: 3 });
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.ok).toBe(true);
    expect(r.coveredChunks).toEqual([1, 2]);
    expect(r.missingChunks).toEqual([]);
  });

  it('catches the agent that made no tool call, however well it wrote', () => {
    // Of 129 real transcripts, 80 made no call — and every one of them cleared a
    // 40-character floor with text like this. Prose is not evidence.
    transcript('a1', good(1), {
      calls: 0,
      text: 'No issues found — reviewed chunk 1 (packages/cli/src/pay.ts) thoroughly, checking correctness, security and error handling.',
    });
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.ok).toBe(false);
    expect(r.idleAgents).toEqual(['chunk 1']);
    expect(r.missingChunks).toEqual([1]);
  });

  it('does not count a failed tool call as work', () => {
    // The runtime records a `functionCall` before the permission check and for a
    // hallucinated tool name, so a bar set at "made a call" is cleared by an
    // agent that read nothing at all.
    transcript('a1', good(1), { calls: 2, failed: true });
    transcript('a2', good(2), { calls: 1 });

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.idleAgents).toEqual(['chunk 1']);
    expect(r.ok).toBe(false);
  });

  it('names a blind launch as itself — the prompt is the defect, not the agent', () => {
    // The real failure, 23 times over: the agent was handed a description of a
    // chunk it had no way to open. Calling this a whiff sends the reader off to
    // relaunch an agent that will be exactly as blind the second time.
    transcript('a1', blind(1), { calls: 0 });
    transcript('a2', blind(2), { calls: 0 });

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.ok).toBe(false);
    expect(r.blindAgents).toEqual(
      expect.arrayContaining(['chunk 1', 'chunk 2']),
    );
    expect(r.idleAgents).toEqual([]); // NOT idle — they were never able to work
    expect(r.missingChunks).toEqual([1, 2]);
  });

  it('accepts an Uncoverable declaration as a disclosed gap', () => {
    transcript('a1', good(1), { calls: 2 });
    transcript('a2', good(2), {
      calls: 1,
      text: 'Uncoverable: chunk 2 — line exceeds the read limit',
    });

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.uncoverableChunks).toEqual([2]);
    expect(r.missingChunks).toEqual([]);
    // A disclosed gap is not coverage: the verdict may not approve on its
    // strength. Every other test here asserts `ok`; this one was the exception.
    expect(r.ok).toBe(false);
  });

  it('ignores transcripts older than the plan they are evidence for', () => {
    // The transcript dir is scoped to the session, not the review, and nothing
    // prunes it. A second /review in one session would otherwise be satisfied by
    // the first one's agents — and the diff path is stable across runs, so the
    // collision is silent.
    transcript('old1', good(1), { calls: 5 });
    transcript('old2', good(2), { calls: 5 });
    const p = plan();
    const future = new Date(Date.now() + 60_000);
    utimesSync(p, future, future); // the plan is NEWER than both transcripts

    const r = coverageFromTranscripts(p, ENV);
    expect(r.agents).toBe(0);
    expect(r.missingChunks).toEqual([1, 2]);
    expect(r.ok).toBe(false);
  });

  it('distinguishes "no transcripts at all" from "the agents idled"', () => {
    // A read-only HOME must not read as 29 whiffing agents. It is an environment
    // failure and has to say so, or the reader chases agents that ran fine.
    expect(() =>
      coverageFromTranscripts(plan(), {
        QWEN_CODE_PROJECT_DIR: join(dir, 'gone'),
        QWEN_CODE_SESSION_ID: 'S1',
      }),
    ).toThrow(TranscriptsUnavailableError);
  });

  it('refuses to look anywhere the CLI did not point it', () => {
    // No env, no answer. A path a caller can choose is a path it can point
    // somewhere flattering.
    expect(() => coverageFromTranscripts(plan(), {})).toThrow(
      TranscriptsUnavailableError,
    );
  });

  it('does not count "functionCall" appearing in a tool OUTPUT as a tool call', () => {
    // Structural part inspection, not a substring over the serialized record.
    // (JSON.stringify escapes quotes inside text, so a naive substring happens to
    // be safe for well-formed records — but reading the parts is correct by
    // construction rather than by that accident, and this pins the behaviour.)
    const base = {
      agentId: 'a1',
      agentName: 'general-purpose',
      sessionId: 'S1',
    };
    const lines = [
      JSON.stringify({
        ...base,
        type: 'user',
        message: { role: 'user', parts: [{ text: good(1) }] },
      }),
      // No real functionCall part — only text that mentions the words.
      JSON.stringify({
        ...base,
        type: 'assistant',
        message: {
          role: 'model',
          parts: [
            {
              text: 'The diff adds `parts.some(p => p.functionCall)` and a functionResponse handler.',
            },
          ],
        },
      }),
    ];
    writeFileSync(
      join(dir, 'subagents', 'S1', 'agent-a1.jsonl'),
      lines.join('\n') + '\n',
    );
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(plan(), ENV);
    // a1 made no real call → idle, not covered.
    expect(r.idleAgents).toEqual(['chunk 1']);
    expect(r.coveredChunks).toEqual([2]);
  });

  it('does not treat a tool output containing "error": as a failed call', () => {
    // The response *object* is what says whether the call failed. A tool whose
    // OUTPUT happens to contain that text — a JSON payload with `error: null`, a
    // log line, this very file quoted back in a diff — is a working agent, and
    // marking it idle would blame it for the diff it read.
    const base = {
      agentId: 'a1',
      agentName: 'general-purpose',
      sessionId: 'S1',
    };
    const lines = [
      JSON.stringify({
        ...base,
        type: 'user',
        message: { role: 'user', parts: [{ text: good(1) }] },
      }),
      JSON.stringify({
        ...base,
        type: 'assistant',
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'read_file',
                args: { file_path: DIFF, offset: 0, limit: 100 },
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
                // `error: null` means *no* error. A coarse `/"error":/` over the
                // stringified record matches this and marks a working agent idle.
                response: { output: 'diff bytes', error: null },
              },
            },
          ],
        },
      }),
      JSON.stringify({
        ...base,
        type: 'assistant',
        message: { role: 'model', parts: [{ text: 'Reviewed.' }] },
      }),
    ];
    writeFileSync(
      join(dir, 'subagents', 'S1', 'agent-a1.jsonl'),
      lines.join('\n') + '\n',
    );
    transcript('a2', good(2), { calls: 1 });

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.idleAgents).toEqual([]); // it worked
    expect(r.coveredChunks).toEqual([1, 2]);
  });

  it('does not call an agent "not blind" for a read_file that never named the diff', () => {
    // A prompt that points the agent at source files but never at the diff is
    // exactly as blind as one that names no file at all — and a bare `read_file(`
    // anywhere in it used to be enough to pass. It would then be reported as a
    // whiff, sending the reader to relaunch an agent whose *prompt* is the defect.
    transcript(
      'a1',
      'Review chunk 1 of 2. Start with read_file(file_path="/src/pay.ts").',
      { calls: 0 },
    );
    transcript('a2', good(2), { calls: 1 });

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.blindAgents).toEqual(['chunk 1']);
    expect(r.idleAgents).toEqual([]); // not a whiff — it could not have read it
  });

  it('refuses a plan whose chunk ids are not ids', () => {
    for (const chunks of [
      [{ id: 0, startLine: 1, endLine: 10 }],
      [{ id: 1.5, startLine: 1, endLine: 10 }],
      [{ id: -2, startLine: 1, endLine: 10 }],
    ]) {
      const p = join(dir, 'bad-ids.json');
      writeFileSync(p, JSON.stringify({ diffPathAbsolute: DIFF, chunks }));
      expect(() => coverageFromTranscripts(p, ENV)).toThrow(
        /positive integer id/,
      );
    }
  });

  it('refuses a plan with duplicate chunk ids', () => {
    const p = join(dir, 'dupe.json');
    writeFileSync(
      p,
      JSON.stringify({
        diffPathAbsolute: DIFF,
        chunks: [
          { id: 1, startLine: 1, endLine: 10 },
          { id: 1, startLine: 11, endLine: 20 },
        ],
      }),
    );
    expect(() => coverageFromTranscripts(p, ENV)).toThrow(/duplicate chunk/);
  });

  it('does not credit a zero-tool-call agent that copied the Uncoverable line', () => {
    // `Uncoverable: chunk N` is a line the prompt hands the agent. An honest one
    // means the agent read the chunk and found a line too long to reach; a
    // whiff can copy it verbatim without reading anything. The idle check must
    // win, or the whiff passes wearing a costume.
    transcript('a1', good(1), {
      calls: 0,
      text: 'Uncoverable: chunk 1 — line exceeds the read limit',
    });
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.idleAgents).toEqual(['chunk 1']); // idle, NOT a disclosed gap
    expect(r.uncoverableChunks).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it('an uncoverable chunk is a gap, not coverage — ok stays false', () => {
    // A working agent legitimately declares its chunk unreachable. That is a
    // disclosed gap: the diff was not reviewed, and the verdict may not approve
    // on its strength. The old formula left `ok` true.
    transcript('a1', good(1), { calls: 2 });
    transcript('a2', good(2), {
      calls: 1,
      text: 'Uncoverable: chunk 2 — line exceeds the read limit',
    });

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.uncoverableChunks).toEqual([2]);
    expect(r.missingChunks).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it('a whole-diff agent that made no chunk claim does not gate the chunks', () => {
    // Build & Test / Issue Fidelity have no `chunk N of M` in their prompt. They
    // are not blind (no chunk to be blind to) and, having made real tool calls,
    // are not idle. They simply contribute no chunk coverage.
    transcript('build', 'Run the build and tests for this PR.', { calls: 4 });
    transcript('a1', good(1), { calls: 2 });
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.ok).toBe(true);
    expect(r.blindAgents).toEqual([]);
    expect(r.coveredChunks).toEqual([1, 2]);
  });

  it('refuses a plan that is not one', () => {
    const p = join(dir, 'bad.json');
    writeFileSync(p, JSON.stringify({}));
    expect(() => coverageFromTranscripts(p, ENV)).toThrow(/diffPathAbsolute/);
  });
});

// The topology most pull requests get, and the one this file could not see at all.
describe('Step 3A — dimension agents, no territory, no receipts', () => {
  it('credits the chunks a whole-diff agent was pointed at and opened', () => {
    // Not one Step 3A prompt says `chunk N of M` — every dimension agent walks the
    // whole diff. Attributing coverage from that phrase meant attributing none:
    // against a real 3A review whose fifteen agents each opened the diff and filed
    // findings, this returned `0/2 chunk(s) reviewed … Nobody read those lines`,
    // in the same breath as `16 agent(s) ran; 16 did work`. `compose-review` runs
    // the same computation, so the verdict was capped away from Approve and the
    // body it would have POSTED to the PR said nobody had read it.
    transcript('sec', wholeDiff(), { calls: 8 });
    transcript('perf', wholeDiff(), { calls: 5 });

    const r = coverageFromTranscripts(plan3a(), ENV);
    expect(r.coveredChunks).toEqual([1, 2]);
    expect(r.missingChunks).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('does not credit a chunk to an agent that was never pointed at it', () => {
    // Half the diff delivered is half the diff reviewed. An agent given only the
    // first chunk's read does not cover the second by having the file open.
    transcript(
      'half',
      `Security review.\nread_file(file_path="${DIFF}", offset=0, limit=100)`,
      { calls: 4 },
    );

    const r = coverageFromTranscripts(plan3a(), ENV);
    expect(r.coveredChunks).toEqual([1]);
    expect(r.missingChunks).toEqual([2]);
    expect(r.ok).toBe(false);
  });
});

describe('worked, but not on the diff', () => {
  it('catches the agent that was pointed at the diff and never opened it', () => {
    // The old bar was one successful tool call, and a `glob` for test files is a
    // successful tool call. This agent read the post-change source instead — which
    // on a diff with deletions shows it precisely nothing: the removed line is not
    // in that file, and nothing marks where it was.
    const base = {
      agentId: 'a1',
      agentName: 'general-purpose',
      sessionId: 'S1',
    };
    writeFileSync(
      join(dir, 'subagents', 'S1', 'agent-a1.jsonl'),
      [
        JSON.stringify({
          ...base,
          type: 'user',
          message: { role: 'user', parts: [{ text: good(1) }] },
        }),
        JSON.stringify({
          ...base,
          type: 'assistant',
          message: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'c1',
                  name: 'read_file',
                  args: { file_path: '/src/pay.ts' }, // the source, not the diff
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
                  id: 'c1',
                  name: 'read_file',
                  response: { output: 'source bytes' },
                },
              },
            ],
          },
        }),
        JSON.stringify({
          ...base,
          type: 'assistant',
          message: { role: 'model', parts: [{ text: 'Reviewed chunk 1.' }] },
        }),
      ].join('\n') + '\n',
    );
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.idleAgents).toEqual([]); // it made a successful call
    expect(r.unopenedAgents).toEqual(['chunk 1']);
    expect(r.coveredChunks).toEqual([2]);
    expect(r.ok).toBe(false);
  });
});

// The failure no other check in this file can see. Every other question is asked of
// an agent that ran; an agent that never ran leaves no transcript to ask.
describe('the roster — who should have been here', () => {
  it('catches the dimension whose brief never reached an agent', () => {
    // Dogfooded, a real PR review simply never launched Agent 0 — issue fidelity —
    // and nothing in the run could tell. The other eight dimensions ran and did
    // real work, so every check passed, and the review certified a diff whose
    // "does this even fix the thing it claims to" question nobody asked.
    const p = planPr();
    // Un-launch one of them: delete its record and its transcript.
    rmSync(join(promptRecordDir(p), '1c.txt'), { force: true });
    rmSync(join(dir, 'subagents', 'S1', 'agent-r-1c.jsonl'), { force: true });
    transcript('sec', wholeDiff(), { calls: 8 }); // somebody covered the chunks

    const r = coverageFromTranscripts(p, ENV);
    expect(r.missingRoles).toHaveLength(1);
    expect(r.missingRoles[0]).toContain('Cross-file tracer');
    expect(r.ok).toBe(false);
    // And it is not confused with the agents that *did* run.
    expect(r.idleAgents).toEqual([]);
    expect(r.coveredChunks).toEqual([1, 2]);
  });

  it('does not claim the agent never ran — it cannot see that, and it has been wrong', () => {
    // A missing record proves the *brief* never arrived. It does not prove nobody
    // reviewed the dimension: an orchestrator that writes the launch by hand gets an
    // agent that runs, reads the diff and reports real findings, having never seen
    // the severity bar the brief carries. On #7012 this gate told a PR author twelve
    // dimensions "never ran" on a review that had just posted two Criticals with
    // line numbers — the agents were right there in the same comment. Both failures
    // are worth reporting; only one of them is provable from a missing file.
    const p = planPr();
    rmSync(join(promptRecordDir(p), '1c.txt'), { force: true });
    rmSync(join(dir, 'subagents', 'S1', 'agent-r-1c.jsonl'), { force: true });
    transcript('sec', wholeDiff(), { calls: 8 });

    const [gap] = coverageFromTranscripts(p, ENV).missingRoles;
    expect(gap).not.toMatch(/never (ran|launched)/i);
    expect(gap).toContain('brief never reached an agent');
    // And it says what the reader loses, rather than leaving them to guess.
    expect(gap).toContain('if at all');
  });

  it('says one thing once when no role was briefed, not the same thing per dimension', () => {
    // The whole public CHANGES_REQUESTED body on #7012 was twelve of these, one per
    // dimension, naming an internal command the PR author cannot run — while the
    // findings that needed acting on sat inline, below the fold. Twelve lines also
    // bury the single fact that explains all twelve: the run never used the prompt
    // builder at all.
    const p = planPr();
    for (const f of readdirSync(promptRecordDir(p))) {
      rmSync(join(promptRecordDir(p), f), { force: true });
    }
    transcript('sec', wholeDiff(), { calls: 8 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.ok).toBe(false);
    expect(r.missingRoles).toHaveLength(1);
    // It reads under the `Not reviewed: ` prefix compose-review renders it with.
    expect(r.missingRoles[0]).toMatch(/^every dimension — /);
    const roster = requiredAgents(
      JSON.parse(readFileSync(p, 'utf8')) as RosterPlan,
    );
    expect(r.missingRoles[0]).toContain(`${roster.length} required`);
    expect(roster.length).toBeGreaterThan(1); // or there is nothing to collapse
    // The author is told what they lost, not which internal command to go run.
    expect(r.missingRoles[0]).not.toContain('agent-prompt');
    expect(r.missingRoles[0]).not.toMatch(/--role/);
  });

  it('tells the operator where it looked, so a wrong --plan is not a missing file', () => {
    // "The builder never ran" and "the builder ran against a different --plan" reach
    // this check as the same thing: an absent record. They are fixed differently, so
    // the report has to hand over the one fact that separates them. The record dir
    // hangs off the plan path as given — a relative --plan resolves against the
    // caller's cwd, and the skill runs Steps 2-6 from inside the worktree, so the
    // two are not always the same directory. This goes to stderr, which the
    // orchestrator reads; the PR author never sees a path to a temp dir.
    const p = planPr();
    for (const f of readdirSync(promptRecordDir(p))) {
      rmSync(join(promptRecordDir(p), f), { force: true });
    }
    transcript('sec', wholeDiff(), { calls: 8 });

    const prevDir = process.env['QWEN_CODE_PROJECT_DIR'];
    const prevSession = process.env['QWEN_CODE_SESSION_ID'];
    process.env['QWEN_CODE_PROJECT_DIR'] = ENV['QWEN_CODE_PROJECT_DIR'];
    process.env['QWEN_CODE_SESSION_ID'] = ENV['QWEN_CODE_SESSION_ID'];
    const prevExit = process.exitCode;
    try {
      vi.mocked(writeStderrLine).mockClear();
      (checkCoverageCommand.handler as (a: Record<string, unknown>) => void)({
        plan: p,
        out: join(dir, 'cov.json'),
      });

      const roleError = vi
        .mocked(writeStderrLine)
        .mock.calls.map((c) => String(c[0]))
        .find((l) => l.includes('required briefs never reached'));
      expect(roleError).toBeDefined();
      expect(roleError).toContain(`Looked for them in: ${promptRecordDir(p)}`);
    } finally {
      process.exitCode = prevExit;
      if (prevDir === undefined) delete process.env['QWEN_CODE_PROJECT_DIR'];
      else process.env['QWEN_CODE_PROJECT_DIR'] = prevDir;
      if (prevSession === undefined) delete process.env['QWEN_CODE_SESSION_ID'];
      else process.env['QWEN_CODE_SESSION_ID'] = prevSession;
    }
  });

  it('formats the partial case on stderr: one role missing, the rest briefed', () => {
    // The all-briefless collapse has a handler test; the partial shape reached
    // stderr only through the pure function. A formatting regression here — a
    // broken join, a lost `--roster` hint, a garbled `Looked for them in:` path —
    // would ship unseen, and stderr is the interface the orchestrator acts on.
    const p = planPr();
    rmSync(join(promptRecordDir(p), '1c.txt'), { force: true });
    rmSync(join(dir, 'subagents', 'S1', 'agent-r-1c.jsonl'), { force: true });
    transcript('sec', wholeDiff(), { calls: 8 });

    const prevDir = process.env['QWEN_CODE_PROJECT_DIR'];
    const prevSession = process.env['QWEN_CODE_SESSION_ID'];
    process.env['QWEN_CODE_PROJECT_DIR'] = ENV['QWEN_CODE_PROJECT_DIR'];
    process.env['QWEN_CODE_SESSION_ID'] = ENV['QWEN_CODE_SESSION_ID'];
    const prevExit = process.exitCode;
    try {
      vi.mocked(writeStderrLine).mockClear();
      (checkCoverageCommand.handler as (a: Record<string, unknown>) => void)({
        plan: p,
        out: join(dir, 'cov.json'),
      });

      const roleError = vi
        .mocked(writeStderrLine)
        .mock.calls.map((c) => String(c[0]))
        .find((l) => l.includes('required briefs never reached'));
      expect(roleError).toBeDefined();
      // The per-role shape, not the collapse: it names the one missing agent.
      expect(roleError).toContain('Cross-file tracer');
      expect(roleError).toContain('its brief never reached an agent');
      expect(roleError).not.toContain('every dimension');
      // The rebuild hints and the record dir survive the formatting.
      expect(roleError).toContain(
        '"${QWEN_CODE_CLI:-qwen}" review agent-prompt --plan <plan> --roster',
      );
      expect(roleError).toContain(`Looked for them in: ${promptRecordDir(p)}`);
    } finally {
      process.exitCode = prevExit;
      if (prevDir === undefined) delete process.env['QWEN_CODE_PROJECT_DIR'];
      else process.env['QWEN_CODE_PROJECT_DIR'] = prevDir;
      if (prevSession === undefined) delete process.env['QWEN_CODE_SESSION_ID'];
      else process.env['QWEN_CODE_SESSION_ID'] = prevSession;
    }
  });

  it('catches a prompt that was built and then never used', () => {
    // Half of the failure: the command was called, so the record exists — but the
    // agent was launched with something else, or not launched at all.
    const p = plan3a();
    rmSync(join(dir, 'subagents', 'S1', 'agent-r-2.jsonl'), { force: true });
    transcript('sec', wholeDiff(), { calls: 8 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.missingRoles).toEqual([
      'Agent 2: Security — its prompt was built, but no agent was launched with it',
    ]);
    expect(r.ok).toBe(false);
  });

  it('does not credit a brief opened as a `.bak` sibling', () => {
    // The brief-open check matches the whole quoted path, not a bare substring, so
    // an agent that opened `<brief>.bak` — a real path with the brief as a strict
    // prefix — is not credited with opening the brief. A bare `includes(brief)`
    // would have counted it and cleared the gap.
    const p = plan3a();
    const brief = briefPath(p, '2'); // Agent 2 (Security), a roster whole-diff role
    const prompt = readFileSync(join(promptRecordDir(p), '2.txt'), 'utf8');
    // Relaunch it opening the `.bak` sibling instead of the brief itself.
    transcript('r-2', prompt, { calls: 2, opens: [`${brief}.bak`] });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.unreadBriefs.some((s) => s.includes('Security'))).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('does not demand a build-and-test agent from a diff with no tree to build', () => {
    // A cross-repo lightweight review has the diff and nothing else. Requiring
    // Agent 7 or the cross-file tracer of it would fail every such review for not
    // doing something it cannot do.
    const p = plan3a();
    transcript('sec', wholeDiff(), { calls: 8 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.missingRoles).toEqual([]);
    expect(r.ok).toBe(true);
    // The same plan WITH a worktree does demand them.
    expect(
      requiredAgents(
        JSON.parse(readFileSync(planPr(), 'utf8')) as RosterPlan,
      ).map((a) => a.key),
    ).toEqual(expect.arrayContaining(['0', '1c', '7']));
  });
});

describe('the prompt the CLI built, against the prompt the agent got', () => {
  it('catches a paraphrase — the diff path survives it, so nothing else can', () => {
    // Dogfooded: the orchestrator called `agent-prompt` for all five chunks and
    // then rewrote what it printed. The delivered prompt dropped the rule against
    // reciting a stock sentence, dropped the half-read warning, and replaced the
    // project's review rules with three sentences of its own — while keeping the
    // `read_file` line, so every other check in this file passed it.
    const p = plan();
    // What the CLI built, in miniature: the read, the rule the whole command
    // exists to deliver, and the project's rules.
    built(
      p,
      1,
      `You are reviewing chunk 1 of 2.\n` +
        `read_file(file_path="${DIFF}", offset=0, limit=100)\n` +
        `Do not recite a stock sentence: a return that names nothing you read is ` +
        `indistinguishable from never having read anything.\n` +
        `## Project rules\nEvery added field must have its read sites grepped.`,
    );
    // What the agent got: the read survived, the rules became a summary, and the
    // sentence that stops a whiff is gone — replaced by a receipt to recite.
    transcript(
      'a1',
      `You are reviewing chunk 1 of 2.\n` +
        `read_file(file_path="${DIFF}", offset=0, limit=100)\n` +
        `Project rules: grep read sites. Match house style.\n` +
        `If you find no issues, say "No issues found — reviewed chunk 1".`,
      { calls: 3 },
    );
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.rewrittenPrompts).toEqual([
      'chunk 1 — launched with a prompt that is not the one the CLI built',
    ]);
    // It still read the diff, so the chunk is covered — the review is not blind,
    // it is unfaithful. Both facts are reported, and the run does not certify.
    expect(r.coveredChunks).toEqual([1, 2]);
    expect(r.ok).toBe(false);
  });

  it('catches a chunk prompt the CLI was never asked to build', () => {
    const p = plan(2, { record: false });
    transcript('a1', good(1), { calls: 3 });
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.rewrittenPrompts).toHaveLength(2);
    expect(r.rewrittenPrompts[0]).toContain('a prompt the run wrote itself');
    // No internal command in the label: compose-review pushes it into the posted
    // body as-is, and `agent-prompt` is not something a PR author can run. The
    // rebuild command rides the remediation channel instead.
    expect(r.rewrittenPrompts[0]).not.toMatch(/agent-prompt|--chunk/);
    expect(r.ok).toBe(false);
  });

  it('allows a wrapper around the built prompt, but not an edit of it', () => {
    // Containment, not equality: prefixing "You are reviewing PR #6766." is
    // harmless, and failing a run over trailing whitespace would teach the reader
    // to distrust the check.
    const p = plan();
    transcript('a1', `Context: PR #6766.\n\n${good(1)}  \n\nGo.`, { calls: 3 });
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.rewrittenPrompts).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe('an agent that paged its chunk still read it', () => {
  it('merges paged reads before asking whether a chunk was covered', () => {
    // The prompt tells an agent to page when a read comes back `isTruncated` — and
    // an oversized chunk gives it no choice. Two reads of 1-100 and 101-200 are one
    // walk of 1-200; requiring a single range to contain the chunk would have
    // contradicted the instruction the same review had just given.
    const p = plan3a();
    const brief = briefPath(p, '2');
    writeFileSync(brief, 'brief');
    const launch =
      `Security review.\n` + `read_file(file_path="${brief}")\n` + DIFF;
    writeFileSync(join(promptRecordDir(p), '2.txt'), launch);
    // No offsets in the prompt: this agent is credited only by what it READ.
    const base = {
      agentId: 'pg',
      agentName: 'general-purpose',
      sessionId: 'S1',
    };
    const call = (id: string, args: Record<string, unknown>) => [
      JSON.stringify({
        ...base,
        type: 'assistant',
        message: {
          role: 'model',
          parts: [{ functionCall: { id, name: 'read_file', args } }],
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
                id,
                name: 'read_file',
                response: { output: 'bytes' },
              },
            },
          ],
        },
      }),
    ];
    writeFileSync(
      join(dir, 'subagents', 'S1', 'agent-pg.jsonl'),
      [
        JSON.stringify({
          ...base,
          type: 'user',
          message: { role: 'user', parts: [{ text: launch }] },
        }),
        ...call('c0', { file_path: brief }),
        // chunk 1 is lines 1-100 — read in two pages, neither of which contains it.
        ...call('c1', { file_path: DIFF, offset: 0, limit: 50 }),
        ...call('c2', { file_path: DIFF, offset: 50, limit: 50 }),
        // and chunk 2 (101-200) whole, so the run is complete.
        ...call('c3', { file_path: DIFF, offset: 100, limit: 100 }),
        JSON.stringify({
          ...base,
          type: 'assistant',
          message: { role: 'model', parts: [{ text: 'Reviewed.' }] },
        }),
      ].join('\n') + '\n',
    );

    const r = coverageFromTranscripts(p, ENV);
    expect(r.coveredChunks).toEqual([1, 2]);
    expect(r.missingChunks).toEqual([]);
  });
});

describe('verificationGaps — Step 4 and Step 5 ran, and read their briefs', () => {
  // A Step 4/5 agent as a real run leaves it: the CLI's record of the prompt it
  // built (`agent-prompt --role <role>`), the brief that prompt points at, and the
  // harness's transcript of an agent launched with it. The opts model each way
  // delivery fails: `launch: false` — built, never handed to an agent;
  // `opensBrief: false` — launched with the built prompt, never opened the brief;
  // `rewritten: true` — an agent ran and opened the brief, but the orchestrator
  // wrote the launch itself (the real 3A run this precision exists for). To model a
  // step skipped wholesale, do not set the key up at all.
  function step45(
    planPath: string,
    key: string,
    opts: { launch?: boolean; opensBrief?: boolean; rewritten?: boolean } = {},
  ): void {
    const d = promptRecordDir(planPath);
    mkdirSync(d, { recursive: true });
    const brief = briefPath(planPath, key);
    writeFileSync(brief, `The ${key} brief.`);
    const prompt =
      `You are review agent \`${key}\`.\n` +
      `read_file(file_path="${brief}")\n` +
      `read_file(file_path="${DIFF}")`;
    writeFileSync(join(d, `${encodeURIComponent(key)}.txt`), prompt);
    if (opts.launch === false) return;
    const id = `v-${key.replace(/[^a-z0-9]/gi, '_')}`;
    if (opts.rewritten) {
      // Kept the brief pointer, threw the rest away and wrote its own preamble —
      // verbatim word-for-word from a real run's transcript.
      transcript(
        id,
        `You are performing a reverse audit of PR #1, which hardens things. ` +
          `**Your brief is a file. Read it first.**\n` +
          `read_file(file_path="${brief}")`,
        { calls: 2, opens: [brief] },
      );
      return;
    }
    transcript(id, prompt, {
      calls: 2,
      opens: opts.opensBrief === false ? [] : [brief],
    });
  }

  it('passes when the reverse audit ran on a review with nothing to verify', () => {
    const p = plan();
    step45(p, 'reverse-audit');
    const r = verificationGaps(p, { postsFindings: false }, ENV);
    expect(r.ok).toBe(true);
    expect(r.gaps).toEqual([]);
  });

  it('passes when both verify and reverse audit ran on a review with findings', () => {
    const p = plan();
    step45(p, 'reverse-audit');
    step45(p, 'verify');
    expect(verificationGaps(p, { postsFindings: true }, ENV).ok).toBe(true);
  });

  it('flags a review that never built the reverse-audit prompt', () => {
    const p = plan(); // no reverse-audit fixture: the step was skipped
    const r = verificationGaps(p, { postsFindings: false }, ENV);
    expect(r.ok).toBe(false);
    const gap = r.gaps.join(' ');
    expect(gap).toMatch(
      /reverse audit — no auditor was launched with a prompt this skill builds/,
    );
    // Not "no auditor ran": this shape is decided before the transcripts are
    // consulted (a hand-written launch leaves no brief to open), so the check
    // cannot see such an auditor — and it may not claim to. Say what a missing
    // record proves, and what it costs.
    expect(gap).not.toMatch(/no auditor ran/);
    expect(gap).toContain('if at all');
  });

  it('names a rewritten launch as itself, not as an agent that never ran', () => {
    // The real 3A run this precision exists for: two auditors ran, made 16 and 23
    // tool calls, and opened their brief — the orchestrator had simply written the
    // launch itself. The old message said "no agent was launched with it that opened
    // its brief", which was false as written; the orchestrator read it, called it a
    // "transcript visibility issue", and reported an Approve over the capped verdict.
    const p = plan();
    step45(p, 'reverse-audit', { rewritten: true });
    const r = verificationGaps(p, { postsFindings: false }, ENV);
    expect(r.ok).toBe(false);
    const gap = r.gaps.join(' ');
    // It says what happened: an auditor ran …
    expect(gap).toMatch(/an auditor ran/);
    // … and what was actually wrong.
    expect(gap).toMatch(/not with the prompt this skill builds/);
    expect(gap).toMatch(/written by hand/);
    // And it must NOT claim the agent never ran or never read its brief.
    expect(gap).not.toMatch(/no auditor ran/);
    expect(gap).not.toMatch(/never opened its brief/);
    // The fix travels beside the gap, not inside it: the gap lands in the posted
    // body, whose reader cannot run `agent-prompt`, and the remediation goes to
    // stderr, whose reader can. #7012's public body was fourteen lines of the
    // second register posted to the first reader.
    expect(gap).not.toMatch(/agent-prompt|--findings|--role/);
    const fix = r.remediation.join(' ');
    expect(fix).toContain(
      '"${QWEN_CODE_CLI:-qwen}" review agent-prompt ' +
        '--plan <plan> --role reverse-audit --findings <file>',
    );
    expect(fix).toMatch(/no round number/);
  });

  it('names a rewritten verifier launch as itself too', () => {
    const p = plan();
    step45(p, 'reverse-audit');
    step45(p, 'verify', { rewritten: true });
    const r = verificationGaps(p, { postsFindings: true }, ENV);
    const gap = r.gaps.join(' ');
    expect(gap).toMatch(/a verifier ran/);
    expect(gap).toMatch(/not with the prompt this skill builds/);
    expect(gap).not.toMatch(/no verifier ran/);
    expect(gap).not.toMatch(/agent-prompt|--findings|--role/);
    expect(r.remediation.join(' ')).toContain('--role verify');
  });

  it('flags a reverse audit built but whose agent never opened its brief', () => {
    const p = plan();
    step45(p, 'reverse-audit', { opensBrief: false });
    const r = verificationGaps(p, { postsFindings: false }, ENV);
    expect(r.ok).toBe(false);
    expect(r.gaps.join(' ')).toMatch(
      /reverse audit — it was launched with the built prompt but never opened its brief/,
    );
  });

  it('flags a reverse audit whose prompt was built but never launched', () => {
    const p = plan();
    step45(p, 'reverse-audit', { launch: false });
    const r = verificationGaps(p, { postsFindings: false }, ENV);
    expect(r.ok).toBe(false);
    expect(r.gaps.join(' ')).toMatch(
      /reverse audit — its prompt was built, but no agent was launched with it/,
    );
  });

  it('counts a Step 3B per-chunk reverse auditor (reverse-audit--chunk-N)', () => {
    const p = plan();
    step45(p, 'reverse-audit--chunk-1');
    const r = verificationGaps(p, { postsFindings: false }, ENV);
    expect(r.gaps.join(' ')).not.toMatch(/reverse audit/);
  });

  it('requires a verifier when the review posts findings', () => {
    const p = plan();
    step45(p, 'reverse-audit'); // isolate the verify gap
    const r = verificationGaps(p, { postsFindings: true }, ENV);
    expect(r.ok).toBe(false);
    expect(r.gaps.join(' ')).toMatch(
      /verification — the review posts findings/,
    );
  });

  it('does not require a verifier when the review confirmed nothing', () => {
    const p = plan();
    step45(p, 'reverse-audit');
    const r = verificationGaps(p, { postsFindings: false }, ENV);
    expect(r.gaps.join(' ')).not.toMatch(/verification/);
  });

  it('flags a verifier built but whose agent never opened its brief', () => {
    const p = plan();
    step45(p, 'reverse-audit');
    step45(p, 'verify', { opensBrief: false });
    const r = verificationGaps(p, { postsFindings: true }, ENV);
    expect(r.gaps.join(' ')).toMatch(
      /verification — it was launched with the built prompt but never opened its brief/,
    );
  });

  it('flags a verifier whose prompt was built but never launched', () => {
    // The other half of `ranAndReadBrief`: `built.get('verify')` returns content,
    // but no transcript matches it. Same gap message as opensBrief:false, but it
    // fails at the transcript-matching term, not the brief-open one.
    const p = plan();
    step45(p, 'reverse-audit');
    step45(p, 'verify', { launch: false });
    const r = verificationGaps(p, { postsFindings: true }, ENV);
    expect(r.gaps.join(' ')).toMatch(
      /verification — its prompt was built, but no agent was launched with it/,
    );
  });
});
