/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Buffer } from 'node:buffer';
import { clearTimeout, setTimeout } from 'node:timers';

import type { Page } from 'playwright-core';

import { BrowserRuntimeError } from '../core/errors.js';
import type {
  DispatchResult,
  LocatorMatcher,
  LogEntry,
} from '../core/primitives.js';
import type { Args, ProviderTab } from './runtime-state.js';

const DEFAULT_TIMEOUT_MS = 30_000;

type KeyboardModifier = 'Alt' | 'Control' | 'ControlOrMeta' | 'Meta' | 'Shift';
type MouseButton = 'left' | 'middle' | 'right';

export function providerTabs(value: unknown): ProviderTab[] {
  if (!Array.isArray(value))
    throw new BrowserRuntimeError(
      'OPERATION_FAILED',
      'Chrome extension returned an invalid tab list',
    );
  return value.map(providerTab);
}

export function providerTab(value: unknown): ProviderTab {
  const tab = record(value);
  if (typeof tab.providerTabId !== 'number')
    throw new BrowserRuntimeError(
      'OPERATION_FAILED',
      'Chrome extension returned an invalid tab',
    );
  return {
    providerTabId: tab.providerTabId,
    title: typeof tab.title === 'string' ? tab.title : null,
    url: typeof tab.url === 'string' ? tab.url : null,
    ...(typeof tab.active === 'boolean' ? { active: tab.active } : {}),
    ...(typeof tab.lastOpened === 'string'
      ? { lastOpened: tab.lastOpened }
      : {}),
    ...(typeof tab.tabGroup === 'string' ? { tabGroup: tab.tabGroup } : {}),
    ...(typeof tab.derivedFromProviderTabId === 'number'
      ? { derivedFromProviderTabId: tab.derivedFromProviderTabId }
      : {}),
  };
}

export function matcher(value: LocatorMatcher): string | RegExp {
  return typeof value === 'string'
    ? value
    : new RegExp(value.regex, value.flags ?? '');
}

export function navigationOptions(args: Args): {
  timeout: number;
  waitUntil: 'commit' | 'domcontentloaded' | 'load' | 'networkidle';
} {
  return {
    timeout: timeoutArg(args),
    waitUntil:
      args.waitUntil === 'commit' ||
      args.waitUntil === 'domcontentloaded' ||
      args.waitUntil === 'networkidle'
        ? args.waitUntil
        : 'load',
  };
}

export function loadState(
  value: unknown,
): 'domcontentloaded' | 'load' | 'networkidle' {
  return value === 'domcontentloaded' || value === 'networkidle'
    ? value
    : 'load';
}

export function timeoutArg(args: Args, fallback = DEFAULT_TIMEOUT_MS): number {
  return typeof args.timeoutMs === 'number' ? args.timeoutMs : fallback;
}

export function timeoutOption(args: Args): { timeout: number } {
  return { timeout: timeoutArg(args) };
}

export function clickOptions(args: Args): {
  timeout: number;
  button: MouseButton;
  modifiers: KeyboardModifier[];
  force?: boolean;
} {
  return {
    timeout: timeoutArg(args),
    button: mouseButton(args.button),
    modifiers: modifiers(args.modifiers),
    ...(args.force === true ? { force: true } : {}),
  };
}

export function mouseButton(value: unknown): MouseButton {
  switch (value) {
    case undefined:
    case 1:
    case 'left':
      return 'left';
    case 2:
    case 'middle':
      return 'middle';
    case 3:
    case 'right':
      return 'right';
    default:
      throw new BrowserRuntimeError(
        'INVALID_ARGUMENT',
        'Playwright supports left, middle and right mouse buttons',
      );
  }
}

