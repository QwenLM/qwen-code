/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { renderMermaidVisual } from './mermaidVisualRenderer.js';

describe('mermaid visual renderer', () => {
  it('expands chained flowchart edges into adjacent edges', () => {
    const preview = renderMermaidVisual(
      `
flowchart TD
  A[Start] -->|Go| B[Middle] --> C[End]
`,
      80,
    );
    const output = preview.lines.join('\n');

    expect(preview.title).toBe('Mermaid flowchart (TD)');
    expect(output).toContain('Start');
    expect(output).toContain('Middle');
    expect(output).toContain('End');
    expect(output).toContain('Go');
    expect(output).not.toContain('Middle] --> C');
  });

  it('keeps CJK labels aligned without treating ghost cells as collisions', () => {
    const preview = renderMermaidVisual(
      `
flowchart TD
  A[用户登录] --> B{是否登录?}
  B -->|是| C[显示主页]
  B -->|否| D[显示登录页]
`,
      60,
    );
    const output = preview.lines.join('\n');

    expect(preview.title).toBe('Mermaid flowchart (TD)');
    expect(output).toContain('用户登录');
    expect(output).toContain('是否登录?');
    expect(output).toContain('显示主页');
    expect(output).toContain('显示登录页');
    expect(output).toContain('是');
    expect(output).toContain('否');
  });

  it('strips terminal control sequences from rendered labels', () => {
    const escape = String.fromCharCode(27);
    const c1Control = `${String.fromCharCode(0x9b)}31m`;
    const preview = renderMermaidVisual(
      `
flowchart TD
  A[${escape}[2J${c1Control}Start] -->|${escape}[31mYes${escape}[0m| B[Done]
`,
      80,
    );
    const output = preview.lines.join('\n');

    expect(output).toContain('Start');
    expect(output).toContain('Yes');
    expect(output).toContain('Done');
    expect(output).not.toContain(escape);
    expect(output).not.toContain(c1Control);
    expect(output).not.toContain('[2J');
    expect(output).not.toContain('[31m');
  });

  it('strips terminal control sequences from source fallback', () => {
    const escape = String.fromCharCode(27);
    const c1Control = `${String.fromCharCode(0x9b)}31m`;
    const preview = renderMermaidVisual(
      `
unknownDiagram
  ${escape}[2J${c1Control}unsafe fallback
`,
      80,
    );
    const output = preview.lines.join('\n');

    expect(preview.title).toBe('Mermaid source (unknownDiagram)');
    expect(output).toContain('unsafe fallback');
    expect(output).not.toContain(escape);
    expect(output).not.toContain(c1Control);
    expect(output).not.toContain('[2J');
  });
});
