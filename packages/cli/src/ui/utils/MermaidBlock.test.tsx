/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createLoadedSettings } from '../../config/settings.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MermaidArt } from 'lovely-mermaid';
import { MarkdownDisplay } from './MarkdownDisplay.js';
import {
  MERMAID_MAX_ROWS,
  MermaidRenderContext,
  clearMermaidArtCache,
  loadMermaidRenderer,
  mermaidRoleColor,
} from './MermaidBlock.js';
import { theme } from '../semantic-colors.js';
import type { LoadedSettings} from '../../config/settings.js';
import { type Settings } from '../../config/settings.js';
import { renderWithProviders } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';

// Real renderer by default; individual tests can swap in a fake result.
const renderOverride = vi.hoisted(() => ({
  fn: null as null | ((source: string) => unknown),
}));
// Holds the dynamic import open until a test releases it, so the
// not-yet-loaded frame is observable.
const loadGate = vi.hoisted(() => {
  let release: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release: () => release() };
});
vi.mock('lovely-mermaid', async (importOriginal) => {
  await loadGate.opened;
  const actual = await importOriginal<typeof import('lovely-mermaid')>();
  return {
    ...actual,
    render: (source: string) =>
      renderOverride.fn ? renderOverride.fn(source) : actual.render(source),
  };
});

const FLOWCHART = 'graph TD\nA[Start]-->B[Done]';
const fence = (body: string, info = 'mermaid') =>
  '```' + info + '\n' + body + '\n```';

const baseProps = {
  isPending: false,
  terminalWidth: 80,
  availableTerminalHeight: 40,
};

function makeSettings(ui: Settings['ui']): LoadedSettings {
  return createLoadedSettings(
    { path: '', settings: { ui }, originalSettings: { ui } },
    { path: '', settings: {}, originalSettings: {} },
    { path: '', settings: {}, originalSettings: {} },
    true,
    [],
  );
}

function fakeArt(rows: number): MermaidArt {
  return {
    plain: Array.from({ length: rows }, () => '[x]'),
    styled: Array.from({ length: rows }, () => [
      { text: '[x]', role: 'border' as const },
    ]),
    width: 3,
    classDefs: {},
    warnings: [],
  };
}

async function frameOf(
  text: string,
  options: Parameters<typeof renderWithProviders>[1] = {},
  props: Partial<typeof baseProps> = {},
): Promise<string> {
  const result = await renderWithProviders(
    <MarkdownDisplay {...baseProps} {...props} text={text} />,
    options,
  );
  await result.waitUntilReady();
  const frame = result.lastFrame() ?? '';
  result.unmount();
  return frame;
}

