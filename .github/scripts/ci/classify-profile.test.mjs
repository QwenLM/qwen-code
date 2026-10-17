import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import test from 'node:test';

import {
  GITHUB_CI_ONLY_FILES,
  TEST_READ_MARKDOWN,
  classifyChangedFiles,
} from './classify-profile.mjs';

test('uses docs_only for markdown-only changes', () => {
  assert.equal(
    classifyChangedFiles(['README.md', 'docs/usage.md']),
    'docs_only',
  );
  // Markdown outside docs/ skips tests too, but keeps full review.
  assert.equal(
    classifyChangedFiles(['README.md', 'docs/usage.md', '.qwen/design/foo.md']),
    'github_ci_only',
  );
});

test('skips application tests for Markdown on any path outside src/ and fixtures', () => {
  for (const file of [
    '.qwen/skills/example/SKILL.md',
    '.qwen/e2e-tests/web-shell/plan.md',
    '.github/pull_request_template.md',
    'packages/web-shell/README.md',
    'integrations/external-context/GUIDE.MD',
  ]) {
    assert.equal(classifyChangedFiles([file]), 'github_ci_only', file);
  }
});

test('keeps Markdown that tests read by path on the full profile', () => {
  for (const file of TEST_READ_MARKDOWN) {
    assert.equal(classifyChangedFiles([file]), 'full', file);
  }
  assert.equal(
    classifyChangedFiles(['AGENTS.md', '.qwen/skills/example/SKILL.md']),
    'full',
  );
});

// Matches a test that names a Markdown file by its path, by its last two
// segments (joined with `/` or as separate quoted arguments, which covers
// path.join(root, 'packages', 'x', 'README.md')), or by a relative literal
// resolved against the test file.
test('lists every lightweight Markdown a test names in TEST_READ_MARKDOWN', () => {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  const tracked = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
    .split('\0')
    .filter(Boolean);
  const lightweight = new Set(
    tracked.filter(
      (file) =>
        /\.md$/i.test(file) &&
        classifyChangedFiles([file]) === 'github_ci_only',
    ),
  );
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const separator = String.raw`(?:/|['"\x60]\s*,\s*['"\x60])`;
  const matchers = [...lightweight].map((file) => {
    const tail = file.split('/').slice(-2).map(escape).join(separator);
    return [
      file,
      posix.basename(file),
      new RegExp(String.raw`(?<![\w.-])${tail}(?![\w/-])`),
    ];
  });
  const named = new Set();
  for (const testFile of tracked) {
    if (
      testFile === '.github/scripts/ci/classify-profile.test.mjs' ||
      !(
        /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(testFile) ||
        /^(?:scripts\/tests|integration-tests)\/.*\.[cm]?[jt]sx?$/.test(
          testFile,
        )
      ) ||
      !existsSync(posix.join(root, testFile))
    ) {
      continue;
    }
    const source = readFileSync(posix.join(root, testFile), 'utf8');
    if (!/\.md/i.test(source)) continue;
    for (const [file, basename, pattern] of matchers) {
      if (source.includes(basename) && pattern.test(source)) {
        named.add(`${file} <- ${testFile}`);
      }
    }
    for (const [, relative] of source.matchAll(
      /['"\x60]((?:\.\.?\/)+[^'"\x60\s]*\.md)['"\x60]/gi,
    )) {
      const file = posix.normalize(
        posix.join(posix.dirname(testFile), relative),
      );
      if (lightweight.has(file)) named.add(`${file} <- ${testFile}`);
    }
  }
  assert.deepEqual([...named].sort(), []);
});

test('keeps Markdown that ships in src/ or feeds fixtures on the full profile', () => {
  for (const file of [
    'packages/core/src/skills/bundled/review/SKILL.md',
    'packages/cli/src/commands/extensions/examples/starter/QWEN.md',
    'packages/cli/src/commands/review/__fixtures__/comment.md',
    'integration-tests/fixtures/chat-transcript-contract/v1/turn.md',
    'integrations/test-failure-explorer/test-fixtures/report.md',
    'packages/cua-driver/compat-fixtures/apps/notes.md',
    'packages/foo/Src/notes.md',
  ]) {
    assert.equal(classifyChangedFiles([file]), 'full', file);
  }
});

