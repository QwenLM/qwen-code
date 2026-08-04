/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { LIVE_HOST_PROTOCOL_VERSION } from './types.js';
import {
  isExpectedLiveHostSignature,
  LiveHostInstaller,
  LIVE_HOST_RELEASE_BASE_URL,
  parseLiveHostReleaseManifest,
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

describe('LiveHostInstaller', () => {
  it('downloads only from the independent stable Live Host feed', () => {
    expect(LIVE_HOST_RELEASE_BASE_URL).toBe(
      'https://github.com/QwenLM/qwen-code/releases/download/live-host-latest',
    );
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
