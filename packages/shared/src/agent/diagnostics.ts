/**
 * Error diagnostics - runs quick checks to identify the specific cause
 * of a generic "process exited" error from the SDK.
 *
 * Provider-aware: routes checks based on providerType so non-Anthropic
 * sessions don't run Anthropic-specific credential/endpoint checks.
 */

import { getLastApiError } from '../interceptor-common.ts';
import { type AuthType, getDefaultLlmConnection, getLlmConnection } from '../config/storage.ts';
import { getCredentialManager } from '../credentials/index.ts';
import { validateAnthropicConnection } from '../config/llm-validation.ts';
import type { LlmProviderType } from '../config/llm-connections.ts';
import { isAnthropicProvider } from '../config/llm-connections.ts';

export type DiagnosticCode =
  | 'billing_error'         // HTTP 402 from API
  | 'token_expired'
  | 'invalid_credentials'
  | 'rate_limited'          // HTTP 429 from API
  | 'mcp_unreachable'
  | 'service_unavailable'
  | 'unknown_error';

export interface DiagnosticResult {
  code: DiagnosticCode;
  title: string;
  message: string;
  /** Diagnostic check results for debugging */
  details: string[];
}

interface DiagnosticConfig {
  authType?: AuthType;
  workspaceId?: string;
  rawError: string;
  /** Provider type for routing provider-specific checks */
  providerType?: LlmProviderType;
  /** Base URL override (uses this instead of process.env.ANTHROPIC_BASE_URL) */
  baseUrl?: string;
}

interface CheckResult {
  ok: boolean;
  detail: string;
  failCode?: DiagnosticCode;
  failTitle?: string;
  failMessage?: string;
}

/** Run a check with a timeout, returns default result if times out */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, defaultValue: T): Promise<T> {
  const timeoutPromise = new Promise<T>((resolve) => setTimeout(() => resolve(defaultValue), timeoutMs));
  return Promise.race([promise, timeoutPromise]);
}

/**
 * Check if a recent API error was captured during the failed request.
 * This is the most accurate source of truth for API failures since it
 * captures the actual HTTP status code before the SDK wraps it.
 *
 * Provider-agnostic: HTTP status codes are universal.
 */
async function checkCapturedApiError(providerLabel: string): Promise<CheckResult> {
  const apiError = getLastApiError();

  if (!apiError) {
    return { ok: true, detail: '✓ API error: None captured' };
  }

  // HTTP 402 - Payment Required
  if (apiError.status === 402) {
    return {
      ok: false,
      detail: `✗ API error: 402 ${apiError.message}`,
      failCode: 'billing_error',
      failTitle: 'Payment Required',
      failMessage: apiError.message || `Your ${providerLabel} account has a billing issue.`,
    };
  }

  // HTTP 401 - Unauthorized / Invalid Credentials
  if (apiError.status === 401) {
    return {
      ok: false,
      detail: `✗ API error: 401 ${apiError.message}`,
      failCode: 'invalid_credentials',
      failTitle: 'Invalid Credentials',
      failMessage: apiError.message || 'Your API credentials are invalid or expired.',
    };
  }

  // HTTP 429 - Rate Limited
  if (apiError.status === 429) {
    return {
      ok: false,
      detail: `✗ API error: 429 ${apiError.message}`,
      failCode: 'rate_limited',
      failTitle: 'Rate Limited',
      failMessage: 'Too many requests. Please wait a moment before trying again.',
    };
  }

  // HTTP 5xx - Service Error
  if (apiError.status >= 500) {
    return {
      ok: false,
      detail: `✗ API error: ${apiError.status} ${apiError.message}`,
      failCode: 'service_unavailable',
      failTitle: `${providerLabel} Service Error`,
      failMessage: `The ${providerLabel} API returned an error (${apiError.status}). This is usually temporary.`,
    };
  }

  // Other 4xx errors - report but don't fail (might be expected)
  // Include the message so users can see what actually went wrong
  return { ok: true, detail: `✓ API error: ${apiError.status} - ${apiError.message}` };
}

/**
 * Derive a user-facing label from the configured API base URL.
 * Used in diagnostics messages so errors reference the correct provider.
 */
function getProviderLabel(baseUrl: string): string {
  if (baseUrl.includes('openrouter')) return 'OpenRouter';
  if (baseUrl.includes('anthropic')) return 'Anthropic';
  return 'API endpoint';
}

/**
 * Derive a user-facing label from the provider type.
 * Falls back to URL-based detection for base URL overrides.
 */
function getProviderLabelFromType(providerType?: LlmProviderType, baseUrl?: string): string {
  if (providerType) {
    switch (providerType) {
      case 'anthropic': return 'Anthropic';
      case 'pi':
      case 'pi_compat': return 'Craft Agents Backend';
      case 'qwen': return 'Qwen Code';
    }
  }
  // Fallback: derive from base URL or default
  const resolvedUrl = baseUrl || process.env.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com';
  return getProviderLabel(resolvedUrl);
}

/**
 * Check if the configured API endpoint is reachable.
 * Uses a simple HEAD request to check connectivity without authentication.
 * Uses explicit baseUrl if provided, otherwise falls back to env var.
 */
