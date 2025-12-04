/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ACP (Agent Communication Protocol) Method Definitions
 *
 * This file defines the protocol methods for communication between
 * the VSCode extension (Client) and the qwen CLI (Agent/Server).
 */

/**
 * Methods that the Agent (CLI) implements and receives from Client (VSCode)
 *
 * Status in qwen CLI:
 * ✅ initialize - Protocol initialization
 * ✅ authenticate - User authentication
 * ✅ session/new - Create new session
 * ✅ session/load - Load existing session (v0.2.4+)
 * ✅ session/list - List available sessions (v0.2.4+)
 * ✅ session/prompt - Send user message to agent
 * ✅ session/cancel - Cancel current generation
 * ✅ session/save - Save current session
 */
export const AGENT_METHODS = {
  authenticate: 'authenticate',
  initialize: 'initialize',
  session_cancel: 'session/cancel',
  session_list: 'session/list',
  session_load: 'session/load',
  session_new: 'session/new',
  session_prompt: 'session/prompt',
  session_save: 'session/save',
} as const;

/**
 * Methods that the Client (VSCode) implements and receives from Agent (CLI)
 *
 * Status in VSCode extension:
 * ✅ fs/read_text_file - Read file content
 * ✅ fs/write_text_file - Write file content
 * ✅ session/request_permission - Request user permission for tool execution
 * ✅ session/update - Stream session updates (notification)
 */
export const CLIENT_METHODS = {
  fs_read_text_file: 'fs/read_text_file',
  fs_write_text_file: 'fs/write_text_file',
  session_request_permission: 'session/request_permission',
  session_update: 'session/update',
} as const;

/**
 * Custom methods (not in standard ACP protocol)
 * These are VSCode extension specific extensions
 */
export const CUSTOM_METHODS = {
  session_list: 'session/list',
} as const;
