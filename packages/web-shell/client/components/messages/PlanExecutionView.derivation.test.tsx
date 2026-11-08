// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TodoItem } from '../../adapters/types';
import { I18nProvider } from '../../i18n';
import { TranscriptRenderModeProvider } from '../../transcriptRenderMode';

// Acceptance #10865, graph-side guarantees, pinned by counting rather than
// by inspection:
//  - hovering a node re-renders without re-running the topological layering
//    or the topology serialization;
//  - `measure` runs at most once per animation frame even when a resize
//    storm lands several schedule calls inside one frame.
// In its own file so the module mock cannot reach the behavioural suite
// next to it.
const counts = vi.hoisted(() => ({ layers: 0 }));

vi.mock('./PlanExecutionView', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./PlanExecutionView')>();
  return {
    ...actual,
    layerPlanTodos: (...args: Parameters<typeof actual.layerPlanTodos>) => {
      counts.layers += 1;
      return actual.layerPlanTodos(...args);
    },
  };
});

const { PlanExecutionView } = await import('./PlanExecutionView');

const todos: TodoItem[] = [
  { id: 'research', content: 'Research', status: 'completed' },
  {
    id: 'build',
    content: 'Build',
    status: 'in_progress',
    blockedBy: ['research'],
  },
  {
    id: 'verify',
    content: 'Verify',
    status: 'pending',
    blockedBy: ['build'],
  },
];

// Each test's tree is unmounted after the test: the graph binds a window
// resize listener, and a leaked listener would double-count the next test's
// resize storm.
const roots: Root[] = [];

function mount(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <TranscriptRenderModeProvider>
          <PlanExecutionView todos={todos} tools={[]} tasks={[]} />
        </TranscriptRenderModeProvider>
      </I18nProvider>,
    );
  });
  return container;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
});

describe('PlanExecutionView derivation discipline', () => {
  it('does not re-run the layering or the topology serialization on hover', () => {
    const container = mount();
    const stringifySpy = vi.spyOn(JSON, 'stringify');
    const layersAfterMount = counts.layers;
    const stringifyAfterMount = stringifySpy.mock.calls.length;

    const buildNode = container
      .querySelector('[data-plan-node-id="build"]')
      ?.closest('article');
    expect(buildNode).toBeTruthy();

    const edges = container.querySelector('[data-plan-edge]')?.closest('svg');
    expect(edges?.getAttribute('data-focused')).toBeNull();

    // jsdom has no PointerEvent; React synthesizes onPointerEnter from a
    // bubbling pointerover, and onPointerLeave from pointerout.
    act(() => {
      buildNode?.dispatchEvent(
        new MouseEvent('pointerover', { bubbles: true }),
      );
    });

    // The hover did re-render (focus state flipped)...
    const focused = container.querySelector('[data-plan-edge]')?.closest('svg');
    expect(focused?.getAttribute('data-focused')).toBe('true');

    // ...but the derivation did not re-run: no extra topological layering,
    // no extra topology serialization.
    expect(counts.layers).toBe(layersAfterMount);
    expect(stringifySpy.mock.calls.length).toBe(stringifyAfterMount);

    act(() => {
      buildNode?.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
    });
    const unfocused = container
      .querySelector('[data-plan-edge]')
      ?.closest('svg');
    expect(unfocused?.getAttribute('data-focused')).toBeNull();
    expect(counts.layers).toBe(layersAfterMount);
    expect(stringifySpy.mock.calls.length).toBe(stringifyAfterMount);

    stringifySpy.mockRestore();
  });

  it('coalesces a same-frame resize storm into one measure per animation frame', () => {
    const frames: FrameRequestCallback[] = [];
    const animationSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        width: 100,
        height: 80,
        right: 100,
        bottom: 80,
        toJSON: () => ({}),
      } as DOMRect);

    const container = mount();
    const nodes = container.querySelectorAll('[data-plan-node-id]').length;
    expect(nodes).toBe(todos.length);

    const framesAfterMount = frames.length;

    // One viewport change lands as several schedule calls in the same
    // frame (the window resize plus, in a real browser, the resize
    // observer's per-node batch). All of them must share a single
    // animation frame, and the frame must run `measure` exactly once.
    act(() => {
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('resize'));
    });
    expect(frames.length - framesAfterMount).toBe(1);

    rectSpy.mockClear();
    act(() => {
      frames.at(-1)!(0);
    });
    // One measure pass reads the graph container's rect plus one rect per
    // node — not one batch per schedule call.
    expect(rectSpy.mock.calls.length).toBe(nodes + 1);

    // The next storm schedules one new frame again.
    act(() => {
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('resize'));
    });
    expect(frames.length - framesAfterMount).toBe(2);

    animationSpy.mockRestore();
    rectSpy.mockRestore();
  });
});
