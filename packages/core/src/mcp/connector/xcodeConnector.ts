/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { XcodeMcpBridgeFixTransport } from './transport/xcode-fix.js';
import type {
  McpConnectOutcome,
  McpConnectRequest,
  McpConnector,
  McpConnectorContext,
} from './types.js';

/**
 * Decorates another connector's transport to repair a non-compliant server's
 * responses. Usable on its own in a connector map, or — as the default stdio
 * slot does — selected per config.
 */
export class XcodeMcpConnector implements McpConnector {
  constructor(private readonly inner: McpConnector) {}

  async connect(
    request: McpConnectRequest,
    ctx: McpConnectorContext,
  ): Promise<McpConnectOutcome> {
    const { transport } = await this.inner.connect(request, ctx);
    return { transport: new XcodeMcpBridgeFixTransport(transport) };
  }
}
