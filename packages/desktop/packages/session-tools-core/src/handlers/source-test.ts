/**
 * Source Test Handler
 *
 * Validates and tests a source configuration comprehensively.
 * Performs schema validation, completeness checks, icon handling,
 * connection tests, and auth verification.
 */

import { basename, join } from 'node:path';
import type { SessionToolContext } from '../context.ts';
import type { ToolResult, SourceConfig, ConnectionStatus } from '../types.ts';
import { errorResponse } from '../response.ts';
import {
  validateJsonFileHasFields,
  validateSourceConfigBasic,
} from '../validation.ts';
import {
  sourceExists,
  getSourceConfigPath,
  getSourceGuidePath,
  getSourcePath,
} from '../source-helpers.ts';

export interface SourceTestArgs {
  sourceSlug: string;
  /**
   * Auto-enable the source on success (flip `enabled: true` if needed
   * and activate it in the running session).
   * Defaults to `true`. Pass `false` for pure validation behavior.
   */
  autoEnable?: boolean;
}

/**
 * Test result structure for API/MCP connection tests
 */
interface ConnectionTestResult {
  success: boolean;
  status?: number;
  message: string;
  toolCount?: number;
  toolNames?: string[];
  serverName?: string;
  serverVersion?: string;
  needsAuth?: boolean;
  error?: string;
}

/**
 * Handle the source_test tool call.
 *
 * Performs:
 * 1. Schema validation - validates config.json structure
 * 2. Icon handling - checks/downloads icon
 * 3. Completeness check - warns about missing guide.md/icon/tagline
 * 4. Connection test - tests if source endpoint is reachable
 * 5. Auth status check - verifies authentication
 * 6. Metadata update - updates lastTestedAt, connectionStatus
 */
