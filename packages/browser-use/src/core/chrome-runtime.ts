/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, sep } from 'node:path';

import { ZodError } from 'zod';

import {
  ChromeExtensionTransport,
  type BridgeEvent,
  type ChromeBridge,
  type ChromeExtensionTransportOptions,
} from '../bridge/index.js';
import {
  BrowserRuntimeError,
  invalidArguments,
  sanitizeOperationError,
} from './errors.js';
import { applyChromeTabEvent } from './chrome-lifecycle-events.js';
import {
  CHECK_STATE_FUNCTION,
  ELEMENT_KIND_FUNCTION,
  HIT_TARGET_FUNCTION,
  SCROLL_FALLBACK_FUNCTION,
  SCROLL_STATE_FUNCTION,
} from './chrome-page-functions.js';
import {
  dialogOpenError,
  evaluationError,
  exceptionDescription,
  finiteNumber,
  inputBlockedError,
  isActionOperation,
  isPageErrorDescription,
  isTransientNavigationError,
  isoTimestamp,
  jsonValue,
  locatorOperationError,
  objectValue,
  originOf,
  pageError,
  parseAllowedOrigins,
  parseUploadRoots,
  providerTab,
  providerTabs,
  remoteEvaluationValue,
  transientOrOriginal,
  urlMatches,
  type ProviderTab,
} from './chrome-runtime-values.js';
import {
  interruptDownloads,
  interruptNavigationExpectations,
  interruptPageEventWaiters,
  navigationExpectationTimeout,
  newTabState,
  renewDocumentIdentity,
  signalNavigationExpectation,
  staleDocumentError,
  waitForDownloadSignal,
  waitForNavigationSignal,
  type FrameRecord,
  type NavigationExpectation,
  type PageEventWaiter,
  type PlaywrightPageEvent,
  type TabState,
} from './chrome-tab-state.js';
import { captureScreenshot as captureChromeScreenshot } from './chrome-screenshot.js';
import { DEFAULT_CHROME_DOCUMENTATION } from './chrome-runtime-documentation.js';
import {
  readConsoleDiagnostics,
  readNetworkDiagnostics,
  safeStringify,
} from './diagnostics-events.js';
import {
  modifierMask,
  mouseButton,
  parseKeyCombination,
  type CdpMouseButton,
  type KeyCombination,
} from './input.js';
import {
  InputController,
  type CoordinateInputCommand,
} from './input-controller.js';
import { PAGE_COMMAND_SOURCE } from './page-command.js';
import {
  NetworkHarRecorder,
  type NetworkHarRecorderOptions,
} from './network-har-recorder.js';
import { compatibilityInvocation } from './primitive-compatibility.js';
import {
  type Box,
  type BrowserHistoryEntry,
  type BrowserInfo,
  type BrowserPrimitive,
  type BrowserPrimitiveArgs,
  type BrowserPrimitiveExecutor,
  type BrowserPrimitiveResult,
  type BrowserSnapshotEnvelope,
  type BrowserUserTabInfo,
  type DialogInfo,
  type DispatchResult,
  type ScreenshotEnvelope,
  type TabInfo,
} from './primitives.js';
import { commandSchemas, type SupportedCommand } from './schemas.js';
import { TabOperationCoordinator } from './tab-operation-coordinator.js';
import { TabRegistry } from './tab-registry.js';

export interface ChromeRuntimeOptions extends ChromeExtensionTransportOptions {
  allowedOrigins?: readonly string[];
  /** Directories the agent may upload files from; uploads are refused when unset. */
  uploadRoots?: readonly string[];
  /** Trusted host path for a crash-recoverable WebArena-compatible HAR trace. */
  networkTracePath?: string;
  /** Bounds the trusted network journal without exposing the setting to the model. */
  networkRecorderOptions?: NetworkHarRecorderOptions;
  /** Adapter-owned model documentation returned by the legacy dispatch facade. */
  documentation?: string;
  bridge?: ChromeBridge;
}

export type {
  Box,
  BrowserHistoryEntry,
  BrowserInfo,
  BrowserSnapshotEnvelope,
  BrowserUserTabInfo,
  DialogInfo,
  DispatchResult,
  LogEntry,
  NetworkEntry,
  ScreenshotEnvelope,
  TabInfo,
} from './primitives.js';

export { normalizeUrl, urlMatches } from './chrome-runtime-values.js';

interface DiscoveredTab extends BrowserUserTabInfo {
  providerTabId: number;
}

interface ClaimedTab {
  id: string;
  providerTabId: number;
  state: TabState;
}

/**
 * Where a page command runs and how its DOM coordinates map to the tab's
 * viewport. `origin` is the absolute position (main-frame CSS px) of the
 * frame's content box; `sessionOrigin` is the same for the root frame of the
 * debugger session, i.e. the offset to add to DOM.* results from that session.
 */
interface FrameTarget {
  sessionId: string | undefined;
  contextId: number | undefined;
  origin: { x: number; y: number };
  sessionOrigin: { x: number; y: number };
  depth: number;
}

interface LocatorPlan {
  target: FrameTarget;
  steps: unknown[];
}

const MAIN_FRAME_TARGET: FrameTarget = {
  sessionId: undefined,
  contextId: undefined,
  origin: { x: 0, y: 0 },
  sessionOrigin: { x: 0, y: 0 },
  depth: 0,
};

// Input.dispatchMouseEvent is acknowledged by the browser process before the
// target renderer is guaranteed to have run the corresponding DOM event. A
// task posted in the destination frame gives click handlers (and dialogs they
// open) a deterministic completion point before the command returns.
const INPUT_COMPLETION_BARRIER_EXPRESSION =
  '/* __qwenBrowserInputBarrier */ new Promise((resolve) => setTimeout(resolve, 0))';
const SCROLL_PRESENTATION_BARRIER_EXPRESSION =
  '/* __qwenBrowserScrollBarrier */ new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))';
const MAX_FRAME_DEPTH = 5;

interface HandleRequirements {
  visible?: boolean;
  enabled?: boolean;
  editable?: boolean;
}

interface ElementPoint {
  x: number;
  y: number;
  box: Box;
}

type Args = Record<string, unknown>;

const BROWSER_ID = 'user-chrome';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LOCATOR_READ_TIMEOUT_MS = 1_000;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_NAVIGATION_EXPECTATIONS_PER_TAB = 100;
const EXPIRED_NAVIGATION_EXPECTATION_RETENTION_MS = 60_000;
// CDP methods that must run while a JavaScript dialog is open.
const DIALOG_SAFE_METHODS = new Set([
  'Page.handleJavaScriptDialog',
  'Page.enable',
  'Runtime.enable',
  'Network.enable',
  'Network.getResponseBody',
  'Browser.setDownloadBehavior',
  'Emulation.setFocusEmulationEnabled',
  'Runtime.releaseObject',
  'Target.setAutoAttach',
]);
const LOCATOR_READ_METHODS: ReadonlySet<SupportedCommand> = new Set([
  'locator.allTextContents',
  'locator.innerText',
  'locator.textContent',
  'locator.getAttribute',
  'locator.isEnabled',
  'locator.isVisible',
  'locator.isChecked',
  'locator.inputValue',
  'locator.boundingBox',
]);

export class ChromeRuntime implements BrowserPrimitiveExecutor {
  readonly browserId = BROWSER_ID;

  private readonly bridge: ChromeBridge;
  private readonly allowedOrigins: ReadonlySet<string> | undefined;
  private readonly uploadRoots: readonly string[] | undefined;
  private readonly networkRecorder: NetworkHarRecorder | undefined;
  private readonly adapterDocumentation: string;
  private readonly tabOperations = new TabOperationCoordinator();
  private readonly inputController: InputController<ClaimedTab, FrameTarget>;
  private readonly discoveredTabs = new Map<string, DiscoveredTab>();
  private readonly claimedTabs = new TabRegistry<ClaimedTab>();
  private sessionName: string | undefined;
  private selectedTabId: string | undefined;
  private stopped = false;
  private readonly pendingNetworkBodyCaptures = new Set<Promise<void>>();

  constructor(options: ChromeRuntimeOptions = {}) {
    this.bridge = options.bridge ?? new ChromeExtensionTransport(options);
    this.allowedOrigins = parseAllowedOrigins(options.allowedOrigins);
    this.uploadRoots = parseUploadRoots(options.uploadRoots);
    this.networkRecorder =
      options.networkTracePath === undefined
        ? undefined
        : new NetworkHarRecorder(
            options.networkTracePath,
            options.networkRecorderOptions,
          );
    this.adapterDocumentation =
      options.documentation ?? DEFAULT_CHROME_DOCUMENTATION;
    this.inputController = new InputController(
      async (tab, method, params) => await this.cdp(tab, method, params),
      async (tab, target) => await this.inputCompletionBarrier(tab, target),
      async (tab, target) =>
        await this.rendererBarrier(
          tab,
          target,
          SCROLL_PRESENTATION_BARRIER_EXPRESSION,
        ),
    );
    this.bridge.onEvent((event) => this.handleBridgeEvent(event));
    this.bridge.onConnectionChange((connected) => {
      if (connected) return;
      for (const tab of this.claimedTabs.values()) {
        // Events emitted while Native Messaging is reconnecting cannot be
        // replayed. Discard the discontinuous buffers and lazily re-attach +
        // re-enable every required CDP domain before the next tab command.
        tab.state.logs.length = 0;
        tab.state.network.clear();
        tab.state.hiddenNetworkEntries.clear();
        tab.state.inflight.clear();
        tab.state.loader = { domContentLoaded: false, load: false };
        renewDocumentIdentity(tab.state);
        interruptNavigationExpectations(
          tab.state,
          'the Chrome event stream disconnected',
        );
        interruptPageEventWaiters(
          tab.state,
          'the Chrome event stream disconnected',
        );
        interruptDownloads(tab.state);
        tab.state.fileChoosers.clear();
        tab.state.downloadEventsEnabled = false;
        tab.state.needsResync = true;
        this.inputController.clear(tab);
        this.tabOperations.clearTab(tab.id);
      }
    });
  }

