import type { ACPToolCall } from '../../adapters/types';
import type { getQuestionAnswerResult } from './toolFormatting';
import flashStyles from '../MessageLocateFlash.module.css';
import messageStyles from './UserMessage.module.css';
import styles from './QuestionAnswerMessage.module.css';
import { SelectionCopyMenu } from './SelectionCopyMenu';
import { useTranscriptRenderMode } from '../../transcriptRenderMode';

export function QuestionAnswerMessage({
  tool,
  result,
  isLocateFlashing = false,
}: {
  tool: ACPToolCall;
  result: NonNullable<ReturnType<typeof getQuestionAnswerResult>>;
  isLocateFlashing?: boolean;
}) {
  const { text, answers } = result;
  const interactive = useTranscriptRenderMode() === 'interactive';
  const content =
    answers.length > 0
      ? answers
          .map(({ question, answer }) => `${question}\n${answer}`)
          .join('\n\n')
      : text;
  return (
    <div
      className={messageStyles.chatMessageRow}
      data-transcript-tool-call-id={tool.callId}
    >
      <div className={messageStyles.chatMessageColumn}>
        <SelectionCopyMenu
          className={`${messageStyles.chatBubble} ${styles.bubble} ${
            isLocateFlashing ? flashStyles.flash : ''
          }`}
          content={content}
          enabled={interactive}
        >
          {answers.length > 0 ? (
            <dl className={styles.answers}>
              {answers.map(({ question, answer }, index) => (
                <div key={index}>
                  <dt className={styles.question}>{question}</dt>
                  <dd className={styles.answer}>{answer}</dd>
                </div>
              ))}
            </dl>
          ) : (
            text
          )}
        </SelectionCopyMenu>
      </div>
    </div>
  );
}
