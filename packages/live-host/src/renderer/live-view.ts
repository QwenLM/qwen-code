import type {
  HostPublicPermissions,
  HostPublicState,
  LiveHostApi,
} from '../shared/host-api.ts';
import {
  isActiveLiveCall,
  shouldRenderSetup,
  shouldShowCameraPreview,
} from '../main/live-state-policy.ts';
import { SettingsPanel } from './settings-panel.ts';
import {
  liveText,
  displayLiveMessage,
  type LiveLanguage,
  type LiveMessageKey,
} from '@qwen-code/qwen-live/i18n';
import { uiText, uiLabel, localizeUi } from './ui-text.ts';
import { makeOverlayDraggable } from './overlay-drag.ts';
import { applyTheme } from './theme.ts';
import {
  OVERLAY_GEOMETRY,
  type OverlayLayout,
} from '../shared/overlay-geometry.ts';

import { uiIcon, setIcon as icon } from './ui-icons.ts';

function text(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.textContent = value;
}

function label(element: HTMLButtonElement, value: string): void {
  if (element.getAttribute('aria-label') !== value)
    element.setAttribute('aria-label', value);
  element.title = value;
}

function button(value: LiveMessageKey, action: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.dataset.liveInteractive = '';
  uiLabel(element, value);
  element.addEventListener('click', action);
  return element;
}

function place(
  element: HTMLElement,
  rect: { x: number; y: number; width: number; height: number },
): void {
  element.style.left = `${rect.x}px`;
  element.style.top = `${rect.y}px`;
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
}

export class LiveView {
  private readonly setup = document.createElement('section');
  private readonly setupMessage = document.createElement('p');
  private readonly setupShortcut = document.createElement('span');
  private readonly setupScreen = button(
    'ui.screen',
    () => void this.action(() => this.api.setVisualSource('screen')),
  );
  private readonly setupCamera = button(
    'ui.camera',
    () => void this.action(() => this.api.setVisualSource('camera')),
  );
  private readonly setupQuit = button('ui.quit', () => void this.quit());
  private readonly permissionRows = new Map<
    keyof HostPublicPermissions,
    { row: HTMLElement; status: HTMLElement; grant: HTMLButtonElement }
  >();
  private readonly surface = document.createElement('section');
  private readonly dock = document.createElement('div');
  private readonly card = document.createElement('div');
  private readonly header = document.createElement('header');
  private readonly shortcut = document.createElement('span');
  private readonly orb = document.createElement('div');
  private readonly bars: HTMLElement[] = [];
  private readonly summary = button(
    'subagents.title',
    () => void this.action(() => this.api.openSubagents()),
  );
  private readonly summaryRunning = document.createElement('span');
  private readonly summaryCompleted = document.createElement('span');
  private readonly summaryAttention = document.createElement('span');
  private readonly toolbar = document.createElement('div');
  private readonly microphone = button(
    'ui.muteInput',
    () =>
      void this.action(() =>
        this.api.setInputMuted(!this.state?.live.inputMuted),
      ),
  );
  private readonly speaker = button(
    'ui.muteOutput',
    () =>
      void this.action(() =>
        this.api.setOutputMuted(!this.state?.live.outputMuted),
      ),
  );
  private readonly call = button('ui.startCall', () => void this.toggleCall());
  private readonly settingsButton = button('ui.settings', () =>
    this.settings.show(this.settingsButton),
  );
  private readonly quitButton = button('ui.quit', () => void this.quit());
  private readonly status = document.createElement('div');
  private readonly statusPrimary = document.createElement('span');
  private readonly statusAudio = document.createElement('span');
  private readonly permissionLink = button(
    'ui.openPermission',
    () => void this.action(() => this.api.openWebShellForPermission()),
  );
  private readonly caption = document.createElement('div');
  private readonly preview = document.createElement('div');
  private readonly previewBadge = document.createElement('span');
  private readonly previewToggle = button('ui.hidePreview', () => {
    this.previewExpanded = !this.previewExpanded;
    if (this.state) this.update(this.state);
  });
  private readonly settings: SettingsPanel;
  private state?: HostPublicState;
  private busy = false;
  private quitting = false;
  private quitFailed = false;
  private hasShownOrb = false;
  private error = '';
  private previewExpanded = true;
  private previewAttached = false;
  private overlayLayout?: OverlayLayout;
  private receivedOverlayOffset = false;
  private disposed = false;
  private inputScale = 1;
  private inputReleaseTimer?: ReturnType<typeof setTimeout>;
  private renderedLanguage?: LiveLanguage;
  private readonly removers: Array<() => void> = [];

