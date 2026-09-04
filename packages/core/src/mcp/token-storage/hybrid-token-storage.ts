/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseTokenStorage } from './base-token-storage.js';
import { FileTokenStorage } from './file-token-storage.js';
import type { TokenStorage, SecretStorage, OAuthCredentials } from './types.js';
import { TokenStorageType } from './types.js';

const FORCE_FILE_STORAGE_ENV_VAR = 'QWEN_CODE_FORCE_FILE_STORAGE';

type HybridBackend = TokenStorage & SecretStorage;

export class HybridTokenStorage
  extends BaseTokenStorage
  implements SecretStorage
{
  private storage: HybridBackend | null = null;
  private storageType: TokenStorageType | null = null;
  private storageInitPromise: Promise<HybridBackend> | null = null;

  constructor(serviceName: string) {
    super(serviceName);
  }

  private async initializeStorage(): Promise<HybridBackend> {
    const forceFileStorage = process.env[FORCE_FILE_STORAGE_ENV_VAR] === 'true';

    if (!forceFileStorage) {
      try {
        const { KeychainTokenStorage } = await import(
          './keychain-token-storage.js'
        );
        const keychainStorage = new KeychainTokenStorage(this.serviceName);

        const isAvailable = await keychainStorage.isAvailable();
        if (isAvailable) {
          this.storage = keychainStorage;
          this.storageType = TokenStorageType.KEYCHAIN;
          return this.storage;
        }
      } catch (_e) {
        // Fallback to file storage if keychain fails to initialize
      }
    }

    this.storage = new FileTokenStorage(this.serviceName);
    this.storageType = TokenStorageType.ENCRYPTED_FILE;
    return this.storage;
  }

  private async getStorage(): Promise<HybridBackend> {
    if (this.storage !== null) {
      return this.storage;
    }

    // Use a single initialization promise to avoid race conditions
    if (!this.storageInitPromise) {
      this.storageInitPromise = this.initializeStorage();
    }

    // Wait for initialization to complete
    return await this.storageInitPromise;
  }

  async getCredentials(serverName: string): Promise<OAuthCredentials | null> {
    const storage = await this.getStorage();
    return storage.getCredentials(serverName);
  }

  async setCredentials(credentials: OAuthCredentials): Promise<void> {
    const storage = await this.getStorage();
    await storage.setCredentials(credentials);
  }

  async deleteCredentials(serverName: string): Promise<void> {
    const storage = await this.getStorage();
    await storage.deleteCredentials(serverName);
  }

  async listServers(): Promise<string[]> {
    const storage = await this.getStorage();
    return storage.listServers();
  }

  async getAllCredentials(): Promise<Map<string, OAuthCredentials>> {
    const storage = await this.getStorage();
    return storage.getAllCredentials();
  }

  async clearAll(): Promise<void> {
    const storage = await this.getStorage();
    await storage.clearAll();
  }

  async getStorageType(): Promise<TokenStorageType> {
    await this.getStorage();
    return this.storageType!;
  }

  // Secret API — delegates to whichever backend is active (keychain when
  // available, otherwise the encrypted file). This is what lets sensitive
  // extension settings degrade gracefully to file storage without a keychain.
  async isAvailable(): Promise<boolean> {
    const storage = await this.getStorage();
    return storage.isAvailable();
  }

  async setSecret(key: string, value: string): Promise<void> {
    const storage = await this.getStorage();
    await storage.setSecret(key, value);
  }

  async getSecret(key: string): Promise<string | null> {
    const storage = await this.getStorage();
    return storage.getSecret(key);
  }

  async deleteSecret(key: string): Promise<void> {
    const storage = await this.getStorage();
    await storage.deleteSecret(key);
  }

  async listSecrets(): Promise<string[]> {
    const storage = await this.getStorage();
    return storage.listSecrets();
  }
}
