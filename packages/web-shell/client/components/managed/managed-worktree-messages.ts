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

const ZH_TW: Record<keyof typeof EN, string> = {
  mode: '會話檔案',
  current: '當前目錄',
  isolated: '獨立 worktree',
  base: '起始分支或提交',
  head: '當前 HEAD',
  committed: '從已提交版本開始，未提交修改保留在當前目錄。',
  checking: '正在檢查 worktree 支援情況…',
  files: 'worktree 就緒後再選擇工作區檔案，已有檔案引用需要重新選擇。',
  manage: '會話 worktree',
  retained: '關閉、歸檔或刪除會話後會保留 worktree。清理只刪除目錄，保留分支。',
  empty: '此工作區沒有會話 worktree。',
  inspect: '檢查清理條件',
  cleanup: '刪除 worktree 目錄',
  confirm: '刪除此目錄？',
  confirmDescription:
    '會話需要已關閉，且 worktree 沒有未提交修改。目錄將被刪除，Git 分支仍會保留。',
  blocked: '暫時無法清理',
  session: '會話',
  branch: '分支',
  baseCommit: '起始提交',
  preparing: '正在準備 worktree',
  ready: 'worktree 已就緒',
  failed: 'worktree 準備失敗',
  blockedState: 'worktree 需要處理',
  removing: '正在刪除 worktree 目錄',
  removed: '目錄已刪除，分支已保留',
  reasonUnavailable: '此 worktree 操作暫不可用。',
  workspaceBusy: '正在等待工作區空閒。',
  unsupported: '當前部署或執行環境不支援會話 worktree。',
  notGit: '所選目錄不在 Git 倉庫中。',
  layoutUnsupported:
    '倉庫和 Git 後設資料需要位於同一已授權儲存中，請選擇原 checkout。',
  invalidRef: '所選起始分支或提交無效。',
  dirty:
    'worktree 中存在未提交修改、未跟蹤檔案或忽略檔案，請先儲存或移除這些內容再清理。',
  identityConflict: '原 worktree 目錄缺失或已發生變化。',
  stopUnverified: '尚未確認上一次 Git 執行已經停止。',
  sessionActive: '請先關閉會話，再刪除它的 worktree。',
  backgroundBusy: '請等待後臺任務結束後再清理。',
};

const RU: Record<keyof typeof EN, string> = {
  mode: 'Файлы сессии',
  current: 'Текущий каталог',
  isolated: 'Независимый worktree',
  base: 'Базовая ветка или коммит',
  head: 'Текущий HEAD',
  committed:
    'Начинается с зафиксированной версии. Незафиксированные изменения остаются в текущем каталоге.',
  checking: 'Проверка поддержки worktree…',
  files:
    'Выберите файлы рабочей области после готовности worktree. Существующие ссылки на файлы нужно выбрать заново.',
  manage: 'Worktree сессий',
  retained:
    'Закрытие, архивация или удаление сессии сохраняет её worktree. Очистка удаляет каталог и оставляет ветку.',
  empty: 'В этой рабочей области нет worktree сессий.',
  inspect: 'Проверить условия очистки',
  cleanup: 'Удалить каталог worktree',
  confirm: 'Удалить этот каталог?',
  confirmDescription:
    'Сессия должна быть закрыта, а worktree — чистым. Каталог будет удалён; ветка Git сохранится.',
  blocked: 'Очистка недоступна',
  session: 'Сессия',
  branch: 'Ветка',
  baseCommit: 'Базовый коммит',
  preparing: 'Подготовка worktree',
  ready: 'Worktree готов',
  failed: 'Не удалось подготовить worktree',
  blockedState: 'Worktree требует внимания',
  removing: 'Удаление каталога worktree',
  removed: 'Каталог удалён; ветка сохранена',
  reasonUnavailable: 'Эта операция worktree сейчас недоступна.',
  workspaceBusy: 'Ожидание, пока рабочая область станет свободной.',
  unsupported:
    'Это развёртывание или среда выполнения не поддерживает worktree сессий.',
  notGit: 'Выбранный каталог не находится в репозитории Git.',
  layoutUnsupported:
    'Репозиторий и его метаданные Git должны быть в одном авторизованном хранилище. Выберите исходный checkout.',
  invalidRef: 'Выбранная базовая ветка или коммит недействительны.',
  dirty:
    'В worktree есть незафиксированные изменения, неотслеживаемые или игнорируемые файлы. Сохраните или удалите их перед очисткой.',
  identityConflict: 'Исходный каталог worktree отсутствует или изменился.',
  stopUnverified:
    'Предыдущая операция Git ещё не подтверждена как остановленная.',
  sessionActive: 'Закройте сессию перед удалением её worktree.',
  backgroundBusy: 'Дождитесь завершения фоновых задач перед очисткой.',
};

