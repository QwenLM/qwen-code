import { memo } from 'react';
import styles from './DiffView.module.css';

interface DiffViewProps {
  diff: string;
}

interface DiffLine {
  type: 'add' | 'del' | 'context' | 'header';
  content: string;
}

function parseDiff(diff: string): {
  lines: DiffLine[];
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  const lines: DiffLine[] = [];

  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      lines.push({ type: 'header', content: line });
    } else if (line.startsWith('+') && !line.startsWith('+++ ')) {
      additions++;
      lines.push({ type: 'add', content: line.slice(1) });
    } else if (line.startsWith('-') && !line.startsWith('--- ')) {
      deletions++;
      lines.push({ type: 'del', content: line.slice(1) });
    } else {
      lines.push({
        type: 'context',
        content: line.startsWith(' ') ? line.slice(1) : line,
      });
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
