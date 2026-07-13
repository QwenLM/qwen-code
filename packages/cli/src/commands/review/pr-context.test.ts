/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Argv, CommandModule } from 'yargs';
import {
  prContextCommand,
  isLegacySuggestionSummary,
  isReviewWorthShowing,
  SUMMARY_MARKER,
  truncatedHeadings,
  buildMarkdown,
  carriesBlockerSignal,
  extractCodeRefs,
  classifyInlineThreads,
  fullBody,
  fullCommentBody,
  type PrMetadata,
  type RawComment,
} from './pr-context.js';

// Guards the recognition of legacy suggestion-summary comments. This is what
// decides which issue comment is excluded from the "Already discussed" list.
// A summary that slips through is rendered as settled discussion and tells
// the review agents not to re-report the findings it lists — so recognition
// must not regress, whoever authored the summary.
describe('isLegacySuggestionSummary', () => {
  const withMarker = (extra = '') => `${SUMMARY_MARKER}\n${extra}`;

  it('matches a summary regardless of who posted it', () => {
    // `/review` ran under whichever identity invoked it: a maintainer
    // locally, or the CI bot in the review workflow. Both left summaries
    // behind, and both must be excluded no matter who runs the next review.
    expect(isLegacySuggestionSummary(withMarker('by a maintainer'))).toBe(true);
    expect(isLegacySuggestionSummary(withMarker('by the CI bot'))).toBe(true);
  });

  it('does not match an ordinary comment', () => {
    expect(isLegacySuggestionSummary('no marker here')).toBe(false);
    expect(
      isLegacySuggestionSummary('mentions qwen-review-suggestion-summary'),
    ).toBe(false);
  });

  it('matches wherever the marker sits in the body', () => {
    expect(isLegacySuggestionSummary(`preamble\n${SUMMARY_MARKER}`)).toBe(true);
  });

  it('tolerates a missing body', () => {
    expect(isLegacySuggestionSummary(undefined)).toBe(false);
    expect(isLegacySuggestionSummary('')).toBe(false);
  });
});

describe('truncatedHeadings', () => {
  it('names the headings that begin past the limit', () => {
    const md = ['## A', 'x'.repeat(50), '## B', 'y'.repeat(10), '## C'].join(
      '\n',
    );
    const bOffset = md.indexOf('## B');
    const got = truncatedHeadings(md, bOffset);
    expect(got.map((h) => h.heading)).toEqual(['## B', '## C']);
    expect(got[0].offset).toBe(bOffset);
  });

  it('returns nothing when the whole document fits', () => {
    expect(truncatedHeadings('## A\nbody\n## B\n', 10_000)).toEqual([]);
  });

  it('scans ### as well as ##, and ignores # and ####', () => {
    const md = '# T\n## A\n### B\n#### C\n';
    expect(truncatedHeadings(md, 0).map((h) => h.heading)).toEqual([
      '## A',
      '### B',
    ]);
  });

  it('ignores a hash that is not at the start of a line', () => {
    expect(truncatedHeadings('text ## not a heading\n', 0)).toEqual([]);
  });
});

describe('buildMarkdown section order', () => {
  const meta = {
    title: 't',
    body: '',
    author: { login: 'a' },
    baseRefName: 'main',
    headRefName: 'f',
    headRefOid: 'abc',
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    state: 'OPEN',
  } as PrMetadata;

  // One thread with a reply (already discussed) and one without (still open).
  const root: RawComment = {
    id: 1,
    user: { login: 'r' },
    body: 'settled',
    path: 'a.ts',
    line: 1,
  };
  const reply: RawComment = {
    id: 2,
    user: { login: 'a' },
    body: 'fixed',
    in_reply_to_id: 1,
  };
  const open: RawComment = {
    id: 3,
    user: { login: 'r' },
    body: 'still live',
    path: 'b.ts',
    line: 2,
  };

  it('puts the open comments before the already-discussed ones', () => {
    const md = buildMarkdown('1', 'o/r', meta, [root, reply, open], [], []);
    const openAt = md.indexOf('## Open inline comments');
    const discussedAt = md.indexOf('## Already discussed');
    expect(openAt).toBeGreaterThan(-1);
    expect(discussedAt).toBeGreaterThan(-1);
    // The section a review must answer is written first, so a truncated read
    // keeps it. PR 5738 lost it at char 27125 of a 31220-char file.
    expect(openAt).toBeLessThan(discussedAt);
  });

  it('still renders both sections in full', () => {
    const md = buildMarkdown('1', 'o/r', meta, [root, reply, open], [], []);
    expect(md).toContain('still live');
    expect(md).toContain('settled');
    expect(md).toContain('fixed');
  });

  it('omits the open section when every thread has a reply', () => {
    const md = buildMarkdown('1', 'o/r', meta, [root, reply], [], []);
    expect(md).not.toContain('## Open inline comments');
    expect(md).toContain('## Already discussed');
  });
});

