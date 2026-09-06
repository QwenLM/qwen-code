/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * U-33: user-invoked shell execution for the OpenTUI `!` shell mode. Runs
 * the command directly through core's ShellExecutionService — no model turn
 * and no approval dialog (ink shellCommandProcessor parity: typing the
 * command IS the consent) — and reports through the stream events the
 * transcript already folds: a `user-shell` command row plus a synthetic
 * run_shell_command tool card carrying the output. The command+result is
 * injected into the LLM history so the model sees what was run (shared with
 * ink's processor, which owns that copy).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isBinary,
  isSignalTermination,
  ShellExecutionService,
  type Config,
  type ShellOutputEvent,
} from '@qwen-code/qwen-code-core';
import { addShellCommandToLlmHistory } from '../hooks/shellCommandProcessor.js';
import type { OpenTuiStreamEvent } from './event-adapter.js';

const OUTPUT_UPDATE_INTERVAL_MS = 1000;

export function executeUserShell(
  config: Config,
  rawQuery: string,
  emit: (event: OpenTuiStreamEvent) => void,
  signal: AbortSignal,
  terminalSize: { width: number; height: number },
): Promise<void> {
  const callId = `shell-${crypto.randomUUID()}`;
  emit({ type: 'user-shell', text: rawQuery });
  emit({
    type: 'tool-start',
    id: callId,
    tool: 'run_shell_command',
    title: 'run_shell_command',
  });
  emit({ type: 'tool-description', id: callId, description: rawQuery });

  const targetDir = config.getTargetDir();
  let commandToExecute = rawQuery;
  let pwdFilePath: string | undefined;

  if (os.platform() !== 'win32') {
    // Capture the child's final working directory so a `cd` can be warned
    // about (shell mode is stateless) — lifted from ink's processor.
    let command = rawQuery.trim();
    const pwdFileName = `shell_pwd_${crypto.randomBytes(6).toString('hex')}.tmp`;
    pwdFilePath = path.join(os.tmpdir(), pwdFileName);
    if (!command.endsWith(';') && !command.endsWith('&')) {
      command += ';';
    }
    commandToExecute = `{ ${command} }; __code=$?; pwd > "${pwdFilePath}"; exit $__code`;
  }

  const usePty = config.getShouldUseNodePtyShell();
  let cumulative = '';
  let emittedText = '';
  let isBinaryStream = false;
  let lastUpdate = Date.now();

  const onOutputEvent = (event: ShellOutputEvent): void => {
    switch (event.type) {
      case 'data':
        // A pty delivers full screen states and a binary stream delivers
        // bytes — neither replays as append deltas, so only child-process
        // text accumulates; everything else lands once at completion.
        if (!isBinaryStream && !usePty && typeof event.chunk === 'string') {
          cumulative += event.chunk;
        }
        break;
      case 'binary_detected':
      case 'binary_progress':
        isBinaryStream = true;
        break;
      default: {
        throw new Error('An unhandled ShellOutputEvent was found.');
      }
    }
    if (
      !usePty &&
      !isBinaryStream &&
      Date.now() - lastUpdate > OUTPUT_UPDATE_INTERVAL_MS &&
      cumulative.length > emittedText.length
    ) {
      const delta = cumulative.slice(emittedText.length);
      emittedText += delta;
      emit({ type: 'tool-output', id: callId, delta });
      lastUpdate = Date.now();
    }
  };

  const cleanup = () => {
    if (pwdFilePath && fs.existsSync(pwdFilePath)) {
      fs.unlinkSync(pwdFilePath);
    }
  };

  return ShellExecutionService.execute(
    commandToExecute,
    targetDir,
    onOutputEvent,
    signal,
    usePty,
    {
      ...config.getShellExecutionConfig(),
      terminalWidth: terminalSize.width,
      terminalHeight: terminalSize.height,
    },
  )
    .then(({ result }) =>
      result.then((res) => {
        let success = true;
        let prefixText = '';
        if (res.error) {
          success = false;
          prefixText = `${res.error.message}\n`;
        } else if (res.aborted) {
          success = false;
          prefixText = 'Command was cancelled.\n';
        } else if (isSignalTermination(res.signal)) {
          success = false;
          prefixText = `Command terminated by signal: ${res.signal}.\n`;
        } else if (res.exitCode !== 0) {
          success = false;
          prefixText = `Command exited with code ${res.exitCode}.\n`;
        }

        if (pwdFilePath && fs.existsSync(pwdFilePath)) {
          const finalPwd = fs.readFileSync(pwdFilePath, 'utf8').trim();
          if (finalPwd && finalPwd !== targetDir) {
            prefixText = `WARNING: shell mode is stateless; the directory change to '${finalPwd}' will not persist.\n\n${prefixText}`;
          }
        }

        const mainContent = isBinary(res.rawOutput)
          ? '[Command produced binary output, which is not shown.]'
          : res.output.trim() || '(Command produced no output)';

        // The streamed head is already on the card; the result event
        // appends only what was not emitted yet (plus status prefixes).
        // The stream tail usually carries the final newline the trimmed
        // result drops, so compare against the trimmed emission.
        const emittedTrimmed = emittedText.trimEnd();
        const tail =
          emittedTrimmed && mainContent.startsWith(emittedTrimmed)
            ? mainContent.slice(emittedTrimmed.length)
            : mainContent;
        const finalOutput = `${prefixText}${tail}`;

        emit({ type: 'tool-result', id: callId, display: finalOutput });
        emit({
          type: 'tool-end',
          id: callId,
          success,
          summary: success ? 'ok' : 'error',
        });
        addShellCommandToLlmHistory(
          config.getGeminiClient(),
          rawQuery,
          `${prefixText}${mainContent}`,
        );
      }),
    )
    .catch((err: unknown) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      emit({
        type: 'error',
        text: `An unexpected error occurred: ${errorMessage}`,
      });
      emit({
        type: 'tool-end',
        id: callId,
        success: false,
        summary: 'error',
      });
    })
    .finally(cleanup);
}
