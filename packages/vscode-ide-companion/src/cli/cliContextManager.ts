/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CliFeatureFlags, CliVersionInfo } from './cliVersionManager.js';

export class CliContextManager {
  private static instance: CliContextManager;
  private currentVersionInfo: CliVersionInfo | null = null;

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): CliContextManager {
    if (!CliContextManager.instance) {
      CliContextManager.instance = new CliContextManager();
    }
    return CliContextManager.instance;
  }

  /**
   * Set current CLI version information
   *
   * @param versionInfo - CLI version information
   */
  setCurrentVersionInfo(versionInfo: CliVersionInfo): void {
    this.currentVersionInfo = versionInfo;
  }

  /**
   * Get current CLI feature flags
   *
   * @returns Current CLI feature flags or default flags if not set
   */
  getCurrentFeatures(): CliFeatureFlags {
    if (this.currentVersionInfo) {
      return this.currentVersionInfo.features;
    }

    // Return default feature flags (all disabled)
    return {
      supportsSessionList: false,
      supportsSessionLoad: false,
    };
  }

  supportsSessionList(): boolean {
    return this.getCurrentFeatures().supportsSessionList;
  }

  supportsSessionLoad(): boolean {
    return this.getCurrentFeatures().supportsSessionLoad;
  }
}
