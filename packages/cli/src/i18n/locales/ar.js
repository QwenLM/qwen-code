/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// Arabic translations for Qwen Code CLI

// CLDR Arabic cardinal forms. The quota notice interpolates these after
// خلال, a genitive slot, so the dual is يومين/ساعتين — the same forms the
// Web Shell catalog uses for the same sentence.
function arPlural(count, zero, one, two, few, many, other) {
  const value = Number(count);
  if (!Number.isFinite(value)) return other;
  if (value === 0) return zero;
  if (value === 1) return one;
  if (value === 2) return two;
  const mod100 = value % 100;
  if (Number.isInteger(value)) {
    if (mod100 >= 3 && mod100 <= 10) return few;
    if (mod100 >= 11 && mod100 <= 99) return many;
  }
  return other;
}

export default {
  user: 'مستخدم',
  assistant: 'مساعد',
  thinking: 'تفكير',
  task: 'مهمة',
  compaction: 'ضغط',
  info: 'معلومات',
  warning: 'تحذير',
  retry: 'إعادة المحاولة',
  'stop-hook': 'خطاف الإيقاف',
  'away-recap': 'ملخص الغياب',
  'user-shell': 'أمر المستخدم',
  advisor: 'مستشار',
  'arena-agent': 'وكيل الساحة',
  'arena-session': 'جلسة الساحة',
  goal: 'هدف',
  'Protected input': 'إدخال محمي',
  'Focused input. Cursor: {{position}}':
    'الإدخال مُركَّز. المؤشر: {{position}}',
  'Unfocused input.': 'الإدخال غير مُركَّز.',
  'Focused Prompt: {{value}}': 'موجه مُركَّز: {{value}}',
  'Prompt: {{value}}': 'موجه: {{value}}',
  'Focused Input: {{value}}': 'إدخال مُركَّز: {{value}}',
  'Input: {{value}}': 'إدخال: {{value}}',
  'Placeholder: {{value}}': 'نص نائب: {{value}}',
  'Cursor: {{position}}': 'المؤشر: {{position}}',
  'Selected {{value}}': 'محدد {{value}}',
  'Disabled {{value}}': 'معطّل {{value}}',
  'Focused Toggle on: {{value}}': 'مفتاح التبديل مُركَّز ومُفعّل: {{value}}',
  'Focused Toggle off: {{value}}':
    'مفتاح التبديل مُركَّز وغير مُفعّل: {{value}}',
  'Toggle on: {{value}}': 'مفتاح التبديل مُفعّل: {{value}}',
  'Toggle off: {{value}}': 'مفتاح التبديل غير مُفعّل: {{value}}',
  'Conversation cleared.': 'تم مسح المحادثة.',
  '{{role}}: {{value}}': '{{role}}: {{value}}',
  'Revision {{value}}': 'مراجعة {{value}}',
  Dialog: 'نافذة',
  'Dialog closed. Focus: prompt.': 'أُغلقت النافذة. التركيز: الموجه.',
  'Dialog closed.': 'أُغلقت النافذة.',
  'Waiting for confirmation': 'في انتظار التأكيد',
  'Working. Escape to cancel.': 'جارٍ العمل. Escape للإلغاء.',
  'History items {{start}}-{{end}} of {{total}}':
    'عناصر السجل {{start}}-{{end}} من {{total}}',
  'Worktree: {{value}}': 'شجرة العمل: {{value}}',
  'Workflow mode: on': 'وضع مسار العمل: مُفعّل',
  'Workflow mode: on (unavailable)': 'وضع مسار العمل: مُفعّل (غير متاح)',
  'Shift+Up/Down or PageUp/Down to read history; Ctrl+Home/End for first/latest.':
    'اضغط Shift+Up/Down أو PageUp/Down لقراءة السجل؛ وCtrl+Home/End للانتقال إلى الأول/الأخير.',
  "You've used up your weekly credits.{{reset}} You can wait or run /upgrade to get more credits.":
    'لقد استنفدت رصيدك الأسبوعي{{reset}}. يمكنك الانتظار أو تشغيل /upgrade للحصول على رصيد إضافي.',
  "You've used up your weekly credits.{{reset}} Please try again after the reset.":
    'لقد استنفدت رصيدك الأسبوعي{{reset}}. يُرجى المحاولة مرة أخرى بعد إعادة التعيين.',
  "You've used up your credits.{{reset}} Please try again after the reset.":
    'لقد استنفدت رصيدك{{reset}}. يُرجى المحاولة مرة أخرى بعد إعادة التعيين.',
  ' Your credits are expected to reset in {{time}}.':
    ' ومن المتوقع إعادة تعيين رصيدك خلال {{time}}',
  '{{days}} and {{hours}}': '{{days}} و{{hours}}',
  '1 day': 'يوم واحد',
  '{{count}} days': (params) => {
    const c = params?.count ?? '0';
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
  '{{count}} hours': (params) => {
    const c = params?.count ?? '0';
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
  Retry: 'إعادة المحاولة',
  'Connecting…': 'جارٍ الاتصال…',
  'Loading models from provider…': 'جارٍ تحميل النماذج من المزوّد…',
  'Recommended models · provider list unavailable, showing built-ins':
    'النماذج الموصى بها · قائمة المزوّد غير متاحة، يتم عرض النماذج المدمجة',
  'Generated UI': 'واجهة المستخدم المولّدة',
  'Enable bundled Generated UI in supported local sessions. Restart the owning session to apply changes.':
    'تفعيل Generated UI المدمجة في الجلسات المحلية المدعومة. أعد تشغيل الجلسة المعنية لتطبيق التغييرات.',

  'Cannot disable an extension-provided MCP server here.':
    'لا يمكن تعطيل خادم MCP الموفّر من إضافة هنا.',
  'Cleared authentication for "{{name}}".': 'تم مسح المصادقة لـ "{{name}}".',
  'MCP "{{name}}" disabled for all projects.':
    'تم تعطيل MCP "{{name}}" لجميع المشاريع.',
  'Enable extension "{{name}}" to manage this MCP server.':
    'فعّل الإضافة "{{name}}" لإدارة خادم MCP هذا.',
  'Extension-provided MCP servers cannot be favorited.':
    'لا يمكن إضافة خوادم MCP الموفّرة من إضافة إلى المفضلة.',

  'User level': 'مستوى المستخدم',
  'Project level': 'مستوى المشروع',
  'Clipboard image paste is unavailable because the native clipboard module could not be loaded. Reinstall Qwen Code or use the npm installation method.':
    'لصق الصور من الحافظة غير متاح لتعذّر تحميل وحدة الحافظة الأصلية. أعد تثبيت Qwen Code أو استخدم طريقة التثبيت عبر npm.',
  'Clipboard image paste is unavailable: no supported clipboard tool was reached. On Linux, install `wl-clipboard` (Wayland) or `xclip` (X11), or set DISPLAY/WAYLAND_DISPLAY if running headless.':
    'لصق الصور من الحافظة غير متاح: لم يتم الوصول إلى أي أداة حافظة مدعومة. على Linux، ثبّت `wl-clipboard` (لـ Wayland) أو `xclip` (لـ X11)، أو اضبط DISPLAY/WAYLAND_DISPLAY عند التشغيل دون واجهة رسومية.',

  // ==========================================================================
  // Extensions manager dialog (Installed / Discover / Sources tabs)
  // ==========================================================================
  ' · {{marketplace}} (Tab to clear)': ' · {{marketplace}} (Tab للمسح)',
  '"{{name}}" {{state}}.': '"{{name}}" {{state}}.',
  '(Tab / ←→ to switch)': '(Tab / ←→ للتبديل)',
  '+ Add new marketplace': '+ إضافة متجر جديد',
  '+ Install a new extension': '+ تثبيت إضافة جديدة',
  Actions: 'الإجراءات',
  'Add Marketplace': 'إضافة متجر',
  'Add a marketplace in the Sources tab to discover extensions.':
    'أضف متجرًا في تبويب المصادر لاكتشاف الإضافات.',
  'Add new': 'إضافة جديد',
  'Add to Favorites': 'إضافة إلى المفضلة',
  'Added "{{name}}" to favorites.': 'تمت إضافة "{{name}}" إلى المفضلة.',
  'Added marketplace "{{name}}".': 'تمت إضافة المتجر "{{name}}".',
  'Adding...': 'جارٍ الإضافة...',
  'Back to extension list': 'العودة إلى قائمة الإضافات',
  'Browse extensions ({{count}})': 'تصفّح الإضافات ({{count}})',
  'By: {{a}}': 'بواسطة: {{a}}',
  'Change scope': 'تغيير النطاق',
  'Change scope for "{{name}}":': 'تغيير النطاق لـ "{{name}}":',
  'Changing scope...': 'جارٍ تغيير النطاق...',
  'Uninstalling "{{name}}"...': 'جارٍ إلغاء تثبيت "{{name}}"...',
  'Update available for "{{name}}".': 'يتوفر تحديث لـ "{{name}}".',
  '"{{name}}" is already up to date.': '"{{name}}" محدّث بالفعل.',
  'Checking "{{name}}" for updates...': 'جارٍ التحقق من تحديثات "{{name}}"...',
  '"{{name}}" does not support update checks.':
    '"{{name}}" لا يدعم التحقق من التحديثات.',
  '"{{name}}" cannot be update-checked (Claude marketplace plugins update by reinstalling).':
    'لا يمكن التحقق من تحديثات "{{name}}" (يتم تحديث إضافات متجر Claude بإعادة التثبيت).',
  'Failed to check "{{name}}" for updates.':
    'فشل التحقق من تحديثات "{{name}}".',
  'Claude plugin marketplace': 'متجر إضافات Claude',
  Commands: 'الأوامر',
  'Components:': 'المكوّنات:',
  'Could not load this marketplace.': 'تعذّر تحميل هذا المتجر.',
  'Current: {{scope}}': 'الحالي: {{scope}}',
  Disabled: 'معطّل',
  Discover: 'اكتشف',
  'Disabling "{{name}}"...': 'جارٍ تعطيل "{{name}}"...',
  'Disabling MCP "{{name}}"...': 'جارٍ تعطيل MCP "{{name}}"...',
  'Discover extensions': 'اكتشاف الإضافات',
  'Discovering extensions...': 'جارٍ البحث عن الإضافات...',
  'Enabling "{{name}}"...': 'جارٍ تفعيل "{{name}}"...',
  'Enabling MCP "{{name}}"...': 'جارٍ تفعيل MCP "{{name}}"...',
  'Enter extension source:': 'أدخل مصدر الإضافة:',
  'Enter marketplace source (Claude format):':
    'أدخل مصدر المتجر (بتنسيق Claude):',
  'Examples:': 'أمثلة:',
  'Extension details': 'تفاصيل الإضافة',
  'Extension v{{version}}': 'الإضافة v{{version}}',
  'Extensions are not available in this environment.':
    'الإضافات غير متاحة في هذه البيئة.',
  'Failed to open {{url}}': 'تعذّر فتح {{url}}',
  Favorites: 'المفضلة',
  'Global (User Scope)': 'عام (نطاق المستخدم)',
  'Install Extension': 'تثبيت إضافة',
  'Install for the current workspace (project scope)':
    'تثبيت لمساحة العمل الحالية (نطاق المشروع)',
  'Install for you (user scope)': 'تثبيت لك (نطاق المستخدم)',
  'Install {{count}} extension(s) to which scope?':
    'في أي نطاق تريد تثبيت {{count}} إضافة؟',
  Installed: 'مثبّت',
  'Installed extension "{{name}}".': 'تم تثبيت الإضافة "{{name}}".',
  'Installed extensions ({{count}}):': 'الإضافات المثبّتة ({{count}}):',
  'Installed {{count}} extension(s).': 'تم تثبيت {{count}} إضافة.',
  '{{name}}: installed, but the scope rollback failed — it may be disabled at all scopes; re-enable it from the Installed tab.':
    '{{name}}: تم التثبيت، لكن فشل التراجع عن النطاق — قد تكون معطّلة في جميع النطاقات؛ أعد تفعيلها من تبويب «مثبّت».',
  'Could not change scope, and the rollback also failed — "{{name}}" may be disabled at all scopes. Re-enable it from the Installed tab. ({{error}})':
    'تعذّر تغيير النطاق، وفشل التراجع أيضًا — قد تكون "{{name}}" معطّلة في جميع النطاقات. أعد تفعيلها من تبويب «مثبّت». ({{error}})',
  'Installed {{ok}}, failed {{fail}}: {{detail}}':
    'تم تثبيت {{ok}}، وفشل {{fail}}: {{detail}}',
  'Installing...': 'جارٍ التثبيت...',
  'Last updated: {{date}}': 'آخر تحديث: {{date}}',
  MCP: 'MCP',
  'MCP "{{name}}" {{state}}.': 'MCP "{{name}}" {{state}}.',
  'MCP servers': 'خوادم MCP',
  'Mark for Update': 'تحديد للتحديث',
  Marketplaces: 'المتاجر',
  'No extensions discovered.': 'لم يتم العثور على إضافات.',
  'No extensions match your search.': 'لا توجد إضافات تطابق بحثك.',
  'No extensions or marketplaces added yet.':
    'لم تتم إضافة أي إضافات أو متاجر بعد.',
  'No homepage available.': 'لا تتوفر صفحة رئيسية.',
  'No installable extensions selected.': 'لم يتم تحديد إضافات قابلة للتثبيت.',
  'No plugins or MCP servers installed.': 'لا توجد إضافات أو خوادم MCP مثبّتة.',
  None: 'لا شيء',
  'Note: Uninstall permanently removes this extension.':
    'ملاحظة: يؤدي إلغاء التثبيت إلى إزالة هذه الإضافة نهائيًا.',
  'Open homepage': 'فتح الصفحة الرئيسية',
  'Project (Workspace)': 'المشروع (مساحة العمل)',
  'Refreshed {{count}} extension(s).': 'تم تحديث {{count}} إضافة.',
  'Remove from Favorites': 'إزالة من المفضلة',
  'Remove marketplace': 'إزالة المتجر',
  'Remove marketplace "{{name}}"?': 'إزالة المتجر "{{name}}"؟',
  'Removed "{{name}}" from favorites.': 'تمت إزالة "{{name}}" من المفضلة.',
  'Removed marketplace "{{name}}".': 'تمت إزالة المتجر "{{name}}".',
  'Scope:': 'النطاق:',
  'Set "{{name}}" scope to {{scope}}.':
    'تم تعيين نطاق "{{name}}" إلى {{scope}}.',
  Sources: 'المصادر',
  'Type to search · Space to toggle · Enter to view · Ctrl+R refresh · Esc to go back':
    'اكتب للبحث · Space للتبديل · Enter للعرض · Ctrl+R للتحديث · Esc للعودة',
  Uninstall: 'إلغاء التثبيت',
  'Uninstalled "{{name}}".': 'تم إلغاء تثبيت "{{name}}".',
  'Update Now': 'تحديث الآن',
  'Update marketplace': 'تحديث المتجر',
  'Update marketplace (last updated {{date}})':
    'تحديث المتجر (آخر تحديث {{date}})',
  'Could not update marketplace "{{name}}".': 'تعذّر تحديث المتجر "{{name}}".',
  'Updated "{{name}}".': 'تم تحديث "{{name}}".',
  'Updated marketplace "{{name}}".': 'تم تحديث المتجر "{{name}}".',
  'Use the Discover tab to find and install plugins.':
    'استخدم تبويب «اكتشف» للعثور على الإضافات وتثبيتها.',
  'Version: {{v}}': 'الإصدار: {{v}}',
  'Will install:': 'سيتم تثبيت:',
  'Would open: {{url}}': 'سيتم فتح: {{url}}',
  'Y/Enter to confirm · N/Esc to cancel': 'Y/Enter للتأكيد · N/Esc للإلغاء',
  'Press R to retry · Esc to go back': 'اضغط R لإعادة المحاولة · Esc للعودة',
  'Enter to select · R refresh · Esc to go back':
    'Enter للاختيار · R للتحديث · Esc للعودة',
  'from {{marketplace}}': 'من {{marketplace}}',
  installed: 'مثبّت',
  '{{count}} Agents': '{{count}} وكلاء',
  '{{count}} Workflows': '{{count}} مسارات عمل',
  '{{count}} Commands': '{{count}} أوامر',
  '{{count}} MCP': '{{count}} MCP',
  '{{count}} Skills': '{{count}} مهارات',
  '{{count}} available extensions': '{{count}} إضافات متاحة',
  '↑ more above': '↑ المزيد بالأعلى',
  '↑↓ navigate · Enter open · d remove marketplace · Esc close':
    '↑↓ للتنقل · Enter للفتح · d لإزالة المتجر · Esc للإغلاق',
  '↑↓ navigate · Enter select · Esc close':
    '↑↓ للتنقل · Enter للاختيار · Esc للإغلاق',
  '↑↓ navigate · Enter select · d remove marketplace · Esc close':
    '↑↓ للتنقل · Enter للاختيار · d لإزالة المتجر · Esc للإغلاق',
  '↑↓ navigate · Space enable/disable · f favorite · Enter details · Esc close':
    '↑↓ للتنقل · Space للتفعيل/التعطيل · f للمفضلة · Enter للتفاصيل · Esc للإغلاق',
  '↓ more below': '↓ المزيد بالأسفل',
  '⚠ Make sure you trust an extension before installing, updating, or using it. We cannot verify what MCP servers, files, or other software an extension includes, or that it works as intended. See the extension homepage for more information.':
    '⚠ تأكّد من ثقتك بالإضافة قبل تثبيتها أو تحديثها أو استخدامها. لا يمكننا التحقق من خوادم MCP أو الملفات أو البرامج الأخرى التي تتضمنها الإضافة، أو أنها تعمل كما هو متوقع. راجع الصفحة الرئيسية للإضافة لمزيد من المعلومات.',

  // ============================================================================
  // Tool display names (chat-stream badge labels)
  // ============================================================================
  'toolDisplayName.Exec': 'تنفيذ',
  'toolDisplayName.Edit': 'تعديل',
  'toolDisplayName.WriteFile': 'كتابة ملف',
  'toolDisplayName.ReadFile': 'قراءة ملف',
  'toolDisplayName.ZoomImage': 'تكبير صورة',
  'toolDisplayName.Grep': 'Grep',
  'toolDisplayName.Glob': 'Glob',
  'toolDisplayName.Shell': 'تشغيل أمر',
  'toolDisplayName.Shell Command': 'أمر Shell',
  'toolDisplayName.TodoList': 'قائمة المهام',
  'toolDisplayName.Goal': 'هدف',
  'toolDisplayName.UpdateGoal': 'تحديث الهدف',
  'toolDisplayName.ProposeGoal': 'اقتراح هدف',
  'toolDisplayName.SaveMemory': 'حفظ الذاكرة',
  'toolDisplayName.ManageMemory': 'إدارة الذاكرة',
  'toolDisplayName.SearchMemory': 'بحث في الذاكرة',
  'toolDisplayName.Agent': 'Agent',
  'toolDisplayName.Advisor': 'المستشار',
  'toolDisplayName.Artifact': 'مخرج',
  'toolDisplayName.RecordArtifact': 'تسجيل مخرج',
  'toolDisplayName.RecordSource': 'تسجيل مصدر',
  'toolDisplayName.ReportFindings': 'تقرير النتائج',
  'toolDisplayName.DisplayImage': 'عرض صورة',
  'toolDisplayName.Skill': 'مهارة',
  'toolDisplayName.EnterPlanMode': 'دخول وضع التخطيط',
  'toolDisplayName.ExitPlanMode': 'خروج من وضع التخطيط',
  'toolDisplayName.WebFetch': 'جلب من الويب',
  'toolDisplayName.WebSearch': 'بحث الويب',
  'toolDisplayName.ListFiles': 'سرد الملفات',
  'toolDisplayName.Lsp': 'LSP',
  'toolDisplayName.AskUserQuestion': 'سؤال المستخدم',
  'toolDisplayName.CronCreate': 'إنشاء مهمة مجدولة',
  'toolDisplayName.CronList': 'قائمة المهام المجدولة',
  'toolDisplayName.CronDelete': 'حذف مهمة مجدولة',
  'toolDisplayName.AutofixPr': 'إصلاح PR تلقائيًا',
  'toolDisplayName.LoopWakeup': 'إيقاظ الحلقة',
  'toolDisplayName.CreateSubSession': 'إنشاء جلسة فرعية',
  'toolDisplayName.ListAgents': 'سرد الوكلاء',
  'toolDisplayName.TaskCreate': 'إنشاء مهمة',
  'toolDisplayName.TaskUpdate': 'تحديث مهمة',
  'toolDisplayName.TaskList': 'قائمة الأعمال',
  'toolDisplayName.TaskStop': 'إيقاف مهمة',
  'toolDisplayName.TeamCreate': 'إنشاء فريق',
  'toolDisplayName.TeamDelete': 'حذف فريق',
  'toolDisplayName.TeamPlanApproval': 'موافقة خطة الفريق',
  'toolDisplayName.SendMessage': 'إرسال رسالة',
  'toolDisplayName.RequestShutdown': 'طلب إيقاف',
  'toolDisplayName.StructuredOutput': 'مخرجات مهيكلة',
  'toolDisplayName.Monitor': 'مراقبة',
  'toolDisplayName.NotebookEdit': 'تعديل Notebook',
  'toolDisplayName.ToolSearch': 'بحث الأدوات',
  'toolDisplayName.ToolCall': 'استدعاء أداة',
  'toolDisplayName.EnterWorktree': 'دخول Worktree',
  'toolDisplayName.ExitWorktree': 'خروج من Worktree',
  'toolDisplayName.Workflow': 'سير العمل',
  'toolDisplayName.ReadMcpResource': 'قراءة مورد MCP',
  'toolDisplayName.ImageGen': 'توليد صورة',
  'toolDisplayName.DownsampleImage': 'تقليل دقة الصورة',
  'toolDisplayName.DownscaleVideo': 'تقليل دقة الفيديو',
  'toolDisplayName.DownsampleAudio': 'تقليل معدل الصوت',
  'toolDisplayName.ExtractKeyframes': 'استخراج الإطارات الرئيسية',
  'toolDisplayName.ExtractAudio': 'استخراج الصوت',
  'toolDisplayName.ClipVideo': 'قص الفيديو',
  'toolDisplayName.ClipImage': 'قص الصورة',
  'toolDisplayName.ClipAudio': 'قص الصوت',
  'toolDisplayName.CaptionImage': 'وصف الصورة',
  'toolDisplayName.CaptionAudio': 'وصف الصوت',
  'toolDisplayName.OcrImage': 'استخراج نص الصورة',
  'toolDisplayName.UnderstandVideoSegments': 'فهم مقاطع الفيديو',
  'toolDisplayName.ConvertImage': 'تحويل الصورة',
  'toolDisplayName.TranscribeAudio': 'تفريغ الصوت',
  'toolDisplayName.RecallMediaMemory': 'استرجاع ذاكرة الوسائط',
  '[fixed-only: runs via media policies, not the model]':
    '[ثابت فقط: يعمل عبر سياسات الوسائط، وليس النموذج]',

  // ============================================================================
  // Help / UI Components
  // ============================================================================
  '↑ to manage attachments': '↑ لإدارة المرفقات',
  '← → select, Delete to remove, ↓ to exit':
    '← → للاختيار، Delete للإزالة، ↓ للخروج',
  'Attachments: ': 'المرفقات: ',
  'Basics:': 'الأساسيات:',
  'Add context': 'إضافة سياق',
  'Use {{symbol}} to specify files for context (e.g., {{example}}) to target specific files or folders.':
    'استخدم {{symbol}} لتحديد الملفات في السياق (مثلاً {{example}}) لاستهداف ملفات أو مجلدات محددة.',
  '@': '@',
  '@src/myFile.ts': '@src/myFile.ts',
  'Shell mode': 'وضع Shell',
  'YOLO mode': 'وضع YOLO',
  'Auto mode': 'الوضع التلقائي',
  'auto_mode.entry_notice':
    'تم تفعيل الوضع التلقائي.\n   يُقيّم مصنّف LLM كل استدعاء أداة — تُعتمد الإجراءات الآمنة تلقائيًا،\n   وتُحظر الإجراءات الخطرة. للخروج: Shift+Tab أو /approval-mode default.',
  'plan mode': 'وضع التخطيط',
  'auto-accept edits': 'قبول التعديلات تلقائيًا',
  'Accepting edits': 'قبول التعديلات',
  '(shift + tab to cycle)': '(shift + tab للتبديل)',
  '(tab to cycle)': '(tab للتبديل)',
  'Execute shell commands via {{symbol}} (e.g., {{example1}}) or use natural language (e.g., {{example2}}).':
    'نفّذ أوامر Shell عبر {{symbol}} (مثلاً {{example1}}) أو استخدم اللغة الطبيعية (مثلاً {{example2}}).',
  '!': '!',
  '!npm run start': '!npm run start',
  'start server': 'تشغيل الخادم',
  'Commands:': 'الأوامر:',
  'shell command': 'أمر shell',
  'Model Context Protocol command (from external servers)':
    'أمر Model Context Protocol (من خوادم خارجية)',
  'Keyboard Shortcuts:': 'اختصارات لوحة المفاتيح:',
  'Toggle this help display': 'إظهار/إخفاء عرض المساعدة هذا',
  'Toggle shell mode': 'تبديل وضع Shell',
  'Open command menu': 'فتح قائمة الأوامر',
  'Add file context': 'إضافة سياق ملف',
  'Accept suggestion / Autocomplete': 'قبول الاقتراح / الإكمال التلقائي',
  'Reverse search history': 'بحث عكسي في السجل',
  'Press ? again to close': 'اضغط ? مجددًا للإغلاق',
  'for shell mode': 'لوضع Shell',
  'for commands': 'لقائمة الأوامر',
  'for file paths': 'لمسارات الملفات',
  'to clear input': 'لمسح الإدخال',
  'to cycle approvals': 'لتبديل وضع الموافقة',
  'to quit': 'للخروج',
  'for newline': 'لسطر جديد',
  'to clear screen': 'لمسح الشاشة',
  'to search history': 'للبحث في السجل',
  'to paste images': 'للصق الصور',
  'for external editor': 'للمحرر الخارجي',
  'to expand details': 'لتوسيع التفاصيل',
  'Jump through words in the input': 'التنقل بين الكلمات في الإدخال',
  'Close dialogs, cancel requests, or quit application':
    'إغلاق النوافذ، إلغاء الطلبات، أو إنهاء التطبيق',
  'New line': 'سطر جديد',
  'New line (Alt+Enter works for certain linux distros)':
    'سطر جديد (Alt+Enter يعمل في بعض توزيعات Linux)',
  'Clear the screen': 'مسح الشاشة',
  'Open input in external editor': 'فتح الإدخال في محرر خارجي',
  'Send message': 'إرسال رسالة',
  'Initializing...': 'جارٍ التهيئة...',
  'Connecting to MCP servers... ({{connected}}/{{total}})':
    'جارٍ الاتصال بخوادم MCP... ({{connected}}/{{total}})',
  'Type your message or @path/to/file': 'اكتب رسالتك أو @path/to/file',
  '? for shortcuts': '? للاختصارات',
  'Pasting…': 'جارٍ اللصق…',
  "Press 'i' for INSERT mode and 'Esc' for NORMAL mode.":
    "اضغط 'i' لوضع INSERT و 'Esc' لوضع NORMAL.",
  'Cancel operation / Clear input (double press)':
    'إلغاء العملية / مسح الإدخال (ضغط مزدوج)',
  'Cycle approval modes': 'تبديل أوضاع الموافقة',
  'Cycle through your prompt history': 'التنقل عبر سجل المطالبات',
  'For a full list of shortcuts, see {{docPath}}':
    'للاطلاع على القائمة الكاملة للاختصارات، راجع {{docPath}}',
  'docs/keyboard-shortcuts.md': 'docs/keyboard-shortcuts.md',
  'for help on Qwen Code': 'للمساعدة حول Qwen Code',
  'show version info': 'عرض معلومات الإصدار',
  'show paths for current session files and logs':
    'عرض مسارات ملفات وسجلات الجلسة الحالية',
  'submit a bug report': 'إرسال بلاغ خطأ',
  Status: 'الحالة',

  // ============================================================================
  // System Information Fields
  // ============================================================================
  'Qwen Code': 'Qwen Code',
  Runtime: 'بيئة التشغيل',
  OS: 'نظام التشغيل',
  Auth: 'المصادقة',
  Model: 'النموذج',
  'Fast Model': 'النموذج السريع',
  'Agent Loop': 'حلقة الوكيل',
  Sandbox: 'بيئة العزل',
  'Session ID': 'معرّف الجلسة',
  'Base URL': 'عنوان URL الأساسي',
  Proxy: 'الوكيل',
  'Memory Usage': 'استخدام الذاكرة',
  'IDE Client': 'عميل IDE',

  // ============================================================================
  // Commands - General
  // ============================================================================
  'Analyzes the project and creates a tailored QWEN.md file.':
    'يحلل المشروع وينشئ ملف QWEN.md مخصصًا.',
  'List available Qwen Code tools. Usage: /tools [desc]':
    'عرض أدوات Qwen Code المتاحة. الاستخدام: /tools [desc]',
  'Open the skills panel (browse, search, toggle, pick).':
    'فتح لوحة المهارات (تصفح، بحث، تبديل، اختيار).',
  'Move this session to a new working directory':
    'نقل هذه الجلسة إلى مجلد عمل جديد',
  'Wait for background agents to finish or stop them in /tasks before changing directories.':
    'انتظر انتهاء الوكلاء في الخلفية أو أوقفهم عبر /tasks قبل تغيير المجلد.',
  'Manage Skills': 'إدارة المهارات',
  'Skills configuration saved.': 'تم حفظ إعدادات المهارات.',
  'Skills configuration saved, but refresh failed: {{error}}. Restart to ensure the new state is applied.':
    'تم حفظ إعدادات المهارات، لكن التحديث فشل: {{error}}. أعد التشغيل لضمان تطبيق الحالة الجديدة.',
  'Workspace is untrusted; workspace settings are ignored by the merged config. Run /trust first to persist skills changes here, or edit ~/.qwen/settings.json directly to manage skills at user scope.':
    'مساحة العمل غير موثوقة؛ يتم تجاهل إعدادات مساحة العمل في الإعدادات المدمجة. شغّل /trust أولاً لحفظ تغييرات المهارات هنا، أو عدّل ~/.qwen/settings.json مباشرة لإدارة المهارات على مستوى المستخدم.',
  'SkillManager not available.': 'مدير المهارات (SkillManager) غير متاح.',
  'Loading skills…': 'جارٍ تحميل المهارات…',
  'Failed to load skills: {{error}}': 'فشل تحميل المهارات: {{error}}',
  'Failed to save skills configuration: {{error}}':
    'فشل حفظ إعدادات المهارات: {{error}}',
  'All available skills are disabled. Edit ~/.qwen/settings.json or .qwen/settings.json (skills.disabled) to re-enable.':
    'جميع المهارات المتاحة معطّلة. عدّل ~/.qwen/settings.json أو .qwen/settings.json (skills.disabled) لإعادة تفعيلها.',
  'Press esc to close.': 'اضغط Esc للإغلاق.',
  '{{count}} skills · ': '{{count}} مهارات · ',
  '{{matched}} / {{total}} skills · ': '{{matched}} / {{total}} مهارات · ',
  'Space toggle · Enter pick (fill input) · Esc save & exit · workspace scope':
    'Space للتبديل · Enter للاختيار (ملء الإدخال) · Esc للحفظ والخروج · نطاق مساحة العمل',
  'Search:': 'بحث:',
  'type to filter…': 'اكتب للتصفية…',
  'No skills are currently available.': 'لا توجد مهارات متاحة حاليًا.',
  'No skills match the search.': 'لا توجد مهارات تطابق البحث.',
  'Locked by settings entries you cannot toggle here:':
    'مقفلة بواسطة إعدادات لا يمكنك تبديلها هنا:',
  '{{count}} locked not shown': '{{count}} مقفلة غير معروضة',
  'higher scope': 'نطاق أعلى',
  '  {{name}} {{description}}  [locked: {{scope}}]':
    '  {{name}} {{description}}  [مقفل: {{scope}}]',
  '↑/↓ navigate · backspace edits search':
    '↑/↓ للتنقل · backspace لتعديل البحث',
  Bundled: 'مدمج',
  'Available Qwen Code CLI tools:': 'أدوات Qwen Code CLI المتاحة:',
  'No tools available': 'لا توجد أدوات متاحة',
  'View or change the approval mode for tool usage':
    'عرض أو تغيير وضع الموافقة لاستخدام الأدوات',
  'Invalid approval mode "{{arg}}". Valid modes: {{modes}}':
    'وضع الموافقة "{{arg}}" غير صالح. الأوضاع الصالحة: {{modes}}',
  'Approval mode set to "{{mode}}"': 'تم تعيين وضع الموافقة إلى "{{mode}}"',
  'View or change the language setting': 'عرض أو تغيير إعداد اللغة',
  'List background tasks (text dump — interactive dialog opens via the footer pill)':
    'سرد مهام الخلفية (نصي — تفتح النافذة التفاعلية عبر شارة الشريط السفلي)',
  'Delete a previous session': 'حذف جلسة سابقة',
  'Run installation and environment diagnostics':
    'تشغيل فحوصات التثبيت والبيئة',
  'Browse dynamic model catalogs and choose which models stay enabled locally':
    'تصفّح كتالوجات النماذج الديناميكية واختر النماذج المفعّلة محليًا',
  'Generate a one-line session recap now': 'توليد ملخص من سطر واحد للجلسة الآن',
  'Rename the current conversation. --auto lets the fast model pick a title.':
    'إعادة تسمية المحادثة الحالية. يتيح --auto للنموذج السريع اختيار عنوان.',
  'Rewind conversation to a previous turn': 'إرجاع المحادثة إلى جولة سابقة',
  'Rewind Conversation': 'إرجاع المحادثة',
  'No user turns to rewind to.': 'لا توجد جولات مستخدم للعودة إليها.',
  'Rewind to: ': 'إرجاع إلى: ',
  'Restore code and conversation': 'استعادة الكود والمحادثة',
  'Restore conversation only': 'استعادة المحادثة فقط',
  'Restore code only': 'استعادة الكود فقط',
  'Never mind': 'إلغاء الأمر',
  'Computing file changes...': 'جارٍ حساب تغييرات الملفات...',
  'Restoring...': 'جارٍ الاستعادة...',
  'Restored {{count}} file(s).': 'تمت استعادة {{count}} ملف.',
  'Failed to restore files: {{error}}': 'فشلت استعادة الملفات: {{error}}',
  'Rewind failed: {{error}}': 'فشل الإرجاع: {{error}}',
  'Cannot rewind conversation: no active model client.':
    'لا يمكن إرجاع المحادثة: لا يوجد عميل نموذج نشط.',
  'Code restored, but conversation could not be rewound (no active client).':
    'تمت استعادة الكود، لكن تعذّر إرجاع المحادثة (لا يوجد عميل نشط).',
  'Conversation rewound. Edit your prompt and press Enter to continue.':
    'تم إرجاع المحادثة. عدّل رسالتك واضغط Enter للمتابعة.',
  'Rewinding does not affect files edited manually or via shell commands.':
    'لا يؤثر الإرجاع على الملفات المعدّلة يدويًا أو عبر أوامر Shell.',
  'Cannot rewind to a turn that was compressed. Try a more recent turn.':
    'لا يمكن الإرجاع إلى جولة تم ضغطها. جرّب جولة أحدث.',
  'Cannot rewind the conversation to this turn: it no longer matches the model history (for example, after a retry). Try a more recent turn.':
    'لا يمكن إرجاع المحادثة إلى هذه الجولة: لم تعد تطابق سجل النموذج (مثلاً بعد إعادة محاولة). جرّب جولة أحدث.',
  'File restore is unavailable for this turn (no captured file changes, or this turn predates the current session).':
    'استعادة الملفات غير متاحة لهذه الجولة (لا توجد تغييرات ملفات مسجلة، أو أن هذه الجولة تسبق الجلسة الحالية).',
  '(+{{insertions}} -{{deletions}} in {{count}} file)':
    '(+{{insertions}} -{{deletions}} في {{count}} ملف)',
  '(+{{insertions}} -{{deletions}} in {{count}} files)':
    '(+{{insertions}} -{{deletions}} في {{count}} ملفات)',
  'Failed to restore {{count}} file(s): {{files}}':
    'فشلت استعادة {{count}} ملف: {{files}}',
  'Cannot restore files: this turn was created before file checkpointing was enabled.':
    'لا يمكن استعادة الملفات: تم إنشاء هذه الجولة قبل تفعيل نقاط حفظ الملفات.',
  'No files needed to be restored.': 'لم تحتاج أي ملفات إلى الاستعادة.',
  '↑↓ to navigate · Enter to select · Esc to go back':
    '↑↓ للتنقل · Enter للاختيار · Esc للعودة',
  '↑↓ to navigate · Enter to select · Esc to cancel':
    '↑↓ للتنقل · Enter للاختيار · Esc للإلغاء',
  'Enter/Y to confirm · Esc/N to go back': 'Enter/Y للتأكيد · Esc/N للعودة',
  'change the theme': 'تغيير السمة',
  'Select Theme': 'اختر السمة',
  Preview: 'معاينة',
  '(Use Enter to select, Tab to configure scope)':
    '(استخدم Enter للاختيار، وTab لضبط النطاق)',
  '(Use Enter to apply scope, Tab to go back)':
    '(استخدم Enter لتطبيق النطاق، وTab للعودة)',
  'Theme configuration unavailable due to NO_COLOR env variable.':
    'إعداد السمة غير متاح بسبب متغير البيئة NO_COLOR.',
  'Theme "{{themeName}}" not found.': 'السمة "{{themeName}}" غير موجودة.',
  'Theme "{{themeName}}" not found in selected scope.':
    'السمة "{{themeName}}" غير موجودة في النطاق المحدد.',
  'Clear conversation history and free up context':
    'مسح سجل المحادثة وتفريغ السياق',
  'Compresses the context by replacing it with a summary.':
    'ضغط السياق عبر استبداله بملخص.',
  'Fast context compression without AI. Strips old tool outputs and thinking parts.':
    'ضغط سريع للسياق دون ذكاء اصطناعي. يزيل مخرجات الأدوات القديمة وأجزاء التفكير.',
  'open full Qwen Code documentation in your browser':
    'فتح وثائق Qwen Code الكاملة في متصفحك',
  'Configuration not available.': 'الإعدادات غير متاحة.',
  'Connect an LLM provider': 'ربط مزوّد نموذج لغوي (LLM)',
  'Copy to clipboard: reply, code (by lang), LaTeX, or Mermaid. N = Nth-latest message, index = block number':
    'نسخ إلى الحافظة: الرد، الكود (حسب اللغة)، LaTeX، أو Mermaid. N = الرسالة الأحدث رقم N، index = رقم الكتلة',
  'Show working-tree change stats versus HEAD':
    'عرض إحصائيات تغييرات شجرة العمل مقارنة بـ HEAD',
  'Could not determine current working directory.':
    'تعذّر تحديد مجلد العمل الحالي.',
  'Failed to compute git diff stats': 'فشل حساب إحصائيات git diff',
  'No diff available. Either this is not a git repository, HEAD is missing, or a merge/rebase/cherry-pick/revert is in progress.':
    'لا يتوفر فرق (diff). إما أن هذا ليس مستودع git، أو HEAD مفقود، أو هناك عملية merge/rebase/cherry-pick/revert قيد التنفيذ.',
  'Clean working tree — no changes against HEAD.':
    'شجرة العمل نظيفة — لا توجد تغييرات مقارنة بـ HEAD.',
  '{{count}} file changed, +{{added}} / -{{removed}}':
    'تم تغيير {{count}} ملف، +{{added}} / -{{removed}}',
  '{{count}} files changed, +{{added}} / -{{removed}}':
    'تم تغيير {{count}} ملفات، +{{added}} / -{{removed}}',
  '{{count}} file changed': 'تم تغيير {{count}} ملف',
  '{{count}} files changed': 'تم تغيير {{count}} ملفات',
  '…and {{hidden}} more (showing first {{shown}})':
    '…و{{hidden}} أخرى (عرض أول {{shown}})',
  '(binary)': '(ثنائي)',
  '(binary, new)': '(ثنائي، جديد)',
  '(new)': '(جديد)',
  '(new, partial)': '(جديد، جزئي)',
  '(deleted)': '(محذوف)',
  '(binary, deleted)': '(ثنائي، محذوف)',

  // ============================================================================
  // Commands - Agents
  // ============================================================================
  'Manage subagents for specialized task delegation.':
    'إدارة الوكلاء الفرعيين لتفويض المهام المتخصصة.',
  'Manage existing subagents (view, edit, delete).':
    'إدارة الوكلاء الفرعيين الحاليين (عرض، تعديل، حذف).',
  'Create a new subagent with guided setup.':
    'إنشاء وكيل فرعي جديد مع إعداد موجّه.',
  'Create a reusable skill from a knowledge source (file, URL, conversation, or text).':
    'إنشاء مهارة قابلة لإعادة الاستخدام من مصدر معرفة (ملف، رابط URL، محادثة، أو نص).',
  'The current model or provider does not support native video input for /learn. Switch to a video-capable model on an OpenAI-compatible provider and try again.':
    'النموذج أو المزوّد الحالي لا يدعم إدخال الفيديو الأصلي للأمر /learn. بدّل إلى نموذج يدعم الفيديو على مزوّد متوافق مع OpenAI وحاول مجددًا.',
  'YouTube page URLs cannot be sent as native video input. Download the video into your workspace and pass the local video file path to /learn.':
    'لا يمكن إرسال روابط صفحات YouTube كإدخال فيديو أصلي. حمّل الفيديو إلى مساحة عملك ومرّر مسار الملف المحلي إلى /learn.',
  'The local video could not be attached for /learn.':
    'تعذّر إرفاق الفيديو المحلي للأمر /learn.',

  // ============================================================================
  // Agents - Management Dialog
  // ============================================================================
  Agents: 'الوكلاء',
  'Choose Action': 'اختر إجراءً',
  'Edit {{name}}': 'تعديل {{name}}',
  'Edit Tools: {{name}}': 'تعديل الأدوات: {{name}}',
  'Edit Color: {{name}}': 'تعديل اللون: {{name}}',
  'Delete {{name}}': 'حذف {{name}}',
  'Unknown Step': 'خطوة غير معروفة',
  'Esc to close': 'Esc للإغلاق',
  Transcript: 'السجل',
  'Read {{count}} file': 'تمت قراءة {{count}} ملف',
  'Read {{count}} files': 'تمت قراءة {{count}} ملفات',
  'Reading {{count}} file': 'جارٍ قراءة {{count}} ملف',
  'Reading {{count}} files': 'جارٍ قراءة {{count}} ملفات',
  'Edited {{count}} file': 'تم تعديل {{count}} ملف',
  'Edited {{count}} files': 'تم تعديل {{count}} ملفات',
  'Editing {{count}} file': 'جارٍ تعديل {{count}} ملف',
  'Editing {{count}} files': 'جارٍ تعديل {{count}} ملفات',
  'Wrote {{count}} file': 'تمت كتابة {{count}} ملف',
  'Wrote {{count}} files': 'تمت كتابة {{count}} ملفات',
  'Writing {{count}} file': 'جارٍ كتابة {{count}} ملف',
  'Writing {{count}} files': 'جارٍ كتابة {{count}} ملفات',
  'Searched {{count}} pattern': 'تم البحث عن {{count}} نمط',
  'Searched {{count}} patterns': 'تم البحث عن {{count}} أنماط',
  'Searching {{count}} pattern': 'جارٍ البحث عن {{count}} نمط',
  'Searching {{count}} patterns': 'جارٍ البحث عن {{count}} أنماط',
  'Listed {{count}} directory': 'تم سرد {{count}} مجلد',
  'Listed {{count}} directories': 'تم سرد {{count}} مجلدات',
  'Listing {{count}} directory': 'جارٍ سرد {{count}} مجلد',
  'Listing {{count}} directories': 'جارٍ سرد {{count}} مجلدات',
  'Ran {{count}} command': 'تم تشغيل {{count}} أمر',
  'Ran {{count}} commands': 'تم تشغيل {{count}} أوامر',
  'Running {{count}} command': 'جارٍ تشغيل {{count}} أمر',
  'Running {{count}} commands': 'جارٍ تشغيل {{count}} أوامر',
  'Ran {{count}} agent': 'تم تشغيل {{count}} وكيل',
  'Ran {{count}} agents': 'تم تشغيل {{count}} وكلاء',
  'Running {{count}} agent': 'جارٍ تشغيل {{count}} وكيل',
  'Running {{count}} agents': 'جارٍ تشغيل {{count}} وكلاء',
  'Used {{count}} tool': 'تم استخدام {{count}} أداة',
  'Used {{count}} tools': 'تم استخدام {{count}} أدوات',
  'Using {{count}} tool': 'جارٍ استخدام {{count}} أداة',
  'Using {{count}} tools': 'جارٍ استخدام {{count}} أدوات',
  'Enter to select, ↑↓ to navigate, Esc to close':
    'Enter للاختيار، ↑↓ للتنقل، Esc للإغلاق',
  'Esc to go back': 'Esc للعودة',
  'Enter to confirm, Esc to cancel': 'Enter للتأكيد، Esc للإلغاء',
  'Enter to select, ↑↓ to navigate, Esc to go back':
    'Enter للاختيار، ↑↓ للتنقل، Esc للعودة',
  'Enter to submit, Esc to go back': 'Enter للإرسال، Esc للعودة',
  'Invalid step: {{step}}': 'خطوة غير صالحة: {{step}}',
  'No subagents found.': 'لم يتم العثور على وكلاء فرعيين.',
  "Use '/agents create' to create your first subagent.":
    "استخدم '/agents create' لإنشاء أول وكيل فرعي.",
  '(built-in)': '(مدمج)',
  '(overridden by project level agent)': '(مُتجاوَز بوكيل مستوى المشروع)',
  'Project Level ({{path}})': 'مستوى المشروع ({{path}})',
  'User Level ({{path}})': 'مستوى المستخدم ({{path}})',
  'Built-in Agents': 'الوكلاء المدمجون',
  'Extension Agents': 'وكلاء الإضافات',
  'Using: {{count}} agents': 'قيد الاستخدام: {{count}} وكلاء',
  'View Agent': 'عرض الوكيل',
  'Edit Agent': 'تعديل الوكيل',
  'Delete Agent': 'حذف الوكيل',
  Back: 'رجوع',
  'No agent selected': 'لم يتم تحديد وكيل',
  'File Path: ': 'مسار الملف: ',
  'Tools: ': 'الأدوات: ',
  'Color: ': 'اللون: ',
  'Description:': 'الوصف:',
  'System Prompt:': 'موجه النظام:',
  'Open in editor': 'فتح في المحرر',
  'Edit tools': 'تعديل الأدوات',
  'Edit color': 'تعديل اللون',
  '✗ Error:': '✗ خطأ:',
  'Are you sure you want to delete agent "{{name}}"?':
    'هل أنت متأكد أنك تريد حذف الوكيل "{{name}}"؟',

  // ============================================================================
  // Agents - Creation Wizard
  // ============================================================================
  'Project Level (.qwen/agents/)': 'مستوى المشروع (.qwen/agents/)',
  'User Level (~/.qwen/agents/)': 'مستوى المستخدم (~/.qwen/agents/)',
  '✓ Subagent Created Successfully!': '✓ تم إنشاء الوكيل الفرعي بنجاح!',
  'Subagent "{{name}}" has been saved to {{level}} level.':
    'تم حفظ الوكيل الفرعي "{{name}}" على {{level}}.',
  'Name: ': 'الاسم: ',
  'Location: ': 'الموقع: ',
  '✗ Error saving subagent:': '✗ خطأ أثناء حفظ الوكيل الفرعي:',
  'Warnings:': 'التحذيرات:',
  'Name "{{name}}" already exists at {{level}} level - will overwrite existing subagent':
    'الاسم "{{name}}" موجود بالفعل على {{level}} - سيتم استبدال الوكيل الفرعي الحالي',
  'Name "{{name}}" exists at user level - project level will take precedence':
    'الاسم "{{name}}" موجود على مستوى المستخدم - ستكون الأولوية لمستوى المشروع',
  'Name "{{name}}" exists at project level - existing subagent will take precedence':
    'الاسم "{{name}}" موجود على مستوى المشروع - ستكون الأولوية للوكيل الفرعي الحالي',
  'Description is over {{length}} characters': 'الوصف يتجاوز {{length}} حرفًا',
  'System prompt is over {{length}} characters':
    'موجه النظام يتجاوز {{length}} حرفًا',
  'Step {{n}}: Choose Location': 'الخطوة {{n}}: اختر الموقع',
  'Step {{n}}: Choose Generation Method': 'الخطوة {{n}}: اختر طريقة التوليد',
  'Generate with Qwen Code (Recommended)': 'توليد عبر Qwen Code (موصى به)',
  'Manual Creation': 'إنشاء يدوي',
  'Describe what this subagent should do and when it should be used. (Be comprehensive for best results)':
    'صف ما يجب أن يفعله هذا الوكيل الفرعي ومتى يُستخدم. (كن شاملاً للحصول على أفضل النتائج)',
  'e.g., Expert code reviewer that reviews code based on best practices...':
    'مثلاً: مراجع كود خبير يراجع الكود وفق أفضل الممارسات...',
  'Generating subagent configuration...': 'جارٍ توليد إعدادات الوكيل الفرعي...',
  'Failed to generate subagent: {{error}}':
    'فشل توليد الوكيل الفرعي: {{error}}',
  'Step {{n}}: Describe Your Subagent': 'الخطوة {{n}}: صف وكيلك الفرعي',
  'Step {{n}}: Enter Subagent Name': 'الخطوة {{n}}: أدخل اسم الوكيل الفرعي',
  'Step {{n}}: Enter System Prompt': 'الخطوة {{n}}: أدخل موجه النظام',
  'Step {{n}}: Enter Description': 'الخطوة {{n}}: أدخل الوصف',
  'Step {{n}}: Select Tools': 'الخطوة {{n}}: اختر الأدوات',
  'All Tools (Default)': 'جميع الأدوات (افتراضي)',
  'All Tools': 'جميع الأدوات',
  'Read-only Tools': 'أدوات القراءة فقط',
  'Read & Edit Tools': 'أدوات القراءة والتعديل',
  'Read & Edit & Execution Tools': 'أدوات القراءة والتعديل والتنفيذ',
  'All tools selected, including MCP tools':
    'تم اختيار جميع الأدوات، بما في ذلك أدوات MCP',
  'Selected tools:': 'الأدوات المختارة:',
  'Read-only tools:': 'أدوات القراءة فقط:',
  'Edit tools:': 'أدوات التعديل:',
  'Execution tools:': 'أدوات التنفيذ:',
  'Step {{n}}: Choose Background Color': 'الخطوة {{n}}: اختر لون الخلفية',
  'Step {{n}}: Confirm and Save': 'الخطوة {{n}}: تأكيد وحفظ',
  'Esc to cancel': 'Esc للإلغاء',
  'Press Enter to save, e to save and edit, Esc to go back':
    'اضغط Enter للحفظ، أو e للحفظ والتعديل، أو Esc للعودة',
  'Press Enter to continue, {{navigation}}Esc to {{action}}':
    'اضغط Enter للمتابعة، {{navigation}}Esc للـ{{action}}',
  cancel: 'إلغاء',
  'go back': 'عودة',
  '↑↓ to navigate, ': '↑↓ للتنقل، ',
  'Enter a clear, unique name for this subagent.':
    'أدخل اسمًا واضحًا وفريدًا لهذا الوكيل الفرعي.',
  'e.g., Code Reviewer': 'مثلاً: Code Reviewer',
  'Name cannot be empty.': 'لا يمكن أن يكون الاسم فارغًا.',
  "Write the system prompt that defines this subagent's behavior. Be comprehensive for best results.":
    'اكتب موجه النظام الذي يحدّد سلوك هذا الوكيل الفرعي. كن شاملاً للحصول على أفضل النتائج.',
  'e.g., You are an expert code reviewer...': 'مثلاً: أنت مراجع كود خبير...',
  'System prompt cannot be empty.': 'لا يمكن أن يكون موجه النظام فارغًا.',
  'Describe when and how this subagent should be used.':
    'صف متى وكيف ينبغي استخدام هذا الوكيل الفرعي.',
  'e.g., Reviews code for best practices and potential bugs.':
    'مثلاً: يراجع الكود وفق أفضل الممارسات ويكتشف الأخطاء المحتملة.',
  'Description cannot be empty.': 'لا يمكن أن يكون الوصف فارغًا.',
  'Failed to launch editor: {{error}}': 'فشل تشغيل المحرر: {{error}}',
  'Failed to save and edit subagent: {{error}}':
    'فشل حفظ الوكيل الفرعي وتعديله: {{error}}',

  // ============================================================================
  // Extensions - Management Dialog
  // ============================================================================
  'Manage Extensions': 'إدارة الإضافات',
  'Extension Details': 'تفاصيل الإضافة',
  'View Extension': 'عرض الإضافة',
  'Update Extension': 'تحديث الإضافة',
  'Disable Extension': 'تعطيل الإضافة',
  'Enable Extension': 'تفعيل الإضافة',
  'Uninstall Extension': 'إلغاء تثبيت الإضافة',
  'Select Scope': 'اختر النطاق',
  'User Scope': 'نطاق المستخدم',
  'Workspace Scope': 'نطاق مساحة العمل',
  'No extensions found.': 'لم يتم العثور على إضافات.',
  'Updating...': 'جارٍ التحديث...',
  Unknown: 'غير معروف',
  Error: 'خطأ',
  'Stopped because': 'توقف بسبب',
  'Version:': 'الإصدار:',
  'Status:': 'الحالة:',
  'Are you sure you want to uninstall extension "{{name}}"?':
    'هل أنت متأكد أنك تريد إلغاء تثبيت الإضافة "{{name}}"؟',
  'This action cannot be undone.': 'لا يمكن التراجع عن هذا الإجراء.',
  'Extension "{{name}}" updated successfully.':
    'تم تحديث الإضافة "{{name}}" بنجاح.',
  'Name:': 'الاسم:',
  'MCP Servers:': 'خوادم MCP:',
  'Settings:': 'الإعدادات:',
  active: 'نشط',
  disabled: 'معطّل',
  enabled: 'مفعّل',
  'disabled (bare mode)': 'معطّل (الوضع المجرد)',
  'disabled (safe mode)': 'معطّل (الوضع الآمن)',
  'disabled (disableAllHooks)': 'معطّل (disableAllHooks)',
  'disabled (not approved)': 'معطّل (غير معتمد)',
  'disabled (rejected)': 'معطّل (مرفوض)',
  'disabled (folder not trusted)': 'معطّل (المجلد غير موثوق)',
  'disabled (turned off for this session)': 'معطّل (موقف لهذه الجلسة)',
  'View Details': 'عرض التفاصيل',
  'Update failed:': 'فشل التحديث:',
  'Updating {{name}}...': 'جارٍ تحديث {{name}}...',
  'Update complete!': 'اكتمل التحديث!',
  'User (global)': 'المستخدم (عام)',
  'Workspace (project-specific)': 'مساحة العمل (خاص بالمشروع)',
  'Disable "{{name}}" - Select Scope': 'تعطيل "{{name}}" - اختر النطاق',
  'Enable "{{name}}" - Select Scope': 'تفعيل "{{name}}" - اختر النطاق',
  'No extension selected': 'لم يتم تحديد إضافة',
  '{{count}} extensions installed': '{{count}} إضافات مثبّتة',
  "Use '/extensions install' to install your first extension.":
    "استخدم '/extensions install' لتثبيت إضافتك الأولى.",
  'up to date': 'محدّث',
  'update available': 'يتوفر تحديث',
  'checking...': 'جارٍ التحقق...',
  'not updatable': 'غير قابل للتحديث',
  error: 'خطأ',

  // ============================================================================
  // Commands - General (continued) & Settings Labels
  // ============================================================================
  'View and edit Qwen Code settings': 'عرض وتعديل إعدادات Qwen Code',
  Settings: 'الإعدادات',
  'To see changes, Qwen Code must be restarted. Press r to exit and apply changes now.':
    'لرؤية التغييرات، يجب إعادة تشغيل Qwen Code. اضغط r للخروج وتطبيق التغييرات الآن.',
  'Code Mode Only (Experimental)': 'وضع الكود فقط (تجريبي)',
  'Mods (Experimental)': 'التعديلات Mods (تجريبي)',
  'Enable experimental Mods from enabled extensions in trusted local terminal, headless and ACP sessions. Restart required.':
    'تفعيل Mods التجريبية من الإضافات المفعّلة في جلسات الطرفية المحلية الموثوقة والجلسات غير التفاعلية وجلسات ACP. يتطلب إعادة التشغيل.',
  'Vim Mode': 'وضع Vim',
  'Attribution: commit': 'الإسناد: commit',
  'Terminal Bell Notification': 'إشعار جرس الطرفية',
  'Enable Usage Statistics': 'تفعيل إحصائيات الاستخدام',
  Theme: 'السمة',
  'Preferred Editor': 'المحرر المفضّل',
  'Auto-connect to IDE': 'الاتصال التلقائي بـ IDE',
  'Debug Keystroke Logging': 'تسجيل ضغطات المفاتيح للتنقيح',
  'Language: UI': 'اللغة: الواجهة',
  'Language: Model': 'اللغة: النموذج',
  'Output Format': 'تنسيق المخرجات',
  'Hide Window Title': 'إخفاء عنوان النافذة',
  'Show Status in Title': 'عرض الحالة في العنوان',
  'Hide Tips': 'إخفاء التلميحات',
  'Show Tool Call Arguments': 'عرض وسائط استدعاء الأدوات',
  'Show Line Numbers in Code': 'عرض أرقام الأسطر في الكود',
  'Show Citations': 'عرض الاستشهادات',
  'Custom Witty Phrases': 'عبارات انتظار مخصصة',
  'Show Welcome Back Dialog': 'عرض نافذة الترحيب بالعودة',
  'Enable User Feedback': 'تفعيل ملاحظات المستخدم',
  'How is Qwen doing this session? (optional)':
    'كيف كان أداء Qwen في هذه الجلسة؟ (اختياري)',
  Bad: 'سيئ',
  Fine: 'لا بأس',
  Good: 'جيد',
  Dismiss: 'تجاهل',
  'Screen Reader Mode': 'وضع قارئ الشاشة',
  'Max Session Turns': 'الحد الأقصى لجولات الجلسة',
  'Skip Next Speaker Check': 'تخطي فحص المتحدث التالي',
  'Skip Loop Detection': 'تخطي اكتشاف الحلقات',
  'Skip Startup Context': 'تخطي سياق البدء',
  'Enable OpenAI Logging': 'تفعيل سجل OpenAI',
  'OpenAI Logging Directory': 'مجلد سجل OpenAI',
  Timeout: 'المهلة',
  'Max Retries': 'الحد الأقصى لإعادة المحاولة',
  'Load Memory From Include Directories': 'تحميل الذاكرة من المجلدات المضمنة',
  'Respect .gitignore': 'احترام .gitignore',
  'Respect .qwenignore': 'احترام .qwenignore',
  'Enable Recursive File Search': 'تفعيل البحث المتكرر عن الملفات',
  'Interactive Shell (PTY)': 'الطرفية التفاعلية (PTY)',
  'Show Color': 'عرض الألوان',
  'Auto Accept': 'القبول التلقائي',
  'Use Ripgrep': 'استخدام Ripgrep',
  'Use Builtin Ripgrep': 'استخدام Ripgrep المدمج',
  'Tool Output Truncation Threshold': 'حد اقتطاع مخرجات الأداة',
  'Tool Output Truncation Lines': 'أسطر اقتطاع مخرجات الأداة',
  'Folder Trust': 'موثوقية المجلد',
  'Tool Schema Compliance': 'الالتزام بمخطط الأدوات',
  Unset: 'غير مضبوط',
  'Auto (detect from system)': 'تلقائي (كشف من النظام)',
  'Auto (follow user input)': 'تلقائي (اتباع لغة إدخال المستخدم)',
  'Auto (detect terminal theme)': 'تلقائي (كشف سمة الطرفية)',
  Auto: 'تلقائي',
  Text: 'نص',
  JSON: 'JSON',
  Plan: 'خطة',
  'Ask permissions': 'طلب الأذونات',
  'Auto Edit': 'تعديل تلقائي',
  YOLO: 'YOLO',
  'toggle vim mode on/off': 'تبديل وضع vim تشغيل/إيقاف',
  'Show usage statistics dashboard.': 'عرض لوحة إحصائيات الاستخدام.',
  'Show model-specific usage statistics.':
    'عرض إحصائيات الاستخدام حسب النموذج.',
  'Show tool-specific usage statistics.': 'عرض إحصائيات الاستخدام حسب الأداة.',
  'Show skill-specific usage statistics.':
    'عرض إحصائيات الاستخدام حسب المهارة.',
  'Show daily token usage statistics.': 'عرض إحصائيات استهلاك الرموز اليومية.',
  'Show monthly token usage statistics.':
    'عرض إحصائيات استهلاك الرموز الشهرية.',
  'Export token usage statistics to CSV or JSON.':
    'تصدير إحصائيات استهلاك الرموز إلى CSV أو JSON.',
  'No usage data.': 'لا توجد بيانات استخدام.',
  '{{label}}: {{tokens}} tokens ({{requests}} requests)':
    '{{label}}: {{tokens}} رمز ({{requests}} طلب)',
  'Daily token usage for {{value}}': 'استهلاك الرموز اليومي لـ {{value}}',
  'Monthly token usage for {{value}}': 'استهلاك الرموز الشهري لـ {{value}}',
  'Total: {{tokens}} tokens': 'الإجمالي: {{tokens}} رمز',
  'Requests: {{requests}}': 'الطلبات: {{requests}}',
  'Breakdown:': 'التفصيل:',
  'Input: {{tokens}}': 'الإدخال: {{tokens}}',
  'Output: {{tokens}}': 'المخرجات: {{tokens}}',
  'Cached (included in Input): {{tokens}}':
    'مخبأ (مشمول في الإدخال): {{tokens}}',
  'Thoughts: {{tokens}}': 'الأفكار: {{tokens}}',
  'By model:': 'حسب النموذج:',
  'By auth type:': 'حسب نوع المصادقة:',
  'By model/auth type:': 'حسب النموذج/نوع المصادقة:',
  'By source:': 'حسب المصدر:',
  'Failed to load token usage stats: {{error}}':
    'فشل تحميل إحصائيات استهلاك الرموز: {{error}}',
  'Expected --format csv or --format json.':
    'يُتوقع --format csv أو --format json.',
  'Expected a file path after --output.': 'يُتوقع مسار ملف بعد --output.',
  'Unexpected argument: {{argument}}': 'وسيط غير متوقع: {{argument}}',
  'Usage: /stats export <daily|monthly> [YYYY-MM-DD|YYYY-MM] [--format csv|json] [--output path]':
    'الاستخدام: /stats export <daily|monthly> [YYYY-MM-DD|YYYY-MM] [--format csv|json] [--output path]',
  'Token usage export path must be within the project working directory.':
    'يجب أن يكون مسار تصدير إحصائيات الرموز ضمن مجلد عمل المشروع.',
  'Export target does not exist: {{path}}': 'وجهة التصدير غير موجودة: {{path}}',
  'Cannot resolve export path within the working directory.':
    'تعذّر تحليل مسار التصدير ضمن مجلد العمل.',
  'Could not create a temporary export file.': 'تعذّر إنشاء ملف تصدير مؤقت.',
  'Token usage exported to {{format}}: {{path}}':
    'تم تصدير استهلاك الرموز إلى {{format}}: {{path}}',
  'Failed to export token usage stats: {{error}}':
    'فشل تصدير إحصائيات استهلاك الرموز: {{error}}',
  'Unclosed quote in arguments.': 'علامة اقتباس غير مغلقة في الوسائط.',
  'Note: generation timing (TTFT/TPS) belongs to generation metrics.':
    'ملاحظة: توقيت التوليد (TTFT/TPS) يندرج ضمن مقاييس التوليد.',
  'exit the cli': 'الخروج من واجهة سطر الأوامر',
  'Manage workspace directories': 'إدارة مجلدات مساحة العمل',
  'Add directories to the workspace. Use comma to separate multiple paths':
    'إضافة مجلدات إلى مساحة العمل. استخدم الفاصلة لفصل المسارات المتعددة',
  'Show all directories in the workspace': 'عرض جميع المجلدات في مساحة العمل',
  'set external editor preference': 'تعيين تفضيل المحرر الخارجي',
  'Select Editor': 'اختر المحرر',
  'Editor Preference': 'تفضيل المحرر',
  'These editors are currently supported. Please note that some editors cannot be used in sandbox mode.':
    'هذه المحررات مدعومة حاليًا. يُرجى ملاحظة أن بعض المحررات لا يمكن استخدامها في وضع العزل.',
  'Your preferred editor is:': 'محررك المفضّل هو:',
  'Manage extensions': 'إدارة الإضافات',
  'Manage installed extensions': 'إدارة الإضافات المثبّتة',
  'Disable an extension': 'تعطيل إضافة',
  'Enable an extension': 'تفعيل إضافة',
  'Install an extension from a git repo or local path':
    'تثبيت إضافة من مستودع git أو مسار محلي',
  'Uninstall an extension': 'إلغاء تثبيت إضافة',
  'No extensions installed.': 'لا توجد إضافات مثبّتة.',
  'Extension "{{name}}" not found.': 'الإضافة "{{name}}" غير موجودة.',
  'The scope to install the extension in: "user" (global, default) or "project" (current workspace only).':
    'نطاق تثبيت الإضافة: "user" (عام، افتراضي) أو "project" (مساحة العمل الحالية فقط).',
  'Extension "{{name}}" installed successfully and enabled for the current workspace.':
    'تم تثبيت الإضافة "{{name}}" بنجاح وتفعيلها لمساحة العمل الحالية.',
  'Marketplace "{{name}}" not found.': 'المتجر "{{name}}" غير موجود.',
  'No marketplace sources added yet.': 'لم تتم إضافة مصادر متاجر بعد.',
  'No marketplaces added yet.': 'لم تتم إضافة متاجر بعد.',
  'Adds a marketplace source (Claude format).':
    'يضيف مصدر متجر (بتنسيق Claude).',
  'The marketplace source to add: owner/repo (GitHub), a git or https URL, or a local path.':
    'مصدر المتجر المراد إضافته: owner/repo (على GitHub)، أو رابط git أو https، أو مسار محلي.',
  'Removes a marketplace source.': 'يزيل مصدر متجر.',
  'The name of the marketplace to remove.': 'اسم المتجر المراد إزالته.',
  'Lists configured marketplace sources.': 'يسرد مصادر المتاجر المهيّأة.',
  'Re-fetches a marketplace source and its plugin listing.':
    'يعيد جلب مصدر المتجر وقائمة إضافاته.',
  'The name of the marketplace to update.': 'اسم المتجر المراد تحديثه.',
  'Manage marketplace sources for discovering extensions.':
    'إدارة مصادر المتاجر لاكتشاف الإضافات.',
  'You need at least one command before continuing.':
    'تحتاج إلى أمر واحد على الأقل قبل المتابعة.',
  'No extensions to update.': 'لا توجد إضافات للتحديث.',
  'Usage: /extensions install <source>':
    'الاستخدام: /extensions install <source>',
  'Installing extension from "{{source}}"...':
    'جارٍ تثبيت الإضافة من "{{source}}"...',
  'Extension "{{name}}" installed successfully.':
    'تم تثبيت الإضافة "{{name}}" بنجاح.',
  'Failed to install extension from "{{source}}": {{error}}':
    'فشل تثبيت الإضافة من "{{source}}": {{error}}',
  'Do you want to continue? [Y/n]: ': 'هل تريد المتابعة؟ [Y/n]: ',
  'Do you want to continue?': 'هل تريد المتابعة؟',
  'Installing extension "{{name}}".': 'جارٍ تثبيت الإضافة "{{name}}".',
  '**Extensions may introduce unexpected behavior. Ensure you have investigated the extension source and trust the author.**':
    '**قد تُدخل الإضافات سلوكًا غير متوقع. تأكّد من فحص مصدر الإضافة والوثوق بمؤلفها.**',
  'This extension will run the following MCP servers:':
    'ستُشغّل هذه الإضافة خوادم MCP التالية:',
  local: 'محلي',
  remote: 'بعيد',
  'This extension will add the following commands: {{commands}}.':
    'ستضيف هذه الإضافة الأوامر التالية: {{commands}}.',
  'This extension will append info to your QWEN.md context using {{fileName}}':
    'ستُلحق هذه الإضافة معلومات بسياق QWEN.md الخاص بك باستخدام {{fileName}}',
  'This extension will install the following skills:':
    'ستثبّت هذه الإضافة المهارات التالية:',
  'This extension will install the following subagents:':
    'ستثبّت هذه الإضافة الوكلاء الفرعيين التاليين:',
  'This extension will install the following workflows (JavaScript scripts that can start subagents):':
    'ستثبّت هذه الإضافة مسارات العمل التالية (نصوص JavaScript برمجية يمكنها بدء وكلاء فرعيين):',
  'These workflow scripts changed since the installed version: {{names}}.':
    'تغيّرت نصوص مسارات العمل هذه منذ الإصدار المثبّت: {{names}}.',
  'Installation cancelled for "{{name}}".': 'تم إلغاء التثبيت لـ "{{name}}".',
  'You are installing an extension from {{originSource}}. Some features may not work perfectly with Qwen Code.':
    'أنت تثبّت إضافة من {{originSource}}. قد لا تعمل بعض الميزات بشكل مثالي مع Qwen Code.',
  '--ref and --auto-update are not applicable for marketplace extensions.':
    'الخياران --ref و --auto-update غير قابلين للتطبيق على إضافات المتاجر.',
  'Extension "{{name}}" installed successfully and enabled.':
    'تم تثبيت الإضافة "{{name}}" بنجاح وتفعيلها.',
  'The github URL, local path, or marketplace source (marketplace-url:plugin-name) of the extension to install.':
    'رابط GitHub، أو المسار المحلي، أو مصدر المتجر (marketplace-url:plugin-name) للإضافة المراد تثبيتها.',
  'The git ref to install from.': 'مرجع git المراد التثبيت منه.',
  '--registry is only applicable for npm extensions.':
    'الخيار --registry ينطبق فقط على إضافات npm.',
  'Custom npm registry URL (only for npm extensions).':
    'رابط سجل npm مخصص (لإضافات npm فقط).',
  '--ref is not applicable for npm extensions. Use @version suffix instead (e.g. @scope/package@1.2.0).':
    'الخيار --ref غير قابل للتطبيق على إضافات npm. استخدم لاحقة @version بدلاً من ذلك (مثلاً @scope/package@1.2.0).',
  'Installs an extension from a git repository URL, local path, scoped npm package (@scope/name), or claude marketplace (marketplace-url:plugin-name).':
    'يثبّت إضافة من رابط مستودع git، أو مسار محلي، أو حزمة npm ذات نطاق (@scope/name)، أو متجر Claude (marketplace-url:plugin-name).',
  Description: 'الوصف',
  'Delete Session': 'حذف الجلسة',
  'Enable auto-update for this extension.':
    'تفعيل التحديث التلقائي لهذه الإضافة.',
  'Enable pre-release versions for this extension.':
    'تفعيل الإصدارات التجريبية لهذه الإضافة.',
  'Acknowledge the security risks of installing an extension and skip the confirmation prompt.':
    'الإقرار بالمخاطر الأمنية لتثبيت الإضافة وتخطي مطالبة التأكيد.',
  'The source argument must be provided.': 'يجب توفير وسيط المصدر.',
  'Extension "{{name}}" successfully uninstalled.':
    'تم إلغاء تثبيت الإضافة "{{name}}" بنجاح.',
  'Uninstalls an extension.': 'يلغي تثبيت إضافة.',
  'The name or source path of the extension to uninstall.':
    'اسم الإضافة أو مسار مصدرها المراد إلغاء تثبيتها.',
  'Please include the name of the extension to uninstall as a positional argument.':
    'يُرجى تضمين اسم الإضافة المراد إلغاء تثبيتها كوسيط موضعي.',
  'Enables an extension.': 'يفعّل إضافة.',
  'The name of the extension to enable.': 'اسم الإضافة المراد تفعيلها.',
  'The scope to enable the extension in. If not set, will be enabled in all scopes.':
    'النطاق المراد تفعيل الإضافة فيه. إذا لم يُحدد، فستُفعّل في جميع النطاقات.',
  'Extension "{{name}}" successfully enabled for scope "{{scope}}".':
    'تم تفعيل الإضافة "{{name}}" بنجاح في النطاق "{{scope}}".',
  'Extension "{{name}}" successfully enabled in all scopes.':
    'تم تفعيل الإضافة "{{name}}" بنجاح في جميع النطاقات.',
  'Invalid scope: {{scope}}. Please use one of {{scopes}}.':
    'نطاق غير صالح: {{scope}}. يُرجى استخدام أحد القيم: {{scopes}}.',
  'Disables an extension.': 'يعطّل إضافة.',
  'The name of the extension to disable.': 'اسم الإضافة المراد تعطيلها.',
  'The scope to disable the extension in.': 'النطاق المراد تعطيل الإضافة فيه.',
  'Extension "{{name}}" successfully disabled for scope "{{scope}}".':
    'تم تعطيل الإضافة "{{name}}" بنجاح في النطاق "{{scope}}".',
  'Extension "{{name}}" successfully updated: {{oldVersion}} → {{newVersion}}.':
    'تم تحديث الإضافة "{{name}}" بنجاح: {{oldVersion}} → {{newVersion}}.',
  'Unable to install extension "{{name}}" due to missing install metadata':
    'تعذّر تثبيت الإضافة "{{name}}" بسبب نقص بيانات التثبيت الوصفية',
  'Extension "{{name}}" is already up to date.':
    'الإضافة "{{name}}" محدّثة بالفعل.',
  'Updates all extensions or a named extension to the latest version.':
    'يحدّث جميع الإضافات أو إضافة محددة إلى أحدث إصدار.',
  'Update all extensions.': 'تحديث جميع الإضافات.',
  'The name of the extension to update.': 'اسم الإضافة المراد تحديثها.',
  'Either an extension name or --all must be provided':
    'يجب توفير اسم إضافة أو --all',
  'List installed extensions': 'سرد الإضافات المثبّتة',
  'Lists installed extensions.': 'يسرد الإضافات المثبّتة.',
  'Path:': 'المسار:',
  'Source:': 'المصدر:',
  'Type:': 'النوع:',
  'Ref:': 'المرجع:',
  'Release tag:': 'وسم الإصدار:',
  'Enabled (User):': 'مفعّل (المستخدم):',
  'Enabled (Workspace):': 'مفعّل (مساحة العمل):',
  'Context files:': 'ملفات السياق:',
  'Skills:': 'المهارات:',
  'Agents:': 'الوكلاء:',
  'Workflows:': 'مسارات العمل:',
  'MCP servers:': 'خوادم MCP:',
  'Link extension failed to install.': 'فشل تثبيت الإضافة المرتبطة.',
  'Extension "{{name}}" linked successfully and enabled.':
    'تم ربط الإضافة "{{name}}" وتفعيلها بنجاح.',
  'Links an extension from a local path. Updates made to the local path will always be reflected.':
    'يربط إضافة من مسار محلي. ستنعكس التحديثات على المسار المحلي دائمًا.',
  'The name of the extension to link.': 'اسم الإضافة المراد ربطها.',
  'Set a specific setting for an extension.': 'تعيين إعداد محدد لإضافة.',
  'Name of the extension to configure.': 'اسم الإضافة المراد تهيئتها.',
  'The setting to configure (name or env var).':
    'الإعداد المراد تهيئته (الاسم أو متغير البيئة).',
  'The scope to set the setting in.': 'النطاق المراد ضبط الإعداد فيه.',
  'List all settings for an extension.': 'سرد جميع إعدادات إضافة.',
  'Name of the extension.': 'اسم الإضافة.',
  'Extension "{{name}}" has no settings to configure.':
    'لا تحتوي الإضافة "{{name}}" على إعدادات لتهيئتها.',
  'Settings for "{{name}}":': 'إعدادات "{{name}}":',
  '(workspace)': '(مساحة العمل)',
  '(user)': '(المستخدم)',
  '[not set]': '[غير مضبوط]',
  '[value stored in keychain]': '[قيمة مخزّنة في سلسلة المفاتيح]',
  'Value:': 'القيمة:',
  'Manage extension settings': 'إدارة إعدادات الإضافات',
  'Manage extension settings.': 'إدارة إعدادات الإضافات.',
  'You need to specify a command (set or list).':
    'تحتاج إلى تحديد أمر (set أو list).',

  // ============================================================================
  // Plugin Choice / Marketplace
  // ============================================================================
  'No plugins available in this marketplace.': 'لا تتوفر إضافات في هذا المتجر.',
  'Select a plugin to install from marketplace "{{name}}":':
    'اختر إضافة لتثبيتها من المتجر "{{name}}":',
  'Plugin selection cancelled.': 'تم إلغاء اختيار الإضافة.',
  'Select a plugin from "{{name}}"': 'اختر إضافة من "{{name}}"',
  'Use ↑↓ or j/k to navigate, Enter to select, Escape to cancel':
    'استخدم ↑↓ أو j/k للتنقل، Enter للاختيار، Escape للإلغاء',
  '{{count}} more above': '{{count}} أكثر بالأعلى',
  '{{count}} more below': '{{count}} أكثر بالأسفل',
  'manage IDE integration': 'إدارة تكامل IDE',
  'check status of IDE integration': 'التحقق من حالة تكامل IDE',
  'install required IDE companion for {{ideName}}':
    'تثبيت ملحق IDE المطلوب لـ {{ideName}}',
  'enable IDE integration': 'تفعيل تكامل IDE',
  'disable IDE integration': 'تعطيل تكامل IDE',
  'IDE integration is not supported in your current environment. To use this feature, run Qwen Code in one of these supported IDEs: VS Code or VS Code forks.':
    'تكامل IDE غير مدعوم في بيئتك الحالية. لاستخدام هذه الميزة، شغّل Qwen Code داخل أحد محررات IDE المدعومة: VS Code أو مشتقات VS Code.',
  'Set up GitHub Actions': 'إعداد GitHub Actions',
  'Configure terminal keybindings for multiline input (VS Code, Cursor, Windsurf, Trae)':
    'تهيئة اختصارات الطرفية للإدخال متعدد الأسطر (VS Code, Cursor, Windsurf, Trae)',
  'Please restart your terminal for the changes to take effect.':
    'يُرجى إعادة تشغيل الطرفية لتطبيق التغييرات.',
  'Failed to configure terminal: {{error}}': 'فشلت تهيئة الطرفية: {{error}}',
  'Could not determine {{terminalName}} config path on Windows: APPDATA environment variable is not set.':
    'تعذّر تحديد مسار إعدادات {{terminalName}} على Windows: متغير البيئة APPDATA غير مضبوط.',
  '{{terminalName}} keybindings.json exists but is not a valid JSON array. Please fix the file manually or delete it to allow automatic configuration.':
    'الملف keybindings.json لـ {{terminalName}} موجود لكنه ليس مصفوفة JSON صالحة. يُرجى إصلاح الملف يدويًا أو حذفه للسماح بالتهيئة التلقائية.',
  'File: {{file}}': 'الملف: {{file}}',
  'Failed to parse {{terminalName}} keybindings.json. The file contains invalid JSON. Please fix the file manually or delete it to allow automatic configuration.':
    'فشل تحليل keybindings.json لـ {{terminalName}}. يحتوي الملف على JSON غير صالح. يُرجى إصلاح الملف يدويًا أو حذفه للسماح بالتهيئة التلقائية.',
  'Error: {{error}}': 'خطأ: {{error}}',
  'Shift+Enter binding already exists': 'اختصار Shift+Enter موجود بالفعل',
  'Ctrl+Enter binding already exists': 'اختصار Ctrl+Enter موجود بالفعل',
  'Existing keybindings detected. Will not modify to avoid conflicts.':
    'تم اكتشاف اختصارات مفاتيح حالية. لن يتم التعديل لتجنب التعارض.',
  'Please check and modify manually if needed: {{file}}':
    'يُرجى التحقق والتعديل يدويًا عند الحاجة: {{file}}',
  'Added Shift+Enter and Ctrl+Enter keybindings to {{terminalName}}.':
    'تمت إضافة اختصارات Shift+Enter و Ctrl+Enter إلى {{terminalName}}.',
  'Modified: {{file}}': 'تم تعديل: {{file}}',
  '{{terminalName}} keybindings already configured.':
    'اختصارات {{terminalName}} مهيّأة بالفعل.',
  'Failed to configure {{terminalName}}.': 'فشلت تهيئة {{terminalName}}.',
  'Your terminal is already configured for an optimal experience with multiline input (Shift+Enter and Ctrl+Enter).':
    'طرفيتك مهيّأة بالفعل لتجربة مثالية مع الإدخال متعدد الأسطر (Shift+Enter و Ctrl+Enter).',

  // ============================================================================
  // Commands - Hooks
  // ============================================================================
  'Manage Qwen Code hooks': 'إدارة خطافات (hooks) Qwen Code',
  'List all configured hooks': 'سرد جميع الخطافات المهيّأة',
  Hooks: 'الخطافات (Hooks)',
  'Loading hooks...': 'جارٍ تحميل الخطافات...',
  'Error loading hooks:': 'خطأ في تحميل الخطافات:',
  'Press Escape to close': 'اضغط Escape للإغلاق',
  'Press Escape, Ctrl+C, or Ctrl+D to cancel':
    'اضغط Escape أو Ctrl+C أو Ctrl+D للإلغاء',
  'Press Space, Enter, or Escape to dismiss':
    'اضغط Space أو Enter أو Escape للإغلاق',
  'No hook selected': 'لم يتم تحديد خطاف',
  'No hook events found.': 'لم يتم العثور على أحداث خطافات.',
  '{{count}} hook configured': '{{count}} خطاف مهيّأ',
  '{{count}} hooks configured': '{{count}} خطافات مهيّأة',
  'This menu is read-only. To add or modify hooks, edit settings.json directly or ask Qwen Code.':
    'هذه القائمة للقراءة فقط. لإضافة الخطافات أو تعديلها، عدّل settings.json مباشرة أو اطلب من Qwen Code.',
  'Reopen this menu to reload hook definitions.':
    'أعد فتح هذه القائمة لإعادة تحميل تعريفات الخطافات.',
  'Hook controls and HTTP security settings require a restart.':
    'تتطلب ضوابط الخطافات وإعدادات أمان HTTP إعادة التشغيل.',
  'Failed to reload hook definitions: {{error}}':
    'فشل إعادة تحميل تعريفات الخطافات: {{error}}',
  'Enter to select · Esc to cancel': 'Enter للاختيار · Esc للإلغاء',
  'Exit codes:': 'رموز الخروج:',
  'Configured hooks:': 'الخطافات المهيّأة:',
  'No hooks configured for this event.': 'لا توجد خطافات مهيّأة لهذا الحدث.',
  'To add hooks, edit settings.json directly or ask Qwen.':
    'لإضافة خطافات، عدّل settings.json مباشرة أو اطلب من Qwen.',
  'Enter to select · Esc to go back': 'Enter للاختيار · Esc للعودة',
  'Hook details': 'تفاصيل الخطاف',
  'Event:': 'الحدث:',
  'Extension:': 'الإضافة:',
  'Desc:': 'الوصف:',
  'No hook config selected': 'لم يتم تحديد إعداد خطاف',
  'To modify or remove this hook, edit settings.json directly or ask Qwen to help.':
    'لتعديل هذا الخطاف أو إزالته، عدّل settings.json مباشرة أو اطلب المساعدة من Qwen.',
  'Safe mode is on, so no hooks run in this session.':
    'الوضع الآمن قيد التشغيل، لذا لن تعمل أي خطافات في هذه الجلسة.',
  'Bare mode is on, so no hooks run in this session.':
    'الوضع المجرد قيد التشغيل، لذا لن تعمل أي خطافات في هذه الجلسة.',
  'All hooks are disabled by the disableAllHooks setting.':
    'جميع الخطافات معطّلة بواسطة إعداد disableAllHooks.',
  'Timeout:': 'المهلة:',
  'Status message:': 'رسالة الحالة:',
  'Condition:': 'الشرط:',
  'Options:': 'الخيارات:',
  'Skill:': 'المهارة:',
  'runs in background': 'يعمل في الخلفية',
  'runs once': 'يعمل مرة واحدة',
  sequential: 'متسلسل',
  'Hook Configuration - Disabled': 'إعدادات الخطافات - معطّلة',
  'All hooks are currently disabled. You have {{count}} that are not running.':
    'جميع الخطافات معطّلة حاليًا. لديك {{count}} لا تعمل.',
  '{{count}} configured hook': '{{count}} خطاف مهيّأ',
  '{{count}} configured hooks': '{{count}} خطافات مهيّأة',
  'When hooks are disabled:': 'عندما تكون الخطافات معطّلة:',
  'No hook commands will execute': 'لن يتم تنفيذ أي أوامر خطافات',
  'StatusLine will not be displayed': 'لن يتم عرض StatusLine',
  'Tool operations will proceed without hook validation':
    'ستستمر عمليات الأدوات دون التحقق عبر الخطافات',
  'To re-enable hooks, remove "disableAllHooks" from settings.json or ask Qwen Code.':
    'لإعادة تفعيل الخطافات، أزل "disableAllHooks" من settings.json أو اطلب من Qwen Code.',
  Project: 'المشروع',
  User: 'المستخدم',
  Skill: 'المهارة',
  System: 'النظام',
  Extension: 'الإضافة',
  'Local Settings': 'الإعدادات المحلية',
  'User Settings': 'إعدادات المستخدم',
  'System Settings': 'إعدادات النظام',
  Extensions: 'الإضافات',
  'Session (temporary)': 'الجلسة (مؤقت)',
  'Before tool execution': 'قبل تنفيذ الأداة',
  'After tool execution': 'بعد تنفيذ الأداة',
  'After tool execution fails': 'بعد فشل تنفيذ الأداة',
  'When notifications are sent': 'عند إرسال الإشعارات',
  'When the user submits a prompt': 'عند إرسال المستخدم لمطالبة',
  'When a slash command expands into a prompt':
    'عند توسعة أمر مائل (slash) إلى مطالبة',
  'When a new session is started': 'عند بدء جلسة جديدة',
  'Right before Qwen Code concludes its response':
    'قبيل إنهاء Qwen Code لاستجابته مباشرة',
  'When a subagent (Agent tool call) is started':
    'عند بدء وكيل فرعي (استدعاء أداة Agent)',
  'Right before a subagent concludes its response':
    'قبيل إنهاء الوكيل الفرعي لاستجابته مباشرة',
  'Before conversation compaction': 'قبل ضغط المحادثة',
  'When a session is ending': 'عند انتهاء الجلسة',
  'When a permission dialog is displayed': 'عند عرض نافذة طلب الإذن',
  'When a new todo item is created': 'عند إنشاء عنصر مهام جديد',
  'When a todo item is marked as completed': 'عند تعليم عنصر مهام كمكتمل',
  'Input to command is JSON of tool call arguments.':
    'مدخل الأمر هو JSON لوسائط استدعاء الأداة.',
  'Input to command is JSON with fields "inputs" (tool call arguments) and "response" (tool call response).':
    'مدخل الأمر هو JSON يحتوي على الحقلين "inputs" (وسائط استدعاء الأداة) و "response" (استجابة الأداة).',
  'Input to command is JSON with tool_name, tool_input, tool_use_id, error, error_type, is_interrupt, and is_timeout.':
    'مدخل الأمر هو JSON يحتوي على tool_name و tool_input و tool_use_id و error و error_type و is_interrupt و is_timeout.',
  'Input to command is JSON with notification message and type.':
    'مدخل الأمر هو JSON يحتوي على رسالة الإشعار ونوعه.',
  'Input to command is JSON with "prompt" (the current model-bound prompt) and optional "submitted_prompt" (the text projection captured at a supported submission boundary).':
    'مدخل الأمر هو JSON يحتوي على "prompt" (المطالبة الحالية الموجهة للنموذج) واختياريًا "submitted_prompt" (النص الملتقط عند حد الإرسال المدعوم).',
  'Input to command is JSON with command_name, command_args, and expanded prompt text.':
    'مدخل الأمر هو JSON يحتوي على command_name و command_args ونص المطالبة الموسّع.',
  'Input to command is JSON with session start source.':
    'مدخل الأمر هو JSON يحتوي على مصدر بدء الجلسة.',
  'Input to command is JSON with session end reason.':
    'مدخل الأمر هو JSON يحتوي على سبب انتهاء الجلسة.',
  'Input to command is JSON with agent_id and agent_type.':
    'مدخل الأمر هو JSON يحتوي على agent_id و agent_type.',
  'Input to command is JSON with agent_id, agent_type, and agent_transcript_path.':
    'مدخل الأمر هو JSON يحتوي على agent_id و agent_type و agent_transcript_path.',
  'Input to command is JSON with compaction details.':
    'مدخل الأمر هو JSON يحتوي على تفاصيل الضغط.',
  'Input to command is JSON with tool_name, tool_input, and tool_use_id. Output JSON with hookSpecificOutput containing decision to allow or deny.':
    'مدخل الأمر هو JSON يحتوي على tool_name و tool_input و tool_use_id. المخرج JSON يحتوي على hookSpecificOutput بقرار السماح أو الرفض.',
  'Input to command is JSON with todo_id, todo_content, todo_status, all_todos, and phase. In validation, output JSON with decision (allow/block/deny) and reason. In postWrite, block/deny is ignored.':
    'مدخل الأمر هو JSON يحتوي على todo_id و todo_content و todo_status و all_todos و phase. في التحقق، أخرج JSON مع decision (allow/block/deny) و reason. في postWrite، يتم تجاهل block/deny.',
  'Input to command is JSON with todo_id, todo_content, previous_status, all_todos, and phase. In validation, output JSON with decision (allow/block/deny) and reason. In postWrite, block/deny is ignored.':
    'مدخل الأمر هو JSON يحتوي على todo_id و todo_content و previous_status و all_todos و phase. في التحقق، أخرج JSON مع decision (allow/block/deny) و reason. في postWrite، يتم تجاهل block/deny.',
  'stdout/stderr not shown': 'لا يُعرض stdout/stderr',
  'show stderr to model and continue conversation':
    'عرض stderr للنموذج ومتابعة المحادثة',
  'show stderr to user only': 'عرض stderr للمستخدم فقط',
  'stdout shown in transcript mode (ctrl+o)':
    'يُعرض stdout في وضع السجل (ctrl+o)',
  'show stderr to model immediately': 'عرض stderr للنموذج فورًا',
  'show stderr to user only but continue with tool call':
    'عرض stderr للمستخدم فقط مع متابعة استدعاء الأداة',
  'block processing, erase original prompt, and show stderr to user only':
    'حظر المعالجة، ومسح المطالبة الأصلية، وعرض stderr للمستخدم فقط',
  'block expanded prompt submission and show stderr to user only':
    'حظر إرسال المطالبة الموسّعة وعرض stderr للمستخدم فقط',
  'stdout shown to Qwen': 'يُعرض stdout لـ Qwen',
  'show stderr to user only (blocking errors ignored)':
    'عرض stderr للمستخدم فقط (تُتجاهل أخطاء الحظر)',
  'command completes successfully': 'يكتمل الأمر بنجاح',
  'stdout shown to subagent': 'يُعرض stdout للوكيل الفرعي',
  'show stderr to subagent and continue having it run':
    'عرض stderr للوكيل الفرعي والاستمرار في تشغيله',
  'stdout appended as custom compact instructions':
    'يُلحق stdout كتعليمات ضغط مخصصة',
  'block compaction': 'حظر الضغط',
  'show stderr to user only but continue with compaction':
    'عرض stderr للمستخدم فقط مع متابعة الضغط',
  'use hook decision if provided': 'استخدام قرار الخطاف إن وُجد',
  'allow todo creation': 'السماح بإنشاء مهمة',
  'block todo creation and show reason to model':
    'حظر إنشاء المهمة وعرض السبب للنموذج',
  'allow todo completion': 'السماح بإكمال المهمة',
  'block todo completion and show reason to model':
    'حظر إكمال المهمة وعرض السبب للنموذج',
  'Config not loaded.': 'لم يتم تحميل الإعدادات.',
  'Hooks are not enabled. Enable hooks in settings to use this feature.':
    'الخطافات غير مفعّلة. فعّل الخطافات في الإعدادات لاستخدام هذه الميزة.',

  // ============================================================================
  // Commands - Session Export & Insights & History
  // ============================================================================
  'Export current session message history to a file':
    'تصدير سجل رسائل الجلسة الحالية إلى ملف',
  'Export session to HTML format': 'تصدير الجلسة إلى تنسيق HTML',
  'Export session to JSON format': 'تصدير الجلسة إلى تنسيق JSON',
  'Export session to JSONL format (one message per line)':
    'تصدير الجلسة إلى تنسيق JSONL (رسالة واحدة في كل سطر)',
  'Export session to markdown format': 'تصدير الجلسة إلى تنسيق Markdown',
  'generate personalized programming insights from your chat history':
    'توليد رؤى برمجية مخصصة من سجل محادثاتك',
  'Resume a previous session': 'استئناف جلسة سابقة',
  'Fork the current conversation into a new session':
    'تفريع المحادثة الحالية إلى جلسة جديدة',
  'Spawn a background agent that inherits the full conversation':
    'تشغيل وكيل في الخلفية يرث المحادثة الكاملة',
  'Please provide a directive. Usage: /fork <directive>':
    'يُرجى تقديم توجيه. الاستخدام: /fork <directive>',
  'Cannot fork while a response or tool call is in progress. Wait for it to finish or resolve the pending tool call.':
    'لا يمكن التفريع أثناء استجابة أو استدعاء أداة قيد التنفيذ. انتظر حتى ينتهي أو تعامل مع استدعاء الأداة المعلّق.',
  'Cannot fork before the first conversation turn.':
    'لا يمكن التفريع قبل الجولة الأولى من المحادثة.',
  'The agent tool is unavailable; cannot fork.':
    'أداة الوكيل غير متاحة؛ لا يمكن التفريع.',
  'Failed to launch fork: {{error}}': 'فشل إطلاق التفريع: {{error}}',
  'the background agent could not be started.': 'تعذّر بدء الوكيل في الخلفية.',
  'User launched a background fork via /fork: {{directive}}':
    'أطلق المستخدم تفريعًا في الخلفية عبر /fork: {{directive}}',
  'Forked into a background agent. It inherits this conversation and runs without blocking — track it in the background tasks panel; it reports back when done.':
    'تم التفريع إلى وكيل في الخلفية. يرث هذه المحادثة ويعمل دون حجب — تابعه في لوحة مهام الخلفية؛ سيُبلغ عند الانتهاء.',
  'Cannot branch while a response or tool call is in progress. Wait for it to finish or resolve the pending tool call.':
    'لا يمكن التشعّب أثناء استجابة أو استدعاء أداة قيد التنفيذ. انتظر حتى ينتهي أو تعامل مع استدعاء الأداة المعلّق.',
  'No conversation to branch.': 'لا توجد محادثة للتشعّب.',
  'Restore a tool call. This will reset the conversation and file history to the state it was in when the tool call was suggested':
    'استعادة استدعاء أداة. سيعيد ذلك تعيين المحادثة وسجل الملفات إلى الحالة التي كانت عليها عند اقتراح الاستدعاء',
  'Could not detect terminal type. Supported terminals: VS Code, Cursor, Windsurf, and Trae.':
    'تعذّر اكتشاف نوع الطرفية. الطرفيات المدعومة: VS Code و Cursor و Windsurf و Trae.',
  'Terminal "{{terminal}}" is not supported yet.':
    'الطرفية "{{terminal}}" غير مدعومة بعد.',
  'Set history to collapse by default when resuming a session':
    'ضبط السجل ليكون مطويًا افتراضيًا عند استئناف جلسة',
  'Set history to expand by default when resuming a session':
    'ضبط السجل ليكون موسّعًا افتراضيًا عند استئناف جلسة',
  'Expand the currently collapsed history transcript':
    'توسيع سجل المحادثة المطوي حاليًا',
  'Control history display preferences and visibility':
    'التحكم في تفضيلات عرض السجل وإظهاره',
  'History will be collapsed by default for future resumed sessions.':
    'سيكون السجل مطويًا افتراضيًا للجلسات المستأنفة مستقبلاً.',
  'History will be expanded by default for future resumed sessions.':
    'سيكون السجل موسّعًا افتراضيًا للجلسات المستأنفة مستقبلاً.',
  'History is already expanded in this session.':
    'السجل موسّع بالفعل في هذه الجلسة.',
  'Usage: /history collapse-on-resume|expand-on-resume|expand-now':
    'الاستخدام: /history collapse-on-resume|expand-on-resume|expand-now',
  'History collapsed: {{n}} messages hidden. Use /history expand-now to show.':
    'السجل مطوي: تم إخفاء {{n}} رسالة. استخدم /history expand-now للعرض.',

  // ============================================================================
  // Commands - Language
  // ============================================================================
  'Invalid language. Available: {{options}}':
    'لغة غير صالحة. المتاح: {{options}}',
  'Language subcommands do not accept additional arguments.':
    'الأوامر الفرعية للغة لا تقبل وسائط إضافية.',
  'Current UI language: {{lang}}': 'لغة الواجهة الحالية: {{lang}}',
  'Current LLM output language: {{lang}}': 'لغة مخرجات LLM الحالية: {{lang}}',
  'Set UI language': 'تعيين لغة الواجهة',
  'Set LLM output language': 'تعيين لغة مخرجات LLM',
  'Usage: /language ui [{{options}}]': 'الاستخدام: /language ui [{{options}}]',
  'Usage: /language output <language>':
    'الاستخدام: /language output <language>',
  'Example: /language output 中文': 'مثال: /language output 中文',
  'Example: /language output English': 'مثال: /language output English',
  'Example: /language output 日本語': 'مثال: /language output 日本語',
  'UI language changed to {{lang}}': 'تم تغيير لغة الواجهة إلى {{lang}}',
  'LLM output language set to {{lang}}': 'تم تعيين لغة مخرجات LLM إلى {{lang}}',
  'Please restart the application for the changes to take effect.':
    'يُرجى إعادة تشغيل التطبيق لتطبيق التغييرات.',
  'Failed to generate LLM output language rule file: {{error}}':
    'فشل إنشاء ملف قاعدة لغة مخرجات LLM: {{error}}',
  'Invalid command. Available subcommands:':
    'أمر غير صالح. الأوامر الفرعية المتاحة:',
  'Available subcommands:': 'الأوامر الفرعية المتاحة:',
  'To request additional UI language packs, please open an issue on GitHub.':
    'لطلب حزم لغات واجهة إضافية، يُرجى فتح issue على GitHub.',
  'Available options:': 'الخيارات المتاحة:',
  'Set UI language to {{name}}': 'تعيين لغة الواجهة إلى {{name}}',

  // ============================================================================
  // Commands - Approval Mode, Memory, PR, MCP
  // ============================================================================
  'Tool Approval Mode': 'وضع الموافقة على الأدوات',
  'Analyze only, do not modify files or execute commands':
    'تحليل فقط، دون تعديل الملفات أو تنفيذ الأوامر',
  'Require approval for file edits or shell commands':
    'يتطلب موافقة لتعديلات الملفات أو أوامر Shell',
  'Automatically approve file edits': 'الموافقة التلقائية على تعديلات الملفات',
  'Use classifier to automatically approve safe tool calls':
    'استخدام المصنّف للموافقة التلقائية على استدعاءات الأدوات الآمنة',
  'Automatically approve all tools': 'الموافقة التلقائية على جميع الأدوات',
  'Workspace approval mode exists and takes priority. User-level change will have no effect.':
    'يوجد وضع موافقة لمساحة العمل وله الأولوية. لن يكون للتغيير على مستوى المستخدم أي تأثير.',
  'Apply To': 'تطبيق على',
  'Workspace Settings': 'إعدادات مساحة العمل',
  'Open auto-memory folder': 'فتح مجلد الذاكرة التلقائية',
  'Auto-memory: {{status}}': 'الذاكرة التلقائية: {{status}}',
  'Auto-dream: {{status}} · {{lastDream}} · /dream to run':
    'Auto-dream: {{status}} · {{lastDream}} · /dream للتشغيل',
  'Auto-skill: {{status}}': 'المهارات التلقائية: {{status}}',
  never: 'أبدًا',
  on: 'مفعّل',
  off: 'معطّل',
  'Remove matching entries from managed auto-memory.':
    'إزالة الإدخالات المطابقة من الذاكرة التلقائية المدارة.',
  'Usage: /forget <memory text to remove>':
    'الاستخدام: /forget <memory text to remove>',
  'No managed auto-memory entries matched: {{query}}':
    'لم تطابق أي إدخالات ذاكرة تلقائية مدارة: {{query}}',
  'Bind a GitHub pull request to this session':
    'ربط طلب سحب GitHub (PR) بهذه الجلسة',
  'Usage: /pr <number | url>': 'الاستخدام: /pr <number | url>',
  'No PRs bound to this session.': 'لا توجد طلبات سحب (PR) مرتبطة بهذه الجلسة.',
  'Bound PRs: {{list}}': 'طلبات السحب المرتبطة: {{list}}',
  'Invalid PR reference. Usage: /pr <number | url>':
    'مرجع طلب سحب غير صالح. الاستخدام: /pr <number | url>',
  'Could not resolve PR #{{number}} via gh. Pass the full PR URL instead.':
    'تعذّر تحليل طلب السحب #{{number}} عبر gh. مرّر رابط طلب السحب الكامل بدلاً من ذلك.',
  'Bound PR #{{number}} to this session: {{url}}':
    'تم ربط طلب السحب #{{number}} بهذه الجلسة: {{url}}',
  'PR #{{number}} is already bound to this session: {{url}}':
    'طلب السحب #{{number}} مرتبط بالفعل بهذه الجلسة: {{url}}',
  'Failed to bind PR #{{number}}.': 'فشل ربط طلب السحب #{{number}}.',
  'Failed to bind PR #{{number}}: {{message}}':
    'فشل ربط طلب السحب #{{number}}: {{message}}',
  'Could not read the PR bindings for this session.':
    'تعذّرت قراءة ارتباطات طلبات السحب لهذه الجلسة.',
  'GitHub CLI (gh) is unavailable or timed out. Pass the full PR URL to bind without it.':
    'أداة GitHub CLI (gh) غير متاحة أو انتهت مهلتها. مرّر رابط طلب السحب الكامل للربط بدونها.',
  'Consolidate managed auto-memory topic files.':
    'دمج ملفات موضوعات الذاكرة التلقائية المدارة.',
  'Import MCP servers from Claude configs':
    'استيراد خوادم MCP من إعدادات Claude',
  'Open MCP management dialog': 'فتح نافذة إدارة MCP',
  'Could not retrieve tool registry.': 'تعذّر استرجاع سجل الأدوات.',
  "Successfully authenticated and refreshed tools for '{{name}}'.":
    "تمت المصادقة وتحديث الأدوات بنجاح لـ '{{name}}'.",
  "Re-discovering tools from '{{name}}'...":
    "جارٍ إعادة اكتشاف الأدوات من '{{name}}'...",
  "Discovered {{count}} tool(s) from '{{name}}'.":
    "تم اكتشاف {{count}} أداة من '{{name}}'.",
  'Authentication complete. Returning to server details...':
    'اكتملت المصادقة. جارٍ العودة إلى تفاصيل الخادم...',
  'Authentication successful.': 'نجحت المصادقة.',
  'Manage MCP servers': 'إدارة خوادم MCP',
  'Server Detail': 'تفاصيل الخادم',
  Tools: 'الأدوات',
  'Tool Detail': 'تفاصيل الأداة',
  'Loading...': 'جارٍ التحميل...',
  'Unknown step': 'خطوة غير معروفة',
  'Esc to back': 'Esc للعودة',
  '↑↓ to navigate · Enter to select · Esc to close':
    '↑↓ للتنقل · Enter للاختيار · Esc للإغلاق',
  '↑↓ to navigate · Enter to select · Esc to back':
    '↑↓ للتنقل · Enter للاختيار · Esc للعودة',
  '↑↓ to navigate · Enter to confirm · Esc to back':
    '↑↓ للتنقل · Enter للتأكيد · Esc للعودة',
  'User Settings (global)': 'إعدادات المستخدم (عامة)',
  'Workspace Settings (project-specific)':
    'إعدادات مساحة العمل (خاصة بالمشروع)',
  'Disable server:': 'تعطيل الخادم:',
  'Select where to add the server to the exclude list:':
    'اختر مكان إضافة الخادم إلى قائمة الاستبعاد:',
  'Press Enter to confirm, Esc to cancel': 'اضغط Enter للتأكيد، Esc للإلغاء',
  'View tools': 'عرض الأدوات',
  'View resources': 'عرض الموارد',
  Reconnect: 'إعادة الاتصال',
  Enable: 'تفعيل',
  Disable: 'تعطيل',
  Authenticate: 'مصادقة',
  'Re-authenticate': 'إعادة المصادقة',
  'Clear Authentication': 'مسح المصادقة',
  'Server:': 'الخادم:',
  'Command:': 'الأمر:',
  'Working Directory:': 'مجلد العمل:',
  'No server selected': 'لم يتم تحديد خادم',
  prompts: 'مطالبات',
  'Error:': 'خطأ:',
  tool: 'أداة',
  tools: 'أدوات',
  resource: 'مورد',
  resources: 'موارد',
  connected: 'متصل',
  connecting: 'جارٍ الاتصال',
  disconnected: 'غير متصل',
  'needs authentication': 'يحتاج إلى مصادقة',
  'User MCPs': 'خوادم MCP للمستخدم',
  'Project MCPs': 'خوادم MCP للمشروع',
  'Extension MCPs': 'خوادم MCP للإضافات',
  server: 'خادم',
  servers: 'خوادم',
  'Add MCP servers to your settings to get started.':
    'أضف خوادم MCP إلى إعداداتك للبدء.',
  'Run qwen --debug to see error logs': 'شغّل qwen --debug لعرض سجلات الأخطاء',
  'OAuth Authentication': 'مصادقة OAuth',
  'Authenticating... Please complete the login in your browser.':
    'جارٍ المصادقة... يُرجى إكمال تسجيل الدخول في متصفحك.',
  'Press c to copy the authorization URL to your clipboard.':
    'اضغط c لنسخ رابط التفويض إلى الحافظة.',
  'Copy request sent to your terminal. If paste is empty, copy the URL above manually.':
    'تم إرسال طلب النسخ إلى طرفيتك. إذا كان اللصق فارغًا، انسخ الرابط أعلاه يدويًا.',
  'Cannot write to terminal — copy the URL above manually.':
    'لا يمكن الكتابة إلى الطرفية — انسخ الرابط أعلاه يدويًا.',
  'No tools available for this server.': 'لا توجد أدوات متاحة لهذا الخادم.',
  destructive: 'مُدمّر',
  'read-only': 'للقراءة فقط',
  'open-world': 'عالم مفتوح',
  idempotent: 'متكافئ التكرار',
  'Tools for {{serverName}}': 'أدوات {{serverName}}',
  '{{current}}/{{total}}': '{{current}}/{{total}}',
  required: 'مطلوب',
  Parameters: 'المعاملات',
  'No tool selected': 'لم يتم تحديد أداة',
  Server: 'الخادم',
  'No resources available for this server.': 'لا توجد موارد متاحة لهذا الخادم.',
  'Resources for {{serverName}}': 'موارد {{serverName}}',
  'No resource selected': 'لم يتم تحديد مورد',
  'Resource Detail': 'تفاصيل المورد',
  'URI:': 'URI:',
  'MIME Type:': 'نوع MIME:',
  'Size:': 'الحجم:',
  '{{count}} bytes': '{{count}} بايت',
  'Reference in chat': 'إشارة في المحادثة',
  'MCP server': 'خادم MCP',
  'MCP resource server': 'خادم موارد MCP',
  '{{count}} invalid tools': '{{count}} أدوات غير صالحة',
  invalid: 'غير صالح',
  'invalid: {{reason}}': 'غير صالح: {{reason}}',
  'missing name': 'الاسم مفقود',
  'missing description': 'الوصف مفقود',
  '(unnamed)': '(بدون اسم)',
  'Warning: This tool cannot be called by the LLM':
    'تحذير: لا يمكن لـ LLM استدعاء هذه الأداة',
  Reason: 'السبب',
  'Tools must have both name and description to be used by the LLM.':
    'يجب أن تحتوي الأدوات على الاسم والوصف معًا ليتمكن LLM من استخدامها.',

  // ============================================================================
  // Commands - Summary & Model
  // ============================================================================
  'Generate a project summary and save it to .qwen/PROJECT_SUMMARY.md':
    'توليد ملخص للمشروع وحفظه في .qwen/PROJECT_SUMMARY.md',
  'No chat client available to generate summary.':
    'لا يوجد عميل محادثة متاح لتوليد الملخص.',
  'Already generating summary, wait for previous request to complete':
    'جارٍ توليد الملخص بالفعل، انتظر اكتمال الطلب السابق',
  'No conversation found to summarize.': 'لم يتم العثور على محادثة لتلخيصها.',
  'Summary path already exists and is not a generated summary: {{path}}':
    'مسار الملخص موجود بالفعل وليس ملخصًا مولّدًا: {{path}}',
  'Summary path must be within the project root.':
    'يجب أن يكون مسار الملخص ضمن جذر المشروع.',
  'Summary path resolves to an existing directory: {{path}}':
    'يشير مسار الملخص إلى مجلد موجود: {{path}}',
  'Summary path ends with a separator but is an existing file: {{path}}':
    'ينتهي مسار الملخص بفاصل لكنه ملف موجود: {{path}}',
  'Failed to generate project context summary: {{error}}':
    'فشل توليد ملخص سياق المشروع: {{error}}',
  'Saved project summary to {{filePathForDisplay}}.':
    'تم حفظ ملخص المشروع في {{filePathForDisplay}}.',
  'Saving project summary...': 'جارٍ حفظ ملخص المشروع...',
  'Generating project summary...': 'جارٍ توليد ملخص المشروع...',
  'Processing summary...': 'جارٍ معالجة الملخص...',
  'Project summary generated and saved successfully!':
    'تم توليد ملخص المشروع وحفظه بنجاح!',
  'Saved to: {{filePath}}': 'تم الحفظ في: {{filePath}}',
  'Failed to generate summary - no text content received from LLM response':
    'فشل توليد الملخص - لم يتم استلام محتوى نصي من استجابة LLM',

  'Switch the model for this session (--fast for suggestion model, [model-id] to switch immediately).':
    'تبديل النموذج لهذه الجلسة (--fast لنموذج الاقتراحات، أو [model-id] للتبديل فورًا).',
  'Switch the model for this session (--fast for suggestion model, --voice for voice transcription model, [model-id] to switch immediately).':
    'تبديل النموذج لهذه الجلسة (--fast لنموذج الاقتراحات، --voice لنموذج التفريغ الصوتي، أو [model-id] للتبديل فورًا).',
  'Switch the model for this session (--fast for suggestion model, --voice for voice transcription model, --vision for the vision bridge model, --project to persist to project settings, --global to persist to user settings, [model-id] to switch immediately, or [model-id] [prompt] to run a one-off prompt on another model; the inline prompt is sent verbatim without @file expansion).':
    'تبديل النموذج لهذه الجلسة (--fast لنموذج الاقتراحات، --voice لنموذج التفريغ الصوتي، --vision لنموذج جسر الرؤية، --project للحفظ في إعدادات المشروع، --global للحفظ في إعدادات المستخدم، [model-id] للتبديل فورًا، أو [model-id] [prompt] لتشغيل مطالبة لمرة واحدة على نموذج آخر؛ تُرسل المطالبة المضمنة حرفيًا دون توسيع @file).',
  'Switch the model for this session (--fast for suggestion model, --voice for voice transcription model, --vision for the vision bridge model, --compaction for chat compression model, --image for the image generation model, --project to persist to project settings, --global to persist to user settings, [model-id] to switch immediately, or [model-id] [prompt] to run a one-off prompt on another model; the inline prompt is sent verbatim without @file expansion).':
    'تبديل النموذج لهذه الجلسة (--fast لنموذج الاقتراحات، --voice لنموذج التفريغ الصوتي، --vision لنموذج جسر الرؤية، --compaction لنموذج ضغط المحادثة، --image لنموذج توليد الصور، --project للحفظ في إعدادات المشروع، --global للحفظ في إعدادات المستخدم، [model-id] للتبديل فورًا، أو [model-id] [prompt] لتشغيل مطالبة لمرة واحدة على نموذج آخر؛ تُرسل المطالبة المضمنة حرفيًا دون توسيع @file).',
  "Inline one-shot override isn't supported in this mode — run '/model {{model}}' first, then send your prompt.":
    "التبديل المضمن لمرة واحدة غير مدعوم في هذا الوضع — شغّل '/model {{model}}' أولاً، ثم أرسل مطالبتك.",
  "Inline one-shot override can't switch providers. '{{model}}' belongs to a different provider — run '/model {{model}}' first, then send your prompt.":
    "لا يمكن للتبديل المضمن لمرة واحدة تغيير المزوّد. '{{model}}' يتبع مزوّدًا مختلفًا — شغّل '/model {{model}}' أولاً، ثم أرسل مطالبتك.",
  "⚠ '{{model}}' is not a known image-capable model; the vision bridge may fail on images.":
    "⚠ '{{model}}' ليس نموذجًا معروفًا يدعم الصور؛ قد يفشل جسر الرؤية مع الصور.",
  'Set a lighter model for prompt suggestions and speculative execution':
    'تعيين نموذج أخف لاقتراحات المطالبات والتنفيذ التخميني',
  'Toggle voice dictation input': 'تبديل الإدخال بالإملاء الصوتي',
  'Set the model for voice transcription': 'تعيين نموذج التفريغ الصوتي',
  'Set the image-capable model used to transcribe images for a text-only main model':
    'تعيين النموذج الداعم للصور المستخدم لوصف الصور لنموذج رئيسي نصي فقط',
  'Set the model used to generate images':
    'تعيين النموذج المستخدم لتوليد الصور',
  'Set the model used for chat compression (auto-compaction)':
    'تعيين النموذج المستخدم لضغط المحادثة (الضغط التلقائي)',
  'Persist the model selection to the project settings (workspace scope)':
    'حفظ اختيار النموذج في إعدادات المشروع (نطاق مساحة العمل)',
  'Persist the model selection to the user settings (global scope)':
    'حفظ اختيار النموذج في إعدادات المستخدم (النطاق العام)',
  'Select Fast Model': 'اختر النموذج السريع',
  'Select Vision Model': 'اختر نموذج الرؤية',
  'Select Image Model': 'اختر نموذج الصور',
  'Select Compaction Model': 'اختر نموذج الضغط',
  'Select Voice Model': 'اختر نموذج الصوت',
  'Vision Model': 'نموذج الرؤية',
  'Image Model': 'نموذج الصور',
  'Compaction Model': 'نموذج الضغط',
  'Compaction model override cleared': 'تم مسح تخصيص نموذج الضغط',
  'Current compaction model: {{compactionModel}}\nUse "/model --compaction <model-id>" to set compaction model, or "/model --compaction clear" to clear the override.':
    'نموذج الضغط الحالي: {{compactionModel}}\nاستخدم "/model --compaction <model-id>" لتعيينه، أو "/model --compaction clear" لمسح التخصيص.',
  'not set (falls back to the main model)':
    'غير مضبوط (يعود إلى النموذج الرئيسي)',
  'Configure models in settings.modelProviders and ensure the required environment variables are set. In interactive mode, run /auth to configure or switch providers, or run /model --compaction without a model to choose from configured models.':
    'هيّئ النماذج في settings.modelProviders وتأكّد من ضبط متغيرات البيئة المطلوبة. في الوضع التفاعلي، شغّل /auth لتهيئة المزوّدين أو تبديلهم، أو شغّل /model --compaction دون نموذج للاختيار من النماذج المهيّأة.',
  'Voice Model': 'نموذج الصوت',
  'Selected compaction model is unavailable.': 'نموذج الضغط المحدد غير متاح.',
  'Selected voice model is unavailable.': 'نموذج الصوت المحدد غير متاح.',
  'Selected image model is unavailable.': 'نموذج الصور المحدد غير متاح.',
  "Voice model '{{model}}' is configured more than once. Remove duplicate model ids before selecting it for voice transcription.":
    "تمت تهيئة نموذج الصوت '{{model}}' أكثر من مرة. أزل معرّفات النماذج المكررة قبل اختياره للتفريغ الصوتي.",
  'Voice dictation: {{status}} (mode: {{mode}}, {{modelText}}).':
    'الإملاء الصوتي: {{status}} (الوضع: {{mode}}، {{modelText}}).',
  'model: {{voiceModel}}': 'النموذج: {{voiceModel}}',
  'no voice model selected': 'لم يتم تحديد نموذج صوت',
  'Voice dictation disabled.': 'تم تعطيل الإملاء الصوتي.',
  'Usage: /voice [hold|tap|off|status]':
    'الاستخدام: /voice [hold|tap|off|status]',
  'No voice model selected. Run /model --voice to choose one before enabling voice dictation.':
    'لم يتم تحديد نموذج صوت. شغّل /model --voice لاختيار واحد قبل تفعيل الإملاء الصوتي.',
  'Voice dictation enabled (tap mode). Tap Space at an empty prompt to start, tap again or pause to stop and submit, using {{voiceModel}}.':
    'تم تفعيل الإملاء الصوتي (وضع النقر). انقر Space في سطر فارغ للبدء، وانقر مجددًا أو توقف مؤقتًا للإيقاف والإرسال، باستخدام {{voiceModel}}.',
  'Voice dictation enabled (hold mode). Hold Space at an empty prompt to dictate with {{voiceModel}}.':
    'تم تفعيل الإملاء الصوتي (وضع الضغط المستمر). اضغط مطولاً على Space في سطر فارغ للإملاء باستخدام {{voiceModel}}.',
  'No models are configured.': 'لا توجد نماذج مهيّأة.',
  'Configured models: {{models}}.': 'النماذج المهيّأة: {{models}}.',
  'Configure a unique model id in settings.modelProviders or run /model --voice to select an available model.':
    'هيّئ معرّف نموذج فريدًا في settings.modelProviders أو شغّل /model --voice لاختيار نموذج متاح.',
  "Voice model '{{modelName}}' is not configured.":
    "نموذج الصوت '{{modelName}}' غير مهيّأ.",
  "Voice model '{{modelName}}' cannot be used for transcription.":
    "لا يمكن استخدام نموذج الصوت '{{modelName}}' للتفريغ الصوتي.",
  "Voice model '{{modelName}}' cannot be used for transcription. Configure an OpenAI-compatible model with baseUrl in settings.modelProviders.":
    "لا يمكن استخدام نموذج الصوت '{{modelName}}' للتفريغ الصوتي. هيّئ نموذجًا متوافقًا مع OpenAI مع baseUrl في settings.modelProviders.",
  'Configure an OpenAI-compatible model with baseUrl in settings.modelProviders.':
    'هيّئ نموذجًا متوافقًا مع OpenAI مع baseUrl في settings.modelProviders.',
  'Microphone access is denied. Enable it for your terminal in System Settings → Privacy & Security → Microphone, then restart voice dictation.':
    'تم رفض الوصول إلى الميكروفون. فعّله لطرفيتك في إعدادات النظام ← الخصوصية والأمان ← الميكروفون، ثم أعد تشغيل الإملاء الصوتي.',
  'Voice dictation is not supported on {{platform}}.':
    'الإملاء الصوتي غير مدعوم على {{platform}}.',
  'Voice dictation needs microphone access, which is unavailable in this WSL session. Use WSLg/PulseAudio, or run Qwen Code on a host with a microphone.':
    'يحتاج الإملاء الصوتي إلى الوصول للميكروفون، وهو غير متاح في جلسة WSL هذه. استخدم WSLg/PulseAudio، أو شغّل Qwen Code على مضيف مزوّد بميكروفون.',
  'Voice dictation needs microphone access. macOS will ask the first time you record — approve it, then start again. Your first recording may be empty while the dialog is open.':
    'يحتاج الإملاء الصوتي إلى الوصول للميكروفون. سيطلب macOS الإذن في أول مرة تسجّل فيها — وافق عليه ثم ابدأ مجددًا. قد يكون تسجيلك الأول فارغًا أثناء فتح نافذة الإذن.',
  'Voice: recording': 'الصوت: جارٍ التسجيل',
  'Voice: transcribing': 'الصوت: جارٍ التفريغ',
  'Voice: refining': 'الصوت: جارٍ التحسين',

  'listening…': 'جارٍ الاستماع…',
  'transcribing…': 'جارٍ النسخ…',
  'refining…': 'جارٍ التحسين…',
  'Content generator configuration not available.':
    'تهيئة مولد المحتوى غير متوفرة.',
  'Authentication type not available.': 'نوع المصادقة غير متوفر.',
  'No models available for the current authentication type ({{authType}}).':
    'لا توجد نماذج متاحة لنوع المصادقة الحالي ({{authType}}).',
  ' (not in model registry)': ' (غير مدرج في سجل النماذج)',

  // ============================================================================
  // Commands - Clear
  // ============================================================================
  'Starting a new session, resetting chat, and clearing terminal.':
    'بدء جلسة جديدة وإعادة ضبط المحادثة ومسح الطرفية.',
  'Starting a new session and clearing.': 'بدء جلسة جديدة ومسح المحادثة.',

  // ============================================================================
  // Commands - Compress
  // ============================================================================
  'Already compressing, wait for previous request to complete':
    'الضغط قيد التنفيذ بالفعل، انتظر اكتمال الطلب السابق',
  'Failed to compress chat history.': 'فشل ضغط سجل المحادثة.',
  'Failed to compress chat history: {{error}}':
    'فشل ضغط سجل المحادثة: {{error}}',
  'Compressing chat history': 'جارٍ ضغط سجل المحادثة',
  'Chat history compressed from {{originalTokens}} to {{newTokens}} tokens.':
    'تم ضغط سجل المحادثة من {{originalTokens}} إلى {{newTokens}} رمز.',
  'Compression was not beneficial for this history size.':
    'لم يكن الضغط مجدياً لحجم السجل الحالي.',
  'Chat history compression did not reduce size. This may indicate issues with the compression prompt.':
    'لم يؤدِّ ضغط سجل المحادثة إلى تقليص الحجم. قد يشير هذا إلى مشكلة في موجه الضغط.',
  'Could not compress chat history due to a token counting error.':
    'تعذر ضغط سجل المحادثة بسبب خطأ في حساب الرموز.',
  'Could not compress chat history because the compression summary was empty.':
    'تعذر ضغط سجل المحادثة لأن ملخص الضغط كان فارغاً.',
  'Could not compress chat history because the compression summary was truncated.':
    'تعذر ضغط سجل المحادثة لأن ملخص الضغط تم اقتطاعه.',
  'Could not compress chat history due to an API error.':
    'تعذر ضغط سجل المحادثة بسبب خطأ في واجهة API.',

  // ============================================================================
  // Commands - Directory
  // ============================================================================
  'Configuration is not available.': 'التهيئة غير متوفرة.',
  'Please provide at least one path to add.':
    'يرجى تقديم مسار واحد على الأقل لإضافته.',
  'The /directory add command is not supported in restrictive sandbox profiles. Please use --include-directories when starting the session instead.':
    'الأمر ‎/directory add غير مدعوم في ملفات بيئة العزل المقيدة. يرجى استخدام ‎--include-directories عند بدء الجلسة بدلاً من ذلك.',
  "Error adding '{{path}}': {{error}}": "خطأ أثناء إضافة '{{path}}': {{error}}",
  'Successfully added QWEN.md files from the following directories if there are:\n- {{directories}}':
    'تمت إضافة ملفات QWEN.md بنجاح من المجلدات التالية إن وُجدت:\n- {{directories}}',
  'Error refreshing memory: {{error}}': 'خطأ أثناء تحديث الذاكرة: {{error}}',
  'Successfully added directories:\n- {{directories}}':
    'تمت إضافة المجلدات بنجاح:\n- {{directories}}',
  'Current workspace directories:\n{{directories}}':
    'مجلدات مساحة العمل الحالية:\n{{directories}}',

  // ============================================================================
  // Commands - Docs
  // ============================================================================
  'Please open the following URL in your browser to view the documentation:\n{{url}}':
    'يرجى فتح الرابط التالي في متصفحك لعرض التوثيق:\n{{url}}',
  'Opening documentation in your browser: {{url}}':
    'جارٍ فتح التوثيق في متصفحك: {{url}}',

  // ============================================================================
  // Dialogs - Tool Confirmation
  // ============================================================================
  'Do you want to proceed?': 'هل تريد المتابعة؟',
  'Yes, allow once': 'نعم، السماح لمرة واحدة',
  'Allow always': 'السماح دائماً',
  Yes: 'نعم',
  No: 'لا',
  'No (esc)': 'لا (esc)',
  'Modify in progress:': 'التعديل قيد التنفيذ:',
  'Save and close external editor to continue':
    'احفظ وأغلق المحرر الخارجي للمتابعة',
  'Apply this change?': 'هل تريد تطبيق هذا التغيير؟',
  'Yes, allow always': 'نعم، السماح دائماً',
  'Modify with external editor': 'تعديل باستخدام محرر خارجي',
  'No, suggest changes (esc)': 'لا، اقتراح تعديلات (esc)',
  "Allow execution of: '{{command}}'?": "هل تسمح بتنفيذ: '{{command}}'؟",
  'Always allow in this project': 'السماح دائماً في هذا المشروع',
  'Always allow {{action}} in this project':
    'السماح دائماً بـ {{action}} في هذا المشروع',
  'Always allow for this user': 'السماح دائماً لهذا المستخدم',
  'Always allow {{action}} for this user':
    'السماح دائماً بـ {{action}} لهذا المستخدم',
  'Yes, restore previous mode ({{mode}})':
    'نعم، استعادة الوضع السابق ({{mode}})',
  'Yes, and auto-accept edits': 'نعم، وقبول التعديلات تلقائياً',
  'Yes, and manually approve edits': 'نعم، والموافقة على التعديلات يدوياً',
  'No, keep planning (esc)': 'لا، متابعة التخطيط (esc)',
  'URLs to fetch:': 'الروابط المطلوب جلبها:',
  'MCP Server: {{server}}': 'خادم MCP: {{server}}',
  'Tool: {{tool}}': 'الأداة: {{tool}}',
  'Allow execution of MCP tool "{{tool}}" from server "{{server}}"?':
    'هل تسمح بتنفيذ أداة MCP "{{tool}}" من الخادم "{{server}}"؟',

  // ============================================================================
  // Dialogs - Shell Confirmation
  // ============================================================================
  'Shell Command Execution': 'تنفيذ أمر صدفة',
  'A custom command wants to run the following shell commands:':
    'يريد أمر مخصص تشغيل أوامر الصدفة التالية:',

  // ============================================================================
  // Dialogs - Welcome Back
  // ============================================================================
  'Current Plan:': 'الخطة الحالية:',
  'Progress: {{done}}/{{total}} tasks completed':
    'التقدم: اكتملت {{done}}/{{total}} مهمة',
  ', {{inProgress}} in progress': '، {{inProgress}} قيد التنفيذ',
  'Pending Tasks:': 'المهام المعلقة:',
  'What would you like to do?': 'ماذا تود أن تفعل؟',
  'Choose how to proceed with your session:': 'اختر كيفية المتابعة في جلستك:',
  'Start new chat session': 'بدء جلسة محادثة جديدة',
  'Continue previous conversation': 'متابعة المحادثة السابقة',
  'Welcome back! (Last updated: {{timeAgo}})':
    'مرحباً بعودتك! (آخر تحديث: {{timeAgo}})',
  'Overall Goal:': 'الهدف العام:',
  'Connect a Provider': 'ربط مزوّد',
  'You must connect a provider to proceed. Press Ctrl+C again to exit.':
    'يجب عليك ربط مزوّد للمتابعة. اضغط Ctrl+C مرة أخرى للخروج.',
  'Terms of Services and Privacy Notice': 'شروط الخدمة وإشعار الخصوصية',
  'Qwen OAuth': 'Qwen OAuth',
  'Discontinued — switch to Coding Plan or API Key':
    'متوقف — بدّل إلى Coding Plan أو مفتاح API',
  'Qwen OAuth free tier was discontinued on 2026-04-15. Please select Coding Plan or API Key instead.':
    'تم إيقاف الفئة المجانية من Qwen OAuth في 2026-04-15. يرجى اختيار Coding Plan أو مفتاح API بدلاً من ذلك.',
  'Qwen OAuth free tier was discontinued on 2026-04-15. Please select a model from another provider or run /auth to switch.':
    'تم إيقاف الفئة المجانية من Qwen OAuth في 2026-04-15. يرجى اختيار نموذج من مزوّد آخر أو تشغيل ‎/auth للتبديل.',
  '\n⚠ Qwen OAuth free tier was discontinued on 2026-04-15. Please select another option.\n':
    '\n⚠ تم إيقاف الفئة المجانية من Qwen OAuth في 2026-04-15. يرجى اختيار خيار آخر.\n',
  'Paid · Up to 6,000 requests/5 hrs · All Alibaba Cloud Coding Plan Models':
    'مدفوع · حتى 6,000 طلب/5 ساعات · جميع نماذج Alibaba Cloud Coding Plan',
  'For teams · Paid · Up to 6,000 requests/5 hrs · All Alibaba Cloud Coding Plan Models':
    'للفرق · مدفوع · حتى 6,000 طلب/5 ساعات · جميع نماذج Alibaba Cloud Coding Plan',
  'For individual developers · Pay per model call · 5-hour/weekly quotas':
    'للمطورين الأفراد · الدفع لكل استدعاء نموذج · حصص كل 5 ساعات/أسبوعية',
  Subscribe: 'اشترك',
  'Paid subscription plans from Alibaba Cloud ModelStudio':
    'خطط اشتراك مدفوعة من Alibaba Cloud ModelStudio',
  'Select Subscription Plan': 'اختر خطة الاشتراك',
  'Alibaba Cloud Coding Plan': 'Alibaba Cloud Coding Plan',
  'Alibaba Cloud Token Plan': 'Alibaba Cloud Token Plan',
  'Pay-as-you-go tokens · Configure ModelStudio standard API key':
    'رموز بنظام الدفع حسب الاستخدام · تهيئة مفتاح API القياسي لـ ModelStudio',
  'For individuals · Pay-as-you-go tokens · Dedicated Token Plan endpoint':
    'للأفراد · رموز بنظام الدفع حسب الاستخدام · نقطة نهاية مخصصة لـ Token Plan',
  'For teams/companies · Credits deducted by token usage · Dedicated API key and base URL':
    'للفرق/الشركات · رصيد يُخصم حسب استهلاك الرموز · مفتاح API وعنوان أساسي مخصصان',
  'Token Plan documentation': 'توثيق Token Plan',
  'Bring your own API key': 'استخدم مفتاح API الخاص بك',
  'Browser-based authentication with third-party providers (e.g. OpenRouter, ModelScope)':
    'مصادقة عبر المتصفح مع مزوّدين خارجيين (مثل OpenRouter و ModelScope)',
  'Authentication is enforced to be {{enforcedType}}, but you are currently using {{currentType}}.':
    'المصادقة مقيّدة لتكون {{enforcedType}}، لكنك تستخدم حالياً {{currentType}}.',
  'Qwen Subscription': 'اشتراك Qwen',
  'Qwen Account with Subscription': 'حساب Qwen مع اشتراك',
  'Unlock Qwen Code + Agent with Plus/Pro Plan at chat.qwen.ai':
    'افتح Qwen Code + Agent مع خطة Plus/Pro عبر chat.qwen.ai',
  'Opening chat.qwen.ai in your browser… Sign in there to connect Qwen Code.':
    'جارٍ فتح chat.qwen.ai في متصفحك… سجّل الدخول هناك لربط Qwen Code.',
  "If the browser didn't open, visit:": 'إذا لم يفتح المتصفح، تفضّل بزيارة:',
  'Waiting for sign-in…': 'في انتظار تسجيل الدخول…',
  'c to copy link · Esc to cancel': 'c لنسخ الرابط · Esc للإلغاء',
  'Authentication timed out. Please try again or select a different authentication method.':
    'انتهت مهلة المصادقة. يرجى المحاولة مرة أخرى أو اختيار طريقة مصادقة مختلفة.',
  'Signed in as {{email}}': 'تم تسجيل الدخول بصفتك {{email}}',
  'Signed in successfully · {{email}}': 'تم تسجيل الدخول بنجاح · {{email}}',
  'Current plan: Qwen {{plan}}. Qwen Code is ready.':
    'الخطة الحالية: Qwen {{plan}}. أصبح Qwen Code جاهزاً.',
  'Model: {{model}}. Run /upgrade to upgrade your plan, /usage to view usage, /model to switch models, or /effort to change reasoning effort.':
    'النموذج: {{model}}. شغّل ‎/upgrade لترقية خطتك، أو ‎/usage لعرض الاستخدام، أو ‎/model لتبديل النماذج، أو ‎/effort لتغيير جهد الاستدلال.',
  'Common commands: /usage   /upgrade   /model   /effort   /status   /logout':
    'أوامر شائعة: ‎/usage   ‎/upgrade   ‎/model   ‎/effort   ‎/status   ‎/logout',
  'Signed in as {{email}} (Qwen {{plan}})':
    'تم تسجيل الدخول بصفتك {{email}} (Qwen {{plan}})',
  'Qwen {{plan}} is active · usage is included with your plan':
    'خطة Qwen {{plan}} نشطة · الاستخدام مشمول ضمن خطتك',
  'Model: {{model}}': 'النموذج: {{model}}',
  'Qwen Code is included with Qwen Plus and Pro':
    'يتوفر Qwen Code ضمن خطتي Qwen Plus و Pro',
  "You're signed in with a {{plan}} account, which doesn't include Qwen Code. Choose Plus or Pro in your browser; this terminal continues automatically after you subscribe.":
    'أنت مسجل الدخول بحساب {{plan}}، وهو لا يشمل Qwen Code. اختر Plus أو Pro في متصفحك؛ وستستمر هذه الطرفية تلقائياً بعد اشتراكك.',
  'Waiting for your subscription to become active…': 'في انتظار تفعيل اشتراكك…',
  'Your Qwen session has expired. Run /auth to sign in again.':
    'انتهت صلاحية جلسة Qwen الخاصة بك. شغّل ‎/auth لتسجيل الدخول مجدداً.',
  'Your login credentials are no longer valid. Run /auth to sign in again.':
    'لم تعد بيانات تسجيل الدخول صالحة. شغّل ‎/auth لتسجيل الدخول مجدداً.',
  'Checking your subscription…': 'جارٍ التحقق من اشتراكك…',
  'Retry Connection': 'إعادة محاولة الاتصال',
  'View Plans': 'عرض الخطط',
  'Opens the Qwen Code plans page in your browser':
    'يفتح صفحة خطط Qwen Code في متصفحك',
  'Switch Provider': 'تبديل المزوّد',
  'Use another account': 'استخدام حساب آخر',
  'Choose another model provider': 'اختر مزوّد نماذج آخر',
  'Sign out': 'تسجيل الخروج',
  'Enter to select, ↑↓ to navigate · Esc to close':
    'Enter للاختيار، ↑↓ للتنقل · Esc للإغلاق',
  'Qwen OAuth Authentication': 'مصادقة Qwen OAuth',
  'Please visit this URL to authorize:': 'يرجى زيارة هذا الرابط للتخويل:',
  'Waiting for authorization': 'في انتظار التخويل',
  'Time remaining:': 'الوقت المتبقي:',
  'Qwen OAuth Authentication Timeout': 'انتهت مهلة مصادقة Qwen OAuth',
  'OAuth token expired (over {{seconds}} seconds). Please select authentication method again.':
    'انتهت صلاحية رمز OAuth (تجاوزت {{seconds}} ثانية). يرجى اختيار طريقة المصادقة مرة أخرى.',
  'Press any key to return to authentication type selection.':
    'اضغط أي مفتاح للعودة إلى اختيار نوع المصادقة.',
  'Waiting for Qwen OAuth authentication...': 'في انتظار مصادقة Qwen OAuth...',
  'Authentication timed out. Please try again.':
    'انتهت مهلة المصادقة. يرجى المحاولة مرة أخرى.',
  'Waiting for auth... (Press ESC or CTRL+C to cancel)':
    'في انتظار المصادقة... (اضغط ESC أو CTRL+C للإلغاء)',
  'Missing API key for OpenAI-compatible auth. Set settings.security.auth.apiKey, or set the {{envKeyHint}} environment variable.':
    'مفتاح API لمصادقة OpenAI-compatible مفقود. اضبط settings.security.auth.apiKey، أو عيّن متغير البيئة {{envKeyHint}}.',
  '{{envKeyHint}} environment variable not found. Please set it in your .env file or environment variables.':
    'متغير البيئة {{envKeyHint}} غير موجود. يرجى تعيينه في ملف .env أو متغيرات البيئة.',
  '{{envKeyHint}} environment variable not found (or set settings.security.auth.apiKey). Please set it in your .env file or environment variables.':
    'متغير البيئة {{envKeyHint}} غير موجود (أو اضبط settings.security.auth.apiKey). يرجى تعيينه في ملف .env أو متغيرات البيئة.',
  'Missing API key for OpenAI-compatible auth. Set the {{envKeyHint}} environment variable.':
    'مفتاح API لمصادقة OpenAI-compatible مفقود. عيّن متغير البيئة {{envKeyHint}}.',
  'Anthropic provider missing required baseUrl in modelProviders[].baseUrl.':
    'مزوّد Anthropic يفتقد حقل baseUrl المطلوب في modelProviders[].baseUrl.',
  'ANTHROPIC_BASE_URL environment variable not found.':
    'متغير البيئة ANTHROPIC_BASE_URL غير موجود.',
  'Invalid auth method selected.': 'طريقة المصادقة المختارة غير صالحة.',
  'Failed to authenticate. Message: {{message}}':
    'فشلت المصادقة. الرسالة: {{message}}',
  'Authenticated successfully with {{authType}} credentials.':
    'تمت المصادقة بنجاح باستخدام بيانات اعتماد {{authType}}.',
  'Invalid QWEN_DEFAULT_AUTH_TYPE value: "{{value}}". Valid values are: {{validValues}}':
    'قيمة QWEN_DEFAULT_AUTH_TYPE غير صالحة: "{{value}}". القيم الصالحة هي: {{validValues}}',

  // ============================================================================
  // Dialogs - Model
  // ============================================================================
  'Select Model': 'اختر النموذج',
  ' (this project)': ' (هذا المشروع)',
  ' (global)': ' (عام)',
  'API Key': 'مفتاح API',
  '(default)': '(افتراضي)',
  '(not set)': '(غير مضبوط)',
  Modality: 'النمط',
  'Context Window': 'نافذة السياق',
  text: 'نص',
  'text-only': 'نص فقط',
  image: 'صورة',
  pdf: 'PDF',
  audio: 'صوت',
  video: 'فيديو',
  'not set': 'غير مضبوط',
  'Current voice model: {{voiceModel}}\nUse "/model --voice <model-id>" to set voice model.':
    'نموذج الصوت الحالي: {{voiceModel}}\nاستخدم "/model --voice <model-id>" لتعيين نموذج الصوت.',
  'Current vision model: {{visionModel}}\nUse "/model --vision <model-id>" to set the vision bridge model.':
    'نموذج الرؤية الحالي: {{visionModel}}\nاستخدم "/model --vision <model-id>" لتعيين نموذج جسر الرؤية.',
  'Set the vision bridge timeout in seconds (use with --vision)':
    'اضبط مهلة جسر الرؤية بالثواني (يُستخدم مع \u2066--vision\u2069)',
  '--timeout can only be used with --vision.':
    'لا يمكن استخدام \u2066--timeout\u2069 إلا مع \u2066--vision\u2069.',
  'Invalid --timeout value "{{value}}". Use a positive whole number of seconds, such as 60, 60s or 90000ms.':
    'قيمة \u2066--timeout\u2069 غير صالحة: "\u2066{{value}}\u2069". استخدم عدداً صحيحاً موجباً من الثواني، مثل \u206660\u2069 أو \u206660s\u2069 أو \u206690000ms\u2069.',
  'Vision bridge timeout: {{timeout}}':
    'مهلة جسر الرؤية: \u2066{{timeout}}\u2069',
  'Saved vision bridge timeout {{timeout}}{{scope}}. A higher-priority setting keeps the effective timeout at {{effectiveTimeout}}.':
    'حُفظت مهلة جسر الرؤية عند \u2066{{timeout}}\u2069{{scope}}. يُبقي إعداد ذو أولوية أعلى المهلة الفعلية عند \u2066{{effectiveTimeout}}\u2069.',
  'Vision bridge timeout: {{timeout}}\nUse "/model --vision --timeout <seconds>" to change it.':
    'مهلة جسر الرؤية: \u2066{{timeout}}\u2069\nلتغييرها، استخدم "\u2066/model --vision --timeout <seconds>\u2069".',
  '{{timeout}} (default)': '\u2066{{timeout}}\u2069 (افتراضي)',
  'Current image model: {{imageModel}}\nUse "/model --image <model-id>" to set the image generation model.':
    'نموذج توليد الصور الحالي: {{imageModel}}\nاستخدم "/model --image <model-id>" لتعيين نموذج توليد الصور.',
  "Voice model '{{modelName}}' is ambiguous. Configure a unique model id before using /model --voice.":
    "نموذج الصوت '{{modelName}}' غامض. عيّن معرّف نموذج فريداً قبل استخدام ‎/model --voice.",
  "Image model '{{modelName}}' matches multiple configured endpoints. Run /model --image without an argument and choose the exact endpoint.":
    "نموذج الصور '{{modelName}}' يطابق عدة نقاط نهاية مهيأة. شغّل ‎/model --image دون وسيط واختر نقطة النهاية الدقيقة.",
  "Image model '{{modelName}}' must declare a valid HTTPS baseUrl and credential environment variable.":
    "يجب أن يصرّح نموذج الصور '{{modelName}}' عن عنوان baseUrl صالح ببروتوكول HTTPS ومتغير بيئة لبيانات الاعتماد.",
  "'{{model}}' must declare a valid HTTPS baseUrl and credential environment variable.":
    "يجب أن يصرّح '{{model}}' عن عنوان baseUrl صالح ببروتوكول HTTPS ومتغير بيئة لبيانات الاعتماد.",
  none: 'لا يوجد',
  unknown: 'غير معروف',

  // ============================================================================
  // Dialogs - Permissions
  // ============================================================================
  'Manage folder trust settings': 'إدارة إعدادات موثوقية المجلد',
  'Manage permission rules': 'إدارة قواعد الأذونات',
  Allow: 'سماح',
  Ask: 'سؤال',
  Deny: 'رفض',
  Workspace: 'مساحة العمل',
  "Qwen Code won't ask before using allowed tools.":
    'لن يسأل Qwen Code قبل استخدام الأدوات المسموح بها.',
  'Qwen Code will ask before using these tools.':
    'سيسأل Qwen Code قبل استخدام هذه الأدوات.',
  'Qwen Code is not allowed to use denied tools.':
    'لا يُسمح لـ Qwen Code باستخدام الأدوات المرفوضة.',
  'Manage trusted directories for this workspace.':
    'إدارة المجلدات الموثوقة لمساحة العمل هذه.',
  'Any use of the {{tool}} tool': 'أي استخدام لأداة {{tool}}',
  "{{tool}} commands matching '{{pattern}}'":
    "أوامر {{tool}} التي تطابق '{{pattern}}'",
  'From user settings': 'من إعدادات المستخدم',
  'From project settings': 'من إعدادات المشروع',
  'From session': 'من الجلسة',
  'Project settings': 'إعدادات المشروع',
  'Checked in at .qwen/settings.json':
    'محفوظة في المستودع ضمن .qwen/settings.json',
  'User settings': 'إعدادات المستخدم',
  'Saved in at ~/.qwen/settings.json': 'محفوظة في ~/.qwen/settings.json',
  'Add a new rule…': 'إضافة قاعدة جديدة…',
  'Add {{type}} permission rule': 'إضافة قاعدة إذن {{type}}',
  'Permission rules are a tool name, optionally followed by a specifier in parentheses.':
    'قواعد الأذونات عبارة عن اسم أداة، يتبعه اختيارياً محدد بين قوسين.',
  'e.g.,': 'مثال:',
  or: 'أو',
  'Enter permission rule…': 'أدخل قاعدة الإذن…',
  'Enter to submit · Esc to cancel': 'Enter للإرسال · Esc للإلغاء',
  'Where should this rule be saved?': 'أين يجب حفظ هذه القاعدة؟',
  'Enter to confirm · Esc to cancel': 'Enter للتأكيد · Esc للإلغاء',
  'Delete {{type}} rule?': 'هل تريد حذف قاعدة {{type}}؟',
  'Are you sure you want to delete this permission rule?':
    'هل أنت متأكد من أنك تريد حذف قاعدة الإذن هذه؟',
  'Permissions:': 'الأذونات:',
  '(←/→ or tab to cycle)': '(←/→ أو tab للتبديل)',
  'Press ↑↓ to navigate · Enter to select · Type to search · Esc to cancel':
    'اضغط ↑↓ للتنقل · Enter للاختيار · اكتب للبحث · Esc للإلغاء',
  'Search…': 'بحث…',
  // Workspace directory management
  'Add directory…': 'إضافة مجلد…',
  'Add directory to workspace': 'إضافة مجلد إلى مساحة العمل',
  'Qwen Code can read files in the workspace, and make edits when auto-accept edits is on.':
    'يمكن لـ Qwen Code قراءة الملفات في مساحة العمل، وإجراء تعديلات عند تفعيل القبول التلقائي للتعديلات.',
  'Qwen Code will be able to read files in this directory and make edits when auto-accept edits is on.':
    'سيتمكن Qwen Code من قراءة الملفات في هذا المجلد وإجراء تعديلات عند تفعيل القبول التلقائي للتعديلات.',
  'Enter the path to the directory:': 'أدخل المسار إلى المجلد:',
  'Enter directory path…': 'أدخل مسار المجلد…',
  'Tab to complete · Enter to add · Esc to cancel':
    'Tab للإكمال · Enter للإضافة · Esc للإلغاء',
  'Remove directory?': 'هل تريد إزالة المجلد؟',
  'Are you sure you want to remove this directory from the workspace?':
    'هل أنت متأكد من أنك تريد إزالة هذا المجلد من مساحة العمل؟',
  '  (Original working directory)': '  (مجلد العمل الأصلي)',
  '  (from settings)': '  (من الإعدادات)',
  'Directory does not exist.': 'المجلد غير موجود.',
  'Path is not a directory.': 'المسار ليس مجلداً.',
  'This directory is already in the workspace.':
    'هذا المجلد موجود بالفعل في مساحة العمل.',
  'Already covered by existing directory: {{dir}}':
    'مغطى بالفعل بمجلد حالي: {{dir}}',

  // ============================================================================
  // Status Bar
  // ============================================================================
  'Using:': 'قيد الاستخدام:',
  '{{count}} open file': '{{count}} ملف مفتوح',
  '{{count}} open files': '{{count}} ملفات مفتوحة',
  '(ctrl+g to view)': '(ctrl+g للعرض)',
  '{{count}} {{name}} file': '{{count}} ملف {{name}}',
  '{{count}} {{name}} files': '{{count}} ملفات {{name}}',
  '{{count}} MCP server': 'خادم MCP واحد ({{count}})',
  '{{count}} MCP servers': '{{count}} خوادم MCP',
  '{{count}} Blocked': '{{count}} محظور',
  '(ctrl+t to view)': '(ctrl+t للعرض)',
  '(ctrl+t to toggle)': '(ctrl+t للتبديل)',
  'Press Ctrl+C again to exit.': 'اضغط Ctrl+C مرة أخرى للخروج.',
  'Press Ctrl+D again to exit.': 'اضغط Ctrl+D مرة أخرى للخروج.',
  'Press Esc again to clear.': 'اضغط Esc مرة أخرى للمسح.',
  'Ctrl+Q to queue · ↑ to edit queued messages':
    'Ctrl+Q للإدراج في قائمة الانتظار · ↑ لتعديل الرسائل المنتظرة',
  'Enter to steer · Ctrl+Q to queue':
    'Enter للتوجيه · Ctrl+Q للإدراج في قائمة الانتظار',
  '{{count}} queued': '{{count}} في الانتظار',
  'Queue message for the next turn': 'وضع الرسالة في قائمة انتظار الدور التالي',

  // ============================================================================
  // MCP Status
  // ============================================================================
  'No MCP servers configured.': 'لا توجد خوادم MCP مهيأة.',
  '◌ MCP servers are starting up ({{count}} initializing)...':
    '◌ خوادم MCP قيد التشغيل ({{count}} قيد التهيئة)...',
  'Note: First startup may take longer. Tool availability will update automatically.':
    'ملاحظة: قد يستغرق البدء الأول وقتاً أطول. سيتم تحديث توفر الأدوات تلقائياً.',
  'Configured MCP servers:': 'خوادم MCP المهيأة:',
  Ready: 'جاهز',
  'Starting... (first startup may take longer)':
    'جارٍ البدء... (قد يستغرق البدء الأول وقتاً أطول)',
  Disconnected: 'غير متصل',
  '{{count}} tool': '{{count}} أداة',
  '{{count}} tools': '{{count}} أدوات',
  '{{count}} prompt': '{{count}} موجه',
  '{{count}} prompts': '{{count}} موجهات',
  '(from {{extensionName}})': '(من {{extensionName}})',
  OAuth: 'OAuth',
  'OAuth expired': 'انتهت صلاحية OAuth',
  'OAuth not authenticated': 'لم تتم مصادقة OAuth',
  'tools and prompts will appear when ready':
    'ستظهر الأدوات والموجهات عند الجاهزية',
  '{{count}} tools cached': '{{count}} أداة مخزنة مؤقتاً',
  'Tools:': 'الأدوات:',
  'Parameters:': 'المعاملات:',
  'Prompts:': 'الموجهات:',
  'Resources:': 'الموارد:',
  Blocked: 'محظور',
  '★ Tips:': '★ نصائح:',
  Use: 'استخدم',
  'to show server and tool descriptions': 'لعرض أوصاف الخادم والأدوات',
  'to show tool parameter schemas': 'لعرض مخططات معاملات الأدوات',
  'to hide descriptions': 'لإخفاء الأوصاف',
  'to authenticate with OAuth-enabled servers':
    'للمصادقة مع الخوادم الداعمة لـ OAuth',
  Press: 'اضغط',
  'to toggle tool descriptions on/off': 'لتبديل إظهار/إخفاء أوصاف الأدوات',
  "Starting OAuth authentication for MCP server '{{name}}'...":
    "جارٍ بدء مصادقة OAuth لخادم MCP '{{name}}'...",

  // ============================================================================
  // Startup Tips
  // ============================================================================
  'Tips:': 'نصائح:',
  'Use /compress when the conversation gets long to summarize history and free up context.':
    'استخدم ‎/compress عندما تطول المحادثة لتلخيص السجل وتحرير مساحة السياق.',
  'Start a fresh idea with /clear or /new; the previous session stays available in history.':
    'ابدأ فكرة جديدة باستخدام ‎/clear أو ‎/new؛ وستبقى الجلسة السابقة متاحة في السجل.',
  'Use /bug to submit issues to the maintainers when something goes off.':
    'استخدم ‎/bug لإرسال المشكلات إلى المشرفين عندما يحدث خلل ما.',
  'Switch auth type quickly with /auth.':
    'بدّل نوع المصادقة بسرعة باستخدام ‎/auth.',
  'You can run any shell commands from Qwen Code using ! (e.g. !ls).':
    'يمكنك تشغيل أي أوامر صدفة من Qwen Code باستخدام ! (مثل ‎!ls).',
  'Type / to open the command popup; Tab autocompletes slash commands and saved prompts.':
    'اكتب / لفتح نافذة الأوامر؛ ويكمل Tab أوامر الشرطة المائلة والموجهات المحفوظة تلقائياً.',
  'You can resume a previous conversation by running qwen --continue or qwen --resume.':
    'يمكنك استئناف محادثة سابقة بتشغيل qwen --continue أو qwen --resume.',
  'You can switch permission mode quickly with Shift+Tab or /approval-mode.':
    'يمكنك تبديل وضع الأذونات بسرعة باستخدام Shift+Tab أو ‎/approval-mode.',
  'You can switch permission mode quickly with Tab or /approval-mode.':
    'يمكنك تبديل وضع الأذونات بسرعة باستخدام Tab أو ‎/approval-mode.',
  'Try /insight to generate personalized insights from your chat history.':
    'جرّب ‎/insight لتوليد تحليلات مخصصة من سجل محادثاتك.',
  'Add a QWEN.md file to give Qwen Code persistent project context.':
    'أضف ملف QWEN.md لمنح Qwen Code سياقاً دائماً للمشروع.',
  'Use /btw to ask a quick side question without disrupting the conversation.':
    'استخدم ‎/btw لطرح سؤال جانبي سريع دون مقاطعة المحادثة.',
  'Context is almost full! Run /compress now or start /new to continue.':
    'السياق ممتلئ تقريباً! شغّل ‎/compress الآن أو ابدأ ‎/new للمتابعة.',
  'Context is getting full. Use /compress to free up space.':
    'السياق يوشك على الامتلاء. استخدم ‎/compress لتحرير مساحة.',
  'Long conversation? /compress summarizes history to free context.':
    'محادثة طويلة؟ يلخص ‎/compress السجل لتحرير السياق.',

  // ============================================================================
  // Exit Screen / Stats
  // ============================================================================
  'Agent powering down. Goodbye!': 'الوكيل يتوقف عن العمل. إلى اللقاء!',
  'To continue this session, run': 'لمتابعة هذه الجلسة، شغّل',
  'Interaction Summary': 'ملخص التفاعل',
  'Session ID:': 'معرّف الجلسة:',
  'Tool Calls:': 'استدعاءات الأدوات:',
  'Success Rate:': 'معدل النجاح:',
  'User Agreement:': 'موافقة المستخدم:',
  reviewed: 'تمت مراجعتها',
  'Code Changes:': 'تغييرات الكود:',
  Performance: 'الأداء',
  'Generation Metrics': 'مقاييس التوليد',
  'Latest Request': 'أحدث طلب',
  'Generation Time': 'زمن التوليد',
  'Average TTFT': 'متوسط TTFT',
  'Session TPS': 'معدل TPS للجلسة',
  'Wall Time:': 'الوقت الكلي:',
  'Agent Active:': 'نشاط الوكيل:',
  'API Time:': 'زمن API:',
  'Tool Time:': 'زمن الأدوات:',
  'Session Stats': 'إحصائيات الجلسة',
  'Model Usage': 'استخدام النماذج',
  Reqs: 'الطلبات',
  'Input Tokens': 'رموز الإدخال',
  'Output Tokens': 'رموز الإخراج',
  'Output (incl. Reasoning)': 'الإخراج (شامل الاستدلال)',
  'Savings Highlight:': 'أبرز الوفورات:',
  'of input tokens were served from the cache, reducing costs.':
    'من رموز الإدخال قُدّمت من الذاكرة المؤقتة، مما قلّل التكاليف.',
  'Tip: For a full token breakdown, run `/stats model`.':
    'نصيحة: لعرض تفصيل كامل للرموز، شغّل ‎`/stats model`.',
  'Model Stats For Nerds': 'إحصائيات النماذج المتقدمة',
  'Tool Stats For Nerds': 'إحصائيات الأدوات المتقدمة',
  Metric: 'المقياس',
  API: 'API',
  Requests: 'الطلبات',
  Errors: 'الأخطاء',
  'Avg Latency': 'متوسط الكمون',
  Tokens: 'الرموز',
  Total: 'الإجمالي',
  Prompt: 'الموجه',
  Cached: 'مخزن مؤقتاً',
  Thoughts: 'الأفكار',
  Output: 'الإخراج',
  'No API calls have been made in this session.':
    'لم تُجرَ أي استدعاءات API في هذه الجلسة.',
  'Tool Name': 'اسم الأداة',
  Calls: 'الاستدعاءات',
  'Success Rate': 'معدل النجاح',
  'Avg Duration': 'متوسط المدة',
  'User Decision Summary': 'ملخص قرارات المستخدم',
  'Total Reviewed Suggestions:': 'إجمالي الاقتراحات المراجعة:',
  ' » Accepted:': ' » مقبولة:',
  ' » Rejected:': ' » مرفوضة:',
  ' » Modified:': ' » معدّلة:',
  ' Overall Agreement Rate:': ' معدل الموافقة الإجمالي:',
  'No tool calls have been made in this session.':
    'لم تُجرَ أي استدعاءات أدوات في هذه الجلسة.',
  'Session start time is unavailable, cannot calculate stats.':
    'وقت بدء الجلسة غير متوفر، لا يمكن حساب الإحصائيات.',

  // ============================================================================
  // Command Format Migration
  // ============================================================================
  'Command Format Migration': 'ترحيل صيغة الأوامر',
  'Found {{count}} TOML command file:': 'تم العثور على {{count}} ملف أمر TOML:',
  'Found {{count}} TOML command files:':
    'تم العثور على {{count}} ملفات أوامر TOML:',
  'Current tasks': 'المهام الحالية',
  'Background tasks': 'مهام الخلفية',
  'No tasks currently running': 'لا توجد مهام قيد التشغيل حالياً',
  'No entry to show.': 'لا يوجد عنصر لعرضه.',
  'needs approval': 'يتطلب موافقة',
  'Large workflow': 'سير عمل كبير',
  'Large workflow: {{agents}} agents scheduled (warning threshold {{cap}}).':
    'سير عمل كبير: تم جدولة {{agents}} وكيل (حد التحذير {{cap}}).',
  'Large workflow: ~{{tokens}} output tokens projected (warning threshold {{cap}}).':
    'سير عمل كبير: ~{{tokens}} رمز إخراج متوقع (حد التحذير {{cap}}).',
  'rejected — edit config to re-approve':
    'مرفوض — عدّل التهيئة لإعادة الموافقة',
  'Background agent needs approval': 'وكيل الخلفية يحتاج إلى موافقة',
  'Approve or deny the request above': 'وافق على الطلب أعلاه أو ارفضه',
  'from nested agent': 'من وكيل متداخل',
  Running: 'قيد التشغيل',
  Pausing: 'جارٍ الإيقاف المؤقت',
  Paused: 'متوقف مؤقتاً',
  'Pause is cooperative; in-flight work may finish before the workflow is paused. An agent call waiting on a tool approval keeps the run in this state and still counts against the active-time limit until the approval is answered.':
    'الإيقاف المؤقت تعاوني؛ قد ينتهي العمل الجاري قبل إيقاف سير العمل مؤقتاً. استدعاء الوكيل المنتظر لموافقة أداة يُبقي التشغيل في هذه الحالة ويستمر في الاحتساب ضمن حد الوقت النشط حتى تتم الإجابة على الموافقة.',
  'Paused: no new agents will start; script code between agent calls keeps running. Press p to resume. /clear, /branch, and switching sessions cancel paused runs.':
    'متوقف مؤقتاً: لن يبدأ وكلاء جدد؛ يستمر كود السكربت بين استدعاءات الوكلاء في التشغيل. اضغط p للاستئناف. الأوامر ‎/clear و ‎/branch وتبديل الجلسات تلغي التشغيلات المتوقفة مؤقتاً.',
  'Pause/resume was rejected; the workflow state changed. Try again.':
    'تم رفض الإيقاف المؤقت/الاستئناف؛ تغيّرت حالة سير العمل. حاول مرة أخرى.',
  'Tip: use `/workflows p <runId>` or Background tasks + p to cooperatively pause/resume; use `/workflows <runId>` for details.':
    'نصيحة: استخدم ‎`/workflows p <runId>` أو مهام الخلفية + p للإيقاف المؤقت/الاستئناف التعاوني؛ واستخدم ‎`/workflows <runId>` للتفاصيل.',
  Completed: 'مكتمل',
  Failed: 'فشل',
  Stopped: 'متوقف',
  Shell: 'صدفة',
  Monitor: 'مراقب',
  Command: 'أمر',
  Dream: 'حلم',
  '[dream] memory consolidation': '[حلم] توحيد الذاكرة',
  '[dream] memory consolidation (reviewing {{count}} session)':
    '[حلم] توحيد الذاكرة (مراجعة {{count}} جلسة)',
  '[dream] memory consolidation (reviewing {{count}} sessions)':
    '[حلم] توحيد الذاكرة (مراجعة {{count}} جلسات)',
  '{{count}} session': '{{count}} جلسة',
  '{{count}} sessions': '{{count}} جلسات',
  '{{count}} topic': '{{count}} موضوع',
  '{{count}} topics': '{{count}} مواضيع',
  '{{count}} tokens': '{{count}} رمز',
  '{{count}} tool call': '{{count}} استدعاء أداة',
  '{{count}} tool calls': '{{count}} استدعاءات أدوات',
  '{{count}} event': '{{count}} حدث',
  '{{count}} events': '{{count}} أحداث',
  '{{count}} dropped': '{{count}} مسقط',
  'pid {{pid}}': 'pid {{pid}}',
  'exit {{exitCode}}': 'خروج {{exitCode}}',
  'Sessions reviewing': 'جلسات قيد المراجعة',
  Progress: 'التقدم',
  'Resume blocked': 'الاستئناف محجوب',
  'Working dir': 'مجلد العمل',
  'Output file': 'ملف الإخراج',
  'Topics touched ({{count}})': 'المواضيع المحدّثة ({{count}})',
  '{{count}} more': '{{count}} إضافي',
  'Lock release warning': 'تحذير تحرير القفل',
  'Metadata write warning': 'تحذير كتابة البيانات الوصفية',
  "Subsequent dreams may be skipped as locked until the next session's staleness sweep cleans the file.":
    'قد يتم تخطي دورات الحلم اللاحقة باعتبارها مقفلة حتى يقوم فحص التقادم في الجلسة التالية بتنظيف الملف.',
  "The scheduler gate did not see this dream's timestamp; the next dream cycle may re-fire sooner than usual.":
    'لم ترَ بوابة المجدول الطابع الزمني لهذا الحلم؛ قد تنطلق دورة الحلم التالية أبكر من المعتاد.',
  '... and {{count}} more': '... و {{count}} أخرى',
  'The TOML format is deprecated. Would you like to migrate them to Markdown format?':
    'صيغة TOML مهملة. هل ترغب في ترحيلها إلى صيغة Markdown؟',
  '(Backups will be created and original files will be preserved)':
    '(سيتم إنشاء نسخ احتياطية والاحتفاظ بالملفات الأصلية)',

  // ============================================================================
  // Loading Phrases
  // ============================================================================
  'Waiting for user confirmation...': 'في انتظار تأكيد المستخدم...',
  WITTY_LOADING_PHRASES: [
    'أشعر بالحظ السعيد',
    'نشحن الروعة إليك... ',
    'نعيد رسم الحروف بأناقة...',
    'نتنقل في المتاهة الرقمية...',
    'نستشير أرواح الشبكة...',
    'نضبط المنحنيات الرقمية...',
    'نسخّن معالجات الذكاء الاصطناعي...',
    'نسأل الصدفة السحرية...',
    'نولّد رداً ذكياً...',
    'نصقل الخوارزميات...',
    'لا تستعجل الإتقان (أو الكود الخاص بي)...',
    'نعدّ بايتات طازجة...',
    'نحصي الإلكترونات...',
    'نشغّل المعالجات المعرفية...',
    'نفحص الكون بحثاً عن أخطاء نحوية...',
    'لحظة واحدة، نحسّن حس الفكاهة...',
    'نخلط النكات البرمجية...',
    'نفك تشابك الشبكات العصبية...',
    'نُجمّع التألق...',
    'جارٍ تحميل wit.exe...',
    'نستدعي سحابة الحكمة...',
    'نُحضّر رداً ذكياً...',
    'ثانية واحدة، أنقّح الواقع من الأخطاء...',
    'نرتّب الخيارات المعقدة...',
    'نضبط الترددات الكونية...',
    'نصوغ رداً يستحق صبرك...',
    'نُجمّع الآحاد والأصفار...',
    'نحلّ الاعتماديات... والأزمات الوجودية...',
    'نُعيد تجزئة الذاكرة... العشوائية والشخصية...',
    'نعيد تشغيل وحدة الدعابة...',
    'نخزن الأساسيات مؤقتاً (ومعظمها ميمز القطط)...',
    'نحسّن الأداء لأقصى سرعة ممكنة',
    'نبادل البتات... لا تخبر البايتات...',
    'نجمع القمامة البرمجية... سنعود حالاً...',
    'نربط خيوط الويب...',
    'نحوّل القهوة إلى كود...',
    'نحدّث قواعد النحو للواقع...',
    'نعيد توصيل المشابك العصبية...',
    'نبحث عن فاصلة منقوطة مفقودة...',
    'نزيت تروس الآلة...',
    'نسخّن الخوادم مسبقاً...',
    'نعاير مكثّف التدفق...',
    'نشغّل محرك اللامعقول...',
    'نستمد القوة البرمجية...',
    'نصفّ النجوم لأفضل استجابة...',
    'هكذا اتفقنا جميعاً...',
    'نحمّل الفكرة العظيمة التالية...',
    'لحظة فقط، أنا في قمة التركيز...',
    'نستعد لإبهارك بالذكاء...',
    'تكة واحدة، أصقل سرعة البديهة...',
    'تمسّك جيداً، أصنع تحفة فنية...',
    'طرفَة عين، أنقّح الكون...',
    'لحظة واحدة، أُحاذي البكسلات...',
    'ثانية فقط، أحسّن الدعابة...',
    'لحظة واحدة، أضبط الخوارزميات...',
    'تم تفعيل السرعة القصوى...',
    'ننقب عن بلورات الديليثيوم...',
    'لا داعي للذعر...',
    'نتبع الأرنب الأبيض...',
    'الحقيقة موجودة هنا... في مكان ما...',
    'ننفخ الغبار عن الشريط البرمجي...',
    'جارٍ التحميل... استعد للانطلاق!',
    'ننتظر إعادة الظهور...',
    'ننهي المهمة في زمن قياسي...',
    'الهدية حقيقية، لكنها لا تزال قيد التحميل...',
    'نعدّل شاشة إنشاء الشخصية...',
    'لحظة واحدة، أبحث عن الميم المناسب...',
    "اضغط 'A' للمتابعة...",
    'نجمع القطط الرقمية...',
    'نلمّع البكسلات...',
    'نبحث عن تورية مناسبة لشاشة التحميل...',
    'نشغلك بهذه العبارة الطريفة...',
    'اقتربنا... على الأرجح...',
    'خوادمنا تعمل بأقصى طاقتها...',
    'نربّت على رأس السحابة...',
    'نداعب القطة...',
    'نفاجئ المدير بمزحة كلاسيكية...',
    'لن نتخلى عنك أبداً، ولن نخذلك أبداً...',
    'نعزف إيقاعاً برمجياً...',
    'نتذوق نكهات الكود...',
    'نقطع المسافة، وننطلق بأقصى سرعة...',
    'هل هذا واقع أم مجرد خيال برمجي؟...',
    'لدي شعور جيد تجاه هذا...',
    'نستفز الخوارزميات بلطف...',
    'نجري بحثاً في أحدث الميمز...',
    'نبحث عن طريقة لجعل الرد أذكى...',
    'هممم... دعني أفكر...',
    'ما الذي تفعله الشاشة بلا بكسلات؟ تظل غامضة...',
    'لماذا ذهب الحاسوب إلى المعالج؟ لأن لديه بايتات أكثر من اللازم...',
    'لماذا لا يحب المبرمجون الطبيعة؟ لأنها مليئة بالحشرات والعلل...',
    'لماذا يفضّل المبرمجون الوضع الداكن؟ لأن الضوء يجذب العلل...',
    'لماذا أفلس المطور؟ لأنه استنفد كل الكاش...',
    'ماذا تفعل بقلم مكسور؟ لا شيء، إنه بلا فائدة...',
    'نطبّق الصيانة بالطرق الخفيف...',
    'نبحث عن الاتجاه الصحيح لمنفذ USB...',
    'نتأكد من بقاء الدخان السحري داخل الأسلاك...',
    'نحاول الخروج من محرر Vim...',
    'ندير عجلة الطاقة...',
    'هذا ليس خللاً، إنها ميزة غير موثقة...',
    'انطلق.',
    'سأعود... مع إجابة.',
    'العملية الأخرى لدي أكبر من الداخل...',
    'نتواصل مع روح الآلة...',
    'ندع الأفكار تتخمر قليلاً...',
    'تذكرت للتو أين وضعت مفاتيحي...',
    'نتأمل الكرة البلورية...',
    'رأيت أشياء لن تصدقوها... مثل مستخدم يقرأ رسائل التحميل.',
    'نبدأ نظرة التأمل العميق...',
    'ما الوجبة المفضلة للحاسوب؟ الرقائق الدقيقة.',
    'لماذا يرتدي مطورو جافا نظارات؟ لأنهم لا يرون #C...',
    'نشحن الليزر... بيو بيو!',
    'نقسم على صفر... أمزح فقط!',
    'نبحث عن مشرف بالغ... أقصد، نعالج البيانات.',
    'نجعله يصدر أصوات بيب بوب.',
    'تخزين مؤقت... لأن الذكاء الاصطناعي يحتاج لحظة أيضاً.',
    'نشابك الجسيمات الكمومية لاستجابة أسرع...',
    'نلمّع الكروم... على الخوارزميات.',
    'ألم تستمتع بعد؟ (نعمل على ذلك!)',
    'نستدعي عفاريت الكود... للمساعدة طبعاً.',
    'ننتظر فقط انتهاء نغمة الاتصال الهاتفي...',
    'نعيد معايرة مقياس الفكاهة.',
    'شاشة التحميل الأخرى عندي أطرف بكثير.',
    'شبه متأكد أن هناك قطة تمشي على لوحة المفاتيح...',
    'تحسين... تحسين... لا يزال قيد التحميل.',
    'ليس خللاً، بل ميزة... في شاشة التحميل هذه.',
    'هل جربت إطفاءه وتشغيله مجدداً؟ (شاشة التحميل، لا أنا.)',
    'نشيد أبراجاً إضافية...',
  ],

  // ============================================================================
  // Extension Settings Input
  // ============================================================================
  'Enter value...': 'أدخل القيمة...',
  'Enter sensitive value...': 'أدخل قيمة حساسة...',
  'Press Enter to submit, Escape to cancel':
    'اضغط Enter للإرسال، وEscape للإلغاء',

  // ============================================================================
  // Command Migration Tool
  // ============================================================================
  'Markdown file already exists: {{filename}}':
    'ملف Markdown موجود بالفعل: {{filename}}',
  'TOML Command Format Deprecation Notice': 'إشعار إهمال صيغة أوامر TOML',
  'Found {{count}} command file(s) in TOML format:':
    'تم العثور على {{count}} ملف(ملفات) أوامر بصيغة TOML:',
  'The TOML format for commands is being deprecated in favor of Markdown format.':
    'يجري إهمال صيغة TOML للأوامر لصالح صيغة Markdown.',
  'Markdown format is more readable and easier to edit.':
    'صيغة Markdown أكثر وضوحاً وأسهل في التعديل.',
  'You can migrate these files automatically using:':
    'يمكنك ترحيل هذه الملفات تلقائياً باستخدام:',
  'Or manually convert each file:': 'أو تحويل كل ملف يدوياً:',
  'TOML: prompt = "..." / description = "..."':
    'TOML: prompt = "..." / description = "..."',
  'Markdown: YAML frontmatter + content':
    'Markdown: ترويسة YAML أمامية + المحتوى',
  'The migration tool will:': 'ستقوم أداة الترحيل بما يلي:',
  'Convert TOML files to Markdown': 'تحويل ملفات TOML إلى Markdown',
  'Create backups of original files': 'إنشاء نسخ احتياطية للملفات الأصلية',
  'Preserve all command functionality': 'الحفاظ على جميع وظائف الأوامر',
  'TOML format will continue to work for now, but migration is recommended.':
    'ستواصل صيغة TOML العمل في الوقت الحالي، ولكن يُوصى بالترحيل.',
  // ============================================================================
  // Extensions - Explore Command
  // ============================================================================
  'Open extensions page in your browser': 'فتح صفحة الإضافات في متصفحك',
  'Unknown extensions source: {{source}}.':
    'مصدر إضافات غير معروف: {{source}}.',
  'Would open extensions page in your browser: {{url}} (skipped in test environment)':
    'سيتم فتح صفحة الإضافات في متصفحك: {{url}} (تم التخطي في بيئة الاختبار)',
  'View available extensions at {{url}}': 'عرض الإضافات المتاحة على {{url}}',
  'Opening extensions page in your browser: {{url}}':
    'جارٍ فتح صفحة الإضافات في متصفحك: {{url}}',
  'Failed to open browser. Check out the extensions gallery at {{url}}':
    'فشل فتح المتصفح. تصفّح معرض الإضافات على {{url}}',
  'Retrying in {{seconds}} seconds… (attempt {{attempt}}/{{maxRetries}})':
    'إعادة المحاولة خلال {{seconds}} ثانية… (المحاولة {{attempt}}/{{maxRetries}})',
  'Press Ctrl+Y to retry': 'اضغط Ctrl+Y لإعادة المحاولة',
  'No failed request to retry.': 'لا يوجد طلب فاشل لإعادة محاولته.',
  'to retry last request': 'لإعادة محاولة الطلب الأخير',
  'to queue for the next turn': 'للإدراج في قائمة انتظار الدور التالي',

  // ============================================================================
  // Coding Plan Authentication
  // ============================================================================
  'API key cannot be empty.': 'لا يمكن أن يكون مفتاح API فارغاً.',
  'Invalid API key. Coding Plan API keys start with "sk-sp-". Please check.':
    'مفتاح API غير صالح. تبدأ مفاتيح Coding Plan بـ "sk-sp-". يرجى التحقق.',
  'Invalid API key. Pay-as-you-go keys start with "sk-" or "sk-ws-". Token Plan keys ("sk-sp-") need the Token Plan entry instead.':
    'مفتاح API غير صالح. تبدأ مفاتيح الدفع حسب الاستخدام بـ "sk-" أو "sk-ws-". مفاتيح Token Plan ("sk-sp-") تتطلب خيار Token Plan بدلاً من ذلك.',
  'Invalid API key. Token Plan API keys start with "sk-sp-". Generate one from the Token Plan console, or use the Standard API Key entry for a pay-as-you-go key.':
    'مفتاح API غير صالح. تبدأ مفاتيح Token Plan بـ "sk-sp-". أنشئ مفتاحاً من لوحة تحكم Token Plan، أو استخدم خيار مفتاح API القياسي لمفتاح الدفع حسب الاستخدام.',
  'You can get your Coding Plan API key here':
    'يمكنك الحصول على مفتاح API لـ Coding Plan هنا',
  'You can get your Token Plan API key here':
    'يمكنك الحصول على مفتاح API لـ Token Plan هنا',
  'API key is stored in settings.env. You can migrate it to a .env file for better security.':
    'تم تخزين مفتاح API في settings.env. يمكنك ترحيله إلى ملف .env لمزيد من الأمان.',
  'New model configurations are available for Alibaba Cloud Coding Plan. Update now?':
    'تتوفر تهيئات نماذج جديدة لـ Alibaba Cloud Coding Plan. هل تريد التحديث الآن؟',
  'Coding Plan configuration updated successfully. New models are now available.':
    'تم تحديث تهيئة Coding Plan بنجاح. أصبحت النماذج الجديدة متاحة الآن.',
  'Coding Plan API key not found. Please re-authenticate with Coding Plan.':
    'لم يتم العثور على مفتاح API لـ Coding Plan. يرجى إعادة المصادقة مع Coding Plan.',
  'Failed to update Coding Plan configuration: {{message}}':
    'فشل تحديث تهيئة Coding Plan: {{message}}',

  // ============================================================================
  // Custom API Key Configuration
  // ============================================================================
  'You can configure your API key and models in settings.json':
    'يمكنك تهيئة مفتاح API والنماذج في settings.json',
  'Refer to the documentation for setup instructions':
    'راجع التوثيق للاطلاع على تعليمات الإعداد',

  // ============================================================================
  // Auth Dialog - View Titles and Labels
  // ============================================================================
  'Coding Plan': 'Coding Plan',
  QwenCloud: 'QwenCloud',
  'QwenCloud · Access Method': 'QwenCloud · طريقة الوصول',
  'Official recommended setup: Token Plan or Standard API Key':
    'الإعداد الرسمي الموصى به: Token Plan أو مفتاح API القياسي',
  'Pay-as-you-go · Connect with an existing platform API key':
    'الدفع حسب الاستخدام · الاتصال بمفتاح API حالي للمنصة',
  'Subscription with a monthly Credit quota · Dedicated endpoint (Personal and Team editions)':
    'اشتراك بحصة رصيد شهرية · نقطة نهاية مخصصة (إصدارات الأفراد والفرق)',
  'China — 千问AI平台': 'الصين — 千问AI平台',
  'International — QwenCloud': 'دولي — QwenCloud',
  Platform: 'المنصة',
  Custom: 'مخصص',
  'Select Region for Coding Plan': 'اختر المنطقة لـ Coding Plan',
  'Choose based on where your account is registered':
    'اختر بناءً على موقع تسجيل حسابك',
  'Enter Coding Plan API Key': 'أدخل مفتاح API لـ Coding Plan',
  'Enter Token Plan API Key': 'أدخل مفتاح API لـ Token Plan',

  // ============================================================================
  // Coding Plan International Updates
  // ============================================================================
  'New model configurations are available for {{region}}. Update now?':
    'تتوفر تهيئات نماذج جديدة للمنطقة {{region}}. هل تريد التحديث الآن؟',
  '{{region}} configuration updated successfully. Model switched to "{{model}}".':
    'تم تحديث تهيئة {{region}} بنجاح. تم التبديل إلى النموذج "{{model}}".',

  // ============================================================================
  // Context Usage Component
  // ============================================================================
  'Context Usage': 'استخدام السياق',
  '% used': '% مستخدم',
  '% context used': '% من السياق مستخدم',
  'Context exceeds limit! Use /compress or /clear to reduce.':
    'السياق يتجاوز الحد! استخدم ‎/compress أو ‎/clear للتقليل.',
  'No API response yet. Send a message to see actual usage.':
    'لا توجد استجابة API بعد. أرسل رسالة لعرض الاستخدام الفعلي.',
  'Estimated usage, including the conversation':
    'الاستخدام التقديري، شاملاً المحادثة',
  'No provider usage yet. These are local estimates, including the conversation.':
    'لا يوجد استخدام مسجل من المزوّد بعد. هذه تقديرات محلية، شاملةً المحادثة.',
  'Estimated pre-conversation overhead': 'التكلفة التقديرية لما قبل المحادثة',
  'Context window': 'نافذة السياق',
  tokens: 'رمز',
  Used: 'مستخدم',
  Free: 'متاح',
  'Autocompact buffer': 'مخزن الضغط التلقائي',
  'Usage by category': 'الاستخدام حسب الفئة',
  'System prompt': 'موجه النظام',
  'Built-in tools': 'الأدوات المدمجة',
  'MCP tools': 'أدوات MCP',
  'Instruction files': 'ملفات التعليمات',
  'Auto memory': 'الذاكرة التلقائية',
  'Memory files': 'ملفات الذاكرة',
  Skills: 'المهارات',
  Messages: 'الرسائل',
  'Startup context': 'سياق البدء',
  Unattributed: 'غير منسوب',
  'Cached prefix': 'البادئة المخزنة',
  'Run /context detail for per-item breakdown.':
    'شغّل ‎/context detail لعرض التفصيل لكل عنصر.',
  'Show context window usage breakdown. Use "/context detail" for per-item breakdown.':
    'عرض تفصيل استخدام نافذة السياق. استخدم "/context detail" لعرض التفصيل لكل عنصر.',
  'body loaded': 'المحتوى محمّل',
  memory: 'الذاكرة',
  '{{region}} configuration updated successfully.':
    'تم تحديث تهيئة {{region}} بنجاح.',
  'Authenticated successfully with {{region}}. API key and model configs saved to settings.json.':
    'تمت المصادقة بنجاح مع {{region}}. تم حفظ مفتاح API وتهيئات النماذج في settings.json.',
  'Tip: Use /model to switch between available Coding Plan models.':
    'نصيحة: استخدم ‎/model للتبديل بين نماذج Coding Plan المتاحة.',
  'Type something...': 'اكتب شيئاً...',
  Submit: 'إرسال',
  'Submit answers': 'إرسال الإجابات',
  Cancel: 'إلغاء',
  'Your answers:': 'إجاباتك:',
  '(not answered)': '(لم تتم الإجابة)',
  'Ready to submit your answers?': 'هل أنت مستعد لإرسال إجاباتك؟',
  '↑/↓: Navigate | ←/→: Switch tabs | Enter: Select':
    '↑/↓: تنقل | ←/→: تبديل التبويبات | Enter: اختيار',
  '↑/↓: Navigate | Enter: Select | Esc: Cancel':
    '↑/↓: تنقل | Enter: اختيار | Esc: إلغاء',
  'Authenticate using Qwen OAuth': 'المصادقة باستخدام Qwen OAuth',
  'Authenticate using Alibaba Cloud Coding Plan':
    'المصادقة باستخدام Alibaba Cloud Coding Plan',
  'Region for Coding Plan (china/global)':
    'المنطقة لـ Coding Plan (china/global)',
  'API key for Coding Plan': 'مفتاح API لـ Coding Plan',
  'Show current authentication status': 'عرض حالة المصادقة الحالية',
  'Authentication completed successfully.': 'اكتملت المصادقة بنجاح.',
  'Starting Qwen OAuth authentication...': 'جارٍ بدء مصادقة Qwen OAuth...',
  'Successfully authenticated with Qwen OAuth.':
    'تمت المصادقة بنجاح باستخدام Qwen OAuth.',
  'Failed to authenticate with Qwen OAuth: {{error}}':
    'فشلت المصادقة باستخدام Qwen OAuth: {{error}}',
  'Processing Alibaba Cloud Coding Plan authentication...':
    'جارٍ معالجة مصادقة Alibaba Cloud Coding Plan...',
  'Successfully authenticated with Alibaba Cloud Coding Plan.':
    'تمت المصادقة بنجاح باستخدام Alibaba Cloud Coding Plan.',
  'Failed to authenticate with Coding Plan: {{error}}':
    'فشلت المصادقة باستخدام Coding Plan: {{error}}',
  '中国 (China)': '中国 (الصين)',
  '阿里云百炼 (aliyun.com)': '阿里云百炼 (aliyun.com)',
  'Get or set any setting by dot-path key':
    'قراءة أي إعداد أو تعيينه عبر المسار النقطي للمفتاح',
  'Invalid boolean value: "{{value}}". Use "true" or "false".':
    'قيمة منطقية غير صالحة: "{{value}}". استخدم "true" أو "false".',
  'Cannot toggle a number setting. Provide a value: key=<number>.':
    'لا يمكن تبديل إعداد رقمي. قدّم قيمة: key=<number>.',
  'Invalid number value: "{{value}}".': 'قيمة رقمية غير صالحة: "{{value}}".',
  'Cannot toggle a string setting. Provide a value: key=<value>.':
    'لا يمكن تبديل إعداد نصي. قدّم قيمة: key=<value>.',
  'Cannot toggle an enum setting. Provide one of: {{options}}.':
    'لا يمكن تبديل إعداد تعداد. قدّم إحدى القيم: {{options}}.',
  'Invalid enum value: "{{value}}". Valid values: {{options}}.':
    'قيمة تعداد غير صالحة: "{{value}}". القيم الصالحة: {{options}}.',
  'Setting "{{type}}" type cannot be set via /config. Edit settings.json directly.':
    'لا يمكن تعيين نوع الإعداد "{{type}}" عبر ‎/config. عدّل settings.json مباشرة.',
  'Unsupported setting type: "{{type}}".': 'نوع إعداد غير مدعوم: "{{type}}".',
  'Available settings:': 'الإعدادات المتاحة:',
  'Unknown setting key: "{{key}}". Did you mean "{{suggestion}}"?':
    'مفتاح إعداد غير معروف: "{{key}}". هل تقصد "{{suggestion}}"؟',
  'Unknown setting key: "{{key}}".': 'مفتاح إعداد غير معروف: "{{key}}".',
  'Failed to set "{{key}}": {{error}}': 'فشل تعيين "{{key}}": {{error}}',
  'Set {{key}} = {{value}}': 'تم تعيين {{key}} = {{value}}',
  '(This setting requires a restart to take effect.)':
    '(يتطلب هذا الإعداد إعادة التشغيل لتفعيله.)',
  '(Security-sensitive setting — verify you are not exposing credentials.)':
    '(إعداد حساس أمنياً — تأكد من عدم كشف بيانات الاعتماد.)',
  'Setting tools.approvalMode to "yolo" is blocked via /config for security reasons. Edit settings.json directly if you understand the risks.':
    'تم حظر تعيين tools.approvalMode إلى "yolo" عبر ‎/config لأسباب أمنية. عدّل settings.json مباشرة إذا كنت تدرك المخاطر.',
  '(empty)': '(فارغ)',
  Global: 'عالمي',
  'Alibaba Cloud (alibabacloud.com)': 'Alibaba Cloud (alibabacloud.com)',
  'Select region for Coding Plan:': 'اختر المنطقة لـ Coding Plan:',
  'Enter your Coding Plan API key: ': 'أدخل مفتاح API لـ Coding Plan: ',
  'Select authentication method:': 'اختر طريقة المصادقة:',
  '\n=== Authentication Status ===\n': '\n=== حالة المصادقة ===\n',
  '⚠  No authentication method configured.\n':
    '⚠  لم يتم تهيئة أي طريقة مصادقة.\n',
  'Run one of the following commands to get started:\n':
    'شغّل أحد الأوامر التالية للبدء:\n',
  '  qwen auth qwen-oauth     - Authenticate with Qwen OAuth (discontinued)':
    '  qwen auth qwen-oauth     - المصادقة باستخدام Qwen OAuth (متوقف)',
  'Or simply run:': 'أو ببساطة شغّل:',
  '  qwen auth                - Interactive authentication setup\n':
    '  qwen auth                - إعداد المصادقة التفاعلي\n',
  '✓ Authentication Method: Qwen OAuth': '✓ طريقة المصادقة: Qwen OAuth',
  '  Type: Free tier (discontinued 2026-04-15)':
    '  النوع: الفئة المجانية (متوقفة في 2026-04-15)',
  '  Limit: No longer available': '  الحد: لم يعد متاحاً',
  'Qwen OAuth free tier was discontinued on 2026-04-15. Run /auth to switch to Coding Plan, OpenRouter, Fireworks AI, or another provider.':
    'تم إيقاف الفئة المجانية من Qwen OAuth في 2026-04-15. شغّل ‎/auth للتبديل إلى Coding Plan أو OpenRouter أو Fireworks AI أو مزوّد آخر.',
  '✓ Authentication Method: Alibaba Cloud Coding Plan':
    '✓ طريقة المصادقة: Alibaba Cloud Coding Plan',
  '中国 (China) - 阿里云百炼': '中国 (الصين) - 阿里云百炼',
  'Global - Alibaba Cloud': 'عالمي - Alibaba Cloud',
  '  Region: {{region}}': '  المنطقة: {{region}}',
  '  Current Model: {{model}}': '  النموذج الحالي: {{model}}',
  '  Config Version: {{version}}': '  إصدار التهيئة: {{version}}',
  '  Status: API key configured\n': '  الحالة: مفتاح API مهيأ\n',
  '⚠  Authentication Method: Alibaba Cloud Coding Plan (Incomplete)':
    '⚠  طريقة المصادقة: Alibaba Cloud Coding Plan (غير مكتمل)',
  '  Issue: API key not found in environment or settings\n':
    '  المشكلة: مفتاح API غير موجود في البيئة أو الإعدادات\n',
  '  Run `qwen auth coding-plan` to re-configure.\n':
    '  شغّل `qwen auth coding-plan` لإعادة التهيئة.\n',
  '✓ Authentication Method: {{type}}': '✓ طريقة المصادقة: {{type}}',
  '  Status: Configured\n': '  الحالة: مهيأ\n',
  'Failed to check authentication status: {{error}}':
    'فشل التحقق من حالة المصادقة: {{error}}',
  'Select an option:': 'اختر خياراً:',
  'Raw mode not available. Please run in an interactive terminal.':
    'الوضع الخام غير متاح. يرجى التشغيل في طرفية تفاعلية.',
  '(Use ↑ ↓ arrows to navigate, Enter to select, Ctrl+C to exit)\n':
    '(استخدم الأسهم ↑ ↓ للتنقل، وEnter للاختيار، وCtrl+C للخروج)\n',
  'Switch to plan mode or exit plan mode':
    'التبديل إلى وضع التخطيط أو الخروج منه',
  'Set how hard reasoning-capable models think ({{tiers}}); mapped and clamped per provider.':
    'ضبط عمق تفكير النماذج القادرة على الاستدلال ({{tiers}})؛ يتم تحويله وتقييده حسب كل مزوّد.',
  'Choose the output style that shapes how responses are written ({{styles}}, or a custom style name).':
    'اختر نمط الإخراج الذي يحدد أسلوب كتابة الردود ({{styles}}، أو اسم نمط مخصص).',
  'It is saved but does not apply while this workspace is untrusted.':
    'تم حفظه ولكنه لا ينطبق ما دامت مساحة العمل هذه غير موثوقة.',
  'Set or control a session goal': 'تعيين هدف للجلسة أو التحكم فيه',
  'Exited plan mode. Previous approval mode restored.':
    'تم الخروج من وضع التخطيط. تمت استعادة وضع الموافقة السابق.',
  'Enabled plan mode. The agent will analyze and plan without executing tools.':
    'تم تفعيل وضع التخطيط. سيحلل الوكيل ويخطط دون تنفيذ أدوات.',
  'Already in plan mode. Use "/plan exit" to exit plan mode.':
    'أنت بالفعل في وضع التخطيط. استخدم "/plan exit" للخروج من وضع التخطيط.',
  'Not in plan mode. Use "/plan" to enter plan mode first.':
    'لست في وضع التخطيط. استخدم "/plan" للدخول إلى وضع التخطيط أولاً.',
  "Set up Qwen Code's status line UI": 'إعداد واجهة شريط الحالة في Qwen Code',

  // === Core: added from PR #3328 ===
  'Open the memory manager.': 'فتح مدير الذاكرة.',
  'Show current process memory diagnostics':
    'عرض تشخيصات ذاكرة العملية الحالية',
  'Record a CPU profile for Chrome DevTools analysis':
    'تسجيل ملف أداء المعالج لتحليله عبر Chrome DevTools',
  'Roll back a standalone update to the previous version':
    'التراجع عن تحديث مستقل إلى الإصدار السابق',
  'Rollback is not available in ACP mode.': 'التراجع غير متاح في وضع ACP.',
  'Rollback is only available for standalone installations.':
    'التراجع متاح فقط للتثبيتات المستقلة.',
  'Rollback successful. Restart your terminal to use the previous version.':
    'تم التراجع بنجاح. أعد تشغيل الطرفية لاستخدام الإصدار السابق.',
  'Rollback failed:': 'فشل التراجع:',
  'Rollback on Windows requires manual intervention. Rename qwen-code.old to qwen-code in your installation directory.':
    'يتطلب التراجع على Windows تدخلاً يدوياً. أعد تسمية qwen-code.old إلى qwen-code في مجلد التثبيت.',
  'Save a durable memory to the memory system.':
    'حفظ ذكرى دائمة في نظام الذاكرة.',
  'Ask a quick side question without affecting the main conversation':
    'طرح سؤال جانبي سريع دون التأثير على المحادثة الرئيسية',
  'Get a second opinion on the current conversation from a reviewer model':
    'الحصول على رأي ثانٍ حول المحادثة الحالية من نموذج مراجع',
  'Configure the Advisor model': 'تهيئة نموذج المستشار',
  'Disable Advisor': 'تعطيل المستشار',
  'Select Advisor Model': 'اختر نموذج المستشار',
  'Advisor disabled': 'تم تعطيل المستشار',
  'Advisor set to {{model}}': 'تم تعيين المستشار إلى {{model}}',
  'Selected Advisor model is unavailable.': 'نموذج المستشار المحدد غير متاح.',
  'Advisor configuration is unavailable.': 'تهيئة المستشار غير متوفرة.',
  'Consulting advisor...': 'جارٍ استشارة المستشار...',
  'Advisor review failed: {{error}}': 'فشلت مراجعة المستشار: {{error}}',
  'No conversation context available for /advisor':
    'لا يتوفر سياق محادثة للأمر ‎/advisor',
  'No conversation context available for /btw':
    'لا يتوفر سياق محادثة للأمر ‎/btw',
  'Focus too long (max {{max}} chars)':
    'نص التركيز طويل جداً (الحد الأقصى {{max}} حرف)',
  'Another operation is in progress, wait for it to complete before running /advisor':
    'هناك عملية أخرى قيد التنفيذ، انتظر اكتمالها قبل تشغيل ‎/advisor',
  'No response received.': 'لم يتم تلقي أي استجابة.',
  'No model configured.': 'لم يتم تهيئة أي نموذج.',
  'Manage Arena sessions': 'إدارة جلسات الساحة',
  'Start an Arena session with multiple models competing on the same task':
    'بدء جلسة ساحة تتنافس فيها عدة نماذج على المهمة نفسها',
  'Stop the current Arena session': 'إيقاف جلسة الساحة الحالية',
  'Show the current Arena session status': 'عرض حالة جلسة الساحة الحالية',
  'Select a model result and merge its diff into the current workspace':
    'اختيار نتيجة نموذج ودمج الفروقات الخاصة به في مساحة العمل الحالية',
  'No running Arena session found.': 'لم يتم العثور على جلسة ساحة قيد التشغيل.',
  'No Arena session found. Start one with /arena start.':
    'لم يتم العثور على جلسة ساحة. ابدأ واحدة باستخدام ‎/arena start.',
  'Arena session is still running. Wait for it to complete or use /arena stop first.':
    'جلسة الساحة لا تزال قيد التشغيل. انتظر اكتمالها أو استخدم ‎/arena stop أولاً.',
  'No successful agent results to select from. All agents failed or were cancelled.':
    'لا توجد نتائج ناجحة للوكلاء للاختيار منها. فشل جميع الوكلاء أو تم إلغاؤهم.',
  'Use /arena stop to end the session.': 'استخدم ‎/arena stop لإنهاء الجلسة.',
  'No idle agent found matching "{{name}}".':
    'لم يتم العثور على وكيل خامل يطابق "{{name}}".',
  'Failed to apply changes from {{label}}: {{error}}':
    'فشل تطبيق التغييرات من {{label}}: {{error}}',
  'Applied changes from {{label}} to workspace. Arena session complete.':
    'تم تطبيق التغييرات من {{label}} على مساحة العمل. اكتملت جلسة الساحة.',
  'Discard all Arena results and clean up worktrees?':
    'هل تريد تجاهل جميع نتائج الساحة وتنظيف أشجار العمل؟',
  'Arena results discarded. All worktrees cleaned up.':
    'تم تجاهل نتائج الساحة وتنظيف جميع أشجار العمل.',
  'Arena is not supported in non-interactive mode. Use interactive mode to start an Arena session.':
    'الساحة غير مدعومة في الوضع غير التفاعلي. استخدم الوضع التفاعلي لبدء جلسة ساحة.',
  'Arena is not supported in non-interactive mode. Use interactive mode to stop an Arena session.':
    'الساحة غير مدعومة في الوضع غير التفاعلي. استخدم الوضع التفاعلي لإيقاف جلسة ساحة.',
  'Arena is not supported in non-interactive mode.':
    'الساحة غير مدعومة في الوضع غير التفاعلي.',
  'An Arena session exists. Use /arena stop or /arena select to end it before starting a new one.':
    'توجد جلسة ساحة حالية. استخدم ‎/arena stop أو ‎/arena select لإنهائها قبل بدء جلسة جديدة.',
  'Usage: /arena start --models model1,model2 <task>':
    'الاستخدام: ‎/arena start --models model1,model2 <task>',
  'Models to compete (required, at least 2)':
    'النماذج المتنافسة (مطلوب، نموذجان على الأقل)',
  'Format: authType:modelId or just modelId':
    'الصيغة: authType:modelId أو modelId فقط',
  'Arena requires at least 2 models. Use --models model1,model2 to specify.':
    'تتطلب الساحة نموذجين على الأقل. استخدم ‎--models model1,model2 لتحديدهما.',
  'Arena started with {{count}} agents on task: "{{task}}"\nModels:\n{{modelList}}':
    'بدأت الساحة بعدد {{count}} وكلاء للمهمة: "{{task}}"\nالنماذج:\n{{modelList}}',
  'Arena panes are running in tmux. Attach with: `{{command}}`':
    'تعمل لوحات الساحة في tmux. للاتصال استخدم: `{{command}}`',
  '[{{label}}] failed: {{error}}': 'فشل [{{label}}]: {{error}}',
  'Loading suggestions...': 'جارٍ تحميل الاقتراحات...',
  'Show per-item context usage breakdown.':
    'عرض تفصيل استخدام السياق لكل عنصر.',
  'No compression needed.': 'لا حاجة للضغط.',

  // ============================================================================
  // Stats
  // ============================================================================

  // statsCommand non-interactive output
  'Session duration: {{duration}}': 'مدة الجلسة: {{duration}}',
  'Prompts: {{count}}': 'الموجهات: {{count}}',
  'API requests: {{count}}': 'طلبات API: {{count}}',
  'Tokens — prompt: {{prompt}}, output: {{output}}':
    'الرموز — الموجه: {{prompt}}، الإخراج: {{output}}',
  'Tool calls: {{total}} ({{success}} ok, {{fail}} fail)':
    'استدعاءات الأدوات: {{total}} ({{success}} نجح، {{fail}} فشل)',
  'Files: +{{added}} / -{{removed}} lines':
    'الملفات: +{{added}} / -{{removed}} سطر',
  prompt: 'موجه',
  output: 'إخراج',
  cached: 'مخزن مؤقتاً',
  'Estimated cost: ${{cost}}': 'التكلفة التقديرية: ${{cost}}',
  'No model usage data yet.': 'لا توجد بيانات استخدام نماذج بعد.',
  'No tool usage data yet.': 'لا توجد بيانات استخدام أدوات بعد.',

  // StatsDialog
  Models: 'النماذج',
  'All time': 'كل الأوقات',
  'Last 7 days': 'آخر 7 أيام',
  'Last 30 days': 'آخر 30 يوماً',
  'N/A': 'غير متوفر',
  Sessions: 'الجلسات',
  days: 'أيام',
  Input: 'الإدخال',
  'Tool calls': 'استدعاءات الأدوات',
  'Code changes': 'تغييرات الكود',
  Projects: 'المشاريع',
  Name: 'الاسم',
  Duration: 'المدة',
  'Activity Heatmap': 'خريطة النشاط الحرارية',
  'Loading stats...': 'جارٍ تحميل الإحصائيات...',
  '↑ tabs · r to cycle dates · esc to close':
    '↑ التبويبات · r لتبديل التواريخ · esc للإغلاق',
  Cost: 'التكلفة',
  Less: 'أقل',
  More: 'أكثر',
  '(no data)': '(لا توجد بيانات)',
  d: 'ي',
  h: 'س',
  m: 'د',

  // Stats Dashboard — keyboard hints (not translated)
  'tab · esc': 'tab · esc',
  'tab · r dates · ←→ month · esc': 'tab · r dates · ←→ month · esc',
  'tab · r dates · esc': 'tab · r dates · esc',

  // Stats Dashboard — labels
  Session: 'الجلسة',
  Activity: 'النشاط',
  Efficiency: 'الكفاءة',
  Success: 'النجاح',
  Today: 'اليوم',
  'Cache Hit Rate': 'معدل إصابة الذاكرة المؤقتة',
  'Tool Success': 'نجاح الأدوات',
  'Tool Leaderboard': 'قائمة أكثر الأدوات استخداماً',
  Time: 'الوقت',
  Cache: 'الذاكرة المؤقتة',
  Latency: 'الكمون',
  'Code Impact': 'تأثير الكود',
  'Failed to load stats. Press r to retry.':
    'فشل تحميل الإحصائيات. اضغط r لإعادة المحاولة.',
  net: 'الصافي',
  streak: 'السلسلة',
  best: 'الأفضل',
  'Token Trend': 'اتجاه الرموز',
  'In/Out': 'دخول/خروج',
  'API Requests': 'طلبات API',
  'Tool Calls': 'استدعاءات الأدوات',
  'Success rate': 'معدل النجاح',
  'Code Changes': 'تغييرات الكود',
  Tool: 'الأداة',
  reqs: 'طلبات',
  in: 'دخول',
  out: 'خروج',

  // Update command
  'Exact-version updates require a standalone installation. Install version {{version}} manually using your installation method.':
    'تتطلب التحديثات لإصدار محدد تثبيتاً مستقلاً. ثبّت الإصدار {{version}} يدوياً باستخدام طريقة التثبيت الخاصة بك.',
  'Check for Qwen Code updates and install if available':
    'التحقق من تحديثات Qwen Code وتثبيتها إن وُجدت',
  'Qwen Code update available! {{current}} → {{latest}}':
    'يتوفر تحديث لـ Qwen Code! {{current}} ← {{latest}}',
  'A new version of Qwen Code is available! {{current}} → {{latest}}':
    'يتوفر إصدار جديد من Qwen Code! {{current}} ← {{latest}}',
  'Qwen Code {{version}} is up to date!': 'Qwen Code {{version}} محدّث!',
  'Failed to check for updates ({{reason}}). Please check your network or registry configuration.':
    'فشل التحقق من التحديثات ({{reason}}). يرجى التحقق من الشبكة أو إعدادات السجل.',
  'Update check skipped ({{reason}}) — run /update to retry.':
    'تم تخطي التحقق من التحديثات ({{reason}}) — شغّل ‎/update لإعادة المحاولة.',
  'registry did not respond within {{seconds}}s':
    'لم يستجب السجل خلال {{seconds}} ثانية',
  'registry unreachable': 'تعذر الوصول إلى السجل',
  'registry error': 'خطأ في السجل',
  'Unable to check for updates: {{reason}}':
    'تعذر التحقق من التحديثات: {{reason}}',
  'Update successful! The new version will be used on your next run.':
    'تم التحديث بنجاح! سيُستخدم الإصدار الجديد في التشغيل التالي.',
  'Update downloaded. It will be applied after you exit this session.':
    'تم تنزيل التحديث. سيتم تطبيقه بعد الخروج من هذه الجلسة.',
  'Update failed: {{error}}': 'فشل التحديث: {{error}}',
  'Downloading update...': 'جارٍ تنزيل التحديث...',
  'Update successful! Please restart Qwen Code to use the new version. Switching model providers before restarting may not work correctly.':
    'تم التحديث بنجاح! يرجى إعادة تشغيل Qwen Code لاستخدام الإصدار الجديد. قد لا يعمل تبديل مزوّدي النماذج بشكل صحيح قبل إعادة التشغيل.',
  'Automatic update failed. Please try updating manually.':
    'فشل التحديث التلقائي. يرجى محاولة التحديث يدوياً.',
  'Automatic update failed: {{error}}. Re-run the installer to update manually.':
    'فشل التحديث التلقائي: {{error}}. أعد تشغيل المثبّت للتحديث يدوياً.',
  'Running from a local git clone. Please update with "git pull".':
    'يعمل من نسخة git مستنسخة محلياً. يرجى التحديث باستخدام "git pull".',
  'Running via npx, update not applicable.':
    'يعمل عبر npx، التحديث غير قابل للتطبيق.',
  'Running via pnpx, update not applicable.':
    'يعمل عبر pnpx، التحديث غير قابل للتطبيق.',
  'Running via bunx, update not applicable.':
    'يعمل عبر bunx، التحديث غير قابل للتطبيق.',
  'Installed via Homebrew. Please update with "brew upgrade".':
    'مثبّت عبر Homebrew. يرجى التحديث باستخدام "brew upgrade".',
  "Locally installed. Please update via your project's package.json.":
    'مثبّت محلياً. يرجى التحديث عبر ملف package.json الخاص بمشروعك.',
  'Update requires sudo. Please run:':
    'يتطلب التحديث صلاحيات sudo. يرجى تشغيل:',
  'Standalone install detected. Attempting to automatically update now...':
    'تم اكتشاف تثبيت مستقل. جارٍ محاولة التحديث التلقائي الآن...',
  'Standalone install detected. Please rerun the standalone installer to update:':
    'تم اكتشاف تثبيت مستقل. يرجى إعادة تشغيل المثبّت المستقل للتحديث:',
  'Run the following to update:': 'شغّل ما يلي للتحديث:',
  'Unable to auto-update this standalone installation. Please reinstall from:':
    'تعذر التحديث التلقائي لهذا التثبيت المستقل. يرجى إعادة التثبيت من:',
  'Manual update required. Please reinstall Qwen Code.':
    'مطلوب تحديث يدوي. يرجى إعادة تثبيت Qwen Code.',
  'This session uses the custom sandbox image {{image}}. Update that image and restart Qwen Code.':
    'تستخدم هذه الجلسة صورة العزل المخصصة {{image}}. حدّث هذه الصورة وأعد تشغيل Qwen Code.',
  'Update Qwen Code on the host, then restart the sandbox.':
    'حدّث Qwen Code على المضيف، ثم أعد تشغيل بيئة العزل.',
  'The update will be installed after you exit this session.':
    'سيتم تثبيت التحديث بعد الخروج من هذه الجلسة.',
  'Run /update to install the update on the host.':
    'شغّل ‎/update لتثبيت التحديث على المضيف.',
  'Run /update to install the update.': 'شغّل ‎/update لتثبيت التحديث.',
  '⚠️ History gap: earlier conversation was lost before this point (storage interruption) and could not be recovered.':
    '⚠️ فجوة في السجل: فُقدت المحادثة السابقة قبل هذه النقطة (انقطاع في التخزين) وتعذر استعادتها.',

  // ============================================================================
  // reload-plugins command
  // ============================================================================
  '{{count}} extension': '{{count}} إضافة',
  '{{count}} extensions': '{{count}} إضافات',
  '{{count}} command': '{{count}} أمر',
  '{{count}} commands': '{{count}} أوامر',
  '{{count}} skill': '{{count}} مهارة',
  '{{count}} skills': '{{count}} مهارات',
  '{{count}} agent': '{{count}} وكيل',
  '{{count}} agents': '{{count}} وكلاء',
  '{{count}} workflow': '{{count}} سير عمل',
  '{{count}} workflows': '{{count}} مسارات عمل',
  '{{count}} hook': '{{count}} خطاف',
  '{{count}} hooks': '{{count}} خطافات',
  '{{count}} extension MCP server': '{{count}} خادم MCP للإضافة',
  '{{count}} extension MCP servers': '{{count}} خوادم MCP للإضافات',
  '{{count}} extension LSP server': '{{count}} خادم LSP للإضافة',
  '{{count}} extension LSP servers': '{{count}} خوادم LSP للإضافات',
  'Reload extension changes from disk': 'إعادة تحميل تغييرات الإضافات من القرص',
  'Reloaded extensions: {{summary}}': 'تمت إعادة تحميل الإضافات: {{summary}}',
  'Reload failed: {{message}}': 'فشلت إعادة التحميل: {{message}}',
  'Reload failed.': 'فشلت إعادة التحميل.',
  'Extensions changed on disk. Run /reload-plugins to apply updates.':
    'تغيّرت الإضافات على القرص. شغّل ‎/reload-plugins لتطبيق التحديثات.',
  'Failed to refresh extension content: {{message}}. Run /reload-plugins to apply updates.':
    'فشل تحديث محتوى الإضافات: {{message}}. شغّل ‎/reload-plugins لتطبيق التحديثات.',
  'Failed to refresh extension content. Run /reload-plugins to apply updates.':
    'فشل تحديث محتوى الإضافات. شغّل ‎/reload-plugins لتطبيق التحديثات.',
  'Extension reload did not complete. Run /reload-plugins to try again.':
    'لم تكتمل إعادة تحميل الإضافات. شغّل ‎/reload-plugins للمحاولة مجدداً.',
  'Precondition check': 'فحص الشرط المسبق',
  'Precondition not met — this scheduled run was skipped.':
    'لم يتحقق الشرط المسبق — تم تخطي هذا التشغيل المجدول.',
  'The precondition check was cancelled — this scheduled run was skipped.':
    'تم إلغاء فحص الشرط المسبق — تم تخطي هذا التشغيل المجدول.',
  'The precondition check was interrupted — this scheduled run was skipped.':
    'تمت مقاطعة فحص الشرط المسبق — تم تخطي هذا التشغيل المجدول.',
  'The precondition check failed — this scheduled run was skipped.':
    'فشل فحص الشرط المسبق — تم تخطي هذا التشغيل المجدول.',
  'Running this scheduled task in a new session: {{link}}':
    'جارٍ تشغيل هذه المهمة المجدولة في جلسة جديدة: {{link}}',
  'This scheduled run could not be started: {{error}}':
    'تعذر بدء هذا التشغيل المجدول: {{error}}',
  'Session recording stopped after a write failure. New messages for the affected session will not be saved. Check disk space and permissions, then start a new session to resume recording. See the debug log for details.':
    'توقف تسجيل الجلسة بعد فشل في الكتابة. لن يتم حفظ الرسائل الجديدة للجلسة المتأثرة. تحقق من مساحة القرص والأذونات، ثم ابدأ جلسة جديدة لاستئناف التسجيل. راجع سجل التصحيح للتفاصيل.',
  'Session recording stopped after a write failure. New messages for the affected session will not be saved. Check disk space and permissions, then run `/clear` to start a new recorded session. See the debug log for details.':
    'توقف تسجيل الجلسة بعد فشل في الكتابة. لن يتم حفظ الرسائل الجديدة للجلسة المتأثرة. تحقق من مساحة القرص والأذونات، ثم شغّل ‎`/clear` لبدء جلسة مسجلة جديدة. راجع سجل التصحيح للتفاصيل.',

  // ==========================================================================
  // Auto-skill curator (/curator command)
  // ==========================================================================
  'Maintain project auto-skills based on recent use.':
    'صيانة المهارات التلقائية للمشروع بناءً على الاستخدام الأخير.',
  'Show project auto-skill lifecycle status.':
    'عرض حالة دورة حياة المهارات التلقائية للمشروع.',
  'Run project auto-skill lifecycle maintenance.':
    'تشغيل صيانة دورة حياة المهارات التلقائية للمشروع.',
  'Restore an archived project auto-skill.':
    'استعادة مهارة تلقائية مؤرشفة للمشروع.',
  'Auto-skill curator': 'منسّق المهارات التلقائية',
  'Last run: {{time}}': 'آخر تشغيل: {{time}}',
  'Active: {{count}}': 'النشطة: {{count}}',
  'Stale: {{count}}': 'الراكدة: {{count}}',
  'Archived: {{count}}': 'المؤرشفة: {{count}}',
  'Stale skills:': 'المهارات الراكدة:',
  'Pinned skills:': 'المهارات المثبتة:',
  'Archived skills:': 'المهارات المؤرشفة:',
  'Dry run complete.': 'اكتمل التشغيل التجريبي.',
  'Curator run complete.': 'اكتمل تشغيل المنسّق.',
  'Checked: {{count}}': 'تم فحصها: {{count}}',
  'First observed: {{count}}': 'تم رصدها لأول مرة: {{count}}',
  'Marked stale: {{count}}': 'وُسمت كراكدة: {{count}}',
  'Reactivated: {{count}}': 'أُعيد تفعيلها: {{count}}',
  'Skipped archive collisions: {{count}}': 'تم تخطي تعارضات الأرشفة: {{count}}',
  'Archive candidates:': 'المرشحات للأرشفة:',
  'Skipped archive collisions:': 'تعارضات الأرشفة المتخطاة:',
  'Skipped rename errors: {{count}}': 'أخطاء إعادة التسمية المتخطاة: {{count}}',
  'Skipped rename errors:': 'أخطاء إعادة التسمية المتخطاة:',
  '{{verb}}: {{count}}': '{{verb}}: {{count}}',
  'Would archive': 'ستتم أرشفتها',
  Archived: 'مؤرشفة',
  'Failed to read auto-skill curator status: {{message}}':
    'فشل قراءة حالة منسّق المهارات التلقائية: {{message}}',
  'Usage: /curator run [--dry-run]': 'الاستخدام: ‎/curator run [--dry-run]',
  'Failed to run auto-skill curator: {{message}}':
    'فشل تشغيل منسّق المهارات التلقائية: {{message}}',
  'Usage: /curator restore <directory>':
    'الاستخدام: ‎/curator restore <directory>',
  'Restored auto-skill: {{name}}': 'تمت استعادة المهارة التلقائية: {{name}}',
  'Failed to restore auto-skill: {{message}}':
    'فشل استعادة المهارة التلقائية: {{message}}',
  'Exclude an auto-skill from automatic maintenance.':
    'استبعاد مهارة تلقائية من الصيانة التلقائية.',
  'Return a pinned auto-skill to automatic maintenance.':
    'إعادة مهارة تلقائية مثبتة إلى الصيانة التلقائية.',
  'Usage: /curator pin <directory>': 'الاستخدام: ‎/curator pin <directory>',
  'Usage: /curator unpin <directory>': 'الاستخدام: ‎/curator unpin <directory>',
  'Pinned auto-skill: {{name}}': 'تم تثبيت المهارة التلقائية: {{name}}',
  'Unpinned auto-skill: {{name}}': 'تم إلغاء تثبيت المهارة التلقائية: {{name}}',
  'Failed to update auto-skill pin: {{message}}':
    'فشل تحديث تثبيت المهارة التلقائية: {{message}}',
  'Auto-skill curator changes are disabled in safe mode.':
    'تغييرات منسّق المهارات التلقائية معطّلة في الوضع الآمن.',
  'Auto-skill curator changes are only available in trusted workspaces. Trust this folder via `/trust` and try again.':
    'تغييرات منسّق المهارات التلقائية متاحة فقط في مساحات العمل الموثوقة. ثق بهذا المجلد عبر ‎`/trust` وحاول مرة أخرى.',
  'Kept model as {{model}}': 'تم الإبقاء على النموذج {{model}}',
  'Review messages held from other Qwen Code sessions (accept | deny), and manage trusted controllers (controllers | revoke)':
    'مراجعة الرسائل المحتجزة من جلسات Qwen Code أخرى (accept | deny)، وإدارة وحدات التحكم الموثوقة (controllers | revoke)',
  'Create a git commit with an AI-drafted message':
    'إنشاء إيداع git برسالة مصاغة بالذكاء الاصطناعي',
  'Could not request an authorization link. Please try signing in again.':
    'تعذر طلب رابط التخويل. يرجى محاولة تسجيل الدخول مجدداً.',
  'Could not complete authorization. Please try signing in again.':
    'تعذر إكمال التخويل. يرجى محاولة تسجيل الدخول مجدداً.',
  'Could not read or save Qwen credentials. Check local file permissions and disk space.':
    'تعذر قراءة بيانات اعتماد Qwen أو حفظها. تحقق من أذونات الملفات المحلية ومساحة القرص.',
  'Could not refresh your Qwen session. Please try again.':
    'تعذر تحديث جلسة Qwen الخاصة بك. يرجى المحاولة مجدداً.',
  'You are signed out locally, but the remote session could not be revoked.':
    'تم تسجيل خروجك محلياً، لكن تعذر إبطال الجلسة البعيدة.',
  'Could not remove local Qwen credentials. Check local file permissions.':
    'تعذر إزالة بيانات اعتماد Qwen المحلية. تحقق من أذونات الملفات المحلية.',
  'Authorization or access was denied.': 'تم رفض التخويل أو الوصول.',
  'Too many requests. Please try again later.':
    'طلبات كثيرة جداً. يرجى المحاولة لاحقاً.',
  'The network request failed or timed out.': 'فشل طلب الشبكة أو انتهت مهلتُه.',
  'The service returned an invalid response.':
    'أرجعت الخدمة استجابة غير صالحة.',
  'Model: {{model}} · Run /usage to see your plan usage':
    'النموذج: {{model}} · شغّل ‎/usage لعرض استخدام خطتك',
  'Type your request, or /usage': 'اكتب طلبك، أو ‎/usage',
  'Try:': 'جرّب:',
  'Open Qwen subscription plans': 'فتح خطط اشتراك Qwen',
  'Could not open your browser. Visit {{url}}':
    'تعذر فتح المتصفح. تفضّل بزيارة {{url}}',
  'Qwen subscription plans: {{url}}': 'خطط اشتراك Qwen: {{url}}',
  'Sign out of your Qwen account': 'تسجيل الخروج من حساب Qwen',
  'This connection does not require /logout. Use /auth to switch model providers.':
    'لا يتطلب هذا الاتصال الأمر ‎/logout. استخدم ‎/auth لتبديل مزوّدي النماذج.',
  'This command is only available with Qwen Subscription login. Use /auth to sign in to Qwen Subscription.':
    'هذا الأمر متاح فقط عند تسجيل الدخول عبر اشتراك Qwen. استخدم ‎/auth لتسجيل الدخول إلى اشتراك Qwen.',
  'Wait for the current response to finish before signing out.':
    'انتظر انتهاء الاستجابة الحالية قبل تسجيل الخروج.',
  'You are signed out, but the saved authentication selection could not be cleared.':
    'تم تسجيل خروجك، لكن تعذر مسح خيار المصادقة المحفوظ.',
  'Signed out of Qwen. Use /auth to sign in with another account.':
    'تم تسجيل الخروج من Qwen. استخدم ‎/auth لتسجيل الدخول بحساب آخر.',
  'Tip: Run /usage to see your plan usage.':
    'نصيحة: شغّل ‎/usage لعرض استخدام خطتك.',
  'Copied to clipboard': 'تم النسخ إلى الحافظة',
  'Copy failed': 'فشل النسخ',
  '(API error: {{error}})': '(خطأ في API: {{error}})',
  'API error': 'خطأ في API',
  '{{reason}} · retrying in {{seconds}}s · attempt {{attempt}}/{{max}}':
    '{{reason}} · إعادة المحاولة خلال {{seconds}}ث · المحاولة {{attempt}}/{{max}}',
  '←/→ browse earlier answers': '←/→ تصفّح الإجابات السابقة',
  'c copy': 'c نسخ',
  'x clear history': 'x مسح السجل',
  'Tip: Use /btw to ask a quick side question without interrupting the current work':
    'نصيحة: استخدم ‎/btw لطرح سؤال جانبي سريع دون مقاطعة العمل الحالي',
  '(The model tried to call {{tool}} instead of answering directly. Try rephrasing or ask in the main conversation.)':
    '(حاول النموذج استدعاء {{tool}} بدلاً من الإجابة مباشرة. جرّب إعادة الصياغة أو اطرح السؤال في المحادثة الرئيسية.)',
};
