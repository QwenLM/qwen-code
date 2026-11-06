import { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { RadioGroup, RadioGroupItem } from '../ui/radio-group';
import { Textarea } from '../ui/textarea';
import type {
  ManagedAgentPendingQuestionAction,
  ManagedAgentQuestionAnswer,
  ManagedAgentQuestionResponse,
} from './managed-agent-provider';
import { MAX_MANAGED_QUESTION_ANSWER_BYTES } from './managed-question-response';

export function ManagedQuestionForm({
  action,
  disabled = false,
  onSubmit,
}: {
  action: ManagedAgentPendingQuestionAction;
  disabled?: boolean;
  onSubmit(response: ManagedAgentQuestionResponse): Promise<void>;
}) {
  const { t } = useI18n();
  const id = useId();
  const [draft, setDraft] = useState<
    Record<string, { optionIds: string[]; text: string }>
  >({});
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const [expired, setExpired] = useState(() => Date.now() >= action.expiresAt);
  useEffect(() => {
    setExpired(Date.now() >= action.expiresAt);
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, action.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [action.expiresAt]);

  const answers: ManagedAgentQuestionAnswer[] = action.questions.flatMap(
    (question) => {
      const entry = draft[question.id];
      const optionIds = question.options
        .filter((option) => entry?.optionIds.includes(option.id))
        .map((option) => option.id);
      const text = entry?.text;
      if (!optionIds.length && !text?.trim()) return [];
      return [
        {
          questionId: question.id,
          ...(optionIds.length ? { optionIds } : {}),
          ...(text?.trim() ? { text } : {}),
        },
      ];
    },
  );
  const complete = action.questions.every(
    (question) =>
      !question.required ||
      answers.some((answer) => answer.questionId === question.id),
  );
  const tooLarge =
    answers.some((answer) => (answer.text?.length ?? 0) > 8192) ||
    new TextEncoder().encode(JSON.stringify(answers)).byteLength >
      MAX_MANAGED_QUESTION_ANSWER_BYTES;
  const blocked = disabled || submitting || expired;

  return (
    <form
      aria-label={t('managed.question.title')}
      className="space-y-3 rounded-lg border border-border bg-background p-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (
          blocked ||
          inFlight.current ||
          !complete ||
          tooLarge ||
          Date.now() >= action.expiresAt
        )
          return;
        inFlight.current = true;
        setSubmitting(true);
        try {
          await onSubmit({ kind: 'question', answers });
        } catch {
          // The Action hook owns the error; keep this exact draft for retry.
          inFlight.current = false;
          setSubmitting(false);
        }
      }}
    >
      <h3 className="text-sm font-semibold">{t('managed.question.title')}</h3>
      <div className="max-h-96 space-y-4 overflow-y-auto">
        {action.questions.map((question) => {
          const entry = draft[question.id] ?? { optionIds: [], text: '' };
          const legendId = `${id}-${question.id}`;
          const options = question.options.map((option) => (
            <label
              key={option.id}
              htmlFor={`${legendId}-${option.id}`}
              className="flex items-start gap-2 text-sm"
            >
              {question.multiple ? (
                <Checkbox
                  id={`${legendId}-${option.id}`}
                  disabled={blocked}
                  checked={entry.optionIds.includes(option.id)}
                  onCheckedChange={(checked) =>
                    setDraft((current) => ({
                      ...current,
                      [question.id]: {
                        ...entry,
                        optionIds:
                          checked === true
                            ? [...entry.optionIds, option.id]
                            : entry.optionIds.filter(
                                (value) => value !== option.id,
                              ),
                      },
                    }))
                  }
                />
              ) : (
                <RadioGroupItem
                  id={`${legendId}-${option.id}`}
                  value={option.id}
                  disabled={blocked}
                />
              )}
              <span>
                <span className="font-medium">{option.label}</span>
                {option.description && (
                  <span className="block text-muted-foreground">
                    {option.description}
                  </span>
                )}
              </span>
            </label>
          ));
          return (
            <fieldset
              key={question.id}
              disabled={blocked}
              className="space-y-2"
            >
              <legend id={legendId} className="mb-2 text-sm font-medium">
                {question.prompt}
                {question.multiple && ` (${t('askUser.multiHint')})`}
              </legend>
              {question.multiple ? (
                <div className="space-y-2">{options}</div>
              ) : (
                <RadioGroup
                  aria-labelledby={legendId}
                  value={entry.optionIds[0] ?? ''}
                  onValueChange={(value) =>
                    setDraft((current) => ({
                      ...current,
                      [question.id]: { optionIds: [value], text: '' },
                    }))
                  }
                  disabled={blocked}
                >
                  {options}
                </RadioGroup>
              )}
              {question.allowText && (
                <label className="block space-y-1 text-sm">
                  <span>{t('managed.question.other')}</span>
                  <Textarea
                    aria-label={`${question.prompt}: ${t('managed.question.other')}`}
                    value={entry.text}
                    maxLength={8192}
                    disabled={blocked}
                    onChange={(event) => {
                      const text = event.target.value;
                      setDraft((current) => ({
                        ...current,
                        [question.id]: {
                          optionIds: question.multiple ? entry.optionIds : [],
                          text,
                        },
                      }));
                    }}
                  />
                </label>
              )}
            </fieldset>
          );
        })}
      </div>
      {expired && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('managed.question.expired')}
        </p>
      )}
      {tooLarge && (
        <p role="alert" className="text-sm text-destructive">
          {t('managed.question.tooLarge')}
        </p>
      )}
      <Button type="submit" disabled={blocked || !complete || tooLarge}>
        {t(submitting ? 'askUser.submitting' : 'askUser.submit')}
      </Button>
    </form>
  );
}
