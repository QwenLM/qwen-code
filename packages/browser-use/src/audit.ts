/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { hasAuditedResult } from './core/index.js';

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const MAX_AUDITED_TEXT_LENGTH = 2_048;
const MAX_AUDITED_DOM_SNAPSHOT_LENGTH = 16 * 1_024;

export interface TrustedBrowserAuditEntry {
  sequence: number;
  method: string;
  backendPrimitive?: string;
  ok: boolean;
  request?: JsonValue;
  result?: JsonValue;
  errorCode?: string;
}

export interface BrowserOperationEntry {
  sequence: number;
  method: string;
  ok: boolean;
  tabId?: string;
}

export function sanitizeAuditRequest(
  method: string,
  args: unknown,
): JsonValue | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args))
    return undefined;
  const record = args as Record<string, unknown>;
  const base = sanitizeAuditRequestFields(method, record);
  const frames =
    frameHops(record.steps) +
    (typeof record.nodeId === 'string'
      ? Math.max(0, record.nodeId.split('/').length - 1)
      : 0);
  if (frames === 0) return base;
  return {
    ...(typeof base === 'object' && base !== null && !Array.isArray(base)
      ? base
      : {}),
    frames,
  };
}

/** Number of frame boundaries a locator plan crosses (frameLocator steps and path refs). */
export function frameHops(steps: unknown): number {
  if (!Array.isArray(steps)) return 0;
  let hops = 0;
  steps.forEach((step, index) => {
    if (typeof step !== 'object' || step === null) return;
    const record = step as Record<string, unknown>;
    if (record.kind === 'frame') hops += 1;
    if (index === 0 && record.kind === 'ref' && typeof record.ref === 'string')
      hops += record.ref.split('/').length - 1;
  });
  return hops;
}

export function sanitizeAuditResult(
  method: string,
  value: unknown,
  includeE2eAuditContent = false,
  args?: unknown,
): JsonValue | undefined {
  if (
    method === 'playwright.domSnapshot' ||
    method === 'dom_cua.get_visible_dom'
  ) {
    if (!includeE2eAuditContent || typeof value !== 'string') return undefined;
    const truncationMarker = '\n[Trusted audit text truncated]';
    return value.length <= MAX_AUDITED_DOM_SNAPSHOT_LENGTH
      ? value
      : `${value.slice(0, MAX_AUDITED_DOM_SNAPSHOT_LENGTH - truncationMarker.length)}${truncationMarker}`;
  }
  if (!hasAuditedResult(method)) return undefined;
  if (method === 'locator.getAttribute' && isSensitiveAttributeRequest(args))
    return '[REDACTED]';
  if (value === null || typeof value === 'number' || typeof value === 'boolean')
    return value;
  if (typeof value === 'string') {
    return includeE2eAuditContent
      ? value.slice(0, MAX_AUDITED_TEXT_LENGTH)
      : { kind: 'text', chars: value.length };
  }
  if (Array.isArray(value)) {
    return includeE2eAuditContent
      ? value
          .slice(0, 50)
          .map((item) => (typeof item === 'string' ? item.slice(0, 512) : null))
      : { kind: 'array', items: value.length };
  }
  return undefined;
}

function sanitizeAuditRequestFields(
  method: string,
  record: Record<string, unknown>,
): JsonValue | undefined {
  if (method === 'tab.goto' || method === 'playwright.waitForURL') {
    return typeof record.url === 'string'
      ? { url: record.url.slice(0, 2_048) }
      : undefined;
  }
  if (method === 'locator.fill' || method === 'locator.type') {
    return typeof record.value === 'string'
      ? { chars: record.value.length }
      : undefined;
  }
  if (method === 'dom_cua.type') {
    return typeof record.text === 'string' && typeof record.nodeId === 'string'
      ? { nodeId: record.nodeId.slice(0, 200), chars: record.text.length }
      : undefined;
  }
  if (
    [
      'dom_cua.click',
      'dom_cua.double_click',
      'dom_cua.hover',
      'dom_cua.screenshot',
    ].includes(method)
  ) {
    return typeof record.nodeId === 'string'
      ? { nodeId: record.nodeId.slice(0, 200) }
      : undefined;
  }
  if (method === 'dom_cua.keypress') {
    return typeof record.nodeId === 'string' && Array.isArray(record.keys)
      ? { nodeId: record.nodeId.slice(0, 200), keys: stringItems(record.keys) }
      : undefined;
  }
  if (method === 'dom_cua.scroll') {
    return typeof record.nodeId === 'string' &&
      typeof record.scrollX === 'number' &&
      typeof record.scrollY === 'number'
      ? {
          nodeId: record.nodeId.slice(0, 200),
          scrollX: record.scrollX,
          scrollY: record.scrollY,
        }
      : undefined;
  }
  if (method === 'cua.type')
    return typeof record.text === 'string'
      ? { chars: record.text.length }
      : undefined;
  if (['cua.click', 'cua.double_click', 'cua.move'].includes(method)) {
    return typeof record.x === 'number' && typeof record.y === 'number'
      ? { x: record.x, y: record.y }
      : undefined;
  }
  if (method === 'cua.scroll') {
    return typeof record.x === 'number' &&
      typeof record.y === 'number' &&
      typeof record.scrollX === 'number' &&
      typeof record.scrollY === 'number'
      ? {
          x: record.x,
          y: record.y,
          scrollX: record.scrollX,
          scrollY: record.scrollY,
        }
      : undefined;
  }
  if (method === 'cua.drag')
    return Array.isArray(record.path)
      ? { points: record.path.length }
      : undefined;
  if (method === 'cua.keypress')
    return Array.isArray(record.keys)
      ? { keys: stringItems(record.keys) }
      : undefined;
  if (method === 'locator.setInputFiles')
    return Array.isArray(record.paths)
      ? { files: record.paths.length }
      : undefined;
  if (method === 'fileChooser.setFiles')
    return Array.isArray(record.files)
      ? { files: record.files.length }
      : undefined;
  if (method === 'locator.waitFor')
    return typeof record.state === 'string'
      ? { state: record.state.slice(0, 64) }
      : undefined;
  return undefined;
}

function stringItems(value: unknown[]): string[] {
  return value
    .filter((item): item is string => typeof item === 'string')
    .slice(0, 32);
}

function isSensitiveAttributeRequest(args: unknown): boolean {
  if (typeof args !== 'object' || args === null || Array.isArray(args))
    return false;
  const name = (args as Record<string, unknown>).name;
  return (
    typeof name === 'string' &&
    /password|passwd|secret|token|credential|authorization|cookie|value/i.test(
      name,
    )
  );
}
