// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { WebShellPortalRootContext } from '../portalRoot';
import type { ContextUsageControls } from '../hooks/useContextUsageControls';
import { ContextUsagePopover } from './ContextUsagePopover';
import { Button } from './ui/button';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren();
  vi.useRealTimers();
});
const advance = (ms: number) =>
  act(async () => vi.advanceTimersByTimeAsync(ms));

async function mount(shadowPortal = false) {
  vi.useFakeTimers();
  const host = document.createElement('div');
  const portal = document.createElement('div');
  const draft = document.createElement('input');
  const portalHost = document.createElement('div');
  const portalRoot = shadowPortal
    ? portalHost.attachShadow({ mode: 'open' })
    : portalHost;
  portalRoot.append(portal);
  document.body.append(host, portalHost, draft);
  draft.value = 'Keep this draft';
  draft.focus();
  const triggerRef = createRef<HTMLButtonElement>();
  const snapshot = vi.fn();
  const details = vi.fn();
  const compress = vi.fn().mockResolvedValue(undefined);
  let controls: Pick<
    ContextUsageControls,
    'canCompress' | 'compressing' | 'result' | 'compress'
  > = {
    canCompress: true,
    compressing: false,
    compress,
  };
  let sessionId = 'a';
  const root = createRoot(host);
  roots.push(root);
  const render = () =>
    act(async () =>
      root.render(
        <I18nProvider language="en">
          <WebShellPortalRootContext.Provider value={portal}>
            <ContextUsagePopover
              key={sessionId}
              tokenCount={60_000}
              contextWindow={100_000}
              controls={controls}
              onOpenDetails={details}
              showSnapshotHint
            >
              <Button ref={triggerRef} onClick={snapshot}>
                Context ring
              </Button>
            </ContextUsagePopover>
          </WebShellPortalRootContext.Provider>
        </I18nProvider>,
      ),
    );
  await render();
  return {
    host,
    portal,
    portalRoot,
    draft,
    snapshot,
    details,
    compress,
    triggerRef,
    get trigger() {
      return triggerRef.current!;
    },
    get card() {
      return portal.querySelector<HTMLElement>(
        '[data-web-shell-context-popover]',
      );
    },
    async update(next: Partial<typeof controls>) {
      controls = { ...controls, ...next };
      await render();
    },
    async switchSession() {
      sessionId = 'b';
      await render();
    },
  };
}
function pointer(
  node: Element,
  type: string,
  relatedTarget: Element | null = null,
) {
  act(() =>
    node.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget })),
  );
}
function key(node: Element, value: string) {
  act(() =>
    node.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: value,
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    ),
  );
}

