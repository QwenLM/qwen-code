/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  findExistingSummary,
  runPostSuggestions,
  SUMMARY_MARKER,
  type IssueComment,
  type PostSuggestionsArgs,
} from './post-suggestions.js';

const {
  ghMock,
  ghApiAllMock,
  currentUserMock,
  ensureAuthenticatedMock,
  readFileSyncMock,
  writeFileSyncMock,
  unlinkSyncMock,
  writeStdoutLineMock,
} = vi.hoisted(() => ({
  ghMock: vi.fn(),
  ghApiAllMock: vi.fn(),
  currentUserMock: vi.fn(),
  ensureAuthenticatedMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  unlinkSyncMock: vi.fn(),
  writeStdoutLineMock: vi.fn(),
}));

vi.mock('./lib/gh.js', () => ({
  gh: ghMock,
  ghApiAll: ghApiAllMock,
  currentUser: currentUserMock,
  ensureAuthenticated: ensureAuthenticatedMock,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const mock = {
    ...actual,
    readFileSync: readFileSyncMock,
    writeFileSync: writeFileSyncMock,
    unlinkSync: unlinkSyncMock,
  };
  return { ...mock, default: mock };
});

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: writeStdoutLineMock,
}));

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

describe('runPostSuggestions', () => {
  const baseArgs: PostSuggestionsArgs = {
    pr_number: '42',
    owner_repo: 'owner/repo',
    'body-file': '/tmp/body.md',
    out: '/tmp/out.json',
  };
  const bodyWithMarker = `${SUMMARY_MARKER}\n### Suggestions\n| file | issue | fix |`;

  beforeEach(() => {
    vi.clearAllMocks();
    ensureAuthenticatedMock.mockReturnValue(undefined);
    currentUserMock.mockReturnValue('qwen-bot');
    readFileSyncMock.mockReturnValue(bodyWithMarker);
  });

  it('PATCHes the existing summary when a prior comment is found', async () => {
    const existing = comment(99, 'qwen-bot', bodyWithMarker);
    ghApiAllMock.mockReturnValue([existing]);
    ghMock.mockReturnValue(JSON.stringify({ id: 99 }));

    await runPostSuggestions(baseArgs);

    expect(ghMock).toHaveBeenCalledWith(
      'api',
      'repos/owner/repo/issues/comments/99',
      '--method',
      'PATCH',
      '--input',
      '/tmp/out.json.payload.json',
    );
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      '/tmp/out.json',
      expect.stringContaining('"action": "updated"'),
      'utf8',
    );
  });

  it('POSTs a new comment when no prior summary exists', async () => {
    ghApiAllMock.mockReturnValue([]);
    ghMock.mockReturnValue(JSON.stringify({ id: 200 }));

    await runPostSuggestions(baseArgs);

    expect(ghMock).toHaveBeenCalledWith(
      'api',
      'repos/owner/repo/issues/42/comments',
      '--method',
      'POST',
      '--input',
      '/tmp/out.json.payload.json',
    );
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      '/tmp/out.json',
      expect.stringContaining('"action": "created"'),
      'utf8',
    );
  });

  it('throws when body-file is missing the summary marker', async () => {
    readFileSyncMock.mockReturnValue('no marker here');

    await expect(runPostSuggestions(baseArgs)).rejects.toThrow(
      'body-file must contain the summary marker',
    );
  });

  it('cleans up the payload file even when gh throws', async () => {
    ghApiAllMock.mockReturnValue([]);
    ghMock.mockImplementation(() => {
      throw new Error('gh api failed');
    });

    await expect(runPostSuggestions(baseArgs)).rejects.toThrow('gh api failed');
    expect(unlinkSyncMock).toHaveBeenCalledWith('/tmp/out.json.payload.json');
  });
});
