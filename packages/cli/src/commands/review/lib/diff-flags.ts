/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The flags every /review diff capture pins, in one place.
//
// Two capture paths produce the diff the whole review reads: `fetch-pr` (a PR's
// merge-base..head) and `capture-local` (the working tree). They must pin the
// same knobs, because the parser downstream is the same and a diff that parses
// under one and not the other is a coverage hole nobody sees — `plan-diff`
// would simply report fewer chunks. Keeping the list in two places invites
// exactly that drift, so it lives here.

/**
 * Config overrides that have no command-line equivalent.
 *
 * `diff.suppressBlankEmpty`: with it set, git prints a blank context line as a
 * physically empty record rather than a lone space, and the parser's new-side
 * cursor must know which it is getting.
 *
 * `core.quotePath=false`: git's DEFAULT is to C-style-quote any path with a
 * non-ASCII byte — `"docs/\\346\\236\\266\\346\\236\\204.md"`. Nothing
 * downstream is broken by that on its own; `parseDiff` unquotes, so the chunk
 * plan and the containment oracle name such a path correctly either way. The
 * pin is about there being ONE shape rather than two: it is the capture, not
 * each reader, that decides how a path is spelled, so a consumer that reads
 * the raw diff text — or a new one written against the unquoted form, which is
 * what every existing reader assumes — cannot be silently wrong for the subset
 * of repositories that have a non-ASCII filename.
 */
export const PINNED_DIFF_CONFIG: readonly string[] = [
  '-c',
  'diff.suppressBlankEmpty=false',
  '-c',
  'core.quotePath=false',
  // The HUNK SHAPE, which the flags above do not pin: `diff.algorithm` and
  // `diff.indentHeuristic` move where a hunk starts and ends with the blobs,
  // the mode and the attributes all standing still. Pinned to git's own
  // defaults so two checkouts render one diff the same way.
  //
  // These two are NOT the boundary of the per-file verdict identity, and
  // that identity is not a class to be closed one knob at a time. It
  // certifies CONTENT: the `<mode> <oid>` pair, plus the attributes that
  // decide whether the content is rendered at all (`binary`, `-diff`,
  // `text`, a driver's `binary`) — and the knobs that could HIDE content
  // from a reviewer are pinned by the flags below (`--no-ext-diff`,
  // `--no-textconv`, `--ignore-submodules=none`). Every remaining diff knob
  // — inter-hunk context, an order file, function-name headers, a
  // driver-scoped algorithm, the rename limit — changes how the same changed
  // lines are grouped, ordered or labelled, never which lines changed (a
  // rename the limit demotes to delete+add shows MORE of the file, and the
  // added side's absent base never transfers, per `changedPairs`).
  // Presentation is not certified, so it is not recorded.
  '-c',
  'diff.algorithm=myers',
  '-c',
  'diff.indentHeuristic=true',
];

/**
 * Flags pinned against user config on every diff we parse.
 *
 * `color.diff=always` alone injects ANSI escapes that make every `diff --git`
 * line unrecognisable — the plan comes back with zero chunks and the review
 * reads nothing. `diff.external` and textconv filters emit output that is not a
 * unified diff at all. `diff.mnemonicPrefix` renames the `a/`/`b/` prefixes to
 * `i/`/`w/`, which `stripPrefix` does not know. `diff.context` changes how many
 * lines each hunk carries. `diff.renames=false` reports a move as delete + add.
 * `diff.relative` strips the repo prefix from every path when git runs from a
 * subdirectory. `diff.ignoreSubmodules=all` hides a changed gitlink entirely,
 * and `diff.submodule=log` replaces the whole section with prose.
 */
export const PINNED_DIFF_FLAGS: readonly string[] = [
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--unified=3',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--find-renames',
  '--no-relative',
  '--ignore-submodules=none',
  '--submodule=short',
];

/**
 * The name git accepts for "the empty side" of a diff.
 *
 * `git diff --no-index -- <null> <file>` is how a file git does not track gets
 * rendered as a new file without writing to the index. Git special-cases both
 * spellings in `diff-no-index.c`'s `get_mode()` rather than stat-ing them, but
 * only `nul` is special-cased on native Windows — so pick by platform instead of
 * betting the Windows CI leg on which branch of that function is compiled in.
 */
export const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

/**
 * Read every pathspec as a plain name.
 *
 * `--` ends option parsing; it does not turn off **pathspec magic**. A filename
 * is not a pathspec — `a[bc].ts` is a glob — so scoping a review to that one
 * file also pulls in `ab.ts` and `ac.ts`, and a leading `:` opens the magic
 * syntax outright. Every command that takes a user-supplied path pins this.
 */
export const LITERAL_PATHSPECS = '--literal-pathspecs';
