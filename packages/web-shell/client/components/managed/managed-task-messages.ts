/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Task-panel copy is omitted from the read-only transcript build.
type ManagedTaskMessage =
  | string
  | ((vars?: Record<string, string | number>) => string);

export const MANAGED_TASK_MESSAGES_EN: Record<string, ManagedTaskMessage> = {
  'managed.tasks.title': 'Session tasks',
  'managed.tasks.recovery': 'Resume task cancellation',
  'managed.tasks.description': 'Task status and cancellation for this Session.',
  'managed.tasks.kind.child_agent': 'Child Agent',
  'managed.tasks.kind.workflow': 'Workflow',
  'managed.tasks.kind.background_shell': 'Background Shell',
  'managed.tasks.kind.monitor': 'Monitor',
  'managed.tasks.kind.automation_run': 'Automation run',
  'managed.tasks.kind.channel_delivery': 'Channel delivery',
  'managed.tasks.kind.other': 'Task',
  'managed.tasks.close': 'Close tasks',
  'managed.tasks.back': 'Back to tasks',
  'managed.tasks.previous': 'Previous page',
  'managed.tasks.next': 'Next page',
  'managed.tasks.empty': 'No tasks found.',
  'managed.tasks.emptyPage':
    'No tasks on this page. Continue browsing task pages.',
  'managed.tasks.created': 'Created',
  'managed.tasks.started': 'Started',
  'managed.tasks.settled': 'Ended',
  'managed.tasks.elapsed': 'Elapsed',
  'managed.tasks.seconds': (v) => `${v?.seconds} seconds`,
  'managed.tasks.notStarted': 'Not started',
  'managed.tasks.unsettled': 'Not ended',
  'managed.tasks.events': 'State history',
  'managed.tasks.noEvents': 'No retained events yet.',
  'managed.tasks.historyGap':
    'Some earlier events expired. Showing the available history.',
  'managed.tasks.noArtifacts':
    'This task has not provided viewable Artifacts yet.',
  'managed.tasks.requestCancel': 'Request cancellation',
  'managed.tasks.confirmDescription':
    'Cancel this task? Stopping takes time; existing results are retained.',
  'managed.tasks.confirmCancel': 'Confirm cancellation',
  'managed.tasks.keepRunning': 'Keep running',
  'managed.tasks.continue': 'Continue confirming',
  'managed.tasks.cancel.submitting': 'Submitting cancellation request…',
  'managed.tasks.cancel.stopping':
    'Stop requested. Waiting for the task to end.',
  'managed.tasks.cancel.unconfirmed': 'Cancellation result is unconfirmed.',
  'managed.tasks.cancel.failed': 'Cancellation request failed.',
  'managed.tasks.forbidden':
    'You do not have permission for this task operation.',
  'managed.tasks.operationBusy':
    'Another Session operation is in progress. Try again after it settles.',
  'managed.tasks.sessionInactive':
    'This Session no longer accepts task cancellation.',
  'managed.tasks.actionUnavailable':
    'This task no longer accepts cancellation. Its latest state will be refreshed.',
  'managed.tasks.workspaceUnavailable': 'The Workspace is unavailable.',
  'managed.tasks.notFound': 'The task or Session is no longer readable.',
  'managed.tasks.storage':
    'Browser recovery storage is unavailable. A new cancellation cannot start safely.',
  'managed.tasks.readFailed': 'Could not confirm the latest task information.',
  'managed.tasks.state.pending': 'Pending',
  'managed.tasks.state.running': 'Running',
  'managed.tasks.state.waiting': 'Waiting',
  'managed.tasks.state.completed': 'Completed',
  'managed.tasks.state.failed': 'Failed',
  'managed.tasks.state.cancelled': 'Cancelled',
  'managed.tasks.state.degraded': 'Running with reduced guarantees',
  'managed.tasks.state.recovery_blocked':
    'Outcome requires recovery confirmation',
  'managed.tasks.runtime.unbound': 'Not bound',
  'managed.tasks.runtime.provisioning': 'Preparing',
  'managed.tasks.runtime.ready': 'Ready',
  'managed.tasks.runtime.draining': 'Draining',
  'managed.tasks.runtime.lost': 'Connection lost',
};

