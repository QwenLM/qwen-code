/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import path from 'node:path';

/**
 * Loopback port launchd listens on. The Web Shell dials the same number
 * (`packages/web-shell/client/desktop-relay/desktop-relay-client.ts`), and an
 * SSH `RemoteForward` targets it for terminal sessions.
 */
export const DESKTOP_RELAY_PORT = 47821;

export const DESKTOP_RELAY_LABEL = 'com.qwencode.desktop-relay';

/**
 * Keep the reverse-channel registration distinct from a configured node-repl
 * server. The daemon deliberately rejects client MCP servers that shadow
 * settings, and remote hosts commonly already have node-repl configured.
 */
export const DESKTOP_RELAY_SERVER_NAME = 'desktop-node-repl';

/** Kept equal to the SDK version the bundled computer-use skill pins. */
export const DESKTOP_RELAY_CUA_SDK_VERSION = '0.20.9';

/**
 * The daemon drops `/acp` frames above 10 MB; leave room for the
 * `mcp_message` envelope around a reply.
 */
export const MAX_RELAYED_REPLY_BYTES = 9 * 1024 * 1024;

export function defaultRelayHome(): string {
  return path.join(os.homedir(), '.qwen', 'desktop-relay');
}

export function launchAgentPlistPath(): string {
  return path.join(
    os.homedir(),
    'Library',
    'LaunchAgents',
    `${DESKTOP_RELAY_LABEL}.plist`,
  );
}
