/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import type React from 'react';
import { useCallback } from 'react';
import {
  formatPeerAttribution,
  joinPeerAttribution,
  type HeldMessageSummary,
  type HoldCause,
} from '@qwen-code/core';
import { theme } from '../semantic-colors.js';
import { BRAND_CLI_NAME } from '@qwen-code/core';
import {
  RadioButtonSelect,
  type RadioSelectItem,
} from './shared/RadioButtonSelect.js';
import { BaseTabDialog } from './shared/BaseTabDialog.js';

export enum PeerInboundApprovalChoice {
  APPROVE = 'approve',
  DENY = 'deny',
}

export interface PeerInboundApprovalResult {
  choice: PeerInboundApprovalChoice;
}

export interface PeerInboundApprovalRequestState {
  /** Held-message id, used to resolve the message when the user answers. */
  id: string;
  cause: HoldCause;
  summary: HeldMessageSummary;
  /** Messages held behind this one, which are reviewable only via `/peers`. */
  otherHeldCount: number;
  /** True when the claimed address matches a session in the local registry. */
  knownPeer: boolean;
}

interface PeerInboundApprovalDialogProps {
  request: PeerInboundApprovalRequestState;
  onComplete: (result: PeerInboundApprovalResult) => void;
}

const CAUSE_EXPLANATIONS: Record<string, string> = {
  'no-mode-asserted':
    'This session bypasses permission checks, and the sender did not declare its own. Anything it asks for would run without a further prompt.',
  'mode-mismatch':
    'The sending session runs with a different permission posture than this one, so it may be asking this session to do something it could not do itself.',
  // Read on access so the explanation names the installed product.
  get 'unregistered-sender'() {
    return `The sender's address does not match any registered session on this machine, so it may not be a ${BRAND_CLI_NAME} session at all.`;
  },
  'repo-setting':
    'A settings file in this repository asks for inbound peer messages to be held. That is a decision the repository made, not one you made, so it is put to you rather than applied silently.',
};

/**
 * Approval prompt for a peer message the inbound gate parked.
 *
 * Everything shown here is peer-authored and was sanitized and truncated on the
 * way in. The dialog states both facts rather than presenting the text as
 * trustworthy or complete: identity is a claim, and approving delivers the whole
 * message, not just the excerpt on screen.
 */
export const PeerInboundApprovalDialog: React.FC<
  PeerInboundApprovalDialogProps
> = ({ request, onComplete }) => {
  const handleDeny = useCallback(() => {
    onComplete({ choice: PeerInboundApprovalChoice.DENY });
  }, [onComplete]);

  const handleSelect = useCallback(
    (choice: PeerInboundApprovalChoice) => {
      onComplete({ choice });
    },
    [onComplete],
  );

  const options: Array<RadioSelectItem<PeerInboundApprovalChoice>> = [
    {
      label: 'Deliver it to this session',
      value: PeerInboundApprovalChoice.APPROVE,
      key: 'approve',
    },
    {
      label: 'Decline — drop it and tell the sender',
      value: PeerInboundApprovalChoice.DENY,
      key: 'deny',
    },
  ];

  const { summary } = request;
  // One formatter for every surface that names a sender, so the dialog, the
  // hold notice and the feed row cannot describe the same message three ways.
  // The handle inside it is derived from the address rather than read from the
  // message, which is what lines it up with `/peers` — but it is not evidence
  // of who sent this: the address is a claim too.
  const attribution = formatPeerAttribution({
    from: summary.claimedAddress,
    ...(summary.claimedName !== undefined && {
      claimedName: summary.claimedName,
    }),
  });
  const sender = joinPeerAttribution(attribution);
  const explanation = CAUSE_EXPLANATIONS[request.cause];

  return (
    <BaseTabDialog
      title="Another session sent this one a message"
      onClose={handleDeny}
      borderColor={theme.status.warning}
    >
      <Box marginBottom={1} flexDirection="column">
        <Text color={theme.text.primary}>
          From <Text bold>{sender}</Text>{' '}
          <Text color={theme.text.secondary} dimColor>
            (name and address are supplied by the sender and are not verified
            {request.knownPeer
              ? "; a session at that address is in this machine's registry"
              : ''}
            )
          </Text>
        </Text>
        {explanation ? (
          <Text color={theme.text.secondary}>{explanation}</Text>
        ) : null}
      </Box>

      <Box marginLeft={2} marginBottom={1} flexDirection="column">
        {summary.body.split('\n').map((line, index) => (
          <Text key={index} color={theme.text.primary}>
            {line}
          </Text>
        ))}
      </Box>

      <Box marginBottom={1} flexDirection="column">
        {summary.truncated ? (
          <Text color={theme.text.secondary} dimColor>
            Excerpt only — the full message is delivered if you approve.
          </Text>
        ) : null}
        {summary.attachmentCount > 0 ? (
          <Text color={theme.status.warning}>
            {summary.attachmentCount} file
            {summary.attachmentCount === 1 ? '' : 's'} arrived with this message
            and {summary.attachmentCount === 1 ? 'has' : 'have'} already been
            copied into this session. Declining removes{' '}
            {summary.attachmentCount === 1 ? 'it' : 'them'}.
          </Text>
        ) : null}
        {request.otherHeldCount > 0 ? (
          <Text color={theme.text.secondary} dimColor>
            {request.otherHeldCount} other held message
            {request.otherHeldCount === 1 ? '' : 's'} — review with /peers.
          </Text>
        ) : null}
      </Box>

      <RadioButtonSelect
        items={options}
        onSelect={handleSelect}
        isFocused={true}
      />
    </BaseTabDialog>
  );
};
