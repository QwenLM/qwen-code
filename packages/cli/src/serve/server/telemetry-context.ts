/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Response } from 'express';

// This module must stay import-light: the access log (inside the serve
// fast-path's pre-listen static closure) reads the captured trace id from
// here, so it cannot reach the telemetry middleware's core import graph.
export interface DaemonTelemetryResponseContext {
  workspaceCwd?: string;
  /**
   * Caller trace id from a valid inbound `traceparent` header, captured with
   * telemetry disabled (with telemetry on the request span already carries
   * it into the log line's trace prefix). Consumed by the access log for the
   * no-backend log-based join.
   */
  inboundTraceId?: string;
}

export const daemonTelemetryResponseContext = Symbol(
  'daemonTelemetryResponseContext',
);

export type TelemetryResponse = Response & {
  [daemonTelemetryResponseContext]?: DaemonTelemetryResponseContext;
};

/**
 * The caller trace id captured from a valid inbound `traceparent` header when
 * telemetry is disabled. The access log reads it so a request's log line
 * still joins with the caller's logs (or trace backend) with no daemon-side
 * telemetry at all.
 */
export function getDaemonTelemetryInboundTraceId(
  res: Response,
): string | undefined {
  try {
    return (res as TelemetryResponse)[daemonTelemetryResponseContext]
      ?.inboundTraceId;
  } catch {
    return undefined;
  }
}
