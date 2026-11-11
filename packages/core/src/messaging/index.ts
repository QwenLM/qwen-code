/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cross-session peer messaging.
 *
 * See docs/designs/2026-08-08-cross-session-peer-messaging.md for the design,
 * and §6.8 in particular for the security posture: there is no verified sender
 * identity, only same-uid filesystem isolation.
 */

export {
  CROSS_SESSION_FEATURE_NAME,
  CROSS_SESSION_LIST_AGENTS_FEATURE_NAME,
  CROSS_SESSION_MODE_EMIT_FEATURE_NAME,
  isCrossSessionMessagingEnabled,
  isListAgentsToolEnabled,
  isPeerModeEmitEnabled,
} from './cross-session-feature.js';

export {
  CROSS_SESSION_MESSAGE_TAG,
  buildCrossSessionEnvelope,
  extractEnvelopeMeta,
  guardEnvelopeBody,
  parseCrossSessionEnvelope,
  type CrossSessionEnvelope,
  type PeerModeClass,
} from './cross-session-envelope.js';

export {
  HOP_ID_LENGTH,
  MAX_HOP_CHAIN,
  MAX_PEER_ADDRESS_LENGTH,
  UDS_ADDRESS_PREFIX,
  hopChainContains,
  hopIdForAddress,
  isLocalIpcPath,
  isValidPeerAddress,
  parsePeerAddress,
  toUdsAddress,
} from './peer-address.js';

export {
  PEER_PROTOCOL_VERSION,
  getProcessStartMs,
  getSessionRegistryDir,
  getSessionRegistryPath,
  getSessionRegistryRefreshFailures,
  isProcessAlive,
  listLivePeerSessions,
  isKnownPeerAddress,
  probeSocket,
  readSessionRegistry,
  refreshSessionRegistryEntry,
  removeSessionRegistryEntry,
  writeSessionRegistryEntry,
  type LivePeerSession,
  type SessionKind,
  type SessionRegistryEntry,
  type SessionStatus,
} from './session-registry.js';

export {
  HOLD_SETTLEMENT_BUDGET_MS,
  INBOUND_SEVERITY,
  MAX_HELD_MESSAGES,
  applyInboundPolicy,
  currentModeClass,
  decideInboundPolicy,
  describeEffectiveInboundPolicy,
  listHeldMessages,
  modeClassOf,
  reevaluateHeldMessages,
  resolveHeldMessage,
  setCrossSessionInboundResolver,
  setHeldMessageListener,
  setPeerReceiptSink,
  setPermissionModeGetter,
  setReviewSurfaceAvailable,
  settleHeldMessagesOnShutdown,
  withdrawHeldMessageClaim,
  type CrossSessionInbound,
  type CrossSessionInboundSource,
  type HeldApprovalRequest,
  type HeldPeerMessage,
  type HoldCause,
  type InboundPolicyDecision,
  type PeerMessageStatus,
  type ResolvedCrossSessionInbound,
} from './inbound-policy.js';

export {
  EMPTY_BODY_PLACEHOLDER,
  MAX_BODY_LINES,
  MAX_BODY_LINE_LENGTH,
  MAX_CLAIMED_NAME_LENGTH,
  MAX_FEED_BODY_LINES,
  MAX_FEED_BODY_LINE_LENGTH,
  MAX_PREVIEW_LENGTH,
  UNKNOWN_PEER_LABEL,
  boundPeerBodyForFeed,
  formatPeerAttribution,
  joinPeerAttribution,
  labelCarriesHandle,
  sanitizeForDisplay,
  summarizeHeldMessage,
  type BoundedPeerBody,
  type HeldMessageSummary,
  type PeerAttribution,
} from './peer-message-preview.js';

export {
  MAX_PEER_FILES,
  MAX_PEER_FILE_BYTES,
  describePeerFiles,
  discardPeerFiles,
  injectPeerFilePrefix,
  materializePeerFiles,
  type PeerFileRef,
} from './peer-files.js';

export { ownSelfToken, sendCrossSessionMessage } from './uds-client.js';

export {
  boundMessagingSocket,
  ensureSelfToken,
  getDefaultUdsSocketPath,
  startUdsMessaging,
  type UdsMessagingHandle,
} from './uds-server.js';

export {
  MAX_ASK_CANDIDATES,
  MAX_MENTIONABLE_LABEL_LENGTH,
  escapePeerLabel,
  isMentionableLabel,
  mentionableLabelFor,
  parsePeerMentions,
  resolvePeerMentions,
  type PeerMentionResolution,
} from './peer-mention.js';

export {
  addressLabel,
  assignPeerLabels,
  baseNameForSession,
  boundPeerIdentity,
  displayNameForSession,
  formatPeersForModel,
  handleFact,
  humanizeAge,
  listAllPeers,
  peerHandle,
  peerHandleFromAddress,
  resolvePeerRecipient,
  shortRef,
  type NameableSession,
  type OwnPeerIdentity,
  type PeerEntry,
  type PeerRecipientResolution,
  type StalePeerAddress,
} from './peer-listing.js';

export { ListAgentsTool } from './list-agents-tool.js';

export { createPeerDropReporter, peerDropReporter } from './peer-guard.js';
