/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sending a message to another session on this machine.
 *
 * Kept apart from the tool so the routing decision — is this name a peer
 * at all? — can be made and tested without a tool invocation.
 */

import type { ApprovalMode } from '../config/approval-mode.js';
import { readOwnSessionRecord } from '../services/session-registry.js';
import { approvalModeClass } from './inbound-gate.js';
import { buildUserFrame } from './peer-frames.js';
import {
  formatPeerAddress,
  listMessageablePeers,
  resolvePeerTarget,
  suggestPeerNames,
  type PeerSessionInfo,
} from './peer-directory.js';
import { PeerSendError, sendPeerFrame } from './uds-client.js';

/**
 * This session's own reply address and display name.
 *
 * `ipcPath` is only present once the inbox is bound, which is also the
 * flag for "cross-session messaging is enabled here". Sending without it
 * would produce a message no one can answer, so the absence doubles as
 * the send-side gate.
 */
export interface OwnPeerIdentity {
  ipcPath: string;
  name: string;
}

export async function getOwnPeerIdentity(): Promise<OwnPeerIdentity | null> {
  const record = await readOwnSessionRecord();
  if (!record?.ipcPath) return null;
  return { ipcPath: record.ipcPath, name: record.name };
}

export type PeerSendOutcome =
  | { kind: 'sent'; peer: PeerSessionInfo; address: string }
  | { kind: 'disabled' }
  | { kind: 'not-found'; suggestions: string[] }
  | { kind: 'ambiguous'; matches: string[] }
  | { kind: 'failed'; peer: PeerSessionInfo; address: string; reason: string };

export interface SendToPeerOptions {
  target: string;
  message: string;
  /** Current approval mode, asserted to the receiver for mode parity. */
  approvalMode: ApprovalMode | null;
}

/**
 * Resolve `target` against the reachable peers and deliver `message`.
 *
 * Every failure is a described outcome rather than a thrown error: the
 * caller renders all of them to a model, and each one has a different
 * next step (turn the feature on, fix the name, add a ref, retry).
 */
export async function sendToPeer(
  options: SendToPeerOptions,
): Promise<PeerSendOutcome> {
  const self = await getOwnPeerIdentity();
  if (!self) return { kind: 'disabled' };

  const peers = (await listMessageablePeers()).filter(
    (peer) => peer.ipcPath !== self.ipcPath,
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

  const peer = resolved.peer;
  const address = formatPeerAddress(peer, peers);
  const frame = buildUserFrame({
    content: options.message,
    from: self.ipcPath,
    fromName: self.name,
    ...(options.approvalMode !== null
      ? { fromMode: approvalModeClass(options.approvalMode) }
      : {}),
  });

  try {
    await sendPeerFrame(peer.ipcPath, frame);
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

/**
 * Turn an errno into something a model can act on.
 *
 * The distinction that matters: a stale address means "re-discover", a
 * busy pipe means "retry the same address". Collapsing both into "send
 * failed" makes the model guess.
 */
export function describeSendFailure(error: unknown): string {
  if (error instanceof PeerSendError) {
    switch (error.code) {
      case 'ENOENT':
      case 'ECONNREFUSED':
        return 'that session just exited — its address is stale. List the agents again to see who is reachable now.';
      case 'EBUSY':
        return 'the session is alive but momentarily busy. Retry the same name shortly.';
      case 'ETIMEDOUT':
        return 'the session accepted the connection but never read the message.';
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
