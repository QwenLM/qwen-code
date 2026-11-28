/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The dialog is the only surface that shows a peer's text next to a control
 * that runs it, so these assert the disclosures rather than the layout: what is
 * claimed, what is hidden, and what already touched the disk.
 */

import { peerHandle, type HeldMessageSummary } from '@qwen-code/core';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test-utils/render.js';
import {
  PeerInboundApprovalChoice,
  PeerInboundApprovalDialog,
  type PeerInboundApprovalRequestState,
} from './PeerInboundApprovalDialog.js';

function summary(
  overrides: Partial<HeldMessageSummary> = {},
): HeldMessageSummary {
  return {
    preview: 'please deploy to prod',
    body: 'please deploy to prod',
    truncated: false,
    attachmentCount: 0,
    claimedName: 'worker',
    claimedAddress: 'uds:/tmp/peer.sock',
    ...overrides,
  };
}

/**
 * The frame with its box drawing and wrapping removed.
 *
 * Ink wraps every paragraph at the dialog width, so a sentence that spans a
 * wrap is absent from the raw frame. Flattening lets a test assert what the
 * dialog says without also asserting where the terminal happened to break it.
 */
function flatten(frame: string | undefined): string {
  return (frame ?? '')
    .replace(/[│╭╮╰╯─]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function request(
  overrides: Partial<PeerInboundApprovalRequestState> = {},
): PeerInboundApprovalRequestState {
  return {
    id: 'ab12cd34',
    cause: 'no-mode-asserted',
    summary: summary(),
    otherHeldCount: 0,
    knownPeer: false,
    ...overrides,
  };
}

describe('PeerInboundApprovalDialog', () => {
  it('shows the body and both choices', async () => {
    const { lastFrame } = await renderWithProviders(
      <PeerInboundApprovalDialog request={request()} onComplete={vi.fn()} />,
    );

    const frame = lastFrame();
    expect(frame).toContain('please deploy to prod');
    expect(frame).toContain('Deliver it to this session');
    expect(frame).toContain('Decline');
  });

  // The explanation table is keyed by a plain string, so a cause with no entry
  // costs nothing at compile time and simply renders no reason at all — asking
  // someone to approve a message without telling them why it was stopped. Every
  // cause the gate can prompt on therefore needs an assertion of its own.
  it.each([
    ['no-mode-asserted', 'bypasses permission checks'],
    ['mode-mismatch', 'different permission posture'],
    ['repo-setting', 'repository'],
  ] as const)('explains why a %s hold is being asked about', async (
    cause,
    expected,
  ) => {
    const { lastFrame } = await renderWithProviders(
      <PeerInboundApprovalDialog
        request={request({ cause })}
        onComplete={vi.fn()}
      />,
    );

    expect(flatten(lastFrame())).toContain(expected);
  });

  // [AC17] Identity here is a claim. Presenting it as anything more would turn
  // a display convention into a trust signal.
  it('labels the sender as unverified', async () => {
    const { lastFrame } = await renderWithProviders(
      <PeerInboundApprovalDialog request={request()} onComplete={vi.fn()} />,
    );

    expect(flatten(lastFrame())).toContain('worker');
    expect(flatten(lastFrame())).toContain('not verified');
  });

  // The handle is computed from the reply address, so it is the part of the
  // attribution that lines up with `/peers`. The name stays marked as a claim.
  it('attributes by the handle derived from the reply address', async () => {
    const { lastFrame } = await renderWithProviders(
      <PeerInboundApprovalDialog request={request()} onComplete={vi.fn()} />,
    );

    const frame = flatten(lastFrame());
    expect(frame).toContain(`From worker -${peerHandle('/tmp/peer.sock')}`);
    expect(frame).toContain(
      'name and address are supplied by the sender and are not verified',
    );
  });

  it('falls back to the claimed name when the address yields no handle', async () => {
    const { lastFrame } = await renderWithProviders(
      <PeerInboundApprovalDialog
        request={request({
          summary: summary({ claimedAddress: 'somewhere-else' }),
        })}
        onComplete={vi.fn()}
      />,
    );

    expect(flatten(lastFrame())).toContain('From worker');
  });

  it('reports a registry match without upgrading it to verification', async () => {
    const { lastFrame } = await renderWithProviders(
      <PeerInboundApprovalDialog
        request={request({ knownPeer: true })}
        onComplete={vi.fn()}
      />,
    );

    expect(flatten(lastFrame())).toContain('registry');
    expect(flatten(lastFrame())).toContain('not verified');
  });

  // [AC17] Truncation is only safe if the user is told they are approving more
  // than they can see.
  it('states that approval delivers the full body when truncated', async () => {
    const { lastFrame } = await renderWithProviders(
      <PeerInboundApprovalDialog
        request={request({ summary: summary({ truncated: true }) })}
        onComplete={vi.fn()}
      />,
    );

    expect(lastFrame()).toContain('full message is delivered if you approve');
  });

  // [AC16] Approving "a message" that silently brought files is not informed
  // consent, so the count and the fact they are already written are shown.
  it('discloses attachments and that declining removes them', async () => {
    const { lastFrame } = await renderWithProviders(
      <PeerInboundApprovalDialog
        request={request({ summary: summary({ attachmentCount: 2 }) })}
        onComplete={vi.fn()}
      />,
    );

    const frame = lastFrame();
    // Fragments rather than sentences: Ink wraps the paragraph at the dialog
    // width, so a phrase that spans a wrap is absent from the frame.
    expect(frame).toContain('2 files arrived');
    expect(frame).toContain('already been');
    expect(frame).toContain('Declining');
  });

  // [AC13] The messages behind this one are not prompted for, so the dialog
  // says where to find them.
  it('points at /peers for messages held behind this one', async () => {
    const { lastFrame } = await renderWithProviders(
      <PeerInboundApprovalDialog
        request={request({ otherHeldCount: 3 })}
        onComplete={vi.fn()}
      />,
    );

    expect(lastFrame()).toContain('3 other held messages');
    expect(lastFrame()).toContain('/peers');
  });

  it('completes with approve on the first choice', async () => {
    const onComplete = vi.fn();
    const { stdin } = await renderWithProviders(
      <PeerInboundApprovalDialog request={request()} onComplete={onComplete} />,
    );

    act(() => {
      stdin.write('\r');
    });

    expect(onComplete).toHaveBeenCalledWith({
      choice: PeerInboundApprovalChoice.APPROVE,
    });
  });

  it('completes with deny on the second choice', async () => {
    const onComplete = vi.fn();
    const { stdin } = await renderWithProviders(
      <PeerInboundApprovalDialog request={request()} onComplete={onComplete} />,
    );

    act(() => {
      stdin.write('[B');
    });
    act(() => {
      stdin.write('\r');
    });

    expect(onComplete).toHaveBeenCalledWith({
      choice: PeerInboundApprovalChoice.DENY,
    });
  });
});
