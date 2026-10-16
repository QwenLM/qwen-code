/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

type ExecutionMessage =
  | string
  | ((vars?: Record<string, string | number>) => string);

export const TRAJECTORY_EXECUTION_MESSAGES_EN: Record<
  string,
  ExecutionMessage
> = {
  'trajectory.executions.title': 'Recent executions',
  'trajectory.executions.scope':
    'Bounded lifecycle records; history filters apply below.',
  'trajectory.executions.outside': (v) =>
    `${v?.count ?? 0} executions outside the historical rows`,
  'trajectory.executions.omitted': (v) =>
    `${v?.count ?? 0} input records omitted by display limit`,
  'trajectory.executions.clock': 'Clock time',
  'trajectory.executions.empty': 'No lifecycle records available.',
  'trajectory.executions.elapsed': (v) => `About ${v?.duration ?? ''} elapsed`,
  'trajectory.executions.uncertain': 'Elapsed unavailable',
  'trajectory.executions.metadata':
    'Lifecycle metadata only; arguments and output are not provided.',
  'trajectory.executions.locate': 'Locate historical record',
  'trajectory.executions.unlinked':
    'Historical content is not linked in this window; refresh history if needed.',
  'trajectory.executions.outcome': 'Final outcome',
  'trajectory.executions.executionStatus': 'Execution status',
  'trajectory.executions.status.running': 'Running',
  'trajectory.executions.status.unknown': 'Unknown',
  'trajectory.executions.status.conflict': 'Record conflict',
  'trajectory.executions.status.success': 'Succeeded',
  'trajectory.executions.status.error': 'Failed',
  'trajectory.executions.status.cancelled': 'Cancelled',
  'trajectory.executions.status.interrupted': 'Interrupted',
  'trajectory.executions.status.not_started': 'Not executed',
};

export const TRAJECTORY_EXECUTION_MESSAGES_ZH: Record<
  string,
  ExecutionMessage
> = {
  'trajectory.executions.title': '近期执行',
  'trajectory.executions.scope': '有界生命周期记录；下方筛选仅作用于历史窗口。',
  'trajectory.executions.outside': (v) =>
    `${v?.count ?? 0} 条执行未关联当前历史行`,
  'trajectory.executions.omitted': (v) =>
    `展示上限省略了 ${v?.count ?? 0} 条输入记录`,
  'trajectory.executions.clock': '真实时间',
  'trajectory.executions.empty': '暂无可用生命周期记录。',
  'trajectory.executions.elapsed': (v) => `约已运行 ${v?.duration ?? ''}`,
  'trajectory.executions.uncertain': '当前耗时不可确定',
  'trajectory.executions.metadata':
    '此处仅有生命周期元数据，未提供参数和输出。',
  'trajectory.executions.locate': '定位历史记录',
  'trajectory.executions.unlinked':
    '当前窗口未关联历史正文；需要时可刷新历史。',
  'trajectory.executions.outcome': '最终处理结果',
  'trajectory.executions.executionStatus': '执行结果',
  'trajectory.executions.status.running': '进行中',
  'trajectory.executions.status.unknown': '未知',
  'trajectory.executions.status.conflict': '记录冲突',
  'trajectory.executions.status.success': '成功',
  'trajectory.executions.status.error': '失败',
  'trajectory.executions.status.cancelled': '已取消',
  'trajectory.executions.status.interrupted': '已中断',
  'trajectory.executions.status.not_started': '未执行',
};
