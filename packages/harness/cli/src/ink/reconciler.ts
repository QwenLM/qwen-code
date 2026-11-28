/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

/* eslint-disable custom-rules/no-top-level-side-effects */

/// <reference path="./types.d.ts" />
import { appendFileSync } from 'fs';
import createReconciler from 'react-reconciler';
import { getYogaCounters } from './stubs/yoga-counters.js';
import {
  appendChildNode,
  clearYogaNodeReferences,
  createNode,
  createTextNode,
  type DOMElement,
  type DOMNodeAttribute,
  type ElementNames,
  insertBeforeNode,
  markDirty,
  removeChildNode,
  setAttribute,
  setStyle,
  setTextNodeValue,
  setTextStyles,
  type TextNode,
} from './dom.js';
import { Dispatcher } from './events/dispatcher.js';
import { EVENT_HANDLER_PROPS } from './events/event-handlers.js';
import { getFocusManager, getRootNode } from './focus.js';
import { LayoutDisplay } from './layout/node.js';
import applyStyles, { type Styles, type TextStyles } from './styles.js';
import { version as reactVersion } from 'react';

// We need to conditionally perform devtools connection to avoid
// accidentally breaking other third-party code.
// See https://github.com/vadimdemedes/ink/issues/384
// See https://github.com/vadimdemedes/ink/issues/648
if (process.env['DEV'] === 'true') {
  // Intentionally no warning when the package is missing.
  // DEV may be set for other reasons; devtools is opt-in via installing the package.
  let isDevtoolsInstalled = false;
  try {
    import.meta.resolve('react-devtools-core');
    isDevtoolsInstalled = true;
  } catch {}

  if (isDevtoolsInstalled) {
    // eslint-disable-next-line custom-rules/no-top-level-dynamic-import -- dev-only; DEV check is DCE'd in production
    void import('./devtools.js').catch(() => {});
  }
}

// --

type AnyObject = Record<string, unknown>;

const diff = (before: AnyObject, after: AnyObject): AnyObject | undefined => {
  if (before === after) {
    return;
  }

  if (!before) {
    return after;
  }

  const changed: AnyObject = {};
  let isChanged = false;

  for (const key of Object.keys(before)) {
    const isDeleted = after ? !Object.hasOwn(after, key) : true;

    if (isDeleted) {
      changed[key] = undefined;
      isChanged = true;
    }
  }

  if (after) {
    for (const key of Object.keys(after)) {
      if (after[key] !== before[key]) {
        changed[key] = after[key];
        isChanged = true;
      }
    }
  }

  return isChanged ? changed : undefined;
};

const cleanupYogaNode = (node: DOMElement | TextNode): void => {
  const yogaNode = node.yogaNode;
  if (yogaNode) {
    yogaNode.unsetMeasureFunc();
    // Clear all references BEFORE freeing to prevent other code from
    // accessing freed WASM memory during concurrent operations
    clearYogaNodeReferences(node);
    yogaNode.freeRecursive();
  }
};

// --

type Props = Record<string, unknown>;

type HostContext = {
  isInsideText: boolean;
};

function setEventHandler(node: DOMElement, key: string, value: unknown): void {
  if (!node._eventHandlers) {
    node._eventHandlers = {};
  }
  node._eventHandlers[key] = value;
}

/**
 * `scrollTop` is a prop-to-DOM-field bridge, not a plain attribute. The
 * renderer reads `node.scrollTop` and also mutates it on its own (clamping to
 * the content, at-bottom follow, wheel-delta drain), so the prop is written
 * through only when its value changes. The last prop value is remembered in
 * `node.attributes` — comparing against `node.scrollTop` itself would re-assert
 * a stale React value on every commit and undo the renderer's adjustments.
 */
function applyScrollTop(node: DOMElement, value: unknown): void {
  if (node.attributes['scrollTop'] === value) return;
  node.attributes['scrollTop'] = value as DOMNodeAttribute;
  if (typeof value === 'number' && Number.isFinite(value)) {
    node.scrollTop = value;
    node.pendingScrollDelta = undefined;
  } else if (value === undefined || value === null) {
    node.scrollTop = undefined;
  }
  markDirty(node);
}

