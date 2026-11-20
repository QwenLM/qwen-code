import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Textarea } from '../ui/textarea';
import { Checkbox } from '../ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Markdown } from '../messages/Markdown';
import { isManagedSideQueryActive } from './managed-side-query-types';
import type { useManagedSideQueries } from './use-managed-side-queries';

const messages = {
  btw: ['BTW', 'BTW 追问', 'BTW 追問', 'BTW'],
  recap: ['Session recap', '会话回顾', '會話回顧', 'Обзор сессии'],
  private: [
    'Saved privately for your account. The main task keeps running.',
    '记录仅当前账号可见，主任务继续执行。',
    '記錄僅當前帳號可見，主任務繼續執行。',
    'Сохранено только для вашей учётной записи. Основная задача продолжает выполняться.',
  ],
  empty: [
    'No saved answers yet.',
    '暂无已保存的回答。',
    '暫無已儲存的回答。',
    'Пока нет сохранённых ответов.',
  ],
  older: ['Older answers', '更早的回答', '更早的回答', 'Более ранние ответы'],
  question: [
    'Ask a follow-up question',
    '继续追问',
    '繼續追問',
    'Задать уточняющий вопрос',
  ],
  send: ['Ask', '提问', '提問', 'Спросить'],
  generate: ['Generate recap', '生成回顾', '生成回顧', 'Сгенерировать обзор'],
  stop: ['Stop', '停止', '停止', 'Остановить'],
  retry: ['Retry', '重试', '重試', 'Повторить'],
  confirm: [
    'Confirm original submission',
    '确认原提交结果',
    '確認原提交結果',
    'Подтвердить исходную отправку',
  ],
  unconfirmed: [
    'The submission is not confirmed. Confirm it using the original request.',
    '提交结果尚未确认，可使用原请求再次确认。',
    '提交結果尚未確認，可使用原請求再次確認。',
    'Отправка не подтверждена. Подтвердите её исходным запросом.',
  ],
  preparing: ['Preparing', '准备中', '準備中', 'Подготовка'],
  running: ['Answering', '回答中', '回答中', 'Отвечает'],
  completed: ['Completed', '已完成', '已完成', 'Завершено'],
  failed: ['Failed', '失败', '失敗', 'Ошибка'],
  cancelled: ['Stopped', '已停止', '已停止', 'Остановлено'],
  interrupted: ['Interrupted', '已中断', '已中斷', 'Прервано'],
  insufficient: [
    'There is not enough completed conversation to recap.',
    '已完成的对话不足，暂时无法生成回顾。',
    '已完成的對話不足，暫時無法生成回顧。',
    'Недостаточно завершённого разговора для обзора.',
  ],
  partial: [
    'This answer is incomplete.',
    '此回答不完整。',
    '此回答不完整。',
    'Этот ответ неполный.',
  ],
  unavailable: [
    'Generation is unavailable for this session.',
    '此会话暂不支持生成。',
    '此會話暫不支援生成。',
    'Генерация недоступна для этой сессии.',
  ],
  storage: [
    'Browser storage is unavailable. The question was not submitted.',
    '浏览器存储不可用，问题尚未提交。',
    '瀏覽器儲存不可用，問題尚未提交。',
    'Хранилище браузера недоступно. Вопрос не был отправлен.',
  ],
  automatic: [
    'Recap after I am away for five minutes',
    '离开五分钟后自动回顾',
    '離開五分鐘後自動回顧',
    'Обзор, если меня нет пять минут',
  ],
  automaticHint: [
    'Off by default. Runs after the main task and queue are idle.',
    '默认关闭，主任务与队列空闲后生成。',
    '預設關閉，主任務與佇列空閒後生成。',
    'По умолчанию выключено. Запускается, когда основная задача и очередь простаивают.',
  ],
  source: [
    'Completed user turns',
    '已完成的用户轮次',
    '已完成的使用者輪次',
    'Завершённые ходы пользователя',
  ],
  boundary: [
    'Source message boundary',
    '来源消息边界',
    '來源訊息邊界',
    'Граница исходного сообщения',
  ],
} as const satisfies Record<string, readonly [string, string, string, string]>;

