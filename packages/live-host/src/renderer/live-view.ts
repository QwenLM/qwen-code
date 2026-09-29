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

type Icon =
  | 'microphone'
  | 'microphoneOff'
  | 'speaker'
  | 'speakerOff'
  | 'play'
  | 'stop'
  | 'settings'
  | 'eye'
  | 'eyeOff'
  | 'quit';
const ICONS: Record<Icon, string[]> = {
  microphone: [
    'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5Z',
    'M5 10v2a7 7 0 0 0 14 0v-2',
    'M12 19v3',
  ],
  microphoneOff: [
    'm2 2 20 20',
    'M9 9v3a3 3 0 0 0 5.1 2.1',
    'M15 9V5a3 3 0 0 0-5.94-.6',
    'M5 10v2a7 7 0 0 0 12 4.9',
    'M12 19v3',
  ],
  speaker: [
    'M11 5 6 9H2v6h4l5 4V5Z',
    'M15 9a4 4 0 0 1 0 6',
    'M18 6a8 8 0 0 1 0 12',
  ],
  speakerOff: ['M11 5 6 9H2v6h4l5 4V5Z', 'm16 9 6 6', 'm22 9-6 6'],
  play: ['m8 4 12 8-12 8V4Z'],
  stop: ['M6 6h12v12H6z'],
  settings: [
    'M9.7 2h4.6l.5 2.7 2 .9 2.3-1.4 2.3 4-1.8 1.8.2 2.2 1.6 2-2.3 4-2.6-.9-1.8 1.3L14 22h-4l-.7-3.4-1.8-1.3-2.6.9-2.3-4 1.6-2 .2-2.2L2.6 8.2l2.3-4 2.3 1.4 2-.9L9.7 2Z',
    'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z',
  ],
  eye: [
    'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z',
    'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  ],
  eyeOff: [
    'm3 3 18 18',
    'M10 5.2A12 12 0 0 1 12 5c6.5 0 10 7 10 7a19 19 0 0 1-3 4',
    'M6 6C3.5 8 2 12 2 12s3.5 7 10 7a12 12 0 0 0 5-1',
    'M9 9a4 4 0 0 0 6 6',
  ],
  quit: ['M12 2v10', 'M6 5a9 9 0 1 0 12 0'],
};

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

function icon(element: HTMLButtonElement, name: Icon): void {
  if (element.dataset.icon === name) return;
  element.dataset.icon = name;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const value of ICONS[name]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', value);
    path.setAttribute(
      'fill',
      name === 'stop' || name === 'play' ? 'currentColor' : 'none',
    );
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
  }
  element.replaceChildren(svg);
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
  private readonly orb = button('ui.controls', () => this.showControls());
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
  private controlsVisible = false;
  private hovering = false;
  private subagentsHovered = false;
  private keyboardMode = false;
  private hideTimer?: ReturnType<typeof setTimeout>;
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
  private readonly keydown = (event: KeyboardEvent) => {
    if (event.key === 'Tab') this.keyboardMode = true;
  };
  private readonly pointerdown = () => {
    this.keyboardMode = false;
    this.syncSubagentsHover();
  };
  private readonly windowBlur = () => {
    this.keyboardMode = false;
    this.hovering = false;
    this.syncSubagentsHover();
  };

  constructor(
    private readonly app: HTMLElement,
    private readonly api: LiveHostApi,
  ) {
    this.setup.className = 'setup-panel';
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
    this.orb.className = 'voice-orb idle';
    this.orb.dataset.liveDrag = '';
    this.orb.title = liveText('en', 'ui.dragHint');
    const core = document.createElement('span');
    core.className = 'orb-core';
    this.orb.append(core);
    place(this.orb, OVERLAY_GEOMETRY.orbMotion);
    place(core, {
      x: (OVERLAY_GEOMETRY.orbMotion.width - OVERLAY_GEOMETRY.orb.width) / 2,
      y: (OVERLAY_GEOMETRY.orbMotion.height - OVERLAY_GEOMETRY.orb.height) / 2,
      width: OVERLAY_GEOMETRY.orb.width,
      height: OVERLAY_GEOMETRY.orb.height,
    });
    makeOverlayDraggable(this.orb, api);
    this.toolbar.className = 'voice-controls';
    this.toolbar.setAttribute('role', 'toolbar');
    uiLabel(this.toolbar, 'ui.toolbar');
    this.toolbar.dataset.liveInteractive = '';
    place(this.toolbar, OVERLAY_GEOMETRY.toolbar);
    this.call.className = 'primary';
    this.quitButton.className = 'quit-control';
    icon(this.microphone, 'microphone');
    icon(this.speaker, 'speaker');
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
    this.statusAudio.hidden = true;
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
    this.surface.append(this.preview, this.caption, this.status, this.dock);
    this.settings = new SettingsPanel(
      api,
      (open) => {
        this.surface.inert = this.setup.inert = open;
        this.syncSubagentsHover();
        this.settingsButton.setAttribute('aria-expanded', String(open));
        if (open) this.showControls();
        else this.scheduleHide();
      },
      (error) => {
        this.error = error;
        if (this.state) this.update(this.state);
      },
    );
    this.app.append(this.setup, this.surface, this.settings.element);
    this.orb.addEventListener('pointerenter', () => {
      this.hovering = true;
      this.showControls();
      this.syncSubagentsHover(undefined, true);
    });
    this.dock.addEventListener('pointerenter', () => {
      this.hovering = true;
      if (this.controlsVisible) this.cancelHide();
      this.syncSubagentsHover(undefined, true);
    });
    this.dock.addEventListener('pointerleave', () => {
      this.hovering = false;
      this.scheduleHide();
      this.syncSubagentsHover();
    });
    this.dock.addEventListener('focusin', () => {
      if (this.keyboardMode) this.showControls();
      this.syncSubagentsHover();
    });
    this.dock.addEventListener('focusout', (event) => {
      this.scheduleHide();
      this.syncSubagentsHover(event.relatedTarget);
    });
    document.addEventListener('keydown', this.keydown);
    document.addEventListener('pointerdown', this.pointerdown, true);
    this.app.ownerDocument.defaultView?.addEventListener(
      'blur',
      this.windowBlur,
    );
    this.removers.push(this.api.onSettingsDismiss(() => this.settings.hide()));
    this.removers.push(
      this.api.onOverlayOffset((offset) => {
        this.receivedOverlayOffset = true;
        this.applyOverlayOffset(offset);
      }),
    );
    this.setControls(false);
    this.setup.hidden = false;
    this.surface.hidden = true;
    this.setupMessage.textContent = liveText('en', 'ui.connecting');
  }

  update(state: HostPublicState): void {
    if (this.disposed) return;
    applyTheme(this.app.ownerDocument, state.resolvedTheme);
    const language = state.language ?? 'en';
    if (this.renderedLanguage !== language) {
      localizeUi(this.app, language);
      this.renderedLanguage = language;
      this.app.ownerDocument.documentElement.lang = language;
      this.orb.title = liveText(language, 'ui.dragHint');
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
    this.orb.className = `voice-orb ${orbState}${state.visualInput?.source === 'camera' ? ' camera-source' : ''}`;
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
    icon(
      this.microphone,
      state.live.inputMuted ? 'microphoneOff' : 'microphone',
    );
    icon(this.speaker, state.live.outputMuted ? 'speakerOff' : 'speaker');
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
      audioStatusKey ? liveText(language, audioStatusKey) : '',
    );
    this.statusAudio.hidden = !audioStatusKey;
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
    this.syncSubagentsHover();
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
    this.orb.style.setProperty('--input-scale', String(this.inputScale));
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
    this.orb.style.setProperty('--input-scale', '1');
  }

  private applyOverlayOffset(offset: { x: number; y: number }): void {
    if (this.disposed) return;
    const transform = `translate(${offset.x}px, ${offset.y}px)`;
    if (this.surface.style.transform !== transform)
      this.surface.style.transform = transform;
  }

  dispose(): void {
    this.settings.dispose();
    this.disposed = true;
    if (this.subagentsHovered) this.api.setSubagentsHover?.(false);
    this.resetInputScale();
    this.cancelHide();
    document.removeEventListener('keydown', this.keydown);
    document.removeEventListener('pointerdown', this.pointerdown, true);
    this.app.ownerDocument.defaultView?.removeEventListener(
      'blur',
      this.windowBlur,
    );
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

  private showControls(): void {
    this.cancelHide();
    this.setControls(true);
  }

  private syncSubagentsHover(
    focused: EventTarget | null = document.activeElement,
    force = false,
  ): void {
    const keyboardHeld =
      this.keyboardMode &&
      focused instanceof this.app.ownerDocument.defaultView!.Node &&
      this.dock.contains(focused);
    this.api.setSubagentsKeyboardHeld?.(
      keyboardHeld && !this.surface.hidden && !this.surface.inert,
    );
    const hovered =
      !this.disposed &&
      !this.surface.hidden &&
      !this.surface.inert &&
      !this.quitting &&
      !this.state?.quitState &&
      this.state?.connection === 'ready' &&
      Boolean(this.state.subagentsV1) &&
      (this.hovering ||
        (this.keyboardMode &&
          focused instanceof this.app.ownerDocument.defaultView!.Node &&
          this.dock.contains(focused)));
    if (hovered === this.subagentsHovered && !(force && hovered)) return;
    this.subagentsHovered = hovered;
    this.api.setSubagentsHover?.(hovered);
  }

  private setControls(visible: boolean): void {
    this.controlsVisible = visible;
    this.dock.classList.toggle('controls-visible', visible);
    this.toolbar.inert = !visible;
    this.toolbar.setAttribute('aria-hidden', String(!visible));
  }

  private cancelHide(): void {
    if (this.hideTimer !== undefined) clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
  }

  private scheduleHide(): void {
    this.cancelHide();
    this.hideTimer = setTimeout(() => {
      this.hideTimer = undefined;
      if (
        !this.hovering &&
        !this.settings.isOpen &&
        !(this.keyboardMode && this.dock.contains(document.activeElement))
      )
        this.setControls(false);
    }, 1000);
  }
}
