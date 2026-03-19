/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';

import { SqliteGraphStore } from './sqliteGraphStore.js';
import type { SymbolDefinition, SymbolEdge, ImportMapping } from '../types.js';

// ===== Test Helpers =====

function tempDbPath(): string {
  const dir = path.join(os.tmpdir(), 'graph-store-test');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, `graph-${crypto.randomBytes(8).toString('hex')}.db`);
}

function createSymbol(
  overrides: Partial<SymbolDefinition> = {},
): SymbolDefinition {
  const name =
    overrides.name ?? `func_${crypto.randomBytes(4).toString('hex')}`;
  const filePath = overrides.filePath ?? 'src/test.ts';
  return {
    id: overrides.id ?? `${filePath}#${name}`,
    name,
    qualifiedName: overrides.qualifiedName ?? name,
    type: overrides.type ?? 'function',
    filePath,
    startLine: overrides.startLine ?? 1,
    endLine: overrides.endLine ?? 10,
    chunkId:
      overrides.chunkId ?? `chunk_${crypto.randomBytes(4).toString('hex')}`,
    signature: overrides.signature ?? `function ${name}(): void`,
    exported: overrides.exported ?? false,
  };
}

function createEdge(overrides: Partial<SymbolEdge> = {}): SymbolEdge {
  return {
    sourceId: overrides.sourceId ?? 'src/a.ts#funcA',
    targetId: overrides.targetId ?? 'src/b.ts#funcB',
    type: overrides.type ?? 'CALLS',
    filePath: overrides.filePath ?? 'src/a.ts',
    line: overrides.line ?? 5,
  };
}

function createImport(overrides: Partial<ImportMapping> = {}): ImportMapping {
  return {
    filePath: overrides.filePath ?? 'src/a.ts',
    localName: overrides.localName ?? 'funcB',
    sourceModule: overrides.sourceModule ?? './b',
    originalName: overrides.originalName ?? 'funcB',
    resolvedPath: overrides.resolvedPath ?? 'src/b.ts',
  };
}

// ===== Tests =====

