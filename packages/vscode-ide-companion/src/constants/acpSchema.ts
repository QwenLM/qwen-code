/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
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
  session_set_mode: 'session/set_mode',
} as const;

export const CLIENT_METHODS = {
  fs_read_text_file: 'fs/read_text_file',
  fs_write_text_file: 'fs/write_text_file',
  session_request_permission: 'session/request_permission',
  session_update: 'session/update',
} as const;
