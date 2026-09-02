/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';
import type { PeerInboxStartFailure } from '@qwen-code/qwen-code-core';
import type { PeerMessaging } from './peer-messaging.js';

export const PeerMessagingContext = createContext<PeerMessaging | null>(null);
export const usePeerMessaging = () => useContext(PeerMessagingContext);

/**
 * Why this session has no inbox although cross-session messaging is on.
 *
 * Null while the inbox is still binding, when it bound, and when the
 * feature is off; set once the bind has failed for good. Kept apart from
 * the inbox itself so a null inbox can be told apart from a failed one.
 */
export const PeerInboxFailureContext =
  createContext<PeerInboxStartFailure | null>(null);
export const usePeerInboxFailure = () => useContext(PeerInboxFailureContext);
