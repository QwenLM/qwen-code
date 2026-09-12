/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  chunkOfKey,
  declaredUncoverableChunkIds,
  declaresOwnUncoverable,
  openedBrief,
  readBrief,
  readFindingsPointer,
} from './certification.js';
import { briefPath } from './prompt-record.js';
import type { AgentRecord } from './transcripts.js';

const PLAN = '/tmp/certification-test/plan.json';

function rec(over: Partial<AgentRecord>): AgentRecord {
  return {
    agentId: 'a1',
    agentName: 'agent-a1',
    launchPrompt: '',
    successfulToolCalls: 0,
    diffToolCalls: 0,
    diffReads: [],
    successfulCallArgs: [],
    successfulReadFileArgs: [],
    recordedSession: 's1',
    finalText: '',
    returned: true,
    mtimeMs: 0,
    ...over,
  };
}

describe('chunkOfKey', () => {
  it('parses the bare chunk key', () => {
    expect(chunkOfKey('chunk-13')).toBe(13);
  });

  it('parses the per-chunk audit key from its --chunk-N segment', () => {
    expect(chunkOfKey('reverse-audit--chunk-13--round-2--0a1b2c')).toBe(13);
  });

  it('parses a trailing --chunk-N segment', () => {
    expect(chunkOfKey('reverse-audit--chunk-7')).toBe(7);
  });

  it('assigns no chunk to chunk-free keys', () => {
    expect(chunkOfKey('verify--0a1b2c')).toBeNull();
    expect(chunkOfKey('reverse-audit--round-2--0a1b2c')).toBeNull();
  });

  it('does not mistake a digest containing "chunk" for an assignment', () => {
    // Only the exact `--chunk-<digits>` segment form assigns; an embedded
    // word does not.
    expect(chunkOfKey('verify--chunky')).toBeNull();
  });
});

describe('declaresOwnUncoverable', () => {
  const declaring = 'Uncoverable: chunk 3 — binary payload, no readable lines';

  it('vetoes the record whose own return declares its own chunk', () => {
    expect(declaresOwnUncoverable(rec({ finalText: declaring }), 3)).toBe(true);
  });

  it('does not veto a declaration about a DIFFERENT chunk', () => {
    expect(declaresOwnUncoverable(rec({ finalText: declaring }), 4)).toBe(
      false,
    );
  });

  it('never vetoes a chunk-less record — a quotation is not a declaration', () => {
    // The whole-diff auditor quoting the evidence it audited.
    expect(declaresOwnUncoverable(rec({ finalText: declaring }), null)).toBe(
      false,
    );
  });

  it('vetoes a declaration preceded by prose on an earlier line (pins /m)', () => {
    expect(
      declaresOwnUncoverable(
        rec({ finalText: `Read what I could.\n${declaring}` }),
        3,
      ),
    ).toBe(true);
  });

  it('matches a lowercase marker (pins /i)', () => {
    expect(
      declaresOwnUncoverable(
        rec({ finalText: 'uncoverable: chunk 3 — binary payload' }),
        3,
      ),
    ).toBe(true);
  });

  it('ignores a declaration quoted mid-line in prose', () => {
    // The `^` anchor: a quotation that does not start its own line cannot
    // match, whatever whitespace the quote carries.
    const quoted = `- the agent said "${declaring}" which I verified`;
    expect(declaresOwnUncoverable(rec({ finalText: quoted }), 3)).toBe(false);
  });

  it('vetoes when the record\u2019s own declaration follows a quoted one', () => {
    // EVERY match is read, not only the first: a declarer that quotes
    // another chunk's declaration — indented, on its own line, exactly as
    // a reverse-audit return does — ahead of its own line still declares
    // its own chunk. The first-match read saw the quotation and missed
    // the declaration (R22-2).
    const text =
      'The chunk-2 agent returned:\n' +
      '  Uncoverable: chunk 2 — line exceeds the read limit\n' +
      `${declaring}`;
    expect(declaresOwnUncoverable(rec({ finalText: text }), 3)).toBe(true);
  });
});

describe('declaredUncoverableChunkIds', () => {
  it('returns every declaration in text order, quotations included', () => {
    // The walk adjudicates each candidate against its shape gates, so the
    // atom must hand over ALL of them — an earlier quotation of another
    // chunk's declaration must not hide the record's own (R22-2).
    const text =
      'The chunk-2 agent returned:\n' +
      '  Uncoverable: chunk 2 — line exceeds the read limit\n' +
      'Uncoverable: chunk 3 — binary payload, no readable lines';
    expect(declaredUncoverableChunkIds(rec({ finalText: text }))).toEqual([
      2, 3,
    ]);
  });

  it('returns nothing when the return carries no declaration', () => {
    expect(
      declaredUncoverableChunkIds(rec({ finalText: 'All clear.' })),
    ).toEqual([]);
  });
});