describe('ContextUsagePopover', () => {
  it('keeps an interactive hover open across the gap without stealing draft focus or issuing actions', async () => {
    const h = await mount();
    expect(h.triggerRef.current).toBe(h.host.querySelector('button'));
    pointer(h.trigger, 'pointerover');
    await advance(299);
    expect(h.card).toBeNull();
    await advance(1);
    expect(h.card?.getAttribute('role')).toBe('dialog');
    expect(h.card?.textContent).toContain('Remaining40,000 tokens');
    expect(document.activeElement).toBe(h.draft);
    pointer(h.trigger, 'pointerout', document.body);
    await advance(100);
    pointer(h.card!, 'pointerover', document.body);
    await advance(200);
    expect(h.card).not.toBeNull();
    expect(h.snapshot).not.toHaveBeenCalled();
    expect(h.details).not.toHaveBeenCalled();
    expect(h.compress).not.toHaveBeenCalled();
    const button = Array.from(h.card!.querySelectorAll('button')).find(
      (b) => b.textContent === 'Compress context',
    )!;
    await act(async () => button.click());
    expect(h.compress).toHaveBeenCalledOnce();
    expect(h.snapshot).not.toHaveBeenCalled();
    expect(h.draft.value).toBe('Keep this draft');
  });

  it('preserves editor focus when Escape dismisses a pointer-only hover', async () => {
    const h = await mount();
    pointer(h.trigger, 'pointerover');
    await advance(300);
    expect(h.card).not.toBeNull();
    key(h.draft, 'Escape');
    await advance(1);
    expect(h.card).toBeNull();
    expect(document.activeElement).toBe(h.draft);
  });

  it('keeps the hover open when focus moves to its ring, then enters actions', async () => {
    const h = await mount();
    pointer(h.trigger, 'pointerover');
    await advance(300);
    await act(async () => h.trigger.focus());
    expect(h.card).not.toBeNull();
    key(h.trigger, 'ArrowDown');
    expect(document.activeElement?.textContent).toBe('Compress context');
  });

  it('keeps Shift+Tab inside the card from reaching host mode shortcuts', async () => {
    const h = await mount();
    await act(async () => h.trigger.focus());
    const details = h.card!.querySelectorAll('button')[1];
    await act(async () => details.focus());
    const hostShortcut = vi.fn();
    window.addEventListener('keydown', hostShortcut);
    try {
      act(() =>
        details.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Tab',
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      expect(hostShortcut).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', hostShortcut);
    }
  });

  it.each(['ArrowDown', 'Tab'])(
    'enters actions with %s and restores focus on Escape without reopening',
    async (entry) => {
      const h = await mount();
      await act(async () => h.trigger.focus());
      expect(h.card).not.toBeNull();
      expect(h.trigger.getAttribute('aria-controls')).toBe(h.card!.id);
      expect(document.activeElement).toBe(h.trigger);
      key(h.trigger, entry);
      expect(document.activeElement?.textContent).toBe('Compress context');
      pointer(h.card!, 'pointerout', document.body);
      await advance(200);
      expect(h.card).not.toBeNull();
      key(document.activeElement!, 'Escape');
      await advance(1);
      expect(h.card).toBeNull();
      expect(document.activeElement).toBe(h.trigger);
      await advance(350);
      expect(h.card).toBeNull();
    },
  );

  it('preserves focus moved to the editor before Escape restoration runs', async () => {
    const h = await mount();
    await act(async () => h.trigger.focus());
    key(h.trigger, 'ArrowDown');
    key(document.activeElement!, 'Escape');
    act(() => h.draft.focus());
    await advance(1);
    expect(h.card).toBeNull();
    expect(document.activeElement).toBe(h.draft);
  });

  it.each(['Escape', 'pointer leave'])(
    'preserves keyboard focus with a shadow portal on %s',
    async (event) => {
      const h = await mount(true);
      await act(async () => h.trigger.focus());
      key(h.trigger, 'ArrowDown');
      const firstAction = h.card!.querySelector('button')!;
      expect((h.portalRoot as ShadowRoot).activeElement).toBe(firstAction);
      if (event === 'Escape') key(firstAction, 'Escape');
      else pointer(h.card!, 'pointerout', document.body);
      await advance(200);
      if (event === 'Escape') {
        expect(h.card).toBeNull();
        expect(document.activeElement).toBe(h.trigger);
      } else {
        expect(h.card).not.toBeNull();
        expect((h.portalRoot as ShadowRoot).activeElement).toBe(firstAction);
      }
    },
  );

  it('opens details independently of the ring snapshot action', async () => {
    const h = await mount();
    await act(async () => h.trigger.focus());
    const button = Array.from(h.card!.querySelectorAll('button')).find(
      (b) => b.textContent === 'View details',
    )!;
    await act(async () => button.click());
    expect(h.details).toHaveBeenCalledOnce();
    expect(h.snapshot).not.toHaveBeenCalled();
    expect(h.card).toBeNull();
    await act(async () => h.trigger.click());
    expect(h.snapshot).toHaveBeenCalledOnce();
    expect(h.details).toHaveBeenCalledOnce();
  });

  it('uses the supplied pending and eligibility state, then shows the shared result', async () => {
    const h = await mount();
    await act(async () => h.trigger.focus());
    await h.update({ canCompress: false, compressing: true });
    const compress = h.card!.querySelector<HTMLButtonElement>('button')!;
    expect(compress.disabled).toBe(true);
    expect(h.card!.querySelector('[role="status"]')?.textContent).toBe(
      'Compressing…',
    );
    await act(async () => compress.click());
    expect(h.compress).not.toHaveBeenCalled();
    await h.update({ compressing: false, result: { kind: 'interrupted' } });
    expect(compress.disabled).toBe(true);
    expect(h.card!.querySelector('[role="status"]')?.textContent).toBe(
      'Connection changed during compression. Refresh to check current usage.',
    );
    await h.update({ canCompress: true, result: { kind: 'failed' } });
    expect(compress.disabled).toBe(false);
    expect(h.card!.querySelector('[role="alert"]')?.textContent).toBe(
      'Compression failed. You can try again.',
    );
  });

  it('dismisses on focus leaving and discards a delayed hover when the session changes', async () => {
    const h = await mount();
    await act(async () => h.trigger.focus());
    await act(async () => h.draft.focus());
    await advance(151);
    expect(h.card).toBeNull();
    pointer(h.trigger, 'pointerover');
    await h.switchSession();
    await advance(350);
    expect(h.card).toBeNull();
  });
});
