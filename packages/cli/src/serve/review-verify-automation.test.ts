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
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  emitReviewCleanEvent,
  pendingEventsDir,
  readPendingReviewEvents,
  readSpawnedKeys,
  reviewEventDedupeKey,
  reviewEventsDir,
  type ReviewCleanEventV1,
  type ReviewEventTarget,
} from '../commands/review/lib/review-events.js';
import {
  reviewVerifyDecision,
  startReviewVerifyAutomation,
  type ReviewVerifyAutomation,
  type ReviewVerifyBridge,
} from './review-verify-automation.js';

let home: string;
let root: string;
let automation: ReviewVerifyAutomation | undefined;
let launch: ReturnType<typeof vi.fn>;
let notices: string[];

const target: ReviewEventTarget = {
  platform: 'github',
  host: 'github.com',
  ownerRepo: 'QwenLM/qwen-code',
  number: 15846,
  headSha: 'a'.repeat(40),
};

const skillRelative = join('.qwen', 'skills', 'verify-pr', 'SKILL.md');

function installSkill(): void {
  const path = join(root, skillRelative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '---\nname: verify-pr\n---\n');
}

function emit(
  overrides: {
    target?: Partial<ReviewEventTarget>;
    sessionId?: string;
    round?: number;
  } = {},
): string {
  const result = emitReviewCleanEvent({
    workspaceRoot: root,
    target: { ...target, ...overrides.target },
    round: overrides.round ?? 1,
    verdict: { event: 'APPROVE', critical: 0, suggestion: 0 },
    artifactPath: '.qwen/reviews/report.json',
    sessionId: overrides.sessionId ?? 'sess-1',
  });
  return result.path;
}

/** A bridge stub for the parentless path: records every call, resolves the
 *  spawn, and lets a test decide whether the prompt dispatch settles. */
function stubBridge(opts: { dispatch?: Promise<unknown> } = {}) {
  const calls = {
    spawn: [] as Array<Record<string, unknown>>,
    named: [] as Array<{ sessionId: string; displayName?: string }>,
    prompts: [] as Array<{ sessionId: string; text: string }>,
  };
  const bridge: ReviewVerifyBridge = {
    spawnOrAttach: async (req) => {
      calls.spawn.push({ ...req });
      return { sessionId: 'top-1' } as unknown as Awaited<
        ReturnType<ReviewVerifyBridge['spawnOrAttach']>
      >;
    },
    updateSessionMetadata: (sessionId, meta) => {
      calls.named.push({ sessionId, displayName: meta.displayName });
      return meta;
    },
    sendPrompt: (sessionId, req) => {
      const first = req.prompt[0] as { text?: string } | undefined;
      calls.prompts.push({ sessionId, text: first?.text ?? '' });
      return (opts.dispatch ??
        Promise.resolve({ stopReason: 'end_turn' })) as unknown as ReturnType<
        ReviewVerifyBridge['sendPrompt']
      >;
    },
  };
  return { bridge, calls };
}

function start(
  opts: { enabled?: boolean; bridge?: ReviewVerifyBridge } = {},
): ReviewVerifyAutomation {
  launch = vi.fn(async () => ({ sessionId: 'child-1' }));
  notices = [];
  automation = startReviewVerifyAutomation({
    boundWorkspace: root,
    launch,
    ...(opts.bridge ? { getBridge: () => opts.bridge } : {}),
    // Long enough that only the explicit tick() runs during a test; the watch
    // is exercised by writing before start, so it has nothing to deliver.
    intervalMs: 600_000,
    isEnabled: () => opts.enabled ?? true,
    onNotice: (message) => notices.push(message),
  });
  return automation;
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'review-verify-home-')));
  root = realpathSync(mkdtempSync(join(tmpdir(), 'review-verify-root-')));
  vi.stubEnv('QWEN_HOME', join(home, '.qwen'));
  vi.stubEnv('QWEN_RUNTIME_DIR', '');
});

