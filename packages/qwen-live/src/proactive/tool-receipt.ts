/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ProactiveTask } from './task-manager.js';

export type ProactiveReceiptOperation =
  | 'create_task'
  | 'update_task'
  | 'cancel_task'
  | 'list_tasks';

export type ProactiveFailureCode =
  | 'capacity'
  | 'missing_target'
  | 'target_not_found'
  | 'ambiguous_target'
  | 'task_busy'
  | 'invalid_arguments'
  | 'validation_error'
  | 'execution_error';

export interface ProactiveTaskSnapshot {
  task_id: string;
  title: string;
  task_type: ProactiveTask['taskType'];
  status: ProactiveTask['status'];
  monitor_mode: ProactiveTask['monitorMode'];
  repeat: boolean;
  modalities?: string[];
  user_intent_text?: string;
  intervention_text?: string;
  duration_sec?: number;
  reminder_text?: string;
  remaining_sec?: number;
  pending_delivery_count?: number;
}

export interface ProactiveReceiptResult {
  op: ProactiveReceiptOperation;
  success: boolean;
  atomic?: true;
  task_id?: string;
  title?: string;
  task_type?: ProactiveTask['taskType'];
  status?: ProactiveTask['status'];
  monitor_mode?: ProactiveTask['monitorMode'];
  repeat?: boolean;
  modalities?: string[];
  user_intent_text?: string;
  intervention_text?: string;
  duration_sec?: number;
  reminder_text?: string;
  cancelled_count?: number;
  cancelled_ids?: string[];
  cancelled_tasks?: Array<{ title: string }>;
  tasks?: ProactiveTaskSnapshot[];
  error?: string;
}

/**
 * Internal authoritative receipt. Keep this structure for state/diagnostics;
 * submit only `renderProactiveToolReceipt(receipt)` to the realtime model.
 */
export interface ProactiveToolReceipt {
  results: ProactiveReceiptResult[];
  active_tasks: ProactiveTaskSnapshot[];
  atomic: true;
  committed: boolean;
  failure_code?: ProactiveFailureCode;
  error?: string;
}

const FAILURE_CODES = new Set<ProactiveFailureCode>([
  'capacity',
  'missing_target',
  'target_not_found',
  'ambiguous_target',
  'task_busy',
  'invalid_arguments',
  'validation_error',
  'execution_error',
]);

const FAILURE_FALLBACK = '提醒任务未创建或修改，原因暂时无法确认。';
const VALIDATION_FAILURE = '提醒任务未创建或修改，提交的信息未通过校验。';
const INVALID_ARGUMENT_FACTS = new Map<string, string>([
  [
    'Tool arguments must be valid JSON.',
    '提醒任务未创建或修改，工具参数必须是有效的 JSON。',
  ],
  [
    'Tool arguments must be an object.',
    '提醒任务未创建或修改，工具参数必须是 JSON 对象。',
  ],
  [
    'An adjacent selector-less update may only set repeat=true.',
    '提醒任务未修改。仅对紧邻刚创建的任务设置 repeat=true 时可省略目标；其他修改必须提供 target_title 或 target_title_contains。',
  ],
  [
    'Selector-less update has no adjacent active task.',
    '提醒任务未修改，没有紧邻刚创建的活动任务；请提供 target_title 或 target_title_contains。',
  ],
  [
    'An adjacent selector-less cancel must have no arguments.',
    '提醒任务未停止。紧邻刚创建任务的无目标取消必须使用空参数对象；其他取消请提供 target_title、target_title_contains 或 all=true。',
  ],
  [
    'Selector-less cancel has no adjacent active task.',
    '提醒任务未停止，没有紧邻刚创建的活动任务；请提供 target_title 或 target_title_contains，停止全部任务请使用 all=true。',
  ],
]);

export function snapshotProactiveTask(
  task: ProactiveTask,
): ProactiveTaskSnapshot {
  const common: ProactiveTaskSnapshot = {
    task_id: task.taskId,
    title: task.title,
    task_type: task.taskType,
    status: task.status,
    monitor_mode: task.monitorMode,
    repeat: task.repeat,
    ...(task.pendingDeliveryCount !== undefined
      ? { pending_delivery_count: task.pendingDeliveryCount }
      : {}),
  };
  if (task.taskType === 'perception_monitor') {
    return {
      ...common,
      modalities: [...task.modalities],
      user_intent_text: task.taskDescription,
      intervention_text: task.interventionText,
    };
  }
  return {
    ...common,
    duration_sec: task.durationSec,
    reminder_text: task.reminderText,
    ...(task.remainingSec !== undefined
      ? { remaining_sec: task.remainingSec }
      : {}),
  };
}

