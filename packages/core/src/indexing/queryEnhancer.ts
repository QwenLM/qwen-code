/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BaseLlmClient } from '../core/baseLlmClient.js';

/**
 * Advanced Query Enhancement Service for Code Search.
 *
 * This module implements LLM-based query rewriting strategies for hybrid
 * retrieval systems (BM25 + Vector Search). The design is inspired by
 * FlashRAG (WWW 2025) and other state-of-the-art RAG frameworks.
 *
 * Key Strategies (inspired by FlashRAG pipelines):
 * 1. **Keyword Extraction**: Extract code-relevant keywords for BM25 search
 * 2. **HyDE (Hypothetical Document Embeddings)**: Generate hypothetical code
 *    snippets for better vector matching (arxiv:2212.10496)
 * 3. **Multi-Query Generation**: Create diverse query variations for
 *    comprehensive retrieval (RAG-Fusion pattern)
 * 4. **Query Decomposition (Self-Ask inspired)**: Break complex queries into
 *    focused sub-queries with iterative refinement
 * 5. **Step-Back Prompting**: Generate more abstract/general queries
 * 6. **Query Classification**: Determine query intent and complexity
 *
 * Design Principles (aligned with FlashRAG):
 * - No hardcoded synonym/framework term mappings (LLM handles semantics)
 * - Separate optimization paths for BM25 vs Vector retrieval
 * - Conditional enhancement based on query complexity
 * - Graceful degradation when LLM is unavailable
 *
 * References:
 * - FlashRAG: https://arxiv.org/abs/2405.13576 (WWW 2025)
 * - HyDE: https://arxiv.org/abs/2212.10496
 * - Self-Ask: https://arxiv.org/abs/2210.03350
 * - RQ-RAG: https://arxiv.org/abs/2404.00610
 * - Step-Back Prompting: https://arxiv.org/abs/2310.06117
 * - RAG-Fusion: Reciprocal Rank Fusion for combining results
 */

/**
 * Configuration for query enhancement.
 */
export interface QueryEnhancerConfig {
  /**
   * Enable HyDE (Hypothetical Document Embeddings) for vector search.
   * Generates a hypothetical code snippet that would answer the query,
   * then uses that for embedding-based retrieval.
   * Default: true (recommended for code search)
   */
  enableHyDE: boolean;

  /**
   * Enable multi-query generation for diverse retrieval.
   * Generates multiple query variations to capture different aspects.
   * Default: true
   */
  enableMultiQuery: boolean;

  /**
   * Number of keyword query variations for BM25.
   * Default: 3
   */
  bm25QueryCount: number;

  /**
   * Number of semantic query variations for vector search.
   * Default: 2
   */
  vectorQueryCount: number;

  /**
   * Enable query decomposition for complex queries.
   * Breaks down multi-concept queries into focused sub-queries.
   * Inspired by Self-Ask (arxiv:2210.03350) pipeline from FlashRAG.
   * Default: true
   */
  enableDecomposition: boolean;

  /**
   * Minimum word count to trigger decomposition.
   * Default: 8
   */
  decompositionThreshold: number;

  /**
   * Enable step-back prompting for abstract query generation.
   * Generates more general/abstract queries that capture high-level intent.
   * Inspired by Step-Back Prompting (arxiv:2310.06117).
   * Default: true
   */
  enableStepBack: boolean;

  /**
   * Enable query intent classification.
   * Classifies query type (definitional, how-to, debugging, etc.)
   * to apply specialized enhancement strategies.
   * Inspired by FlashRAG's Conditional Pipeline pattern.
   * Default: true
   */
  enableIntentClassification: boolean;

  /**
   * Model to use for LLM-based query enhancement.
   */
  model?: string;

  /**
   * Request timeout in milliseconds.
   * Default: 30000 (30 seconds)
   */
  timeout: number;

  /**
   * Enable multilingual query enhancement.
   * When enabled, generates queries in both original language and English
   * to improve cross-lingual code search.
   * Default: true
   */
  enableMultilingual: boolean;

  /**
   * Always include English translation for non-English queries.
   * This is important for code search since code identifiers are
   * typically in English.
   * Default: true
   */
  includeEnglishTranslation: boolean;

  /**
   * Primary programming languages in the repository.
   * Used by HyDE to generate code in the correct language.
   * Example: ['typescript', 'javascript'] or ['python']
   * If not specified, LLM will infer from the query context.
   */
  primaryLanguages?: string[];
}

/**
 * Default configuration for QueryEnhancer.
 */
