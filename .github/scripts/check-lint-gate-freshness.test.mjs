import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

import {
  CI_GATE_JOBS,
  CI_PLUMBING_STEPS,
  GATE_FILES,
  TEXT_ACCEPT,
  extractLintGateSlice,
  findStaleGateFiles,
  ignoreLines,
  lintGateDocument,
  renderReport,
  splitGlobalIgnores,
} from './check-lint-gate-freshness.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function fakeFetch(handlers, calls = []) {
  return async (path) => {
    calls.push(path);
    for (const [pattern, response] of handlers) {
      if (path.startsWith(pattern)) return response;
    }
    throw new Error(`unexpected path: ${path}`);
  };
}

function commitsResponse(sha) {
  return [
    {
      sha,
      commit: {
        message: `ci: change the gate (#1)\n\nbody`,
        committer: { date: '2026-09-07T00:44:18Z' },
      },
      html_url: `https://github.com/QwenLM/qwen-code/commit/${sha}`,
    },
  ];
}

const BASE_OPTS = {
  repo: 'QwenLM/qwen-code',
  baseRef: 'main',
  headSha: 'f'.repeat(40),
  gateFiles: ['scripts/lint.js'],
};

test('pins the gate file list', () => {
  // Mutation witness: dropping a gate file from the list — lint.js being
  // the file whose --write → --check flip caused #11378 — must redden this
  // assertion, or the check silently stops watching that gate.
  assert.deepEqual(GATE_FILES, [
    'scripts/lint.js',
    'scripts/lint-scope.js',
    'eslint.config.js',
    'eslint.legacy-filenames.mjs',
    'eslint.legacy-core-barrel-imports.mjs',
    '.prettierrc.json',
    '.prettierignore',
    '.github/workflows/ci.yml',
    '.github/scripts/check-lint-gate-freshness.mjs',
  ]);
});

test('passes when the branch contains the base-side gate change', async () => {
  const calls = [];
  const fetchJson = fakeFetch(
    [
      ['/repos/QwenLM/qwen-code/commits?', commitsResponse('a'.repeat(40))],
      [
        `/repos/QwenLM/qwen-code/compare/${'a'.repeat(40)}...`,
        { status: 'ahead' },
      ],
    ],
    calls,
  );
  assert.deepEqual(await findStaleGateFiles({ ...BASE_OPTS, fetchJson }), []);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('path=scripts%2Flint.js'));
  assert.ok(calls[0].includes('sha=main'));
  assert.ok(calls[1].endsWith(`...${'f'.repeat(40)}`));
});

test('treats an identical head as contained', async () => {
  const fetchJson = fakeFetch([
    ['/repos/QwenLM/qwen-code/commits?', commitsResponse('a'.repeat(40))],
    [
      `/repos/QwenLM/qwen-code/compare/${'a'.repeat(40)}...`,
      { status: 'identical' },
    ],
  ]);
  assert.deepEqual(await findStaleGateFiles({ ...BASE_OPTS, fetchJson }), []);
});

test('flags a diverged compare as stale', async () => {
  const fetchJson = fakeFetch([
    ['/repos/QwenLM/qwen-code/commits?', commitsResponse('a'.repeat(40))],
    [
      `/repos/QwenLM/qwen-code/compare/${'a'.repeat(40)}...`,
      { status: 'diverged' },
    ],
  ]);
  const stale = await findStaleGateFiles({ ...BASE_OPTS, fetchJson });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].file, 'scripts/lint.js');
  assert.equal(stale[0].message, 'ci: change the gate (#1)');
  assert.equal(stale[0].date, '2026-09-07T00:44:18Z');
});

test('flags "behind" as stale: the head is an ancestor of the gate commit', async () => {
  const fetchJson = fakeFetch([
    ['/repos/QwenLM/qwen-code/commits?', commitsResponse('a'.repeat(40))],
    [
      `/repos/QwenLM/qwen-code/compare/${'a'.repeat(40)}...`,
      { status: 'behind' },
    ],
  ]);
  const stale = await findStaleGateFiles({ ...BASE_OPTS, fetchJson });
  assert.equal(stale.length, 1);
});

test('skips a gate file that never existed on the base', async () => {
  const calls = [];
  const fetchJson = fakeFetch(
    [['/repos/QwenLM/qwen-code/commits?', []]],
    calls,
  );
  assert.deepEqual(await findStaleGateFiles({ ...BASE_OPTS, fetchJson }), []);
  // No containment compare without a base-side commit.
  assert.equal(calls.length, 1);
});

test('propagates API errors so the caller can fail open', async () => {
  const fetchJson = async () => {
    throw new Error('403 rate limit');
  };
  await assert.rejects(findStaleGateFiles({ ...BASE_OPTS, fetchJson }), /403/);
});

test('report names the file, the commit, and the remedy', () => {
  const report = renderReport(
    [
      {
        file: 'scripts/lint.js',
        sha: 'a'.repeat(40),
        message: 'ci: change the gate (#1)',
        date: '2026-09-07T00:44:18Z',
        url: 'https://github.com/QwenLM/qwen-code/commit/' + 'a'.repeat(40),
      },
    ],
    'main',
  );
  assert.match(report, /scripts\/lint\.js/);
  assert.match(report, /aaaaaaaaaaaa/);
  assert.match(report, /2026-09-07/);
  assert.match(report, /rebase 'main' into this branch/);
});