  constructor(
    private readonly app: HTMLElement,
    private readonly api: LiveHostApi,
  ) {
    this.setup.className = 'setup-panel';
    place(this.setup, OVERLAY_GEOMETRY.setup);
    this.setup.dataset.liveInteractive = '';
    const header = document.createElement('header');
    header.className = 'setup-header';
    header.dataset.liveDrag = '';
    const title = document.createElement('strong');
    uiText(title, 'ui.appName');
    this.setupShortcut.className = 'shortcut';
    header.append(title, this.setupShortcut);
    makeOverlayDraggable(header, api);
    this.setupMessage.className = 'setup-message';
    const sources = document.createElement('div');
    sources.className = 'setup-source settings-options';
    sources.setAttribute('role', 'group');
    uiLabel(sources, 'ui.videoSource');
    uiText(this.setupScreen, 'ui.screen');
    uiText(this.setupCamera, 'ui.camera');
    this.setupScreen.disabled = this.setupCamera.disabled = true;
    sources.append(this.setupScreen, this.setupCamera);
    const hint = document.createElement('p');
    hint.className = 'settings-hint';
    uiText(hint, 'ui.setupHint');
    const permissions = document.createElement('div');
    permissions.className = 'permissions';
    for (const [permission, name, allow] of [
      ['microphone', 'ui.microphone', 'ui.allowMicrophone'],
      ['camera', 'ui.camera', 'ui.allowCamera'],
      ['accessibility', 'ui.accessibility', 'ui.allowAccessibility'],
      ['screenRecording', 'ui.screenRecording', 'ui.allowScreenRecording'],
    ] as const) {
      const row = document.createElement('div');
      row.className = 'permission';
      row.hidden = true;
      row.dataset.permission = permission;
      const title = document.createElement('span');
      uiText(title, name);
      const status = document.createElement('span');
      status.className = 'permission-status';
      const grant = button(
        allow,
        () => void this.action(() => this.api.requestPermission(permission)),
      );
      uiText(grant, 'ui.allow');
      grant.disabled = true;
      row.append(title, status, grant);
      permissions.append(row);
      this.permissionRows.set(permission, { row, status, grant });
    }
    uiText(this.setupQuit, 'ui.quit');
    this.setupQuit.className = 'setup-quit';
    this.setup.append(
      header,
      this.setupMessage,
      sources,
      hint,
      permissions,
      this.setupQuit,
    );
    this.surface.className = 'voice-surface';
    this.dock.className = 'orb-dock';
    this.card.className = 'voice-card';
    this.card.dataset.liveInteractive = '';
    place(this.card, OVERLAY_GEOMETRY.card);
    this.header.className = 'voice-header';
    uiLabel(this.header, 'ui.dragHint');
    this.shortcut.className = 'voice-shortcut';
    const brand = uiText(document.createElement('span'), 'ui.appName');
    this.header.append(uiIcon('qwen'), brand, this.shortcut);
    place(this.header, OVERLAY_GEOMETRY.header);
    makeOverlayDraggable(this.header, api);
    this.orb.className = 'voice-orb idle';
    this.orb.setAttribute('aria-hidden', 'true');
    const core = document.createElement('span');
    core.className = 'orb-core';
    const wave = document.createElement('span');
    wave.className = 'voice-wave';
    for (let i = 0; i < 7; i++) {
      const bar = document.createElement('i');
      this.bars.push(bar);
      wave.append(bar);
    }
    core.append(wave);
    this.orb.append(core);
    place(this.orb, OVERLAY_GEOMETRY.orbMotion);
    const summarySlot = document.createElement('div');
    summarySlot.className = 'task-summary-slot';
    place(summarySlot, OVERLAY_GEOMETRY.summary);
    this.summary.className = 'task-summary';
    this.summary.setAttribute('aria-haspopup', 'dialog');
    const summaryTitle = uiText(
      document.createElement('span'),
      'subagents.title',
    );
    this.summaryRunning.className = 'task-summary-running';
    this.summaryCompleted.className = 'task-summary-completed';
    this.summaryAttention.className = 'task-summary-attention';
    this.summaryAttention.textContent = '!';
    this.summary.append(
      uiIcon('task'),
      summaryTitle,
      this.summaryRunning,
      this.summaryCompleted,
      this.summaryAttention,
    );
    summarySlot.append(this.summary);
    this.dock.append(this.card, this.header, summarySlot);
    this.toolbar.className = 'voice-controls';
    this.toolbar.setAttribute('role', 'toolbar');
    uiLabel(this.toolbar, 'ui.toolbar');
    this.toolbar.dataset.liveInteractive = '';
    place(this.toolbar, OVERLAY_GEOMETRY.toolbar);
    this.call.className = 'primary';
    this.quitButton.className = 'quit-control';
    icon(this.microphone, 'mic');
    icon(this.speaker, 'volume');
    icon(this.call, 'play');
    icon(this.settingsButton, 'settings');
    this.settingsButton.className = 'settings-control';
    icon(this.quitButton, 'quit');
    this.settingsButton.setAttribute('aria-haspopup', 'dialog');
    this.toolbar.append(
      this.microphone,
      this.speaker,
      this.call,
      this.settingsButton,
      this.quitButton,
    );
    this.dock.append(this.orb, this.toolbar);
    this.status.className = 'voice-status';
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    place(this.status, OVERLAY_GEOMETRY.status);
    this.statusPrimary.className = 'voice-status-primary';
    this.statusPrimary.dataset.liveInteractive = '';
    this.statusAudio.className = 'voice-status-audio';
    this.statusAudio.hidden = false;
    this.permissionLink.className = 'permission-link';
    uiText(this.permissionLink, 'ui.openPermission');
    this.status.append(
      this.statusPrimary,
      this.permissionLink,
      this.statusAudio,
    );
    this.caption.className = 'voice-caption';
    this.caption.setAttribute('role', 'status');
    place(this.caption, OVERLAY_GEOMETRY.caption);
    this.preview.className = 'camera-preview';
    place(this.preview, OVERLAY_GEOMETRY.preview);
    const slot = document.createElement('div');
    slot.className = 'camera-preview-slot';
    slot.dataset.liveCameraPreview = '';
    this.previewBadge.className = 'camera-preview-badge';
    this.preview.append(slot, this.previewBadge);
    this.previewToggle.className = 'preview-toggle';
    this.previewToggle.hidden = true;
    this.previewToggle.setAttribute('aria-controls', 'camera-preview');
    this.preview.id = 'camera-preview';
    place(this.previewToggle, OVERLAY_GEOMETRY.previewToggle);
    icon(this.previewToggle, 'eye');
    this.dock.append(this.previewToggle);
    this.dock.append(this.status);
    this.surface.append(this.preview, this.caption, this.dock);
    this.settings = new SettingsPanel(
      api,
      (open) => {
        this.settingsButton.setAttribute('aria-expanded', String(open));
      },
      (error) => {
        this.error = error;
        if (this.state) this.update(this.state);
      },
    );
    this.app.append(this.setup, this.surface, this.settings.element);
    this.removers.push(this.api.onSettingsDismiss(() => this.settings.hide()));
    this.removers.push(
      this.api.onOverlayOffset((offset) => {
        this.receivedOverlayOffset = true;
        this.applyOverlayOffset(offset);
      }),
    );
    this.setup.hidden = false;
    this.surface.hidden = true;
    this.setupMessage.textContent = liveText('en', 'ui.connecting');
  }

