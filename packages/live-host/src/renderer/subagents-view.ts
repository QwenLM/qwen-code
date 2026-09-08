import {
  displayLiveMessage,
  liveText,
  type LiveLanguage,
  type LiveMessageKey,
} from '@qwen-code/qwen-live/i18n';
import type {
  SubagentActivity,
  SubagentStatus,
  SubagentTask,
} from '@qwen-code/qwen-live/subagents';
import type {
  SubagentsWindowApi,
  SubagentsWindowState,
} from '../shared/subagents-api.ts';
import { localizeUi, uiLabel, uiText } from './ui-text.ts';
import { applyTheme } from './theme.ts';

const STATUS_KEYS = {
  queued: 'subagents.queued',
  starting: 'subagents.starting',
  running: 'subagents.running',
  monitoring: 'subagents.monitoring',
  waiting: 'subagents.waiting',
  delivering: 'subagents.delivering',
  completed: 'subagents.completed',
  failed: 'subagents.failed',
  cancelled: 'subagents.cancelled',
  interrupted: 'subagents.interrupted',
} as const satisfies Record<SubagentStatus, LiveMessageKey>;

const EVENT_KEYS = {
  status: 'subagents.eventStatus',
  message: 'subagents.eventMessage',
  plan: 'subagents.eventPlan',
  tool: 'subagents.eventTool',
  observation: 'subagents.eventObservation',
  notification: 'subagents.eventNotification',
} as const satisfies Record<SubagentActivity['kind'], LiveMessageKey>;

const NOTIFICATION_KEYS = {
  queued: 'subagents.notificationQueued',
  speaking: 'subagents.notificationSpeaking',
  delivered: 'subagents.notificationDelivered',
} as const satisfies Record<
  NonNullable<SubagentTask['notification']>,
  LiveMessageKey
