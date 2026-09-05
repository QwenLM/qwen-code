/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChildProcess } from 'node:child_process';

export function cdpEndpoint(env?: Record<string, string | undefined>): string;
export function parseSelectedPageUrl(pages: string): string | undefined;
export function waitForJson<T>(
  url: string,
  predicate: (value: T) => boolean,
  timeoutMs?: number,
  fetchImpl?: typeof fetch,
): Promise<T>;
export function stopChild(
  child: ChildProcess | undefined,
  options?: { graceMs?: number },
): Promise<void>;
export function isCdpSmokePassed(out: {
  tools: number;
  listPages: string | null;
  error: string | null;
}): boolean;
