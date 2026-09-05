/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Box,
  BrowserHistoryEntry,
  BrowserInfo,
  BrowserSelectOption,
  BrowserUserTabInfo,
  LogEntry,
  TabInfo,
} from '../core/primitives.js';

export type {
  Box,
  BrowserHistoryEntry,
  BrowserInfo,
  BrowserSelectOption,
  BrowserUserTabInfo,
  LogEntry,
  TabInfo,
} from '../core/primitives.js';

export interface TimeoutOptions {
  timeoutMs?: number;
}

export interface PageWaitForURLOptions extends TimeoutOptions {
  waitUntil?: 'commit' | 'domcontentloaded' | 'load' | 'networkidle';
}

export interface LocatorTextOptions {
  exact?: boolean;
}

export interface LocatorRoleOptions extends LocatorTextOptions {
  name?: string | RegExp;
}

export interface LocatorFilterOptions {
  hasText?: string | RegExp;
  hasNotText?: string | RegExp;
  has?: BrowserLocator;
  hasNot?: BrowserLocator;
  visible?: boolean;
}

export type LocatorLocatorOptions = Omit<LocatorFilterOptions, 'visible'>;

export type KeyboardModifier =
  | 'Alt'
  | 'Control'
  | 'ControlOrMeta'
  | 'Meta'
  | 'Shift';

export interface LocatorClickOptions extends TimeoutOptions {
  button?: 'left' | 'middle' | 'right';
  modifiers?: readonly KeyboardModifier[];
  force?: boolean;
}

export interface LocatorCheckOptions extends TimeoutOptions {
  force?: boolean;
}

export interface LocatorWaitOptions extends TimeoutOptions {
  state: 'attached' | 'detached' | 'visible' | 'hidden';
}

export interface BrowserLocator {
  locator(selector: string, options?: LocatorLocatorOptions): BrowserLocator;
  getByRole(role: string, options?: LocatorRoleOptions): BrowserLocator;
  getByText(
    text: string | RegExp,
    options?: LocatorTextOptions,
  ): BrowserLocator;
  getByLabel(
    text: string | RegExp,
    options?: LocatorTextOptions,
  ): BrowserLocator;
  getByPlaceholder(
    text: string | RegExp,
    options?: LocatorTextOptions,
  ): BrowserLocator;
  getByTestId(testId: string): BrowserLocator;
  first(): BrowserLocator;
  last(): BrowserLocator;
  nth(index: number): BrowserLocator;
  filter(options?: LocatorFilterOptions): BrowserLocator;
  and(other: BrowserLocator): BrowserLocator;
  or(other: BrowserLocator): BrowserLocator;
  all(): Promise<BrowserLocator[]>;
  count(): Promise<number>;
  evaluate<Result = unknown, Arg = unknown>(
    pageFunction:
      | string
      | ((element: Element, arg: Arg) => Result | Promise<Result>),
    arg?: Arg,
    options?: TimeoutOptions,
  ): Promise<Result>;
  evaluateAll<Result = unknown, Arg = unknown>(
    pageFunction:
      | string
      | ((elements: Element[], arg: Arg) => Result | Promise<Result>),
    arg?: Arg,
    options?: TimeoutOptions,
  ): Promise<Result>;
  allTextContents(options?: TimeoutOptions): Promise<string[]>;
  innerText(options?: TimeoutOptions): Promise<string>;
  textContent(options?: TimeoutOptions): Promise<string | null>;
  getAttribute(name: string, options?: TimeoutOptions): Promise<string | null>;
  isEnabled(): Promise<boolean>;
  isVisible(): Promise<boolean>;
  click(options?: LocatorClickOptions): Promise<void>;
  dblclick(options?: LocatorClickOptions): Promise<void>;
  downloadMedia(options?: TimeoutOptions): Promise<void>;
  fill(value: string, options?: TimeoutOptions): Promise<void>;
  type(value: string, options?: TimeoutOptions): Promise<void>;
  press(value: string, options?: TimeoutOptions): Promise<void>;
  selectOption(
    value: BrowserSelectOption | readonly BrowserSelectOption[],
    options?: TimeoutOptions,
  ): Promise<void>;
  check(options?: LocatorCheckOptions): Promise<void>;
  uncheck(options?: LocatorCheckOptions): Promise<void>;
  setChecked(checked: boolean, options?: LocatorCheckOptions): Promise<void>;
  waitFor(options: LocatorWaitOptions): Promise<void>;
}

