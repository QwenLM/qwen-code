import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyChangedFiles } from './classify-profile.mjs';

test('uses docs_only for markdown-only changes', () => {
  assert.equal(
    classifyChangedFiles(['README.md', 'docs/usage.md', '.qwen/design/foo.md']),
    'docs_only',
  );
});

test('uses github_ci_only for the allowed GitHub CI helper files', () => {
  assert.equal(
    classifyChangedFiles([
      '.github/scripts/pr-safety-precheck.mjs',
      '.github/scripts/pr-safety-precheck.test.mjs',
      '.github/scripts/ci/classify-profile.mjs',
      '.github/scripts/ci/classify-profile.test.mjs',
      '.github/workflows/qwen-pr-safety-precheck.yml',
    ]),
    'github_ci_only',
  );
});

test('falls back to full when changed files are unavailable', () => {
  assert.equal(classifyChangedFiles([]), 'full');
});

test('falls back to full for source or mixed changes', () => {
  assert.equal(
    classifyChangedFiles(['README.md', 'packages/cli/src/index.ts']),
    'full',
  );
});

test('falls back to full for main CI workflow changes', () => {
  assert.equal(classifyChangedFiles(['.github/workflows/ci.yml']), 'full');
});
