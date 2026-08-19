/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  chunkOfKey,
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

  it('ignores a declaration indented into prose', () => {
    // The `^` anchor with only whitespace allowed before the marker: a
    // quoted line inside a bullet does not match.
    const quoted = `- the agent said "${declaring}" which I verified`;
    expect(declaresOwnUncoverable(rec({ finalText: quoted }), 3)).toBe(false);
  });
});

describe('openedBrief / readBrief', () => {
  const key = 'chunk-2';
  const needle = JSON.stringify(briefPath(PLAN, key));
  const arg = `{"absolute_path":${needle}}`;

  it('credits any successful tool whose args name the exact brief path', () => {
    const r = rec({ successfulCallArgs: [arg] });
    expect(openedBrief(r, PLAN, key)).toBe(true);
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
