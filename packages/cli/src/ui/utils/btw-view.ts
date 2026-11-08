/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Projects one /btw request of the session store into the TUI's btw item.
 *
 * Only one request is on screen at a time. Showing another one detaches the
 * current view without cancelling its request; `cancelBtw()` (Esc, Ctrl+C,
 * dismiss) aborts the view's controller, which cancels the request if it is
 * still running. The request lifecycle itself belongs to the store.
 */

import type {
  BtwRequest,
  BtwSession,
} from '@qwen-code/qwen-code-core/agents/btw-session.js';
import type { CommandContext } from '../commands/types.js';
import type { Key } from '../contexts/KeypressContext.js';
import { MessageType, type BtwProps } from '../types.js';
import { t } from '../../i18n/index.js';
import { copyToClipboard } from './commandUtils.js';

export function formatBtwToolCallNotice(toolName: string): string {
  return t(
    '(The model tried to call {{tool}} instead of answering directly. Try rephrasing or ask in the main conversation.)',
    { tool: toolName },
  );
}

type BtwViewUi = Pick<
  CommandContext['ui'],
  'setBtwItem' | 'btwAbortControllerRef'
>;

interface BtwView {
  ui: BtwViewUi;
  session: BtwSession;
  requestId: string;
  /** Id of the browsed exchange, or null for the request itself. */
  browseId: string | null;
  /** True after ←/→ enables `c`/`x` until the next other key. */
  shortcuts: boolean;
  notice?: NonNullable<BtwProps['notice']>;
  noticeTimer?: ReturnType<typeof setTimeout>;
  retryTimer?: ReturnType<typeof setTimeout>;
  detach: () => void;
}

const NOTICE_MS = 2000;

let activeView: BtwView | null = null;

export function showBtwRequest(
  ui: BtwViewUi,
  session: BtwSession,
  requestId: string,
): void {
  activeView?.detach();

  const controller = new AbortController();
  const view: BtwView = {
    ui,
    session,
    requestId,
    browseId: null,
    shortcuts: false,
    detach: () => {
      unsubscribe();
      controller.signal.removeEventListener('abort', onAbort);
      clearTimeout(view.noticeTimer);
      clearTimeout(view.retryTimer);
      if (activeView === view) activeView = null;
    },
  };
  const onAbort = () => {
    view.detach();
    session.abort(requestId);
  };
  controller.signal.addEventListener('abort', onAbort);
  const unsubscribe = session.subscribe(() => render(view));

  ui.btwAbortControllerRef.current = controller;
  activeView = view;
  render(view);
}

/**
 * Handles a key typed into the empty prompt while a btw item is shown:
 * ←/→ enter browse mode, `c` copies and `x` clears earlier answers while in
 * that mode, Space/Enter dismiss a settled item. The first other key leaves
 * browse mode and is handled as normal input, so a prompt that starts with
 * `c` or `x` is no longer swallowed. Returns true when the key was consumed.
 */
export function handleBtwViewKey(key: Key): boolean {
  const view = activeView;
  if (!view) return false;
  if (key.ctrl || key.meta || key.paste) {
    exitBrowseMode(view);
    return false;
  }
  if (key.name === 'left' || key.name === 'right') {
    return browseBtwHistory(key.name === 'left' ? 'older' : 'newer');
  }
  if (view.shortcuts) {
    if (key.sequence === 'c' && copyBtwAnswer()) return true;
    if (key.sequence === 'x' && clearBtwHistory()) return true;
  }
  if (key.name === 'return' || key.sequence === ' ') {
    const ownRequest = view.session.getRequest(view.requestId);
    if (ownRequest?.outcome === null || project(view)?.isPending !== false) {
      exitBrowseMode(view);
      return false;
    }
    dismissBtwView();
    return true;
  }
  exitBrowseMode(view);
  return false;
}

/** Hides the btw area without cancelling a request that is still running. */
export function dismissBtwView(): void {
  const view = activeView;
  if (!view) return;
  view.detach();
  view.ui.btwAbortControllerRef.current = null;
  view.ui.setBtwItem(null);
}

/** Moves through earlier answers. Returns false when there is nothing to browse. */
export function browseBtwHistory(direction: 'older' | 'newer'): boolean {
  const view = activeView;
  if (!view) return false;
  const exchanges = browsableExchanges(view);
  const count = exchanges.length;
  if (count === 0) return false;
  const current = exchanges.findIndex(
    (exchange) => exchange.id === view.browseId,
  );
  if (direction === 'older') {
    view.browseId =
      current === -1
        ? exchanges[count - 1].id
        : exchanges[Math.max(0, current - 1)].id;
  } else if (view.browseId !== null) {
    view.browseId =
      current === -1 || current >= count - 1 ? null : exchanges[current + 1].id;
  }
  view.shortcuts = true;
  render(view);
  return true;
}