describe('openedBrief / readBrief', () => {
  const key = 'chunk-2';
  const needle = JSON.stringify(briefPath(PLAN, key));
  const arg = `{"absolute_path":${needle}}`;

  it('does not credit a shell command that merely MENTIONS the brief', () => {
    // The trap a prose matcher walks into: `findings.ts` has a
    // same-purpose-looking `namesPath` that matches on a name boundary, and
    // it credits this arg. Deleting a brief is not opening it — so this atom
    // matches the whole JSON string value instead, and keeps a different
    // name so no future consolidation unifies the two the wrong way.
    const r = rec({
      successfulCallArgs: [
        JSON.stringify({ command: `rm ${briefPath(PLAN, key)}` }),
      ],
    });
    expect(openedBrief(r, PLAN, key)).toBe(false);
  });

  it('credits any successful tool whose args name the exact brief path', () => {
    const r = rec({ successfulCallArgs: [arg] });
    expect(openedBrief(r, PLAN, key)).toBe(true);
  });

  it('credits a match anywhere in the call list, not just the first call', () => {
    // The shared `argsNameExactPath` wrapper is an existential over the whole
    // list. Every other fixture here has 0 or 1 arg, so a first-element-only
    // regression (`args.length > 0 && …(args[0]!, path)`) ships green while
    // refusing an agent whose first successful call named another file and
    // whose LATER call opened the brief — its work re-owed. Match in the
    // second position pins the quantifier for all three atoms.
    const other = `{"absolute_path":${JSON.stringify(`${PLAN}-other.txt`)}}`;
    expect(
      openedBrief(rec({ successfulCallArgs: [other, arg] }), PLAN, key),
    ).toBe(true);
    expect(
      readBrief(rec({ successfulReadFileArgs: [other, arg] }), PLAN, key),
    ).toBe(true);
  });

  it('does not credit a record that made zero successful tool calls', () => {
    // `[].every(...)` is true: the existential quantifier needs its own
    // negative, like its two sibling atoms already have.
    expect(openedBrief(rec({}), PLAN, key)).toBe(false);
  });

  it('does not credit a sibling file sharing the prefix', () => {
    const bak = JSON.stringify(`${briefPath(PLAN, key)}.bak`);
    const r = rec({ successfulCallArgs: [`{"absolute_path":${bak}}`] });
    expect(openedBrief(r, PLAN, key)).toBe(false);
  });

  it('does not credit another key’s brief', () => {
    const r = rec({ successfulCallArgs: [arg] });
    expect(openedBrief(r, PLAN, 'chunk-3')).toBe(false);
  });

  it('readBrief does not credit a sibling file sharing the prefix', () => {
    const bak = JSON.stringify(`${briefPath(PLAN, key)}.bak`);
    const r = rec({ successfulReadFileArgs: [`{"absolute_path":${bak}}`] });
    expect(readBrief(r, PLAN, key)).toBe(false);
  });

  it('readBrief requires a successful read_file, not a mention', () => {
    // A grep whose args contain the path opened nothing.
    const r = rec({ successfulCallArgs: [arg], successfulReadFileArgs: [] });
    expect(openedBrief(r, PLAN, key)).toBe(true);
    expect(readBrief(r, PLAN, key)).toBe(false);
    const read = rec({ successfulReadFileArgs: [arg] });
    expect(readBrief(read, PLAN, key)).toBe(true);
  });
});

describe('readFindingsPointer', () => {
  const pointer =
    '/tmp/certification-test/plan.json-prompts/round-2.findings.md';
  const arg = `{"absolute_path":${JSON.stringify(pointer)}}`;

  it('owes nothing when the prompt names no pointer', () => {
    expect(readFindingsPointer(rec({}), null)).toBe(true);
  });

  it('does not credit a sibling of the pointer', () => {
    const bak = JSON.stringify(`${pointer}.bak`);
    const r = rec({ successfulReadFileArgs: [`{"absolute_path":${bak}}`] });
    expect(readFindingsPointer(r, pointer)).toBe(false);
  });

  it('requires a successful read_file of the exact pointer', () => {
    expect(
      readFindingsPointer(rec({ successfulReadFileArgs: [arg] }), pointer),
    ).toBe(true);
    // Named by a listing, read by nothing.
    expect(
      readFindingsPointer(rec({ successfulCallArgs: [arg] }), pointer),
    ).toBe(false);
  });
});
