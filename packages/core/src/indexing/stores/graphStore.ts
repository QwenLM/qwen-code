/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { GraphDatabase } from '@ruvector/graph-node';
import type { JsDistanceMetric, JsQueryResult } from '@ruvector/graph-node';

import { Storage } from '../../config/storage.js';
import type {
  GraphEntity,
  GraphRelation,
  IGraphStore,
  RelationType,
} from '../types.js';

/** Distance metric constant for cosine similarity */
const COSINE_METRIC = 'Cosine' as JsDistanceMetric;

/**
 * Gets the graph store directory path for a project.
 * @param projectHash SHA-256 hash of the project root path.
 * @returns Absolute path to the graph store directory.
 */
export function getGraphStoreDir(projectHash: string): string {
  return path.join(Storage.getGlobalQwenDir(), 'index', projectHash, 'graph');
}

/**
 * RuVector Graph-based storage for code dependency relationships.
 * Stores entities (functions, classes, modules) and their relationships
 * for multi-hop graph traversal during retrieval.
 */
export class GraphStore implements IGraphStore {
  private db: GraphDatabase | null = null;
  private readonly dbDir: string;
  private readonly dbPath: string;

  /**
   * Creates a new GraphStore instance.
   * @param projectHash SHA-256 hash of the project root path.
   */
  constructor(projectHash: string) {
    this.dbDir = getGraphStoreDir(projectHash);
    this.dbPath = path.join(this.dbDir, 'graph.db');
  }

  /**
   * Initializes the graph database.
   */
  async initialize(): Promise<void> {
    // Ensure directory exists
    if (!fs.existsSync(this.dbDir)) {
      fs.mkdirSync(this.dbDir, { recursive: true });
    }

    // Check if database already exists
    const dbExists = fs.existsSync(this.dbPath);

    if (dbExists) {
      // Open existing database
      try {
        this.db = GraphDatabase.open(this.dbPath);
      } catch {
        // If open fails, recreate
        await this.recreateDatabase();
      }
    } else {
      // Create new database
      this.db = new GraphDatabase({
        distanceMetric: COSINE_METRIC,
        dimensions: 1, // We don't use embeddings in graph store, minimal dimension
        storagePath: this.dbPath,
      });
    }
  }

  /**
   * Recreates the database by deleting and creating anew.
   */
  private async recreateDatabase(): Promise<void> {
    // Remove existing database file
    if (fs.existsSync(this.dbPath)) {
      fs.rmSync(this.dbPath, { force: true });
    }

    // Create new database
    this.db = new GraphDatabase({
      distanceMetric: COSINE_METRIC,
      dimensions: 1,
      storagePath: this.dbPath,
    });
  }

  /**
   * Inserts entities as graph nodes.
   * @param entities Array of graph entities to insert.
   */
  async insertEntities(entities: GraphEntity[]): Promise<void> {
    if (!this.db) {
      throw new Error('GraphStore not initialized');
    }

    for (const entity of entities) {
      try {
        this.db.createNode({
          id: entity.id,
          // Use a minimal placeholder embedding since we don't use vector search on entities
          embedding: new Float32Array([0]),
          labels: [entity.type],
          properties: {
            name: entity.name,
            type: entity.type,
            filePath: entity.filePath,
            startLine: String(entity.startLine),
            endLine: String(entity.endLine),
            signature: entity.signature ?? '',
            docstring: entity.docstring ?? '',
            chunkId: entity.chunkId ?? '',
          },
        });
      } catch {
        // Node might already exist, skip
      }
    }
  }

  /**
   * Inserts relations as graph edges.
   * Creates placeholder nodes for targets that don't exist.
   * @param relations Array of graph relations to insert.
   */
  async insertRelations(relations: GraphRelation[]): Promise<void> {
    if (!this.db) {
      throw new Error('GraphStore not initialized');
    }

    for (const relation of relations) {
      try {
        // Ensure target node exists before creating edge
        // This handles cases like external imports, unresolved function calls, etc.
        await this.ensureNodeExists(relation.targetId);

        await this.db.createEdge({
          from: relation.sourceId,
          to: relation.targetId,
          description: relation.type,
          // Use minimal placeholder embedding
          embedding: new Float32Array([0]),
          confidence: 1.0,
        });
      } catch (error) {
        // Edge creation may still fail for other reasons, log in debug mode
        if (process.env['DEBUG_GRAPH']) {
          console.warn(
            `Failed to create edge ${relation.sourceId} -> ${relation.targetId}: ${error}`,
          );
        }
      }
    }
  }