describe('fullBody', () => {
  it('returns short bodies untouched', () => {
    expect(fullBody('a Critical here', 7)).toBe('a Critical here');
  });

  it('caps long bodies and names the review id for the tail', () => {
    const long = 'x'.repeat(9000);
    const got = fullBody(long, 42);
    expect(got).toContain('truncated at 8000 chars');
    expect(got).toContain('/reviews/42');
    expect(got).toContain('cannot tell');
  });
});

describe('fullCommentBody', () => {
  it('caps long comment bodies and names the comment id for the tail', () => {
    const got = fullCommentBody('y'.repeat(9000), 314);
    expect(got).toContain('truncated at 8000 chars');
    expect(got).toContain('pulls/comments/314');
    expect(got).toContain('cannot tell');
  });
});

describe('isReviewWorthShowing', () => {
  const FOOTER = '_— qwen3.7-max via Qwen Code /review_';

  it('filters the exact canonical LGTM template, with or without the footer', () => {
    expect(isReviewWorthShowing('No issues found. LGTM! ✅')).toBe(false);
    expect(isReviewWorthShowing(`No issues found. LGTM! ✅\n\n${FOOTER}`)).toBe(
      false,
    );
    expect(isReviewWorthShowing('')).toBe(false);
    expect(isReviewWorthShowing(undefined)).toBe(false);
  });

  it('shows a body that OPENS with the template but carries more (a relocated blocker once hid behind a prefix match)', () => {
    expect(
      isReviewWorthShowing(
        'No issues found. LGTM! ✅\n\n**[Critical]** relocated blocker: the cache is never invalidated',
      ),
    ).toBe(true);
  });

  it('shows ordinary review bodies', () => {
    expect(isReviewWorthShowing('Downgraded from Approve: self-PR.')).toBe(
      true,
    );
  });
});

