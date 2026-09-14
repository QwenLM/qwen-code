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

    const indicator = container.querySelector(
      '[data-slot="tabs-list-indicator"]',
    );
    expect(indicator).not.toBeNull();
    expect((indicator as HTMLElement).style.opacity).toBe('1');
    expect(
      container.querySelector('[data-slot="tabs-trigger"][data-state="active"]')
        ?.textContent,
    ).toBe('Tasks');
  });

  it('hides the indicator when no trigger is active', () => {
    const { container } = renderTabs(
      <Tabs value="missing">
        <TabsList>
          <TabsTrigger value="a">Tasks</TabsTrigger>
          <TabsTrigger value="b">Channels</TabsTrigger>
        </TabsList>
      </Tabs>,
    );

    const indicator = container.querySelector(
      '[data-slot="tabs-list-indicator"]',
    );
    expect(indicator).not.toBeNull();
    expect((indicator as HTMLElement).style.opacity).toBe('0');
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

    expect(
      container.querySelector('[data-slot="tabs-list-indicator"]'),
    ).toBeNull();
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
    expect(
      container.querySelector('[data-slot="tabs-list-indicator"]'),
    ).not.toBeNull();
  });
});
