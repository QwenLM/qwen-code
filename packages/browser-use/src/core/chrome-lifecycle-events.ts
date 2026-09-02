/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';

import type { BridgeEvent } from '../bridge/index.js';

import { applyDiagnosticsEvent } from './diagnostics-events.js';
import { BrowserRuntimeError } from './errors.js';
import {
  interruptDownloads,
  interruptNavigationExpectations,
  interruptPageEventWaiters,
  recordNavigation,
  rejectPageEventWaiters,
  renewDocumentIdentity,
  resolvePageEventWaiters,
  signalDownload,
  trimOldestMap,
  type ChildSession,
  type FileChooserRecord,
  type TabState,
} from './chrome-tab-state.js';
import { objectValue, originOf } from './chrome-runtime-values.js';

const MAX_EVENT_HANDLES_PER_TAB = 100;

export interface ChromeLifecycleEventHooks {
  prepareChildSession(sessionId: string): Promise<void>;
  clearInputState(): void;
}

/** Applies one pushed CDP/bridge event to the bounded state of a claimed tab. */
export function applyChromeTabEvent(
  state: TabState,
  event: BridgeEvent,
  hooks: ChromeLifecycleEventHooks,
): void {
  if (applyDiagnosticsEvent(state, event)) return;
  const params = objectValue(event.params);
  const sessionId = event.sessionId;
  switch (event.method) {
    case 'Page.fileChooserOpened': {
      const waiters = [...state.pageEventWaiters].filter(
        (waiter) => waiter.event === 'filechooser',
      );
      if (waiters.length === 0) break;
      if (sessionId !== undefined) {
        rejectPageEventWaiters(
          state,
          'filechooser',
          new BrowserRuntimeError(
            'OPERATION_FAILED',
            'File chooser events in out-of-process frames are not supported',
          ),
        );
        break;
      }
      if (
        typeof params.backendNodeId !== 'number' ||
        typeof params.frameId !== 'string'
      ) {
        rejectPageEventWaiters(
          state,
          'filechooser',
          new BrowserRuntimeError(
            'OPERATION_FAILED',
            'Chrome reported a file chooser without an input node',
          ),
        );
        break;
      }
      const chooser: FileChooserRecord = {
        id: `filechooser-${randomUUID()}`,
        backendNodeId: params.backendNodeId,
        frameId: params.frameId,
        multiple: params.mode === 'selectMultiple',
      };
      state.fileChoosers.set(chooser.id, chooser);
      trimOldestMap(state.fileChoosers, MAX_EVENT_HANDLES_PER_TAB);
      resolvePageEventWaiters(state, 'filechooser', {
        chooserId: chooser.id,
        multiple: chooser.multiple,
      });
      break;
    }
    case 'Browser.downloadWillBegin':
    case 'Page.downloadWillBegin': {
      if (typeof params.guid !== 'string' || params.guid === '') break;
      let download = [...state.downloads.values()].find(
        (candidate) => candidate.guid === params.guid,
      );
      if (download === undefined) {
        download = {
          id: `download-${randomUUID()}`,
          guid: params.guid,
          url: typeof params.url === 'string' ? params.url : '',
          suggestedFilename:
            typeof params.suggestedFilename === 'string'
              ? params.suggestedFilename
              : '',
          startedAt: Date.now(),
          state: 'inProgress',
          filePath: undefined,
          signals: new Set(),
        };
        state.downloads.set(download.id, download);
        trimSettledDownloads(state);
        pushDownloadEvent(state, {
          type: 'started',
          downloadId: download.id,
          url: download.url,
          ...(download.suggestedFilename === ''
            ? {}
            : { suggestedFilename: download.suggestedFilename }),
        });
      }
      resolvePageEventWaiters(state, 'download', { downloadId: download.id });
      break;
    }
    case 'Browser.downloadProgress':
    case 'Page.downloadProgress': {
      if (typeof params.guid !== 'string') break;
      const download = [...state.downloads.values()].find(
        (candidate) => candidate.guid === params.guid,
      );
      if (download === undefined) break;
      const previousState = download.state;
      const nextState = params.state;
      if (previousState === 'inProgress' && isDownloadState(nextState)) {
        download.state = nextState;
      }
      if (typeof params.filePath === 'string' && params.filePath !== '')
        download.filePath = params.filePath;
      if (previousState === 'inProgress' && nextState === 'completed') {
        const sizeBytes =
          nonNegativeInteger(params.receivedBytes) ??
          nonNegativeInteger(params.totalBytes);
        pushDownloadEvent(state, {
          type: 'completed',
          downloadId: download.id,
          url: download.url,
          ...(download.suggestedFilename === ''
            ? {}
            : { suggestedFilename: download.suggestedFilename }),
          ...(download.filePath === undefined
            ? {}
            : { path: download.filePath }),
          ...(sizeBytes === undefined ? {} : { sizeBytes }),
        });
      } else if (previousState === 'inProgress' && nextState === 'canceled') {
        pushDownloadEvent(state, {
          type: 'failed',
          downloadId: download.id,
          url: download.url,
          ...(download.suggestedFilename === ''
            ? {}
            : { suggestedFilename: download.suggestedFilename }),
          error: 'Download was canceled',
        });
      }
      signalDownload(download);
      trimSettledDownloads(state);
      break;
    }
    case 'Target.attachedToTarget': {
      const info = objectValue(params.targetInfo);
      const childSession =
        typeof params.sessionId === 'string' ? params.sessionId : '';
      const targetId = typeof info.targetId === 'string' ? info.targetId : '';
      if (childSession === '' || targetId === '' || info.type !== 'iframe')
        break;
      const session: ChildSession = {
        sessionId: childSession,
        targetId,
        ready: Promise.resolve(),
        setupError: undefined,
      };
      session.ready = hooks
        .prepareChildSession(childSession)
        .catch((error: unknown) => {
          session.setupError =
            error instanceof Error
              ? error
              : new BrowserRuntimeError(
                  'OPERATION_FAILED',
                  'Chrome could not prepare the iframe child session',
                );
        });
      state.sessions.set(childSession, session);
      state.frames.set(targetId, {
        frameId: targetId,
        sessionId: childSession,
        contextId: undefined,
        url: typeof info.url === 'string' ? info.url : '',
      });
      break;
    }
    case 'Target.detachedFromTarget':
      dropChildSession(
        state,
        typeof params.sessionId === 'string' ? params.sessionId : '',
      );
      break;
    case 'qwenBrowser.sessionDetached':
      dropChildSession(state, sessionId ?? '');
      break;
    case 'Runtime.executionContextCreated': {
      const context = objectValue(params.context);
      const aux = objectValue(context.auxData);
      if (
        aux.isDefault !== true ||
        typeof aux.frameId !== 'string' ||
        typeof context.id !== 'number'
      )
        break;
      const existing = state.frames.get(aux.frameId);
      state.frames.set(aux.frameId, {
        frameId: aux.frameId,
        sessionId,
        contextId: context.id,
        url: existing?.url ?? '',
      });
      break;
    }
    case 'Runtime.executionContextDestroyed': {
      const contextId = params.executionContextId;
      for (const record of state.frames.values()) {
        if (record.sessionId === sessionId && record.contextId === contextId)
          record.contextId = undefined;
      }
      break;
    }
    case 'Runtime.executionContextsCleared':
      for (const record of state.frames.values()) {
        if (record.sessionId === sessionId) record.contextId = undefined;
      }
      break;
    case 'Page.frameDetached':
      if (typeof params.frameId === 'string') {
        const record = state.frames.get(params.frameId);
        if (params.reason === 'swap') {
          // A process swap detaches the frame from its old session without
          // removing the frame itself. The new OOPIF session/context can be
          // reported before this root-session event, so never erase a record
          // that already belongs to a different session.
          if (record !== undefined && record.sessionId === sessionId)
            record.contextId = undefined;
        } else {
          state.frames.delete(params.frameId);
        }
        renewDocumentIdentity(state);
      }
      break;
    case 'Page.javascriptDialogOpening': {
      const dialog = {
        type: typeof params.type === 'string' ? params.type : 'alert',
        message:
          typeof params.message === 'string'
            ? params.message.slice(0, 4_000)
            : '',
        defaultPrompt:
          typeof params.defaultPrompt === 'string'
            ? params.defaultPrompt.slice(0, 4_000)
            : '',
        url: typeof params.url === 'string' ? params.url : '',
        ...(sessionId === undefined ? {} : { sessionId }),
      };
      state.dialog = dialog;
      for (const waiter of state.dialogWaiters) waiter(dialog);
      state.dialogWaiters.clear();
      break;
    }
    case 'Page.javascriptDialogClosed':
      state.dialog = undefined;
      break;
    case 'Page.frameNavigated': {
      renewDocumentIdentity(state);
      const frame = objectValue(params.frame);
      const frameId = typeof frame.id === 'string' ? frame.id : '';
      const record = state.frames.get(frameId);
      if (record !== undefined && typeof frame.url === 'string')
        record.url = frame.url;
      if (sessionId !== undefined || frame.parentId !== undefined) break;
      state.loader = { domContentLoaded: false, load: false };
      if (typeof frame.id === 'string') state.mainFrameId = frame.id;
      const origin = originOf(typeof frame.url === 'string' ? frame.url : '');
      if (origin !== state.origin) {
        state.network.clear();
        state.hiddenNetworkEntries.clear();
        state.inflight.clear();
        state.logs.length = 0;
      }
      state.fileChoosers.clear();
      state.origin = origin;
      state.dialog = undefined;
      recordNavigation(state, typeof frame.url === 'string' ? frame.url : '');
      break;
    }
    case 'Page.navigatedWithinDocument': {
      if (sessionId !== undefined) break;
      const frameId =
        typeof params.frameId === 'string' ? params.frameId : undefined;
      if (state.mainFrameId !== undefined && frameId !== state.mainFrameId)
        break;
      recordNavigation(state, typeof params.url === 'string' ? params.url : '');
      break;
    }
    case 'Page.domContentEventFired':
      if (sessionId === undefined) state.loader.domContentLoaded = true;
      break;
    case 'Page.loadEventFired':
      if (sessionId === undefined) state.loader.load = true;
      break;
    case 'Inspector.targetCrashed':
      if (sessionId === undefined) markStale(state, 'the tab crashed', hooks);
      break;
    case 'qwenBrowser.detached':
      markStale(
        state,
        `the debugger was detached (${typeof params.reason === 'string' ? params.reason : 'unknown'})`,
        hooks,
      );
      break;
    case 'qwenBrowser.tabRemoved':
      markStale(state, 'the tab was closed', hooks);
      break;
    default:
      break;
  }
}

