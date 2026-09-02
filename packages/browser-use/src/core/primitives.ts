/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type BrowserMouseButton =
  | 'left'
  | 'middle'
  | 'right'
  | 'back'
  | 'forward';
export type BrowserModifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

export interface BrowserInfo {
  id: string;
  name: string;
  type: 'extension';
  family: 'chrome';
}

export interface TabInfo {
  id: string;
  title: string | null;
  url: string | null;
}

export interface BrowserUserTabInfo {
  id: string;
  title: string | null;
  url: string | null;
  lastOpened?: string;
  tabGroup?: string;
}

export interface BrowserHistoryEntry {
  url: string;
  title: string | null;
  dateVisited: string;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Screenshot pixels and action coordinates both use the viewport's CSS-pixel space. */
export interface ScreenshotEnvelope {
  kind: 'image';
  mediaType: 'image/png';
  base64: string;
  width?: number;
  height?: number;
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  coordinateSpace: 'css-pixels';
  element?: Box;
}

export interface LogEntry {
  level: 'debug' | 'info' | 'log' | 'warn' | 'error';
  message: string;
  timestamp: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  stack?: string;
}

export interface NetworkEntry {
  requestId: string;
  url: string;
  method: string;
  resourceType: string;
  startedAt: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  finished: boolean;
  failed?: string;
  encodedDataLength?: number;
  /** Wall-clock ms when response headers arrived; internal recorders may use this before exposing an entry. */
  respondedAt?: number;
}

export interface DialogInfo {
  type: string;
  message: string;
  defaultPrompt: string;
  url: string;
  /** Child debugger session that raised the dialog (an out-of-process iframe), if any. */
  sessionId?: string;
}

export interface BrowserSnapshotEnvelope {
  text: string;
  documentId: string;
}

type JsonPrimitive = string | number | boolean | null;
export type DispatchResult =
  | JsonPrimitive
  | BrowserInfo
  | TabInfo
  | BrowserUserTabInfo
  | BrowserHistoryEntry
  | BrowserSnapshotEnvelope
  | ScreenshotEnvelope
  | Box
  | DispatchResult[]
  | { readonly [key: string]: DispatchResult };

type Primitive<Args, Result> = { args: Args; result: Result };
type BrowserArgs = { browserId: string };
type TabArgs = { tabId: string };
type Timeout = { timeoutMs?: number };
type NavigationOptions = Timeout & {
  waitUntil?: 'commit' | 'domcontentloaded' | 'load' | 'networkidle';
};
type LoadOptions = Timeout & {
  state?: 'domcontentloaded' | 'load' | 'networkidle';
};
type Modifiers = { modifiers?: readonly BrowserModifier[] };
type DocumentGuard = { expectedDocumentId?: string };
type LocatorArgs = TabArgs & DocumentGuard & { steps: readonly LocatorStep[] };
type LocatorTimeoutArgs = LocatorArgs & Timeout;
type LocatorActionArgs = LocatorTimeoutArgs & { force?: boolean };
type RefArgs = TabArgs & DocumentGuard & { ref: string };
type RefActionArgs = RefArgs & Timeout & { force?: boolean };
export type LocatorMatcher = string | { regex: string; flags?: string };
export type LocatorStep =
  | { kind: 'locator'; selector: string }
  | { kind: 'ref'; ref: string }
  | { kind: 'frame'; selector: string }
  | { kind: 'getByRole'; role: string; name?: LocatorMatcher; exact?: boolean }
  | {
      kind: 'getByText' | 'getByLabel' | 'getByPlaceholder';
      text: LocatorMatcher;
      exact?: boolean;
    }
  | { kind: 'getByTestId'; testId: string }
  | {
      kind: 'filter';
      hasText?: LocatorMatcher;
      hasNotText?: LocatorMatcher;
      has?: LocatorStep[];
      hasNot?: LocatorStep[];
      visible?: boolean;
    }
  | { kind: 'first' | 'last' }
  | { kind: 'nth'; index: number }
  | { kind: 'and' | 'or'; steps: LocatorStep[] };
export type BrowserSelectOption =
  | string
  | (
      | { index: number; label?: string; value?: string }
      | { index?: number; label: string; value?: string }
      | { index?: number; label?: string; value: string }
    );
export interface BrowserScrollResult {
  scrollX: number;
  scrollY: number;
}
export type BrowserDialogInfo = Pick<
  DialogInfo,
  'type' | 'message' | 'defaultPrompt'
>;
export type BrowserNetworkEntry = Omit<NetworkEntry, 'respondedAt'>;

/** Incremental lifecycle event emitted by a browser-managed file download. */
export type BrowserDownloadEvent =
  | {
      type: 'started';
      downloadId: string;
      url: string;
      suggestedFilename?: string;
    }
  | {
      type: 'completed';
      downloadId: string;
      url: string;
      suggestedFilename?: string;
      path?: string;
      sizeBytes?: number;
    }
  | {
      type: 'failed';
      downloadId: string;
      url: string;
      suggestedFilename?: string;
      error?: string;
    };

export interface BrowserPrimitiveSpec {
  'browser.list': Primitive<Record<string, never>, BrowserInfo[]>;
  'browser.get': Primitive<{ id: string }, BrowserInfo>;
  'session.setName': Primitive<BrowserArgs & { name: string }, null>;
  'tab.discover': Primitive<BrowserArgs, BrowserUserTabInfo[]>;
  'tab.claim': Primitive<
    BrowserArgs & { tab: string | BrowserUserTabInfo },
    TabInfo
  >;
  'history.list': Primitive<
    BrowserArgs & {
      options?: {
        limit?: number;
        queries?: readonly string[];
        from?: string | Date;
        to?: string | Date;
      };
    },
    BrowserHistoryEntry[]
  >;
  'tab.create': Primitive<BrowserArgs, TabInfo>;
  'tab.list': Primitive<BrowserArgs, TabInfo[]>;
  'tab.get': Primitive<BrowserArgs & TabArgs, TabInfo>;
  'tab.getSelected': Primitive<BrowserArgs, TabInfo | null>;
  'tab.activate': Primitive<TabArgs, null>;
  'navigation.goto': Primitive<
    TabArgs & NavigationOptions & { url: string },
    null
  >;
  'navigation.getUrl': Primitive<TabArgs, string | null>;
  'navigation.getTitle': Primitive<TabArgs, string | null>;
  'navigation.back': Primitive<TabArgs & NavigationOptions, null>;
  'navigation.forward': Primitive<TabArgs & NavigationOptions, null>;
  'navigation.reload': Primitive<TabArgs & NavigationOptions, null>;
  'tab.close': Primitive<TabArgs, null>;
  'capture.screenshot': Primitive<
    TabArgs & {
      clip?: { x: number; y: number; width: number; height: number };
      fullPage?: boolean;
      /** Render scale factor (1-4) applied on top of the CSS-pixel contract, for magnified crops. */
      scale?: number;
    },
    ScreenshotEnvelope
  >;
  'pointer.click': Primitive<
    TabArgs &
      Modifiers & {
        x: number;
        y: number;
        button?: BrowserMouseButton;
        clickCount?: number;
      },
    null
  >;
  'pointer.doubleClick': Primitive<
    TabArgs & Modifiers & { x: number; y: number },
    null
  >;
  'pointer.drag': Primitive<
    TabArgs & Modifiers & { path: ReadonlyArray<{ x: number; y: number }> },
    null
  >;
  'pointer.move': Primitive<
    TabArgs & Modifiers & { x: number; y: number },
    null
  >;
  'pointer.scroll': Primitive<
    TabArgs &
      Modifiers & {
        x: number;
        y: number;
        deltaX: number;
        deltaY: number;
      },
    null
  >;
  'pointer.down': Primitive<
    TabArgs &
      Modifiers & {
        x: number;
        y: number;
        button?: BrowserMouseButton;
      },
    null
  >;
  'pointer.up': Primitive<
    TabArgs &
      Modifiers & {
        x: number;
        y: number;
        button?: BrowserMouseButton;
      },
    null
  >;
  'keyboard.press': Primitive<TabArgs & { keys: readonly string[] }, null>;
  'keyboard.type': Primitive<TabArgs & { text: string }, null>;
  'keyboard.down': Primitive<TabArgs & Modifiers & { key: string }, null>;
  'keyboard.up': Primitive<TabArgs & Modifiers & { key: string }, null>;
  'keyboard.hold': Primitive<
    TabArgs & { keys: readonly string[]; durationMs: number },
    null
  >;
  'snapshot.capture': Primitive<
    TabArgs & {
      filter?: 'interactive' | 'all';
      maxChars?: number;
      root?: string;
      viewportOnly?: boolean;
    },
    string
  >;
  'snapshot.captureWithMetadata': Primitive<
    TabArgs &
      DocumentGuard & {
        filter?: 'interactive' | 'all';
        maxChars?: number;
        root?: string;
        /** Skip elements whose box does not intersect the (frame) viewport. */
        viewportOnly?: boolean;
      },
    BrowserSnapshotEnvelope
  >;
  'snapshot.captureByRef': Primitive<
    TabArgs &
      DocumentGuard & {
        filter?: 'interactive' | 'all';
        maxChars?: number;
        rootRef?: string;
        viewportOnly?: boolean;
      },
    string
  >;
  'element.clickByRef': Primitive<
    RefActionArgs &
      Modifiers & { button?: BrowserMouseButton; clickCount?: number },
    null
  >;
  'element.doubleClickByRef': Primitive<RefActionArgs & Modifiers, null>;
  'element.hoverByRef': Primitive<RefArgs & Timeout, null>;
  'element.typeByRef': Primitive<RefArgs & Timeout & { text: string }, null>;
  'element.pressByRef': Primitive<
    RefArgs & Timeout & { keys: readonly string[] },
    null
  >;
  'element.scrollByRef': Primitive<
    RefArgs & Timeout & { deltaX: number; deltaY: number },
    BrowserScrollResult
  >;
  'element.screenshotByRef': Primitive<RefArgs & Timeout, ScreenshotEnvelope>;
  'dialog.get': Primitive<TabArgs, BrowserDialogInfo | null>;
  'dialog.accept': Primitive<TabArgs & { promptText?: string }, null>;
  'dialog.dismiss': Primitive<TabArgs, null>;
  'diagnostics.readConsole': Primitive<
    TabArgs & {
      filter?: string;
      levels?: ReadonlyArray<
        'debug' | 'info' | 'log' | 'warn' | 'warning' | 'error'
      >;
      limit?: number;
      clear?: boolean;
    },
    LogEntry[]
  >;
  'diagnostics.readNetwork': Primitive<
    TabArgs & {
      urlPattern?: string;
      limit?: number;
      clear?: boolean;
    },
    BrowserNetworkEntry[]
  >;
  'page.evaluate': Primitive<
    TabArgs & Timeout & { script: string },
    DispatchResult
  >;
  'event.wait': Primitive<
    TabArgs & Timeout & { event: 'download' | 'filechooser' },
    | {
        downloadId: string;
      }
    | { chooserId: string; multiple: boolean }
  >;
  'fileChooser.setFiles': Primitive<
    TabArgs & Timeout & { chooserId: string; files: readonly string[] },
    null
  >;
  'download.readEvents': Primitive<
    TabArgs & { clear?: boolean },
    BrowserDownloadEvent[]
  >;
  'download.getPath': Primitive<
    TabArgs & Timeout & { downloadId: string },
    string | null
  >;
  'navigation.waitForUrl': Primitive<
    TabArgs & NavigationOptions & { url: string },
    null
  >;
  'navigation.watch.begin': Primitive<
    TabArgs &
      Timeout & {
        url?: string;
        waitUntil?: 'domcontentloaded' | 'load' | 'networkidle';
      },
    string
  >;
  'navigation.watch.wait': Primitive<TabArgs & { waiterId: string }, null>;
  'navigation.watch.cancel': Primitive<TabArgs & { waiterId: string }, null>;
  'navigation.waitForLoadState': Primitive<TabArgs & LoadOptions, null>;
  'time.wait': Primitive<TabArgs & { timeoutMs: number }, null>;
  'element.count': Primitive<LocatorArgs, number>;
  'element.evaluate': Primitive<
    LocatorArgs & Timeout & { script: string },
    DispatchResult
  >;
  'element.evaluateAll': Primitive<
    LocatorArgs & Timeout & { script: string },
    DispatchResult
  >;
  'element.getAllText': Primitive<LocatorTimeoutArgs, string[]>;
  'element.getInnerText': Primitive<LocatorTimeoutArgs, string>;
  'element.getTextContent': Primitive<LocatorTimeoutArgs, string | null>;
  'element.getAttribute': Primitive<
    LocatorTimeoutArgs & { name: string },
    string | null
  >;
  'element.isEnabled': Primitive<LocatorTimeoutArgs, boolean>;
  'element.isVisible': Primitive<LocatorTimeoutArgs, boolean>;
  'element.isChecked': Primitive<LocatorTimeoutArgs, boolean>;
  'element.getInputValue': Primitive<LocatorTimeoutArgs, string>;
  'element.getBoundingBox': Primitive<LocatorTimeoutArgs, Box | null>;
  'element.scrollIntoView': Primitive<LocatorTimeoutArgs, Box>;
  'element.click': Primitive<
    LocatorActionArgs &
      Modifiers & { button?: BrowserMouseButton; clickCount?: number },
    null
  >;
  'element.doubleClick': Primitive<
    LocatorActionArgs & Modifiers & { button?: BrowserMouseButton },
    null
  >;
  'element.hover': Primitive<LocatorTimeoutArgs & Modifiers, null>;
  'element.scroll': Primitive<
    LocatorTimeoutArgs & { deltaX: number; deltaY: number },
    BrowserScrollResult
  >;
  'element.setFiles': Primitive<
    LocatorTimeoutArgs & { paths: readonly string[] },
    null
  >;
  'element.screenshot': Primitive<LocatorTimeoutArgs, ScreenshotEnvelope>;
  'element.fill': Primitive<LocatorTimeoutArgs & { value: string }, null>;
  'element.type': Primitive<LocatorTimeoutArgs & { value: string }, null>;
  'element.press': Primitive<LocatorTimeoutArgs & { value: string }, null>;
  'element.select': Primitive<
    LocatorTimeoutArgs & {
      value: BrowserSelectOption | readonly BrowserSelectOption[];
    },
    string[]
  >;
  'element.check': Primitive<LocatorTimeoutArgs, null>;
  'element.uncheck': Primitive<LocatorTimeoutArgs, null>;
  'element.setChecked': Primitive<
    LocatorTimeoutArgs & { checked: boolean },
    null
  >;
  'element.waitFor': Primitive<
    LocatorTimeoutArgs & {
      state: 'attached' | 'detached' | 'visible' | 'hidden';
    },
    null
  >;
}

export type BrowserPrimitive = keyof BrowserPrimitiveSpec;
export type BrowserPrimitiveArgs<P extends BrowserPrimitive> =
  BrowserPrimitiveSpec[P]['args'];
export type BrowserPrimitiveResult<P extends BrowserPrimitive> =
  BrowserPrimitiveSpec[P]['result'];

export interface BrowserPrimitiveExecutor {
  start(): Promise<void>;
  stop(): Promise<void>;
  executePrimitive<P extends BrowserPrimitive>(
    primitive: P,
    args: BrowserPrimitiveArgs<P>,
  ): Promise<BrowserPrimitiveResult<P>>;
}
