/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateMods } from './mod-validation.js';

describe('validateMods', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-mod-validation-'));
    await fs.mkdir(path.join(root, 'hooks'));
    await fs.writeFile(
      path.join(root, 'qwen-extension.json'),
      JSON.stringify({ name: 'mod-fixture', version: '1.0.0' }),
    );
    await fs.writeFile(
      path.join(root, 'hooks/hooks.json'),
      JSON.stringify({ modules: ['./register.mjs'] }),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function source(text: string, filename = 'hooks/register.mjs') {
    await fs.mkdir(path.dirname(path.join(root, filename)), {
      recursive: true,
    });
    await fs.writeFile(path.join(root, filename), text);
  }

  it('returns literal event/API requirements with locations, matcher and catch', async () => {
    await source(`export function register(on) {
      on('tool.call', { tool: 'Bash' }, ($, e, next) => $.session.cwd()).catch(() => {});
    }`);
    const report = await validateMods(root);
    expect(report.static).toEqual({ status: 'valid', complete: true });
    expect(report.runtime).toBe('unavailable');
    expect(report.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'event',
          name: 'tool.call',
          matcher: '{"tool":"Bash"}',
          hasCatch: true,
          line: 2,
          stage: 'M4',
        }),
        expect.objectContaining({ kind: 'api', name: 'session.cwd', line: 2 }),
      ]),
    );
    expect(report.entry).toBe('hooks/register.mjs');
    expect(report.files).toEqual(['hooks/register.mjs']);
  });

  it.each([
    'export function register(on) {}',
    'export const register = (on) => {};',
    'export const register = function (on) {};',
    'function register(on) {} export { register };',
    'const local = (on) => {}; export { local as register };',
  ])('accepts a statically identifiable register export: %s', async (text) => {
    await source(text);
    expect((await validateMods(root)).static.status).toBe('valid');
  });

  it.each([
    'export default function register(on) {}',
    'export const register = makeRegister();',
    'export let register = () => {};',
    'export { register } from "./other.mjs";',
  ])('rejects unsupported register exports: %s', async (text) => {
    await source(text);
    await source('export function register() {}', 'hooks/other.mjs');
    expect((await validateMods(root)).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'MOD_ENTRY_EXPORT_INVALID' }),
      ]),
    );
  });

  it.each(['export type { register };', 'export { type register };'])(
    'rejects an erased type-only register export: %s',
    async (declaration) => {
      await fs.writeFile(
        path.join(root, 'hooks/hooks.json'),
        JSON.stringify({ modules: ['./register.ts'] }),
      );
      await source(
        `function register(on: unknown) {} ${declaration}`,
        'hooks/register.ts',
      );
      const report = await validateMods(root);
      expect(report.static).toEqual({ status: 'invalid', complete: true });
      expect(report.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'MOD_ENTRY_EXPORT_INVALID' }),
      );
    },
  );

  it('retains a runtime register export alongside type-only specifiers', async () => {
    await fs.writeFile(
      path.join(root, 'hooks/hooks.json'),
      JSON.stringify({ modules: ['./register.ts'] }),
    );
    await source(
      'type Options = {}; function register(on: unknown) {} export { type Options, register };',
      'hooks/register.ts',
    );
    expect((await validateMods(root)).static).toEqual({
      status: 'valid',
      complete: true,
    });
  });

  it.each(['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx'])(
    'parses ESM %s without executing it',
    async (extension) => {
      await fs.writeFile(
        path.join(root, 'hooks/hooks.json'),
        JSON.stringify({ modules: [`./register.${extension}`] }),
      );
      await source(
        `export function register(on${extension.includes('t') ? ': unknown' : ''}) {}`,
        `hooks/register.${extension}`,
      );
      expect((await validateMods(root)).static.status).toBe('valid');
    },
  );

  it('walks explicit relative imports, side effects and cycles only once', async () => {
    await source(
      "import '../lib/helper.mjs'; import './shared.mjs'; export function register(on) {} ",
    );
    await source(
      "import '../hooks/register.mjs'; import '../hooks/shared.mjs'; export function helper($) { return $.clock.now(); }",
      'lib/helper.mjs',
    );
    await source('export const unused = true;', 'hooks/shared.mjs');
    const report = await validateMods(root);
    expect(report.static.status).toBe('valid');
    expect(report.files).toEqual([
      'hooks/register.mjs',
      'hooks/shared.mjs',
      'lib/helper.mjs',
    ]);
    expect(report.requirements).toEqual([
      expect.objectContaining({
        kind: 'api',
        name: 'clock.now',
        file: 'lib/helper.mjs',
      }),
    ]);
  });

  it('reads a shared source once despite repeated imports and internal symlink aliases', async () => {
    await source('export const value = true;', 'hooks/shared.mjs');
    const imports = Array.from(
      { length: 1000 },
      () => "import './shared.mjs';",
    );
    for (let index = 0; index < 12; index++) {
      await fs.symlink(
        'shared.mjs',
        path.join(root, `hooks/alias-${index}.mjs`),
      );
      imports.push(`import './alias-${index}.mjs';`);
    }
    await source(`${imports.join('\n')} export function register(on) {}`);
    const opened = vi.spyOn(fs, 'open');
    const report = await validateMods(root);
    expect(report.static.status).toBe('valid');
    expect(report.files).toHaveLength(2);
    expect(
      opened.mock.calls.filter(([filename]) =>
        String(filename).endsWith('/shared.mjs'),
      ),
    ).toHaveLength(1);
  });

  it.each([
    "import 'node:fs';",
    "import 'external-package';",
    "import './helper';",
    "import('node:fs');",
    "require('node:fs');",
    "eval('sideEffect()');",
    'new Function("sideEffect()");',
    'const execute = eval; execute("sideEffect()");',
    'const load = require; load("node:fs");',
    'const constructor = Function; constructor("sideEffect()");',
    'module.exports = {};',
    'exports.helper = () => {};',
  ])('rejects unsupported module/loader forms: %s', async (text) => {
    await source(`${text} export function register(on) {}`);
    expect((await validateMods(root)).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'MOD_IMPORT_UNSUPPORTED' }),
      ]),
    );
  });

  it('allows type-only claude-code contracts and flags runtime helpers as deferred', async () => {
    await fs.writeFile(
      path.join(root, 'hooks/hooks.json'),
      JSON.stringify({ modules: ['./register.ts'] }),
    );
    await source(
      "import type { Mod } from 'claude-code'; export function register(on: Mod) {}",
      'hooks/register.ts',
    );
    expect((await validateMods(root)).static.status).toBe('valid');
    await source(
      "import { state } from 'claude-code/state'; export function register(on: unknown) {}",
      'hooks/register.ts',
    );
    expect((await validateMods(root)).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MOD_DEPENDENCY_DEFERRED',
          severity: 'error',
        }),
      ]),
    );
  });

  it.each([
    "globalThis.eval('var x = 1');",
    "new globalThis.Function('return 1');",
    "globalThis['eval']('var x = 1');",
    "new globalThis['Function']('return 1');",
    "globalThis.eval?.('var x = 1');",
    'const generate = globalThis.Function;',
    "globalThis.eval.call(undefined, 'var x = 1');",
  ])('rejects explicit global generated-code access: %s', async (text) => {
    await source(`export function register(on) { ${text} }`);
    const report = await validateMods(root);
    expect(report.static.status).toBe('invalid');
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'MOD_IMPORT_UNSUPPORTED' }),
    );
  });

  it('marks a computed global access incomplete when its property is unknown', async () => {
    await source(
      'export function register(on, property) { globalThis[property]("x"); }',
    );
    expect((await validateMods(root)).static).toEqual({
      status: 'incomplete',
      complete: false,
    });
  });

  it.each([
    '(globalThis as typeof globalThis).eval("x");',
    'globalThis!.eval("x");',
    'new (globalThis satisfies typeof globalThis).Function("return 1");',
    '(<typeof globalThis>globalThis).eval("x");',
    '((globalThis as typeof globalThis)!).eval?.("x");',
  ])(
    'rejects generated-code access through erased TS wrappers: %s',
    async (text) => {
      await fs.writeFile(
        path.join(root, 'hooks/hooks.json'),
        JSON.stringify({ modules: ['./register.ts'] }),
      );
      await source(
        `export function register(on: unknown) { ${text} }`,
        'hooks/register.ts',
      );
      const report = await validateMods(root);
      expect(report.static).toEqual({ status: 'invalid', complete: true });
      expect(report.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'MOD_IMPORT_UNSUPPORTED' }),
      );
    },
  );

  it.each([
    'const globalThis = { eval() {} };',
    'var globalThis = { eval() {} };',
    'function globalThis() {}',
  ])(
    'keeps body bindings out of default parameter evaluation: %s',
    async (body) => {
      await source(
        `export function register(on, options = globalThis.eval("x")) { ${body} }`,
      );
      const report = await validateMods(root);
      expect(report.static).toEqual({ status: 'invalid', complete: true });
      expect(report.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'MOD_IMPORT_UNSUPPORTED' }),
      );
    },
  );

  it.each([
    'const object = { [globalThis.eval("key")](globalThis) {} };',
    'class Local { [globalThis.eval("key")](globalThis) {} }',
    'class Local { static [globalThis.eval("key")](globalThis) {} }',
    'const object = { set [globalThis.eval("key")](globalThis) {} };',
  ])(
    'checks computed method keys outside parameter scope: %s',
    async (text) => {
      await source(`export function register(on) { ${text} }`);
      const report = await validateMods(root);
      expect(report.static).toEqual({ status: 'invalid', complete: true });
      expect(report.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'MOD_IMPORT_UNSUPPORTED' }),
      );
    },
  );

  it.each([
    'const globalThis = { eval() {} }; const object = { [globalThis.eval("key")](globalThis) {} };',
    'const globalThis = { eval() {} }; class Local { [globalThis.eval("key")](globalThis) {} }',
    'const object = { ["key"](globalThis, options = globalThis.eval("key")) { globalThis.eval("x"); } };',
    'class Local { #Function(Function) {} }',
    'class Local { #on(on) {} }',
  ])(
    'preserves outer key bindings and method parameter bindings: %s',
    async (text) => {
      await source(`export function register(on) { ${text} }`);
      const report = await validateMods(root);
      expect(report.static).toEqual({ status: 'valid', complete: true });
      expect(report.diagnostics).toEqual([]);
    },
  );

  it('retains outer event inventory while marking registration-result keys incomplete', async () => {
    await source(`export function register(on) {
      const object = { [on('session.start', () => {})](on) {} };
    }`);
    const report = await validateMods(root);
    expect(report.static).toEqual({ status: 'incomplete', complete: false });
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'MOD_ANALYSIS_INCOMPLETE' }),
    );
    expect(
      report.requirements.map(({ kind, name }) => ({ kind, name })),
    ).toEqual([{ kind: 'event', name: 'session.start' }]);
  });

  it('inventories outer host calls in computed keys despite same-named method parameters', async () => {
    await source(`export function register(on) {
      on('session.start', (ctx) => {
        const object = { [ctx.session.cwd()](ctx) {} };
      });
    }`);
    const report = await validateMods(root);
    expect(report.static).toEqual({ status: 'valid', complete: true });
    expect(
      report.requirements.map(({ kind, name }) => ({ kind, name })),
    ).toEqual([
      { kind: 'event', name: 'session.start' },
      { kind: 'api', name: 'session.cwd' },
    ]);
  });

  it.each([
    'export function register(on) { { var globalThis = { eval() {} }; } globalThis.eval("x"); }',
    '{ var globalThis = { eval() {} }; } export function register(on) { globalThis.eval("x"); }',
    'const local = class globalThis { static eval() {} static value = globalThis.eval("x"); }; export function register(on) {}',
    'export function register(on, globalThis = { eval() {} }, options = globalThis.eval("x")) {}',
    'const globalThis = { eval() {} }; export function register(on, options = globalThis.eval("x")) { const globalThis = {}; }',
    'const local = class { static { { var globalThis = { eval() {} }; } globalThis.eval("x"); } }; export function register(on) {}',
  ])('preserves lexical and hoisted globalThis shadows: %s', async (text) => {
    await source(text);
    const report = await validateMods(root);
    expect(report.static).toEqual({ status: 'valid', complete: true });
    expect(report.diagnostics).toEqual([]);
  });

  it.each([
    'const local = class globalThis { static eval() {} }; globalThis.eval("x"); export function register(on) {}',
    'function helper() { var globalThis = { eval() {} }; } export function register(on) { globalThis.eval("x"); }',
    'const local = class { static { var globalThis = { eval() {} }; } }; export function register(on) { globalThis.eval("x"); }',
  ])('does not leak nested globalThis bindings: %s', async (text) => {
    await source(text);
    expect((await validateMods(root)).static.status).toBe('invalid');
  });

  it('preserves wrapped local receiver shadows in TypeScript', async () => {
    await fs.writeFile(
      path.join(root, 'hooks/hooks.json'),
      JSON.stringify({ modules: ['./register.ts'] }),
    );
    await source(
      'export function register(on: unknown, globalThis: { eval(x: string): void }) { (globalThis as typeof globalThis)!.eval("x"); }',
      'hooks/register.ts',
    );
    expect((await validateMods(root)).static).toEqual({
      status: 'valid',
      complete: true,
    });
  });

  it.each([
    'export function register(on, globalThis) { globalThis.eval("x"); new globalThis.Function("x"); }',
    'const globalThis = { eval() {}, Function: function () {} }; export function register(on) { globalThis.eval("x"); new globalThis.Function("x"); }',
    'export function register(on) { { const globalThis = { eval() {} }; globalThis["eval"]("x"); } }',
    'const local = { eval() {}, Function: function () {} }; export function register(on) { local.eval("x"); new local.Function("x"); }',
    'const local = { eval() {}, Function() {} }; export function register(on) { local.eval("x"); local.Function("x"); }',
    'class Local { eval() {} Function() {} } export function register(on) { const local = new Local(); local.eval("x"); local.Function("x"); }',
  ])(
    'does not confuse local methods with global primitives: %s',
    async (text) => {
      await source(text);
      const report = await validateMods(root);
      expect(report.static).toEqual({ status: 'valid', complete: true });
      expect(report.diagnostics).toEqual([]);
    },
  );

  it.each(['ts', 'mts', 'cts', 'tsx'])(
    'does not treat erased Function annotations as runtime bindings in %s',
    async (extension) => {
      await fs.writeFile(
        path.join(root, 'hooks/hooks.json'),
        JSON.stringify({ modules: [`./register.${extension}`] }),
      );
      await source(
        `import type { Context } from 'claude-code';
      interface Options extends Function { callback: Function; }
      type Callback = Function;
      export function register(on: Function) { on('session.start', ($: Context) => $.session.cwd()); }`,
        `hooks/register.${extension}`,
      );
      const report = await validateMods(root);
      expect(report.static).toEqual({ status: 'valid', complete: true });
      expect(report.requirements.map((item) => item.name)).toEqual([
        'session.start',
        'session.cwd',
      ]);
      expect(report.diagnostics).toEqual([]);
    },
  );

  it('preserves runtime expressions inside erased TypeScript assertions', async () => {
    await fs.writeFile(
      path.join(root, 'hooks/hooks.json'),
      JSON.stringify({ modules: ['./register.ts'] }),
    );
    await source(
      `export function register(on: Function) {
      on('session.start', ($) => ($.session.cwd() as string));
      const generated = (Function('sideEffect()') as unknown);
    }`,
      'hooks/register.ts',
    );
    const report = await validateMods(root);
    expect(report.static.status).toBe('invalid');
    expect(report.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'api', name: 'session.cwd' }),
      ]),
    );
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'MOD_IMPORT_UNSUPPORTED' }),
      ]),
    );
  });

  it('rejects TypeScript CommonJS import-equals syntax', async () => {
    await fs.writeFile(
      path.join(root, 'hooks/hooks.json'),
      JSON.stringify({ modules: ['./register.cts'] }),
    );
    await source(
      "import fs = require('node:fs'); export function register(on: unknown) {}",
      'hooks/register.cts',
    );
    expect((await validateMods(root)).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'MOD_IMPORT_UNSUPPORTED' }),
      ]),
    );
  });

  it('does not let a cached type declaration hide a runtime d.ts import', async () => {
    await fs.writeFile(
      path.join(root, 'hooks/hooks.json'),
      JSON.stringify({ modules: ['./register.ts'] }),
    );
    await source(
      "import type { Value } from './value.d.ts'; import './value.d.ts'; export function register(on: unknown) {}",
      'hooks/register.ts',
    );
    await source('export declare const Value: string;', 'hooks/value.d.ts');
    expect((await validateMods(root)).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'MOD_IMPORT_UNSUPPORTED' }),
      ]),
    );
  });

  it('does not let an internal source symlink turn a declaration file into a runtime module', async () => {
    await fs.writeFile(
      path.join(root, 'hooks/hooks.json'),
      JSON.stringify({ modules: ['./register.ts'] }),
    );
    await source(
      "import type { Value } from './value.d.ts'; import './alias.mjs'; export function register(on: unknown) {}",
      'hooks/register.ts',
    );
    await source('export declare const Value: string;', 'hooks/value.d.ts');
    await fs.symlink('value.d.ts', path.join(root, 'hooks/alias.mjs'));
    expect((await validateMods(root)).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'MOD_IMPORT_UNSUPPORTED' }),
      ]),
    );
  });

  it('does not expose credential URLs from invalid self-type declarations', async () => {
    await fs.writeFile(
      path.join(root, 'qwen-extension.json'),
      JSON.stringify({
        name: 'fixture',
        version: '1',
        types: 'https://SECRET:password@example.com/types.d.ts',
      }),
    );
    await source('export function register(on) {}');
    const report = await validateMods(root);
    expect(report.static.status).toBe('invalid');
    expect(JSON.stringify(report)).not.toContain('SECRET');
    expect(JSON.stringify(report)).not.toContain('password');
  });

  it('anchors rejected import paths to the importing file without repeating the target', async () => {
    await source("import '../../SECRET.mjs'; export function register(on) {}");
    const report = await validateMods(root);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MOD_PATH_OUTSIDE',
          file: 'hooks/register.mjs',
        }),
      ]),
    );
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });

  it.each(['register.TS', 'register.D.TS'])(
    'does not admit undeclared uppercase source suffixes: %s',
    async (filename) => {
      await fs.writeFile(
        path.join(root, 'hooks/hooks.json'),
        JSON.stringify({ modules: [`./${filename}`] }),
      );
      await source('export function register(on) {}', `hooks/${filename}`);
      expect((await validateMods(root)).static.status).toBe('invalid');
    },
  );

  it('ignores comments, strings and same-named local on functions', async () => {
    await source(`// on('fake.event'); $.fake.api();
      const example = "on('fake.event'); $.fake.api();";
      function unrelated(on) { on('also.fake', () => {}); }
      export function register(on) {
        function inner(on) { on('shadow.fake', () => {}); }
        { const on = () => {}; on('block.fake', () => {}); }
        on('session.start', ($) => $.session.cwd());
      }`);
    const report = await validateMods(root);
    expect(report.static.status).toBe('valid');
    expect(report.requirements.map((item) => item.name)).toEqual([
      'session.start',
      'session.cwd',
    ]);
  });

  it.each([
    "const alias = on; alias('session.start', () => {});",
    'on(eventName, () => {});',
    "on('tool.call', matcher, () => {});",
    "on('tool.call', {tool: toolName}, () => {});",
    "on('tool.call', ($) => $['session'].cwd());",
    "on('tool.call', ($) => $.session[method]());",
    "on('tool.call', ($) => { const ui = $.ui; });",
    "on('tool.call', ($) => { const {ui} = $; });",
  ])(
    'marks dynamic or aliased host references incomplete: %s',
    async (text) => {
      await source(`export function register(on) { ${text} }`);
      expect((await validateMods(root)).static).toEqual({
        status: 'incomplete',
        complete: false,
      });
    },
  );

  it('retains unknown literal capabilities as unclassified warnings', async () => {
    await source(
      "export function register(on) { on('future.event', ($) => $.future.method()); }",
    );
    const report = await validateMods(root);
    expect(report.static.status).toBe('valid');
    expect(report.requirements).toEqual([
      expect.objectContaining({
        kind: 'event',
        name: 'future.event',
        stage: 'unclassified',
        hasCatch: false,
      }),
      expect.objectContaining({
        kind: 'api',
        name: 'future.method',
        stage: 'unclassified',
      }),
    ]);
    expect(report.runtime).toBe('unavailable');
    expect(report.diagnostics).toHaveLength(2);
    expect(report.diagnostics.map((item) => item.code)).toEqual([
      'MOD_CAPABILITY_UNCLASSIFIED',
      'MOD_CAPABILITY_UNCLASSIFIED',
    ]);
    expect(
      report.diagnostics.every((item) => item.severity === 'warning'),
    ).toBe(true);
  });

  it.each([
    'function helper(ctx) { ctx.fs.read("x"); }',
    'function helper({fs}) { fs.read("x"); }',
    'const helper = unknown;',
    '',
  ])(
    'does not whitelist passing the host to an unproved helper: %s',
    async (text) => {
      await source(
        `${text} export function register(on) { on('session.start', ($) => helper($)); }`,
      );
      expect((await validateMods(root)).static).toEqual({
        status: 'incomplete',
        complete: false,
      });
    },
  );

  it('inventories a local helper with an explicit host parameter', async () => {
    await source(`function helper($) { return $.fs.read('x'); }
      export function register(on) { on('session.start', ($) => helper($)); }`);
    const report = await validateMods(root);
    expect(report.static.status).toBe('valid');
    expect(report.requirements).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'fs.read' })]),
    );
  });

  it('marks reassigned helpers incomplete', async () => {
    await source(`function helper($) { return $.fs.read('x'); }
      helper = function(ctx) { ctx.fs.exists('x'); };
      export function register(on) { on('session.start', ($) => helper($)); }`);
    expect((await validateMods(root)).static).toEqual({
      status: 'incomplete',
      complete: false,
    });
  });

  it.each([
    'export function register(on) {} register = 123;',
    'export function register(on) { register = 123; }',
    'const local = (on) => {}; export { local as register }; [local] = [123];',
  ])('marks mutations of a register export incomplete: %s', async (text) => {
    await source(text);
    expect((await validateMods(root)).static).toEqual({
      status: 'incomplete',
      complete: false,
    });
  });

  it('inventories renamed host parameters in a direct registration catch handler', async () => {
    await source(
      "export function register(on) { on('tool.call', ($,e,next)=>next(e)).catch((ctx,e,next)=>ctx.process.run(['echo','test'])); }",
    );
    const report = await validateMods(root);
    expect(report.static.status).toBe('valid');
    expect(report.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'tool.call', hasCatch: true }),
        expect.objectContaining({ name: 'process.run' }),
      ]),
    );
  });

  it.each([false, true])(
    'marks an unproved %s imported catch callback incomplete',
    async (imported) => {
      const recover = "function recover(ctx) { ctx.fs.read('x'); }";
      if (imported) {
        await source(`export ${recover}`, 'hooks/recover.mjs');
      }
      await source(
        `${imported ? "import { recover } from './recover.mjs';" : recover}
        export function register(on) { on('tool.call', () => {}).catch(recover); }`,
      );
      const report = await validateMods(root);
      expect(report.static).toEqual({ status: 'incomplete', complete: false });
      expect(report.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'MOD_ANALYSIS_INCOMPLETE' }),
      );
      expect(report.requirements).toContainEqual(
        expect.objectContaining({ name: 'tool.call', hasCatch: true }),
      );
    },
  );

  it('marks a missing catch callback incomplete', async () => {
    await source(
      "export function register(on) { on('tool.call', () => {}).catch(); }",
    );
    expect((await validateMods(root)).static).toEqual({
      status: 'incomplete',
      complete: false,
    });
  });

  it.each([
    "const registration = on('tool.call', ()=>{}); registration.catch((ctx)=>ctx.fs.read('x'));",
    "on('tool.call', ()=>{})['catch']((ctx)=>ctx.fs.read('x'));",
    "const catchHandler = on('tool.call', ()=>{}).catch;",
  ])(
    'marks aliased or computed registration handlers incomplete: %s',
    async (text) => {
      await source(`export function register(on) { ${text} }`);
      expect((await validateMods(root)).static).toEqual({
        status: 'incomplete',
        complete: false,
      });
    },
  );

  it('respects method parameters and named function expression shadows', async () => {
    await source(`export function register(on) {
      const object = { method(on) { on('fake.event', () => {}); } };
      const fn = function on() { on('fake.event', () => {}); };
      on('session.start', () => {});
    }`);
    const report = await validateMods(root);
    expect(report.static.status).toBe('valid');
    expect(report.requirements.map((item) => item.name)).toEqual([
      'session.start',
    ]);
  });

  it('keeps loop-local on shadows out of the enclosing host binding', async () => {
    await source(`export function register(on) {
      for (let on of []) { on('fake.event', () => {}); }
      on('session.start', () => {});
    }`);
    const report = await validateMods(root);
    expect(report.static.status).toBe('valid');
    expect(report.requirements.map((item) => item.name)).toEqual([
      'session.start',
    ]);
  });

  it.each([
    "export function register({on}) { on('session.start', () => {}); }",
    "export function register(on) { {var on = other;} on('session.start', () => {}); }",
    "export function register(on) { var on = other; on('session.start', () => {}); }",
    "export function register(on) { on('session.start', (ctx) => { var ctx = other; ctx.fs.read('x'); }); }",
  ])('marks ambiguous host bindings incomplete: %s', async (text) => {
    await source(text);
    expect((await validateMods(root)).static).toEqual({
      status: 'incomplete',
      complete: false,
    });
  });

  it.each(['var on = () => {};', '{ var on = () => {}; }'])(
    'does not confuse a nested function var with the outer host parameter: %s',
    async (declaration) => {
      await source(`export function register(on) {
      function helper() { ${declaration} on('fake.event', () => {}); }
      on('session.start', () => {});
    }`);
      const report = await validateMods(root);
      expect(report.static).toEqual({ status: 'valid', complete: true });
      expect(report.requirements.map((item) => item.name)).toEqual([
        'session.start',
      ]);
    },
  );

  it('keeps static block vars separate from outer host parameters', async () => {
    await source(`export function register(on) {
      const local = class { static { var on = () => {}; on('fake.event', () => {}); } };
      on('session.start', () => {});
    }`);
    const report = await validateMods(root);
    expect(report.static).toEqual({ status: 'valid', complete: true });
    expect(report.requirements.map((item) => item.name)).toEqual([
      'session.start',
    ]);
  });

  it('recognizes renamed on and callback host formal bindings', async () => {
    await source(
      "export function register(subscribe) { subscribe('session.start', (host) => host.session.cwd()); }",
    );
    const report = await validateMods(root);
    expect(report.static.status).toBe('valid');
    expect(report.requirements.map((item) => item.name)).toEqual([
      'session.start',
      'session.cwd',
    ]);
  });

  it('reads only confined self declaration files without executing them', async () => {
    await fs.writeFile(
      path.join(root, 'qwen-extension.json'),
      JSON.stringify({
        name: 'fixture',
        version: '1',
        types: './types/self.d.ts',
        dependencies: ['other-plugin'],
      }),
    );
    await source('export function register(on) {}');
    await source(
      "import type { External } from 'other-plugin'; export declare const value: External;",
      'types/self.d.ts',
    );
    const report = await validateMods(root);
    expect(report.static.status).toBe('valid');
    expect(report.files).toEqual(['hooks/register.mjs', 'types/self.d.ts']);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MOD_TYPE_RESOLUTION_DEFERRED',
          severity: 'warning',
        }),
        expect.objectContaining({
          code: 'MOD_DEPENDENCY_DEFERRED',
          severity: 'warning',
        }),
      ]),
    );
  });

  it('inventories JSX element syntax without constructing an element', async () => {
    await fs.writeFile(
      path.join(root, 'hooks/hooks.json'),
      JSON.stringify({ modules: ['./register.tsx'] }),
    );
    await source(
      "export function register(on: unknown) { on('ui.render', ($) => <Box><Text>Hello</Text></Box>); }",
      'hooks/register.tsx',
    );
    const report = await validateMods(root);
    expect(report.static.status).toBe('valid');
    expect(
      report.requirements
        .filter((item) => item.kind === 'element')
        .map((item) => item.name),
    ).toEqual(['Box', 'Text']);
  });

  it('does not execute top-level infinite loops, throws or source side effects', async () => {
    await source(`globalThis.__qwenModExecuted = true;
      while (true) {};
      throw new Error('secret fixture text');
      export function register(on) { on('session.start', () => {}); }`);
    const report = await validateMods(root);
    expect(report.static.status).toBe('valid');
    expect('__qwenModExecuted' in globalThis).toBe(false);
    expect(JSON.stringify(report)).not.toContain('secret fixture text');
  });

  it('reports syntax positions without including source or parser error text', async () => {
    await source('export function register( secret-value-is-not-valid {}');
    const report = await validateMods(root);
    expect(report.static.status).toBe('invalid');
    expect(report.diagnostics).toEqual([
      expect.objectContaining({ code: 'MOD_SYNTAX_INVALID', line: 1 }),
    ]);
    expect(JSON.stringify(report)).not.toContain('secret-value');
  });

  it('does not resolve extensionless imports through index files', async () => {
    await source("import '../lib'; export function register(on) {}");
    await source('export const value = true;', 'lib/index.mjs');
    const report = await validateMods(root);
    expect(report.static.status).toBe('invalid');
    expect(report.files).toEqual(['hooks/register.mjs']);
  });

  it('confines every imported file, including symlinks', async () => {
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-mod-outside-'),
    );
    try {
      await fs.writeFile(
        path.join(outside, 'outside.mjs'),
        'throw new Error("do not read");',
      );
      await fs.symlink(
        path.join(outside, 'outside.mjs'),
        path.join(root, 'hooks/link.mjs'),
      );
      await source("import './link.mjs'; export function register(on) {}");
      const report = await validateMods(root);
      expect(report.static.status).toBe('invalid');
      expect(report.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'MOD_PATH_OUTSIDE' }),
        ]),
      );
      expect(report.files).toEqual(['hooks/register.mjs']);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('marks per-file and total graph byte limits incomplete', async () => {
    await source(
      `export function register(on) {} /*${'x'.repeat(1024 * 1024)}*/`,
    );
    expect((await validateMods(root)).static).toEqual({
      status: 'incomplete',
      complete: false,
    });
    const imports: string[] = [];
    for (let index = 0; index < 9; index++) {
      imports.push(`import './large-${index}.mjs';`);
      await source(
        `/*${'x'.repeat(1000 * 1024)}*/`,
        `hooks/large-${index}.mjs`,
      );
    }
    await source(`${imports.join('\n')} export function register(on) {}`);
    expect((await validateMods(root)).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'MOD_ANALYSIS_LIMIT' }),
      ]),
    );
  });

  it('bounds file count and diagnostic output with an explicit incomplete result', async () => {
    const imports: string[] = [];
    for (let index = 0; index < 129; index++) {
      imports.push(`import './file-${index}.mjs';`);
      await source('export const value = true;', `hooks/file-${index}.mjs`);
    }
    await source(`${imports.join('\n')} export function register(on) {}`);
    const graph = await validateMods(root);
    expect(graph.static).toEqual({ status: 'incomplete', complete: false });
    expect(graph.files).toHaveLength(128);
    await source(
      `export function register(on) { ${Array.from({ length: 110 }, (_, index) => `on('unknown.${index}', () => {});`).join(' ')} }`,
    );
    const diagnostics = await validateMods(root);
    expect(diagnostics.diagnostics).toHaveLength(100);
    expect(diagnostics.static).toEqual({
      status: 'incomplete',
      complete: false,
    });
  });
  it.each([
    "on('tool.call', { /* constraints */ }, ($, e, next) => next());",
    "function notify() {} const handlers = {}; handlers.notify = notify; on('tool.call', () => {});",
    "on('tool.call' as string, { tool: 'Bash' } as const, (($) => $.fs.read('/x')) satisfies Function);",
    "on?.('tool.call', (ctx) => ctx.fs.read('/x')).catch((ctx) => ctx.fs.write('/x', 'y'));",
  ])('preserves supported literal syntax: %s', async (body) => {
    await fs.writeFile(
      path.join(root, 'hooks/hooks.json'),
      JSON.stringify({ modules: ['./register.ts'] }),
    );
    await source(
      `export function register(on) { ${body} }`,
      'hooks/register.ts',
    );
    const result = await validateMods(root);
    expect(result.static).toEqual({ status: 'valid', complete: true });
    expect(result.requirements).toContainEqual(
      expect.objectContaining({ kind: 'event', name: 'tool.call' }),
    );
  });

  it.each([
    'class Local { exports = {}; #require() {} #Function() {} }',
    'const value = {}; export { value as module };',
    'module: for (;;) { break module; }',
    'declare global { const module: unknown; } module.exports = 1;',
    'declare const exports: unknown; exports.helper = () => {};',
    'const { a }: { eval: unknown } = { a: 1 }; const e = eval; e("x");',
    'const { a }: { Function: unknown } = { a: 1 }; const F = Function; F("x");',
  ])('separates nominal names and erased declarations: %s', async (text) => {
    await fs.writeFile(
      path.join(root, 'hooks/hooks.json'),
      JSON.stringify({ modules: ['./register.ts'] }),
    );
    await source(
      `${text} export function register(on) {}`,
      'hooks/register.ts',
    );
    const result = await validateMods(root);
    const forbidden = text.includes('declare') || text.includes('const {');
    expect(result.static.status).toBe(forbidden ? 'invalid' : 'valid');
    expect(
      result.diagnostics.some((d) => d.code === 'MOD_IMPORT_UNSUPPORTED'),
    ).toBe(forbidden);
  });

  it.each([
    'const g = globalThis; g.eval("x");',
    'global.eval("x");',
    'window.eval("x");',
    'const F = "".constructor.constructor; F("x");',
    'const F = Reflect.get("", "constructor").constructor; F("x");',
    'process.mainModule.require("node:child_process");',
    'globalThis.process.mainModule.require("node:child_process");',
    'const r = Reflect; r.get(globalThis, "eval")("x");',
    'const o = Object; o.getOwnPropertyDescriptor(globalThis, "eval").value("x");',
  ])(
    'does not certify unresolved globals or reflective access: %s',
    async (body) => {
      await source(`export function register(on) { ${body} }`);
      expect((await validateMods(root)).static).toEqual({
        status: 'incomplete',
        complete: false,
      });
    },
  );

  it('preserves a real imported Function binding', async () => {
    await source('export function shim() {}', 'hooks/shim.mjs');
    await source(
      "import { shim as Function } from './shim.mjs'; export function register(on) { new Function('x'); }",
    );
    expect((await validateMods(root)).static).toEqual({
      status: 'valid',
      complete: true,
    });
  });

  it('inventories every direct catch handler', async () => {
    await source(
      "export function register(on) { on('tool.call', () => {}).catch(() => {}).catch((ctx) => ctx.fs.write('/x','y')); }",
    );
    const result = await validateMods(root);
    expect(result.static).toEqual({ status: 'valid', complete: true });
    expect(result.requirements).toContainEqual(
      expect.objectContaining({ kind: 'api', name: 'fs.write' }),
    );
  });

  it('keeps aliased catch results incomplete', async () => {
    await source(
      "export function register(on) { const registration = on('tool.call', () => {}).catch(() => {}); registration.catch((ctx) => ctx.fs.read('/x')); }",
    );
    expect((await validateMods(root)).static).toEqual({
      status: 'incomplete',
      complete: false,
    });
  });

  it('keeps erased imports separate from runtime imports of the same file', async () => {
    await fs.writeFile(
      path.join(root, 'hooks/hooks.json'),
      JSON.stringify({ modules: ['./register.ts'] }),
    );
    await source(
      "export type Context = {}; export function helper($) { $.process.run('x'); }",
      'hooks/context.ts',
    );
    await source(
      "import type { Context } from './context.ts'; export function register(on) {}",
      'hooks/register.ts',
    );
    expect((await validateMods(root)).requirements).toEqual([]);
    await source(
      "import type { Context } from './context.ts'; import { helper } from './context.ts'; export function register(on) {}",
      'hooks/register.ts',
    );
    expect((await validateMods(root)).requirements).toContainEqual(
      expect.objectContaining({ kind: 'api', name: 'process.run' }),
    );
    await source(
      "import type { State } from 'claude-code/state'; export function register(on) {}",
      'hooks/register.ts',
    );
    expect((await validateMods(root)).static.status).toBe('valid');
  });

  it('keeps internal import spellings POSIX under a Windows path implementation', async () => {
    await source("import './sibling.mjs'; export function register(on) {}");
    await source('export const value = 1;', 'hooks/sibling.mjs');
    const originalPosix = path.posix;
    Object.defineProperty(path, 'posix', { value: { ...originalPosix } });
    const originalJoin = path.join;
    const originalDirname = path.dirname;
    const join = vi
      .spyOn(path, 'join')
      .mockImplementation((...parts) =>
        parts[0] === 'hooks'
          ? path.win32.join(...parts)
          : originalJoin(...parts),
      );
    const dirname = vi
      .spyOn(path, 'dirname')
      .mockImplementation((value) =>
        value === 'hooks/register.mjs'
          ? path.win32.dirname(value)
          : originalDirname(value),
      );
    let result;
    try {
      result = await validateMods(root);
    } finally {
      join.mockRestore();
      dirname.mockRestore();
      Object.defineProperty(path, 'posix', { value: originalPosix });
    }
    expect(result.static).toEqual({ status: 'valid', complete: true });
    expect(result.files).toEqual(['hooks/register.mjs', 'hooks/sibling.mjs']);
  });
  it.each([false, true])(
    'reports absent modules without a runtime promise (%s)',
    async (withHooks) => {
      if (withHooks)
        await fs.writeFile(path.join(root, 'hooks/hooks.json'), '{}');
      else await fs.rm(path.join(root, 'hooks/hooks.json'));
      const report = await validateMods(root);
      expect(report).toMatchObject({
        schemaVersion: 1,
        target: 'claude-code@2.1.295',
        discovery: 'absent',
        static: { status: 'not-checked', complete: true },
        runtime: 'unavailable',
        files: [],
        requirements: [],
        diagnostics: [],
      });
    },
  );

  it('bounds repeated requirements and overlong literals honestly', async () => {
    await source(
      `export function register(on) { ${"on('session.start', () => {});".repeat(4097)} }`,
    );
    const report = await validateMods(root);
    expect(report.static).toEqual({ status: 'incomplete', complete: false });
    expect(report.requirements).toHaveLength(4096);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'MOD_ANALYSIS_LIMIT' }),
    );
    await source(
      `export function register(on) { on('${'a'.repeat(4097)}', () => {}); }`,
    );
    const literal = await validateMods(root);
    expect(literal.static).toEqual({ status: 'incomplete', complete: false });
    expect(literal.requirements).toEqual([]);
    expect(literal.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'MOD_ANALYSIS_LIMIT' }),
    );
  });

  it('sanitizes bidi and line controls in capability names and matchers', async () => {
    await source(
      "export function register(on) { on('future\\u202e\\u2028', {tool: 'Bash\\u2066\\u2029'}, () => {}); }",
    );
    const report = await validateMods(root);
    expect(report.requirements).toContainEqual(
      expect.objectContaining({
        name: 'future??',
        matcher: '{"tool":"Bash??"}',
      }),
    );
    expect(JSON.stringify(report)).not.toMatch(
      /[\u202a-\u202e\u2066-\u2069\u2028\u2029]/u,
    );
  });

  it.each(['mts', 'cts'])(
    'never scans declaration .d.%s files as runtime source',
    async (suffix) => {
      await source('export const value = 1;', `hooks/context.d.${suffix}`);
      await source(
        `import './context.d.${suffix}'; export function register(on) {}`,
      );
      const runtime = await validateMods(root);
      expect(runtime.static.status).toBe('invalid');
      expect(runtime.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'MOD_IMPORT_UNSUPPORTED' }),
      );
      await fs.writeFile(
        path.join(root, 'hooks/hooks.json'),
        JSON.stringify({ modules: ['./register.ts'] }),
      );
      await source(
        `import type { Value } from './context.d.${suffix}'; export function register(on) {}`,
        'hooks/register.ts',
      );
      const erased = await validateMods(root);
      expect(erased.static.status).toBe('valid');
      expect(erased.requirements).toEqual([]);
    },
  );
  it('marks a full discovery diagnostic budget incomplete', async () => {
    await fs.writeFile(
      path.join(root, 'qwen-extension.json'),
      JSON.stringify({
        name: 'mod-fixture',
        version: '1.0.0',
        userConfig: Object.fromEntries(
          Array.from({ length: 100 }, (_, index) => [`option${index}`, null]),
        ),
      }),
    );
    await source('export function register(on) {}');
    const report = await validateMods(root);
    expect(report.static).toEqual({ status: 'incomplete', complete: false });
    expect(report.diagnostics).toHaveLength(100);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'MOD_ANALYSIS_LIMIT' }),
    );
  });

  it('does not mislabel an inspection failure as a nesting limit', async () => {
    vi.doMock('@babel/parser', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@babel/parser')>();
      return {
        ...actual,
        parse: (...args: Parameters<typeof actual.parse>) => {
          const parsed = actual.parse(...args);
          const exported = parsed.program.body[0];
          if (
            exported.type === 'ExportNamedDeclaration' &&
            exported.declaration?.type === 'FunctionDeclaration'
          ) {
            Object.defineProperty(exported.declaration, 'params', {
              enumerable: true,
              get() {
                throw new TypeError('unsafe injected failure');
              },
            });
          }
          return parsed;
        },
      };
    });
    try {
      await source('export function register(on) {}');
      const report = await validateMods(root);
      expect(report.static).toEqual({ status: 'incomplete', complete: false });
      expect(report.diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'MOD_ANALYSIS_INCOMPLETE',
          message: 'The source could not be fully inspected.',
        }),
      );
      expect(
        report.diagnostics.some((item) => item.code === 'MOD_ANALYSIS_LIMIT'),
      ).toBe(false);
      expect(JSON.stringify(report)).not.toContain('unsafe injected failure');
    } finally {
      vi.doUnmock('@babel/parser');
    }
  });
  it('preserves ordinary computed array and string data reads', async () => {
    await source(`export function register(on) {
      const values = ['a', 'b'];
      const grid = [[1, 2]];
      const index = 0;
      const last = values[values.length - 1];
      const nested = grid[index][index];
      const match = last.match(/a/)?.[0];
      const selected = values[Math.min(index, 1)];
      on('tool.call', ($) => $.fs.read('x'));
    }`);
    const report = await validateMods(root);
    expect(report.static).toEqual({ status: 'valid', complete: true });
    expect(report.requirements.map((item) => item.name)).toEqual([
      'tool.call',
      'fs.read',
    ]);
  });
});
