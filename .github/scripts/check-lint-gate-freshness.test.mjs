import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  GATE_FILES,
  TEXT_ACCEPT,
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
  assert.ok(
    stepBlock.includes("github.event_name == 'pull_request'"),
    'step must be gated to pull_request',
  );
  assert.ok(
    stepBlock.includes("skip_ci != 'true'"),
    'step must stay running alongside the other no-op-pass lanes on skip_ci',
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
    fetchJson: divergedJson(),
    fetchText: textFetch(
      ignoreFile(['node_modules', 'packages/live-host/']),
      ignoreFile(['node_modules']),
      calls,
      '.prettierignore',
    ),
  });
  assert.deepEqual(stale, []);
  assert.equal(calls.length, 2);
});

test('a base-side prettierignore REMOVAL still stales the branch', async () => {
  const stale = await findStaleGateFiles({
    ...PRETTIER_OPTS,
    fetchJson: divergedJson(),
    fetchText: textFetch(
      ignoreFile(['node_modules']),
      ignoreFile(['node_modules', 'packages/live-host/']),
      [],
      '.prettierignore',
    ),
  });
  assert.equal(stale.length, 1);
});

test('a negated prettierignore line blocks the narrowing', async () => {
  const stale = await findStaleGateFiles({
    ...PRETTIER_OPTS,
    fetchJson: divergedJson(),
    fetchText: textFetch(
      ignoreFile(['*.md', '!keep.md']),
      ignoreFile(['*.md']),
      [],
      '.prettierignore',
    ),
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
    fetchJson: divergedJson(),
    fetchText: textFetch(
      ignoreFile([' foo.js']),
      ignoreFile(['foo.js']),
      [],
      '.prettierignore',
    ),
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
});