test('ci.yml wires the check into lint_and_static before the lint lanes', () => {
  const ci = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  // Slice out the lint_and_static job: from its key to the next job key.
  // Bounded by the next job KEY, not by a named neighbour: `test_macos` is an
  // unrelated lane, and renaming it would leave this bound at -1.
  const { start: jobStart, end: jobEnd } = jobSpan(ci, 'lint_and_static');
  const job = ci.slice(jobStart, jobEnd);

  const step = job.indexOf("- name: 'Check lint gate freshness'");
  assert.ok(step > 0, 'freshness step missing');
  // PRs only: merge_group validates the prospective merged tree (fresh by
  // construction) and push validates the base itself.
  const stepBlock = job.slice(step, job.indexOf('\n      - name:', step + 1));
  // Whole literal, not the substrings this used to check: appending
  // `&& ... != 'docs_only'` keeps every one of those tokens in place, and that
  // revert was green on every suite while re-opening the stale-gate hole for
  // docs-only PRs — a lane that still runs Prettier, but against the branch's
  // older .prettierrc/lint.js, which is the post-merge class this check exists
  // to catch (#16872, #16918). No profile arm: every profile runs a lint lane,
  // docs_only included, so keying this gate on the profile could only narrow
  // it — the hole this pin closes. On a skip_ci PR `Use trusted CI profile`
  // is skipped, so the output is '' rather than a profile name.
  assert.equal(
    stepBlock.match(/^ {8}if: "(.*)"$/m)?.[1],
    "${{ needs.classify_pr.outputs.skip_ci != 'true' && github.event_name == 'pull_request' }}",
    'freshness gate drifted',
  );
  // The gate must stay fatal: `continue-on-error` would leave the literal
  // above intact while the freshness check stops blocking the required
  // check (#16918). Read the key through the parser, not by matching a line:
  // `continue-on-error : true` (space before the colon), a quoted key and flow
  // style are all legal YAML that silences the step, and a line-shaped pattern
  // finds none of them — it reads the edit as an absent key and stays green
  // while the gate stops blocking. This file already parses ci.yml with `yaml`
  // below, so the model costs nothing here. The same class bit the autofix
  // signature extractor in #17011, where a Prettier re-quote silently emptied a
  // pattern that every behavioural assertion then matched trivially.
  // One call covers all three pins that used to live here: this step, the
  // freshness suite step further down, and the JOB level — the last of which no
  // slice could ever see, since a job-level key sits above `steps:` and outside
  // every step block, while silencing every step in the job including this one.
  // It reads the whole workflow rather than the slice above for that reason.
  assertNoContinueOnError(
    ci,
    'lint_and_static',
    'Check lint gate freshness',
    'Run lint gate freshness tests',
  );
  // Nor may the run line swallow the exit code. Mutation witness: `run: 'node
  // .github/scripts/check-lint-gate-freshness.mjs || true'` keeps the `if`
  // literal, the command containment and the continue-on-error pin above all
  // intact, and both this suite and ci-platform-lanes stayed green on the
  // merged head — while the gate exits 0 on a stale lint configuration,
  // re-opening the post-merge breakage class it exists to catch (#16872,
  // #16918). Containment proves the command is present, not that its failure
  // reaches the job; this is the body half of that pair, mirroring the
  // convention the load-bearing lint gates already use in
  // scripts/tests/ci-platform-lanes.test.js. `|| :` is the same hole spelled
  // differently. A bare `||` is not matched: `|| {` is a legitimate retry shape
  // elsewhere in this job.
  assert.doesNotMatch(
    stepBlock,
    /\|\|\s*(true|:)(\s|'|$)/,
    'the freshness run must not swallow its exit code',
  );
  assert.ok(
    stepBlock.includes('node .github/scripts/check-lint-gate-freshness.mjs'),
    'step must run the freshness script',
  );
  assert.ok(
    stepBlock.includes('github.event.pull_request.base.ref') &&
      stepBlock.includes('github.event.pull_request.head.sha'),
    'step must pass the PR base ref and head sha',
  );
  // The check parses ci.yml with the `yaml` package, so it now runs after the
  // install — the price wenshao accepted for a model with no unenumerated-YAML
  // class. It still precedes the lint lanes it can make pointless.
  assert.ok(
    step < job.indexOf("- name: 'Run ESLint'"),
    'freshness step must precede Run ESLint',
  );
  assert.ok(
    step > job.indexOf("- name: 'Install dependencies'"),
    'freshness step must follow the install it depends on',
  );
  assert.ok(
    job.includes("name: 'Run lint gate freshness tests'"),
    'the github_ci_only profile must run the freshness suite',
  );
  // The step's own wiring, not just its name. Its profile arm and its run line
  // are what make the most relevant profile execute the suite: dropping the
  // arm runs it on profiles that do not need it, and pointing the run line at
  // another file leaves the name in place while this suite stops running.
  const suiteStep = job.indexOf("- name: 'Run lint gate freshness tests'");
  const suiteBlock = job.slice(
    suiteStep,
    job.indexOf('\n      - name:', suiteStep + 1),
  );
  assert.equal(
    suiteBlock.match(/^ {8}if: "(.*)"$/m)?.[1],
    "${{ needs.classify_pr.outputs.skip_ci != 'true' && steps.ci_profile.outputs.ci_profile == 'github_ci_only' }}",
    'the freshness suite must run on the github_ci_only profile',
  );
  assert.ok(
    suiteBlock.includes(
      'node --test --test-concurrency=1 .github/scripts/check-lint-gate-freshness.test.mjs',
    ),
    'the step must run this suite',
  );
  // This step's fatality is pinned by the same parsed reading as the gate's
  // above. The body half of that pair still needs its own assertion here:
  // `|| true` (or `|| :`) leaves the profile arm, the run-line containment and
  // the continue-on-error pin all intact while the suite exits 0 on a failure.
  // This step is the only reason the suite runs on github_ci_only at all, so a
  // silenced one restores exactly the coverage gap it was added to close.
  assert.doesNotMatch(
    suiteBlock,
    /\|\|\s*(true|:)(\s|'|$)/,
    'the freshness suite must not swallow its exit code',
  );
  // The suite imports `yaml`, so it can only run once the install has happened.
  assert.ok(
    suiteStep > job.indexOf("- name: 'Install dependencies'"),
    'the freshness suite must follow the install it depends on',
  );
});

const GATE_SHA = 'a'.repeat(40);
const HEAD_SHA = BASE_OPTS.headSha;
const ESLINT_OPTS = { ...BASE_OPTS, gateFiles: ['eslint.config.js'] };

function configWith(ignores, tail = '') {
  return [
    'export default tseslint.config(',
    '  {',
    '    // Global ignores',
    '    ignores: [',
    ...ignores.map((entry) => `      '${entry}',`),
    '    ],',
    '  },',
    tail,
    ');',
    '',
  ].join('\n');
}

function divergedJson() {
  return fakeFetch([
    ['/repos/QwenLM/qwen-code/commits?', commitsResponse(GATE_SHA)],
    [`/repos/QwenLM/qwen-code/compare/${GATE_SHA}...`, { status: 'diverged' }],
  ]);
}

function textFetch(baseText, headText, calls = [], file = 'eslint.config.js') {
  return async (path) => {
    calls.push(path);
    // Pin the file too, not just the ref: fetching the wrong path would
    // otherwise be served the same fixture and stay green.
    const prefix = `/repos/QwenLM/qwen-code/contents/${file}?ref=`;
    if (!path.startsWith(prefix)) throw new Error(`unexpected path: ${path}`);
    if (path === `${prefix}${GATE_SHA}`) return baseText;
    if (path === `${prefix}${HEAD_SHA}`) return headText;
    throw new Error(`unexpected ref: ${path}`);
  };
}

const PRETTIER_OPTS = { ...BASE_OPTS, gateFiles: ['.prettierignore'] };
const ignoreFile = (lines) => `${lines.join('\n')}\n`;

// Prettier's scope is every ignore file in the tree, read at the base TIP.
// Serves commits/compare/trees on fetchJson and the root .prettierignore on
// fetchText, recording every path so a wrong-ref fetch cannot pass silently.
const BASE_REF = 'main';
const blob = (s) => createHash('sha1').update(s).digest('hex');

function prettierFetch(
  {
    basePi,
    headPi,
    baseScope = {},
    headScope = {},
    truncated = false,
    // Per-side flags: a single shared one cannot tell the two halves of
    // `baseTree.truncated || headTree.truncated` apart, so each arm would
    // survive its own removal. `truncated` stays as shorthand for both.
    baseTruncated = truncated,
    headTruncated = truncated,
    baseRef = BASE_REF,
  },
  calls = [],
) {
  const treeFor = (scope, pi, isTruncated) => ({
    truncated: isTruncated,
    tree: [
      { type: 'blob', path: '.prettierignore', sha: blob(ignoreFile(pi)) },
      ...Object.entries(scope).map(([path, text]) => ({
        type: 'blob',
        path,
        sha: blob(text),
      })),
      { type: 'blob', path: 'src/a.ts', sha: blob('unrelated') },
    ],
  });
  const trees = {
    [baseRef]: treeFor(baseScope, basePi, baseTruncated),
    [HEAD_SHA]: treeFor(headScope, headPi, headTruncated),
  };
  const piText = {
    [baseRef]: ignoreFile(basePi),
    [HEAD_SHA]: ignoreFile(headPi),
  };
  return {
    fetchJson: async (path) => {
      calls.push(path);
      if (path.startsWith('/repos/QwenLM/qwen-code/commits?'))
        return commitsResponse(GATE_SHA);
      if (path.startsWith(`/repos/QwenLM/qwen-code/compare/${GATE_SHA}...`))
        return { status: 'diverged' };
      const t =
        /^\/repos\/QwenLM\/qwen-code\/git\/trees\/(.+)\?recursive=1$/.exec(
          path,
        );
      if (t && decodeURIComponent(t[1]) in trees)
        return trees[decodeURIComponent(t[1])];
      throw new Error(`unexpected json path: ${path}`);
    },
    fetchText: async (path) => {
      calls.push(path);
      const m =
        /^\/repos\/QwenLM\/qwen-code\/contents\/\.prettierignore\?ref=(.+)$/.exec(
          path,
        );
      if (m && decodeURIComponent(m[1]) in piText)
        return piText[decodeURIComponent(m[1])];
      throw new Error(`unexpected text path: ${path}`);
    },
  };
}

test('a base-side global ignore addition does not stale the branch', async () => {
  // Mutation witness: deleting the post-filter leaves this stale. This is the
  // #16200 shape named by all 9 measured freshness reds.
  const calls = [];
  const stale = await findStaleGateFiles({
    ...ESLINT_OPTS,
    fetchJson: divergedJson(),
    fetchText: textFetch(
      configWith(['node_modules/*', 'dist/**']),
      configWith(['node_modules/*']),
      calls,
    ),
  });
  assert.deepEqual(stale, []);
  // Only the two content fetches, and only on an already-stale verdict.
  assert.equal(calls.length, 2);
});

test('a base-side global ignore REMOVAL still stales the branch', async () => {
  // Mutation witness: inverting the subset to `base ⊆ head` passes this
  // wrongly. The base now checks a file the branch never linted.
  const stale = await findStaleGateFiles({
    ...ESLINT_OPTS,
    fetchJson: divergedJson(),
    fetchText: textFetch(
      configWith(['node_modules/*']),
      configWith(['node_modules/*', 'dist/**']),
    ),
  });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].file, 'eslint.config.js');
});

test('a branch-only ignore stales even when the base also added one', async () => {
  const stale = await findStaleGateFiles({
    ...ESLINT_OPTS,
    fetchJson: divergedJson(),
    fetchText: textFetch(
      configWith(['node_modules/*', 'base-only/**']),
      configWith(['node_modules/*', 'branch-only/**']),
    ),
  });
  assert.equal(stale.length, 1);
});

test('an ignore addition plus a rule change still stales the branch', async () => {
  // Mutation witness: dropping the remainder-equality conjunct passes this.
  const stale = await findStaleGateFiles({
    ...ESLINT_OPTS,
    fetchJson: divergedJson(),
    fetchText: textFetch(
      configWith(
        ['node_modules/*', 'dist/**'],
        "  { rules: { 'no-var': 'error' } },",
      ),
      configWith(['node_modules/*'], "  { rules: { 'no-var': 'warn' } },"),
    ),
  });
  assert.equal(stale.length, 1);
});

test('a config-scoped ignores addition still stales the branch', async () => {
  // Mutation witness: the base scoped list is a SUPERSET of the head's, so
  // consuming that block instead of the global one would satisfy the subset
  // test and wrongly pass. Only keeping it in the byte-compare makes this stale.
  const scoped = (globs) =>
    [
      '  {',
      "    files: ['packages/core/src/**'],",
      '    ignores: [',
      ...globs.map((glob) => `      '${glob}',`),
      '    ],',
      '  },',
    ].join('\n');
  const stale = await findStaleGateFiles({
    ...ESLINT_OPTS,
    fetchJson: divergedJson(),
    fetchText: textFetch(
      configWith(
        ['node_modules/*'],
        scoped([
          'packages/core/src/generated/**',
          'packages/core/src/other/**',
        ]),
      ),
      configWith(
        ['node_modules/*'],
        scoped(['packages/core/src/generated/**']),
      ),
    ),
  });
  assert.equal(stale.length, 1);
});

test('a content fetch failure keeps every verdict instead of failing open', async () => {
  // Mutation witness: letting the narrowing error propagate reaches main()'s
  // fail-open and would drop the sibling lint.js verdict too.
  const stale = await findStaleGateFiles({
    ...BASE_OPTS,
    gateFiles: ['scripts/lint.js', 'eslint.config.js'],
    fetchJson: divergedJson(),
    fetchText: async () => {
      throw new Error('curl exit 28');
    },
  });
  assert.deepEqual(stale.map((entry) => entry.file).sort(), [
    'eslint.config.js',
    'scripts/lint.js',
  ]);
});

