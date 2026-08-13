/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The defensive branches of the transcript reader, in isolation. They exist
// because the files come off disk while agents may still be writing them — a
// partial last line, an empty file materialised before the first record, a file
// that is not a transcript at all — and the reader must degrade to "this is not
// evidence" rather than throw and take the whole coverage check down.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readTranscripts,
  readRunTranscripts,
  transcriptDirsForRun,
  wasGivenTheDiff,
  transcriptDir,
  TranscriptsUnavailableError,
  type AgentRecord,
} from './transcripts.js';

let dir: string;
let ENV: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'transcripts-'));
  ENV = { QWEN_CODE_PROJECT_DIR: dir, QWEN_CODE_SESSION_ID: 'S1' };
  mkdirSync(join(dir, 'subagents', 'S1'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function file(name: string, contents: string): void {
  writeFileSync(join(dir, 'subagents', 'S1', name), contents);
}

describe('transcriptDir — resolved from the environment only', () => {
  it('throws when the CLI exported neither key', () => {
    expect(() => transcriptDir({})).toThrow(TranscriptsUnavailableError);
  });

  it('throws when only one key is present', () => {
    expect(() => transcriptDir({ QWEN_CODE_SESSION_ID: 'S1' })).toThrow(
      TranscriptsUnavailableError,
    );
    expect(() => transcriptDir({ QWEN_CODE_PROJECT_DIR: '/p' })).toThrow(
      TranscriptsUnavailableError,
    );
  });
});

describe('readTranscripts — defensive parsing', () => {
  it('throws TranscriptsUnavailableError when the session dir is absent', () => {
    // Not a verdict about the agents — an infrastructure fact.
    expect(() =>
      readTranscripts(undefined, {
        QWEN_CODE_PROJECT_DIR: join(dir, 'gone'),
        QWEN_CODE_SESSION_ID: 'S1',
      }),
    ).toThrow(TranscriptsUnavailableError);
  });

  it('skips a non-.jsonl file', () => {
    file('notes.txt', 'not a transcript');
    expect(readTranscripts(undefined, ENV)).toEqual([]);
  });

  it('skips the harness sidecar files beside a transcript', () => {
    // The harness writes sibling files per agent into this dir —
    // agent-transcript.ts writes `agent-<id>.meta.json` via writeAgentMeta,
    // and a meta carries an `agentId` key. Admitted by the filter, it would
    // parse to a phantom zero-tool-call AgentRecord: it is the
    // `.endsWith('.jsonl')` filter, not parseTranscript, that keeps it out.
    file(
      'agent-a1.jsonl',
      JSON.stringify({
        agentId: 'a1',
        agentName: 'general-purpose',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'chunk 1 of 1' }] },
      }) + '\n',
    );
    file(
      'agent-a1.meta.json',
      JSON.stringify({
        agentId: 'a1',
        agentType: 'general-purpose',
        description: 'dimension 1',
        parentSessionId: 'S1',
        parentAgentId: null,
        createdAt: '2026-08-03T10:06:00.000Z',
        status: 'completed',
      }),
    );
    file('agent-a1.jsonl.stream', 'streaming text, not jsonl records');
    const recs = readTranscripts(undefined, ENV);
    expect(recs).toHaveLength(1);
    expect(recs[0].agentId).toBe('a1');
  });

  it('skips an empty transcript file', () => {
    file('agent-empty.jsonl', '');
    expect(readTranscripts(undefined, ENV)).toEqual([]);
  });

  it('skips a transcript whose records carry no agentId', () => {
    // A file of well-formed JSON that is not an agent transcript.
    file('agent-x.jsonl', JSON.stringify({ hello: 'world' }) + '\n');
    expect(readTranscripts(undefined, ENV)).toEqual([]);
  });

  it('tolerates a malformed final line — an agent still writing', () => {
    // The harness flushes per record; a reader can catch a half-written last
    // line. The complete records before it must still parse.
    const good = {
      agentId: 'a1',
      agentName: 'general-purpose',
      sessionId: 'S1',
    };
    file(
      'agent-a1.jsonl',
      JSON.stringify({
        ...good,
        type: 'user',
        message: { role: 'user', parts: [{ text: 'chunk 1 of 1' }] },
      }) +
        '\n' +
        '{"type":"assistant","message":{"parts":[{"text":"partial', // truncated
    );
    const recs = readTranscripts(undefined, ENV);
    expect(recs).toHaveLength(1);
    expect(recs[0].agentId).toBe('a1');
    expect(recs[0].launchPrompt).toBe('chunk 1 of 1');
  });

  it('counts only successful tool calls', () => {
    const b = { agentId: 'a1', agentName: 'general-purpose', sessionId: 'S1' };
    const call = {
      ...b,
      type: 'assistant',
      message: {
        role: 'model',
        parts: [{ functionCall: { name: 'read_file', args: {} } }],
      },
    };
    file(
      'agent-a1.jsonl',
      [
        JSON.stringify({
          ...b,
          type: 'user',
          message: { role: 'user', parts: [{ text: 'chunk 1 of 1' }] },
        }),
        JSON.stringify(call),
        JSON.stringify({
          ...b,
          type: 'tool_result',
          message: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'read_file',
                  response: { error: 'denied' }, // a FAILED call
                },
              },
            ],
          },
        }),
      ].join('\n') + '\n',
    );
    const [rec] = readTranscripts(undefined, ENV);
    expect(rec.successfulToolCalls).toBe(0);
  });

  it('separates read_file calls from other tools that merely name a path', () => {
    // successfulReadFileArgs backs the checks where NAMING a path is not
    // OPENING it: a search over the findings file carries the same
    // stringified path in its args without reading a line of it.
    const b = { agentId: 'a1', agentName: 'general-purpose', sessionId: 'S1' };
    const pairs: object[] = [];
    for (const [name, args] of [
      ['read_file', { file_path: '/r/f.findings.md' }],
      ['search_file_content', { path: '/r/f.findings.md', pattern: 'Crit' }],
    ]) {
      pairs.push(
        {
          ...b,
          type: 'assistant',
          message: {
            role: 'model',
            parts: [{ functionCall: { name, args } }],
          },
        },
        {
          ...b,
          type: 'tool_result',
          message: {
            role: 'user',
            parts: [{ functionResponse: { name, response: { output: 'ok' } } }],
          },
        },
      );
    }
    file(
      'agent-a1.jsonl',
      [
        JSON.stringify({
          ...b,
          type: 'user',
          message: { role: 'user', parts: [{ text: 'chunk 1 of 1' }] },
        }),
        ...pairs.map((r) => JSON.stringify(r)),
      ].join('\n') + '\n',
    );
    const [rec] = readTranscripts(undefined, ENV);
    expect(rec.successfulToolCalls).toBe(2);
    expect(rec.successfulCallArgs).toHaveLength(2);
    expect(rec.successfulReadFileArgs).toHaveLength(1);
    expect(rec.successfulReadFileArgs[0]).toContain('/r/f.findings.md');
    expect(rec.successfulReadFileArgs[0]).not.toContain('search_file_content');
  });
});

