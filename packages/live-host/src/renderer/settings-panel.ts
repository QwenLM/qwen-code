import type { HostPublicState, LiveHostApi } from '../shared/host-api.ts';
import { MemoryPanel } from './memory-panel.ts';
import {
  liveText,
  displayLiveMessage,
  type LiveMessageKey,
} from '@qwen-code/qwen-live/i18n';
import { uiText, uiLabel, localizeUi } from './ui-text.ts';
import { makeOverlayDraggable } from './overlay-drag.ts';

function button(label: LiveMessageKey, action: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  uiText(element, label);
  element.addEventListener('click', action);
  return element;
}

function field(label: LiveMessageKey, ...controls: HTMLElement[]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'settings-field';
  const title = document.createElement('strong');
  uiText(title, label);
  const group = document.createElement('div');
  group.className = 'settings-options';
  group.setAttribute('role', 'group');
  uiLabel(group, label);
  group.append(...controls);
  row.append(title, group);
  return row;
}

export class SettingsPanel {
  readonly element = document.createElement('div');
  private readonly panel = document.createElement('section');
  private readonly sourceScreen = button(
    'ui.screen',
    () => void this.run(() => this.api.setVisualSource('screen')),
  );
  private readonly sourceCamera = button(
    'ui.camera',
    () => void this.run(() => this.api.setVisualSource('camera')),
  );
  private readonly modeDemand = button(
    'ui.onDemand',
    () => void this.run(() => this.api.setVisualMode('on-demand')),
  );
  private readonly modeFeed = button(
    'ui.liveFeed',
    () => void this.run(() => this.api.setVisualMode('live-feed')),
  );
  private readonly device = document.createElement('select');
  private readonly display = document.createElement('select');
  private readonly displayField = field('ui.display', this.display);
  private readonly displayHint = document.createElement('p');
  private displayKey = '';
  private readonly refresh = button(
    'ui.refresh',
    () => void this.loadDevices(),
  );
  private readonly status = document.createElement('p');
  private readonly modeDescription = document.createElement('p');
  private readonly memory: MemoryPanel;
  private readonly close = button('ui.close', () => this.hide());
  private readonly openConfig = button(
    'ui.openConfig',
    () => void this.openConfigFile(),
  );
  private readonly configStatus = document.createElement('p');
  private openingConfig = false;
  private configError = '';
  private readonly english = button(
    'language.english',
    () => void this.run(() => this.api.setLanguage('en')),
  );
  private readonly chinese = button(
    'language.chinese',
    () => void this.run(() => this.api.setLanguage('zh-CN')),
  );
  private readonly systemTheme = button(
    'theme.system',
    () => void this.run(() => this.api.setTheme('system')),
  );
  private readonly lightTheme = button(
    'theme.light',
    () => void this.run(() => this.api.setTheme('light')),
  );
  private readonly darkTheme = button(
    'theme.dark',
    () => void this.run(() => this.api.setTheme('dark')),
  );
  private state?: HostPublicState;
  private busy = false;
  private loadingDevices = false;
  private deviceGeneration = 0;
  private deviceKey = '';
  private deviceLabels = new Map<HTMLOptionElement, string>();
  private selectedDeviceId = '';
  private error = '';
  private returnFocus?: HTMLElement;
  private opening = false;
  private openingGeneration = 0;
  private disposed = false;
  private readonly dismissPending = (event: KeyboardEvent) => {
    if (this.opening && event.key === 'Escape') {
      event.preventDefault();
      this.hide();
    }
  };

