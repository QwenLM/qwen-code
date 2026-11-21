/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi } from 'vitest';

/**
 * Options of every `execFile` call that went through the module returned by
 * {@link createExecFileMockModule}, in call order. Suites that assert on it
 * (e.g. pinning `windowsHide: true` on the daemon's direct git spawns,
 * #17266) clear the array themselves before driving the code under test.
 */
export const recordedExecFileCalls: Array<{
  file: string;
  args: readonly string[];
  options: Record<string, unknown>;
}> = [];

/** Record calls while preserving the real callback and promisified behavior. */
export async function createExecFileMockModule() {
  const actual =
    await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    );
  const { promisify: promisifyActual } =
    await vi.importActual<typeof import('node:util')>('node:util');
  const wrappedExecFile = ((
    file: string,
    args: readonly string[],
    options: unknown,
    callback: unknown,
  ) => {
    const hasOptions = typeof options === 'object' && options !== null;
    const callOptions = (hasOptions ? options : {}) as Record<string, unknown>;
    const callCallback = (hasOptions ? callback : options) as (
      ...callArgs: never[]
    ) => void;
    recordedExecFileCalls.push({ file, args, options: callOptions });
    return hasOptions
      ? actual.execFile(
          file,
          args,
          callOptions as Parameters<typeof actual.execFile>[2],
          callCallback as never,
        )
      : actual.execFile(file, args, callCallback as never);
  }) as unknown as typeof actual.execFile;
  // Generic promisification resolves stdout alone. Preserve Node's custom
  // { stdout, stderr } result and rejection details while recording calls.
  Object.defineProperty(wrappedExecFile, promisifyActual.custom, {
    value: (
      file: string,
      args: readonly string[],
      options: Record<string, unknown>,
    ) => {
      recordedExecFileCalls.push({
        file,
        args,
        options: options ?? {},
      });
      return promisifyActual(actual.execFile)(file, args, options);
    },
  });
  return {
    ...actual,
    default: { ...actual, execFile: wrappedExecFile },
    execFile: wrappedExecFile,
  };
}
