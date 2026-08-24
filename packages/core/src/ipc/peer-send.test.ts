/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalMode } from '../config/approval-mode.js';
import type { PeerSessionInfo } from './peer-directory.js';
import { describeSendFailure, sendToPeer } from './peer-send.js';
import { PeerSendError } from './uds-client.js';

const mocks = vi.hoisted(() => ({
  readOwnSessionRecord: vi.fn(),
  listMessageablePeers: vi.fn(),
  sendPeerFrame: vi.fn(),
}));

vi.mock('../services/session-registry.js', () => ({
  readOwnSessionRecord: mocks.readOwnSessionRecord,
}));
vi.mock('./peer-directory.js', async () => {
  const real = await vi.importActual<typeof import('./peer-directory.js')>(
    './peer-directory.js',
  );
  return { ...real, listMessageablePeers: mocks.listMessageablePeers };
});
vi.mock('./uds-client.js', async () => {
  const real =
    await vi.importActual<typeof import('./uds-client.js')>('./uds-client.js');
  return { ...real, sendPeerFrame: mocks.sendPeerFrame };
});

const socket = (name: string) =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\qwen-${name}`
    : `/tmp/qwen-${name}.sock`;

function peer(
  name: string,
  ref: string,
  sessionId = `${name}-${ref}`,
): PeerSessionInfo {
  return {
    sessionId,
    name,
    ref,
    cwd: `/work/${name}`,
    pid: 10,
    ipcPath: socket(ref),
    startedAt: 1,
  };
}

describe('sendToPeer', () => {
  beforeEach(() => {
    mocks.readOwnSessionRecord.mockReset().mockResolvedValue({
      sessionId: 'self-session',
      name: 'planner',
      ipcPath: socket('self'),
    });
    mocks.listMessageablePeers.mockReset().mockResolvedValue([]);
    mocks.sendPeerFrame.mockReset().mockResolvedValue(undefined);
  });

  it('stays disabled until this session advertises an inbox', async () => {
    mocks.readOwnSessionRecord.mockResolvedValue({
      sessionId: 'self-session',
      name: 'planner',
    });

    await expect(
      sendToPeer({
        target: 'worker',
        message: 'hello',
        approvalMode: ApprovalMode.DEFAULT,
      }),
    ).resolves.toEqual({ kind: 'disabled' });
    expect(mocks.listMessageablePeers).not.toHaveBeenCalled();
  });

  it('sends a marked frame and excludes this session from discovery', async () => {
    const worker = peer('worker', 'aaaaaa');
    mocks.listMessageablePeers.mockResolvedValue([
      peer('planner', '000000', 'self-session'),
      worker,
    ]);

    const outcome = await sendToPeer({
      target: 'worker',
      message: 'run the focused tests',
      approvalMode: ApprovalMode.DEFAULT,
    });

    expect(outcome).toEqual({
      kind: 'sent',
      peer: worker,
      address: 'qwen-session:aaaaaa',
    });
    expect(mocks.sendPeerFrame).toHaveBeenCalledWith(
      worker.ipcPath,
      expect.objectContaining({
        type: 'user',
        from: socket('self'),
        fromName: 'planner',
        fromMode: 'prompting',
        message: { role: 'user', content: 'run the focused tests' },
      }),
    );
  });

  it('asserts AUTO as bypassing per-action review', async () => {
    const worker = peer('worker', 'aaaaaa');
    mocks.listMessageablePeers.mockResolvedValue([worker]);

    await sendToPeer({
      target: 'worker',
      message: 'edit the file',
      approvalMode: ApprovalMode.AUTO,
    });

    expect(mocks.sendPeerFrame).toHaveBeenCalledWith(
      worker.ipcPath,
      expect.objectContaining({ fromMode: 'bypass' }),
    );
  });

  it('reports ambiguity without sending', async () => {
    mocks.listMessageablePeers.mockResolvedValue([
      peer('worker', 'aaaaaa'),
      peer('worker', 'bbbbbb'),
    ]);

    const outcome = await sendToPeer({
      target: 'worker',
      message: 'hello',
      approvalMode: null,
    });

    expect(outcome).toMatchObject({
      kind: 'ambiguous',
      matches: [
        'qwen-session:aaaaaa (worker in /work/worker)',
        'qwen-session:bbbbbb (worker in /work/worker)',
      ],
    });
    expect(mocks.sendPeerFrame).not.toHaveBeenCalled();
  });

  it('does not claim an empty frame was sent', async () => {
    mocks.listMessageablePeers.mockResolvedValue([peer('worker', 'aaaaaa')]);

    await expect(
      sendToPeer({
        target: 'worker',
        message: '',
        approvalMode: null,
      }),
    ).resolves.toEqual({ kind: 'empty' });
    expect(mocks.sendPeerFrame).not.toHaveBeenCalled();
  });
});

describe('describeSendFailure', () => {
  it('gives an actionable retry hint for a busy peer', () => {
    expect(describeSendFailure(new PeerSendError('busy', 'EAGAIN'))).toContain(
      'retry',
    );
  });

  it('asks for fresh discovery after a stale address', () => {
    expect(
      describeSendFailure(new PeerSendError('gone', 'ECONNREFUSED')),
    ).toContain('list agents again');
  });
});
