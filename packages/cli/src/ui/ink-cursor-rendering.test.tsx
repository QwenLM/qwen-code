/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, useRef, useState, type ReactNode } from 'react';
import ansiEscapes from 'ansi-escapes';
import {
  Box,
  render,
  Static,
  Text,
  type DOMElement,
  type Instance,
  useBoxMetrics,
  useCursor,
} from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { getPhysicalCursorPosition } from './components/BaseTextInput.js';

const SHOW_CURSOR = '\u001B[?25h';
const mountedApps = new Set<Instance>();

afterEach(async () => {
  for (const app of mountedApps) {
    await act(async () => {
      app.unmount();
    });
    await app.waitUntilRenderFlush();
  }
  mountedApps.clear();
});

function createTestStdout(rows = 24): {
  stdout: NodeJS.WriteStream;
  read: () => string;
  reset: () => void;
} {
  let chunks: string[] = [];
  const stdout = Object.create(process.stdout, {
    columns: { value: 80 },
    rows: { value: rows },
    isTTY: { value: true },
    write: {
      value(
        chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | (() => void),
        callback?: () => void,
      ) {
        chunks.push(String(chunk));
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
    read: () => chunks.join(''),
    reset: () => {
      chunks = [];
    },
  };
}

function expectedCursorSuffix(visibleLines: number, x = 2): string {
  return (
    ansiEscapes.cursorUp(visibleLines) + ansiEscapes.cursorTo(x) + SHOW_CURSOR
  );
}

async function mount(
  node: ReactNode,
  stdout: NodeJS.WriteStream,
  incrementalRendering: boolean,
): Promise<Instance> {
  let app!: Instance;
  await act(async () => {
    app = render(node, {
      stdout,
      interactive: true,
      incrementalRendering,
      maxFps: 1_000,
      patchConsole: false,
    });
  });
  mountedApps.add(app);
  await app.waitUntilRenderFlush();
  return app;
}

async function updateAndFlush(
  app: Instance,
  update: () => void,
): Promise<void> {
  await act(async () => {
    update();
  });
  await app.waitUntilRenderFlush();
}

async function unmount(app: Instance): Promise<void> {
  await act(async () => {
    app.unmount();
  });
  await app.waitUntilRenderFlush();
  mountedApps.delete(app);
}

function LazyCursorOwner() {
  const ref = useRef<DOMElement | null>(null);
  const { hasMeasured } = useBoxMetrics(ref);
  useCursor().setCursorPosition(
    getPhysicalCursorPosition(ref.current, {
      hasMeasured,
      showCursor: true,
      cursorVisualRow: 0,
      cursorVisualCol: 0,
      scrollVisualRow: 0,
      linesToRender: [''],
      prefixWidth: 2,
    }),
  );
  return (
    <Box ref={ref} flexDirection="column">
      <Text>border</Text>
      <Text>input</Text>
    </Box>
  );
}

describe.each([false, true])(
  'Ink cursor rendering (incrementalRendering: %s)',
  (incrementalRendering) => {
    it('reasserts the cursor after a sibling-only update', async () => {
      const capture = createTestStdout();
      let updateFooter!: () => void;
      let cursorRenderCount = 0;

      function CursorOwner() {
        cursorRenderCount++;
        useCursor().setCursorPosition({ x: 2, y: 0 });
        return <Text>input</Text>;
      }

      function Footer() {
        const [multiline, setMultiline] = useState(false);
        updateFooter = () => setMultiline(true);
        return <Text>{multiline ? 'footer-a\nfooter-b' : 'footer'}</Text>;
      }

      const app = await mount(
        <Box flexDirection="column">
          <CursorOwner />
          <Footer />
        </Box>,
        capture.stdout,
        incrementalRendering,
      );
      expect(cursorRenderCount).toBe(1);
      capture.reset();

      await updateAndFlush(app, updateFooter);

      expect(cursorRenderCount).toBe(1);
      expect(capture.read()).toContain(expectedCursorSuffix(3));
      await unmount(app);
    });

    it('resolves lazy cursor coordinates once per output flush', async () => {
      const capture = createTestStdout();
      let updateFooter!: () => void;
      let xReads = 0;
      let yReads = 0;
      let cursorRenderCount = 0;

      function CursorOwner() {
        cursorRenderCount++;
        const position = useRef({
          get x() {
            xReads++;
            return 2;
          },
          get y() {
            yReads++;
            return 0;
          },
        }).current;
        useCursor().setCursorPosition(position);
        return <Text>input</Text>;
      }

      function Footer() {
        const [version, setVersion] = useState(0);
        updateFooter = () => setVersion((value) => value + 1);
        return <Text>footer-{version}</Text>;
      }

      const app = await mount(
        <Box flexDirection="column">
          <CursorOwner />
          <Footer />
        </Box>,
        capture.stdout,
        incrementalRendering,
      );
      expect(cursorRenderCount).toBe(1);
      xReads = 0;
      yReads = 0;

      await updateAndFlush(app, updateFooter);

      expect(xReads).toBe(1);
      expect(yReads).toBe(1);
      expect(cursorRenderCount).toBe(1);
      xReads = 0;
      yReads = 0;

      await updateAndFlush(app, updateFooter);

      expect(xReads).toBe(1);
      expect(yReads).toBe(1);
      expect(cursorRenderCount).toBe(1);
      await unmount(app);
    });

    it('reasserts the cursor after Static output is appended', async () => {
      const capture = createTestStdout();
      let appendStatic!: () => void;
      let cursorRenderCount = 0;

      function CursorOwner() {
        cursorRenderCount++;
        useCursor().setCursorPosition({ x: 2, y: 0 });
        return <Text>input</Text>;
      }

      function StaticOutput() {
        const [items, setItems] = useState<string[]>([]);
        appendStatic = () => setItems(['done']);
        return (
          <Static items={items}>
            {(item) => <Text key={item}>{item}</Text>}
          </Static>
        );
      }

      const app = await mount(
        <>
          <StaticOutput />
          <Box flexDirection="column">
            <CursorOwner />
            <Text>footer</Text>
          </Box>
        </>,
        capture.stdout,
        incrementalRendering,
      );
      expect(cursorRenderCount).toBe(1);
      capture.reset();

      await updateAndFlush(app, appendStatic);

      expect(cursorRenderCount).toBe(1);
      expect(capture.read()).toContain('done');
      expect(capture.read()).toContain(expectedCursorSuffix(2));
      await unmount(app);
    });

    it('reasserts the cursor after a fullscreen clear and sync', async () => {
      const capture = createTestStdout(2);
      let updateFooter!: () => void;
      let cursorRenderCount = 0;

      function CursorOwner() {
        cursorRenderCount++;
        useCursor().setCursorPosition({ x: 2, y: 0 });
        return <Text>input</Text>;
      }

      function Footer() {
        const [multiline, setMultiline] = useState(false);
        updateFooter = () => setMultiline(true);
        return <Text>{multiline ? 'footer-a\nfooter-b' : 'footer'}</Text>;
      }

      const app = await mount(
        <Box flexDirection="column">
          <CursorOwner />
          <Footer />
        </Box>,
        capture.stdout,
        incrementalRendering,
      );
      expect(cursorRenderCount).toBe(1);
      capture.reset();

      await updateAndFlush(app, updateFooter);

      expect(cursorRenderCount).toBe(1);
      expect(capture.read()).toContain(ansiEscapes.clearTerminal);
      // Fullscreen mode (output >= terminal rows) omits the trailing newline,
      // so the cursor starts one line higher: moveUp = visibleLines - 1 - y.
      expect(capture.read()).toContain(expectedCursorSuffix(2));
      await unmount(app);
    });

    it('positions a lazy cursor after content above it shrinks out of fullscreen', async () => {
      const capture = createTestStdout(6);
      let shrinkHistory!: () => void;

      function History() {
        const [multiline, setMultiline] = useState(true);
        shrinkHistory = () => setMultiline(false);
        return <Text>{multiline ? 'history-a\nhistory-b' : 'history'}</Text>;
      }

      const app = await mount(
        <Box flexDirection="column">
          <History />
          <LazyCursorOwner />
          <Text>{'footer-a\nfooter-b'}</Text>
        </Box>,
        capture.stdout,
        incrementalRendering,
      );
      capture.reset();

      await updateAndFlush(app, shrinkHistory);

      const output = capture.read();
      expect(output).toContain(ansiEscapes.clearTerminal);
      expect(output).not.toContain(
        'history\nborder\ninput\nfooter-a\nfooter-b\n' +
          expectedCursorSuffix(2),
      );
      expect(output).toContain(
        'history\nborder\ninput\nfooter-a\nfooter-b\n' +
          expectedCursorSuffix(3),
      );
      await unmount(app);
    });

    it('positions the hardware cursor at the correct row in fullscreen (y > 0)', async () => {
      // Regression test for QwenLM/qwen-code#7980: in fullscreen mode the
      // output has no trailing newline, so the terminal cursor sits ON the
      // last line rather than one past it. buildCursorSuffix must account
      // for this, otherwise the hardware cursor lands one row too high.
      const capture = createTestStdout(3);

      function CursorOwner() {
        // y=1 — the second row of the 3-line output. With the old bug the
        // escape sequence would move the cursor to y=0 instead.
        useCursor().setCursorPosition({ x: 2, y: 1 });
        return <Text>input</Text>;
      }

      const app = await mount(
        <Box flexDirection="column">
          <CursorOwner />
          <Text>{'mid\nbottom'}</Text>
        </Box>,
        capture.stdout,
        incrementalRendering,
      );

      // 3 visible lines, fullscreen (3 >= 3 rows), no trailing \n.
      // Terminal cursor after write: line 2. Target: y=1.
      // Correct moveUp = 2 - 1 = 1.
      const output = capture.read();
      expect(output).toContain(
        ansiEscapes.cursorUp(1) + ansiEscapes.cursorTo(2) + SHOW_CURSOR,
      );
      // The buggy value would have been cursorUp(2) — verify it's absent.
      expect(output).not.toContain(
        ansiEscapes.cursorUp(2) + ansiEscapes.cursorTo(2) + SHOW_CURSOR,
      );
      await unmount(app);
    });

    it('preserves cursor-only position updates', async () => {
      const capture = createTestStdout();
      let moveCursor!: () => void;

      function CursorOwner() {
        const [x, setX] = useState(2);
        moveCursor = () => setX(4);
        useCursor().setCursorPosition({ x, y: 0 });
        return <Text>input</Text>;
      }

      const app = await mount(
        <Box flexDirection="column">
          <CursorOwner />
          <Text>footer</Text>
        </Box>,
        capture.stdout,
        incrementalRendering,
      );
      capture.reset();

      await updateAndFlush(app, moveCursor);

      expect(capture.read()).toContain(expectedCursorSuffix(2, 4));
      await unmount(app);
    });

    it('preserves cursor-only position updates in fullscreen', async () => {
      const capture = createTestStdout(2);
      let moveCursor!: () => void;

      function CursorOwner() {
        const [x, setX] = useState(2);
        moveCursor = () => setX(4);
        useCursor().setCursorPosition({ x, y: 0 });
        return <Text>input</Text>;
      }

      const app = await mount(
        <Box flexDirection="column">
          <CursorOwner />
          <Text>footer</Text>
        </Box>,
        capture.stdout,
        incrementalRendering,
      );
      capture.reset();

      await updateAndFlush(app, moveCursor);

      // Fullscreen (2 lines >= 2 rows): no trailing newline, so
      // moveUp = (visibleLines - 1) - y = 1, not visibleLines - y = 2.
      const output = capture.read();
      expect(output).toContain(
        ansiEscapes.cursorUp(1) + ansiEscapes.cursorTo(4) + SHOW_CURSOR,
      );
      expect(output).not.toContain(
        ansiEscapes.cursorUp(2) + ansiEscapes.cursorTo(4) + SHOW_CURSOR,
      );
      await unmount(app);
    });

    it('reasserts the latest committed cursor after a later sibling update', async () => {
      const capture = createTestStdout();
      let moveCursor!: () => void;
      let updateFooter!: () => void;
      let cursorRenderCount = 0;

      function CursorOwner() {
        cursorRenderCount++;
        const [x, setX] = useState(2);
        moveCursor = () => setX(4);
        useCursor().setCursorPosition({ x, y: 0 });
        return <Text>input</Text>;
      }

      function Footer() {
        const [multiline, setMultiline] = useState(false);
        updateFooter = () => setMultiline(true);
        return <Text>{multiline ? 'footer-a\nfooter-b' : 'footer'}</Text>;
      }

      const app = await mount(
        <Box flexDirection="column">
          <CursorOwner />
          <Footer />
        </Box>,
        capture.stdout,
        incrementalRendering,
      );

      await updateAndFlush(app, moveCursor);
      expect(cursorRenderCount).toBe(2);
      capture.reset();

      await updateAndFlush(app, updateFooter);

      expect(cursorRenderCount).toBe(2);
      expect(capture.read()).toContain(expectedCursorSuffix(3, 4));
      await unmount(app);
    });

    it.each([
      { direction: 'grows', initiallyMultiline: false, staleCursorUp: 3 },
      { direction: 'shrinks', initiallyMultiline: true, staleCursorUp: 1 },
    ])(
      'does not show a stale cursor when content above the input $direction',
      async ({ initiallyMultiline, staleCursorUp }) => {
        const capture = createTestStdout();
        let updateHistory!: () => void;

        function History() {
          const [multiline, setMultiline] = useState(initiallyMultiline);
          updateHistory = () => setMultiline(!initiallyMultiline);
          return <Text>{multiline ? 'history-a\nhistory-b' : 'history'}</Text>;
        }

        const app = await mount(
          <Box flexDirection="column">
            <History />
            <LazyCursorOwner />
            <Text>footer</Text>
          </Box>,
          capture.stdout,
          incrementalRendering,
        );
        capture.reset();

        await updateAndFlush(app, updateHistory);

        const output = capture.read();
        expect(output).not.toContain(expectedCursorSuffix(staleCursorUp));
        expect(output).toContain(expectedCursorSuffix(2));
        await unmount(app);
      },
    );

    it('does not write when a sibling rerenders identical output', async () => {
      const capture = createTestStdout();
      let updateFooter!: () => void;
      let cursorRenderCount = 0;

      function CursorOwner() {
        cursorRenderCount++;
        useCursor().setCursorPosition({ x: 2, y: 0 });
        return <Text>input</Text>;
      }

      function Footer() {
        const [, setVersion] = useState(0);
        updateFooter = () => setVersion((version) => version + 1);
        return <Text>footer</Text>;
      }

      const app = await mount(
        <Box flexDirection="column">
          <CursorOwner />
          <Footer />
        </Box>,
        capture.stdout,
        incrementalRendering,
      );
      expect(cursorRenderCount).toBe(1);
      capture.reset();

      await updateAndFlush(app, updateFooter);

      expect(cursorRenderCount).toBe(1);
      expect(capture.read()).toBe('');
      await unmount(app);
    });

    it('does not restore a cursor after its owner unmounts', async () => {
      const capture = createTestStdout();
      let removeCursor!: () => void;
      let updateFooter!: () => void;
      let cursorRenderCount = 0;

      function CursorOwner() {
        cursorRenderCount++;
        useCursor().setCursorPosition({ x: 2, y: 0 });
        return <Text>input</Text>;
      }

      function CursorBoundary() {
        const [mounted, setMounted] = useState(true);
        removeCursor = () => setMounted(false);
        return mounted ? <CursorOwner /> : null;
      }

      function Footer() {
        const [value, setValue] = useState('footer');
        updateFooter = () => setValue('footer-updated');
        return <Text>{value}</Text>;
      }

      const app = await mount(
        <Box flexDirection="column">
          <CursorBoundary />
          <Footer />
        </Box>,
        capture.stdout,
        incrementalRendering,
      );
      await updateAndFlush(app, removeCursor);
      expect(cursorRenderCount).toBe(1);
      capture.reset();

      await updateAndFlush(app, updateFooter);

      expect(cursorRenderCount).toBe(1);
      const output = capture.read();
      expect(output).toContain('footer-updated');
      expect(output).not.toContain(SHOW_CURSOR);
      await unmount(app);
    });

    it('does not restore a cursor after its owner hides it', async () => {
      const capture = createTestStdout();
      let hideCursor!: () => void;
      let updateFooter!: () => void;
      let cursorRenderCount = 0;

      function CursorOwner() {
        const [visible, setVisible] = useState(true);
        hideCursor = () => setVisible(false);
        cursorRenderCount++;
        useCursor().setCursorPosition(visible ? { x: 2, y: 0 } : undefined);
        return <Text>input</Text>;
      }

      function Footer() {
        const [value, setValue] = useState('footer');
        updateFooter = () => setValue('footer-updated');
        return <Text>{value}</Text>;
      }

      const app = await mount(
        <Box flexDirection="column">
          <CursorOwner />
          <Footer />
        </Box>,
        capture.stdout,
        incrementalRendering,
      );
      await updateAndFlush(app, hideCursor);
      expect(cursorRenderCount).toBe(2);
      capture.reset();

      await updateAndFlush(app, updateFooter);

      expect(cursorRenderCount).toBe(2);
      const output = capture.read();
      expect(output).toContain('footer-updated');
      expect(output).not.toContain(SHOW_CURSOR);
      await unmount(app);
    });
  },
);
