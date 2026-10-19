/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FunctionDeclaration } from '@google/genai';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { readHostedTurnApprovalSelection } from './hosted-approval-selection.js';
import {
  readHostedActionOptions,
  hostedActionAllowed,
} from './hosted-tool-approval.js';
import { readHostedApprovalContinuation } from './hosted-approval-continuation.js';

export const HOSTED_PUBLIC_PLAN_TOOL: FunctionDeclaration = {
  name: 'exit_plan_mode',
  description:
    'Submit your complete Markdown plan for user approval, as the only call in a batch. Remain read-only until approval. Approval continues this Turn under its selected execution permission.',
  parametersJsonSchema: {
    type: 'object',
    properties: { plan: { type: 'string', minLength: 1, maxLength: 24000 } },
    required: ['plan'],
    additionalProperties: false,
  },
};

export const HOSTED_PUBLIC_PLAN_READS = new Set(['read_file', 'glob', 'skill']);
export const HOSTED_PUBLIC_PLAN_REFUSAL =
  'Plan mode is read-only: only read_file, glob, static skill loading and a single exit_plan_mode call are allowed. Submit a plan with exit_plan_mode and wait for the user to approve it before making changes or running Shell commands.';

export async function hostedPublicPlanActive(
  session: ManagedSession,
  promptId: string,
): Promise<boolean> {
  if (!(await readHostedTurnApprovalSelection(session, promptId))?.planMode)
    return false;
  const events = session.authority.eventsInSequenceRange(
    1,
    session.authority.committedSequence,
  );
  for (const event of events) {
    if (event.kind !== 'action.changed' || event.payload['state'] !== 'decided')
      continue;
    const action = session.authority.action(String(event.payload['requestId']));
    if (!action) continue;
    const options = await readHostedActionOptions(session, action);
    if (
      options.turnId !== promptId ||
      options.toolName !== 'exit_plan_mode' ||
      options.v !== 3 ||
      !hostedActionAllowed(action, options.policyRevision)
    )
      continue;
    const saved = await readHostedApprovalContinuation(
      session,
      options.continuationRef,
      promptId,
    );
    if (
      saved.plan.calls.length !== 1 ||
      saved.plan.calls[0].call.name !== 'exit_plan_mode' ||
      saved.plan.calls[0].call.callId !== options.functionCallId ||
      saved.plan.calls[0].actionId !== action.requestId
    )
      throw new Error('Plan approval does not match its original call.');
    return false;
  }
  return true;
}
