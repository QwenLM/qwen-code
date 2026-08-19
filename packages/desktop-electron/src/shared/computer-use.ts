/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const COMPUTER_USE_CHANNELS = {
  setAlwaysHidePictureInPicture: 'desktop-computer-use:set-always-hide-pip',
  setPictureInPictureVisible: 'desktop-computer-use:set-pip-visible',
  stateChanged: 'desktop-computer-use:state-changed',
  stop: 'desktop-computer-use:stop',
} as const;

export const COMPUTER_USE_CONTROL_CSS = `
  [data-qwen-desktop-computer-use-control] {
    app-region: no-drag;
    color: var(--foreground, #ececec);
    font-family: inherit;
    position: fixed;
    right: 14px;
    top: 48px;
    z-index: 2147483646;
  }

  [data-qwen-desktop-computer-use-control][hidden] {
    display: none !important;
  }

  body:has([data-qwen-desktop-browser-panel]:not([hidden]))
    [data-qwen-desktop-computer-use-control] {
    right: calc(var(--qwen-desktop-browser-width, 520px) + 14px);
  }

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

  [data-qwen-desktop-computer-use-popover][hidden] {
    display: none !important;
  }

  [data-qwen-desktop-computer-use-heading] {
    font-size: 13px;
    font-weight: 650;
  }

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

  [data-qwen-desktop-computer-use-control] button,
  [data-qwen-desktop-computer-use-control] input {
    app-region: no-drag;
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

  [data-qwen-desktop-computer-use-stop]:disabled {
    cursor: default;
    opacity: .55;
  }
`;

export interface ComputerUseApi {
  onStateChanged(
    callback: (state: ComputerUseSurfaceState) => void,
  ): () => void;
  setAlwaysHidePictureInPicture(hidden: boolean): Promise<void>;
  setPictureInPictureVisible(visible: boolean): Promise<void>;
  stop(): Promise<void>;
}

export interface ComputerUseSurfaceState {
  active: boolean;
  action: string;
  alwaysHidePictureInPicture: boolean;
  canStopWithEscape: boolean;
  language: string;
  pictureInPictureVisible: boolean;
  previewUnavailable: boolean;
  screenshot?: string;
  sessionId?: string;
  stopping: boolean;
  target?: string;
}

export interface ComputerUseActivitySnapshot {
  active: boolean;
  args: Record<string, unknown>;
  toolName?: string;
}

type ProjectedComputerUseEvent =
  | {
      kind: 'tool';
      args: Record<string, unknown>;
      callId: string;
      status: string;
      toolName: string;
    }
  | {
      kind: 'permission-request';
      args: Record<string, unknown>;
      allowedOptionIds: readonly string[];
      callId: string;
      requestId: string;
      toolName: string;
    }
  | {
      kind: 'permission-resolved';
      optionId?: string;
      requestId: string;
    }
  | { kind: 'turn-terminal' }
  | { kind: 'replay-complete' };

export class ComputerUseActivityTracker {
  private active = false;
  private args: Record<string, unknown> = {};
  private lastCallId: string | undefined;
  private readonly pendingPermissions = new Map<
    string,
    {
      allowedOptionIds: ReadonlySet<string>;
      args: Record<string, unknown>;
      callId: string;
      toolName: string;
    }
  >();
  private toolName: string | undefined;

  consume(raw: unknown): ComputerUseActivitySnapshot {
    const event = projectComputerUseDaemonEvent(raw);
    if (!event) return this.snapshot();
    if (event.kind === 'turn-terminal') {
      this.active = false;
      this.pendingPermissions.clear();
      return this.snapshot();
    }
    if (event.kind === 'replay-complete') return this.snapshot();
    if (event.kind === 'permission-request') {
      this.pendingPermissions.set(event.requestId, {
        allowedOptionIds: new Set(event.allowedOptionIds),
        args: event.args,
        callId: event.callId,
        toolName: event.toolName,
      });
      return this.snapshot();
    }
    if (event.kind === 'permission-resolved') {
      const pending = this.pendingPermissions.get(event.requestId);
      this.pendingPermissions.delete(event.requestId);
      if (!pending || !event.optionId) return this.snapshot();
      if (!pending.allowedOptionIds.has(event.optionId)) return this.snapshot();
      this.args = pending.args;
      this.lastCallId = pending.callId;
      this.toolName = pending.toolName;
      this.active = true;
      return this.snapshot();
    }

    if (
      Object.keys(event.args).length > 0 ||
      event.callId !== this.lastCallId
    ) {
      this.args = event.args;
    }
    this.lastCallId = event.callId;
    this.toolName = event.toolName;
    if (event.status === 'in_progress') this.active = true;
    return this.snapshot();
  }

