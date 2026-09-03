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
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  coverageFromTranscripts,
  verificationGaps,
  TranscriptsUnavailableError,
  assertChunkPartition,
  type ChunkCoverageItem,
} from './lib/coverage.js';
import { buildSelectionIdentity, planIdentityToken } from './lib/selection.js';
import { READ_FILE_CHAR_CAP, type DiffChunk } from './lib/diff-plan.js';
import {
  promptRecordDir,
  briefPath,
  findingsFilePath,
} from './lib/prompt-record.js';
import { requiredAgents, type RosterPlan } from './lib/roster.js';
import { buildWholeDiffBlock } from './agent-prompt.js';
import { checkCoverageCommand } from './check-coverage.js';
import { appendRunSession, recordResume } from './lib/run-ledger.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import * as coverageModule from './lib/coverage.js';
import { CHUNK_RE } from './lib/coverage.js';
import {
  chunkAssignmentFromLaunchPrompt,
  labelFromLaunchPrompt,
} from './lib/agent-identity.js';

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
  opts: {
    record?: boolean;
    roster?: boolean;
    /** Id of a chunk carrying one line longer than the read cap. */
    longLineChunk?: number;
    /**
     * Longest-line measurement for every other chunk. Defaults to the
     * hand-zeroed shape, which admission and refutation fail open on.
     */
    maxLineChars?: number;
  } = {},
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
        // The planner's own pre-detection of a chunk no read can span —
        // written unconditionally (the field has shipped with every plan
        // since the format's first release), so the fixtures carry it too.
        // A plan WITHOUT it models a hand-edited plan, not a legacy one.
        maxLineChars:
          opts.longLineChunk === i + 1
            ? READ_FILE_CHAR_CAP + 1
            : (opts.maxLineChars ?? 0),
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
    /**
     * Paths the agent's only contact with is NAMING them in a successful
     * non-read tool's args — a search, not an open. Models the agent that
     * clears a path-shaped floor without reading the file.
     */
    mentions?: string[];
    /**
     * `[offset, limit]` for the diff reads, making them RANGED — the shape
     * a compliant agent's reads take, and the only shape `diffReads`
     * records. The budget-gap tests need it: a disclosing agent's chunk
     * credit narrows to its ranged reads.
     */
    range?: [number, number];
    /**
     * Several ranged diff reads, one call each — the paging shape.
     * Overrides `range` and sizes the call count.
     */
    ranges?: Array<[number, number]>;
    /**
     * The path the reads target. Defaults to the module's diff constant;
     * the drift fixture binds its plan to a real file of its own.
     */
    toolPath?: string;
  } = {},
): void {
  const base = { agentId: id, agentName: 'general-purpose', sessionId: 'S1' };
  const pointedAtBriefs = [
    ...launchPrompt.matchAll(/read_file\(file_path="([^"]*\.brief\.md)"\)/g),
  ].map((m) => m[1]);
  // An agent that did nothing opened nothing — not even its brief. The default
  // models a *working* agent, which is the only kind that reads what it is pointed
  // at; a whiff and a failed run leave the briefs unread, as they do the diff.
  const callCount = opts.ranges ? opts.ranges.length : (opts.calls ?? 0);
  const working = callCount > 0 && !opts.failed;
  const opens = opts.opens ?? (working ? pointedAtBriefs : []);
  const lines = [
    JSON.stringify({
      ...base,
      type: 'user',
      message: { role: 'user', parts: [{ text: launchPrompt }] },
    }),
  ];
  for (let i = 0; i < callCount; i++) {
    const rg = opts.ranges ? opts.ranges[i] : opts.range;
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
                args: rg
                  ? {
                      file_path: opts.toolPath ?? DIFF,
                      offset: rg[0],
                      limit: rg[1],
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
  for (const path of opts.mentions ?? []) {
    lines.push(
      JSON.stringify({
        ...base,
        type: 'assistant',
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'search_file_content',
                args: { path, pattern: 'Critical' },
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
                name: 'search_file_content',
                response: { output: '1 match' },
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
  `You are review agent \`chunk ${c} of 2\` — the territory agent for ` +
  `lines ${(c - 1) * 100 + 1}-${c * 100} of the diff.\n` +
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
  `You are review agent \`chunk ${c} of 2\` — the territory agent for ` +
  `lines ${(c - 1) * 100 + 1}-${c * 100} of the diff.`;

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
      'You are review agent `chunk 1 of 2` — the territory agent.\n' +
        'Start with read_file(file_path="/src/pay.ts").',
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

describe('budget-gap disclosures — guarded, parsed, never punished', () => {
  it("collects a working agent's gaps under its coverage label", () => {
    transcript('a1', good(1), {
      calls: 3,
      range: [0, 100],
      text:
        'No issues found — reviewed chunk 1 end to end.\n' +
        'Budget gap: callers of parseArgs outside packages/cli\n' +
        '- Budget gap: the removed retry path in fetch-pr',
    });
    transcript('a2', good(2), { calls: 2, range: [100, 100] });

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.budgetGaps).toEqual([
      {
        agent: 'chunk 1',
        gaps: [
          'callers of parseArgs outside packages/cli',
          'the removed retry path in fetch-pr',
        ],
      },
    ]);
    // The load-bearing half: this agent READ its territory (the ranged
    // read), so its disclosure costs nothing — coverage stands and the gate
    // passes. Failing on disclosure teaches agents not to disclose; the
    // ruling on each gap belongs to the orchestrator, exactly as with
    // whiffs.
    expect(r.coveredChunks).toContain(1);
    expect(r.ok).toBe(true);
  });

  it("labels a non-chunk discloser by its brief codename, not the prompt's first line", () => {
    // Launchers prepend context: twelve live finders shared one PR-summary
    // first line, so every disclosure rendered the same truncated PR quote
    // instead of a name. The codename line names the agent wherever it sits.
    transcript(
      '6c',
      'PR #9045 modifies getAuthTypeFromEnv() to infer auth.\n\nYou are review agent `6c` — Agent 6c: Undirected audit.\n' +
        wholeDiff(),
      {
        calls: 4,
        text: 'Walked the diff.\nBudget gap: second-order callers of getAuthTypeFromEnv',
      },
    );

    const r = coverageFromTranscripts(plan3a(), ENV);
    expect(r.budgetGaps).toEqual([
      {
        agent: 'agent 6c',
        gaps: ['second-order callers of getAuthTypeFromEnv'],
      },
    ]);
  });

  it('a whole-diff disclosure is silenced only by a compliant gap-free relaunch', () => {
    // `gapsSuperseded`'s whole-diff branch: the superseding record must have
    // OPENED the key's brief and be gap-free itself. Neither conjunct was
    // reached by any test — a revert of the branch shipped green.
    const p = plan3a();
    const d = promptRecordDir(p);
    mkdirSync(d, { recursive: true });
    const brief = briefPath(p, 'audit-w');
    writeFileSync(brief, 'The audit-w brief.');
    const prompt =
      'You are review agent `audit-w`.\n' +
      `read_file(file_path="${brief}")\n` +
      wholeDiff();
    writeFileSync(join(d, 'audit-w.txt'), prompt);
    transcript('g1', prompt, {
      calls: 3,
      text: 'Walked the diff.\nBudget gap: the reconnect state machine',
    });
    // A gap-free relaunch that opened the brief silences the disclosure.
    transcript('g2', prompt, { calls: 3 });
    expect(coverageFromTranscripts(p, ENV).budgetGaps).toEqual([]);
  });

  it('a relaunch that never opened the brief cannot silence the disclosure', () => {
    const p = plan3a();
    const d = promptRecordDir(p);
    mkdirSync(d, { recursive: true });
    const brief = briefPath(p, 'audit-w');
    writeFileSync(brief, 'The audit-w brief.');
    const prompt =
      'You are review agent `audit-w`.\n' +
      `read_file(file_path="${brief}")\n` +
      wholeDiff();
    writeFileSync(join(d, 'audit-w.txt'), prompt);
    transcript('g1', prompt, {
      calls: 3,
      text: 'Walked the diff.\nBudget gap: the reconnect state machine',
    });
    transcript('g2', prompt, { calls: 3, opens: [] });
    expect(coverageFromTranscripts(p, ENV).budgetGaps).toHaveLength(1);
  });

  it('a relaunch still disclosing gaps of its own cannot silence anything', () => {
    const p = plan3a();
    const d = promptRecordDir(p);
    mkdirSync(d, { recursive: true });
    const brief = briefPath(p, 'audit-w');
    writeFileSync(brief, 'The audit-w brief.');
    const prompt =
      'You are review agent `audit-w`.\n' +
      `read_file(file_path="${brief}")\n` +
      wholeDiff();
    writeFileSync(join(d, 'audit-w.txt'), prompt);
    transcript('g1', prompt, {
      calls: 3,
      text: 'Walked the diff.\nBudget gap: the reconnect state machine',
    });
    transcript('g2', prompt, {
      calls: 3,
      text: 'Walked again.\nBudget gap: the remaining call sites',
    });
    // Two live disclosures, neither silenced by the other.
    expect(coverageFromTranscripts(p, ENV).budgetGaps).toHaveLength(2);
  });

  it('a disclosure costs no coverage credit — the gate must not punish it', () => {
    // An earlier draft narrowed a disclosing agent's credit to its ranged
    // reads. `rangeOf` records only reads carrying a positive `limit`, so
    // a compliant offset-paged or whole-file read left an honest discloser
    // with zero credit and a hard gate failure — while an agent that
    // stopped WITHOUT disclosing kept its full credit. The `told`
    // presumption is the same for every agent; a disclosed gap changes the
    // RULING (Step 3D), never the arithmetic.
    transcript('sec', wholeDiff(), {
      calls: 1,
      text: 'Walked what I could.\nBudget gap: chunk 2 exploration depth',
    });

    const r = coverageFromTranscripts(plan3a(), ENV);
    expect(r.coveredChunks).toEqual([1, 2]);
    expect(r.ok).toBe(true);
    expect(r.budgetGaps).toHaveLength(1);
  });

  it("a gap-free compliant relaunch silences the failed attempt's gaps", () => {
    // The repair pattern: attempt 1 hits the ceiling and discloses,
    // attempt 2 (same verbatim prompt) finishes clean. Reporting attempt
    // 1's stale gaps beside the repair would keep the report from ever
    // converging — the same rule every failure flag in this file follows.
    transcript('try1', good(1), {
      calls: 2,
      text: 'Partial.\nBudget gap: the rest of chunk 1',
    });
    transcript('try2', good(1), { calls: 3 });
    transcript('a2', good(2), { calls: 2 });
    const p = plan();
    writeFileSync(join(promptRecordDir(p), 'chunk-1.txt'), good(1));

    expect(coverageFromTranscripts(p, ENV).budgetGaps).toEqual([]);
  });

  it('two disclosing relaunches must not supersede each other into silence', () => {
    // Both attempts hit the ceiling and both disclosed. Mutual
    // supersession would drop every gap — nobody rules, nothing renders,
    // and a required-trace gap never caps the verdict. Suppression
    // requires a GAP-FREE superseding record: a genuine repair.
    transcript('try1', good(1), {
      calls: 2,
      text: 'Partial.\nBudget gap: the callers of the renamed export',
    });
    transcript('try2', good(1), {
      calls: 2,
      text: 'Partial again.\nBudget gap: the callers of the renamed export',
    });
    transcript('a2', good(2), { calls: 2 });
    const p = plan();
    writeFileSync(join(promptRecordDir(p), 'chunk-1.txt'), good(1));

    const gaps = coverageFromTranscripts(p, ENV).budgetGaps;
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps[0].gaps).toEqual(['the callers of the renamed export']);
  });

  it('does not credit an idle agent that copied the template back', () => {
    // The brief hands every agent the literal `Budget gap: <the check>`
    // format — the costume is issued with the uniform. A zero-tool-call
    // agent's disclosure is the whiff wearing it.
    transcript('idle1', good(1), {
      calls: 0,
      text: 'No issues found — thorough review.\nBudget gap: deeper caller tracing',
    });
    transcript('a2', good(2), { calls: 2, range: [100, 100] });

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.idleAgents).toEqual(['chunk 1']);
    expect(r.budgetGaps).toEqual([]);
  });

  it('does not credit a blind agent with a disclosed gap either', () => {
    transcript('blind1', blind(1), {
      calls: 2,
      text: 'Reviewed.\nBudget gap: the other half of the chunk',
    });
    transcript('a2', good(2), { calls: 2, range: [100, 100] });

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.blindAgents).toEqual(['chunk 1']);
    expect(r.budgetGaps).toEqual([]);
  });

  it('reports none when nobody disclosed one', () => {
    transcript('a1', good(1), { calls: 3 });
    transcript('a2', good(2), { calls: 2 });

    expect(coverageFromTranscripts(plan(), ENV).budgetGaps).toEqual([]);
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
    expect(gap).toContain('no record shows its brief reaching an agent');
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

  it("keeps per-role entries when every prompt was built and none was launched — the collapse is compose's job", () => {
    // The first cut collapsed this shape HERE, into one "the run stopped at
    // the prompt builder" line — and misfired: candidatesOf is also all-empty
    // when every agent ran on a REWRITTEN prompt, so the aggregate claimed
    // nothing launched beside forty-three rewritten-launch disclosures that
    // said otherwise. Coverage now reports per role, structurally
    // (`disclosures`), and compose-review groups same-reason subjects into
    // the one sentence — after the caller's echoes have been deduped against
    // the very subjects a coverage-side collapse would have discarded.
    const p = planPr();
    for (const f of readdirSync(join(dir, 'subagents', 'S1'))) {
      rmSync(join(dir, 'subagents', 'S1', f), { force: true });
    }
    transcript('stray', wholeDiff(), { calls: 8 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.ok).toBe(false);
    const roster = requiredAgents(
      JSON.parse(readFileSync(p, 'utf8')) as RosterPlan,
    );
    expect(roster.length).toBeGreaterThan(1);
    expect(r.missingRoles).toHaveLength(roster.length);
    expect(r.missingRoleSelectors).toHaveLength(roster.length);
    // Structural twins, one per role, all sharing the one reason — what the
    // compose-side grouping turns into a single sentence.
    const notLaunched = r.disclosures.filter(
      (d) =>
        d.reason ===
        'its prompt was built, but no agent on record was launched with it',
    );
    expect(notLaunched).toHaveLength(roster.length);
    expect(new Set(notLaunched.map((d) => d.subject)).size).toBe(roster.length);
  });

  it('keeps the per-role not-launched text when only SOME launches are missing', () => {
    // The collapse must not swallow the partial case: one unlaunched role
    // beside launched siblings is that role's own line, naming it.
    const p = planPr();
    rmSync(join(dir, 'subagents', 'S1', 'agent-r-1c.jsonl'), { force: true });
    transcript('sec', wholeDiff(), { calls: 8 });

    const r = coverageFromTranscripts(p, ENV);
    const gap = r.missingRoles.join(' ');
    expect(gap).toContain('Cross-file tracer');
    expect(gap).toContain(
      'its prompt was built, but no agent on record was launched with it',
    );
    expect(gap).not.toContain('every dimension');
  });

  it('reads the effort from the plan: medium drops the personas, high still requires them', () => {
    // coverageFromTranscripts passes the WHOLE plan to requiredAgents, which reads
    // plan.effort. A medium run that launched the reduced set (no 6a/6b/6c) must
    // pass; the SAME records under a high plan must fail for the missing personas.
    // Drop the effort read and the medium case demands the personas too and exits 3,
    // halting every medium review — this A/B is what would redden.
    const p = join(dir, 'plan.json');
    const base = {
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
    };
    const backdate = () =>
      utimesSync(p, new Date(2020, 0, 1), new Date(2020, 0, 1));

    // Medium: satisfyRoster launches exactly the reduced roster (personas dropped).
    writeFileSync(p, JSON.stringify({ ...base, effort: 'medium' }));
    satisfyRoster(p);
    backdate();
    expect(coverageFromTranscripts(p, ENV).missingRoles).toEqual([]);

    // The SAME records, now a high plan: the personas are required and were never
    // launched, so they are missing — proving the medium pass was the effort, not luck.
    writeFileSync(p, JSON.stringify({ ...base, effort: 'high' }));
    backdate();
    const high = coverageFromTranscripts(p, ENV).missingRoles.join(' ');
    expect(high).toMatch(/mindset|Undirected audit/);
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

  it('refuses a ledger contradiction with its own ERROR line and exit 3, not a stack trace', () => {
    // `compose-review` renders a `ChunkPartitionError` on its own arm so the
    // operator is not sent to re-capture a diff that was never the problem;
    // this command let the same error escape as an uncaught throw — exit 1,
    // no ERROR line, no report — the one shape the orchestrator cannot act
    // on. Same posture as the transcripts arm: refuse, for the right reason.
    const p = planPr();
    const spy = vi
      .spyOn(coverageModule, 'coverageFromTranscripts')
      .mockImplementation(() => {
        throw new coverageModule.ChunkPartitionError(
          'probe — uncoverable disagrees with the ledger',
        );
      });
    const prevExit = process.exitCode;
    try {
      vi.mocked(writeStderrLine).mockClear();
      expect(() =>
        (checkCoverageCommand.handler as (a: Record<string, unknown>) => void)({
          plan: p,
          out: join(dir, 'cov.json'),
        }),
      ).not.toThrow();
      const err = vi
        .mocked(writeStderrLine)
        .mock.calls.map((c) => String(c[0]))
        .find((l) => l.startsWith('ERROR: '));
      expect(err).toContain('uncoverable disagrees with the ledger');
      expect(err).toContain('defect in the coverage ledger');
      expect(err).not.toContain('This is an environment problem');
      expect(process.exitCode).toBe(3);
      expect(existsSync(join(dir, 'cov.json'))).toBe(false);
    } finally {
      spy.mockRestore();
      process.exitCode = prevExit;
    }
  });

  it('prints the budget-gap NOTE with its directives before the agent text', () => {
    // stderr is the interface the orchestrator acts on, and this NOTE is
    // the only channel telling it not to relaunch and how to rule each
    // gap. The directive-before-disclosure ordering is deliberate —
    // instructions that follow quoted material can be impersonated by it —
    // and a disclosure must never move the exit code.
    transcript('a1', good(1), {
      calls: 3,
      text: 'No issues found — walked it.\nBudget gap: the removed retry path',
    });
    transcript('a2', good(2), { calls: 2 });
    const p = plan();

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

      const note = vi
        .mocked(writeStderrLine)
        .mock.calls.map((c) => String(c[0]))
        .find((l) => l.includes('budget-gap disclosure(s)'));
      expect(note).toBeDefined();
      expect(note).toContain(
        'NOTE: 1 budget-gap disclosure(s) from 1 agent(s)',
      );
      expect(note).toContain('chunk 1: the removed retry path');
      expect(note!.indexOf('Do not relaunch over these')).toBeLessThan(
        note!.indexOf('chunk 1: the removed retry path'),
      );
      expect(process.exitCode).toBe(prevExit);
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
      expect(roleError).toContain(
        'no record shows its brief reaching an agent',
      );
      expect(roleError).not.toContain('every dimension');
      // The rebuild hints and the record dir survive the formatting — with the
      // run's REAL plan path substituted, not a `<plan>` placeholder a literal
      // paste would parse as a shell redirection.
      expect(roleError).toContain(
        `"\${QWEN_CODE_CLI:-qwen}" review agent-prompt --plan '${p}' --roster`,
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

  it('a compliant relaunch is not masked by the failed attempt before it', () => {
    // The remediation for an unread brief says: relaunch with the same printed
    // prompt. Judging only the FIRST transcript that matches the built prompt
    // would keep flagging the role after the operator did exactly that — an
    // older launch that never opened its brief masking the compliant one.
    const p = plan();
    const built = readFileSync(
      join(promptRecordDir(p), 'test-matrix.txt'),
      'utf8',
    );
    rmSync(join(dir, 'subagents', 'S1', 'agent-r-test_matrix.jsonl'), {
      force: true,
    });
    // Attempt 1: right prompt, never opened the brief. Attempt 2: the relaunch,
    // which did. (`a-` sorts before `b-`, so the failed attempt is read first.)
    transcript('a-first-try', built, { calls: 2, opens: [] });
    transcript('b-relaunch', built, {
      calls: 2,
      opens: [briefPath(p, 'test-matrix')],
    });
    // The rest of the roster, compliant, so the only defect is the one above.
    transcript('c1', good(1), { calls: 2 });
    transcript('c2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.unreadBriefs).toEqual([]);
    expect(r.missingRoles).toEqual([]);
  });

  it('an agent flagged rewritten is not also flagged unopened — one repair, not two', () => {
    // A hand-written chunk prompt whose agent also never opened the diff used to
    // land in both lists, handing the operator contradictory repairs: rebuild
    // the prompt AND relaunch the same one. The rebuild subsumes the relaunch.
    const p = plan(2, { record: false });
    transcript('a1', good(1), { calls: 0, opens: ['/some/other/file'] });
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.rewrittenPrompts.join(' ')).toContain('chunk 1');
    expect(r.unopenedAgents).toEqual([]);
  });

  it('all-briefless does not also repeat "none was built" once per chunk transcript', () => {
    // On a 3B replay of the #7012 shape, every chunk transcript would add its
    // own "ran on a prompt the run wrote itself" line beside the collapsed
    // roster line — N+1 public sentences for one fact. The collapse already
    // states it once, for the whole run.
    const p = plan(2, { record: false, roster: false });
    transcript('a1', good(1), { calls: 2 });
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.missingRoles).toHaveLength(1);
    expect(r.missingRoles[0]).toMatch(/^every dimension — /);
    expect(r.rewrittenPrompts).toEqual([]);
    expect(r.ok).toBe(false); // suppressing the text never suppresses the cap
  });

  it('requires Agent 0 on a lightweight plan that carries the PR identity', () => {
    // A cross-repo review has no worktree, but it HAS a pull request — and the
    // skill runs Agent 0 there whenever pr-context succeeded. The roster used to
    // gate role 0 on worktree mode, so the lightweight fan-out could silently
    // omit issue fidelity and check-coverage would bless the omission. plan-diff
    // now writes prNumber/ownerRepo (only when pr-context succeeded), and the
    // roster requires role 0 wherever the full identity is present.
    const withPr = requiredAgents({
      srcDiffLines: 100,
      diffLines: 100,
      files: [{ path: 'a.ts', kind: 'source', removedLines: 0 }],
      chunks: [{ id: 1 }],
      prNumber: '6998',
      ownerRepo: 'QwenLM/qwen-code',
    } as RosterPlan);
    expect(withPr.map((r) => r.key)).toContain('0');

    // Without the identity (pr-context failed → flags omitted), no role 0: a
    // roster demanding an agent nobody can brief would wedge the run.
    const without = requiredAgents({
      srcDiffLines: 100,
      diffLines: 100,
      files: [{ path: 'a.ts', kind: 'source', removedLines: 0 }],
      chunks: [{ id: 1 }],
    } as RosterPlan);
    expect(without.map((r) => r.key)).not.toContain('0');

    // HALF the identity is not the identity: the brief builder needs both
    // halves, and every other fixture carries ownerRepo — without this case,
    // dropping the ownerRepo guard would require an agent nobody can build and
    // no test would notice.
    const halfIdentity = requiredAgents({
      srcDiffLines: 100,
      diffLines: 100,
      files: [{ path: 'a.ts', kind: 'source', removedLines: 0 }],
      chunks: [{ id: 1 }],
      prNumber: '6998',
    } as RosterPlan);
    expect(halfIdentity.map((r) => r.key)).not.toContain('0');
  });

  it('hands the operator exact selectors beside the human labels', () => {
    // `Test coverage matrix (whole-diff)` does not say `--role test-matrix`, and
    // a wrong guess costs a full-roster rerun. The selectors ride the report for
    // stderr; the body still gets only the labels.
    const p = planPr();
    rmSync(join(promptRecordDir(p), '1c.txt'), { force: true });
    rmSync(join(dir, 'subagents', 'S1', 'agent-r-1c.jsonl'), { force: true });
    transcript('sec', wholeDiff(), { calls: 8 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.missingRoleSelectors).toEqual(['--role 1c']);
  });

  it('a compliant relaunch clears the failed attempt — the report converges', () => {
    // The FIX its own report prints says "relaunch". Without supersession the
    // relaunch ADDS a transcript while the failed one keeps its flag, `ok` stays
    // false, and the same FIX prints forever — a repair loop that cannot close.
    const p = plan();
    // Attempt 1: blind (prompt never names the diff). Attempt 2: the rebuild,
    // verbatim and diff-opening. Same chunk.
    transcript(
      'a-blind',
      'You are review agent `chunk 1 of 2` — the territory agent.',
      { calls: 0 },
    );
    transcript('b-rebuilt', good(1), { calls: 3 });
    transcript('c2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.blindAgents).toEqual([]);
    expect(r.idleAgents).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('one transcript cannot certify two dimensions — pasting the whole roster to one agent fails', () => {
    // The roster output makes this a one-keystroke mistake: a single agent
    // handed every block yields ONE transcript that verbatim-contains every
    // prompt and opens every brief. Independent matching would credit it with
    // the entire fan-out; the claim set does not.
    const p = plan();
    const d = promptRecordDir(p);
    const allBlocks = readdirSync(d)
      .filter((f) => f.endsWith('.txt'))
      .map((f) => readFileSync(join(d, f), 'utf8'))
      .join('\n\n');
    // Un-launch the compliant roster fixtures; ONE agent gets everything.
    for (const f of readdirSync(join(dir, 'subagents', 'S1'))) {
      rmSync(join(dir, 'subagents', 'S1', f), { force: true });
    }
    const briefs = readdirSync(d)
      .filter((f) => f.endsWith('.brief.md'))
      .map((f) => join(d, f));
    transcript('mega', allBlocks, { calls: 8, opens: briefs });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.ok).toBe(false);
    expect(r.missingRoles.join(' ')).toContain(
      'one transcript cannot certify two dimensions',
    );
  });

  it('finds the valid assignment a greedy claim order would miss', () => {
    // The round-11 injectivity used first-come claiming: with T1 containing
    // blocks A+B (opens both briefs) and T2 containing only A (opens A), greedy
    // claimed T1 for A and reported B missing — a compliant repair permanently
    // capped by transcript filename order. Maximum matching assigns T2→A, T1→B.
    const p = plan();
    const d = promptRecordDir(p);
    const promptA = readFileSync(join(d, 'chunk-1.txt'), 'utf8');
    const promptB = readFileSync(join(d, 'chunk-2.txt'), 'utf8');
    // 'a-' sorts first: the greedy order that used to break this.
    transcript('a-both', `${promptA}\n\n${promptB}`, {
      calls: 4,
      opens: [briefPath(p, 'chunk-1'), briefPath(p, 'chunk-2')],
    });
    transcript('b-solo', promptA, {
      calls: 2,
      opens: [briefPath(p, 'chunk-1')],
    });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.missingRoles).toEqual([]);
    expect(r.unreadBriefs).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('a zero-byte prompt record is not "built" — an all-empty dir still collapses', () => {
    // A partial write can leave empty records. `Map.has()` would read them as
    // built and surface N false built-but-not-launched failures instead of the
    // one collapsed diagnosis the all-briefless run deserves.
    const p = plan(2, { roster: false });
    const d = promptRecordDir(p);
    for (const f of readdirSync(d)) {
      if (f.endsWith('.txt')) writeFileSync(join(d, f), '');
    }
    transcript('a1', good(1), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.ok).toBe(false);
    expect(r.missingRoles).toHaveLength(1);
    expect(r.missingRoles[0]).toMatch(/^every dimension — /);
  });

  it('catches a prompt that was built and then never used', () => {
    // Half of the failure: the command was called, so the record exists — but the
    // agent was launched with something else, or not launched at all.
    const p = plan3a();
    rmSync(join(dir, 'subagents', 'S1', 'agent-r-2.jsonl'), { force: true });
    transcript('sec', wholeDiff(), { calls: 8 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.missingRoles).toEqual([
      'Agent 2: Security — its prompt was built, but no agent on record was ' +
        'launched with it',
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
      `You are review agent \`chunk 1 of 2\` — the territory agent.\n` +
        `read_file(file_path="${DIFF}", offset=0, limit=100)\n` +
        `Do not recite a stock sentence: a return that names nothing you read is ` +
        `indistinguishable from never having read anything.\n` +
        `## Project rules\nEvery added field must have its read sites grepped.`,
    );
    // What the agent got: the read survived, the rules became a summary, and the
    // sentence that stops a whiff is gone — replaced by a receipt to recite.
    transcript(
      'a1',
      `You are review agent \`chunk 1 of 2\` — the territory agent.\n` +
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

describe('a drifted launch whose payload provably arrived', () => {
  it('notes a near-verbatim chunk launch instead of demanding a relaunch', () => {
    // Measured on a real run: asked to copy twelve blocks, the model normalized
    // one word in every block's tail ("you" → "it"), every launch failed the
    // verbatim match, and the repair relaunched the entire fan-out — the most
    // expensive step in the pipeline, redelivering text the agents had already
    // acted on. The payload had arrived: the brief was opened and the diff was
    // read, and both facts are the harness's records, not the run's prose.
    const p = plan();
    transcript('a1', good(1).replace('of the diff.', 'of the diff file.'), {
      calls: 3,
    });
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.rewrittenPrompts).toEqual([]);
    expect(r.driftedLaunches).toHaveLength(1);
    expect(r.driftedLaunches[0]).toContain('chunk 1');
    expect(r.driftedLaunches[0]).toContain('delivery stands');
    expect(r.coveredChunks).toEqual([1, 2]);
    expect(r.ok).toBe(true);
  });

  it('does not rescue a drift that never opened the brief', () => {
    const p = plan();
    transcript('a1', good(1).replace('of the diff.', 'of the diff file.'), {
      calls: 3,
      opens: [],
    });
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.driftedLaunches).toEqual([]);
    expect(r.rewrittenPrompts).toHaveLength(1);
    expect(r.ok).toBe(false);
  });

  it('requires the diff read, not brief-open alone', () => {
    // A drifted launch that dropped the read list is not rescued on the
    // brief-open by itself: the diff read is the other half of the payload.
    const p = plan();
    transcript('a1', good(1).replace('of the diff.', 'of the diff file.'), {
      calls: 0,
      opens: [chunkBrief(1)],
    });
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.driftedLaunches).toEqual([]);
    expect(r.rewrittenPrompts).toHaveLength(1);
    expect(r.ok).toBe(false);
  });

  it('rescues a drifted dimension launch on brief-open plus the diff read', () => {
    const p = planPr();
    rmSync(join(dir, 'subagents', 'S1', 'agent-r-1c.jsonl'), { force: true });
    const builtPrompt = readFileSync(
      join(promptRecordDir(p), '1c.txt'),
      'utf8',
    );
    transcript(
      'r-1c-drift',
      builtPrompt.replace('You are 1c.', 'You are Agent 1c.'),
      { calls: 2 },
    );
    transcript('sec', wholeDiff(), { calls: 8 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.missingRoles).toEqual([]);
    expect(r.unreadBriefs).toEqual([]);
    expect(r.driftedLaunches).toHaveLength(1);
    expect(r.driftedLaunches[0]).toContain('Cross-file tracer');
    expect(r.ok).toBe(true);
  });

  it('one drifted transcript cannot certify two roles', () => {
    // The verbatim matching is injective — one transcript, one requirement —
    // or pasting the whole roster to a single agent certifies an N-agent
    // fan-out with one reader. The rescue inherits the same rule.
    const p = planPr();
    rmSync(join(dir, 'subagents', 'S1', 'agent-r-1c.jsonl'), { force: true });
    rmSync(join(dir, 'subagents', 'S1', 'agent-r-2.jsonl'), { force: true });
    transcript(
      'r-both-drift',
      `You are neither role, exactly.\n` +
        `read_file(file_path="${briefPath(p, '1c')}")\n` +
        `read_file(file_path="${briefPath(p, '2')}")\n` +
        `read_file(file_path="${DIFF}")`,
      { calls: 2 },
    );
    transcript('sec', wholeDiff(), { calls: 8 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.driftedLaunches).toHaveLength(1);
    expect(r.missingRoles).toHaveLength(1);
    expect(r.ok).toBe(false);
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

/** The old rendered shape, for the regex assertions: structural gaps, joined. */
const gapText = (r: {
  gaps: Array<{ subject: string; reason: string }>;
}): string => r.gaps.map((g) => `${g.subject} — ${g.reason}`).join(' ');

describe('verificationGaps — Step 4 and Step 5 ran, and read their briefs', () => {
  // A Step 4/5 agent as a real run leaves it: the CLI's record of the prompt it
  // built (`agent-prompt --role <role>`), the brief that prompt points at, and the
  // harness's transcript of an agent launched with it. The opts model each way
  // delivery fails: `launch: false` — built, never handed to an agent;
  // `opensBrief: false` — launched with the built prompt, never opened the brief;
  // `rewritten: true` — an agent ran and opened the brief, but the orchestrator
  // wrote the launch itself (the real 3A run this precision exists for). To model a
  // step skipped wholesale, do not set the key up at all. `findings: true` bakes
  // the #8597 pointer into the recorded prompt — the block points at a
  // digest-named list file — and `opensFindings: false` models the agent that
  // opened its brief but skipped the one instructed findings read.
  function step45(
    planPath: string,
    key: string,
    opts: {
      launch?: boolean;
      opensBrief?: boolean;
      rewritten?: boolean;
      findings?: boolean;
      opensFindings?: boolean;
      mentionsFindings?: boolean;
    } = {},
  ): void {
    const d = promptRecordDir(planPath);
    mkdirSync(d, { recursive: true });
    const brief = briefPath(planPath, key);
    writeFileSync(brief, `The ${key} brief.`);
    const findings = findingsFilePath(planPath, key);
    if (opts.findings) {
      writeFileSync(findings, '- **[Critical]** x.ts:1 — y');
    }
    const prompt =
      `You are review agent \`${key}\`.\n` +
      (opts.findings ? `read_file(file_path="${findings}")\n` : '') +
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
    const opens = opts.opensBrief === false ? [] : [brief];
    if (opts.findings && opts.opensFindings !== false) opens.push(findings);
    const mentions =
      opts.findings && opts.mentionsFindings ? [findings] : undefined;
    transcript(id, prompt, { calls: 2, opens, mentions });
  }

  it('passes when the reverse audit ran on a review with nothing to verify', () => {
    const p = plan();
    step45(p, 'reverse-audit');
    const r = verificationGaps(p, { postsFindings: false }, ENV);
    expect(r.ok).toBe(true);
    expect(r.gaps).toEqual([]);
  });

  it('does not let an OLDER findings digest vouch for the current one', () => {
    // `verify--<digest>` keys accumulate: a run that finds new Criticals
    // writes a new digest's records beside the old. Taking the best delivery
    // across all of them let a verifier that succeeded against an EARLIER
    // list satisfy the floor for a list it never opened — and widening the
    // record set to prior sessions is what made that reachable.
    const p = plan();
    step45(p, 'reverse-audit');
    step45(p, 'verify--old11111111', { findings: true });
    // The current digest: built and launched, but its findings list unread.
    step45(p, 'verify--new22222222', {
      findings: true,
      opensFindings: false,
    });
    // Date the two lists apart — the round builder writes a digest's records
    // in one pass, so a previous list is a round older.
    const old = new Date(Date.now() - 600_000);
    utimesSync(findingsFilePath(p, 'verify--old11111111'), old, old);

    const r = verificationGaps(p, { postsFindings: true }, ENV);
    expect(r.ok).toBe(false);
    expect(r.unverifiedFindings).toBe(true);
  });

  it('drops a POINTERLESS stale verify key once a dated digest exists', () => {
    // The write-failure fallback inlines the list, so its key has no
    // findings file — no date, and no findings-read floor either, which
    // means it CAN reach ok. Kept beside a dated digest, a stale pointerless
    // verifier vouches for a list no verifier opened.
    const p = plan();
    step45(p, 'reverse-audit');
    // The pointerless stale verifier: compliant in every respect, no
    // findings file on disk (prompt carries no pointer).
    const d = promptRecordDir(p);
    const key = 'verify--stale9999';
    const brief = briefPath(p, key);
    writeFileSync(brief, `The ${key} brief.`);
    const prompt =
      `You are review agent \`${key}\`.\n` +
      `read_file(file_path="${brief}")\n` +
      `read_file(file_path="${DIFF}")`;
    writeFileSync(join(d, `${encodeURIComponent(key)}.txt`), prompt);
    // A stale generation's record is a round old in production; the record
    // file now DATES a pointerless key (so a current inlined-fallback
    // generation survives the window), and an undated fixture would sit
    // inside the current window by accident of being written just now.
    const staleAt = new Date(Date.now() - 600_000);
    utimesSync(join(d, `${encodeURIComponent(key)}.txt`), staleAt, staleAt);
    transcript('vstale', prompt, { calls: 2, opens: [brief] });
    // The CURRENT digest: dated (findings file on disk), launched, its list
    // unread — the floor must come back owed.
    step45(p, 'verify--new22222222', { findings: true, opensFindings: false });

    const r = verificationGaps(p, { postsFindings: true }, ENV);
    expect(r.unverifiedFindings).toBe(true);
  });

  it('accepts a compliant CURRENT-digest verifier beside an older one', () => {
    // The acceptance direction of the digest narrowing: a keep-only-newest
    // or refuse-multi-generation mutant must go red somewhere.
    const p = plan();
    step45(p, 'reverse-audit');
    step45(p, 'verify--old11111111', { findings: true });
    const old = new Date(Date.now() - 600_000);
    utimesSync(findingsFilePath(p, 'verify--old11111111'), old, old);
    step45(p, 'verify--new22222222', { findings: true });

    const r = verificationGaps(p, { postsFindings: true }, ENV);
    expect(r.ok).toBe(true);
    expect(r.unverifiedFindings).toBe(false);
  });

  it('an undatable CURRENT digest cannot be vouched for by the previous round', () => {
    // The mirror of the stale-pointerless drop: when the CURRENT digest's
    // findings writes fail (the documented inline fallback), its keys have
    // no findings file. Dropped, the window kept the PREVIOUS round's dated
    // cluster and the floor passed `ok` on an earlier list's verifier —
    // certifying a verification that never happened. The prompt record now
    // dates every built key, so the current generation stays in the window.
    const p = plan();
    step45(p, 'reverse-audit');
    // Round 1: digest A, dated, fully compliant — and a round old.
    step45(p, 'verify--oldA1111111', { findings: true });
    const old = new Date(Date.now() - 600_000);
    utimesSync(findingsFilePath(p, 'verify--oldA1111111'), old, old);
    utimesSync(
      join(
        promptRecordDir(p),
        `${encodeURIComponent('verify--oldA1111111')}.txt`,
      ),
      old,
      old,
    );
    // Round 2: digest B, findings write failed (no file, no pointer), its
    // verify shard never launched — the failure the floor exists to catch.
    step45(p, 'verify--newB2222222', { launch: false });

    const r = verificationGaps(p, { postsFindings: true }, ENV);
    expect(r.unverifiedFindings).toBe(true);
  });

  it('the reverse-audit floor is narrowed to the current digest too', () => {
    // Reverse keys accumulate per round/digest exactly like verify keys;
    // ranging over all of them let a round-1 auditor's delivered receipt
    // satisfy the floor after the findings list changed and the current
    // round's audit was never delivered.
    const p = plan();
    // Round 1: compliant, delivered — and a round old.
    step45(p, 'reverse-audit--chunk-1--round-1--aaa1');
    const old = new Date(Date.now() - 600_000);
    utimesSync(
      join(
        promptRecordDir(p),
        `${encodeURIComponent('reverse-audit--chunk-1--round-1--aaa1')}.txt`,
      ),
      old,
      old,
    );
    // Round 3: built, never launched.
    step45(p, 'reverse-audit--chunk-1--round-3--ccc3', { launch: false });

    const r = verificationGaps(p, { postsFindings: false }, ENV);
    expect(r.remediation.some((m) => m.startsWith('reverse audit:'))).toBe(
      true,
    );
  });

  it('passes when both verify and reverse audit ran on a review with findings', () => {
    const p = plan();
    step45(p, 'reverse-audit');
    step45(p, 'verify');
    expect(verificationGaps(p, { postsFindings: true }, ENV).ok).toBe(true);
  });

  it('a verifier launched without its findings prefix no longer clears the gate', () => {
    // The record now IS the printed prompt — findings section included,
    // digest-keyed. The old findings-free record was a receipt a partial
    // delivery could satisfy: launch the agent with only the recorded tail,
    // let it open the brief, and verification read as ok while no verifier
    // ever saw a finding.
    const p = plan();
    step45(p, 'reverse-audit'); // Step 5 compliant; verification is the subject
    const d = promptRecordDir(p);
    const brief = briefPath(p, 'verify--abc123def456');
    writeFileSync(brief, 'The verify brief.');
    const tail =
      'You are review agent `verify`.\n' +
      `read_file(file_path="${brief}")\n` +
      `read_file(file_path="${DIFF}")`;
    const full = `## The findings you are ruling on\n\n- x.ts:1 — y\n\n${tail}`;
    writeFileSync(join(d, 'verify--abc123def456.txt'), full);
    // The attack: the agent gets ONLY the tail, and dutifully opens the brief.
    transcript('v-tail', tail, { calls: 2, opens: [brief] });

    const r = verificationGaps(p, { postsFindings: true }, ENV);
    expect(r.ok).toBe(false);
    expect(gapText(r)).toMatch(/verification — /);

    // The compliant launch — the full printed prompt — clears it.
    transcript('v-full', full, { calls: 2, opens: [brief] });
    expect(verificationGaps(p, { postsFindings: true }, ENV).ok).toBe(true);
  });

  it('quotes a plan path with an apostrophe so the pasted repair survives it', () => {
    // A macOS workspace like ~/Documents/John's Projects is ordinary. A bare
    // '…' wrap closed the quote at the apostrophe; the shared shell-quoting
    // emits the '\'' dance, so the copy-pasted FIX parses whole.
    const sub = join(dir, "john's-project");
    mkdirSync(sub, { recursive: true });
    mkdirSync(join(sub, 'subagents', 'S1'), { recursive: true });
    const p = join(sub, 'plan.json');
    writeFileSync(
      p,
      JSON.stringify({
        diffPathAbsolute: DIFF,
        srcDiffLines: 5000,
        diffLines: 5000,
        files: [{ path: 'a.ts', kind: 'source', removedLines: 0 }],
        chunks: [{ id: 1, startLine: 1, endLine: 100 }],
      }),
    );
    const old = new Date(2020, 0, 1);
    utimesSync(p, old, old);
    const env = { QWEN_CODE_PROJECT_DIR: sub, QWEN_CODE_SESSION_ID: 'S1' };

    const r = verificationGaps(p, { postsFindings: false }, env);
    expect(r.ok).toBe(false);
    const fix = r.remediation.join(' ');
    expect(fix).toContain(`--plan '${p.replace(/'/g, "'\\''")}'`);
    // And never the naive wrap that dies at the apostrophe.
    expect(fix).not.toContain(`--plan '${p}'`);
  });

  it('flags a review that never built the reverse-audit prompt', () => {
    const p = plan(); // no reverse-audit fixture: the step was skipped
    const r = verificationGaps(p, { postsFindings: false }, ENV);
    expect(r.ok).toBe(false);
    const gap = gapText(r);
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
    const gap = gapText(r);
    // It says what happened — the auditor ran AND opened its brief (that is how
    // this shape is even detected, and a text denying it publishes a false
    // mechanism) …
    expect(gap).toMatch(/an auditor ran and opened its brief/);
    // … and what was actually wrong.
    expect(gap).toMatch(/no agent was launched with the prompt the CLI built/);
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
    // The REAL plan path, not a `<plan>` placeholder — pasted literally into a
    // POSIX shell that parses as input redirection, and the repair round the
    // skill prescribes could never run.
    expect(fix).toContain(
      `"\${QWEN_CODE_CLI:-qwen}" review agent-prompt ` +
        `--plan '${p}' --role reverse-audit --findings <file>`,
    );
    expect(fix).not.toContain('<plan>');
    // The repair command carries --round, and the ban names the alternative:
    // the dogfooded failure was the orchestrator hand-appending `(round N)` to
    // the identity line because the CLI gave it nowhere else to put it.
    expect(fix).toMatch(/no hand-added round number/);
    // UNBRACKETED: `agent-prompt` refuses a round-less reverse-audit call, so
    // a paste-and-run repair that bracketed --round as optional handed the
    // orchestrator a first attempt the validation rejects.
    expect(fix).toContain('--round <k>');
    expect(fix).not.toContain('[--round <k>]');
  });

  it('names a rewritten verifier launch as itself too', () => {
    const p = plan();
    step45(p, 'reverse-audit');
    step45(p, 'verify', { rewritten: true });
    const r = verificationGaps(p, { postsFindings: true }, ENV);
    const gap = gapText(r);
    expect(gap).toMatch(/a verifier ran and opened its brief/);
    expect(gap).toMatch(/no agent was launched with the prompt the CLI built/);
    expect(gap).not.toMatch(/no verifier ran/);
    expect(gap).not.toMatch(/agent-prompt|--findings|--role/);
    const fix = r.remediation.join(' ');
    expect(fix).toContain('--role verify');
    // The verify fix bans a hand-added SHARD number, and must not claim
    // --round bakes one in — --round bakes in a round number, and shards are
    // told apart by their findings digest, not by that flag.
    expect(fix).toMatch(/no hand-added shard number,/);
    expect(fix).not.toContain('shard number (--round bakes it in)');
    // For verify the flag stays BRACKETED — only a repeat verification round
    // passes one, unlike reverse-audit where the CLI refuses without it.
    expect(fix).toContain('[--round <k>]');
  });

  it('flags a reverse audit built but whose agent never opened its brief', () => {
    const p = plan();
    step45(p, 'reverse-audit', { opensBrief: false });
    const r = verificationGaps(p, { postsFindings: false }, ENV);
    expect(r.ok).toBe(false);
    expect(gapText(r)).toMatch(
      /reverse audit — it was launched with the built prompt but never opened its brief/,
    );
  });

  it('flags a reverse audit whose prompt was built but never launched', () => {
    const p = plan();
    step45(p, 'reverse-audit', { launch: false });
    const r = verificationGaps(p, { postsFindings: false }, ENV);
    expect(r.ok).toBe(false);
    expect(gapText(r)).toMatch(
      /reverse audit — its prompt was built, but no agent was launched with it/,
    );
  });

  it('counts a Step 3B per-chunk reverse auditor (reverse-audit--chunk-N)', () => {
    const p = plan();
    step45(p, 'reverse-audit--chunk-1');
    const r = verificationGaps(p, { postsFindings: false }, ENV);
    expect(gapText(r)).not.toMatch(/reverse audit/);
  });

  it('requires a verifier when the review posts findings', () => {
    const p = plan();
    step45(p, 'reverse-audit'); // isolate the verify gap
    const r = verificationGaps(p, { postsFindings: true }, ENV);
    expect(r.ok).toBe(false);
    expect(gapText(r)).toMatch(/verification — the review posts findings/);
  });

  it('does not require a verifier when the review confirmed nothing', () => {
    const p = plan();
    step45(p, 'reverse-audit');
    const r = verificationGaps(p, { postsFindings: false }, ENV);
    expect(gapText(r)).not.toMatch(/verification/);
  });

  it('flags a verifier built but whose agent never opened its brief', () => {
    const p = plan();
    step45(p, 'reverse-audit');
    step45(p, 'verify', { opensBrief: false });
    const r = verificationGaps(p, { postsFindings: true }, ENV);
    expect(gapText(r)).toMatch(
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
    expect(gapText(r)).toMatch(
      /verification — its prompt was built, but no agent was launched with it/,
    );
  });

  it('flags a verifier that opened its brief but skipped the findings file', () => {
    // Since #8597 the findings list rides a digest-named file the block points
    // at; the brief's read receipt does not cover it. An instruction-skipping
    // verifier that opens the brief but never reads the list must not clear
    // the floor — it would otherwise rule on findings it was never shown (the
    // probe shape: a skip arm indistinguishable from the compliant one).
    const p = plan();
    step45(p, 'reverse-audit'); // Step 5 compliant; verification is the subject
    step45(p, 'verify--abc123def456', {
      findings: true,
      opensFindings: false,
    });
    const r = verificationGaps(p, { postsFindings: true }, ENV);
    expect(r.ok).toBe(false);
    expect(r.unverifiedFindings).toBe(true);
    expect(gapText(r)).toMatch(
      /verification — it was launched with the built prompt and opened its brief, but never read the findings file/,
    );
    // The fix names the findings read as part of the receipt.
    expect(r.remediation.join(' ')).toContain('read the findings file');
  });

  it('clears the floor when the verifier reads the findings file its block points at', () => {
    const p = plan();
    step45(p, 'reverse-audit');
    step45(p, 'verify--abc123def456', { findings: true });
    expect(verificationGaps(p, { postsFindings: true }, ENV).ok).toBe(true);
  });

  it('does not credit a non-read tool that merely names the findings path', () => {
    // Every tool serializes its args, so a `search_file_content` over the
    // findings file carries the same stringified path as a read of it —
    // without reading a line. The floor certifies the list was OPENED; a
    // mention is not an open, and only read_file counts.
    const p = plan();
    step45(p, 'reverse-audit'); // Step 5 compliant; verification is the subject
    step45(p, 'verify--abc123def456', {
      findings: true,
      opensFindings: false,
      mentionsFindings: true,
    });
    const r = verificationGaps(p, { postsFindings: true }, ENV);
    expect(r.ok).toBe(false);
    expect(r.unverifiedFindings).toBe(true);
    expect(gapText(r)).toMatch(
      /verification — it was launched with the built prompt and opened its brief, but never read the findings file/,
    );
  });

  it('flags a reverse auditor that opened its brief but skipped the findings file', () => {
    const p = plan();
    step45(p, 'reverse-audit--round-1--abc123def456', {
      findings: true,
      opensFindings: false,
    });
    const r = verificationGaps(p, { postsFindings: false }, ENV);
    expect(r.ok).toBe(false);
    expect(gapText(r)).toMatch(
      /reverse audit — it was launched with the built prompt and opened its brief, but never read the findings file/,
    );
  });

  it('merges both steps into one gap when both skipped the findings file', () => {
    const p = plan();
    step45(p, 'reverse-audit--round-1--abc123def456', {
      findings: true,
      opensFindings: false,
    });
    step45(p, 'verify--abc123def456', {
      findings: true,
      opensFindings: false,
    });
    const r = verificationGaps(p, { postsFindings: true }, ENV);
    expect(r.ok).toBe(false);
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0].subject).toBe('verification and reverse audit');
    expect(r.gaps[0].reason).toMatch(/never read the findings file/);
    expect(r.unverifiedFindings).toBe(true);
  });

  it('merges both steps into one gap when they failed the same way', () => {
    // #7268: the posted body carried the verify and reverse-audit `rewritten`
    // sentences back to back, near-identical but for the tail. One shape, one
    // sentence, two subjects — and still both consequences and both honesty
    // limits (each demonstrably RAN and opened its brief).
    const p = plan();
    step45(p, 'reverse-audit', { rewritten: true });
    step45(p, 'verify', { rewritten: true });
    const r = verificationGaps(p, { postsFindings: true }, ENV);
    expect(r.ok).toBe(false);
    expect(r.gaps).toHaveLength(1);
    const gap = r.gaps[0];
    expect(gap.subject).toBe('verification and reverse audit');
    expect(gap.subjectZh).toBe('验证与反向审计');
    expect(gap.reasonZh).toContain('手写');
    expect(gap.reason).toMatch(/each ran and opened its brief/);
    expect(gap.reason).toMatch(/written by hand/);
    expect(gap.reason).toMatch(/cannot be counted as verified/);
    // The remediation stays per-role: the two rebuild commands differ.
    const fix = r.remediation.join(' ');
    expect(fix).toContain('--role reverse-audit');
    expect(fix).toContain('--role verify');
    expect(r.unverifiedFindings).toBe(true);
  });

  it('keeps two precise gaps when the steps failed differently', () => {
    // Mixed shapes have different mechanisms and different fixes; a sentence
    // vague enough to cover both would misname one of them.
    const p = plan();
    step45(p, 'reverse-audit', { rewritten: true });
    step45(p, 'verify', { launch: false });
    const r = verificationGaps(p, { postsFindings: true }, ENV);
    expect(r.gaps).toHaveLength(2);
    expect(gapText(r)).toMatch(
      /reverse audit — an auditor ran and opened its brief/,
    );
    expect(gapText(r)).toMatch(
      /verification — its prompt was built, but no agent was launched with it/,
    );
    expect(gapText(r)).not.toMatch(/verification and reverse audit/);
  });

  it('does not merge when the review posts no findings — verify was never owed', () => {
    // A zero-finding review with the reverse audit skipped keeps the solo
    // reverse-audit text: there is no verify failure to share a sentence with.
    const p = plan(); // neither step on record
    const r = verificationGaps(p, { postsFindings: false }, ENV);
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0].subject).toBe('reverse audit');
  });
});

describe('coverage — a resumed run credits the prior attempt through the ledger', () => {
  // The run ledger `fetch-pr` writes: S0 is the interrupted attempt, S1 the
  // resumed continuation this suite's ENV runs as. Entries carry a current
  // atMs, which sits inside the epoch fence of the backdated plan.
  let ledgerNowMs = 0;
  function ledger(planPath: string, ...ids: string[]): void {
    const d = promptRecordDir(planPath);
    mkdirSync(d, { recursive: true });
    // Written by the real writer: it stamps the plan mtime each entry is
    // keyed on, and the resume marker is what authorizes reading prior
    // evidence at all. The current attempt is stamped last, since each
    // attempt's window closes when the next one opened.
    const nowMs = Date.now();
    ledgerNowMs = nowMs;
    ids.forEach((id, i) =>
      appendRunSession(
        planPath,
        { QWEN_CODE_SESSION_ID: id },
        i === ids.length - 1 ? nowMs + 1500 : nowMs,
      ),
    );
    recordResume(planPath, ENV, nowMs + 1500);
  }

  /** Re-home a transcript written by `transcript()` into another session. */
  function moveToSession(id: string, session: string): void {
    mkdirSync(join(dir, 'subagents', session), { recursive: true });
    // Re-stamp the records with the session that now owns them: a
    // transcript COPIED into another session's directory is not that
    // session's evidence, and production refuses the misplaced shape.
    const from = join(dir, 'subagents', 'S1', `agent-${id}.jsonl`);
    const to = join(dir, 'subagents', session, `agent-${id}.jsonl`);
    writeFileSync(
      to,
      readFileSync(from, 'utf8').replaceAll(
        '"sessionId":"S1"',
        `"sessionId":"${session}"`,
      ),
    );
    rmSync(from, { force: true });
    if (ledgerNowMs > 0) {
      const at = new Date(ledgerNowMs);
      utimesSync(to, at, at);
    }
  }

  it('passes 3D on work the interrupted attempt completed, and discloses it', () => {
    const p = plan();
    ledger(p, 'S0', 'S1');
    transcript('a1', good(1), { calls: 3 });
    moveToSession('a1', 'S0');
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.ok).toBe(true);
    expect(r.coveredChunks).toEqual([1, 2]);
    expect(r.recoveredAgents).toBe(1);
    // Continuity is NOT a disclosure: that channel caps the verdict and
    // renders under "Not reviewed:" — recovered work is the opposite of a
    // gap. compose-review renders its own non-capping note from the count.
    expect(r.disclosures.some((d) => d.subject === 'review continuity')).toBe(
      false,
    );
  });

  it('sees nothing from a prior session the ledger never recorded', () => {
    // The orphan-invisibility guard: no ledger entry, no evidence — a
    // fabricated directory cannot vouch for itself.
    const p = plan();
    transcript('a1', good(1), { calls: 3 });
    moveToSession('a1', 'S0');
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.ok).toBe(false);
    expect(r.missingChunks).toEqual([1]);
    expect(r.recoveredAgents).toBe(0);
  });

  it("lets a compliant relaunch supersede the prior attempt's failure", () => {
    // Attempt 1's chunk-1 agent idled before the crash; the resumed run
    // relaunched it properly. The prior failure must not pin `ok` false.
    const p = plan();
    ledger(p, 'S0', 'S1');
    transcript('a1', good(1), { calls: 0 });
    moveToSession('a1', 'S0');
    transcript('a1b', good(1), { calls: 3 });
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.ok).toBe(true);
    expect(r.idleAgents).toEqual([]);
    // The idle prior record certifies nothing, so it is not "recovered".
    expect(r.recoveredAgents).toBe(0);
  });

  it('reports zero recovered agents on a run that never resumed', () => {
    transcript('a1', good(1), { calls: 3 });
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.recoveredAgents).toBe(0);
  });
});

describe('verificationGaps — a resumed run reads the prior attempt', () => {
  /** Re-home a transcript into another session, re-stamping its records. */
  function moveToSession(id: string, session: string): void {
    mkdirSync(join(dir, 'subagents', session), { recursive: true });
    const from = join(dir, 'subagents', 'S1', `agent-${id}.jsonl`);
    const to = join(dir, 'subagents', session, `agent-${id}.jsonl`);
    writeFileSync(
      to,
      readFileSync(from, 'utf8').replaceAll(
        '"sessionId":"S1"',
        `"sessionId":"${session}"`,
      ),
    );
    rmSync(from, { force: true });
    if (ledgerNowMs > 0) {
      const at = new Date(ledgerNowMs);
      utimesSync(to, at, at);
    }
  }

  /** The ledger `fetch-pr` writes, through the real writers. */
  let ledgerNowMs = 0;
  function ledger(planPath: string, ...ids: string[]): void {
    const nowMs = Date.now();
    ledgerNowMs = nowMs;
    ids.forEach((id, i) =>
      appendRunSession(
        planPath,
        { QWEN_CODE_SESSION_ID: id },
        i === ids.length - 1 ? nowMs + 1500 : nowMs,
      ),
    );
    recordResume(planPath, ENV, nowMs + 1500);
  }

  /**
   * A compliant Step 4/5 agent: recorded prompt, brief and findings on disk,
   * and a transcript of an agent launched verbatim with it that opened both.
   * Returns the agent id so the caller can re-home it into a prior session.
   */
  function step45(
    planPath: string,
    key: string,
    opts: { returned?: boolean } = {},
  ): string {
    const d = promptRecordDir(planPath);
    mkdirSync(d, { recursive: true });
    const brief = briefPath(planPath, key);
    writeFileSync(brief, `The ${key} brief.`);
    const findings = findingsFilePath(planPath, key);
    writeFileSync(findings, '- **[Critical]** x.ts:1 — y');
    const prompt =
      `You are review agent \`${key}\`.\n` +
      `read_file(file_path="${findings}")\n` +
      `read_file(file_path="${brief}")\n` +
      `read_file(file_path="${DIFF}")`;
    writeFileSync(join(d, `${encodeURIComponent(key)}.txt`), prompt);
    const id = `v-${key.replace(/[^a-z0-9]/gi, '_')}`;
    transcript(id, prompt, {
      calls: 2,
      opens: [brief, findings],
      // `returned: false` is the died-mid-flight shape: every delivery check
      // still passes (recorded prompt, brief opened, findings read) and only
      // the final text is missing, which is exactly the record that must not
      // certify a verification.
      ...(opts.returned === false ? { text: '' } : {}),
    });
    return id;
  }

  it('owes only the step whose agent died, per record — not per session', () => {
    // Both prior fixtures were symmetric (all returned or all died), so a
    // session-granular refactor (drop the whole session when ANY agent died)
    // shipped green. Mixed shapes are the discriminator.
    const p = plan();
    const okId = step45(p, 'reverse-audit');
    const deadId = step45(p, 'verify', { returned: false });
    moveToSession(okId, 'S0');
    moveToSession(deadId, 'S0');
    ledger(p, 'S0', 'S1');
    rmSync(join(dir, 'subagents', 'S1'), { recursive: true, force: true });

    const r = verificationGaps(p, { postsFindings: true }, ENV);
    expect(r.gaps.map((g) => g.subject)).toEqual(['verification']);
  });

  it('accepts Step 4/5 evidence that exists only in a prior session', () => {
    // The zero-launch continuation, pinned at the verification floor rather
    // than inferred from its coverage sibling: a current-session-only reader
    // regressing here would report the steps as never run.
    //
    // The fixture must BUILD both steps. `plan()` alone emits neither role,
    // so with no Step 4/5 records at all the two failures merge into one gap
    // whose subject is the combined `'verification and reverse audit'` —
    // which equals neither exact string, and an assertion pair written as
    // `not.toContain('verification')` then passes on a review where nothing
    // was verified. That is what this test used to do.
    const p = plan();
    const ids = [step45(p, 'verify'), step45(p, 'reverse-audit')];
    for (const id of ids) moveToSession(id, 'S0');
    ledger(p, 'S0', 'S1');
    rmSync(join(dir, 'subagents', 'S1'), { recursive: true, force: true });

    const r = verificationGaps(p, { postsFindings: true }, ENV);
    // No gaps AT ALL, not the absence of two names: the combined subject is
    // exactly the shape a name-based assertion cannot see.
    expect(r.gaps).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('refuses prior-session Step 4/5 evidence whose agent never returned', () => {
    // The same fixture, minus the return: an interrupted attempt's verifier
    // that opened its brief and died satisfies every delivery check — the
    // prompt was recorded, the brief was read — while its verification never
    // existed. The gate reads live records only, and both steps come back
    // owed.
    const p = plan();
    const ids = [
      step45(p, 'verify', { returned: false }),
      step45(p, 'reverse-audit', { returned: false }),
    ];
    for (const id of ids) moveToSession(id, 'S0');
    ledger(p, 'S0', 'S1');
    rmSync(join(dir, 'subagents', 'S1'), { recursive: true, force: true });

    const r = verificationGaps(p, { postsFindings: true }, ENV);
    expect(r.ok).toBe(false);
    // BOTH steps come back owed, by name — "any gap exists" would stay green
    // when only the reverse audit was refused while a dead verify agent was
    // accepted, and `unverifiedFindings` would then ship findings as
    // verified.
    expect(r.gaps.map((g) => g.subject)).toEqual([
      'verification and reverse audit',
    ]);
    expect(r.unverifiedFindings).toBe(true);
  });
});

describe('coverage — a stale Uncoverable declaration cannot cap live coverage', () => {
  let ledgerNowMs = 0;
  function ledger(planPath: string, ...ids: string[]): void {
    const d = promptRecordDir(planPath);
    mkdirSync(d, { recursive: true });
    // Written by the real writer: it stamps the plan mtime each entry is
    // keyed on, and the resume marker is what authorizes reading prior
    // evidence at all. The current attempt is stamped last, since each
    // attempt's window closes when the next one opened.
    const nowMs = Date.now();
    ledgerNowMs = nowMs;
    ids.forEach((id, i) =>
      appendRunSession(
        planPath,
        { QWEN_CODE_SESSION_ID: id },
        i === ids.length - 1 ? nowMs + 1500 : nowMs,
      ),
    );
    recordResume(planPath, ENV, nowMs + 1500);
  }

  function moveToSession(id: string, session: string): void {
    mkdirSync(join(dir, 'subagents', session), { recursive: true });
    // Re-stamp the records with the session that now owns them: a
    // transcript COPIED into another session's directory is not that
    // session's evidence, and production refuses the misplaced shape.
    const from = join(dir, 'subagents', 'S1', `agent-${id}.jsonl`);
    const to = join(dir, 'subagents', session, `agent-${id}.jsonl`);
    writeFileSync(
      to,
      readFileSync(from, 'utf8').replaceAll(
        '"sessionId":"S1"',
        `"sessionId":"${session}"`,
      ),
    );
    rmSync(from, { force: true });
    if (ledgerNowMs > 0) {
      const at = new Date(ledgerNowMs);
      utimesSync(to, at, at);
    }
  }

  it('a superseded prior-attempt declaration does not delete the chunk it covers', () => {
    // The prior attempt's chunk-1 agent declared chunk 1 unreachable; this
    // run's chunk-1 agent read it. The post-loop `covered.delete()` is
    // order-independent, so without the supersession guard no relaunch could
    // ever clear the cap — on lines this run demonstrably read.
    const p = plan();
    ledger(p, 'S0', 'S1');
    transcript('a1old', good(1), {
      calls: 1,
      text: 'Uncoverable: chunk 1 — line exceeds the read limit',
    });
    moveToSession('a1old', 'S0');
    transcript('a1', good(1), { calls: 3 });
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.uncoverableChunks).toEqual([]);
    expect(r.coveredChunks).toEqual([1, 2]);
    expect(r.ok).toBe(true);
    // ...and the declaring record is not announced as recovered work.
    expect(r.recoveredAgents).toBe(0);
  });

  it('two honest returned declarers annihilate into the relaunch on untrusted metadata', () => {
    // Supersession USED to exclude records that themselves declare the
    // chunk, keeping two honest declarers from annihilating each other —
    // and that same exclusion read a QUOTATION as a declaration (an
    // indented quote starts a line, so the regex matches it) and removed
    // the quoter as the only suppressor, admitting the quote over a chunk
    // the same run demonstrably read (R20-3). The conjunct is reachable
    // only when the plan's metadata cannot prove unspannability, and there
    // any compliant returned record stands the declaration down: two
    // honest declarers annihilate into `missingChunks`, whose relaunch is
    // the correct repair — a re-plan re-measures the lines, and a chunk
    // genuinely unspannable comes back truncatable, where the declaration
    // is admitted ahead of suppression.
    const p = plan();
    transcript('a1', good(1), {
      calls: 2,
      text: 'Uncoverable: chunk 1 — line exceeds the read limit',
    });
    transcript('a1b', good(1), {
      calls: 2,
      text: 'Uncoverable: chunk 1 — line exceeds the read limit',
    });
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.uncoverableChunks).toEqual([]);
    expect(r.missingChunks).toEqual([1]);
    expect(r.coveredChunks).toEqual([2]);
  });

  it('an unsuperseded declaration still caps, resumed or not', () => {
    const p = plan();
    ledger(p, 'S0', 'S1');
    transcript('a1old', good(1), {
      calls: 1,
      text: 'Uncoverable: chunk 1 — line exceeds the read limit',
    });
    moveToSession('a1old', 'S0');
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.uncoverableChunks).toEqual([1]);
    expect(r.ok).toBe(false);
  });

  it('does not count prior work a current relaunch superseded', () => {
    // The count is what the continuity note reports; claiming recovery for
    // an obligation this run re-did would misdescribe what it reused.
    const p = plan();
    ledger(p, 'S0', 'S1');
    transcript('a1old', good(1), { calls: 2 });
    moveToSession('a1old', 'S0');
    transcript('a1', good(1), { calls: 3 });
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.ok).toBe(true);
    expect(r.recoveredAgents).toBe(0);
  });

  it('a whole-diff recovery is superseded only by a relaunch that opened the brief', () => {
    // `keySatisfied` — the chunk-less arm of the supersession predicates —
    // was reached by no test: its brief requirement could be deleted (or
    // left dangling) with the suite green. The deciding conjunct is the
    // relaunch's brief read, so both arms pin it.
    const p = plan();
    ledger(p, 'S0', 'S1');
    const d = promptRecordDir(p);
    mkdirSync(d, { recursive: true });
    const brief = briefPath(p, 'audit-w');
    writeFileSync(brief, 'The audit-w brief.');
    const prompt =
      'You are review agent `audit-w`.\n' +
      `read_file(file_path="${brief}")\n` +
      wholeDiff();
    writeFileSync(join(d, 'audit-w.txt'), prompt);
    transcript('w1', prompt, { calls: 3 });
    moveToSession('w1', 'S0');
    // The current relaunch never opened its brief: no supersession, the
    // prior work still counts as recovered.
    transcript('w2', prompt, { calls: 3, opens: [] });
    expect(coverageFromTranscripts(p, ENV).recoveredAgents).toBe(1);
    // A compliant relaunch supersedes it.
    transcript('w3', prompt, { calls: 3 });
    expect(coverageFromTranscripts(p, ENV).recoveredAgents).toBe(0);
  });

  it('does NOT credit a prior agent whose text is progress, not a return', () => {
    // `finalText` keeps the last non-empty assistant text, and agents narrate
    // between tool calls — so an agent that said "reading the diff now" and
    // died mid-flight carries plausible text. Tool traffic AFTER the text is
    // what marks it as progress, and the empty-return filter alone cannot
    // see it.
    const p = plan();
    ledger(p, 'S0', 'S1');
    transcript('a1prog', good(1), { calls: 2, text: 'Reading the diff now…' });
    // Re-order: append one more tool call AFTER the text, the died-mid-work
    // shape.
    const f = join(dir, 'subagents', 'S1', 'agent-a1prog.jsonl');
    const lines = readFileSync(f, 'utf8').trim().split('\n');
    const callLine = lines.findIndex((l) => l.includes('functionCall'));
    lines.push(lines[callLine], lines[callLine + 1]);
    writeFileSync(f, lines.join('\n') + '\n');
    moveToSession('a1prog', 'S0');
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.coveredChunks).not.toContain(1);
    expect(r.recoveredAgents).toBe(0);
  });

  it('an honest Uncoverable declaration survives an unreturned relaunch', () => {
    // The probe from review: agent A declares chunk 1 unreachable; a verbatim
    // relaunch B reads the diff once and dies. B must not supersede A — the
    // declaration is the only honest account of the chunk, and B's told-range
    // presumption would otherwise mark it covered.
    const p = plan();
    transcript('aDecl', good(1), {
      calls: 2,
      text: 'Uncoverable: chunk 1 — a line exceeds the read limit',
    });
    transcript('aRelaunch', good(1), { calls: 1, text: '' });
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.ok).toBe(false);
    expect(r.uncoverableChunks).toEqual([1]);
    expect(r.coveredChunks).not.toContain(1);
  });

  it('an unreturned narration of the template line declares nothing', () => {
    // `finalText` keeps narration emitted between tool calls; only
    // `returned` separates a return from progress. A chunk agent on a
    // truncatable chunk that echoed the template line mid-work and then made
    // one more call (or died) has declared nothing — and pinning the chunk
    // `declared-uncoverable` off that narration steered the repair away
    // from the relaunch the chunk needs. Same bar every crediting sibling
    // already applies (R31-1).
    const p = plan(2, { longLineChunk: 1 });
    transcript('a1', good(1), {
      calls: 1,
      range: [0, 100],
      text: 'Uncoverable: chunk 1 — line exceeds the read limit',
    });
    // One successful tool call AFTER the text: progress, not a return.
    const base = {
      agentId: 'a1',
      agentName: 'general-purpose',
      sessionId: 'S1',
    };
    appendFileSync(
      join(dir, 'subagents', 'S1', 'agent-a1.jsonl'),
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
      }) +
        '\n' +
        JSON.stringify({
          ...base,
          type: 'tool_result',
          message: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'read_file',
                  response: { output: 'diff bytes' },
                },
              },
            ],
          },
        }) +
        '\n',
    );
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.uncoverableChunks).toEqual([]);
    expect(r.missingChunks).toEqual([1]);
    expect(r.coveredChunks).toEqual([2]);
    expect(r.chunkItems.find((i) => i.id === 1)?.classification).not.toBe(
      'declared-uncoverable',
    );
  });

  it('an unreturned paraphrased declarer declares nothing either', () => {
    // The chunk-less arm carries the same return requirement (R31-1): the
    // paraphrased launch below is the shape `seals and admits a paraphrased
    // declarer the anchored regex de-assigned` admits when it RETURNS.
    const p = plan(2, { longLineChunk: 2 });
    transcript('a1', good(1), { calls: 2 });
    transcript(
      'a2para',
      'Please review chunk 2 of 2 carefully.\n' +
        `read_file(file_path="${DIFF}", offset=100, limit=100)`,
      {
        calls: 1,
        range: [100, 100],
        text: 'Uncoverable: chunk 2 — line exceeds the read limit',
      },
    );
    const base = {
      agentId: 'a2para',
      agentName: 'general-purpose',
      sessionId: 'S1',
    };
    appendFileSync(
      join(dir, 'subagents', 'S1', 'agent-a2para.jsonl'),
      JSON.stringify({
        ...base,
        type: 'assistant',
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'read_file',
                args: { file_path: DIFF, offset: 100, limit: 100 },
              },
            },
          ],
        },
      }) +
        '\n' +
        JSON.stringify({
          ...base,
          type: 'tool_result',
          message: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'read_file',
                  response: { output: 'diff bytes' },
                },
              },
            ],
          },
        }) +
        '\n',
    );

    const r = coverageFromTranscripts(p, ENV);
    expect(r.uncoverableChunks).toEqual([]);
    expect(r.coveredChunks).toEqual([1]);
    expect(r.missingChunks).toEqual([2]);
  });

  it('a declaration the plan measurement contradicts does not cap a paraphrased relaunch', () => {
    // Attempt 1 declared chunk 1 unreachable; the continuation relaunched
    // chunk 1 with a paraphrased prompt, and the agent read lines spanning
    // the chunk. The plan's own measurement says every line fits under the
    // read cap, so `planContradictsDeclaration` refuses the declaration and
    // the paraphrased relaunch keeps its spanning coverage — without the
    // refusal the paraphrase fails `chunkSatisfied`'s verbatim bar, the
    // declaration passes the guard, and the post-loop subtraction deletes
    // the very coverage the walk credited. The fixture measures its chunks
    // at 42: a zero measurement is untrusted metadata (the planner writes
    // >= 1 for any non-empty chunk) that contradicts nothing.
    const p = plan(2, { maxLineChars: 42 });
    ledger(p, 'S0', 'S1');
    transcript('a1old', good(1), {
      calls: 1,
      text: 'Uncoverable: chunk 1 — line exceeds the read limit',
    });
    moveToSession('a1old', 'S0');
    const paraphrased =
      `Please review chunk 1 of 2 carefully.\n` +
      `read_file(file_path="${chunkBrief(1)}")\n` +
      `read_file(file_path="${DIFF}", offset=0, limit=100)`;
    transcript('a1relaunch', paraphrased, { calls: 1, range: [0, 100] });
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.uncoverableChunks).toEqual([]);
    expect(r.coveredChunks).toEqual([1, 2]);
    expect(r.ok).toBe(true);
  });

  it('a false declaration beside a quoting whole-diff auditor does not cap live coverage', () => {
    // The quoter shape: a whole-diff auditor whose return QUOTES the
    // declaration it audited is not declaring — `declaresOwnUncoverable`
    // alone matches the quotation, because an indented quote starts a line.
    // The plan's own measurement says every line fits, so the false
    // declaration is contradicted outright and the auditor's live spanning
    // coverage stands; admitted anyway, the declaration would pin
    // `declared-uncoverable` — nothing a relaunch repairs — over a chunk
    // the same run demonstrably spanned. The fixture measures its chunks at
    // 42: a zero measurement is untrusted metadata (the planner writes
    // >= 1 for any non-empty chunk) that contradicts nothing.
    transcript('a1', good(1), {
      calls: 1,
      text: 'Uncoverable: chunk 1 — line exceeds the read limit',
    });
    transcript('w1', wholeDiff(), {
      ranges: [
        [0, 100],
        [100, 100],
      ],
      text:
        'The chunk-1 agent returned:\n' +
        '  Uncoverable: chunk 1 — line exceeds the read limit\n' +
        'My own reads spanned the whole chunk.',
    });
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(plan(2, { maxLineChars: 42 }), ENV);
    expect(r.uncoverableChunks).toEqual([]);
    expect(r.coveredChunks).toEqual([1, 2]);
    expect(r.ok).toBe(true);
  });

  it('a quoter whose launch spells no reads does not cap live coverage', () => {
    // The round-20 fix closed the no-reads shape with `diffReads.length >
    // 0`, but the containment check — the branch's only quoter defense —
    // stays vacuous when the launch spells NO reads: `pointedAt` returns
    // [], and [].every(...) is true. A heavily paraphrased whole-diff
    // launch — the diff path present, no offset/limit spelled — pages the
    // diff with ranged reads spanning every chunk and returns a QUOTATION
    // of the declaration indented, and every seal passes: the
    // untrusted-metadata plan contradicts nothing, no returned superseder
    // exists, and the entrance gate cannot tell the shape (a whole-diff
    // launch carries no identity line). Admitted, the quotation stripped
    // the spanning coverage the same run's reads earned and the chunk left
    // `missingChunks`, so the relaunch that would cover it was never
    // emitted. A genuine paraphrased declarer's launch spells the ranged
    // read that showed it the over-cap line; the branch refuses the
    // vacuous shape (R20-4).
    const p = plan();
    transcript(
      'w1',
      'Security review of the whole diff.\n' + `read_file(file_path="${DIFF}")`,
      {
        ranges: [
          [0, 100],
          [100, 100],
        ],
        text:
          'The chunk-2 agent returned:\n' +
          '  Uncoverable: chunk 2 — line exceeds the read limit\n' +
          'My own reads spanned the whole diff.',
      },
    );
    transcript('w2', wholeDiff(), {
      ranges: [
        [0, 100],
        [100, 100],
      ],
    });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.uncoverableChunks).toEqual([]);
    expect(r.coveredChunks).toEqual([1, 2]);
  });

  it('adjudicates a declarer quoting another chunk\u2019s declaration ahead of its own', () => {
    // The all-match witness: the return quotes chunk 2's declaration —
    // indented, as a quotation — BEFORE the record's own declaration. The
    // first-match read adjudicated the quoted id, failed containment, and
    // fell through with the honest declaration dropped undisclosed while
    // the credit gate certified the chunk covered off the declarer's own
    // reads. Every match is now adjudicated in text order: the quoted id
    // fails the containment gate, and the record's own line is admitted
    // (R22-2).
    const good3 = (c: number) =>
      `You are review agent \`chunk ${c} of 3\` — the territory agent for ` +
      `lines ${(c - 1) * 100 + 1}-${c * 100} of the diff.\n` +
      `read_file(file_path="${chunkBrief(c)}")\n` +
      `read_file(file_path="${DIFF}", offset=${(c - 1) * 100}, limit=100)`;
    const p = plan(3, { record: false });
    built(p, 1, good3(1));
    built(p, 2, good3(2));
    built(p, 3, good3(3));
    transcript('a1', good3(1), { calls: 2 });
    transcript('a2', good3(2), { calls: 2 });
    transcript(
      'w3',
      `Please review chunk 3 of 3 carefully.\n` +
        `read_file(file_path="${chunkBrief(3)}")\n` +
        `read_file(file_path="${DIFF}", offset=200, limit=100)`,
      {
        calls: 1,
        range: [200, 100],
        text:
          'The chunk-2 agent returned:\n' +
          '  Uncoverable: chunk 2 — line exceeds the read limit\n' +
          'Uncoverable: chunk 3 — line exceeds the read limit',
      },
    );

    const r = coverageFromTranscripts(p, ENV);
    expect(r.uncoverableChunks).toEqual([3]);
    expect(r.coveredChunks).toEqual([1, 2]);
    const entry = r.chunkItems.find((i) => i.id === 3);
    expect(entry?.outcome).toBe('uncoverable');
    expect(entry?.classification).toBe('declared-uncoverable');
  });

  it('refuses coverage credit to a no-reads declarer the plan proves unspannable', () => {
    // The refused-declarer arm: the shape gate refuses a launch that
    // spells NO reads, and the refusal used to fall through to the credit
    // gate, which certified the declared chunk covered off the declarer's
    // own spanning reads — truncated by construction for a chunk the
    // plan's own measurement proves unspannable. The declaration is
    // refused (the launch proves nothing), but the chunk goes to
    // `missingChunks` — the relaunch that works — instead of being
    // certified covered: the R17-4 drop surviving in the fall-through
    // shape (R20-4).
    const p = plan(2, { longLineChunk: 2 });
    transcript('a1', good(1), { calls: 2 });
    transcript(
      'w1',
      'Security review of the whole diff.\n' + `read_file(file_path="${DIFF}")`,
      {
        ranges: [
          [0, 100],
          [100, 100],
        ],
        text: 'Uncoverable: chunk 2 — line exceeds the read limit',
      },
    );

    const r = coverageFromTranscripts(p, ENV);
    expect(r.uncoverableChunks).toEqual([]);
    expect(r.coveredChunks).toEqual([1]);
    expect(r.missingChunks).toEqual([2]);
    expect(r.ok).toBe(false);
  });

  it('a no-reads quoter of a truncatable chunk keeps its credit for the chunks it spanned', () => {
    // The refused no-reads declarer used to be DROPPED as a record, so a
    // whole-diff quoter of chunk 2's declaration lost its spanning credit
    // for chunk 1 too — the identical record over a non-truncatable chunk 2
    // kept both, opposite treatment purely from the quoted chunk's
    // metadata (R28-1). The exclusion is per CHUNK: the declared truncatable
    // chunk is withheld from this record's credit (the premise the test
    // above pins), the rest of its reads keep theirs.
    const p = plan(2, { longLineChunk: 2 });
    transcript(
      'w1',
      'Security review of the whole diff.\n' + `read_file(file_path="${DIFF}")`,
      {
        ranges: [
          [0, 100],
          [100, 100],
        ],
        text:
          'The chunk-2 agent returned:\n' +
          '  Uncoverable: chunk 2 — line exceeds the read limit',
      },
    );

    const r = coverageFromTranscripts(p, ENV);
    expect(r.coveredChunks).toEqual([1]);
    expect(r.missingChunks).toEqual([2]);
    expect(r.uncoverableChunks).toEqual([]);
  });

  it('a declarer whose spelled reads overshoot a truncatable chunk does not certify it', () => {
    // The containment gate refuses a declarer pointed past its chunk's
    // window — a genuine declarer is pointed at its chunk alone — and the
    // refusal fell through to the credit gate, where the same reads
    // certified the declared chunk covered: a chunk the plan's own
    // measurement says no read can return, wearing `covered` (R27-1). The
    // declaration is still not admitted (the shape is a quoter's), but the
    // chunk lands in `missingChunks`, the relaunch that yields a declaration
    // about this plan's lines.
    const p = plan(2, { longLineChunk: 2 });
    transcript('a1', good(1), { calls: 2 });
    transcript(
      'd2',
      'Please review chunk 2 of 2 carefully.\n' +
        `read_file(file_path="${chunkBrief(2)}")\n` +
        `read_file(file_path="${DIFF}", offset=100, limit=150)`,
      {
        calls: 1,
        range: [100, 150],
        text: 'Uncoverable: chunk 2 — line exceeds the read limit',
      },
    );

    const r = coverageFromTranscripts(p, ENV);
    expect(r.coveredChunks).toEqual([1]);
    expect(r.uncoverableChunks).toEqual([]);
    expect(r.missingChunks).toEqual([2]);
    // Same record over a chunk the plan can span: a quoter shape, and its
    // reads keep their credit — the exclusion rides the plan's measurement.
    const q = plan(2, { maxLineChars: 42 });
    transcript('a1', good(1), { calls: 2 });
    transcript(
      'd2',
      'Please review chunk 2 of 2 carefully.\n' +
        `read_file(file_path="${chunkBrief(2)}")\n` +
        `read_file(file_path="${DIFF}", offset=100, limit=150)`,
      {
        calls: 1,
        range: [100, 150],
        text: 'Uncoverable: chunk 2 — line exceeds the read limit',
      },
    );
    expect(coverageFromTranscripts(q, ENV).coveredChunks).toEqual([1, 2]);
  });

  it('does not count a prior agent that declared ITS OWN chunk unreachable', () => {
    // The veto on the recovery count, pinned: the declaration is a disclosed
    // gap, and counting the record beside the cap would announce work
    // "counted as reviewed" next to the gap the same record disclosed.
    const p = plan();
    ledger(p, 'S0', 'S1');
    transcript('a1u', good(1), {
      calls: 2,
      text: 'Uncoverable: chunk 1 — a line exceeds the read limit',
    });
    moveToSession('a1u', 'S0');
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.recoveredAgents).toBe(0);
    expect(r.uncoverableChunks).toEqual([1]);
  });

  it('counts two prior records that only supersede each other', () => {
    // A whiff-relaunch INSIDE the interrupted attempt: two records for the
    // same chunk, both clearing the bar, and no current-session agent at all.
    // Checked against every record, each supersedes the other and both drop
    // out — the continuity note then reports nothing while coverage credits
    // the chunk, so on this single-chunk plan the recovered work appears
    // nowhere. Supersession is about what THIS run re-did.
    const p = plan();
    ledger(p, 'S0', 'S1');
    transcript('a1first', good(1), { calls: 2 });
    moveToSession('a1first', 'S0');
    transcript('a1retry', good(1), { calls: 3 });
    moveToSession('a1retry', 'S0');
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.ok).toBe(true);
    expect(r.coveredChunks).toEqual([1, 2]);
    expect(r.recoveredAgents).toBe(2);
  });

  it('does NOT credit a prior agent that died mid-flight', () => {
    // Verbatim prompt, a logged diff read, and no return: the session was
    // killed before it reported. Crediting it would let the resumed run skip
    // the relaunch and ship a chunk whose findings never existed anywhere.
    const p = plan();
    ledger(p, 'S0', 'S1');
    transcript('a1dead', good(1), { calls: 2, text: '' });
    moveToSession('a1dead', 'S0');
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.coveredChunks).toEqual([2]);
    expect(r.missingChunks).toEqual([1]);
    expect(r.recoveredAgents).toBe(0);
    expect(r.ok).toBe(false);
  });

  it('counts recovered KEY-shaped work (verify/reverse-audit), not only chunks', () => {
    // Every other recoveredAgents fixture is chunk-shaped; the key-shaped
    // branch of `certifies()` — the one production uses for recovered
    // whole-diff roles — was countable by nothing.
    const p = plan();
    ledger(p, 'S0', 'S1');
    const d = promptRecordDir(p);
    mkdirSync(d, { recursive: true });
    const key = 'reverse-audit';
    const brief = briefPath(p, key);
    writeFileSync(brief, 'The brief.');
    const prompt =
      'You are review agent `reverse-audit`.\n' +
      `read_file(file_path="${brief}")\n` +
      `read_file(file_path="${DIFF}")`;
    writeFileSync(join(d, `${encodeURIComponent(key)}.txt`), prompt);
    transcript('ra0', prompt, { calls: 2, opens: [brief] });
    moveToSession('ra0', 'S0');
    transcript('a1', good(1), { calls: 2 });
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.recoveredAgents).toBe(1);
  });

  it('credits the prior attempt when this session launched nothing at all', () => {
    // The zero-launch continuation: the harness creates subagents/<session>
    // on the first launch, so a run that recovered everything has no dir.
    const p = plan();
    ledger(p, 'S0', 'S1');
    transcript('a1', good(1), { calls: 3 });
    transcript('a2', good(2), { calls: 2 });
    for (const name of readdirSync(join(dir, 'subagents', 'S1'))) {
      moveToSession(name.replace(/^agent-|\.jsonl$/g, ''), 'S0');
    }
    rmSync(join(dir, 'subagents', 'S1'), { recursive: true, force: true });

    const r = coverageFromTranscripts(p, ENV);
    // `ok` is the verdict that decides exit 0 vs exit 3 (relaunch
    // everything) — the point of the continuation is that it does not.
    expect(r.ok).toBe(true);
    expect(r.coveredChunks).toEqual([1, 2]);
    // EXACT: the prior session holds three recoverable records — the two
    // chunk agents plus the roster stand-in, which recovers through the
    // whole-diff branch of `certifies()` (no `chunk N of M` in its launch).
    // `>= 2` could not see that branch: deleting it read 3 as 2 and stayed
    // green, silently dropping recovered whole-diff work (verify,
    // reverse-audit) from the continuity count.
    expect(r.recoveredAgents).toBe(3);
    // The ledger's provenance split, on the run that produces it: chunks this
    // session did not read, credited to the attempt that did. `recovered`
    // rather than `covered` is the whole distinction — and it is covered
    // scope, so the run is not reported as a gap.
    expect(r.chunkItems.map((i) => i.outcome)).toEqual([
      'recovered',
      'recovered',
    ]);
  });
});