export function buildProactiveCreateReceipt(
  task: ProactiveTask,
  activeTasks: readonly ProactiveTask[],
): ProactiveToolReceipt {
  return successReceipt(
    [{ op: 'create_task', success: true, ...snapshotProactiveTask(task) }],
    activeTasks,
  );
}

export function buildProactiveUpdateReceipt(
  task: ProactiveTask,
  activeTasks: readonly ProactiveTask[],
): ProactiveToolReceipt {
  return successReceipt(
    [
      {
        op: 'update_task',
        task_id: task.taskId,
        title: task.title,
        success: true,
      },
    ],
    activeTasks,
  );
}

export function buildProactiveCancelReceipt(
  cancelledTasks: readonly ProactiveTask[],
  activeTasks: readonly ProactiveTask[],
): ProactiveToolReceipt {
  if (cancelledTasks.length === 0) {
    return buildProactiveFailureReceipt(
      'cancel_task',
      new Error('No active task matched the cancel selector.'),
      activeTasks,
      'target_not_found',
    );
  }
  const result: ProactiveReceiptResult =
    cancelledTasks.length === 1
      ? {
          op: 'cancel_task',
          task_id: cancelledTasks[0]!.taskId,
          title: cancelledTasks[0]!.title,
          success: true,
        }
      : {
          op: 'cancel_task',
          cancelled_count: cancelledTasks.length,
          cancelled_ids: cancelledTasks.map((task) => task.taskId),
          cancelled_tasks: cancelledTasks.map((task) => ({
            title: task.title,
          })),
          success: true,
        };
  return successReceipt([result], activeTasks);
}

export function buildProactiveListReceipt(
  activeTasks: readonly ProactiveTask[],
): ProactiveToolReceipt {
  const snapshot = activeTasks.map(snapshotProactiveTask);
  return {
    results: [{ op: 'list_tasks', success: true, tasks: snapshot }],
    active_tasks: snapshot,
    atomic: true,
    committed: true,
  };
}

export function buildProactiveFailureReceipt(
  operation: ProactiveReceiptOperation,
  error: unknown,
  activeTasks: readonly ProactiveTask[],
  failureCode?: ProactiveFailureCode,
): ProactiveToolReceipt {
  const message = boundedErrorMessage(error);
  const code =
    failureCode ??
    explicitFailureCode(error) ??
    classifyProactiveFailure(error);
  return {
    results: [
      {
        op: operation,
        success: false,
        atomic: true,
        error: message,
      },
    ],
    active_tasks: activeTasks.map(snapshotProactiveTask),
    atomic: true,
    committed: false,
    failure_code: code,
    error: message,
  };
}

export function classifyProactiveFailure(error: unknown): ProactiveFailureCode {
  const message = boundedErrorMessage(error).toLocaleLowerCase();
  if (/capacity|task limit|too many (?:active )?tasks/u.test(message)) {
    return 'capacity';
  }
  if (/ambiguous|not unique|more than one/u.test(message)) {
    return 'ambiguous_target';
  }
  if (/\bbusy\b|provisioning|delivering|after it settles/u.test(message)) {
    return 'task_busy';
  }
  if (
    /no task title selector|no target selector|selector was provided/u.test(
      message,
    )
  ) {
    return 'missing_target';
  }
  if (/no matching|not found|no active task matched/u.test(message)) {
    return 'target_not_found';
  }
  if (
    /invalid|must |provide exactly|all=true|fields do not apply|needs at least|non-empty|unsupported|already exists|only active|valid only|positive finite/u.test(
      message,
    )
  ) {
    return 'validation_error';
  }
  return 'execution_error';
}

