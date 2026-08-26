/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review revert-hunk`: take ONE hunk of the diff back out of a tree, so
// "is this change load-bearing?" can be measured instead of argued.
//
// The probe answers "does the PR's code exhibit the claimed behaviour", and
// the A/B answers "did the base behave differently". Between them sits a
// question both leave open: whether EACH change in the diff is needed for the
// behaviour the PR claims — the fix that is really two fixes and only one is
// exercised, the hunk that is dead weight, the "refactor" hunk a fix rode in
// on. Maintainer verification answers it the same way every time: revert
// exactly one hunk, re-run the probe that the intact tree passes, and watch
// whether the behaviour reverts with it. The probe pair (intact vs reverted)
// is the witness; a hunk whose revert flips nothing is either not load-bearing
// or the probe is too weak to see it — both worth knowing before an Approve.
//
// The judgment half — WHICH probe to run and what its flip means — stays with
// the verifier. What was hand-done every time, and hand-done wrongly, is the
// mechanical half: extracting hunk N of file F out of a unified diff. By-hand
// extraction means sed ranges over a 5 000-line diff file, and a range that is
// off by one line silently produces a DIFFERENT mutation than the one the
// report claims was tested — the transcription failure this skill has measured
// in every place a hand copies what a command could carry. So this command
// owns: enumerating the diff's hunks under stable ids, extracting one verbatim
// (its file headers and its `\ No newline` markers with it), and applying it
// in REVERSE via git's own patch engine — never a reimplementation of it.
//
// Two facts the report states rather than papering over:
//  - A hunk that will not revert independently (its context overlaps another
//    hunk's edits) is a FACT about the diff's internal coupling, not a failure:
//    "hunk 3 depends on hunk 1" is itself evidence about what is load-bearing.
//  - The tree this runs in should be the verifier's own scratch tree. The
//    command does not know where the shared review worktree is, so it cannot
//    refuse it — but a revert left in the shared tree is exactly the #9207
//    residue class, which is why the brief sends every mutation here through
//    `scratch-tree` first.

import type { CommandModule } from 'yargs';
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DiffFile } from './lib/diff-plan.js';
import { parseDiff } from './lib/diff-plan.js';
import { sanitizedGitEnv } from './lib/worktree.js';
import { assertWritableOutPath } from './lib/paths.js';
import {
  ignoreBrokenPipe,
  writeStdoutLineSafe,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';

/** One enumerable hunk, under the id `--hunk` accepts. */
export interface HunkEntry {
  /** `<new-side path>:<n>`, n 1-based within the file. The selector. */
  id: string;
  path: string;
  n: number;
  /** The `@@ ...` header line, verbatim — enough to recognise the hunk. */
  header: string;
  addedLines: number;
  removedLines: number;
}

export interface RevertHunkReport {
  /** True when the reverse patch is IN the tree — the only state worth probing. */
  applied: boolean;
  hunk?: HunkEntry;
  /**
   * git's own refusal text when the hunk does not apply in reverse. Coupling
   * to another hunk's edits is the common cause; a tree already mutated at the
   * same lines is the other. Either way the tree is UNCHANGED — `--check`
   * runs first, so a refused revert never half-applies.
   */
  conflict?: string;
  /**
   * True when `applied` is false because the HARNESS failed (git unrunnable
   * in --tree, killed, or `fatal:`), or because the INVOCATION was
   * repairable (a bad selector, a hunk that does not exist, an unsupported
   * diff prefix) — neither is the genuine coupling refusal exit 1 is for.
   * The handler maps it to exit 2 (repair the invocation / harness), never
   * exit 1 (a refusal a calling script records as a coupling fact).
   */
  harnessFailure?: boolean;
  /** What happened, one line, rendered to the verifier verbatim. */
  note: string;
}

/**
 * The 1-based line of a hunk's LAST body line, bounded by the `@@ -a,b +c,d @@`
 * header's declared old/new line counts rather than by `parseDiff`'s range.
 *
 * parseDiff leaves the final hunk's range open to EOF, so for a single-commit
 * `git format-patch -1 --stdout` capture (in scope for arbitrary `--diff`) the
 * mbox signature trailer (`-- \n<version>\n`) falls inside `[diffStart,
 * diffEnd]`. Its `-- ` line's first byte is `-`, so a raw scan counts it as a
 * removed line (fabricating `removedLines`) and a raw slice appends the trailer
 * bytes to the extracted patch. Consuming exactly the header's declared counts
 * stops at the last real body line instead. Falls back to `diffEnd` when the
 * header is unparseable, so a malformed header never regresses behaviour.
 */
function hunkBodyEnd(
  lines: string[],
  hunk: { diffStart: number; diffEnd: number },
): number {
  const header = lines[hunk.diffStart - 1] ?? '';
  const m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(header);
  if (!m) return hunk.diffEnd;
  let oldRem = m[1] === undefined ? 1 : Number(m[1]);
  let newRem = m[2] === undefined ? 1 : Number(m[2]);
  let ln = hunk.diffStart; // the `@@` line; the body begins at +1
  while ((oldRem > 0 || newRem > 0) && ln < hunk.diffEnd) {
    ln++;
    const body = lines[ln - 1];
    const c = body?.[0];
    // `body === ''`: under `diff.suppressBlankEmpty` git emits a blank context
    // line as a physically EMPTY record. `parseDiff` counts it as context and
    // git's own patch engine accepts it, so the body must not end at it — a
    // truncation there leaves the `@@` header's declared counts unmatched and
    // `git apply -R --check` fails with `corrupt patch`, misread as a tree or
    // harness problem.
    if (c === ' ' || body === '') {
      oldRem--;
      newRem--;
    } else if (c === '-') oldRem--;
    else if (c === '+') newRem--;
    else if (c === '\\') {
      // `\ No newline at end of file` — a marker on the previous line, consumes
      // neither side.
    } else break; // a trailer or anything else is past the hunk body.
  }
  // A `\ No newline at end of file` marker for the LAST counted line trails it,
  // after both counts have reached zero; absorb any such marker line so it
  // stays with the hunk (the format-patch trailer starts with `-`, not `\`, so
  // it is never re-absorbed here).
  while (ln < hunk.diffEnd && lines[ln]?.[0] === '\\') ln++;
  return ln;
}

/**
 * Enumerate the diff's hunks. Binary and mode-only sections carry none and
 * are simply absent — there is nothing of theirs to revert.
 */
export function listHunks(diffText: string): HunkEntry[] {
  const lines = diffText.split('\n');
  const { files } = parseDiff(diffText);
  const out: HunkEntry[] = [];
  for (const f of files) {
    f.hunks.forEach((h, i) => {
      let added = 0;
      let removed = 0;
      // Body starts after the `@@` line, bounded by the header's declared
      // counts (see `hunkBodyEnd`) so a format-patch signature trailer inside
      // the final hunk's open range is not miscounted as a removed line.
      const end = hunkBodyEnd(lines, h);
      for (let ln = h.diffStart + 1; ln <= end; ln++) {
        const c = lines[ln - 1]?.[0];
        if (c === '+') added++;
        else if (c === '-') removed++;
      }
      out.push({
        id: `${f.path}:${i + 1}`,
        path: f.path,
        n: i + 1,
        header: lines[h.diffStart - 1] ?? '',
        addedLines: added,
        removedLines: removed,
      });
    });
  }
  return out;
}

/**
 * File-level header metadata that must NOT ride into a single-hunk patch.
 * `git apply -R` re-executes whatever the header carries alongside the one
 * selected hunk: rename lines rewind the RENAME (the tree ends with the file
 * at its old path while the report claims a content revert at the new one),
 * and mode lines flip the permission bits. Both are mutations different from
 * the one the report names — the harness-fabricated kind. `deleted file
 * mode` / `new file mode` stay: they ARE the content semantics of a
 * deletion/creation section, which cannot also be a rename.
 */
const FILE_LEVEL_METADATA_RE =
  /^(?:similarity index |dissimilarity index |rename from |rename to |copy from |copy to |old mode |new mode )/;

/**
 * Extract hunk `n` (1-based) of `file` as a minimal, self-contained patch:
 * the file's header block, then the hunk verbatim. The HUNK is verbatim on
 * purpose — the `@@` line numbers, the context, and any `\ No newline at end
 * of file` marker inside its range all survive, so what git applies is what
 * the diff says. The HEADER is filtered: file-level rename/mode metadata is
 * dropped (see `FILE_LEVEL_METADATA_RE`), and for a renamed file the
 * `diff --git` / `---` lines are rewritten to the new-side path, so the
 * reverse patch is a pure content revert at the file's current location.
 */
export function extractHunkPatch(
  diffText: string,
  file: DiffFile,
  n: number,
): string {
  const lines = diffText.split('\n');
  const hunk = file.hunks[n - 1];
  const rawHeader = lines.slice(
    file.diffStart - 1,
    file.hunks[0].diffStart - 1,
  );
  let header = rawHeader.filter((l) => !FILE_LEVEL_METADATA_RE.test(l));
  // A rename-with-edits OR copy-with-edits section names the OLD path in
  // `diff --git`'s first token and in `---`. With the rename/copy lines
  // stripped those tokens would send `git apply -R` to move the file back —
  // a mutation different from the one the report names. So whenever the two
  // sides genuinely disagree, both old-side tokens are rewritten from the
  // `+++` token — taken verbatim, quoting and all, because re-quoting a
  // C-quoted path by hand is exactly the transcription this command exists
  // to avoid. Keyed on the TOKENS disagreeing, not on `renameFrom`: parseDiff
  // sets that from `rename from` lines only, and a copy section (git emits
  // them under copy detection, which arbitrary --diff inputs may carry) has
  // the same two-path shape with `copy from`/`copy to` instead. Creations
  // and deletions keep their `/dev/null` side untouched — neither token
  // carries an a/-and-b/ pair there, so the guard below skips them.
  const isMoveOrCopy =
    file.renameFrom !== undefined ||
    rawHeader.some(
      (l) => l.startsWith('copy from ') || l.startsWith('rename from '),
    );
  const plusLine = header.find((l) => l.startsWith('+++ '));
  if (isMoveOrCopy && plusLine !== undefined) {
    // Only reached for a move/copy the guard already confirmed uses standard
    // a/ b/ (or "a/ "b/) prefixes, so the `"a/`-assuming slice is safe. A
    // plain edit never enters here: git's own -p1 strips the one prefix
    // component, so old and new resolve to the same file untouched.
    const bTok = plusLine.slice(4);
    const aTok = bTok.startsWith('"')
      ? `"a/${bTok.slice(3)}`
      : `a/${bTok.slice(2)}`;
    header = header.map((l) => {
      if (l.startsWith('diff --git ')) return `diff --git ${aTok} ${bTok}`;
      if (l.startsWith('--- ')) return `--- ${aTok}`;
      return l;
    });
  }
  // Bound by the header's declared counts, not parseDiff's open range, so a
  // format-patch mbox trailer inside the final hunk is never appended to the
  // patch git applies (see `hunkBodyEnd`).
  const body = lines.slice(hunk.diffStart - 1, hunkBodyEnd(lines, hunk));
  return `${[...header, ...body].join('\n')}\n`;
}