  reset(): ComputerUseActivitySnapshot {
    this.active = false;
    this.args = {};
    this.lastCallId = undefined;
    this.pendingPermissions.clear();
    this.toolName = undefined;
    return this.snapshot();
  }

  private snapshot(): ComputerUseActivitySnapshot {
    return {
      active: this.active,
      args: this.args,
      ...(this.toolName ? { toolName: this.toolName } : {}),
    };
  }
}

export function projectComputerUseDaemonEvent(
  raw: unknown,
): ProjectedComputerUseEvent | undefined {
  const event = asRecord(raw);
  const eventType = stringValue(event?.['type']);
  if (!eventType) return undefined;
  if (eventType === 'replay_complete') return { kind: 'replay-complete' };
  if (
    eventType === 'turn_complete' ||
    eventType === 'turn_error' ||
    eventType === 'prompt_cancelled'
  ) {
    return { kind: 'turn-terminal' };
  }

  const data = asRecord(event?.['data']);
  if (eventType === 'permission_request') {
    const requestId = stringValue(data?.['requestId']);
    const toolCall = asRecord(data?.['toolCall']);
    const meta = asRecord(toolCall?.['_meta']);
    const toolName =
      stringValue(meta?.['toolName']) ?? stringValue(toolCall?.['toolName']);
    const callId = stringValue(toolCall?.['toolCallId']);
    if (!requestId || !callId || !toolName?.startsWith('computer_use__')) {
      return undefined;
    }
    return {
      kind: 'permission-request',
      allowedOptionIds: permissionAllowOptionIds(data?.['options']),
      args: asRecord(toolCall?.['rawInput']) ?? {},
      callId,
      requestId,
      toolName,
    };
  }
  if (eventType === 'permission_resolved') {
    const requestId = stringValue(data?.['requestId']);
    const outcome = asRecord(data?.['outcome']);
    if (!requestId || !outcome) return undefined;
    return {
      kind: 'permission-resolved',
      ...(outcome['outcome'] === 'selected' &&
      typeof outcome['optionId'] === 'string'
        ? { optionId: outcome['optionId'] }
        : {}),
      requestId,
    };
  }

  const wrappedUpdate = asRecord(data?.['update']);
  const update = wrappedUpdate ?? data;
  const updateType =
    stringValue(update?.['sessionUpdate']) ??
    (eventType === 'tool_call' || eventType === 'tool_call_update'
      ? eventType
      : undefined);
  if (updateType !== 'tool_call' && updateType !== 'tool_call_update') {
    return undefined;
  }

  const meta = asRecord(update?.['_meta']);
  const toolName =
    stringValue(meta?.['toolName']) ?? stringValue(update?.['toolName']);
  if (!toolName?.startsWith('computer_use__')) return undefined;
  const callId =
    stringValue(update?.['toolCallId']) ?? stringValue(update?.['id']);
  if (!callId) return undefined;
  return {
    kind: 'tool',
    args: asRecord(update?.['rawInput']) ?? {},
    callId,
    status: stringValue(update?.['status']) ?? 'pending',
    toolName,
  };
}

export function sessionIdFromUrl(raw: string): string | undefined {
  try {
    const match = new URL(raw).pathname.match(/\/session\/([^/]+)\/?$/);
    if (!match) return undefined;
    return decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
}

export function extractComputerUseTarget(
  args: Record<string, unknown>,
): string | undefined {
  for (const key of ['window_title', 'app_name', 'application', 'bundle_id']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function formatComputerUseAction(
  toolName: string | undefined,
  language: string,
): string {
  const name = toolName?.replace(/^computer_use__/, '') ?? '';
  const chinese = language.toLowerCase().startsWith('zh');
  const labels: Record<string, readonly [string, string]> = {
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
  const label = labels[name];
  if (label) return label[chinese ? 1 : 0];
  if (!name) return chinese ? '正在使用电脑' : 'Using the computer';
  const readable = name.replaceAll('_', ' ');
  return chinese
    ? `执行 ${readable}`
    : readable.replace(/^./, (c) => c.toUpperCase());
}

export function takeSseMessages(buffer: string): {
  messages: string[];
  rest: string;
} {
  const messages: string[] = [];
  let rest = buffer;
  while (true) {
    const match = /\r?\n\r?\n/.exec(rest);
    if (!match || match.index === undefined) break;
    messages.push(rest.slice(0, match.index));
    rest = rest.slice(match.index + match[0].length);
  }
  return { messages, rest };
}

export function parseSseMessage(message: string): unknown {
  const data = message
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data) return undefined;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function permissionAllowOptionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((option) => {
    const record = asRecord(option);
    const kind = stringValue(record?.['kind']);
    const optionId = stringValue(record?.['optionId']);
    return optionId && (kind === 'allow_once' || kind === 'allow_always')
      ? [optionId]
      : [];
  });
}
