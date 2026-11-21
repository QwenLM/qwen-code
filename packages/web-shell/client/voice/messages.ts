/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

type VoiceMessage =
  | string
  | ((vars?: Record<string, string | number>) => string);

export const VOICE_MESSAGES_EN: Record<string, VoiceMessage> = {
  'voice.noSpeech': 'No speech detected.',
  'voice.stopDictation': 'Stop dictation',
  'voice.transcribing': 'Transcribing…',
  'voice.starting': 'Starting…',
  'voice.errorRetry': (v) =>
    `Voice error — click to retry${v?.message ? `: ${v.message}` : ''}`,
  'voice.noSpeechRetry': 'No speech detected — click to retry',
  'voice.startDictation': 'Start voice dictation',
  'voice.error': 'Voice error',
  'voice.dismissFeedback': 'Dismiss voice message',
  'voice.error.noModel': 'No voice model is configured for this workspace.',
  'voice.error.transcription': 'Voice transcription failed. Please try again.',
  'voice.error.tooManySessions':
    'Too many voice sessions in progress; try again shortly.',
  'voice.error.microphoneBlocked':
    'Microphone blocked. Click the camera/lock icon in the address bar to allow the mic for this site, and enable your browser under System Settings → Privacy → Microphone, then retry.',
  'voice.error.noMicrophone': 'No microphone found. Connect one and retry.',
  'voice.error.microphoneInUse':
    'Microphone is in use by another app. Close it and retry.',
  'voice.error.unsupportedBrowser':
    'Microphone capture is not supported in this browser.',
  'voice.error.insecureContext':
    'Microphone needs a secure context — open the Web Shell via localhost/127.0.0.1 or https.',
  'voice.error.sampleRate': (v) =>
    `Browser audio rate ${v?.actual} Hz is not the required ${v?.required} Hz.`,
  'voice.error.startTimeout': 'Voice capture timed out while starting.',
  'voice.error.bufferLimit':
    'Voice capture buffer limit reached while starting.',
  'voice.error.noResponse':
    'No response from server. Check that the voice model is running.',
  'voice.error.capacityUnavailable':
    'Voice capacity is temporarily unavailable. Retry shortly.',
  'voice.error.connectionClosed': (v) =>
    `Voice connection closed (code=${v?.code}, reason=${v?.reason}).`,
  'voice.error.transcriptionTimeout': 'Transcription timed out.',
  'voice.error.finalize': 'Failed to finalize voice transcription.',
  'voice.error.sessionTimeLimit': 'Voice session exceeded the time limit.',
  'voice.error.recordingTooLong':
    'Recording is too long for transcription (max ~5 minutes).',
  'voice.error.queueLimit': 'Queued voice audio exceeded the memory limit.',
  'voice.closeReason.none': 'no reason provided',
  'voice.closeReason.busy': 'voice service busy',
  'voice.closeReason.connectionLimit': 'connection limit reached',
  'voice.closeReason.serverShutdown': 'server shutting down',
  'voice.closeReason.workspaceRemoved': 'workspace removed',
  'voice.closeReason.trustChanged': 'workspace trust settings changed',
  'voice.closeReason.runtimeChanged': 'workspace runtime reconfigured',
  'voice.closeReason.voiceError': 'voice transcription failed',
  'voice.closeReason.unknown': 'unknown reason',
};

