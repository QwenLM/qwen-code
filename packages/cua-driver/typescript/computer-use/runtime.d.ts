import type { ComputerUse, CallOptions } from './index.js';
import type { Browser, BrowserTab } from '@qwen-code/browser-use';
export interface RuntimeOutput {
  write(value: unknown): void;
  emitImage(value: string): void | Promise<void>;
  readonly signal?: AbortSignal;
}
export interface ObservationOptions extends CallOptions {
  emit?: boolean;
  forceFull?: boolean;
  maxTextChars?: number;
  maxElements?: number;
  maxDepth?: number;
}
export type AppPoint = number | { x: number; y: number };
export interface RuntimeApp {
  readonly name: string;
  getAXState(options?: ObservationOptions): Promise<string>;
  getScreenshot(options?: CallOptions & { emit?: boolean }): Promise<string>;
  getAXStateAndScreenshot(options?: ObservationOptions): Promise<string>;
  click(point: AppPoint, options?: CallOptions & { key?: string | string[]; button?: 'left' | 'right' | 'middle'; count?: number }): Promise<void>;
  doubleClick(point: AppPoint, options?: CallOptions): Promise<void>;
  rightClick(point: AppPoint, options?: CallOptions): Promise<void>;
  scroll(point: AppPoint, options: CallOptions & { direction: 'up' | 'down' | 'left' | 'right'; amount?: number }): Promise<void>;
  drag(options: CallOptions & { fromX: number; fromY: number; toX: number; toY: number }): Promise<void>;
  setValue(element: number, value: string, options?: CallOptions): Promise<void>;
  performSecondaryAction(element: number, action: string, options?: CallOptions): Promise<void>;
  typeText(text: string, options?: CallOptions): Promise<void>;
  paste(text: string, options?: CallOptions): Promise<void>;
  selectText(element: number, text: string, options?: CallOptions): Promise<void>;
  pressKey(key: string, options?: CallOptions & { modifiers?: string[] }): Promise<void>;
  hotkey(keys: string[], options?: CallOptions): Promise<void>;
}
export interface RuntimeDesktop {
  getScreenshot(options?: CallOptions & { emit?: boolean }): Promise<string>;
  click(point: { x: number; y: number }, options?: CallOptions & { key?: string | string[]; button?: 'left' | 'right' | 'middle'; count?: number }): Promise<void>;
  doubleClick(point: { x: number; y: number }, options?: CallOptions): Promise<void>;
  rightClick(point: { x: number; y: number }, options?: CallOptions): Promise<void>;
  scroll(point: { x: number; y: number }, options: CallOptions & { direction: 'up' | 'down' | 'left' | 'right'; amount?: number }): Promise<void>;
  drag(options: CallOptions & { fromX: number; fromY: number; toX: number; toY: number }): Promise<void>;
  typeText(text: string, options?: CallOptions): Promise<void>;
  pressKey(key: string, options?: CallOptions & { modifiers?: string[] }): Promise<void>;
  hotkey(keys: string[], options?: CallOptions): Promise<void>;
  keyDown(key: string, options?: CallOptions): Promise<void>;
  keyUp(key: string, options?: CallOptions): Promise<void>;
}
export interface CuaRuntime {
  readonly desktop: RuntimeDesktop;
  getBrowser(selector?: string | { id: string }): Promise<Browser>;
  getTab(reference: string | { url: string }, options?: { browser?: string | { id: string } }): Promise<BrowserTab>;
  createBrowserTab(browser?: string | { id: string }, url?: string): Promise<BrowserTab>;
  [Symbol.asyncDispose](): Promise<void>;
  rewriteDocumentation(): string;
  getState(options?: CallOptions & { emit?: boolean }): Promise<string>;
  getApp(selector: string): Promise<RuntimeApp>;
}
export function createCua(output: RuntimeOutput, options?: { computer?: ComputerUse }): CuaRuntime;
