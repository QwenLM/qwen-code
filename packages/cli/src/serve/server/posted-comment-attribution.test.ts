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
  it('pins the cross-package ic:/rc: wire format with literals', () => {
    // The adapter builds attrKey with these exact prefixes; a helper-only
    // expectation would let a prefix rename pass both sides while they no
    // longer match. Pin the literals the watch relies on.
    expect(issueCommentKey(1)).toBe('ic:1');
    expect(reviewCommentKey(2)).toBe('rc:2');
    const entry = shellResult(
      'gh pr comment 1 --body a',
      'https://github.com/o/r/pull/1#issuecomment-42',
    );
    expect(extractPostedCommentIds(entry)).toEqual(['ic:42']);
  });

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

  it('vetoes a quoted GET method value', () => {
    const entry = shellResult(
      'gh api repos/o/r/issues/42/comments --method "GET" --paginate -F per_page=100',
      '[{"id":111},{"id":222}]',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('treats a newline as a command boundary (listing then stat -f)', () => {
    const entry = shellResult(
      "gh api repos/o/r/issues/42/comments\nstat -f '%Sm' report.md",
      '[{"id":111},{"id":222}]',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not split on separators inside quotes (read-only search)', () => {
    // The `|` is inside the search pattern, not a pipeline: the quoted
    // `gh pr comment` must not be mistaken for a real creation.
    const pipe = shellResult(
      "rg 'gh api|gh pr comment' transcript.jsonl",
      'match: https://github.com/o/r/pull/1#issuecomment-111',
    );
    expect(extractPostedCommentIds(pipe)).toEqual([]);
    const semicolon = shellResult(
      "grep 'gh pr comment; echo' transcript.jsonl",
      'https://github.com/o/r/pull/1#issuecomment-222',
    );
    expect(extractPostedCommentIds(semicolon)).toEqual([]);
    const or = shellResult(
      "rg 'gh pr comment || gh issue comment' transcript.jsonl",
      'https://github.com/o/r/pull/1#issuecomment-333',
    );
    expect(extractPostedCommentIds(or)).toEqual([]);
  });

  it('attributes a creation whose output is a bare id (--jq .id)', () => {
    const entry = shellResult(
      "gh api repos/o/r/issues/42/comments -X POST --input payload.json --jq '.id'",
      '6556188465',
    );
    expect(extractPostedCommentIds(entry)).toEqual([
      issueCommentKey('6556188465'),
    ]);
  });

  it('attributes a curl write whose flags precede the URL', () => {
    const entry = shellResult(
      'curl -X POST -d \'{"body":"hi"}\' https://api.github.com/repos/o/r/issues/9/comments',
      '{"id":6600000002}',
    );
    expect(extractPostedCommentIds(entry)).toContain(
      issueCommentKey('6600000002'),
    );
  });

  it('attributes a creation with a quoted collection path', () => {
    const entry = shellResult(
      'gh api "repos/o/r/issues/42/comments" -X POST -f body=x',
      '{"id":99}',
    );
    expect(extractPostedCommentIds(entry)).toContain(issueCommentKey('99'));
  });

  it('attributes a creation whose write flag is on a backslash-continued line', () => {
    const entry = shellResult(
      'gh api repos/o/r/pulls/6535/comments \\\n  -f body=note -f commit_id=abc -f path=a.ts -F line=3',
      '{"id":102}',
    );
    expect(extractPostedCommentIds(entry)).toContain(reviewCommentKey('102'));
  });

  it('attributes a creation behind an env wrapper (assignment and -u flag)', () => {
    const assign = shellResult(
      'env FOO=1 gh api repos/o/r/issues/42/comments -X POST -f body=x',
      '{"id":701}',
    );
    expect(extractPostedCommentIds(assign)).toContain(issueCommentKey('701'));
    const unset = shellResult(
      "env -u HTTP_PROXY gh api repos/o/r/pulls/3820/comments/9/replies -f body=x --jq '.id'",
      '3182736379',
    );
    expect(extractPostedCommentIds(unset)).toContain(
      reviewCommentKey('3182736379'),
    );
  });

  it('attributes a creation behind time/nohup/sudo wrappers', () => {
    for (const wrapper of ['time', 'nohup', 'sudo']) {
      const entry = shellResult(
        `${wrapper} gh api repos/o/r/issues/42/comments -X POST -f body=x`,
        '{"id":702}',
      );
      expect(extractPostedCommentIds(entry)).toContain(issueCommentKey('702'));
    }
  });

  it('attributes a creation captured in an assignment', () => {
    const entry = shellResult(
      'cid=$(gh api repos/o/r/issues/42/comments -X POST -f body=x)',
      '{"id":703}',
    );
    expect(extractPostedCommentIds(entry)).toContain(issueCommentKey('703'));
  });

  it('does not attribute a search that quotes a creation with path and write flag', () => {
    // Pins the stage-start anchor: the stage leads with the search tool, not a
    // wrapper or gh api/curl, so the quoted creation is not a real command.
    const entry = shellResult(
      'grep -n "gh api repos/o/r/issues/1/comments -X POST" notes.md',
      '{"id":888}',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not credit a create-then-list compound with the listed comments', () => {
    // The output mixes the created URL with a listing; that is ambiguous, so
    // attribute nothing rather than crediting the mere reader (fail-open).
    const entry = shellResult(
      'gh pr comment 42 --body hi && gh api repos/o/r/issues/42/comments',
      'https://github.com/o/r/pull/42#issuecomment-900\n[{"id":6538275524,"html_url":"https://github.com/o/r/issues/42#issuecomment-6538275524"},{"id":6538275599,"html_url":"https://github.com/o/r/issues/42#issuecomment-6538275599"}]',
    );
    const ids = extractPostedCommentIds(entry);
    expect(ids).not.toContain(issueCommentKey('6538275524'));
    expect(ids).not.toContain(issueCommentKey('6538275599'));
  });

  it('harvests only the top-level id of a single creation object, not nested user.id', () => {
    const entry = shellResult(
      'gh api repos/o/r/issues/42/comments -X POST -f body=x',
      '{"id":555,"user":{"id":999}}',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('555')]);
  });

  it('does not attribute a curl -G listing', () => {
    const entry = shellResult(
      'curl -sG https://api.github.com/repos/o/r/issues/42/comments -d per_page=100',
      '[{"id":111},{"id":222}]',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not attribute a read backgrounded before an unrelated -f command', () => {
    // A lone `&` ends the stage, so the read is not merged with `stat -f`.
    const entry = shellResult(
      "gh api repos/o/r/issues/42/comments --jq '.[].id' & stat -f %Sm x",
      '111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('still attributes a creation that redirects with >& or &>', () => {
    const redir = shellResult(
      'gh api repos/o/r/issues/42/comments -X POST -f body=x 2>&1',
      '{"id":131}',
    );
    expect(extractPostedCommentIds(redir)).toContain(issueCommentKey('131'));
  });

  it('keys a creation to its own collection when another collection is read', () => {
    const entry = shellResult(
      "gh api repos/o/r/issues/42/comments --jq '.[0].id' ; gh api repos/o/r/pulls/42/comments -X POST -f body=x",
      '{"id":900}',
    );
    expect(extractPostedCommentIds(entry)).toEqual([reviewCommentKey('900')]);
  });

  it('does not veto a POST whose quoted body merely quotes --method GET', () => {
    const entry = shellResult(
      "gh api repos/o/r/issues/42/comments -X POST -f body='--method GET' --jq '.id'",
      '45678',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('45678')]);
  });

  it('does not attribute a GET listing chained with an unrelated -f (stat -f)', () => {
    // The write flag must be in the same pipeline stage as the collection
    // path; a trailing `stat -f` in the chain is not a POST body field.
    const entry = shellResult(
      "gh api repos/QwenLM/qwen-code/issues/15974/comments --jq '.[] | {id, user: .user.login}' | tail -20; echo done; stat -f '%Sm %N' report.md",
      '[{"id":6538275524},{"id":111}]',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not attribute a creation subcommand inside a quoted grep pattern', () => {
    const entry = shellResult(
      "grep -n 'gh pr comment' scripts/post.sh",
      'https://github.com/o/r/pull/1#issuecomment-999',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('still attributes a creation piped into a reader', () => {
    const entry = shellResult(
      'gh pr comment 42 --body hi | tee comment.log',
      'https://github.com/o/r/pull/42#issuecomment-777',
    );
    expect(extractPostedCommentIds(entry)).toContain(issueCommentKey('777'));
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

  it('evicts the oldest cached transcript past the bound', async () => {
    dir = await mkdtemp(join(tmpdir(), 'posted-comments-'));
    const paths: string[] = [];
    for (let i = 0; i < 257; i++) {
      const p = join(dir, `s${i}.jsonl`);
      const entry = shellResult(
        'gh pr comment 1 --body a',
        `https://github.com/o/r/pull/1#issuecomment-${i}`,
      );
      await writeFile(p, JSON.stringify(entry) + '\n');
      paths.push(p);
    }
    const first = await postedCommentIdsForTranscript(paths[0]!);
    expect([...first]).toEqual([issueCommentKey('0')]);
    for (let i = 1; i < 257; i++) {
      await postedCommentIdsForTranscript(paths[i]!);
    }
    // The oldest entry was evicted, so re-scanning rebuilds a fresh set rather
    // than returning the cached instance (removing the eviction keeps it cached).
    const rescan = await postedCommentIdsForTranscript(paths[0]!);
    expect([...rescan]).toEqual([issueCommentKey('0')]);
    expect(rescan).not.toBe(first);
  });
});
