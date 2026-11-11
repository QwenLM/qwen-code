/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createQwenReleasePolicy, qwenVersion } from './releasePolicy.js';
import {
  fetchManifest,
  fetchVersionManifest,
  pickFile,
} from '../update/manifest.js';
import { detectMusl } from '../install/systemInfo.js';
vi.mock('../install/systemInfo.js', () => ({ detectMusl: vi.fn(() => false) }));
vi.mock('../update/manifest.js', () => ({
  fetchManifest: vi.fn(),
  fetchVersionManifest: vi.fn(),
  pickFile: vi.fn(),
}));
const file = {
  os: 'darwin',
  arch: 'arm64',
  runtime: 'bun' as const,
  sha256: 'a'.repeat(64),
  url: 'https://example.test/qwen.tar.gz',
};
const manifest = { latest: '1.0.1', published_at: '', files: [file] };
const originalPlatform = process.platform;
const originalArch = process.arch;
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  Object.defineProperty(process, 'arch', { value: 'arm64' });
  vi.clearAllMocks();
  vi.mocked(detectMusl).mockReturnValue(false);
  vi.mocked(fetchManifest).mockResolvedValue(manifest);
  vi.mocked(fetchVersionManifest).mockResolvedValue(manifest);
  vi.mocked(pickFile).mockImplementation((files) => files[0] ?? null);
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  Object.defineProperty(process, 'arch', { value: originalArch });
});
describe('Qwen release policy', () => {
  it.each(['x64', 'arm64'])(
    'selects the Windows %s ZIP using the common selector',
    async (arch) => {
      const { pickFileForPlatform } = await vi.importActual<
        typeof import('../update/manifest.js')
      >('../update/manifest.js');
      const windows = ['x64', 'arm64'].map((arch) => ({
        ...file,
        os: 'windows',
        arch,
        min_windows_build: 17763,
        url: `https://example.test/qwen-windows-${arch}.zip`,
      }));
      vi.mocked(fetchManifest).mockResolvedValue({
        ...manifest,
        files: [file, ...windows],
      });
      vi.mocked(pickFile).mockImplementation((files) =>
        pickFileForPlatform(files, 'win32', arch, 19045),
      );
      const selected = await createQwenReleasePolicy({
        baseURL: 'https://example.test',
      }).resolve('update');
      await expect(selected.getArtifact()).resolves.toMatchObject({
        os: 'windows',
        arch,
        runtime: 'bun',
      });
    },
  );
  it('does not select the unsupported legacy Windows line', async () => {
    const { pickFileForPlatform } = await vi.importActual<
      typeof import('../update/manifest.js')
    >('../update/manifest.js');
    const windows = {
      ...file,
      os: 'windows',
      arch: 'x64',
      min_windows_build: 17763,
      url: 'https://example.test/qwen.zip',
    };
    vi.mocked(fetchManifest).mockResolvedValue({
      ...manifest,
      files: [windows],
    });
    vi.mocked(pickFile).mockImplementation((files) =>
      pickFileForPlatform(files, 'win32', 'x64', 14393),
    );
    await expect(
      createQwenReleasePolicy({ baseURL: 'https://example.test' }).resolve(
        'install',
      ),
    ).rejects.toThrow('no Qwen binary');
  });
  it.each([
    '1.0.0-01',
    '1.0.0 ',
    '1.0.0?query',
    '../1.0.0',
    'garbage',
  ])('rejects invalid version %s', (version) => {
    expect(() => qwenVersion(version)).toThrow();
  });
  it.each(['0.26.9', '1.2.3', '2.0.0-beta.1+build.7'])(
    'normalizes a valid version %s',
    (version) => expect(qwenVersion(`v${version}`)).toBe(version),
  );
  it('resolves prereleases from the configured source for every operation', async () => {
    const version = '1.0.0-nightly.20261104.12345.gabcdef123456';
    vi.mocked(fetchVersionManifest).mockResolvedValue({
      ...manifest,
      latest: version,
    });
    const policy = createQwenReleasePolicy({
      baseURL: 'https://example.test',
      version,
    });
    for (const operation of ['install', 'update', 'rollback'] as const) {
      expect(policy.allows(version, operation)).toBe(true);
      expect((await policy.resolve(operation)).version).toBe(version);
    }
    expect(fetchVersionManifest).toHaveBeenCalledWith(
      'https://example.test',
      version,
    );
  });
  it.each([
    ['x64', false, 'x64'],
    ['x64', true, 'x64-musl'],
    ['arm64', false, 'arm64'],
    ['arm64', true, 'arm64-musl'],
  ] as const)(
    'selects Linux %s with musl=%s as %s regardless of a legacy baseline entry',
    async (arch, musl, expected) => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      Object.defineProperty(process, 'arch', { value: arch });
      vi.mocked(detectMusl).mockReturnValue(musl);
      const linux = ['x64-baseline', 'x64', 'x64-musl', 'arm64', 'arm64-musl']
        .map((arch) => ({ ...file, os: 'linux', arch }));
      vi.mocked(fetchManifest).mockResolvedValue({
        ...manifest,
        files: [file, ...linux],
      });
      const selected = await createQwenReleasePolicy({
        baseURL: 'https://example.test',
      }).resolve('update');
      await expect(selected.getArtifact()).resolves.toMatchObject({
        os: 'linux',
        arch: expected,
      });
      expect(pickFile).not.toHaveBeenCalled();
    },
  );
  it('does not query the network to select a local rollback', async () => {
    const policy = createQwenReleasePolicy({
      baseURL: 'https://example.test',
      version: '0.26.9',
    });
    vi.mocked(fetchVersionManifest).mockResolvedValue({
      ...manifest,
      latest: '0.26.9',
    });
    const selected = await policy.resolve('rollback');
    expect(fetchVersionManifest).not.toHaveBeenCalled();
    expect(fetchManifest).not.toHaveBeenCalled();
    await expect(selected.getArtifact()).resolves.toEqual(file);
    expect(fetchVersionManifest).toHaveBeenCalledWith(
      'https://example.test',
      '0.26.9',
    );
    expect(policy.allows('0.26.9', 'rollback')).toBe(true);
  });
  it('limits implicit rollback to an earlier 1.x version in the same channel', async () => {
    const policy = createQwenReleasePolicy({ baseURL: 'https://example.test' });
    await expect(
      policy.resolve('rollback', {
        fromVersion: '1.0.0-alpha.1',
        toVersion: '1.0.0',
      }),
    ).resolves.toMatchObject({ version: '1.0.0-alpha.1' });
    for (const fromVersion of [
      '0.26.9',
      '1.0.0-nightly.20261109.123.gabcdef123456',
    ]) {
      await expect(
        policy.resolve('rollback', {
          fromVersion,
          toVersion: '1.0.0',
        }),
      ).rejects.toThrow('--to');
    }
    expect(fetchVersionManifest).not.toHaveBeenCalled();
  });
  it('uses manifests, not npm, and disables reuse for force install', async () => {
    const policy = createQwenReleasePolicy({
      baseURL: 'https://example.test',
      force: true,
    });
    const selected = await policy.resolve('install');
    expect(selected.version).toBe('1.0.1');
    expect(selected.reuseLocal).toBe(false);
    expect(fetchManifest).toHaveBeenCalledOnce();
  });
  it('rejects a malformed version in the latest manifest', async () => {
    vi.mocked(fetchManifest).mockResolvedValue({
      ...manifest,
      latest: '../1.0.0',
    });
    await expect(
      createQwenReleasePolicy({ baseURL: 'https://example.test' }).resolve(
        'update',
      ),
    ).rejects.toThrow('Invalid Qwen version');
  });
  it.each([
    { ...file, sha256: '' },
    { ...file, runtime: 'node-sea' as const },
    { ...file, url: 'http://example.test/qwen.tar.gz' },
    { ...file, url: 'file:///tmp/qwen' },
  ])('rejects invalid release metadata', async (invalid) => {
    vi.mocked(fetchManifest).mockResolvedValue({
      ...manifest,
      files: [invalid],
    });
    await expect(
      createQwenReleasePolicy({ baseURL: 'https://example.test' }).resolve(
        'update',
      ),
    ).rejects.toThrow('metadata');
  });
});
