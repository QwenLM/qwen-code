import { nextFireTime, parseCron } from '@qwen-code/qwen-code-core';
import type {
  ChannelLoopController,
  ChannelLoopStore,
} from '@qwen-code/channel-base';

export function createChannelLoopController(
  store: ChannelLoopStore,
): ChannelLoopController {
  return {
    create: (input) => store.create(input),
    createForTarget: (input, maxEnabledLoops) =>
      store.createForTarget(input, maxEnabledLoops),
    listForTarget: (channelName, target) =>
      store.listForTarget(channelName, target),
    disable: (id) => store.disable(id),
    validateCron: (cron) => {
      parseCron(cron);
      nextFireTime(cron, new Date());
    },
    nextFireTime: (job) =>
      nextFireTime(job.cron, new Date(job.lastFiredAt ?? job.createdAt)),
  };
}

export function isChannelCronEnabled(settings: {
  merged: { experimental?: { cron?: boolean } };
}): boolean {
  if (process.env['QWEN_CODE_DISABLE_CRON'] === '1') return false;
  return settings.merged.experimental?.cron !== false;
}
