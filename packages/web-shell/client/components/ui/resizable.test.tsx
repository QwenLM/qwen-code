// @vitest-environment jsdom
import { act, createRef, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Slot } from 'radix-ui';
import { expect, it, vi } from 'vitest';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from './resizable';

it('forwards group, panel and slotted separator refs to DOM elements', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const groupRef = createRef<HTMLDivElement>();
  const panelRef = createRef<HTMLDivElement>();
  const handleRef = createRef<HTMLDivElement>();
  try {
    await act(async () =>
      root.render(
        <StrictMode>
          <ResizablePanelGroup ref={groupRef}>
            <ResizablePanel ref={panelRef}>Preview</ResizablePanel>
            <Slot.Root ref={handleRef}>
              <ResizableHandle aria-label="Resize panes" />
            </Slot.Root>
            <ResizablePanel>Tree</ResizablePanel>
          </ResizablePanelGroup>
        </StrictMode>,
      ),
    );
    expect(groupRef.current).toBe(container.querySelector('[data-group]'));
    expect(panelRef.current).toBe(container.querySelector('[data-panel]'));
    expect(handleRef.current).toBe(
      container.querySelector('[role="separator"]'),
    );
    expect(handleRef.current).toBeInstanceOf(HTMLDivElement);
    act(() => root.unmount());
    expect(groupRef.current).toBeNull();
    expect(panelRef.current).toBeNull();
    expect(handleRef.current).toBeNull();
  } finally {
    if (container.hasChildNodes()) act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
