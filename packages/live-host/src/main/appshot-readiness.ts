import type { PermissionState } from '../shared/protocol.ts';
import { loadNativeAppshot, type NativeAppshot } from './native-appshot.ts';

export type AppshotReadiness = {
  accessibility: PermissionState;
  screenRecording: PermissionState;
  appshot: boolean;
};

const EMPTY_READINESS: AppshotReadiness = {
  accessibility: 'not_determined',
  screenRecording: 'not_determined',
  appshot: false,
};

function permission(value: boolean): PermissionState {
  return value ? 'granted' : 'denied';
}

export class AppshotReadinessMonitor {
  private started = false;
  private lastState = '';

  constructor(
    private readonly onState: (state: AppshotReadiness) => void,
    private readonly native: () => NativeAppshot = loadNativeAppshot,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.refresh();
  }

  stop(): void {
    this.started = false;
    this.lastState = '';
  }

  requestPermission(kind: 'accessibility' | 'screenRecording'): void {
    if (!this.started) return;
    try {
      const native = this.native();
      if (kind === 'accessibility') native.requestAccessibility();
      else native.requestScreenRecording();
    } catch {}
    this.refresh();
  }

  refresh(): void {
    if (!this.started) return;
    let state = EMPTY_READINESS;
    try {
      const permissions = this.native().getPermissionState();
      state = {
        accessibility: permission(permissions.accessibility),
        screenRecording: permission(permissions.screenRecording),
        appshot: permissions.accessibility && permissions.screenRecording,
      };
    } catch {
      state = EMPTY_READINESS;
    }
    const serialized = JSON.stringify(state);
    if (serialized === this.lastState) return;
    this.lastState = serialized;
    this.onState({ ...state });
  }
}
