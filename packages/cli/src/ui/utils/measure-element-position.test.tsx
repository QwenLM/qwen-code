/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';
import { describe, it, expect } from 'vitest';
import { render, Box, Text, type DOMElement } from 'ink';
import { measureElementPosition } from './measure-element-position.js';

function createTestStdout() {
  const stdout = Object.create(process.stdout, {
    columns: { value: 80 },
    rows: { value: 24 },
    write: {
      value() {
        return true;
      },
    },
  });
  return { stdout };
}

describe('measureElementPosition', () => {
  it('should return {0,0} for root-level element', async () => {
    const { stdout } = createTestStdout();
    let result: ReturnType<typeof measureElementPosition> | null = null;

    function Test() {
      const ref = useRef<DOMElement>(null);
      useEffect(() => {
        if (ref.current) {
          result = measureElementPosition(ref.current);
        }
      }, []);
      return (
        <Box ref={ref}>
          <Text>hello</Text>
        </Box>
      );
    }

    const app = render(<Test />, {
      stdout,
      patchConsole: false,
    });
    await new Promise((r) => setTimeout(r, 50));
    app.unmount();

    expect(result).not.toBeNull();
    expect(result!.x).toBe(0);
    expect(result!.y).toBe(0);
    expect(result!.width).toBeGreaterThan(0);
    expect(result!.height).toBeGreaterThan(0);
  });

  it('should accumulate parent padding/margin offsets', async () => {
    const { stdout } = createTestStdout();
    let result: ReturnType<typeof measureElementPosition> | null = null;

    function Test() {
      const ref = useRef<DOMElement>(null);
      useEffect(() => {
        if (ref.current) {
          result = measureElementPosition(ref.current);
        }
      }, []);
      return (
        <Box paddingLeft={3} paddingTop={2}>
          <Box ref={ref}>
            <Text>nested</Text>
          </Box>
        </Box>
      );
    }

    const app = render(<Test />, {
      stdout,
      patchConsole: false,
    });
    await new Promise((r) => setTimeout(r, 50));
    app.unmount();

    expect(result).not.toBeNull();
    expect(result!.x).toBe(3);
    expect(result!.y).toBe(2);
  });

  it('should account for sibling offset', async () => {
    const { stdout } = createTestStdout();
    let result: ReturnType<typeof measureElementPosition> | null = null;

    function Test() {
      const ref = useRef<DOMElement>(null);
      useEffect(() => {
        if (ref.current) {
          result = measureElementPosition(ref.current);
        }
      }, []);
      return (
        <Box flexDirection="column">
          <Box height={3}>
            <Text>sibling above</Text>
          </Box>
          <Box ref={ref}>
            <Text>target</Text>
          </Box>
        </Box>
      );
    }

    const app = render(<Test />, {
      stdout,
      patchConsole: false,
    });
    await new Promise((r) => setTimeout(r, 50));
    app.unmount();

    expect(result).not.toBeNull();
    expect(result!.y).toBe(3);
  });

  it('should return zeroes for unmounted node', () => {
    const fakeNode = {
      yogaNode: undefined,
      parentNode: undefined,
    } as unknown as DOMElement;
    const result = measureElementPosition(fakeNode);
    expect(result).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});
