import type { WebShellLanguage } from '../i18n';

// Composer-only messages must not grow the read-only transcript renderer.
const EN = {
  label: 'Workflow mode',
  details: 'Workflow mode details',
  unbound: 'Create or resume a session to check availability.',
  updating: 'Updating Workflow mode…',
  syncing: 'Syncing Workflow mode…',
  unknown: 'Workflow mode could not be confirmed.',
  on: 'Workflow mode is on.',
  off: 'Workflow mode is off.',
  onUnavailable: 'Workflow mode is on, but currently unavailable.',
  unavailable: 'Workflow mode is currently unavailable.',
  initializing: 'The session is still initializing.',
  workflowUnavailable: 'The Workflow tool is unavailable in this session.',
  unsupported: 'This session does not support Workflow mode.',
  nextTurn:
    'Changes apply to the next fresh turn without interrupting the current turn or changing effort.',
  updateFailed: 'Failed to update Workflow mode',
};

const ZH: typeof EN = {
  label: 'Workflow 模式',
  details: 'Workflow 模式详情',
  unbound: '创建或恢复会话后查看可用性。',
  updating: '正在更新 Workflow 模式…',
  syncing: '正在同步 Workflow 模式…',
  unknown: '暂时无法确认 Workflow 模式。',
  on: 'Workflow 模式已开启。',
  off: 'Workflow 模式已关闭。',
  onUnavailable: 'Workflow 模式已开启，但当前不可用。',
  unavailable: 'Workflow 模式当前不可用。',
  initializing: '会话仍在初始化。',
  workflowUnavailable: '此会话中的 Workflow 工具不可用。',
  unsupported: '此会话不支持 Workflow 模式。',
  nextTurn: '更改从下一轮新输入开始生效，不会中断当前轮次或修改思考强度。',
  updateFailed: '更新 Workflow 模式失败',
};

export function getWorkflowModeMessages(language: WebShellLanguage) {
  return language === 'zh-CN' ? ZH : EN;
}