export function modifiers(value: unknown): KeyboardModifier[] {
  if (value === undefined) return [];
  const values = stringArray(value);
  return values.map((item) => {
    const normalized = item.replace(/[\s_-]/g, '').toLowerCase();
    if (normalized === 'alt' || normalized === 'option') return 'Alt';
    if (normalized === 'control' || normalized === 'ctrl') return 'Control';
    if (
      normalized === 'meta' ||
      normalized === 'command' ||
      normalized === 'cmd'
    )
      return 'Meta';
    if (normalized === 'shift') return 'Shift';
    if (normalized === 'controlormeta' || normalized === 'ctrlormeta')
      return 'ControlOrMeta';
    throw new BrowserRuntimeError(
      'INVALID_ARGUMENT',
      `Unsupported modifier key: ${item}`,
    );
  });
}

export async function withModifiers(
  page: Page,
  value: unknown,
  action: () => Promise<void>,
): Promise<void> {
  const keys = modifiers(value);
  for (const key of keys) await page.keyboard.down(key);
  try {
    await action();
  } finally {
    for (const key of [...keys].reverse()) await page.keyboard.up(key);
  }
}

export function keyChord(value: unknown): string {
  return stringArray(value).join('+');
}

export function selectOptions(
  value: unknown,
):
  | string
  | string[]
  | { value?: string; label?: string; index?: number }
  | Array<{ value?: string; label?: string; index?: number }> {
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value.map((item) =>
      typeof item === 'string' ? item : selectOptionRecord(item),
    ) as string[] | Array<{ value?: string; label?: string; index?: number }>;
  return selectOptionRecord(value);
}

export function selectOptionRecord(value: unknown): {
  value?: string;
  label?: string;
  index?: number;
} {
  const item = record(value);
  return {
    ...(typeof item.value === 'string' ? { value: item.value } : {}),
    ...(typeof item.label === 'string' ? { label: item.label } : {}),
    ...(typeof item.index === 'number' ? { index: item.index } : {}),
  };
}

export function consoleLevel(value: string): LogEntry['level'] {
  if (
    value === 'debug' ||
    value === 'info' ||
    value === 'warn' ||
    value === 'error'
  )
    return value;
  return 'log';
}

export function isClip(value: unknown): value is {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const clip = record(value);
  return (
    typeof clip.x === 'number' &&
    typeof clip.y === 'number' &&
    typeof clip.width === 'number' &&
    typeof clip.height === 'number'
  );
}

export function pngDimensions(buffer: Buffer): {
  width: number;
  height: number;
} {
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG')
    throw new BrowserRuntimeError(
      'OPERATION_FAILED',
      'Playwright returned an invalid PNG screenshot',
    );
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export function staleTabError(): BrowserRuntimeError {
  return new BrowserRuntimeError(
    'STALE_TAB',
    'The Chrome tab is closed or stale; claim a tab again to continue',
  );
}

export function isoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  throw new BrowserRuntimeError(
    'INVALID_ARGUMENT',
    'Expected an ISO date string',
  );
}

export function stringArg(args: Args, name: string): string {
  const value = args[name];
  if (typeof value !== 'string')
    throw new BrowserRuntimeError(
      'INVALID_ARGUMENT',
      `Missing string argument: ${name}`,
    );
  return value;
}

export function numberArg(args: Args, name: string): number {
  const value = args[name];
  if (typeof value !== 'number')
    throw new BrowserRuntimeError(
      'INVALID_ARGUMENT',
      `Missing number argument: ${name}`,
    );
  return value;
}

export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new BrowserRuntimeError(
      'INVALID_ARGUMENT',
      'Expected a string array',
    );
  return value;
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

export function pushBounded<T>(array: T[], value: T, limit = 1_000): void {
  array.push(value);
  if (array.length > limit) array.splice(0, array.length - limit);
}

export function jsonResult(value: unknown): DispatchResult {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as DispatchResult;
  } catch {
    throw new BrowserRuntimeError(
      'OPERATION_FAILED',
      'Browser evaluation returned a non-serializable value',
    );
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeout: number,
): Promise<T> {
  if (timeout === 0) return await promise;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Operation timed out after ${timeout}ms`)),
          timeout,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