  /**
   * Ensures a node exists in the graph, creating a placeholder if needed.
   * @param nodeId The node ID to check/create.
   */
  private async ensureNodeExists(nodeId: string): Promise<void> {
    if (!this.db) return;

    try {
      // Try to query the node - if it exists, we're done
      const result: JsQueryResult = await this.db.query(`
        MATCH (n)
        WHERE n.id = '${this.escapeValue(nodeId)}'
        RETURN n
        LIMIT 1
      `);

      if (result.nodes.length > 0) {
        return; // Node exists
      }
    } catch {
      // Query failed, node likely doesn't exist
    }

    // Create placeholder node
    try {
      this.db.createNode({
        id: nodeId,
        embedding: new Float32Array([0]),
        labels: ['external'],
        properties: {
          name: nodeId.split('/').pop() || nodeId,
          type: 'external',
          filePath: nodeId,
          startLine: '0',
          endLine: '0',
          signature: '',
          docstring: '',
          chunkId: '',
        },
      });
    } catch {
      // Node creation might fail if it already exists (race condition), that's OK
    }
  }

  /**
   * Gets entity IDs that are associated with the given chunk IDs.
   * @param chunkIds Array of chunk IDs.
   * @returns Array of entity IDs.
   */
  async getEntitiesByChunkIds(chunkIds: string[]): Promise<string[]> {
    if (!this.db) {
      throw new Error('GraphStore not initialized');
    }

    const entityIds: string[] = [];

    for (const chunkId of chunkIds) {
      try {
        // Query for entities with this chunkId
        const result: JsQueryResult = await this.db.query(`
          MATCH (e)
          WHERE e.chunkId = '${this.escapeValue(chunkId)}'
          RETURN e
        `);

        for (const node of result.nodes) {
          entityIds.push(node.id);
        }
      } catch {
        // Query might fail, continue
      }
    }

    return entityIds;
  }

