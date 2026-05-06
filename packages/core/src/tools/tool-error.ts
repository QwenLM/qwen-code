/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A type-safe enum for tool-related errors.
 */
export enum ToolErrorType {
  // General Errors
  INVALID_TOOL_PARAMS = 'invalid_tool_params',
  UNKNOWN = 'unknown',
  UNHANDLED_EXCEPTION = 'unhandled_exception',
  TOOL_NOT_REGISTERED = 'tool_not_registered',
  EXECUTION_FAILED = 'execution_failed',
  // Try to execute a tool that is excluded due to the approval mode
  EXECUTION_DENIED = 'execution_denied',

  // File System Errors
  FILE_NOT_FOUND = 'file_not_found',
  FILE_WRITE_FAILURE = 'file_write_failure',
  READ_CONTENT_FAILURE = 'read_content_failure',
  ATTEMPT_TO_CREATE_EXISTING_FILE = 'attempt_to_create_existing_file',
  FILE_TOO_LARGE = 'file_too_large',
  PERMISSION_DENIED = 'permission_denied',
  NO_SPACE_LEFT = 'no_space_left',
  TARGET_IS_DIRECTORY = 'target_is_directory',
  PATH_NOT_IN_WORKSPACE = 'path_not_in_workspace',
  SEARCH_PATH_NOT_FOUND = 'search_path_not_found',
  SEARCH_PATH_NOT_A_DIRECTORY = 'search_path_not_a_directory',

  // Edit-specific Errors
  EDIT_PREPARATION_FAILURE = 'edit_preparation_failure',
  EDIT_NO_OCCURRENCE_FOUND = 'edit_no_occurrence_found',
  EDIT_EXPECTED_OCCURRENCE_MISMATCH = 'edit_expected_occurrence_mismatch',
  EDIT_NO_CHANGE = 'edit_no_change',
  EDIT_NO_CHANGE_LLM_JUDGEMENT = 'edit_no_change_llm_judgement',
  // Returned when Edit / WriteFile is asked to mutate a file in a
  // state the session-scoped FileReadCache cannot vouch for. Three
  // cases share this code:
  //
  //   1. The file has not been read this session via ReadFile (the
  //      original "model never saw the bytes" case).
  //   2. The file was read only as a partial / ranged / truncated
  //      view, so the model has not seen the full text content the
  //      mutation could touch.
  //   3. The file is a structural dead end that no amount of
  //      re-reading can change:
  //        - non-text payloads (binary / image / audio / video /
  //          PDF / notebook) — read_file returns these as
  //          structured values that Edit / WriteFile cannot mutate
  //          safely; the rejection message tells the model to use
  //          a different tool (shell with a binary-aware writer).
  //        - special files (FIFO / socket / character or block
  //          device) — read_file rejects these as "not a regular
  //          file", so an enforcement loop on read_file would
  //          never terminate; the rejection points the model at
  //          shell instead.
  //
  // Despite the `EDIT_` prefix this code is shared between EditTool
  // and WriteFileTool: the boundary it guards is "the model is about
  // to mutate bytes it has not legitimately seen", which both tools
  // can hit. The prefix is kept for backwards-compatibility with
  // logs/dashboards already keyed on it; consumers that need to
  // distinguish edit-vs-write should look at the originating tool
  // name in the surrounding ToolCallEvent rather than the error
  // code itself.
  //
  // Note for operators routing alerts: a single `edit_requires_prior_read`
  // signal can mean any of the three cases above. If per-cause monitoring
  // becomes important, splitting this into separate codes (e.g.
  // `EDIT_NO_PRIOR_READ`, `EDIT_PARTIAL_PRIOR_READ`,
  // `EDIT_TARGET_NOT_TEXT_EDITABLE`) is a follow-up; for now the
  // originating tool name and the message text already disambiguate.
  EDIT_REQUIRES_PRIOR_READ = 'edit_requires_prior_read',
  // Returned when Edit / WriteFile is asked to mutate a file the model
  // *has* read this session, but the on-disk bytes have changed since
  // (mtime or size differs from the recorded fingerprint). The model
  // is expected to re-read with ReadFile to refresh its mental model
  // before retrying the edit.
  FILE_CHANGED_SINCE_READ = 'file_changed_since_read',
  // Returned when Edit / WriteFile cannot determine whether the model
  // has read a file because `fs.stat` itself failed for a reason
  // other than ENOENT (typically EACCES, EBUSY, or an NFS hiccup).
  // Distinct from EDIT_REQUIRES_PRIOR_READ ("definitely not read")
  // because the model may have legitimately read the file — we just
  // cannot verify. Operators monitoring on error codes can route this
  // separately.
  PRIOR_READ_VERIFICATION_FAILED = 'prior_read_verification_failed',

  // Glob-specific Errors
  GLOB_EXECUTION_ERROR = 'glob_execution_error',

  // Grep-specific Errors
  GREP_EXECUTION_ERROR = 'grep_execution_error',

  // Ls-specific Errors
  LS_EXECUTION_ERROR = 'ls_execution_error',
  PATH_IS_NOT_A_DIRECTORY = 'path_is_not_a_directory',

  // MCP-specific Errors
  MCP_TOOL_ERROR = 'mcp_tool_error',

  // Memory-specific Errors
  MEMORY_TOOL_EXECUTION_ERROR = 'memory_tool_execution_error',

  // Shell errors
  SHELL_EXECUTE_ERROR = 'shell_execute_error',

  // DiscoveredTool-specific Errors
  DISCOVERED_TOOL_EXECUTION_ERROR = 'discovered_tool_execution_error',

  // WebFetch-specific Errors
  WEB_FETCH_NO_URL_IN_PROMPT = 'web_fetch_no_url_in_prompt',
  WEB_FETCH_FALLBACK_FAILED = 'web_fetch_fallback_failed',
  WEB_FETCH_PROCESSING_ERROR = 'web_fetch_processing_error',

  // Truncation Errors
  OUTPUT_TRUNCATED = 'output_truncated',

  // TaskStop-specific Errors
  TASK_STOP_NOT_FOUND = 'task_stop_not_found',
  TASK_STOP_NOT_RUNNING = 'task_stop_not_running',
  TASK_STOP_NOT_CANCELLABLE = 'task_stop_not_cancellable',
  TASK_STOP_INTERNAL_ERROR = 'task_stop_internal_error',

  // SendMessage-specific Errors
  SEND_MESSAGE_NOT_FOUND = 'send_message_not_found',
  SEND_MESSAGE_NOT_RUNNING = 'send_message_not_running',
}
