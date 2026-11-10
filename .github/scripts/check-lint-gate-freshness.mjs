#!/usr/bin/env node
/**
 * Fail a PR's Lint & Static lane when the base branch changed the lint gate
 * after this branch last incorporated it.
 *
 * The lane checks out the event PR head SHA — the branch alone, not the
 * merge ref, which GitHub rebuilds asynchronously and can serve stale for
 * minutes. A green run
 * therefore proves "the branch passes the gate AS THE BRANCH DEFINES IT",
 * not as the base defines it. When the base changes the gate between branch
 * point and merge, the branch keeps validating with the old gate: #11117
 * flipped the Prettier lane from --write to --check on main while #11216's
 * branch still ran --write; its green was real, the merged tree was red,
 * and every later full-profile PR failed lint for a reason outside its own
 * diff (#11378 cleaned up). Nothing else catches this: main's ruleset
 * requires reviews, not status checks, and the merge queue has been off
 * since 2026-07-02.
 *
 * Gate-defining files only, deliberately NOT package.json /
 * package-lock.json: at 50-100 merges a day a dependency bump lands almost
 * daily, and forcing every in-flight PR to rebase behind one recreates the
 * "require up-to-date branch" treadmill. A prettier/eslint version bump
 * cannot sneak changed semantics past a branch either:
 * `affectsAllFiles()` in scripts/lint-scope.js restores full checking
 * whenever a manifest or lockfile it names changes, so the bumping PR still
 * brings the whole tree under the new semantics in its own run. That
 * predicate — not a repo-wide sweep inherent to the lanes — is what carries
 * the exclusion, so trimming its name list re-opens this treadmill. What can
 * sneak past a branch is a change to how the gate RUNS (the lane definitions
 * in lint.js, the configs they read, this check), which is exactly the list
 * below. Rare enough — lint.js saw five commits in the months before this
 * check — that an occasional "rebase, the gate moved" is cheap.
 *
 * Containment is a proxy, and for a purely subtractive scope list it
 * over-rejects. Lint scope is `tree \ ignores`, so a branch's green covers what
 * the base gate checks exactly when the branch's ignores are a SUBSET of the
 * base's: adding an ignore on the base only shrinks what the base checks, and
 * the branch already validated the larger scope. All nine measured freshness
 * reds in one eight-hour window named one such addition (#16200 ignoring a
 * built host bundle). The NARROWINGS table below applies that argument to
 * eslint.config.js's global `ignores` and to `.prettierignore`, whose last three
 * commits were pure additions too; a base-side REMOVAL fails the subset test
 * and still reddens the branch. The argument needs entries to be purely
 * subtractive, so `reincludesFiles` refuses negations and escapes. See
 * docs/design/2026-11-09-lint-gate-freshness-ignores-subset.md.
 *
 * Fail-open on API errors: with no required status checks this step is
 * advisory by convention (red means do not merge), and a GitHub API
 * brownout must not hold every PR hostage. The warning stays in the log.
 *
 * Cost: two API calls per gate file (latest base-side commit, then a
 * containment compare). The per-file `commits?path=` lookup is exact where
 * the alternative — scanning one swapped compare's file list — caps at 300
 * files, and a branch a few days behind a repo merging 50-100 PRs a day
 * blows past that, silently dropping gate files from the scan.
 */
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const GATE_FILES = [
  'scripts/lint.js',
  'scripts/lint-scope.js',
  'eslint.config.js',
  'eslint.legacy-filenames.mjs',
  'eslint.legacy-core-barrel-imports.mjs',
  '.prettierrc.json',
  '.prettierignore',
  '.github/workflows/ci.yml',
  // This check is itself part of the gate: a base-side change to it must
  // not be validated by the branch's older copy.
  '.github/scripts/check-lint-gate-freshness.mjs',
];

/**
 * curl honours HTTPS_PROXY/NO_PROXY on the ECS runners' squid egress;
 * node's global fetch does not (undici needs a ProxyAgent that builtins
 * alone cannot construct). `-f` turns HTTP errors into a non-zero exit,
 * which execFile rejects — callers catch both shapes, but not alike: the JSON
 * path reaches main()'s fail-open, the text path the narrowing's fail-closed.
 */
