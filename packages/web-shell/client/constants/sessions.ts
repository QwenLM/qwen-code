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
export const SESSION_ORGANIZATION_FEATURE = 'session_organization';
export const WEB_SHELL_SESSION_SOURCE_TYPE = 'default';
export const WEB_SHELL_HISTORY_PAGE_SIZE = 100;

/**
 * Upper bound on transcript blocks retained in memory per Web Shell session
 * (the main chat and each split pane). The daemon stays the authoritative
 * full-transcript source; this only caps the client's in-memory window.
 *
 * The SDK default (200_000) is far beyond what the virtualized message list
 * renders, and it inflates both the per-dispatch reducer cost (a full
 * block-array copy) and the full-list message normalization. On a large
 * transcript that turns a burst of buffered SSE events — e.g. the stream
 * catching up when the tab returns from being hidden — into a multi-minute
 * main-thread block. Bounding the window keeps very long sessions responsive.
 */
export const WEB_SHELL_MAX_TRANSCRIPT_BLOCKS = 50_000;