test('a missing ignores anchor keeps the verdict', async () => {
  // Mutation witness: returning true on an extraction miss passes this. An
  // empty-list fallback does NOT witness it — the differing remainders still
  // reject — so the fail-closed return is what this case pins.
  const stale = await findStaleGateFiles({
    ...ESLINT_OPTS,
    fetchJson: divergedJson(),
    fetchText: textFetch(
      configWith(['node_modules/*', 'dist/**']),
      'export default tseslint.config({});',
    ),
  });
  assert.equal(stale.length, 1);
});

test('an unparseable entry line keeps the verdict', async () => {
  // Mutation witness: skipping lines that fail the entry regex would silently
  // shorten the head list into a subset.
  const doubleQuoted = configWith(['node_modules/*']).replace(
    "      'node_modules/*',",
    '      "node_modules/*",',
  );
  const stale = await findStaleGateFiles({
    ...ESLINT_OPTS,
    fetchJson: divergedJson(),
    fetchText: textFetch(
      configWith(['node_modules/*', 'dist/**']),
      doubleQuoted,
    ),
  });
  assert.equal(stale.length, 1);
});

test('a negated entry on the base side blocks the narrowing', async () => {
  // `!` RE-INCLUDES files, so entries are not purely subtractive. Measured on
  // eslint 9.29.0 with lintFiles: this base lints keep.gen.ts, this head lints
  // nothing, yet head is a subset of base. Mutation witness: dropping the
  // negation guard passes this wrongly.
  const stale = await findStaleGateFiles({
    ...ESLINT_OPTS,
    fetchJson: divergedJson(),
    fetchText: textFetch(
      configWith(['**/*.gen.ts', '!**/keep.gen.ts']),
      configWith(['**/*.gen.ts']),
    ),
  });
  assert.equal(stale.length, 1);
});

test('an escaped bang on the base side blocks the narrowing', async () => {
  // The extractor sees source text; ESLint evaluates the decoded string, so
  // '\x21foo' is a negation that startsWith('!') cannot see. Mutation witness:
  // dropping the backslash arm of the guard passes this wrongly.
  const stale = await findStaleGateFiles({
    ...ESLINT_OPTS,
    fetchJson: divergedJson(),
    fetchText: textFetch(
      configWith(['**/*.gen.ts', '\\x21**/keep.gen.ts']),
      configWith(['**/*.gen.ts']),
    ),
  });
  assert.equal(stale.length, 1);
});

test('a base-side prettierignore addition does not stale the branch', async () => {
  // Same subtractive-scope argument, second gate file. Mutation witness:
  // removing .prettierignore from the narrowing table leaves this stale.
  const calls = [];
  const stale = await findStaleGateFiles({
    ...PRETTIER_OPTS,
    ...prettierFetch(
      {
        basePi: ['node_modules', 'packages/live-host/'],
        headPi: ['node_modules'],
      },
      calls,
    ),
  });
  assert.deepEqual(stale, []);
  // commits + compare + two trees + two root-ignore reads.
  assert.equal(calls.length, 6);
  assert.ok(
    calls.some((c) => c.includes('/git/trees/main?recursive=1')),
    'the base tree must be read at the base TIP, not at the gate commit',
  );
});

test('a base-side prettierignore REMOVAL still stales the branch', async () => {
  const stale = await findStaleGateFiles({
    ...PRETTIER_OPTS,
    ...prettierFetch({
      basePi: ['node_modules'],
      headPi: ['node_modules', 'packages/live-host/'],
    }),
  });
  assert.equal(stale.length, 1);
});

test('a negated prettierignore line blocks the narrowing', async () => {
  const stale = await findStaleGateFiles({
    ...PRETTIER_OPTS,
    ...prettierFetch({ basePi: ['*.md', '!keep.md'], headPi: ['*.md'] }),
  });
  assert.equal(stale.length, 1);
});

test('prettierignore comments and blank lines are not patterns', () => {
  assert.deepEqual(ignoreLines('# heading\n\nnode_modules\ndist  \n   \n'), [
    'node_modules',
    'dist',
  ]);
});

test('prettierignore keeps leading whitespace, which is part of the pattern', () => {
  // Measured against prettier: 'foo.js' and ' foo.js' ignore different files,
  // and '  # foo' is a pattern, not a comment. Trimming both ends would merge
  // distinct patterns and could certify a narrower branch scope as fresh.
  assert.deepEqual(ignoreLines('foo.js\n foo.js\n  # foo\n'), [
    'foo.js',
    ' foo.js',
    '  # foo',
  ]);
});

test('a leading-space prettierignore pattern is not conflated with its trimmed form', async () => {
  // base ignores ' foo.js', head ignores 'foo.js': different scopes, and the
  // head excludes a file the base checks. Must stay stale.
  const stale = await findStaleGateFiles({
    ...PRETTIER_OPTS,
    ...prettierFetch({ basePi: [' foo.js'], headPi: ['foo.js'] }),
  });
  assert.equal(stale.length, 1);
});

test('the raw media type is pinned', () => {
  // Every narrowing case injects its own fetchText, so nothing else executes
  // curlText. Flipping this to the JSON media type makes the contents API
  // return an envelope the extractor cannot read, and the fail-closed catch
  // hides it — the refinement would silently stop firing.
  assert.equal(TEXT_ACCEPT, 'application/vnd.github.raw');
  const source = readFileSync(
    join(repoRoot, '.github/scripts/check-lint-gate-freshness.mjs'),
    'utf8',
  );
  assert.match(source, /curlRaw\(path, token, TEXT_ACCEPT\)/);
});

for (const [name, sep] of [
  ['U+2028', '\u2028'],
  ['U+2029', '\u2029'],
  ['a lone CR', '\r'],
]) {
  test(`a ${name} inside a comment cannot hide an ignore entry`, async () => {
    // The engine ends a `//` comment at these terminators and reads the rest
    // as a real entry; a \n-only split saw one comment line and skipped it,
    // under-reporting the branch's own ignores and certifying it fresh.
    const stale = await findStaleGateFiles({
      ...ESLINT_OPTS,
      fetchJson: divergedJson(),
      fetchText: textFetch(
        configWith(['node_modules/*']),
        configWith(['node_modules/*']).replace(
          "      'node_modules/*',",
          `      'node_modules/*',\n      // x${sep} 'hidden/**',`,
        ),
      ),
    });
    assert.equal(stale.length, 1);
  });
}

test('moving the base array into a files-scoped object stays stale', async () => {
  // The extractor takes the first ignores block without proving it is global.
  // The remainder byte-compare is what catches this: the `files:` property
  // lands in `rest`. Pin it so a future loosening of that compare reddens here
  // instead of silently certifying a narrower branch.
  const scoped = [
    'export default tseslint.config(',
    '  {',
    '  },',
    '  {',
    "    files: ['x'],",
    '    ignores: [',
    "      'node_modules/*',",
    '    ],',
    '  },',
    ');',
    '',
  ].join('\n');
  const stale = await findStaleGateFiles({
    ...ESLINT_OPTS,
    fetchJson: divergedJson(),
    fetchText: textFetch(scoped, configWith(['node_modules/*'])),
  });
  assert.equal(stale.length, 1);
});

test('a branch-only .gitignore entry blocks the prettier narrowing', async () => {
  // Prettier 3 reads .gitignore too: measured on 3.6.1, adding apps/host/
  // there drops the checked-file count from 2 to 1. Comparing .prettierignore
  // alone would certify a branch whose prettier scope is smaller.
  const stale = await findStaleGateFiles({
    ...PRETTIER_OPTS,
    ...prettierFetch({
      basePi: ['node_modules', 'packages/live-host/'],
      headPi: ['node_modules'],
      headScope: { '.gitignore': 'apps/host/\n' },
    }),
  });
  assert.equal(stale.length, 1);
});

test('any .gitignore difference blocks the prettier narrowing', async () => {
  // Even a base-side addition: .gitignore is compared by equality, not subset,
  // because the real file carries `!` re-inclusions that would make a semantic
  // comparison reject every input. Conservative, and it never reasons about
  // gitignore semantics.
  const stale = await findStaleGateFiles({
    ...PRETTIER_OPTS,
    ...prettierFetch({
      basePi: ['node_modules'],
      headPi: ['node_modules'],
      baseScope: { '.gitignore': 'apps/host/\n' },
    }),
  });
  assert.equal(stale.length, 1);
});

test('a base-side .gitignore change after the gate commit is still seen', async () => {
  // The Critical: .gitignore owns no gate verdict, so reading it at the
  // .prettierignore gate commit hides any later base-side change. The tree
  // must be read at the base TIP.
  const calls = [];
  const stale = await findStaleGateFiles({
    ...PRETTIER_OPTS,
    ...prettierFetch(
      {
        basePi: ['node_modules', 'packages/live-host/'],
        headPi: ['node_modules'],
        baseScope: { '.gitignore': 'dist/\n' },
        headScope: { '.gitignore': 'dist/\napps/host/\n' },
      },
      calls,
    ),
  });
  assert.equal(stale.length, 1);
  assert.ok(calls.some((c) => c.includes('/git/trees/main?recursive=1')));
});

test('a nested .gitignore difference blocks the prettier narrowing', async () => {
  // prettier discovers ignore files per directory; the lane groups by the
  // nearest ancestor carrying one, so packages/cli/.gitignore scopes a group.
  const stale = await findStaleGateFiles({
    ...PRETTIER_OPTS,
    ...prettierFetch({
      basePi: ['node_modules', 'packages/live-host/'],
      headPi: ['node_modules'],
      baseScope: { 'packages/cli/.gitignore': 'dist/\n' },
      headScope: { 'packages/cli/.gitignore': 'dist/\nextra/\n' },
    }),
  });
  assert.equal(stale.length, 1);
});

