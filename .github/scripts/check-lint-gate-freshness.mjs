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
 * diff (#11378 cleaned up). Nothing else catches this: `main`'s ruleset
 * (9234124) requires four status checks — `Lint & Static (ubuntu-latest,
 * Node 22.x)` among them — but all four judge the branch alone, none compares
 * the branch's gate with the base's, and the merge queue has been off since
 * 2026-07-02.
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
 * The same over-rejection applies to ci.yml, for a different reason: it holds
 * the whole CI definition, and most of its traffic is not the lint gate at
 * all. Runner routing, checkout repair, shard counts, disk collectors — six of
 * its ten commits in the week of 2026-11-04 were that kind of churn, and each
 * one asked every in-flight PR to rebase. That is the treadmill the
 * package.json exclusion above exists to avoid, reintroduced through one path.
 * So ci.yml's narrowing compares only the LINT GATE this file defines: the
 * workflow env, the profile classifier, and the gate-defining steps of the
 * lint job. A base-side edit confined to the plumbing leaves that slice
 * byte-identical and passes. See
 * docs/design/2026-11-11-lint-gate-freshness-ci-slice.md.
 *
 * Unlike the scope argument this is not an ordering claim but an equality claim
 * on a slice, and its risk is misclassifying a gate step as plumbing. The
 * plumbing list is therefore a whitelist of what may be IGNORED: a step named
 * in neither list stays in the slice, so forgetting to classify a new gate step
 * costs at most today's over-rejection rather than hiding a gate change. A
 * plumbing step whose body invokes a linter refuses the narrowing outright, and
 * every structural shape the extractor does not model returns null and keeps
 * whole-file containment: a duplicate key, a sequence item that is not a
 * single-quoted `- name:`, a tab indent, an anchor or alias (a line model cannot
 * follow a cross-reference), a job key off indent 2, or a body line outside a
 * key's region. Dropped regions are not deleted silently — each leaves a
 * `[[dropped ...]]` marker in the compared text, so the job roster and the
 * position of what was excluded are part of the claim. The test suite reads the
 * real workflow and requires every plumbing name to exist in the gate jobs, so a
 * renamed step cannot leave a stale entry silently excluding nothing.
 *
 * Fail-open on API errors: `Lint & Static` is a required status check in main's
 * ruleset, so a red here blocks the merge rather than annotating it. That
 * sharpens the cost of over-rejection but not the policy: a GitHub API brownout
 * must not hold every PR hostage, so API failures still fail open and the
 * warning stays in the log.
 *
 * Cost: two API calls per gate file (latest base-side commit, then a
 * containment compare), plus the narrowing's own reads only for a gate file
 * whose verdict already came back stale. The per-file `commits?path=` lookup is
 * exact where the alternative — scanning one swapped compare's file list — caps
 * at 300 files, and a branch a few days behind a repo merging 50-100 PRs a day
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

/**
 * Steps that carry runner plumbing rather than the lint gate: they pick the
 * machine, hand it a clean tree, or clean up after it. None of them changes
 * what the lane CHECKS, so a base-side edit to one must not ask every in-flight
 * PR to rebase.
 *
 * The default is the opposite: an unnamed step stays in the slice. That
 * includes the install prelude, deliberately — those steps decide whether the
 * lane reaches its linters at all, and #16900 / #16920 widened exactly that
 * prelude to close a post-merge lint gap. An install a profile skips is a
 * linter that profile never runs.
 *
 * Two steps that harden the tree the linters read are deliberately NOT here:
 * `Restore workspace ownership` and `Clean stale .qwen before checkout` sanitise
 * the workspace before checkout, and untrusted fork code runs in this job. A
 * base-side hardening of either is a security fix that must reach in-flight
 * branches, and they are edited on incidents rather than on routing churn, so
 * they stay in the slice and stale the branch like any other gate change.
 *
 * So the list is a whitelist of what may be IGNORED, not of what matters:
 * forgetting to classify a new gate step keeps it in the slice and costs at
 * most today's over-rejection, while a wrong entry here would hide a real gate
 * change. `LINTER_INVOCATION` below refuses any entry that runs a linter, and
 * the test suite requires every plumbing name to exist in the workflow so a
 * renamed step cannot leave a stale entry silently excluding nothing.
 *
 * One entry is safe only because of a step that is NOT here, and the coupling
 * is not re-derivable from this list: `Checkout` carries `fetch-depth: 1`, while
 * `scripts/lint-scope.js` needs `git merge-base baseSha HEAD` to compute the
 * incremental scope. The depth guarantee lives in `Fetch incremental lint
 * history`, which fetches the base at depth 100 and deepens until the merge
 * base resolves — and that step is deliberately absent below, so it stays in
 * the slice as the only guard of that guarantee. Losing the merge base does not
 * narrow what lint covers: `lint-scope.js` then reports `full: true` and the
 * lane runs the wider, slower full lint, which is the direction the test pins.
 */
export const CI_PLUMBING_STEPS = new Set([
  'Create isolated HOME',
  'Recreate runner Git metadata',
  'Checkout',
  'Verify checkout includes expected head commit',
  'Select Linux runner',
  'Verify trusted classifier checkout is clean',
  'Checkout trusted CI classifier',
  'Disk floor gate (self-hosted)',
  'Configure persistent npm cache (self-hosted)',
  'Configure npm for rate limiting',
  'Report npm cache usage (self-hosted)',
  'Clean isolated HOME',
  'Dump disk state on failure',
  'Upload disk-pressure samples',
]);

// Node provisioning stays in the slice on purpose: `setup-node`'s version and
// the pnpm store action decide the toolchain the linters run under, so a bump
// there can change lint semantics. Only the cache's location and retry
// settings are excluded above.

// Job keys that only place the job on a machine, or cap how long it may take.
// `env`, `if`, `needs`, `outputs`, `permissions`, `steps` and anything unlisted
// stay in the slice: they decide what runs, not where.
const CI_PLUMBING_JOB_KEYS = new Set(['runs-on', 'timeout-minutes']);

// The two jobs that define the gate: the classifier picks the profile, which
// picks the linters, and the lint job runs them. Every other job in this
// workflow is a test, build or E2E lane — a shard-count edit there cannot
// change what lint checks.
const CI_GATE_JOBS = ['classify_pr', 'lint_and_static'];

// A plumbing step that invokes a linter contradicts its classification: refuse
// the narrowing rather than trust the label. `node --test` counts too — the
// helper battery is a gate. The package-manager forms are part of the pattern
// because that is how the lanes are actually reached: `npm run lint`,
// `pnpm run lint`, `corepack pnpm run lint`, a bare `pnpm lint`, `npx`. A bare
// `\bnpm run\b` matched none of the `pnpm` spellings (`pnpm` has no word
// boundary before `npm`), so the refusal could be stepped around by changing
// the manager. A manager followed by `config`/`set` is configuration, not an
// invocation, so the form is anchored on the command that follows.
const LINTER_INVOCATION =
  /scripts\/lint\.js|node --test|\b(?:npx|pnpx|bunx)\b|(?:corepack\s+)?(?:npm|pnpm|yarn|bun)\s+(?:run|run-script|exec|dlx|test|ci|install|i|x|lint|prettier|eslint|format)\b|prettier|eslint|actionlint|shellcheck|yamllint/;

// Every YAML line terminator, `\r\n` first so a CRLF pair counts once. A lone
// `\r` terminates a line in YAML too, and the earlier `split('\n')` read a
// CR-terminated file as one long line: a base file that used CR parsed to 43
// steps while the slice built from the branch's 42-step copy was byte-identical
// — the #11117 → #11216 shape, with the flag flipped on main and the branch
// still certified fresh.
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;

// An anchor or an alias in value position. This extractor is a line model: an
// anchor defined in one place and read in another cannot be followed, so a file
// carrying either is refused outright. Otherwise `&lintcmd 'node
// scripts/lint.js --prettier'` and the `--write` version of the same anchor
// render an identical slice wherever `*lintcmd` is cited, and the alias carries
// meaning the compared text does not.
const ANCHOR_OR_ALIAS = /(?:^|[\s[(,:=])[&*][A-Za-z0-9_][\w.-]*/;

// The indent of a block-scalar opener, or null when the line is not one.
// `run: |`, `with: >-`, `timeout: |2-` are all openers; the chomping indicator
// and the explicit indentation may come in either order (`|+2` and `|2+` are
// both legal YAML, as are `>-2` and `>2-`). Everything indented deeper than the
// opener is scalar CONTENT — the runner reads it as a script, so it is compared
// verbatim, including lines starting with `#` (a shell comment, not a YAML one).
function blockScalarIndent(line) {
  const opener =
    /^(\s*)(?:-\s+)?[^\s#][^:]*:\s*[|>](?:[+-]?\d*|\d+[+-])\s*(?:#.*)?$/.exec(
      line,
    );
  return opener ? opener[1].length : null;
}

// A value that OPENS with `|` or `>` is a scalar whatever follows it. When the
// opener pattern above does not accept the modifier spelled there, the shape is
// one this model does not enumerate — and the answer is null, not "treat the
// body as structure". Deleting the body was the R1-1 hole: `|2-` fell through,
// its lines were reclassified as structure, and every `#` line in the script was
// then dropped as prose.
const SCALAR_VALUE_START = /^(?:\s*)(?:-\s+)?[^\s#][^:]*:\s*[|>]/;

function indentOf(line) {
  return /^ */.exec(line)[0].length;
}

// True when a structural line ends inside a quoted scalar. Tracks both quote
// kinds, a doubled `''` inside single quotes, a backslash escape inside double
// quotes, and a trailing `#` comment (which starts only after whitespace, so
// `run: 'echo #tag'` keeps its `#`). A line that ends inside a quote is a
// multi-line flow scalar, a shape this model does not enumerate.
function endsInsideQuote(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote === null) {
      if (char === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
      if (char === "'" || char === '"') quote = char;
    } else if (quote === "'") {
      if (char === "'") {
        if (line[i + 1] === "'") i += 1;
        else quote = null;
      }
    } else if (char === '\\') {
      i += 1;
    } else if (char === '"') {
      quote = null;
    }
  }
  return quote !== null;
}

/**
 * Split the file into the lines the comparison models.
 *
 * Prose outside block scalars is dropped here, once, so the walk below never
 * has to decide what a blank or comment line means: it cannot be absorbed into
 * a step body (the shape that truncated a job slice), cannot open a step, and
 * cannot hide a structural line. Block-scalar content is marked and kept.
 *
 * Returns null for a line this model cannot classify — a tab in the indent, or
 * an anchor/alias on a structural line.
 */
function structuralLines(text) {
  const lines = [];
  const content = [];
  let scalar = null;
  for (const line of text.split(LINE_BREAK)) {
    // Blank lines carry no meaning in either model: they are dropped wherever
    // they appear, including inside a block scalar, where the surrounding
    // script lines are still compared.
    if (line.trim() === '') continue;
    if (scalar !== null) {
      // Deeper than the opener: the runner reads it, so it is content. A line at
      // or above the opener's indent ends the scalar and is classified normally
      // — which is what keeps a comment block sitting before the NEXT step from
      // being absorbed into this one's script.
      if (indentOf(line) > scalar) {
        lines.push(line);
        content.push(true);
        continue;
      }
      scalar = null;
    }
    if (line.trimStart().startsWith('#')) continue;
    if (/^[ \t]*\t/.test(/^[ \t]*/.exec(line)[0])) return null;
    if (ANCHOR_OR_ALIAS.test(line)) return null;
    // A quoted scalar that does not close on its own line continues on the
    // next one, and those continuation lines are DATA the runner reads. This
    // model is one line at a time, so it refuses rather than let a `#` there be
    // mistaken for prose.
    if (endsInsideQuote(line)) return null;
    scalar = blockScalarIndent(line);
    // The value opens with `|`/`>` but the opener did not accept it: an
    // unenumerated modifier. Refuse; never fall through to the structural path.
    if (scalar === null && SCALAR_VALUE_START.test(line)) return null;
    lines.push(line);
    content.push(false);
  }
  return { lines, content };
}

// A structural drop is recorded in the slice instead of vanishing: its position
// and identity survive the comparison, so moving gate content into a dropped
// region changes the compared text. `[[...]]` is not a YAML comment, so a marker
// can never be mistaken for prose and can never collide with a real line.
const dropped = (what) => `[[dropped ${what}]]`;

/**
 * Split a `steps:` region into named steps. A sequence item that is not
 * `      - name: '<single-quoted name>'` returns null: a bare `-` with the name
 * on the next line, an unnamed `- uses:`, a double-quoted name and a block
 * scalar name are shapes this model refuses rather than guesses at. Refusing is
 * what keeps a name-carrying step from being absorbed into its predecessor.
 */
function splitSteps(lines, content) {
  if (lines.length === 0 || !/^ {4}steps:\s*$/.test(lines[0])) return null;
  const steps = [];
  let current = null;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (content[i]) {
      if (!current) return null;
      current.lines.push(line);
      continue;
    }
    const indent = indentOf(line);
    if (indent === 6) {
      const opening = /^ {6}- name: '([^']*)'\s*$/.exec(line);
      if (!opening) return null;
      if (current) steps.push(current);
      current = { name: opening[1], lines: [line] };
    } else if (indent > 6) {
      if (!current) return null;
      current.lines.push(line);
    } else {
      return null;
    }
  }
  if (current) steps.push(current);
  return steps.length > 0 ? steps : null;
}

