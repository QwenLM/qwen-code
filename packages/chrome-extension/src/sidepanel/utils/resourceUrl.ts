/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Extend Window interface to include __EXTENSION_URI__
declare global {
  interface Window {
    __EXTENSION_URI__?: string;
  }
}

/**
 * Get the extension URI from the body data attribute or window global
 * @returns Extension URI or undefined if not found
 */
function getExtensionUri(): string | undefined {
  // First try to get from window (for backwards compatibility)
  if (window.__EXTENSION_URI__) {
    return window.__EXTENSION_URI__;
  }

  // Then try to get from body data attribute (CSP-compliant method)
  const bodyUri = document.body?.getAttribute('data-extension-uri');
  if (bodyUri) {
    // Cache it in window for future use
    window.__EXTENSION_URI__ = bodyUri;
    return bodyUri;
  }

  return undefined;
}

/**
 * Validate if URL is a secure VS Code webview resource URL
 * Prevent XSS attacks
 *
 * @param url - URL to validate
 * @returns Whether it is a secure URL
 */
function isValidWebviewUrl(url: string): boolean {
  try {
    // Valid protocols for VS Code webview resource URLs
    const allowedProtocols = [
      'vscode-webview-resource:',
      'https-vscode-webview-resource:',
      'vscode-file:',
      'https:',
    ];

    // Check if it starts with a valid protocol
    return allowedProtocols.some((protocol) => url.startsWith(protocol));
  } catch {
    return false;
  }
}

/**
 * Generate a resource URL for webview access
 * Similar to the pattern used in other VSCode extensions
 *
 * @param relativePath - Relative path from extension root (e.g., 'assets/icon.png')
 * @returns Full webview-accessible URL (empty string if validation fails)
 *
 * @example
 * ```tsx
 * <img src={generateResourceUrl('assets/icon.png')} />
 * ```
 */
export function generateResourceUrl(relativePath: string): string {
  const extensionUri = getExtensionUri();

  if (!extensionUri) {
    console.warn('[resourceUrl] Extension URI not found in window or body');
    return '';
  }

  // Validate if extensionUri is a secure URL
  if (!isValidWebviewUrl(extensionUri)) {
    console.error(
      '[resourceUrl] Invalid extension URI - possible security risk:',
      extensionUri,
    );
    return '';
  }

  // Remove leading slash if present
  const cleanPath = relativePath.startsWith('/')
    ? relativePath.slice(1)
    : relativePath;

  // Ensure extension URI has trailing slash
  const baseUri = extensionUri.endsWith('/')
    ? extensionUri
    : `${extensionUri}/`;

  const fullUrl = `${baseUri}${cleanPath}`;

  // Validate if the final generated URL is secure
  if (!isValidWebviewUrl(fullUrl)) {
    console.error('[resourceUrl] Generated URL failed validation:', fullUrl);
    return '';
  }

  return fullUrl;
}

/**
 * Shorthand for generating icon URLs
 * @param iconPath - Path relative to assets directory
 */
export function generateIconUrl(iconPath: string): string {
  return generateResourceUrl(`assets/${iconPath}`);
}
