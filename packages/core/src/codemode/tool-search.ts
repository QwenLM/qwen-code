/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Tool discovery shared by CodeMode searchTools and mcp_list: Okapi BM25 over tool and server text. */

import { isRecord } from '../utils/markdownUtils.js';
import { MCP_TOOL_PREFIX } from '../mcp/tools/mcp-names.js';

export interface SearchableTool {
  name: string;
  /** Indexed text; defaults to the name and description. */
  searchText?: string;
  description?: string;
  /** Owning MCP server. */
  namespace?: string;
}

export interface SearchableNamespace {
  name: string;
  description?: string;
  instructions?: string;
}

export interface ToolSearchOptions {
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
  return (name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name)
    .toLowerCase()
    .replace(/-/g, '_');
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

/** Name, name with spaces, description and input properties. */
export function toolSearchText(
  name: string,
  description: string | undefined,
  inputSchema?: unknown,
): string {
  return [
    name,
    name.replace(/_/g, ' '),
    description ?? '',
    schemaSearchText(inputSchema),
  ].join(' ');
}

interface IndexedTool<T> {
  tool: T;
  counts: Map<string, number>;
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
    const servers = new Map(
      namespaces.map((entry) => [namespaceKey(entry.name), entry]),
    );
    // A server's text is shared by all of its tools, so tokenize it once.
    const serverTerms = new Map<string, string[]>();
    this.documents = tools.map((tool) => {
      const terms = tokenize(
        tool.searchText ?? toolSearchText(tool.name, tool.description),
      );
      const key =
        tool.namespace === undefined ? undefined : namespaceKey(tool.namespace);
      const server = key === undefined ? undefined : servers.get(key);
      if (key !== undefined && server) {
        let shared = serverTerms.get(key);
        if (!shared) {
          shared = tokenize(
            [
              server.name,
              server.description ?? '',
              (server.instructions ?? '').slice(0, INSTRUCTION_CHARS),
            ].join(' '),
          );
          serverTerms.set(key, shared);
        }
        terms.push(...shared);
      }
      const counts = new Map<string, number>();
      for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
      return { tool, counts, length: terms.length, namespace: key };
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
      for (const term of item.counts.keys()) {
        bump(this.frequency, term);
        if (scoped) bump(scoped, term);
      }
    }
  }

  /** Ranked matches; ties keep input order. An empty query returns the first tools. */
  search(query: string, options: ToolSearchOptions = {}): T[] {
    const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
    const wanted =
      options.namespace === undefined
        ? undefined
        : namespaceKey(options.namespace);
    const documents =
      wanted === undefined
        ? this.documents
        : this.documents.filter((item) => item.namespace === wanted);
    const terms = [...new Set(tokenize(query))];
    if (!terms.length) return documents.slice(0, limit).map((item) => item.tool);
    const frequencies =
      wanted === undefined
        ? this.frequency
        : (this.frequencyByNamespace.get(wanted) ?? new Map<string, number>());
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
      let score = 0;
      const norm = K1 * (1 - B + (B * item.length) / this.averageLength);
      for (const term of terms) {
        const count = item.counts.get(term);
        if (count)
          score += idf.get(term)! * ((count * (K1 + 1)) / (count + norm));
      }
      if (score > 0) matches.push({ tool: item.tool, score, order });
    });
    return matches
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, limit)
      .map((match) => match.tool);
  }
}
