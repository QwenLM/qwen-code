import type { ComputerUse, ComputerUseApp, CallOptions } from './index.js';

export interface RuntimeOutput {
  write(value: unknown): void;
  emitImage(value: string): void | Promise<void>;
  readonly signal?: AbortSignal;
}
export interface ObservationOptions extends CallOptions {
  emit?: boolean;
  forceFull?: boolean;
  maxTextChars?: number;
}
type ActionMethods = Omit<ComputerUseApp, 'name' | 'getState'>;
type VoidActions = {
  [K in keyof ActionMethods]: ActionMethods[K] extends (...args: infer A) => unknown
    ? (...args: A) => Promise<void> : never;
};
export type RuntimeApp = VoidActions & {
  readonly name: string;
  getAXState(options?: ObservationOptions): Promise<string>;
  getScreenshot(options?: ObservationOptions): Promise<string>;
  getAXStateAndScreenshot(options?: ObservationOptions): Promise<string>;
};
export interface CuaRuntime {
  rewriteDocumentation(): string;
  getState(options?: CallOptions & { emit?: boolean }): Promise<string>;
  getApp(selector: string): Promise<RuntimeApp>;
}
export function createCua(output: RuntimeOutput, options?: { computer?: ComputerUse }): CuaRuntime;
