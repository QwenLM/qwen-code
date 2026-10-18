/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const WORKSPACE_REGISTRATION_MESSAGES_EN: Record<string, string> = {
  'managed.remoteWorkspaceAdd': 'Add Workspace',
  'managed.remoteWorkspaceDescription':
    'Choose a machine and an existing directory to add to your Workspace list.',
  'managed.remoteWorkspaceMachine': 'Machine',
  'managed.remoteWorkspaceChooseMachine': 'Choose a machine',
  'managed.remoteWorkspaceDirectory': 'Directory on this machine',
  'managed.remoteWorkspaceName': 'Workspace name',
  'managed.remoteWorkspaceCheck': 'Check directory',
  'managed.remoteWorkspaceRegister': 'Register Workspace',
  'managed.remoteWorkspaceConfirm': 'Continue confirming registration',
  'managed.remoteWorkspaceStartAnother': 'Start another registration',
  'managed.remoteWorkspaceClose': 'Close',
  'managed.remoteWorkspaceWorking': 'Confirming Workspace…',
  'managed.remoteWorkspacePermission':
    'Your account does not have permission to use this machine or Workspace.',
  'managed.remoteWorkspaceInvalidDirectory':
    'The directory is unavailable. Check the machine and directory, then try again.',
  'managed.remoteWorkspaceFailed':
    'Registration failed. Check the machine and directory before trying again.',
  'managed.remoteWorkspaceBlocked':
    'The machine has not confirmed this registration yet. It completes, or releases the directory, on its own once the machine answers; if it stays blocked, it needs administrator review. You can clear this browser draft to register another directory.',
  'managed.remoteWorkspaceUnconfirmed':
    'Registration is unconfirmed. Continue confirming the saved request.',
};

export const WORKSPACE_REGISTRATION_MESSAGES_ZH: Record<string, string> = {
  'managed.remoteWorkspaceAdd': '添加工作空间',
  'managed.remoteWorkspaceDescription':
    '选择机器和已有目录，将其加入工作空间列表。',
  'managed.remoteWorkspaceMachine': '机器',
  'managed.remoteWorkspaceChooseMachine': '选择机器',
  'managed.remoteWorkspaceDirectory': '机器上的目录',
  'managed.remoteWorkspaceName': '工作空间名称',
  'managed.remoteWorkspaceCheck': '检查目录',
  'managed.remoteWorkspaceRegister': '登记工作空间',
  'managed.remoteWorkspaceConfirm': '继续确认登记结果',
  'managed.remoteWorkspaceStartAnother': '开始另一项登记',
  'managed.remoteWorkspaceClose': '关闭',
  'managed.remoteWorkspaceWorking': '正在确认工作空间…',
  'managed.remoteWorkspacePermission': '当前账号无权使用该机器或工作空间。',
  'managed.remoteWorkspaceInvalidDirectory':
    '目录不可用。请检查机器和目录后重试。',
  'managed.remoteWorkspaceFailed': '登记失败。请检查机器和目录后重试。',
  'managed.remoteWorkspaceBlocked':
    '机器尚未确认此登记。机器给出结果后，它会自动完成或释放该目录；若一直保持阻塞，则需要管理员检查。可以清除此浏览器草稿并登记其他目录。',
  'managed.remoteWorkspaceUnconfirmed':
    '登记结果尚未确认，请继续确认已保存的请求。',
};
