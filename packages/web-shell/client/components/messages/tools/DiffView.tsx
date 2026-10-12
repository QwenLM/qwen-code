import { memo } from 'react';
import { useI18n } from '../../../i18n';
import { escapePreviewText } from '../../../adapters/transcriptAdapter';
import {
  localizeDiffNotice,
  parseUnifiedDiff,
} from '../../../utils/unifiedDiff';
import { sanitizeControlChars } from '../toolFormatting';
import styles from './DiffView.module.css';

interface DiffViewProps {
  diff: string;
}

// Strip CR only for uniform CRLF bodies: mixed endings are part of the change.
// Compose both existing guards to cover C0/C1 and invisible format characters,
// while leaving adapter-preescaped input unchanged.
function sanitizeDiffContent(content: string, crlfBody: boolean): string {
  const body =
    crlfBody && content.endsWith('\r') ? content.slice(0, -1) : content;
  return escapePreviewText(sanitizeControlChars(body));
}

export const DiffView = memo(function DiffView({ diff }: DiffViewProps) {
  // `buildContextBoundedDiff` emits ASCII-safe markers instead of prose (it is
  // import-free, so it cannot reach the catalog); resolve them here, at the
  // render boundary, where a translator is in scope.
  const { t } = useI18n();
  if (!diff) return null;

  const { lines, additions, deletions } = parseUnifiedDiff(diff);
  const contentLines = lines.filter((line) => line.type !== 'header');
  const crlfBody =
    contentLines.length > 0 &&
    contentLines.every((line) => line.content.endsWith('\r'));
  // Builders emit a notice as the whole preview, never inside a raw patch.
  const notice =
    lines.length === 1 && lines[0].type === 'header'
      ? localizeDiffNotice(diff, t)
      : undefined;

  return (
    <div className={styles.view}>
      <div className={styles.stats}>
        {additions > 0 && <span className={styles.statAdd}>+{additions}</span>}
        {deletions > 0 && <span className={styles.statDel}>-{deletions}</span>}
      </div>
      <div className={styles.lines} tabIndex={0} aria-label="File diff">
        {lines.map((line, i) => (
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
            <span className={styles.content}>
              {sanitizeDiffContent(notice ?? line.content, crlfBody)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
});
