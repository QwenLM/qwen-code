/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ChatRecord } from '../services/chatRecordingService.js';
import { inspectConversationBranches } from './conversation-branches.js';
import { buildOrderedUuidChain } from './conversation-chain.js';

function record(
  uuid: string,
  parentUuid: string | null,
  overrides: Partial<ChatRecord> = {},
): ChatRecord {
  return {
    uuid,
    parentUuid,
    sessionId: 'session',
    timestamp: `2026-01-01T00:00:${uuid.length.toString().padStart(2, '0')}.000Z`,
    type: 'user',
    message: { role: 'user', parts: [{ text: uuid }] },
    cwd: '/workspace',
    version: '0.0.0',
    ...overrides,
  };
}

function assistant(
  uuid: string,
  parentUuid: string | null,
  text = uuid,
): ChatRecord {
  return record(uuid, parentUuid, {
    type: 'assistant',
    message: { role: 'model', parts: [{ text }] },
  });
}

function system(
  uuid: string,
  parentUuid: string | null,
  subtype: NonNullable<ChatRecord['subtype']>,
): ChatRecord {
  return record(uuid, parentUuid, {
    type: 'system',
    subtype,
    message: undefined,
  });
}

describe('inspectConversationBranches', () => {
  it('returns no branches or diagnostics for an empty transcript', () => {
    expect(inspectConversationBranches([])).toEqual({
      branches: [],
      diagnostics: [],
    });
  });

  it('identifies ordinary sibling branches and summarizes their divergence', () => {
    const records = [
      record('root-user', null, {
        message: { role: 'user', parts: [{ text: 'shared request' }] },
      }),
      assistant('shared-answer', 'root-user', 'shared answer'),
      record('left-user', 'shared-answer', {
        message: { role: 'user', parts: [{ text: 'take the left path' }] },
      }),
      assistant('left-leaf', 'left-user', 'left result'),
      record('right-user', 'shared-answer', {
        message: { role: 'user', parts: [{ text: 'take the right path' }] },
      }),
      assistant('right-leaf', 'right-user', 'right result'),
    ];

    const analysis = inspectConversationBranches(records);

    expect(analysis.diagnostics).toEqual([]);
    expect(analysis.branches.map((branch) => branch.leafUuid)).toEqual([
      'left-leaf',
      'right-leaf',
    ]);
    expect(analysis.branches[0]).toMatchObject({
      branchPointUuid: 'shared-answer',
      classification: 'ordinary',
      firstUserTextAfterBranchPoint: 'take the left path',
      lastUserText: 'take the left path',
      lastAssistantText: 'left result',
      recordCounts: { user: 2, assistant: 2, toolResult: 0, system: 0 },
    });
    expect(analysis.branches[1]).toMatchObject({
      branchPointUuid: 'shared-answer',
      firstUserTextAfterBranchPoint: 'take the right path',
      lastAssistantText: 'right result',
    });
  });

  it('summarizes a single linear branch without a branch point', () => {
    const records = [
      record('root-user', null, {
        message: { role: 'user', parts: [{ text: 'only request' }] },
      }),
      assistant('only-answer', 'root-user', 'only answer'),
    ];

    expect(inspectConversationBranches(records).branches).toEqual([
      expect.objectContaining({
        leafUuid: 'only-answer',
        branchPointUuid: null,
        firstUserTextAfterBranchPoint: 'only request',
      }),
    ]);
  });

  it('counts tool results in a branch chain', () => {
    const records = [
      record('root-user', null),
      assistant('tool-call', 'root-user'),
      record('tool-result', 'tool-call', { type: 'tool_result' }),
    ];

    expect(inspectConversationBranches(records).branches[0]).toMatchObject({
      recordCounts: { user: 1, assistant: 1, toolResult: 1, system: 0 },
    });
  });

  it('uses the nearest branch point for nested forks', () => {
    const records = [
      record('root', null),
      assistant('outer-leaf', 'root'),
      record('nested-root', 'root'),
      assistant('nested-left', 'nested-root'),
      assistant('nested-right', 'nested-root'),
    ];

    const analysis = inspectConversationBranches(records);
    expect(
      analysis.branches.map((branch) => [
        branch.leafUuid,
        branch.branchPointUuid,
      ]),
    ).toEqual([
      ['outer-leaf', 'root'],
      ['nested-left', 'nested-root'],
      ['nested-right', 'nested-root'],
    ]);
  });

  it('collapses and deduplicates neutral terminal metadata', () => {
    const records = [
      record('conversation-leaf', null),
      system('title', 'conversation-leaf', 'custom_title'),
      system('artifact-event', 'conversation-leaf', 'session_artifact_event'),
      system(
        'artifact-snapshot',
        'conversation-leaf',
        'session_artifact_snapshot',
      ),
    ];

    expect(
      inspectConversationBranches(records).branches.map(
        (branch) => branch.leafUuid,
      ),
    ).toEqual(['conversation-leaf']);
  });

  it('drops neutral-only branches without a conversation ancestor', () => {
    const subtypes = [
      'custom_title',
      'session_artifact_event',
      'session_artifact_snapshot',
    ] as const;

    for (const subtype of subtypes) {
      const records = [system('metadata-root', null, subtype)];
      expect(inspectConversationBranches(records)).toEqual({
        branches: [],
        diagnostics: [],
      });
    }
  });

  it('uses the last collapsed physical leaf timestamp as updatedAt', () => {
    const records = [
      record('conversation-leaf', null),
      system('title', 'conversation-leaf', 'custom_title'),
      system('artifact', 'conversation-leaf', 'session_artifact_event'),
    ];
    records[0]!.timestamp = '2026-01-01T00:00:01.000Z';
    records[1]!.timestamp = '2026-01-01T00:00:02.000Z';
    records[2]!.timestamp = '2026-01-01T00:00:03.000Z';

    expect(inspectConversationBranches(records).branches[0]).toMatchObject({
      leafUuid: 'conversation-leaf',
      updatedAt: '2026-01-01T00:00:03.000Z',
    });
  });

  it('removes a collapsed ancestor when a real descendant leaf exists', () => {
    const records = [
      record('root', null),
      system('title', 'root', 'custom_title'),
      system('artifact', 'root', 'session_artifact_event'),
      assistant('real-leaf', 'root'),
    ];

    expect(
      inspectConversationBranches(records).branches.map(
        (branch) => branch.leafUuid,
      ),
    ).toEqual(['real-leaf']);
  });

  it('collapses a neutral chain but preserves significant system terminals', () => {
    const records = [
      record('root', null),
      system('title-1', 'root', 'custom_title'),
      system('title-2', 'title-1', 'custom_title'),
      system('compression', 'root', 'chat_compression'),
      system('slash', 'root', 'slash_command'),
      system('attribution', 'root', 'attribution_snapshot'),
      system('file-history', 'root', 'file_history_snapshot'),
    ];

    expect(
      inspectConversationBranches(records).branches.map(
        (branch) => branch.leafUuid,
      ),
    ).toEqual(['compression', 'slash', 'attribution', 'file-history']);
  });

  it('classifies rewind descendants and siblings without discarding either', () => {
    const records = [
      record('shared', null),
      record('old-user', 'shared'),
      assistant('old-leaf', 'old-user'),
      system('rewind', 'shared', 'rewind'),
      record('new-user', 'rewind'),
      assistant('new-leaf', 'new-user'),
    ];

    const analysis = inspectConversationBranches(records);
    const oldBranch = analysis.branches.find(
      (branch) => branch.leafUuid === 'old-leaf',
    );
    const newBranch = analysis.branches.find(
      (branch) => branch.leafUuid === 'new-leaf',
    );

    expect(oldBranch).toMatchObject({
      classification: 'rewind-sibling',
      containsRewindUuids: [],
      siblingRewindUuids: ['rewind'],
    });
    expect(newBranch).toMatchObject({
      classification: 'rewind-descendant',
      containsRewindUuids: ['rewind'],
      siblingRewindUuids: [],
    });
  });

  it('reports mixed rewind relationships across nested forks', () => {
    const records = [
      record('root', null),
      system('first-rewind', 'root', 'rewind'),
      assistant('first-leaf', 'first-rewind'),
      record('other-path', 'root'),
      system('second-rewind', 'other-path', 'rewind'),
      assistant('mixed-leaf', 'second-rewind'),
    ];

    const mixed = inspectConversationBranches(records).branches.find(
      (branch) => branch.leafUuid === 'mixed-leaf',
    );
    expect(mixed).toMatchObject({
      classification: 'mixed-rewind',
      containsRewindUuids: ['second-rewind'],
      siblingRewindUuids: ['first-rewind'],
    });
  });

  it('does not classify a rewind from another root as a sibling', () => {
    const records = [
      record('first-root', null),
      assistant('first-leaf', 'first-root'),
      record('second-root', null),
      system('unrelated-rewind', 'second-root', 'rewind'),
      assistant('second-leaf', 'unrelated-rewind'),
    ];

    const firstBranch = inspectConversationBranches(records).branches.find(
      (branch) => branch.leafUuid === 'first-leaf',
    );
    expect(firstBranch).toMatchObject({
      classification: 'ordinary',
      containsRewindUuids: [],
      siblingRewindUuids: [],
    });
  });

  it('detects missing parents, cycles, and conflicting duplicate parents', () => {
    const records = [
      record('orphan', 'missing'),
      record('cycle-a', 'cycle-b'),
      record('cycle-b', 'cycle-a'),
      record('duplicate', null),
      record('other-root', null),
      record('duplicate', 'other-root'),
    ];

    const analysis = inspectConversationBranches(records);

    expect(analysis.branches.map((branch) => branch.leafUuid)).toEqual([
      'orphan',
      'duplicate',
      'other-root',
    ]);
    expect(analysis.diagnostics).toEqual([
      {
        kind: 'missing-parent',
        childUuid: 'orphan',
        missingParentUuid: 'missing',
      },
      {
        kind: 'conflicting-parent',
        uuid: 'duplicate',
        parentUuids: [null, 'other-root'],
      },
      { kind: 'parent-cycle', uuids: ['cycle-a', 'cycle-b'] },
    ]);
    expect(
      buildOrderedUuidChain(records, {
        leafUuid: 'orphan',
        detectGaps: true,
      }),
    ).toEqual({
      uuids: ['orphan'],
      gaps: [{ childUuid: 'orphan', missingParentUuid: 'missing' }],
    });
  });

  it('does not mix roles when duplicate UUID records have different types', () => {
    const records = [
      record('duplicate', null, {
        message: { role: 'user', parts: [{ text: 'user text' }] },
      }),
      assistant('duplicate', null, 'assistant text'),
    ];

    const [branch] = inspectConversationBranches(records).branches;
    expect(branch).toMatchObject({
      lastUserText: 'user text',
      recordCounts: { user: 1, assistant: 0, toolResult: 0, system: 0 },
    });
    expect(branch?.lastAssistantText).toBeUndefined();
  });

  it('filters synthetic prompts and thoughts and truncates summary text', () => {
    const longText = 'x'.repeat(220);
    const records = [
      record('real-user', null, {
        message: { role: 'user', parts: [{ text: '  real\n request  ' }] },
      }),
      record('notification', 'real-user', {
        subtype: 'notification',
        message: { role: 'user', parts: [{ text: 'synthetic prompt' }] },
      }),
      record('cron', 'notification', {
        subtype: 'cron',
        message: { role: 'user', parts: [{ text: 'cron prompt' }] },
      }),
      record('mid-turn', 'cron', {
        subtype: 'mid_turn_user_message',
        message: { role: 'user', parts: [{ text: 'mid-turn prompt' }] },
      }),
      record('external-notification', 'mid-turn', {
        externalInputKind: 'notification',
        message: {
          role: 'user',
          parts: [{ text: 'background agent notification' }],
        },
      }),
      record('visible-assistant', 'external-notification', {
        type: 'assistant',
        message: {
          role: 'model',
          parts: [{ text: 'hidden', thought: true }, { text: longText }],
        },
      }),
      record('tool-call', 'visible-assistant', {
        type: 'assistant',
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'dangerous-looking-tool',
                args: { secret: 'must not enter the summary' },
              },
            },
          ],
        },
      }),
    ];

    const [branch] = inspectConversationBranches(records).branches;
    expect(branch).toMatchObject({
      firstUserTextAfterBranchPoint: 'real request',
      lastUserText: 'real request',
      recordCounts: { user: 5, assistant: 2, toolResult: 0, system: 0 },
    });
    expect(branch?.lastAssistantText).toBe(`${'x'.repeat(200)}...`);
  });

  it('uses physical leaf order even when timestamps are out of order', () => {
    const records = [
      record('root', null),
      assistant('first-leaf', 'root', 'first'),
      assistant('second-leaf', 'root', 'second'),
    ];
    records[1]!.timestamp = '2099-01-01T00:00:00.000Z';
    records[2]!.timestamp = '2000-01-01T00:00:00.000Z';

    expect(
      inspectConversationBranches(records).branches.map(
        (branch) => branch.leafUuid,
      ),
    ).toEqual(['first-leaf', 'second-leaf']);
  });

  it('uses collapsed physical leaf order instead of ancestor order', () => {
    const records = [
      record('first-root', null),
      record('second-root', null),
      system('second-title', 'second-root', 'custom_title'),
      system('first-title', 'first-root', 'custom_title'),
    ];

    expect(
      inspectConversationBranches(records).branches.map(
        (branch) => branch.leafUuid,
      ),
    ).toEqual(['second-root', 'first-root']);
  });

  it('normalizes the sanitized incident topology from three raw terminals to two branches', () => {
    const records = [
      record('shared', null),
      record('old-user', 'shared'),
      assistant('old-answer', 'old-user'),
      system('old-title-tail', 'old-answer', 'custom_title'),
      system('rewind', 'shared', 'rewind'),
      record('new-user', 'rewind'),
      assistant('new-answer', 'new-user'),
      system('artifact-side-tail', 'shared', 'session_artifact_event'),
    ];

    const rawTerminals = records.filter(
      (candidate) =>
        !records.some((record) => record.parentUuid === candidate.uuid),
    );
    const analysis = inspectConversationBranches(records);

    expect(rawTerminals.map((record) => record.uuid)).toEqual([
      'old-title-tail',
      'new-answer',
      'artifact-side-tail',
    ]);
    expect(analysis.branches.map((branch) => branch.leafUuid)).toEqual([
      'old-answer',
      'new-answer',
    ]);
  });

  it('returns leaves accepted by the existing explicit reconstruction path', () => {
    const records = [
      record('root', null),
      record('left', 'root'),
      assistant('left-leaf', 'left'),
      record('right', 'root'),
      assistant('right-leaf', 'right'),
    ];

    const chains = inspectConversationBranches(records).branches.map((branch) =>
      buildOrderedUuidChain(records, {
        leafUuid: branch.leafUuid,
        detectGaps: true,
      }),
    );

    expect(chains).toEqual([
      { uuids: ['root', 'left', 'left-leaf'], gaps: [] },
      { uuids: ['root', 'right', 'right-leaf'], gaps: [] },
    ]);
  });
});