/**
 * Whether this section is a rename/copy whose prefixes we cannot rewrite.
 *
 * The rewrite above turns the old-side tokens into the new path with a
 * standard `a/` prefix, which only works when the tokens carry `a/`/`b/` (or
 * quoted). A diff captured with `--src-prefix`/`--dst-prefix` or `--no-prefix`
 * has the SAME two-path shape but unstrippable tokens, so the rename metadata
 * would be gone and the rewrite skipped — `git apply -R` would then move the
 * file back while the report claims a content revert. The pipeline's own
 * captures always use default prefixes; a non-standard one arrives only
 * through arbitrary `--diff`, and refusing it is safe where mutating is not.
 *
 * This is a SYNTACTIC first-filter — it catches prefixes that do not even look
 * like `a/`/`b/` (`--src-prefix=old/`, crossed prefixes, bare `--no-prefix`
 * tokens) cheaply, before any apply. It CANNOT catch a `--no-prefix` /
 * `--src-prefix=a/…` capture whose literal paths merely begin `a/`/`b/`: those
 * are indistinguishable from default prefixes by token shape alone. The
 * correctness backstop for that class is grounded in the TREE, not the token —
 * `runRevertHunk` reclassifies a `--check` failure as a harness fact (exit 2)
 * whenever git's own `-p1` target does not exist in the tree.
 */
