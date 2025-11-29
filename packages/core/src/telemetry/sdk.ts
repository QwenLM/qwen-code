/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * TELEMETRY REMOVED FOR OFFLINE/AIR-GAPPED USE
 *
 * All telemetry functionality has been removed from this fork.
 * Only minimal stubs remain for API compatibility.
 */

import type { Config } from '../config/config.js';

/**
 * TELEMETRY REMOVED FOR OFFLINE/AIR-GAPPED USE
 *
 * Always returns false since telemetry is completely removed.
 */
export function isTelemetrySdkInitialized(): boolean {
  return false;
}

/**
 * TELEMETRY REMOVED FOR OFFLINE/AIR-GAPPED USE
 *
 * This function is a stub that does nothing. All telemetry code has been removed
 * to ensure no data can be transmitted, even accidentally.
 */
export function initializeTelemetry(_config: Config): void {
  // No-op: Telemetry completely removed for air-gapped environments
}

/**
 * TELEMETRY REMOVED FOR OFFLINE/AIR-GAPPED USE
 *
 * This function is a stub that does nothing. All telemetry code has been removed.
 */
export async function shutdownTelemetry(_config: Config): Promise<void> {
  // No-op: Telemetry completely removed for air-gapped environments
}
