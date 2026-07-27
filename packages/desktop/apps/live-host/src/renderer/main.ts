import type { HostPublicState, LiveHostApi } from '../shared/host-api.ts';
import type { HostPermissions, SessionLocator } from '../shared/protocol.ts';

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
  options?: { disabled?: boolean; primary?: boolean },
): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.disabled = options?.disabled ?? false;
  if (options?.primary) element.className = 'primary';
  element.addEventListener('click', action);
  return element;
}

function sessionRow(label: string, locator: SessionLocator): HTMLElement {
  const row = document.createElement('div');
  row.className = 'session-link';
  const title = document.createElement('span');
  title.textContent = label;
  row.append(
    title,
    button('打开', () => void window.qwenLiveHost.openSession(locator)),
  );
  return row;
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

function render(state: HostPublicState): void {
  app.replaceChildren();
  const panel = document.createElement('section');
  panel.className = 'panel';

  const header = document.createElement('div');
  header.className = 'header';
  const identity = document.createElement('div');
  identity.className = 'identity';
  const orb = document.createElement('span');
  orb.className = `orb ${state.connection === 'ready' ? state.live.state : state.connection}`;
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = `Qwen Live · ${state.live.state}`;
  identity.append(orb, title);
  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = '⌘ ⌘';
  header.append(identity, hint);
  panel.append(header);

  const blocker =
    state.live.message ?? state.live.blocker ?? state.connectionError;
  if (blocker) {
    const message = document.createElement('div');
    message.className = 'blocker';
    message.textContent = blocker;
    panel.append(message);
  }

  const transcript = document.createElement('div');
  transcript.className = 'transcript';
  transcript.textContent =
    state.live.transcript || '双击 Command 开始 Live 对话。';
  panel.append(transcript);

  const active = !['idle', 'unavailable', 'error'].includes(state.live.state);
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(
    button(
      active ? '停止对话' : '开始对话',
      () => {
        if (active) void window.qwenLiveHost.stop();
        else void window.qwenLiveHost.toggle();
      },
      {
        disabled: active ? false : !state.live.available,
        primary: true,
      },
    ),
    button('新对话', () => void window.qwenLiveHost.newConversation(), {
      disabled: !state.live.available,
    }),
    button(
      state.live.inputMuted ? '打开麦克风' : '麦克风静音',
      () => {
        void window.qwenLiveHost.setInputMuted(!state.live.inputMuted);
      },
      { disabled: !active },
    ),
    button(
      state.live.outputMuted ? '打开声音' : '扬声器静音',
      () => {
        void window.qwenLiveHost.setOutputMuted(!state.live.outputMuted);
      },
      { disabled: !active },
    ),
  );
  panel.append(actions);

  if (!state.live.available) {
    const permissions = document.createElement('div');
    permissions.className = 'permissions';
    permissions.append(
      permissionRow('麦克风', 'microphone', state.permissions.microphone),
      permissionRow(
        '输入监控（DoubleCommand）',
        'inputMonitoring',
        state.permissions.inputMonitoring,
      ),
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

  if (state.live.coordinator || state.live.workers?.length) {
    const sessions = document.createElement('div');
    sessions.className = 'sessions';
    if (state.live.coordinator)
      sessions.append(sessionRow('当前对话', state.live.coordinator));
    state.live.workers?.forEach((worker, index) => {
      sessions.append(sessionRow(`任务 ${index + 1}`, worker));
    });
    panel.append(sessions);
  }

  app.append(panel);
}

void window.qwenLiveHost.getState().then(render);
window.qwenLiveHost.onState(render);
