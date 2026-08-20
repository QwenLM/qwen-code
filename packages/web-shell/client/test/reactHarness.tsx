import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

export function mountReact(node: ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  mounted.push({ root, container });
  return container;
}

export function cleanupReact(): void {
  for (const { root, container } of mounted.splice(0)) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
}

export async function flushReact(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

export function immediateClipboardWrite(): Promise<void> {
  return {
    then(onFulfilled?: (value: void) => unknown) {
      onFulfilled?.(undefined);
      return Promise.resolve();
    },
  } as Promise<void>;
}
