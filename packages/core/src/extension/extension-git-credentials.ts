/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteJSON } from '../utils/atomicFileWrite.js';
import { FileTokenStorage } from '../mcp/token-storage/file-token-storage.js';
import { HybridTokenStorage } from '../mcp/token-storage/hybrid-token-storage.js';
import { KeychainTokenStorage } from '../mcp/token-storage/keychain-token-storage.js';
import {
  TokenStorageType,
  type SecretStorage,
} from '../mcp/token-storage/types.js';

export const EXTENSION_GIT_CREDENTIAL_SELECTOR_FILENAME =
  '.qwen-extension-git-credentials.json';

const GIT_CREDENTIAL_SERVICE_NAME = 'Qwen Code Extension Git Credentials';
const GIT_CREDENTIAL_KEY_PREFIX = '$qwen:extension-git:v1:';

export type ExtensionCredentialPersistence = 'stored' | 'one_time';

export interface GitCredential {
  username: string;
  password: string;
}

export interface ExtensionGitCredential extends GitCredential {
  persistence: ExtensionCredentialPersistence;
}

export interface ExtensionGitCredentialSelector {
  version: 1;
  backend: TokenStorageType;
  secretKey: string;
}

export interface ResolvedStoredGitCredential {
  credential: GitCredential;
  selector: ExtensionGitCredentialSelector;
}

export interface PreparedStoredGitCredential {
  storageType: TokenStorageType;
  selector: ExtensionGitCredentialSelector;
  commit(): void;
  discard(): Promise<void>;
}

export class ExtensionCredentialUnavailableError extends Error {
  readonly code = 'extension_credential_unavailable';

  constructor(
    message = 'Stored extension Git credentials are unavailable.',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ExtensionCredentialUnavailableError';
  }
}

const selectorPath = (extensionDir: string): string =>
  path.join(extensionDir, EXTENSION_GIT_CREDENTIAL_SELECTOR_FILENAME);

function createSelectedStorage(backend: TokenStorageType): SecretStorage {
  return backend === TokenStorageType.KEYCHAIN
    ? new KeychainTokenStorage(GIT_CREDENTIAL_SERVICE_NAME)
    : new FileTokenStorage(GIT_CREDENTIAL_SERVICE_NAME);
}

function parseSelector(content: string): ExtensionGitCredentialSelector {
  const value: unknown = JSON.parse(content);
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('backend' in value) ||
    !Object.values(TokenStorageType).includes(
      value.backend as TokenStorageType,
    ) ||
    !('secretKey' in value) ||
    typeof value.secretKey !== 'string' ||
    !value.secretKey.startsWith(GIT_CREDENTIAL_KEY_PREFIX)
  ) {
    throw new Error('Stored extension Git credential selector is invalid.');
  }
  return value as ExtensionGitCredentialSelector;
}

async function readSelector(
  extensionDir: string,
): Promise<ExtensionGitCredentialSelector> {
  try {
    const target = selectorPath(extensionDir);
    const stats = await fs.lstat(target);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 4096) {
      throw new Error('Stored extension Git credential selector is invalid.');
    }
    return parseSelector(await fs.readFile(target, 'utf8'));
  } catch (error) {
    if (error instanceof ExtensionCredentialUnavailableError) throw error;
    throw new ExtensionCredentialUnavailableError(undefined, { cause: error });
  }
}

function parseCredential(content: string): GitCredential {
  const value: unknown = JSON.parse(content);
  if (
    !value ||
    typeof value !== 'object' ||
    !('username' in value) ||
    typeof value.username !== 'string' ||
    !('password' in value) ||
    typeof value.password !== 'string'
  ) {
    throw new Error('Stored extension Git credential is invalid.');
  }
  return { username: value.username, password: value.password };
}

export async function resolveStoredGitCredential(
  extensionDir: string,
): Promise<ResolvedStoredGitCredential> {
  try {
    const selector = await readSelector(extensionDir);
    const storage = createSelectedStorage(selector.backend);
    const content = await storage.getSecret(selector.secretKey);
    if (content === null) throw new Error('Stored secret is missing.');
    return { credential: parseCredential(content), selector };
  } catch (error) {
    if (error instanceof ExtensionCredentialUnavailableError) throw error;
    throw new ExtensionCredentialUnavailableError(undefined, { cause: error });
  }
}

export async function removeGitCredentialSelector(
  extensionDir: string,
): Promise<void> {
  await fs.rm(selectorPath(extensionDir), { force: true });
}

export async function writeGitCredentialSelector(
  extensionDir: string,
  selector: ExtensionGitCredentialSelector,
): Promise<void> {
  await atomicWriteJSON(selectorPath(extensionDir), selector, {
    mode: 0o600,
    forceMode: true,
    noFollow: true,
  });
}

export async function prepareStoredGitCredential(
  extensionDir: string,
  credential: GitCredential,
): Promise<PreparedStoredGitCredential> {
  const storage = new HybridTokenStorage(GIT_CREDENTIAL_SERVICE_NAME);
  const secretKey = `${GIT_CREDENTIAL_KEY_PREFIX}${randomUUID()}`;
  await storage.setSecret(secretKey, JSON.stringify(credential));
  const selector: ExtensionGitCredentialSelector = {
    version: 1,
    backend: await storage.getStorageType(),
    secretKey,
  };
  try {
    await writeGitCredentialSelector(extensionDir, selector);
  } catch (error) {
    await storage.deleteSecret(secretKey).catch(() => undefined);
    throw error;
  }
  let committed = false;
  let discarded = false;
  return {
    storageType: selector.backend,
    selector,
    commit: () => {
      committed = true;
    },
    discard: async () => {
      if (committed || discarded) return;
      const selectedStorage = createSelectedStorage(selector.backend);
      await selectedStorage.deleteSecret(secretKey);
      discarded = true;
    },
  };
}

export async function prepareStoredGitCredentialDeletion(
  extensionDir: string,
): Promise<() => Promise<void>> {
  const selector = await readSelector(extensionDir);
  return async () => {
    const storage = createSelectedStorage(selector.backend);
    await storage.deleteSecret(selector.secretKey);
  };
}
