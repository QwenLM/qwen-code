/**
 * A single host/daemon setting descriptor the panel renders (e.g. tool
 * settings shown in a tool group). Shape mirrors the daemon SDK's descriptor;
 * the host passes its values in, the panel only reads them.
 */
export interface DaemonSettingDescriptor {
  key: string;
  type: string;
  label: string;
  category: string;
  description?: string;
  requiresRestart: boolean;
  default: unknown;
  options?: ReadonlyArray<{ value: string | number; label: string }>;
  values: {
    effective: unknown;
    user?: unknown;
    workspace?: unknown;
  };
}
