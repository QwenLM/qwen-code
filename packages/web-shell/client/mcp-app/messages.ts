/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

type Message = string | ((vars?: Record<string, string | number>) => string);

export const MCP_APP_MESSAGES_EN: Record<string, Message> = {
  'mcpApp.generatedUi.reset': 'Reopen and reset',
  'mcpApp.generatedUi.reopen': 'Reopen interactive view',
  'mcpApp.generatedUi.openElsewhere': 'Already open elsewhere.',
  'mcpApp.generatedUi.reopenNotice':
    'Reopening starts from the original content and any state the view saved; other interactions are discarded. Check the original session first: analysis already sent is not revoked or automatically resent.',
  'mcpApp.generatedUi.resetNotice':
    'Resetting clears the state this view saved and starts from the original content. Check the original session first: analysis already sent is not revoked or automatically resent.',
  'mcpApp.generatedUi.state.saving': 'Saving…',
  'mcpApp.generatedUi.state.saved': 'Saved in this conversation',
  'mcpApp.generatedUi.state.stale':
    'Not saved: this view changed elsewhere. Refresh the page to load the latest state.',
  'mcpApp.generatedUi.state.too_large':
    'Not saved: the view state is larger than 16 KiB.',
  'mcpApp.generatedUi.state.failed':
    'Not saved: the session could not store the view state.',
  'mcpApp.generatedUi.state.unavailable':
    'The saved view state could not be loaded, so changes are not saved.',
  'mcpApp.generatedUi.effect.copied': 'Copied to the clipboard',
  'mcpApp.generatedUi.effect.copy-pending':
    'The browser blocked the copy. Use Copy to try again.',
  'mcpApp.generatedUi.effect.downloaded': ({ name } = {}) =>
    `Download started: ${name}`,
  'mcpApp.generatedUi.effect.refused': 'Not copied or downloaded.',
  'mcpApp.generatedUi.effect.copy': 'Copy',
  'mcpApp.generatedUi.unavailable':
    'Interactive views are off for this session, so only the summary is shown.',
  'mcpApp.generatedUi.title': 'Interactive view',
  'mcpApp.generatedUi.contextTag': ({ title } = {}) =>
    `Interactive view values: ${title}`,
  'mcpApp.generatedUi.loading': 'Loading the interactive view…',
  'mcpApp.loading': 'Loading the MCP App…',
  'toolName.mcp__generated-ui__generated_ui_show': 'Interactive view',
  'mcpApp.message.title': 'Review App message',
  'mcpApp.message.description':
    'This text comes from an MCP App. Sending starts an ordinary request in the session below; normal tool approvals still apply.',
  'mcpApp.message.server': 'Server',
  'mcpApp.message.resource': 'Resource',
  'mcpApp.message.session': 'Target session',
  'mcpApp.message.receipt': 'Prompt receipt',
  'mcpApp.message.send': 'Send to session',
  'mcpApp.message.stopWaiting': 'Stop waiting for receipt',
  'mcpApp.message.busy':
    'The session is busy. Wait for it to finish, then send the message again.',
  'mcpApp.message.reviewing': 'Review the full message before sending.',
  'mcpApp.message.preparing': 'Preparing the message. You can still cancel.',
  'mcpApp.message.dispatched':
    'Sending. Waiting for the session to confirm acceptance.',
  'mcpApp.message.accepted':
    'The session accepted this request. Analysis may still be running.',
  'mcpApp.message.cancelled': 'Cancelled before sending.',
  'mcpApp.message.expired':
    'Review expired before sending. Request a new review from the App.',
  'mcpApp.message.failed':
    'The message was not accepted. The text is kept here.',
  'mcpApp.message.unknown':
    'Acceptance could not be confirmed. Check the original session before sending again. This request will not be retried automatically.',
};