test('keeps non-Markdown lookalikes outside docs/ on the full profile', () => {
  for (const file of [
    'packages/web-shell/README.mdx',
    'packages/web-shell/notes.md.ts',
    'packages/web-shell/notes.md/index.ts',
  ]) {
    assert.equal(classifyChangedFiles([file]), 'full', file);
  }
});

test('uses docs_only for uppercase and extensionless docs', () => {
  assert.equal(
    classifyChangedFiles(['README.MD', 'docs/guide.MD', 'LICENSE', 'README']),
    'docs_only',
  );
});

test('MDX is executable content, never docs_only', () => {
  // MDX pages can import components and carry expressions — a runtime/build
  // failure surface the docs-only downgrade must not skip over.
  assert.equal(classifyChangedFiles(['docs/guide.mdx']), 'full');
  assert.equal(classifyChangedFiles(['docs/guide.MDX']), 'full');
  assert.equal(classifyChangedFiles(['README.mdx']), 'full');
  assert.equal(
    classifyChangedFiles(['docs/usage.md', 'docs/guide.mdx']),
    'full',
  );
});

test('falls back to full for root docs names used as directories', () => {
  assert.equal(classifyChangedFiles(['README.md/evil.ts']), 'full');
  assert.equal(classifyChangedFiles(['LICENSE.txt/src/index.ts']), 'full');
});

test('uses github_ci_only for the allowed GitHub CI helper files', () => {
  assert.equal(
    classifyChangedFiles([...GITHUB_CI_ONLY_FILES]),
    'github_ci_only',
  );
});

test('uses github_ci_only for each allowed GitHub CI helper file', () => {
  for (const file of GITHUB_CI_ONLY_FILES) {
    assert.equal(classifyChangedFiles([file]), 'github_ci_only');
  }
});

test('uses github_ci_only, not docs_only, for CODEOWNERS changes', () => {
  assert.equal(classifyChangedFiles(['.github/CODEOWNERS']), 'github_ci_only');
  assert.equal(
    classifyChangedFiles([
      { filename: '.github/CODEOWNERS', status: 'modified' },
    ]),
    'github_ci_only',
  );
});

test('keeps CODEOWNERS lookalikes and mixed changes on the full profile', () => {
  for (const files of [
    ['.github/codeowners'],
    ['.GITHUB/CODEOWNERS'],
    ['.github/CODEOWNERS.js'],
    ['.github/CODEOWNERS/src/index.ts'],
    ['.github/ISSUE_TEMPLATE/bug_report.yml'],
    ['.github/CODEOWNERS', 'packages/core/src/runtime.ts'],
    ['.github/CODEOWNERS', '.github/workflows/ci.yml'],
  ]) {
    assert.equal(classifyChangedFiles(files), 'full', files.join(', '));
  }
});

test('keeps cross-profile renames involving CODEOWNERS on the full profile', () => {
  for (const path of ['packages/core/src/runtime.ts', 'docs/old.md']) {
    for (const [filename, previous_filename] of [
      ['.github/CODEOWNERS', path],
      [path, '.github/CODEOWNERS'],
    ]) {
      assert.equal(
        classifyChangedFiles([
          { filename, previous_filename, status: 'renamed' },
        ]),
        'full',
      );
    }
  }
  assert.equal(
    classifyChangedFiles([
      { filename: '.github/CODEOWNERS', status: 'renamed' },
    ]),
    'full',
  );
});

