// /**
//  * @license
//  * Copyright 2025 Qwen Team
//  * SPDX-License-Identifier: Apache-2.0
//  */

// import { describe, it, expect, beforeEach, vi } from 'vitest';
// import { RetrievalService } from './retrievalService.js';
// import { QueryEnhancer } from './queryEnhancer.js';
// import { ContextBuilder } from './contextBuilder.js';
// import type {
//   Chunk,
//   FileMetadata,
//   IGraphStore,
//   IMetadataStore,
//   IVectorStore,
//   ScoredChunk,
// } from './types.js';
// import type { ILlmClient } from './embeddingService.js';

// /**
//  * Creates a mock IMetadataStore.
//  */
// function createMockMetadataStore(): IMetadataStore {
//   const files: FileMetadata[] = [
//     { path: 'src/auth.ts', contentHash: 'hash1', lastModified: Date.now() - 1000, size: 1000, language: 'typescript' },
//     { path: 'src/user.ts', contentHash: 'hash2', lastModified: Date.now() - 2000, size: 800, language: 'typescript' },
//     { path: 'src/utils.ts', contentHash: 'hash3', lastModified: Date.now() - 3000, size: 500, language: 'typescript' },
//   ];

//   const chunks: Map<string, Chunk[]> = new Map([
//     ['src/auth.ts', [
//       {
//         id: 'chunk-auth-1',
//         filepath: 'src/auth.ts',
//         content: 'function authenticate(user: User): boolean { return validateCredentials(user); }',
//         startLine: 10,
//         endLine: 15,
//         index: 0,
//         contentHash: 'chash1',
//         type: 'function',
//         metadata: { language: 'typescript', functionName: 'authenticate' },
//       },
//     ]],
//     ['src/user.ts', [
//       {
//         id: 'chunk-user-1',
//         filepath: 'src/user.ts',
//         content: 'class User { constructor(public name: string) {} }',
//         startLine: 1,
//         endLine: 5,
//         index: 0,
//         contentHash: 'chash2',
//         type: 'class',
//         metadata: { language: 'typescript', className: 'User' },
//       },
//     ]],
//   ]);

//   return {
//     insertFileMeta: vi.fn(),
//     getFileMeta: vi.fn().mockImplementation((path: string) => files.find(f => f.path === path) ?? null),
//     getAllFileMeta: vi.fn().mockReturnValue(files),
//     deleteFileMeta: vi.fn(),
//     insertChunks: vi.fn(),
//     getChunksByFilePath: vi.fn().mockImplementation((path: string) => chunks.get(path) ?? []),
//     deleteChunksByFilePath: vi.fn(),
//     searchFTS: vi.fn().mockImplementation((query: string, _limit: number): ScoredChunk[] => {
//       // Simple mock: return auth chunk if query contains 'auth'
//       if (query.toLowerCase().includes('auth') || query.toLowerCase().includes('authenticate')) {
//         return [{
//           id: 'chunk-auth-1',
//           filePath: 'src/auth.ts',
//           content: 'function authenticate(user: User): boolean { return validateCredentials(user); }',
//           startLine: 10,
//           endLine: 15,
//           score: 0.9,
//           rank: 1,
//           source: 'bm25',
//         }];
//       }
//       return [];
//     }),
//     getRecentChunks: vi.fn().mockImplementation((limit: number): ScoredChunk[] => {
//       // Return first chunk from each file, sorted by lastModified desc
//       const recentFiles = files
//         .slice()
//         .sort((a, b) => b.lastModified - a.lastModified)
//         .slice(0, limit);
//       const results: ScoredChunk[] = [];
//       for (let idx = 0; idx < recentFiles.length; idx++) {
//         const f = recentFiles[idx];
//         if (!f) continue;
//         const fileChunks = chunks.get(f.path) ?? [];
//         const chunk = fileChunks[0];
//         if (!chunk) continue;
//         results.push({
//           id: chunk.id,
//           filePath: chunk.filepath,
//           content: chunk.content,
//           startLine: chunk.startLine,
//           endLine: chunk.endLine,
//           score: Math.max(0, 1.0 - idx * 0.05),
//           rank: idx + 1,
//           source: 'recent' as const,
//         });
//       }
//       return results;
//     }),
//     getEmbeddingCache: vi.fn().mockReturnValue(null),
//     setEmbeddingCache: vi.fn(),
//     getIndexStatus: vi.fn().mockReturnValue({ status: 'done', phase: 4, phaseProgress: 100, overallProgress: 100 }),
//     updateIndexStatus: vi.fn(),
//     getCheckpoint: vi.fn().mockReturnValue(null),
//     saveCheckpoint: vi.fn(),
//     clearCheckpoint: vi.fn(),
//     close: vi.fn(),
//   } as unknown as IMetadataStore;
// }