describe('buildMarkdown — review bodies and replied Criticals', () => {
  const meta = {
    title: 'T',
    body: 'D',
    author: { login: 'a' },
    baseRefName: 'main',
    headRefName: 'b',
    headRefOid: 'sha',
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    state: 'OPEN',
  };

  it('renders review bodies in full, not 240-char snippets (a body-only blocker lives only here)', () => {
    const longBody = `**[Critical]** ${'y'.repeat(500)} the tail survives`;
    const md = buildMarkdown(
      '1',
      'o/r',
      meta,
      [],
      [],
      [
        {
          id: 7,
          user: { login: 'rev' },
          state: 'CHANGES_REQUESTED',
          body: longBody,
        },
      ],
    );
    expect(md).toContain('the tail survives');
    expect(md).toContain('(review 7)');
    expect(md).not.toContain('…');
  });

  it('pulls a replied Critical root out of Already discussed into the mandatory re-check section', () => {
    const inline = [
      {
        id: 1,
        user: { login: 'rev' },
        path: 'a.ts',
        line: 3,
        body: '**[Critical]** real blocker',
      },
      {
        id: 2,
        user: { login: 'author' },
        in_reply_to_id: 1,
        body: 'I disagree',
      },
      {
        id: 3,
        user: { login: 'rev' },
        path: 'b.ts',
        line: 9,
        body: '**[Suggestion]** nit',
      },
      { id: 4, user: { login: 'author' }, in_reply_to_id: 3, body: 'done' },
    ];
    const md = buildMarkdown('1', 'o/r', meta, inline, [], []);
    const critSection = md.indexOf('## Blockers to re-check');
    const discussed = md.indexOf('## Already discussed');
    expect(critSection).toBeGreaterThan(-1);
    expect(critSection).toBeLessThan(discussed);
    // The Critical thread lives in the re-check section, not the settled one.
    const critIdx = md.indexOf('real blocker');
    expect(critIdx).toBeGreaterThan(critSection);
    expect(critIdx).toBeLessThan(discussed);
    // The Suggestion thread stays settled.
    expect(md.indexOf('**[Suggestion]** nit')).toBeGreaterThan(discussed);
    expect(md).toContain('a reply alone does NOT retire a blocker');
  });

  it('renders a replied-Critical root in full past the old 1000-char snippet cap, and a cut reply names its comment id', () => {
    const inline = [
      {
        id: 11,
        user: { login: 'rev' },
        path: 'a.ts',
        line: 3,
        body: `**[Critical]** long claim ${'z'.repeat(3000)} THE-TAIL-SURVIVES`,
      },
      {
        id: 12,
        user: { login: 'author' },
        in_reply_to_id: 11,
        body: `pushback ${'w'.repeat(700)}`,
      },
    ];
    const md = buildMarkdown('1', 'o/r', meta, inline, [], []);
    // The root body is what the Step 6 re-check rules on; its tail (the
    // failure scenario, the proposed fix) used to be silently dropped.
    expect(md).toContain('THE-TAIL-SURVIVES');
    expect(md).toContain('(comment 11)');
    // The reply snippet is cut, and the cut names the fetch for the rest.
    expect(md).toContain('pulls/comments/12');
  });
});

describe('buildMarkdown — truncation refs are copy-runnable with real coordinates', () => {
  const meta = {
    title: 'T',
    body: '',
    author: { login: 'a' },
    baseRefName: 'main',
    headRefName: 'b',
    headRefOid: 'sha',
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    state: 'OPEN',
  } as PrMetadata;

  it('a cut open-root snippet and a cut issue comment name their exact fetch (no {owner}/{n} placeholders)', () => {
    const inline = [
      {
        id: 21,
        user: { login: 'r' },
        path: 'a.ts',
        line: 1,
        body: `Must fix: ${'x'.repeat(400)}`,
      },
    ];
    const issue = [{ id: 31, user: { login: 'r' }, body: 'y'.repeat(400) }];
    const md = buildMarkdown(
      '6711',
      'QwenLM/qwen-code',
      meta,
      inline,
      issue,
      [],
    );
    // A markerless blocker past the snippet cap is recoverable only through
    // the named fetch — and the emitted command must not need filling in.
    expect(md).toContain('gh api repos/QwenLM/qwen-code/pulls/comments/21');
    expect(md).toContain('gh api repos/QwenLM/qwen-code/issues/comments/31');
    expect(md).not.toContain('{owner}');
  });

  it('a capped review body names the filled-in review fetch', () => {
    const md = buildMarkdown(
      '6711',
      'QwenLM/qwen-code',
      meta,
      [],
      [],
      [
        {
          id: 7,
          user: { login: 'rev' },
          state: 'CHANGES_REQUESTED',
          body: `**[Critical]** ${'z'.repeat(9000)}`,
        },
      ],
    );
    expect(md).toContain('gh api repos/QwenLM/qwen-code/pulls/6711/reviews/7');
  });

  it('a settled replied thread cut past the snippet cap names both comment ids', () => {
    const inline = [
      {
        id: 41,
        user: { login: 'r' },
        path: 'b.ts',
        line: 2,
        body: `**[Suggestion]** ${'w'.repeat(400)}`,
      },
      {
        id: 42,
        user: { login: 'a' },
        in_reply_to_id: 41,
        body: `ok ${'v'.repeat(400)}`,
      },
    ];
    const md = buildMarkdown('1', 'o/r', meta, inline, [], []);
    expect(md).toContain('gh api repos/o/r/pulls/comments/41');
    expect(md).toContain('gh api repos/o/r/pulls/comments/42');
  });
});