test('an ignore file added or removed on either side blocks the narrowing', async () => {
  for (const [baseScope, headScope] of [
    [{ 'packages/cli/.gitignore': 'dist/\n' }, {}],
    [{}, { 'packages/cli/.gitignore': 'dist/\n' }],
  ]) {
    const stale = await findStaleGateFiles({
      ...PRETTIER_OPTS,
      ...prettierFetch({
        basePi: ['node_modules', 'packages/live-host/'],
        headPi: ['node_modules'],
        baseScope,
        headScope,
      }),
    });
    assert.equal(stale.length, 1);
  }
});

// One case per side, not just both at once: the guard is
// `baseTree.truncated || headTree.truncated`, and a shared flag lets either
// arm be deleted with the suite still green. Each shape below is the sole
// witness for its own arm.
for (const [shape, flags] of [
  ['both trees', { truncated: true }],
  ['only the base tree', { baseTruncated: true }],
  ['only the head tree', { headTruncated: true }],
]) {
  test(`a truncated tree never narrows, and says so (${shape})`, async () => {
    // Same principle as the extraction miss: a silent false would stop the
    // narrowing with nothing in the log to explain the stale verdict.
    const logged = [];
    const original = console.log;
    let stale;
    console.log = (m) => logged.push(String(m));
    try {
      stale = await findStaleGateFiles({
        ...PRETTIER_OPTS,
        ...prettierFetch({
          basePi: ['node_modules', 'packages/live-host/'],
          headPi: ['node_modules'],
          ...flags,
        }),
      });
    } finally {
      console.log = original;
    }
    assert.equal(stale.length, 1);
    assert.ok(
      logged.some(
        (m) =>
          m.includes('could not narrow .prettierignore') &&
          m.includes('truncated'),
      ),
      'a truncated tree must annotate why the verdict was kept',
    );
  });
}

test('a base ref containing a hash is URI-encoded in the tree path', async () => {
  // This is the shape the encoder is actually for. '#' and '%' are legal in a
  // git branch name, and an unencoded '#' starts the fragment and swallows
  // '?recursive=1' with it, so the request answers for a DIFFERENT ref instead
  // of failing. Measured live: git/trees/main#frag?recursive=1 -> 200 with 42
  // top-level entries, git/trees/main%23frag?recursive=1 -> 404, and
  // git/trees/main?recursive=1 -> 200 with 16226. Silent wrong-tree read, not a
  // fail-closed refusal. BASE_REF is github.event.pull_request.base.ref, so a
  // 'fix#1'-style base branch reaches this path verbatim.
  const calls = [];
  const stale = await findStaleGateFiles({
    ...PRETTIER_OPTS,
    baseRef: 'fix#1',
    ...prettierFetch(
      {
        basePi: ['node_modules', 'packages/live-host/'],
        headPi: ['node_modules'],
        baseRef: 'fix#1',
      },
      calls,
    ),
  });
  assert.deepEqual(stale, []);
  assert.ok(
    calls.some((c) => c.includes('/git/trees/fix%231?recursive=1')),
    `expected an encoded tree ref, got ${JSON.stringify(calls)}`,
  );
  // On this path the base ref reaches three URLs, not just the tree one: the
  // root `.prettierignore` contents `?ref=` read and the commits `&sha=` lookup
  // interpolate it too. (Two encoders sit outside this path: the ci.yml
  // narrowing's `?ref=` takes a branch name and is pinned by its own case
  // below; `fetchGateFilePair`'s takes hex SHAs.) The tree assertion above says
  // nothing about the other two, and the fixture decodes recorded paths and
  // answers the commits lookup whatever `sha` it carries, so this sweep is what
  // covers them. A raw '#' at the commits site cuts the ref VALUE at the '#',
  // so this case's own `fix#1` is looked up as `fix`: measured live, that 404s
  // (no such branch) and reaches main()'s fail-open, while `&sha=x6#frag`
  // answers 200 with 28415ddff367 — the same commit as `&sha=x6`, a branch that
  // is NOT the default one — and `&sha=x6%23frag` answers 404. Either a silent
  // read of another branch or a false green, never a clean refusal.
  assert.deepEqual(
    calls.filter((c) => c.includes('fix#1')),
    [],
    'every URL embedding the base ref must encode it',
  );
});

test('a base ref containing a percent is URI-encoded in the tree path', async () => {
  // The server decodes '%' escapes, so the ref it looks up is the DECODED one.
  // 'fix%201' is a legal ref; unencoded it is requested verbatim and the server
  // decodes it to 'fix 1', which is NOT a legal ref, so the lookup 404s. What
  // that costs depends on the site: inside the narrowing it fails closed and
  // keeps a stuck stale verdict, but the commits lookup is awaited outside that
  // try, so its 404 reaches main()'s fail-open and reports the branch fresh — a
  // false green. This sample only 404s because its decoded form is illegal; a
  // '%' escape that decodes to an existing ref does read that one (measured:
  // &sha=mai%6E answers 200 with main's commit). The fixture keys trees by the
  // raw ref, so pass 'fix%201' unencoded.
  const calls = [];
  const stale = await findStaleGateFiles({
    ...PRETTIER_OPTS,
    baseRef: 'fix%201',
    ...prettierFetch(
      {
        basePi: ['node_modules', 'packages/live-host/'],
        headPi: ['node_modules'],
        baseRef: 'fix%201',
      },
      calls,
    ),
  });
  assert.deepEqual(stale, []);
  assert.ok(
    calls.some((c) => c.includes('/git/trees/fix%25201?recursive=1')),
    `expected an encoded tree ref, got ${JSON.stringify(calls)}`,
  );
  // The all-hazards case below pins the encoded form at every ref-bearing site,
  // so it already witnesses '%' at the commits `&sha=` encoder too. What this
  // case adds is a sweep of every recorded URL for the raw ref, which catches a
  // leak at a site no case pins by name. 'fix%25201' does not contain
  // 'fix%201', so correct encoding cannot trip the sweep.
  assert.deepEqual(
    calls.filter((c) => c.includes('fix%201')),
    [],
    'every URL embedding the base ref must encode it',
  );
});

// One sample carrying every URL-hazardous character that git still allows in a
// ref ('&', '#', '%', '+', '=', ';', '@' — all pass git check-ref-format; '?'
// and space do not), asserted per site. Adding a row per character is what kept
// regenerating findings: '#' and '%' each got a case while '&' had none, so an
// encoder narrowed to '%'/'#'/'/' passed the whole suite. Three of them can
// name a DIFFERENT EXISTING ref, by three mechanisms: '&' starts another query
// parameter (measured: contents/.prettierignore?ref=main&x answers 200 with
// main's file, ?ref=main%26x answers 404), '#' cuts the value at the fragment
// (measured: &sha=x6#frag reads branch x6), and '%' is decoded server-side
// (measured: &sha=mai%6E reads main). The other four all 404 at that site
// (measured: sha=main;x, main=x, main+x, main@x). A raw-ref scan cannot stand
// in for these: once '#' and '%' are escaped the full raw needle is gone, and
// the query-value sites are exactly where the meaning changes.
const HAZARD_REF = 'a&b#c%d+e=f;g@h';
const HAZARD_ENC = 'a%26b%23c%25d%2Be%3Df%3Bg%40h';

test('every prettier-path URL encodes a ref carrying every hazardous character', async () => {
  const calls = [];
  const stale = await findStaleGateFiles({
    ...PRETTIER_OPTS,
    baseRef: HAZARD_REF,
    ...prettierFetch(
      {
        basePi: ['node_modules', 'packages/live-host/'],
        headPi: ['node_modules'],
        baseRef: HAZARD_REF,
      },
      calls,
    ),
  });
  assert.deepEqual(stale, []);
  for (const wire of [
    `/git/trees/${HAZARD_ENC}?recursive=1`,
    `/contents/.prettierignore?ref=${HAZARD_ENC}`,
    `&sha=${HAZARD_ENC}&per_page=1`,
  ]) {
    assert.ok(
      calls.some((c) => c.includes(wire)),
      `expected ${wire}, got ${JSON.stringify(calls)}`,
    );
  }
});

test('the ci.yml URL encodes a ref carrying every hazardous character', async () => {
  const calls = [];
  const stale = await findStaleGateFiles({
    ...CI_OPTS,
    baseRef: HAZARD_REF,
    ...ciFetch(realCi, realCi, calls, MERGE_BASE_SHA, HAZARD_REF),
  });
  assert.deepEqual(stale, []);
  assert.ok(
    calls.some((c) => c.includes(`?ref=${HAZARD_ENC}`)),
    `expected an encoded contents ref, got ${JSON.stringify(calls)}`,
  );
});

test('a base ref containing a slash is URI-encoded in the tree path', async () => {
  // A slash survives an unencoded path: measured against the live API,
  // git/trees/agent/agent-view-commands?recursive=1 answers 200 with the same
  // tree sha as the encoded form. So this case pins the encoded STRING; the
  // shape that actually misbehaves without the encoder is the '#' case above.
  const calls = [];
  const stale = await findStaleGateFiles({
    ...PRETTIER_OPTS,
    baseRef: 'release/1.0',
    ...prettierFetch(
      {
        basePi: ['node_modules', 'packages/live-host/'],
        headPi: ['node_modules'],
        baseRef: 'release/1.0',
      },
      calls,
    ),
  });
  assert.deepEqual(stale, []);
  assert.ok(
    calls.some((c) => c.includes('/git/trees/release%2F1.0?recursive=1')),
    `expected an encoded tree ref, got ${JSON.stringify(calls)}`,
  );
});

