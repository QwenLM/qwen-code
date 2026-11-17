/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setTimeout as settle } from 'node:timers/promises';
import { renderWithProviders } from '../../test-utils/render.js';
import {
  isSlowTestHost,
  slowHostBudgetMs,
} from '../../test-utils/slow-test-host.js';
import type { SubscriptionState } from './use-subscription.js';
import { SubscriptionDialog } from './SubscriptionDialog.js';

// The macOS nightly legs run on contended 3-core hosts where the ink
// keypress-to-render chain can exceed vi.waitFor's 1s default budget (the
// canCheckAgain=true keyboard case failed three of four nights). 5s still
// timed out under the extreme contention of dispatch 43574338804 (cli 2/3,
// 734s of test time across workers), so raise to 15s on a slow host via the
// repo's slowHostBudgetMs helper (idle hosts keep the fast budget).
const WAIT_FOR_TIMEOUT = slowHostBudgetMs(5_000, 15_000);
// The keyboard case's Enter-to-activation wait gets a larger slow-host
// budget: a starved keypress is delivered late, not discarded, so the wait
// absorbs the latency with a single press instead of re-sending (a re-send
// loop would mask a swallowed first press and could double-fire; R3-2).
// The case ceiling is owned by packages/cli/vitest.config.ts (60s on the
// macOS runner), which keeps the chained waits under it without a runtime
// vi.setConfig that would outrank the autofix gate's --testTimeout (R4-1).
const ENTER_WAIT_TIMEOUT = slowHostBudgetMs(5_000, 40_000);
// The chained selection + Enter waits can reach ~55s on a saturated host,
// so the case ceiling must sit above them on ANY slow host, not only the
// macOS runner the config keys on. The fast arm stays undefined to inherit
// the lane grant (never outrank the autofix gate's --testTimeout; R4-1).
const CEILING_MS = isSlowTestHost() ? 60_000 : undefined;

