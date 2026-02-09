/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Graph traversal service for extracting relevant subgraphs.
 * Uses multi-hop BFS to find related entities from seed chunks,
 * enabling cross-file dependency tracking for retrieval augmentation.
 */

import type {
  GraphEntity,
  GraphRelation,
  GraphSubgraph,
  IGraphStore,
  RelationType,
} from './types.js';

/**
 * Configuration for graph traversal operations.
 */
export interface GraphTraverserConfig {
  /** Maximum traversal depth (number of hops). Default: 2. */
  maxDepth: number;
  /** Maximum nodes to include in subgraph. Default: 50. */
  maxNodes: number;
  /** Relation types to follow during traversal. */
  relationTypes: RelationType[];
  /** Traversal direction. Default: 'both'. */
  direction: 'outgoing' | 'incoming' | 'both';
}

/**
 * Default configuration for GraphTraverser.
 */
export const DEFAULT_GRAPH_TRAVERSER_CONFIG: GraphTraverserConfig = {
  maxDepth: 2,
  maxNodes: 50,
  relationTypes: ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS'],
  direction: 'both',
};

/**
 * Options for subgraph extraction.
 */
export interface ExtractSubgraphOptions {
  /** Maximum traversal depth. */
  maxDepth?: number;
  /** Maximum nodes to include. */
  maxNodes?: number;
  /** Relation types to traverse. */
  relationTypes?: RelationType[];
  /** Traversal direction. */
  direction?: 'outgoing' | 'incoming' | 'both';
}

/**
 * Graph traversal service for extracting relevant subgraphs
 * from the code dependency graph. Used to expand retrieval
 * results with related entities (callers, callees, imports, etc.).
 */
export class GraphTraverser {
  private readonly config: GraphTraverserConfig;

  /**
   * Creates a new GraphTraverser instance.
   * @param graphStore The graph store to traverse.
   * @param config Optional configuration overrides.
   */
  constructor(
    private readonly graphStore: IGraphStore,
    config: Partial<GraphTraverserConfig> = {},
  ) {
    this.config = { ...DEFAULT_GRAPH_TRAVERSER_CONFIG, ...config };
  }

  /**
   * Extracts a minimal complete subgraph starting from seed entities.
   * Uses BFS to traverse the graph up to maxDepth hops, collecting
   * all visited entities and their relationships.
   *
   * @param seedChunkIds Chunk IDs from initial retrieval results.
   * @param options Traversal options.
   * @returns Subgraph containing related entities and relations.
   */
  async extractSubgraph(
    seedChunkIds: string[],
    options: ExtractSubgraphOptions = {},
  ): Promise<GraphSubgraph> {
    const {
      maxDepth = this.config.maxDepth,
      maxNodes = this.config.maxNodes,
      relationTypes = this.config.relationTypes,
      direction = this.config.direction,
    } = options;

    // Empty input check
    if (seedChunkIds.length === 0) {
      return { entities: [], relations: [], seedIds: [], depth: 0 };
    }

    // Get entity IDs associated with the seed chunks
    const seedEntityIds =
      await this.graphStore.getEntitiesByChunkIds(seedChunkIds);

    if (seedEntityIds.length === 0) {
      return { entities: [], relations: [], seedIds: [], depth: 0 };
    }

    // BFS traversal
    const visitedEntities = new Map<string, GraphEntity>();
    const collectedRelations: GraphRelation[] = [];
    const relationSet = new Set<string>(); // For deduplication

    // Initialize queue with seed entities at depth 0
    const queue: Array<{ entityId: string; depth: number }> = seedEntityIds.map(
      (id) => ({ entityId: id, depth: 0 }),
    );
    const visited = new Set<string>(seedEntityIds);

    // Get seed entities' full data
    await this.loadEntities(seedEntityIds, visitedEntities);

    // BFS traversal
    while (queue.length > 0 && visitedEntities.size < maxNodes) {
      const { entityId, depth } = queue.shift()!;

      // Stop if max depth reached
      if (depth >= maxDepth) {
        continue;
      }

      // Get relations for current entity
      const relations = await this.getRelationsForEntity(
        entityId,
        relationTypes,
        direction,
      );

      for (const relation of relations) {
        // Add relation to collection (deduplicated)
        const relKey = `${relation.sourceId}:${relation.type}:${relation.targetId}`;
        if (!relationSet.has(relKey)) {
          relationSet.add(relKey);
          collectedRelations.push(relation);
        }

        // Determine the neighbor entity ID
        const neighborId =
          relation.sourceId === entityId
            ? relation.targetId
            : relation.sourceId;

        // Add unvisited neighbors to queue
        if (!visited.has(neighborId) && visitedEntities.size < maxNodes) {
          visited.add(neighborId);
          queue.push({ entityId: neighborId, depth: depth + 1 });

          // Load the neighbor entity
          await this.loadEntities([neighborId], visitedEntities);
        }
      }
    }

    return {
      entities: Array.from(visitedEntities.values()),
      relations: collectedRelations,
      seedIds: seedEntityIds,
      depth: maxDepth,
    };
  }