/** Render only speakable authoritative facts; never serialize the envelope. */
export function renderProactiveToolReceipt(receipt: unknown): string {
  if (!isRecord(receipt) || receipt['committed'] !== true) {
    return renderFailureFact(receipt);
  }
  const results = receipt['results'];
  if (!Array.isArray(results)) return FAILURE_FALLBACK;

  const sentences: string[] = [];
  for (const rawResult of results) {
    if (!isRecord(rawResult) || rawResult['success'] !== true) {
      return renderFailureFact(receipt);
    }
    switch (rawResult['op']) {
      case 'create_task':
        sentences.push(renderCreatedTask(rawResult));
        break;
      case 'update_task': {
        const title = safePhrase(rawResult['title'], '这项提醒', 80);
        sentences.push(`提醒任务“${title}”已更新。`);
        break;
      }
      case 'cancel_task': {
        const names = speechSafeNames(rawResult['cancelled_tasks']);
        if (names.length === 0) {
          names.push(safePhrase(rawResult['title'], '这项提醒', 80));
        }
        sentences.push(`提醒任务${joinSpokenNames(names)}已停止。`);
        break;
      }
      case 'list_tasks': {
        const tasks = rawResult['tasks'];
        if (!Array.isArray(tasks)) return '提醒任务状态暂时无法确认。';
        sentences.push(renderTaskList(tasks));
        break;
      }
      default:
        return FAILURE_FALLBACK;
    }
  }
  return sentences.join('') || FAILURE_FALLBACK;
}

function successReceipt(
  results: ProactiveReceiptResult[],
  activeTasks: readonly ProactiveTask[],
): ProactiveToolReceipt {
  return {
    results,
    active_tasks: activeTasks.map(snapshotProactiveTask),
    atomic: true,
    committed: true,
  };
}

function renderCreatedTask(result: Record<string, unknown>): string {
  const title = safePhrase(result['title'], '这项提醒', 80);
  const state = proactiveStartState(result['status']);
  if (result['task_type'] === 'time_reminder') {
    const reminder = safePhrase(result['reminder_text'], title, 100);
    const duration = spokenDuration(result['duration_sec']);
    return `${duration}后的定时提醒“${title}”${state}，提醒内容是“${reminder}”。`;
  }
  if (result['task_type'] === 'perception_monitor') {
    const media = spokenMedia(result['modalities']);
    const intent = safePhrase(result['user_intent_text'], title, 100);
    if (result['monitor_mode'] === 'always') {
      return `${media}持续解说“${title}”${state}，关注“${intent}”，只在出现新事件或明显变化时更新。`;
    }
    const guidance = safePhrase(
      result['intervention_text'],
      '自然提醒用户',
      100,
    );
    const cadence =
      result['repeat'] === true ? '，每次独立再次出现都会触发' : '';
    return `${media}监控“${title}”${state}，条件是“${intent}”，触发后的回应要求是“${guidance}”${cadence}。`;
  }
  return `提醒任务“${title}”${state}${
    result['repeat'] === true ? '，将重复提醒' : ''
  }。`;
}

function renderTaskList(tasks: unknown[]): string {
  if (tasks.length === 0) return '当前没有活动中的提醒任务。';
  const rendered: string[] = [];
  for (const rawTask of tasks) {
    if (!isRecord(rawTask)) return '提醒任务状态暂时无法确认。';
    const title = safePhrase(rawTask['title'], '未命名提醒', 80);
    const state = taskState(
      rawTask['status'],
      rawTask['task_type'],
      rawTask['monitor_mode'],
    );
    let kind: string;
    const details: string[] = [];
    if (rawTask['task_type'] === 'time_reminder') {
      kind = '定时提醒';
      details.push(`设定时长${spokenDuration(rawTask['duration_sec'])}`);
      const remaining = rawTask['remaining_sec'];
      if (
        typeof remaining === 'number' &&
        Number.isFinite(remaining) &&
        remaining >= 0
      ) {
        details.push(
          remaining === 0 ? '已到提醒时间' : `剩余${spokenDuration(remaining)}`,
        );
      }
      details.push(
        `提醒内容是“${safePhrase(rawTask['reminder_text'], title, 1_000)}”`,
      );
    } else {
      const media = spokenMedia(rawTask['modalities']);
      const narration = rawTask['monitor_mode'] === 'always';
      kind = narration ? `${media}解说任务` : `${media}监控任务`;
      details.push(
        `${narration ? '关注' : '条件是'}“${safePhrase(rawTask['user_intent_text'], title, 1_000)}”`,
      );
      details.push(
        `${narration ? '解说风格是' : '触发后的回应要求是'}“${safePhrase(rawTask['intervention_text'], '自然提醒用户', 1_000)}”`,
      );
      if (!narration)
        details.push(rawTask['repeat'] === true ? '重复监控' : '仅提醒一次');
    }
    const pending = rawTask['pending_delivery_count'];
    if (Number.isSafeInteger(pending) && Number(pending) > 0) {
      details.push(`有${Number(pending)}条通知等待或正在播报`);
    }
    rendered.push(`${kind}“${title}”${state}，${details.join('，')}`);
  }
  return `当前共有${rendered.length}项活动中的提醒任务：${rendered.join('；')}。`;
}

