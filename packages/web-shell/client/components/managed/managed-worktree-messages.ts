import { useI18n } from '../../i18n';

const EN = {
  mode: 'Session files',
  current: 'Current directory',
  isolated: 'Independent worktree',
  base: 'Base branch or commit',
  head: 'Current HEAD',
  committed:
    'Starts from the committed version. Uncommitted changes stay in the current directory.',
  checking: 'Checking worktree support…',
  files:
    'Select workspace files after the worktree is ready. Existing file references must be selected again.',
  manage: 'Session worktrees',
  retained:
    'Closing, archiving or deleting a session keeps its worktree. Cleanup removes the directory and keeps the branch.',
  empty: 'No session worktrees in this workspace.',
  inspect: 'Inspect cleanup',
  cleanup: 'Remove worktree directory',
  confirm: 'Remove this directory?',
  confirmDescription:
    'The session must be closed and the worktree clean. The directory will be removed; its Git branch will be retained.',
  blocked: 'Cleanup is unavailable',
  session: 'Session',
  branch: 'Branch',
  baseCommit: 'Base commit',
  preparing: 'Preparing worktree',
  ready: 'Worktree ready',
  failed: 'Worktree preparation failed',
  blockedState: 'Worktree needs attention',
  removing: 'Removing worktree directory',
  removed: 'Directory removed; branch retained',
  reasonUnavailable: 'This worktree operation is currently unavailable.',
  workspaceBusy: 'Waiting for the workspace to become idle.',
  unsupported:
    'This deployment or runtime environment does not support session worktrees.',
  notGit: 'The selected directory is not in a Git repository.',
  layoutUnsupported:
    'The repository and its Git metadata must be in the same authorized storage. Select the original checkout.',
  invalidRef: 'The selected base branch or commit is invalid.',
  dirty:
    'The worktree contains uncommitted changes, untracked files or ignored files. Preserve or remove them before cleanup.',
  identityConflict:
    'The original worktree directory is missing or has changed.',
  stopUnverified: 'The previous Git operation has not been confirmed stopped.',
  sessionActive: 'Close the session before removing its worktree.',
  backgroundBusy: 'Wait for background tasks to finish before cleanup.',
} as const;

const ZH: Record<keyof typeof EN, string> = {
  mode: '会话文件',
  current: '当前目录',
  isolated: '独立 worktree',
  base: '起始分支或提交',
  head: '当前 HEAD',
  committed: '从已提交版本开始，未提交修改保留在当前目录。',
  checking: '正在检查 worktree 支持情况…',
  files: 'worktree 就绪后再选择工作区文件，已有文件引用需要重新选择。',
  manage: '会话 worktree',
  retained: '关闭、归档或删除会话后会保留 worktree。清理只删除目录，保留分支。',
  empty: '此工作区没有会话 worktree。',
  inspect: '检查清理条件',
  cleanup: '删除 worktree 目录',
  confirm: '删除此目录？',
  confirmDescription:
    '会话需要已关闭，且 worktree 没有未提交修改。目录将被删除，Git 分支仍会保留。',
  blocked: '暂时无法清理',
  session: '会话',
  branch: '分支',
  baseCommit: '起始提交',
  preparing: '正在准备 worktree',
  ready: 'worktree 已就绪',
  failed: 'worktree 准备失败',
  blockedState: 'worktree 需要处理',
  removing: '正在删除 worktree 目录',
  removed: '目录已删除，分支已保留',
  reasonUnavailable: '此 worktree 操作暂不可用。',
  workspaceBusy: '正在等待工作区空闲。',
  unsupported: '当前部署或运行环境不支持会话 worktree。',
  notGit: '所选目录不在 Git 仓库中。',
  layoutUnsupported:
    '仓库和 Git 元数据需要位于同一已授权存储中，请选择原 checkout。',
  invalidRef: '所选起始分支或提交无效。',
  dirty:
    'worktree 中存在未提交修改、未跟踪文件或忽略文件，请先保存或移除这些内容再清理。',
  identityConflict: '原 worktree 目录缺失或已发生变化。',
  stopUnverified: '尚未确认上一次 Git 执行已经停止。',
  sessionActive: '请先关闭会话，再删除它的 worktree。',
  backgroundBusy: '请等待后台任务结束后再清理。',
};

const REASON_KEYS: Record<string, keyof typeof EN> = {
  workspace_busy: 'workspaceBusy',
  worktree_unsupported: 'unsupported',
  worktree_not_git: 'notGit',
  worktree_layout_unsupported: 'layoutUnsupported',
  worktree_invalid_ref: 'invalidRef',
  worktree_dirty: 'dirty',
  worktree_index_flags: 'dirty',
  worktree_identity_conflict: 'identityConflict',
  maintenance_stop_unverified: 'stopUnverified',
  worktree_session_active: 'sessionActive',
  worktree_runtime_busy: 'backgroundBusy',
  worktree_children_busy: 'backgroundBusy',
  worktree_operations_busy: 'backgroundBusy',
};

export function useManagedWorktreeText() {
  const { language } = useI18n();
  return (key: keyof typeof EN): string =>
    (language === 'zh-CN' ? ZH : EN)[key];
}

export function useManagedWorktreeReason() {
  const text = useManagedWorktreeText();
  return (code?: string | null): string => {
    const key =
      code && Object.hasOwn(REASON_KEYS, code) ? REASON_KEYS[code] : undefined;
    const message = text(key ?? 'reasonUnavailable');
    return code ? `${message} (${code})` : message;
  };
}