async function curlRaw(path, token, accept) {
  try {
    const { stdout } = await execFileAsync(
      'curl',
      [
        '-sS',
        '-fL',
        '--max-time',
        '30',
        '-H',
        `Authorization: Bearer ${token}`,
        '-H',
        `Accept: ${accept}`,
        '-H',
        'X-GitHub-Api-Version: 2022-11-28',
        `https://api.github.com${path}`,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout;
  } catch (error) {
    // execFile's message embeds the full argv — including the bearer token.
    // Actions masks the exact secret in logs, but a local run would print
    // it, so rebuild the error from the exit code and curl's own stderr.
    const stderr = String(error.stderr ?? '')
      .trim()
      .split('\n')
      .pop();
    throw new Error(
      `GET ${path} failed (curl exit ${error.code ?? '?'})${stderr ? `: ${stderr}` : ''}`,
    );
  }
}

async function curlJson(path, token) {
  return JSON.parse(await curlRaw(path, token, 'application/vnd.github+json'));
}

// Raw, not the JSON representation: the contents API returns an empty `content`
// field above 1 MB, and the JSON envelope has no line-anchored `ignores: [` for
// the extractor either. Exported so a test can pin it — flipping it to the JSON
// media type turns the narrowing into a no-op that the fail-closed catch hides.
export const TEXT_ACCEPT = 'application/vnd.github.raw';

function curlText(path, token) {
  return curlRaw(path, token, TEXT_ACCEPT);
}

function firstLine(message) {
  return message.split('\n', 1)[0];
}

/**
 * Split eslint.config.js into the entries of its FIRST `ignores: [...]` block
 * and `rest`, the file with that whole block removed. The first block is the
 * global one; the config-scoped arrays further down stay in `rest` and keep
 * being compared byte for byte.
 *
 * Line-anchored on purpose. This suite is in HELPER_TESTS_DEP_FREE, so the
 * import closure is node: builtins — no parser — and importing the config
 * itself would execute branch-controlled code. Anchoring the literal at the
 * start of the line is what keeps prose in a trailing comment from being read
 * as an entry. An unexpected line returns null ("cannot narrow"), never a
 * silently shortened list.
 */
export function splitGlobalIgnores(text) {
  // Split on the engine's terminator set, not just \n. A line written
  // `// x<U+2028> 'hidden/**',` is ONE line to a \n split and gets skipped as a
  // comment, while the engine ends the comment at U+2028 and reads a real
  // entry. The extractor would then under-report the branch's own ignores and
  // certify it fresh. Measured for U+2028, U+2029 and a lone CR.
  const lines = text.split(/\r\n|[\n\r\u2028\u2029]/);
  const start = lines.findIndex((line) => /^\s*ignores:\s*\[\s*$/.test(line));
  if (start === -1) return null;
  const end = lines.findIndex(
    (line, index) => index > start && /^\s*\],?\s*$/.test(line),
  );
  if (end === -1) return null;
  const entries = [];
  for (const line of lines.slice(start + 1, end)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    const entry = /^'((?:[^'\\]|\\.)*)'\s*,?\s*(?:\/\/.*)?$/.exec(trimmed);
    if (!entry) return null;
    entries.push(entry[1]);
  }
  return {
    entries,
    rest: [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n'),
  };
}

// Line comments, not a block: the glob examples below contain `*/`.
//
// A negated pattern RE-INCLUDES files, so the list stops being purely
// subtractive and the subset argument does not hold. Measured on eslint 9.29.0
// with lintFiles: base ['**/*.gen.ts', '!**/keep.gen.ts'] lints keep.gen.ts
// while head ['**/*.gen.ts'] lints nothing, yet head is a subset of base.
// Cite lintFiles, not isPathIgnored: the latter answers true for both when no
// config object matches the extension (or a parent directory is pruned), which
// is an artifact of the probe, not of the ignore pattern.
//
// Any backslash is refused too, not just a leading bang: the extractor sees
// source text while the consumer sees the decoded pattern, so '\x21foo'
// (or gitignore's '\!foo') hides a negation from a startsWith('!') test.
// Decoding here would mean evaluating branch-controlled text, which the
// dep-free lane has no parser for and this check must never do.
function reincludesFiles(entries) {
  return entries.some((entry) => entry.startsWith('!') || entry.includes('\\'));
}

/**
 * gitignore-style scope list: every non-blank line that does not start with `#`
 * is a pattern. Only TRAILING whitespace is stripped — measured against
 * prettier, `foo.js` and ` foo.js` ignore different files, so trimming both ends
 * would merge two distinct patterns into one and could certify a branch whose
 * scope is narrower than the base's. For the same reason `  # foo` stays a
 * pattern: `#` only opens a comment at column zero. Trailing spaces are
 * insignificant unless backslash-quoted, and `reincludesFiles` refuses those.
 */
export function ignoreLines(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line !== '' && !line.startsWith('#'));
}

