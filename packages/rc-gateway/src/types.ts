/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RcScope } from './scopes.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by `bearerResolve` once a token is validated. */
      rcClient?: { id: string; scopes: RcScope[]; sessionLockId?: string };
    }
  }
}

export {};
