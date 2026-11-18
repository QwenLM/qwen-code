import type { WebShellLanguage } from '../i18n';

// Composer-only messages must not grow the read-only transcript renderer.
const EN = {
  label: 'Workflow mode',
  menuDescription: 'Let new tasks use workflows',
  short: {
    unbound: 'Needs an active session',
    updating: 'Updating…',
    syncing: 'Syncing…',
    unknown: 'State not confirmed',
    onUnavailable: 'On, but unavailable now',
    unavailable: 'Unavailable now',
  },
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
  clickToTurnOff: 'Click to turn off.',
};

const ZH: typeof EN = {
  label: 'Workflow 模式',
  menuDescription: '新任务可交给 workflow 执行',
  short: {
    unbound: '需要先有会话',
    updating: '正在更新…',
    syncing: '正在同步…',
    unknown: '状态未确认',
    onUnavailable: '已开启，当前不可用',
    unavailable: '当前不可用',
  },
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
  clickToTurnOff: '点击关闭。',
};

const ZH_TW: typeof EN = {
  label: 'Workflow 模式',
  menuDescription: '新任務可交給 workflow 執行',
  short: {
    unbound: '需要先有會話',
    updating: '正在更新…',
    syncing: '正在同步…',
    unknown: '狀態未確認',
    onUnavailable: '已開啟，當前不可用',
    unavailable: '當前不可用',
  },
  details: 'Workflow 模式詳情',
  unbound: '建立或恢復會話後檢視可用性。',
  updating: '正在更新 Workflow 模式…',
  syncing: '正在同步 Workflow 模式…',
  unknown: '暫時無法確認 Workflow 模式。',
  on: 'Workflow 模式已開啟。',
  off: 'Workflow 模式已關閉。',
  onUnavailable: 'Workflow 模式已開啟，但當前不可用。',
  unavailable: 'Workflow 模式當前不可用。',
  initializing: '會話仍在初始化。',
  workflowUnavailable: '此會話中的 Workflow 工具不可用。',
  unsupported: '此會話不支援 Workflow 模式。',
  nextTurn: '更改從下一輪新輸入開始生效，不會中斷當前輪次或修改思考強度。',
  updateFailed: '更新 Workflow 模式失敗',
  clickToTurnOff: '點選關閉。',
};

const RU: typeof EN = {
  label: 'Режим Workflow',
  menuDescription: 'Новые задачи можно поручать workflow',
  short: {
    unbound: 'Нужна активная сессия',
    updating: 'Обновление…',
    syncing: 'Синхронизация…',
    unknown: 'Состояние не подтверждено',
    onUnavailable: 'Вкл., но сейчас недоступно',
    unavailable: 'Сейчас недоступно',
  },
  details: 'Сведения о режиме Workflow',
  unbound: 'Создайте или возобновите сессию, чтобы проверить доступность.',
  updating: 'Обновление режима Workflow…',
  syncing: 'Синхронизация режима Workflow…',
  unknown: 'Не удалось подтвердить режим Workflow.',
  on: 'Режим Workflow включён.',
  off: 'Режим Workflow выключен.',
  onUnavailable: 'Режим Workflow включён, но сейчас недоступен.',
  unavailable: 'Режим Workflow сейчас недоступен.',
  initializing: 'Сессия ещё инициализируется.',
  workflowUnavailable: 'Инструмент Workflow недоступен в этой сессии.',
  unsupported: 'Эта сессия не поддерживает режим Workflow.',
  nextTurn:
    'Изменения применяются к следующему новому ходу, не прерывая текущий и не меняя интенсивность размышления.',
  updateFailed: 'Не удалось обновить режим Workflow',
  clickToTurnOff: 'Нажмите, чтобы выключить.',
};

const AR: typeof EN = {
  label: 'وضع سير العمل',
  menuDescription: 'السماح للمهام الجديدة باستخدام مسارات العمل',
  short: {
    unbound: 'يتطلب جلسة نشطة',
    updating: 'جارٍ التحديث…',
    syncing: 'جارٍ المزامنة…',
    unknown: 'الحالة غير مؤكدة',
    onUnavailable: 'مفعّل، لكنه غير متاح الآن',
    unavailable: 'غير متاح الآن',
  },
  details: 'تفاصيل وضع سير العمل',
  unbound: 'أنشئ جلسة أو استأنفها للتحقق من التوفر.',
  updating: 'جارٍ تحديث وضع سير العمل…',
  syncing: 'جارٍ مزامنة وضع سير العمل…',
  unknown: 'تعذر تأكيد وضع سير العمل.',
  on: 'وضع سير العمل مفعّل.',
  off: 'وضع سير العمل معطّل.',
  onUnavailable: 'وضع سير العمل مفعّل، لكنه غير متاح حالياً.',
  unavailable: 'وضع سير العمل غير متاح حالياً.',
  initializing: 'لا تزال الجلسة قيد التهيئة.',
  workflowUnavailable: 'أداة Workflow غير متاحة في هذه الجلسة.',
  unsupported: 'لا تدعم هذه الجلسة وضع سير العمل.',
  nextTurn:
    'تنطبق التغييرات على الجولة الجديدة التالية دون مقاطعة الجولة الحالية أو تغيير الجهد.',
  updateFailed: 'فشل تحديث وضع سير العمل',
  clickToTurnOff: 'انقر للإيقاف.',
};

export function getWorkflowModeMessages(language: WebShellLanguage) {
  if (language === 'zh-TW') return ZH_TW;
  if (language === 'zh-CN') return ZH;
  if (language === 'ru') return RU;
  if (language === 'ar') return AR;
  return EN;
}