test('an extraction miss emits the warning, not a silent false', async () => {
  // The design promises a ::warning:: on extraction failure too. Returning
  // false instead of throwing keeps the verdict but skips the catch that logs.
  const logged = [];
  const original = console.log;
  console.log = (m) => logged.push(String(m));
  try {
    const stale = await findStaleGateFiles({
      ...ESLINT_OPTS,
      fetchJson: divergedJson(),
      fetchText: textFetch(
        configWith(['node_modules/*', 'dist/**']),
        'export default tseslint.config({});',
      ),
    });
    assert.equal(stale.length, 1);
  } finally {
    console.log = original;
  }
  assert.ok(
    logged.some((m) => m.includes('could not narrow eslint.config.js')),
    'extraction failure must annotate, not silently keep the verdict',
  );
});

test('the real prettier scope files keep the narrowing usable', () => {
  // Anchor-drift guard, matching the eslint one: a `!` or backslash line in
  // either real file permanently disables the prettier narrowing, and every
  // other prettier case injects fixtures so nothing else would notice.
  // Only .prettierignore is parsed for semantics; .gitignore is compared by
  // equality, so its real `!` lines are expected and must NOT be flagged here.
  for (const file of ['.prettierignore']) {
    const entries = ignoreLines(readFileSync(join(repoRoot, file), 'utf8'));
    assert.ok(entries.length > 0, `${file} yielded no patterns`);
    const reincluding = entries.filter(
      (entry) => entry.startsWith('!') || entry.includes('\\'),
    );
    assert.deepEqual(
      reincluding,
      [],
      `${file} gained a negated or escaped pattern; the narrowing is permanently disabled for it — teach the parser or drop the entry`,
    );
  }
});

test('the fail-closed catch leaves a diagnostic', () => {
  // Without it the refinement can stop firing for every PR and leave no trace
  // beyond a stale verdict nobody can explain. Source-read pin: the catch is
  // exercised by the fetch-failure case, but that case asserts the verdict, not
  // the log, so deleting the warning would otherwise stay green.
  const source = readFileSync(
    join(repoRoot, '.github/scripts/check-lint-gate-freshness.mjs'),
    'utf8',
  );
  const at = source.indexOf(
    '} catch (error) {',
    source.indexOf('const narrow ='),
  );
  assert.ok(at > 0, 'fail-closed catch not found');
  assert.match(
    source.slice(at, source.indexOf('return verdict;', at)),
    /::warning::lint gate freshness: could not narrow/,
    'the fail-closed path must annotate why it kept the verdict',
  );
});

// Both wiring pins below read the same call, so its shape is checked here once.
// Without these checks a hoisted options literal misdiagnoses intact wiring,
// and a decoy call earlier in main() lets the real one encode its ref unseen
// (measured: that pair passed 82/82 before the checks existed).
function mainWiring() {
  const source = readFileSync(
    join(repoRoot, '.github/scripts/check-lint-gate-freshness.mjs'),
    'utf8',
  );
  const at = source.indexOf('async function main()');
  assert.ok(at > 0, 'main() not found');
  const main = source.slice(at);
  const anchor = 'await findStaleGateFiles({';
  assert.equal(
    main.split(anchor).length - 1,
    1,
    'main() must make exactly one verdict call for the pins to anchor to it',
  );
  // Bounded by the option-line shape, not by a `});` search: that substring
  // also occurs inside main()'s own warning template (`(${error.message}); …`),
  // so a missing closer widens the slice into the catch block instead of
  // failing. Measured: 146 chars intact, 745 with the closer changed.
  const call =
    /await findStaleGateFiles\(\{\n(?:[ \t]+[\w$]+(?::[^,\n]*)?,\n)+[ \t]*\}\);/.exec(
      main,
    );
  assert.ok(
    call,
    'the verdict call must be an options literal closed by `});`',
  );
  return { main, call: call[0] };
}

test('main() passes BASE_REF through verbatim', () => {
  // Every other case injects baseRef directly, so nothing watches this wiring.
  // For a ref carrying a hazardous character, encoding it here double-encodes
  // at the request sites: the lookup 404s, the throw reaches main()'s fail-open,
  // and the whole check reports fresh.
  // Measured: wrapping it in encodeURIComponent leaves every other case green.
  assert.match(
    mainWiring().call,
    /^\s*baseRef: BASE_REF,$/m,
    'main() must hand BASE_REF to the verdict call unencoded',
  );
});

test('the JSON media type is pinned alongside the raw one', () => {
  // The two Accept values sit side by side and read as interchangeable; only
  // the raw one had a pin. Swapping the JSON half would break every containment
  // call, and no injected-fixture case would notice.
  const source = readFileSync(
    join(repoRoot, '.github/scripts/check-lint-gate-freshness.mjs'),
    'utf8',
  );
  assert.match(
    source,
    /curlRaw\(path, token, 'application\/vnd\.github\+json'\)/,
    'curlJson must keep the JSON media type',
  );
});

test('main() wires fetchText into the verdict call', () => {
  // Source-read pin, same style as the ci.yml wiring case above: deleting the
  // wiring leaves fetchText undefined, the narrowing throws into the
  // fail-closed catch, and every injected-fixture test still passes.
  const { main, call } = mainWiring();
  assert.match(
    main,
    /const fetchText = \(path\) => curlText\(path, GITHUB_TOKEN\);/,
    'main() must build fetchText from curlText',
  );
  assert.match(
    call,
    /^\s*fetchText,$/m,
    'fetchText must reach the verdict call',
  );
});

test('a contained eslint verdict pays no content fetch', async () => {
  // The narrowing is a post-filter on stale verdicts only. Running it on every
  // verdict would leave the result identical while adding two API calls to
  // every fresh PR, so only a call count pins this.
  const calls = [];
  const stale = await findStaleGateFiles({
    ...ESLINT_OPTS,
    fetchJson: fakeFetch([
      ['/repos/QwenLM/qwen-code/commits?', commitsResponse(GATE_SHA)],
      [`/repos/QwenLM/qwen-code/compare/${GATE_SHA}...`, { status: 'ahead' }],
    ]),
    fetchText: textFetch(configWith([]), configWith([]), calls),
  });
  assert.deepEqual(stale, []);
  assert.deepEqual(calls, []);
});

test('other gate files never reach the content fetch', async () => {
  const calls = [];
  const stale = await findStaleGateFiles({
    ...BASE_OPTS,
    fetchJson: divergedJson(),
    fetchText: textFetch('', '', calls),
  });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].file, 'scripts/lint.js');
  assert.deepEqual(calls, []);
});

test('a trailing comment is not read as ignore entries', () => {
  // Mutation witness: matching quoted literals anywhere in the line instead
  // of anchoring at line start picks up 'generated' from the prose.
  const split = splitGlobalIgnores(
    configWith([]).replace(
      '    ignores: [',
      "    ignores: [\n      'dist/**', // don't lint 'generated' output",
    ),
  );
  assert.deepEqual(split.entries, ['dist/**']);
});

test('the extractor finds the global block in the real eslint.config.js', () => {
  // Anchor-drift guard: a reformat that defeats the line anchors must redden
  // here rather than silently disable the narrowing in CI.
  const split = splitGlobalIgnores(
    readFileSync(join(repoRoot, 'eslint.config.js'), 'utf8'),
  );
  assert.ok(split, 'global ignores block not found');
  assert.ok(split.entries.includes('node_modules/*'));
  assert.ok(split.entries.includes('packages/**/dist/**'));
  // Only the first block is consumed: the config-scoped arrays stay in rest.
  assert.ok(!split.entries.includes('packages/core/src/config/config.ts'));
  assert.ok(split.rest.includes('ignores: ['));
  // A negated or escaped entry permanently disables the eslint narrowing too,
  // and every other eslint case injects fixtures. Same drift guard as the
  // prettier one, which was missing here.
  assert.deepEqual(
    split.entries.filter((e) => e.startsWith('!') || e.includes('\\')),
    [],
    'the real global ignores gained a negated or escaped entry; the narrowing is permanently disabled for it — teach the parser or drop the entry',
  );
});

test('relocating the ignores block never compares equal', async () => {
  // The extractor takes the first block without proving it is global. Every
  // relocation leaves a trace in the byte-compared remainder, which is what
  // rejects it. Pin the shapes so a future loosening reddens here instead of
  // silently certifying a narrower branch.
  const wrap = (body) => `export default tseslint.config(\n${body});\n`;
  const obj = (props) => `  {\n${props}  },\n`;
  const ign = (entries) =>
    `    ignores: [\n${entries.map((e) => `      '${e}',\n`).join('')}    ],\n`;
  const head = wrap(obj(ign(['a'])));
  for (const base of [
    wrap(obj(`    files: ['x'],\n` + ign(['b'])) + obj(ign(['a']))),
    wrap(obj(`    files: ['x'],\n` + ign(['a'])) + obj(ign(['a']))),
    wrap(obj(ign(['a']) + `    files: ['x'],\n`)),
    wrap(obj(ign(['a'])) + obj(ign(['a']))),
  ]) {
    const stale = await findStaleGateFiles({
      ...ESLINT_OPTS,
      fetchJson: divergedJson(),
      fetchText: textFetch(base, head),
    });
    assert.equal(stale.length, 1);
  }
});

// --- ci.yml: the lint gate slice -------------------------------------------

const CI_FILE = '.github/workflows/ci.yml';
const CI_OPTS = { ...BASE_OPTS, gateFiles: [CI_FILE] };
const MERGE_BASE_SHA = 'b'.repeat(40);
const realCi = readFileSync(join(repoRoot, CI_FILE), 'utf8');

