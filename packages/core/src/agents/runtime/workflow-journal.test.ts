/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  canonicalizeAgentOpts,
  deriveAgentKey,
  deriveArgsSeed,
  buildReplay,
  WorkflowJournal,
  JOURNAL_KEY_VERSION,
  type JournalEntry,
} from './workflow-journal.js';

describe('canonicalizeAgentOpts', () => {
  it('keeps only dispatch-affecting opts', () => {
    const c = canonicalizeAgentOpts({
      label: 'ignored',
      phase: 'ignored',
      stallMs: 1234,
      model: 'm1',
      agentType: 'a1',
    });
    expect(c).toBe(JSON.stringify({ agentType: 'a1', model: 'm1' }));
  });

  it('sorts object keys deeply so reordered schemas hash the same', () => {
    const a = canonicalizeAgentOpts({
      schema: { type: 'object', properties: { b: 1, a: 2 } },
    });
    const b = canonicalizeAgentOpts({
      schema: { properties: { a: 2, b: 1 }, type: 'object' },
    });
    expect(a).toBe(b);
  });

  it('drops function-valued opts', () => {
    const c = canonicalizeAgentOpts({
      model: 'm',
      // A function is structurally an `object`, so this needs no type
      // suppression — the test asserts the *runtime* strip of callable values.
      schema: () => {},
    });
    expect(c).toBe(JSON.stringify({ model: 'm' }));
  });

  it('empty opts → {}', () => {
    expect(canonicalizeAgentOpts({})).toBe('{}');
  });
});

describe('deriveAgentKey', () => {
  it('is deterministic for the same inputs', () => {
    const k1 = deriveAgentKey('', 'do x', { model: 'm' });
    const k2 = deriveAgentKey('', 'do x', { model: 'm' });
    expect(k1).toBe(k2);
    expect(k1).toMatch(new RegExp(`^${JOURNAL_KEY_VERSION}:[0-9a-f]{64}$`));
  });

  it('changes when the prompt changes', () => {
    expect(deriveAgentKey('', 'a', {})).not.toBe(deriveAgentKey('', 'b', {}));
  });

  it('changes when an opt changes', () => {
    expect(deriveAgentKey('', 'x', { model: 'm1' })).not.toBe(
      deriveAgentKey('', 'x', { model: 'm2' }),
    );
  });

  it('does NOT change when only a cosmetic opt (label) changes', () => {
    expect(deriveAgentKey('', 'x', { label: 'a' })).toBe(
      deriveAgentKey('', 'x', { label: 'b' }),
    );
  });

  it('changes when the prefix hash changes (chaining)', () => {
    expect(deriveAgentKey('prefA', 'x', {})).not.toBe(
      deriveAgentKey('prefB', 'x', {}),
    );
  });
});

describe('buildReplay', () => {
  it('results last-write-wins; started entries accumulate', () => {
    const entries: JournalEntry[] = [
      { type: 'started', key: 'k1', agentId: '1' },
      { type: 'result', key: 'k1', agentId: '1', result: 'first' },
      { type: 'started', key: 'k1', agentId: '2' }, // respawn
      { type: 'result', key: 'k1', agentId: '2', result: 'second' },
      { type: 'started', key: 'k2', agentId: '3' },
    ];
    const replay = buildReplay(entries);
    expect(replay.results.get('k1')?.result).toBe('second');
    expect(replay.started.get('k1')).toHaveLength(2);
    expect(replay.started.get('k2')).toHaveLength(1);
    expect(replay.results.has('k2')).toBe(false); // started but never resulted
  });
});

describe('WorkflowJournal', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-journal-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('append then load round-trips entries', async () => {
    const j = new WorkflowJournal(path.join(dir, 'sub', 'journal.jsonl'));
    await j.append({ type: 'started', key: 'k1', agentId: '1' });
    await j.append({ type: 'result', key: 'k1', agentId: '1', result: { v: 9 } });
    const replay = await j.load();
    expect(replay.results.get('k1')?.result).toEqual({ v: 9 });
    expect(replay.started.get('k1')).toHaveLength(1);
  });

  it('load on a missing file returns empty maps', async () => {
    const j = new WorkflowJournal(path.join(dir, 'nope.jsonl'));
    const replay = await j.load();
    expect(replay.results.size).toBe(0);
    expect(replay.started.size).toBe(0);
  });
});

// #7: the resume prefix chain is seeded with the run's args, so a resume with
// different args yields a disjoint key space (cache misses → live re-run).
describe('deriveArgsSeed', () => {
  it('is deterministic for equal args and differs for different args', () => {
    expect(deriveArgsSeed({ a: 1 })).toBe(deriveArgsSeed({ a: 1 }));
    expect(deriveArgsSeed({ a: 1 })).not.toBe(deriveArgsSeed({ a: 2 }));
    expect(deriveArgsSeed(undefined)).toBe(deriveArgsSeed(null));
  });

  it('changes the first agent key when args change', () => {
    const k1 = deriveAgentKey(deriveArgsSeed({ topic: 'a' }), 'do x', {});
    const k2 = deriveAgentKey(deriveArgsSeed({ topic: 'b' }), 'do x', {});
    expect(k1).not.toBe(k2); // same prompt+opts, different args → different key
  });
});
