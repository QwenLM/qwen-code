// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DaemonRewindSnapshotInfo,
  DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';
import { RewindDialog } from './RewindDialog';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const blocks = [
  { kind: 'user', text: 'first turn' },
  { kind: 'user', text: 'second turn' },
] as unknown as DaemonTranscriptBlock[];

const snapshots: DaemonRewindSnapshotInfo[] = [
  { promptId: 'p0', turnIndex: 0, timestamp: '2026-01-01T00:00:00.000Z' },
  { promptId: 'p1', turnIndex: 1, timestamp: '2026-01-01T00:01:00.000Z' },
] as unknown as DaemonRewindSnapshotInfo[];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(rewind: (id: string) => Promise<void>) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider language="en">
        <RewindDialog
          blocks={blocks}
          loadSnapshots={() => Promise.resolve({ snapshots })}
          rewind={rewind}
          onError={vi.fn()}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );
  });
  // Flush the async loadSnapshots() effect.
  await act(async () => {});
}

function press(key: string) {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key, cancelable: true }),
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('RewindDialog keyboard', () => {
  function rewindButton(): HTMLButtonElement {
    return Array.from(container!.querySelectorAll('button')).find((el) =>
      /rewind/i.test(el.textContent || ''),
    ) as HTMLButtonElement;
  }

  it('does not confirm a target until Enter — the button stays disabled', async () => {
    const rewind = vi.fn().mockResolvedValue(undefined);
    await mount(rewind);

    // Moving the cursor with arrows must not confirm anything yet.
    press('ArrowDown');
    press('ArrowUp');
    expect(rewind).not.toHaveBeenCalled();
    expect(rewindButton().disabled).toBe(true);

    // Enter commits the cursor row; it still does not run the rewind itself.
    press('Enter');
    expect(rewind).not.toHaveBeenCalled();
    expect(rewindButton().disabled).toBe(false);
  });

  it('the button rewinds the snapshot confirmed via keyboard', async () => {
    const rewind = vi.fn().mockResolvedValue(undefined);
    await mount(rewind);

    // Move cursor to the 2nd snapshot and confirm it with Enter.
    press('ArrowDown');
    press('Enter');
    act(() => {
      rewindButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(rewind).toHaveBeenCalledWith('p1');
  });
});
