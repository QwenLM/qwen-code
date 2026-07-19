import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { shouldAutoSkipChangelog } from './classify-release-notes.mjs';

describe('release note classification', () => {
  it('only skips internal CI changes', () => {
    const cases = [
      {
        title: 'ci: speed up PR checks',
        files: ['.github/workflows/ci.yml'],
        expected: true,
      },
      {
        title: 'ci(autofix): harden review automation',
        files: [
          '.github/workflows/qwen-autofix.yml',
          '.qwen/skills/autofix/SKILL.md',
          'scripts/tests/qwen-autofix-workflow.test.js',
        ],
        expected: true,
      },
      {
        title: 'Fix flaky CI routing',
        labels: ['scope/ci-cd'],
        files: ['.github/workflows/ci.yml'],
        expected: true,
      },
      {
        title: 'Update action permissions',
        labels: ['scope/github-actions'],
        files: ['.github/workflows/ci.yml'],
        expected: true,
      },
      {
        title: 'fix(ci): repair check results',
        labels: ['scope/ci-cd'],
        files: ['.github/workflows/ci.yml'],
        expected: false,
      },
      {
        title: 'ci: update release automation',
        files: ['.github/workflows/finalize-release.yml'],
        expected: false,
      },
      {
        title: 'ci: update release helper',
        files: ['.github/scripts/publish-release.mjs'],
        expected: false,
      },
      {
        title: 'ci: support a new platform build',
        labels: ['category/platform'],
        files: ['.github/workflows/ci.yml'],
        expected: false,
      },
      {
        title: 'ci: update checks and runtime',
        files: ['.github/workflows/ci.yml', 'packages/core/src/index.ts'],
        expected: false,
      },
      {
        title: 'ci: move a runtime file into automation',
        files: ['.github/scripts/runtime.ts', 'packages/core/src/runtime.ts'],
        expected: false,
      },
      {
        title: 'ci: keep manual exclusion',
        labels: ['skip-changelog'],
        files: ['.github/workflows/ci.yml'],
        expected: false,
      },
    ];

    for (const { expected, ...pullRequest } of cases) {
      assert.equal(
        shouldAutoSkipChangelog(pullRequest),
        expected,
        pullRequest.title,
      );
    }
  });

  it('keeps renamed production files by checking their previous paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-note-classifier-'));
    try {
      const gh = join(dir, 'gh');
      writeFileSync(
        gh,
        [
          '#!/usr/bin/env node',
          'const args = process.argv.slice(2);',
          "if (args[0] === 'pr') { process.stdout.write(JSON.stringify({ title: 'ci: move runtime', labels: [] })); process.exit(0); }",
          "if (args.includes('.[] | .filename, (.previous_filename // empty)')) { process.stdout.write('.github/scripts/runtime.ts\\npackages/core/src/runtime.ts\\n'); process.exit(0); }",
          'process.exit(1);',
        ].join('\n'),
      );
      chmodSync(gh, 0o755);

      const decision = execFileSync(
        process.execPath,
        [join(import.meta.dirname, 'classify-release-notes.mjs')],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_REPOSITORY: 'QwenLM/qwen-code',
            PATH: `${dir}:${process.env.PATH}`,
            PR_NUMBER: '1',
          },
        },
      );

      assert.equal(decision, 'include\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('wires reclassification and exclusion to the same automatic label', () => {
    const workflow = readFileSync(
      '.github/workflows/classify-release-notes.yml',
      'utf8',
    );
    const release = readFileSync('.github/release.yml', 'utf8');

    for (const action of ['synchronize', 'edited', 'labeled', 'unlabeled']) {
      assert.match(workflow, new RegExp(`- '${action}'`));
    }
    assert.match(workflow, /AUTO_LABEL: 'skip-changelog-auto'/);
    assert.match(workflow, /classification failed; including this PR/);
    assert.doesNotMatch(workflow, /decision=unchanged/);
    assert.match(release, /- 'skip-changelog-auto'/);
  });
});
