import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
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
        title: 'ci: update test helpers',
        files: ['packages/core/src/__tests__/utils.ts'],
        expected: true,
      },
      {
        title: 'ci: update vitest config',
        files: ['packages/cli/vitest.config.ts'],
        expected: true,
      },
      {
        title: 'ci: update spec tests',
        files: ['packages/core/src/auth.spec.ts'],
        expected: true,
      },
      {
        title: 'ci: update playwright config',
        files: ['packages/e2e/playwright.config.ts'],
        expected: true,
      },
      {
        title: 'ci: update release classifier tests',
        files: ['.github/scripts/classify-release-notes.test.mjs'],
        expected: true,
      },
      {
        title: 'Fix flaky CI routing',
        labels: [{ name: 'scope/ci-cd' }],
        files: ['.github/workflows/ci.yml'],
        expected: true,
      },
      {
        title: 'ci!: breaking dispatch change',
        files: ['.github/workflows/ci.yml'],
        expected: false,
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
        title: 'ci: fix check',
        labels: ['bug'],
        files: ['.github/workflows/ci.yml'],
        expected: false,
      },
      {
        title: 'ci: fix check',
        labels: ['breaking-change'],
        files: ['.github/workflows/ci.yml'],
        expected: false,
      },
      {
        title: 'ci: keep automatic exclusion stable',
        labels: ['skip-changelog-auto'],
        files: ['.github/workflows/ci.yml'],
        expected: true,
      },
      {
        title: 'Update docs',
        files: ['.github/workflows/ci.yml'],
        expected: false,
      },
      {
        title: 'ci: empty',
        files: [],
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
        title: 'ci: update changelog helper',
        files: ['.github/workflows/update-changelog.yml'],
        expected: false,
      },
      {
        title: 'ci: update deploy pipeline',
        files: ['.github/workflows/deploy-app.yml'],
        expected: false,
      },
      {
        title: 'ci: bump sync action',
        files: ['.github/workflows/sync-labels.yml'],
        expected: false,
      },
      {
        title: 'ci: update prebuild pipeline',
        files: ['.github/workflows/prebuild.yml'],
        expected: false,
      },
      {
        title: 'ci: update package pipeline',
        files: ['.github/workflows/package-cli.yml'],
        expected: false,
      },
      {
        title: 'ci: update installer pipeline',
        files: ['.github/workflows/build-installer.yml'],
        expected: false,
      },
      {
        title: 'ci: update artifact upload',
        files: ['.github/workflows/upload-artifact.yml'],
        expected: false,
      },
      {
        title: 'ci: update image build',
        files: ['.github/scripts/build-image.mjs'],
        expected: false,
      },
      {
        title: 'ci: update cd pipeline',
        files: ['.github/workflows/cd-pages.yml'],
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

  it('rejects invalid pull request environment before invoking gh', () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-note-classifier-'));
    try {
      const marker = join(dir, 'gh-invoked');
      const gh = join(dir, 'gh');
      writeFileSync(
        gh,
        [
          '#!/usr/bin/env node',
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '1');`,
          'process.exit(1);',
        ].join('\n'),
      );
      chmodSync(gh, 0o755);

      for (const env of [
        { GITHUB_REPOSITORY: 'QwenLM/qwen-code/extra', PR_NUMBER: '1' },
        { GITHUB_REPOSITORY: 'QwenLM/qwen-code', PR_NUMBER: 'abc' },
      ]) {
        assert.throws(() =>
          execFileSync(
            process.execPath,
            [join(import.meta.dirname, 'classify-release-notes.mjs')],
            {
              env: {
                ...process.env,
                ...env,
                PATH: `${dir}:${process.env.PATH}`,
              },
            },
          ),
        );
        assert.equal(existsSync(marker), false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
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

  it('prints skip for internal CI changes through main', () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-note-classifier-'));
    try {
      const gh = join(dir, 'gh');
      writeFileSync(
        gh,
        [
          '#!/usr/bin/env node',
          'const args = process.argv.slice(2);',
          "if (args[0] === 'pr') { process.stdout.write(JSON.stringify({ title: 'ci: speed up checks', labels: [] })); process.exit(0); }",
          "if (args.includes('.[] | .filename, (.previous_filename // empty)')) { process.stdout.write('.github/workflows/ci.yml\\n'); process.exit(0); }",
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

      assert.equal(decision, 'skip\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('wires batch labeling and exclusion through release.yml', () => {
    const release = readFileSync(
      join(import.meta.dirname, '../workflows/release.yml'),
      'utf8',
    );
    const changelog = readFileSync(
      join(import.meta.dirname, '../release.yml'),
      'utf8',
    );

    assert.match(changelog, /- 'skip-changelog-auto'/);
    assert.match(release, /classify-release-notes\.mjs --batch/);
    assert.match(release, /Auto-label internal CI PRs/);
  });

  it('batch mode labels qualifying PRs from stdin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-note-classifier-'));
    try {
      const labeled = join(dir, 'labeled.txt');
      const gh = join(dir, 'gh');
      writeFileSync(
        gh,
        [
          '#!/usr/bin/env node',
          'const args = process.argv.slice(2);',
          "if (args[0] === 'api' && args.includes('.[] | .filename, (.previous_filename // empty)')) {",
          "  const num = args.find((a, i) => args[i-1] === 'pulls' || /^repos\\/.+\\/pulls\\/\\d+\\/files$/.test(a));",
          "  process.stdout.write('.github/workflows/ci.yml\\n');",
          '  process.exit(0);',
          '}',
          "if (args[0] === 'pr' && args[1] === 'edit') {",
          `  require('node:fs').appendFileSync(${JSON.stringify(labeled)}, args[2] + '\\n');`,
          '  process.exit(0);',
          '}',
          'process.exit(1);',
        ].join('\n'),
      );
      chmodSync(gh, 0o755);

      const input = JSON.stringify([
        { number: 10, title: 'ci: speed up checks', labels: [] },
        { number: 11, title: 'feat: new feature', labels: [] },
      ]);

      const output = execFileSync(
        process.execPath,
        [join(import.meta.dirname, 'classify-release-notes.mjs'), '--batch'],
        {
          encoding: 'utf8',
          input,
          env: {
            ...process.env,
            GITHUB_REPOSITORY: 'QwenLM/qwen-code',
            PATH: `${dir}:${process.env.PATH}`,
          },
        },
      );

      assert.match(output, /Labeled: 10/);
      assert.doesNotMatch(output, /11/);
      const labeledContent = readFileSync(labeled, 'utf8').trim();
      assert.equal(labeledContent, '10');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
