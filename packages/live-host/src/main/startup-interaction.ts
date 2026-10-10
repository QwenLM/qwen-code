import type { LiveStatus } from '../shared/protocol.ts';
import { isActiveLiveCall } from './live-state-policy.ts';

export type StartupInteractionState = {
  connectionReady: boolean;
  rendererReady: boolean;
  hostReady: boolean;
  startPending: boolean;
  live: Pick<LiveStatus, 'available' | 'state'>;
};

export class StartupInteraction {
  private pending = true;

  cancel(): void {
    this.pending = false;
  }

  shouldStart(state: StartupInteractionState): boolean {
    if (!this.pending) return false;
    if (state.startPending || isActiveLiveCall(state.live)) {
      this.cancel();
      return false;
    }
    if (
      !state.connectionReady ||
      !state.rendererReady ||
      !state.hostReady ||
      !state.live.available ||
      state.live.state !== 'idle'
    )
      return false;
    this.cancel();
    return true;
  }
}
