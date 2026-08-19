/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
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
    Pick<
      KernelManagerOptions,
      'initialModuleRoots' | 'policy' | 'capabilities' | 'readableRoots'
    >
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
    'persists declarations and captures the final expression',
    async () => {
      expect((await run('const answer = 41;')).status).toBe('ok');
      const result = await run('answer + 1;');
      expect(result.status).toBe('ok');
      expect(texts(result)).toEqual(['42']);
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
        'const first = next(); `${first}|${next()}|${box === same}`;',
      );
      expect(result.status).toBe('ok');
      expect(texts(result)).toEqual(['1|2|true']);
    },
    TEST_TIMEOUT,
  );

  it(
    'keeps an earlier closure when a later cell shadows its binding',
    async () => {
      await run('const x = 1; const readX = () => x;');
      const result = await run('const x = 2; `${readX()}|${x}`;');
      expect(result.status).toBe('ok');
      expect(texts(result)).toEqual(['1|2']);
    },
    TEST_TIMEOUT,
  );

  it(
    'commits direct assignments to carried bindings',
    async () => {
      await run('let count = 1;');
      expect(texts(await run('count += 2;'))).toEqual(['3']);
      expect(texts(await run('count;'))).toEqual(['3']);
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
      expect(texts(await run('new Box(double(awaited)).value;'))).toEqual([
        '14',
      ]);
    },
    TEST_TIMEOUT,
  );

  it(
    'persists var, static imports, and Unicode bindings',
    async () => {
      fs.writeFileSync(
        path.join(workDir, 'static-helper.mjs'),
        'export const seed = 4;',
      );
      const first = await run(
        [
          'import { seed as importedSeed } from "./static-helper.mjs";',
          'var mutable = importedSeed;',
          'if (true) { var fromBlock = 8; }',
          'const 变量 = "你好";',
        ].join('\n'),
      );
      expect(first.status).toBe('ok');
      expect(
        texts(
          await run(
            'mutable += 1; `${mutable}|${importedSeed}|${fromBlock}|${变量}`;',
          ),
        ),
      ).toEqual(['5|4|8|你好']);
      expect((await run('var mutable = 9;')).status).toBe('ok');
      expect(texts(await run('mutable;'))).toEqual(['9']);
      expect((await run(String.raw`const \u0061 = 1;`)).status).toBe('ok');
      expect(texts(await run('const a = 2; a;'))).toEqual(['2']);
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
        texts(await run('`${existing}|${kept}|${typeof ghost}`;')),
      ).toEqual(['old|safe|undefined']);
    },
    TEST_TIMEOUT,
  );

  it(
    'does not mutate bindings after parse or link failure',
    async () => {
      await run('const anchor = { value: 9 };');
      expect((await run('const = ;')).status).toBe('error');
      expect(
        (await run('import "./missing.mjs"; const leaked = 1;')).status,
      ).toBe('error');
      expect(texts(await run('`${anchor.value}|${typeof leaked}`;'))).toEqual([
        '9|undefined',
      ]);
    },
    TEST_TIMEOUT,
  );

  it(
    'preserves ordered console, write, and result events',
    async () => {
      const result = await run(
        'console.log("one"); nodeRepl.write("two"); console.warn("three"); "four";',
      );
      expect(result.status).toBe('ok');
      expect(textEvents(result)).toEqual([
        { type: 'text', kind: 'console', level: 'log', text: 'one' },
        { type: 'text', kind: 'write', text: 'two' },
        { type: 'text', kind: 'console', level: 'warn', text: 'three' },
        { type: 'text', kind: 'result', text: 'four' },
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
        '{"self":"[Circular]"}',
        '[function named]',
        'Symbol(token)',
        'Error: expected',
        '[function anonymous]',
        '[Unserializable: opaque]',
      ]);
    },
    TEST_TIMEOUT,
  );

  it(
    'exposes frozen request metadata only for its owning execution',
    async () => {
      const first = await manager.exec({
        code: 'nodeRepl.write(JSON.stringify({ meta: nodeRepl.requestMeta, frozen: Object.isFrozen(nodeRepl.requestMeta) })); const done = true;',
        timeoutMs: EXEC_TIMEOUT,
        title: 'metadata probe',
      });
      const payload = JSON.parse(texts(first)[0]!) as {
        meta: Record<string, unknown>;
        frozen: boolean;
      };
      expect(payload.frozen).toBe(true);
      expect(payload.meta['title']).toBe('metadata probe');
      expect(payload.meta['generation']).toBe(first.stats.generation);
      expect(payload.meta['execId']).toEqual(expect.any(String));

      const second = await run(
        'nodeRepl.write(String("title" in nodeRepl.requestMeta)); const doneAgain = true;',
      );
      expect(texts(second)).toEqual(['false']);
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
          'const metaAfterPoison = nodeRepl.requestMeta;',
          'const heapAfterPoison = nodeRepl.getHeapStatus();',
          '`${metaAfterPoison.title}|${heapAfterPoison.pid > 0}|${objectKeysProbe}`;',
        ].join('\n'),
        timeoutMs: EXEC_TIMEOUT,
        title: 'intrinsic probe',
      });
      expect(result.status).toBe('ok');
      expect(texts(result)).toEqual(['intrinsic probe|true|not-called']);
    },
    TEST_TIMEOUT,
  );

  it(
    'does not expose Node authority or dynamic code generation',
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
          'let importErrorProbe;',
          'try { await import("node:fs"); } catch (error) {',
          '  try { error.constructor.constructor("return process")(); } catch (inner) { importErrorProbe = inner.name; }',
          '}',
          '[typeof process, typeof require, typeof module, typeof Buffer, typeof nodeRepl.callHost, functionProbe, constructorProbe, wasmProbe, imageErrorProbe, importErrorProbe].join(",");',
        ].join('\n'),
      );
      expect(result.status).toBe('ok');
      expect(texts(result)).toEqual([
        'undefined,undefined,undefined,undefined,undefined,EvalError,EvalError,CompileError,EvalError,EvalError',
      ]);
    },
    TEST_TIMEOUT,
  );

  it(
    'does not inherit Node preload options from the parent environment',
    async () => {
      const original = process.env['NODE_OPTIONS'];
      process.env['NODE_OPTIONS'] =
        '--require=/definitely/missing/qwen-node-repl-preload.cjs';
      try {
        const result = await run('21 * 2;');
        expect(result.status).toBe('ok');
        expect(texts(result)).toEqual(['42']);
      } finally {
        if (original === undefined) delete process.env['NODE_OPTIONS'];
        else process.env['NODE_OPTIONS'] = original;
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
          '`${timerApplyProbe}|${timerThenProbe}`;',
        ].join('\n'),
      );
      expect(result.status).toBe('ok');
      expect(texts(result)).toEqual(['EvalError|not-called']);
    },
    TEST_TIMEOUT,
  );

  it(
    'blocks Node builtins from static and dynamic import',
    async () => {
      expect((await run('await import("node:child_process");')).status).toBe(
        'error',
      );
      expect((await run('import fs from "fs"; fs;')).status).toBe('error');
    },
    TEST_TIMEOUT,
  );

  it(
    'imports local ESM only inside readable roots',
    async () => {
      fs.writeFileSync(
        path.join(workDir, 'helper.mjs'),
        'export const value = 123; export default "dflt";',
      );
      expect(
        texts(
          await run(
            'const helper = await import("./helper.mjs"); `${helper.value}/${helper.default}`;',
          ),
        ),
      ).toEqual(['123/dflt']);

      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'node-repl-out-'));
      try {
        fs.writeFileSync(path.join(outside, 'x.mjs'), 'export const v = 1;');
        for (const candidate of [
          path.join(outside, 'x.mjs'),
          path.join(outside, 'missing.mjs'),
        ]) {
          const denied = await run(
            `await import(${JSON.stringify(candidate)});`,
          );
          expect(denied.status).toBe('error');
          expect(denied.error?.message).toMatch(/allowed roots/);
        }
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'loads ESM packages from an approved node_modules root and rejects CJS',
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

      await manager.addModuleRoot(root);
      expect(
        texts(
          await run(
            'const demo = await import("demo-esm"); demo.multiply(6, 7);',
          ),
        ),
      ).toEqual(['42']);
      expect(
        texts(
          await run(
            'const demoAgain = await import("demo-esm"); `${demo.bump()}|${demoAgain.bump()}`;',
          ),
        ),
      ).toEqual(['1|1']);
      const cjs = await run('await import("demo-cjs");');
      expect(cjs.status).toBe('error');
      expect(cjs.error?.message).toMatch(/CommonJS/);
    },
    TEST_TIMEOUT,
  );

  it.skipIf(process.platform === 'win32')(
    'revokes an untrusted module root if its canonical target changes',
    async () => {
      const root = path.join(workDir, 'node_modules');
      createEsmPackage(root, 'original-fixture', 'export const value = 1;');
      await manager.addModuleRoot(root);
      expect(
        texts(
          await run(
            'const original = await import("original-fixture"); original.value;',
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
    'does not read a package manifest through a symlink outside approved roots',
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

        const denied = await run('await import("manifest-escape-fixture");');
        expect(denied.status).toBe('error');
        expect(denied.error?.message).toMatch(/cannot resolve package/);
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
      expect(result.responseMeta).toBeUndefined();
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
    'shallow-merges response metadata only within the current execution',
    async () => {
      const first = await run(
        'nodeRepl.setResponseMeta({ first: 1, replaced: "old" }); nodeRepl.setResponseMeta({ second: 2, replaced: "new" }); const done = true;',
      );
      expect(first.responseMeta).toEqual({
        first: 1,
        second: 2,
        replaced: 'new',
      });
      expect((await run('0;')).responseMeta).toBeUndefined();
    },
    TEST_TIMEOUT,
  );

  it(
    'bounds cumulative response metadata for one execution',
    async () => {
      const result = await run(
        [
          'nodeRepl.setResponseMeta({ first: "x".repeat(300 * 1024) });',
          'nodeRepl.setResponseMeta({ second: "y".repeat(300 * 1024) });',
        ].join('\n'),
      );
      expect(result.status).toBe('error');
      expect(result.error?.message).toMatch(/metadata is too large/);
      expect(result.responseMeta?.['first']).toHaveLength(300 * 1024);
      expect(result.responseMeta?.['second']).toBeUndefined();
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
        'const pkg = await import("reset-esm"); `${typeof gone}|${pkg.tag}`;',
      );
      expect(texts(result)).toEqual(['undefined|retained']);
      expect(result.stats.pid).not.toBe(oldPid);
      expect(result.stats.generation).toBeGreaterThan(oldGeneration);
    },
    TEST_TIMEOUT,
  );

  it(
    'kills timed-out and cancelled generations without replaying source',
    async () => {
      await run('const oldBinding = "gone";');
      const timeoutPid = manager.getKernelPid();
      const timedOut = await run('while (true) {}', 500);
      expect(timedOut.status).toBe('timeout');
      expect(timedOut.stats.kernelReplaced).toBe(true);
      expect(manager.getKernelPid()).toBeNull();

      const controller = new AbortController();
      const pending = manager.exec({
        code: 'await new Promise((resolve) => setTimeout(resolve, 60_000));',
        timeoutMs: 120_000,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 200);
      const cancelled = await pending;
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.stats.kernelReplaced).toBe(true);
      expect(cancelled.stats.pid).not.toBe(timeoutPid);

      const recovered = await run('typeof oldBinding;');
      expect(texts(recovered)).toEqual(['undefined']);
      expect(recovered.stats.pid).not.toBe(cancelled.stats.pid);
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

      const recovered = await run('typeof crashBinding;');
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
    'keeps model-added packages untrusted',
    async () => {
      const root = path.join(workDir, 'node_modules');
      createEsmPackage(
        root,
        'plain-fixture',
        'export const authority = [typeof nodeRepl.callHost, typeof process].join("/");',
      );
      await manager.addModuleRoot(root);
      const result = await run(
        'const fixture = await import("plain-fixture"); fixture.authority;',
      );
      expect(texts(result)).toEqual(['undefined/undefined']);
    },
    TEST_TIMEOUT,
  );

  it(
    'allows only a hash-pinned host package to use an exact host capability',
    async () => {
      const root = path.join(workDir, 'node_modules');
      const source = [
        'let calls = 0;',
        'export const privileged = typeof nodeRepl.callHost === "function";',
        'export const runtimeFrozen = Object.isFrozen(nodeRepl);',
        'export const processFacade = [typeof process, typeof process.cwd, Object.keys(process.env).length].join("/");',
        'export async function echo(value) { return nodeRepl.callHost("fixture.echo", { value }); }',
        'export async function unknown() { return nodeRepl.callHost("fixture.missing", null); }',
        'export async function inherited() { return nodeRepl.callHost("constructor", { escaped: true }); }',
        'export function bump() { return ++calls; }',
      ].join('\n');
      const entry = createEsmPackage(root, 'trusted-fixture', source);
      createEsmPackage(root, 'unapproved-sibling', 'export const value = 1;');
      const digest = createHash('sha256')
        .update(fs.readFileSync(entry))
        .digest('hex');
      const executionSignals: AbortSignal[] = [];
      const generationSignals: AbortSignal[] = [];
      manager.dispose();
      manager = makeManager({
        policy: new NodeReplSecurityPolicy([
          {
            root,
            packageName: 'trusted-fixture',
            entryPath: entry,
            entrySha256: digest,
            allowModelImport: true,
          },
        ]),
        capabilities: {
          'fixture.echo': (args, context) => {
            executionSignals.push(context.signal);
            generationSignals.push(context.generationSignal);
            return { echoed: args };
          },
        },
      });
      expect(manager.getModuleRoots()).toEqual([]);
      expect((await run('await import("unapproved-sibling");')).status).toBe(
        'error',
      );

      const result = await run(
        [
          'const fixture = await import("trusted-fixture");',
          'let constructorProbe;',
          'try { fixture.echo.constructor("return process")(); } catch (error) { constructorProbe = error.name; }',
          'const echoed = await fixture.echo("ok");',
          '`${fixture.privileged}|${fixture.runtimeFrozen}|${Object.isFrozen(nodeRepl)}|${fixture.processFacade}|${typeof nodeRepl.callHost}|${constructorProbe}|${echoed.echoed.value}|${fixture.bump()}`;',
        ].join('\n'),
      );
      expect(result.status).toBe('ok');
      expect(texts(result)).toEqual([
        'true|true|true|object/function/0|undefined|EvalError|ok|1',
      ]);
      expect(executionSignals[0]?.aborted).toBe(true);
      expect(generationSignals[0]?.aborted).toBe(false);

      const denied = await run(
        [
          'const fixture = await import("trusted-fixture");',
          'let capabilityErrorProbe;',
          'let capabilityMessage;',
          'const cachedCall = fixture.bump();',
          'try { await fixture.unknown(); } catch (error) {',
          '  capabilityMessage = error.message;',
          '  try { error.constructor.constructor("return process")(); } catch (inner) { capabilityErrorProbe = inner.name; }',
          '}',
          '`${capabilityMessage}|${capabilityErrorProbe}|${cachedCall}`;',
        ].join('\n'),
      );
      expect(denied.status).toBe('ok');
      expect(texts(denied)[0]).toMatch(/not registered\|EvalError\|2/);

      const inherited = await run(
        [
          'const fixture = await import("trusted-fixture");',
          'let inheritedMessage;',
          'try { await fixture.inherited(); } catch (error) { inheritedMessage = error.message; }',
          'inheritedMessage;',
        ].join('\n'),
      );
      expect(inherited.status).toBe('ok');
      expect(texts(inherited)).toEqual(['host capability is not registered']);

      await manager.reset();
      expect(generationSignals[0]?.aborted).toBe(true);
      const resetSingleton = await run(
        [
          'const fixture = await import("trusted-fixture");',
          'const echoed = await fixture.echo("again");',
          '`${fixture.bump()}|${echoed.echoed.value}`;',
        ].join('\n'),
      );
      expect(texts(resetSingleton)).toEqual(['1|again']);
      expect(executionSignals[1]?.aborted).toBe(true);
      expect(generationSignals[1]).not.toBe(generationSignals[0]);
      expect(generationSignals[1]?.aborted).toBe(false);
      manager.dispose();
      expect(generationSignals[1]?.aborted).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'loads a trusted ESM package outside ordinary readable roots',
    async () => {
      const trustedParent = fs.mkdtempSync(
        path.join(os.tmpdir(), 'node-repl-trusted-package-'),
      );
      const root = path.join(trustedParent, 'node_modules');
      const entry = createEsmPackage(
        root,
        'external-trusted-fixture',
        'export const privileged = typeof nodeRepl.callHost === "function";',
      );
      const digest = createHash('sha256')
        .update(fs.readFileSync(entry))
        .digest('hex');
      manager.dispose();
      manager = makeManager({
        policy: new NodeReplSecurityPolicy([
          {
            root,
            packageName: 'external-trusted-fixture',
            entryPath: entry,
            entrySha256: digest,
            allowModelImport: true,
          },
        ]),
      });

      try {
        const result = await run(
          'const fixture = await import("external-trusted-fixture"); fixture.privileged;',
        );
        expect(result.status).toBe('ok');
        expect(texts(result)).toEqual(['true']);
      } finally {
        manager.dispose();
        fs.rmSync(trustedParent, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'authenticates capability requests against the live execution',
    async () => {
      let calls = 0;
      manager.dispose();
      manager = makeManager({
        capabilities: {
          'fixture.echo': () => {
            calls += 1;
            return null;
          },
        },
      });
      const pending = run(
        'await new Promise((resolve) => setTimeout(resolve, 1000));',
      );
      const internals = manager as unknown as {
        kernel: { capabilityToken: string; generation: number } | null;
        inflight: { execId: string } | null;
        handleFrame: (handle: object, frame: unknown) => void;
      };
      for (let attempt = 0; attempt < 200; attempt++) {
        if (internals.kernel && internals.inflight) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const handle = internals.kernel;
      const inflight = internals.inflight;
      expect(handle).not.toBeNull();
      expect(inflight).not.toBeNull();
      if (!handle || !inflight) throw new Error('execution did not start');

      const base = {
        type: 'capabilityRequest',
        capabilityToken: handle.capabilityToken,
        generation: handle.generation,
        execId: inflight.execId,
        operation: 'fixture.echo',
        argsJson: 'null',
      };
      internals.handleFrame(handle, {
        ...base,
        capabilityRequestId: 'wrong-token',
        capabilityToken: 'wrong',
      });
      internals.handleFrame(handle, {
        ...base,
        capabilityRequestId: 'wrong-generation',
        generation: handle.generation + 1,
      });
      internals.handleFrame(handle, {
        ...base,
        capabilityRequestId: 'stale-execution',
        execId: 'stale',
      });
      internals.handleFrame(handle, {
        ...base,
        capabilityRequestId: 'unknown-operation',
        operation: 'fixture.missing',
      });
      internals.handleFrame(handle, {
        ...base,
        capabilityRequestId: 'duplicate',
      });
      internals.handleFrame(handle, {
        ...base,
        capabilityRequestId: 'duplicate',
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(calls).toBe(1);
      expect((await pending).status).toBe('ok');
    },
    TEST_TIMEOUT,
  );

  it(
    'rejects a trusted package whose entry hash changed',
    async () => {
      const root = path.join(workDir, 'node_modules');
      const entry = createEsmPackage(
        root,
        'changed-fixture',
        'export const value = 1;',
      );
      manager.dispose();
      manager = makeManager({
        policy: new NodeReplSecurityPolicy([
          {
            root,
            packageName: 'changed-fixture',
            entryPath: entry,
            entrySha256: '0'.repeat(64),
            allowModelImport: true,
          },
        ]),
      });
      const result = await run('await import("changed-fixture");');
      expect(result.status).toBe('error');
      expect(result.error?.message).toMatch(/sha256/);
    },
    TEST_TIMEOUT,
  );

  it(
    'rejects a hash-matching trusted package whose resolved entry path changed',
    async () => {
      const root = path.join(workDir, 'node_modules');
      const source = 'export const value = 1;';
      const entry = createEsmPackage(root, 'entry-pinned-fixture', source);
      const alternate = path.join(path.dirname(entry), 'alternate.js');
      fs.writeFileSync(alternate, source);
      const digest = createHash('sha256')
        .update(fs.readFileSync(entry))
        .digest('hex');
      manager.dispose();
      manager = makeManager({
        policy: new NodeReplSecurityPolicy([
          {
            root,
            packageName: 'entry-pinned-fixture',
            entryPath: entry,
            entrySha256: digest,
            allowModelImport: true,
          },
        ]),
      });
      fs.writeFileSync(
        path.join(path.dirname(entry), 'package.json'),
        JSON.stringify({
          name: 'entry-pinned-fixture',
          version: '1.0.0',
          type: 'module',
          exports: './alternate.js',
        }),
      );

      const result = await run('await import("entry-pinned-fixture");');
      expect(result.status).toBe('error');
      expect(result.error?.message).toMatch(/unapproved entry path/);
    },
    TEST_TIMEOUT,
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a hash-matching trusted package if its root target changes',
    async () => {
      const root = path.join(workDir, 'node_modules');
      const source = 'export const value = "approved";';
      const entry = createEsmPackage(root, 'root-pinned-fixture', source);
      const digest = createHash('sha256')
        .update(fs.readFileSync(entry))
        .digest('hex');
      manager.dispose();
      manager = makeManager({
        policy: new NodeReplSecurityPolicy([
          {
            root,
            packageName: 'root-pinned-fixture',
            entryPath: entry,
            entrySha256: digest,
            allowModelImport: true,
          },
        ]),
      });

      const outside = fs.mkdtempSync(
        path.join(os.tmpdir(), 'node-repl-replaced-trust-root-'),
      );
      const replacementRoot = path.join(outside, 'node_modules');
      createEsmPackage(replacementRoot, 'root-pinned-fixture', source);
      try {
        fs.rmSync(root, { recursive: true, force: true });
        fs.symlinkSync(replacementRoot, root, 'dir');
        const denied = await run('await import("root-pinned-fixture");');
        expect(denied.status).toBe('error');
        expect(denied.error?.message).toMatch(/trusted package root changed/);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT,
  );

  it.skipIf(process.platform === 'win32')(
    'revokes a trusted workspace package if its symlink target changes',
    async () => {
      const root = path.join(workDir, 'node_modules');
      fs.mkdirSync(root);
      const source = 'export const value = "approved";';
      const createWorkspaceTarget = (name: string) => {
        const packageDir = path.join(workDir, name);
        fs.mkdirSync(packageDir);
        fs.writeFileSync(
          path.join(packageDir, 'package.json'),
          JSON.stringify({ type: 'module', exports: './index.js' }),
        );
        const entryPath = path.join(packageDir, 'index.js');
        fs.writeFileSync(entryPath, source);
        return { packageDir, entryPath };
      };
      const first = createWorkspaceTarget('workspace-first');
      const second = createWorkspaceTarget('workspace-second');
      const linkedPackage = path.join(root, 'workspace-fixture');
      fs.symlinkSync(first.packageDir, linkedPackage, 'dir');
      const digest = createHash('sha256')
        .update(fs.readFileSync(first.entryPath))
        .digest('hex');
      manager.dispose();
      manager = makeManager({
        policy: new NodeReplSecurityPolicy([
          {
            root,
            packageName: 'workspace-fixture',
            entryPath: first.entryPath,
            entrySha256: digest,
            allowModelImport: true,
          },
        ]),
      });

      fs.unlinkSync(linkedPackage);
      fs.symlinkSync(second.packageDir, linkedPackage, 'dir');
      const denied = await run('await import("workspace-fixture");');
      expect(denied.status).toBe('error');
      expect(denied.error?.message).toMatch(/package directory changed/);
    },
    TEST_TIMEOUT,
  );

  it(
    'denies trusted-package files that are not explicitly hash-pinned',
    async () => {
      const root = path.join(workDir, 'node_modules');
      const entry = createEsmPackage(
        root,
        'dependent-fixture',
        'import "./dependency.js"; export const value = 1;',
      );
      fs.writeFileSync(
        path.join(path.dirname(entry), 'dependency.js'),
        'export const dependency = true;',
      );
      const digest = createHash('sha256')
        .update(fs.readFileSync(entry))
        .digest('hex');
      manager.dispose();
      manager = makeManager({
        policy: new NodeReplSecurityPolicy([
          {
            root,
            packageName: 'dependent-fixture',
            entryPath: entry,
            entrySha256: digest,
            allowModelImport: true,
          },
        ]),
      });
      const result = await run('await import("dependent-fixture");');
      expect(result.status).toBe('error');
      expect(result.error?.message).toMatch(/unapproved file/);
    },
    TEST_TIMEOUT,
  );

  it(
    'loads only hash-pinned trusted files and declared trusted packages',
    async () => {
      const root = path.join(workDir, 'node_modules');
      const dependencyEntry = createEsmPackage(
        root,
        'trusted-dependency',
        'export const dependency = 40;',
      );
      const unlistedEntry = createEsmPackage(
        root,
        'unlisted-dependency',
        'export const value = 1;',
      );
      const entry = createEsmPackage(
        root,
        'trusted-multifile',
        [
          'import { helper } from "./helper.js";',
          'import { dependency } from "trusted-dependency";',
          'export const value = helper + dependency;',
          'export const loadUnlisted = () => import("unlisted-dependency");',
          'export const loadBuiltin = () => import("node:path");',
        ].join('\n'),
      );
      const helperPath = path.join(path.dirname(entry), 'helper.js');
      fs.writeFileSync(helperPath, 'export const helper = 2;');
      const digest = (filePath: string) =>
        createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
      manager.dispose();
      manager = makeManager({
        policy: new NodeReplSecurityPolicy([
          {
            root,
            packageName: 'trusted-multifile',
            entryPath: entry,
            entrySha256: digest(entry),
            additionalFiles: [{ path: helperPath, sha256: digest(helperPath) }],
            dependencies: ['trusted-dependency'],
            allowModelImport: true,
          },
          {
            root,
            packageName: 'trusted-dependency',
            entryPath: dependencyEntry,
            entrySha256: digest(dependencyEntry),
          },
          {
            root,
            packageName: 'unlisted-dependency',
            entryPath: unlistedEntry,
            entrySha256: digest(unlistedEntry),
          },
        ]),
      });

      const result = await run(
        'const fixture = await import("trusted-multifile"); fixture.value;',
      );
      expect(result.status).toBe('ok');
      expect(texts(result)).toEqual(['42']);

      await manager.addModuleRoot(root);
      const hiddenDependency = await run('await import("trusted-dependency");');
      expect(hiddenDependency.status).toBe('error');
      expect(hiddenDependency.error?.message).toMatch(/not available to model/);
      const directTrustedFile = await run(
        `await import(${JSON.stringify(pathToFileURL(helperPath).href)});`,
      );
      expect(directTrustedFile.status).toBe('error');
      expect(directTrustedFile.error?.message).toMatch(
        /require an approved package import/,
      );

      const denied = await run(
        [
          'const deniedMessages = [];',
          'for (const load of [fixture.loadUnlisted, fixture.loadBuiltin]) {',
          '  try { await load(); } catch (error) { deniedMessages.push(error.message); }',
          '}',
          'deniedMessages.join("|");',
        ].join('\n'),
      );
      expect(texts(denied)[0]).toMatch(
        /no approved dependency.*Node builtin.*is not available/,
      );

      await manager.reset();
      fs.writeFileSync(helperPath, 'export const helper = 3;');
      const changed = await run('await import("trusted-multifile");');
      expect(changed.status).toBe('error');
      expect(changed.error?.message).toMatch(/sha256 verification/);
    },
    TEST_TIMEOUT,
  );

  it(
    'revokes an in-flight trusted request when execution is cancelled',
    async () => {
      const root = path.join(workDir, 'node_modules');
      const source =
        'export async function wait() { return nodeRepl.callHost("fixture.wait", null); }';
      const entry = createEsmPackage(root, 'waiting-fixture', source);
      const digest = createHash('sha256')
        .update(fs.readFileSync(entry))
        .digest('hex');
      let hostSignalAborted = false;
      let markHostStarted: (() => void) | undefined;
      const hostStarted = new Promise<void>((resolve) => {
        markHostStarted = resolve;
      });
      manager.dispose();
      manager = makeManager({
        policy: new NodeReplSecurityPolicy([
          {
            root,
            packageName: 'waiting-fixture',
            entryPath: entry,
            entrySha256: digest,
            allowModelImport: true,
          },
        ]),
        capabilities: {
          'fixture.wait': (_args, context) => {
            markHostStarted?.();
            return new Promise((resolve) => {
              context.signal.addEventListener(
                'abort',
                () => {
                  hostSignalAborted = true;
                  resolve(null);
                },
                { once: true },
              );
            });
          },
        },
      });
      const controller = new AbortController();
      const pending = manager.exec({
        code: 'const fixture = await import("waiting-fixture"); await fixture.wait();',
        timeoutMs: EXEC_TIMEOUT,
        signal: controller.signal,
      });
      await hostStarted;
      controller.abort();
      const result = await pending;
      expect(result.status).toBe('cancelled');
      expect(hostSignalAborted).toBe(true);
      expect(manager.getKernelPid()).toBeNull();
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
    'revokes a cold kernel if cancellation lands during startup',
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
      expect(cancelled.stats.kernelReplaced).toBe(true);
      expect(manager.getKernelPid()).toBeNull();
      expect(texts(await run('"alive";'))).toEqual(['alive']);
    },
    TEST_TIMEOUT,
  );

  it(
    'clamps oversized timeouts and serializes concurrent calls',
    async () => {
      const largeTimeout = manager.exec({
        code: 'let order = "a"; order;',
        timeoutMs: 2 ** 31 + 1000,
      });
      const second = run('order += "b";');
      const third = run('order += "c";');
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