describe('wasGivenTheDiff', () => {
  const rec = (launchPrompt: string): AgentRecord => ({
    agentId: 'a',
    agentName: 'general-purpose',
    launchPrompt,
    successfulToolCalls: 0,
    diffToolCalls: 0,
    diffReads: [],
    successfulCallArgs: [],
    successfulReadFileArgs: [],
    finalText: '',
    mtimeMs: 0,
  });

  it('is true only when the prompt names the diff path', () => {
    expect(
      wasGivenTheDiff(rec('read_file(file_path="/d.txt")'), '/d.txt'),
    ).toBe(true);
  });

  it('is false for a prompt that names only source files', () => {
    expect(
      wasGivenTheDiff(rec('read_file(file_path="/src/pay.ts")'), '/d.txt'),
    ).toBe(false);
  });

  it('is false for an empty prompt', () => {
    expect(wasGivenTheDiff(rec(''), '/d.txt')).toBe(false);
  });
});

describe('readRunTranscripts — the run across its sessions', () => {
  // A minimal valid transcript: launch prompt only.
  const transcript = (agentId: string): string =>
    JSON.stringify({
      agentId,
      agentName: 'general-purpose',
      type: 'user',
      message: { role: 'user', parts: [{ text: `launch ${agentId}` }] },
    }) + '\n';

  // The run ledger fetch-pr would have written: sessions S0 (interrupted
  // attempt) then S1 (current). Entries must postdate the plan's epoch.
  function planWithLedger(...sessionIds: string[]): string {
    const plan = join(dir, 'qwen-review-pr-7-fetch.json');
    writeFileSync(plan, JSON.stringify({ diffLines: 1, chunks: [] }));
    const recordDir = join(dir, 'qwen-review-pr-7-fetch-prompts');
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(
      join(recordDir, 'run-sessions.json'),
      JSON.stringify(
        sessionIds.map((id) => ({ sessionId: id, atMs: Date.now() })),
      ),
    );
    return plan;
  }

  function priorFile(session: string, name: string, contents: string): void {
    mkdirSync(join(dir, 'subagents', session), { recursive: true });
    writeFileSync(join(dir, 'subagents', session, name), contents);
  }

  it('unions prior-session transcripts, marked fromPriorSession', () => {
    const plan = planWithLedger('S0', 'S1');
    priorFile('S0', 'agent-a0.jsonl', transcript('a0'));
    file('agent-a1.jsonl', transcript('a1'));
    const recs = readRunTranscripts(plan, undefined, ENV);
    expect(recs.map((r) => [r.agentId, r.fromPriorSession === true])).toEqual([
      ['a1', false],
      ['a0', true],
    ]);
  });

  it('reads only the current session when no ledger exists', () => {
    // The orphan-invisibility guard: without a ledger entry, a prior
    // session's transcripts do not exist to any reader.
    const plan = join(dir, 'qwen-review-pr-7-fetch.json');
    writeFileSync(plan, JSON.stringify({ diffLines: 1, chunks: [] }));
    priorFile('S0', 'agent-a0.jsonl', transcript('a0'));
    file('agent-a1.jsonl', transcript('a1'));
    const recs = readRunTranscripts(plan, undefined, ENV);
    expect(recs.map((r) => r.agentId)).toEqual(['a1']);
  });

  it('skips a prior session whose directory is gone, silently', () => {
    const plan = planWithLedger('S0', 'S1');
    file('agent-a1.jsonl', transcript('a1'));
    const recs = readRunTranscripts(plan, undefined, ENV);
    expect(recs.map((r) => r.agentId)).toEqual(['a1']);
  });

  it('still throws when the CURRENT session dir is absent', () => {
    const plan = planWithLedger('S0', 'S1');
    priorFile('S0', 'agent-a0.jsonl', transcript('a0'));
    expect(() =>
      readRunTranscripts(plan, undefined, {
        QWEN_CODE_PROJECT_DIR: dir,
        QWEN_CODE_SESSION_ID: 'S-gone',
      }),
    ).toThrow(TranscriptsUnavailableError);
  });

  it('applies the since fence to prior-session records too', () => {
    const plan = planWithLedger('S0', 'S1');
    priorFile('S0', 'agent-a0.jsonl', transcript('a0'));
    const past = new Date(Date.now() - 3600_000);
    utimesSync(join(dir, 'subagents', 'S0', 'agent-a0.jsonl'), past, past);
    file('agent-a1.jsonl', transcript('a1'));
    const recs = readRunTranscripts(plan, Date.now() - 60_000, ENV);
    expect(recs.map((r) => r.agentId)).toEqual(['a1']);
  });

  it('lists the current session dir first, priors after, deduplicated', () => {
    const plan = planWithLedger('S0', 'S0', 'S1');
    // A prior session that exists on disk: the accessor skips a ledgered id
    // whose directory is absent or symlinked, so the fixture must be real.
    priorFile('S0', 'agent-a0.jsonl', transcript('a0'));
    expect(transcriptDirsForRun(plan, ENV)).toEqual([
      join(dir, 'subagents', 'S1'),
      join(dir, 'subagents', 'S0'),
    ]);
  });
});