// Serves the stale ci.yml verdict — whose compare already carries the merge
// base — and the two content reads. Refs are pinned: the base side must be read
// at the base TIP and the branch side at the MERGE BASE, so a fetch at the head
// is a bug, not a match. A second compare is refused: the narrowing must reuse
// the containment compare, because a fresh `base...head` one is ~4 MB here and
// timed out against the live API.
function ciFetch(
  baseText,
  branchText,
  calls = [],
  mergeBase = MERGE_BASE_SHA,
  baseRef = 'main',
) {
  return {
    fetchJson: async (path) => {
      calls.push(path);
      if (path.startsWith('/repos/QwenLM/qwen-code/commits?'))
        return commitsResponse(GATE_SHA);
      if (path.startsWith(`/repos/QwenLM/qwen-code/compare/${GATE_SHA}...`))
        return {
          status: 'diverged',
          merge_base_commit: mergeBase ? { sha: mergeBase } : undefined,
        };
      throw new Error(`unexpected json path: ${path}`);
    },
    fetchText: async (path) => {
      calls.push(path);
      const prefix = `/repos/QwenLM/qwen-code/contents/${CI_FILE}?ref=`;
      if (path === `${prefix}${encodeURIComponent(baseRef)}`) return baseText;
      if (path === `${prefix}${mergeBase}`) return branchText;
      throw new Error(`unexpected text path: ${path}`);
    },
  };
}

// Replace one step's body inside the LINT JOB of the real workflow, so every
// fixture keeps the surrounding structure the extractor has to parse. Scoped to
// that job because several plumbing names repeat across jobs — the first match
// in the file is usually a test lane, which the slice drops.
function withStepText(name, from, to) {
  // The job's own span, not a named neighbour: `web_shell_e2e_smoke` is an
  // unrelated lane whose rename is exactly the ci.yml churn this narrowing
  // exists to make irrelevant. With the literal, that rename left jobEnd at
  // -1 — eight fixtures reddened with "step not found" for steps that are
  // present, and two kept slicing a wrong span without failing.
  const { start: jobAt, end: jobEnd } = jobSpan(realCi, 'lint_and_static');
  const offset = realCi.indexOf(`      - name: '${name}'`, jobAt);
  assert.ok(
    offset > jobAt && offset < jobEnd,
    `step ${name} not found in lint_and_static`,
  );
  const next = realCi.indexOf("\n      - name: '", offset + 1);
  const end = next === -1 || next > jobEnd ? jobEnd : next;
  const block = realCi.slice(offset, end);
  assert.ok(block.includes(from), `${name} does not contain ${from}`);
  return realCi.slice(0, offset) + block.replace(from, to) + realCi.slice(end);
}

// --- ci.yml: the parsed lint gate ------------------------------------------

// The span of one top-level job: its key line through the line before the next
// job key. Used to scope fixtures to the lint job, since many step names repeat
// across test lanes.
function jobSpan(text, name) {
  const at = text.indexOf(`\n  ${name}:`);
  assert.ok(at > 0, `job ${name} not found`);
  const rest = text.slice(at + 1);
  const next = /^ {2}[A-Za-z0-9_-]+:\s*$/m.exec(
    rest.slice(rest.indexOf('\n') + 1),
  );
  return {
    start: at,
    end: next ? at + 1 + rest.indexOf('\n') + 1 + next.index : text.length,
  };
}

function lintJobEdit(edit) {
  const { start, end } = jobSpan(realCi, 'lint_and_static');
  return (
    realCi.slice(0, start) + edit(realCi.slice(start, end)) + realCi.slice(end)
  );
}

/**
 * Assert that neither the job nor any named step carries `continue-on-error`,
 * reading the parsed document rather than matching lines.
 *
 * A line-shaped pattern only recognises `continue-on-error:` spelled one way.
 * `continue-on-error : true`, a quoted key and flow style are equally legal and
 * equally silencing, and against those the pattern finds nothing — so the
 * assertion passes while the gate it guards stops failing the job. The truthy
 * comparison is deliberate: `continue-on-error: false` is the default and must
 * stay allowed, while `${{ ... }}` is a non-empty string and is refused because
 * this gate has no business being conditional.
 */
function assertNoContinueOnError(text, jobName, ...stepNames) {
  const document = parseDocument(text, { uniqueKeys: true });
  assert.equal(document.errors.length, 0, 'ci.yml must parse');
  const job = document.toJS().jobs?.[jobName];
  assert.ok(job, `job ${jobName} not found`);
  assert.ok(
    !job['continue-on-error'],
    `a job-level continue-on-error would swallow every step's failure in ${jobName}`,
  );
  for (const name of stepNames) {
    const steps = (job.steps ?? []).filter((step) => step?.name === name);
    assert.equal(steps.length, 1, `step ${name} must appear exactly once`);
    assert.ok(
      !steps[0]['continue-on-error'],
      `${name} must stay fatal: continue-on-error stops it failing the job`,
    );
  }
}

// Every step name in the two gate jobs, plumbing included — the pruned
// document cannot answer this, because plumbing is what it removes.
function gateJobStepNames(text) {
  const document = parseDocument(text, { uniqueKeys: true });
  assert.equal(document.errors.length, 0, 'the fixture must parse');
  const jobs = document.toJS().jobs;
  return CI_GATE_JOBS.flatMap((job) =>
    (jobs[job].steps ?? []).map((step) => step.name),
  );
}

test('extracts the lint gate from the real workflow', () => {
  // Anchor-drift guard: a reformat that defeats the pruning must redden here
  // rather than silently disable the narrowing for every PR in CI.
  const gate = lintGateDocument(realCi);
  assert.ok(gate, 'the real ci.yml must parse as a lint gate');
  assert.deepEqual(Object.keys(gate.jobs).sort(), [...CI_GATE_JOBS].sort());
  const slice = extractLintGateSlice(realCi);
  for (const linter of [
    'node scripts/lint.js --eslint',
    'node scripts/lint.js --prettier',
    'node scripts/lint.js --actionlint',
    'node scripts/lint.js --shellcheck',
    'node scripts/lint.js --yamllint',
    'node scripts/lint.js --sensitive-keywords',
  ]) {
    assert.ok(slice.includes(linter), `slice dropped ${linter}`);
  }
  // The classifier and the helper-test lists are gate-defining too, and they
  // live above `jobs:` or inside the other gate job.
  assert.ok(slice.includes('HELPER_TESTS_DEP_FREE'));
  assert.ok(slice.includes('ACTIONLINT_VERSION'));
  assert.ok(slice.includes('classify_pr'));
  // Strictly smaller than the file: most of ci.yml is not this gate.
  assert.ok(
    slice.length < realCi.length / 2,
    'the compared gate is not meaningfully narrower than the whole file',
  );
});

test('every plumbing name exists in the gate jobs', () => {
  // A plumbing name that no longer exists in the gate jobs excludes nothing
  // and rots silently, so require each entry to be real.
  const names = gateJobStepNames(realCi);
  for (const name of CI_PLUMBING_STEPS) {
    assert.ok(
      names.includes(name),
      `plumbing step '${name}' is not in the gate jobs any more — drop the entry`,
    );
  }
});

test('a plumbing step that invokes a linter refuses the narrowing', () => {
  // The label is not trusted on its own: a step moved into the plumbing list
  // while still running a linter is a contradiction, not a pass. The forms are
  // the ones the lanes are actually reached through, flags included.
  for (const invocation of [
    'node scripts/lint.js --prettier',
    'pnpm run lint',
    'pnpm -w run lint',
    'corepack pnpm -w run lint',
    'pnpm lint',
    'npx eslint .',
  ]) {
    const patched = withStepText(
      'Disk floor gate (self-hosted)',
      "run: 'bash .github/scripts/check-disk-floor.sh",
      `run: '${invocation} && bash .github/scripts/check-disk-floor.sh`,
    );
    assert.equal(
      extractLintGateSlice(patched),
      null,
      `${invocation} must refuse the narrowing`,
    );
  }
  // Configuration is not an invocation: the real workflow's npm config step
  // must keep parsing, or the narrowing would be dead on arrival.
  assert.ok(extractLintGateSlice(realCi));
});

test('the depth guarantee that makes excluding Checkout safe stays compared', () => {
  // `Checkout` is only safe to exclude because `Fetch incremental lint history`
  // fetches the base deep enough for lint-scope's merge-base. Losing it does
  // not narrow lint coverage — lint-scope falls back to `full: true` — so the
  // pin guards who owns that fallback, and that the body, not just the header,
  // is compared.
  assert.ok(!CI_PLUMBING_STEPS.has('Fetch incremental lint history'));
  const slice = extractLintGateSlice(realCi);
  assert.ok(slice.includes('--depth=100'), 'the depth body must be compared');
  const edited = withStepText(
    'Fetch incremental lint history',
    'git "${partial[@]}" fetch --no-tags --depth=100 --filter=blob:none',
    'git "${partial[@]}" fetch --no-tags --depth=50 --filter=blob:none',
  );
  const editedSlice = extractLintGateSlice(edited);
  assert.ok(editedSlice, 'the edited workflow must still parse');
  assert.ok(editedSlice.includes('--depth=50'));
  assert.notEqual(editedSlice, slice);
});

test('the install prelude stays in the compared gate', () => {
  // An install a profile skips is a linter that profile never runs, and
  // #16900/#16920 widened exactly this prelude. Its name must not be plumbing.
  assert.ok(!CI_PLUMBING_STEPS.has('Install dependencies'));
  assert.ok(extractLintGateSlice(realCi).includes('disk-pressure-samples.log'));
});

test('trust-boundary steps stay in the compared gate', () => {
  // These sanitise the workspace before checkout while untrusted fork code runs
  // in the job, so a base-side hardening has to reach in-flight branches.
  for (const name of [
    'Restore workspace ownership',
    'Clean stale .qwen before checkout',
  ]) {
    assert.ok(!CI_PLUMBING_STEPS.has(name), `${name} must not be plumbing`);
    assert.ok(extractLintGateSlice(realCi).includes(name));
  }
});

