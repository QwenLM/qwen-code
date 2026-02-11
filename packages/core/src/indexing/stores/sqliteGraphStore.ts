/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SQLite-based Symbol Graph Store.
 *
 * Replaces the old @ruvector/graph-node with a SQLite adjacency table approach:
 * - `symbols` table: all symbol definitions with chunk mapping
 * - `edges` table: all edges between symbols (CALLS, EXTENDS, IMPLEMENTS, CONTAINS, IMPORTS)
 * - `imports` table: import mappings for reference resolution
 *
 * Key feature: `expandFromChunks()` uses SQLite recursive CTEs for graph traversal,
 * starting from seed chunk IDs and expanding outward via edges to discover related chunks.
 *
 * Design principles:
 * - All operations are synchronous (better-sqlite3)
 * - All writes use transactions for atomicity
 * - Incremental: deleteByFilePath() removes all data for a single file
 * - High performance: prepared statements + WAL mode + proper indexes
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getIndexDir } from './metadataStore.js';
import type {
  SymbolDefinition,
  SymbolEdge,
  ImportMapping,
  ISymbolGraphStore,
  GraphExpansionOptions,
  GraphExpansionResult,
  SymbolType,
  EdgeType,
} from '../types.js';

// ===== Schema =====

const SCHEMA = `
-- Symbol definitions table
CREATE TABLE IF NOT EXISTS symbols (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    chunk_id TEXT,
    signature TEXT,
    exported INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_symbols_file_path ON symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_symbols_chunk_id ON symbols(chunk_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_type ON symbols(type);

-- Edges table (adjacency list)
CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    line INTEGER,
    UNIQUE(source_id, target_id, type)
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_file_path ON edges(file_path);
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);

-- Import mappings table
CREATE TABLE IF NOT EXISTS imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL,
    local_name TEXT NOT NULL,
    source_module TEXT NOT NULL,
    original_name TEXT NOT NULL,
    resolved_path TEXT
);

CREATE INDEX IF NOT EXISTS idx_imports_file_path ON imports(file_path);
CREATE INDEX IF NOT EXISTS idx_imports_resolved_path ON imports(resolved_path);
CREATE INDEX IF NOT EXISTS idx_imports_source_module ON imports(source_module);
`;

// ===== SqliteGraphStore =====

/**
 * SQLite-based symbol graph storage with recursive CTE graph traversal.
 */
export class SqliteGraphStore implements ISymbolGraphStore {
  private db: Database.Database;
  private readonly dbPath: string;

  // Prepared statements (initialized lazily)
  private stmts: {
    insertSymbol?: Database.Statement;
    insertEdge?: Database.Statement;
    insertImport?: Database.Statement;
    deleteSymbolsByFile?: Database.Statement;
    deleteEdgesByFile?: Database.Statement;
    deleteImportsByFile?: Database.Statement;
    getSymbolsByChunkIds?: Database.Statement;
    getEdgesBetweenSymbols?: Database.Statement;
    getStats?: Database.Statement;
  } = {};

  /**
   * Creates a new SqliteGraphStore.
   * @param projectHash - SHA-256 hash of the project root (for storage path).
   * @param dbPathOverride - Optional override for the database file path (for testing).
   */
  constructor(projectHash: string, dbPathOverride?: string) {
    this.dbPath =
      dbPathOverride ?? path.join(getIndexDir(projectHash), 'graph.db');

    // Ensure directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Open database with WAL mode
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
  }

  /**
   * Initialize the database tables.
   */
  initialize(): void {
    this.db.exec(SCHEMA);
    this.prepareStatements();
  }