async function checkApiAvailability(explicitBaseUrl?: string): Promise<CheckResult> {
  const baseUrl = explicitBaseUrl || process.env.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com';
  const label = getProviderLabel(baseUrl);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    try {
      // HEAD request doesn't require auth and checks if service is up
      const response = await fetch(`${baseUrl}/v1/models`, {
        method: 'HEAD',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      // Any response means the service is reachable
      // 401/403 = reachable but auth required (expected without key)
      // 5xx = service issues
      if (response.status >= 500) {
        return {
          ok: false,
          detail: `✗ ${label}: Service error (${response.status})`,
          failCode: 'service_unavailable',
          failTitle: `${label} Service Error`,
          failMessage: `The ${label} is experiencing issues. Please try again later.`,
        };
      }

      return { ok: true, detail: `✓ ${label}: Reachable (${response.status})` };
    } catch (fetchError) {
      clearTimeout(timeoutId);

      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        return {
          ok: false,
          detail: `✗ ${label}: Timeout`,
          failCode: 'service_unavailable',
          failTitle: `${label} Unreachable`,
          failMessage: `Cannot connect to ${label}. Check your internet connection.`,
        };
      }

      const msg = fetchError instanceof Error ? fetchError.message : String(fetchError);
      if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('fetch failed')) {
        return {
          ok: false,
          detail: `✗ ${label}: Unreachable (${msg})`,
          failCode: 'service_unavailable',
          failTitle: `${label} Unreachable`,
          failMessage: `Cannot connect to ${label}. Check your internet connection.`,
        };
      }

      return { ok: true, detail: `✓ ${label}: Unknown (${msg})` };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: true, detail: `✓ ${label}: Check failed (${msg})` };
  }
}

/** Check workspace token expiry - placeholder, always returns valid */
async function checkWorkspaceToken(_workspaceId: string): Promise<CheckResult> {
  // Token expiry checking was removed in a refactoring
  // For now, just assume tokens are valid - the actual API call will fail if expired
  return { ok: true, detail: '✓ Workspace token: Present' };
}

/**
 * Validate an API key by making a minimal query through the Claude Agent SDK.
 * Uses validateAnthropicConnection() which runs query() with maxTurns:1.
 */
async function validateApiKeyWithAnthropic(apiKey: string, baseUrl?: string | null, providerLabel: string = 'Anthropic'): Promise<CheckResult> {
  try {
    const { getDefaultSummarizationModel } = await import('../config/models.ts');
    const model = getDefaultSummarizationModel();

    const result = await validateAnthropicConnection({
      model,
      apiKey,
      baseUrl: baseUrl || undefined,
    });

    if (result.success) {
      return {
        ok: true,
        detail: '✓ API key: Valid',
      };
    }

    const errorMsg = result.error || 'Unknown error';
    const lowerMsg = errorMsg.toLowerCase();

    // 401 = Invalid key
    if (lowerMsg.includes('401') || lowerMsg.includes('authentication') || lowerMsg.includes('unauthorized')) {
      return {
        ok: false,
        detail: '✗ API key: Invalid or expired',
        failCode: 'invalid_credentials',
        failTitle: 'Invalid API Key',
        failMessage: `Your ${providerLabel} API key is invalid or has expired. Please update it in settings.`,
      };
    }

    // 403 = Key valid but no permission
    if (lowerMsg.includes('403') || lowerMsg.includes('permission') || lowerMsg.includes('forbidden')) {
      return {
        ok: false,
        detail: '✗ API key: Insufficient permissions',
        failCode: 'invalid_credentials',
        failTitle: 'API Key Permission Error',
        failMessage: `Your API key does not have permission to access the ${providerLabel} API. Check your dashboard.`,
      };
    }

    // Other errors - don't fail diagnostics, just note them
    return {
      ok: true,
      detail: `✓ API key: Validation skipped (${errorMsg.slice(0, 50)})`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: true,
      detail: `✓ API key: Validation skipped (${msg.slice(0, 50)})`,
    };
  }
}

/** Check API key presence and validity */
async function checkApiKey(providerLabel: string = 'Anthropic'): Promise<CheckResult> {
  try {
    // Resolve API key from the default LLM connection
    const defaultConnSlug = getDefaultLlmConnection();
    const connection = defaultConnSlug ? getLlmConnection(defaultConnSlug) : null;
    const credManager = getCredentialManager();
    const apiKey = defaultConnSlug ? await credManager.getLlmApiKey(defaultConnSlug) : null;
    const baseUrl = connection?.baseUrl ?? null;

    if (!apiKey) {
      return {
        ok: false,
        detail: '✗ API key: Not found',
        failCode: 'invalid_credentials',
        failTitle: 'API Key Missing',
        failMessage: `Your ${providerLabel} API key is missing. Please add it in settings.`,
      };
    }

    // Actually validate the key works
    return await validateApiKeyWithAnthropic(apiKey, baseUrl, providerLabel);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: true, detail: `✓ API key: Check failed (${msg})` };
  }
}

