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

export async function executeUserShell(
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
    // A command ending in an odd run of backslashes leaves a dangling line
    // continuation; the `;` appended below would be escaped into a literal
    // argument (`ls \` would run `ls ';'`). Close the continuation first so
    // the terminator ends the user's own command (R6-8).
    const trailingBackslashes = /\\+$/.exec(command)?.[0].length ?? 0;
    if (trailingBackslashes % 2 === 1) {
      command += '\n';
    }
    if (!command.endsWith(';') && !command.endsWith('&')) {
      command += ';';
    }
    // The brace group closes on its own line: a one-line `{ ... #comment; };`
    // lets a trailing comment swallow the wrapper tail and the shell dies on
    // a syntax error before the user's command runs at all.
    commandToExecute = `{ ${command}\n}; __code=$?; pwd > "${pwdFilePath}"; exit $__code`;
  }

  const usePty = config.getShouldUseNodePtyShell();
  // A command can outlive the chat it started in: /clear swaps the chat
  // while the client object survives, so a late history write would inject
  // the previous session's output into the fresh chat. Identify the chat at
  // start and skip the write when it is no longer current. `getChat()`
  // throws while the client is uninitialized (boot timing, U-31), so both
  // identity reads are guarded — the command itself never needs a chat.
  // Undefined never matches a live chat (R1-43), so an uninitialized start
  // skips the write even if the chat arrives mid-run.
  const client = config.getGeminiClient();
  const chatAtStart = client.isInitialized() ? client.getChat() : undefined;
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
        let summary: 'ok' | 'error' | 'cancelled' = 'ok';
        let prefixText = '';
        if (res.error) {
          success = false;
          summary = 'error';
          prefixText = `${res.error.message}\n`;
        } else if (res.aborted) {
          success = false;
          // Ink's processor sets Canceled for a user-cancelled `!` command;
          // 'error' would paint the red ERROR glyph for an Esc the user
          // chose (and disagree with /resume replay's 'cancelled').
          summary = 'cancelled';
          prefixText = 'Command was cancelled.\n';
        } else if (isSignalTermination(res.signal)) {
          success = false;
          summary = 'error';
          prefixText = `Command terminated by signal: ${res.signal}.\n`;
        } else if (res.exitCode !== 0) {
          success = false;
          summary = 'error';
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
        // When the output was already streamed as deltas, the card's last
        // line is on screen and `tail` is empty — the status prefix must
        // start its own row instead of gluing onto it.
        const finalOutput = tail
          ? `${prefixText}${tail}`
          : prefixText
            ? `\n${prefixText}`
            : '';

        emit({ type: 'tool-result', id: callId, display: finalOutput });
        emit({
          type: 'tool-end',
          id: callId,
          success,
          summary,
        });
        if (client.isInitialized() && client.getChat() === chatAtStart) {
          addShellCommandToLlmHistory(
            config.getGeminiClient(),
            rawQuery,
            `${prefixText}${mainContent}`,
          );
        }
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