describe('coverage — an honest Uncoverable declaration is not refuted by the read that produced it', () => {
  it("a declarer performing the launch prompt's spelled-out read still lands declared-uncoverable", () => {
    // Production shape: `buildChunkLaunchPrompt` spells out a ranged read of
    // the chunk's own window for EVERY chunk agent, unreachable ones
    // included, and a compliant declarer performs exactly that read before
    // returning the declaration. The read lands in `diffReads` spanning the
    // chunk, so a refutation scan that quantifies over the declarer too
    // refutes every honest declaration through the very read that motivated
    // it — the chunk drops to `missingChunks` with no cause, and
    // check-coverage prescribes relaunching a chunk no read can span,
    // forever.
    const p = plan();
    transcript('a1', good(1), {
      calls: 1,
      range: [0, 100],
      text: 'Uncoverable: chunk 1 — line exceeds the read limit',
    });
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.uncoverableChunks).toEqual([1]);
    expect(r.missingChunks).toEqual([]);
    expect(r.coveredChunks).toEqual([2]);
    expect(r.ok).toBe(false);
    const entry = r.chunkItems.find((i) => i.id === 1);
    expect(entry?.outcome).toBe('uncoverable');
    expect(entry?.classification).toBe('declared-uncoverable');
  });

  it('a spanning read of a long-line chunk is a truncated view and refutes nothing', () => {
    // The whole-diff agents' prompts carry one ranged read per chunk, so one
    // of them RETURNs a read spanning the declarer's chunk too. For a chunk
    // whose longest line exceeds the read cap — the planner's own
    // `maxLineChars` pre-detection — that read necessarily truncated before
    // returning the window: counting it as a demonstration that the chunk
    // CAN be spanned refutes the honest declaration and certifies the chunk
    // COVERED on a tail no read ever returned.
    const p = plan(2, { longLineChunk: 1 });
    transcript('a1', good(1), {
      calls: 1,
      range: [0, 100],
      text: 'Uncoverable: chunk 1 — line exceeds the read limit',
    });
    transcript('w1', wholeDiff(), { calls: 2, range: [0, 100] });
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.uncoverableChunks).toEqual([1]);
    expect(r.coveredChunks).toEqual([2]);
    expect(r.missingChunks).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it('a plan without maxLineChars cannot refute a declaration either', () => {
    // The planner has written `maxLineChars` unconditionally since the plan
    // format's first release, so a plan without it is hand-edited or
    // degraded, not legacy. Its absence leaves the truncation question
    // unanswered — the spanning read may have been the truncated kind —
    // and a refutation the metadata cannot clear would delete an honest
    // declaration on a guess. Fail closed: no metadata, no refutation.
    const p = plan();
    const stripped = JSON.parse(readFileSync(p, 'utf8'));
    for (const c of stripped.chunks) delete c.maxLineChars;
    writeFileSync(p, JSON.stringify(stripped));
    const old = new Date(2020, 0, 1);
    utimesSync(p, old, old);
    transcript('a1', good(1), {
      calls: 1,
      text: 'Uncoverable: chunk 1 — line exceeds the read limit',
    });
    transcript('w1', wholeDiff(), { calls: 2, range: [0, 100] });
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.uncoverableChunks).toEqual([1]);
    expect(r.coveredChunks).toEqual([2]);
    expect(r.missingChunks).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it('a hand-zeroed maxLineChars cannot refute a declaration either', () => {
    // The planner measures >= 1 for every non-empty chunk, so a zero lives
    // only on a hand-edited plan — untrusted metadata, the same shape as
    // its absence above: the spanning read may have been the truncated
    // kind, and a refutation the metadata cannot clear would delete an
    // honest declaration on a guess. Fail closed: `<= 0`, no refutation.
    // The fixture mirrors the quoting-auditor shape, differing only in the
    // measurement — there the plan's measurement contradicts the
    // declaration; here the declaration stands.
    const p = plan();
    transcript('a1', good(1), {
      calls: 1,
      range: [0, 100],
      text: 'Uncoverable: chunk 1 — line exceeds the read limit',
    });
    transcript('w1', wholeDiff(), {
      ranges: [
        [0, 100],
        [100, 100],
      ],
      text: 'My reads spanned the whole diff.',
    });
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.uncoverableChunks).toEqual([1]);
    expect(r.coveredChunks).toEqual([2]);
    expect(r.missingChunks).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it('a returned verbatim relaunch does not supersede a declaration the plan itself confirms', () => {
    // The honest-declaration shape is exactly `maxLineChars > CAP`: the
    // builder hands the template only to such chunks, and the planner's
    // measurement proves no read can return the window. A relaunch that
    // returns ordinary prose after one diff call clears `chunkSatisfied`'s
    // bar — returned, verbatim, a diff call — but cannot have returned the
    // window the plan proves unspannable; admitting the suppression let the
    // told-range presumption certify a tail no read ever returned — the
    // back door beside the guarded front door (the refutation guard's
    // `> CAP` arm, pinned above). The UNRETURNED twin is pinned in the
    // sibling describe ('survives an unreturned relaunch'); this is the
    // returned one.
    const p = plan(2, { longLineChunk: 1 });
    transcript('a1', good(1), {
      calls: 1,
      range: [0, 100],
      text: 'Uncoverable: chunk 1 — line exceeds the read limit',
    });
    transcript('a1b', good(1), { calls: 1, text: 'Reviewed the chunk.' });
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.uncoverableChunks).toEqual([1]);
    expect(r.coveredChunks).toEqual([2]);
    expect(r.ok).toBe(false);
    const entry = r.chunkItems.find((i) => i.id === 1);
    expect(entry?.outcome).toBe('uncoverable');
    expect(entry?.classification).toBe('declared-uncoverable');
  });

  it('a superseded rewritten record leaves no cause behind', () => {
    // The supersession gate suppresses the blind/idle/rewritten PROSE for a
    // record a verbatim relaunch superseded — but the rewritten arm's
    // chunk-cause note carried no gate, so `classify()` diagnosed a prompt
    // defect the relaunch already repaired while the suppressed prose array
    // said nothing. First record: chunk 2 launched with a paraphrase,
    // worked, read without spanning. The operator rebuilt and relaunched;
    // the rebuild on disk is stale — it points at the wrong window, the
    // state family the supersession machinery exists to serve — and the
    // relaunch delivered it verbatim. The stale rebuild points at the
    // wrong window, so the relaunch fails the territory seal too — no
    // agent is noted under this plan's chunk — and the superseded cause
    // leaves nothing behind: 'no-agent'.
    const p = plan();
    const stale =
      `You are review agent \`chunk 2 of 2\` — the territory agent.\n` +
      `read_file(file_path="${chunkBrief(2)}")\n` +
      `read_file(file_path="${DIFF}", offset=0, limit=50)`;
    writeFileSync(join(promptRecordDir(p), 'chunk-2.txt'), stale);
    const paraphrased =
      `Please review chunk 2 of 2 carefully.\n` +
      `read_file(file_path="${DIFF}", offset=100, limit=50)`;
    transcript('a2first', paraphrased, { calls: 1, range: [100, 50] });
    transcript('a2relaunch', stale, { calls: 1, range: [0, 50] });
    transcript('a1', good(1), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.missingChunks).toEqual([2]);
    expect(r.rewrittenPrompts).toEqual([]);
    const entry = r.chunkItems.find((i) => i.id === 2);
    expect(entry?.outcome).toBe('missing');
    expect(entry?.classification).toBe('no-agent');
  });

  it('a superseded unopened record leaves no cause behind either', () => {
    // Same gate, sibling arm: the unopened prose push is suppressed for a
    // superseded record, so its cause note must be too, or the ledger
    // contradicts the suppressed prose exactly the way the rewritten arm
    // did. The record was told chunk 2's lines, worked, and never opened
    // the diff; the stale verbatim relaunch opened it — and points at the
    // wrong window, so it fails the territory seal and notes no agent
    // either: with every cause suppressed the residue is 'no-agent'.
    const p = plan();
    const stale =
      `You are review agent \`chunk 2 of 2\` — the territory agent.\n` +
      `read_file(file_path="${chunkBrief(2)}")\n` +
      `read_file(file_path="${DIFF}", offset=0, limit=50)`;
    writeFileSync(join(promptRecordDir(p), 'chunk-2.txt'), stale);
    transcript('a2first', stale, {
      calls: 0,
      opens: [],
      mentions: [chunkBrief(2)],
    });
    transcript('a2relaunch', stale, { calls: 1, range: [0, 50] });
    transcript('a1', good(1), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.missingChunks).toEqual([2]);
    expect(r.unopenedAgents).toEqual([]);
    expect(r.rewrittenPrompts).toEqual([]);
    const entry = r.chunkItems.find((i) => i.id === 2);
    expect(entry?.outcome).toBe('missing');
    expect(entry?.classification).toBe('no-agent');
  });
});

describe('coverage — a stale chunk id cannot break the partition', () => {
  it('drops an Uncoverable declaration for a chunk the plan does not carry', () => {
    // A re-plan left a launch block behind from the old chunking: the record
    // says `chunk 9 of 2` over a 2-chunk plan and declares it unreachable.
    // The plan's ledger can never contain 9, so the declaration is about
    // nothing this run planned — it must be dropped rather than entered into
    // `uncoverable`, which the partition assertion cross-checks against a
    // ledger built only from planned ids. Before the membership check, this
    // exact shape threw `ChunkPartitionError` (`uncoverable disagrees with the
    // ledger — reported=[9] ledger=[]`), crashing `check-coverage` out of its
    // structured fail-closed refusal and aborting `compose-review`'s whole
    // coverage computation on a run that had covered every planned chunk.
    transcript('a1', good(1), { calls: 2 });
    transcript('a2', good(2), { calls: 2 });
    transcript(
      'stale',
      `You are review agent \`chunk 9 of 2\` — the territory agent.\n` +
        `read_file(file_path="${DIFF}", offset=800, limit=100)`,
      {
        calls: 1,
        range: [800, 100],
        text: 'Uncoverable: chunk 9 — line exceeds the read limit',
      },
    );

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.uncoverableChunks).toEqual([]);
    expect(r.missingChunks).toEqual([]);
    expect(r.coveredChunks).toEqual([1, 2]);
    // The stale record is still disclosed — as a prompt defect, which is
    // what it is: no prompt was built for a chunk the plan does not carry.
    expect(r.rewrittenPrompts.join(' ')).toContain('chunk 9');
    expect(r.ok).toBe(false);
  });

  it('drops a stale declaration whose id collides with a planned chunk it does not describe', () => {
    // A re-plan shrank nine chunks to two, and a launch block left behind
    // from the old chunking says `chunk 2 of 9` — its id collides with a
    // chunk this plan carries, so the membership check passes, but its
    // count names a plan this one is not: chunk 2 described different
    // lines when the declaration was written. Chunk 2's own agent was
    // launched verbatim and made a diff call but died before returning —
    // its told-range credit covers the chunk, yet it cannot suppress the
    // stale declaration (`chunkSatisfied` requires a RETURNED superseder)
    // nor refute it (no returned spanning read exists). Admitted anyway,
    // the declaration erased the coverage the walk itself credited and
    // capped the verdict on a chunk a relaunch could cover.
    transcript('a1', good(1), { calls: 2 });
    transcript('a2', good(2), { calls: 1, text: '' });
    transcript(
      'stale',
      `You are review agent \`chunk 2 of 9\` — the territory agent.\n` +
        `read_file(file_path="${DIFF}", offset=800, limit=100)`,
      {
        calls: 1,
        range: [800, 100],
        text: 'Uncoverable: chunk 2 — line exceeds the read limit',
      },
    );

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.uncoverableChunks).toEqual([]);
    expect(r.coveredChunks).toEqual([1, 2]);
    // Still disclosed as a prompt defect — the record ran on a launch the
    // CLI did not build for this plan's chunk 2.
    expect(r.rewrittenPrompts.join(' ')).toContain('chunk 2');
    expect(r.ok).toBe(false);
  });

  it('classifies a collided chunk by its live cause, not the stale declaration', () => {
    // The same collision over a repairable failure: chunk 2's relaunch was
    // paraphrased — it kept the identity line and the spelled reads (a
    // rewrite that altered the READS would spell a window that is not this
    // chunk's, and the territory seal would key no cause through it), but
    // it worked on another file and never opened the diff, so the chunk is
    // genuinely missing and its live cause is the rewrite. The stale
    // `chunk 2 of 9` declaration passed the membership-only guard and
    // outranked that cause (`classify()` orders the declaration first),
    // handing the operator "no read can span it" — nothing a relaunch
    // repairs — for a chunk a relaunch could cover.
    transcript('a1', good(1), { calls: 2 });
    transcript(
      'a2',
      good(2).replace('the territory agent', 'the chunk agent'),
      { calls: 2, toolPath: '/abs/other-file.ts' },
    );
    transcript(
      'stale',
      `You are review agent \`chunk 2 of 9\` — the territory agent.\n` +
        `read_file(file_path="${DIFF}", offset=800, limit=100)`,
      {
        calls: 1,
        range: [800, 100],
        text: 'Uncoverable: chunk 2 — line exceeds the read limit',
      },
    );

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.uncoverableChunks).toEqual([]);
    expect(r.missingChunks).toEqual([2]);
    const entry = r.chunkItems.find((i) => i.id === 2);
    expect(entry?.outcome).toBe('missing');
    expect(entry?.classification).toBe('rewritten-prompt');
  });

  it('drops a stale declaration whose count matches but whose window moved', () => {
    // The collision the `of M` count cannot see. A re-plan kept TWO chunks and
    // shifted their windows, so a launch left over from the old chunking says
    // `chunk 2 of 2` — membership passes, and so does the count seal, because
    // both plans have two chunks.
    //
    // It reaches the walk because `since` fences transcripts by their FILE's
    // mtime and the harness appends every event through one long-lived fd: a
    // record written before a same-session re-plan lands in a file the re-plan
    // leaves NEWER than the plan, so the fence never sees it. Chunk 2's live
    // agent was launched verbatim and died before returning, so neither
    // `chunkSatisfied` (needs a RETURNED superseder) nor the spanning-read
    // refutation can stand the declaration down.
    //
    // Territory is what tells the two plans apart: this launch was told to read
    // lines 801-900, and the chunk 2 it names now spans 101-200.
    transcript('a1', good(1), { calls: 2 });
    transcript('a2', good(2), { calls: 1, text: '' });
    transcript(
      'stale',
      `You are review agent \`chunk 2 of 2\` — the territory agent.\n` +
        `read_file(file_path="${DIFF}", offset=800, limit=100)`,
      {
        calls: 1,
        range: [800, 100],
        text: 'Uncoverable: chunk 2 — line exceeds the read limit',
      },
    );

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.uncoverableChunks).toEqual([]);
    expect(r.missingChunks).toEqual([]);
    expect(r.coveredChunks).toEqual([1, 2]);
    const entry = r.chunkItems.find((i) => i.id === 2);
    expect(entry?.outcome).toBe('covered');
    expect(entry?.classification).toBeUndefined();
  });

  it("still admits a declaration whose told-range is its chunk's own window", () => {
    // The control for the guard above, and the reason it is a territory test
    // rather than a blanket refusal: the same fixture with the declarer reading
    // the window it declares is an HONEST declaration, and it must still stand.
    // Without this pair, a mutant that dropped every declaration would ship
    // green on the test above.
    transcript('a1', good(1), { calls: 2 });
    transcript('a2', good(2), {
      calls: 1,
      text: 'Uncoverable: chunk 2 — line exceeds the read limit',
    });

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.uncoverableChunks).toEqual([2]);
    const entry = r.chunkItems.find((i) => i.id === 2);
    expect(entry?.outcome).toBe('uncoverable');
    expect(entry?.classification).toBe('declared-uncoverable');
  });

  it('drops a stale declaration whose old window is a superset of the re-planned chunk', () => {
    // The containment edge of the territory seal. A re-plan kept two chunks
    // but shrank chunk 2's tail — [101,200] became [101,185] — and the old
    // launch's told [101,200] still CONTAINS the new window, so a
    // containment test would pass membership, count and territory alike for
    // a declaration written against the old lines, and `uncoverable.add`
    // would erase the chunk's live coverage. An honest declarer's
    // told-range spans its chunk EXACTLY (the launch spells the chunk's own
    // window); exactness is what tells the plans apart.
    const p = join(dir, 'plan.json');
    const shrunk =
      `You are review agent \`chunk 2 of 2\` — the territory agent.\n` +
      `read_file(file_path="${chunkBrief(2)}")\n` +
      `read_file(file_path="${DIFF}", offset=100, limit=85)`;
    writeFileSync(
      p,
      JSON.stringify({
        diffPathAbsolute: DIFF,
        srcDiffLines: 5000,
        diffLines: 5000,
        files: [
          { path: 'a.ts', kind: 'source', removedLines: 0, heavy: false },
        ],
        chunks: [
          { id: 1, startLine: 1, endLine: 100, maxLineChars: 0 },
          { id: 2, startLine: 101, endLine: 185, maxLineChars: 0 },
        ],
      }),
    );
    built(p, 1);
    built(p, 2, shrunk);
    satisfyRoster(p);
    const old = new Date(2020, 0, 1);
    utimesSync(p, old, old);
    transcript('a1', good(1), { calls: 2 });
    // Chunk 2's live agent: launched verbatim, made a diff call, died
    // before returning — told-credit covers the shrunken window, and the
    // unreturned shape leaves no superseder and no refuting read.
    transcript('a2', shrunk, { calls: 1, text: '' });
    transcript(
      'stale',
      `You are review agent \`chunk 2 of 2\` — the territory agent.\n` +
        `read_file(file_path="${DIFF}", offset=100, limit=100)`,
      {
        calls: 1,
        range: [100, 100],
        text: 'Uncoverable: chunk 2 — line exceeds the read limit',
      },
    );

    const r = coverageFromTranscripts(p, ENV);
    expect(r.uncoverableChunks).toEqual([]);
    expect(r.missingChunks).toEqual([]);
    expect(r.coveredChunks).toEqual([1, 2]);
    const entry = r.chunkItems.find((i) => i.id === 2);
    expect(entry?.outcome).toBe('covered');
  });

  it('still admits a declaration whose told-range is the shrunken window itself', () => {
    // The positive control for the exact-span seal: the same shrunken plan,
    // but the declarer's launch spells the window it declares. A mutant
    // that flipped the seal to refuse everything would ship green on the
    // drop test alone.
    const p = join(dir, 'plan.json');
    const shrunk =
      `You are review agent \`chunk 2 of 2\` — the territory agent.\n` +
      `read_file(file_path="${chunkBrief(2)}")\n` +
      `read_file(file_path="${DIFF}", offset=100, limit=85)`;
    writeFileSync(
      p,
      JSON.stringify({
        diffPathAbsolute: DIFF,
        srcDiffLines: 5000,
        diffLines: 5000,
        files: [
          { path: 'a.ts', kind: 'source', removedLines: 0, heavy: false },
        ],
        chunks: [
          { id: 1, startLine: 1, endLine: 100, maxLineChars: 0 },
          { id: 2, startLine: 101, endLine: 185, maxLineChars: 0 },
        ],
      }),
    );
    built(p, 1);
    built(p, 2, shrunk);
    satisfyRoster(p);
    const old = new Date(2020, 0, 1);
    utimesSync(p, old, old);
    transcript('a1', good(1), { calls: 2 });
    transcript('a2', shrunk, {
      calls: 1,
      range: [100, 85],
      text: 'Uncoverable: chunk 2 — line exceeds the read limit',
    });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.uncoverableChunks).toEqual([2]);
    expect(r.missingChunks).toEqual([]);
    const entry = r.chunkItems.find((i) => i.id === 2);
    expect(entry?.outcome).toBe('uncoverable');
    expect(entry?.classification).toBe('declared-uncoverable');
  });

  it('a stale idle record keys no cause and no agent into this plan\u2019s chunk', () => {
    // The cause notes keyed the record's `chunk N of M` id against the
    // CURRENT plan with no identity seal, while the declaration branch in
    // the same walk required membership, count and territory because "a
    // stale id can collide with a planned one". A stale `chunk 2 of 9`
    // surviving the mtime fence noted `idle` for this plan's chunk 2 and
    // put its label in the ledger's agents, where the true state is
    // no-agent and nobody. The prose arrays still name the record — those
    // describe the RECORD — but the ledger is this plan's.
    transcript('a1', good(1), { calls: 2 });
    transcript(
      'stale',
      `You are review agent \`chunk 2 of 9\` — the territory agent.\n` +
        `read_file(file_path="${DIFF}", offset=800, limit=100)`,
      { calls: 0 },
    );

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.idleAgents).toContain('chunk 2');
    expect(r.missingChunks).toEqual([2]);
    const entry = r.chunkItems.find((i) => i.id === 2);
    expect(entry?.outcome).toBe('missing');
    expect(entry?.classification).toBe('no-agent');
    expect(entry?.agents).toEqual([]);
  });

  it('a stale blind record does not outrank the genuine current cause', () => {
    // The same seal on the blind arm. `classify()` orders the prompt-defect
    // family above `idle`, so an unsealed stale `chunk 2 of 9` launch
    // without the diff noted `blind-prompt` for this plan's chunk 2 and
    // outranked the chunk's genuine current idle — handing the operator
    // "rebuild the prompt" for a prompt this run delivered verbatim.
    transcript('a1', good(1), { calls: 2 });
    transcript('a2', good(2), { calls: 0 });
    transcript(
      'stale',
      'You are review agent `chunk 2 of 9` — the territory agent for lines 801-900 of the diff.',
      { calls: 0 },
    );

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.blindAgents).toContain('chunk 2');
    const entry = r.chunkItems.find((i) => i.id === 2);
    expect(entry?.outcome).toBe('missing');
    expect(entry?.classification).toBe('idle');
  });
});