export async function handleSourceTest(
  ctx: SessionToolContext,
  args: SourceTestArgs
): Promise<ToolResult> {
  const { sourceSlug } = args;
  const lines: string[] = [];
  let hasErrors = false;
  let hasWarnings = false;
  let connectionStatus: ConnectionStatus = 'unknown';
  let connectionError: string | undefined;

  // 1. Check source exists
  if (!sourceExists(ctx.workspacePath, sourceSlug)) {
    return errorResponse(`Source '${sourceSlug}' not found in workspace.`);
  }

  // 2. Schema validation
  lines.push('## Schema Validation');
  const configPath = getSourceConfigPath(ctx.workspacePath, sourceSlug);
  const schemaResult = validateJsonFileHasFields(configPath, ['slug', 'name', 'type']);

  if (schemaResult.valid) {
    lines.push('✓ Config schema valid');
  } else {
    hasErrors = true;
    lines.push('✗ Config schema invalid:');
    for (const error of schemaResult.errors) {
      lines.push(`  - ${error.message}`);
    }
  }

  // 3. Load config for further checks
  const source = ctx.loadSourceConfig(sourceSlug);
  if (!source) {
    return errorResponse(`Failed to load source config for '${sourceSlug}'.`);
  }

  // Validate loaded config with basic validator
  const configValidation = validateSourceConfigBasic(source);
  if (!configValidation.valid) {
    hasErrors = true;
    for (const error of configValidation.errors) {
      lines.push(`  - ${error.path}: ${error.message}`);
    }
  }

  // 4. Icon handling
  lines.push('\n## Icon Status');
  const sourcePath = getSourcePath(ctx.workspacePath, sourceSlug);
  const iconResult = await handleIconCheck(ctx, sourcePath, sourceSlug, source);
  lines.push(...iconResult.lines);
  if (iconResult.hasWarning) hasWarnings = true;

  // 5. Completeness check
  lines.push('\n## Completeness Check');
  const completenessResult = checkCompleteness(ctx, sourcePath, source);
  lines.push(...completenessResult.lines);
  if (completenessResult.hasWarning) hasWarnings = true;

  // 6. Connection test
  lines.push('\n## Connection Test');
  const connectionResult = await testConnection(ctx, source, sourceSlug);
  lines.push(...connectionResult.lines);
  if (connectionResult.hasError) {
    hasErrors = true;
    connectionStatus = 'error';
    connectionError = connectionResult.error;
  } else if (connectionResult.success) {
    connectionStatus = 'connected';
  } else {
    connectionStatus = 'disconnected';
  }

  // 7. Auth status
  lines.push('\n## Authentication');
  const authResult = await checkAuthStatus(ctx, source, sourceSlug);
  lines.push(...authResult.lines);
  if (authResult.hasWarning) hasWarnings = true;

  // 8. Auto-enable + metadata update
  // Defaults to true; pass autoEnable: false to keep pure validation behavior.
  const autoEnable = args.autoEnable !== false;
  const shouldAutoEnable = autoEnable && !hasErrors;
  const willFlipEnabled = shouldAutoEnable && source.enabled === false;

  if (ctx.saveSourceConfig) {
    const updatedSource: SourceConfig = {
      ...source,
      lastTestedAt: new Date().toISOString(),
      connectionStatus,
      connectionError,
      // Fold enabled flip into the same save — one write, not two.
      ...(willFlipEnabled ? { enabled: true } : {}),
    };
    try {
      ctx.saveSourceConfig(updatedSource);
      lines.push('\n_Config updated with test results._');
      if (willFlipEnabled) {
        lines.push('✓ Source auto-enabled in config');
      }
    } catch {
      // Silently ignore save errors
    }
  }

  // Try to activate the source in the running session (backend may not support this).
  if (shouldAutoEnable) {
    if (ctx.activateSourceInSession) {
      try {
        const result = await ctx.activateSourceInSession(sourceSlug);
        if (result.ok) {
          // Activation succeeded — the backend will abort this turn after the
          // tool result lands, and the renderer auto-resends the original user
          // message with a "[{slug} activated]" suffix. From the model's POV,
          // the "next step" is a new turn where the tools are live.
          lines.push('✓ Source activated — the current turn will auto-restart with tools available');
        } else {
          lines.push(`⚠ Config updated, but session activation failed: ${result.reason ?? 'unknown error'}. Restart session to load tools.`);
          hasWarnings = true;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'unknown error';
        lines.push(`⚠ Config updated, but session activation threw: ${msg}. Restart session to load tools.`);
        hasWarnings = true;
      }
    } else if (willFlipEnabled) {
      // Only nag about restart if we actually flipped the flag.
      lines.push('ℹ Config updated. Restart session to load tools (mid-session activation not available in this backend).');
    }
  }

  // Summary
  lines.push('\n---');
  if (hasErrors) {
    lines.push('**Result: ✗ Validation failed with errors**');
  } else if (hasWarnings) {
    lines.push('**Result: ⚠ Validation passed with warnings**');
  } else {
    lines.push('**Result: ✓ Validation passed**');
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    isError: hasErrors,
  };
}

// ============================================================
// Icon Handling
// ============================================================

async function handleIconCheck(
  ctx: SessionToolContext,
  sourcePath: string,
  sourceSlug: string,
  source: SourceConfig
): Promise<{ lines: string[]; hasWarning: boolean }> {
  const lines: string[] = [];
  let hasWarning = false;

  // Check for local icon files
  const iconPngPath = join(sourcePath, 'icon.png');
  const iconSvgPath = join(sourcePath, 'icon.svg');
  const iconJpgPath = join(sourcePath, 'icon.jpg');

  const hasLocalIcon =
    ctx.fs.exists(iconPngPath) ||
    ctx.fs.exists(iconSvgPath) ||
    ctx.fs.exists(iconJpgPath);

  if (hasLocalIcon) {
    const format = ctx.fs.exists(iconPngPath) ? 'PNG' : ctx.fs.exists(iconSvgPath) ? 'SVG' : 'JPG';
    lines.push(`✓ Icon file exists (${format})`);
    return { lines, hasWarning };
  }

  // Check if icon is a URL that can be downloaded
  if (source.icon && ctx.isIconUrl && ctx.isIconUrl(source.icon)) {
    if (ctx.downloadSourceIcon) {
      lines.push(`ℹ Icon URL detected: ${source.icon}`);
      try {
        const cachedPath = await ctx.downloadSourceIcon(sourceSlug, source.icon);
        if (cachedPath) {
          lines.push(`✓ Icon downloaded and cached`);
          return { lines, hasWarning };
        }
      } catch (e) {
        lines.push(`⚠ Failed to download icon: ${e instanceof Error ? e.message : 'Unknown error'}`);
        hasWarning = true;
      }
    } else {
      lines.push(`ℹ Icon URL configured but download not available: ${source.icon}`);
    }
  }

  // Check if icon is an emoji
  if (source.icon && isEmoji(source.icon)) {
    lines.push(`✓ Emoji icon configured: ${source.icon}`);
    return { lines, hasWarning };
  }

  // Try to auto-fetch icon from service
  if (!source.icon && ctx.deriveServiceUrl && ctx.getHighQualityLogoUrl && ctx.downloadIcon) {
    const serviceUrl = ctx.deriveServiceUrl(source);
    if (serviceUrl) {
      lines.push(`ℹ Attempting to auto-fetch icon from service URL...`);
      try {
        const logoUrl = await ctx.getHighQualityLogoUrl(serviceUrl, sourceSlug);
        if (logoUrl) {
          const destPath = join(sourcePath, 'icon.png');
          const downloaded = await ctx.downloadIcon(destPath, logoUrl, sourceSlug);
          if (downloaded) {
            lines.push(`✓ Icon auto-fetched and saved`);
            return { lines, hasWarning };
          }
        }
      } catch {
        // Silently continue if auto-fetch fails
      }
    }
  }

  // No icon found
  hasWarning = true;
  lines.push('⚠ No icon configured');
  lines.push('  Options:');
  lines.push('  - Add icon.png or icon.svg to source folder');
  lines.push('  - Set "icon" field to a URL or emoji in config.json');
  if (source.type === 'api' && source.api?.baseUrl) {
    lines.push(`  - Icon may be auto-fetched from ${new URL(source.api.baseUrl).hostname}`);
  }

  return { lines, hasWarning };
}

/**
 * Simple emoji detection
 */
function isEmoji(str: string): boolean {
  // Check if string is a single emoji (basic heuristic)
  const emojiRegex = /^[\p{Emoji}]$/u;
  return emojiRegex.test(str) || (str.length >= 2 && str.length <= 8 && /[\u{1F300}-\u{1FAD6}]/u.test(str));
}

// ============================================================
// Completeness Check
// ============================================================

function checkCompleteness(
  ctx: SessionToolContext,
  sourcePath: string,
  source: SourceConfig
): { lines: string[]; hasWarning: boolean } {
  const lines: string[] = [];
  let hasWarning = false;

  // Check guide.md
  const guidePath = getSourceGuidePath(ctx.workspacePath, source.slug);
  if (!ctx.fs.exists(guidePath)) {
    hasWarning = true;
    lines.push('⚠ No guide.md file');
    lines.push('  Recommended: Add guide.md with usage instructions for the agent');
  } else {
    try {
      const guideContent = ctx.fs.readFile(guidePath);
      const guideSize = guideContent.length;
      const wordCount = guideContent.split(/\s+/).filter(Boolean).length;
      lines.push(`✓ guide.md exists (${wordCount} words, ${formatBytes(guideSize)})`);

      if (wordCount < 50) {
        lines.push('  ℹ Guide is short - consider adding more context');
      }
    } catch {
      lines.push('✓ guide.md exists');
    }
  }

  // Check tagline field
  if (!source.tagline) {
    // Check if they used 'description' instead (common mistake)
    if ((source as unknown as Record<string, unknown>)['description']) {
      hasWarning = true;
      lines.push('⚠ Found "description" field instead of "tagline"');
      lines.push('  Rename "description" to "tagline" in config.json');
    } else {
      hasWarning = true;
      lines.push('⚠ No tagline configured');
      lines.push('  Add "tagline": "Brief description" to config.json');
    }
  } else {
    lines.push(`✓ Tagline: "${source.tagline}"`);
    if (source.tagline.length > 100) {
      lines.push('  ℹ Tagline is long - consider shortening to < 100 chars');
    }
  }

  // Check name
  if (source.name) {
    lines.push(`✓ Name: "${source.name}"`);
  }

  return { lines, hasWarning };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ============================================================
// Connection Test
// ============================================================

async function testConnection(
  ctx: SessionToolContext,
  source: SourceConfig,
  sourceSlug: string
): Promise<{ lines: string[]; success: boolean; hasError: boolean; error?: string }> {
  const lines: string[] = [];
  let success = false;
  let hasError = false;
  let error: string | undefined;

  if (source.type === 'api') {
    const result = await testApiConnection(ctx, source, sourceSlug);
    lines.push(...result.lines);
    success = result.success;
    hasError = result.hasError;
    error = result.error;
  } else if (source.type === 'mcp') {
    const result = await testMcpConnection(ctx, source, sourceSlug);
    lines.push(...result.lines);
    success = result.success;
    hasError = result.hasError;
    error = result.error;
  } else if (source.type === 'local') {
    const result = testLocalConnection(ctx, source);
    lines.push(...result.lines);
    success = result.success;
    hasError = result.hasError;
    error = result.error;
  } else {
    lines.push('ℹ No connection test available for this source type');
    success = true;
  }

  return { lines, success, hasError, error };
}

async function testApiConnection(
  ctx: SessionToolContext,
  source: SourceConfig,
  sourceSlug: string
): Promise<{ lines: string[]; success: boolean; hasError: boolean; error?: string }> {
  const lines: string[] = [];
  let success = false;
  let hasError = false;
  let error: string | undefined;

  if (!source.api?.baseUrl) {
    lines.push('✗ No API base URL configured');
    hasError = true;
    error = 'No base URL';
    return { lines, success, hasError, error };
  }

  // If ctx has advanced testApiSource, use it
  if (ctx.testApiSource) {
    try {
      const result = await ctx.testApiSource(source);
      if (result.success) {
        success = true;
        lines.push(`✓ API endpoint reachable`);
        if (result.status) {
          lines.push(`  Status: ${result.status}`);
        }
      } else {
        hasError = true;
        error = result.error || 'Connection failed';
        lines.push(`✗ ${result.error || 'Connection failed'}`);
        if (result.hint) {
          lines.push(`  ${result.hint}`);
        }
      }
      return { lines, success, hasError, error };
    } catch (e) {
      // Fall through to built-in test
    }
  }

  // Build test URL
  const testUrl = source.api.testEndpoint
    ? `${source.api.baseUrl}${source.api.testEndpoint.path}`
    : source.api.baseUrl;

  // Try authenticated request if credentials available
  if (source.isAuthenticated && ctx.credentialManager && source.api.authType !== 'none') {
    const authResult = await testApiConnectionWithAuth(ctx, source, sourceSlug, testUrl);
    if (authResult.attempted) {
      return authResult;
    }
    // If auth test wasn't attempted (no token), fall through to basic test
  }

  // Basic connection test (no auth)
  return testApiConnectionBasic(source, testUrl);
}

/**
 * Test API connection WITH authentication credentials.
 * Returns attempted=false if credentials couldn't be retrieved.
 */
async function testApiConnectionWithAuth(
  ctx: SessionToolContext,
  source: SourceConfig,
  sourceSlug: string,
  testUrl: string
): Promise<{ lines: string[]; success: boolean; hasError: boolean; error?: string; attempted: boolean }> {
  const lines: string[] = [];

  // Build LoadedSource for credential manager
  const workspaceId = basename(ctx.workspacePath) || '';
  const loadedSource = {
    config: source,
    folderPath: getSourcePath(ctx.workspacePath, sourceSlug),
    workspaceRootPath: ctx.workspacePath,
    workspaceId,
  };

  // Get token from credential manager
  let token: string | null = null;
  try {
    token = await ctx.credentialManager!.getToken(loadedSource);
  } catch {
    // Couldn't get token, will fall through to basic test
  }

  if (!token) {
    return { lines: [], success: false, hasError: false, attempted: false };
  }

  // Build auth headers based on authType
  const headers: Record<string, string> = {};
  let urlWithAuth = testUrl;

  switch (source.api!.authType) {
    case 'bearer':
    case 'oauth':
      // Generic OAuth tokens are sent as Bearer tokens
      headers['Authorization'] = `Bearer ${token}`;
      break;
    case 'basic':
      // Token for basic auth is already base64 encoded (user:pass)
      headers['Authorization'] = `Basic ${token}`;
      break;
    case 'header':
      // Custom header name
      if (source.api!.headerName) {
        headers[source.api!.headerName] = token;
      } else if (source.api!.headerNames && source.api!.headerNames.length > 0) {
        // Multi-header auth: token is JSON with header values
        const headerNames = source.api!.headerNames;
        try {
          const headerValues = JSON.parse(token) as Record<string, string>;
          for (const headerName of headerNames) {
            if (headerValues[headerName]) {
              headers[headerName] = headerValues[headerName];
            }
          }
        } catch {
          // Token is not valid JSON - this is a configuration error for multi-header auth
          const firstHeader = headerNames[0] || 'Header';
          return {
            lines: [`✗ Multi-header auth requires JSON token with header values`],
            success: false,
            hasError: true,
            error: `Expected JSON token like {"${firstHeader}": "value"} but got non-JSON string`,
            attempted: true,
          };
        }
      } else {
        // Fallback to X-API-Key if no header name specified
        headers['X-API-Key'] = token;
      }
      break;
    case 'query':
      // Add token as query parameter
      const paramName = source.api!.queryParam || 'api_key';
      const separator = testUrl.includes('?') ? '&' : '?';
      urlWithAuth = `${testUrl}${separator}${paramName}=${encodeURIComponent(token)}`;
      break;
  }

  // Make authenticated request
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const method = source.api!.testEndpoint?.method || 'GET';
    const response = await fetch(urlWithAuth, {
      method,
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      lines.push(`✓ API connection successful (authenticated)`);
      lines.push(`  Status: ${response.status}`);
      return { lines, success: true, hasError: false, attempted: true };
    } else if (response.status === 401 || response.status === 403) {
      lines.push(`✗ API returned ${response.status} (credentials invalid or expired)`);
      lines.push('  Re-authenticate the source to refresh credentials');
      return { lines, success: false, hasError: true, error: `Auth failed: ${response.status}`, attempted: true };
    } else if (response.status === 404) {
      lines.push(`⚠ API returned 404 (endpoint not found)`);
      if (source.api!.testEndpoint) {
        lines.push(`  Check if testEndpoint.path is correct: ${source.api!.testEndpoint.path}`);
      }
      return { lines, success: false, hasError: false, attempted: true };
    } else {
      lines.push(`⚠ API returned ${response.status}`);
      return { lines, success: false, hasError: false, attempted: true };
    }
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : 'Unknown error';
    lines.push(`✗ Connection failed: ${errorMsg}`);
    if (errorMsg.includes('abort')) {
      lines.push('  Request timed out after 10 seconds');
    }
    return { lines, success: false, hasError: true, error: errorMsg, attempted: true };
  }
}

/**
 * Basic API connection test WITHOUT authentication.
 * Used when no credentials are available.
 */
async function testApiConnectionBasic(
  source: SourceConfig,
  testUrl: string
): Promise<{ lines: string[]; success: boolean; hasError: boolean; error?: string }> {
  const lines: string[] = [];
  let success = false;
  let hasError = false;
  let error: string | undefined;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    // Try HEAD first
    let response = await fetch(testUrl, {
      method: 'HEAD',
      signal: controller.signal,
    }).catch(() => null);

    // If HEAD returns 405, try GET
    if (response && response.status === 405) {
      response = await fetch(testUrl, {
        method: 'GET',
        signal: controller.signal,
      }).catch(() => null);
    }

    clearTimeout(timeoutId);

    if (response) {
      if (response.ok) {
        success = true;
        lines.push(`✓ API endpoint reachable (${testUrl})`);
      } else if (response.status === 401 || response.status === 403) {
        // Auth required - endpoint is reachable but needs credentials
        success = true;
        lines.push(`⚠ API returned ${response.status} (authentication required)`);
        if (!source.isAuthenticated) {
          lines.push('  Authenticate the source to test with credentials');
        } else {
          lines.push('  Source is marked authenticated but credentials could not be retrieved');
        }
      } else if (response.status === 404) {
        lines.push(`⚠ API returned 404 (endpoint not found)`);
        if (source.api?.testEndpoint) {
          lines.push(`  Check if testEndpoint.path is correct: ${source.api.testEndpoint.path}`);
        } else {
          lines.push('  Consider adding testEndpoint configuration');
        }
      } else {
        lines.push(`⚠ API returned ${response.status}`);
      }
    } else {
      hasError = true;
      error = 'Connection failed';
      lines.push(`✗ Cannot reach API endpoint (${source.api?.baseUrl})`);
      lines.push('  Check if the URL is correct and the service is running');
    }
  } catch (e) {
    hasError = true;
    error = e instanceof Error ? e.message : 'Unknown error';
    lines.push(`✗ Connection failed: ${error}`);
    if (error.includes('abort')) {
      lines.push('  Request timed out after 10 seconds');
    }
  }

  return { lines, success, hasError, error };
}

async function testMcpConnection(
  ctx: SessionToolContext,
  source: SourceConfig,
  sourceSlug: string
): Promise<{ lines: string[]; success: boolean; hasError: boolean; error?: string }> {
  const lines: string[] = [];
  let success = false;
  let hasError = false;
  let error: string | undefined;

  if (source.mcp?.transport === 'stdio') {
    // Stdio MCP - use validateStdioMcpConnection if available
    if (ctx.validateStdioMcpConnection && source.mcp.command) {
      lines.push(`ℹ Testing stdio MCP: ${source.mcp.command}`);
      try {
        const result = await ctx.validateStdioMcpConnection({
          command: source.mcp.command,
          args: source.mcp.args || [],
          env: source.mcp.env,
        });
        if (result.success) {
          success = true;
          lines.push(`✓ MCP server started successfully`);
          if (result.toolCount !== undefined) {
            lines.push(`  Tools available: ${result.toolCount}`);
            if (result.toolNames && result.toolNames.length > 0) {
              const preview = result.toolNames.slice(0, 5).join(', ');
              if (result.toolNames.length > 5) {
                lines.push(`  Examples: ${preview}, ...`);
              } else {
                lines.push(`  Tools: ${preview}`);
              }
            }
          }
          if (result.serverName) {
            lines.push(`  Server: ${result.serverName} v${result.serverVersion || 'unknown'}`);
          }
        } else {
          hasError = true;
          error = result.error || 'MCP validation failed';
          lines.push(`✗ ${error}`);
        }
      } catch (e) {
        hasError = true;
        error = e instanceof Error ? e.message : 'Unknown error';
        lines.push(`✗ Failed to test MCP server: ${error}`);
      }
    } else if (source.mcp?.command) {
      // Basic check - just report config
      lines.push(`ℹ Stdio MCP source: ${source.mcp.command}`);
      if (source.mcp.args?.length) {
        lines.push(`  Args: ${source.mcp.args.join(' ')}`);
      }
      lines.push('  Connection test not available in this context — call the source\'s MCP tools directly to verify');
      success = true; // Config looks ok
    } else {
      hasError = true;
      error = 'No command configured';
      lines.push('✗ No command configured for stdio MCP source');
    }
  } else if (source.mcp?.url) {
    // HTTP/SSE MCP
    if (ctx.validateMcpConnection) {
      lines.push(`ℹ Testing MCP server: ${source.mcp.url}`);
      try {
        // Merge static headers with credential-store headers (if headerNames configured)
        let headers = source.mcp.headers ? { ...source.mcp.headers } : undefined;
        if (source.mcp.headerNames?.length && ctx.credentialManager) {
          const workspaceId = basename(ctx.workspacePath) || '';
          const loadedSource = {
            config: source,
            folderPath: getSourcePath(ctx.workspacePath, sourceSlug),
            workspaceRootPath: ctx.workspacePath,
            workspaceId,
          };
          try {
            const rawCred = await ctx.credentialManager.getToken(loadedSource);
            if (rawCred) {
              const parsed = JSON.parse(rawCred) as Record<string, string>;
              headers = { ...headers, ...parsed };
            }
          } catch {
            // Not JSON or no credential — continue without credential headers
          }
        }
        const result = await ctx.validateMcpConnection({
          url: source.mcp.url,
          transport: source.mcp.transport,
          authType: source.mcp.authType,
          headers,
        });
        if (result.success) {
          success = true;
          lines.push(`✓ MCP server connected`);
          if (result.toolCount !== undefined) {
            lines.push(`  Tools available: ${result.toolCount}`);
          }
          if (result.serverName) {
            lines.push(`  Server: ${result.serverName} v${result.serverVersion || 'unknown'}`);
          }
        } else if (result.needsAuth) {
          lines.push(`⚠ MCP server requires authentication`);
          if (source.mcp.authType === 'oauth') {
            lines.push('  Use source_oauth_trigger to authenticate');
          }
          success = true; // Server is reachable, just needs auth
        } else {
          hasError = true;
          error = result.error || 'MCP connection failed';
          lines.push(`✗ ${error}`);
        }
      } catch (e) {
        hasError = true;
        error = e instanceof Error ? e.message : 'Unknown error';
        lines.push(`✗ Failed to connect to MCP server: ${error}`);
      }
    } else {
      // Basic URL check
      lines.push(`ℹ MCP source URL: ${source.mcp.url}`);
      lines.push('  Connection test not available in this context — call the source\'s MCP tools directly to verify');
      success = true; // Config looks ok
    }
  } else {
    hasError = true;
    error = 'No MCP URL or command configured';
    lines.push('✗ No MCP URL or command configured');
  }

  return { lines, success, hasError, error };
}

function testLocalConnection(
  ctx: SessionToolContext,
  source: SourceConfig
): { lines: string[]; success: boolean; hasError: boolean; error?: string } {
  const lines: string[] = [];
  let success = false;
  let hasError = false;
  let error: string | undefined;

  if (!source.local?.path) {
    hasError = true;
    error = 'No local path configured';
    lines.push('✗ No local path configured');
    return { lines, success, hasError, error };
  }

  if (ctx.fs.exists(source.local.path)) {
    success = true;
    const isDir = ctx.fs.isDirectory(source.local.path);
    lines.push(`✓ Local path exists: ${source.local.path}`);
    lines.push(`  Type: ${isDir ? 'Directory' : 'File'}`);
  } else {
    hasError = true;
    error = 'Path not found';
    lines.push(`✗ Local path not found: ${source.local.path}`);
    lines.push('  Verify the path exists and is accessible');
  }

  return { lines, success, hasError, error };
}

// ============================================================
// Auth Status Check
// ============================================================

async function checkAuthStatus(
  ctx: SessionToolContext,
  source: SourceConfig,
  sourceSlug: string
): Promise<{ lines: string[]; hasWarning: boolean }> {
  const lines: string[] = [];
  let hasWarning = false;

  if (source.isAuthenticated) {
    // In Codex context (no validateMcpConnection), MCP source credentials are delivered
    // via config.toml headers, not the credential cache. Skip token verification to avoid
    // false "token missing" warnings from the file-based cache.
    if (source.type === 'mcp' && !ctx.validateMcpConnection) {
      lines.push('✓ Source is authenticated');
    } else if (ctx.credentialManager) {
      const workspaceId = basename(ctx.workspacePath) || '';
      const loadedSource = {
        config: source,
        folderPath: getSourcePath(ctx.workspacePath, sourceSlug),
        workspaceRootPath: ctx.workspacePath,
        workspaceId,
      };

      try {
        const token = await ctx.credentialManager.getToken(loadedSource);
        if (token) {
          lines.push('✓ Source is authenticated (token valid)');
        } else {
          // Token missing or expired — attempt refresh before reporting failure.
          // OAuth tokens are short-lived (typically 1h) and frequently expired in the
          // credential store between uses. The normal connection pipeline refreshes
          // them proactively, so source_test should too.
          const refreshed = await ctx.credentialManager.refresh(loadedSource);
          if (refreshed) {
            lines.push('✓ Source is authenticated (token refreshed)');
          } else {
            hasWarning = true;
            lines.push('⚠ Source marked authenticated but token missing or refresh failed');
            lines.push('  Re-authenticate to refresh credentials');
          }
        }
      } catch {
        lines.push('✓ Source is authenticated');
      }
    } else {
      lines.push('✓ Source is authenticated');
    }
  } else {
    // Determine required auth type
    if (source.type === 'mcp' && source.mcp?.authType === 'oauth') {
      hasWarning = true;
      lines.push('⚠ Source not authenticated');
      lines.push('  Use source_oauth_trigger to authenticate');
    } else if (source.type === 'api') {
      if (source.provider === 'google') {
        hasWarning = true;
        lines.push('⚠ Source not authenticated');
        lines.push('  Use source_google_oauth_trigger to authenticate');
      } else if (source.provider === 'slack') {
        hasWarning = true;
        lines.push('⚠ Source not authenticated');
        lines.push('  Use source_slack_oauth_trigger to authenticate');
      } else if (source.provider === 'microsoft') {
        hasWarning = true;
        lines.push('⚠ Source not authenticated');
        lines.push('  Use source_microsoft_oauth_trigger to authenticate');
      } else if (source.api?.authType && source.api.authType !== 'none') {
        hasWarning = true;
        lines.push('⚠ Source not authenticated');
        lines.push('  Use source_credential_prompt to enter credentials');
      } else {
        lines.push('ℹ Source does not require authentication');
      }
    } else {
      lines.push('ℹ Source does not require authentication');
    }
  }

  return { lines, hasWarning };
}
