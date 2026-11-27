/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { BusinessInfo } from '../qoder/business-info.js';

/**
 * AsyncLocalStorage that carries the root session UUID through the entire
 * async call chain. Set once at the top-level entry point (e.g. QueryEngine)
 * and readable at any depth — including subagent model calls — without
 * parameter threading.
 */
export const sessionIdContext = new AsyncLocalStorage<string>();

/**
 * Retrieves the session ID from the async context, or returns undefined
 * if not set. Callers can provide their own fallback.
 */
export function getSessionIdFromContext(): string | undefined {
  return sessionIdContext.getStore();
}

/**
 * AsyncLocalStorage that carries the root requestSetId through the entire
 * async call chain. Set once by the main agent's query() invocation and
 * automatically inherited by all subagent calls without parameter threading.
 *
 * This allows the backend to group all LLM requests triggered by a single
 * user prompt (including subagent calls) under one requestSetId.
 */
export const requestSetIdContext = new AsyncLocalStorage<string>();

/**
 * Retrieves the requestSetId from the async context, or returns undefined
 * if not set (e.g. in subagent context before main agent injects it).
 */
export function getRequestSetIdFromContext(): string | undefined {
  return requestSetIdContext.getStore();
}

/**
 * AsyncLocalStorage that carries the main agent's BusinessInfo through the
 * async call chain. Set once by the main agent's query() invocation so that
 * subagents can inherit it (read-only) without parameter threading.
 */
export const businessInfoContext = new AsyncLocalStorage<
  Readonly<BusinessInfo>
>();

/**
 * Retrieves the BusinessInfo from the async context.
 * Returns undefined if not set (i.e. caller is the main agent itself).
 */
export function getBusinessInfoFromContext():
  | Readonly<BusinessInfo>
  | undefined {
  return businessInfoContext.getStore();
}

/**
 * AsyncLocalStorage that carries the caller-provided customContext for the
 * current turn. Set at the SDK submit boundary and by subagent/fork execution
 * when an explicit snapshot is supplied; utility, hook and tool requests then
 * inherit the same identity without threading the field through every call.
 *
 * Never fall back to "the latest turn": detached work must bind its own
 * snapshot so concurrent sessions cannot borrow another turn's identity.
 */
export const customContextContext = new AsyncLocalStorage<
  Readonly<Record<string, string>> | undefined
>();

/**
 * Retrieves the current turn's customContext from the async context, or
 * undefined when the request did not originate from a turn that supplied one.
 */
export function getCustomContextFromContext():
  | Readonly<Record<string, string>>
  | undefined {
  return customContextContext.getStore();
}

/**
 * Copies and freezes a customContext before it crosses an async boundary.
 * Callers may keep or mutate their source object; every request derived from
 * the same turn must observe one stable identity snapshot.
 */
export function snapshotCustomContext(
  value: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  return value === undefined ? undefined : Object.freeze({ ...value });
}

/**
 * Parses a custom_context value received on a control request. Returns
 * undefined for anything that is not a plain string-to-string map so callers
 * can ignore malformed optional input without changing request semantics.
 */
export function parseCustomContext(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  const parsed: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (key.length === 0 || typeof entry !== 'string') return undefined;
    parsed[key] = entry;
  }
  return Object.freeze(parsed);
}
