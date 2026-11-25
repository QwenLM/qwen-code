/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  clearCommittedMidTurnMessages,
  commitMidTurnMessages,
  deleteMidTurnDeliveryData,
  readCommittedMidTurnMessages,
  readMidTurnCancelGeneration,
  readMidTurnOwnership,
  writeMidTurnOwnership,
  writeMidTurnCancelGeneration,
} from './mid-turn-commit-ledger.js';

it('keeps committed content and ownership independently across reads', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'qwen-mid-turn-ledger-'));
  const workspace = path.join(root, 'workspace-one');
  const other = path.join(root, 'workspace_one');
  const sessionId = 'session';
  const first = {
    messageId: 'first',
    parts: [{ text: 'raw prompt' }, { text: 'hook context' }],
    displayText: 'raw prompt',
  };
  const second = { ...first, messageId: 'second' };
  const ownership = {
    messageId: 'second',
    clientId: 'sender',
    state: 'recovery' as const,
    draft: { messageId: 'second', text: 'original draft' },
  };
  try {
    commitMidTurnMessages(workspace, sessionId, [first, second], root);
    commitMidTurnMessages(
      workspace,
      sessionId,
      [{ ...first, displayText: 'retry' }],
      root,
    );
    expect(readCommittedMidTurnMessages(workspace, sessionId, root)).toEqual([
      first,
      second,
    ]);
    expect(readCommittedMidTurnMessages(other, sessionId, root)).toEqual([]);
    writeMidTurnOwnership(workspace, sessionId, [ownership], root);
    clearCommittedMidTurnMessages(workspace, sessionId, ['first'], root);
    expect(readCommittedMidTurnMessages(workspace, sessionId, root)).toEqual([
      second,
    ]);
    expect(readMidTurnOwnership(workspace, sessionId, root)).toEqual([
      ownership,
    ]);
    expect(readMidTurnCancelGeneration(workspace, sessionId, root)).toBe(0);
    writeMidTurnCancelGeneration(workspace, sessionId, 3, root);
    expect(readMidTurnCancelGeneration(workspace, sessionId, root)).toBe(3);
    clearCommittedMidTurnMessages(workspace, sessionId, ['second'], root);
    expect(readCommittedMidTurnMessages(workspace, sessionId, root)).toEqual(
      [],
    );
    deleteMidTurnDeliveryData(workspace, sessionId, root);
    expect(readMidTurnOwnership(workspace, sessionId, root)).toEqual([]);
    expect(readMidTurnCancelGeneration(workspace, sessionId, root)).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
