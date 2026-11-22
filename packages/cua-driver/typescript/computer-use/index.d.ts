import type { SessionOutput } from '../dist/index.js';
export interface CallOptions { signal?: AbortSignal }
export interface ComputerUseOptions extends CallOptions {
  session?: string;
  sessionTtlSeconds?: number;
  idleTtlSeconds?: number;
}
export interface ComputerUseConnectOptions extends ComputerUseOptions { socketPath?: string }
export interface DriverObservation {
  text: string;
  structured?: Record<string, unknown>;
  images: Array<{ mimeType: string; dataBase64: string }>;
}
export class ComputerUseError extends Error {
  readonly code?: string;
  readonly reason?: string;
  readonly sent?: boolean;
  readonly next?: string;
  readonly details?: unknown;
}
/** Internal typed session transport. Use createCua for the model-facing API. */
export class ComputerUseApp {
  readonly name: string;
  call(name: string, args?: Record<string, unknown>, options?: CallOptions & { readOnly?: boolean }): Promise<DriverObservation>;
}
export class ComputerUse {
  private constructor();
  static create(options?: ComputerUseOptions): Promise<ComputerUse>;
  static connect(options?: ComputerUseConnectOptions): Promise<ComputerUse>;
  readonly connectionGeneration: number;
  getPlatform(options?: CallOptions): Promise<'macos' | 'windows' | 'linux'>;
  sessionInfo(options?: CallOptions): Promise<SessionOutput>;
  reconnect(options?: CallOptions): Promise<{ connectionGeneration: number }>;
  appCall(name: string, args?: Record<string, unknown>, options?: CallOptions & { readOnly?: boolean }): Promise<DriverObservation>;
  getState(options?: CallOptions): Promise<DriverObservation>;
  getApp(selector: string, options?: CallOptions): Promise<{ app: ComputerUseApp; initial: DriverObservation }>;
  close(): Promise<void>;
}