  /**
   * Finds the shortest path between two entities.
   * Uses BFS to find the minimum number of hops.
   *
   * @param sourceId Source entity ID.
   * @param targetId Target entity ID.
   * @param maxDepth Maximum search depth.
   * @returns Array of relations forming the path, or empty if no path found.
   */
  async findPath(
    sourceId: string,
    targetId: string,
    maxDepth: number = 5,
  ): Promise<GraphRelation[]> {
    if (sourceId === targetId) {
      return [];
    }

    // BFS with path tracking
    const queue: Array<{
      entityId: string;
      path: GraphRelation[];
    }> = [{ entityId: sourceId, path: [] }];
    const visited = new Set<string>([sourceId]);

    while (queue.length > 0) {
      const { entityId, path } = queue.shift()!;

      // Stop if max depth reached
      if (path.length >= maxDepth) {
        continue;
      }

      // Get all relations for current entity
      const relations = await this.getRelationsForEntity(
        entityId,
        this.config.relationTypes,
        'both',
      );

      for (const relation of relations) {
        const neighborId =
          relation.sourceId === entityId
            ? relation.targetId
            : relation.sourceId;

        // Found target
        if (neighborId === targetId) {
          return [...path, relation];
        }

        // Add unvisited neighbors to queue
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          queue.push({
            entityId: neighborId,
            path: [...path, relation],
          });
        }
      }
    }