export const DEFAULT_QUERY_ENHANCER_CONFIG: QueryEnhancerConfig = {
  enableHyDE: true,
  enableMultiQuery: true,
  bm25QueryCount: 3,
  vectorQueryCount: 2,
  enableDecomposition: true,
  decompositionThreshold: 8,
  enableStepBack: true,
  enableIntentClassification: true,
  timeout: 30000,
  enableMultilingual: true,
  includeEnglishTranslation: true,
};

/**
 * Query intent classification for conditional enhancement.
 * Inspired by FlashRAG's Conditional Pipeline pattern.
 */
export type QueryIntent =
  | 'definitional' // "What is X?" - needs definitions and explanations
  | 'how-to' // "How to do X?" - needs implementation examples
  | 'debugging' // Error messages, stack traces - needs solutions
  | 'comparison' // "X vs Y" - needs comparative analysis
  | 'finding' // "Find X" - needs specific code locations
  | 'understanding' // "Why does X?" - needs conceptual explanation
  | 'refactoring' // "How to improve X?" - needs best practices
  | 'general'; // General code search

/**
 * Result of query enhancement for hybrid retrieval.
 */
export interface EnhancedQuery {
  /** Original query string. */
  original: string;

  /**
   * Queries optimized for BM25/full-text search.
   * Contains extracted keywords, code identifiers, and search terms.
   * Multiple queries for diverse keyword matching.
   * May include both original language and English keywords.
   */
  bm25Queries: string[];

  /**
   * Queries optimized for vector/semantic search.
   * May include HyDE-generated code snippets for better embedding matching.
   * Supports multilingual queries for cross-lingual retrieval.
   */
  vectorQueries: string[];

  /**
   * Sub-queries from decomposition (if complex query detected).
   * Each sub-query focuses on one specific aspect of the original query.
   * Inspired by Self-Ask pattern from FlashRAG.
   */
  subQueries?: string[];

  /**
   * Step-back query for high-level context retrieval.
   * A more abstract/general version of the query.
   * Inspired by Step-Back Prompting (arxiv:2310.06117).
   */
  stepBackQuery?: string;

  /**
   * Classified intent of the query.
   * Used for conditional enhancement strategies.
   */
  intent?: QueryIntent;

  /**
   * Whether the query is related to testing (unit tests, test files, etc.).
   * When true, test files should NOT be penalized in search results.
   * Detected during intent classification.
   */
  isTestRelated?: boolean;

  /**
   * Processing metadata for debugging and analysis.
   */
  metadata: {
    /** Whether LLM was used for enhancement. */
    llmUsed: boolean;
    /** Strategies applied during enhancement. */
    strategiesApplied: string[];
    /** Processing time in milliseconds. */
    processingTimeMs: number;
    /** Detected source language of the query. */
    detectedLanguage?: string;
    /** Whether multilingual enhancement was applied. */
    multilingualApplied?: boolean;
    /** Confidence score for intent classification (0-1). */
    intentConfidence?: number;
    /** Whether query was deemed complex (triggered decomposition). */
    isComplexQuery?: boolean;
  };
}

/**
 * Options for query enhancement.
 */
export interface EnhanceOptions {
  /**
   * Override primary languages for this query.
   * If not specified, uses config.primaryLanguages.
   */
  primaryLanguages?: string[];
}

/**
 * LLM-powered query enhancement service for hybrid code search.
 *
 * This service transforms natural language queries into optimized queries
 * for both BM25 (full-text) and vector (semantic) retrieval systems.
 * The design follows FlashRAG's modular pipeline architecture.
 *
 * Key features (inspired by FlashRAG):
 * - Separate optimization paths for BM25 and vector search
 * - HyDE for generating hypothetical code snippets
 * - Multi-query generation for comprehensive retrieval
 * - Query decomposition (Self-Ask pattern) for complex queries
 * - Step-back prompting for abstract query generation
 * - Intent classification for conditional enhancement
 * - **Multilingual support**: Handles queries in any language with
 *   automatic translation and cross-lingual keyword extraction
 *
 * Pipeline Modes (aligned with FlashRAG categories):
 * - Sequential: Standard enhancement flow
 * - Conditional: Intent-based enhancement selection
 * - Branching: Multiple query strategies in parallel
 * - Loop: Iterative decomposition for complex queries
 *
 * Multilingual Strategy:
 * - Detects query language automatically
 * - For non-English queries:
 *   - Generates keywords in both original language and English
 *   - Considers language-specific tokenization (CJK bigram, etc.)
 *   - Translates technical concepts to English for code matching
 * - Code identifiers (function names, etc.) are typically English,
 *   so English translation is crucial for effective retrieval
 *
 * All enhancements are LLM-powered to ensure semantic understanding.
 * When LLM is unavailable, provides graceful fallback with basic tokenization.
 */
