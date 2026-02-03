/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { ChunkingService } from './chunkingService.js';
import { initTreeSitter } from './treeSitterParser.js';

const TEST_TIMEOUT = 30000;

describe('ChunkingService', () => {
  let service: ChunkingService;

  beforeAll(async () => {
    await initTreeSitter();
    service = new ChunkingService();
  }, TEST_TIMEOUT);

  describe('line-based chunking', () => {
    it('should chunk plain text files', async () => {
      const content = `Line 1
Line 2
Line 3
Line 4
Line 5`;
      const chunks = await service.chunkFile('test.txt', content);

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].filepath).toBe('test.txt');
      expect(chunks[0].type).toBe('block');
      expect(chunks[0].startLine).toBe(1);
    });

    it('should handle empty files', async () => {
      const chunks = await service.chunkFile('empty.txt', '');
      // Empty file may produce 0 or 1 empty chunk depending on implementation
      expect(chunks.length).toBeLessThanOrEqual(1);
    });

    it('should respect maxChunkTokens', async () => {
      const longContent = Array(1000).fill('This is a test line.').join('\n');
      const customService = new ChunkingService({ maxChunkTokens: 100 });
      const chunks = await customService.chunkFile('long.txt', longContent);

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        // Each chunk should be roughly within the token limit
        expect(chunk.content.length).toBeLessThan(500); // ~100 tokens * 4 chars
      }
    });

    it('should include overlap between chunks', async () => {
      const longContent = Array(100).fill('This is line number X.').join('\n');
      const customService = new ChunkingService({
        maxChunkTokens: 50,
        overlapTokens: 10,
      });
      const chunks = await customService.chunkFile('overlap.txt', longContent);

      if (chunks.length >= 2) {
        // Check that consecutive chunks have some overlap
        const chunk1Lines = chunks[0].content.split('\n');
        const chunk2Lines = chunks[1].content.split('\n');
        const chunk1End = chunk1Lines.slice(-3);
        const chunk2Start = chunk2Lines.slice(0, 3);

        // There should be some overlap
        const hasOverlap = chunk1End.some((line) => chunk2Start.includes(line));
        expect(hasOverlap).toBe(true);
      }
    });
  });

  describe('AST-based chunking for TypeScript', () => {
    it('should chunk TypeScript functions', async () => {
      const tsContent = `
function hello(name: string): string {
  return 'Hello, ' + name;
}

function goodbye(name: string): string {
  return 'Goodbye, ' + name;
}
`;
      const chunks = await service.chunkFile('test.ts', tsContent);

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].metadata.language).toBe('typescript');
    });

    it('should chunk TypeScript classes', async () => {
      const tsContent = `
class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  subtract(a: number, b: number): number {
    return a - b;
  }
}
`;
      const chunks = await service.chunkFile('calculator.ts', tsContent);

      // Should produce chunks
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].metadata.language).toBe('typescript');
    });

    it('should chunk TypeScript interfaces', async () => {
      const tsContent = `
interface User {
  id: string;
  name: string;
  email: string;
}

interface Post {
  id: string;
  title: string;
  content: string;
}
`;
      const chunks = await service.chunkFile('types.ts', tsContent);

      // Should produce chunks
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].metadata.language).toBe('typescript');
    });

    it('should handle mixed content', async () => {
      const tsContent = `
// Constants
const VERSION = '1.0.0';

interface Config {
  debug: boolean;
}

function initialize(config: Config): void {
  console.log('Initializing...');
}

class App {
  constructor() {}
}
`;
      const chunks = await service.chunkFile('app.ts', tsContent);

      expect(chunks.length).toBeGreaterThan(0);
    });
  });

  describe('AST-based chunking for JavaScript', () => {
    it('should chunk JavaScript functions', async () => {
      const jsContent = `
function add(a, b) {
  return a + b;
}

const multiply = (a, b) => a * b;
`;
      const chunks = await service.chunkFile('math.js', jsContent);

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].metadata.language).toBe('javascript');
    });

    it('should chunk JavaScript classes', async () => {
      const jsContent = `
class Animal {
  constructor(name) {
    this.name = name;
  }

  speak() {
    console.log(this.name + ' makes a sound.');
  }
}
`;
      const chunks = await service.chunkFile('animal.js', jsContent);

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].metadata.language).toBe('javascript');
    });
  });

  describe('AST-based chunking for Python', () => {
    it('should chunk Python functions', async () => {
      const pyContent = `
def greet(name):
    """Greet a person."""
    return f"Hello, {name}!"

def farewell(name):
    """Say goodbye to a person."""
    return f"Goodbye, {name}!"
`;
      const chunks = await service.chunkFile('greetings.py', pyContent);

      // Python should produce chunks (either AST or line-based)
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].metadata.language).toBe('python');
    });

    it('should chunk Python classes', async () => {
      const pyContent = `
class Dog:
    def __init__(self, name):
        self.name = name

    def bark(self):
        return f"{self.name} says woof!"
`;
      const chunks = await service.chunkFile('dog.py', pyContent);

      // Should produce at least one chunk
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].metadata.language).toBe('python');
    });
  });

  describe('chunk metadata', () => {
    it('should include correct line numbers', async () => {
      const content = `
function first() {
  return 1;
}

function second() {
  return 2;
}
`;
      const chunks = await service.chunkFile('lines.ts', content);

      // Should have chunks with line information
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].startLine).toBeGreaterThanOrEqual(1);
      expect(chunks[0].endLine).toBeGreaterThanOrEqual(chunks[0].startLine);
    });

    it('should generate unique IDs', async () => {
      const content = `
function a() {}
function b() {}
`;
      const chunks = await service.chunkFile('ids.ts', content);
      const ids = chunks.map((c) => c.id);
      const uniqueIds = new Set(ids);

      expect(uniqueIds.size).toBe(ids.length);
    });

    it('should compute content hash', async () => {
      const content = `function test() { return 42; }`;
      const chunks = await service.chunkFile('hash.ts', content);

      expect(chunks[0].contentHash).toBeDefined();
      expect(chunks[0].contentHash.length).toBe(64); // SHA-256 hex
    });

    it('should include language in metadata', async () => {
      const tsChunks = await service.chunkFile('test.ts', 'const x = 1;');
      const pyChunks = await service.chunkFile('test.py', 'x = 1');

      expect(tsChunks[0].metadata.language).toBe('typescript');
      expect(pyChunks[0].metadata.language).toBe('python');
    });
  });

  describe('large file handling', () => {
    it('should split large functions into multiple chunks', async () => {
      const largeFunction = `
function processData(data: any[]): any[] {
  ${Array(200).fill('  const x = 1;').join('\n')}
  return data;
}
`;
      const customService = new ChunkingService({ maxChunkTokens: 200 });
      const chunks = await customService.chunkFile('large.ts', largeFunction);

      // Large function should be split
      expect(chunks.length).toBeGreaterThan(1);
    });
  });

  describe('edge cases', () => {
    it('should handle files with syntax errors gracefully', async () => {
      const invalidTs = `
function broken( {
  return;
}
`;
      // Should fall back to line-based chunking
      const chunks = await service.chunkFile('broken.ts', invalidTs);
      expect(chunks.length).toBeGreaterThan(0);
    });

    it('should handle files with only comments', async () => {
      const commentsOnly = `
// This is a comment
// Another comment
/* Block comment */
`;
      const chunks = await service.chunkFile('comments.ts', commentsOnly);
      expect(chunks.length).toBeGreaterThanOrEqual(0);
    });

    it('should handle unsupported file types', async () => {
      const rustContent = `
fn main() {
    println!("Hello, World!");
}
`;
      // Should use line-based chunking for unsupported languages
      const chunks = await service.chunkFile('main.rs', rustContent);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].type).toBe('block');
    });
  });
});
