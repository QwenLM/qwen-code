/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TelemetryTarget } from './index.js';

export interface TelemetryRuntimeConfig {
  getTelemetryEnabled(): boolean;
  getTelemetryOtlpEndpoint(): string | undefined;
  getTelemetryOtlpProtocol(): 'grpc' | 'http';
  getTelemetryOtlpTracesEndpoint(): string | undefined;
  getTelemetryOtlpLogsEndpoint(): string | undefined;
  getTelemetryOtlpMetricsEndpoint(): string | undefined;
  getTelemetryTarget(): TelemetryTarget;
  getTelemetryOutfile(): string | undefined;
  getTelemetryIncludeSensitiveSpanAttributes(): boolean;
  getTelemetryResourceAttributes(): Record<string, string>;
  getTelemetryMetricsIncludeSessionId(): boolean;
  getTelemetryResourceAttributeWarnings(): readonly string[];
  getCliVersion(): string | undefined;
  getSessionId(): string;
  isInteractive(): boolean;
  getOutboundCorrelationPropagateTraceContext(): boolean;
}
