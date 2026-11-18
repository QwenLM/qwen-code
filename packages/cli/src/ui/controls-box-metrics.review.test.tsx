/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, useRef, useState } from 'react';
import { Box, Text, useBoxMetrics, type DOMElement } from 'ink';
import { render, cleanup } from 'ink-testing-library';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(cleanup);

it('PR17541 R1-12 observes a child-only footer growth through the real Ink hook', async () => {
  let grow!: () => void;
  function Footer() {
    const [lines, setLines] = useState(1);
    grow = () => setLines(4);
    return (
      <Text>
        {Array.from({ length: lines }, (_, i) => `footer-${i}`).join('\n')}
      </Text>
    );
  }
  function Host() {
    const ref = useRef<DOMElement>(null);
    const { height } = useBoxMetrics(ref);
    return (
      <Box flexDirection="column">
        <Box ref={ref} flexDirection="column">
          <Footer />
        </Box>
        <Text>measured-height={height}</Text>
      </Box>
    );
  }
  const view = render(<Host />);
  await vi.waitFor(() =>
    expect(view.lastFrame()).toContain('measured-height=1'),
  );
  act(() => grow());
  await vi.waitFor(() =>
    expect(view.lastFrame()).toContain('measured-height=4'),
  );
});
