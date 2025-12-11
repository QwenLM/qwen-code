/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import semver from 'semver';
import { CliDetector, type CliDetectionResult } from './cliDetector.js';

export const MIN_CLI_VERSION_FOR_SESSION_METHODS = '0.4.0';

export interface CliFeatureFlags {
  supportsSessionList: boolean;
  supportsSessionLoad: boolean;
}

export interface CliVersionInfo {
  version: string | undefined;
  isSupported: boolean;
  features: CliFeatureFlags;
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

    // Use semver for robust comparison (handles v-prefix, pre-release, etc.)
    const v = semver.valid(version) ?? semver.coerce(version)?.version ?? null;
    const min =
      semver.valid(minVersion) ?? semver.coerce(minVersion)?.version ?? null;

    if (!v || !min) {
      console.warn(
        `[CliVersionManager] Invalid semver: version=${version}, min=${minVersion}`,
      );
      return false;
    }
    console.log(`[CliVersionManager] Version ${v} meets requirements: ${min}`);
    return semver.gte(v, min);
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
}
