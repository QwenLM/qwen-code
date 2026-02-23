/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const KNOWN_TOOL_NAMES = [
  'get_windows_and_tabs',
  'chrome_navigate',
  'chrome_screenshot',
  'chrome_close_tabs',
  'chrome_switch_tab',
  'chrome_get_web_content',
  'chrome_click_element',
  'chrome_fill_or_select',
  'chrome_request_element_selection',
  'chrome_get_interactive_elements',
  'chrome_network_capture',
  'chrome_network_capture_start',
  'chrome_network_capture_stop',
  'chrome_network_request',
  'chrome_network_debugger_start',
  'chrome_network_debugger_stop',
  'chrome_keyboard',
  'chrome_history',
  'chrome_bookmark_search',
  'chrome_bookmark_add',
  'chrome_bookmark_delete',
  'chrome_inject_script',
  'chrome_javascript',
  'chrome_console',
  'chrome_upload_file',
  'chrome_read_page',
  'chrome_computer',
  'chrome_handle_dialog',
  'chrome_handle_download',
  'performance_start_trace',
  'performance_stop_trace',
  'performance_analyze_insight',
  'chrome_gif_recorder',
];

export const LEGACY_TOOL_ALIASES = {
  browser_capture_screenshot: 'chrome_screenshot',
  browser_read_page: 'chrome_read_page',
  browser_click: 'chrome_click_element',
  browser_fill_form: 'chrome_fill_or_select',
  browser_input_text: 'chrome_fill_or_select',
  browser_get_console_logs: 'chrome_console',
  browser_run_js: 'chrome_inject_script',
  chrome_get_tabs: 'get_windows_and_tabs',
};

const KNOWN_TOOL_SET = new Set(KNOWN_TOOL_NAMES);

export function normalizeToolName(name) {
  if (!name || typeof name !== 'string') return name;
  return LEGACY_TOOL_ALIASES[name] || name;
}

export function isKnownToolName(name) {
  return KNOWN_TOOL_SET.has(name);
}
