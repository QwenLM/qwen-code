/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** A remote-control capability scope. Flat set for the walking skeleton. */
export type RcScope = string;

/** The only scope exercised this cycle: read a session's event stream. */
export const SESSION_READ: RcScope = 'session:read';
