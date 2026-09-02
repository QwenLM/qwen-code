/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { BrowserRuntimeError, type RuntimeErrorCode } from './errors.js';
import type { DialogInfo, DispatchResult } from './primitives.js';

export interface ProviderTab {
  providerTabId: number;
  derivedFromProviderTabId?: number;
  title: string | null;
  url: string | null;
  active: boolean;
  windowId: number;
  lastOpened?: string;
  tabGroup?: string;
}

const PAGE_ERROR_CODES: ReadonlySet<RuntimeErrorCode> = new Set([
  'INVALID_LOCATOR',
  'LOCATOR_NOT_UNIQUE',
  'OPERATION_TIMEOUT',
  'INVALID_ARGUMENT',
  'OPERATION_FAILED',
]);
const PAGE_ERROR_PATTERN =
  /(INVALID_LOCATOR|LOCATOR_NOT_UNIQUE|OPERATION_TIMEOUT|INVALID_ARGUMENT|OPERATION_FAILED): ([^\n]*)/;
const PAGE_ERROR_DETAILS_PATTERN = /__QWEN_BROWSER_DETAILS__:(\{[^\n]*\})/;
const TRANSIENT_CONTEXT_PATTERN =
  /Execution context was destroyed|Cannot find context with specified id|Inspected target navigated or closed|uniqueContextId not found|Could not find object with given id/i;

export function isoTimestamp(value: unknown, name: string): string {
  const timestamp =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'string' && value.trim() !== ''
        ? Date.parse(value)
        : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    throw new BrowserRuntimeError(
      'INVALID_ARGUMENT',
      `History ${name} must be a valid date`,
    );
  }
  return new Date(timestamp).toISOString();
}

export function providerTabs(value: unknown): ProviderTab[] {
  if (!Array.isArray(value))
    throw new BrowserRuntimeError(
      'OPERATION_FAILED',
      'Chrome extension returned an invalid tab list',
    );
  return value.map(providerTab);
}

export function providerTab(value: unknown): ProviderTab {
  const tab = objectValue(value);
  if (typeof tab.providerTabId !== 'number')
    throw new BrowserRuntimeError(
      'OPERATION_FAILED',
      'Chrome extension returned an invalid tab',
    );
  const derivedFromProviderTabId =
    typeof tab.derivedFromProviderTabId === 'number' &&
    Number.isInteger(tab.derivedFromProviderTabId) &&
    tab.derivedFromProviderTabId >= 0
      ? tab.derivedFromProviderTabId
      : undefined;
  return {
    providerTabId: tab.providerTabId,
    ...(derivedFromProviderTabId === undefined
      ? {}
      : { derivedFromProviderTabId }),
    title: typeof tab.title === 'string' ? tab.title : null,
    url: typeof tab.url === 'string' ? tab.url : null,
    active: tab.active === true,
    windowId: typeof tab.windowId === 'number' ? tab.windowId : -1,
    ...(typeof tab.lastOpened === 'string' && tab.lastOpened !== ''
      ? { lastOpened: tab.lastOpened }
      : {}),
    ...(typeof tab.tabGroup === 'string' && tab.tabGroup !== ''
      ? { tabGroup: tab.tabGroup }
      : {}),
  };
}

export function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function jsonValue(value: unknown): DispatchResult {
  try {
    return JSON.parse(JSON.stringify(value)) as DispatchResult;
  } catch {
    throw new BrowserRuntimeError(
      'OPERATION_FAILED',
      'Chrome returned a non-serializable result',
    );
  }
}

export function remoteEvaluationValue(value: unknown): DispatchResult {
  const remote = objectValue(value);
  if ('value' in remote) return jsonValue(remote.value);
  if (typeof remote.unserializableValue !== 'string') return null;
  switch (remote.unserializableValue) {
    case '-0':
      return -0;
    case 'NaN':
    case 'Infinity':
    case '-Infinity':
      return null;
    default:
      return /^-?\d+n$/.test(remote.unserializableValue)
        ? remote.unserializableValue.slice(0, -1)
        : remote.unserializableValue;
  }
}

export function parseAllowedOrigins(
  values: readonly string[] | undefined,
): ReadonlySet<string> | undefined {
  if (values === undefined) return undefined;
  const origins = new Set<string>();
  for (const value of values) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value)
        throw new Error();
      origins.add(url.origin);
    } catch {
      throw new BrowserRuntimeError(
        'INVALID_ARGUMENT',
        `Invalid allowed Chrome origin: ${value}`,
      );
    }
  }
  return origins;
}