  async start(): Promise<void> {
    if (this.stopped)
      throw new BrowserRuntimeError(
        'NOT_RUNNING',
        'A stopped ChromeRuntime cannot be restarted',
      );
    await this.bridge.start();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const tab of this.claimedTabs.values()) {
      interruptPageEventWaiters(tab.state, 'the Chrome runtime stopped');
      interruptDownloads(tab.state);
      this.inputController.clear(tab);
      this.tabOperations.clearTab(tab.id);
    }
    await this.drainNetworkBodyCaptures();
    if (this.bridge.isConnected()) {
      await Promise.allSettled(
        [...this.claimedTabs.values()].map(async (tab) =>
          this.bridge.request(
            'tabs.detach',
            { tabId: tab.providerTabId },
            2_000,
          ),
        ),
      );
    }
    this.claimedTabs.clear();
    this.discoveredTabs.clear();
    try {
      await this.bridge.stop();
    } finally {
      await this.networkRecorder?.close();
    }
  }

  async dispatch(method: string, args: unknown): Promise<DispatchResult> {
    const schema = commandSchemas[method as SupportedCommand];
    if (schema === undefined)
      throw new BrowserRuntimeError(
        'UNKNOWN_METHOD',
        `Unknown Chrome runtime method: ${method}`,
      );
    let parsed: Args;
    try {
      parsed = schema.parse(args) as Args;
    } catch (error) {
      if (error instanceof ZodError) throw invalidArguments(method, error);
      throw error;
    }

    await this.start();
    const command = method as SupportedCommand;
    try {
      return await this.tabOperations.run(command, parsed, async () => {
        const tab =
          typeof parsed.tabId === 'string'
            ? this.claimed(parsed.tabId)
            : undefined;
        if (tab !== undefined) {
          await this.ensureTabSynchronized(tab);
          if (command !== 'tab.goto' && command !== 'tab.close') {
            await this.assertCurrentOriginAllowed(tab);
          }
        }
        const result = await this.execute(command, parsed);
        if (tab !== undefined && command !== 'tab.close') {
          await this.assertCurrentOriginAllowed(tab);
        }
        return result;
      });
    } catch (error) {
      throw sanitizeOperationError(method, error);
    }
  }

  async executePrimitive<P extends BrowserPrimitive>(
    primitive: P,
    args: BrowserPrimitiveArgs<P>,
  ): Promise<BrowserPrimitiveResult<P>> {
    const invocation = compatibilityInvocation(primitive, args);
    return (await this.dispatch(
      invocation.method,
      invocation.args,
    )) as BrowserPrimitiveResult<P>;
  }

  private async execute(
    method: SupportedCommand,
    args: Args,
  ): Promise<DispatchResult> {
    switch (method) {
      case 'browsers.list':
        try {
          await this.bridge.request('ping', {}, 1_500);
          return [this.browserInfo()];
        } catch (error) {
          if (
            error instanceof BrowserRuntimeError &&
            error.code === 'BROWSER_DISCONNECTED'
          )
            return [];
          throw error;
        }
      case 'browsers.get':
        this.assertBrowser(this.stringArg(args, 'id'));
        await this.bridge.request('ping');
        return this.browserInfo();
      case 'browser.documentation':
        this.assertBrowser(this.stringArg(args, 'browserId'));
        return this.documentation();
      case 'browser.nameSession':
        this.assertBrowser(this.stringArg(args, 'browserId'));
        {
          const name = this.stringArg(args, 'name');
          await this.bridge.request('session.name', { name });
          this.sessionName = name;
        }
        return null;
      case 'browser.user.openTabs':
        this.assertBrowser(this.stringArg(args, 'browserId'));
        return await this.openTabs();
      case 'browser.user.claimTab':
        this.assertBrowser(this.stringArg(args, 'browserId'));
        return await this.claimTab(args.tab);
      case 'browser.user.history':
        this.assertBrowser(this.stringArg(args, 'browserId'));
        return await this.history(args.options);
      case 'tabs.new': {
        this.assertBrowser(this.stringArg(args, 'browserId'));
        const provider = providerTab(await this.bridge.request('tabs.create'));
        return await this.prepareClaim(provider);
      }
      case 'tabs.list':
        this.assertBrowser(this.stringArg(args, 'browserId'));
        return await this.listClaimedTabs();
      case 'tabs.get':
        this.assertBrowser(this.stringArg(args, 'browserId'));
        return await this.tabInfo(this.claimed(this.stringArg(args, 'tabId')));
      case 'tabs.selected': {
        this.assertBrowser(this.stringArg(args, 'browserId'));
        if (this.selectedTabId === undefined) return null;
        const selected = this.claimedTabs.get(this.selectedTabId);
        if (selected === undefined) return null;
        return await this.tabInfo(selected);
      }
      case 'tab.activate': {
        const tab = this.tabFromArgs(args);
        await this.bridge.request('tabs.activate', {
          tabId: tab.providerTabId,
        });
        this.selectedTabId = tab.id;
        return null;
      }
      case 'tab.goto': {
        const tab = this.tabFromArgs(args);
        const url = this.stringArg(args, 'url');
        this.assertAllowedNavigationUrl(url);
        const commitWaiterId = this.beginNavigationCommit(tab, args);
        tab.state.loader = { domContentLoaded: false, load: false };
        try {
          const result = objectValue(
            await this.cdp(tab, 'Page.navigate', { url }),
          );
          if (typeof result.errorText === 'string' && result.errorText !== '') {
            throw new BrowserRuntimeError(
              'OPERATION_FAILED',
              `Chrome navigation failed: ${result.errorText}`,
            );
          }
          const remaining = await this.waitForNavigationCommit(
            tab,
            commitWaiterId,
          );
          if (args.waitUntil !== 'commit')
            await this.waitForLoadState(tab, args.waitUntil, remaining);
        } catch (error) {
          this.cancelNavigationExpectation(tab, commitWaiterId);
          throw error;
        }
        return null;
      }
      case 'tab.url':
        return (await this.tabInfo(this.tabFromArgs(args))).url;
      case 'tab.title':
        return (await this.tabInfo(this.tabFromArgs(args))).title;
      case 'tab.back':
        await this.navigateHistory(this.tabFromArgs(args), -1, args);
        return null;
      case 'tab.forward':
        await this.navigateHistory(this.tabFromArgs(args), 1, args);
        return null;
      case 'tab.reload': {
        const tab = this.tabFromArgs(args);
        const commitWaiterId = this.beginNavigationCommit(tab, args);
        tab.state.loader = { domContentLoaded: false, load: false };
        try {
          await this.cdp(tab, 'Page.reload', {});
          const remaining = await this.waitForNavigationCommit(
            tab,
            commitWaiterId,
          );
          if (args.waitUntil !== 'commit')
            await this.waitForLoadState(tab, args.waitUntil, remaining);
        } catch (error) {
          this.cancelNavigationExpectation(tab, commitWaiterId);
          throw error;
        }
        return null;
      }
      case 'tab.close': {
        const tab = this.tabFromArgs(args);
        interruptPageEventWaiters(tab.state, 'the tab was closed');
        interruptDownloads(tab.state);
        this.inputController.clear(tab);
        this.tabOperations.clearTab(tab.id);
        await this.bridge.request('tabs.close', { tabId: tab.providerTabId });
        this.claimedTabs.delete(tab.id);
        if (this.selectedTabId === tab.id) this.selectedTabId = undefined;
        return null;
      }
      case 'tab.screenshot':
        return await this.captureScreenshot(this.tabFromArgs(args), args);
      case 'tab.getJsDialog': {
        const dialog = this.tabFromArgs(args).state.dialog;
        return dialog === undefined
          ? null
          : {
              type: dialog.type,
              message: dialog.message,
              defaultPrompt: dialog.defaultPrompt,
            };
      }
      case 'tab.dialog.accept':
      case 'tab.dialog.dismiss': {
        const tab = this.tabFromArgs(args);
        if (tab.state.dialog === undefined)
          throw new BrowserRuntimeError(
            'NOT_FOUND',
            'No JavaScript dialog is open on this tab',
          );
        const accept = method === 'tab.dialog.accept';
        await this.cdp(
          tab,
          'Page.handleJavaScriptDialog',
          {
            accept,
            ...(accept && typeof args.promptText === 'string'
              ? { promptText: args.promptText }
              : {}),
          },
          5_000,
          tab.state.dialog.sessionId,
        );
        tab.state.dialog = undefined;
        return null;
      }
      case 'dev.logs': {
        const state = this.tabFromArgs(args).state;
        return readConsoleDiagnostics(state, args);
      }
      case 'dev.network': {
        const state = this.tabFromArgs(args).state;
        return readNetworkDiagnostics(state, args);
      }
      case 'playwright.domSnapshot':
        return await this.snapshotWithFrames(this.tabFromArgs(args), args);
      case 'playwright.domSnapshotWithMetadata':
        return await this.snapshotWithMetadata(this.tabFromArgs(args), args);
      case 'playwright.evaluate':
        return await this.evaluateInPage(
          this.tabFromArgs(args),
          this.stringArg(args, 'script'),
          this.timeoutArg(args),
        );
      case 'playwright.waitForEvent':
        return await this.waitForPageEvent(
          this.tabFromArgs(args),
          this.stringArg(args, 'event') as PlaywrightPageEvent,
          this.timeoutArg(args),
        );
      case 'fileChooser.setFiles':
        await this.setFileChooserFiles(this.tabFromArgs(args), args);
        return null;
      case 'download.events':
        return await this.readDownloadEvents(
          this.tabFromArgs(args),
          args.clear === true,
        );
      case 'download.path':
        return await this.downloadPath(this.tabFromArgs(args), args);
      case 'playwright.waitForURL':
        await this.waitForURL(
          this.tabFromArgs(args),
          this.stringArg(args, 'url'),
          this.timeoutArg(args),
        );
        return null;
      case 'playwright.expectNavigation.begin':
        return this.beginNavigationExpectation(this.tabFromArgs(args), args);
      case 'playwright.expectNavigation.wait':
        await this.waitForNavigationExpectation(
          this.tabFromArgs(args),
          this.stringArg(args, 'waiterId'),
        );
        return null;
      case 'playwright.expectNavigation.cancel':
        this.cancelNavigationExpectation(
          this.tabFromArgs(args),
          this.stringArg(args, 'waiterId'),
        );
        return null;
      case 'playwright.waitForLoadState':
        await this.waitForLoadState(
          this.tabFromArgs(args),
          args.state,
          this.timeoutArg(args),
        );
        return null;
      case 'playwright.waitForTimeout':
        await delay(this.numberArg(args, 'timeoutMs'));
        return null;
      default:
        if (method.startsWith('locator.'))
          return await this.executeLocator(method, args);
        if (method.startsWith('dom_cua.'))
          return await this.executeDomCUA(method, args);
        if (method.startsWith('cua.'))
          return await this.executeCUA(method, args);
        throw new BrowserRuntimeError(
          'UNKNOWN_METHOD',
          `Unknown Chrome runtime method: ${method}`,
        );
    }
  }

  // DOM CUA retains a distinct public command for audit/telemetry, then lowers
  // the ref to the same locator primitive used by semantic actions.
  private async executeDomCUA(
    method: SupportedCommand,
    args: Args,
  ): Promise<DispatchResult> {
    const tabId = this.stringArg(args, 'tabId');
    const tab = this.tabFromArgs(args);
    this.assertExpectedDocument(tab, args);
    if (method === 'dom_cua.get_visible_dom') {
      return await this.snapshotWithFrames(tab, args);
    }
    const steps = [{ kind: 'ref', ref: this.stringArg(args, 'nodeId') }];
    const timeout =
      typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {};
    const documentGuard =
      typeof args.expectedDocumentId === 'string'
        ? { expectedDocumentId: args.expectedDocumentId }
        : {};
    switch (method) {
      case 'dom_cua.click':
        return await this.executeLocator('locator.click', {
          tabId,
          steps,
          ...timeout,
          ...documentGuard,
          ...(args.button === undefined ? {} : { button: args.button }),
          ...(args.modifiers === undefined
            ? {}
            : { modifiers: args.modifiers }),
          ...(args.force === true ? { force: true } : {}),
          ...(typeof args.clickCount === 'number'
            ? { clickCount: args.clickCount }
            : {}),
        });
      case 'dom_cua.double_click':
        return await this.executeLocator('locator.dblclick', {
          tabId,
          steps,
          ...timeout,
          ...documentGuard,
          ...(args.modifiers === undefined
            ? {}
            : { modifiers: args.modifiers }),
          ...(args.force === true ? { force: true } : {}),
        });
      case 'dom_cua.hover':
        return await this.executeLocator('locator.hover', {
          tabId,
          steps,
          ...timeout,
          ...documentGuard,
        });
      case 'dom_cua.type':
        return await this.executeLocator('locator.type', {
          tabId,
          steps,
          value: this.stringArg(args, 'text'),
          ...timeout,
          ...documentGuard,
        });
      case 'dom_cua.keypress':
        return await this.executeLocator('locator.press', {
          tabId,
          steps,
          value: (args.keys as unknown[]).map(String).join('+'),
          ...timeout,
          ...documentGuard,
        });
      case 'dom_cua.scroll':
        return await this.executeLocator('locator.scroll', {
          tabId,
          steps,
          scrollX: this.numberArg(args, 'scrollX'),
          scrollY: this.numberArg(args, 'scrollY'),
          ...timeout,
          ...documentGuard,
        });
      case 'dom_cua.screenshot':
        return await this.executeLocator('locator.screenshot', {
          tabId,
          steps,
          ...timeout,
          ...documentGuard,
        });
      default:
        throw new BrowserRuntimeError(
          'UNKNOWN_METHOD',
          `Unknown DOM CUA method: ${method}`,
        );
    }
  }

  // --- coordinate CUA ----------------------------------------------------------
  // Fixed primitives on viewport CSS-pixel coordinates (the screenshot contract),
  // sharing the same CDP Input paths as the locator actions.

  private async executeCUA(
    method: SupportedCommand,
    args: Args,
  ): Promise<null> {
    const tab = this.tabFromArgs(args);
    try {
      const result = await this.inputController.executeCoordinate(
        method as CoordinateInputCommand,
        tab,
        args,
        MAIN_FRAME_TARGET,
      );
      if (method === 'cua.mouse_down')
        this.tabOperations.beginGesture(tab.id, 'pointer');
      if (method === 'cua.key_down')
        this.tabOperations.beginGesture(tab.id, 'keyboard');
      return result;
    } finally {
      // A release can reach Chrome before its completion barrier reports a
      // dialog or navigation error. Close the logical gesture from the actual
      // held-state, otherwise recovery actions would remain blocked forever.
      if (
        method === 'cua.mouse_up' &&
        !this.inputController.hasPointerDown(tab)
      ) {
        this.tabOperations.endGesture(tab.id, 'pointer');
      }
      if (method === 'cua.key_up' && !this.inputController.hasKeysDown(tab)) {
        this.tabOperations.endGesture(tab.id, 'keyboard');
      }
    }
  }

  private async executeLocator(
    method: SupportedCommand,
    args: Args,
  ): Promise<DispatchResult> {
    const operation = method.slice('locator.'.length);
    const tab = this.tabFromArgs(args);
    this.assertExpectedDocument(tab, args);
    const expectedDocumentId =
      typeof args.expectedDocumentId === 'string'
        ? args.expectedDocumentId
        : undefined;
    const timeout = this.timeoutArg(
      args,
      LOCATOR_READ_METHODS.has(method)
        ? DEFAULT_LOCATOR_READ_TIMEOUT_MS
        : DEFAULT_TIMEOUT_MS,
    );
    try {
      // Keep frame-hop resolution inside the public-operation error boundary:
      // stale path refs should report click/innerText/etc., not internal resolve.
      const plan = await this.planLocator(
        tab,
        args.steps as readonly unknown[],
        timeout,
        expectedDocumentId,
      );
      const { target, steps } = plan;
      switch (operation) {
        case 'evaluate':
          return await this.evaluateInPage(
            tab,
            this.stringArg(args, 'script'),
            timeout,
            steps,
            'one',
            expectedDocumentId,
            target,
          );
        case 'evaluateAll':
          return await this.evaluateInPage(
            tab,
            this.stringArg(args, 'script'),
            timeout,
            steps,
            'all',
            expectedDocumentId,
            target,
          );
        case 'click':
          return await this.clickLocator(
            tab,
            steps,
            args,
            typeof args.clickCount === 'number' ? args.clickCount : 1,
            target,
          );
        case 'dblclick':
          return await this.clickLocator(tab, steps, args, 2, target);
        case 'hover':
          return await this.withHandle(
            tab,
            steps,
            { visible: true },
            timeout,
            async (objectId) => {
              const point = await this.elementPoint(tab, objectId, target);
              await this.cdp(tab, 'Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: point.x,
                y: point.y,
                modifiers: modifierMask(
                  args.modifiers as unknown[] | undefined,
                ),
              });
              return null;
            },
            target,
            expectedDocumentId,
          );
        case 'check':
          return await this.setCheckedLocator(
            tab,
            steps,
            timeout,
            true,
            target,
            expectedDocumentId,
          );
        case 'uncheck':
          return await this.setCheckedLocator(
            tab,
            steps,
            timeout,
            false,
            target,
            expectedDocumentId,
          );
        case 'setChecked':
          return await this.setCheckedLocator(
            tab,
            steps,
            timeout,
            args.checked === true,
            target,
            expectedDocumentId,
          );
        case 'scrollIntoViewIfNeeded':
          return await this.withHandle(
            tab,
            steps,
            {},
            timeout,
            async (objectId) =>
              (await this.elementPoint(tab, objectId, target)).box,
            target,
            expectedDocumentId,
          );
        case 'scroll':
          return await this.withHandle(
            tab,
            steps,
            { visible: true },
            timeout,
            async (objectId) => {
              const point = await this.elementPoint(tab, objectId, target);
              const deltaX = this.numberArg(args, 'scrollX');
              const deltaY = this.numberArg(args, 'scrollY');
              const before = await this.callOnHandle(
                tab,
                objectId,
                SCROLL_STATE_FUNCTION,
                [],
                target.sessionId,
              );
              await this.cdp(tab, 'Input.dispatchMouseEvent', {
                type: 'mouseWheel',
                x: point.x,
                y: point.y,
                deltaX,
                deltaY,
                modifiers: 0,
              });
              await this.rendererBarrier(
                tab,
                target,
                SCROLL_PRESENTATION_BARRIER_EXPRESSION,
              );
              const afterWheel = await this.callOnHandle(
                tab,
                objectId,
                SCROLL_STATE_FUNCTION,
                [],
                target.sessionId,
              );
              if (
                safeStringify(afterWheel) === safeStringify(before) &&
                (deltaX !== 0 || deltaY !== 0)
              ) {
                await this.callOnHandle(
                  tab,
                  objectId,
                  SCROLL_FALLBACK_FUNCTION,
                  [deltaX, deltaY],
                  target.sessionId,
                );
                await this.rendererBarrier(
                  tab,
                  target,
                  SCROLL_PRESENTATION_BARRIER_EXPRESSION,
                );
              }
              const scrolled = objectValue(
                await this.pageCommand(tab, 'viewport', [], {}, 5_000, target),
              );
              return {
                scrollX: finiteNumber(scrolled.scrollX, 0),
                scrollY: finiteNumber(scrolled.scrollY, 0),
              };
            },
            target,
            expectedDocumentId,
          );
        case 'setInputFiles':
          return await this.setInputFilesLocator(
            tab,
            steps,
            args,
            timeout,
            target,
            expectedDocumentId,
          );
        case 'screenshot':
          return await this.withHandle(
            tab,
            steps,
            { visible: true },
            timeout,
            async (objectId) => {
              const point = await this.elementPoint(tab, objectId, target);
              const shot = await this.captureScreenshot(tab, {
                clip: point.box,
              });
              return { ...shot, element: point.box };
            },
            target,
            expectedDocumentId,
          );
        case 'press': {
          const combination = parseKeyCombination(
            this.stringArg(args, 'value'),
          );
          const focus = objectValue(
            await this.pageCommand(
              tab,
              'focus',
              steps,
              {
                timeoutMs: timeout,
                ...(expectedDocumentId === undefined
                  ? {}
                  : { expectedDocumentId }),
              },
              timeout + 1_000,
              target,
            ),
          );
          this.assertKeyboardTargetFocused(focus);
          await this.pressCombination(tab, combination);
          return null;
        }
        case 'type': {
          const text = this.stringArg(args, 'value');
          const guardedArgs = {
            ...(expectedDocumentId === undefined ? {} : { expectedDocumentId }),
          };
          const focus = objectValue(
            await this.pageCommand(
              tab,
              'focus',
              steps,
              { timeoutMs: timeout, ...guardedArgs },
              timeout + 1_000,
              target,
            ),
          );
          this.assertKeyboardTargetFocused(focus);
          if (focus.editable !== true) {
            throw new BrowserRuntimeError(
              'INVALID_LOCATOR',
              'type requires an editable input, textarea or contenteditable element',
            );
          }
          const before = await this.pageCommand(
            tab,
            'inputValue',
            steps,
            guardedArgs,
            5_000,
            target,
          );
          await this.typeText(tab, text);
          if (text !== '') {
            // Chrome drops every automation input event while a tab-modal browser
            // dialog is open (for example the password-leak warning after a
            // login). Real keyboard events cannot report that, so verify the
            // effect instead of letting the model believe the text was typed.
            const after = await this.pageCommand(
              tab,
              'inputValue',
              steps,
              guardedArgs,
              5_000,
              target,
            );
            if (after === before) throw inputBlockedError();
          }
          return null;
        }
        default: {
          const pageArgs: Args = { ...args, timeoutMs: timeout };
          delete pageArgs.tabId;
          delete pageArgs.steps;
          // The page program owns the public locator timeout. Leave enough CDP
          // transport grace for its final polling iteration and exception serialization.
          return await this.pageCommand(
            tab,
            operation,
            steps,
            pageArgs,
            timeout + 2_000,
            target,
          );
        }
      }
    } catch (error) {
      throw locatorOperationError(error, operation);
    }
  }

  // --- frames --------------------------------------------------------------------

  /**
   * Split a locator plan at frame hops (frameLocator steps and path refs such
   * as "n7/n3") and resolve each hop to the document of that iframe, so the
   * remaining steps run inside the frame. Same-process frames are addressed by
   * execution context on the tab session; out-of-process iframes through the
   * child debugger session Chrome auto-attached for them. Hops are resolved
   * fresh on every command, so a frame that navigated is picked up again.
   */
  private async planLocator(
    tab: ClaimedTab,
    steps: readonly unknown[],
    timeoutMs: number,
    expectedDocumentId?: string,
  ): Promise<LocatorPlan> {
    const hops: Array<readonly unknown[]> = [];
    let segment: unknown[] = [];
    steps.forEach((step, index) => {
      const record = objectValue(step);
      if (
        index === 0 &&
        record.kind === 'ref' &&
        typeof record.ref === 'string' &&
        record.ref.includes('/')
      ) {
        const parts = record.ref.split('/');
        for (const part of parts.slice(0, -1))
          hops.push([{ kind: 'ref', ref: part }]);
        segment.push({ kind: 'ref', ref: parts.at(-1) });
        return;
      }
      if (record.kind === 'frame') {
        hops.push([
          ...segment,
          { kind: 'locator', selector: String(record.selector) },
        ]);
        segment = [];
        return;
      }
      segment.push(step);
    });
    let target = MAIN_FRAME_TARGET;
    for (const hop of hops)
      target = await this.enterFrame(
        tab,
        target,
        hop,
        timeoutMs,
        expectedDocumentId,
      );
    return { target, steps: segment };
  }

  /** Resolve `hopSteps` (inside `parent`) to an <iframe> and return the target for its document. */
  private async enterFrame(
    tab: ClaimedTab,
    parent: FrameTarget,
    hopSteps: readonly unknown[],
    timeoutMs: number,
    expectedDocumentId?: string,
  ): Promise<FrameTarget> {
    if (parent.depth >= MAX_FRAME_DEPTH) {
      throw new BrowserRuntimeError(
        'INVALID_LOCATOR',
        `frames nested deeper than ${MAX_FRAME_DEPTH} levels are not supported`,
      );
    }
    const objectId = await this.resolveHandle(
      tab,
      hopSteps,
      {},
      timeoutMs,
      parent,
      expectedDocumentId,
    );
    try {
      const node = objectValue(
        objectValue(
          await this.cdp(
            tab,
            'DOM.describeNode',
            { objectId },
            5_000,
            parent.sessionId,
          ),
        ).node,
      );
      const nodeName = String(node.nodeName ?? '').toLowerCase();
      if (nodeName !== 'iframe' && nodeName !== 'frame') {
        throw new BrowserRuntimeError(
          'INVALID_LOCATOR',
          `frameLocator must resolve to an <iframe> element, but it matched <${nodeName || 'unknown'}>`,
        );
      }
      if (typeof node.frameId !== 'string' || node.frameId === '') {
        throw new BrowserRuntimeError(
          'INVALID_LOCATOR',
          'the <iframe> has no content frame yet; wait for it to load and retry',
        );
      }
      const frameScrolled = await this.cdp(
        tab,
        'DOM.scrollIntoViewIfNeeded',
        { objectId },
        5_000,
        parent.sessionId,
      ).then(
        () => true,
        () => false,
      );
      if (frameScrolled)
        await this.rendererBarrier(
          tab,
          parent,
          SCROLL_PRESENTATION_BARRIER_EXPRESSION,
        );
      const model = objectValue(
        objectValue(
          await this.cdp(
            tab,
            'DOM.getBoxModel',
            { objectId },
            5_000,
            parent.sessionId,
          ),
        ).model,
      );
      const content = Array.isArray(model.content) ? model.content : [];
      const origin = {
        x: parent.sessionOrigin.x + finiteNumber(content[0], 0),
        y: parent.sessionOrigin.y + finiteNumber(content[1], 0),
      };
      const record = await this.waitForFrameRecord(
        tab,
        node.frameId,
        Math.min(timeoutMs, 10_000),
      );
      const sameSession = record.sessionId === parent.sessionId;
      return {
        sessionId: record.sessionId,
        contextId: record.contextId,
        origin,
        sessionOrigin: sameSession ? parent.sessionOrigin : origin,
        depth: parent.depth + 1,
      };
    } finally {
      await this.cdp(
        tab,
        'Runtime.releaseObject',
        { objectId },
        2_000,
        parent.sessionId,
      ).catch(() => undefined);
    }
  }

  /** Wait until the frame's document has an execution context we can evaluate in. */
  private async waitForFrameRecord(
    tab: ClaimedTab,
    frameId: string,
    timeoutMs: number,
  ): Promise<FrameRecord> {
    const deadline = Date.now() + Math.max(timeoutMs, 500);
    let awaitedSession: string | undefined;
    while (true) {
      const record = tab.state.frames.get(frameId);
      if (record !== undefined) {
        if (
          record.sessionId !== undefined &&
          awaitedSession !== record.sessionId
        ) {
          const child = tab.state.sessions.get(record.sessionId);
          if (child === undefined) {
            await delay(50);
            continue;
          }
          awaitedSession = record.sessionId;
          await child.ready;
          if (child.setupError !== undefined) throw child.setupError;
          continue;
        }
        if (record.contextId !== undefined) return record;
      }
      if (Date.now() >= deadline) {
        throw new BrowserRuntimeError(
          'INVALID_LOCATOR',
          "the iframe's document is not reachable yet (still loading, sandboxed, or not attachable); retry once it has loaded",
        );
      }
      await delay(50);
    }
  }

  /** Enable the CDP domains on an auto-attached child target (out-of-process iframe). */
  private async prepareChildSession(
    tab: ClaimedTab,
    sessionId: string,
  ): Promise<void> {
    const results = await Promise.allSettled([
      this.cdp(tab, 'Runtime.enable', {}, 5_000, sessionId),
      this.cdp(tab, 'Page.enable', {}, 5_000, sessionId),
      this.cdp(tab, 'Network.enable', {}, 5_000, sessionId),
      this.cdp(
        tab,
        'Emulation.setFocusEmulationEnabled',
        { enabled: true },
        5_000,
        sessionId,
      ),
      this.cdp(
        tab,
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        5_000,
        sessionId,
      ),
    ]);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure !== undefined) throw failure.reason;
  }

  private async snapshotWithFrames(
    tab: ClaimedTab,
    args: Args,
  ): Promise<string> {
    const filter = typeof args.filter === 'string' ? args.filter : 'all';
    const maxChars = typeof args.maxChars === 'number' ? args.maxChars : 20_000;
    let target = MAIN_FRAME_TARGET;
    let root: string | undefined;
    let refPrefix = '';
    const documentId =
      typeof args.documentId === 'string' ? args.documentId : undefined;
    const expectedDocumentId =
      typeof args.expectedDocumentId === 'string'
        ? args.expectedDocumentId
        : documentId;
    if (typeof args.root === 'string') {
      const parts = args.root.split('/');
      for (const hop of parts.slice(0, -1)) {
        target = await this.enterFrame(
          tab,
          target,
          [{ kind: 'ref', ref: hop }],
          DEFAULT_TIMEOUT_MS,
          expectedDocumentId,
        );
      }
      root = parts.at(-1);
      refPrefix = parts.length > 1 ? `${parts.slice(0, -1).join('/')}/` : '';
    }
    return await this.renderFrameSnapshot(
      tab,
      target,
      {
        filter,
        root,
        refPrefix,
        indent: 0,
        footer: true,
        documentId,
        expectedDocumentId,
        viewportOnly: args.viewportOnly === true,
      },
      maxChars,
    );
  }

  private async snapshotWithMetadata(
    tab: ClaimedTab,
    args: Args,
  ): Promise<BrowserSnapshotEnvelope> {
    this.assertExpectedDocument(tab, args);
    const documentId = tab.state.documentId;
    const text = await this.snapshotWithFrames(tab, { ...args, documentId });
    if (tab.state.documentId !== documentId) throw staleDocumentError();
    return { text, documentId };
  }

  private assertExpectedDocument(tab: ClaimedTab, args: Args): void {
    if (typeof args.expectedDocumentId !== 'string') return;
    if (args.expectedDocumentId !== tab.state.documentId)
      throw staleDocumentError();
  }

  /**
   * Render one document's snapshot and splice each iframe's own snapshot
   * beneath its line. The page marks iframe lines with "<<frame:REF>>"; the
   * backend resolves REF to the frame's document (any origin) and recurses.
   */
  private async renderFrameSnapshot(
    tab: ClaimedTab,
    target: FrameTarget,
    options: {
      filter: string;
      root: string | undefined;
      refPrefix: string;
      indent: number;
      footer: boolean;
      documentId: string | undefined;
      expectedDocumentId: string | undefined;
      viewportOnly: boolean;
    },
    budget: number,
  ): Promise<string> {
    const pageArgs: Args = {
      filter: options.filter,
      maxChars: Math.max(budget, 1_000),
      refPrefix: options.refPrefix,
      indent: options.indent,
      footer: options.footer,
      ...(options.viewportOnly ? { viewportOnly: true } : {}),
    };
    if (options.documentId !== undefined)
      pageArgs.documentId = options.documentId;
    if (options.expectedDocumentId !== undefined)
      pageArgs.expectedDocumentId = options.expectedDocumentId;
    if (options.root !== undefined) pageArgs.root = options.root;
    const rendered = String(
      await this.pageCommand(
        tab,
        'domSnapshot',
        [],
        pageArgs,
        DEFAULT_TIMEOUT_MS,
        target,
      ),
    );
    const output: string[] = [];
    let used = 0;
    for (const line of rendered.split('\n')) {
      const marker = /^(.*) <<frame:([^>]+)>>$/.exec(line);
      if (marker === null) {
        output.push(line);
        used += line.length + 1;
        continue;
      }
      const visible = marker[1] ?? '';
      const ref = marker[2] ?? '';
      output.push(visible);
      used += visible.length + 1;
      const childIndent =
        Math.floor((visible.length - visible.trimStart().length) / 2) + 1;
      const pad = '  '.repeat(childIndent);
      const remaining = budget - used;
      if (target.depth + 1 >= MAX_FRAME_DEPTH) {
        output.push(
          `${pad}- (frame content not expanded: nesting deeper than ${MAX_FRAME_DEPTH} levels)`,
        );
        continue;
      }
      if (remaining < 500) {
        output.push(`${pad}- (frame content omitted: maxChars reached)`);
        continue;
      }
      const lastHop = ref.split('/').at(-1) ?? ref;
      try {
        const child = await this.enterFrame(
          tab,
          target,
          [{ kind: 'ref', ref: lastHop }],
          5_000,
          options.expectedDocumentId,
        );
        const nested = await this.renderFrameSnapshot(
          tab,
          child,
          {
            filter: options.filter,
            root: undefined,
            refPrefix: `${ref}/`,
            indent: childIndent,
            footer: false,
            documentId: options.documentId,
            expectedDocumentId: options.expectedDocumentId,
            viewportOnly: options.viewportOnly,
          },
          remaining,
        );
        if (nested.trim() !== '') {
          output.push(nested);
          used += nested.length + 1;
        }
      } catch (error) {
        const reason =
          error instanceof BrowserRuntimeError
            ? error.message
            : 'unknown error';
        output.push(
          `${pad}- (frame content not accessible: ${reason.slice(0, 200)})`,
        );
      }
    }
    return output.join('\n');
  }

  // --- element handles and real mouse input ------------------------------------

  /**
   * Resolve the locator to exactly one element (waiting for the requested
   * actionability) and hand its remote-object handle to `fn`. The handle lets
   * the trusted backend drive CDP DOM/Input commands against that node instead
   * of firing synthetic DOM events inside the page.
   */
  private async withHandle<T>(
    tab: ClaimedTab,
    steps: readonly unknown[],
    requirements: HandleRequirements,
    timeoutMs: number,
    fn: (objectId: string) => Promise<T>,
    target: FrameTarget = MAIN_FRAME_TARGET,
    expectedDocumentId?: string,
  ): Promise<T> {
    const objectId = await this.resolveHandle(
      tab,
      steps,
      requirements,
      timeoutMs,
      target,
      expectedDocumentId,
    );
    try {
      return await fn(objectId);
    } finally {
      await this.cdp(
        tab,
        'Runtime.releaseObject',
        { objectId },
        2_000,
        target.sessionId,
      ).catch(() => undefined);
    }
  }

  private async resolveHandle(
    tab: ClaimedTab,
    steps: readonly unknown[],
    requirements: HandleRequirements,
    timeoutMs: number,
    target: FrameTarget = MAIN_FRAME_TARGET,
    expectedDocumentId?: string,
  ): Promise<string> {
    const expression = `(${PAGE_COMMAND_SOURCE})(${JSON.stringify({
      operation: 'resolve',
      steps,
      args: {
        timeoutMs,
        requirements,
        ...(expectedDocumentId === undefined ? {} : { expectedDocumentId }),
      },
    })})`;
    let response: Record<string, unknown>;
    try {
      response = objectValue(
        await this.cdp(
          tab,
          'Runtime.evaluate',
          {
            expression,
            awaitPromise: true,
            returnByValue: false,
            ...(target.contextId === undefined
              ? {}
              : { contextId: target.contextId }),
          },
          timeoutMs + 1_000,
          target.sessionId,
        ),
      );
    } catch (error) {
      throw transientOrOriginal(error);
    }
    if (response.exceptionDetails !== undefined)
      throw pageError(exceptionDescription(response.exceptionDetails));
    const remote = objectValue(response.result);
    if (typeof remote.objectId !== 'string')
      throw new BrowserRuntimeError(
        'OPERATION_FAILED',
        'Chrome did not return an element handle',
      );
    return remote.objectId;
  }

  private async callOnHandle(
    tab: ClaimedTab,
    objectId: string,
    functionDeclaration: string,
    args: unknown[] = [],
    sessionId?: string,
  ): Promise<unknown> {
    let response: Record<string, unknown>;
    try {
      response = objectValue(
        await this.cdp(
          tab,
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration,
            arguments: args.map((value) => ({ value })),
            returnByValue: true,
            awaitPromise: true,
          },
          5_000,
          sessionId,
        ),
      );
    } catch (error) {
      throw transientOrOriginal(error);
    }
    if (response.exceptionDetails !== undefined)
      throw pageError(exceptionDescription(response.exceptionDetails));
    return objectValue(response.result).value;
  }

  /**
   * Scroll the element into view and return the centre of its visible area in
   * viewport CSS pixels of the tab. DOM.getContentQuads answers in the
   * coordinate space of the element's debugger session: the main frame for
   * everything in the tab's process, the iframe's own viewport for an
   * out-of-process iframe, hence the sessionOrigin offset.
   */
  private async elementPoint(
    tab: ClaimedTab,
    objectId: string,
    target: FrameTarget = MAIN_FRAME_TARGET,
  ): Promise<ElementPoint> {
    try {
      await this.cdp(
        tab,
        'DOM.scrollIntoViewIfNeeded',
        { objectId },
        5_000,
        target.sessionId,
      );
      await this.rendererBarrier(
        tab,
        target,
        SCROLL_PRESENTATION_BARRIER_EXPRESSION,
      );
    } catch (error) {
      const original = transientOrOriginal(error);
      if (isTransientNavigationError(original)) throw original;
      throw new BrowserRuntimeError(
        'OPERATION_FAILED',
        'the element cannot be scrolled into view (it may be detached or not rendered)',
      );
    }
    const [quadsResult, metrics] = await Promise.all([
      this.cdp(
        tab,
        'DOM.getContentQuads',
        { objectId },
        5_000,
        target.sessionId,
      ).then(objectValue),
      this.cdp(tab, 'Page.getLayoutMetrics', {}, 5_000).then(objectValue),
    ]);
    const layout = objectValue(
      metrics.cssLayoutViewport ?? metrics.layoutViewport,
    );
    const viewportWidth = finiteNumber(
      layout.clientWidth,
      Number.POSITIVE_INFINITY,
    );
    const viewportHeight = finiteNumber(
      layout.clientHeight,
      Number.POSITIVE_INFINITY,
    );
    const quads = Array.isArray(quadsResult.quads) ? quadsResult.quads : [];
    for (const quad of quads) {
      if (!Array.isArray(quad) || quad.length < 8) continue;
      const xs = [quad[0], quad[2], quad[4], quad[6]].map(
        (value) => finiteNumber(value, 0) + target.sessionOrigin.x,
      );
      const ys = [quad[1], quad[3], quad[5], quad[7]].map(
        (value) => finiteNumber(value, 0) + target.sessionOrigin.y,
      );
      const left = Math.max(Math.min(...xs), 0);
      const top = Math.max(Math.min(...ys), 0);
      const right = Math.min(Math.max(...xs), viewportWidth);
      const bottom = Math.min(Math.max(...ys), viewportHeight);
      const width = right - left;
      const height = bottom - top;
      if (width < 1 || height < 1) continue;
      return {
        x: left + width / 2,
        y: top + height / 2,
        box: { x: left, y: top, width, height },
      };
    }
    throw new BrowserRuntimeError(
      'OPERATION_FAILED',
      'the element has no visible area inside the viewport',
    );
  }

  private async clickLocator(
    tab: ClaimedTab,
    steps: readonly unknown[],
    args: Args,
    clicks: number,
    target: FrameTarget = MAIN_FRAME_TARGET,
  ): Promise<null> {
    const timeout = this.timeoutArg(args);
    const button = mouseButton(args.button);
    const modifiers = modifierMask(args.modifiers as unknown[] | undefined);
    const force = args.force === true;
    const deadline = Date.now() + timeout;
    let blocker = '';
    while (true) {
      const remaining = Math.max(deadline - Date.now(), 100);
      const clicked = await this.withHandle(
        tab,
        steps,
        { visible: true, enabled: true },
        remaining,
        async (objectId) => {
          const kind = await this.callOnHandle(
            tab,
            objectId,
            ELEMENT_KIND_FUNCTION,
            [],
            target.sessionId,
          );
          if (kind === 'option' || kind === 'optgroup') {
            throw new BrowserRuntimeError(
              'INVALID_LOCATOR',
              'native <option> elements cannot be clicked; call selectOption(value | label) on the <select> instead',
            );
          }
          const point = await this.elementPoint(tab, objectId, target);
          if (!force) {
            // elementFromPoint runs in the element's own document, so the probe
            // point is expressed relative to that frame's viewport.
            const hit = await this.callOnHandle(
              tab,
              objectId,
              HIT_TARGET_FUNCTION,
              [point.x - target.origin.x, point.y - target.origin.y],
              target.sessionId,
            );
            if (hit !== 'ok') {
              blocker = typeof hit === 'string' ? hit : 'another element';
              return false;
            }
          }
          await this.mouseClick(
            tab,
            point.x,
            point.y,
            { button, modifiers, clicks },
            target,
          );
          return true;
        },
        target,
        typeof args.expectedDocumentId === 'string'
          ? args.expectedDocumentId
          : undefined,
      );
      if (clicked) return null;
      if (Date.now() >= deadline) {
        throw new BrowserRuntimeError(
          'OPERATION_TIMEOUT',
          `the element is covered by ${blocker} at its centre and did not become clickable within ${timeout}ms; pass force: true to click through`,
          {
            kind: 'intercepted',
            action:
              clicks === 2
                ? 'dblclick'
                : clicks === 3
                  ? 'tripleclick'
                  : 'click',
            matchCount: 1,
            visibleCount: 1,
            blocker: blocker.slice(0, 500),
          },
        );
      }
      await delay(100);
    }
  }

  private async setCheckedLocator(
    tab: ClaimedTab,
    steps: readonly unknown[],
    timeoutMs: number,
    wanted: boolean,
    target: FrameTarget = MAIN_FRAME_TARGET,
    expectedDocumentId?: string,
  ): Promise<null> {
    return await this.withHandle(
      tab,
      steps,
      { visible: true, enabled: true },
      timeoutMs,
      async (objectId) => {
        const state = objectValue(
          await this.callOnHandle(
            tab,
            objectId,
            CHECK_STATE_FUNCTION,
            [],
            target.sessionId,
          ),
        );
        if (state.kind !== 'checkable') {
          throw new BrowserRuntimeError(
            'INVALID_LOCATOR',
            'check/uncheck require a checkbox, radio, switch or aria-checked element',
          );
        }
        if (state.checked === wanted) return null;
        const point = await this.elementPoint(tab, objectId, target);
        const hit = await this.callOnHandle(
          tab,
          objectId,
          HIT_TARGET_FUNCTION,
          [point.x - target.origin.x, point.y - target.origin.y],
          target.sessionId,
        );
        if (hit !== 'ok') {
          throw new BrowserRuntimeError(
            'OPERATION_FAILED',
            `the element is covered by ${String(hit)} and cannot be toggled`,
          );
        }
        await this.mouseClick(
          tab,
          point.x,
          point.y,
          { button: 'left', modifiers: 0, clicks: 1 },
          target,
        );
        const after = objectValue(
          await this.callOnHandle(
            tab,
            objectId,
            CHECK_STATE_FUNCTION,
            [],
            target.sessionId,
          ),
        );
        if (after.checked !== wanted) {
          throw new BrowserRuntimeError(
            'OPERATION_FAILED',
            'clicking the element did not change its checked state',
          );
        }
        return null;
      },
      target,
      expectedDocumentId,
    );
  }

  private async setInputFilesLocator(
    tab: ClaimedTab,
    steps: readonly unknown[],
    args: Args,
    timeoutMs: number,
    target: FrameTarget = MAIN_FRAME_TARGET,
    expectedDocumentId?: string,
  ): Promise<null> {
    const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
    const files = await this.resolveUploadFiles(paths);
    return await this.withHandle(
      tab,
      steps,
      {},
      timeoutMs,
      async (objectId) => {
        const kind = await this.callOnHandle(
          tab,
          objectId,
          ELEMENT_KIND_FUNCTION,
          [],
          target.sessionId,
        );
        if (kind !== 'file') {
          throw new BrowserRuntimeError(
            'INVALID_LOCATOR',
            'setInputFiles requires an <input type="file"> element',
          );
        }
        await this.cdp(
          tab,
          'DOM.setFileInputFiles',
          { objectId, files },
          10_000,
          target.sessionId,
        );
        return null;
      },
      target,
      expectedDocumentId,
    );
  }

  private async resolveUploadFiles(
    paths: readonly string[],
  ): Promise<string[]> {
    const files: string[] = [];
    let totalBytes = 0;
    for (const path of paths) {
      const resolved = await this.assertUploadAllowed(path);
      const info = await stat(resolved).catch(() => undefined);
      if (info === undefined || !info.isFile()) {
        throw new BrowserRuntimeError(
          'INVALID_ARGUMENT',
          `upload path is not a readable file: ${path}`,
        );
      }
      totalBytes += info.size;
      if (totalBytes > MAX_UPLOAD_BYTES) {
        throw new BrowserRuntimeError(
          'INVALID_ARGUMENT',
          `uploads are limited to ${MAX_UPLOAD_BYTES} bytes per call`,
        );
      }
      files.push(resolved);
    }
    return files;
  }

  private async assertUploadAllowed(value: string): Promise<string> {
    if (this.uploadRoots === undefined) {
      throw new BrowserRuntimeError(
        'UPLOAD_BLOCKED',
        'File uploads are disabled for this session: configure the allowed upload roots in the host adapter',
      );
    }
    if (!isAbsolute(value))
      throw new BrowserRuntimeError(
        'INVALID_ARGUMENT',
        'upload paths must be absolute',
      );
    const real = await realpath(value).catch(() => undefined);
    if (real === undefined)
      throw new BrowserRuntimeError(
        'INVALID_ARGUMENT',
        `upload path does not exist: ${value}`,
      );
    if (
      !this.uploadRoots.some(
        (root) => real === root || real.startsWith(`${root}${sep}`),
      )
    ) {
      throw new BrowserRuntimeError(
        'UPLOAD_BLOCKED',
        `${value} is outside the allowed upload directories`,
      );
    }
    return real;
  }

  private async mouseClick(
    tab: ClaimedTab,
    x: number,
    y: number,
    options: { button: CdpMouseButton; modifiers: number; clicks: number },
    target: FrameTarget = MAIN_FRAME_TARGET,
  ): Promise<void> {
    await this.inputController.mouseClick(tab, x, y, options, target);
  }

  private async inputCompletionBarrier(
    tab: ClaimedTab,
    target: FrameTarget,
  ): Promise<void> {
    await this.rendererBarrier(
      tab,
      target,
      INPUT_COMPLETION_BARRIER_EXPRESSION,
    );
  }

  private async rendererBarrier(
    tab: ClaimedTab,
    target: FrameTarget,
    expression: string,
  ): Promise<void> {
    let response: Record<string, unknown>;
    try {
      response = objectValue(
        await this.cdp(
          tab,
          'Runtime.evaluate',
          {
            expression,
            awaitPromise: true,
            returnByValue: true,
            ...(target.contextId === undefined
              ? {}
              : { contextId: target.contextId }),
          },
          5_000,
          target.sessionId,
        ),
      );
    } catch (error) {
      throw transientOrOriginal(error);
    }
    if (response.exceptionDetails !== undefined)
      throw pageError(exceptionDescription(response.exceptionDetails));
  }

  // --- keyboard -----------------------------------------------------------

  private async pressCombination(
    tab: ClaimedTab,
    combination: KeyCombination,
  ): Promise<void> {
    await this.inputController.pressCombination(tab, combination);
  }

  private async typeText(tab: ClaimedTab, text: string): Promise<void> {
    await this.inputController.typeText(tab, text);
  }

  // --- screenshots --------------------------------------------------------

  private async captureScreenshot(
    tab: ClaimedTab,
    args: Args,
  ): Promise<ScreenshotEnvelope> {
    return await captureChromeScreenshot(tab, args, {
      cdp: async (target, method, params) =>
        await this.cdp(target, method, params),
      readViewport: async (target) =>
        await this.pageCommand(target, 'viewport', [], {}, 5_000),
    });
  }

  // --- tabs ---------------------------------------------------------------

  private async openTabs(): Promise<BrowserUserTabInfo[]> {
    const providers = providerTabs(
      await this.bridge.request('tabs.queryOpen'),
    ).filter((provider) => this.isCurrentUrlAllowed(provider.url));
    this.discoveredTabs.clear();
    return providers.map((provider) => {
      const discovered: DiscoveredTab = {
        id: `open-${randomUUID()}`,
        providerTabId: provider.providerTabId,
        title: provider.title,
        url: provider.url,
        ...(provider.lastOpened === undefined
          ? {}
          : { lastOpened: provider.lastOpened }),
        ...(provider.tabGroup === undefined
          ? {}
          : { tabGroup: provider.tabGroup }),
      };
      this.discoveredTabs.set(discovered.id, discovered);
      return {
        id: discovered.id,
        title: discovered.title,
        url: discovered.url,
        ...(discovered.lastOpened === undefined
          ? {}
          : { lastOpened: discovered.lastOpened }),
        ...(discovered.tabGroup === undefined
          ? {}
          : { tabGroup: discovered.tabGroup }),
      };
    });
  }

  private async history(value: unknown): Promise<BrowserHistoryEntry[]> {
    const options =
      value === undefined || value === null ? {} : objectValue(value);
    const entries = await this.bridge.request('history.query', {
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.queries === undefined ? {} : { queries: options.queries }),
      ...(options.from === undefined
        ? {}
        : { from: isoTimestamp(options.from, 'from') }),
      ...(options.to === undefined
        ? {}
        : { to: isoTimestamp(options.to, 'to') }),
    });
    if (!Array.isArray(entries)) {
      throw new BrowserRuntimeError(
        'OPERATION_FAILED',
        'Chrome extension returned an invalid history list',
      );
    }
    return entries.map((entry) => {
      const record = objectValue(entry);
      return {
        url: typeof record.url === 'string' ? record.url : '',
        title: typeof record.title === 'string' ? record.title : null,
        dateVisited:
          typeof record.dateVisited === 'string' ? record.dateVisited : '',
      };
    });
  }

  private async claimTab(value: unknown): Promise<TabInfo> {
    const supplied =
      typeof value === 'string' ? { id: value } : objectValue(value);
    const id = typeof supplied.id === 'string' ? supplied.id : '';
    const discovered = this.discoveredTabs.get(id);
    if (discovered === undefined) {
      throw new BrowserRuntimeError(
        'TAB_NOT_GRANTED',
        'The tab must come from a fresh browser.user.openTabs() result',
      );
    }
    if (
      ('title' in supplied && supplied.title !== discovered.title) ||
      ('url' in supplied && supplied.url !== discovered.url)
    ) {
      throw new BrowserRuntimeError(
        'STALE_TAB',
        'The supplied tab snapshot does not match the discovered Chrome tab',
      );
    }
    const current = providerTab(
      await this.bridge.request('tabs.get', {
        tabId: discovered.providerTabId,
      }),
    );
    if (current.title !== discovered.title || current.url !== discovered.url) {
      throw new BrowserRuntimeError(
        'STALE_TAB',
        'The Chrome tab changed after discovery; list open tabs again',
      );
    }
    await this.bridge.request('tabs.attach', {
      tabId: discovered.providerTabId,
    });
    return await this.prepareClaim(current);
  }

  private async prepareClaim(provider: ProviderTab): Promise<TabInfo> {
    this.assertCurrentUrlAllowed(provider.url);
    const info = this.registerClaim(provider);
    try {
      await this.prepareTab(this.claimed(info.id));
      return info;
    } catch (error) {
      const tab = this.claimedTabs.get(info.id);
      if (tab !== undefined) this.inputController.clear(tab);
      this.tabOperations.clearTab(info.id);
      this.claimedTabs.delete(info.id);
      if (this.selectedTabId === info.id) this.selectedTabId = undefined;
      await this.bridge
        .request('tabs.detach', { tabId: provider.providerTabId }, 2_000)
        .catch(() => undefined);
      throw error;
    }
  }

  /**
   * One-time setup after the debugger is attached to a claimed tab. Headless
   * and background windows do not hold OS focus, so without focus emulation
   * real keyboard events never reach document.activeElement; Playwright and
   * Puppeteer enable the same emulation for every page they drive.
   */
  private async prepareTab(tab: ClaimedTab): Promise<void> {
    const results = await Promise.allSettled([
      this.cdp(
        tab,
        'Emulation.setFocusEmulationEnabled',
        { enabled: true },
        5_000,
      ),
      this.cdp(tab, 'Page.enable', {}, 5_000),
      this.cdp(tab, 'Runtime.enable', {}, 5_000),
      this.cdp(tab, 'Network.enable', {}, 5_000),
      // Out-of-process iframes are separate targets; auto-attach them as flat
      // child sessions so their documents can be addressed by sessionId.
      this.cdp(
        tab,
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        5_000,
      ),
    ]);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure !== undefined) throw failure.reason;
  }

  private async ensureTabSynchronized(tab: ClaimedTab): Promise<void> {
    if (tab.state.resyncPromise !== undefined)
      return await tab.state.resyncPromise;
    if (!tab.state.needsResync) return;
    const resync = this.resyncTab(tab);
    tab.state.resyncPromise = resync;
    try {
      await resync;
    } finally {
      if (tab.state.resyncPromise === resync)
        tab.state.resyncPromise = undefined;
    }
  }

  private async resyncTab(tab: ClaimedTab): Promise<void> {
    // Clear first: another disconnect during any awaited request flips the
    // flag back to true, so a subsequent command will retry the whole sync.
    tab.state.needsResync = false;
    try {
      await this.bridge.request(
        'tabs.get',
        { tabId: tab.providerTabId },
        5_000,
      );
      await this.bridge.request(
        'tabs.attach',
        { tabId: tab.providerTabId },
        5_000,
      );
      await this.prepareTab(tab);
    } catch (error) {
      tab.state.needsResync = true;
      if (
        error instanceof BrowserRuntimeError &&
        [
          'TAB_ALREADY_CLAIMED',
          'TAB_NOT_GRANTED',
          'TAB_NOT_OWNED',
          'STALE_TAB',
          'UNSUPPORTED_TAB',
        ].includes(error.code)
      ) {
        tab.state.stale =
          'the tab was unavailable when the Chrome connection was restored';
      }
      throw error;
    }
  }

  private registerClaim(provider: ProviderTab): TabInfo {
    for (const tab of this.claimedTabs.values()) {
      if (
        tab.providerTabId === provider.providerTabId &&
        tab.state.stale !== undefined
      ) {
        this.inputController.clear(tab);
        this.tabOperations.clearTab(tab.id);
        this.claimedTabs.delete(tab.id);
      }
    }
    const existing = this.claimedTabs.getByProviderId(provider.providerTabId);
    const claimed = existing ?? {
      id: `tab-${randomUUID()}`,
      providerTabId: provider.providerTabId,
      state: newTabState(provider.url),
    };
    this.claimedTabs.set(claimed);
    this.selectedTabId = claimed.id;
    return { id: claimed.id, title: provider.title, url: provider.url };
  }

  private async listClaimedTabs(): Promise<TabInfo[]> {
    const results: TabInfo[] = [];
    const previouslySelected = this.selectedTabId;
    try {
      await this.syncDerivedTabs();
      for (const claimed of [...this.claimedTabs.values()]) {
        try {
          results.push(await this.tabInfo(claimed));
        } catch (error) {
          if (
            error instanceof BrowserRuntimeError &&
            [
              'STALE_TAB',
              'TAB_ALREADY_CLAIMED',
              'TAB_NOT_GRANTED',
              'TAB_NOT_OWNED',
              'UNSUPPORTED_TAB',
            ].includes(error.code)
          ) {
            this.inputController.clear(claimed);
            this.tabOperations.clearTab(claimed.id);
            this.claimedTabs.delete(claimed.id);
            continue;
          }
          throw error;
        }
      }
      return results;
    } finally {
      this.selectedTabId =
        previouslySelected !== undefined &&
        this.claimedTabs.has(previouslySelected)
          ? previouslySelected
          : undefined;
    }
  }

  private async syncDerivedTabs(): Promise<void> {
    const providers = providerTabs(
      await this.bridge.request('tabs.queryDerived'),
    );
    const claimedProviderIds = (): Set<number> =>
      new Set([...this.claimedTabs.values()].map((tab) => tab.providerTabId));
    let progressed = true;
    while (progressed) {
      progressed = false;
      const claimed = claimedProviderIds();
      for (const provider of providers) {
        if (
          provider.derivedFromProviderTabId === undefined ||
          claimed.has(provider.providerTabId) ||
          !claimed.has(provider.derivedFromProviderTabId)
        )
          continue;
        await this.prepareClaim(provider);
        progressed = true;
      }
    }
  }

  private async tabInfo(claimed: ClaimedTab): Promise<TabInfo> {
    const current = providerTab(
      await this.bridge.request('tabs.get', { tabId: claimed.providerTabId }),
    );
    this.assertCurrentUrlAllowed(current.url);
    this.selectedTabId = claimed.id;
    return { id: claimed.id, title: current.title, url: current.url };
  }

  // --- navigation and waiting ----------------------------------------------

  private async navigateHistory(
    tab: ClaimedTab,
    offset: number,
    args: Args,
  ): Promise<void> {
    const history = objectValue(
      await this.cdp(tab, 'Page.getNavigationHistory', {}),
    );
    const entries = Array.isArray(history.entries) ? history.entries : [];
    const currentIndex =
      typeof history.currentIndex === 'number' ? history.currentIndex : -1;
    const target = entries[currentIndex + offset];
    const targetObject = objectValue(target);
    if (typeof targetObject.id !== 'number') return;
    const commitWaiterId = this.beginNavigationCommit(tab, args);
    tab.state.loader = { domContentLoaded: false, load: false };
    try {
      await this.cdp(tab, 'Page.navigateToHistoryEntry', {
        entryId: targetObject.id,
      });
      const remaining = await this.waitForNavigationCommit(tab, commitWaiterId);
      if (args.waitUntil !== 'commit')
        await this.waitForLoadState(tab, args.waitUntil, remaining);
    } catch (error) {
      this.cancelNavigationExpectation(tab, commitWaiterId);
      throw error;
    }
  }

  private async waitForURL(
    tab: ClaimedTab,
    expected: string,
    timeoutMs: number,
  ): Promise<void> {
    const started = Date.now();
    while (true) {
      const current = (await this.tabInfo(tab)).url ?? '';
      if (urlMatches(current, expected)) return;
      if (Date.now() - started >= timeoutMs) {
        throw new BrowserRuntimeError(
          'OPERATION_TIMEOUT',
          `Timed out after ${timeoutMs}ms waiting for the URL to match ${expected}; current URL is ${current}`,
        );
      }
      await delay(100);
    }
  }

  private beginNavigationExpectation(tab: ClaimedTab, args: Args): string {
    const state = tab.state;
    const now = Date.now();
    for (const [id, expectation] of state.navigationExpectations) {
      if (
        now - expectation.deadline >
        EXPIRED_NAVIGATION_EXPECTATION_RETENTION_MS
      ) {
        state.navigationExpectations.delete(id);
      }
    }
    while (
      state.navigationExpectations.size >= MAX_NAVIGATION_EXPECTATIONS_PER_TAB
    ) {
      const oldestId = state.navigationExpectations.keys().next().value;
      if (oldestId === undefined) break;
      const oldest = state.navigationExpectations.get(oldestId);
      if (oldest !== undefined) {
        oldest.interrupted =
          'too many navigation expectations were armed on this tab';
        signalNavigationExpectation(oldest);
      }
      state.navigationExpectations.delete(oldestId);
    }
    const id = `navigation-${randomUUID()}`;
    state.navigationExpectations.set(id, {
      id,
      afterSequence: state.navigationSequence,
      deadline: now + this.timeoutArg(args),
      expectedUrl: typeof args.url === 'string' ? args.url : undefined,
      waitUntil:
        typeof args.waitUntil === 'string'
          ? (args.waitUntil as NavigationExpectation['waitUntil'])
          : 'load',
      matchedUrl: undefined,
      interrupted: undefined,
      signals: new Set(),
    });
    return id;
  }

  private beginNavigationCommit(tab: ClaimedTab, args: Args): string {
    return this.beginNavigationExpectation(tab, {
      timeoutMs: this.timeoutArg(args),
    });
  }

  private async waitForNavigationMatch(
    tab: ClaimedTab,
    expectation: NavigationExpectation,
  ): Promise<number> {
    while (expectation.matchedUrl === undefined) {
      this.assertTabUsable(tab);
      if (expectation.interrupted !== undefined) {
        throw new BrowserRuntimeError(
          'BROWSER_DISCONNECTED',
          `Navigation observation was interrupted: ${expectation.interrupted}`,
        );
      }
      const remaining = expectation.deadline - Date.now();
      if (remaining <= 0) throw navigationExpectationTimeout(expectation);
      await waitForNavigationSignal(expectation, remaining);
    }
    const remaining = expectation.deadline - Date.now();
    if (remaining <= 0) throw navigationExpectationTimeout(expectation);
    return remaining;
  }

  private async waitForNavigationCommit(
    tab: ClaimedTab,
    waiterId: string,
  ): Promise<number> {
    const expectation = tab.state.navigationExpectations.get(waiterId);
    if (expectation === undefined) {
      throw new BrowserRuntimeError(
        'NOT_FOUND',
        'The navigation expectation is no longer active',
      );
    }
    try {
      return await this.waitForNavigationMatch(tab, expectation);
    } finally {
      tab.state.navigationExpectations.delete(waiterId);
    }
  }

  private async waitForNavigationExpectation(
    tab: ClaimedTab,
    waiterId: string,
  ): Promise<void> {
    const expectation = tab.state.navigationExpectations.get(waiterId);
    if (expectation === undefined) {
      throw new BrowserRuntimeError(
        'NOT_FOUND',
        'The navigation expectation is no longer active',
      );
    }
    try {
      const remaining = await this.waitForNavigationMatch(tab, expectation);
      await this.waitForLoadState(tab, expectation.waitUntil, remaining);
    } finally {
      tab.state.navigationExpectations.delete(waiterId);
    }
  }

  private cancelNavigationExpectation(tab: ClaimedTab, waiterId: string): void {
    const expectation = tab.state.navigationExpectations.get(waiterId);
    if (expectation === undefined) return;
    expectation.interrupted = 'the triggering action failed';
    signalNavigationExpectation(expectation);
    tab.state.navigationExpectations.delete(waiterId);
  }

  private async waitForLoadState(
    tab: ClaimedTab,
    requested: unknown,
    timeoutMs: number,
  ): Promise<void> {
    const state = typeof requested === 'string' ? requested : 'load';
    const started = Date.now();
    let quietSince: number | undefined;
    while (true) {
      this.assertTabUsable(tab);
      // Page lifecycle events pushed by the extension answer first; the
      // readyState probe covers tabs claimed after they finished loading.
      let ready =
        state === 'domcontentloaded'
          ? tab.state.loader.domContentLoaded || tab.state.loader.load
          : tab.state.loader.load;
      if (!ready) {
        let readyState: unknown = 'loading';
        try {
          readyState = await this.pageCommand(tab, 'readyState', [], {}, 5_000);
        } catch (error) {
          // The document is being replaced; keep polling until the new one answers.
          if (!isTransientNavigationError(error)) throw error;
        }
        ready =
          state === 'domcontentloaded'
            ? readyState === 'interactive' || readyState === 'complete'
            : readyState === 'complete';
      }
      if (ready) {
        if (state !== 'networkidle') return;
        if (this.activeRequests(tab.state) === 0) {
          quietSince ??= Date.now();
          if (Date.now() - quietSince >= 500) return;
        } else {
          quietSince = undefined;
        }
      }
      if (Date.now() - started >= timeoutMs) {
        throw new BrowserRuntimeError(
          'OPERATION_TIMEOUT',
          `Timed out after ${timeoutMs}ms waiting for the "${state}" load state`,
        );
      }
      await delay(100);
    }
  }

  /**
   * Requests that still block "networkidle". A fetch whose body the page never
   * reads gets responseReceived but no loadingFinished until it is garbage
   * collected, so a response that has been pending for over a second no
   * longer counts; requests without any response still do.
   */
  private activeRequests(state: TabState): number {
    const now = Date.now();
    let active = 0;
    for (const respondedAt of state.inflight.values()) {
      if (respondedAt === undefined || now - respondedAt < 1_000) active += 1;
    }
    return active;
  }

  // --- page events ----------------------------------------------------------

  private async waitForPageEvent(
    tab: ClaimedTab,
    event: PlaywrightPageEvent,
    timeoutMs: number,
  ): Promise<DispatchResult> {
    const state = tab.state;
    let waiter!: PageEventWaiter;
    const pending = new Promise<DispatchResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pageEventWaiters.delete(waiter);
        reject(
          new BrowserRuntimeError(
            'OPERATION_TIMEOUT',
            `Timed out after ${timeoutMs}ms waiting for the "${event}" event`,
          ),
        );
      }, timeoutMs);
      waiter = { event, resolve, reject, timer };
      state.pageEventWaiters.add(waiter);
    });
    // If enabling the corresponding CDP event fails, the pending waiter is
    // removed below and must never become an unhandled rejection.
    pending.catch(() => undefined);

    try {
      if (event === 'filechooser') {
        await this.cdp(
          tab,
          'Page.setInterceptFileChooserDialog',
          { enabled: true },
          5_000,
        );
      } else await this.enableDownloadEvents(tab);
      return await pending;
    } finally {
      clearTimeout(waiter.timer);
      state.pageEventWaiters.delete(waiter);
      if (
        event === 'filechooser' &&
        ![...state.pageEventWaiters].some(
          (candidate) => candidate.event === 'filechooser',
        ) &&
        state.stale === undefined
      ) {
        await this.cdp(
          tab,
          'Page.setInterceptFileChooserDialog',
          { enabled: false },
          5_000,
        ).catch(() => undefined);
      }
    }
  }

  private async enableDownloadEvents(tab: ClaimedTab): Promise<void> {
    if (tab.state.downloadEventsEnabled) return;
    try {
      await this.cdp(
        tab,
        'Browser.setDownloadBehavior',
        {
          behavior: 'default',
          eventsEnabled: true,
        },
        5_000,
      );
    } catch (error) {
      // chrome.debugger exposes the stable 1.3 command surface and may not
      // include the experimental Browser-domain method. Page.enable (part of
      // normal tab setup) still emits the legacy Page download events.
      if (
        !(error instanceof Error) ||
        !/wasn't found|not found|-32601/i.test(error.message)
      )
        throw error;
    }
    tab.state.downloadEventsEnabled = true;
  }

  private async readDownloadEvents(
    tab: ClaimedTab,
    clear: boolean,
  ): Promise<DispatchResult> {
    await this.enableDownloadEvents(tab);
    const events = tab.state.downloadEvents.map((event) => ({ ...event }));
    if (clear) tab.state.downloadEvents.length = 0;
    return events;
  }

  private async setFileChooserFiles(
    tab: ClaimedTab,
    args: Args,
  ): Promise<void> {
    const chooserId = this.stringArg(args, 'chooserId');
    const chooser = tab.state.fileChoosers.get(chooserId);
    if (chooser === undefined) {
      throw new BrowserRuntimeError(
        'NOT_FOUND',
        'The file chooser is stale or no longer belongs to this tab',
      );
    }
    const paths = Array.isArray(args.files) ? args.files.map(String) : [];
    const files = await this.resolveUploadFiles(paths);
    if (!chooser.multiple && files.length > 1) {
      throw new BrowserRuntimeError(
        'INVALID_ARGUMENT',
        'This file chooser accepts only one file',
      );
    }
    await this.cdp(
      tab,
      'DOM.setFileInputFiles',
      {
        backendNodeId: chooser.backendNodeId,
        files,
      },
      this.timeoutArg(args),
    );
    tab.state.fileChoosers.delete(chooserId);
  }

  private async downloadPath(
    tab: ClaimedTab,
    args: Args,
  ): Promise<string | null> {
    const downloadId = this.stringArg(args, 'downloadId');
    const download = tab.state.downloads.get(downloadId);
    if (download === undefined) {
      throw new BrowserRuntimeError(
        'NOT_FOUND',
        'The download is stale or no longer belongs to this tab',
      );
    }
    const deadline = Date.now() + this.timeoutArg(args);
    while (download.state === 'inProgress') {
      this.assertTabUsable(tab);
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new BrowserRuntimeError(
          'OPERATION_TIMEOUT',
          `Timed out waiting for download ${download.suggestedFilename || download.url}`,
        );
      }
      await waitForDownloadSignal(download, remaining);
    }
    if (download.state === 'canceled') {
      throw new BrowserRuntimeError(
        'OPERATION_FAILED',
        `Download was canceled: ${download.suggestedFilename || download.url}`,
      );
    }
    if (download.filePath !== undefined) return download.filePath;
    const resolved = objectValue(
      await this.bridge.request(
        'downloads.resolve',
        {
          tabId: tab.providerTabId,
          url: download.url,
          suggestedFilename: download.suggestedFilename,
          startedAt: download.startedAt,
        },
        Math.max(1_000, Math.min(5_000, deadline - Date.now())),
      ),
    );
    return resolved.state === 'complete' &&
      typeof resolved.filename === 'string'
      ? resolved.filename
      : null;
  }

  // --- page commands ---------------------------------------------------------

  /**
   * Playwright-compatible evaluation intentionally runs model-supplied
   * JavaScript in the tab's main world.
   */
  private async evaluateInPage(
    tab: ClaimedTab,
    script: string,
    timeoutMs: number,
    steps?: readonly unknown[],
    mode?: 'one' | 'all',
    expectedDocumentId?: string,
    target: FrameTarget = MAIN_FRAME_TARGET,
  ): Promise<DispatchResult> {
    let binding = '';
    if (steps !== undefined) {
      const operation = mode === 'all' ? 'resolveAll' : 'resolve';
      const variable = mode === 'all' ? 'elements' : 'element';
      const resolverArgs =
        mode === 'all'
          ? {
              ...(expectedDocumentId === undefined
                ? {}
                : { expectedDocumentId }),
            }
          : {
              timeoutMs,
              requirements: {},
              ...(expectedDocumentId === undefined
                ? {}
                : { expectedDocumentId }),
            };
      const resolver = `(${PAGE_COMMAND_SOURCE})(${JSON.stringify({ operation, steps, args: resolverArgs })})`;
      binding = `const ${variable} = await ${resolver};\n`;
    }
    const expression = `(async () => {\n${binding}${script}\n})()`;
    let response: Record<string, unknown>;
    try {
      response = objectValue(
        await this.cdp(
          tab,
          'Runtime.evaluate',
          {
            expression,
            awaitPromise: true,
            returnByValue: true,
            timeout: Math.max(timeoutMs, 1),
            ...(target.contextId === undefined
              ? {}
              : { contextId: target.contextId }),
          },
          Math.max(timeoutMs, 1) + 1_000,
          target.sessionId,
        ),
      );
    } catch (error) {
      throw transientOrOriginal(error);
    }
    if (response.exceptionDetails !== undefined) {
      const description = exceptionDescription(response.exceptionDetails);
      if (isPageErrorDescription(description)) {
        throw pageError(description);
      }
      throw evaluationError(description);
    }
    return remoteEvaluationValue(response.result);
  }

  private async pageCommand(
    tab: ClaimedTab,
    operation: string,
    steps: readonly unknown[],
    args: Record<string, unknown>,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    target: FrameTarget = MAIN_FRAME_TARGET,
  ): Promise<DispatchResult> {
    const expression = `(${PAGE_COMMAND_SOURCE})(${JSON.stringify({ operation, steps, args })})`;
    let response: Record<string, unknown>;
    try {
      response = objectValue(
        await this.cdp(
          tab,
          'Runtime.evaluate',
          {
            expression,
            awaitPromise: true,
            returnByValue: true,
            userGesture: isActionOperation(operation),
            ...(target.contextId === undefined
              ? {}
              : { contextId: target.contextId }),
          },
          timeoutMs,
          target.sessionId,
        ),
      );
    } catch (error) {
      throw transientOrOriginal(error);
    }
    if (response.exceptionDetails !== undefined)
      throw pageError(exceptionDescription(response.exceptionDetails));
    const remote = objectValue(response.result);
    const value = 'value' in remote ? remote.value : null;
    return jsonValue(value);
  }

  private async cdp(
    tab: ClaimedTab,
    method: string,
    params: Record<string, unknown>,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    sessionId?: string,
  ): Promise<unknown> {
    const session = sessionId === undefined ? {} : { sessionId };
    if (DIALOG_SAFE_METHODS.has(method)) {
      return await this.bridge.request(
        'cdp.send',
        { tabId: tab.providerTabId, method, params, ...session },
        timeoutMs,
      );
    }
    this.assertTabUsable(tab);
    // A JavaScript dialog blocks the renderer: any command sent while one is
    // open (or one that opens a dialog, such as a click on an alert button)
    // would hang until the timeout. Race the request against dialog events.
    const state = tab.state;
    let waiter: ((dialog: DialogInfo) => void) | undefined;
    const dialogOpened = new Promise<never>((_resolve, reject) => {
      waiter = (dialog) => reject(dialogOpenError(dialog));
      state.dialogWaiters.add(waiter);
    });
    const request = this.bridge.request(
      'cdp.send',
      { tabId: tab.providerTabId, method, params, ...session },
      timeoutMs,
    );
    request.catch(() => undefined);
    try {
      return await Promise.race([request, dialogOpened]);
    } finally {
      if (waiter !== undefined) state.dialogWaiters.delete(waiter);
    }
  }

  private assertTabUsable(tab: ClaimedTab): void {
    if (tab.state.stale !== undefined) {
      this.claimedTabs.delete(tab.id);
      throw new BrowserRuntimeError(
        'STALE_TAB',
        `The Chrome tab is no longer available: ${tab.state.stale}. Claim a tab again to continue`,
      );
    }
    if (tab.state.dialog !== undefined) throw dialogOpenError(tab.state.dialog);
  }

  // --- bridge events ---------------------------------------------------------

  private handleBridgeEvent(event: BridgeEvent): void {
    const tab = this.claimedTabs.getByProviderId(event.tabId);
    if (tab === undefined) return;
    const responseBodyRequest = this.networkRecorder?.record(event);
    if (responseBodyRequest !== undefined) {
      const capture = this.cdp(
        tab,
        'Network.getResponseBody',
        { requestId: responseBodyRequest.requestId },
        5_000,
        responseBodyRequest.sessionId,
      )
        .then((value) => {
          this.networkRecorder?.recordResponseBody(responseBodyRequest, value);
        })
        .catch(() => undefined);
      this.pendingNetworkBodyCaptures.add(capture);
      void capture.finally(() =>
        this.pendingNetworkBodyCaptures.delete(capture),
      );
    }
    applyChromeTabEvent(tab.state, event, {
      prepareChildSession: async (sessionId) =>
        await this.prepareChildSession(tab, sessionId),
      clearInputState: () => {
        this.inputController.clear(tab);
        this.tabOperations.clearTab(tab.id);
      },
    });
  }

  private async drainNetworkBodyCaptures(): Promise<void> {
    while (this.pendingNetworkBodyCaptures.size > 0) {
      await Promise.allSettled([...this.pendingNetworkBodyCaptures]);
    }
  }

  // --- helpers --------------------------------------------------------------

  private browserInfo(): BrowserInfo {
    return {
      id: this.browserId,
      name:
        this.sessionName === undefined
          ? 'User Chrome'
          : `User Chrome · ${this.sessionName}`,
      type: 'extension',
      family: 'chrome',
    };
  }

  private documentation(): string {
    const origins =
      this.allowedOrigins === undefined
        ? 'Explicit goto accepts HTTP(S) URLs. Existing user tabs must come from a fresh openTabs() result and be claimed before use.'
        : `Explicit goto is restricted to: ${[...this.allowedOrigins].join(', ')}`;
    const uploads =
      this.uploadRoots === undefined
        ? 'File uploads are disabled (the host adapter configured no allowed upload roots).'
        : `File uploads are allowed from: ${this.uploadRoots.join(', ')}`;
    return `${this.adapterDocumentation}\n\n## Navigation policy\n\n${origins}\n\n## Upload policy\n\n${uploads}`;
  }

  private claimed(id: string): ClaimedTab {
    const tab = this.claimedTabs.get(id);
    if (tab === undefined)
      throw new BrowserRuntimeError(
        'STALE_TAB',
        'No claimed Chrome tab exists for this opaque id',
      );
    if (tab.state.stale !== undefined) this.assertTabUsable(tab);
    this.selectedTabId = id;
    return tab;
  }

  private tabFromArgs(args: Args): ClaimedTab {
    return this.claimed(this.stringArg(args, 'tabId'));
  }

  private assertBrowser(id: string): void {
    if (id !== this.browserId)
      throw new BrowserRuntimeError(
        'NOT_FOUND',
        'No Chrome browser exists for the supplied id',
      );
  }

  private assertAllowedNavigationUrl(value: string): void {
    if (value === 'about:blank') return;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BrowserRuntimeError(
        'NAVIGATION_BLOCKED',
        'Navigation requires an absolute HTTP(S) URL',
      );
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username !== '' ||
      url.password !== '' ||
      (this.allowedOrigins !== undefined &&
        !this.allowedOrigins.has(url.origin))
    ) {
      throw new BrowserRuntimeError(
        'NAVIGATION_BLOCKED',
        'Navigation is outside the configured Chrome policy',
        { origin: url.origin },
      );
    }
  }

  private async assertCurrentOriginAllowed(tab: ClaimedTab): Promise<void> {
    if (this.allowedOrigins === undefined) return;
    const current = providerTab(
      await this.bridge.request('tabs.get', { tabId: tab.providerTabId }),
    );
    this.assertCurrentUrlAllowed(current.url);
  }

  private assertCurrentUrlAllowed(value: string | null): void {
    if (this.isCurrentUrlAllowed(value)) return;
    const origin = value === null ? undefined : originOf(value);
    throw new BrowserRuntimeError(
      'NAVIGATION_BLOCKED',
      'The current page is outside the configured Chrome policy',
      origin === undefined ? undefined : { origin },
    );
  }

  private isCurrentUrlAllowed(value: string | null): boolean {
    if (value === 'about:blank') return true;
    if (this.allowedOrigins === undefined) return true;
    if (value === null) return false;
    const origin = originOf(value);
    return origin !== undefined && this.allowedOrigins.has(origin);
  }

  private timeoutArg(
    args: Args,
    defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  ): number {
    return typeof args.timeoutMs === 'number'
      ? args.timeoutMs
      : defaultTimeoutMs;
  }

  private stringArg(args: Args, name: string): string {
    const value = args[name];
    if (typeof value !== 'string')
      throw new BrowserRuntimeError(
        'INVALID_ARGUMENT',
        `Missing string argument: ${name}`,
      );
    return value;
  }

  private numberArg(args: Args, name: string): number {
    const value = args[name];
    if (typeof value !== 'number')
      throw new BrowserRuntimeError(
        'INVALID_ARGUMENT',
        `Missing number argument: ${name}`,
      );
    return value;
  }

  private assertKeyboardTargetFocused(focus: Record<string, unknown>): void {
    if (focus.focused === true) return;
    throw new BrowserRuntimeError(
      'OPERATION_FAILED',
      'the target element could not be focused, so no keyboard input was sent',
    );
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
