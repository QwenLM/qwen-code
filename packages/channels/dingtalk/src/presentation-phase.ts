import type { ChannelTaskLifecycleEvent } from '@qwen-code/channel-base';

export type DingtalkPresentationPhase =
  | 'thinking'
  | 'reading'
  | 'searching'
  | 'running'
  | 'editing'
  | 'working'
  | 'retrying'
  | 'replying';

export const DINGTALK_PRESENTATION_PHASE_LABELS: Record<
  DingtalkPresentationPhase,
  string
> = {
  thinking: '🤔 Thinking',
  reading: '📖 Reading',
  searching: '🔎 Searching',
  running: '🖥️ Running',
  editing: '🛠️ Editing',
  working: '🛠️ Working',
  retrying: '⚠️ Retrying',
  replying: '✍️ Replying',
};

export function lifecyclePresentationPhase(
  event: ChannelTaskLifecycleEvent,
): DingtalkPresentationPhase | undefined {
  if (event.type === 'text_chunk') return 'replying';
  if (event.type !== 'tool_call') return undefined;
  if (/fail|error/iu.test(event.toolCall.status)) return 'retrying';
  if (/complete|success/iu.test(event.toolCall.status)) return 'thinking';
  if (/read/iu.test(event.toolCall.kind)) return 'reading';
  if (/search|browser|web/iu.test(event.toolCall.kind)) return 'searching';
  if (/shell|exec|command|run/iu.test(event.toolCall.kind)) return 'running';
  if (/edit|write|patch/iu.test(event.toolCall.kind)) return 'editing';
  return 'working';
}
