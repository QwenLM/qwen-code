/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  act,
  StrictMode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
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

// Pins the clock so that a budget refilling on elapsed wall-clock time refills
// on every measurement, however fast the machine is. Restored unconditionally:
// the patched hook reads no clock, but ink's render loop does, and a spy left
// in place would push a 16ms-jumping clock into the cases after this one.
async function withPinnedClock(body: () => Promise<void>): Promise<void> {
  let clock = 0;
  const now = vi
    .spyOn(performance, 'now')
    .mockImplementation(() => (clock += 16));
  try {
    await body();
  } finally {
    now.mockRestore();
  }
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
// cycle never settles without the guard. `onRender` lets a test count the
// commits the guard let through before it stopped the cascade; it reports from
// an effect rather than from the render body, because StrictMode invokes a body
// twice per commit and an invocation count is not a commit count.
function OscillatingBox({ onRender }: { onRender?: () => void } = {}) {
  const ref = useRef<DOMElement>(null);
  const { width, hasMeasured } = useBoxMetrics(ref);
  useEffect(() => {
    onRender?.();
  });
  return (
    <Box ref={ref} width={hasMeasured && width >= 11 ? 10 : 11}>
      <Text>x</Text>
    </Box>
  );
}

function ParentRoutedChild({
  width,
  onMeasure,
}: {
  width: number;
  onMeasure: (width: number) => void;
}) {
  const ref = useRef<DOMElement>(null);
  const { width: measuredWidth, hasMeasured } = useBoxMetrics(ref);
  useLayoutEffect(() => {
    if (hasMeasured) {
      onMeasure(measuredWidth);
    }
  }, [hasMeasured, measuredWidth, onMeasure]);

  return (
    <Box ref={ref} width={width}>
      <Text>x</Text>
    </Box>
  );
}

function ParentRoutedOscillatingBox() {
  const [measuredWidth, setMeasuredWidth] = useState(0);
  return (
    <ParentRoutedChild
      width={measuredWidth === 2 ? 3 : 2}
      onMeasure={setMeasuredWidth}
    />
  );
}

// Gates the measured element's own mounting on `hasMeasured`, and the attached
// box computes to all zeros, so `metrics` never changes value: the only setter
// scheduling commits is `setHasMeasured`. `onRender` counts commits the same way
// `OscillatingBox`'s does, from an effect rather than from the render body.
function HasMeasuredGatedBox({ onRender }: { onRender?: () => void } = {}) {
  const ref = useRef<DOMElement>(null);
  const { hasMeasured } = useBoxMetrics(ref);
  useEffect(() => {
    onRender?.();
  });
  return hasMeasured ? (
    <Text>fallback</Text>
  ) : (
    <Box ref={ref} width={0} height={0}>
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

// Halves its own width on every measurement, from 32 down to 3, so it settles
// only if five consecutive self-driven passes are allowed to run; a budget of
// two freezes it on an intermediate width. The width is derived in the render
// body rather than from state of its own, which keeps the passes on the hook's
// budget instead of handing the guard a genuine external commit between them.
function ConvergingBox() {
  const ref = useRef<DOMElement>(null);
  const { width, hasMeasured } = useBoxMetrics(ref);
  const size = hasMeasured ? Math.max(3, Math.floor(width / 2)) : 32;
  return (
    <Box flexDirection="row">
      <Box ref={ref}>
        <Text>{'x'.repeat(size)}</Text>
      </Box>
      <Text>{hasMeasured ? ` settled=${width}px` : ' settled=pending'}</Text>
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

  it('settles an oscillation routed through parent state', async () => {
    const { stdout, lastFrame } = createTestStdout();
    await mount(<ParentRoutedOscillatingBox />, stdout);

    expect(lastFrame()).toContain('x');
  });

  it('settles an oscillating box inside StrictMode, where the render body runs twice', async () => {
    // #11817. React invokes a render body twice under StrictMode, and `DEBUG=1
    // npm run dev` renders the CLI inside it. A budget mutated during render is
    // spent by the first invocation and refilled by the second, so it never
    // drains and React's #185 fires instead. The budget therefore has to be
    // settled once per commit rather than once per render invocation.
    //
    // The clock is pinned for the reason the case below pins it: this whole
    // mount fits inside one 16ms window on an idle machine, so a budget
    // refilling on elapsed time could not fail it here.
    await withPinnedClock(async () => {
      const { stdout, lastFrame } = createTestStdout();
      await mount(
        <StrictMode>
          <OscillatingBox />
        </StrictMode>,
        stdout,
      );

      expect(lastFrame()).toContain('x');
    });
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

  it('unfreezes a tripped instance on resize, which needs no React commit', async () => {
    // A tripped instance stops scheduling renders of its own, so it can only
    // measure again on an event from outside the cascade. Any later commit in
    // the ink root reaches it too - this box keeps its measured element mounted,
    // and the root layout listener that `getMeasurementGuard` registers fans out
    // to every instance subscribed to that root, so it runs for every commit of
    // the root, not only for commits that re-render this subtree - but a resize
    // is recomputed by ink's own handler with no React commit at all, so
    // `onResize` is the path that reaches a tripped instance while nothing else
    // in the tree renders. That handler refills the budget outright, which is a
    // separate path from the commit-driven refill pinned by the case below, not
    // by this one.
    // Drop the re-measure and this case goes red: nothing follows the resize, so
    // the box renders against a stale width for the rest of the session. The
    // budget reset beside it is not what pins this case - the microtask a
    // zero-based run queues drains before a resize event is delivered, so the
    // count is already 0 when `onResize` runs and the reset is a no-op here.
    // Deleting the reset alone leaves all 13 cases green.
    let renders = 0;
    const { stdout, setColumns } = createTestStdout(80);
    const app = await mount(
      <Box flexDirection="row">
        <Box width="50%" />
        <OscillatingBox
          onRender={() => {
            renders += 1;
          }}
        />
      </Box>,
      stdout,
    );
    const afterTrip = renders;
    // The reset below only matters if the budget was actually exhausted, so
    // assert that state rather than "more than one render".
    expect(afterTrip).toBeGreaterThanOrEqual(16);

    // The sibling shrinks with the terminal, so the oscillator's own left moves
    // and its metrics have genuinely changed by the time it re-measures.
    setColumns(60);
    await act(async () => {
      stdout.emit('resize');
    });
    await app.waitUntilRenderFlush();

    expect(renders).toBeGreaterThan(afterTrip);
  });

  it('refills a tripped instance on a later sibling commit, without a resize', async () => {
    // The case above pins `onResize`; this pins the other refill path, the one
    // a commit drives. The budget the cascade tripped is refilled by the
    // microtask that a run starting from zero schedules, which cannot fire until
    // the cascading chain has unwound - so a later commit in the root measures
    // again, and the comment there calls that "any later commit in the ink
    // root". Nothing pinned that tripped-then-recovered path until now: every
    // other recovery here goes through `stdout.emit('resize')`, and the
    // external-rerender case never trips - its count oscillates between 0 and 1
    // across all 39 iterations - though it rests on the same refill to get back
    // to 0, and stops measuring without it. Without that refill a box that
    // tripped once stays frozen until the user happens to resize the terminal,
    // rendering a stale width for the rest of the session.
    let renders = 0;
    let bumpSibling!: () => void;
    // The sibling owns its state on purpose. With the width in a shared parent
    // the driver's commit re-renders the oscillator whatever the guard does, so
    // the assertion stops discriminating. Its width also shifts the oscillator's
    // `left`, because the guard only re-renders on a changed measurement and a
    // box that did not move legitimately produces no commit.
    function Sibling() {
      const [width, setWidth] = useState(1);
      bumpSibling = () => setWidth(2);
      return <Box width={width} />;
    }

    const { stdout } = createTestStdout(80);
    const app = await mount(
      <Box flexDirection="row">
        <Sibling />
        <OscillatingBox
          onRender={() => {
            renders += 1;
          }}
        />
      </Box>,
      stdout,
    );
    const afterTrip = renders;
    // Exhaustion is what this case's refill depends on - same precondition.
    expect(afterTrip).toBeGreaterThanOrEqual(16);

    await act(async () => {
      bumpSibling();
    });
    await app.waitUntilRenderFlush();

    // The refill resets the whole budget rather than decrementing it, so the
    // oscillator runs a second cascade - 16 further commits at this head. Both
    // mutations of that branch stop short of this bound, so it discriminates the
    // kind of refill and not merely its presence: a partial refill gets 1, and
    // one gated on the instance not being tripped gets 0.
    expect(renders - afterTrip).toBeGreaterThan(2);
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
    await withPinnedClock(async () => {
      const { stdout, lastFrame } = createTestStdout();
      await mount(<OscillatingBox />, stdout);

      expect(lastFrame()).toContain('x');
    });
  });

  // `onRender` reports once per commit, so the same bound has to hold in both
  // modes. Running it under StrictMode is what pins the counter against a
  // render-body invocation count, which would report roughly double here.
  describe.each([false, true])('strictMode=%s', (strictMode) => {
    it('stops an oscillation in far fewer commits than React tolerates', async () => {
      // React throws #185 once 50 nested updates stack up, so the guard has to
      // stop the cascade well inside that. A guard that never trips does not just
      // fail this assertion - it takes the whole mount down with #185.
      let renders = 0;
      const { stdout } = createTestStdout();
      const box = (
        <OscillatingBox
          onRender={() => {
            renders += 1;
          }}
        />
      );
      await mount(strictMode ? <StrictMode>{box}</StrictMode> : box, stdout);

      // Bounded on both sides: a cap loose enough to only just beat React's own
      // 50-nested-update limit, and one tight enough to stale a consumer that
      // needs a second measurement pass, both fail here. The bound is a count of
      // commits, which StrictMode does not double.
      expect(renders).toBeGreaterThan(2);
      expect(renders).toBeLessThanOrEqual(24);
    });
  });

  it('lets a consumer that needs several measurement passes converge', async () => {
    // The other half of the bound, behaviourally rather than numerically: a
    // budget tight enough to strand a consumer that legitimately needs more than
    // one measurement pass fails here. This box halves its width on every
    // measurement, so it reaches `settled=3px` only if five consecutive
    // self-driven passes are allowed to run; a budget of 2 freezes it on an
    // intermediate width and the frame keeps that width instead.
    const { stdout, lastFrame } = createTestStdout();
    await mount(<ConvergingBox />, stdout);

    expect(lastFrame()).toContain('settled=3px');
  });

  it('settles a cascade driven only by a hasMeasured transition', async () => {
    // `setHasMeasured` schedules a commit of its own, with no changed
    // measurement behind it, so the budget only bounds this cascade if a
    // `hasMeasured` transition arms the guard too. Without that arming every
    // commit takes the refill branch and the mount runs to React's own cap, so
    // the frame asserted below becomes the #185 error instead of the box.
    let renders = 0;
    const { stdout, lastFrame } = createTestStdout();
    await mount(
      <HasMeasuredGatedBox
        onRender={() => {
          renders += 1;
        }}
      />,
      stdout,
    );

    // What the frame pins is the arming's existence, and only that: this fixture
    // detaches its measured element every other commit, so it is unsubscribed
    // for those commits and, whichever of its two states the cascade freezes in,
    // the last non-blank frame is the `fallback` render. The commit count is
    // what makes this a depth assertion - 32 commits at this head, the
    // detached-ref doubling of a budget of 16 - and, unlike the frame, it does
    // not depend on that parity. React's own cap is 50 commits, and a budget
    // raised to 23 or 26 takes this cascade to 46 or 52 while the suite stays
    // green without the bound below.
    expect(lastFrame()).toContain('fallback');
    // The floor is the budget: the cascade spends all 16 charged commits, so a
    // hook that settles early passes the ceiling below without ever reaching it.
    expect(renders).toBeGreaterThanOrEqual(16);
    expect(renders).toBeLessThanOrEqual(34);
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
