// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { Tabs, TabsList, TabsTrigger } from './tabs';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

function renderTabs(ui: React.ReactElement): {
  container: HTMLElement;
  root: Root;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  act(() => root.render(ui));
  return { container, root };
}

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
});

const INDICATOR = '[data-slot="tabs-list-indicator"]';
const TRANSITION_CLASS = 'transition-[';

async function flushFrame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

describe('TabsList sliding indicator', () => {
  it('renders the indicator over the active trigger in the default variant', () => {
    const { container } = renderTabs(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">Tasks</TabsTrigger>
          <TabsTrigger value="b">Channels</TabsTrigger>
        </TabsList>
      </Tabs>,
    );

    const indicator = container.querySelector(INDICATOR);
    expect(indicator).not.toBeNull();
    expect((indicator as HTMLElement).style.opacity).toBe('1');
    expect(
      container.querySelector('[data-slot="tabs-trigger"][data-state="active"]')
        ?.textContent,
    ).toBe('Tasks');
  });

  it('hides the indicator when the active trigger disappears', async () => {
    const { container, root } = renderTabs(
      <Tabs value="a">
        <TabsList>
          <TabsTrigger value="a">Tasks</TabsTrigger>
          <TabsTrigger value="b">Channels</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const indicator = container.querySelector(INDICATOR) as HTMLElement;
    expect(indicator.style.opacity).toBe('1');

    await act(async () => {
      root.render(
        <Tabs value="missing">
          <TabsList>
            <TabsTrigger value="a">Tasks</TabsTrigger>
            <TabsTrigger value="b">Channels</TabsTrigger>
          </TabsList>
        </Tabs>,
      );
    });

    expect(indicator.style.opacity).toBe('0');
  });

  it('does not render the indicator in the line variant', () => {
    const { container } = renderTabs(
      <Tabs defaultValue="a">
        <TabsList variant="line">
          <TabsTrigger value="a">Tasks</TabsTrigger>
          <TabsTrigger value="b">Channels</TabsTrigger>
        </TabsList>
      </Tabs>,
    );

    expect(container.querySelector(INDICATOR)).toBeNull();
  });

  it('forwards a ref to the list element while rendering the indicator', () => {
    const ref = React.createRef<HTMLDivElement>();
    const { container } = renderTabs(
      <Tabs defaultValue="a">
        <TabsList ref={ref}>
          <TabsTrigger value="a">Tasks</TabsTrigger>
          <TabsTrigger value="b">Channels</TabsTrigger>
        </TabsList>
      </Tabs>,
    );

    expect(ref.current).toBe(
      container.querySelector('[data-slot="tabs-list"]'),
    );
    expect(container.querySelector(INDICATOR)).not.toBeNull();
  });

  it('animates mutation-driven moves but tracks resizes without a transition', async () => {
    let resizeCallback: (() => void) | undefined;
    const SharedResizeObserver = globalThis.ResizeObserver;
    class CapturingResizeObserver {
      constructor(callback: () => void) {
        resizeCallback = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.assign(globalThis, {
      ResizeObserver: CapturingResizeObserver,
    });

    try {
      const { container, root } = renderTabs(
        <Tabs value="a">
          <TabsList>
            <TabsTrigger value="a">Tasks</TabsTrigger>
            <TabsTrigger value="b">Channels</TabsTrigger>
          </TabsList>
        </Tabs>,
      );
      const indicator = container.querySelector(INDICATOR) as HTMLElement;
      const list = container.querySelector(
        '[data-slot="tabs-list"]',
      ) as HTMLElement;

      // jsdom reports zero boxes; give the list and triggers plausible
      // geometry so the resize-driven measurement has something to read.
      const stubRect = (el: HTMLElement, left: number, width: number) => {
        Object.defineProperty(el, 'getBoundingClientRect', {
          configurable: true,
          value: () => ({
            left,
            top: 0,
            width,
            height: 25,
            right: left + width,
            bottom: 25,
            x: left,
            y: 0,
            toJSON: () => ({}),
          }),
        });
      };
      stubRect(list, 0, 200);
      for (const [i, trigger] of [
        ...list.querySelectorAll<HTMLElement>('[data-slot="tabs-trigger"]'),
      ].entries()) {
        stubRect(trigger, 3 + i * 80, 80);
      }

      // Resize-driven write: arms the hook and snaps — no transition class.
      act(() => resizeCallback!());
      expect(indicator.className).not.toContain(TRANSITION_CLASS);
      await flushFrame();
      expect(indicator.style.left).toBe('3px');
      expect(indicator.className).not.toContain(TRANSITION_CLASS);

      // Mutation-driven write (activation change): the transition arms.
      await act(async () => {
        root.render(
          <Tabs value="b">
            <TabsList>
              <TabsTrigger value="a">Tasks</TabsTrigger>
              <TabsTrigger value="b">Channels</TabsTrigger>
            </TabsList>
          </Tabs>,
        );
      });
      expect(indicator.style.left).toBe('83px');
      expect(indicator.className).toContain(TRANSITION_CLASS);
    } finally {
      Object.assign(globalThis, { ResizeObserver: SharedResizeObserver });
    }
  });
});
