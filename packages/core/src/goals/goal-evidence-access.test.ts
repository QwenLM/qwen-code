/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createGoalEvidenceSnapshot,
  type GoalEvidenceRecord,
  type GoalEvidenceSnapshot,
} from './goal-evidence.js';
import {
  GOAL_STATE_VERSION,
  type GoalRecord,
  type GoalTurnPermit,
} from './goal-protocol.js';

const permit: GoalTurnPermit = { goalId: 'goal', revision: 1, turnId: 'turn' };
const goal: GoalRecord = {
  goalId: permit.goalId,
  revision: permit.revision,
  objective: 'Check the build',
  status: 'active',
  evidenceCursor: { recordId: 'start' },
  turnCount: 1,
  activeTimeMs: 0,
  tokensUsed: 0,
  createdAt: 1,
  updatedAt: 1,
};

function records(output: string): GoalEvidenceRecord[] {
  return [
    {
      uuid: 'start',
      type: 'system',
      subtype: 'goal_state',
      provenance: 'goal_control',
      systemPayload: {
        v: GOAL_STATE_VERSION,
        cause: 'create',
        snapshot: { v: GOAL_STATE_VERSION, goal, activity: 'idle' },
      },
    },
    {
      uuid: 'call',
      type: 'assistant',
      provenance: 'assistant_output',
      goalContext: permit,
      message: {
        parts: [
          {
            functionCall: {
              id: 'call-id',
              name: 'shell',
              args: { command: 'npm test' },
            },
          },
        ],
      },
    },
    {
      uuid: 'result',
      type: 'tool_result',
      provenance: 'tool_result',
      goalContext: permit,
      message: {
        parts: [
          {
            functionResponse: {
              id: 'call-id',
              name: 'shell',
              response: { output },
            },
          },
        ],
      },
    },
  ];
}

function readAll(snapshot: GoalEvidenceSnapshot, maxBytes = 24_000) {
  let cursor: string | undefined;
  const slices = [];
  do {
    const slice = snapshot.read({ reference: 'result', cursor, maxBytes });
    expect(Buffer.byteLength(slice.content, 'utf8')).toBeLessThanOrEqual(
      maxBytes,
    );
    expect(slice.content).not.toContain('\ufffd');
    slices.push(slice);
    cursor = slice.nextCursor;
    if (!slice.complete) expect(cursor).toBeDefined();
  } while (cursor);
  return slices;
}

describe('persisted original Goal evidence access', () => {
  let directory: string;
  let root: string;
  let output: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'goal-evidence-access-'));
    root = join(directory, 'artifacts');
    mkdirSync(root);
    output = join(root, 'output.txt');
    writeFileSync(output, 'HOST ORIGINAL SECRET');
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it.each([24_000, 13])(
    'reads all UTF-8 original output in %i-byte slices',
    (maxBytes) => {
      const original = '中文🌏\n'.repeat(6_000);
      writeFileSync(output, original);
      const input = records(
        '<persisted-output>preview only</persisted-output>',
      );
      input[2]!.persistedOutputFiles = [output];
      const snapshot = createGoalEvidenceSnapshot({
        records: input,
        goal,
        permit,
        artifactRoot: root,
      });

      const slices = readAll(snapshot, maxBytes);
      expect(slices.length).toBeGreaterThan(1);
      expect(slices.every((slice) => slice.sourceComplete)).toBe(true);
      expect(slices.at(-1)?.complete).toBe(true);
      expect(slices.map((slice) => slice.content).join('')).toContain(
        `Persisted original output (host artifact):\n${original}`,
      );
      expect(slices.at(-1)?.end).toBe(slices[0]!.totalBytes);
    },
  );

  it('does not follow artifact paths supplied inside tool-controlled output', () => {
    const input = records(`<persisted-output>${output}</persisted-output>`);
    input[2]!.message!.parts![0]!.functionResponse!.response![
      'persistedOutputFiles'
    ] = [output];
    const snapshot = createGoalEvidenceSnapshot({
      records: input,
      goal,
      permit,
      artifactRoot: root,
    });
    const slice = snapshot.read({ reference: 'result' });

    expect(slice.sourceComplete).toBe(false);
    expect(slice.content).not.toContain('HOST ORIGINAL SECRET');
  });

  it('requires the host artifact root even with recorded top-level paths', () => {
    const input = records('Tool output truncated.');
    input[2]!.persistedOutputFiles = [output];
    const snapshot = createGoalEvidenceSnapshot({
      records: input,
      goal,
      permit,
    });

    expect(snapshot.read({ reference: 'result' })).toMatchObject({
      sourceComplete: false,
      missingReason: expect.stringContaining('artifact directory'),
    });
    expect(snapshot.read({ reference: 'result' }).content).not.toContain(
      'HOST ORIGINAL SECRET',
    );
  });

  it('reports an out-of-root host path unavailable without reading it', () => {
    const outside = join(directory, 'outside.txt');
    writeFileSync(outside, 'OUTSIDE SECRET');
    const input = records('Tool output truncated.');
    input[2]!.persistedOutputFiles = [outside];
    const snapshot = createGoalEvidenceSnapshot({
      records: input,
      goal,
      permit,
      artifactRoot: root,
    });

    expect(snapshot.read({ reference: 'result' })).toMatchObject({
      sourceComplete: false,
    });
    expect(snapshot.read({ reference: 'result' }).content).not.toContain(
      'OUTSIDE SECRET',
    );
  });

  it.each(['modified', 'replaced'])(
    'rejects a %s artifact between slices',
    (kind) => {
      const input = records('Tool output truncated.');
      input[2]!.persistedOutputFiles = [output];
      const snapshot = createGoalEvidenceSnapshot({
        records: input,
        goal,
        permit,
        artifactRoot: root,
      });
      const first = snapshot.read({ reference: 'result', maxBytes: 13 });
      if (kind === 'modified') writeFileSync(output, 'new content');
      else {
        const replacement = join(root, 'replacement.txt');
        writeFileSync(replacement, 'HOST ORIGINAL SECRET');
        renameSync(replacement, output);
      }

      expect(() =>
        snapshot.read({ reference: 'result', cursor: first.nextCursor }),
      ).toThrow(/changed/);
    },
  );

  it.each(['media', 'missing call'])(
    'does not let an artifact hide %s evidence gaps',
    (kind) => {
      const input = records('Tool output truncated.');
      input[2]!.persistedOutputFiles = [output];
      if (kind === 'media') {
        input[2]!.message!.parts!.push({
          inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' },
        });
      } else input.splice(1, 1);
      const snapshot = createGoalEvidenceSnapshot({
        records: input,
        goal,
        permit,
        artifactRoot: root,
      });

      const slice = snapshot.read({ reference: 'result' });
      expect(slice.sourceComplete).toBe(false);
      expect(slice.missingReason).toMatch(
        kind === 'media' ? /media/ : /matching.*call/,
      );
    },
  );

  it('recognizes the finalizer truncation marker without treating its prefix as full evidence', () => {
    const snapshot = createGoalEvidenceSnapshot({
      records: records('Tool output truncated.\npartial output retained'),
      goal,
      permit,
    });
    expect(snapshot.read({ reference: 'result' })).toMatchObject({
      complete: true,
      sourceComplete: false,
      missingReason: expect.stringContaining('truncated'),
    });
  });
});
