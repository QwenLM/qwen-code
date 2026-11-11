/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { redactTextForDebug } from '../../qoder/log-redaction.js';
import { runLogger } from '../../utils/runLogger.js';
import { CUSTOM_MODEL_PROVIDER_CONFIG_ERROR } from './customModelProviderConfigCommon.js';

type LogFields = Record<string, string | number | boolean | null | undefined>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>) : undefined;
}

/** Only diagnostic text is transformed; request data and errors are untouched. */
export function safeConfigLogText(
  text: string,
  secrets: readonly string[] = [],
): string {
  let safe = text;
  const variants = new Set<string>();
  for (const secret of secrets
    .flatMap((value) => [value, value.trim()])
    .filter(Boolean)) {
    variants.add(secret);
    variants.add(JSON.stringify(secret).slice(1, -1));
    try {
      variants.add(encodeURIComponent(secret));
    } catch {
      // Malformed UTF-16 is still a validation input worth diagnosing.
    }
  }
  for (const value of [...variants].sort((a, b) => b.length - a.length)) {
    safe = safe.split(value).join('[REDACTED]');
  }
  safe = safe.replace(/https?:\/\/[^\s"'<>]+/gi, (value) => {
    try {
      const url = new URL(value);
      // Userinfo, query strings and fragments can contain arbitrary credentials.
      return `${url.origin}${url.pathname}`;
    } catch {
      return '[invalid URL]';
    }
  });
  return redactTextForDebug(
    safe
      .replace(/\b(?:sk-|key-)[\w-]+/gi, '[REDACTED]')
      .replace(
        /((?:api[_-]?key|password|secret|token|authorization)\s*[=:]\s*)[^\s,;]+/gi,
        '$1[REDACTED]',
      )
      .replace(/[\r\n\t]/g, ' '),
    1024,
  );
}

/** A per-operation context, shared only by this config request's helpers. */
export class CustomModelProviderConfigLog {
  private readonly fields: LogFields;
  private readonly startedAt = Date.now();
  private readonly secrets = new Set<string>();

  constructor(operation: string, requestId?: string) {
    this.fields = {
      operation,
      request_id: requestId ?? 'local',
      stage: 'validation',
    };
  }

  addSecrets(...values: unknown[]): void {
    for (const value of values) {
      if (typeof value === 'string' && value) this.secrets.add(value);
    }
  }

  context(fields: LogFields): void {
    Object.assign(this.fields, fields);
  }

  captureError(error: unknown): void {
    // Keep transport details before callers normalize the error for the wire.
    this.context(this.errorFields(error));
  }

  event(event: string, fields: LogFields = {}): void {
    this.write('log', { ...this.fields, event, ...fields });
  }

  warning(event: string, error: unknown, fields: LogFields = {}): void {
    this.write('warn', {
      ...this.fields,
      event,
      ...this.errorFields(error),
      ...fields,
    });
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      const result = await operation();
      this.write('log', {
        ...this.fields,
        result: 'success',
        duration_ms: Date.now() - this.startedAt,
      });
      return result;
    } catch (error) {
      const cancelled = signal?.aborted === true;
      const failure = this.errorFields(error);
      const level = cancelled
        ? 'log'
        : failure['code'] === CUSTOM_MODEL_PROVIDER_CONFIG_ERROR.persistFailed ||
            ['lock', 'read', 'parse', 'decrypt', 'encrypt', 'persist'].includes(
              String(this.fields['stage']),
            )
          ? 'error'
          : 'warn';
      this.write(level, {
        ...this.fields,
        ...failure,
        result: cancelled ? 'cancelled' : 'failed',
        duration_ms: Date.now() - this.startedAt,
      });
      throw error;
    }
  }

  private errorFields(error: unknown): LogFields {
    const record = asRecord(error) ?? {};
    const cause = asRecord(record['cause']);
    const scalar = (value: unknown) =>
      typeof value === 'string' || typeof value === 'number'
        ? value
        : undefined;
    // JSON parser errors may quote raw settings (including unknown credentials).
    const parsing = this.fields['stage'] === 'parse';
    return Object.fromEntries(
      Object.entries({
        error_name: scalar(record['name']),
        code: scalar(record['code']),
        field: scalar(record['field']),
        reason: parsing
          ? this.fields['operation'] === 'catalog'
            ? 'Failed to parse provider catalog'
            : 'Failed to parse stored provider configuration'
          : error instanceof Error
            ? error.message
            : String(error),
        cause_code: scalar(cause?.['code']),
        cause: parsing ? undefined : scalar(cause?.['message']),
        http_status: scalar(record['httpStatus'] ?? record['status']),
        upstream_code: scalar(record['upstreamCode']),
      }).filter(([, value]) => value !== undefined),
    );
  }

  private write(level: 'log' | 'warn' | 'error', fields: LogFields): void {
    // Whitelisted scalar fields only: never serialize configs, errors or headers.
    try {
      const safe = Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [
          key,
          typeof value === 'string'
            ? safeConfigLogText(value, [...this.secrets])
            : value,
        ]),
      );
      runLogger[level](`[custom-provider] ${JSON.stringify(safe)}`);
    } catch {
      // Diagnostics must not affect a successful mutation or mask its error.
    }
  }
}