// The end of the job-level region opened at `start`: the first modelled line
// indented four or less. Block-scalar content is part of the region whatever its
// indent, so a `timeout-minutes: |-` body cannot be left behind under the next
// key.
function regionEnd(lines, content, start) {
  let i = start + 1;
  while (i < lines.length) {
    if (content[i] || indentOf(lines[i]) > 4) {
      i += 1;
      continue;
    }
    break;
  }
  return i;
}

/**
 * One gate job's contribution to the slice, or null when it holds a shape this
 * extractor does not model. Job keys in CI_PLUMBING_JOB_KEYS are dropped with
 * their region and replaced by a marker; `steps:` is split and each step is kept
 * unless named as plumbing, and a plumbing step that invokes a linter refuses
 * the whole narrowing.
 *
 * Keys are read in file order, so a job-level key placed AFTER `steps:` is a
 * key, not the tail of the last step.
 */
function gateJobSlice(name, lines, content) {
  const kept = [`  ${name}:`];
  let i = 0;
  let sawSteps = false;
  while (i < lines.length) {
    if (content[i] || indentOf(lines[i]) !== 4) return null;
    const key = /^ {4}([A-Za-z0-9_-]+):/.exec(lines[i]);
    if (!key) return null;
    const end = regionEnd(lines, content, i);
    const chunk = lines.slice(i, end);
    if (key[1] === 'steps') {
      const steps = splitSteps(chunk, content.slice(i, end));
      if (!steps) return null;
      sawSteps = true;
      const seen = new Set();
      for (const step of steps) {
        if (seen.has(step.name)) return null;
        seen.add(step.name);
        const text = step.lines.join('\n');
        if (CI_PLUMBING_STEPS.has(step.name)) {
          if (LINTER_INVOCATION.test(text)) return null;
          kept.push(dropped(`plumbing-step '${step.name}'`));
          continue;
        }
        kept.push(...step.lines);
      }
    } else if (CI_PLUMBING_JOB_KEYS.has(key[1])) {
      kept.push(dropped(`job-key '${key[1]}'`));
    } else {
      kept.push(...chunk);
    }
    i = end;
  }
  // A gate job without a steps sequence is a shape that cannot be compared as a
  // lane at all; treat it like a missing job instead of an empty one.
  return sawSteps ? kept : null;
}

