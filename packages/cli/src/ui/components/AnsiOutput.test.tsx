/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { AnsiOutputText } from './AnsiOutput.js';
import type { AnsiOutput, AnsiToken } from '@qwen-code/qwen-code-core';

// Helper to create a valid AnsiToken with default values
const createAnsiToken = (overrides: Partial<AnsiToken>): AnsiToken => ({
  text: '',
  bold: false,
  italic: false,
  underline: false,
  dim: false,
  inverse: false,
  fg: '#ffffff',
  bg: '#000000',
  ...overrides,
});

describe('<AnsiOutputText />', () => {
  it('renders a simple AnsiOutput object correctly', () => {
    const data: AnsiOutput = [
      [
        createAnsiToken({ text: 'Hello, ' }),
        createAnsiToken({ text: 'world!' }),
      ],
    ];
    const { lastFrame } = render(<AnsiOutputText data={data} maxWidth={80} />);
    expect(lastFrame()).toBe('Hello, world!');
  });

  it('correctly applies all the styles', () => {
    const data: AnsiOutput = [
      [
        createAnsiToken({ text: 'Bold', bold: true }),
        createAnsiToken({ text: 'Italic', italic: true }),
        createAnsiToken({ text: 'Underline', underline: true }),
        createAnsiToken({ text: 'Dim', dim: true }),
        createAnsiToken({ text: 'Inverse', inverse: true }),
      ],
    ];
    // Note: ink-testing-library doesn't render styles, so we can only check the text.
    // We are testing that it renders without crashing.
    const { lastFrame } = render(<AnsiOutputText data={data} maxWidth={80} />);
    expect(lastFrame()).toBe('BoldItalicUnderlineDimInverse');
  });

  it('correctly applies foreground and background colors', () => {
    const data: AnsiOutput = [
      [
        createAnsiToken({ text: 'Red FG', fg: '#ff0000' }),
        createAnsiToken({ text: 'Blue BG', bg: '#0000ff' }),
      ],
    ];
    // Note: ink-testing-library doesn't render colors, so we can only check the text.
    // We are testing that it renders without crashing.
    const { lastFrame } = render(<AnsiOutputText data={data} maxWidth={80} />);
    expect(lastFrame()).toBe('Red FGBlue BG');
  });

  it('handles empty lines and empty tokens', () => {
    const data: AnsiOutput = [
      [createAnsiToken({ text: 'First line' })],
      [],
      [createAnsiToken({ text: 'Third line' })],
      [createAnsiToken({ text: '' })],
    ];
    const { lastFrame } = render(<AnsiOutputText data={data} maxWidth={80} />);
    const output = lastFrame();
    expect(output).toBeDefined();
    const lines = output!.split('\n');
    expect(lines[0]).toBe('First line');
    // Empty AnsiLines are preserved as blank rows so shell output layout
    // matches the terminal it came from.
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe('Third line');
  });

  it('respects the availableTerminalHeight prop and slices the lines correctly', () => {
    const data: AnsiOutput = [
      [createAnsiToken({ text: 'Line 1' })],
      [createAnsiToken({ text: 'Line 2' })],
      [createAnsiToken({ text: 'Line 3' })],
      [createAnsiToken({ text: 'Line 4' })],
    ];
    const { lastFrame } = render(
      <AnsiOutputText data={data} availableTerminalHeight={2} maxWidth={80} />,
    );
    const output = lastFrame();
    expect(output).not.toContain('Line 1');
    expect(output).not.toContain('Line 2');
    expect(output).toContain('Line 3');
    expect(output).toContain('Line 4');
  });

  it('renders a large AnsiOutput object without crashing', () => {
    const largeData: AnsiOutput = [];
    for (let i = 0; i < 1000; i++) {
      largeData.push([createAnsiToken({ text: `Line ${i}` })]);
    }
    const { lastFrame } = render(
      <AnsiOutputText data={largeData} maxWidth={80} />,
    );
    // We are just checking that it renders something without crashing.
    expect(lastFrame()).toBeDefined();
  });

  it('truncates wide lines to fit within maxWidth', () => {
    const wideText = 'A'.repeat(100);
    const data: AnsiOutput = [[createAnsiToken({ text: wideText })]];
    const { lastFrame } = render(<AnsiOutputText data={data} maxWidth={20} />);
    const output = lastFrame()!;
    // The line should be truncated to fit within maxWidth
    expect(output.length).toBeLessThanOrEqual(20);
  });

  it('truncates multi-token wide lines (styled-column output) to maxWidth', () => {
    // Mirrors the real-world shape produced by commands like `gh run list`:
    // a single logical row composed of many styled-column tokens whose
    // combined width far exceeds the available box width. This exercises
    // the MaxSizedBox row.segments.length === 0 path, where truncation
    // depends on per-token wrap="truncate" + ink's flex layout rather
    // than MaxSizedBox performing the crop itself.
    const data: AnsiOutput = [
      [
        createAnsiToken({ text: 'STATUS  ', bold: true }),
        createAnsiToken({ text: 'TITLE  ', bold: true }),
        createAnsiToken({ text: 'WORKFLOW  ', bold: true }),
        createAnsiToken({ text: 'BRANCH  ', bold: true }),
        createAnsiToken({ text: 'EVENT  ', bold: true }),
        createAnsiToken({ text: 'ID  ', bold: true }),
        createAnsiToken({ text: 'ELAPSED  ', bold: true }),
        createAnsiToken({ text: 'AGE', bold: true }),
      ],
    ];
    const maxWidth = 30;
    const { lastFrame } = render(
      <AnsiOutputText data={data} maxWidth={maxWidth} />,
    );
    const output = lastFrame()!;
    for (const line of output.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(maxWidth);
    }
  });
});