describe('coverage — a declaration must be evidenced by the declarer\u2019s own reads', () => {
  it('does not admit a declaration from an agent whose ranged reads avoid the chunk', () => {
    // Told the right window, it read lines 1-50 only and returned the
    // declaration line its prompt carried: membership, count and the
    // told-range territory all pass, but its own ranged reads prove it
    // never reached the chunk it declares. Admitted anyway, the verdict
    // pinned `declared-uncoverable` — nothing is repaired by relaunching —
    // over a repairable gap, steering every classification-routing
    // consumer away from the one repair that works. Refused, the chunk is
    // the relaunchable gap its reads demonstrate.
    transcript('a1', good(1), { calls: 2 });
    transcript('a2', good(2), {
      calls: 1,
      range: [0, 50],
      text: 'Uncoverable: chunk 2 — line exceeds the read limit',
    });

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.uncoverableChunks).toEqual([]);
    expect(r.missingChunks).toEqual([2]);
    const entry = r.chunkItems.find((i) => i.id === 2);
    expect(entry?.outcome).toBe('missing');
    expect(entry?.classification).toBe('unknown');
  });

  it('admits a declaration whose paged reads together span the chunk', () => {
    // The guard merges before it asks: a declarer that paged its window in
    // two abutting reads holds the same evidence as one spanning read —
    // paging is what the prompt tells it to do when a read truncates. A
    // mutant dropping the merge refuses this honest declarer.
    transcript('a1', good(1), { calls: 2 });
    transcript('a2', good(2), {
      ranges: [
        [100, 50],
        [150, 50],
      ],
      text: 'Uncoverable: chunk 2 — line exceeds the read limit',
    });

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.uncoverableChunks).toEqual([2]);
    expect(r.missingChunks).toEqual([]);
    const entry = r.chunkItems.find((i) => i.id === 2);
    expect(entry?.outcome).toBe('uncoverable');
    expect(entry?.classification).toBe('declared-uncoverable');
  });

  it('admits a declaration whose launch pasted two adjacent blocks', () => {
    // The territory seal exact-matched the MERGED told-range, and chunks
    // tile contiguously: a pasted-two-blocks launch spells the declarer's
    // own window beside its neighbour's, the merge coalesces the pair,
    // and the exact match refused the genuine this-plan declaration
    // purely from the paste — the credit gate then certified the
    // unspannable chunk off the same record's spanning read (R18-1).
    // Any contiguous RUN of the spelled reads that is the window proves
    // the launch was written against it.
    transcript('a1', good(1), { calls: 2 });
    transcript(
      'a2pasted',
      `You are review agent \`chunk 2 of 2\` — the territory agent for lines 101-200 of the diff.\n` +
        `read_file(file_path="${chunkBrief(2)}")\n` +
        `read_file(file_path="${DIFF}", offset=0, limit=100)\n` +
        `read_file(file_path="${DIFF}", offset=100, limit=100)`,
      {
        ranges: [
          [0, 100],
          [100, 100],
        ],
        text: 'Uncoverable: chunk 2 — line exceeds the read limit',
      },
    );

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.uncoverableChunks).toEqual([2]);
    expect(r.coveredChunks).toEqual([1]);
    expect(r.missingChunks).toEqual([]);
    expect(r.ok).toBe(false);
    const entry = r.chunkItems.find((i) => i.id === 2);
    expect(entry?.outcome).toBe('uncoverable');
    expect(entry?.classification).toBe('declared-uncoverable');
    expect(entry?.agents).toEqual(['chunk 2']);
  });

  it('seals and admits a paraphrased declarer the anchored regex de-assigned', () => {
    // The anchored CHUNK_RE de-assigns a launch the orchestrator
    // paraphrased — the words survive, the identity line does not. The
    // declaration branch never saw the record, its own `Uncoverable:`
    // return was dropped undisclosed, and the credit gate certified the
    // truncated read that motivated the declaration (R17-4). The walk
    // takes the id from the declaration line itself and routes it through
    // the seals; the declarer's own ranged read of its window is the
    // evidence that admits it.
    transcript('a1', good(1), { calls: 2 });
    transcript(
      'a2para',
      'Please review chunk 2 of 2 carefully.\n' +
        `read_file(file_path="${DIFF}", offset=100, limit=100)`,
      {
        calls: 1,
        range: [100, 100],
        text: 'Uncoverable: chunk 2 — line exceeds the read limit',
      },
    );

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.uncoverableChunks).toEqual([2]);
    expect(r.coveredChunks).toEqual([1]);
    expect(r.missingChunks).toEqual([]);
    expect(r.ok).toBe(false);
    // The branch records its own cause and declarer directly: it has
    // already run its own seals, and `noteChunkCause`'s re-applied
    // `sealedToThisPlan` cannot hold here — a record reaches this branch
    // exactly when CHUNK_RE did not match, so the count conjunct
    // (`assignedChunkTotal === plan.chunks.length`) is guaranteed false
    // and the cause would be silently dropped, classifying the chunk
    // `no-agent` while the walk's own admission says a record declared it
    // unreachable (R17-4).
    const entry = r.chunkItems.find((i) => i.id === 2);
    expect(entry?.outcome).toBe('uncoverable');
    expect(entry?.classification).toBe('declared-uncoverable');
    expect(entry?.agents).toEqual(['Please review chunk 2 of 2 carefully.']);
  });

  it('assigns a case- or whitespace-variant identity line the label parser already reads', () => {
    // `CHUNK_RE` and `CHUNK_ROLE_RE` must agree: a launch the one assigns,
    // the other labels. A hand-edited `Chunk 2 of 2` was labeled `chunk 2`
    // yet de-assigned, fell between the assigned arm and the chunk-less
    // arm's entrance gate (an identity line is present, so it read as a
    // role launch), and its spanning read certified a truncatable chunk
    // covered while the honest declaration was dropped (R31-2).
    const p = plan(2, { longLineChunk: 2 });
    transcript('a1', good(1), { calls: 2 });
    transcript('a2case', good(2).replace('`chunk 2 of 2`', '`Chunk  2 of 2`'), {
      calls: 1,
      range: [100, 100],
      text: 'Uncoverable: chunk 2 — line exceeds the read limit',
    });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.uncoverableChunks).toEqual([2]);
    expect(r.coveredChunks).toEqual([1]);
    expect(r.ok).toBe(false);
    const entry = r.chunkItems.find((i) => i.id === 2);
    expect(entry?.outcome).toBe('uncoverable');
    expect(entry?.classification).toBe('declared-uncoverable');
    expect(entry?.agents).toEqual(['chunk 2']);
    // The prefix stays case-sensitive: a lower-cased prefix is not an
    // identity line to either parser, so it assigns nothing.
    expect(CHUNK_RE.test('you are review agent `chunk 2 of 2` — forged')).toBe(
      false,
    );
  });

  it('assigns a slot with a trailing space inside the backticks — one parser, one answer', () => {
    // Entrance (1) of R32-1: `chunk 2 of 2 ` was a role to the label parser
    // and nothing to the assignment regex, so the record walked the credit
    // gate as a role launch and certified a truncatable chunk covered while
    // its honest declaration was dropped. Assignment and label now read the
    // same slot, and the slot tolerates surrounding whitespace.
    const p = plan(2, { longLineChunk: 2 });
    transcript('a1', good(1), { calls: 2 });
    transcript('a2sp', good(2).replace('`chunk 2 of 2`', '`chunk 2 of 2 `'), {
      calls: 1,
      range: [100, 100],
      text: 'Uncoverable: chunk 2 — line exceeds the read limit',
    });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.uncoverableChunks).toEqual([2]);
    expect(r.coveredChunks).toEqual([1]);
    expect(r.ok).toBe(false);
    expect(r.chunkItems.find((i) => i.id === 2)).toMatchObject({
      outcome: 'uncoverable',
      classification: 'declared-uncoverable',
      agents: ['chunk 2'],
    });
  });

  it('a role launch quoting a chunk launch below its own identity line is not assigned the quote', () => {
    // Entrance (2) of R32-1: the assignment regex took the FIRST chunk-shaped
    // identity line anywhere, so a verifier whose launch quoted a chunk
    // launch verbatim (identity line at line start) was assigned that chunk,
    // and its QUOTED declaration was admitted by the assigned-declarer arm —
    // `uncoverable.add` fired and `covered.delete` stripped the live agent's
    // coverage of lines the run demonstrably read. Assignment now reads the
    // launch's first identity line, the verifier's own: a role. Its reads
    // keep their credit, the quote declares nothing.
    const p = plan();
    transcript('a1', good(1), { calls: 2 });
    transcript(
      'v1',
      'You are review agent `verify` — Verification agent (round 1).\n' +
        'Prior finding, quoted from the chunk launch:\n' +
        good(2) +
        '\n' +
        `read_file(file_path="${DIFF}", offset=0, limit=100)`,
      {
        ranges: [
          [0, 100],
          [100, 100],
        ],
        text:
          'The chunk-2 agent returned:\n' +
          '  Uncoverable: chunk 2 — line exceeds the read limit\n' +
          'Verified: the read spans the window.',
      },
    );

    const r = coverageFromTranscripts(p, ENV);
    expect(r.uncoverableChunks).toEqual([]);
    expect(r.coveredChunks).toEqual([1, 2]);
    expect(r.chunkItems.find((i) => i.id === 2)?.agents).toEqual([]);
  });

  it('a newline inside the slot is an identity to neither parser', () => {
    // Entrance (3) of R32-1: `\s+` in the assignment regex spanned a newline
    // the label parser's backticked slot refuses, so the record was assigned
    // a chunk while carrying no identity — half-owned: the ledger named it
    // the chunk's owner while the credit exclusion treated it as
    // identity-less. Both parsers now refuse it, and the record walks the
    // chunk-less arm consistently: the quoted truncatable chunk is withheld
    // from its credit, the chunk it demonstrably spanned keeps it.
    const split =
      'You are review agent `chunk 2\nof 2` — the territory agent.\n' +
      `read_file(file_path="${DIFF}", offset=0, limit=100)\n` +
      `read_file(file_path="${DIFF}", offset=100, limit=100)`;
    expect(labelFromLaunchPrompt(split)).toBeNull();
    expect(chunkAssignmentFromLaunchPrompt(split)).toBeNull();
    const p = plan(2, { longLineChunk: 2 });
    transcript('w1', split, {
      ranges: [
        [0, 100],
        [100, 100],
      ],
      text:
        'The chunk-2 agent returned:\n' +
        '  Uncoverable: chunk 2 — line exceeds the read limit',
    });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.coveredChunks).toEqual([1]);
    expect(r.missingChunks).toEqual([2]);
    expect(r.uncoverableChunks).toEqual([]);
  });

  it('a quoted declaration annihilates into the relaunch on untrusted metadata', () => {
    // The suppression conjunct's declarer-exclusion reads a QUOTATION the
    // same as a declaration: the relaunch below merely quotes the template
    // line indented — normal pipeline prose — and that excludes it as the
    // declarer's only suppressor. With trusted metadata the truncatable and
    // contradictory shapes answer first; the conjunct is reachable ONLY on
    // the untrusted shape (absent or hand-zeroed `maxLineChars`), where
    // the plan cannot prove unspannability — so any compliant returned
    // record must stand the declaration down, and two honest declarers
    // annihilate into `missingChunks`, whose relaunch is the correct
    // repair there (R20-3).
    transcript('a1', good(1), { calls: 2 });
    transcript('a2first', good(2), {
      calls: 1,
      range: [100, 100],
      text: 'Uncoverable: chunk 2 — line exceeds the read limit',
    });
    transcript('a2relaunch', good(2), {
      calls: 1,
      range: [100, 100],
      text:
        'Reviewed again.\n' +
        '  Uncoverable: chunk 2 — line exceeds the read limit',
    });
    transcript('w', wholeDiff(), {
      ranges: [
        [0, 100],
        [100, 100],
      ],
    });

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.uncoverableChunks).toEqual([]);
    expect(r.coveredChunks).toEqual([1, 2]);
  });

  it('the unassigned arm fails toward suppression like the assigned arm', () => {
    // The suppression conjunct's two call sites share one shape, and the
    // unassigned arm carried the same defect twice over: the paraphrased
    // declarer was admitted because its only suppressors — the returned
    // chunk agents — all wore declarations (one honest, one a QUOTE), and
    // the exclusion removed every one (R20-3).
    transcript('a1', good(1), { calls: 2 });
    transcript('a2honest', good(2), {
      calls: 1,
      range: [100, 100],
      text: 'Uncoverable: chunk 2 — line exceeds the read limit',
    });
    transcript('a2quote', good(2), {
      calls: 1,
      range: [100, 100],
      text:
        'Reviewed again.\n' +
        '  Uncoverable: chunk 2 — line exceeds the read limit',
    });
    transcript(
      'a2para',
      'Please review chunk 2 of 2 carefully.\n' +
        `read_file(file_path="${DIFF}", offset=100, limit=100)`,
      {
        calls: 1,
        range: [100, 100],
        text: 'Uncoverable: chunk 2 — line exceeds the read limit',
      },
    );
    transcript('w', wholeDiff(), {
      ranges: [
        [0, 100],
        [100, 100],
      ],
    });

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.uncoverableChunks).toEqual([]);
    expect(r.coveredChunks).toEqual([1, 2]);
  });

  it('a role agent quoting the declaration is not an unassigned declarer', () => {
    // A chunk-scoped role launch carries a role identity line (never
    // CHUNK_RE-matched), walks chunk-less, and spells exactly the declared
    // chunk's window — so the containment shape passes for a quotation,
    // the seals admitted it (truncatable short-circuit), and the quoted
    // line stripped the live coverage of a chunk the same run demonstrably
    // read. Role agents never declare chunks: a launch still carrying ANY
    // intact identity line is not the paraphrased chunk launch this branch
    // exists for (R20-4).
    const p = plan(2, { longLineChunk: 2 });
    transcript('a1', good(1), { calls: 2 });
    transcript(
      'ra',
      'You are review agent `reverse-audit` — Reverse audit (round 1).\n' +
        `read_file(file_path="${DIFF}", offset=100, limit=100)`,
      {
        calls: 1,
        range: [100, 100],
        text:
          'Prior round reported:\n' +
          '  Uncoverable: chunk 2 — line exceeds the read limit\n' +
          'Continuing the audit.',
      },
    );

    const r = coverageFromTranscripts(p, ENV);
    expect(r.uncoverableChunks).toEqual([]);
    expect(r.coveredChunks).toEqual([1, 2]);
  });

  it('an unassigned declarer with no ranged reads cannot strip a grown window', () => {
    // The branch's territory substitute is containment, not the assigned
    // arm's exact-window seal, and `declarerReadItsChunk` fails open on
    // empty `diffReads` — so a fence-surviving paraphrased declarer whose
    // spelled OLD window is a strict subset of the re-planned window rode
    // the fail-open and erased the live agent's spanning coverage of the
    // grown window. The arm has no told-range seal for the presumption to
    // preserve: an honest declarer discovered the over-cap line through a
    // ranged read, so requiring one loses no honest declaration (R20-5).
    const p = join(dir, 'plan.json');
    writeFileSync(
      p,
      JSON.stringify({
        diffPathAbsolute: DIFF,
        srcDiffLines: 5000,
        diffLines: 300,
        files: [
          { path: 'a.ts', kind: 'source', removedLines: 0, heavy: false },
        ],
        chunks: [
          { id: 1, startLine: 1, endLine: 100, maxLineChars: 0 },
          { id: 2, startLine: 101, endLine: 300, maxLineChars: 0 },
        ],
      }),
    );
    const live2 =
      'You are review agent `chunk 2 of 2` — the territory agent for ' +
      'lines 101-300 of the diff.\n' +
      `read_file(file_path="${chunkBrief(2)}")\n` +
      `read_file(file_path="${DIFF}", offset=100, limit=200)`;
    built(p, 1);
    built(p, 2, live2);
    satisfyRoster(p);
    const old = new Date(2020, 0, 1);
    utimesSync(p, old, old);

    transcript('a1', good(1), { calls: 2 });
    // The live agent died before returning — told-range presumption still
    // credits the grown window — while the stale declarer read the diff
    // with no positive limit, leaving `diffReads` empty.
    transcript('a2live', live2, { calls: 1, text: '' });
    transcript(
      'a2stale',
      'Please review chunk 2 of 2 carefully.\n' +
        `read_file(file_path="${DIFF}", offset=100, limit=100)`,
      {
        calls: 1,
        text: 'Uncoverable: chunk 2 — line exceeds the read limit',
      },
    );

    const r = coverageFromTranscripts(p, ENV);
    expect(r.uncoverableChunks).toEqual([]);
    expect(r.coveredChunks).toEqual([1, 2]);
  });
});

