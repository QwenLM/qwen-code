/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ActiveLeafEntry,
  Entry,
  TranscriptMessage,
} from '../../protocol/transcript/entry.js';
import { buildTranscriptIndex } from './index.js';
import { EntryScanner } from './scanner.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function user(
  uuid: string,
  parentUuid: string | null,
  content: string,
): TranscriptMessage {
  return {
    type: 'user',
    uuid,
    parentUuid,
    isSidechain: false,
    timestamp: '2026-07-10T00:00:00.000Z',
    cwd: '/workspace/project',
    sessionId: 'session-1',
    userType: 'external',
    version: '1.0.0',
    message: { role: 'user', content },
  };
}

describe('buildTranscriptIndex', () => {
  it('preserves file order, uses the last duplicate UUID and reduces metadata', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-index-'));
    tempDirs.push(root);
    const filePath = path.join(root, 'session.jsonl');
    const first = user('message-1', null, 'first value');
    const duplicate = user('message-1', null, 'last value');
    const child = user('message-2', 'message-1', 'child');
    const broken = user('message-3', 'missing-parent', 'broken');
    const firstActiveLeaf: ActiveLeafEntry = {
      type: 'active-leaf',
      sessionId: 'session-1',
      leafUuid: 'message-2',
      explicit: false,
      timestamp: 1_754_300_000_100,
    };
    const lastActiveLeaf: ActiveLeafEntry = {
      type: 'active-leaf',
      sessionId: 'session-1',
      leafUuid: 'message-1',
      explicit: true,
      rewound: true,
      timestamp: 1_754_300_000_000,
    };
    const relocated: Entry = {
      type: 'relocated',
      sessionId: 'session-1',
      relocatedCwd: '/workspace/project-worktree',
    };
    const worktreeState: Entry = {
      type: 'worktree-state',
      sessionId: 'session-1',
      worktreeSession: {
        originalCwd: '/workspace/project',
        preEnterOriginalCwd: '/workspace/project',
        worktreePath: '/workspace/project-worktree',
        worktreeName: 'feature',
        worktreeBranch: 'worktree-feature',
        sessionId: 'session-1',
      },
    };
    const entries: Entry[] = [
      first,
      { type: 'custom-title', sessionId: 'session-1', customTitle: 'old' },
      firstActiveLeaf,
      duplicate,
      child,
      broken,
      { type: 'custom-title', sessionId: 'session-1', customTitle: 'new' },
      lastActiveLeaf,
      relocated,
      worktreeState,
    ];
    await fs.writeFile(
      filePath,
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n{\n`,
      'utf8',
    );

    const index = buildTranscriptIndex(await new EntryScanner().scan(filePath));

    expect(index.entriesInFileOrder.map((item) => item.entry)).toEqual(entries);
    expect(index.messagesByUuid.get('message-1')).toEqual(duplicate);
    expect(index.orderByUuid.get('message-1')).toBe(3);
    expect(index.childrenByParentUuid.get('message-1')).toEqual(['message-2']);
    expect(index.leafUuids).toEqual(new Set(['message-2', 'message-3']));
    expect(index.metadata.customTitles.get('session-1')).toBe('new');
    expect(index.metadata.activeLeaves.get('session-1')).toEqual(
      lastActiveLeaf,
    );
    expect(index.metadata.latestActiveLeaf).toEqual(lastActiveLeaf);
    expect(index.metadata.relocatedCwds.get('session-1')).toBe(
      '/workspace/project-worktree',
    );
    expect(index.metadata.worktreeSessions.get('session-1')).toEqual(
      worktreeState.worktreeSession,
    );
    expect(index.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'duplicate-uuid',
          uuid: 'message-1',
          orders: [0, 3],
          winningOrder: 3,
        }),
        expect.objectContaining({
          kind: 'broken-parent',
          uuid: 'message-3',
          parentUuid: 'missing-parent',
        }),
        expect.objectContaining({ kind: 'malformed' }),
      ]),
    );
  });
});
