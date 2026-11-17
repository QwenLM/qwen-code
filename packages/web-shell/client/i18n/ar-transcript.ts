import { arPlural } from '../utils/plural.js';

export type ArMessageValue =
  | string
  | ((vars?: Record<string, string | number>) => string);

/**
 * Arabic translations for keys reachable from the read-only transcript bundle
 * (`WebShellTranscript` / `/export html`). Interactive-only keys live in
 * `./ar-interactive.ts`, which is stubbed out in `--mode transcript`.
 */
export const AR_TRANSCRIPT_MESSAGES: Record<string, ArMessageValue> = {
  "You've used up your weekly credits.{{reset}} You can wait or run /upgrade to get more credits.":
    (v) =>
      `لقد استنفدت رصيدك الأسبوعي${v?.['reset'] ?? ''}. يمكنك الانتظار أو تشغيل /upgrade للحصول على رصيد إضافي.`,
  "You've used up your weekly credits.{{reset}} Please try again after the reset.":
    (v) =>
      `لقد استنفدت رصيدك الأسبوعي${v?.['reset'] ?? ''}. يُرجى المحاولة مرة أخرى بعد إعادة التعيين.`,
  "You've used up your credits.{{reset}} Please try again after the reset.": (
    v,
  ) =>
    `لقد استنفدت رصيدك${v?.['reset'] ?? ''}. يُرجى المحاولة مرة أخرى بعد إعادة التعيين.`,
  ' Your credits are expected to reset in {{time}}.': (v) =>
    ` ومن المتوقع إعادة تعيين رصيدك خلال ${v?.['time'] ?? ''}`,
  '{{days}} and {{hours}}': (v) =>
    `${v?.['days'] ?? ''} و${v?.['hours'] ?? ''}`,
  '1 day': 'يوم واحد',
  '{{count}} days': (v) => {
    const c = v?.['count'] ?? 0;
    return arPlural(
      c,
      '0 أيام',
      'يوم واحد',
      'يومين',
      `${c} أيام`,
      `${c} يوماً`,
      `${c} يوم`,
    );
  },
  '1 hour': 'ساعة واحدة',
  '{{count}} hours': (v) => {
    const c = v?.['count'] ?? 0;
    return arPlural(
      c,
      '0 ساعات',
      'ساعة واحدة',
      'ساعتين',
      `${c} ساعات`,
      `${c} ساعة`,
      `${c} ساعة`,
    );
  },
  'subscription.loginRequired':
    'لم تعد بيانات تسجيل الدخول صالحة. شغّل ‎/auth لتسجيل الدخول مجدداً.',
  'footnotes.note': (v) => `حاشية ${v?.number ?? ''}`,
  'footnotes.references': (v) => {
    const c = v?.count ?? 0;
    return `عرض ${arPlural(c, '0 مراجع', 'مرجع واحد', 'مرجعين', `${c} مراجع`, `${c} مرجعاً`, `${c} مرجع`)}`;
  },
  'footnotes.preview': 'معاينة المرجع',
  'footnotes.previous': 'المرجع السابق',
  'footnotes.next': 'المرجع التالي',
  'managed.loading': 'جارٍ التحميل…',
  'managed.result.view': 'عرض المخرجات',
  'managed.result.execution.success': 'نجح الأمر',
  'managed.result.execution.error': 'فشل الأمر',
  'managed.result.execution.cancelled': 'أُلغي الأمر',
  'managed.result.execution.not_started': 'لم يُنفَّذ الأمر',
  'managed.result.capture.complete': 'اكتمل الالتقاط',
  'managed.result.capture.partial': 'الالتقاط غير مكتمل',
  'managed.result.capture.unavailable': 'الالتقاط غير متاح',
  'managed.result.capture.none': 'لا يوجد التقاط',
  'managed.result.delivery.pending': 'جارٍ حفظ المخرجات',
  'managed.result.delivery.committed': 'تم حفظ المخرجات',
  'managed.result.delivery.blocked': 'تسليم المخرجات محجوب',
  'about.auth': 'المصادقة',
  'about.baseUrl': 'العنوان الأساسي',
  'about.fastModel': 'النموذج السريع',
  'about.memoryUsage': 'استهلاك الذاكرة',
  'about.model': 'النموذج',
  'about.noProxy': 'دون وكيل',
  'about.noSandbox': 'دون عزل',
  'about.platform': 'نظام التشغيل',
  'about.proxy': 'الوكيل',
  'about.runtime': 'بيئة التشغيل',
  'about.sandbox': 'بيئة العزل',
  'about.sessionId': 'معرّف الجلسة',
  'about.title': 'الحالة',
  'agent.label': 'الوكيل',
  'subagent.result': 'النتيجة',
  'subagent.tools': (v) => `الأدوات (${v?.count ?? 0})`,
  'subagent.toolsCount': (v) => {
    const c = v?.count ?? 0;
    return arPlural(
      c,
      '0 أدوات',
      'أداة واحدة',
      'أداتان',
      `${c} أدوات`,
      `${c} أداة`,
      `${c} أداة`,
    );
  },
  'subagent.toggleStream': 'تبديل تفاصيل بث الوكيل',
  'subagent.creating': 'جارٍ الإنشاء…',
  'subagent.pending': 'قيد الانتظار',
  'subagent.running': 'قيد التشغيل',
  'subagent.background': 'مهمة في الخلفية',
  'subagent.completed': 'مكتمل',
  'subagent.failed': 'فشل',
  'subagent.cancelled': 'ملغى',
  'agentType.general-purpose': 'متعدد الأغراض',
  'agentType.explore': 'استكشاف',
  'agentType.statusline-setup': 'إعداد شريط الحالة',
  'agentType.review-agent': 'وكيل المراجعة',
  'agentType.test-engineer': 'مهندس الاختبارات',
  'agentType.fork': 'تفريع',
  'timeline.parallelAgents': 'وكلاء متوازون',
  'timeline.thinking': 'تفكير',
  'timeline.assistantUpdate': 'تحديث المساعد',
  'timeline.toolCalls': (v) => {
    const c = v?.count ?? 0;
    return arPlural(
      c,
      '0 استدعاءات أدوات',
      'استدعاء أداة واحد',
      'استدعاءا أداة',
      `${c} استدعاءات أدوات`,
      `${c} استدعاء أداة`,
      `${c} استدعاء أداة`,
    );
  },
  'timeline.planUpdate': 'تحديث الخطة',
  'timeline.statusUpdate': 'تحديث الحالة',
  'timeline.userTurn': 'دور المستخدم',
  'timeline.planDetail': 'تحديث الخطة',
  'timeline.parallelAgentsDetail': (v) => {
    const c = v?.count ?? 0;
    return arPlural(
      c,
      '0 وكلاء متوازين',
      'وكيل متوازٍ واحد',
      'وكيلان متوازيان',
      `${c} وكلاء متوازين`,
      `${c} وكيلاً متوازياً`,
      `${c} وكيل متوازٍ`,
    );
  },
  'timeline.noActivity': 'لا يوجد نشاط',
  'timeline.sessionTimeline': 'الخط الزمني للجلسة',
  'timeline.turnPrefix': (v) => `الجولة ${v?.index ?? 0}`,
  'timeline.currentTurn': 'الجولة الحالية',
  'timeline.kind.thought': 'تفكير',
  'timeline.kind.commentary': 'تحديث المساعد',
  'timeline.kind.tool': 'استدعاءات الأدوات',
  'timeline.kind.agents': 'وكلاء متوازون',
  'timeline.kind.plan': 'تحديث الخطة',
  'timeline.kind.status': 'تحديث الحالة',
  'timeline.kind.none': 'جولة',
  'common.copy': 'نسخ',
  'common.download': 'تنزيل',
  'common.downloading': 'جارٍ التنزيل…',
  'common.downloadFailed': (v) => `فشل التنزيل: ${v?.message ?? ''}`,
  'common.open': 'فتح',
  'common.openFailed': (v) => `تعذر فتح الرابط: ${v?.message ?? ''}`,
  'common.server': 'الخادم',
  'common.agent': 'الوكيل',
  'mermaid.label': 'mermaid',
  'mermaid.errorLabel': 'mermaid (خطأ)',
  'user.uploadedImage': (v) => `صورة مرفوعة من المستخدم ${v?.index ?? 1}`,
  'insight.ready': 'تم إنشاء تقرير التحليل بنجاح!',
  'request.cancelled': 'تم إلغاء الطلب.',
  'visionBridge.model': 'نموذج الرؤية',
  'visionBridge.skipped': (v) =>
    `تم إلغاء جسر الرؤية.${v?.egressOccurred === 1 ? ` تم إرسال صورتك والموجه/السياق إلى ${v?.target ?? ''}.` : ''}`,
  'visionBridge.failed': (v) =>
    v?.egressOccurred === 1
      ? `فشل جسر الرؤية (${v?.modelName ?? ''}): تعذر إتمام طلب نموذج الرؤية. تم إرسال صورتك والموجه/السياق إلى ${v?.target ?? ''}. لم يتم تفسير الصورة.`
      : `فشل جسر الرؤية (${v?.target ?? ''}): تعذر تشغيل جسر الرؤية. لم يتم تفسير الصورة.`,
  'visionBridge.ok': (v) => {
    const converted = Number(v?.convertedCount ?? 0);
    const omitted = Number(v?.omittedCount ?? 0);
    return `تم تحويل ${arPlural(converted, '0 صور', 'صورة واحدة', 'صورتين', `${converted} صور`, `${converted} صورة`, `${converted} صورة`)} إلى نص عبر ${v?.target ?? ''}${omitted > 0 ? ` (تم استبعاد ${omitted} صورة)` : ''}.${v?.egressOccurred === 1 ? ' تم إرسال صورتك والموجه/السياق إلى هذا النموذج.' : ''}`;
  },
  'approval.explain': 'شرح',
  'approval.explanation': 'شرح الأمر',
  'approval.explaining': 'جارٍ الشرح…',
  'approval.explanationThinking': 'جارٍ التفكير…',
  'approval.explanationFailed': 'فشل الشرح',
  'approval.reExplain': 'إعادة الشرح',
  'assistant.branch': 'محادثة جديدة من هنا',
  'assistant.copyContent': 'نسخ المحتوى',
  'assistant.copyMarkdownSource': 'نسخ مصدر Markdown',
  'assistant.dissatisfied': 'غير راضٍ',
  'assistant.satisfied': 'راضٍ',
  'agentMessage.status.failed': 'فشل',
  'agentMessage.status.cancelled': 'متوقف',
  'agentMessage.status.offline': 'بيئة التشغيل غير متصلة',
  'agentMessage.tokens': (v) => {
    const c = v?.count ?? 0;
    return arPlural(
      c,
      '0 رموز',
      'رمز واحد',
      'رمزان',
      `${c} رموز`,
      `${c} رمزاً`,
      `${c} رمز`,
    );
  },
  'agentMessage.steps': 'الخطوات',
  'agentMessage.noAction': (v) => `لم يكن لدى ${v?.name ?? ''} ما يفعله`,
  'agentMessage.step.running': 'قيد التشغيل',
  'agentMessage.step.completed': 'تم',
  'agentMessage.step.failed': 'فشل',
  'agentMessage.step.stopped': 'متوقف',
  'common.cancel': 'إلغاء',
  'common.fullscreen': 'ملء الشاشة',
  'common.exitFullscreen': 'الخروج من ملء الشاشة',
  'common.retry': 'إعادة المحاولة',
  'common.expand': 'توسيع',
  'common.collapse': 'طي',
  'copy.failedFallback': 'فشل النسخ إلى الحافظة',
  'code.copy': 'نسخ',
  'code.copied': 'تم النسخ!',
  'echartsChart.noData': 'لا توجد بيانات',
  'echartsChart.tableNotice': (v) => {
    const omittedRows = Number(v?.omittedRows ?? 0);
    const omittedColumns = Number(v?.omittedColumns ?? 0);
    if (omittedRows > 0 && omittedColumns > 0) {
      return `عرض ${v?.visibleRows ?? 0} من ${v?.totalRows ?? 0} صف و${v?.visibleColumns ?? 0} من ${v?.totalColumns ?? 0} عمود`;
    }
    if (omittedColumns > 0) {
      return `عرض ${v?.visibleColumns ?? 0} من ${v?.totalColumns ?? 0} عمود`;
    }
    return `عرض ${v?.visibleRows ?? 0} من ${v?.totalRows ?? 0} صف`;
  },
  'echartsChart.rendering': 'جارٍ رسم المخطط',
  'echartsChart.renderFailed': 'فشل رسم المخطط.',
  'echartsChart.viewMode': 'وضع العرض',
  'echartsChart.showChart': 'عرض المخطط',
  'echartsChart.showData': 'عرض البيانات',
  'echartsChart.chart': 'المخطط',
  'echartsChart.data': 'البيانات',
  'echartsChart.nodes': 'العقد',
  'echartsChart.links': 'الروابط',
  'echartsChart.name': 'الاسم',
  'echartsChart.category': 'الفئة',
  'echartsChart.id': 'المعرّف',
  'echartsChart.source': 'المصدر',
  'echartsChart.target': 'الهدف',
  'echartsChart.value': 'القيمة',
  'echartsChart.depth': 'العمق',
  'echartsChart.path': 'المسار',
  'echartsChart.idPath': 'مسار المعرّف',
  'echartsChart.subtreeTotal': 'إجمالي الشجرة الفرعية (مشتق)',
  'markdownTable.blank': '(فارغ)',
  'markdownTable.column': (v) => `العمود ${v?.index ?? ''}`,
  'markdownTable.rows': (v) => {
    const count = Number(v?.count ?? 0);
    return arPlural(
      count,
      '0 صفوف',
      'صف واحد',
      'صفان',
      `${count} صفوف`,
      `${count} صفاً`,
      `${count} صف`,
    );
  },
  'markdownTable.rowsFiltered': (v) => `${v?.visible ?? 0}/${v?.total ?? 0} صف`,
  'markdownTable.filtersActive': (v) => {
    const count = Number(v?.count ?? 0);
    return arPlural(
      count,
      '0 فلاتر',
      'فلتر واحد',
      'فلتران',
      `${count} فلاتر`,
      `${count} فلتراً`,
      `${count} فلتر`,
    );
  },
  'markdownTable.selection.selected': 'محدد',
  'markdownTable.selection.nonEmpty': 'غير فارغ',
  'markdownTable.selection.numeric': 'رقمي',
  'markdownTable.selection.statistics': 'إحصائيات التحديد الرقمي',
  'markdownTable.selection.sum': 'المجموع',
  'markdownTable.selection.average': 'المتوسط',
  'markdownTable.selection.min': 'الأدنى',
  'markdownTable.selection.max': 'الأعلى',
  'markdownTable.copyTsv': 'نسخ كنص',
  'markdownTable.copyTsvHint': 'نسخ النص للصقه في تطبيقات الجداول',
  'markdownTable.copyVisible': 'نسخ',
  'markdownTable.copyMarkdown': 'نسخ Markdown',
  'markdownTable.customColumns': 'أعمدة مخصصة',
  'markdownTable.customColumns.tableSection': 'الأعمدة الظاهرة في الجدول',
  'markdownTable.customColumns.detailSection':
    'الحقول الظاهرة في الصفوف الموسّعة',
  'markdownTable.customColumns.toggleAllTable': 'تبديل كل أعمدة الجدول',
  'markdownTable.customColumns.toggleAllDetails':
    'تبديل كل حقول الصفوف الموسّعة',
  'markdownTable.customColumns.reset': 'إعادة ضبط',
  'markdownTable.customColumns.noDetails': 'لم يتم تحديد حقول للصفوف الموسّعة.',
  'markdownTable.freezeFirstColumn': 'تجميد العمود الأول',
  'markdownTable.unfreezeFirstColumn': 'إلغاء تجميد العمود الأول',
  'markdownTable.densityLabel': 'كثافة الجدول',
  'markdownTable.densityCurrent': (v) => `كثافة ${v?.density ?? ''}`.trim(),
  'markdownTable.density.standard': 'قياسية',
  'markdownTable.density.compact': 'مكثفة',
  'markdownTable.density.comfortable': 'مريحة',
  'markdownTable.expandLongText': 'توسيع النص',
  'markdownTable.collapseLongText': 'طي النص',
  'markdownTable.emptyValue': '(فارغ)',
  'markdownTable.moveColumn': (v) => `نقل ${v?.column ?? ''}`,
  'markdownTable.resizeColumn': (v) => `تغيير عرض ${v?.column ?? ''}`,
  'markdownTable.rowDetailsAria': (v) => `عرض تفاصيل الصف ${v?.index ?? ''}`,
  'markdownTable.closeRowDetailsAria': (v) =>
    `إخفاء تفاصيل الصف ${v?.index ?? ''}`,
  'markdownTable.detailsHeader': 'تفاصيل الصف',
  'markdownTable.cellDialogTitle': 'قيمة الحقل الحالية',
  'markdownTable.copyCell': 'نسخ',
  'markdownTable.close': 'إغلاق',
  'markdownTable.actions': 'الإجراءات',
  'markdownTable.sortByColumn': (v) => `ترتيب حسب ${v?.column ?? ''}`,
  'markdownTable.sortByColumnAsc': (v) =>
    `ترتيب حسب ${v?.column ?? ''}، تصاعدياً`,
  'markdownTable.sortByColumnDesc': (v) =>
    `ترتيب حسب ${v?.column ?? ''}، تنازلياً`,
  'markdownTable.filterColumn': (v) => `تصفية ${v?.column ?? ''}`,
  'markdownTable.empty': 'لا يحتوي هذا الجدول على بيانات.',
  'markdownTable.emptyFiltered': 'لا توجد صفوف تطابق التصفية.',
  'markdownTable.filter.searchPlaceholder': 'ابحث في قيم التصفية',
  'markdownTable.filter.searchAria': (v) => `بحث ${v?.column ?? ''}`,
  'markdownTable.filter.selectVisible': 'تحديد النتائج الحالية',
  'markdownTable.filter.optionLimit': (v) =>
    `عرض أول ${v?.count ?? 0} عنصر. ابحث لتضييق النتائج.`,
  'markdownTable.filter.noOptions': 'لا توجد نتائج مطابقة',
  'markdownTable.filter.custom': 'تصفية مخصصة',
  'markdownTable.filter.numberAria': (v) => `تصفية رقمية لـ ${v?.column ?? ''}`,
  'markdownTable.filter.textAria': (v) => `تصفية نصية لـ ${v?.column ?? ''}`,
  'markdownTable.filter.numberPlaceholder': 'القيمة',
  'markdownTable.filter.toPlaceholder': 'إلى',
  'markdownTable.filter.textPlaceholder': 'أدخل شرط التصفية',
  'markdownTable.filter.reset': 'إعادة ضبط',
  'markdownTable.filter.cancel': 'إلغاء',
  'markdownTable.filter.confirm': 'تأكيد',
  'markdownTable.filter.text.contains': 'يحتوي على',
  'markdownTable.filter.text.equals': 'يساوي',
  'markdownTable.filter.text.notEquals': 'لا يساوي',
  'markdownTable.filter.text.startsWith': 'يبدأ بـ',
  'markdownTable.filter.text.endsWith': 'ينتهي بـ',
  'markdownTable.filter.number.gt': 'أكبر من',
  'markdownTable.filter.number.gte': 'أكبر من أو يساوي',
  'markdownTable.filter.number.lt': 'أصغر من',
  'markdownTable.filter.number.lte': 'أصغر من أو يساوي',
  'markdownTable.filter.number.between': 'بين',
  'mermaid.rendering': 'جارٍ رسم المخطط...',
  'mermaid.viewCode': '</>',
  'mermaid.viewDiagram': '⊞',
  'mermaid.zoomIn': '+',
  'mermaid.zoomOut': '−',
  'mermaid.zoomReset': '↺',
  'contextUsage.autocompactBuffer': 'مخزن الضغط التلقائي',
  'contextUsage.bodyLoaded': 'المحتوى محمّل',
  'contextUsage.builtinTools': 'الأدوات المدمجة',
  'contextUsage.contextWindow': 'نافذة السياق',
  'contextUsage.detailHint': 'شغّل ‎/context detail لعرض التفصيل لكل عنصر.',
  'contextUsage.estimatedOverhead': 'التكلفة التقديرية الأساسية',
  'contextUsage.estimatedUsage': 'الاستخدام التقديري، شاملاً المحادثة',
  'contextUsage.usageEstimatedWithConversation':
    'لا يوجد استخدام مسجل من المزوّد بعد. التقديرات أدناه تشمل المحادثة.',
  'contextUsage.estimatedUntilProviderUsage':
    'استخدام الرموز تقديري حتى وصول تقرير المزوّد.',
  'contextUsage.free': 'متاح',
  'contextUsage.instructionFiles': 'ملفات التعليمات',
  'contextUsage.autoMemory': 'الذاكرة التلقائية',
  'contextUsage.memoryFiles': 'ملفات الذاكرة',
  'contextUsage.messages': 'الرسائل',
  'contextUsage.startupContext': 'سياق البدء',
  'contextUsage.cachedPrefix': 'البادئة المخزنة',
  'contextUsage.mcpTools': 'أدوات MCP',
  'contextUsage.model': 'النموذج',
  'contextUsage.usageUnavailable':
    'استخدام السياق الحالي غير متوفر. التقديرات أدناه تغطي التكلفة الأساسية فقط دون رسائل المحادثة.',
  'contextUsage.overLimit':
    'السياق يتجاوز الحد! استخدم ‎/compress أو ‎/clear للتقليل.',
  'contextUsage.skills': 'المهارات',
  'contextUsage.systemPrompt': 'موجه النظام',
  'contextUsage.title': 'استخدام السياق',
  'contextUsage.tokens': 'رمز',
  'contextUsage.used': 'مستخدم',
  'contextUsage.viewDetails': 'عرض التفاصيل',
  'history.loadingEarlier': 'جارٍ تحميل الرسائل السابقة…',
  'history.capacityReached':
    'تم الوصول إلى حد عرض السجل. تبقى الرسائل الأقدم محفوظة.',
  'history.paginationError': 'تعذر تحميل السجل الأقدم.',
  'history.retry': 'إعادة المحاولة',
  'editor.sessionLoading': 'لا تزال الجلسة قيد التحميل. حاول بعد لحظة.',
  'quickActions.copy': 'نسخ المخرجات',
  'scheduledTasks.title': 'المهام المجدولة',
  'scheduledTasks.weekdayNames':
    'الأحد,الاثنين,الثلاثاء,الأربعاء,الخميس,الجمعة,السبت',
  'scheduledTasks.human.daily': (v) => `يومياً عند ${v?.time ?? ''}`,
  'scheduledTasks.human.weekdays': (v) => `أيام العمل عند ${v?.time ?? ''}`,
  'scheduledTasks.human.weekly': (v) =>
    `كل ${v?.day ?? ''} عند ${v?.time ?? ''}`,
  'scheduledTasks.human.hourly': (v) => `كل ساعة عند :${v?.min ?? '00'}`,
  'scheduledTasks.human.everyMinutes': (v) => `كل ${v?.n ?? ''} دقيقة`,
  'scheduledTasks.repeats': 'يتكرر',
  'scheduledTasks.runsOnce': 'يعمل مرة واحدة',
  'scheduledTasks.runContext.title': 'تشغيل مهمة مجدولة',
  'scheduledTasks.runContext.taskId': 'معرّف المهمة',
  'scheduledTasks.runContext.schedule': 'الجدول',
  'scheduledTasks.runContext.triggeredAt': 'وقت الإطلاق',
  'scheduledTasks.runContext.trigger.scheduled': 'مجدول',
  'scheduledTasks.runContext.trigger.manual': 'تشغيل يدوي',
  'scheduledTasks.sessionMode.perRun': 'جلسة جديدة لكل تشغيل',
  'turnOutputs.filesEdited': (v) => {
    const c = v?.count ?? 0;
    return `تم تعديل ${arPlural(c, '0 ملفات', 'ملف واحد', 'ملفين', `${c} ملفات`, `${c} ملفاً`, `${c} ملف`)}`;
  },
  'turnOutputs.viewChanges': 'عرض التغييرات',
  'turnOutputs.review': 'التغييرات',
  'webPreview.saved': 'نسخة محفوظة',
  'turnOutputs.preview': 'معاينة',
  'turnOutputs.collapseFiles': 'طي الملفات',
  'turnOutputs.showMoreFiles': (v) => `عرض ${v?.count ?? 0} ملفات إضافية`,
  'turnOutputs.collapseArtifacts': 'طي المخرجات',
  'turnOutputs.showMoreArtifacts': (v) => `عرض ${v?.count ?? 0} مخرجات إضافية`,
  'turnOutputs.artifactMissing': 'الملف غير موجود في مساحة العمل',
  'turnOutputs.artifactChanged': 'تم تعديله بعد التسجيل',
  'turnOutputs.artifactUnavailable': (v) =>
    v?.path
      ? `الملف غير موجود في مساحة العمل · ${v.path}`
      : 'الملف غير موجود في مساحة العمل',
  'retry.hint': 'اضغط Ctrl+Y أو انقر لإعادة المحاولة',
  'system.taskNotification': 'إشعار مهمة',
  'background.result': 'نتيجة الخلفية',
  'background.agent': 'وكيل في الخلفية',
  'background.task': 'مهمة في الخلفية',
  'background.peer': 'رسالة بين الجلسات',
  'background.details': 'عرض التفاصيل',
  'background.source': 'المصدر',
  'background.pending': 'في انتظار المعالجة',
  'system.taskCompleted': 'اكتملت مهمة الخلفية',
  'system.taskFailed': 'فشلت مهمة الخلفية',
  'system.taskCancelled': 'أُلغيت مهمة الخلفية',
  'notification.shell.completed': (v) =>
    `اكتمل أمر الصدفة في الخلفية "${v?.command ?? ''}".`,
  'notification.shell.failed': (v) =>
    `فشل أمر الصدفة في الخلفية "${v?.command ?? ''}".`,
  'notification.shell.cancelled': (v) =>
    `تم إلغاء أمر الصدفة في الخلفية "${v?.command ?? ''}".`,
  'notification.monitor.completed': (v) =>
    `اكتمل المراقب "${v?.description ?? ''}". (${v?.events ?? 0} حدث${
      v?.droppedLines ? `، وتم إسقاط ${v.droppedLines} سطراً بسبب التقييد` : ''
    })`,
  'notification.monitor.failed': (v) =>
    `فشل المراقب "${v?.description ?? ''}". (${v?.events ?? 0} حدث${
      v?.droppedLines ? `، وتم إسقاط ${v.droppedLines} سطراً بسبب التقييد` : ''
    })`,
  'notification.monitor.cancelled': (v) =>
    `تم إلغاء المراقب "${v?.description ?? ''}". (${v?.events ?? 0} حدث${
      v?.droppedLines ? `، وتم إسقاط ${v.droppedLines} سطراً بسبب التقييد` : ''
    })`,
  'notification.agent.completed': (v) =>
    `اكتمل وكيل الخلفية "${v?.description ?? ''}".`,
  'notification.agent.failed': (v) =>
    `فشل وكيل الخلفية "${v?.description ?? ''}".`,
  'notification.agent.cancelled': (v) =>
    `تم إلغاء وكيل الخلفية "${v?.description ?? ''}".`,
  'branch.success': (v) =>
    `تم نسخ الجلسة. اسم الجلسة الجديدة: "${v?.name ?? ''}". تم التبديل إلى الجلسة الجديدة.`,
  'error.modelStreamInterrupted':
    'انقطع بث استجابة النموذج. يُرجى إعادة المحاولة.',
  'error.loopDetected':
    'علق النموذج أثناء استخدام الأدوات أو وصل إلى حد الأمان، لذا تم إيقاف هذا الدور. جلستك لا تزال مفتوحة—جرّب تعليمة أكثر تحديداً للمتابعة.',
  'error.loopDetected.explicitCap': (vars) =>
    `بلغ هذا الدور حد ${vars?.limit} استدعاء أداة الذي يضبطه model.maxToolCallsPerTurn، لذا تم إيقافه. جلستك لا تزال مفتوحة—ارفع الحد في إعداداتك أو أرسل تعليمة جديدة للمتابعة.`,
  'error.loopDetected.backstop': (vars) =>
    `بلغ هذا الدور حد الأمان البالغ ${vars?.limit} استدعاء أداة، لذا تم إيقافه. جلستك لا تزال مفتوحة—أرسل تعليمة جديدة للمتابعة، أو اضبط model.maxToolCallsPerTurn لاختيار حد مختلف.`,
  'error.loopDetected.stuckRepetition': (vars) =>
    `بعد أكثر من ${vars?.limit} استدعاء أداة، استمر النموذج في تكرار الاستدعاء نفسه، لذا تم إيقاف هذا الدور. جلستك لا تزال مفتوحة—جرّب تعليمة مختلفة أو أكثر تحديداً.`,
  'error.loopDetected.repeatedCall':
    'استمر النموذج في تكرار استدعاء الأداة نفسه خلال هذا الدور، لذا تم إيقافه. جلستك لا تزال مفتوحة—جرّب تعليمة مختلفة أو أكثر تحديداً.',
  'error.loopDetected.providerDuplicateId':
    'أرسلت خدمة النموذج استدعاء أداة كان قد نُفّذ بالفعل، لذا تم إيقاف هذا الدور بدلاً من إعادة تشغيله. جلستك لا تزال مفتوحة—أرسل رسالة جديدة للمتابعة.',
  'error.loopDetected.invalidToolParams':
    'استمر النموذج في إرسال وسائط غير صالحة إلى الأداة نفسها، لذا تم إيقاف هذا الدور. جلستك لا تزال مفتوحة—جرّب تعليمة أكثر تحديداً للمتابعة.',
  'error.loopDetected.repeatedToolFailure':
    'استمرت الأداة نفسها في الفشل للسبب ذاته بعد تذكير، لذا تم إيقاف هذا الدور. جلستك لا تزال مفتوحة—تحقق من الأخطاء أعلاه أو جرّب نهجاً مختلفاً.',
  'shell.command': 'أمر صدفة',
  'shell.result.timedOut': 'انتهت المهلة',
  'shell.result.notices': 'ملاحظات',
  'shell.result.truncated': 'تم اقتطاع معاينة المخرجات',
  'shell.result.outputFiles': 'ملفات المخرجات',
  'shell.result.output': 'المخرجات',
  'shell.result.command': 'الأمر',
  'shell.result.copy': 'نسخ الأمر',
  'shell.result.details': 'تفاصيل التنفيذ',
  'shell.result.directory': 'المجلد',
  'shell.result.timeout': 'المهلة',
  'shell.result.timeoutMs': (v) => `${v?.milliseconds} مللي ثانية`,
  'shell.result.defaultTimeout': 'استخدام الافتراضي',
  'shell.result.exitCode': 'رمز الخروج',
  'shell.result.signal': 'الإشارة',
  'shell.result.pending': 'قيد الانتظار',
  'shell.result.lines': 'أسطر المخرجات',
  'shell.result.bytes': 'بايتات المخرجات',
  'shell.result.running': 'قيد التشغيل',
  'shell.result.completed': 'مكتمل',
  'shell.result.success': 'نجح',
  'shell.result.cancelled': 'ملغى',
  'shell.result.waiting': 'في انتظار المخرجات…',
  'shell.result.empty': 'لا توجد مخرجات',
  'shell.result.unavailable': 'المخرجات غير متوفرة لاستدعاء الأداة هذا.',
  'shell.result.exited': (v) => `خرج بالرمز ${v?.code}`,
  'turnCalls.open': 'عرض استدعاءات الأدوات',
  'turnCalls.arguments': 'الوسائط',
  'turnCalls.result': 'النتيجة',
  'btw.answering': '+ جارٍ الإجابة...',
  'btw.shortcuts.pending': 'اضغط Escape أو Ctrl+C أو Ctrl+D للإلغاء',
  'btw.shortcuts.done': 'اضغط Space أو Enter أو Escape للإغلاق',
  'mcp.action.auth': 'مصادقة',
  'mcp.action.clearAuth': 'مسح المصادقة',
  'mcp.action.disable': 'تعطيل',
  'mcp.action.done': (v) => `اكتمل ${v?.action ?? 'الإجراء'}.`,
  'mcp.action.enable': 'تفعيل',
  'mcp.action.failed': (v) => `فشل: ${v?.error ?? ''}`,
  'mcp.action.running': (v) => `${v?.action ?? 'جارٍ التنفيذ'}...`,
  'mcp.action.reauth': 'إعادة المصادقة',
  'mcp.action.approve': 'موافقة',
  'mcp.annotation.destructive': 'تدميري',
  'mcp.annotation.idempotent': 'متكافئ التكرار',
  'mcp.annotation.openWorld': 'عالم مفتوح',
  'mcp.annotation.readOnly': 'للقراءة فقط',
  'mcp.annotations': 'التعليقات التوضيحية',
  'mcp.oauth.server': 'الخادم',
  'mcp.oauth.starting': (v) =>
    `جارٍ بدء مصادقة OAuth لخادم MCP '${v?.name ?? ''}'...`,
  'mcp.oauth.title': 'مصادقة OAuth',
  'mcp.command': 'الأمر',
  'mcp.description': 'الوصف:',
  'mcp.action.reconnect': 'إعادة الاتصال',
  'mcp.reconnect.skipped': (v) =>
    `لم تكتمل إعادة الاتصال: ${v?.reason ?? 'سبب غير معروف'}.`,
  'mcp.action.tools': 'عرض الأدوات',
  'mcp.empty': 'لا توجد خوادم MCP مهيأة.',
  'mcp.emptyTools': 'لم يتم اكتشاف أي أدوات.',
  'mcp.discovery.timeout':
    'يستغرق اكتشاف MCP وقتاً أطول من المتوقع. حدّث لإعادة المحاولة.',
  'mcp.servers': (v) => {
    const c = v?.count ?? 0;
    return arPlural(
      c,
      '0 خوادم',
      'خادم واحد',
      'خادمان',
      `${c} خوادم`,
      `${c} خادماً`,
      `${c} خادم`,
    );
  },
  'mcp.extensionMcp': 'MCP الإضافة',
  'mcp.invalidReason': (v) => `غير صالح: ${v?.reason ?? ''}`,
  'mcp.invalidReasonLabel': 'السبب:',
  'mcp.invalidToolHelp':
    'يجب أن تحتوي الأدوات على اسم ووصف ليتمكن النموذج من استخدامها.',
  'mcp.invalidToolWarning': 'تحذير: لا يمكن للنموذج استدعاء هذه الأداة',
  'mcp.manageServers': 'إدارة خوادم MCP',
  'mcp.parameters': 'المعاملات:',
  'mcp.required': ' مطلوب',
  'mcp.scrollPosition': (v) => `${v?.current ?? 0}/${v?.total ?? 0}`,
  'mcp.shortcut.back': 'Esc للرجوع',
  'mcp.shortcut.close': 'Esc للإغلاق',
  'mcp.shortcut.selectBack': '↑↓ للتنقل · Enter للاختيار · Esc للرجوع',
  'mcp.shortcut.selectClose': '↑↓ للتنقل · Enter للاختيار · Esc للإغلاق',
  'mcp.starting': (v) =>
    `⏳ خوادم MCP قيد التشغيل (${v?.count ?? 0} قيد التهيئة)...`,
  'mcp.startingNote':
    'ملاحظة: قد يستغرق البدء الأول وقتاً أطول. سيتم تحديث توفر الأدوات تلقائياً.',
  'mcp.source': 'المصدر',
  'mcp.source.extension': 'الإضافة',
  'mcp.source.project': 'MCP المشروع (.mcp.json)',
  'mcp.source.workspace': 'إعدادات مساحة العمل',
  'mcp.source.user': 'الإعدادات العامة',
  'mcp.status': 'الحالة',
  'mcp.status.authenticating': 'جارٍ المصادقة',
  'mcp.status.authenticationFailed': 'فشلت المصادقة',
  'mcp.status.needsAuthentication': 'يتطلب مصادقة',
  'mcp.status.needsApproval': 'يتطلب موافقة',
  'mcp.status.rejected': 'مرفوض',
  'mcp.status.connected': 'متصل',
  'mcp.status.disconnectedTitle': 'غير متصل',
  'mcp.status.disabled': 'معطّل',
  'mcp.status.starting': 'جارٍ البدء... (قد يستغرق البدء الأول وقتاً أطول)',
  'mcp.status.unknown': 'غير معروف',
  'mcp.toolCount': (v) => {
    const c = v?.count ?? 0;
    return arPlural(
      c,
      '0 أدوات',
      'أداة واحدة',
      'أداتان',
      `${c} أدوات`,
      `${c} أداة`,
      `${c} أداة`,
    );
  },
  'mcp.toolsCount': (v) => {
    const c = v?.count ?? 0;
    return arPlural(
      c,
      '0 أدوات',
      'أداة واحدة',
      'أداتان',
      `${c} أدوات`,
      `${c} أداة`,
      `${c} أداة`,
    );
  },
  'mcp.toolDetail': 'تفاصيل الأداة',
  'mcp.tools': 'الأدوات',
  'mcp.toolsForServer': (v) => `أدوات ${v?.name ?? 'الخادم'}`,
  'mcp.userMcp': 'MCP العام',
  'mcp.workingDirectory': 'مجلد العمل',
  'goal.aborted': 'تم إجهاض الهدف',
  'goal.blocked': 'الهدف محجوب',
  'goal.usageLimited': 'تجاوز الهدف حد الاستخدام',
  'goal.paused': 'الهدف متوقف مؤقتاً',
  'goal.achieved': 'تحقق الهدف',
  'goal.check': 'فحص الهدف',
  'goal.cleared': 'تمت إزالة الهدف',
  'goal.failed': 'تعذر تحقيق الهدف',
  'goal.judge': 'المُقيّم',
  'goal.label': 'الهدف',
  'goal.expandDetails': 'توسيع التفاصيل',
  'goal.collapseDetails': 'طي التفاصيل',
  'goal.lastCheck': 'آخر فحص',
  'goal.notYetMet': 'لم يتحقق بعد',
  'goal.set': 'تم تعيين الهدف',
  'goal.turn': (v) => {
    const c = v?.count ?? 0;
    return arPlural(
      c,
      '0 جولات',
      'جولة واحدة',
      'جولتان',
      `${c} جولات`,
      `${c} جولة`,
      `${c} جولة`,
    );
  },
  'goal.turnLabel': (v) => `الجولة ${v?.count ?? 0}`,
  'goal.turns': (v) => {
    const c = v?.count ?? 0;
    return arPlural(
      c,
      '0 جولات',
      'جولة واحدة',
      'جولتان',
      `${c} جولات`,
      `${c} جولة`,
      `${c} جولة`,
    );
  },
  'plan.title': 'الخطة',
  'parallelAgents.title': 'وكلاء متوازون',
  'parallelAgents.done': (v) => `اكتمل ${v?.done ?? 0}/${v?.total ?? 0}`,
  'parallelAgents.failed': (v) => `فشل ${v?.count ?? 0}`,
  'stats.accepted': 'مقبولة:',
  'stats.agreementRate': 'معدل الموافقة الإجمالي:',
  'stats.api': 'API',
  'stats.apiTime': 'زمن API',
  'stats.avgDuration': 'متوسط المدة',
  'stats.avgLatency': 'متوسط الكمون',
  'stats.cached': 'مخزن مؤقتاً',
  'stats.cacheDesc':
    'من رموز الإدخال قُدّمت من الذاكرة المؤقتة، مما قلّل التكاليف.',
  'stats.calls': 'الاستدعاءات',
  'stats.codeChanges': 'تغييرات الكود',
  'stats.decisionSummary': 'ملخص قرارات المستخدم',
  'stats.duration': 'المدة',
  'stats.errors': 'الأخطاء',
  'stats.inputTokens': 'رموز الإدخال',
  'stats.metric': 'المقياس',
  'stats.modelStats': 'إحصائيات النماذج',
  'stats.modelTip': 'نصيحة: لعرض تفصيل كامل للرموز، شغّل ‎/stats model.',
  'stats.modelUsage': 'استخدام النماذج',
  'stats.modified': 'معدّلة:',
  'stats.noApiCalls': 'لم تُجرَ أي استدعاءات API في هذه الجلسة.',
  'stats.noToolCalls': 'لم تُجرَ أي استدعاءات أدوات في هذه الجلسة.',
  'stats.outputTokens': 'رموز الإخراج',
  'stats.overview': 'نظرة عامة على الجلسة',
  'stats.performance': 'الأداء',
  'stats.prompts': 'الموجهات',
  'stats.rejected': 'مرفوضة:',
  'stats.reqs': 'الطلبات',
  'stats.requests': 'الطلبات',
  'stats.savingsHighlight': 'أبرز الوفورات:',
  'stats.successRate': 'معدل النجاح',
  'stats.thoughts': 'الأفكار',
  'stats.title': 'إحصائيات الجلسة',
  'stats.tokens': 'الرموز',
  'stats.toolCalls': 'استدعاءات الأدوات',
  'stats.toolName': 'اسم الأداة',
  'stats.toolStats': 'إحصائيات الأدوات',
  'stats.toolTime': 'زمن الأدوات',
  'stats.total': 'الإجمالي',
  'stats.totalReviewed': 'إجمالي الاقتراحات المراجعة:',
  'contextUsage.remaining': 'المتبقي',
  'contextUsage.advanced': 'متقدم · الاستخدام حسب الفئة',
  'contextUsage.snapshot': 'لقطة',
  'contextUsage.viewCurrent': 'عرض السياق الحالي',
  'contextUsage.compressing': 'جارٍ الضغط…',
  'contextCompression.result': (v) =>
    `تم ضغط السياق ${v?.from ?? ''} ← ${v?.to ?? ''}`,
  'contextCompression.instructionsTruncated': (v) =>
    `تم اقتطاع تعليمات الضغط إلى ${v?.max ?? ''} حرفاً.`,
  'contextCompression.noop': 'لا حاجة للضغط.',
  'trajectory.inspector.truncated': 'تم اقتطاع المحتوى',
  'trajectory.inspector.expand': 'عرض المزيد',
  'todo.allDone': 'اكتملت جميع المهام',
  'todo.collapse': 'طي قائمة المهام',
  'todo.detail.api': 'API',
  'todo.detail.cached': 'مخزن مؤقتاً',
  'todo.detail.end': 'النهاية',
  'todo.detail.hide': 'إخفاء تفاصيل المهمة',
  'todo.detail.input': 'الإدخال',
  'todo.detail.noResources': 'لم يتم تسجيل استهلاك الرموز والوقت لهذه المهمة.',
  'todo.detail.output': 'الإخراج',
  'todo.detail.sectionSpent': 'الوقت المستغرق',
  'todo.detail.sectionTime': 'الوقت',
  'todo.detail.sectionTokens': 'الرموز',
  'todo.detail.show': 'عرض تفاصيل المهمة',
  'todo.detail.start': 'البداية',
  'todo.detail.tool': 'الأداة',
  'todo.expand': 'توسيع قائمة المهام',
  'planExecution.title': 'تنفيذ الخطة',
  'planExecution.overview': 'نظرة عامة على سير العمل',
  'planExecution.overallProgress': 'التقدم الإجمالي',
  'planExecution.stepsCompleted': 'الخطوات المكتملة',
  'planExecution.activeAgents': 'الوكلاء النشطون',
  'planExecution.needsAttention': 'يتطلب انتباهاً',
  'planExecution.stepDetails': 'تفاصيل الخطوة',
  'planExecution.subagents': 'الوكلاء الفرعيون',
  'planExecution.noSubagents': 'لم يُربط أي وكيل بهذه الخطوة بعد.',
  'planExecution.openDetails': 'فتح تفاصيل الوكيل الفرعي',
  'planExecution.currentActivity': 'النشاط الحالي:',
  'planExecution.toolCalls': (v) => {
    const c = v?.count ?? 0;
    return arPlural(
      c,
      '0 استدعاءات أدوات',
      'استدعاء أداة واحد',
      'استدعاءا أداة',
      `${c} استدعاءات أدوات`,
      `${c} استدعاء أداة`,
      `${c} استدعاء أداة`,
    );
  },
  'planExecution.tokens': (v) => {
    const c = v?.count ?? 0;
    return arPlural(
      c,
      '0 رموز',
      'رمز واحد',
      'رمزان',
      `${c} رموز`,
      `${c} رمزاً`,
      `${c} رمز`,
    );
  },
  'planExecution.dependsOn': 'يعتمد على:',
  'planExecution.unblocks': 'يفتح المسار لـ:',
  'planExecution.unassigned': 'تنفيذات غير مخصصة',
  'planExecution.attention': 'يتطلب انتباهاً',
  'planExecution.agentCount': (v) => {
    const c = v?.count ?? 0;
    return arPlural(
      c,
      '0 وكلاء',
      'وكيل واحد',
      'وكيلان',
      `${c} وكلاء`,
      `${c} وكيلاً`,
      `${c} وكيل`,
    );
  },
  'planExecution.status.running': 'قيد التشغيل',
  'planExecution.status.paused': 'متوقف مؤقتاً',
  'planExecution.status.completed': 'مكتمل',
  'planExecution.status.blocked': 'محجوب',
  'planExecution.status.in_progress': 'قيد التنفيذ',
  'planExecution.status.ready': 'جاهز',
  'planExecution.edgesHidden': (v) =>
    `الاعتماديات كثيرة جداً للرسم (${v?.count ?? 0}). تسرد كل خطوة ما تعتمد عليه بدلاً من ذلك.`,
  'workflow.task.completed': 'مكتمل',
  'workflow.task.attention': 'يتطلب انتباهاً',
  'workflow.task.running': 'التعاون قيد التشغيل',
  'workflow.task.waitingExecution': 'في انتظار التنفيذ',
  'planExecution.locateCurrent': 'تحديد موقع الخطوة الحالية',
  'sources.count': (v) => {
    const c = v?.count ?? 0;
    return arPlural(
      c,
      '0 مصادر',
      'مصدر واحد',
      'مصدران',
      `${c} مصادر`,
      `${c} مصدراً`,
      `${c} مصدر`,
    );
  },
  'sources.currentTurn': 'مصادر هذه الجولة',
  'sources.open': 'فتح المصدر',
  'userMessage.showMore': 'عرض المزيد',
  'userMessage.showLess': 'طي',
  'userMessage.sendFailed': 'فشل الإرسال',
  'userMessage.retrySend': 'إعادة محاولة إرسال الرسالة',
  'userMessage.edit': 'تعديل الرسالة',
  'message.moreActions': 'المزيد من إجراءات الرسالة',
  'userMessage.editSubmit': 'إرسال',
  'userMessage.editSending': 'جارٍ الإرسال…',
  'turn.processed': 'تمت المعالجة',
  'turn.processing': 'قيد المعالجة',
  'turn.collapse': 'طي الخطوات',
  'turn.expand': 'توسيع الخطوات',
  'turn.cached': 'مخزن مؤقتاً',
  'turn.toolCalls': (v) => {
    const n = v?.count ?? 0;
    return arPlural(
      n,
      '0 استدعاءات أدوات',
      'استدعاء أداة واحد',
      'استدعاءا أداة',
      `${n} استدعاءات أدوات`,
      `${n} استدعاء أداة`,
      `${n} استدعاء أداة`,
    );
  },
  'turn.thinkingCount': (v) => {
    const n = v?.count ?? 0;
    return arPlural(
      n,
      '0 أفكار',
      'فكرة واحدة',
      'فكرتان',
      `${n} أفكار`,
      `${n} فكرة`,
      `${n} فكرة`,
    );
  },
  'turn.stopped': 'لقد ألغيت هذا الطلب',
  'turn.stoppedAfter': (v) => `لقد ألغيت هذا الطلب بعد ${v?.duration ?? '0s'}`,
  'message.renderError': 'تعذر عرض هذه الرسالة.',
  'tasks.title': 'مهام الخلفية',
  'tasks.empty': 'لا توجد مهام قيد التشغيل حالياً',
  'tasks.refreshStale': 'قد تكون حالة المهمة قديمة؛ جارٍ إعادة الاتصال...',
  'tasks.cancelFailed': 'فشل إلغاء المهمة',
  'tasks.alreadyStopped': 'المهمة متوقفة بالفعل',
  'tasks.moreAbove': (v) => `^ ${v?.count ?? 0} أخرى بالأعلى`,
  'tasks.moreBelow': (v) => `v ${v?.count ?? 0} أخرى بالأسفل`,
  'tasks.running': 'قيد التشغيل',
  'tasks.pausing': 'جارٍ الإيقاف المؤقت',
  'tasks.completed': 'مكتمل',
  'tasks.failed': 'فشل',
  'tasks.cancelled': 'متوقف',
  'tasks.paused': 'متوقف مؤقتاً',
  'tasks.kind.shell': 'صدفة',
  'tasks.kind.monitor': 'مراقب',
  'tasks.kind.workflow': 'سير عمل',
  'workflow.graph.waiting': 'في انتظار إرسال أول وكيل…',
  'workflow.graph.notRecorded': 'لم يُحفظ مخطط تنفيذ لهذا التشغيل.',
  'workflow.inline.loading': 'جارٍ تحميل تنفيذ سير العمل المباشر…',
  'workflow.inline.unavailable':
    'تشغيل سير العمل هذا لم يعد متاحاً في الجلسة الحالية.',
  'workflow.graph.omitted': (v) =>
    `تم تقييد المخطط لتحسين الأداء: تم استبعاد ${v?.lanes ?? 0} مراحل و${v?.nodes ?? 0} وكلاء و${v?.edges ?? 0} اتصالات.`,
  'workflow.noPhase': 'بلا مرحلة',
  'workflow.dispatchCount': (v) => {
    const c = v?.count ?? 0;
    return arPlural(
      c,
      '0 إرسالات',
      'إرسال واحد',
      'إرسالان',
      `${c} إرسالات`,
      `${c} إرسالاً`,
      `${c} إرسال`,
    );
  },
  'workflow.selectedDispatch': 'الإرسال المحدد',
  'workflow.dependencies': 'يعتمد على',
  'workflow.action.pause': 'إيقاف مؤقت',
  'workflow.action.resume': 'استئناف',
  'workflow.action.retry': 'إعادة محاولة المسار الفاشل',
  'workflow.action.rerun': 'إعادة تشغيل الكل',
  'workflow.action.unavailable': 'تغيّرت حالة سير العمل قبل تنفيذ الإجراء.',
  'workflow.action.argsUnavailable':
    'لا يمكن إعادة التشغيل: لا يحتوي السجل على الوسائط التي بدأ بها.',
  'workflow.action.failed': 'تعذر تحديث سير العمل.',
  'workflow.history.retry': (v) => `أُعيدت المحاولة من ${v?.runId ?? ''}`,
  'workflow.history.rerun': (v) => `أُعيد التشغيل من ${v?.runId ?? ''}`,
  'workflow.history.cached': (v) => `${v?.count ?? 0} مخزنة مؤقتاً`,
  'workflow.history.saved': (v) => `${v?.count ?? 0} تشغيلات محفوظة`,
  'workflow.history.restored': 'تشغيل محفوظ',
  'workflow.history.showRuns': (v) => `سجل التشغيلات (${v?.count ?? 0})`,
  'workflow.history.hideRuns': 'إخفاء السجل',
  'workflow.history.filter': 'تصفية التشغيلات',
  'workflow.history.filterAll': 'كل الحالات',
  'workflow.history.visibleCount': (v) =>
    `${v?.count ?? 0} من ${v?.total ?? 0}`,
  'workflow.history.filterEmpty': 'لا توجد تشغيلات محفوظة تطابق هذه التصفية.',
  'workflow.history.exportVisible': 'تصدير الظاهرة',
  'workflow.history.delete': 'حذف',
  'workflow.history.deleteSaved': 'حذف التشغيل المحفوظ',
  'workflow.history.confirmDelete': 'تأكيد الحذف',
  'workflow.history.deleteUnavailable': 'لم يعد التشغيل المحفوظ متاحاً.',
  'workflow.history.deleteFailed': 'تعذر حذف التشغيل المحفوظ.',
  'workflow.history.compareRun': (v) => `مقارنة التشغيل ${v?.runId ?? ''}`,
  'workflow.history.compare': 'مقارنة التشغيلات',
  'workflow.history.hideComparison': 'إخفاء المقارنة',
  'workflow.history.source': 'التشغيل المصدر',
  'workflow.history.compared': 'التشغيل المقارَن',
  'workflow.history.current': 'التشغيل الحالي',
  'workflow.history.status': 'الحالة',
  'workflow.history.agents': 'الوكلاء',
  'workflow.approvalNeeded': 'مطلوب موافقة',
  'workflow.respondInChat': 'الرد في المحادثة',
  'workflow.metric.agents': 'وكلاء',
  'workflow.metric.running': 'قيد التشغيل',
  'workflow.metric.queued': 'في الانتظار',
  'workflow.metric.tokens': 'رموز',
  'workflow.dispatch.queued': 'في الانتظار',
  'workflow.dispatch.running': 'قيد التشغيل',
  'workflow.dispatch.completed': 'مكتمل',
  'workflow.dispatch.failed': 'فشل',
  'workflow.dispatch.cancelled': 'ملغى',
  'workflow.dispatch.cached': 'مخزن مؤقتاً',
  'tasks.action.stop': 'إيقاف',
  'tasks.action.abandon': 'التخلي',
  'tasks.action.confirmStop': 'تأكيد الإيقاف',
  'tasks.action.confirmAbandon': 'تأكيد التخلي',
  'tasks.action.confirmHint': 'سيؤدي هذا إلى إنهاء الجولة الحاجبة.',
  'tasks.confirmStop': 'x مرة أخرى لتأكيد الإيقاف · ينهي الجولة الحاجبة',
  'tasks.shortcut.select': '↑/↓ للاختيار',
  'tasks.shortcut.view': 'Enter للعرض',
  'tasks.shortcut.stop': 'x إيقاف',
  'tasks.shortcut.abandon': 'x تخلي',
  'tasks.shortcut.listClose': '←/Esc إغلاق',
  'tasks.shortcut.detailBack': '← رجوع',
  'tasks.shortcut.detailClose': 'Esc/Enter/Space إغلاق',
  'tasks.shortcut.close': 'Esc إغلاق',
  'tasks.shortcut.cancelConfirm': 'Esc إلغاء',
  'tasks.detail.workingDir': 'مجلد العمل',
  'tasks.detail.outputFile': 'ملف الإخراج',
  'tasks.detail.command': 'الأمر',
  'tasks.detail.events': (v) => {
    const c = v?.count ?? 0;
    return arPlural(
      c,
      '0 أحداث',
      'حدث واحد',
      'حدثان',
      `${c} أحداث`,
      `${c} حدثاً`,
      `${c} حدث`,
    );
  },
  'tasks.detail.exit': (v) => `خروج ${v?.exitCode ?? ''}`,
  'tasks.detail.dropped': (v) => `${v?.count ?? 0} مسقط`,
  'tasks.detail.error': 'خطأ',
  'tasks.detail.stoppedBecause': 'توقف بسبب',
  'tasks.detail.resumeBlocked': 'الاستئناف محجوب',
  'tasks.detail.progress': 'التقدم',
  'tasks.detail.prompt': 'الموجه',
  'tasks.detail.type': 'النوع',
  'tasks.detail.runtime': 'الوقت',
  'tasks.detail.tokenCount': 'الرموز',
  'tasks.detail.toolCallCount': 'استدعاءات الأدوات',
  'tasks.detail.tokens': (v) => {
    const c = v?.count ?? 0;
    return arPlural(
      c,
      '0 رموز',
      'رمز واحد',
      'رمزان',
      `${c} رموز`,
      `${c} رمزاً`,
      `${c} رمز`,
    );
  },
  'tasks.detail.toolCalls': (v) => {
    const c = v?.count ?? 0;
    return arPlural(
      c,
      '0 استدعاءات أدوات',
      'استدعاء أداة واحد',
      'استدعاءا أداة',
      `${c} استدعاءات أدوات`,
      `${c} استدعاء أداة`,
      `${c} استدعاء أداة`,
    );
  },
  'tasks.detail.nesting': 'التداخل',
  'tasks.detail.nestingValue': (v) =>
    `المستوى ${v?.level ?? '?'} · من ${v?.parent ?? '?'}`,
  'tasks.detail.nestingLevel': (v) => `المستوى ${v?.level ?? '?'}`,
  'tasks.row.from': (v) => `من ${v?.parent ?? '?'}`,
  'tasks.row.nested': 'متداخل',
  'tool.expand': 'توسيع',
  'tool.viewFile': 'عرض الملف',
  'tool.viewImage': 'عرض الصورة',
  'tool.viewCurrentFile': 'عرض الملف الحالي',
  'tool.collapseHint': 'طي',
  'tool.status.failed': 'فشل',
  'toolGroup.summary': (v) => {
    const c = v?.count ?? 0;
    return `تم تشغيل ${arPlural(c, '0 أدوات', 'أداة واحدة', 'أداتين', `${c} أدوات`, `${c} أداة`, `${c} أداة`)}`;
  },
  'toolGroup.summary.ranAgents': (v) => {
    const c = v?.count ?? 0;
    return `تم تشغيل ${arPlural(c, '0 وكلاء', 'وكيل واحد', 'وكيلين', `${c} وكلاء`, `${c} وكيلاً`, `${c} وكيل`)}`;
  },
  'toolGroup.summary.editedFiles': (v) => {
    const c = v?.count ?? 0;
    return `تم تعديل الملفات ${arPlural(c, '0 مرات', 'مرة واحدة', 'مرتين', `${c} مرات`, `${c} مرة`, `${c} مرة`)}`;
  },
  'toolGroup.summary.ranCommands': (v) => {
    const c = v?.count ?? 0;
    return `تم تشغيل ${arPlural(c, '0 أوامر', 'أمر واحد', 'أمرين', `${c} أوامر`, `${c} أمراً`, `${c} أمر`)}`;
  },
  'toolGroup.summary.readFiles': (v) => {
    const c = v?.count ?? 0;
    return `تمت قراءة الملفات ${arPlural(c, '0 مرات', 'مرة واحدة', 'مرتين', `${c} مرات`, `${c} مرة`, `${c} مرة`)}`;
  },
  'toolGroup.summary.searched': (v) => {
    const c = v?.count ?? 0;
    return `تم البحث ${arPlural(c, '0 مرات', 'مرة واحدة', 'مرتين', `${c} مرات`, `${c} مرة`, `${c} مرة`)}`;
  },
  'toolGroup.summary.updatedTodos': (v) => {
    const c = Number(v?.count ?? 0);
    return c === 1
      ? 'تم تحديث قائمة المهام'
      : `تم تحديث قائمة المهام ${arPlural(c, '0 مرات', 'مرة واحدة', 'مرتين', `${c} مرات`, `${c} مرة`, `${c} مرة`)}`;
  },
  'toolGroup.summary.provideInformation': 'تقديم معلومات',
  'toolGroup.summary.askedQuestions': (v) => {
    const c = v?.count ?? 0;
    return `تم طرح ${arPlural(c, '0 أسئلة', 'سؤال واحد', 'سؤالين', `${c} أسئلة`, `${c} سؤالاً`, `${c} سؤال`)}`;
  },
  'toolGroup.summary.otherTools': (v) => {
    const c = v?.count ?? 0;
    return `تم استدعاء ${arPlural(c, '0 أدوات أخرى', 'أداة أخرى واحدة', 'أداتين أخريين', `${c} أدوات أخرى`, `${c} أداة أخرى`, `${c} أداة أخرى`)}`;
  },
  'toolGroup.running': (v) =>
    Number(v?.count ?? 0) > 1
      ? `جارٍ تشغيل ${v?.count ?? 0} أدوات: ${v?.name ?? 'أداة'}`
      : `جارٍ تشغيل ${v?.name ?? 'أداة'}`,
  'toolGroup.runningPrefix': 'جارٍ تشغيل',
  'thinking.expand': 'توسيع التفكير',
  'thinking.collapse': 'طي التفكير',
  'thinking.running': (v) =>
    `جارٍ التفكير${v?.duration ? ` ${v.duration}` : ''}`,
  'thinking.doneBriefly': 'فكّر بإيجاز',
  'thinking.done': (v) =>
    v?.duration ? `فكّر لمدة ${v.duration}` : 'انتهى التفكير',
  'thinking.translate': 'ترجمة',
  'thinking.translation': 'التفكير المترجم',
  'thinking.translating': 'جارٍ الترجمة...',
  'thinking.translationThinking': 'جارٍ التفكير...',
  'thinking.translationFailed': 'فشلت الترجمة',
  'thinking.retranslate': 'إعادة الترجمة',
  'thinking.cancelTranslation': 'إلغاء',
  'thinking.closeTranslation': 'إغلاق',
  'thinking.inputTokens': (v) => `رموز الإدخال: ${v?.count ?? '--'}`,
  'thinking.outputTokens': (v) => `رموز الإخراج: ${v?.count ?? '--'}`,
};