describe('coverage — the plan-identity token orders records against a re-plan', () => {
  // Windows, counts and reads cannot order a record against a same-session
  // re-plan: a modify-only commit keeps every window, so a fence-surviving
  // record of the OLD plan passes the geometry seals with its old cause
  // intact. The launch carries the plan's epoch instead — a short token of
  // its capture identity, written by `buildChunkLaunchPrompt` — and the seal
  // refuses a launch marked with ANOTHER plan's token while a marker-less
  // launch keeps the pre-token posture.
  let diffPath: string;
  beforeEach(() => {
    diffPath = join(dir, 'the.diff');
  });
  const chunks = [
    { id: 1, startLine: 1, endLine: 100, maxLineChars: 0 },
    { id: 2, startLine: 101, endLine: 200, maxLineChars: 0 },
  ];
  const identityOf = (diffText: string) =>
    buildSelectionIdentity(diffText, chunks as unknown as DiffChunk[], 200);
  /** A plan over `diffText` carrying a real selection identity. */
  function identityPlan(diffText: string): string {
    writeFileSync(diffPath, diffText);
    const p = join(dir, 'plan.json');
    writeFileSync(
      p,
      JSON.stringify({
        diffPathAbsolute: diffPath,
        srcDiffLines: 5000,
        diffLines: 200,
        files: [
          { path: 'a.ts', kind: 'source', removedLines: 0, heavy: false },
        ],
        chunks,
        selection: identityOf(diffText),
      }),
    );
    satisfyRoster(p);
    const old = new Date(2020, 0, 1);
    utimesSync(p, old, old);
    return p;
  }
  const tokenOf = (diffText: string): string =>
    planIdentityToken(identityOf(diffText)) as string;
  /** What `buildChunkLaunchPrompt` emits for an identity-carrying plan. */
  const launch = (c: number, token: string): string =>
    `You are review agent \`chunk ${c} of 2\` — the territory agent for ` +
    `lines ${(c - 1) * 100 + 1}-${c * 100} of the diff.\n` +
    `Plan identity: ${token}\n` +
    `read_file(file_path="${chunkBrief(c)}")\n` +
    `read_file(file_path="${diffPath}", offset=${(c - 1) * 100}, limit=100)`;

  const OLD = 'diff --git a/a.ts b/a.ts\n@@ -1,1 +1,1 @@\n-old\n';
  const NEW = 'diff --git a/a.ts b/a.ts\n@@ -1,1 +1,1 @@\n+new\n';

  it('drops a stale declaration the re-plan kept every window for', () => {
    // The shape the territory seal cannot see: a modify-only rewrite keeps
    // the line counts and every window, and the identity moves. The old
    // declarer survives the mtime fence (the long-lived fd shape), its told
    // range EQUALS the current window and its reads still span it — every
    // older seal passes. The live agent was relaunched verbatim from the
    // new plan and died before returning, so neither supersession nor a
    // returned spanning read can stand the declaration down. Only the token
    // tells the plans apart.
    const p = identityPlan(NEW);
    const current = tokenOf(NEW);
    built(p, 1, launch(1, current));
    built(p, 2, launch(2, current));
    transcript('a1', launch(1, current), {
      calls: 1,
      range: [0, 100],
      toolPath: diffPath,
    });
    transcript('b2', launch(2, current), {
      calls: 1,
      text: '',
      toolPath: diffPath,
    });
    transcript('a2stale', launch(2, tokenOf(OLD)), {
      calls: 1,
      range: [100, 100],
      toolPath: diffPath,
      opens: [],
      text: 'Uncoverable: chunk 2 — line exceeds the read limit',
    });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.uncoverableChunks).toEqual([]);
    expect(r.coveredChunks).toEqual([1, 2]);
    const entry = r.chunkItems.find((i) => i.id === 2);
    expect(entry?.outcome).toBe('covered');
    // The stale record is still disclosed — as a prompt defect — but its
    // declaration describes a plan this one is not.
    expect(r.rewrittenPrompts.join(' ')).toContain('chunk 2');
  });

  it('drops a marker-less stale declaration the re-plan kept every window for', () => {
    // The marker-less twin of the test above: a paraphrase that dropped
    // the identity line AND the token line survives the mtime fence, its
    // spelled window passes containment (a modify-only re-plan keeps every
    // window), its ranged read spans the chunk, and the metadata is the
    // fail-open shape. `launchOfThisPlan` fails open on a marker-less
    // launch, so the stale declaration stripped the live agent's coverage
    // and the chunk left `missingChunks`. The fail-closed token check
    // refuses it the same way the sibling chunk-less paths do; over an
    // identity-carrying plan the chunk stays covered, and the relaunch
    // re-delivers a marked launch the assigned arm can admit — the
    // repair a standing declaration blocks (R21-8).
    const p = identityPlan(NEW);
    const current = tokenOf(NEW);
    built(p, 1, launch(1, current));
    built(p, 2, launch(2, current));
    transcript('a1', launch(1, current), {
      calls: 1,
      range: [0, 100],
      toolPath: diffPath,
    });
    transcript('b2', launch(2, current), {
      calls: 1,
      text: '',
      toolPath: diffPath,
    });
    transcript(
      'a2stale',
      `Please review chunk 2 of 2 carefully.\n` +
        `read_file(file_path="${chunkBrief(2)}")\n` +
        `read_file(file_path="${diffPath}", offset=100, limit=100)`,
      {
        calls: 1,
        range: [100, 100],
        toolPath: diffPath,
        opens: [],
        text: 'Uncoverable: chunk 2 — line exceeds the read limit',
      },
    );

    const r = coverageFromTranscripts(p, ENV);
    expect(r.uncoverableChunks).toEqual([]);
    expect(r.coveredChunks).toEqual([1, 2]);
    const entry = r.chunkItems.find((i) => i.id === 2);
    expect(entry?.outcome).toBe('covered');
  });

  it('a stale-token record keys no cause and no agent into this plan', () => {
    // The note arms' witness: the re-plan moved the windows; the stale
    // record carries the old plan's token. Without the token conjunct its
    // rewrite notes 'rewritten-prompt' for this plan's chunk 2 and its
    // label lands in the ledger's agents — where the truth is no-agent,
    // because no LIVE record was ever assigned to it.
    const p = identityPlan(NEW);
    const current = tokenOf(NEW);
    built(p, 1, launch(1, current));
    built(p, 2, launch(2, current));
    transcript('a1', launch(1, current), {
      calls: 1,
      range: [0, 100],
      toolPath: diffPath,
    });
    transcript(
      'stale',
      launch(2, tokenOf(OLD)).replace(
        'offset=100, limit=100',
        'offset=200, limit=100',
      ),
      { calls: 1, range: [200, 100], toolPath: diffPath, opens: [] },
    );

    const r = coverageFromTranscripts(p, ENV);
    expect(r.rewrittenPrompts.join(' ')).toContain('chunk 2');
    expect(r.missingChunks).toEqual([2]);
    const entry = r.chunkItems.find((i) => i.id === 2);
    expect(entry?.outcome).toBe('missing');
    expect(entry?.classification).toBe('no-agent');
    expect(entry?.agents).toEqual([]);
  });

  it('a stale-token cause does not outrank the genuine current cause', () => {
    // The second note-arm witness: chunk 2's live agent worked but never
    // opened the diff — the genuine cause is `unopened`. The stale record's
    // `rewritten-prompt` outranks it in classify()'s fixed order, handing
    // the operator "rebuild the prompt" for a prompt this run delivered
    // verbatim.
    const p = identityPlan(NEW);
    const current = tokenOf(NEW);
    built(p, 1, launch(1, current));
    built(p, 2, launch(2, current));
    transcript('a1', launch(1, current), {
      calls: 1,
      range: [0, 100],
      toolPath: diffPath,
    });
    transcript('a2', launch(2, current), {
      calls: 2,
      toolPath: '/abs/other-file.ts',
    });
    transcript(
      'stale',
      launch(2, tokenOf(OLD)).replace(
        'offset=100, limit=100',
        'offset=200, limit=100',
      ),
      { calls: 1, range: [200, 100], toolPath: diffPath, opens: [] },
    );

    const r = coverageFromTranscripts(p, ENV);
    const entry = r.chunkItems.find((i) => i.id === 2);
    expect(entry?.outcome).toBe('missing');
    expect(entry?.classification).toBe('unopened');
  });

  it('still admits a declaration whose launch carries the current token', () => {
    // The positive control: the token refuses ANOTHER plan's launches, not
    // this plan's. Same fixture family, but the declarer was launched
    // verbatim from the current plan.
    const p = identityPlan(NEW);
    const current = tokenOf(NEW);
    built(p, 1, launch(1, current));
    built(p, 2, launch(2, current));
    transcript('a1', launch(1, current), {
      calls: 1,
      range: [0, 100],
      toolPath: diffPath,
    });
    transcript('a2', launch(2, current), {
      calls: 1,
      range: [100, 100],
      toolPath: diffPath,
      text: 'Uncoverable: chunk 2 — line exceeds the read limit',
    });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.uncoverableChunks).toEqual([2]);
    const entry = r.chunkItems.find((i) => i.id === 2);
    expect(entry?.outcome).toBe('uncoverable');
    expect(entry?.classification).toBe('declared-uncoverable');
  });

  it('a stale-token record earns no coverage credit, even when it spans', () => {
    // The credit-loop witness: the re-plan kept every window, so the stale
    // record's told-range and reads are geometrically identical to this
    // plan's chunk 2 — geometry alone would cover the chunk off the OLD
    // plan's read. The token is the only fact that tells the plans apart,
    // so the credit loop asks for it exactly the way the note arms do.
    const p = identityPlan(NEW);
    const current = tokenOf(NEW);
    built(p, 1, launch(1, current));
    built(p, 2, launch(2, current));
    transcript('a1', launch(1, current), {
      calls: 1,
      range: [0, 100],
      toolPath: diffPath,
    });
    transcript('a2stale', launch(2, tokenOf(OLD)), {
      calls: 1,
      range: [100, 100],
      toolPath: diffPath,
      opens: [],
      text: 'Reviewed chunk 2 thoroughly.',
    });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.coveredChunks).toEqual([1]);
    expect(r.missingChunks).toEqual([2]);
    expect(r.ok).toBe(false);
  });

  it('drops a marker-less stale declaration the re-plan kept every window for — the assigned twin', () => {
    // The assigned twin of the marker-less test above: this stale launch
    // KEEPS the anchored identity line (CHUNK_RE assigns it chunk 2) and
    // the spelled reads, and drops only the `Plan identity:` line. The
    // assigned declarer arm rides `sealedToThisPlan`, whose token conjunct
    // failed open on the marker-less launch — admitting the declaration off
    // the OLD diff and erasing the live relaunch's told-range coverage.
    // Fail-closed, the seal refuses it and the chunk stays covered (R22-3).
    const p = identityPlan(NEW);
    const current = tokenOf(NEW);
    built(p, 1, launch(1, current));
    built(p, 2, launch(2, current));
    transcript('a1', launch(1, current), {
      calls: 1,
      range: [0, 100],
      toolPath: diffPath,
    });
    transcript('b2', launch(2, current), {
      calls: 1,
      text: '',
      toolPath: diffPath,
    });
    transcript(
      'a2stale',
      launch(2, tokenOf(OLD)).replace(`Plan identity: ${tokenOf(OLD)}\n`, ''),
      {
        calls: 1,
        range: [100, 100],
        toolPath: diffPath,
        opens: [],
        text: 'Uncoverable: chunk 2 — line exceeds the read limit',
      },
    );

    const r = coverageFromTranscripts(p, ENV);
    expect(r.uncoverableChunks).toEqual([]);
    expect(r.coveredChunks).toEqual([1, 2]);
    const entry = r.chunkItems.find((i) => i.id === 2);
    expect(entry?.outcome).toBe('covered');
  });

  it('drops a marker-less stale budget-gap disclosure the re-plan kept every window for', () => {
    // The budget-gap arm's twin: the gate is sealed because a disclosure
    // has NO geometry backstop — it rides straight into the posted report.
    // The seal's token conjunct failed open on the marker-less launch, so
    // the stale record's OLD-plan gap capped this run. Fail-closed, the
    // gap is dropped (R22-3).
    const p = identityPlan(NEW);
    const current = tokenOf(NEW);
    built(p, 1, launch(1, current));
    built(p, 2, launch(2, current));
    transcript('a1', launch(1, current), {
      calls: 1,
      range: [0, 100],
      toolPath: diffPath,
    });
    // The live relaunch carries a gap of its own: a gap-free superseder
    // would silence the stale disclosure by supersession alone, hiding
    // whether the SEAL dropped it — this twin must fail on the conjunct,
    // not pass on the suppression.
    transcript('a2', launch(2, current), {
      calls: 1,
      range: [100, 100],
      toolPath: diffPath,
      text: 'Walked the diff.\nBudget gap: the reconnect state machine',
    });
    transcript(
      'g2stale',
      launch(2, tokenOf(OLD)).replace(`Plan identity: ${tokenOf(OLD)}\n`, ''),
      {
        calls: 1,
        range: [100, 100],
        toolPath: diffPath,
        opens: [],
        text:
          'Walked the diff.\n' +
          'Budget gap: second-order callers of getAuthTypeFromEnv',
      },
    );

    const r = coverageFromTranscripts(p, ENV);
    expect(r.budgetGaps).toEqual([
      { agent: 'chunk 2', gaps: ['the reconnect state machine'] },
    ]);
    expect(r.coveredChunks).toEqual([1, 2]);
  });

  it('refuses the drift rescue to a marker-less stale record the count cannot tell apart', () => {
    // The rescue arm's twin: the re-plan restored the count to 2, so the
    // count conjunct cannot tell the stale record apart — it keeps the
    // identity line and the spelled reads, and drops only the token line.
    // Its brief-open and diff read are facts about the plan that DELIVERED
    // them; the rescue rides the full seal, whose token conjunct failed
    // open and certified this plan's roster requirement off the old
    // plan's delivery (R22-3).
    const p = identityPlan(NEW);
    const current = tokenOf(NEW);
    built(p, 1, launch(1, current));
    built(p, 2, launch(2, current));
    transcript('a1', launch(1, current), {
      calls: 1,
      range: [0, 100],
      toolPath: diffPath,
    });
    transcript(
      'r2stale',
      launch(2, tokenOf(OLD)).replace(`Plan identity: ${tokenOf(OLD)}\n`, ''),
      { calls: 1, range: [100, 100], toolPath: diffPath },
    );

    const r = coverageFromTranscripts(p, ENV);
    expect(r.missingRoles.join(' ')).toContain('chunk 2');
    expect(r.coveredChunks).toEqual([1]);
    expect(r.ok).toBe(false);
  });

  it('refuses coverage credit to a marker-less stale record over a modify-only re-plan', () => {
    // The credit gate's token witness: windows, count AND territory are
    // identical by construction on a modify-only re-plan — only the token
    // tells the plans apart, and the gate's chunk arm failed open on the
    // marker-less launch. The stale record keeps the identity line and the
    // spelled reads but dropped the `Plan identity:` line, and no live
    // agent covers the chunk (R22-1).
    const p = identityPlan(NEW);
    const current = tokenOf(NEW);
    built(p, 1, launch(1, current));
    built(p, 2, launch(2, current));
    transcript('a1', launch(1, current), {
      calls: 1,
      range: [0, 100],
      toolPath: diffPath,
    });
    transcript(
      'a2stale',
      launch(2, tokenOf(OLD)).replace(`Plan identity: ${tokenOf(OLD)}\n`, ''),
      { calls: 1, range: [100, 100], toolPath: diffPath, opens: [] },
    );

    const r = coverageFromTranscripts(p, ENV);
    expect(r.rewrittenPrompts.join(' ')).toContain('chunk 2');
    expect(r.coveredChunks).toEqual([1]);
    expect(r.missingChunks).toEqual([2]);
    expect(r.ok).toBe(false);
  });

  it('a stale-token record earns no drifted-launch rescue either', () => {
    // The rescue witness: the stale record opened THIS plan's brief file —
    // the path survives the re-plan — and did real diff work, so the
    // near-verbatim rescue would vouch for it as a delivery that "stands".
    // The open and the read are facts about the OLD plan's delivery; the
    // token tells the plans apart, and refused, the record lands where the
    // rewrite check puts any launch that is not this plan's.
    const p = identityPlan(NEW);
    const current = tokenOf(NEW);
    built(p, 1, launch(1, current));
    built(p, 2, launch(2, current));
    transcript('a1', launch(1, current), {
      calls: 1,
      range: [0, 100],
      toolPath: diffPath,
    });
    transcript('a2stale', launch(2, tokenOf(OLD)), {
      calls: 1,
      range: [100, 100],
      toolPath: diffPath,
      opens: [chunkBrief(2)],
      text: 'Reviewed chunk 2 thoroughly.',
    });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.driftedLaunches).toEqual([]);
    expect(r.rewrittenPrompts.join(' ')).toContain('chunk 2');
  });

  it('does not rescue a role delivery the old plan made', () => {
    // The roster rescue certifies a role on brief-open plus tool calls
    // alone. `briefPath` is stable across re-plans, and so is the diff's —
    // so the old plan's working role agent opened THIS plan's brief and
    // read THIS diff, and an unsealed rescue vouched for THAT delivery as
    // this plan's: `missingRoles` stayed empty and the run certified a
    // brief delivery it never made. The chunk loop's drifted-launch note
    // was sealed in this diff for exactly this reason; the rescue is
    // sealed the same way — the open and the read are facts about the
    // plan that delivered them, and the token tells the plans apart.
    const p = identityPlan(NEW);
    const current = tokenOf(NEW);
    built(p, 1, launch(1, current));
    built(p, 2, launch(2, current));
    transcript('a1', launch(1, current), {
      calls: 1,
      range: [0, 100],
      toolPath: diffPath,
    });
    transcript('a2', launch(2, current), {
      calls: 1,
      range: [100, 100],
      toolPath: diffPath,
    });
    // The old plan's test-matrix agent: its launch carries the OLD token,
    // but the brief it opens and the diff it reads are this plan's paths.
    rmSync(join(dir, 'subagents', 'S1', 'agent-r-test_matrix.jsonl'), {
      force: true,
    });
    transcript(
      'stale-matrix',
      `You are review agent \`test-matrix\` — Test coverage matrix.\n` +
        `Plan identity: ${tokenOf(OLD)}\n` +
        `read_file(file_path="${briefPath(p, 'test-matrix')}")\n` +
        `read_file(file_path="${diffPath}", offset=0, limit=200)`,
      {
        calls: 1,
        range: [0, 200],
        toolPath: diffPath,
        opens: [briefPath(p, 'test-matrix')],
      },
    );

    const r = coverageFromTranscripts(p, ENV);
    expect(r.driftedLaunches).toEqual([]);
    expect(r.missingRoles).toHaveLength(1);
    expect(r.missingRoles.join(' ')).toContain('its prompt was built');
    expect(r.ok).toBe(false);
  });

  it('does not rescue a marker-less role delivery the old plan made', () => {
    // The probe twin of the witness above with the `Plan identity:` line
    // removed: the chunk-less rescue branch kept a token-only posture, and
    // `launchOfThisPlan` fails open on a marker-less launch — so the old
    // plan's role agent rescued this plan's roster requirement off the old
    // plan's delivery, and `driftedLaunches` affirmatively certified it,
    // while the role never read this diff. Fail closed like the credit
    // gate when the plan carries identity and the record carries none
    // (R20-7).
    const p = identityPlan(NEW);
    const current = tokenOf(NEW);
    built(p, 1, launch(1, current));
    built(p, 2, launch(2, current));
    transcript('a1', launch(1, current), {
      calls: 1,
      range: [0, 100],
      toolPath: diffPath,
    });
    transcript('a2', launch(2, current), {
      calls: 1,
      range: [100, 100],
      toolPath: diffPath,
    });
    rmSync(join(dir, 'subagents', 'S1', 'agent-r-test_matrix.jsonl'), {
      force: true,
    });
    transcript(
      'stale-matrix',
      `You are review agent \`test-matrix\` — Test coverage matrix.\n` +
        `read_file(file_path="${briefPath(p, 'test-matrix')}")\n` +
        `read_file(file_path="${diffPath}", offset=0, limit=200)`,
      {
        calls: 1,
        range: [0, 200],
        toolPath: diffPath,
        opens: [briefPath(p, 'test-matrix')],
      },
    );

    const r = coverageFromTranscripts(p, ENV);
    expect(r.driftedLaunches).toEqual([]);
    expect(r.missingRoles).toHaveLength(1);
    expect(r.missingRoles.join(' ')).toContain('its prompt was built');
    expect(r.missingRoleSelectors).toContain('--role test-matrix');
    expect(r.ok).toBe(false);
  });

  it('a marker-less whole-diff record earns no credit off an identity plan', () => {
    // The credit gate's chunk-less arm collapsed to `launchOfThisPlan`
    // alone — no geometry at all — and a marker-less launch fails it open,
    // so a fence-surviving whole-diff record from the OLD plan certified
    // the re-planned chunks off the old diff's reads, with no disclosure.
    // Windows and reads cannot tie the record to this plan's lines — a
    // whole-diff read spans every window by construction — so the arm
    // fails closed when the plan carries identity and the record carries
    // none (R20-6).
    const shrunk = [
      { id: 1, startLine: 1, endLine: 100, maxLineChars: 0 },
      { id: 2, startLine: 101, endLine: 185, maxLineChars: 0 },
    ];
    writeFileSync(diffPath, NEW);
    const p = join(dir, 'plan.json');
    writeFileSync(
      p,
      JSON.stringify({
        diffPathAbsolute: diffPath,
        srcDiffLines: 5000,
        diffLines: 185,
        files: [
          { path: 'a.ts', kind: 'source', removedLines: 0, heavy: false },
        ],
        chunks: shrunk,
        selection: buildSelectionIdentity(
          NEW,
          shrunk as unknown as DiffChunk[],
          185,
        ),
      }),
    );
    satisfyRoster(p);
    const old = new Date(2020, 0, 1);
    utimesSync(p, old, old);
    const current = planIdentityToken(
      buildSelectionIdentity(NEW, shrunk as unknown as DiffChunk[], 185),
    ) as string;
    built(
      p,
      1,
      'You are review agent `chunk 1 of 2` — the territory agent for ' +
        'lines 1-100 of the diff.\n' +
        `Plan identity: ${current}\n` +
        `read_file(file_path="${chunkBrief(1)}")\n` +
        `read_file(file_path="${diffPath}", offset=0, limit=100)`,
    );
    built(
      p,
      2,
      'You are review agent `chunk 2 of 2` — the territory agent for ' +
        'lines 101-185 of the diff.\n' +
        `Plan identity: ${current}\n` +
        `read_file(file_path="${chunkBrief(2)}")\n` +
        `read_file(file_path="${diffPath}", offset=100, limit=85)`,
    );
    transcript(
      'a1',
      'You are review agent `chunk 1 of 2` — the territory agent for ' +
        'lines 1-100 of the diff.\n' +
        `Plan identity: ${current}\n` +
        `read_file(file_path="${chunkBrief(1)}")\n` +
        `read_file(file_path="${diffPath}", offset=0, limit=100)`,
      { calls: 1, range: [0, 100], toolPath: diffPath },
    );
    // The stale whole-diff record: no `Plan identity:` line, reads that
    // strictly contain the re-planned chunk 2.
    transcript(
      'wstale',
      'Security review of the whole diff.\n' +
        `read_file(file_path="${diffPath}", offset=0, limit=200)`,
      { calls: 1, range: [0, 200], toolPath: diffPath },
    );

    const r = coverageFromTranscripts(p, ENV);
    expect(r.coveredChunks).toEqual([1]);
    expect(r.missingChunks).toEqual([2]);
    expect(r.ok).toBe(false);
  });

  it('does not rescue a chunk delivery the old plan made', () => {
    // The chunk twin of the role-rescue witness: the rescue gated on the
    // token conjunct alone, and a marker-less launch rides it through —
    // so a stale `chunk 2 of 9` record from a re-planned old run that
    // opened this plan's stable brief path and read the diff certified
    // this plan's chunk-2 roster requirement off the OLD plan's
    // delivery: no missingRoles entry, no `--chunk 2` rebuild selector,
    // beside missingChunks reporting chunk 2 missing (R17-2). A record
    // CLAIMING a chunk assignment rides the full seal, and the count
    // tells the plans apart here.
    const p = identityPlan(NEW);
    const current = tokenOf(NEW);
    built(p, 1, launch(1, current));
    built(p, 2, launch(2, current));
    transcript('a1', launch(1, current), {
      calls: 1,
      range: [0, 100],
      toolPath: diffPath,
    });
    transcript(
      'stale',
      `You are review agent \`chunk 2 of 9\` — the territory agent for lines 101-200 of the diff.\n` +
        `read_file(file_path="${chunkBrief(2)}")\n` +
        `read_file(file_path="${diffPath}", offset=100, limit=100)`,
      {
        calls: 1,
        range: [100, 100],
        toolPath: diffPath,
        opens: [chunkBrief(2)],
      },
    );

    const r = coverageFromTranscripts(p, ENV);
    expect(r.missingChunks).toEqual([2]);
    expect(r.missingRoles.join(' ')).toContain('chunk 2');
    expect(r.missingRoleSelectors).toContain('--chunk 2');
    expect(r.ok).toBe(false);
  });

  it('a stale-token record injects no budget gap into this plan', () => {
    // The budget-gap collection sat ABOVE the credit gate's token conjunct
    // and never rode it: a record marked with another plan's token pushed
    // its `Budget gap:` disclosures into this plan's report — the old
    // plan's truncated trace attributed to this run, and `gapsSuperseded`
    // cannot suppress it (supersession requires verbatim delivery of THIS
    // plan's built prompt, which the stale record never had) (R19-28).
    const p = identityPlan(NEW);
    const current = tokenOf(NEW);
    built(p, 1, launch(1, current));
    transcript('a1', launch(1, current), {
      calls: 1,
      range: [0, 100],
      toolPath: diffPath,
    });
    transcript('a2stale', launch(2, tokenOf(OLD)), {
      calls: 1,
      range: [100, 100],
      toolPath: diffPath,
      text: "Budget gap: the old plan's truncated trace",
    });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.budgetGaps).toEqual([]);
    // The record is still disclosed — as a prompt defect.
    expect(r.rewrittenPrompts.join(' ')).toContain('chunk 2');
  });

  it('a marker-less count-changed record injects no budget gap either', () => {
    // The marker-less corner the token conjunct cannot see: a stale record
    // with no `Plan identity:` line fails `launchOfThisPlan` open, and its
    // OLD plan's `Budget gap:` disclosures landed in this run's report —
    // feeding the Step 3D ruling and the not-reviewed rendering — while
    // the credit gate below refused the SAME record on membership + count.
    // The gate's own comment claims it rides what the credit gate carries;
    // mirror the geometry conjuncts (R20-1).
    const p = identityPlan(NEW);
    const current = tokenOf(NEW);
    built(p, 1, launch(1, current));
    built(p, 2, launch(2, current));
    transcript('a1', launch(1, current), {
      calls: 1,
      range: [0, 100],
      toolPath: diffPath,
    });
    // The live agent died before returning, so it cannot supersede the
    // stale record's gaps — the refusal must ride the gate, not
    // suppression.
    transcript('a2live', launch(2, current), {
      calls: 1,
      range: [100, 100],
      toolPath: diffPath,
      text: '',
    });
    transcript(
      'stale9',
      'You are review agent `chunk 2 of 9` — the territory agent for ' +
        'lines 101-200 of the diff.\n' +
        `read_file(file_path="${diffPath}", offset=100, limit=100)`,
      {
        calls: 1,
        range: [100, 100],
        toolPath: diffPath,
        text: "Budget gap: the old plan's truncated trace",
      },
    );

    const r = coverageFromTranscripts(p, ENV);
    expect(r.budgetGaps).toEqual([]);
    // The record is still disclosed — as a prompt defect.
    expect(r.rewrittenPrompts.join(' ')).toContain('chunk 2');
    expect(r.coveredChunks).toEqual([1, 2]);
  });

  it('a marker-less stale record whose window moved injects no budget gap', () => {
    // The corner the count-and-membership arm cannot see: a re-plan kept
    // TWO chunks and moved chunk 2's window, so a fence-surviving
    // marker-less record from the old plan passes membership, count AND
    // the fail-open token — disclosing the OLD plan's `Budget gap:` lines
    // into this plan's report. The credit gate's chunk arm shares the
    // fail-open but its spanning-range requirement backstops it; a gap
    // admitted here rides straight into the posted report with no geometry
    // check at all, so the arm rides the whole plan-identity seal like the
    // note arms (R21-21).
    const moved = [
      { id: 1, startLine: 1, endLine: 100, maxLineChars: 0 },
      { id: 2, startLine: 301, endLine: 400, maxLineChars: 0 },
    ];
    writeFileSync(diffPath, NEW);
    const p = join(dir, 'plan.json');
    writeFileSync(
      p,
      JSON.stringify({
        diffPathAbsolute: diffPath,
        srcDiffLines: 5000,
        diffLines: 400,
        files: [
          { path: 'a.ts', kind: 'source', removedLines: 0, heavy: false },
        ],
        chunks: moved,
        selection: buildSelectionIdentity(
          NEW,
          moved as unknown as DiffChunk[],
          400,
        ),
      }),
    );
    satisfyRoster(p);
    const old = new Date(2020, 0, 1);
    utimesSync(p, old, old);
    const current = planIdentityToken(
      buildSelectionIdentity(NEW, moved as unknown as DiffChunk[], 400),
    ) as string;
    const launchMoved = (c: number): string =>
      `You are review agent \`chunk ${c} of 2\` — the territory agent for ` +
      `lines ${c === 1 ? 1 : 301}-${c === 1 ? 100 : 400} of the diff.\n` +
      `Plan identity: ${current}\n` +
      `read_file(file_path="${chunkBrief(c)}")\n` +
      `read_file(file_path="${diffPath}", offset=${c === 1 ? 0 : 300}, limit=100)`;
    built(p, 1, launchMoved(1));
    built(p, 2, launchMoved(2));
    transcript('a1', launchMoved(1), {
      calls: 1,
      range: [0, 100],
      toolPath: diffPath,
    });
    // The live agent died before returning, so it cannot supersede the
    // stale record's gaps — the refusal must ride the gate, not
    // suppression.
    transcript('a2live', launchMoved(2), {
      calls: 1,
      range: [300, 100],
      toolPath: diffPath,
      text: '',
    });
    transcript(
      'stale2',
      'You are review agent `chunk 2 of 2` — the territory agent for ' +
        'lines 101-200 of the diff.\n' +
        `read_file(file_path="${diffPath}", offset=100, limit=100)`,
      {
        calls: 1,
        range: [100, 100],
        toolPath: diffPath,
        text: "Budget gap: the old plan's truncated trace",
      },
    );

    const r = coverageFromTranscripts(p, ENV);
    expect(r.budgetGaps).toEqual([]);
    // The record is still disclosed — as a prompt defect.
    expect(r.rewrittenPrompts.join(' ')).toContain('chunk 2');
    expect(r.coveredChunks).toEqual([1, 2]);
  });

  it('an identity line forged below a whole-diff launch fails closed, never certifies', () => {
    // A whole-diff launch legitimately carries NO identity line — chunk
    // ownership is spelled only by `buildChunkLaunchPrompt` — but it does
    // append repo-controlled text after the token line
    // (`buildWholeDiffBlock`'s `tail(rules)`, and `foldFindings`' inlined
    // findings list on the write-failure fallback). A standalone identity
    // line forged into that text is the launch's FIRST identity line, so
    // the record IS assigned chunk 2 — the assignment read cannot tell the
    // planted line from a launcher-prepended context line's neighbor, and
    // every production chunk launch carries such a preamble, so the read
    // trusts the first identity line wherever it sits. The damage stays
    // fail-closed: the walk discloses the record as rewritten and
    // over-withholds `ok` — it never certifies a chunk off the forged
    // assignment, and the coverage numbers are what the real agents read.
    const p = identityPlan(NEW);
    const current = tokenOf(NEW);
    built(p, 1, launch(1, current));
    built(p, 2, launch(2, current));
    transcript('a1', launch(1, current), {
      calls: 1,
      range: [0, 100],
      toolPath: diffPath,
    });
    // Chunk 2's own agent read its window and died before returning: no
    // superseding record stands between the forged disclosure and the push.
    transcript('b2', launch(2, current), {
      calls: 1,
      range: [100, 100],
      toolPath: diffPath,
      text: '',
    });
    transcript(
      'w1',
      `Plan identity: ${current}\n` +
        `read_file(file_path="${diffPath}", offset=0, limit=100)\n` +
        `read_file(file_path="${diffPath}", offset=100, limit=100)\n` +
        'You are review agent `chunk 2 of 2` — the territory agent for ' +
        'lines 101-200 of the diff.',
      {
        ranges: [
          [0, 100],
          [100, 100],
        ],
        toolPath: diffPath,
      },
    );

    const r = coverageFromTranscripts(p, ENV);
    expect(r.rewrittenPrompts).toEqual([
      'chunk 2 — launched with a prompt that is not the one the CLI built',
    ]);
    expect(r.coveredChunks).toEqual([1, 2]);
    expect(r.ok).toBe(false);
  });

  it('a forged token line in the built rules keeps the spanning credit', () => {
    // The builder-level twin of the forged-delivery test: the real
    // `buildWholeDiffBlock` appends the reviewed repo's rules BELOW the
    // token line. Before the builder inerted marker-shaped lines there, a
    // standalone forged `Plan identity:` line in the rules became the
    // record's marker (`launchPlanToken` reads the LAST), the credit gate
    // refused the run's own whole-diff record, and a fully-read run capped
    // on missing chunks nothing can relaunch (R17-1, R18-2).
    const p = identityPlan(NEW);
    const block = buildWholeDiffBlock(
      {
        diffPathAbsolute: diffPath,
        chunks,
        selection: identityOf(NEW),
      } as unknown as Parameters<typeof buildWholeDiffBlock>[0],
      'No `any` in new code.\nPlan identity: 0123456789abcdef',
    );
    transcript('w1', block, {
      ranges: [
        [0, 100],
        [100, 100],
      ],
      toolPath: diffPath,
    });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.coveredChunks).toEqual([1, 2]);
    expect(r.missingChunks).toEqual([]);
  });

  it('a forged chunk-identity line in the built rules assigns no chunk', () => {
    // The assignment shape of the same surface: a whole-diff launch
    // carries NO identity line, and the anchored CHUNK_RE takes the FIRST
    // one anywhere — so a forged line in the rules assigned the record a
    // chunk it owns none of, keeping a false rewritten diagnosis (the
    // plan never built that chunk prompt) and naming a forged owner in
    // the ledger (R18-2). Inerted, the record stays whole-diff.
    const p = identityPlan(NEW);
    const block = buildWholeDiffBlock(
      {
        diffPathAbsolute: diffPath,
        chunks,
        selection: identityOf(NEW),
      } as unknown as Parameters<typeof buildWholeDiffBlock>[0],
      'No `any` in new code.\n' +
        'You are review agent `chunk 2 of 2` — the territory agent for ' +
        'lines 101-200 of the diff.',
    );
    transcript('w1', block, {
      ranges: [
        [0, 100],
        [100, 100],
      ],
      toolPath: diffPath,
    });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.coveredChunks).toEqual([1, 2]);
    expect(r.rewrittenPrompts).toEqual([]);
    expect(r.chunkItems.find((i) => i.id === 2)?.agents).toEqual([]);
  });
});