  update(state: HostPublicState): void {
    if (this.disposed) return;
    applyTheme(this.app.ownerDocument, state.resolvedTheme, state.themeColor);
    const language = state.language ?? 'en';
    if (this.renderedLanguage !== language) {
      localizeUi(this.app, language);
      this.renderedLanguage = language;
      this.app.ownerDocument.documentElement.lang = language;
      this.preview.style.setProperty(
        '--camera-connecting-text',
        JSON.stringify(liveText(language, 'ui.previewConnecting')),
      );
    }
    if (
      state.visualInput?.source === 'camera' &&
      this.state?.visualInput?.source !== 'camera'
    )
      this.previewExpanded = true;
    this.state = state;
    if (!this.receivedOverlayOffset)
      this.applyOverlayOffset(state.overlayOffset ?? { x: 0, y: 0 });
    this.settings.update(state);
    const quitting = this.quitting || state.quitState === 'pending';
    const quitFailed = this.quitFailed || state.quitState === 'failed';
    if (quitting) this.settings.hide();
    const needsSetup = shouldRenderSetup(
      state.live,
      state.connection === 'ready',
    );
    if (!needsSetup) this.hasShownOrb = true;
    const setup = needsSetup && !(this.hasShownOrb && (quitting || quitFailed));
    this.setup.hidden = !setup;
    this.surface.hidden = setup;
    const active = isActiveLiveCall(state.live);
    const orbState = quitFailed
      ? 'error'
      : quitting
        ? 'stopping'
        : state.live.state;
    this.orb.className = `voice-orb ${orbState}${state.live.inputMuted ? ' muted' : ''}`;
    if (
      state.live.state !== 'listening' ||
      state.live.inputMuted ||
      quitting ||
      quitFailed
    )
      this.resetInputScale();
    label(
      this.call,
      liveText(language, active ? 'ui.endCall' : 'ui.startCall'),
    );
    this.call.title = liveText(language, 'ui.shortcutAction', {
      action: liveText(language, active ? 'ui.endCall' : 'ui.startCall'),
      shortcut: state.live.shortcut,
    });
    icon(this.call, active ? 'stop' : 'play');
    this.call.classList.toggle('active', active);
    label(
      this.microphone,
      liveText(
        language,
        state.live.inputMuted ? 'ui.unmuteInput' : 'ui.muteInput',
      ),
    );
    label(
      this.speaker,
      liveText(
        language,
        state.live.outputMuted ? 'ui.unmuteOutput' : 'ui.muteOutput',
      ),
    );
    this.microphone.setAttribute(
      'aria-pressed',
      String(state.live.inputMuted === true),
    );
    this.speaker.setAttribute(
      'aria-pressed',
      String(state.live.outputMuted === true),
    );
    icon(this.microphone, state.live.inputMuted ? 'micOff' : 'mic');
    icon(this.speaker, state.live.outputMuted ? 'volumeOff' : 'volume');
    const pending = this.busy || quitting || quitFailed;
    this.call.disabled =
      pending ||
      state.connection !== 'ready' ||
      state.live.state === 'stopping';
    this.microphone.disabled = this.speaker.disabled =
      pending ||
      state.connection !== 'ready' ||
      state.live.state === 'stopping';
    this.settingsButton.disabled = pending || state.connection !== 'ready';
    this.quitButton.disabled = this.setupQuit.disabled = quitting;
    const quitError = quitFailed ? liveText(language, 'ui.quitFailed') : '';
    const status = quitting
      ? liveText(language, 'ui.quitting')
      : quitError ||
        displayLiveMessage(
          language,
          this.error ||
            state.live.statusText ||
            state.visualError ||
            state.live.message ||
            '',
        ) ||
        liveText(
          language,
          (
            {
              idle: 'ui.ready',
              starting: 'ui.starting',
              listening: 'ui.listening',
              thinking: 'ui.thinking',
              speaking: 'ui.speaking',
              stopping: 'ui.stopping',
              error: 'ui.callEnded',
              unavailable: 'ui.unavailable',
            } as const
          )[state.live.state],
        );
    text(this.statusPrimary, status ?? '');
    this.statusPrimary.title = status ?? '';
    const audioStatusKey = state.live.inputMuted
      ? state.live.outputMuted
        ? 'ui.micAndSpeakerMuted'
        : 'ui.micOff'
      : state.live.outputMuted
        ? 'ui.speakerMuted'
        : undefined;
    text(
      this.statusAudio,
      audioStatusKey
        ? liveText(language, audioStatusKey)
        : state.visualInput
          ? `${liveText(language, state.visualInput.source === 'camera' ? 'ui.camera' : 'ui.screen')} · ${liveText(language, state.visualInput.mode === 'live-feed' ? 'ui.liveFeed' : 'ui.onDemand')}`
          : '',
    );
    this.statusAudio.hidden = !this.statusAudio.textContent;
    this.statusAudio.title = this.statusAudio.textContent;
    this.status.classList.toggle('has-audio-status', Boolean(audioStatusKey));
    this.status.classList.toggle(
      'error',
      Boolean(
        quitFailed ||
          this.error ||
          state.live.state === 'error' ||
          state.visualError,
      ),
    );
    const showPermission =
      Boolean(state.live.pendingPermission) && !quitting && !quitFailed;
    this.statusPrimary.hidden = showPermission;
    this.permissionLink.hidden = !showPermission;
    this.permissionLink.disabled = pending;
    const caption = state.live.outputMuted ? (state.live.caption ?? '') : '';
    text(this.caption, caption);
    this.caption.hidden = !caption;
    this.caption.scrollTop = this.caption.scrollHeight;
    const cameraAvailable =
      !setup &&
      !quitting &&
      !quitFailed &&
      shouldShowCameraPreview(
        state.live,
        state.visualInput,
        state.connection === 'ready',
      );
    const preview = cameraAvailable && this.previewExpanded;
    this.preview.hidden = !preview;
    this.preview.style.top = `${caption ? OVERLAY_GEOMETRY.previewWithCaption.y : OVERLAY_GEOMETRY.preview.y}px`;
    this.previewToggle.hidden = !cameraAvailable;
    this.previewToggle.disabled = pending;
    this.previewToggle.setAttribute(
      'aria-pressed',
      String(this.previewExpanded),
    );
    label(
      this.previewToggle,
      liveText(
        language,
        this.previewExpanded ? 'ui.hidePreview' : 'ui.showPreview',
      ),
    );
    icon(this.previewToggle, this.previewExpanded ? 'eye' : 'eyeOff');
    text(
      this.previewBadge,
      state.visualReady
        ? liveText(language, 'ui.cameraBadge', {
            mode: liveText(
              language,
              active
                ? state.visualInput?.mode === 'live-feed'
                  ? 'ui.liveFeed'
                  : 'ui.onDemand'
                : 'ui.localPreview',
            ),
          })
        : liveText(language, 'ui.cameraConnecting'),
    );
    if (cameraAvailable && !this.previewAttached) {
      this.api.attachCameraPreview();
      this.previewAttached = true;
    }
    const reservePreview =
      this.previewExpanded &&
      state.visualInput?.source === 'camera' &&
      state.connection === 'ready' &&
      !quitting &&
      !quitFailed;
    const layout: OverlayLayout = setup
      ? 'setup'
      : reservePreview
        ? 'orb-preview'
        : 'orb';
    if (layout !== this.overlayLayout) {
      this.overlayLayout = layout;
      this.api.setOverlayLayout(layout);
    }
    text(this.setupShortcut, state.live.shortcut);
    text(
      this.setupMessage,
      quitting
        ? liveText(language, 'ui.quitting')
        : quitError ||
            displayLiveMessage(
              language,
              this.error || state.live.message || state.connectionError || '',
            ) ||
            (state.connection === 'ready'
              ? liveText(language, 'ui.allowRequired')
              : liveText(language, 'ui.waiting')),
    );
    for (const [control, selected] of [
      [this.setupScreen, state.visualInput?.source === 'screen'],
      [this.setupCamera, state.visualInput?.source === 'camera'],
    ] as const) {
      control.disabled =
        pending || state.connection !== 'ready' || !state.visualInput;
      control.classList.toggle('selected', selected);
      control.setAttribute('aria-pressed', String(selected));
    }
    for (const [permission, controls] of this.permissionRows) {
      const relevant =
        permission === 'microphone' ||
        (state.visualInput?.source === 'camera'
          ? permission === 'camera'
          : permission !== 'camera' &&
            (permission !== 'accessibility' ||
              state.visualInput?.mode !== 'live-feed'));
      controls.row.hidden = state.connection !== 'ready' || !relevant;
      const granted = state.permissions[permission] === 'granted';
      text(
        controls.status,
        liveText(language, granted ? 'ui.allowed' : 'ui.required'),
      );
      controls.status.classList.toggle('granted', granted);
      controls.grant.hidden = granted;
      controls.grant.disabled = pending;
    }
    text(
      this.shortcut,
      state.live.shortcut
        .replace(/Command/g, '⌘')
        .replace(/Control/g, '⌃')
        .replace(/Alt|Option/g, '⌥')
        .replace(/Shift/g, '⇧')
        .replace(/\+/g, ' '),
    );
    const snapshot = state.subagentsV1;
    this.summary.hidden = !snapshot;
    this.summary.disabled = pending || state.connection !== 'ready';
    if (snapshot) {
      const { running, completed, needsAttention } = snapshot.counts;
      const waiting =
        needsAttention + (snapshot.pendingUnassignedPermissions ?? 0);
      text(this.summaryRunning, String(running));
      text(this.summaryCompleted, `✓ ${completed}`);
      this.summaryAttention.hidden = waiting === 0;
      label(
        this.summary,
        liveText(language, 'subagents.summaryLabel', {
          running,
          completed,
          waiting,
        }),
      );
    }
  }

