const tauri = window.__TAURI__;
const invoke = tauri?.core?.invoke;
const listen = tauri?.event?.listen;

const title = document.querySelector('#title');
const detail = document.querySelector('#detail');
const pulse = document.querySelector('#pulse');
const workspace = document.querySelector('#workspace');
const error = document.querySelector('#error');
const choose = document.querySelector('#choose');
const retry = document.querySelector('#retry');
const logs = document.querySelector('#logs');
const update = document.querySelector('#update');
const version = document.querySelector('#version');

let currentWorkspace = '';
let snapshotOverrideStatus;
let updateVersion;

function setWorkspace(path) {
  workspace.hidden = !path;
  workspace.textContent = path || '';
}

function setStatus(kind, heading, message, failure = '') {
  document.body.dataset.state = kind;
  title.textContent = heading;
  detail.textContent = message;
  pulse.className = `pulse ${kind === 'starting' ? '' : kind}`;
  error.style.display = failure ? 'block' : 'none';
  error.textContent = failure;
  retry.hidden = kind !== 'error';
  choose.hidden = kind === 'starting';
  choose.disabled = kind === 'starting';
  setWorkspace(kind === 'starting' ? '' : currentWorkspace);
}

async function chooseWorkspace() {
  if (!invoke) return;
  snapshotOverrideStatus = 'starting';
  setStatus(
    'starting',
    'Opening workspace',
    'Starting the bundled Qwen Code runtime…',
  );
  try {
    const path = await invoke('choose_workspace');
    if (path) currentWorkspace = path;
    else
      setStatus('idle', 'Choose another workspace', 'No folder was selected.');
  } catch (failure) {
    setStatus(
      'error',
      'Workspace could not start',
      'Review the details or open the desktop log.',
      String(failure),
    );
  }
}

async function retryRuntime() {
  if (!invoke) return;
  snapshotOverrideStatus = 'starting';
  setStatus(
    'starting',
    'Restarting Qwen Code',
    'Checking the bundled runtime and workspace…',
  );
  try {
    await invoke('restart_runtime');
  } catch (failure) {
    setStatus(
      'error',
      'Qwen Code could not restart',
      'Review the details or choose another workspace.',
      String(failure),
    );
  }
}

async function installUpdate() {
  if (!invoke) return;
  update.disabled = true;
  update.textContent = `Installing ${updateVersion || 'update'}…`;
  try {
    await invoke('install_update');
  } catch (failure) {
    setStatus(
      'error',
      'Update failed',
      'Qwen Code remains usable. Try again or update manually.',
      String(failure),
    );
  } finally {
    update.disabled = false;
    update.textContent = 'Install update';
  }
}

async function openLogs() {
  if (!invoke) return;
  try {
    await invoke('open_logs');
  } catch (failure) {
    setStatus(
      'error',
      'Logs could not open',
      'Review the details or try again.',
      String(failure),
    );
  }
}

choose.addEventListener('click', chooseWorkspace);
retry.addEventListener('click', retryRuntime);
logs.addEventListener('click', openLogs);
update.addEventListener('click', installUpdate);

async function initialize() {
  if (!invoke || !listen) {
    setStatus(
      'error',
      'Desktop bridge unavailable',
      'The packaged desktop bridge did not initialize.',
      'Restart Qwen Code.',
    );
    return;
  }

  await Promise.all([
    listen('runtime-starting', ({ payload }) => {
      snapshotOverrideStatus = 'starting';
      currentWorkspace = String(payload || '');
      setStatus(
        'starting',
        'Starting Qwen Code',
        'Launching the bundled runtime and checking its health…',
      );
    }),
    listen('runtime-failed', ({ payload }) => {
      snapshotOverrideStatus = 'failed';
      setStatus(
        'error',
        'Qwen Code could not start',
        'Review the details, open the log, or choose another workspace.',
        String(payload),
      );
    }),
    listen('update-available', ({ payload }) => {
      updateVersion = String(payload);
      update.hidden = false;
      update.textContent = `Install ${updateVersion}`;
    }),
  ]);

  const state = await invoke('bootstrap_state');
  version.textContent = `Desktop ${state.desktopVersion}`;
  currentWorkspace ||= String(state.workspace || '');
  if (snapshotOverrideStatus) {
    if (snapshotOverrideStatus === 'failed') setWorkspace(currentWorkspace);
    return;
  }
  if (state.status === 'starting') {
    setStatus(
      'starting',
      'Starting Qwen Code',
      'Launching the bundled runtime and checking its health…',
    );
  } else if (state.status === 'ready') {
    setStatus(
      'starting',
      'Loading Qwen Code',
      'Connecting to the local Web Shell…',
    );
  } else if (state.error) {
    setStatus(
      'error',
      'Qwen Code could not start',
      'Review the details, open the log, or choose another workspace.',
      state.error,
    );
  } else {
    setStatus(
      'idle',
      'Choose another workspace',
      'The automatic workspace did not start.',
    );
  }
}

initialize().catch((failure) => {
  setStatus(
    'error',
    'Desktop initialization failed',
    'Restart Qwen Code or inspect the desktop log.',
    String(failure),
  );
});
