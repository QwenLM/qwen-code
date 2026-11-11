/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { HttpMcpConnector } from './httpConnector.js';
import { SdkHostedMcpConnector } from './sdkHostedConnector.js';
import { StdioMcpConnector } from './stdioConnector.js';
import { XcodeMcpConnector } from './xcodeConnector.js';
import type { McpConnector, McpConnectorMap } from './types.js';
import type { McpTransportType } from './transportType.js';

/** The connector set of a CLI with no host contribution. */
export function createDefaultMcpConnectorMap(): McpConnectorMap {
  return new Map<McpTransportType, McpConnector>([
    ['stdio', new StdioMcpConnector()],
    ['xcode', new XcodeMcpConnector(new StdioMcpConnector())],
    ['http', new HttpMcpConnector()],
    ['sdk-hosted', new SdkHostedMcpConnector()],
  ]);
}
