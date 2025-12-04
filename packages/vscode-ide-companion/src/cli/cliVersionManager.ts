/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { CliDetector, type CliDetectionResult } from './cliDetector.js';

/**
 * Minimum CLI version that supports session/list and session/load ACP methods
 */
export const MIN_CLI_VERSION_FOR_SESSION_METHODS = '0.2.4';

/**
 * CLI Feature Flags based on version
 */
export interface CliFeatureFlags {
  /**
   * Whether the CLI supports session/list ACP method
   */
  supportsSessionList: boolean;

  /**
   * Whether the CLI supports session/load ACP method
   */
  supportsSessionLoad: boolean;

  /**
   * Whether the CLI supports session/save ACP method
   */
  supportsSessionSave: boolean;
}

/**
 * CLI Version Information
 */
export interface CliVersionInfo {
  /**
   * Detected version string
   */
  version: string | undefined;

  /**
   * Whether the version meets the minimum requirement
   */
  isSupported: boolean;

  /**
   * Feature flags based on version
   */
  features: CliFeatureFlags;

  /**
   * Raw detection result
   */
  detectionResult: CliDetectionResult;
}

/**
 * CLI Version Manager
 *
 * Manages CLI version detection and feature availability based on version
 */
export class CliVersionManager {
  private static instance: CliVersionManager;
  private cachedVersionInfo: CliVersionInfo | null = null;
  private lastCheckTime: number = 0;
  private static readonly CACHE_DURATION_MS = 30000; // 30 seconds

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): CliVersionManager {
    if (!CliVersionManager.instance) {
      CliVersionManager.instance = new CliVersionManager();
    }
    return CliVersionManager.instance;
  }

  /**
   * Check if CLI version meets minimum requirements
   *
   * @param version - Version string to check
   * @param minVersion - Minimum required version
   * @returns Whether version meets requirements
   */
  private isVersionSupported(
    version: string | undefined,
    minVersion: string,
  ): boolean {
    if (!version) {
      return false;
    }

    // Simple version comparison (assuming semantic versioning)
    try {
      const versionParts = version.split('.').map(Number);
      const minVersionParts = minVersion.split('.').map(Number);

      for (
        let i = 0;
        i < Math.min(versionParts.length, minVersionParts.length);
        i++
      ) {
        if (versionParts[i] > minVersionParts[i]) {
          return true;
        } else if (versionParts[i] < minVersionParts[i]) {
          return false;
        }
      }

      // If all compared parts are equal, check if version has more parts
      return versionParts.length >= minVersionParts.length;
    } catch (error) {
      console.error('[CliVersionManager] Failed to parse version:', error);
      return false;
    }
  }

  /**
   * Get feature flags based on CLI version
   *
   * @param version - CLI version string
   * @returns Feature flags
   */
  private getFeatureFlags(version: string | undefined): CliFeatureFlags {
    const isSupportedVersion = this.isVersionSupported(
      version,
      MIN_CLI_VERSION_FOR_SESSION_METHODS,
    );

    return {
      supportsSessionList: isSupportedVersion,
      supportsSessionLoad: isSupportedVersion,
      supportsSessionSave: false, // Not yet supported in any version
    };
  }

  /**
   * Detect CLI version and features
   *
   * @param forceRefresh - Force a new check, ignoring cache
   * @returns CLI version information
   */
  async detectCliVersion(forceRefresh = false): Promise<CliVersionInfo> {
    const now = Date.now();

    // Return cached result if available and not expired
    if (
      !forceRefresh &&
      this.cachedVersionInfo &&
      now - this.lastCheckTime < CliVersionManager.CACHE_DURATION_MS
    ) {
      console.log('[CliVersionManager] Returning cached version info');
      return this.cachedVersionInfo;
    }

    console.log('[CliVersionManager] Detecting CLI version...');

    try {
      // Detect CLI installation
      const detectionResult = await CliDetector.detectQwenCli(forceRefresh);

      const versionInfo: CliVersionInfo = {
        version: detectionResult.version,
        isSupported: this.isVersionSupported(
          detectionResult.version,
          MIN_CLI_VERSION_FOR_SESSION_METHODS,
        ),
        features: this.getFeatureFlags(detectionResult.version),
        detectionResult,
      };

      // Cache the result
      this.cachedVersionInfo = versionInfo;
      this.lastCheckTime = now;

      console.log(
        '[CliVersionManager] CLI version detection result:',
        versionInfo,
      );

      return versionInfo;
    } catch (error) {
      console.error('[CliVersionManager] Failed to detect CLI version:', error);

      // Return fallback result
      const fallbackResult: CliVersionInfo = {
        version: undefined,
        isSupported: false,
        features: {
          supportsSessionList: false,
          supportsSessionLoad: false,
          supportsSessionSave: false,
        },
        detectionResult: {
          isInstalled: false,
          error: error instanceof Error ? error.message : String(error),
        },
      };

      return fallbackResult;
    }
  }

  /**
   * Clear cached version information
   */
  clearCache(): void {
    this.cachedVersionInfo = null;
    this.lastCheckTime = 0;
    CliDetector.clearCache();
  }

  /**
   * Check if CLI supports session/list method
   *
   * @param forceRefresh - Force a new check, ignoring cache
   * @returns Whether session/list is supported
   */
  async supportsSessionList(forceRefresh = false): Promise<boolean> {
    const versionInfo = await this.detectCliVersion(forceRefresh);
    return versionInfo.features.supportsSessionList;
  }

  /**
   * Check if CLI supports session/load method
   *
   * @param forceRefresh - Force a new check, ignoring cache
   * @returns Whether session/load is supported
   */
  async supportsSessionLoad(forceRefresh = false): Promise<boolean> {
    const versionInfo = await this.detectCliVersion(forceRefresh);
    return versionInfo.features.supportsSessionLoad;
  }

  /**
   * Check if CLI supports session/save method
   *
   * @param forceRefresh - Force a new check, ignoring cache
   * @returns Whether session/save is supported
   */
  async supportsSessionSave(forceRefresh = false): Promise<boolean> {
    const versionInfo = await this.detectCliVersion(forceRefresh);
    return versionInfo.features.supportsSessionSave;
  }
}
