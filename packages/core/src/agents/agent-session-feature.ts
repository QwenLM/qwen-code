/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_ENABLE_AGENT_SESSIONS } from '../config/brand.js';

/**
 * Agent-session gate shared by CLI and SDK-launched sessions.
 *
 * The feature is enabled by default. Set the branded environment variable to
 * `0` before launching the CLI process to force Agent invocations to run in
 * the foreground and disable background-only Agent entry points.
 */
export function isAgentSessionsEnabled(): boolean {
  return process.env[ENV_ENABLE_AGENT_SESSIONS] !== '0';
}
