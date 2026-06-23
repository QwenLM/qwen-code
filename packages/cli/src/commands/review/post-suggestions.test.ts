/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  findExistingSummary,
  SUMMARY_MARKER,
  type IssueComment,
} from './post-suggestions.js';

function comment(id: number, login: string, body: string): IssueComment {
  return { id, user: { login }, body };
}

describe('findExistingSummary', () => {
  it('returns the comment authored by me that carries the marker', () => {
    const me = comment(5, 'qwen-bot', `${SUMMARY_MARKER}\n## Suggestions`);
    const comments: IssueComment[] = [
      comment(1, 'someone-else', 'LGTM'),
      me,
      comment(8, 'qwen-bot', 'a different unrelated comment'),
    ];
    expect(findExistingSummary(comments, 'qwen-bot')).toEqual(me);
  });

  it('picks the highest id when multiple summaries exist (latest wins)', () => {
    const old = comment(3, 'qwen-bot', `${SUMMARY_MARKER}\nround 1`);
    const latest = comment(42, 'qwen-bot', `${SUMMARY_MARKER}\nround 2`);
    expect(findExistingSummary([old, latest], 'qwen-bot')).toEqual(latest);
  });

  it('ignores comments from other users even if they carry the marker', () => {
    const other = comment(9, 'impersonator', `${SUMMARY_MARKER}\nfake`);
    expect(findExistingSummary([other], 'qwen-bot')).toBeNull();
  });

  it('ignores comments by me that do not carry the marker', () => {
    const plain = comment(7, 'qwen-bot', 'just a normal review note');
    expect(findExistingSummary([plain], 'qwen-bot')).toBeNull();
  });

  it('matches the login case-insensitively', () => {
    const me = comment(11, 'Qwen-Bot', `${SUMMARY_MARKER}\nx`);
    expect(findExistingSummary([me], 'qwen-bot')).toEqual(me);
    expect(findExistingSummary([me], 'QWEN-BOT')).toEqual(me);
  });

  it('returns null for an empty comment list', () => {
    expect(findExistingSummary([], 'qwen-bot')).toBeNull();
  });

  it('treats a missing body the same as no marker', () => {
    const noBody: IssueComment = { id: 2, user: { login: 'qwen-bot' } };
    expect(findExistingSummary([noBody], 'qwen-bot')).toBeNull();
  });
});
