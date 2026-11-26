/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const script = resolve('.github/scripts/run-release-step.sh');
const directories = [];
afterEach(() =>
  directories
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);
const write = (root, path, data) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), data);
};

function fixture(changed = true) {
  const root = mkdtempSync(join(tmpdir(), 'release-handoff-'));
  directories.push(root);
  const producer = join(root, 'producer');
  const consumer = join(root, 'consumer');
  mkdirSync(producer);
  const git = (cwd, ...args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git(producer, 'init', '-b', 'main');
  git(producer, 'config', 'user.name', 'Test');
  git(producer, 'config', 'user.email', 'test@example.com');
  for (const path of [
    'package.json',
    'packages/audio-capture/package.json',
    'packages/channels/base/package.json',
    'integrations/example/package.json',
    'integrations/example/qwen-extension.json',
  ])
    write(producer, path, '{"version":"1.0.0"}');
  write(producer, 'pnpm-lock.yaml', 'lock');
  git(producer, 'add', '.');
  git(producer, 'commit', '-m', 'base');
  const base = git(producer, 'rev-parse', 'HEAD');
  git(root, 'clone', '--no-local', producer, consumer);
  git(producer, 'switch', '-c', 'release/v1.2.3');
  const env = {
    ...process.env,
    RUNNER_TEMP: root,
    GITHUB_OUTPUT: join(root, 'output'),
    RELEASE_TAG: 'v1.2.3',
    RELEASE_SHA: base,
    BRANCH_NAME: 'release/v1.2.3',
  };
  const step = (cwd, name, extra = {}) =>
    spawnSync('bash', [script, name], {
      cwd,
      env: { ...env, ...extra },
      encoding: 'utf8',
    });
  if (changed) {
    write(producer, 'package.json', '{"version":"1.2.3"}');
    const committed = step(producer, 'commit-release-branch');
    expect(committed.status, committed.stderr).toBe(0);
  }
  const commit = git(producer, 'rev-parse', 'HEAD');
  for (const path of [
    'dist/cli.js',
    'dist/review-sources.sha256',
    'dist/standalone/SHA256SUMS',
    'dist/vendor/rg',
    'packages/audio-capture/dist/index.js',
    'packages/web-templates/src/generated/template.js',
    'packages/audio-capture/prebuilds/linux-x64/audio.node',
  ])
    write(producer, path, 'built output');
  chmodSync(join(producer, 'dist/vendor/rg'), 0o755);
  const packed = step(producer, 'pack-release');
  expect(packed.status, packed.stderr).toBe(0);
  return {
    root,
    producer,
    consumer,
    base,
    commit,
    git,
    restore: (extra = {}) =>
      step(consumer, 'restore-release', { RELEASE_COMMIT: commit, ...extra }),
  };
}

describe.skipIf(process.platform === 'win32')(
  'isolated release build handoff',
  () => {
    it.each([true, false])(
      'preserves the exact commit and executable modes (version changed: %s)',
      (changed) => {
        const f = fixture(changed);
        const result = f.restore();
        expect(result.status, result.stderr).toBe(0);
        expect(f.git(f.consumer, 'rev-parse', 'HEAD')).toBe(f.commit);
        expect(f.git(f.consumer, 'branch', '--show-current')).toBe(
          'release/v1.2.3',
        );
        expect(statSync(join(f.consumer, 'dist/vendor/rg')).mode & 0o111).toBe(
          0o111,
        );
        expect(
          readFileSync(
            join(
              f.consumer,
              'packages/audio-capture/prebuilds/linux-x64/audio.node',
            ),
            'utf8',
          ),
        ).toBe('built output');
        expect(readFileSync(join(f.root, 'output'), 'utf8')).toContain(
          `release_commit=${f.commit}`,
        );
        expect(existsSync(join(f.consumer, 'node_modules'))).toBe(false);
      },
    );
    it('rejects a different expected commit', () => {
      const f = fixture();
      expect(f.restore({ RELEASE_COMMIT: 'a'.repeat(40) }).status).not.toBe(0);
    });
    it('rejects a version commit based on a different source', () => {
      const f = fixture();
      expect(f.restore({ RELEASE_SHA: 'b'.repeat(40) }).status).not.toBe(0);
    });
    it.each(['release-build.tgz', 'audio-prebuilds.tgz', 'version.bundle'])(
      'fails closed without %s',
      (path) => {
        const f = fixture();
        rmSync(join(f.root, 'release-publish-build', path));
        expect(f.restore().status).not.toBe(0);
      },
    );
  },
);

it('uses a job-specific SDK image and tests its immutable ID without pruning peers', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdk-image-'));
  directories.push(root);
  const step = parse(
    readFileSync('.github/workflows/release-sdk.yml', 'utf8'),
  ).jobs['build-sdk'].steps.find(
    (step) => step.name === 'Run SDK Integration Tests',
  );
  const commands = {
    npm: 'printf "%s\\n" "$*" >> "$TRACE"',
    docker: `if [ "$1" = image ]; then
      printf '%s\\n' "$*" >> "$TRACE"
      echo sha256:tested-image
    fi`,
    npx: 'printf "%s %s\\n" "$QWEN_SANDBOX" "$QWEN_SANDBOX_IMAGE" >> "$TRACE"',
    xargs: 'exit 0',
  };
  for (const [name, body] of Object.entries(commands)) {
    write(root, `bin/${name}`, `#!/bin/sh\n${body}\n`);
    chmodSync(join(root, 'bin', name), 0o755);
  }
  const trace = join(root, 'trace');
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${root}/bin:${process.env.PATH}`,
      TRACE: trace,
      RELEASE_CONTAINER_OWNER: '123-1-build-sdk',
    },
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(trace, 'utf8').trim().split('\n')).toEqual([
    'run test:integration:sdk:sandbox:none',
    'run build:sandbox -- --no-prune -i qwen-sdk-release:123-1-build-sdk',
    'image inspect --format {{.Id}} qwen-sdk-release:123-1-build-sdk',
    'docker sha256:tested-image',
  ]);
});