/**
 * The lint gate as ci.yml defines it, or null when the file's shape is not one
 * this extractor models.
 *
 * Kept: everything above `jobs:` (triggers, concurrency, workflow env — the
 * linter versions and HELPER_TESTS lists live there) plus the two gate jobs,
 * minus the plumbing named above. Every other job is dropped, and each dropped
 * job and each dropped plumbing step or job key leaves a `[[dropped ...]]`
 * marker in the compared text: the roster and the order of the file are part of
 * the claim, so a base-side edit that moves content into a dropped region — a
 * new job carrying the install prelude, a renamed step — changes the slice
 * instead of passing silently.
 *
 * Prose is the one class left out of the comparison, by this file's purpose: the
 * narrowing exists because most ci.yml churn is comments. It is removed up front
 * and cannot influence structure; a comment line is never read by the runner.
 * Block-scalar content is the opposite — it IS what the runner reads — and is
 * compared verbatim.
 *
 * Refused (null): a tab indent, an anchor or alias anywhere on a structural line
 * (a line model cannot follow a cross-reference), a sequence item that is not a
 * single-quoted `- name:`, a job key not at indent 2 or a job body line outside
 * a key region, a duplicated job key, and a missing `jobs:`, `classify_pr` or
 * `lint_and_static`.
 */