const AR: Record<keyof typeof EN, string> = {
  mode: 'ملفات الجلسة',
  current: 'المجلد الحالي',
  isolated: 'Worktree مستقلة',
  base: 'الفرع الأساسي أو الإيداع',
  head: 'HEAD الحالي',
  committed:
    'يبدأ من الإصدار المودَع. وتبقى التغييرات غير المودَعة في المجلد الحالي.',
  checking: 'جارٍ فحص دعم worktree…',
  files:
    'اختر ملفات مساحة العمل بعد جاهزية worktree. يجب إعادة اختيار إشارات الملفات الحالية.',
  manage: 'أشجار عمل الجلسة',
  retained:
    'يُبقي إغلاق الجلسة أو أرشفتها أو حذفها على worktree الخاصة بها. يزيل التنظيف المجلد ويُبقي الفرع.',
  empty: 'لا توجد أشجار عمل للجلسات في مساحة العمل هذه.',
  inspect: 'فحص التنظيف',
  cleanup: 'إزالة مجلد worktree',
  confirm: 'هل تريد إزالة هذا المجلد؟',
  confirmDescription:
    'يجب أن تكون الجلسة مغلقة وأن تكون worktree نظيفة. ستتم إزالة المجلد؛ وسيتم الاحتفاظ بفرع Git الخاص به.',
  blocked: 'التنظيف غير متاح',
  session: 'الجلسة',
  branch: 'الفرع',
  baseCommit: 'الإيداع الأساسي',
  preparing: 'جارٍ تحضير worktree',
  ready: 'worktree جاهزة',
  failed: 'فشل تحضير worktree',
  blockedState: 'worktree تحتاج انتباهاً',
  removing: 'جارٍ إزالة مجلد worktree',
  removed: 'تمت إزالة المجلد والاحتفاظ بالفرع',
  reasonUnavailable: 'عملية worktree هذه غير متاحة حالياً.',
  workspaceBusy: 'في انتظار خمول مساحة العمل.',
  unsupported: 'لا يدعم هذا النشر أو بيئة التشغيل أشجار عمل الجلسة.',
  notGit: 'المجلد المحدد ليس داخل مستودع Git.',
  layoutUnsupported:
    'يجب أن يكون المستودع وبيانات Git الوصفية في نفس وحدة التخزين المخوّلة. اختر النسخة الأصلية.',
  invalidRef: 'الفرع الأساسي أو الإيداع المحدد غير صالح.',
  dirty:
    'تحتوي worktree على تغييرات غير مودَعة أو ملفات غير متتبَّعة أو ملفات متجاهَلة. احفظها أو أزلها قبل التنظيف.',
  identityConflict: 'مجلد worktree الأصلي مفقود أو تغيّر.',
  stopUnverified: 'لم يتم تأكيد توقف عملية Git السابقة.',
  sessionActive: 'أغلق الجلسة قبل إزالة worktree الخاصة بها.',
  backgroundBusy: 'انتظر انتهاء مهام الخلفية قبل التنظيف.',
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
    (language === 'zh-TW'
      ? ZH_TW
      : language === 'zh-CN'
        ? ZH
        : language === 'ru'
          ? RU
          : language === 'ar'
            ? AR
            : EN)[key];
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
