/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIO_SELECTION_MARGIN_MS,
  AUDIO_TARGETS,
  audioPrebuildKey,
  findAudioArtifact,
  validateAudioPrebuilds,
  verifyAudioArtifact,
} from '../../.github/scripts/audio-prebuilds.mjs';

const directories = [];
const temporary = () => {
  const path = mkdtempSync(join(tmpdir(), 'audio-prebuilds-'));
  directories.push(path);
  return path;
};
afterEach(() => {
  vi.restoreAllMocks();
  directories
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true }));
});
const write = (root, path, content) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};

describe('audio prebuild identity', () => {
  function fixture() {
    const root = temporary();
    const git = (...args) =>
      execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    for (const [path, content] of Object.entries({
      'package.json': '{"version":"1.0.0","packageManager":"pnpm@11.24.0"}',
      'packages/audio-capture/package.json':
        '{"name":"audio","version":"1.0.0","scripts":{"prebuildify":"prebuildify --napi"}}',
      'packages/audio-capture/native/audio.cc': 'native source',
      'packages/audio-capture/binding.gyp': 'binding',
      'packages/audio-capture/install.js': 'install',
      'pnpm-lock.yaml': 'locked dependencies',
      'pnpm-workspace.yaml': 'workspace settings',
      '.pnpmfile.mjs': 'dependency hook',
      '.npmrc': 'registry=https://registry.npmjs.org',
      '.github/workflows/audio-capture-prebuilds.yml': 'native workflow',
      '.github/scripts/audio-prebuilds.mjs': 'trusted helper',
    }))
      write(root, path, content);
    const commit = () => {
      git('add', '.');
      git('commit', '-m', 'fixture');
      return git('rev-parse', 'HEAD');
    };
    const ref = commit();
    return {
      root,
      git,
      ref,
      commit,
      key: () => audioPrebuildKey(root, 'HEAD', root),
    };
  }

  it('ignores release versions and uses the selected commit rather than dirty files', () => {
    const f = fixture();
    const key = f.key();
    write(
      f.root,
      'packages/audio-capture/package.json',
      '{"name":"audio","version":"2.0.0","scripts":{"prebuildify":"prebuildify --napi"}}',
    );
    write(
      f.root,
      'package.json',
      '{"version":"2.0.0","packageManager":"pnpm@11.24.0"}',
    );
    f.commit();
    expect(f.key()).toBe(key);
    write(f.root, 'packages/audio-capture/native/audio.cc', 'changed');
    expect(f.key()).toBe(key);
    f.commit();
    expect(f.key()).not.toBe(key);
    expect(audioPrebuildKey(f.root, f.ref, f.root)).toBe(key);
  });

  it.each([
    'packages/audio-capture/binding.gyp',
    'packages/audio-capture/install.js',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.pnpmfile.mjs',
    '.npmrc',
    '.github/workflows/audio-capture-prebuilds.yml',
    '.github/scripts/audio-prebuilds.mjs',
  ])('invalidates reuse for %s', (path) => {
    const f = fixture();
    const key = f.key();
    write(f.root, path, 'changed input');
    f.commit();
    expect(f.key()).not.toBe(key);
  });

  it('invalidates changed package scripts and package manager versions', () => {
    const f = fixture();
    const key = f.key();
    write(
      f.root,
      'packages/audio-capture/package.json',
      '{"name":"audio","version":"1.0.0","scripts":{"prebuildify":"different"}}',
    );
    f.commit();
    const changedScript = f.key();
    expect(changedScript).not.toBe(key);
    write(f.root, 'package.json', '{"packageManager":"pnpm@12.0.0"}');
    f.commit();
    expect(f.key()).not.toBe(changedScript);
  });

  it('fingerprints the workflow checkout separately from the release ref', () => {
    const f = fixture();
    const workflowRoot = temporary();
    write(workflowRoot, '.github/scripts/audio-prebuilds.mjs', 'trusted helper');
    const path = '.github/workflows/audio-capture-prebuilds.yml';
    write(workflowRoot, path, 'workflow at dispatch');
    const key = audioPrebuildKey(f.root, f.ref, workflowRoot);
    write(f.root, path, 'unrelated release checkout edit');
    expect(audioPrebuildKey(f.root, f.ref, workflowRoot)).toBe(key);
    write(workflowRoot, path, 'updated native toolchain');
    expect(audioPrebuildKey(f.root, f.ref, workflowRoot)).not.toBe(key);
  });

  it('does not reuse refs without a native dependency lock', () => {
    const f = fixture();
    f.git('rm', 'pnpm-lock.yaml');
    f.commit();
    expect(f.key()).toBe('');
  });

  it('fingerprints large native headers without a child-process buffer limit', () => {
    const f = fixture();
    const path = 'packages/audio-capture/native/miniaudio.h';
    write(f.root, path, 'x'.repeat(4 * 1024 * 1024));
    f.commit();
    const key = f.key();
    write(f.root, path, 'y'.repeat(4 * 1024 * 1024));
    f.commit();
    expect(f.key()).not.toBe(key);
  });
});