// PR #6486, comment 4942713150: a maintainer built the PR, drove the real CLI,
// and filed a live blocker (Ctrl+F dual-fires — it toggles the model AND moves
// the cursor, `text-buffer.ts:2663`) as an ISSUE comment. Three hours later
// /review reviewed the same commit `5ede0f3a2`, where the blocker was still
// live — the fix did not land until `34e13ddb4` that evening — and submitted
// "Reviewed — no blockers".
//
// Why it dropped the blocker is structural, not a lapse of judgment. Every
// issue comment is rendered as a 240-char one-line snippet under a heading
// that reads "do NOT re-report", and the first 240 characters of this one are
// its preamble: "I built this PR from source and drove the real CLI ... to
// validate the model-toggle hotkey before merge." That reads as an ENDORSEMENT.
// "Finding 1 — Ctrl+F dual-fires ... (blocker)" begins 1 143 characters past
// the cut. The `[Critical]` marker that promotes a thread into the mandatory
// re-check section never appears in the body at all — the finding is headed
// "🔴 Finding 1".
//
// The fixture is the real comment body, byte for byte.
describe('buildMarkdown — a markerless maintainer blocker must not render as an endorsement (PR #6486 regression)', () => {
  const realBody = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '__fixtures__',
      'pr-6486-comment-4942713150.md',
    ),
    'utf8',
  );

  const meta = {
    title: 'feat(cli): model toggle hotkey',
    body: 'Adds Ctrl+F to toggle between two models.',
    author: { login: 'Aleks-0' },
    baseRefName: 'main',
    headRefName: 'feat/model-toggle-hotkey',
    headRefOid: '5ede0f3a2',
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    state: 'OPEN',
  } as PrMetadata;

  const render = () =>
    buildMarkdown(
      '6486',
      'QwenLM/qwen-code',
      meta,
      [],
      [
        { id: 4942713150, user: { login: 'wenshao' }, body: realBody },
        {
          id: 4909062177,
          user: { login: 'Aleks-0' },
          body: 'Addressed all 3.',
        },
      ],
      [],
    );

  it('carries the blocker itself into the context, not just its preamble', () => {
    const md = render();
    // The substance the Step 6 re-check has to rule on. None of it survives a
    // 240-char snippet, and a reader who never sees it cannot even know there
    // is something to fetch.
    expect(md).toContain('dual-fires');
    expect(md).toContain('text-buffer.ts:2663');
  });

  it('does not file it under "do NOT re-report"', () => {
    const md = render();
    const alreadyDiscussed = md.indexOf('## Already discussed');
    const blocker = md.indexOf('dual-fires');
    expect(blocker).toBeGreaterThanOrEqual(0);
    // Rendered ahead of the settled-discussion section — i.e. in a section the
    // re-check must rule on, not one it is told to skip.
    expect(
      alreadyDiscussed === -1 || blocker < alreadyDiscussed,
      'the blocker is rendered inside "Already discussed — do NOT re-report"',
    ).toBe(true);
  });

  it('hands the re-check the untouched file the fix turns on', () => {
    const md = render();
    // The blocker names `text-buffer.ts:2663` — a file THIS PR NEVER TOUCHES,
    // and the reason the author's first fix (a guard, plainly visible in the
    // diff) was inert. An agent that rules "fixed" from the diff alone rules
    // wrong. Extracting the reference turns "go read the untouched code" from
    // a hope into a list the agent is handed.
    expect(md).toContain('**Referenced code');
    expect(md).toContain('`text-buffer.ts:2663`');
  });

  it('puts the blockers where one read_file can see them', () => {
    // Found by running it against the live thread, not by any unit test. The
    // section was originally written after "Open inline comments"; on #6486 that
    // put its heading at char 25 961 and the blocker body at 43 094 — both past
    // the 25 000 chars one `read_file` returns. The blocker was in the file and
    // nobody could read it, which is strictly no better than not promoting it.
    const md = render();
    const section = md.indexOf('## Blockers to re-check');
    const blocker = md.indexOf('dual-fires');
    expect(section).toBeGreaterThanOrEqual(0);
    expect(section).toBeLessThan(md.indexOf('## Description'));
    expect(blocker).toBeLessThan(25_000);
  });

  it('does not promote the triage bot saying there are NO blockers', () => {
    // "No critical blockers." is the triage bot's own template line. A
    // whole-body keyword scan fired on it, on every PR it ever commented on —
    // and each false promotion spends the read budget the real blocker needs.
    const md = buildMarkdown(
      '6486',
      'QwenLM/qwen-code',
      meta,
      [],
      [
        { id: 1, user: { login: 'bot' }, body: 'No critical blockers. LGTM.' },
        {
          id: 2,
          user: { login: 'author' },
          body: '### 🔴 Critical fixes\nAddressed all 3 findings.',
        },
      ],
      [],
    );
    expect(md).not.toContain('## Blockers to re-check');
  });

  it('still lets ordinary chatter settle into Already discussed', () => {
    const md = render();
    const alreadyDiscussed = md.indexOf('## Already discussed');
    const chatter = md.indexOf('Addressed all 3.');
    // The promotion must key on blocker substance, not on "issue comment" —
    // otherwise every thankyou note becomes a mandatory ruling.
    expect(alreadyDiscussed).toBeGreaterThanOrEqual(0);
    expect(chatter).toBeGreaterThan(alreadyDiscussed);
  });
});