function markStale(
  state: TabState,
  reason: string,
  hooks: ChromeLifecycleEventHooks,
): void {
  state.stale = reason;
  hooks.clearInputState();
  interruptNavigationExpectations(state, reason);
  interruptPageEventWaiters(state, reason);
  interruptDownloads(state);
}

function pushDownloadEvent(
  state: TabState,
  event: TabState['downloadEvents'][number],
): void {
  if (!state.downloadEventsEnabled) return;
  state.downloadEvents.push(event);
}

function isDownloadState(
  value: unknown,
): value is 'inProgress' | 'completed' | 'canceled' {
  return (
    value === 'inProgress' || value === 'completed' || value === 'canceled'
  );
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function trimSettledDownloads(state: TabState): void {
  if (state.downloads.size <= MAX_EVENT_HANDLES_PER_TAB) return;
  for (const [downloadId, download] of state.downloads) {
    if (download.state === 'inProgress') continue;
    state.downloads.delete(downloadId);
    if (state.downloads.size <= MAX_EVENT_HANDLES_PER_TAB) return;
  }
}

function dropChildSession(state: TabState, sessionId: string): void {
  if (sessionId === '') return;
  let changed = state.sessions.delete(sessionId);
  for (const [frameId, record] of state.frames) {
    if (record.sessionId === sessionId) {
      state.frames.delete(frameId);
      changed = true;
    }
  }
  if (state.dialog?.sessionId === sessionId) state.dialog = undefined;
  if (changed) renewDocumentIdentity(state);
}
