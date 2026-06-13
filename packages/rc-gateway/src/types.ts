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
      rcClient?: {
        id: string;
        scopes: RcScope[];
        sessionLockId?: string;
        /** Present only for a share token: its id, for audit `shareId` tagging. */
        shareId?: string;
        /** Present only for a share token: its operator-chosen label. */
        shareLabel?: string;
        /**
         * Underlying-human identity asserted by a BRIDGE token via the
         * `X-RC-SubActor` header (e.g. `telegram:evan`). Set by `resolveSubActor`
         * ONLY when the token holds the `bridge` scope and the value is valid —
         * a non-bridge token can never assert one (no audit-attribution spoofing).
         */
        subActor?: string;
      };
    }
  }
}

export {};
