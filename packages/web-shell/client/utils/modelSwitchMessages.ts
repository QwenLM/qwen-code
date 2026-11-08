import type { Message, SystemMessage } from '../adapters/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseModelSwitchStatusModel(content: string): string | null {
  const prefix = 'Model switched: ';
  if (!content.startsWith(prefix)) return null;
  const rawModel = content.slice(prefix.length).trim();
  return rawModel.replace(/\([^()]+\)$/, '');
}

export function isModelSwitchSummaryMessage(
  message: Message,
): message is SystemMessage {
  return (
    message.role === 'system' &&
    message.variant === 'info' &&
    message.source === 'model_switch_summary'
  );
}

function getModelSwitchSummaryMessageModel(message: Message): string | null {
  if (!isModelSwitchSummaryMessage(message) || !isRecord(message.data)) {
    return null;
  }
  const modelId = message.data['modelId'];
  return typeof modelId === 'string' && modelId ? modelId : null;
}

function filterDuplicateModelSwitchMessages(
  messages: readonly Message[],
): Message[] {
  const summarizedModels = new Set<string>();
  for (const message of messages) {
    if (!isModelSwitchSummaryMessage(message)) continue;
    const model = getModelSwitchSummaryMessageModel(message);
    if (model) summarizedModels.add(model);
  }
  if (summarizedModels.size === 0) return [...messages];
  return messages.filter((message) => {
    if (message.role !== 'system' || message.variant !== 'info') return true;
    const statusModel = parseModelSwitchStatusModel(message.content);
    return !statusModel || !summarizedModels.has(statusModel);
  });
}

function isModelSwitchMessage(message: Message): boolean {
  if (message.role !== 'system' || message.variant !== 'info') return false;
  return (
    parseModelSwitchStatusModel(message.content) !== null ||
    isModelSwitchSummaryMessage(message)
  );
}

function filterLeadingModelSwitchMessages(
  messages: readonly Message[],
): Message[] {
  const firstContentIndex = messages.findIndex(
    (message) => !isModelSwitchMessage(message),
  );
  return firstContentIndex < 0 ? [] : messages.slice(firstContentIndex);
}

export function filterModelSwitchMessages(
  messages: readonly Message[],
): Message[] {
  return filterLeadingModelSwitchMessages(
    filterDuplicateModelSwitchMessages(messages),
  );
}
