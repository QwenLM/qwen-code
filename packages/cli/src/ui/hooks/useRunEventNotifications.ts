/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useRef } from 'react';
import {
  StreamingState,
  type ConfirmationRequest,
  type HistoryItemWithoutId,
} from '../types.js';
import {
  BRAND_CLI_NAME,
  NotificationType,
  type Config,
} from '@qwen-code/core';
import { getPendingAttentionNotification } from '../utils/pendingAttentionNotification.js';
import {
  buildRunEventNotificationContent,
  notifyViaTerminal,
} from '../../utils/terminalNotifications.js';

const ATTENTION_NOTIFICATION_COOLDOWN_MS = 20_000;

interface RunEventNotificationParams {
  notificationsEnabled: boolean;
  isFocused: boolean;
  hasReceivedFocusEvent: boolean;
  streamingState: StreamingState;
  hasPendingActionRequired: boolean;
  pendingHistoryItems: HistoryItemWithoutId[];
  commandConfirmationRequest: ConfirmationRequest | null;
  authConsentRequest: ConfirmationRequest | null;
  hasConfirmUpdateExtensionRequests: boolean;
  terminalName?: string;
  config?: Config;
}

export function useRunEventNotifications({
  notificationsEnabled,
  isFocused,
  hasReceivedFocusEvent,
  streamingState,
  hasPendingActionRequired,
  pendingHistoryItems,
  commandConfirmationRequest,
  authConsentRequest,
  hasConfirmUpdateExtensionRequests,
  config,
}: RunEventNotificationParams): void {
  const pendingAttentionNotification = useMemo(
    () =>
      getPendingAttentionNotification(
        pendingHistoryItems,
        commandConfirmationRequest,
        authConsentRequest,
        hasConfirmUpdateExtensionRequests,
      ),
    [
      pendingHistoryItems,
      commandConfirmationRequest,
      authConsentRequest,
      hasConfirmUpdateExtensionRequests,
    ],
  );

  const hadPendingAttentionRef = useRef(false);
  const previousFocusedRef = useRef(isFocused);
  const previousStreamingStateRef = useRef(streamingState);
  const lastSentAttentionNotificationRef = useRef<{
    key: string;
    sentAt: number;
  } | null>(null);

  useEffect(() => {
    if (!notificationsEnabled) {
      return;
    }

    const wasFocused = previousFocusedRef.current;
    previousFocusedRef.current = isFocused;

    const hasPendingAttention = pendingAttentionNotification !== null;
    const hadPendingAttention = hadPendingAttentionRef.current;
    hadPendingAttentionRef.current = hasPendingAttention;

    if (!hasPendingAttention) {
      lastSentAttentionNotificationRef.current = null;
      return;
    }

    const shouldSuppressForFocus = hasReceivedFocusEvent && isFocused;
    if (shouldSuppressForFocus) {
      return;
    }

    const justEnteredAttentionState = !hadPendingAttention;
    const justLostFocus = wasFocused && !isFocused;
    const now = Date.now();
    const currentKey = pendingAttentionNotification.key;
    const lastSent = lastSentAttentionNotificationRef.current;
    const keyChanged = !lastSent || lastSent.key !== currentKey;
    const onCooldown =
      !!lastSent &&
      lastSent.key === currentKey &&
      now - lastSent.sentAt < ATTENTION_NOTIFICATION_COOLDOWN_MS;

    const shouldNotifyByStateChange = hasReceivedFocusEvent
      ? justEnteredAttentionState || justLostFocus || keyChanged
      : justEnteredAttentionState || keyChanged;

    if (!shouldNotifyByStateChange || onCooldown) {
      return;
    }

    lastSentAttentionNotificationRef.current = {
      key: currentKey,
      sentAt: now,
    };

    void notifyViaTerminal(
      notificationsEnabled,
      buildRunEventNotificationContent(pendingAttentionNotification.event),
    );
  }, [
    isFocused,
    hasReceivedFocusEvent,
    notificationsEnabled,
    pendingAttentionNotification,
  ]);

  useEffect(() => {
    const previousStreamingState = previousStreamingStateRef.current;
    previousStreamingStateRef.current = streamingState;

    const justCompletedTurn =
      previousStreamingState === StreamingState.Responding &&
      streamingState === StreamingState.Idle;
    const shouldSuppressForFocus = hasReceivedFocusEvent && isFocused;

    if (
      !justCompletedTurn ||
      shouldSuppressForFocus ||
      hasPendingActionRequired
    ) {
      return;
    }

    // Terminal notification — gated by enableNotifications
    if (notificationsEnabled) {
      void notifyViaTerminal(
        true,
        buildRunEventNotificationContent({
          type: 'session_complete',
          detail: `${BRAND_CLI_NAME} finished responding.`,
        }),
      );
    }

    // Notification hook — always fire, not gated by enableNotifications
    void config
      ?.getHookSystem()
      ?.fireNotificationEvent(
        NotificationType.IdlePrompt,
        `${BRAND_CLI_NAME} finished responding and is awaiting input.`,
        { streamingState: 'idle' },
      );
  }, [
    streamingState,
    isFocused,
    hasReceivedFocusEvent,
    notificationsEnabled,
    config,
    hasPendingActionRequired,
  ]);
}