  setInputLevel(level: number): void {
    if (
      this.disposed ||
      this.state?.live.state !== 'listening' ||
      this.state.live.inputMuted ||
      this.state.quitState ||
      this.quitting ||
      this.quitFailed
    )
      return;
    const bounded = Number.isFinite(level)
      ? Math.min(1, Math.max(0, level))
      : 0;
    const target =
      1 + Math.min(0.3, Math.sqrt(Math.max(0, bounded - 0.005)) * 1.25);
    this.inputScale =
      target > this.inputScale
        ? target
        : target + (this.inputScale - target) * 0.75;
    if (this.inputScale - 1 < 0.003) this.inputScale = 1;
    const strength = (this.inputScale - 1) / 0.3;
    for (const [index, bar] of this.bars.entries()) {
      const weight = 1 - Math.abs(3 - index) * 0.06;
      bar.style.transform = `scaleY(${0.3 + strength * 0.7 * weight})`;
    }
    if (this.inputReleaseTimer !== undefined)
      clearTimeout(this.inputReleaseTimer);
    this.inputReleaseTimer = setTimeout(() => {
      this.inputReleaseTimer = undefined;
      this.setInputLevel(0);
    }, 32);
    if (this.inputScale === 1) {
      clearTimeout(this.inputReleaseTimer);
      this.inputReleaseTimer = undefined;
    }
  }

