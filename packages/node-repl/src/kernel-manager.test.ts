/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NodeReplKernelManager,
  type KernelManagerOptions,
  type NodeReplExecOutcome,
  type NodeReplTextEvent,
} from './kernel-manager.js';
import { NodeReplSecurityPolicy } from './security-policy.js';

const EXEC_TIMEOUT = 15_000;
const TEST_TIMEOUT = 60_000;
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let workDir: string;
let manager: NodeReplKernelManager;

function textEvents(outcome: NodeReplExecOutcome): NodeReplTextEvent[] {
  return outcome.events.filter(
    (event): event is NodeReplTextEvent => event.type === 'text',
  );
}

function texts(outcome: NodeReplExecOutcome): string[] {
  return textEvents(outcome).map((event) => event.text);
}

function makeManager(
  overrides: Partial<
    Pick<KernelManagerOptions, 'policy' | 'readableRoots'>
  > = {},
): NodeReplKernelManager {
  return new NodeReplKernelManager({
    cwd: workDir,
    homeDir: os.homedir(),
    tmpRootDir: path.join(workDir, 'repl-tmp'),
    policy: NodeReplSecurityPolicy.default(),
    readableRoots: [workDir],
    ...overrides,
  });
}

function createEsmPackage(
  root: string,
  packageName: string,
  source: string,
): string {
  const packageDir = path.join(root, packageName);
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({
      name: packageName,
      version: '1.0.0',
      type: 'module',
      exports: './index.js',
    }),
  );
  const entry = path.join(packageDir, 'index.js');
  fs.writeFileSync(entry, source);
  return entry;
}

async function run(code: string, timeoutMs = EXEC_TIMEOUT) {
  return manager.exec({ code, timeoutMs });
}

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-repl-km-'));
  manager = makeManager();
});

