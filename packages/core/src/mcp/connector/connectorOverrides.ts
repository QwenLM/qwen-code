/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { McpConnector } from './types.js';

/**
 * Wraps a connector with per-connection contributions without changing its
 * transport. The pool uses this to attach the reporter that receives the
 * connection's progress notifications.
 */
export function withConnectorOverrides(
  connector: McpConnector,
  overrides: Pick<McpConnector, 'progressReporter'>,
): McpConnector {
  return {
    connect: (request, ctx) => connector.connect(request, ctx),
    clientExtensions: connector.clientExtensions?.bind(connector),
    authenticate: connector.authenticate?.bind(connector),
    progressReporter: overrides.progressReporter ?? connector.progressReporter,
  };
}