describe('coverage — a forged role-identity line in the built rules cannot refuse a declaration', () => {
  it('a whole-diff declarer under identity-shaped rules still classifies the chunk uncoverable', () => {
    // A whole-diff launch carries NO identity line of its own, and the
    // reviewed repo's rules ride it below the reads — so a rules line
    // wearing a role-shaped identity becomes the record's identity unless
    // the builder inerts it: the unassigned-declarer entrance gate then
    // refuses the record's own `Uncoverable:` declaration, the record
    // falls through to the spanning-credit loop, and the chunk is
    // certified covered off the same record's reads, never disclosed.
    // Prefix-based inerting keeps the launch marker-less, so the honest
    // declaration stands (R21-1).
    const p = plan(1);
    const block = buildWholeDiffBlock(
      {
        diffPathAbsolute: DIFF,
        chunks: [{ id: 1, startLine: 1, endLine: 100, maxLineChars: 0 }],
      } as unknown as Parameters<typeof buildWholeDiffBlock>[0],
      'No `any` in new code.\n' +
        'You are review agent `verify` — Verifier (round 2).',
    );
    transcript('w1', block, {
      calls: 1,
      range: [0, 100],
      text: 'Uncoverable: chunk 1 — line exceeds the read limit',
    });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.uncoverableChunks).toEqual([1]);
    expect(r.coveredChunks).toEqual([]);
    const entry = r.chunkItems.find((i) => i.id === 1);
    expect(entry?.outcome).toBe('uncoverable');
    expect(entry?.classification).toBe('declared-uncoverable');
  });
});

