/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
// Use the repository's compiler; a locally overridden Vite dependency may
// already fix the logical-assignment lowering bug and mask this regression.
import { transform } from 'esbuild';

const require = createRequire(import.meta.url);
const webShellRoot = resolve(import.meta.dirname, '../../packages/web-shell');

// Resolve the config through web-shell's own Vite: the bare `vite` import
// here lands on the root-hoisted Vite 7, whose default `build.target`
// (chrome107/…) never lowers logical assignments, so a dropped
// `target: 'es2021'` would keep this probe green while the real Vite 5
// build ships a broken bundle. Vite 5 exposes `resolveConfig` on `.default`
// under some interops, so normalize that.
const webShellVite = createRequire(resolve(webShellRoot, 'package.json'))(
  'vite',
) as typeof import('vite') & { default?: typeof import('vite') };
const resolveViteConfig = (webShellVite.resolveConfig ??
  webShellVite.default?.resolveConfig)!;

interface TestTerminal {
  onData(listener: (data: string) => void): void;
  _core: { _inputHandler: { parse(data: string): void } };
  buffer: {
    active: { getLine(index: number): { translateToString(): string } };
  };
  dispose(): void;
}

async function builtTerminal(target: string | string[]) {
  const source = await readFile(
    resolve(dirname(require.resolve('@xterm/xterm')), 'xterm.mjs'),
    'utf8',
  );
  const { code } = await transform(source, {
    target,
    minify: true,
    format: 'cjs',
  });
  const module = {
    exports: {} as {
      Terminal: new (options: { allowProposedApi: boolean }) => TestTerminal;
    },
  };
  const { window } = new JSDOM();
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', {
    value: () => null,
  });
  runInNewContext(code, {
    window,
    document: window.document,
    navigator: window.navigator,
    module,
    exports: module.exports,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    console,
    performance,
  });
  return new module.exports.Terminal({ allowProposedApi: true });
}

function queryAndPrint(terminal: TestTerminal) {
  const replies: string[] = [];
  terminal.onData((data) => replies.push(data));
  // Parsing synchronously exposes failures that xterm's asynchronous write queue
  // otherwise reports outside the test, without requiring a browser renderer.
  terminal._core._inputHandler.parse('\x1b[?2004$pafter-query');
  return {
    replies,
    output: terminal.buffer.active.getLine(0).translateToString().trimEnd(),
  };
}

// The package runs three builds: the app (`vite.config.ts`) and the two lib
// invocations (`vite.lib.config.ts`, default and transcript modes). Both
// configs must carry the ES2021 floor or the shipped bundle throws on the
// first DECRQM query.
describe.each(['vite.config.ts', 'vite.lib.config.ts'])(
  'Web Shell production terminal (%s)',
  (configFile) => {
    it('answers DECRQM and keeps processing output after minification', async () => {
      const config = await resolveViteConfig(
        {
          root: webShellRoot,
          configFile: resolve(webShellRoot, configFile),
        },
        'build',
      );
      // Pin the floor itself: the probe cannot discriminate it (both esbuild
      // copies miscompile identically only at the Vite 5 default), and
      // resolveConfig always fills a default so a dropped `target` would be
      // masked without this assertion.
      expect(config.build.target).toBe('es2021');
      const terminal = await builtTerminal(config.build.target);
      try {
        expect(queryAndPrint(terminal)).toEqual({
          replies: ['\x1b[?2004;2$y'],
          output: 'after-query',
        });
      } finally {
        terminal.dispose();
      }
    });
  },
);