  constructor(
    private readonly api: LiveHostApi,
    private readonly visibilityChanged: (open: boolean) => void,
    private readonly reportError: (error: string) => void = () => {},
  ) {
    this.element.className = 'settings-layer';
    this.element.hidden = true;
    this.element.dataset.liveInteractive = '';
    this.panel.className = 'settings-panel';
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-modal', 'true');
    this.panel.setAttribute('aria-labelledby', 'settings-title');
    const header = document.createElement('header');
    const title = document.createElement('strong');
    title.id = 'settings-title';
    uiText(title, 'ui.settings');
    uiLabel(this.close, 'ui.closeSettings');
    header.append(title, this.close);
    makeOverlayDraggable(header, api);
    const body = document.createElement('div');
    body.className = 'settings-body';
    const config = document.createElement('div');
    config.className = 'settings-config';
    uiLabel(this.openConfig, 'ui.openConfig');
    this.configStatus.className = 'settings-hint settings-config-status';
    this.configStatus.id = 'settings-config-status';
    this.configStatus.setAttribute('role', 'status');
    this.openConfig.setAttribute('aria-describedby', this.configStatus.id);
    config.append(this.openConfig, this.configStatus);
    uiLabel(this.device, 'ui.audioSource');
    this.device.addEventListener('change', () => {
      const id = this.device.value || undefined;
      this.device.value = this.selectedDeviceId;
      void this.run(async () => {
        await this.api.setInputDevice(id);
        await this.loadDevices();
      });
    });
    uiLabel(this.refresh, 'ui.refreshAudio');
    uiLabel(this.display, 'ui.display');
    this.displayHint.className = 'settings-hint';
    this.displayHint.id = 'display-capture-hint';
    this.display.setAttribute('aria-describedby', this.displayHint.id);
    this.display.addEventListener('change', () => {
      const id = this.display.value;
      this.display.value =
        this.state?.visualInput?.screenDisplayId ?? 'primary';
      void this.run(() => this.api.setScreenDisplay(id));
    });
    this.modeDescription.className = 'settings-hint capture-mode-description';
    this.modeDescription.id = 'capture-mode-description';
    this.modeDemand.setAttribute('aria-describedby', this.modeDescription.id);
    this.modeFeed.setAttribute('aria-describedby', this.modeDescription.id);
    this.memory = new MemoryPanel(api);
    this.status.className = 'settings-status';
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    body.append(
      config,
      field('ui.audioSource', this.device, this.refresh),
      field('ui.videoSource', this.sourceScreen, this.sourceCamera),
      this.displayField,
      this.displayHint,
      field('ui.captureMode', this.modeDemand, this.modeFeed),
      this.modeDescription,
      this.memory.element,
      field('language.label', this.chinese, this.english),
      field('theme.label', this.systemTheme, this.lightTheme, this.darkTheme),
      this.status,
    );
    this.chinese.dataset.language = 'zh-CN';
    this.english.dataset.language = 'en';
    this.systemTheme.dataset.theme = 'system';
    this.lightTheme.dataset.theme = 'light';
    this.darkTheme.dataset.theme = 'dark';
    this.panel.append(header, body);
    this.element.append(this.panel);
    this.element.ownerDocument.addEventListener('keydown', this.dismissPending);
    this.element.addEventListener('pointerdown', (event) => {
      if (event.target === this.element) this.hide();
    });
    this.element.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.hide();
      } else if (event.key === 'Tab') {
        const controls = Array.from(
          this.panel.querySelectorAll<
            HTMLInputElement | HTMLButtonElement | HTMLSelectElement
          >('button, input, select'),
        ).filter((item) => !item.disabled && !item.closest('[hidden]'));
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    });
  }

  get isOpen(): boolean {
    return this.opening || !this.element.hidden;
  }

  show(trigger?: HTMLElement): void {
    if (this.disposed || this.isOpen || this.state?.connection !== 'ready')
      return;
    this.returnFocus = trigger;
    const generation = ++this.openingGeneration;
    this.opening = true;
    this.visibilityChanged(true);
    void (async () => {
      try {
        await this.api.setSettingsOpen(true);
        if (
          this.disposed ||
          generation !== this.openingGeneration ||
          this.state?.connection !== 'ready'
        )
          return;
        this.opening = false;
        this.element.hidden = false;
        this.close.focus();
        void this.loadDevices();
      } catch (error) {
        if (this.disposed || generation !== this.openingGeneration) return;
        this.hide();
        this.reportError(
          error instanceof Error ? error.message : String(error),
        );
      }
    })();
  }

  hide(): void {
    if (!this.isOpen) return;
    const generation = ++this.openingGeneration;
    this.opening = false;
    this.element.hidden = true;
    void this.api.setSettingsOpen(false).catch((error: unknown) => {
      if (!this.disposed && generation === this.openingGeneration)
        this.reportError(
          error instanceof Error ? error.message : String(error),
        );
    });
    this.visibilityChanged(false);
    this.returnFocus?.focus();
  }

  dispose(): void {
    this.hide();
    this.disposed = true;
    this.openingGeneration++;
    this.deviceGeneration++;
    this.element.ownerDocument.removeEventListener(
      'keydown',
      this.dismissPending,
    );
  }

  update(state: HostPublicState): void {
    const microphoneGranted =
      this.state?.permissions.microphone !== 'granted' &&
      state.permissions.microphone === 'granted';
    this.state = state;
    this.memory.update(state);
    if (state.connection !== 'ready') {
      this.deviceGeneration++;
      this.loadingDevices = false;
      this.hide();
    }
    this.render();
    if (microphoneGranted && this.isOpen) void this.loadDevices();
  }

  private render(): void {
    const state = this.state;
    if (this.disposed || !state) return;
    const unavailable = state.connection !== 'ready';
    const language = state.language ?? 'en';
    localizeUi(this.element, language);
    this.openConfig.disabled =
      this.openingConfig ||
      this.busy ||
      unavailable ||
      !state.canOpenConfig ||
      Boolean(state.quitState);
    this.configStatus.textContent =
      displayLiveMessage(language, this.configError) ||
      liveText(
        language,
        this.openingConfig
          ? 'ui.openingConfig'
          : state.canOpenConfig
            ? 'ui.openConfigHint'
            : 'host.config.unavailable',
      );
    this.configStatus.classList.toggle('error', Boolean(this.configError));
    for (const [option, value] of this.deviceLabels) {
      option.textContent = displayLiveMessage(language, value);
    }
    this.modeDescription.textContent =
      state.visualInput?.mode === 'live-feed'
        ? liveText(language, 'ui.modeFeedHint')
        : state.visualInput?.mode === 'on-demand'
          ? liveText(language, 'ui.modeDemandHint')
          : liveText(language, 'ui.modeUnavailable');
    const visualDisabled =
      this.busy ||
      unavailable ||
      !state.visualInput ||
      state.live.state === 'stopping';
    this.displayField.hidden = this.displayHint.hidden =
      state.visualInput?.source !== 'screen';
    this.display.disabled =
      visualDisabled ||
      !state.canSelectScreenDisplay ||
      Boolean(state.quitState);
    const selectedDisplay = state.visualInput?.screenDisplayId ?? 'primary';
    const displays = state.screenDisplays ?? [];
    const displayKey = JSON.stringify([language, selectedDisplay, displays]);
    if (displayKey !== this.displayKey) {
      this.displayKey = displayKey;
      const primary = document.createElement('option');
      primary.value = 'primary';
      primary.textContent = liveText(language, 'ui.primaryDisplay');
      const options = [primary];
      for (const item of displays) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = `${item.name} · ${item.width} × ${item.height}`;
        options.push(option);
      }
      if (
        selectedDisplay !== 'primary' &&
        !displays.some((item) => item.id === selectedDisplay)
      ) {
        const missing = document.createElement('option');
        missing.value = selectedDisplay;
        missing.textContent = liveText(language, 'ui.displayMissing', {
          id: selectedDisplay,
        });
        missing.disabled = true;
        options.push(missing);
      }
      this.display.replaceChildren(...options);
      this.display.value = selectedDisplay;
    }
    this.displayHint.textContent = state.screenDisplaysError
      ? displayLiveMessage(language, state.screenDisplaysError)
      : liveText(
          language,
          state.canSelectScreenDisplay
            ? 'ui.displayCaptureHint'
            : 'ui.displayCaptureUnavailable',
        );
    for (const [control, selected] of [
      [this.sourceScreen, state.visualInput?.source === 'screen'],
      [this.sourceCamera, state.visualInput?.source === 'camera'],
      [this.modeDemand, state.visualInput?.mode === 'on-demand'],
      [this.modeFeed, state.visualInput?.mode === 'live-feed'],
    ] as const) {
      control.disabled = visualDisabled;
      control.classList.toggle('selected', selected);
      control.setAttribute('aria-pressed', String(selected));
    }
    this.device.disabled = this.refresh.disabled =
      this.busy ||
      this.loadingDevices ||
      unavailable ||
      state.permissions.microphone !== 'granted';
    for (const control of [this.chinese, this.english]) {
      const selected = control.dataset.language === language;
      control.classList.toggle('selected', selected);
      control.setAttribute('aria-pressed', String(selected));
      control.disabled = this.busy || unavailable;
    }
    for (const control of [this.systemTheme, this.lightTheme, this.darkTheme]) {
      const selected = control.dataset.theme === (state.theme ?? 'system');
      control.classList.toggle('selected', selected);
      control.setAttribute('aria-pressed', String(selected));
      control.disabled = this.busy || unavailable;
    }
    this.status.textContent =
      displayLiveMessage(
        language,
        this.error || state.visualSettingsError || '',
      ) ||
      (this.busy
        ? liveText(language, 'ui.applying')
        : this.loadingDevices
          ? liveText(language, 'ui.loadingDevices')
          : '');
    this.status.classList.toggle(
      'error',
      Boolean(this.error || state.visualSettingsError),
    );
  }

  private async openConfigFile(): Promise<void> {
    if (this.disposed || this.openConfig.disabled) return;
    this.openingConfig = true;
    this.configError = '';
    this.render();
    try {
      await this.api.openConfig();
    } catch (error) {
      this.configError = error instanceof Error ? error.message : String(error);
    } finally {
      this.openingConfig = false;
      this.render();
    }
  }

  private async run(action: () => Promise<void>): Promise<void> {
    if (this.disposed || this.busy || this.state?.connection !== 'ready')
      return;
    this.busy = true;
    this.error = '';
    this.render();
    try {
      await action();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async loadDevices(): Promise<void> {
    if (
      this.disposed ||
      this.state?.connection !== 'ready' ||
      this.state.permissions.microphone !== 'granted'
    )
      return;
    const generation = ++this.deviceGeneration;
    this.loadingDevices = true;
    this.render();
    try {
      const devices = await this.api.listInputDevices();
      if (generation !== this.deviceGeneration) return;
      const key = JSON.stringify(devices);
      if (key !== this.deviceKey) {
        this.deviceKey = key;
        const systemDefault = document.createElement('option');
        uiText(systemDefault, 'ui.systemDefault');
        systemDefault.value = '';
        const options = [systemDefault];
        this.deviceLabels.clear();
        for (const item of devices) {
          const option = document.createElement('option');
          this.deviceLabels.set(option, item.label);
          option.textContent = displayLiveMessage(
            this.state?.language ?? 'en',
            item.label,
          );
          option.value = item.deviceId;
          options.push(option);
        }
        this.selectedDeviceId =
          devices.find((item) => item.selected)?.deviceId ?? '';
        this.device.replaceChildren(...options);
        this.device.value = this.selectedDeviceId;
        localizeUi(this.element, this.state?.language ?? 'en');
      }
    } catch (error) {
      if (generation === this.deviceGeneration)
        this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (generation === this.deviceGeneration) {
        this.loadingDevices = false;
        this.render();
      }
    }
  }
}