export const MCP_APP_MESSAGES_ZH: Record<string, Message> = {
  'mcpApp.generatedUi.reset': '重新打开并重置',
  'mcpApp.generatedUi.reopen': '重新打开交互视图',
  'mcpApp.generatedUi.openElsewhere': '已在另一处打开。',
  'mcpApp.generatedUi.reopenNotice':
    '重新打开将从原始内容和视图保存的状态开始，其他交互不会恢复。请先检查原会话：已发送的分析不会撤销，也不会自动重发。',
  'mcpApp.generatedUi.resetNotice':
    '重置会清除此视图保存的状态，并从原始内容开始。请先检查原会话：已发送的分析不会撤销，也不会自动重发。',
  'mcpApp.generatedUi.state.saving': '正在保存…',
  'mcpApp.generatedUi.state.saved': '已保存到此对话',
  'mcpApp.generatedUi.state.stale':
    '未保存：此视图已在别处修改。刷新页面即可载入最新状态。',
  'mcpApp.generatedUi.state.too_large': '未保存：视图状态超过 16 KiB。',
  'mcpApp.generatedUi.state.failed': '未保存：会话无法保存视图状态。',
  'mcpApp.generatedUi.state.unavailable':
    '无法载入已保存的视图状态，因此修改不会被保存。',
  'mcpApp.generatedUi.effect.copied': '已复制到剪贴板',
  'mcpApp.generatedUi.effect.copy-pending':
    '浏览器阻止了复制。点击“复制”重试。',
  'mcpApp.generatedUi.effect.downloaded': ({ name } = {}) =>
    `已开始下载：${name}`,
  'mcpApp.generatedUi.effect.refused': '未复制或下载。',
  'mcpApp.generatedUi.effect.copy': '复制',
  'mcpApp.generatedUi.unavailable': '此会话未开启交互视图，仅显示摘要。',
  'mcpApp.generatedUi.title': '交互视图',
  'mcpApp.generatedUi.contextTag': ({ title } = {}) => `交互视图参数：${title}`,
  'mcpApp.generatedUi.loading': '正在加载交互视图…',
  'mcpApp.loading': '正在加载 MCP App…',
  'toolName.mcp__generated-ui__generated_ui_show': '交互视图',
  'mcpApp.message.title': '审阅 App 消息',
  'mcpApp.message.description':
    '以下文字来自 MCP App。发送后将作为普通请求进入下方会话，工具仍需按正常规则审批。',
  'mcpApp.message.server': '服务',
  'mcpApp.message.resource': '资源',
  'mcpApp.message.session': '目标会话',
  'mcpApp.message.receipt': '请求回执',
  'mcpApp.message.send': '发送到会话',
  'mcpApp.message.stopWaiting': '停止等待回执',
  'mcpApp.message.busy': '会话正忙，请等待结束后重新发送消息。',
  'mcpApp.message.reviewing': '请审阅完整消息后再发送。',
  'mcpApp.message.preparing': '正在准备消息，仍可取消。',
  'mcpApp.message.dispatched': '正在发送，等待会话确认接收。',
  'mcpApp.message.accepted': '会话已接收请求，分析可能仍在进行。',
  'mcpApp.message.cancelled': '已在发送前取消。',
  'mcpApp.message.expired': '审阅已过期，消息未发送。请从 App 重新发起审阅。',
  'mcpApp.message.failed': '消息未被接收，原文保留在此。',
  'mcpApp.message.unknown':
    '无法确认是否已接收。再次发送前请检查原会话，本请求不会自动重试。',
};

export const MCP_APP_MESSAGES_RU: Record<string, Message> = {
  'mcpApp.generatedUi.reset': 'Открыть заново и сбросить',
  'mcpApp.generatedUi.reopen': 'Снова открыть интерактивный вид',
  'mcpApp.generatedUi.openElsewhere': 'Уже открыто в другом месте.',
  'mcpApp.generatedUi.reopenNotice':
    'Повторное открытие начинается с исходного содержимого и сохранённого видом состояния; остальные взаимодействия отбрасываются. Сначала проверьте исходную сессию: уже отправленный анализ не отменяется и не пересылается автоматически.',
  'mcpApp.generatedUi.resetNotice':
    'Сброс удаляет сохранённое видом состояние и начинает с исходного содержимого. Сначала проверьте исходную сессию: уже отправленный анализ не отменяется и не пересылается автоматически.',
  'mcpApp.generatedUi.state.saving': 'Сохранение…',
  'mcpApp.generatedUi.state.saved': 'Сохранено в этом разговоре',
  'mcpApp.generatedUi.state.stale':
    'Не сохранено: вид изменён в другом месте. Обновите страницу, чтобы загрузить последнее состояние.',
  'mcpApp.generatedUi.state.too_large':
    'Не сохранено: состояние вида больше 16 КиБ.',
  'mcpApp.generatedUi.state.failed':
    'Не сохранено: сессия не смогла сохранить состояние вида.',
  'mcpApp.generatedUi.state.unavailable':
    'Не удалось загрузить сохранённое состояние вида, поэтому изменения не сохраняются.',
  'mcpApp.generatedUi.effect.copied': 'Скопировано в буфер обмена',
  'mcpApp.generatedUi.effect.copy-pending':
    'Браузер заблокировал копирование. Нажмите «Копировать», чтобы повторить.',
  'mcpApp.generatedUi.effect.downloaded': ({ name } = {}) =>
    `Загрузка началась: ${name}`,
  'mcpApp.generatedUi.effect.refused': 'Не скопировано и не загружено.',
  'mcpApp.generatedUi.effect.copy': 'Копировать',
  'mcpApp.generatedUi.unavailable':
    'Интерактивные виды для этой сессии выключены, поэтому показана только сводка.',
  'mcpApp.generatedUi.title': 'Интерактивный вид',
  'mcpApp.generatedUi.contextTag': ({ title } = {}) =>
    `Значения интерактивного вида: ${title}`,
  'mcpApp.generatedUi.loading': 'Загрузка интерактивного вида…',
  'mcpApp.loading': 'Загрузка MCP App…',
  'toolName.mcp__generated-ui__generated_ui_show': 'Интерактивный вид',
  'mcpApp.message.title': 'Проверить сообщение App',
  'mcpApp.message.description':
    'Этот текст пришёл из MCP App. Отправка запускает обычный запрос в сессии ниже; обычные подтверждения инструментов по-прежнему действуют.',
  'mcpApp.message.server': 'Сервер',
  'mcpApp.message.resource': 'Ресурс',
  'mcpApp.message.session': 'Целевая сессия',
  'mcpApp.message.receipt': 'Квитанция запроса',
  'mcpApp.message.send': 'Отправить в сессию',
  'mcpApp.message.stopWaiting': 'Перестать ждать квитанцию',
  'mcpApp.message.busy':
    'Сессия занята. Дождитесь завершения, затем отправьте сообщение снова.',
  'mcpApp.message.reviewing': 'Просмотрите полное сообщение перед отправкой.',
  'mcpApp.message.preparing': 'Сообщение готовится. Его ещё можно отменить.',
  'mcpApp.message.dispatched':
    'Отправка. Ожидание подтверждения приёма сессией.',
  'mcpApp.message.accepted':
    'Сессия приняла этот запрос. Анализ может ещё выполняться.',
  'mcpApp.message.cancelled': 'Отменено до отправки.',
  'mcpApp.message.expired':
    'Проверка истекла до отправки. Запросите новую проверку из App.',
  'mcpApp.message.failed': 'Сообщение не принято. Текст сохранён здесь.',
  'mcpApp.message.unknown':
    'Не удалось подтвердить приём. Перед повторной отправкой проверьте исходную сессию. Этот запрос не будет повторён автоматически.',
};

