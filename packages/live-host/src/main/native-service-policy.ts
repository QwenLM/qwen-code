import type { ConnectionPhase } from './daemon-connection.ts';

export function shouldActivateNativeServices(phase: ConnectionPhase): boolean {
  return phase === 'ready';
}

export function shouldDeactivateNativeServices(
  phase: ConnectionPhase,
): boolean {
  return (
    phase === 'disconnected' || phase === 'incompatible' || phase === 'error'
  );
}
