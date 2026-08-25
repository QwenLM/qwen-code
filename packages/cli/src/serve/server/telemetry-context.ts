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
}

export const daemonTelemetryResponseContext = Symbol(
  'daemonTelemetryResponseContext',
);

export type TelemetryResponse = Response & {
  [daemonTelemetryResponseContext]?: DaemonTelemetryResponseContext;
};

// The captured caller trace id lives under its own symbol: the presence of
// the telemetry response context doubles as the opt-in gate for
// handler-resolved workspace attribution (see setDaemonTelemetryWorkspace),
// so capturing a trace id must never create it — otherwise a caller merely
// sending a traceparent header would silently change span attribution.
export const daemonInboundTraceIdContext = Symbol(
  'daemonInboundTraceIdContext',
);

export type InboundTraceIdResponse = Response & {
  [daemonInboundTraceIdContext]?: string;
};

/**
 * The caller trace id captured from a valid inbound `traceparent` header,
 * in both telemetry modes. The access log reads it so a request's log line
 * still joins with the caller's logs (or trace backend) with no daemon-side
 * telemetry at all.
 */
export function getDaemonTelemetryInboundTraceId(
  res: Response,
): string | undefined {
  try {
    return (res as InboundTraceIdResponse)[daemonInboundTraceIdContext];
  } catch {
    return undefined;
  }
}
