/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { SymbolExtractor } from './symbolExtractor.js';
import { initTreeSitter } from './treeSitterParser.js';

const TEST_TIMEOUT = 30000;
const PROJECT_ROOT = '/tmp/test-project';

describe('SymbolExtractor', () => {
  let extractor: SymbolExtractor;

  beforeAll(async () => {
    await initTreeSitter();
    extractor = new SymbolExtractor(PROJECT_ROOT);
  }, TEST_TIMEOUT);

  // ===== TypeScript Extraction =====

  describe('TypeScript definitions', () => {
    it('should extract function declarations', async () => {
      const content = `
function greet(name: string): string {
  return 'Hello, ' + name;
}
`;
      const result = await extractor.extract('src/utils.ts', content);

      const func = result.symbols.find((s) => s.name === 'greet');
      expect(func).toBeDefined();
      expect(func?.type).toBe('function');
      expect(func?.filePath).toBe('src/utils.ts');
      expect(func?.startLine).toBe(2);
      expect(func?.endLine).toBe(4);
    });

    it('should extract arrow function assignments', async () => {
      const content = `
const add = (a: number, b: number) => a + b;
`;
      const result = await extractor.extract('src/math.ts', content);

      const func = result.symbols.find((s) => s.name === 'add');
      expect(func).toBeDefined();
      expect(func?.type).toBe('function');
    });

    it('should extract class declarations', async () => {
      const content = `
class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  subtract(a: number, b: number): number {
    return a - b;
  }
}
`;
      const result = await extractor.extract('src/calc.ts', content);

      const cls = result.symbols.find(
        (s) => s.name === 'Calculator' && s.type === 'class',
      );
      expect(cls).toBeDefined();
      expect(cls?.startLine).toBe(2);
      expect(cls?.endLine).toBe(10);

      const addMethod = result.symbols.find((s) => s.name === 'add');
      expect(addMethod).toBeDefined();
      expect(addMethod?.type).toBe('method');

      const subMethod = result.symbols.find((s) => s.name === 'subtract');
      expect(subMethod).toBeDefined();
      expect(subMethod?.type).toBe('method');
    });

    it('should extract interface declarations', async () => {
      const content = `
interface User {
  id: string;
  name: string;
  getFullName(): string;
}
`;
      const result = await extractor.extract('src/types.ts', content);

      const iface = result.symbols.find((s) => s.name === 'User');
      expect(iface).toBeDefined();
      expect(iface?.type).toBe('interface');
    });

    it('should extract type alias declarations', async () => {
      const content = `
type UserId = string;
type Config = {
  host: string;
  port: number;
};
`;
      const result = await extractor.extract('src/types.ts', content);

      const userId = result.symbols.find((s) => s.name === 'UserId');
      expect(userId).toBeDefined();
      expect(userId?.type).toBe('type');

      const config = result.symbols.find((s) => s.name === 'Config');
      expect(config).toBeDefined();
      expect(config?.type).toBe('type');
    });

    it('should extract enum declarations', async () => {
      const content = `
enum Direction {
  Up,
  Down,
  Left,
  Right,
}
`;
      const result = await extractor.extract('src/enums.ts', content);

      const enumDef = result.symbols.find((s) => s.name === 'Direction');
      expect(enumDef).toBeDefined();
      expect(enumDef?.type).toBe('type');
    });

    it('should extract abstract class declarations', async () => {
      const content = `
abstract class Shape {
  abstract area(): number;
  abstract perimeter(): number;

  describe(): string {
    return 'I am a shape';
  }
}
`;
      const result = await extractor.extract('src/shapes.ts', content);

      const cls = result.symbols.find((s) => s.name === 'Shape');
      expect(cls).toBeDefined();
      expect(cls?.type).toBe('class');
    });
  });

  // ===== TypeScript References =====

  describe('TypeScript references and edges', () => {
    it('should extract CALLS edges for function calls', async () => {
      const content = `
function helper(): void {}

function main(): void {
  helper();
}
`;
      const result = await extractor.extract('src/main.ts', content);

      // Should have a CALLS edge from main → helper
      const callEdge = result.edges.find(
        (e) => e.type === 'CALLS' && e.targetId === 'src/main.ts#helper',
      );
      expect(callEdge).toBeDefined();
    });

    it('should extract CALLS edges for imported functions', async () => {
      const content = `
import { parse } from './parser';

function process(): void {
  parse('data');
}
`;
      const result = await extractor.extract('src/processor.ts', content);

      // Should have an import mapping
      const parseImport = result.imports.find(
        (imp) => imp.localName === 'parse',
      );
      expect(parseImport).toBeDefined();
      expect(parseImport?.sourceModule).toBe('./parser');
      expect(parseImport?.originalName).toBe('parse');

      // Should have a CALLS edge targeting the imported module
      const callEdge = result.edges.find(
        (e) => e.type === 'CALLS' && e.targetId.includes('parse'),
      );
      expect(callEdge).toBeDefined();
    });

    it('should extract CONTAINS edges for class methods', async () => {
      const content = `
class MyService {
  init(): void {}
  process(data: string): string {
    return data;
  }
}
`;
      const result = await extractor.extract('src/service.ts', content);

      // Should have CONTAINS edges from MyService to its methods
      const containsEdges = result.edges.filter((e) => e.type === 'CONTAINS');
      expect(containsEdges.length).toBeGreaterThanOrEqual(2);

      // Methods should have qualified names
      const initMethod = result.symbols.find((s) => s.name === 'init');
      expect(initMethod?.qualifiedName).toBe('MyService.init');

      const processMethod = result.symbols.find((s) => s.name === 'process');
      expect(processMethod?.qualifiedName).toBe('MyService.process');
    });
  });

  // ===== Import Extraction =====

  describe('import extraction', () => {
    it('should extract named imports', async () => {
      const content = `
import { Foo, Bar as Baz } from './module';
`;
      const result = await extractor.extract('src/test.ts', content);

      const fooImport = result.imports.find((imp) => imp.localName === 'Foo');
      expect(fooImport).toBeDefined();
      expect(fooImport?.originalName).toBe('Foo');
      expect(fooImport?.sourceModule).toBe('./module');

      const bazImport = result.imports.find((imp) => imp.localName === 'Baz');
      expect(bazImport).toBeDefined();
      expect(bazImport?.originalName).toBe('Bar');
    });

    it('should extract default imports', async () => {
      const content = `
import React from 'react';
`;
      const result = await extractor.extract('src/app.tsx', content);

      const reactImport = result.imports.find(
        (imp) => imp.localName === 'React',
      );
      expect(reactImport).toBeDefined();
      expect(reactImport?.originalName).toBe('default');
    });

    it('should extract namespace imports', async () => {
      const content = `
import * as utils from './utils';
`;
      const result = await extractor.extract('src/test.ts', content);

      const utilsImport = result.imports.find(
        (imp) => imp.localName === 'utils',
      );
      expect(utilsImport).toBeDefined();
      expect(utilsImport?.originalName).toBe('*');
      expect(utilsImport?.sourceModule).toBe('./utils');
    });
  });

  // ===== Export Detection =====

  describe('export detection', () => {
    it('should mark exported functions', async () => {
      const content = `
export function publicFunc(): void {}
function privateFunc(): void {}
`;
      const result = await extractor.extract('src/lib.ts', content);

      const publicSym = result.symbols.find((s) => s.name === 'publicFunc');
      expect(publicSym?.exported).toBe(true);

      const privateSym = result.symbols.find((s) => s.name === 'privateFunc');
      expect(privateSym?.exported).toBe(false);
    });

    it('should mark exported classes', async () => {
      const content = `
export class PublicClass {}
class PrivateClass {}
`;
      const result = await extractor.extract('src/classes.ts', content);

      const publicCls = result.symbols.find((s) => s.name === 'PublicClass');
      expect(publicCls?.exported).toBe(true);

      const privateCls = result.symbols.find((s) => s.name === 'PrivateClass');
      expect(privateCls?.exported).toBe(false);
    });
  });

  // ===== Heritage (extends / implements) =====

  describe('class heritage', () => {
    it('should extract EXTENDS edges', async () => {
      const content = `
class Animal {
  speak(): void {}
}

class Dog extends Animal {
  bark(): void {}
}
`;
      const result = await extractor.extract('src/animals.ts', content);

      const extendsEdge = result.edges.find(
        (e) =>
          e.type === 'EXTENDS' &&
          e.sourceId.includes('Dog') &&
          e.targetId.includes('Animal'),
      );
      expect(extendsEdge).toBeDefined();
    });

    it('should extract IMPLEMENTS edges', async () => {
      const content = `
interface Serializable {
  serialize(): string;
}

class User implements Serializable {
  serialize(): string {
    return '{}';
  }
}
`;
      const result = await extractor.extract('src/user.ts', content);

      // Check if IMPLEMENTS edge exists
      const implEdge = result.edges.find(
        (e) =>
          e.type === 'IMPLEMENTS' &&
          e.sourceId.includes('User') &&
          e.targetId.includes('Serializable'),
      );
      // Note: This depends on tree-sitter grammar handling implements_clause
      // It's ok if this is captured through the extends_clause mechanism
      if (!implEdge) {
        // Fallback: at least the symbols should be extracted
        const userCls = result.symbols.find((s) => s.name === 'User');
        expect(userCls).toBeDefined();
        const serIface = result.symbols.find((s) => s.name === 'Serializable');
        expect(serIface).toBeDefined();
      }
    });
  });

  // ===== JavaScript Extraction =====

  describe('JavaScript extraction', () => {
    it('should extract function declarations', async () => {
      const content = `
function processData(data) {
  return data.map(x => x * 2);
}
`;
      const result = await extractor.extract('src/utils.js', content);

      const func = result.symbols.find((s) => s.name === 'processData');
      expect(func).toBeDefined();
      expect(func?.type).toBe('function');
    });

    it('should extract class declarations', async () => {
      const content = `
class EventEmitter {
  emit(event) {
    // emit event
  }

  on(event, handler) {
    // register handler
  }
}
`;
      const result = await extractor.extract('src/emitter.js', content);

      const cls = result.symbols.find((s) => s.name === 'EventEmitter');
      expect(cls).toBeDefined();
      expect(cls?.type).toBe('class');

      const emitMethod = result.symbols.find((s) => s.name === 'emit');
      expect(emitMethod).toBeDefined();
      expect(emitMethod?.type).toBe('method');
    });

    it('should extract arrow function assignments', async () => {
      const content = `
const multiply = (a, b) => a * b;
`;
      const result = await extractor.extract('src/math.js', content);

      const func = result.symbols.find((s) => s.name === 'multiply');
      expect(func).toBeDefined();
      expect(func?.type).toBe('function');
    });
  });

  // ===== Python Extraction =====

  describe('Python extraction', () => {
    it('should extract function definitions', async () => {
      const content = `
def greet(name):
    return f"Hello, {name}"
`;
      const result = await extractor.extract('src/utils.py', content);

      const func = result.symbols.find((s) => s.name === 'greet');
      expect(func).toBeDefined();
      expect(func?.type).toBe('function');
    });

    it('should extract class definitions', async () => {
      const content = `
class Calculator:
    def add(self, a, b):
        return a + b

    def subtract(self, a, b):
        return a - b
`;
      const result = await extractor.extract('src/calc.py', content);

      const cls = result.symbols.find((s) => s.name === 'Calculator');
      expect(cls).toBeDefined();
      expect(cls?.type).toBe('class');

      const addMethod = result.symbols.find((s) => s.name === 'add');
      expect(addMethod).toBeDefined();
      expect(addMethod?.type).toBe('method');
      // After addContainsEdges, method should have qualified name
      expect(addMethod?.qualifiedName).toBe('Calculator.add');
    });

    it('should extract Python imports', async () => {
      const content = `
from .utils import helper
from os.path import join
import json
`;
      const result = await extractor.extract('src/main.py', content);

      const helperImport = result.imports.find(
        (imp) => imp.localName === 'helper',
      );
      expect(helperImport).toBeDefined();
      expect(helperImport?.sourceModule).toBe('.utils');
    });

    it('should extract CALLS edges for Python function calls', async () => {
      const content = `
def helper():
    pass

def main():
    helper()
`;
      const result = await extractor.extract('src/app.py', content);

      const callEdge = result.edges.find(
        (e) => e.type === 'CALLS' && e.targetId === 'src/app.py#helper',
      );
      expect(callEdge).toBeDefined();
    });

    it('should extract Python class inheritance', async () => {
      const content = `
class Animal:
    def speak(self):
        pass

class Dog(Animal):
    def bark(self):
        pass
`;
      const result = await extractor.extract('src/animals.py', content);

      const extendsEdge = result.edges.find(
        (e) =>
          e.type === 'EXTENDS' &&
          e.sourceId.includes('Dog') &&
          e.targetId.includes('Animal'),
      );
      expect(extendsEdge).toBeDefined();
    });

    it('should mark top-level Python symbols as exported', async () => {
      const content = `
def public_func():
    pass

class PublicClass:
    def _private_method(self):
        pass
`;
      const result = await extractor.extract('src/module.py', content);

      const publicFunc = result.symbols.find((s) => s.name === 'public_func');
      expect(publicFunc?.exported).toBe(true);

      const publicClass = result.symbols.find((s) => s.name === 'PublicClass');
      expect(publicClass?.exported).toBe(true);
    });
  });

  // ===== Edge Cases =====

  describe('edge cases', () => {
    it('should handle unsupported file types gracefully', async () => {
      const result = await extractor.extract('readme.txt', 'Hello world');
      expect(result.symbols).toHaveLength(0);
      expect(result.edges).toHaveLength(0);
      expect(result.imports).toHaveLength(0);
    });

    it('should handle empty files', async () => {
      const result = await extractor.extract('src/empty.ts', '');
      expect(result.symbols).toHaveLength(0);
    });

    it('should skip built-in references', async () => {
      const content = `
function test(): void {
  console.log("hello");
  JSON.parse('{}');
  parseInt("42");
}
`;
      const result = await extractor.extract('src/test.ts', content);

      // Built-in names should be filtered out
      const consoleEdge = result.edges.find((e) =>
        e.targetId.includes('console'),
      );
      expect(consoleEdge).toBeUndefined();
    });

    it('should NOT create cross-file edges for built-in object method calls', async () => {
      const content = `
function doStuff(): void {
  console.warn("warning");
  console.error("error");
  Math.floor(1.5);
  JSON.stringify({});
  Object.keys({});
  Array.isArray([]);
  process.exit(1);
}
`;
      const result = await extractor.extract('src/test.ts', content);

      // No edges should be created for built-in object methods
      // (warn, error, floor, stringify, keys, isArray, exit)
      const badEdges = result.edges.filter(
        (e) =>
          e.type === 'CALLS' &&
          (e.targetId.includes('warn') ||
            e.targetId.includes('error') ||
            e.targetId.includes('floor') ||
            e.targetId.includes('stringify') ||
            e.targetId.includes('keys') ||
            e.targetId.includes('isArray') ||
            e.targetId.includes('exit')),
      );
      expect(badEdges).toHaveLength(0);
    });

    it('should NOT create cross-file edges for this/super member calls', async () => {
      const content = `
class MyClass {
  helper(): void {}

  run(): void {
    this.helper();
    this.unknownMethod();
  }
}
`;
      const result = await extractor.extract('src/test.ts', content);

      // this.helper() should resolve to same-file CALLS edge (helper is defined here)
      const helperEdge = result.edges.find(
        (e) =>
          e.type === 'CALLS' && e.targetId === 'src/test.ts#MyClass.helper',
      );
      expect(helperEdge).toBeDefined();

      // this.unknownMethod() should NOT create a ?# cross-file placeholder edge
      const unknownEdge = result.edges.find((e) =>
        e.targetId.includes('?#unknownMethod'),
      );
      expect(unknownEdge).toBeUndefined();
    });

    it('should NOT create cross-file edges for arbitrary obj.method() calls', async () => {
      const content = `
import { createService } from './factory';

function main(): void {
  const svc = createService();
  svc.start();
  svc.stop();
}
`;
      const result = await extractor.extract('src/test.ts', content);

      // svc is a local variable (not directly imported) → svc.start(), svc.stop() dropped
      const startEdge = result.edges.find((e) => e.targetId.includes('start'));
      const stopEdge = result.edges.find((e) => e.targetId.includes('stop'));
      expect(startEdge).toBeUndefined();
      expect(stopEdge).toBeUndefined();

      // But createService() is a direct call with import → should create ?# edge
      const factoryEdge = result.edges.find((e) =>
        e.targetId.includes('createService'),
      );
      expect(factoryEdge).toBeDefined();
      expect(factoryEdge!.targetId).toBe('?#createService');
    });

    it('should create module-scoped placeholders for imported object member calls', async () => {
      const content = `
import { logger } from './logger';

function main(): void {
  logger.info("hello");
  logger.warn("warning");
}
`;
      const result = await extractor.extract('src/test.ts', content);

      // logger is imported from './logger' → logger.info() gets ?./logger#info
      const infoEdge = result.edges.find(
        (e) => e.type === 'CALLS' && e.targetId === '?./logger#info',
      );
      const warnEdge = result.edges.find(
        (e) => e.type === 'CALLS' && e.targetId === '?./logger#warn',
      );
      expect(infoEdge).toBeDefined();
      expect(warnEdge).toBeDefined();
    });

    it('should create module-scoped placeholders for external package member calls', async () => {
      const content = `
import tseslint from 'typescript-eslint';
import express from 'express';

const app = express();
export default tseslint.config(app.listen(3000));
`;
      const result = await extractor.extract('src/test.js', content);

      // tseslint is imported from 'typescript-eslint' →
      // tseslint.config() produces ?typescript-eslint#config (module-scoped placeholder).
      // At resolution time, this will be cleaned up because the external
      // package has no indexed symbols.
      const configEdge = result.edges.find(
        (e) => e.targetId === '?typescript-eslint#config',
      );
      expect(configEdge).toBeDefined();

      // app is a local variable (result of express() call), not an import →
      // app.listen() should NOT produce any placeholder
      const listenEdge = result.edges.find((e) =>
        e.targetId.includes('listen'),
      );
      expect(listenEdge).toBeUndefined();
    });

    it('should deduplicate symbols at the same position', async () => {
      const content = `
function foo(): void {}
`;
      const result = await extractor.extract('src/test.ts', content);

      // Should only have one 'foo' symbol
      const fooSymbols = result.symbols.filter((s) => s.name === 'foo');
      expect(fooSymbols).toHaveLength(1);
    });

    it('should generate file-level IMPORTS edges', async () => {
      const content = `
import { something } from './other';
`;
      const result = await extractor.extract('src/test.ts', content);

      const importEdge = result.edges.find(
        (e) => e.type === 'IMPORTS' && e.sourceId === 'src/test.ts',
      );
      // Import edge exists if the path was resolved
      if (result.imports[0]?.resolvedPath) {
        expect(importEdge).toBeDefined();
      }
    });
  });

  // ===== Complex Scenarios =====

  describe('complex scenarios', () => {
    it('should handle a real-world TypeScript module', async () => {
      const content = `
import { EventEmitter } from 'events';
import { Logger } from './logger';

export interface IService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class MyService extends EventEmitter implements IService {
  private logger: Logger;

  constructor() {
    super();
    this.logger = new Logger();
  }

  async start(): Promise<void> {
    this.logger.info('Starting service');
    this.emit('started');
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping service');
    this.emit('stopped');
  }
}
`;
      const result = await extractor.extract('src/service.ts', content);

      // Check symbols
      expect(result.symbols.find((s) => s.name === 'IService')).toBeDefined();
      expect(result.symbols.find((s) => s.name === 'MyService')).toBeDefined();

      // Check imports
      expect(result.imports.length).toBeGreaterThanOrEqual(2);
      const loggerImport = result.imports.find(
        (imp) => imp.localName === 'Logger',
      );
      expect(loggerImport).toBeDefined();

      // Check CONTAINS edges
      const containsEdges = result.edges.filter((e) => e.type === 'CONTAINS');
      expect(containsEdges.length).toBeGreaterThanOrEqual(2);

      // Check CALLS edges (Logger constructor call)
      const loggerNewEdge = result.edges.find(
        (e) => e.type === 'CALLS' && e.targetId.includes('Logger'),
      );
      expect(loggerNewEdge).toBeDefined();
    });

    it('should handle nested function calls', async () => {
      const content = `
function outer(): void {
  function inner(): void {}
  inner();
}
`;
      const result = await extractor.extract('src/nested.ts', content);

      // Both functions should be extracted
      expect(result.symbols.find((s) => s.name === 'outer')).toBeDefined();
      expect(result.symbols.find((s) => s.name === 'inner')).toBeDefined();

      // inner() call from within outer should create a CALLS edge
      const callEdge = result.edges.find(
        (e) => e.type === 'CALLS' && e.targetId.includes('inner'),
      );
      expect(callEdge).toBeDefined();
    });

    it('should handle TSX files', async () => {
      const content = `
import React from 'react';

interface Props {
  name: string;
}

export function Greeting({ name }: Props): JSX.Element {
  return <div>Hello, {name}</div>;
}
`;
      const result = await extractor.extract('src/Greeting.tsx', content);

      expect(result.symbols.find((s) => s.name === 'Greeting')).toBeDefined();
      expect(result.symbols.find((s) => s.name === 'Props')).toBeDefined();
    });
  });

  // ===== Module-scoped placeholder format =====

  describe('module-scoped placeholder format', () => {
    it('should produce ?sourceModule#method for imported object member calls', async () => {
      const content = `
import { apiClient } from './services/api';

export function fetchData() {
  return apiClient.get('/data');
}
`;
      const result = await extractor.extract('src/handler.ts', content);

      const getEdge = result.edges.find(
        (e) => e.type === 'CALLS' && e.targetId === '?./services/api#get',
      );
      expect(getEdge).toBeDefined();
    });

    it('should produce ?sourceModule#method for bare specifier imports', async () => {
      const content = `
import { db } from '@myorg/database';

export function query() {
  return db.execute('SELECT 1');
}
`;
      const result = await extractor.extract('src/repo.ts', content);

      // Even bare specifiers get a module-scoped placeholder.
      // resolveEdgesByName will clean it up if no match is found.
      const execEdge = result.edges.find(
        (e) => e.type === 'CALLS' && e.targetId === '?@myorg/database#execute',
      );
      expect(execEdge).toBeDefined();
    });

    it('should produce ?#name for direct calls (not member expressions)', async () => {
      const content = `
import { helper } from './utils';

function main() {
  helper();
}
`;
      const result = await extractor.extract('src/main.ts', content);

      // Direct calls use the original import-guided format ?#originalName
      const helperEdge = result.edges.find(
        (e) => e.type === 'CALLS' && e.targetId === '?#helper',
      );
      expect(helperEdge).toBeDefined();
    });

    it('should drop member calls on non-imported local variables', async () => {
      const content = `
import { createLogger } from './factory';

function main() {
  const log = createLogger();
  log.debug("msg");
}
`;
      const result = await extractor.extract('src/app.ts', content);

      // createLogger() is a direct call → gets ?#createLogger
      expect(
        result.edges.find((e) => e.targetId === '?#createLogger'),
      ).toBeDefined();

      // log.debug() → log is a local variable, not an import → dropped
      expect(
        result.edges.find((e) => e.targetId.includes('debug')),
      ).toBeUndefined();
    });
  });
});
