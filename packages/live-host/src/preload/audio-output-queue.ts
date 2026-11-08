import type { PlaybackIdentity } from '../shared/protocol.ts';

const OUTPUT_START_DELAY_SECONDS = 0.01;
export const MAX_COMPLETED_OUTPUT_TOMBSTONES = 256;

export type OutputFrameSchedule = {
  startAt: number;
  endAt: number;
};

export type TrackedOutputPlayback = {
  readonly identity: PlaybackIdentity;
  started: boolean;
  finished: boolean;
  completed: boolean;
  activeFrames: number;
};

export type OutputFrameAdmission = {
  output: TrackedOutputPlayback;
  playbackStarted: boolean;
};

export type OutputCompletionTransition = {
  accepted: boolean;
  completed?: PlaybackIdentity;
};

function outputKey(identity: PlaybackIdentity): string {
  return `${identity.epoch}:${identity.outputId}`;
}

export class OutputPlaybackTracker {
  private readonly outputs = new Map<string, TrackedOutputPlayback>();
  private readonly completedOutputs = new Set<string>();
  private endMarkerRequired = false;

  setEndMarkerRequired(required: boolean): void {
    this.endMarkerRequired = required;
  }

  beginFrame(identity: PlaybackIdentity): OutputFrameAdmission | undefined {
    const key = outputKey(identity);
    if (this.completedOutputs.has(key)) return undefined;
    let output = this.outputs.get(key);
    if (output?.finished || output?.completed) return undefined;
    if (!output) {
      output = {
        identity: { ...identity },
        started: false,
        finished: false,
        completed: false,
        activeFrames: 0,
      };
      this.outputs.set(key, output);
    }
    output.activeFrames += 1;
    const playbackStarted = !output.started;
    output.started = true;
    return { output, playbackStarted };
  }

  finish(identity: PlaybackIdentity): OutputCompletionTransition {
    const output = this.outputs.get(outputKey(identity));
    if (!output || output.finished || output.completed) {
      return { accepted: false };
    }
    output.finished = true;
    return { accepted: true, ...this.maybeComplete(output) };
  }

  endFrame(output: TrackedOutputPlayback): OutputCompletionTransition {
    if (
      this.outputs.get(outputKey(output.identity)) !== output ||
      output.activeFrames <= 0
    ) {
      return { accepted: false };
    }
    output.activeFrames -= 1;
    return { accepted: true, ...this.maybeComplete(output) };
  }

  clear(): void {
    this.outputs.clear();
    this.completedOutputs.clear();
  }

  private maybeComplete(
    output: TrackedOutputPlayback,
  ): Pick<OutputCompletionTransition, 'completed'> {
    if (
      output.completed ||
      output.activeFrames !== 0 ||
      (this.endMarkerRequired && !output.finished)
    ) {
      return {};
    }
    output.completed = true;
    const key = outputKey(output.identity);
    this.outputs.delete(key);
    if (this.endMarkerRequired) {
      this.completedOutputs.add(key);
      if (this.completedOutputs.size > MAX_COMPLETED_OUTPUT_TOMBSTONES) {
        const oldest = this.completedOutputs.values().next().value;
        if (oldest !== undefined) this.completedOutputs.delete(oldest);
      }
    }
    return { completed: { ...output.identity } };
  }
}

export function scheduleOutputFrame(
  currentTime: number,
  outputCursor: number,
  duration: number,
  sampleRate?: number,
): OutputFrameSchedule {
  const candidate =
    outputCursor > currentTime
      ? outputCursor
      : currentTime + OUTPUT_START_DELAY_SECONDS;
  if (sampleRate !== undefined) {
    const startFrame =
      outputCursor > currentTime
        ? Math.round(candidate * sampleRate)
        : Math.ceil(candidate * sampleRate);
    return {
      startAt: startFrame / sampleRate,
      endAt: (startFrame + Math.round(duration * sampleRate)) / sampleRate,
    };
  }
  const startAt = candidate;
  const endAt = startAt + duration;
  return { startAt, endAt };
}