export const VOICE_MESSAGES_ZH: Record<string, VoiceMessage> = {
  'voice.noSpeech': '未检测到语音。',
  'voice.stopDictation': '停止语音输入',
  'voice.transcribing': '正在转录…',
  'voice.starting': '正在启动…',
  'voice.errorRetry': (v) =>
    `语音错误 — 点击重试${v?.message ? `：${v.message}` : ''}`,
  'voice.noSpeechRetry': '未检测到语音 — 点击重试',
  'voice.startDictation': '开始语音输入',
  'voice.error': '语音错误',
  'voice.dismissFeedback': '关闭语音提示',
  'voice.error.noModel': '当前工作区未配置语音模型。',
  'voice.error.transcription': '语音转写失败，请重试。',
  'voice.error.tooManySessions': '正在进行的语音会话过多，请稍后重试。',
  'voice.error.microphoneBlocked':
    '麦克风权限被阻止。请点击地址栏中的摄像头或锁图标，允许此网站使用麦克风，并在系统设置 → 隐私 → 麦克风中允许浏览器使用麦克风，然后重试。',
  'voice.error.noMicrophone': '未找到麦克风，请连接后重试。',
  'voice.error.microphoneInUse': '麦克风正被其他应用占用，请关闭该应用后重试。',
  'voice.error.unsupportedBrowser': '此浏览器不支持麦克风采集。',
  'voice.error.insecureContext':
    '麦克风需要安全上下文，请通过 localhost、127.0.0.1 或 HTTPS 打开 Web Shell。',
  'voice.error.sampleRate': (v) =>
    `浏览器音频采样率为 ${v?.actual} Hz，不符合要求的 ${v?.required} Hz。`,
  'voice.error.startTimeout': '语音采集启动超时，请重试。',
  'voice.error.bufferLimit': '启动期间的语音缓冲区已达上限，请重试。',
  'voice.error.noResponse': '服务器无响应，请检查语音模型是否正在运行。',
  'voice.error.capacityUnavailable': '语音服务容量暂时不足，请稍后重试。',
  'voice.error.connectionClosed': (v) =>
    `语音连接已关闭（错误码：${v?.code}，原因：${v?.reason}）。`,
  'voice.error.transcriptionTimeout': '语音转写超时，请重试。',
  'voice.error.finalize': '无法结束语音转写，请重试。',
  'voice.error.sessionTimeLimit': '语音会话已超过时间限制。',
  'voice.error.recordingTooLong': '录音过长，无法转写（最长约 5 分钟）。',
  'voice.error.queueLimit': '排队的语音音频已超过内存限制，请重试。',
  'voice.closeReason.none': '未提供原因',
  'voice.closeReason.busy': '语音服务繁忙',
  'voice.closeReason.connectionLimit': '连接数已达上限',
  'voice.closeReason.serverShutdown': '服务器正在关闭',
  'voice.closeReason.workspaceRemoved': '工作区已移除',
  'voice.closeReason.trustChanged': '工作区信任设置已更改',
  'voice.closeReason.runtimeChanged': '工作区运行时已重新配置',
  'voice.closeReason.voiceError': '语音转写失败',
  'voice.closeReason.unknown': '未知原因',
};

export const VOICE_MESSAGES_RU: Record<string, VoiceMessage> = {
  'voice.noSpeech': 'Речь не обнаружена.',
  'voice.stopDictation': 'Остановить диктовку',
  'voice.transcribing': 'Транскрибирование…',
  'voice.starting': 'Запуск…',
  'voice.errorRetry': (v) =>
    `Ошибка голоса — нажмите, чтобы повторить${v?.message ? `: ${v.message}` : ''}`,
  'voice.noSpeechRetry': 'Речь не обнаружена — нажмите, чтобы повторить',
  'voice.startDictation': 'Начать голосовую диктовку',
  'voice.error': 'Ошибка голоса',
  'voice.dismissFeedback': 'Скрыть голосовое сообщение',
  'voice.error.noModel':
    'Для этой рабочей области не настроена голосовая модель.',
  'voice.error.transcription':
    'Голосовая транскрипция не удалась. Попробуйте снова.',
  'voice.error.tooManySessions':
    'Слишком много голосовых сессий; повторите чуть позже.',
  'voice.error.microphoneBlocked':
    'Микрофон заблокирован. Нажмите значок камеры или замка в адресной строке, чтобы разрешить микрофон для этого сайта, и включите браузер в «Системные настройки → Конфиденциальность → Микрофон», затем повторите.',
  'voice.error.noMicrophone': 'Микрофон не найден. Подключите его и повторите.',
  'voice.error.microphoneInUse':
    'Микрофон занят другим приложением. Закройте его и повторите.',
  'voice.error.unsupportedBrowser':
    'Захват с микрофона в этом браузере не поддерживается.',
  'voice.error.insecureContext':
    'Микрофону нужен защищённый контекст — откройте Web Shell через localhost/127.0.0.1 или https.',
  'voice.error.sampleRate': (v) =>
    `Частота аудио браузера ${v?.actual} Гц, требуется ${v?.required} Гц.`,
  'voice.error.startTimeout':
    'Захват голоса превысил время ожидания при запуске.',
  'voice.error.bufferLimit':
    'Достигнут предел буфера захвата голоса при запуске.',
  'voice.error.noResponse':
    'Нет ответа от сервера. Проверьте, что голосовая модель запущена.',
  'voice.error.capacityUnavailable':
    'Голосовая ёмкость временно недоступна. Повторите чуть позже.',
  'voice.error.connectionClosed': (v) =>
    `Голосовое соединение закрыто (code=${v?.code}, reason=${v?.reason}).`,
  'voice.error.transcriptionTimeout': 'Время транскрипции истекло.',
  'voice.error.finalize': 'Не удалось завершить голосовую транскрипцию.',
  'voice.error.sessionTimeLimit': 'Голосовая сессия превысила лимит времени.',
  'voice.error.recordingTooLong':
    'Запись слишком длинная для транскрипции (макс. ~5 минут).',
  'voice.error.queueLimit': 'Очередь голосового аудио превысила лимит памяти.',
  'voice.closeReason.none': 'причина не указана',
  'voice.closeReason.busy': 'голосовой сервис занят',
  'voice.closeReason.connectionLimit': 'достигнут лимит соединений',
  'voice.closeReason.serverShutdown': 'сервер завершает работу',
  'voice.closeReason.workspaceRemoved': 'рабочая область удалена',
  'voice.closeReason.trustChanged':
    'изменены настройки доверия рабочей области',
  'voice.closeReason.runtimeChanged': 'runtime рабочей области перенастроен',
  'voice.closeReason.voiceError': 'голосовая транскрипция не удалась',
  'voice.closeReason.unknown': 'неизвестная причина',
};

