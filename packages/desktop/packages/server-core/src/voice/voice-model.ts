export type VoiceTransport =
  | 'qwen-asr-chat'
  | 'qwen-asr-realtime'
  | 'dashscope-task-realtime'
  | 'unsupported';

/** Map a model id to the ASR transport it uses, or 'unsupported'. */
export function resolveVoiceTransport(model: string): VoiceTransport {
  const id = model.toLowerCase();
  if (/^qwen3-asr-flash-realtime(?:-|$)/.test(id)) {
    return 'qwen-asr-realtime';
  }
  if (/^qwen3-asr-flash(?:-\d{4}-\d{2}-\d{2})?$/.test(id)) {
    return 'qwen-asr-chat';
  }
  if (/^(fun-asr|paraformer).*realtime(?:-|$)/.test(id)) {
    return 'dashscope-task-realtime';
  }
  return 'unsupported';
}

/** True when the model streams over a realtime WebSocket transport. */
export function isStreamingVoiceModel(model: string): boolean {
  const transport = resolveVoiceTransport(model);
  return (
    transport === 'qwen-asr-realtime' || transport === 'dashscope-task-realtime'
  );
}
