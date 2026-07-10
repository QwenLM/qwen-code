/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RcScope } from './scopes.js';

/**
 * A browser origin admitted to the CORS allowlist.  Origins admitted at
 * pairing-code redemption are persisted (`source: 'db'`); origins from
 * server config are merged in at read time and never stored (`source: 'config'`).
 */
export interface CorsOriginRecord {
  origin: string;
  admittedByTokenId: string | null;
  admittedAt: string | null;
  /** Derived at read time; not a stored field. */
  source: 'db' | 'config';
}

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
         * `X-RC-SubActor` header (e.g. `telegram:alice`). Set by `resolveSubActor`
         * ONLY when the token holds the `bridge` scope and the value is valid —
         * a non-bridge token can never assert one (no audit-attribution spoofing).
         */
        subActor?: string;
      };
    }
  }
}

export {};