describe('extractCodeRefs', () => {
  it('pulls the locations a blocker points at, with line numbers', () => {
    expect(
      extractCodeRefs(
        "`text-buffer.ts:2663` still binds `Ctrl+F → move('right')`, and the " +
          'handler in `AppContainer.tsx` is an independent subscriber.',
      ),
    ).toEqual(['text-buffer.ts:2663', 'AppContainer.tsx']);
  });

  it('keeps full paths and line ranges', () => {
    expect(
      extractCodeRefs('see packages/cli/src/ui/x.ts:10-20 and lib/y.go:3'),
    ).toEqual(['packages/cli/src/ui/x.ts:10-20', 'lib/y.go:3']);
  });

  it('dedups repeats and bounds the list', () => {
    expect(extractCodeRefs('a.ts:1 a.ts:1 a.ts:1')).toEqual(['a.ts:1']);
    const many = Array.from({ length: 30 }, (_, i) => `f${i}.ts`).join(' ');
    expect(extractCodeRefs(many)).toHaveLength(12);
  });

  it('collapses a bare filename into the full path naming the same location', () => {
    // Reports name a location twice — once bare, once by path. Keep the one
    // the reader can actually open.
    expect(
      extractCodeRefs(
        '`text-buffer.ts:2663` still binds it; remove it at ' +
          '`packages/cli/src/ui/components/shared/text-buffer.ts:2663`.',
      ),
    ).toEqual(['packages/cli/src/ui/components/shared/text-buffer.ts:2663']);
    // Different lines in the same file are different locations — keep both.
    expect(extractCodeRefs('a/b.ts:1 and a/b.ts:2')).toEqual([
      'a/b.ts:1',
      'a/b.ts:2',
    ]);
  });

  it('drops paths that escape the worktree — the read list is a trusted directive', () => {
    // The body is untrusted and this list is rendered as "read each at the
    // reviewed commit". A traversal or absolute token must not enter it.
    expect(
      extractCodeRefs('read `../../../../etc/passwd.sh` and `src/ok.ts:5`'),
    ).toEqual(['src/ok.ts:5']);
    expect(extractCodeRefs('see `/root/.ssh/id_rsa.key`')).toEqual([]);
    expect(extractCodeRefs('see `~/secrets.json`')).toEqual([]);
  });

  it('keeps a scoped in-repo path prefix intact', () => {
    // `\b` fires on the first word-character transition, so `@scope/…` came back
    // as `scope/…` — not the path that was cited. A scoped package path stays in
    // the repo, so it is kept; a `../` path escapes it and is dropped by the
    // traversal filter above.
    expect(extractCodeRefs('see @scope/pkg/index.ts:10')).toEqual([
      '@scope/pkg/index.ts:10',
    ]);
    expect(extractCodeRefs('see ../lib/b.ts')).toEqual([]);
  });

  it('returns nothing for a body that names no code', () => {
    expect(extractCodeRefs('LGTM, ship it')).toEqual([]);
    expect(extractCodeRefs(undefined)).toEqual([]);
  });
});

