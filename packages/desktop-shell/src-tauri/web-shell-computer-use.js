/* global document, location, navigator, setInterval, window */

(() => {
  if (
    window.__qwenTauriComputerUseInstalled ||
    location.protocol !== 'http:' ||
    location.hostname !== '127.0.0.1'
  ) {
    return;
  }
  window.__qwenTauriComputerUseInstalled = true;

  const invoke = window.__TAURI__?.core?.invoke;
  const listen = window.__TAURI__?.event?.listen;
  if (!invoke || !listen) return;

  const style = document.createElement('style');
  style.textContent = `
    [data-qwen-desktop-computer-use-control] {
      -webkit-app-region: no-drag;
      color: var(--foreground, #ececec);
      font-family: inherit;
      position: fixed;
      right: 14px;
      top: 48px;
      z-index: 2147483646;
    }
    [data-qwen-desktop-computer-use-control][hidden],
    [data-qwen-desktop-computer-use-popover][hidden] { display: none !important; }
    [data-qwen-desktop-computer-use-trigger] {
      align-items: center;
      backdrop-filter: blur(18px);
      background: color-mix(in srgb, var(--background, #111) 86%, transparent);
      border: 1px solid color-mix(in srgb, currentColor 13%, transparent);
      border-radius: 10px;
      color: inherit;
      cursor: pointer;
      display: flex;
      font: inherit;
      font-size: 12px;
      gap: 7px;
      height: 30px;
      padding: 0 10px;
    }
    [data-qwen-desktop-computer-use-dot] {
      background: #16a34a;
      border-radius: 999px;
      box-shadow: 0 0 0 4px rgb(22 163 74 / 14%);
      height: 7px;
      width: 7px;
    }
    [data-qwen-desktop-computer-use-popover] {
      backdrop-filter: blur(24px);
      background: color-mix(in srgb, var(--background, #111) 94%, transparent);
      border: 1px solid color-mix(in srgb, currentColor 13%, transparent);
      border-radius: 14px;
      box-shadow: 0 18px 46px rgb(0 0 0 / 22%);
      box-sizing: border-box;
      display: grid;
      gap: 13px;
      min-width: 292px;
      padding: 15px;
      position: absolute;
      right: 0;
      top: 36px;
    }
    [data-qwen-desktop-computer-use-heading] { font-size: 13px; font-weight: 650; }
    [data-qwen-desktop-computer-use-action],
    [data-qwen-desktop-computer-use-target] {
      color: color-mix(in srgb, currentColor 65%, transparent);
      font-size: 12px;
      line-height: 1.4;
    }
    [data-qwen-desktop-computer-use-row] {
      align-items: center;
      display: flex;
      font-size: 12px;
      gap: 10px;
      justify-content: space-between;
    }
    [data-qwen-desktop-computer-use-secondary],
    [data-qwen-desktop-computer-use-stop] {
      border: 0;
      border-radius: 8px;
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      padding: 7px 10px;
    }
    [data-qwen-desktop-computer-use-secondary] {
      background: color-mix(in srgb, currentColor 8%, transparent);
      color: inherit;
    }
    [data-qwen-desktop-computer-use-stop] {
      background: #dc2626;
      color: white;
      width: 100%;
    }
    [data-qwen-desktop-computer-use-stop]:disabled { cursor: default; opacity: .55; }
  `;

  let elements;
  let state;

  function labels() {
    if ((navigator.language || '').toLowerCase().startsWith('zh')) {
      return {
        alwaysHide: '总是隐藏画中画',
        hide: '隐藏',
        pictureInPicture: '画中画',
        show: '显示',
        stop: '停止电脑操作',
        stopping: '正在停止…',
        target: '目标',
        title: 'Computer Use',
      };
    }
    return {
      alwaysHide: 'Always hide picture in picture',
      hide: 'Hide',
      pictureInPicture: 'Picture in picture',
      show: 'Show',
      stop: 'Stop computer use',
      stopping: 'Stopping…',
      target: 'Target',
      title: 'Computer Use',
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

  function render(next) {
    state = next;
    if (!elements) return;
    const copy = labels();
    elements.root.hidden = !state.active;
    if (!state.active) {
      elements.popover.hidden = true;
      elements.trigger.setAttribute('aria-expanded', 'false');
    }
    elements.trigger.setAttribute(
      'aria-label',
      `${copy.title}: ${formatAction(state.toolName)}`,
    );
    elements.action.textContent = formatAction(state.toolName);
    elements.target.textContent = state.target
      ? `${copy.target}: ${state.target}`
      : '';
    elements.target.hidden = !state.target;
    elements.alwaysHide.checked = state.alwaysHidePictureInPicture;
    elements.pictureInPicture.textContent = state.pictureInPictureVisible
      ? copy.hide
      : copy.show;
    elements.pictureInPicture.disabled = !state.active;
    elements.stop.textContent = state.stopping ? copy.stopping : copy.stop;
    elements.stop.disabled = !state.active || state.stopping;
  }

  function mount() {
    if (elements || !document.body) return;
    document.head.append(style);
    const copy = labels();
    const root = document.createElement('aside');
    root.dataset.qwenDesktopComputerUseControl = '';
    root.hidden = true;

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.dataset.qwenDesktopComputerUseTrigger = '';
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'false');
    const dot = document.createElement('span');
    dot.dataset.qwenDesktopComputerUseDot = '';
    dot.setAttribute('aria-hidden', 'true');
    const triggerText = document.createElement('span');
    triggerText.textContent = copy.title;
    trigger.append(dot, triggerText);

    const popover = document.createElement('section');
    popover.dataset.qwenDesktopComputerUsePopover = '';
    popover.hidden = true;
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', copy.title);
    const heading = document.createElement('div');
    heading.dataset.qwenDesktopComputerUseHeading = '';
    heading.textContent = copy.title;
    const action = document.createElement('div');
    action.dataset.qwenDesktopComputerUseAction = '';
    const target = document.createElement('div');
    target.dataset.qwenDesktopComputerUseTarget = '';

    const pipRow = document.createElement('div');
    pipRow.dataset.qwenDesktopComputerUseRow = '';
    const pipLabel = document.createElement('span');
    pipLabel.textContent = copy.pictureInPicture;
    const pictureInPicture = document.createElement('button');
    pictureInPicture.type = 'button';
    pictureInPicture.dataset.qwenDesktopComputerUseSecondary = '';
    pipRow.append(pipLabel, pictureInPicture);

    const hideRow = document.createElement('label');
    hideRow.dataset.qwenDesktopComputerUseRow = '';
    const hideLabel = document.createElement('span');
    hideLabel.textContent = copy.alwaysHide;
    const alwaysHide = document.createElement('input');
    alwaysHide.type = 'checkbox';
    hideRow.append(hideLabel, alwaysHide);

    const stop = document.createElement('button');
    stop.type = 'button';
    stop.dataset.qwenDesktopComputerUseStop = '';
    popover.append(heading, action, target, pipRow, hideRow, stop);
    root.append(trigger, popover);
    document.body.append(root);

    elements = {
      root,
      trigger,
      popover,
      action,
      target,
      pictureInPicture,
      alwaysHide,
      stop,
    };
    trigger.addEventListener('click', () => {
      const open = popover.hidden;
      popover.hidden = !open;
      trigger.setAttribute('aria-expanded', String(open));
    });
    pictureInPicture.addEventListener('click', () => {
      if (state)
        invoke('computer_use_set_picture_in_picture_visible', {
          visible: !state.pictureInPictureVisible,
        }).catch(() => {});
    });
    alwaysHide.addEventListener('change', () => {
      invoke('computer_use_set_always_hide_picture_in_picture', {
        hidden: alwaysHide.checked,
      }).catch(() => {});
    });
    stop.addEventListener('click', () =>
      invoke('computer_use_stop').catch(() => {}),
    );
    document.addEventListener('pointerdown', (event) => {
      if (!root.contains(event.target)) {
        popover.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
      }
    });
    if (state) render(state);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
  listen('desktop-computer-use-state', ({ payload }) => render(payload))
    .then(() => invoke('computer_use_request_state'))
    .catch(() => {});

  let lastUrl = '';
  const syncSession = () => {
    if (location.href === lastUrl) return;
    const currentUrl = location.href;
    invoke('computer_use_sync_session')
      .then(() => {
        lastUrl = currentUrl;
      })
      .catch(() => {});
  };
  syncSession();
  setInterval(syncSession, 300);
})();