// /**
//  * Creates a mock IVectorStore.
//  */
// function createMockVectorStore(): IVectorStore {
//   return {
//     initialize: vi.fn().mockResolvedValue(undefined),
//     insertBatch: vi.fn().mockResolvedValue(undefined),
//     query: vi.fn().mockResolvedValue([{
//       chunkId: 'chunk-auth-1',
//       filePath: 'src/auth.ts',
//       content: 'function authenticate(user: User): boolean { return validateCredentials(user); }',
//       score: 0.85,
//       rank: 1,
//     }]),
//     deleteByFilePath: vi.fn().mockResolvedValue(undefined),
//     deleteByChunkIds: vi.fn().mockResolvedValue(undefined),
//     optimize: vi.fn(),
//     destroy: vi.fn(),
//   };
// }

// /**
//  * Creates a mock IGraphStore.
//  */
// function createMockGraphStore(): IGraphStore {
//   return {
//     initialize: vi.fn().mockResolvedValue(undefined),
//     insertEntities: vi.fn().mockResolvedValue(undefined),
//     insertRelations: vi.fn().mockResolvedValue(undefined),
//     getEntitiesByChunkIds: vi.fn().mockResolvedValue(['src/auth.ts#authenticate']),
//     query: vi.fn().mockResolvedValue([]),
//     deleteByFilePath: vi.fn().mockResolvedValue(undefined),
//     getStats: vi.fn().mockResolvedValue({ nodeCount: 0, edgeCount: 0 }),
//     close: vi.fn().mockResolvedValue(undefined),
//   };
// }

// /**
//  * Creates a mock ILlmClient.
//  */
// function createMockLlmClient(): ILlmClient {
//   return {
//     generateEmbedding: vi.fn().mockResolvedValue([
//       new Array(1024).fill(0).map(() => Math.random()),
//     ]),
//   };
// }

// function createMockEmbeddingLlmClient(): ILlmClient {
//   return {
//     generateEmbedding: vi.fn().mockResolvedValue([
//       new Array(1024).fill(0).map(() => Math.random()),
//     ]),
//   };
// }

// describe('RetrievalService', () => {
//   let metadataStore: IMetadataStore;
//   let vectorStore: IVectorStore;
//   let graphStore: IGraphStore;
//   let llmClient: ILlmClient;
//   let embeddingLlmClient: ILlmClient;
//   let service: RetrievalService;

//   beforeEach(() => {
//     metadataStore = createMockMetadataStore();
//     vectorStore = createMockVectorStore();
//     graphStore = createMockGraphStore();
//     llmClient = createMockLlmClient();
//     embeddingLlmClient = createMockEmbeddingLlmClient();
//     service = new RetrievalService(
//       metadataStore,
//       vectorStore,
//       graphStore,
//       llmClient,
//       embeddingLlmClient,
//     );
//   });

//   describe('constructor', () => {
//     it('should create service with default config', () => {
//       expect(service).toBeDefined();
//     });

//     it('should accept custom config', () => {
//       const customService = new RetrievalService(
//         metadataStore,
//         vectorStore,
//         graphStore,
//         llmClient,
//         { topK: 30 },
//       );
//       expect(customService).toBeDefined();
//     });
//   });

//   describe('bm25Search', () => {
//     it('should perform BM25 search', async () => {
//       const results = await service.bm25Search('authenticate', 10);
//       expect(results.length).toBeGreaterThan(0);
//       expect(results[0]?.source).toBe('bm25');
//     });

//     it('should return empty for empty query', async () => {
//       const results = await service.bm25Search('', 10);
//       expect(results).toHaveLength(0);
//     });
//   });

//   describe('vectorSearch', () => {
//     it('should perform vector search', async () => {
//       const results = await service.vectorSearch('authentication logic', 10);
//       expect(results.length).toBeGreaterThan(0);
//       expect(results[0]?.source).toBe('vector');
//     });

//     it('should call LLM client for embeddings', async () => {
//       await service.vectorSearch('test query', 10);
//       expect(llmClient.generateEmbedding).toHaveBeenCalled();
//     });

//     it('should return empty for empty query', async () => {
//       const results = await service.vectorSearch('', 10);
//       expect(results).toHaveLength(0);
//     });
//   });

