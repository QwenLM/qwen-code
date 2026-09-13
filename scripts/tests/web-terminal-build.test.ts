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
import { resolveConfig } from 'vite';
import { JSDOM } from 'jsdom';
// Use the repository's compiler; a locally overridden Vite dependency may
// already fix the logical-assignment lowering bug and mask this regression.
import { transform } from 'esbuild';

const require = createRequire(import.meta.url);
const webShellRoot = resolve(import.meta.dirname, '../../packages/web-shell');

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

describe('Web Shell production terminal', () => {
  it('answers DECRQM and keeps processing output after minification', async () => {
    const config = await resolveConfig(
      {
        root: webShellRoot,
        configFile: resolve(webShellRoot, 'vite.config.ts'),
      },
      'build',
    );
    const terminal = await builtTerminal(config.build.target || 'esnext');
    try {
      expect(queryAndPrint(terminal)).toEqual({
        replies: ['\x1b[?2004;2$y'],
        output: 'after-query',
      });
    } finally {
      terminal.dispose();
    }
  });
});
