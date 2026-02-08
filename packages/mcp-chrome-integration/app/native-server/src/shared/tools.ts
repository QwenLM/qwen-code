/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Tool } from '@modelcontextprotocol/sdk/types.js';

// Re-export schema modules
export { BASIC_SCHEMAS } from './browser-basic-schemas.js';
export { ELEMENT_SCHEMAS } from './browser-element-schemas.js';
export { PAGE_SCHEMAS } from './browser-page-schemas.js';
export { NETWORK_SCHEMAS } from './browser-network-schemas.js';
export { BOOKMARK_SCHEMAS } from './browser-bookmark-schemas.js';
export { ADVANCED_SCHEMAS } from './browser-advanced-schemas.js';
export { PERFORMANCE_SCHEMAS } from './browser-performance-schemas.js';

export const TOOL_NAMES = {
  BROWSER: {
    GET_WINDOWS_AND_TABS: 'get_windows_and_tabs',
    NAVIGATE: 'chrome_navigate',
    SCREENSHOT: 'chrome_screenshot',
    CLOSE_TABS: 'chrome_close_tabs',
    SWITCH_TAB: 'chrome_switch_tab',
    WEB_FETCHER: 'chrome_get_web_content',
    CLICK: 'chrome_click_element',
    FILL: 'chrome_fill_or_select',
    REQUEST_ELEMENT_SELECTION: 'chrome_request_element_selection',
    GET_INTERACTIVE_ELEMENTS: 'chrome_get_interactive_elements',
    NETWORK_CAPTURE: 'chrome_network_capture',
    // Legacy tool names (kept for internal use, not exposed in TOOL_SCHEMAS)
    NETWORK_CAPTURE_START: 'chrome_network_capture_start',
    NETWORK_CAPTURE_STOP: 'chrome_network_capture_stop',
    NETWORK_REQUEST: 'chrome_network_request',
    NETWORK_DEBUGGER_START: 'chrome_network_debugger_start',
    NETWORK_DEBUGGER_STOP: 'chrome_network_debugger_stop',
    KEYBOARD: 'chrome_keyboard',
    HISTORY: 'chrome_history',
    BOOKMARK_SEARCH: 'chrome_bookmark_search',
    BOOKMARK_ADD: 'chrome_bookmark_add',
    BOOKMARK_DELETE: 'chrome_bookmark_delete',
    INJECT_SCRIPT: 'chrome_inject_script',
    JAVASCRIPT: 'chrome_javascript',
    CONSOLE: 'chrome_console',
    FILE_UPLOAD: 'chrome_upload_file',
    READ_PAGE: 'chrome_read_page',
    COMPUTER: 'chrome_computer',
    HANDLE_DIALOG: 'chrome_handle_dialog',
    HANDLE_DOWNLOAD: 'chrome_handle_download',
    PERFORMANCE_START_TRACE: 'performance_start_trace',
    PERFORMANCE_STOP_TRACE: 'performance_stop_trace',
    PERFORMANCE_ANALYZE_INSIGHT: 'performance_analyze_insight',
    GIF_RECORDER: 'chrome_gif_recorder',
  },
};

// Import and merge all schemas
import { BASIC_SCHEMAS } from './browser-basic-schemas.js';
import { ELEMENT_SCHEMAS } from './browser-element-schemas.js';
import { PAGE_SCHEMAS } from './browser-page-schemas.js';
import { NETWORK_SCHEMAS } from './browser-network-schemas.js';
import { BOOKMARK_SCHEMAS } from './browser-bookmark-schemas.js';
import { ADVANCED_SCHEMAS } from './browser-advanced-schemas.js';
import { PERFORMANCE_SCHEMAS } from './browser-performance-schemas.js';

export const TOOL_SCHEMAS: Tool[] = [
  ...BASIC_SCHEMAS,
  ...ELEMENT_SCHEMAS,
  ...PAGE_SCHEMAS,
  ...NETWORK_SCHEMAS,
  ...BOOKMARK_SCHEMAS,
  ...ADVANCED_SCHEMAS,
  ...PERFORMANCE_SCHEMAS,
];