export class QueryEnhancer {
  private readonly config: QueryEnhancerConfig;
  private llmClient?: BaseLlmClient;

  /**
   * Creates a new QueryEnhancer instance.
   * @param config Optional configuration overrides.
   * @param llmClient Optional LLM client for advanced features.
   */
  constructor(
    config: Partial<QueryEnhancerConfig> = {},
    llmClient?: BaseLlmClient,
  ) {
    this.config = { ...DEFAULT_QUERY_ENHANCER_CONFIG, ...config };
    this.llmClient = llmClient;
  }

  /**
   * Sets the LLM client for query enhancement.
   * @param client LLM client implementation.
   */
  setLlmClient(client: BaseLlmClient): void {
    this.llmClient = client;
  }

  /**
   * Detects if a query contains primarily non-ASCII characters,
   * indicating a non-English language (CJK, Arabic, Hebrew, etc.)
   *
   * This is a heuristic for quick language detection without LLM.
   */
  private containsNonLatinScript(query: string): boolean {
    // Remove code-like patterns (identifiers, punctuation) first
    const textOnly = query.replace(
      /[a-zA-Z0-9_\-./\\<>(){}[\];:'"`,!@#$%^&*+=|~`]/g,
      '',
    );
    if (textOnly.length === 0) return false;

    // Check for non-ASCII characters (CJK, Arabic, Hebrew, Cyrillic, etc.)
    // Match characters outside the basic Latin range (code points > 127)
    // eslint-disable-next-line no-control-regex
    const nonLatinChars = textOnly.match(/[^\u0000-\u007F\s]/g) || [];
    const totalChars = textOnly.replace(/\s/g, '').length;

    // If more than 30% non-Latin characters, consider it non-English
    return totalChars > 0 && nonLatinChars.length / totalChars > 0.3;
  }

  /**
   * Detects if a query contains CJK (Chinese, Japanese, Korean) characters.
   * CJK languages require special tokenization (bigram) for BM25.
   */
  private containsCJK(query: string): boolean {
    // CJK Unified Ideographs and common ranges
    const cjkPattern =
      /[\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/;
    return cjkPattern.test(query);
  }

  /**
   * Extracts code identifiers from a query.
   * These are typically already in English and should be preserved.
   */
  private extractCodeIdentifiers(query: string): string[] {
    const identifiers: string[] = [];

    // Match camelCase, PascalCase, snake_case patterns
    const patterns = [
      /[a-zA-Z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]*)*/g, // camelCase/PascalCase
      /[a-z]+(?:_[a-z]+)+/g, // snake_case
      /[A-Z]+(?:_[A-Z]+)+/g, // SCREAMING_SNAKE_CASE
      /\.[a-zA-Z]+/g, // file extensions
      /[a-zA-Z]+\(\)/g, // function calls
    ];

    for (const pattern of patterns) {
      const matches = query.match(pattern) || [];
      identifiers.push(...matches.map((m) => m.replace(/[()]/g, '')));
    }

    return [...new Set(identifiers.filter((id) => id.length > 1))];
  }

  /**
   * Main entry point: Enhances a query for hybrid retrieval.
   *
   * This method implements a unified LLM-based enhancement that generates
   * all query variations in a single request for optimal performance.
   *
   * Key optimizations:
   * - Single LLM request for all enhancements (reduced from 5-6 requests)
   * - Intent classification drives the generation of other outputs
   * - LLM uses Chain-of-Thought: first classify intent, then generate
   *   intent-aware BM25 keywords, HyDE code, decomposition, and step-back
   *
   * Enhancement outputs:
   * - BM25 queries: Keywords optimized for full-text search
   * - Vector queries: HyDE code + semantic variations for embedding search
   * - Sub-queries: Decomposed queries for complex questions
   * - Step-back query: Abstract/general version for context retrieval
   *
   * For multilingual queries:
   * - Detects query language automatically
   * - Generates both original language and English keywords
   * - Applies language-specific tokenization for CJK languages
   *
   * @param query Original search query (natural language or code).
   * @param options Optional enhancement options.
   * @returns Enhanced queries optimized for hybrid retrieval.
   */
  async enhance(
    query: string,
    options?: EnhanceOptions,
  ): Promise<EnhancedQuery> {
    const startTime = Date.now();
    const strategiesApplied: string[] = [];

    // Detect if query is non-English
    const isNonEnglish = this.containsNonLatinScript(query);
    const isCJK = this.containsCJK(query);
    const codeIdentifiers = this.extractCodeIdentifiers(query);
    const isComplex = this.shouldDecompose(query);

    // If no LLM client, return basic enhancement
    if (!this.llmClient) {
      return this.createFallbackResult(query, startTime, isNonEnglish, isCJK);
    }

    // Merge primary languages from options and config
    const primaryLanguages =
      options?.primaryLanguages ?? this.config.primaryLanguages;

    try {
      // Single unified LLM request for all enhancements
      // Intent classification is done first (Chain-of-Thought) and drives other generations
      const result = await this.enhanceQueryUnified({
        query,
        isNonEnglish,
        isCJK,
        codeIdentifiers,
        isComplex,
        primaryLanguages,
      });

      // Build strategies applied list
      if (result.intent) strategiesApplied.push('intent-classification');
      if (result.bm25Queries.length > 0)
        strategiesApplied.push('keyword-extraction');
      if (result.hydeCode) strategiesApplied.push('hyde');
      if (result.semanticVariations && result.semanticVariations.length > 0) {
        strategiesApplied.push('multi-query');
      }
      if (result.subQueries && result.subQueries.length > 0) {
        strategiesApplied.push('decomposition');
      }
      if (result.stepBackQuery) strategiesApplied.push('step-back');
      if (isNonEnglish) strategiesApplied.push('multilingual');

      // Build vector queries: HyDE code first, then original, then variations
      const vectorQueries: string[] = [];
      if (result.hydeCode) {
        vectorQueries.push(result.hydeCode);
      }
      vectorQueries.push(query);
      if (result.semanticVariations) {
        vectorQueries.push(...result.semanticVariations);
      }
      // Add step-back query for high-level context retrieval (vector search)
      if (result.stepBackQuery) {
        vectorQueries.push(result.stepBackQuery);
      }

      // Build BM25 queries: include code identifiers if present
      const bm25Queries = [...result.bm25Queries];
      if (codeIdentifiers.length > 0) {
        bm25Queries.push(codeIdentifiers.join(' '));
      }
      // Add sub-queries for focused keyword retrieval (BM25)
      // Sub-queries decompose complex questions into focused searches
      if (result.subQueries && result.subQueries.length > 0) {
        bm25Queries.push(...result.subQueries);
      }

      return {
        original: query,
        bm25Queries: [...new Set(bm25Queries)],
        vectorQueries: [...new Set(vectorQueries)],
        subQueries: result.subQueries,
        stepBackQuery: result.stepBackQuery,
        intent: result.intent,
        isTestRelated: result.isTestRelated,
        metadata: {
          llmUsed: true,
          strategiesApplied,
          processingTimeMs: Date.now() - startTime,
          detectedLanguage: isNonEnglish
            ? isCJK
              ? 'cjk'
              : 'non-english'
            : 'english',
          multilingualApplied: isNonEnglish,
          intentConfidence: result.intentConfidence,
          isComplexQuery: isComplex,
        },
      };
    } catch {
      // On error, fall back to basic enhancement
      return this.createFallbackResult(query, startTime, isNonEnglish, isCJK);
    }
  }

  /**
   * Unified query enhancement using a single LLM request with Chain-of-Thought.
   *
   * The LLM is instructed to:
   * 1. FIRST classify the query intent
   * 2. THEN generate all other outputs based on the classified intent
   *
   * This ensures Intent Classification actually influences the generation:
   * - definitional: Focus on documentation keywords, generate explanatory code
   * - how-to: Focus on implementation keywords, generate working examples
   * - debugging: Focus on error patterns, generate fix/solution code
   * - comparison: Focus on both terms, generate comparative examples
   * - finding: Focus on exact identifiers, generate precise code patterns
   * - understanding: Focus on conceptual terms, generate explanatory code
   * - refactoring: Focus on best practices, generate improved code
   *
   * Uses 2 LLM calls: 1 for intent classification, 1 for query enhancement.
   */
  private async enhanceQueryUnified(params: {
    query: string;
    isNonEnglish: boolean;
    isCJK: boolean;
    codeIdentifiers: string[];
    isComplex: boolean;
    primaryLanguages?: string[];
  }): Promise<{
    intent?: QueryIntent;
    intentConfidence?: number;
    isTestRelated?: boolean;
    bm25Queries: string[];
    hydeCode?: string;
    semanticVariations?: string[];
    subQueries?: string[];
    stepBackQuery?: string;
  }> {
    const { query, isNonEnglish, isCJK, isComplex, primaryLanguages } = params;

    // Step 1: Fast intent classification (separate call to avoid context pollution)
    const intentResult = this.config.enableIntentClassification
      ? await this.classifyIntent(query)
      : null;

    // Step 2: Generate all enhancements based on classified intent
    const result = await this.generateEnhancements({
      query,
      intent: intentResult?.intent,
      isNonEnglish,
      isCJK,
      isComplex,
      primaryLanguages,
    });

    return {
      intent: intentResult?.intent,
      intentConfidence: intentResult?.confidence,
      isTestRelated: intentResult?.isTestRelated,
      ...result,
    };
  }

  /**
   * Fast intent classification using a lightweight LLM call.
   * This is a separate call to avoid polluting the enhancement prompt with
   * excessive intent-related context.
   *
   * Also detects if the query is test-related to avoid penalizing test files.
   */
  private async classifyIntent(
    query: string,
  ): Promise<{
    intent: QueryIntent;
    confidence: number;
    isTestRelated: boolean;
  } | null> {
    if (!this.llmClient) return null;

    try {
      const response = await this.llmClient.generateJson({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `Classify the intent of this code search query:

"${query}"

Categories:
- definitional: "What is X?" - seeking definitions
- how-to: "How to do X?" - seeking implementation
- debugging: Error messages or fixing issues
- comparison: "X vs Y" - comparing approaches
- finding: "Find X" - locating specific code
- understanding: "Why does X?" - understanding behavior
- refactoring: "How to improve X?" - best practices
- general: General code search

Also determine if the query is test-related (looking for unit tests, test files, test examples, mocking, testing patterns, etc.)`,
              },
            ],
          },
        ],
        schema: {
          type: 'object',
          properties: {
            intent: {
              type: 'string',
              enum: [
                'definitional',
                'how-to',
                'debugging',
                'comparison',
                'finding',
                'understanding',
                'refactoring',
                'general',
              ],
            },
            confidence: {
              type: 'number',
              description:
                'Confidence score for the intent classification (0-1)',
            },
            isTestRelated: {
              type: 'boolean',
              description:
                'Whether the query is related to testing (unit tests, test files, mocking, test patterns, etc.)',
            },
          },
          required: ['intent', 'confidence', 'isTestRelated'],
        },
        model: this.config.model || 'qwen-coder-plus-latest',
        systemInstruction:
          'Classify the query intent and detect if it is test-related. Be concise.',
        abortSignal: AbortSignal.timeout(this.config.timeout / 3),
      });

      const intent = response['intent'] as QueryIntent | undefined;
      const confidence = response['confidence'] as number | undefined;
      const isTestRelated = response['isTestRelated'] as boolean | undefined;

      if (intent && typeof confidence === 'number') {
        return {
          intent,
          confidence: Math.min(1, Math.max(0, confidence)),
          isTestRelated: isTestRelated === true,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Generate all query enhancements based on the classified intent.
   * Intent is passed in and used to guide generation.
   */
  private async generateEnhancements(params: {
    query: string;
    intent?: QueryIntent;
    isNonEnglish: boolean;
    isCJK: boolean;
    isComplex: boolean;
    primaryLanguages?: string[];
  }): Promise<{
    bm25Queries: string[];
    hydeCode?: string;
    semanticVariations?: string[];
    subQueries?: string[];
    stepBackQuery?: string;
  }> {
    const { query, intent, isNonEnglish, isCJK, isComplex, primaryLanguages } =
      params;

    // Build multilingual-aware guidance
    const multilingualGuidance =
      isNonEnglish && this.config.enableMultilingual
        ? `
IMPORTANT - Multilingual Query Handling:
The query is in a non-English language${isCJK ? ' (CJK)' : ''}. You must:
1. Generate keywords in BOTH the original language AND English
2. Translate technical concepts to their English equivalents (code uses English)
3. ${isCJK ? 'For CJK languages: segment text appropriately, consider common phrases' : 'Preserve original language keywords for comments/docs search'}
4. Always include English code identifiers that map to the query concept
5. Consider that function names, class names, and variables are typically in English`
        : '';

    // Programming language guidance for HyDE
    const languageGuidance =
      primaryLanguages && primaryLanguages.length > 0
        ? `
IMPORTANT - Programming Language Requirement:
You MUST generate code in one of these programming languages: ${primaryLanguages.join(', ')}.
- Use ${primaryLanguages[0]} as the primary language unless another language is more appropriate for the query.
- Follow the idioms, conventions, and best practices of the specified language(s).
- Use language-specific patterns (e.g., async/await for TypeScript, decorators for Python, etc.).
- Do NOT generate code in any other language.`
        : '';

    // Intent-specific guidance (concise, only for the detected intent)
    const intentGuidance = this.getIntentGuidance(intent);

    const systemInstruction = `You are an expert code search query optimizer. Your task is to enhance search queries for hybrid retrieval (BM25 + vector search).

${intentGuidance}

For BM25/full-text search:
- Extract exact function/method/class names mentioned or implied
- Include technical terms that would appear in actual code (not natural language descriptions)
- Focus on identifiers: camelCase, snake_case, PascalCase patterns
- Include file patterns, module names, and import paths

For HyDE (Hypothetical Document Embeddings):
Generate a SHORT, REALISTIC code snippet that would exist in the codebase. Rules:
- NO comments, NO explanatory text, NO docstrings
- Just raw code: function signatures, class definitions, implementations
- 5-15 lines maximum, focusing on the core pattern
- Use realistic naming that matches typical codebase conventions
- The code should look like it was extracted from an actual file
${languageGuidance}
${multilingualGuidance}`;

    const complexGuidance = isComplex
      ? `
4. subQueries: 2-4 focused sub-queries for decomposed search (each 3-8 words, keyword style)
5. stepBackQuery: One abstract/general query capturing high-level concept (3-8 words)`
      : '';

    const userPrompt = `Query: "${query}"

Generate:

1. bm25Queries (${this.config.bm25QueryCount}): Space-separated keywords/identifiers. Example: "async fetchUser API handler", "getUserById AuthService database"
${isNonEnglish ? '   Include English technical terms.' : ''}

2. hydeCode: SHORT code snippet (5-15 lines) - NO comments, NO docstrings, just pure code.${primaryLanguages ? ` Use ${primaryLanguages[0]}.` : ''}

3. semanticVariations (${this.config.vectorQueryCount}): Alternative phrasings (5-12 words each).
${isNonEnglish ? '   Include one English version.' : ''}${complexGuidance}`;

    // Build the JSON schema
    const schemaProperties: Record<string, unknown> = {
      bm25Queries: {
        type: 'array',
        items: { type: 'string' },
        description: 'Keyword-focused queries for BM25 full-text search',
      },
      hydeCode: {
        type: 'string',
        description:
          'Short code snippet (5-15 lines) without comments or docstrings',
      },
      semanticVariations: {
        type: 'array',
        items: { type: 'string' },
        description: 'Alternative query phrasings (5-12 words each)',
      },
    };

    const requiredFields = ['bm25Queries', 'hydeCode', 'semanticVariations'];

    if (isComplex) {
      schemaProperties['subQueries'] = {
        type: 'array',
        items: { type: 'string' },
        description: 'Focused sub-queries (3-8 keywords each)',
      };
      schemaProperties['stepBackQuery'] = {
        type: 'string',
        description: 'Abstract/general query (3-8 words)',
      };
      requiredFields.push('subQueries', 'stepBackQuery');
    }

    const response = await this.llmClient!.generateJson({
      contents: [
        {
          role: 'user',
          parts: [{ text: userPrompt }],
        },
      ],
      schema: {
        type: 'object',
        properties: schemaProperties,
        required: requiredFields,
      },
      model: this.config.model || 'qwen-coder-plus-latest',
      systemInstruction,
      abortSignal: AbortSignal.timeout(this.config.timeout),
    });

    const bm25Queries = (response['bm25Queries'] as string[] | undefined) || [
      query,
    ];
    const hydeCode = response['hydeCode'] as string | undefined;
    const semanticVariations = response['semanticVariations'] as
      | string[]
      | undefined;
    const subQueries = isComplex
      ? (response['subQueries'] as string[] | undefined)
      : undefined;
    const stepBackQuery = isComplex
      ? (response['stepBackQuery'] as string | undefined)
      : undefined;

    return {
      bm25Queries: bm25Queries.slice(
        0,
        this.config.bm25QueryCount + (isNonEnglish ? 2 : 0),
      ),
      hydeCode: hydeCode?.trim(),
      semanticVariations: semanticVariations?.slice(
        0,
        this.config.vectorQueryCount,
      ),
      subQueries: subQueries?.slice(0, 4),
      stepBackQuery: stepBackQuery?.trim(),
    };
  }

  /**
   * Get intent-specific guidance for query enhancement.
   * Only includes guidance for the specific intent.
   */
  private getIntentGuidance(intent?: QueryIntent): string {
    if (!intent) return '';

    const guidanceMap: Record<QueryIntent, string> = {
      definitional: `Intent: DEFINITIONAL - Focus on type definitions, interfaces, class declarations`,
      'how-to': `Intent: HOW-TO - Focus on implementation patterns, function bodies, working examples`,
      debugging: `Intent: DEBUGGING - Focus on error handling, try-catch, validation code`,
      comparison: `Intent: COMPARISON - Include keywords for both alternatives being compared`,
      finding: `Intent: FINDING - Focus on exact identifiers, file paths, specific patterns`,
      understanding: `Intent: UNDERSTANDING - Focus on internal implementation details`,
      refactoring: `Intent: REFACTORING - Focus on clean code patterns, best practices`,
      general: '',
    };

    return guidanceMap[intent] || '';
  }

  /**
   * Determines if a query should be decomposed.
   *
   * Complexity detection is language-aware:
   * - For English/Latin: Uses word count (space-separated)
   * - For CJK languages: Uses character count (no spaces between words)
   * - Mixed queries: Considers both metrics
   *
   * Additional complexity signals:
   * - Multiple conjunctions (and, or, 和, 或, 以及)
   * - Multiple question words
   * - Long character sequences for CJK
   */
  private shouldDecompose(query: string): boolean {
    if (!this.config.enableDecomposition) return false;

    // Check for CJK content
    const isCJK = this.containsCJK(query);

    if (isCJK) {
      // For CJK languages, use character-based complexity detection
      return this.shouldDecomposeCJK(query);
    }

    // For Latin-based languages, use word count
    const wordCount = query.split(/\s+/).length;
    return wordCount >= this.config.decompositionThreshold;
  }

  /**
   * Determines if a CJK query should be decomposed.
   *
   * CJK languages don't use spaces between words, so we need different
   * heuristics to detect query complexity:
   * 1. Character count (CJK characters are information-dense)
   * 2. Presence of conjunctions indicating multiple concepts
   * 3. Multiple question patterns
   */
  private shouldDecomposeCJK(query: string): boolean {
    // Extract CJK character count
    const cjkChars = query.match(
      /[\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/g,
    );
    const cjkCharCount = cjkChars?.length || 0;

    // CJK characters are more information-dense than English words
    // Roughly 2-3 CJK characters = 1 English word
    // So threshold of 8 English words ≈ 16-24 CJK characters
    const cjkThreshold = Math.floor(this.config.decompositionThreshold * 2.5);

    if (cjkCharCount >= cjkThreshold) {
      return true;
    }

    // Check for conjunction patterns indicating multiple concepts
    // Chinese: 和, 与, 以及, 并且, 或者, 还有, 同时
    // Japanese: と, や, および, または
    // Korean: 와, 과, 그리고, 또는
    const conjunctionPatterns = [
      // Chinese conjunctions
      /[和与]|以及|并且|或者|还有|同时/,
      // Japanese conjunctions
      /[とや]|および|または/,
      // Korean conjunctions
      /[와과]|그리고|또는/,
    ];

    let conjunctionCount = 0;
    for (const pattern of conjunctionPatterns) {
      const matches = query.match(new RegExp(pattern, 'g'));
      conjunctionCount += matches?.length || 0;
    }

    // Multiple conjunctions suggest multiple concepts
    if (conjunctionCount >= 2) {
      return true;
    }

    // Check for multiple question patterns in the query
    // This suggests the user is asking about multiple things
    const questionPatterns = [
      // Chinese question patterns
      /如何|怎么|怎样|什么|为什么|哪个|哪些|是否|能否|可以/g,
      // Japanese question patterns
      /どう|どのように|なぜ|何|どれ/g,
      // Korean question patterns
      /어떻게|왜|무엇|어느/g,
    ];

    let questionPatternCount = 0;
    for (const pattern of questionPatterns) {
      const matches = query.match(pattern);
      questionPatternCount += matches?.length || 0;
    }

    // Multiple question patterns suggest complexity
    if (questionPatternCount >= 2) {
      return true;
    }

    // Also consider mixed CJK + English content
    // If there's significant English alongside CJK, count English words too
    const englishWords = query.match(/[a-zA-Z]{2,}/g);
    const englishWordCount = englishWords?.length || 0;

    // Combined complexity: CJK chars / 2.5 + English words
    const combinedComplexity = cjkCharCount / 2.5 + englishWordCount;
    return combinedComplexity >= this.config.decompositionThreshold;
  }

  /**
   * Creates a fallback result when LLM is unavailable.
   * Uses basic tokenization and the original query.
   * Includes basic multilingual handling for CJK languages.
   */
  private createFallbackResult(
    query: string,
    startTime: number,
    isNonEnglish: boolean = false,
    isCJK: boolean = false,
  ): EnhancedQuery {
    // Basic tokenization for BM25
    const tokens = this.extractBasicKeywords(query, isCJK);
    const codeIdentifiers = this.extractCodeIdentifiers(query);

    // Build BM25 queries
    const bm25Queries: string[] = [];
    if (tokens.length > 0) {
      bm25Queries.push(tokens.join(' '));
    }
    bm25Queries.push(query);
    if (codeIdentifiers.length > 0) {
      bm25Queries.push(codeIdentifiers.join(' '));
    }

    return {
      original: query,
      bm25Queries: [...new Set(bm25Queries)],
      vectorQueries: [query],
      metadata: {
        llmUsed: false,
        strategiesApplied: ['fallback-tokenization'],
        processingTimeMs: Date.now() - startTime,
        detectedLanguage: isNonEnglish
          ? isCJK
            ? 'cjk'
            : 'non-english'
          : 'english',
        multilingualApplied: false,
      },
    };
  }

  /**
   * Extracts basic keywords from a query using simple tokenization.
   * Used as fallback when LLM is unavailable.
   *
   * For CJK languages:
   * - Uses character-based tokenization (bigram approach)
   * - Extracts meaningful character sequences
   */
  private extractBasicKeywords(
    query: string,
    isCJK: boolean = false,
  ): string[] {
    // Remove common stop words (English)
    const stopWords = new Set([
      'a',
      'an',
      'the',
      'is',
      'are',
      'was',
      'were',
      'be',
      'been',
      'being',
      'have',
      'has',
      'had',
      'do',
      'does',
      'did',
      'will',
      'would',
      'could',
      'should',
      'may',
      'might',
      'must',
      'shall',
      'can',
      'need',
      'dare',
      'ought',
      'used',
      'to',
      'of',
      'in',
      'for',
      'on',
      'with',
      'at',
      'by',
      'from',
      'as',
      'into',
      'through',
      'during',
      'before',
      'after',
      'above',
      'below',
      'between',
      'under',
      'again',
      'further',
      'then',
      'once',
      'here',
      'there',
      'when',
      'where',
      'why',
      'how',
      'all',
      'each',
      'few',
      'more',
      'most',
      'other',
      'some',
      'such',
      'no',
      'nor',
      'not',
      'only',
      'own',
      'same',
      'so',
      'than',
      'too',
      'very',
      's',
      't',
      'just',
      'don',
      'now',
      'i',
      'me',
      'my',
      'myself',
      'we',
      'our',
      'ours',
      'ourselves',
      'you',
      'your',
      'yours',
      'yourself',
      'yourselves',
      'he',
      'him',
      'his',
      'himself',
      'she',
      'her',
      'hers',
      'herself',
      'it',
      'its',
      'itself',
      'they',
      'them',
      'their',
      'theirs',
      'themselves',
      'what',
      'which',
      'who',
      'whom',
      'this',
      'that',
      'these',
      'those',
      'am',
      'and',
      'but',
      'if',
      'or',
      'because',
      'as',
      'until',
      'while',
      'about',
      'against',
    ]);

    // Chinese common stop words
    const chineseStopWords = new Set([
      '的',
      '是',
      '在',
      '了',
      '和',
      '与',
      '或',
      '一个',
      '这个',
      '那个',
      '如何',
      '怎么',
      '什么',
      '为什么',
      '哪个',
      '哪些',
      '可以',
      '能够',
      '需要',
      '应该',
      '会',
      '要',
      '想',
      '让',
      '把',
      '被',
      '给',
      '从',
      '到',
      '上',
      '下',
      '中',
      '里',
      '外',
      '前',
      '后',
      '左',
      '右',
    ]);

    const expanded: string[] = [];

    // Handle CJK text with bigram tokenization
    if (isCJK) {
      // Extract CJK characters and create bigrams
      const cjkChars =
        query.match(
          /[\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]+/g,
        ) || [];

      for (const segment of cjkChars) {
        // Add the full segment
        if (segment.length >= 2 && !chineseStopWords.has(segment)) {
          expanded.push(segment);
        }

        // Create bigrams for longer segments (common CJK search technique)
        if (segment.length > 2) {
          for (let i = 0; i < segment.length - 1; i++) {
            const bigram = segment.slice(i, i + 2);
            if (!chineseStopWords.has(bigram)) {
              expanded.push(bigram);
            }
          }
        }
      }
    }

    // Tokenize English/Latin text
    const tokens = query
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 1 && !stopWords.has(token));

    // Also extract camelCase and snake_case parts
    for (const token of tokens) {
      // Skip if it's just CJK characters (already handled)
      if (
        /^[\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]+$/.test(
          token,
        )
      ) {
        continue;
      }

      expanded.push(token);

      // Split camelCase
      const camelParts = token.split(/(?=[A-Z])/).map((p) => p.toLowerCase());
      if (camelParts.length > 1) {
        expanded.push(...camelParts.filter((p) => p.length > 1));
      }
      // Split snake_case
      const snakeParts = token.split('_').filter((p) => p.length > 1);
      if (snakeParts.length > 1) {
        expanded.push(...snakeParts);
      }
    }

    return [...new Set(expanded)];
  }
}