export function extractLintGateSlice(text) {
  const parsed = structuralLines(text);
  if (!parsed) return null;
  const { lines, content } = parsed;
  const jobsAt = lines.findIndex((line) => line === 'jobs:');
  if (jobsAt === -1) return null;
  const slice = [...lines.slice(0, jobsAt + 1)];

  // Job key -> [start, end) in `lines`. Comments are already gone, so the body
  // is contiguous and a key is always at indent 2.
  const bodies = new Map();
  let current = null;
  for (let i = jobsAt + 1; i < lines.length; i += 1) {
    if (content[i]) {
      if (current === null) return null;
      bodies.get(current)[1] = i + 1;
      continue;
    }
    const indent = indentOf(lines[i]);
    if (indent === 2) {
      const key = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i]);
      // `  name: value` is a job whose value is not a mapping; a column-zero
      // line is the next top-level key, which this model does not read.
      if (!key || bodies.has(key[1])) return null;
      bodies.set(key[1], [i + 1, i + 1]);
      current = key[1];
      continue;
    }
    if (indent <= 2 || current === null) return null;
    bodies.get(current)[1] = i + 1;
  }

  const seen = new Set();
  for (const [job, [start, end]] of bodies) {
    const body = lines.slice(start, end);
    const flags = content.slice(start, end);
    if (!CI_GATE_JOBS.includes(job)) {
      slice.push(dropped(`job '${job}'`));
      continue;
    }
    const kept = gateJobSlice(job, body, flags);
    if (!kept) return null;
    seen.add(job);
    slice.push(...kept);
  }
  for (const job of CI_GATE_JOBS) if (!seen.has(job)) return null;
  return slice.join('\n');
}

