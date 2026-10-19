import { memo } from 'react';
import { useI18n } from '../../../i18n';
import { DIFF_INVISIBLE_CHARACTERS, escapeDiffContent } from './diffContent';
import {
  DIFF_CRLF_UNIFORM_MARKER,
  localizeDiffNotice,
  parseUnifiedDiff,
} from '../../../utils/unifiedDiff';
import styles from './DiffView.module.css';

interface DiffViewProps {
  diff: string;
  maxLength?: number;
}

export const DiffView = memo(function DiffView({
  diff,
  maxLength,
}: DiffViewProps) {
  // `buildContextBoundedDiff` emits ASCII-safe markers instead of prose (it is
  // import-free, so it cannot reach the catalog); resolve them here, at the
  // render boundary, where a translator is in scope.
  const { t } = useI18n();
  if (!diff) return null;

  const input = maxLength === undefined ? diff : diff.slice(0, maxLength);
  const { lines, additions, deletions, crlfUniform } = parseUnifiedDiff(input);
  // Whether a trailing `\r` is part of a `\r\n` terminator is decided in
  // `parseUnifiedDiff`, so both patch sources agree: builders know the source
  // text and emit `DIFF_CRLF_UNIFORM_MARKER`, while raw patches (which no
  // builder produced) are judged from their own rows, since a uniform-CRLF
  // file keeps the `\r` on every content row. A mixed file keeps the `\r`
  // visible as an escape node, which is the honest rendering there.
  // Builders emit a notice as the whole preview, never inside a raw patch.
  const notice =
    lines.length === 1 && lines[0].type === 'header'
      ? localizeDiffNotice(diff, t)
      : undefined;
  let remaining = maxLength ?? Infinity;
  let truncated = input.length < diff.length;
  const renderedLines = lines.flatMap((line) => {
    if (line.type === 'header' && line.content === DIFF_CRLF_UNIFORM_MARKER) {
      return [];
    }
    if (remaining === 0) {
      truncated = true;
      return [];
    }
    const content = notice ?? line.content;
    const body =
      crlfUniform && content.endsWith('\r') ? content.slice(0, -1) : content;
    const parts = body.split(DIFF_INVISIBLE_CHARACTERS);
    const rendered = parts.map((part, index) => {
      const safe = escapeDiffContent(part);
      const visible = safe.slice(0, remaining);
      truncated ||= visible.length < safe.length;
      remaining -= visible.length;
      if (!visible) return '';
      return safe === part ? (
        visible
      ) : (
        <span
          key={index}
          className={styles.escaped}
          title={`${t('gitDiff.escapedCharacter')}: ${safe}`}
        >
          {visible}
        </span>
      );
    });
    return remaining === 0 && rendered.every((part) => part === '')
      ? []
      : [{ ...line, rendered }];
  });

  return (
    <div className={styles.view}>
      <div className={styles.stats}>
        {additions > 0 && <span className={styles.statAdd}>+{additions}</span>}
        {deletions > 0 && <span className={styles.statDel}>-{deletions}</span>}
      </div>
      <div className={styles.lines} tabIndex={0} aria-label="File diff">
        {renderedLines.map((line, i) => (
          <div
            key={i}
            className={`${styles.line} ${styles[`line${line.type[0].toUpperCase()}${line.type.slice(1)}`]}`}
          >
            <span className={styles.lineNo}>
              {line.type === 'header' ? '' : (line.oldLine ?? line.newLine)}
            </span>
            <span className={styles.marker}>
              {line.type === 'add'
                ? '+'
                : line.type === 'del'
                  ? '-'
                  : line.type === 'header'
                    ? ''
                    : ' '}
            </span>
            <span className={styles.content}>{line.rendered}</span>
          </div>
        ))}
      </div>
      {truncated && (
        <p className="text-xs text-muted-foreground">
          {t('gitDiff.truncated')}
        </p>
      )}
    </div>
  );
});
