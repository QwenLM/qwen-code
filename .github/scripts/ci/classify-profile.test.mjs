import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GITHUB_CI_ONLY_FILES,
  classifyChangedFiles,
} from './classify-profile.mjs';

test('uses docs_only for markdown-only changes', () => {
  assert.equal(
    classifyChangedFiles(['README.md', 'docs/usage.md', '.qwen/design/foo.md']),
    'docs_only',
  );
});

test('uses docs_only for uppercase and extensionless docs', () => {
  assert.equal(
    classifyChangedFiles(['README.MD', 'docs/guide.MDX', 'LICENSE', 'README']),
    'docs_only',
  );
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
    classifyChangedFiles([
      'README.md',
      '.github/scripts/pr-safety-precheck.mjs',
    ]),
    'full',
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
