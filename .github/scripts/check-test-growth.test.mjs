import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FLAG_THRESHOLD,
  classify,
  curlJson,
  measure,
  packageOf,
  parseNumstat,
  renderAnnotation,
  renderSummary,
  tally,
} from './check-test-growth.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('classifies test, production and other files', () => {
  const cases = {
    'packages/core/src/a.test.ts': 'test',
    'packages/cli/src/ui/App.test.tsx': 'test',
    'packages/core/src/a.spec.ts': 'test',
    'packages/core/src/tools/shell.test-helper.ts': 'test',
    'packages/core/src/x/case.fixtures.json': 'test',
    'packages/core/src/utils/testUtils.ts': 'test',
    'packages/core/test-setup.ts': 'test',
    'packages/core/src/__tests__/a.ts': 'test',
    'packages/cli/src/__snapshots__/App.test.tsx.snap': 'test',
    'packages/core/src/test-utils/mock-tool.ts': 'test',
    'packages/cli/src/commands/review/lib/test-utils.ts': 'test',
    'packages/core/src/lsp/__e2e__/lsp-e2e-test.ts': 'test',
    'packages/web-shell/client/e2e/utils/mockDaemon.ts': 'test',
    'packages/web-shell/client/test/setup.ts': 'test',
    'packages/core/src/core/client.ts': 'production',
    'packages/web-shell/client/src/App.tsx': 'production',
    'packages/cli/src/index.mjs': 'production',
    'packages/core/src/config/settings.schema.ts': 'other',
    'packages/core/src/generated/git-commit.ts': 'other',
    'packages/core/src/x.generated.ts': 'other',
    'packages/core/package.json': 'other',
    'packages/web-shell/client/src/app.css': 'other',
    'packages/core/README.md': 'other',
  };
  for (const [path, kind] of Object.entries(cases)) {
    assert.equal(classify(path), kind, path);
  }
});

test('counts only core, cli and web-shell', () => {
  assert.equal(packageOf('packages/core/src/a.ts'), 'core');
  assert.equal(packageOf('packages/web-shell/client/src/a.ts'), 'web-shell');
  assert.equal(packageOf('packages/sdk-typescript/src/a.ts'), null);
  assert.equal(packageOf('scripts/build.js'), null);
});

test('tallies numstat per package, skipping binary and other files', () => {
  const numstat = [
    '120\t20\tpackages/core/src/a.test.ts',
    '30\t5\tpackages/core/src/a.ts',
    '-\t-\tpackages/cli/assets/logo.png',
    '40\t0\tpackages/cli/src/b.test.tsx',
    '9\t1\tpackages/cli/package.json',
    '7\t2\tpackages/sdk-typescript/src/c.test.ts',
    '',
  ].join('\n');
  const entries = parseNumstat(numstat);
  assert.equal(entries.length, 5);
  assert.deepEqual(tally(entries), {
    byPackage: {
      core: {
        test: { added: 120, deleted: 20 },
        production: { added: 30, deleted: 5 },
      },
      cli: {
        test: { added: 40, deleted: 0 },
        production: { added: 0, deleted: 0 },
      },
      'web-shell': {
        test: { added: 0, deleted: 0 },
        production: { added: 0, deleted: 0 },
      },
    },
    total: {
      test: { added: 160, deleted: 20 },
      production: { added: 30, deleted: 5 },
    },
  });
});

test('flags at the threshold of net test lines, not below', () => {
  const withNet = (n) =>
    tally([
      { added: n + 100, deleted: 100, path: 'packages/core/src/a.test.ts' },
    ]);
  assert.equal(FLAG_THRESHOLD, 2000);

  const below = withNet(FLAG_THRESHOLD - 1);
  assert.equal(renderAnnotation(below), null);
  assert.doesNotMatch(renderSummary(below), /net test lines, at or above/);

  const at = withNet(FLAG_THRESHOLD);
  assert.match(
    renderAnnotation(at),
    /^::warning title=Test growth::This PR adds 2,000 net test lines/,
  );
  assert.match(renderSummary(at), /\| core \| \+2,100 \/ −100 \(net \+2,000\)/);
  assert.match(
    renderSummary(at),
    /2,000 net test lines, at or above the 2,000-line flag/,
  );
});

