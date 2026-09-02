/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChromeBridge } from './bridge/index.js';
import {
  BrowserRuntimeError,
  ChromeRuntime,
  DEFAULT_CHROME_DOCUMENTATION,
} from './core/index.js';
import { sanitizeAuditRequest, sanitizeAuditResult } from './audit.js';

export type BrowserBridge = ChromeBridge;

export interface BrowserAuditEntry {
  method: string;
  ok: boolean;
  request?: unknown;
  result?: unknown;
  error?: string;
}

export class BrowserRuntime {
  readonly browserId: string;

  private readonly runtime: ChromeRuntime;
  private readonly includeAuditContent: boolean;
  private audit: BrowserAuditEntry[] = [];

  constructor(
    bridge: ChromeBridge,
    allowedOrigins = process.env['QWEN_BROWSER_USE_ALLOWED_ORIGINS'] ?? '',
  ) {
    const origins = commaSeparated(allowedOrigins);
    const uploadRoots = commaSeparated(
      process.env['QWEN_BROWSER_USE_UPLOAD_ROOTS'] ?? '',
    );
    this.runtime = new ChromeRuntime({
      bridge,
      documentation: DEFAULT_CHROME_DOCUMENTATION,
      ...(origins.length === 0 ? {} : { allowedOrigins: origins }),
      ...(uploadRoots.length === 0 ? {} : { uploadRoots }),
    });
    this.browserId = this.runtime.browserId;
    this.includeAuditContent =
      process.env['QWEN_BROWSER_USE_E2E_AUDIT'] === '1';
  }

  async dispatch(method: string, args: unknown): Promise<unknown> {
    const request = sanitizeAuditRequest(method, args);
    try {
      const value = await this.runtime.dispatch(method, args);
      const result = sanitizeAuditResult(
        method,
        value,
        this.includeAuditContent,
        args,
      );
      this.appendAudit({
        method,
        ok: true,
        ...(request === undefined ? {} : { request }),
        ...(result === undefined ? {} : { result }),
      });
      return value;
    } catch (error) {
      this.appendAudit({
        method,
        ok: false,
        ...(request === undefined ? {} : { request }),
        error:
          error instanceof BrowserRuntimeError
            ? error.code
            : 'OPERATION_FAILED',
      });
      throw error;
    }
  }

  drainAudit(): BrowserAuditEntry[] {
    const entries = this.audit;
    this.audit = [];
    return entries;
  }

  async stop(): Promise<void> {
    await this.runtime.stop();
  }

  private appendAudit(entry: BrowserAuditEntry): void {
    this.audit.push(entry);
    if (this.audit.length > 1_000) this.audit.shift();
  }
}

function commaSeparated(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
