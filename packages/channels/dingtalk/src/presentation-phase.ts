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

const DINGTALK_ZH_PRESENTATION_PHASE_LABELS: Record<
  DingtalkPresentationPhase,
  string
> = {
  thinking: '🤔 思考中',
  reading: '📖 读取中',
  searching: '🔎 搜索中',
  running: '🖥️ 执行中',
  editing: '🛠️ 编辑中',
  working: '🛠️ 处理中',
  retrying: '⚠️ 重试中',
  replying: '✍️ 回复中',
};

export function isChinesePresentationLanguage(language?: string): boolean {
  const normalized = language?.trim().toLowerCase().replaceAll('_', '-');
  return normalized?.startsWith('zh') === true;
}

export function presentationPhaseLabel(
  phase: DingtalkPresentationPhase,
  language?: string,
): string {
  return (
    isChinesePresentationLanguage(language)
      ? DINGTALK_ZH_PRESENTATION_PHASE_LABELS
      : DINGTALK_PRESENTATION_PHASE_LABELS
  )[phase];
}

function toolPresentationPhase(kind: string): DingtalkPresentationPhase {
  if (/read/iu.test(kind)) return 'reading';
  if (/search|browser|web/iu.test(kind)) return 'searching';
  if (/shell|exec|command|run/iu.test(kind)) return 'running';
  if (/edit|write|patch/iu.test(kind)) return 'editing';
  return 'working';
}

export function lifecyclePresentationPhase(
  event: ChannelTaskLifecycleEvent,
): DingtalkPresentationPhase | undefined {
  if (event.type === 'text_chunk') return 'replying';
  if (event.type !== 'tool_call') return undefined;
  if (/fail|error/iu.test(event.toolCall.status)) return 'retrying';
  if (/complete|success/iu.test(event.toolCall.status)) return 'thinking';
  return toolPresentationPhase(event.toolCall.kind);
}