test('a base-side plumbing-only edit does not stale the branch', async () => {
  // The shape this narrowing exists for: runner routing is plumbing, so a
  // base-side rerouting must not ask every in-flight PR to rebase.
  const { start, end } = jobSpan(realCi, 'lint_and_static');
  const job = realCi.slice(start, end);
  const patched = job.replace(
    /^ {4}runs-on: .*$/m,
    "    runs-on: 'ubuntu-22.04'",
  );
  assert.notEqual(patched, job, 'runs-on anchor not found in lint_and_static');
  const stale = await findStaleGateFiles({
    ...CI_OPTS,
    ...ciFetch(realCi.slice(0, start) + patched + realCi.slice(end), realCi),
  });
  assert.deepEqual(stale, []);
});

test('a base-side edit inside a non-gate job does not stale the branch', async () => {
  const { start, end } = jobSpan(realCi, 'test_build');
  const job = realCi.slice(start, end);
  const patched = job.replace(
    'echo "key=$(node scripts/ci-build-cache.mjs key)"',
    'echo "key=$(node scripts/ci-build-cache.mjs --key)"',
  );
  assert.notEqual(patched, job, 'build-key anchor not found in test_build');
  const stale = await findStaleGateFiles({
    ...CI_OPTS,
    ...ciFetch(realCi.slice(0, start) + patched + realCi.slice(end), realCi),
  });
  assert.deepEqual(stale, []);
});

test('a base-side lint lane edit still stales the branch', async () => {
  // The #11117 → #11216 incident this check exists for.
  const base = withStepText(
    'Run Prettier',
    'node scripts/lint.js --prettier',
    'node scripts/lint.js --prettier --write',
  );
  assert.notEqual(base, realCi, 'the fixture must change the Prettier lane');
  assert.notEqual(extractLintGateSlice(base), extractLintGateSlice(realCi));
  const stale = await findStaleGateFiles({
    ...CI_OPTS,
    ...ciFetch(base, realCi),
  });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].file, CI_FILE);
});

test('a base-side trust-boundary hardening stales the branch', async () => {
  for (const [name, from, to] of [
    ['Restore workspace ownership', 'sudo -n chown', 'sudo -n -E chown'],
    [
      'Clean stale .qwen before checkout',
      'for stale_qwen in ',
      'for stale_qwen in "$GITHUB_WORKSPACE/.qwen.root-orig2" ',
    ],
  ]) {
    const base = withStepText(name, from, to);
    assert.notEqual(base, realCi, `${name} fixture did not apply`);
    const stale = await findStaleGateFiles({
      ...CI_OPTS,
      ...ciFetch(base, realCi),
    });
    assert.equal(stale.length, 1, `${name} hardening must stale the branch`);
  }
});

test('a base-side helper-test list change still stales the branch', async () => {
  const base = realCi.replace(
    '  HELPER_TESTS: ',
    "  HELPER_TESTS: '.github/scripts/check-ci-budget.test.mjs' #\n  HELPER_TESTS_UNUSED: ",
  );
  assert.notEqual(base, realCi, 'HELPER_TESTS anchor not found');
  const stale = await findStaleGateFiles({
    ...CI_OPTS,
    ...ciFetch(base, realCi),
  });
  assert.equal(stale.length, 1);
});

test('a base-side profile classifier change still stales the branch', async () => {
  const base = realCi.replace(
    '            docs_only|github_ci_only|full) ;;',
    '            docs_only|github_ci_only|java_only|full) ;;',
  );
  assert.notEqual(base, realCi, 'classifier anchor not found');
  const stale = await findStaleGateFiles({
    ...CI_OPTS,
    ...ciFetch(base, realCi),
  });
  assert.equal(stale.length, 1);
});

test('the gate is compared at the merge base, not at the head', async () => {
  // A branch that edits the gate itself must not be flagged for its own edit:
  // `main` will not carry that edit until the branch merges, so a head-side
  // comparison would demand a rebase that can never satisfy it. The fake
  // refuses any read at the head SHA, so fetching the head fails.
  const branch = withStepText(
    'Run Prettier',
    'node scripts/lint.js --prettier',
    'node scripts/lint.js --prettier --write',
  );
  assert.notEqual(
    extractLintGateSlice(branch),
    extractLintGateSlice(realCi),
    'the fixture must actually change the gate',
  );
  const stale = await findStaleGateFiles({
    ...CI_OPTS,
    ...ciFetch(realCi, realCi),
  });
  assert.deepEqual(stale, []);
});

test('the ci.yml branch side is read at the merge base it was given', async () => {
  // A second, distinct merge base: with only one value the fixture could pin
  // the branch side to a constant and still pass. ciFetch honours `mergeBase`
  // in fetchJson, so its fetchText must honour the same value.
  const other = 'c'.repeat(40);
  const calls = [];
  const stale = await findStaleGateFiles({
    ...CI_OPTS,
    ...ciFetch(realCi, realCi, calls, other),
  });
  assert.deepEqual(stale, []);
  assert.ok(
    calls.some((c) => c.includes(`?ref=${other}`)),
    `expected the branch side at ${other}, got ${JSON.stringify(calls)}`,
  );
  assert.ok(
    !calls.some((c) => c.includes(`?ref=${MERGE_BASE_SHA}`)),
    'the branch side must not fall back to the default merge base',
  );
});

test('the ci.yml narrowing encodes a hash-bearing base ref too', async () => {
  // narrowsToUnchangedLintSlice reads the base side at baseRef, so its `?ref=`
  // takes a branch name just like the prettier path does. Before this case
  // nothing drove that path with a ref needing encoding, so deleting its
  // encoder left every case green. The all-hazards ci.yml case above now covers
  // the whole character family here; this one keeps the '#' shape explicit.
  const calls = [];
  const stale = await findStaleGateFiles({
    ...CI_OPTS,
    baseRef: 'fix#1',
    ...ciFetch(realCi, realCi, calls, MERGE_BASE_SHA, 'fix#1'),
  });
  assert.deepEqual(stale, []);
  assert.ok(
    calls.some((c) => c.includes('?ref=fix%231')),
    `expected an encoded contents ref, got ${JSON.stringify(calls)}`,
  );
  assert.deepEqual(
    calls.filter((c) => c.includes('fix#1')),
    [],
    'every URL embedding the base ref must encode it',
  );
});

test('a comment-only base-side edit does not stale the branch', () => {
  // Most of ci.yml's churn is prose, and a parsed comparison cannot see it at
  // all — unlike the line model, which had to drop comment lines by hand.
  const commented = realCi.replace(
    "      - name: 'Run Prettier'",
    "      # A new explanatory paragraph about the Prettier lane.\n      - name: 'Run Prettier'",
  );
  assert.notEqual(commented, realCi, 'the comment fixture did not apply');
  assert.equal(extractLintGateSlice(commented), extractLintGateSlice(realCi));
});

test('a step without a name refuses the narrowing', () => {
  // An unnamed step cannot be matched against the whitelist, so the comparison
  // cannot say what it does.
  const patched = lintJobEdit((job) =>
    job.replace(
      "      - name: 'Run Prettier'",
      "      - uses: './.github/actions/unknown'\n      - name: 'Run Prettier'",
    ),
  );
  assert.notEqual(patched, realCi, 'fixture did not apply');
  assert.equal(extractLintGateSlice(patched), null);
});

test('a duplicated step name refuses the narrowing', () => {
  const patched = lintJobEdit((job) =>
    job.replace(
      "      - name: 'Run Prettier'",
      "      - name: 'Checkout'\n        run: 'true'\n      - name: 'Run Prettier'",
    ),
  );
  assert.notEqual(patched, realCi, 'fixture did not apply');
  assert.equal(extractLintGateSlice(patched), null);
});

test('a duplicated job key refuses the narrowing', () => {
  // `uniqueKeys` turns YAML's last-one-wins into a parse error, which is the
  // fail-closed reading: the comparison cannot say which copy the runner uses.
  const { start, end } = jobSpan(realCi, 'lint_and_static');
  const duplicated =
    realCi.slice(0, end) + realCi.slice(start, end) + realCi.slice(end);
  assert.notEqual(duplicated, realCi, 'the fixture did not apply');
  assert.equal(extractLintGateSlice(duplicated), null);
});

