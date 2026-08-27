/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';

interface MarkdownPoint {
  offset?: number;
}

interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  alt?: string;
  identifier?: string;
  lang?: string | null;
  children?: MarkdownNode[];
  position?: { start: MarkdownPoint; end: MarkdownPoint };
}

interface Replacement {
  start: number;
  end: number;
  value: string;
}

export interface MarkdownDocumentPolicy {
  normalizeUrl(source: string): string | undefined;
  replaceImage(alt: string, source: string | undefined): string;
  onUrlChange(code: 'url_rejected' | 'url_sanitized'): void;
  onComplexityLimit?(): void;
}

const MARKDOWN_COMPLEXITY_FALLBACK =
  '[markdown omitted: complexity limit exceeded]';
const MAX_MARKDOWN_SOURCE_MARKERS = 2_048;
const MAX_MARKDOWN_AST_NODES = 20_000;
const MAX_MARKDOWN_AST_DEPTH = 512;

const markdownParser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath);

function mayContainNavigableMarkdown(value: string): boolean {
  return (
    value.includes(']') ||
    value.includes('@') ||
    /www\.|(?:https?|mailto|javascript|data):/i.test(value) ||
    (value.includes('<') && value.includes('>'))
  );
}

function mayContainFencedCode(value: string): boolean {
  return value.includes('```') || value.includes('~~~');
}

function parseMarkdown(value: string): MarkdownNode | undefined {
  let markers = 0;
  for (const character of value) {
    if (character !== '[' && character !== ']' && character !== '>') continue;
    markers += 1;
    if (markers > MAX_MARKDOWN_SOURCE_MARKERS) return undefined;
  }
  try {
    const root = markdownParser.parse(value) as unknown as MarkdownNode;
    return isMarkdownTreeWithinBudget(root) ? root : undefined;
  } catch {
    return undefined;
  }
}

function walkMarkdown(
  node: MarkdownNode,
  visit: (node: MarkdownNode) => boolean | void,
): void {
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visit(current) === false) continue;
    const children = current.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }
}

function isMarkdownTreeWithinBudget(root: MarkdownNode): boolean {
  const stack: Array<{ node: MarkdownNode; depth: number }> = [
    { node: root, depth: 0 },
  ];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    nodes += 1;
    if (
      nodes > MAX_MARKDOWN_AST_NODES ||
      current.depth > MAX_MARKDOWN_AST_DEPTH
    ) {
      return false;
    }
    for (const child of current.node.children ?? []) {
      stack.push({ node: child, depth: current.depth + 1 });
    }
  }
  return true;
}

function rangeOf(
  node: MarkdownNode,
): { start: number; end: number } | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return typeof start === 'number' && typeof end === 'number'
    ? { start, end }
    : undefined;
}

function applyReplacements(value: string, replacements: Replacement[]): string {
  let result = value;
  let previousStart = Number.POSITIVE_INFINITY;
  for (const replacement of replacements.sort(
    (left, right) => right.start - left.start,
  )) {
    if (replacement.end > previousStart) continue;
    result =
      result.slice(0, replacement.start) +
      replacement.value +
      result.slice(replacement.end);
    previousStart = replacement.start;
  }
  return result;
}

function normalizedIdentifier(node: MarkdownNode): string | undefined {
  return node.identifier?.trim().toLowerCase();
}

function markdownText(node: MarkdownNode): string {
  if (node.type === 'text' || node.type === 'inlineCode') {
    return node.value ?? '';
  }
  if (node.type === 'image') return node.alt ?? '';
  return (node.children ?? []).map(markdownText).join('');
}

function escapeLabel(value: string): string {
  return value.replace(/([\\[\]])/g, '\\$1');
}

function safeLinkReplacement(
  original: string,
  node: MarkdownNode,
  safe: string | undefined,
): string {
  if (!safe) {
    return original.trimStart().startsWith('[')
      ? escapeLabel(markdownText(node))
      : '[link omitted]';
  }
  if (!original.trimStart().startsWith('[')) return safe;
  return `[${escapeLabel(markdownText(node))}](${safe})`;
}

