import type {
  ChannelLoop,
  ChannelLoopController,
  SessionTarget,
} from '@qwen-code/channel-base';
import {
  generateCronTaskId,
  MAX_JOBS,
  nextDurableFireMs,
  nextFireTime,
  parseCron,
  readCronTasks,
  updateCronTasks,
  type DurableCronTask,
} from '@qwen-code/qwen-code-core';

export interface DurableChannelLoopControllerOptions {
  workspaceCwd: string;
  now?: () => Date;
  idFactory?: () => string;
}

function sameTarget(
  task: DurableCronTask,
  channelName: string,
  target: SessionTarget,
): boolean {
  const deliveryTarget = task.delivery?.target;
  return (
    task.delivery?.kind === 'channel' &&
    task.channelLoop !== undefined &&
    target.threadId === undefined &&
    task.delivery.channelName === channelName &&
    deliveryTarget?.type === (target.isGroup === true ? 'chat' : 'user') &&
    deliveryTarget.id === target.chatId &&
    task.channelLoop.senderId === target.senderId
  );
}

function taskToLoop(task: DurableCronTask): ChannelLoop {
  const delivery = task.delivery!;
  const target = delivery.target;
  const lastRun = task.runs?.at(-1);
  return {
    id: task.id,
    channelName: delivery.channelName,
    target: {
      channelName: delivery.channelName,
      senderId: task.channelLoop!.senderId,
      chatId: target.id,
      isGroup: target.type === 'chat',
    },
    cwd: '',
    cron: task.cron,
    prompt: task.prompt,
    ...(task.channelLoop!.label !== undefined
      ? { label: task.channelLoop!.label }
      : {}),
    recurring: task.recurring,
    enabled: task.enabled !== false,
    createdBy: task.channelLoop!.createdBy,
    createdAt: new Date(task.createdAt).toISOString(),
    ...(lastRun ? { lastFiredAt: new Date(lastRun.at).toISOString() } : {}),
    consecutiveFailures: 0,
    runCount: task.runs?.length ?? 0,
  };
}

export function createDurableChannelLoopController(
  options: DurableChannelLoopControllerOptions,
): ChannelLoopController {
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? generateCronTaskId;

  return {
    async create() {
      throw new Error('Durable channel loops require session-bound creation.');
    },

    async createForSession(input, maxEnabledLoops, sessionId) {
      if (input.target.threadId !== undefined) {
        throw new Error(
          'Durable channel loops do not support threaded targets.',
        );
      }
      let created: DurableCronTask | undefined;
      await updateCronTasks(options.workspaceCwd, (tasks) => {
        const enabledForTarget = tasks.filter(
          (task) =>
            task.enabled !== false &&
            sameTarget(task, input.channelName, input.target),
        ).length;
        if (enabledForTarget >= maxEnabledLoops) return tasks;
        if (tasks.length >= MAX_JOBS) {
          throw new Error(
            `Maximum number of cron jobs (${MAX_JOBS}) reached. Delete some jobs first.`,
          );
        }

        const existingIds = new Set(tasks.map((task) => task.id));
        let id = idFactory();
        while (existingIds.has(id)) id = idFactory();
        const createdAt = now().getTime();
        created = {
          id,
          cron: input.cron,
          prompt: input.prompt,
          recurring: input.recurring,
          createdAt,
          lastFiredAt: createdAt - (createdAt % 60_000),
          enabled: true,
          ...(input.label !== undefined ? { name: input.label } : {}),
          sessionId,
          sessionOwnership: 'shared',
          delivery: {
            kind: 'channel',
            channelName: input.channelName,
            target: {
              type: input.target.isGroup === true ? 'chat' : 'user',
              id: input.target.chatId,
            },
          },
          channelLoop: {
            senderId: input.target.senderId,
            createdBy: input.createdBy,
            ...(input.label !== undefined ? { label: input.label } : {}),
          },
        };
        return [...tasks, created];
      });
      return created ? { ...taskToLoop(created), cwd: input.cwd } : undefined;
    },

    async listForTarget(channelName, target) {
      return (await readCronTasks(options.workspaceCwd))
        .filter((task) => sameTarget(task, channelName, target))
        .map((task) => ({ ...taskToLoop(task), cwd: options.workspaceCwd }));
    },

    async disable(id) {
      let found = false;
      await updateCronTasks(options.workspaceCwd, (tasks) => {
        const next = tasks.map((task) => {
          if (task.id !== id || !task.channelLoop || !task.delivery)
            return task;
          found = true;
          return { ...task, enabled: false };
        });
        return found ? next : tasks;
      });
      return found;
    },

    validateCron(cron) {
      parseCron(cron);
      nextFireTime(cron, new Date());
    },

    nextFireTime(job) {
      const createdAt = new Date(job.createdAt).getTime();
      const fireAt = nextDurableFireMs({
        id: job.id,
        cron: job.cron,
        recurring: job.recurring,
        createdAt,
        lastFiredAt: job.lastFiredAt
          ? new Date(job.lastFiredAt).getTime()
          : createdAt - (createdAt % 60_000),
      });
      if (fireAt === null) throw new Error('Cron expression has no next run.');
      return new Date(fireAt);
    },
  };
}
