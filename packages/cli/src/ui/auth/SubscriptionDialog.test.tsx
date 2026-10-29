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

const flow = vi.hoisted(() => ({
  state: { status: 'waiting' } as SubscriptionState,
  email: 'tester@example.com',
  deviceAuth: {
    device_code: 'test-device',
    user_code: 'BCDF-GHJK',
    verification_uri: 'https://pre4-chat.qwen.ai/authorize',
    verification_uri_complete:
      'https://pre4-chat.qwen.ai/authorize?user_code=BCDF-GHJK&client=qwen-code',
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
  signOut: vi.fn(),
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
  flow.signOut.mockResolvedValue(true);
});
afterEach(() => vi.restoreAllMocks());

it('shows the real authorization link and cancels without signing out', async () => {
  const onBack = vi.fn();
  const ui = renderWithProviders(
    <SubscriptionDialog onBack={onBack} onModelStudio={vi.fn()} />,
  );
  try {
    expect(ui.lastFrame()).toContain('client=qwen-code');
    expect(ui.lastFrame()).not.toContain('LOCAL-MOCK');
    await settle(100);
    ui.stdin.write('\u001b');
    await vi.waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
    expect(flow.cancel).toHaveBeenCalledTimes(1);
    expect(flow.signOut).not.toHaveBeenCalled();
  } finally {
    ui.unmount();
  }
});

it('keeps Check again hidden during purchase polling and signs out through the session', async () => {
  flow.state = { status: 'purchase-required', plan: 'Free' };
  const onBack = vi.fn();
  const ui = renderWithProviders(
    <SubscriptionDialog onBack={onBack} onModelStudio={vi.fn()} />,
  );
  try {
    expect(ui.lastFrame()).toContain('tester@example.com');
    expect(ui.lastFrame()).not.toContain('Check again');
    await settle(100);
    ui.stdin.write('\u001b[B');
    await settle(100);
    ui.stdin.write('\u001b[B');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('› Sign out'));
    await settle(100);
    ui.stdin.write('\u001b[13u');
    await vi.waitFor(() => expect(flow.signOut).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
  } finally {
    ui.unmount();
  }
});

it('shows Check again after purchase timeout and disables it while checking', () => {
  flow.state = {
    status: 'purchase-required',
    plan: 'Free',
    message: 'test timeout',
  };
  flow.canCheckAgain = true;
  flow.checking = true;
  const ui = renderWithProviders(
    <SubscriptionDialog onBack={vi.fn()} onModelStudio={vi.fn()} />,
  );
  try {
    expect(ui.lastFrame()).toContain('Check again');
    expect(ui.lastFrame()).toContain('Checking your subscription…');
  } finally {
    ui.unmount();
  }
});

it('waits for automatic activation without a Connect or Sign out menu', () => {
  flow.state = { status: 'ready', plan: 'Plus' };
  const ui = renderWithProviders(
    <SubscriptionDialog onBack={vi.fn()} onModelStudio={vi.fn()} />,
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
      onModelStudio={vi.fn()}
    />,
  );
  try {
    expect(ui.lastFrame()).toContain('Run /model');
    expect(ui.lastFrame()).not.toContain('Retry');
    await settle(100);
    ui.stdin.write('\u001b');
    await vi.waitFor(() =>
      expect(onModelSelectionRequired).toHaveBeenCalledOnce(),
    );
    expect(onBack).not.toHaveBeenCalled();
    expect(flow.signOut).not.toHaveBeenCalled();
    expect(flow.connect).not.toHaveBeenCalled();
  } finally {
    ui.unmount();
  }
});

it('keeps the error visible when sign-out fails', async () => {
  flow.state = { status: 'purchase-required', plan: 'Free' };
  flow.signOut.mockResolvedValue(false);
  const onBack = vi.fn();
  const ui = renderWithProviders(
    <SubscriptionDialog onBack={onBack} onModelStudio={vi.fn()} />,
  );
  try {
    await settle(100);
    ui.stdin.write('\u001b[B');
    await settle(100);
    ui.stdin.write('\u001b[B');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('› Sign out'));
    await settle(100);
    ui.stdin.write('\u001b[13u');
    await vi.waitFor(() => expect(flow.signOut).toHaveBeenCalledTimes(1));
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
    <SubscriptionDialog onBack={onBack} onModelStudio={vi.fn()} />,
  );
  try {
    expect(ui.lastFrame()).toContain('Check again');
    expect(ui.lastFrame()).not.toContain('Press any key');
    await settle(100);
    ui.stdin.write('\u001b[13u');
    await vi.waitFor(() => expect(flow.checkAgain).toHaveBeenCalledTimes(1));
    expect(onBack).not.toHaveBeenCalled();
  } finally {
    ui.unmount();
  }
});

it('retries activation after failure without leaving the dialog', async () => {
  flow.state = { status: 'ready', plan: 'Pro' };
  flow.connectionError =
    'Could not connect Qwen Subscription. Please try again.';
  const ui = renderWithProviders(
    <SubscriptionDialog onBack={vi.fn()} onModelStudio={vi.fn()} />,
  );
  try {
    expect(ui.lastFrame()).toContain('Retry');
    expect(ui.lastFrame()).not.toContain('› Connect');
    await settle(100);
    ui.stdin.write('\u001b[13u');
    await vi.waitFor(() => expect(flow.connect).toHaveBeenCalledOnce());
    expect(flow.signOut).not.toHaveBeenCalled();
  } finally {
    ui.unmount();
  }
});

it('cancels while automatic activation is pending', async () => {
  flow.state = { status: 'ready', plan: 'Pro' };
  flow.connecting = true;
  const onBack = vi.fn();
  const ui = renderWithProviders(
    <SubscriptionDialog onBack={onBack} onModelStudio={vi.fn()} />,
  );
  try {
    expect(ui.lastFrame()).toContain('Loading models from provider…');
    expect(ui.lastFrame()).not.toContain('Retry');
    await settle(100);
    ui.stdin.write('\u001b');
    await vi.waitFor(() => expect(onBack).toHaveBeenCalledOnce());
    expect(flow.cancel).toHaveBeenCalledOnce();
    expect(flow.connect).not.toHaveBeenCalled();
  } finally {
    ui.unmount();
  }
});
