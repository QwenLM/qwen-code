/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview This daemon's programs as an Agent Host.
 *
 * The Host heartbeat and `GET …/hosts/service` both read the probe; it is
 * cached by `probeAgentPrograms` (60 s), so a CLI installed after the join
 * shows up on a later heartbeat without a restart.
 */

import type {
  HostProgramProbe,
  SessionAgentProgram,
} from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';
import { probeAgentPrograms } from './session-agents/program-probe.js';

export function getHostProgramProbe(): Promise<HostProgramProbe[]> {
  return probeAgentPrograms();
}

export function availablePrograms(
  probes: readonly HostProgramProbe[],
): SessionAgentProgram[] {
  return probes
    .filter((probe) => probe.available)
    .map((probe) => probe.program);
}
