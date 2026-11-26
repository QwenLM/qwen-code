/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  lstat,
  rm,
  rename,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createNativeInstallation } from './nativeInstallationService.js';
import { downloadFile } from './update/manifest.js';

const mocks = vi.hoisted(() => ({ entry: '', busy: false }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    symlink: vi.fn(async () => {
      throw Object.assign(new Error('no symlink privilege'), { code: 'EPERM' });
    }),
    rename: vi.fn(fs.rename),
    unlink: vi.fn(async (path: string) => {
      if (path === mocks.entry && mocks.busy) {
        mocks.busy = false;
        throw Object.assign(new Error('running executable'), { code: 'EPERM' });
      }
      return fs.unlink(path);
    }),
  };
});
vi.mock('./update/manifest.js', async (original) => ({
  ...(await original<typeof import('./update/manifest.js')>()),
  downloadFile: vi.fn(),
}));

const platform = process.platform;
let directory: string;
const payload = 'verified next executable';
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'qwen-windows-service-'));
  mocks.entry = join(directory, 'qwen.exe');
  mocks.busy = false;
  await writeFile(mocks.entry, 'active executable');
  await writeFile(join(directory, '.qwen-install-resource'), 'curl-bash\n');
  vi.mocked(downloadFile).mockImplementation(async (_url, destination) => {
    await writeFile(destination, payload);
  });
  Object.defineProperty(process, 'platform', { value: 'win32' });
});
afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: platform });
  await rm(directory, { recursive: true, force: true });
  vi.clearAllMocks();
});

function service(version = '1.0.1', archive?: { url: string; sha256: string }) {
  return createNativeInstallation({
    paths: { binaryName: 'qwen', binDir: directory, linkPath: mocks.entry },
    keepVersions: 3,
    policy: {
      allows: () => true,
      resolve: async () => ({
        version,
        reuseLocal: true,
        getArtifact: async () => ({
          os: 'windows',
          arch: 'x64',
          url: archive?.url ?? 'https://fixture.test/qwen.bin',
          sha256:
            archive?.sha256 ??
            createHash('sha256').update(payload).digest('hex'),
        }),
      }),
    },
  });
}

it('updates a running Windows entry by renaming the busy file and falling back to a copy', async () => {
  mocks.busy = true;
  await service().update();
  expect(await readFile(mocks.entry, 'utf8')).toBe(payload);
  expect((await lstat(mocks.entry)).isSymbolicLink()).toBe(false);
  expect(await readFile(join(directory, 'qwen-1.0.1.exe'), 'utf8')).toBe(
    payload,
  );
  expect(
    vi
      .mocked(rename)
      .mock.calls.some(
        ([from, to]) =>
          from === mocks.entry && String(to).startsWith(`${mocks.entry}.old.`),
      ),
  ).toBe(true);
  expect(
    await readFile(join(directory, '.qwen-install-resource'), 'utf8'),
  ).toBe('curl-bash\n');
});

it('rolls back to a local .exe without a download or rewriting the existing version file', async () => {
  await writeFile(join(directory, 'qwen-1.0.0.exe'), 'previous executable');
  await writeFile(join(directory, 'version.txt'), '1.0.1\n');
  await expect(service('1.0.0').rollback()).resolves.toMatchObject({
    reused: true,
  });
  expect(await readFile(mocks.entry, 'utf8')).toBe('previous executable');
  expect(downloadFile).not.toHaveBeenCalled();
  expect(await readFile(join(directory, 'version.txt'), 'utf8')).toBe(
    '1.0.1\n',
  );
});

it('keeps the active Windows entry when the downloaded payload fails checksum verification', async () => {
  vi.mocked(downloadFile).mockImplementationOnce(async (_url, destination) => {
    await writeFile(destination, 'corrupted');
  });
  await expect(service().update()).rejects.toThrow('SHA256 mismatch');
  expect(await readFile(mocks.entry, 'utf8')).toBe('active executable');
});

it('extracts a real Windows ZIP through the shared Windows archive path', async () => {
  const source = join(directory, 'zip-payload');
  await mkdir(source);
  await writeFile(join(source, 'qwen.exe'), payload);
  const archivePath = join(directory, 'fixture.zip');
  // Only the archive tool runs on the actual host; native service selection is Windows.
  Object.defineProperty(process, 'platform', { value: platform });
  execFileSync('zip', ['-jq', archivePath, join(source, 'qwen.exe')]);
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const bytes = await readFile(archivePath);
  vi.mocked(downloadFile).mockImplementationOnce(async (_url, destination) => {
    await writeFile(destination, bytes);
  });
  await service('1.0.1', {
    url: 'https://fixture.test/qwen-windows-x64.zip',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }).update();
  expect(await readFile(mocks.entry, 'utf8')).toBe(payload);
});
