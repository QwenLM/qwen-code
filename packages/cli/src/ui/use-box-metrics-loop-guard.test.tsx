/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, useRef, type ReactNode } from 'react';
import {
  Box,
  render,
  Text,
  type DOMElement,
  type Instance,
  useBoxMetrics,
} from 'ink';
import stripAnsi from 'strip-ansi';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Regression coverage for the `useBoxMetrics` loop guard carried in the
 * vendored Ink patch (`patches/ink+7.0.3.patch`). A box whose measured layout
 * feeds back into its own size oscillates through the commit-phase layout
 * listener until React throws #185 and the CLI exits silently (#11500).
 */

const mounted = new Set<Instance>();

afterEach(async () => {
  for (const app of mounted) {
    await act(async () => {
      app.unmount();
    });
    await app.waitUntilRenderFlush();
  }
  mounted.clear();
});

function createTestStdout(
  initialColumns = 80,
  rows = 24,
): {
  stdout: NodeJS.WriteStream;
  setColumns: (columns: number) => void;
  lastFrame: () => string;
} {
  let columns = initialColumns;
  let lastFrame = '';
  const stdout = Object.create(process.stdout, {
    columns: { get: () => columns },
    rows: { value: rows },
    isTTY: { value: true },
    write: {
      value(
        chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | (() => void),
        callback?: () => void,
      ) {
        const text = stripAnsi(String(chunk));
        if (text.trim() !== '') {
          lastFrame = text;
        }
        const done =
          typeof encodingOrCallback === 'function'
            ? encodingOrCallback
            : callback;
        done?.();
        return true;
      },
    },
  }) as NodeJS.WriteStream;

  return {
    stdout,
    setColumns: (next: number) => {
      columns = next;
    },
    lastFrame: () => lastFrame,
  };
}

async function mount(
  node: ReactNode,
  stdout: NodeJS.WriteStream,
): Promise<Instance> {
  let app!: Instance;
  await act(async () => {
    app = render(node, {
      stdout,
      interactive: true,
      maxFps: 1_000,
      patchConsole: false,
    });
  });
  mounted.add(app);
  await app.waitUntilRenderFlush();
  return app;
}

function MeasuredBox({
  id,
  width = 20,
}: {
  id: string;
  width?: number | string;
}) {
  const ref = useRef<DOMElement>(null);
  const { width: measuredWidth, hasMeasured } = useBoxMetrics(ref);
  return (
    <Box ref={ref} width={width}>
      <Text>{hasMeasured ? `${id}:${measuredWidth}` : `${id}:pending`}</Text>
    </Box>
  );
}

// Flips its own width on every measurement, so each commit produces a layout
// that disagrees with the previous one and the measure -> setState -> commit
// cycle never settles without the guard.
function OscillatingBox() {
  const ref = useRef<DOMElement>(null);
  const { width, hasMeasured } = useBoxMetrics(ref);
  return (
    <Box ref={ref} width={hasMeasured && width >= 11 ? 10 : 11}>
      <Text>x</Text>
    </Box>
  );
}

describe('ink useBoxMetrics loop guard', () => {
  it('settles an oscillating box instead of throwing React #185', async () => {
    const { stdout, lastFrame } = createTestStdout();
    await mount(<OscillatingBox />, stdout);

    // The oscillator re-renders until its budget trips. Without the guard this
    // mount throws "Maximum update depth exceeded" out of the commit phase.
    expect(lastFrame()).toContain('x');
  });

  it('still measures on a later resize once an oscillation tripped the guard', async () => {
    const { stdout, setColumns, lastFrame } = createTestStdout(80);
    const app = await mount(
      <Box flexDirection="column">
        <OscillatingBox />
        <MeasuredBox id="probe" width="100%" />
      </Box>,
      stdout,
    );
    expect(lastFrame()).toContain('probe:80');

    setColumns(60);
    await act(async () => {
      stdout.emit('resize');
    });
    await app.waitUntilRenderFlush();

    expect(lastFrame()).toContain('probe:60');
  });

  it('gives every instance its own measurement budget', async () => {
    const { stdout, lastFrame } = createTestStdout(120, 60);
    await mount(
      <Box flexDirection="column">
        {Array.from({ length: 40 }, (_, index) => (
          <MeasuredBox key={index} id={`box-${index}`} />
        ))}
      </Box>,
      stdout,
    );

    const frame = lastFrame();
    expect(frame).not.toContain(':pending');
    expect(frame).toContain('box-39:20');
  });
});