export function sectionUnsafeToRevert(
  diffText: string,
  file: DiffFile,
): string | null {
  const lines = diffText.split('\n');
  const header = lines.slice(file.diffStart - 1, file.hunks[0].diffStart - 1);
  const tok = (pfx: string) =>
    header.find((l) => l.startsWith(pfx))?.slice(pfx.length) ?? '';
  const minus = tok('--- ');
  const plus = tok('+++ ');
  // An empty header token means a binary/mode-only section this command
  // already refuses for lacking hunks — not this gate's concern.
  if (minus === '' || plus === '') return null;
  // The command assumes git's DEFAULT prefixes at every layer (parseDiff
  // strips a/ b/, extractHunkPatch rewrites with them, git apply -R uses
  // -p1). The old side must be `a/…` and the new side `b/…` (quoted or
  // /dev/null variants included). This rejects --src-prefix / --dst-prefix,
  // --no-prefix (whose bare or a/-only tokens read as non-standard), crossed
  // prefixes, and a top-level directory literally named a or b under
  // --no-prefix (the +++ then lacks its b/).
  const oldOk =
    minus === '/dev/null' || minus.startsWith('a/') || minus.startsWith('"a/');
  const newOk =
    plus === '/dev/null' || plus.startsWith('b/') || plus.startsWith('"b/');
  if (!oldOk || !newOk) {
    return `hunk sits in a section whose diff prefixes are not git's standard a/ b/ (got --- ${JSON.stringify(minus)}, +++ ${JSON.stringify(plus)}) — this command assumes default prefixes at every layer. Recapture with default prefixes (drop --src-prefix/--dst-prefix/--no-prefix).`;
  }
  // Standard prefixes confirmed. When the two paths DIFFER it must be a real
  // rename/copy (metadata present), or `git apply -R` would MOVE the file
  // rather than revert its content — the mutation the report does not name.
  const strip = (t: string) =>
    t === '/dev/null' ? t : t.startsWith('"') ? t.slice(3) : t.slice(2);
  const isMoveOrCopy =
    file.renameFrom !== undefined ||
    header.some(
      (l) => l.startsWith('copy from ') || l.startsWith('rename from '),
    );
  // A creation (`--- /dev/null`) or deletion (`+++ /dev/null`) legitimately
  // has differing sides — only two REAL paths differing without metadata is
  // the move-inducing shape.
  const bothReal = minus !== '/dev/null' && plus !== '/dev/null';
  // Rename/copy metadata together with a /dev/null side is a contradictory
  // shape git never emits (a real rename/copy has two real paths). Left
  // through, extractHunkPatch's old-side rewrite fires on isMoveOrCopy and
  // rewrites the /dev/null token into a fabricated real path, reverse-applying
  // over the WRONG mutation while reporting applied:true. Inside the
  // arbitrary-diff threat model; refuse it where mutating is not safe.
  if (isMoveOrCopy && !bothReal) {
    return `hunk sits in a section carrying rename/copy metadata together with a /dev/null (creation or deletion) side — a contradictory shape git does not emit, whose reverse-apply would rewrite the /dev/null side into a real path and mutate the wrong file. This command reverts git-produced diffs; recapture with git.`;
  }
  if (bothReal && strip(minus) !== strip(plus) && !isMoveOrCopy) {
    return `hunk sits in a section whose --- and +++ paths differ with no rename/copy metadata — a reverse-apply would move the file rather than revert its content. This command reverts git-produced diffs; recapture with git.`;
  }
  return null;
}

