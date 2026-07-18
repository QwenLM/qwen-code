import type {
  DaemonObservedChannelContacts,
  DaemonScheduledTaskChannelTarget,
} from '@qwen-code/webui/daemon-react-sdk';

export type ScheduledTaskDeliveryTargetKind = 'direct' | 'group' | 'topic';

export interface ScheduledTaskDeliveryOption {
  kind: ScheduledTaskDeliveryTargetKind;
  label: string;
  description: string;
  inputValue: string;
  target: DaemonScheduledTaskChannelTarget;
}

export function deliveryTargetKey(
  target: DaemonScheduledTaskChannelTarget,
): string {
  return JSON.stringify([
    target.channelName,
    target.chatId,
    target.threadId ?? null,
    target.isGroup === true,
  ]);
}

export function deliveryTargetsEqual(
  left: DaemonScheduledTaskChannelTarget | undefined,
  right: DaemonScheduledTaskChannelTarget | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      deliveryTargetKey(left) === deliveryTargetKey(right))
  );
}

function option(
  kind: ScheduledTaskDeliveryTargetKind,
  label: string,
  description: string,
  target: DaemonScheduledTaskChannelTarget,
): ScheduledTaskDeliveryOption {
  const inputValue = `${kind} · ${label} · ${description}`;
  return {
    kind,
    label,
    description,
    inputValue,
    target,
  };
}

export function flattenScheduledTaskDeliveryTargets(
  contacts: DaemonObservedChannelContacts,
): ScheduledTaskDeliveryOption[] {
  const result: ScheduledTaskDeliveryOption[] = [];
  for (const user of contacts.users) {
    if (!user.chatId) continue;
    result.push(
      option('direct', user.label, `${user.channelName} · ${user.chatId}`, {
        channelName: user.channelName,
        chatId: user.chatId,
        isGroup: false,
      }),
    );
  }
  for (const group of contacts.groups) {
    result.push(
      option('group', group.label, `${group.channelName} · ${group.id}`, {
        channelName: group.channelName,
        chatId: group.id,
        isGroup: true,
      }),
    );
    for (const topic of group.topics) {
      result.push(
        option(
          'topic',
          `${group.label} / ${topic.label}`,
          `${group.channelName} · ${group.id} · ${topic.id}`,
          {
            channelName: group.channelName,
            chatId: group.id,
            threadId: topic.id,
            isGroup: true,
          },
        ),
      );
    }
  }
  return result;
}

export function resolveScheduledTaskDeliveryInput(
  rawInput: string,
  options: readonly ScheduledTaskDeliveryOption[],
): ScheduledTaskDeliveryOption | null {
  const input = rawInput.trim();
  if (!input) return null;
  const formatted = options.filter((item) => item.inputValue === input);
  if (formatted.length === 1) return formatted[0]!;
  const exactId = options.filter((item) =>
    item.kind === 'topic'
      ? item.target.threadId === input
      : item.target.chatId === input,
  );
  return exactId.length === 1 ? exactId[0]! : null;
}