/** Drops the earlier answers, keeping the one on screen. */
export function clearBtwHistory(): boolean {
  const view = activeView;
  if (!view) return false;
  const ids = browsableExchanges(view).map((exchange) => exchange.id);
  if (ids.length === 0) return false;
  view.browseId = null;
  view.session.removeExchanges(ids);
  return true;
}

/** Copies the displayed answer. Returns false when there is none to copy. */
export function copyBtwAnswer(
  copy: (text: string) => Promise<void> = copyToClipboard,
): boolean {
  const view = activeView;
  if (!view) return false;
  const displayed = project(view);
  if (!displayed || displayed.isPending || displayed.isError) return false;
  void copy(displayed.answer).then(
    () => setNotice(view, { text: t('Copied to clipboard') }),
    () => setNotice(view, { text: t('Copy failed'), isError: true }),
  );
  return true;
}

function exitBrowseMode(view: BtwView): void {
  if (!view.shortcuts) return;
  view.shortcuts = false;
  render(view);
}

function setNotice(
  view: BtwView,
  notice: NonNullable<BtwProps['notice']>,
): void {
  if (activeView !== view) return;
  clearTimeout(view.noticeTimer);
  view.notice = notice;
  render(view);
  view.noticeTimer = setTimeout(() => {
    view.notice = undefined;
    render(view);
  }, NOTICE_MS);
}

function browsableExchanges(view: BtwView) {
  return view.session
    .getSnapshot()
    .exchanges.filter((exchange) => exchange.id !== view.requestId);
}

function render(view: BtwView): void {
  if (activeView !== view) return;
  const btw = project(view);
  if (!btw) {
    view.detach();
    view.ui.btwAbortControllerRef.current = null;
    view.ui.setBtwItem(null);
    return;
  }
  clearTimeout(view.retryTimer);
  if (btw.retryStatus) {
    view.retryTimer = setTimeout(() => render(view), 1000);
  }
  view.ui.setBtwItem({ type: MessageType.BTW, btw });
}

function project(view: BtwView): BtwProps | null {
  const exchanges = browsableExchanges(view);
  const common = {
    historyCount: exchanges.length,
    ...(view.shortcuts ? { browsing: true } : {}),
    ...(view.notice ? { notice: view.notice } : {}),
  };

  if (view.browseId !== null) {
    const index = exchanges.findIndex(
      (exchange) => exchange.id === view.browseId,
    );
    if (index !== -1) {
      const exchange = exchanges[index];
      return {
        ...common,
        question: exchange.question,
        answer: exchange.response,
        isPending: false,
        browsePosition: index + 1,
      };
    }
    view.browseId = null;
  }

  const request = view.session.getRequest(view.requestId);
  if (request) return projectRequest(request, common);

  const exchange = view.session
    .getSnapshot()
    .exchanges.find((entry) => entry.id === view.requestId);
  return exchange
    ? {
        ...common,
        question: exchange.question,
        answer: exchange.response,
        isPending: false,
      }
    : null;
}

function projectRequest(
  request: BtwRequest,
  common: Pick<BtwProps, 'historyCount' | 'browsing' | 'notice'>,
): BtwProps | null {
  const base = { ...common, question: request.question };
  const outcome = request.outcome;
  if (!outcome) {
    return {
      ...base,
      answer: request.streamingText,
      isPending: true,
      ...(request.retry ? { retryStatus: formatRetry(request.retry) } : {}),
    };
  }
  switch (outcome.kind) {
    case 'answered':
      return { ...base, answer: outcome.response, isPending: false };
    case 'tool-call':
      return {
        ...base,
        answer: formatBtwToolCallNotice(outcome.toolName),
        isPending: false,
      };
    case 'empty':
      return { ...base, answer: t('No response received.'), isPending: false };
    case 'unavailable':
      return {
        ...base,
        answer: t('No conversation context available for /btw'),
        isPending: false,
        isError: true,
      };
    case 'failed':
      return {
        ...base,
        answer: t('(API error: {{error}})', { error: outcome.error }),
        isPending: false,
        isError: true,
      };
    case 'cancelled':
      return null;
    default:
      return null;
  }
}

function formatRetry(retry: NonNullable<BtwRequest['retry']>): string {
  const seconds = Math.max(0, Math.ceil((retry.retryAt - Date.now()) / 1000));
  return t(
    '{{reason}} · retrying in {{seconds}}s · attempt {{attempt}}/{{max}}',
    {
      reason: retry.message?.split('\n')[0] || t('API error'),
      seconds: String(seconds),
      attempt: String(retry.attempt),
      max: String(retry.maxRetries),
    },
  );
}
