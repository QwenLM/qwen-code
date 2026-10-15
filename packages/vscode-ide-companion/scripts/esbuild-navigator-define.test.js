/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import esbuild from 'esbuild';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const esbuildConfig = readFileSync(
  fileURLToPath(new URL('../esbuild.js', import.meta.url)),
  'utf-8',
);

/**
 * VS Code >= 1.142 installs `navigator` on the extension-host global as a
 * getter that throws `PendingMigrationError`. Any read raises, including a
 * `typeof navigator` feature probe, because `typeof` only guards against
 * *unresolvable* references, not throwing accessors.
 */
function runWithThrowingNavigator(code) {
  const sandbox = { exports: {} };
  vm.createContext(sandbox);
  // Install the guard on the context's own global object. Defining it on the
  // sandbox after createContext() would not be seen as a global by the vm.
  vm.runInContext(
    `Object.defineProperty(globalThis, 'navigator', {
       configurable: true,
       get() { throw new Error('PendingMigrationError'); },
     });`,
    sandbox,
  );
  vm.runInContext(code, sandbox, { filename: 'bundle.cjs' });
  return sandbox.exports;
}

/** Balanced-brace slice of the object literal passed to a given esbuild call. */
function sliceContextBlock(marker) {
  const start = esbuildConfig.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const open = esbuildConfig.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < esbuildConfig.length; i++) {
    if (esbuildConfig[i] === '{') depth++;
    else if (esbuildConfig[i] === '}') {
      depth--;
      if (depth === 0) return esbuildConfig.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${marker}`);
}

function extractDefine(block) {
  const match = /\bdefine:\s*\{/.exec(block);
  expect(match, 'no `define` key in esbuild context block').not.toBeNull();
  const open = match.index + match[0].length - 1;
  let depth = 0;
  for (let i = open; i < block.length; i++) {
    if (block[i] === '{') depth++;
    else if (block[i] === '}') {
      depth--;
      if (depth === 0) return block.slice(open, i + 1);
    }
  }
  throw new Error('unbalanced braces in define literal');
}

function extractPlatform(block) {
  const match = /\bplatform:\s*'([^']+)'/.exec(block);
  expect(match, 'no `platform` key in esbuild context block').not.toBeNull();
  return match[1];
}

/**
 * Reads the real `define` map out of `esbuild.js` at test time. Never
 * hardcoded here: a hardcoded map would be green both before and after the fix.
 */
function readDefine(marker) {
  const block = sliceContextBlock(marker);
  return {
    platform: extractPlatform(block),
    define: new Function('production', `return (${extractDefine(block)});`)(
      false,
    ),
  };
}

const extension = readDefine('const extensionCtx = await esbuild.context(');
const webview = readDefine('const webviewCtx = await esbuild.context(');

async function bundle(source, { platform, define }) {
  const result = await esbuild.build({
    stdin: {
      contents: source,
      resolveDir: packageDir,
      sourcefile: 'fixture.js',
      loader: 'js',
    },
    bundle: true,
    platform,
    format: 'cjs',
    write: false,
    define,
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

// zod@3.25.x `allowsEval` JIT probe, verbatim shape from
// node_modules/zod/v4/core/util.cjs:164.
const zodBareProbe = `
exports.allowsEval = (() => {
  if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) {
    return false;
  }
  try {
    new Function("");
    return true;
  } catch {
    return false;
  }
});
`;

// The member form also shipped in dist/extension.cjs.
const memberProbe = `
exports.isReactNative =
  typeof globalThis.navigator < "u" &&
  globalThis.navigator.product === "ReactNative";
`;

describe('extension bundle must not read the navigator global', () => {
  it('reads the define map from the real esbuild.js (extractor canary)', () => {
    expect(Object.keys(extension.define)).toContain('import.meta.url');
    expect(extension.define['import.meta.url']).toBe('import_meta.url');
    expect(extension.platform).toBe('node');
  });

  it("neutralizes zod's bare-identifier `typeof navigator` JIT probe", async () => {
    const output = await bundle(zodBareProbe, {
      platform: extension.platform,
      define: extension.define,
    });
    expect(output).not.toMatch(/\bnavigator\b/);
    const exports = runWithThrowingNavigator(output);
    expect(() => exports.allowsEval()).not.toThrow();
    // JIT must stay enabled: defining navigator away must not kill eval.
    expect(exports.allowsEval()).toBe(true);
  });

  it('neutralizes the `globalThis.navigator` member form too', async () => {
    const output = await bundle(memberProbe, {
      platform: extension.platform,
      define: extension.define,
    });
    expect(output).not.toMatch(/\bnavigator\b/);
    const exports = runWithThrowingNavigator(output);
    expect(() => exports.isReactNative).not.toThrow();
    expect(exports.isReactNative).toBe(false);
  });
});

describe('webview bundle must keep the real navigator', () => {
  it('does not define navigator away for the browser platform', async () => {
    expect(webview.platform).toBe('browser');
    expect(Object.keys(webview.define)).not.toContain('navigator');
    expect(Object.keys(webview.define)).not.toContain('globalThis.navigator');

    const output = await bundle('exports.language = navigator.language;\n', {
      platform: webview.platform,
      define: webview.define,
    });
    // src/webview/strings.ts falls back to navigator.language for i18n; the
    // output must still read the real global.
    expect(output).toMatch(/\bnavigator\.language\b/);
  });
});