    // No path found
    return [];
  }

  /**
   * Gets the immediate neighbors of an entity.
   *
   * @param entityId Entity ID to get neighbors for.
   * @param relationTypes Types of relations to follow.
   * @param direction Direction of traversal.
   * @returns Array of neighbor entity IDs with their relation types.
   */
  async getNeighbors(
    entityId: string,
    relationTypes: RelationType[] = this.config.relationTypes,
    direction: 'outgoing' | 'incoming' | 'both' = 'both',
  ): Promise<Array<{ entityId: string; relationType: RelationType }>> {
    const relations = await this.getRelationsForEntity(
      entityId,
      relationTypes,
      direction,
    );

    return relations.map((rel) => ({
      entityId: rel.sourceId === entityId ? rel.targetId : rel.sourceId,
      relationType: rel.type,
    }));
  }

  /**
   * Gets all callers of a function or method.
   *
   * @param entityId Function or method entity ID.
   * @returns Array of caller entity IDs.
   */
  async getCallers(entityId: string): Promise<string[]> {
    const relations = await this.getRelationsForEntity(
      entityId,
      ['CALLS'],
      'incoming',
    );
    return relations.map((rel) => rel.sourceId);
  }

  /**
   * Gets all callees of a function or method.
   *
   * @param entityId Function or method entity ID.
   * @returns Array of callee entity IDs.
   */
  async getCallees(entityId: string): Promise<string[]> {
    const relations = await this.getRelationsForEntity(
      entityId,
      ['CALLS'],
      'outgoing',
    );
    return relations.map((rel) => rel.targetId);
  }

  /**
   * Gets all imports of a module.
   *
   * @param moduleId Module entity ID.
   * @returns Array of imported module entity IDs.
   */
  async getImports(moduleId: string): Promise<string[]> {
    const relations = await this.getRelationsForEntity(
      moduleId,
      ['IMPORTS'],
      'outgoing',
    );
    return relations.map((rel) => rel.targetId);
  }

  /**
   * Gets all modules that import a given module.
   *
   * @param moduleId Module entity ID.
   * @returns Array of importer module entity IDs.
   */
  async getImporters(moduleId: string): Promise<string[]> {
    const relations = await this.getRelationsForEntity(
      moduleId,
      ['IMPORTS'],
      'incoming',
    );
    return relations.map((rel) => rel.sourceId);
  }

  /**
   * Gets the inheritance hierarchy for a class.
   *
   * @param classId Class entity ID.
   * @param direction 'ancestors' for parent classes, 'descendants' for child classes.
   * @returns Array of class entity IDs in the hierarchy.
   */
  async getInheritanceHierarchy(
    classId: string,
    direction: 'ancestors' | 'descendants' = 'ancestors',
  ): Promise<string[]> {
    const relDirection = direction === 'ancestors' ? 'outgoing' : 'incoming';
    const result: string[] = [];
    const visited = new Set<string>([classId]);
    const queue = [classId];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const relations = await this.getRelationsForEntity(
        currentId,
        ['EXTENDS'],
        relDirection,
      );

      for (const rel of relations) {
        const relatedId =
          direction === 'ancestors' ? rel.targetId : rel.sourceId;
        if (!visited.has(relatedId)) {
          visited.add(relatedId);
          result.push(relatedId);
          queue.push(relatedId);
        }
      }
    }

    return result;
  }

  /**
   * Loads entity data from the graph store.
   */
  private async loadEntities(
    entityIds: string[],
    targetMap: Map<string, GraphEntity>,
  ): Promise<void> {
    for (const id of entityIds) {
      if (targetMap.has(id)) continue;

      try {
        // Query the entity from the graph store
        const results = await this.graphStore.query(
          `MATCH (e) WHERE e.id = '${this.escapeValue(id)}' RETURN e LIMIT 1`,
        );

        if (results.length > 0) {
          const node = results[0] as {
            id: string;
            labels?: string[];
            properties?: Record<string, string>;
          };
          const entity: GraphEntity = {
            id: node.id,
            name: node.properties?.['name'] ?? id.split('#').pop() ?? id,
            type:
              (node.properties?.['type'] as GraphEntity['type']) ?? 'module',
            filePath: node.properties?.['filePath'] ?? '',
            startLine: parseInt(node.properties?.['startLine'] ?? '0', 10),
            endLine: parseInt(node.properties?.['endLine'] ?? '0', 10),
            signature: node.properties?.['signature'] || undefined,
            docstring: node.properties?.['docstring'] || undefined,
            chunkId: node.properties?.['chunkId'] || undefined,
          };
          targetMap.set(id, entity);
        }
      } catch {
        // Entity not found, create a placeholder
        targetMap.set(id, {
          id,
          name: id.split('#').pop() ?? id,
          type: 'module',
          filePath: id,
          startLine: 0,
          endLine: 0,
        });
      }
    }
  }

  /**
   * Gets relations for an entity based on direction.
   */
  private async getRelationsForEntity(
    entityId: string,
    relationTypes: RelationType[],
    direction: 'outgoing' | 'incoming' | 'both',
  ): Promise<GraphRelation[]> {
    const relations: GraphRelation[] = [];
    const escapedId = this.escapeValue(entityId);
    const typeFilter = relationTypes
      .map((t) => `r.description = '${t}'`)
      .join(' OR ');

    try {
      if (direction === 'outgoing' || direction === 'both') {
        // Query outgoing relations
        const outgoingQuery = `
          MATCH (a)-[r]->(b)
          WHERE a.id = '${escapedId}'${typeFilter ? ` AND (${typeFilter})` : ''}
          RETURN r, b
        `;
        const outResults = await this.graphStore.query(outgoingQuery);
        for (const result of outResults) {
          const r = result as {
            from?: string;
            to?: string;
            description?: string;
          };
          if (r.from && r.to) {
            relations.push({
              sourceId: r.from,
              targetId: r.to,
              type: (r.description as RelationType) ?? 'CALLS',
            });
          }
        }
      }

      if (direction === 'incoming' || direction === 'both') {
        // Query incoming relations
        const incomingQuery = `
          MATCH (a)-[r]->(b)
          WHERE b.id = '${escapedId}'${typeFilter ? ` AND (${typeFilter})` : ''}
          RETURN r, a
        `;
        const inResults = await this.graphStore.query(incomingQuery);
        for (const result of inResults) {
          const r = result as {
            from?: string;
            to?: string;
            description?: string;
          };
          if (r.from && r.to) {
            relations.push({
              sourceId: r.from,
              targetId: r.to,
              type: (r.description as RelationType) ?? 'CALLS',
            });
          }
        }
      }
    } catch {
      // Query failed, return empty relations
    }

    return relations;
  }

  /**
   * Escapes a string value for use in Cypher queries.
   */
  private escapeValue(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }
}