export const VOICE_MESSAGES_AR: Record<string, VoiceMessage> = {
  'voice.noSpeech': 'لم يتم اكتشاف أي كلام.',
  'voice.stopDictation': 'إيقاف الإملاء',
  'voice.transcribing': 'جارٍ النسخ…',
  'voice.starting': 'جارٍ البدء…',
  'voice.errorRetry': (v) =>
    `خطأ صوتي — انقر لإعادة المحاولة${v?.message ? `: ${v.message}` : ''}`,
  'voice.noSpeechRetry': 'لم يتم اكتشاف أي كلام — انقر لإعادة المحاولة',
  'voice.startDictation': 'بدء الإملاء الصوتي',
  'voice.error': 'خطأ صوتي',
  'voice.dismissFeedback': 'إغلاق رسالة الصوت',
  'voice.error.noModel': 'لم يتم تهيئة نموذج صوتي لمساحة العمل هذه.',
  'voice.error.transcription': 'فشل نسخ الصوت. يُرجى المحاولة مجدداً.',
  'voice.error.tooManySessions':
    'عدد جلسات الصوت الجارية كبير جداً؛ حاول بعد قليل.',
  'voice.error.microphoneBlocked':
    'الميكروفون محظور. انقر على أيقونة الكاميرا/القفل في شريط العنوان للسماح بالميكروفون لهذا الموقع، وفعّل متصفحك ضمن إعدادات النظام ← الخصوصية ← الميكروفون، ثم أعد المحاولة.',
  'voice.error.noMicrophone':
    'لم يتم العثور على ميكروفون. وصّل واحداً وأعد المحاولة.',
  'voice.error.microphoneInUse':
    'الميكروفون قيد الاستخدام بواسطة تطبيق آخر. أغلقه وأعد المحاولة.',
  'voice.error.unsupportedBrowser':
    'التقاط الميكروفون غير مدعوم في هذا المتصفح.',
  'voice.error.insecureContext':
    'يتطلب الميكروفون سياقاً آمناً — افتح Web Shell عبر localhost/127.0.0.1 أو https.',
  'voice.error.sampleRate': (v) =>
    `معدل صوت المتصفح ${v?.actual} Hz لا يطابق المطلوب ${v?.required} Hz.`,
  'voice.error.startTimeout': 'انتهت مهلة التقاط الصوت أثناء البدء.',
  'voice.error.bufferLimit': 'بلغ مخزن التقاط الصوت حده أثناء البدء.',
  'voice.error.noResponse':
    'لا توجد استجابة من الخادم. تحقق من أن نموذج الصوت يعمل.',
  'voice.error.capacityUnavailable':
    'سعة الصوت غير متاحة مؤقتاً. أعد المحاولة بعد قليل.',
  'voice.error.connectionClosed': (v) =>
    `أُغلق اتصال الصوت (الرمز=${v?.code}، السبب=${v?.reason}).`,
  'voice.error.transcriptionTimeout': 'انتهت مهلة النسخ الصوتي.',
  'voice.error.finalize': 'فشل إنهاء النسخ الصوتي.',
  'voice.error.sessionTimeLimit': 'تجاوزت الجلسة الصوتية الحد الزمني.',
  'voice.error.recordingTooLong':
    'التسجيل طويل جداً للنسخ (الحد الأقصى ~5 دقائق).',
  'voice.error.queueLimit': 'تجاوز الصوت المنتظر حد الذاكرة.',
  'voice.closeReason.none': 'لم يُقدَّم سبب',
  'voice.closeReason.busy': 'خدمة الصوت مشغولة',
  'voice.closeReason.connectionLimit': 'تم بلوغ حد الاتصالات',
  'voice.closeReason.serverShutdown': 'الخادم قيد الإيقاف',
  'voice.closeReason.workspaceRemoved': 'تمت إزالة مساحة العمل',
  'voice.closeReason.trustChanged': 'تغيّرت إعدادات موثوقية مساحة العمل',
  'voice.closeReason.runtimeChanged': 'أُعيدت تهيئة بيئة تشغيل مساحة العمل',
  'voice.closeReason.voiceError': 'فشل نسخ الصوت',
  'voice.closeReason.unknown': 'سبب غير معروف',
};
