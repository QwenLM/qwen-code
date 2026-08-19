const invoke = window.__TAURI__?.core?.invoke;
const listen = window.__TAURI__?.event?.listen;
let state;

function labels() {
  if ((navigator.language || '').toLowerCase().startsWith('zh')) {
    return {
      escape: '按 Esc 取消',
      hide: '隐藏画中画',
      stop: '停止',
      stopInQwen: '在 Qwen Code 中停止',
      stopping: '正在停止…',
      title: 'Qwen Code 正在使用你的电脑',
      unavailable: '屏幕预览不可用',
      waiting: '正在等待屏幕画面',
    };
  }
  return {
    escape: 'Esc to cancel',
    hide: 'Hide picture in picture',
    stop: 'Stop',
    stopInQwen: 'Stop in Qwen Code',
    stopping: 'Stopping…',
    title: 'Qwen Code is using your computer',
    unavailable: 'Screen preview unavailable',
    waiting: 'Waiting for the screen',
  };
}

function formatAction(toolName) {
  const name = String(toolName || '').replace(/^computer_use__/, '');
  const chinese = (navigator.language || '').toLowerCase().startsWith('zh');
  const actions = {
    bring_to_front: ['Bringing app forward', '切换到目标应用'],
    click: ['Clicking', '点击'],
    double_click: ['Double-clicking', '双击'],
    drag: ['Dragging', '拖动'],
    get_accessibility_tree: ['Reading controls', '读取界面控件'],
    get_window_state: ['Reading the screen', '查看屏幕'],
    hotkey: ['Using a shortcut', '使用快捷键'],
    launch_app: ['Opening an app', '打开应用'],
    move_cursor: ['Moving the pointer', '移动指针'],
    page: ['Using the browser', '操作浏览器'],
    press_key: ['Pressing a key', '按键'],
    right_click: ['Right-clicking', '右键点击'],
    scroll: ['Scrolling', '滚动'],
    set_value: ['Setting a value', '设置内容'],
    type_text: ['Typing', '输入文字'],
    zoom: ['Zooming', '缩放'],
  };
  if (actions[name]) return actions[name][chinese ? 1 : 0];
  if (!name) return chinese ? '正在使用电脑' : 'Using the computer';
  const readable = name.replaceAll('_', ' ');
  return chinese
    ? `执行 ${readable}`
    : readable.replace(/^./, (c) => c.toUpperCase());
}

function setText(selector, value) {
  for (const element of document.querySelectorAll(selector))
    element.textContent = value;
}

function render(next) {
  state = next;
  const copy = labels();
  setText('[data-value="title"]', copy.title);
  setText('[data-value="action"]', formatAction(state.toolName));
  setText('[data-value="target"]', state.target ? ` · ${state.target}` : '');
  setText(
    '[data-value="shortcut"]',
    state.canStopWithEscape ? copy.escape : copy.stopInQwen,
  );
  setText(
    '[data-value="waiting"]',
    state.previewUnavailable ? copy.unavailable : copy.waiting,
  );
  const image = document.querySelector('[data-value="screenshot"]');
  const empty = document.querySelector('[data-value="empty"]');
  if (image && empty) {
    if (state.screenshot) {
      image.src = state.screenshot;
      image.hidden = false;
      empty.hidden = true;
    } else {
      image.removeAttribute('src');
      image.hidden = true;
      empty.hidden = false;
    }
  }
  const stop = document.querySelector('[data-action="stop"]');
  if (stop) {
    stop.disabled = state.stopping;
    stop.textContent = state.stopping ? copy.stopping : copy.stop;
  }
  const hide = document.querySelector('[data-action="hide"]');
  if (hide) {
    hide.title = copy.hide;
    hide.setAttribute('aria-label', copy.hide);
  }
}

document
  .querySelector('[data-action="stop"]')
  ?.addEventListener('click', () => {
    invoke?.('computer_use_stop').catch(() => {});
  });
document
  .querySelector('[data-action="hide"]')
  ?.addEventListener('click', () => {
    invoke?.('computer_use_set_picture_in_picture_visible', {
      visible: false,
    }).catch(() => {});
  });
listen?.('desktop-computer-use-state', ({ payload }) => render(payload))
  .then(() => invoke?.('computer_use_request_state'))
  .catch(() => {});
