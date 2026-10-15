/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Is the bundle this review is about to drive built from the review source
// beside it?
//
// Every `/review` subcommand runs as `"${QWEN_CODE_CLI}" review <name>`, which
// resolves to the built bundle — not to the working tree. `QWEN_CODE_CLI`
// already stops the review talking to a DIFFERENT program (a bare `qwen` on
// PATH once resolved to a v0.19.10 whose `agent-prompt` predated `--role`, and
// the review died on a missing argument). This is the other half: the right
// program, built before the change you are trying to exercise. That failure is
// silent and total — the run behaves like the last build, and every conclusion
// drawn from it is a conclusion about that build.
//
// Measured on 2026-08-02, dogfooding `/review` against #8368 from a checkout
// whose bundle was fourteen hours old. Three things were invalidated at once
// and none of them announced itself:
//
//   - `drive` and `mock-provider` had merged that morning and were absent from
//     the binary, so "the agent never reached for them" measured nothing;
//   - #8345's guard against scoring a mutant `survived` when its own test was
//     red had merged too, so the run reproduced the bug it fixed and filed
//     three findings the current code holds as `inconclusive`.
//
// The whole round had to be discarded and re-run after a rebuild.
//
// SCOPE, so silence is not read as more than it is: the roots are the review
// commands, the file that registers them, the review-only lease they import
// from `services/`, the two review helpers left in `utils/`, and the bundled
// skill — not the modules those import. The validator itself is back under
// `commands/review/`, which the directory root covers. Editing
// `utils/stdioHelpers.ts` or a core helper on a review path and skipping the
// rebuild produces no warning. The line drawn here is the code
// whose behaviour a review is about; a quiet run means that code matches the
// bundle, not that the whole tree does.
//
// CONTENT, not timestamps. The first version compared the bundle's mtime
// against the newest source file, and a warning that fires when nothing is
// wrong is worse than none — it teaches its reader to skip the line. Measured:
// `git checkout` rewrites every file that differs between two commits, so
// returning to the branch you built from re-stamps those files and the bundle
// reads as stale while being byte-for-byte correct. A digest has no margin to
// tune, no clock to trust, and no answer but the true one.

import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs';
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

/** Where the build stamps the digest of the sources it bundled. */
export const DIGEST_FILE = 'review-sources.sha256';

/**
 * Files the bundle does not contain, and which therefore cannot make it stale.
 *
 * esbuild follows imports from the CLI entry, and no test is reachable that
 * way — so folding tests into the digest would fire the warning for an edit
 * to a file the bundle cannot contain. That is the false positive this
 * module already rejected once, in the timestamp version.
 */
export const NOT_BUNDLED_RE = /\.(?:test|spec)\.(?:d\.)?[cm]?[jt]sx?$/;

/**
 * Directories whose contents exist only for tests.
 *
 * A fixture is loaded by a test at runtime and is reachable from no import the
 * bundler follows — measured, none of the four under `review/__fixtures__` is
 * in `dist`. Editing one is the same nothing-changed warning a test file was.
 */
export const NOT_BUNDLED_DIR = new Set(['__fixtures__', '__snapshots__']);

/**
 * Code-root files no production import reaches, named the way production
 * files are.
 *
 * `lib/test-utils.ts` is test support imported only by tests; the extension
 * allowlist cannot tell it apart from a command. Editor droppings no longer
 * need an entry here — no extension they carry is digested. The class is
 * policed, not remembered: `review-digest-covers-only-bundled.test.ts` fails
 * when any file in the digest is imported by tests alone.
 */
export const NOT_BUNDLED_FILE = new Set(['test-utils.ts']);

/**
 * Skill-root files the copier deliberately does not ship.
 *
 * `DESIGN.md` is the skill's maintainer design narrative, kept out of the
 * bundle by the copier (see `copy_bundle_assets.js`). An edit to it cannot
 * change a byte of the bundle, so digesting it would fire the same
 * nothing-changed warning a test file once did.
 */
export const NOT_BUNDLED_SKILL_FILE = new Set(['DESIGN.md']);