  /**
   * Prepare reusable statements for performance.
   */
  private prepareStatements(): void {
    this.stmts.insertSymbol = this.db.prepare(`
      INSERT OR REPLACE INTO symbols
        (id, name, qualified_name, type, file_path, start_line, end_line, chunk_id, signature, exported)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmts.insertEdge = this.db.prepare(`
      INSERT OR IGNORE INTO edges
        (source_id, target_id, type, file_path, line)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.stmts.insertImport = this.db.prepare(`
      INSERT INTO imports
        (file_path, local_name, source_module, original_name, resolved_path)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.stmts.deleteSymbolsByFile = this.db.prepare(
      'DELETE FROM symbols WHERE file_path = ?',
    );

    this.stmts.deleteEdgesByFile = this.db.prepare(
      'DELETE FROM edges WHERE file_path = ?',
    );

    this.stmts.deleteImportsByFile = this.db.prepare(
      'DELETE FROM imports WHERE file_path = ?',
    );
  }

  // ===== Write Operations =====

  /**
   * Insert symbol definitions in a transaction.
   */
  insertSymbols(symbols: SymbolDefinition[]): void {
    if (symbols.length === 0) return;

    const stmt = this.stmts.insertSymbol!;
    const transaction = this.db.transaction((syms: SymbolDefinition[]) => {
      for (const sym of syms) {
        stmt.run(
          sym.id,
          sym.name,
          sym.qualifiedName,
          sym.type,
          sym.filePath,
          sym.startLine,
          sym.endLine,
          sym.chunkId ?? null,
          sym.signature ?? null,
          sym.exported ? 1 : 0,
        );
      }
    });

    transaction(symbols);
  }

  /**
   * Insert edges in a transaction.
   */
  insertEdges(edges: SymbolEdge[]): void {
    if (edges.length === 0) return;

    const stmt = this.stmts.insertEdge!;
    const transaction = this.db.transaction((edgeList: SymbolEdge[]) => {
      for (const edge of edgeList) {
        stmt.run(
          edge.sourceId,
          edge.targetId,
          edge.type,
          edge.filePath,
          edge.line ?? null,
        );
      }
    });

    transaction(edges);
  }

  /**
   * Insert import mappings in a transaction.
   */
  insertImports(imports: ImportMapping[]): void {
    if (imports.length === 0) return;

    const stmt = this.stmts.insertImport!;
    const transaction = this.db.transaction((impList: ImportMapping[]) => {
      for (const imp of impList) {
        stmt.run(
          imp.filePath,
          imp.localName,
          imp.sourceModule,
          imp.originalName,
          imp.resolvedPath ?? null,
        );
      }
    });

    transaction(imports);
  }

  /**
   * Delete all graph data for a file (symbols, edges, imports).
   * Used for incremental updates when a file changes.
   */
  deleteByFilePath(filePath: string): void {
    const deleteInboundEdges = this.db.prepare(
      `DELETE FROM edges WHERE target_id IN (
        SELECT id FROM symbols WHERE file_path = ?
      )`,
    );

    const transaction = this.db.transaction((fp: string) => {
      // Delete edges targeting symbols in this file (from other files)
      deleteInboundEdges.run(fp);
      // Delete edges originating from this file
      this.stmts.deleteEdgesByFile!.run(fp);
      // Delete symbols and imports
      this.stmts.deleteSymbolsByFile!.run(fp);
      this.stmts.deleteImportsByFile!.run(fp);
    });

    transaction(filePath);
  }

  // ===== Core Query: Graph Expansion via Recursive CTE =====

  /**
   * Expand from seed chunk IDs to find related chunks via graph traversal.
   *
   * Algorithm:
   * 1. Find all symbols in the seed chunks
   * 2. Use recursive CTE to traverse edges (bidirectional) up to maxDepth
   * 3. Collect unique chunk IDs of discovered symbols
   * 4. Return chunk IDs + traversal metadata
   *
   * The recursive CTE walks the edges table:
   * - Forward: source_id → target_id (outgoing edges)
   * - Backward: target_id → source_id (incoming edges, if bidirectional)
   *
   * @param seedChunkIds - Chunk IDs from reranker output
   * @param options - Expansion options
   * @returns Related chunk IDs and traversal metadata
   */
  expandFromChunks(
    seedChunkIds: string[],
    options?: GraphExpansionOptions,
  ): GraphExpansionResult {
    const maxDepth = options?.maxDepth ?? 2;
    const maxChunks = options?.maxChunks ?? 30;
    const bidirectional = options?.bidirectional ?? true;
    const edgeTypes = options?.edgeTypes;

    if (seedChunkIds.length === 0) {
      return {
        relatedChunkIds: [],
        symbols: [],
        edges: [],
        seedChunkIds: [],
      };
    }

    // Validate and build edge type filter clause (whitelist to prevent SQL injection)
    const VALID_EDGE_TYPES: Set<string> = new Set([
      'CALLS',
      'IMPORTS',
      'EXTENDS',
      'IMPLEMENTS',
      'CONTAINS',
    ]);
    const validEdgeTypes = edgeTypes?.filter((t) => VALID_EDGE_TYPES.has(t));
    const edgeTypeFilter =
      validEdgeTypes && validEdgeTypes.length > 0
        ? `AND e.type IN (${validEdgeTypes.map(() => '?').join(',')})`
        : '';
    const edgeTypeParams =
      validEdgeTypes && validEdgeTypes.length > 0 ? validEdgeTypes : [];

    // Build the placeholder string for seed chunk IDs
    const placeholders = seedChunkIds.map(() => '?').join(',');

    // Step 1: Find seed symbols (symbols in the seed chunks)
    const seedSymbolsQuery = `
      SELECT id, name, qualified_name, type, file_path, start_line, end_line,
             chunk_id, signature, exported
      FROM symbols
      WHERE chunk_id IN (${placeholders})
    `;
    const seedSymbolRows = this.db
      .prepare(seedSymbolsQuery)
      .all(...seedChunkIds) as SymbolRow[];

    if (seedSymbolRows.length === 0) {
      return {
        relatedChunkIds: [],
        symbols: [],
        edges: [],
        seedChunkIds,
      };
    }

    const seedSymbolIds = seedSymbolRows.map((r) => r.id);
    const seedPlaceholders = seedSymbolIds.map(() => '?').join(',');

    // Step 2: Recursive CTE to traverse graph
    // The CTE starts from seed symbols and expands outward via edges
    const cteQuery = bidirectional
      ? `
      WITH RECURSIVE traversal(symbol_id, depth) AS (
        -- Base case: seed symbols
        SELECT id, 0 FROM symbols WHERE id IN (${seedPlaceholders})

        UNION

        -- Recursive case: follow edges (forward)
        SELECT e.target_id, t.depth + 1
        FROM traversal t
        JOIN edges e ON e.source_id = t.symbol_id
        WHERE t.depth < ? ${edgeTypeFilter}

        UNION

        -- Recursive case: follow edges (backward)
        SELECT e.source_id, t.depth + 1
        FROM traversal t
        JOIN edges e ON e.target_id = t.symbol_id
        WHERE t.depth < ? ${edgeTypeFilter}
      )
      SELECT DISTINCT s.id, s.name, s.qualified_name, s.type, s.file_path,
             s.start_line, s.end_line, s.chunk_id, s.signature, s.exported,
             MIN(t.depth) as depth
      FROM traversal t
      JOIN symbols s ON s.id = t.symbol_id
      WHERE s.chunk_id IS NOT NULL
      GROUP BY s.id
      ORDER BY depth ASC
      LIMIT ?
    `
      : `
      WITH RECURSIVE traversal(symbol_id, depth) AS (
        -- Base case: seed symbols
        SELECT id, 0 FROM symbols WHERE id IN (${seedPlaceholders})

        UNION

        -- Recursive case: follow edges (forward only)
        SELECT e.target_id, t.depth + 1
        FROM traversal t
        JOIN edges e ON e.source_id = t.symbol_id
        WHERE t.depth < ? ${edgeTypeFilter}
      )
      SELECT DISTINCT s.id, s.name, s.qualified_name, s.type, s.file_path,
             s.start_line, s.end_line, s.chunk_id, s.signature, s.exported,
             MIN(t.depth) as depth
      FROM traversal t
      JOIN symbols s ON s.id = t.symbol_id
      WHERE s.chunk_id IS NOT NULL
      GROUP BY s.id
      ORDER BY depth ASC
      LIMIT ?
    `;

    // Build params (edge type params are injected for each WHERE clause that uses them)
    const cteParams = bidirectional
      ? [
          ...seedSymbolIds,
          maxDepth,
          ...edgeTypeParams,
          maxDepth,
          ...edgeTypeParams,
          maxChunks * 3,
        ]
      : [...seedSymbolIds, maxDepth, ...edgeTypeParams, maxChunks * 3];

    const discoveredRows = this.db.prepare(cteQuery).all(...cteParams) as Array<
      SymbolRow & { depth: number }
    >;

    // Step 3: Collect unique chunk IDs (excluding seed chunks)
    const seedChunkIdSet = new Set(seedChunkIds);
    const relatedChunkIds: string[] = [];
    const seenChunks = new Set<string>();

    for (const row of discoveredRows) {
      if (
        row.chunk_id &&
        !seedChunkIdSet.has(row.chunk_id) &&
        !seenChunks.has(row.chunk_id)
      ) {
        seenChunks.add(row.chunk_id);
        relatedChunkIds.push(row.chunk_id);
        if (relatedChunkIds.length >= maxChunks) break;
      }
    }

    // Step 4: Collect all symbols in the traversal
    const allSymbols = discoveredRows.map((r) => this.rowToSymbol(r));

    // Step 5: Collect edges between discovered symbols
    const allSymbolIds = discoveredRows.map((r) => r.id);
    const edges = this.getEdgesBetweenSymbols(allSymbolIds);

    return {
      relatedChunkIds,
      symbols: allSymbols,
      edges,
      seedChunkIds,
    };
  }

  // ===== Query Operations =====

  /**
   * Get symbols associated with specific chunk IDs.
   */
  getSymbolsByChunkIds(chunkIds: string[]): SymbolDefinition[] {
    if (chunkIds.length === 0) return [];

    const placeholders = chunkIds.map(() => '?').join(',');
    const query = `
      SELECT id, name, qualified_name, type, file_path, start_line, end_line,
             chunk_id, signature, exported
      FROM symbols
      WHERE chunk_id IN (${placeholders})
    `;

    const rows = this.db.prepare(query).all(...chunkIds) as SymbolRow[];
    return rows.map((r) => this.rowToSymbol(r));
  }

  /**
   * Get edges between a set of symbols.
   */
  getEdgesBetweenSymbols(symbolIds: string[]): SymbolEdge[] {
    if (symbolIds.length === 0) return [];

    const placeholders = symbolIds.map(() => '?').join(',');
    const query = `
      SELECT source_id, target_id, type, file_path, line
      FROM edges
      WHERE source_id IN (${placeholders})
        AND target_id IN (${placeholders})
    `;

    // Need to pass symbolIds twice (for source_id and target_id IN clauses)
    const rows = this.db
      .prepare(query)
      .all(...symbolIds, ...symbolIds) as EdgeRow[];

    return rows.map((r) => ({
      sourceId: r.source_id,
      targetId: r.target_id,
      type: r.type as EdgeType,
      filePath: r.file_path,
      line: r.line ?? undefined,
    }));
  }

  /**
   * Get symbols by file path.
   */
  getSymbolsByFilePath(filePath: string): SymbolDefinition[] {
    const query = `
      SELECT id, name, qualified_name, type, file_path, start_line, end_line,
             chunk_id, signature, exported
      FROM symbols
      WHERE file_path = ?
    `;

    const rows = this.db.prepare(query).all(filePath) as SymbolRow[];
    return rows.map((r) => this.rowToSymbol(r));
  }

  /**
   * Get all edges originating from a file.
   */
  getEdgesByFilePath(filePath: string): SymbolEdge[] {
    const query = `
      SELECT source_id, target_id, type, file_path, line
      FROM edges
      WHERE file_path = ?
    `;

    const rows = this.db.prepare(query).all(filePath) as EdgeRow[];
    return rows.map((r) => ({
      sourceId: r.source_id,
      targetId: r.target_id,
      type: r.type as EdgeType,
      filePath: r.file_path,
      line: r.line ?? undefined,
    }));
  }

  /**
   * Get import mappings for a file.
   */
  getImportsByFilePath(filePath: string): ImportMapping[] {
    const query = `
      SELECT file_path, local_name, source_module, original_name, resolved_path
      FROM imports
      WHERE file_path = ?
    `;

    const rows = this.db.prepare(query).all(filePath) as ImportRow[];
    return rows.map((r) => ({
      filePath: r.file_path,
      localName: r.local_name,
      sourceModule: r.source_module,
      originalName: r.original_name,
      resolvedPath: r.resolved_path ?? undefined,
    }));
  }

  /**
   * Update chunk_id mappings for symbols.
   * Called after chunking to map symbols to their containing chunks.
   *
   * @param filePath - File to update mappings for.
   * @param chunkRanges - Array of { chunkId, startLine, endLine }.
   */
  updateChunkMappings(
    filePath: string,
    chunkRanges: Array<{ chunkId: string; startLine: number; endLine: number }>,
  ): void {
    if (chunkRanges.length === 0) return;

    const updateStmt = this.db.prepare(
      'UPDATE symbols SET chunk_id = ? WHERE id = ?',
    );

    const symbols = this.getSymbolsByFilePath(filePath);

    const transaction = this.db.transaction(() => {
      for (const sym of symbols) {
        // Find the chunk that best contains this symbol
        // (symbol's start line is within the chunk)
        const containingChunk = chunkRanges.find(
          (c) => sym.startLine >= c.startLine && sym.startLine <= c.endLine,
        );

        if (containingChunk) {
          updateStmt.run(containingChunk.chunkId, sym.id);
        }
      }
    });

    transaction();
  }

  // ===== Statistics =====

  // ===== Cross-File Resolution =====

  /**
   * Batch-resolve deferred cross-file edges after all files are indexed.
   *
   * During per-file extraction, cross-file references are stored with
   * placeholder target IDs like `?#symbolName`. This method resolves them
   * by matching names globally against the symbols table.
   *
   * Resolution priority:
   * 1. Import-guided: if the source file has an import whose resolved_path
   *    matches a candidate symbol's file_path, prefer that symbol
   * 2. Exported symbols: prefer exported over internal symbols
   * 3. First match: if multiple candidates remain, pick the first one
   *
   * Unresolvable edges (no matching symbol anywhere) are removed.
   *
   * Placeholder formats:
   *   `?#name`              — direct call: match symbol by name globally
   *   `?sourceModule#name`  — member call: restrict to files imported via sourceModule
   *
   * @returns Number of edges successfully resolved.
   */
  resolveEdgesByName(): number {
    // Fetch all unresolved edges (target_id contains '?...#')
    const unresolvedEdges = this.db
      .prepare(
        `SELECT id, source_id, target_id, type, file_path
       FROM edges WHERE target_id LIKE '?%#%'`,
      )
      .all() as Array<{
      id: number;
      source_id: string;
      target_id: string;
      type: string;
      file_path: string;
    }>;

    if (unresolvedEdges.length === 0) return 0;

    const updateStmt = this.db.prepare(
      'UPDATE edges SET target_id = ? WHERE id = ?',
    );
    const deleteStmt = this.db.prepare('DELETE FROM edges WHERE id = ?');

    // Pre-compiled query for finding candidate symbols by name (global)
    const findCandidatesStmt = this.db.prepare(
      `SELECT id, file_path, exported FROM symbols
       WHERE name = ? AND file_path != ?
       ORDER BY exported DESC`,
    );

    // Pre-compiled query for import-guided disambiguation (direct calls)
    const findImportHintStmt = this.db.prepare(
      `SELECT resolved_path FROM imports
       WHERE file_path = ? AND local_name = ? AND resolved_path IS NOT NULL
       LIMIT 1`,
    );

    // Pre-compiled query for module-scoped resolution (member calls).
    // Find files that import from a given source_module, then look for
    // symbols in the resolved_path of those imports.
    const findModuleScopedCandidatesStmt = this.db.prepare(
      `SELECT DISTINCT s.id, s.file_path, s.exported
       FROM symbols s
       INNER JOIN imports i ON s.file_path = i.resolved_path
       WHERE s.name = ?
         AND i.source_module = ?
         AND i.resolved_path IS NOT NULL
       ORDER BY s.exported DESC`,
    );

    // Fallback for module-scoped: when no resolved_path exists in imports
    // (non-relative imports), find the file whose import source_module matches
    // and that file also defines the symbol.
    // This handles: file A imports from 'foo', file B also imports from 'foo'
    // → look at what files are reachable from ANY import of 'foo'.
    const findModuleScopedBySourceStmt = this.db.prepare(
      `SELECT DISTINCT s.id, s.file_path, s.exported
       FROM symbols s
       WHERE s.name = ?
         AND s.file_path IN (
           SELECT DISTINCT i2.resolved_path FROM imports i2
           WHERE i2.source_module = ? AND i2.resolved_path IS NOT NULL
         )
       ORDER BY s.exported DESC`,
    );

    let resolved = 0;
    let removed = 0;

    const transaction = this.db.transaction(() => {
      for (const edge of unresolvedEdges) {
        const hashIdx = edge.target_id.indexOf('#');
        const sourceModule = edge.target_id.substring(1, hashIdx); // between '?' and '#'
        const refName = edge.target_id.substring(hashIdx + 1); // after '#'

        if (sourceModule === '') {
          // === Direct call: ?#name — global name matching ===
          this.resolveDirectPlaceholder(
            edge,
            refName,
            findCandidatesStmt,
            findImportHintStmt,
            updateStmt,
            deleteStmt,
          )
            ? resolved++
            : removed++;
        } else {
          // === Member call: ?sourceModule#name — module-scoped matching ===
          this.resolveModuleScopedPlaceholder(
            edge,
            refName,
            sourceModule,
            findModuleScopedCandidatesStmt,
            findModuleScopedBySourceStmt,
            findCandidatesStmt,
            updateStmt,
            deleteStmt,
          )
            ? resolved++
            : removed++;
        }
      }
    });

    transaction();
    return resolved;
  }

  /**
   * Resolve a direct-call placeholder `?#name`.
   * Uses global name matching with import-guided disambiguation.
   * @returns true if resolved, false if removed.
   */
  private resolveDirectPlaceholder(
    edge: { id: number; file_path: string },
    refName: string,
    findCandidatesStmt: Database.Statement,
    findImportHintStmt: Database.Statement,
    updateStmt: Database.Statement,
    deleteStmt: Database.Statement,
  ): boolean {
    const candidates = findCandidatesStmt.all(
      refName,
      edge.file_path,
    ) as Array<{ id: string; file_path: string; exported: number }>;

    if (candidates.length === 0) {
      deleteStmt.run(edge.id);
      return false;
    }

    if (candidates.length === 1) {
      updateStmt.run(candidates[0]!.id, edge.id);
      return true;
    }

    // Multiple candidates → try import-guided disambiguation
    const importHint = findImportHintStmt.get(edge.file_path, refName) as
      | { resolved_path: string }
      | undefined;

    if (importHint?.resolved_path) {
      const importMatch = candidates.find(
        (c) => c.file_path === importHint.resolved_path,
      );
      if (importMatch) {
        updateStmt.run(importMatch.id, edge.id);
        return true;
      }
    }

    // Fall back: prefer first exported symbol
    updateStmt.run(candidates[0]!.id, edge.id);
    return true;
  }

  /**
   * Resolve a module-scoped placeholder `?sourceModule#name`.
   * Restricts candidate search to symbols in files reachable via the given
   * sourceModule in the imports table. Falls back to global matching if
   * no module-scoped candidates found.
   * @returns true if resolved, false if removed.
   */
  private resolveModuleScopedPlaceholder(
    edge: { id: number; file_path: string },
    refName: string,
    sourceModule: string,
    findModuleScopedCandidatesStmt: Database.Statement,
    findModuleScopedBySourceStmt: Database.Statement,
    findCandidatesGlobalStmt: Database.Statement,
    updateStmt: Database.Statement,
    deleteStmt: Database.Statement,
  ): boolean {
    // Strategy 1: Find symbols in files that are resolved targets of
    // imports with matching source_module.
    let candidates = findModuleScopedCandidatesStmt.all(
      refName,
      sourceModule,
    ) as Array<{ id: string; file_path: string; exported: number }>;

    // Strategy 2: If strategy 1 found nothing (e.g. imports have no
    // resolved_path for this module), try the broader source_module query.
    if (candidates.length === 0) {
      candidates = findModuleScopedBySourceStmt.all(
        refName,
        sourceModule,
      ) as Array<{ id: string; file_path: string; exported: number }>;
    }

    if (candidates.length > 0) {
      // Prefer exported, then first match
      updateStmt.run(candidates[0]!.id, edge.id);
      return true;
    }

    // No module-scoped match → the symbol is likely from an external
    // package that wasn't indexed. Remove the dangling edge.
    deleteStmt.run(edge.id);
    return false;
  }

  // ===== Statistics =====

  /**
   * Get graph statistics.
   */
  getStats(): { symbolCount: number; edgeCount: number; importCount: number } {
    const symbolCount = (
      this.db.prepare('SELECT COUNT(*) as count FROM symbols').get() as {
        count: number;
      }
    ).count;
    const edgeCount = (
      this.db.prepare('SELECT COUNT(*) as count FROM edges').get() as {
        count: number;
      }
    ).count;
    const importCount = (
      this.db.prepare('SELECT COUNT(*) as count FROM imports').get() as {
        count: number;
      }
    ).count;

    return { symbolCount, edgeCount, importCount };
  }

  /**
   * Get detailed stats breakdown by type.
   */
  getDetailedStats(): {
    symbolsByType: Record<string, number>;
    edgesByType: Record<string, number>;
    fileCount: number;
  } {
    const symbolsByType: Record<string, number> = {};
    const symbolTypeRows = this.db
      .prepare('SELECT type, COUNT(*) as count FROM symbols GROUP BY type')
      .all() as Array<{ type: string; count: number }>;
    for (const row of symbolTypeRows) {
      symbolsByType[row.type] = row.count;
    }

    const edgesByType: Record<string, number> = {};
    const edgeTypeRows = this.db
      .prepare('SELECT type, COUNT(*) as count FROM edges GROUP BY type')
      .all() as Array<{ type: string; count: number }>;
    for (const row of edgeTypeRows) {
      edgesByType[row.type] = row.count;
    }

    const fileCount = (
      this.db
        .prepare('SELECT COUNT(DISTINCT file_path) as count FROM symbols')
        .get() as { count: number }
    ).count;

    return { symbolsByType, edgesByType, fileCount };
  }

  // ===== Lifecycle =====

  /**
   * Close the database connection.
   */
  close(): void {
    try {
      this.db.close();
    } catch {
      // Ignore close errors
    }
  }

  // ===== Private Helpers =====

  /**
   * Convert a database row to a SymbolDefinition.
   */
  private rowToSymbol(row: SymbolRow): SymbolDefinition {
    return {
      id: row.id,
      name: row.name,
      qualifiedName: row.qualified_name,
      type: row.type as SymbolType,
      filePath: row.file_path,
      startLine: row.start_line,
      endLine: row.end_line,
      chunkId: row.chunk_id ?? undefined,
      signature: row.signature ?? undefined,
      exported: row.exported === 1,
    };
  }
}

// ===== Row Types =====

interface SymbolRow {
  id: string;
  name: string;
  qualified_name: string;
  type: string;
  file_path: string;
  start_line: number;
  end_line: number;
  chunk_id: string | null;
  signature: string | null;
  exported: number;
}

interface EdgeRow {
  source_id: string;
  target_id: string;
  type: string;
  file_path: string;
  line: number | null;
}

interface ImportRow {
  file_path: string;
  local_name: string;
  source_module: string;
  original_name: string;
  resolved_path: string | null;
}