function fetchGateFilePair({ fetchText, repo, file, baseSha, headSha }) {
  return Promise.all(
    [baseSha, headSha].map((sha) =>
      fetchText(
        `/repos/${repo}/contents/${file}?ref=${encodeURIComponent(sha)}`,
      ),
    ),
  );
}

/**
 * True when the base-side eslint.config.js change cannot invalidate this
 * branch: everything outside the global ignores array is byte-identical, and
 * the branch excludes no more than the base does. See the header for why the
 * subset runs in this direction.
 */
async function narrowsToIgnoredScope(args) {
  const [baseText, headText] = await fetchGateFilePair(args);
  const base = splitGlobalIgnores(baseText);
  const head = splitGlobalIgnores(headText);
  // Throw, not `return false`: the caller's catch is what emits the warning,
  // so a silent false here would keep the verdict with no trace — the exact
  // unexplained-stale case the annotation exists for.
  if (!base || !head)
    throw new Error('could not extract the global ignores block');
  if (reincludesFiles([...base.entries, ...head.entries])) return false;
  return (
    base.rest === head.rest &&
    head.entries.every((entry) => base.entries.includes(entry))
  );
}

// Every ignore file prettier can discover, at any depth. The lane groups by
// the nearest ancestor carrying one, so `packages/cli/.gitignore` scopes its
// own group just as the root pair does.
const SCOPE_FILE_RE = /(?:^|\/)\.(?:gitignore|prettierignore)$/;
const ROOT_PRETTIER_IGNORE = '.prettierignore';

function scopeFileBlobs(tree) {
  return new Map(
    tree.tree
      .filter((e) => e.type === 'blob' && SCOPE_FILE_RE.test(e.path))
      .map((e) => [e.path, e.sha]),
  );
}

/**
 * Same subset argument for prettier's scope, but prettier's scope is not one
 * file: it reads `.gitignore` too (measured on 3.6.1 — adding `apps/host/`
 * there drops the checked-file count from 2 to 1), and it discovers both kinds
 * at every depth.
 *
 * So instead of guessing which files matter, compare the whole ignore-file set
 * from both trees. Every one of them except the root `.prettierignore` must be
 * byte-identical, which blob SHAs answer without fetching content. They cannot
 * be folded into the subset test: the real `.gitignore` carries a dozen `!`
 * re-inclusions, so `reincludesFiles` would reject every comparison and the
 * narrowing would be dead code from day one.
 *
 * The base side is read at `baseRef`, the base TIP — not at `baseSha`. That
 * distinction is load-bearing: `baseSha` is the newest commit touching
 * `.prettierignore`, and a later base-side `.gitignore` change would otherwise
 * be invisible, because `.gitignore` owns no gate verdict of its own.
 */