export function sanitizeMarkdownDocument(
  value: string,
  policy: MarkdownDocumentPolicy,
): string {
  if (!mayContainNavigableMarkdown(value)) return value;
  const root = parseMarkdown(value);
  if (!root) {
    policy.onComplexityLimit?.();
    return MARKDOWN_COMPLEXITY_FALLBACK;
  }
  const definitions = new Map<string, MarkdownNode>();
  const imageDefinitionIds = new Set<string>();
  const linkDefinitionIds = new Set<string>();
  walkMarkdown(root, (node) => {
    if (node.type === 'definition') {
      const identifier = normalizedIdentifier(node);
      if (identifier && !definitions.has(identifier)) {
        definitions.set(identifier, node);
      }
    } else if (node.type === 'imageReference') {
      const identifier = normalizedIdentifier(node);
      if (identifier) imageDefinitionIds.add(identifier);
    } else if (node.type === 'linkReference') {
      const identifier = normalizedIdentifier(node);
      if (identifier) linkDefinitionIds.add(identifier);
    }
  });

  const replacements: Replacement[] = [];
  walkMarkdown(root, (node) => {
    const range = rangeOf(node);
    if (!range) return;
    if (node.type === 'code' || node.type === 'inlineCode') return false;
    if (node.type === 'image') {
      replacements.push({
        ...range,
        value: policy.replaceImage(node.alt ?? '', node.url),
      });
      return false;
    }
    if (node.type === 'imageReference') {
      const definition = definitions.get(normalizedIdentifier(node) ?? '');
      replacements.push({
        ...range,
        value: policy.replaceImage(node.alt ?? '', definition?.url),
      });
      return false;
    }
    if (node.type === 'html' && /<img\b/i.test(node.value ?? '')) {
      replacements.push({
        ...range,
        value: policy.replaceImage('', undefined),
      });
      return false;
    }
    if (node.type === 'definition') {
      const identifier = normalizedIdentifier(node);
      if (
        identifier &&
        imageDefinitionIds.has(identifier) &&
        !linkDefinitionIds.has(identifier)
      ) {
        replacements.push({ ...range, value: '' });
        return false;
      }
      const source = node.url ?? '';
      const safe = policy.normalizeUrl(source);
      if (safe === source) return false;
      policy.onUrlChange(safe ? 'url_sanitized' : 'url_rejected');
      replacements.push({
        ...range,
        value:
          safe && identifier ? `[${escapeLabel(identifier)}]: ${safe}` : '',
      });
      return false;
    }
    if (node.type === 'link') {
      const source = node.url ?? '';
      const safe = policy.normalizeUrl(source);
      if (safe === source) return;
      policy.onUrlChange(safe ? 'url_sanitized' : 'url_rejected');
      replacements.push({
        ...range,
        value: safeLinkReplacement(
          value.slice(range.start, range.end),
          node,
          safe,
        ),
      });
      return false;
    }
    return undefined;
  });
  return applyReplacements(value, replacements);
}

function richLanguage(node: MarkdownNode): string | undefined {
  if (node.type !== 'code' || !node.lang) return undefined;
  const language = node.lang.trim().toLowerCase();
  return ['text', 'plain', 'plaintext'].includes(language)
    ? undefined
    : language;
}

function demoteFence(
  value: string,
  node: MarkdownNode,
  language: string,
): Replacement | undefined {
  const range = rangeOf(node);
  if (!range) return undefined;
  const lineEnd = value.indexOf('\n', range.start);
  const end = lineEnd === -1 || lineEnd > range.end ? range.end : lineEnd;
  const opening = value.slice(range.start, end);
  const match = /^(`{3,}|~{3,})[ \t]*(\S+)(.*)$/.exec(opening);
  if (!match) return undefined;
  return {
    start: range.start,
    end,
    value: `${match[1]}text${match[3]} [source fallback: ${language.slice(0, 32)}]`,
  };
}

export function transformRichMarkdownTasks(
  value: string,
  keepTask: (language: string) => boolean,
): string {
  if (!mayContainFencedCode(value)) return value;
  const replacements: Replacement[] = [];
  const root = parseMarkdown(value);
  if (!root) return MARKDOWN_COMPLEXITY_FALLBACK;
  walkMarkdown(root, (node) => {
    const language = richLanguage(node);
    if (!language || keepTask(language)) return;
    const replacement = demoteFence(value, node, language);
    if (replacement) replacements.push(replacement);
  });
  return applyReplacements(value, replacements);
}

export function countRichMarkdownTasks(value: string): number {
  if (!mayContainFencedCode(value)) return 0;
  let count = 0;
  const root = parseMarkdown(value);
  if (!root) return 0;
  walkMarkdown(root, (node) => {
    if (richLanguage(node)) count += 1;
  });
  return count;
}
