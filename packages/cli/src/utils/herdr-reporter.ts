/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';

const AGENT = 'qwen';
const LIFECYCLE_SOURCE = 'qwen-code:tui';
const SESSION_SOURCE = 'herdr:qwen';
const COMMAND_TIMEOUT_MS = 500;

export type HerdrAgentState = 'blocked' | 'idle' | 'working';

type Report = {
  sessionId: string;
  state: HerdrAgentState;
};

type RunCommand = (args: readonly string[]) => Promise<void>;

export class HerdrReporter {
  private pending: Report | undefined;
  private drainPromise: Promise<void> | undefined;
  private releasePromise: Promise<void> | undefined;
  private lastSessionId: string | undefined;
  private lastState: HerdrAgentState | undefined;
  private sequence = Date.now() * 1000;
  private closed = false;

  constructor(
    private readonly paneId: string,
    private readonly runCommand: RunCommand,
  ) {}

  report(sessionId: string, state: HerdrAgentState): void {
    if (
      this.closed ||
      !sessionId ||
      (this.pending?.sessionId === sessionId && this.pending.state === state) ||
      (!this.pending &&
        this.lastSessionId === sessionId &&
        this.lastState === state)
    ) {
      return;
    }

    this.pending = { sessionId, state };
    this.startDrain();
  }

  release(): Promise<void> {
    if (!this.releasePromise) {
      this.closed = true;
      this.pending = undefined;
      this.releasePromise = (async () => {
        await this.drainPromise;
        await this.run([
          'pane',
          'release-agent',
          this.paneId,
          '--source',
          LIFECYCLE_SOURCE,
          '--agent',
          AGENT,
          '--seq',
          this.nextSequence(),
        ]);
      })();
    }
    return this.releasePromise;
  }

  private startDrain(): void {
    if (this.drainPromise) return;
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = undefined;
      if (this.pending && !this.closed) this.startDrain();
    });
  }

  private async drain(): Promise<void> {
    while (this.pending && !this.closed) {
      const report = this.pending;
      this.pending = undefined;

      if (report.sessionId !== this.lastSessionId) {
        if (
          !(await this.run([
            'pane',
            'report-agent-session',
            this.paneId,
            '--source',
            SESSION_SOURCE,
            '--agent',
            AGENT,
            '--agent-session-id',
            report.sessionId,
            '--session-start-source',
            this.lastSessionId ? 'clear' : 'startup',
          ]))
        ) {
          continue;
        }
        this.lastSessionId = report.sessionId;
      }

      if (this.pending || this.closed) continue;
      if (report.state !== this.lastState) {
        if (
          await this.run([
            'pane',
            'report-agent',
            this.paneId,
            '--source',
            LIFECYCLE_SOURCE,
            '--agent',
            AGENT,
            '--state',
            report.state,
            '--seq',
            this.nextSequence(),
          ])
        ) {
          this.lastState = report.state;
        }
      }
    }
  }

  private nextSequence(): string {
    return String(++this.sequence);
  }

  private async run(args: readonly string[]): Promise<boolean> {
    try {
      await this.runCommand(args);
      return true;
    } catch {
      // ignored: Herdr reporting must never affect the TUI.
      return false;
    }
  }
}

export function createHerdrReporter(
  env: NodeJS.ProcessEnv = process.env,
  runCommand?: RunCommand,
): HerdrReporter | null {
  const paneId = env['HERDR_PANE_ID'];
  const binary = env['HERDR_BIN_PATH'];
  if (
    env['HERDR_ENV'] !== '1' ||
    !paneId ||
    !binary ||
    !env['HERDR_SOCKET_PATH']
  ) {
    return null;
  }

  return new HerdrReporter(
    paneId,
    runCommand ?? ((args) => spawnCommand(binary, args)),
  );
}

function spawnCommand(binary: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(binary, args, {
        stdio: 'ignore',
        timeout: COMMAND_TIMEOUT_MS,
        windowsHide: true,
      });
      child.once('error', reject);
      child.once('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`Herdr exited ${code}`)),
      );
    } catch (error) {
      reject(error);
    }
  });
}
