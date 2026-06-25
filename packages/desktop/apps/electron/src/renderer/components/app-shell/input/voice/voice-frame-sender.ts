export const MAX_DROPPED_VOICE_FRAMES = 3;

interface VoiceFrameSocket {
  readonly OPEN: number;
  readyState: number;
  send(frame: ArrayBuffer): void;
}

export function sendVoicePcmFrame(
  ws: VoiceFrameSocket,
  pcm: ArrayBuffer,
  droppedFrames: number,
  onTooManyDroppedFrames: () => void,
): number {
  if (ws.readyState === ws.OPEN) {
    ws.send(pcm);
    return 0;
  }

  const nextDroppedFrames = droppedFrames + 1;
  if (nextDroppedFrames >= MAX_DROPPED_VOICE_FRAMES) {
    onTooManyDroppedFrames();
  }
  return nextDroppedFrames;
}