  private resetInputScale(): void {
    if (this.inputReleaseTimer !== undefined)
      clearTimeout(this.inputReleaseTimer);
    this.inputReleaseTimer = undefined;
    this.inputScale = 1;
    for (const bar of this.bars) bar.style.removeProperty('transform');
  }

  private applyOverlayOffset(offset: { x: number; y: number }): void {
    if (this.disposed) return;
    const transform = `translate(${offset.x}px, ${offset.y}px)`;
    for (const element of [this.surface, this.setup, this.settings.element]) {
      if (element.style.transform !== transform)
        element.style.transform = transform;
    }
  }

  dispose(): void {
    this.settings.dispose();
    this.disposed = true;
    this.resetInputScale();
    for (const remove of this.removers) remove();
  }

  private async toggleCall(): Promise<void> {
    if (!this.state || this.busy) return;
    const active = isActiveLiveCall(this.state.live);
    await this.action(() => (active ? this.api.stop() : this.api.toggle()));
  }

  private async quit(): Promise<void> {
    if (this.quitting) return;
    this.quitting = true;
    this.quitFailed = false;
    this.error = '';
    if (this.state) this.update(this.state);
    try {
      await this.api.quit();
    } catch (error) {
      this.quitFailed = true;
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.quitting = false;
      if (this.state) this.update(this.state);
    }
  }

  private async action(run: () => Promise<void>): Promise<void> {
    if (this.busy || this.quitting || this.quitFailed || this.state?.quitState)
      return;
    this.busy = true;
    this.error = '';
    if (this.state) this.update(this.state);
    try {
      await run();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      if (this.state) this.update(this.state);
    }
  }
}
