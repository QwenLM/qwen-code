/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ContextState } from '../agents/runtime/agent-headless.js';
import type { AgentExternalInput } from '../agents/runtime/agent-types.js';

export function applySubagentStartContext(
  context: ContextState,
  additionalContext: string,
  systemPrompt?: string,
): void {
  context.set('hook_context', additionalContext);
  // An explicit template owns first-turn placement; resident turns omit it.
  if (systemPrompt?.includes('${hook_context}')) return;

  const externalInputs = context.get('external_inputs_override') as
    | AgentExternalInput[]
    | undefined;
  if (externalInputs) {
    context.set('external_inputs_override', [
      ...externalInputs,
      additionalContext,
    ]);
  } else {
    context.set(
      'task_prompt',
      `${String(context.get('task_prompt') ?? '')}\n\n${additionalContext}`,
    );
  }
}