describe('audio prebuild payload', () => {
  const targets = [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-x64',
    'win32-x64',
  ];
  const fixture = () => {
    const root = temporary();
    for (const target of targets)
      write(root, `${target}/audio.node`, 'native binary');
    return root;
  };
  it('accepts all five nonempty targets', () => {
    expect(AUDIO_TARGETS).toEqual(targets);
    expect(() => validateAudioPrebuilds(fixture())).not.toThrow();
  });
  it.each(AUDIO_TARGETS)('rejects missing %s', (target) => {
    const root = fixture();
    rmSync(join(root, target), { recursive: true });
    expect(() => validateAudioPrebuilds(root)).toThrow();
  });
  it.each(['empty', 'extra', 'symlink'])('rejects %s binaries', (kind) => {
    const root = fixture();
    if (kind === 'empty') write(root, 'linux-x64/audio.node', '');
    if (kind === 'extra') write(root, 'linux-x64/unexpected.js', 'code');
    if (kind === 'symlink') {
      rmSync(join(root, 'linux-x64/audio.node'));
      symlinkSync(
        join(root, 'linux-arm64/audio.node'),
        join(root, 'linux-x64/audio.node'),
      );
    }
    expect(() => validateAudioPrebuilds(root)).toThrow();
  });
  it('rejects symlinked platform directories', () => {
    const root = fixture();
    rmSync(join(root, 'linux-x64'), { recursive: true });
    symlinkSync(join(root, 'linux-arm64'), join(root, 'linux-x64'), 'junction');
    expect(() => validateAudioPrebuilds(root)).toThrow();
  });
});