>;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function text(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

function botIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('subagents-bot');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute(
    'd',
    'M9 3h3v3M5 8h14v12H5zM2 12v4m20-4v4M9 12v2m6-2v2M9 17h6',
  );
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function atBottom(node: HTMLElement): boolean {
  return node.scrollHeight - node.clientHeight - node.scrollTop <= 8;
}

function time(language: LiveLanguage, at: number): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString(language === 'en' ? 'en-US' : 'zh-CN', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}

type TaskRow = {
  element: HTMLLIElement;
  button: HTMLButtonElement;
  title: HTMLElement;
  status: HTMLElement;
  activity: HTMLElement;
};

export class SubagentsView {
  private readonly summary = element('button', 'subagents-summary');
  private readonly panel = element('section', 'subagents-panel');
  private readonly heading = element('strong', 'subagents-heading');
  private readonly close = element('button', 'subagents-close');
  private readonly back = element('button', 'subagents-back');
  private readonly notice = element('p', 'subagents-notice');
  private readonly counts = element('div', 'subagents-counts');
  private readonly summaryCounts = element('span', 'subagents-counts');
  private readonly summaryWaiting = element(
    'span',
    'subagents-summary-waiting',
  );
  private readonly summaryError = element('span', 'subagents-summary-error');
  private readonly list = element('ol', 'subagents-list');
  private readonly empty = element('p', 'subagents-empty');
  private readonly omitted = element('p', 'subagents-retention');
  private readonly otherCounts = element('p', 'subagents-other-counts');
  private readonly error = element('p', 'subagents-error');
  private readonly detail = element('div', 'subagent-detail-body');
  private readonly title = element('h1', 'subagent-title');
  private readonly status = element('span', 'subagent-status');
  private readonly updated = element('p', 'subagent-updated');
  private readonly metadata = element('p', 'subagent-metadata');
  private readonly activity = element('p', 'subagent-latest');
  private readonly notifications = element('p', 'subagent-notifications');
  private readonly request = element('pre', 'subagent-request');
  private readonly events = element('ol', 'subagent-events');
  private readonly noEvents = element('p', 'subagent-no-events');
  private readonly outputHeading = element('h2', 'subagent-section-title');
  private readonly output = element('pre', 'subagent-output');
  private readonly truncated = element('p', 'subagent-truncated');
  private readonly rows = new Map<string, TaskRow>();
  private readonly eventRows = new Map<
    string,
    { element: HTMLLIElement; label: HTMLElement; message: HTMLElement }
  >();
  private state?: SubagentsWindowState;
  private detailId?: string;
  private disposed = false;
  private hovered = false;
  private focused = false;
  private keyboardMode = false;
  private pending = false;
  private actionGeneration = 0;
  private errorMessage = '';
  private readonly keydown = (event: KeyboardEvent) => {
    if (event.key === 'Tab') {
      this.keyboardMode = true;
      this.syncHover();
    }
    if (event.key !== 'Escape') return;
    event.preventDefault();
    this.dismiss();
  };
  private readonly blur = () => {
    this.keyboardMode = false;
    this.focused = false;
    this.syncHover();
  };
  private readonly pointerdown = () => {
    this.keyboardMode = false;
    this.syncHover();
  };

  constructor(
    private readonly app: HTMLElement,
    private readonly api: SubagentsWindowApi,
  ) {
    app.classList.add('subagents-app');
    this.summary.type = this.close.type = 'button';
    const summaryTitle = uiText(element('strong', ''), 'subagents.title');
    const summaryHeader = element('span', 'subagents-summary-heading');
    this.summaryWaiting.textContent = '!';
    this.summaryWaiting.setAttribute('aria-hidden', 'true');
    summaryHeader.append(summaryTitle, this.summaryWaiting);
    const summaryMain = element('span', 'subagents-summary-main');
    summaryMain.append(summaryHeader, this.summaryCounts, this.summaryError);
    this.summary.append(botIcon(), summaryMain);
    this.summary.addEventListener(
      'click',
      () => void this.run(() => this.api.expand()),
    );
    for (const key of ['running', 'completed', 'needsAttention'] as const) {
      const count = element('span', `subagents-count ${key}`);
      const value = element('b', 'subagents-count-value');
      value.dataset.count = key;
      count.append(value, uiText(element('span', ''), `subagents.${key}`));
      this.counts.append(count);
    }
    for (const key of ['running', 'completed'] as const) {
      const count = element('span', `subagents-count ${key}`);
      const symbol = element('span', `subagents-count-symbol ${key}`);
      symbol.textContent = key === 'running' ? '●' : '✓';
      symbol.setAttribute('aria-hidden', 'true');
      const value = element('b', 'subagents-count-value');
      value.dataset.count = key;
      count.append(symbol, value);
      this.summaryCounts.append(count);
    }
    uiText(this.close, 'ui.close');
    this.back.type = 'button';
    uiText(this.back, 'subagents.back');
    this.back.addEventListener(
      'click',
      () => void this.run(() => this.api.back(), false),
    );
    this.close.addEventListener('click', () => this.dismiss());
    const header = element('header', 'subagents-header');
    header.append(this.back, this.heading, this.close);
    this.notice.setAttribute('role', 'status');
    this.error.setAttribute('role', 'alert');
    this.events.tabIndex = this.output.tabIndex = this.list.tabIndex = 0;
    uiLabel(this.events, 'subagents.activity');
    uiLabel(this.output, 'subagents.output');
    uiLabel(this.list, 'subagents.title');
    const identity = element('section', 'subagent-identity');
    identity.append(
      this.title,
      this.status,
      this.updated,
      this.metadata,
      this.activity,
      this.notifications,
    );
    const requestSection = element('section', 'subagent-section');
    requestSection.append(
      uiText(element('h2', 'subagent-section-title'), 'subagents.request'),
      this.request,
    );
    const activitySection = element('section', 'subagent-section');
    activitySection.append(
      uiText(element('h2', 'subagent-section-title'), 'subagents.activity'),
      this.noEvents,
      this.events,
    );
    const outputSection = element('section', 'subagent-section');
    outputSection.append(this.outputHeading, this.output, this.truncated);
    this.detail.append(
      identity,
      requestSection,
      activitySection,
      outputSection,
    );
    const footer = uiText(
      element('p', 'subagents-footer'),
      'subagents.history',
    );
    this.panel.append(
      header,
      this.notice,
      this.counts,
      this.otherCounts,
      this.empty,
      this.list,
      this.detail,
      this.omitted,
      this.error,
      footer,
    );
    this.summary.hidden = this.panel.hidden = true;
    app.append(this.summary, this.panel);
    app.addEventListener('pointerenter', () => {
      this.hovered = true;
      this.syncHover();
    });
    app.addEventListener('pointerleave', () => {
      this.hovered = false;
      this.syncHover();
    });
    app.addEventListener('focusin', () => {
      this.focused = true;
      this.syncHover();
    });
    app.addEventListener('focusout', (event) => {
      this.focused =
        event.relatedTarget instanceof app.ownerDocument.defaultView!.Node &&
        app.contains(event.relatedTarget);
      this.syncHover();
    });
    app.ownerDocument.addEventListener('keydown', this.keydown);
    app.ownerDocument.addEventListener('pointerdown', this.pointerdown, true);
    app.ownerDocument.defaultView?.addEventListener('blur', this.blur);
  }

  update(state: SubagentsWindowState): void {
    if (this.disposed) return;
    applyTheme(this.app.ownerDocument, state.resolvedTheme);
    const priorMode = this.state?.mode;
    if (priorMode !== state.mode) this.focused = false;
    this.state = state;
    const language = state.language;
    this.app.dataset.mode = state.mode;
    this.app.ownerDocument.documentElement.lang = language;
    this.app.ownerDocument.title = liveText(language, 'subagents.title');
    localizeUi(this.app, language);
    const summary = state.mode === 'summary';
    const detail = state.mode === 'detail';
    this.back.hidden = !detail;
    this.summary.hidden = !summary;
    this.panel.hidden = summary;
    this.counts.hidden = detail;
    this.summary.disabled = this.pending || !state.connected || !state.snapshot;
    text(
      this.heading,
      liveText(language, detail ? 'subagents.details' : 'subagents.title'),
    );
    for (const node of this.app.querySelectorAll<HTMLElement>('[data-count]')) {
      const key = node.dataset.count as
        | 'running'
        | 'completed'
        | 'needsAttention';
      const value = state.snapshot?.counts[key] ?? 0;
      const compact = this.summaryCounts.contains(node);
      text(node, compact && value >= 1_000 ? '999+' : String(value));
      node.title = compact
        ? `${liveText(language, `subagents.${key}`)}: ${value}`
        : String(value);
      if (compact && node.parentElement) {
        node.parentElement.title = node.title;
      }
    }
    this.notice.hidden = state.connected;
    text(this.notice, liveText(language, 'subagents.disconnected'));
    const counts = state.snapshot?.counts;
    const summaryLabel = liveText(language, 'subagents.summaryLabel', {
      running: counts?.running ?? 0,
      completed: counts?.completed ?? 0,
      waiting: counts?.needsAttention ?? 0,
    });
    this.summary.setAttribute('aria-label', summaryLabel);
    this.summary.title = state.connected
      ? summaryLabel
      : `${summaryLabel} ${liveText(language, 'subagents.disconnected')}`;
    this.summaryWaiting.hidden = !counts?.needsAttention;
    this.summaryWaiting.title = liveText(language, 'subagents.summaryWaiting', {
      count: counts?.needsAttention ?? 0,
    });
    this.summary.classList.toggle(
      'running-active',
      summary && state.connected && (counts?.running ?? 0) > 0,
    );
    this.otherCounts.hidden =
      detail ||
      !counts ||
      !(counts.failed || counts.cancelled || counts.interrupted);
    if (counts)
      text(
        this.otherCounts,
        liveText(language, 'subagents.otherCounts', counts),
      );
    this.omitted.hidden = !state.snapshot?.omitted;
    text(
      this.omitted,
      liveText(language, 'subagents.omitted', {
        count: state.snapshot?.omitted ?? 0,
      }),
    );
    this.list.hidden = detail;
    this.detail.hidden = !detail;
    if (detail) this.renderDetail(state);
    else {
      this.renderList(state);
      this.empty.hidden = Boolean(state.snapshot?.tasks.length);
      text(
        this.empty,
        liveText(
          language,
          !state.snapshot
            ? 'subagents.unavailable'
            : state.snapshot.omitted
              ? 'subagents.noRetained'
              : 'subagents.empty',
        ),
      );
    }
    this.renderError();
    if (
      priorMode === 'summary' &&
      state.mode === 'list' &&
      this.app.ownerDocument.activeElement === this.summary
    )
      this.close.focus();
  }

  showLoadFailure(): void {
    if (this.disposed) return;
    this.update({ language: 'en', connected: false, mode: 'list' });
    this.errorMessage = liveText('en', 'subagents.loadFailed');
    this.renderError();
  }

  dispose(): void {
    this.disposed = true;
    this.actionGeneration++;
    this.api.setHover(false);
    this.api.setKeyboardHeld?.(false);
    this.app.ownerDocument.removeEventListener('keydown', this.keydown);
    this.app.ownerDocument.removeEventListener(
      'pointerdown',
      this.pointerdown,
      true,
    );
    this.app.ownerDocument.defaultView?.removeEventListener('blur', this.blur);
  }

  private renderList(state: SubagentsWindowState): void {
    const tasks = state.snapshot?.tasks ?? [];
    const ids = new Set(tasks.map((task) => task.id));
    for (const [id, row] of this.rows) {
      if (ids.has(id)) continue;
      row.element.remove();
      this.rows.delete(id);
    }
    for (const task of tasks) {
      let row = this.rows.get(task.id);
      if (!row) {
        row = {
          element: element('li', 'subagent-row'),
          button: element('button', 'subagent-task'),
          title: element('strong', 'subagent-task-title'),
          status: element('span', 'subagent-status'),
          activity: element('span', 'subagent-task-activity'),
        };
        row.button.type = 'button';
        row.button.dataset.taskId = task.id;
        const id = task.id;
        row.button.addEventListener(
          'click',
          () => void this.run(() => this.api.openDetail(id)),
        );
        row.button.append(row.title, row.status, row.activity);
        row.element.append(row.button);
        this.list.append(row.element);
        this.rows.set(task.id, row);
      }
      text(row.title, task.title);
      text(row.status, liveText(state.language, STATUS_KEYS[task.status]));
      row.status.dataset.status = task.status;
      text(
        row.activity,
        displayLiveMessage(state.language, task.activity) ||
          liveText(state.language, 'subagents.noActivity'),
      );
      row.button.disabled = !state.connected;
      row.button.setAttribute(
        'aria-label',
        liveText(state.language, 'subagents.openTask', { title: task.title }),
      );
    }
  }

  private renderDetail(state: SubagentsWindowState): void {
    const task = state.snapshot?.tasks.find(
      (item) => item.id === state.selectedId,
    );
    this.empty.hidden = Boolean(task);
    this.detail.hidden = !task;
    text(this.empty, liveText(state.language, 'subagents.missing'));
    if (!task) {
      this.detailId = undefined;
      return;
    }
    const changedTask = this.detailId !== task.id;
    const followBody = !changedTask && atBottom(this.detail);
    const followEvents = changedTask || atBottom(this.events);
    const followOutput = changedTask || atBottom(this.output);
    this.detailId = task.id;
    if (changedTask) {
      this.events.replaceChildren();
      this.eventRows.clear();
    }
    const language = state.language;
    text(this.title, task.title);
    text(this.status, liveText(language, STATUS_KEYS[task.status]));
    this.status.dataset.status = task.status;
    text(
      this.updated,
      liveText(language, 'subagents.updated', {
        time: time(language, task.updatedAt),
      }),
    );
    text(
      this.metadata,
      [
        liveText(language, `subagents.${task.kind}`),
        task.backend &&
          `${liveText(language, 'subagents.backend')}: ${task.backend}`,
        task.source &&
          `${liveText(language, 'subagents.source')}: ${task.source}`,
      ]
        .filter(Boolean)
        .join(' · '),
    );
    text(this.activity, displayLiveMessage(language, task.activity));
    this.activity.hidden = !task.activity;
    text(this.request, task.request);
    text(
      this.outputHeading,
      liveText(
        language,
        task.status === 'completed' ? 'subagents.result' : 'subagents.output',
      ),
    );
    text(this.output, task.output || liveText(language, 'subagents.noOutput'));
    this.truncated.hidden = !task.outputTruncated;
    text(this.truncated, liveText(language, 'subagents.truncated'));
    this.renderNotifications(task, language);
    this.renderEvents(task.events, language);
    if (changedTask) this.detail.scrollTop = 0;
    else if (followBody) this.detail.scrollTop = this.detail.scrollHeight;
    if (followEvents) this.events.scrollTop = this.events.scrollHeight;
    if (followOutput) this.output.scrollTop = this.output.scrollHeight;
  }

  private renderNotifications(
    task: SubagentTask,
    language: LiveLanguage,
  ): void {
    const parts: string[] = [];
    if (task.triggerCount !== undefined)
      parts.push(
        liveText(language, 'subagents.triggers', { count: task.triggerCount }),
      );
    if (task.pendingNotifications !== undefined)
      parts.push(
        liveText(language, 'subagents.pendingNotifications', {
          count: task.pendingNotifications,
        }),
      );
    if (task.notification)
      parts.push(liveText(language, NOTIFICATION_KEYS[task.notification]));
    if (task.remainingSec !== undefined)
      parts.push(
        liveText(language, 'subagents.remaining', {
          seconds: Math.ceil(task.remainingSec),
        }),
      );
    text(this.notifications, parts.join(' · '));
    this.notifications.hidden = parts.length === 0;
  }

  private renderEvents(
    events: SubagentActivity[],
    language: LiveLanguage,
  ): void {
    this.noEvents.hidden = events.length > 0;
    text(this.noEvents, liveText(language, 'subagents.noActivity'));
    const keys = new Set<string>();
    for (const event of events) {
      let key = JSON.stringify(event);
      while (keys.has(key)) key += ':';
      keys.add(key);
      let row = this.eventRows.get(key);
      if (!row) {
        row = {
          element: element('li', 'subagent-event'),
          label: element('span', 'subagent-event-label'),
          message: element('p', 'subagent-event-message'),
        };
        row.element.append(row.label, row.message);
        this.events.append(row.element);
        this.eventRows.set(key, row);
      }
      text(
        row.label,
        `${liveText(language, EVENT_KEYS[event.kind])} · ${time(language, event.at)}`,
      );
      text(row.message, displayLiveMessage(language, event.text));
    }
    for (const [key, row] of this.eventRows) {
      if (keys.has(key)) continue;
      row.element.remove();
      this.eventRows.delete(key);
    }
  }

  private syncHover(): void {
    if (!this.disposed) {
      this.api.setHover(this.hovered);
      this.api.setKeyboardHeld?.(this.keyboardMode && this.focused);
    }
  }

  private dismiss(): void {
    this.actionGeneration++;
    this.hovered = this.focused = false;
    this.keyboardMode = false;
    this.api.setKeyboardHeld?.(false);
    this.api.setHover(false);
    this.api.close();
  }

  private async run(
    action: () => Promise<void>,
    requiresConnection = true,
  ): Promise<void> {
    if (
      this.pending ||
      this.disposed ||
      !this.state ||
      (requiresConnection && !this.state.connected)
    )
      return;
    this.pending = true;
    this.errorMessage = '';
    const generation = ++this.actionGeneration;
    this.summary.disabled = true;
    this.renderError();
    try {
      await action();
    } catch (error) {
      if (!this.disposed && generation === this.actionGeneration)
        this.errorMessage =
          error instanceof Error
            ? error.message
            : liveText(this.state.language, 'subagents.openFailed');
    } finally {
      this.pending = false;
      if (!this.disposed && generation === this.actionGeneration && this.state)
        this.update(this.state);
    }
  }

  private renderError(): void {
    this.error.hidden = !this.errorMessage;
    const message = displayLiveMessage(
      this.state?.language ?? 'en',
      this.errorMessage,
    );
    text(this.error, message);
    this.summaryError.hidden = !message;
    this.summaryCounts.hidden = Boolean(message);
    text(this.summaryError, message);
    this.summaryError.title = message;
  }
}
