/**
 * Selectable voice (ASR) models for dictation. These are DashScope/Qwen-ASR
 * models, not chat models — they aren't in the agent's ACP model list, so the
 * picker offers a fixed set. `batch` transcribes on stop; `realtime` streams
 * live interim text.
 */
export interface VoiceModelOption {
  id: string;
  label: string;
  kind: 'batch' | 'realtime';
}

export const VOICE_MODELS: VoiceModelOption[] = [
  { id: 'qwen3-asr-flash', label: 'Qwen3 ASR Flash', kind: 'batch' },
  {
    id: 'qwen3-asr-flash-realtime',
    label: 'Qwen3 ASR Flash (realtime)',
    kind: 'realtime',
  },
  {
    id: 'paraformer-realtime-v2',
    label: 'Paraformer (realtime)',
    kind: 'realtime',
  },
  { id: 'fun-asr-realtime', label: 'Fun ASR (realtime)', kind: 'realtime' },
];

export const DEFAULT_VOICE_MODEL = 'qwen3-asr-flash';
