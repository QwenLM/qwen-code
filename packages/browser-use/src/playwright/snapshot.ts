/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Locator } from 'playwright-core';

import { BrowserRuntimeError } from '../core/errors.js';
import { SNAPSHOT_REF_PATTERN } from '../core/primitives.js';
import type { TabState } from './runtime-state.js';

export async function snapshotTab(tab: TabState): Promise<string> {
  const raw = await tab.page.ariaSnapshot({ mode: 'ai' });
  const text = truncateLines(raw, 20_000);
  // Playwright re-issues e1…eN from zero on every new document, so a ref is
  // valid only while the snapshot that emitted it is current. Record what
  // the returned (post-truncation) text actually carries; the session's
  // main-frame navigation observer clears the set.
  tab.snapshotRefs = collectRefs(text);
  return text;
}

export async function snapshotRefLocator(
  tab: TabState,
  ref: string,
): Promise<Locator> {
  if (!SNAPSHOT_REF_PATTERN.test(ref) || tab.snapshotRefs?.has(ref) !== true)
    throw invalidRef(ref);
  const locator = tab.page.locator(`aria-ref=${ref}`);
  if ((await locator.count()) !== 1) throw invalidRef(ref);
  return locator;
}

function invalidRef(ref: string): BrowserRuntimeError {
  return new BrowserRuntimeError(
    'INVALID_LOCATOR',
    `Snapshot ref ${ref} is stale or unknown; take a new domSnapshot`,
  );
}

function collectRefs(text: string): ReadonlySet<string> {
  const refs = new Set<string>();
  for (const match of text.matchAll(/\[ref=([^\s\]]+)\]/g)) {
    const ref = match[1];
    if (ref !== undefined && SNAPSHOT_REF_PATTERN.test(ref)) refs.add(ref);
  }
  return refs;
}

function truncateLines(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = `[truncated: snapshot exceeded ${maxChars} characters]`;
  const lines: string[] = [];
  let chars = marker.length + 1;
  let truncated = false;
  for (const line of text.split('\n')) {
    // Skip a line that does not fit instead of stopping: one long node must
    // not discard every ref that follows it.
    if (chars + line.length + 1 > maxChars) {
      truncated = true;
      continue;
    }
    lines.push(line);
    chars += line.length + 1;
  }
  if (truncated) lines.push(marker);
  return lines.join('\n');
}
