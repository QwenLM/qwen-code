/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ApprovalMode } from '../config/approval-mode.js';
import { readOwnSessionRecord } from '../services/session-registry.js';
import { receiverReviewsActions } from './inbound-gate.js';
import { buildUserFrame } from './peer-frames.js';
import {
  formatPeerAddress,
  listMessageablePeers,
  resolvePeerTarget,
  suggestPeerNames,
  type PeerSessionInfo,
} from './peer-directory.js';
import { PeerSendError, sendPeerFrame } from './uds-client.js';

export interface OwnPeerIdentity {
  sessionId: string;
  ipcPath: string;
  name: string;
}

export async function getOwnPeerIdentity(): Promise<OwnPeerIdentity | null> {
  const record = await readOwnSessionRecord();
  if (!record?.ipcPath) return null;
  return {
    sessionId: record.sessionId,
    ipcPath: record.ipcPath,
    name: record.name,
  };
}

export type PeerSendOutcome =
  | { kind: 'sent'; peer: PeerSessionInfo; address: string }
  | { kind: 'disabled' }
  | { kind: 'not-found'; suggestions: string[] }
  | { kind: 'ambiguous'; matches: string[] }
  | { kind: 'empty' }
  | { kind: 'failed'; peer: PeerSessionInfo; address: string; reason: string };

export async function sendToPeer(options: {
  target: string;
  message: string;
  approvalMode: ApprovalMode | null;
}): Promise<PeerSendOutcome> {
  const self = await getOwnPeerIdentity();
  if (!self) return { kind: 'disabled' };

  const peers = (await listMessageablePeers()).filter(
    (peer) => peer.sessionId !== self.sessionId,
  );
  const resolved = resolvePeerTarget(peers, options.target);
  if (resolved.kind === 'none') {
    return {
      kind: 'not-found',
      suggestions: suggestPeerNames(peers, options.target),
    };
  }
  if (resolved.kind === 'ambiguous') {
    return {
      kind: 'ambiguous',
      matches: resolved.matches.map(
        (peer) => `${peer.name} [${peer.ref}] in ${peer.cwd}`,
      ),
    };
  }
  if (!options.message) return { kind: 'empty' };

  const peer = resolved.peer;
  const address = formatPeerAddress(peer, peers);
  try {
    await sendPeerFrame(
      peer.ipcPath,
      buildUserFrame({
        content: options.message,
        from: self.ipcPath,
        fromName: self.name,
        ...(options.approvalMode !== null
          ? {
              fromMode: receiverReviewsActions(options.approvalMode)
                ? 'prompting'
                : 'bypass',
            }
          : {}),
      }),
    );
    return { kind: 'sent', peer, address };
  } catch (error) {
    return {
      kind: 'failed',
      peer,
      address,
      reason: describeSendFailure(error),
    };
  }
}

export function describeSendFailure(error: unknown): string {
  if (error instanceof PeerSendError) {
    switch (error.code) {
      case 'ENOENT':
      case 'ECONNREFUSED':
        return 'that session exited; list agents again to refresh its address.';
      case 'EAGAIN':
      case 'EBUSY':
        return 'that session is busy; retry the same name shortly.';
      case 'ETIMEDOUT':
        return 'that session accepted the connection but did not read the message.';
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
