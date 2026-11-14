/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setTimeout as settle } from 'node:timers/promises';
import { renderWithProviders } from '../../test-utils/render.js';
import type { SubscriptionState } from './use-subscription.js';
import { SubscriptionDialog } from './SubscriptionDialog.js';

// The macOS nightly legs run on contended 3-core hosts where the ink
// keypress-to-render chain can exceed vi.waitFor's 1s default budget (the
// canCheckAgain=true keyboard case failed three of four nights). 5s still
// timed out under the extreme contention of dispatch 43574338804 (cli 2/3,
// 734s of test time across workers), so use the repo's 15s contended-host
// budget. The case ceiling below keeps the chained waits under it.
const WAIT_FOR_TIMEOUT = 15_000;
// Keep the chained per-wait budgets under the case ceiling: the off-ECS
// lane default is 15s and the purchase-polling case chains three waits, so
// vitest would otherwise decide the outcome before the last wait's own
// timer (same rule as packages/core/src/test-utils/latency-budget.ts).
vi.setConfig({ testTimeout: 60_000 });

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
    <SubscriptionDialog onBack={onBack} onSwitchProvider={onSwitchProvider} />,
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
    const ui = renderWithProviders(
      <SubscriptionDialog onBack={onBack} onSwitchProvider={vi.fn()} />,
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
      // Enter. Under the extreme macOS nightly load a single keypress can be
      // starved or its escape sequence split across stdin reads (dispatch
      // 43584714730 cli 2/3: spy 0 calls after 15s). Re-send Enter until the
      // handler fires, with a real settle between attempts so an in-flight
      // keypress is processed before the next; stop the instant it fires so
      // the exactly-once assertion below stays meaningful.
      await settle(150);
      for (
        let i = 0;
        i < 30 && flow.switchAccount.mock.calls.length === 0;
        i++
      ) {
        ui.stdin.write('\u001b[13u');
        await settle(500);
      }
      await vi.waitFor(
        () => expect(flow.switchAccount).toHaveBeenCalledOnce(),
        { timeout: WAIT_FOR_TIMEOUT },
      );
      expect(onBack).not.toHaveBeenCalled();
      expect(flow.cancel).not.toHaveBeenCalled();
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
