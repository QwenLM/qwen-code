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
  priorSessionDirs,
  wasGivenTheDiff,
  transcriptDir,
  TranscriptsUnavailableError,
  type AgentRecord,
  serializedArgsNamePath,
} from './transcripts.js';
import { appendRunSession, recordResume } from './run-ledger.js';

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

  it('counts a diff read via serializedArgsNamePath, not a look-alike', () => {
    // The diff-read half of the shared needle: `diffToolCalls` is populated
    // only when `diffPath` is passed, and no other test passes one. A swap of
    // the two args at the `serializedArgsNamePath(JSON.stringify(args), path)`
    // call site (both strings, so it compiles) ships green and every coverage
    // gate then reads `diffToolCalls: 0`. Pin it with the exact read counted
    // and two look-alikes — a `.bak` sibling and a shell command that only
    // NAMES the diff — refused.
    const b = { agentId: 'a1', agentName: 'general-purpose', sessionId: 'S1' };
    const call = (
      name: string,
      args: object,
      response: object = { output: 'ok' },
    ): object[] => [
      {
        ...b,
        type: 'assistant',
        message: { role: 'model', parts: [{ functionCall: { name, args } }] },
      },
      {
        ...b,
        type: 'tool_result',
        message: {
          role: 'user',
          parts: [{ functionResponse: { name, response } }],
        },
      },
    ];
    file(
      'agent-a1.jsonl',
      [
        // A plain object literal like its siblings — pre-stringifying it here
        // would let the trailing `.map` encode it twice, so `parseTranscript`
        // parses a bare string and silently drops the launch line.
        {
          ...b,
          type: 'user',
          message: { role: 'user', parts: [{ text: 'chunk 1 of 1' }] },
        },
        ...call('read_file', { file_path: '/d.txt', offset: 0, limit: 40 }),
        ...call('read_file', { file_path: '/d.txt.bak' }),
        ...call('run_shell_command', { command: 'rm /d.txt' }),
        // A FAILED read of the diff: names it, but the response is an error.
        // Hoisting the `diffToolCalls++` / `diffReads.push` out of the
        // `!isErrorPart` branch would count this as a diff read.
        ...call(
          'read_file',
          { file_path: '/d.txt', offset: 40, limit: 40 },
          { error: 'denied' },
        ),
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );
    const [rec] = readTranscripts(undefined, ENV, '/d.txt');
    // The launch line survived — proof the fixture is single-encoded.
    expect(rec.launchPrompt).toBe('chunk 1 of 1');
    // Only the ONE successful, exact-path read counts: not the `.bak`
    // sibling, not the shell mention, not the denied read.
    expect(rec.diffToolCalls).toBe(1);
    // The RANGE too, not only the count: `range` is wired through the same
    // `namedTheDiff` decision, so dropping that wiring leaves the count
    // right and every chunk-coverage ruling — which reads the lines, not
    // the tally — with nothing to rule on. The denied read's [41, 80] is
    // absent, pinning the success gate on `diffReads` as well.
    expect(rec.diffReads).toEqual([[1, 40]]);
    // The same gate guards the evidence lists the certification atoms read
    // (`openedBrief`, `readBrief`, `readFindingsPointer`): the denied read
    // must stay out of them too, not only out of the diff fields.
    expect(rec.successfulCallArgs).toHaveLength(3);
    expect(rec.successfulReadFileArgs).toHaveLength(2);
    // And with no diffPath the field stays 0, whatever was read.
    expect(readTranscripts(undefined, ENV)[0].diffToolCalls).toBe(0);
  });
});