function applyProp(node: DOMElement, key: string, value: unknown): void {
  if (key === 'children') return;

  if (key === 'scrollTop') {
    applyScrollTop(node, value);
    return;
  }

  if (key === 'style') {
    setStyle(node, value as Styles);
    if (node.yogaNode) {
      applyStyles(node.yogaNode, value as Styles);
    }
    return;
  }

  if (key === 'textStyles') {
    node.textStyles = value as TextStyles;
    return;
  }

  if (EVENT_HANDLER_PROPS.has(key)) {
    setEventHandler(node, key, value);
    return;
  }

  setAttribute(node, key, value as DOMNodeAttribute);
}

// --

export const dispatcher = new Dispatcher();

// --- COMMIT INSTRUMENTATION (temp debugging) ---
// eslint-disable-next-line custom-rules/no-process-env-top-level -- debug instrumentation, read-once is fine
const COMMIT_LOG = process.env['QODEER_COMMIT_LOG'];
let _commits = 0;
let _lastLog = 0;
let _lastCommitAt = 0;
let _maxGapMs = 0;
let _createCount = 0;
let _prepareAt = 0;
// --- END ---

// --- SCROLL PROFILING (bench/scroll-e2e.sh reads via getLastYogaMs) ---
// Set by onComputeLayout wrapper in ink.tsx; read by onRender for phases.
let _lastYogaMs = 0;
let _lastCommitMs = 0;
let _commitStart = 0;
export function recordYogaMs(ms: number): void {
  // Accumulated, not overwritten: a frame can lay out several times while its
  // after-layout callbacks converge, and onFrame should report the whole cost.
  _lastYogaMs += ms;
}
export function getLastYogaMs(): number {
  return _lastYogaMs;
}
export function markCommitStart(): void {
  _commitStart = performance.now();
}
export function getLastCommitMs(): number {
  return _lastCommitMs;
}
export function resetProfileCounters(): void {
  _lastYogaMs = 0;
  _lastCommitMs = 0;
  _commitStart = 0;
}
// --- END ---

const reconciler = createReconciler<
  ElementNames,
  Props,
  DOMElement,
  DOMElement,
  TextNode,
  DOMElement,
  unknown,
  unknown,
  DOMElement,
  HostContext,
  null, // UpdatePayload - not used in React 19
  NodeJS.Timeout,
  -1,
  null
