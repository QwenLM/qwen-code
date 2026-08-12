const tauri = window.__TAURI__;
const invoke = tauri?.core?.invoke;
const listen = tauri?.event?.listen;

const badge = document.querySelector('#badge');
const inactive = document.querySelector('#inactive');
const active = document.querySelector('#active');
const qr = document.querySelector('#qr');
const url = document.querySelector('#url');
const sleep = document.querySelector('#sleep');
const error = document.querySelector('#error');
const toggle = document.querySelector('#toggle');

const messages = {
  en: {
    title: 'Local Control',
    heading: 'Local Control',
    subtitle: 'Continue this session from your phone.',
    off: 'Off',
    on: 'On',
    inactiveCopy:
      'Turn this on, then scan from a phone on the same trusted Wi-Fi.',
    inactiveNotice:
      'Uses unencrypted HTTP. Phone access stays closed until enabled.',
    qrLabel: 'Local Control QR code',
    turnOn: 'Turn on Local Control',
    disconnect: 'Disconnect phone access',
    awake: 'Trusted Wi-Fi · Unencrypted · Re-enable after network changes',
    maySleep:
      'Trusted Wi-Fi · Unencrypted · May sleep · Re-enable after network changes',
    bridgeUnavailable: 'The Desktop bridge is unavailable.',
  },
  'zh-CN': {
    title: '本地控制',
    heading: '本地控制',
    subtitle: '在手机上继续当前会话。',
    off: '关闭',
    on: '已开启',
    inactiveCopy: '开启后，使用同一受信任 Wi-Fi 中的手机扫码。',
    inactiveNotice: '使用未加密 HTTP。开启前，手机访问保持关闭。',
    qrLabel: '本地控制二维码',
    turnOn: '开启本地控制',
    disconnect: '断开手机访问',
    awake: '受信任 Wi-Fi · 未加密 · 网络变化后需重新开启',
    maySleep: '受信任 Wi-Fi · 未加密 · 可能休眠 · 网络变化后需重新开启',
    bridgeUnavailable: '桌面端桥接不可用。',
  },
};

const language = navigator.language.toLowerCase() === 'zh-cn' ? 'zh-CN' : 'en';
const t = (key) => messages[language][key];

document.documentElement.lang = language;
document.title = `Qwen Code ${t('title')}`;
document.querySelectorAll('[data-i18n]').forEach((element) => {
  element.textContent = t(element.dataset.i18n);
});
qr.setAttribute('aria-label', t('qrLabel'));

let enabled = false;

function render(state) {
  enabled = state.active;
  badge.textContent = enabled ? t('on') : t('off');
  badge.className = `badge${enabled ? ' on' : ''}`;
  inactive.hidden = enabled;
  active.hidden = !enabled;
  toggle.textContent = enabled ? t('disconnect') : t('turnOn');
  toggle.className = enabled ? 'stop' : '';
  qr.innerHTML = enabled ? state.qrSvg || '' : '';
  url.textContent = enabled ? state.url || '' : '';
  sleep.textContent = state.sleepInhibited ? t('awake') : t('maySleep');
  error.hidden = true;
  error.textContent = '';
}

async function toggleLocalControl() {
  if (!invoke) return;
  toggle.disabled = true;
  try {
    if (enabled) {
      await invoke('disable_local_control');
      render({ active: false, sleepInhibited: false });
    } else {
      render(await invoke('enable_local_control'));
    }
  } catch (failure) {
    error.hidden = false;
    error.textContent = String(failure);
  } finally {
    toggle.disabled = false;
  }
}

toggle.addEventListener('click', toggleLocalControl);

async function initialize() {
  if (!invoke || !listen) {
    throw new Error(t('bridgeUnavailable'));
  }
  await listen('local-control-changed', ({ payload }) => render(payload));
  render(await invoke('local_control_status'));
}

initialize().catch((failure) => {
  error.hidden = false;
  error.textContent = String(failure);
  toggle.disabled = true;
});
