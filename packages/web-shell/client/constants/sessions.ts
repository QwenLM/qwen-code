/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared session configuration used by Web Shell surfaces so pagination and
 * retention limits cannot drift between the main and split views.
 */
export const SESSION_LIST_PAGE_SIZE = 1000;
export const SIDEBAR_SESSION_PREVIEW_LIMIT = 5;
export const SESSION_ORGANIZATION_FEATURE = 'session_organization';
export const SESSION_LIVE_STATE_FEATURE = 'workspace_session_live_state';
export const SESSION_TRANSCRIPT_PAGINATION_FEATURE =
  'session_transcript_pagination';
export const SESSION_MONITOR_TOOL_CORRELATION_FEATURE =
  'session_monitor_tool_correlation';
export const SESSION_TASK_OUTPUT_FEATURE = 'session_task_output';
export const SESSION_SIDE_TASK_FEATURE = 'session_side_task';
export const WEB_SHELL_SESSION_SOURCE_TYPE = 'default';
export const WEB_SHELL_SIDE_TASK_SOURCE_TYPE = 'side_task';
export const WEB_SHELL_HISTORY_PAGE_SIZE = 200;
export const WEB_SHELL_TRANSCRIPT_RELOAD_BLOCKS = 500;

/**
 * Upper bound on transcript blocks retained in memory per Web Shell session
 * (the main chat and each split pane). The daemon stays the authoritative
 * full-transcript source; this only caps the client's in-memory window.
 *
 * Intentionally equal to the provider's `DEFAULT_MAX_BLOCKS`; the equality is
 * enforced by `sessions.test.ts` (importing the constant here instead of the
 * provider would pull the webui barrel into every importer's module graph and
 * break the enumerative `daemon-react-sdk` mocks in component tests). Bounding
 * the window keeps very long sessions responsive: the per-dispatch reducer
 * cost (a full block-array copy) and the full-list message normalization turn
 * a burst of buffered SSE events — e.g. the stream catching up when the tab
 * returns from being hidden — into a long main-thread block on large
 * transcripts.
 */
export const WEB_SHELL_MAX_TRANSCRIPT_BLOCKS = 50_000;
