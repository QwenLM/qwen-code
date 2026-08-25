/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  EXTENSION_GIT_CREDENTIAL_SELECTOR_FILENAME,
  prepareStoredGitCredential,
  removeGitCredentialSelector,
  resolveStoredGitCredential,
  writeGitCredentialSelector,
} from './extension-git-credentials.js';
import { TokenStorageType } from '../mcp/token-storage/types.js';
import { KeychainTokenStorage } from '../mcp/token-storage/keychain-token-storage.js';

describe('extension Git credential storage', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-git-auth-'));
    vi.stubEnv('QWEN_HOME', path.join(tempDir, 'qwen-home'));
    vi.stubEnv('QWEN_CODE_FORCE_FILE_STORAGE', 'true');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('stages an encrypted-file credential and resolves it through its selector', async () => {
    const extensionDir = path.join(tempDir, 'extension');
    await fs.mkdir(extensionDir);
    const prepared = await prepareStoredGitCredential(extensionDir, {
      username: 'user',
      password: 'fine-grained-token',
    });

    const selectorPath = path.join(
      extensionDir,
      EXTENSION_GIT_CREDENTIAL_SELECTOR_FILENAME,
    );
    const selectorContent = await fs.readFile(selectorPath, 'utf8');
    expect(selectorContent).not.toContain('user');
    expect(selectorContent).not.toContain('fine-grained-token');
    // Windows has no POSIX permission bits; the credential read side does
    // not rely on the file mode.
    if (process.platform !== 'win32') {
      expect((await fs.stat(selectorPath)).mode & 0o777).toBe(0o600);
    }
    await expect(resolveStoredGitCredential(extensionDir)).resolves.toEqual({
      credential: { username: 'user', password: 'fine-grained-token' },
      selector: prepared.selector,
    });

    prepared.commit();
    await prepared.discard();
    await expect(resolveStoredGitCredential(extensionDir)).resolves.toEqual({
      credential: { username: 'user', password: 'fine-grained-token' },
      selector: prepared.selector,
    });
  });

  it('deletes an uncommitted secret when preparation is discarded', async () => {
    const extensionDir = path.join(tempDir, 'extension');
    await fs.mkdir(extensionDir);
    const prepared = await prepareStoredGitCredential(extensionDir, {
      username: 'user',
      password: 'token',
    });

    await prepared.discard();

    await expect(
      resolveStoredGitCredential(extensionDir),
    ).rejects.toMatchObject({ code: 'extension_credential_unavailable' });
  });

  it('selects the keychain when it is available', async () => {
    vi.stubEnv('QWEN_CODE_FORCE_FILE_STORAGE', 'false');
    const isAvailable = vi
      .spyOn(KeychainTokenStorage.prototype, 'isAvailable')
      .mockResolvedValue(true);
    const setSecret = vi
      .spyOn(KeychainTokenStorage.prototype, 'setSecret')
      .mockResolvedValue();
    const deleteSecret = vi
      .spyOn(KeychainTokenStorage.prototype, 'deleteSecret')
      .mockResolvedValue();
    const extensionDir = path.join(tempDir, 'extension');
    await fs.mkdir(extensionDir);

    const prepared = await prepareStoredGitCredential(extensionDir, {
      username: 'user',
      password: 'token',
    });

    expect(prepared.storageType).toBe(TokenStorageType.KEYCHAIN);
    expect(prepared.selector.backend).toBe(TokenStorageType.KEYCHAIN);
    expect(isAvailable).toHaveBeenCalled();
    expect(setSecret).toHaveBeenCalledWith(
      prepared.selector.secretKey,
      JSON.stringify({ username: 'user', password: 'token' }),
    );
    await prepared.discard();
    expect(deleteSecret).toHaveBeenCalledWith(prepared.selector.secretKey);
  });

  it('rejects a symlinked selector and removes repository-provided selectors', async () => {
    const extensionDir = path.join(tempDir, 'extension');
    await fs.mkdir(extensionDir);
    const outside = path.join(tempDir, 'outside.json');
    await fs.writeFile(outside, '{}');
    await fs.symlink(
      outside,
      path.join(extensionDir, EXTENSION_GIT_CREDENTIAL_SELECTOR_FILENAME),
    );

    await expect(
      resolveStoredGitCredential(extensionDir),
    ).rejects.toMatchObject({ code: 'extension_credential_unavailable' });
    await removeGitCredentialSelector(extensionDir);
    await writeGitCredentialSelector(extensionDir, {
      version: 1,
      backend: TokenStorageType.ENCRYPTED_FILE,
      secretKey: '$qwen:extension-git:v1:test',
    });
    expect(await fs.lstat(outside)).toBeDefined();
    expect(
      (
        await fs.lstat(
          path.join(extensionDir, EXTENSION_GIT_CREDENTIAL_SELECTOR_FILENAME),
        )
      ).isSymbolicLink(),
    ).toBe(false);
  });
});
