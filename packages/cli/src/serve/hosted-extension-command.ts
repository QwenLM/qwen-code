/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import {
  parseManagedToolStage,
  type ManagedToolStage,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-stage-record.js';
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { HostedCommand } from './hosted-skill-catalog.js';
import type { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import { extractInjections } from '../services/prompt-processors/injectionParser.js';
export class HostedCommandExpansionRefusedError extends Error {}

export interface HostedCommandPermission {
  readonly allowed: boolean;
  readonly toolName: 'read_file' | 'shell';
  readonly input: Record<string, unknown>;
  readonly inputRef?: ManagedSessionDurableRef;
  readonly approvalMode: 'default' | 'auto-edit' | 'auto' | 'yolo';
  readonly preHookOccurrence: string | null;
  readonly permissionHookOccurrence: string | null;
  readonly actionRequestId: string | null;
}

export async function expandHostedExtensionCommand(options: {
  session: ManagedSession;
  broker: HostedWorkspaceBroker;
  promptId: string;
  callId: string;
  revision: number;
  command: HostedCommand;
  args: string;
  signal: AbortSignal;
  definitionDigest(toolName: 'read_file' | 'shell'): string;
  decide(
    toolStageId: string,
    toolName: 'read_file' | 'shell',
    input: Record<string, unknown>,
  ): Promise<HostedCommandPermission>;
  completed(
    toolStageId: string,
    toolName: 'read_file' | 'shell',
    input: Record<string, unknown>,
    result: Record<string, unknown>,
  ): Promise<void>;
}): Promise<string> {
  const { session, broker, command, signal } = options;
  const expansionId = `command-${hash([session.authority.sessionHeader.sessionKey, options.promptId, options.callId, options.revision, command.name])}`;
  const original = command.prompt;
  const injections = [
    ...injectionsFor('!{').map((entry) => ({
      ...entry,
      toolName: 'shell' as const,
    })),
    ...injectionsFor('@{').map((entry) => ({
      ...entry,
      toolName: 'read_file' as const,
    })),
  ].sort((a, b) => a.startIndex - b.startIndex);
  if (
    injections.some(
      (entry, index) =>
        index > 0 && entry.startIndex < injections[index - 1]!.endIndex,
    )
  )
    throw new HostedCommandExpansionRefusedError(
      'Nested file and shell command preprocessing is unsupported.',
    );
  let prompt = '';
  let offset = 0;
  for (const [stepIndex, injection] of injections.entries()) {
    signal.throwIfAborted();
    const toolStageId = `command-step-${hash([expansionId, stepIndex])}`;
    prompt += raw(original.slice(offset, injection.startIndex));
    offset = injection.endIndex;
    if (!injection.content) continue;
    const input: Record<string, unknown> =
      injection.toolName === 'shell'
        ? {
            command: renderShellArguments(
              injection.content,
              options.args,
            ).replaceAll('${extensionPath}', '${QWEN_EXTENSION_ROOT}'),
            timeout: 120000,
          }
        : { file_path: raw(injection.content) };
    const saved = session.authority.extensionRecord('tool_stage', toolStageId);
    let stage: ManagedToolStage;
    if (saved) {
      stage = parseManagedToolStage(saved.record);
      if (
        stage.expansionId !== expansionId ||
        stage.stepIndex !== stepIndex ||
        stage.toolName !== injection.toolName
      )
        throw new Error('Command preprocessing identity conflicts.');
    } else {
      const decision = await options.decide(
        toolStageId,
        injection.toolName,
        input,
      );
      const inputRef =
        decision.inputRef ??
        (await publish('managed-extension-command-input', decision.input));
      const { input: _input, inputRef: _inputRef, ...permission } = decision;
      const permissionRef = await publish(
        'managed-extension-command-permission',
        { ...permission, inputRef },
      );
      stage = {
        kind: 'tool_stage',
        toolStageId,
        expansionId,
        stepIndex,
        toolName: injection.toolName,
        inputRef,
        permissionRef,
        resultRef: null,
        run: {
          state: 'admitted',
          reason: null,
          definition: {
            definitionId: injection.toolName,
            definitionRevision: 1,
            definitionDigest: options.definitionDigest(injection.toolName),
          },
          executionCallId: toolStageId,
          effectId: null,
          dispatchId: null,
          deliveryId: null,
          execution: 'intent',
          runtime: null,
          delivery: null,
        },
      };
      await commit(stage);
      if (!decision.allowed) {
        const result = {
          executionStatus: 'not_started',
          responseParts: [
            { text: 'The command preprocessing step was denied.' },
          ],
        };
        stage = {
          ...stage,
          resultRef: await publish('managed-extension-command-result', result),
          run: {
            ...stage.run,
            state: 'cancelled',
            execution: 'not_started_proven',
          },
        };
        await commit(stage);
      }
    }
    const actualInput = await read<Record<string, unknown>>(stage.inputRef);
    let result: Record<string, unknown>;
    if (stage.resultRef) result = await read(stage.resultRef);
    else {
      if (!broker.runtime)
        throw new Error('Command Runtime owner is unavailable.');
      const runtime = {
        runtimeBindingId: broker.runtime.bindingId,
        generation: broker.runtime.generation,
      };
      if (stage.run.runtime && !isDeepStrictEqual(stage.run.runtime, runtime))
        throw new Error(
          'Command preprocessing belongs to its original Runtime.',
        );
      const resume = stage.run.execution !== 'intent';
      if (!resume) {
        stage = {
          ...stage,
          run: {
            ...stage.run,
            state: 'running',
            execution: 'dispatch_started',
            runtime,
          },
        };
        await commit(stage);
      }
      const operation = {
        kind: 'extension-command' as const,
        operationId: toolStageId,
        toolName: injection.toolName,
        input: actualInput,
        revision: options.revision,
        extensionId: command.extensionId,
      };
      const send = (action: 'execute' | 'status' | 'cancel') =>
        broker.extensionCommand({
          ...operation,
          action,
          grant: session.authority.issueOperationGrant({
            domain: 'tool_stage',
            recordId: toolStageId,
            ownerId: broker.runtimeSessionId,
            workspaceGeneration: broker.runtime!.workspaceGeneration,
            phases: ['execute', 'status', 'cancel'],
            leaseDurationMs: 60_000,
          }),
        });
      let response = await send(resume ? 'status' : 'execute');
      while (response['state'] === 'running') {
        if (signal.aborted) {
          response = await send('cancel');
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        response = await send('status');
      }
      if (
        response['state'] !== 'settled' ||
        !response['result'] ||
        typeof response['result'] !== 'object'
      )
        throw new Error(
          'Command preprocessing outcome is unknown; query its original operation.',
        );
      result = response['result'] as Record<string, unknown>;
      stage = {
        ...stage,
        resultRef: await publish('managed-extension-command-result', result),
        run: {
          ...stage.run,
          state: result['executionStatus'] === 'success' ? 'settled' : 'failed',
          execution: 'settled',
        },
      };
      await commit(stage);
    }
    await options.completed(
      toolStageId,
      injection.toolName,
      actualInput,
      result,
    );
    if (result['executionStatus'] !== 'success')
      throw new HostedCommandExpansionRefusedError(
        'Command preprocessing did not complete successfully.',
      );
    if (!Array.isArray(result['responseParts']))
      throw new Error('Command preprocessing returned invalid text.');
    const output = result['responseParts']
      .map((part: unknown) =>
        part &&
        typeof part === 'object' &&
        'text' in part &&
        typeof part.text === 'string'
          ? part.text
          : '',
      )
      .join('\n');
    if (Buffer.byteLength(output) > 48 * 1024)
      throw new HostedCommandExpansionRefusedError(
        'Command preprocessing output exceeds the inline limit.',
      );
    prompt += output;
  }
  prompt += raw(original.slice(offset));
  if (
    !original.includes('{{args}}') &&
    !original.includes('$ARGUMENTS') &&
    options.args.trim()
  )
    prompt += `\n\n/${command.name} ${options.args}`;
  if (Buffer.byteLength(prompt) > 48 * 1024)
    throw new HostedCommandExpansionRefusedError(
      'Expanded command exceeds the inline limit.',
    );
  return `<extension_command name="${command.name}" source="extension://${command.extensionId}/" revision="${options.revision}">\n${prompt}\n</extension_command>`;

  function raw(text: string): string {
    return text
      .replaceAll('{{args}}', options.args)
      .replaceAll('$ARGUMENTS', options.args)
      .replaceAll('${extensionPath}', `extension://${command.extensionId}`);
  }
  function injectionsFor(trigger: string) {
    try {
      return extractInjections(original, trigger, command.name);
    } catch (cause) {
      throw new HostedCommandExpansionRefusedError(
        cause instanceof Error
          ? cause.message
          : 'Invalid command preprocessing.',
      );
    }
  }
  function publish(kind: string, value: unknown) {
    return session.resources.publish(kind, Buffer.from(JSON.stringify(value)));
  }
  function read<T>(ref: ManagedSessionDurableRef): Promise<T> {
    return session.resources
      .read(ref)
      .then((bytes) => JSON.parse(bytes.toString('utf8')) as T);
  }
  async function commit(stage: ManagedToolStage): Promise<void> {
    const previous = session.authority.extensionRecord(
      'tool_stage',
      stage.toolStageId,
    );
    await session.authority.commitExtensionRecord(
      {
        operation: 'commitCommandToolStage',
        commandId: previous
          ? `${stage.toolStageId}:${previous.revision + 1}`
          : stage.toolStageId,
        sessionKey: session.authority.sessionHeader.sessionKey,
        contentDigest: hash(stage),
      },
      { domain: 'tool_stage', record: stage },
      { class: 'trusted_entry' },
    );
  }
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function renderShellArguments(template: string, args: string): string {
  if (
    (template.includes('{{args}}') || template.includes('$ARGUMENTS')) &&
    /`|\$\(|<</u.test(template)
  )
    throw new HostedCommandExpansionRefusedError(
      'Argument placeholders in Shell substitutions and here-documents are unsupported.',
    );
  let result = '';
  let quoted: "'" | '"' | undefined;
  for (let index = 0; index < template.length; index++) {
    const placeholder = template.startsWith('{{args}}', index)
      ? '{{args}}'
      : template.startsWith('$ARGUMENTS', index)
        ? '$ARGUMENTS'
        : undefined;
    if (placeholder) {
      result +=
        quoted === "'"
          ? args.replaceAll("'", "'\\''")
          : quoted === '"'
            ? args.replace(/[\\$`"]/gu, '\\$&')
            : quote(args);
      index += placeholder.length - 1;
      continue;
    }
    const character = template[index]!;
    result += character;
    if (character === '\\' && quoted !== "'" && index + 1 < template.length) {
      result += template[++index];
      continue;
    }
    if (character === quoted) quoted = undefined;
    else if (!quoted && (character === "'" || character === '"'))
      quoted = character;
  }
  return result;
}
