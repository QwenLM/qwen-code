/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Control Request Types
 *
 * Centralized enum for all control request subtypes supported by the CLI.
 * This enum should be kept in sync with the controllers in:
 * - packages/cli/src/services/control/controllers/systemController.ts
 * - packages/cli/src/services/control/controllers/permissionController.ts
 * - packages/cli/src/services/control/controllers/mcpController.ts
 * - packages/cli/src/services/control/controllers/hookController.ts
 */
export enum ControlRequestType {
  // SystemController requests
  INITIALIZE = 'initialize',
  INTERRUPT = 'interrupt',
  SET_MODEL = 'set_model',
  SUPPORTED_COMMANDS = 'supported_commands',

  // PermissionController requests
  CAN_USE_TOOL = 'can_use_tool',
  SET_PERMISSION_MODE = 'set_permission_mode',

  // MCPController requests
  MCP_MESSAGE = 'mcp_message',
  MCP_SERVER_STATUS = 'mcp_server_status',

  // HookController requests
  HOOK_CALLBACK = 'hook_callback',
}

/**
 * Get all available control request types as a string array
 */
export function getAllControlRequestTypes(): string[] {
  return Object.values(ControlRequestType);
}

/**
 * Check if a string is a valid control request type
 */
export function isValidControlRequestType(
  type: string,
): type is ControlRequestType {
  return getAllControlRequestTypes().includes(type);
}
