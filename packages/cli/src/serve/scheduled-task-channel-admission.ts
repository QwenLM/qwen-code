import type { ObservedChannelContactGraph } from '@qwen-code/channel-base';
import type { CronTaskChannelTarget } from '@qwen-code/qwen-code-core';
import { daemonObservedContactsPath } from '../commands/channel/runtime.js';
import { ObservedChannelContactStore } from '../commands/channel/observed-contact-store.js';
import type { AdmitScheduledTaskChannelTarget } from './routes/scheduled-tasks.js';

const DEFAULT_ADMISSION_FRESH_WITHIN_SECONDS = 7 * 24 * 60 * 60;

export function resolveObservedScheduledTaskChannelTarget(
  graph: ObservedChannelContactGraph,
  target: CronTaskChannelTarget,
): CronTaskChannelTarget | null {
  const group = graph.groups.find(
    (candidate) =>
      candidate.channelName === target.channelName &&
      candidate.id === target.chatId,
  );
  const groupTarget = (() => {
    if (!group) return null;
    if (target.threadId === undefined) {
      return {
        channelName: group.channelName,
        chatId: group.id,
        isGroup: true,
      } satisfies CronTaskChannelTarget;
    }
    const topic = group.topics.find(
      (candidate) => candidate.id === target.threadId,
    );
    if (!topic) return null;
    return {
      channelName: group.channelName,
      chatId: group.id,
      threadId: topic.id,
      isGroup: true,
    } satisfies CronTaskChannelTarget;
  })();

  const user =
    target.threadId === undefined
      ? graph.users.find(
          (candidate) =>
            candidate.channelName === target.channelName &&
            candidate.chatId === target.chatId,
        )
      : undefined;
  const userTarget = user?.chatId
    ? ({
        channelName: user.channelName,
        chatId: user.chatId,
        isGroup: false,
      } satisfies CronTaskChannelTarget)
    : null;

  if (target.isGroup === true) return groupTarget;
  if (target.isGroup === false) return userTarget;
  if (groupTarget && userTarget) return null;
  return groupTarget ?? userTarget;
}

export function createObservedContactScheduledTaskAdmission(): AdmitScheduledTaskChannelTarget {
  return ({ workspaceCwd, target }) => {
    const graph = new ObservedChannelContactStore(
      daemonObservedContactsPath(workspaceCwd),
    ).list({ freshWithinSeconds: DEFAULT_ADMISSION_FRESH_WITHIN_SECONDS });
    return Promise.resolve(
      resolveObservedScheduledTaskChannelTarget(graph, target),
    );
  };
}
