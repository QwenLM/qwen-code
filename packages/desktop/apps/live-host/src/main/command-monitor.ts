import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { app } from 'electron';
import type { PermissionState } from '../shared/protocol.ts';
import { BoundedReconnectPolicy } from './reconnect-policy.ts';

const MAX_HELPER_LINE_BYTES = 4 * 1024;
const MAX_HELPER_BUFFER_BYTES = 8 * 1024;

type CommandMonitorState = {
  permission: PermissionState;
  healthy: boolean;
  error?: string;
};

type HelperMessage =
  | { type: 'permission'; inputMonitoring: boolean }
  | { type: 'ready'; pid: number }
  | { type: 'toggle'; monotonicMs: number }
  | { type: 'error'; code: string };

function parseHelperMessage(line: string): HelperMessage | undefined {
  if (Buffer.byteLength(line, 'utf8') > MAX_HELPER_LINE_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.type === 'permission' &&
    typeof record.inputMonitoring === 'boolean'
  ) {
    return { type: 'permission', inputMonitoring: record.inputMonitoring };
  }
  if (record.type === 'ready' && Number.isSafeInteger(record.pid)) {
    return { type: 'ready', pid: Number(record.pid) };
  }
  if (record.type === 'toggle' && Number.isFinite(record.monotonicMs)) {
    return { type: 'toggle', monotonicMs: Number(record.monotonicMs) };
  }
  if (
    record.type === 'error' &&
    typeof record.code === 'string' &&
    record.code.length <= 128
  ) {
    return { type: 'error', code: record.code };
  }
  return undefined;
}

export class CommandMonitor {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = Buffer.alloc(0);
  private intentionalStop = false;
  private restartTimer: NodeJS.Timeout | undefined;
  private readonly restartPolicy = new BoundedReconnectPolicy([
    250, 500, 1_000, 2_000, 5_000,
  ]);
  private state: CommandMonitorState = {
    permission: 'not_determined',
    healthy: false,
  };

  constructor(
    private readonly onToggle: () => void,
    private readonly onState: (state: CommandMonitorState) => void,
  ) {}

  start(requestAccess = false): void {
    if (process.platform !== 'darwin' || this.child) return;
    this.intentionalStop = false;
    this.buffer = Buffer.alloc(0);
    const executable = app.isPackaged
      ? join(process.resourcesPath, 'native', 'qwen-live-command-monitor')
      : join(app.getAppPath(), 'dist', 'native', 'qwen-live-command-monitor');
    const args = requestAccess ? ['--request-access'] : [];
    const child = spawn(executable, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    child.stdout.on('data', (chunk: Buffer) => {
      if (child !== this.child) return;
      this.consumeStdout(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (child !== this.child) return;
      if (chunk.byteLength > MAX_HELPER_BUFFER_BYTES) {
        this.failHelper('helper_stderr_overflow');
      }
    });
    child.on('error', () => this.failHelper('helper_launch'));
    child.on('close', (code) => {
      if (child !== this.child) return;
      this.child = undefined;
      this.update({ ...this.state, healthy: false });
      if (
        this.intentionalStop ||
        code === 3 ||
        this.state.permission === 'denied'
      )
        return;
      this.scheduleRestart();
    });
  }

  stop(): void {
    this.intentionalStop = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.child?.kill('SIGTERM');
    this.child = undefined;
    this.update({ ...this.state, healthy: false });
  }

  requestAccess(): void {
    this.stop();
    this.intentionalStop = false;
    this.restartPolicy.reset();
    this.start(true);
  }

  private consumeStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.byteLength > MAX_HELPER_BUFFER_BYTES) {
      this.failHelper('helper_stdout_overflow');
      return;
    }

    let newline = this.buffer.indexOf(0x0a);
    while (newline >= 0) {
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.byteLength > MAX_HELPER_LINE_BYTES) {
        this.failHelper('helper_line_overflow');
        return;
      }
      this.handleMessage(parseHelperMessage(line.toString('utf8')));
      newline = this.buffer.indexOf(0x0a);
    }
  }

  private handleMessage(message: HelperMessage | undefined): void {
    if (!message) {
      this.failHelper('helper_protocol');
      return;
    }
    switch (message.type) {
      case 'permission':
        this.update({
          permission: message.inputMonitoring ? 'granted' : 'denied',
          healthy: message.inputMonitoring && this.state.healthy,
        });
        break;
      case 'ready':
        this.restartPolicy.reset();
        this.update({ permission: 'granted', healthy: true });
        break;
      case 'toggle':
        if (this.state.healthy) this.onToggle();
        break;
      case 'error':
        this.update({ ...this.state, healthy: false, error: message.code });
        break;
    }
  }

  private failHelper(error: string): void {
    this.update({ ...this.state, healthy: false, error });
    this.child?.kill('SIGTERM');
  }

  private scheduleRestart(): void {
    if (this.restartTimer) return;
    const delay = this.restartPolicy.nextDelayMs();
    if (delay === undefined) {
      this.update({ ...this.state, error: 'helper_restart_exhausted' });
      return;
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.start();
    }, delay);
    this.restartTimer.unref();
  }

  private update(state: CommandMonitorState): void {
    this.state = state;
    this.onState(state);
  }
}
