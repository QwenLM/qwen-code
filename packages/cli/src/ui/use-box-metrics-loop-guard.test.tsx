/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, StrictMode, useRef, useState, type ReactNode } from 'react';
import {
  Box,
  render,
  Text,
  type DOMElement,
  type Instance,
  useBoxMetrics,
} from 'ink';
import stripAnsi from 'strip-ansi';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    // Register before the flush so a mount that throws out of the commit phase
    // is still unmounted by `afterEach`.
    mounted.add(app);
  });
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

// Same oscillator, but counting renders so a test can assert on how many
// commits the guard let through before it stopped the cascade.
function CountingOscillatingBox({ onRender }: { onRender: () => void }) {
  onRender();
  const ref = useRef<DOMElement>(null);
  const { width, hasMeasured } = useBoxMetrics(ref);
  return (
    <Box ref={ref} width={hasMeasured && width >= 11 ? 10 : 11}>
      <Text>x</Text>
    </Box>
  );
}

// A box whose size is driven from the outside. Every re-render is a genuine
// new interaction, so it must keep reporting fresh metrics indefinitely.
function ExternallySizedBox({ size }: { size: number }) {
  const ref = useRef<DOMElement>(null);
  const { width, hasMeasured } = useBoxMetrics(ref);
  return (
    <Box flexDirection="row">
      <Box ref={ref}>
        <Text>{'x'.repeat(size)}</Text>
      </Box>
      <Text>{hasMeasured ? `measured:${width}` : 'measured:pending'}</Text>
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

  it('settles an oscillating box inside StrictMode, where the render body runs twice', async () => {
    // #11817. React invokes a render body twice under StrictMode, and `DEBUG=1
    // npm run dev` renders the CLI inside it. A budget mutated during render is
    // spent by the first invocation and refilled by the second, so it never
    // drains and React's #185 fires instead. The budget therefore has to be
    // settled once per commit rather than once per render invocation.
    const { stdout, lastFrame } = createTestStdout();
    let renderError: unknown;
    try {
      await mount(
        <StrictMode>
          <OscillatingBox />
        </StrictMode>,
        stdout,
      );
    } catch (error) {
      // Captured instead of thrown so the failure stays one case: a mount that
      // throws out of the commit phase also leaves this suite's act scope
      // unusable for the cases after it.
      renderError = error;
    }

    expect(renderError).toBeUndefined();
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

  it('settles an oscillating box whose commits never fit inside one wall-clock window', async () => {
    // #11817. The budget used to refill whenever 16ms of wall clock had passed.
    // A cascade whose commits are slower than that refills on every measurement,
    // so the budget never drains and React's own 50-nested-update cap fires
    // first - which is what a loaded CI runner or a slower platform does.
    // Advancing the clock 16ms on every read keeps that refill firing on every
    // measurement however fast the machine is, so this case separates a
    // commit-counted budget from a timed one without racing the clock.
    let clock = 0;
    const now = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => (clock += 16));
    try {
      const { stdout, lastFrame } = createTestStdout();
      await mount(<OscillatingBox />, stdout);

      expect(lastFrame()).toContain('x');
    } finally {
      now.mockRestore();
    }
  });

  it('stops an oscillation in far fewer commits than React tolerates', async () => {
    // React throws #185 once 50 nested updates stack up, so the guard has to
    // stop the cascade well inside that. A guard that never trips does not just
    // fail this assertion - it takes the whole mount down with #185.
    let renders = 0;
    const { stdout } = createTestStdout();
    await mount(
      <CountingOscillatingBox
        onRender={() => {
          renders += 1;
        }}
      />,
      stdout,
    );

    expect(renders).toBeGreaterThan(1);
    expect(renders).toBeLessThan(50);
  });

  it('keeps measuring across far more external re-renders than one budget', async () => {
    // The other half of the guard's contract: a render the hook did not cause is
    // a new interaction and refills the budget. Without that refill a box which
    // legitimately changes size while content streams in would go stale after
    // the first budget's worth of changes.
    let setSize!: (size: number) => void;
    function Driver() {
      const [size, setSizeState] = useState(1);
      setSize = setSizeState;
      return <ExternallySizedBox size={size} />;
    }

    const { stdout, lastFrame } = createTestStdout();
    const app = await mount(<Driver />, stdout);
    expect(lastFrame()).toContain('measured:1');

    for (let size = 2; size <= 40; size += 1) {
      await act(async () => {
        setSize(size);
      });
    }
    await app.waitUntilRenderFlush();

    expect(lastFrame()).toContain('measured:40');
  });
});