const flow = vi.hoisted(() => ({
  state: { status: 'waiting' } as SubscriptionState,
  email: 'tester@example.com',
  deviceAuth: {
    device_code: 'test-device',
    user_code: 'BCDF-GHJK',
    verification_uri: 'https://chat.qwen.ai/authorize',
    verification_uri_complete:
      'https://chat.qwen.ai/authorize?user_code=BCDF-GHJK&client=cli&entry=qwen_code&paywallScene=cli',
    expires_in: 600,
    interval: 5,
    expiresAt: Date.now() + 600_000,
  },
  checking: false,
  connecting: false,
  connectionError: undefined as string | undefined,
  modelSelectionRequired: false,
  connect: vi.fn(),
  canCheckAgain: false,
  openPlans: vi.fn(),
  checkAgain: vi.fn(),
  switchAccount: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock('./use-subscription.js', () => ({ useSubscription: () => flow }));
beforeEach(() => {
  vi.clearAllMocks();
  flow.state = { status: 'waiting' };
  flow.checking = false;
  flow.connectionError = undefined;
  flow.modelSelectionRequired = false;
  flow.connecting = false;
  flow.canCheckAgain = false;
});
afterEach(() => vi.restoreAllMocks());

describe('SubscriptionDialog', { timeout: CEILING_MS }, () => {
  it('shows the real authorization link and cancels without signing out', async () => {
    const onBack = vi.fn();
    const ui = renderWithProviders(
      <SubscriptionDialog onBack={onBack} onSwitchProvider={vi.fn()} />,
    );
    try {
      expect(ui.lastFrame()).toContain('client=cli');
      expect(ui.lastFrame()).not.toContain('LOCAL-MOCK');
      await settle(100);
      ui.stdin.write('\u001b');
      await vi.waitFor(() => expect(onBack).toHaveBeenCalledTimes(1), {
        timeout: WAIT_FOR_TIMEOUT,
      });
      expect(flow.cancel).toHaveBeenCalledTimes(1);
    } finally {
      ui.unmount();
    }
  });

  it('opens plans and switches provider during purchase polling without signing out', async () => {
    flow.state = { status: 'purchase-required', plan: 'Free' };
    const onBack = vi.fn();
    const onSwitchProvider = vi.fn();
    const ui = renderWithProviders(
      <SubscriptionDialog
        onBack={onBack}
        onSwitchProvider={onSwitchProvider}
      />,
    );
    try {
      expect(ui.lastFrame()).toContain('tester@example.com');
      expect(ui.lastFrame()).not.toContain('Retry Connection');
      expect(ui.lastFrame()).not.toContain('Sign out');
      await settle(100);
      ui.stdin.write('\u001b[13u');
      await vi.waitFor(() => expect(flow.openPlans).toHaveBeenCalledOnce(), {
        timeout: WAIT_FOR_TIMEOUT,
      });
      ui.stdin.write('\u001b[B');
      await vi.waitFor(
        () => expect(ui.lastFrame()).toContain('› Switch Provider'),
        { timeout: WAIT_FOR_TIMEOUT },
      );
      await settle(100);
      ui.stdin.write('\u001b[13u');
      await vi.waitFor(() => expect(onSwitchProvider).toHaveBeenCalledOnce(), {
        timeout: WAIT_FOR_TIMEOUT,
      });
      expect(flow.cancel).toHaveBeenCalledOnce();
      expect(onBack).not.toHaveBeenCalled();
    } finally {
      ui.unmount();
    }
  });

  it('shows Retry Connection after purchase timeout and disables it while checking', () => {
    flow.state = {
      status: 'purchase-required',
      plan: 'Free',
      message: 'test timeout',
    };
    flow.canCheckAgain = true;
    flow.checking = true;
    const ui = renderWithProviders(
      <SubscriptionDialog onBack={vi.fn()} onSwitchProvider={vi.fn()} />,
    );
    try {
      expect(ui.lastFrame()).toContain('Retry Connection');
      expect(ui.lastFrame()).toContain('Checking your subscription…');
      expect(ui.lastFrame()).not.toContain('View Plans');
      expect(ui.lastFrame()).not.toContain('Switch Provider');
      expect(ui.lastFrame()).not.toContain('Sign out');
    } finally {
      ui.unmount();
    }
  });

  it.each([false, true])(
    'switches account with the keyboard (canCheckAgain=%s)',
    async (canCheckAgain) => {
      flow.state = { status: 'purchase-required', plan: 'Free' };
      flow.canCheckAgain = canCheckAgain;
      const onBack = vi.fn();
      const onSwitchProvider = vi.fn();
      const ui = renderWithProviders(
        <SubscriptionDialog
          onBack={onBack}
          onSwitchProvider={onSwitchProvider}
        />,
      );
      try {
        expect(ui.lastFrame()).toContain('Use another account');
        await settle(100);
        for (let index = 0; index < (canCheckAgain ? 1 : 2); index++) {
          ui.stdin.write('\u001b[B');
          await settle(50);
        }
        await vi.waitFor(
          () => expect(ui.lastFrame()).toContain('› Use another account'),
          { timeout: WAIT_FOR_TIMEOUT },
        );
        // Let the input handler's closure pick up the new selection, then land
        // a single Enter. A starved keypress is delivered late, not discarded,
        // so the wait's budget absorbs the latency; re-sending would mask a
        // swallowed first press (the "one press activates the selection"
        // property this case exists to pin) and could double-fire when two
        // presses are in flight (R3-2).
        await settle(150);
        ui.stdin.write('\u001b[13u');
        await vi.waitFor(
          () => expect(flow.switchAccount).toHaveBeenCalledOnce(),
          { timeout: ENTER_WAIT_TIMEOUT },
        );
        expect(onBack).not.toHaveBeenCalled();
        expect(flow.cancel).not.toHaveBeenCalled();
        // A mis-routed press must not pass silently: pin that no OTHER menu
        // item was activated (a regression that lands Enter on the stale
        // selection would fire one of these instead of switchAccount).
        expect(flow.openPlans).not.toHaveBeenCalled();
        expect(flow.checkAgain).not.toHaveBeenCalled();
        expect(onSwitchProvider).not.toHaveBeenCalled();
      } finally {
        ui.unmount();
      }
    },
  );

  it('waits for automatic activation without a Connect or Sign out menu', () => {
    flow.state = { status: 'ready', plan: 'Plus' };
    const ui = renderWithProviders(
      <SubscriptionDialog onBack={vi.fn()} onSwitchProvider={vi.fn()} />,
    );
    try {
      expect(ui.lastFrame()).toContain('Loading models from provider…');
      expect(ui.lastFrame()).not.toContain('› Connect');
      expect(ui.lastFrame()).not.toContain('Sign out');
    } finally {
      ui.unmount();
    }
  });

  it('only points to /model and returns to the input without signing out', async () => {
    flow.state = { status: 'ready', plan: 'Pro' };
    flow.connectionError =
      'The selected model, removed, is no longer available. Run /model to choose another model.';
    flow.modelSelectionRequired = true;
    const onBack = vi.fn();
    const onModelSelectionRequired = vi.fn();
    const ui = renderWithProviders(
      <SubscriptionDialog
        onBack={onBack}
        onModelSelectionRequired={onModelSelectionRequired}
        onSwitchProvider={vi.fn()}
      />,
    );
    try {
      expect(ui.lastFrame()).toContain('Run /model');
      expect(ui.lastFrame()).not.toContain('Retry');
      await settle(100);
      ui.stdin.write('\u001b');
      await vi.waitFor(
        () => expect(onModelSelectionRequired).toHaveBeenCalledOnce(),
        { timeout: WAIT_FOR_TIMEOUT },
      );
      expect(onBack).not.toHaveBeenCalled();
      expect(flow.connect).not.toHaveBeenCalled();
    } finally {
      ui.unmount();
    }
  });

  it('retries inactive membership without opening plans or leaving the dialog', async () => {
    flow.state = { status: 'purchase-required', plan: 'Free' };
    flow.canCheckAgain = true;
    const onBack = vi.fn();
    const ui = renderWithProviders(
      <SubscriptionDialog onBack={onBack} onSwitchProvider={vi.fn()} />,
    );
    try {
      await settle(100);
      expect(ui.lastFrame()).toContain('Retry Connection');
      expect(ui.lastFrame()).not.toContain('View Plans');
      expect(ui.lastFrame()).not.toContain('Switch Provider');
      ui.stdin.write('\u001b[13u');
      await vi.waitFor(() => expect(flow.checkAgain).toHaveBeenCalledOnce(), {
        timeout: WAIT_FOR_TIMEOUT,
      });
      expect(flow.openPlans).not.toHaveBeenCalled();
      expect(onBack).not.toHaveBeenCalled();
    } finally {
      ui.unmount();
    }
  });

  it('keeps a first membership query error visible and retries only the query', async () => {
    flow.state = {
      status: 'query-error',
      message: "Couldn't check your subscription status. Please try again.",
    };
    const onBack = vi.fn();
    const ui = renderWithProviders(
      <SubscriptionDialog onBack={onBack} onSwitchProvider={vi.fn()} />,
    );
    try {
      expect(ui.lastFrame()).toContain('Retry Connection');
      expect(ui.lastFrame()).not.toContain('Press any key');
      await settle(100);
      ui.stdin.write('\u001b[13u');
      await vi.waitFor(() => expect(flow.checkAgain).toHaveBeenCalledTimes(1), {
        timeout: WAIT_FOR_TIMEOUT,
      });
      expect(onBack).not.toHaveBeenCalled();
    } finally {
      ui.unmount();
    }
  });

  it('retries activation after failure without leaving the dialog', async () => {
    flow.state = { status: 'ready', plan: 'Pro' };
    flow.connectionError = '';
    const ui = renderWithProviders(
      <SubscriptionDialog onBack={vi.fn()} onSwitchProvider={vi.fn()} />,
    );
    try {
      expect(ui.lastFrame()).toContain('Retry');
      expect(ui.lastFrame()).not.toContain('› Connect');
      expect(ui.lastFrame()).not.toContain('Loading models from provider');
      await settle(100);
      ui.stdin.write('\u001b[13u');
      await vi.waitFor(() => expect(flow.connect).toHaveBeenCalledOnce(), {
        timeout: WAIT_FOR_TIMEOUT,
      });
    } finally {
      ui.unmount();
    }
  });

  it('cancels while automatic activation is pending', async () => {
    flow.state = { status: 'ready', plan: 'Pro' };
    flow.connecting = true;
    const onBack = vi.fn();
    const ui = renderWithProviders(
      <SubscriptionDialog onBack={onBack} onSwitchProvider={vi.fn()} />,
    );
    try {
      expect(ui.lastFrame()).toContain('Loading models from provider…');
      expect(ui.lastFrame()).not.toContain('Retry');
      await settle(100);
      ui.stdin.write('\u001b');
      await vi.waitFor(() => expect(onBack).toHaveBeenCalledOnce(), {
        timeout: WAIT_FOR_TIMEOUT,
      });
      expect(flow.cancel).toHaveBeenCalledOnce();
      expect(flow.connect).not.toHaveBeenCalled();
    } finally {
      ui.unmount();
    }
  });
});
