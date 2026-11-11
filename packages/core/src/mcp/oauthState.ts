/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Process-level record of servers whose last connect requires authorization.
// It is deliberately separate from connection status: a server parks in
// AUTH_REQUIRED on its McpClient, while CLI commands that probe configs before
// any client exists still need to know the server asked for credentials.

export const mcpServerRequiresOAuth: Map<string, boolean> = new Map();
