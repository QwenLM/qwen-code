/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import type { TodoItem } from '@qwen-code/qwen-code-core/hooks/types.js';
import { checkHostedTodoWriteInput } from './hosted-workspace-tool-input.js';

async function readTodoState(
  session: ManagedSession,
  ref: ManagedSessionDurableRef,
): Promise<TodoItem[]> {
  const body = JSON.parse(
    (await session.resources.read(ref)).toString('utf8'),
  ) as Record<string, unknown>;
  const check = checkHostedTodoWriteInput({ todos: body['todos'] });
  if (check.error)
    throw new Error(`Stored Hosted Todo state is invalid: ${check.error}`);
  return body['todos'] as TodoItem[];
}

export async function writeHostedTodos(
  session: ManagedSession,
  promptId: string,
  callId: string,
  input: Record<string, unknown>,
): Promise<TodoItem[]> {
  const check = checkHostedTodoWriteInput(input);
  if (check.error) throw new Error(check.error);
  const callKey = createHash('sha256')
    .update(JSON.stringify([promptId, callId]))
    .digest('hex');
  const receipt = await session.authority.commitDomainRecord(
    {
      operation: 'writeHostedTodos',
      commandId: `todo:${callKey}`,
      sessionKey: session.authority.sessionHeader.sessionKey,
      contentDigest: `sha256:${managedToolDigest(input)}`,
    },
    { domain: 'todo_state', content: { todos: input['todos'] } },
    { class: 'trusted_entry' },
  );
  // Replay returns this call's committed state, even after a later update.
  return readTodoState(session, receipt.recordRef);
}

export async function hostedTodoInstructions(
  session: ManagedSession,
): Promise<string> {
  const current = session.authority.domainRecord('todo_state');
  if (!current) return '';
  const todos = await readTodoState(session, current.recordRef);
  return (
    '# Current Session todo list\n\n' +
    'This is the latest persisted task state. Keep it current with todo_write; do not mark unfinished work complete.\n' +
    JSON.stringify(todos)
  );
}
