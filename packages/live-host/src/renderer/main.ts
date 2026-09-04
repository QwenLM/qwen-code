import type { HostPublicState, LiveHostApi } from '../shared/host-api.ts';
import type { HostPermissions } from '../shared/protocol.ts';
import { shouldRenderSetup } from '../main/live-state-policy.ts';

declare global {
  interface Window {
    qwenLiveHost: LiveHostApi;
  }
}

const appRoot = document.querySelector<HTMLElement>('#app');
if (!appRoot) throw new Error('Missing Live Host root');
const app: HTMLElement = appRoot;

function button(
  label: string,
  action: () => void,
  options?: {
    disabled?: boolean;
    primary?: boolean;
    className?: string;
    symbol?: string;
  },
): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.dataset.liveInteractive = '';
  element.textContent = options?.symbol ?? label;
  element.title = label;
  element.setAttribute('aria-label', label);
  element.disabled = options?.disabled ?? false;
  element.className = [
    options?.primary ? 'primary' : '',
    options?.className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  element.addEventListener('click', action);
  return element;
}

function permissionRow(
  label: string,
  permission: keyof HostPermissions,
  state: HostPermissions[keyof HostPermissions],
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'permission';
  const title = document.createElement('span');
  title.textContent = label;
  const status = document.createElement('span');
  status.textContent =
    state === 'granted' ? '已授权' : state === 'denied' ? '未授权' : '待确认';
  status.className = state === 'granted' ? 'granted' : '';
  if (state === 'granted') row.append(title, status);
  else
    row.append(
      title,
      button(
        '授权',
        () => void window.qwenLiveHost.requestPermission(permission),
      ),
    );
  return row;
}

function microphonePicker(): HTMLElement {
  const row = document.createElement('label');
  row.className = 'microphone-picker';
  const title = document.createElement('span');
  title.textContent = '输入设备';
  const select = document.createElement('select');
  select.dataset.liveInteractive = '';
  const systemDefault = document.createElement('option');
  systemDefault.value = '';
  systemDefault.textContent = '系统默认';
  select.append(systemDefault);
  select.addEventListener('change', () => {
    void window.qwenLiveHost.setInputDevice(select.value || undefined);
  });
  void window.qwenLiveHost.listInputDevices().then((devices) => {
    if (!row.isConnected) return;
    for (const device of devices) {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label;
      option.selected = device.selected;
      select.append(option);
    }
  });
  row.append(title, select);
  return row;
}

function liveStatus(state: HostPublicState): string | undefined {
  if (state.live.statusText) return state.live.statusText;
  switch (state.live.state) {
    case 'starting':
      return '正在开始语音对话…';
    case 'thinking':
      return '思考中';
    case 'stopping':
      return '正在停止…';
    case 'error':
      return state.live.message ?? 'Live 对话已停止';
    default:
      return undefined;
  }
}

type ControlIcon =
  | 'microphone'
  | 'microphoneOff'
  | 'speaker'
  | 'speakerOff'
  | 'stop';

function controlIcon(name: ControlIcon): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('control-icon');
  const paths: Record<ControlIcon, string[]> = {
    microphone: [
      'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z',
      'M5 10v2a7 7 0 0 0 14 0v-2',
      'M12 19v3',
    ],
    microphoneOff: [
      'm2 2 20 20',
      'M9 9v3a3 3 0 0 0 5.1 2.1',
      'M15 9.34V5a3 3 0 0 0-5.94-.6',
      'M5 10v2a7 7 0 0 0 12 4.9',
      'M12 19v3',
    ],
    speaker: [
      'M11 5 6 9H2v6h4l5 4V5Z',
      'M15 9a4 4 0 0 1 0 6',
      'M18 6a8 8 0 0 1 0 12',
    ],
    speakerOff: [
      'm2 2 20 20',
      'M11 5 6 9H2v6h4l5 4v-8',
      'M15 9a4 4 0 0 1 1.4 3',
    ],
    stop: ['M7 7h10v10H7z'],
  };
  for (const data of paths[name]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', data);
    path.setAttribute('fill', name === 'stop' ? 'currentColor' : 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
  }
  return svg;
}

function controlButton(
  label: string,
  icon: ControlIcon,
  action: () => void,
  options?: { disabled?: boolean; primary?: boolean; className?: string },
): HTMLButtonElement {
  const element = button(label, action, {
    disabled: options?.disabled,
    primary: options?.primary,
    className: `control-button ${options?.className ?? ''}`.trim(),
  });
  element.replaceChildren(controlIcon(icon));
  return element;
}

