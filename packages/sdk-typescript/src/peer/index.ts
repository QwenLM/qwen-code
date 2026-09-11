/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `@qwen-code/sdk/peer`: join the Qwen Code sessions running as this user.
 *
 * An implementation of the cross-session protocol for a program that is
 * not itself a Qwen Code session — a voice front-end, a relay, a build
 * watcher. Node only, and built from Node's own modules alone.
 *
 * ```ts
 * import { PeerEndpoint } from '@qwen-code/sdk/peer';
 *
 * const endpoint = await PeerEndpoint.start({
 *   name: 'voice-bridge',
 *   onMessage: (message) => console.log(message.fromName, message.content),
 * });
 * const [session] = await endpoint.list();
 * const sent = await endpoint.send({ to: session.address, content: 'status?' });
 * ```
 *
 * `PeerEndpoint` is the whole of what most programs need. The pieces it is
 * built from are exported too, for a program that wants to hold its own
 * record or socket.
 */

export {
  MAX_REMEMBERED_MESSAGES,
  MAX_TRACKED_SENDS,
  PeerEndpoint,
  describeSendFailure,
  type AwaitReceiptOptions,
  type PeerEndpointOptions,
  type PeerInboundMessage,
  type PeerReceipt,
  type PeerSendOptions,
  type PeerSendResult,
  type PeerSessionSummary,
} from './endpoint.js';
export { PeerEndpointError, type PeerEndpointErrorCode } from './errors.js';
export {
  MAX_DROPPED_MSG_IDS,
  MAX_FRAME_CHARS,
  PEER_DELIVERY_STATUSES,
  PEER_FRAME_VERSION,
  buildAuthLine,
  buildDeliveryStatusFrame,
  buildUserFrame,
  canonicalizeMsgId,
  describeDeliveryStatus,
  encodePeerFrame,
  isPeerMsgId,
  parsePeerAuthLine,
  parsePeerFrame,
  type BuildDeliveryStatusFields,
  type BuildUserFrameFields,
  type PeerControlFrame,
  type PeerDeliveryStatus,
  type PeerDropReason,
  type PeerFrame,
  type PeerMessagePriority,
  type PeerModeClass,
  type PeerUserFrame,
} from './frames.js';
export {
  MAX_CONCURRENT_SENDS,
  PROBE_TIMEOUT_MS,
  PeerSendError,
  SEND_TIMEOUT_MS,
  isLocalIpcPath,
  probePeerSocketVerdict,
  sendPeerFrame,
  type PeerSocketVerdict,
  type SendPeerFrameOptions,
} from './client.js';
export {
  LINE_DEADLINE_MS,
  MAX_PEER_CONNECTIONS,
  MAX_SOCKET_PATH_BYTES,
  resolveInboxCandidates,
  startPeerInbox,
  type PeerInbox,
  type PeerInboxOptions,
} from './inbox.js';
export {
  advertisablePeerAddress,
  reachableEntries,
  resolvePeerTarget,
  suggestPeerNames,
  toDirectoryEntry,
  type PeerDirectoryEntry,
  type PeerResolution,
} from './directory.js';
export {
  SESSION_REGISTRY_SCHEMA_VERSION,
  readLiveSessionRecords,
  resolveQwenHome,
  sessionRegistryDir,
  type SessionRecord,
} from './registry.js';
export {
  MAX_LABEL_CHARS,
  MAX_SESSION_NAME_CHARS,
  deriveSessionName,
  flattenPeerLabel,
  peerRef,
} from './label.js';
