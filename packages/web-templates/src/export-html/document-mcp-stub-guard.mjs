/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const DOCUMENT_MCP_APP_BRIDGE_STUB = '/document-mcp-app-bridge-stub.ts';

export function hasDocumentMcpAppBridgeStubInput(inputs) {
  return inputs.some((input) =>
    input.replaceAll('\\', '/').endsWith(DOCUMENT_MCP_APP_BRIDGE_STUB),
  );
}
