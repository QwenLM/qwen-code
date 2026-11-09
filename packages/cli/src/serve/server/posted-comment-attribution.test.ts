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

  it('does not attribute when a comments read precedes the creation (output origin ambiguous)', () => {
    // The read leaves comment-shaped output that cannot be distinguished from
    // the creation's, even though the creation targets another collection.
    const entry = shellResult(
      "gh api repos/o/r/issues/42/comments --jq '.[0].id' ; gh api repos/o/r/pulls/42/comments -X POST -f body=x",
      '{"id":900}',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not credit a read object that precedes the creation object in the output', () => {
    const entry = shellResult(
      "gh api repos/o/r/issues/42/comments --jq '.[0] | {id,body}' && gh api repos/o/r/issues/42/comments -f body=hi --jq '{id,body}'",
      '{"id":111,"body":"existing comment"}\n{"id":900,"body":"hi"}',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not credit a read URL when the creation output is redirected away', () => {
    const entry = shellResult(
      "gh api repos/o/r/issues/42/comments --jq '.[0].html_url' && gh pr comment 42 --body hi >/dev/null",
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not attribute a creation chained with another gh command (output origin unprovable)', () => {
    // Even a non-comments read shares the chain; enumerating read shapes cannot
    // prove no other command contributed comment output, so stay fail-open.
    const entry = shellResult(
      'gh pr view 42 --json state --jq .state && gh pr comment 42 --body-file comment.md',
      'OPEN\nhttps://github.com/o/r/pull/42#issuecomment-802',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not credit a single-comment-endpoint read chained after a redirected creation', () => {
    const entry = shellResult(
      'gh pr comment 42 --body hi >/dev/null && gh api repos/o/r/issues/comments/111 --jq .html_url',
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not credit a gh pr view --json comments read chained after a redirected creation', () => {
    const entry = shellResult(
      "gh pr comment 42 --body hi >/dev/null && gh pr view 42 --json comments --jq '.comments[0].url'",
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not credit a gh pr view --comments read chained before a creation', () => {
    const entry = shellResult(
      'gh pr view 42 --comments && gh pr comment 42 --body x',
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not attribute a creation inside an if-then guard (execution unprovable)', () => {
    // Static analysis cannot prove the creation branch ran, so stay fail-open.
    const entry = shellResult(
      'if [ "$STATE" = "OPEN" ]; then gh pr comment 42 --body c.md; else echo skip; fi',
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not attribute a creation inside a case arm (execution unprovable)', () => {
    const entry = shellResult(
      'case "$S" in open*) gh pr comment 42 --body c.md;; *) echo skip;; esac',
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not credit the condition read when the creation output is redirected', () => {
    const entry = shellResult(
      'if gh api repos/o/r/issues/comments/111 --jq .html_url; then gh pr comment 42 --body hi >/dev/null; fi',
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not attribute when no gh command executes (if-false else file read)', () => {
    const entry = shellResult(
      'if false; then gh pr comment 42 --body hi; else cat comment-url.txt; fi',
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not attribute a conditional whose creation branch is chained with a comments read', () => {
    const entry = shellResult(
      'if [ "$S" = "OPEN" ]; then gh api repos/o/r/issues/42/comments --jq ".[0].html_url"; gh pr comment 42 --body x; fi',
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('attributes a creation after a heredoc with a plain body (heredoc control)', () => {
    const entry = shellResult(
      "cat > /tmp/note.md <<'EOF'\nplain body\nEOF\ngh pr comment 42 --body-file /tmp/note.md",
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('111')]);
  });

  it('attributes a creation after a heredoc whose body contains an apostrophe', () => {
    // The heredoc body is data: its apostrophe must not open a shell quote that
    // swallows the following creation stage. stripHeredocBodies consumes the
    // body up to the delimiter before segmentation.
    const entry = shellResult(
      "cat > /tmp/note.md <<'EOF'\nit's quoted\nEOF\ngh pr comment 42 --body-file /tmp/note.md",
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('111')]);
  });

  it('does not scan creation-shaped text inside a heredoc body as a creation', () => {
    // The body is written to a file, not executed: a `gh pr comment` line inside
    // it is data and must not attribute when no real creation follows.
    const entry = shellResult(
      "cat > /tmp/note.md <<'EOF'\ngh pr comment 42 --body x\nEOF",
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not mistake a herestring for a heredoc (create after still attributes)', () => {
    const entry = shellResult(
      'cat <<< "it\'s a test" >/dev/null\ngh pr comment 42 --body hi',
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('111')]);
  });

  it('does not mistake an arithmetic left-shift for a heredoc', () => {
    const entry = shellResult(
      'n=$((1 << 2))\ngh pr comment 42 --body hi',
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('111')]);
  });

  it('does not let a << inside a shell comment start heredoc consumption that hides a read', () => {
    // The comment's <<'EOF' must not be treated as a heredoc start: finding the
    // later real heredoc's EOF line would otherwise delete the gh api read in
    // between, leaving a single API command and crediting the read's URL to the
    // redirected creation. The visible output comes from the read → ambiguous.
    const entry = shellResult(
      "gh pr comment 42 --body hi >/dev/null\n# Use <<'EOF' for the note\ngh api repos/o/r/issues/comments/111 --jq .html_url\ncat >/dev/null <<'EOF'\nplain note\nEOF",
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('still attributes a creation when a trailing comment merely mentions <<', () => {
    const entry = shellResult(
      "gh pr comment 42 --body hi\n# note about <<'EOF' usage",
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('111')]);
  });

  it('does not treat a # after an escaped space as a comment that hides a heredoc', () => {
    // In `tee review\ #1.md` the space is escaped, so #1.md is part of the
    // filename word (not a comment) and <<'EOF' is a real heredoc. The body is
    // data printed by tee — no creation runs, so nothing is attributed.
    const entry = shellResult(
      "tee review\\ #1.md <<'EOF'\ngh pr comment 42 --body hi\nhttps://github.com/o/r/pull/42#issuecomment-111\nEOF",
      'gh pr comment 42 --body hi\nhttps://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('pins the escaped-space guard via a provable create-after-heredoc chain (F7)', () => {
    // Unlike the tee fixture above (which the structural rule vetoes either
    // way), this chain is provable: the heredoc writes the body to the escaped
    // filename and the creation posts it. If the escaped-space guard regressed
    // (the # treated as a comment), the heredoc would not be consumed and the
    // creation would lose attribution — so this fixture reds without the guard.
    const entry = shellResult(
      "cat > review\\ #1.md <<'EOF'\nbody text\nEOF\ngh pr comment 42 --body-file review\\ #1.md",
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('111')]);
  });

  it('does not credit an unredirected read printed before the creation (structural source proof)', () => {
    // `cat url.txt` writes the comment URL to stdout before the creation runs;
    // the visible result is the read's, not the creation's, so attribute nothing.
    const entry = shellResult(
      'cat url.txt\ngh pr comment 42 --body x',
      'https://github.com/o/r/pull/42#issuecomment-777',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('still attributes when the preceding command redirects stdout (heredoc body to a file)', () => {
    // The heredoc writes the body to a file (stdout redirected), contributing no
    // visible output, so the creation that follows is the provable source.
    const entry = shellResult(
      "cat > note.md <<'EOF'\nbody text\nEOF\ngh pr comment 42 --body-file note.md",
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('111')]);
  });

  it('attributes a creation after a no-stdout builtin such as cd (F5)', () => {
    // cd writes nothing to stdout, so it must not count as a stdout producer
    // that vetoes the creation.
    const entry = shellResult(
      'cd /tmp\ngh pr comment 42 --body hi',
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('111')]);
  });

  it('attributes cd && heredoc-to-file then create (F5, the corpus note shape)', () => {
    const entry = shellResult(
      "cd /tmp && cat > note.md <<'EOF'\nbody text\nEOF\ngh pr comment 42 --body-file note.md",
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('111')]);
  });

  it('attributes a creation after export (F5)', () => {
    const entry = shellResult(
      'export FOO=1\ngh pr comment 42 --body hi',
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('111')]);
  });

  it('attributes a creation after set -e (silent operand form)', () => {
    const entry = shellResult(
      'set -e\ngh pr comment 42 --body hi',
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('111')]);
  });

  it('does not attribute when a pipe downstream reads a FILE instead of stdin', () => {
    // `cat url.txt` ignores stdin and prints the file's old comment, so leading
    // the pipeline does not prove the visible output is the creation's.
    const entry = shellResult(
      'gh pr comment 42 --body hi | cat url.txt',
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not treat tee as a passthrough when its stdin is redirected from a file', () => {
    // `tee < url.txt` reads the FILE instead of the pipe, so the visible URL is
    // the file's old comment even though tee normally echoes stdin.
    const entry = shellResult(
      'gh pr comment 42 --body hi | tee < url.txt',
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not treat tee as a passthrough when a herestring replaces its stdin', () => {
    const entry = shellResult(
      'gh pr comment 42 --body hi | tee <<< word',
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not exempt a QUOTED export -p, which prints the variables', () => {
    // `export '-p'` runs the same print as `export -p`; stripping quoted spans
    // would turn it into an empty operand and wrongly look silent.
    const entry = shellResult(
      "export REVIEW_URL=https://github.com/o/r/pull/42#issuecomment-111; false && gh pr comment 42 --body hi; export '-p'",
      'export REVIEW_URL="https://github.com/o/r/pull/42#issuecomment-111"',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('still attributes after export with a quoted value (silent operand form)', () => {
    const entry = shellResult(
      "export FOO='bar'\ngh pr comment 42 --body hi",
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('111')]);
  });

  it('does not exempt a BACKSLASH-escaped export -p (F1)', () => {
    // The shell removes the backslash, so the builtin still sees `-p`.
    const entry = shellResult(
      'export REVIEW_URL=https://github.com/o/r/pull/42#issuecomment-111; false && gh pr comment 42 --body hi; export \\-p',
      'export REVIEW_URL="https://github.com/o/r/pull/42#issuecomment-111"',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not exempt an ANSI-C quoted export -p (F1)', () => {
    // `$'-p'` is unquoted by the shell to the same `-p` argument.
    const entry = shellResult(
      "export REVIEW_URL=https://github.com/o/r/pull/42#issuecomment-111; false && gh pr comment 42 --body hi; export $'-p'",
      'export REVIEW_URL="https://github.com/o/r/pull/42#issuecomment-111"',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not exempt an export operand that EXPANDS to a printing flag', () => {
    // `export $FLAGS` with FLAGS=-p prints; the operand text is not a literal
    // NAME/NAME=value, so its silence cannot be proven.
    const entry = shellResult(
      'export REVIEW_URL=https://github.com/o/r/pull/42#issuecomment-111; FLAGS=-p; false && gh pr comment 42 --body hi; export $FLAGS',
      'export REVIEW_URL="https://github.com/o/r/pull/42#issuecomment-111"',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not exempt a QUOTED export operand that expands to a printing flag', () => {
    const entry = shellResult(
      'export REVIEW_URL=https://github.com/o/r/pull/42#issuecomment-111; FLAGS=-p; false && gh pr comment 42 --body hi; export "$FLAGS"',
      'export REVIEW_URL="https://github.com/o/r/pull/42#issuecomment-111"',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not exempt a set operand that expands away, leaving a bare set', () => {
    // `set $E` with an empty E is a bare `set`, which prints every variable.
    const entry = shellResult(
      'export REVIEW_URL=https://github.com/o/r/pull/42#issuecomment-111; E=; false && gh pr comment 42 --body hi; set $E',
      'REVIEW_URL=https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('counts a trailing set -o as a stdout producer (it lists the options)', () => {
    const entry = shellResult(
      'gh pr comment 42 --body hi; set -o',
      'https://github.com/o/r/pull/42#issuecomment-111\nallexport off',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not exempt a set operand that pathname expansion can delete', () => {
    // Under `nullglob` a pattern matching nothing is removed, so this runs a
    // bare `set`, which prints every variable. `shopt` is redirected so it is
    // not itself the second producer that would make this vacuous.
    const entry = shellResult(
      'U=issuecomment; export REVIEW_URL=https://github.com/o/r/pull/42#$U-111; shopt -s nullglob >/dev/null; false && gh pr comment 42 --body hi; set zzz*',
      'REVIEW_URL=https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not exempt a brace list that expands into a set option', () => {
    // `set {-o,}` expands to `set -o ''`, which lists the options — the
    // unexpanded word looks like an innocuous positional parameter.
    const entry = shellResult(
      'gh pr comment 42 --body hi; set {-o,}',
      'https://github.com/o/r/pull/42#issuecomment-111\nallexport off',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not exempt an unquoted glob in an export operand', () => {
    // Bash protects an assignment word from `nullglob`, but the detector cannot
    // assume that across shells: a deleted `FOO=*` would leave a bare `export`.
    // Refusing it costs this attribution, which is the fail-open direction.
    const entry = shellResult(
      'shopt -s nullglob >/dev/null\nexport FOO=*\ngh pr comment 42 --body hi',
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('still attributes after set -- with a glob (positional words never print)', () => {
    const entry = shellResult(
      'set -- zzz*\ngh pr comment 42 --body hi',
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('111')]);
  });

  it('still attributes after a QUOTED glob in an export value', () => {
    const entry = shellResult(
      'export FOO="*"\ngh pr comment 42 --body hi',
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('111')]);
  });

  it('still attributes when an export VALUE expands (never an option)', () => {
    const entry = shellResult(
      'X="a -p"\nexport FOO=$X\ngh pr comment 42 --body hi',
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('111')]);
  });

  it('still attributes after export PATH=$PATH:/x', () => {
    const entry = shellResult(
      'export PATH=$PATH:/x\ngh pr comment 42 --body hi',
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('111')]);
  });

  it('still attributes after a quoted export value containing spaces', () => {
    const entry = shellResult(
      'export FOO="a -p"\ngh pr comment 42 --body hi',
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('111')]);
  });

  it('still attributes after set -euo pipefail (option with its operand)', () => {
    const entry = shellResult(
      'set -euo pipefail\ngh pr comment 42 --body hi',
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('111')]);
  });

  it('still attributes after set -- a b (positional parameters)', () => {
    const entry = shellResult(
      'set -- a b\ngh pr comment 42 --body hi',
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('111')]);
  });

  it('attributes a creation piped into a bare cat (stdin passthrough)', () => {
    const entry = shellResult(
      'gh pr comment 42 --body hi | cat',
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('111')]);
  });

  it('does not exempt export -p, which prints the variables', () => {
    // No creation runs (`false && …`); the only comment URL is printed by
    // `export -p`, so the first word alone must not exempt it.
    const entry = shellResult(
      'export REVIEW_URL=https://github.com/o/r/pull/42#issuecomment-111; false && gh pr comment 42 --body hi; export -p',
      'export REVIEW_URL="https://github.com/o/r/pull/42#issuecomment-111"',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not exempt a bare export, which prints the variables', () => {
    // The creation is NOT redirected here, so a blanket exemption would leave
    // it as the sole producer and attribute; the bare `export` must count as a
    // second stdout producer instead.
    const entry = shellResult(
      'export REVIEW_URL=https://github.com/o/r/pull/42#issuecomment-111; gh pr comment 42 --body hi; export',
      'export REVIEW_URL="https://github.com/o/r/pull/42#issuecomment-111"',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not exempt a bare set, which prints the variables', () => {
    const entry = shellResult(
      'REVIEW_URL=https://github.com/o/r/pull/42#issuecomment-111; gh pr comment 42 --body hi; set',
      'REVIEW_URL=https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not treat a stderr-only redirect as silencing stdout (R2-1)', () => {
    // `cat url.txt 2>/dev/null` redirects only stderr; its stdout (the comment
    // URL) is still visible, and the creation's own stdout is redirected away,
    // so the visible result is the read's — attribute nothing.
    const entry = shellResult(
      'cat url.txt 2>/dev/null; gh pr comment 42 --body hi >/dev/null',
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not credit a read printed AFTER the redirected creation (R2-1)', () => {
    // The source proof covers the whole command, not just the prefix: the cat
    // after the creation is the visible stdout source, not the creation.
    const entry = shellResult(
      'gh pr comment 42 --body hi >/dev/null; cat url.txt',
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not attribute a two-heredoc body printed back by cat (H1 is over-attribution)', () => {
    // The second heredoc body (creation-shaped text + URL) is written to the
    // file and printed by `cat note.md`; no gh runs. The visible output is not
    // provably a creation's, so attribute nothing.
    const entry = shellResult(
      "cat >note.md <<'A' <<'B'\nignored\nA\ngh pr comment 42 --body hi\nhttps://github.com/o/r/pull/42#issuecomment-111\nB\ncat note.md",
      'gh pr comment 42 --body hi\nhttps://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not scan a heredoc with an escaped delimiter as a creation', () => {
    // <<\EOF is <<'EOF': the body is data, and the example creation inside it
    // must not attribute.
    const entry = shellResult(
      'cat > note.md <<\\EOF\ngh pr comment 42 --body x\nEOF',
      'https://github.com/o/r/pull/42#issuecomment-777',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('attributes a creation after a heredoc with an escaped delimiter (H2)', () => {
    // The escaped delimiter must still be recognised so the body is consumed
    // and its apostrophe does not swallow the creation that follows.
    const entry = shellResult(
      "cat > note.md <<\\EOF\nit's quoted\nEOF\ngh pr comment 42 --body-file note.md",
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('111')]);
  });

  it('does not let a line continuation hide a real comment before a later heredoc', () => {
    // `: \` + newline joins to `: # Use <<'EOF' …`: the # is a real comment, the
    // gh api read between it and the later heredoc is real → two API commands.
    const entry = shellResult(
      "gh pr comment 42 --body hi >/dev/null\n: \\\n# Use <<'EOF' for the note\ngh api repos/o/r/issues/comments/111 --jq .html_url\ncat >/dev/null <<'EOF'\nplain note\nEOF",
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('attributes a creation after a <<- heredoc with a tab-indented delimiter', () => {
    const entry = shellResult(
      "cat > note.md <<-'EOF'\n\tit's quoted\n\tEOF\ngh pr comment 42 --body-file note.md",
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('111')]);
  });

  it('attributes a creation after a heredoc with a double-quoted delimiter', () => {
    const entry = shellResult(
      'cat > note.md <<"EOF"\nit\'s quoted\nEOF\ngh pr comment 42 --body-file note.md',
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('111')]);
  });

  it('does not re-read a herestring as a heredoc (redirected herestring then create)', () => {
    // The <<< is a herestring, not a heredoc; the redirected cat contributes no
    // visible stdout, so the creation is the provable source.
    const entry = shellResult(
      'cat <<< x >/dev/null\ngh pr comment 42 --body hi',
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('111')]);
  });

  it('treats a # at the very start of the command as a comment', () => {
    // The i===0 word boundary: the leading comment (even one mentioning
    // <<'EOF') is ignored, leaving the creation as the sole stdout source.
    const entry = shellResult(
      "# Use <<'EOF' note\ngh pr comment 42 --body hi",
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('111')]);
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

  it('does not attribute a review body creation (out of scope, different id table)', () => {
    // Review bodies are not delivered by the watch, and a review-object id is
    // not an inline review-comment id; neither spelling may credit the session.
    const ghReview = shellResult(
      'gh pr review 42 --approve --body "LGTM"',
      'https://github.com/o/r/pull/42#pullrequestreview-123',
    );
    expect(extractPostedCommentIds(ghReview)).toEqual([]);
    const apiReview = shellResult(
      'gh api repos/o/r/pulls/42/reviews -X POST -f event=COMMENT -f body=summary',
      '{"id":999}',
    );
    expect(extractPostedCommentIds(apiReview)).toEqual([]);
  });

  it('attributes a gh api creation whose write flags precede the collection path', () => {
    const entry = shellResult(
      'gh api --method POST --input p.json repos/o/r/issues/5/comments',
      '{"id":987}',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('987')]);
  });

  it('does not attribute a flags-first gh api GET listing', () => {
    const entry = shellResult(
      'gh api -F per_page=100 repos/o/r/issues/42/comments --method GET',
      '[{"id":111},{"id":222}]',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('attributes a creation behind bare environment assignments', () => {
    const entry = shellResult(
      'FOO=1 BAR=2 gh api repos/o/r/issues/5/comments -X POST -f body=x',
      '{"id":701}',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('701')]);
  });

  it('credits only the top-level id of a JSON result, not a URL quoted in its body', () => {
    const entry = shellResult(
      "gh api repos/o/r/issues/42/comments -f body='see https://github.com/o/r/pull/42#issuecomment-111' --jq '{id,body}'",
      '{"id":900,"body":"see https://github.com/o/r/pull/42#issuecomment-111"}',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('900')]);
  });

  it('does not attribute a bare URL produced by a read chained after a redirected creation', () => {
    const entry = shellResult(
      "gh pr comment 42 --body-file report.md >/dev/null && gh api repos/o/r/issues/42/comments --jq '.[0].html_url'",
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('still attributes a lone creation whose output is a single comment URL', () => {
    const entry = shellResult(
      'gh pr comment 42 --body hi',
      'https://github.com/o/r/pull/42#issuecomment-777',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('777')]);
  });

  it('does not attribute a read whose shell comment merely names a creation subcommand', () => {
    const entry = shellResult(
      "gh api repos/o/r/issues/42/comments --jq '.[0].html_url' # gh pr comment",
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not attribute a read whose shell comment contains a write flag', () => {
    const entry = shellResult(
      'gh api repos/o/r/issues/42/comments # -f body=x',
      '{"id":111}',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not attribute an unquoted search for a creation subcommand', () => {
    const entry = shellResult(
      'grep -n gh pr comment scripts/post.sh',
      'https://github.com/o/r/pull/1#issuecomment-999',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('vetoes curl --request GET even when a jq stage reduces the listing to one URL', () => {
    const entry = shellResult(
      "curl --request GET https://api.github.com/repos/o/r/issues/42/comments -d per_page=100 | jq -r '.[0].html_url'",
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('vetoes a quoted curl --request "GET" method value', () => {
    const entry = shellResult(
      'curl --request "GET" https://api.github.com/repos/o/r/issues/42/comments -d per_page=100',
      '{"id":111}',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not attribute a JSON object produced by a read chained after a redirected creation', () => {
    const entry = shellResult(
      "gh api repos/o/r/issues/42/comments -f body=hi >/dev/null && gh api repos/o/r/issues/42/comments --jq '.[0] | {id,body}'",
      '{"id":111,"body":"someone else wrote this"}',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not attribute a bare id produced by a read chained after a redirected creation', () => {
    const entry = shellResult(
      "gh api repos/o/r/issues/42/comments -f body=hi >/dev/null && gh api repos/o/r/issues/42/comments --jq '.[0].id'",
      '111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('counts a wrapper-with-flags read in a chain (env -u) when checking output origin', () => {
    const entry = shellResult(
      "gh pr comment 42 --body-file report.md >/dev/null && env -u HTTP_PROXY gh api repos/o/r/issues/42/comments --jq '.[0].html_url'",
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('does not split a shell comment on its separators into a phantom creation', () => {
    const entry = shellResult(
      'cat comment-url.txt # inspect; gh pr comment 42 --body hi',
      'https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([]);
  });

  it('still attributes a lone creation with a JSON result (origin-check control)', () => {
    const entry = shellResult(
      'gh api repos/o/r/issues/42/comments -f body=hi',
      '{"id":900}',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('900')]);
  });

  it('attributes a creation whose JSON object is followed by a trailer line', () => {
    const entry = shellResult(
      'gh api repos/o/r/pulls/42/comments/7/replies -f body=x',
      '{ "id": 3180644908 }\nALL DONE',
    );
    expect(extractPostedCommentIds(entry)).toEqual([
      reviewCommentKey('3180644908'),
    ]);
  });

  it('does not scan a URL in the trailer of a structured creation result', () => {
    const entry = shellResult(
      'gh api repos/o/r/issues/42/comments -f body=x',
      '{"id":900}\nsee https://github.com/o/r/pull/42#issuecomment-111',
    );
    expect(extractPostedCommentIds(entry)).toEqual([issueCommentKey('900')]);
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