describe('readRunTranscripts — currentDirOptional', () => {
  const transcript = (agentId: string): string =>
    JSON.stringify({
      agentId,
      agentName: 'general-purpose',
      type: 'user',
      message: { role: 'user', parts: [{ text: `launch ${agentId}` }] },
    }) + '\n';

  it('absorbs a missing CURRENT dir when asked — the pre-launch resume read', () => {
    const plan = join(dir, 'qwen-review-pr-7-fetch.json');
    writeFileSync(plan, JSON.stringify({ diffLines: 1, chunks: [] }));
    const recordDir = join(dir, 'qwen-review-pr-7-fetch-prompts');
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(
      join(recordDir, 'run-sessions.json'),
      JSON.stringify([{ sessionId: 'S0', atMs: Date.now() }]),
    );
    mkdirSync(join(dir, 'subagents', 'S0'), { recursive: true });
    writeFileSync(
      join(dir, 'subagents', 'S0', 'agent-a0.jsonl'),
      transcript('a0'),
    );

    const env = { QWEN_CODE_PROJECT_DIR: dir, QWEN_CODE_SESSION_ID: 'S-new' };
    // Without the option: the current dir is still load-bearing.
    expect(() => readRunTranscripts(plan, undefined, env)).toThrow(
      TranscriptsUnavailableError,
    );
    const recs = readRunTranscripts(plan, undefined, env, undefined, {
      currentDirOptional: true,
    });
    expect(recs.map((r) => [r.agentId, r.fromPriorSession === true])).toEqual([
      ['a0', true],
    ]);
  });

  it('still throws on a missing ENVIRONMENT even with the option', () => {
    const plan = join(dir, 'qwen-review-pr-7-fetch.json');
    writeFileSync(plan, JSON.stringify({ diffLines: 1, chunks: [] }));
    expect(() =>
      readRunTranscripts(plan, undefined, {}, undefined, {
        currentDirOptional: true,
      }),
    ).toThrow(TranscriptsUnavailableError);
  });
});

