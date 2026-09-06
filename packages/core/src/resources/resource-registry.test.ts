/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResourceRegistry } from './resource-registry.js';
import type { DiscoveredMCPResource } from '../tools/mcp-client.js';

vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function makeResource(
  uri: string,
  serverName: string,
  name = uri,
): DiscoveredMCPResource {
  return { uri, name, serverName };
}

describe('ResourceRegistry', () => {
  let registry: ResourceRegistry;

  beforeEach(() => {
    registry = new ResourceRegistry();
  });

  describe('registerResource', () => {
    it('should register a resource addressable by (serverName, uri)', () => {
      const resource = makeResource('file:///a.txt', 'server-a');
      registry.registerResource(resource);

      expect(registry.getResource('server-a', 'file:///a.txt')).toBe(resource);
    });

    it('should NOT collide when two servers advertise the same uri', () => {
      const a = makeResource('file:///shared.txt', 'server-a');
      const b = makeResource('file:///shared.txt', 'server-b');

      registry.registerResource(a);
      registry.registerResource(b);

      expect(registry.getResource('server-a', 'file:///shared.txt')).toBe(a);
      expect(registry.getResource('server-b', 'file:///shared.txt')).toBe(b);
      expect(registry.getAllResources()).toHaveLength(2);
    });

    it('should overwrite on re-registration of the same (serverName, uri)', () => {
      const first = makeResource('file:///a.txt', 'server-a', 'old');
      const second = makeResource('file:///a.txt', 'server-a', 'new');

      registry.registerResource(first);
      registry.registerResource(second);

      expect(registry.getResource('server-a', 'file:///a.txt')?.name).toBe(
        'new',
      );
      expect(registry.getAllResources()).toHaveLength(1);
    });
  });

  describe('getAllResources', () => {
    it('should return empty array when none registered', () => {
      expect(registry.getAllResources()).toEqual([]);
    });

    it('should return all resources sorted by server then uri', () => {
      registry.registerResource(makeResource('file:///z.txt', 'server-b'));
      registry.registerResource(makeResource('file:///a.txt', 'server-b'));
      registry.registerResource(makeResource('file:///m.txt', 'server-a'));

      const all = registry.getAllResources();
      expect(all.map((r) => `${r.serverName}:${r.uri}`)).toEqual([
        'server-a:file:///m.txt',
        'server-b:file:///a.txt',
        'server-b:file:///z.txt',
      ]);
    });
  });

  describe('getResource', () => {
    it('should return undefined for an unknown resource', () => {
      expect(
        registry.getResource('server-a', 'file:///nope.txt'),
      ).toBeUndefined();
    });
  });

  describe('getResourcesByServer', () => {
    it('should return resources from a specific server, sorted by uri', () => {
      registry.registerResource(makeResource('file:///z.txt', 'server-a'));
      registry.registerResource(makeResource('file:///a.txt', 'server-a'));
      registry.registerResource(makeResource('file:///c.txt', 'server-b'));

      const serverA = registry.getResourcesByServer('server-a');
      expect(serverA.map((r) => r.uri)).toEqual([
        'file:///a.txt',
        'file:///z.txt',
      ]);
    });

    it('should return empty array for an unknown server', () => {
      expect(registry.getResourcesByServer('unknown')).toEqual([]);
    });
  });

  describe('clear', () => {
    it('should remove all resources', () => {
      registry.registerResource(makeResource('file:///a.txt', 'server-a'));
      registry.registerResource(makeResource('file:///b.txt', 'server-b'));

      registry.clear();

      expect(registry.getAllResources()).toEqual([]);
    });
  });

  describe('removeResourcesByServer', () => {
    it('should remove only resources from the specified server', () => {
      registry.registerResource(makeResource('file:///a.txt', 'server-a'));
      registry.registerResource(makeResource('file:///b.txt', 'server-a'));
      registry.registerResource(makeResource('file:///c.txt', 'server-b'));

      registry.removeResourcesByServer('server-a');

      const remaining = registry.getAllResources();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].uri).toBe('file:///c.txt');
    });

    it('should do nothing for an unknown server', () => {
      registry.registerResource(makeResource('file:///a.txt', 'server-a'));

      registry.removeResourcesByServer('unknown');

      expect(registry.getAllResources()).toHaveLength(1);
    });
  });
});