function taskState(
  status: unknown,
  taskType: unknown,
  monitorMode: unknown,
): string {
  if (status === 'provisioning') return '正在启动';
  if (status === 'running') {
    if (taskType === 'time_reminder') return '正在计时等待';
    return monitorMode === 'always' ? '正在持续解说' : '正在监控';
  }
  if (status === 'delivering') return '已触发，正在等待播报完成';
  return '状态暂时无法确认';
}

function proactiveStartState(status: unknown): string {
  if (status === 'running') return '已启动';
  if (status === 'provisioning') return '已受理，正在启动';
  return '已创建';
}

function spokenMedia(value: unknown): string {
  if (!Array.isArray(value)) return '画面和声音';
  const modalities = new Set(value.filter((item) => typeof item === 'string'));
  if (modalities.size === 1 && modalities.has('vision')) return '画面';
  if (modalities.size === 1 && modalities.has('audio')) return '声音';
  return '画面和声音';
}

function spokenDuration(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return '约定时间';
  }
  const seconds = Math.max(1, Math.round(value));
  if (seconds % 3_600 === 0) return `${seconds / 3_600}小时`;
  if (seconds % 60 === 0) return `${seconds / 60}分钟`;
  if (seconds > 60) {
    return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
  }
  return `${seconds}秒`;
}

function renderFailureFact(receipt: unknown): string {
  if (!isRecord(receipt)) return FAILURE_FALLBACK;
  switch (receipt['failure_code']) {
    case 'capacity':
      return '提醒任务未创建，当前活动任务已达上限。';
    case 'missing_target':
    case 'target_not_found':
    case 'ambiguous_target':
    case 'task_busy':
      return '提醒任务未修改，没有找到唯一可操作的活动任务。';
    case 'invalid_arguments':
      return (
        INVALID_ARGUMENT_FACTS.get(
          typeof receipt['error'] === 'string' ? receipt['error'] : '',
        ) ?? VALIDATION_FAILURE
      );
    case 'validation_error':
      return VALIDATION_FAILURE;
    default:
      return FAILURE_FALLBACK;
  }
}

function explicitFailureCode(error: unknown): ProactiveFailureCode | undefined {
  if (!isRecord(error)) return undefined;
  const code = error['code'];
  return typeof code === 'string' &&
    FAILURE_CODES.has(code as ProactiveFailureCode)
    ? (code as ProactiveFailureCode)
    : undefined;
}

function boundedErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown Proactive failure.';
  const normalized = raw.replace(/\s+/gu, ' ').trim();
  return (normalized || 'Unknown Proactive failure.').slice(0, 300);
}

function speechSafeNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const title = safePhrase(item['title'], '这项提醒', 80);
    if (!result.includes(title)) result.push(title);
  }
  return result;
}

function joinSpokenNames(names: readonly string[]): string {
  const quoted = names.map((name) => `“${name}”`);
  if (quoted.length <= 1) return quoted.join('');
  return `${quoted.slice(0, -1).join('、')}和${quoted.at(-1)}`;
}

function safePhrase(
  value: unknown,
  fallback: string,
  maxChars: number,
): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (
    !normalized ||
    /\p{C}/u.test(normalized) ||
    /```|~~~/u.test(normalized) ||
    /(?:HARNESS_BACKGROUND_EVENTS|PROACTIVE_EVENT|TASK_SNAPSHOT|FRONTIER_RESULT|FRONTIER_ERROR|CLIENT_CLOCK)/iu.test(
      normalized,
    ) ||
    /<\s*\/?\s*[A-Za-z][^>]*>|\[\s*\/?\s*(?:INST|SYS|SYSTEM|ASSISTANT|USER|TOOL|FUNCTION|INSTRUCTIONS?|CONTEXT|METADATA|JSON|XML)\b[^\]]*\]/iu.test(
      normalized,
    ) ||
    isJsonEnvelope(normalized)
  ) {
    return fallback;
  }
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function isJsonEnvelope(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) || isRecord(parsed);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
