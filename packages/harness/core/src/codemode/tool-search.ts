/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Tool discovery shared by CodeMode searchTools and mcp_list: Okapi BM25 over tool and server text. */

import { isRecord } from '../utils/markdownUtils.js';
import { MCP_TOOL_PREFIX, parseMcpToolName } from '../mcp/tools/mcp-names.js';

export interface SearchableTool {
  name: string;
  description?: string;
  definition?: { description?: string; inputSchema: unknown };
  /** Owning MCP server. */
  namespace?: string;
}

export interface SearchableNamespace {
  name: string;
  description?: string;
  instructions?: string;
}

export interface ToolSearchOptions {
  browseOnEmptyTerms?: boolean;
  limit?: number;
  namespace?: string;
}

export const DEFAULT_SEARCH_LIMIT = 8;
const K1 = 1.2;
const B = 0.75;
const INSTRUCTION_CHARS = 2000;
const SCHEMA_TEXT_CHARS = 4000;
const SCHEMA_DEPTH = 6;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is',
  'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'with',
]);

/** Server names may be written as "docs", "mcp__docs" or with - and _ swapped. */
export function namespaceKey(name: string): string {
  return withoutMcpPrefix(name).toLowerCase().replace(/-/g, '_');
}

function withoutMcpPrefix(name: string): string {
  return name.startsWith(MCP_TOOL_PREFIX)
    ? name.slice(MCP_TOOL_PREFIX.length)
    : name;
}

/** Prefer the configured spelling. A shorthand is usable only if it identifies one server. */
export function resolveNamespaceName(
  names: Pick<ReadonlySet<string>, 'has' | 'keys'>,
  requested: string,
): string | undefined {
  if (names.has(requested)) return requested;
  const bare = withoutMcpPrefix(requested);
  if (names.has(bare)) return bare;
  const key = namespaceKey(requested);
  let match: string | undefined;
  for (const name of names.keys()) {
    if (namespaceKey(name) !== key) continue;
    if (match !== undefined) return undefined;
    match = name;
  }
  return match;
}

function stem(term: string): string {
  if (term.length > 4 && term.endsWith('ies')) return term.slice(0, -3) + 'y';
  if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term))
    return term.slice(0, -2);
  if (term.length > 3 && term.endsWith('s') && !term.endsWith('ss'))
    return term.slice(0, -1);
  return term;
}

