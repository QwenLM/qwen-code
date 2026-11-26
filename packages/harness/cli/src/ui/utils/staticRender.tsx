/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useLayoutEffect } from 'react';
import { PassThrough } from 'node:stream';
import { renderSync, useApp } from '../../ink/index.js';

/**
 * Wrapper component that exits Ink after a single render frame.
 * Uses useLayoutEffect to ensure React's commit phase completes before exiting.
 */
function RenderOnceAndExit({ children }: { children: React.ReactNode }) {
  const { exit } = useApp();
  useLayoutEffect(() => {
    const timer = setTimeout(exit, 0);
    return () => clearTimeout(timer);
  }, [exit]);
  return <>{children}</>;
}

/**
 * Renders a React node to a string with ANSI escape codes (for terminal output).
 * Uses Ink's rendering engine with a PassThrough stream for headless operation.
 */
export async function renderToAnsiString(
  node: React.ReactNode,
  columns?: number,
): Promise<string> {
  let pendingOutput = '';
  let lastFrame = '';

  // Capture all writes. Set .columns so Ink picks up a chosen width
  // instead of PassThrough's undefined -> 80 fallback.
  const stream = new PassThrough();
  if (columns !== undefined) {
    (stream as unknown as { columns: number }).columns = columns;
  }
  stream.on('data', (chunk: Buffer) => {
    pendingOutput += chunk.toString();
  });

  const instance = renderSync(<RenderOnceAndExit>{node}</RenderOnceAndExit>, {
    stdout: stream as unknown as NodeJS.WriteStream,
    patchConsole: false,
    onFrame: () => {
      // Non-TTY frames contain the whole tree. Keep the latest complete frame
      // after layout settles, regardless of terminal synchronization support.
      lastFrame = pendingOutput;
      pendingOutput = '';
    },
  });

  try {
    await instance.waitUntilExit();
    // Ignore unmount's terminal cleanup writes and end each exported chunk
    // with a newline so adjacent chunks stay on separate lines.
    return lastFrame ? `${lastFrame}\n` : '';
  } finally {
    instance.cleanup();
    stream.destroy();
  }
}
