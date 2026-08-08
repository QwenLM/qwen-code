/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  canonicalizeAgentOpts,
  deriveAgentKey,
  deriveArgsSeed,
  buildReplay,
  WorkflowJournal,
  JOURNAL_FORMAT_VERSION,
  JOURNAL_KEY_VERSION,
  type JournalCheckpoint,
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
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('append then load round-trips entries', async () => {
    const j = new WorkflowJournal(path.join(dir, 'sub', 'journal.jsonl'));
    await j.append({ type: 'started', key: 'k1', agentId: '1' });
    await j.append({
      type: 'result',
      key: 'k1',
      agentId: '1',
      result: { v: 9 },
    });
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

  it('continues from an empty checkpoint when the journal file is absent', async () => {
    const journalPath = path.join(dir, 'empty-resume', 'journal.jsonl');
    const checkpoint = await new WorkflowJournal(journalPath).flush();
    const resumed = new WorkflowJournal(journalPath);

    await expect(resumed.load(checkpoint)).resolves.toMatchObject({
      results: expect.any(Map),
      started: expect.any(Map),
    });
    await expect(resumed.flush()).resolves.toMatchObject({
      byteLength: 0,
      integrity: 'complete',
    });
    await expect(
      resumed.append({ type: 'started', key: 'v2:first', agentId: '1' }),
    ).resolves.toBeUndefined();
    expect((await resumed.flush()).byteLength).toBeGreaterThan(0);
  });

  it('orders concurrent appends and flushes exactly the queued prefix', async () => {
    const journalPath = path.join(dir, 'ordered', 'journal.jsonl');
    const j = new WorkflowJournal(journalPath);
    const entries: JournalEntry[] = [
      { type: 'started', key: 'v2:k1', agentId: '1' },
      { type: 'result', key: 'v2:k1', agentId: '1', result: 'first' },
      { type: 'started', key: 'v2:k2', agentId: '2' },
    ];

    const writes = entries.map((entry) => j.append(entry));
    const checkpoint = await j.flush();
    await Promise.all(writes);

    const bytes = await fs.readFile(journalPath);
    expect(bytes.toString('utf8')).toBe(
      entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
    );
    expect(checkpoint).toEqual({
      version: JOURNAL_FORMAT_VERSION,
      keyVersion: JOURNAL_KEY_VERSION,
      byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      integrity: 'complete',
    });
  });

  it('continues the queue after a write failure and remembers the failure', async () => {
    const blockedParent = path.join(dir, 'blocked');
    await fs.writeFile(blockedParent, 'not a directory');
    const journalPath = path.join(blockedParent, 'journal.jsonl');
    const j = new WorkflowJournal(journalPath);

    await expect(
      j.append({ type: 'started', key: 'v2:failed', agentId: '1' }),
    ).rejects.toBeDefined();
    await fs.rm(blockedParent);
    await fs.mkdir(blockedParent);
    await expect(
      j.append({ type: 'started', key: 'v2:survived', agentId: '2' }),
    ).resolves.toBeUndefined();

    const checkpoint = await j.flush();
    expect(checkpoint.integrity).toBe('failed');
    expect(checkpoint.error).toBeTruthy();
    await expect(j.load(checkpoint)).rejects.toThrow(/integrity/i);
    expect(await fs.readFile(journalPath, 'utf8')).toContain('v2:survived');
  });

  it('refuses journal and parent symlinks without modifying outside files', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-outside-'));
    try {
      for (const kind of ['journal', 'run-dir', 'root'] as const) {
        const caseRoot = path.join(dir, kind);
        const outsideRun = path.join(outside, kind, 'wf_dead');
        await fs.mkdir(outsideRun, { recursive: true });
        const canary = path.join(outsideRun, 'journal.jsonl');
        await fs.writeFile(canary, 'CANARY\n');
        let journalPath: string;
        if (kind === 'journal') {
          const runDir = path.join(caseRoot, 'wf_dead');
          await fs.mkdir(runDir, { recursive: true });
          journalPath = path.join(runDir, 'journal.jsonl');
          await fs.symlink(canary, journalPath);
        } else if (kind === 'run-dir') {
          await fs.mkdir(caseRoot, { recursive: true });
          await fs.symlink(outsideRun, path.join(caseRoot, 'wf_dead'));
          journalPath = path.join(caseRoot, 'wf_dead', 'journal.jsonl');
        } else {
          await fs.mkdir(path.dirname(caseRoot), { recursive: true });
          const outsideRoot = path.dirname(outsideRun);
          await fs.symlink(outsideRoot, caseRoot);
          journalPath = path.join(caseRoot, 'wf_dead', 'journal.jsonl');
        }
        const journal = new WorkflowJournal(journalPath);
        await expect(
          journal.append({
            type: 'started',
            key: `v2:${kind}`,
            agentId: '1',
          }),
        ).rejects.toBeDefined();
        expect((await journal.flush()).integrity).toBe('failed');
        await expect(fs.readFile(canary, 'utf8')).resolves.toBe('CANARY\n');
      }
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a hardlinked journal without modifying its other name', async () => {
    const runDir = path.join(dir, 'hardlink', 'wf_dead');
    const canary = path.join(dir, 'outside-canary.txt');
    const journalPath = path.join(runDir, 'journal.jsonl');
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(canary, 'CANARY\n');
    await fs.link(canary, journalPath);

    const journal = new WorkflowJournal(journalPath);
    await expect(
      journal.append({ type: 'started', key: 'v2:hardlink', agentId: '1' }),
    ).rejects.toThrow(/unsafe/i);
    expect((await journal.flush()).integrity).toBe('failed');
    await expect(fs.readFile(canary, 'utf8')).resolves.toBe('CANARY\n');
  });

  it('validates a committed prefix and ignores a later suffix', async () => {
    const journalPath = path.join(dir, 'prefix', 'journal.jsonl');
    const j = new WorkflowJournal(journalPath);
    await j.append({ type: 'started', key: 'v2:k1', agentId: '1' });
    await j.append({
      type: 'result',
      key: 'v2:k1',
      agentId: '1',
      result: 'committed',
    });
    const checkpoint = await j.flush();
    await j.append({
      type: 'result',
      key: 'v2:k1',
      agentId: '2',
      result: 'suffix',
    });

    const replay = await j.load(checkpoint);
    expect(replay.results.get('v2:k1')?.result).toBe('committed');
    expect(replay.started.get('v2:k1')).toHaveLength(1);
  });

  it('discards an uncommitted suffix before publishing the resumed checkpoint', async () => {
    const journalPath = path.join(dir, 'resume', 'journal.jsonl');
    const original = new WorkflowJournal(journalPath);
    await original.append({
      type: 'started',
      key: 'v2:k1',
      agentId: '1',
    });
    const committed = await original.flush();
    await fs.appendFile(journalPath, '{partial');

    const resumed = new WorkflowJournal(journalPath);
    const replay = await resumed.load(committed);
    expect(replay.started.get('v2:k1')).toHaveLength(1);

    const repaired = await resumed.flush();
    expect(repaired.byteLength).toBe(committed.byteLength);
    await expect(resumed.load(repaired)).resolves.toMatchObject({
      results: expect.any(Map),
      started: expect.any(Map),
    });

    await resumed.append({
      type: 'result',
      key: 'v2:k1',
      agentId: '1',
      result: 'done',
    });
    const extended = await resumed.flush();
    const extendedReplay = await resumed.load(extended);
    expect(extendedReplay.results.get('v2:k1')?.result).toBe('done');
    expect(extendedReplay.started.get('v2:k1')).toHaveLength(1);
  });

  it('returns failed integrity instead of rejecting when suffix repair is unsafe', async () => {
    const journalPath = path.join(dir, 'unsafe-repair', 'journal.jsonl');
    const original = new WorkflowJournal(journalPath);
    await original.append({ type: 'started', key: 'v2:k1', agentId: '1' });
    const committed = await original.flush();
    await original.append({
      type: 'result',
      key: 'v2:k1',
      agentId: '1',
      result: 'suffix',
    });

    const resumed = new WorkflowJournal(journalPath);
    await resumed.load(committed);
    const canary = path.join(dir, 'repair-canary.txt');
    await fs.writeFile(canary, 'CANARY\n');
    await fs.rm(journalPath);
    await fs.link(canary, journalPath);

    await expect(resumed.flush()).resolves.toMatchObject({
      integrity: 'failed',
      error: expect.stringMatching(/unsafe/i),
    });
    await expect(fs.readFile(canary, 'utf8')).resolves.toBe('CANARY\n');
  });

  it.runIf(process.platform !== 'win32')(
    'does not overwrite a journal inode replaced after its prefix is read',
    async () => {
      const journalPath = path.join(dir, 'replacement-race', 'journal.jsonl');
      const original = new WorkflowJournal(journalPath);
      await original.append({ type: 'started', key: 'v2:k1', agentId: '1' });
      const committed = await original.flush();
      await original.append({
        type: 'result',
        key: 'v2:k1',
        agentId: '1',
        result: 'old-suffix',
      });

      const resumed = new WorkflowJournal(journalPath);
      await resumed.load(committed);
      const replacement = path.join(path.dirname(journalPath), 'replacement');
      const replacementBytes = Buffer.from('REPLACEMENT\n');
      await fs.writeFile(replacement, replacementBytes);
      const realOpen = fs.open.bind(fs);
      vi.spyOn(fs, 'open').mockImplementationOnce(
        async (...args: Parameters<typeof fs.open>) => {
          const handle = await realOpen(...args);
          return {
            stat: (...statArgs: Parameters<typeof handle.stat>) =>
              handle.stat(...statArgs),
            readFile: async (
              ...readArgs: Parameters<typeof handle.readFile>
            ) => {
              const bytes = await handle.readFile(...readArgs);
              await fs.rename(replacement, journalPath);
              return bytes;
            },
            close: () => handle.close(),
          } as unknown as Awaited<ReturnType<typeof fs.open>>;
        },
      );

      await expect(resumed.flush()).resolves.toMatchObject({
        integrity: 'failed',
        error: expect.stringMatching(/changed/i),
      });
      await expect(fs.readFile(journalPath)).resolves.toEqual(replacementBytes);
    },
  );

  it('fails closed for truncated or hash-mismatched committed bytes', async () => {
    const journalPath = path.join(dir, 'corrupt', 'journal.jsonl');
    const j = new WorkflowJournal(journalPath);
    await j.append({ type: 'started', key: 'v2:k1', agentId: '1' });
    const checkpoint = await j.flush();
    const bytes = await fs.readFile(journalPath);

    await fs.writeFile(journalPath, bytes.subarray(0, bytes.byteLength - 1));
    await expect(j.load(checkpoint)).rejects.toThrow(/truncated/i);

    const changed = Buffer.from(bytes);
    changed[changed.indexOf('1')] = '2'.charCodeAt(0);
    await fs.writeFile(journalPath, changed);
    await expect(j.load(checkpoint)).rejects.toThrow(/hash/i);
  });

  it.each([
    ['invalid JSON', '{not-json}\n'],
    ['invalid entry', '{"type":"started","key":3,"agentId":"1"}\n'],
  ])('rejects %s even when its checkpoint hash matches', async (_, content) => {
    const journalPath = path.join(dir, 'invalid', 'journal.jsonl');
    await fs.mkdir(path.dirname(journalPath), { recursive: true });
    const bytes = Buffer.from(content, 'utf8');
    await fs.writeFile(journalPath, bytes);
    const checkpoint: JournalCheckpoint = {
      version: JOURNAL_FORMAT_VERSION,
      keyVersion: JOURNAL_KEY_VERSION,
      byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      integrity: 'complete',
    };

    await expect(
      new WorkflowJournal(journalPath).load(checkpoint),
    ).rejects.toThrow(/invalid/i);
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
