/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CliFeatureFlags, CliVersionInfo } from './cliVersionManager.js';

/**
 * CLI Context Manager
 *
 * Manages the current CLI context including version information and feature availability
 */
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
   * Get current CLI version information
   *
   * @returns Current CLI version information or null if not set
   */
  getCurrentVersionInfo(): CliVersionInfo | null {
    return this.currentVersionInfo;
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
      supportsSessionSave: false,
    };
  }

  /**
   * Check if current CLI supports session/list method
   *
   * @returns Whether session/list is supported
   */
  supportsSessionList(): boolean {
    return this.getCurrentFeatures().supportsSessionList;
  }

  /**
   * Check if current CLI supports session/load method
   *
   * @returns Whether session/load is supported
   */
  supportsSessionLoad(): boolean {
    return this.getCurrentFeatures().supportsSessionLoad;
  }

  /**
   * Check if current CLI supports session/save method
   *
   * @returns Whether session/save is supported
   */
  supportsSessionSave(): boolean {
    return this.getCurrentFeatures().supportsSessionSave;
  }

  /**
   * Check if CLI is installed and detected
   *
   * @returns Whether CLI is installed
   */
  isCliInstalled(): boolean {
    return this.currentVersionInfo?.detectionResult.isInstalled ?? false;
  }

  /**
   * Get CLI version string
   *
   * @returns CLI version string or undefined if not detected
   */
  getCliVersion(): string | undefined {
    return this.currentVersionInfo?.version;
  }

  /**
   * Check if CLI version is supported
   *
   * @returns Whether CLI version is supported
   */
  isCliVersionSupported(): boolean {
    return this.currentVersionInfo?.isSupported ?? false;
  }

  /**
   * Clear current CLI context
   */
  clearContext(): void {
    this.currentVersionInfo = null;
  }
}