export interface BrowserFrameLocator {
  locator(selector: string): BrowserLocator;
  getByRole(role: string, options?: LocatorRoleOptions): BrowserLocator;
  getByText(
    text: string | RegExp,
    options?: LocatorTextOptions,
  ): BrowserLocator;
  getByLabel(
    text: string | RegExp,
    options?: LocatorTextOptions,
  ): BrowserLocator;
  getByPlaceholder(
    text: string | RegExp,
    options?: LocatorTextOptions,
  ): BrowserLocator;
  getByTestId(testId: string): BrowserLocator;
  frameLocator(selector: string): BrowserFrameLocator;
}

export interface BrowserFileChooser {
  isMultiple(): boolean;
  setFiles(
    files: string | readonly string[],
    options?: TimeoutOptions,
  ): Promise<void>;
}

export type BrowserDownload = Readonly<Record<never, never>>;

export interface NavigationExpectationOptions extends TimeoutOptions {
  url?: string;
  waitUntil?: 'domcontentloaded' | 'load' | 'networkidle';
}

export interface LoadStateOptions extends TimeoutOptions {
  state?: 'domcontentloaded' | 'load' | 'networkidle';
}

export interface BrowserPlaywright {
  locator(selector: string): BrowserLocator;
  getByRole(role: string, options?: LocatorRoleOptions): BrowserLocator;
  getByText(
    text: string | RegExp,
    options?: LocatorTextOptions,
  ): BrowserLocator;
  getByLabel(
    text: string | RegExp,
    options?: LocatorTextOptions,
  ): BrowserLocator;
  getByPlaceholder(
    text: string | RegExp,
    options?: LocatorTextOptions,
  ): BrowserLocator;
  getByTestId(testId: string): BrowserLocator;
  frameLocator(selector: string): BrowserFrameLocator;
  evaluate<Result = unknown, Arg = unknown>(
    pageFunction: string | ((arg: Arg) => Result | Promise<Result>),
    arg?: Arg,
    options?: TimeoutOptions,
  ): Promise<Result>;
  domSnapshot(): Promise<string>;
  waitForEvent(
    event: 'download',
    options?: TimeoutOptions,
  ): Promise<BrowserDownload>;
  waitForEvent(
    event: 'filechooser',
    options?: TimeoutOptions,
  ): Promise<BrowserFileChooser>;
  waitForURL(url: string, options?: PageWaitForURLOptions): Promise<void>;
  expectNavigation<Result>(
    action: () => Result | Promise<Result>,
    options?: NavigationExpectationOptions,
  ): Promise<Awaited<Result>>;
  waitForLoadState(options?: LoadStateOptions): Promise<void>;
  waitForTimeout(timeoutMs: number): Promise<void>;
}

export interface CoordinateClickOptions {
  x: number;
  y: number;
  button?: number;
  keypress?: readonly string[];
}

export interface BrowserCUA {
  click(options: CoordinateClickOptions): Promise<void>;
  double_click(
    options: Pick<CoordinateClickOptions, 'x' | 'y' | 'keypress'>,
  ): Promise<void>;
  drag(options: {
    path: ReadonlyArray<{ x: number; y: number }>;
    keys?: readonly string[];
  }): Promise<void>;
  keypress(options: { keys: readonly string[] }): Promise<void>;
  move(options: {
    x: number;
    y: number;
    keys?: readonly string[];
  }): Promise<void>;
  scroll(options: {
    x: number;
    y: number;
    scrollX: number;
    scrollY: number;
    keypress?: readonly string[];
  }): Promise<void>;
  type(options: { text: string }): Promise<void>;
}

