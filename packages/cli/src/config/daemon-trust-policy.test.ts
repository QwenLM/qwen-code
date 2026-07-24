/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { ideContextStore } from '@qwen-code/qwen-code-core';
import {
  evaluateDaemonWorkspaceTrust,
  readDaemonTrustPolicySnapshot,
} from './daemon-trust-policy.js';
import { TrustLevel } from './trustedFolders.js';

vi.mock('node:fs/promises');
vi.mock('./settings.js', () => ({
  getUserSettingsPath: () => '/config/user.json',
  getSystemSettingsPath: () => '/config/system.json',
  getSystemDefaultsPath: () => '/config/system-defaults.json',
}));
vi.mock('./trustedFolders.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./trustedFolders.js')>();
  return { ...actual, getTrustedFoldersPath: () => '/config/trusted.json' };
});

const mockedFs = vi.mocked(fs);

function installFiles(files: Record<string, string>): void {
  mockedFs.lstat.mockImplementation(async (filePath) => {
    const key = String(filePath);
    if (!(key in files)) {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    }
    return {
      isFile: () => true,
      isSymbolicLink: () => false,
      size: Buffer.byteLength(files[key]!),
    } as Awaited<ReturnType<typeof fs.lstat>>;
  });
  mockedFs.readFile.mockImplementation(
    async (filePath) => files[String(filePath)] ?? '',
  );
}

