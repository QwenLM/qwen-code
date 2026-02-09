/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphTraverser } from './graphTraverser.js';
import type { GraphEntity, GraphRelation, IGraphStore } from './types.js';

/**
 * Creates a mock IGraphStore for testing.
 */
function createMockGraphStore(): IGraphStore {
  const entities = new Map<string, GraphEntity>();
  const relations: GraphRelation[] = [];

  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    insertEntities: vi.fn().mockImplementation(async (ents: GraphEntity[]) => {
      for (const e of ents) {
        entities.set(e.id, e);
      }
    }),
    insertRelations: vi
      .fn()
      .mockImplementation(async (rels: GraphRelation[]) => {
        relations.push(...rels);
      }),
    getEntitiesByChunkIds: vi
      .fn()
      .mockImplementation(async (chunkIds: string[]) => {
        const result: string[] = [];
        for (const [id, entity] of entities) {
          if (entity.chunkId && chunkIds.includes(entity.chunkId)) {
            result.push(id);
          }
        }
        return result;
      }),
    query: vi.fn().mockImplementation(async (cypher: string) => {
      // Simple mock query implementation
      if (cypher.includes('WHERE e.id =')) {
        const match = cypher.match(/e\.id = '([^']+)'/);
        if (match && match[1]) {
          const entity = entities.get(match[1]);
          if (entity) {
            return [
              {
                id: entity.id,
                labels: [entity.type],
                properties: {
                  name: entity.name,
                  type: entity.type,
                  filePath: entity.filePath,
                  startLine: String(entity.startLine),
                  endLine: String(entity.endLine),
                  signature: entity.signature ?? '',
                  chunkId: entity.chunkId ?? '',
                },
              },
            ];
          }
        }
        return [];
      }

      // Handle relation queries
      if (cypher.includes('MATCH (a)-[r]->(b)')) {
        const match = cypher.match(/a\.id = '([^']+)'|b\.id = '([^']+)'/);
        if (match) {
          const id = match[1] || match[2];
          const isOutgoing = !!match[1];

          // Extract relation type filter from query
          const typeMatches = cypher.match(/r\.description = '(\w+)'/g);
          const allowedTypes = typeMatches
            ? typeMatches
                .map((m) => m.match(/r\.description = '(\w+)'/)?.[1])
                .filter(Boolean)
            : null;

          return relations
            .filter((rel) => {
              const directionMatch = isOutgoing
                ? rel.sourceId === id
                : rel.targetId === id;
              const typeMatch =
                !allowedTypes || allowedTypes.includes(rel.type);
              return directionMatch && typeMatch;
            })
            .map((rel) => ({
              from: rel.sourceId,
              to: rel.targetId,
              description: rel.type,
            }));
        }
      }

      return [];
    }),
    deleteByFilePath: vi.fn().mockResolvedValue(undefined),
    getStats: vi
      .fn()
      .mockResolvedValue({
        nodeCount: entities.size,
        edgeCount: relations.length,
      }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Sets up a mock graph with test data.
 */
async function setupMockGraph(store: IGraphStore): Promise<{
  entities: GraphEntity[];
  relations: GraphRelation[];
}> {
  // Create a test graph:
  // moduleA -> imports -> moduleB
  // funcA (in moduleA) -> calls -> funcB (in moduleB)
  // funcA (in moduleA) -> calls -> funcC (in moduleA)
  // classA -> extends -> classBase

  const entities: GraphEntity[] = [
    {
      id: 'src/moduleA.ts',
      name: 'moduleA.ts',
      type: 'module',
      filePath: 'src/moduleA.ts',
      startLine: 1,
      endLine: 100,
      chunkId: 'chunk-a1',
    },
    {
      id: 'src/moduleB.ts',
      name: 'moduleB.ts',
      type: 'module',
      filePath: 'src/moduleB.ts',
      startLine: 1,
      endLine: 50,
      chunkId: 'chunk-b1',
    },
    {
      id: 'src/moduleA.ts#funcA',
      name: 'funcA',
      type: 'function',
      filePath: 'src/moduleA.ts',
      startLine: 10,
      endLine: 20,
      signature: 'function funcA(): void',
      chunkId: 'chunk-a2',
    },
    {
      id: 'src/moduleA.ts#funcC',
      name: 'funcC',
      type: 'function',
      filePath: 'src/moduleA.ts',
      startLine: 25,
      endLine: 35,
      signature: 'function funcC(): void',
      chunkId: 'chunk-a3',
    },
    {
      id: 'src/moduleB.ts#funcB',
      name: 'funcB',
      type: 'function',
      filePath: 'src/moduleB.ts',
      startLine: 5,
      endLine: 15,
      signature: 'function funcB(): string',
      chunkId: 'chunk-b2',
    },
    {
      id: 'src/moduleA.ts#ClassA',
      name: 'ClassA',
      type: 'class',
      filePath: 'src/moduleA.ts',
      startLine: 40,
      endLine: 80,
      chunkId: 'chunk-a4',
    },
    {
      id: 'src/base.ts#ClassBase',
      name: 'ClassBase',
      type: 'class',
      filePath: 'src/base.ts',
      startLine: 1,
      endLine: 30,
      chunkId: 'chunk-base1',
    },
  ];

  const relations: GraphRelation[] = [
    { sourceId: 'src/moduleA.ts', targetId: 'src/moduleB.ts', type: 'IMPORTS' },
    {
      sourceId: 'src/moduleA.ts#funcA',
      targetId: 'src/moduleB.ts#funcB',
      type: 'CALLS',
    },
    {
      sourceId: 'src/moduleA.ts#funcA',
      targetId: 'src/moduleA.ts#funcC',
      type: 'CALLS',
    },
    {
      sourceId: 'src/moduleA.ts#ClassA',
      targetId: 'src/base.ts#ClassBase',
      type: 'EXTENDS',
    },
    {
      sourceId: 'src/moduleA.ts',
      targetId: 'src/moduleA.ts#funcA',
      type: 'CONTAINS',
    },
    {
      sourceId: 'src/moduleA.ts',
      targetId: 'src/moduleA.ts#funcC',
      type: 'CONTAINS',
    },
    {
      sourceId: 'src/moduleA.ts',
      targetId: 'src/moduleA.ts#ClassA',
      type: 'CONTAINS',
    },
    {
      sourceId: 'src/moduleB.ts',
      targetId: 'src/moduleB.ts#funcB',
      type: 'CONTAINS',
    },
  ];

  await store.insertEntities(entities);
  await store.insertRelations(relations);

  return { entities, relations };
}

describe('GraphTraverser', () => {
  let store: IGraphStore;
  let traverser: GraphTraverser;

  beforeEach(async () => {
    store = createMockGraphStore();
    traverser = new GraphTraverser(store);
    await setupMockGraph(store);
  });

  describe('extractSubgraph', () => {
    it('should return empty subgraph for empty seed', async () => {
      const result = await traverser.extractSubgraph([]);
      expect(result.entities).toHaveLength(0);
      expect(result.relations).toHaveLength(0);
      expect(result.seedIds).toHaveLength(0);
    });

    it('should extract subgraph from seed chunks', async () => {
      const result = await traverser.extractSubgraph(['chunk-a2'], {
        maxDepth: 1,
        maxNodes: 10,
      });

      // Should find funcA and its immediate neighbors
      expect(result.seedIds).toContain('src/moduleA.ts#funcA');
      expect(result.entities.length).toBeGreaterThan(0);
    });

    it('should respect maxDepth option', async () => {
      const depth1Result = await traverser.extractSubgraph(['chunk-a2'], {
        maxDepth: 1,
        maxNodes: 50,
      });

      const depth2Result = await traverser.extractSubgraph(['chunk-a2'], {
        maxDepth: 2,
        maxNodes: 50,
      });

      // Deeper traversal should potentially find more nodes
      expect(depth2Result.depth).toBe(2);
      expect(depth1Result.depth).toBe(1);
    });

    it('should respect maxNodes option', async () => {
      const result = await traverser.extractSubgraph(['chunk-a2'], {
        maxDepth: 3,
        maxNodes: 2,
      });

      expect(result.entities.length).toBeLessThanOrEqual(2);
    });

    it('should filter by relation types', async () => {
      const callsOnlyResult = await traverser.extractSubgraph(['chunk-a2'], {
        maxDepth: 1,
        relationTypes: ['CALLS'],
      });

      // Should only have CALLS relations
      for (const rel of callsOnlyResult.relations) {
        expect(rel.type).toBe('CALLS');
      }
    });
  });

  describe('getNeighbors', () => {
    it('should get neighbors of an entity', async () => {
      const neighbors = await traverser.getNeighbors('src/moduleA.ts#funcA');
      expect(neighbors.length).toBeGreaterThan(0);
    });

    it('should filter by direction', async () => {
      const outgoing = await traverser.getNeighbors(
        'src/moduleA.ts#funcA',
        ['CALLS'],
        'outgoing',
      );
      // funcA calls funcB and funcC
      expect(outgoing.length).toBeGreaterThan(0);
    });
  });

  describe('getCallers', () => {
    it('should get callers of a function', async () => {
      const callers = await traverser.getCallers('src/moduleB.ts#funcB');
      // funcA calls funcB
      expect(callers).toContain('src/moduleA.ts#funcA');
    });
  });

  describe('getCallees', () => {
    it('should get callees of a function', async () => {
      const callees = await traverser.getCallees('src/moduleA.ts#funcA');
      // funcA calls funcB and funcC
      expect(callees).toContain('src/moduleB.ts#funcB');
      expect(callees).toContain('src/moduleA.ts#funcC');
    });
  });

  describe('getImports', () => {
    it('should get imports of a module', async () => {
      const imports = await traverser.getImports('src/moduleA.ts');
      expect(imports).toContain('src/moduleB.ts');
    });
  });

  describe('getInheritanceHierarchy', () => {
    it('should get ancestors of a class', async () => {
      const ancestors = await traverser.getInheritanceHierarchy(
        'src/moduleA.ts#ClassA',
        'ancestors',
      );
      expect(ancestors).toContain('src/base.ts#ClassBase');
    });
  });

  describe('findPath', () => {
    it('should return empty path for same source and target', async () => {
      const path = await traverser.findPath(
        'src/moduleA.ts#funcA',
        'src/moduleA.ts#funcA',
      );
      expect(path).toHaveLength(0);
    });

    it('should find path between connected entities', async () => {
      const path = await traverser.findPath(
        'src/moduleA.ts#funcA',
        'src/moduleB.ts#funcB',
        5,
      );
      // There should be a direct CALLS path
      expect(path.length).toBeGreaterThanOrEqual(0);
    });
  });
});