describe('readRunTranscripts — containment and fault handling', () => {
  const transcript = (agentId: string): string =>
    JSON.stringify({
      agentId,
      agentName: 'general-purpose',
      type: 'user',
      message: { role: 'user', parts: [{ text: `launch ${agentId}` }] },
    }) + '\n';

  function planWithLedger(...sessionIds: string[]): string {
    const plan = join(dir, 'qwen-review-pr-7-fetch.json');
    writeFileSync(plan, JSON.stringify({ diffLines: 1, chunks: [] }));
    const recordDir = join(dir, 'qwen-review-pr-7-fetch-prompts');
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(
      join(recordDir, 'run-sessions.json'),
      JSON.stringify(
        sessionIds.map((id) => ({ sessionId: id, atMs: Date.now() })),
      ),
    );
    return plan;
  }

  it('refuses a prior session whose directory is a symlink', () => {
    // The ledger's charset gate stops `..`, but `subagents/<id>` can BE a
    // symlink and readdir/readFile follow one — that would let foreign
    // transcripts enter as this run's prior evidence.
    const plan = planWithLedger('S0', 'S1');
    const outside = join(dir, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'agent-foreign.jsonl'), transcript('foreign'));
    symlinkSync(outside, join(dir, 'subagents', 'S0'));
    mkdirSync(join(dir, 'subagents', 'S1'), { recursive: true });
    file('agent-a1.jsonl', transcript('a1'));

    const recs = readRunTranscripts(plan, undefined, ENV);
    expect(recs.map((r) => r.agentId)).toEqual(['a1']);
    expect(transcriptDirsForRun(plan, ENV)).toEqual([
      join(dir, 'subagents', 'S1'),
    ]);
  });

  it('still throws when the current dir is unreadable, not merely absent', () => {
    // EACCES on an EXISTING directory is a live fault; absorbing it would
    // certify on prior evidence while the current records are unreadable.
    const plan = planWithLedger('S0', 'S1');
    mkdirSync(join(dir, 'subagents', 'S0'), { recursive: true });
    writeFileSync(
      join(dir, 'subagents', 'S0', 'agent-a0.jsonl'),
      transcript('a0'),
    );
    const cur = join(dir, 'subagents', 'S1');
    mkdirSync(cur, { recursive: true });
    chmodSync(cur, 0o000);
    try {
      expect(() =>
        readRunTranscripts(plan, undefined, ENV, undefined, {
          currentDirOptional: true,
        }),
      ).toThrow(TranscriptsUnavailableError);
    } finally {
      chmodSync(cur, 0o755);
    }
  });

  it('throws on a missing current dir when the run has no prior evidence', () => {
    // No ledger: this is a run that has shown nothing, not a continuation.
    const plan = join(dir, 'qwen-review-pr-7-fetch.json');
    writeFileSync(plan, JSON.stringify({ diffLines: 1, chunks: [] }));
    expect(() =>
      readRunTranscripts(
        plan,
        undefined,
        { QWEN_CODE_PROJECT_DIR: dir, QWEN_CODE_SESSION_ID: 'S-none' },
        undefined,
        { currentDirOptional: true },
      ),
    ).toThrow(TranscriptsUnavailableError);
  });
});
