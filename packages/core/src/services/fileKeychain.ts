/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  promises as fs,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Keychain } from './keychainTypes.js';
import { getConfigHomeDir } from '../utils/paths.js';
import { withFileLock } from '../utils/fileLock.js';
import { writeFileAtomic } from '../utils/fileWriteUtils.js';
import { BRAND_KEYCHAIN_PREFIX } from '../config/brand.js';

const SALT_LENGTH = 32;

export class FileKeychain implements Keychain {
  private readonly tokenFilePath: string;
  private readonly saltFilePath: string;
  private readonly encryptionKey: Buffer;

  constructor() {
    const configDir = getConfigHomeDir();
    this.tokenFilePath = path.join(
      configDir,
      `${BRAND_KEYCHAIN_PREFIX}-credentials.json`,
    );
    this.saltFilePath = path.join(configDir, '.keychain-salt');
    this.encryptionKey = this.deriveEncryptionKey();
  }

  private getOrCreateSalt(): Buffer {
    if (existsSync(this.saltFilePath)) {
      return readFileSync(this.saltFilePath);
    }
    const salt = crypto.randomBytes(SALT_LENGTH);
    const dir = path.dirname(this.saltFilePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.saltFilePath, salt, { mode: 0o600 });
    return salt;
  }

  private deriveEncryptionKey(): Buffer {
    const salt = this.getOrCreateSalt();
    return crypto.scryptSync(`${BRAND_KEYCHAIN_PREFIX}-credentials`, salt, 32);
  }

  private encrypt(text: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
  }

  private decrypt(encryptedData: string): string {
    const parts = encryptedData.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted data format');
    }

    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      iv,
    );
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  private async ensureDirectoryExists(): Promise<void> {
    const dir = path.dirname(this.tokenFilePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  }

  private async loadData(): Promise<Record<string, Record<string, string>>> {
    try {
      const data = await fs.readFile(this.tokenFilePath, 'utf-8');
      const decrypted = this.decrypt(data);
      return JSON.parse(decrypted) as Record<string, Record<string, string>>;
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException & { message?: string };
      if (err.code === 'ENOENT') {
        return {};
      }
      if (
        err.message?.includes('Invalid encrypted data format') ||
        err.message?.includes(
          'Unsupported state or unable to authenticate data',
        )
      ) {
        throw new Error(
          `Corrupted credentials file detected at: ${this.tokenFilePath}\n` +
            `Please delete or rename this file to resolve the issue.`,
        );
      }
      throw error;
    }
  }

  private async saveData(
    data: Record<string, Record<string, string>>,
    assertHeld?: () => void,
  ): Promise<void> {
    await this.ensureDirectoryExists();
    const json = JSON.stringify(data, null, 2);
    await writeFileAtomic(this.tokenFilePath, this.encrypt(json), {
      encoding: 'utf-8',
      mode: 0o600,
      ...(assertHeld ? { beforeWrite: assertHeld } : {}),
    });
  }

  async getPassword(service: string, account: string): Promise<string | null> {
    const data = await this.loadData();
    return data[service]?.[account] ?? null;
  }

  async setPassword(
    service: string,
    account: string,
    password: string,
  ): Promise<void> {
    // Read, change and write as one step, so a change from another process
    // in between is not lost.
    await withFileLock(this.tokenFilePath, async (assertHeld) => {
      const data = await this.loadData();
      if (!data[service]) {
        data[service] = {};
      }
      data[service][account] = password;
      await this.saveData(data, assertHeld);
    });
  }

  async deletePassword(service: string, account: string): Promise<boolean> {
    return withFileLock(this.tokenFilePath, (assertHeld) =>
      this.deletePasswordUnlocked(service, account, assertHeld),
    );
  }

  private async deletePasswordUnlocked(
    service: string,
    account: string,
    assertHeld: () => void,
  ): Promise<boolean> {
    const data = await this.loadData();
    if (data[service] && account in data[service]) {
      delete data[service][account];

      if (Object.keys(data[service]).length === 0) {
        delete data[service];
      }

      assertHeld();
      if (Object.keys(data).length === 0) {
        try {
          await fs.unlink(this.tokenFilePath);
        } catch (error: unknown) {
          const err = error as NodeJS.ErrnoException;
          if (err.code !== 'ENOENT') {
            throw error;
          }
        }
      } else {
        await this.saveData(data, assertHeld);
      }
      return true;
    }
    return false;
  }

  async findCredentials(
    service: string,
  ): Promise<Array<{ account: string; password: string }>> {
    const data = await this.loadData();
    const serviceData = data[service] || {};
    return Object.entries(serviceData).map(([account, password]) => ({
      account,
      password,
    }));
  }
}
