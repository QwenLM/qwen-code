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

let enabled = false;

function render(state) {
  enabled = state.active;
  badge.textContent = enabled ? 'On' : 'Off';
  badge.className = `badge${enabled ? ' on' : ''}`;
  inactive.hidden = enabled;
  active.hidden = !enabled;
  toggle.textContent = enabled
    ? 'Disconnect phone access'
    : 'Turn on Local Control';
  toggle.className = enabled ? 'stop' : '';
  qr.innerHTML = enabled ? state.qrSvg || '' : '';
  url.textContent = enabled ? state.url || '' : '';
  sleep.textContent = state.sleepInhibited
    ? 'Trusted Wi-Fi · Unencrypted · Re-enable after network changes'
    : 'Trusted Wi-Fi · Unencrypted · May sleep · Re-enable after network changes';
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
    throw new Error('The Desktop bridge is unavailable.');
  }
  await listen('local-control-changed', ({ payload }) => render(payload));
  render(await invoke('local_control_status'));
}

initialize().catch((failure) => {
  error.hidden = false;
  error.textContent = String(failure);
  toggle.disabled = true;
});
