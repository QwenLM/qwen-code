// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DaemonAutofixPrWatch } from '@qwen-code/web-shell/daemon-react-sdk';
import { I18nProvider } from '../../i18n';
import { indexAutofixPrWatches } from '../../utils/autofixPrWatches';
import {
  AutofixPrContext,
  type AutofixPrContextValue,
} from './AutofixPrContext';
import { AutofixPrActionButton } from './AutofixPrActionButton';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

const makeWatch = (
  over: Partial<DaemonAutofixPrWatch> = {},
): DaemonAutofixPrWatch => ({
  pr: 42,
  repo: 'acme/widgets',
  host: 'github.com',
  url: 'https://github.com/acme/widgets/pull/42',
  headRefName: 'fix/ci',
  headSha: 'a'.repeat(40),
  pushes: 1,
  maxPushes: 10,
  session: 'session-watch',
  preparedAt: null,
  lastCheck: null,
  checkedRecently: true,
  lastRound: null,
  stopped: null,
  watch: { every: 2, reply: true, instructions: '', task: 'feedc0ffee12' },
  ended: null,
  needsHuman: [],
  worktreeExists: true,
  fix: null,
  ...over,
});

function makeContext(
  watches: DaemonAutofixPrWatch[] = [],
  overrides: Partial<AutofixPrContextValue> = {},
): AutofixPrContextValue {
  const lists = new Map([['', { available: true, watches }]]);
  return {
    watchIndex: indexAutofixPrWatches(lists, new Map([['', '/repo']])),
    lists,
    error: null,
    loaded: true,
    reload: vi.fn().mockResolvedValue(undefined),
    canStartInWorkspace: vi.fn(() => true),
    startInNewSession: vi.fn().mockResolvedValue(undefined),
    openWatch: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function renderButton(
  ctx: AutofixPrContextValue | null,
  props: Partial<Parameters<typeof AutofixPrActionButton>[0]> = {},
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <I18nProvider language="en">
        <AutofixPrContext.Provider value={ctx}>
          <AutofixPrActionButton
            prNumber={42}
            prUrl="https://github.com/acme/widgets/pull/42"
            prState="open"
            workspaceCwd="/repo"
            {...props}
          />
        </AutofixPrContext.Provider>
      </I18nProvider>,
    );
  });
  return container.querySelector<HTMLButtonElement>(
    '[data-testid="autofix-pr-action"]',
  );
}

