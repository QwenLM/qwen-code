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
  prop: boolean;
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
    // Playwright YAML-quotes the whole key when the name needs it, and node
    // props (e.g. /url) use a slash-prefixed key; the role token itself is
    // never quoted.
    const key = /^\s*-\s+'?(\/?[\w-]+)/.exec(line)?.[1];
    const node: SnapshotNode = {
      line,
      role: key !== undefined && !key.startsWith('/') ? key : undefined,
      prop: key?.startsWith('/') === true,
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

// A YAML-quoted key ends at its closing quote ('' escapes a quote); an
// unquoted key ends at the colon that introduces children or inline text.
// Either way the attribute list — [ref=…] and the cursor marker — lives
// inside the key, so a suffix test must run on the extracted key, not the
// rendered line.
const QUOTED_KEY = /^'((?:[^']|'')*)'(?::(?:\s.*)?)?$/;

function nodeKey(line: string): string {
  const body = line.trimEnd().replace(/^\s*-\s+/, '');
  const quoted = QUOTED_KEY.exec(body);
  if (quoted !== null) return (quoted[1] ?? '').replace(/''/g, "'");
  const separator = /:(?=\s|$)/.exec(body);
  return separator === null ? body : body.slice(0, separator.index);
}

function selectInteractiveNodes(
  nodes: readonly SnapshotNode[],
  parentSelected = false,
): SnapshotNode[] {
  const selected: SnapshotNode[] = [];
  for (const node of nodes) {
    // AI mode appends [cursor=pointer] as the final attribute of a node's
    // key; a page-controlled name or text value that merely contains the
    // literal must not promote the line.
    const cursorPointer =
      node.role !== undefined &&
      node.role !== 'text' &&
      nodeKey(node.line).endsWith(' [cursor=pointer]');
    const keep =
      node.role === 'iframe' ||
      (node.role !== undefined && INTERACTIVE_ROLES.has(node.role)) ||
      cursorPointer;
    if (keep) {
      selected.push({
        ...node,
        children: selectInteractiveNodes(node.children, true),
      });
    } else if (parentSelected && node.prop) {
      // A prop (e.g. /url) is only meaningful under its kept parent.
      selected.push({ ...node, children: [] });
    } else {
      selected.push(...selectInteractiveNodes(node.children));
    }
  }
  return selected;
}

function renderNodes(nodes: readonly SnapshotNode[], depth = 0): string {
  const lines: string[] = [];
  for (const node of nodes) {
    let line = node.line.trimStart();
    // A trailing colon declares children; drop it once filtering removed
    // them so the listing does not claim subtrees it omits.
    if (!node.prop && node.children.length === 0 && line.endsWith(':'))
      line = line.slice(0, -1);
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