/** Split `<path>:<n>` from the RIGHT — a path may itself contain a colon. */
export function parseHunkId(id: string): { path: string; n: number } | null {
  const i = id.lastIndexOf(':');
  if (i <= 0) return null;
  const n = Number(id.slice(i + 1));
  if (!Number.isInteger(n) || n < 1) return null;
  return { path: id.slice(0, i), n };
}

/**
 * What one git invocation came back with. `error`/`signal` are the
 * spawn-level facts: a `status` of null with `error: 'ENOENT'` is "git never
 * ran" (a mistyped --tree, a missing binary), and null with `signal` is the
 * 60s hang guard — neither says anything about the patch, and folding them
 * into the refusal branch records a harness failure as a coupling fact about
 * the diff.
 */
export interface GitApplyResult {
  status: number | null;
  stderr: string;
  error?: string;
  signal?: string;
}

export interface RevertHunkArgs {
  diff: string;
  tree: string;
  hunk: string;
  /** Test seam — production shells out to the real git. */
  exec?: (cwd: string, args: string[]) => GitApplyResult;
}

function gitApply(cwd: string, args: string[]): GitApplyResult {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: sanitizedGitEnv(),
    timeout: 60_000,
  });
  return {
    status: r.status ?? null,
    stderr: (r.stderr ?? '').trim(),
    ...(r.error
      ? { error: (r.error as NodeJS.ErrnoException).code ?? r.error.message }
      : {}),
    ...(r.signal ? { signal: r.signal } : {}),
  };
}

/**
 * Whether `tree` is inside a git WORK TREE. `git apply` itself needs NO
 * repository, so the status-128 guard on the apply cannot catch a --tree that
 * is a plain directory: a content mismatch there records a fabricated coupling
 * fact, and a content MATCH silently reverse-applies into the wrong directory
 * while the report claims the scratch tree was reverted. Repo-ness is not
 * enough either: a bare clone or a `.git` metadata dir answers
 * `rev-parse --git-dir` fine yet holds no work-tree files, so the apply's
 * guaranteed refusal there (exit 1, not 128) would land in the conflict
 * branch and be recorded as a coupling fact about the hunk. Distinguishes the
 * three states so a genuinely unusable directory refuses up front (exit 2)
 * while a non-existent tree or a missing git binary still falls through to the
 * apply path's spawn-error classification (`could not run git`).
 */
function gitTreeState(
  tree: string,
): 'root' | 'subdir' | 'not-repo' | 'unrunnable' {
  // `--show-toplevel` does double duty: it fails (exit 128) in a bare repo, a
  // `.git` dir, or a non-repo — the work-tree check — AND, inside a work tree,
  // prints the ROOT. `git apply` from a SUBDIRECTORY resolves -p1 paths against
  // the toplevel but silently SKIPS any path outside the cwd subtree and exits
  // 0, so a subdir --tree would report applied:true over an untouched file.
  // Comparing the printed root to the tree's realpath catches that too.
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: tree,
    encoding: 'utf8',
    env: sanitizedGitEnv(),
    timeout: 60_000,
  });
  if (r.error) return 'unrunnable';
  if (r.status !== 0) return 'not-repo';
  const rawTop = (r.stdout ?? '').trim();
  if (rawTop === '') return 'not-repo';
  // realpath BOTH sides — not just the tree. git prints POSIX slashes from
  // `--show-toplevel` even on Windows (`C:/…`), while realpathSync returns the
  // platform separator (`C:\…`), so a raw comparison never matches there and
  // every valid root is misread as a subdirectory. realpath-ing git's output
  // too normalizes the separators (and any symlink, e.g. macOS /var →
  // /private/var), mirroring the sibling gate in scratch-tree.ts.
  let real: string;
  let top: string;
  try {
    real = realpathSync(tree);
    top = realpathSync(rawTop);
  } catch {
    return 'unrunnable';
  }
  return real === top ? 'root' : 'subdir';
}

