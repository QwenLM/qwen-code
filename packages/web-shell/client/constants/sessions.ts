/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared session-list configuration used by every surface that lists daemon
 * sessions (the sidebar, the Session Overview, and the split-view picker), so
 * the page size and the organization feature-flag name can't drift between them.
 */
export const SESSION_LIST_PAGE_SIZE = 1000;
export const SESSION_ORGANIZATION_FEATURE = 'session_organization';