export const MANAGED_TASK_MESSAGES_ZH: Record<string, ManagedTaskMessage> = {
  'managed.tasks.title': '会话任务',
  'managed.tasks.recovery': '恢复任务取消确认',
  'managed.tasks.description': '查看此会话的任务状态并请求取消。',
  'managed.tasks.kind.child_agent': '子 Agent',
  'managed.tasks.kind.workflow': '工作流',
  'managed.tasks.kind.background_shell': '后台 Shell',
  'managed.tasks.kind.monitor': '监视',
  'managed.tasks.kind.automation_run': '自动化运行',
  'managed.tasks.kind.channel_delivery': 'channel 投递',
  'managed.tasks.kind.other': '任务',
  'managed.tasks.close': '关闭任务面板',
  'managed.tasks.back': '返回任务列表',
  'managed.tasks.previous': '上一页',
  'managed.tasks.next': '下一页',
  'managed.tasks.empty': '未找到任务。',
  'managed.tasks.emptyPage': '本页没有任务，请继续浏览任务分页。',
  'managed.tasks.created': '创建时间',
  'managed.tasks.started': '开始时间',
  'managed.tasks.settled': '结束时间',
  'managed.tasks.elapsed': '耗时',
  'managed.tasks.seconds': (v) => `${v?.seconds} 秒`,
  'managed.tasks.notStarted': '尚未开始',
  'managed.tasks.unsettled': '尚未结束',
  'managed.tasks.events': '状态时间线',
  'managed.tasks.noEvents': '暂无保留的事件。',
  'managed.tasks.historyGap': '部分较早事件已过期，正在展示可读取的历史。',
  'managed.tasks.noArtifacts': '此任务尚未提供可查看的产物。',
  'managed.tasks.requestCancel': '请求取消',
  'managed.tasks.confirmDescription':
    '取消此任务？停止需要时间，已经产生的结果会保留。',
  'managed.tasks.confirmCancel': '确认取消',
  'managed.tasks.keepRunning': '继续执行',
  'managed.tasks.continue': '继续确认',
  'managed.tasks.cancel.submitting': '正在提交取消请求…',
  'managed.tasks.cancel.stopping': '停止请求已送达，等待任务结束。',
  'managed.tasks.cancel.unconfirmed': '取消结果待确认。',
  'managed.tasks.cancel.failed': '取消请求失败。',
  'managed.tasks.forbidden': '没有执行此任务操作的权限。',
  'managed.tasks.operationBusy': '此会话已有操作处理中，请等待其结束后重试。',
  'managed.tasks.sessionInactive': '此会话已不再接受任务取消。',
  'managed.tasks.actionUnavailable': '此任务已不再接受取消，将刷新最新状态。',
  'managed.tasks.workspaceUnavailable': '工作区不可用。',
  'managed.tasks.notFound': '任务或会话已不可读取。',
  'managed.tasks.storage': '浏览器恢复存储不可用，无法安全地开始新的取消请求。',
  'managed.tasks.readFailed': '无法确认最新任务信息。',
  'managed.tasks.state.pending': '等待启动',
  'managed.tasks.state.running': '执行中',
  'managed.tasks.state.waiting': '等待中',
  'managed.tasks.state.completed': '已完成',
  'managed.tasks.state.failed': '失败',
  'managed.tasks.state.cancelled': '已取消',
  'managed.tasks.state.degraded': '降级执行中',
  'managed.tasks.state.recovery_blocked': '结局需要恢复确认',
  'managed.tasks.runtime.unbound': '尚未绑定',
  'managed.tasks.runtime.provisioning': '准备中',
  'managed.tasks.runtime.ready': '就绪',
  'managed.tasks.runtime.draining': '排空中',
  'managed.tasks.runtime.lost': '连接丢失',
};