export function runRevertHunk(args: RevertHunkArgs): RevertHunkReport {
  // 'latin1', not 'utf8', end to end: the pipeline's diff files are byte
  // streams (fetch-diff writes latin1 so "a Latin-1/Shift-JIS diff survives
  // intact"), and a utf8 round-trip mangles any non-UTF-8 byte to U+FFFD —
  // git then either refuses a valid patch (a fabricated coupling fact) or
  // reverse-applies replacement characters into the "reverted" tree (a
  // fabricated witness pair). latin1 is a 1:1 byte<->char map and all diff
  // syntax is ASCII, so parsing is unaffected.
  const diffText = readFileSync(resolve(args.diff), 'latin1');
  // A --diff whose line endings were normalized to CRLF (a text-mode copy, a
  // Windows paste of the capture) carries a trailing \r on the `@@` header
  // itself. git's own diffs are LF; extractHunkPatch would then write a \r\n
  // patch git apply -R refuses, landing a damaged capture in the exit-1
  // coupling-fact class instead of the repairable exit-2 class. Refuse it as a
  // harness fact, before parsing. A \r inside CONTENT lines is legitimate (a
  // CRLF file's own bytes), so the structural `@@` header — never a content
  // line, which always carries a leading ' '/'+'/'-' — is the signal.
  if (
    diffText.split('\n').some((l) => /^@@ .*@@/.test(l) && l.endsWith('\r'))
  ) {
    return {
      applied: false,
      harnessFailure: true,
      note: `--diff ${JSON.stringify(args.diff)} has CRLF line endings on its hunk headers — the capture was normalized through a text-mode channel, not written as bytes, so git apply -R would refuse the \\r\\n patch and the refusal would read as a coupling fact. Recapture or transfer the diff as bytes (no CRLF conversion); nothing was changed.`,
    };
  }
  const sel = parseHunkId(args.hunk);
  if (!sel) {
    return {
      applied: false,
      harnessFailure: true,
      note: `--hunk ${JSON.stringify(args.hunk)} is not a hunk id; expected <path>:<n> with n >= 1 — run with --list to see the ids this diff has.`,
    };
  }
  const { files } = parseDiff(diffText);
  const matches = files.filter((f) => f.path === sel.path);
  if (matches.length > 1) {
    return {
      applied: false,
      harnessFailure: true,
      note: `hunk ${args.hunk} is ambiguous: ${sel.path} appears in ${matches.length} sections of this diff, so the <path>:<n> id cannot name one. This command needs a single git diff where each path appears once, not concatenated format-patches; recapture and retry. Nothing was changed.`,
    };
  }
  const file = matches[0];
  if (!file || file.hunks.length < sel.n) {
    const have = file
      ? `${file.hunks.length} hunk(s)`
      : 'no section in this diff';
    return {
      applied: false,
      harnessFailure: true,
      note: `hunk ${args.hunk} does not exist: ${sel.path} has ${have} — run with --list to see the ids this diff has.`,
    };
  }
  // Keyed on the PARSED selector, never the raw string: `parseHunkId`
  // accepts non-canonical numbers (`f.ts:01`, `f.ts:1.0`), and an exact-id
  // lookup for those returns undefined AFTER the existence check passed —
  // the success branch would then throw on `entry.header` with the tree
  // already mutated and exit code 2 telling the caller nothing happened.
  const entry = listHunks(diffText).find(
    (h) => h.path === sel.path && h.n === sel.n,
  )!;
  const allLines = diffText.split('\n');
  const rawSection = allLines.slice(
    file.diffStart - 1,
    file.hunks[0].diffStart - 1,
  );
  const sectionBody = allLines.slice(file.hunks[0].diffStart - 1, file.diffEnd);
  if (
    rawSection.some(
      (l) =>
        // A pointer CHANGE carries a mode line and/or a trailing-mode index.
        l.startsWith('old mode 160000') ||
        l.startsWith('new mode 160000') ||
        // A submodule ADDITION / DELETION carries these instead, with an index
        // line whose other side is all-zero (no trailing mode) — so the index
        // regex below never matches them and only these markers catch them.
        l.startsWith('new file mode 160000') ||
        l.startsWith('deleted file mode 160000') ||
        // Loose like the startsWith siblings: no `$` anchor and uppercase
        // admitted, because an arbitrary --diff can carry trailing whitespace
        // or uppercase SHAs on the index line. Over-refusing to the exit-2
        // harness class is the safe direction; admitting the section lets
        // apply -R exit 0 without moving the pointer — a false applied:true.
        /^index [0-9a-fA-F]+\.\.[0-9a-fA-F]+ 160000/.test(l),
    ) ||
    // A DIRTY submodule (locally modified content, UNCHANGED pointer) carries
    // NO mode or index line — git emits only `Subproject commit <sha>` body
    // lines. git apply -R still exits 0 without touching the gitlink, so
    // applied:true would be a false witness. This body marker is the robust
    // one: it covers pointer change, add, delete, and dirty alike.
    sectionBody.some((l) => /^[-+ ]Subproject commit [0-9a-fA-F]{40}/.test(l))
  ) {
    return {
      applied: false,
      hunk: entry,
      harnessFailure: true,
      note: `hunk ${args.hunk} is a gitlink/submodule change (mode 160000 and/or a Subproject commit body line) — git apply -R reports success without moving the submodule, so applied:true would be a false witness. Reverting a submodule needs index/submodule semantics this command does not implement; nothing was changed.`,
    };
  }
  const unsafe = sectionUnsafeToRevert(diffText, file);
  if (unsafe !== null) {
    return {
      applied: false,
      hunk: entry,
      harnessFailure: true,
      note: `${args.hunk}: ${unsafe} Nothing was changed.`,
    };
  }
  const patch = extractHunkPatch(diffText, file, sel.n);
  // The file `git apply -R -p1` will actually TOUCH — its own path resolution,
  // not a guess about the prefix. `-p1` strips exactly one leading path
  // component from each side (assuming git's default `a/` `b/`); the reverse
  // apply modifies the non-`/dev/null` side. Grounding the prefix assumption in
  // this resolved path (does it exist in the tree?) is what the syntactic
  // `sectionUnsafeToRevert` gate cannot do: a `--no-prefix` or `--src-prefix`
  // capture whose tokens merely LOOK like `a/` `b/` resolves, after the strip,
  // to a path that is simply not in the tree.
  const p1strip = (raw: string): string => {
    const t = raw.startsWith('"') ? raw.slice(1, -1) : raw;
    if (t === '/dev/null') return t;
    const slash = t.indexOf('/');
    return slash >= 0 ? t.slice(slash + 1) : t;
  };
  const patchLines = patch.split('\n');
  const p1Minus = p1strip(
    patchLines.find((l) => l.startsWith('--- '))?.slice(4) ?? '',
  );
  const p1Plus = p1strip(
    patchLines.find((l) => l.startsWith('+++ '))?.slice(4) ?? '',
  );
  // -R modifies the side that is NOT /dev/null: the `+++` (new) side for an
  // edit or creation, the `---` (old) side for a deletion (un-delete).
  const p1Target = p1Plus !== '/dev/null' ? p1Plus : p1Minus;

  const tree = resolve(args.tree);
  // git apply needs no repository, so a --tree that is a plain (non-repo)
  // directory would either fabricate a coupling fact on a content mismatch or
  // silently mutate the wrong directory on a match — and a bare clone or a
  // .git dir has no work-tree files to revert in, so its guaranteed refusal
  // would read as a coupling fact too. Refuse all of it up front as a harness
  // fact. A non-existent tree or a missing git binary is left to the apply
  // path's spawn-error classification below, so this changes only the
  // exists-but-no-work-tree case.
  const treeState = gitTreeState(tree);
  if (treeState === 'not-repo') {
    return {
      applied: false,
      hunk: entry,
      harnessFailure: true,
      note: `--tree ${JSON.stringify(args.tree)} is not inside a git repository work tree (git rev-parse --show-toplevel did not name one there) — a plain directory, a bare clone, or a .git metadata dir has no work-tree files to revert in, and git apply there would mutate the wrong place or refuse in a way that reads as a fact about the hunk. Point --tree at the scratch worktree; nothing was changed.`,
    };
  }
  if (treeState === 'subdir') {
    return {
      applied: false,
      hunk: entry,
      harnessFailure: true,
      note: `--tree ${JSON.stringify(args.tree)} is a SUBDIRECTORY of a work tree, not its root — git apply resolves the patch's paths against the toplevel and silently SKIPS any that fall outside this subdirectory, exiting 0 without touching them, so applied:true would be a false witness over an unchanged file. Point --tree at the work-tree root (the scratch worktree); nothing was changed.`,
    };
  }
  // mkdtemp, not a pid-keyed name: a predictable path in the shared temp dir
  // can be pre-planted as a symlink by a local peer, and `mkdirSync`
  // (recursive) follows it silently. mkdtemp creates a fresh 0700 directory
  // nothing else can have claimed.
  const dir = mkdtempSync(join(tmpdir(), 'qwen-review-revert-hunk-'));
  const patchPath = join(dir, 'hunk.patch');
  const exec = args.exec ?? gitApply;
  try {
    // Inside the try: a patch-write failure (a full or quota-exhausted
    // tmpdir mid-review) must not leak the fresh 0700 directory the finally
    // sweeps.
    writeFileSync(patchPath, patch, 'latin1');
    // `--check` first: a refused revert must leave the tree byte-identical,
    // or the verifier's next probe measures a half-mutation nothing reports.
    // --whitespace=nowarn: overrides a repo's apply.whitespace=fix, which would
    // otherwise silently rewrite the restored bytes (drop a trailing space) as
    // it re-adds base lines under -R while reporting applied:true — a reverted
    // tree that no longer matches base. `nowarn` is git apply's disable value
    // (there is no `nochange`); it neither warns nor fixes.
    const check = exec(tree, [
      'apply',
      '-R',
      '--whitespace=nowarn',
      '--check',
      patchPath,
    ]);
    if (check.error !== undefined || check.signal !== undefined) {
      return {
        applied: false,
        hunk: entry,
        harnessFailure: true,
        note: `could not run git in ${tree}: ${check.error ?? `killed by ${check.signal}`} — a harness failure, not a fact about the hunk. Check --tree and that git is on PATH; the tree is unchanged (nothing ran).`,
      };
    }
    if (check.status === 128) {
      // `fatal:` — git never inspected the patch (a non-repo --tree, a pruned
      // gitdir). Recording it as a coupling fact would feed the load-bearing
      // decision a failure of the harness dressed as a fact about the diff.
      return {
        applied: false,
        hunk: entry,
        harnessFailure: true,
        note: `git could not operate on ${tree}: ${check.stderr || 'fatal (no text)'} — a harness failure, not a fact about the hunk. Point --tree at the scratch worktree (a real git tree); nothing was changed.`,
      };
    }
    if (check.status !== 0) {
      // Structural prefix check, grounded in the tree rather than token shape:
      // if git's own `-p1` target does not EXIST here, the refusal is not a
      // coupling fact about the hunk — git could not find the file to revert.
      // That is either a non-default-prefix capture (git strips one component
      // assuming a/ b/, so `--no-prefix`/`--src-prefix` tokens resolve to a path
      // that is not there) or a wrong --tree. Classify it as a harness fact
      // (exit 2), not the exit-1 coupling class a verifier records against the
      // diff. Only the "target genuinely present but content no longer matches"
      // case — a real overlap/coupling — stays exit 1.
      if (p1Target !== '/dev/null' && !existsSync(join(tree, p1Target))) {
        return {
          applied: false,
          hunk: entry,
          harnessFailure: true,
          note: `hunk ${args.hunk}: git apply -R -p1 resolves the target to ${JSON.stringify(p1Target)}, which does not exist in ${tree} — so this is a harness fact, not a coupling refusal about the hunk. The capture likely uses non-default diff prefixes (git strips one leading component, assuming a/ b/), or --tree points at the wrong tree. Recapture with git's default prefixes (drop --no-prefix/--src-prefix/--dst-prefix); nothing was changed.`,
        };
      }
      return {
        applied: false,
        hunk: entry,
        conflict: check.stderr || 'git apply --check refused (no error text)',
        note: `hunk ${args.hunk} does not revert independently — its context no longer matches the tree. Usually that means it overlaps another hunk's edits (a coupling worth reporting as a fact) or the tree was already mutated at those lines (reset the scratch tree and retry). The tree is unchanged.`,
      };
    }
    const apply = exec(tree, ['apply', '-R', '--whitespace=nowarn', patchPath]);
    if (apply.error !== undefined || apply.signal !== undefined) {
      // Same misclassification the --check guard above closes, one call
      // later — with one difference the note must carry: a git killed
      // MID-apply may have left the tree partially written, so the caller
      // must reset before trusting any probe.
      return {
        applied: false,
        hunk: entry,
        harnessFailure: true,
        note: `git apply was ${apply.error !== undefined ? `not runnable (${apply.error})` : `killed by ${apply.signal}`} after --check passed — a harness failure, not a fact about the hunk, and the tree may be PARTIALLY modified: reset the scratch tree before the next probe.`,
      };
    }
    if (apply.status !== 0) {
      // --check passed and the apply did not: the tree raced us between the
      // two calls. `--check` already proved independent revertibility, so
      // this is a harness condition, not a coupling fact about the hunk —
      // harnessFailure keeps it out of the exit-1 refusal class.
      return {
        applied: false,
        hunk: entry,
        harnessFailure: true,
        note: `hunk ${args.hunk} passed --check but failed to apply — the tree changed between the two calls, so it may be PARTIALLY modified. Reset the scratch tree and retry.`,
      };
    }
    return {
      applied: true,
      hunk: entry,
      note: `reverted hunk ${args.hunk} (${entry.header}) in ${tree}. Re-run the probe the intact tree passed — the intact/reverted pair is the witness — and reset the scratch tree afterwards. A compiled product needs its rebuild between revert and probe, or the probe measures the previous build.`,
    };
  } finally {
    // Best effort: an EACCES (a same-uid peer chmods the staging dir mid-run;
    // `force:true` only suppresses ENOENT) must not throw out of the finally
    // and displace the return — the tree may already be reverted, and losing
    // `applied:true` reads to the caller as a refusal over a mutation that
    // happened.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* leak over lie */
    }
  }
}