/** Check OAuth token presence */
async function checkOAuthToken(providerLabel: string = 'Anthropic'): Promise<CheckResult> {
  try {
    // Resolve OAuth token from the default LLM connection
    const defaultConnSlug = getDefaultLlmConnection();
    const credManager = getCredentialManager();
    let token: string | null = null;
    if (defaultConnSlug) {
      const oauth = await credManager.getLlmOAuth(defaultConnSlug);
      token = oauth?.accessToken || null;
    }
    if (!token) {
      return {
        ok: false,
        detail: '✗ OAuth token: Not found',
        failCode: 'invalid_credentials',
        failTitle: 'OAuth Token Missing',
        failMessage: `Your ${providerLabel} OAuth token is missing. Please re-authenticate.`,
      };
    }
    return { ok: true, detail: '✓ OAuth token: Present' };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: true, detail: `✓ OAuth token: Check failed (${msg})` };
  }
}

/** Check MCP server connectivity with a quick HEAD request */
async function checkMcpConnectivity(mcpUrl: string): Promise<CheckResult> {
  try {
    // Parse the URL to get just the base server
    const url = new URL(mcpUrl);
    const baseUrl = `${url.protocol}//${url.host}`;

    // Quick HEAD request with short timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    try {
      const response = await fetch(baseUrl, {
        method: 'HEAD',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      // Any response (even 4xx) means the server is reachable
      return { ok: true, detail: `✓ MCP server: Reachable (${response.status})` };
    } catch (fetchError) {
      clearTimeout(timeoutId);
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        return {
          ok: false,
          detail: '✗ MCP server: Timeout',
          failCode: 'mcp_unreachable',
          failTitle: 'MCP Server Unreachable',
          failMessage: 'Cannot connect to the Craft MCP server (timeout). Check your network connection.',
        };
      }
      const msg = fetchError instanceof Error ? fetchError.message : String(fetchError);
      // Check for common network errors
      if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('fetch failed')) {
        return {
          ok: false,
          detail: `✗ MCP server: Unreachable (${msg})`,
          failCode: 'mcp_unreachable',
          failTitle: 'MCP Server Unreachable',
          failMessage: 'Cannot connect to the Craft MCP server. Check your network connection.',
        };
      }
      return { ok: true, detail: `✓ MCP server: Unknown (${msg})` };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: true, detail: `✓ MCP server: Check failed (${msg})` };
  }
}

/**
 * Run error diagnostics to identify the specific cause of a failure.
 * All checks run in parallel with 5s timeouts.
 *
 * Provider-aware: only runs Anthropic-specific checks (API key validation,
 * endpoint availability) for Anthropic-based providers. Non-Anthropic
 * providers get the captured API error check plus the raw error details.
 */
export async function runErrorDiagnostics(config: DiagnosticConfig): Promise<DiagnosticResult> {
  const { authType, workspaceId, rawError, providerType, baseUrl } = config;
  const providerLabel = getProviderLabelFromType(providerType, baseUrl);
  const details: string[] = [];
  const defaultResult: CheckResult = { ok: true, detail: '? Check: Timeout' };

  // Build list of checks to run based on config
  const checks: Promise<CheckResult>[] = [];

  // 0. FIRST: Check captured API error (most accurate source of truth)
  // This is provider-agnostic — HTTP status codes are universal.
  checks.push(withTimeout(checkCapturedApiError(providerLabel), 1000, defaultResult));

  // Provider-specific checks: only run for Anthropic-based providers
  // Codex, Copilot, and Pi handle auth internally — no env-var-based checks apply.
  const isAnthropic = !providerType || isAnthropicProvider(providerType);

  if (isAnthropic) {
    // 1. API endpoint availability check (uses explicit baseUrl or env var)
    checks.push(withTimeout(checkApiAvailability(baseUrl), 4000, defaultResult));

    // 2. API key check with validation (only for api_key auth)
    if (authType === 'api_key') {
      checks.push(withTimeout(checkApiKey(providerLabel), 5000, defaultResult));
    }

    // 3. OAuth token check (only for oauth_token auth)
    if (authType === 'oauth_token') {
      checks.push(withTimeout(checkOAuthToken(providerLabel), 5000, defaultResult));
    }
  }

  // Run all checks in parallel
  const results = await Promise.all(checks);

  // Collect details and find first failure
  let firstFailure: CheckResult | null = null;
  for (const result of results) {
    details.push(result.detail);
    if (!result.ok && !firstFailure) {
      firstFailure = result;
    }
  }

  // Add raw error to details
  details.push(`Raw error: ${rawError.slice(0, 200)}${rawError.length > 200 ? '...' : ''}`);

  // Return specific issue if found
  if (firstFailure && firstFailure.failCode && firstFailure.failTitle && firstFailure.failMessage) {
    return {
      code: firstFailure.failCode,
      title: firstFailure.failTitle,
      message: firstFailure.failMessage,
      details,
    };
  }

  // All checks passed but still failed - likely service issue
  return {
    code: 'service_unavailable',
    title: 'Service Unavailable',
    message: `The ${providerLabel} service is experiencing issues. All credentials appear valid. Try again in a moment.`,
    details,
  };
}