async function narrowsToPrettierIgnore({
  fetchJson,
  fetchText,
  repo,
  baseRef,
  headSha,
}) {
  const [baseTree, headTree] = await Promise.all(
    [baseRef, headSha].map((ref) =>
      fetchJson(
        `/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      ),
    ),
  );
  // A truncated tree is a partial answer; never narrow on one. Throw rather
  // than return false so the caller's catch annotates it — the same reason the
  // extraction miss throws. A silent false here is the "narrowing quietly
  // stopped working" shape the warning exists to prevent.
  if (baseTree.truncated || headTree.truncated)
    throw new Error('the recursive tree is truncated');
  const baseBlobs = scopeFileBlobs(baseTree);
  const headBlobs = scopeFileBlobs(headTree);
  for (const [path, sha] of baseBlobs) {
    if (path === ROOT_PRETTIER_IGNORE) continue;
    if (headBlobs.get(path) !== sha) return false;
  }
  for (const path of headBlobs.keys()) {
    if (path === ROOT_PRETTIER_IGNORE) continue;
    if (!baseBlobs.has(path)) return false;
  }
  const [basePi, headPi] = await Promise.all(
    [baseRef, headSha].map((ref) =>
      fetchText(
        `/repos/${repo}/contents/${ROOT_PRETTIER_IGNORE}?ref=${encodeURIComponent(ref)}`,
      ),
    ),
  );
  const base = ignoreLines(basePi);
  const head = ignoreLines(headPi);
  if (reincludesFiles([...base, ...head])) return false;
  return head.every((entry) => base.includes(entry));
}

// Gate files whose stale verdict a purely subtractive scope argument can
// narrow. Everything else keeps whole-file containment.
const NARROWINGS = {
  'eslint.config.js': narrowsToIgnoredScope,
  '.prettierignore': narrowsToPrettierIgnore,
};

/**
 * Return the gate files whose latest base-side change this branch does not
 * contain. `fetchJson(path)` and `fetchText(path)` are injected so tests never
 * touch the network; `fetchText` is consulted only for a NARROWINGS file whose
 * verdict already came back stale.
 *
 * Containment uses the swapped three-dot compare `S...head`: its status is
 * "ahead"/"identical" exactly when S is an ancestor of (or equal to) head;
 * "diverged"/"behind" mean the base's gate change never reached the branch.
 */
export async function findStaleGateFiles({
  fetchJson,
  fetchText,
  repo,
  baseRef,
  headSha,
  gateFiles = GATE_FILES,
}) {
  const latest = await Promise.all(
    gateFiles.map(async (file) => {
      const commits = await fetchJson(
        `/repos/${repo}/commits?path=${encodeURIComponent(file)}` +
          `&sha=${encodeURIComponent(baseRef)}&per_page=1`,
      );
      const commit = commits[0];
      // Never existed on the base: nothing to be stale against.
      if (!commit) return null;
      return {
        file,
        sha: commit.sha,
        message: firstLine(commit.commit.message),
        date: commit.commit.committer.date,
        url: commit.html_url,
      };
    }),
  );
  const candidates = latest.filter((entry) => entry !== null);
  const verdicts = await Promise.all(
    candidates.map(async (candidate) => {
      const comparison = await fetchJson(
        `/repos/${repo}/compare/${candidate.sha}...${headSha}`,
      );
      return {
        ...candidate,
        contained:
          comparison.status === 'ahead' || comparison.status === 'identical',
      };
    }),
  );
  const stale = verdicts.filter((verdict) => !verdict.contained);
  const narrowed = await Promise.all(
    stale.map(async (verdict) => {
      const narrow = NARROWINGS[verdict.file];
      if (!narrow) return verdict;
      try {
        const ignorable = await narrow({
          fetchJson,
          fetchText,
          repo,
          file: verdict.file,
          baseSha: verdict.sha,
          baseRef,
          headSha,
        });
        return ignorable ? null : verdict;
      } catch (error) {
        // Fail closed. Propagating would reach main()'s fail-open and discard
        // every OTHER gate file's verdict too, so a transient curl failure on
        // this one optional refinement would become a blanket pass. Say so in
        // the log: without this the refinement can stop firing for every PR
        // and leave no trace beyond a stale verdict nobody can explain.
        console.log(
          `::warning::lint gate freshness: could not narrow ${verdict.file} ` +
            `(${error.message}); keeping the stale verdict`,
        );
        return verdict;
      }
    }),
  );
  return narrowed.filter((verdict) => verdict !== null);
}

export function renderReport(stale, baseRef) {
  const lines = stale.map(
    (entry) =>
      `  - ${entry.file}: ${entry.sha.slice(0, 12)} ${entry.message} ` +
      `(${entry.date.slice(0, 10)})\n    ${entry.url}`,
  );
  return [
    `The lint gate changed on '${baseRef}' after this branch last incorporated it:`,
    '',
    ...lines,
    '',
    'This lane checks out the branch head alone, so its green proves the branch',
    'passes the gate AS THE BRANCH DEFINES IT — with the files above, that gate',
    `is stale. Merge or rebase '${baseRef}' into this branch and push to`,
    're-validate under the current gate.',
  ].join('\n');
}

async function main() {
  const { GITHUB_TOKEN, BASE_REF, HEAD_SHA, GITHUB_REPOSITORY } = process.env;
  if (!GITHUB_TOKEN || !BASE_REF || !HEAD_SHA || !GITHUB_REPOSITORY) {
    console.log(
      '::warning::lint gate freshness: BASE_REF, HEAD_SHA, ' +
        'GITHUB_REPOSITORY or GITHUB_TOKEN missing; skipping the check',
    );
    return;
  }
  try {
    const fetchJson = (path) => curlJson(path, GITHUB_TOKEN);
    const fetchText = (path) => curlText(path, GITHUB_TOKEN);
    const stale = await findStaleGateFiles({
      fetchJson,
      fetchText,
      repo: GITHUB_REPOSITORY,
      baseRef: BASE_REF,
      headSha: HEAD_SHA,
    });
    if (stale.length === 0) {
      // Not "contains every change": the ignores narrowing can pass a branch
      // that lacks a base-side addition, because that addition cannot
      // invalidate it.
      console.log(
        `Lint gate freshness OK: no '${BASE_REF}' change to the ` +
          `${GATE_FILES.length} gate files invalidates this branch.`,
      );
      return;
    }
    console.error(renderReport(stale, BASE_REF));
    process.exitCode = 1;
  } catch (error) {
    console.log(
      `::warning::lint gate freshness check could not run ` +
        `(${error.message}); treating the branch as fresh`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
