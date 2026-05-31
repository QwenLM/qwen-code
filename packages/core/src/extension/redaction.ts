/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const REDACTED_URL_CREDENTIAL = '***REDACTED***';

const URL_CREDENTIALS_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^/\s]+@)+/gi;

/**
 * Redacts userinfo credentials from URL-like extension sources for logs,
 * telemetry, and display. This also handles diagnostic messages that contain
 * credentialed URLs. The original source should still be preserved for
 * installation and update operations.
 */
export function redactUrlCredentials(source: string): string {
  return source.replace(
    URL_CREDENTIALS_PATTERN,
    `$1${REDACTED_URL_CREDENTIAL}@`,
  );
}
