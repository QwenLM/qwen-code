/**
 * ScheduleDaemon: always-on execution host for /schedule tasks.
 *
 * Wraps a CronScheduler (session-only mode). On each fire:
 *  1. Spawns `qwen -p "<prompt>" --approval-mode ... --model ...` child process
 *  2. Writes a run record to the task's state.json
 *
 * No 7-day expiry (sets expiresAt: Infinity post-creation).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

import { CronScheduler, type CronJob } from './cronScheduler.js';
import {
  readScheduleTask,
  listScheduleTasks,
  writeScheduleRunRecord,
  updateScheduleTask,
  type ScheduleTask,
} from './schedule-task-store.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  ChannelRegistry,
  type TaskNotification,
  type ChannelConfig,
} from './channels/index.js';

const debugLogger = createDebugLogger('SCHEDULE_DAEMON');

const MAX_CONCURRENT_FIRES = 3;
const DEFAULT_MAX_WALL_TIME_SECONDS = 600;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DaemonRunState = 'starting' | 'running' | 'stopping' | 'stopped';

export interface ActiveFire {
  child: ChildProcess;
  taskId: string;
  jobId: string;
  startedAt: Date;
}

export interface DaemonStatus {
  state: DaemonRunState;
  taskCount: number;
  activeFires: Array<{ taskId: string; jobId: string; startedAt: string }>;
  lastFireTimes: Array<{ taskId: string; lastFiredAt: string }>;
}

export interface DaemonOptions {
  forceSandbox?: boolean;
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

function resolveQwenBinary(): string {
  if (process.argv[1]?.includes('cli-entry')) {
    return process.argv[1];
  }
  return 'qwen';
}

// ---------------------------------------------------------------------------
// ScheduleDaemon
// ---------------------------------------------------------------------------

export class ScheduleDaemon {
  private scheduler: CronScheduler;
  private state: DaemonRunState = 'stopped';
  private activeFires = new Map<string, ActiveFire>();
  private jobToTaskId = new Map<string, string>();
  private loadedTasks = new Map<string, ScheduleTask>();
  private forceSandbox: boolean;
  private channelRegistry: ChannelRegistry;
  private fireAtTimers = new Map<string, NodeJS.Timeout>();

  constructor(options: DaemonOptions = {}) {
    this.scheduler = new CronScheduler(null);
    this.forceSandbox = options.forceSandbox ?? false;
    this.channelRegistry = new ChannelRegistry();
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.state === 'running') return;
    this.state = 'starting';

    const tasks = await listScheduleTasks();
    for (const task of tasks) {
      if (!task.definition.schedule.enabled) continue;
      this.registerTask(task);
    }

    this.scheduler.start((job) => {
      void this.onFire(job);
    });

    this.state = 'running';
    debugLogger.info(
      `ScheduleDaemon started with ${this.loadedTasks.size} task(s)${this.forceSandbox ? ' (forced sandbox)' : ''}`,
    );
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'stopping') return;
    this.state = 'stopping';

    this.scheduler.stop();

    // Clear all pending fireAt timers
    for (const timer of this.fireAtTimers.values()) {
      clearTimeout(timer);
    }
    this.fireAtTimers.clear();

    const promises = [...this.activeFires.values()].map(async (fire) => {
      if (fire.child.exitCode === null) {
        fire.child.kill('SIGTERM');
        try {
          await once(fire.child, 'exit', {
            signal: AbortSignal.timeout(5_000),
          });
        } catch {
          fire.child.kill('SIGKILL');
        }
      }
    });
    await Promise.allSettled(promises);

    this.activeFires.clear();
    this.jobToTaskId.clear();
    this.loadedTasks.clear();
    this.state = 'stopped';
  }

  getStatus(): DaemonStatus {
    const lastFireTimes: DaemonStatus['lastFireTimes'] = [];
    for (const [, task] of this.loadedTasks) {
      if (task.state.lastFiredAt) {
        lastFireTimes.push({
          taskId: task.definition.taskId,
          lastFiredAt: task.state.lastFiredAt,
        });
      }
    }

    return {
      state: this.state,
      taskCount: this.loadedTasks.size,
      activeFires: [...this.activeFires.values()].map((f) => ({
        taskId: f.taskId,
        jobId: f.jobId,
        startedAt: f.startedAt.toISOString(),
      })),
      lastFireTimes,
    };
  }

  // -----------------------------------------------------------------------
  // Task management
  // -----------------------------------------------------------------------

  loadTask(taskId: string): void {
    if (this.loadedTasks.has(taskId)) return;
    void readScheduleTask(taskId).then((task) => {
      if (task && task.definition.schedule.enabled) {
        this.registerTask(task);
      }
    });
  }

  unloadTask(taskId: string): void {
    const loaded = this.loadedTasks.get(taskId);
    if (!loaded) return;

    for (const [jobId, tid] of this.jobToTaskId) {
      if (tid === taskId) {
        void this.scheduler.delete(jobId);
        this.jobToTaskId.delete(jobId);
      }
    }
    this.loadedTasks.delete(taskId);
  }

  reloadTask(taskId: string): void {
    this.unloadTask(taskId);
    void readScheduleTask(taskId).then((task) => {
      if (task && task.definition.schedule.enabled) {
        this.registerTask(task);
      }
    });
  }

  get isRunning(): boolean {
    return this.state === 'running';
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private registerTask(task: ScheduleTask): void {
    const { definition } = task;

    // Handle fireAt (one-shot) tasks
    if (definition.schedule.fireAt) {
      const fireAtDate = new Date(definition.schedule.fireAt);
      const now = new Date();

      // If fireAt is in the past, skip registration
      if (fireAtDate <= now) {
        debugLogger.info(
          `ScheduleDaemon: skipping past fireAt task ${definition.taskId} (${definition.name})`,
        );
        return;
      }

      // Calculate delay in milliseconds
      const delayMs = fireAtDate.getTime() - now.getTime();

      // Schedule a one-shot timeout
      const timerId = setTimeout(() => {
        void this.fireTask(task, 'fireAt');
      }, delayMs);
      this.fireAtTimers.set(definition.taskId, timerId);

      this.loadedTasks.set(definition.taskId, task);
      debugLogger.info(
        `ScheduleDaemon: registered fireAt task ${definition.taskId} (${definition.name}) for ${definition.schedule.fireAt}`,
      );
      return;
    }

    // Handle cron tasks
    if (definition.schedule.cron) {
      const job = this.scheduler.create(
        definition.schedule.cron,
        definition.prompt,
        true,
      );
      job.expiresAt = Infinity;

      this.jobToTaskId.set(job.id, definition.taskId);
      this.loadedTasks.set(definition.taskId, task);
    }
  }

  private async onFire(job: CronJob): Promise<void> {
    const taskId = this.jobToTaskId.get(job.id);
    if (!taskId) return;

    const task = this.loadedTasks.get(taskId);
    if (!task) return;

    await this.fireTask(task, 'cron', job.id);
  }

  private async fireTask(
    task: ScheduleTask,
    trigger: 'cron' | 'fireAt',
    jobId?: string,
  ): Promise<void> {
    const { definition } = task;

    if (this.activeFires.size >= MAX_CONCURRENT_FIRES) {
      debugLogger.warn(
        `ScheduleDaemon: max concurrent fires (${MAX_CONCURRENT_FIRES}) reached, ` +
          `skipping fire for task ${definition.taskId}`,
      );
      return;
    }

    // Apply forced sandbox if enabled
    let approvalMode = definition.approvalMode;
    if (this.forceSandbox) {
      // Downgrade privileged modes to safer alternatives
      if (approvalMode === 'auto' || approvalMode === 'yolo') {
        approvalMode = 'default';
        debugLogger.warn(
          `ScheduleDaemon: forced sandbox mode, downgrading approval from ${definition.approvalMode} to ${approvalMode} for task ${definition.taskId}`,
        );
      }
    }

    const args = [
      '-p',
      definition.prompt,
      '--approval-mode',
      approvalMode,
      '--output-format',
      'stream-json',
      '--max-wall-time',
      String(DEFAULT_MAX_WALL_TIME_SECONDS),
    ];
    if (definition.model) {
      args.push('--model', definition.model);
    }
    if (this.forceSandbox || definition.sandbox) {
      args.push('--sandbox');
    }

    debugLogger.info(
      `ScheduleDaemon: firing task ${definition.taskId} (${definition.name}) via ${trigger}`,
    );

    const startedAt = new Date();
    const child = spawn(resolveQwenBinary(), args, {
      cwd: definition.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      shell: false,
    });

    const fireId = jobId || `fireAt-${definition.taskId}-${Date.now()}`;
    const fire: ActiveFire = {
      child,
      taskId: definition.taskId,
      jobId: fireId,
      startedAt,
    };
    this.activeFires.set(fireId, fire);

    child.on('error', (err) => {
      debugLogger.error(
        `ScheduleDaemon: failed to spawn task ${definition.taskId}: ${err.message}`,
      );
      this.activeFires.delete(fireId);
    });

    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
      if (stdout.length > 500) {
        stdout = stdout.slice(0, 500);
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    try {
      const [exitCode] = (await once(child, 'exit')) as [number | null];
      const endedAt = new Date();

      await writeScheduleRunRecord(definition.taskId, {
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        exitCode,
        outputSummary: stdout.slice(0, 500).trim(),
      });

      // If this was a fireAt task, disable it after execution
      if (trigger === 'fireAt') {
        await updateScheduleTask(definition.taskId, { enabled: false });
        debugLogger.info(
          `ScheduleDaemon: fireAt task ${definition.taskId} completed and disabled`,
        );
      }

      // Send channel notifications
      await this.sendNotification(definition, {
        taskId: definition.taskId,
        taskName: definition.name,
        status: exitCode === 0 ? 'success' : 'failure',
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        exitCode,
        outputSummary: stdout.slice(0, 500).trim(),
        error: exitCode !== 0 ? `Exit code: ${exitCode}` : undefined,
      });
    } catch (err) {
      debugLogger.warn(
        `ScheduleDaemon: error waiting for task ${definition.taskId}: ${err}`,
      );
    } finally {
      this.activeFires.delete(fireId);
    }
  }

  // -----------------------------------------------------------------------
  // Channel notifications
  // -----------------------------------------------------------------------

  private async sendNotification(
    definition: ScheduleTask['definition'],
    notification: TaskNotification,
  ): Promise<void> {
    // Register channels from task definition if any
    const channels = (definition as unknown as Record<string, unknown>)[
      'channels'
    ] as ChannelConfig[] | undefined;

    if (channels && channels.length > 0) {
      const registry = new ChannelRegistry();
      const channelInstances = ChannelRegistry.createChannels(channels);
      for (const ch of channelInstances) {
        registry.register(ch);
      }
      await registry.sendToAll(notification);
    }
  }

  /**
   * Register channels for this daemon instance (used by CLI).
   */
  registerChannels(configs: ChannelConfig[]): void {
    for (const config of configs) {
      const channel = ChannelRegistry.createChannel(config);
      this.channelRegistry.register(channel);
    }
  }
}
