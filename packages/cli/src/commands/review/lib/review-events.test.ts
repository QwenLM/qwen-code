/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SPAWNED_KEY_CAP,
  cleanRoundHeadSha,
  emitReviewCleanEvent,
  pendingEventsDir,
  readPendingReviewEvents,
  readSpawnedKeys,
  recordSpawnedKey,
  removePendingEvent,
  reviewEventDedupeKey,
  reviewEventId,
  reviewEventsDir,
  type ReviewEventTarget,
} from './review-events.js';

let home: string;
let root: string;

const target: ReviewEventTarget = {
  platform: 'github',
  host: 'github.com',
  ownerRepo: 'QwenLM/qwen-code',
  number: 15846,
  headSha: 'a'.repeat(40),
};

function emit(
  overrides: Partial<Parameters<typeof emitReviewCleanEvent>[0]> = {},
) {
  return emitReviewCleanEvent({
    workspaceRoot: root,
    target,
    round: 1,
    verdict: { event: 'APPROVE', critical: 0, suggestion: 0 },
    artifactPath: '.qwen/reviews/report.json',
    sessionId: 'sess-1',
    ...overrides,
  });
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'review-events-home-')));
  root = realpathSync(mkdtempSync(join(tmpdir(), 'review-events-root-')));
  vi.stubEnv('QWEN_HOME', join(home, '.qwen'));
  vi.stubEnv('QWEN_RUNTIME_DIR', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('cleanRoundHeadSha', () => {
  const sha = 'b'.repeat(40);

  it('accepts a zero-Critical Approve or Comment whose marker carries an anchor', () => {
    expect(
      cleanRoundHeadSha({ event: 'APPROVE', critical: 0, anchorSha: sha }),
    ).toBe(sha);
    expect(
      cleanRoundHeadSha({ event: 'COMMENT', critical: 0, anchorSha: sha }),
    ).toBe(sha);
  });

  it('refuses a Request changes round even with zero counted Criticals', () => {
    expect(
      cleanRoundHeadSha({
        event: 'REQUEST_CHANGES',
        critical: 0,
        anchorSha: sha,
      }),
    ).toBeNull();
  });

  it('refuses any counted Critical', () => {
    expect(
      cleanRoundHeadSha({ event: 'APPROVE', critical: 1, anchorSha: sha }),
    ).toBeNull();
  });

  it('refuses a round whose marker withheld its anchor — the fail-closed caps', () => {
    expect(
      cleanRoundHeadSha({
        event: 'COMMENT',
        critical: 0,
        anchorSha: undefined,
      }),
    ).toBeNull();
    expect(
      cleanRoundHeadSha({ event: 'COMMENT', critical: 0, anchorSha: '  ' }),
    ).toBeNull();
  });
});

describe('the dedupe key', () => {
  it('is one verification per head, not per round', () => {
    const key = reviewEventDedupeKey(target);
    expect(key).toBe(
      `github:github.com:qwenlm/qwen-code:15846:${'a'.repeat(40)}`,
    );
    expect(reviewEventId(key)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('separates heads, numbers, repos, hosts and platforms', () => {
    const base = reviewEventDedupeKey(target);
    const variants: ReviewEventTarget[] = [
      { ...target, headSha: 'c'.repeat(40) },
      { ...target, number: 15847 },
      { ...target, ownerRepo: 'QwenLM/other' },
      { ...target, host: 'ghe.example.com' },
      { ...target, platform: 'aone' },
    ];
    for (const variant of variants) {
      expect(reviewEventDedupeKey(variant)).not.toBe(base);
    }
  });
});

describe('emitReviewCleanEvent', () => {
  it('writes outside the repository workspace, in the host-trusted state dir', () => {
    const result = emit();
    expect(result.path.startsWith(join(home, '.qwen'))).toBe(true);
    expect(result.path.startsWith(root)).toBe(false);
    expect(result.path).toBe(
      join(pendingEventsDir(root), `${result.eventId}.json`),
    );
    expect(existsSync(join(root, '.qwen'))).toBe(false);
    const written = JSON.parse(readFileSync(result.path, 'utf8'));
    expect(written).toMatchObject({
      schemaVersion: 1,
      eventId: result.eventId,
      sessionId: 'sess-1',
      round: 1,
      // Stored canonical: GitHub repository identity is case-insensitive.
      target: { ...target, ownerRepo: 'qwenlm/qwen-code' },
      verdict: { event: 'APPROVE', critical: 0, suggestion: 0 },
      artifactPath: '.qwen/reviews/report.json',
    });
    expect(typeof written.createdAt).toBe('string');
  });

  it('collapses a re-emission for the same head into one pending file', () => {
    emit({ round: 1 });
    emit({ round: 2 });
    expect(readdirSync(pendingEventsDir(root))).toHaveLength(1);
    const { events } = readPendingReviewEvents(root);
    expect(events).toHaveLength(1);
    expect(events[0]?.event.round).toBe(2);
  });

  it('queues a separate file for a different head', () => {
    emit();
    emit({ target: { ...target, headSha: 'd'.repeat(40) } });
    expect(readPendingReviewEvents(root).events).toHaveLength(2);
  });

  it('omits sessionId when the CLI exported none', () => {
    const result = emit({ sessionId: undefined });
    const written = JSON.parse(readFileSync(result.path, 'utf8'));
    expect('sessionId' in written).toBe(false);
  });
});

describe('readPendingReviewEvents', () => {
  it('reads nothing from a workspace that never reviewed', () => {
    expect(readPendingReviewEvents(root)).toEqual({
      events: [],
      unreadable: [],
    });
  });

  it('reports an unparseable or foreign file instead of throwing or deleting it', () => {
    emit();
    const dir = pendingEventsDir(root);
    writeFileSync(join(dir, 'broken.json'), '{not json');
    writeFileSync(join(dir, 'foreign.json'), '{"schemaVersion":9}');
    const { events, unreadable } = readPendingReviewEvents(root);
    expect(events).toHaveLength(1);
    expect(unreadable.map((item) => item.path).sort()).toEqual([
      join(dir, 'broken.json'),
      join(dir, 'foreign.json'),
    ]);
    expect(existsSync(join(dir, 'broken.json'))).toBe(true);
  });

  it('orders events oldest first', () => {
    emit({
      target: { ...target, headSha: 'e'.repeat(40) },
      now: () => new Date('2026-10-29T10:00:00.000Z'),
    });
    emit({
      now: () => new Date('2026-10-29T09:00:00.000Z'),
    });
    const { events } = readPendingReviewEvents(root);
    expect(events.map((item) => item.event.createdAt)).toEqual([
      '2026-10-29T09:00:00.000Z',
      '2026-10-29T10:00:00.000Z',
    ]);
  });

  it('reads an event from a provider added later — the consumer gates, not the schema', () => {
    emit({
      target: { ...target, platform: 'gitlab', host: 'gitlab.example.com' },
    });
    const { events, unreadable } = readPendingReviewEvents(root);
    expect(unreadable).toEqual([]);
    expect(events[0]?.event.target.platform).toBe('gitlab');
  });

  it('refuses coordinates that could carry a second flag into the spawned prompt', () => {
    const dir = pendingEventsDir(root);
    mkdirSync(dir, { recursive: true });
    const base = {
      schemaVersion: 1,
      eventId: 'x',
      createdAt: '2026-10-29T00:00:00.000Z',
      round: 1,
      verdict: { event: 'APPROVE', critical: 0, suggestion: 0 },
      artifactPath: '.qwen/reviews/report.json',
    };
    const planted = [
      { ...target, ownerRepo: 'a/b --repo evil/x' },
      { ...target, ownerRepo: 'a/b;rm -rf /' },
      { ...target, host: 'github.com --assets-repo evil/x' },
      { ...target, ownerRepo: 'no-slash' },
    ];
    planted.forEach((plantedTarget, i) => {
      writeFileSync(
        join(dir, `planted-${i}.json`),
        JSON.stringify({ ...base, target: plantedTarget }),
      );
    });
    const { events, unreadable } = readPendingReviewEvents(root);
    expect(events).toEqual([]);
    expect(unreadable).toHaveLength(planted.length);
  });
});

describe('the spawned ledger', () => {
  it('reads as empty before the first spawn', () => {
    expect(readSpawnedKeys(root).size).toBe(0);
  });

  it('records a key and reads it back', () => {
    const key = reviewEventDedupeKey(target);
    recordSpawnedKey(
      root,
      key,
      'sess-1',
      () => new Date('2026-10-29T00:00:00Z'),
    );
    expect(readSpawnedKeys(root).has(key)).toBe(true);
    const ledger = JSON.parse(
      readFileSync(join(reviewEventsDir(root), 'spawned.json'), 'utf8'),
    );
    expect(ledger.entries[0]).toEqual({
      key,
      at: '2026-10-29T00:00:00.000Z',
      sessionId: 'sess-1',
    });
  });

  it('does not duplicate a re-recorded key', () => {
    const key = reviewEventDedupeKey(target);
    recordSpawnedKey(root, key);
    recordSpawnedKey(root, key);
    expect(readSpawnedKeys(root).size).toBe(1);
  });

  it('evicts the oldest keys past the cap', () => {
    for (let i = 0; i < SPAWNED_KEY_CAP + 5; i++) {
      recordSpawnedKey(root, `key-${i}`);
    }
    const keys = readSpawnedKeys(root);
    expect(keys.size).toBe(SPAWNED_KEY_CAP);
    expect(keys.has('key-0')).toBe(false);
    expect(keys.has(`key-${SPAWNED_KEY_CAP + 4}`)).toBe(true);
  });

  it('refuses to read a corrupt ledger — it cannot prove a head was not verified', () => {
    mkdirSync(reviewEventsDir(root), { recursive: true });
    writeFileSync(join(reviewEventsDir(root), 'spawned.json'), '{"v":2}');
    expect(() => readSpawnedKeys(root)).toThrow(/v1 ledger/);
  });

  it('starts a fresh ledger when recording over a corrupt one', () => {
    mkdirSync(reviewEventsDir(root), { recursive: true });
    writeFileSync(join(reviewEventsDir(root), 'spawned.json'), 'garbage');
    recordSpawnedKey(root, 'key-1');
    expect([...readSpawnedKeys(root)]).toEqual(['key-1']);
  });
});

describe('removePendingEvent', () => {
  it('drops the file and tolerates a second removal', () => {
    const result = emit();
    removePendingEvent(result.path);
    expect(existsSync(result.path)).toBe(false);
    expect(() => removePendingEvent(result.path)).not.toThrow();
  });
});

describe('canonical identities (one head, one verification)', () => {
  const sha = 'a'.repeat(40);

  it('collapses repository casing across producers into one pending file', () => {
    emit({
      target: { ...target, ownerRepo: 'QwenLM/qwen-code', headSha: sha },
    });
    emit({
      target: { ...target, ownerRepo: 'qwenlm/qwen-code', headSha: sha },
    });
    const { events } = readPendingReviewEvents(root);
    expect(events).toHaveLength(1);
    expect(events[0]?.event.target.ownerRepo).toBe('qwenlm/qwen-code');
  });

  it('collapses host casing too', () => {
    emit({ target: { ...target, host: 'GitHub.com', headSha: sha } });
    emit({ target: { ...target, host: 'github.com', headSha: sha } });
    expect(readPendingReviewEvents(root).events).toHaveLength(1);
  });

  it('keeps a case-sensitive platform’s repository spelling', () => {
    emit({
      target: {
        ...target,
        platform: 'aone',
        host: 'code.alibaba-inc.com',
        ownerRepo: 'Group/Project',
        headSha: sha,
      },
    });
    expect(
      readPendingReviewEvents(root).events[0]?.event.target.ownerRepo,
    ).toBe('Group/Project');
  });

  it('refuses an abbreviated anchor in the internal predicate', () => {
    expect(
      cleanRoundHeadSha({
        event: 'APPROVE',
        critical: 0,
        anchorSha: 'abc1234',
      }),
    ).toBeNull();
    expect(
      cleanRoundHeadSha({ event: 'APPROVE', critical: 0, anchorSha: sha }),
    ).toBe(sha);
  });

  it('refuses a record carrying an abbreviated head', () => {
    const dir = pendingEventsDir(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'short.json'),
      JSON.stringify({
        schemaVersion: 1,
        eventId: 'short',
        createdAt: '2026-10-30T00:00:00.000Z',
        sessionId: 's',
        target: { ...target, headSha: 'abc1234' },
        round: 1,
        verdict: { event: 'APPROVE', critical: 0, suggestion: 0 },
      }),
    );
    const { events, unreadable } = readPendingReviewEvents(root);
    expect(events).toEqual([]);
    expect(unreadable).toHaveLength(1);
  });
});