test('every legal spelling of continue-on-error is refused', () => {
  // The three fatality pins used to match `^ {8}continue-on-error:` against a
  // text slice. Each spelling below is legal YAML that the runner honours and
  // that pattern does not see, so all three assertions passed while the gate
  // stopped failing the job — the post-merge stale-lint class (#16872, #16918)
  // silently re-opened. Measured on the merged head: the canonical spelling was
  // the only one the old patterns caught. The parsed reading refuses them all.
  const gateStep = "      - name: 'Check lint gate freshness'\n";
  const suiteStep = "      - name: 'Run lint gate freshness tests'\n";
  const variants = [
    ['step, canonical', gateStep, '        continue-on-error: true\n'],
    [
      'step, space before colon',
      gateStep,
      '        continue-on-error : true\n',
    ],
    [
      'step, double-quoted key',
      gateStep,
      '        "continue-on-error": true\n',
    ],
    [
      'step, single-quoted key',
      gateStep,
      "        'continue-on-error': true\n",
    ],
    [
      'suite, space before colon',
      suiteStep,
      '        continue-on-error : true\n',
    ],
    ['suite, quoted key', suiteStep, '        "continue-on-error": true\n'],
  ];
  for (const [label, anchor, line] of variants) {
    const patched = lintJobEdit((job) => job.replace(anchor, anchor + line));
    assert.notEqual(patched, realCi, `${label}: fixture did not apply`);
    assert.throws(
      () =>
        assertNoContinueOnError(
          patched,
          'lint_and_static',
          'Check lint gate freshness',
          'Run lint gate freshness tests',
        ),
      /must stay fatal/,
      label,
    );
  }
  // Flow style: the whole step becomes one mapping on one line, so there is no
  // `        continue-on-error:` line to find at any indentation.
  // The whole step has to become the flow mapping: folding just the header
  // leaves the block keys below it and the document stops parsing, which would
  // trip the parse guard instead of the fatality pin this case is about. Scoped
  // through the job's own span so a moved step reddens rather than yielding a
  // no-op fixture.
  const flow = lintJobEdit((job) => {
    const at = job.indexOf("      - name: 'Check lint gate freshness'");
    assert.ok(at > 0, 'the gate step must be present');
    const next = job.indexOf("\n      - name: '", at + 1);
    assert.ok(next > at, 'the gate step must be followed by another step');
    return (
      job.slice(0, at) +
      "      - { name: 'Check lint gate freshness', continue-on-error: true, run: 'true' }" +
      job.slice(next)
    );
  });
  assert.notEqual(flow, realCi, 'flow-style fixture did not apply');
  // The fixture must be legal YAML with the key actually set, or the case would
  // pass by tripping the parse guard while proving nothing about flow style.
  const flowDocument = parseDocument(flow, { uniqueKeys: true });
  assert.equal(flowDocument.errors.length, 0, 'the flow fixture must parse');
  assert.equal(
    flowDocument
      .toJS()
      .jobs.lint_and_static.steps.find(
        (step) => step.name === 'Check lint gate freshness',
      )['continue-on-error'],
    true,
    'the flow fixture must really carry the key',
  );
  assert.throws(
    () =>
      assertNoContinueOnError(
        flow,
        'lint_and_static',
        'Check lint gate freshness',
      ),
    /must stay fatal/,
    'flow style',
  );
  // Job level: outside every step slice, so slicing alone cannot see it at all.
  for (const line of [
    '    continue-on-error: true\n',
    '    continue-on-error : true\n',
    '    "continue-on-error": true\n',
    // An expression is a non-empty string, so it must be refused as set. A pin
    // that only rejects the literal `true` accepts this one — and a job-level
    // expression is exactly the conditional gate the check forbids.
    "    continue-on-error: ${{ github.actor == 'bot' }}\n",
  ]) {
    const patched = realCi.replace(
      '\n  lint_and_static:\n',
      `\n  lint_and_static:\n${line}`,
    );
    assert.notEqual(patched, realCi, 'job-level fixture did not apply');
    assert.throws(
      () => assertNoContinueOnError(patched, 'lint_and_static'),
      /job-level continue-on-error/,
      line.trim(),
    );
  }
  // An expression is refused too: this gate is not allowed to be conditional,
  // and a truthy string would otherwise read as "set" only by accident.
  const conditional = lintJobEdit((job) =>
    job.replace(
      gateStep,
      gateStep + "        continue-on-error: ${{ github.actor == 'bot' }}\n",
    ),
  );
  assert.notEqual(conditional, realCi, 'the expression fixture did not apply');
  assert.throws(
    () =>
      assertNoContinueOnError(
        conditional,
        'lint_and_static',
        'Check lint gate freshness',
      ),
    /must stay fatal/,
  );
});

test('an explicitly fatal gate still passes', () => {
  // The negative control for the pin above: `false` is the default and must not
  // be refused, or the assertion would be demanding the key's absence rather
  // than the behaviour it names. The untouched workflow is the other half.
  assertNoContinueOnError(
    realCi,
    'lint_and_static',
    'Check lint gate freshness',
    'Run lint gate freshness tests',
  );
  for (const anchor of [
    "      - name: 'Check lint gate freshness'\n",
    "      - name: 'Run lint gate freshness tests'\n",
  ]) {
    const patched = lintJobEdit((job) =>
      job.replace(anchor, anchor + '        continue-on-error: false\n'),
    );
    assert.notEqual(patched, realCi, 'fixture did not apply');
    assertNoContinueOnError(
      patched,
      'lint_and_static',
      'Check lint gate freshness',
      'Run lint gate freshness tests',
    );
  }
  // The key's presence at job level is not itself the offence: `false` is the
  // default there too, so a pin that refused the key rather than its truth
  // would demand its absence instead of the behaviour it names.
  const jobLevel = realCi.replace(
    '\n  lint_and_static:\n',
    '\n  lint_and_static:\n    continue-on-error: false\n',
  );
  assert.notEqual(jobLevel, realCi, 'job-level fixture did not apply');
  assertNoContinueOnError(
    jobLevel,
    'lint_and_static',
    'Check lint gate freshness',
    'Run lint gate freshness tests',
  );
});

test('a renamed or duplicated gate step is refused, not skipped', () => {
  // Without the exactly-once reading, renaming the step would leave the filter
  // matching nothing and the fatality loop would assert nothing at all — the
  // same vacuous-pass shape this fix exists to remove, one level up.
  const renamed = lintJobEdit((job) =>
    job.replace(
      "      - name: 'Check lint gate freshness'",
      "      - name: 'Check lint gate freshness (advisory)'",
    ),
  );
  assert.notEqual(renamed, realCi, 'fixture did not apply');
  assert.throws(
    () =>
      assertNoContinueOnError(
        renamed,
        'lint_and_static',
        'Check lint gate freshness',
      ),
    /must appear exactly once/,
  );
  const doubled = lintJobEdit((job) =>
    job.replace(
      "      - name: 'Check lint gate freshness'\n",
      "      - name: 'Check lint gate freshness'\n        run: 'true'\n      - name: 'Check lint gate freshness'\n",
    ),
  );
  assert.notEqual(doubled, realCi, 'fixture did not apply');
  assert.throws(
    () =>
      assertNoContinueOnError(
        doubled,
        'lint_and_static',
        'Check lint gate freshness',
      ),
    /must appear exactly once/,
  );
});

test('an unparseable workflow is refused rather than read last-one-wins', () => {
  // `uniqueKeys` reports a duplicated key as an error, but toJS() still returns
  // the last copy. With `continue-on-error: true` followed by `false` the
  // parsed value is `false`, so without the parse-error assertion this reads as
  // a fatal gate while the document is one the runner may reject or resolve
  // differently. Fail closed on the error, not on the surviving value.
  const patched = lintJobEdit((job) =>
    job.replace(
      "      - name: 'Check lint gate freshness'\n",
      "      - name: 'Check lint gate freshness'\n        continue-on-error: true\n        continue-on-error: false\n",
    ),
  );
  assert.notEqual(patched, realCi, 'fixture did not apply');
  const document = parseDocument(patched, { uniqueKeys: true });
  assert.ok(document.errors.length > 0, 'the fixture must be a parse error');
  assert.equal(
    document
      .toJS()
      .jobs.lint_and_static.steps.find(
        (step) => step.name === 'Check lint gate freshness',
      )['continue-on-error'],
    false,
    'last-one-wins would hide the first copy',
  );
  assert.throws(
    () =>
      assertNoContinueOnError(
        patched,
        'lint_and_static',
        'Check lint gate freshness',
      ),
    /must parse/,
  );
});

test('a missing gate job refuses the narrowing', () => {
  assert.equal(
    extractLintGateSlice(realCi.replace('\n  lint_and_static:', '\n  lint:')),
    null,
  );
  assert.equal(
    extractLintGateSlice(realCi.replace('\n  classify_pr:', '\n  classify:')),
    null,
  );
  assert.equal(extractLintGateSlice('name: x\n'), null);
});

test('a needs edge outside the gate jobs refuses the narrowing', () => {
  // A lane's inputs are whatever it depends on. A job the comparison drops
  // could install or sanitise the tree the linters read, so a dependency that
  // points at one refuses rather than being silently outside the gate.
  for (const value of [
    "[build, 'classify_pr']",
    'build',
    "[build, 'test_build']",
  ]) {
    const patched = lintJobEdit((job) =>
      job.replace(/^ {4}needs: .*$/m, `    needs: ${value}`),
    );
    assert.notEqual(patched, realCi, `fixture did not apply: ${value}`);
    assert.equal(
      extractLintGateSlice(patched),
      null,
      `needs outside the gate must refuse: ${value}`,
    );
  }
  // ...while the real workflow's own dependency still parses.
  const gate = lintGateDocument(realCi);
  assert.equal(gate.jobs.lint_and_static.needs, 'classify_pr');
});

test('unparsable YAML refuses the narrowing', () => {
  assert.equal(extractLintGateSlice('jobs:\n  - [unclosed\n'), null);
  assert.equal(extractLintGateSlice(''), null);
});

test('an extraction miss emits the warning, not a silent false', async () => {
  // Fail closed: an unparsable base-side file keeps the whole-file verdict and
  // says why, rather than disabling the narrowing without a trace.
  const logged = [];
  const original = console.log;
  console.log = (m) => logged.push(String(m));
  let stale;
  try {
    const base = realCi.replace(
      "      - name: 'Run Prettier'",
      "      - uses: './.github/actions/unknown'\n      - name: 'Run Prettier'",
    );
    stale = await findStaleGateFiles({ ...CI_OPTS, ...ciFetch(base, realCi) });
  } finally {
    console.log = original;
  }
  assert.equal(stale.length, 1);
  assert.ok(
    logged.some(
      (m) =>
        m.includes(`could not narrow ${CI_FILE}`) &&
        m.includes('lint gate slice'),
    ),
    'an extraction miss must annotate why the verdict was kept',
  );
});

test('a compare without a merge base keeps the verdict, and says so', async () => {
  const logged = [];
  const original = console.log;
  console.log = (m) => logged.push(String(m));
  let stale;
  try {
    stale = await findStaleGateFiles({
      ...CI_OPTS,
      ...ciFetch(realCi, realCi, [], null),
    });
  } finally {
    console.log = original;
  }
  assert.equal(stale.length, 1);
  assert.ok(
    logged.some((m) => m.includes('no merge base commit')),
    'a missing merge base must annotate why the verdict was kept',
  );
});
