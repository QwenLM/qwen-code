/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const A2A_MCP_SERVER_NAME = 'qwen-a2a' as const;
export const A2A_MCP_ORIGINATOR_CLIENT_ID = 'daemon-a2a:local' as const;
export const A2A_CONTEXT_SUMMARY_MAX_CHARS = 4000;
export const A2A_MAX_DEPTH = 1;

export type A2aPeerSource = 'local' | 'explicit';

export interface A2aPeerConfig {
  id: string;
  alias?: string;
  url: string;
  tokenRef?: string;
}

export interface A2aSettings {
  enabled: boolean;
  explicitPeers: A2aPeerConfig[];
  trustedPeers: Map<string, A2aPeerConfig>;
}

export interface A2aPeerCandidate extends A2aPeerConfig {
  source: A2aPeerSource;
  workspaceCwd?: string;
  daemonId?: string;
  pid?: number;
  startedAt?: string;
  lastSeenAt?: string;
  trusted: boolean;
  callable: boolean;
}

export type A2aErrorCode =
  | 'peer_not_found'
  | 'peer_not_trusted'
  | 'peer_unreachable'
  | 'peer_auth_failed'
  | 'peer_capability_mismatch'
  | 'peer_permission_timeout'
  | 'peer_prompt_failed'
  | 'peer_response_timeout'
  | 'a2a_depth_exceeded'
  | 'peer_alias_ambiguous';

export class A2aError extends Error {
  constructor(
    readonly code: A2aErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'A2aError';
  }
}