interface DomCuaTargetOptions {
  node_id: string;
}

export interface BrowserDomCUA {
  get_visible_dom(): Promise<unknown>;
  click(options: DomCuaTargetOptions): Promise<void>;
  double_click(options: DomCuaTargetOptions): Promise<void>;
  type(options: { text: string }): Promise<void>;
  keypress(options: { keys: readonly string[] }): Promise<void>;
  scroll(options: { node_id?: string; x: number; y: number }): Promise<void>;
}

export interface BrowserDev {
  logs(options?: {
    filter?: string;
    levels?: ReadonlyArray<
      'debug' | 'info' | 'log' | 'warn' | 'warning' | 'error'
    >;
    limit?: number;
  }): Promise<LogEntry[]>;
}

interface BrowserDialogBase {
  readonly message: string;
  dismiss(): Promise<void>;
}

export interface BrowserAlertDialog extends BrowserDialogBase {
  readonly type: 'alert';
}

export interface BrowserBeforeUnloadDialog extends BrowserDialogBase {
  readonly type: 'beforeunload';
}

export interface BrowserConfirmDialog extends BrowserDialogBase {
  readonly type: 'confirm';
  accept(): Promise<void>;
}

export interface BrowserPromptDialog extends BrowserDialogBase {
  readonly type: 'prompt';
  readonly defaultValue: string;
  accept(text: string): Promise<void>;
}

export type BrowserDialog =
  | BrowserAlertDialog
  | BrowserBeforeUnloadDialog
  | BrowserConfirmDialog
  | BrowserPromptDialog;

export interface TabScreenshotOptions {
  clip?: Box;
  fullPage?: boolean;
}

export interface BrowserScreenshot {
  readonly bytes: Uint8Array;
  readonly mimeType: 'image/jpeg';
  readonly metadata: {
    readonly width: number;
    readonly height: number;
    readonly viewport: {
      readonly width: number;
      readonly height: number;
    };
    readonly devicePixelRatio: number;
    readonly coordinateSpace: 'css-pixels';
  };
}

export interface BrowserTab {
  readonly id: string;
  readonly playwright: BrowserPlaywright;
  readonly cua: BrowserCUA;
  readonly dom_cua: BrowserDomCUA;
  readonly dev: BrowserDev;
  goto(url: string): Promise<void>;
  url(): Promise<string | null>;
  title(): Promise<string | null>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  close(): Promise<void>;
  screenshot(options?: TabScreenshotOptions): Promise<BrowserScreenshot>;
  getJsDialog(): Promise<BrowserDialog | undefined>;
}

export interface BrowserTabs {
  new: () => Promise<BrowserTab>;
  list(): Promise<TabInfo[]>;
  get(tabId: string): Promise<BrowserTab>;
  selected(): Promise<BrowserTab | undefined>;
}

export interface BrowserHistoryOptions {
  limit?: number;
  queries?: readonly string[];
  from?: string | Date;
  to?: string | Date;
}

export interface BrowserUser {
  openTabs(): Promise<BrowserUserTabInfo[]>;
  claimTab(tab: string | BrowserUserTabInfo): Promise<BrowserTab>;
  history(options?: BrowserHistoryOptions): Promise<BrowserHistoryEntry[]>;
}

export interface Browser {
  readonly browserId: string;
  readonly tabs: BrowserTabs;
  readonly user: BrowserUser;
  documentation(): Promise<string>;
  nameSession(name: string): Promise<void>;
}

export interface Browsers {
  list(): Promise<BrowserInfo[]>;
  get(id: string): Promise<Browser>;
}

export interface BrowserAgent {
  readonly browsers: Browsers;
}
