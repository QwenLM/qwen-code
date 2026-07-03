import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GITHUB_CI_ONLY_FILES,
  classifyChangedFiles,
} from './classify-profile.mjs';

test('uses docs_only for markdown-only changes', () => {
  assert.equal(
    classifyChangedFiles(['README.md', 'docs/usage.md', '.qwen/design/foo.md']),
    'full',
  );
  assert.equal(
    classifyChangedFiles(['README.md', 'docs/usage.md']),
    'docs_only',
  );
});

test('uses docs_only for uppercase and extensionless docs', () => {
  assert.equal(
    classifyChangedFiles(['README.MD', 'docs/guide.MDX', 'LICENSE', 'README']),
    'docs_only',
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

test('falls back to full for runtime markdown assets and instruction files', () => {
  assert.equal(
    classifyChangedFiles(['packages/core/src/skills/bundled/foo/SKILL.md']),
    'full',
  );
  assert.equal(classifyChangedFiles(['AGENTS.md']), 'full');
});