describe('AutofixPrActionButton', () => {
  it('renders nothing without context, on closed/merged PRs, or in an unavailable workspace', () => {
    expect(renderButton(null)).toBeNull();
    act(() => root?.unmount());
    expect(renderButton(makeContext(), { prState: 'merged' })).toBeNull();
    act(() => root?.unmount());
    expect(renderButton(makeContext(), { prState: 'closed' })).toBeNull();
    act(() => root?.unmount());
    expect(
      renderButton(makeContext([], { canStartInWorkspace: () => false })),
    ).toBeNull();
  });

  it('starts /autofix-pr in a new session for an unwatched open PR', async () => {
    const ctx = makeContext();
    const onTriggered = vi.fn();
    const btn = renderButton(ctx, { onTriggered });
    expect(btn?.textContent).toBe('Autofix');
    expect(btn?.dataset.autofixPrState).toBe('start');

    await act(async () => {
      btn!.click();
      await Promise.resolve();
    });
    expect(onTriggered).toHaveBeenCalledOnce();
    expect(ctx.startInNewSession).toHaveBeenCalledWith({
      prompt: '/autofix-pr https://github.com/acme/widgets/pull/42',
      workspaceCwd: '/repo',
      sessionTitle: 'Autofix PR #42',
    });
  });

  it('shows active watch states and jumps to the watch when clicked', async () => {
    const fixing = makeWatch({
      fix: { attempt: '0123456789ab', startedAt: null, fresh: true },
    });
    const ctx = makeContext([fixing]);
    const btn = renderButton(ctx);
    expect(btn?.textContent).toBe('Fixing');
    expect(btn?.dataset.autofixPrState).toBe('fixing');

    await act(async () => {
      btn!.click();
      await Promise.resolve();
    });
    expect(ctx.openWatch).toHaveBeenCalledWith(
      expect.objectContaining({ watch: fixing, phase: 'fixing' }),
    );
    expect(ctx.startInNewSession).not.toHaveBeenCalled();
  });

  it('prioritizes needsHuman count over watching/fixing', () => {
    const ctx = makeContext([
      makeWatch({
        needsHuman: [
          { sha: 'a'.repeat(40), at: '2026-11-28T00:00:00Z', text: 'Decision' },
          { sha: 'a'.repeat(40), at: '2026-11-28T00:01:00Z', text: 'Other' },
        ],
      }),
    ]);
    const btn = renderButton(ctx);
    expect(btn?.textContent).toBe('Needs you (2)');
    expect(btn?.dataset.autofixPrState).toBe('needsHuman');
  });

  it('offers Resume for an idle watch and sends /autofix-pr resume', async () => {
    const ctx = makeContext([makeWatch({ checkedRecently: false })]);
    const btn = renderButton(ctx);
    expect(btn?.textContent).toBe('Resume');
    expect(btn?.dataset.autofixPrState).toBe('idle');

    await act(async () => {
      btn!.click();
      await Promise.resolve();
    });
    expect(ctx.startInNewSession).toHaveBeenCalledWith({
      prompt: '/autofix-pr resume 42',
      workspaceCwd: '/repo',
      sessionTitle: 'Autofix PR #42',
    });
  });

  it('offers Autofix restart for an ended watch on an open PR, preserving --in-place --watch when inPlace is true', async () => {
    const ctx = makeContext([
      makeWatch({ ended: { at: '2026-11-28T00:00:00Z', reason: 'stopped' } }),
    ]);
    const btn = renderButton(ctx);
    expect(btn?.textContent).toBe('Autofix');
    await act(async () => {
      btn!.click();
      await Promise.resolve();
    });
    expect(ctx.startInNewSession).toHaveBeenCalledWith({
      prompt: '/autofix-pr https://github.com/acme/widgets/pull/42',
      workspaceCwd: '/repo',
      sessionTitle: 'Autofix PR #42',
    });

    act(() => root?.unmount());
    const inPlaceCtx = makeContext([
      makeWatch({
        watch: null,
        inPlace: true,
        checkedRecently: false,
      }),
    ]);
    const inPlaceBtn = renderButton(inPlaceCtx);
    expect(inPlaceBtn?.textContent).toBe('Autofix');
    await act(async () => {
      inPlaceBtn!.click();
      await Promise.resolve();
    });
    expect(inPlaceCtx.startInNewSession).toHaveBeenCalledWith({
      prompt:
        '/autofix-pr https://github.com/acme/widgets/pull/42 --in-place --watch',
      workspaceCwd: '/repo',
      sessionTitle: 'Autofix PR #42',
    });
  });

  it('prefers the watch clone workspaceCwd over the surface workspaceCwd when resuming across workspaces', async () => {
    const lists = new Map([
      ['', { available: true, watches: [] }],
      [
        'second',
        {
          available: true,
          watches: [makeWatch({ checkedRecently: false })],
        },
      ],
    ]);
    const ctx: AutofixPrContextValue = {
      watchIndex: indexAutofixPrWatches(
        lists,
        new Map([
          ['', '/w/a'],
          ['second', '/w/b'],
        ]),
      ),
      lists,
      error: null,
      loaded: true,
      reload: vi.fn().mockResolvedValue(undefined),
      canStartInWorkspace: vi.fn((cwd) => cwd === '/w/b'),
      startInNewSession: vi.fn().mockResolvedValue(undefined),
      openWatch: vi.fn().mockResolvedValue(undefined),
    };
    const btn = renderButton(ctx, { workspaceCwd: '/w/a' });
    expect(btn?.textContent).toBe('Resume');
    await act(async () => {
      btn!.click();
      await Promise.resolve();
    });
    expect(ctx.startInNewSession).toHaveBeenCalledWith({
      prompt: '/autofix-pr resume 42',
      workspaceCwd: '/w/b',
      sessionTitle: 'Autofix PR #42',
    });
  });

  it('suppresses start buttons when watch state is merged/closed, still loading, errored, or URL is malformed, and canonicalizes sub-page URLs', async () => {
    // Terminal watch state suppresses button even when session PR state is stale 'open'.
    expect(
      renderButton(
        makeContext([makeWatch({ stopped: 'merged', checkedRecently: false })]),
        { prState: 'open' },
      ),
    ).toBeNull();
    act(() => root?.unmount());
    // Cold-start !loaded suppresses unwatched Autofix start button.
    expect(renderButton(makeContext([], { loaded: false }))).toBeNull();
    act(() => root?.unmount());
    // Failed watch listing suppresses unwatched Autofix start button.
    expect(
      renderButton(makeContext([], { error: 'daemon offline' })),
    ).toBeNull();
    act(() => root?.unmount());
    // Hostile or malformed PR URL never renders an actionable trigger.
    expect(
      renderButton(makeContext(), {
        prUrl: 'https://github.com/o%20--yes/r/pull/42',
      }),
    ).toBeNull();
    act(() => root?.unmount());
    // Sub-page PR URL is canonicalized before emitting /autofix-pr command.
    const subCtx = makeContext();
    const subBtn = renderButton(subCtx, {
      prUrl: 'https://github.com/acme/widgets/pull/42/files?w=1',
    });
    expect(subBtn?.textContent).toBe('Autofix');
    await act(async () => {
      subBtn!.click();
      await Promise.resolve();
    });
    expect(subCtx.startInNewSession).toHaveBeenCalledWith({
      prompt: '/autofix-pr https://github.com/acme/widgets/pull/42',
      workspaceCwd: '/repo',
      sessionTitle: 'Autofix PR #42',
    });
  });
});