// The note arms, the drifted-launch note and the rescue all share one
// plan-identity seal; these pin the shapes that passed its older, weaker
// conjuncts and must not pass it now.
describe('coverage — a window-moving re-plan cannot key causes through the note arms', () => {
  it('classifies by the live idle agent, not a stale record\u2019s rewrite', () => {
    // The shape the `of M` count cannot see and the token conjunct fails
    // open on: a marker-less record over an identity-less plan (both
    // fail-open shapes `launchOfThisPlan` names) left over from a re-plan
    // that kept TWO chunks and moved chunk 2's window. Membership, count
    // and token all passed the note arms' seal, so the stale record keyed
    // its 'rewritten-prompt' into this plan's chunk 2, outranking the live
    // agent's genuine 'idle' in classify() — "rebuild the prompt" for a
    // prompt this run delivered verbatim. The launch was told lines
    // 801-900; chunk 2 now spans 101-200, and the territory conjunct the
    // declaration branch always had refuses the keying.
    transcript('a1', good(1), { calls: 2 });
    transcript('a2', good(2), { calls: 0 });
    transcript(
      'stale',
      `You are review agent \`chunk 2 of 2\` — the territory agent for lines 801-900 of the diff.\n` +
        `read_file(file_path="${DIFF}", offset=800, limit=100)`,
      { calls: 1, range: [800, 100] },
    );

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.missingChunks).toEqual([2]);
    // The prose array still names the record — that describes the RECORD.
    expect(r.rewrittenPrompts.join(' ')).toContain('chunk 2');
    const entry = r.chunkItems.find((i) => i.id === 2);
    expect(entry?.outcome).toBe('missing');
    expect(entry?.classification).toBe('idle');
  });
});