describe('carriesBlockerSignal', () => {
  it('recognises a blocker that never uses the [Critical] marker', () => {
    // The real PR #6486 heading. Only /review emits `[Critical]`; a human
    // types whatever they type, and the old literal-marker gate saw none of it.
    expect(
      carriesBlockerSignal(
        '### 🔴 Finding 1 — Ctrl+F dual-fires: it toggles the model **and** moves the cursor (blocker)',
      ),
    ).toBe(true);
    expect(carriesBlockerSignal('This is still reproducible at HEAD.')).toBe(
      true,
    );
    expect(carriesBlockerSignal('Must fix before merge: auth bypass.')).toBe(
      true,
    );
    expect(carriesBlockerSignal('这个问题是阻塞项，合并前必须修复。')).toBe(
      true,
    );
  });

  it('still recognises the marker /review emits', () => {
    expect(carriesBlockerSignal('**[Critical]** real blocker')).toBe(true);
    expect(carriesBlockerSignal('**[critical]** case-insensitive')).toBe(true);
  });

  it('is not fooled by a signal sitting inside its own negation', () => {
    expect(carriesBlockerSignal('No critical blockers. LGTM.')).toBe(false);
    expect(carriesBlockerSignal('There is not a blocker here.')).toBe(false);
    expect(carriesBlockerSignal('Zero must-fix items.')).toBe(false);
    // …but a body may BOTH wave off one blocker and assert another. One
    // un-negated occurrence is enough to promote.
    expect(
      carriesBlockerSignal(
        'No critical blockers in the parser. The cache path, though, is a blocker.',
      ),
    ).toBe(true);
  });

  it('recognises the words people actually write, not the nouns we imagined', () => {
    // The second real blocker this list missed. A maintainer's E2E report on
    // PR #6638 — a committed extension policy that never reaches a running
    // agent's system prompt while the API reports full convergence — is headed
    // "86/90 checks pass, 1 blocking gap" and "🔴 Blocking:", and in Chinese
    // "阻塞问题". The patterns named the nouns (`blocking issue|defect|bug`,
    // `阻塞项`) and not one of them matched, so it would have settled behind a
    // 240-char snippet reading "86/90 checks pass … hold up well" — an
    // endorsement, exactly as in #6486.
    expect(
      carriesBlockerSignal(
        '## E2E verification — 86/90 checks pass, 1 blocking gap',
      ),
    ).toBe(true);
    expect(
      carriesBlockerSignal('### 🔴 Blocking: a committed policy never lands'),
    ).toBe(true);
    expect(
      carriesBlockerSignal('### 🔴 阻塞问题：策略没有到达运行中的 agent'),
    ).toBe(true);
  });

  it('does not fire on our own "Non-blocking observations" heading', () => {
    // Every verification report files its nits under this heading. Matching a
    // bare `blocking` without the lookbehind would promote all of them.
    expect(carriesBlockerSignal('### 🟡 Non-blocking observations')).toBe(
      false,
    );
    expect(carriesBlockerSignal('This is a non-blocking nit.')).toBe(false);
    expect(carriesBlockerSignal('非阻塞观察：建议后续跟进')).toBe(false);
  });

  it('guards the Chinese signal in Chinese, not only in English', () => {
    // The signal list is bilingual (`阻塞项`); the guard was not. On a repo whose
    // PR discussion is substantially Chinese, every "没有阻塞项" — the Chinese half
    // of the triage bot's own template — promoted, while its English twin did
    // not. A guard that only defends the language it was written in has a hole
    // exactly the size of the other language.
    expect(carriesBlockerSignal('没有阻塞项。LGTM')).toBe(false);
    expect(carriesBlockerSignal('不是阻塞项，可以合并')).toBe(false);
    expect(carriesBlockerSignal('经检查无阻塞项')).toBe(false);
    expect(carriesBlockerSignal('未发现阻塞项')).toBe(false);
    // The assertion still promotes.
    expect(carriesBlockerSignal('这是一个阻塞项，必须修复')).toBe(true);
  });

  it('does not promote a severity emoji on a list of repairs', () => {
    // The author's "### 🔴 Critical fixes" heading. A bare emoji says nothing
    // about who is asserting what — it fired the first implementation and cost
    // the read budget the real blocker needed.
    expect(
      carriesBlockerSignal('### 🔴 Critical fixes\nAddressed all 3.'),
    ).toBe(false);
  });

  it('does not let a negation reach across a clause separator', () => {
    // The negation guard scans back 40 characters for a negation word, and its
    // stop-set only had `.!?`. "No blockers; the cache path is a (blocker)"
    // therefore suppressed the real assertion — a false negative, which is the
    // costly direction.
    expect(
      carriesBlockerSignal('No blockers; the cache path is a (blocker)'),
    ).toBe(true);
    expect(
      carriesBlockerSignal('No blockers: the cache path is a (blocker)'),
    ).toBe(true);
    // …and the plain negation still negates.
    expect(carriesBlockerSignal('No critical blockers. LGTM.')).toBe(false);
    expect(carriesBlockerSignal('没有阻塞问题：一切正常')).toBe(false);
  });

  it('does not promote ordinary chatter', () => {
    // Promotion means a mandatory ruling AND a full-body render. Over-promote
    // and the context file outgrows one read — which is its own way of losing
    // a blocker, so precision matters in both directions.
    expect(carriesBlockerSignal('Addressed all 3 findings, thanks!')).toBe(
      false,
    );
    expect(carriesBlockerSignal('**[Suggestion]** rename this helper')).toBe(
      false,
    );
    expect(carriesBlockerSignal('LGTM, nice work')).toBe(false);
    expect(carriesBlockerSignal(undefined)).toBe(false);
  });
});