export function ManagedSideQueryPanel({
  sideQueries,
  interactive,
}: {
  sideQueries: ReturnType<typeof useManagedSideQueries>;
  interactive: boolean;
}) {
  const { language } = useI18n();
  const t = (key: keyof typeof messages) =>
    messages[key][
      language === 'zh-TW'
        ? 2
        : language === 'zh-CN'
          ? 1
          : language === 'ru'
            ? 3
            : 0
    ];
  const kind = sideQueries.open;
  const [question, setQuestion] = useState('');
  useEffect(() => setQuestion(''), [sideQueries.identity]);
  const queries = sideQueries.queries.filter((query) => query.kind === kind);
  const active = queries.some(isManagedSideQueryActive);
  const pending = kind !== undefined && sideQueries.pending.includes(kind);
  const canGenerate =
    !!kind && sideQueries.available(kind) && !active && !pending && interactive;
  const submit = async () => {
    if (!canGenerate || !kind) return;
    const accepted = await sideQueries.create(
      kind === 'btw'
        ? { kind, question: question.trim() }
        : { kind, trigger: 'manual' },
    );
    if (accepted && kind === 'btw') setQuestion('');
  };
  return (
    <Dialog
      open={!!kind}
      onOpenChange={(open) => {
        if (!open) sideQueries.close();
      }}
    >
      <DialogContent
        className="flex max-h-[85vh] flex-col sm:max-w-2xl"
        data-managed-side-query-panel={kind}
      >
        <DialogHeader>
          <DialogTitle>{t(kind === 'recap' ? 'recap' : 'btw')}</DialogTitle>
          <DialogDescription>{t('private')}</DialogDescription>
        </DialogHeader>
        <div
          className="min-h-0 flex-1 space-y-4 overflow-y-auto"
          aria-live="polite"
        >
          {sideQueries.nextCursor && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void sideQueries.loadMore()}
            >
              {t('older')}
            </Button>
          )}
          {!queries.length && (
            <p className="text-muted-foreground">{t('empty')}</p>
          )}
          {queries.map((query) => (
            <article
              key={query.queryId}
              className="space-y-2 rounded-md border p-3"
              data-side-query-id={query.queryId}
            >
              {query.question && (
                <p className="whitespace-pre-wrap font-medium">
                  {query.question}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="secondary">{t(query.status)}</Badge>
                <span>
                  {t('source')}: {query.source.completedUserTurnCount}
                </span>
                <span>
                  {t('boundary')}: {query.source.completedTurnSequence}
                </span>
              </div>
              {query.text && <Markdown content={query.text} />}
              {query.outcome === 'insufficient_context' && (
                <p>{t('insufficient')}</p>
              )}
              {query.outcome &&
                ['truncated', 'partial', 'filtered'].includes(
                  query.outcome,
                ) && <p role="status">{t('partial')}</p>}
              {query.errorCode && <p role="status">{query.errorCode}</p>}
              {isManagedSideQueryActive(query) ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!interactive}
                  onClick={() => void sideQueries.cancel(query)}
                >
                  {t('stop')}
                </Button>
              ) : (
                query.status !== 'completed' && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canGenerate}
                    onClick={() =>
                      void sideQueries.create(
                        query.kind === 'btw'
                          ? { kind: 'btw', question: query.question ?? '' }
                          : { kind: 'recap', trigger: 'manual' },
                      )
                    }
                  >
                    {t('retry')}
                  </Button>
                )
              )}
            </article>
          ))}
        </div>
        {sideQueries.error && (
          <p role="alert">
            {sideQueries.error === 'storage_unavailable'
              ? t('storage')
              : sideQueries.error}
          </p>
        )}
        {pending && !active && kind && (
          <div className="space-y-2" role="status">
            <p>{sideQueries.error ? t('unconfirmed') : t('preparing')}</p>
            <Button
              variant="outline"
              disabled={!interactive}
              onClick={() => void sideQueries.confirm(kind)}
            >
              {t('confirm')}
            </Button>
          </div>
        )}
        {kind === 'recap' && (
          <div className="space-y-1 text-sm">
            <label className="flex items-center gap-2">
              <Checkbox
                aria-label={t('automatic')}
                checked={sideQueries.automatic}
                disabled={
                  !interactive ||
                  (!sideQueries.available('recap') && !sideQueries.automatic)
                }
                onCheckedChange={(checked) =>
                  sideQueries.setAutomatic(checked === true)
                }
              />
              {t('automatic')}
            </label>
            <p className="text-xs text-muted-foreground">
              {t('automaticHint')}
            </p>
          </div>
        )}
        {!kind || !sideQueries.available(kind) ? (
          <p className="text-muted-foreground">{t('unavailable')}</p>
        ) : (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {kind === 'btw' && (
              <Textarea
                aria-label={t('question')}
                placeholder={t('question')}
                maxLength={4096}
                rows={3}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                disabled={!interactive}
              />
            )}
            <Button
              type="submit"
              disabled={!canGenerate || (kind === 'btw' && !question.trim())}
            >
              {t(kind === 'btw' ? 'send' : 'generate')}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