describe('coverage — the drifted-launch note carries the whole seal', () => {
  it('refuses a count-changed stale record the token-only arm vouched for', () => {
    // The arm's comment claimed it was "sealed like the note arms", but it
    // gated on the token conjunct alone. A marker-less record rides that
    // conjunct through (fail open), and the record's `of M` count was
    // never checked at all — so an old plan's record that opened this
    // plan's brief and read the diff earned the NOTE's "the delivery
    // stands" for a chunk this plan never delivered, beside
    // `missingChunks` demanding a relaunch of the very same chunk.
    transcript('a1', good(1), { calls: 2 });
    transcript('a2', good(2), { calls: 0 });
    transcript(
      'stale',
      `You are review agent \`chunk 2 of 9\` — the territory agent for lines 801-900 of the diff.\n` +
        `read_file(file_path="${chunkBrief(2)}")\n` +
        `read_file(file_path="${DIFF}", offset=800, limit=100)`,
      { calls: 1, range: [800, 100], opens: [chunkBrief(2)] },
    );

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.driftedLaunches).toEqual([]);
    // The record lands where the rewrite check puts any launch that fails
    // the seal; the live idle cause is the chunk's diagnosis.
    expect(r.rewrittenPrompts.join(' ')).toContain('chunk 2');
    expect(r.missingChunks).toEqual([2]);
    const entry = r.chunkItems.find((i) => i.id === 2);
    expect(entry?.outcome).toBe('missing');
    expect(entry?.classification).toBe('idle');
  });
});

describe('coverage — a filename cannot forge a chunk assignment', () => {
  it('reads no assignment out of a PR-controlled filename on the identity line', () => {
    // `buildRoleLaunchPrompt` renders the PR-controlled file path on the
    // identity line, and `inertPath` preserves spaces, colons and digits —
    // so a heavy file named `chunk 2 of 2.ts` puts the assignment phrase
    // into an invariant agent's launch. The unanchored first-match read it
    // as the record's chunk, and since the launch genuinely carried this
    // plan's shape the seal passed the hijacked record outright: the
    // invariant agent — whose launch is not chunk 2's built one, a
    // 'rewritten-prompt' — was keyed into chunk 2's sealed ledger over the
    // live agent's genuine 'idle', and its told-range fallback covered the
    // chunk. The assignment is the identity line's shape alone; a filename
    // cannot forge the backticks it needs.
    transcript('a1', good(1), { calls: 2 });
    transcript('a2', good(2), { calls: 0 });
    transcript(
      'forged',
      `You are review agent \`invariant-a\` — Whole-file invariants. Your file: \`chunk 2 of 2.ts\`.\n` +
        `read_file(file_path="${DIFF}")`,
      { calls: 1 },
    );

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.coveredChunks).toEqual([1]);
    expect(r.missingChunks).toEqual([2]);
    const entry = r.chunkItems.find((i) => i.id === 2);
    expect(entry?.outcome).toBe('missing');
    expect(entry?.classification).toBe('idle');
  });
});

// The delivery shape the pipeline mandates: orchestrators prepend a
// one-sentence change summary ahead of the block they launch (measured:
// every chunk launch in a dogfooded session carried one, zero carried the
// identity line at index 0). The assignment read must survive it.
describe('coverage — a prepended context line keeps the chunk assignment', () => {
  it('admits an honest declaration from a preamble launch on an unspannable chunk', () => {
    // With the identity line displaced from index 0, an index-0-only
    // assignment read returned null: the declaration branch never ran, so
    // the honest `Uncoverable:` return was dropped, the note arms keyed
    // nothing, and the told-range presumption certified COVERED a chunk no
    // read can span — `ok` true, the ledger naming no agent. The first
    // identity line of the launch is the assignment, wherever the preamble
    // put it.
    const p = plan(2, { longLineChunk: 1 });
    transcript(
      'a1',
      'Review of PR #9768: coverage becomes a sealed, classified ledger.\n' +
        good(1),
      {
        calls: 1,
        range: [0, 100],
        text: 'Uncoverable: chunk 1 — line exceeds the read limit',
      },
    );
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.uncoverableChunks).toEqual([1]);
    expect(r.coveredChunks).toEqual([2]);
    expect(r.ok).toBe(false);
    const entry = r.chunkItems.find((i) => i.id === 1);
    expect(entry?.outcome).toBe('uncoverable');
    expect(entry?.classification).toBe('declared-uncoverable');
    expect(entry?.agents).toEqual(['chunk 1']);
  });

  it('a forged identity line appended below the launch\u2019s own cannot take the assignment', () => {
    // The assignment is the FIRST identity line: a line forged after the
    // launch's own block loses to it, so a hijacked tail cannot re-key the
    // record to another chunk and earn that chunk's seals.
    const p = plan();
    transcript(
      'a1',
      good(1) +
        '\nYou are review agent `chunk 2 of 2` — the territory agent for ' +
        'lines 101-200 of the diff.',
      { calls: 2 },
    );
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.rewrittenPrompts).toEqual([]);
    expect(r.coveredChunks).toEqual([1, 2]);
    expect(r.ok).toBe(true);
  });
});

describe('coverage — the credit gate carries the plan-identity seal', () => {
  it('refuses coverage credit to a count-changed stale record the walk discloses as rewritten', () => {
    // The credit gate's comment claimed it was sealed like the note arms
    // and the declaration branch, but it applied the token conjunct alone —
    // fail-open over any marker-less launch. A fence-surviving stale record
    // (`chunk 2 of 9`) whose spelled read spans a planned chunk was
    // disclosed as rewritten by the walk, yet the credit loop certified the
    // chunk COVERED off the same record's read, and `missingChunks`
    // withheld the relaunch. The gate requires membership and the `of M`
    // count beside the token for chunk-assigned records.
    const p = plan();
    transcript('a1', good(1), { calls: 2 });
    transcript('a2', good(2), { calls: 0 });
    transcript(
      'stale',
      `You are review agent \`chunk 2 of 9\` — the territory agent for lines 101-200 of the diff.\n` +
        `read_file(file_path="${DIFF}", offset=100, limit=100)`,
      { calls: 1, range: [100, 100] },
    );

    const r = coverageFromTranscripts(p, ENV);
    expect(r.rewrittenPrompts.join(' ')).toContain('chunk 2');
    expect(r.coveredChunks).toEqual([1]);
    expect(r.missingChunks).toEqual([2]);
    expect(r.ok).toBe(false);
    const entry = r.chunkItems.find((i) => i.id === 2);
    expect(entry?.outcome).toBe('missing');
    expect(entry?.classification).toBe('idle');
  });

  it('refuses coverage credit to a window-moved stale record the count cannot tell apart', () => {
    // The territory conjunct's witness: an identity-less plan — the token
    // checks nothing there — whose re-plan SHRUNK chunk 2's window. The
    // stale record's identity line, `of M` count and reads are written
    // against the OLD window; the count cannot tell the plans apart, and
    // the merged told-and-read ranges no longer re-prove the current one.
    // Without the conjunct the gate certified the chunk covered off the
    // old plan's read while `missingChunks` withheld the relaunch (R22-1).
    const p = join(dir, 'plan.json');
    writeFileSync(
      p,
      JSON.stringify({
        diffPathAbsolute: DIFF,
        srcDiffLines: 5000,
        diffLines: 5000,
        files: [
          { path: 'a.ts', kind: 'source', removedLines: 0, heavy: false },
        ],
        chunks: [
          { id: 1, startLine: 1, endLine: 100, maxLineChars: 0 },
          { id: 2, startLine: 101, endLine: 185, maxLineChars: 0 },
        ],
      }),
    );
    const currentTwo =
      `You are review agent \`chunk 2 of 2\` — the territory agent for ` +
      `lines 101-185 of the diff.\n` +
      `read_file(file_path="${chunkBrief(2)}")\n` +
      `read_file(file_path="${DIFF}", offset=100, limit=85)`;
    built(p, 1);
    built(p, 2, currentTwo);
    satisfyRoster(p);
    const old = new Date(2020, 0, 1);
    utimesSync(p, old, old);
    transcript('a1', good(1), { calls: 2 });
    transcript(
      'stale',
      `You are review agent \`chunk 2 of 2\` — the territory agent for lines 101-200 of the diff.\n` +
        `read_file(file_path="${DIFF}", offset=100, limit=100)`,
      { calls: 1, range: [100, 100] },
    );

    const r = coverageFromTranscripts(p, ENV);
    expect(r.rewrittenPrompts.join(' ')).toContain('chunk 2');
    expect(r.coveredChunks).toEqual([1]);
    expect(r.missingChunks).toEqual([2]);
    expect(r.ok).toBe(false);
    const entry = r.chunkItems.find((i) => i.id === 2);
    expect(entry?.outcome).toBe('missing');
  });
});

