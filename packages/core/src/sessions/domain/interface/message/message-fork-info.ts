/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Fork provenance: which source session and message this entry was branched from. */
export interface MessageForkInfo {
  /** Source session id that was forked. */
  readonly sessionId: string;
  /** Source message UUID carried over in the fork. */
  readonly messageUuid: string;
}
