import type { LiveStatus, VisualSource } from '../shared/protocol.ts';

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

export function shouldCaptureLiveVisual(
  status: Pick<LiveStatus, 'callId' | 'state'>,
  visualInput: unknown,
): boolean {
  return (
    visualInput !== undefined &&
    status.callId !== undefined &&
    ['starting', 'listening', 'thinking', 'speaking'].includes(status.state)
  );
}

export function shouldShowCameraPreview(
  status: Pick<LiveStatus, 'available' | 'state'>,
  visualInput: { source: 'screen' | 'camera' } | undefined,
  connectionReady: boolean,
): boolean {
  return (
    connectionReady &&
    visualInput?.source === 'camera' &&
    status.state !== 'stopping' &&
    (status.available || isActiveLiveCall(status))
  );
}

export function canChangeLiveVisualInput(
  status: Pick<LiveStatus, 'callId' | 'state'>,
  visualInput: unknown,
  connectionReady: boolean,
): boolean {
  return (
    connectionReady &&
    visualInput !== undefined &&
    (status.callId === undefined ||
      shouldCaptureLiveVisual(status, visualInput))
  );
}

export function shouldRequestVisualSourceChange(
  current: VisualSource,
  requested: VisualSource,
  pending?: VisualSource,
): boolean {
  return (
    requested !== current || (pending !== undefined && pending !== requested)
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