export const revertHunkCommand: CommandModule = {
  command: 'revert-hunk',
  describe:
    'List the diff\'s hunks (--list), or apply exactly one in reverse in a tree — the "is this change load-bearing?" mutation, done by git instead of by hand',
  builder: (yargs) =>
    yargs
      .option('diff', {
        type: 'string',
        demandOption: true,
        describe: 'The unified diff file the plan records',
      })
      .option('list', {
        type: 'boolean',
        // No `default: false`: yargs `conflicts` counts a defaulted key as
        // "given", which made --hunk unusable — measured on the first live
        // run of this command.
        describe: 'Enumerate the hunks and their ids; touches no tree',
      })
      .option('hunk', {
        type: 'string',
        describe: 'The hunk to revert, as <path>:<n> from --list',
      })
      .option('tree', {
        type: 'string',
        describe:
          'The tree to revert in — the verifier’s scratch tree, never the shared review worktree',
      })
      .option('out', {
        type: 'string',
        describe: 'Also write the report JSON here',
      })
      .conflicts('list', 'hunk'),
  handler: (argv) => {
    // stdout is this command's result and the tree may already be mutated by
    // the time we write it, so a reader that left (`| head`) must not crash
    // the process on the async EPIPE path the safe writer cannot catch.
    ignoreBrokenPipe();
    const out = argv['out'] as string | undefined;
    try {
      if (out !== undefined) assertWritableOutPath(out);
      // A mistyped --diff must exit 2 (repair the invocation) with the
      // reason named — an ENOENT escaping readFileSync would exit 1, the
      // refused-revert class, and a calling script would record a coupling
      // fact for a typo.
      const diffPath = resolve(String(argv['diff']));
      let diffReadable = existsSync(diffPath) && statSync(diffPath).isFile();
      if (diffReadable) {
        // isFile() does not imply readable — a mode-000 file (or one owned by
        // another pipeline stage) exists and is a file yet throws EACCES on
        // read. Probe R_OK so that surfaces as exit 2 here, not exit 1 from
        // deep in the read.
        try {
          accessSync(diffPath, constants.R_OK);
        } catch {
          diffReadable = false;
        }
      }
      if (!diffReadable) {
        writeStderrLineSafe(
          `revert-hunk: --diff ${JSON.stringify(String(argv['diff']))} is not a readable file — check the path.`,
        );
        process.exitCode = 2;
        return;
      }
      let report: object;
      if (argv['list']) {
        report = {
          hunks: listHunks(
            readFileSync(resolve(String(argv['diff'])), 'latin1'),
          ),
        };
      } else {
        const hunk = argv['hunk'] as string | undefined;
        const tree = argv['tree'] as string | undefined;
        if (!hunk || !tree) {
          writeStderrLineSafe(
            'revert-hunk: pass --list to enumerate, or both --hunk <path>:<n> and --tree <path> to revert one.',
          );
          process.exitCode = 2;
          return;
        }
        const r = runRevertHunk({ diff: String(argv['diff']), tree, hunk });
        // The JSON is the report; the exit code is the branch a calling
        // script takes. A harness failure (git unrunnable, killed) is the
        // repairable class — exit 2, like a mistyped --diff — never exit 1,
        // which a script records as a real refusal / coupling fact.
        if (r.harnessFailure) process.exitCode = 2;
        else if (!r.applied) process.exitCode = 1;
        report = r;
      }
      const text = JSON.stringify(report, null, 2);
      // stdout first — and the SAFE variant: the exit code already carries
      // `applied`'s semantics, and by this line the tree may already be
      // mutated, so neither an --out failure nor stdout's reader having gone
      // away (EPIPE from `qwen … | head`) may crash the process into the
      // refused class over a revert that happened.
      writeStdoutLineSafe(text);
      if (out !== undefined) {
        try {
          mkdirSync(dirname(resolve(out)), { recursive: true });
          writeFileSync(resolve(out), `${text}\n`, 'utf8');
        } catch (err) {
          writeStderrLineSafe(
            `revert-hunk: the report was printed above but --out failed: ${(err as Error).message}`,
          );
        }
      }
    } catch (err) {
      writeStderrLineSafe(`revert-hunk: ${(err as Error).message}`);
      process.exitCode = err instanceof TypeError ? 2 : 1;
    }
  },
};
