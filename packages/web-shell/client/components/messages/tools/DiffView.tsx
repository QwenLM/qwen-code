import { memo } from 'react';
import styles from './DiffView.module.css';

interface DiffViewProps {
  diff: string;
}

interface DiffLine {
  type: 'add' | 'del' | 'context' | 'header';
  content: string;
  oldLine?: number;
  newLine?: number;
}

function parseDiff(diff: string): {
  lines: DiffLine[];
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      lines.push({ type: 'header', content: line });
    } else if (line.startsWith('+') && !line.startsWith('+++ ')) {
      additions++;
      lines.push({ type: 'add', content: line.slice(1), newLine });
      newLine++;
    } else if (line.startsWith('-') && !line.startsWith('--- ')) {
      deletions++;
      lines.push({ type: 'del', content: line.slice(1), oldLine });
      oldLine++;
    } else {
      lines.push({
        type: 'context',
        content: line.startsWith(' ') ? line.slice(1) : line,
        oldLine,
        newLine,
      });
      oldLine++;
      newLine++;
    }
  }

  return { lines, additions, deletions };
}

export const DiffView = memo(function DiffView({ diff }: DiffViewProps) {
  if (!diff) return null;

  const { lines, additions, deletions } = parseDiff(diff);

  return (
    <div className={styles.view}>
      <div className={styles.stats}>
        {additions > 0 && <span className={styles.statAdd}>+{additions}</span>}
        {deletions > 0 && <span className={styles.statDel}>-{deletions}</span>}
      </div>
      <div className={styles.lines}>
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
            <span className={styles.content}>{line.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
});
