/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearPostedCommentScanCache,
  extractPostedCommentIds,
  issueCommentKey,
  postedCommentIdsForTranscript,
  reviewCommentKey,
} from './posted-comment-attribution.js';

function shellResult(command: string, output: string): unknown {
  return {
    type: 'tool_result',
    message: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'run_shell_command',
            response: {
              output: `Command: ${command}\nDirectory: (root)\nOutput: ${output}\nError: (none)\nExit Code: 0\n`,
            },
          },
        },
      ],
    },
  };
}

describe('extractPostedCommentIds', () => {
  it('attributes a gh pr comment creation', () => {
    const entry = shellResult(
      'gh pr comment 16458 --repo QwenLM/qwen-code --body-file report.md',
      'https://github.com/QwenLM/qwen-code/pull/16458#issuecomment-6684204082',
    );
    expect(extractPostedCommentIds(entry)).toEqual([
      issueCommentKey('6684204082'),
    ]);
  });

  it('attributes a gh issue comment creation', () => {
    const entry = shellResult(
      'gh issue comment 42 --body hi',
      'https://github.com/o/r/issues/42#issuecomment-777',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('777')]);
  });

  it('attributes a gh api POST to an issue comments collection', () => {
    const entry = shellResult(
      'gh api repos/o/r/issues/42/comments -f body=hi',
      '{"id":987654,"html_url":"https://github.com/o/r/issues/42#issuecomment-987654"}',
    );
    const ids = extractPostedCommentIds(entry);
    expect(ids).toContain(issueCommentKey('987654'));
  });

  it('attributes a gh api POST to a pull review-comment collection', () => {
    const entry = shellResult(
      'gh api repos/o/r/pulls/7/comments -f body=note -f commit_id=abc -f path=a.ts -F line=3',
      '{"id":555,"html_url":"https://github.com/o/r/pull/7#discussion_r555"}',
    );
    const ids = extractPostedCommentIds(entry);
    expect(ids).toContain(reviewCommentKey('555'));
  });

  it('attributes a curl POST creating a comment', () => {
    const entry = shellResult(
      'curl -X POST -H "Authorization: bearer x" https://api.github.com/repos/o/r/issues/9/comments -d \'{"body":"hi"}\'',
      '{"id":321}',
    );
    expect(extractPostedCommentIds(entry)).toContain(issueCommentKey('321'));
  });

  it('does not attribute a read/list of comments', () => {
    const read = shellResult(
      'gh pr view 7 --comments',
      'author: someone\nhttps://github.com/o/r/pull/7#issuecomment-111\nhttps://github.com/o/r/pull/7#issuecomment-222',
    );
    expect(extractPostedCommentIds(read)).toEqual([]);
    const apiGet = shellResult(
      'gh api repos/o/r/issues/7/comments',
      '[{"id":111},{"id":222}]',
    );
    expect(extractPostedCommentIds(apiGet)).toEqual([]);
  });

  it('does not attribute an explicit GET that passes field flags as query params', () => {
    // gh api sends -f/-F values as query parameters on a GET; this is the
    // repo's own triage listing shape and must never attribute the listed ids.
    const methodGet = shellResult(
      'gh api repos/o/r/issues/42/comments --method GET --paginate -F per_page=100',
      '[{"id":111},{"id":222}]',
    );
    expect(extractPostedCommentIds(methodGet)).toEqual([]);
    const xGet = shellResult(
      'gh api repos/o/r/pulls/7/comments -X GET -F per_page=100 -f since=2026-01-01',
      '[{"id":333}]',
    );
    expect(extractPostedCommentIds(xGet)).toEqual([]);
    const curlGet = shellResult(
      'curl -X GET https://api.github.com/repos/o/r/issues/9/comments -d per_page=100',
      '[{"id":444}]',
    );
    expect(extractPostedCommentIds(curlGet)).toEqual([]);
  });

  it('still attributes a POST that carries field flags', () => {
    const post = shellResult(
      'gh api repos/o/r/issues/42/comments -X POST -f body=hi',
      '{"id":555}',
    );
    expect(extractPostedCommentIds(post)).toContain(issueCommentKey('555'));
  });

  it('does not attribute a received channel event (user message)', () => {
    const entry = {
      type: 'user',
      provenance: 'real_user',
      message: {
        role: 'user',
        parts: [
          {
            text: '[GitHub event for a PR this session follows] … https://github.com/o/r/pull/7#issuecomment-111',
          },
        ],
      },
    };
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not grab a bare JSON id from a non-comments endpoint', () => {
    const entry = shellResult(
      'gh api repos/o/r/pulls/7 -X POST -f title=x',
      '{"id":424242}',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('ignores non-shell tool results and malformed entries', () => {
    expect(extractPostedCommentIds(null)).toEqual([]);
    expect(extractPostedCommentIds({})).toEqual([]);
    expect(
      extractPostedCommentIds({
        type: 'tool_result',
        message: {
          parts: [{ functionResponse: { name: 'write_file', response: {} } }],
        },
      }),
    ).toEqual([]);
  });
});

describe('postedCommentIdsForTranscript (incremental scan)', () => {
  let dir: string | undefined;

  afterEach(async () => {
    clearPostedCommentScanCache();
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('accumulates ids across appends and answers unchanged files from cache', async () => {
    dir = await mkdtemp(join(tmpdir(), 'posted-comments-'));
    const path = join(dir, 'session.jsonl');
    const first = shellResult(
      'gh pr comment 1 --body a',
      'https://github.com/o/r/pull/1#issuecomment-10',
    );
    await writeFile(path, JSON.stringify(first) + '\n');
    const a = await postedCommentIdsForTranscript(path);
    expect([...a]).toEqual([issueCommentKey('10')]);

    const second = shellResult(
      'gh api repos/o/r/pulls/1/comments -f body=b',
      '{"id":20,"html_url":"https://github.com/o/r/pull/1#discussion_r20"}',
    );
    await appendFile(path, JSON.stringify(second) + '\n');
    const b = await postedCommentIdsForTranscript(path);
    expect([...b].sort()).toEqual(
      [issueCommentKey('10'), reviewCommentKey('20')].sort(),
    );

    // Unchanged file: same set instance from cache.
    const c = await postedCommentIdsForTranscript(path);
    expect(c).toBe(b);
  });

  it('leaves a trailing partial line unconsumed until it completes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'posted-comments-'));
    const path = join(dir, 'session.jsonl');
    const entry = shellResult(
      'gh pr comment 1 --body a',
      'https://github.com/o/r/pull/1#issuecomment-30',
    );
    const full = JSON.stringify(entry);
    await writeFile(path, full.slice(0, full.length - 5)); // no trailing newline, truncated
    expect([...(await postedCommentIdsForTranscript(path))]).toEqual([]);
    await appendFile(path, full.slice(full.length - 5) + '\n');
    expect([...(await postedCommentIdsForTranscript(path))]).toEqual([
      issueCommentKey('30'),
    ]);
  });

  it('returns an empty set for a missing transcript', async () => {
    dir = await mkdtemp(join(tmpdir(), 'posted-comments-'));
    const ids = await postedCommentIdsForTranscript(join(dir, 'absent.jsonl'));
    expect(ids.size).toBe(0);
  });
});
