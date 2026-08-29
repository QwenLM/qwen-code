/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LIVE_HOST_PROTOCOL_VERSION } from './types.js';
import {
  downloadLiveHostRelease,
  isExpectedLiveHostSignature,
  LiveHostInstaller,
  LIVE_HOST_DOWNLOAD_TIMEOUT_MS,
  LIVE_HOST_MANIFEST_FETCH_TIMEOUT_MS,
  LIVE_HOST_OSS_BASE_URL,
  LIVE_HOST_RELEASE_BASE_URL,
  parseLiveHostReleaseManifest,
  resolveLiveHostAssetUrls,
  resolveLiveHostManifestUrls,
} from './live-host-installer.js';

const sha = 'a'.repeat(64);

function manifest() {
  return {
    schemaVersion: 1,
    version: '0.1.0',
    protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
    bundleId: 'com.alibaba.qwen-code.live-host',
    assets: {
      arm64: {
        name: 'Qwen-Live-Host-arm64.zip',
        size: 123,
        sha256: sha,
      },
      x64: {
        name: 'Qwen-Live-Host-x64.zip',
        size: 456,
        sha256: sha,
      },
    },
  };
}

function manifestForBytes(version: string, bytes: Buffer) {
  const checksum = createHash('sha256').update(bytes).digest('hex');
  return {
    ...manifest(),
    version,
    assets: {
      arm64: {
        name: 'Qwen-Live-Host-arm64.zip',
        size: bytes.byteLength,
        sha256: checksum,
      },
      x64: {
        name: 'Qwen-Live-Host-x64.zip',
        size: bytes.byteLength,
        sha256: checksum,
      },
    },
  };
}

