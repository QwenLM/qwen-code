/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const generatorPath = path.join(repoRoot, '.fork', 'generate-patches.js');
const regenPath = path.join(repoRoot, 'scripts', 'regen-fork-patches.sh');

function runGit(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
}

function createDivergedRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-fork-patches-'));
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  runGit(cwd, ['init', '-b', 'main']);
  runGit(cwd, ['config', 'user.email', 'bot@example.com']);
  runGit(cwd, ['config', 'user.name', 'Test Bot']);

  fs.writeFileSync(path.join(cwd, 'src', 'feature.txt'), 'base\n');
  runGit(cwd, ['add', 'src/feature.txt']);
  runGit(cwd, ['commit', '-m', 'base']);
  const base = runGit(cwd, ['rev-parse', 'HEAD']);

  runGit(cwd, ['checkout', '-b', 'upstream-work']);
  fs.writeFileSync(
    path.join(cwd, 'src', 'feature.txt'),
    'base\nupstream-only\n',
  );
  runGit(cwd, ['commit', '-am', 'upstream change']);
  const upstream = runGit(cwd, ['rev-parse', 'HEAD']);
  runGit(cwd, ['update-ref', 'refs/remotes/upstream/main', upstream]);

  runGit(cwd, ['checkout', '-b', 'fork-work', base]);
  fs.writeFileSync(
    path.join(cwd, 'src', 'feature.txt'),
    'base\nfork-customization\n',
  );
  runGit(cwd, ['commit', '-am', 'fork change']);
  const fork = runGit(cwd, ['rev-parse', 'HEAD']);
  runGit(cwd, ['update-ref', 'refs/remotes/origin/main', fork]);

  fs.mkdirSync(path.join(cwd, '.fork', 'patches'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.fork', 'manifest.json'),
    `${JSON.stringify(
      {
        version: 1,
        upstream: { remote: 'https://example.com/upstream.git', branch: 'main' },
        patches: {
          directory: 'patches/',
          seriesFile: 'patches/series',
          definitions: [
            {
              file: '0001-fork-feature.patch',
              title: 'Fork feature',
              reason: 'Keep fork behavior',
              paths: ['src/feature.txt'],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );

  return { cwd, base };
}

describe('fork patch generation', () => {
  it('generates patch diffs from the fork/upstream merge-base', () => {
    const { cwd, base } = createDivergedRepo();

    const output = execFileSync('node', [generatorPath, '--write'], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    });

    const patch = fs.readFileSync(
      path.join(cwd, '.fork', 'patches', '0001-fork-feature.patch'),
      'utf8',
    );
    const series = fs.readFileSync(
      path.join(cwd, '.fork', 'patches', 'series'),
      'utf8',
    );

    expect(output).toContain(`patch_base: ${base.slice(0, 9)}`);
    expect(patch).toContain('Subject: Fork feature');
    expect(patch).toContain('+fork-customization');
    expect(patch).not.toContain('upstream-only');
    expect(series.trim()).toBe('0001-fork-feature.patch');
  });

  it('uses the merge-base range in the fork patch manifest snapshot', () => {
    const { cwd, base } = createDivergedRepo();
    fs.writeFileSync(
      path.join(cwd, '.fork', 'patches.md'),
      [
        '# Fork Patch Manifest',
        '',
        '<!-- AUTO:SNAPSHOT BEGIN -->',
        '<!-- AUTO:SNAPSHOT END -->',
        '<!-- AUTO:LANDING BEGIN -->',
        '<!-- AUTO:LANDING END -->',
        '<!-- AUTO:INVENTORY BEGIN -->',
        '<!-- AUTO:INVENTORY END -->',
        '',
      ].join('\n'),
    );

    execFileSync('bash', [regenPath, '--write'], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        FILE: '.fork/patches.md',
      },
    });

    const manifest = fs.readFileSync(path.join(cwd, '.fork', 'patches.md'), {
      encoding: 'utf8',
    });

    expect(manifest).toContain(`patch_base: \`${base.slice(0, 9)}\``);
    expect(manifest).toContain(`diff_range: \`${base.slice(0, 9)}..origin/main\``);
  });
});