//   describe('recentFilesSearch', () => {
//     it('should return recent files', async () => {
//       const results = await service.recentFilesSearch(10);
//       expect(results.length).toBeGreaterThan(0);
//       expect(results[0]?.source).toBe('recent');
//     });
//   });

//   describe('rrfFusion', () => {
//     it('should fuse results from multiple sources', () => {
//       const bm25Results: ScoredChunk[] = [
//         { id: 'chunk-1', filePath: 'a.ts', content: 'code1', startLine: 1, endLine: 5, score: 0.9, rank: 1, source: 'bm25' },
//         { id: 'chunk-2', filePath: 'b.ts', content: 'code2', startLine: 1, endLine: 5, score: 0.8, rank: 2, source: 'bm25' },
//       ];

//       const vectorResults: ScoredChunk[] = [
//         { id: 'chunk-2', filePath: 'b.ts', content: 'code2', startLine: 1, endLine: 5, score: 0.85, rank: 1, source: 'vector' },
//         { id: 'chunk-3', filePath: 'c.ts', content: 'code3', startLine: 1, endLine: 5, score: 0.7, rank: 2, source: 'vector' },
//       ];

//       const fused = service.rrfFusion([
//         { results: bm25Results, weight: 1.0, source: 'bm25' },
//         { results: vectorResults, weight: 1.0, source: 'vector' },
//       ], 60);

//       expect(fused.length).toBe(3); // chunk-1, chunk-2, chunk-3

//       // chunk-2 should have higher score as it appears in both
//       const chunk2 = fused.find(c => c.id === 'chunk-2');
//       expect(chunk2?.sources).toContain('bm25');
//       expect(chunk2?.sources).toContain('vector');
//     });

//     it('should apply weights correctly', () => {
//       const results1: ScoredChunk[] = [
//         { id: 'chunk-1', filePath: 'a.ts', content: 'code1', startLine: 1, endLine: 5, score: 0.9, rank: 1, source: 'bm25' },
//       ];

//       const results2: ScoredChunk[] = [
//         { id: 'chunk-2', filePath: 'b.ts', content: 'code2', startLine: 1, endLine: 5, score: 0.9, rank: 1, source: 'vector' },
//       ];

//       const fusedEqual = service.rrfFusion([
//         { results: results1, weight: 1.0, source: 'bm25' },
//         { results: results2, weight: 1.0, source: 'vector' },
//       ], 60);

//       // With equal weights, both should have equal scores
//       expect(fusedEqual[0]?.fusedScore).toEqual(fusedEqual[1]?.fusedScore);

//       const fusedWeighted = service.rrfFusion([
//         { results: results1, weight: 2.0, source: 'bm25' },
//         { results: results2, weight: 1.0, source: 'vector' },
//       ], 60);

//       // With higher weight, chunk-1 should rank higher
//       expect(fusedWeighted[0]?.id).toBe('chunk-1');
//     });
//   });

//   describe('retrieve', () => {
//     it('should perform full retrieval pipeline', async () => {
//       const response = await service.retrieve('authentication');

//       expect(response.chunks).toBeDefined();
//       expect(response.textView).toBeDefined();
//       expect(typeof response.textView).toBe('string');
//     });

//     it('should include graph expansion when enabled', async () => {
//       const response = await service.retrieve('authentication', {
//         enableGraph: true,
//       });

//       expect(response.subgraph).toBeDefined();
//     });

//     it('should skip graph expansion when disabled', async () => {
//       const response = await service.retrieve('authentication', {
//         enableGraph: false,
//       });

//       expect(response.subgraph).toBeNull();
//     });

//     it('should respect topK option', async () => {
//       const response = await service.retrieve('authentication', {
//         topK: 5,
//       });

//       expect(response.chunks.length).toBeLessThanOrEqual(5);
//     });
//   });

//   describe('retrieveWithGraph', () => {
//     it('should always enable graph expansion', async () => {
//       const response = await service.retrieveWithGraph('authentication');
//       expect(response.subgraph).toBeDefined();
//     });
//   });

//   describe('simpleRetrieve', () => {
//     it('should return only chunks without graph', async () => {
//       const chunks = await service.simpleRetrieve('authentication', 10);
//       expect(Array.isArray(chunks)).toBe(true);
//     });
//   });
// });

// describe('QueryEnhancer', () => {
//   let enhancer: QueryEnhancer;

//   beforeEach(() => {
//     enhancer = new QueryEnhancer();
//   });

//   describe('enhance', () => {
//     it('should normalize query', () => {
//       const result = enhancer.enhance('  FILE  Upload  ');
//       expect(result.normalized).toBe('file upload');
//     });

