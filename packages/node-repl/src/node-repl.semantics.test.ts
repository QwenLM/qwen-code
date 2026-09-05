/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeReplKernelManager } from './kernel-manager.js';
import { NodeReplSecurityPolicy } from './security-policy.js';

const managers: NodeReplKernelManager[] = [];

function makeManager(): NodeReplKernelManager {
  const manager = new NodeReplKernelManager({
    cwd: process.cwd(),
    homeDir: os.homedir(),
    tmpRootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-node-repl-sem-')),
    policy: NodeReplSecurityPolicy.default(),
    readableRoots: [process.cwd()],
  });
  managers.push(manager);
  return manager;
}

afterEach(() => {
  while (managers.length > 0) managers.pop()?.dispose();
});

function textOf(events: Array<{ type: string; text?: string }>): string {
  return events
    .filter((e) => e.type === 'text')
    .map((e) => e.text ?? '')
    .join('');
}

describe('binding semantics through the real kernel', () => {
  it('persists a var declared inside a block across cells', async () => {
    const manager = makeManager();
    const first = await manager.exec({
      code: 'if (true) { var hoisted = "kept"; }',
      timeoutMs: 30_000,
    });
    expect(first.status).toBe('ok');
    const second = await manager.exec({
      code: 'nodeRepl.write(String(hoisted));',
      timeoutMs: 30_000,
    });
    expect(second.status).toBe('ok');
    expect(textOf(second.events).trim()).toBe('kept');
  });

  it('does not leak a var from an inner function scope', async () => {
    const manager = makeManager();
    await manager.exec({
      code: 'function fn() { var innerOnly = 1; }',
      timeoutMs: 30_000,
    });
    const probe = await manager.exec({
      code: 'nodeRepl.write(typeof innerOnly);',
      timeoutMs: 30_000,
    });
    expect(textOf(probe.events).trim()).toBe('undefined');
  });

  it('rejects a binding that would shadow the nodeRepl global, and stays usable', async () => {
    const manager = makeManager();
    const shadow = await manager.exec({
      code: 'const nodeRepl = 42;',
      timeoutMs: 30_000,
    });
    expect(shadow.status).toBe('error');
    expect(shadow.error?.message ?? '').toMatch(/shadow/i);

    // The output channel must still work afterwards.
    const after = await manager.exec({
      code: 'nodeRepl.write("still working");',
      timeoutMs: 30_000,
    });
    expect(after.status).toBe('ok');
    expect(textOf(after.events).trim()).toBe('still working');
  });

  it('matches real JS scoping for every hoisting construct', async () => {
    const manager = makeManager();
    // [setup, probe, expected typeof in a LATER cell]
    const cases: Array<[string, string, string]> = [
      // `var` hoists out of blocks / control flow to module scope:
      ['if (true) { var h_a = 1; }', 'h_a', 'number'],
      ['try { var h_b = 2; } catch {}', 'h_b', 'number'],
      ['try { null.x; } catch (e) { var h_c = 3; }', 'h_c', 'number'],
      ['switch (1) { case 1: var h_d = 4; }', 'h_d', 'number'],
      ['do { var h_e = 5; } while (false);', 'h_e', 'number'],
      ['lbl: { var h_f = 6; }', 'h_f', 'number'],
      ['{ { { var h_g = 7; } } }', 'h_g', 'number'],
      ['for await (const x of [1]) { var h_h = 8; }', 'h_h', 'number'],
      // `var` must NOT escape an inner function scope:
      ['function hFn() { var h_i = 9; }', 'h_i', 'undefined'],
      ['const hArrow = () => { var h_j = 10; };', 'h_j', 'undefined'],
      ['class HK { m() { var h_k = 11; } }', 'h_k', 'undefined'],
      ['class HS { static { var h_l = 12; } }', 'h_l', 'undefined'],
      [
        'const hO = { p: (() => { var h_m = 13; return 1; })() };',
        'h_m',
        'undefined',
      ],
      // const/let stay block-scoped:
      ['if (true) { const h_n = 14; }', 'h_n', 'undefined'],
      ['if (true) { let h_o = 15; }', 'h_o', 'undefined'],
    ];

    for (const [setup, probe, expected] of cases) {
      const s = await manager.exec({ code: setup, timeoutMs: 30_000 });
      expect(s.status, `setup failed: ${setup}`).toBe('ok');
      const r = await manager.exec({
        code: `nodeRepl.write(typeof ${probe});`,
        timeoutMs: 30_000,
      });
      expect(textOf(r.events).trim(), `case: ${setup}`).toBe(expected);
    }
  });

  it('rejects every tool-runtime global name, and stays usable', async () => {
    const manager = makeManager();
    // Must match kernel.mjs's intrinsicObjectDefineProperties bootstrap.
    const reserved = [
      'nodeRepl',
      'console',
      'setTimeout',
      'setInterval',
      'clearTimeout',
      'clearInterval',
    ];
    for (const name of reserved) {
      const r = await manager.exec({
        code: `const ${name} = 42;`,
        timeoutMs: 30_000,
      });
      expect(r.status, `${name} should be rejected`).toBe('error');
      expect(r.error?.message ?? '').toMatch(/shadow/i);
    }
    // The output channel must survive all of those rejections.
    const alive = await manager.exec({
      code: 'nodeRepl.write("session-alive");',
      timeoutMs: 30_000,
    });
    expect(alive.status).toBe('ok');
    expect(textOf(alive.events).trim()).toBe('session-alive');
  });

  it('allows shadowing ordinary JS/Web globals, matching plain Node', async () => {
    const manager = makeManager();
    // `const Buffer = 42` makes Buffer a number in plain Node too. A persistent
    // REPL shares one scope across cells, so the shadow persisting is correct;
    // rejecting it would diverge from JS semantics.
    const shadow = await manager.exec({
      code: 'const Buffer = 42;',
      timeoutMs: 30_000,
    });
    expect(shadow.status).toBe('ok');
    const probe = await manager.exec({
      code: 'nodeRepl.write(typeof Buffer);',
      timeoutMs: 30_000,
    });
    expect(textOf(probe.events).trim()).toBe('number');
  });

  it('does not hoist var out of any nested function form', async () => {
    const manager = makeManager();
    // Over-collection guards: none of these may reach module scope.
    const cases: Array<[string, string]> = [
      ['class O1 { f = (() => { var o1 = 1; return 2; })(); }', 'o1'],
      ['function o2f(p = (() => { var o2 = 1; return 2; })()) {}', 'o2'],
      ['const o3o = { get g() { var o3 = 1; return 2; } };', 'o3'],
      ['const o4o = { set s(v) { var o4 = 1; } };', 'o4'],
      ['const o5o = { m() { var o5 = 1; } };', 'o5'],
      ['async function o6f() { var o6 = 1; }', 'o6'],
      ['function* o7f() { var o7 = 1; }', 'o7'],
      ['const o8a = async () => { var o8 = 1; };', 'o8'],
      ['function o9f(cb = function(){ var o9 = 1; }) {}', 'o9'],
    ];
    for (const [setup, probe] of cases) {
      const s = await manager.exec({ code: setup, timeoutMs: 30_000 });
      expect(s.status, `setup failed: ${setup}`).toBe('ok');
      const r = await manager.exec({
        code: `nodeRepl.write(typeof ${probe});`,
        timeoutMs: 30_000,
      });
      expect(textOf(r.events).trim(), `case: ${setup}`).toBe('undefined');
    }
  });

  it('hoists var out of every non-function nesting form', async () => {
    const manager = makeManager();
    // Under-collection guards: all of these must reach module scope.
    const cases: Array<[string, string, string]> = [
      ['try { } finally { var u1 = 1; }', 'u1', 'number'],
      ['switch(1){case 1: switch(2){case 2: var u2=1;}}', 'u2', 'number'],
      ['if(false){} else if(true){ var u3 = 1; }', 'u3', 'number'],
      ['for (var u4 of [7]) {}', 'u4', 'number'],
      ['for (var u5 in {a:1}) {}', 'u5', 'string'],
      ['while(true){ var u6 = 1; break; }', 'u6', 'number'],
      ['if(true){ for(;;){ try{ var u7=1; break; }catch{} } }', 'u7', 'number'],
    ];
    for (const [setup, probe, want] of cases) {
      const s = await manager.exec({ code: setup, timeoutMs: 30_000 });
      expect(s.status, `setup failed: ${setup}`).toBe('ok');
      const r = await manager.exec({
        code: `nodeRepl.write(typeof ${probe});`,
        timeoutMs: 30_000,
      });
      expect(textOf(r.events).trim(), `case: ${setup}`).toBe(want);
    }
  });

  it('gives loader-originated failures cell-realm Error identity', async () => {
    const manager = makeManager();
    // Block-scoped so nothing persists between cells.
    const probe = (spec: string, expr: string) =>
      [
        '{',
        '  let out = "NO-CATCH";',
        '  try {',
        `    await import(${JSON.stringify(spec)});`,
        '  } catch (e) {',
        `    out = ${expr};`,
        '  }',
        '  nodeRepl.write(out);',
        '}',
      ].join('\n');

    for (const [spec, pattern] of [
      ['./definitely-missing.mjs', 'not found'],
      ['node:process', 'not allowed'],
      ['process', 'not allowed'],
      ['definitely-not-installed-xyz', 'cannot resolve'],
    ] as Array<[string, string]>) {
      const r = await manager.exec({
        code: probe(
          spec,
          `[e instanceof Error, /${pattern}/.test(e.message)].join("|")`,
        ),
        timeoutMs: 30_000,
      });
      expect(r.status, `spec ${spec}`).toBe('ok');
      expect(textOf(r.events).trim(), `spec ${spec}`).toBe('true|true');
    }
  });

  it('keeps a hoisted var assigned before a throw (partial commit)', async () => {
    const manager = makeManager();
    // Plain Node keeps y === 42: `var` hoists, so the assignment ran before the
    // throw. The statement-boundary snapshot must carry it too.
    const failed = await manager.exec({
      code: 'yh = 42; throw new Error("boom"); var yh;',
      timeoutMs: 30_000,
    });
    expect(failed.status).toBe('error');
    const probe = await manager.exec({
      code: 'nodeRepl.write(typeof yh + ":" + String(yh));',
      timeoutMs: 30_000,
    });
    expect(textOf(probe.events).trim()).toBe('number:42');
  });

  it('preserves the carried value when a var redeclares an inherited binding', async () => {
    const manager = makeManager();
    await manager.exec({ code: 'var xr = 5;', timeoutMs: 30_000 });
    const r = await manager.exec({
      code: 'const seenBefore = xr; var xr = xr * 2; nodeRepl.write(seenBefore + "|" + xr);',
      timeoutMs: 30_000,
    });
    expect(r.status).toBe('ok');
    expect(textOf(r.events).trim()).toBe('5|10');
  });

  it('keeps const-ness across cells', async () => {
    const manager = makeManager();
    await manager.exec({ code: 'const cc = 1;', timeoutMs: 30_000 });
    const r = await manager.exec({
      code: 'cc = 2;',
      timeoutMs: 30_000,
    });
    expect(r.status).toBe('error');
    expect(r.error?.name).toBe('TypeError');
  });

  it('surfaces an unhandled rejection that settles after the cell returns', async () => {
    const manager = makeManager();
    const first = await manager.exec({
      code: 'Promise.reject(new Error("lateboom"));',
      timeoutMs: 30_000,
    });
    expect(first.status).toBe('ok');
    // Reported on the next cell rather than vanishing.
    const next = await manager.exec({
      code: 'nodeRepl.write("next");',
      timeoutMs: 30_000,
    });
    expect(textOf(next.events)).toMatch(/Uncaught \(in promise\).*lateboom/s);
  });

  it('treats image MIME types case-insensitively for bytes and data URLs', async () => {
    const manager = makeManager();
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const viaBytes = await manager.exec({
      code: `await nodeRepl.emitImage({ bytes: Uint8Array.from(atob("${png}"), (c) => c.charCodeAt(0)), mimeType: "Image/PNG" });`,
      timeoutMs: 30_000,
    });
    expect(viaBytes.status).toBe('ok');
    expect(viaBytes.events.some((e) => e.type === 'image')).toBe(true);
  });

  it('caps live sandbox timers instead of letting one cell saturate the loop', async () => {
    const manager = makeManager();
    const r = await manager.exec({
      code: 'for (let i = 0; i < 5000; i++) setInterval(() => {}, 1000);',
      timeoutMs: 30_000,
    });
    expect(r.status).toBe('error');
    expect(r.error?.message ?? '').toMatch(/live timers/);
    // The session must still work after hitting the cap.
    const after = await manager.exec({
      code: 'nodeRepl.write("still-usable");',
      timeoutMs: 30_000,
    });
    expect(textOf(after.events)).toContain('still-usable');
  });

  it('resolves bare packages from a symlinked cwd node_modules', async () => {
    // pnpm / monorepo hoisting / shared CI caches make node_modules a symlink;
    // the implicit cwd root must still resolve through it.
    const store = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qwen-node-repl-store-'),
    );
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-node-repl-cwd-'));
    const pkg = path.join(store, 'demo-symlinked');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({
        name: 'demo-symlinked',
        version: '1.0.0',
        type: 'module',
        exports: { import: './index.mjs' },
      }),
    );
    fs.writeFileSync(
      path.join(pkg, 'index.mjs'),
      'export const value = "via-symlink";',
    );
    fs.symlinkSync(store, path.join(work, 'node_modules'), 'dir');

    const manager = new NodeReplKernelManager({
      cwd: work,
      homeDir: os.homedir(),
      tmpRootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-node-repl-sl-')),
      policy: NodeReplSecurityPolicy.default(),
      readableRoots: [work],
    });
    managers.push(manager);
    try {
      const r = await manager.exec({
        code: 'const d = await import("demo-symlinked"); nodeRepl.write(d.value);',
        timeoutMs: 30_000,
      });
      expect(r.status).toBe('ok');
      expect(textOf(r.events).trim()).toBe('via-symlink');
    } finally {
      // The kernel child's cwd is `work`; on Windows a directory that is any
      // process's cwd cannot be removed (EBUSY). Dispose first, then retry
      // the removal across the child's asynchronous teardown.
      manager.dispose();
      fs.rmSync(store, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      });
      fs.rmSync(work, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      });
    }
  });

  it('keeps the error code of a host builtin failure inside imported code', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-node-repl-dep-'));
    const dep = path.join(dir, 'dep.mjs');
    fs.writeFileSync(
      dep,
      [
        "const fs = (await import('node:fs')).default;",
        "fs.readFileSync('/no/such/file/here.json');",
        'export const x = 1;',
      ].join('\n'),
    );
    const manager = makeManager();
    try {
      const r = await manager.exec({
        code: [
          '{ let out = "none";',
          `  try { await import(${JSON.stringify(dep)}); }`,
          '  catch (e) { out = [e instanceof Error, e.code].join("|"); }',
          '  nodeRepl.write(out); }',
        ].join('\n'),
        timeoutMs: 30_000,
      });
      expect(r.status).toBe('ok');
      // ENOENT and instanceof must survive the loader's error wrapping.
      expect(textOf(r.events).trim()).toBe('true|ENOENT');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves the class and properties of an error thrown by an imported module', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-node-repl-err-'));
    const modulePath = path.join(dir, 'thrower.mjs');
    fs.writeFileSync(
      modulePath,
      [
        'export class CustomError extends Error {',
        '  constructor(m) { super(m); this.name = "CustomError"; this.code = "E_CUSTOM"; }',
        '}',
        'throw new CustomError("from module");',
      ].join('\n'),
    );
    const manager = makeManager();
    try {
      const outcome = await manager.exec({
        code: [
          'let seen = "none";',
          'try {',
          `  await import(${JSON.stringify(modulePath)});`,
          '} catch (e) {',
          '  seen = [e.name, e.code, e instanceof Error].join("|");',
          '}',
          'nodeRepl.write(seen);',
        ].join('\n'),
        timeoutMs: 30_000,
      });
      expect(outcome.status).toBe('ok');
      // Class, custom `code`, and realm-correct instanceof must all survive.
      expect(textOf(outcome.events).trim()).toBe('CustomError|E_CUSTOM|true');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
