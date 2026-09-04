/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { GoalTurnPermit } from './goal-protocol.js';

export const goalTurnContext = new AsyncLocalStorage<GoalTurnPermit>();