  /**
   * Executes a Cypher query against the graph database.
   * @param cypher Cypher query string.
   * @param params Query parameters (optional, may not be fully supported).
   * @returns Query results as array of nodes.
   */
  async query(
    cypher: string,
    params?: Record<string, unknown>,
  ): Promise<unknown[]> {
    if (!this.db) {
      throw new Error('GraphStore not initialized');
    }

    // Substitute parameters into the query (basic implementation)
    let processedQuery = cypher;
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (Array.isArray(value)) {
          const escapedArray = value
            .map((v) =>
              typeof v === 'string' ? `'${this.escapeValue(v)}'` : String(v),
            )
            .join(', ');
          processedQuery = processedQuery.replace(
            new RegExp(`\\$${key}`, 'g'),
            `[${escapedArray}]`,
          );
        } else if (typeof value === 'string') {
          processedQuery = processedQuery.replace(
            new RegExp(`\\$${key}`, 'g'),
            `'${this.escapeValue(value)}'`,
          );
        } else {
          processedQuery = processedQuery.replace(
            new RegExp(`\\$${key}`, 'g'),
            String(value),
          );
        }
      }
    }

    try {
      const result: JsQueryResult = await this.db.query(processedQuery);
      // Return nodes as the result array
      return result.nodes.map((node) => ({
        id: node.id,
        labels: node.labels,
        properties: node.properties,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Deletes all entities and relations for a file.
   * First deletes edges connected to entities, then deletes the entities themselves.
   * @param filePath File path to delete entities for.
   */
  async deleteByFilePath(filePath: string): Promise<void> {
    if (!this.db) {
      throw new Error('GraphStore not initialized');
    }

    try {
      // First, find all entity IDs for this file
      const result: JsQueryResult = await this.db.query(`
        MATCH (e)
        WHERE e.filePath = '${this.escapeValue(filePath)}'
        RETURN e
      `);

      const entityIds = result.nodes.map((node) => node.id);

      if (entityIds.length === 0) {
        return;
      }

      // Try DETACH DELETE first (Neo4j-compatible syntax)
      // If not supported, fall back to manual edge + node deletion
      for (const entityId of entityIds) {
        try {
          // Attempt DETACH DELETE (deletes node and all connected edges)
          await this.db.query(`
            MATCH (e)
            WHERE e.id = '${this.escapeValue(entityId)}'
            DETACH DELETE e
          `);
        } catch {
          // DETACH DELETE not supported, try manual deletion
          try {
            // First delete all edges connected to this node
            await this.db.query(`
              MATCH (e)-[r]-()
              WHERE e.id = '${this.escapeValue(entityId)}'
              DELETE r
            `);
            // Then delete the node itself
            await this.db.query(`
              MATCH (e)
              WHERE e.id = '${this.escapeValue(entityId)}'
              DELETE e
            `);
          } catch {
            // If Cypher DELETE not supported, try using deleteNode API if available
            // RuVector may require direct API calls for deletion
            console.warn(`Failed to delete entity ${entityId}, skipping`);
          }
        }
      }
    } catch (error) {
      console.warn(`Failed to delete entities for file ${filePath}:`, error);
    }
  }

  /**
   * Escapes a string value for use in Cypher queries.
   * @param value Value to escape.
   * @returns Escaped value.
   */
  private escapeValue(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  /**
   * Gets statistics about the graph.
   * @returns Node and edge counts.
   */
  async getStats(): Promise<{ nodeCount: number; edgeCount: number }> {
    if (!this.db) {
      throw new Error('GraphStore not initialized');
    }

    try {
      const stats = await this.db.stats();
      return {
        nodeCount: stats?.totalNodes ?? 0,
        edgeCount: stats?.totalEdges ?? 0,
      };
    } catch {
      return { nodeCount: 0, edgeCount: 0 };
    }
  }

  /**
   * Finds entities by type within a file.
   * @param filePath File path.
   * @param entityType Entity type to filter by.
   * @returns Array of matching entities.
   */
  async getEntitiesByFile(
    filePath: string,
    entityType?: string,
  ): Promise<GraphEntity[]> {
    if (!this.db) {
      throw new Error('GraphStore not initialized');
    }

    const typeFilter = entityType ? `AND e.type = '${entityType}'` : '';

    try {
      const result: JsQueryResult = await this.db.query(`
        MATCH (e)
        WHERE e.filePath = '${this.escapeValue(filePath)}' ${typeFilter}
        RETURN e
      `);

      return result.nodes.map((node) => ({
        id: node.id,
        name: node.properties['name'] ?? '',
        type: (node.properties['type'] as GraphEntity['type']) ?? 'module',
        filePath: node.properties['filePath'] ?? '',
        startLine: parseInt(node.properties['startLine'] ?? '0', 10),
        endLine: parseInt(node.properties['endLine'] ?? '0', 10),
        signature: node.properties['signature'] || undefined,
        docstring: node.properties['docstring'] || undefined,
        chunkId: node.properties['chunkId'] || undefined,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Gets outgoing relations from an entity.
   * @param entityId Source entity ID.
   * @param relationType Optional relation type filter.
   * @returns Array of outgoing relations.
   */
  async getOutgoingRelations(
    entityId: string,
    relationType?: RelationType,
  ): Promise<GraphRelation[]> {
    if (!this.db) {
      throw new Error('GraphStore not initialized');
    }

    const typeFilter = relationType ? `:${relationType}` : '';

    try {
      const result: JsQueryResult = await this.db.query(`
        MATCH (a {id: '${this.escapeValue(entityId)}'})-[r${typeFilter}]->(b)
        RETURN r, b
      `);

      return result.edges.map((edge) => ({
        sourceId: entityId,
        targetId: edge.to,
        type: (edge.edgeType as RelationType) ?? 'CALLS',
      }));
    } catch {
      return [];
    }
  }

  /**
   * Closes the database connection.
   */
  async close(): Promise<void> {
    // RuVector GraphDatabase might not have an explicit close method
    // Clear the reference
    this.db = null;
  }
}
