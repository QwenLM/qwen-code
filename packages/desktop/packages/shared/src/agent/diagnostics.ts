/**
 * Error diagnostics for backend failures.
 *
 * Qwen Code is the only built-in backend, so diagnostics focus on captured
 * HTTP failures and the raw process error text.
 */

import { getLastApiError } from '../interceptor-common.ts';
import type { LlmProviderType } from '../config/llm-connections.ts';

export type DiagnosticCode =
  | 'billing_error'
  | 'token_expired'
  | 'invalid_credentials'
  | 'rate_limited'
  | 'mcp_unreachable'
  | 'service_unavailable'
  | 'unknown_error';

export interface DiagnosticResult {
  code: DiagnosticCode;
  title: string;
  message: string;
  details: string[];
}

interface DiagnosticConfig {
  authType?: string;
  workspaceId?: string;
  rawError: string;
  providerType?: LlmProviderType;
  baseUrl?: string;
}

interface CheckResult {
  ok: boolean;
  detail: string;
  failCode?: DiagnosticCode;
  failTitle?: string;
  failMessage?: string;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, defaultValue: T): Promise<T> {
  const timeoutPromise = new Promise<T>((resolve) => setTimeout(() => resolve(defaultValue), timeoutMs));
  return Promise.race([promise, timeoutPromise]);
}

async function checkCapturedApiError(providerLabel: string): Promise<CheckResult> {
  const apiError = getLastApiError();

  if (!apiError) {
    return { ok: true, detail: 'API error: none captured' };
  }

  if (apiError.status === 402) {
    return {
      ok: false,
      detail: `API error: 402 ${apiError.message}`,
      failCode: 'billing_error',
      failTitle: 'Payment Required',
      failMessage: apiError.message || `${providerLabel} reported a billing issue.`,
    };
  }

  if (apiError.status === 401 || apiError.status === 403) {
    return {
      ok: false,
      detail: `API error: ${apiError.status} ${apiError.message}`,
      failCode: 'invalid_credentials',
      failTitle: 'Invalid Credentials',
      failMessage: apiError.message || 'Credentials are invalid or expired.',
    };
  }

  if (apiError.status === 429) {
    return {
      ok: false,
      detail: `API error: 429 ${apiError.message}`,
      failCode: 'rate_limited',
      failTitle: 'Rate Limited',
      failMessage: 'Too many requests. Please wait a moment before trying again.',
    };
  }

  if (apiError.status >= 500) {
    return {
      ok: false,
      detail: `API error: ${apiError.status} ${apiError.message}`,
      failCode: 'service_unavailable',
      failTitle: `${providerLabel} Service Error`,
      failMessage: `${providerLabel} returned an error (${apiError.status}). This is usually temporary.`,
    };
  }

  return { ok: true, detail: `API error: ${apiError.status} - ${apiError.message}` };
}

export async function runErrorDiagnostics(config: DiagnosticConfig): Promise<DiagnosticResult> {
  const providerLabel = config.providerType === 'qwen' ? 'Qwen Code' : 'Backend';
  const details: string[] = [];
  const defaultResult: CheckResult = { ok: true, detail: 'Check timed out' };

  const result = await withTimeout(checkCapturedApiError(providerLabel), 1000, defaultResult);
  details.push(result.detail);
  details.push(`Raw error: ${config.rawError.slice(0, 200)}${config.rawError.length > 200 ? '...' : ''}`);

  if (!result.ok && result.failCode && result.failTitle && result.failMessage) {
    return {
      code: result.failCode,
      title: result.failTitle,
      message: result.failMessage,
      details,
    };
  }

  return {
    code: 'service_unavailable',
    title: 'Backend Unavailable',
    message: `${providerLabel} is unavailable. Check the Qwen Code CLI installation and try again.`,
    details,
  };
}