describe('wasGivenTheDiff', () => {
  const rec = (launchPrompt: string): AgentRecord => ({
    agentId: 'a',
    agentName: 'general-purpose',
    recordedSession: '',
    launchPrompt,
    successfulToolCalls: 0,
    diffToolCalls: 0,
    diffReads: [],
    successfulCallArgs: [],
    successfulReadFileArgs: [],
    finalText: '',
    returned: false,
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
    // Prior attempts first, the current one stamped slightly later: each
    // attempt's window closes when the next one opened, and a fixture that
    // stamped them together would fence out transcripts written "now".
    const now = Date.now();
    sessionIds.forEach((id, i) => {
      appendRunSession(
        plan,
        { QWEN_CODE_SESSION_ID: id },
        i === sessionIds.length - 1 ? now + 1500 : now,
      );
    });
    recordResume(plan, ENV, now + 1500);
    return plan;
  }

  function priorFile(session: string, name: string, contents: string): void {
    mkdirSync(join(dir, 'subagents', session), { recursive: true });
    const f = join(dir, 'subagents', session, name);
    writeFileSync(f, contents);
    // Backdated: the ledger fixture closes the prior window ~1.5s after its
    // own `Date.now()`, and these files are written AFTERWARD — a CI stall
    // between the two would fence them out via the `until` clamp and flake
    // every positive test. Ten seconds back keeps them inside any window a
    // stall can produce, and still after the backdated plan.
    const past = new Date(Date.now() - 10_000);
    utimesSync(f, past, past);
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

  it('refuses a foreign-stamped transcript in the CURRENT directory too', () => {
    // The one-sided version of the copy rule was the gap: prior directories
    // checked ownership, the current one did not, so an S0-stamped file
    // planted under S1 was trusted as current evidence — `since` cannot
    // catch a copy (fresh mtime), and the prompt pairing passes (prompts are
    // deterministic per plan).
    // The fixture's records carry no session stamp (older harness shape), so
    // stamp this one explicitly: the check refuses a MISMATCH, not absence.
    file(
      'agent-planted.jsonl',
      JSON.stringify({
        agentId: 'planted',
        agentName: 'general-purpose',
        sessionId: 'S0',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'launch planted' }] },
      }) + '\n',
    );
    file('agent-own.jsonl', transcript('own'));
    const recs = readTranscripts(undefined, ENV);
    expect(recs.map((r) => r.agentId)).toEqual(['own']);
  });

  it('looks up the session directory under the SANITIZED id', () => {
    // The harness writes `subagents/<sanitized>` — everything outside
    // [A-Za-z0-9_-] maps to '_' — while the ledger's charset admits dots
    // ("room for prefixed variants"). Joined raw, an id like `resume.1`
    // reaches a path that does not exist and every reader silently sees
    // nothing, one underscore away from the records.
    const env = { QWEN_CODE_PROJECT_DIR: dir, QWEN_CODE_SESSION_ID: 'S.dot' };
    mkdirSync(join(dir, 'subagents', 'S_dot'), { recursive: true });
    writeFileSync(
      join(dir, 'subagents', 'S_dot', 'agent-a9.jsonl'),
      JSON.stringify({
        agentId: 'a9',
        agentName: 'general-purpose',
        sessionId: 'S.dot',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'launch a9' }] },
      }) + '\n',
    );
    const recs = readTranscripts(undefined, env);
    expect(recs.map((r) => r.agentId)).toEqual(['a9']);
  });

  it('refuses a foreign-stamped transcript in a PRIOR directory', () => {
    // The refusing side of the copy rule for prior dirs: every other fixture
    // either matches the stamp or omits it. Deleting the guard shipped green.
    const plan = planWithLedger('S0', 'S1');
    priorFile(
      'S0',
      'agent-planted.jsonl',
      JSON.stringify({
        agentId: 'planted',
        agentName: 'general-purpose',
        sessionId: 'S9',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'launch planted' }] },
      }) + '\n',
    );
    file('agent-a1.jsonl', transcript('a1'));
    const recs = readRunTranscripts(plan, undefined, ENV);
    expect(recs.map((r) => r.agentId)).toEqual(['a1']);
  });

  it('excludes a prior transcript written AFTER its attempt ended', () => {
    // The refusing side of the per-attempt window: an operator who kept
    // using the interrupted CLI session writes transcripts after the resume
    // took over, and those are not this review's evidence. Every other
    // fixture writes prior files before endsAtMs, so deleting the clamp
    // shipped green.
    const plan = planWithLedger('S0', 'S1');
    priorFile('S0', 'agent-late.jsonl', transcript('late'));
    // The prior attempt's window closed at the S1 entry (now + 1500 in the
    // ledger fixture); stamp the file well past it.
    const future = new Date(Date.now() + 3600_000);
    utimesSync(
      join(dir, 'subagents', 'S0', 'agent-late.jsonl'),
      future,
      future,
    );
    file('agent-a1.jsonl', transcript('a1'));
    const recs = readRunTranscripts(plan, undefined, ENV);
    expect(recs.map((r) => r.agentId)).toEqual(['a1']);
  });

  it('finds a dotted PRIOR session under its sanitized directory', () => {
    // The ledger charset admits dots; the harness writes `subagents/S_0dot`.
    // Under a raw join the lookup ENOENTs and every reader silently sees
    // nothing — the current-session side is pinned, this is the prior side.
    const plan = planWithLedger('S.0dot', 'S1');
    mkdirSync(join(dir, 'subagents', 'S_0dot'), { recursive: true });
    const f = join(dir, 'subagents', 'S_0dot', 'agent-ap.jsonl');
    writeFileSync(
      f,
      JSON.stringify({
        agentId: 'ap',
        agentName: 'general-purpose',
        sessionId: 'S.0dot',
        type: 'user',
        message: { role: 'user', parts: [{ text: 'launch ap' }] },
      }) + '\n',
    );
    const past = new Date(Date.now() - 10_000);
    utimesSync(f, past, past);
    file('agent-a1.jsonl', transcript('a1'));
    const recs = readRunTranscripts(plan, undefined, ENV);
    expect(recs.map((r) => r.agentId).sort()).toEqual(['a1', 'ap']);
  });

  it('lists each prior session once, and only those that exist', () => {
    const plan = planWithLedger('S0', 'S0', 'S1');
    // A prior session that exists on disk: the accessor skips a ledgered id
    // whose directory is absent or symlinked, so the fixture must be real.
    priorFile('S0', 'agent-a0.jsonl', transcript('a0'));
    expect(priorSessionDirs(plan, ENV).map((p) => p.dir)).toEqual([
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
    const now = Date.now();
    appendRunSession(plan, { QWEN_CODE_SESSION_ID: 'S0' }, now);
    mkdirSync(join(dir, 'subagents', 'S0'), { recursive: true });
    writeFileSync(
      join(dir, 'subagents', 'S0', 'agent-a0.jsonl'),
      transcript('a0'),
    );

    const env = { QWEN_CODE_PROJECT_DIR: dir, QWEN_CODE_SESSION_ID: 'S-new' };
    // Reading prior evidence requires this session's own authorized resume.
    // (The stamp's position relative to the transcripts is fixture realism,
    // not a requirement — no code compares a resume's atMs to any transcript
    // mtime; the only time clamps on prior records are `since` and the next
    // session's ledger `atMs`.)
    appendRunSession(plan, env, now + 1500);
    recordResume(plan, env, now + 1500);
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
    const now = Date.now();
    sessionIds.forEach((id, i) => {
      appendRunSession(
        plan,
        { QWEN_CODE_SESSION_ID: id },
        i === sessionIds.length - 1 ? now + 1500 : now,
      );
    });
    recordResume(plan, ENV, now + 1500);
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
    expect(priorSessionDirs(plan, ENV)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'still throws when the current dir is unreadable, not merely absent',
    () => {
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
    },
  );

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

describe('the incomplete-transcript shapes the resume path reads', () => {
  const user = (text: string) =>
    JSON.stringify({
      agentId: 'a1',
      agentName: 'general-purpose',
      sessionId: 'S1',
      type: 'user',
      message: { role: 'user', parts: [{ text }] },
    });
  const assistant = (parts: unknown[]) =>
    JSON.stringify({
      agentId: 'a1',
      sessionId: 'S1',
      type: 'assistant',
      message: { role: 'assistant', parts },
    });

  it('a non-terminal sidecar status makes the last text progress, not a return', () => {
    // The harness appends ROUND_TEXT before the round's tool calls and
    // writes NO terminal transcript record on completion, so an agent
    // killed after a text flush ends IDENTICALLY to a completed one. The
    // sidecar is the authoritative lifecycle record: a killed agent's
    // persisted status stays 'running'.
    file(
      'agent-a1.jsonl',
      [user('go'), assistant([{ text: 'Verdict: clean.' }])].join('\n') + '\n',
    );
    file(
      'agent-a1.meta.json',
      JSON.stringify({ agentId: 'a1', status: 'running' }),
    );
    const recs = readTranscripts(undefined, ENV);
    expect(recs).toHaveLength(1);
    expect(recs[0].finalText).toBe('Verdict: clean.');
    expect(recs[0].returned).toBe(false);
  });

  it('a completed sidecar (or none) leaves content inference standing', () => {
    file(
      'agent-a1.jsonl',
      [user('go'), assistant([{ text: 'Verdict: clean.' }])].join('\n') + '\n',
    );
    file(
      'agent-a1.meta.json',
      JSON.stringify({ agentId: 'a1', status: 'completed' }),
    );
    expect(readTranscripts(undefined, ENV)[0].returned).toBe(true);
    rmSync(join(dir, 'subagents', 'S1', 'agent-a1.meta.json'));
    expect(readTranscripts(undefined, ENV)[0].returned).toBe(true);
  });

  it('a thought-only final record is not a return and never final text', () => {
    // Thinking mode emits {text, thought: true} parts in ROUND_TEXT before
    // the round's tool calls land as records — a kill between the two
    // leaves a complete thought-only last record, and counting thoughts
    // handed the agent's INTERNAL REASONING downstream as its verdict.
    file(
      'agent-a1.jsonl',
      [
        user('go'),
        assistant([{ text: 'Real return.' }]),
        assistant([
          {
            text: 'Let me consider whether UNCOVERABLE applies…',
            thought: true,
          },
        ]),
      ].join('\n') + '\n',
    );
    const recs = readTranscripts(undefined, ENV);
    expect(recs[0].finalText).toBe('Real return.');
    expect(recs[0].returned).toBe(true);
  });

  it('rejects a transcript whose records carry two different sessions', () => {
    // A GRAFT: a forged head stamped with the directory's session (the
    // launch prompt is deterministic per plan) spliced onto another
    // session's genuine records. The ownership check keys on the first
    // stamp, so per-line consistency has to be what rejects the file.
    file(
      'agent-a1.jsonl',
      [
        user('go'),
        JSON.stringify({
          agentId: 'a1',
          sessionId: 'S0',
          type: 'assistant',
          message: { role: 'assistant', parts: [{ text: 'grafted return' }] },
        }),
      ].join('\n') + '\n',
    );
    expect(readTranscripts(undefined, ENV)).toEqual([]);
  });

  it('keeps accepting unstamped lines beside stamped ones', () => {
    // Older harness writes stamp nothing; absence is not a conflict.
    file(
      'agent-a1.jsonl',
      [
        user('go'),
        JSON.stringify({
          agentId: 'a1',
          type: 'assistant',
          message: { role: 'assistant', parts: [{ text: 'ok' }] },
        }),
      ].join('\n') + '\n',
    );
    expect(readTranscripts(undefined, ENV)).toHaveLength(1);
  });
});

describe('serializedArgsNamePath — the one needle both halves use', () => {
  const brief = '/plan/chunk-3.brief.md';

  it('matches the path as a whole JSON string value', () => {
    expect(
      serializedArgsNamePath(JSON.stringify({ absolute_path: brief }), brief),
    ).toBe(true);
  });

  it('does not credit a longer path holding this one as a prefix', () => {
    expect(
      serializedArgsNamePath(
        JSON.stringify({ absolute_path: `${brief}.bak` }),
        brief,
      ),
    ).toBe(false);
  });

  it('does not credit a shell command that merely mentions the path', () => {
    // The divergence the review measured between this and the prose-boundary
    // `namesPath` in `findings.ts`, which returns true here. Both the
    // diff-read half and the brief atoms route through THIS one, so the
    // certification bar cannot credit `rm <file>` as opening it.
    expect(
      serializedArgsNamePath(JSON.stringify({ command: `rm ${brief}` }), brief),
    ).toBe(false);
  });
});
