import type { LiveStatus } from '../shared/protocol.ts';

const ACTIVE_CALL_STATES = new Set<LiveStatus['state']>([
  'starting',
  'listening',
  'thinking',
  'speaking',
  'stopping',
]);

const CAPTURE_READY_STATES = new Set<LiveStatus['state']>([
  'listening',
  'thinking',
  'speaking',
]);

export function isActiveLiveCall(status: Pick<LiveStatus, 'state'>): boolean {
  return ACTIVE_CALL_STATES.has(status.state);
}

export function canToggleLive(
  status: Pick<LiveStatus, 'available' | 'state'>,
  connectionReady: boolean,
  hostReady: boolean,
): boolean {
  return (
    connectionReady &&
    hostReady &&
    (status.available || isActiveLiveCall(status))
  );
}

export function shouldCaptureLiveAudio(
  status: Pick<LiveStatus, 'available' | 'state'>,
  hostReady: boolean,
): boolean {
  return (
    hostReady && status.available && CAPTURE_READY_STATES.has(status.state)
  );
}

export function shouldStopLiveOnToggle(
  status: Pick<LiveStatus, 'state'>,
  startPending: boolean,
): boolean {
  return startPending || isActiveLiveCall(status);
}

export function projectLiveStatusForCapture(
  status: LiveStatus,
  captureReady: boolean,
): LiveStatus {
  if (status.state !== 'listening' || captureReady) return status;
  return { ...status, state: 'starting', statusText: undefined };
}

export function shouldRenderSetup(
  status: Pick<LiveStatus, 'available' | 'state'>,
  connectionReady: boolean,
): boolean {
  return !connectionReady || (!status.available && !isActiveLiveCall(status));
}
