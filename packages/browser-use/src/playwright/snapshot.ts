/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Locator, Page } from 'playwright-core';

import { BrowserRuntimeError } from '../core/errors.js';
import { SNAPSHOT_REF_PATTERN } from '../core/primitives.js';
import type { TabState } from './runtime-state.js';

const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

interface SnapshotNode {
  line: string;
  role: string | undefined;
  children: SnapshotNode[];
}

export async function snapshotTab(
  tab: TabState,
  options: { interactiveOnly?: boolean } = {},
): Promise<string> {
  const raw = await tab.page.ariaSnapshot({ mode: 'ai' });
  const text = options.interactiveOnly
    ? renderNodes(selectInteractiveNodes(parseSnapshot(raw)))
    : raw;
  return truncateLines(text, 20_000);
}

export async function snapshotRefLocator(
  page: Page,
  ref: string,
): Promise<Locator> {
  if (!SNAPSHOT_REF_PATTERN.test(ref)) throw invalidRef(ref);
  const locator = page.locator(`aria-ref=${ref}`);
  if ((await locator.count()) !== 1) throw invalidRef(ref);
  return locator;
}

function invalidRef(ref: string): BrowserRuntimeError {
  return new BrowserRuntimeError(
    'INVALID_LOCATOR',
    `Snapshot ref ${ref} is stale or unknown; take a new domSnapshot`,
  );
}

function parseSnapshot(text: string): SnapshotNode[] {
  const roots: SnapshotNode[] = [];
  const stack: Array<{ indent: number; node: SnapshotNode }> = [];
  let blockScalarIndent: number | undefined;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (blockScalarIndent !== undefined) {
      if (indent > blockScalarIndent) continue;
      blockScalarIndent = undefined;
    }
    while ((stack.at(-1)?.indent ?? -1) >= indent) stack.pop();
    const role = /^\s*-\s+([\w-]+)/.exec(line)?.[1];
    const node: SnapshotNode = {
      line,
      role,
      children: [],
    };
    const parent = stack.at(-1)?.node;
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push({ indent, node });
    if (/[:]\s*[|>](?:[1-9][+-]?|[+-][1-9]?)?\s*$/.test(line))
      blockScalarIndent = indent;
  }
  return roots;
}

function selectInteractiveNodes(
  nodes: readonly SnapshotNode[],
): SnapshotNode[] {
  const selected: SnapshotNode[] = [];
  for (const node of nodes) {
    const children = selectInteractiveNodes(node.children);
    const keep =
      node.role === 'iframe' ||
      (node.role !== undefined && INTERACTIVE_ROLES.has(node.role));
    if (keep) selected.push({ ...node, children });
    else selected.push(...children);
  }
  return selected;
}

function renderNodes(nodes: readonly SnapshotNode[], depth = 0): string {
  const lines: string[] = [];
  for (const node of nodes) {
    const line = node.line.trimStart();
    lines.push(`${'  '.repeat(depth)}${line}`);
    const children = renderNodes(node.children, depth + 1);
    if (children !== '') lines.push(children);
  }
  return lines.join('\n');
}

function truncateLines(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = `[truncated: snapshot exceeded ${maxChars} characters]`;
  const lines: string[] = [];
  let chars = marker.length + 1;
  for (const line of text.split('\n')) {
    if (chars + line.length + 1 > maxChars) break;
    lines.push(line);
    chars += line.length + 1;
  }
  lines.push(marker);
  return lines.join('\n');
}