test('measures from the merge base, fetching it only when missing', async () => {
  const [base, head, mergeBase] = ['b', 'h', 'm'].map((c) => c.repeat(40));
  const run = async ({ present, partialFails = false }) => {
    const calls = [];
    const result = await measure({
      repo: 'QwenLM/qwen-code',
      baseSha: base,
      headSha: head,
      fetchJson: async (path) => {
        assert.equal(
          path,
          `/repos/QwenLM/qwen-code/compare/${base}...${head}?per_page=1`,
        );
        return { merge_base_commit: { sha: mergeBase } };
      },
      runGit: async (...args) => {
        calls.push(args.join(' '));
        if (args[0] === 'cat-file' && !present) throw new Error('missing');
        if (partialFails && args.includes('--filter=blob:none')) {
          throw new Error('no partial clone');
        }
        // The diff must start at the merge base, not the base tip.
        if (args.includes('diff')) return '3\t1\tpackages/core/src/a.test.ts\n';
        return '';
      },
    });
    assert.deepEqual(result.tallied.total.test, { added: 3, deleted: 1 });
    return calls;
  };
  const PARTIAL =
    '-c extensions.partialClone=origin -c remote.origin.promisor=true';
  const DIFF = `diff --numstat --no-renames ${mergeBase} ${head} -- packages/core packages/cli packages/web-shell`;

  assert.deepEqual(await run({ present: true }), [
    `cat-file -e ${mergeBase}^{commit}`,
    DIFF,
  ]);
  assert.deepEqual(await run({ present: false }), [
    `cat-file -e ${mergeBase}^{commit}`,
    `${PARTIAL} fetch --no-tags --depth=1 --filter=blob:none origin ${mergeBase}`,
    `${PARTIAL} ${DIFF}`,
    'config --unset remote.origin.partialclonefilter',
  ]);
  assert.deepEqual(
    (await run({ present: false, partialFails: true })).slice(2),
    [`fetch --no-tags --depth=1 origin ${mergeBase}`, DIFF],
  );
});

test('ci.yml runs the check in lint_and_static on pull requests', () => {
  const ci = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  const jobStart = ci.indexOf('\n  lint_and_static:');
  const jobEnd = ci.indexOf('\n  test_macos:', jobStart);
  assert.ok(jobStart > 0 && jobEnd > jobStart, 'lint_and_static job not found');
  const job = ci.slice(jobStart, jobEnd);

  const step = job.indexOf("- name: 'Report test growth'");
  assert.ok(step > 0, 'test growth step missing');
  const stepBlock = job.slice(step, job.indexOf('\n      - name:', step + 1));
  // Whole literal, not the `pull_request`/`skip_ci` substrings this used to
  // check: appending `&& ... != 'docs_only'` keeps both tokens in place while
  // narrowing the gate, and no suite asserted the literal (#16991, the third
  // step sharing it after #16918). No profile arm: the report is meant to
  // cover every PR, so keying this gate on the profile could only narrow it.
  assert.equal(
    stepBlock.match(/^ {8}if: "(.*)"$/m)?.[1],
    "${{ needs.classify_pr.outputs.skip_ci != 'true' && github.event_name == 'pull_request' }}",
    'test growth gate drifted',
  );
  // Advisory by contract (see the script header): the step reports and never
  // blocks. Dropping `continue-on-error` would leave the gate literal above
  // intact while turning a summary into a required-check failure.
  assert.match(
    stepBlock,
    /^ {8}continue-on-error: true$/m,
    'test growth step must stay advisory',
  );
  assert.ok(
    stepBlock.includes('node .github/scripts/check-test-growth.mjs'),
    'step must run the test growth script',
  );
  // Whole lines, not keys or values: the script reads these three names plus
  // GITHUB_REPOSITORY from process.env and returns early — one warning, exit 0,
  // no summary — if any is missing. Only these three are pinned: the fourth is
  // a default environment variable the runner injects, so the workflow never
  // spells it and there is no line here to pin. A key-only pin accepts an empty
  // value or a mistyped secret; a value-only pin accepts a renamed key
  // (`BASE_SHA` → `TEST_GROWTH_BASE_SHA`, a prefix this job already uses for
  // LINT_BASE_SHA). Either keeps the report a permanent no-op behind a green
  // check, since the step is continue-on-error.
  for (const [line, label] of [
    [
      /^ {10}GITHUB_TOKEN: '\$\{\{ secrets\.GITHUB_TOKEN \}\}'$/m,
      'the GitHub token',
    ],
    [
      /^ {10}BASE_SHA: '\$\{\{ github\.event\.pull_request\.base\.sha \}\}'$/m,
      'BASE_SHA',
    ],
    [
      /^ {10}HEAD_SHA: '\$\{\{ github\.event\.pull_request\.head\.sha \}\}'$/m,
      'HEAD_SHA',
    ],
  ]) {
    assert.match(stepBlock, line, `test growth step must pass ${label}`);
  }
  assert.ok(
    step < job.indexOf("- name: 'Install dependencies'"),
    'the check needs no dependencies and must run before the install',
  );

  for (const list of ['HELPER_TESTS_DEP_FREE', 'HELPER_TESTS']) {
    const line = ci.split('\n').find((l) => l.trim().startsWith(`${list}:`));
    assert.ok(
      line?.includes('.github/scripts/check-test-growth.test.mjs'),
      `${list} must run this test`,
    );
  }
});

test('API errors never carry the token', async () => {
  const failing = async () => {
    throw Object.assign(
      new Error('Command failed: curl -H Authorization: Bearer secret-token'),
      {
        code: 22,
        stderr: 'curl: (22) The requested URL returned error: 401\n',
      },
    );
  };
  await assert.rejects(
    curlJson('/repos/o/r/compare/a...b', 'secret-token', failing),
    (error) => {
      assert.doesNotMatch(error.message, /secret-token/);
      assert.match(error.message, /curl exit 22\): curl: \(22\).*401$/);
      return true;
    },
  );
});