test('keeps yaml-dependent helper suites on the full profile', () => {
  // web-shell-visuals-publish.test.mjs statically imports `yaml`, so the
  // dependency-free github_ci_only lane can never execute it; downgrading a
  // PR that only edits that suite would green-light it without running it.
  assert.equal(
    classifyChangedFiles([
      '.github/scripts/web-shell-visuals-publish.test.mjs',
    ]),
    'full',
  );
});

test('falls back to full for case-mismatched GitHub CI helper paths', () => {
  assert.equal(
    classifyChangedFiles(['.GITHUB/SCRIPTS/PR-SAFETY-PRECHECK.MJS']),
    'full',
  );
});

test('classifies renamed files using both old and new paths', () => {
  assert.equal(
    classifyChangedFiles([
      {
        filename: 'docs/new.md',
        previous_filename: 'packages/core/src/runtime.ts',
        status: 'renamed',
      },
    ]),
    'full',
  );
  assert.equal(
    classifyChangedFiles([
      {
        filename: 'docs/new.md',
        previous_filename: 'docs/old.md',
        status: 'renamed',
      },
    ]),
    'docs_only',
  );
  assert.equal(
    classifyChangedFiles([
      {
        filename: '.qwen/skills/new/SKILL.md',
        previous_filename: 'packages/core/src/skills/bundled/old/SKILL.md',
        status: 'renamed',
      },
    ]),
    'full',
  );
});

test('falls back to full when changed files are unavailable', () => {
  assert.equal(classifyChangedFiles([]), 'full');
  assert.equal(classifyChangedFiles(['', null, undefined]), 'full');
});

test('falls back to full for source or mixed changes', () => {
  assert.equal(
    classifyChangedFiles(['README.md', 'packages/cli/src/index.ts']),
    'full',
  );
  assert.equal(
    classifyChangedFiles(['.qwen/skills/triage/SKILL.md', 'scripts/build.js']),
    'full',
  );
});

test('keeps docs mixed with helper files or Markdown off application tests', () => {
  assert.equal(
    classifyChangedFiles([
      'README.md',
      '.github/scripts/pr-safety-precheck.mjs',
    ]),
    'github_ci_only',
  );
  assert.equal(
    classifyChangedFiles(['docs/usage.md', 'packages/web-shell/README.md']),
    'github_ci_only',
  );
  assert.equal(
    classifyChangedFiles(['.github/CODEOWNERS', 'README.md']),
    'github_ci_only',
  );
});

test('falls back to full for main CI workflow changes', () => {
  assert.equal(classifyChangedFiles(['.github/workflows/ci.yml']), 'full');
  assert.equal(classifyChangedFiles(['.github/workflows/codeql.yml']), 'full');
});

test('falls back to full for classifier changes', () => {
  assert.equal(
    classifyChangedFiles(['.github/scripts/ci/classify-profile.mjs']),
    'full',
  );
  assert.equal(
    classifyChangedFiles(['.github/scripts/ci/classify-profile.test.mjs']),
    'full',
  );
});

test('never downgrades review for runtime markdown assets and instruction files', () => {
  assert.equal(
    classifyChangedFiles(['packages/core/src/skills/bundled/foo/SKILL.md']),
    'full',
  );
  assert.equal(classifyChangedFiles(['AGENTS.md']), 'full');
  assert.equal(
    classifyChangedFiles(['.qwen/skills/example/SKILL.md']),
    'github_ci_only',
  );
});

test('reserved prose basenames classify docs_only only with inert extensions', () => {
  assert.equal(classifyChangedFiles(['README.md']), 'docs_only');
  assert.equal(classifyChangedFiles(['LICENSE']), 'docs_only');
  assert.equal(classifyChangedFiles(['SECURITY.txt']), 'docs_only');
  // Executable files named after reserved basenames must never downgrade a
  // review: the open-extension form classified all of these as docs.
  assert.equal(classifyChangedFiles(['README.js']), 'full');
  assert.equal(classifyChangedFiles(['SECURITY.ts']), 'full');
  assert.equal(classifyChangedFiles(['LICENSE.sh']), 'full');
});
