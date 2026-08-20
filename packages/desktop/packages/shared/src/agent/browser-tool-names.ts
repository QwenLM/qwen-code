/**
 * Browser tool naming helpers.
 *
 * Canonical runtime tool is `browser_tool`, but we retain compatibility with
 * legacy split tool names (browser_open, browser_snapshot, etc.) that may
 * appear in older sessions/tests/logs.
 */

/** Legacy split browser tool aliases that map to canonical `browser_tool`. */
export const LEGACY_BROWSER_TOOL_ALIASES = new Set<string>([
  'browser_open',
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_click_at',
  'browser_fill',
  'browser_select',
  'browser_screenshot',
  'browser_screenshot_region',
  'browser_console',
  'browser_window_resize',
  'browser_network',
  'browser_wait',
  'browser_key',
  'browser_downloads',
  'browser_scroll',
  'browser_back',
  'browser_forward',
  'browser_evaluate',
]);

/**
 * Strip known session prefixes from tool names.
 */
function stripSessionPrefix(toolName: string): string {
  return toolName.replace(/^(mcp__session__|session__)/, '');
}

/**
 * Normalize canonical browser tool names (`browser_tool`) with optional namespaces.
 * Does NOT accept legacy aliases.
 */
export function normalizeCanonicalBrowserToolName(toolName: string): 'browser_tool' | null {
  const normalized = toolName.trim();
  if (!normalized) return null;

  // Accept direct and namespaced canonical forms, e.g.:
  // - browser_tool
  // - mcp__session__browser_tool
  // - mcp__workspace__browser_tool
  return /(?:^|__)browser_tool$/i.test(normalized) ? 'browser_tool' : null;
}

/**
 * Normalize browser tool names (canonical + legacy aliases) to `browser_tool`.
 */
export function normalizeBrowserToolName(toolName: string): 'browser_tool' | null {
  const canonical = normalizeCanonicalBrowserToolName(toolName);
  if (canonical) return canonical;

  const normalized = toolName.trim();
  if (!normalized) return null;

  const stripped = stripSessionPrefix(normalized);
  return LEGACY_BROWSER_TOOL_ALIASES.has(stripped) ? 'browser_tool' : null;
}

/**
 * True when a tool name is the canonical browser tool (with optional namespace prefix).
 */
export function isCanonicalBrowserToolName(toolName: string): boolean {
  return normalizeCanonicalBrowserToolName(toolName) === 'browser_tool';
}

/**
 * True when a tool name is the canonical browser tool or a supported legacy alias.
 */
export function isBrowserToolNameOrAlias(toolName: string): boolean {
  return normalizeBrowserToolName(toolName) === 'browser_tool';
}
