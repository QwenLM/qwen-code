/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { Storage } from '../config/storage.js';
import { runLogger } from './runLogger.js';

let installationIdCreatedThisProcess = false;

export function wasInstallationIdCreatedThisProcess(): boolean {
  return installationIdCreatedThisProcess;
}

export class InstallationManager {
  // Installation identity is stable for the lifetime of a CLI process. Keep
  // filesystem access off repeated telemetry and model-request hot paths.
  private cachedInstallationId: string | undefined;

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
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(installationIdFile, installationId, 'utf-8');
  }

  /**
   * Retrieves the installation ID from a file, creating it if it doesn't exist.
   * This ID is used for unique user installation tracking.
   * @returns A UUID string for the user.
   */
  getInstallationId(): string {
    if (this.cachedInstallationId !== undefined) {
      return this.cachedInstallationId;
    }

    try {
      let installationId = this.readInstallationIdFromFile();

      if (!installationId) {
        installationId = randomUUID();
        this.writeInstallationIdToFile(installationId);
        installationIdCreatedThisProcess = true;
      }

      this.cachedInstallationId = installationId;
      return this.cachedInstallationId;
    } catch (error) {
      runLogger.warn(
        'Error accessing installation ID file, generating ephemeral ID:',
        error,
      );
      this.cachedInstallationId = '123456789';
      return this.cachedInstallationId;
    }
  }
}