describe('audio artifact provenance', () => {
  const repo = { owner: 'QwenLM', repo: 'qwen-code' };
  const fixture = () => {
    const artifact = {
      id: 12,
      name: 'audio-capture-prebuilds-key',
      expired: false,
      expires_at: '2100-01-01T00:00:00Z',
      workflow_run: {
        id: 34,
        head_branch: 'main',
        repository_id: 1,
        head_repository_id: 1,
      },
    };
    const run = {
      id: 34,
      status: 'completed',
      conclusion: 'success',
      head_branch: 'main',
      path: '.github/workflows/release.yml',
      event: 'workflow_dispatch',
      repository: { full_name: 'QwenLM/qwen-code' },
      head_repository: { full_name: 'QwenLM/qwen-code' },
    };
    const github = {
      rest: {
        actions: {
          getWorkflowRun: vi.fn(async () => ({ data: run })),
          listArtifactsForRepo: vi.fn(async () => ({
            data: { artifacts: [artifact] },
          })),
        },
      },
    };
    return { artifact, run, github };
  };
  it.each(['workflow_dispatch', 'schedule'])(
    'selects an immutable artifact ID from a successful main %s release',
    async (event) => {
      const f = fixture();
      f.run.event = event;
      await expect(
        findAudioArtifact(f.github, repo, 'key', vi.fn()),
      ).resolves.toEqual({ artifact_id: 12, run_id: 34 });
    },
  );
  it.each([
    ['expired', true],
    ['expires_at', 'invalid'],
    ['expires_at', new Date(Date.now() - 1000).toISOString()],
    ['name', 'other'],
  ])('rejects artifact %s=%s', async (field, value) => {
    const f = fixture();
    f.artifact[field] = value;
    await expect(
      verifyAudioArtifact(f.github, repo, f.artifact, 'key'),
    ).rejects.toThrow();
  });
  it('requires selection headroom but consumes any unexpired artifact', async () => {
    const f = fixture();
    const now = Date.parse('2026-10-29T00:00:00Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(AUDIO_SELECTION_MARGIN_MS).toBe(48 * 60 * 60 * 1000);
    // Just over the selection margin: chosen by prepare, then consumed later.
    f.artifact.expires_at = new Date(
      now + AUDIO_SELECTION_MARGIN_MS + 60_000,
    ).toISOString();
    await expect(
      verifyAudioArtifact(
        f.github,
        repo,
        f.artifact,
        'key',
        now,
        AUDIO_SELECTION_MARGIN_MS,
      ),
    ).resolves.toEqual({ artifact_id: 12, run_id: 34 });
    await expect(
      findAudioArtifact(f.github, repo, 'key', vi.fn()),
    ).resolves.toEqual({ artifact_id: 12, run_id: 34 });
    // The downstream consumers re-verify after the release has already
    // committed to reuse and skipped the fresh build, so they must not
    // re-apply the margin: the same artifact still has ~48h left.
    await expect(
      verifyAudioArtifact(f.github, repo, f.artifact, 'key', now + 120_000),
    ).resolves.toEqual({ artifact_id: 12, run_id: 34 });
    // Too thin to survive the release: never selected in the first place.
    f.artifact.expires_at = new Date(now + 60_000).toISOString();
    await expect(
      verifyAudioArtifact(
        f.github,
        repo,
        f.artifact,
        'key',
        now,
        AUDIO_SELECTION_MARGIN_MS,
      ),
    ).rejects.toThrow();
    await expect(
      findAudioArtifact(f.github, repo, 'key', vi.fn()),
    ).resolves.toBeUndefined();
  });
  it.each([
    ['conclusion', 'failure'],
    ['status', 'in_progress'],
    ['head_branch', 'feature'],
    ['path', '.github/workflows/ci.yml'],
    ['event', 'pull_request'],
    ['head_repository', { full_name: 'attacker/fork' }],
  ])('rejects producer %s', async (field, value) => {
    const f = fixture();
    f.run[field] = value;
    await expect(
      verifyAudioArtifact(f.github, repo, f.artifact, 'key'),
    ).rejects.toThrow();
  });
  it('rejects a fork artifact before requesting its run', async () => {
    const f = fixture();
    f.artifact.workflow_run.head_repository_id = 2;
    await expect(
      verifyAudioArtifact(f.github, repo, f.artifact, 'key'),
    ).rejects.toThrow();
    expect(f.github.rest.actions.getWorkflowRun).not.toHaveBeenCalled();
  });
  it('falls back on API failure and skips rejected candidates', async () => {
    const f = fixture();
    const warn = vi.fn();
    f.github.rest.actions.listArtifactsForRepo.mockRejectedValueOnce(
      new Error('offline'),
    );
    await expect(
      findAudioArtifact(f.github, repo, 'key', warn),
    ).resolves.toBeUndefined();
    f.github.rest.actions.listArtifactsForRepo.mockResolvedValueOnce({
      data: { artifacts: [{ ...f.artifact, id: 13, expired: true }, f.artifact] },
    });
    await expect(
      findAudioArtifact(f.github, repo, 'key', warn),
    ).resolves.toEqual({ artifact_id: 12, run_id: 34 });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