function renderSetup(state: HostPublicState): void {
  const panel = document.createElement('section');
  panel.className = 'setup-panel';
  panel.dataset.liveInteractive = '';

  const header = document.createElement('div');
  header.className = 'setup-header';
  const orb = document.createElement('span');
  orb.className = `setup-dot ${state.connection}`;
  const title = document.createElement('strong');
  title.textContent = 'Qwen Live';
  const shortcut = document.createElement('span');
  shortcut.className = 'shortcut';
  shortcut.textContent = state.live.shortcut;
  header.append(orb, title, shortcut);
  panel.append(header);

  const blocker = document.createElement('div');
  blocker.className = 'blocker';
  blocker.textContent =
    state.live.message ??
    state.live.blocker ??
    state.connectionError ??
    '等待 Qwen Code WebShell…';
  panel.append(blocker);

  if (state.permissions.microphone === 'granted') {
    panel.append(microphonePicker());
  }

  if (state.connection === 'ready') {
    const permissions = document.createElement('div');
    permissions.className = 'permissions';
    permissions.append(
      permissionRow('麦克风', 'microphone', state.permissions.microphone),
      permissionRow(
        '辅助功能（Appshot）',
        'accessibility',
        state.permissions.accessibility,
      ),
      permissionRow(
        '屏幕录制（Appshot）',
        'screenRecording',
        state.permissions.screenRecording,
      ),
    );
    panel.append(permissions);
  }
  app.append(panel);
}

function render(state: HostPublicState): void {
  app.replaceChildren();
  if (shouldRenderSetup(state.live, state.connection === 'ready')) {
    renderSetup(state);
    return;
  }

  const surface = document.createElement('section');
  surface.className = 'voice-surface';

  const active = !['idle', 'unavailable', 'error'].includes(state.live.state);
  const captionText = state.live.outputMuted ? state.live.caption : undefined;
  let caption: HTMLElement | undefined;
  if (captionText) {
    const captionElement = document.createElement('div');
    captionElement.className = 'voice-caption';
    captionElement.setAttribute('role', 'status');
    captionElement.setAttribute('aria-live', 'polite');
    captionElement.textContent = captionText;
    requestAnimationFrame(() => {
      captionElement.scrollTop = captionElement.scrollHeight;
    });
    caption = captionElement;
  }

  const statusText = liveStatus(state);
  const stage = document.createElement('div');
  stage.className =
    statusText || state.live.pendingPermission
      ? 'voice-stage has-status'
      : 'voice-stage';

  const orb = document.createElement('div');
  orb.className = `voice-orb ${state.live.state}`;
  orb.dataset.liveInteractive = '';
  orb.title = active ? '停止语音对话' : '开始语音对话';
  orb.addEventListener('click', () => {
    if (active) void window.qwenLiveHost.stop();
    else void window.qwenLiveHost.toggle();
  });
  stage.append(orb);

  if (state.live.pendingPermission) {
    const openWebShell = button(
      '等待授权 · 前往 WebShell',
      () => void window.qwenLiveHost.openWebShellForPermission(),
      { className: 'web-shell-permission' },
    );
    openWebShell.dataset.liveOpenWebShell = '';
    stage.append(openWebShell);
  } else if (statusText) {
    const status = document.createElement('div');
    status.className = 'voice-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = statusText;
    stage.append(status);
  }

  const actions = document.createElement('div');
  actions.className = 'voice-controls';
  if (active) {
    actions.append(
      controlButton(
        state.live.outputMuted ? '取消语音静音' : '语音静音',
        state.live.outputMuted ? 'speakerOff' : 'speaker',
        () => {
          void window.qwenLiveHost.setOutputMuted(!state.live.outputMuted);
        },
      ),
      controlButton(
        '停止语音对话',
        'stop',
        () => {
          void window.qwenLiveHost.stop();
        },
        { primary: true },
      ),
      controlButton(
        state.live.inputMuted ? '取消麦克风静音' : '麦克风静音',
        state.live.inputMuted ? 'microphoneOff' : 'microphone',
        () => {
          void window.qwenLiveHost.setInputMuted(!state.live.inputMuted);
        },
      ),
    );
    stage.append(actions);
  }
  surface.append(stage);
  if (caption) surface.append(caption);
  app.append(surface);
}

void window.qwenLiveHost.getState().then(render);
window.qwenLiveHost.onState(render);
window.qwenLiveHost.onInputLevel((level) => {
  const orb = document.querySelector<HTMLElement>('.voice-orb.listening');
  if (!orb) return;
  const bounded = Math.min(1, Math.max(0, level));
  orb.style.transform = `scale(${1 + bounded * 0.7})`;
});
