/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

/**
 * GMN render() adapter.
 *
 * Maps GMN's render options (which include GMN-specific extensions like
 * alternateBuffer, terminalBuffer, renderProcess, etc.) to the core ink engine's
 * native RenderOptions (which only has stdout/stdin/stderr/exitOnCtrlC/
 * patchConsole/onFrame).
 *
 * GMN's 200+ files call `render()` from 'ink' — this adapter ensures
 * they all work unchanged.
 */
import type { ReactNode } from 'react';
import {
  renderSync as coreRenderSync,
  type RenderOptions as CoreRenderOptions,
  type Instance as CoreInstance,
} from './root.js';

export interface GMNRenderOptions {
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
  exitOnCtrlC?: boolean;
  patchConsole?: boolean;

  // GMN-specific options — forwarded or silently ignored
  isScreenReaderEnabled?: boolean;
  onRender?: (stats: { renderTime: number }) => void;
  alternateBuffer?: boolean;
  debug?: boolean;

  // Deprecated options — core engine supersedes these
  terminalBuffer?: boolean;
  renderProcess?: boolean;
  incrementalRendering?: boolean;
  standardReactLayoutTiming?: boolean;
}

export type Instance = CoreInstance;

/**
 * Render a React element tree using the core ink engine.
 *
 * Accepts GMN's extended options and maps them to the core engine's native options.
 * Returns an Instance synchronously — callers expect `.unmount()` etc.
 * to be available immediately.
 */
export function render(node: ReactNode, options?: GMNRenderOptions): Instance {
  const coreOptions = mapOptions(options);
  const instance = coreRenderSync(node, coreOptions);

  // NOTE: alternateBuffer is handled by the <AlternateScreen> React component
  // in the render tree (see interactiveCli.tsx AppWrapper), NOT here.
  // The component uses useInsertionEffect to enter alt screen synchronously
  // before children paint — matching how the upstream REPL.tsx wraps its content.
  //
  // The process.stdout ↔ Proxy stdout dual-key registration is handled in
  // root.ts renderSync(), BEFORE instance.render(node), so that
  // AlternateScreen's useInsertionEffect can find the Ink instance.

  return instance;
}

function mapOptions(options?: GMNRenderOptions): CoreRenderOptions {
  if (!options) return {};

  const coreOptions: CoreRenderOptions = {};

  if (options.stdout) coreOptions.stdout = options.stdout;
  if (options.stdin) coreOptions.stdin = options.stdin;
  if (options.stderr) coreOptions.stderr = options.stderr;
  if (options.exitOnCtrlC !== undefined)
    coreOptions.exitOnCtrlC = options.exitOnCtrlC;
  if (options.patchConsole !== undefined)
    coreOptions.patchConsole = options.patchConsole;

  // Map GMN's onRender to core engine's onFrame
  if (options.onRender) {
    const onRender = options.onRender;
    coreOptions.onFrame = (event) => {
      onRender({ renderTime: event.durationMs });
    };
  }

  // GMN-specific options that core engine handles differently:
  // - alternateBuffer: forwarded via setAltScreenActive() after instance creation
  // - terminalBuffer: deprecated, core engine's in-process double buffering supersedes
  // - renderProcess: deprecated, core engine doesn't use worker processes
  // - incrementalRendering: core engine always does cell-level diff (always "incremental")
  // - standardReactLayoutTiming: core engine uses microtask deferred render by default
  // - isScreenReaderEnabled: TODO wire into AppContext if needed
  // - debug: silently ignored (core engine has its own debug infrastructure)

  return coreOptions;
}