describe('daemon trust policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ideContextStore.clear();
  });

  it('uses system folder trust over user', async () => {
    installFiles({
      '/config/user.json': JSON.stringify({
        security: { folderTrust: { enabled: true } },
      }),
      '/config/system.json': JSON.stringify({
        security: { folderTrust: { enabled: false } },
      }),
      '/config/trusted.json': JSON.stringify({
        '/work': TrustLevel.TRUST_FOLDER,
      }),
    });

    const snapshot = await readDaemonTrustPolicySnapshot();
    expect(snapshot.folderTrustEnabled).toBe(false);
    expect(
      evaluateDaemonWorkspaceTrust(snapshot, '/work/project'),
    ).toMatchObject({
      state: 'trusted',
      targetTrusted: true,
      source: 'disabled',
    });
  });

  it('uses system folder trust to enable over user', async () => {
    installFiles({
      '/config/user.json': JSON.stringify({
        security: { folderTrust: { enabled: false } },
      }),
      '/config/system.json': JSON.stringify({
        security: { folderTrust: { enabled: true } },
      }),
      '/config/trusted.json': JSON.stringify({
        '/work': TrustLevel.TRUST_FOLDER,
      }),
    });

    const snapshot = await readDaemonTrustPolicySnapshot();
    expect(snapshot.folderTrustEnabled).toBe(true);
    expect(
      evaluateDaemonWorkspaceTrust(snapshot, '/work/project'),
    ).toMatchObject({
      state: 'trusted',
      targetTrusted: true,
      source: 'file',
    });
  });

  it('uses user folder trust over system defaults', async () => {
    installFiles({
      '/config/user.json': JSON.stringify({
        security: { folderTrust: { enabled: true } },
      }),
      '/config/system.json': '{}',
      '/config/system-defaults.json': JSON.stringify({
        security: { folderTrust: { enabled: false } },
      }),
      '/config/trusted.json': JSON.stringify({
        '/work': TrustLevel.TRUST_FOLDER,
      }),
    });

    const snapshot = await readDaemonTrustPolicySnapshot();
    expect(snapshot.folderTrustEnabled).toBe(true);
    expect(
      evaluateDaemonWorkspaceTrust(snapshot, '/work/project'),
    ).toMatchObject({
      state: 'trusted',
      targetTrusted: true,
      source: 'file',
    });
  });

  it('falls back to system defaults for folder trust', async () => {
    installFiles({
      '/config/user.json': '{}',
      '/config/system.json': '{}',
      '/config/system-defaults.json': JSON.stringify({
        security: { folderTrust: { enabled: true } },
      }),
      '/config/trusted.json': JSON.stringify({
        '/work': TrustLevel.TRUST_FOLDER,
      }),
    });

    const snapshot = await readDaemonTrustPolicySnapshot();
    expect(snapshot.folderTrustEnabled).toBe(true);
    expect(
      evaluateDaemonWorkspaceTrust(snapshot, '/work/project'),
    ).toMatchObject({
      state: 'trusted',
      targetTrusted: true,
      source: 'file',
    });
    expect(evaluateDaemonWorkspaceTrust(snapshot, '/outside')).toMatchObject({
      state: 'unknown',
      targetTrusted: false,
      source: 'none',
    });
  });

  it('migrates legacy folder trust settings before evaluation', async () => {
    installFiles({
      '/config/user.json': JSON.stringify({ folderTrust: true }),
      '/config/system.json': '{}',
      '/config/trusted.json': JSON.stringify({
        '/work': TrustLevel.TRUST_FOLDER,
      }),
    });

    const snapshot = await readDaemonTrustPolicySnapshot();
    expect(snapshot.folderTrustEnabled).toBe(true);
    expect(
      evaluateDaemonWorkspaceTrust(snapshot, '/work/project'),
    ).toMatchObject({
      state: 'trusted',
      targetTrusted: true,
      source: 'file',
    });
  });

  it('confirms a missing trusted-folders file before treating it as empty', async () => {
    const files = {
      '/config/user.json': JSON.stringify({
        security: { folderTrust: { enabled: true } },
      }),
      '/config/system.json': '{}',
      '/config/trusted.json': JSON.stringify({
        '/work': TrustLevel.TRUST_FOLDER,
      }),
    };
    installFiles(files);
    const lstat = mockedFs.lstat.getMockImplementation();
    let firstTrustedFoldersRead = true;
    mockedFs.lstat.mockImplementation(async (filePath) => {
      if (
        String(filePath) === '/config/trusted.json' &&
        firstTrustedFoldersRead
      ) {
        firstTrustedFoldersRead = false;
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return lstat!(filePath);
    });

    const snapshot = await readDaemonTrustPolicySnapshot();

    expect(snapshot.trustedFolders).toEqual({
      '/work': TrustLevel.TRUST_FOLDER,
    });
    expect(
      mockedFs.lstat.mock.calls.filter(
        ([filePath]) => String(filePath) === '/config/trusted.json',
      ),
    ).toHaveLength(2);
  });

  it('retries when trusted folders disappear between stat and read', async () => {
    const files: Record<string, string> = {
      '/config/user.json': JSON.stringify({
        security: { folderTrust: { enabled: true } },
      }),
      '/config/system.json': '{}',
      '/config/trusted.json': JSON.stringify({
        '/work': TrustLevel.TRUST_FOLDER,
      }),
    };
    installFiles(files);
    let firstTrustedFoldersRead = true;
    mockedFs.readFile.mockImplementation(async (filePath) => {
      if (
        String(filePath) === '/config/trusted.json' &&
        firstTrustedFoldersRead
      ) {
        firstTrustedFoldersRead = false;
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return files[String(filePath)] ?? '';
    });

    const snapshot = await readDaemonTrustPolicySnapshot();

    expect(snapshot.trustedFolders).toEqual({
      '/work': TrustLevel.TRUST_FOLDER,
    });
    expect(
      mockedFs.readFile.mock.calls.filter(
        ([filePath]) => String(filePath) === '/config/trusted.json',
      ),
    ).toHaveLength(2);
  });

  it('fails closed when system defaults are malformed', async () => {
    installFiles({
      '/config/user.json': '{}',
      '/config/system.json': '{}',
      '/config/system-defaults.json': '{bad',
      '/config/trusted.json': '{}',
    });

    const decision = evaluateDaemonWorkspaceTrust(
      await readDaemonTrustPolicySnapshot(),
      '/work',
    );
    expect(decision.state).toBe('error');
    expect(decision.targetTrusted).toBe(false);
    expect(decision.error?.code).toBe('trust_policy_invalid');
  });

  it('fails closed when folder trust settings have an invalid type', async () => {
    installFiles({
      '/config/user.json': JSON.stringify({
        security: { folderTrust: { enabled: 'true' } },
      }),
      '/config/system.json': '{}',
      '/config/trusted.json': '{}',
    });

    const decision = evaluateDaemonWorkspaceTrust(
      await readDaemonTrustPolicySnapshot(),
      '/work',
    );

    expect(decision).toMatchObject({
      state: 'error',
      targetTrusted: false,
      error: { code: 'trust_policy_invalid', path: '/config/user.json' },
    });
  });

  it('resolves relative trusted-folder rules from the daemon working directory', async () => {
    installFiles({
      '/config/user.json': JSON.stringify({
        security: { folderTrust: { enabled: true } },
      }),
      '/config/system.json': '{}',
      '/config/trusted.json': JSON.stringify({
        './relative-workspace': TrustLevel.TRUST_FOLDER,
      }),
    });

    const decision = evaluateDaemonWorkspaceTrust(
      await readDaemonTrustPolicySnapshot(),
      `${process.cwd()}/relative-workspace/project`,
    );

    expect(decision).toMatchObject({
      state: 'trusted',
      targetTrusted: true,
      source: 'file',
    });
  });

  it('maps an unknown workspace to operationally untrusted', async () => {
    installFiles({
      '/config/user.json': JSON.stringify({
        security: { folderTrust: { enabled: true } },
      }),
      '/config/system.json': '{}',
      '/config/trusted.json': '{}',
    });

    const decision = evaluateDaemonWorkspaceTrust(
      await readDaemonTrustPolicySnapshot(),
      '/work/unknown',
    );
    expect(decision).toMatchObject({
      state: 'unknown',
      targetTrusted: false,
      source: 'none',
    });
  });

  it('fails closed for malformed trusted folders when file trust is needed', async () => {
    installFiles({
      '/config/user.json': JSON.stringify({
        security: { folderTrust: { enabled: true } },
      }),
      '/config/system.json': '{}',
      '/config/trusted.json': '{bad',
    });

    const decision = evaluateDaemonWorkspaceTrust(
      await readDaemonTrustPolicySnapshot(),
      '/work',
    );
    expect(decision.state).toBe('error');
    expect(decision.targetTrusted).toBe(false);
    expect(decision.error?.code).toBe('trust_policy_invalid');
  });

  it('ignores a trusted-folders error when folder trust is disabled', async () => {
    installFiles({
      '/config/user.json': '{}',
      '/config/system.json': '{}',
      '/config/trusted.json': '{bad',
    });

    expect(
      evaluateDaemonWorkspaceTrust(
        await readDaemonTrustPolicySnapshot(),
        '/work',
      ),
    ).toMatchObject({
      state: 'trusted',
      targetTrusted: true,
      source: 'disabled',
    });
  });

  it('lets IDE trust resolve the primary before a trusted-folders error', async () => {
    installFiles({
      '/config/user.json': JSON.stringify({
        security: { folderTrust: { enabled: true } },
      }),
      '/config/system.json': '{}',
      '/config/trusted.json': '{bad',
    });
    ideContextStore.set({ workspaceState: { isTrusted: true } });

    expect(
      evaluateDaemonWorkspaceTrust(
        await readDaemonTrustPolicySnapshot(),
        process.cwd(),
      ),
    ).toMatchObject({ state: 'trusted', source: 'ide' });
  });
});