/** Which half of the build carries a root into the bundle. */
export type ReviewSourceKind = 'code' | 'skill';

export interface ReviewSourceRoot {
  path: string;
  kind: ReviewSourceKind;
}

/**
 * The extensions each root kind can put in the bundle.
 *
 * Bounded on purpose: a file that appears after a build — `drive.ts.orig`
 * from a conflicted rebase, an editor swapfile, a scratch note — cannot reach
 * the bundle, so it must not move the digest either. The blocklist this
 * replaces had been patched four times for that class; an allowlist has no
 * fifth patch to apply. Code roots reach the bundle through esbuild's import
 * graph; the skill root is the markdown the asset copier ships, so extend its
 * set the day the skill grows a file the copier would carry.
 */
export const DIGESTED_EXTENSIONS: Record<
  ReviewSourceKind,
  ReadonlySet<string>
> = {
  code: new Set([
    '.ts',
    '.tsx',
    '.mts',
    '.cts',
    '.js',
    '.mjs',
    '.json',
    '.jsx',
  ]),
  skill: new Set(['.md']),
};

/**
 * Whether a file of this root kind belongs in the digest.
 *
 * The skill rule is the allowlist minus the copier's deliberate skips — its
 * root holds no importable code, only the documents the copier ships. The
 * code roots additionally drop the files and names the bundler cannot reach
 * from the CLI entry.
 */
function isDigestedFile(kind: ReviewSourceKind, name: string): boolean {
  if (!DIGESTED_EXTENSIONS[kind].has(extname(name))) return false;
  if (kind !== 'code') return !NOT_BUNDLED_SKILL_FILE.has(name);
  return !NOT_BUNDLED_RE.test(name) && !NOT_BUNDLED_FILE.has(name);
}

export interface BundleStaleness {
  /** `true` only when both digests are known and differ. */
  stale: boolean;
  /** Why no comparison was made. Absent when one was. */
  unmeasured?: string;
}

/**
 * A digest over every review source, stable across machines and checkouts.
 *
 * Paths are made relative to `repoRoot` and separators normalised, so the same
 * tree hashes the same on Windows and under any parent directory. Files are
 * folded in sorted order, because `readdir` order is a property of the
 * filesystem and not of the source.
 */
export function reviewSourcesDigest(
  repoRoot: string,
  roots: readonly ReviewSourceRoot[],
): string | undefined {
  return measureReviewSources(repoRoot, roots).digest;
}

/** What one walk over the roots found out. */
interface SourceMeasurement {
  /** The digest, or `undefined` when nothing was measured. */
  digest: string | undefined;
  /** A file could not be read, or a directory could not be listed. */
  incomplete: boolean;
  /**
   * Some roots were measured and others were never there — a partial tree,
   * such as a sparse checkout that did not materialize every root. Not
   * `incomplete` (a root that IS there but cannot be read) and not the
   * installed package (no root at all): the digest covers the present roots
   * only, where the stamp was made from every root, so comparing them would
   * accuse a build that may be exactly correct.
   */
  partial: boolean;
}

/**
 * The walk and the hash together, keeping the two reasons a measurement comes
 * up empty apart: `incomplete` says a source could not be read, where a zero
 * count says there was nothing to read. `bundleStalenessNotices` needs the
 * difference to name the case it reports; the digest alone cannot carry it.
 */
