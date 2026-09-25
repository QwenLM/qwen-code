import { StreamingState } from '../types.js';

export type CommandIdleState = {
  streamingState: StreamingState;
  localCommandDispatchStartedIdle: boolean;
  activeModelStreams: number;
};

export const isCommandIdle = ({
  streamingState,
  localCommandDispatchStartedIdle,
  activeModelStreams,
}: CommandIdleState) =>
  streamingState === StreamingState.Idle ||
  (localCommandDispatchStartedIdle && activeModelStreams === 0);
