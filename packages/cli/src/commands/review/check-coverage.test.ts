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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  coverageFromTranscripts,
  TranscriptsUnavailableError,
} from './lib/coverage.js';
import { promptRecordDir } from './lib/prompt-record.js';

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
function plan(n = 2, opts: { record?: boolean } = {}): string {
  const p = join(dir, 'plan.json');
  writeFileSync(
    p,
    JSON.stringify({
      diffPathAbsolute: DIFF,
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
  const old = new Date(2020, 0, 1);
  utimesSync(p, old, old);
  return p;
}

/** Write a transcript the way the harness writes one. */
function transcript(
  id: string,
  launchPrompt: string,
  opts: { calls?: number; failed?: boolean; text?: string } = {},
): void {
  const base = { agentId: id, agentName: 'general-purpose', sessionId: 'S1' };
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
  `read_file(file_path="${DIFF}", offset=${(c - 1) * 100}, limit=100)`;

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

    const r = coverageFromTranscripts(plan(), ENV);
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

    const r = coverageFromTranscripts(plan(), ENV);
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
    expect(r.rewrittenPrompts[0]).toContain('`agent-prompt` never ran');
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
