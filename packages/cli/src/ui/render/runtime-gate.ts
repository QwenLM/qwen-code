/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fail-closed runtime preflight for the experimental OpenTUI renderer.
 *
 * The locked @opentui/core 0.5.8 loads its native renderer through FFI:
 * `bun:ffi` under Bun, and the built-in `node:ffi` module under Node.js.
 * Node builds that cannot load `node:ffi` (node:ffi ships with Node 26.4+;
 * earlier majors lack it) only fail deep inside
 * @opentui/core, after the terminal has already been taken over. This gate
 * probes the runtime BEFORE the native-dependent renderer is imported and,
 * when unsupported, exits non-zero with a verified Bun invocation. The
 * default ink path never calls this module. Pure Node.js builtins — no
 * @opentui imports.
 */

import { createRequire } from 'node:module';

/** Verified working invocation (reproduced rendering under Bun 1.3.x). */
export const BUN_FALLBACK_COMMAND =
  'QWEN_TUI_RENDERER=opentui bun packages/cli/dist/index.js';

export interface OpenTuiRuntimeProbe {
  runtime: 'bun' | 'node' | 'unknown';
  supported: boolean;
  reason: string;
}

export type NodeFfiLoader = () => unknown;

export function loadNodeFfi(): unknown {
  return createRequire(import.meta.url)('node:ffi');
}

export function probeOpenTuiRuntime(
  versions: NodeJS.Process['versions'] = process.versions,
  loader: NodeFfiLoader = loadNodeFfi,
): OpenTuiRuntimeProbe {
  if (versions['bun']) {
    return {
      runtime: 'bun',
      supported: true,
      reason: `Bun ${versions['bun']} loads the native renderer through bun:ffi`,
    };
  }
  if (versions['node']) {
    try {
      loader();
      return {
        runtime: 'node',
        supported: true,
        reason: `Node v${versions['node']} can load node:ffi`,
      };
    } catch (error) {
      return {
        runtime: 'node',
        supported: false,
        reason: `Node v${versions['node']} cannot load node:ffi (${describeError(error)})`,
      };
    }
  }
  return {
    runtime: 'unknown',
    supported: false,
    reason: 'neither Bun nor Node.js version strings were detected',
  };
}

export function openTuiRuntimeFailureLines(
  probe: OpenTuiRuntimeProbe,
): string[] {
  return [
    'The OpenTUI renderer needs native FFI, which this runtime cannot provide.',
    `Detected: ${probe.reason}.`,
    'The locked @opentui/core 0.5.8 requires Bun, or a Node.js build that can actually load node:ffi.',
    'Re-run under Bun instead:',
    '',
    `    ${BUN_FALLBACK_COMMAND}`,
  ];
}

export interface OpenTuiRuntimeGateOptions {
  versions?: NodeJS.Process['versions'];
  loader?: NodeFfiLoader;
  writeError?: (line: string) => void;
  exit?: (code: number) => never;
}

export function ensureOpenTuiRuntimeSupported(
  options: OpenTuiRuntimeGateOptions = {},
): void {
  const probe = probeOpenTuiRuntime(options.versions, options.loader);
  if (probe.supported) {
    return;
  }
  const writeError =
    options.writeError ?? ((line: string) => process.stderr.write(`${line}\n`));
  for (const line of openTuiRuntimeFailureLines(probe)) {
    writeError(line);
  }
  const exit = options.exit ?? ((code: number) => process.exit(code));
  exit(1);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