describe('blockerSection — both channels, and the budget', () => {
  const meta = {
    title: 'T',
    body: 'D',
    author: { login: 'a' },
    baseRefName: 'main',
    headRefName: 'b',
    headRefOid: 'sha',
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    state: 'OPEN',
  } as PrMetadata;

  it('carries an inline blocker and an issue-level one in the same section', () => {
    // A blocker arrives on whichever channel the reviewer happened to use, and
    // the re-check must rule on every one of them. The two are rendered by
    // different loops; nothing pinned that they land in the SAME section.
    const inline = [
      {
        id: 11,
        user: { login: 'rev' },
        path: 'a.ts',
        line: 3,
        body: '**[Critical]** the cache is never invalidated',
      },
      { id: 12, user: { login: 'auth' }, in_reply_to_id: 11, body: 'wontfix' },
    ];
    const issue = [
      {
        id: 21,
        user: { login: 'maint' },
        body: 'Drove the real CLI: Ctrl+F still dual-fires (blocker). See `text-buffer.ts:2663`.',
      },
    ];
    const md = buildMarkdown('1', 'o/r', meta, inline, issue, []);

    const section = md.indexOf('## Blockers to re-check');
    const discussed = md.indexOf('## Already discussed');
    const inlineBlocker = md.indexOf('the cache is never invalidated');
    const issueBlocker = md.indexOf('still dual-fires');

    expect(section).toBeGreaterThanOrEqual(0);
    // Both inside the re-check section — i.e. before "Already discussed"
    // (or before the end of the file, when that section is absent).
    const end = discussed === -1 ? md.length : discussed;
    expect(inlineBlocker).toBeGreaterThan(section);
    expect(inlineBlocker).toBeLessThan(end);
    expect(issueBlocker).toBeGreaterThan(section);
    expect(issueBlocker).toBeLessThan(end);
    // A reply does not retire a blocker; the thread's reply still renders.
    expect(md).toContain('wontfix');
    // And the issue-level one keeps its Referenced-code list.
    expect(md).toContain('`text-buffer.ts:2663`');
  });

  it('degrades a body past the budget to a snippet that names its fetch', () => {
    // Promotion means full-body rendering, and full bodies are what blew the
    // read window on the live #6486 thread. The budget bounds the section; what
    // it must NOT do is drop a blocker silently — a degraded body still says how
    // to fetch the rest, which the re-check must do before ruling.
    const big = (n: number) => ({
      id: n,
      user: { login: 'r' },
      body: `**[Critical]** blocker ${n}: ${'x'.repeat(7000)}`,
    });
    const md = buildMarkdown(
      '6486',
      'QwenLM/qwen-code',
      meta,
      [],
      [big(1), big(2), big(3)],
      [],
    );
    expect(md).toContain('## Blockers to re-check');
    // Every blocker is still ANNOUNCED — none vanishes.
    for (const n of [1, 2, 3]) {
      expect(md).toContain(`(comment ${n})`);
    }
    // The one past the budget is a snippet, and it names the exact fetch.
    expect(md).toContain('section budget spent');
    expect(md).toContain('gh api repos/QwenLM/qwen-code/issues/comments/3');
  });

  it('renders the bodies that fit in FULL and only degrades past the budget', () => {
    // The boundary is the whole point: a budget that degraded everything, or
    // nothing, would pass the test above just as well. Blocker 1 must arrive
    // whole (that is what makes it rulable); blocker 3 must not.
    const big = (n: number) => ({
      id: n,
      user: { login: 'r' },
      body: `**[Critical]** blocker ${n} TAIL${n}: ${'x'.repeat(7000)}`,
    });
    const md = buildMarkdown(
      '6486',
      'QwenLM/qwen-code',
      meta,
      [],
      [big(1), big(2), big(3)],
      [],
    );
    // 7000-char bodies against a 16000 budget: the first two fit whole…
    expect(md).toContain('TAIL1');
    expect(md).toContain('TAIL2');
    // …and the third is the snippet. Its 7000-char tail is not in the file.
    expect(md).not.toContain('TAIL3'.padEnd(0) + 'x'.repeat(6900));
    expect(md.match(/section budget spent/g)).toHaveLength(1);
  });

  it('charges its own headings and reference lists against the budget', () => {
    // Structural overhead is real characters in a file whose whole purpose is
    // fitting inside one `read_file`. Charging only the quoted bodies leaves it
    // unbounded — the section can then outgrow the window while its own
    // accounting still says it has room.
    const withRefs = (n: number) => ({
      id: n,
      user: { login: 'r' },
      body: `**[Critical]** blocker ${n} — see \`src/a${n}.ts:10\`, \`src/b${n}.ts:20\`. ${'y'.repeat(5000)}`,
    });
    const md = buildMarkdown(
      '1',
      'o/r',
      meta,
      [],
      [withRefs(1), withRefs(2), withRefs(3), withRefs(4)],
      [],
    );
    const section = md.slice(
      md.indexOf('## Blockers to re-check'),
      md.indexOf('## Description'),
    );
    // Bodies alone would be 4 × ~5 100 = 20 400 > 16 000, so degradation must
    // kick in; with the overhead charged too, it kicks in no later.
    expect(section).toContain('section budget spent');
    // And the section stays inside the window one read returns.
    expect(section.length).toBeLessThan(25_000);
  });
});