describe('<MermaidBlock /> via <MarkdownDisplay />', () => {
  beforeEach(() => {
    renderOverride.fn = null;
    clearMermaidArtCache();
  });

  // Runs first on purpose: the renderer module is loaded once per process.
  it('shows the source until the renderer loads, then the diagram', async () => {
    const result = await renderWithProviders(
      <MarkdownDisplay {...baseProps} text={fence(FLOWCHART)} />,
    );
    expect(result.lastFrame()).toContain('A[Start]-->B[Done]');
    loadGate.release();
    await waitFor(() => {
      expect(result.lastFrame()).toContain('┌');
    });
    expect(result.lastFrame()).not.toContain('-->');
    result.unmount();
  });

  describe('with the renderer loaded', () => {
    beforeEach(async () => {
      loadGate.release();
      await loadMermaidRenderer();
    });

    it('draws a closed mermaid fence as a diagram', async () => {
      const frame = await frameOf(fence(FLOWCHART));
      expect(frame).toContain('┌');
      expect(frame).toContain('▼');
      expect(frame).toContain('Start');
      expect(frame).not.toContain('-->');
      expect(frame).toMatchSnapshot();
    });

    it.each(['Mermaid title="x"', 'MERMAID', 'mermaid\tfoo'])(
      'recognizes the info string %j',
      async (info) => {
        expect(await frameOf(fence(FLOWCHART, info))).toContain('┌');
      },
    );

    it('treats ~~~ fences like ``` fences', async () => {
      const frame = await frameOf('~~~mermaid\n' + FLOWCHART + '\n~~~');
      expect(frame).toContain('┌');
    });

    it('does not treat mermaid-js as mermaid', async () => {
      const frame = await frameOf(fence(FLOWCHART, 'mermaid-js'));
      expect(frame).toContain('-->');
    });

    it.each([true, false])(
      'keeps an unclosed fence as source (isPending=%s)',
      async (isPending) => {
        const frame = await frameOf(
          '```mermaid\n' + FLOWCHART + '\n',
          {},
          { isPending },
        );
        expect(frame).toContain('A[Start]-->B[Done]');
        expect(frame).not.toContain('┌');
      },
    );

    it('keeps prose after an unclosed fence visible', async () => {
      const text =
        'Intro\n\n```mermaid\n' + FLOWCHART + '\n\nThat shows the flow.';
      const frame = await frameOf(text);
      expect(frame).toContain('That shows the flow.');
      expect(frame).not.toContain('┌');
    });

    it('switches to the diagram once a streaming fence closes', async () => {
      const draw = (text: string) => (
        <MarkdownDisplay {...baseProps} isPending={true} text={text} />
      );
      const result = await renderWithProviders(
        draw('Intro\n\n```mermaid\n' + FLOWCHART + '\n'),
      );
      expect(result.lastFrame()).toContain('-->');
      result.rerender(draw('Intro\n\n' + fence(FLOWCHART) + '\n\nMore'));
      await result.waitUntilReady();
      expect(result.lastFrame()).toContain('┌');
      expect(result.lastFrame()).toContain('More');
      result.unmount();
    });

    it('falls back silently for an unsupported diagram type', async () => {
      const gantt = fence('gantt\n  title Plan\n  section A\n  Task :a1, 2024-01-01, 3d');
      const drawn = await frameOf(gantt);
      const plain = await frameOf(gantt, {
        settings: makeSettings({ renderMermaid: false }),
      });
      expect(drawn).toBe(plain);
      expect(drawn).toContain('title Plan');
    });

    it('falls back when the library reports a warning', async () => {
      const broken = 'graph TD\nA-->B\nthis is ((( not mermaid\nC-->D';
      const frame = await frameOf(fence(broken));
      expect(frame).toContain('this is ((( not mermaid');
      expect(frame).not.toContain('┌');
    });

    it('falls back when the library throws', async () => {
      renderOverride.fn = () => {
        throw new Error('boom');
      };
      const frame = await frameOf(fence(FLOWCHART));
      expect(frame).toContain('A[Start]-->B[Done]');
    });

    it('falls back for an empty fence without calling the library', async () => {
      const spy = vi.fn(() => fakeArt(1));
      renderOverride.fn = spy;
      const frame = await frameOf('```mermaid\n   \n```\n\nafter');
      expect(frame).toContain('after');
      expect(spy).not.toHaveBeenCalled();
    });

    it('falls back when the diagram is wider than the terminal', async () => {
      const wide = 'graph LR\nA[Alpha]-->B[Bravo]-->C[Charlie]-->D[Delta]';
      const narrow = await frameOf(fence(wide), {}, { terminalWidth: 20 });
      expect(narrow).toContain('A[Alpha]');
      expect(narrow).not.toContain('┌');
      const roomy = await frameOf(fence(wide), {}, { terminalWidth: 120 });
      expect(roomy).toContain('┌');
    });

    it('falls back when the diagram is taller than the row cap', async () => {
      renderOverride.fn = () => fakeArt(MERMAID_MAX_ROWS + 1);
      const tall = await frameOf(fence(FLOWCHART));
      expect(tall).not.toContain('[x]');

      clearMermaidArtCache();
      renderOverride.fn = () => fakeArt(MERMAID_MAX_ROWS);
      const fits = await frameOf(fence(FLOWCHART));
      expect(fits).toContain('[x]');
    });

    it('shows the source when ui.renderMermaid is false', async () => {
      const frame = await frameOf(fence(FLOWCHART), {
        settings: makeSettings({ renderMermaid: false }),
      });
      expect(frame).toContain('A[Start]-->B[Done]');
    });

    it('shows the source in screen reader mode', async () => {
      const frame = await frameOf(fence(FLOWCHART), {
        settings: makeSettings({ accessibility: { screenReader: true } }),
      });
      expect(frame).toContain('A[Start]-->B[Done]');
    });

    it('shows the source when a parent disables diagrams', async () => {
      const result = await renderWithProviders(
        <MermaidRenderContext.Provider value={false}>
          <MarkdownDisplay {...baseProps} text={fence(FLOWCHART)} />
        </MermaidRenderContext.Provider>,
      );
      await result.waitUntilReady();
      expect(result.lastFrame()).toContain('A[Start]-->B[Done]');
      result.unmount();
    });

    it('draws edge labels', async () => {
      const frame = await frameOf(fence('graph TD\nA[Start]-->|go|B[Done]'));
      expect(frame).toContain('go');
      expect(frame).not.toContain('|go|');
    });
  });
});

// Colors cannot be asserted from rendered frames: the test terminal strips
// them (SVG snapshots of colored output are skipped repo-wide for the same
// reason), so the role mapping is checked directly.
describe('mermaidRoleColor', () => {
  it('maps diagram roles onto theme colors', () => {
    expect(mermaidRoleColor('border')).toBe(theme.border.default);
    expect(mermaidRoleColor('text')).toBe(theme.text.primary);
    expect(mermaidRoleColor('edge')).toBe(theme.text.accent);
    expect(mermaidRoleColor('title')).toBe(theme.text.accent);
    expect(mermaidRoleColor('edgeLabel')).toBe(theme.text.secondary);
    expect(mermaidRoleColor('none')).toBeUndefined();
  });
});
