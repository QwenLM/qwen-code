const OUTPUT_START_DELAY_SECONDS = 0.01;

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
  return { startAt, endAt };
}
