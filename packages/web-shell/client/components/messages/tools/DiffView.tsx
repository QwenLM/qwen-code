import { memo } from 'react';
import { useI18n } from '../../../i18n';
import {
  localizeDiffNotice,
  parseUnifiedDiff,
} from '../../../utils/unifiedDiff';
import { sanitizeControlChars } from '../toolFormatting';
import styles from './DiffView.module.css';

interface DiffViewProps {
  diff: string;
}

/**
 * Rows are sanitized here, at the sink every diff consumer shares, so a
 * model-supplied body cannot use bidi embedding/isolate controls to make an
 * added line read differently from the bytes it writes (the class
 * `toolFormatting.ts` already neutralises for commands, descriptions and
 * paths). `splitLines` splits on '\n' only, so every row of a CRLF body keeps
 * its trailing '\r'; `sanitizeControlChars` maps '\x0d' to the visible literal
 * `\r`, which would otherwise append that text to every row of such a file —
 * drop the line terminator first. Only the C0/C1/bidi class is covered:
 * zero-width and line/paragraph separator code points still pass through, so
 * this narrows the spoofing surface rather than closing it.
 */
function sanitizeDiffContent(content: string): string {
  const body = content.endsWith('\r') ? content.slice(0, -1) : content;
  return sanitizeControlChars(body);
}

export const DiffView = memo(function DiffView({ diff }: DiffViewProps) {
  // `buildContextBoundedDiff` emits ASCII-safe markers instead of prose (it is
  // import-free, so it cannot reach the catalog); resolve them here, at the
  // render boundary, where a translator is in scope.
  const { t } = useI18n();
  if (!diff) return null;

  const { lines, additions, deletions } = parseUnifiedDiff(diff);

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
              {sanitizeDiffContent(
                line.type === 'header'
                  ? localizeDiffNotice(line.content, t)
                  : line.content,
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
});
