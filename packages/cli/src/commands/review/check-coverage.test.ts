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

let dir: string;
let ENV: NodeJS.ProcessEnv;

const DIFF = '/abs/qwen-review-pr-1-diff.txt';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cov-'));
  ENV = { QWEN_CODE_PROJECT_DIR: dir, QWEN_CODE_SESSION_ID: 'S1' };
  mkdirSync(join(dir, 'subagents', 'S1'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A plan with `n` chunks, backdated so every transcript counts as newer. */
function plan(n = 2): string {
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

/** What `agent-prompt` builds: the diff and the read are in it. */
const good = (c: number) =>
  `You are reviewing chunk ${c} of 2.\nread_file(file_path="${DIFF}", offset=0, limit=100)`;

/** What the orchestrator actually sent, 23 times: no diff anywhere in it. */
const blind = (c: number) =>
  `The changes are in chunk ${c} of 2, covering lines 1-100 of the diff.`;

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
          parts: [{ functionCall: { name: 'read_file', args: {} } }],
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

  it('refuses a plan that is not one', () => {
    const p = join(dir, 'bad.json');
    writeFileSync(p, JSON.stringify({}));
    expect(() => coverageFromTranscripts(p, ENV)).toThrow(/diffPathAbsolute/);
  });
});
