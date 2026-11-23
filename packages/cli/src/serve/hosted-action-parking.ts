/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import type {
  HostedActionOptions,
  HostedApprovalSettings,
} from './hosted-tool-approval.js';

export interface HostedActionParkRegistration {
  readonly promptId: string;
  readonly options: HostedActionOptions;
  readonly settings?: HostedApprovalSettings;
  readonly livePoll: boolean;
  readonly globProfile: boolean;
  freeze: () => boolean;
}

// The value may capture its key's turn, so the registry itself must not keep a
// removed Session alive while its frozen promise remains pending.
const registrations = new WeakMap<
  ManagedSession,
  HostedActionParkRegistration
>();

export function registerHostedActionPark(
  session: ManagedSession,
  registration?: HostedActionParkRegistration,
): void {
  if (registration) registrations.set(session, registration);
  else registrations.delete(session);
}

export function hostedActionParkRegistration(
  session: ManagedSession,
): HostedActionParkRegistration | undefined {
  return registrations.get(session);
}
