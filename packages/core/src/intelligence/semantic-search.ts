/**
 * Copyright (c) 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import type { CodebaseGraph, CodeNode } from './codebase-graph.js';

/**
 * Search result with relevance score
 */
export interface SearchResult {
  _node: CodeNode;
  score: number; // 0-1, higher is more relevant
  matches: SearchMatch[];
  context: string;
}

/**
 * Specific match within a result
 */
export interface SearchMatch {
  type: 'exact' | 'fuzzy' | 'semantic';
  location: {
    line: number;
    column: number;
    snippet: string;
  };
  confidence: number; // 0-1
}

/**
 * Search options
 */
export interface SearchOptions {
  mode: 'exact' | 'fuzzy' | 'semantic' | 'hybrid';
  caseSensitive?: boolean;
  wholeWord?: boolean;
  includeTests?: boolean;
  fileTypes?: string[];
  maxResults?: number;
  minScore?: number;
}

/**
 * Semantic index for fast searching
 */
interface SemanticIndex {
  terms: Map<string, Set<string>>; // term -> file paths
  embeddings: Map<string, number[]>; // file path -> embedding vector
  metadata: {
    indexedAt: Date;
    filesCount: number;
    termsCount: number;
  };
}

/**
 * Semantic search engine for codebase
 */
export class SemanticSearchEngine {
  private index: SemanticIndex;
  private graph?: CodebaseGraph;

  constructor() {
    this.index = {
      terms: new Map(),
      embeddings: new Map(),
      metadata: {
        indexedAt: new Date(),
        filesCount: 0,
        termsCount: 0,
      },
    };
  }

  /**
   * Build search index from codebase graph
   */
  async buildIndex(graph: CodebaseGraph): Promise<void> {
    this.graph = graph;

    for (const [filePath, node] of graph.nodes.entries()) {
      await this.indexFile(filePath, node);
    }

    this.index.metadata.indexedAt = new Date();
    this.index.metadata.filesCount = graph.nodes.size;
    this.index.metadata.termsCount = this.index.terms.size;
  }

  /**
   * Index a single file
   */
  private async indexFile(filePath: string, _node: CodeNode): Promise<void> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');

      // Extract terms
      const terms = this.extractTerms(content);

      // Index each term
      for (const term of terms) {
        if (!this.index.terms.has(term)) {
          this.index.terms.set(term, new Set());
        }
        this.index.terms.get(term)!.add(filePath);
      }

