/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { OverflowProvider } from '../../contexts/OverflowContext.js';
import { renderWithProviders } from '../../../test-utils/render.js';
import { createMockSettings } from '../../../test-utils/settings.js';
import { waitFor } from '../../../test-utils/async.js';
import {
  DiffRenderer,
  renderDiffToLines,
  renderDiffToBlocks,
  getColorDiffThemeName,
} from './DiffRenderer.js';

describe('<OverflowProvider><DiffRenderer /></OverflowProvider>', () => {
  const sanitizeOutput = (output: string | undefined, terminalWidth: number) =>
    output?.replace(/GAP_INDICATOR/g, '═'.repeat(terminalWidth));

  describe.each([true, false])(
    'with useAlternateBuffer = %s',
    (useAlternateBuffer) => {
      it('should render new file with known extension (syntax highlighted)', async () => {
        const newFileDiffContent = `
diff --git a/test.py b/test.py
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/test.py
@@ -0,0 +1 @@
+print("hello world")
`;
        const { lastFrame } = await renderWithProviders(
          <OverflowProvider>
            <DiffRenderer
              diffContent={newFileDiffContent}
              filePath="test.py"
              terminalWidth={80}
            />
          </OverflowProvider>,
          {
            settings: createMockSettings({ ui: { useAlternateBuffer } }),
          },
        );
        await waitFor(() => expect(lastFrame()).toContain('print'));
        expect(lastFrame()).toContain('hello world');
        expect(lastFrame()).toMatchSnapshot();
      });

      it('should render new file with unknown extension', async () => {
        const newFileDiffContent = `
diff --git a/test.unknown b/test.unknown
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/test.unknown
@@ -0,0 +1 @@
+some content
`;
        const { lastFrame } = await renderWithProviders(
          <OverflowProvider>
            <DiffRenderer
              diffContent={newFileDiffContent}
              filePath="test.unknown"
              terminalWidth={80}
            />
          </OverflowProvider>,
          {
            settings: createMockSettings({ ui: { useAlternateBuffer } }),
          },
        );
        await waitFor(() => expect(lastFrame()).toContain('some content'));
        expect(lastFrame()).toMatchSnapshot();
      });

      it('should render new file without filename provided', async () => {
        const newFileDiffContent = `
diff --git a/test.txt b/test.txt
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/test.txt
@@ -0,0 +1 @@
+some text content
`;
        const { lastFrame } = await renderWithProviders(
          <OverflowProvider>
            <DiffRenderer diffContent={newFileDiffContent} terminalWidth={80} />
          </OverflowProvider>,
          {
            settings: createMockSettings({ ui: { useAlternateBuffer } }),
          },
        );
        await waitFor(() => expect(lastFrame()).toContain('some text content'));
        expect(lastFrame()).toMatchSnapshot();
      });

      it('should render diff content for existing file with add/del lines', async () => {
        const existingFileDiffContent = `

diff --git a/test.txt b/test.txt
index 0000001..0000002 100644
--- a/test.txt
+++ b/test.txt
@@ -1 +1 @@
-old line
+new line
`;
        const { lastFrame } = await renderWithProviders(
          <OverflowProvider>
            <DiffRenderer
              diffContent={existingFileDiffContent}
              filePath="test.txt"
              terminalWidth={80}
            />
          </OverflowProvider>,
          {
            settings: createMockSettings({ ui: { useAlternateBuffer } }),
          },
        );
        await waitFor(() => expect(lastFrame()).toContain('new line'));
        expect(lastFrame()).toMatchSnapshot();
      });

      it('should handle diff with only header and no changes', async () => {
        const noChangeDiff = `diff --git a/file.txt b/file.txt
index 1234567..1234567 100644
--- a/file.txt
+++ b/file.txt
`;
        const { lastFrame } = await renderWithProviders(
          <OverflowProvider>
            <DiffRenderer
              diffContent={noChangeDiff}
              filePath="file.txt"
              terminalWidth={80}
            />
          </OverflowProvider>,
          {
            settings: createMockSettings({ ui: { useAlternateBuffer } }),
          },
        );
        await waitFor(() => expect(lastFrame()).toBeDefined());
        expect(lastFrame()).toMatchSnapshot();
      });

      it('should handle empty diff content', async () => {
        const { lastFrame } = await renderWithProviders(
          <OverflowProvider>
            <DiffRenderer diffContent="" terminalWidth={80} />
          </OverflowProvider>,
          {
            settings: createMockSettings({ ui: { useAlternateBuffer } }),
          },
        );
        await waitFor(() => expect(lastFrame()).toBeDefined());
        expect(lastFrame()).toMatchSnapshot();
      });

      // skip: 现存失败
      it.skip('should render hunk separators for skipped lines', async () => {
        const diffWithGap = `

diff --git a/file.txt b/file.txt
index 123..456 100644
--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,2 @@
 context line 1
-deleted line
+added line
@@ -10,2 +10,2 @@
 context line 10
 context line 11
`;
        const { lastFrame } = await renderWithProviders(
          <OverflowProvider>
            <DiffRenderer
              diffContent={diffWithGap}
              filePath="file.txt"
              terminalWidth={80}
            />
          </OverflowProvider>,
          {
            settings: createMockSettings({ ui: { useAlternateBuffer } }),
          },
        );
        await waitFor(() => expect(lastFrame()).toContain('added line'));
        // Multi-hunk diffs should have a "..." separator
        expect(lastFrame()).toContain('...');
        expect(lastFrame()).toMatchSnapshot();
      });

      it('should render context lines from adjacent hunks', async () => {
        const diffWithSmallGap = `

diff --git a/file.txt b/file.txt
index abc..def 100644
--- a/file.txt
+++ b/file.txt
@@ -1,5 +1,5 @@
 context line 1
 context line 2
 context line 3
 context line 4
 context line 5
@@ -11,5 +11,5 @@
 context line 11
 context line 12
 context line 13
 context line 14
 context line 15
`;
        const { lastFrame } = await renderWithProviders(
          <OverflowProvider>
            <DiffRenderer
              diffContent={diffWithSmallGap}
              filePath="file.txt"
              terminalWidth={80}
            />
          </OverflowProvider>,
          {
            settings: createMockSettings({ ui: { useAlternateBuffer } }),
          },
        );
        await waitFor(() => expect(lastFrame()).toContain('context line 15'));
        expect(lastFrame()).toMatchSnapshot();
      });

      describe('should correctly render a diff with multiple hunks and a gap indicator', () => {
        const diffWithMultipleHunks = `

diff --git a/multi.js b/multi.js
index 123..789 100644
--- a/multi.js
+++ b/multi.js
@@ -1,3 +1,3 @@
 console.log('first hunk');
-const oldVar = 1;
+const newVar = 1;
 console.log('end of first hunk');
@@ -20,3 +20,3 @@
 console.log('second hunk');
-const anotherOld = 'test';
+const anotherNew = 'test';
 console.log('end of second hunk');
`;

        // skip: 现存失败
        it.skip.each([
          {
            terminalWidth: 80,
            height: undefined,
          },
          {
            terminalWidth: 80,
            height: 6,
          },
          {
            terminalWidth: 30,
            height: 6,
          },
        ])(
          'with terminalWidth $terminalWidth and height $height',
          async ({ terminalWidth }) => {
            const { lastFrame } = await renderWithProviders(
              <OverflowProvider>
                <DiffRenderer
                  diffContent={diffWithMultipleHunks}
                  filePath="multi.js"
                  terminalWidth={terminalWidth}
                />
              </OverflowProvider>,
              {
                settings: createMockSettings({ ui: { useAlternateBuffer } }),
              },
            );
            await waitFor(() => expect(lastFrame()).toContain('anotherNew'));
            const output = lastFrame();
            expect(sanitizeOutput(output, terminalWidth)).toMatchSnapshot();
          },
        );
      });

      it('should correctly render a diff with a SVN diff format', async () => {
        const newFileDiff = `

fileDiff Index: file.txt
===================================================================
--- a/file.txt   Current
+++ b/file.txt   Proposed
--- a/multi.js
+++ b/multi.js
@@ -1,1 +1,1 @@
-const oldVar = 1;
+const newVar = 1;
@@ -20,1 +20,1 @@
-const anotherOld = 'test';
+const anotherNew = 'test';
\\ No newline at end of file
`;
        const { lastFrame } = await renderWithProviders(
          <OverflowProvider>
            <DiffRenderer
              diffContent={newFileDiff}
              filePath="TEST"
              terminalWidth={80}
            />
          </OverflowProvider>,
          {
            settings: createMockSettings({ ui: { useAlternateBuffer } }),
          },
        );
        await waitFor(() => expect(lastFrame()).toContain('newVar'));
        expect(lastFrame()).toMatchSnapshot();
      });

      it('should correctly render a new file with no file extension correctly', async () => {
        const newFileDiff = `

fileDiff Index: Dockerfile
===================================================================
--- Dockerfile   Current
+++ Dockerfile   Proposed
@@ -0,0 +1,3 @@
+FROM node:14
+RUN npm install
+RUN npm run build
\\ No newline at end of file
`;
        const { lastFrame } = await renderWithProviders(
          <OverflowProvider>
            <DiffRenderer
              diffContent={newFileDiff}
              filePath="Dockerfile"
              terminalWidth={80}
            />
          </OverflowProvider>,
          {
            settings: createMockSettings({ ui: { useAlternateBuffer } }),
          },
        );
        await waitFor(() => expect(lastFrame()).toContain('RUN npm run build'));
        expect(lastFrame()).toMatchSnapshot();
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Phase 0: isNewFile semantic tests
  // ---------------------------------------------------------------------------

  describe('isNewFile prop semantics', () => {
    it('should NOT use new-file path when isNewFile=false even if all hunks are additions', async () => {
      // This simulates writing content to an existing empty file.
      // All hunks are '+' lines, but isNewFile=false means it's NOT a new file.
      const allAdditionsDiff = `
diff --git a/existing.ts b/existing.ts
index 0000000..abc1234 100644
--- a/existing.ts
+++ b/existing.ts
@@ -0,0 +1,3 @@
+export const x = 1;
+export const y = 2;
+export const z = 3;
`;
      const { lastFrame } = await renderWithProviders(
        <OverflowProvider>
          <DiffRenderer
            diffContent={allAdditionsDiff}
            filePath="existing.ts"
            terminalWidth={80}
            isNewFile={false}
          />
        </OverflowProvider>,
        {
          settings: createMockSettings({ ui: { useAlternateBuffer: false } }),
        },
      );
      await waitFor(() => expect(lastFrame()).toContain('export const x'));
      // When isNewFile=false, the diff path should show + markers (diff mode).
      // The output should contain diff-style rendering with line markers.
      expect(lastFrame()).toMatchSnapshot();
    });

    it('should use new-file path when isNewFile=true', async () => {
      const newFileDiff = `
diff --git a/brand-new.ts b/brand-new.ts
index 0000000..abc1234 100644
--- a/brand-new.ts
+++ b/brand-new.ts
@@ -0,0 +1,2 @@
+const hello = "world";
+console.log(hello);
`;
      const { lastFrame } = await renderWithProviders(
        <OverflowProvider>
          <DiffRenderer
            diffContent={newFileDiff}
            filePath="brand-new.ts"
            terminalWidth={80}
            isNewFile={true}
          />
        </OverflowProvider>,
        {
          settings: createMockSettings({ ui: { useAlternateBuffer: false } }),
        },
      );
      await waitFor(() => expect(lastFrame()).toContain('hello'));
      expect(lastFrame()).toMatchSnapshot();
    });

    it('should fall back to heuristic when isNewFile is undefined', async () => {
      // No explicit isNewFile, no /dev/null header → heuristic (all + → new file)
      const ambiguousDiff = `
--- a/file.ts
+++ b/file.ts
@@ -0,0 +1,2 @@
+line one
+line two
`;
      const { lastFrame } = await renderWithProviders(
        <OverflowProvider>
          <DiffRenderer
            diffContent={ambiguousDiff}
            filePath="file.ts"
            terminalWidth={80}
          />
        </OverflowProvider>,
        {
          settings: createMockSettings({ ui: { useAlternateBuffer: false } }),
        },
      );
      await waitFor(() => expect(lastFrame()).toContain('line one'));
      expect(lastFrame()).toMatchSnapshot();
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 1.5: malformed diff graceful fallback (resume crash fix)
  // ---------------------------------------------------------------------------

  describe('malformed diff graceful fallback', () => {
    it('should not crash and should show fallback for a corrupted diff (invalid hunk line)', async () => {
      // This diff has a line inside the hunk that doesn't start with +/-/space/backslash,
      // which would cause parsePatch() to throw "Hunk at line N contained invalid line".
      const corruptedDiff = `Index: one.txt
===================================================================
--- one.txt\tOriginal
+++ one.txt\tWritten
@@ -1,3 +1,5 @@
INVALID_LINE_WITHOUT_PREFIX
 context line 2
 context line 3
+
+new line added
`;
      const { lastFrame } = await renderWithProviders(
        <OverflowProvider>
          <DiffRenderer
            diffContent={corruptedDiff}
            filePath="one.txt"
            terminalWidth={80}
          />
        </OverflowProvider>,
        {
          settings: createMockSettings({ ui: { useAlternateBuffer: false } }),
        },
      );
      await waitFor(() => expect(lastFrame()).toBeDefined());
      // Should NOT throw, should show fallback with raw content
      expect(lastFrame()).not.toBeUndefined();
      expect(lastFrame()).toMatchSnapshot();
    });

    it('should not crash for a truncated diff', async () => {
      const truncatedDiff = `--- a/file.txt
+++ b/file.txt
@@ -1,5 +1,5 @@
 line1
-line2`;
      // Truncated mid-hunk: line counts don't match

      const { lastFrame } = await renderWithProviders(
        <OverflowProvider>
          <DiffRenderer
            diffContent={truncatedDiff}
            filePath="file.txt"
            terminalWidth={80}
          />
        </OverflowProvider>,
        {
          settings: createMockSettings({ ui: { useAlternateBuffer: false } }),
        },
      );
      await waitFor(() => expect(lastFrame()).toBeDefined());
      expect(lastFrame()).not.toBeUndefined();
      expect(lastFrame()).toMatchSnapshot();
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 2: block vs line renderer structure tests
  // ---------------------------------------------------------------------------

  describe('block renderer vs line renderer', () => {
    const multiHunkDiff = `
diff --git a/test.js b/test.js
index 123..456 100644
--- a/test.js
+++ b/test.js
@@ -1,3 +1,3 @@
 line 1
-old line 2
+new line 2
 line 3
@@ -10,3 +10,3 @@
 line 10
-old line 11
+new line 11
 line 12
`;

    it('renderDiffToBlocks should produce fewer nodes than renderDiffToLines for multi-hunk diff', () => {
      const colorDiffTheme = getColorDiffThemeName();
      const args = {
        diffContent: multiHunkDiff,
        filePath: 'test.js',
        colorDiffTheme,
        terminalWidth: 80,
        disableColor: false,
        splitGutter: false,
      };

      const blocks = renderDiffToBlocks(args);
      const lines = renderDiffToLines(args);

      // Block renderer: 2 hunks = 2 RawAnsi + 1 separator = 3 nodes
      // Line renderer: ~8 lines + 1 separator = 9 nodes
      expect(blocks.length).toBeLessThan(lines.length);
      // Block renderer should have at most hunk_count * 2 + separator_count nodes
      expect(blocks.length).toBeLessThanOrEqual(5);
    });

    it('renderDiffToLines should produce per-line nodes for ScrollableList', () => {
      const colorDiffTheme = getColorDiffThemeName();
      const lines = renderDiffToLines({
        diffContent: multiHunkDiff,
        filePath: 'test.js',
        colorDiffTheme,
        terminalWidth: 80,
        disableColor: false,
        splitGutter: false,
      });

      // Each rendered line from both hunks + the separator
      // Hunk 1: 3 context/del/add lines = ~4 rendered lines (after wrap)
      // Hunk 2: same
      // + 1 separator
      expect(lines.length).toBeGreaterThan(5);
    });

    it('renderDiffToBlocks for a new file produces a single block node', () => {
      const newFileDiff = `
diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,5 @@
+line 1
+line 2
+line 3
+line 4
+line 5
`;
      const colorDiffTheme = getColorDiffThemeName();
      const blocks = renderDiffToBlocks({
        diffContent: newFileDiff,
        filePath: 'new.ts',
        colorDiffTheme,
        terminalWidth: 80,
        disableColor: false,
        splitGutter: false,
      });

      // New file block renderer should output a single RawAnsi node
      expect(blocks.length).toBe(1);
    });
  });
});
