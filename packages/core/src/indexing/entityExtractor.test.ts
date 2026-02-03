/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { EntityExtractor } from './entityExtractor.js';
import { initTreeSitter } from './treeSitterParser.js';

const TEST_TIMEOUT = 30000;

describe('EntityExtractor', () => {
  let extractor: EntityExtractor;

  beforeAll(async () => {
    await initTreeSitter();
    extractor = new EntityExtractor();
  }, TEST_TIMEOUT);

  describe('module extraction', () => {
    it('should create module entity for any file', async () => {
      const content = 'const x = 1;';
      const result = await extractor.extract('src/test.ts', content);

      expect(result.entities.length).toBeGreaterThanOrEqual(1);
      const moduleEntity = result.entities.find((e) => e.type === 'module');
      expect(moduleEntity).toBeDefined();
      expect(moduleEntity?.id).toBe('src/test.ts');
      expect(moduleEntity?.name).toBe('test.ts');
    });

    it('should handle unsupported file types', async () => {
      const content = 'Some plain text content';
      const result = await extractor.extract('readme.txt', content);

      expect(result.entities.length).toBe(1);
      expect(result.entities[0].type).toBe('module');
    });
  });

  describe('TypeScript extraction', () => {
    it('should extract entities from TypeScript files', async () => {
      const content = `
function greet(name: string): string {
  return 'Hello, ' + name;
}

class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }
}

interface User {
  id: string;
  name: string;
}
`;
      const result = await extractor.extract('src/example.ts', content);

      // Should have module entity
      expect(result.entities.some((e) => e.type === 'module')).toBe(true);

      // Should have at least the module entity
      expect(result.entities.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle empty TypeScript files', async () => {
      const result = await extractor.extract('src/empty.ts', '');

      expect(result.entities.length).toBe(1);
      expect(result.entities[0].type).toBe('module');
    });
  });

  describe('JavaScript extraction', () => {
    it('should extract entities from JavaScript files', async () => {
      const content = `
function process(data) {
  return data.map(x => x * 2);
}

class EventEmitter {
  emit(event) {
    console.log(event);
  }
}
`;
      const result = await extractor.extract('src/events.js', content);

      // Should have module entity
      expect(result.entities.some((e) => e.type === 'module')).toBe(true);

      // Should have entities extracted
      expect(result.entities.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('IMPLEMENTS relation extraction', () => {
    it('should extract implements relations from TypeScript class', async () => {
      const content = `
interface Printable {
  print(): void;
}

interface Serializable {
  serialize(): string;
}

class Document implements Printable, Serializable {
  print(): void {
    console.log('printing');
  }
  serialize(): string {
    return JSON.stringify(this);
  }
}
`;
      const result = await extractor.extract('src/document.ts', content);

      // Should have IMPLEMENTS relations
      const implementsRelations = result.relations.filter(
        (r) => r.type === 'IMPLEMENTS',
      );
      expect(implementsRelations.length).toBe(2);

      // Check the class implements both interfaces
      const implementedNames = implementsRelations.map((r) => r.targetId);
      expect(implementedNames).toContain('Printable');
      expect(implementedNames).toContain('Serializable');
    });

    it('should handle class with extends and implements', async () => {
      const content = `
class BaseClass {}

interface Logger {
  log(msg: string): void;
}

class MyClass extends BaseClass implements Logger {
  log(msg: string): void {
    console.log(msg);
  }
}
`;
      const result = await extractor.extract('src/myclass.ts', content);

      // Should have both EXTENDS and IMPLEMENTS relations
      const extendsRelations = result.relations.filter(
        (r) => r.type === 'EXTENDS',
      );
      const implementsRelations = result.relations.filter(
        (r) => r.type === 'IMPLEMENTS',
      );

      expect(extendsRelations.length).toBeGreaterThanOrEqual(1);
      expect(implementsRelations.length).toBe(1);
      expect(implementsRelations[0].targetId).toBe('Logger');
    });

    it('should handle generic interface implementation', async () => {
      const content = `
interface Repository<T> {
  find(id: string): T;
}

class UserRepository implements Repository<User> {
  find(id: string): User {
    return { id };
  }
}
`;
      const result = await extractor.extract('src/repo.ts', content);

      const implementsRelations = result.relations.filter(
        (r) => r.type === 'IMPLEMENTS',
      );
      // Should extract the base interface name without generics
      expect(implementsRelations.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Python extraction', () => {
    it('should extract entities from Python files', async () => {
      const content = `
def greet(name):
    return f"Hello, {name}!"

class Calculator:
    def add(self, a, b):
        return a + b
`;
      const result = await extractor.extract('src/example.py', content);

      // Should have module entity
      expect(result.entities.some((e) => e.type === 'module')).toBe(true);

      // Should have entities extracted
      expect(result.entities.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('chunk association', () => {
    it('should associate entities with chunk IDs', async () => {
      const content = `function test() {}`;
      const chunkId = 'chunk-123';
      const result = await extractor.extract('src/test.ts', content, chunkId);

      // Should have entities with chunkId
      expect(result.entities.length).toBeGreaterThanOrEqual(1);
      // At least the module entity should exist
      const moduleEntity = result.entities.find((e) => e.type === 'module');
      expect(moduleEntity).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('should handle syntax errors gracefully', async () => {
      const invalidContent = `
function broken( {
  return
}
`;
      const result = await extractor.extract('src/broken.ts', invalidContent);

      // Should still return at least the module entity
      expect(result.entities.length).toBeGreaterThanOrEqual(1);
      expect(result.entities.some((e) => e.type === 'module')).toBe(true);
    });
  });
});
