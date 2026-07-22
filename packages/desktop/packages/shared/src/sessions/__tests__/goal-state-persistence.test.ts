import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { GoalSnapshotV2 } from '../../protocol/dto.ts';
import { readSessionHeader, writeSessionJsonl } from '../jsonl.ts';
import { listSessions } from '../storage.ts';
import { SESSION_PERSISTENT_FIELDS, type StoredSession } from '../types.ts';
import { pickSessionFields } from '../utils.ts';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
});

describe('session persistence: Goal protocol v2', () => {
  it('preserves the authoritative snapshot for restart display', () => {
    const goalState: GoalSnapshotV2 = {
      v: 2,
      goal: {
        goalId: 'goal-1',
        revision: 3,
        objective: 'Finish every Desktop surface',
        status: 'paused',
        evidenceCursor: { recordId: 'record-3' },
        turnCount: 2,
        activeTimeMs: 8_000,
        createdAt: 1_000,
        updatedAt: 9_000,
      },
      activity: 'idle',
    };

    expect(SESSION_PERSISTENT_FIELDS).toContain('goalState');
    expect(
      pickSessionFields({
        id: 'session-1',
        workspaceRootPath: '/tmp/workspace',
        goalState,
      }),
    ).toMatchObject({ goalState });

    const workspaceRoot = join(
      tmpdir(),
      `goal-state-persistence-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const sessionId = 'session-goal';
    const sessionDirectory = join(workspaceRoot, 'sessions', sessionId);
    mkdirSync(sessionDirectory, { recursive: true });
    tempRoots.push(workspaceRoot);

    writeSessionJsonl(join(sessionDirectory, 'session.jsonl'), {
      id: sessionId,
      workspaceRootPath: workspaceRoot,
      createdAt: 1,
      lastUsedAt: 2,
      goalState,
      messages: [],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
    } satisfies StoredSession);

    expect(
      readSessionHeader(join(sessionDirectory, 'session.jsonl'))?.goalState,
    ).toEqual(goalState);
    expect(listSessions(workspaceRoot)[0]?.goalState).toEqual(goalState);
  });
});
