const OUTPUT_START_DELAY_SECONDS = 0.01;
const MAX_QUEUED_OUTPUT_SECONDS = 10;

export const AUDIO_OUTPUT_BACKPRESSURE = 'audio_output_backpressure';

export type OutputFrameSchedule = {
  startAt: number;
  endAt: number;
};

export function scheduleOutputFrame(
  currentTime: number,
  outputCursor: number,
  duration: number,
): OutputFrameSchedule {
  const startAt = Math.max(
    currentTime + OUTPUT_START_DELAY_SECONDS,
    outputCursor,
  );
  const endAt = startAt + duration;
  if (endAt - currentTime >= MAX_QUEUED_OUTPUT_SECONDS) {
    throw new Error(AUDIO_OUTPUT_BACKPRESSURE);
  }
  return { startAt, endAt };
}
