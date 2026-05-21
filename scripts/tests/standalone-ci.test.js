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

const rootDir = path.resolve(import.meta.dirname, '../..');

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function makeGitRepo(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: dir,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.name', 'Test User'], {
    cwd: dir,
    stdio: 'ignore',
  });
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'test fixture'], {
    cwd: dir,
    stdio: 'ignore',
  });
}

describe('DataWorks standalone CI package', () => {
  it('includes a package scope declaring ESM for dist/cli.js', () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qwen-standalone-ci-'),
    );
    const workspaceDir = path.join(tmpDir, 'workspace');
    const sourceDir = path.join(tmpDir, 'source');
    const version = '0.15.10-beta.5';

    try {
      fs.mkdirSync(workspaceDir, { recursive: true });
      writeFile(path.join(workspaceDir, '.resolved_version'), `${version}\n`);
      writeFile(
        path.join(workspaceDir, '.build_time'),
        '2026-05-14T00:00:00Z\n',
      );
      writeFile(
        path.join(sourceDir, 'dist', 'cli.js'),
        'export {};\nconsole.log("qwen");\n',
      );
      makeGitRepo(sourceDir);

      execFileSync(
        'bash',
        [path.join(rootDir, '.aoneci/scripts/build-standalone-ci.sh')],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            ARCH: 'amd64',
            WORKSPACE_DIR: workspaceDir,
            SOURCE_DIR: sourceDir,
          },
        },
      );

      const packageJsonPath = path.join(
        workspaceDir,
        'build',
        'qwen-code',
        'package.json',
      );
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      expect(packageJson).toMatchObject({
        name: '@alife/dataworks-qwen-code',
        version,
        type: 'module',
      });

      const tarballList = execFileSync(
        'tar',
        [
          '-tzf',
          path.join(
            workspaceDir,
            'build',
            `qwen-code-${version}-linux-amd64.tar.gz`,
          ),
        ],
        { encoding: 'utf8' },
      );
      expect(tarballList).toContain('qwen-code/package.json');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