describe('SqliteGraphStore', () => {
  let store: SqliteGraphStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
    // Use a dummy projectHash, but override the path
    store = new SqliteGraphStore('test', dbPath);
    store.initialize();
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // Ignore
    }

    // Cleanup
    try {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      // Also remove WAL/SHM files
      if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
      if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');
    } catch {
      // Ignore
    }
  });

  // ===== Initialization =====

  describe('initialization', () => {
    it('should initialize with empty tables', () => {
      const stats = store.getStats();
      expect(stats.symbolCount).toBe(0);
      expect(stats.edgeCount).toBe(0);
      expect(stats.importCount).toBe(0);
    });

    it('should create the database file', () => {
      expect(fs.existsSync(dbPath)).toBe(true);
    });
  });

  // ===== Insert Operations =====

  describe('insert operations', () => {
    it('should insert symbols', () => {
      const symbols = [
        createSymbol({ id: 'src/a.ts#funcA', name: 'funcA' }),
        createSymbol({ id: 'src/a.ts#funcB', name: 'funcB' }),
      ];

      store.insertSymbols(symbols);
      const stats = store.getStats();
      expect(stats.symbolCount).toBe(2);
    });

    it('should insert edges', () => {
      const edges = [
        createEdge({
          sourceId: 'src/a.ts#funcA',
          targetId: 'src/b.ts#funcB',
          type: 'CALLS',
        }),
        createEdge({
          sourceId: 'src/a.ts#MyClass',
          targetId: 'src/b.ts#BaseClass',
          type: 'EXTENDS',
        }),
      ];

      store.insertEdges(edges);
      const stats = store.getStats();
      expect(stats.edgeCount).toBe(2);
    });

    it('should insert imports', () => {
      const imports = [
        createImport({ localName: 'funcB', resolvedPath: 'src/b.ts' }),
        createImport({
          localName: 'Logger',
          sourceModule: './logger',
          resolvedPath: 'src/logger.ts',
        }),
      ];

      store.insertImports(imports);
      const stats = store.getStats();
      expect(stats.importCount).toBe(2);
    });

    it('should handle empty arrays gracefully', () => {
      store.insertSymbols([]);
      store.insertEdges([]);
      store.insertImports([]);
      const stats = store.getStats();
      expect(stats.symbolCount).toBe(0);
      expect(stats.edgeCount).toBe(0);
      expect(stats.importCount).toBe(0);
    });

    it('should deduplicate edges (source+target+type)', () => {
      const edge = createEdge({
        sourceId: 'src/a.ts#f',
        targetId: 'src/b.ts#g',
        type: 'CALLS',
      });

      store.insertEdges([edge]);
      store.insertEdges([edge]); // Duplicate — should be ignored
      const stats = store.getStats();
      expect(stats.edgeCount).toBe(1);
    });

    it('should replace symbols with same ID (upsert)', () => {
      const sym1 = createSymbol({
        id: 'src/a.ts#func',
        name: 'func',
        filePath: 'src/a.ts',
        signature: 'v1',
      });
      store.insertSymbols([sym1]);

      const sym2 = createSymbol({
        id: 'src/a.ts#func',
        name: 'func',
        filePath: 'src/a.ts',
        signature: 'v2',
      });
      store.insertSymbols([sym2]);

      const stats = store.getStats();
      expect(stats.symbolCount).toBe(1);

      // Verify the signature was updated
      const symbols = store.getSymbolsByFilePath('src/a.ts');
      expect(symbols[0].signature).toBe('v2');
    });
  });

  // ===== Delete Operations =====

  describe('delete by file path', () => {
    it('should delete all data for a file', () => {
      const symbols = [
        createSymbol({ id: 'src/a.ts#f1', filePath: 'src/a.ts' }),
        createSymbol({ id: 'src/a.ts#f2', filePath: 'src/a.ts' }),
        createSymbol({ id: 'src/b.ts#f3', filePath: 'src/b.ts' }),
      ];
      const edges = [
        createEdge({
          sourceId: 'src/a.ts#f1',
          targetId: 'src/a.ts#f2',
          filePath: 'src/a.ts',
        }),
        createEdge({
          sourceId: 'src/b.ts#f3',
          targetId: 'src/a.ts#f1',
          filePath: 'src/b.ts',
        }),
      ];
      const imports = [
        createImport({ filePath: 'src/a.ts' }),
        createImport({ filePath: 'src/b.ts' }),
      ];

      store.insertSymbols(symbols);
      store.insertEdges(edges);
      store.insertImports(imports);

      // Delete file a.ts
      store.deleteByFilePath('src/a.ts');

      const stats = store.getStats();
      expect(stats.symbolCount).toBe(1); // Only src/b.ts#f3 remains
      expect(stats.edgeCount).toBe(0); // b.ts→a.ts edge also deleted (inbound to deleted symbols)
      expect(stats.importCount).toBe(1); // Only src/b.ts import remains
    });

    it('should not affect unrelated files', () => {
      const symbols = [
        createSymbol({ id: 'src/x.ts#f', filePath: 'src/x.ts' }),
      ];
      store.insertSymbols(symbols);

      store.deleteByFilePath('src/unrelated.ts');
      expect(store.getStats().symbolCount).toBe(1);
    });
  });

  // ===== Query Operations =====

  describe('getSymbolsByChunkIds', () => {
    it('should retrieve symbols by chunk IDs', () => {
      const sym1 = createSymbol({
        id: 'src/a.ts#f1',
        chunkId: 'chunk-1',
      });
      const sym2 = createSymbol({
        id: 'src/a.ts#f2',
        chunkId: 'chunk-2',
      });
      const sym3 = createSymbol({
        id: 'src/a.ts#f3',
        chunkId: 'chunk-3',
      });

      store.insertSymbols([sym1, sym2, sym3]);

      const result = store.getSymbolsByChunkIds(['chunk-1', 'chunk-3']);
      expect(result).toHaveLength(2);
      expect(result.map((s) => s.id)).toContain('src/a.ts#f1');
      expect(result.map((s) => s.id)).toContain('src/a.ts#f3');
    });

    it('should return empty array for no matching chunks', () => {
      const result = store.getSymbolsByChunkIds(['nonexistent']);
      expect(result).toHaveLength(0);
    });

    it('should handle empty chunk IDs array', () => {
      const result = store.getSymbolsByChunkIds([]);
      expect(result).toHaveLength(0);
    });
  });

  describe('getEdgesBetweenSymbols', () => {
    it('should retrieve edges between specified symbols', () => {
      store.insertEdges([
        createEdge({
          sourceId: 'A',
          targetId: 'B',
          type: 'CALLS',
        }),
        createEdge({
          sourceId: 'B',
          targetId: 'C',
          type: 'CALLS',
        }),
        createEdge({
          sourceId: 'D',
          targetId: 'E',
          type: 'CALLS',
        }),
      ]);

      const result = store.getEdgesBetweenSymbols(['A', 'B', 'C']);
      expect(result).toHaveLength(2); // A→B and B→C
    });

    it('should return empty for no matching symbols', () => {
      store.insertEdges([createEdge({ sourceId: 'A', targetId: 'B' })]);

      const result = store.getEdgesBetweenSymbols(['X', 'Y']);
      expect(result).toHaveLength(0);
    });
  });

  // ===== Graph Expansion (Recursive CTE) =====

  describe('expandFromChunks', () => {
    /**
     * Set up a graph for expansion tests:
     *
     *  chunk-1: [symA]
     *  chunk-2: [symB]
     *  chunk-3: [symC]
     *  chunk-4: [symD]
     *  chunk-5: [symE]
     *
     *  symA --CALLS--> symB --CALLS--> symC
     *  symA --EXTENDS--> symD
     *  symE is isolated
     */
    function setupExpansionGraph(s: SqliteGraphStore) {
      const symbols = [
        createSymbol({
          id: 'f1#symA',
          name: 'symA',
          chunkId: 'chunk-1',
          filePath: 'f1',
        }),
        createSymbol({
          id: 'f2#symB',
          name: 'symB',
          chunkId: 'chunk-2',
          filePath: 'f2',
        }),
        createSymbol({
          id: 'f3#symC',
          name: 'symC',
          chunkId: 'chunk-3',
          filePath: 'f3',
        }),
        createSymbol({
          id: 'f4#symD',
          name: 'symD',
          chunkId: 'chunk-4',
          filePath: 'f4',
        }),
        createSymbol({
          id: 'f5#symE',
          name: 'symE',
          chunkId: 'chunk-5',
          filePath: 'f5',
        }),
      ];
      const edges: SymbolEdge[] = [
        {
          sourceId: 'f1#symA',
          targetId: 'f2#symB',
          type: 'CALLS',
          filePath: 'f1',
        },
        {
          sourceId: 'f2#symB',
          targetId: 'f3#symC',
          type: 'CALLS',
          filePath: 'f2',
        },
        {
          sourceId: 'f1#symA',
          targetId: 'f4#symD',
          type: 'EXTENDS',
          filePath: 'f1',
        },
      ];

      s.insertSymbols(symbols);
      s.insertEdges(edges);
    }

    it('should expand one hop from seed chunks', () => {
      setupExpansionGraph(store);

      const result = store.expandFromChunks(['chunk-1'], {
        maxDepth: 1,
        bidirectional: true,
      });

      // From chunk-1 (symA): one hop forward → symB (chunk-2), symD (chunk-4)
      expect(result.seedChunkIds).toEqual(['chunk-1']);
      expect(result.relatedChunkIds).toContain('chunk-2');
      expect(result.relatedChunkIds).toContain('chunk-4');
      expect(result.relatedChunkIds).not.toContain('chunk-3'); // 2 hops away
      expect(result.relatedChunkIds).not.toContain('chunk-5'); // isolated
    });

    it('should expand two hops from seed chunks', () => {
      setupExpansionGraph(store);

      const result = store.expandFromChunks(['chunk-1'], {
        maxDepth: 2,
        bidirectional: true,
      });

      // From chunk-1 (symA): two hops → symB, symD (depth 1) + symC (depth 2)
      expect(result.relatedChunkIds).toContain('chunk-2');
      expect(result.relatedChunkIds).toContain('chunk-3');
      expect(result.relatedChunkIds).toContain('chunk-4');
      expect(result.relatedChunkIds).not.toContain('chunk-5'); // isolated
    });

    it('should exclude seed chunks from related results', () => {
      setupExpansionGraph(store);

      const result = store.expandFromChunks(['chunk-1'], {
        maxDepth: 2,
      });

      // chunk-1 is a seed, should not be in relatedChunkIds
      expect(result.relatedChunkIds).not.toContain('chunk-1');
    });

    it('should respect maxChunks limit', () => {
      setupExpansionGraph(store);

      const result = store.expandFromChunks(['chunk-1'], {
        maxDepth: 2,
        maxChunks: 1,
      });

      // Should only return 1 related chunk
      expect(result.relatedChunkIds).toHaveLength(1);
    });

    it('should support bidirectional traversal', () => {
      setupExpansionGraph(store);

      // Start from chunk-3 (symC), backward → symB, then symA
      const result = store.expandFromChunks(['chunk-3'], {
        maxDepth: 2,
        bidirectional: true,
      });

      // Backward: symC ← symB (depth 1) ← symA (depth 2)
      expect(result.relatedChunkIds).toContain('chunk-2'); // symB
      expect(result.relatedChunkIds).toContain('chunk-1'); // symA
    });

    it('should support forward-only traversal', () => {
      setupExpansionGraph(store);

      // Start from chunk-3 (symC), forward only → nothing (symC has no outgoing edges)
      const result = store.expandFromChunks(['chunk-3'], {
        maxDepth: 2,
        bidirectional: false,
      });

      // symC has no outgoing edges, so no related chunks
      expect(result.relatedChunkIds).toHaveLength(0);
    });

    it('should filter by edge types', () => {
      setupExpansionGraph(store);

      // Only follow CALLS edges
      const result = store.expandFromChunks(['chunk-1'], {
        maxDepth: 2,
        edgeTypes: ['CALLS'],
      });

      // symA --CALLS--> symB --CALLS--> symC
      expect(result.relatedChunkIds).toContain('chunk-2');
      expect(result.relatedChunkIds).toContain('chunk-3');
      // symA --EXTENDS--> symD should NOT be followed
      expect(result.relatedChunkIds).not.toContain('chunk-4');
    });

    it('should return empty for no seed chunks', () => {
      setupExpansionGraph(store);

      const result = store.expandFromChunks([]);
      expect(result.relatedChunkIds).toHaveLength(0);
      expect(result.symbols).toHaveLength(0);
      expect(result.edges).toHaveLength(0);
    });

    it('should return empty when no symbols match seed chunks', () => {
      setupExpansionGraph(store);

      const result = store.expandFromChunks(['nonexistent-chunk']);
      expect(result.relatedChunkIds).toHaveLength(0);
    });

    it('should include edges in the result', () => {
      setupExpansionGraph(store);

      const result = store.expandFromChunks(['chunk-1'], {
        maxDepth: 2,
      });

      // Should include edges between discovered symbols
      expect(result.edges.length).toBeGreaterThan(0);
      const callEdge = result.edges.find(
        (e) => e.sourceId === 'f1#symA' && e.targetId === 'f2#symB',
      );
      expect(callEdge).toBeDefined();
    });

    it('should handle multiple seed chunks', () => {
      setupExpansionGraph(store);

      const result = store.expandFromChunks(['chunk-1', 'chunk-5'], {
        maxDepth: 1,
      });

      // From chunk-1: symB (chunk-2), symD (chunk-4)
      // From chunk-5: symE has no edges → nothing
      expect(result.relatedChunkIds).toContain('chunk-2');
      expect(result.relatedChunkIds).toContain('chunk-4');
      expect(result.seedChunkIds).toContain('chunk-1');
      expect(result.seedChunkIds).toContain('chunk-5');
    });
  });

  // ===== Chunk Mapping =====

  describe('updateChunkMappings', () => {
    it('should update chunk_id for symbols', () => {
      const sym1 = createSymbol({
        id: 'src/a.ts#funcA',
        name: 'funcA',
        filePath: 'src/a.ts',
        startLine: 1,
        endLine: 10,
        chunkId: undefined,
      });
      const sym2 = createSymbol({
        id: 'src/a.ts#funcB',
        name: 'funcB',
        filePath: 'src/a.ts',
        startLine: 12,
        endLine: 20,
        chunkId: undefined,
      });

      store.insertSymbols([sym1, sym2]);

      // Map chunks
      store.updateChunkMappings('src/a.ts', [
        { chunkId: 'chunk-1', startLine: 1, endLine: 11 },
        { chunkId: 'chunk-2', startLine: 12, endLine: 25 },
      ]);

      const updated = store.getSymbolsByFilePath('src/a.ts');
      const a = updated.find((s) => s.name === 'funcA');
      const b = updated.find((s) => s.name === 'funcB');
      expect(a?.chunkId).toBe('chunk-1');
      expect(b?.chunkId).toBe('chunk-2');
    });
  });

  // ===== Cross-File Resolution =====

  describe('resolveEdgesByName', () => {
    it('should resolve unique cross-file references', () => {
      // File A defines funcA, File B defines funcB
      // File A references funcB (stored as ?#funcB)
      store.insertSymbols([
        createSymbol({
          id: 'src/a.ts#funcA',
          name: 'funcA',
          filePath: 'src/a.ts',
          exported: true,
        }),
        createSymbol({
          id: 'src/b.ts#funcB',
          name: 'funcB',
          filePath: 'src/b.ts',
          exported: true,
        }),
      ]);
      store.insertEdges([
        createEdge({
          sourceId: 'src/a.ts#funcA',
          targetId: '?#funcB',
          type: 'CALLS',
          filePath: 'src/a.ts',
        }),
      ]);

      const resolved = store.resolveEdgesByName();
      expect(resolved).toBe(1);

      // Edge should now point to src/b.ts#funcB
      const edges = store.getEdgesByFilePath('src/a.ts');
      const callEdge = edges.find((e) => e.type === 'CALLS');
      expect(callEdge?.targetId).toBe('src/b.ts#funcB');
    });

    it('should remove unresolvable edges', () => {
      store.insertSymbols([
        createSymbol({
          id: 'src/a.ts#funcA',
          name: 'funcA',
          filePath: 'src/a.ts',
        }),
      ]);
      store.insertEdges([
        createEdge({
          sourceId: 'src/a.ts#funcA',
          targetId: '?#nonExistent',
          type: 'CALLS',
          filePath: 'src/a.ts',
        }),
      ]);

      const resolved = store.resolveEdgesByName();
      expect(resolved).toBe(0);

      // Edge should be deleted
      const edges = store.getEdgesByFilePath('src/a.ts');
      expect(edges.filter((e) => e.type === 'CALLS')).toHaveLength(0);
    });

    it('should prefer import-guided resolution when multiple candidates exist', () => {
      // Both fileB and fileC define 'Config'
      // File A imports Config from fileB
      store.insertSymbols([
        createSymbol({
          id: 'src/a.ts#funcA',
          name: 'funcA',
          filePath: 'src/a.ts',
        }),
        createSymbol({
          id: 'src/b.ts#Config',
          name: 'Config',
          filePath: 'src/b.ts',
          exported: true,
        }),
        createSymbol({
          id: 'src/c.ts#Config',
          name: 'Config',
          filePath: 'src/c.ts',
          exported: true,
        }),
      ]);
      store.insertEdges([
        createEdge({
          sourceId: 'src/a.ts#funcA',
          targetId: '?#Config',
          type: 'CALLS',
          filePath: 'src/a.ts',
        }),
      ]);
      store.insertImports([
        createImport({
          filePath: 'src/a.ts',
          localName: 'Config',
          sourceModule: './b',
          originalName: 'Config',
          resolvedPath: 'src/b.ts',
        }),
      ]);

      const resolved = store.resolveEdgesByName();
      expect(resolved).toBe(1);

      // Should resolve to src/b.ts#Config (import-guided)
      const edges = store.getEdgesByFilePath('src/a.ts');
      const callEdge = edges.find((e) => e.type === 'CALLS');
      expect(callEdge?.targetId).toBe('src/b.ts#Config');
    });

    it('should prefer exported symbols when no import hint exists', () => {
      // Both fileB and fileC define 'Helper', but only fileB exports it
      store.insertSymbols([
        createSymbol({
          id: 'src/a.ts#funcA',
          name: 'funcA',
          filePath: 'src/a.ts',
        }),
        createSymbol({
          id: 'src/b.ts#Helper',
          name: 'Helper',
          filePath: 'src/b.ts',
          exported: true,
        }),
        createSymbol({
          id: 'src/c.ts#Helper',
          name: 'Helper',
          filePath: 'src/c.ts',
          exported: false,
        }),
      ]);
      store.insertEdges([
        createEdge({
          sourceId: 'src/a.ts#funcA',
          targetId: '?#Helper',
          type: 'CALLS',
          filePath: 'src/a.ts',
        }),
      ]);

      const resolved = store.resolveEdgesByName();
      expect(resolved).toBe(1);

      // Should resolve to the exported symbol
      const edges = store.getEdgesByFilePath('src/a.ts');
      const callEdge = edges.find((e) => e.type === 'CALLS');
      expect(callEdge?.targetId).toBe('src/b.ts#Helper');
    });

    it('should not resolve same-file references (already resolved)', () => {
      // Same-file edges should NOT have ?# prefix
      store.insertSymbols([
        createSymbol({
          id: 'src/a.ts#funcA',
          name: 'funcA',
          filePath: 'src/a.ts',
        }),
        createSymbol({
          id: 'src/a.ts#funcB',
          name: 'funcB',
          filePath: 'src/a.ts',
        }),
      ]);
      store.insertEdges([
        createEdge({
          sourceId: 'src/a.ts#funcA',
          targetId: 'src/a.ts#funcB',
          type: 'CALLS',
          filePath: 'src/a.ts',
        }),
      ]);

      const resolved = store.resolveEdgesByName();
      expect(resolved).toBe(0);

      // Edge should remain unchanged
      const edges = store.getEdgesByFilePath('src/a.ts');
      expect(edges.find((e) => e.type === 'CALLS')?.targetId).toBe(
        'src/a.ts#funcB',
      );
    });

    it('should handle multiple unresolved edges in batch', () => {
      store.insertSymbols([
        createSymbol({
          id: 'src/a.ts#funcA',
          name: 'funcA',
          filePath: 'src/a.ts',
        }),
        createSymbol({
          id: 'src/b.ts#funcB',
          name: 'funcB',
          filePath: 'src/b.ts',
          exported: true,
        }),
        createSymbol({
          id: 'src/c.ts#funcC',
          name: 'funcC',
          filePath: 'src/c.ts',
          exported: true,
        }),
      ]);
      store.insertEdges([
        createEdge({
          sourceId: 'src/a.ts#funcA',
          targetId: '?#funcB',
          type: 'CALLS',
          filePath: 'src/a.ts',
          line: 5,
        }),
        createEdge({
          sourceId: 'src/a.ts#funcA',
          targetId: '?#funcC',
          type: 'CALLS',
          filePath: 'src/a.ts',
          line: 6,
        }),
        createEdge({
          sourceId: 'src/a.ts#funcA',
          targetId: '?#missingFunc',
          type: 'CALLS',
          filePath: 'src/a.ts',
          line: 7,
        }),
      ]);

      const resolved = store.resolveEdgesByName();
      expect(resolved).toBe(2); // funcB and funcC resolved, missingFunc removed

      const edges = store.getEdgesByFilePath('src/a.ts');
      const callEdges = edges.filter((e) => e.type === 'CALLS');
      expect(callEdges).toHaveLength(2);
      expect(callEdges.map((e) => e.targetId).sort()).toEqual([
        'src/b.ts#funcB',
        'src/c.ts#funcC',
      ]);
    });

    it('should resolve EXTENDS edges for class inheritance', () => {
      store.insertSymbols([
        createSymbol({
          id: 'src/child.ts#ChildClass',
          name: 'ChildClass',
          type: 'class',
          filePath: 'src/child.ts',
        }),
        createSymbol({
          id: 'src/base.ts#BaseClass',
          name: 'BaseClass',
          type: 'class',
          filePath: 'src/base.ts',
          exported: true,
        }),
      ]);
      store.insertEdges([
        createEdge({
          sourceId: 'src/child.ts#ChildClass',
          targetId: '?#BaseClass',
          type: 'EXTENDS',
          filePath: 'src/child.ts',
        }),
      ]);

      const resolved = store.resolveEdgesByName();
      expect(resolved).toBe(1);

      const edges = store.getEdgesByFilePath('src/child.ts');
      const extendsEdge = edges.find((e) => e.type === 'EXTENDS');
      expect(extendsEdge?.targetId).toBe('src/base.ts#BaseClass');
    });

    it('should return 0 when no unresolved edges exist', () => {
      store.insertSymbols([
        createSymbol({
          id: 'src/a.ts#funcA',
          name: 'funcA',
          filePath: 'src/a.ts',
        }),
      ]);
      store.insertEdges([
        createEdge({
          sourceId: 'src/a.ts#funcA',
          targetId: 'src/a.ts#funcA',
          type: 'CALLS',
          filePath: 'src/a.ts',
        }),
      ]);

      const resolved = store.resolveEdgesByName();
      expect(resolved).toBe(0);
    });

    // --- Module-scoped placeholder resolution ---

    it('should resolve module-scoped placeholder ?sourceModule#name via imports table', () => {
      // File A calls logger.info() where logger is imported from './logger'
      // → extraction produces ?./logger#info
      // File B ('src/logger.ts') defines 'info'
      store.insertSymbols([
        createSymbol({
          id: 'src/a.ts#main',
          name: 'main',
          filePath: 'src/a.ts',
        }),
        createSymbol({
          id: 'src/logger.ts#info',
          name: 'info',
          filePath: 'src/logger.ts',
          exported: true,
        }),
      ]);
      store.insertEdges([
        createEdge({
          sourceId: 'src/a.ts#main',
          targetId: '?./logger#info',
          type: 'CALLS',
          filePath: 'src/a.ts',
        }),
      ]);
      store.insertImports([
        createImport({
          filePath: 'src/a.ts',
          localName: 'logger',
          sourceModule: './logger',
          originalName: 'logger',
          resolvedPath: 'src/logger.ts',
        }),
      ]);

      const resolved = store.resolveEdgesByName();
      expect(resolved).toBe(1);

      const edges = store.getEdgesByFilePath('src/a.ts');
      const callEdge = edges.find((e) => e.type === 'CALLS');
      expect(callEdge?.targetId).toBe('src/logger.ts#info');
    });

    it('should remove module-scoped placeholder when external package has no indexed symbols', () => {
      // tseslint.config() → ?typescript-eslint#config
      // No symbols from typescript-eslint in the DB
      store.insertSymbols([
        createSymbol({
          id: 'src/lint.ts#setup',
          name: 'setup',
          filePath: 'src/lint.ts',
        }),
      ]);
      store.insertEdges([
        createEdge({
          sourceId: 'src/lint.ts#setup',
          targetId: '?typescript-eslint#config',
          type: 'CALLS',
          filePath: 'src/lint.ts',
        }),
      ]);
      // No imports with resolved_path for typescript-eslint (bare specifier)

      const resolved = store.resolveEdgesByName();
      expect(resolved).toBe(0);

      // Edge should be deleted
      const edges = store.getEdgesByFilePath('src/lint.ts');
      expect(edges.filter((e) => e.type === 'CALLS')).toHaveLength(0);
    });

    it('should resolve module-scoped placeholder even when multiple files export the same name', () => {
      // Both src/a-logger.ts and src/b-logger.ts export 'warn'
      // File main.ts imports logger from './a-logger'
      // Edge should resolve to src/a-logger.ts#warn, not src/b-logger.ts#warn
      store.insertSymbols([
        createSymbol({
          id: 'src/main.ts#run',
          name: 'run',
          filePath: 'src/main.ts',
        }),
        createSymbol({
          id: 'src/a-logger.ts#warn',
          name: 'warn',
          filePath: 'src/a-logger.ts',
          exported: true,
        }),
        createSymbol({
          id: 'src/b-logger.ts#warn',
          name: 'warn',
          filePath: 'src/b-logger.ts',
          exported: true,
        }),
      ]);
      store.insertEdges([
        createEdge({
          sourceId: 'src/main.ts#run',
          targetId: '?./a-logger#warn',
          type: 'CALLS',
          filePath: 'src/main.ts',
        }),
      ]);
      store.insertImports([
        createImport({
          filePath: 'src/main.ts',
          localName: 'logger',
          sourceModule: './a-logger',
          originalName: 'logger',
          resolvedPath: 'src/a-logger.ts',
        }),
      ]);

      const resolved = store.resolveEdgesByName();
      expect(resolved).toBe(1);

      const edges = store.getEdgesByFilePath('src/main.ts');
      const callEdge = edges.find((e) => e.type === 'CALLS');
      expect(callEdge?.targetId).toBe('src/a-logger.ts#warn');
    });

    it('should handle mixed direct and module-scoped placeholders in one batch', () => {
      store.insertSymbols([
        createSymbol({
          id: 'src/main.ts#run',
          name: 'run',
          filePath: 'src/main.ts',
        }),
        createSymbol({
          id: 'src/utils.ts#helper',
          name: 'helper',
          filePath: 'src/utils.ts',
          exported: true,
        }),
        createSymbol({
          id: 'src/logger.ts#info',
          name: 'info',
          filePath: 'src/logger.ts',
          exported: true,
        }),
      ]);
      store.insertEdges([
        // Direct call: helper()
        createEdge({
          sourceId: 'src/main.ts#run',
          targetId: '?#helper',
          type: 'CALLS',
          filePath: 'src/main.ts',
          line: 5,
        }),
        // Module-scoped: logger.info()
        createEdge({
          sourceId: 'src/main.ts#run',
          targetId: '?./logger#info',
          type: 'CALLS',
          filePath: 'src/main.ts',
          line: 6,
        }),
        // Unresolvable: ?nonexistent#foo
        createEdge({
          sourceId: 'src/main.ts#run',
          targetId: '?nonexistent#foo',
          type: 'CALLS',
          filePath: 'src/main.ts',
          line: 7,
        }),
      ]);
      store.insertImports([
        createImport({
          filePath: 'src/main.ts',
          localName: 'logger',
          sourceModule: './logger',
          originalName: 'logger',
          resolvedPath: 'src/logger.ts',
        }),
      ]);

      const resolved = store.resolveEdgesByName();
      expect(resolved).toBe(2); // helper + info resolved, foo removed

      const edges = store.getEdgesByFilePath('src/main.ts');
      const callEdges = edges.filter((e) => e.type === 'CALLS');
      expect(callEdges).toHaveLength(2);
      expect(callEdges.map((e) => e.targetId).sort()).toEqual([
        'src/logger.ts#info',
        'src/utils.ts#helper',
      ]);
    });
  });

  // ===== Detailed Stats =====

  describe('getDetailedStats', () => {
    it('should return breakdown by type', () => {
      store.insertSymbols([
        createSymbol({ id: 'a#f1', type: 'function', filePath: 'a' }),
        createSymbol({ id: 'a#f2', type: 'function', filePath: 'a' }),
        createSymbol({ id: 'a#c1', type: 'class', filePath: 'a' }),
        createSymbol({ id: 'b#f3', type: 'function', filePath: 'b' }),
      ]);
      store.insertEdges([
        createEdge({
          sourceId: 'a#f1',
          targetId: 'a#f2',
          type: 'CALLS',
          filePath: 'a',
        }),
        createEdge({
          sourceId: 'a#c1',
          targetId: 'a#f1',
          type: 'CONTAINS',
          filePath: 'a',
        }),
      ]);

      const detailed = store.getDetailedStats();
      expect(detailed.symbolsByType['function']).toBe(3);
      expect(detailed.symbolsByType['class']).toBe(1);
      expect(detailed.edgesByType['CALLS']).toBe(1);
      expect(detailed.edgesByType['CONTAINS']).toBe(1);
      expect(detailed.fileCount).toBe(2);
    });
  });

  // ===== Lifecycle =====

  describe('lifecycle', () => {
    it('should be safe to close multiple times', () => {
      store.close();
      expect(() => store.close()).not.toThrow();
    });
  });
});
