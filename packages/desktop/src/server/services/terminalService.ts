/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DesktopHttpError } from '../http/errors.js';

const MAX_OUTPUT_LENGTH = 300_000;

export type DesktopTerminalStatus = 'running' | 'exited' | 'failed' | 'killed';

export interface DesktopTerminal {
  id: string;
  projectId: string;
  cwd: string;
  command: string;
  status: DesktopTerminalStatus;
  output: string;
  exitCode: number | null;
  signal: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TerminalRecord extends DesktopTerminal {
  child: ChildProcessWithoutNullStreams | null;
}

export class DesktopTerminalService {
  private readonly terminals = new Map<string, TerminalRecord>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  run(projectId: string, cwd: string, command: string): DesktopTerminal {
    const trimmedCommand = command.trim();
    if (!trimmedCommand) {
      throw new DesktopHttpError(
        400,
        'bad_request',
        'Terminal command must be a non-empty string.',
      );
    }

    const id = randomUUID();
    const timestamp = this.now().toISOString();
    const record: TerminalRecord = {
      id,
      projectId,
      cwd,
      command: trimmedCommand,
      status: 'running',
      output: '',
      exitCode: null,
      signal: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      child: null,
    };
    this.terminals.set(id, record);

    const child = spawn(getShellCommand(), getShellArgs(trimmedCommand), {
      cwd,
      env: process.env,
    });
    record.child = child;

    child.stdout.on('data', (chunk: Buffer) => {
      appendOutput(record, chunk.toString('utf8'), this.now);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      appendOutput(record, chunk.toString('utf8'), this.now);
    });
    child.on('error', (error) => {
      record.status = 'failed';
      record.exitCode = null;
      record.signal = null;
      appendOutput(record, `${error.message}\n`, this.now);
      record.child = null;
    });
    child.on('exit', (exitCode, signal) => {
      record.status = record.status === 'killed' ? 'killed' : 'exited';
      record.exitCode = exitCode;
      record.signal = signal;
      record.updatedAt = this.now().toISOString();
      record.child = null;
    });

    return toPublicTerminal(record);
  }

  get(terminalId: string): DesktopTerminal {
    return toPublicTerminal(this.getRecord(terminalId));
  }

  write(terminalId: string, input: string): DesktopTerminal {
    if (input.length === 0) {
      throw new DesktopHttpError(
        400,
        'bad_request',
        'Terminal input must be a non-empty string.',
      );
    }

    const record = this.getRecord(terminalId);
    if (record.status !== 'running' || !record.child) {
      throw new DesktopHttpError(
        409,
        'terminal_not_running',
        'Terminal session is not running.',
      );
    }

    const stdin = record.child.stdin;
    if (stdin.destroyed || stdin.writableEnded || !stdin.writable) {
      throw new DesktopHttpError(
        409,
        'terminal_not_running',
        'Terminal session is not accepting input.',
      );
    }

    try {
      stdin.write(input);
    } catch {
      throw new DesktopHttpError(
        409,
        'terminal_not_running',
        'Terminal session is not accepting input.',
      );
    }
    record.updatedAt = this.now().toISOString();

    return toPublicTerminal(record);
  }

  kill(terminalId: string): DesktopTerminal {
    const record = this.getRecord(terminalId);
    if (record.status === 'running' && record.child) {
      record.status = 'killed';
      record.updatedAt = this.now().toISOString();
      record.child.kill();
    }

    return toPublicTerminal(record);
  }

  close(): void {
    for (const record of this.terminals.values()) {
      if (record.status === 'running' && record.child) {
        record.status = 'killed';
        record.child.kill();
      }
    }
  }

  private getRecord(terminalId: string): TerminalRecord {
    const record = this.terminals.get(terminalId);
    if (!record) {
      throw new DesktopHttpError(
        404,
        'terminal_not_found',
        'Terminal session was not found.',
      );
    }

    return record;
  }
}

function appendOutput(
  record: TerminalRecord,
  text: string,
  now: () => Date,
): void {
  record.output = `${record.output}${text}`.slice(-MAX_OUTPUT_LENGTH);
  record.updatedAt = now().toISOString();
}

function toPublicTerminal(record: TerminalRecord): DesktopTerminal {
  return {
    id: record.id,
    projectId: record.projectId,
    cwd: record.cwd,
    command: record.command,
    status: record.status,
    output: record.output,
    exitCode: record.exitCode,
    signal: record.signal,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function getShellCommand(): string {
  if (process.platform === 'win32') {
    return process.env['COMSPEC'] || 'cmd.exe';
  }

  return process.env['SHELL'] || '/bin/sh';
}

function getShellArgs(command: string): string[] {
  if (process.platform === 'win32') {
    return ['/d', '/s', '/c', command];
  }

  return ['-lc', command];
}
