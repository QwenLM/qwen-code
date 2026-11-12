import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CI_PLUMBING_STEPS,
  GATE_FILES,
  TEXT_ACCEPT,
  extractLintGateSlice,
  findStaleGateFiles,
  ignoreLines,
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
  const jobStart = ci.indexOf('\n  lint_and_static:');
  const jobEnd = ci.indexOf('\n  test_macos:', jobStart);
  assert.ok(jobStart > 0 && jobEnd > jobStart, 'lint_and_static job not found');
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
  // check (#16918).
  assert.equal(
    stepBlock.match(/^ {8}continue-on-error:/m),
    null,
    'freshness gate must stay fatal',
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
  // Fail fast: the check costs seconds and must run before the expensive
  // install/lint steps it can make pointless.
  assert.ok(
    step < job.indexOf("- name: 'Run ESLint'"),
    'freshness step must precede Run ESLint',
  );
  assert.ok(
    step < job.indexOf("- name: 'Install dependencies'"),
    'freshness step must precede Install dependencies',
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
    baseRef = BASE_REF,
  },
  calls = [],
) {
  const treeFor = (scope, pi) => ({
    truncated,
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
    [baseRef]: treeFor(baseScope, basePi),
    [HEAD_SHA]: treeFor(headScope, headPi),
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

test('a truncated tree never narrows, and says so', async () => {
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
        truncated: true,
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

test('a base ref containing a slash is URI-encoded in the tree path', async () => {
  // Without encodeURIComponent the request 404s for e.g. release/1.0, the
  // narrowing throws into the fail-closed catch and the verdict is kept — a
  // false red rather than a false green, but silent. Pin the encoded shape.
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
  const source = readFileSync(
    join(repoRoot, '.github/scripts/check-lint-gate-freshness.mjs'),
    'utf8',
  );
  const main = source.slice(source.indexOf('async function main()'));
  assert.match(
    main,
    /const fetchText = \(path\) => curlText\(path, GITHUB_TOKEN\);/,
    'main() must build fetchText from curlText',
  );
  const call = main.slice(
    main.indexOf('await findStaleGateFiles({'),
    main.indexOf('});', main.indexOf('await findStaleGateFiles({')),
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
function ciFetch(baseText, branchText, calls = [], mergeBase = MERGE_BASE_SHA) {
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
      if (path === `${prefix}main`) return baseText;
      if (path === `${prefix}${MERGE_BASE_SHA}`) return branchText;
      throw new Error(`unexpected text path: ${path}`);
    },
  };
}

// Replace one step's body inside the LINT JOB of the real workflow, so every
// fixture keeps the surrounding structure the extractor has to parse. Scoped to
// that job because several plumbing names repeat across jobs — the first match
// in the file is usually a test lane, which the slice drops.
function withStepText(name, from, to) {
  const jobAt = realCi.indexOf('\n  lint_and_static:');
  const jobEnd = realCi.indexOf('\n  web_shell_e2e_smoke:', jobAt);
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

test('extracts the lint gate slice from the real workflow', () => {
  // Anchor-drift guard: a reformat that defeats the line anchors must redden
  // here rather than silently disable the narrowing for every PR in CI.
  const slice = extractLintGateSlice(realCi);
  assert.ok(slice, 'lint gate slice not found in the real ci.yml');
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
  // The profile classifier and the helper-test lists are gate-defining too.
  assert.ok(slice.includes('  classify_pr:'));
  assert.ok(slice.includes('HELPER_TESTS_DEP_FREE'));
  assert.ok(slice.includes('ACTIONLINT_VERSION'));
  // Strictly smaller than the file: the point of the narrowing is that most of
  // ci.yml is not this gate.
  assert.ok(
    slice.split('\n').length < realCi.split('\n').length / 2,
    'the slice is not meaningfully narrower than the whole file',
  );
});

// The [start, end) span of one top-level job in a ci.yml text: the job key line
// through the line before the next job key.
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

// Step names inside the two gate jobs only. The plumbing list is consulted for
// those jobs alone, so an inventory taken over the whole workflow can be kept
// alive by a same-named step in a test lane: rename the gate job's copy and the
// stale-entry guard still passes, silently excluding nothing.
function gateJobStepNames(text) {
  const names = [];
  for (const job of ['classify_pr', 'lint_and_static']) {
    const { start, end } = jobSpan(text, job);
    for (const m of text
      .slice(start, end)
      .matchAll(/^ {6}- name: '([^']*)'\s*$/gm)) {
      names.push(m[1]);
    }
  }
  return names;
}

test('every lint job step is classified, and no plumbing name is stale', () => {
  // The two halves of the fail-closed contract. A step named in neither list
  // stays in the slice (safe), but a plumbing name that no longer exists in the
  // workflow silently excludes nothing and rots, so require each one to be
  // real. And require every linter-running step to be OUT of the plumbing set,
  // which is the misclassification that would hide a gate change.
  const names = gateJobStepNames(realCi);
  for (const name of CI_PLUMBING_STEPS) {
    assert.ok(
      names.includes(name),
      `plumbing step '${name}' is not in ci.yml any more — drop the entry`,
    );
  }
  const lintStart = realCi.indexOf('\n  lint_and_static:');
  const lintEnd = realCi.indexOf('\n  web_shell_e2e_smoke:', lintStart);
  const lintJob = realCi.slice(lintStart, lintEnd);
  const blocks = lintJob.split(/\n(?= {6}- name: ')/);
  for (const block of blocks) {
    const name = /^ {6}- name: '([^']*)'/m.exec(block)?.[1];
    if (!name || !CI_PLUMBING_STEPS.has(name)) continue;
    assert.ok(
      !/scripts\/lint\.js|node --test|npm run |prettier|eslint|actionlint|shellcheck|yamllint/.test(
        block,
      ),
      `'${name}' is classified as plumbing but invokes a linter`,
    );
  }
});

test('the depth guarantee that makes excluding Checkout safe stays in the slice', () => {
  // The step that owns the incremental-lint depth guarantee must stay OUT of
  // the plumbing list. `Checkout` is only safe to exclude because this step
  // fetches the base deep enough for lint-scope's merge-base. Excluding it too
  // would leave that guarantee unguarded: a base-side depth change could make
  // the merge base unresolvable, and lint-scope then falls back to `full: true`
  // — a wider, slower run. So the pin guards who owns the fallback, not a
  // narrowing this check could miss.
  assert.ok(
    !CI_PLUMBING_STEPS.has('Fetch incremental lint history'),
    "'Fetch incremental lint history' is the only guard of the depth guarantee that makes excluding 'Checkout' safe — it must stay in the slice",
  );
  // Membership in the list is not the claim; what matters is that the step's
  // own BODY reaches the compared text. The previous version of this pin edited
  // the `- name:` line, which `splitSteps` refuses — the extraction returned
  // null, and `notEqual(null, slice)` passes for any slice at all. Edit the
  // body instead, and assert on the body text.
  const slice = extractLintGateSlice(realCi);
  assert.ok(slice, 'the real workflow must extract');
  assert.ok(
    slice.includes('--depth=100'),
    'the depth guarantee body must be compared',
  );
  const depthEdit = withStepText(
    'Fetch incremental lint history',
    'git "${partial[@]}" fetch --no-tags --depth=100 --filter=blob:none',
    'git "${partial[@]}" fetch --no-tags --depth=50 --filter=blob:none',
  );
  const edited = extractLintGateSlice(depthEdit);
  assert.notEqual(depthEdit, realCi, 'the depth fixture must apply');
  assert.ok(edited, 'the edited workflow must still extract');
  assert.ok(
    edited.includes('--depth=50'),
    'a body edit must reach the compared text',
  );
  assert.notEqual(
    edited,
    slice,
    'a base-side edit to the depth guarantee must change the compared text',
  );
});

test('a base-side runner-routing edit does not stale the branch', async () => {
  // Mutation witness: removing ci.yml from NARROWINGS leaves this stale, and so
  // does dropping `runs-on` from CI_PLUMBING_JOB_KEYS. This is the measured
  // shape — 6 of 13 recent ci.yml commits were plumbing churn that asked every
  // in-flight PR to rebase. The edit is a REAL routing change: this case used to
  // rewrite a step body instead, leaving the routing half of the headline
  // benefit unpinned.
  const calls = [];
  const { start, end } = jobSpan(realCi, 'lint_and_static');
  const job = realCi.slice(start, end);
  const patched = job.replace(
    /^ {4}runs-on: .*$/m,
    "    runs-on: 'ubuntu-22.04'",
  );
  assert.notEqual(patched, job, 'runs-on anchor not found in lint_and_static');
  const base = realCi.slice(0, start) + patched + realCi.slice(end);
  const stale = await findStaleGateFiles({
    ...CI_OPTS,
    ...ciFetch(base, realCi, calls),
  });
  assert.deepEqual(stale, []);
  // The containment lookup and its compare, then the two content reads — no
  // third compare. A fresh `base...head` compare is ~4 MB on this repo and
  // timed out at curl's ceiling against the live API, which would have reached
  // main()'s fail-open and discarded every other gate file's verdict.
  assert.equal(calls.length, 4);
  assert.equal(
    calls.filter((c) => c.includes('/compare/')).length,
    1,
    'the narrowing must reuse the containment compare, not fetch a second one',
  );
});

test('a base-side hardening of a trust-boundary step stales the branch', async () => {
  // `Restore workspace ownership` and `Clean stale .qwen before checkout`
  // sanitise the workspace before checkout, and untrusted fork code runs in the
  // job. They are deliberately NOT plumbing: a base-side hardening has to reach
  // in-flight branches. A base-side edit to one of them must therefore keep the
  // stale verdict — the case above used to assert the opposite on one of these
  // two steps' bodies.
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

test('trust-boundary steps stay out of the plumbing whitelist', () => {
  for (const name of [
    'Restore workspace ownership',
    'Clean stale .qwen before checkout',
  ]) {
    assert.ok(!CI_PLUMBING_STEPS.has(name), `${name} must not be plumbing`);
    assert.ok(
      extractLintGateSlice(realCi).includes(name),
      `${name} must be compared`,
    );
  }
});

test('the install prelude stays in the slice', () => {
  // The whitelist is a list of what may be ignored, and the install prelude is
  // not on it: an install a profile skips is a linter that profile never runs,
  // and #16900/#16920 widened exactly that prelude. Adding its name to the
  // whitelist would drop the body from the slice and no linter pattern would
  // notice; this case is what reddens.
  const slice = extractLintGateSlice(realCi);
  assert.ok(!CI_PLUMBING_STEPS.has('Install dependencies'));
  assert.ok(
    slice.includes('DISK_SAMPLES="${RUNNER_TEMP}/disk-pressure-samples.log"'),
    'the install prelude body must stay in the compared text',
  );
});

test('a duplicated step name refuses the narrowing', () => {
  // Two steps with one name make "which step is this" unanswerable, and the
  // name is the only handle the whitelist has. YAML accepts the duplicate.
  const patched = lintJobEdit((job) =>
    job.replace(
      "      - name: 'Run Prettier'",
      "      - name: 'Checkout'\n        run: 'true'\n      - name: 'Run Prettier'",
    ),
  );
  assert.notEqual(patched, realCi, 'fixture did not apply');
  assert.equal(extractLintGateSlice(patched), null);
});

test('a base-side edit inside a non-gate job does not stale the branch', async () => {
  // Mutation witness: adding `test_build` to CI_GATE_JOBS keeps every other
  // case green while the slice grows by that whole lane. A non-gate job cannot
  // change what lint checks, so an edit inside it must not ask for a rebase.
  const { start, end } = jobSpan(realCi, 'test_build');
  const job = realCi.slice(start, end);
  // A KEPT step's body, not a dropped job key: if `test_build` ever entered
  // CI_GATE_JOBS this edit would reach the slice and the verdict would go stale.
  const patched = job.replace(
    'echo "key=$(node scripts/ci-build-cache.mjs key)"',
    'echo "key=$(node scripts/ci-build-cache.mjs --key)"',
  );
  assert.notEqual(patched, job, 'build-key anchor not found in test_build');
  const base = realCi.slice(0, start) + patched + realCi.slice(end);
  const stale = await findStaleGateFiles({
    ...CI_OPTS,
    ...ciFetch(base, realCi),
  });
  assert.deepEqual(stale, []);
});

test('a plumbing step name reused in the lint job cannot hide a new step', () => {
  // `Select Linux runner` exists only in classify_pr and the duplicate-name
  // guard is per job, so the lint job accepts a step under that name and the
  // whitelist then elides its body. With `actions/checkout` and a `ref:`, the
  // linted tree becomes main's while an unmarked slice stays identical.
  const patched = lintJobEdit(
    (job) =>
      `${job}      - name: 'Select Linux runner'\n        uses: 'actions/checkout@v4'\n        with:\n          ref: 'refs/heads/main'\n`,
  );
  const slice = extractLintGateSlice(patched);
  assert.ok(slice);
  assert.notEqual(slice, extractLintGateSlice(realCi));
  assert.ok(
    slice.includes("[[dropped plumbing-step 'Select Linux runner']]"),
    'the elided step must leave its name and position behind',
  );
});

test('moving a plumbing step changes the compared text', () => {
  // Position is part of the claim: the step that exports COREPACK_HOME and
  // XDG_CACHE_HOME runs before the install, and a base-side move must not read
  // as "nothing happened".
  const moved = lintJobEdit((job) => {
    const at = job.indexOf("      - name: 'Checkout'\n");
    assert.ok(at > 0, 'Checkout step not found in the lint job');
    const end = job.indexOf("\n      - name: '", at + 1);
    const block = job.slice(at, end + 1);
    const rest = job.slice(0, at) + job.slice(end + 1);
    const insertAt = rest.indexOf("      - name: 'Create isolated HOME'");
    return rest.slice(0, insertAt) + block + rest.slice(insertAt);
  });
  const slice = extractLintGateSlice(moved);
  assert.ok(slice);
  assert.notEqual(slice, extractLintGateSlice(realCi));
});

test('a base-side lint lane edit still stales the branch', async () => {
  // Mutation witness: a slice that keeps only the job headers passes this
  // wrongly — it would certify every branch against a changed Prettier lane,
  // which is the #11117 → #11216 incident this check exists for.
  const base = withStepText(
    'Run Prettier',
    'node scripts/lint.js --prettier',
    'node scripts/lint.js --prettier --write',
  );
  assert.notEqual(base, realCi, 'the fixture must change the Prettier lane');
  assert.notEqual(
    extractLintGateSlice(base),
    extractLintGateSlice(realCi),
    'and the change must reach the compared text',
  );
  const stale = await findStaleGateFiles({
    ...CI_OPTS,
    ...ciFetch(base, realCi),
  });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].file, CI_FILE);
});

test('a base-side helper-test list change still stales the branch', async () => {
  // The workflow env is above `jobs:` and gate-defining: dropping a suite from
  // HELPER_TESTS is a narrower gate, and the slice must see it.
  const base = realCi.replace(
    '  HELPER_TESTS: ',
    "  HELPER_TESTS: '.github/scripts/check-ci-budget.test.mjs' #\n  HELPER_TESTS_UNUSED: ",
  );
  const stale = await findStaleGateFiles({
    ...CI_OPTS,
    ...ciFetch(base, realCi),
  });
  assert.equal(stale.length, 1);
});

test('a base-side profile classifier change still stales the branch', async () => {
  // classify_pr decides which profile runs, and the profile decides which
  // linters run, so it belongs in the slice even though it is a different job.
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

test('an unclassifiable step refuses the narrowing, and says so', async () => {
  // Fail closed: an unnamed `- uses:` step cannot be classified, so the
  // extractor must return null and the whole-file verdict must stand. A silent
  // drop would hide whatever that step does.
  const logged = [];
  const original = console.log;
  console.log = (m) => logged.push(String(m));
  let stale;
  try {
    const base = realCi.replace(
      "      - name: 'Run Prettier'",
      "      - uses: './.github/actions/unknown'\n      - name: 'Run Prettier'",
    );
    stale = await findStaleGateFiles({
      ...CI_OPTS,
      ...ciFetch(base, realCi),
    });
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
    'an unclassifiable shape must annotate why the verdict was kept',
  );
});

test('a plumbing step that invokes a linter refuses the narrowing', () => {
  // The label is not trusted on its own: a step moved into the plumbing set
  // while still running a linter would hide a real gate change.
  const base = withStepText(
    'Disk floor gate (self-hosted)',
    "        run: 'bash .github/scripts/check-disk-floor.sh",
    "        run: 'node scripts/lint.js --prettier && bash .github/scripts/check-disk-floor.sh",
  );
  assert.equal(extractLintGateSlice(base), null);
});

// The lint job of the real workflow, as an edit target: every fixture below
// changes only that job so the extractor still has to parse the surrounding
// structure, and each one is a shape the previous, line-absorbing model
// compared as identical to the untouched file.
function lintJobEdit(edit) {
  const { start, end } = jobSpan(realCi, 'lint_and_static');
  return (
    realCi.slice(0, start) + edit(realCi.slice(start, end)) + realCi.slice(end)
  );
}

test('a bare dash step refuses the narrowing instead of joining the step above it', () => {
  // `      -` with `name:` on the next line is a valid sequence item. Opening a
  // step only on `      - name: '...'` absorbed the item into the step above —
  // the last one here is plumbing, whose body is dropped — so a step the runner
  // executes left no trace in the compared text.
  const patched = lintJobEdit(
    (job) => `${job}      -\n        name: 'Scratch'\n        run: 'true'\n`,
  );
  assert.notEqual(patched, realCi, 'fixture did not apply');
  assert.equal(extractLintGateSlice(patched), null);
});

test('comments at list positions and between steps change nothing', () => {
  // Prose is the one class the narrowing deliberately ignores, and it must
  // never enter the structure: the head of the step list and the gap between
  // two steps are exactly where an absorbed comment used to truncate a job
  // slice and drop `Run Prettier` from the comparison.
  const base = extractLintGateSlice(realCi);
  const headText = lintJobEdit((job) =>
    job.replace(
      /^ {4}steps:\n/m,
      '    steps:\n      # Which gates this lane runs\n',
    ),
  );
  const betweenText = lintJobEdit((job) =>
    job.replace(
      /^( {6})- name: 'Run Prettier'$/m,
      "      # Prettier is the lane #11117 flipped\n      - name: 'Run Prettier'",
    ),
  );
  // Both fixtures must actually have changed the file, or the equality below
  // says nothing about comments at all.
  assert.notEqual(headText, realCi, 'the list-head fixture did not apply');
  assert.notEqual(
    betweenText,
    realCi,
    'the between-steps fixture did not apply',
  );
  const head = extractLintGateSlice(headText);
  const between = extractLintGateSlice(betweenText);
  assert.equal(head, base);
  assert.equal(between, base);
  assert.ok(String(between).includes("  - name: 'Run Prettier'"));
  assert.ok(String(between).includes('--prettier'));
});

test("a '#' line inside a run block is content, not a comment to drop", () => {
  // A line starting with `#` inside `run: |` is shell source: the runner reads
  // it. Dropping it contradicted this file's own claim that the extractor never
  // removes a line the runner would read, and two versions of a script could
  // differ there while comparing equal.
  const withComment = (marker) =>
    lintJobEdit((job) => {
      const at = job.indexOf('          DISK_SAMPLES=');
      assert.ok(at > 0, 'sampler body not found in the lint job');
      return `${job.slice(0, at)}          # sampler ${marker}\n${job.slice(at)}`;
    });
  const one = extractLintGateSlice(withComment('revision one'));
  const two = extractLintGateSlice(withComment('revision two'));
  assert.ok(one && one.includes('# sampler revision one'));
  assert.notEqual(one, two);
  assert.notEqual(one, extractLintGateSlice(realCi));
});

// Put a scalar into the lint job's Run Prettier step in place of its plain
// `run:` value, so every row below is exercised inside the structure the real
// workflow has.
function withStepValue(valueLines) {
  return lintJobEdit((job) =>
    job.replace(
      /^ {8}run: 'node scripts\/lint\.js --prettier'$/m,
      [
        `        run: ${valueLines[0]}`,
        ...valueLines.slice(1).map((line) => `          ${line}`),
      ].join('\n'),
    ),
  );
}

test('a scalar opened with | or > is content in either modifier order', () => {
  // `|2-` and `>2-` are legal YAML (explicit indent then chomping), as are
  // `|+2` and `>+2`. The opener accepted only `[+-]?\d*`, so `|2-` was not an
  // opener at all: its body fell through to the structural path and every `#`
  // line in the script was dropped as prose while the two sides compared equal.
  const tweaked = withStepValue([
    '|2-',
    '# lane: prettier',
    'node scripts/lint.js --prettier',
  ]);
  assert.notEqual(tweaked, realCi, 'fixture did not apply');
  const slash = extractLintGateSlice(tweaked);
  assert.ok(slash, '|2- must open a block scalar');
  assert.ok(
    slash.includes('# lane: prettier'),
    'a # line inside an explicitly indented block scalar is code, not prose',
  );
  assert.ok(slash.includes('node scripts/lint.js --prettier'));
  const folded = withStepValue([
    '>2-',
    '# folded lane',
    'node scripts/lint.js --prettier',
  ]);
  const foldedSlice = extractLintGateSlice(folded);
  assert.ok(foldedSlice, '>2- must open a block scalar');
  assert.ok(foldedSlice.includes('# folded lane'));
  // Two versions differing only inside that script must not compare equal.
  const other = withStepValue([
    '|2-',
    '# lane: eslint',
    'node scripts/lint.js --prettier',
  ]);
  assert.notEqual(extractLintGateSlice(other), slash);
});

test('a block scalar the key line does not carry refuses the narrowing', () => {
  // Three legal YAML spellings put the indicator somewhere the opener pattern
  // cannot see it: on the line below the key, on a sequence item, behind a tag.
  // Read as structure, their bodies reprice `#` lines as prose — the deletion
  // SCALAR_VALUE_START closes for `|2+-`, reached by three other spellings.
  const shapes = {
    'indicator below the key': [
      'run:',
      '  |-',
      '    # lane: DIRECTIVE',
      '    node scripts/lint.js --prettier',
    ],
    "a sequence item's scalar": [
      'with:',
      '  items:',
      '    - |',
      '      # lane: DIRECTIVE',
      '      node scripts/lint.js --prettier',
    ],
    'a tagged value': [
      'run: !!str |',
      '  # lane: DIRECTIVE',
      '  node scripts/lint.js --prettier',
    ],
  };
  for (const [label, template] of Object.entries(shapes)) {
    const render = (directive) =>
      lintJobEdit((job) =>
        job.replace(
          /^ {8}run: 'node scripts\/lint\.js --prettier'$/m,
          template
            .map((line) => `        ${line.replace('DIRECTIVE', directive)}`)
            .join('\n'),
        ),
      );
    const one = render('prettier');
    const two = render('eslint');
    assert.notEqual(one, realCi, `${label}: fixture did not apply`);
    // Both refuse, so the two versions can never compare equal through the
    // narrowing; the whole-file rule — which is what a refusal falls back to —
    // still sees the difference.
    assert.equal(extractLintGateSlice(one), null, `${label} must refuse`);
    assert.equal(extractLintGateSlice(two), null, `${label} must refuse`);
  }
});

test('a multi-line quoted scalar refuses the narrowing', () => {
  // The continuation of a quoted scalar is DATA the runner reads. This model is
  // one line at a time, so a line that does not close its quote is refused
  // rather than letting a `#` on the next line be read as prose.
  for (const value of [
    ["'node scripts/lint.js", "--prettier'"],
    ['"node scripts/lint.js', '--prettier"'],
  ]) {
    const patched = withStepValue(value);
    assert.notEqual(patched, realCi, `fixture did not apply: ${value[0]}`);
    assert.equal(
      extractLintGateSlice(patched),
      null,
      `a multi-line quoted scalar must refuse: ${value[0]}`,
    );
  }
});

test('every scalar form in value position is either modelled or refused', () => {
  // The convergence mechanism: a table instead of one entry per reported shape.
  // Each row states what the model must do with it, so a newly legal YAML form
  // is one line here rather than another round of review findings.
  const forms = [
    ['plain', ['node scripts/lint.js --prettier'], 'kept'],
    ['single-quoted', ["'node scripts/lint.js --prettier'"], 'kept'],
    ['double-quoted', ['"node scripts/lint.js --prettier"'], 'kept'],
    [
      'single-quoted with trailing comment',
      ["'node scripts/lint.js --prettier' # lane"],
      'kept',
    ],
    ['|', ['|', 'node scripts/lint.js --prettier'], 'kept'],
    ['|-', ['|-', 'node scripts/lint.js --prettier'], 'kept'],
    ['|+', ['|+', 'node scripts/lint.js --prettier'], 'kept'],
    ['|2', ['|2', 'node scripts/lint.js --prettier'], 'kept'],
    ['|2-', ['|2-', 'node scripts/lint.js --prettier'], 'kept'],
    ['|+2', ['|+2', 'node scripts/lint.js --prettier'], 'kept'],
    ['>', ['>', 'node scripts/lint.js --prettier'], 'kept'],
    ['>-', ['>-', 'node scripts/lint.js --prettier'], 'kept'],
    ['>2-', ['>2-', 'node scripts/lint.js --prettier'], 'kept'],
    ['>+2', ['>+2', 'node scripts/lint.js --prettier'], 'kept'],
    [
      'multi-line single-quoted',
      ["'node scripts/lint.js", "--prettier'"],
      'null',
    ],
    [
      'multi-line double-quoted',
      ['"node scripts/lint.js', '--prettier"'],
      'null',
    ],
    [
      'unknown block modifier',
      ['|2+-', 'node scripts/lint.js --prettier'],
      'null',
    ],
  ];
  for (const [label, value, want] of forms) {
    const slice = extractLintGateSlice(withStepValue(value));
    if (want === 'null') {
      assert.equal(slice, null, `${label} must refuse the narrowing`);
    } else {
      assert.ok(slice, `${label} must be modelled`);
      assert.ok(
        slice.includes('--prettier'),
        `${label} must keep the step body in the compared text`,
      );
    }
  }
});

test('a job-level key after steps: is a key, not the tail of the last step', () => {
  // `defaults:` after the last step is a job key. Read as step content it was
  // appended to the last step — plumbing, whose body is dropped — so a
  // base-side edit that moved a job key below `steps:` compared equal.
  const patched = lintJobEdit(
    (job) => `${job}    defaults:\n      run:\n        shell: 'bash'\n`,
  );
  const slice = extractLintGateSlice(patched);
  assert.ok(slice, 'the shape must still be classified');
  assert.notEqual(slice, extractLintGateSlice(realCi));
  assert.ok(slice.includes('    defaults:'));
  assert.ok(slice.includes("        shell: 'bash'"));
});

test('a lone CR line break cannot hide a changed lint flag', () => {
  // YAML terminates a line at a lone CR as well as at LF. Splitting on '\n'
  // alone read `<comment>\r<flag line>` as ONE line whose first character is
  // `#`, dropped it, and compared two files equal where the lint flag really
  // changed — the #11117 -> #11216 shape on main.
  const withFlag = (flag) =>
    lintJobEdit((job) =>
      job.replace(
        /^ {8}run: 'node scripts\/lint\.js --prettier'$/m,
        `        # lint lane\r        run: 'node scripts/lint.js --${flag}'`,
      ),
    );
  const check = extractLintGateSlice(withFlag('prettier'));
  const write = extractLintGateSlice(withFlag('write'));
  assert.ok(check && write);
  assert.notEqual(check, write);
});

test('an anchor or alias refuses the narrowing, however far it sits', () => {
  // `&lintcmd` defined in a dropped job and `*lintcmd` cited in a kept step: a
  // line model cannot follow the reference, so two files whose only difference
  // is the anchor's value rendered the same slice wherever the alias stood.
  const withAnchor = (flag) =>
    realCi
      .replace(
        '\n  test_build:',
        `\n  test_build:\n    env:\n      LINT: &lintcmd 'node scripts/lint.js --${flag}'`,
      )
      .replace(
        /^ {8}run: 'node scripts\/lint\.js --prettier'$/m,
        '        run: *lintcmd',
      );
  const a = withAnchor('prettier');
  const b = withAnchor('write');
  assert.notEqual(a, realCi, 'fixture did not apply');
  assert.equal(extractLintGateSlice(a), null);
  assert.equal(extractLintGateSlice(b), null);
});

test('a job added or renamed on the base side changes the compared text', () => {
  // The slice names the jobs it dropped. Without that, relocating the install
  // prelude into a new job and pointing `needs:` at it left the two gate jobs
  // looking identical; with it, any change to the job roster refuses the
  // narrowing and the whole-file verdict stands.
  const added = realCi.replace(
    '\n  lint_and_static:',
    "\n  lint_prelude:\n    runs-on: 'ubuntu-latest'\n    steps:\n      - name: 'Install'\n        run: 'true'\n\n  lint_and_static:",
  );
  assert.notEqual(added, realCi, 'fixture did not apply');
  const slice = extractLintGateSlice(added);
  assert.ok(slice);
  assert.notEqual(slice, extractLintGateSlice(realCi));
  assert.ok(slice.includes("[[dropped job 'lint_prelude']]"));
});

test('the plumbing-name inventory is scoped to the gate jobs', () => {
  // The plumbing list is consulted for the two gate jobs only, so an inventory
  // over the whole workflow could be kept alive by a same-named step in a test
  // lane: rename the gate job's copy and the stale-entry guard still passed.
  // `Create isolated HOME` lives only in the lint job among the gate jobs, so
  // renaming it there is exactly the rename the whole-file inventory could not
  // see: the name survives in test lanes, which the plumbing list never governs.
  const renamed = withStepText(
    'Create isolated HOME',
    "- name: 'Create isolated HOME'",
    "- name: 'Create the lint HOME'",
  );
  assert.ok(
    !gateJobStepNames(renamed).includes('Create isolated HOME'),
    'a rename inside the gate job must leave the scoped inventory',
  );
  // The whole-file inventory is what the old assertion used, and it still finds
  // the renamed name in a test lane — which is exactly why it could never see
  // this rename. Assert the name that WAS renamed, not a different one.
  const wholeFile = [...renamed.matchAll(/^ {6}- name: '([^']*)'\s*$/gm)].map(
    (m) => m[1],
  );
  assert.ok(
    wholeFile.includes('Create isolated HOME'),
    'the renamed name must still exist in a test lane, which is what fooled the whole-file inventory',
  );
  assert.notEqual(renamed, realCi, 'the rename fixture must apply');
});

test('a plumbing step that reaches a linter through a package manager refuses', () => {
  // The label is not trusted: a plumbing step whose body invokes a linter is a
  // contradiction. The guard used to anchor on `npm run`, which no `pnpm`
  // spelling contains a word boundary for, so `pnpm run lint` — and
  // `corepack pnpm run lint` — walked straight through.
  for (const invocation of [
    'pnpm run lint',
    'corepack pnpm run lint',
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

test('a missing gate job refuses the narrowing', () => {
  // Renaming the lint job must not read as "no gate to compare".
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

test('a duplicated job key refuses the narrowing', () => {
  // YAML would take the last one; a Map that silently overwrites would compare
  // a slice built from whichever copy the parser happened to keep.
  const { start, end } = jobSpan(realCi, 'lint_and_static');
  const duplicated =
    realCi.slice(0, end) + realCi.slice(start, end) + realCi.slice(end);
  assert.notEqual(duplicated, realCi, 'the fixture did not apply');
  assert.equal(extractLintGateSlice(duplicated), null);
});

test('a dropped job key takes its block-scalar body with it', () => {
  // `timeout-minutes` is plumbing, but its value can be a block scalar indented
  // by only two spaces. A fixed six-space continuation test leaves that body
  // orphaned under the preceding key — and a blank-line-swallowing scan runs
  // past the NEXT key and drops gate content with it.
  const jobAt = realCi.indexOf('\n  lint_and_static:');
  const jobEnd = realCi.indexOf('\n  web_shell_e2e_smoke:', jobAt);
  const job = realCi.slice(jobAt, jobEnd);
  const patched = job.replace(
    /^ {4}timeout-minutes: .*$/m,
    '    timeout-minutes: |-\n      45\n    env:\n      KEEP_ME: 1',
  );
  assert.notEqual(patched, job, 'timeout-minutes anchor not found');
  const blockScalar = realCi.slice(0, jobAt) + patched + realCi.slice(jobEnd);
  const slice = extractLintGateSlice(blockScalar);
  assert.ok(slice, 'the block-scalar shape must still be parseable');
  assert.ok(
    !/^ {4}timeout-minutes:/m.test(slice),
    'the job-level plumbing key must be gone',
  );
  // Step-level timeouts are gate content (a 5-minute actionlint cap), so only
  // the four-space job key is dropped.
  assert.ok(
    /^ {8}timeout-minutes:/m.test(slice),
    'step-level timeouts must survive',
  );
  assert.ok(
    slice.includes('KEEP_ME: 1'),
    'the scan must stop at the next key, not swallow it',
  );
});

test('a comment-only base-side edit does not stale the branch', () => {
  // Most of ci.yml's churn is prose. Only whole-line comments are dropped, so
  // this is safe; a `#` inside a shell body is content and must survive.
  const commented = realCi.replace(
    "      - name: 'Run Prettier'",
    "      # A new explanatory paragraph about the Prettier lane.\n      - name: 'Run Prettier'",
  );
  assert.notEqual(commented, realCi, 'the comment fixture did not apply');
  assert.equal(extractLintGateSlice(commented), extractLintGateSlice(realCi));
  const inBody = withStepText(
    'Use trusted CI profile',
    '          profile="${TRUSTED_CI_PROFILE:-full}"',
    '          profile="${TRUSTED_CI_PROFILE:-full}" # keep',
  );
  const inBodySlice = extractLintGateSlice(inBody);
  assert.notEqual(inBodySlice, extractLintGateSlice(realCi));
  assert.ok(
    inBodySlice.includes('profile="${TRUSTED_CI_PROFILE:-full}" # keep'),
    'a trailing comment inside a shell body is content, not a comment line',
  );
});

test('a compare without a merge base keeps the verdict, and says so', async () => {
  // Fail closed, not open: an absent merge_base_commit must not be read as
  // "nothing to compare".
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

test('the ci.yml slice is compared at the merge base, not at the head', async () => {
  // A branch that edits the gate itself must not be flagged for its own edit:
  // main will not carry that edit until the branch merges, so a head-side
  // comparison would keep demanding a rebase that can never satisfy it. Here
  // the branch's own copy weakens the Prettier lane while both sides of the
  // comparison are clean, and the fake refuses any read at the head SHA — so
  // fetching the head instead of the merge base fails rather than passing.
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
