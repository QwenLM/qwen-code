/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { SessionMetrics } from '@qwen-code/core';
import { renderWithProviders } from '../../test-utils/render.js';
import {
  UsageStatusPanel,
  buildSessionStatusRows,
  buildSessionUsageRows,
} from './UsageStatusPanel.js';

const coreMocks = vi.hoisted(() => ({
  boundPeerIdentity: vi.fn<() => { address: string; ref: string } | undefined>(
    () => undefined,
  ),
}));

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return { ...actual, ...coreMocks };
});

const metrics = {
  models: { a: { api: { totalLatencyMs: 1500 } } },
  files: { totalLinesAdded: 3, totalLinesRemoved: 1 },
} as unknown as SessionMetrics;

const ACCOUNT_LABELS = [
  'Plan',
  'Credits',
  'Org Resource Package',
  'Account',
  'Organization',
  'Login',
  'Promotions',
];

async function render(initialTab: 'usage' | 'status') {
  let view!: Awaited<ReturnType<typeof renderWithProviders>>;
  await act(async () => {
    view = await renderWithProviders(
      <UsageStatusPanel
        initialTab={initialTab}
        currentModel="auto"
        sessionId="session-1"
        sessionMetrics={metrics}
        cliVersion="9.9.9"
        onClose={vi.fn()}
      />,
      { width: 120 },
    );
  });
  return view;
}

describe('UsageStatusPanel', () => {
  it('shows only session usage on the usage tab', async () => {
    const view = await render('usage');
    const frame = view.lastFrame() ?? '';

    expect(frame).toContain('Total Duration (API)');
    expect(frame).toContain('1.5s');
    expect(frame).toContain('3 lines added, 1 lines removed');
    for (const label of ACCOUNT_LABELS) expect(frame).not.toContain(label);
    view.unmount();
  });

  it('shows the model and session details on the status tab', async () => {
    coreMocks.boundPeerIdentity.mockReturnValueOnce({
      address: '/tmp/peer.sock',
      ref: 'ref',
    });
    const view = await render('status');
    const frame = view.lastFrame() ?? '';

    expect(frame).toContain('Model');
    expect(frame).toContain('9.9.9');
    expect(frame).toContain('session-1');
    expect(frame).toContain('/tmp/peer.sock');
    for (const label of ACCOUNT_LABELS) expect(frame).not.toContain(label);
    view.unmount();
  });
});

describe('session rows', () => {
  it('builds the usage rows from session metrics', () => {
    expect(
      buildSessionUsageRows({ sessionMetrics: metrics }).map(([l]) => l),
    ).toEqual([
      'Total Duration (API)',
      'Total Duration (wall)',
      'Total Code Changes',
    ]);
  });

  it('builds the status rows and omits an unbound peer', () => {
    expect(buildSessionStatusRows({ sessionId: 's', cliVersion: '1' })).toEqual(
      [
        ['Version', '1'],
        ['Session ID', 's'],
        ['Working Directory', process.cwd()],
      ],
    );
  });
});