//     it('should expand synonyms', () => {
//       const result = enhancer.enhance('authentication');
//       expect(result.synonyms.length).toBeGreaterThan(0);
//       expect(result.synonyms).toContain('auth');
//     });

//     it('should expand framework terms', () => {
//       const result = enhancer.enhance('upload');
//       expect(result.frameworkTerms.length).toBeGreaterThan(0);
//       expect(result.frameworkTerms).toContain('multer');
//     });

//     it('should handle Chinese queries', () => {
//       const result = enhancer.enhance('用户认证');
//       expect(result.synonyms.length).toBeGreaterThan(0);
//     });

//     it('should generate BM25 query', () => {
//       const result = enhancer.enhance('test query');
//       expect(result.bm25Query).toBeDefined();
//       expect(result.bm25Query.length).toBeGreaterThan(0);
//     });
//   });

//   describe('generateQueryVariations', () => {
//     it('should generate multiple query variations', () => {
//       const variations = enhancer.generateQueryVariations('authentication');
//       expect(variations.length).toBeGreaterThan(1);
//       expect(variations.length).toBeLessThanOrEqual(5);
//     });
//   });
// });

// describe('ContextBuilder', () => {
//   let builder: ContextBuilder;

//   beforeEach(() => {
//     builder = new ContextBuilder();
//   });

//   describe('buildTextView', () => {
//     it('should build markdown text view', () => {
//       const chunks: ScoredChunk[] = [
//         {
//           id: 'chunk-1',
//           filePath: 'src/auth.ts',
//           content: 'function authenticate() {}',
//           startLine: 1,
//           endLine: 5,
//           score: 0.9,
//           rank: 1,
//           source: 'bm25',
//         },
//       ];

//       const textView = builder.buildTextView(chunks);

//       expect(textView).toContain('## Relevant Code');
//       expect(textView).toContain('src/auth.ts');
//       expect(textView).toContain('function authenticate()');
//       expect(textView).toContain('```typescript');
//     });

//     it('should respect token budget', () => {
//       const longChunks: ScoredChunk[] = Array.from({ length: 100 }, (_, i) => ({
//         id: `chunk-${i}`,
//         filePath: `src/file${i}.ts`,
//         content: 'x'.repeat(1000),
//         startLine: 1,
//         endLine: 100,
//         score: 0.9 - i * 0.01,
//         rank: i + 1,
//         source: 'bm25' as const,
//       }));

//       const textView = builder.buildTextView(longChunks, 100);
//       // Should be truncated to fit budget
//       expect(builder.estimateTokens(textView)).toBeLessThanOrEqual(150); // Some overhead allowed
//     });
//   });

//   describe('buildGraphView', () => {
//     it('should build mermaid graph', () => {
//       const subgraph = {
//         entities: [
//           { id: 'a#func1', name: 'func1', type: 'function' as const, filePath: 'a.ts', startLine: 1, endLine: 10 },
//           { id: 'b#func2', name: 'func2', type: 'function' as const, filePath: 'b.ts', startLine: 1, endLine: 10 },
//         ],
//         relations: [
//           { sourceId: 'a#func1', targetId: 'b#func2', type: 'CALLS' as const },
//         ],
//         seedIds: ['a#func1'],
//         depth: 1,
//       };

//       const graphView = builder.buildGraphView(subgraph);

//       expect(graphView).toContain('```mermaid');
//       expect(graphView).toContain('graph LR');
//       expect(graphView).toContain('calls');
//     });

//     it('should return empty string for empty subgraph', () => {
//       const graphView = builder.buildGraphView({
//         entities: [],
//         relations: [],
//         seedIds: [],
//         depth: 0,
//       });

//       expect(graphView).toBe('');
//     });
//   });

//   describe('estimateTokens', () => {
//     it('should estimate token count', () => {
//       const tokens = builder.estimateTokens('hello world');
//       expect(tokens).toBeGreaterThan(0);
//     });
//   });

//   describe('trimToTokenBudget', () => {
//     it('should trim content to budget', () => {
//       const content = 'a'.repeat(100);
//       const trimmed = builder.trimToTokenBudget(content, 10);
//       expect(trimmed.length).toBeLessThan(content.length);
//       expect(trimmed.endsWith('...')).toBe(true);
//     });

//     it('should not trim content within budget', () => {
//       const content = 'short';
//       const trimmed = builder.trimToTokenBudget(content, 100);
//       expect(trimmed).toBe(content);
//     });
//   });
// });