// The per-chunk ledger: the same walk's conclusions, keyed by CHUNK instead of
// by agent.
//
// Before it, "why was chunk 7 not reviewed" had no machine answer. The reason
// lived in one of six agent-keyed prose arrays, and an id in `missingChunks`
// carried no pointer into them — an operator matched them up by reading stderr.
describe('the chunk ledger', () => {
  /** The ledger entry for one chunk, so a test names what it is asserting on. */
  const entryFor = (
    r: ReturnType<typeof coverageFromTranscripts>,
    id: number,
  ) => r.chunkItems.find((i) => i.id === id)!;

  it('partitions the plan: one entry per chunk, no more and no fewer', () => {
    transcript('a1', good(1), { calls: 2 });
    transcript('a2', good(2), { calls: 2 });

    const r = coverageFromTranscripts(plan(), ENV);
    expect(r.chunkItems.map((i) => i.id)).toEqual([1, 2]);
    expect(r.chunkItems.every((i) => i.outcome === 'covered')).toBe(true);
    // Covered scope carries no failure class: the field is the ledger saying
    // WHY it could not certify, and there is nothing to say about a chunk it
    // certified.
    expect(r.chunkItems.every((i) => i.classification === undefined)).toBe(
      true,
    );
  });

  it('names an idle agent as the reason its chunk went unread', () => {
    transcript('a1', good(1), { calls: 2 });
    transcript('a2', good(2), { calls: 0 });

    const r = coverageFromTranscripts(plan(), ENV);
    expect(entryFor(r, 2)).toMatchObject({
      outcome: 'missing',
      classification: 'idle',
    });
    // The agent-keyed array still says the same thing. The ledger adds the
    // chunk key, it does not replace the prose.
    expect(r.idleAgents).toEqual(['chunk 2']);
  });

  it('names a blind prompt, which is a different repair from an idle agent', () => {
    // Relaunching an idle agent can work; relaunching a blind one produces a
    // second agent that also cannot read the diff. One classification each, so
    // a caller can tell the two repairs apart without parsing prose.
    transcript('a1', good(1), { calls: 2 });
    transcript('a2', blind(2), { calls: 0 });

    const r = coverageFromTranscripts(plan(), ENV);
    expect(entryFor(r, 2)).toMatchObject({
      outcome: 'missing',
      classification: 'blind-prompt',
    });
  });

  it('does not classify a chunk by a blind cause its superseding relaunch repaired', () => {
    // Chunk 2's first agent was launched blind; the operator followed
    // check-coverage's own FIX — rebuilt the prompt, relaunched verbatim.
    // The relaunch read the diff but mis-paged its lines, so it passes
    // every guard, records no cause, and `chunkSatisfied` suppresses
    // `blindAgents` — yet the stale cause survived in the ledger, and
    // `classify()` diagnosed the chunk with a problem the relaunch already
    // repaired. The `'unknown'` class whose doc describes exactly this
    // residue was unreachable while the superseded cause kept the set
    // non-empty.
    const p = plan();
    const mispaged =
      `You are review agent \`chunk 2 of 2\` — the territory agent.\n` +
      `read_file(file_path="${chunkBrief(2)}")\n` +
      `read_file(file_path="${DIFF}", offset=0, limit=50)`;
    built(p, 2, mispaged);
    transcript('a1', good(1), { calls: 2 });
    transcript('a2blind', blind(2), { calls: 0 });
    transcript('a2fix', mispaged, { calls: 1, range: [0, 50] });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.blindAgents).toEqual([]);
    expect(entryFor(r, 2)).toMatchObject({
      outcome: 'missing',
      classification: 'unknown',
    });
  });

  it('does not classify a chunk idle when its superseding relaunch worked', () => {
    // The same supersession shape on the idle arm: the first attempt never
    // made a tool call; the verbatim relaunch worked but mis-paged, so the
    // chunk is still missing — and the ledger must name the residue
    // ('unknown'), not the cause the relaunch repaired.
    const p = plan();
    const mispaged =
      `You are review agent \`chunk 2 of 2\` — the territory agent.\n` +
      `read_file(file_path="${chunkBrief(2)}")\n` +
      `read_file(file_path="${DIFF}", offset=0, limit=50)`;
    built(p, 2, mispaged);
    transcript('a1', good(1), { calls: 2 });
    transcript('a2idle', good(2), { calls: 0 });
    transcript('a2fix', mispaged, { calls: 1, range: [0, 50] });

    const r = coverageFromTranscripts(p, ENV);
    expect(r.idleAgents).toEqual([]);
    expect(entryFor(r, 2)).toMatchObject({
      outcome: 'missing',
      classification: 'unknown',
    });
  });

  it('names an agent that worked but never opened the diff it was pointed at', () => {
    // Two successful tool calls, none of them on the diff: it did work, just
    // not this work. The repair is a relaunch — the prompt already names the
    // diff and its ranges — a different class from a rewritten prompt, whose
    // repair is a rebuild.
    transcript('a1', good(1), { calls: 2 });
    transcript('a2', good(2), { calls: 2, toolPath: '/abs/other-file.ts' });

    const r = coverageFromTranscripts(plan(), ENV);
    expect(entryFor(r, 2)).toMatchObject({
      outcome: 'missing',
      classification: 'unopened',
    });
    expect(r.unopenedAgents).toEqual(['chunk 2']);
  });

  it('names a rewritten launch — a prompt rebuild, not a relaunch', () => {
    // The CLI built good(2); the orchestrator delivered a prompt that
    // ALTERED one of its lines (adding lines is delivery, not rewrite —
    // `wasDeliveredVerbatim` permits it). The record worked but never read
    // the diff, so the cause is the rewrite. The paraphrase keeps the
    // identity line and the spelled reads — a rewrite that altered the
    // READS spells a window that is not this chunk's, and the territory
    // seal refuses to key causes through a launch it cannot order against
    // this plan. What pins the classification is `classify()` ordering
    // rewritten-prompt above unopened: the ternary inside the unopened
    // branch re-notes the same cause, so a mutant replacing it with plain
    // `'unopened'` flips this test. The unconditional note ahead of the
    // branch is pinned by the next test, whose rewrite opened the diff and
    // skips the branch.
    transcript('a1', good(1), { calls: 2 });
    transcript(
      'a2',
      good(2).replace('the territory agent', 'the chunk agent'),
      { calls: 2, toolPath: '/abs/other-file.ts' },
    );

    const r = coverageFromTranscripts(plan(), ENV);
    expect(entryFor(r, 2)).toMatchObject({
      outcome: 'missing',
      classification: 'rewritten-prompt',
    });
  });

  it('classifies a zero-call record on a rewritten launch as rewritten-prompt, not idle', () => {
    // The idle guard `continue`s before the rewritten-prompt arm, so a record
    // launched on a prompt the CLI did not build that then made no tool call
    // was classified `idle` — repair: relaunch the same prompt — when the
    // repair that works is a rebuild. Both causes are recorded and
    // `classify()` ranks the rebuild above the relaunch (R23-1). The prose
    // channel still names it idle: the ledger adds a key, it does not move a
    // record out of the array that names what it did.
    transcript('a1', good(1), { calls: 2 });
    transcript(
      'a2',
      good(2).replace('the territory agent', 'the chunk agent'),
      { calls: 0 },
    );

    const r = coverageFromTranscripts(plan(), ENV);
    expect(entryFor(r, 2)).toMatchObject({
      outcome: 'missing',
      classification: 'rewritten-prompt',
    });
    expect(r.idleAgents).toEqual(['chunk 2']);
    // The verbatim-launched idler keeps `idle` — `names an idle agent as the
    // reason its chunk went unread`, above, is the control.
  });

  it('names owners, not spanning readers: a whole-diff-only run covers with empty agents', () => {
    // The ledger's `agents` contract, settled on #9768 (R8-4 / R19-2): the
    // field names who was SENT for the chunk — its assigned owners and an
    // admitted paraphrased declarer — not every reader whose range spanned
    // it. A whole-diff agent spans every chunk by construction; naming it on
    // each entry would put the same label everywhere and distinguish
    // nothing. So coverage earned by a whole-diff read alone is recorded by
    // the `covered` outcome, beside `agents: []`.
    transcript('w1', wholeDiff(), {
      ranges: [
        [0, 100],
        [100, 100],
      ],
    });

    const r = coverageFromTranscripts(plan(2, { record: false }), ENV);
    expect(r.coveredChunks).toEqual([1, 2]);
    expect(entryFor(r, 1)).toMatchObject({ outcome: 'covered', agents: [] });
    expect(entryFor(r, 2)).toMatchObject({ outcome: 'covered', agents: [] });
    // Mixed run: the owner that failed is named on its chunk, the whole-diff
    // reader that covered it is not — the entry says who was sent, and the
    // outcome says the lines were read anyway.
    transcript('a2', good(2), { calls: 0 });
    const m = coverageFromTranscripts(plan(), ENV);
    expect(entryFor(m, 2)).toMatchObject({
      outcome: 'covered',
      agents: ['chunk 2'],
    });
    expect(entryFor(m, 1)).toMatchObject({ outcome: 'covered', agents: [] });
  });

  it('pins the unconditional rewritten-prompt note on a refused declarer', () => {
    // The fixture above never opens the diff, so it enters the unopened
    // branch, whose ternary re-notes the same cause — deleting the
    // unconditional note ahead of the branch keeps it green. This launch
    // opened the diff, so it skips that branch; it also returned an
    // `Uncoverable:` declaration the plan's own measurement contradicts,
    // which the declaration branch refuses and then `continue`s — no
    // coverage credit, the chunk stays missing. The unconditional note is
    // the only record of the cause: a rewrite that altered the READS
    // would fail the territory seal and note nothing, and the plan's
    // contradiction refuses the declaration's own cause. Deleting the
    // note hands the operator `'unknown'` — a cause with no repair —
    // instead of "rebuild the prompt".
    transcript('a1', good(1), { calls: 2 });
    transcript(
      'a2',
      good(2).replace('the territory agent', 'the chunk agent'),
      {
        calls: 1,
        range: [100, 100],
        opens: [],
        text: 'Uncoverable: chunk 2 — line exceeds the read limit',
      },
    );

    const r = coverageFromTranscripts(plan(2, { maxLineChars: 42 }), ENV);
    expect(entryFor(r, 2)).toMatchObject({
      outcome: 'missing',
      classification: 'rewritten-prompt',
    });
  });

  it('orders two causes on one chunk by which repair subsumes which', () => {
    // Chunk 2 had two failing records: the first never started (idle), the
    // replacement worked but not on the diff (unopened). `classify()` walks
    // its precedence list — a relaunch fixes both, and `idle` is the class
    // the plain relaunch is ordered around — so idle outranks unopened. A
    // mutant reordering the list flips this and hands the operator the
    // wrong cause.
    transcript('a1', good(1), { calls: 2 });
    transcript('a2', good(2), { calls: 0 });
    transcript('a3', good(2), { calls: 2, toolPath: '/abs/other-file.ts' });

    const r = coverageFromTranscripts(plan(), ENV);
    expect(entryFor(r, 2)).toMatchObject({
      outcome: 'missing',
      classification: 'idle',
    });
  });

  it('marks a chunk nobody was assigned to as no-agent, not unknown', () => {
    // The failure with no transcript to interrogate. Every other class is a
    // question asked of an agent that ran; this one is the absence of one, and
    // reporting it as `unknown` would hide that nothing was ever launched.
    transcript('a1', good(1), { calls: 2 });

    const r = coverageFromTranscripts(plan(), ENV);
    expect(entryFor(r, 2)).toMatchObject({
      outcome: 'missing',
      classification: 'no-agent',
    });
    expect(entryFor(r, 2).agents).toEqual([]);
  });

  it('carries an uncoverable chunk as its own outcome, with the declaration as the cause', () => {
    // The HONEST shape: the plan's own measurement says chunk 2's longest
    // line exceeds the read cap, so the declaration is true on this plan
    // and admitted. A plan whose measurement CONTRADICTS the declaration
    // lands `missing` — see the next test.
    transcript('a1', good(1), { calls: 2 });
    transcript('a2', good(2), {
      calls: 1,
      text: 'Uncoverable: chunk 2 — line exceeds the read limit',
    });

    const r = coverageFromTranscripts(plan(2, { longLineChunk: 2 }), ENV);
    expect(entryFor(r, 2)).toMatchObject({
      outcome: 'uncoverable',
      classification: 'declared-uncoverable',
    });
    // Not `missing`: an agent read it and said why no read can span it. The
    // two are different facts and different repairs — one relaunches, the
    // other cannot be repaired at all.
    expect(entryFor(r, 1).outcome).toBe('covered');
  });

  it('refuses a declaration the plan’s own measurement contradicts', () => {
    // `maxLineChars` is the planner's walk of these same lines, and the
    // builder hands the declaration template only to chunks whose longest
    // line exceeds the read cap. Metadata saying every line fits proves the
    // declaration false on THIS plan — admitted anyway, it pinned
    // `declared-uncoverable` over a chunk the plan's own input shows is
    // spannable, and `uncoverable.add` erased the coverage the walk
    // credited. Refused, the chunk is the relaunchable gap the measurement
    // shows it is.
    transcript('a1', good(1), { calls: 2 });
    transcript('a2', good(2), {
      calls: 1,
      range: [100, 100],
      text: 'Uncoverable: chunk 2 — line exceeds the read limit',
    });

    const r = coverageFromTranscripts(plan(2, { maxLineChars: 42 }), ENV);
    expect(r.uncoverableChunks).toEqual([]);
    expect(entryFor(r, 2)).toMatchObject({
      outcome: 'missing',
      classification: 'unknown',
    });
    expect(entryFor(r, 1).outcome).toBe('covered');
  });

  it('ranks a declaration above a rewritten launch on the same chunk', () => {
    // The two causes genuinely co-occur: a rewritten record that made one
    // ranged diff read and then declared the chunk uncoverable notes both.
    // The record never opened its brief, so the near-verbatim delivery
    // branch cannot claim it — it stays rewritten — and a ranged read keeps
    // it out of the unopened branch, so it lives to declare. `classify()`
    // orders the declaration first — the agent's own verdict outranks the
    // prompt defect, because nothing is repaired by relaunching a chunk no
    // read can span. A mutant reordering the pair hands the operator
    // "rebuild the prompt" for a chunk proven unreviewable, and only this
    // fixture goes red.
    //
    // The rewrite is in the PROSE, not the offsets. Mis-paging the read was
    // the older way to make this record rewritten, and it no longer produces
    // the pair: a declarer whose told-range does not span the chunk it names
    // is now dropped as off-territory, so the fixture would have tested the
    // territory guard instead of the precedence it exists for. Keeping the
    // read on the chunk's own window isolates the one question this test asks.
    transcript('a1', good(1), { calls: 2 });
    transcript(
      'a2',
      good(2).replace('the territory agent', 'the chunk agent'),
      {
        calls: 1,
        range: [100, 100],
        opens: [],
        text: 'Uncoverable: chunk 2 — line exceeds the read limit',
      },
    );

    const r = coverageFromTranscripts(plan(), ENV);
    expect(entryFor(r, 2)).toMatchObject({
      outcome: 'uncoverable',
      classification: 'declared-uncoverable',
    });
  });

  it('names the agent that owned a chunk, on success as well as failure', () => {
    transcript('a1', good(1), { calls: 2 });
    transcript('a2', good(2), { calls: 0 });

    const r = coverageFromTranscripts(plan(), ENV);
    expect(entryFor(r, 1).agents).toEqual(['chunk 1']);
    expect(entryFor(r, 2).agents).toEqual(['chunk 2']);
  });

  it('agrees with the three id arrays it is built beside', () => {
    // The assertion inside `coverageFromTranscripts` enforces this on every
    // call; this pins the agreement as a stated expectation rather than an
    // internal one, so a change that removed the assertion still has to keep
    // the property.
    transcript('a1', good(1), { calls: 2 });
    transcript('a2', good(2), { calls: 0 });

    const r = coverageFromTranscripts(plan(3), ENV);
    const byOutcome = (...want: string[]) =>
      r.chunkItems
        .filter((i) => want.includes(i.outcome))
        .map((i) => i.id)
        .sort((a, b) => a - b);
    expect(byOutcome('covered', 'recovered')).toEqual(
      [...r.coveredChunks].sort((a, b) => a - b),
    );
    expect(byOutcome('missing')).toEqual(
      [...r.missingChunks].sort((a, b) => a - b),
    );
    expect(byOutcome('uncoverable')).toEqual(
      [...r.uncoverableChunks].sort((a, b) => a - b),
    );
  });

  it('reports no selection drift for a plan that carries no identity', () => {
    // Every fixture here writes a plan without one — they stand in for plans
    // written before the field existed, and those must not narrate a defect.
    transcript('a1', good(1), { calls: 2 });
    transcript('a2', good(2), { calls: 2 });

    expect(coverageFromTranscripts(plan(), ENV).selectionDrift).toBeNull();
  });
});

describe('coverage — a drifted selection identity, end to end', () => {
  // The plan carries a `selection` identity (as every capture command writes
  // since lib/selection.ts) bound to a REAL diff file, and the file is
  // rewritten after the agents ran. The non-null half of the drift check:
  // coverage still computes — nothing caps on drift yet — but the report
  // must carry the reason, and the handler must print it.
  const diffText = 'diff --git a/a.ts b/a.ts\n@@ -1,1 +1,1 @@\n+x\n';

  /** A compliant fully-covered run over a plan with a real identity. */
  function identityRun(): { p: string; diffPath: string } {
    const diffPath = join(dir, 'the.diff');
    writeFileSync(diffPath, diffText);
    const chunks = [
      { id: 1, startLine: 1, endLine: 100 },
      { id: 2, startLine: 101, endLine: 200 },
    ];
    const selection = buildSelectionIdentity(
      diffText,
      chunks as unknown as DiffChunk[],
      200,
    );
    const p = join(dir, 'plan.json');
    writeFileSync(
      p,
      JSON.stringify({
        diffPathAbsolute: diffPath,
        srcDiffLines: 5000,
        diffLines: 200,
        files: [
          { path: 'a.ts', kind: 'source', removedLines: 0, heavy: false },
        ],
        chunks,
        selection,
      }),
    );
    // The chunk prompts name the fixture's own diff path — `good()` names the
    // module constant, a different (nonexistent) file — and carry the plan's
    // token line exactly as `buildChunkLaunchPrompt` writes it: over an
    // identity-carrying plan a marker-less launch earns nothing, so a
    // COMPLIANT fixture must look like one.
    const goodHere = (c: number) =>
      `You are review agent \`chunk ${c} of 2\` — the territory agent for ` +
      `lines ${(c - 1) * 100 + 1}-${c * 100} of the diff.\n` +
      `Plan identity: ${planIdentityToken(selection)}\n` +
      `read_file(file_path="${chunkBrief(c)}")\n` +
      `read_file(file_path="${diffPath}", offset=${(c - 1) * 100}, limit=100)`;
    for (const c of [1, 2]) built(p, c, goodHere(c));
    satisfyRoster(p);
    utimesSync(p, new Date(2020, 0, 1), new Date(2020, 0, 1));
    transcript('a1', goodHere(1), {
      calls: 1,
      range: [0, 100],
      toolPath: diffPath,
    });
    transcript('a2', goodHere(2), {
      calls: 1,
      range: [100, 100],
      toolPath: diffPath,
    });
    return { p, diffPath };
  }

  it('reports the drift on the report without moving anything else', () => {
    const { p, diffPath } = identityRun();
    writeFileSync(diffPath, `${diffText}+rewritten after planning\n`);

    const r = coverageFromTranscripts(p, ENV);
    expect(r.selectionDrift).toMatch(/diff file has changed/);
    // Report-only: the same run still certifies what its transcripts prove.
    expect(r.coveredChunks).toEqual([1, 2]);
    expect(r.ok).toBe(true);
  });

  it('reports no drift when the identity-carrying diff is unchanged', () => {
    // The unchanged-diff control: every sibling exercises the drift-present
    // or the identity-absent state, so a mutant digesting the wrong text
    // fires on rewritten diffs as expected AND on unchanged ones — and only
    // this control goes red.
    const { p } = identityRun();

    expect(coverageFromTranscripts(p, ENV).selectionDrift).toBeNull();
  });

  it('reports an unreadable diff file instead of certifying over it', () => {
    // Deletion is the one mutation the identity exists to catch. Collapsing
    // the read failure into `null` — "everything matched" — certified over a
    // file that may have been rewritten or deleted since the agents ran.
    const { p, diffPath } = identityRun();
    rmSync(diffPath);

    expect(coverageFromTranscripts(p, ENV).selectionDrift).toMatch(
      /could not be read/,
    );
  });

  it('prints the drift NOTE scoped to the whole report, exit unchanged', () => {
    const { p, diffPath } = identityRun();
    writeFileSync(diffPath, `${diffText}+rewritten after planning\n`);

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

      const note = vi
        .mocked(writeStderrLine)
        .mock.calls.map((c) => String(c[0]))
        .find(
          (l) => l.includes('NOTE:') && l.includes('diff file has changed'),
        );
      expect(note).toBeDefined();
      // The caveat names the WHOLE report — the summary fraction above the
      // NOTE is the very number the drift invalidates, so scoping it to "the
      // coverage below" left the headline certifying moved chunk ranges.
      expect(note).toContain('including the summary above');
      expect(process.exitCode).toBe(prevExit);
    } finally {
      process.exitCode = prevExit;
      if (prevDir === undefined) delete process.env['QWEN_CODE_PROJECT_DIR'];
      else process.env['QWEN_CODE_PROJECT_DIR'] = prevDir;
      if (prevSession === undefined) delete process.env['QWEN_CODE_SESSION_ID'];
      else process.env['QWEN_CODE_SESSION_ID'] = prevSession;
    }
  });
});

describe('assertChunkPartition', () => {
  const item = (
    id: number,
    outcome: ChunkCoverageItem['outcome'],
    classification?: ChunkCoverageItem['classification'],
  ): ChunkCoverageItem => ({
    id,
    files: [],
    outcome,
    agents: [],
    ...(classification ? { classification } : {}),
  });
  const reported = (
    covered: number[] = [],
    missing: number[] = [],
    uncoverable: number[] = [],
  ) => ({ covered, missing, uncoverable });

  it('accepts a ledger that covers the plan exactly once', () => {
    expect(() =>
      assertChunkPartition(
        [1, 2],
        [item(1, 'covered'), item(2, 'missing', 'idle')],
        reported([1], [2]),
      ),
    ).not.toThrow();
  });

  it('refuses a planned chunk the ledger never mentions', () => {
    expect(() =>
      assertChunkPartition([1, 2], [item(1, 'covered')], reported([1])),
    ).toThrow(/chunk 2 is in the plan but not the ledger/);
  });

  it('refuses a ledger entry for a chunk nobody planned', () => {
    expect(() =>
      assertChunkPartition(
        [1],
        [item(1, 'covered'), item(9, 'covered')],
        reported([1, 9]),
      ),
    ).toThrow(/chunk 9 is in the ledger but not the plan/);
  });

  it('refuses the same chunk twice', () => {
    expect(() =>
      assertChunkPartition(
        [1],
        [item(1, 'covered'), item(1, 'missing', 'idle')],
        reported([1], [1]),
      ),
    ).toThrow(/chunk 1 appears twice/);
  });

  it('refuses a gap that declines to say why', () => {
    // The classification is the whole point of the entry: a `missing` with no
    // cause is the ledger reporting a gap and withholding the one field that
    // makes it actionable.
    expect(() =>
      assertChunkPartition([1], [item(1, 'missing')], reported([], [1])),
    ).toThrow(/is missing with no classification/);
  });

  it('refuses a covered chunk carrying a failure class', () => {
    expect(() =>
      assertChunkPartition([1], [item(1, 'covered', 'idle')], reported([1])),
    ).toThrow(/but carries a failure class/);
  });

  it('refuses a ledger that disagrees with the arrays the report exports', () => {
    // The comparison that gives the assertion its teeth. Without it the check
    // would only prove the ledger self-consistent — and the ledger is built
    // from the same sets it would be checking, which is the exact
    // can't-disagree-with-itself defect this change removed from
    // `check-coverage`'s denominator.
    expect(() =>
      assertChunkPartition(
        [1, 2],
        [item(1, 'covered'), item(2, 'missing', 'idle')],
        // The arrays say chunk 2 was covered; the ledger says nobody read it.
        reported([1, 2], []),
      ),
    ).toThrow(/covered disagrees with the ledger/);
  });

  it('counts a recovered chunk as covered scope, not as a fourth set', () => {
    // The live/prior split is provenance this report adds. It must not change
    // what counts as reviewed, or a resumed run would read as a gap.
    expect(() =>
      assertChunkPartition(
        [1, 2],
        [item(1, 'covered'), item(2, 'recovered')],
        reported([1, 2]),
      ),
    ).not.toThrow();
  });
});