export const MCP_APP_MESSAGES_AR: Record<string, Message> = {
  'mcpApp.generatedUi.reset': 'إعادة الفتح وإعادة الضبط',
  'mcpApp.generatedUi.reopen': 'إعادة فتح العرض التفاعلي',
  'mcpApp.generatedUi.openElsewhere': 'مفتوح بالفعل في مكان آخر.',
  'mcpApp.generatedUi.reopenNotice':
    'تبدأ إعادة الفتح من المحتوى الأصلي وتتجاهل التفاعلات السابقة. تحقق من الجلسة الأصلية أولاً: لن يتم سحب التحليلات المرسلة بالفعل أو إعادة إرسالها تلقائياً.',
  'mcpApp.generatedUi.unavailable':
    'طرق العرض التفاعلية معطلة لهذه الجلسة، لذا يتم عرض الملخص فقط.',
  'mcpApp.generatedUi.title': 'عرض تفاعلي',
  'mcpApp.generatedUi.contextTag': ({ title } = {}) =>
    `قيم العرض التفاعلي: ${title}`,
  'mcpApp.generatedUi.loading': 'جارٍ تحميل العرض التفاعلي…',
  'mcpApp.loading': 'جارٍ تحميل MCP App…',
  'toolName.mcp__generated-ui__generated_ui_show': 'عرض تفاعلي',
  'mcpApp.message.title': 'مراجعة رسالة App',
  'mcpApp.message.description':
    'يأتي هذا النص من MCP App. يبدأ الإرسال طلباً عادياً في الجلسة أدناه؛ وتظل موافقات الأدوات الاعتيادية سارية.',
  'mcpApp.message.server': 'الخادم',
  'mcpApp.message.resource': 'المورد',
  'mcpApp.message.session': 'الجلسة المستهدفة',
  'mcpApp.message.receipt': 'إيصال الموجه',
  'mcpApp.message.send': 'إرسال إلى الجلسة',
  'mcpApp.message.stopWaiting': 'إيقاف انتظار الإيصال',
  'mcpApp.message.busy':
    'الجلسة مشغولة. انتظر انتهاءها ثم أرسل الرسالة مجدداً.',
  'mcpApp.message.reviewing': 'راجع الرسالة كاملة قبل الإرسال.',
  'mcpApp.message.preparing': 'جارٍ تحضير الرسالة. لا يزال بإمكانك الإلغاء.',
  'mcpApp.message.dispatched': 'جارٍ الإرسال. في انتظار تأكيد الجلسة للاستلام.',
  'mcpApp.message.accepted':
    'قبلت الجلسة هذا الطلب. قد يكون التحليل لا يزال قيد التشغيل.',
  'mcpApp.message.cancelled': 'تم الإلغاء قبل الإرسال.',
  'mcpApp.message.expired':
    'انتهت صلاحية المراجعة قبل الإرسال. اطلب مراجعة جديدة من التطبيق.',
  'mcpApp.message.failed': 'لم يتم قبول الرسالة. النص محفوظ هنا.',
  'mcpApp.message.unknown':
    'تعذر تأكيد الاستلام. تحقق من الجلسة الأصلية قبل الإرسال مجدداً. لن تتم إعادة محاولة هذا الطلب تلقائياً.',
};
