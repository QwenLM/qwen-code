/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseTokenStorage } from './base-token-storage.js';
import type { OAuthCredentials, SecretStorage } from './types.js';
import { coreEvents } from '../../utils/events.js';
import { KeychainService } from '../../services/keychainService.js';
import {
  KEYCHAIN_TEST_PREFIX,
  SECRET_PREFIX,
} from '../../services/keychainTypes.js';

export class KeychainTokenStorage
  extends BaseTokenStorage
  implements SecretStorage
{
  private readonly keychainService: KeychainService;

  constructor(serviceName: string) {
    super(serviceName);
    this.keychainService = new KeychainService(serviceName);
  }

  async getCredentials(serverName: string): Promise<OAuthCredentials | null> {
    const account = this.accountNameFor(serverName);
    const data = await this.keychainService.getPassword(account);

    if (data) {
      // Expired credentials are returned like any others, as the plaintext
      // storage does: the refresh token may still be good, and whether to
      // refresh or sign in again is the caller's call.
      return this.parseCredentials(data, serverName);
    }

    const legacy = this.legacyAccountNameFor(serverName);
    if (legacy === account) {
      return null;
    }
    const legacyData = await this.keychainService.getPassword(legacy);
    if (!legacyData) {
      return null;
    }
    const parsed = this.parseCredentials(legacyData, serverName);
    // The lossy legacy account may also hold another identity whose name
    // collapsed onto the same key; never hand those credentials over.
    if (parsed.serverName !== serverName) {
      return null;
    }
    await this.migrateLegacyAccount(account, legacy, legacyData);
    return parsed;
  }

  async setCredentials(
    credentials: OAuthCredentials,
    beforeWrite?: () => void,
  ): Promise<void> {
    this.validateCredentials(credentials);

    const updatedCredentials: OAuthCredentials = {
      ...credentials,
      updatedAt: Date.now(),
    };

    const data = JSON.stringify(updatedCredentials);
    await this.keychainService.setPassword(
      this.accountNameFor(credentials.serverName),
      data,
      ...(beforeWrite ? [beforeWrite] : []),
    );
  }

  /** Deleting credentials that are not there is not an error. */
  async deleteCredentials(serverName: string): Promise<void> {
    await this.keychainService.deletePassword(this.accountNameFor(serverName));

    const legacy = this.legacyAccountNameFor(serverName);
    if (legacy === this.accountNameFor(serverName)) {
      return;
    }
    const legacyData = await this.keychainService.getPassword(legacy);
    if (!legacyData) {
      return;
    }
    // Only a legacy copy of the same identity is ours to delete; a collided
    // name belongs to the other server.
    try {
      const parsed = JSON.parse(legacyData) as OAuthCredentials;
      if (parsed.serverName !== serverName) return;
    } catch {
      return;
    }
    await this.keychainService.deletePassword(legacy);
  }

  async listServers(): Promise<string[]> {
    return Array.from((await this.getAllCredentials()).keys());
  }

  async getAllCredentials(): Promise<Map<string, OAuthCredentials>> {
    const result = new Map<string, OAuthCredentials>();
    try {
      const credentials = (await this.keychainService.findCredentials()).filter(
        (c) =>
          !c.account.startsWith(KEYCHAIN_TEST_PREFIX) &&
          !c.account.startsWith(SECRET_PREFIX),
      );

      for (const cred of credentials) {
        try {
          const parsed = JSON.parse(cred.password) as OAuthCredentials;
          const key =
            typeof parsed.serverName === 'string' && parsed.serverName
              ? parsed.serverName
              : cred.account;
          const existing = result.get(key);
          if (!existing || parsed.updatedAt > existing.updatedAt) {
            result.set(key, parsed);
          }
        } catch (error) {
          coreEvents.emitFeedback(
            'error',
            `Failed to parse credentials for ${cred.account}`,
            error,
          );
        }
      }
    } catch (error) {
      coreEvents.emitFeedback(
        'error',
        'Failed to get all credentials from keychain',
        error,
      );
    }

    return result;
  }

  private parseCredentials(data: string, serverName: string): OAuthCredentials {
    try {
      return JSON.parse(data) as OAuthCredentials;
    } catch {
      throw new Error(`Failed to parse stored credentials for ${serverName}`);
    }
  }

  /** Move a verified legacy copy to the lossless account; read stays usable on failure. */
  private async migrateLegacyAccount(
    account: string,
    legacy: string,
    data: string,
  ): Promise<void> {
    try {
      await this.keychainService.setPassword(account, data);
      await this.keychainService.deletePassword(legacy);
    } catch {
      // The credential was still returned from the legacy account.
    }
  }

  async clearAll(): Promise<void> {
    try {
      const credentials = await this.keychainService.findCredentials();
      const errors: Error[] = [];

      for (const cred of credentials) {
        try {
          await this.deleteCredentials(cred.account);
        } catch (error) {
          errors.push(error as Error);
        }
      }

      if (errors.length > 0) {
        throw new Error(
          `Failed to clear some credentials: ${errors.map((e) => e.message).join(', ')}`,
        );
      }
    } catch (error) {
      coreEvents.emitFeedback(
        'error',
        'Failed to clear credentials from keychain',
        error,
      );
      throw error;
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.keychainService.isAvailable();
  }

  async isUsingFileFallback(): Promise<boolean> {
    return this.keychainService.isUsingFileFallback();
  }

  async setSecret(key: string, value: string): Promise<void> {
    await this.keychainService.setPassword(`${SECRET_PREFIX}${key}`, value);
  }

  async getSecret(key: string): Promise<string | null> {
    return this.keychainService.getPassword(`${SECRET_PREFIX}${key}`);
  }

  async deleteSecret(key: string): Promise<void> {
    const deleted = await this.keychainService.deletePassword(
      `${SECRET_PREFIX}${key}`,
    );
    if (!deleted) {
      throw new Error(`No secret found for key: ${key}`);
    }
  }

  async listSecrets(): Promise<string[]> {
    try {
      const credentials = await this.keychainService.findCredentials();
      return credentials
        .filter((cred) => cred.account.startsWith(SECRET_PREFIX))
        .map((cred) => cred.account.substring(SECRET_PREFIX.length));
    } catch (error) {
      coreEvents.emitFeedback(
        'error',
        'Failed to list secrets from keychain',
        error,
      );
      return [];
    }
  }
}
