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
  it('confirms the rewind for the highlighted snapshot on Enter', async () => {
    const rewind = vi.fn().mockResolvedValue(undefined);
    await mount(rewind);

    // Opens with the first snapshot highlighted; Enter rewinds it.
    press('Enter');
    expect(rewind).toHaveBeenCalledWith('p0');
  });

  it('Enter rewinds the snapshot the arrow keys moved to', async () => {
    const rewind = vi.fn().mockResolvedValue(undefined);
    await mount(rewind);

    press('ArrowDown');
    press('Enter');
    expect(rewind).toHaveBeenCalledWith('p1');
  });
});