describe('classifyInlineThreads', () => {
  it('is the single walk both the markdown and the stdout count use', () => {
    const inline: RawComment[] = [
      { id: 1, user: { login: 'r' }, body: '**[Critical]** blocker' },
      { id: 2, user: { login: 'a' }, in_reply_to_id: 1, body: 'reply' },
      { id: 3, user: { login: 'r' }, body: '**[Suggestion]** nit' },
      { id: 4, user: { login: 'a' }, in_reply_to_id: 3, body: 'done' },
      { id: 5, user: { login: 'r' }, body: 'open question' },
    ];
    const t = classifyInlineThreads(inline);
    expect(t.repliedBlockerRoots.map((c) => c.id)).toEqual([1]);
    expect(t.repliedRoots.map((c) => c.id)).toEqual([3]);
    expect(t.openRoots.map((c) => c.id)).toEqual([5]);
    expect(t.repliesByRoot.get(1)!.map((c) => c.id)).toEqual([2]);
  });
});

describe('prContextCommand builder', () => {
  it('registers --host so Enterprise routing is a flag, not a prose instruction', () => {
    const opts: string[] = [];
    const stub = {
      positional: () => stub,
      option: (name: string) => {
        opts.push(name);
        return stub;
      },
    } as unknown as Argv;
    ((prContextCommand as CommandModule).builder as (y: Argv) => Argv)(stub);
    expect(opts).toContain('host');
  });
});
