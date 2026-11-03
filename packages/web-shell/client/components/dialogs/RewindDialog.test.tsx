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
  { id: 'user-A', kind: 'user', text: 'first turn', promptId: 'daemon-A' },
  { id: 'user-B', kind: 'user', text: 'second turn', promptId: 'daemon-B' },
] as unknown as DaemonTranscriptBlock[];

const snapshots: DaemonRewindSnapshotInfo[] = [
  {
    promptId: 'p0',
    daemonPromptId: 'daemon-A',
    turnIndex: 0,
    timestamp: '2026-01-01T00:00:00.000Z',
  },
  {
    promptId: 'p1',
    daemonPromptId: 'daemon-B',
    turnIndex: 1,
    timestamp: '2026-01-01T00:01:00.000Z',
  },
] as unknown as DaemonRewindSnapshotInfo[];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(
  rewind: (id: string) => Promise<void>,
  entries = snapshots,
  transcriptBlocks = blocks,
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider language="en">
        <RewindDialog
          blocks={transcriptBlocks}
          loadSnapshots={() => Promise.resolve({ snapshots: entries })}
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
    expect(container!.textContent).toContain('#2 second turn');

    // Move cursor to the 2nd snapshot and confirm it with Enter.
    press('ArrowDown');
    press('Enter');
    act(() => {
      rewindButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(rewind).toHaveBeenCalledWith('p1');
  });

  it('does not relabel a retained checkpoint as an earlier visible turn', async () => {
    const rewind = vi.fn().mockResolvedValue(undefined);
    await mount(rewind, [snapshots[1]!]);
    expect(container!.textContent).toContain('#2 second turn');
    expect(container!.textContent).not.toContain('first turn');
    press('Enter');
    await act(async () => {
      rewindButton().click();
    });
    expect(rewind).toHaveBeenCalledWith('p1');
  });

  it('keeps session turn numbers after earlier transcript blocks are evicted', async () => {
    const rewind = vi.fn().mockResolvedValue(undefined);
    await mount(rewind, [{ ...snapshots[1]!, turnIndex: 40 }], [blocks[1]!]);
    expect(container!.querySelector('[role="option"]')?.textContent).toContain(
      '#41 second turn',
    );
    press('Enter');
    await act(async () => {
      rewindButton().click();
    });
    expect(rewind).toHaveBeenCalledWith('p1');
  });

  it('numbers the checkpoint the way the chat numbers it past an injected row', async () => {
    // The injected row shares the daemon prompt identity; the preview must
    // still come from the ordinary user block.
    const withInjected = [
      blocks[0]!,
      {
        id: 'injected',
        kind: 'user',
        text: 'injected mid turn',
        promptId: 'daemon-B',
        meta: { source: 'mid_turn_message_injected' },
      },
      blocks[1]!,
    ] as unknown as DaemonTranscriptBlock[];
    const rewind = vi.fn().mockResolvedValue(undefined);
    await mount(rewind, [snapshots[1]!], withInjected);
    expect(container!.textContent).toContain('#2 second turn');
    expect(container!.textContent).not.toContain('#3');
  });

  it.each(['missing', 'duplicate'])(
    'refuses a %s association instead of guessing an ordinal',
    async (kind) => {
      const entry = {
        ...snapshots[0]!,
        daemonPromptId: kind === 'missing' ? undefined : 'daemon-A',
      };
      const rewind = vi.fn().mockResolvedValue(undefined);
      await mount(
        rewind,
        kind === 'duplicate'
          ? [entry, { ...entry, promptId: 'duplicate' }]
          : [entry],
      );
      press('Enter');
      expect(rewindButton().disabled).toBe(true);
      expect(rewind).not.toHaveBeenCalled();
      if (kind === 'missing') {
        expect(container!.textContent).toContain('no prompt identity');
      }
    },
  );

  it('keeps a turn outside the loaded window rewindable by its identity', async () => {
    // The loaded transcript is a window, not the session: a truncated replay
    // leaves snapshots whose blocks were never paged in. The rewind itself
    // carries only the prompt identity, so those rows stay targetable and keep
    // their snapshot number even without preview text.
    const entry = { ...snapshots[0]!, daemonPromptId: 'not-paged-in' };
    const rewind = vi.fn().mockResolvedValue(undefined);
    await mount(rewind, [entry]);
    // The snapshot still supplies its number; only the preview falls back to
    // the identity-derived label.
    expect(container!.textContent).toContain('Prompt');
    expect(container!.textContent).toContain('#1');
    press('Enter');
    expect(rewindButton().disabled).toBe(false);
    await act(async () => {
      rewindButton().click();
    });
    expect(rewind).toHaveBeenCalledWith(entry.promptId);
  });

  it('disables keyboard navigation while a rewind is in flight', async () => {
    // A rewind that never settles keeps isRewinding true.
    const rewind = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    await mount(rewind);

    const activeDescendant = () =>
      container!
        .querySelector('[role="listbox"]')!
        .getAttribute('aria-activedescendant');

    press('ArrowDown');
    press('Enter');
    expect(activeDescendant()).toBe('rewind-snapshot-list-opt-1');
    act(() => {
      rewindButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(rewind).toHaveBeenCalledWith('p1');

    // While rewinding, arrows must not move the highlight (enabled: false).
    press('ArrowUp');
    expect(activeDescendant()).toBe('rewind-snapshot-list-opt-1');
  });

  it('shows an inline error and re-enables the button when rewind fails', async () => {
    const rewind = vi.fn().mockRejectedValue(new Error('boom'));
    await mount(rewind);

    press('ArrowDown');
    press('Enter');
    await act(async () => {
      rewindButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // The failure is visible in-dialog (toasts may be deduplicated upstream)
    // and the user can retry.
    expect(container!.textContent).toContain('boom');
    expect(rewindButton().disabled).toBe(false);
  });

  it('pulls focus into the listbox once snapshots arrive, if parked on the panel', async () => {
    // Simulate DialogShell's fallback: nothing focusable during loading, so
    // focus sits on the dialog panel.
    const panel = document.createElement('div');
    panel.setAttribute('role', 'dialog');
    panel.tabIndex = -1;
    document.body.appendChild(panel);
    panel.focus();
    expect(document.activeElement).toBe(panel);

    await mount(vi.fn().mockResolvedValue(undefined));

    const listbox = container!.querySelector<HTMLElement>('[role="listbox"]');
    expect(document.activeElement).toBe(listbox);
    panel.remove();
  });
});
