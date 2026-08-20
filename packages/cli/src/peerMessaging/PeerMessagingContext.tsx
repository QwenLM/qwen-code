/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';
import type { PeerMessaging } from './peer-messaging.js';

export const PeerMessagingContext = createContext<PeerMessaging | null>(null);
export const usePeerMessaging = () => useContext(PeerMessagingContext);