/**
 * True when the base-side ci.yml change cannot invalidate this branch: the
 * lint gate the file defines is byte-identical on both sides.
 *
 * The two sides are the base TIP and the MERGE BASE — not the head. Comparing
 * the head's slice would flag a branch for its own gate edit and keep flagging
 * it after the rebase it asks for, because main will not carry that edit until
 * the branch merges. The question is whether the gate moved UNDER this branch,
 * so the branch's own version never enters the comparison.
 *
 * That leaves the branch's own edits outside this check, and NOT because some
 * other mechanism covers them: containment only reads a compare's status, never
 * its file list, so a branch that deletes a lint step from its own copy is
 * invisible here — it would pass even a whole-file containment verdict. The
 * division of labour is deliberate rather than mechanical: a branch weakening
 * the gate is a product decision, reviewed by humans on the diff and reddened by
 * the post-merge lint on `main`, not something a freshness check should decide.
 * This check asks one question only — did the gate move UNDER the branch.
 *
 * The merge base comes from the containment compare the caller ALREADY made,
 * not from a second one. A fresh `base...head` compare on this repo returns
 * ~4 MB of commits and files and timed out at curl's 30-second ceiling when
 * measured against a real week-old branch; that failure would have reached
 * main()'s fail-open and discarded every other gate file's verdict too. The
 * existing compare is between the base-side gate commit S and the head, and
 * since S is on main and is not contained (the verdict is stale), its merge
 * base IS the branch's fork point from main. Should it ever be older, the
 * slice comparison over-rejects — the safe direction.
 */
async function narrowsToUnchangedLintSlice({
  fetchText,
  repo,
  baseRef,
  file,
  mergeBase,
}) {
  if (!mergeBase) throw new Error('the compare carried no merge base commit');
  const [baseText, branchText] = await Promise.all(
    [baseRef, mergeBase].map((ref) =>
      fetchText(
        `/repos/${repo}/contents/${file}?ref=${encodeURIComponent(ref)}`,
      ),
    ),
  );
  const base = extractLintGateSlice(baseText);
  const branch = extractLintGateSlice(branchText);
  // Throw, not `return false`: the caller's catch is what emits the warning, so
  // a silent false would disable the narrowing for every PR and leave no trace
  // beyond a stale verdict nobody can explain.
  if (!base || !branch)
    throw new Error('could not extract the lint gate slice');
  return base === branch;
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
  '.github/workflows/ci.yml': narrowsToUnchangedLintSlice,
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
  // Only the fork-point SHA is retained, not the compare response: one of those
  // was measured at ~4 MB, and holding all nine through the narrowing phase
  // would keep them alive for a single field. Kept beside the verdicts rather
  // than on them, because the verdict shape is what the report renders and the
  // tests assert. Passing it along means no narrowing pays a second compare.
  const mergeBases = new Map();
  const verdicts = await Promise.all(
    candidates.map(async (candidate) => {
      const comparison = await fetchJson(
        `/repos/${repo}/compare/${candidate.sha}...${headSha}`,
      );
      mergeBases.set(candidate.file, comparison.merge_base_commit?.sha);
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
          mergeBase: mergeBases.get(verdict.file),
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