const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}`;
const CJK_RUN = new RegExp(`^[${CJK}]`, 'u');
const SEGMENTS = new RegExp(`[${CJK}]+|(?:(?![${CJK}])[\\p{L}\\p{N}])+`, 'gu');

/** Words split at camelCase and punctuation; CJK runs become character bigrams. */
export function tokenize(value: string): string[] {
  const terms: string[] = [];
  const spaced = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
  for (const segment of spaced.match(SEGMENTS) ?? []) {
    if (!CJK_RUN.test(segment)) {
      if (!STOP_WORDS.has(segment))
        terms.push(/^[a-z0-9]+$/.test(segment) ? stem(segment) : segment);
    } else if (segment.length === 1) terms.push(segment);
    else
      for (let i = 0; i + 1 < segment.length; i++)
        terms.push(segment.slice(i, i + 2));
  }
  return terms;
}

function descriptionOf(value: unknown): string {
  const description = isRecord(value) ? value['description'] : undefined;
  return typeof description === 'string' ? description : '';
}

/** Property names and descriptions of an input schema, nested objects included. */
export function schemaSearchText(schema: unknown): string {
  const parts: string[] = [];
  let length = 0;
  const visit = (node: unknown, depth: number) => {
    if (!isRecord(node) || depth > SCHEMA_DEPTH || length > SCHEMA_TEXT_CHARS)
      return;
    if (isRecord(node['properties']))
      for (const [key, value] of Object.entries(node['properties'])) {
        const part = `${key} ${descriptionOf(value)}`;
        parts.push(part);
        length += part.length + 1;
        visit(value, depth + 1);
      }
    visit(node['items'], depth + 1);
    for (const key of ['anyOf', 'oneOf', 'allOf'])
      if (Array.isArray(node[key]))
        for (const item of node[key]) visit(item, depth + 1);
  };
  visit(schema, 0);
  return parts.join(' ').slice(0, SCHEMA_TEXT_CHARS);
}

interface IndexedTool<T> {
  tool: T;
  counts: Map<string, number>;
  serverTerms: ReadonlySet<string>;
  length: number;
  namespace?: string;
}

type DocumentFrequency = Map<string, number>;

export class ToolSearchIndex<T extends SearchableTool> {
  private readonly documents: Array<IndexedTool<T>>;
  private readonly averageLength: number;
  private readonly frequency: DocumentFrequency = new Map();
  private readonly frequencyByNamespace = new Map<string, DocumentFrequency>();

  constructor(
    tools: readonly T[],
    namespaces: readonly SearchableNamespace[] = [],
  ) {
    const sharedTerms = new Map<string, Set<string>>();
    for (const server of namespaces) {
      const text = [server.name, server.description, server.instructions?.slice(0, INSTRUCTION_CHARS)];
      sharedTerms.set(server.name, new Set(tokenize(text.join(' '))));
    }
    this.documents = tools.map((tool) => {
      const parsed = parseMcpToolName(tool.name);
      const serverName = tool.namespace ?? parsed.serverName;
      const serverKey = serverName ?? '';
      let serverTerms = sharedTerms.get(serverKey);
      if (!serverTerms) {
        serverTerms = new Set(tokenize(serverKey));
        sharedTerms.set(serverKey, serverTerms);
      }
      const counts = new Map<string, number>();
      let length = 0;
      const indexField = (text: string, weight: number) => {
        const terms = tokenize(text);
        length += terms.length;
        for (const term of terms)
          counts.set(term, (counts.get(term) ?? 0) + weight);
      };
      // Weighted term frequency: the tool's action and purpose distinguish
      // siblings that share parameters and every word in the server description.
      indexField(parsed.toolName ?? tool.name, 5);
      indexField(tool.definition?.description ?? tool.description ?? '', 2);
      indexField(schemaSearchText(tool.definition?.inputSchema), 1);
      return { tool, counts, serverTerms, length, namespace: serverName };
    });
    this.averageLength =
      this.documents.reduce((sum, item) => sum + item.length, 0) /
        (this.documents.length || 1) || 1;
    const bump = (map: DocumentFrequency, term: string) =>
      map.set(term, (map.get(term) ?? 0) + 1);
    for (const item of this.documents) {
      let scoped: DocumentFrequency | undefined;
      if (item.namespace !== undefined) {
        scoped = this.frequencyByNamespace.get(item.namespace);
        if (!scoped)
          this.frequencyByNamespace.set(item.namespace, (scoped = new Map()));
      }
      for (const term of new Set([...item.counts.keys(), ...item.serverTerms])) {
        bump(this.frequency, term);
        if (scoped) bump(scoped, term);
      }
    }
  }

  /** Exact callable name first, then relevance; ties preserve catalog order. */
  search(query: string, options: ToolSearchOptions = {}): T[] {
    const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
    const wanted =
      options.namespace === undefined
        ? undefined
        : resolveNamespaceName(this.frequencyByNamespace, options.namespace);
    if (options.namespace !== undefined && wanted === undefined) return [];
    const documents =
      wanted === undefined
        ? this.documents
        : this.documents.filter((item) => item.namespace === wanted);
    const exactName = query.trim();
    const terms = [...new Set(tokenize(exactName))];
    if (!terms.length) {
      const exact = exactName && documents.find(({ tool }) => tool.name === exactName);
      if (exact) return [exact.tool].slice(0, limit);
      return options.browseOnEmptyTerms === false
        ? []
        : documents.slice(0, limit).map(({ tool }) => tool);
    }
    const frequencies =
      wanted === undefined
        ? this.frequency
        : this.frequencyByNamespace.get(wanted)!;
    const idf = new Map(
      terms.map((term) => {
        const frequency = frequencies.get(term) ?? 0;
        return [
          term,
          Math.log(
            1 + (documents.length - frequency + 0.5) / (frequency + 0.5),
          ),
        ];
      }),
    );
    const matches: Array<{ tool: T; score: number; order: number }> = [];
    documents.forEach((item, order) => {
      if (item.tool.name === exactName) {
        matches.push({ tool: item.tool, score: Infinity, order });
        return;
      }
      let score = 0;
      const norm = K1 * (1 - B + (B * item.length) / this.averageLength);
      for (const term of terms) {
        const count = item.counts.get(term);
        if (count)
          score += idf.get(term)! * ((count * (K1 + 1)) / (count + norm));
        else if (item.serverTerms.has(term))
          score += idf.get(term)! * 0.15;
      }
      if (score > 0) matches.push({ tool: item.tool, score, order });
    });
    return matches
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, limit)
      .map((match) => match.tool);
  }
}