      // Create simple embedding (in real implementation, would use ML model)
      const embedding = this.createEmbedding(content);
      this.index.embeddings.set(filePath, embedding);
    } catch (_error) {
      // Skip files that can't be read
    }
  }

  /**
   * Extract searchable terms from content
   */
  private extractTerms(content: string): Set<string> {
    const terms = new Set<string>();

    // Extract words (alphanumeric sequences)
    const words = content.match(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g) || [];

    for (const word of words) {
      // Skip very short or very long words
      if (word.length < 3 || word.length > 50) continue;

      // Normalize
      terms.add(word.toLowerCase());
    }

    // Extract camelCase words
    const camelCaseWords = content.match(/[a-z][A-Z][a-zA-Z0-9]*/g) || [];
    for (const word of camelCaseWords) {
      // Split camelCase
      const parts = word.split(/(?=[A-Z])/);
      parts.forEach((part) => {
        if (part.length >= 3) {
          terms.add(part.toLowerCase());
        }
      });
    }

    return terms;
  }

  /**
   * Create simple embedding vector (simplified, would use ML in production)
   */
  private createEmbedding(content: string): number[] {
    // Simple TF-IDF-like embedding
    const terms = Array.from(this.extractTerms(content));
    const embedding = new Array(100).fill(0);

    // Hash terms to embedding dimensions
    for (const term of terms) {
      const hash = this.hashString(term);
      const index = hash % embedding.length;
      embedding[index]++;
    }

    // Normalize
    const magnitude = Math.sqrt(
      embedding.reduce((sum, val) => sum + val * val, 0),
    );
    return embedding.map((val) => (magnitude > 0 ? val / magnitude : 0));
  }

  /**
   * Simple string hash
   */
  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Search the codebase
   */
  async search(
    query: string,
    _options: SearchOptions = { mode: 'hybrid' },
  ): Promise<SearchResult[]> {
    if (!this.graph) {
      throw new Error('Index not built. Call buildIndex() first.');
    }

    const results: SearchResult[] = [];

    switch (options.mode) {
      case 'exact': {
        results.push(...(await this.exactSearch(query, options)));
        break;
      }
      case 'fuzzy': {
        results.push(...(await this.fuzzySearch(query, options)));
        break;
      }
      case 'semantic': {
        results.push(...(await this.semanticSearch(query, options)));
        break;
      }
      case 'hybrid': {
        // Combine all methods
        const exact = await this.exactSearch(query, options);
        const fuzzy = await this.fuzzySearch(query, options);
        const semantic = await this.semanticSearch(query, options);

        // Merge and deduplicate
        const combined = new Map<string, SearchResult>();

        for (const result of [...exact, ...fuzzy, ...semantic]) {
          const key = result.node.path;
          if (!combined.has(key)) {
            combined.set(key, result);
          } else {
            // Boost score for multiple matches
            const existing = combined.get(key)!;
            existing.score = Math.min(1, existing.score + result.score * 0.3);
          }
        }

        results.push(...combined.values());
        break;
      }
      default: {
        results.push(...(await this.exactSearch(query, options)));
        break;
      }
    }

    // Apply filters
    let filtered = results;

    if (!options.includeTests) {
      filtered = filtered.filter(
        (r) =>
          !r.node.path.includes('.test.') && !r.node.path.includes('.spec.'),
      );
    }

    if (options.fileTypes) {
      filtered = filtered.filter((r) =>
        options.fileTypes!.some((ext) => r.node.path.endsWith(ext)),
      );
    }

    if (options.minScore) {
      filtered = filtered.filter((r) => r.score >= options.minScore!);
    }

    // Sort by score
    filtered.sort((a, b) => b.score - a.score);

    // Limit results
    if (options.maxResults) {
      filtered = filtered.slice(0, options.maxResults);
    }

    return filtered;
  }

  /**
   * Exact string search
   */
  private async exactSearch(
    query: string,
    _options: SearchOptions,
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const searchTerm = options.caseSensitive ? query : query.toLowerCase();

    for (const [filePath, node] of this.graph!.nodes.entries()) {
      try {
        const content = await fs.readFile(filePath, 'utf-8');

        const matches: SearchMatch[] = [];
        const lines = content.split('\n');

        lines.forEach((line, lineNum) => {
          const searchLine = options.caseSensitive ? line : line.toLowerCase();

          if (options.wholeWord) {
            const regex = new RegExp(`\\b${searchTerm}\\b`, 'g');
            const lineMatches = searchLine.match(regex);
            if (lineMatches) {
              matches.push({
                type: 'exact',
                location: {
                  line: lineNum + 1,
                  column: searchLine.indexOf(searchTerm),
                  snippet: line.trim(),
                },
                confidence: 1.0,
              });
            }
          } else {
            if (searchLine.includes(searchTerm)) {
              matches.push({
                type: 'exact',
                location: {
                  line: lineNum + 1,
                  column: searchLine.indexOf(searchTerm),
                  snippet: line.trim(),
                },
                confidence: 1.0,
              });
            }
          }
        });

        if (matches.length > 0) {
          results.push({
            node,
            score: 1.0,
            matches,
            context: this.extractContext(content, matches[0].location.line),
          });
        }
      } catch (_error) {
        // Skip files that can't be read
      }
    }

    return results;
  }

  /**
   * Fuzzy search
   */
  private async fuzzySearch(
    query: string,
    _options: SearchOptions,
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const queryTerms = this.extractTerms(query);

    // Find files containing any query terms
    const candidateFiles = new Set<string>();

    for (const term of queryTerms) {
      const matchingFiles = this.index.terms.get(term);
      if (matchingFiles) {
        matchingFiles.forEach((file) => candidateFiles.add(file));
      }

      // Also check for partial matches
      for (const [indexTerm, files] of this.index.terms.entries()) {
        if (this.fuzzyMatch(term, indexTerm)) {
          files.forEach((file) => candidateFiles.add(file));
        }
      }
    }

    // Score each candidate
    for (const filePath of candidateFiles) {
      const node = this.graph!.nodes.get(filePath);
      if (!node) continue;

      const score = await this.calculateFuzzyScore(filePath, queryTerms);

      if (score > 0.3) {
        results.push({
          node,
          score,
          matches: [
            {
              type: 'fuzzy',
              location: { line: 1, column: 0, snippet: '' },
              confidence: score,
            },
          ],
          context: `File contains fuzzy matches for: ${query}`,
        });
      }
    }

    return results;
  }

  /**
   * Fuzzy string matching
   */
  private fuzzyMatch(term1: string, term2: string): boolean {
    // Simple edit distance
    const maxDistance = Math.max(2, Math.floor(term1.length * 0.2));
    const distance = this.levenshteinDistance(term1, term2);
    return distance <= maxDistance;
  }

  /**
   * Levenshtein distance
   */
  private levenshteinDistance(str1: string, str2: string): number {
    const m = str1.length;
    const n = str2.length;
    const dp: number[][] = Array(m + 1)
      .fill(0)
      .map(() => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (str1[i - 1] === str2[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1];
        } else {
          dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
      }
    }

    return dp[m][n];
  }

  /**
   * Calculate fuzzy score
   */
  private async calculateFuzzyScore(
    filePath: string,
    queryTerms: Set<string>,
  ): Promise<number> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const fileTerms = this.extractTerms(content);

      let matchCount = 0;
      for (const queryTerm of queryTerms) {
        for (const fileTerm of fileTerms) {
          if (this.fuzzyMatch(queryTerm, fileTerm)) {
            matchCount++;
            break;
          }
        }
      }

      return matchCount / queryTerms.size;
    } catch (_error) {
      return 0;
    }
  }

  /**
   * Semantic search using embeddings
   */
  private async semanticSearch(
    query: string,
    _options: SearchOptions,
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    // Create query embedding
    const queryEmbedding = this.createEmbedding(query);

    // Calculate similarity with all files
    const similarities: Array<{ path: string; score: number }> = [];

    for (const [filePath, fileEmbedding] of this.index.embeddings.entries()) {
      const similarity = this.cosineSimilarity(queryEmbedding, fileEmbedding);
      if (similarity > 0.3) {
        similarities.push({ path: filePath, score: similarity });
      }
    }

    // Sort by similarity
    similarities.sort((a, b) => b.score - a.score);

    // Create results
    for (const { path, score } of similarities.slice(0, 20)) {
      const node = this.graph!.nodes.get(path);
      if (!node) continue;

      results.push({
        node,
        score,
        matches: [
          {
            type: 'semantic',
            location: { line: 1, column: 0, snippet: '' },
            confidence: score,
          },
        ],
        context: `Semantically similar to: ${query}`,
      });
    }

    return results;
  }

  /**
   * Cosine similarity between vectors
   */
  private cosineSimilarity(vec1: number[], vec2: number[]): number {
    let dotProduct = 0;
    let mag1 = 0;
    let mag2 = 0;

    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i] * vec2[i];
      mag1 += vec1[i] * vec1[i];
      mag2 += vec2[i] * vec2[i];
    }

    mag1 = Math.sqrt(mag1);
    mag2 = Math.sqrt(mag2);

    if (mag1 === 0 || mag2 === 0) return 0;

    return dotProduct / (mag1 * mag2);
  }

  /**
   * Extract context around a line
   */
  private extractContext(
    content: string,
    line: number,
    contextLines = 2,
  ): string {
    const lines = content.split('\n');
    const start = Math.max(0, line - contextLines - 1);
    const end = Math.min(lines.length, line + contextLines);

    return lines.slice(start, end).join('\n');
  }

  /**
   * Find similar functions
   */
  async findSimilarFunctions(functionName: string): Promise<SearchResult[]> {
    return this.search(functionName, {
      mode: 'semantic',
      maxResults: 10,
      minScore: 0.5,
    });
  }

  /**
   * Find usage of a symbol
   */
  async findUsages(symbol: string): Promise<SearchResult[]> {
    return this.search(symbol, {
      mode: 'exact',
      wholeWord: true,
      includeTests: true,
    });
  }

  /**
   * Find files by content
   */
  async findByContent(
    query: string,
    options?: Partial<SearchOptions>,
  ): Promise<SearchResult[]> {
    return this.search(query, {
      mode: 'hybrid',
      maxResults: 50,
      ...options,
    });
  }

  /**
   * Get search statistics
   */
  getStats(): {
    filesIndexed: number;
    termsIndexed: number;
    lastIndexed: Date;
  } {
    return {
      filesIndexed: this.index.metadata.filesCount,
      termsIndexed: this.index.metadata.termsCount,
      lastIndexed: this.index.metadata.indexedAt,
    };
  }
}

/**
 * Create a new semantic search engine
 */
export function createSemanticSearchEngine(): SemanticSearchEngine {
  return new SemanticSearchEngine();
}
