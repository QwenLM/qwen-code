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