>({
  getRootHostContext: () => ({ isInsideText: false }),
  prepareForCommit: () => {
    if (COMMIT_LOG) _prepareAt = performance.now();
    return null;
  },
  preparePortalMount: () => null,
  clearContainer: () => false,
  resetAfterCommit(rootNode: DOMElement) {
    _lastCommitMs = _commitStart > 0 ? performance.now() - _commitStart : 0;
    _commitStart = 0;
    if (COMMIT_LOG) {
      const now = performance.now();
      _commits++;
      const gap = _lastCommitAt > 0 ? now - _lastCommitAt : 0;
      if (gap > _maxGapMs) _maxGapMs = gap;
      _lastCommitAt = now;
      const reconcileMs = _prepareAt > 0 ? now - _prepareAt : 0;
      if (gap > 30 || reconcileMs > 20 || _createCount > 50) {
        // eslint-disable-next-line custom-rules/no-sync-fs -- debug instrumentation
        appendFileSync(
          COMMIT_LOG,
          `${now.toFixed(1)} gap=${gap.toFixed(1)}ms reconcile=${reconcileMs.toFixed(1)}ms creates=${_createCount}\n`,
        );
      }
      _createCount = 0;
      if (now - _lastLog > 1000) {
        // eslint-disable-next-line custom-rules/no-sync-fs -- debug instrumentation
        appendFileSync(
          COMMIT_LOG,
          `${now.toFixed(1)} commits=${_commits}/s maxGap=${_maxGapMs.toFixed(1)}ms\n`,
        );
        _commits = 0;
        _maxGapMs = 0;
        _lastLog = now;
      }
    }
    const _t0 = COMMIT_LOG ? performance.now() : 0;
    if (typeof rootNode.onComputeLayout === 'function') {
      rootNode.onComputeLayout();
    }
    if (COMMIT_LOG) {
      const layoutMs = performance.now() - _t0;
      if (layoutMs > 20) {
        const c = getYogaCounters();
        // eslint-disable-next-line custom-rules/no-sync-fs -- debug instrumentation
        appendFileSync(
          COMMIT_LOG,
          `${_t0.toFixed(1)} SLOW_YOGA ${layoutMs.toFixed(1)}ms visited=${c.visited} measured=${c.measured} hits=${c.cacheHits} live=${c.live}\n`,
        );
      }
    }

    if (process.env['NODE_ENV'] === 'test') {
      if (rootNode.childNodes.length === 0 && rootNode.hasRenderedContent) {
        return;
      }
      if (rootNode.childNodes.length > 0) {
        rootNode.hasRenderedContent = true;
      }
      rootNode.onImmediateRender?.();
      return;
    }

    const _tr = COMMIT_LOG ? performance.now() : 0;
    rootNode.onRender?.();
    if (COMMIT_LOG) {
      const renderMs = performance.now() - _tr;
      if (renderMs > 10) {
        // eslint-disable-next-line custom-rules/no-sync-fs -- debug instrumentation
        appendFileSync(
          COMMIT_LOG,
          `${_tr.toFixed(1)} SLOW_PAINT ${renderMs.toFixed(1)}ms\n`,
        );
      }
    }
  },
  getChildHostContext(
    parentHostContext: HostContext,
    type: ElementNames,
  ): HostContext {
    const previousIsInsideText = parentHostContext.isInsideText;
    const isInsideText =
      type === 'ink-text' || type === 'ink-virtual-text' || type === 'ink-link';

    if (previousIsInsideText === isInsideText) {
      return parentHostContext;
    }

    return { isInsideText };
  },
  shouldSetTextContent: () => false,
  createInstance(
    originalType: ElementNames,
    newProps: Props,
    _root: DOMElement,
    hostContext: HostContext,
    _internalHandle?: unknown,
  ): DOMElement {
    if (hostContext.isInsideText && originalType === 'ink-box') {
      throw new Error(`<Box> can't be nested inside <Text> component`);
    }

    const type =
      originalType === 'ink-text' && hostContext.isInsideText
        ? 'ink-virtual-text'
        : originalType;

    const node = createNode(type);
    if (COMMIT_LOG) _createCount++;

    for (const [key, value] of Object.entries(newProps)) {
      applyProp(node, key, value);
    }

    return node;
  },
  createTextInstance(
    text: string,
    _root: DOMElement,
    hostContext: HostContext,
  ): TextNode {
    if (!hostContext.isInsideText) {
      throw new Error(
        `Text string "${text}" must be rendered inside <Text> component`,
      );
    }

    return createTextNode(text);
  },
  resetTextContent() {},
  hideTextInstance(node: TextNode) {
    setTextNodeValue(node, '');
  },
  unhideTextInstance(node: TextNode, text: string) {
    setTextNodeValue(node, text);
  },
  getPublicInstance: (instance: DOMElement): DOMElement => instance,
  hideInstance(node: DOMElement) {
    node.isHidden = true;
    node.yogaNode?.setDisplay(LayoutDisplay.None);
    markDirty(node);
  },
  unhideInstance(node: DOMElement) {
    node.isHidden = false;
    node.yogaNode?.setDisplay(LayoutDisplay.Flex);
    markDirty(node);
  },
  appendInitialChild: appendChildNode,
  appendChild: appendChildNode,
  insertBefore: insertBeforeNode,
  finalizeInitialChildren(
    _node: DOMElement,
    _type: ElementNames,
    props: Props,
  ): boolean {
    return props['autoFocus'] === true;
  },
  commitMount(node: DOMElement): void {
    getFocusManager(node).handleAutoFocus(node);
  },
  isPrimaryRenderer: true,
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  rendererPackageName: 'ink',
  rendererVersion: reactVersion,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,
  getCurrentUpdatePriority: () => dispatcher.currentUpdatePriority,
  beforeActiveInstanceBlur() {},
  afterActiveInstanceBlur() {},
  detachDeletedInstance() {},
  getInstanceFromNode: () => null,
  prepareScopeUpdate() {},
  getInstanceFromScope: () => null,
  appendChildToContainer: appendChildNode,
  insertInContainerBefore: insertBeforeNode,
  removeChildFromContainer(node: DOMElement, removeNode: DOMElement): void {
    removeChildNode(node, removeNode);
    cleanupYogaNode(removeNode);
    try {
      getFocusManager(node).handleNodeRemoved(removeNode, node);
    } catch {
      // During unmount the container may already be detached from the root,
      // so walking up to find the FocusManager can fail.  Focus cleanup is
      // best-effort — the entire tree is being torn down anyway.
    }
  },
  // React 19 commitUpdate receives old and new props directly instead of an updatePayload
  commitUpdate(
    node: DOMElement,
    _type: ElementNames,
    oldProps: Props,
    newProps: Props,
  ): void {
    const props = diff(oldProps, newProps);
    const style = diff(
      oldProps['style'] as Styles,
      newProps['style'] as Styles,
    );

    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (key === 'style') {
          setStyle(node, value as Styles);
          continue;
        }

        if (key === 'textStyles') {
          setTextStyles(node, value as TextStyles);
          continue;
        }

        if (key === 'scrollTop') {
          applyScrollTop(node, value);
          continue;
        }

        if (EVENT_HANDLER_PROPS.has(key)) {
          setEventHandler(node, key, value);
          continue;
        }

        setAttribute(node, key, value as DOMNodeAttribute);
      }
    }

    if (style && node.yogaNode) {
      applyStyles(node.yogaNode, style, newProps['style'] as Styles);
    }
  },
  commitTextUpdate(node: TextNode, _oldText: string, newText: string): void {
    setTextNodeValue(node, newText);
  },
  removeChild(node: DOMElement, removeNode: DOMElement) {
    removeChildNode(node, removeNode);
    cleanupYogaNode(removeNode);
    if ((removeNode.nodeName as string) !== '#text') {
      const root = getRootNode(node);
      root.focusManager!.handleNodeRemoved(removeNode, root);
    }
  },
  // React 19 required methods
  maySuspendCommit(): boolean {
    return false;
  },
  preloadInstance(): boolean {
    return true;
  },
  startSuspendingCommit(): void {},
  suspendInstance(): void {},
  waitForCommitToBeReady(): null {
    return null;
  },
  NotPendingTransition: null,
  HostTransitionContext: {
    $$typeof: Symbol.for('react.context'),
    _currentValue: null,
  } as never,
  setCurrentUpdatePriority(newPriority: number): void {
    dispatcher.currentUpdatePriority = newPriority;
  },
  resolveUpdatePriority(): number {
    return dispatcher.resolveEventPriority();
  },
  resetFormInstance(): void {},
  requestPostPaintCallback(): void {},
  shouldAttemptEagerTransition(): boolean {
    return false;
  },
  trackSchedulerEvent(): void {},
  resolveEventType(): string | null {
    return dispatcher.currentEvent?.type ?? null;
  },
  resolveEventTimeStamp(): number {
    return dispatcher.currentEvent?.timeStamp ?? -1.1;
  },
});

// Wire the reconciler's discreteUpdates into the dispatcher.
// This breaks the import cycle: dispatcher.ts doesn't import reconciler.ts.
dispatcher.discreteUpdates = reconciler.discreteUpdates.bind(reconciler);

export default reconciler;
