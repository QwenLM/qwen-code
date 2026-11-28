/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createNativeInstallation,
  type NativeEvent,
  type NativeReleaseSelection,
  type ReleasePolicy,
} from './nativeInstallationService.js';
import { downloadFile } from './update/manifest.js';

vi.mock('./update/manifest.js', async (original) => ({
  ...(await original<typeof import('./update/manifest.js')>()),
  downloadFile: vi.fn(),
}));

let directory: string;
const payload = 'new binary fixture';
const suffix = process.platform === 'win32' ? '.exe' : '';
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'native-installation-'));
  vi.mocked(downloadFile).mockImplementation(async (_url, destination) => {
    await writeFile(destination, payload);
  });
});
afterEach(async () => {
  for (const [, path] of vi.mocked(downloadFile).mock.calls) {
    await rm(path, { force: true });
    await rm(path.replace(/\.bin$/, '') + '-extract', {
      recursive: true,
      force: true,
    });
  }
  vi.clearAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function fixture(
  overrides: Partial<NativeReleaseSelection> = {},
  allows = true,
) {
  const events: NativeEvent[] = [];
  const getArtifact = vi.fn(async () => ({
    os: 'darwin',
    arch: 'arm64',
    url: 'https://example.invalid/fixture.bin',
    sha256: createHash('sha256').update(payload).digest('hex'),
  }));
  const selection: NativeReleaseSelection = {
    version: '1.2.3',
    getArtifact,
    reuseLocal: true,
    ...overrides,
  };
  const policy = {
    resolve: vi.fn<ReleasePolicy['resolve']>(
      async (_operation, previous) => ({
        ...selection,
        version: previous?.fromVersion ?? selection.version,
      }),
    ),
    allows: vi.fn(() => allows),
  };
  const paths = {
    binaryName: 'qwen',
    binDir: join(directory, 'versions'),
    linkPath: join(directory, 'entry', `qwen${suffix}`),
  };
  return {
    paths,
    policy,
    events,
    getArtifact,
    service: createNativeInstallation({
      paths,
      policy,
      keepVersions: 3,
      events: (event) => events.push(event),
    }),
  };
}

describe('native installation execution', () => {
  it('downloads, verifies and activates without any product runtime', async () => {
    const f = fixture();
    expect(await f.service.update()).toMatchObject({
      version: '1.2.3',
      reused: false,
    });
    expect(await readFile(f.paths.linkPath, 'utf8')).toBe(payload);
    expect(await readFile(join(f.paths.binDir, 'version.txt'), 'utf8')).toBe(
      '1.2.3\n',
    );
    expect(f.events.map((e) => `${e.stage}:${e.phase}`)).toContain(
      'checksum:success',
    );
    expect(f.policy.resolve).toHaveBeenCalledOnce();
  });

  it('reuses a local rollback offline without querying an artifact or writing a new version pointer', async () => {
    const f = fixture();
    await mkdir(f.paths.binDir, { recursive: true });
    await writeFile(join(f.paths.binDir, `qwen-1.2.3${suffix}`), payload);
    expect(await f.service.rollback()).toMatchObject({ reused: true });
    expect(await readFile(f.paths.linkPath, 'utf8')).toBe(payload);
    expect(f.getArtifact).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
    await expect(
      readFile(join(f.paths.binDir, 'version.txt')),
    ).rejects.toThrow();
  });

  it('rejects an out-of-line target before local reuse or download', async () => {
    const f = fixture({ version: '0.2.6' }, false);
    await mkdir(f.paths.binDir, { recursive: true });
    await writeFile(join(f.paths.binDir, `qwen-0.2.6${suffix}`), 'old line');
    await expect(f.service.rollback()).rejects.toThrow(
      'outside the product version line',
    );
    expect(f.getArtifact).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('does not activate a bad checksum', async () => {
    const f = fixture();
    vi.mocked(downloadFile).mockImplementationOnce(async (_url, path) => {
      await writeFile(path, 'corrupt');
    });
    await expect(f.service.update()).rejects.toThrow('SHA256 mismatch');
    await expect(readFile(f.paths.linkPath)).rejects.toThrow();
    expect(
      f.events.some((e) => e.stage === 'checksum' && e.phase === 'failure'),
    ).toBe(true);
  });

  it('awaits renewal and necessary recording, and blocks activation after withdrawal', async () => {
    let authorized = true;
    const guard = {
      assertIdentity: vi.fn(),
      assertAuthorized: vi.fn(() => {
        if (!authorized) throw new Error('withdrawn');
      }),
      renewBeforeInstall: vi.fn(async () => {}),
    };
    const record = {
      beforeActivate: vi.fn(async () => {
        authorized = false;
      }),
    };
    const f = fixture({ reuseLocal: false, guard, record });
    await expect(f.service.update()).rejects.toThrow('withdrawn');
    expect(guard.renewBeforeInstall).toHaveBeenCalledOnce();
    expect(record.beforeActivate).toHaveBeenCalledOnce();
    await expect(readFile(f.paths.linkPath)).rejects.toThrow();
    expect(
      await readFile(join(f.paths.binDir, `qwen-1.2.3${suffix}`), 'utf8'),
    ).toBe(payload);
  });
});

describe('installation and rollback contracts', () => {
  it.skipIf(process.platform === 'win32').each([true, false])(
    'preserves the previous version on a same-version update (reuseLocal=%s)',
    async (reuseLocal) => {
      const f = fixture();
      await mkdir(f.paths.binDir, { recursive: true });
      await mkdir(join(directory, 'entry'));
      const previous = join(f.paths.binDir, 'qwen-1.0.0');
      await writeFile(previous, 'previous active');
      for (const version of ['1.0.1', '1.0.2', '1.0.3'])
        await writeFile(join(f.paths.binDir, `qwen-${version}`), 'cached only');
      await symlink(previous, f.paths.linkPath);
      await f.service.update();

      const retry = fixture({ reuseLocal });
      await retry.service.update();
      f.getArtifact.mockClear();
      await expect(
        f.service.rollback({ previous: true }),
      ).resolves.toMatchObject({ version: '1.0.0', reused: true });
      expect(await readFile(f.paths.linkPath, 'utf8')).toBe('previous active');
      expect(f.getArtifact).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform === 'win32').each(['symlink', 'copy'])(
    'rolls back offline to the prior active %s, preserving it during cleanup',
    async (entry) => {
      const f = fixture();
      await mkdir(f.paths.binDir, { recursive: true });
      await mkdir(join(directory, 'entry'));
      const previous = join(f.paths.binDir, 'qwen-1.0.0');
      await writeFile(previous, 'previous active');
      for (const version of ['1.0.1', '1.0.2', '1.0.3'])
        await writeFile(join(f.paths.binDir, `qwen-${version}`), 'cached only');
      if (entry === 'symlink') {
        await symlink(previous, f.paths.linkPath);
      } else {
        await writeFile(f.paths.linkPath, '#!/bin/sh\necho 1.0.0\n', {
          mode: 0o755,
        });
      }

      await expect(f.service.rollback({ previous: true })).rejects.toThrow('--to');
      expect(f.getArtifact).not.toHaveBeenCalled();
      await f.service.update();
      let authorized = true;
      const failed = fixture({
        version: '1.3.0',
        reuseLocal: false,
        guard: {
          assertIdentity: () => {},
          assertAuthorized: () => {
            if (!authorized) throw new Error('withdrawn');
          },
          renewBeforeInstall: async () => {},
        },
        record: {
          beforeActivate: async () => {
            authorized = false;
          },
        },
      });
      await expect(failed.service.update()).rejects.toThrow('withdrawn');
      f.getArtifact.mockClear();
      await expect(f.service.rollback({ previous: true })).resolves.toMatchObject({
        version: '1.0.0',
        reused: true,
      });
      expect(await readFile(f.paths.linkPath, 'utf8')).toBe('previous active');
      expect(f.getArtifact).not.toHaveBeenCalled();
      await expect(f.service.rollback({ previous: true })).rejects.toThrow('--to');
    },
  );

  it.skipIf(process.platform === 'win32').each(['entry changed', 'target missing'])(
    'does not use a rollback record when the %s',
    async (scenario) => {
      const f = fixture();
      await mkdir(f.paths.binDir, { recursive: true });
      await mkdir(join(directory, 'entry'));
      const previous = join(f.paths.binDir, 'qwen-1.0.0');
      await writeFile(previous, 'previous active');
      await symlink(previous, f.paths.linkPath);
      await f.service.update();
      if (scenario === 'entry changed') {
        await rm(f.paths.linkPath);
        await symlink(previous, f.paths.linkPath);
      } else {
        await rm(previous);
      }
      f.getArtifact.mockClear();

      await expect(f.service.rollback({ previous: true })).rejects.toThrow('--to');
      expect(f.getArtifact).not.toHaveBeenCalled();
    },
  );

  it('installs a matching bootstrap without fetching an archive, and defers version cleanup', async () => {
    const f = fixture();
    const bootstrap = join(directory, 'bootstrap');
    await writeFile(bootstrap, payload);
    await mkdir(f.paths.binDir, { recursive: true });
    for (const version of ['1.0.0', '1.0.1', '1.0.2', '1.0.3'])
      await writeFile(
        join(f.paths.binDir, `qwen-${version}${suffix}`),
        'previous',
      );
    const result = await f.service.install({
      sourceMarker: 'curl-bash',
      bootstrap: async () => ({ version: '1.2.3', binaryPath: bootstrap }),
    });
    expect(result.reused).toBe(false);
    expect(await readFile(f.paths.linkPath, 'utf8')).toBe(payload);
    expect(await readFile(bootstrap, 'utf8')).toBe(payload);
    expect(
      await readFile(join(f.paths.binDir, '.qwen-install-resource'), 'utf8'),
    ).toBe('curl-bash\n');
    expect(f.getArtifact).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
    expect(
      await readFile(join(f.paths.binDir, `qwen-1.0.0${suffix}`), 'utf8'),
    ).toBe('previous');
    await f.service.cleanup(result.version);
    await expect(
      readFile(join(f.paths.binDir, `qwen-1.0.0${suffix}`)),
    ).rejects.toThrow();
    expect(await readFile(f.paths.linkPath, 'utf8')).toBe(payload);
    const stages = f.events
      .filter((e) => e.phase === 'success')
      .map((e) => e.stage);
    expect(stages.indexOf('marker')).toBeLessThan(stages.indexOf('link'));
  });

  it('repairs a cached install without evaluating bootstrap, replacing the marker or downloading', async () => {
    const f = fixture();
    await mkdir(f.paths.binDir, { recursive: true });
    await writeFile(join(f.paths.binDir, `qwen-1.2.3${suffix}`), payload);
    await writeFile(
      join(f.paths.binDir, '.qwen-install-resource'),
      'existing-source\n',
    );
    const bootstrap = vi.fn(async () => {
      throw new Error('must not evaluate bootstrap');
    });
    expect(
      await f.service.install({ sourceMarker: 'curl-bash', bootstrap }),
    ).toMatchObject({ reused: true });
    expect(bootstrap).not.toHaveBeenCalled();
    expect(f.getArtifact).not.toHaveBeenCalled();
    expect(
      await readFile(join(f.paths.binDir, '.qwen-install-resource'), 'utf8'),
    ).toBe('existing-source\n');
    expect(await readFile(join(f.paths.binDir, 'version.txt'), 'utf8')).toBe(
      '1.2.3\n',
    );
  });

  it('downloads when the bootstrap version differs from the selected target', async () => {
    const f = fixture();
    await f.service.install({
      sourceMarker: 'curl-bash',
      bootstrap: async () => ({
        version: '1.2.2',
        binaryPath: '/unused-bootstrap',
      }),
    });
    expect(f.getArtifact).toHaveBeenCalledOnce();
    expect(downloadFile).toHaveBeenCalledOnce();
    expect(await readFile(f.paths.linkPath, 'utf8')).toBe(payload);
  });

  it('supports forced bootstrap placement and does not copy a running binary onto itself', async () => {
    const f = fixture({ reuseLocal: false });
    await mkdir(f.paths.binDir, { recursive: true });
    const binaryPath = join(f.paths.binDir, `qwen-1.2.3${suffix}`);
    await writeFile(binaryPath, payload);
    const before = await import('node:fs/promises').then((fs) =>
      fs.stat(binaryPath),
    );
    await f.service.install({
      sourceMarker: 'curl-bash',
      bootstrap: async () => ({ version: '1.2.3', binaryPath }),
    });
    const after = await import('node:fs/promises').then((fs) =>
      fs.stat(binaryPath),
    );
    expect(after.ino).toBe(before.ino);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(await readFile(f.paths.linkPath, 'utf8')).toBe(payload);
  });

  it('rolls back to an alternate local filename offline without changing the update pointer or marker', async () => {
    const f = fixture();
    await mkdir(f.paths.binDir, { recursive: true });
    await writeFile(join(f.paths.binDir, 'qwen-1.2.3.bin'), payload);
    await writeFile(join(f.paths.binDir, 'version.txt'), '1.5.0\n');
    await writeFile(
      join(f.paths.binDir, '.qwen-install-resource'),
      'curl-bash\n',
    );
    expect(await f.service.rollback()).toMatchObject({
      reused: true,
      binaryPath: join(f.paths.binDir, 'qwen-1.2.3.bin'),
    });
    expect(f.getArtifact).not.toHaveBeenCalled();
    expect(await readFile(join(f.paths.binDir, 'version.txt'), 'utf8')).toBe(
      '1.5.0\n',
    );
    expect(
      await readFile(join(f.paths.binDir, '.qwen-install-resource'), 'utf8'),
    ).toBe('curl-bash\n');
  });

  it('does not activate an offline rollback when its required record fails', async () => {
    const record = vi.fn(async () => { throw new Error('record unavailable'); });
    const f = fixture({ record: { beforeActivate: record } });
    await mkdir(f.paths.binDir, { recursive: true });
    await mkdir(join(directory, 'entry'), { recursive: true });
    await writeFile(join(f.paths.binDir, `qwen-1.2.3${suffix}`), payload);
    await writeFile(f.paths.linkPath, 'previous entry');
    await expect(f.service.rollback()).rejects.toThrow('record unavailable');
    expect(await readFile(f.paths.linkPath, 'utf8')).toBe('previous entry');
    expect(f.getArtifact).not.toHaveBeenCalled();
  });

  it('downloads and activates a missing rollback target without writing a forward-update pointer', async () => {
    const f = fixture();
    expect(await f.service.rollback()).toMatchObject({ reused: false });
    expect(f.getArtifact).toHaveBeenCalledOnce();
    expect(await readFile(f.paths.linkPath, 'utf8')).toBe(payload);
    await expect(
      readFile(join(f.paths.binDir, 'version.txt')),
    ).rejects.toThrow();
    await expect(
      readFile(join(f.paths.binDir, '.qwen-install-resource')),
    ).rejects.toThrow();
    for (const [, temporary] of vi.mocked(downloadFile).mock.calls)
      await expect(readFile(temporary)).rejects.toThrow();
  });

  it('keeps the previous entry active and removes owned downloads after failed rollback verification', async () => {
    const f = fixture();
    await mkdir(f.paths.linkPath.replace(/[^/\\]+$/, ''), { recursive: true });
    await writeFile(f.paths.linkPath, 'previous entry');
    vi.mocked(downloadFile).mockImplementationOnce(async (_url, path) => {
      await writeFile(path, 'corrupted');
    });
    await expect(f.service.rollback()).rejects.toThrow('SHA256 mismatch');
    expect(await readFile(f.paths.linkPath, 'utf8')).toBe('previous entry');
    for (const [, temporary] of vi.mocked(downloadFile).mock.calls)
      await expect(readFile(temporary)).rejects.toThrow();
  });

  it('extracts a real rollback archive through the common native mechanism', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { copyFile } = await import('node:fs/promises');
    const archiveDir = join(directory, 'archive-content');
    await mkdir(archiveDir);
    await writeFile(join(archiveDir, `qwen${suffix}`), payload);
    const archive = join(directory, 'fixture.tar.gz');
    await promisify(execFile)('tar', [
      'czf',
      archive,
      '-C',
      archiveDir,
      `qwen${suffix}`,
    ]);
    const sha256 = createHash('sha256')
      .update(await readFile(archive))
      .digest('hex');
    const f = fixture({
      getArtifact: async () => ({
        os: 'darwin',
        arch: 'arm64',
        url: 'https://example.invalid/fixture.tar.gz',
        sha256,
      }),
    });
    vi.mocked(downloadFile).mockImplementationOnce(async (_url, path) => {
      await copyFile(archive, path);
    });
    await f.service.rollback();
    expect(await readFile(f.paths.linkPath, 'utf8')).toBe(payload);
  });
});