afterEach(() => {
  automation?.stop();
  automation = undefined;
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('reviewVerifyDecision', () => {
  const event = {
    schemaVersion: 1,
    eventId: 'x',
    createdAt: '2026-10-29T00:00:00.000Z',
    sessionId: 'sess-1',
    target,
    round: 1,
    verdict: { event: 'APPROVE', critical: 0, suggestion: 0 },
    artifactPath: '.qwen/reviews/report.json',
  } satisfies ReviewCleanEventV1;
  const facts = {
    enabled: true,
    skillAvailable: true,
    spawnedKeys: new Set<string>(),
    canSpawnTopLevel: true,
  };

  it('builds the maintainer-round prompt for an accepted event', () => {
    const decision = reviewVerifyDecision(event, facts);
    expect(decision).toMatchObject({
      action: 'spawn',
      prompt: '/verify-pr 15846 --publish --repo QwenLM/qwen-code',
      callerSessionId: 'sess-1',
    });
  });

  it('declines each gate with its own reason', () => {
    const cases: Array<[string, Partial<typeof facts>, ReviewCleanEventV1]> = [
      ['disabled', { enabled: false }, event],
      [
        'unsupported-platform',
        {},
        { ...event, target: { ...target, platform: 'aone' } },
      ],
      [
        'unsupported-platform',
        {},
        { ...event, target: { ...target, host: 'ghe.example.com' } },
      ],
      ['skill-unavailable', { skillAvailable: false }, event],
      [
        'no-session',
        { canSpawnTopLevel: false },
        { ...event, sessionId: undefined },
      ],
      [
        'already-verified',
        { spawnedKeys: new Set([reviewEventDedupeKey(target)]) },
        event,
      ],
    ];
    for (const [reason, override, subject] of cases) {
      expect(
        reviewVerifyDecision(subject, { ...facts, ...override }),
      ).toMatchObject({ action: 'decline', reason });
    }
  });

  it('accepts a sessionless event when a parentless spawn path exists', () => {
    const decision = reviewVerifyDecision(
      { ...event, sessionId: undefined },
      facts,
    );
    expect(decision.action).toBe('spawn');
    expect(decision).not.toHaveProperty('callerSessionId');
  });
});

describe('startReviewVerifyAutomation', () => {
  it('spawns one sub-session and clears the pending event', async () => {
    installSkill();
    const path = emit();
    await start().tick();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith({
      prompt: '/verify-pr 15846 --publish --repo QwenLM/qwen-code',
      completion: 'sent',
      callerSessionId: 'sess-1',
      name: 'verify PR #15846',
    });
    expect(existsSync(path)).toBe(false);
    expect(readSpawnedKeys(root).has(reviewEventDedupeKey(target))).toBe(true);
    expect(notices.join('\n')).toContain('spawned child-1');
  });

  it('records the head BEFORE spawning, so a crash cannot replay a published round', async () => {
    installSkill();
    emit();
    const key = reviewEventDedupeKey(target);
    launch = vi.fn(async () => {
      // The write-ahead record must already be durable at spawn time.
      expect(readSpawnedKeys(root).has(key)).toBe(true);
      return { sessionId: 'child-1' };
    });
    notices = [];
    automation = startReviewVerifyAutomation({
      boundWorkspace: root,
      launch,
      intervalMs: 600_000,
      isEnabled: () => true,
      onNotice: (message) => notices.push(message),
    });
    await automation.tick();
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('does not retry a failed spawn, and keeps the head recorded', async () => {
    installSkill();
    const path = emit();
    launch = vi.fn(async () => {
      throw new Error('Too many concurrent sub-sessions');
    });
    notices = [];
    automation = startReviewVerifyAutomation({
      boundWorkspace: root,
      launch,
      intervalMs: 600_000,
      isEnabled: () => true,
      onNotice: (message) => notices.push(message),
    });
    await automation.tick();
    expect(existsSync(path)).toBe(false);
    expect(readSpawnedKeys(root).has(reviewEventDedupeKey(target))).toBe(true);
    expect(notices.join('\n')).toContain('not retried');
    await automation.tick();
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('verifies one head once across rounds', async () => {
    installSkill();
    emit({ round: 1 });
    await start().tick();
    expect(launch).toHaveBeenCalledTimes(1);
    // A later clean round at the same head writes a new pending event.
    emit({ round: 2 });
    await automation?.tick();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(notices.join('\n')).toContain('already-verified');
    expect(readPendingReviewEvents(root).events).toHaveLength(0);
  });

  it('declines and drops events it cannot act on', async () => {
    installSkill();
    const path = emit({
      target: { platform: 'aone', host: 'code.alibaba-inc.com' },
    });
    await start().tick();
    expect(launch).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
    expect(notices.join('\n')).toContain('unsupported-platform');
  });

  it('declines when the operator turned the automation off', async () => {
    installSkill();
    const path = emit();
    await start({ enabled: false }).tick();
    expect(launch).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
    expect(notices.join('\n')).toContain('disabled');
  });

  it('declines when the workspace has no verify-pr skill', async () => {
    const path = emit();
    await start().tick();
    expect(launch).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
    expect(notices.join('\n')).toContain('skill-unavailable');
  });

  it('declines a sessionless event when no parentless path is wired', async () => {
    installSkill();
    const { path } = emitReviewCleanEvent({
      workspaceRoot: root,
      target,
      round: 1,
      verdict: { event: 'APPROVE', critical: 0, suggestion: 0 },
    });
    await start().tick();
    expect(launch).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
    expect(notices.join('\n')).toContain('no-session');
  });

  it('spawns a TOP-LEVEL session for a review another agent performed', async () => {
    installSkill();
    const { path } = emitReviewCleanEvent({
      workspaceRoot: root,
      target,
      round: 1,
      verdict: { event: 'APPROVE', critical: 0, suggestion: 0 },
      reviewedBy: 'codex',
    });
    const { bridge, calls } = stubBridge();
    await start({ bridge }).tick();
    // Not a sub-session: there is no qwen-code session to be the parent.
    expect(launch).not.toHaveBeenCalled();
    expect(calls.spawn).toEqual([
      { workspaceCwd: root, sessionScope: 'thread' },
    ]);
    expect(calls.prompts).toEqual([
      {
        sessionId: 'top-1',
        text: '/verify-pr 15846 --publish --repo QwenLM/qwen-code',
      },
    ]);
    expect(calls.named).toEqual([
      { sessionId: 'top-1', displayName: 'verify PR #15846' },
    ]);
    expect(existsSync(path)).toBe(false);
    expect(readSpawnedKeys(root).has(reviewEventDedupeKey(target))).toBe(true);
    expect(notices.join('\n')).toContain('spawned top-1');
    expect(notices.join('\n')).toContain('reviewed by codex');
  });

  it('verifies a sessionless head once, like any other', async () => {
    installSkill();
    const { bridge, calls } = stubBridge();
    const emitExternal = () =>
      emitReviewCleanEvent({
        workspaceRoot: root,
        target,
        round: 1,
        verdict: { event: 'APPROVE', critical: 0, suggestion: 0 },
        reviewedBy: 'codex',
      });
    emitExternal();
    await start({ bridge }).tick();
    emitExternal();
    await automation?.tick();
    expect(calls.spawn).toHaveLength(1);
    expect(notices.join('\n')).toContain('already-verified');
  });

  it('surfaces a prompt dispatch failure without losing the spawned session', async () => {
    installSkill();
    emitReviewCleanEvent({
      workspaceRoot: root,
      target,
      round: 1,
      verdict: { event: 'APPROVE', critical: 0, suggestion: 0 },
      reviewedBy: 'codex',
    });
    const { bridge, calls } = stubBridge({
      dispatch: Promise.reject(new Error('admission refused')),
    });
    await start({ bridge }).tick();
    expect(calls.spawn).toHaveLength(1);
    await vi.waitFor(() =>
      expect(notices.join('\n')).toContain('prompt dispatch failed'),
    );
    expect(notices.join('\n')).toContain('admission refused');
  });

  it('leaves events pending when the spawned ledger cannot be read', async () => {
    installSkill();
    const path = emit();
    mkdirSync(reviewEventsDir(root), { recursive: true });
    writeFileSync(join(reviewEventsDir(root), 'spawned.json'), '{"v":99}');
    await start().tick();
    expect(launch).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(true);
    expect(notices.join('\n')).toContain('cannot read the spawned ledger');
  });

  it('reports an unreadable event once, keeps it, and still processes the rest', async () => {
    installSkill();
    const broken = join(pendingEventsDir(root), 'broken.json');
    emit();
    writeFileSync(broken, '{not json');
    await start().tick();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(existsSync(broken)).toBe(true);
    expect(
      notices.filter((line) => line.includes('unreadable event')).length,
    ).toBe(1);
    await automation?.tick();
    expect(
      notices.filter((line) => line.includes('unreadable event')).length,
    ).toBe(1);
  });

  it('never spawns from an event whose coordinates could carry a second flag', async () => {
    installSkill();
    const dir = pendingEventsDir(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'planted.json'),
      JSON.stringify({
        schemaVersion: 1,
        eventId: 'planted',
        createdAt: '2026-10-29T00:00:00.000Z',
        sessionId: 'sess-1',
        target: { ...target, ownerRepo: 'a/b --repo evil/x' },
        round: 1,
        verdict: { event: 'APPROVE', critical: 0, suggestion: 0 },
        artifactPath: '.qwen/reviews/report.json',
      }),
    );
    await start().tick();
    expect(launch).not.toHaveBeenCalled();
    expect(notices.join('\n')).toContain('unreadable event');
  });

  it('reads no settings and touches no ledger while nothing is pending', async () => {
    const isEnabled = vi.fn(() => true);
    notices = [];
    launch = vi.fn(async () => ({ sessionId: 'child-1' }));
    automation = startReviewVerifyAutomation({
      boundWorkspace: root,
      launch,
      intervalMs: 600_000,
      isEnabled,
      onNotice: (message) => notices.push(message),
    });
    await automation.tick();
    expect(isEnabled).not.toHaveBeenCalled();
    expect(existsSync(join(reviewEventsDir(root), 'spawned.json'))).toBe(false);
    expect(notices).toEqual([]);
  });

  it('stops idempotently and reports no active work when idle', async () => {
    installSkill();
    const started = start();
    expect(started.activeWork).toBe(false);
    started.stop();
    expect(() => started.stop()).not.toThrow();
    expect(started.activeWork).toBe(false);
  });

  it('reads the ledger the producer wrote, not one inside the repository', async () => {
    installSkill();
    emit();
    await start().tick();
    const ledger = join(reviewEventsDir(root), 'spawned.json');
    expect(ledger.startsWith(join(home, '.qwen'))).toBe(true);
    expect(JSON.parse(readFileSync(ledger, 'utf8')).entries).toHaveLength(1);
    expect(existsSync(join(root, 'verify-events'))).toBe(false);
  });
});
