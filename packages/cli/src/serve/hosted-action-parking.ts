/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { isHostedConfigScopedOwner } from './hosted-hook-session.js';
import type {
  HostedActionOptions,
  HostedApprovalSettings,
} from './hosted-tool-approval.js';

/** Why a continuation capture published no recovery plan for the wait. */
export type HostedContinuationCaptureRefusal =
  | 'not_native_batch'
  | 'todo_batch'
  | 'no_runtime'
  | 'shell_profile'
  | 'hooks_activation_owner'
  | 'hooks_memory_batch'
  | 'hook_unsettled'
  | 'mcp'
  | 'unsupported_tool'
  | 'undigested_call'
  | 'plan_oversize';

/** Why cold recovery cannot resume an approval wait on this Session shape. */
export type HostedApprovalResumeShapeRefusal =
  | 'mcp'
  | 'hooks_activation_owner'
  | 'no_tool_owner';

/** Why cold recovery cannot resume a command-step wait on this Session shape. */
export type HostedCommandStepResumeShapeRefusal =
  | 'extensions_disabled'
  | 'no_tool_owner';

export type HostedActionParkRefusal =
  | HostedContinuationCaptureRefusal
  | HostedApprovalResumeShapeRefusal
  | HostedCommandStepResumeShapeRefusal
  | 'turn_mismatch'
  | 'recovered_turn'
  | 'capability_not_advertised'
  | 'input_missing'
  | 'wake_owned'
  | 'other_unsettled_input'
  | 'action_not_requested'
  | 'no_continuation'
  | 'original_prompt_missing'
  | 'approval_selection_unavailable'
  | 'approval_mode_allows';

export interface HostedActionParkRegistration {
  readonly promptId: string;
  readonly options: HostedActionOptions;
  readonly settings?: HostedApprovalSettings;
  readonly livePoll: boolean;
  readonly globProfile: boolean;
  /** Set for a wait that can never park; it registers only to be counted. */
  readonly refusal?: HostedActionParkRefusal;
  freeze: () => boolean;
}

/**
 * The Session-shape terms cold recovery requires before it resumes an
 * approval continuation. Park eligibility reads the same terms, so a wait
 * never parks on a shape whose recovery would refuse it. A Hooks Session
 * resumes only on a config-scoped Hook owner: park teardown releases any
 * other owner's Runtime session, and the next load may not recompute its id.
 */
export function hostedApprovalResumeShapeRefusal(
  session: {
    readonly hooks?: { readonly broker: { readonly runtimeSessionId: string } };
    readonly mcp?: unknown;
    readonly toolProfile?: string;
    readonly memory?: unknown;
  },
  brokerOptions: unknown,
): HostedApprovalResumeShapeRefusal | undefined {
  if (session.mcp) return 'mcp';
  if (
    session.hooks &&
    !isHostedConfigScopedOwner(session.hooks.broker.runtimeSessionId)
  )
    return 'hooks_activation_owner';
  if (!((session.toolProfile && brokerOptions) || session.memory))
    return 'no_tool_owner';
  return undefined;
}

/**
 * The Session-shape terms cold recovery requires before it resumes a saved
 * extension command-step plan. Unlike a native batch, a Hook catalog does not
 * stop it: the takeover recovery arm admits the plan with one.
 */
export function hostedCommandStepResumeShapeRefusal(
  session: {
    readonly extensions?: { readonly enabled: boolean };
    readonly toolProfile?: string;
  },
  brokerOptions: unknown,
): HostedCommandStepResumeShapeRefusal | undefined {
  if (!session.extensions?.enabled) return 'extensions_disabled';
  if (!(session.toolProfile && brokerOptions)) return 'no_tool_owner';
  return undefined;
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