describe('LiveHostInstaller', () => {
  it('prefers the OSS mirror and retains the independent GitHub fallback', () => {
    expect(LIVE_HOST_OSS_BASE_URL).toBe(
      'https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/live-host',
    );
    expect(LIVE_HOST_RELEASE_BASE_URL).toBe(
      'https://github.com/QwenLM/qwen-code/releases/download/live-host-latest',
    );
    expect(resolveLiveHostManifestUrls()).toEqual([
      `${LIVE_HOST_OSS_BASE_URL}/latest/Qwen-Live-Host-manifest.json`,
      `${LIVE_HOST_RELEASE_BASE_URL}/Qwen-Live-Host-manifest.json`,
    ]);
    expect(
      resolveLiveHostAssetUrls('0.1.0', 'Qwen-Live-Host-arm64.zip'),
    ).toEqual([
      `${LIVE_HOST_OSS_BASE_URL}/v0.1.0/Qwen-Live-Host-arm64.zip`,
      `${LIVE_HOST_RELEASE_BASE_URL}/Qwen-Live-Host-arm64.zip`,
    ]);
  });

  it('falls back with a matching GitHub manifest and asset pair', async () => {
    const ossBytes = Buffer.from('oss-archive');
    const githubBytes = Buffer.from('github-archive');
    const ossManifest = manifestForBytes('0.1.0', ossBytes);
    const githubManifest = manifestForBytes('0.2.0', githubBytes);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(ossManifest))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json(githubManifest))
      .mockResolvedValueOnce(
        new Response(githubBytes, {
          headers: { 'content-length': String(githubBytes.byteLength) },
        }),
      );
    const directory = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'live-host-download-test-'),
    );
    const destination = path.join(directory, 'host.zip');

    try {
      const release = await downloadLiveHostRelease(
        'arm64',
        destination,
        () => {},
        fetchImpl,
      );
      expect(release.manifest).toEqual(githubManifest);
      await expect(fsp.readFile(destination)).resolves.toEqual(githubBytes);
      expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
        resolveLiveHostManifestUrls()[0],
        resolveLiveHostAssetUrls(
          ossManifest.version,
          ossManifest.assets.arm64.name,
        )[0],
        resolveLiveHostManifestUrls()[1],
        resolveLiveHostAssetUrls(
          githubManifest.version,
          githubManifest.assets.arm64.name,
        )[1],
      ]);
    } finally {
      await fsp.rm(directory, { recursive: true, force: true });
    }
  });

  it('removes a checksum-invalid OSS archive before falling back', async () => {
    const expectedOssBytes = Buffer.from('expected-oss-archive');
    const corruptOssBytes = Buffer.alloc(expectedOssBytes.byteLength, 0x78);
    const githubBytes = Buffer.from('github-archive');
    const ossManifest = manifestForBytes('0.1.0', expectedOssBytes);
    const githubManifest = manifestForBytes('0.2.0', githubBytes);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(ossManifest))
      .mockResolvedValueOnce(
        new Response(corruptOssBytes, {
          headers: { 'content-length': String(corruptOssBytes.byteLength) },
        }),
      )
      .mockResolvedValueOnce(Response.json(githubManifest))
      .mockResolvedValueOnce(
        new Response(githubBytes, {
          headers: { 'content-length': String(githubBytes.byteLength) },
        }),
      );
    const directory = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'live-host-download-test-'),
    );
    const destination = path.join(directory, 'host.zip');

    try {
      const release = await downloadLiveHostRelease(
        'arm64',
        destination,
        () => {},
        fetchImpl,
      );
      expect(release.manifest).toEqual(githubManifest);
      await expect(fsp.readFile(destination)).resolves.toEqual(githubBytes);
    } finally {
      await fsp.rm(directory, { recursive: true, force: true });
    }
  });

  it('reports both source failures and removes the destination', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 503 }));
    const directory = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'live-host-download-test-'),
    );
    const destination = path.join(directory, 'host.zip');

    try {
      await expect(
        downloadLiveHostRelease('arm64', destination, () => {}, fetchImpl),
      ).rejects.toMatchObject({
        message:
          'Qwen Live Host download failed. OSS: Live Host manifest download failed (503). GitHub: Live Host manifest download failed (503).',
        errors: [
          { message: 'OSS: Live Host manifest download failed (503).' },
          { message: 'GitHub: Live Host manifest download failed (503).' },
        ],
      });
      await expect(fsp.stat(destination)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await fsp.rm(directory, { recursive: true, force: true });
    }
  });

  it('passes separate bounded signals to manifest and archive requests', async () => {
    const bytes = Buffer.from('signed-live-host-archive');
    const expected = manifestForBytes('0.1.0', bytes);
    const manifestSignal = AbortSignal.abort('manifest');
    const downloadSignal = AbortSignal.abort('download');
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValueOnce(manifestSignal)
      .mockReturnValueOnce(downloadSignal);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(expected))
      .mockResolvedValueOnce(new Response(bytes));
    const directory = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'live-host-download-test-'),
    );
    const destination = path.join(directory, 'host.zip');

    try {
      await downloadLiveHostRelease('arm64', destination, () => {}, fetchImpl);
      expect(LIVE_HOST_MANIFEST_FETCH_TIMEOUT_MS).toBe(5 * 60 * 1000);
      expect(LIVE_HOST_DOWNLOAD_TIMEOUT_MS).toBe(60 * 60 * 1000);
      expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBe(manifestSignal);
      expect(fetchImpl.mock.calls[1]?.[1]?.signal).toBe(downloadSignal);
    } finally {
      timeout.mockRestore();
      await fsp.rm(directory, { recursive: true, force: true });
    }
  });

  it('accepts only the Qwen Developer ID team', () => {
    expect(
      isExpectedLiveHostSignature(
        [
          'Authority=Developer ID Application: Alibaba Cloud (Singapore) Private Limited (NF4574S59H)',
          'TeamIdentifier=NF4574S59H',
        ].join('\n'),
      ),
    ).toBe(true);
    expect(
      isExpectedLiveHostSignature(
        'Authority=Developer ID Application: Other\nTeamIdentifier=OTHER12345',
      ),
    ).toBe(false);
    expect(
      isExpectedLiveHostSignature('Signature=adhoc\nTeamIdentifier=NF4574S59H'),
    ).toBe(false);
  });

  it('accepts only the fixed compatible release manifest', () => {
    expect(parseLiveHostReleaseManifest(manifest())).toEqual(manifest());
    expect(() =>
      parseLiveHostReleaseManifest({
        ...manifest(),
        protocolVersion: LIVE_HOST_PROTOCOL_VERSION + 1,
      }),
    ).toThrow(/incompatible/);
    expect(() =>
      parseLiveHostReleaseManifest({
        ...manifest(),
        assets: {
          ...manifest().assets,
          arm64: { ...manifest().assets.arm64, name: 'other.zip' },
        },
      }),
    ).toThrow(/asset/);
  });

  it('launches an existing verified installation without downloading', async () => {
    const inspectInstalled = vi.fn(async () => ({ version: '0.1.0' }));
    const installLatest = vi.fn();
    const launch = vi.fn(async () => {});
    const installer = new LiveHostInstaller({
      platform: 'darwin',
      architecture: 'arm64',
      inspectInstalled,
      installLatest,
      launch,
    });

    await expect(installer.ensureInstalled()).resolves.toEqual({
      state: 'installed',
      version: '0.1.0',
    });
    expect(installLatest).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent installs and exposes progress', async () => {
    let finish: ((value: { version: string }) => void) | undefined;
    const installLatest = vi.fn(
      async (
        _architecture: 'arm64' | 'x64',
        onStatus: (status: { state: 'downloading'; progress: number }) => void,
      ) => {
        onStatus({ state: 'downloading', progress: 0.5 });
        return await new Promise<{ version: string }>((resolve) => {
          finish = resolve;
        });
      },
    );
    const installer = new LiveHostInstaller({
      platform: 'darwin',
      architecture: 'x64',
      inspectInstalled: async () => undefined,
      installLatest,
      launch: async () => {},
    });

    const first = installer.ensureInstalled();
    const second = installer.ensureInstalled();
    await vi.waitFor(() => {
      expect(installer.getStatus()).toEqual({
        state: 'downloading',
        progress: 0.5,
      });
    });
    finish?.({ version: '0.1.0' });
    await expect(first).resolves.toMatchObject({ state: 'installed' });
    await expect(second).resolves.toMatchObject({ state: 'installed' });
    expect(installLatest).toHaveBeenCalledOnce();
  });

  it('fails closed on unsupported platforms and architectures', async () => {
    const installLatest = vi.fn();
    const linux = new LiveHostInstaller({
      platform: 'linux',
      architecture: 'x64',
      installLatest,
    });
    await expect(linux.ensureInstalled()).resolves.toMatchObject({
      state: 'error',
      retryable: false,
    });

    const unsupported = new LiveHostInstaller({
      platform: 'darwin',
      architecture: 'ia32',
      inspectInstalled: async () => undefined,
      installLatest,
    });
    await expect(unsupported.ensureInstalled()).resolves.toMatchObject({
      state: 'error',
      retryable: true,
    });
    expect(installLatest).not.toHaveBeenCalled();
  });

  it('keeps an installation failure retryable', async () => {
    const installer = new LiveHostInstaller({
      platform: 'darwin',
      architecture: 'arm64',
      inspectInstalled: async () => undefined,
      installLatest: async () => {
        throw new Error('checksum verification failed');
      },
      launch: async () => {},
    });

    await expect(installer.ensureInstalled()).resolves.toEqual({
      state: 'error',
      message: 'checksum verification failed',
      retryable: true,
    });
  });
});
