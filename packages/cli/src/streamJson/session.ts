/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import readline from 'node:readline';
import type { Config } from '@qwen-code/qwen-code-core';
import { logUserPrompt } from '@qwen-code/qwen-code-core';
import {
  parseStreamJsonEnvelope,
  type StreamJsonEnvelope,
  type StreamJsonUserEnvelope,
} from './types.js';
import { extractUserMessageText } from './io.js';
import { StreamJsonWriter } from './writer.js';
import { StreamJsonController } from './controller.js';
import { runNonInteractive } from '../nonInteractiveCli.js';
import type { LoadedSettings } from '../config/settings.js';

export interface StreamJsonSessionOptions {
  input?: NodeJS.ReadableStream;
  writer?: StreamJsonWriter;
}

interface PromptJob {
  prompt: string;
  envelope?: StreamJsonUserEnvelope;
}

export async function runStreamJsonSession(
  config: Config,
  settings: LoadedSettings,
  initialPrompt: string | undefined,
  options: StreamJsonSessionOptions = {},
): Promise<void> {
  const inputStream = options.input ?? process.stdin;
  const writer =
    options.writer ??
    new StreamJsonWriter(config, config.getIncludePartialMessages());

  const controller = new StreamJsonController(writer);
  const promptQueue: PromptJob[] = [];
  let activeRun: Promise<void> | null = null;

  const processQueue = async (): Promise<void> => {
    if (activeRun || promptQueue.length === 0) {
      return;
    }

    const job = promptQueue.shift();
    if (!job) {
      void processQueue();
      return;
    }

    const abortController = new AbortController();
    controller.setActiveRunAbortController(abortController);

    const runPromise = handleUserPrompt(
      config,
      settings,
      writer,
      controller,
      job,
      abortController,
    )
      .catch((error) => {
        console.error('Failed to handle stream-json prompt:', error);
      })
      .finally(() => {
        controller.setActiveRunAbortController(null);
      });

    activeRun = runPromise;
    try {
      await runPromise;
    } finally {
      activeRun = null;
      void processQueue();
    }
  };

  const enqueuePrompt = (job: PromptJob): void => {
    promptQueue.push(job);
    void processQueue();
  };

  if (initialPrompt && initialPrompt.trim().length > 0) {
    enqueuePrompt({ prompt: initialPrompt.trim() });
  }

  const rl = readline.createInterface({
    input: inputStream,
    crlfDelay: Number.POSITIVE_INFINITY,
    terminal: false,
  });

  try {
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      let envelope: StreamJsonEnvelope;
      try {
        envelope = parseStreamJsonEnvelope(line);
      } catch (error) {
        writer.emitResult({
          isError: true,
          numTurns: 0,
          errorMessage:
            error instanceof Error ? error.message : 'Failed to parse JSON',
        });
        continue;
      }

      switch (envelope.type) {
        case 'user':
          enqueuePrompt({
            prompt: extractUserMessageText(envelope).trim(),
            envelope,
          });
          break;
        case 'control_request':
          controller.handleIncomingControlRequest(config, envelope);
          break;
        case 'control_response':
          controller.handleControlResponse(envelope);
          break;
        case 'control_cancel_request':
          controller.handleControlCancel(envelope);
          break;
        default:
          writer.emitResult({
            isError: true,
            numTurns: 0,
            errorMessage: `Unsupported stream-json input type: ${envelope.type}`,
          });
      }
    }
  } finally {
    while (activeRun) {
      try {
        await activeRun;
      } catch {
        // 忽略已记录的运行错误。
      }
    }
    rl.close();
    controller.cancelPendingRequests('Session terminated');
  }
}

async function handleUserPrompt(
  config: Config,
  settings: LoadedSettings,
  writer: StreamJsonWriter,
  controller: StreamJsonController,
  job: PromptJob,
  abortController: AbortController,
): Promise<void> {
  const prompt = job.prompt ?? '';
  const messageRecord =
    job.envelope && typeof job.envelope.message === 'object'
      ? (job.envelope.message as Record<string, unknown>)
      : undefined;
  const envelopePromptId =
    messageRecord && typeof messageRecord['prompt_id'] === 'string'
      ? String(messageRecord['prompt_id']).trim()
      : undefined;
  const promptId = envelopePromptId ?? `stream-json-${Date.now()}`;

  if (prompt.length > 0) {
    const authType =
      typeof (
        config as {
          getContentGeneratorConfig?: () => { authType?: string };
        }
      ).getContentGeneratorConfig === 'function'
        ? (
            (
              config as {
                getContentGeneratorConfig: () => { authType?: string };
              }
            ).getContentGeneratorConfig() ?? {}
          ).authType
        : undefined;

    logUserPrompt(config, {
      'event.name': 'user_prompt',
      'event.timestamp': new Date().toISOString(),
      prompt,
      prompt_id: promptId,
      auth_type: authType,
      prompt_length: prompt.length,
    });
  }

  await runNonInteractive(config, settings, prompt, promptId, {
    abortController,
    streamJson: {
      writer,
      controller,
    },
    userEnvelope: job.envelope,
  });
}
