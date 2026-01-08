/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Storage } from '../config/storage.js';
import { createSecureDir, writeSecureFile } from './fileUtils.js';

export class InstallationManager {
  private getInstallationIdPath(): string {
    return Storage.getInstallationIdPath();
  }

  private readInstallationIdFromFile(): string | null {
    const installationIdFile = this.getInstallationIdPath();
    if (fs.existsSync(installationIdFile)) {
      const installationid = fs
        .readFileSync(installationIdFile, 'utf-8')
        .trim();
      return installationid || null;
    }
    return null;
  }

  private writeInstallationIdToFile(installationId: string) {
    const installationIdFile = this.getInstallationIdPath();
    const dir = path.dirname(installationIdFile);
    createSecureDir(dir);
    writeSecureFile(installationIdFile, installationId);
  }

  /**
   * Retrieves the installation ID from a file, creating it if it doesn't exist.
   * This ID is used for unique user installation tracking.
   * @returns A UUID string for the user.
   */
  getInstallationId(): string {
    try {
      let installationId = this.readInstallationIdFromFile();

      if (!installationId) {
        installationId = randomUUID();
        this.writeInstallationIdToFile(installationId);
      }

      return installationId;
    } catch (error) {
      console.error(
        'Error accessing installation ID file, generating ephemeral ID:',
        error,
      );
      return '123456789';
    }
  }
}
