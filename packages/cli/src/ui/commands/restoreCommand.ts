/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createRestoreToolResponseBinding,
  selectRestoreCheckpointCall,
  isRestoreToolResponseBindingCurrent,
  type RestoreToolResponseBinding,
} from '../utils/restore-tool-response.js';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  InteractiveModToolScheduler,
  type InteractiveCompletedToolCall,
} from '../../services/interactive-mod-tool-scheduler.js';
import { ToolNames } from '@qwen-code/qwen-code-core/tools/tool-names.js';
import {
  ToolConfirmationOutcome,
  type ToolCallConfirmationDetails,
} from '@qwen-code/qwen-code-core/tools/tools.js';
import {
  type CommandContext,
  type SlashCommand,
  type SlashCommandActionReturn,
  CommandKind,
} from './types.js';
import type { Content } from '@google/genai';
import type { Config } from '@qwen-code/qwen-code-core';
import { markApiHistoryPrompt } from '@qwen-code/qwen-code-core/services/session-api-history.js';
import { t } from '../../i18n/index.js';
import type { HistoryItem } from '../types.js';

async function restoreAction(
  context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const { services, ui } = context;
  const { config } = services;
  const { addItem, loadHistory } = ui;
  const sessionId = config?.getSessionId();
  const expectedHistory = ui.history;
  let loadedHistory: HistoryItem[] | undefined;
  let restoreNoticeId: number | undefined;
  let restoreResponseBinding: RestoreToolResponseBinding | undefined;
  let restoreRecorder: ReturnType<Config['getChatRecordingService']>;
  const isCurrent = () => {
    const history = ui.history;
    const loaded = loadedHistory;
    // Ink can publish this command's queued user item while filesystem work awaits.
    const invocation = history[expectedHistory.length];
    const ownInvocationPublished =
      context.invocation?.historyItemId !== undefined &&
      invocation?.id === context.invocation.historyItemId &&
      invocation.type === 'user' &&
      invocation.text === context.invocation.raw;
    const expectedLength =
      expectedHistory.length + (ownInvocationPublished ? 1 : 0);
    return (
      !context.abortSignal?.aborted &&
      (!restoreRecorder ||
        config?.getChatRecordingService() === restoreRecorder) &&
      (!restoreResponseBinding ||
        isRestoreToolResponseBindingCurrent(restoreResponseBinding)) &&
      config?.getSessionId() === sessionId &&
      ui.isIdleRef.current &&
      ((history.length === expectedLength &&
        expectedHistory.every((item, index) => item === history[index])) ||
        (loaded !== undefined &&
          history.length === loaded.length &&
          history.every((item, index) => item === loaded[index])) ||
        (restoreNoticeId !== undefined &&
          history.length === expectedLength + 1 &&
          history.at(-1)?.id === restoreNoticeId &&
          expectedHistory.every((item, index) => item === history[index])))
    );
  };

  if (config?.getShellExecutionSandbox?.()) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'File restore is unavailable in tool sandbox.',
    };
  }

  const checkpointDir = config?.storage.getProjectTempCheckpointsDir();

  if (!checkpointDir) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Could not determine the .qwen directory path.',
    };
  }

  try {
    // Ensure the directory exists before trying to read it.
    await fs.mkdir(checkpointDir, { recursive: true });
    const files = await fs.readdir(checkpointDir);
    if (!isCurrent()) return;
    const jsonFiles = files.filter((file) => file.endsWith('.json'));

    if (!args) {
      if (jsonFiles.length === 0) {
        return {
          type: 'message',
          messageType: 'info',
          content: 'No restorable tool calls found.',
        };
      }
      const truncatedFiles = jsonFiles.map((file) => {
        const components = file.split('.');
        if (components.length <= 1) {
          return file;
        }
        components.pop();
        return components.join('.');
      });
      const fileList = truncatedFiles.join('\n');
      return {
        type: 'message',
        messageType: 'info',
        content: `Available tool calls to restore:\n\n${fileList}`,
      };
    }

    const selectedFile = args.endsWith('.json') ? args : `${args}.json`;

    if (!jsonFiles.includes(selectedFile)) {
      return {
        type: 'message',
        messageType: 'error',
        content: `File not found: ${selectedFile}`,
      };
    }

    const filePath = path.join(checkpointDir, selectedFile);
    const data = await fs.readFile(filePath, 'utf-8');
    if (!isCurrent()) return;
    const toolCallData = JSON.parse(data);

    if (toolCallData.commitHash && !toolCallData.promptId) {
      return {
        type: 'message',
        messageType: 'error',
        content:
          'This checkpoint uses a legacy format that is no longer supported. Please create a new checkpoint.',
      };
    }

    const toolCall = toolCallData.toolCall;
    if (
      !toolCall ||
      typeof toolCall !== 'object' ||
      typeof toolCall.name !== 'string' ||
      (toolCall.callId !== undefined &&
        (typeof toolCall.callId !== 'string' || toolCall.callId.length === 0))
    ) {
      throw new Error('Checkpoint is missing a valid toolCall.');
    }

    const checkpointHistory: Content[] | undefined = Array.isArray(
      toolCallData.clientHistory,
    )
      ? toolCallData.clientHistory
      : undefined;
    if (checkpointHistory) {
      const promptIds: unknown[] = Array.isArray(toolCallData.promptIds)
        ? toolCallData.promptIds
        : [];
      checkpointHistory.forEach((content, index) =>
        markApiHistoryPrompt(content, promptIds[index]),
      );
      const selected = selectRestoreCheckpointCall(
        checkpointHistory,
        toolCall.name,
        toolCall.callId,
      );
      if (selected) {
        if (!config) throw new Error('Configuration is not available.');
        restoreRecorder = config.getChatRecordingService();
        if (
          selected.promptId &&
          toolCallData.promptId &&
          selected.promptId !== toolCallData.promptId
        )
          throw new Error(
            'Checkpoint prompt identity does not match its pending call.',
          );
        restoreRecorder?.assertRestoreToolBranchAnchor({
          sessionId: sessionId!,
          originalCallId: selected.callId,
          name: selected.name,
          args: selected.args,
          promptId: selected.promptId ?? toolCallData.promptId,
        });
      }
    }

    if (toolCallData.promptId) {
      if (!config) {
        return {
          type: 'message',
          messageType: 'error',
          content: 'Configuration is not available.',
        };
      }
      try {
        const result = await config
          .getFileHistoryService()
          .rewind(toolCallData.promptId, true);
        if (!isCurrent()) return;
        if (result.filesFailed.length > 0) {
          addItem(
            {
              type: 'warning',
              text: `Partially restored: ${result.filesChanged.length} file(s) reverted, ${result.filesFailed.length} file(s) failed. Aborting tool replay.`,
            },
            Date.now(),
          );
          return;
        }
        restoreNoticeId = addItem(
          {
            type: 'info',
            text: 'Restored project to the state at the start of this turn.',
          },
          Date.now(),
        );
      } catch (error) {
        if (!isCurrent()) return;
        addItem(
          {
            type: 'warning',
            text: `Could not restore files: ${error instanceof Error ? error.message : String(error)}`,
          },
          Date.now(),
        );
        return;
      }
    }

    if (toolCallData.history) {
      if (!loadHistory) {
        return {
          type: 'message',
          messageType: 'error',
          content: 'loadHistory function is not available.',
        };
      }
      context.ui.clearPendingState?.();
      // Ink publishes loadHistory through React before its command-context
      // ref updates. Accept the exact requested snapshot on either side of it.
      loadedHistory = toolCallData.history;
      loadHistory(toolCallData.history);
    }

    if (toolCallData.clientHistory) {
      // A checkpoint is JSON, so the Symbol-keyed prompt identity of each
      // model-facing entry cannot survive the round trip. Re-mark from the
      // parallel array the writer persisted; without it a restored turn is
      // identified in the UI but unresolvable in the API history, and
      // conversation rewind fails closed across the whole restored range.
      const promptIds: unknown[] = Array.isArray(toolCallData.promptIds)
        ? toolCallData.promptIds
        : [];
      toolCallData.clientHistory.forEach((content: Content, index: number) => {
        markApiHistoryPrompt(content, promptIds[index]);
      });
      const historyInstalled = config
        ?.getLlmClient()
        ?.setHistory(toolCallData.clientHistory);
      const pendingTail = toolCallData.clientHistory?.at(-1);
      restoreResponseBinding =
        config &&
        pendingTail?.role === 'model' &&
        pendingTail.parts?.some(
          (part: NonNullable<Content['parts']>[number]) => part.functionCall,
        )
          ? createRestoreToolResponseBinding(
              config,
              toolCall.name,
              toolCall.args,
              restoreRecorder
                ? {
                    recorder: restoreRecorder,
                    truncatedCount: Math.max(
                      0,
                      expectedHistory.length -
                        (toolCallData.history?.length ??
                          expectedHistory.length),
                    ),
                    promptId: toolCallData.promptId,
                  }
                : undefined,
              toolCall.callId,
            )
          : undefined;
      await historyInstalled;
      if (!isCurrent()) return;
    }

    const editable = [
      ToolNames.EDIT,
      'replace',
      ToolNames.WRITE_FILE,
      ToolNames.NOTEBOOK_EDIT,
    ].includes(toolCall.name);
    const target =
      toolCall.args?.[
        toolCall.name === ToolNames.NOTEBOOK_EDIT
          ? 'notebook_path'
          : 'file_path'
      ];
    if (
      config &&
      editable &&
      typeof target === 'string' &&
      target &&
      !config.getFileReadCacheDisabled()
    ) {
      let exists = true;
      try {
        await fs.stat(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        exists = false;
      }
      if (!isCurrent()) return;
      if (exists) {
        const controller = new AbortController();
        const signal = context.abortSignal
          ? AbortSignal.any([controller.signal, context.abortSignal])
          : controller.signal;
        let waiting: ToolCallConfirmationDetails | undefined;
        let approval: AbortController | undefined;
        try {
          const read = await new Promise<InteractiveCompletedToolCall>(
            (resolve, reject) => {
              const callId = randomUUID();
              const scheduler = new InteractiveModToolScheduler({
                config,
                getPreferredEditor: () => undefined,
                onEditorClose: () => {},
                onAllToolCallsComplete: async (calls) => {
                  if (calls[0]) resolve(calls[0]);
                  else reject(new Error('Restore read did not complete.'));
                },
                onToolCallsUpdate: (calls) => {
                  const call = calls.find(
                    (call) => call.request.callId === callId,
                  );
                  if (call?.status !== 'awaiting_approval') {
                    waiting = undefined;
                    approval?.abort();
                    approval = undefined;
                    return;
                  }
                  const details = call.confirmationDetails;
                  if (waiting === details) return;
                  waiting = details;
                  approval?.abort();
                  approval = new AbortController();
                  if (details.type !== 'info' || !isCurrent()) {
                    void details
                      .onConfirm(ToolConfirmationOutcome.Cancel)
                      .catch(reject);
                    return;
                  }
                  let answered = false;
                  ui.addConfirmUpdateExtensionRequest({
                    prompt: `${details.title}\n\n${details.prompt}`,
                    signal: AbortSignal.any([signal, approval.signal]),
                    isCurrent,
                    onConfirm: (confirmed) => {
                      if (answered || waiting !== details) return;
                      answered = true;
                      void details
                        .onConfirm(
                          confirmed && isCurrent()
                            ? ToolConfirmationOutcome.ProceedOnce
                            : ToolConfirmationOutcome.Cancel,
                        )
                        .catch(reject);
                    },
                  });
                },
              });
              void scheduler
                .schedule(
                  {
                    callId,
                    name: ToolNames.READ_FILE,
                    args: { file_path: target },
                    prompt_id: toolCallData.promptId ?? randomUUID(),
                    isClientInitiated: true,
                    executionOrigin: { kind: 'client' },
                  },
                  signal,
                )
                .catch(reject);
            },
          );
          if (!isCurrent()) return;
          if (read.status !== 'success' || read.response.error) {
            return {
              type: 'message',
              messageType: 'error',
              content: `Could not read the restored file: ${read.response.error?.message ?? read.status}`,
            };
          }
        } finally {
          waiting = undefined;
          approval?.abort();
          controller.abort();
        }
      }
    }

    if (!isCurrent()) return;
    return {
      type: 'tool',
      toolName: toolCall.name,
      toolArgs: toolCall.args,
      ...(restoreResponseBinding ? { restoreResponseBinding } : {}),
    };
  } catch (error) {
    if (!isCurrent()) return;
    return {
      type: 'message',
      messageType: 'error',
      content: `Could not read restorable tool calls. This is the error: ${error}`,
    };
  }
}

async function completion(
  context: CommandContext,
  _partialArg: string,
): Promise<string[]> {
  const { services } = context;
  const { config } = services;
  const checkpointDir = config?.storage.getProjectTempCheckpointsDir();
  if (!checkpointDir) {
    return [];
  }
  try {
    const files = await fs.readdir(checkpointDir);
    return files
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.replace('.json', ''));
  } catch (_err) {
    return [];
  }
}

export const restoreCommand = (config: Config | null): SlashCommand | null => {
  if (!config?.getFileCheckpointingEnabled()) {
    return null;
  }

  return {
    name: 'restore',
    get description() {
      return t(
        'Restore a tool call. This will reset the conversation and file history to the state it was in when the tool call was suggested',
      );
    },
    kind: CommandKind.BUILT_IN,
    supportedModes: ['interactive'] as const,
    action: restoreAction,
    completion,
  };
};
