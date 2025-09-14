/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto';

/**
 * A unique identifier for the current session.
 * This is generated once when the module is first loaded and remains constant for the lifetime of the process.
 */
export const sessionId = randomUUID();
