/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * This module handles installation of extensions from Claude marketplaces.
 *
 * A marketplace URL format: marketplace-url:plugin-name
 * Example: https://github.com/example/marketplace:my-plugin
 */

import type { ExtensionConfig } from './extensionManager.js';
import type { ExtensionInstallMetadata } from '../config/config.js';

export interface MarketplaceInstallOptions {
  marketplaceUrl: string;
  pluginName: string;
  tempDir: string;
  requestConsent: (consent: string) => Promise<boolean>;
}

export interface MarketplaceInstallResult {
  config: ExtensionConfig;
  sourcePath: string;
  installMetadata: ExtensionInstallMetadata;
}

/**
 * Parse marketplace install source string.
 * Format: marketplace-url:plugin-name
 */
export function parseMarketplaceSource(source: string): {
  marketplaceSource: string;
  pluginName: string;
} | null {
  // Check if source contains a colon separator
  const lastColonIndex = source.lastIndexOf(':');
  if (lastColonIndex === -1) {
    return null;
  }

  // Split at the last colon to separate URL from plugin name
  const marketplaceSource = source.substring(0, lastColonIndex);
  const pluginName = source.substring(lastColonIndex + 1);

  // Validate that marketplace URL looks like a URL
  if (
    !marketplaceSource.startsWith('http://') &&
    !marketplaceSource.startsWith('https://')
  ) {
    return null;
  }

  if (!pluginName || pluginName.length === 0) {
    return null;
  }

  return { marketplaceSource, pluginName };
}