export function parseUploadRoots(
  values: readonly string[] | undefined,
): readonly string[] | undefined {
  if (values === undefined || values.length === 0) return undefined;
  return values.map((value) => {
    if (!isAbsolute(value))
      throw new BrowserRuntimeError(
        'INVALID_ARGUMENT',
        `Upload root must be an absolute path: ${value}`,
      );
    try {
      return realpathSync(value);
    } catch {
      throw new BrowserRuntimeError(
        'INVALID_ARGUMENT',
        `Upload root does not exist: ${value}`,
      );
    }
  });
}

export function isActionOperation(operation: string): boolean {
  return ['fill', 'focus', 'selectOption'].includes(operation);
}

export function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export function dialogOpenError(dialog: DialogInfo): BrowserRuntimeError {
  return new BrowserRuntimeError(
    'DIALOG_OPEN',
    `A JavaScript ${dialog.type} dialog is open on this tab ("${dialog.message.slice(0, 200)}") and is blocking further page operations.`,
    { type: dialog.type, message: dialog.message.slice(0, 200) },
  );
}

export function exceptionDescription(details: unknown): string {
  const record = objectValue(details);
  const exception = objectValue(record.exception);
  if (typeof exception.description === 'string') return exception.description;
  if (typeof record.text === 'string') return record.text;
  return 'Page command failed';
}

export function pageError(description: string): BrowserRuntimeError {
  const match = PAGE_ERROR_PATTERN.exec(description);
  if (match !== null && PAGE_ERROR_CODES.has(match[1] as RuntimeErrorCode)) {
    return new BrowserRuntimeError(
      match[1] as RuntimeErrorCode,
      (match[2] ?? '').slice(0, 500),
      pageErrorDetails(description),
    );
  }
  if (TRANSIENT_CONTEXT_PATTERN.test(description))
    return transientNavigationError();
  return new BrowserRuntimeError(
    'OPERATION_FAILED',
    'Chrome page command failed',
  );
}

export function isPageErrorDescription(description: string): boolean {
  return (
    PAGE_ERROR_PATTERN.test(description) ||
    TRANSIENT_CONTEXT_PATTERN.test(description)
  );
}

function pageErrorDetails(
  description: string,
): Readonly<Record<string, unknown>> | undefined {
  const encoded = PAGE_ERROR_DETAILS_PATTERN.exec(description)?.[1];
  if (encoded === undefined) return undefined;
  try {
    const parsed = JSON.parse(encoded) as unknown;
    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function locatorOperationError(error: unknown, action: string): unknown {
  if (!(error instanceof BrowserRuntimeError) || error.details === undefined)
    return error;
  return new BrowserRuntimeError(error.code, error.message, {
    ...error.details,
    action,
  });
}

export function evaluationError(description: string): BrowserRuntimeError {
  const firstLine =
    description.split('\n')[0]?.trim() || 'JavaScript evaluation failed';
  return new BrowserRuntimeError(
    'OPERATION_FAILED',
    `JavaScript evaluation failed: ${firstLine.slice(0, 500)}`,
  );
}

export function transientOrOriginal(error: unknown): unknown {
  if (
    error instanceof BrowserRuntimeError &&
    error.code !== 'OPERATION_TIMEOUT' &&
    TRANSIENT_CONTEXT_PATTERN.test(error.message)
  ) {
    return transientNavigationError();
  }
  return error;
}

export function inputBlockedError(): BrowserRuntimeError {
  return new BrowserRuntimeError(
    'INPUT_BLOCKED',
    'Keyboard input did not reach the page. Chrome is probably showing a tab-level dialog (for example a password warning) that blocks all automation input on this tab; ask the user to dismiss it, or continue in a new tab from tabs.new()',
  );
}

export function transientNavigationError(): BrowserRuntimeError {
  return new BrowserRuntimeError(
    'OPERATION_FAILED',
    'The page navigated while the command was running; observe the page again and retry',
    { transient: true },
  );
}

export function isTransientNavigationError(error: unknown): boolean {
  return (
    error instanceof BrowserRuntimeError && error.details?.transient === true
  );
}

export function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.pathname.length > 1 && url.pathname.endsWith('/'))
      url.pathname = url.pathname.slice(0, -1);
    return url.href;
  } catch {
    return value;
  }
}

export function urlMatches(actual: string, expected: string): boolean {
  const normalizedActual = normalizeUrl(actual);
  if (!expected.includes('*'))
    return normalizedActual === normalizeUrl(expected);
  const pattern = expected.includes('://') ? normalizeUrl(expected) : expected;
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*');
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(normalizedActual) || regex.test(actual);
}

export function pngDimensions(
  base64: string,
): { width: number; height: number } | undefined {
  const head = Buffer.from(base64.slice(0, 44), 'base64');
  if (head.byteLength < 24 || head.readUInt32BE(0) !== 0x89504e47)
    return undefined;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}
