/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { MermaidDiagram } from './MermaidDiagram.js';
import { TerminalOutputProvider } from '../contexts/TerminalOutputContext.js';
import { renderMermaidImageAsync } from './mermaidImageRenderer.js';

vi.mock('./mermaidImageRenderer.js', async () => {
  const actual = await vi.importActual<
    typeof import('./mermaidImageRenderer.js')
  >('./mermaidImageRenderer.js');
  return {
    ...actual,
    renderMermaidImageAsync: vi.fn(),
  };
});

const mockedRenderMermaidImageAsync = vi.mocked(renderMermaidImageAsync);

describe('MermaidDiagram', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the wireframe immediately and writes Kitty images through raw output', async () => {
    const writeRaw = vi.fn();
    mockedRenderMermaidImageAsync.mockResolvedValueOnce({
      kind: 'terminal-image',
      title: 'Mermaid diagram image (kitty)',
      sequence: '\x1b_Gpayload\x1b\\',
      rows: 2,
      protocol: 'kitty',
      placeholder: {
        color: '#00002a',
        imageId: 42,
        lines: ['placeholder'],
      },
    });

    const { lastFrame } = render(
      <TerminalOutputProvider value={writeRaw}>
        <MermaidDiagram
          source={'flowchart TD\nA[Start] --> B[End]'}
          sourceCopyCommand="/copy mermaid 1"
          contentWidth={80}
          isPending={false}
          availableTerminalHeight={20}
        />
      </TerminalOutputProvider>,
    );

    expect(lastFrame()).toContain('Mermaid flowchart (TD)');
    await vi.waitFor(() => {
      expect(writeRaw).toHaveBeenCalledWith('\x1b_Gpayload\x1b\\');
    });
  });

  it('does not start image rendering while the Mermaid block is pending', () => {
    render(
      <MermaidDiagram
        source={'flowchart TD\nA[Start] --> B[End]'}
        sourceCopyCommand="/copy mermaid 1"
        contentWidth={80}
        isPending={true}
      />,
    );

    expect(mockedRenderMermaidImageAsync).not.toHaveBeenCalled();
  });
});