function measureReviewSources(
  repoRoot: string,
  roots: readonly ReviewSourceRoot[],
): SourceMeasurement {
  const state = { incomplete: false, absentRoots: 0 };
  const files: string[] = [];
  for (const root of roots) files.push(...sourceFilesUnder(root, state, false));
  // Some-but-not-all: every root absent is an installed package with nothing
  // to say, and every root present is the tree the stamp was made from —
  // only between the two does a comparison measure less than it claims.
  const partial = state.absentRoots > 0 && state.absentRoots < roots.length;
  if (state.incomplete || files.length === 0) {
    return { digest: undefined, incomplete: state.incomplete, partial };
  }

  const hash = createHash('sha256');
  for (const file of files.sort()) {
    let content: Buffer;
    try {
      content = readFileSync(file);
    } catch {
      // Vanished between listing and reading. Nothing can be said about a tree
      // that is changing underneath the check.
      return { digest: undefined, incomplete: true, partial };
    }
    hash.update(relative(repoRoot, file).split(sep).join('/'));
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return { digest: hash.digest('hex'), incomplete: false, partial };
}

/**
 * Compare the digest the build stamped beside the bundle against the sources
 * present now.
 *
 * Returns `stale: false` whenever it cannot compare — no stamp (an installed
 * package, or a bundle from before the build wrote one), no sources (the same
 * install, from the other side), an unreadable tree. A check that cannot see
 * both halves must not accuse the build, and the caller has a review to run
 * either way. Each such case names itself in `unmeasured` rather than passing
 * silently, for the same reason a probe does.
 */
export function bundleStaleness(
  stampedDigest: string | undefined,
  currentDigest: string | undefined,
): BundleStaleness {
  if (!stampedDigest) {
    return { stale: false, unmeasured: 'the bundle carries no source digest' };
  }
  if (!currentDigest) {
    return {
      stale: false,
      unmeasured: 'no review sources were found to compare',
    };
  }
  return { stale: stampedDigest !== currentDigest };
}

/**
 * Every file at or under `root`, recursively — `root` may be a directory or a
 * single file. Symlinks of any kind are skipped, because `isFile()` and
 * `isDirectory()` are both false for one: a link out of the tree is not this
 * tree's source, and a directory cycle would hang the one check that must
 * never cost the run anything.
 *
 * `listed` is true when the parent walk saw this path as a directory a moment
 * ago: if it cannot be listed now, the tree changed underneath the check and
 * the measurement is incomplete, where a root that was never there (an
 * installed package) has simply nothing to say.
 */
function* sourceFilesUnder(
  root: ReviewSourceRoot,
  state: { incomplete: boolean; absentRoots: number },
  listed: boolean,
): Generator<string> {
  const { kind } = root;
  let entries;
  try {
    entries = readdirSync(root.path, { withFileTypes: true });
  } catch {
    let stats: Stats | undefined;
    try {
      stats = statSync(root.path);
    } catch (err) {
      // A root that was never there is silent only on ENOENT: EACCES/EPERM is
      // a tree that IS there but cannot be measured — a permission-corrupted
      // checkout — and silence there would drive a review against an
      // arbitrarily stale bundle with no line at all. The ENOENT count is how
      // `measureReviewSources` tells a partial checkout from an installed
      // package.
      if (listed || (err as NodeJS.ErrnoException).code !== 'ENOENT')
        state.incomplete = true;
      else state.absentRoots += 1;
      return;
    }
    if (stats.isDirectory()) {
      // Exists, but could not be listed — `EACCES` where `ENOTDIR` was
      // expected. Hashing the survivors would differ from the stamp and accuse
      // a bundle that is merely unreadable: the exact false positive the
      // file-level read avoids by measuring nothing.
      state.incomplete = true;
      return;
    }
    // Not a directory. Asking whether it is a file states that directly, where
    // inferring it from `ENOTDIR` assumed every platform's libuv maps the case
    // the same way — and the one root that is a file is `review.ts`, which is
    // exactly where "a new subcommand was registered" lives.
    if (stats.isFile() && isDigestedFile(kind, basename(root.path)))
      yield root.path;
    return;
  }
  for (const e of entries) {
    const full = join(root.path, e.name);
    if (e.isDirectory()) {
      // Fixtures are a code-root concern: they sit beside importable modules
      // but are loaded by tests at runtime. Nothing under the skill root is
      // reachable by import in the first place; the allowlist already decides.
      if (kind !== 'code' || !NOT_BUNDLED_DIR.has(e.name))
        yield* sourceFilesUnder({ path: full, kind }, state, true);
    } else if (e.isFile() && isDigestedFile(kind, e.name)) {
      yield full;
    }
  }
}

/**
 * The review sources a checkout at `repoRoot` holds.
 *
 * An installed package has no `packages/` beside its bundle, so the caller
 * finds no files and reports that it could not measure — the right answer for
 * a user who never had sources to differ from.
 */
export function reviewSourceRoots(repoRoot: string): ReviewSourceRoot[] {
  const cli = join(repoRoot, 'packages', 'cli', 'src', 'commands');
  return [
    { path: join(cli, 'review'), kind: 'code' },
    // The parent file, which is where every subcommand is registered — a new
    // command, or a changed dispatch, lives here and nowhere under `review/`.
    // A root may be a single file for exactly this reason.
    { path: join(cli, 'review.ts'), kind: 'code' },
    // The worktree lease is review-only code that lives outside `review/`:
    // `fetch-pr` and `cleanup` import it from `services/`, so an edit to it
    // with a skipped rebuild is the same silent failure this check exists
    // for. The two shared files the closure also reaches (`stdioHelpers.ts`,
    // `skill-args-file.ts`) stay out for the reason SCOPE gives.
    {
      path: join(
        repoRoot,
        'packages',
        'cli',
        'src',
        'services',
        'review-worktree-lease.ts',
      ),
      kind: 'code',
    },
    // The two helpers of the findings validator live in `utils/`, outside
    // the `review/` directory root; a root list that lost them would keep
    // both digest copies equal while a skipped rebuild silently runs the
    // bundle's old validator. The validator itself moved back into
    // `commands/review/` (#9146), which the directory root covers.
    {
      path: join(repoRoot, 'packages', 'cli', 'src', 'utils', 'shell-args.ts'),
      kind: 'code',
    },
    {
      path: join(repoRoot, 'packages', 'cli', 'src', 'utils', 'paths.ts'),
      kind: 'code',
    },
    {
      path: join(
        repoRoot,
        'packages',
        'core',
        'src',
        'skills',
        'bundled',
        'review',
      ),
      kind: 'skill',
    },
  ];
}

/**
 * The whole check, from an entry path to whatever needs saying.
 *
 * Lives here rather than in `parse-args`, which is about parsing arguments —
 * and so that a second caller (the verifier brief sends agents straight to
 * `drive`, and that is where the long work starts) is one line rather than a
 * copy of fifty.
 *
 * Returns the line to emit, or `undefined` when there is nothing to say. It
 * reads the filesystem and decides nothing else; the caller owns how it
 * reaches a terminal.
 *
 * `brief` selects the one-line forms: `drive` repeats a check `parse-args`
 * already printed in full at the start of the review, and a repeated
 * paragraph becomes wallpaper the reader learns to skip.
 */
export function bundleStalenessNotices(
  entryPath: string | undefined,
  brief?: boolean,
): string | undefined {
  // Caught here rather than at each call site: the contract is the one check
  // that must never cost the run anything, and a guard inside the function is
  // a property of the module, where a call-site `try` belongs to its two call
  // sites.
  try {
    if (!entryPath) return undefined;
    // `realpath` before deriving anything: node hands a symlinked entry over
    // unresolved, so an alias of the bundle (`ln -s dist/cli.js ~/bin/qwen`)
    // would hand `distDir` a directory with no stamp beside it and turn the
    // check off — even though the stamp and the sources are one `realpath`
    // away. A real file resolves to itself, so installed layouts behave
    // exactly as before; a vanished entry keeps the unresolved path and the
    // layout check below decides the case.
    let entry = entryPath;
    try {
      entry = realpathSync(entryPath);
    } catch {
      // Leave the path unresolved; `resolve` below still makes it absolute.
    }
    // `resolve`, because `argv[1]` can be relative (`node dist/cli.js`), and a
    // `repoRoot` derived from it must stay printable and absolute.
    const distDir = dirname(resolve(entry));
    // Only a `<root>/dist/cli.js` layout carries a stamp. A dev launcher runs
    // `node <root>/packages/cli`, where node sets argv[1] to the DIRECTORY —
    // measured — so the derivation would find sources under `<root>` and no
    // stamp beside them, and say "could not check" on every review forever, with
    // advice its reader can never act on. A layout with no stamp to grow is not
    // half-measured; it is not measured.
    if (basename(distDir) !== 'dist') return undefined;

    const repoRoot = dirname(distDir);
    let stamped: string | undefined;
    try {
      const raw = readFileSync(join(distDir, DIGEST_FILE), 'utf8').trim();
      // A bundle step killed mid-write leaves a truncated or non-hex digest
      // beside a current build; compared as-is it would accuse the build on
      // every review until the next one, where an unmeasurable stamp owes
      // the same 'could not check' as a missing one.
      if (/^[0-9a-f]{64}$/.test(raw)) stamped = raw;
    } catch {
      // No stamp: an installed package, or a bundle from before the build wrote
      // one. Which of those it is depends on whether sources exist, below.
    }
    // Always hashed, even with no stamp to compare against: the branch below
    // needs this value to tell a pre-stamp checkout apart from an installed
    // package. Gating the walk on `stamped` would make that branch dead and
    // silence the one unmeasured case worth saying out loud.
    const roots = reviewSourceRoots(repoRoot);
    const measured = measureReviewSources(repoRoot, roots);
    const current = measured.digest;
    if (stamped && current && measured.partial) {
      // A sparse or partial checkout holds only some of the roots the stamp
      // was made from, so the digest computed here covers less than the
      // stamped tree — a mismatch would accuse a build that may be
      // byte-for-byte correct. Name the case; accuse nothing.
      return (
        `review: could not check whether the bundle is current — ` +
        `only some of the review sources are present` +
        (brief
          ? ' (a partial checkout).'
          : ' (a sparse or partial checkout). The stamp covers the whole tree; materialize the missing sources to compare again.')
      );
    }
    const staleness = bundleStaleness(stamped, current);

    const warning = staleBundleWarning(staleness, brief);
    if (warning) return warning;

    // No digest, but the sources are on disk. The two reasons a measurement
    // comes up empty each name themselves: a file or directory that could not
    // be read is a tree mid-change, where a root holding nothing the digest
    // admits (tests only, say) is a tree with nothing to compare.
    if (
      stamped &&
      !current &&
      (measured.incomplete || roots.some((r) => existsSync(r.path)))
    ) {
      const reason = measured.incomplete
        ? 'a review source could not be read, so nothing was compared' +
          (brief ? '.' : '. Re-run once the tree is settled.')
        : `${staleness.unmeasured}.`;
      return `review: could not check whether the bundle is current — ${reason}`;
    }
    // A checkout whose `dist/` predates the stamp is genuinely stale and cannot
    // be measured — the state of every existing tree until its next rebuild. An
    // installed package has no sources either and gets nothing, so a user who
    // could do nothing about it is not told anything.
    if (!stamped && current) {
      return (
        `review: could not check whether the bundle is current — ${staleness.unmeasured}. ` +
        (brief
          ? 'Rebuild with `npm run bundle` to record one.'
          : 'Either it was built before this check existed, or the build declined to ' +
            'record one; rebuild with `npm run bundle` and, if the line persists, ' +
            "read that build's output for why it refused.")
      );
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * The warning a stale bundle earns, or `undefined` when there is nothing to
 * say.
 *
 * "Rebuild" on its own is advice a reader cannot check, and the whole point of
 * the line is that the run they are about to trust may not be running their
 * code — so it says what runs from the bundle and what to do about it.
 */
export function staleBundleWarning(
  s: BundleStaleness,
  brief?: boolean,
): string | undefined {
  if (!s.stale) return undefined;
  if (brief) {
    return (
      `review: the bundle these commands run from was NOT built from the review sources in this tree — ` +
      `rebuild with \`npm run bundle\` and start again, or read every result ` +
      `below as being about the older build.`
    );
  }
  return (
    `review: the bundle these commands run from was NOT built from the review sources in this tree. ` +
    `Every \`qwen review …\` step below runs the BUILT bundle, not the working tree, ` +
    `so a review source changed since that build will not take effect and this run ` +
    `will measure the old behaviour without saying so. Rebuild with ` +
    `\`npm run bundle\` ` +
    `and start again, or read every result below as being about the older build.`
  );
}
