import {
  displayLiveMessage,
  liveMessage,
  liveText,
  type LiveLanguage,
  type LiveMessageKey,
} from '@qwen-code/qwen-live/i18n';
import type {
  SubagentActivity,
  SubagentPermission,
  SubagentStatus,
  SubagentTask,
  SubagentsControlRequest,
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
  stop: HTMLButtonElement;
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
  private readonly feedback = element('p', 'subagents-feedback');
  private readonly pagination = element('nav', 'subagents-pagination');
  private readonly previous = element('button', 'subagents-page-button');
  private readonly next = element('button', 'subagents-page-button');
  private readonly retry = element('button', 'subagents-page-button');
  private readonly pageLabel = element('span', 'subagents-page-label');
  private readonly stop = element('button', 'subagents-stop');
  private readonly stopReason = element('p', 'subagents-stop-reason');
  private readonly permissions = element('section', 'subagent-permissions');
  private readonly unassigned = element('li', 'subagent-unassigned');
  private readonly permissionRows = new Map<
    string,
    {
      element: HTMLElement;
      title: HTMLElement;
      origin: HTMLElement;
      unavailable: HTMLElement;
      choices: HTMLElement;
      buttons: Map<string, HTMLButtonElement>;
    }
  >();
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
  private feedbackKey?: LiveMessageKey;
  private feedbackTaskId?: string;
  private readonly previousOffsets = new Map<number, number>();
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
    this.feedback.setAttribute('role', 'status');
    for (const [button, key] of [
      [this.previous, 'subagents.previous'],
      [this.next, 'subagents.next'],
      [this.retry, 'subagents.retry'],
    ] as const) {
      button.type = 'button';
      uiText(button, key);
    }
    this.previous.addEventListener('click', () => this.changePage(-1));
    this.next.addEventListener('click', () => this.changePage(1));
    this.retry.addEventListener('click', () => this.changePage(0));
    this.pagination.append(
      this.previous,
      this.pageLabel,
      this.next,
      this.retry,
    );
    this.events.tabIndex = this.output.tabIndex = this.list.tabIndex = 0;
    uiLabel(this.events, 'subagents.activity');
    uiLabel(this.output, 'subagents.output');
    uiLabel(this.list, 'subagents.title');
    const identity = element('section', 'subagent-identity');
    identity.append(
      this.title,
      this.status,
      this.stop,
      this.stopReason,
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
      this.permissions,
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
      this.pagination,
      this.feedback,
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
    if (this.state?.instanceId !== state.instanceId) {
      this.previousOffsets.clear();
      this.actionGeneration++;
      this.pending = false;
      this.errorMessage = '';
      this.feedbackKey = undefined;
      for (const row of this.rows.values()) row.element.remove();
      this.rows.clear();
      for (const row of this.permissionRows.values()) row.element.remove();
      this.permissionRows.clear();
    }
    if (
      this.state?.selectedId !== state.selectedId ||
      priorMode !== state.mode
    ) {
      this.feedbackKey = undefined;
      this.errorMessage = '';
    }
    if (priorMode !== state.mode) this.focused = false;
    if (state.mode === 'summary') this.previousOffsets.clear();
    const previousOffset = this.state?.page?.offset;
    if (
      previousOffset !== undefined &&
      state.page &&
      state.page.offset > previousOffset
    )
      this.previousOffsets.set(state.page.offset, previousOffset);
    this.state = state;
    if (
      this.feedbackKey === 'subagents.outcome.stopping' &&
      this.feedbackTaskId
    ) {
      const task =
        state.page?.selected?.id === this.feedbackTaskId
          ? state.page.selected
          : (state.page?.snapshot ?? state.snapshot)?.tasks.find(
              (item) => item.id === this.feedbackTaskId,
            );
      if (task?.status === 'cancelled')
        this.feedbackKey = 'subagents.outcome.stopped';
      else if (task?.status === 'completed' || task?.status === 'failed')
        this.feedbackKey = 'subagents.outcome.already_ended';
      else if (task?.status === 'interrupted') {
        this.feedbackKey = undefined;
        this.errorMessage = liveMessage('subagents.error.action_failed');
      }
    }
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
      const value =
        (state.snapshot?.counts[key] ?? 0) +
        (key === 'needsAttention'
          ? (state.snapshot?.pendingUnassignedPermissions ?? 0)
          : 0);
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
    const waiting =
      (counts?.needsAttention ?? 0) +
      (state.snapshot?.pendingUnassignedPermissions ?? 0);
    const summaryLabel = liveText(language, 'subagents.summaryLabel', {
      running: counts?.running ?? 0,
      completed: counts?.completed ?? 0,
      waiting,
    });
    this.summary.setAttribute('aria-label', summaryLabel);
    this.summary.title = state.connected
      ? summaryLabel
      : `${summaryLabel} ${liveText(language, 'subagents.disconnected')}`;
    this.summaryWaiting.hidden = waiting === 0;
    this.summaryWaiting.title = liveText(language, 'subagents.summaryWaiting', {
      count: waiting,
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
    this.omitted.hidden = Boolean(state.page) || !state.snapshot?.omitted;
    text(
      this.omitted,
      liveText(language, 'subagents.omitted', {
        count: state.snapshot?.omitted ?? 0,
      }),
    );
    this.list.hidden = detail;
    this.detail.hidden = !detail;
    const page = state.page;
    this.pagination.hidden = summary || detail || !state.controlsAvailable;
    this.previous.disabled =
      this.pending ||
      Boolean(state.loading) ||
      !state.connected ||
      !page?.offset;
    this.next.disabled =
      this.pending ||
      Boolean(state.loading) ||
      !state.connected ||
      !page ||
      page.offset + page.snapshot.tasks.length >= page.total;
    this.retry.hidden = !state.pageError;
    this.retry.disabled =
      this.pending || Boolean(state.loading) || !state.connected;
    text(
      this.pageLabel,
      state.loading && !page
        ? liveText(language, 'subagents.loading')
        : liveText(language, 'subagents.page', {
            start: page?.snapshot.tasks.length ? page.offset + 1 : 0,
            end: page ? page.offset + page.snapshot.tasks.length : 0,
            total: page?.total ?? 0,
          }),
    );
    if (detail) this.renderDetail(state);
    else {
      this.renderList(state);
      this.empty.hidden = Boolean(
        (page?.snapshot ?? state.snapshot)?.tasks.length ||
          page?.unassignedPermissions?.length,
      );
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
    this.feedback.hidden = !this.feedbackKey;
    text(
      this.feedback,
      this.feedbackKey ? liveText(language, this.feedbackKey) : '',
    );
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
    const tasks = (state.page?.snapshot ?? state.snapshot)?.tasks ?? [];
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
          stop: element('button', 'subagents-stop'),
        };
        row.button.type = 'button';
        row.button.dataset.taskId = task.id;
        const id = task.id;
        row.button.addEventListener(
          'click',
          () => void this.run(() => this.api.openDetail(id)),
        );
        row.button.append(row.title, row.status, row.activity);
        row.element.append(row.button, row.stop);
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
      this.renderStop(row.stop, task, state);
      row.button.setAttribute(
        'aria-label',
        liveText(state.language, 'subagents.openTask', { title: task.title }),
      );
    }
    const permissions = state.page?.unassignedPermissions ?? [];
    this.renderPermissions(
      this.unassigned,
      permissions,
      state,
      'subagents.unassignedPermissions',
      state.page?.unassignedPermissionsOmitted,
    );
    if (permissions.length) {
      if (this.list.firstElementChild !== this.unassigned)
        this.list.prepend(this.unassigned);
    } else this.unassigned.remove();
  }

  private renderDetail(state: SubagentsWindowState): void {
    const selected = state.page?.selected;
    const task =
      selected && selected.id === state.selectedId
        ? selected
        : (state.page?.snapshot ?? state.snapshot)?.tasks.find(
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
    this.renderStop(this.stop, task, state);
    const reason =
      task.stopReason === 'untracked'
        ? 'subagents.stopUntracked'
        : task.stopReason === 'unsupported'
          ? 'subagents.stopUnsupported'
          : undefined;
    this.stopReason.hidden = !state.controlsAvailable || !reason;
    text(this.stopReason, reason ? liveText(language, reason) : '');
    this.renderPermissions(
      this.permissions,
      task.permissions ?? [],
      state,
      'subagents.permissions',
      task.permissionsOmitted,
    );
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

  private renderStop(
    button: HTMLButtonElement,
    task: SubagentTask,
    state: SubagentsWindowState,
  ): void {
    const stopping = task.stopReason === 'stopping';
    button.type = 'button';
    button.hidden = !state.controlsAvailable || (!task.canStop && !stopping);
    button.disabled = this.pending || !state.connected || !task.canStop;
    text(
      button,
      liveText(
        state.language,
        stopping ? 'subagents.stopping' : 'subagents.stop',
      ),
    );
    button.setAttribute(
      'aria-label',
      liveText(state.language, 'subagents.stopTask', { title: task.title }),
    );
    button.onclick = () =>
      this.control({ action: 'stop', taskId: task.id }, state.instanceId);
  }

  private renderPermissions(
    container: HTMLElement,
    permissions: SubagentPermission[],
    state: SubagentsWindowState,
    heading: LiveMessageKey,
    omitted = 0,
  ): void {
    container.hidden = !permissions.length;
    let title = container.querySelector<HTMLElement>('h2');
    if (!title) {
      title = element('h2', 'subagent-section-title');
      container.append(title);
    }
    text(title, liveText(state.language, heading));
    const ids = new Set(
      permissions.map((permission) => permission.requestHandle),
    );
    for (const [id, row] of this.permissionRows) {
      if (row.element.parentElement === container && !ids.has(id)) {
        row.element.remove();
        this.permissionRows.delete(id);
      }
    }
    for (const permission of permissions) {
      let row = this.permissionRows.get(permission.requestHandle);
      if (!row) {
        row = {
          element: element('section', 'subagent-permission'),
          title: element('p', 'subagent-permission-title'),
          origin: element('p', 'subagent-permission-origin'),
          unavailable: element('p', 'subagents-stop-reason'),
          choices: element('div', 'subagent-permission-choices'),
          buttons: new Map(),
        };
        row.element.append(row.origin, row.title, row.choices, row.unavailable);
        this.permissionRows.set(permission.requestHandle, row);
      }
      if (row.element.parentElement !== container)
        container.append(row.element);
      text(row.title, permission.title);
      text(
        row.origin,
        [permission.backend, permission.sessionId].filter(Boolean).join(' · '),
      );
      row.origin.hidden = !row.origin.textContent;
      row.unavailable.hidden =
        permission.choices.length > 0 && !permission.titleTruncated;
      text(
        row.unavailable,
        liveText(
          state.language,
          permission.titleTruncated
            ? 'subagents.permissionTruncated'
            : 'subagents.permissionNoChoice',
        ),
      );
      const choiceIds = new Set<string>();
      for (const choice of permission.choices) {
        const key = `${choice.decision}:${choice.scope ?? ''}`;
        choiceIds.add(key);
        let button = row.buttons.get(key);
        if (!button) {
          button = element('button', 'subagent-permission-choice');
          button.type = 'button';
          row.choices.append(button);
          row.buttons.set(key, button);
        }
        const label =
          choice.decision === 'allow'
            ? choice.scope === 'once'
              ? 'subagents.allowOnce'
              : choice.scope === 'always'
                ? 'subagents.allowAlways'
                : 'subagents.allow'
            : choice.scope === 'once'
              ? 'subagents.denyOnce'
              : choice.scope === 'always'
                ? 'subagents.denyAlways'
                : 'subagents.deny';
        text(button, liveText(state.language, label));
        button.title = liveText(state.language, 'subagents.permissionScope');
        button.disabled =
          this.pending || !state.connected || !state.controlsAvailable;
        button.dataset.decision = choice.decision;
        button.onclick = () =>
          this.control(
            {
              action: 'permission',
              requestHandle: permission.requestHandle,
              decision: choice.decision,
            },
            state.instanceId,
          );
      }
      for (const [key, button] of row.buttons)
        if (!choiceIds.has(key)) {
          button.remove();
          row.buttons.delete(key);
        }
    }
    let more = container.querySelector<HTMLElement>(
      '.subagents-more-permissions',
    );
    if (!more) {
      more = element('p', 'subagents-more-permissions');
      container.append(more);
    }
    more.hidden = omitted === 0;
    text(
      more,
      liveText(state.language, 'subagents.morePermissions', { count: omitted }),
    );
  }

  private changePage(direction: -1 | 0 | 1): void {
    const page = this.state?.page;
    const offset =
      direction > 0
        ? (page?.offset ?? 0) + (page?.snapshot.tasks.length ?? 0)
        : direction < 0
          ? (this.previousOffsets.get(page?.offset ?? 0) ??
            Math.max(0, (page?.offset ?? 0) - 32))
          : (page?.offset ?? 0);
    this.control({ action: 'list', offset }, this.state?.instanceId);
  }

  private control(request: SubagentsControlRequest, instanceId?: string): void {
    if (!instanceId || !this.state?.controlsAvailable) return;
    void this.run(async () => {
      const generation = this.actionGeneration;
      const result = await this.api.control(instanceId, request);
      if (
        this.disposed ||
        generation !== this.actionGeneration ||
        this.state?.instanceId !== instanceId
      )
        return;
      if (result.type === 'error')
        this.errorMessage = liveMessage(`subagents.error.${result.code}`);
      else if (result.type === 'outcome') {
        this.feedbackTaskId = result.taskId;
        this.feedbackKey = `subagents.outcome.${result.outcome}`;
      }
    });
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
    this.pending = false;
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
    this.feedbackKey = undefined;
    const generation = ++this.actionGeneration;
    this.summary.disabled = true;
    this.renderError();
    this.update(this.state);
    try {
      await action();
    } catch (error) {
      if (!this.disposed && generation === this.actionGeneration)
        this.errorMessage =
          error instanceof Error
            ? error.message
            : liveText(this.state.language, 'subagents.openFailed');
    } finally {
      if (
        !this.disposed &&
        generation === this.actionGeneration &&
        this.state
      ) {
        this.pending = false;
        this.update(this.state);
      }
    }
  }

  private renderError(): void {
    const error =
      this.errorMessage ||
      (this.state?.pageError
        ? liveMessage(`subagents.error.${this.state.pageError}`)
        : '');
    this.error.hidden = !error;
    const message = displayLiveMessage(this.state?.language ?? 'en', error);
    text(this.error, message);
    this.summaryError.hidden = !message;
    this.summaryCounts.hidden = Boolean(message);
    text(this.summaryError, message);
    this.summaryError.title = message;
  }
}