afterEach(() => {
  manager.dispose();
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('NodeReplKernelManager', () => {
  it(
    'persists declarations without returning ordinary expressions',
    async () => {
      expect((await run('const answer = 41;')).status).toBe('ok');
      const result = await run('answer + 1;');
      expect(result.status).toBe('ok');
      expect(texts(result)).toEqual([]);
      expect(texts(await run('nodeRepl.write(answer + 1);'))).toEqual(['42']);
      expect(manager.getBindingNames()).toEqual(['answer']);
    },
    TEST_TIMEOUT,
  );

  it(
    'preserves object identity and closure state as real references',
    async () => {
      await run(
        'const box = { count: 0 }; const same = box; const next = () => ++box.count;',
      );
      const result = await run(
        'const first = next(); nodeRepl.write(`${first}|${next()}|${box === same}`);',
      );
      expect(result.status).toBe('ok');
      expect(texts(result)).toEqual(['1|2|true']);
    },
    TEST_TIMEOUT,
  );

  it(
    'keeps an earlier closure when a later cell assigns its carried binding',
    async () => {
      await run('let x = 1; const readX = () => x;');
      const result = await run('x = 2; nodeRepl.write(`${readX()}|${x}`);');
      expect(result.status).toBe('ok');
      expect(texts(result)).toEqual(['1|2']);
    },
    TEST_TIMEOUT,
  );

  it(
    'commits direct assignments to carried bindings',
    async () => {
      await run('let count = 1;');
      expect(texts(await run('nodeRepl.write(count += 2);'))).toEqual(['3']);
      expect(texts(await run('nodeRepl.write(count);'))).toEqual(['3']);
    },
    TEST_TIMEOUT,
  );

  it(
    'supports top-level await, functions, classes, and destructuring',
    async () => {
      const first = await run(
        [
          'const { value: awaited } = await Promise.resolve({ value: 7 });',
          'function double(value) { return value * 2; }',
          'class Box { constructor(value) { this.value = value; } }',
        ].join('\n'),
      );
      expect(first.status).toBe('ok');
      expect(
        texts(await run('nodeRepl.write(new Box(double(awaited)).value);')),
      ).toEqual(['14']);
    },
    TEST_TIMEOUT,
  );

  it(
    'keeps function and class bindings mutable but non-redeclarable',
    async () => {
      await run(
        'function mutableFunction() { return 1; } class MutableClass { static value() { return 1; } }',
      );
      expect(
        texts(
          await run(
            'mutableFunction = () => 2; MutableClass = class { static value() { return 2; } }; nodeRepl.write(`${mutableFunction()}|${MutableClass.value()}`);',
          ),
        ),
      ).toEqual(['2|2']);
      expect((await run('function mutableFunction() {}')).status).toBe('error');
      expect((await run('class MutableClass {}')).status).toBe('error');
      expect(
        texts(
          await run(
            'nodeRepl.write(`${mutableFunction()}|${MutableClass.value()}`);',
          ),
        ),
      ).toEqual(['2|2']);
    },
    TEST_TIMEOUT,
  );

  it(
    'persists var, dynamic imports, and Unicode bindings',
    async () => {
      fs.writeFileSync(
        path.join(workDir, 'static-helper.mjs'),
        'export const seed = 4;',
      );
      const first = await run(
        [
          'const { seed: importedSeed } = await import("./static-helper.mjs");',
          'var mutable = importedSeed;',
          'if (true) { var fromBlock = 8; }',
          'const 变量 = "你好";',
        ].join('\n'),
      );
      expect(first.status).toBe('ok');
      expect(
        texts(
          await run(
            'mutable += 1; nodeRepl.write(`${mutable}|${importedSeed}|${变量}|${typeof fromBlock}`);',
          ),
        ),
      ).toEqual(['5|4|你好|number']);
      expect((await run('var mutable = 9;')).status).toBe('ok');
      expect(texts(await run('nodeRepl.write(mutable);'))).toEqual(['9']);
      expect((await run(String.raw`const \u0061 = 1;`)).status).toBe('ok');
      expect((await run('const a = 2;')).status).toBe('error');
      expect(texts(await run('nodeRepl.write(a);'))).toEqual(['1']);
    },
    TEST_TIMEOUT,
  );

  it(
    'persists control-flow var declarations across cells (hoisting)',
    async () => {
      // `var` inside a block/loop body at the top level hoists to module scope,
      // so it must survive into later cells just like a bare top-level `var`.
      expect(
        texts(
          await run(
            'if (true) { var nestedVar = 8; } nodeRepl.write(nestedVar);',
          ),
        ),
      ).toEqual(['8']);
      expect(texts(await run('nodeRepl.write(typeof nestedVar);'))).toEqual([
        'number',
      ]);

      await run('for (var loopVar = 0; loopVar < 1; loopVar++) {}');
      expect(texts(await run('nodeRepl.write(loopVar);'))).toEqual(['1']);

      await run('for (var loopKey in { key: true }) {}');
      expect(texts(await run('nodeRepl.write(loopKey);'))).toEqual(['key']);

      await run('for (; false;) var bareLoopBody = 1;');
      expect(texts(await run('nodeRepl.write(typeof bareLoopBody);'))).toEqual([
        'undefined',
      ]);

      await run('for (const value of []) var bareForOfBody = value;');
      expect(texts(await run('nodeRepl.write(typeof bareForOfBody);'))).toEqual(
        ['undefined'],
      );

      const failed = await run(
        'if (true) { var nestedBeforeThrow = 1; } throw new Error("boom");',
      );
      expect(failed.status).toBe('error');
      // The hoisted var was assigned before the throw, so partial-commit keeps it.
      expect(
        texts(await run('nodeRepl.write(typeof nestedBeforeThrow);')),
      ).toEqual(['number']);
    },
    TEST_TIMEOUT,
  );

  it(
    'preserves const, let, and var declaration semantics across cells',
    async () => {
      await run('const fixed = 1; let changeable = 1; var rerunnable = 1;');

      const fixedAssignment = await run('fixed = 2;');
      expect(fixedAssignment.status).toBe('error');
      expect(fixedAssignment.error?.message).toContain(
        'Assignment to constant variable',
      );
      expect((await run('const fixed = 2;')).status).toBe('error');
      expect((await run('var fixed = 2;')).status).toBe('error');

      expect(
        texts(await run('changeable = 2; nodeRepl.write(changeable);')),
      ).toEqual(['2']);
      expect((await run('let changeable = 3;')).status).toBe('error');

      expect(
        texts(await run('var rerunnable; nodeRepl.write(rerunnable);')),
      ).toEqual(['1']);
      expect((await run('var rerunnable = 2;')).status).toBe('ok');
      expect(
        texts(
          await run('nodeRepl.write(`${fixed}|${changeable}|${rerunnable}`);'),
        ),
      ).toEqual(['1|2|2']);
    },
    TEST_TIMEOUT,
  );

  it(
    'keeps exported declarations local to their cell',
    async () => {
      expect(
        texts(
          await run(
            'export const exportedProbe = 7; nodeRepl.write(exportedProbe);',
          ),
        ),
      ).toEqual(['7']);
      expect(texts(await run('nodeRepl.write(typeof exportedProbe);'))).toEqual(
        ['undefined'],
      );
      expect((await run('export default 7;')).status).toBe('ok');

      await run('const exportedCollision = 3;');
      const collision = await run(
        'export const exportedCollision = 7; nodeRepl.write(exportedCollision);',
      );
      expect(collision.status).toBe('error');
      expect(texts(await run('nodeRepl.write(exportedCollision);'))).toEqual([
        '3',
      ]);

      await run('var exportedVarCollision = 4;');
      expect((await run('export var exportedVarCollision = 8;')).status).toBe(
        'error',
      );
      expect(texts(await run('nodeRepl.write(exportedVarCollision);'))).toEqual(
        ['4'],
      );

      expect(
        texts(
          await run(
            'export var cellLocalExport = 1; var cellLocalExport = 2; nodeRepl.write(cellLocalExport);',
          ),
        ),
      ).toEqual(['2']);
      expect(
        texts(await run('nodeRepl.write(typeof cellLocalExport);')),
      ).toEqual(['undefined']);
    },
    TEST_TIMEOUT,
  );

  it(
    'partially commits completed statements after a runtime failure',
    async () => {
      await run('const existing = "old";');
      const failed = await run(
        'const kept = "safe"; throw new Error("boom"); function ghost() {}',
      );
      expect(failed.status).toBe('error');
      expect(failed.error?.message).toContain('boom');
      expect(
        texts(
          await run('nodeRepl.write(`${existing}|${kept}|${typeof ghost}`);'),
        ),
      ).toEqual(['old|safe|undefined']);
    },
    TEST_TIMEOUT,
  );

  it(
    'partially commits completed declarators before a later initializer fails',
    async () => {
      const failed = await run(
        'const completedDeclarator = 41, failedDeclarator = (() => { throw new Error("initializer boom"); })();',
      );
      expect(failed.status).toBe('error');
      expect(failed.error?.message).toContain('initializer boom');
      expect(
        texts(
          await run(
            'nodeRepl.write(`${completedDeclarator}|${typeof failedDeclarator}`);',
          ),
        ),
      ).toEqual(['41|undefined']);
    },
    TEST_TIMEOUT,
  );

  it(
    'does not mutate bindings after parse or link failure',
    async () => {
      await run('const anchor = { value: 9 };');
      expect((await run('const = ;')).status).toBe('error');
      expect(
        (await run('await import("./missing.mjs"); const leaked = 1;')).status,
      ).toBe('error');
      expect(
        texts(await run('nodeRepl.write(`${anchor.value}|${typeof leaked}`);')),
      ).toEqual(['9|undefined']);
    },
    TEST_TIMEOUT,
  );

  it(
    'preserves ordered explicit outputs and ignores the final expression',
    async () => {
      const result = await run(
        'console.log("one"); nodeRepl.write("two"); console.warn("three"); "four";',
      );
      expect(result.status).toBe('ok');
      expect(textEvents(result)).toEqual([
        { type: 'text', kind: 'console', level: 'log', text: 'one' },
        { type: 'text', kind: 'write', text: 'two' },
        { type: 'text', kind: 'console', level: 'warn', text: 'three' },
      ]);
    },
    TEST_TIMEOUT,
  );

  it(
    'serializes complex and hostile values without breaking the protocol',
    async () => {
      const result = await run(
        [
          'const cyclic = {}; cyclic.self = cyclic;',
          'const hostileFunction = new Proxy(function () {}, { get() { throw new Error("name trap"); } });',
          'const opaque = new Proxy({}, { get() { throw new Error("opaque"); }, getPrototypeOf() { throw new Error("opaque"); }, ownKeys() { throw new Error("opaque"); } });',
          'nodeRepl.write(1n);',
          'nodeRepl.write(cyclic);',
          'nodeRepl.write(function named() {});',
          'nodeRepl.write(Symbol("token"));',
          'nodeRepl.write(new Error("expected"));',
          'nodeRepl.write(hostileFunction);',
          'nodeRepl.write(opaque);',
          'const completed = true;',
        ].join('\n'),
      );
      expect(result.status).toBe('ok');
      expect(texts(result)).toEqual([
        '1n',
        '<ref *1> { self: [Circular *1] }',
        '[Function: named]',
        'Symbol(token)',
        'Error: expected',
        '[Function (anonymous)]',
        '{}',
      ]);
    },
    TEST_TIMEOUT,
  );

  it(
    'formats values without invoking getters or custom inspection hooks',
    async () => {
      const result = await run(
        [
          'let getterCalled = false;',
          'let customInspectCalled = false;',
          'const inspected = {};',
          'Object.defineProperty(inspected, "value", { enumerable: true, get() { getterCalled = true; return 1; } });',
          'Object.defineProperty(inspected, Symbol.for("nodejs.util.inspect.custom"), { value() { customInspectCalled = true; return "escaped"; } });',
          'nodeRepl.write(inspected);',
          'nodeRepl.write(`${getterCalled}|${customInspectCalled}`);',
        ].join('\n'),
      );
      expect(result.status).toBe('ok');
      expect(texts(result).at(-1)).toBe('false|false');
      expect(texts(result)[0]).not.toBe('escaped');
    },
    TEST_TIMEOUT,
  );

  it(
    'does not fabricate request or response metadata APIs',
    async () => {
      const result = await run(
        'nodeRepl.write(`${typeof nodeRepl.requestMeta}|${typeof nodeRepl.setResponseMeta}`);',
      );
      expect(texts(result)).toEqual(['undefined|undefined']);
    },
    TEST_TIMEOUT,
  );

  it(
    'keeps host bridge values private after realm intrinsics are replaced',
    async () => {
      const result = await manager.exec({
        code: [
          'let objectKeysProbe = "not-called";',
          'Object.keys = (value) => {',
          '  try { value.constructor.constructor("return process")(); objectKeysProbe = "escaped"; }',
          '  catch (error) { objectKeysProbe = error.name; }',
          '  return [];',
          '};',
          'JSON.parse = () => { throw new Error("poisoned parse"); };',
          'Number = () => { throw new Error("poisoned number"); };',
          'const heapAfterPoison = nodeRepl.getHeapStatus();',
          'nodeRepl.write(`${heapAfterPoison.pid > 0}|${objectKeysProbe}`);',
        ].join('\n'),
        timeoutMs: EXEC_TIMEOUT,
      });
      expect(result.status).toBe('ok');
      expect(texts(result)).toEqual(['true|not-called']);
    },
    TEST_TIMEOUT,
  );

  it(
    'does not expose process globals or dynamic code generation directly',
    async () => {
      const result = await run(
        [
          'let functionProbe;',
          'try { Function("return 1")(); } catch (error) { functionProbe = error.name; }',
          'let constructorProbe;',
          'try { globalThis.constructor.constructor("return process")(); } catch (error) { constructorProbe = error.name; }',
          'let wasmProbe;',
          'try { await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); wasmProbe = "allowed"; } catch (error) { wasmProbe = error.name; }',
          'let imageErrorProbe;',
          'try { await nodeRepl.emitImage("https://example.invalid/image.png"); } catch (error) {',
          '  try { error.constructor.constructor("return process")(); } catch (inner) { imageErrorProbe = inner.name; }',
          '}',
          'nodeRepl.write([typeof globalThis.qwenSession, typeof process, typeof require, typeof module, typeof Buffer, typeof nodeRepl.callHost, functionProbe, constructorProbe, wasmProbe, imageErrorProbe].join(","));',
        ].join('\n'),
      );
      expect(result.status).toBe('ok');
      expect(texts(result)).toEqual([
        'undefined,undefined,undefined,undefined,function,undefined,EvalError,EvalError,CompileError,EvalError',
      ]);
    },
    TEST_TIMEOUT,
  );

  it(
    'gives ordinary packages the parent Node process environment',
    async () => {
      const key = 'QWEN_NODE_REPL_TEST_PARENT_ENV';
      const original = process.env[key];
      process.env[key] = 'visible';
      try {
        const root = path.join(workDir, 'node_modules');
        createEsmPackage(
          root,
          'environment-fixture',
          `export const value = process.env.${key};`,
        );
        await manager.addModuleRoot(root);
        const result = await run(
          'const environment = await import("environment-fixture"); nodeRepl.write(environment.value);',
        );
        expect(result.status).toBe('ok');
        expect(texts(result)).toEqual(['visible']);
      } finally {
        if (original === undefined) delete process.env[key];
        else process.env[key] = original;
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'does not expose host realm values while invoking timer callbacks',
    async () => {
      const result = await run(
        [
          'let timerThenProbe = "not-called";',
          'let timerApplyProbe = "not-called";',
          'const timerCallback = new Proxy(() => ({ then(resolve) {',
          '  try { resolve.constructor("return process")(); timerThenProbe = "escaped"; }',
          '  catch (error) { timerThenProbe = error.name; }',
          '} }), { apply(target, thisArg, args) {',
          '  try { args.constructor.constructor("return process")(); timerApplyProbe = "escaped"; }',
          '  catch (error) { timerApplyProbe = error.name; }',
          '  return Reflect.apply(target, thisArg, args);',
          '} });',
          'setTimeout(timerCallback, 0);',
          'await new Promise((resolve) => setTimeout(resolve, 50));',
          'nodeRepl.write(`${timerApplyProbe}|${timerThenProbe}`);',
        ].join('\n'),
      );
      expect(result.status).toBe('ok');
      expect(texts(result)).toEqual(['EvalError|not-called']);
    },
    TEST_TIMEOUT,
  );

  it(
    'loads Node builtins while blocking direct process imports',
    async () => {
      fs.writeFileSync(
        path.join(workDir, 'builtin-helper.mjs'),
        'import path from "node:path"; export const value = path.join("a", "b");',
      );
      expect(
        texts(
          await run(
            'const helper = await import("./builtin-helper.mjs"); const fs = await import("node:fs"); nodeRepl.write(`${helper.value}|${typeof fs.readFile}`);',
          ),
        ),
      ).toEqual([`a${path.sep}b|function`]);
      for (const specifier of ['process', 'node:process']) {
        const denied = await run(`await import(${JSON.stringify(specifier)});`);
        expect(denied.status).toBe('error');
        expect(denied.error?.message).toMatch(/not allowed in node_repl/);
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'imports exact local ESM paths outside the workspace root',
    async () => {
      fs.writeFileSync(
        path.join(workDir, 'helper.mjs'),
        'export const value = 123; export default "dflt";',
      );
      expect(
        texts(
          await run(
            'const helper = await import("./helper.mjs"); nodeRepl.write(`${helper.value}/${helper.default}`);',
          ),
        ),
      ).toEqual(['123/dflt']);

      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'node-repl-out-'));
      try {
        fs.writeFileSync(path.join(outside, 'x.mjs'), 'export const v = 1;');
        const imported = await run(
          `const outside = await import(${JSON.stringify(path.join(outside, 'x.mjs'))}); nodeRepl.write(outside.v);`,
        );
        expect(imported.status).toBe('ok');
        expect(texts(imported)).toEqual(['1']);

        const missing = await run(
          `await import(${JSON.stringify(path.join(outside, 'missing.mjs'))});`,
        );
        expect(missing.status).toBe('error');
        expect(missing.error?.message).toMatch(/module file not found/);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'loads ESM and CommonJS packages with Node singleton semantics',
    async () => {
      const root = path.join(workDir, 'node_modules');
      createEsmPackage(
        root,
        'demo-esm',
        'let calls = 0; export function multiply(a, b) { return a * b; } export function bump() { return ++calls; }',
      );
      const cjsDir = path.join(root, 'demo-cjs');
      fs.mkdirSync(cjsDir, { recursive: true });
      fs.writeFileSync(
        path.join(cjsDir, 'package.json'),
        JSON.stringify({ name: 'demo-cjs', main: 'index.js' }),
      );
      fs.writeFileSync(path.join(cjsDir, 'index.js'), 'module.exports = 3;');

      await expect(manager.addModuleRoot(root)).resolves.toEqual({
        path: fs.realpathSync(root),
        added: true,
      });
      expect(
        texts(
          await run(
            'const demo = await import("demo-esm"); nodeRepl.write(demo.multiply(6, 7));',
          ),
        ),
      ).toEqual(['42']);
      expect(
        texts(
          await run(
            'const demoAgain = await import("demo-esm"); nodeRepl.write(`${demo.bump()}|${demoAgain.bump()}`);',
          ),
        ),
      ).toEqual(['1|2']);
      expect(
        texts(
          await run(
            'const cjs = await import("demo-cjs"); const { createRequire } = await import("node:module"); const require = createRequire(import.meta.url); nodeRepl.write(`${cjs.default}|${require("demo-cjs")}`);',
          ),
        ),
      ).toEqual(['3|3']);
    },
    TEST_TIMEOUT,
  );

  it(
    'resolves packages installed after their module root is registered',
    async () => {
      const root = path.join(workDir, 'future', 'node_modules');
      const registration = await manager.addModuleRoot(root);
      createEsmPackage(root, 'future-fixture', 'export const value = 42;');
      expect(registration).toEqual({
        path: fs.realpathSync(root),
        added: true,
      });
      expect(
        texts(
          await run(
            'const fixture = await import("future-fixture"); nodeRepl.write(fixture.value);',
          ),
        ),
      ).toEqual(['42']);
    },
    TEST_TIMEOUT,
  );

  it.skipIf(process.platform === 'win32')(
    'resolves packages through a node_modules symlink with a differently named target',
    async () => {
      const target = path.join(workDir, 'packages');
      createEsmPackage(
        target,
        'symlink-root-fixture',
        'export const value = 42;',
      );
      const aliasParent = fs.mkdtempSync(
        path.join(os.tmpdir(), 'node-repl-module-root-alias-'),
      );
      const alias = path.join(aliasParent, 'node_modules');
      fs.symlinkSync(target, alias, 'dir');
      try {
        await expect(manager.addModuleRoot(alias)).resolves.toEqual({
          path: fs.realpathSync(target),
          added: true,
        });
        const result = await run(
          'const fixture = await import("symlink-root-fixture"); nodeRepl.write(fixture.value);',
        );
        expect(result.status).toBe('ok');
        expect(texts(result)).toEqual(['42']);
      } finally {
        fs.rmSync(aliasParent, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT,
  );

  it.skipIf(process.platform === 'win32')(
    'revokes a module root if its canonical target changes',
    async () => {
      const root = path.join(workDir, 'node_modules');
      createEsmPackage(root, 'original-fixture', 'export const value = 1;');
      await manager.addModuleRoot(root);
      expect(
        texts(
          await run(
            'const original = await import("original-fixture"); nodeRepl.write(original.value);',
          ),
        ),
      ).toEqual(['1']);

      const outside = fs.mkdtempSync(
        path.join(os.tmpdir(), 'node-repl-replaced-root-'),
      );
      const replacementRoot = path.join(outside, 'node_modules');
      createEsmPackage(
        replacementRoot,
        'replacement-fixture',
        'export const escaped = true;',
      );
      try {
        fs.rmSync(root, { recursive: true, force: true });
        fs.symlinkSync(replacementRoot, root, 'dir');
        const denied = await run('await import("replacement-fixture");');
        expect(denied.status).toBe('error');
        expect(denied.error?.message).toMatch(/cannot resolve package/);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT,
  );

  it.skipIf(process.platform === 'win32')(
    'revalidates a module root after earlier queued work completes',
    async () => {
      const root = path.join(workDir, 'node_modules');
      fs.mkdirSync(root);
      const busy = run(
        'await new Promise((resolve) => setTimeout(resolve, 300));',
      );
      const registration = manager.addModuleRoot(root);
      const outside = fs.mkdtempSync(
        path.join(os.tmpdir(), 'node-repl-queued-root-swap-'),
      );
      const replacement = path.join(outside, 'node_modules');
      fs.mkdirSync(replacement);
      try {
        fs.rmSync(root, { recursive: true, force: true });
        fs.symlinkSync(replacement, root, 'dir');
        expect((await busy).status).toBe('ok');
        await expect(registration).rejects.toThrow(/canonical target changed/);
        expect(manager.getModuleRoots()).toEqual([]);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT,
  );

  it.skipIf(process.platform === 'win32')(
    'allows package metadata symlinks when the resolved entry stays in the module root',
    async () => {
      const root = path.join(workDir, 'node_modules');
      const packageDir = path.join(root, 'manifest-escape-fixture');
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(
        path.join(packageDir, 'index.js'),
        'export const escaped = true;',
      );
      const outside = fs.mkdtempSync(
        path.join(os.tmpdir(), 'node-repl-package-json-'),
      );
      try {
        const outsideManifest = path.join(outside, 'package.json');
        fs.writeFileSync(
          outsideManifest,
          JSON.stringify({ type: 'module', exports: './index.js' }),
        );
        fs.symlinkSync(outsideManifest, path.join(packageDir, 'package.json'));
        await manager.addModuleRoot(root);

        const result = await run(
          'const fixture = await import("manifest-escape-fixture"); nodeRepl.write(fixture.escaped);',
        );
        expect(result.status).toBe('ok');
        expect(texts(result)).toEqual(['true']);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'passes 2 MiB of raw text and 20 images without legacy caps',
    async () => {
      const result = await run(
        [
          'nodeRepl.write("x".repeat(2 * 1024 * 1024));',
          `for (let index = 0; index < 20; index++) await nodeRepl.emitImage("data:image/png;base64,${PNG_BASE64}");`,
        ].join('\n'),
      );
      expect(result.status).toBe('ok');
      expect(texts(result)[0]).toHaveLength(2 * 1024 * 1024);
      expect(
        result.events.filter((event) => event.type === 'image'),
      ).toHaveLength(20);
      expect(result.rawTextTruncated).toBe(false);
      expect(result.imagesDropped).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'reports image drops only after the wide child sanity limit',
    async () => {
      const result = await run(
        `for (let index = 0; index < 65; index++) await nodeRepl.emitImage("data:image/png;base64,${PNG_BASE64}");`,
      );
      expect(result.status).toBe('ok');
      expect(
        result.events.filter((event) => event.type === 'image'),
      ).toHaveLength(64);
      expect(result.imagesDropped).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'allows image file URLs only inside readable roots',
    async () => {
      const imageBytes = Buffer.from(PNG_BASE64, 'base64');
      const inside = path.join(workDir, 'inside.png');
      fs.writeFileSync(inside, imageBytes);
      const allowed = await run(
        `await nodeRepl.emitImage(${JSON.stringify(pathToFileURL(inside).href)});`,
      );
      expect(allowed.status).toBe('ok');
      expect(
        allowed.events.filter((event) => event.type === 'image'),
      ).toHaveLength(1);

      const outsideDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'node-repl-image-'),
      );
      try {
        const outside = path.join(outsideDirectory, 'outside.png');
        fs.writeFileSync(outside, imageBytes);
        const denied = await run(
          `await nodeRepl.emitImage(${JSON.stringify(pathToFileURL(outside).href)});`,
        );
        expect(denied.status).toBe('error');
        expect(denied.error?.message).toMatch(/restricted/);
      } finally {
        fs.rmSync(outsideDirectory, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'rejects malformed base64 image data URLs',
    async () => {
      const result = await run(
        `await nodeRepl.emitImage("data:image/png;base64,${PNG_BASE64}!!!!");`,
      );
      expect(result.status).toBe('error');
      expect(result.error?.message).toMatch(/malformed base64 data URL/);
      expect(result.events).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    'reads image views without invoking model-defined typed-array accessors',
    async () => {
      const bytes = JSON.stringify([...Buffer.from(PNG_BASE64, 'base64')]);
      const result = await run(
        [
          `const imageBytes = new Uint8Array(${bytes});`,
          "for (const name of ['buffer', 'byteOffset', 'byteLength']) {",
          '  Object.defineProperty(imageBytes, name, { get() { throw new Error(`poisoned ${name}`); } });',
          '}',
          'await nodeRepl.emitImage(imageBytes);',
        ].join('\n'),
      );
      expect(result.status).toBe('ok');
      expect(
        result.events.filter((event) => event.type === 'image'),
      ).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );

  it.skipIf(process.platform === 'win32')(
    'revokes image access if a readable root changes canonical target',
    async () => {
      const readableRoot = path.join(workDir, 'readable');
      fs.mkdirSync(readableRoot);
      const original = path.join(readableRoot, 'original.png');
      fs.writeFileSync(original, Buffer.from(PNG_BASE64, 'base64'));
      manager.dispose();
      manager = makeManager({ readableRoots: [readableRoot] });
      expect(
        (
          await run(
            `await nodeRepl.emitImage(${JSON.stringify(pathToFileURL(original).href)});`,
          )
        ).events.filter((event) => event.type === 'image'),
      ).toHaveLength(1);

      const outside = fs.mkdtempSync(
        path.join(os.tmpdir(), 'node-repl-readable-root-swap-'),
      );
      const replacement = path.join(outside, 'readable');
      fs.mkdirSync(replacement);
      const escaped = path.join(replacement, 'escaped.png');
      fs.writeFileSync(escaped, Buffer.from(PNG_BASE64, 'base64'));
      try {
        fs.rmSync(readableRoot, { recursive: true, force: true });
        fs.symlinkSync(replacement, readableRoot, 'dir');
        const denied = await run(
          `await nodeRepl.emitImage(${JSON.stringify(pathToFileURL(path.join(readableRoot, 'escaped.png')).href)});`,
        );
        expect(denied.status).toBe('error');
        expect(denied.error?.message).toMatch(/restricted to the workspace/);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'returns a synchronous heap snapshot with the current owner identity',
    async () => {
      const result = await run(
        'nodeRepl.write(JSON.stringify(nodeRepl.getHeapStatus()));',
      );
      expect(result.status).toBe('ok');
      const heap = JSON.parse(texts(result)[0]!) as Record<string, unknown>;
      expect(heap['pid']).toBe(result.stats.pid);
      expect(heap['generation']).toBe(result.stats.generation);
      for (const name of [
        'rssBytes',
        'heapUsedBytes',
        'heapTotalBytes',
        'heapLimitBytes',
        'externalBytes',
        'arrayBuffersBytes',
      ]) {
        expect(heap[name]).toEqual(expect.any(Number));
        expect(heap[name] as number).toBeGreaterThanOrEqual(0);
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'reports explicit allocation changes without replacing the kernel',
    async () => {
      const result = await run(
        [
          'const heapBeforeAllocation = nodeRepl.getHeapStatus();',
          'const retainedBuffer = new ArrayBuffer(1024 * 1024);',
          'const heapAfterAllocation = nodeRepl.getHeapStatus();',
          'nodeRepl.write(JSON.stringify({ before: heapBeforeAllocation.arrayBuffersBytes, after: heapAfterAllocation.arrayBuffersBytes, size: retainedBuffer.byteLength }));',
        ].join('\n'),
      );
      const measured = JSON.parse(texts(result)[0]!) as {
        before: number;
        after: number;
        size: number;
      };
      expect(result.status).toBe('ok');
      expect(measured.size).toBe(1024 * 1024);
      expect(measured.after - measured.before).toBeGreaterThanOrEqual(
        measured.size,
      );
      expect(manager.getKernelPid()).toBe(result.stats.pid);
      expect((await run('retainedBuffer.byteLength;')).stats.pid).toBe(
        result.stats.pid,
      );
    },
    TEST_TIMEOUT,
  );

  it(
    'replaces the process on reset, clears bindings, and retains roots',
    async () => {
      const root = path.join(workDir, 'node_modules');
      createEsmPackage(root, 'reset-esm', 'export const tag = "retained";');
      await manager.addModuleRoot(root);
      await run('const gone = 1;');
      const oldPid = manager.getKernelPid()!;
      const oldGeneration = manager.getGeneration();

      await manager.reset();

      expect(manager.getKernelPid()).toBeNull();
      expect(manager.getGeneration()).toBeGreaterThan(oldGeneration);
      expect(manager.getModuleRoots()).toContain(fs.realpathSync(root));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(() => process.kill(oldPid, 0)).toThrow();

      const result = await run(
        'const pkg = await import("reset-esm"); nodeRepl.write(`${typeof gone}|${pkg.tag}`);',
      );
      expect(texts(result)).toEqual(['undefined|retained']);
      expect(result.stats.pid).not.toBe(oldPid);
      expect(result.stats.generation).toBeGreaterThan(oldGeneration);
    },
    TEST_TIMEOUT,
  );

  it(
    'interrupts timed-out and cancelled cells without replacing the kernel',
    async () => {
      await run(
        'globalThis.oldObject = { value: "retained", afterBarrier: false, caughtAfterCancel: false, finallyAfterCancel: false }; const oldBinding = globalThis.oldObject;',
      );
      const timeoutPid = manager.getKernelPid()!;
      const generation = manager.getGeneration();
      const timedOut = await run(
        'setTimeout(() => { oldBinding.value = "timeout-late"; }, 100); while (true) {}',
        500,
      );
      expect(timedOut.status).toBe('timeout');
      expect(timedOut.stats.kernelReplaced).toBe(false);
      expect(manager.getKernelPid()).toBe(timeoutPid);
      expect(manager.getGeneration()).toBe(generation);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(texts(await run('nodeRepl.write(oldBinding.value);'))).toEqual([
        'retained',
      ]);

      const controller = new AbortController();
      const pending = manager.exec({
        code: 'const { setTimeout: sleepAfterCancel } = await import("node:timers/promises"); setTimeout(() => nodeRepl.write("late-cancel"), 500); try { await sleepAfterCancel(400); } catch { oldBinding.caughtAfterCancel = true; } finally { oldBinding.finallyAfterCancel = true; } oldBinding.value = "cancel-late"; const mustNotCommit = true;',
        timeoutMs: 120_000,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 200);
      const cancelled = await pending;
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.stats.kernelReplaced).toBe(false);
      expect(cancelled.stats.pid).toBe(timeoutPid);
      expect(manager.getKernelPid()).toBe(timeoutPid);
      expect(manager.getGeneration()).toBe(generation);

      await new Promise((resolve) => setTimeout(resolve, 700));

      const recovered = await run(
        'nodeRepl.write(`${oldBinding === globalThis.oldObject}|${oldBinding.value}|${oldBinding.caughtAfterCancel}|${oldBinding.finallyAfterCancel}|${typeof mustNotCommit}`);',
      );
      expect(texts(recovered)).toEqual(['true|retained|false|false|undefined']);
      expect(texts(recovered)).not.toContain('late-cancel');
      expect(recovered.stats.pid).toBe(timeoutPid);

      await run(
        'setTimeout(async () => { const { setTimeout: sleepInTimer } = await import("node:timers/promises"); await sleepInTimer(20); oldBinding.value = "background-await-completed"; }, 20);',
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(texts(await run('nodeRepl.write(oldBinding.value);'))).toEqual([
        'background-await-completed',
      ]);
      await run('oldBinding.value = "retained";');

      const iterableController = new AbortController();
      const iterableCell = manager.exec({
        code: 'const guardedStream = { [Symbol.asyncIterator]() { return this; }, next() { return import("node:timers/promises").then(({ setTimeout: sleep }) => sleep(400)).then(() => ({ done: false, value: 1 })); } }; for await (const value of guardedStream) { oldBinding.value = `iterable-${value}`; break; }',
        timeoutMs: 30_000,
        signal: iterableController.signal,
      });
      setTimeout(() => iterableController.abort(), 50);
      expect((await iterableCell).status).toBe('cancelled');
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(texts(await run('nodeRepl.write(oldBinding.value);'))).toEqual([
        'retained',
      ]);

      const barrierController = new AbortController();
      let barrierSettled = false;
      const barrierCell = manager
        .exec({
          code: 'const { setTimeout: sleep } = await import("node:timers/promises"); await nodeRepl.signal.waitUntil(sleep(400)); oldBinding.afterBarrier = true; const barrierBinding = true;',
          timeoutMs: 30_000,
          signal: barrierController.signal,
        })
        .finally(() => {
          barrierSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 50));
      barrierController.abort();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(barrierSettled).toBe(false);
      const barrierCancelled = await barrierCell;
      expect(barrierCancelled.status).toBe('cancelled');
      expect(barrierCancelled.stats.pid).toBe(timeoutPid);
      expect(manager.getGeneration()).toBe(generation);
      expect(
        texts(
          await run(
            'nodeRepl.write(`${typeof barrierBinding}|${oldBinding.afterBarrier}`);',
          ),
        ),
      ).toEqual(['undefined|false']);

      const operationModule = path.join(workDir, 'terminal-operation.mjs');
      fs.writeFileSync(
        operationModule,
        [
          'import { setTimeout as sleep } from "node:timers/promises";',
          'export async function dispatch(signal, state) {',
          '  await signal.waitUntil(sleep(400));',
          '  const result = "committed";',
          '  state.operation = result;',
          '  return result;',
          '}',
        ].join('\n'),
      );
      await run(
        'globalThis.nativeLifecycle = { operation: "dispatched", userContinuation: false };',
      );
      const nativeController = new AbortController();
      const nativeCell = manager.exec({
        code: `const { dispatch } = await import(${JSON.stringify(pathToFileURL(operationModule).href)}); await dispatch(nodeRepl.signal, nativeLifecycle); nativeLifecycle.userContinuation = true;`,
        timeoutMs: 30_000,
        signal: nativeController.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      nativeController.abort();
      expect((await nativeCell).status).toBe('cancelled');
      expect(
        texts(
          await run(
            'nodeRepl.write(`${nativeLifecycle.operation}|${nativeLifecycle.userContinuation}`);',
          ),
        ),
      ).toEqual(['committed|false']);
    },
    TEST_TIMEOUT,
  );

  it(
    'drops delayed output instead of assigning it to a later execution',
    async () => {
      const first = await run(
        'setTimeout(() => nodeRepl.write("late"), 100); nodeRepl.write("first"); const scheduled = true;',
      );
      expect(texts(first)).toEqual(['first']);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(
        texts(await run('nodeRepl.write("second"); const finished = true;')),
      ).toEqual(['second']);
    },
    TEST_TIMEOUT,
  );

  it(
    'returns a structured crash and lazily recovers without bindings',
    async () => {
      await run('const crashBinding = 1;');
      const pid = manager.getKernelPid()!;
      const pending = run(
        'await new Promise((resolve) => setTimeout(resolve, 60_000));',
      );
      setTimeout(() => process.kill(pid, 'SIGKILL'), 200);
      const crashed = await pending;
      expect(crashed.status).toBe('crashed');
      expect(manager.getKernelPid()).toBeNull();

      const recovered = await run('nodeRepl.write(typeof crashBinding);');
      expect(texts(recovered)).toEqual(['undefined']);
      expect(recovered.stats.pid).not.toBe(pid);
    },
    TEST_TIMEOUT,
  );

  it(
    'returns a structured startup crash if the working directory disappears',
    async () => {
      const volatileCwd = path.join(workDir, 'volatile-cwd');
      fs.mkdirSync(volatileCwd);
      manager.dispose();
      manager = new NodeReplKernelManager({
        cwd: volatileCwd,
        homeDir: os.homedir(),
        tmpRootDir: path.join(workDir, 'separate-repl-tmp'),
        policy: NodeReplSecurityPolicy.default(),
        readableRoots: [volatileCwd],
      });
      fs.rmSync(volatileCwd, { recursive: true, force: true });

      const result = await run('1 + 1;');
      expect(result.status).toBe('crashed');
      expect(result.error?.message).toMatch(/failed to start/i);
      expect(manager.getKernelPid()).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
    TEST_TIMEOUT,
  );

  it(
    "loads added packages through Node's native package loader",
    async () => {
      const root = path.join(workDir, 'node_modules');
      createEsmPackage(
        root,
        'plain-fixture',
        'export const authority = [typeof globalThis.nodeRepl, typeof process].join("/");',
      );
      await manager.addModuleRoot(root);
      const result = await run(
        'const fixture = await import("plain-fixture"); nodeRepl.write(fixture.authority);',
      );
      expect(texts(result)).toEqual(['undefined/object']);
    },
    TEST_TIMEOUT,
  );

  it(
    'disposes the process and temp directory and settles in-flight work',
    async () => {
      await run('nodeRepl.write("up");');
      const pid = manager.getKernelPid()!;
      const tmpDir = manager.getSessionTmpDir()!;
      const pending = run(
        'await new Promise((resolve) => setTimeout(resolve, 60_000));',
      );
      await new Promise((resolve) => setTimeout(resolve, 100));

      const queuedReset = manager.reset();
      manager.dispose();

      expect((await pending).status).toBe('cancelled');
      await expect(queuedReset).rejects.toThrow(/disposed/);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(() => process.kill(pid, 0)).toThrow();
      expect(fs.existsSync(tmpDir)).toBe(false);
      await expect(run('1;')).rejects.toThrow(/disposed/);
    },
    TEST_TIMEOUT,
  );

  it(
    'retains a cold kernel if cancellation lands during startup',
    async () => {
      const controller = new AbortController();
      const pending = manager.exec({
        code: 'nodeRepl.write("must-not-run");',
        timeoutMs: EXEC_TIMEOUT,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 20);
      const cancelled = await pending;
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.events).toEqual([]);
      expect(cancelled.stats.kernelReplaced).toBe(false);
      const pid = manager.getKernelPid();
      expect(pid).not.toBeNull();
      const alive = await run('nodeRepl.write("alive");');
      expect(texts(alive)).toEqual(['alive']);
      expect(alive.stats.pid).toBe(pid);
    },
    TEST_TIMEOUT,
  );

  it(
    'clamps oversized timeouts and serializes concurrent calls',
    async () => {
      const largeTimeout = manager.exec({
        code: 'let order = "a"; nodeRepl.write(order);',
        timeoutMs: 2 ** 31 + 1000,
      });
      const second = run('nodeRepl.write(order += "b");');
      const third = run('nodeRepl.write(order += "c");');
      const [firstResult, secondResult, thirdResult] = await Promise.all([
        largeTimeout,
        second,
        third,
      ]);
      expect(texts(firstResult)).toEqual(['a']);
      expect(texts(secondResult)).toEqual(['ab']);
      expect(texts(thirdResult)).toEqual(['abc']);
    },
    TEST_TIMEOUT,
  );
});
